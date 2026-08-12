// Declarative field schema: expanded IR → editable controls.
//
// Each field knows where it lives in the text (`path`), how to present it, and
// what unit family its written token uses. The panel is generated from this,
// so adding a control never means touching the DOM code.

import type { PatchIR } from '../dsl/ir.ts';
import { FILTER_MODES, LFO_WAVES } from '../dsl/ir.ts';
import { DIST_MODES, NOISE_COLORS, FX_KEYS, type FxIR } from '../dsl/fx.ts';
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

function fxFields(entry: FxIR, i: number): FieldSpec[] {
  const at = (key: string) => [String('fx'), String(i), key];
  switch (entry.type) {
    case 'dist': {
      const v = entry.params;
      return [
        ratio(at('drive'), 'drive', v.drive),
        ratio(at('mix'), 'mix', v.mix),
        enumField(at('mode'), 'mode', v.mode, Object.keys(DIST_MODES)),
        hz(at('tone'), 'tone', v.toneHz),
      ];
    }
    case 'eq': {
      const v = entry.params;
      return [
        db(at('low'), 'low', v.lowDb, -24, 24),
        db(at('mid'), 'mid', v.midDb, -24, 24),
        db(at('high'), 'high', v.highDb, -24, 24),
        hz(at('mid_freq'), 'mid freq', v.midFreqHz),
      ];
    }
    case 'chorus': {
      const v = entry.params;
      return [hz(at('rate'), 'rate', v.rateHz, 0.01, 20), ratio(at('depth'), 'depth', v.depth), ratio(at('mix'), 'mix', v.mix)];
    }
    case 'phaser': {
      const v = entry.params;
      return [
        hz(at('rate'), 'rate', v.rateHz, 0.01, 20),
        ratio(at('depth'), 'depth', v.depth),
        ratio(at('feedback'), 'feedback', v.feedback),
        ratio(at('mix'), 'mix', v.mix),
        int(at('stages'), 'stages', v.stages, 2, 8, 2),
        hz(at('center'), 'center', v.centerHz),
      ];
    }
    case 'flanger': {
      const v = entry.params;
      return [
        hz(at('rate'), 'rate', v.rateHz, 0.01, 20),
        ratio(at('depth'), 'depth', v.depth),
        ratio(at('feedback'), 'feedback', v.feedback),
        ratio(at('mix'), 'mix', v.mix),
      ];
    }
    case 'delay': {
      const v = entry.params;
      return [
        secs(at('time'), 'time', v.timeS, 0.001, 2),
        ratio(at('feedback'), 'feedback', v.feedback),
        ratio(at('mix'), 'mix', v.mix),
        toggle(at('pingpong'), 'ping-pong', v.pingpong),
        hz(at('tone'), 'tone', v.toneHz),
      ];
    }
    case 'reverb': {
      const v = entry.params;
      return [
        ratio(at('size'), 'size', v.size),
        ratio(at('damp'), 'damp', v.damp),
        ratio(at('mix'), 'mix', v.mix),
        { path: at('predelay'), label: 'predelay', kind: 'lin', unit: 'sec', min: 0, max: 0.25, step: 0.001, value: v.predelayS },
        ratio(at('width'), 'width', v.width),
      ];
    }
    case 'comp': {
      const v = entry.params;
      return [
        db(at('thresh_low'), 'thresh low', v.threshLowDb, -80, 0),
        db(at('thresh_mid'), 'thresh mid', v.threshMidDb, -80, 0),
        db(at('thresh_high'), 'thresh high', v.threshHighDb, -80, 0),
        int(at('ratio'), 'ratio', v.ratio, 1, 20),
        secs(at('attack'), 'attack', v.attackS, 0.0005, 1),
        secs(at('release'), 'release', v.releaseS, 0.005, 5),
        db(at('makeup'), 'makeup', linearToDb(v.makeup), -24, 24),
      ];
    }
  }
}

/** Every key this schema can write, per effect type — used by the tests. */
export const FX_EDITABLE_KEYS = FX_KEYS;
