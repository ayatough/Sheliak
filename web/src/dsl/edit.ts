// Surgical text edits driven by parser source positions.
//
// The markdown document is the single source of truth: every GUI gesture is
// translated into the smallest possible text patch, which then flows back
// through the normal compile → hot-reload path. Nothing outside the targeted
// token is ever touched — comments, alignment and unrelated fields survive
// byte-for-byte.
//
// All positions here are document-absolute (1-based line, 1-based column), the
// same coordinate space the parsers report, because yamlite is fed the fence's
// `bodyStartLine`.

import { extractFences, findFence, type Fence } from './fences.ts';
import { parseYamlite, isMap, isSeq, isScalar, type YMap, type YNode, type YScalar } from './yamlite.ts';
import { parsePhrase, type DetailEntry, type Phrase } from './phrase.ts';
import type { Pos } from './errors.ts';

export interface TextSpan {
  line: number;
  /** 1-based, inclusive. */
  col: number;
  /** 1-based, exclusive. */
  endCol: number;
}

export type EditResult = { ok: true; doc: string } | { ok: false; reason: string };

// --------------------------------------------------------------- primitives

/** Replace `[col, endCol)` on `line`, leaving every other byte untouched. */
export function replaceSpan(doc: string, span: TextSpan, newText: string): EditResult {
  const lines = doc.split('\n');
  const idx = span.line - 1;
  const line = lines[idx];
  if (line === undefined) return { ok: false, reason: `line ${span.line} is out of range` };
  if (span.col < 1 || span.endCol - 1 > line.length) {
    return { ok: false, reason: `span ${span.col}..${span.endCol} is out of range on line ${span.line}` };
  }
  lines[idx] = line.slice(0, span.col - 1) + newText + line.slice(span.endCol - 1);
  return { ok: true, doc: lines.join('\n') };
}

/** Insert text at a position without removing anything. */
export function insertAt(doc: string, pos: Pos, text: string): EditResult {
  return replaceSpan(doc, { line: pos.line, col: pos.col, endCol: pos.col }, text);
}

/** Replace one scalar token (the value of a field). */
export function replaceValue(doc: string, scalar: YScalar, newText: string): EditResult {
  return replaceSpan(doc, { line: scalar.line, col: scalar.col, endCol: scalar.endCol }, newText);
}

/**
 * Add `key: value` to a flow map, just before its closing brace.
 * Block maps are deliberately not supported — see `resolveField`.
 */
export function insertEntry(doc: string, map: YMap, key: string, valueText: string): EditResult {
  if (!map.flow || !map.close) return { ok: false, reason: 'can only insert into a { ... } map' };

  if (map.entries.length === 0) {
    // `{}` → `{ key: value }`
    return insertAt(doc, map.close, ` ${key}: ${valueText} `);
  }
  const last = map.entries[map.entries.length - 1];
  if (!last) return { ok: false, reason: 'empty map' };
  const end = nodeEnd(last.value);
  if (!end) return { ok: false, reason: 'cannot locate the end of the last entry' };
  return insertAt(doc, end, `, ${key}: ${valueText}`);
}

/** Exclusive end position of a node, when it is representable on one line. */
export function nodeEnd(node: YNode): Pos | null {
  if (isScalar(node)) return { line: node.line, col: node.endCol };
  if ((isMap(node) || isSeq(node)) && node.flow && node.close) {
    return { line: node.close.line, col: node.close.col + 1 };
  }
  return null;
}

// ------------------------------------------------------------ path resolving

export type FieldTarget =
  | { kind: 'replace'; scalar: YScalar }
  | { kind: 'insert'; map: YMap; key: string }
  | { kind: 'missing'; reason: string };

/**
 * Walk a path such as ['osc','0','level'] or ['env','amp','a'].
 * Returns where to write: an existing token, or the flow map that should gain
 * the key. A missing intermediate section is reported rather than synthesized —
 * creating whole sections is out of scope, the UI disables those controls.
 */
export function resolveField(root: YMap, path: string[]): FieldTarget {
  if (path.length === 0) return { kind: 'missing', reason: 'empty path' };

  let node: YNode = root;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i] as string;
    const next = step(node, seg);
    if (!next) {
      return { kind: 'missing', reason: `"${path.slice(0, i + 1).join('.')}" is not in the text` };
    }
    node = next;
  }

  const key = path[path.length - 1] as string;
  const target = step(node, key);
  if (target) {
    if (!isScalar(target)) return { kind: 'missing', reason: `"${path.join('.')}" is not a single value` };
    return { kind: 'replace', scalar: target };
  }
  if (isMap(node) && node.flow && node.close) return { kind: 'insert', map: node, key };
  return { kind: 'missing', reason: `add \`${key}:\` to edit this` };
}

