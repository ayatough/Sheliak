import { describe, it, expect } from 'vitest';
import { parseYamlite, isMap, isSeq, isScalar, type YMap, type YNode } from './yamlite.ts';

function entry(map: YMap, key: string): YNode {
  const e = map.entries.find((x) => x.key === key);
  if (!e) throw new Error(`no entry "${key}"`);
  return e.value;
}

function scalarOf(node: YNode, key: string): { value: string; line: number; col: number } {
  if (!isMap(node)) throw new Error('not a map');
  const v = entry(node, key);
  if (!isScalar(v)) throw new Error(`entry "${key}" is not a scalar`);
  return { value: v.value, line: v.line, col: v.col };
}

describe('parseYamlite', () => {
  it('parses top-level maps with flow values', () => {
    const { root, errors } = parseYamlite('filter: { type: lp12, cutoff: 800Hz, res: 0.3 }');
    expect(errors).toEqual([]);
    const filter = entry(root!, 'filter');
    expect(isMap(filter)).toBe(true);
    expect(scalarOf(filter, 'type').value).toBe('lp12');
    expect(scalarOf(filter, 'cutoff').value).toBe('800Hz');
    expect(scalarOf(filter, 'res').value).toBe('0.3');
  });

  it('parses block lists of flow maps', () => {
    const src = ['osc:', '  - { table: basic/saw, level: 0dB }', '  - { table: basic/square }'].join('\n');
    const { root, errors } = parseYamlite(src);
    expect(errors).toEqual([]);
    const osc = entry(root!, 'osc');
    expect(isSeq(osc)).toBe(true);
    if (!isSeq(osc)) return;
    expect(osc.items).toHaveLength(2);
    expect(scalarOf(osc.items[0]!, 'table').value).toBe('basic/saw');
    expect(scalarOf(osc.items[1]!, 'table').value).toBe('basic/square');
  });

  it('parses one level of block nesting', () => {
    const src = ['env:', '  amp:    { a: 5ms, d: 200ms }', '  filter: { a: 2ms }'].join('\n');
    const { root, errors } = parseYamlite(src);
    expect(errors).toEqual([]);
    const env = entry(root!, 'env');
    expect(isMap(env)).toBe(true);
    expect(scalarOf(entry(env as YMap, 'amp'), 'a').value).toBe('5ms');
    expect(scalarOf(entry(env as YMap, 'filter'), 'a').value).toBe('2ms');
  });

  it('accepts numeric keys (lfo slots)', () => {
    const { root, errors } = parseYamlite(['lfo:', '  1: { wave: tri, rate: 1/4 }'].join('\n'));
    expect(errors).toEqual([]);
    const lfo = entry(root!, 'lfo');
    expect(scalarOf(entry(lfo as YMap, '1'), 'rate').value).toBe('1/4');
  });

  it('records the source position of every scalar', () => {
    // line 1: "filter: { type: lp12, cutoff: 800Hz }"
    //          1234567890123456789012345678901234
    const { root } = parseYamlite('filter: { type: lp12, cutoff: 800Hz }');
    const filter = entry(root!, 'filter');
    expect(scalarOf(filter, 'type')).toMatchObject({ line: 1, col: 17 });
    expect(scalarOf(filter, 'cutoff')).toMatchObject({ line: 1, col: 31 });
  });

  it('offsets line numbers by the fence body start', () => {
    const { root } = parseYamlite('filter: { type: lp12 }', 42);
    const filter = entry(root!, 'filter');
    expect(scalarOf(filter, 'type').line).toBe(42);
  });

  it('ignores comments and blank lines', () => {
    const src = ['# a comment', '', 'voice: { polyphony: 8 } # trailing', '', '# end'].join('\n');
    const { root, errors } = parseYamlite(src);
    expect(errors).toEqual([]);
    expect(root!.entries).toHaveLength(1);
    expect(scalarOf(entry(root!, 'voice'), 'polyphony').value).toBe('8');
  });

  it('parses flow sequences', () => {
    const { root, errors } = parseYamlite('notes: [ 1, 2, 3 ]');
    expect(errors).toEqual([]);
    const notes = entry(root!, 'notes');
    expect(isSeq(notes)).toBe(true);
    if (!isSeq(notes)) return;
    expect(notes.items.map((n) => (isScalar(n) ? n.value : ''))).toEqual(['1', '2', '3']);
  });

  it('reports unterminated flow maps with a position', () => {
    const { errors } = parseYamlite('filter: { type: lp12', 10);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.line).toBe(10);
    expect(errors[0]!.message).toMatch(/unterminated/);
  });

  it('reports lines that are not key: value', () => {
    const { errors } = parseYamlite(['osc:', '  - { table: basic/saw }', 'garbage'].join('\n'));
    expect(errors).toHaveLength(1);
    expect(errors[0]!.line).toBe(3);
    expect(errors[0]!.message).toMatch(/key/);
  });

  it('reports tabs used for indentation', () => {
    const { errors } = parseYamlite(['env:', '\tamp: { a: 5ms }'].join('\n'));
    expect(errors.some((e) => /tab/.test(e.message))).toBe(true);
  });
});
