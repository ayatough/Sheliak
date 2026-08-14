// Whole-document formatting. The single property that matters is that nothing
// outside a `phrase` fence moves — the file is a person's song, not the
// formatter's output, and a formatter that reflows prose will not be run twice.

import { describe, it, expect } from 'vitest';
import { formatDocument } from './formatDoc.ts';

const F = '```';

const RAGGED = [
  '# A song',
  '',
  'Some prose   with   deliberate    spacing, and a `code span`.',
  '',
  `${F}synth id=lead seed=1`,
  'osc:',
  '  - { table: basic/saw,   level: -6dB }   # a comment, aligned by hand',
  F,
  '',
  `${F}phrase id=hook res=1/8 bars=1`,
  'grid:',
  '  5 |o-o.....|',
  '  1 |o-....o-|',
  F,
  '',
  'Closing prose.',
  '',
].join('\n');

describe('formatDocument', () => {
  it('writes the beat ruler the document did not have', () => {
    const out = formatDocument(RAGGED);
    expect(out.errors).toEqual([]);
    expect(out.changed).toBe(true);
    expect(out.formatted).toBe(1);
    expect(out.text).toContain('  #   1.2.3.4.');
  });

  it('leaves prose, synth fences and comments byte-for-byte alone', () => {
    const out = formatDocument(RAGGED);
    expect(out.text).toContain('Some prose   with   deliberate    spacing, and a `code span`.');
    expect(out.text).toContain('  - { table: basic/saw,   level: -6dB }   # a comment, aligned by hand');
    expect(out.text).toContain('Closing prose.');
    expect(out.text.endsWith('Closing prose.\n')).toBe(true);
  });

  it('is idempotent', () => {
    // The property the GUI depends on: one structure, exactly one spelling.
    const once = formatDocument(RAGGED).text;
    const twice = formatDocument(once);
    expect(twice.text).toBe(once);
    expect(twice.changed).toBe(false);
  });

  it('reports a document that is already canonical as unchanged', () => {
    const canonical = formatDocument(RAGGED).text;
    expect(formatDocument(canonical).changed).toBe(false);
  });

  it('formats every phrase, and the line numbers of later ones survive', () => {
    // Applied last-first for exactly this reason: the first fence grows by a
    // ruler line, which would otherwise put the second edit one line out.
    const two = RAGGED.replace(
      `${F}phrase id=hook res=1/8 bars=1`,
      `${F}phrase id=intro res=1/8 bars=1\ngrid:\n  1 |o-......|\n${F}\n\n${F}phrase id=hook res=1/8 bars=1`,
    );
    const out = formatDocument(two);
    expect(out.errors).toEqual([]);
    expect(out.formatted).toBe(2);
    expect(formatDocument(out.text).changed).toBe(false);
  });

  it('touches nothing at all when a phrase does not parse', () => {
    const broken = RAGGED.replace('  5 |o-o.....|', '  5 |o-o....|');
    const out = formatDocument(broken);
    expect(out.text).toBe(broken);
    expect(out.changed).toBe(false);
    expect(out.formatted).toBe(0);
    expect(out.errors[0]!.message).toMatch(/7 cells, expected 8/);
  });

  it('keeps a fence indented where its author left it', () => {
    const nested = ['- a list item:', '', `  ${F}phrase id=hook res=1/8 bars=1`, '  grid:', '    1 |o-......|', `  ${F}`, ''].join('\n');
    const out = formatDocument(nested);
    expect(out.errors).toEqual([]);
    for (const line of out.text.split('\n')) {
      if (line.includes('|') || line.trim() === 'grid:') expect(line.startsWith('  ')).toBe(true);
    }
    expect(formatDocument(out.text).changed).toBe(false);
  });

  it('keeps CRLF endings', () => {
    const crlf = RAGGED.replace(/\n/g, '\r\n');
    const out = formatDocument(crlf);
    expect(out.text.includes('\r\n')).toBe(true);
    expect(out.text.split('\n').every((l) => l === '' || l.endsWith('\r') || !out.text.includes('\r\n'))).toBe(true);
  });

  it('does nothing to a document with no phrase fence', () => {
    const noPhrase = `# just prose\n\n${F}synth id=lead\nosc: []\n${F}\n`;
    expect(formatDocument(noPhrase)).toMatchObject({ text: noPhrase, changed: false, formatted: 0 });
  });
});
