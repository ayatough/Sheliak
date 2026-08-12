// `loop` fence → Loop IR (SPEC.md §6 / §7, REQUIREMENTS §3.3).
//
//   ```loop id=demo bars=2 bpm=124
//   lead: C3 . Eb3 . | G3 ~ ~ . | Bb3 . . . | C4 ~ ~ ~
//   ```
//
//   `.` rest, `~` tie (extends the previous cell), `|` visual bar/beat marker
//   (ignored for timing), `[C3 Eb3 G3]` a chord inside one cell.
//
// Cells-per-beat is inferred: totalCells / (bars * 4).

import { ErrorSink, type DslError, type Pos } from './errors.ts';
import { samplesPerBeat } from './units.ts';

export interface LoopEvent {
  offsetSamples: number;
  /** Track index, 0..MAX_TRACKS-1 (the synth fence's order of appearance). */
  track: number;
  /** 0 = noteOn, 1 = noteOff */
  kind: 0 | 1;
  note: number;
  velocity: number;
}

export interface LoopIR {
  lengthSamples: number;
  events: LoopEvent[];
}

/** One `id: <cells>` line. Subdivision is inferred per line. */
export interface LoopLineMeta {
  trackId: string;
  track: number;
  cells: number;
  cellsPerBeat: number;
}

export interface LoopMeta {
  id: string;
  bars: number;
  bpm: number;
  lines: LoopLineMeta[];
}

export interface LoopParseOptions {
  bodyStartLine?: number;
  sampleRate: number;
  /**
   * Maps a loop line's `id:` to its track index (the synth fence order).
   * When omitted the lines are simply numbered in order of appearance, which
   * keeps `parseLoop` usable standalone.
   */
  trackIds?: Record<string, number>;
}

export interface LoopParseResult {
  loop: LoopIR | null;
  meta: LoopMeta | null;
  errors: DslError[];
}

/** MVP: single fixed velocity. */
export const DEFAULT_VELOCITY = 1.0;

const DEFAULT_BARS = 1;
const DEFAULT_BPM = 120;

interface Cell {
  /** MIDI notes; empty = rest, null = tie (extend previous). */
  notes: number[] | null;
  tie: boolean;
  pos: Pos;
}

export function parseLoop(
  body: string,
  attrs: Record<string, string> = {},
  opts: LoopParseOptions,
): LoopParseResult {
  const startLine = opts.bodyStartLine ?? 1;
  const sink = new ErrorSink();
  const fencePos: Pos = { line: startLine - 1, col: 1 };

  const bars = readPositive(attrs['bars'], DEFAULT_BARS, 'bars', fencePos, sink);
  const bpm = readPositive(attrs['bpm'], DEFAULT_BPM, 'bpm', fencePos, sink);
  const id = attrs['id'] ?? '';

  const raw = body.split(/\r\n|\r|\n/);
  const trackLines: { text: string; n: number }[] = [];
  for (let i = 0; i < raw.length; i++) {
    const text = (raw[i] ?? '').replace(/\s+#.*$/, '');
    if (text.trim() === '' || text.trim().startsWith('#')) continue;
    trackLines.push({ text, n: startLine + i });
  }

  if (trackLines.length === 0) {
    sink.push(fencePos, 'loop needs at least one track line, e.g. "lead: C3 . Eb3 ."');
    return { loop: null, meta: null, errors: sink.errors };
  }

  // Every line spans the same musical length, so the loop length comes from the
  // bar count — lines only differ in how finely they subdivide it.
  const spb = samplesPerBeat(bpm, opts.sampleRate);
  const beats = bars * 4;
  const lengthSamples = Math.round(beats * spb);

  const events: LoopEvent[] = [];
  const lineMetas: LoopLineMeta[] = [];
  const seenIds = new Set<string>();

  for (const line of trackLines) {
    const colon = line.text.indexOf(':');
    if (colon < 0) {
      sink.push({ line: line.n, col: 1 }, 'expected "trackId: <cells>"');
      continue;
    }
    const trackIdCol = line.text.length - line.text.trimStart().length + 1;
    const trackId = line.text.slice(0, colon).trim();
    const cellsSrc = line.text.slice(colon + 1);
    const cellsCol = colon + 2;

    // v0.3: a line binds to the synth fence with the same id.
    let track: number;
    if (opts.trackIds) {
      const resolved = opts.trackIds[trackId];
      if (resolved === undefined) {
        const known = Object.keys(opts.trackIds);
        sink.push(
          { line: line.n, col: trackIdCol },
          `unknown track "${trackId}" — no \`\`\`synth fence with that id` +
            (known.length ? ` (known: ${known.join(', ')})` : ''),
        );
        continue;
      }
      track = resolved;
    } else {
      // Standalone parse (tests/tools): number the lines in order.
      track = lineMetas.length;
    }

    if (seenIds.has(trackId)) {
      sink.push({ line: line.n, col: trackIdCol }, `duplicate loop line for track "${trackId}"`);
      continue;
    }
    seenIds.add(trackId);

    const cells = tokenizeCells(cellsSrc, line.n, cellsCol, sink);
    if (cells.length === 0) {
      sink.push({ line: line.n, col: cellsCol }, 'track has no cells');
      continue;
    }

    // Cells per beat is inferred per line: 16 cells over 1 bar = 16th notes.
    const cellsPerBeat = cells.length / beats;
    if (!Number.isInteger(cellsPerBeat) || cellsPerBeat < 1) {
      sink.push(
        { line: line.n, col: cellsCol },
        `cell count ${cells.length} is not divisible by bars*4 (${beats}) — cells per beat would be ${round(cellsPerBeat)}`,
      );
      continue;
    }

    lineMetas.push({ trackId, track, cells: cells.length, cellsPerBeat });
    emitLineEvents(cells, track, spb / cellsPerBeat, events, sink);
  }

  const meta: LoopMeta = { id, bars, bpm, lines: lineMetas };
  if (!sink.ok) return { loop: null, meta, errors: sink.errors };

  // noteOff before noteOn when they land on the same sample.
  events.sort(
    (a, b) => a.offsetSamples - b.offsetSamples || b.kind - a.kind || a.track - b.track || a.note - b.note,
  );

  return { loop: { lengthSamples, events }, meta, errors: [] };
}

/** Turn one line's cells into note events (ties extend, rests close a run). */
function emitLineEvents(
  cells: Cell[],
  track: number,
  cellSamples: number,
  out: LoopEvent[],
  sink: ErrorSink,
): void {
  let runNotes: number[] | null = null;
  let runStart = 0;

  const closeRun = (endCell: number) => {
    if (!runNotes) return;
    const off = Math.max(Math.round(endCell * cellSamples) - 1, Math.round(runStart * cellSamples));
    for (const note of runNotes) {
      out.push({ offsetSamples: off, track, kind: 1, note, velocity: 0 });
    }
    runNotes = null;
  };

  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i] as Cell;
    if (cell.tie) {
      if (!runNotes) sink.push(cell.pos, 'tie "~" has no preceding note');
      continue;
    }
    // rest or new note: the previous run ends here
    closeRun(i);
    if (cell.notes && cell.notes.length > 0) {
      runStart = i;
      runNotes = cell.notes;
      const on = Math.round(i * cellSamples);
      for (const note of cell.notes) {
        out.push({ offsetSamples: on, track, kind: 0, note, velocity: DEFAULT_VELOCITY });
      }
    }
  }
  closeRun(cells.length);
}

