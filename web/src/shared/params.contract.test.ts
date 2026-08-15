// `dsp/src/params.rs` and `params.ts` are one file written twice. This is the
// test that says so out loud.
//
// A disagreement between them is the one change that breaks in silence: every
// suite stays green, the wasm builds, and the audio simply comes out wrong,
// because one side wrote `cutoff` where the other reads `res`. AGENTS.md warns
// about it three times, and until now nothing checked it — the wasm end-to-end
// test would only catch a disagreement that happened to be audible in the four
// patches it renders.
//
// Every constant defined on both sides must agree. A constant defined on only
// one side must be named below, so that adding one is a decision rather than an
// oversight.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as ts from './params.ts';

const RUST_FILE = fileURLToPath(new URL('../../../dsp/src/params.rs', import.meta.url));

/** Internal to the DSP core: sizes and table ids the notation never names. */
const RUST_ONLY = [
  'FRAME_LEN',
  'FX_TYPE_COUNT',
  'TABLE_COUNT',
  'TABLE_FOLD',
  'TABLE_PWM',
  'TABLE_SAW',
  'TABLE_SINE',
  'TABLE_SQUARE',
  'TABLE_TRI',
];

/**
 * Modulation *source* ids. The Rust side matches on the literals rather than
 * naming them, which is a gap in the contract rather than a difference of
 * meaning — the numbers are in docs/architecture.md and both sides obey them.
 */
const TS_ONLY = ['SRC_ENV_AMP', 'SRC_ENV_FILTER', 'SRC_LFO1', 'SRC_NONE', 'SRC_VELOCITY'];

function rustConstants(): Map<string, number> {
  const source = readFileSync(RUST_FILE, 'utf8');
  const found = new Map<string, number>();
  const pattern = /^pub const (\w+): \w+ = (-?[\d_]+(?:\.\d+)?)/gm;
  for (const [, name, value] of source.matchAll(pattern)) {
    found.set(name, Number(value.replace(/_/g, '')));
  }
  return found;
}

function tsConstants(): Map<string, number> {
  const found = new Map<string, number>();
  for (const [name, value] of Object.entries(ts)) {
    if (typeof value === 'number') found.set(name, value);
  }
  return found;
}

describe('the parameter block contract', () => {
  const rust = rustConstants();
  const web = tsConstants();

  it('finds constants on both sides', () => {
    // A regex that silently matched nothing would make every other assertion
    // below pass vacuously.
    expect(rust.size).toBeGreaterThan(90);
    expect(web.size).toBeGreaterThan(90);
  });

  it('agrees on every constant defined on both sides', () => {
    const shared = [...rust.keys()].filter((name) => web.has(name)).sort();
    expect(shared.length).toBeGreaterThan(90);

    const disagreements = shared
      .filter((name) => rust.get(name) !== web.get(name))
      .map((name) => `${name}: params.rs = ${rust.get(name)}, params.ts = ${web.get(name)}`);
    expect(disagreements).toEqual([]);
  });

  it('has no constant on one side that is not accounted for', () => {
    const rustOnly = [...rust.keys()].filter((name) => !web.has(name)).sort();
    const tsOnly = [...web.keys()].filter((name) => !rust.has(name)).sort();

    // Adding a parameter means adding it to both files (non-negotiable 3). If
    // this fails, mirror the constant rather than extending the list — the list
    // is for constants that genuinely belong to one side only.
    expect(rustOnly).toEqual([...RUST_ONLY].sort());
    expect(tsOnly).toEqual([...TS_ONLY].sort());
  });

  it('keeps the effect blocks inside the parameter block', () => {
    // The layout arithmetic both sides perform, checked once: the last slot's
    // block has to end at or before PARAM_COUNT. Slots, not types — which is
    // why adding an effect type no longer needs room reserved for it.
    const end = ts.FX_SLOT_BASE + ts.FX_SLOTS * ts.FX_SLOT_STRIDE;
    expect(end).toBeLessThanOrEqual(ts.PARAM_COUNT);
  });
});
