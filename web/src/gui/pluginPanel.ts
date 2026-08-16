// Controls for a plugin nobody wrote a schema for.
//
// Every other panel in this app is generated from `schema.ts`, which knows what
// a filter cutoff is because Sheliak defines it. A plugin's parameters are not
// like that: the list arrives at run time from `clap_plugin_params`, with a
// name, a range, a default, and — through `value_to_text` — the plugin's own
// spelling of a value. That is all there is, and it turns out to be enough to
// draw a working panel.
//
// # What is deliberately absent
//
// A unit. CLAP does not carry one, so Sheliak still does not know whether 8000
// is hertz or milliseconds, and nothing here pretends otherwise: the number
// under a control is whatever `value_to_text` said, and the number written into
// the document is the plugin's own.
//
// # The one guess
//
// Whether a slider is linear or logarithmic. A 20..20000 control is unusable
// linear and there is no flag for it, so the rule is a ratio: a range that
// spans a factor of a hundred or more, with a positive minimum, gets a log
// slider. It is a guess about *feel*, not about meaning — the value written is
// identical either way — which is why it is allowed to be a guess at all.

import { setPluginParam, getPluginParamText } from '../dsl/edit.ts';
import type { EditResult } from '../dsl/edit.ts';
import { parseScalar } from '../dsl/units.ts';
import type { WclapParam, WclapPlugin } from '../audio/wclap.ts';

/** A control drawn for one CLAP parameter. */
export interface PluginFieldSpec {
  /** The plugin's stable id, which is what a CLAP event carries. */
  id: number;
  /** The plugin's name for it, and the key written in the fence. */
  name: string;
  min: number;
  max: number;
  default: number;
  kind: 'lin' | 'log' | 'int' | 'enum';
  /** For `enum`, the plugin's own label per step. */
  options?: string[];
  /** What the plugin calls this value, for the readout. */
  label: (value: number) => string;
}

/** Ranges wider than this, with a positive minimum, get a log slider. */
const LOG_RATIO = 100;

/**
 * Turns a plugin's parameter list into controls, asking the plugin itself for
 * every label it will show.
 */
export function pluginFields(plugin: WclapPlugin, params: readonly WclapParam[] = plugin.params()): PluginFieldSpec[] {
  return params.map((param) => {
    const options = param.enumerated ? stepLabels(plugin, param) : undefined;
    return {
      id: param.id,
      name: param.name,
      min: param.min,
      max: param.max,
      default: param.default,
      kind: options ? 'enum' : param.stepped ? 'int' : scale(param),
      ...(options ? { options } : {}),
      label: (value: number) => plugin.valueText(param.id, value) ?? trim(value),
    };
  });
}

function scale(param: WclapParam): 'lin' | 'log' {
  return param.min > 0 && param.max / param.min >= LOG_RATIO ? 'log' : 'lin';
}

/** One label per step of an enumerated parameter, asked of the plugin. */
function stepLabels(plugin: WclapPlugin, param: WclapParam): string[] {
  const out: string[] = [];
  for (let value = Math.round(param.min); value <= Math.round(param.max); value++) {
    out.push(plugin.valueText(param.id, value) ?? String(value));
  }
  return out;
}

// ---------------------------------------------------------------- the slider

/** Slider position (0..1) for a value. */
export function toSlider(spec: PluginFieldSpec, value: number): number {
  if (spec.max === spec.min) return 0;
  if (spec.kind === 'log') {
    const lo = Math.log(spec.min);
    const hi = Math.log(spec.max);
    return clamp01((Math.log(Math.max(value, spec.min)) - lo) / (hi - lo));
  }
  return clamp01((value - spec.min) / (spec.max - spec.min));
}

/** Value for a slider position (0..1). */
export function fromSlider(spec: PluginFieldSpec, t: number): number {
  const u = clamp01(t);
  if (spec.kind === 'log') {
    const lo = Math.log(spec.min);
    const hi = Math.log(spec.max);
    return Math.exp(lo + (hi - lo) * u);
  }
  const raw = spec.min + (spec.max - spec.min) * u;
  return spec.kind === 'lin' ? raw : Math.round(raw);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// ------------------------------------------------------------- reading back

/**
 * The value a fence currently gives a parameter, resolved the way the renderer
 * resolves it: a percentage against the plugin's own range, a bare number as
 * the plugin's own value. Falls back to the plugin's default when the fence
 * does not mention it — which is exactly what will be heard.
 */
export function currentValue(doc: string, track: number, spec: PluginFieldSpec): number {
  const text = getPluginParamText(doc, track, spec.name);
  if (text === null) return spec.default;
  const scalar = parseScalar(text, { line: 1, col: 1 });
  if (scalar.unit === 'ratio') return spec.min + clamp01(scalar.value) * (spec.max - spec.min);
  if (scalar.unit === 'bare') return Math.min(spec.max, Math.max(spec.min, scalar.value));
  return spec.default;
}

/**
 * Writes a value into the fence, **keeping the spelling that is already
 * there**.
 *
 * A document that says `cutoff: 40%` gets a percentage back and one that says
 * `cutoff: 8000` gets a number, because the person who wrote the line chose
 * that spelling and a knob is not an argument for changing it. A parameter the
 * fence does not mention yet is written as the plugin's own number: it is the
 * spelling that survives a plugin changing its range.
 */
export function writePluginField(
  doc: string,
  track: number,
  spec: PluginFieldSpec,
  value: number,
): EditResult {
  const existing = getPluginParamText(doc, track, spec.name);
  const asRatio = existing !== null && parseScalar(existing, { line: 1, col: 1 }).unit === 'ratio';
  return setPluginParam(doc, track, spec.name, asRatio ? percent(spec, value) : trim(value));
}

function percent(spec: PluginFieldSpec, value: number): string {
  const span = spec.max - spec.min;
  const t = span === 0 ? 0 : (value - spec.min) / span;
  // One decimal is exactly the slider's own resolution — it has a thousand
  // steps — and a document full of `25.044%` reads like machine output.
  return `${Number((clamp01(t) * 100).toFixed(1))}%`;
}

/**
 * A number as short as it can be without changing what it means here.
 *
 * Four significant figures: finer than a thousand-step slider anywhere in a
 * range, and it keeps `0.4173` as readable as `8123`, which a fixed number of
 * decimals cannot do when the unit is unknown.
 */
function trim(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toPrecision(4)));
}
