// Patch IR — the normalized, fully-expanded internal representation (SPEC.md §5).
// The worklet never sees this: `irToParams` flattens it into the f32 block that
// matches `shared/params.ts` exactly.

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
  MOD_SLOTS,
  MOD_STRIDE,
  MOD_SRC,
  MOD_DST,
  MOD_AMOUNT,
  SRC_NONE,
  SRC_ENV_FILTER,
  SRC_ENV_AMP,
  SRC_LFO1,
  SRC_VELOCITY,
  DST_NONE,
  DST_FILTER_CUTOFF,
  DST_OSC1_MORPH,
  DST_OSC2_MORPH,
  DST_PITCH,
  DST_AMP,
  TABLE_IDS,
} from '../shared/params.ts';
import { dbToLinear, linearToDb } from './units.ts';
import {
  defaultNoise,
  mergeFx,
  writeNoise,
  writeFxChain,
  noiseView,
  fxView,
  type NoiseIR,
  type FxIR,
  type FxInput,
} from './fx.ts';

// ------------------------------------------------------------------ registries

export const FILTER_MODES: Record<string, number> = {
  lp12: 0,
  lp24: 1,
  hp12: 2,
  bp12: 3,
};

export const LFO_WAVES: Record<string, number> = {
  sine: 0,
  tri: 1,
  saw: 2,
  square: 3,
};

export const MOD_SOURCES: Record<string, number> = {
  'env.filter': SRC_ENV_FILTER,
  'env.amp': SRC_ENV_AMP,
  'lfo.1': SRC_LFO1,
  velocity: SRC_VELOCITY,
  none: SRC_NONE,
};

export const MOD_DESTS: Record<string, number> = {
  'filter.cutoff': DST_FILTER_CUTOFF,
  'osc.1.morph': DST_OSC1_MORPH,
  'osc.2.morph': DST_OSC2_MORPH,
  pitch: DST_PITCH,
  amp: DST_AMP,
  none: DST_NONE,
};

/** Destinations whose `amount` is expressed in cents (rest are normalized). */
export const CENTS_DESTS = new Set<number>([DST_FILTER_CUTOFF, DST_PITCH]);

// ------------------------------------------------------------------- IR types

export interface OscIR {
  enabled: boolean;
  table: string;
  tableId: number;
  /** Linear gain. */
  level: number;
  morph: number;
  unison: number;
  detuneCents: number;
  spread: number;
  tuneSemi: number;
  tuneCents: number;
  phaseRandom: boolean;
}

export interface FilterIR {
  type: string;
  cutoffHz: number;
  res: number;
  drive: number;
  keyTrack: number;
}

/** ADSR; a/d/r in seconds, s normalized 0..1. */
export interface AdsrIR {
  a: number;
  d: number;
  s: number;
  r: number;
}

export interface LfoIR {
  wave: string;
  rateHz: number;
  phase: number;
}

export interface ModIR {
  from: string;
  to: string;
  amount: number;
}

export interface VoiceIR {
  polyphony: number;
  glide: number;
}

export interface PatchIR {
  id: string;
  seed: number;
  /** BPM used to resolve musical units (from the loop fence). */
  bpm: number;
  masterGain: number;
  osc: OscIR[];
  /** v0.2: per-voice noise layer, disabled unless the patch has `noise:`. */
  noise: NoiseIR;
  filter: FilterIR;
  env: { amp: AdsrIR; filter: AdsrIR };
  lfo1: LfoIR;
  mod: ModIR[];
  voice: VoiceIR;
  /** v0.2: master FX chain, in processing order. */
  fx: FxIR[];
}

/** What the parser produces before defaults are filled in. */
export interface PatchInput {
  id?: string;
  seed?: number;
  bpm?: number;
  osc?: Partial<OscIR>[];
  /** Present only when the patch declared a `noise:` section. */
  noise?: Partial<NoiseIR>;
  filter?: Partial<FilterIR>;
  env?: { amp?: Partial<AdsrIR>; filter?: Partial<AdsrIR> };
  lfo1?: Partial<LfoIR>;
  mod?: ModIR[];
  voice?: Partial<VoiceIR>;
  fx?: FxInput[];
}

// ------------------------------------------------------------------- defaults

export function defaultOsc(enabled: boolean): OscIR {
  return {
    enabled,
    table: 'basic/saw',
    tableId: TABLE_IDS['basic/saw'] ?? 2,
    level: 1, // 0dB
    morph: 0,
    unison: 1,
    detuneCents: 0,
    spread: 0,
    tuneSemi: 0,
    tuneCents: 0,
    phaseRandom: true,
  };
}

