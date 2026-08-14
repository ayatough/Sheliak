// v0.2 contract extension: the per-voice noise layer and the master FX chain.
//
// Kept beside ir.ts so the patch-level IR stays readable; ir.ts re-exports the
// public pieces. Units follow web/src/shared/params.ts comments exactly:
// levels/makeup are LINEAR in the param block (converted from dB here), while
// EQ gains and compressor thresholds stay in dB.

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
import { dbToLinear, linearToDb, beatsToSeconds } from './units.ts';

// --------------------------------------------------------------------- noise

export type NoiseColor = 'white' | 'pink';

export const NOISE_COLORS: Record<string, number> = { white: 0, pink: 1 };

export interface NoiseIR {
  enabled: boolean;
  /** Linear gain (converted from dB). */
  level: number;
  color: NoiseColor;
}

/** docs/syntax.md: only active when the patch has a `noise:` section. */
export function defaultNoise(enabled = false): NoiseIR {
  return { enabled, level: dbToLinear(-12), color: 'white' };
}

// ------------------------------------------------------------------ fx types

export interface DistIR {
  drive: number;
  mix: number;
  mode: 'tanh' | 'fold' | 'clip';
  toneHz: number;
}

export interface EqIR {
  lowDb: number;
  midDb: number;
  highDb: number;
  midFreqHz: number;
}

export interface ChorusIR {
  rateHz: number;
  depth: number;
  mix: number;
}

export interface PhaserIR {
  rateHz: number;
  depth: number;
  feedback: number;
  mix: number;
  stages: number;
  centerHz: number;
}

export interface FlangerIR {
  rateHz: number;
  depth: number;
  feedback: number;
  mix: number;
}

export interface DelayIR {
  timeS: number;
  feedback: number;
  mix: number;
  pingpong: boolean;
  toneHz: number;
}

export interface ReverbIR {
  size: number;
  damp: number;
  mix: number;
  predelayS: number;
  width: number;
}

export interface CompIR {
  threshLowDb: number;
  threshMidDb: number;
  threshHighDb: number;
  ratio: number;
  attackS: number;
  releaseS: number;
  /** Linear gain (converted from dB). */
  makeup: number;
}

export interface FxParamMap {
  dist: DistIR;
  eq: EqIR;
  chorus: ChorusIR;
  phaser: PhaserIR;
  flanger: FlangerIR;
  delay: DelayIR;
  reverb: ReverbIR;
  comp: CompIR;
}

export type FxType = keyof FxParamMap;

/** One entry in the chain, fully expanded. */
export type FxIR = { [K in FxType]: { type: K; params: FxParamMap[K] } }[FxType];

/** What the parser produces before defaults are merged in. */
export type FxInput = { [K in FxType]: { type: K; params: Partial<FxParamMap[K]> } }[FxType];

export const DIST_MODES: Record<string, number> = { tanh: 0, fold: 1, clip: 2 };

// ----------------------------------------------------------------- descriptors

/**
 * How a parameter is spelled in the document and shown back to the reader.
 *
 * This is the DSL's half of the contract and it lives here on purpose: the DSP
 * core is handed a number at an offset and never learns that the number was
 * written `-6dB` (non-negotiable 1). The IR always carries the *param block's*
 * unit — `db-linear` means the DSL says dB and the IR holds linear gain, which
 * is why it needs a spelling of its own.
 */
export type FxUnit =
  | 'norm' // bare 0..1, shown rounded
  | 'ratio' // written and shown as a percentage
  | 'db'
  | 'db-linear' // dB in the document, linear in the IR and the block
  | 'hz'
  | 'seconds'
  | 'count' // a bare integer or ratio, shown as written
  | 'bool'
  | 'enum';

export interface FxParamDesc<P> {
  /** The key as written in the fence. */
  key: string;
  /** The field it lands on in this effect's IR. */
  field: keyof P & string;
  /** Index inside the effect's parameter block. */
  offset: number;
  unit: FxUnit;
  /** Default, already in IR units. `beats` is for a musical default. */
  value?: number | boolean | string;
  /** A default the bpm resolves, in beats — delay's `3/16`. */
  beats?: number;
  /** `enum` only: the spellings, and what each is worth in the block. */
  values?: Record<string, number>;
  /** Editable range. Domain facts — a phaser has 2..8 stages — not GUI ones. */
  min?: number;
  max?: number;
  step?: number;
  /** Shown instead of the key with its underscores spaced out. */
  label?: string;
}

