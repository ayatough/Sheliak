import { describe, it, expect } from 'vitest';
import { parseSynth } from './synth.ts';
import { compile } from './compile.ts';
import { expandedView } from './ir.ts';
import { DEFAULT_DOC } from '../defaultDoc.ts';
import { dbToLinear, beatsToSeconds } from './units.ts';
import {
  NOISE_BASE,
  NOISE_ENABLED,
  NOISE_LEVEL,
  NOISE_COLOR,
  FX_ORDER_BASE,
  FX_SLOTS,
  FX_NONE,
  FX_DIST,
  FX_EQ,
  FX_CHORUS,
  FX_PHASER,
  FX_FLANGER,
  FX_DELAY,
  FX_REVERB,
  FX_MBCOMP,
  FX_SLOT_BASE,
  FX_SLOT_STRIDE,
  DIST_DRIVE,
  DIST_MIX,
  DIST_MODE,
  DIST_TONE_HZ,
  EQ_LOW_DB,
  EQ_MID_DB,
  EQ_HIGH_DB,
  EQ_MID_FREQ_HZ,
  CHORUS_RATE_HZ,
  CHORUS_DEPTH,
  CHORUS_MIX,
  PHASER_RATE_HZ,
  PHASER_DEPTH,
  PHASER_FEEDBACK,
  PHASER_MIX,
  PHASER_STAGES,
  PHASER_CENTER_HZ,
  FLANGER_RATE_HZ,
  FLANGER_DEPTH,
  FLANGER_FEEDBACK,
  FLANGER_MIX,
  DELAY_TIME_S,
  DELAY_FEEDBACK,
  DELAY_MIX,
  DELAY_PINGPONG,
  DELAY_TONE_HZ,
  REVERB_SIZE,
  REVERB_DAMP,
  REVERB_MIX,
  REVERB_PREDELAY_S,
  REVERB_WIDTH,
  MBCOMP_THRESH_LOW_DB,
  MBCOMP_THRESH_MID_DB,
  MBCOMP_THRESH_HIGH_DB,
  MBCOMP_RATIO,
  MBCOMP_ATTACK_S,
  MBCOMP_RELEASE_S,
  MBCOMP_MAKEUP,
} from '../shared/params.ts';

const BPM = 124;
/**
 * The block belonging to an effect, found the way the engine finds it: by
 * looking up which chain slot the type landed in. Blocks are addressed by
 * position now, so "the reverb's parameters" depends on where the reverb is.
 */
const base = (p: Float32Array, typeId: number): number => {
  for (let i = 0; i < FX_SLOTS; i++) {
    if (p[FX_ORDER_BASE + i] === typeId) return FX_SLOT_BASE + i * FX_SLOT_STRIDE;
  }
  throw new Error(`type id ${typeId} is not in the chain`);
};

function parse(body: string, bpm = BPM) {
  return parseSynth(body, {}, { bodyStartLine: 1, bpm });
}

// --------------------------------------------------------------------- noise

describe('noise section', () => {
  it('is disabled when absent', () => {
    const r = parse('filter: { cutoff: 800Hz }');
    expect(r.errors).toEqual([]);
    expect(r.params![NOISE_BASE + NOISE_ENABLED]).toBe(0);
    expect(r.ir!.noise.enabled).toBe(false);
  });

  it('is enabled by the section existing, with SPEC defaults', () => {
    const r = parse('noise: {}');
    expect(r.errors).toEqual([]);
    expect(r.params![NOISE_BASE + NOISE_ENABLED]).toBe(1);
    expect(r.params![NOISE_BASE + NOISE_LEVEL]).toBeCloseTo(dbToLinear(-12), 6);
    expect(r.params![NOISE_BASE + NOISE_COLOR]).toBe(0); // white
  });

  it('reads level (dB → linear) and color', () => {
    const r = parse('noise: { level: -18dB, color: pink }');
    expect(r.errors).toEqual([]);
    expect(r.params![NOISE_BASE + NOISE_LEVEL]).toBeCloseTo(dbToLinear(-18), 6);
    expect(r.params![NOISE_BASE + NOISE_COLOR]).toBe(1); // pink
  });

  it('rejects an unknown color and a bare level', () => {
    expect(parse('noise: { color: brown }').errors[0]!.message).toMatch(/unknown noise color/);
    const bare = parse('noise: { level: 0.5 }');
    expect(bare.errors[0]!.message).toMatch(/bare numbers are not allowed/);
  });

  it('rejects unknown noise keys', () => {
    const r = parse('noise: { levl: -12dB }');
    expect(r.errors[0]!.message).toMatch(/unknown noise key "levl"/);
  });
});

