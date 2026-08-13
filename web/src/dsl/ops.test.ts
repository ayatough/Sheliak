// A4: the operation set, and invariant 1 — the GUI and the text are the same
// thing (docs/workstreams.md §7, §8).

import { describe, it, expect } from 'vitest';
import { applyModel, applyText, type Op } from './ops.ts';
import { formatPhrase } from './format.ts';
import { parsePhrase, type Phrase } from './phrase.ts';
import { loadPhrase } from './edit.ts';

const F = '```';
const HEAD = '```phrase id=p key=C scale=minor res=1/16 bars=1';

const BODY = [
  'grid:',
  '  #     1...2...3...4...',
  "  5'   |a---....o---....|",
  "  b3'  |a---............|",
  '  1    |b-------....o---|',
  '',
  'detail:',
  '  1.1a  : { roll: +12ms }',
  '  1.1:1 : { vel: 90% }',
].join('\n');

/** A document with prose on both sides, so locality has something to protect. */
function docWith(body: string): string {
  return ['# a song', '', 'Some prose.', '', HEAD, body, F, '', 'More prose.', ''].join('\n');
}

const DOC = docWith(BODY);

function phraseOf(doc: string): Phrase {
  const loaded = loadPhrase(doc, 'p');
  expect(loaded).not.toBeNull();
  return (loaded as { phrase: Phrase }).phrase;
}

/** Run one operation both ways and assert invariant 1 for it. */
function both(doc: string, op: Op): { doc: string; phrase: Phrase } {
  const before = phraseOf(doc);
  const model = applyModel(before, op);
  const text = applyText(doc, 'p', op);
  expect(model.ok, model.ok ? '' : `model refused: ${(model as { reason: string }).reason}`).toBe(true);
  expect(text.ok, text.ok ? '' : `text refused: ${(text as { reason: string }).reason}`).toBe(true);
  if (!model.ok || !text.ok) throw new Error('unreachable');

  const reparsed = phraseOf(text.doc);
  expect(formatPhrase(reparsed)).toBe(formatPhrase(model.phrase));
  return { doc: text.doc, phrase: reparsed };
}

function refuses(doc: string, op: Op, pattern: RegExp): void {
  const model = applyModel(phraseOf(doc), op);
  expect(model.ok).toBe(false);
  expect((model as { reason: string }).reason).toMatch(pattern);
  const text = applyText(doc, 'p', op);
  expect(text.ok).toBe(false);
}

function gridOf(doc: string): string[] {
  return doc.split('\n').filter((l) => l.includes('|'));
}

// ------------------------------------------------------------------ locality

describe('invariant 4 — locality', () => {
  it('changes exactly one character when a note is placed', () => {
    // Cell 4 has no other onset, so the added note is a group of one: the
    // canonical tags of its neighbours do not move.
    const after = both(DOC, { kind: 'note.add', row: "b3'", onset: 4, length: 1 }).doc;
    expect(after).toHaveLength(DOC.length);
    let differing = 0;
    for (let i = 0; i < DOC.length; i++) if (DOC[i] !== after[i]) differing++;
    expect(differing).toBe(1);
  });

  it('leaves the prose and the other rows byte for byte', () => {
    const after = both(DOC, { kind: 'note.remove', address: "1.3:5'" }).doc;
    expect(after.startsWith('# a song\n\nSome prose.\n')).toBe(true);
    expect(after.endsWith('\nMore prose.\n')).toBe(true);
    expect(after.split('\n').filter((l) => l.includes("b3'"))).toEqual(
      DOC.split('\n').filter((l) => l.includes("b3'")),
    );
  });

  it('touches one line when a detail entry changes', () => {
    const after = both(DOC, { kind: 'detail.set', address: '1.1:1', key: 'vel', value: 0.5 }).doc;
    const changed = after.split('\n').filter((l, i) => l !== DOC.split('\n')[i]);
    expect(changed).toEqual(['  1.1:1 : { vel: 50% }']);
  });
});

// ----------------------------------------------------------------- note ops

