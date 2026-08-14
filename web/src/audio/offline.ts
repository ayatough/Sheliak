// Rendering the loop without an AudioContext.
//
// This is `public/worklet.js` with the audio thread taken out: the same ABI, the
// same sample-accurate event dispatch, the same wrap at the loop boundary. It
// exists because two callers need to render a document to samples off the audio
// thread — the end-to-end test, which is how this project checks its own output
// without ears, and `sheliak render`, which writes a file.
//
// It has to keep matching worklet.js. A JS call with arguments missing passes 0
// for the glide and the legato flag, which reads as "no glide" rather than "use
// the patch's", so a drift here would be silent for every patch whose glide is
// zero. `src/integration.test.ts` is what catches that.

import type { CompiledTrack } from '../dsl/compile.ts';
import type { LoopIR } from '../dsl/loop.ts';
import { PARAM_COUNT } from '../shared/params.ts';

/** The wasm exports, as documented in docs/architecture.md. */
export interface DspExports {
  memory: WebAssembly.Memory;
  init(sampleRate: number): void;
  params_ptr(track: number): number;
  apply_patch(track: number): void;
  note_on(track: number, note: number, velocity: number, glideS: number, legato: number): void;
  note_off(track: number, note: number): void;
  all_notes_off(): void;
  process(nframes: number): void;
  out_l_ptr(): number;
  out_r_ptr(): number;
}

/** The render quantum the worklet is called with. */
const BLOCK = 128;

export function instantiateDsp(bytes: BufferSource): DspExports {
  const module = new WebAssembly.Module(bytes);
  const instance = new WebAssembly.Instance(module, {});
  return instance.exports as unknown as DspExports;
}

/**
 * Renders `total` samples of `loop`, applying every compiled track first.
 *
 * The engine is initialised here rather than by the caller: `init()` allocates
 * the voices and wavetables, and a render that reused a previous instance's
 * state would not be reproducible, which is the one property this has to have.
 */
export function renderLoop(
  dsp: DspExports,
  tracks: readonly CompiledTrack[],
  loop: LoopIR,
  total: number,
  sampleRate: number,
): { l: Float32Array; r: Float32Array } {
  dsp.init(sampleRate);
  for (const track of tracks) {
    new Float32Array(dsp.memory.buffer, dsp.params_ptr(track.track), PARAM_COUNT).set(track.params);
    dsp.apply_patch(track.track);
  }

  const l = new Float32Array(total);
  const r = new Float32Array(total);
  let counter = 0;
  let evIdx = 0;
  let written = 0;
  while (written < total) {
    while (evIdx < loop.events.length && loop.events[evIdx]!.offsetSamples <= counter) {
      const ev = loop.events[evIdx++]!;
      // -1 / 0, exactly as worklet.js sends them: use the patch's glide, no legato.
      if (ev.kind === 0) dsp.note_on(ev.track, ev.note, ev.velocity, -1, 0);
      else dsp.note_off(ev.track, ev.note);
    }
    let boundary = loop.lengthSamples;
    if (evIdx < loop.events.length) boundary = Math.min(boundary, loop.events[evIdx]!.offsetSamples);
    let n = Math.min(BLOCK, total - written, boundary - counter);
    if (n <= 0) n = 1;
    dsp.process(n);
    l.set(new Float32Array(dsp.memory.buffer, dsp.out_l_ptr(), n), written);
    r.set(new Float32Array(dsp.memory.buffer, dsp.out_r_ptr(), n), written);
    written += n;
    counter += n;
    while (counter >= loop.lengthSamples) {
      counter -= loop.lengthSamples;
      evIdx = 0;
    }
  }
  return { l, r };
}

/**
 * Renders `total` samples with every note released at the start, which is how a
 * tail is produced: the loop has stopped, the effects and release stages have
 * not. Continues from the state `renderLoop` left behind, so it must be called
 * on the same instance and nothing may re-`init()` in between.
 */
export function renderTail(dsp: DspExports, total: number): { l: Float32Array; r: Float32Array } {
  dsp.all_notes_off();
  const l = new Float32Array(total);
  const r = new Float32Array(total);
  let written = 0;
  while (written < total) {
    const n = Math.min(BLOCK, total - written);
    dsp.process(n);
    l.set(new Float32Array(dsp.memory.buffer, dsp.out_l_ptr(), n), written);
    r.set(new Float32Array(dsp.memory.buffer, dsp.out_r_ptr(), n), written);
    written += n;
  }
  return { l, r };
}
