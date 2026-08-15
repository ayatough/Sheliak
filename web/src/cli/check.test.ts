// `sheliak check`: the errors are the compiler's, so what is tested here is the
// reporting — that a syntax error fails the run, that the two silent-song
// warnings fire and do not, on their own, fail it, and that the JSON contract
// holds its shape.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, checkFile, failed, formatJson, formatText, SCHEMA_VERSION } from './check.ts';

const F = '```';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sheliak-check-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Writes `body` to a file in the temp dir and returns its path. */
function file(body: string, name = 'song.md'): string {
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
}

const LEAD = `${F}synth id=lead seed=1
osc:
  - { table: basic/saw, level: -6dB }
${F}`;

const HOOK = `${F}phrase id=hook res=1/8 bars=1
grid:
  1  |o-......|
${F}`;

const SONG = `${LEAD}\n\n${HOOK}\n\n${F}loop id=song bars=1 bpm=120\nlead: hook\n${F}`;

describe('errors', () => {
  it('reports a bare number by line and column, and fails the run', () => {
    const path = file(SONG.replace('level: -6dB', 'level: -6'));
    const report = check([path]);
    expect(report.errors).toBe(1);
    expect(report.files[0].ok).toBe(false);
    expect(report.files[0].findings[0]).toMatchObject({ severity: 'error', line: 3 });
    expect(failed(report, { strict: false })).toBe(true);
  });

  it('passes a document with nothing wrong with it', () => {
    const report = check([file(SONG)]);
    expect(report.files[0].findings).toEqual([]);
    expect(failed(report, { strict: true })).toBe(false);
  });

  it('reports an unreadable file rather than throwing', () => {
    const report = checkFile(join(dir, 'absent.md'));
    expect(report.ok).toBe(false);
    expect(report.summary).toBeUndefined();
    expect(report.findings[0].message).toContain('no such file');
  });

  it('checks several files in one run', () => {
    const report = check([file(SONG, 'a.md'), file(SONG.replace('level: -6dB', 'level: -6'), 'b.md')]);
    expect(report.files).toHaveLength(2);
    expect(report.errors).toBe(1);
  });
});

describe('what compiling cannot call an error', () => {
  it('warns about a track no loop line binds', () => {
    const pad = `${F}synth id=pad seed=2\nosc:\n  - { table: basic/sine, level: -9dB }\n${F}`;
    const report = check([file(`${SONG}\n\n${pad}`)]);
    expect(report.errors).toBe(0);
    expect(report.warnings).toBe(1);
    expect(report.files[0].findings[0].message).toContain('track `pad`');
    // A warning alone is a legitimate work-in-progress, and does not fail.
    expect(failed(report, { strict: false })).toBe(false);
    expect(failed(report, { strict: true })).toBe(true);
  });

  it('warns about a phrase nothing plays', () => {
    const spare = `${F}phrase id=spare res=1/8 bars=1\ngrid:\n  1  |o-......|\n${F}`;
    const report = check([file(`${SONG}\n\n${spare}`)]);
    expect(report.warnings).toBe(1);
    expect(report.files[0].findings[0].message).toContain('phrase `spare`');
  });

  it('warns when there is no loop fence at all', () => {
    const report = check([file(`${LEAD}\n\n${HOOK}`)]);
    expect(report.files[0].findings.map((f) => f.message)).toEqual([
      expect.stringContaining('no `loop` fence'),
    ]);
  });

  it('warns when the document declares no track at all', () => {
    // "no `synth` or `plugin` fence": a plugin fence is a track too, so a
    // document with one is not trackless.
    const report = check([file(HOOK)]);
    expect(
      report.files[0].findings.some((f) => f.message.includes('no `synth` or `plugin` fence')),
    ).toBe(true);
  });

  it('stays quiet about bindings when the loop itself failed', () => {
    // Otherwise one broken loop line reports every phrase in the document as
    // unused, and the error that caused it is lost in the noise.
    const report = check([file(SONG.replace('lead: hook', 'lead: absent'))]);
    expect(report.errors).toBeGreaterThan(0);
    expect(report.warnings).toBe(0);
  });
});

describe('output', () => {
  it('lists findings in document order, warnings interleaved', () => {
    const pad = `${F}synth id=pad seed=2\nosc:\n  - { table: basic/sine, level: -9 }\n${F}`;
    const report = check([file(`${pad}\n\n${SONG}`)]);
    const lines = report.files[0].findings.map((f) => f.line);
    expect(lines).toEqual([...lines].sort((a, b) => a - b));
  });

  it('names the file and position on every finding', () => {
    const path = file(SONG.replace('level: -6dB', 'level: -6'));
    expect(formatText(check([path]))).toContain(`${path}:3:`);
  });

  it('says so plainly when nothing is wrong', () => {
    expect(formatText(check([file(SONG)]))).toContain('no problems');
  });

  it('emits one JSON document carrying the schema version', () => {
    const parsed = JSON.parse(formatJson(check([file(SONG)])));
    expect(parsed.schemaVersion).toBe(SCHEMA_VERSION);
    expect(parsed.files[0].summary).toMatchObject({ tracks: 1, phrases: 1, loop: true, bpm: 120 });
  });
});
