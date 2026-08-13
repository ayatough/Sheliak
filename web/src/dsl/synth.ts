// `synth` fence → PatchIR.
//
// Field names, units and ranges are validated here (docs/syntax.md).
// Nothing throws: everything comes back as { line, col, message }.

import { ErrorSink, type DslError, type Pos } from './errors.ts';
import { parseYamlite, type YMap, type YNode, isMap, isSeq, isScalar, nodePos } from './yamlite.ts';
import { parseScalar, dbToLinear, beatsToSeconds, beatsToHz, clamp, type UnitValue } from './units.ts';
import {
  expandPatch,
  irToParams,
  FILTER_MODES,
  LFO_WAVES,
  MOD_SOURCES,
  MOD_DESTS,
  CENTS_DESTS,
  DEFAULT_BPM,
  type PatchIR,
  type PatchInput,
  type OscIR,
  type FilterIR,
  type AdsrIR,
  type LfoIR,
  type ModIR,
  type VoiceIR,
} from './ir.ts';
import {
  FX_ALIASES,
  FX_KEYS,
  DIST_MODES,
  NOISE_COLORS,
  type FxInput,
  type FxType,
  type NoiseIR,
  type FxParamMap,
} from './fx.ts';
import { TABLE_IDS, MAX_UNISON, MAX_VOICES, MOD_SLOTS, FX_SLOTS } from '../shared/params.ts';

export interface SynthParseOptions {
  /** 1-based document line of the first body line. */
  bodyStartLine?: number;
  /** BPM used to resolve musical units (comes from the loop fence). */
  bpm?: number;
}

export interface SynthParseResult {
  /** null when the patch has any error — the caller keeps the last valid one. */
  ir: PatchIR | null;
  params: Float32Array | null;
  errors: DslError[];
}

const TOP_KEYS = ['osc', 'noise', 'filter', 'env', 'lfo', 'mod', 'voice', 'fx'];
const NOISE_KEYS = ['level', 'color'];
const OSC_KEYS = ['table', 'level', 'morph', 'unison', 'detune', 'spread', 'tune', 'phase_random'];
const FILTER_KEYS = ['type', 'cutoff', 'res', 'drive', 'key_track'];
const ADSR_KEYS = ['a', 'd', 's', 'r'];
const LFO_KEYS = ['wave', 'rate', 'phase'];
const MOD_KEYS = ['from', 'to', 'amount'];
const VOICE_KEYS = ['polyphony', 'glide'];

/** Parse a `synth` fence body. `attrs` come from the info string (`id=`, `seed=`). */
export function parseSynth(
  body: string,
  attrs: Record<string, string> = {},
  opts: SynthParseOptions = {},
): SynthParseResult {
  const startLine = opts.bodyStartLine ?? 1;
  const bpm = opts.bpm && opts.bpm > 0 ? opts.bpm : DEFAULT_BPM;
  const sink = new ErrorSink();

  const { root, errors } = parseYamlite(body, startLine);
  for (const e of errors) sink.errors.push(e);

  const input: PatchInput = { bpm };
  const fencePos: Pos = { line: startLine - 1, col: 1 };

  input.id = attrs['id'] ?? '';
  if (attrs['seed'] !== undefined) {
    const seed = Number(attrs['seed']);
    if (!Number.isFinite(seed) || !Number.isInteger(seed) || seed < 0) {
      sink.push(fencePos, `seed must be a non-negative integer, got "${attrs['seed']}"`);
    } else {
      input.seed = seed;
    }
  }

  if (root) readTop(root, input, bpm, sink);

  const ir = expandPatch(input);
  if (!sink.ok) return { ir: null, params: null, errors: sink.errors };
  return { ir, params: irToParams(ir), errors: [] };
}

// ------------------------------------------------------------------ traversal

