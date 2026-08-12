// Top level: markdown document → per-track patch params + loop IR + diagnostics.
//
// v0.3: every ```synth fence is a track, indexed by order of appearance
// (SPEC §7). Glicol style per track — a fence with an error yields no params so
// the caller keeps that track's last valid patch, while the others reload.

import { extractFences, findFence, type Fence } from './fences.ts';
import { parseSynth } from './synth.ts';
import { parseLoop, type LoopIR, type LoopMeta } from './loop.ts';
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
  /** Track index = order of appearance among synth fences. */
  track: number;
}

export interface CompileResult {
  /** Tracks that compiled cleanly, in track order. */
  tracks: CompiledTrack[];
  /**
   * How many synth fences the document declares (including ones that failed to
   * compile, so their index stays reserved). Tracks at or above this index are
   * stale and should be cleared.
   */
  trackCount: number;
  /** Convenience alias for tracks[0], kept for single-track callers. */
  patch?: CompiledPatch;
  loop?: LoopIR;
  loopMeta?: LoopMeta;
  /** BPM in effect (from the loop fence, else the default). */
  bpm: number;
  errors: DslError[];
  /** Fences found in the document, for diagnostics/UI. */
  fences: Fence[];
}

export function compile(markdown: string, sampleRate: number): CompileResult {
  const fences = extractFences(markdown);
  const errors: DslError[] = [];

  const synthFences = fences.filter((f) => f.lang === 'synth');
  const loopFence = findFence(fences, 'loop');

  // The loop fence owns the tempo; patches need it to resolve musical units
  // (`rate: 1/4`, delay `time: 3/16`, ...).
  let bpm = DEFAULT_BPM;
  if (loopFence?.attrs['bpm'] !== undefined) {
    const v = Number(loopFence.attrs['bpm']);
    if (Number.isFinite(v) && v > 0) bpm = v;
  }

  if (synthFences.length > MAX_TRACKS) {
    for (const extra of synthFences.slice(MAX_TRACKS)) {
      errors.push({
        line: extra.fenceLine,
        col: 1,
        message: `at most ${MAX_TRACKS} synth fences (tracks) are supported, got ${synthFences.length}`,
      });
    }
  }

  const used = synthFences.slice(0, MAX_TRACKS);
  const tracks: CompiledTrack[] = [];
  // Every declared fence gets an id, so loop lines can bind even to a fence
  // that failed to compile.
  const trackIds: Record<string, number> = {};

  used.forEach((fence, index) => {
    const id = fence.attrs['id'] ?? `track${index}`;
    if (trackIds[id] !== undefined) {
      errors.push({
        line: fence.fenceLine,
        col: 1,
        message: `duplicate synth id "${id}" — each track needs a unique id`,
      });
    } else {
      trackIds[id] = index;
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

  const result: CompileResult = { tracks, trackCount: used.length, bpm, errors, fences };
  if (tracks[0]) result.patch = tracks[0];

  if (used.length === 0 && !loopFence) {
    errors.push({
      line: 1,
      col: 1,
      message: 'no ```synth or ```loop code fence found in the document',
    });
  }

  if (loopFence) {
    const r = parseLoop(loopFence.body, loopFence.attrs, {
      bodyStartLine: loopFence.bodyStartLine,
      sampleRate,
      trackIds,
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
