// AudioContext / AudioWorklet lifecycle.
//
// The wasm module is compiled on the main thread (worklets cannot fetch) and
// transferred to the processor as a WebAssembly.Module (SPEC.md §9).

import type { LoopIR } from '../dsl/loop.ts';

export type EngineState = 'idle' | 'loading' | 'ready' | 'error';

export interface EngineEvents {
  onState?: (state: EngineState, detail: string) => void;
  onPosition?: (samples: number, loopLen: number) => void;
}

const WASM_URL = '/dsp.wasm';
const WORKLET_URL = '/worklet.js';
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

    const module = await this.fetchWasm();

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

    node.port.postMessage({ type: 'load-wasm', module });
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

  private async fetchWasm(): Promise<WebAssembly.Module> {
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
    try {
      return await WebAssembly.compile(bytes);
    } catch (e) {
      throw new Error(`could not compile ${WASM_URL}: ${message(e)}`);
    }
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
