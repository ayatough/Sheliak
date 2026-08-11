import { describe, it, expect } from 'vitest';
import { extractFences, parseInfoAttrs, findFence } from './fences.ts';

const DOC = [
  '# title', // 1
  '', // 2
  'intro text', // 3
  '', // 4
  '```synth id=lead seed=42', // 5
  'osc:', // 6
  '  - { table: basic/saw }', // 7
  '```', // 8
  '', // 9
  'between', // 10
  '', // 11
  '```loop id=demo bars=2 bpm=124', // 12
  'lead: C3 . . .', // 13
  '```', // 14
].join('\n');

describe('extractFences', () => {
  it('finds fences with their info strings', () => {
    const fences = extractFences(DOC);
    expect(fences).toHaveLength(2);
    expect(fences[0]!.lang).toBe('synth');
    expect(fences[1]!.lang).toBe('loop');
  });

  it('tracks line offsets relative to the whole document', () => {
    const fences = extractFences(DOC);
    expect(fences[0]!.fenceLine).toBe(5);
    expect(fences[0]!.bodyStartLine).toBe(6);
    expect(fences[1]!.fenceLine).toBe(12);
    expect(fences[1]!.bodyStartLine).toBe(13);
  });

  it('captures the body without the fence lines', () => {
    const fences = extractFences(DOC);
    expect(fences[0]!.body).toBe('osc:\n  - { table: basic/saw }');
    expect(fences[1]!.body).toBe('lead: C3 . . .');
  });

  it('parses info string attributes', () => {
    const fences = extractFences(DOC);
    expect(fences[0]!.attrs).toEqual({ id: 'lead', seed: '42' });
    expect(fences[1]!.attrs).toEqual({ id: 'demo', bars: '2', bpm: '124' });
  });

  it('handles unterminated fences by running to the end', () => {
    const fences = extractFences('```synth\nosc:\n');
    expect(fences).toHaveLength(1);
    expect(fences[0]!.bodyStartLine).toBe(2);
    expect(fences[0]!.body).toBe('osc:\n');
  });

  it('handles longer fences and tildes', () => {
    const fences = extractFences('~~~~loop bars=1\nlead: C3 . . .\n~~~~\n');
    expect(fences).toHaveLength(1);
    expect(fences[0]!.lang).toBe('loop');
    expect(fences[0]!.body).toBe('lead: C3 . . .');
  });

  it('handles CRLF documents', () => {
    const fences = extractFences('a\r\n```synth\r\nosc:\r\n```\r\n');
    expect(fences[0]!.bodyStartLine).toBe(3);
    expect(fences[0]!.body).toBe('osc:');
  });

  it('findFence picks the first matching language', () => {
    const fences = extractFences(DOC);
    expect(findFence(fences, 'loop')!.attrs['bpm']).toBe('124');
    expect(findFence(fences, 'nope')).toBeUndefined();
  });
});

describe('parseInfoAttrs', () => {
  it('drops the language word and reads key=value pairs', () => {
    expect(parseInfoAttrs('synth id=lead seed=42')).toEqual({ id: 'lead', seed: '42' });
  });

  it('supports quoted values and bare flags', () => {
    expect(parseInfoAttrs('loop id="my demo" solo')).toEqual({ id: 'my demo', solo: 'true' });
  });
});
