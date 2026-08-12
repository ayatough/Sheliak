// Step-sequencer model: a pure projection of one loop line.
//
// parse → edit → render is a closed loop over TEXT. The grid never becomes a
// second source of truth: every gesture regenerates that single line and the
// document is re-parsed from scratch.

import { tokenizeCells, noteToMidi, type Cell } from '../dsl/loop.ts';
import { ErrorSink } from '../dsl/errors.ts';
import { formatNote } from '../dsl/format.ts';

export type CellKind = 'rest' | 'note' | 'tie';

export interface GridCell {
  kind: CellKind;
  /** MIDI notes; length > 1 is a chord. Empty for rest/tie. */
  notes: number[];
  /** Original source token, reused verbatim while the notes are unchanged. */
  raw: string;
}

export interface GridLine {
  trackId: string;
  cells: GridCell[];
  /** Inferred from the cell count: cells / (bars * 4). */
  cellsPerBeat: number;
  bars: number;
}

export const DEFAULT_NOTE = noteToMidi('C3') ?? 48;

// ------------------------------------------------------------------- parsing

/** Parse `lead: C3 . Eb3 .` into a grid model. Returns null when unusable. */
export function parseGridLine(text: string, bars: number): GridLine | null {
  const colon = text.indexOf(':');
  if (colon < 0) return null;
  const trackId = text.slice(0, colon).trim();
  const sink = new ErrorSink();
  const cells = tokenizeCells(text.slice(colon + 1), 1, 1, sink);
  if (cells.length === 0) return null;

  const beats = Math.max(1, bars * 4);
  const cellsPerBeat = cells.length / beats;
  return {
    trackId,
    bars,
    cellsPerBeat: Number.isInteger(cellsPerBeat) && cellsPerBeat >= 1 ? cellsPerBeat : 0,
    cells: cells.map(toGridCell),
  };
}

function toGridCell(cell: Cell): GridCell {
  if (cell.tie) return { kind: 'tie', notes: [], raw: '~' };
  if (cell.notes && cell.notes.length > 0) return { kind: 'note', notes: [...cell.notes], raw: cell.raw };
  return { kind: 'rest', notes: [], raw: '.' };
}

// ----------------------------------------------------------------- rendering

/** Cell → token, preferring the original spelling when the notes are intact. */
export function cellText(cell: GridCell): string {
  if (cell.kind === 'rest') return '.';
  if (cell.kind === 'tie') return '~';
  if (cell.raw && sameNotes(parseRaw(cell.raw), cell.notes)) return cell.raw;
  const flat = cell.raw.includes('b');
  const names = cell.notes.map((n) => formatNote(n, flat));
  return names.length > 1 ? `[${names.join(' ')}]` : (names[0] ?? '.');
}

function parseRaw(raw: string): number[] {
  const inner = raw.startsWith('[') ? raw.slice(1, -1) : raw;
  const out: number[] = [];
  for (const tok of inner.split(/\s+/).filter(Boolean)) {
    const n = noteToMidi(tok);
    if (n === null) return [];
    out.push(n);
  }
  return out;
}

