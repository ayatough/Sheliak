// v0.3 multi-track: one ```synth fence per track, loop lines bound by id.

import { describe, it, expect } from 'vitest';
import { compile } from './compile.ts';
import { parseLoop } from './loop.ts';
import { parsePhrase } from './phrase.ts';
import { formatPhrase } from './format.ts';
import { parseSynth } from './synth.ts';
import { DEFAULT_DOC } from '../defaultDoc.ts';
import { OSC_A_BASE, OSC_B_BASE, OSC_ENABLED, NOISE_BASE, NOISE_ENABLED, MAX_TRACKS } from '../shared/params.ts';

const SR = 48000;
const F = '```';

/**
 * Build a document out of (id, body) synth fences, the phrases the loop refers
 * to, and an optional loop fence.
 */
function doc(
  fences: [string, string][],
  loop?: string,
  loopAttrs = 'bars=1 bpm=120',
  phrases: [string, string][] = [],
): string {
  const parts = fences.map(([id, body]) => `${F}synth id=${id}\n${body}\n${F}`);
  for (const [id, grid] of phrases) {
    parts.push(`${F}phrase id=${id} res=1/16 bars=1\ngrid:\n${grid}\n${F}`);
  }
  if (loop !== undefined) parts.push(`${F}loop ${loopAttrs}\n${loop}\n${F}`);
  return parts.join('\n\n');
}

const SAW = 'osc:\n  - { table: basic/saw }';
/** Phrases used by the loop-binding tests, in the absolute-pitch namespace. */
const PHRASES: [string, string][] = [
  ['down', '  C4 |o...............|'],
  ['up', '  C2 |........o.......|'],
  ['pulse', '  C1 |o...o...o...o...|'],
  ['off', '  C2 |....o...........|'],
];

// ----------------------------------------------------------- fence → track

describe('multi-fence compile', () => {
  it('indexes tracks by order of appearance', () => {
    const r = compile(doc([['lead', SAW], ['bass', SAW], ['kick', SAW]]), SR);
    expect(r.errors).toEqual([]);
    expect(r.trackCount).toBe(3);
    expect(r.tracks.map((t) => [t.id, t.track])).toEqual([
      ['lead', 0],
      ['bass', 1],
      ['kick', 2],
    ]);
    // Each track gets its own params block.
    expect(r.tracks[0]!.params).not.toBe(r.tracks[1]!.params);
    expect(r.patch).toBe(r.tracks[0]);
  });

  it('names id-less fences by index so they still get a track', () => {
    const r = compile(`${F}synth\n${SAW}\n${F}\n\n${F}synth\n${SAW}\n${F}`, SR);
    expect(r.errors).toEqual([]);
    expect(r.tracks.map((t) => t.id)).toEqual(['track0', 'track1']);
  });

  it('rejects duplicate synth ids', () => {
    const r = compile(doc([['lead', SAW], ['lead', SAW]]), SR);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.message).toMatch(/duplicate synth id "lead"/);
  });

  it('rejects more than 8 synth fences, on the 9th', () => {
    const nine: [string, string][] = [];
    for (let i = 0; i < 9; i++) nine.push([`t${i}`, SAW]);
    const r = compile(doc(nine), SR);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.message).toMatch(/at most 8 synth fences/);
    // The first 8 still compile.
    expect(r.trackCount).toBe(MAX_TRACKS);
    expect(r.tracks).toHaveLength(MAX_TRACKS);
  });

  it('isolates errors: a broken fence does not block the others', () => {
    const r = compile(
      doc([
        ['lead', SAW],
        ['bass', 'filter: { cutoff: 800 }'], // bare number → error
        ['kick', SAW],
      ]),
      SR,
    );
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.message).toMatch(/bare numbers are not allowed/);
    // Track 1 produced nothing, but 0 and 2 keep their indices and compile.
    expect(r.trackCount).toBe(3);
    expect(r.tracks.map((t) => t.track)).toEqual([0, 2]);
  });

  it('reserves the index of a failed fence so later tracks do not shift', () => {
    const r = compile(doc([['a', 'filter: { cutoff: 800 }'], ['b', SAW]]), SR);
    expect(r.tracks).toHaveLength(1);
    expect(r.tracks[0]!.track).toBe(1);
    expect(r.tracks[0]!.id).toBe('b');
  });

  it('resolves musical units against the loop bpm for every track', () => {
    const body = 'lfo:\n  1: { wave: tri, rate: 1/4 }';
    const r = compile(doc([['a', body], ['b', body]], 'a: down', 'bars=1 bpm=126', PHRASES), SR);
    expect(r.errors).toEqual([]);
    for (const t of r.tracks) expect(t.ir.lfo1.rateHz).toBeCloseTo(126 / 60, 9);
  });
});

