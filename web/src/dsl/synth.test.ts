import { describe, it, expect } from 'vitest';
import { parseSynth } from './synth.ts';
import { expandPatch, irToParams } from './ir.ts';
import {
  PARAM_COUNT,
  P_POLYPHONY,
  P_GLIDE_S,
  P_MASTER_GAIN,
  P_SEED,
  OSC_A_BASE,
  OSC_B_BASE,
  OSC_ENABLED,
  OSC_TABLE_ID,
  OSC_LEVEL,
  OSC_MORPH,
  OSC_UNISON,
  OSC_DETUNE_CENTS,
  OSC_SPREAD,
  OSC_TUNE_SEMI,
  OSC_TUNE_CENTS,
  OSC_PHASE_RANDOM,
  P_FILTER_MODE,
  P_FILTER_CUTOFF_HZ,
  P_FILTER_RES,
  P_FILTER_DRIVE,
  P_FILTER_KEYTRACK,
  ENV_AMP_BASE,
  ENV_FILTER_BASE,
  ENV_A,
  ENV_D,
  ENV_S,
  ENV_R,
  P_LFO_WAVE,
  P_LFO_RATE_HZ,
  P_LFO_PHASE,
  MOD_BASE,
  MOD_STRIDE,
  MOD_SRC,
  MOD_DST,
  MOD_AMOUNT,
} from '../shared/params.ts';

// The full example from docs/syntax.md (body only).
const EXAMPLE = `osc:
  - { table: basic/saw, level: 0dB, morph: 0%, unison: 7, detune: 22c, spread: 80% }
  - { table: basic/square, level: -8dB, morph: 30%, tune: -12st }

filter: { type: lp12, cutoff: 800Hz, res: 0.3, drive: 0.2, key_track: 50% }

env:
  amp:    { a: 5ms,  d: 200ms, s: 70%,  r: 120ms }
  filter: { a: 2ms,  d: 400ms, s: 0%,   r: 100ms }

lfo:
  1: { wave: tri, rate: 1/4, phase: 0% }

mod:
  - { from: env.filter, to: filter.cutoff, amount: +2400c }
  - { from: lfo.1,      to: osc.1.morph,   amount: 25% }

voice: { polyphony: 8, glide: 0ms }`;

function parseExample() {
  return parseSynth(EXAMPLE, { id: 'lead', seed: '42' }, { bodyStartLine: 1, bpm: 124 });
}

