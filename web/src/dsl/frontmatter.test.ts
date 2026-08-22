// The song header (Stream 2 §2). Two properties matter more than the parsing:
// a document without a header is untouched, and a fence that states a value
// keeps it — otherwise adding a header could change what a song sounds like.

import { describe, it, expect } from 'vitest';
import { parseFrontmatter } from './frontmatter.ts';
import { compile } from './compile.ts';

const SR = 48000;
const F = '```';

const SONG = [
  `${F}synth id=lead seed=1`,
  'osc:',
  '  - { table: basic/saw, level: -6dB }',
  F,
  '',
  `${F}phrase id=hook res=1/8 bars=1`,
  'grid:',
  '  1  |o-......|',
  F,
  '',
  `${F}loop id=song bars=1 bpm=120`,
  'lead: hook',
  F,
  '',
].join('\n');

/** Puts a header on top of `SONG`. */
function withHeader(...fields: string[]): string {
  return ['---', ...fields, '---', '', SONG].join('\n');
}

describe('recognising a header', () => {
  it('reads the fields it knows', () => {
    const r = parseFrontmatter('---\ntitle: Nocturne\nbpm: 126\nkey: Eb\nscale: minor\nbars: 4\n---\n\n# song\n');
    expect(r.errors).toEqual([]);
    expect(r.present).toBe(true);
    expect(r.header).toEqual({ title: 'Nocturne', bpm: 126, key: 'Eb', scale: 'minor', bars: 4 });
  });

  it('finds nothing in a document that has none', () => {
    const r = parseFrontmatter('# a song\n\nsome prose\n');
    expect(r).toMatchObject({ present: false, header: {}, errors: [] });
  });

  it('is only a header at the very top', () => {
    // A horizontal rule in someone's prose is not a song header.
    const r = parseFrontmatter('# a song\n\n---\ntitle: not a header\n---\n');
    expect(r.present).toBe(false);
    expect(r.header).toEqual({});
  });

  it('reports a header that is never closed', () => {
    const r = parseFrontmatter('---\ntitle: Nocturne\n\n# song\n');
    expect(r.present).toBe(true);
    expect(r.errors[0]!.message).toMatch(/never closed/);
  });

  it('reports the line a bad field is on, relative to the document', () => {
    const r = parseFrontmatter('---\ntitle: ok\nbpm: fast\n---\n');
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.line).toBe(3);
    expect(r.errors[0]!.message).toMatch(/bpm must be a positive number/);
  });
});

describe('refusing what it cannot mean', () => {
  const cases: [string, RegExp][] = [
    ['tempo: 126', /unknown song header field "tempo"/],
    ['bpm: 0', /positive number/],
    ['bpm: -4', /positive number/],
    ['bars: 1.5', /whole number of bars/],
    ['bars: 0', /whole number of bars/],
    ['key: H', /pitch class/],
    ['scale: lydianish', /unknown scale/],
    ['title:', /"title" has no value/],
    ['bpm:', /"bpm" has no value/],
  ];
  for (const [field, message] of cases) {
    it(`rejects \`${field}\``, () => {
      const r = parseFrontmatter(`---\n${field}\n---\n`);
      expect(r.errors.map((e) => e.message).join('\n')).toMatch(message);
    });
  }

  it('reports a field written twice', () => {
    const r = parseFrontmatter('---\nbpm: 120\nbpm: 126\n---\n');
    expect(r.errors[0]!.message).toMatch(/duplicate song header field "bpm"/);
  });
});

describe('what the header changes, and what it must not', () => {
  it('leaves a document with no header exactly as it was', () => {
    const r = compile(SONG, SR);
    expect(r.errors).toEqual([]);
    expect(r.header).toEqual({});
    expect(r.bpm).toBe(120);
    expect(r.phrases['hook']!.key).toBe('C');
    expect(r.phrases['hook']!.scale).toBe('major');
  });

  it('gives a phrase the song\'s key and scale', () => {
    const r = compile(withHeader('key: Eb', 'scale: minor'), SR);
    expect(r.errors).toEqual([]);
    expect(r.phrases['hook']!.key).toBe('Eb');
    expect(r.phrases['hook']!.scale).toBe('minor');
  });

  it('lets a phrase keep what it says for itself', () => {
    // Nearest wins. Without this, adding a header would re-tune every song
    // that already spelled its keys out.
    const doc = withHeader('key: Eb', 'scale: minor').replace(
      'phrase id=hook res=1/8 bars=1',
      'phrase id=hook key=G scale=dorian res=1/8 bars=1',
    );
    const r = compile(doc, SR);
    expect(r.phrases['hook']!.key).toBe('G');
    expect(r.phrases['hook']!.scale).toBe('dorian');
  });

  it('sets the tempo when no loop fence says otherwise', () => {
    const doc = withHeader('bpm: 96').replace('loop id=song bars=1 bpm=120', 'loop id=song bars=1');
    const r = compile(doc, SR);
    expect(r.bpm).toBe(96);
  });

  it('yields the tempo to a loop fence that states one', () => {
    // `bpm=` on a loop is where tempo lives today; the header must not move it.
    const r = compile(withHeader('bpm: 96'), SR);
    expect(r.bpm).toBe(120);
  });

  it('sets the default length of a loop that does not say', () => {
    const doc = withHeader('bars: 2').replace('loop id=song bars=1 bpm=120', 'loop id=song bpm=120');
    const r = compile(doc, SR);
    expect(r.errors).toEqual([]);
    expect(r.loopMeta!.bars).toBe(2);
  });

  it('yields the length to a loop that states one', () => {
    const r = compile(withHeader('bars: 8'), SR);
    expect(r.loopMeta!.bars).toBe(1);
  });

  it('reports a bad header without stopping the rest of the document', () => {
    const r = compile(withHeader('bpm: fast'), SR);
    expect(r.errors.some((e) => /bpm must be/.test(e.message))).toBe(true);
    // The song still compiled: one bad header field is not a broken song.
    expect(r.tracks).toHaveLength(1);
    expect(r.phrases['hook']).toBeDefined();
  });

  it('does not shift the line numbers of anything below it', () => {
    const withOut = compile(SONG, SR);
    const withIn = compile(withHeader('bpm: 96'), SR);
    const offset = withHeader('bpm: 96').indexOf(SONG.slice(0, 20));
    expect(offset).toBeGreaterThan(0);
    // The fences moved down by the header's height, and the reported positions
    // must move with them rather than staying where they were.
    const before = withOut.fences[0]!.fenceLine;
    const after = withIn.fences[0]!.fenceLine;
    expect(after).toBe(before + 4);
  });
});
