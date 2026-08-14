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

import { basename } from 'node:path';
import { readFileSync } from 'node:fs';
import { check, failed, formatJson, formatText, type CheckOptions } from './check.ts';
import { create } from './scaffold.ts';
import { describeRender, render, type RenderOptions } from './render.ts';
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
    case 'render':
      return cmdRender(argv.slice(1));
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
  // Not `npm run dev`: whoever ran this may have no clone to run it in.
  const next = empty
    ? ''
    : `\nCheck it: sheliak check ${path}\nHear it:  paste it into https://ayatough.github.io/Sheliak/`;
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

function cmdRender(args: string[]): Outcome {
  let input: string | undefined;
  let out: string | undefined;
  const opts: RenderOptions = { out: '', loops: 1, tailSeconds: 0, sampleRate: 48000 };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '-o':
      case '--out':
        out = args[++i];
        if (out === undefined) return usage('-o requires an output path');
        break;
      case '--loops': {
        const n = Number(args[++i]);
        if (!Number.isInteger(n) || n < 1) return usage('--loops requires a whole number of repeats, 1 or more');
        opts.loops = n;
        break;
      }
      case '--tail': {
        const seconds = parseDuration(args[++i]);
        if (seconds === undefined) return usage('--tail requires a duration with a unit, e.g. 2s or 500ms');
        opts.tailSeconds = seconds;
        break;
      }
      case '--sample-rate': {
        const n = Number(args[++i]);
        if (!Number.isFinite(n) || n <= 0) return usage('--sample-rate requires a rate in Hz, e.g. 44100');
        opts.sampleRate = n;
        break;
      }
      case '--wasm':
        opts.wasm = args[++i];
        if (opts.wasm === undefined) return usage('--wasm requires a path to dsp.wasm');
        break;
      default:
        if (input === undefined && !arg.startsWith('-')) input = arg;
        else return usage(`unknown argument: ${arg}`);
    }
  }
  if (input === undefined) return usage('a file to render is required');
  // Beside the caller, not beside the song: `render songs/a.md` writing into
  // `songs/` would be a surprise, and `-o` is right there for saying otherwise.
  opts.out = out ?? `${basename(input).replace(/\.md$/i, '')}.wav`;

  let source: string;
  try {
    source = readFileSync(input, 'utf8');
  } catch {
    return { out: '', err: `error: cannot read ${input}`, code: 1 };
  }
  try {
    return { out: describeRender(render(source, opts)), err: '', code: 0 };
  } catch (e) {
    return { out: '', err: `error: ${e instanceof Error ? e.message : String(e)}`, code: 1 };
  }
}

/**
 * `2s`, `500ms`. A bare number is rejected here for the same reason it is
 * rejected in the notation: seconds and milliseconds are three orders of
 * magnitude apart and look identical without a unit.
 */
export function parseDuration(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const m = /^(\d+(?:\.\d+)?)(ms|s)$/.exec(text.trim());
  if (!m) return undefined;
  const value = Number(m[1]);
  return m[2] === 'ms' ? value / 1000 : value;
}

/**
 * Message for an unrecognised subcommand, with a suggestion when one is close.
 * `sheliak lint` instead of `sheliak check` should read as "that is not the
 * name", not as "your file is wrong".
 */
function unknownCommand(given: string): string {
  const commands = ['new', 'check', 'render', 'help'];
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
  sheliak render <file.md> [-o <out.wav>] [--loops <n>] [--tail <2s>]
                 [--sample-rate <hz>] [--wasm <dsp.wasm>]

  new     write the smallest song that makes a sound — one synth fence, one
          phrase and the loop that binds them — or, with --empty, a blank file
          to type into. An existing file is never overwritten
  check   compile each file the way the browser does and report every syntax
          error by line and column, plus what compiling cannot call an error:
          a track with no loop line and a phrase nothing binds, both of which
          are silent. Exits non-zero on any error, so a song can be gated in
          CI — the reading a repository of text songs should get for free
  render  render the loop to a 16-bit WAV with the same wasm and the same
          sample-accurate scheduling the browser uses, so the file is what you
          heard. Refuses a document that does not compile rather than writing
          one with a track missing from it. Needs the DSP core built
          (./scripts/build-wasm.sh)

  --strict       also exit non-zero on the warnings, for a project that wants
                 no unbound track to reach main
  --format       json emits the same run as records, for a caller that is
                 going to act on them rather than read them
  --loops        how many times the loop repeats (default 1)
  --tail         decay rendered after the last note is released, e.g. 2s. The
                 default is none, so one loop is exactly loop-length and still
                 loops seamlessly; a reverb that should ring out wants this
  --sample-rate  default 48000. Musical time resolves against it, so a render
                 at another rate is a different set of sample offsets`;
}