function readTop(root: YMap, input: PatchInput, bpm: number, sink: ErrorSink): void {
  const fields = mapFields(root, TOP_KEYS, 'patch', sink);

  const oscNode = fields['osc'];
  if (oscNode) input.osc = readOscList(oscNode, sink);

  // The presence of `noise:` is what enables the layer (docs/syntax.md).
  const noiseNode = fields['noise'];
  if (noiseNode) input.noise = readNoise(noiseNode, sink);

  const filterNode = fields['filter'];
  if (filterNode) input.filter = readFilter(filterNode, sink);

  const envNode = fields['env'];
  if (envNode) input.env = readEnv(envNode, bpm, sink);

  const lfoNode = fields['lfo'];
  if (lfoNode) input.lfo1 = readLfo(lfoNode, bpm, sink);

  const modNode = fields['mod'];
  if (modNode) input.mod = readModList(modNode, sink);

  const voiceNode = fields['voice'];
  if (voiceNode) input.voice = readVoice(voiceNode, bpm, sink);

  const fxNode = fields['fx'];
  if (fxNode) input.fx = readFxList(fxNode, bpm, sink);

  // `osc: []` only makes sense together with a noise layer.
  if (input.osc && input.osc.length === 0 && !input.noise) {
    const oscKey = root.entries.find((e) => e.key === 'osc');
    sink.push(oscKey ? oscKey.keyPos : nodePos(root), 'patch produces no sound: osc is empty and no noise section');
  }
}

// ---------------------------------------------------------------------- noise

function readNoise(node: YNode, sink: ErrorSink): Partial<NoiseIR> {
  // `enabled` is implied by the section existing; expandPatch forces it true.
  const out: Partial<NoiseIR> = { enabled: true };
  const m = asMap(node, 'noise', sink);
  if (!m) return out;
  const f = mapFields(m, NOISE_KEYS, 'noise', sink);

  const level = f['level'];
  if (level) {
    const db = readGain(level, 'level', sink);
    if (db !== undefined) out.level = dbToLinear(clamp(db, -96, 12));
  }

  const color = f['color'];
  if (color) {
    const name = readName(color, 'color', sink);
    if (name !== undefined) {
      if (NOISE_COLORS[name] === undefined) {
        sink.push(nodePos(color), `unknown noise color "${name}" (expected one of: ${Object.keys(NOISE_COLORS).join(', ')})`);
      } else {
        out.color = name as NoiseIR['color'];
      }
    }
  }

  return out;
}

// ------------------------------------------------------------------ fx chain

function readFxList(node: YNode, bpm: number, sink: ErrorSink): FxInput[] {
  const items: YNode[] = isSeq(node) ? node.items : isMap(node) ? [node] : [];
  if (!isSeq(node) && !isMap(node)) {
    sink.push(nodePos(node), 'fx must be a list of effects');
    return [];
  }
  if (items.length > FX_SLOTS) {
    sink.push(nodePos(items[FX_SLOTS] as YNode), `at most ${FX_SLOTS} effects are supported, got ${items.length}`);
  }

  const out: FxInput[] = [];
  const seen = new Map<FxType, YNode>();

  for (const item of items.slice(0, FX_SLOTS)) {
    const m = asMap(item, 'fx entry', sink);
    if (!m) continue;

    const typeEntry = m.entries.find((e) => e.key === 'type');
    if (!typeEntry) {
      sink.push(nodePos(item), 'fx entry needs a type, e.g. { type: reverb }');
      continue;
    }
    const rawType = readName(typeEntry.value, 'type', sink);
    if (rawType === undefined) continue;
    const type = FX_ALIASES[rawType];
    if (type === undefined) {
      sink.push(
        nodePos(typeEntry.value),
        `unknown effect type "${rawType}" (expected one of: ${Object.keys(FX_ALIASES).join(', ')})`,
      );
      continue;
    }
    if (seen.has(type)) {
      sink.push(nodePos(typeEntry.value), `effect "${type}" appears more than once — each type may be used at most once`);
      continue;
    }
    seen.set(type, typeEntry.value);

    const f = mapFields(m, ['type', ...FX_KEYS[type]], `fx.${type}`, sink);
    out.push(readFxEntry(type, f, bpm, sink));
  }

  return out;
}

