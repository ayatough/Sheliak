import { describe, it, expect } from 'vitest';
import { parseLoop, noteToMidi, DEFAULT_VELOCITY } from './loop.ts';
import { compile } from './compile.ts';

const SR = 48000;
const DEMO = 'lead: C3 . Eb3 . | G3 ~ ~ . | Bb3 . . . | C4 ~ ~ ~';

describe('noteToMidi', () => {
  it('anchors C4 at 60', () => {
    expect(noteToMidi('C4')).toBe(60);
    expect(noteToMidi('C3')).toBe(48);
    expect(noteToMidi('A4')).toBe(69);
  });

  it('handles sharps and flats', () => {
    expect(noteToMidi('Eb3')).toBe(51);
    expect(noteToMidi('D#3')).toBe(51);
    expect(noteToMidi('Bb3')).toBe(58);
    expect(noteToMidi('F#4')).toBe(66);
  });

  it('covers C-1..G9', () => {
    expect(noteToMidi('C-1')).toBe(0);
    expect(noteToMidi('G9')).toBe(127);
    expect(noteToMidi('A9')).toBeNull(); // out of MIDI range
  });

  it('rejects junk', () => {
    expect(noteToMidi('H3')).toBeNull();
    expect(noteToMidi('C')).toBeNull();
    expect(noteToMidi('')).toBeNull();
  });
});

describe('parseLoop — demo loop at 124bpm / 48000Hz', () => {
  const r = parseLoop(DEMO, { id: 'demo', bars: '2', bpm: '124' }, { bodyStartLine: 1, sampleRate: SR });

  // 60/124 * 48000 = 23225.806… samples per beat; 16 cells over 8 beats
  // → 2 cells per beat → 11612.903… samples per cell.
  it('infers cells per beat', () => {
    expect(r.errors).toEqual([]);
    expect(r.meta).toMatchObject({ bars: 2, bpm: 124 });
    expect(r.meta!.lines).toEqual([{ trackId: 'lead', track: 0, cells: 16, cellsPerBeat: 2 }]);
  });

  it('computes the loop length in samples', () => {
    expect(r.loop!.lengthSamples).toBe(185806);
  });

  it('emits sample-accurate note events (ties, rests, noteOff at cell end - 1)', () => {
    expect(r.loop!.events).toEqual([
      { offsetSamples: 0, track: 0, kind: 0, note: 48, velocity: DEFAULT_VELOCITY },
      { offsetSamples: 11612, track: 0, kind: 1, note: 48, velocity: 0 },
      { offsetSamples: 23226, track: 0, kind: 0, note: 51, velocity: DEFAULT_VELOCITY },
      { offsetSamples: 34838, track: 0, kind: 1, note: 51, velocity: 0 },
      { offsetSamples: 46452, track: 0, kind: 0, note: 55, velocity: DEFAULT_VELOCITY },
      // G3 is tied across three cells → off at cell 7 end - 1
      { offsetSamples: 81289, track: 0, kind: 1, note: 55, velocity: 0 },
      { offsetSamples: 92903, track: 0, kind: 0, note: 58, velocity: DEFAULT_VELOCITY },
      { offsetSamples: 104515, track: 0, kind: 1, note: 58, velocity: 0 },
      { offsetSamples: 139355, track: 0, kind: 0, note: 60, velocity: DEFAULT_VELOCITY },
      // C4 is tied to the end of the loop
      { offsetSamples: 185805, track: 0, kind: 1, note: 60, velocity: 0 },
    ]);
  });

  it('keeps offsets sorted and inside the loop', () => {
    const ev = r.loop!.events;
    for (let i = 1; i < ev.length; i++) {
      expect(ev[i]!.offsetSamples).toBeGreaterThanOrEqual(ev[i - 1]!.offsetSamples);
    }
    expect(ev[ev.length - 1]!.offsetSamples).toBeLessThan(r.loop!.lengthSamples);
  });

  it('scales with the sample rate (no hardcoding)', () => {
    const r44 = parseLoop(DEMO, { bars: '2', bpm: '124' }, { sampleRate: 44100 });
    expect(r44.loop!.lengthSamples).toBe(Math.round((8 * 60 * 44100) / 124));
  });
});

