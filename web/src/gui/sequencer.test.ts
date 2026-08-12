import { describe, it, expect } from 'vitest';
import {
  parseGridLine,
  renderGridLine,
  emptyGridLine,
  cellText,
  toggleCell,
  clearCell,
  transposeCell,
  setTieCell,
  resampleLine,
  noteBefore,
  firstNote,
  type GridLine,
} from './sequencer.ts';
import { compile } from '../dsl/compile.ts';
import { setLoopLine, loopLines } from '../dsl/edit.ts';
import { DEFAULT_DOC } from '../defaultDoc.ts';

const SR = 48000;

describe('parse → render round trip', () => {
  it('regenerates a simple line verbatim', () => {
    const line = parseGridLine('kick: C1 . . . | C1 . . . | C1 . . . | C1 . . .', 1)!;
    expect(line.trackId).toBe('kick');
    expect(line.cells).toHaveLength(16);
    expect(line.cellsPerBeat).toBe(4);
    expect(renderGridLine(line)).toBe('kick: C1 . . . | C1 . . . | C1 . . . | C1 . . .');
  });

  it('keeps flats and chord spelling', () => {
    const src = 'lead: [C3 Eb3 G3] ~ ~ . | Bb3 . . .';
    const line = parseGridLine(src, 0.5)!;
    expect(cellText(line.cells[0]!)).toBe('[C3 Eb3 G3]');
    expect(cellText(line.cells[4]!)).toBe('Bb3');
    expect(renderGridLine(line)).toBe(src);
  });

  it('every line of the default document survives a round trip (same events)', () => {
    const before = compile(DEFAULT_DOC, SR);
    expect(before.errors).toEqual([]);

    let doc = DEFAULT_DOC;
    for (const ref of loopLines(DEFAULT_DOC)) {
      const line = parseGridLine(`${ref.trackId}:${ref.cellsText}`, before.loopMeta!.bars)!;
      expect(line.cellsPerBeat).toBe(4);
      const r = setLoopLine(doc, ref.trackId, renderGridLine(line, 6));
      expect(r.ok).toBe(true);
      if (r.ok) doc = r.doc;
    }

    const after = compile(doc, SR);
    expect(after.errors).toEqual([]);
    expect(after.loop!.lengthSamples).toBe(before.loop!.lengthSamples);
    expect(after.loop!.events).toEqual(before.loop!.events);
  });
});

describe('cell edits', () => {
  const line = () => parseGridLine('x: C3 . . . | . . . . | . . . . | . . . .', 1)!;

  it('tap on a rest places the previous note (single-pitch tracks toggle)', () => {
    const out = toggleCell(line(), 4);
    expect(cellText(out.cells[4]!)).toBe('C3');
    expect(renderGridLine(out)).toBe('x: C3 . . . | C3 . . . | . . . . | . . . .');
  });

  it('tap on a note clears it', () => {
    const out = toggleCell(line(), 0);
    expect(out.cells[0]!.kind).toBe('rest');
    expect(renderGridLine(out)).toBe('x: . . . . | . . . . | . . . . | . . . .');
  });

  it('clearing a note takes its tie chain with it', () => {
    const l = parseGridLine('x: C3 ~ ~ . | . . . .', 0.5)!;
    const out = clearCell(l, 0);
    expect(renderGridLine(out)).toBe('x: . . . . | . . . .');
  });

  it('falls back to the line’s first note, then C3', () => {
    const l = parseGridLine('x: . . . . | . . . Eb4', 0.5)!;
    expect(firstNote(l)).toEqual([63]);
    expect(cellText(toggleCell(l, 0).cells[0]!)).toBe('D#4');

    const blank = emptyGridLine('x', 1);
    expect(noteBefore(blank, 4)).toBeNull();
    expect(cellText(toggleCell(blank, 0).cells[0]!)).toBe('C3');
  });

  it('uses the last note the user picked when given', () => {
    const out = toggleCell(line(), 8, [67]);
    expect(cellText(out.cells[8]!)).toBe('G4');
  });

  it('transposes a cell, keeping accidental style', () => {
    const l = parseGridLine('x: Eb3 . . .', 0.25)!;
    expect(cellText(transposeCell(l, 0, 2).cells[0]!)).toBe('F3');
    expect(cellText(transposeCell(l, 0, -3).cells[0]!)).toBe('C3');
    // Sharps stay sharp.
    const sharp = parseGridLine('x: F#3 . . .', 0.25)!;
    expect(cellText(transposeCell(sharp, 0, 1).cells[0]!)).toBe('G3');
  });

  it('transposes a whole chord as a block', () => {
    const l = parseGridLine('x: [C3 Eb3 G3] . . .', 0.25)!;
    const out = transposeCell(l, 0, 12);
    expect(out.cells[0]!.notes).toEqual([60, 63, 67]);
    expect(cellText(out.cells[0]!)).toBe('[C4 Eb4 G4]');
  });

  it('refuses to transpose out of MIDI range', () => {
    const l = parseGridLine('x: C-1 . . .', 0.25)!;
    expect(transposeCell(l, 0, -1)).toBe(l);
  });

  it('ties extend the previous note and need one to exist', () => {
    const out = setTieCell(line(), 1);
    expect(renderGridLine(out)).toBe('x: C3 ~ . . | . . . . | . . . . | . . . .');
    const blank = emptyGridLine('x', 1);
    expect(setTieCell(blank, 3)).toBe(blank); // nothing to extend
    const l = line();
    expect(setTieCell(l, 0)).toBe(l); // a tie can never be the first cell
  });
});

