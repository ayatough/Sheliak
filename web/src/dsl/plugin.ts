// The `plugin` fence: a track whose voice comes from outside the engine.
//
// A ```plugin fence is a track like a ```synth fence is, and it occupies an
// index in the same sequence. What it does not have is a patch: there is no
// oscillator, filter or envelope to describe, because the sound is somebody
// else's program. All this fence carries is *which* program, and what to set on
// it.
//
// # Why the parser cannot check the parameter names
//
// Every other fence in this notation validates its keys, because Sheliak knows
// what a filter has. It does not know what `studio.kx.distrho.Kars` has, and it
// cannot find out: the parameters live behind `clap_plugin_params`, which means
// loading a dynamic library, which the browser cannot do at all. So a name here
// is accepted as written and resolved where the plugin is — the native renderer
// — and an unknown one is an error that names the plugin rather than the line.
//
// That is a real loss and it is the price of the thing being external. It is
// also why the *values* are restricted to the two forms below rather than the
// full unit vocabulary: `1.5kHz` would be a promise about the parameter's unit
// that nothing on this side can keep.

import { ErrorSink, type DslError } from './errors.ts';
import { parseYamlite, isScalar, nodePos } from './yamlite.ts';
import { parseScalar } from './units.ts';

/** How a plugin parameter was written, which decides what the number means. */
export type PluginValueKind =
  /** `60%` — a position between the parameter's own minimum and maximum. */
  | 'normalized'
  /** `800` — the plugin's own value, in whatever unit it uses. */
  | 'plain';

export interface PluginParam {
  kind: PluginValueKind;
  value: number;
  /** As written, so an error can quote it back. */
  raw: string;
}

export interface PluginIR {
  /** The fence's `id=`; a `loop` line binds to it. */
  id: string;
  /** The plugin's reverse-domain id, from `from=`. */
  from: string;
  /** Parameters by the name the document wrote, unvalidated (see above). */
  params: Record<string, PluginParam>;
}

export interface ParsePluginResult {
  ir: PluginIR | null;
  errors: DslError[];
}

/** A CLAP id is reverse-domain: dots and dashes, no spaces. */
const PLUGIN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function parsePlugin(
  body: string,
  attrs: Record<string, string>,
  opts: { bodyStartLine: number; fenceLine: number },
): ParsePluginResult {
  const sink = new ErrorSink();
  const id = attrs['id'] ?? '';
  const from = attrs['from'] ?? '';

  if (from === '') {
    sink.push(
      { line: opts.fenceLine, col: 1 },
      'a plugin fence needs `from=`, naming the plugin — e.g. ' +
        '```plugin id=pad from=studio.kx.distrho.Kars',
    );
  } else if (!PLUGIN_ID_RE.test(from)) {
    sink.push(
      { line: opts.fenceLine, col: 1 },
      `"${from}" is not a plugin id. CLAP ids are reverse-domain, like ` +
        '`studio.kx.distrho.Kars` — `sheliak-render --list-clap <file.clap>` prints them',
    );
  }

  const parsed = parseYamlite(body, opts.bodyStartLine);
  sink.errors.push(...parsed.errors);
  const params: Record<string, PluginParam> = {};

  for (const entry of parsed.root?.entries ?? []) {
    if (params[entry.key] !== undefined) {
      sink.push(nodePos(entry.value), `duplicate parameter "${entry.key}"`);
      continue;
    }
    if (!isScalar(entry.value)) {
      sink.push(
        nodePos(entry.value),
        `"${entry.key}" needs a single value: a plugin parameter is one number`,
      );
      continue;
    }
    const scalar = parseScalar(entry.value.value, nodePos(entry.value));
    if (scalar.unit === 'ratio') {
      params[entry.key] = { kind: 'normalized', value: scalar.value, raw: scalar.raw };
    } else if (scalar.unit === 'bare') {
      params[entry.key] = { kind: 'plain', value: scalar.value, raw: scalar.raw };
    } else {
      // Deliberately narrow. Sheliak does not know this parameter's unit, so
      // accepting `500ms` would be inventing a meaning for it.
      sink.push(
        nodePos(entry.value),
        `"${entry.key}: ${scalar.raw}" — a plugin parameter is written as a ` +
          'percentage of its own range (`60%`) or as the plugin\'s own number (`800`). ' +
          'Sheliak cannot know what unit this plugin uses',
      );
    }
  }

  const errors = sink.errors;
  return { ir: errors.length > 0 ? null : { id, from, params }, errors };
}
