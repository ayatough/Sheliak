// Markdown fenced-code-block extraction.
//
// We only need enough CommonMark to find ```synth / ```loop blocks and to keep
// accurate line offsets so downstream parsers can report positions relative to
// the whole document.

export interface Fence {
  /** First word of the info string, e.g. "synth" / "loop". Empty when absent. */
  lang: string;
  /** key=value pairs from the info string, e.g. { id: 'lead', seed: '42' }. */
  attrs: Record<string, string>;
  /** The raw info string (everything after the opening fence marker). */
  info: string;
  /** Body text without the fence lines, newline separated, no trailing newline. */
  body: string;
  /** 1-based document line of the opening fence marker. */
  fenceLine: number;
  /** 1-based document line of the FIRST body line (fenceLine + 1). */
  bodyStartLine: number;
}

const OPEN_RE = /^(\s{0,3})(`{3,}|~{3,})(.*)$/;

/**
 * Extract all fenced code blocks from a markdown document.
 * Unterminated fences run to the end of the document (CommonMark behaviour).
 */
export function extractFences(md: string): Fence[] {
  const lines = md.split(/\r\n|\r|\n/);
  const out: Fence[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const m = OPEN_RE.exec(line);
    if (!m) {
      i++;
      continue;
    }
    const indent = (m[1] ?? '').length;
    const marker = m[2] ?? '';
    const fenceChar = marker[0] as '`' | '~';
    const info = (m[3] ?? '').trim();

    // Backtick fences may not carry a backtick in the info string.
    if (fenceChar === '`' && info.includes('`')) {
      i++;
      continue;
    }

    const fenceLine = i + 1;
    const bodyLines: string[] = [];
    let j = i + 1;
    let closed = false;
    for (; j < lines.length; j++) {
      const cur = lines[j] ?? '';
      const cm = OPEN_RE.exec(cur);
      if (cm && (cm[2] ?? '')[0] === fenceChar && (cm[2] ?? '').length >= marker.length && (cm[3] ?? '').trim() === '') {
        closed = true;
        break;
      }
      // Strip up to `indent` leading spaces, as CommonMark does.
      bodyLines.push(stripIndent(cur, indent));
    }

    out.push({
      lang: firstWord(info),
      attrs: parseInfoAttrs(info),
      info,
      body: bodyLines.join('\n'),
      fenceLine,
      bodyStartLine: fenceLine + 1,
    });

    i = closed ? j + 1 : j;
  }

  return out;
}

function stripIndent(line: string, indent: number): string {
  let k = 0;
  while (k < indent && line[k] === ' ') k++;
  return line.slice(k);
}

function firstWord(info: string): string {
  const m = /^\S+/.exec(info);
  return m ? m[0] : '';
}

/**
 * Parse an info string like `synth id=lead seed=42` into attributes.
 * The leading language word is not included. Bare flags become "true".
 * Values may be quoted with ' or ".
 */
export function parseInfoAttrs(info: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const rest = info.replace(/^\S+\s*/, '');
  const re = /([A-Za-z_][A-Za-z0-9_-]*)(?:=(?:"([^"]*)"|'([^']*)'|(\S+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rest)) !== null) {
    if (m[0] === '') {
      re.lastIndex++;
      continue;
    }
    const key = m[1] as string;
    const value = m[2] ?? m[3] ?? m[4];
    attrs[key] = value === undefined ? 'true' : value;
  }
  return attrs;
}

/** First fence whose lang matches, or undefined. */
export function findFence(fences: Fence[], lang: string): Fence | undefined {
  return fences.find((f) => f.lang === lang);
}