// ------------------------------------------------------------------ fx chain

describe('fx chain — order and type ids', () => {
  it('writes the chain in DSL order into the FX_ORDER slots', () => {
    const r = parse(
      ['fx:', '  - { type: dist }', '  - { type: delay }', '  - { type: reverb }', '  - { type: comp }'].join('\n'),
    );
    expect(r.errors).toEqual([]);
    const p = r.params!;
    expect(p[FX_ORDER_BASE + 0]).toBe(FX_DIST);
    expect(p[FX_ORDER_BASE + 1]).toBe(FX_DELAY);
    expect(p[FX_ORDER_BASE + 2]).toBe(FX_REVERB);
    expect(p[FX_ORDER_BASE + 3]).toBe(FX_MBCOMP);
    for (let i = 4; i < FX_SLOTS; i++) expect(p[FX_ORDER_BASE + i]).toBe(FX_NONE);
  });

  it('reorders when the DSL order changes', () => {
    const r = parse(['fx:', '  - { type: reverb }', '  - { type: dist }'].join('\n'));
    expect(r.params![FX_ORDER_BASE + 0]).toBe(FX_REVERB);
    expect(r.params![FX_ORDER_BASE + 1]).toBe(FX_DIST);
  });

  it('accepts the type aliases', () => {
    const r = parse(['fx:', '  - { type: distortion }', '  - { type: mbcomp }'].join('\n'));
    expect(r.errors).toEqual([]);
    expect(r.params![FX_ORDER_BASE + 0]).toBe(FX_DIST);
    expect(r.params![FX_ORDER_BASE + 1]).toBe(FX_MBCOMP);
    expect(r.ir!.fx.map((f) => f.type)).toEqual(['dist', 'comp']);
  });

  it('leaves the whole block empty when there is no fx section', () => {
    const p = parse('filter: { cutoff: 800Hz }').params!;
    for (let i = 0; i < FX_SLOTS; i++) expect(p[FX_ORDER_BASE + i]).toBe(FX_NONE);
    for (let i = 0; i < FX_SLOTS * FX_SLOT_STRIDE; i++) expect(p[FX_SLOT_BASE + i]).toBe(0);
  });
});