function sameNotes(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Regenerate the whole line, grouping cells per beat with `|` separators.
 * `pad` right-pads the `id:` prefix so stacked rows line up.
 */
export function renderGridLine(line: GridLine, pad = 0): string {
  const groups: string[] = [];
  const per = line.cellsPerBeat > 0 ? line.cellsPerBeat : line.cells.length;
  for (let i = 0; i < line.cells.length; i += per) {
    groups.push(
      line.cells
        .slice(i, i + per)
        .map((c) => cellText(c))
        .join(' '),
    );
  }
  const prefix = `${line.trackId}:`.padEnd(Math.max(pad, line.trackId.length + 1));
  return `${prefix} ${groups.join(' | ')}`;
}

/** A fresh all-rest line, used when a track has no loop line yet. */
export function emptyGridLine(trackId: string, bars: number, cellsPerBeat = 4): GridLine {
  const count = Math.max(1, bars * 4 * cellsPerBeat);
  return {
    trackId,
    bars,
    cellsPerBeat,
    cells: Array.from({ length: count }, () => ({ kind: 'rest', notes: [], raw: '.' }) as GridCell),
  };
}

// -------------------------------------------------------------------- edits
// All edits return a NEW line; the caller renders it and patches the document.

function clone(line: GridLine): GridLine {
  return { ...line, cells: line.cells.map((c) => ({ ...c, notes: [...c.notes] })) };
}

/** The most recent note (or chord) at or before `index`. */
export function noteBefore(line: GridLine, index: number): number[] | null {
  for (let i = Math.min(index, line.cells.length) - 1; i >= 0; i--) {
    const c = line.cells[i];
    if (c && c.kind === 'note') return c.notes;
  }
  return null;
}

/** First note anywhere on the line — the natural pitch for a one-pitch track. */
export function firstNote(line: GridLine): number[] | null {
  for (const c of line.cells) if (c.kind === 'note') return c.notes;
  return null;
}

/** Clear a cell to a rest, taking the tie chain that follows it with it. */
export function clearCell(line: GridLine, index: number): GridLine {
  const out = clone(line);
  const cell = out.cells[index];
  if (!cell) return out;
  cell.kind = 'rest';
  cell.notes = [];
  cell.raw = '.';
  for (let i = index + 1; i < out.cells.length; i++) {
    const next = out.cells[i];
    if (!next || next.kind !== 'tie') break;
    next.kind = 'rest';
    next.notes = [];
    next.raw = '.';
  }
  return out;
}

export function placeNote(line: GridLine, index: number, notes: number[]): GridLine {
  const out = clone(line);
  const cell = out.cells[index];
  if (!cell) return out;
  cell.kind = 'note';
  cell.notes = [...notes];
  cell.raw = '';
  return out;
}

/**
 * Tap behaviour: a rest becomes a note (last used pitch → line's first note →
 * C3), anything else clears. Single-pitch tracks therefore just toggle.
 */
export function toggleCell(line: GridLine, index: number, lastUsed?: number[] | null): GridLine {
  const cell = line.cells[index];
  if (!cell) return line;
  if (cell.kind === 'rest') {
    const notes = lastUsed?.length ? lastUsed : (noteBefore(line, index) ?? firstNote(line) ?? [DEFAULT_NOTE]);
    return placeNote(line, index, notes);
  }
  return clearCell(line, index);
}

/** Vertical drag: transpose a cell (chords move as a block). */
export function transposeCell(line: GridLine, index: number, semitones: number): GridLine {
  const cell = line.cells[index];
  if (!cell || cell.kind !== 'note' || semitones === 0) return line;
  const moved = cell.notes.map((n) => n + semitones);
  if (moved.some((n) => n < 0 || n > 127)) return line;
  const out = clone(line);
  const target = out.cells[index] as GridCell;
  target.notes = moved;
  // Keep the accidental style of the original spelling.
  target.raw = target.raw.includes('b') ? 'b' : '';
  return out;
}

/** Tie mode: extend the previous note through this cell. */
export function setTieCell(line: GridLine, index: number): GridLine {
  if (index <= 0) return line;
  if (!noteBefore(line, index)) return line; // nothing to extend
  const out = clone(line);
  const cell = out.cells[index];
  if (!cell) return out;
  cell.kind = 'tie';
  cell.notes = [];
  cell.raw = '~';
  return out;
}

export type ResampleResult = { ok: true; line: GridLine } | { ok: false; reason: string };

/**
 * Change a line's resolution (e.g. 1/8 ⇔ 1/16).
 * Up: each cell is padded with a tie (notes keep their duration) or a rest.
 * Down: only whole groups collapse, and only when no onset would be lost.
 */
export function resampleLine(line: GridLine, targetCellsPerBeat: number): ResampleResult {
  const from = line.cellsPerBeat;
  if (from <= 0) return { ok: false, reason: 'line resolution is unknown' };
  if (targetCellsPerBeat === from) return { ok: true, line };

  if (targetCellsPerBeat > from) {
    const factor = targetCellsPerBeat / from;
    if (!Number.isInteger(factor)) return { ok: false, reason: 'resolutions must be multiples of each other' };
    const cells: GridCell[] = [];
    for (const cell of line.cells) {
      cells.push({ ...cell, notes: [...cell.notes] });
      for (let k = 1; k < factor; k++) {
        // Sustain notes/ties, keep rests silent — durations stay identical.
        cells.push(
          cell.kind === 'rest'
            ? { kind: 'rest', notes: [], raw: '.' }
            : { kind: 'tie', notes: [], raw: '~' },
        );
      }
    }
    return { ok: true, line: { ...line, cells, cellsPerBeat: targetCellsPerBeat } };
  }

  const factor = from / targetCellsPerBeat;
  if (!Number.isInteger(factor)) return { ok: false, reason: 'resolutions must be multiples of each other' };
  for (let i = 0; i < line.cells.length; i++) {
    if (i % factor === 0) continue;
    if ((line.cells[i] as GridCell).kind === 'note') {
      return { ok: false, reason: `a note on step ${i + 1} would be lost — clear the off-grid notes first` };
    }
  }
  const cells = line.cells.filter((_, i) => i % factor === 0).map((c) => ({ ...c, notes: [...c.notes] }));
  return { ok: true, line: { ...line, cells, cellsPerBeat: targetCellsPerBeat } };
}
