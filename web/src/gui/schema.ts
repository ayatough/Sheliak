// Declarative field schema: expanded IR → editable controls.
//
// Each field knows where it lives in the text (`path`), how to present it, and
// what unit family its written token uses. The panel is generated from this,
// so adding a control never means touching the DOM code.

import type { PatchIR } from '../dsl/ir.ts';
import { FILTER_MODES, LFO_WAVES } from '../dsl/ir.ts';
import { NOISE_COLORS, FX_KEYS, FX_DESCRIPTORS, type FxIR } from '../dsl/fx.ts';
import { TABLE_IDS, MAX_UNISON, MAX_VOICES } from '../shared/params.ts';
import { linearToDb } from '../dsl/units.ts';
import type { UnitFamily } from '../dsl/format.ts';

export type ControlKind = 'log' | 'lin' | 'int' | 'enum' | 'toggle';

export interface FieldSpec {
  /** Path inside the synth fence, e.g. ['osc','0','level']. */
  path: string[];
  label: string;
  kind: ControlKind;
  /** How the written token is spelled. */
  unit: UnitFamily;
  min?: number;
  max?: number;
  step?: number;
  options?: readonly string[];
  /** Current value, already in the unit family's space (dB, Hz, seconds, 0..1). */
  value: number | string | boolean;
}

export interface PanelSection {
  id: string;
  label: string;
  fields: FieldSpec[];
}

const ratio = (path: string[], label: string, value: number): FieldSpec => ({
  path,
  label,
  kind: 'lin',
  unit: 'ratio',
  min: 0,
  max: 1,
  step: 0.01,
  value,
});

const db = (path: string[], label: string, value: number, min = -60, max = 6): FieldSpec => ({
  path,
  label,
  kind: 'lin',
  unit: 'db',
  min,
  max,
  step: 0.1,
  value,
});

const hz = (path: string[], label: string, value: number, min = 20, max = 20000): FieldSpec => ({
  path,
  label,
  kind: 'log',
  unit: 'hz',
  min,
  max,
  value,
});

const secs = (path: string[], label: string, value: number, min = 0.001, max = 5): FieldSpec => ({
  path,
  label,
  kind: 'log',
  unit: 'sec',
  min,
  max,
  value,
});

const int = (path: string[], label: string, value: number, min: number, max: number, step = 1): FieldSpec => ({
  path,
  label,
  kind: 'int',
  unit: 'int',
  min,
  max,
  step,
  value,
});

const enumField = (path: string[], label: string, value: string, options: readonly string[]): FieldSpec => ({
  path,
  label,
  kind: 'enum',
  unit: 'enum',
  options,
  value,
});

const toggle = (path: string[], label: string, value: boolean): FieldSpec => ({
  path,
  label,
  kind: 'toggle',
  unit: 'bool',
  value,
});

