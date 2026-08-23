// `loop` fence → Loop IR (docs/workstreams.md §6, docs/syntax.md).
//
//   ```loop id=groove bars=1 bpm=126
//   lead: verse-lead
//   bass: verse-bass
//   kick: four-floor
//   ```
//
// The loop is the arrangement: each line binds a track — a `synth` fence's id,
// resolved to a track index by fence order — to a `phrase` fence's id. The
// notes themselves live in the phrase (`phrase.ts`); this file turns them into
// sample-accurate events, which is where the detail block's gestures stop being
// text and become timing, velocity and glide.

import { ErrorSink, type DslError, type Pos } from './errors.ts';
import { samplesPerBeat } from './units.ts';
import { keyToPitchClass, resolveRowLabel } from './pitch.ts';
import {
  groupMembers,
  resolveGestures,
  DEFAULT_VELOCITY,
  type Phrase,
  type PhraseNote,
  type PhraseRow,
} from './phrase.ts';

export interface LoopEvent {
  offsetSamples: number;
  /** Track index, 0..MAX_TRACKS-1 (the synth fence's order of appearance). */
  track: number;
  /** 0 = noteOn, 1 = noteOff */
  kind: 0 | 1;
  note: number;
  velocity: number;
  /**
   * Glide time in seconds for this note (§10). `-1` means "use the patch's
   * `voice.glide`", which is every note that is not the destination of a
   * glissando — so today's audio is unchanged.
   */
  glideS: number;
  /** 1 suppresses the amplitude-envelope retrigger, so a slide is one note. */
  legato: 0 | 1;
}

export interface LoopIR {
  lengthSamples: number;
  events: LoopEvent[];
}

/** One `trackId: phraseId` line. */
export interface LoopLineMeta {
  trackId: string;
  track: number;
  phraseId: string;
  /** How many times the phrase repeats to fill the loop. */
  repeats: number;
  /** Cells per beat of the bound phrase, for the sequencer. */
  cellsPerBeat: number;
  /** The `##` section this line came from; absent for a lone `loop` fence. */
  section?: string;
  /** True when the binding came from `from=` rather than from a line here. */
  inherited?: boolean;
}

/** What `from=` copies: one section's bindings, after its own `from=` merge. */
export interface Binding {
  trackId: string;
  phraseId: string;
}

export interface LoopMeta {
  id: string;
  bars: number;
  bpm: number;
  /** One pass through this arrangement, at its own tempo. */
  lengthSamples: number;
  lines: LoopLineMeta[];
  /** Present when the document is a list of `##` sections (Stream 2 §3). */
  sections?: SectionMeta[];
}

/** One `##` section's place in the song, for the GUI and `sheliak check`. */
export interface SectionMeta {
  name: string;
  /** 1-based document line of the `##` heading. */
  line: number;
  bars: number;
  bpm: number;
  /** How many times it plays before the next section. */
  repeat: number;
  /** One pass through it, in samples, at its own tempo. */
  lengthSamples: number;
  /** Where it starts in the song, in samples. */
  startSamples: number;
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
  /** Every `phrase` fence in the document, by id. */
  phrases?: Record<string, Phrase>;
  /**
   * Every phrase id the document *declares*, including fences that failed to
   * parse and are therefore absent from `phrases`. Without it a phrase with a
   * bad row reports twice: once where the row is, and once here as "undefined",
   * which is not true and is the louder of the two.
   */
  declaredPhrases?: ReadonlySet<string>;
  /**
   * The song header's `bars` (Stream 2 §2), used when this fence does not say.
   * A loop that states its own length keeps it.
   */
  defaultBars?: number;
  /**
   * Bindings this section inherits with `from=` (Stream 2 §4). This fence's own
   * lines then add, replace, or remove (`-`) against them.
   */
  inherited?: readonly Binding[];
  /** The `##` heading this fence sits under, stamped onto the line metadata. */
  section?: string;
}

/** One binding after `from=` has been merged with this fence's own lines. */
interface MergedLine extends Binding {
  /** Document line to report against — the fence itself, when inherited. */
  n: number;
  trackIdCol: number;
  phraseCol: number;
  /** Came from `from=`, so no line in this fence says it. */
  inherited: boolean;
}

