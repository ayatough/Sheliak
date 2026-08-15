// `sheliak check` — read a song without opening a browser.
//
// The compiler already reports every syntax error by line and column; until now
// the only way to see one was to paste the document into the editor and look at
// the panel under it. That is a poor fit for the thing a song file is supposed
// to be — something you can put in a repository, review in a pull request, and
// gate in CI — so this runs the same `compile()` over a file and exits non-zero.
//
// It also reports what compiling cannot: a fence that parses perfectly and is
// never referenced. An unbound track and an unused phrase are both silent, and
// silence is the one failure the compiler has no way to call an error.

import { readFileSync } from 'node:fs';
import { compile, type CompileResult } from '../dsl/compile.ts';
import { sortErrors } from '../dsl/errors.ts';

/**
 * The version of the `--format json` contract. A field may be added without
 * moving it; this goes up only when one is renamed, removed, or given a
 * different meaning.
 */
export const SCHEMA_VERSION = 1;

/**
 * Musical time (`rate: 1/4`, delay `time: 3/16`) is resolved to samples at
 * compile time, so `compile` needs a rate even though nothing here plays. 48 kHz
 * is what `dsp/tests/verify.rs` verifies at; a different rate moves the sample
 * counts and no diagnostic.
 */
const SAMPLE_RATE = 48000;

export type Severity = 'error' | 'warning';

export interface Finding {
  severity: Severity;
  line: number;
  col: number;
  message: string;
}

export interface FileReport {
  path: string;
  /** False when the file has at least one error (a warning still leaves it true). */
  ok: boolean;
  /** Absent when the file could not be read. */
  summary?: {
    /** Synth fences that compiled cleanly. */
    tracks: number;
    /** Synth fences declared, including ones that failed. */
    trackCount: number;
    phrases: number;
    /** A `loop` fence is present, whether or not it compiled. */
    loopFence: boolean;
    /** The loop compiled to something schedulable. */
    loop: boolean;
    bpm: number;
    bars: number;
  };
  findings: Finding[];
}

export interface CheckReport {
  schemaVersion: number;
  files: FileReport[];
  errors: number;
  warnings: number;
}

export interface CheckOptions {
  /** Treat warnings as errors, for a CI job that wants no silent tracks. */
  strict: boolean;
}

/** Reads and checks one file. Never throws: an unreadable file is a finding. */
export function checkFile(path: string): FileReport {
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch (e) {
    // The path is already on both the summary line and the finding, so the
    // message says only what went wrong with it.
    return {
      path,
      ok: false,
      findings: [{ severity: 'error', line: 1, col: 1, message: `cannot read this file: ${readReason(e)}` }],
    };
  }

  const result = compile(source, SAMPLE_RATE);
  const findings: Finding[] = sortErrors(result.errors).map((e) => ({
    severity: 'error' as const,
    line: e.line,
    col: e.col,
    message: e.message,
  }));
  findings.push(...silenceWarnings(result));
  // Document order, warnings interleaved: the list is read top to bottom
  // against the file, not triaged by severity — that is what the counts at the
  // end are for.
  findings.sort((a, b) => a.line - b.line || a.col - b.col);

  return {
    path,
    ok: !findings.some((f) => f.severity === 'error'),
    summary: {
      tracks: result.tracks.length,
      trackCount: result.trackCount,
      phrases: Object.keys(result.phrases).length,
      loopFence: result.fences.some((f) => f.lang === 'loop'),
      loop: result.loop !== undefined,
      bpm: result.bpm,
      bars: result.loopMeta?.bars ?? 0,
    },
    findings,
  };
}

function readReason(e: unknown): string {
  const code = e instanceof Error && 'code' in e ? (e as NodeJS.ErrnoException).code : undefined;
  switch (code) {
    case 'ENOENT':
      return 'no such file';
    case 'EISDIR':
      return 'that is a directory';
    case 'EACCES':
      return 'permission denied';
    default:
      return e instanceof Error ? e.message : String(e);
  }
}

/**
 * What a clean compile still leaves silent.
 *
 * These are warnings rather than errors because every one of them is a
 * legitimate intermediate state — a patch written before the phrase that will
 * use it, a phrase kept around for the next section — and turning them into
 * errors would make the notation hostile to being written in any order. They
 * are worth saying out loud anyway, because "it compiles and I hear nothing"
 * is otherwise a debugging session with no starting point.
 */
