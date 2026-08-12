import { describe, it, expect } from 'vitest';
import { buildPanel, type FieldSpec } from './schema.ts';
import { toSlider, fromSlider, writeField, fieldStatus, displayValue } from './panel.ts';
import { compile } from '../dsl/compile.ts';
import { DEFAULT_DOC } from '../defaultDoc.ts';
import { PARAM_COUNT, P_FILTER_CUTOFF_HZ, OSC_A_BASE, OSC_LEVEL, ENV_AMP_BASE, ENV_D } from '../shared/params.ts';

const SR = 48000;

const base = compile(DEFAULT_DOC, SR);
const lead = base.tracks.find((t) => t.id === 'lead')!;
const hat = base.tracks.find((t) => t.id === 'hat')!;

function field(sections: ReturnType<typeof buildPanel>, sectionId: string, label: string): FieldSpec {
  const section = sections.find((s) => s.id === sectionId);
  if (!section) throw new Error(`no section ${sectionId}`);
  const f = section.fields.find((x) => x.label === label);
  if (!f) throw new Error(`no field ${sectionId}.${label}`);
  return f;
}

/** Indices where two param blocks differ. */
function diffSlots(a: Float32Array, b: Float32Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < PARAM_COUNT; i++) if (a[i] !== b[i]) out.push(i);
  return out;
}

describe('schema generation', () => {
  const sections = buildPanel(lead.ir);

  it('covers the sections present in the patch', () => {
    expect(sections.map((s) => s.id)).toEqual([
      'osc0',
      'osc1',
      'filter',
      'env-amp',
      'env-filter',
      'lfo',
      'mod',
      'fx0',
      'fx1',
      'voice',
    ]);
  });

  it('reads current values out of the expanded IR, in unit space', () => {
    expect(field(sections, 'filter', 'cutoff').value).toBe(900);
    expect(field(sections, 'osc0', 'level').value).toBeCloseTo(-3, 4); // linear → dB
    expect(field(sections, 'osc0', 'unison').value).toBe(5);
    expect(field(sections, 'osc0', 'detune').value).toBe(18);
    expect(field(sections, 'osc1', 'tune').value).toBe(-12);
    expect(field(sections, 'env-amp', 'decay').value).toBeCloseTo(0.22, 6);
    expect(field(sections, 'lfo', 'rate').value).toBeCloseTo(126 / 60, 6);
    expect(field(sections, 'voice', 'polyphony').value).toBe(6);
  });

  it('exposes mod amounts with the destination’s unit', () => {
    const amount = field(sections, 'mod', 'env.filter → filter.cutoff');
    expect(amount.unit).toBe('cent');
    expect(amount.value).toBe(2600);
    expect(field(sections, 'mod', 'lfo.1 → osc.1.morph').unit).toBe('ratio');
  });

  it('generates fx controls per effect type, in chain order', () => {
    expect(sections.find((s) => s.id === 'fx0')!.label).toBe('FX 1 · reverb');
    expect(sections.find((s) => s.id === 'fx1')!.label).toBe('FX 2 · comp');
    expect(field(sections, 'fx0', 'size').value).toBeCloseTo(0.65, 6);
    expect(field(sections, 'fx1', 'ratio').value).toBe(3);
    expect(field(sections, 'fx0', 'size').path).toEqual(['fx', '0', 'size']);
  });

  it('shows noise only when the track has it, and skips disabled oscillators', () => {
    const hatSections = buildPanel(hat.ir);
    expect(hatSections.map((s) => s.id)).toContain('noise');
    expect(hatSections.map((s) => s.id)).not.toContain('osc0');
    expect(buildPanel(lead.ir).map((s) => s.id)).not.toContain('noise');
    expect(field(hatSections, 'noise', 'color').options).toEqual(['white', 'pink']);
  });

  it('offers enum options from the registries', () => {
    expect(field(sections, 'filter', 'type').options).toEqual(['lp12', 'lp24', 'hp12', 'bp12']);
    expect(field(sections, 'osc0', 'table').options).toContain('morph/pwm');
  });
});

describe('slider mapping', () => {
  const sections = buildPanel(lead.ir);

  it('maps log fields geometrically', () => {
    const cutoff = field(sections, 'filter', 'cutoff');
    expect(toSlider(cutoff, 20)).toBeCloseTo(0, 6);
    expect(toSlider(cutoff, 20000)).toBeCloseTo(1, 6);
    // The midpoint of a 20Hz..20kHz log slider is the geometric mean, ~632Hz.
    expect(fromSlider(cutoff, 0.5)).toBeCloseTo(Math.sqrt(20 * 20000), 3);
  });

  it('round-trips values through the slider', () => {
    for (const f of [field(sections, 'filter', 'cutoff'), field(sections, 'env-amp', 'attack')]) {
      for (const v of [f.min as number, 0.37, 1, f.max as number]) {
        const clamped = Math.min(Math.max(v, f.min as number), f.max as number);
        expect(fromSlider(f, toSlider(f, clamped))).toBeCloseTo(clamped, 5);
      }
    }
  });

  it('quantises integer fields', () => {
    const unison = field(sections, 'osc0', 'unison');
    expect(fromSlider(unison, 0)).toBe(1);
    expect(fromSlider(unison, 1)).toBe(7);
    expect(Number.isInteger(fromSlider(unison, 0.42))).toBe(true);
  });

  it('displays values the way they will be written', () => {
    expect(displayValue(field(sections, 'filter', 'cutoff'), 1200)).toBe('1.2kHz');
    expect(displayValue(field(sections, 'env-amp', 'attack'), 0.008)).toBe('8ms');
    expect(displayValue(field(sections, 'osc0', 'level'), -3)).toBe('-3dB');
  });
});

