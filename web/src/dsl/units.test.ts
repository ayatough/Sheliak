import { describe, it, expect } from 'vitest';
import { parseScalar, dbToLinear, beatsToSeconds, beatsToHz, samplesPerBeat } from './units.ts';

const P = { line: 1, col: 1 };
const at = (s: string) => parseScalar(s, P);

describe('parseScalar — units', () => {
  it('parses frequencies', () => {
    expect(at('320Hz')).toMatchObject({ unit: 'hz', value: 320 });
    expect(at('4.5kHz')).toMatchObject({ unit: 'hz', value: 4500 });
    expect(at('800hz')).toMatchObject({ unit: 'hz', value: 800 });
  });

  it('parses gains', () => {
    expect(at('-6dB')).toMatchObject({ unit: 'db', value: -6 });
    expect(at('0dB')).toMatchObject({ unit: 'db', value: 0 });
    expect(at('+3.5db')).toMatchObject({ unit: 'db', value: 3.5 });
  });

  it('parses absolute times, keeping ms distinct from s', () => {
    expect(at('180ms')).toMatchObject({ unit: 'sec', value: 0.18 });
    expect(at('2s')).toMatchObject({ unit: 'sec', value: 2 });
    expect(at('0ms')).toMatchObject({ unit: 'sec', value: 0 });
  });

  it('parses musical times as beats (quarter notes)', () => {
    expect(at('1/16')).toMatchObject({ unit: 'musical', value: 0.25 });
    expect(at('1/4')).toMatchObject({ unit: 'musical', value: 1 });
    expect(at('1/8')).toMatchObject({ unit: 'musical', value: 0.5 });
    expect(at('3/8')).toMatchObject({ unit: 'musical', value: 1.5 });
    expect(at('2bar')).toMatchObject({ unit: 'musical', value: 8 });
    expect(at('1.5beat')).toMatchObject({ unit: 'musical', value: 1.5 });
  });

  it('parses pitch offsets, keeping st distinct from s', () => {
    expect(at('-7c')).toMatchObject({ unit: 'cent', value: -7 });
    expect(at('+2400c')).toMatchObject({ unit: 'cent', value: 2400 });
    expect(at('+12st')).toMatchObject({ unit: 'semitone', value: 12 });
    expect(at('-12st')).toMatchObject({ unit: 'semitone', value: -12 });
  });

  it('parses ratios', () => {
    expect(at('70%')).toMatchObject({ unit: 'ratio', value: 0.7 });
    expect(at('0%')).toMatchObject({ unit: 'ratio', value: 0 });
    expect(at('80%')).toMatchObject({ unit: 'ratio', value: 0.8 });
  });

  it('marks bare numbers as their own kind so fields can reject them', () => {
    expect(at('0.3')).toMatchObject({ unit: 'bare', value: 0.3 });
    expect(at('7')).toMatchObject({ unit: 'bare', value: 7 });
    expect(at('-0.5')).toMatchObject({ unit: 'bare', value: -0.5 });
    expect(at('.5')).toMatchObject({ unit: 'bare', value: 0.5 });
  });

  it('treats non-numeric tokens as names', () => {
    expect(at('basic/saw')).toMatchObject({ unit: 'ident' });
    expect(at('lp12')).toMatchObject({ unit: 'ident' });
    expect(at('env.filter')).toMatchObject({ unit: 'ident' });
    expect(at('tri')).toMatchObject({ unit: 'ident' });
    // A number with a bogus unit is not silently accepted as a number.
    expect(at('320Hzz')).toMatchObject({ unit: 'ident' });
  });

  it('keeps source positions', () => {
    const uv = parseScalar('22c', { line: 12, col: 34 });
    expect(uv.line).toBe(12);
    expect(uv.col).toBe(34);
    expect(uv.raw).toBe('22c');
  });
});

describe('conversions', () => {
  it('dB → linear', () => {
    expect(dbToLinear(0)).toBe(1);
    expect(dbToLinear(-6)).toBeCloseTo(0.5011872, 6);
    expect(dbToLinear(-8)).toBeCloseTo(0.3981072, 6);
  });

  it('beats → seconds / Hz at a given bpm', () => {
    expect(beatsToSeconds(1, 120)).toBeCloseTo(0.5, 9);
    expect(beatsToSeconds(8, 124)).toBeCloseTo((8 * 60) / 124, 9);
    // `1/4` = one beat → one LFO cycle per beat.
    expect(beatsToHz(1, 124)).toBeCloseTo(124 / 60, 9);
    expect(beatsToHz(4, 120)).toBeCloseTo(0.5, 9);
  });

  it('samplesPerBeat has no hardcoded sample rate', () => {
    expect(samplesPerBeat(120, 44100)).toBeCloseTo(22050, 6);
    expect(samplesPerBeat(124, 48000)).toBeCloseTo(23225.8064516, 6);
  });
});