describe('parseSynth — docs/syntax.md example', () => {
  it('parses without errors', () => {
    const r = parseExample();
    expect(r.errors).toEqual([]);
    expect(r.ir).not.toBeNull();
    expect(r.params).not.toBeNull();
    expect(r.params!.length).toBe(PARAM_COUNT);
  });

  it('fills the global block', () => {
    const p = parseExample().params!;
    expect(p[P_POLYPHONY]).toBe(8);
    expect(p[P_GLIDE_S]).toBe(0);
    expect(p[P_MASTER_GAIN]).toBeCloseTo(0.5, 6);
    expect(p[P_SEED]).toBe(42);
  });

  it('fills osc A (supersaw)', () => {
    const p = parseExample().params!;
    expect(p[OSC_A_BASE + OSC_ENABLED]).toBe(1);
    expect(p[OSC_A_BASE + OSC_TABLE_ID]).toBe(2); // basic/saw
    expect(p[OSC_A_BASE + OSC_LEVEL]).toBe(1); // 0dB → 1.0 linear
    expect(p[OSC_A_BASE + OSC_MORPH]).toBe(0);
    expect(p[OSC_A_BASE + OSC_UNISON]).toBe(7);
    expect(p[OSC_A_BASE + OSC_DETUNE_CENTS]).toBe(22);
    expect(p[OSC_A_BASE + OSC_SPREAD]).toBeCloseTo(0.8, 6);
    expect(p[OSC_A_BASE + OSC_TUNE_SEMI]).toBe(0);
    expect(p[OSC_A_BASE + OSC_TUNE_CENTS]).toBe(0);
    expect(p[OSC_A_BASE + OSC_PHASE_RANDOM]).toBe(1);
  });

  it('fills osc B', () => {
    const p = parseExample().params!;
    expect(p[OSC_B_BASE + OSC_ENABLED]).toBe(1);
    expect(p[OSC_B_BASE + OSC_TABLE_ID]).toBe(3); // basic/square
    expect(p[OSC_B_BASE + OSC_LEVEL]).toBeCloseTo(0.3981072, 6); // -8dB
    expect(p[OSC_B_BASE + OSC_MORPH]).toBeCloseTo(0.3, 6);
    expect(p[OSC_B_BASE + OSC_UNISON]).toBe(1); // default
    expect(p[OSC_B_BASE + OSC_TUNE_SEMI]).toBe(-12);
    expect(p[OSC_B_BASE + OSC_TUNE_CENTS]).toBe(0);
  });

  it('fills the filter block', () => {
    const p = parseExample().params!;
    expect(p[P_FILTER_MODE]).toBe(0); // lp12
    expect(p[P_FILTER_CUTOFF_HZ]).toBe(800);
    expect(p[P_FILTER_RES]).toBeCloseTo(0.3, 6);
    expect(p[P_FILTER_DRIVE]).toBeCloseTo(0.2, 6);
    expect(p[P_FILTER_KEYTRACK]).toBeCloseTo(0.5, 6);
  });

  it('fills both envelopes in seconds', () => {
    const p = parseExample().params!;
    expect(p[ENV_AMP_BASE + ENV_A]).toBeCloseTo(0.005, 6);
    expect(p[ENV_AMP_BASE + ENV_D]).toBeCloseTo(0.2, 6);
    expect(p[ENV_AMP_BASE + ENV_S]).toBeCloseTo(0.7, 6);
    expect(p[ENV_AMP_BASE + ENV_R]).toBeCloseTo(0.12, 6);
    expect(p[ENV_FILTER_BASE + ENV_A]).toBeCloseTo(0.002, 6);
    expect(p[ENV_FILTER_BASE + ENV_D]).toBeCloseTo(0.4, 6);
    expect(p[ENV_FILTER_BASE + ENV_S]).toBe(0);
    expect(p[ENV_FILTER_BASE + ENV_R]).toBeCloseTo(0.1, 6);
  });

  it('converts the tempo-synced LFO rate to Hz on the TS side', () => {
    const p = parseExample().params!;
    expect(p[P_LFO_WAVE]).toBe(1); // tri
    // `1/4` = one beat; at 124bpm that is 124/60 Hz.
    expect(p[P_LFO_RATE_HZ]).toBeCloseTo(124 / 60, 5);
    expect(p[P_LFO_PHASE]).toBe(0);
  });

  it('fills the mod matrix with the right units per destination', () => {
    const p = parseExample().params!;
    expect(p[MOD_BASE + MOD_SRC]).toBe(1); // env.filter
    expect(p[MOD_BASE + MOD_DST]).toBe(1); // filter.cutoff
    expect(p[MOD_BASE + MOD_AMOUNT]).toBe(2400); // cents

    const s1 = MOD_BASE + MOD_STRIDE;
    expect(p[s1 + MOD_SRC]).toBe(3); // lfo.1
    expect(p[s1 + MOD_DST]).toBe(2); // osc.1.morph
    expect(p[s1 + MOD_AMOUNT]).toBeCloseTo(0.25, 6); // normalized

    // Unused slots are zeroed.
    const s2 = MOD_BASE + 2 * MOD_STRIDE;
    expect(p[s2 + MOD_SRC]).toBe(0);
    expect(p[s2 + MOD_DST]).toBe(0);
  });

  it('exposes an expanded IR', () => {
    const ir = parseExample().ir!;
    expect(ir.id).toBe('lead');
    expect(ir.seed).toBe(42);
    expect(ir.osc).toHaveLength(2);
    expect(ir.osc[0]!.table).toBe('basic/saw');
    expect(ir.voice.polyphony).toBe(8);
  });
});

describe('defaults expansion', () => {
  it('an empty patch expands to the docs/syntax.md defaults', () => {
    const r = parseSynth('', {}, { bodyStartLine: 1, bpm: 120 });
    expect(r.errors).toEqual([]);
    const p = r.params!;
    expect(p[OSC_A_BASE + OSC_ENABLED]).toBe(1);
    expect(p[OSC_B_BASE + OSC_ENABLED]).toBe(0);
    expect(p[OSC_A_BASE + OSC_TABLE_ID]).toBe(2); // basic/saw
    expect(p[OSC_A_BASE + OSC_LEVEL]).toBe(1); // 0dB
    expect(p[OSC_A_BASE + OSC_UNISON]).toBe(1);
    expect(p[P_FILTER_CUTOFF_HZ]).toBe(20000);
    expect(p[P_FILTER_MODE]).toBe(0);
    expect(p[ENV_AMP_BASE + ENV_A]).toBeCloseTo(0.005, 6);
    expect(p[ENV_AMP_BASE + ENV_S]).toBeCloseTo(0.7, 6);
    expect(p[ENV_FILTER_BASE + ENV_D]).toBeCloseTo(0.4, 6);
    expect(p[P_LFO_WAVE]).toBe(1); // tri
    expect(p[P_LFO_RATE_HZ]).toBe(1);
    expect(p[P_POLYPHONY]).toBe(8);
    expect(p[P_SEED]).toBe(0);
  });

  it('partial oscillators keep their defaults', () => {
    const r = parseSynth('osc:\n  - { table: morph/pwm }', {}, { bpm: 120 });
    expect(r.errors).toEqual([]);
    const p = r.params!;
    expect(p[OSC_A_BASE + OSC_TABLE_ID]).toBe(4);
    expect(p[OSC_A_BASE + OSC_UNISON]).toBe(1);
    expect(p[OSC_A_BASE + OSC_LEVEL]).toBe(1);
    expect(p[OSC_B_BASE + OSC_ENABLED]).toBe(0);
  });

  it('irToParams(expandPatch()) is stable', () => {
    const p = irToParams(expandPatch());
    expect(p.length).toBe(PARAM_COUNT);
    expect(p[P_MASTER_GAIN]).toBeCloseTo(0.5, 6);
  });
});

