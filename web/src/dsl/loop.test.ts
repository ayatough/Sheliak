// A5: the `loop` fence as the arrangement layer (docs/workstreams.md §6).

import { describe, it, expect } from 'vitest';
import { parseLoop, PATCH_GLIDE, DEFAULT_VELOCITY, type LoopEvent } from './loop.ts';
import { parsePhrase, type Phrase } from './phrase.ts';
import { compile } from './compile.ts';

const SR = 48000;
const BEAT = 24000; // 120bpm at 48kHz
const CELL = BEAT / 4; // 1/16 grid

function phrase(body: string, attrs: Record<string, string> = {}): Phrase {
  const r = parsePhrase(body, { id: 'p', ...attrs });
  expect(r.errors).toEqual([]);
  return r.phrase as Phrase;
}

const FOUR_FLOOR = phrase(['grid:', '  kick |o...o...o...o...|'].join('\n'));
const OFFBEATS = phrase(['grid:', '  hh |.o.o.o.o.o.o.o.o|'].join('\n'));

function ons(events: LoopEvent[], track?: number): LoopEvent[] {
  return events.filter((e) => e.kind === 0 && (track === undefined || e.track === track));
}

describe('phrase references', () => {
  const r = parseLoop('kick: four\nhat: off', { id: 'g', bars: '1', bpm: '120' }, {
    sampleRate: SR,
    phrases: { four: FOUR_FLOOR, off: OFFBEATS },
  });

  it('resolves ids and reports what is bound', () => {
    expect(r.errors).toEqual([]);
    expect(r.meta!.lines).toEqual([
      { trackId: 'kick', track: 0, phraseId: 'four', repeats: 1, cellsPerBeat: 4 },
      { trackId: 'hat', track: 1, phraseId: 'off', repeats: 1, cellsPerBeat: 4 },
    ]);
    expect(r.loop!.lengthSamples).toBe(4 * BEAT);
  });

  it('places the kick on the beat and the hat between', () => {
    expect(ons(r.loop!.events, 0).map((e) => e.offsetSamples)).toEqual([0, BEAT, 2 * BEAT, 3 * BEAT]);
    expect(ons(r.loop!.events, 1)[0]!.offsetSamples).toBe(CELL);
    expect(ons(r.loop!.events, 0).every((e) => e.note === 24)).toBe(true);
  });

  it('closes a note one sample before its written length ends', () => {
    const offs = r.loop!.events.filter((e) => e.kind === 1 && e.track === 0);
    expect(offs[0]!.offsetSamples).toBe(CELL - 1);
  });

  it('leaves glide and legato alone, so today’s audio is unchanged', () => {
    expect(r.loop!.events.every((e) => e.glideS === PATCH_GLIDE && e.legato === 0)).toBe(true);
    expect(ons(r.loop!.events)[0]!.velocity).toBe(DEFAULT_VELOCITY);
  });

  it('repeats a phrase to fill a longer loop', () => {
    const two = parseLoop('kick: four', { bars: '2', bpm: '120' }, { sampleRate: SR, phrases: { four: FOUR_FLOOR } });
    expect(two.errors).toEqual([]);
    expect(two.meta!.lines[0]!.repeats).toBe(2);
    expect(ons(two.loop!.events).map((e) => e.offsetSamples)).toEqual([0, 1, 2, 3, 4, 5, 6, 7].map((i) => i * BEAT));
  });

  it('scales with the sample rate', () => {
    const r44 = parseLoop('kick: four', { bars: '1', bpm: '124' }, { sampleRate: 44100, phrases: { four: FOUR_FLOOR } });
    expect(r44.loop!.lengthSamples).toBe(Math.round((4 * 60 * 44100) / 124));
  });
});

describe('gestures become timing and velocity', () => {
  const detailed = phrase(
    [
      'grid:',
      "  5' |o-------........|",
      '  1  |o-------....o---|',
      '',
      'detail:',
      '  1.1o : { roll: +10ms, vel: 50% }',
      '  1.4  : { gate: 50%, nudge: -5ms }',
    ].join('\n'),
    { key: 'C', scale: 'minor' },
  );
  const r = parseLoop('lead: p', { bars: '1', bpm: '120' }, { sampleRate: SR, phrases: { p: detailed } });

  it('applies vel', () => {
    expect(r.errors).toEqual([]);
    expect(ons(r.loop!.events)[0]!.velocity).toBeCloseTo(0.5, 6);
  });

  it('rolls a group from the bottom up', () => {
    const chord = ons(r.loop!.events).filter((e) => e.offsetSamples < BEAT);
    // The bottom note keeps the written time; the one above is 10ms later.
    expect(chord.map((e) => [e.note, e.offsetSamples])).toEqual([
      [48, 0],
      [67, Math.round(0.01 * SR)],
    ]);
  });

  it('applies nudge and gate', () => {
    const late = ons(r.loop!.events).find((e) => e.offsetSamples > 2 * BEAT)!;
    expect(late.offsetSamples).toBe(12 * CELL - Math.round(0.005 * SR));
    const off = r.loop!.events.find((e) => e.kind === 1 && e.offsetSamples > late.offsetSamples)!;
    // Four cells written, sounding for half of that.
    expect(off.offsetSamples).toBe(late.offsetSamples + 2 * CELL - 1);
  });
});

