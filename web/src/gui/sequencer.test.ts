// A6: the sequencer as a projection of a phrase grid. Every gesture is one of
// the operations in dsl/ops.ts — the GUI has no vocabulary of its own.

import { describe, it, expect } from 'vitest';
import {
  projectPhrase,
  noteAt,
  addressOf,
  tapOp,
  movePitchOp,
  resizeOp,
  groupOp,
  velocityOp,
} from './sequencer.ts';
import { parsePhrase, type Phrase } from '../dsl/phrase.ts';
import { applyText } from '../dsl/ops.ts';
import { formatPhrase } from '../dsl/format.ts';
import { loadPhrase } from '../dsl/edit.ts';

const F = '```';

const BODY = [
  'grid:',
  "  5'  |a---....o---....|",
  "  b3' |a---............|",
  '  1   |b-------....o---|',
].join('\n');

function phraseOf(body: string): Phrase {
  const r = parsePhrase(body, { id: 'p', key: 'C', scale: 'minor', res: '1/16', bars: '1' });
  expect(r.errors).toEqual([]);
  return r.phrase as Phrase;
}

function docWith(body: string): string {
  return ['# song', '', `${F}phrase id=p key=C scale=minor res=1/16 bars=1`, body, F, ''].join('\n');
}

const PHRASE = phraseOf(BODY);
const GRID = projectPhrase(PHRASE, 'lead');

describe('projection', () => {
  it('lays the rows out in the order the phrase has them', () => {
    expect(GRID.rows.map((r) => r.label)).toEqual(["5'", "b3'", '1']);
    expect(GRID.totalCells).toBe(16);
    expect(GRID.cellsPerBeat).toBe(4);
  });

  it('marks onsets, holds and rests', () => {
    const row = GRID.rows[2]!;
    expect(row.cells[0]!.kind).toBe('onset');
    expect(row.cells[1]!.kind).toBe('hold');
    expect(row.cells[8]!.kind).toBe('rest');
    expect(row.cells[12]!.kind).toBe('onset');
  });

  it('shows the canonical group tag, so a chord is visible', () => {
    expect(GRID.rows[0]!.cells[0]!.tag).toBe('a');
    expect(GRID.rows[2]!.cells[0]!.tag).toBe('b');
    // A note alone at its onset is a group of one, spelled `o`.
    expect(GRID.rows[0]!.cells[8]!.tag).toBe('o');
  });

  it('finds the note under any cell of its run', () => {
    expect(noteAt(GRID, 2, 3)?.onset).toBe(0);
    expect(noteAt(GRID, 2, 9)).toBeNull();
  });

  it('names a note by bar, beat, tick and row', () => {
    expect(addressOf(PHRASE, noteAt(GRID, 0, 8)!)).toBe("1.3.1:5'");
  });
});

describe('gestures produce operations', () => {
  it('taps an empty cell into a note and a sounding one out', () => {
    expect(tapOp(PHRASE, GRID, 1, 8)).toEqual({ kind: 'note.add', row: "b3'", onset: 8, length: 1 });
    expect(tapOp(PHRASE, GRID, 0, 9)).toEqual({ kind: 'note.remove', address: "1.3.1:5'" });
  });

  it('drags a note to the row above', () => {
    expect(movePitchOp(PHRASE, GRID, 2, 12, 1)).toEqual({
      kind: 'note.movePitch',
      address: '1.4.1:1',
      row: "b3'",
    });
    expect(movePitchOp(PHRASE, GRID, 0, 0, 5)).toBeNull(); // already at the top
    expect(movePitchOp(PHRASE, GRID, 1, 8, 1)).toBeNull(); // no note here
  });

  it('drags a note longer', () => {
    expect(resizeOp(PHRASE, GRID, 0, 8, 6)).toEqual({ kind: 'note.resize', address: "1.3.1:5'", length: 6 });
    expect(resizeOp(PHRASE, GRID, 0, 8, 4)).toBeNull(); // unchanged
  });

  it('joins and leaves a group', () => {
    expect(groupOp(PHRASE, GRID, 0, 0)).toEqual({ kind: 'group.detach', address: "1.1.1:5'" });
    expect(groupOp(PHRASE, GRID, 2, 0)).toEqual({
      kind: 'group.merge',
      addresses: ["1.1.1:5'", "1.1.1:b3'", '1.1.1:1'],
    });
    expect(groupOp(PHRASE, GRID, 0, 8)).toBeNull(); // nothing to group with
  });

  it('sets a velocity on the note under the cursor', () => {
    expect(velocityOp(PHRASE, GRID, 0, 8, 0.6)).toEqual({
      kind: 'detail.set',
      address: "1.3.1:5'",
      key: 'vel',
      value: 0.6,
    });
  });
});

describe('a gesture round-trips through the document', () => {
  it('taps a note in and reads it back from the re-parsed text', () => {
    // Start from canonical text, so the round trip has somewhere to return to.
    const doc = docWith(formatPhrase(PHRASE));
    const op = tapOp(PHRASE, GRID, 1, 8)!;
    const r = applyText(doc, 'p', op);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const after = loadPhrase(r.doc, 'p')!.phrase;
    const grid = projectPhrase(after, 'lead');
    expect(grid.rows[1]!.cells[8]!.kind).toBe('onset');
    // And tapping it again takes it away, leaving the original text.
    const back = applyText(r.doc, 'p', tapOp(after, grid, 1, 8)!);
    expect(back.ok && back.doc).toBe(doc);
  });
});
