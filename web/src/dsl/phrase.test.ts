// A1: the grid and detail parser (docs/workstreams.md §2-§5, §9).

import { describe, it, expect } from 'vitest';
import {
  parsePhrase,
  resolveGestures,
  resolveGestureSources,
  cellCoords,
  canonicalTags,
  resToCellsPerBeat,
  type Phrase,
} from './phrase.ts';
import { noteToMidi, resolveRowLabel } from './pitch.ts';

const SPEC = [
  'grid:',
  '  #     1...2...3...4...',
  "  5'   |a---....o---....|",
  "  b3'  |a---............|",
  '  1    |b-------....o---|',
  '',
  'detail:',
  '  1.1a   : { roll: +12ms }',
  '  1.1:1  : { vel: 90% }',
].join('\n');

const SPEC_ATTRS = { id: 'verse-lead', key: 'C', scale: 'minor', res: '1/16', bars: '1' };

function parse(body: string, attrs: Record<string, string> = SPEC_ATTRS, startLine = 1) {
  return parsePhrase(body, attrs, { bodyStartLine: startLine });
}

function ok(body: string, attrs: Record<string, string> = SPEC_ATTRS): Phrase {
  const r = parse(body, attrs);
  expect(r.errors).toEqual([]);
  return r.phrase as Phrase;
}

describe('res', () => {
  it('maps a fraction of a whole note onto cells per beat', () => {
    expect(resToCellsPerBeat('1/16')).toBe(4);
    expect(resToCellsPerBeat('1/8')).toBe(2);
    expect(resToCellsPerBeat('1/12')).toBe(3);
    expect(resToCellsPerBeat('1/32')).toBe(8);
    expect(resToCellsPerBeat('1/6')).toBeNull(); // not a whole number of cells
    expect(resToCellsPerBeat('nonsense')).toBeNull();
  });
});

describe('row labels', () => {
  const ctx = { tonic: 0, scale: 'minor' };

  it('resolves degrees through key and scale', () => {
    expect(resolveRowLabel('1', ctx)).toEqual({ ok: true, midi: 48 }); // C3
    expect(resolveRowLabel('b3', ctx)).toEqual({ ok: true, midi: 51 }); // Eb3, a minor third
    expect(resolveRowLabel('5', ctx)).toEqual({ ok: true, midi: 55 }); // G3
    expect(resolveRowLabel("5'", ctx)).toEqual({ ok: true, midi: 67 });
    expect(resolveRowLabel('1,', ctx)).toEqual({ ok: true, midi: 36 });
  });

  it('is case sensitive: b3 is a minor third, B3 is a note', () => {
    expect(resolveRowLabel('b3', ctx)).toEqual({ ok: true, midi: 51 });
    expect(resolveRowLabel('B3', ctx)).toEqual({ ok: true, midi: noteToMidi('B3') });
  });

  it('resolves percussion through the kit map', () => {
    expect(resolveRowLabel('kick', ctx)).toEqual({ ok: true, midi: 24 });
    expect(resolveRowLabel('nope', ctx).ok).toBe(false);
  });
});

describe('the fence in §2', () => {
  const phrase = ok(SPEC);

  it('reads rows, onsets, lengths and groups', () => {
    expect(phrase.rows.map((r) => [r.label, r.midi])).toEqual([
      ["5'", 67],
      ["b3'", 63],
      ['1', 48],
    ]);
    expect(phrase.notes).toEqual([
      { row: 0, onset: 0, length: 4, tag: 'a' },
      { row: 1, onset: 0, length: 4, tag: 'a' },
      { row: 2, onset: 0, length: 8, tag: 'b' },
      { row: 0, onset: 8, length: 4, tag: 'o' },
      { row: 2, onset: 12, length: 4, tag: 'o' },
    ]);
  });

  it('keeps the geometry needed for one-character edits', () => {
    expect(phrase.cellCols).toHaveLength(16);
    // Every row shares the geometry, so cell 0 sits at the same column.
    expect(phrase.cellCols[0]).toBe(9);
    expect(phrase.cellCols[15]).toBe(24);
    expect(phrase.barCols).toEqual([]);
  });

  it('parses the detail block', () => {
    expect(phrase.detail).toHaveLength(2);
    expect(phrase.detail[0]!.address.text).toBe('1.1a');
    expect(phrase.detail[0]!.gestures.roll).toBeCloseTo(0.012, 9);
    expect(phrase.detail[1]!.address.text).toBe('1.1:1');
    expect(phrase.detail[1]!.gestures.vel).toBeCloseTo(0.9, 9);
  });

  it('places notes on the beat grid', () => {
    expect(cellCoords(phrase, 0)).toEqual({ bar: 1, beat: 1, tick: 1 });
    expect(cellCoords(phrase, 8)).toEqual({ bar: 1, beat: 3, tick: 1 });
    expect(cellCoords(phrase, 14)).toEqual({ bar: 1, beat: 4, tick: 3 });
  });
});