export interface FxDesc<P> {
  id: number;
  /** Every spelling accepted for `type:`; the first is the canonical one. */
  aliases: string[];
  params: FxParamDesc<P>[];
}

/**
 * The effect set, described once.
 *
 * Everything below this point is derived from it — the type ids, the accepted
 * spellings, the allowed keys, the defaults, the flattening into the parameter
 * block and the expanded view. Adding an effect is an entry here plus a file in
 * `dsp/src/fx/`, rather than an edit to five tables that have to agree.
 *
 * `field` is typed against the effect's IR, so a typo in one is a type error
 * rather than a parameter that silently never gets written.
 */
export const FX_DESCRIPTORS: { [K in FxType]: FxDesc<FxParamMap[K]> } = {
  dist: {
    id: FX_DIST,
    aliases: ['dist', 'distortion'],
    params: [
      { key: 'drive', field: 'drive', offset: DIST_DRIVE, unit: 'norm', value: 0.3 },
      { key: 'mix', field: 'mix', offset: DIST_MIX, unit: 'ratio', value: 1 },
      { key: 'mode', field: 'mode', offset: DIST_MODE, unit: 'enum', value: 'tanh', values: DIST_MODES },
      { key: 'tone', field: 'toneHz', offset: DIST_TONE_HZ, unit: 'hz', value: 20000 },
    ],
  },
  eq: {
    id: FX_EQ,
    aliases: ['eq'],
    params: [
      { key: 'low', field: 'lowDb', offset: EQ_LOW_DB, unit: 'db', value: 0, min: -24, max: 24 },
      { key: 'mid', field: 'midDb', offset: EQ_MID_DB, unit: 'db', value: 0, min: -24, max: 24 },
      { key: 'high', field: 'highDb', offset: EQ_HIGH_DB, unit: 'db', value: 0, min: -24, max: 24 },
      { key: 'mid_freq', field: 'midFreqHz', offset: EQ_MID_FREQ_HZ, unit: 'hz', value: 1000 },
    ],
  },
  chorus: {
    id: FX_CHORUS,
    aliases: ['chorus'],
    params: [
      { key: 'rate', field: 'rateHz', offset: CHORUS_RATE_HZ, unit: 'hz', value: 0.8, min: 0.01, max: 20 },
      { key: 'depth', field: 'depth', offset: CHORUS_DEPTH, unit: 'ratio', value: 0.3 },
      { key: 'mix', field: 'mix', offset: CHORUS_MIX, unit: 'ratio', value: 0.35 },
    ],
  },
  phaser: {
    id: FX_PHASER,
    aliases: ['phaser'],
    params: [
      { key: 'rate', field: 'rateHz', offset: PHASER_RATE_HZ, unit: 'hz', value: 0.4, min: 0.01, max: 20 },
      { key: 'depth', field: 'depth', offset: PHASER_DEPTH, unit: 'ratio', value: 0.7 },
      { key: 'feedback', field: 'feedback', offset: PHASER_FEEDBACK, unit: 'ratio', value: 0.3 },
      { key: 'mix', field: 'mix', offset: PHASER_MIX, unit: 'ratio', value: 0.4 },
      { key: 'stages', field: 'stages', offset: PHASER_STAGES, unit: 'count', value: 6, min: 2, max: 8, step: 2 },
      { key: 'center', field: 'centerHz', offset: PHASER_CENTER_HZ, unit: 'hz', value: 800 },
    ],
  },
  flanger: {
    id: FX_FLANGER,
    aliases: ['flanger'],
    params: [
      { key: 'rate', field: 'rateHz', offset: FLANGER_RATE_HZ, unit: 'hz', value: 0.25, min: 0.01, max: 20 },
      { key: 'depth', field: 'depth', offset: FLANGER_DEPTH, unit: 'ratio', value: 0.6 },
      { key: 'feedback', field: 'feedback', offset: FLANGER_FEEDBACK, unit: 'ratio', value: 0.5 },
      { key: 'mix', field: 'mix', offset: FLANGER_MIX, unit: 'ratio', value: 0.35 },
    ],
  },
  delay: {
    id: FX_DELAY,
    aliases: ['delay'],
    params: [
      // 3/16 = 0.75 beat, so the default moves with the document's bpm.
      { key: 'time', field: 'timeS', offset: DELAY_TIME_S, unit: 'seconds', beats: 0.75, min: 0.001, max: 2 },
      { key: 'feedback', field: 'feedback', offset: DELAY_FEEDBACK, unit: 'ratio', value: 0.4 },
      { key: 'mix', field: 'mix', offset: DELAY_MIX, unit: 'ratio', value: 0.25 },
      { key: 'pingpong', field: 'pingpong', offset: DELAY_PINGPONG, unit: 'bool', value: true, label: 'ping-pong' },
      { key: 'tone', field: 'toneHz', offset: DELAY_TONE_HZ, unit: 'hz', value: 4000 },
    ],
  },
  reverb: {
    id: FX_REVERB,
    aliases: ['reverb'],
    params: [
      { key: 'size', field: 'size', offset: REVERB_SIZE, unit: 'ratio', value: 0.6 },
      { key: 'damp', field: 'damp', offset: REVERB_DAMP, unit: 'ratio', value: 0.5 },
      { key: 'mix', field: 'mix', offset: REVERB_MIX, unit: 'ratio', value: 0.2 },
      { key: 'predelay', field: 'predelayS', offset: REVERB_PREDELAY_S, unit: 'seconds', value: 0.02, min: 0, max: 0.25, step: 0.001 },
      { key: 'width', field: 'width', offset: REVERB_WIDTH, unit: 'ratio', value: 1 },
    ],
  },
  comp: {
    id: FX_MBCOMP,
    aliases: ['comp', 'mbcomp'],
    params: [
      { key: 'thresh_low', field: 'threshLowDb', offset: MBCOMP_THRESH_LOW_DB, unit: 'db', value: -24, min: -80, max: 0 },
      { key: 'thresh_mid', field: 'threshMidDb', offset: MBCOMP_THRESH_MID_DB, unit: 'db', value: -24, min: -80, max: 0 },
      { key: 'thresh_high', field: 'threshHighDb', offset: MBCOMP_THRESH_HIGH_DB, unit: 'db', value: -24, min: -80, max: 0 },
      { key: 'ratio', field: 'ratio', offset: MBCOMP_RATIO, unit: 'count', value: 3, min: 1, max: 20 },
      { key: 'attack', field: 'attackS', offset: MBCOMP_ATTACK_S, unit: 'seconds', value: 0.01, min: 0.0005, max: 1 },
      { key: 'release', field: 'releaseS', offset: MBCOMP_RELEASE_S, unit: 'seconds', value: 0.12, min: 0.005, max: 5 },
      { key: 'makeup', field: 'makeup', offset: MBCOMP_MAKEUP, unit: 'db-linear', value: 1, min: -24, max: 24 }, // 0dB
    ],
  },
};

