// Top level: markdown document → patch params + loop IR + diagnostics.
//
// Glicol style: whatever compiled successfully is returned even when other
// parts failed, so the caller can keep the last valid patch playing.

import { extractFences, findFence, type Fence } from './fences.ts';
import { parseSynth } from './synth.ts';
import { parseLoop, type LoopIR, type LoopMeta } from './loop.ts';
import { expandedView, DEFAULT_BPM, type PatchIR } from './ir.ts';
import { sortErrors, type DslError } from './errors.ts';

export interface CompiledPatch {
  ir: PatchIR;
  params: Float32Array;
  /** Pretty, unit-annotated view of the fully expanded patch. */
  expanded: unknown;
}

export interface CompileResult {
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

  const synthFence = findFence(fences, 'synth');
  const loopFence = findFence(fences, 'loop');

  // The loop fence owns the tempo; the patch needs it to resolve musical units
  // (`rate: 1/4`, `d: 1/8`, ...).
  let bpm = DEFAULT_BPM;
  if (loopFence?.attrs['bpm'] !== undefined) {
    const v = Number(loopFence.attrs['bpm']);
    if (Number.isFinite(v) && v > 0) bpm = v;
  }

  const result: CompileResult = { bpm, errors, fences };

  if (!synthFence && !loopFence) {
    errors.push({
      line: 1,
      col: 1,
      message: 'no ```synth or ```loop code fence found in the document',
    });
  }

  if (synthFence) {
    const r = parseSynth(synthFence.body, synthFence.attrs, {
      bodyStartLine: synthFence.bodyStartLine,
      bpm,
    });
    errors.push(...r.errors);
    if (r.ir && r.params) {
      result.patch = { ir: r.ir, params: r.params, expanded: expandedView(r.ir) };
    }
  }

  if (loopFence) {
    const r = parseLoop(loopFence.body, loopFence.attrs, {
      bodyStartLine: loopFence.bodyStartLine,
      sampleRate,
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
