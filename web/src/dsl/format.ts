// Canonical text formatting for values written back into the markdown.
//
// GUI edits reformat exactly the one token they touch, so the spelling has to
// be stable and compact — scrubbing a slider back and forth must not grow the
// document with noise like "800.0000001Hz". The phrase grid at the bottom of
// this file goes further: it is a whole-block canonicalization, so that one
// structure has exactly one spelling.

import type { DslError } from './errors.ts';
import {
  canonicalRowOrder,
  canonicalTags,
  formatAddress,
  matchesAddress,
  parsePhrase,
  DEFAULT_BARS,
  DEFAULT_KEY,
  DEFAULT_RES,
  DEFAULT_SCALE,
  type Gestures,
  type GlissSpec,
  type Phrase,
  type PhraseNote,
  type PhraseRow,
} from './phrase.ts';

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

// --------------------------------------------------------- phrase grid (§3)
//
// One structure has exactly one spelling. Row order, group tags, the beat ruler
// and the label alignment are all derived, never preserved, so
// `format(format(x)) == format(x)` — the property every operation in ops.ts
// relies on to be able to claim its result is canonical.

/** Two spaces of indent inside the fence, like the rest of the DSL. */
const GRID_INDENT = '  ';
/** Spaces between the padded row label and the opening `|`. */
const LABEL_GAP = 2;

/** Canonical `phrase` fence body: `grid:` block, then `detail:` when non-empty. */
export function formatPhrase(phrase: Phrase): string {
  const parts = formatPhraseParts(phrase);
  const out = [...parts.grid];
  if (parts.detail.length > 0) out.push('', 'detail:', ...parts.detail);
  return out.join('\n');
}

/**
 * The two blocks separately, because an edit rewrites at most one of them:
 * `grid` includes the `grid:` key and the ruler, `detail` is the entries only.
 */
export function formatPhraseParts(phrase: Phrase): { grid: string[]; detail: string[] } {
  const order = canonicalRowOrder(phrase);
  const position = new Map<number, number>();
  order.forEach((oldRow, newRow) => position.set(oldRow, newRow));

  const notes = phrase.notes
    .map((n) => ({ ...n, row: position.get(n.row) ?? n.row }))
    .sort((a, b) => a.onset - b.onset || a.row - b.row);
  const tags = canonicalTags(notes);

  // Paint the grid.
  const cells: string[][] = order.map(() => new Array<string>(phrase.totalCells).fill('.'));
  notes.forEach((note, i) => {
    const row = cells[note.row];
    if (!row) return;
    row[note.onset] = tags[i] as string;
    for (let k = 1; k < note.length && note.onset + k < phrase.totalCells; k++) row[note.onset + k] = '-';
  });

  const labels = order.map((oldRow) => (phrase.rows[oldRow] as PhraseRow).label);
  const width = Math.max(1, ...labels.map((l) => l.length));

  const out: string[] = ['grid:', `${GRID_INDENT}${ruler(phrase, width)}`];
  labels.forEach((label, i) => {
    const glyphs = cells[i] as string[];
    out.push(`${GRID_INDENT}${label.padEnd(width)}${' '.repeat(LABEL_GAP)}|${withBarLines(glyphs, phrase)}|`);
  });

  return { grid: out, detail: formatDetail(phrase, notes, tags, order) };
}

/**
 * Parse a fence body and render it canonically. The composition is the whole
 * of `format` as invariant 2 means it: `format(format(x)) == format(x)`.
 */
export function canonicalizePhrase(
  body: string,
  attrs: Record<string, string>,
  bodyStartLine = 1,
): { text: string | null; errors: DslError[] } {
  const r = parsePhrase(body, attrs, { bodyStartLine });
  return { text: r.phrase ? formatPhrase(r.phrase) : null, errors: r.errors };
}

/** `#     1...2...3...4...` — the beat ruler, aligned with the cells. */
function ruler(phrase: Phrase, labelWidth: number): string {
  const glyphs: string[] = [];
  for (let i = 0; i < phrase.totalCells; i++) {
    glyphs.push(i % phrase.cellsPerBeat === 0 ? String((Math.floor(i / phrase.cellsPerBeat) % 4) + 1) : '.');
  }
  // The `#` replaces the first label character; the rest of the label field and
  // the opening `|` become spaces so the digits sit over the first cell.
  return `#${' '.repeat(labelWidth - 1 + LABEL_GAP + 1)}${withBarLines(glyphs, phrase, ' ')}`;
}

