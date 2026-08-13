// `phrase` fence → the note layer (docs/workstreams.md §2-§5, docs/syntax.md).
//
//   ```phrase id=verse-lead key=C scale=minor res=1/16 bars=1
//   grid:
//     #     1...2...3...4...
//     5'   |a---....o---....|
//     b3'  |a---............|
//     1    |b-------....o---|
//
//   detail:
//     1.1a   : { roll: +12ms }
//     1.1:1  : { vel: 90% }
//   ```
//
// The grid carries structure only: which pitch sounds when, for how long, and
// which notes belong to one group. Everything expressive — velocity, timing,
// length, glissando — lives in the detail block, addressed by coordinate, so a
// column of the grid always stays one character wide.

import { ErrorSink, type DslError, type Pos } from './errors.ts';
import { parseInlineValue, isMap, isScalar, type YMap, type YNode } from './yamlite.ts';
import { parseScalar, unitName } from './units.ts';
import {
  keyToPitchClass,
  labelNamespace,
  midiToLabel,
  resolveRowLabel,
  SCALES,
  type RowNamespace,
} from './pitch.ts';

// ---------------------------------------------------------------------- model

export interface PhraseRow {
  /** The label exactly as written — addresses name this, not the pitch. */
  label: string;
  namespace: RowNamespace;
  /** Resolved MIDI note. */
  midi: number;
  /** Document line of the row. */
  line: number;
  /** 1-based column of the first character of the label. */
  labelCol: number;
  /** One glyph per cell: `.`, `-`, or a group tag `a`-`z`. */
  cells: string[];
}

export interface PhraseNote {
  /** Index into `Phrase.rows`. */
  row: number;
  /** Cell index of the onset. */
  onset: number;
  /** Length in cells, including the onset cell. */
  length: number;
  /** Group tag, `a`-`z`. Notes sharing an onset *and* a tag are one group. */
  tag: string;
}

export type GlissTarget =
  | { kind: 'row'; label: string }
  | { kind: 'interval'; semitones: number };

export interface GlissSpec {
  to: GlissTarget;
  /** Slide length in cells; null = "to the next onset". */
  cells: number | null;
  curve: 'linear' | 'exp';
}

/** One expression entry. Keys are kept in written order for canonical output. */
export interface Gestures {
  /** 0..1 */
  vel?: number;
  /** Seconds, may be negative. */
  nudge?: number;
  /** Fraction of the written length. */
  gate?: number;
  /** Seconds between group members. */
  roll?: number;
  gliss?: GlissSpec;
}

export const GESTURE_KEYS = ['vel', 'nudge', 'gate', 'roll', 'gliss'] as const;
export type GestureKey = (typeof GESTURE_KEYS)[number];

export interface Address {
  /** null = `*` (every bar). 1-based. */
  bar: number | null;
  beat: number | null;
  tick: number | null;
  group: string | null;
  /** A row label as written. */
  row: string | null;
  /** Number of constraints — higher wins in the cascade (§5). */
  specificity: number;
  /** Canonical text of the address. */
  text: string;
}

export interface DetailEntry {
  address: Address;
  gestures: Gestures;
  /** Document line of the entry. */
  line: number;
  /** 1-based column of the first character of the address. */
  col: number;
}

export interface Phrase {
  id: string;
  key: string;
  scale: string;
  res: string;
  bars: number;
  /** Cells per beat, from `res`. */
  cellsPerBeat: number;
  /** bars × 4 × cellsPerBeat. */
  totalCells: number;
  /** The one namespace every row is in. */
  namespace: RowNamespace;
  rows: PhraseRow[];
  notes: PhraseNote[];
  detail: DetailEntry[];
  /** Document column of each cell index — identical on every row. */
  cellCols: number[];
  /** Document columns of the interior bar lines. */
  barCols: number[];
  /** Document line of the `grid:` key, or null when the fence had none. */
  gridLine: number | null;
  /** Document line of the `detail:` key, or null when absent. */
  detailLine: number | null;
  /** Document line of the fence's first body line. */
  bodyStartLine: number;
}

export interface PhraseParseOptions {
  bodyStartLine?: number;
}

