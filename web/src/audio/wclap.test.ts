// The browser-side CLAP host, driven against a real WCLAP.
//
// The plugin under test is Sheliak's own distortion (`wclap/`), for the reason
// docs/workstreams.md §8 gives: a third-party binary as the first subject
// leaves two unknowns to debug at once, and no reference for what the right
// answer was. Here the effect is one the engine also runs, so "did the plugin
// path change the sound?" has an exact answer.
//
// The bundle is a build artifact. `./scripts/build-wclap.sh` writes it, and
// these tests skip loudly rather than silently when it has not been run.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { WclapModule, installCallbacks, type WclapPlugin } from './wclap.ts';

const BUNDLE = resolve(__dirname, '../../public/sheliak.wclap/module.wasm');
const PLUGIN_ID = 'io.github.ayatough.sheliak.dist';
const SAMPLE_RATE = 48000;
const BLOCK = 128;

const built = existsSync(BUNDLE);
const withBundle = built ? describe : describe.skip;
if (!built) {
  console.warn(`skipping the WCLAP tests: ${BUNDLE} is missing — run ./scripts/build-wclap.sh`);
}

function load(): WclapModule {
  return WclapModule.instantiate(readFileSync(BUNDLE));
}

/** An activated plugin, and the caller's job to destroy it. */
function open(): WclapPlugin {
  const plugin = load().create(PLUGIN_ID);
  plugin.activate(SAMPLE_RATE, BLOCK);
  return plugin;
}

/** Writes one cycle of a sine into both input channels. */
function sine(plugin: WclapPlugin, amplitude = 0.5): void {
  const l = plugin.input(0);
  const r = plugin.input(1);
  for (let i = 0; i < BLOCK; i++) {
    const s = amplitude * Math.sin((2 * Math.PI * i) / BLOCK);
    l[i] = s;
    r[i] = s;
  }
}

withBundle('the module Sheliak builds', () => {
  it('is the shape the draft asks for: no imports, and the four exports', () => {
    const module = new WebAssembly.Module(readFileSync(BUNDLE));
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    const exports = WebAssembly.Module.exports(module);
    expect(exports).toContainEqual({ name: 'memory', kind: 'memory' });
    expect(exports).toContainEqual({ name: 'clap_entry', kind: 'global' });
    expect(exports).toContainEqual({ name: 'malloc', kind: 'function' });
    // Exactly one table, and the host grows it — see installCallbacks.
    expect(exports.filter((e) => e.kind === 'table')).toHaveLength(1);
  });

  it('announces itself through the factory', () => {
    const descriptors = load().descriptors();
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]).toMatchObject({
      id: PLUGIN_ID,
      name: 'Sheliak Distortion',
      vendor: 'Sheliak',
    });
    expect(descriptors[0]!.features).toContain('audio-effect');
  });

  it('refuses a plugin id it does not have, and says what it does have', () => {
    expect(() => load().create('com.example.nope')).toThrow(PLUGIN_ID);
  });
});

withBundle('what the host can read off a plugin', () => {
  it('the parameters, with their ranges and defaults', () => {
    const plugin = open();
    const params = plugin.params();
    expect(params.map((p) => p.name)).toEqual(['Drive', 'Mix', 'Mode', 'Tone']);
    expect(params[0]).toMatchObject({ id: 0, min: 0, max: 1, default: 0.3, stepped: false });
    expect(params[2]).toMatchObject({ id: 2, min: 0, max: 2, stepped: true, enumerated: true });
    expect(params[3]).toMatchObject({ min: 20, max: 20000 });
    plugin.destroy();
  });

  it('the plugin’s own spelling of a value, which is the only label Sheliak has', () => {
    const plugin = open();
    expect(plugin.valueText(2, 0)).toBe('Tanh');
    expect(plugin.valueText(2, 1)).toBe('Fold');
    expect(plugin.valueText(2, 2)).toBe('Clip');
    expect(plugin.valueText(3, 20000)).toBe('20000');
    plugin.destroy();
  });

  it('the audio ports, which decide how it may be wired up', () => {
    const plugin = open();
    const { inputs, outputs } = plugin.ports();
    expect(inputs).toEqual([{ id: 0, name: 'Input', channels: 2, main: true }]);
    expect(outputs).toEqual([{ id: 0, name: 'Output', channels: 2, main: true }]);
    plugin.destroy();
  });

  it('a parameter value, before and after the host sets it', () => {
    const plugin = open();
    expect(plugin.value(0)).toBeCloseTo(0.3, 6);
    plugin.setParam(0, 0.8);
    // A queued event reaches the plugin at the next block, not before.
    expect(plugin.value(0)).toBeCloseTo(0.3, 6);
    plugin.process(BLOCK);
    expect(plugin.value(0)).toBeCloseTo(0.8, 6);
    plugin.destroy();
  });
});

