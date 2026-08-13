import { describe, it, expect } from 'vitest';
import {
  replaceSpan,
  cellSpan,
  writeCell,
  loadPhrase,
  replaceDetailBlock,
  replaceGridBlock,
  setSynthField,
  getSynthFieldText,
  setLoopLine,
  setLoopAttr,
  appendLoopLine,
  loopLines,
  resolveField,
} from './edit.ts';
import { parseYamlite } from './yamlite.ts';
import {
  formatHz,
  formatSeconds,
  formatDb,
  formatRatio,
  formatCents,
  formatSemitones,
  formatNote,
  formatFor,
} from './format.ts';

const F = '```';

const DOC = [
  '# title', // 1
  '', // 2
  `${F}synth id=lead`, // 3
  'osc:', // 4
  '  - { table: basic/saw, level: 0dB, unison: 7 }   # supersaw', // 5
  '', // 6
  'filter: { type: lp12, cutoff: 800Hz, res: 0.3 }', // 7
  '', // 8
  'env:', // 9
  '  amp: { a: 5ms, d: 200ms, s: 70%, r: 120ms }', // 10
  F, // 11
  '', // 12
  `${F}synth id=bass`, // 13
  'filter: { type: lp24, cutoff: 400Hz }', // 14
  F, // 15
  '', // 16
  `${F}loop id=demo bars=1 bpm=120`, // 17
  'lead: C3 . . .', // 18
  'bass: . . C2 .', // 19
  F, // 20
].join('\n');

const lines = (d: string) => d.split('\n');

describe('replaceSpan', () => {
  it('replaces exactly the given columns', () => {
    const out = replaceSpan('abcdef', { line: 1, col: 3, endCol: 5 }, 'XY');
    expect(out.ok && out.doc).toBe('abXYef');
  });

  it('refuses out-of-range spans', () => {
    expect(replaceSpan('abc', { line: 9, col: 1, endCol: 2 }, 'x').ok).toBe(false);
    expect(replaceSpan('abc', { line: 1, col: 1, endCol: 99 }, 'x').ok).toBe(false);
  });
});

describe('setSynthField', () => {
  it('swaps one value and leaves every other byte alone', () => {
    const r = setSynthField(DOC, 0, ['filter', 'cutoff'], '1.2kHz');
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const before = lines(DOC);
    const after = lines(r.doc);
    expect(after).toHaveLength(before.length);
    for (let i = 0; i < before.length; i++) {
      if (i === 6) continue; // the filter line
      expect(after[i]).toBe(before[i]);
    }
    expect(after[6]).toBe('filter: { type: lp12, cutoff: 1.2kHz, res: 0.3 }');
  });

  it('preserves trailing comments and alignment on the edited line', () => {
    const r = setSynthField(DOC, 0, ['osc', '0', 'level'], '-6dB');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(lines(r.doc)[4]).toBe('  - { table: basic/saw, level: -6dB, unison: 7 }   # supersaw');
  });

  it('writes into nested block maps', () => {
    const r = setSynthField(DOC, 0, ['env', 'amp', 'd'], '350ms');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(lines(r.doc)[9]).toBe('  amp: { a: 5ms, d: 350ms, s: 70%, r: 120ms }');
  });

  it('targets the right fence — editing track 1 leaves track 0 untouched', () => {
    const r = setSynthField(DOC, 1, ['filter', 'cutoff'], '250Hz');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const after = lines(r.doc);
    expect(after[6]).toBe('filter: { type: lp12, cutoff: 800Hz, res: 0.3 }'); // track 0 intact
    expect(after[13]).toBe('filter: { type: lp24, cutoff: 250Hz }');
    // Only line 14 changed.
    lines(DOC).forEach((l, i) => {
      if (i !== 13) expect(after[i]).toBe(l);
    });
  });

  it('inserts a missing key into an existing flow map', () => {
    const r = setSynthField(DOC, 1, ['filter', 'res'], '0.4');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(lines(r.doc)[13]).toBe('filter: { type: lp24, cutoff: 400Hz, res: 0.4 }');
  });

  it('inserts into an empty flow map with padding', () => {
    const doc = `${F}synth id=a\nfilter: {}\n${F}`;
    const r = setSynthField(doc, 0, ['filter', 'cutoff'], '900Hz');
    expect(r.ok && r.doc.split('\n')[1]).toBe('filter: { cutoff: 900Hz }');
  });

  it('refuses when the whole section is absent', () => {
    const r = setSynthField(DOC, 1, ['lfo', '1', 'rate'], '2Hz');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/lfo/);
  });

  it('refuses to patch a fence with parse errors', () => {
    const broken = DOC.replace('cutoff: 800Hz', 'cutoff: { oops');
    const r = setSynthField(broken, 0, ['osc', '0', 'level'], '-6dB');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/parse errors/);
  });

  it('round-trips through getSynthFieldText', () => {
    expect(getSynthFieldText(DOC, 0, ['filter', 'cutoff'])).toBe('800Hz');
    expect(getSynthFieldText(DOC, 0, ['osc', '0', 'unison'])).toBe('7');
    expect(getSynthFieldText(DOC, 1, ['filter', 'res'])).toBeNull();
  });
});

