// The `sheliak` command line interface.
//
// Usage:
//   sheliak new <file.md> [--empty]
//   sheliak check <file.md>... [--strict] [--format text|json]
//
// It is a Node program rather than a second binary beside the DSP core on
// purpose: the notation is parsed in TypeScript (`web/src/dsl/`), and the first
// rule of this repository is that the Rust side does not know the DSL. A Rust
// CLI would have to parse the notation a second time, which is one more copy of
// the contract to keep in step — the mistake `params.rs` / `params.ts` already
// costs enough to avoid repeating.

import { check, failed, formatJson, formatText, type CheckOptions } from './check.ts';
import { create } from './scaffold.ts';
import { version } from '../../package.json';

type Format = 'text' | 'json';

export interface Outcome {
  /** Written to stdout. */
  out: string;
  /** Written to stderr. */
  err: string;
  code: number;
}

export function run(argv: string[]): Outcome {
  switch (argv[0]) {
    case 'new':
      return cmdNew(argv.slice(1));
    case 'check':
      return cmdCheck(argv.slice(1));
    case '--version':
    case '-V':
      return { out: `sheliak ${version}`, err: '', code: 0 };
    // Asking for help is not an error: it goes to stdout and succeeds.
    case '--help':
    case '-h':
    case 'help':
      return { out: helpText(), err: '', code: 0 };
    case undefined:
      return usage('');
    default:
      return usage(unknownCommand(argv[0]));
  }
}

function cmdNew(args: string[]): Outcome {
  let path: string | undefined;
  let empty = false;
  for (const arg of args) {
    if (arg === '--empty') empty = true;
    else if (path === undefined && !arg.startsWith('-')) path = arg;
    else return usage(`unknown argument: ${arg}`);
  }
  if (path === undefined) return usage('a file to create is required');

  try {
    create(path, empty);
  } catch (e) {
    return { out: '', err: `error: ${e instanceof Error ? e.message : String(e)}`, code: 1 };
  }
  const next = empty ? '' : `\nPlay it: cd web && npm run dev — or check it: sheliak check ${path}`;
  return { out: `wrote ${path}${next}`, err: '', code: 0 };
}

function cmdCheck(args: string[]): Outcome {
  const paths: string[] = [];
  const opts: CheckOptions = { strict: false };
  let format: Format = 'text';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--strict') {
      opts.strict = true;
    } else if (arg === '--format') {
      i++;
      const value = args[i];
      if (value !== 'text' && value !== 'json') return usage('--format takes text or json');
      format = value;
    } else if (!arg.startsWith('-')) {
      paths.push(arg);
    } else {
      return usage(`unknown argument: ${arg}`);
    }
  }
  if (paths.length === 0) return usage('a file to check is required');

  const report = check(paths);
  const out = format === 'json' ? formatJson(report) : formatText(report);
  return { out, err: '', code: failed(report, opts) ? 1 : 0 };
}

/**
 * Message for an unrecognised subcommand, with a suggestion when one is close.
 * `sheliak lint` instead of `sheliak check` should read as "that is not the
 * name", not as "your file is wrong".
 */
function unknownCommand(given: string): string {
  const commands = ['new', 'check', 'help'];
  const close = commands
    .map((c) => ({ d: editDistance(given, c), c }))
    .filter((x) => x.d <= 2)
    .sort((a, b) => a.d - b.d)[0];
  return close ? `unknown command \`${given}\` — did you mean \`${close.c}\`?` : `unknown command \`${given}\``;
}

/** Levenshtein distance, over code points so non-ASCII input cannot misbehave. */
function editDistance(a: string, b: string): number {
  const bc = [...b];
  let prev = bc.map((_, i) => i + 1);
  prev.unshift(0);
  for (const [i, ca] of [...a].entries()) {
    const curr = [i + 1];
    for (const [j, cb] of bc.entries()) {
      curr.push(Math.min(prev[j] + (ca === cb ? 0 : 1), prev[j + 1] + 1, curr[j] + 1));
    }
    prev = curr;
  }
  return prev[bc.length];
}

function usage(msg: string): Outcome {
  return { out: '', err: `${msg ? `error: ${msg}\n\n` : ''}${helpText()}`, code: 1 };
}

export function helpText(): string {
  return `sheliak ${version} — the CLI for Markdown songs

Usage:
  sheliak new <file.md> [--empty]
  sheliak check <file.md>... [--strict] [--format text|json]

  new     write the smallest song that makes a sound — one synth fence, one
          phrase and the loop that binds them — or, with --empty, a blank file
          to type into. An existing file is never overwritten
  check   compile each file the way the browser does and report every syntax
          error by line and column, plus what compiling cannot call an error:
          a track with no loop line and a phrase nothing binds, both of which
          are silent. Exits non-zero on any error, so a song can be gated in
          CI — the reading a repository of text songs should get for free

  --strict  also exit non-zero on the warnings, for a project that wants no
            unbound track to reach main
  --format  json emits the same run as records, for a caller that is going to
            act on them rather than read them`;
}
