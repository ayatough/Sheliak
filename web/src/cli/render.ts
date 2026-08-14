// `sheliak render` — the song as a file.
//
// The browser is the only place a document could be heard, and it cannot open a
// file or save one, so a song lived in a text editor and was auditioned by
// copy-paste. This is the other half: the same document, the same wasm, the same
// scheduling as the AudioWorklet, written to a WAV.
//
// It renders with the offline engine in `audio/offline.ts` rather than a copy,
// so what comes out of this is what the end-to-end test measures and — given the
// same document and seed — bit-identical between machines.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from '../dsl/compile.ts';
import { instantiateDsp, renderLoop, renderTail } from '../audio/offline.ts';
import { sortErrors } from '../dsl/errors.ts';
import { encodeWav, peakOf } from './wav.ts';

export interface RenderOptions {
  out: string;
  /** How many times the loop repeats. */
  loops: number;
  /** Seconds of decay rendered after the last note is released. */
  tailSeconds: number;
  sampleRate: number;
  /** Overrides where `dsp.wasm` is looked for. */
  wasm?: string;
}

export interface RenderResult {
  out: string;
  frames: number;
  seconds: number;
  peak: number;
  tracks: number;
  bpm: number;
}

/**
 * Where the DSP binary lives, relative to the module asking for it.
 *
 * Two answers, because this module runs from two places: bundled as
 * `dist-cli/sheliak.mjs`, one hop from `public/`, and straight from
 * `src/cli/render.ts` under vitest, which is two. `SHELIAK_WASM` overrides both,
 * for a build kept somewhere else entirely. The first candidate is returned
 * unconditionally when none exists, so the error names the expected location
 * rather than the last one tried.
 */
export function defaultWasmPath(): string {
  const fromEnv = process.env['SHELIAK_WASM'];
  if (fromEnv) return fromEnv;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(here, '../public/dsp.wasm'), resolve(here, '../../public/dsp.wasm')];
  return candidates.find(existsSync) ?? candidates[0];
}

/**
 * Copied into an array of our own rather than handed on as the Buffer:
 * `WebAssembly.Module` takes a BufferSource, and as far as the types are
 * concerned a Node Buffer may be backed by a SharedArrayBuffer.
 */
function readWasm(path: string): Uint8Array<ArrayBuffer> {
  const file = readFileSync(path);
  const bytes = new Uint8Array(file.byteLength);
  bytes.set(file);
  return bytes;
}

/** Renders `source` to a WAV file. Throws with a readable message on failure. */
export function render(source: string, opts: RenderOptions): RenderResult {
  // The document is read before the engine is loaded. Both can be wrong at
  // once, and "your line 5 is wrong" is the more useful half to hear first —
  // a missing wasm is a property of the machine, not of the song.
  const result = compile(source, opts.sampleRate);
  if (result.errors.length > 0) {
    // Rendering a document with an error would write a file that is not the song
    // — the broken track silently missing from it — so this refuses instead.
    const list = sortErrors(result.errors)
      .map((e) => `  ${e.line}:${e.col}  ${e.message}`)
      .join('\n');
    throw new Error(`the document does not compile, so there is nothing to render:\n${list}`);
  }
  if (result.loop === undefined) {
    throw new Error('no `loop` fence: nothing is scheduled, so there is nothing to render');
  }
  if (result.tracks.length === 0) {
    throw new Error('no `synth` fence: the document declares no track, so there is nothing to render');
  }

  const wasmPath = opts.wasm ?? defaultWasmPath();
  let wasm;
  try {
    wasm = readWasm(wasmPath);
  } catch {
    // The one dependency that installing this cannot produce: it comes out of
    // cargo. Naming the command that builds it is the whole of the fix.
    throw new Error(
      `the DSP core is not built: ${wasmPath} is missing.\n` +
        '  From a working copy, run ./scripts/build-wasm.sh (needs Rust with the\n' +
        '  wasm32-unknown-unknown target). Point --wasm at it if it lives elsewhere.',
    );
  }

  const dsp = instantiateDsp(wasm);
  const loopFrames = result.loop.lengthSamples * opts.loops;
  const body = renderLoop(dsp, result.tracks, result.loop, loopFrames, opts.sampleRate);

  const tailFrames = Math.round(opts.tailSeconds * opts.sampleRate);
  const l = concat(body.l, tailFrames);
  const r = concat(body.r, tailFrames);
  if (tailFrames > 0) {
    const tail = renderTail(dsp, tailFrames);
    l.set(tail.l, loopFrames);
    r.set(tail.r, loopFrames);
  }

  writeFileSync(opts.out, encodeWav(l, r, opts.sampleRate));
  return {
    out: opts.out,
    frames: l.length,
    seconds: l.length / opts.sampleRate,
    peak: peakOf(l, r),
    tracks: result.tracks.length,
    bpm: result.bpm,
  };
}

function concat(head: Float32Array, extra: number): Float32Array {
  if (extra <= 0) return head;
  const out = new Float32Array(head.length + extra);
  out.set(head, 0);
  return out;
}

/** The line printed after a successful render. */
export function describeRender(r: RenderResult): string {
  const clipped = r.peak > 1 ? '  ⚠ clipped' : '';
  return (
    `wrote ${r.out} — ${r.seconds.toFixed(2)}s · ${r.tracks} track${r.tracks === 1 ? '' : 's'} · ` +
    `${r.bpm}bpm · peak ${dbfs(r.peak)}${clipped}`
  );
}

function dbfs(peak: number): string {
  if (peak <= 0) return '-inf dBFS';
  return `${(20 * Math.log10(peak)).toFixed(1)} dBFS`;
}