describe('resolveField', () => {
  it('reports the insertion map for a missing key', () => {
    const { root } = parseYamlite('filter: { type: lp12 }', 1);
    const t = resolveField(root!, ['filter', 'cutoff']);
    expect(t.kind).toBe('insert');
  });

  it('reports missing intermediates', () => {
    const { root } = parseYamlite('filter: { type: lp12 }', 1);
    expect(resolveField(root!, ['lfo', '1', 'rate']).kind).toBe('missing');
  });
});

describe('loop editing', () => {
  it('lists the track lines with document-absolute positions', () => {
    const refs = loopLines(DOC);
    expect(refs.map((r) => [r.trackId, r.line])).toEqual([
      ['lead', 18],
      ['bass', 19],
    ]);
  });

  it('replaces one line and leaves the others alone', () => {
    const r = setLoopLine(DOC, 'bass', 'bass: C2 . C2 .');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const after = lines(r.doc);
    expect(after[17]).toBe('lead: C3 . . .');
    expect(after[18]).toBe('bass: C2 . C2 .');
    expect(after).toHaveLength(lines(DOC).length);
  });

  it('appends a new track line before the closing fence', () => {
    const r = appendLoopLine(DOC, 'hat: . . . .');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const after = lines(r.doc);
    expect(after[19]).toBe('hat: . . . .');
    expect(after[20]).toBe(F);
  });

  it('updates fence attributes in place', () => {
    const r = setLoopAttr(DOC, 'bpm', '128');
    expect(r.ok && lines(r.doc)[16]).toBe('```loop id=demo bars=1 bpm=128');
    const r2 = setLoopAttr(DOC, 'swing', '10');
    expect(r2.ok && lines(r2.doc)[16]).toBe('```loop id=demo bars=1 bpm=120 swing=10');
  });
});

describe('unit formatting', () => {
  it('formats frequencies', () => {
    expect(formatHz(800)).toBe('800Hz');
    expect(formatHz(20)).toBe('20Hz');
    expect(formatHz(999.4)).toBe('999.4Hz');
    expect(formatHz(1000)).toBe('1kHz');
    expect(formatHz(1200)).toBe('1.2kHz');
    expect(formatHz(4523.7)).toBe('4.52kHz');
    expect(formatHz(20000)).toBe('20kHz');
  });

  it('formats times', () => {
    expect(formatSeconds(0.005)).toBe('5ms');
    expect(formatSeconds(0.12)).toBe('120ms');
    expect(formatSeconds(0.9994)).toBe('999.4ms');
    expect(formatSeconds(1)).toBe('1s');
    expect(formatSeconds(2.5)).toBe('2.5s');
  });

  it('formats gains, ratios and pitch', () => {
    expect(formatDb(0)).toBe('0dB');
    expect(formatDb(-6)).toBe('-6dB');
    expect(formatDb(-7.54)).toBe('-7.5dB');
    expect(formatRatio(0.7)).toBe('70%');
    expect(formatRatio(0)).toBe('0%');
    expect(formatRatio(1)).toBe('100%');
    expect(formatCents(22)).toBe('22c');
    expect(formatSemitones(-12)).toBe('-12st');
  });

  it('dispatches on unit family', () => {
    expect(formatFor('hz', 1200)).toBe('1.2kHz');
    expect(formatFor('bool', true)).toBe('on');
    expect(formatFor('bool', false)).toBe('off');
    expect(formatFor('enum', 'lp24')).toBe('lp24');
    expect(formatFor('int', 7.4)).toBe('7');
  });

  it('names notes, honouring flats', () => {
    expect(formatNote(60)).toBe('C4');
    expect(formatNote(48)).toBe('C3');
    expect(formatNote(51)).toBe('D#3');
    expect(formatNote(51, true)).toBe('Eb3');
    expect(formatNote(127)).toBe('G9');
  });
});

