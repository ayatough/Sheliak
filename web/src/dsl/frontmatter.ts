// The song header (workstreams.md Stream 2 §2).
//
//   ---
//   title: Nocturne
//   bpm: 126
//   key: C
//   scale: minor
//   ---
//
// Optional, and only at the very top of the document. What it exists for is
// inheritance: `key` and `scale` are per-fence attributes, so without a header
// every phrase in a song spells them out, and every one of them has to be
// changed together to change the mode. Nearest wins — a fence that says `key=`
// keeps it — so adding a header to an existing document changes nothing about
// what it sounds like.
//
// `bpm` is the exception that keeps today's documents working: a `loop` fence's
// own `bpm=` still wins over the header, because that is where it lives now.

import { ErrorSink, type DslError, type Pos } from './errors.ts';
import { isScalar, parseYamlite, type YMapEntry } from './yamlite.ts';
import { keyToPitchClass, SCALES } from './pitch.ts';

export interface SongHeader {
  /** Names the song. The engine does not use it; the editor shows it. */
  title?: string;
  /** Beats per minute, unless a `loop` fence says otherwise. */
  bpm?: number;
  /** Tonic pitch class inherited by every `phrase` that does not say. */
  key?: string;
  /** Scale inherited by every `phrase` that does not say. */
  scale?: string;
  /** Default length, in bars, of a `loop` that does not say. */
  bars?: number;
}

export interface FrontmatterResult {
  /** Empty when the document has no header — which is the common case. */
  header: SongHeader;
  /** True when a header was present, even if every field in it was wrong. */
  present: boolean;
  /**
   * 1-based line of the closing `---`, or 0 without a header. Everything from
   * here down is the document proper; fence line numbers are unaffected either
   * way, because the header is counted rather than stripped.
   */
  endLine: number;
  errors: DslError[];
}

/** Every field the header understands. A typo in a header is otherwise silent. */
const FIELDS = ['title', 'bpm', 'key', 'scale', 'bars'] as const;

const EMPTY: FrontmatterResult = { header: {}, present: false, endLine: 0, errors: [] };

/**
 * Reads the header, if there is one.
 *
 * Recognised only as the very first thing in the document: a `---` on line 1,
 * closed by the next `---` alone on its own line. Anything looser would make a
 * horizontal rule in someone's prose into a song header.
 */
export function parseFrontmatter(markdown: string): FrontmatterResult {
  const lines = markdown.split(/\r\n|\r|\n/);
  if ((lines[0] ?? '').trim() !== '---') return EMPTY;

  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] ?? '').trim() === '---') {
      close = i;
      break;
    }
  }
  if (close < 0) {
    return {
      ...EMPTY,
      present: true,
      errors: [
        {
          line: 1,
          col: 1,
          message: 'the song header is never closed — it needs a second `---` on its own line',
        },
      ],
    };
  }

  const sink = new ErrorSink();
  const body = lines.slice(1, close).join('\n');
  // Line 2 is the first body line, so positions land on the real document line.
  const parsed = parseYamlite(body, 2);
  sink.errors.push(...parsed.errors);

  const header: SongHeader = {};
  const seen = new Set<string>();
  for (const entry of parsed.root?.entries ?? []) {
    const pos: Pos = entry.keyPos;
    if (!(FIELDS as readonly string[]).includes(entry.key)) {
      sink.push(pos, `unknown song header field "${entry.key}" (${FIELDS.join(', ')})`);
      continue;
    }
    if (seen.has(entry.key)) {
      sink.push(pos, `duplicate song header field "${entry.key}"`);
      continue;
    }
    seen.add(entry.key);
    readField(entry, header, sink);
  }

  return { header, present: true, endLine: close + 1, errors: sink.errors };
}

function readField(entry: YMapEntry, header: SongHeader, sink: ErrorSink): void {
  const pos: Pos = entry.keyPos;
  if (!isScalar(entry.value)) {
    // `title:` with nothing after it parses as an empty map, which is worth
    // saying plainly rather than as a complaint about structure.
    const empty = entry.value.kind === 'map' && entry.value.entries.length === 0;
    sink.push(pos, empty ? `"${entry.key}" has no value` : `"${entry.key}" takes a single value`);
    return;
  }
  const text = entry.value.value.trim();
  const at: Pos = { line: entry.value.line, col: entry.value.col };

  switch (entry.key) {
    case 'title':
      if (text === '') sink.push(pos, 'title is empty');
      else header.title = text;
      return;

    // Bare numbers are allowed here, as they are in a fence's info string. The
    // unit rule governs fence bodies, where a number could be milliseconds or
    // seconds; `bpm: 126` has one meaning.
    case 'bpm': {
      const v = Number(text);
      if (!Number.isFinite(v) || v <= 0) sink.push(at, `bpm must be a positive number, got "${text}"`);
      else header.bpm = v;
      return;
    }
    case 'bars': {
      const v = Number(text);
      if (!Number.isInteger(v) || v < 1) sink.push(at, `bars must be a whole number of bars, 1 or more, got "${text}"`);
      else header.bars = v;
      return;
    }
    case 'key':
      if (keyToPitchClass(text) === null) {
        sink.push(at, `key must be a pitch class like C, Eb or F#, got "${text}"`);
      } else {
        header.key = text;
      }
      return;
    case 'scale':
      if (!SCALES[text]) sink.push(at, `unknown scale "${text}" (${Object.keys(SCALES).join(', ')})`);
      else header.scale = text;
      return;
  }
}
