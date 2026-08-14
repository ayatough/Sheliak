// Argument handling. `run` returns what it would have written and the code it
// would have exited with, so none of this needs a subprocess.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './main.ts';
import { TEMPLATE } from './scaffold.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sheliak-cli-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('new', () => {
  it('writes the file and succeeds', () => {
    const path = join(dir, 'song.md');
    const outcome = run(['new', path]);
    expect(outcome.code).toBe(0);
    expect(readFileSync(path, 'utf8')).toBe(TEMPLATE);
  });

  it('takes --empty in either order', () => {
    const path = join(dir, 'blank.md');
    expect(run(['new', '--empty', path]).code).toBe(0);
    expect(readFileSync(path, 'utf8')).toBe('');
  });

  it('fails with a message rather than a stack trace on an existing file', () => {
    const path = join(dir, 'song.md');
    run(['new', path]);
    const outcome = run(['new', path]);
    expect(outcome.code).toBe(1);
    expect(outcome.err).toContain('never overwrites');
  });

  it('needs a path', () => {
    expect(run(['new']).code).toBe(1);
    expect(run(['new']).err).toContain('a file to create is required');
  });
});

describe('check', () => {
  it('exits 0 on the file `new` just wrote', () => {
    const path = join(dir, 'song.md');
    run(['new', path]);
    expect(run(['check', path]).code).toBe(0);
  });

  it('writes JSON to stdout and nothing else', () => {
    const path = join(dir, 'song.md');
    run(['new', path]);
    const outcome = run(['check', path, '--format', 'json']);
    expect(outcome.err).toBe('');
    expect(() => JSON.parse(outcome.out)).not.toThrow();
  });

  it('rejects an unknown --format', () => {
    expect(run(['check', 'x.md', '--format', 'yaml']).code).toBe(1);
  });

  it('needs a path', () => {
    expect(run(['check']).err).toContain('a file to check is required');
  });
});

describe('the rest of the surface', () => {
  it('answers --help on stdout, successfully', () => {
    const outcome = run(['--help']);
    expect(outcome.code).toBe(0);
    expect(outcome.out).toContain('sheliak new');
  });

  it('answers --version', () => {
    expect(run(['--version']).out).toMatch(/^sheliak \d+\.\d+\.\d+$/);
  });

  it('suggests the command that was meant', () => {
    expect(run(['chek', 'x.md']).err).toContain('did you mean `check`');
  });

  it('does not guess when nothing is close', () => {
    const err = run(['transmogrify']).err;
    expect(err).toContain('unknown command `transmogrify`');
    expect(err).not.toContain('did you mean');
  });

  it('prints usage when given nothing', () => {
    expect(run([]).code).toBe(1);
  });
});
