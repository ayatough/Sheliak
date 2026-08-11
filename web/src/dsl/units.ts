// Unit-typed scalar parsing (REQUIREMENTS §3.1).
//
//   frequency   320Hz, 4.5kHz
//   gain        -6dB
//   time (abs)  180ms, 2s
//   time (mus)  1/16, 2bar, 1.5beat
//   pitch       -7c, +12st
//   ratio       70%   (bare 0.0-1.0 only where a field explicitly allows it)
//
// Bare numbers are deliberately a distinct unit kind so field validators can
// reject them everywhere except the whitelisted normalized fields.

import type { Pos } from './errors.ts';

export type Unit =
  | 'hz' // value: Hz
  | 'db' // value: dB
  | 'sec' // value: seconds
  | 'musical' // value: beats (quarter notes); 1bar = 4 beats
  | 'cent' // value: cents
  | 'semitone' // value: semitones
  | 'ratio' // value: 0..1 (from %)
  | 'bare' // value: raw number, no unit given
  | 'ident'; // non-numeric token (enum name, dotted reference, ...)

export interface UnitValue extends Pos {
  unit: Unit;
  /** Canonical numeric value for the unit (NaN for `ident`). */
  value: number;
  /** Original source text, for error messages. */
  raw: string;
}

const NUM_RE = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;
const FRACTION_RE = /^([+-]?\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/;

// Longest suffix first so `ms` beats `s`, `st` beats `s`, `khz` beats `hz`.
const SUFFIXES: ReadonlyArray<readonly [string, Unit]> = [
  ['beats', 'musical'],
  ['beat', 'musical'],
  ['bars', 'musical'],
  ['khz', 'hz'],
  ['bar', 'musical'],
  ['hz', 'hz'],
  ['db', 'db'],
  ['ms', 'sec'],
  ['st', 'semitone'],
  ['s', 'sec'],
  ['c', 'cent'],
  ['%', 'ratio'],
];

/** Parse one scalar token. Never throws; unknown shapes come back as `ident`. */
export function parseScalar(raw: string, pos: Pos): UnitValue {
  const t = raw.trim();
  const base: Pos = { line: pos.line, col: pos.col };

  const fr = FRACTION_RE.exec(t);
  if (fr) {
    const n = parseFloat(fr[1] as string);
    const d = parseFloat(fr[2] as string);
    if (d !== 0) {
      // Musical fraction is relative to a whole note: 1/4 = 1 beat, 1/16 = 0.25 beat.
      return { unit: 'musical', value: (4 * n) / d, raw: t, ...base };
    }
  }

  const lower = t.toLowerCase();
  for (const [suffix, unit] of SUFFIXES) {
    if (lower.length > suffix.length && lower.endsWith(suffix)) {
      const numPart = t.slice(0, t.length - suffix.length);
      if (!NUM_RE.test(numPart)) continue;
      let v = parseFloat(numPart);
      switch (suffix) {
        case 'khz':
          v *= 1000;
          break;
        case 'ms':
          v /= 1000;
          break;
        case 'bar':
        case 'bars':
          v *= 4;
          break;
        case '%':
          v /= 100;
          break;
        default:
          break;
      }
      return { unit, value: v, raw: t, ...base };
    }
  }

  if (NUM_RE.test(t)) return { unit: 'bare', value: parseFloat(t), raw: t, ...base };

  return { unit: 'ident', value: NaN, raw: t, ...base };
}

// ---------------------------------------------------------------- conversions

export function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

export function linearToDb(lin: number): number {
  return 20 * Math.log10(Math.max(lin, 1e-9));
}

/** Musical duration (in beats) -> seconds. */
export function beatsToSeconds(beats: number, bpm: number): number {
  return (beats * 60) / bpm;
}

/** Musical duration (in beats) -> rate in Hz (one full cycle per duration). */
export function beatsToHz(beats: number, bpm: number): number {
  const s = beatsToSeconds(beats, bpm);
  return s > 0 ? 1 / s : 0;
}

/** Number of samples in one beat (quarter note). */
export function samplesPerBeat(bpm: number, sampleRate: number): number {
  return (60 / bpm) * sampleRate;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Human-readable unit name for error messages. */
export function unitName(unit: Unit): string {
  switch (unit) {
    case 'hz':
      return 'frequency (Hz/kHz)';
    case 'db':
      return 'gain (dB)';
    case 'sec':
      return 'time (ms/s)';
    case 'musical':
      return 'musical time (1/16, 2bar, 1.5beat)';
    case 'cent':
      return 'cents (c)';
    case 'semitone':
      return 'semitones (st)';
    case 'ratio':
      return 'ratio (%)';
    case 'bare':
      return 'bare number';
    case 'ident':
      return 'name';
  }
}
