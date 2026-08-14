// The render job — the boundary between the half of rendering that knows the
// notation and the half that only knows numbers.
//
// None of this needs the DSP core: emitting a job is compiling, and compiling
// happens without the engine. That is the point of the flag — a job can be
// produced on a machine that has never run `build-wasm.sh`.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile } from '../dsl/compile.ts';
import { buildJob } from './job.ts';
import { render } from './render.ts';
import { TEMPLATE } from './scaffold.ts';
import { PARAM_COUNT } from '../shared/params.ts';

const SR = 48000;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sheliak-job-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the render job', () => {
  it('carries one full parameter block per track', () => {
    const job = buildJob(compile(TEMPLATE, SR), { loops: 1, tailSeconds: 0, sampleRate: SR });
    expect(job.tracks.length).toBeGreaterThan(0);
    for (const track of job.tracks) {
      // The block is the contract. A short one would be read as zeros on the
      // far side, which is a patch, just not the one that was written.
      expect(track.params).toHaveLength(PARAM_COUNT);
      expect(track.params.every((v) => Number.isFinite(v))).toBe(true);
      expect(track.id).not.toBe('');
    }
  });

  it('resolves the loop count and the tail into frames', () => {
    const result = compile(TEMPLATE, SR);
    const job = buildJob(result, { loops: 3, tailSeconds: 2, sampleRate: SR });
    expect(job.loopFrames).toBe(result.loop!.lengthSamples * 3);
    // Resolved here so that both renderers agree on the length without doing
    // the arithmetic twice in two languages.
    expect(job.tailFrames).toBe(2 * SR);
  });

  it('keeps the events in samples, ascending, with a track and a kind', () => {
    const job = buildJob(compile(TEMPLATE, SR), { loops: 1, tailSeconds: 0, sampleRate: SR });
    expect(job.loop.events.length).toBeGreaterThan(0);
    let previous = -1;
    for (const event of job.loop.events) {
      expect(event.offsetSamples).toBeGreaterThanOrEqual(previous);
      previous = event.offsetSamples;
      expect([0, 1]).toContain(event.kind);
      expect(event.track).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(event.note)).toBe(true);
    }
  });

  it('refuses a document with nothing scheduled', () => {
    const noLoop = TEMPLATE.replace(/```loop[\s\S]*?```/, '');
    expect(() => buildJob(compile(noLoop, SR), { loops: 1, tailSeconds: 0, sampleRate: SR })).toThrow(
      /no `loop` fence/,
    );
  });

  it('is written as JSON by --emit-job, without the engine', () => {
    const out = join(dir, 'job.json');
    // No `wasm` option and no build required: if this ever starts needing the
    // engine, emitting a job has stopped being the compile-only half.
    const result = render(TEMPLATE, {
      out: join(dir, 'unused.wav'),
      loops: 2,
      tailSeconds: 1,
      sampleRate: SR,
      emitJob: out,
      wasm: join(dir, 'definitely-not-here.wasm'),
    });
    expect(result.job).toBe(true);
    expect(result.out).toBe(out);

    const job = JSON.parse(readFileSync(out, 'utf8'));
    expect(job.sampleRate).toBe(SR);
    expect(job.tailFrames).toBe(SR);
    expect(job.tracks[0].params).toHaveLength(PARAM_COUNT);
    expect(job.loop.lengthSamples).toBeGreaterThan(0);
    // camelCase throughout: the Rust side deserializes by these names.
    expect(Object.keys(job).sort()).toEqual(
      ['loop', 'loopFrames', 'sampleRate', 'stems', 'tailFrames', 'tracks'].sort(),
    );
  });
});
