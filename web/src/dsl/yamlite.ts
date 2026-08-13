// "YAML-lite": a hand-written parser for the subset used by the Sheliak DSL.
// Deliberately tiny — no external YAML dependency.
//
// Supported:
//   - top-level `key: value` maps
//   - one level of block nesting (`env:` / indented `amp:`), actually N levels
//     since the algorithm is recursive, but the DSL only uses one
//   - block sequences with `- `
//   - flow maps/sequences `{ k: v, ... }` / `[ a, b ]` (single line)
//   - `#` comments and blank lines
//
// Every scalar carries its source position so field validators can report
// `{ line, col, message }`.

import type { DslError, Pos } from './errors.ts';

export interface YScalar extends Pos {
  kind: 'scalar';
  value: string;
  /** 1-based column just past the last character of the token (exclusive). */
  endCol: number;
}

export interface YMapEntry {
  key: string;
  keyPos: Pos;
  value: YNode;
}

export interface YMap extends Pos {
  kind: 'map';
  entries: YMapEntry[];
  /** true for `{ ... }`, false for indented block maps. */
  flow: boolean;
  /** Position of the closing `}` (flow maps only) — the insertion anchor. */
  close?: Pos;
}

export interface YSeq extends Pos {
  kind: 'seq';
  items: YNode[];
  /** true for `[ ... ]`, false for `- ` block sequences. */
  flow: boolean;
  /** Position of the closing `]` (flow sequences only). */
  close?: Pos;
}

export type YNode = YScalar | YMap | YSeq;

export interface YamliteResult {
  root: YMap | null;
  errors: DslError[];
}

interface Line {
  /** 1-based absolute document line number. */
  n: number;
  /** Leading-space count. */
  indent: number;
  /** Comment-stripped source, leading whitespace preserved (for column math). */
  raw: string;
  /** raw with leading whitespace removed. */
  text: string;
}

const KEY_RE = /^(\s*)([^\s:#][^:]*?)\s*:(?:\s|$)([\s\S]*)$/;
const SEQ_RE = /^(\s*)-(?:\s+|$)([\s\S]*)$/;

/**
 * Parse a YAML-subset document.
 * @param src        the fence body
 * @param startLine  1-based document line of the first body line
 */
export function parseYamlite(src: string, startLine = 1): YamliteResult {
  const errors: DslError[] = [];
  const lines = prepare(src, startLine, errors);

  if (lines.length === 0) {
    return { root: { kind: 'map', entries: [], flow: false, line: startLine, col: 1 }, errors };
  }

  const first = lines[0] as Line;
  const state = { lines, i: 0, errors };
  const root = parseBlockMap(state, first.indent);

  if (state.i < lines.length) {
    const l = lines[state.i] as Line;
    errors.push({ line: l.n, col: l.indent + 1, message: 'unexpected indentation' });
  }
  return { root, errors };
}

// ------------------------------------------------------------------ line prep

function prepare(src: string, startLine: number, errors: DslError[]): Line[] {
  const out: Line[] = [];
  const raw = src.split(/\r\n|\r|\n/);
  for (let i = 0; i < raw.length; i++) {
    const original = raw[i] ?? '';
    const n = startLine + i;
    if (original.includes('\t')) {
      errors.push({ line: n, col: original.indexOf('\t') + 1, message: 'tabs are not allowed for indentation' });
    }
    const stripped = stripComment(original.replace(/\t/g, ' '));
    if (stripped.trim() === '') continue;
    const indent = stripped.length - stripped.replace(/^ +/, '').length;
    out.push({ n, indent, raw: stripped, text: stripped.slice(indent).replace(/\s+$/, '') });
  }
  return out;
}

/** Remove a `#` comment (must be at line start or preceded by whitespace). */
function stripComment(line: string): string {
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== '#') continue;
    if (i === 0 || /\s/.test(line[i - 1] as string)) return line.slice(0, i);
  }
  return line;
}

// -------------------------------------------------------------------- parsing

interface State {
  lines: Line[];
  i: number;
  errors: DslError[];
}

