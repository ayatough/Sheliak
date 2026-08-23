// Sections — a `##` heading is a span of the song (workstreams.md Stream 2 §3).
//
//   ## intro
//
//   ```loop bars=4
//   lead: verse-lead
//   ```
//
//   ## verse
//
//   ```loop bars=8 repeat=2
//   lead: verse-lead
//   bass: verse-bass
//   ```
//
// Document order is playback order. Everything before the first `##` is the
// preamble, which is where `synth`, `plugin` and `phrase` fences go; a section
// holds at most one `loop` fence, and that fence is its arrangement.
//
// **A section with no `loop` fence is prose and is skipped**, not four bars of
// silence. A song file is still a document, and `## Notes` must not play.
//
// This file only finds the structure. Resolving `from=`, `repeat=` and laying
// the sections end to end is `compile.ts`.

import { ErrorSink, type DslError } from './errors.ts';
import type { Fence } from './fences.ts';

export interface Section {
  /** The heading text, which is what `from=` names. */
  name: string;
  /** 1-based document line of the `##` heading. */
  line: number;
  /** 1-based column of the `##` marker. */
  col: number;
  /** The `loop` fence that is this section's arrangement. */
  loop: Fence;
}

export interface SectionsResult {
  /**
   * Sections in document — and therefore playback — order. Empty when the
   * document is not a list of sections, in which case it is a single `loop`
   * exactly as it has always been.
   */
  sections: Section[];
  /** Headings skipped for holding no `loop` fence, by name, for diagnostics. */
  prose: string[];
  /** `loop` fences under no `##` heading. Only a problem when there are sections. */
  orphans: Fence[];
  errors: DslError[];
}

/**
 * Exactly two hashes: `#` is the document's title and `###` a subheading inside
 * a section, and neither starts one. CommonMark allows up to three leading
 * spaces and a run of closing hashes.
 */
const HEADING = /^ {0,3}##(?!#)(?:[ \t]+(.*?))?[ \t]*$/;

/** Finds the `##` sections of a document and the `loop` fence in each. */
export function extractSections(markdown: string, fences: readonly Fence[]): SectionsResult {
  const sink = new ErrorSink();
  const lines = markdown.split(/\r\n|\r|\n/);

  // A `##` inside a fence is a comment in somebody's grid, not a heading.
  const covered = new Set<number>();
  for (const fence of fences) {
    for (let n = fence.fenceLine; n <= fence.endLine; n++) covered.add(n);
  }

  interface Heading {
    name: string;
    line: number;
    col: number;
    loops: Fence[];
  }

  const headings: Heading[] = [];
  for (let i = 0; i < lines.length; i++) {
    const n = i + 1;
    if (covered.has(n)) continue;
    const text = lines[i] ?? '';
    const m = HEADING.exec(text);
    if (!m) continue;
    headings.push({
      name: (m[1] ?? '').replace(/[ \t]+#+$/, '').trim(),
      line: n,
      col: text.indexOf('##') + 1,
      loops: [],
    });
  }

  // Each `loop` fence belongs to the last heading above it; one with no heading
  // above it is in the preamble.
  const orphans: Fence[] = [];
  for (const fence of fences) {
    if (fence.lang !== 'loop') continue;
    let owner: Heading | undefined;
    for (const heading of headings) {
      if (heading.line >= fence.fenceLine) break;
      owner = heading;
    }
    if (owner) owner.loops.push(fence);
    else orphans.push(fence);
  }

  const sections: Section[] = [];
  const prose: string[] = [];
  const seen = new Map<string, number>();

  for (const heading of headings) {
    const first = heading.loops[0];
    if (!first) {
      prose.push(heading.name);
      continue;
    }

    for (const extra of heading.loops.slice(1)) {
      sink.push(
        { line: extra.fenceLine, col: 1 },
        `a second \`loop\` fence under "${heading.name}" — a section has one arrangement` +
          ` (the first is on line ${first.fenceLine})`,
      );
    }

    if (heading.name === '') {
      sink.push({ line: heading.line, col: heading.col }, 'this `##` heading has no text, so its section has no name');
    } else if (seen.has(heading.name)) {
      sink.push(
        { line: heading.line, col: heading.col },
        `duplicate section "${heading.name}" — \`from=\` names a section, so each heading needs its own name` +
          ` (the first is on line ${seen.get(heading.name)})`,
      );
    } else {
      seen.set(heading.name, heading.line);
    }

    sections.push({ name: heading.name, line: heading.line, col: heading.col, loop: first });
  }

  return { sections, prose, orphans, errors: sink.errors };
}