// --------------------------------------------------------- A3: phrase spans

describe('phrase cell spans', () => {
  const F = '```';
  const DOC = [
    '# song', // 1
    '', // 2
    `${F}phrase id=p key=C scale=minor res=1/16 bars=1`, // 3
    'grid:', // 4
    '  #     1...2...3...4...', // 5
    "  5'   |o---....o---....|", // 6
    '  1    |o-------....o---|', // 7
    '', // 8
    'detail:', // 9
    '  1.1 : { vel: 90% }', // 10
    F, // 11
    '', // 12
    'Prose that must survive.', // 13
  ].join('\n');

  const loaded = loadPhrase(DOC, 'p')!;

  it('finds a phrase by id and keeps its document positions', () => {
    expect(loaded.phrase.rows.map((r) => r.line)).toEqual([6, 7]);
    expect(loaded.phrase.gridLine).toBe(4);
    expect(loaded.phrase.detailLine).toBe(9);
  });

  it('gives every cell a one-character span, shared column by column', () => {
    expect(cellSpan(loaded.phrase, 0, 0)).toEqual({ line: 6, col: 9, endCol: 10 });
    expect(cellSpan(loaded.phrase, 1, 0)).toEqual({ line: 7, col: 9, endCol: 10 });
    expect(cellSpan(loaded.phrase, 1, 15)).toEqual({ line: 7, col: 24, endCol: 25 });
    expect(cellSpan(loaded.phrase, 2, 0)).toBeNull();
  });

  it('writes one character and leaves every other byte identical', () => {
    const r = writeCell(DOC, loaded.phrase, 0, 4, 'o');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc).toHaveLength(DOC.length);
    const differing = [...DOC].filter((c, i) => c !== r.doc[i]);
    expect(differing).toEqual(['.']);
    expect(r.doc.split('\n')[5]).toBe("  5'   |o---o...o---....|");
    expect(r.doc.endsWith('Prose that must survive.')).toBe(true);
  });

  it('rewrites the grid block when the geometry moves', () => {
    const r = replaceGridBlock(DOC, loaded.phrase, ['grid:', '  1 |o---............|']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.split('\n').slice(3, 6)).toEqual(['grid:', '  1 |o---............|', '']);
    expect(r.doc).toContain('Prose that must survive.');
  });

  it('replaces, appends and removes the detail block', () => {
    const replaced = replaceDetailBlock(DOC, loaded.phrase, ['  1.1 : { vel: 40% }']);
    expect(replaced.ok && replaced.doc.split('\n')[9]).toBe('  1.1 : { vel: 40% }');

    const removed = replaceDetailBlock(DOC, loaded.phrase, []);
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.doc).not.toContain('detail:');
    expect(removed.doc.split('\n')[7]).toBe(F);

    const bare = removed.doc;
    const again = loadPhrase(bare, 'p')!;
    const added = replaceDetailBlock(bare, again.phrase, ['  1.1 : { gate: 50% }']);
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.doc.split('\n').slice(7, 10)).toEqual(['', 'detail:', '  1.1 : { gate: 50% }']);
  });
});