export function defaultFilter(): FilterIR {
  return { type: 'lp12', cutoffHz: 20000, res: 0, drive: 0, keyTrack: 0 };
}

export function defaultEnvAmp(): AdsrIR {
  return { a: 0.005, d: 0.2, s: 0.7, r: 0.12 };
}

export function defaultEnvFilter(): AdsrIR {
  return { a: 0.002, d: 0.4, s: 0, r: 0.1 };
}

export function defaultLfo(): LfoIR {
  return { wave: 'tri', rateHz: 1, phase: 0 };
}

export function defaultVoice(): VoiceIR {
  return { polyphony: 8, glide: 0 };
}

/** SPEC §5: master gain is -6dB-ish (0.5) for headroom. */
export const DEFAULT_MASTER_GAIN = 0.5;
export const DEFAULT_BPM = 120;

// -------------------------------------------------------------------- expand

/** Fill every unspecified field with its default → the "展開済みビュー". */
export function expandPatch(input: PatchInput = {}): PatchIR {
  const oscIn = input.osc ?? [];
  const osc: OscIR[] = [];
  for (let i = 0; i < 2; i++) {
    const given = oscIn[i];
    // Osc A is enabled by default so an empty patch still makes sound;
    // Osc B only exists when the DSL declares it.
    const base = defaultOsc(given !== undefined || i === 0);
    osc.push(given ? { ...base, ...given, enabled: true } : base);
  }

  const filter = { ...defaultFilter(), ...(input.filter ?? {}) };
  const env = {
    amp: { ...defaultEnvAmp(), ...(input.env?.amp ?? {}) },
    filter: { ...defaultEnvFilter(), ...(input.env?.filter ?? {}) },
  };
  const lfo1 = { ...defaultLfo(), ...(input.lfo1 ?? {}) };
  const voice = { ...defaultVoice(), ...(input.voice ?? {}) };
  const bpm = input.bpm ?? DEFAULT_BPM;

  // A `noise:` section switches the layer on; its fields fall back to defaults.
  const noise: NoiseIR = input.noise ? { ...defaultNoise(true), ...input.noise, enabled: true } : defaultNoise(false);

  return {
    id: input.id ?? '',
    seed: input.seed ?? 0,
    bpm,
    masterGain: DEFAULT_MASTER_GAIN,
    osc,
    noise,
    filter,
    env,
    lfo1,
    mod: input.mod ?? [],
    voice,
    fx: (input.fx ?? []).map((entry) => mergeFx(entry, bpm)),
  };
}

// ---------------------------------------------------------------- flattening

/** IR → the f32 parameter block handed to the worklet. */
export function irToParams(ir: PatchIR): Float32Array {
  const p = new Float32Array(PARAM_COUNT);

  p[P_POLYPHONY] = ir.voice.polyphony;
  p[P_GLIDE_S] = ir.voice.glide;
  p[P_MASTER_GAIN] = ir.masterGain;
  p[P_SEED] = ir.seed;

  writeOsc(p, OSC_A_BASE, ir.osc[0]);
  writeOsc(p, OSC_B_BASE, ir.osc[1]);
  writeNoise(p, ir.noise);

  p[P_FILTER_MODE] = FILTER_MODES[ir.filter.type] ?? 0;
  p[P_FILTER_CUTOFF_HZ] = ir.filter.cutoffHz;
  p[P_FILTER_RES] = ir.filter.res;
  p[P_FILTER_DRIVE] = ir.filter.drive;
  p[P_FILTER_KEYTRACK] = ir.filter.keyTrack;

  writeEnv(p, ENV_AMP_BASE, ir.env.amp);
  writeEnv(p, ENV_FILTER_BASE, ir.env.filter);

  p[P_LFO_WAVE] = LFO_WAVES[ir.lfo1.wave] ?? 1;
  p[P_LFO_RATE_HZ] = ir.lfo1.rateHz;
  p[P_LFO_PHASE] = ir.lfo1.phase;

  for (let i = 0; i < MOD_SLOTS; i++) {
    const base = MOD_BASE + i * MOD_STRIDE;
    const slot = ir.mod[i];
    if (!slot) {
      p[base + MOD_SRC] = SRC_NONE;
      p[base + MOD_DST] = DST_NONE;
      p[base + MOD_AMOUNT] = 0;
      continue;
    }
    p[base + MOD_SRC] = MOD_SOURCES[slot.from] ?? SRC_NONE;
    p[base + MOD_DST] = MOD_DESTS[slot.to] ?? DST_NONE;
    p[base + MOD_AMOUNT] = slot.amount;
  }

  writeFxChain(p, ir.fx);

  return p;
}

