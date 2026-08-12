// Canonical text formatting for values written back into the markdown.
//
// GUI edits reformat exactly the one token they touch, so the spelling has to
// be stable and compact — scrubbing a slider back and forth must not grow the
// document with noise like "800.0000001Hz".

/** Trim float noise and a trailing ".0", keeping at most `digits` decimals. */
function trim(v: number, digits: number): string {
  const s = v.toFixed(digits);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

/** Frequencies: Hz below 1k, kHz with at most 2 decimals above. */
export function formatHz(hz: number): string {
  if (Math.abs(hz) >= 1000) return `${trim(hz / 1000, 2)}kHz`;
  return `${trim(hz, 2)}Hz`;
}

/** Times: ms below one second, s above. */
export function formatSeconds(s: number): string {
  if (Math.abs(s) >= 1) return `${trim(s, 3)}s`;
  return `${trim(s * 1000, 2)}ms`;
}

/** Gains: at most one decimal, with an explicit sign only when negative. */
export function formatDb(db: number): string {
  return `${trim(db, 1)}dB`;
}

/** 0..1 ratios are written as whole percentages. */
export function formatRatio(v: number): string {
  return `${Math.round(v * 100)}%`;
}

export function formatCents(c: number): string {
  return `${trim(c, 1)}c`;
}

export function formatSemitones(st: number): string {
  return `${trim(st, 2)}st`;
}

export function formatInt(v: number): string {
  return String(Math.round(v));
}

export function formatBool(v: boolean): string {
  return v ? 'on' : 'off';
}

export type UnitFamily = 'db' | 'hz' | 'sec' | 'ratio' | 'cent' | 'semitone' | 'int' | 'enum' | 'bool';

/** Format a value for a field of the given unit family. */
export function formatFor(unit: UnitFamily, value: number | string | boolean): string {
  switch (unit) {
    case 'db':
      return formatDb(Number(value));
    case 'hz':
      return formatHz(Number(value));
    case 'sec':
      return formatSeconds(Number(value));
    case 'ratio':
      return formatRatio(Number(value));
    case 'cent':
      return formatCents(Number(value));
    case 'semitone':
      return formatSemitones(Number(value));
    case 'int':
      return formatInt(Number(value));
    case 'bool':
      return formatBool(Boolean(value));
    case 'enum':
      return String(value);
  }
}

const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

/** MIDI number → note name (C4 = 60). `preferFlat` keeps Eb3 from becoming D#3. */
export function formatNote(midi: number, preferFlat = false): string {
  const n = Math.max(0, Math.min(127, Math.round(midi)));
  const pc = ((n % 12) + 12) % 12;
  const octave = Math.floor(n / 12) - 1;
  return `${(preferFlat ? FLAT : SHARP)[pc]}${octave}`;
}
