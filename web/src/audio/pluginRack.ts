// The plugin tracks of one document, running.
//
// A `plugin` fence is a track whose voice is somebody else's program, so it
// takes an index in the same sequence as a `synth` fence and receives the same
// note events — but the engine knows nothing about it. This is the piece in
// between: it turns compiled plugin tracks into live plugins, routes notes to
// them, and adds what they produce to the mix.
//
// It is used from two places that cannot share code any other way: `offline.ts`
// (the test suite and `sheliak render`) imports it directly, and
// `public/worklet.js` reaches it through the bundle built by
// `npm run build:worklet-host`, because a worklet cannot import TypeScript. One
// implementation, two callers — the alternative was writing the parameter
// resolution twice and letting the two drift.
//
// # What it does about the master bus
//
// The engine guards its own sum; audio added afterwards is outside that
// guarantee, and a loud plugin takes the mix past full scale where the browser
// hard-clips it. So a caller that added anything calls `master_guard` on the
// engine, which is the same curve the native renderer re-applies for the same
// reason (docs/workstreams.md §9). A document with no plugin track never calls
// it and stays bit-identical to what it rendered before this file existed.

import type { CompiledPluginTrack } from '../dsl/compile.ts';
import type { PluginParam } from '../dsl/plugin.ts';
import { WclapModule, type WclapPlugin } from './wclap.ts';

/** One document's plugin tracks, keyed by track index. */
export class PluginRack {
  private readonly plugins = new Map<number, WclapPlugin>();

  private constructor() {}

  /**
   * Creates and activates a plugin per track, resolving each written
   * parameter name against the plugin's own list.
   *
   * Never throws: a plugin that cannot be found or a parameter it does not
   * have is a message, and the rest of the document still plays. Silence with
   * an explanation beats a song that will not start.
   */
  static open(
    modules: readonly WclapModule[],
    tracks: readonly CompiledPluginTrack[],
    sampleRate: number,
    maxFrames: number,
  ): { rack: PluginRack; errors: string[] } {
    const rack = new PluginRack();
    const errors: string[] = [];

    for (const track of tracks) {
      const module = modules.find((m) => m.descriptors().some((d) => d.id === track.from));
      if (module === undefined) {
        const known = modules.flatMap((m) => m.descriptors().map((d) => d.id));
        errors.push(
          `track "${track.id}": no plugin "${track.from}" is available here. ` +
            (known.length > 0
              ? `This build carries: ${known.join(', ')}`
              : 'This build carries no plugins at all') +
            '. A `.clap` installed on your machine plays through `sheliak-render`, not here',
        );
        continue;
      }

      let plugin: WclapPlugin;
      try {
        plugin = module.create(track.from);
        plugin.activate(sampleRate, maxFrames);
      } catch (error) {
        errors.push(`track "${track.id}": ${(error as Error).message}`);
        continue;
      }

      if (plugin.noteInputs() === 0) {
        errors.push(
          `track "${track.id}": "${track.from}" has no note input, so it cannot be a track's ` +
            'voice — it is an effect, and Sheliak cannot put a plugin in an effect chain yet',
        );
        plugin.destroy();
        continue;
      }

      errors.push(...applyParams(plugin, track));
      rack.plugins.set(track.track, plugin);
    }

    return { rack, errors };
  }

  /** Is this track index played by a plugin rather than by the engine? */
  has(track: number): boolean {
    return this.plugins.has(track);
  }

  get size(): number {
    return this.plugins.size;
  }

  /**
   * Starts a note. `note` may be fractional in Sheliak and cannot be in CLAP —
   * a note event carries an integer key — so a microtonal note reaches a plugin
   * rounded. Nothing here can fix that; a plugin would have to support note
   * expression, and saying so is better than pretending the pitch arrived.
   */
  noteOn(track: number, note: number, velocity: number, time = 0): void {
    this.plugins.get(track)?.noteOn(Math.round(note), velocity, time);
  }

  noteOff(track: number, note: number, time = 0): void {
    this.plugins.get(track)?.noteOff(Math.round(note), time);
  }

  allNotesOff(): void {
    // -1 is CLAP's wildcard key: every note this plugin is holding.
    for (const plugin of this.plugins.values()) plugin.noteOff(-1);
  }

  /**
   * Renders `frames` from every plugin and adds the result into `l` / `r`,
   * which are the engine's own output buffers. Returns whether anything was
   * added — the caller needs that to decide about the master guard.
   */
  add(frames: number, l: Float32Array, r: Float32Array): boolean {
    if (this.plugins.size === 0) return false;
    for (const plugin of this.plugins.values()) {
      plugin.process(frames);
      const channels = plugin.channels().out;
      const pl = plugin.output(0);
      const pr = channels > 1 ? plugin.output(1) : pl;
      for (let i = 0; i < frames; i++) {
        l[i] += pl[i]!;
        r[i] += pr[i]!;
      }
    }
    return true;
  }

  destroy(): void {
    for (const plugin of this.plugins.values()) plugin.destroy();
    this.plugins.clear();
  }
}

/**
 * Sends the fence's parameters, resolving each name against the plugin's own
 * list — the same contract the native renderer follows: a name the plugin does
 * not have, or a value outside its range, is an error that names the plugin
 * rather than the line, because the line was written before anyone could know.
 */
function applyParams(plugin: WclapPlugin, track: CompiledPluginTrack): string[] {
  const errors: string[] = [];
  const declared = plugin.params();
  for (const [name, param] of Object.entries(track.params)) {
    const match = declared.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (match === undefined) {
      errors.push(
        `track "${track.id}": "${track.from}" has no parameter "${name}". It has: ` +
          (declared.length > 0 ? declared.map((p) => p.name).join(', ') : '(none)'),
      );
      continue;
    }
    const value = resolve(match, param);
    if (value === null) {
      errors.push(
        `track "${track.id}": ${name} = ${param.raw} is outside ` +
          `${match.min}..${match.max}, which is what "${match.name}" accepts`,
      );
      continue;
    }
    plugin.setParam(match.id, value);
  }
  return errors;
}

/** A written value in the plugin's own units, or null when out of range. */
function resolve(
  param: { min: number; max: number },
  written: PluginParam,
): number | null {
  if (written.kind === 'normalized') {
    if (written.value < 0 || written.value > 1) return null;
    return param.min + written.value * (param.max - param.min);
  }
  if (written.value < param.min || written.value > param.max) return null;
  return written.value;
}
