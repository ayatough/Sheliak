// A document whose track is a plugin, rendered end to end.
//
// Everything below the notation is already tested — the plugin against the
// engine in `wclap/tests/native.rs`, the host against the plugin in
// `wclap.test.ts`. What this covers is the join: a `plugin` fence naming a
// WCLAP Sheliak ships, its parameters resolved by name against the plugin's
// own list, its notes arriving from the loop, and its audio in the mix.
//
// Both build artifacts have to exist for this to mean anything, so it skips
// loudly rather than passing on a checkout where they do not.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { compile } from '../dsl/compile.ts';
import { instantiateDsp, renderLoop } from './offline.ts';
import { PluginRack } from './pluginRack.ts';
import { WclapModule } from './wclap.ts';

const DSP = resolve(__dirname, '../../public/dsp.wasm');
const BUNDLE = resolve(__dirname, '../../public/sheliak.wclap/module.wasm');
const SR = 48000;

const built = existsSync(DSP) && existsSync(BUNDLE);
const withBuilds = built ? describe : describe.skip;
if (!built) {
  console.warn('skipping the plugin-track tests: run ./scripts/build-wasm.sh and ./scripts/build-wclap.sh');
}

function bytes(path: string): Uint8Array<ArrayBuffer> {
  const file = readFileSync(path);
  const out = new Uint8Array(file.byteLength);
  out.set(file);
  return out;
}

/** A document with one track, played by `from`, plus whatever parameters. */
function doc(from: string, params = ''): string {
  return [
    '```plugin id=lead from=' + from,
    params,
    '```',
    '',
    '```phrase id=riff key=C scale=minor res=1/8 bars=1',
    'grid:',
    '  #     1.2.3.4.',
    "  1'   |o.......|",
    "  5'   |....o...|",
    '```',
    '',
    '```loop id=groove bars=1 bpm=120',
    'lead: riff',
    '```',
  ].join('\n');
}

function open(source: string): { rack: PluginRack; errors: string[]; result: ReturnType<typeof compile> } {
  const result = compile(source, SR);
  const module = WclapModule.instantiate(bytes(BUNDLE));
  const opened = PluginRack.open([module], result.pluginTracks, SR, 128);
  return { ...opened, result };
}

const SYNTH = 'io.github.ayatough.sheliak.synth';

withBuilds('a plugin track', () => {
  it('plays, and what it plays reaches the mix', () => {
    const { rack, errors, result } = open(doc(SYNTH));
    expect(errors).toEqual([]);
    expect(rack.size).toBe(1);
    expect(rack.has(0)).toBe(true);

    const dsp = instantiateDsp(bytes(DSP));
    const frames = result.loop!.lengthSamples;
    const audio = renderLoop(dsp, result.tracks, result.loop!, frames, SR, [], rack);

    const peak = audio.l.reduce((m, s) => Math.max(m, Math.abs(s)), 0);
    expect(peak).toBeGreaterThan(0.01);
    expect(audio.l.every((s) => Number.isFinite(s) && Math.abs(s) <= 1)).toBe(true);
    rack.destroy();
  });

  it('is silent without the rack, which is what proves the audio was the plugin’s', () => {
    const { result } = open(doc(SYNTH));
    const dsp = instantiateDsp(bytes(DSP));
    const frames = result.loop!.lengthSamples;
    const audio = renderLoop(dsp, result.tracks, result.loop!, frames, SR);
    expect(audio.l.every((s) => s === 0)).toBe(true);
  });

  it('sends the parameters the fence writes, in the plugin’s own units', () => {
    // Cutoff is 20..20000 in the plugin, so 0% is the bottom of that range and
    // a percentage is resolved against the plugin's range rather than guessed.
    const { rack, errors } = open(doc(SYNTH, 'cutoff: 0%\nrelease: 1.5'));
    expect(errors).toEqual([]);

    const dark = energy(rack);
    const bright = energy(open(doc(SYNTH, 'cutoff: 100%\nrelease: 1.5')).rack);
    expect(bright).toBeGreaterThan(dark * 2);
  });

  it('accepts the plugin’s own numbers as well as percentages', () => {
    const { errors } = open(doc(SYNTH, 'cutoff: 400\nwaveform: 2'));
    expect(errors).toEqual([]);
  });
});

/** Total energy of one loop, as a stand-in for "how much sound came out". */
function energy(rack: PluginRack): number {
  const result = compile(doc(SYNTH), SR);
  const dsp = instantiateDsp(bytes(DSP));
  const audio = renderLoop(dsp, result.tracks, result.loop!, result.loop!.lengthSamples, SR, [], rack);
  const total = audio.l.reduce((sum, s) => sum + s * s, 0);
  rack.destroy();
  return total;
}

withBuilds('what a plugin track says when it cannot play', () => {
  it('a plugin nobody here has, listing what there is', () => {
    const { errors, rack } = open(doc('com.example.tape'));
    expect(rack.size).toBe(0);
    expect(errors[0]).toContain('no plugin "com.example.tape" is available here');
    expect(errors[0]).toContain(SYNTH);
    expect(errors[0]).toContain('sheliak-render');
  });

  it('an effect used as a track, which is a different mistake', () => {
    const { errors, rack } = open(doc('io.github.ayatough.sheliak.dist'));
    expect(rack.size).toBe(0);
    expect(errors[0]).toContain('has no note input');
  });

  it('a parameter the plugin does not have, listing the ones it does', () => {
    const { errors } = open(doc(SYNTH, 'wobble: 50%'));
    expect(errors[0]).toContain('has no parameter "wobble"');
    expect(errors[0]).toContain('Cutoff');
  });

  it('a value outside the range the plugin declares', () => {
    const { errors } = open(doc(SYNTH, 'cutoff: 40000'));
    expect(errors[0]).toContain('outside 20..20000');
  });

  it('but the track still exists, so one bad parameter is not a silent song', () => {
    const { errors, rack } = open(doc(SYNTH, 'wobble: 50%'));
    expect(errors).toHaveLength(1);
    expect(rack.size).toBe(1);
    rack.destroy();
  });
});