describe('parseLoop — cells and chords', () => {
  it('treats | as visual only', () => {
    const withBars = parseLoop('x: C3 . . . | . . . .', { bars: '1' }, { sampleRate: SR });
    const without = parseLoop('x: C3 . . . . . . .', { bars: '1' }, { sampleRate: SR });
    expect(withBars.errors).toEqual([]);
    expect(withBars.meta!.lines[0]!.cells).toBe(8);
    expect(withBars.loop!.events).toEqual(without.loop!.events);
  });

  it('parses chords as one cell', () => {
    const r = parseLoop('x: [C3 Eb3 G3] . . .', { bars: '1' }, { sampleRate: SR });
    expect(r.errors).toEqual([]);
    expect(r.meta!.lines[0]!.cells).toBe(4);
    const ons = r.loop!.events.filter((e) => e.kind === 0);
    expect(ons.map((e) => e.note)).toEqual([48, 51, 55]);
    expect(ons.every((e) => e.offsetSamples === 0)).toBe(true);
    // All three notes stop at the end of the first cell.
    const offs = r.loop!.events.filter((e) => e.kind === 1);
    expect(new Set(offs.map((e) => e.offsetSamples)).size).toBe(1);
  });

  it('extends a chord with a tie', () => {
    const r = parseLoop('x: [C3 G3] ~ . .', { bars: '1' }, { sampleRate: SR });
    const spc = (60 / 120) * SR; // 120bpm default
    const cell = spc / 1; // 4 cells over 4 beats
    const offs = r.loop!.events.filter((e) => e.kind === 1);
    expect(offs.every((e) => e.offsetSamples === Math.round(2 * cell) - 1)).toBe(true);
  });

  it('rests end the previous note', () => {
    const r = parseLoop('x: C3 . . .', { bars: '1' }, { sampleRate: SR });
    const cell = (60 / 120) * SR;
    expect(r.loop!.events).toEqual([
      { offsetSamples: 0, track: 0, kind: 0, note: 48, velocity: DEFAULT_VELOCITY },
      { offsetSamples: Math.round(cell) - 1, track: 0, kind: 1, note: 48, velocity: 0 },
    ]);
  });
});

describe('parseLoop — errors', () => {
  it('errors when the cell count does not divide into bars*4', () => {
    const r = parseLoop('x: C3 . .', { bars: '1' }, { bodyStartLine: 7, sampleRate: SR });
    expect(r.loop).toBeNull();
    expect(r.errors[0]!.line).toBe(7);
    expect(r.errors[0]!.message).toMatch(/not divisible/);
  });

  it('errors on a leading tie', () => {
    const r = parseLoop('x: ~ C3 . .', { bars: '1' }, { bodyStartLine: 4, sampleRate: SR });
    expect(r.loop).toBeNull();
    expect(r.errors[0]!.message).toMatch(/tie/);
    expect(r.errors[0]!.line).toBe(4);
  });

  it('errors on an invalid note with a column', () => {
    const r = parseLoop('x: C3 H9 . .', { bars: '1' }, { bodyStartLine: 1, sampleRate: SR });
    expect(r.errors[0]!.message).toMatch(/invalid note "H9"/);
    expect(r.errors[0]!.col).toBe(7);
  });

  it('errors on a missing track line', () => {
    const r = parseLoop('\n\n', { bars: '1' }, { bodyStartLine: 3, sampleRate: SR });
    expect(r.errors[0]!.message).toMatch(/at least one track line/);
  });
});

describe('compile — whole document', () => {
  const DOC = [
    '# doc', // 1
    '', // 2
    '```synth id=lead seed=7', // 3
    'osc:', // 4
    '  - { table: basic/saw, unison: 7, detune: 22c }', // 5
    'lfo:', // 6
    '  1: { wave: tri, rate: 1/4 }', // 7
    '```', // 8
    '', // 9
    '```loop id=demo bars=2 bpm=124', // 10
    `${DEMO}`, // 11
    '```', // 12
  ].join('\n');

  it('compiles both fences and shares the bpm with the patch', () => {
    const r = compile(DOC, SR);
    expect(r.errors).toEqual([]);
    expect(r.bpm).toBe(124);
    expect(r.patch!.ir.seed).toBe(7);
    // LFO rate `1/4` resolved with the loop's bpm.
    expect(r.patch!.ir.lfo1.rateHz).toBeCloseTo(124 / 60, 9);
    expect(r.loop!.lengthSamples).toBe(185806);
    expect(r.loopMeta!.lines[0]!.cellsPerBeat).toBe(2);
  });

  it('still returns the loop when the patch fails (Glicol style)', () => {
    const broken = DOC.replace('detune: 22c', 'detune: 22');
    const r = compile(broken, SR);
    expect(r.patch).toBeUndefined();
    expect(r.loop).toBeDefined();
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.line).toBe(5);
  });

  it('reports a document with no fences', () => {
    const r = compile('just prose', SR);
    expect(r.errors[0]!.message).toMatch(/no ```synth/);
  });

  it('produces an expanded view for the UI', () => {
    const r = compile(DOC, SR);
    const json = JSON.stringify(r.patch!.expanded);
    expect(json).toContain('basic/saw');
    expect(json).toContain('22c');
  });
});
