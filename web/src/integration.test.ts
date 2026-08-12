// End-to-end integration: the real dsp.wasm driven with params produced by the
// DSL compiler, scheduled the same way worklet.js does. Requires
// public/dsp.wasm (built by ../scripts/build-wasm.sh); skipped when absent.

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile, type CompileResult } from './dsl/compile.ts';
import type { LoopIR } from './dsl/loop.ts';
import { DEFAULT_DOC } from './defaultDoc.ts';
import { PARAM_COUNT } from './shared/params.ts';

const WASM_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../public/dsp.wasm');
const SR = 48000;
const BLOCK = 128;

// v0.3 ABI: params_ptr / apply_patch / note_on / note_off are track-indexed.
interface DspExports {
  memory: WebAssembly.Memory;
  init(sampleRate: number): void;
  params_ptr(track: number): number;
  apply_patch(track: number): void;
  note_on(track: number, note: number, velocity: number): void;
  note_off(track: number, note: number): void;
  all_notes_off(): void;
  process(nframes: number): void;
  out_l_ptr(): number;
  out_r_ptr(): number;
}

function instantiate(): DspExports {
  const bytes = readFileSync(WASM_PATH);
  const module = new WebAssembly.Module(bytes);
  const instance = new WebAssembly.Instance(module, {});
  return instance.exports as unknown as DspExports;
}

/**
 * Render `total` samples, applying every compiled track and dispatching the
 * merged event list exactly the way worklet.js does.
 */
function renderLoop(dsp: DspExports, result: CompileResult, loop: LoopIR, total: number): { l: Float32Array; r: Float32Array } {
  dsp.init(SR);
  for (const track of result.tracks) {
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
      if (ev.kind === 0) dsp.note_on(ev.track, ev.note, ev.velocity);
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

describe.skipIf(!existsSync(WASM_PATH))('dsp.wasm end-to-end', () => {
  it('renders the default document with audible, finite, bounded output', () => {
    const result = compile(DEFAULT_DOC, SR);
    expect(result.errors).toEqual([]);
    expect(result.tracks).toHaveLength(4);
    expect(result.loop).toBeDefined();
    // Every track should actually be playing something.
    expect(new Set(result.loop!.events.map((e) => e.track)).size).toBe(4);

    const total = SR; // 1 second
    const { l, r } = renderLoop(instantiate(), result, result.loop!, total);

    let peak = 0;
    let sum = 0;
    let dc = 0;
    for (let i = 0; i < total; i++) {
      expect(Number.isFinite(l[i])).toBe(true);
      expect(Number.isFinite(r[i])).toBe(true);
      peak = Math.max(peak, Math.abs(l[i]), Math.abs(r[i]));
      sum += l[i] * l[i];
      dc += l[i];
    }
    const rms = Math.sqrt(sum / total);
    expect(rms).toBeGreaterThan(0.01); // actually making sound
    expect(peak).toBeLessThanOrEqual(1.0);
    expect(Math.abs(dc / total)).toBeLessThan(1e-3);

    // Stereo: unison spread should decorrelate L and R.
    let diff = 0;
    for (let i = 0; i < total; i++) diff += Math.abs(l[i] - r[i]);
    expect(diff / total).toBeGreaterThan(1e-4);
  });

  it('is bit-exact across two independent renders (same DSL + seed)', () => {
    const result = compile(DEFAULT_DOC, SR);
    const total = SR / 2;
    const a = renderLoop(instantiate(), result, result.loop!, total);
    const b = renderLoop(instantiate(), result, result.loop!, total);
    for (let i = 0; i < total; i++) {
      expect(a.l[i]).toBe(b.l[i]);
      expect(a.r[i]).toBe(b.r[i]);
    }
  });
});
