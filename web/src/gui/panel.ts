// Panel logic: slider ↔ value mapping and the writeback computation.
// Pure functions only — the DOM binding lives in view.ts.

import { setSynthField, getSynthFieldText, type EditResult } from '../dsl/edit.ts';
import { formatFor } from '../dsl/format.ts';
import { parseScalar } from '../dsl/units.ts';
import type { FieldSpec } from './schema.ts';

/** Slider position (0..1) for a field's current value. */
export function toSlider(spec: FieldSpec, value: number): number {
  const min = spec.min ?? 0;
  const max = spec.max ?? 1;
  if (max === min) return 0;
  if (spec.kind === 'log') {
    const lo = Math.log(Math.max(min, 1e-6));
    const hi = Math.log(Math.max(max, 1e-6));
    const v = Math.log(Math.max(value, 1e-6));
    return clamp01((v - lo) / (hi - lo));
  }
  return clamp01((value - min) / (max - min));
}

/** Value for a slider position (0..1). */
export function fromSlider(spec: FieldSpec, t: number): number {
  const min = spec.min ?? 0;
  const max = spec.max ?? 1;
  const u = clamp01(t);
  if (spec.kind === 'log') {
    const lo = Math.log(Math.max(min, 1e-6));
    const hi = Math.log(Math.max(max, 1e-6));
    return Math.exp(lo + (hi - lo) * u);
  }
  const raw = min + (max - min) * u;
  if (spec.kind === 'int') {
    const step = spec.step ?? 1;
    return Math.min(max, Math.max(min, Math.round(raw / step) * step));
  }
  return raw;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** How a field's value reads in the UI, using the same spelling as the text. */
export function displayValue(spec: FieldSpec, value?: number | string | boolean): string {
  return formatFor(spec.unit, value ?? spec.value);
}

/**
 * Apply a control change to the document.
 * Returns the patched markdown, or why the edit could not be made.
 */
export function writeField(
  doc: string,
  track: number,
  spec: FieldSpec,
  value: number | string | boolean,
): EditResult {
  return setSynthField(doc, track, spec.path, formatFor(spec.unit, value));
}

export interface FieldStatus {
  /** The token currently in the text, or null when the value is a default. */
  text: string | null;
  /** True when the text uses musical time (`1/4`) for this field. */
  musical: boolean;
  /** False when the field cannot be written (missing section). */
  editable: boolean;
  reason?: string;
}

/**
 * Inspect how a field is currently spelled.
 * Musical-time tokens (`rate: 1/4`, `time: 3/16`) stay editable: scrubbing
 * rewrites them in Hz/seconds, which is why the badge tells the user that the
 * tempo link is about to be replaced by an absolute value.
 *
 * `compiled` is the caller's "this fence produced a patch" flag. Syntax errors
 * are caught here by the parser, but unit/range errors are only known to the
 * compiler, and we refuse to patch a fence the user still has to fix.
 */
export function fieldStatus(doc: string, track: number, spec: FieldSpec, compiled = true): FieldStatus {
  const text = getSynthFieldText(doc, track, spec.path);
  const musical = text !== null && parseScalar(text, { line: 1, col: 1 }).unit === 'musical';
  if (!compiled) {
    return { text, musical, editable: false, reason: 'fix the errors in this fence to edit it here' };
  }
  if (text !== null) return { text, musical, editable: true };

  // Not written out: can we insert it into the enclosing flow map?
  const probe = setSynthField(doc, track, spec.path, formatFor(spec.unit, spec.value));
  if (probe.ok) return { text: null, musical: false, editable: true };
  return { text: null, musical: false, editable: false, reason: probe.reason };
}