export interface LoopParseResult {
  loop: LoopIR | null;
  meta: LoopMeta | null;
  /**
   * The merged bindings — `from=` plus this fence's own lines, in order, before
   * any of them is checked against the document. This is what a later section's
   * `from=` copies, and it exists whether or not this fence compiled: a section
   * with a typo in it should not silently change what inherits from it.
   */
  bindings: Binding[];
  errors: DslError[];
}

const DEFAULT_BARS = 1;
const DEFAULT_BPM = 120;
/** `glide_s < 0` keeps the patch's own `voice.glide` (§10). */
export const PATCH_GLIDE = -1;

export { DEFAULT_VELOCITY };

export function parseLoop(
  body: string,
  attrs: Record<string, string> = {},
  opts: LoopParseOptions,
): LoopParseResult {
  const startLine = opts.bodyStartLine ?? 1;
  const sink = new ErrorSink();
  const fencePos: Pos = { line: startLine - 1, col: 1 };

  const bars = readPositive(attrs['bars'], opts.defaultBars ?? DEFAULT_BARS, 'bars', fencePos, sink);
  const bpm = readPositive(attrs['bpm'], DEFAULT_BPM, 'bpm', fencePos, sink);
  const id = attrs['id'] ?? '';

  const raw = body.split(/\r\n|\r|\n/);
  const trackLines: { text: string; n: number }[] = [];
  for (let i = 0; i < raw.length; i++) {
    const text = (raw[i] ?? '').replace(/\s+#.*$/, '');
    if (text.trim() === '' || text.trim().startsWith('#')) continue;
    trackLines.push({ text, n: startLine + i });
  }

  if (trackLines.length === 0 && !opts.inherited?.length) {
    sink.push(fencePos, 'loop needs at least one track line, e.g. "lead: verse-lead"');
    return { loop: null, meta: null, bindings: [], errors: sink.errors };
  }

  const spb = samplesPerBeat(bpm, opts.sampleRate);
  const lengthSamples = Math.round(bars * 4 * spb);

  const events: LoopEvent[] = [];
  const lineMetas: LoopLineMeta[] = [];
  /**
   * A line that could not be resolved for a reason already reported elsewhere.
   * It yields no diagnostic of its own but still invalidates the loop, so the
   * transport keeps the last valid arrangement rather than switching to one
   * with a track quietly missing from it while a phrase is half-typed.
   */
  let incomplete = false;

  // `from=` (Stream 2 §4): the section starts as a copy of an earlier one's
  // bindings, and this fence's lines add, replace or remove against them. The
  // merge happens before anything is validated, so replacing an inherited
  // binding is a replacement rather than a duplicate.
  const merged: MergedLine[] = (opts.inherited ?? []).map((b) => ({
    trackId: b.trackId,
    phraseId: b.phraseId,
    n: fencePos.line,
    trackIdCol: 1,
    phraseCol: 1,
    inherited: true,
  }));
  const ownIds = new Set<string>();

  for (const line of trackLines) {
    const colon = line.text.indexOf(':');
    if (colon < 0) {
      sink.push({ line: line.n, col: 1 }, 'expected "trackId: phraseId"');
      continue;
    }
    const trackIdCol = line.text.length - line.text.trimStart().length + 1;
    const trackId = line.text.slice(0, colon).trim();
    const phraseId = line.text.slice(colon + 1).trim();
    const phraseCol = colon + 2 + (line.text.slice(colon + 1).length - line.text.slice(colon + 1).trimStart().length);

    if (ownIds.has(trackId)) {
      sink.push({ line: line.n, col: trackIdCol }, `duplicate loop line for track "${trackId}"`);
      continue;
    }
    ownIds.add(trackId);

    const at = merged.findIndex((m) => m.trackId === trackId);
    if (phraseId === '-') {
      // Removing what was never there is a typo, not a no-op: silence is
      // exactly what both outcomes look like.
      if (at < 0) {
        sink.push(
          { line: line.n, col: phraseCol },
          `nothing to remove — track "${trackId}" is not bound here` +
            (opts.inherited?.length ? '' : ' (`-` removes a binding inherited with `from=`)'),
        );
      } else {
        merged.splice(at, 1);
      }
      continue;
    }

    const entry: MergedLine = { trackId, phraseId, n: line.n, trackIdCol, phraseCol, inherited: false };
    if (at < 0) merged.push(entry);
    else merged[at] = entry;
  }

  const bindings: Binding[] = merged.map((m) => ({ trackId: m.trackId, phraseId: m.phraseId }));

  for (const line of merged) {
    const { trackId, phraseId, trackIdCol, phraseCol } = line;

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
      track = lineMetas.length;
    }

    if (phraseId === '') {
      sink.push({ line: line.n, col: phraseCol }, `track "${trackId}" names no phrase`);
      continue;
    }
    if (/\s/.test(phraseId)) {
      sink.push(
        { line: line.n, col: phraseCol },
        `"${phraseId}" is not a phrase id — a loop line binds one track to one phrase`,
      );
      continue;
    }

    const phrase = opts.phrases?.[phraseId];
    if (!phrase) {
      // Declared but not parsed: its own fence already reported why, and this
      // line is not the mistake. No second diagnostic — but the loop is still
      // not the arrangement the document describes, so it does not compile.
      if (opts.declaredPhrases?.has(phraseId)) {
        incomplete = true;
        continue;
      }
      const known = [...(opts.declaredPhrases ?? Object.keys(opts.phrases ?? {}))];
      sink.push(
        { line: line.n, col: phraseCol },
        `undefined phrase "${phraseId}"` + (known.length ? ` (known: ${known.join(', ')})` : ''),
      );
      continue;
    }

    const repeats = bars / phrase.bars;
    if (!Number.isInteger(repeats) || repeats < 1) {
      sink.push(
        { line: line.n, col: phraseCol },
        `loop is ${bars} bar${bars === 1 ? '' : 's'} but phrase "${phraseId}" is ${phrase.bars} — the loop length must be a multiple of the phrase length`,
      );
      continue;
    }

    const lineMeta: LoopLineMeta = { trackId, track, phraseId, repeats, cellsPerBeat: phrase.cellsPerBeat };
    if (opts.section !== undefined) lineMeta.section = opts.section;
    if (line.inherited) lineMeta.inherited = true;
    lineMetas.push(lineMeta);
    emitPhrase(phrase, track, repeats, spb, opts.sampleRate, lengthSamples, events, sink, {
      line: line.n,
      col: phraseCol,
    });
  }

  const meta: LoopMeta = { id, bars, bpm, lengthSamples, lines: lineMetas };
  if (!sink.ok || incomplete) return { loop: null, meta, bindings, errors: sink.errors };

  return { loop: { lengthSamples, events: sortEvents(events) }, meta, bindings, errors: [] };
}

