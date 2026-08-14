// End-to-end integration: the real dsp.wasm driven with params produced by the
// DSL compiler, scheduled the same way worklet.js does. Requires
// public/dsp.wasm (built by ../scripts/build-wasm.sh); skipped when absent.
//
// The scheduling itself lives in `audio/offline.ts`, because `sheliak render`
// needs the same thing and a second copy of the ABI mirror is exactly the drift
// this test exists to catch. What is tested here is the pairing: this document,
// through that renderer, into the binary the browser loads.

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from './dsl/compile.ts';
import { instantiateDsp, renderLoop } from './audio/offline.ts';
import { DEFAULT_DOC } from './defaultDoc.ts';

const WASM_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../public/dsp.wasm');
const SR = 48000;

function instantiate() {
  return instantiateDsp(readFileSync(WASM_PATH));
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
    const { l, r } = renderLoop(instantiate(), result.tracks, result.loop!, total, SR);

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
    const a = renderLoop(instantiate(), result.tracks, result.loop!, total, SR);
    const b = renderLoop(instantiate(), result.tracks, result.loop!, total, SR);
    for (let i = 0; i < total; i++) {
      expect(a.l[i]).toBe(b.l[i]);
      expect(a.r[i]).toBe(b.r[i]);
    }
  });

  it('the stems of the four tracks sum back to the mix, sample for sample', () => {
    // What `render --stems` promises. It holds through the real wasm because a
    // stem is tapped after that track's own FX chain and the master bus does
    // nothing but sum — the guard is the identity below CLIP_KNEE, and the
    // default document sits well under it.
    const result = compile(DEFAULT_DOC, SR);
    const tracks = result.tracks.map((t) => t.track);
    expect(tracks).toHaveLength(4);

    const total = SR / 2;
    const { l, r, stems } = renderLoop(instantiate(), result.tracks, result.loop!, total, SR, tracks);
    expect(stems.size).toBe(4);

    // `Math.fround` after every add, in track order: the engine accumulates in
    // f32 and JS numbers are f64, so summing them the obvious way lands a few
    // parts in 10^12 away from what the mix actually holds. Reproducing the
    // engine's arithmetic is the point — an approximate check here would pass
    // just as happily on a stem that was subtly the wrong track.
    for (let i = 0; i < total; i++) {
      let sumL = 0;
      let sumR = 0;
      for (const track of tracks) {
        const stem = stems.get(track)!;
        sumL = Math.fround(sumL + stem.l[i]!);
        sumR = Math.fround(sumR + stem.r[i]!);
      }
      expect(sumL).toBe(l[i]);
      expect(sumR).toBe(r[i]);
    }

    // And each stem is really only its own track.
    for (const track of tracks) {
      const stem = stems.get(track)!;
      expect(stem.l.some((v) => v !== 0)).toBe(true);
    }
  });
});
