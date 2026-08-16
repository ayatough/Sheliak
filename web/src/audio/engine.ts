// AudioContext / AudioWorklet lifecycle.
//
// The wasm binary is fetched on the main thread (worklets cannot fetch) and
// transferred to the processor as raw bytes; the worklet compiles it
// synchronously. Transferring a compiled WebAssembly.Module would be nicer,
// but Chrome silently drops Module postMessage without cross-origin isolation
// (COOP/COEP), which we deliberately avoid (docs/architecture.md).

import type { CompiledPluginTrack } from '../dsl/compile.ts';
import type { LoopIR } from '../dsl/loop.ts';
import { MAX_TRACKS } from '../shared/params.ts';

export type EngineState = 'idle' | 'loading' | 'ready' | 'error';

export interface EngineEvents {
  onState?: (state: EngineState, detail: string) => void;
  onPosition?: (samples: number, loopLen: number) => void;
  /**
   * What happened to the document's plugin tracks. Empty errors and a count
   * mean they are playing; anything else is a track the listener will not
   * hear, with the reason.
   */
  onPlugins?: (tracks: number, errors: string[]) => void;
}

// Injected by vite.config.ts at build time.
declare const __BUILD_ID__: string;

// BASE_URL ends with '/'; resolves correctly both at the root and under a
// subpath deployment such as GitHub Pages (/<repo>/). The ?v= query ties the
// stable-named assets to this build so a redeploy never pairs a fresh main
// bundle with a stale cached worklet or wasm binary.
const WASM_URL = `${import.meta.env.BASE_URL}dsp.wasm?v=${__BUILD_ID__}`;
const WORKLET_URL = `${import.meta.env.BASE_URL}worklet.js?v=${__BUILD_ID__}`;
/**
 * The CLAP host, bundled for the worklet by `npm run build:worklet-host`, and
 * the WCLAP bundle Sheliak ships. Both are fetched only when a document
 * actually names a plugin — the app must not pay for a feature it is not using,
 * and must not fail to start because a build step nobody needed was skipped.
 */
const WCLAP_HOST_URL = `${import.meta.env.BASE_URL}wclap-host.js?v=${__BUILD_ID__}`;
export const WCLAP_BUNDLE_URLS = [
  `${import.meta.env.BASE_URL}sheliak.wclap/module.wasm?v=${__BUILD_ID__}`,
];
const PROCESSOR_NAME = 'sheliak-processor';
const READY_TIMEOUT_MS = 10000;

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private analyserNode: AnalyserNode | null = null;
  private booting: Promise<void> | null = null;

  private state: EngineState = 'idle';
  private playing = false;

  /** Last params sent per track, replayed once the worklet is ready. */
  private lastParams: (Float32Array | null)[] = new Array(MAX_TRACKS).fill(null);
  private lastKeep = MAX_TRACKS;
  private lastLoop: LoopIR | null = null;
  private lastPluginTracks: CompiledPluginTrack[] = [];
  private lastPluginSig = '';
  private lastPluginShape = '';
  private hasPluginHost = false;
  /** The bundles, fetched once and kept: they are sent on every rebuild. */
  private bundles: ArrayBuffer[] | null = null;

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
    // The CLAP host first, into the same global scope: `worklet.js` looks for
    // it on `globalThis` rather than importing it. Its absence is not fatal —
    // a checkout that skipped `npm run build:worklet-host` still plays
    // everything except plugin tracks, and says so when one is declared.
    try {
      await ctx.audioWorklet.addModule(WCLAP_HOST_URL);
      this.hasPluginHost = true;
    } catch {
      this.hasPluginHost = false;
    }
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
        const msg = ev.data as {
          type?: string;
          message?: string;
          samples?: number;
          loopLen?: number;
          tracks?: number;
          errors?: string[];
        };
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
          return;
        }
        if (msg?.type === 'plugin-status') {
          this.events.onPlugins?.(msg.tracks ?? 0, msg.errors ?? []);
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
    for (let t = 0; t < MAX_TRACKS; t++) {
      const params = this.lastParams[t];
      if (params) this.sendPatch(t, params);
    }
    this.sendClearTracks(this.lastKeep);
    if (this.lastPluginTracks.length > 0) await this.sendPluginTracks(this.lastPluginTracks, true);
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

  /** Hot reload: swap one track's parameters without touching the transport. */
  sendPatch(track: number, params: Float32Array): void {
    if (track < 0 || track >= MAX_TRACKS) return;
    this.lastParams[track] = params;
    this.node?.port.postMessage({ type: 'patch', track, params });
  }

  /** Disable tracks at or above `keep` (a synth fence was deleted). */
  sendClearTracks(keep: number): void {
    this.lastKeep = keep;
    for (let t = keep; t < MAX_TRACKS; t++) this.lastParams[t] = null;
    this.node?.port.postMessage({ type: 'clear-tracks', keep });
  }

  /**
   * Hands the worklet the document's plugin tracks, fetching the WCLAP bundles
   * the first time one is needed.
   *
   * Sent only when the tracks actually changed: rebuilding means new plugin
   * instances, which means a sounding note stops. A document with no plugin
   * track costs one comparison and no network.
   */
  async sendPluginTracks(tracks: readonly CompiledPluginTrack[], force = false): Promise<void> {
    const sig = JSON.stringify(tracks);
    if (!force && sig === this.lastPluginSig) return;

    // Which plugin sits on which track is what a rebuild is for. A parameter
    // that moved is not: rebuilding on a knob would restart the plugin thirty
    // times a second and cut every note it was holding.
    const shape = JSON.stringify(tracks.map((t) => [t.track, t.from, t.id]));
    const paramsOnly = !force && shape === this.lastPluginShape && this.lastPluginSig !== '';
    this.lastPluginSig = sig;
    this.lastPluginShape = shape;
    this.lastPluginTracks = [...tracks];

    if (paramsOnly) {
      for (const track of tracks) {
        this.node?.port.postMessage({
          type: 'plugin-params',
          track: track.track,
          params: track.params,
        });
      }
      return;
    }

    if (tracks.length === 0) {
      this.node?.port.postMessage({ type: 'plugins', bundles: [], tracks: [] });
      return;
    }
    if (!this.hasPluginHost) {
      this.events.onPlugins?.(0, [
        'the CLAP host is missing, so a plugin track is silent — ' +
          'run `npm run build:worklet-host` (it writes public/wclap-host.js)',
      ]);
      return;
    }

    let bundles: ArrayBuffer[];
    try {
      bundles = await this.fetchBundles();
    } catch (e) {
      this.events.onPlugins?.(0, [message(e)]);
      return;
    }
    // Copies, because a transferred ArrayBuffer is detached here and these are
    // sent again on every rebuild.
    this.node?.port.postMessage({
      type: 'plugins',
      bundles: bundles.map((b) => b.slice(0)),
      tracks: this.lastPluginTracks,
    });
  }

  private async fetchBundles(): Promise<ArrayBuffer[]> {
    if (this.bundles) return this.bundles;
    const out: ArrayBuffer[] = [];
    for (const url of WCLAP_BUNDLE_URLS) {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`could not fetch ${url} (HTTP ${res.status}) — run ./scripts/build-wclap.sh first`);
      }
      out.push(await res.arrayBuffer());
    }
    this.bundles = out;
    return out;
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