export interface PhraseParseResult {
  phrase: Phrase | null;
  errors: DslError[];
}

export const DEFAULT_KEY = 'C';
export const DEFAULT_SCALE = 'major';
export const DEFAULT_RES = '1/16';
export const DEFAULT_BARS = 1;
/** Velocity when no `vel` gesture applies. */
export const DEFAULT_VELOCITY = 1.0;

const CELL_RE = /^[.\-a-z]$/;

// --------------------------------------------------------------------- parsing

export function parsePhrase(
  body: string,
  attrs: Record<string, string> = {},
  opts: PhraseParseOptions = {},
): PhraseParseResult {
  const startLine = opts.bodyStartLine ?? 1;
  const sink = new ErrorSink();
  const fencePos: Pos = { line: startLine - 1, col: 1 };

  const id = attrs['id'] ?? '';
  if (id === '') sink.push(fencePos, 'phrase needs an id, e.g. ```phrase id=verse-lead');

  const key = attrs['key'] ?? DEFAULT_KEY;
  const tonic = keyToPitchClass(key);
  if (tonic === null) sink.push(fencePos, `key must be a pitch class like C, Eb or F#, got "${key}"`);

  const scale = attrs['scale'] ?? DEFAULT_SCALE;
  if (!SCALES[scale]) {
    sink.push(fencePos, `unknown scale "${scale}" (${Object.keys(SCALES).join(', ')})`);
  }

  const res = attrs['res'] ?? DEFAULT_RES;
  const cellsPerBeat = resToCellsPerBeat(res);
  if (cellsPerBeat === null) {
    sink.push(fencePos, `res must be a fraction of a whole note such as 1/16, got "${res}"`);
  }

  const bars = readPositiveInt(attrs['bars'], DEFAULT_BARS, 'bars', fencePos, sink);
  const cpb = cellsPerBeat ?? 4;
  const totalCells = bars * 4 * cpb;

  // ------------------------------------------------------------- sectioning
  const lines = body.split(/\r\n|\r|\n/);
  let section: 'none' | 'grid' | 'detail' = 'none';
  let gridLine: number | null = null;
  let detailLine: number | null = null;
  const gridLines: { text: string; n: number }[] = [];
  const detailLines: { text: string; n: number }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i] ?? '';
    const n = startLine + i;
    const trimmed = text.trim();
    if (trimmed === '') continue;
    if (trimmed.startsWith('#')) continue; // the ruler, and any other comment
    if (trimmed === 'grid:') {
      section = 'grid';
      gridLine = n;
      continue;
    }
    if (trimmed === 'detail:') {
      section = 'detail';
      detailLine = n;
      continue;
    }
    if (section === 'none') {
      sink.push({ line: n, col: indentOf(text) + 1 }, 'expected "grid:" before the rows');
      section = 'grid';
    }
    (section === 'grid' ? gridLines : detailLines).push({ text, n });
  }

  if (gridLines.length === 0) {
    sink.push(fencePos, 'phrase needs a grid: block with at least one row');
    return { phrase: null, errors: sink.errors };
  }

  // ------------------------------------------------------------------- rows
  const ctx = { tonic: tonic ?? 0, scale: SCALES[scale] ? scale : DEFAULT_SCALE };
  const rows: PhraseRow[] = [];
  const seenLabels = new Set<string>();
  let geometry: RowLine | null = null;
  let pipeCols: number[] | null = null;
  let pipeRow = 0;

  for (const line of gridLines) {
    const parsed = parseRowLine(line.text, line.n, sink);
    if (!parsed) continue;

    if (pipeCols === null) {
      pipeCols = parsed.pipeCols;
      pipeRow = line.n;
      geometry = parsed;
    } else if (!sameCols(pipeCols, parsed.pipeCols)) {
      sink.push(
        { line: line.n, col: parsed.pipeCols[0] ?? 1 },
        `bar lines must fall in the same column on every row (row on line ${pipeRow} has them at ${pipeCols.join(', ')})`,
      );
      continue;
    }

    if (seenLabels.has(parsed.label)) {
      sink.push({ line: line.n, col: parsed.labelCol }, `duplicate row label "${parsed.label}"`);
      continue;
    }
    seenLabels.add(parsed.label);

    const resolved = resolveRowLabel(parsed.label, ctx);
    if (!resolved.ok) {
      sink.push({ line: line.n, col: parsed.labelCol }, resolved.reason);
      continue;
    }
    const ns = labelNamespace(parsed.label) as RowNamespace;

    if (parsed.cells.length !== totalCells) {
      sink.push(
        { line: line.n, col: parsed.cellCols[0] ?? parsed.labelCol },
        `row "${parsed.label}" has ${parsed.cells.length} cells, expected ${totalCells} (bars ${bars} × 4 × ${cpb} per beat)`,
      );
      continue;
    }

    rows.push({
      label: parsed.label,
      namespace: ns,
      midi: resolved.midi,
      line: line.n,
      labelCol: parsed.labelCol,
      cells: parsed.cells,
    });
  }

  if (rows.length === 0) {
    sink.push(fencePos, 'phrase has no usable rows');
    return { phrase: null, errors: sink.errors };
  }

  const namespace = (rows[0] as PhraseRow).namespace;
  for (const row of rows) {
    if (row.namespace !== namespace) {
      sink.push(
        { line: row.line, col: row.labelCol },
        `row "${row.label}" is a ${row.namespace} row but this phrase is in the ${namespace} namespace — a phrase may not mix them`,
      );
    }
  }

  // Cell geometry is shared: every row was checked against the first one.
  const cellCols = geometry ? geometry.cellCols : [];
  const barCols = geometry ? geometry.pipeCols.slice(1, -1) : [];

  // ------------------------------------------------------------------ notes
  const notes = collectNotes(rows, cellCols, sink);

  // ----------------------------------------------------------------- detail
  const detail = parseDetail(detailLines, sink);

  const phrase: Phrase = {
    id,
    key,
    scale,
    res,
    bars,
    cellsPerBeat: cpb,
    totalCells,
    namespace,
    rows,
    notes,
    detail,
    cellCols,
    barCols,
    gridLine,
    detailLine,
    bodyStartLine: startLine,
  };

  validateDetail(phrase, sink);

  if (!sink.ok) return { phrase: null, errors: sink.errors };
  return { phrase, errors: [] };
}