// ------------------------------------------------------------------ tokenizer

function tokenizeCells(src: string, line: number, colBase: number, sink: ErrorSink): Cell[] {
  const cells: Cell[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i] as string;
    if (/\s/.test(ch) || ch === '|') {
      i++;
      continue;
    }
    const pos: Pos = { line, col: colBase + i };

    if (ch === '[') {
      const end = src.indexOf(']', i);
      if (end < 0) {
        sink.push(pos, 'unterminated chord "["');
        break;
      }
      const inner = src.slice(i + 1, end).trim();
      const notes: number[] = [];
      for (const tok of inner.split(/\s+/).filter((t) => t !== '')) {
        const n = noteToMidi(tok);
        if (n === null) {
          sink.push({ line, col: colBase + i + 1 + inner.indexOf(tok) }, `invalid note "${tok}"`);
        } else {
          notes.push(n);
        }
      }
      if (notes.length === 0) sink.push(pos, 'empty chord "[]"');
      cells.push({ notes, tie: false, pos });
      i = end + 1;
      continue;
    }

    let j = i;
    while (j < src.length && !/\s/.test(src[j] as string) && src[j] !== '|' && src[j] !== '[') j++;
    const tok = src.slice(i, j);
    i = j;

    if (tok === '.') {
      cells.push({ notes: [], tie: false, pos });
      continue;
    }
    if (tok === '~') {
      cells.push({ notes: null, tie: true, pos });
      continue;
    }
    const n = noteToMidi(tok);
    if (n === null) {
      sink.push(pos, `invalid note "${tok}" (expected a note like C3, Eb3, F#4, or "." / "~")`);
      cells.push({ notes: [], tie: false, pos });
      continue;
    }
    cells.push({ notes: [n], tie: false, pos });
  }
  return cells;
}

const PITCH_CLASS: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
const NOTE_RE = /^([A-Ga-g])([#b]*)(-1|\d)$/;

/** Note name → MIDI number (C4 = 60). Returns null when malformed/out of range. */
export function noteToMidi(name: string): number | null {
  const m = NOTE_RE.exec(name);
  if (!m) return null;
  const pc = PITCH_CLASS[(m[1] as string).toLowerCase()];
  if (pc === undefined) return null;
  let accidental = 0;
  for (const c of m[2] as string) accidental += c === '#' ? 1 : -1;
  const octave = parseInt(m[3] as string, 10);
  const midi = (octave + 1) * 12 + pc + accidental;
  if (midi < 0 || midi > 127) return null;
  return midi;
}

// -------------------------------------------------------------------- helpers

function readPositive(raw: string | undefined, fallback: number, field: string, pos: Pos, sink: ErrorSink): number {
  if (raw === undefined) return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) {
    sink.push(pos, `${field} must be a positive number, got "${raw}"`);
    return fallback;
  }
  return v;
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}