const FX_TYPES = Object.keys(FX_DESCRIPTORS) as FxType[];

/** Untyped view of a descriptor, for the loops that cannot name the effect. */
const descOf = (type: FxType): FxDesc<Record<string, unknown>> =>
  FX_DESCRIPTORS[type] as unknown as FxDesc<Record<string, unknown>>;

const fromTypes = <V>(f: (type: FxType) => V): Record<FxType, V> =>
  Object.fromEntries(FX_TYPES.map((t) => [t, f(t)])) as Record<FxType, V>;

export const FX_TYPE_IDS: Record<FxType, number> = fromTypes((t) => FX_DESCRIPTORS[t].id);

/** DSL spellings accepted for `type:` (docs/syntax.md). */
export const FX_ALIASES: Record<string, FxType> = Object.fromEntries(
  FX_TYPES.flatMap((t) => FX_DESCRIPTORS[t].aliases.map((a) => [a, t] as const)),
);

/** Allowed DSL keys per effect (`type` is added by the parser). */
export const FX_KEYS: Record<FxType, string[]> = fromTypes((t) =>
  descOf(t).params.map((p) => p.key),
);

// ------------------------------------------------------------------ defaults

/**
 * docs/syntax.md per-effect defaults. `bpm` resolves delay's musical default
 * (3/16). Built from the descriptors, so the defaults documented there and the
 * defaults the parser fills in cannot drift apart.
 *
 * The cast is the one place the descriptors give up on types: `params` is
 * assembled key by key, and only the `field` typing above keeps the keys
 * honest. `fx.test.ts` asserts the whole expanded default for every effect.
 */
export function defaultFxEntry(type: FxType, bpm: number): FxIR {
  const params: Record<string, unknown> = {};
  for (const p of descOf(type).params) {
    params[p.field] = p.beats !== undefined ? beatsToSeconds(p.beats, bpm) : p.value;
  }
  return { type, params } as unknown as FxIR;
}

