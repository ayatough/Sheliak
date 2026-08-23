// Sections → one loop (workstreams.md Stream 2 §4, §7).
//
// `sections.ts` finds the `##` headings and the `loop` fence in each. This file
// turns that list into the single `LoopIR` the audio side already plays: it
// resolves `from=` against the sections above, expands `repeat=`, and lays the
// sections end to end, offsetting every event by where its section starts.
//
// The reason this is cheap is that `worklet.js` plays a `LoopIR` by wrapping a
// sample counter and does not care whether the span is one bar or four minutes.
// A section is a span of the event list; that is the whole mechanism.

import { ErrorSink, type DslError, type Pos } from './errors.ts';
import type { Phrase } from './phrase.ts';
import type { Section } from './sections.ts';
import {
  parseLoop,
  type Binding,
  type LoopEvent,
  type LoopIR,
  type LoopLineMeta,
  type LoopMeta,
  type SectionMeta,
} from './loop.ts';

export interface ArrangementOptions {
  sampleRate: number;
  /** The song's tempo, for a `LoopMeta` with no section to take one from. */
  bpm: number;
  trackIds: Record<string, number>;
  phrases: Record<string, Phrase>;
  declaredPhrases: ReadonlySet<string>;
  /** The song header's `bars`, used by a section that does not say. */
  defaultBars?: number;
  /** Headings skipped for having no `loop` fence, so `from=` can say so. */
  prose: readonly string[];
}

export interface ArrangementResult {
  /** The whole song as one loop, or null when any section did not compile. */
  loop: LoopIR | null;
  meta: LoopMeta | null;
  errors: DslError[];
}

/** Lays a document's sections end to end into one loop. */
export function buildArrangement(
  sections: readonly Section[],
  opts: ArrangementOptions,
): ArrangementResult {
  const sink = new ErrorSink();

  /** Each section's merged bindings, for a later `from=` to copy. */
  const resolved = new Map<string, Binding[]>();
  const sectionMetas: SectionMeta[] = [];
  const lines: LoopLineMeta[] = [];
  const events: LoopEvent[] = [];

  let startSamples = 0;
  let ok = true;

  sections.forEach((section, index) => {
    const fence = section.loop;
    const pos: Pos = { line: fence.fenceLine, col: 1 };

    // `from=` (§4): the section begins as a copy of an earlier one's bindings.
    // Earlier only — a forward reference is an error, not a resolution order to
    // work out, and it keeps this a single pass down the document.
    let inherited: Binding[] | undefined;
    const from = fence.attrs['from'];
    if (from !== undefined) {
      const found = resolved.get(from);
      if (found) {
        inherited = found;
      } else {
        sink.push(pos, fromMessage(from, section, sections, index, opts.prose));
        ok = false;
      }
    }

    const repeat = readRepeat(fence.attrs['repeat'], pos, sink);
    if (repeat === null) ok = false;
    const times = repeat ?? 1;

    const r = parseLoop(fence.body, fence.attrs, {
      bodyStartLine: fence.bodyStartLine,
      sampleRate: opts.sampleRate,
      trackIds: opts.trackIds,
      phrases: opts.phrases,
      declaredPhrases: opts.declaredPhrases,
      defaultBars: opts.defaultBars,
      section: section.name,
      inherited,
    });
    sink.errors.push(...r.errors);

    // Registered even when the section did not compile: what a later `from=`
    // inherits is what this section's text says, so one typo does not silently
    // rewrite every variation below it.
    if (section.name !== '' && !resolved.has(section.name)) resolved.set(section.name, r.bindings);

    const meta = r.meta;
    if (!meta) {
      // An empty `loop` fence; it has already said so. It contributes no time,
      // which keeps every section below it at the offset the document implies.
      ok = false;
      return;
    }

    sectionMetas.push({
      name: section.name,
      line: section.line,
      bars: meta.bars,
      bpm: meta.bpm,
      repeat: times,
      lengthSamples: meta.lengthSamples,
      startSamples,
      lines: meta.lines,
    });
    lines.push(...meta.lines);

    if (r.loop) {
      for (let pass = 0; pass < times; pass++) {
        const base = startSamples + pass * r.loop.lengthSamples;
        for (const e of r.loop.events) events.push({ ...e, offsetSamples: base + e.offsetSamples });
      }
    } else {
      ok = false;
    }

    // Advance from the metadata rather than from the events, so a section that
    // failed still holds its place and the ones after it are reported where
    // they will be once it is fixed.
    startSamples += meta.lengthSamples * times;
  });

  const first = sectionMetas[0];
  const meta: LoopMeta = {
    id: '',
    // The whole song: what plays before it comes round again.
    bars: sectionMetas.reduce((n, s) => n + s.bars * s.repeat, 0),
    bpm: first?.bpm ?? opts.bpm,
    lengthSamples: startSamples,
    lines,
    sections: sectionMetas,
  };

  // Events are already in order: each section's are sorted, and every section
  // starts after the one before it ends.
  if (!ok) return { loop: null, meta, errors: sink.errors };
  return { loop: { lengthSamples: startSamples, events }, meta, errors: sink.errors };
}

function readRepeat(raw: string | undefined, pos: Pos, sink: ErrorSink): number | null {
  if (raw === undefined) return 1;
  const v = Number(raw);
  if (!Number.isInteger(v) || v < 1) {
    sink.push(pos, `repeat must be a whole number of times, 1 or more, got "${raw}"`);
    return null;
  }
  return v;
}

/** Why this `from=` did not resolve — the three cases are different mistakes. */
function fromMessage(
  from: string,
  section: Section,
  sections: readonly Section[],
  index: number,
  prose: readonly string[],
): string {
  if (from === section.name) {
    return `\`from=${from}\` names this section itself — \`from\` starts from a section above this one`;
  }
  const later = sections.findIndex((s, i) => i > index && s.name === from);
  if (later >= 0) {
    return (
      `\`from=${from}\` names a section further down (line ${sections[later]!.line})` +
      ' — `from` starts from a section above this one'
    );
  }
  if (prose.includes(from)) {
    return `\`from=${from}\` names a heading with no \`loop\` fence, so there are no bindings to start from`;
  }
  const known = sections.slice(0, index).map((s) => s.name).filter((n) => n !== '');
  return `\`from=${from}\` names no section` + (known.length ? ` (above this one: ${known.join(', ')})` : '');
}
