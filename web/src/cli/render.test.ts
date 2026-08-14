// `sheliak render`. The parts that need the DSP core are skipped when it has
// not been built, exactly as `integration.test.ts` is — the checks that matter
// most here (refusing to render a broken document) do not need it at all,
// because refusing happens before the wasm is ever asked for.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultWasmPath, render } from './render.ts';
import { TEMPLATE } from './scaffold.ts';

const SR = 48000;
const hasWasm = existsSync(defaultWasmPath());

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sheliak-render-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function opts(over: Partial<Parameters<typeof render>[1]> = {}) {
  return { out: join(dir, 'out.wav'), loops: 1, tailSeconds: 0, sampleRate: SR, ...over };
}

/** Frame count from the data chunk, which is what a player will believe. */
function frames(path: string): number {
  const bytes = readFileSync(path);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(40, true) / 4;
}

describe('refusing to render', () => {
  it('refuses a document that does not compile, naming the line', () => {
    const broken = TEMPLATE.replace('level: -6dB', 'level: -6');
    expect(() => render(broken, opts())).toThrow(/does not compile[\s\S]*bare numbers/);
  });

  it('writes nothing when it refuses', () => {
    const broken = TEMPLATE.replace('level: -6dB', 'level: -6');
    try {
      render(broken, opts());
    } catch {
      /* expected */
    }
    expect(existsSync(join(dir, 'out.wav'))).toBe(false);
  });

  it('refuses a document with no loop fence', () => {
    const noLoop = TEMPLATE.slice(0, TEMPLATE.indexOf('```loop'));
    expect(() => render(noLoop, opts())).toThrow(/no `loop` fence/);
  });

  it('says how to build the DSP core when it is missing', () => {
    expect(() => render(TEMPLATE, opts({ wasm: join(dir, 'absent.wasm') }))).toThrow(
      /build-wasm\.sh/,
    );
  });
});

describe.skipIf(!hasWasm)('rendering', () => {
  it('writes a WAV of exactly one loop', () => {
    const result = render(TEMPLATE, opts());
    // The starter song is 1 bar at 120bpm = 2 seconds.
    expect(result.seconds).toBeCloseTo(2, 5);
    expect(frames(result.out)).toBe(result.frames);
    expect(result.tracks).toBe(1);
    expect(result.bpm).toBe(120);
  });

  it('repeats the loop', () => {
    const one = render(TEMPLATE, opts());
    const three = render(TEMPLATE, opts({ out: join(dir, 'three.wav'), loops: 3 }));
    expect(three.frames).toBe(one.frames * 3);
  });

  it('adds exactly the tail it was asked for', () => {
    const dry = render(TEMPLATE, opts());
    const rung = render(TEMPLATE, opts({ out: join(dir, 'tail.wav'), tailSeconds: 0.5 }));
    expect(rung.frames).toBe(dry.frames + SR * 0.5);
  });

  it('makes a sound, and one that is not clipped', () => {
    const result = render(TEMPLATE, opts());
    expect(result.peak).toBeGreaterThan(0.01);
    expect(result.peak).toBeLessThanOrEqual(1);
  });

  it('renders the same bytes twice', () => {
    // The whole promise of the format: same document, same seed, same samples.
    render(TEMPLATE, opts({ out: join(dir, 'a.wav') }));
    render(TEMPLATE, opts({ out: join(dir, 'b.wav') }));
    expect(readFileSync(join(dir, 'a.wav'))).toEqual(readFileSync(join(dir, 'b.wav')));
  });

  it('resolves musical time against the sample rate it is given', () => {
    const at44 = render(TEMPLATE, opts({ out: join(dir, '44.wav'), sampleRate: 44100 }));
    expect(at44.seconds).toBeCloseTo(2, 5);
    expect(at44.frames).toBeLessThan(SR * 2);
  });
});
