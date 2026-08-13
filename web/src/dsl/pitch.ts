// Row labels → pitch (docs/syntax.md, docs/workstreams.md §2).
//
// A `phrase` row is named in exactly one of three namespaces, and the spelling
// alone decides which:
//
//   degree      1, b3, #4, 5', b7,     resolved through `key` and `scale`
//   pitch       C4, Eb2, F#5           absolute, resolves to itself
//   percussion  kick, sd, hh           resolved through the kit map below
//
// **Case is significant**: `b3` is a minor third, `B3` is the note B in octave 3.
// That single rule is the whole of the disambiguation.

/** Degree `1` with no octave mark resolves inside this octave (C3 = MIDI 48). */
export const DEGREE_BASE_OCTAVE = 3;

const PITCH_CLASS: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

const NOTE_RE = /^([A-Ga-g])([#b]*)(-1|\d)$/;
const KEY_RE = /^([A-Ga-g])([#b]*)$/;
const DEGREE_RE = /^([b#]?)(\d+)(['’,]*)$/;
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_.\-]*$/;

/** The reference an accidental alters: the natural (major) degrees. */
const NATURAL_DEGREES = [0, 2, 4, 5, 7, 9, 11] as const;

/** Semitone offsets from the tonic, one entry per degree. */
export const SCALES: Record<string, readonly number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  ionian: [0, 2, 4, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  minor: [0, 2, 3, 5, 7, 8, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

/**
 * Percussion names → MIDI note. Drums are patches here, not samples, so the
 * number only matters to a patch that tracks pitch (a kick's sine sweep does,
 * a noise hat does not).
 */
export const KIT: Record<string, number> = {
  kick: 24, // C1
  bd: 24,
  rim: 25,
  snare: 26, // D1
  sd: 26,
  clap: 27,
  cp: 27,
  lt: 29, // low tom
  hh: 30, // F#1, closed hat
  ch: 30,
  mt: 33,
  oh: 34, // open hat
  ht: 36,
  crash: 37,
  cr: 37,
  ride: 39,
  rd: 39,
  perc: 40,
  shaker: 42,
  sh: 42,
};

export type RowNamespace = 'degree' | 'pitch' | 'percussion';

export type RowLabel =
  | { namespace: 'degree'; degree: number; accidental: number; octave: number }
  | { namespace: 'pitch'; midi: number }
  | { namespace: 'percussion'; name: string };

/** Note name → MIDI number (C4 = 60). Null when malformed or out of range. */
export function noteToMidi(name: string): number | null {
  const m = NOTE_RE.exec(name);
  if (!m) return null;
  const pc = PITCH_CLASS[(m[1] as string).toLowerCase()];
  if (pc === undefined) return null;
  const octave = parseInt(m[3] as string, 10);
  const midi = (octave + 1) * 12 + pc + accidentalValue(m[2] as string);
  if (midi < 0 || midi > 127) return null;
  return midi;
}

/** Tonic name (`C`, `Eb`, `F#`) → pitch class 0..11, or null. */
export function keyToPitchClass(key: string): number | null {
  const m = KEY_RE.exec(key.trim());
  if (!m) return null;
  const pc = PITCH_CLASS[(m[1] as string).toLowerCase()];
  if (pc === undefined) return null;
  return (((pc + accidentalValue(m[2] as string)) % 12) + 12) % 12;
}

function accidentalValue(marks: string): number {
  let v = 0;
  for (const c of marks) v += c === '#' ? 1 : -1;
  return v;
}

/**
 * Classify a row label by its spelling alone. Returns null for a label that is
 * in no namespace (the grid parser turns that into "unknown row label").
 */
export function parseRowLabel(label: string): RowLabel | null {
  const deg = DEGREE_RE.exec(label);
  if (deg) {
    const accidental = deg[1] === '#' ? 1 : deg[1] === 'b' ? -1 : 0;
    const degree = parseInt(deg[2] as string, 10);
    let octave = 0;
    for (const c of deg[3] as string) octave += c === ',' ? -1 : 1;
    return { namespace: 'degree', degree, accidental, octave };
  }
  if (/^[A-G]/.test(label)) {
    const midi = noteToMidi(label);
    return midi === null ? null : { namespace: 'pitch', midi };
  }
  if (IDENT_RE.test(label)) return { namespace: 'percussion', name: label };
  return null;
}

export interface PitchContext {
  /** Tonic pitch class, 0..11. */
  tonic: number;
  /** A key of `SCALES`. */
  scale: string;
}

export type ResolveResult = { ok: true; midi: number } | { ok: false; reason: string };

/** Row label → MIDI note, in the phrase's key and scale. */
export function resolveRowLabel(label: string, ctx: PitchContext): ResolveResult {
  const parsed = parseRowLabel(label);
  if (!parsed) return { ok: false, reason: `unknown row label "${label}"` };

  switch (parsed.namespace) {
    case 'pitch':
      return { ok: true, midi: parsed.midi };
    case 'percussion': {
      const midi = KIT[parsed.name];
      if (midi === undefined) {
        return { ok: false, reason: `unknown percussion row "${parsed.name}" — not in the kit map` };
      }
      return { ok: true, midi };
    }
    case 'degree': {
      const steps = SCALES[ctx.scale];
      if (!steps) return { ok: false, reason: `unknown scale "${ctx.scale}"` };
      if (parsed.degree < 1 || parsed.degree > steps.length) {
        return {
          ok: false,
          reason: `degree ${parsed.degree} is outside ${ctx.scale} (1..${steps.length})`,
        };
      }
      // A plain degree follows the scale. An accidental spells an interval
      // instead — `b3` is a minor third and `b7` a minor seventh whatever the
      // scale is — which is what makes `1 b3 5` a minor triad in C major and in
      // C minor alike, and what the §2 example in workstreams.md writes.
      const natural = (ctx.scale === 'chromatic' ? steps : NATURAL_DEGREES)[parsed.degree - 1] as number;
      const step = parsed.accidental === 0 ? (steps[parsed.degree - 1] as number) : natural;
      const midi =
        (DEGREE_BASE_OCTAVE + 1 + parsed.octave) * 12 + ctx.tonic + step + parsed.accidental;
      if (midi < 0 || midi > 127) return { ok: false, reason: `row "${label}" is outside MIDI range` };
      return { ok: true, midi };
    }
  }
}

/** The namespace a label belongs to, without resolving it. */
export function labelNamespace(label: string): RowNamespace | null {
  return parseRowLabel(label)?.namespace ?? null;
}

/**
 * Move a degree row label by `steps` scale degrees. An altered degree lands on
 * the scale — `b3` moved up one step in C minor is `4` (Eb → F), not `b4` —
 * because the alteration described where that note sat, not where the next one
 * does. Absolute-pitch rows move by semitones; percussion rows never move.
 */
export function transposeLabel(label: string, steps: number, scale: string): string | null {
  const parsed = parseRowLabel(label);
  if (!parsed) return null;
  if (parsed.namespace === 'percussion') return null;
  if (parsed.namespace === 'pitch') {
    const midi = parsed.midi + steps;
    if (midi < 0 || midi > 127) return null;
    return midiToLabel(midi, label.includes('b'));
  }
  const size = (SCALES[scale] ?? (SCALES['major'] as readonly number[])).length;
  const zero = parsed.degree - 1 + steps;
  const degree = ((zero % size) + size) % size;
  const octave = parsed.octave + Math.floor(zero / size);
  return `${degree + 1}${octaveMarks(octave)}`;
}

export function octaveMarks(octave: number): string {
  if (octave === 0) return '';
  return (octave > 0 ? "'" : ',').repeat(Math.abs(octave));
}

const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

/** MIDI number → an absolute-pitch row label (C4 = 60). */
export function midiToLabel(midi: number, preferFlat = false): string {
  const n = Math.max(0, Math.min(127, Math.round(midi)));
  const pc = ((n % 12) + 12) % 12;
  return `${(preferFlat ? FLAT_NAMES : SHARP_NAMES)[pc]}${Math.floor(n / 12) - 1}`;
}