interface RowLine {
  label: string;
  labelCol: number;
  cells: string[];
  /** Document columns of every `|`, opening and closing included. */
  pipeCols: number[];
  cellCols: number[];
}

/** `  5'   |a---....o---....|` → label, cells and their columns. */
function parseRowLine(text: string, line: number, sink: ErrorSink): RowLine | null {
  const indent = indentOf(text);
  const body = text.replace(/\s+$/, '');
  const open = body.indexOf('|');
  if (open < 0) {
    sink.push({ line, col: indent + 1 }, 'expected a row like `5\'   |a---....o---....|`');
    return null;
  }
  const label = body.slice(indent, open).trim();
  if (label === '') {
    sink.push({ line, col: indent + 1 }, 'row has no label');
    return null;
  }
  if (/\s/.test(label)) {
    sink.push({ line, col: indent + 1 }, `row label "${label}" may not contain spaces`);
    return null;
  }
  if (!body.endsWith('|')) {
    sink.push({ line, col: body.length + 1 }, 'the cell run must close with "|"');
    return null;
  }

  const cells: string[] = [];
  const cellCols: number[] = [];
  const pipeCols: number[] = [];
  for (let i = open; i < body.length; i++) {
    const ch = body[i] as string;
    const col = i + 1;
    if (ch === '|') {
      pipeCols.push(col);
      continue;
    }
    if (!CELL_RE.test(ch)) {
      sink.push({ line, col }, `"${ch}" is not a cell — use "." rest, "-" hold, or a letter onset`);
      return null;
    }
    cells.push(ch);
    cellCols.push(col);
  }

  return { label, labelCol: indent + 1, cells, pipeCols, cellCols };
}

