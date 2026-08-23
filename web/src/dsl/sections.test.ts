// Sections (Stream 2 §3–§5, §7–§8). Three properties matter more than the
// parsing: a document with no `##` section compiles exactly as it did before,
// a heading with no `loop` fence is prose rather than silence, and the sections
// end up in one event list at the offsets the document implies.

import { describe, it, expect } from 'vitest';
import { compile } from './compile.ts';
import { extractSections } from './sections.ts';
import { extractFences } from './fences.ts';

const SR = 48000;
const F = '```';
/** One bar at the default 120bpm. */
const BAR = 96000;

const PREAMBLE = [
  `${F}synth id=lead seed=1`,
  'osc:',
  '  - { table: basic/saw, level: -6dB }',
  F,
  '',
  `${F}synth id=bass seed=2`,
  'osc:',
  '  - { table: basic/saw, level: -6dB }',
  F,
  '',
  `${F}synth id=hat seed=3`,
  'osc:',
  '  - { table: basic/saw, level: -6dB }',
  F,
  '',
  `${F}phrase id=a res=1/4 bars=1`,
  'grid:',
  '  1  |o...|',
  F,
  '',
  `${F}phrase id=b res=1/4 bars=1`,
  'grid:',
  '  1  |..o.|',
  F,
  '',
  `${F}phrase id=c res=1/4 bars=1`,
  'grid:',
  '  1  |.o.o|',
  F,
  '',
].join('\n');

/** A `loop` fence, with whatever info string and lines are given. */
function loop(info: string, ...lines: string[]): string {
  return [`${F}loop${info ? ` ${info}` : ''}`, ...lines, F, ''].join('\n');
}

function song(...body: string[]): string {
  return [PREAMBLE, ...body].join('\n');
}

function messages(doc: string): string {
  return compile(doc, SR)
    .errors.map((e) => e.message)
    .join('\n');
}

// ------------------------------------------------------------------------ B1

describe('finding the sections', () => {
  it('takes them in document order, which is playback order', () => {
    const doc = song('## intro', '', loop('bars=1', 'lead: a'), '## verse', '', loop('bars=1', 'bass: b'));
    const r = compile(doc, SR);
    expect(r.errors).toEqual([]);
    expect(r.sections.map((s) => s.name)).toEqual(['intro', 'verse']);
    expect(r.loopMeta!.sections!.map((s) => s.name)).toEqual(['intro', 'verse']);
  });

  it('skips a heading with no loop fence — prose is not a bar of silence', () => {
    const doc = song(
      '## notes',
      '',
      'This section is about how the bass part came out.',
      '',
      '## verse',
      '',
      loop('bars=1', 'bass: b'),
    );
    const r = compile(doc, SR);
    expect(r.errors).toEqual([]);
    expect(r.sections.map((s) => s.name)).toEqual(['verse']);
    expect(r.loop!.lengthSamples).toBe(BAR);
  });

  it('leaves a document with no `##` heading exactly as it was', () => {
    const doc = song('# a title', '', loop('id=groove bars=1', 'lead: a'));
    const r = compile(doc, SR);
    expect(r.errors).toEqual([]);
    expect(r.sections).toEqual([]);
    expect(r.loopMeta!.sections).toBeUndefined();
    expect(r.loopMeta!.id).toBe('groove');
    expect(r.loop!.lengthSamples).toBe(BAR);
  });

  it('is not a section when every `##` is below the loop fence', () => {
    const doc = song(loop('id=groove bars=1', 'lead: a'), '## notes', '', 'written afterwards');
    const r = compile(doc, SR);
    expect(r.errors).toEqual([]);
    expect(r.sections).toEqual([]);
    expect(r.loopMeta!.id).toBe('groove');
  });

  it('sounds the same when an existing document happens to head its loop', () => {
    // A document that writes `## Arrangement` above its one loop fence becomes
    // a song of one section. That must be the same song: one section, played
    // once, in a transport that loops, is the loop it already was.
    const plain = song(loop('id=groove bars=1', 'lead: a', 'bass: b'));
    const headed = song('## Arrangement', '', loop('id=groove bars=1', 'lead: a', 'bass: b'));
    const a = compile(plain, SR);
    const b = compile(headed, SR);
    expect(b.errors).toEqual([]);
    expect(b.sections).toHaveLength(1);
    expect(b.loop!.lengthSamples).toBe(a.loop!.lengthSamples);
    expect(b.loop!.events).toEqual(a.loop!.events);
  });

  it('does not read a `##` inside a fence as a heading', () => {
    const fences = extractFences(['```text', '## not a heading', '```', '', '## verse', ''].join('\n'));
    const r = extractSections(['```text', '## not a heading', '```', '', '## verse', ''].join('\n'), fences);
    expect(r.prose).toEqual(['verse']);
  });

  it('reads only `##`, so `#` titles and `###` subheadings stay prose', () => {
    const doc = song('# song', '', '## verse', '', '### about the bass', '', loop('bars=1', 'bass: b'));
    const r = compile(doc, SR);
    expect(r.errors).toEqual([]);
    expect(r.sections.map((s) => s.name)).toEqual(['verse']);
  });

  it('gives a section the loop fence below its heading, not the one above', () => {
    const doc = song('## intro', '', loop('bars=1', 'lead: a'), '## verse', '', loop('bars=2', 'bass: b'));
    const r = compile(doc, SR);
    expect(r.loopMeta!.sections!.map((s) => s.bars)).toEqual([1, 2]);
  });
});