describe('resolution resampling', () => {
  it('1/16 → 1/8 keeps the onsets when the odd steps are free', () => {
    const l = parseGridLine('x: C3 . . . | C3 . . . | C3 . . . | C3 . . .', 1)!;
    const r = resampleLine(l, 2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.line.cells).toHaveLength(8);
    expect(renderGridLine(r.line)).toBe('x: C3 . | C3 . | C3 . | C3 .');
  });

  it('1/16 → 1/8 refuses when an off-grid note would be lost', () => {
    // The note on step 4 sits on an odd 16th, so halving the grid would drop it.
    const l = parseGridLine('x: C3 . . C3 | . . . . | . . . . | . . . .', 1)!;
    const r = resampleLine(l, 2);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/step 4 would be lost/);
  });

  it('1/16 → 1/8 allows notes that land on the coarser grid', () => {
    const l = parseGridLine('x: C3 . C3 . | . . . . | . . . . | . . . .', 1)!;
    const r = resampleLine(l, 2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(renderGridLine(r.line)).toBe('x: C3 C3 | . . | . . | . .');
  });

  it('1/8 → 1/16 preserves durations by padding with ties', () => {
    const l = parseGridLine('x: C3 . | C3 ~ | . . | Eb3 .', 1)!;
    expect(l.cellsPerBeat).toBe(2);
    const r = resampleLine(l, 4);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.line.cells).toHaveLength(16);
    expect(renderGridLine(r.line)).toBe('x: C3 ~ . . | C3 ~ ~ ~ | . . . . | Eb3 ~ . .');
  });

  it('round-trips a line through 1/8 and back with identical timing', () => {
    const src = 'x: C3 ~ . . | C3 ~ ~ ~ | . . . . | Eb3 ~ . .';
    const l = parseGridLine(src, 1)!;
    const down = resampleLine(l, 2);
    expect(down.ok).toBe(true);
    if (!down.ok) return;
    const up = resampleLine(down.line, 4);
    expect(up.ok).toBe(true);
    if (!up.ok) return;
    expect(renderGridLine(up.line)).toBe(src);
  });

  it('upsampling then downsampling a document keeps the events identical', () => {
    const before = compile(DEFAULT_DOC, SR);
    const ref = loopLines(DEFAULT_DOC).find((l) => l.trackId === 'kick')!;
    const line = parseGridLine(`kick:${ref.cellsText}`, 1)!;

    const down = resampleLine(line, 2);
    expect(down.ok).toBe(true);
    if (!down.ok) return;
    const patched = setLoopLine(DEFAULT_DOC, 'kick', renderGridLine(down.line, 6));
    expect(patched.ok).toBe(true);
    if (!patched.ok) return;

    const after = compile(patched.doc, SR);
    expect(after.errors).toEqual([]);
    expect(after.loopMeta!.lines.find((l) => l.trackId === 'kick')!.cellsPerBeat).toBe(2);
    // Same kick onsets, now written as eighths.
    const onsets = (r: typeof after) =>
      r.loop!.events.filter((e) => e.track === 2 && e.kind === 0).map((e) => e.offsetSamples);
    expect(onsets(after)).toEqual(onsets(before));
  });
});

describe('new lines', () => {
  it('builds an all-rest line at the requested resolution', () => {
    const l = emptyGridLine('hat', 1);
    expect(l.cells).toHaveLength(16);
    expect(renderGridLine(l)).toBe('hat: . . . . | . . . . | . . . . | . . . .');
  });

  it('pads the id prefix so rows line up', () => {
    const a = renderGridLine(emptyGridLine('hat', 0.25), 6);
    const b = renderGridLine(emptyGridLine('lead', 0.25), 6);
    expect(a).toBe('hat:   . . . .');
    expect(b).toBe('lead:  . . . .');
  });

  it('an appended line compiles as a real (silent) track', () => {
    const doc = DEFAULT_DOC;
    const line = emptyGridLine('lead', 1);
    const r = setLoopLine(doc, 'lead', renderGridLine(line, 6));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const after = compile(r.doc, SR);
    expect(after.errors).toEqual([]);
    expect(after.loop!.events.some((e) => e.track === 0)).toBe(false);
  });
});

describe('grid model shape', () => {
  it('marks rest / note / tie / chord distinctly', () => {
    const l: GridLine = parseGridLine('x: C3 ~ . [C3 G3]', 0.25)!;
    expect(l.cells.map((c) => c.kind)).toEqual(['note', 'tie', 'rest', 'note']);
    expect(l.cells[3]!.notes).toEqual([48, 55]);
  });

  it('reports an unusable resolution as 0 rather than guessing', () => {
    const l = parseGridLine('x: C3 . .', 1)!;
    expect(l.cellsPerBeat).toBe(0);
  });
});