function readFxEntry(type: FxType, f: Record<string, YNode>, bpm: number, sink: ErrorSink): FxInput {
  // Each branch reads only its own keys; unknown ones were already reported.
  switch (type) {
    case 'dist': {
      const v: Partial<FxParamMap['dist']> = {};
      assignRatio(v, 'drive', f['drive'], sink, 0, 1);
      assignRatio(v, 'mix', f['mix'], sink, 0, 1);
      const mode = f['mode'];
      if (mode) {
        const name = readName(mode, 'mode', sink);
        if (name !== undefined) {
          if (DIST_MODES[name] === undefined) {
            sink.push(nodePos(mode), `unknown dist mode "${name}" (expected one of: ${Object.keys(DIST_MODES).join(', ')})`);
          } else {
            v.mode = name as FxParamMap['dist']['mode'];
          }
        }
      }
      assignFreq(v, 'toneHz', f['tone'], 'tone', sink);
      return { type, params: v };
    }
    case 'eq': {
      const v: Partial<FxParamMap['eq']> = {};
      assignGainDb(v, 'lowDb', f['low'], 'low', sink);
      assignGainDb(v, 'midDb', f['mid'], 'mid', sink);
      assignGainDb(v, 'highDb', f['high'], 'high', sink);
      assignFreq(v, 'midFreqHz', f['mid_freq'], 'mid_freq', sink);
      return { type, params: v };
    }
    case 'chorus': {
      const v: Partial<FxParamMap['chorus']> = {};
      assignRate(v, 'rateHz', f['rate'], 'rate', bpm, sink);
      assignRatio(v, 'depth', f['depth'], sink, 0, 1);
      assignRatio(v, 'mix', f['mix'], sink, 0, 1);
      return { type, params: v };
    }
    case 'phaser': {
      const v: Partial<FxParamMap['phaser']> = {};
      assignRate(v, 'rateHz', f['rate'], 'rate', bpm, sink);
      assignRatio(v, 'depth', f['depth'], sink, 0, 1);
      assignRatio(v, 'feedback', f['feedback'], sink, 0, 1);
      assignRatio(v, 'mix', f['mix'], sink, 0, 1);
      const stages = f['stages'];
      if (stages) {
        const n = readCount(stages, 'stages', sink);
        if (n !== undefined) {
          const i = Math.round(n);
          if (i < 2 || i > 8 || i % 2 !== 0) {
            sink.push(nodePos(stages), `stages must be an even number between 2 and 8, got ${n}`);
          } else {
            v.stages = i;
          }
        }
      }
      assignFreq(v, 'centerHz', f['center'], 'center', sink);
      return { type, params: v };
    }
    case 'flanger': {
      const v: Partial<FxParamMap['flanger']> = {};
      assignRate(v, 'rateHz', f['rate'], 'rate', bpm, sink);
      assignRatio(v, 'depth', f['depth'], sink, 0, 1);
      assignRatio(v, 'feedback', f['feedback'], sink, 0, 1);
      assignRatio(v, 'mix', f['mix'], sink, 0, 1);
      return { type, params: v };
    }
    case 'delay': {
      const v: Partial<FxParamMap['delay']> = {};
      const time = f['time'];
      if (time) {
        // Absolute (ms/s) and musical (3/16) both allowed.
        const s = readTime(time, 'time', bpm, sink);
        if (s !== undefined) v.timeS = clamp(s, 0.001, 2);
      }
      assignRatio(v, 'feedback', f['feedback'], sink, 0, 1);
      assignRatio(v, 'mix', f['mix'], sink, 0, 1);
      const pingpong = f['pingpong'];
      if (pingpong) {
        const b = readBool(pingpong, 'pingpong', sink);
        if (b !== undefined) v.pingpong = b;
      }
      assignFreq(v, 'toneHz', f['tone'], 'tone', sink);
      return { type, params: v };
    }
    case 'reverb': {
      const v: Partial<FxParamMap['reverb']> = {};
      assignRatio(v, 'size', f['size'], sink, 0, 1);
      assignRatio(v, 'damp', f['damp'], sink, 0, 1);
      assignRatio(v, 'mix', f['mix'], sink, 0, 1);
      const predelay = f['predelay'];
      if (predelay) {
        const s = readTime(predelay, 'predelay', bpm, sink);
        if (s !== undefined) v.predelayS = clamp(s, 0, 0.25);
      }
      assignRatio(v, 'width', f['width'], sink, 0, 1);
      return { type, params: v };
    }
    case 'comp': {
      const v: Partial<FxParamMap['comp']> = {};
      assignThresh(v, 'threshLowDb', f['thresh_low'], 'thresh_low', sink);
      assignThresh(v, 'threshMidDb', f['thresh_mid'], 'thresh_mid', sink);
      assignThresh(v, 'threshHighDb', f['thresh_high'], 'thresh_high', sink);
      const ratio = f['ratio'];
      if (ratio) {
        const n = readCount(ratio, 'ratio', sink);
        if (n !== undefined) {
          if (n < 1) sink.push(nodePos(ratio), `ratio must be >= 1, got ${n}`);
          else v.ratio = clamp(n, 1, 100);
        }
      }
      const attack = f['attack'];
      if (attack) {
        const s = readTime(attack, 'attack', bpm, sink);
        if (s !== undefined) v.attackS = clamp(s, 0, 1);
      }
      const release = f['release'];
      if (release) {
        const s = readTime(release, 'release', bpm, sink);
        if (s !== undefined) v.releaseS = clamp(s, 0, 5);
      }
      const makeup = f['makeup'];
      if (makeup) {
        const db = readGain(makeup, 'makeup', sink);
        if (db !== undefined) v.makeup = dbToLinear(clamp(db, -24, 24));
      }
      return { type, params: v };
    }
  }
}