describe('what a section may not be', () => {
  it('refuses two loop fences under one heading', () => {
    const doc = song('## verse', '', loop('bars=1', 'lead: a'), loop('bars=1', 'bass: b'));
    expect(messages(doc)).toMatch(/a second `loop` fence under "verse" — a section has one arrangement/);
  });

  it('refuses a loop fence outside every section, once there are sections', () => {
    const doc = song(loop('bars=1', 'lead: a'), '## verse', '', loop('bars=1', 'bass: b'));
    expect(messages(doc)).toMatch(/outside any `##` section/);
    expect(compile(doc, SR).loop).toBeUndefined();
  });

  it('refuses two sections with the same name', () => {
    const doc = song('## verse', '', loop('bars=1', 'lead: a'), '## verse', '', loop('bars=1', 'bass: b'));
    expect(messages(doc)).toMatch(/duplicate section "verse"/);
    expect(compile(doc, SR).loop).toBeUndefined();
  });

  it('refuses a heading with no text', () => {
    const doc = song('##', '', loop('bars=1', 'lead: a'));
    expect(messages(doc)).toMatch(/no text, so its section has no name/);
  });
});

// ------------------------------------------------------------------------ B2

describe('`from=` — a variation is a difference', () => {
  const base = ['## verse', '', loop('bars=1', 'lead: a', 'bass: b')];

  function chorus(...lines: string[]): string {
    return song(...base, '## chorus', '', loop('bars=1 from=verse', ...lines));
  }

  function bindingsOf(doc: string, section: string): string[] {
    const s = compile(doc, SR).loopMeta!.sections!.find((x) => x.name === section)!;
    return s.lines.map((l) => `${l.trackId}: ${l.phraseId}`);
  }

  it('starts from the earlier section, unchanged', () => {
    const doc = chorus('hat: c');
    expect(compile(doc, SR).errors).toEqual([]);
    expect(bindingsOf(doc, 'chorus')).toEqual(['lead: a', 'bass: b', 'hat: c']);
  });

  it('replaces a binding in place', () => {
    const doc = chorus('lead: c');
    expect(compile(doc, SR).errors).toEqual([]);
    expect(bindingsOf(doc, 'chorus')).toEqual(['lead: c', 'bass: b']);
  });

  it('removes one with `-`', () => {
    const doc = chorus('bass: -');
    expect(compile(doc, SR).errors).toEqual([]);
    expect(bindingsOf(doc, 'chorus')).toEqual(['lead: a']);
  });

  it('inherits everything when the fence adds nothing of its own', () => {
    const doc = song(...base, '## again', '', loop('bars=1 from=verse'));
    expect(compile(doc, SR).errors).toEqual([]);
    expect(bindingsOf(doc, 'again')).toEqual(['lead: a', 'bass: b']);
  });

  it('marks the lines it did not write itself', () => {
    const doc = chorus('lead: c');
    const s = compile(doc, SR).loopMeta!.sections!.find((x) => x.name === 'chorus')!;
    expect(s.lines.map((l) => l.inherited === true)).toEqual([false, true]);
  });

  it('chains, so a variation of a variation is one difference each', () => {
    const doc = song(
      ...base,
      '## chorus',
      '',
      loop('bars=1 from=verse', 'hat: c'),
      '## outro',
      '',
      loop('bars=1 from=chorus', 'lead: -'),
    );
    expect(compile(doc, SR).errors).toEqual([]);
    expect(bindingsOf(doc, 'outro')).toEqual(['bass: b', 'hat: c']);
  });

  it('inherits nothing else — length and repeat are the section\'s own', () => {
    const doc = song(
      '## verse',
      '',
      loop('bars=2 repeat=3', 'lead: a'),
      '## chorus',
      '',
      loop('from=verse', 'bass: b'),
    );
    const s = compile(doc, SR).loopMeta!.sections!;
    expect(s[1]).toMatchObject({ bars: 1, repeat: 1 });
  });

  it('refuses a section that is `from` itself', () => {
    const doc = song('## verse', '', loop('bars=1 from=verse', 'lead: a'));
    expect(messages(doc)).toMatch(/names this section itself/);
  });

  it('refuses a forward reference', () => {
    const doc = song('## intro', '', loop('bars=1 from=verse', 'lead: a'), '## verse', '', loop('bars=1', 'bass: b'));
    expect(messages(doc)).toMatch(/names a section further down/);
    expect(compile(doc, SR).loop).toBeUndefined();
  });

  it('refuses an unknown name, and says what is above', () => {
    const doc = song(...base, '## chorus', '', loop('bars=1 from=bridge', 'hat: c'));
    expect(messages(doc)).toMatch(/`from=bridge` names no section \(above this one: verse\)/);
  });

  it('says so when the name is a prose heading', () => {
    const doc = song('## notes', '', 'prose', '', '## verse', '', loop('bars=1 from=notes', 'lead: a'));
    expect(messages(doc)).toMatch(/names a heading with no `loop` fence/);
  });

  it('refuses `-` for a track that was not inherited', () => {
    const doc = song(...base, '## chorus', '', loop('bars=1 from=verse', 'hat: -'));
    expect(messages(doc)).toMatch(/nothing to remove — track "hat" is not bound here/);
  });

  it('keeps a broken section inheritable, so one typo does not spread', () => {
    // `nope` is undefined, so `verse` does not compile. `chorus` must still
    // inherit what the text of `verse` says rather than an empty section.
    const doc = song(
      '## verse',
      '',
      loop('bars=1', 'lead: a', 'bass: nope'),
      '## chorus',
      '',
      loop('bars=1 from=verse', 'hat: c'),
    );
    const r = compile(doc, SR);
    expect(r.errors.map((e) => e.message).join('\n')).toMatch(/undefined phrase "nope"/);
    // Reported once, where it is written — not again in every section below.
    expect(r.errors.filter((e) => /undefined phrase/.test(e.message))).toHaveLength(2);
    expect(r.loop).toBeUndefined();
  });
});