describe('the cascade (§5)', () => {
  const body = [
    'grid:',
    "  5'  |o---o---o---o---|",
    '  1   |o---o---o---o---|',
    '',
    'detail:',
    '  *      : { vel: 50% }',
    '  1      : { vel: 60% }',
    '  1.2    : { vel: 70% }',
    "  1.3:5' : { vel: 80% }",
    '  1.4    : { nudge: +5ms }',
  ].join('\n');
  const phrase = ok(body);

  it('lets the most specific entry win, per gesture key', () => {
    const vel = (onset: number, row: number) =>
      resolveGestures(phrase, phrase.notes.find((n) => n.onset === onset && n.row === row)!).vel;
    expect(vel(0, 0)).toBeCloseTo(0.6, 9); // bar beats the wildcard
    expect(vel(4, 0)).toBeCloseTo(0.7, 9); // beat beats the bar
    expect(vel(8, 0)).toBeCloseTo(0.8, 9); // beat + row beats the beat
    expect(vel(8, 1)).toBeCloseTo(0.6, 9); // the row entry misses this one
  });

  it('resolves each gesture independently', () => {
    const note = phrase.notes.find((n) => n.onset === 12 && n.row === 0)!;
    const g = resolveGestures(phrase, note);
    expect(g.vel).toBeCloseTo(0.6, 9); // inherited from the bar entry
    expect(g.nudge).toBeCloseTo(0.005, 9);
    expect(resolveGestureSources(phrase, note)).toEqual({ vel: '1', nudge: '1.4' });
  });

  it('breaks a tie in favour of the entry written later', () => {
    const later = ok(['grid:', '  1 |o---o---o---o---|', '', 'detail:', '  1 : { vel: 10% }', '  1 : { vel: 20% }'].join('\n'));
    expect(resolveGestures(later, later.notes[0]!).vel).toBeCloseTo(0.2, 9);
  });
});

describe('groups (§3)', () => {
  it('collapses to `o` when every note at an onset is one group', () => {
    const phrase = ok(['grid:', "  5'  |a---............|", '  1   |a---............|'].join('\n'));
    expect(canonicalTags(phrase.notes)).toEqual(['o', 'o']);
  });

  it('assigns a, b, c from the top row down', () => {
    const phrase = ok(['grid:', "  5'  |b---............|", "  b3' |c---............|", '  1   |a---............|'].join('\n'));
    expect(canonicalTags(phrase.notes)).toEqual(['a', 'b', 'c']);
  });
});

describe('errors (§9)', () => {
  const errorsFor = (body: string, attrs: Record<string, string> = SPEC_ATTRS) => parse(body, attrs, 10).errors;

  it('rejects a row whose length is not bars × 4 × cells per beat', () => {
    const e = errorsFor(['grid:', '  1 |o---|'].join('\n'));
    expect(e[0]!.message).toMatch(/has 4 cells, expected 16/);
    expect(e[0]!.line).toBe(11);
  });

  it('rejects bar lines that are not in the same column on every row', () => {
    const e = errorsFor(
      ['grid:', "  5' |o---o---|o---o---|", '  1  |o---o---o|---o---|'].join('\n'),
      { ...SPEC_ATTRS, bars: '2', res: '1/8' },
    );
    expect(e[0]!.message).toMatch(/same column/);
  });

  it('rejects a hold with no onset before it', () => {
    const e = errorsFor(['grid:', '  1 |--------........|'].join('\n'));
    expect(e[0]!.message).toMatch(/holds the note before it/);
    expect(e[0]!.col).toBe(6);
  });

  it('rejects a duplicate row label', () => {
    const e = errorsFor(['grid:', '  1 |o---............|', '  1 |o---............|'].join('\n'));
    expect(e[0]!.message).toMatch(/duplicate row label "1"/);
  });

  it('rejects mixed namespaces', () => {
    const e = errorsFor(['grid:', '  1    |o---............|', '  kick |o---............|'].join('\n'));
    expect(e[0]!.message).toMatch(/may not mix/);
  });

  it('rejects an unknown row label', () => {
    const e = errorsFor(['grid:', '  9 |o---............|'].join('\n'));
    expect(e[0]!.message).toMatch(/degree 9 is outside/);
  });

  it('rejects an orphan address rather than ignoring it', () => {
    const e = errorsFor(['grid:', '  1 |o---............|', '', 'detail:', '  4.2 : { vel: 50% }'].join('\n'));
    expect(e[0]!.message).toMatch(/names no note/);
  });

  it('rejects a malformed address', () => {
    const e = errorsFor(['grid:', '  1 |o---............|', '', 'detail:', '  1..2 : { vel: 50% }'].join('\n'));
    expect(e[0]!.message).toMatch(/malformed address/);
  });

  it('rejects roll on something that is not a group', () => {
    const e = errorsFor(['grid:', '  1 |o---............|', '', 'detail:', '  1.1 : { roll: +5ms }'].join('\n'));
    expect(e[0]!.message).toMatch(/roll applies to a group/);
  });

  it('rejects a bare number where a unit is required', () => {
    const e = errorsFor(['grid:', '  1 |o---............|', '', 'detail:', '  1.1 : { vel: 0.9 }'].join('\n'));
    expect(e[0]!.message).toMatch(/must be a percentage/);
  });

  it('reports an unusable cell glyph with a column', () => {
    const e = errorsFor(['grid:', '  1 |o---...?........|'].join('\n'));
    expect(e[0]!.message).toMatch(/is not a cell/);
    expect(e[0]!.col).toBe(13);
  });

  it('requires an id', () => {
    const e = errorsFor(['grid:', '  1 |o---............|'].join('\n'), { key: 'C' });
    expect(e[0]!.message).toMatch(/needs an id/);
  });
});

describe('gliss', () => {
  it('takes an interval or a row target, with cells and a curve', () => {
    const phrase = ok(
      [
        'grid:',
        "  5' |o---............|",
        '  1  |....o---........|',
        '',
        'detail:',
        '  1.1 : { gliss: { to: +5st, cells: 3, curve: exp } }',
        "  1.2 : { gliss: { to: 5' } }",
      ].join('\n'),
    );
    expect(phrase.detail[0]!.gestures.gliss).toEqual({
      to: { kind: 'interval', semitones: 5 },
      cells: 3,
      curve: 'exp',
    });
    expect(phrase.detail[1]!.gestures.gliss).toEqual({
      to: { kind: 'row', label: "5'" },
      cells: null,
      curve: 'linear',
    });
  });
});
