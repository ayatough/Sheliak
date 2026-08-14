// `sheliak new` — the first file.
//
// `check` starts from a document that already exists, which leaves nothing for
// someone with an empty directory. The smallest song that makes a sound is
// three fences that have to agree with each other by id, and working out which
// fields are required and which have defaults — by reading the syntax reference
// before hearing anything at all — is exactly the part a starter file answers.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const F = '```';

/**
 * The song `sheliak new` writes: one `synth` fence, one `phrase`, one `loop`.
 *
 * This is the minimum that makes a sound — a track, notes for it, and an
 * arrangement binding the two by id — and deliberately not a tour of the
 * notation. Every field here is one the author either keeps or deletes on
 * sight; everything omitted is taking its documented default, which is the
 * useful thing to learn from a first file. `web/src/defaultDoc.ts` is the
 * four-track version, and docs/syntax.md is the reference.
 */
export const TEMPLATE = `# My song

Rows are pitches, columns are time. \`sheliak check\` reads this file;
<https://ayatough.github.io/Sheliak/> plays it.

${F}synth id=lead seed=1
osc:
  - { table: basic/saw, level: -6dB }

filter: { type: lp12, cutoff: 1200Hz, res: 0.2 }

env:
  amp: { a: 5ms, d: 200ms, s: 60%, r: 150ms }
${F}

${F}phrase id=hook key=C scale=minor res=1/8 bars=1
grid:
  #    1.2.3.4.
  5   |o-o.....|
  b3  |....o-o.|
  1   |o-....o-|
${F}

${F}loop id=song bars=1 bpm=120
lead: hook
${F}
`;

/**
 * Writes a new song at `path`, refusing to touch a file that is already there.
 *
 * `empty` writes nothing at all: starting from a blank document is a legitimate
 * way in, and it is the one that `check` on a non-existent path cannot express.
 */
export function create(path: string, empty: boolean): void {
  // `sheliak new songs/2026/demo.md` should not fail on the directories.
  const parent = dirname(path);
  if (parent && parent !== '.') {
    try {
      mkdirSync(parent, { recursive: true });
    } catch (e) {
      throw new Error(`cannot create ${parent}: ${message(e)}`);
    }
  }

  // Flag `wx` rather than "does it exist?" then write: the check and the write
  // have to be one step, or a song can be overwritten between them.
  try {
    writeFileSync(path, empty ? '' : TEMPLATE, { flag: 'wx' });
  } catch (e) {
    if (isErrno(e) && e.code === 'EEXIST') {
      throw new Error(`${path} already exists — \`sheliak new\` never overwrites a song`);
    }
    throw new Error(`cannot create ${path}: ${message(e)}`);
  }
}

function isErrno(e: unknown): e is NodeJS.ErrnoException {
  return e instanceof Error && 'code' in e;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
