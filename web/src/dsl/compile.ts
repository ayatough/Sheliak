// Top level: markdown document → per-track patch params + loop IR + diagnostics.
//
// v0.3: every ```synth fence is a track, indexed by order of appearance
// (docs/syntax.md). Glicol style per track — a fence with an error yields no params so
// the caller keeps that track's last valid patch, while the others reload.

import { extractFences, findFence, type Fence } from './fences.ts';
import { parseFrontmatter, type SongHeader } from './frontmatter.ts';
import { parseSynth } from './synth.ts';
import { parseLoop, type LoopIR, type LoopMeta } from './loop.ts';
import { parsePhrase, type Phrase } from './phrase.ts';
import { parsePlugin, type PluginIR } from './plugin.ts';
import { expandedView, DEFAULT_BPM, type PatchIR } from './ir.ts';
import { sortErrors, type DslError } from './errors.ts';
import { MAX_TRACKS } from '../shared/params.ts';

export interface CompiledPatch {
  ir: PatchIR;
  params: Float32Array;
  /** Pretty, unit-annotated view of the fully expanded patch. */
  expanded: unknown;
}

export interface CompiledTrack extends CompiledPatch {
  /** The fence's `id=` (or a generated `trackN` when absent). */
  id: string;
  /** Track index = order of appearance among synth **and plugin** fences. */
  track: number;
}

/**
 * A track whose voice is a plugin. It holds an index in the same sequence as
 * the synth tracks, and no patch — the engine has nothing to play for it, so
 * its output is silence anywhere a plugin cannot be loaded (which is every
 * browser). `sheliak render` says so rather than leaving it a mystery.
 */
export interface CompiledPluginTrack extends PluginIR {
  track: number;
}

export interface CompileResult {
  /** Tracks that compiled cleanly, in track order. */
  tracks: CompiledTrack[];
  /**
   * How many tracks the document declares — synth and plugin fences together,
   * including ones that failed to compile, so their index stays reserved.
   * Tracks at or above this index are stale and should be cleared.
   */
  trackCount: number;
  /** Tracks played by a plugin rather than by the engine, in track order. */
  pluginTracks: CompiledPluginTrack[];
  /** Convenience alias for tracks[0], kept for single-track callers. */
  patch?: CompiledPatch;
  /** Every `phrase` fence that parsed, by id. */
  phrases: Record<string, Phrase>;
  loop?: LoopIR;
  loopMeta?: LoopMeta;
  /** BPM in effect (the loop fence, else the song header, else the default). */
  bpm: number;
  /** The song header, empty when the document has none. */
  header: SongHeader;
  errors: DslError[];
  /** Fences found in the document, for diagnostics/UI. */
  fences: Fence[];
}

export function compile(markdown: string, sampleRate: number): CompileResult {
  const fences = extractFences(markdown);
  const errors: DslError[] = [];

  // Both kinds of fence are tracks and they share one sequence, so the index a
  // `loop` line binds to is the order of appearance among them together.
  const trackFences = fences.filter((f) => f.lang === 'synth' || f.lang === 'plugin');
  const loopFence = findFence(fences, 'loop');

  // The song header (Stream 2 §2), if there is one. Its fields are defaults:
  // anything a fence says for itself wins, so adding a header to a document
  // that already spelled everything out cannot change what it sounds like.
  const front = parseFrontmatter(markdown);
  errors.push(...front.errors);
  const header = front.header;

  // Tempo: the loop fence still wins, because that is where it lives today.
  // Patches need it to resolve musical units (`rate: 1/4`, delay `time: 3/16`).
  let bpm = header.bpm ?? DEFAULT_BPM;
  if (loopFence?.attrs['bpm'] !== undefined) {
    const v = Number(loopFence.attrs['bpm']);
    if (Number.isFinite(v) && v > 0) bpm = v;
  }

  if (trackFences.length > MAX_TRACKS) {
    for (const extra of trackFences.slice(MAX_TRACKS)) {
      errors.push({
        line: extra.fenceLine,
        col: 1,
        message: `at most ${MAX_TRACKS} tracks are supported, got ${trackFences.length}`,
      });
    }
  }

  const used = trackFences.slice(0, MAX_TRACKS);
  const tracks: CompiledTrack[] = [];
  const pluginTracks: CompiledPluginTrack[] = [];
  // Every declared fence gets an id, so loop lines can bind even to a fence
  // that failed to compile.
  const trackIds: Record<string, number> = {};

  used.forEach((fence, index) => {
    const id = fence.attrs['id'] ?? `track${index}`;
    if (trackIds[id] !== undefined) {
      errors.push({
        line: fence.fenceLine,
        col: 1,
        message: `duplicate track id "${id}" — each track needs a unique id`,
      });
    } else {
      trackIds[id] = index;
    }

    if (fence.lang === 'plugin') {
      const r = parsePlugin(fence.body, fence.attrs, {
        bodyStartLine: fence.bodyStartLine,
        fenceLine: fence.fenceLine,
      });
      errors.push(...r.errors);
      if (r.ir) pluginTracks.push({ ...r.ir, id, track: index });
      return;
    }

    const r = parseSynth(fence.body, fence.attrs, {
      bodyStartLine: fence.bodyStartLine,
      bpm,
    });
    errors.push(...r.errors);
    if (r.ir && r.params) {
      tracks.push({ id, track: index, ir: r.ir, params: r.params, expanded: expandedView(r.ir) });
    }
  });

  // Phrases are parsed before the loop, which only holds references to them.
  const phrases: Record<string, Phrase> = {};
  // Every id the document declares, whether or not its fence parsed — the same
  // reason `trackIds` above includes fences that failed. A loop line naming a
  // broken phrase is not a second mistake, and must not be reported as one.
  const declaredPhrases = new Set<string>();
  for (const fence of fences.filter((f) => f.lang === 'phrase')) {
    const id = fence.attrs['id'] ?? '';
    if (id !== '') declaredPhrases.add(id);
    if (id !== '' && phrases[id]) {
      errors.push({
        line: fence.fenceLine,
        col: 1,
        message: `duplicate phrase id "${id}" — each phrase needs a unique id`,
      });
      continue;
    }
    const r = parsePhrase(fence.body, fence.attrs, {
      bodyStartLine: fence.bodyStartLine,
      inherited: { key: header.key, scale: header.scale },
    });
    errors.push(...r.errors);
    if (r.phrase && id !== '') phrases[id] = r.phrase;
  }

  const result: CompileResult = {
    tracks,
    pluginTracks,
    trackCount: used.length,
    phrases,
    bpm,
    header,
    errors,
    fences,
  };
  if (tracks[0]) result.patch = tracks[0];

  if (used.length === 0 && !loopFence) {
    errors.push({
      line: 1,
      col: 1,
      message: 'no ```synth, ```plugin or ```loop code fence found in the document',
    });
  }

  if (loopFence) {
    const r = parseLoop(loopFence.body, loopFence.attrs, {
      bodyStartLine: loopFence.bodyStartLine,
      sampleRate,
      trackIds,
      phrases,
      declaredPhrases,
      defaultBars: header.bars,
    });
    errors.push(...r.errors);
    if (r.loop) result.loop = r.loop;
    if (r.meta) result.loopMeta = r.meta;
  }

  result.errors = sortErrors(errors);
  return result;
}

export type { DslError } from './errors.ts';
export type { LoopIR } from './loop.ts';