function step(node: YNode, seg: string): YNode | null {
  if (isMap(node)) {
    const entry = node.entries.find((e) => e.key === seg);
    return entry ? entry.value : null;
  }
  if (isSeq(node)) {
    const i = Number(seg);
    if (!Number.isInteger(i) || i < 0 || i >= node.items.length) return null;
    return node.items[i] ?? null;
  }
  return null;
}

// ---------------------------------------------------------- document editing

/** The synth fences of a document, in track order. */
export function synthFences(doc: string): Fence[] {
  return extractFences(doc).filter((f) => f.lang === 'synth');
}

/**
 * Write `valueText` at `path` inside the Nth synth fence.
 * Only that one token (or one inserted pair) changes.
 */
export function setSynthField(doc: string, track: number, path: string[], valueText: string): EditResult {
  const fences = synthFences(doc);
  const fence = fences[track];
  if (!fence) return { ok: false, reason: `no synth fence for track ${track}` };

  const { root, errors } = parseYamlite(fence.body, fence.bodyStartLine);
  if (!root) return { ok: false, reason: 'fence did not parse' };
  if (errors.length > 0) return { ok: false, reason: 'fence has parse errors — fix the text first' };

  const target = resolveField(root, path);
  switch (target.kind) {
    case 'replace':
      return replaceValue(doc, target.scalar, valueText);
    case 'insert':
      return insertEntry(doc, target.map, target.key, valueText);
    case 'missing':
      return { ok: false, reason: target.reason };
  }
}

/** Read the current text of a field, or null when it is not written out. */
export function getSynthFieldText(doc: string, track: number, path: string[]): string | null {
  const fence = synthFences(doc)[track];
  if (!fence) return null;
  const { root } = parseYamlite(fence.body, fence.bodyStartLine);
  if (!root) return null;
  const target = resolveField(root, path);
  return target.kind === 'replace' ? target.scalar.value : null;
}

// -------------------------------------------------------------- loop editing

export interface LoopLineRef {
  trackId: string;
  /** Document-absolute line number. */
  line: number;
  /** Everything after the `id:` prefix. */
  cellsText: string;
  /** Column (1-based) where the cells start. */
  cellsCol: number;
}

/** Locate every `id: ...` line in the loop fence. */
export function loopLines(doc: string): LoopLineRef[] {
  const fence = findFence(extractFences(doc), 'loop');
  if (!fence) return [];
  const out: LoopLineRef[] = [];
  const lines = fence.body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i] ?? '';
    if (text.trim() === '' || text.trim().startsWith('#')) continue;
    const colon = text.indexOf(':');
    if (colon < 0) continue;
    out.push({
      trackId: text.slice(0, colon).trim(),
      line: fence.bodyStartLine + i,
      cellsText: text.slice(colon + 1),
      cellsCol: colon + 2,
    });
  }
  return out;
}

/** Replace one whole loop line, leaving the other lines untouched. */
export function setLoopLine(doc: string, trackId: string, newLineText: string): EditResult {
  const ref = loopLines(doc).find((l) => l.trackId === trackId);
  if (!ref) return { ok: false, reason: `no loop line for "${trackId}"` };
  const lines = doc.split('\n');
  const current = lines[ref.line - 1];
  if (current === undefined) return { ok: false, reason: 'loop line vanished' };
  return replaceSpan(doc, { line: ref.line, col: 1, endCol: current.length + 1 }, newLineText);
}

/** Append a new track line just before the loop fence's closing marker. */
export function appendLoopLine(doc: string, lineText: string): EditResult {
  const fence = findFence(extractFences(doc), 'loop');
  if (!fence) return { ok: false, reason: 'no loop fence in the document' };
  const bodyLines = fence.body.split('\n');
  // Skip trailing blank lines so the new row sits with the others.
  let n = bodyLines.length;
  while (n > 0 && (bodyLines[n - 1] ?? '').trim() === '') n--;
  const insertAtLine = fence.bodyStartLine + n; // 1-based line the new text becomes

  const lines = doc.split('\n');
  lines.splice(insertAtLine - 1, 0, lineText);
  return { ok: true, doc: lines.join('\n') };
}

/** Set `bars=` / `bpm=` (or any attr) on the loop fence's info string. */
export function setLoopAttr(doc: string, key: string, value: string): EditResult {
  const fence = findFence(extractFences(doc), 'loop');
  if (!fence) return { ok: false, reason: 'no loop fence in the document' };
  return setFenceAttr(doc, fence, key, value);
}

/** Set an attribute on any fence's info string, leaving the others alone. */
export function setFenceAttr(doc: string, fence: Fence, key: string, value: string): EditResult {
  const lines = doc.split('\n');
  const idx = fence.fenceLine - 1;
  const line = lines[idx];
  if (line === undefined) return { ok: false, reason: 'fence line vanished' };

  const re = new RegExp(`(\\b${key}=)(\\S+)`);
  lines[idx] = re.test(line) ? line.replace(re, `$1${value}`) : `${line.replace(/\s+$/, '')} ${key}=${value}`;
  return { ok: true, doc: lines.join('\n') };
}

