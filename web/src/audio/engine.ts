// AudioContext / AudioWorklet lifecycle.
//
// The wasm binary is fetched on the main thread (worklets cannot fetch) and
// transferred to the processor as raw bytes; the worklet compiles it
// synchronously. Transferring a compiled WebAssembly.Module would be nicer,
// but Chrome silently drops Module postMessage without cross-origin isolation
// (COOP/COEP), which we deliberately avoid (REQUIREMENTS §5.1).

import type { LoopIR } from '../dsl/loop.ts';

export type EngineState = 'idle' | 'loading' | 'ready' | 'error';

export interface EngineEvents {
  onState?: (state: EngineState, detail: string) => void;
  onPosition?: (samples: number, loopLen: number) => void;
}

// Injected by vite.config.ts at build time.
declare const __BUILD_ID__: string;

// BASE_URL ends with '/'; resolves correctly both at the root and under a
// subpath deployment such as GitHub Pages (/<repo>/). The ?v= query ties the
// stable-named assets to this build so a redeploy never pairs a fresh main
// bundle with a stale cached worklet or wasm binary.
const WASM_URL = `${import.meta.env.BASE_URL}dsp.wasm?v=${__BUILD_ID__}`;
const WORKLET_URL = `${import.meta.env.BASE_URL}worklet.js?v=${__BUILD_ID__}`;
const PROCESSOR_NAME = 'sheliak-processor';
const READY_TIMEOUT_MS = 10000;

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private analyserNode: AnalyserNode | null = null;
  private booting: Promise<void> | null = null;

  private state: EngineState = 'idle';
  private playing = false;

  private lastParams: Float32Array | null = null;
  private lastLoop: LoopIR | null = null;

  constructor(private readonly events: EngineEvents = {}) {}

  /** Context sample rate; 0 until the context exists. Never hardcoded. */
  get sampleRate(): number {
    return this.ctx ? this.ctx.sampleRate : 0;
  }

  get analyser(): AnalyserNode | null {
    return this.analyserNode;
  }

  get isReady(): boolean {
    return this.state === 'ready';
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  /**
   * Boot the audio graph. MUST be called from a user gesture (iOS is strict).
   * Safe to call repeatedly — subsequent calls just resume the context.
   */
  async start(): Promise<void> {
    if (!this.ctx) {
      const Ctor: typeof AudioContext =
        window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) throw new Error('Web Audio API is not available in this browser');
      this.ctx = new Ctor({ latencyHint: 'interactive' });
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    if (this.state === 'ready') return;
    if (!this.booting) {
      this.booting = this.boot().catch((e: unknown) => {
        this.booting = null;
        this.setState('error', message(e));
        throw e;
      });
    }
    return this.booting;
  }

  private async boot(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) throw new Error('no AudioContext');
    this.setState('loading', 'compiling dsp.wasm…');

    const bytes = await this.fetchWasm();

    this.setState('loading', 'loading worklet…');
    try {
      await ctx.audioWorklet.addModule(WORKLET_URL);
    } catch (e) {
      throw new Error(`could not load ${WORKLET_URL}: ${message(e)}`);
    }

    const node = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });

    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('worklet did not report ready in time')), READY_TIMEOUT_MS);
      node.port.onmessage = (ev: MessageEvent) => {
        const msg = ev.data as { type?: string; message?: string; samples?: number; loopLen?: number };
        if (msg?.type === 'ready') {
          clearTimeout(timer);
          resolve();
          return;
        }
        if (msg?.type === 'error') {
          clearTimeout(timer);
          reject(new Error(msg.message ?? 'worklet error'));
          return;
        }
        if (msg?.type === 'position') {
          this.events.onPosition?.(msg.samples ?? 0, msg.loopLen ?? 0);
        }
      };
    });

    node.port.postMessage({ type: 'load-wasm', bytes }, [bytes]);
    await ready;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.6;

    node.connect(analyser);
    analyser.connect(ctx.destination);

    this.node = node;
    this.analyserNode = analyser;
    this.setState('ready', `dsp ready @ ${ctx.sampleRate}Hz`);

    // Replay whatever the UI compiled while we were booting.
    if (this.lastParams) this.sendPatch(this.lastParams);
    if (this.lastLoop) this.sendLoop(this.lastLoop);
    if (this.playing) this.setPlaying(true);
  }

  private async fetchWasm(): Promise<ArrayBuffer> {
    let res: Response;
    try {
      res = await fetch(WASM_URL);
    } catch (e) {
      throw new Error(`could not fetch ${WASM_URL}: ${message(e)}`);
    }
    if (!res.ok) {
      throw new Error(`could not fetch ${WASM_URL} (HTTP ${res.status}) — run ./scripts/build-wasm.sh first`);
    }
    const bytes = await res.arrayBuffer();
    // A dev server that falls back to index.html would hand us HTML here.
    const magic = new Uint8Array(bytes.slice(0, 4));
    if (!(magic[0] === 0x00 && magic[1] === 0x61 && magic[2] === 0x73 && magic[3] === 0x6d)) {
      throw new Error(`${WASM_URL} is not a WebAssembly binary — run ./scripts/build-wasm.sh first`);
    }
    return bytes;
  }

  // ------------------------------------------------------------- messaging

  /** Hot reload: swap parameters without touching the transport. */
  sendPatch(params: Float32Array): void {
    this.lastParams = params;
    this.node?.port.postMessage({ type: 'patch', params });
  }

  sendLoop(loop: LoopIR | null): void {
    this.lastLoop = loop;
    this.node?.port.postMessage({ type: 'loop', loop });
  }

  setPlaying(playing: boolean): void {
    this.playing = playing;
    this.node?.port.postMessage({ type: 'transport', playing });
  }

  async stop(): Promise<void> {
    this.setPlaying(false);
  }

  private setState(state: EngineState, detail: string): void {
    this.state = state;
    this.events.onState?.(state, detail);
  }
}

function message(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