function writeOsc(p: Float32Array, base: number, osc: OscIR | undefined): void {
  if (!osc) {
    p[base + OSC_ENABLED] = 0;
    return;
  }
  p[base + OSC_ENABLED] = osc.enabled ? 1 : 0;
  p[base + OSC_TABLE_ID] = osc.tableId;
  p[base + OSC_LEVEL] = osc.level;
  p[base + OSC_MORPH] = osc.morph;
  p[base + OSC_UNISON] = osc.unison;
  p[base + OSC_DETUNE_CENTS] = osc.detuneCents;
  p[base + OSC_SPREAD] = osc.spread;
  p[base + OSC_TUNE_SEMI] = osc.tuneSemi;
  p[base + OSC_TUNE_CENTS] = osc.tuneCents;
  p[base + OSC_PHASE_RANDOM] = osc.phaseRandom ? 1 : 0;
}

function writeEnv(p: Float32Array, base: number, env: AdsrIR): void {
  p[base + ENV_A] = env.a;
  p[base + ENV_D] = env.d;
  p[base + ENV_S] = env.s;
  p[base + ENV_R] = env.r;
}

// ------------------------------------------------------------- expanded view

/**
 * Human-readable expansion of the IR, with units spelled out.
 * Rendered as pretty JSON in the UI's "展開済みパラメータ" panel.
 */
export function expandedView(ir: PatchIR): unknown {
  const sec = (s: number) => (s >= 1 ? `${round(s, 4)}s` : `${round(s * 1000, 3)}ms`);
  const pct = (v: number) => `${round(v * 100, 3)}%`;

  return {
    id: ir.id,
    seed: ir.seed,
    bpm: ir.bpm,
    master_gain: `${round(linearToDb(ir.masterGain), 2)}dB (${round(ir.masterGain, 4)})`,
    osc: ir.osc.map((o, i) => ({
      index: i + 1,
      enabled: o.enabled,
      table: `${o.table} (id ${o.tableId})`,
      level: `${round(linearToDb(o.level), 2)}dB (${round(o.level, 4)})`,
      morph: pct(o.morph),
      unison: o.unison,
      detune: `${round(o.detuneCents, 3)}c`,
      spread: pct(o.spread),
      tune: `${o.tuneSemi}st ${o.tuneCents >= 0 ? '+' : ''}${round(o.tuneCents, 3)}c`,
      phase_random: o.phaseRandom,
    })),
    noise: noiseView(ir.noise),
    filter: {
      type: `${ir.filter.type} (mode ${FILTER_MODES[ir.filter.type] ?? 0})`,
      cutoff: `${round(ir.filter.cutoffHz, 3)}Hz`,
      res: round(ir.filter.res, 4),
      drive: round(ir.filter.drive, 4),
      key_track: pct(ir.filter.keyTrack),
    },
    env: {
      amp: { a: sec(ir.env.amp.a), d: sec(ir.env.amp.d), s: pct(ir.env.amp.s), r: sec(ir.env.amp.r) },
      filter: {
        a: sec(ir.env.filter.a),
        d: sec(ir.env.filter.d),
        s: pct(ir.env.filter.s),
        r: sec(ir.env.filter.r),
      },
    },
    lfo: {
      1: {
        wave: `${ir.lfo1.wave} (${LFO_WAVES[ir.lfo1.wave] ?? 1})`,
        rate: `${round(ir.lfo1.rateHz, 4)}Hz`,
        phase: pct(ir.lfo1.phase),
      },
    },
    mod: ir.mod.map((m, i) => ({
      slot: i,
      from: `${m.from} (${MOD_SOURCES[m.from] ?? 0})`,
      to: `${m.to} (${MOD_DESTS[m.to] ?? 0})`,
      amount: CENTS_DESTS.has(MOD_DESTS[m.to] ?? 0) ? `${round(m.amount, 3)}c` : pct(m.amount),
    })),
    voice: { polyphony: ir.voice.polyphony, glide: sec(ir.voice.glide) },
    fx: fxView(ir.fx),
  };
}

function round(v: number, digits: number): number {
  const f = Math.pow(10, digits);
  return Math.round(v * f) / f;
}

export { dbToLinear };
export type { NoiseIR, FxIR, FxInput, FxType } from './fx.ts';
export { FX_TYPE_IDS, FX_ALIASES, FX_KEYS, DIST_MODES, NOISE_COLORS, defaultFxEntry, defaultNoise } from './fx.ts';