function collectNotes(rows: PhraseRow[], cellCols: number[], sink: ErrorSink): PhraseNote[] {
  const notes: PhraseNote[] = [];
  rows.forEach((row, r) => {
    let i = 0;
    while (i < row.cells.length) {
      const glyph = row.cells[i] as string;
      if (glyph === '.') {
        i++;
        continue;
      }
      if (glyph === '-') {
        sink.push(
          { line: row.line, col: cellCols[i] ?? row.labelCol },
          `"-" holds the note before it, but row "${row.label}" has none here`,
        );
        i++;
        continue;
      }
      let length = 1;
      while (i + length < row.cells.length && row.cells[i + length] === '-') length++;
      notes.push({ row: r, onset: i, length, tag: glyph });
      i += length;
    }
  });
  // Onset order first, then top row down — the order the formatter tags in.
  notes.sort((a, b) => a.onset - b.onset || a.row - b.row);
  return notes;
}

// --------------------------------------------------------------------- detail

function parseDetail(lines: { text: string; n: number }[], sink: ErrorSink): DetailEntry[] {
  const out: DetailEntry[] = [];
  for (const line of lines) {
    const indent = indentOf(line.text);
    const brace = line.text.indexOf('{');
    if (brace < 0) {
      sink.push({ line: line.n, col: indent + 1 }, 'expected `<address> : { vel: 90% }`');
      continue;
    }
    const head = line.text.slice(0, brace).replace(/\s+$/, '');
    if (!head.endsWith(':')) {
      sink.push({ line: line.n, col: indent + 1 }, 'expected ":" between the address and the { ... } map');
      continue;
    }
    const addrText = head.slice(indent, head.length - 1).trim();
    const addrPos: Pos = { line: line.n, col: indent + 1 };
    const address = parseAddress(addrText, addrPos, sink);
    if (!address) continue;

    const value = parseInlineValue(line.text.slice(brace), { line: line.n, col: brace + 1 }, sink.errors);
    if (!isMap(value)) {
      sink.push({ line: line.n, col: brace + 1 }, 'expected a { ... } map of gestures');
      continue;
    }
    const gestures = parseGestures(value, sink);
    out.push({ address, gestures, line: line.n, col: indent + 1 });
  }
  return out;
}

const ADDRESS_RE = /^(\*|\d+(?:\.\d+){0,2})([a-z])?$/;

/** `1.1a`, `1.1:b3'`, `*:1`, `1.3.2` → an Address, or null when malformed. */
export function parseAddress(text: string, pos: Pos, sink: ErrorSink): Address | null {
  const colon = text.indexOf(':');
  const timePart = colon < 0 ? text : text.slice(0, colon);
  const rowPart = colon < 0 ? null : text.slice(colon + 1).trim();
  if (rowPart !== null && rowPart === '') {
    sink.push(pos, `address "${text}" has no row after ":"`);
    return null;
  }

  const m = ADDRESS_RE.exec(timePart.trim());
  if (!m) {
    sink.push(pos, `malformed address "${text}" — expected <bar[.beat[.tick]] | *>[group][:row]`);
    return null;
  }
  const time = m[1] as string;
  const group = m[2] ?? null;

  let bar: number | null = null;
  let beat: number | null = null;
  let tick: number | null = null;
  let depth = 0;
  if (time !== '*') {
    const parts = time.split('.').map((p) => parseInt(p, 10));
    depth = parts.length;
    bar = parts[0] as number;
    if (parts.length > 1) beat = parts[1] as number;
    if (parts.length > 2) tick = parts[2] as number;
    if ([bar, beat, tick].some((v) => v !== null && v < 1)) {
      sink.push(pos, `address "${text}" — bars, beats and ticks are 1-based`);
      return null;
    }
  }

  const specificity = depth + (group ? 1 : 0) + (rowPart ? 1 : 0);
  return { bar, beat, tick, group, row: rowPart, specificity, text: formatAddress({ bar, beat, tick, group, row: rowPart }) };
}

/** Canonical spelling of an address. */
export function formatAddress(a: {
  bar: number | null;
  beat: number | null;
  tick: number | null;
  group: string | null;
  row: string | null;
}): string {
  let time = '*';
  if (a.bar !== null) {
    time = String(a.bar);
    if (a.beat !== null) time += `.${a.beat}`;
    if (a.tick !== null) time += `.${a.tick}`;
  }
  return `${time}${a.group ?? ''}${a.row ? `:${a.row}` : ''}`;
}