// Small typed assignment helpers — they keep the per-effect branches readable.

function assignRatio<T, K extends keyof T>(
  target: T,
  key: K,
  node: YNode | undefined,
  sink: ErrorSink,
  lo: number,
  hi: number,
): void {
  if (!node) return;
  const v = readRatio(node, String(key), sink);
  if (v !== undefined) target[key] = clamp(v, lo, hi) as T[K];
}

function assignFreq<T, K extends keyof T>(
  target: T,
  key: K,
  node: YNode | undefined,
  field: string,
  sink: ErrorSink,
): void {
  if (!node) return;
  const v = readFreq(node, field, sink);
  if (v !== undefined) target[key] = clamp(v, 20, 20000) as T[K];
}

function assignGainDb<T, K extends keyof T>(
  target: T,
  key: K,
  node: YNode | undefined,
  field: string,
  sink: ErrorSink,
): void {
  if (!node) return;
  const v = readGain(node, field, sink);
  if (v !== undefined) target[key] = clamp(v, -24, 24) as T[K];
}

function assignThresh<T, K extends keyof T>(
  target: T,
  key: K,
  node: YNode | undefined,
  field: string,
  sink: ErrorSink,
): void {
  if (!node) return;
  const v = readGain(node, field, sink);
  if (v !== undefined) target[key] = clamp(v, -80, 0) as T[K];
}

function assignRate<T, K extends keyof T>(
  target: T,
  key: K,
  node: YNode | undefined,
  field: string,
  bpm: number,
  sink: ErrorSink,
): void {
  if (!node) return;
  const v = readRate(node, field, bpm, sink);
  if (v !== undefined) target[key] = v as T[K];
}