// --------------------------------------------------------------- loop lines

describe('the loop as an arrangement', () => {
  it('binds each line to its synth fence and tags events with the track', () => {
    const r = compile(
      doc(
        [['lead', SAW], ['bass', SAW], ['kick', SAW]],
        ['lead: down', 'bass: up', 'kick: pulse'].join('\n'),
        'bars=1 bpm=120',
        PHRASES,
      ),
      SR,
    );
    expect(r.errors).toEqual([]);
    const ons = r.loop!.events.filter((e) => e.kind === 0);
    expect(ons.map((e) => [e.track, e.note, e.offsetSamples])).toEqual([
      [0, 60, 0], // lead C4 at cell 0
      [2, 24, 0], // kick C1 at cell 0
      [1, 36, 48000], // bass C2 at cell 8 = beat 3
      [2, 24, 24000],
      [2, 24, 48000],
      [2, 24, 72000],
    ].sort((a, b) => (a[2] as number) - (b[2] as number) || (a[0] as number) - (b[0] as number)));
  });

  it('lets a synth have no loop line (silent track)', () => {
    const r = compile(doc([['lead', SAW], ['pad', SAW]], 'lead: down', 'bars=1 bpm=120', PHRASES), SR);
    expect(r.errors).toEqual([]);
    expect(r.trackCount).toBe(2);
    expect(r.loop!.events.every((e) => e.track === 0)).toBe(true);
  });

  it('rejects a line whose id has no synth fence', () => {
    const r = compile(
      doc([['lead', SAW]], ['lead: down', 'ghost: up'].join('\n'), 'bars=1 bpm=120', PHRASES),
      SR,
    );
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.message).toMatch(/unknown track "ghost"/);
    expect(r.errors[0]!.message).toMatch(/known: lead/);
    expect(r.loop).toBeUndefined(); // keep the last valid loop
  });

  it('reports the unknown id at its line and column', () => {
    const md = [
      '# doc', // 1
      '', // 2
      `${F}synth id=lead`, // 3
      SAW, // 4-5
      F, // 6
      '', // 7
      `${F}phrase id=down res=1/16 bars=1`, // 8
      'grid:', // 9
      '  C4 |o...............|', // 10
      F, // 11
      '', // 12
      `${F}loop bars=1 bpm=120`, // 13
      'lead: down', // 14
      'ghost: down', // 15
      F,
    ].join('\n');
    expect(md.split('\n')[14]).toBe('ghost: down');
    const r = compile(md, SR);
    expect(r.errors[0]!.line).toBe(15);
    expect(r.errors[0]!.col).toBe(1);
  });

  it('lets phrases on different tracks use different resolutions', () => {
    const md = [
      `${F}synth id=lead`,
      SAW,
      F,
      `${F}synth id=bass`,
      SAW,
      F,
      `${F}phrase id=fast res=1/16 bars=1`,
      'grid:',
      '  C4 |.o.o.o.o.o.o.o.o|',
      F,
      `${F}phrase id=slow res=1/8 bars=1`,
      'grid:',
      '  C2 |o.o.o.o.|',
      F,
      `${F}loop bars=1 bpm=120`,
      'lead: fast',
      'bass: slow',
      F,
    ].join('\n');
    const r = compile(md, SR);
    expect(r.errors).toEqual([]);
    expect(r.loopMeta!.lines).toEqual([
      { trackId: 'lead', track: 0, phraseId: 'fast', repeats: 1, cellsPerBeat: 4 },
      { trackId: 'bass', track: 1, phraseId: 'slow', repeats: 1, cellsPerBeat: 2 },
    ]);

    // Both phrases span the same loop: at 120bpm/48kHz a beat is 24000 samples,
    // so the 8th-note bass hits every 12000 and the lead's first 16th is 6000.
    expect(r.loop!.lengthSamples).toBe(96000);
    const bassOns = r.loop!.events.filter((e) => e.track === 1 && e.kind === 0);
    expect(bassOns.map((e) => e.offsetSamples)).toEqual([0, 24000, 48000, 72000]);
    const leadOns = r.loop!.events.filter((e) => e.track === 0 && e.kind === 0);
    expect(leadOns[0]!.offsetSamples).toBe(6000);
  });

  it('merges every line into one event list sorted by offset', () => {
    const r = compile(
      doc([['a', SAW], ['b', SAW]], ['a: pulse', 'b: off'].join('\n'), 'bars=1 bpm=120', PHRASES),
      SR,
    );
    expect(r.errors).toEqual([]);
    const ev = r.loop!.events;
    for (let i = 1; i < ev.length; i++) {
      expect(ev[i]!.offsetSamples).toBeGreaterThanOrEqual(ev[i - 1]!.offsetSamples);
    }
    expect(new Set(ev.map((e) => e.track))).toEqual(new Set([0, 1]));
  });

  it('rejects two loop lines for the same track', () => {
    const r = compile(
      doc([['lead', SAW]], ['lead: down', 'lead: up'].join('\n'), 'bars=1 bpm=120', PHRASES),
      SR,
    );
    expect(r.errors[0]!.message).toMatch(/duplicate loop line for track "lead"/);
  });

  it('numbers lines in order when parsed standalone (no trackIds)', () => {
    const phrases = {
      down: parsePhrase('grid:\n  C4 |o...............|', { id: 'down' }).phrase!,
    };
    const r = parseLoop(['a: down', 'b: down'].join('\n'), { bars: '1', bpm: '120' }, { sampleRate: SR, phrases });
    expect(r.errors).toEqual([]);
    expect(r.meta!.lines.map((l) => l.track)).toEqual([0, 1]);
  });
});