withBundle('what comes out of process()', () => {
  it('silence in, silence out', () => {
    const plugin = open();
    plugin.process(BLOCK);
    expect([...plugin.output(0)].every((s) => s === 0)).toBe(true);
    expect([...plugin.output(1)].every((s) => s === 0)).toBe(true);
    plugin.destroy();
  });

  it('a bypassed effect passes the signal through bit for bit', () => {
    const plugin = open();
    sine(plugin);
    const before = [...plugin.input(0)];
    plugin.setParam(1, 0); // Mix = 0
    plugin.process(BLOCK); // this block still ramps down from the default mix
    plugin.process(BLOCK);
    expect([...plugin.output(0)]).toEqual(before);
    plugin.destroy();
  });

  it('a driven effect changes the signal, and stays in range', () => {
    const plugin = open();
    plugin.setParam(0, 1); // Drive = 1
    plugin.setParam(1, 1); // Mix = 1
    plugin.process(BLOCK);
    sine(plugin);
    plugin.process(BLOCK);

    const input = [...plugin.input(0)];
    const output = [...plugin.output(0)];
    expect(output).not.toEqual(input);
    expect(output.every((s) => Number.isFinite(s) && Math.abs(s) <= 1.5)).toBe(true);
    // A distortion that did nothing audible would still pass the line above.
    const moved = output.filter((s, i) => Math.abs(s - input[i]!) > 1e-4).length;
    expect(moved).toBeGreaterThan(BLOCK / 2);
  });

  it('the same input twice gives the same output twice', () => {
    const runs = [0, 1].map(() => {
      const plugin = open();
      plugin.setParam(0, 0.7);
      sine(plugin);
      plugin.process(BLOCK);
      sine(plugin);
      plugin.process(BLOCK);
      const out = [...plugin.output(0)];
      plugin.destroy();
      return out;
    });
    expect(runs[0]).toEqual(runs[1]);
  });

  it('a parameter change lands on the frame it was queued for', () => {
    // A block carrying an event at frame 64 is rendered in two halves, and a
    // *moving* smoother does not give the same numbers across 64 + 64 as it
    // does across 128. So the drive is settled first — the smoother parks
    // exactly on its target — and only then is the comparison about the event.
    const settled = (): WclapPlugin => {
      const plugin = open();
      plugin.setParam(0, 1); // Drive = 1
      plugin.setParam(1, 1); // Mix = 1
      for (let i = 0; i < 60; i++) plugin.process(BLOCK);
      return plugin;
    };

    // Mode is the one parameter that switches immediately rather than ramping,
    // so a mid-block change to the hard clip is visible on the exact sample.
    const plugin = settled();
    sine(plugin, 0.9);
    plugin.setParam(2, 2, 64);
    plugin.process(BLOCK);
    const withSwitch = [...plugin.output(0)];

    const plain = settled();
    sine(plain, 0.9);
    plain.process(BLOCK);
    const without = [...plain.output(0)];

    expect(withSwitch.slice(0, 64)).toEqual(without.slice(0, 64));
    expect(withSwitch.slice(64)).not.toEqual(without.slice(64));
    plugin.destroy();
    plain.destroy();
  });

  it('refuses a block longer than the one it was activated for', () => {
    const plugin = open();
    expect(() => plugin.process(BLOCK + 1)).toThrow(/activated for/);
    plugin.destroy();
  });
});

describe('what the host refuses to load', () => {
  /**
   * `(module (import "wasi_snapshot_preview1" "fd_write" (func (param i32))))`
   * — the shape of a plugin built against a C sysroot, which is what most
   * WCLAPs will look like until this host grows a WASI shim.
   */
  function importer(): Uint8Array<ArrayBuffer> {
    const encoder = new TextEncoder();
    const str = (s: string) => [s.length, ...encoder.encode(s)];
    const types = [0x01, 0x60, 0x01, 0x7f, 0x00];
    const imports = [0x01, ...str('wasi_snapshot_preview1'), ...str('fd_write'), 0x00, 0x00];
    return new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
      0x01, types.length, ...types,
      0x02, imports.length, ...imports,
    ]);
  }

  it('a module that needs an import it cannot be given, by name', () => {
    expect(() => WclapModule.instantiate(importer())).toThrow(/wasi_snapshot_preview1\.fd_write/);
  });
});

describe('installCallbacks', () => {
  it('makes a JS function callable from wasm through the table', () => {
    const table = new WebAssembly.Table({ element: 'anyfunc', initial: 1 });
    const seen: number[] = [];
    const [index] = installCallbacks(table, [
      { params: ['i32', 'i32'], result: 'i32', fn: (a, b) => (seen.push(a!, b!), a! + b!) },
    ]);
    expect(index).toBe(1);
    const fn = table.get(index!) as (a: number, b: number) => number;
    expect(fn(2, 40)).toBe(42);
    expect(seen).toEqual([2, 40]);
  });

  it('grows the table by exactly as many entries as it was given', () => {
    const table = new WebAssembly.Table({ element: 'anyfunc', initial: 3 });
    const nop = { params: ['i32'] as const, result: null, fn: () => {} };
    const indices = installCallbacks(table, [{ ...nop, params: ['i32'] }, { ...nop, params: ['i32'] }]);
    expect(indices).toEqual([3, 4]);
    expect(table.length).toBe(5);
  });
});