function parseNode(state: State, indent: number): YNode {
  const line = state.lines[state.i] as Line;
  if (SEQ_RE.test(line.raw)) return parseBlockSeq(state, indent);
  return parseBlockMap(state, indent);
}

function parseBlockMap(state: State, indent: number): YMap {
  const start = state.lines[state.i] as Line;
  const map: YMap = { kind: 'map', entries: [], flow: false, line: start.n, col: indent + 1 };

  while (state.i < state.lines.length) {
    const line = state.lines[state.i] as Line;
    if (line.indent < indent) break;
    if (line.indent > indent) {
      state.errors.push({ line: line.n, col: line.indent + 1, message: 'unexpected indentation' });
      state.i++;
      continue;
    }

    const m = KEY_RE.exec(line.raw);
    if (!m) {
      state.errors.push({
        line: line.n,
        col: line.indent + 1,
        message: `expected "key: value", got "${line.text}"`,
      });
      state.i++;
      continue;
    }

    const key = (m[2] as string).trim();
    const keyPos: Pos = { line: line.n, col: line.indent + 1 };
    const rest = (m[3] as string).trim();
    const restCol = rest === '' ? line.raw.length + 1 : line.raw.indexOf(rest, line.indent + key.length) + 1;
    state.i++;

    let value: YNode;
    if (rest !== '') {
      value = parseInline(rest, { line: line.n, col: restCol }, state.errors);
    } else {
      const next = state.lines[state.i];
      if (next && next.indent > indent) {
        value = parseNode(state, next.indent);
      } else {
        value = { kind: 'map', entries: [], flow: false, line: line.n, col: restCol };
      }
    }
    map.entries.push({ key, keyPos, value });
  }

  return map;
}

function parseBlockSeq(state: State, indent: number): YSeq {
  const start = state.lines[state.i] as Line;
  const seq: YSeq = { kind: 'seq', items: [], flow: false, line: start.n, col: indent + 1 };

  while (state.i < state.lines.length) {
    const line = state.lines[state.i] as Line;
    if (line.indent < indent) break;
    if (line.indent > indent) {
      state.errors.push({ line: line.n, col: line.indent + 1, message: 'unexpected indentation' });
      state.i++;
      continue;
    }
    const m = SEQ_RE.exec(line.raw);
    if (!m) break;

    const rest = (m[2] as string).trim();
    const restCol = rest === '' ? line.indent + 2 : line.raw.indexOf(rest, line.indent + 1) + 1;
    state.i++;

    if (rest === '') {
      state.errors.push({ line: line.n, col: line.indent + 1, message: 'empty list item' });
      continue;
    }
    seq.items.push(parseInline(rest, { line: line.n, col: restCol }, state.errors));
  }

  return seq;
}

/**
 * Parse one value in isolation — a flow map, a flow sequence or a scalar.
 * `phrase.ts` uses it for the `{ ... }` half of a detail entry, whose key is an
 * address rather than a YAML key.
 */
export function parseInlineValue(text: string, pos: Pos, errors: DslError[]): YNode {
  return parseInline(text, pos, errors);
}

/** Parse the value part of a line: flow map, flow seq, or plain scalar. */
function parseInline(text: string, pos: Pos, errors: DslError[]): YNode {
  const head = text[0];
  if (head === '{' || head === '[') {
    // Column arithmetic: the flow scanner works on `text` with 0-based indices,
    // and pos.col is the 1-based column of text[0].
    const r = parseFlow(text, 0, pos, errors);
    const tail = text.slice(r.next).trim();
    if (tail !== '') {
      errors.push({ line: pos.line, col: pos.col + r.next, message: `unexpected "${tail}" after value` });
    }
    return r.node;
  }
  return { kind: 'scalar', value: text, line: pos.line, col: pos.col, endCol: pos.col + text.length };
}

interface FlowResult {
  node: YNode;
  next: number;
}

function colOf(pos: Pos, index: number): number {
  return pos.col + index;
}

function skipWs(s: string, i: number): number {
  while (i < s.length && /\s/.test(s[i] as string)) i++;
  return i;
}