function readOscList(node: YNode, sink: ErrorSink): Partial<OscIR>[] {
  const items: YNode[] = isSeq(node) ? node.items : isMap(node) ? [node] : [];
  if (!isSeq(node) && !isMap(node)) {
    sink.push(nodePos(node), 'osc must be a list of oscillators');
    return [];
  }
  if (items.length > 2) {
    sink.push(nodePos(items[2] as YNode), `at most 2 oscillators are supported, got ${items.length}`);
  }
  const out: Partial<OscIR>[] = [];
  for (const item of items.slice(0, 2)) {
    out.push(readOsc(item, sink));
  }
  return out;
}

function readOsc(node: YNode, sink: ErrorSink): Partial<OscIR> {
  const osc: Partial<OscIR> = {};
  const m = asMap(node, 'osc entry', sink);
  if (!m) return osc;
  const f = mapFields(m, OSC_KEYS, 'osc', sink);

  const table = f['table'];
  if (table) {
    const name = readName(table, 'table', sink);
    if (name !== undefined) {
      const id = TABLE_IDS[name];
      if (id === undefined) {
        sink.push(nodePos(table), `unknown table "${name}" (expected one of: ${Object.keys(TABLE_IDS).join(', ')})`);
      } else {
        osc.table = name;
        osc.tableId = id;
      }
    }
  }

  const level = f['level'];
  if (level) {
    const db = readGain(level, 'level', sink);
    if (db !== undefined) osc.level = dbToLinear(clamp(db, -96, 24));
  }

  const morph = f['morph'];
  if (morph) {
    const v = readRatio(morph, 'morph', sink);
    if (v !== undefined) osc.morph = clamp(v, 0, 1);
  }

  const unison = f['unison'];
  if (unison) {
    const v = readCount(unison, 'unison', sink);
    if (v !== undefined) osc.unison = clamp(Math.round(v), 1, MAX_UNISON);
  }

  const detune = f['detune'];
  if (detune) {
    const v = readCents(detune, 'detune', sink);
    if (v !== undefined) osc.detuneCents = clamp(v, 0, 1200);
  }

  const spread = f['spread'];
  if (spread) {
    const v = readRatio(spread, 'spread', sink);
    if (v !== undefined) osc.spread = clamp(v, 0, 1);
  }

  const tune = f['tune'];
  if (tune) {
    const uv = scalarValue(tune, 'tune', sink);
    if (uv) {
      if (uv.unit === 'semitone') {
        const st = clamp(uv.value, -48, 48);
        const semi = Math.trunc(st);
        osc.tuneSemi = semi;
        osc.tuneCents = Math.round((st - semi) * 100 * 1e6) / 1e6;
      } else if (uv.unit === 'cent') {
        osc.tuneSemi = 0;
        osc.tuneCents = clamp(uv.value, -4800, 4800);
      } else {
        unitError(uv, 'tune', 'semitones or cents (e.g. -12st, +7c)', sink);
      }
    }
  }

  const phaseRandom = f['phase_random'];
  if (phaseRandom) {
    const v = readBool(phaseRandom, 'phase_random', sink);
    if (v !== undefined) osc.phaseRandom = v;
  }

  return osc;
}

function readFilter(node: YNode, sink: ErrorSink): Partial<FilterIR> {
  const out: Partial<FilterIR> = {};
  const m = asMap(node, 'filter', sink);
  if (!m) return out;
  const f = mapFields(m, FILTER_KEYS, 'filter', sink);

  const type = f['type'];
  if (type) {
    const name = readName(type, 'type', sink);
    if (name !== undefined) {
      if (FILTER_MODES[name] === undefined) {
        sink.push(nodePos(type), `unknown filter type "${name}" (expected one of: ${Object.keys(FILTER_MODES).join(', ')})`);
      } else {
        out.type = name;
      }
    }
  }

  const cutoff = f['cutoff'];
  if (cutoff) {
    const hz = readFreq(cutoff, 'cutoff', sink);
    if (hz !== undefined) out.cutoffHz = clamp(hz, 20, 20000);
  }

  for (const key of ['res', 'drive', 'key_track'] as const) {
    const n = f[key];
    if (!n) continue;
    const v = readRatio(n, key, sink);
    if (v === undefined) continue;
    if (key === 'res') out.res = clamp(v, 0, 1);
    else if (key === 'drive') out.drive = clamp(v, 0, 1);
    else out.keyTrack = clamp(v, 0, 1);
  }

  return out;
}

