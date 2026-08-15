// The render job: everything a synthesizer needs, and nothing about Markdown.
//
// `sheliak render` compiles and synthesizes in one process, which is the path
// that matters — it drives the same `dsp.wasm` the browser drives, so what it
// writes cannot drift from what a listener hears. A job exists for the renderer
// that cannot do the compiling half: `render/` is native Rust, which is the only
// place a `.clap` plugin can ever be loaded (docs/workstreams.md §9), and giving
// it a copy of the parser would be two grammars to keep in step.
//
// So the boundary is drawn where it already is everywhere else in this project:
// **the flat parameter block**. A job carries each track's `PARAM_COUNT` floats,
// the loop's events in samples, and how long to render. It is the content
// `worklet.js` receives over `postMessage`, written down — which is why it needs
// no version of its own to go wrong.

import type { CompileResult } from './../dsl/compile.ts';

/** One track's fully expanded patch, as the numbers the engine reads. */
export interface JobTrack {
  track: number;
  /** The `synth` fence's id, which names its stem file. */
  id: string;
  params: number[];
}

export interface JobEvent {
  offsetSamples: number;
  track: number;
  /** 0 = note on, 1 = note off. */
  kind: 0 | 1;
  note: number;
  velocity: number;
}

/** A track the engine cannot play: the renderer has to load a plugin for it. */
export interface JobPluginTrack {
  track: number;
  id: string;
  /** The plugin's reverse-domain id. Which file carries it is the renderer's
   *  problem, not the document's — a song names the plugin, not a path. */
  from: string;
  /** By the name the document wrote. Resolved where the plugin is loaded. */
  params: Record<string, { kind: 'normalized' | 'plain'; value: number }>;
}

export interface RenderJob {
  sampleRate: number;
  tracks: JobTrack[];
  /** Empty unless the document has a `plugin` fence. */
  pluginTracks: JobPluginTrack[];
  loop: { lengthSamples: number; events: JobEvent[] };
  /** Frames of loop, with the repeat count already multiplied out. */
  loopFrames: number;
  /** Frames of decay after every note is released. */
  tailFrames: number;
  stems: boolean;
}

export interface JobOptions {
  loops: number;
  tailSeconds: number;
  sampleRate: number;
  stems?: boolean;
}

/**
 * Builds a job from a compiled document.
 *
 * The frame counts are resolved here rather than left as a loop count and a
 * duration, so that both renderers agree on the length without repeating the
 * arithmetic — `Math.round` on the tail is the sort of thing two languages
 * quietly disagree about.
 */
export function buildJob(result: CompileResult, opts: JobOptions): RenderJob {
  if (result.loop === undefined) {
    throw new Error('no `loop` fence: nothing is scheduled, so there is nothing to render');
  }
  if (result.tracks.length === 0 && result.pluginTracks.length === 0) {
    throw new Error('no `synth` or `plugin` fence: the document declares no track, so there is nothing to render');
  }
  return {
    sampleRate: opts.sampleRate,
    tracks: result.tracks.map((t) => ({ track: t.track, id: t.id, params: Array.from(t.params) })),
    pluginTracks: result.pluginTracks.map((t) => ({
      track: t.track,
      id: t.id,
      from: t.from,
      params: Object.fromEntries(
        Object.entries(t.params).map(([name, p]) => [name, { kind: p.kind, value: p.value }]),
      ),
    })),
    loop: {
      lengthSamples: result.loop.lengthSamples,
      events: result.loop.events.map((e) => ({
        offsetSamples: e.offsetSamples,
        track: e.track,
        kind: e.kind,
        note: e.note,
        velocity: e.velocity ?? 0,
      })),
    },
    loopFrames: result.loop.lengthSamples * opts.loops,
    tailFrames: Math.round(opts.tailSeconds * opts.sampleRate),
    stems: opts.stems === true,
  };
}