function parseFlow(s: string, i0: number, pos: Pos, errors: DslError[]): FlowResult {
  let i = skipWs(s, i0);
  const ch = s[i];

  if (ch === '{') {
    const map: YMap = { kind: 'map', entries: [], flow: true, line: pos.line, col: colOf(pos, i) };
    i++;
    for (;;) {
      i = skipWs(s, i);
      if (i >= s.length) {
        errors.push({ line: pos.line, col: colOf(pos, i), message: 'unterminated "{"' });
        break;
      }
      if (s[i] === '}') {
        map.close = { line: pos.line, col: colOf(pos, i) };
        i++;
        break;
      }
      const keyStart = i;
      while (i < s.length && s[i] !== ':' && s[i] !== ',' && s[i] !== '}') i++;
      const key = s.slice(keyStart, i).trim();
      if (s[i] !== ':') {
        errors.push({ line: pos.line, col: colOf(pos, keyStart), message: `expected ":" after key "${key}"` });
        // Skip to the next separator to keep going.
        while (i < s.length && s[i] !== ',' && s[i] !== '}') i++;
        if (s[i] === ',') i++;
        continue;
      }
      i++; // consume ':'
      const keyPos: Pos = { line: pos.line, col: colOf(pos, keyStart) };
      const v = parseFlow(s, i, pos, errors);
      i = v.next;
      map.entries.push({ key, keyPos, value: v.node });
      i = skipWs(s, i);
      if (s[i] === ',') {
        i++;
        continue;
      }
      if (s[i] === '}') {
        map.close = { line: pos.line, col: colOf(pos, i) };
        i++;
        break;
      }
      if (i >= s.length) {
        errors.push({ line: pos.line, col: colOf(pos, i), message: 'unterminated "{"' });
        break;
      }
      errors.push({ line: pos.line, col: colOf(pos, i), message: `expected "," or "}" but found "${s[i]}"` });
      i++;
    }
    return { node: map, next: i };
  }

  if (ch === '[') {
    const seq: YSeq = { kind: 'seq', items: [], flow: true, line: pos.line, col: colOf(pos, i) };
    i++;
    for (;;) {
      i = skipWs(s, i);
      if (i >= s.length) {
        errors.push({ line: pos.line, col: colOf(pos, i), message: 'unterminated "["' });
        break;
      }
      if (s[i] === ']') {
        seq.close = { line: pos.line, col: colOf(pos, i) };
        i++;
        break;
      }
      const v = parseFlow(s, i, pos, errors);
      i = v.next;
      seq.items.push(v.node);
      i = skipWs(s, i);
      if (s[i] === ',') {
        i++;
        continue;
      }
      if (s[i] === ']') {
        seq.close = { line: pos.line, col: colOf(pos, i) };
        i++;
        break;
      }
      if (i >= s.length) {
        errors.push({ line: pos.line, col: colOf(pos, i), message: 'unterminated "["' });
        break;
      }
      errors.push({ line: pos.line, col: colOf(pos, i), message: `expected "," or "]" but found "${s[i]}"` });
      i++;
    }
    return { node: seq, next: i };
  }

  // Plain scalar inside a flow collection: runs to the next separator.
  const start = i;
  while (i < s.length && s[i] !== ',' && s[i] !== '}' && s[i] !== ']') i++;
  const value = s.slice(start, i).replace(/\s+$/, '');
  const col = colOf(pos, start);
  return {
    node: { kind: 'scalar', value, line: pos.line, col, endCol: col + value.length },
    next: i,
  };
}

// ------------------------------------------------------------------- helpers

export function isMap(n: YNode | undefined): n is YMap {
  return !!n && n.kind === 'map';
}

export function isSeq(n: YNode | undefined): n is YSeq {
  return !!n && n.kind === 'seq';
}

export function isScalar(n: YNode | undefined): n is YScalar {
  return !!n && n.kind === 'scalar';
}

/** Position of any node (maps/seqs point at their opening token). */
export function nodePos(n: YNode): Pos {
  return { line: n.line, col: n.col };
}
