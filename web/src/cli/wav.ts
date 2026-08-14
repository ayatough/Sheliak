// A WAV encoder, because a rendered song has to leave as a file somebody else's
// player can open.
//
// 16-bit PCM: the format every player, browser and DAW reads without asking.
// The DSP works in float, so the last step is a conversion, and it is done the
// dull way on purpose — scale, round, clamp, no dither. Dither would trade a
// deterministic render for a slightly nicer noise floor, and determinism is the
// property this project actually promises.

const HEADER_BYTES = 44;
const CHANNELS = 2;
const BITS = 16;
const FULL_SCALE = 0x7fff;

/** Interleaves L/R and wraps the result in a canonical 44-byte RIFF header. */
export function encodeWav(l: Float32Array, r: Float32Array, sampleRate: number): Uint8Array {
  const frames = Math.min(l.length, r.length);
  const bytesPerFrame = (CHANNELS * BITS) / 8;
  const dataBytes = frames * bytesPerFrame;
  const buffer = new ArrayBuffer(HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);

  ascii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true); // everything after this field
  ascii(view, 8, 'WAVE');
  ascii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk length
  view.setUint16(20, 1, true); // 1 = PCM, uncompressed
  view.setUint16(22, CHANNELS, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerFrame, true); // byte rate
  view.setUint16(32, bytesPerFrame, true); // block align
  view.setUint16(34, BITS, true);
  ascii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);

  let at = HEADER_BYTES;
  for (let i = 0; i < frames; i++) {
    view.setInt16(at, toPcm16(l[i]), true);
    view.setInt16(at + 2, toPcm16(r[i]), true);
    at += 4;
  }
  return new Uint8Array(buffer);
}

/**
 * Anything outside ±1 is clipped rather than rescaled: a render quietly made
 * quieter than what the browser plays would be a different song, and the peak
 * is reported so a clipped one is not a surprise.
 */
function toPcm16(v: number): number {
  if (!Number.isFinite(v)) return 0;
  const scaled = Math.round(v * FULL_SCALE);
  return Math.max(-FULL_SCALE - 1, Math.min(FULL_SCALE, scaled));
}

function ascii(view: DataView, at: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i));
}

/** Largest absolute sample across both channels, for the clipping report. */
export function peakOf(l: Float32Array, r: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < l.length; i++) {
    const a = Math.abs(l[i]);
    if (a > peak) peak = a;
  }
  for (let i = 0; i < r.length; i++) {
    const a = Math.abs(r[i]);
    if (a > peak) peak = a;
  }
  return peak;
}