describe('fx chain — per-effect parameters', () => {
  it('dist', () => {
    const r = parse('fx:\n  - { type: dist, drive: 0.4, mix: 60%, mode: fold, tone: 8kHz }');
    expect(r.errors).toEqual([]);
    const b = base(r.params!, FX_DIST);
    const p = r.params!;
    expect(p[b + DIST_DRIVE]).toBeCloseTo(0.4, 6);
    expect(p[b + DIST_MIX]).toBeCloseTo(0.6, 6);
    expect(p[b + DIST_MODE]).toBe(1); // fold
    expect(p[b + DIST_TONE_HZ]).toBe(8000);
  });

  it('eq keeps gains in dB and converts kHz', () => {
    const r = parse('fx:\n  - { type: eq, low: +2dB, mid: -1dB, high: +3dB, mid_freq: 1.2kHz }');
    expect(r.errors).toEqual([]);
    const b = base(r.params!, FX_EQ);
    const p = r.params!;
    expect(p[b + EQ_LOW_DB]).toBe(2);
    expect(p[b + EQ_MID_DB]).toBe(-1);
    expect(p[b + EQ_HIGH_DB]).toBe(3);
    expect(p[b + EQ_MID_FREQ_HZ]).toBe(1200);
  });

  it('chorus', () => {
    const r = parse('fx:\n  - { type: chorus, rate: 0.8Hz, depth: 30%, mix: 35% }');
    expect(r.errors).toEqual([]);
    const b = base(r.params!, FX_CHORUS);
    const p = r.params!;
    expect(p[b + CHORUS_RATE_HZ]).toBeCloseTo(0.8, 6);
    expect(p[b + CHORUS_DEPTH]).toBeCloseTo(0.3, 6);
    expect(p[b + CHORUS_MIX]).toBeCloseTo(0.35, 6);
  });

  it('phaser', () => {
    const r = parse('fx:\n  - { type: phaser, rate: 0.4Hz, depth: 70%, feedback: 30%, mix: 40%, stages: 6, center: 800Hz }');
    expect(r.errors).toEqual([]);
    const b = base(r.params!, FX_PHASER);
    const p = r.params!;
    expect(p[b + PHASER_RATE_HZ]).toBeCloseTo(0.4, 6);
    expect(p[b + PHASER_DEPTH]).toBeCloseTo(0.7, 6);
    expect(p[b + PHASER_FEEDBACK]).toBeCloseTo(0.3, 6);
    expect(p[b + PHASER_MIX]).toBeCloseTo(0.4, 6);
    expect(p[b + PHASER_STAGES]).toBe(6);
    expect(p[b + PHASER_CENTER_HZ]).toBe(800);
  });

  it('flanger', () => {
    const r = parse('fx:\n  - { type: flanger, rate: 0.25Hz, depth: 60%, feedback: 50%, mix: 35% }');
    expect(r.errors).toEqual([]);
    const b = base(r.params!, FX_FLANGER);
    const p = r.params!;
    expect(p[b + FLANGER_RATE_HZ]).toBeCloseTo(0.25, 6);
    expect(p[b + FLANGER_DEPTH]).toBeCloseTo(0.6, 6);
    expect(p[b + FLANGER_FEEDBACK]).toBeCloseTo(0.5, 6);
    expect(p[b + FLANGER_MIX]).toBeCloseTo(0.35, 6);
  });

  it('delay converts musical time with the loop bpm', () => {
    const r = parse('fx:\n  - { type: delay, time: 3/16, feedback: 45%, mix: 25%, pingpong: on, tone: 4kHz }');
    expect(r.errors).toEqual([]);
    const b = base(r.params!, FX_DELAY);
    const p = r.params!;
    // 3/16 = 0.75 beat; at 124bpm that is 0.75 * 60/124 s.
    expect(p[b + DELAY_TIME_S]).toBeCloseTo(beatsToSeconds(0.75, BPM), 6);
    expect(p[b + DELAY_TIME_S]).toBeCloseTo(0.3629032, 6);
    expect(p[b + DELAY_FEEDBACK]).toBeCloseTo(0.45, 6);
    expect(p[b + DELAY_MIX]).toBeCloseTo(0.25, 6);
    expect(p[b + DELAY_PINGPONG]).toBe(1);
    expect(p[b + DELAY_TONE_HZ]).toBe(4000);
  });

  it('delay also accepts absolute time and off for pingpong', () => {
    const r = parse('fx:\n  - { type: delay, time: 375ms, pingpong: off }');
    expect(r.errors).toEqual([]);
    const b = base(r.params!, FX_DELAY);
    expect(r.params![b + DELAY_TIME_S]).toBeCloseTo(0.375, 6);
    expect(r.params![b + DELAY_PINGPONG]).toBe(0);
  });

  it('reverb', () => {
    const r = parse('fx:\n  - { type: reverb, size: 70%, damp: 50%, mix: 20%, predelay: 20ms, width: 100% }');
    expect(r.errors).toEqual([]);
    const b = base(r.params!, FX_REVERB);
    const p = r.params!;
    expect(p[b + REVERB_SIZE]).toBeCloseTo(0.7, 6);
    expect(p[b + REVERB_DAMP]).toBeCloseTo(0.5, 6);
    expect(p[b + REVERB_MIX]).toBeCloseTo(0.2, 6);
    expect(p[b + REVERB_PREDELAY_S]).toBeCloseTo(0.02, 6);
    expect(p[b + REVERB_WIDTH]).toBe(1);
  });

  it('comp keeps thresholds in dB but converts makeup to linear', () => {
    const r = parse(
      'fx:\n  - { type: comp, thresh_low: -24dB, thresh_mid: -24dB, thresh_high: -24dB, ratio: 3, attack: 10ms, release: 120ms, makeup: 2dB }',
    );
    expect(r.errors).toEqual([]);
    const b = base(r.params!, FX_MBCOMP);
    const p = r.params!;
    expect(p[b + MBCOMP_THRESH_LOW_DB]).toBe(-24);
    expect(p[b + MBCOMP_THRESH_MID_DB]).toBe(-24);
    expect(p[b + MBCOMP_THRESH_HIGH_DB]).toBe(-24);
    expect(p[b + MBCOMP_RATIO]).toBe(3);
    expect(p[b + MBCOMP_ATTACK_S]).toBeCloseTo(0.01, 6);
    expect(p[b + MBCOMP_RELEASE_S]).toBeCloseTo(0.12, 6);
    expect(p[b + MBCOMP_MAKEUP]).toBeCloseTo(dbToLinear(2), 6);
  });

  it('accepts a musical rate for chorus/phaser/flanger', () => {
    const r = parse('fx:\n  - { type: chorus, rate: 1/4 }');
    expect(r.errors).toEqual([]);
    expect(r.params![base(r.params!, FX_CHORUS) + CHORUS_RATE_HZ]).toBeCloseTo(BPM / 60, 5);
  });
});

