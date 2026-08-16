// Controls generated from a plugin's own parameter list.
//
// The plugin is the real one, because the point of this panel is that nothing
// in Sheliak describes it: a fake would be a schema written here, which is the
// thing being avoided. Skips when the bundle has not been built.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { WclapModule, type WclapPlugin } from '../audio/wclap.ts';
import {
  currentValue,
  fromSlider,
  pluginFields,
  toSlider,
  writePluginField,
  type PluginFieldSpec,
} from './pluginPanel.ts';

const BUNDLE = resolve(__dirname, '../../public/sheliak.wclap/module.wasm');
const SYNTH = 'io.github.ayatough.sheliak.synth';
const built = existsSync(BUNDLE);
const withBundle = built ? describe : describe.skip;

function synth(): WclapPlugin {
  const file = readFileSync(BUNDLE);
  const bytes = new Uint8Array(file.byteLength);
  bytes.set(file);
  return WclapModule.instantiate(bytes).create(SYNTH);
}

const DOC = [
  '```plugin id=lead from=' + SYNTH,
  'cutoff: 40%',
  'release: 0.4',
  '```',
  '',
  '```loop id=groove bars=1 bpm=120',
  'lead: riff',
  '```',
].join('\n');

function field(specs: PluginFieldSpec[], name: string): PluginFieldSpec {
  const spec = specs.find((s) => s.name === name);
  if (!spec) throw new Error(`no ${name} in ${specs.map((s) => s.name).join(', ')}`);
  return spec;
}

withBundle('controls built from what the plugin says', () => {
  it('one per parameter, with the plugin’s names and ranges', () => {
    const specs = pluginFields(synth());
    expect(specs.map((s) => s.name)).toContain('Cutoff');
    expect(field(specs, 'Cutoff')).toMatchObject({ min: 20, max: 20000, default: 8000 });
  });

  it('a wide range gets a log slider, a narrow one does not', () => {
    const specs = pluginFields(synth());
    // 20..20000 is a factor of a thousand: linear would put every useful
    // setting in the last tenth of the travel.
    expect(field(specs, 'Cutoff').kind).toBe('log');
    expect(field(specs, 'Resonance').kind).toBe('lin');
  });

  it('an enumerated parameter carries the plugin’s own labels', () => {
    const waveform = field(pluginFields(synth()), 'Waveform');
    expect(waveform.kind).toBe('enum');
    expect(waveform.options).toEqual(['Sine', 'Triangle', 'Saw', 'Square', 'PWM', 'Fold']);
  });

  it('the readout is the plugin’s spelling, not ours', () => {
    const specs = pluginFields(synth());
    expect(field(specs, 'Cutoff').label(8000)).toBe('8000 Hz');
    expect(field(specs, 'Release').label(0.4)).toBe('0.400 s');
    expect(field(specs, 'Waveform').label(3)).toBe('Square');
  });

  it('the slider round-trips a value', () => {
    const cutoff = field(pluginFields(synth()), 'Cutoff');
    for (const value of [20, 440, 8000, 20000]) {
      expect(fromSlider(cutoff, toSlider(cutoff, value))).toBeCloseTo(value, 3);
    }
  });

  it('a stepped parameter only produces whole numbers', () => {
    const unison = field(pluginFields(synth()), 'Unison');
    expect(unison.kind).toBe('int');
    for (let t = 0; t <= 1; t += 0.05) {
      expect(Number.isInteger(fromSlider(unison, t))).toBe(true);
    }
  });
});

withBundle('reading the document', () => {
  it('a percentage is resolved against the plugin’s own range', () => {
    const cutoff = field(pluginFields(synth()), 'Cutoff');
    // 40% of 20..20000.
    expect(currentValue(DOC, 0, cutoff)).toBeCloseTo(20 + 0.4 * (20000 - 20), 6);
  });

  it('a bare number is the plugin’s own value', () => {
    const release = field(pluginFields(synth()), 'Release');
    expect(currentValue(DOC, 0, release)).toBeCloseTo(0.4, 6);
  });

  it('a parameter the fence does not mention reads as the plugin’s default', () => {
    const resonance = field(pluginFields(synth()), 'Resonance');
    expect(currentValue(DOC, 0, resonance)).toBeCloseTo(resonance.default, 6);
  });
});

withBundle('writing back into the document', () => {
  it('keeps the spelling the line already uses', () => {
    const specs = pluginFields(synth());
    const percent = writePluginField(DOC, 0, field(specs, 'Cutoff'), 10010);
    expect(percent.ok && percent.doc).toContain('cutoff: 50%');

    const bare = writePluginField(DOC, 0, field(specs, 'Release'), 1.25);
    expect(bare.ok && bare.doc).toContain('release: 1.25');
  });

  it('adds a line for a parameter the fence does not have yet', () => {
    const r = writePluginField(DOC, 0, field(pluginFields(synth()), 'Resonance'), 0.5);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc).toContain('Resonance: 0.5');
    // And nothing else moved.
    expect(r.doc).toContain('cutoff: 40%');
    expect(r.doc.split('\n').length).toBe(DOC.split('\n').length + 1);
  });

  it('touches nothing but the one token', () => {
    const spec = field(pluginFields(synth()), 'Cutoff');
    const r = writePluginField(DOC, 0, spec, 10010);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const before = DOC.split('\n');
    const after = r.doc.split('\n');
    const changed = after.filter((line, i) => line !== before[i]);
    expect(changed).toEqual(['cutoff: 50%']);
  });

  it('a value written back reads back as the same value', () => {
    const specs = pluginFields(synth());
    for (const name of ['Cutoff', 'Release', 'Waveform']) {
      const spec = field(specs, name);
      const target = spec.kind === 'enum' ? 2 : (spec.min + spec.max) / 3;
      const r = writePluginField(DOC, 0, spec, target);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(currentValue(r.doc, 0, spec)).toBeCloseTo(target, 1);
    }
  });
});