function parseGestures(map: YMap, sink: ErrorSink): Gestures {
  const out: Record<string, unknown> = {};
  for (const entry of map.entries) {
    const pos: Pos = entry.keyPos;
    switch (entry.key) {
      case 'vel': {
        const v = ratio(entry.value, 'vel', sink);
        if (v !== null) out['vel'] = v;
        break;
      }
      case 'gate': {
        const v = ratio(entry.value, 'gate', sink);
        if (v !== null) out['gate'] = v;
        break;
      }
      case 'nudge': {
        const v = seconds(entry.value, 'nudge', sink);
        if (v !== null) out['nudge'] = v;
        break;
      }
      case 'roll': {
        const v = seconds(entry.value, 'roll', sink);
        if (v !== null) out['roll'] = v;
        break;
      }
      case 'gliss': {
        const v = parseGliss(entry.value, sink);
        if (v) out['gliss'] = v;
        break;
      }
      default:
        sink.push(pos, `unknown gesture "${entry.key}" (${GESTURE_KEYS.join(', ')})`);
    }
  }
  return out as Gestures;
}

function parseGliss(node: YNode, sink: ErrorSink): GlissSpec | null {
  if (!isMap(node)) {
    sink.push({ line: node.line, col: node.col }, 'gliss takes a map: { to: +5st, cells: 3 }');
    return null;
  }
  let to: GlissTarget | null = null;
  let cells: number | null = null;
  let curve: 'linear' | 'exp' = 'linear';

  for (const entry of node.entries) {
    switch (entry.key) {
      case 'to': {
        if (!isScalar(entry.value)) {
          sink.push(entry.keyPos, 'gliss.to takes a row label or an interval such as +5st');
          break;
        }
        const raw = entry.value.value.trim();
        const scalar = parseScalar(raw, entry.value);
        if (scalar.unit === 'semitone') {
          to = { kind: 'interval', semitones: scalar.value };
        } else if (scalar.unit === 'cent') {
          to = { kind: 'interval', semitones: scalar.value / 100 };
        } else if (labelNamespace(raw)) {
          to = { kind: 'row', label: raw };
        } else {
          sink.push(entry.value, `gliss.to "${raw}" is neither a row label nor an interval (+5st)`);
        }
        break;
      }
      case 'cells': {
        if (!isScalar(entry.value)) {
          sink.push(entry.keyPos, 'gliss.cells takes a whole number of cells');
          break;
        }
        const scalar = parseScalar(entry.value.value, entry.value);
        // `cells` is the one field that is deliberately a bare number: it counts
        // grid columns, which have no unit of their own.
        if (scalar.unit !== 'bare' || !Number.isInteger(scalar.value) || scalar.value < 1) {
          sink.push(entry.value, `gliss.cells must be a whole number of cells, got "${entry.value.value}"`);
          break;
        }
        cells = scalar.value;
        break;
      }
      case 'curve': {
        const raw = isScalar(entry.value) ? entry.value.value.trim() : '';
        if (raw !== 'linear' && raw !== 'exp') {
          sink.push(entry.keyPos, `gliss.curve is linear or exp, got "${raw}"`);
          break;
        }
        curve = raw;
        break;
      }
      default:
        sink.push(entry.keyPos, `unknown gliss field "${entry.key}" (to, cells, curve)`);
    }
  }

  if (!to) {
    sink.push({ line: node.line, col: node.col }, 'gliss needs a `to:` target');
    return null;
  }
  return { to, cells, curve };
}

function ratio(node: YNode, field: string, sink: ErrorSink): number | null {
  if (!isScalar(node)) {
    sink.push({ line: node.line, col: node.col }, `${field} takes a percentage such as 90%`);
    return null;
  }
  const v = parseScalar(node.value, node);
  if (v.unit !== 'ratio') {
    sink.push(node, `${field} must be a percentage such as 90%, got ${unitName(v.unit)} "${node.value}"`);
    return null;
  }
  if (v.value < 0) {
    sink.push(node, `${field} must not be negative`);
    return null;
  }
  return v.value;
}