function readEnv(node: YNode, bpm: number, sink: ErrorSink): { amp?: Partial<AdsrIR>; filter?: Partial<AdsrIR> } {
  const out: { amp?: Partial<AdsrIR>; filter?: Partial<AdsrIR> } = {};
  const m = asMap(node, 'env', sink);
  if (!m) return out;
  const f = mapFields(m, ['amp', 'filter'], 'env', sink);

  const amp = f['amp'];
  if (amp) out.amp = readAdsr(amp, 'env.amp', bpm, sink);
  const filt = f['filter'];
  if (filt) out.filter = readAdsr(filt, 'env.filter', bpm, sink);
  return out;
}

function readAdsr(node: YNode, what: string, bpm: number, sink: ErrorSink): Partial<AdsrIR> {
  const out: Partial<AdsrIR> = {};
  const m = asMap(node, what, sink);
  if (!m) return out;
  const f = mapFields(m, ADSR_KEYS, what, sink);

  for (const key of ['a', 'd', 'r'] as const) {
    const n = f[key];
    if (!n) continue;
    const v = readTime(n, `${what}.${key}`, bpm, sink);
    if (v !== undefined) out[key] = clamp(v, 0, 60);
  }
  const s = f['s'];
  if (s) {
    const v = readRatio(s, `${what}.s`, sink);
    if (v !== undefined) out.s = clamp(v, 0, 1);
  }
  return out;
}

function readLfo(node: YNode, bpm: number, sink: ErrorSink): Partial<LfoIR> {
  const m = asMap(node, 'lfo', sink);
  if (!m) return {};
  // `lfo:` holds numbered slots; MVP only has slot 1.
  const f = mapFields(m, ['1'], 'lfo', sink);
  const one = f['1'];
  if (!one) return {};

  const out: Partial<LfoIR> = {};
  const sm = asMap(one, 'lfo.1', sink);
  if (!sm) return out;
  const lf = mapFields(sm, LFO_KEYS, 'lfo.1', sink);

  const wave = lf['wave'];
  if (wave) {
    const name = readName(wave, 'wave', sink);
    if (name !== undefined) {
      if (LFO_WAVES[name] === undefined) {
        sink.push(nodePos(wave), `unknown lfo wave "${name}" (expected one of: ${Object.keys(LFO_WAVES).join(', ')})`);
      } else {
        out.wave = name;
      }
    }
  }

  const rate = lf['rate'];
  if (rate) {
    const v = readRate(rate, 'rate', bpm, sink);
    if (v !== undefined) out.rateHz = v;
  }

  const phase = lf['phase'];
  if (phase) {
    const v = readRatio(phase, 'phase', sink);
    if (v !== undefined) out.phase = clamp(v, 0, 1);
  }

  return out;
}