/**
 * Merge parsed fields over the type's defaults.
 * The cast is sound because `type` determines both halves of the union member.
 */
export function mergeFx(entry: FxInput, bpm: number): FxIR {
  const base = defaultFxEntry(entry.type, bpm);
  return { type: entry.type, params: { ...base.params, ...entry.params } } as FxIR;
}

// ----------------------------------------------------------------- flattening

export function writeNoise(p: Float32Array, noise: NoiseIR): void {
  p[NOISE_BASE + NOISE_ENABLED] = noise.enabled ? 1 : 0;
  p[NOISE_BASE + NOISE_LEVEL] = noise.level;
  p[NOISE_BASE + NOISE_COLOR] = NOISE_COLORS[noise.color] ?? 0;
}

/**
 * Chain order goes into the FX_ORDER slots, and each effect's parameters into
 * the block of the slot it occupies. Position in the chain — not type — is what
 * addresses a block, so the region stays 8 x 8 floats however many effect types
 * come to exist, and an unused slot is left at zero.
 */
export function writeFxChain(p: Float32Array, chain: FxIR[]): void {
  for (let i = 0; i < FX_SLOTS; i++) {
    const entry = chain[i];
    p[FX_ORDER_BASE + i] = entry ? FX_TYPE_IDS[entry.type] : FX_NONE;
    if (entry) writeFxParams(p, entry, i);
  }
}

export function fxSlotBase(slot: number): number {
  return FX_SLOT_BASE + slot * FX_SLOT_STRIDE;
}

/** A field's value as the parameter block wants it: a plain `f32`. */
function toBlock(value: unknown, desc: FxParamDesc<Record<string, unknown>>): number {
  switch (desc.unit) {
    case 'bool':
      return value ? 1 : 0;
    case 'enum':
      return desc.values?.[String(value)] ?? 0;
    default:
      return value as number;
  }
}

function writeFxParams(p: Float32Array, entry: FxIR, slot: number): void {
  const b = fxSlotBase(slot);
  const params = entry.params as unknown as Record<string, unknown>;
  for (const desc of descOf(entry.type).params) {
    p[b + desc.offset] = toBlock(params[desc.field], desc);
  }
}

// -------------------------------------------------------------- display view

const r = (v: number, digits = 4): number => {
  const f = Math.pow(10, digits);
  return Math.round(v * f) / f;
};
const pct = (v: number): string => `${r(v * 100, 3)}%`;
const sec = (s: number): string => (s >= 1 ? `${r(s, 4)}s` : `${r(s * 1000, 3)}ms`);
const hz = (v: number): string => (v >= 1000 ? `${r(v / 1000, 4)}kHz` : `${r(v, 3)}Hz`);
const db = (v: number): string => `${v >= 0 ? '+' : ''}${r(v, 2)}dB`;

export function noiseView(noise: NoiseIR): unknown {
  return {
    enabled: noise.enabled,
    level: `${db(linearToDb(noise.level))} (${r(noise.level)})`,
    color: `${noise.color} (${NOISE_COLORS[noise.color] ?? 0})`,
  };
}

/** Unit-annotated chain, in processing order. */
export function fxView(chain: FxIR[]): unknown[] {
  return chain.map((entry, i) => ({
    slot: i + 1,
    type: `${entry.type} (id ${FX_TYPE_IDS[entry.type]})`,
    ...fxParamsView(entry),
  }));
}

function showValue(value: unknown, desc: FxParamDesc<Record<string, unknown>>): unknown {
  switch (desc.unit) {
    case 'norm':
      return r(value as number);
    case 'ratio':
      return pct(value as number);
    case 'db':
      return db(value as number);
    case 'db-linear': {
      const linear = value as number;
      return `${db(linearToDb(linear))} (${r(linear)})`;
    }
    case 'hz':
      return hz(value as number);
    case 'seconds':
      return sec(value as number);
    case 'enum':
      return `${String(value)} (${desc.values?.[String(value)] ?? 0})`;
    default:
      return value;
  }
}

function fxParamsView(entry: FxIR): Record<string, unknown> {
  const params = entry.params as unknown as Record<string, unknown>;
  const view: Record<string, unknown> = {};
  for (const desc of descOf(entry.type).params) {
    view[desc.key] = showValue(params[desc.field], desc);
  }
  return view;
}
