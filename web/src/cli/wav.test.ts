// The WAV header is 44 bytes of numbers that no listener will ever see and
// every player depends on. These pin the fields down.

import { describe, it, expect } from 'vitest';
import { encodeWav, peakOf } from './wav.ts';

function header(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function tag(bytes: Uint8Array, at: number, length = 4): string {
  return String.fromCharCode(...bytes.slice(at, at + length));
}

describe('encodeWav', () => {
  const l = new Float32Array([0, 0.5, -0.5, 1]);
  const r = new Float32Array([0, -0.25, 0.25, -1]);

  it('writes a canonical RIFF/WAVE/fmt/data header', () => {
    const out = encodeWav(l, r, 48000);
    const v = header(out);
    expect(tag(out, 0)).toBe('RIFF');
    expect(tag(out, 8)).toBe('WAVE');
    expect(tag(out, 12)).toBe('fmt ');
    expect(tag(out, 36)).toBe('data');
    expect(v.getUint32(16, true)).toBe(16); // fmt chunk length
    expect(v.getUint16(20, true)).toBe(1); // PCM
    expect(v.getUint16(22, true)).toBe(2); // stereo
    expect(v.getUint32(24, true)).toBe(48000);
    expect(v.getUint16(34, true)).toBe(16); // bits
  });

  it('agrees with itself about the sizes', () => {
    const out = encodeWav(l, r, 44100);
    const v = header(out);
    const dataBytes = l.length * 4; // 2 channels × 16 bits
    expect(out.length).toBe(44 + dataBytes);
    expect(v.getUint32(40, true)).toBe(dataBytes);
    expect(v.getUint32(4, true)).toBe(36 + dataBytes);
    expect(v.getUint32(28, true)).toBe(44100 * 4); // byte rate
    expect(v.getUint16(32, true)).toBe(4); // block align
  });

  it('interleaves left and right', () => {
    const out = encodeWav(l, r, 48000);
    const v = header(out);
    expect(v.getInt16(44, true)).toBe(0);
    expect(v.getInt16(46, true)).toBe(0);
    expect(v.getInt16(48, true)).toBe(Math.round(0.5 * 0x7fff));
    expect(v.getInt16(50, true)).toBe(Math.round(-0.25 * 0x7fff));
  });

  it('clips rather than rescaling, and survives a non-finite sample', () => {
    // Rescaling would make the file a quieter song than the browser plays.
    const out = encodeWav(new Float32Array([4, NaN]), new Float32Array([-4, Infinity]), 48000);
    const v = header(out);
    expect(v.getInt16(44, true)).toBe(0x7fff);
    expect(v.getInt16(46, true)).toBe(-0x8000);
    expect(v.getInt16(48, true)).toBe(0);
    expect(v.getInt16(50, true)).toBe(0);
  });

  it('handles an empty render', () => {
    const out = encodeWav(new Float32Array(0), new Float32Array(0), 48000);
    expect(out.length).toBe(44);
    expect(header(out).getUint32(40, true)).toBe(0);
  });
});

describe('peakOf', () => {
  it('is the largest magnitude on either channel', () => {
    expect(peakOf(new Float32Array([0.2, -0.9]), new Float32Array([0.5, 0.1]))).toBeCloseTo(0.9);
    expect(peakOf(new Float32Array([0.1]), new Float32Array([-1.4]))).toBeCloseTo(1.4);
    expect(peakOf(new Float32Array(4), new Float32Array(4))).toBe(0);
  });
});
