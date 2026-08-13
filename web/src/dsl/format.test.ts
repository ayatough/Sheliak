// A2: grid canonicalization. One structure has exactly one spelling, and
// `format(format(x)) == format(x)` (docs/workstreams.md §8, invariant 2).

import { describe, it, expect } from 'vitest';
import { canonicalizePhrase, formatPhrase, formatPhraseAttrs } from './format.ts';
import { parsePhrase, type Phrase } from './phrase.ts';

const ATTRS = { id: 'p', key: 'C', scale: 'minor', res: '1/16', bars: '1' };

function canon(body: string, attrs: Record<string, string> = ATTRS): string {
  const r = canonicalizePhrase(body, attrs);
  expect(r.errors).toEqual([]);
  return r.text as string;
}

describe('canonical grid', () => {
  it('reproduces the fence in §2 byte for byte', () => {
    const source = [
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
    expect(canon(source)).toBe(source);
  });

  it('sorts rows highest resolved pitch first', () => {
    const out = canon(['grid:', '  1   |o---............|', "  5'  |o---............|"].join('\n'));
    expect(out.split('\n')[2]).toContain("5'");
    expect(out.split('\n')[3]).toContain('1 ');
  });

  it('keeps percussion rows in the order they were written', () => {
    const out = canon(['grid:', '  hh   |o...............|', '  kick |o...............|'].join('\n'));
    expect(out.split('\n').slice(2, 4).map((l) => l.trim().split(' ')[0])).toEqual(['hh', 'kick']);
  });

  it('collapses a single group at an onset to `o` and renumbers the rest', () => {
    const out = canon(
      ['grid:', "  5'  |c---............|", "  b3' |c---q...........|", '  1   |c---z...........|'].join('\n'),
    );
    const rows = out.split('\n').slice(2, 5);
    expect(rows[0]).toContain('|o---');
    expect(rows[1]).toContain('|o---a'); // second onset splits into two groups
    expect(rows[2]).toContain('|o---b');
  });

  it('re-aligns labels and regenerates the ruler', () => {
    // Rows have to be aligned to parse at all; the gap and the ruler do not.
    const out = canon(['grid:', '  # ruler', '     b7,,      |o---............|', '     1         |o---............|'].join('\n'));
    expect(out.split('\n')[1]).toBe('  #      1...2...3...4...');
    expect(out.split('\n')[2]).toBe('  1     |o---............|');
    expect(out.split('\n')[3]).toBe('  b7,,  |o---............|');
  });

  it('draws bar lines between bars and numbers the ruler per bar', () => {
    const out = canon(['grid:', '  1 |o-o-o-o-o-o-o-o-|'].join('\n'), { ...ATTRS, bars: '2', res: '1/8' });
    expect(out.split('\n')[1]).toBe('  #   1.2.3.4. 1.2.3.4.');
    expect(out.split('\n')[2]).toBe('  1  |o-o-o-o-|o-o-o-o-|');
  });

  it('rewrites a group tag the canonicalization moved', () => {
    const out = canon(
      [
        'grid:',
        "  5' |z---............|",
        '  1  |y---............|',
        '',
        'detail:',
        '  1.1z : { roll: +5ms }',
      ].join('\n'),
    );
    expect(out).toContain('1.1a : { roll: +5ms }');
  });

  it('canonicalizes gesture spelling and key order', () => {
    const out = canon(
      [
        'grid:',
        '  1 |o---o-----------|',
        '',
        'detail:',
        '  1.1 : { gate: 50%, vel: 90.0%, nudge: -0.012s }',
        '  1.2 : { gliss: { curve: linear, cells: 2, to: +5st } }',
      ].join('\n'),
    );
    expect(out).toContain('1.1 : { vel: 90%, nudge: -12ms, gate: 50% }');
    expect(out).toContain('1.2 : { gliss: { to: +5st, cells: 2 } }');
  });

  it('writes the attributes back without the defaults', () => {
    const phrase = parsePhrase('grid:\n  1 |o---............|', ATTRS).phrase as Phrase;
    expect(formatPhraseAttrs(phrase)).toBe('id=p scale=minor');
  });
});

// ---------------------------------------------------------- property testing

/** Deterministic PRNG — nothing in this repository may read a clock. */
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

const DEGREES = ['1', '2', 'b3', '3', '4', '5', 'b7', "1'", "5'", '1,'];
const TAGS = 'abcdopqz';

/** A random but well-formed phrase fence body. */
function generate(random: () => number): { body: string; attrs: Record<string, string> } {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;
  const cellsPerBeat = pick([1, 2, 4] as const);
  const bars = pick([1, 2] as const);
  const total = bars * 4 * cellsPerBeat;

  const rowCount = 1 + Math.floor(random() * 3);
  const labels: string[] = [];
  while (labels.length < rowCount) {
    const label = pick(DEGREES);
    if (!labels.includes(label)) labels.push(label);
  }

  const grid = labels.map(() => new Array<string>(total).fill('.'));
  const notes: { row: number; onset: number; tag: string }[] = [];
  for (let r = 0; r < rowCount; r++) {
    const row = grid[r] as string[];
    let i = 0;
    while (i < total) {
      if (random() < 0.45) {
        const length = 1 + Math.floor(random() * 4);
        const tag = pick([...TAGS]);
        row[i] = tag;
        notes.push({ row: r, onset: i, tag });
        for (let k = 1; k < length && i + k < total; k++) row[i + k] = '-';
        i += length;
      } else {
        i++;
      }
    }
  }

  const width = Math.max(...labels.map((l) => l.length));
  const lines = ['grid:'];
  // Deliberately non-canonical spacing: the formatter has to fix it.
  labels.forEach((label, r) => lines.push(`   ${label.padEnd(width)} |${(grid[r] as string[]).join('')}|`));

  if (notes.length > 0 && random() < 0.7) {
    lines.push('', 'detail:');
    const count = 1 + Math.floor(random() * 3);
    for (let i = 0; i < count; i++) {
      const note = pick(notes);
      const beatIndex = Math.floor(note.onset / cellsPerBeat);
      const bar = Math.floor(beatIndex / 4) + 1;
      const beat = (beatIndex % 4) + 1;
      const address = pick([
        `${bar}`,
        `${bar}.${beat}`,
        `${bar}.${beat}${note.tag}`,
        `${bar}.${beat}:${labels[note.row] as string}`,
        '*',
      ]);
      const gesture = pick([
        '{ vel: 80% }',
        '{ nudge: +7ms }',
        '{ gate: 60% }',
        '{ vel: 55%, gate: 120% }',
        '{ gliss: { to: +2st, cells: 2 } }',
      ]);
      lines.push(`  ${address}: ${gesture}`);
    }
  }

  return {
    body: lines.join('\n'),
    attrs: { id: 'gen', key: 'C', scale: 'minor', res: `1/${cellsPerBeat * 4}`, bars: String(bars) },
  };
}

describe('invariant 2 — canonical form is idempotent', () => {
  it('holds over 300 generated phrases', () => {
    const random = rng(0x5e11ac);
    let checked = 0;
    for (let i = 0; i < 300; i++) {
      const { body, attrs } = generate(random);
      const once = canonicalizePhrase(body, attrs);
      // A generated phrase can still be rejected (an address that matches no
      // note, say); those are not interesting here.
      if (!once.text) continue;
      const twice = canonicalizePhrase(once.text, attrs);
      expect(twice.errors).toEqual([]);
      expect(twice.text).toBe(once.text);
      checked++;
    }
    expect(checked).toBeGreaterThan(150);
  });

  it('a formatted phrase parses back to the same structure', () => {
    const random = rng(0xc0ffee);
    for (let i = 0; i < 100; i++) {
      const { body, attrs } = generate(random);
      const first = parsePhrase(body, attrs);
      if (!first.phrase) continue;
      const text = formatPhrase(first.phrase);
      const second = parsePhrase(text, attrs);
      expect(second.errors).toEqual([]);
      const shape = (p: Phrase) =>
        p.notes.map((n) => [p.rows[n.row]!.midi, n.onset, n.length].join('/')).sort();
      expect(shape(second.phrase as Phrase)).toEqual(shape(first.phrase));
    }
  });
});