function readModList(node: YNode, sink: ErrorSink): ModIR[] {
  const items: YNode[] = isSeq(node) ? node.items : isMap(node) ? [node] : [];
  if (!isSeq(node) && !isMap(node)) {
    sink.push(nodePos(node), 'mod must be a list of routings');
    return [];
  }
  if (items.length > MOD_SLOTS) {
    sink.push(nodePos(items[MOD_SLOTS] as YNode), `at most ${MOD_SLOTS} mod slots are supported, got ${items.length}`);
  }

  const out: ModIR[] = [];
  for (const item of items.slice(0, MOD_SLOTS)) {
    const m = asMap(item, 'mod entry', sink);
    if (!m) continue;
    const f = mapFields(m, MOD_KEYS, 'mod', sink);

    const fromNode = f['from'];
    const toNode = f['to'];
    const amountNode = f['amount'];

    if (!fromNode || !toNode || !amountNode) {
      sink.push(nodePos(item), 'mod entry needs from, to and amount');
      continue;
    }

    const from = readName(fromNode, 'from', sink);
    const to = readName(toNode, 'to', sink);
    if (from === undefined || to === undefined) continue;

    if (MOD_SOURCES[from] === undefined) {
      sink.push(nodePos(fromNode), `unknown mod source "${from}" (expected one of: ${Object.keys(MOD_SOURCES).join(', ')})`);
      continue;
    }
    const dst = MOD_DESTS[to];
    if (dst === undefined) {
      sink.push(nodePos(toNode), `unknown mod destination "${to}" (expected one of: ${Object.keys(MOD_DESTS).join(', ')})`);
      continue;
    }

    const uv = scalarValue(amountNode, 'amount', sink);
    if (!uv) continue;

    let amount: number | undefined;
    if (CENTS_DESTS.has(dst)) {
      if (uv.unit === 'cent') amount = clamp(uv.value, -9600, 9600);
      else if (uv.unit === 'semitone') amount = clamp(uv.value * 100, -9600, 9600);
      else unitError(uv, 'amount', `cents for "${to}" (e.g. +2400c)`, sink);
    } else {
      if (uv.unit === 'ratio' || uv.unit === 'bare') amount = clamp(uv.value, -1, 1);
      else unitError(uv, 'amount', `a normalized amount for "${to}" (e.g. 25% or 0.25)`, sink);
    }
    if (amount === undefined) continue;

    out.push({ from, to, amount });
  }
  return out;
}

function readVoice(node: YNode, bpm: number, sink: ErrorSink): Partial<VoiceIR> {
  const out: Partial<VoiceIR> = {};
  const m = asMap(node, 'voice', sink);
  if (!m) return out;
  const f = mapFields(m, VOICE_KEYS, 'voice', sink);

  const poly = f['polyphony'];
  if (poly) {
    const v = readCount(poly, 'polyphony', sink);
    if (v !== undefined) out.polyphony = clamp(Math.round(v), 1, MAX_VOICES);
  }
  const glide = f['glide'];
  if (glide) {
    const v = readTime(glide, 'glide', bpm, sink);
    if (v !== undefined) out.glide = clamp(v, 0, 10);
  }
  return out;
}

// -------------------------------------------------------------------- readers

function asMap(node: YNode, what: string, sink: ErrorSink): YMap | null {
  if (isMap(node)) return node;
  sink.push(nodePos(node), `${what} must be a map, e.g. { ... }`);
  return null;
}

/**
 * Index a map's entries by key, reporting unknown and duplicate keys.
 */
function mapFields(m: YMap, allowed: string[], what: string, sink: ErrorSink): Record<string, YNode> {
  const out: Record<string, YNode> = {};
  for (const entry of m.entries) {
    if (!allowed.includes(entry.key)) {
      sink.push(entry.keyPos, `unknown ${what} key "${entry.key}" (expected one of: ${allowed.join(', ')})`);
      continue;
    }
    if (out[entry.key] !== undefined) {
      sink.push(entry.keyPos, `duplicate ${what} key "${entry.key}"`);
    }
    out[entry.key] = entry.value;
  }
  return out;
}

function scalarValue(node: YNode, field: string, sink: ErrorSink): UnitValue | null {
  if (!isScalar(node)) {
    sink.push(nodePos(node), `${field} must be a single value`);
    return null;
  }
  if (node.value.trim() === '') {
    sink.push(nodePos(node), `${field} is empty`);
    return null;
  }
  return parseScalar(node.value, nodePos(node));
}

function unitError(uv: UnitValue, field: string, expected: string, sink: ErrorSink): void {
  const hint =
    uv.unit === 'bare'
      ? `bare numbers are not allowed for "${field}" — expected ${expected}`
      : `"${field}" expects ${expected}, got "${uv.raw}"`;
  sink.push({ line: uv.line, col: uv.col }, hint);
}