describe('error reporting', () => {
  it('rejects bare numbers where a unit is required, with line/col', () => {
    const src = ['osc:', '  - { table: basic/saw }', 'filter: { cutoff: 800 }'].join('\n');
    const r = parseSynth(src, {}, { bodyStartLine: 10, bpm: 120 });
    expect(r.ir).toBeNull();
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.line).toBe(12); // bodyStartLine 10 + 2 lines
    expect(r.errors[0]!.col).toBe(19);
    expect(r.errors[0]!.message).toMatch(/bare numbers are not allowed/);
  });

  it('allows bare 0-1 numbers on the whitelisted fields', () => {
    const r = parseSynth('filter: { res: 0.3, drive: 0.2, key_track: 0.5 }', {}, { bpm: 120 });
    expect(r.errors).toEqual([]);
    const p = r.params!;
    expect(p[P_FILTER_RES]).toBeCloseTo(0.3, 6);
    expect(p[P_FILTER_KEYTRACK]).toBeCloseTo(0.5, 6);
  });

  it('rejects the wrong unit for a field', () => {
    const r = parseSynth('filter: { cutoff: 5ms }', {}, { bpm: 120 });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.message).toMatch(/frequency/);
  });

  it('reports unknown keys', () => {
    const r = parseSynth('filtre: { cutoff: 800Hz }', {}, { bodyStartLine: 3, bpm: 120 });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!).toMatchObject({ line: 3, col: 1 });
    expect(r.errors[0]!.message).toMatch(/unknown patch key "filtre"/);
  });

  it('reports unknown enum values', () => {
    const bad = parseSynth('filter: { type: lp99 }', {}, { bpm: 120 });
    expect(bad.errors[0]!.message).toMatch(/unknown filter type/);

    const badTable = parseSynth('osc:\n  - { table: basic/nope }', {}, { bpm: 120 });
    expect(badTable.errors[0]!.message).toMatch(/unknown table/);

    const badWave = parseSynth('lfo:\n  1: { wave: ramp }', {}, { bpm: 120 });
    expect(badWave.errors[0]!.message).toMatch(/unknown lfo wave/);
  });

  it('reports unknown mod sources and destinations', () => {
    const r = parseSynth('mod:\n  - { from: env.pitch, to: filter.cutoff, amount: 100c }', {}, { bpm: 120 });
    expect(r.errors[0]!.message).toMatch(/unknown mod source/);

    const r2 = parseSynth('mod:\n  - { from: lfo.1, to: reverb, amount: 10% }', {}, { bpm: 120 });
    expect(r2.errors[0]!.message).toMatch(/unknown mod destination/);
  });

  it('requires cents for cutoff/pitch mod amounts', () => {
    const r = parseSynth('mod:\n  - { from: env.filter, to: filter.cutoff, amount: 50% }', {}, { bpm: 120 });
    expect(r.errors[0]!.message).toMatch(/cents/);
  });

  it('rejects more than 2 oscillators and more than 8 mod slots', () => {
    const osc = ['osc:', '  - { table: basic/saw }', '  - { table: basic/saw }', '  - { table: basic/saw }'].join('\n');
    expect(parseSynth(osc, {}, { bpm: 120 }).errors[0]!.message).toMatch(/at most 2 oscillators/);

    const mods = ['mod:']
      .concat(new Array(9).fill('  - { from: lfo.1, to: amp, amount: 10% }'))
      .join('\n');
    expect(parseSynth(mods, {}, { bpm: 120 }).errors[0]!.message).toMatch(/at most 8 mod slots/);
  });

  it('clamps continuous values instead of erroring', () => {
    const r = parseSynth('filter: { cutoff: 40kHz, res: 250% }', {}, { bpm: 120 });
    expect(r.errors).toEqual([]);
    expect(r.params![P_FILTER_CUTOFF_HZ]).toBe(20000);
    expect(r.params![P_FILTER_RES]).toBe(1);
  });

  it('clamps unison and polyphony to the engine limits', () => {
    const r = parseSynth('osc:\n  - { unison: 12 }\nvoice: { polyphony: 64 }', {}, { bpm: 120 });
    expect(r.errors).toEqual([]);
    expect(r.params![OSC_A_BASE + OSC_UNISON]).toBe(7);
    expect(r.params![P_POLYPHONY]).toBe(16);
  });

  it('rejects a malformed seed attribute', () => {
    const r = parseSynth('', { seed: 'abc' }, { bodyStartLine: 5, bpm: 120 });
    expect(r.errors[0]!).toMatchObject({ line: 4, col: 1 });
    expect(r.errors[0]!.message).toMatch(/seed/);
  });
});