describe('note operations', () => {
  it('adds a note of the requested length', () => {
    const { phrase } = both(DOC, { kind: 'note.add', row: '1', onset: 8, length: 4 });
    expect(phrase.notes.find((n) => n.onset === 8 && phrase.rows[n.row]!.label === '1')?.length).toBe(4);
  });

  it('refuses to stack two notes in one row', () => {
    refuses(DOC, { kind: 'note.add', row: '1', onset: 2, length: 1 }, /already sounds/);
  });

  it('removes every note an address names', () => {
    const { phrase } = both(DOC, { kind: 'note.remove', address: '1.1a' });
    expect(phrase.notes).toHaveLength(3);
    // The entry that named only the removed group goes with it.
    expect(phrase.detail.map((e) => e.address.text)).toEqual(['1.1:1']);
  });

  it('moves a note to another row', () => {
    const { phrase } = both(DOC, { kind: 'note.movePitch', address: "1.3:5'", row: "b3'" });
    expect(phrase.notes.some((n) => n.onset === 8 && phrase.rows[n.row]!.label === "b3'")).toBe(true);
    expect(phrase.notes.some((n) => n.onset === 8 && phrase.rows[n.row]!.label === "5'")).toBe(false);
  });

  it('moves a note in time', () => {
    const { phrase } = both(DOC, { kind: 'note.moveTime', address: "1.3:5'", onset: 9 });
    expect(phrase.notes.some((n) => n.onset === 9 && phrase.rows[n.row]!.label === "5'")).toBe(true);
  });

  it('resizes a note', () => {
    const { phrase } = both(DOC, { kind: 'note.resize', address: "1.3:5'", length: 2 });
    expect(phrase.notes.find((n) => n.onset === 8)?.length).toBe(2);
  });

  it('refuses a resize that would collide', () => {
    refuses(DOC, { kind: 'note.resize', address: '1.1:1', length: 16 }, /in the way/);
  });

  it('generates a run along the scale', () => {
    const body = ['grid:', "  5'  |................|", "  b3' |................|", '  1   |................|'].join('\n');
    const { phrase } = both(docWith(body), { kind: 'note.insertRun', from: '1', to: "5'", onset: 0, cells: 3 });
    expect(
      phrase.notes.map((n) => [n.onset, phrase.rows[n.row]!.label]),
    ).toEqual([[0, '1'], [1, "b3'"], [2, "5'"]]);
  });
});

describe('§7 rule 4 — a moved note takes its detail with it', () => {
  it('rewrites an address that named only that note', () => {
    const { phrase } = both(DOC, { kind: 'note.moveTime', address: "1.3:5'", onset: 9 });
    // `1.1:1` is untouched; a note-specific entry would have followed.
    expect(phrase.detail.map((e) => e.address.text)).toEqual(['1.1a', '1.1:1']);
  });

  it('follows the note when the entry named it alone', () => {
    const body = [
      'grid:',
      "  5' |o---............|",
      '  1  |....o---........|',
      '',
      'detail:',
      "  1.1:5' : { vel: 40% }",
    ].join('\n');
    const { phrase } = both(docWith(body), { kind: 'note.moveTime', address: "1.1:5'", onset: 8 });
    expect(phrase.detail[0]!.address.text).toBe("1.3:5'");
    expect(phrase.detail[0]!.gestures.vel).toBeCloseTo(0.4, 9);
  });

  it('gives the note its own entry when others shared the address', () => {
    const body = [
      'grid:',
      "  5' |o---............|",
      '  1  |o---............|',
      '',
      'detail:',
      '  1.1 : { vel: 40% }',
    ].join('\n');
    const { phrase } = both(docWith(body), { kind: 'note.moveTime', address: "1.1:5'", onset: 8 });
    expect(phrase.detail.map((e) => e.address.text)).toEqual(['1.1', "1.3.1o:5'"]);
    expect(phrase.detail[1]!.gestures.vel).toBeCloseTo(0.4, 9);
  });
});

// ---------------------------------------------------------------- group ops

describe('group operations', () => {
  it('merges two notes at one onset into a chord', () => {
    const body = ['grid:', "  5' |a---............|", '  1  |b---............|'].join('\n');
    const { doc } = both(docWith(body), { kind: 'group.merge', addresses: ["1.1:5'", '1.1:1'] });
    // One group at the onset now, so the canonical tag is `o` on both rows.
    expect(gridOf(doc).every((l) => l.includes('|o---'))).toBe(true);
  });

  it('detaches one note from its group', () => {
    const { doc } = both(DOC, { kind: 'group.detach', address: "1.1:b3'" });
    const rows = gridOf(doc);
    expect(rows[0]!).toContain('|a---');
    expect(rows[1]!).toContain('|b---');
    expect(rows[2]!).toContain('|c-------');
  });

  it('refuses to merge across onsets', () => {
    refuses(DOC, { kind: 'group.merge', addresses: ["1.1:5'", "1.3:5'"] }, /one onset/);
  });
});

