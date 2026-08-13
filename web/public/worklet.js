/* Sheliak AudioWorkletProcessor — self-contained plain JS.
 *
 * This file is served verbatim from /worklet.js and loaded with
 * `audioWorklet.addModule()`. It is deliberately NOT TypeScript and has no
 * imports: bundlers rewrite module graphs in ways that break worklet scope.
 *
 * Protocol (docs/architecture.md §6):
 *   main → worklet: 'load-wasm' | 'patch' | 'clear-tracks' | 'loop' | 'transport'
 *   worklet → main: 'ready' | 'position' | 'error'
 *
 * v0.3 is multi-track: 'patch' carries a track index, params_ptr/apply_patch/
 * note_on/note_off are all track-indexed, and 'clear-tracks' disables the
 * tracks a shrinking document no longer declares.
 *
 * Scheduling: the loop position is a plain sample counter. Each 128-frame
 * render quantum is split at event boundaries so note_on/note_off land on the
 * exact sample. No setTimeout/setInterval anywhere.
 */

// Mirror of web/src/shared/params.ts / dsp/src/params.rs.
const PARAM_COUNT = 192;
const MAX_TRACKS = 8;

// Buffers exported by the DSP core are 128 frames (the render quantum).
const MAX_BLOCK = 128;

// Post a position update roughly every this many samples (~10Hz at 48k).
const POSITION_INTERVAL = 4096;

class SheliakProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    this.exports = null;
    this.memory = null;
    this.ready = false;

    // Cached typed-array views over the wasm heap. `viewBuffer` lets us detect
    // detachment after a memory.grow().
    this.viewBuffer = null;
    this.outL = null;
    this.outR = null;
    // One params view per track (params_ptr is track-indexed since v0.3).
    this.paramsViews = new Array(MAX_TRACKS).fill(null);

    // Transport / scheduler state.
    this.playing = false;
    this.loop = null; // { lengthSamples, events: [{offsetSamples, kind, note, velocity}] }
    this.counter = 0; // samples since the start of the current loop pass
    this.evIdx = 0; // index of the next event to dispatch this pass
    this.posAccum = 0;

    // Patches may arrive before the wasm module finished instantiating.
    this.pendingParams = new Array(MAX_TRACKS).fill(null);
    this.pendingClear = -1;

    this.port.onmessage = (event) => this.onMessage(event.data);
  }

  onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'load-wasm':
        this.loadWasm(msg.bytes);
        break;
      case 'patch':
        this.applyPatch(msg.track | 0, msg.params);
        break;
      case 'clear-tracks':
        this.clearTracks(msg.keep | 0);
        break;
      case 'loop':
        this.setLoop(msg.loop || null);
        break;
      case 'transport':
        this.setPlaying(!!msg.playing);
        break;
      default:
        break;
    }
  }

  // ------------------------------------------------------------------ wasm

  loadWasm(bytes) {
    try {
      // Compile from raw bytes: Chrome refuses to structured-clone a
      // WebAssembly.Module into a worklet without cross-origin isolation, so
      // the main thread sends the binary instead. Synchronous compilation is
      // allowed off the main thread and takes only a few ms for this module.
      const module = new WebAssembly.Module(bytes);
      const instance = new WebAssembly.Instance(module, {});
      const ex = instance.exports;
      const required = [
        'memory',
        'init',
        'params_ptr',
        'apply_patch',
        'note_on',
        'note_off',
        'all_notes_off',
        'process',
        'out_l_ptr',
        'out_r_ptr',
      ];
      for (let i = 0; i < required.length; i++) {
        if (!ex[required[i]]) {
          throw new Error('dsp.wasm is missing export "' + required[i] + '"');
        }
      }

      this.exports = ex;
      this.memory = ex.memory;
      // `sampleRate` is a global in AudioWorkletGlobalScope — never hardcoded.
      ex.init(sampleRate);
      this.refreshViews();
      this.ready = true;
      this.port.postMessage({ type: 'ready', sampleRate: sampleRate });

      for (let t = 0; t < MAX_TRACKS; t++) {
        const p = this.pendingParams[t];
        if (p) {
          this.pendingParams[t] = null;
          this.applyPatch(t, p);
        }
      }
      if (this.pendingClear >= 0) {
        const keep = this.pendingClear;
        this.pendingClear = -1;
        this.clearTracks(keep);
      }
    } catch (e) {
      this.ready = false;
      this.port.postMessage({ type: 'error', message: String((e && e.message) || e) });
    }
  }

  refreshViews() {
    const buf = this.memory.buffer;
    this.outL = new Float32Array(buf, this.exports.out_l_ptr(), MAX_BLOCK);
    this.outR = new Float32Array(buf, this.exports.out_r_ptr(), MAX_BLOCK);
    for (let t = 0; t < MAX_TRACKS; t++) {
      this.paramsViews[t] = new Float32Array(buf, this.exports.params_ptr(t), PARAM_COUNT);
    }
    this.viewBuffer = buf;
  }

  /** wasm memory growth detaches our views — re-create them when that happens. */
  ensureViews() {
    if (this.viewBuffer !== this.memory.buffer) this.refreshViews();
  }

  // ----------------------------------------------------------------- state

  applyPatch(track, params) {
    if (!params || track < 0 || track >= MAX_TRACKS) return;
    if (!this.ready) {
      this.pendingParams[track] = params;
      return;
    }
    this.ensureViews();
    const view = this.paramsViews[track];
    const n = Math.min(params.length, PARAM_COUNT);
    for (let i = 0; i < n; i++) view[i] = params[i];
    this.exports.apply_patch(track);
  }

  /**
   * Silence tracks the document no longer declares: zeroing a block disables
   * its oscillators and noise, so the track stops costing anything.
   */
  clearTracks(keep) {
    if (!this.ready) {
      this.pendingClear = keep;
      return;
    }
    this.ensureViews();
    for (let t = Math.max(keep, 0); t < MAX_TRACKS; t++) {
      const view = this.paramsViews[t];
      for (let i = 0; i < PARAM_COUNT; i++) view[i] = 0;
      this.exports.apply_patch(t);
    }
  }

  setLoop(loop) {
    if (!loop || !loop.events || !loop.lengthSamples) {
      this.loop = null;
      this.evIdx = 0;
      if (this.ready) this.exports.all_notes_off();
      return;
    }
    this.loop = loop;
    if (this.counter >= loop.lengthSamples) this.counter = this.counter % loop.lengthSamples;
    // Resume mid-pass without retriggering notes we have already passed.
    let idx = 0;
    while (idx < loop.events.length && loop.events[idx].offsetSamples <= this.counter) idx++;
    this.evIdx = idx;
  }

  setPlaying(playing) {
    if (playing === this.playing) return;
    this.playing = playing;
    this.counter = 0;
    this.evIdx = 0;
    if (!playing && this.ready) this.exports.all_notes_off();
  }

  // --------------------------------------------------------------- render

  process(_inputs, outputs) {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const left = out[0];
    const right = out.length > 1 ? out[1] : null;
    const frames = left.length;

    if (!this.ready) {
      left.fill(0);
      if (right) right.fill(0);
      return true;
    }

    this.ensureViews();

    const scheduling = this.playing && this.loop !== null && this.loop.lengthSamples > 0;
    let frame = 0;

    while (frame < frames) {
      let n = frames - frame;

      if (scheduling) {
        const len = this.loop.lengthSamples;
        const events = this.loop.events;

        // Fire everything due at the current sample position.
        while (this.evIdx < events.length && events[this.evIdx].offsetSamples <= this.counter) {
          const ev = events[this.evIdx++];
          const track = ev.track | 0;
          // note_on(track, note, velocity, glide_s, legato): -1 asks for the
          // patch's own `voice.glide` and 0 for a normal retrigger, which is
          // what every event carries until the note layer emits glissandi
          // (docs/workstreams.md §10).
          if (ev.kind === 0) this.exports.note_on(track, ev.note, ev.velocity, -1, 0);
          else this.exports.note_off(track, ev.note);
        }

        // Render only up to the next boundary (next event, or the loop wrap).
        let boundary = len;
        if (this.evIdx < events.length && events[this.evIdx].offsetSamples < boundary) {
          boundary = events[this.evIdx].offsetSamples;
        }
        const avail = boundary - this.counter;
        if (avail > 0 && avail < n) n = avail;
      }

      if (n > MAX_BLOCK) n = MAX_BLOCK;
      if (n <= 0) n = 1; // never stall

      this.exports.process(n);
      this.ensureViews();
      left.set(this.outL.subarray(0, n), frame);
      if (right) right.set(this.outR.subarray(0, n), frame);
      frame += n;

      if (scheduling) {
        this.counter += n;
        const len = this.loop.lengthSamples;
        while (this.counter >= len) {
          this.counter -= len;
          this.evIdx = 0;
        }
      }
    }

    this.posAccum += frames;
    if (this.posAccum >= POSITION_INTERVAL) {
      this.posAccum = 0;
      this.port.postMessage({
        type: 'position',
        samples: this.counter,
        loopLen: this.loop ? this.loop.lengthSamples : 0,
      });
    }

    return true;
  }
}

registerProcessor('sheliak-processor', SheliakProcessor);
