// Step-sequencer model: a pure projection of one `phrase` fence.
//
// parse → operate → render is a closed loop over TEXT. The grid never becomes a
// second source of truth: a gesture turns into one of the operations in
// `dsl/ops.ts`, the operation patches the document, and the document is
// re-parsed from scratch. Nothing in here holds state the markdown does not.

import { cellCoords, formatAddress, type Phrase, type PhraseNote, type PhraseRow } from '../dsl/phrase.ts';
import { canonicalTags } from '../dsl/phrase.ts';
import type { Op } from '../dsl/ops.ts';

export type CellKind = 'rest' | 'onset' | 'hold';

export interface SeqCell {
  kind: CellKind;
  /** Canonical group tag of the note sounding here; empty for a rest. */
  tag: string;
  /** Index into `SeqGrid.notes`, or -1. */
  note: number;
}

export interface SeqRow {
  label: string;
  midi: number;
  cells: SeqCell[];
}

export interface SeqGrid {
  trackId: string;
  phraseId: string;
  bars: number;
  cellsPerBeat: number;
  totalCells: number;
  rows: SeqRow[];
  notes: PhraseNote[];
}

/** Read a phrase as a grid of rows and cells, in canonical (pitch) order. */
export function projectPhrase(phrase: Phrase, trackId: string): SeqGrid {
  const tags = canonicalTags(phrase.notes);
  const rows: SeqRow[] = phrase.rows.map((row: PhraseRow) => ({
    label: row.label,
    midi: row.midi,
    cells: Array.from({ length: phrase.totalCells }, () => ({ kind: 'rest', tag: '', note: -1 }) as SeqCell),
  }));

  phrase.notes.forEach((note, i) => {
    const row = rows[note.row];
    if (!row) return;
    for (let k = 0; k < note.length && note.onset + k < phrase.totalCells; k++) {
      row.cells[note.onset + k] = {
        kind: k === 0 ? 'onset' : 'hold',
        tag: tags[i] as string,
        note: i,
      };
    }
  });

  return {
    trackId,
    phraseId: phrase.id,
    bars: phrase.bars,
    cellsPerBeat: phrase.cellsPerBeat,
    totalCells: phrase.totalCells,
    rows,
    notes: phrase.notes,
  };
}

/** The note sounding at a cell, or null. */
export function noteAt(grid: SeqGrid, row: number, cell: number): PhraseNote | null {
  const at = grid.rows[row]?.cells[cell];
  if (!at || at.note < 0) return null;
  return grid.notes[at.note] ?? null;
}

/** A full-specificity address for one note: bar.beat.tick plus its row. */
export function addressOf(phrase: Phrase, note: PhraseNote): string {
  const at = cellCoords(phrase, note.onset);
  return formatAddress({
    bar: at.bar,
    beat: at.beat,
    tick: at.tick,
    group: null,
    row: (phrase.rows[note.row] as PhraseRow).label,
  });
}

// -------------------------------------------------------------------- gestures
//
// Every gesture is a function from a cell to an operation. Returning null means
// "nothing to do" — the caller leaves the document alone rather than writing an
// identical one.

/** Tap: an empty cell gains a note, a sounding one loses it. */
export function tapOp(phrase: Phrase, grid: SeqGrid, row: number, cell: number, length = 1): Op | null {
  const note = noteAt(grid, row, cell);
  if (note) return { kind: 'note.remove', address: addressOf(phrase, note) };
  const label = grid.rows[row]?.label;
  if (label === undefined) return null;
  return { kind: 'note.add', row: label, onset: cell, length };
}

/** Vertical drag: move the note `steps` rows up (negative = down the list). */
export function movePitchOp(phrase: Phrase, grid: SeqGrid, row: number, cell: number, steps: number): Op | null {
  const note = noteAt(grid, row, cell);
  if (!note || steps === 0) return null;
  const target = grid.rows[clamp(row - steps, 0, grid.rows.length - 1)];
  if (!target || target.label === grid.rows[row]?.label) return null;
  return { kind: 'note.movePitch', address: addressOf(phrase, note), row: target.label };
}

/** Horizontal drag on a note's tail: change how many cells it holds. */
export function resizeOp(phrase: Phrase, grid: SeqGrid, row: number, cell: number, cells: number): Op | null {
  const note = noteAt(grid, row, cell);
  if (!note) return null;
  const length = clamp(cells, 1, grid.totalCells - note.onset);
  if (length === note.length) return null;
  return { kind: 'note.resize', address: addressOf(phrase, note), length };
}

/** Two notes at one onset become a chord; a chord member can leave it. */
export function groupOp(phrase: Phrase, grid: SeqGrid, row: number, cell: number): Op | null {
  const note = noteAt(grid, row, cell);
  if (!note) return null;
  const address = addressOf(phrase, note);
  const together = phrase.notes.filter((n) => n.onset === note.onset);
  if (together.length < 2) return null;
  const shared = together.filter((n) => n.tag === note.tag);
  if (shared.length > 1) return { kind: 'group.detach', address };
  return { kind: 'group.merge', addresses: together.map((n) => addressOf(phrase, n)) };
}

/** Set one gesture on the note under the cursor. */
export function velocityOp(phrase: Phrase, grid: SeqGrid, row: number, cell: number, vel: number): Op | null {
  const note = noteAt(grid, row, cell);
  if (!note) return null;
  return { kind: 'detail.set', address: addressOf(phrase, note), key: 'vel', value: clamp(vel, 0, 1) };
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