// ------------------------------------------------------------ phrase editing
//
// A grid cell is one character wide and every row shares its columns, so the
// span of a cell is arithmetic rather than a search: writing a note changes
// exactly one byte and the rest of the document — including the other rows,
// their alignment and any prose around the fence — is untouched.

/** Every `phrase` fence in the document, in order of appearance. */
export function phraseFences(doc: string): Fence[] {
  return extractFences(doc).filter((f) => f.lang === 'phrase');
}

export interface LoadedPhrase {
  fence: Fence;
  phrase: Phrase;
}

/** Locate and parse one phrase by id. Null when it is missing or broken. */
export function loadPhrase(doc: string, id: string): LoadedPhrase | null {
  const fence = phraseFences(doc).find((f) => (f.attrs['id'] ?? '') === id);
  if (!fence) return null;
  const { phrase } = parsePhrase(fence.body, fence.attrs, { bodyStartLine: fence.bodyStartLine });
  return phrase ? { fence, phrase } : null;
}

/** The one-character span of a cell, in document coordinates. */
export function cellSpan(phrase: Phrase, row: number, cell: number): TextSpan | null {
  const line = phrase.rows[row];
  const col = phrase.cellCols[cell];
  if (!line || col === undefined) return null;
  return { line: line.line, col, endCol: col + 1 };
}

/** Write one cell glyph. One character in, one character out. */
export function writeCell(doc: string, phrase: Phrase, row: number, cell: number, glyph: string): EditResult {
  if (glyph.length !== 1) return { ok: false, reason: `"${glyph}" is not a single cell glyph` };
  const span = cellSpan(phrase, row, cell);
  if (!span) return { ok: false, reason: `no cell at row ${row}, column ${cell}` };
  return replaceSpan(doc, span, glyph);
}

/** Replace the inclusive line range `[from, to]` with `lines`. */
export function replaceLines(doc: string, from: number, to: number, lines: string[]): EditResult {
  const all = doc.split('\n');
  if (from < 1 || to < from - 1 || to > all.length) {
    return { ok: false, reason: `line range ${from}..${to} is out of range` };
  }
  all.splice(from - 1, to - from + 1, ...lines);
  return { ok: true, doc: all.join('\n') };
}

/** The `grid:` key through the last row line. */
export function gridBlockRange(phrase: Phrase): { from: number; to: number } | null {
  const rows = phrase.rows;
  if (rows.length === 0) return null;
  const last = Math.max(...rows.map((r) => r.line));
  const from = phrase.gridLine ?? Math.min(...rows.map((r) => r.line));
  return { from, to: last };
}

/** The `detail:` key through the last entry line, or null when there is none. */
export function detailBlockRange(phrase: Phrase): { from: number; to: number } | null {
  if (phrase.detailLine === null) return null;
  const last = phrase.detail.length > 0 ? Math.max(...phrase.detail.map((e) => e.line)) : phrase.detailLine;
  return { from: phrase.detailLine, to: last };
}

/**
 * Rewrite the grid block. Only reached when the geometry itself moved — a row
 * added, removed or re-sorted — because every other edit is a cell write.
 */
export function replaceGridBlock(doc: string, phrase: Phrase, lines: string[]): EditResult {
  const range = gridBlockRange(phrase);
  if (!range) return { ok: false, reason: 'phrase has no grid block' };
  return replaceLines(doc, range.from, range.to, lines);
}

/**
 * Rewrite the detail block: replaced in place when it exists, appended after
 * the grid when it does not, removed entirely when `entries` is empty.
 */
export function replaceDetailBlock(doc: string, phrase: Phrase, entries: string[]): EditResult {
  const range = detailBlockRange(phrase);
  if (range) {
    if (entries.length === 0) {
      // Take the blank line that separated it from the grid with it.
      const lines = doc.split('\n');
      const before = lines[range.from - 2];
      const from = before !== undefined && before.trim() === '' ? range.from - 1 : range.from;
      return replaceLines(doc, from, range.to, []);
    }
    return replaceLines(doc, range.from, range.to, ['detail:', ...entries]);
  }
  if (entries.length === 0) return { ok: true, doc };

  const grid = gridBlockRange(phrase);
  if (!grid) return { ok: false, reason: 'phrase has no grid block' };
  return replaceLines(doc, grid.to + 1, grid.to, ['', 'detail:', ...entries]);
}

/** Replace one detail entry line. */
export function replaceDetailLine(doc: string, entry: DetailEntry, text: string): EditResult {
  return replaceLines(doc, entry.line, entry.line, [text]);
}

/** Replace the whole fence body — the fallback when the text is not canonical. */
export function replacePhraseBody(doc: string, fence: Fence, body: string): EditResult {
  const bodyLines = fence.body.split('\n');
  return replaceLines(doc, fence.bodyStartLine, fence.bodyStartLine + bodyLines.length - 1, body.split('\n'));
}