// ------------------------------------------------------------ noise-only osc

describe('osc: [] (noise-only patches)', () => {
  it('disables both oscillators when paired with a noise section', () => {
    const r = parseSynth('osc: []\nnoise: { level: -6dB, color: white }', {}, { bpm: 120 });
    expect(r.errors).toEqual([]);
    expect(r.params![OSC_A_BASE + OSC_ENABLED]).toBe(0);
    expect(r.params![OSC_B_BASE + OSC_ENABLED]).toBe(0);
    expect(r.params![NOISE_BASE + NOISE_ENABLED]).toBe(1);
  });

  it('errors when the patch would be silent', () => {
    const r = parseSynth('osc: []\nfilter: { cutoff: 8kHz }', {}, { bodyStartLine: 5, bpm: 120 });
    expect(r.ir).toBeNull();
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.message).toMatch(/patch produces no sound/);
    expect(r.errors[0]!).toMatchObject({ line: 5, col: 1 });
  });

  it('omitting osc: still gives the default single saw', () => {
    const r = parseSynth('filter: { cutoff: 8kHz }', {}, { bpm: 120 });
    expect(r.errors).toEqual([]);
    expect(r.params![OSC_A_BASE + OSC_ENABLED]).toBe(1);
    expect(r.params![OSC_B_BASE + OSC_ENABLED]).toBe(0);
  });
});