/** Build every editable section for one track's patch. */
export function buildPanel(ir: PatchIR): PanelSection[] {
  const sections: PanelSection[] = [];

  ir.osc.forEach((osc, i) => {
    if (!osc.enabled) return;
    sections.push({
      id: `osc${i}`,
      label: `OSC ${i + 1}`,
      fields: [
        enumField(['osc', String(i), 'table'], 'table', osc.table, Object.keys(TABLE_IDS)),
        db(['osc', String(i), 'level'], 'level', linearToDb(osc.level)),
        ratio(['osc', String(i), 'morph'], 'morph', osc.morph),
        int(['osc', String(i), 'unison'], 'unison', osc.unison, 1, MAX_UNISON),
        { path: ['osc', String(i), 'detune'], label: 'detune', kind: 'lin', unit: 'cent', min: 0, max: 100, step: 1, value: osc.detuneCents },
        ratio(['osc', String(i), 'spread'], 'spread', osc.spread),
        {
          path: ['osc', String(i), 'tune'],
          label: 'tune',
          kind: 'lin',
          unit: 'semitone',
          min: -24,
          max: 24,
          step: 1,
          value: osc.tuneSemi + osc.tuneCents / 100,
        },
      ],
    });
  });

  if (ir.noise.enabled) {
    sections.push({
      id: 'noise',
      label: 'NOISE',
      fields: [
        db(['noise', 'level'], 'level', linearToDb(ir.noise.level)),
        enumField(['noise', 'color'], 'color', ir.noise.color, Object.keys(NOISE_COLORS)),
      ],
    });
  }

  sections.push({
    id: 'filter',
    label: 'FILTER',
    fields: [
      enumField(['filter', 'type'], 'type', ir.filter.type, Object.keys(FILTER_MODES)),
      hz(['filter', 'cutoff'], 'cutoff', ir.filter.cutoffHz),
      ratio(['filter', 'res'], 'res', ir.filter.res),
      ratio(['filter', 'drive'], 'drive', ir.filter.drive),
      ratio(['filter', 'key_track'], 'key track', ir.filter.keyTrack),
    ],
  });

  for (const which of ['amp', 'filter'] as const) {
    const env = ir.env[which];
    sections.push({
      id: `env-${which}`,
      label: `ENV ${which}`,
      fields: [
        secs(['env', which, 'a'], 'attack', env.a),
        secs(['env', which, 'd'], 'decay', env.d),
        ratio(['env', which, 's'], 'sustain', env.s),
        secs(['env', which, 'r'], 'release', env.r),
      ],
    });
  }

  sections.push({
    id: 'lfo',
    label: 'LFO 1',
    fields: [
      enumField(['lfo', '1', 'wave'], 'wave', ir.lfo1.wave, Object.keys(LFO_WAVES)),
      hz(['lfo', '1', 'rate'], 'rate', ir.lfo1.rateHz, 0.01, 40),
      ratio(['lfo', '1', 'phase'], 'phase', ir.lfo1.phase),
    ],
  });

  if (ir.mod.length > 0) {
    sections.push({
      id: 'mod',
      label: 'MOD',
      // Routing stays text-only; only the amounts are scrubbable.
      fields: ir.mod.map((m, i) => {
        const cents = m.to === 'filter.cutoff' || m.to === 'pitch';
        return {
          path: ['mod', String(i), 'amount'],
          label: `${m.from} → ${m.to}`,
          kind: 'lin',
          unit: cents ? 'cent' : 'ratio',
          min: cents ? -4800 : -1,
          max: cents ? 4800 : 1,
          step: cents ? 10 : 0.01,
          value: m.amount,
        } satisfies FieldSpec;
      }),
    });
  }

  ir.fx.forEach((entry, i) => {
    sections.push({
      id: `fx${i}`,
      label: `FX ${i + 1} · ${entry.type}`,
      fields: fxFields(entry, i),
    });
  });

  sections.push({
    id: 'voice',
    label: 'VOICE',
    fields: [
      int(['voice', 'polyphony'], 'polyphony', ir.voice.polyphony, 1, MAX_VOICES),
      { path: ['voice', 'glide'], label: 'glide', kind: 'lin', unit: 'sec', min: 0, max: 2, step: 0.005, value: ir.voice.glide },
    ],
  });

  return sections;
}

/**
 * The one control whose scale does not follow from its unit. Predelay spans
 * 0–250 ms, where a log slider spends most of its travel below 10 ms; every
 * other time control covers three decades and needs one.
 */
const LINEAR_SECONDS = new Set(['reverb.predelay']);

/**
 * One effect's controls, from its descriptor in `dsl/fx.ts`.
 *
 * The unit picks the control, the descriptor carries the range, and `db-linear`
 * is the one that has to convert: the block holds linear gain and the slider
 * has to show dB. Adding an effect adds no code here.
 */
function fxFields(entry: FxIR, i: number): FieldSpec[] {
  const params = entry.params as unknown as Record<string, unknown>;
  return FX_DESCRIPTORS[entry.type].params.map((desc): FieldSpec => {
    const path = ['fx', String(i), desc.key];
    const label = desc.label ?? desc.key.replace(/_/g, ' ');
    const raw = params[desc.field];
    switch (desc.unit) {
      case 'norm':
      case 'ratio':
        return ratio(path, label, raw as number);
      case 'db':
        return db(path, label, raw as number, desc.min, desc.max);
      case 'db-linear':
        return db(path, label, linearToDb(raw as number), desc.min, desc.max);
      case 'hz':
        return hz(path, label, raw as number, desc.min, desc.max);
      case 'seconds':
        return LINEAR_SECONDS.has(`${entry.type}.${desc.key}`)
          ? { path, label, kind: 'lin', unit: 'sec', min: desc.min, max: desc.max, step: desc.step, value: raw as number }
          : secs(path, label, raw as number, desc.min, desc.max);
      case 'count':
        return int(path, label, raw as number, desc.min ?? 0, desc.max ?? 1, desc.step);
      case 'bool':
        return toggle(path, label, raw as boolean);
      case 'enum':
        return enumField(path, label, String(raw), Object.keys(desc.values ?? {}));
    }
  });
}

/** Every key this schema can write, per effect type — used by the tests. */
export const FX_EDITABLE_KEYS = FX_KEYS;
