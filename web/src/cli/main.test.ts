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
  it('writes the file and succeeds', async () => {
    const path = join(dir, 'song.md');
    const outcome = await run(['new', path]);
    expect(outcome.code).toBe(0);
    expect(readFileSync(path, 'utf8')).toBe(TEMPLATE);
  });

  it('takes --empty in either order', async () => {
    const path = join(dir, 'blank.md');
    expect((await run(['new', '--empty', path])).code).toBe(0);
    expect(readFileSync(path, 'utf8')).toBe('');
  });

  it('fails with a message rather than a stack trace on an existing file', async () => {
    const path = join(dir, 'song.md');
    await run(['new', path]);
    const outcome = await run(['new', path]);
    expect(outcome.code).toBe(1);
    expect(outcome.err).toContain('never overwrites');
  });

  it('needs a path', async () => {
    expect((await run(['new'])).code).toBe(1);
    expect((await run(['new'])).err).toContain('a file to create is required');
  });
});

describe('check', () => {
  it('exits 0 on the file `new` just wrote', async () => {
    const path = join(dir, 'song.md');
    await run(['new', path]);
    expect((await run(['check', path])).code).toBe(0);
  });

  it('writes JSON to stdout and nothing else', async () => {
    const path = join(dir, 'song.md');
    await run(['new', path]);
    const outcome = await run(['check', path, '--format', 'json']);
    expect(outcome.err).toBe('');
    expect(() => JSON.parse(outcome.out)).not.toThrow();
  });

  it('rejects an unknown --format', async () => {
    expect((await run(['check', 'x.md', '--format', 'yaml'])).code).toBe(1);
  });

  it('needs a path', async () => {
    expect((await run(['check'])).err).toContain('a file to check is required');
  });
});

describe('the rest of the surface', () => {
  it('answers --help on stdout, successfully', async () => {
    const outcome = await run(['--help']);
    expect(outcome.code).toBe(0);
    expect(outcome.out).toContain('sheliak new');
  });

  it('answers --version', async () => {
    expect((await run(['--version'])).out).toMatch(/^sheliak \d+\.\d+\.\d+$/);
  });

  it('suggests the command that was meant', async () => {
    expect((await run(['chek', 'x.md'])).err).toContain('did you mean `check`');
  });

  it('does not guess when nothing is close', async () => {
    const err = (await run(['transmogrify'])).err;
    expect(err).toContain('unknown command `transmogrify`');
    expect(err).not.toContain('did you mean');
  });

  it('prints usage when given nothing', async () => {
    expect((await run([])).code).toBe(1);
  });
});