/** noteOff before noteOn on the same sample; emission order breaks the rest. */
function sortEvents(events: LoopEvent[]): LoopEvent[] {
  return events
    .map((event, index) => ({ event, index }))
    .sort((a, b) =>
      a.event.offsetSamples - b.event.offsetSamples ||
      b.event.kind - a.event.kind ||
      a.index - b.index)
    .map((e) => e.event);
}

// ------------------------------------------------------------ phrase → events

function emitPhrase(
  phrase: Phrase,
  track: number,
  repeats: number,
  samplesPerBeatValue: number,
  sampleRate: number,
  lengthSamples: number,
  out: LoopEvent[],
  sink: ErrorSink,
  pos: Pos,
): void {
  const cellSamples = samplesPerBeatValue / phrase.cellsPerBeat;
  const tonic = keyToPitchClass(phrase.key) ?? 0;

  for (let repeat = 0; repeat < repeats; repeat++) {
    const base = repeat * phrase.totalCells * cellSamples;

    for (const note of phrase.notes) {
      const row = phrase.rows[note.row] as PhraseRow;
      const gestures = resolveGestures(phrase, note);
      const velocity = clamp01(gestures.vel ?? DEFAULT_VELOCITY);
      const gate = gestures.gate ?? 1;
      const nudge = (gestures.nudge ?? 0) + rollOffset(phrase, note, gestures.roll);

      const start = base + note.onset * cellSamples + nudge * sampleRate;
      const sounding = note.length * cellSamples * gate;
      const on = clampSample(Math.round(start), lengthSamples);
      const off = clampSample(Math.max(Math.round(start + sounding) - 1, on), lengthSamples);

      if (!gestures.gliss) {
        out.push(event(on, track, 0, row.midi, velocity, PATCH_GLIDE, 0));
        out.push(event(off, track, 1, row.midi, 0, PATCH_GLIDE, 0));
        continue;
      }

      // A glissando is two note_ons on one voice: the note itself, then its
      // destination with a glide time and the legato flag, so the amplitude
      // envelope does not retrigger and the slide is heard as one note (§10).
      const target = glissTarget(phrase, note, tonic, sink, pos);
      if (target === null) continue;
      const slideCells = gestures.gliss.cells ?? cellsToNextOnset(phrase, note);
      const glide = (slideCells * cellSamples) / sampleRate;

      out.push(event(on, track, 0, row.midi, velocity, PATCH_GLIDE, 0));
      out.push(event(on, track, 0, target, velocity, glide, 1));
      out.push(event(off, track, 1, target, 0, PATCH_GLIDE, 0));
      // Until the engine takes the legato flag (Track B), the first note_on is
      // a voice of its own; releasing it here keeps a slide from droning.
      out.push(event(off, track, 1, row.midi, 0, PATCH_GLIDE, 0));
    }
  }
}