describe('writeback', () => {
  const sections = buildPanel(lead.ir);

  it('a cutoff edit changes exactly one param slot', () => {
    const spec = field(sections, 'filter', 'cutoff');
    const r = writeField(DEFAULT_DOC, 0, spec, 1200);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const after = compile(r.doc, SR);
    expect(after.errors).toEqual([]);
    expect(after.tracks).toHaveLength(4);

    const changed = diffSlots(lead.params, after.tracks[0]!.params);
    expect(changed).toEqual([P_FILTER_CUTOFF_HZ]);
    expect(after.tracks[0]!.params[P_FILTER_CUTOFF_HZ]).toBe(1200);

    // Other tracks are untouched.
    for (let t = 1; t < 4; t++) {
      expect(diffSlots(base.tracks[t]!.params, after.tracks[t]!.params)).toEqual([]);
    }
    // And the loop is unaffected.
    expect(after.loop!.events).toEqual(base.loop!.events);
  });

  it('a level edit only moves that oscillator’s gain', () => {
    const spec = field(sections, 'osc0', 'level');
    const r = writeField(DEFAULT_DOC, 0, spec, -6);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const after = compile(r.doc, SR);
    expect(diffSlots(lead.params, after.tracks[0]!.params)).toEqual([OSC_A_BASE + OSC_LEVEL]);
  });

  it('an envelope edit writes into the nested block map', () => {
    const spec = field(sections, 'env-amp', 'decay');
    const r = writeField(DEFAULT_DOC, 0, spec, 0.35);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const after = compile(r.doc, SR);
    expect(diffSlots(lead.params, after.tracks[0]!.params)).toEqual([ENV_AMP_BASE + ENV_D]);
    expect(r.doc).toContain('d: 350ms');
  });

  it('edits a specific track without disturbing the others', () => {
    const hatSections = buildPanel(hat.ir);
    const spec = field(hatSections, 'noise', 'level');
    const r = writeField(DEFAULT_DOC, 3, spec, -9);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const after = compile(r.doc, SR);
    expect(diffSlots(base.tracks[0]!.params, after.tracks[0]!.params)).toEqual([]);
    expect(diffSlots(hat.params, after.tracks[3]!.params)).toHaveLength(1);
  });

  it('enum and toggle fields write their names', () => {
    const spec = field(sections, 'filter', 'type');
    const r = writeField(DEFAULT_DOC, 0, spec, 'lp24');
    expect(r.ok && r.doc).toContain('type: lp24');
  });
});

describe('field status', () => {
  const sections = buildPanel(lead.ir);

  it('reports the token currently in the text', () => {
    expect(fieldStatus(DEFAULT_DOC, 0, field(sections, 'filter', 'cutoff'))).toMatchObject({
      text: '900Hz',
      musical: false,
      editable: true,
    });
  });

  it('flags musical-time tokens, which scrubbing will convert', () => {
    const rate = fieldStatus(DEFAULT_DOC, 0, field(sections, 'lfo', 'rate'));
    expect(rate.text).toBe('1/4');
    expect(rate.musical).toBe(true);
    expect(rate.editable).toBe(true);

    // Scrubbing rewrites it in Hz and the value survives a round trip.
    const r = writeField(DEFAULT_DOC, 0, field(sections, 'lfo', 'rate'), 3);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc).toContain('rate: 3Hz');
    expect(compile(r.doc, SR).tracks[0]!.ir.lfo1.rateHz).toBe(3);
  });

  it('treats a defaulted key as editable when its map exists', () => {
    const status = fieldStatus(DEFAULT_DOC, 0, field(sections, 'lfo', 'phase'));
    expect(status.text).toBe('0%');
    const morph = fieldStatus(DEFAULT_DOC, 1, buildPanel(base.tracks[1]!.ir).find((s) => s.id === 'osc0')!.fields[2]!);
    expect(morph.text).toBeNull(); // bass has no morph written
    expect(morph.editable).toBe(true); // but the osc flow map can take it
  });

  it('disables fields whose section is missing from the text', () => {
    const kick = base.tracks.find((t) => t.id === 'kick')!;
    const status = fieldStatus(DEFAULT_DOC, 2, field(buildPanel(kick.ir), 'lfo', 'rate'));
    expect(status.editable).toBe(false);
    expect(status.reason).toMatch(/lfo/);
  });

  it('refuses to patch a syntactically broken fence', () => {
    const broken = DEFAULT_DOC.replace('cutoff: 900Hz', 'cutoff: { oops');
    expect(fieldStatus(broken, 0, field(sections, 'filter', 'res')).editable).toBe(false);
  });

  it('refuses to patch a fence that failed to compile, even if it parses', () => {
    // `cutoff: 900` is valid YAML but an invalid unit, so only the compiler
    // knows it is broken — the caller passes that verdict in.
    const broken = DEFAULT_DOC.replace('cutoff: 900Hz', 'cutoff: 900');
    const after = compile(broken, SR);
    const compiled = after.tracks.some((t) => t.track === 0);
    expect(compiled).toBe(false);

    const status = fieldStatus(broken, 0, field(sections, 'filter', 'res'), compiled);
    expect(status.editable).toBe(false);
    expect(status.reason).toMatch(/fix the errors/);
    // Tracks that did compile stay editable.
    expect(fieldStatus(broken, 2, field(sections, 'filter', 'res'), true).editable).toBe(true);
  });
});