function seconds(node: YNode, field: string, sink: ErrorSink): number | null {
  if (!isScalar(node)) {
    sink.push({ line: node.line, col: node.col }, `${field} takes a time such as +12ms`);
    return null;
  }
  const v = parseScalar(node.value, node);
  if (v.unit !== 'sec') {
    sink.push(node, `${field} must be a time such as +12ms, got ${unitName(v.unit)} "${node.value}"`);
    return null;
  }
  return v.value;
}

/** Every address must name a note that exists, and `roll` must name a group. */
function validateDetail(phrase: Phrase, sink: ErrorSink): void {
  for (const entry of phrase.detail) {
    const matched = phrase.notes.filter((n) => matchesAddress(phrase, n, entry.address));
    if (matched.length === 0) {
      sink.push(
        { line: entry.line, col: entry.col },
        `address "${entry.address.text}" names no note in this phrase`,
      );
      continue;
    }
    if (entry.gestures.roll !== undefined && entry.address.group === null) {
      sink.push(
        { line: entry.line, col: entry.col },
        'roll applies to a group — give the address a group tag, e.g. 1.1a',
      );
    }
  }
}

// -------------------------------------------------------------- address logic

/** Bar/beat/tick of a cell index, all 1-based. */
export function cellCoords(phrase: Phrase, cell: number): { bar: number; beat: number; tick: number } {
  const beatIndex = Math.floor(cell / phrase.cellsPerBeat);
  return {
    bar: Math.floor(beatIndex / 4) + 1,
    beat: (beatIndex % 4) + 1,
    tick: (cell % phrase.cellsPerBeat) + 1,
  };
}

export function matchesAddress(phrase: Phrase, note: PhraseNote, address: Address): boolean {
  const at = cellCoords(phrase, note.onset);
  if (address.bar !== null && address.bar !== at.bar) return false;
  if (address.beat !== null && address.beat !== at.beat) return false;
  if (address.tick !== null && address.tick !== at.tick) return false;
  if (address.group !== null && address.group !== note.tag) return false;
  if (address.row !== null && address.row !== (phrase.rows[note.row] as PhraseRow).label) return false;
  return true;
}

/**
 * The cascade (§5): per gesture key, the matching entry with the highest
 * specificity wins; ties go to the entry written later.
 */
export function resolveGestures(phrase: Phrase, note: PhraseNote): Gestures {
  const out: Record<string, unknown> = {};
  const best: Record<string, number> = {};
  phrase.detail.forEach((entry) => {
    if (!matchesAddress(phrase, note, entry.address)) return;
    for (const key of GESTURE_KEYS) {
      const value = entry.gestures[key];
      if (value === undefined) continue;
      const previous = best[key];
      if (previous !== undefined && entry.address.specificity < previous) continue;
      best[key] = entry.address.specificity;
      out[key] = value;
    }
  });
  return out as Gestures;
}

/** Which detail entry won each gesture, for the expanded view. */
export function resolveGestureSources(phrase: Phrase, note: PhraseNote): Record<string, string> {
  const out: Record<string, string> = {};
  const best: Record<string, number> = {};
  phrase.detail.forEach((entry) => {
    if (!matchesAddress(phrase, note, entry.address)) return;
    for (const key of GESTURE_KEYS) {
      if (entry.gestures[key] === undefined) continue;
      const previous = best[key];
      if (previous !== undefined && entry.address.specificity < previous) continue;
      best[key] = entry.address.specificity;
      out[key] = entry.address.text;
    }
  });
  return out;
}

/**
 * The expanded view (§5): for every note, the gesture values that actually
 * apply and which entry won them. Without it a cascade cannot be traced.
 */