// ------------------------------------------------------------- default doc

describe('the default document', () => {
  const r = compile(DEFAULT_DOC, SR);

  it('compiles four tracks clean', () => {
    expect(r.errors).toEqual([]);
    expect(r.trackCount).toBe(4);
    expect(r.tracks.map((t) => t.id)).toEqual(['lead', 'bass', 'kick', 'hat']);
    expect(r.bpm).toBe(126);
  });

  it('binds every track to a phrase on a 16th grid', () => {
    expect(r.loopMeta!.bars).toBe(1);
    expect(r.loopMeta!.lines).toEqual([
      { trackId: 'lead', track: 0, phraseId: 'verse-lead', repeats: 1, cellsPerBeat: 4 },
      { trackId: 'bass', track: 1, phraseId: 'verse-bass', repeats: 1, cellsPerBeat: 4 },
      { trackId: 'kick', track: 2, phraseId: 'four-floor', repeats: 1, cellsPerBeat: 4 },
      { trackId: 'hat', track: 3, phraseId: 'offbeats', repeats: 1, cellsPerBeat: 4 },
    ]);
  });

  it('opens with canonical phrase text', () => {
    for (const phrase of Object.values(r.phrases)) {
      const fence = r.fences.find((f) => f.lang === 'phrase' && f.attrs['id'] === phrase.id)!;
      expect(fence.body).toBe(formatPhrase(phrase));
    }
  });

  it('puts the kick four-on-the-floor', () => {
    const beat = (60 / 126) * SR;
    const kicks = r.loop!.events.filter((e) => e.track === 2 && e.kind === 0);
    expect(kicks).toHaveLength(4);
    kicks.forEach((e, i) => expect(e.offsetSamples).toBe(Math.round(i * beat)));
    expect(kicks.every((e) => e.note === 24)).toBe(true); // the kit's kick, C1
  });

  it('keeps the lead chords, strummed by the roll gesture', () => {
    const leadOns = r.loop!.events.filter((e) => e.track === 0 && e.kind === 0);
    expect(leadOns).toHaveLength(6); // two triads
    // C minor over the first two beats: C4, Eb4, G4.
    const first = leadOns.filter((e) => e.offsetSamples < (60 / 126) * SR);
    expect(first.map((e) => e.note)).toEqual([60, 63, 67]);
    // `roll: +9ms` spreads them from the bottom up.
    expect(first.map((e) => e.offsetSamples)).toEqual([0, Math.round(0.009 * SR), Math.round(0.018 * SR)]);
  });

  it('accents the hat where the detail block says so', () => {
    const hats = r.loop!.events.filter((e) => e.track === 3 && e.kind === 0);
    expect(hats).toHaveLength(8);
    expect(hats.filter((e) => Math.abs(e.velocity - 0.85) < 1e-6)).toHaveLength(2); // beat 2
    expect(hats.filter((e) => Math.abs(e.velocity - 0.55) < 1e-6)).toHaveLength(6);
  });

  it('keeps the noise-only hat patch', () => {
    const hat = r.tracks.find((t) => t.id === 'hat')!;
    expect(hat.ir.noise.enabled).toBe(true);
    expect(hat.ir.osc.every((o) => !o.enabled)).toBe(true);
    expect(hat.ir.filter.type).toBe('hp12');
  });

  it('drives the kick pitch from the filter envelope', () => {
    const kick = r.tracks.find((t) => t.id === 'kick')!;
    expect(kick.ir.mod).toEqual([{ from: 'env.filter', to: 'pitch', amount: 3600 }]);
  });

  it('only puts fx on the lead', () => {
    expect(r.tracks.find((t) => t.id === 'lead')!.ir.fx.map((f) => f.type)).toEqual(['reverb', 'comp']);
    for (const id of ['bass', 'kick', 'hat']) {
      expect(r.tracks.find((t) => t.id === id)!.ir.fx).toEqual([]);
    }
  });
});