function silenceWarnings(result: CompileResult): Finding[] {
  const out: Finding[] = [];
  const synthFences = result.fences.filter((f) => f.lang === 'synth' || f.lang === 'plugin');
  const loopFence = result.fences.find((f) => f.lang === 'loop');

  if (synthFences.length === 0) {
    out.push({ severity: 'warning', line: 1, col: 1, message: 'no `synth` or `plugin` fence: the document declares no track, so nothing can play' });
  }
  if (loopFence === undefined) {
    out.push({ severity: 'warning', line: 1, col: 1, message: 'no `loop` fence: nothing is scheduled, so the document is silent' });
  }

  // Bindings are only worth comparing against a document that compiled. A
  // broken fence drops out of the arrangement wherever it is written, so on a
  // document with any error at all these warnings describe the error's fallout
  // rather than the song — "phrase X is unused" when X simply failed to parse
  // is a second report of one mistake, and the less useful one.
  const lines = result.loopMeta?.lines;
  if (lines === undefined || result.errors.length > 0) return out;

  const boundPhrases = new Set(lines.map((l) => l.phraseId));
  for (const fence of result.fences) {
    if (fence.lang !== 'phrase') continue;
    const id = fence.attrs['id'];
    if (id === undefined || boundPhrases.has(id)) continue;
    // Only phrases that actually parsed: an unparsed one already has an error.
    if (result.phrases[id] === undefined) continue;
    out.push({
      severity: 'warning',
      line: fence.fenceLine,
      col: 1,
      message: `phrase \`${id}\` is never bound by a loop line, so it never plays`,
    });
  }

  const boundTracks = new Set(lines.map((l) => l.trackId));
  const trackFences = result.fences.filter((f) => f.lang === 'synth' || f.lang === 'plugin');
  for (const track of [...result.tracks, ...result.pluginTracks]) {
    if (boundTracks.has(track.id)) continue;
    const fence = trackFences[track.track];
    out.push({
      severity: 'warning',
      line: fence?.fenceLine ?? 1,
      col: 1,
      message: `track \`${track.id}\` has no loop line, so it never plays`,
    });
  }

  // A plugin track is silent in the browser and in `sheliak render`, because
  // both drive the engine and neither can load a `.clap`. Saying so is the
  // difference between a known limitation and a mystery.
  for (const track of result.pluginTracks) {
    const fence = trackFences[track.track];
    out.push({
      severity: 'warning',
      line: fence?.fenceLine ?? 1,
      col: 1,
      message:
        `track \`${track.id}\` is played by the plugin \`${track.from}\`, which the engine ` +
        'cannot load — it is silent here and in the browser. `sheliak render --emit-job` ' +
        'and `sheliak-render` play it',
    });
  }

  return out;
}

export function check(paths: string[]): CheckReport {
  const files = paths.map(checkFile);
  return {
    schemaVersion: SCHEMA_VERSION,
    files,
    errors: files.reduce((n, f) => n + f.findings.filter((x) => x.severity === 'error').length, 0),
    warnings: files.reduce((n, f) => n + f.findings.filter((x) => x.severity === 'warning').length, 0),
  };
}

/** True when the run should exit non-zero. */
export function failed(report: CheckReport, opts: CheckOptions): boolean {
  return report.errors > 0 || (opts.strict && report.warnings > 0);
}

// ------------------------------------------------------------------ output

/**
 * The human-readable report. Positions are `line:col` with the file in front,
 * which is the form an editor and a terminal both turn into a jump.
 */
export function formatText(report: CheckReport): string {
  const out: string[] = [];
  for (const file of report.files) {
    out.push(`${file.path} — ${summarize(file)}`);
    for (const f of file.findings) {
      out.push(`  ${file.path}:${f.line}:${f.col}  ${f.severity.padEnd(7)}  ${f.message}`);
    }
    out.push('');
  }

  const parts: string[] = [];
  if (report.errors > 0) parts.push(plural(report.errors, 'error'));
  if (report.warnings > 0) parts.push(plural(report.warnings, 'warning'));
  out.push(parts.length === 0 ? 'no problems' : parts.join(', '));
  return out.join('\n');
}

function summarize(file: FileReport): string {
  const s = file.summary;
  if (s === undefined) return 'not read';
  const bits = [
    `${plural(s.tracks, 'track')}${s.tracks === s.trackCount ? '' : ` of ${s.trackCount}`}`,
    plural(s.phrases, 'phrase'),
  ];
  // "no loop" for a document that has none and one whose loop failed to compile
  // reads as the same file, and they are the opposite problem.
  if (s.loop) bits.push(`${s.bpm}bpm`, plural(s.bars, 'bar'));
  else bits.push(s.loopFence ? 'loop did not compile' : 'no loop fence');
  return bits.join(' · ');
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** The same run as records, for a caller that is going to act on them. */
export function formatJson(report: CheckReport): string {
  return JSON.stringify(report, null, 2);
}
