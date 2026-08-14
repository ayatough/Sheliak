// The starter song is a promise the notation has to keep: someone runs
// `sheliak new`, plays it, and hears something. Every one of these guards a way
// that promise can rot without anybody noticing.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { create, TEMPLATE } from './scaffold.ts';
import { checkFile } from './check.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sheliak-scaffold-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the starter song', () => {
  it('compiles with no errors and no warnings', () => {
    const path = join(dir, 'song.md');
    create(path, false);
    const report = checkFile(path);
    // Named rather than counted: a failure should say which line is wrong.
    expect(report.findings).toEqual([]);
  });

  it('declares one track, one phrase and a loop that binds them', () => {
    const path = join(dir, 'song.md');
    create(path, false);
    expect(checkFile(path).summary).toMatchObject({
      tracks: 1,
      trackCount: 1,
      phrases: 1,
      loop: true,
      bars: 1,
    });
  });

  it('stays short enough to read in one screen', () => {
    // Not style policing: a first file long enough to skim past is one whose
    // fields get copied without being understood, which is the failure this
    // template exists to prevent.
    expect(TEMPLATE.split('\n').length).toBeLessThan(30);
  });
});

describe('create', () => {
  it('writes the template', () => {
    const path = join(dir, 'song.md');
    create(path, false);
    expect(readFileSync(path, 'utf8')).toBe(TEMPLATE);
  });

  it('writes nothing with --empty', () => {
    const path = join(dir, 'blank.md');
    create(path, true);
    expect(readFileSync(path, 'utf8')).toBe('');
  });

  it('creates missing parent directories', () => {
    const path = join(dir, 'songs', '2026', 'demo.md');
    create(path, false);
    expect(readFileSync(path, 'utf8')).toBe(TEMPLATE);
  });

  it('refuses to overwrite an existing file', () => {
    const path = join(dir, 'song.md');
    writeFileSync(path, 'a song someone is working on');
    expect(() => create(path, false)).toThrow(/already exists/);
    expect(readFileSync(path, 'utf8')).toBe('a song someone is working on');
  });
});