// ------------------------------------------------------------------ row ops

describe('row operations', () => {
  it('adds a row and re-sorts by pitch', () => {
    const { doc } = both(DOC, { kind: 'row.add', row: '4' });
    const labels = gridOf(doc).map((l) => l.trim().split(/\s+/)[0]);
    expect(labels).toEqual(["5'", "b3'", '4', '1']);
  });

  it('refuses a row from another namespace', () => {
    refuses(DOC, { kind: 'row.add', row: 'kick' }, /namespace/);
  });

  it('removes an empty row only', () => {
    const added = both(DOC, { kind: 'row.add', row: '4' }).doc;
    const { doc } = both(added, { kind: 'row.remove', row: '4' });
    expect(gridOf(doc)).toHaveLength(3);
    refuses(doc, { kind: 'row.remove', row: '1' }, /still has notes/);
  });
});

// --------------------------------------------------------------- detail ops

describe('detail operations', () => {
  it('sets a gesture on a new address', () => {
    const { phrase } = both(DOC, { kind: 'detail.set', address: "1.3:5'", key: 'gate', value: 0.6 });
    expect(phrase.detail.map((e) => e.address.text)).toEqual(['1.1a', '1.1:1', "1.3:5'"]);
  });

  it('clears one gesture and drops the entry when it empties', () => {
    const { phrase } = both(DOC, { kind: 'detail.clear', address: '1.1:1', key: 'vel' });
    expect(phrase.detail.map((e) => e.address.text)).toEqual(['1.1a']);
  });

  it('refuses roll on an address with no group', () => {
    refuses(DOC, { kind: 'detail.set', address: '1.1:1', key: 'roll', value: 0.01 }, /roll applies to a group/);
  });

  it('refuses an address that names no note', () => {
    refuses(DOC, { kind: 'detail.set', address: '2.1', key: 'vel', value: 0.5 }, /names no note/);
  });
});

// --------------------------------------------------------------- phrase ops

