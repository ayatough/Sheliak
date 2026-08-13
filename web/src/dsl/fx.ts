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
  FX_PARAMS_BASE,
  FX_PARAMS_STRIDE,
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

export const FX_TYPE_IDS: Record<FxType, number> = {
  dist: FX_DIST,
  eq: FX_EQ,
  chorus: FX_CHORUS,
  phaser: FX_PHASER,
  flanger: FX_FLANGER,
  delay: FX_DELAY,
  reverb: FX_REVERB,
  comp: FX_MBCOMP,
};

/** DSL spellings accepted for `type:` (docs/syntax.md). */
export const FX_ALIASES: Record<string, FxType> = {
  dist: 'dist',
  distortion: 'dist',
  eq: 'eq',
  chorus: 'chorus',
  phaser: 'phaser',
  flanger: 'flanger',
  delay: 'delay',
  reverb: 'reverb',
  comp: 'comp',
  mbcomp: 'comp',
};

/** Allowed DSL keys per effect (`type` is added by the parser). */
export const FX_KEYS: Record<FxType, string[]> = {
  dist: ['drive', 'mix', 'mode', 'tone'],
  eq: ['low', 'mid', 'high', 'mid_freq'],
  chorus: ['rate', 'depth', 'mix'],
  phaser: ['rate', 'depth', 'feedback', 'mix', 'stages', 'center'],
  flanger: ['rate', 'depth', 'feedback', 'mix'],
  delay: ['time', 'feedback', 'mix', 'pingpong', 'tone'],
  reverb: ['size', 'damp', 'mix', 'predelay', 'width'],
  comp: ['thresh_low', 'thresh_mid', 'thresh_high', 'ratio', 'attack', 'release', 'makeup'],
};

// ------------------------------------------------------------------ defaults