function event(
  offsetSamples: number,
  track: number,
  kind: 0 | 1,
  note: number,
  velocity: number,
  glideS: number,
  legato: 0 | 1,
): LoopEvent {
  return { offsetSamples, track, kind, note, velocity, glideS, legato };
}

/**
 * `roll` offsets the members of a group in turn: `+` from the bottom up, `-`
 * from the top down. The written time is when the first of them sounds.
 */
function rollOffset(phrase: Phrase, note: PhraseNote, roll: number | undefined): number {
  if (roll === undefined || roll === 0) return 0;
  const members = groupMembers(phrase, note);
  if (members.length < 2) return 0;
  const fromTop = members.findIndex((n) => n.row === note.row);
  const step = roll > 0 ? members.length - 1 - fromTop : fromTop;
  return step * Math.abs(roll);
}

/**
 * Where a glissando lands. An interval target moves the note by that much; a
 * row target slides to that pitch — and applied to a group, every member moves
 * by the interval the group's top note would travel, so the two chords need not
 * have the same number of notes (§4).
 */
function glissTarget(
  phrase: Phrase,
  note: PhraseNote,
  tonic: number,
  sink: ErrorSink,
  pos: Pos,
): number | null {
  const gliss = resolveGestures(phrase, note).gliss;
  if (!gliss) return null;
  const row = phrase.rows[note.row] as PhraseRow;

  if (gliss.to.kind === 'interval') return clampMidi(row.midi + gliss.to.semitones);

  const resolved = resolveRowLabel(gliss.to.label, { tonic, scale: phrase.scale });
  if (!resolved.ok) {
    sink.push(pos, `gliss target: ${resolved.reason}`);
    return null;
  }
  const lead = groupMembers(phrase, note)[0] as PhraseNote;
  const leadMidi = (phrase.rows[lead.row] as PhraseRow).midi;
  return clampMidi(row.midi + (resolved.midi - leadMidi));
}

/** `cells` defaults to the distance to the next onset in the same row. */
function cellsToNextOnset(phrase: Phrase, note: PhraseNote): number {
  let next = phrase.totalCells;
  for (const other of phrase.notes) {
    if (other.row !== note.row) continue;
    if (other.onset > note.onset && other.onset < next) next = other.onset;
  }
  return Math.max(1, next - note.onset);
}

// -------------------------------------------------------------------- helpers

function clampSample(v: number, lengthSamples: number): number {
  return Math.max(0, Math.min(v, Math.max(lengthSamples - 1, 0)));
}

function clampMidi(v: number): number {
  return Math.max(0, Math.min(127, v));
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function readPositive(raw: string | undefined, fallback: number, field: string, pos: Pos, sink: ErrorSink): number {
  if (raw === undefined) return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) {
    sink.push(pos, `${field} must be a positive number, got "${raw}"`);
    return fallback;
  }
  return v;
}