function readFreq(node: YNode, field: string, sink: ErrorSink): number | undefined {
  const uv = scalarValue(node, field, sink);
  if (!uv) return undefined;
  if (uv.unit === 'hz') return uv.value;
  unitError(uv, field, 'a frequency (e.g. 800Hz, 4.5kHz)', sink);
  return undefined;
}

function readGain(node: YNode, field: string, sink: ErrorSink): number | undefined {
  const uv = scalarValue(node, field, sink);
  if (!uv) return undefined;
  if (uv.unit === 'db') return uv.value;
  unitError(uv, field, 'a gain in dB (e.g. -6dB)', sink);
  return undefined;
}

function readTime(node: YNode, field: string, bpm: number, sink: ErrorSink): number | undefined {
  const uv = scalarValue(node, field, sink);
  if (!uv) return undefined;
  if (uv.unit === 'sec') return uv.value;
  if (uv.unit === 'musical') return beatsToSeconds(uv.value, bpm);
  unitError(uv, field, 'a time (e.g. 180ms, 2s, 1/8, 1bar)', sink);
  return undefined;
}

/**
 * Modulation rates: absolute (`5Hz`) or tempo-synced (`1/4`, converted with the
 * loop's bpm). Used by lfo.1 and the chorus/phaser/flanger rates.
 */
function readRate(node: YNode, field: string, bpm: number, sink: ErrorSink): number | undefined {
  const uv = scalarValue(node, field, sink);
  if (!uv) return undefined;
  if (uv.unit === 'hz') return clamp(uv.value, 0.001, 200);
  if (uv.unit === 'musical') return clamp(beatsToHz(uv.value, bpm), 0.001, 200);
  unitError(uv, field, 'frequency (e.g. 5Hz) or musical time (e.g. 1/4)', sink);
  return undefined;
}

/** Ratio fields accept `%` or a bare 0..1 number (the explicit whitelist). */
function readRatio(node: YNode, field: string, sink: ErrorSink): number | undefined {
  const uv = scalarValue(node, field, sink);
  if (!uv) return undefined;
  if (uv.unit === 'ratio' || uv.unit === 'bare') return uv.value;
  unitError(uv, field, 'a ratio (e.g. 70% or 0.7)', sink);
  return undefined;
}

function readCents(node: YNode, field: string, sink: ErrorSink): number | undefined {
  const uv = scalarValue(node, field, sink);
  if (!uv) return undefined;
  if (uv.unit === 'cent') return uv.value;
  if (uv.unit === 'semitone') return uv.value * 100;
  unitError(uv, field, 'a detune in cents (e.g. 22c) or semitones (e.g. 1st)', sink);
  return undefined;
}

/** Integer counts (unison, polyphony) are written bare — they carry no unit. */
function readCount(node: YNode, field: string, sink: ErrorSink): number | undefined {
  const uv = scalarValue(node, field, sink);
  if (!uv) return undefined;
  if (uv.unit === 'bare' && Number.isFinite(uv.value)) return uv.value;
  unitError(uv, field, 'a plain integer count (e.g. 7)', sink);
  return undefined;
}

function readName(node: YNode, field: string, sink: ErrorSink): string | undefined {
  if (!isScalar(node)) {
    sink.push(nodePos(node), `${field} must be a single value`);
    return undefined;
  }
  const v = node.value.trim();
  if (v === '') {
    sink.push(nodePos(node), `${field} is empty`);
    return undefined;
  }
  return v;
}

function readBool(node: YNode, field: string, sink: ErrorSink): boolean | undefined {
  const name = readName(node, field, sink);
  if (name === undefined) return undefined;
  const v = name.toLowerCase();
  if (v === 'on' || v === 'true' || v === 'yes') return true;
  if (v === 'off' || v === 'false' || v === 'no') return false;
  sink.push(nodePos(node), `${field} must be on/off, got "${name}"`);
  return undefined;
}
