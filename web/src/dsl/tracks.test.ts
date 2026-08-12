// v0.3 multi-track: one ```synth fence per track, loop lines bound by id.

import { describe, it, expect } from 'vitest';
import { compile } from './compile.ts';
import { parseLoop } from './loop.ts';
import { parseSynth } from './synth.ts';
import { DEFAULT_DOC } from '../defaultDoc.ts';
import { OSC_A_BASE, OSC_B_BASE, OSC_ENABLED, NOISE_BASE, NOISE_ENABLED, MAX_TRACKS } from '../shared/params.ts';

const SR = 48000;
const F = '```';

/** Build a document out of (id, body) synth fences plus an optional loop. */
function doc(fences: [string, string][], loop?: string, loopAttrs = 'bars=1 bpm=120'): string {
  const parts = fences.map(([id, body]) => `${F}synth id=${id}\n${body}\n${F}`);
  if (loop !== undefined) parts.push(`${F}loop ${loopAttrs}\n${loop}\n${F}`);
  return parts.join('\n\n');
}

const SAW = 'osc:\n  - { table: basic/saw }';

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
    const r = compile(doc([['a', body], ['b', body]], 'a: C3 . . .', 'bars=1 bpm=126'), SR);
    expect(r.errors).toEqual([]);
    for (const t of r.tracks) expect(t.ir.lfo1.rateHz).toBeCloseTo(126 / 60, 9);
  });
});

// --------------------------------------------------------------- loop lines

describe('multi-line loop', () => {
  it('binds each line to its synth fence and tags events with the track', () => {
    const r = compile(
      doc([['lead', SAW], ['bass', SAW], ['kick', SAW]], ['lead: C4 . . .', 'bass: . . C2 .', 'kick: C1 . . .'].join('\n')),
      SR,
    );
    expect(r.errors).toEqual([]);
    const ons = r.loop!.events.filter((e) => e.kind === 0);
    expect(ons.map((e) => [e.track, e.note])).toEqual([
      [0, 60], // lead C4 at cell 0
      [2, 24], // kick C1 at cell 0
      [1, 36], // bass C2 at cell 2
    ]);
  });

  it('lets a synth have no loop line (silent track)', () => {
    const r = compile(doc([['lead', SAW], ['pad', SAW]], 'lead: C4 . . .'), SR);
    expect(r.errors).toEqual([]);
    expect(r.trackCount).toBe(2);
    expect(r.loop!.events.every((e) => e.track === 0)).toBe(true);
  });

  it('rejects a line whose id has no synth fence', () => {
    const r = compile(doc([['lead', SAW]], ['lead: C4 . . .', 'ghost: C2 . . .'].join('\n')), SR);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.message).toMatch(/unknown track "ghost"/);
    expect(r.errors[0]!.message).toMatch(/known: lead/);
    expect(r.loop).toBeUndefined(); // keep the last valid loop
  });

  it('reports the unknown id at its line and column', () => {
    const md = ['# doc', '', `${F}synth id=lead`, SAW, F, '', `${F}loop bars=1 bpm=120`, 'lead: C4 . . .', 'ghost: C2 . . .', F].join(
      '\n',
    );
    // SAW spans two lines, so `ghost:` is the 10th line of the document.
    expect(md.split('\n')[9]).toBe('ghost: C2 . . .');
    const r = compile(md, SR);
    expect(r.errors[0]!.line).toBe(10);
    expect(r.errors[0]!.col).toBe(1);
  });

  it('infers cells-per-beat independently per line', () => {
    const sixteen = '. C4 . C4 . C4 . C4 . C4 . C4 . C4 . C4'; // 16 cells = 16ths
    const eight = 'C2 . C2 . C2 . C2 .'; // 8 cells = 8ths
    const r = compile(doc([['lead', SAW], ['bass', SAW]], [`lead: ${sixteen}`, `bass: ${eight}`].join('\n')), SR);
    expect(r.errors).toEqual([]);
    expect(r.loopMeta!.lines).toEqual([
      { trackId: 'lead', track: 0, cells: 16, cellsPerBeat: 4 },
      { trackId: 'bass', track: 1, cells: 8, cellsPerBeat: 2 },
    ]);

    // Both lines span the same loop, so the grids line up: at 120bpm/48kHz a
    // beat is 24000 samples — the 8th-note bass hits every 12000.
    expect(r.loop!.lengthSamples).toBe(96000);
    const bassOns = r.loop!.events.filter((e) => e.track === 1 && e.kind === 0);
    expect(bassOns.map((e) => e.offsetSamples)).toEqual([0, 24000, 48000, 72000]);
    const leadOns = r.loop!.events.filter((e) => e.track === 0 && e.kind === 0);
    expect(leadOns[0]!.offsetSamples).toBe(6000); // second 16th
  });

  it('merges every line into one event list sorted by offset', () => {
    const r = compile(
      doc([['a', SAW], ['b', SAW]], ['a: C4 . C4 . C4 . C4 .', 'b: . C2 . C2 . C2 . C2'].join('\n')),
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
    const r = compile(doc([['lead', SAW]], ['lead: C4 . . .', 'lead: C3 . . .'].join('\n')), SR);
    expect(r.errors[0]!.message).toMatch(/duplicate loop line for track "lead"/);
  });

  it('numbers lines in order when parsed standalone (no trackIds)', () => {
    const r = parseLoop(['a: C4 . . .', 'b: C2 . . .'].join('\n'), { bars: '1', bpm: '120' }, { sampleRate: SR });
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

  it('has a loop line per track on a 16th grid', () => {
    expect(r.loopMeta!.bars).toBe(1);
    expect(r.loopMeta!.lines.map((l) => [l.trackId, l.track, l.cells, l.cellsPerBeat])).toEqual([
      ['lead', 0, 16, 4],
      ['bass', 1, 16, 4],
      ['kick', 2, 16, 4],
      ['hat', 3, 16, 4],
    ]);
  });

  it('puts the kick four-on-the-floor', () => {
    const beat = (60 / 126) * SR;
    const kicks = r.loop!.events.filter((e) => e.track === 2 && e.kind === 0);
    expect(kicks).toHaveLength(4);
    kicks.forEach((e, i) => expect(e.offsetSamples).toBe(Math.round(i * beat)));
    expect(kicks.every((e) => e.note === 24)).toBe(true); // C1
  });

  it('keeps the lead chords and the noise-only hat', () => {
    const leadOns = r.loop!.events.filter((e) => e.track === 0 && e.kind === 0);
    expect(leadOns).toHaveLength(6); // two triads
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