/** docs/syntax.md per-effect defaults. `bpm` resolves delay's musical default (3/16). */
export function defaultFxEntry(type: FxType, bpm: number): FxIR {
  switch (type) {
    case 'dist':
      return { type: 'dist', params: { drive: 0.3, mix: 1, mode: 'tanh', toneHz: 20000 } };
    case 'eq':
      return { type: 'eq', params: { lowDb: 0, midDb: 0, highDb: 0, midFreqHz: 1000 } };
    case 'chorus':
      return { type: 'chorus', params: { rateHz: 0.8, depth: 0.3, mix: 0.35 } };
    case 'phaser':
      return {
        type: 'phaser',
        params: { rateHz: 0.4, depth: 0.7, feedback: 0.3, mix: 0.4, stages: 6, centerHz: 800 },
      };
    case 'flanger':
      return { type: 'flanger', params: { rateHz: 0.25, depth: 0.6, feedback: 0.5, mix: 0.35 } };
    case 'delay':
      return {
        type: 'delay',
        // 3/16 = 0.75 beat.
        params: { timeS: beatsToSeconds(0.75, bpm), feedback: 0.4, mix: 0.25, pingpong: true, toneHz: 4000 },
      };
    case 'reverb':
      return { type: 'reverb', params: { size: 0.6, damp: 0.5, mix: 0.2, predelayS: 0.02, width: 1 } };
    case 'comp':
      return {
        type: 'comp',
        params: {
          threshLowDb: -24,
          threshMidDb: -24,
          threshHighDb: -24,
          ratio: 3,
          attackS: 0.01,
          releaseS: 0.12,
          makeup: 1, // 0dB
        },
      };
  }
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

/** Chain order goes into FX_ORDER slots; each effect's params into its block. */
export function writeFxChain(p: Float32Array, chain: FxIR[]): void {
  for (let i = 0; i < FX_SLOTS; i++) {
    const entry = chain[i];
    p[FX_ORDER_BASE + i] = entry ? FX_TYPE_IDS[entry.type] : FX_NONE;
  }
  for (const entry of chain) {
    writeFxParams(p, entry);
  }
}

function fxBase(type: FxType): number {
  return FX_PARAMS_BASE + (FX_TYPE_IDS[type] - 1) * FX_PARAMS_STRIDE;
}

function writeFxParams(p: Float32Array, entry: FxIR): void {
  const b = fxBase(entry.type);
  switch (entry.type) {
    case 'dist': {
      const v = entry.params;
      p[b + DIST_DRIVE] = v.drive;
      p[b + DIST_MIX] = v.mix;
      p[b + DIST_MODE] = DIST_MODES[v.mode] ?? 0;
      p[b + DIST_TONE_HZ] = v.toneHz;
      break;
    }
    case 'eq': {
      const v = entry.params;
      p[b + EQ_LOW_DB] = v.lowDb;
      p[b + EQ_MID_DB] = v.midDb;
      p[b + EQ_HIGH_DB] = v.highDb;
      p[b + EQ_MID_FREQ_HZ] = v.midFreqHz;
      break;
    }
    case 'chorus': {
      const v = entry.params;
      p[b + CHORUS_RATE_HZ] = v.rateHz;
      p[b + CHORUS_DEPTH] = v.depth;
      p[b + CHORUS_MIX] = v.mix;
      break;
    }
    case 'phaser': {
      const v = entry.params;
      p[b + PHASER_RATE_HZ] = v.rateHz;
      p[b + PHASER_DEPTH] = v.depth;
      p[b + PHASER_FEEDBACK] = v.feedback;
      p[b + PHASER_MIX] = v.mix;
      p[b + PHASER_STAGES] = v.stages;
      p[b + PHASER_CENTER_HZ] = v.centerHz;
      break;
    }
    case 'flanger': {
      const v = entry.params;
      p[b + FLANGER_RATE_HZ] = v.rateHz;
      p[b + FLANGER_DEPTH] = v.depth;
      p[b + FLANGER_FEEDBACK] = v.feedback;
      p[b + FLANGER_MIX] = v.mix;
      break;
    }
    case 'delay': {
      const v = entry.params;
      p[b + DELAY_TIME_S] = v.timeS;
      p[b + DELAY_FEEDBACK] = v.feedback;
      p[b + DELAY_MIX] = v.mix;
      p[b + DELAY_PINGPONG] = v.pingpong ? 1 : 0;
      p[b + DELAY_TONE_HZ] = v.toneHz;
      break;
    }
    case 'reverb': {
      const v = entry.params;
      p[b + REVERB_SIZE] = v.size;
      p[b + REVERB_DAMP] = v.damp;
      p[b + REVERB_MIX] = v.mix;
      p[b + REVERB_PREDELAY_S] = v.predelayS;
      p[b + REVERB_WIDTH] = v.width;
      break;
    }
    case 'comp': {
      const v = entry.params;
      p[b + MBCOMP_THRESH_LOW_DB] = v.threshLowDb;
      p[b + MBCOMP_THRESH_MID_DB] = v.threshMidDb;
      p[b + MBCOMP_THRESH_HIGH_DB] = v.threshHighDb;
      p[b + MBCOMP_RATIO] = v.ratio;
      p[b + MBCOMP_ATTACK_S] = v.attackS;
      p[b + MBCOMP_RELEASE_S] = v.releaseS;
      p[b + MBCOMP_MAKEUP] = v.makeup;
      break;
    }
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

function fxParamsView(entry: FxIR): Record<string, unknown> {
  switch (entry.type) {
    case 'dist': {
      const v = entry.params;
      return { drive: r(v.drive), mix: pct(v.mix), mode: `${v.mode} (${DIST_MODES[v.mode] ?? 0})`, tone: hz(v.toneHz) };
    }
    case 'eq': {
      const v = entry.params;
      return { low: db(v.lowDb), mid: db(v.midDb), high: db(v.highDb), mid_freq: hz(v.midFreqHz) };
    }
    case 'chorus': {
      const v = entry.params;
      return { rate: hz(v.rateHz), depth: pct(v.depth), mix: pct(v.mix) };
    }
    case 'phaser': {
      const v = entry.params;
      return {
        rate: hz(v.rateHz),
        depth: pct(v.depth),
        feedback: pct(v.feedback),
        mix: pct(v.mix),
        stages: v.stages,
        center: hz(v.centerHz),
      };
    }
    case 'flanger': {
      const v = entry.params;
      return { rate: hz(v.rateHz), depth: pct(v.depth), feedback: pct(v.feedback), mix: pct(v.mix) };
    }
    case 'delay': {
      const v = entry.params;
      return {
        time: sec(v.timeS),
        feedback: pct(v.feedback),
        mix: pct(v.mix),
        pingpong: v.pingpong,
        tone: hz(v.toneHz),
      };
    }
    case 'reverb': {
      const v = entry.params;
      return {
        size: pct(v.size),
        damp: pct(v.damp),
        mix: pct(v.mix),
        predelay: sec(v.predelayS),
        width: pct(v.width),
      };
    }
    case 'comp': {
      const v = entry.params;
      return {
        thresh_low: db(v.threshLowDb),
        thresh_mid: db(v.threshMidDb),
        thresh_high: db(v.threshHighDb),
        ratio: v.ratio,
        attack: sec(v.attackS),
        release: sec(v.releaseS),
        makeup: `${db(linearToDb(v.makeup))} (${r(v.makeup)})`,
      };
    }
  }
}