export function phraseExpandedLines(phrase: Phrase): string[] {
  const tags = canonicalTags(phrase.notes);
  return phrase.notes.map((note, i) => {
    const row = phrase.rows[note.row] as PhraseRow;
    const at = cellCoords(phrase, note.onset);
    const g = resolveGestures(phrase, note);
    const from = resolveGestureSources(phrase, note);
    const parts: string[] = [
      `${at.bar}.${at.beat}.${at.tick}${tags[i] as string}:${row.label}`.padEnd(14),
      `${midiToLabel(row.midi)}`.padEnd(5),
      `${note.length}c`.padEnd(4),
      `vel ${Math.round((g.vel ?? DEFAULT_VELOCITY) * 100)}%${from['vel'] ? ` (${from['vel']})` : ''}`,
    ];
    if (g.nudge !== undefined) parts.push(`nudge ${Math.round(g.nudge * 1000)}ms (${from['nudge']})`);
    if (g.gate !== undefined) parts.push(`gate ${Math.round(g.gate * 100)}% (${from['gate']})`);
    if (g.roll !== undefined) parts.push(`roll ${Math.round(g.roll * 1000)}ms (${from['roll']})`);
    if (g.gliss !== undefined) {
      const to = g.gliss.to.kind === 'row' ? g.gliss.to.label : `${g.gliss.to.semitones}st`;
      parts.push(`gliss → ${to} (${from['gliss']})`);
    }
    return parts.join('  ');
  });
}

// ---------------------------------------------------------------- group logic

/** The notes of one group: same onset, same tag. Sorted top row down. */
export function groupMembers(phrase: Phrase, note: PhraseNote): PhraseNote[] {
  return phrase.notes.filter((n) => n.onset === note.onset && n.tag === note.tag).sort((a, b) => a.row - b.row);
}

/** Every distinct onset in the phrase, ascending. */
export function onsets(phrase: Phrase): number[] {
  return [...new Set(phrase.notes.map((n) => n.onset))].sort((a, b) => a - b);
}

/**
 * Canonical group tags (§3): one group at an onset is `o`, otherwise `a`, `b`,
 * `c` … assigned from the top row down. Returns tag by note identity index.
 */
export function canonicalTags(notes: PhraseNote[]): string[] {
  const tags = new Array<string>(notes.length).fill('o');
  const byOnset = new Map<number, number[]>();
  notes.forEach((n, i) => {
    const list = byOnset.get(n.onset);
    if (list) list.push(i);
    else byOnset.set(n.onset, [i]);
  });

  for (const indices of byOnset.values()) {
    const sorted = [...indices].sort((a, b) => (notes[a] as PhraseNote).row - (notes[b] as PhraseNote).row);
    const distinct: string[] = [];
    for (const i of sorted) {
      const tag = (notes[i] as PhraseNote).tag;
      if (!distinct.includes(tag)) distinct.push(tag);
    }
    if (distinct.length === 1) {
      for (const i of sorted) tags[i] = 'o';
      continue;
    }
    for (const i of sorted) {
      const rank = distinct.indexOf((notes[i] as PhraseNote).tag);
      tags[i] = String.fromCharCode(97 + rank);
    }
  }
  return tags;
}

/**
 * Canonical row order (§2): highest resolved pitch first. Percussion rows have
 * no natural order, so they keep the order they were written in.
 */
export function canonicalRowOrder(phrase: Phrase): number[] {
  const indices = phrase.rows.map((_, i) => i);
  if (phrase.namespace === 'percussion') return indices;
  return indices.sort(
    (a, b) => (phrase.rows[b] as PhraseRow).midi - (phrase.rows[a] as PhraseRow).midi || a - b,
  );
}

// -------------------------------------------------------------------- helpers

/** `1/16` → 4 cells per beat. Null when the fraction is not a grid. */
export function resToCellsPerBeat(res: string): number | null {
  const m = /^(\d+)\/(\d+)$/.exec(res.trim());
  if (!m) return null;
  const num = parseInt(m[1] as string, 10);
  const den = parseInt(m[2] as string, 10);
  if (num <= 0 || den <= 0) return null;
  const cells = den / (4 * num);
  return Number.isInteger(cells) && cells >= 1 ? cells : null;
}

/** Cells per beat → the `res` spelling. */
export function cellsPerBeatToRes(cells: number): string {
  return `1/${cells * 4}`;
}

function indentOf(text: string): number {
  return text.length - text.trimStart().length;
}

function sameCols(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function readPositiveInt(
  raw: string | undefined,
  fallback: number,
  field: string,
  pos: Pos,
  sink: ErrorSink,
): number {
  if (raw === undefined) return fallback;
  const v = Number(raw);
  if (!Number.isInteger(v) || v <= 0) {
    sink.push(pos, `${field} must be a positive whole number, got "${raw}"`);
    return fallback;
  }
  return v;
}