describe('fx chain — defaults (docs/syntax.md)', () => {
  it('fills every default for a bare entry', () => {
    const r = parse(
      [
        'fx:',
        '  - { type: dist }',
        '  - { type: eq }',
        '  - { type: chorus }',
        '  - { type: phaser }',
        '  - { type: flanger }',
        '  - { type: delay }',
        '  - { type: reverb }',
        '  - { type: comp }',
      ].join('\n'),
    );
    expect(r.errors).toEqual([]);
    const p = r.params!;

    let b = base(r.params!, FX_DIST);
    expect(p[b + DIST_DRIVE]).toBeCloseTo(0.3, 6);
    expect(p[b + DIST_MIX]).toBe(1);
    expect(p[b + DIST_MODE]).toBe(0); // tanh
    expect(p[b + DIST_TONE_HZ]).toBe(20000);

    b = base(r.params!, FX_EQ);
    expect(p[b + EQ_LOW_DB]).toBe(0);
    expect(p[b + EQ_MID_FREQ_HZ]).toBe(1000);

    b = base(r.params!, FX_CHORUS);
    expect(p[b + CHORUS_RATE_HZ]).toBeCloseTo(0.8, 6);
    expect(p[b + CHORUS_DEPTH]).toBeCloseTo(0.3, 6);
    expect(p[b + CHORUS_MIX]).toBeCloseTo(0.35, 6);

    b = base(r.params!, FX_PHASER);
    expect(p[b + PHASER_STAGES]).toBe(6);
    expect(p[b + PHASER_CENTER_HZ]).toBe(800);
    expect(p[b + PHASER_FEEDBACK]).toBeCloseTo(0.3, 6);

    b = base(r.params!, FX_FLANGER);
    expect(p[b + FLANGER_RATE_HZ]).toBeCloseTo(0.25, 6);
    expect(p[b + FLANGER_DEPTH]).toBeCloseTo(0.6, 6);

    b = base(r.params!, FX_DELAY);
    // Default is the musical 3/16, so it tracks the tempo.
    expect(p[b + DELAY_TIME_S]).toBeCloseTo(beatsToSeconds(0.75, BPM), 6);
    expect(p[b + DELAY_FEEDBACK]).toBeCloseTo(0.4, 6);
    expect(p[b + DELAY_PINGPONG]).toBe(1);
    expect(p[b + DELAY_TONE_HZ]).toBe(4000);

    b = base(r.params!, FX_REVERB);
    expect(p[b + REVERB_SIZE]).toBeCloseTo(0.6, 6);
    expect(p[b + REVERB_PREDELAY_S]).toBeCloseTo(0.02, 6);
    expect(p[b + REVERB_WIDTH]).toBe(1);

    b = base(r.params!, FX_MBCOMP);
    expect(p[b + MBCOMP_THRESH_MID_DB]).toBe(-24);
    expect(p[b + MBCOMP_RATIO]).toBe(3);
    expect(p[b + MBCOMP_MAKEUP]).toBe(1); // 0dB
  });

  it('the default delay time follows the document bpm', () => {
    const slow = parse('fx:\n  - { type: delay }', 60);
    expect(slow.params![base(slow.params!, FX_DELAY) + DELAY_TIME_S]).toBeCloseTo(0.75, 6);
  });
});

