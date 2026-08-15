// The `plugin` fence.
//
// The interesting cases are the ones where this fence is unlike every other:
// its parameter names cannot be validated, and its track is silent everywhere a
// plugin cannot be loaded.

import { describe, it, expect } from 'vitest';
import { compile } from './compile.ts';
import { parsePlugin } from './plugin.ts';

const SR = 48000;

const parse = (body: string, attrs: Record<string, string> = { id: 'pad', from: 'com.example.synth' }) =>
  parsePlugin(body, attrs, { bodyStartLine: 2, fenceLine: 1 });

describe('the plugin fence', () => {
  it('needs a plugin to name', () => {
    const r = parse('', { id: 'pad' });
    expect(r.ir).toBeNull();
    expect(r.errors[0]!.message).toMatch(/needs `from=`/);
  });

  it('rejects something that is not a plugin id', () => {
    const r = parse('', { id: 'pad', from: 'my favourite synth' });
    expect(r.errors[0]!.message).toMatch(/not a plugin id/);
  });

  it('takes a parameter as a percentage of its own range', () => {
    const r = parse('brightness: 60%');
    expect(r.errors).toEqual([]);
    expect(r.ir!.params['brightness']).toEqual({ kind: 'normalized', value: 0.6, raw: '60%' });
  });

  it("takes a parameter as the plugin's own number", () => {
    const r = parse('cutoff: 800');
    expect(r.errors).toEqual([]);
    expect(r.ir!.params['cutoff']).toEqual({ kind: 'plain', value: 800, raw: '800' });
  });

  it('accepts a parameter name it has never heard of', () => {
    // The whole point: Sheliak cannot know this plugin's parameters, so a name
    // is carried through rather than checked. The renderer, which has the
    // plugin, is where an unknown one becomes an error.
    const r = parse('wobbliness: 30%\nsome_other_thing: 12');
    expect(r.errors).toEqual([]);
    expect(Object.keys(r.ir!.params)).toEqual(['wobbliness', 'some_other_thing']);
  });

  it('refuses a unit it cannot possibly interpret', () => {
    // `500ms` would be a promise about the parameter's unit that nothing on
    // this side can keep.
    const r = parse('attack: 500ms');
    expect(r.ir).toBeNull();
    expect(r.errors[0]!.message).toMatch(/cannot know what unit/);
  });

  it('refuses a duplicate parameter', () => {
    const r = parse('mix: 10%\nmix: 20%');
    expect(r.errors[0]!.message).toMatch(/duplicate parameter "mix"/);
  });
});

describe('a plugin fence as a track', () => {
  const doc = [
    '```synth id=lead',
    'osc:',
    '  - { table: basic/saw }',
    '```',
    '',
    '```plugin id=pad from=studio.kx.distrho.Kars',
    'brightness: 60%',
    '```',
    '',
    '```synth id=bass',
    'osc:',
    '  - { table: basic/sine }',
    '```',
    '',
    '```phrase id=fig key=C scale=minor res=1/4 bars=1',
    'grid:',
    '  #    1234',
    '  1   |o...|',
    '```',
    '',
    '```loop id=song bars=1 bpm=120',
    'lead: fig',
    'pad:  fig',
    'bass: fig',
    '```',
  ].join('\n');

  it('takes an index in the same sequence as the synth fences', () => {
    const r = compile(doc, SR);
    expect(r.errors).toEqual([]);
    expect(r.trackCount).toBe(3);
    // The plugin fence sits between them, so the second synth fence is track 2.
    expect(r.tracks.map((t) => [t.id, t.track])).toEqual([
      ['lead', 0],
      ['bass', 2],
    ]);
    expect(r.pluginTracks.map((t) => [t.id, t.track, t.from])).toEqual([
      ['pad', 1, 'studio.kx.distrho.Kars'],
    ]);
  });

  it('can be bound by a loop line like any other track', () => {
    const r = compile(doc, SR);
    expect(r.loop!.events.some((e) => e.track === 1)).toBe(true);
  });

  it('leaves the engine nothing to play for it', () => {
    // No patch means the engine's track stays silent, which is the whole of the
    // browser's behaviour: the other tracks play, this one does not.
    const r = compile(doc, SR);
    expect(r.tracks.some((t) => t.track === 1)).toBe(false);
  });

  it('shares the id namespace with synth fences', () => {
    const clash = doc.replace('```plugin id=pad', '```plugin id=lead');
    const r = compile(clash, SR);
    expect(r.errors.some((e) => /duplicate track id "lead"/.test(e.message))).toBe(true);
  });
});
