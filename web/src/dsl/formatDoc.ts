// Canonicalising every `phrase` fence in a document, leaving everything else
// byte-for-byte alone.
//
// The formatter already existed for one fence body (`canonicalizePhrase`), and
// the GUI leans on it: one structure has exactly one spelling, which is what
// makes a text edit and a model edit provably the same operation. What was
// missing was the whole-document version, and with it the thing a person
// actually needs — the beat ruler and the row labels are written by hand today,
// so a grid can be misaligned, and the ruler can be an outright lie, without
// anything being wrong enough to fail.

import { extractFences } from './fences.ts';
import { canonicalizePhrase } from './format.ts';
import { sortErrors, type DslError } from './errors.ts';

export interface FormatDocResult {
  /** The formatted document, or the original when anything could not be parsed. */
  text: string;
  /** True when `text` differs from the source. */
  changed: boolean;
  /** How many `phrase` fences were rewritten. */
  formatted: number;
  /**
   * Parse errors from the fences that could not be formatted. Non-empty means
   * `text` is the untouched source: a document is formatted whole or not at all.
   */
  errors: DslError[];
}

/**
 * Rewrites every `phrase` fence canonically.
 *
 * Whole or nothing, like `cargo fmt`: a document with one broken phrase is not
 * partly formatted, because a formatter that half-runs leaves you unable to say
 * whether what you are looking at is canonical.
 */
export function formatDocument(source: string): FormatDocResult {
  const fences = extractFences(source);
  const lines = source.split(/\r\n|\r|\n/);
  const errors: DslError[] = [];

  const edits: { start: number; end: number; body: string[] }[] = [];
  for (const fence of fences) {
    if (fence.lang !== 'phrase') continue;
    const { text, errors: fenceErrors } = canonicalizePhrase(fence.body, fence.attrs, fence.bodyStartLine);
    if (text === null) {
      errors.push(...fenceErrors);
      continue;
    }
    const pad = ' '.repeat(fence.indent);
    edits.push({
      // Line numbers are 1-based; these are indices into `lines`.
      start: fence.bodyStartLine - 1,
      end: fence.bodyStartLine - 1 + fence.body.split('\n').length,
      // The indent the fence was written with is restored: the body arrives
      // with it stripped, as CommonMark requires, and putting it back is what
      // keeps a fence inside a list item where its author left it.
      body: text.split('\n').map((line) => (line === '' ? '' : pad + line)),
    });
  }

  if (errors.length > 0) {
    return { text: source, changed: false, formatted: 0, errors: sortErrors(errors) };
  }

  // Applied last-first, so that an earlier fence's line numbers stay true
  // however much a later one grew or shrank.
  for (const edit of edits.reverse()) {
    lines.splice(edit.start, edit.end - edit.start, ...edit.body);
  }

  // Rejoined with the endings the file already used. Rewriting a CRLF document
  // as LF would be a diff on every line of it, which is not formatting.
  const text = lines.join(source.includes('\r\n') ? '\r\n' : '\n');
  return { text, changed: text !== source, formatted: edits.length, errors: [] };
}