describe('fx chain — errors', () => {
  it('rejects a duplicate effect type with a position', () => {
    const r = parseSynth(
      ['fx:', '  - { type: delay, mix: 20% }', '  - { type: delay, mix: 40% }'].join('\n'),
      {},
      { bodyStartLine: 10, bpm: BPM },
    );
    expect(r.ir).toBeNull();
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.line).toBe(12);
    expect(r.errors[0]!.message).toMatch(/appears more than once/);
  });

  it('tells someone who named a plugin what is actually wrong', () => {
    // Listing the eight built-ins would be no answer at all here: they were not
    // looking for `reverb`. The separator is reserved before anything uses it,
    // so that a built-in added later can never collide with a plugin id.
    const r = parseSynth('fx:\n  - { type: plugin:com.example.tape }', {}, { bodyStartLine: 1, bpm: BPM });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.message).toMatch(/does not host plugins yet/);
    expect(r.errors[0]!.message).not.toMatch(/expected one of/);
  });

  it('rejects an unknown effect type', () => {
    const r = parse('fx:\n  - { type: bitcrush }');
    expect(r.errors[0]!.message).toMatch(/unknown effect type "bitcrush"/);
  });

  it('rejects an entry with no type', () => {
    const r = parse('fx:\n  - { mix: 20% }');
    expect(r.errors[0]!.message).toMatch(/needs a type/);
  });

  it('rejects unknown per-effect keys', () => {
    const r = parse('fx:\n  - { type: reverb, decay: 2s }');
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.message).toMatch(/unknown fx.reverb key "decay"/);
  });

  it('rejects a key that belongs to another effect', () => {
    const r = parse('fx:\n  - { type: chorus, feedback: 30% }');
    expect(r.errors[0]!.message).toMatch(/unknown fx.chorus key "feedback"/);
  });

  it('validates phaser stages (even, 2..8)', () => {
    expect(parse('fx:\n  - { type: phaser, stages: 5 }').errors[0]!.message).toMatch(/even number between 2 and 8/);
    expect(parse('fx:\n  - { type: phaser, stages: 10 }').errors[0]!.message).toMatch(/even number between 2 and 8/);
    expect(parse('fx:\n  - { type: phaser, stages: 2 }').errors).toEqual([]);
    expect(parse('fx:\n  - { type: phaser, stages: 8 }').errors).toEqual([]);
  });

  it('validates compressor ratio >= 1', () => {
    expect(parse('fx:\n  - { type: comp, ratio: 0.5 }').errors[0]!.message).toMatch(/ratio must be >= 1/);
    expect(parse('fx:\n  - { type: comp, ratio: 4 }').errors).toEqual([]);
  });

  it('requires dB for eq gains and compressor thresholds', () => {
    expect(parse('fx:\n  - { type: eq, low: 2 }').errors[0]!.message).toMatch(/bare numbers are not allowed/);
    expect(parse('fx:\n  - { type: comp, thresh_low: -24 }').errors[0]!.message).toMatch(/bare numbers are not allowed/);
  });

  it('rejects more than 8 effects', () => {
    const many = ['fx:'].concat(new Array(9).fill('  - { type: reverb }')).join('\n');
    expect(parse(many).errors[0]!.message).toMatch(/at most 8 effects/);
  });

  it('rejects an unknown dist mode', () => {
    expect(parse('fx:\n  - { type: dist, mode: crunch }').errors[0]!.message).toMatch(/unknown dist mode/);
  });

  it('clamps continuous fx values instead of erroring', () => {
    const r = parse('fx:\n  - { type: delay, time: 8s, feedback: 150% }\n  - { type: reverb, predelay: 900ms }');
    expect(r.errors).toEqual([]);
    expect(r.params![base(r.params!, FX_DELAY) + DELAY_TIME_S]).toBe(2);
    expect(r.params![base(r.params!, FX_DELAY) + DELAY_FEEDBACK]).toBe(1);
    expect(r.params![base(r.params!, FX_REVERB) + REVERB_PREDELAY_S]).toBeCloseTo(0.25, 6);
  });
});