describe('`repeat=`', () => {
  it('plays the section that many times', () => {
    const doc = song('## verse', '', loop('bars=1 repeat=3', 'lead: a'));
    const r = compile(doc, SR);
    expect(r.errors).toEqual([]);
    expect(r.loop!.lengthSamples).toBe(3 * BAR);
    expect(r.loop!.events.filter((e) => e.kind === 0).map((e) => e.offsetSamples)).toEqual([0, BAR, 2 * BAR]);
  });

  it('defaults to once', () => {
    const doc = song('## verse', '', loop('bars=1', 'lead: a'));
    expect(compile(doc, SR).loopMeta!.sections![0]!.repeat).toBe(1);
  });

  const bad = ['repeat=0', 'repeat=-2', 'repeat=1.5', 'repeat=twice'];
  for (const attr of bad) {
    it(`refuses \`${attr}\``, () => {
      const doc = song('## verse', '', loop(`bars=1 ${attr}`, 'lead: a'));
      expect(messages(doc)).toMatch(/repeat must be a whole number of times, 1 or more/);
    });
  }
});

// ------------------------------------------------------------------------ B3

describe('laying the sections end to end', () => {
  it('offsets every event by where its section starts', () => {
    const doc = song('## intro', '', loop('bars=1', 'lead: a'), '## verse', '', loop('bars=1', 'lead: b'));
    const r = compile(doc, SR);
    expect(r.errors).toEqual([]);
    // `a` hits on cell 0, `b` on cell 2 of a 1/4 grid — half a bar in.
    expect(r.loop!.events.filter((e) => e.kind === 0).map((e) => e.offsetSamples)).toEqual([0, BAR + BAR / 2]);
    expect(r.loop!.lengthSamples).toBe(2 * BAR);
  });

  it('reports where each section starts and how long it is', () => {
    const doc = song(
      '## intro',
      '',
      loop('bars=2', 'lead: a'),
      '## verse',
      '',
      loop('bars=1 repeat=2', 'bass: b'),
      '## outro',
      '',
      loop('bars=1', 'hat: c'),
    );
    const s = compile(doc, SR).loopMeta!.sections!;
    expect(s.map((x) => [x.startSamples, x.lengthSamples, x.repeat])).toEqual([
      [0, 2 * BAR, 1],
      [2 * BAR, BAR, 2],
      [4 * BAR, BAR, 1],
    ]);
    expect(compile(doc, SR).loopMeta!.bars).toBe(5);
  });

  it('gives a section its own tempo', () => {
    const doc = song('## intro', '', loop('bars=1 bpm=120', 'lead: a'), '## verse', '', loop('bars=1 bpm=240', 'lead: a'));
    const r = compile(doc, SR);
    expect(r.errors).toEqual([]);
    expect(r.loop!.lengthSamples).toBe(BAR + BAR / 2);
    expect(r.loopMeta!.sections!.map((x) => x.bpm)).toEqual([120, 240]);
  });

  it('stamps each line with the section it came from', () => {
    const doc = song('## intro', '', loop('bars=1', 'lead: a'), '## verse', '', loop('bars=1', 'bass: b'));
    const lines = compile(doc, SR).loopMeta!.lines;
    expect(lines.map((l) => [l.section, l.trackId])).toEqual([
      ['intro', 'lead'],
      ['verse', 'bass'],
    ]);
  });

  it('plays nothing new while any section is broken', () => {
    const doc = song('## intro', '', loop('bars=1', 'lead: a'), '## verse', '', loop('bars=1', 'nobody: b'));
    const r = compile(doc, SR);
    expect(r.loop).toBeUndefined();
    // The metadata survives, so the editor can still say what it found.
    expect(r.loopMeta!.sections!.map((s) => s.name)).toEqual(['intro', 'verse']);
  });

  it('takes the song\'s default length from the header', () => {
    const doc = ['---', 'bars: 2', '---', '', song('## verse', '', loop('', 'lead: a'))].join('\n');
    const r = compile(doc, SR);
    expect(r.errors).toEqual([]);
    expect(r.loopMeta!.sections![0]!.bars).toBe(2);
  });
});