/** Insert a bar line between bars; the ruler uses a space instead. */
function withBarLines(glyphs: string[], phrase: Phrase, separator = '|'): string {
  const perBar = phrase.cellsPerBeat * 4;
  let out = '';
  for (let i = 0; i < glyphs.length; i++) {
    if (i > 0 && i % perBar === 0) out += separator;
    out += glyphs[i] as string;
  }
  return out;
}

/**
 * Detail entries keep the order they were written in — the cascade breaks ties
 * by position, so reordering them would change what the phrase sounds like.
 * Only the alignment, the value spelling and group tags that canonicalization
 * moved are rewritten.
 */
function formatDetail(phrase: Phrase, notes: PhraseNote[], tags: string[], order: number[]): string[] {
  const rewritten: { address: string; body: string }[] = [];

  for (const entry of phrase.detail) {
    const body = gestureText(entry.gestures);
    if (body === null) continue; // an entry with no gesture left says nothing
    if (entry.address.group === null) {
      rewritten.push({ address: entry.address.text, body });
      continue;
    }
    // A group tag is positional, so canonicalization can rename it. Follow the
    // notes the address named; if they landed on several tags, the entry splits
    // into one entry per tag, which says exactly what the original said.
    const moved = new Set<string>();
    notes.forEach((note, i) => {
      // Addresses name rows as written, so match through the original index.
      const original = { ...note, row: order[note.row] ?? note.row };
      if (matchesAddress(phrase, original, entry.address)) moved.add(tags[i] as string);
    });
    const targets = moved.size === 0 ? [entry.address.group] : [...moved].sort();
    for (const tag of targets) {
      rewritten.push({ address: formatAddress({ ...entry.address, group: tag }), body });
    }
  }

  if (rewritten.length === 0) return [];
  const width = Math.max(...rewritten.map((e) => e.address.length));
  return rewritten.map((e) => `${GRID_INDENT}${e.address.padEnd(width)} : ${e.body}`);
}

/** `{ vel: 90%, gliss: { to: +5st, cells: 3 } }`, keys in a fixed order. */
export function gestureText(g: Gestures): string | null {
  const parts: string[] = [];
  if (g.vel !== undefined) parts.push(`vel: ${formatRatio(g.vel)}`);
  if (g.nudge !== undefined) parts.push(`nudge: ${formatSignedSeconds(g.nudge)}`);
  if (g.gate !== undefined) parts.push(`gate: ${formatRatio(g.gate)}`);
  if (g.roll !== undefined) parts.push(`roll: ${formatSignedSeconds(g.roll)}`);
  if (g.gliss !== undefined) parts.push(`gliss: ${glissText(g.gliss)}`);
  if (parts.length === 0) return null;
  return `{ ${parts.join(', ')} }`;
}

function glissText(gliss: GlissSpec): string {
  const parts: string[] = [
    `to: ${gliss.to.kind === 'row' ? gliss.to.label : formatSignedSemitones(gliss.to.semitones)}`,
  ];
  if (gliss.cells !== null) parts.push(`cells: ${gliss.cells}`);
  if (gliss.curve !== 'linear') parts.push(`curve: ${gliss.curve}`);
  return `{ ${parts.join(', ')} }`;
}

/** Timing offsets always carry their sign: `+12ms` reads as a direction. */
export function formatSignedSeconds(s: number): string {
  const body = formatSeconds(Math.abs(s));
  return `${s < 0 ? '-' : '+'}${body}`;
}

export function formatSignedSemitones(st: number): string {
  return `${st < 0 ? '' : '+'}${formatSemitones(st)}`;
}

/** Canonical info string for a phrase fence, defaults omitted. */
export function formatPhraseAttrs(phrase: Phrase): string {
  const parts = [`id=${phrase.id}`];
  if (phrase.key !== DEFAULT_KEY) parts.push(`key=${phrase.key}`);
  if (phrase.scale !== DEFAULT_SCALE) parts.push(`scale=${phrase.scale}`);
  if (phrase.res !== DEFAULT_RES) parts.push(`res=${phrase.res}`);
  if (phrase.bars !== DEFAULT_BARS) parts.push(`bars=${phrase.bars}`);
  return parts.join(' ');
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