// --------------------------------------------------------------- expanded view

// A stable document for view assertions: the showcase default doc is covered
// by tracks.test.ts and is free to change.
const FX_DOC = [
  '```synth id=pad',
  'noise: { level: -18dB, color: white }',
  'fx:',
  '  - { type: dist,   drive: 0.25, mix: 40% }',
  '  - { type: eq,     low: +2dB }',
  '  - { type: delay,  time: 3/16, mix: 25% }',
  '  - { type: reverb, size: 70%, mix: 18% }',
  '  - { type: comp,   ratio: 3 }',
  '```',
  '',
  '```phrase id=hold res=1/4 bars=1',
  'grid:',
  '  C3 |o...|',
  '```',
  '',
  '```loop id=demo bars=1 bpm=124',
  'pad: hold',
  '```',
].join('\n');

describe('expandedView with v0.2 sections', () => {
  it('shows noise and the fx chain in processing order', () => {
    const r = compile(FX_DOC, 48000);
    expect(r.errors).toEqual([]);
    const view = r.patch!.expanded as {
      noise: { enabled: boolean; color: string; level: string };
      fx: { slot: number; type: string }[];
    };

    expect(view.noise.enabled).toBe(true);
    expect(view.noise.color).toMatch(/^white/);
    expect(view.noise.level).toMatch(/-18dB/);

    expect(view.fx.map((f) => f.type.split(' ')[0])).toEqual(['dist', 'eq', 'delay', 'reverb', 'comp']);
    expect(view.fx.map((f) => f.slot)).toEqual([1, 2, 3, 4, 5]);
    expect(JSON.stringify(view)).toContain('pingpong');
  });

  it('annotates units per effect', () => {
    const r = parse('fx:\n  - { type: delay, time: 3/16, mix: 25% }');
    const json = JSON.stringify(expandedViewOf(r), null, 2);
    // Musical time resolved to an absolute value, ratios shown as percentages.
    expect(json).toMatch(/"time": "362\.903ms"/);
    expect(json).toContain('"mix": "25%"');
    expect(json).toContain('"pingpong": true');
    expect(json).toContain('delay (id 6)');
  });

  it('keeps the fx chain and noise per track', () => {
    const r = compile(DEFAULT_DOC, 48000);
    expect(r.errors).toEqual([]);
    const lead = r.tracks.find((t) => t.id === 'lead')!;
    const hat = r.tracks.find((t) => t.id === 'hat')!;
    const leadView = lead.expanded as { fx: { type: string }[]; noise: { enabled: boolean } };
    const hatView = hat.expanded as { fx: unknown[]; noise: { enabled: boolean; level: string } };

    expect(leadView.fx.map((f) => f.type.split(' ')[0])).toEqual(['reverb', 'comp']);
    expect(leadView.noise.enabled).toBe(false);
    expect(hatView.fx).toEqual([]);
    expect(hatView.noise.enabled).toBe(true);
    expect(hatView.noise.level).toMatch(/-6dB/);
  });
});

function expandedViewOf(r: { ir: { fx: unknown } | null }): unknown {
  if (!r.ir) throw new Error('patch did not compile');
  return expandedView(r.ir as Parameters<typeof expandedView>[0]);
}

describe('the fx showcase document', () => {
  it('compiles clean with the delay tracking the tempo', () => {
    const r = compile(FX_DOC, 48000);
    expect(r.errors).toEqual([]);
    const delay = r.patch!.ir.fx.find((f) => f.type === 'delay');
    if (delay?.type !== 'delay') throw new Error('expected delay');
    expect(delay.params.timeS).toBeCloseTo(beatsToSeconds(0.75, 124), 9);
  });
});