describe('gliss (§10)', () => {
  const slide = phrase(
    ['grid:', '  1 |o-------........|', '', 'detail:', '  1.1 : { gliss: { to: +5st, cells: 2 } }'].join('\n'),
  );
  const r = parseLoop('lead: p', { bars: '1', bpm: '120' }, { sampleRate: SR, phrases: { p: slide } });

  it('sounds the note, then its destination with a glide time and legato', () => {
    expect(r.errors).toEqual([]);
    const starts = ons(r.loop!.events);
    expect(starts.map((e) => [e.note, e.legato])).toEqual([
      [48, 0],
      [53, 1],
    ]);
    expect(starts[0]!.glideS).toBe(PATCH_GLIDE);
    expect(starts[1]!.glideS).toBeCloseTo((2 * CELL) / SR, 9);
  });

  it('releases both, so a slide cannot drone on the old ABI', () => {
    const offs = r.loop!.events.filter((e) => e.kind === 1);
    expect(offs.map((e) => e.note).sort()).toEqual([48, 53]);
  });

  it('defaults the slide to the distance to the next onset', () => {
    const p = phrase(
      ['grid:', '  1 |o---o-----------|', '', 'detail:', '  1.1 : { gliss: { to: +2st } }'].join('\n'),
    );
    const rr = parseLoop('lead: p', { bars: '1', bpm: '120' }, { sampleRate: SR, phrases: { p } });
    const target = ons(rr.loop!.events).find((e) => e.legato === 1)!;
    expect(target.glideS).toBeCloseTo((4 * CELL) / SR, 9);
  });
});

describe('loop errors (§9)', () => {
  const parse = (body: string, attrs: Record<string, string>, phrases: Record<string, Phrase>) =>
    parseLoop(body, attrs, { bodyStartLine: 5, sampleRate: SR, phrases });

  it('reports an undefined phrase id', () => {
    const r = parse('kick: nope', { bars: '1' }, { four: FOUR_FLOOR });
    expect(r.loop).toBeNull();
    expect(r.errors[0]!.message).toMatch(/undefined phrase "nope" \(known: four\)/);
    expect(r.errors[0]!.line).toBe(5);
  });

  it('reports an unknown track id', () => {
    const r = parseLoop('ghost: four', { bars: '1' }, {
      sampleRate: SR,
      phrases: { four: FOUR_FLOOR },
      trackIds: { kick: 0 },
    });
    expect(r.errors[0]!.message).toMatch(/unknown track "ghost"/);
  });

  it('reports a loop length that is not a multiple of the phrase length', () => {
    const twoBar = phrase(['grid:', `  kick |${'o...'.repeat(8)}|`].join('\n'), { bars: '2' });
    const r = parse('kick: long', { bars: '1' }, { long: twoBar });
    expect(r.errors[0]!.message).toMatch(/must be a multiple of the phrase length/);
  });

  it('reports two lines for one track', () => {
    const r = parse('kick: four\nkick: four', { bars: '1' }, { four: FOUR_FLOOR });
    expect(r.errors[0]!.message).toMatch(/duplicate loop line/);
  });

  it('rejects note cells left over from the old notation', () => {
    const r = parse('kick: C1 . . .', { bars: '1' }, { four: FOUR_FLOOR });
    expect(r.errors[0]!.message).toMatch(/is not a phrase id/);
  });
});

describe('compile — a whole document', () => {
  const F = '```';
  const DOC = [
    '# doc', // 1
    '', // 2
    `${F}synth id=lead seed=7`, // 3
    'osc:', // 4
    '  - { table: basic/saw, unison: 7, detune: 22c }', // 5
    'lfo:', // 6
    '  1: { wave: tri, rate: 1/4 }', // 7
    F, // 8
    '', // 9
    `${F}phrase id=verse key=C scale=minor res=1/16 bars=1`, // 10
    'grid:', // 11
    "  5' |o---....o---....|", // 12
    '  1  |o-------....o---|', // 13
    F, // 14
    '', // 15
    `${F}loop id=demo bars=1 bpm=124`, // 16
    'lead: verse', // 17
    F, // 18
  ].join('\n');

  it('compiles the synth, the phrase and the loop together', () => {
    const r = compile(DOC, SR);
    expect(r.errors).toEqual([]);
    expect(r.bpm).toBe(124);
    expect(Object.keys(r.phrases)).toEqual(['verse']);
    expect(r.patch!.ir.lfo1.rateHz).toBeCloseTo(124 / 60, 9);
    expect(r.loopMeta!.lines[0]!.phraseId).toBe('verse');
    // Two notes at cell 0, then the second onset of each row.
    expect(ons(r.loop!.events).map((e) => e.note)).toEqual([67, 48, 67, 48]);
  });

  it('reports a phrase error at its line and keeps the rest of the document', () => {
    const broken = DOC.replace("  5' |o---....o---....|", "  5' |o---....o---...|");
    const r = compile(broken, SR);
    expect(r.errors.some((e) => e.line === 12 && /15 cells, expected 16/.test(e.message))).toBe(true);
    // The patch still compiled, so its track keeps playing (Glicol style).
    expect(r.patch).toBeDefined();
    expect(r.loop).toBeUndefined();
  });

  it('rejects two phrases with one id', () => {
    const twice = DOC.replace(`${F}loop id=demo bars=1 bpm=124\nlead: verse\n${F}`,
      `${F}phrase id=verse res=1/16 bars=1\ngrid:\n  1 |o---............|\n${F}`);
    const r = compile(twice, SR);
    expect(r.errors.some((e) => /duplicate phrase id "verse"/.test(e.message))).toBe(true);
  });
});