describe('phrase operations', () => {
  it('transposes the row labels, not the notes', () => {
    const { doc, phrase } = both(DOC, { kind: 'phrase.transpose', steps: 1 });
    expect(phrase.rows.map((r) => r.label)).toEqual(["6'", "4'", '2']);
    expect(gridOf(doc)[0]).toContain("6'  |a---....o---....|");
  });

  it('changes key and scale in the info string alone', () => {
    const text = applyText(DOC, 'p', { kind: 'phrase.setKey', key: 'Eb', scale: 'dorian' });
    expect(text.ok).toBe(true);
    if (!text.ok) return;
    expect(text.doc).toContain('```phrase id=p key=Eb scale=dorian res=1/16 bars=1');
    expect(text.doc.split('\n').slice(5)).toEqual(DOC.split('\n').slice(5));
    expect(phraseOf(text.doc).rows[0]!.midi).toBe(70); // 5' of Eb = Bb4
  });

  it('binds a loop line to a phrase id', () => {
    const doc = [F + 'loop id=g bars=1 bpm=120', 'lead:  verse', 'bass:  walk', F].join('\n');
    const r = applyText(doc, 'p', { kind: 'loop.bind', track: 'bass', phrase: 'chorus' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.doc.split('\n')[2]).toBe('bass: chorus');
  });
});

// ------------------------------------------------------------ non-canonical

describe('canonical output (§7 rule 1)', () => {
  it('canonicalizes a body the operation had to rewrite anyway', () => {
    const scruffy = ['grid:', "   5'    |....a---........|", '   1     |o-------........|'].join('\n');
    const doc = docWith(scruffy);
    const r = applyText(doc, 'p', { kind: 'note.add', row: '1', onset: 12, length: 4 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const phrase = phraseOf(r.doc);
    expect(r.doc).toContain(formatPhrase(phrase));
  });
});

// ------------------------------------------- invariant 1, over generated docs

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

const ROWS = ['1', 'b3', '5', "1'"];

function generateDoc(random: () => number): string {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;
  const rowCount = 2 + Math.floor(random() * 3);
  const labels = ROWS.slice(0, rowCount);
  const total = 16;
  const grid = labels.map(() => new Array<string>(total).fill('.'));
  for (let r = 0; r < labels.length; r++) {
    const row = grid[r] as string[];
    let i = 0;
    while (i < total) {
      if (random() < 0.35) {
        const length = 1 + Math.floor(random() * 3);
        row[i] = pick(['o', 'a', 'b']);
        for (let k = 1; k < length && i + k < total; k++) row[i + k] = '-';
        i += length;
      } else {
        i++;
      }
    }
  }
  const width = Math.max(...labels.map((l) => l.length));
  const body = ['grid:', ...labels.map((l, r) => `  ${l.padEnd(width)}  |${(grid[r] as string[]).join('')}|`)];
  return docWith(body.join('\n'));
}

/** A random operation, valid or not — refusal has to commute too. */
function generateOp(random: () => number, phrase: Phrase): Op {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;
  const label = () => (phrase.rows[Math.floor(random() * phrase.rows.length)] as { label: string }).label;
  const cell = () => Math.floor(random() * phrase.totalCells);
  const addressOf = (note: { onset: number; row: number; tag: string }) => {
    const beatIndex = Math.floor(note.onset / phrase.cellsPerBeat);
    const bar = Math.floor(beatIndex / 4) + 1;
    const beat = (beatIndex % 4) + 1;
    const tick = (note.onset % phrase.cellsPerBeat) + 1;
    return pick([
      `${bar}.${beat}.${tick}:${(phrase.rows[note.row] as { label: string }).label}`,
      `${bar}.${beat}.${tick}${note.tag}`,
      `${bar}.${beat}`,
    ]);
  };
  const anyNote = phrase.notes.length > 0 ? pick(phrase.notes) : null;
  const address = anyNote ? addressOf(anyNote) : '1.1';

  switch (Math.floor(random() * 9)) {
    case 0:
      return { kind: 'note.add', row: label(), onset: cell(), length: 1 + Math.floor(random() * 3) };
    case 1:
      return { kind: 'note.remove', address };
    case 2:
      return { kind: 'note.movePitch', address, row: label() };
    case 3:
      return { kind: 'note.moveTime', address, onset: cell() };
    case 4:
      return { kind: 'note.resize', address, length: 1 + Math.floor(random() * 4) };
    case 5:
      return { kind: 'group.detach', address };
    case 6:
      return { kind: 'detail.set', address, key: pick(['vel', 'gate', 'nudge'] as const), value: 0.5 };
    case 7:
      return { kind: 'row.add', row: pick(ROWS) };
    default:
      return { kind: 'phrase.transpose', steps: random() < 0.5 ? 1 : -1 };
  }
}

describe('invariant 1 — the text and the model agree', () => {
  it('holds over generated documents and operation sequences', () => {
    const random = rng(0x17ac71);
    let applied = 0;
    let refused = 0;

    for (let d = 0; d < 60; d++) {
      let doc = generateDoc(random);
      for (let step = 0; step < 6; step++) {
        const loaded = loadPhrase(doc, 'p');
        if (!loaded) break;
        const op = generateOp(random, loaded.phrase);
        const model = applyModel(loaded.phrase, op);
        const text = applyText(doc, 'p', op);

        // An operation the model refuses must not touch the document either.
        expect(text.ok).toBe(model.ok);
        if (!model.ok || !text.ok) {
          refused++;
          continue;
        }
        const after = loadPhrase(text.doc, 'p');
        expect(after, `document stopped parsing after ${op.kind}`).not.toBeNull();
        expect(formatPhrase((after as { phrase: Phrase }).phrase)).toBe(formatPhrase(model.phrase));
        doc = text.doc;
        applied++;
      }
    }
    expect(applied).toBeGreaterThan(100);
    expect(refused).toBeGreaterThan(10);
  });
});

describe('parse → format → parse', () => {
  it('round-trips the fence in §2 without drift', () => {
    const first = parsePhrase(BODY, { id: 'p', key: 'C', scale: 'minor' }).phrase as Phrase;
    const second = parsePhrase(formatPhrase(first), { id: 'p', key: 'C', scale: 'minor' }).phrase as Phrase;
    expect(formatPhrase(second)).toBe(formatPhrase(first));
  });
});
