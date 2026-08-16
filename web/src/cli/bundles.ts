// Finding the WCLAP bundles Sheliak ships with, on disk.
//
// A `.wclap` bundle is a directory holding `module.wasm`, and the ones Sheliak
// builds itself sit beside `dsp.wasm` — so the search is the same three
// candidates `defaultWasmPath` uses, for the same three places the CLI runs
// from: an installed release, the built bundle in a working copy, and the
// source tree.
//
// A missing bundle is not an error. It means a document naming a plugin from it
// gets told so by name, and every other document behaves exactly as it did
// before any of this existed.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WclapModule } from '../audio/wclap.ts';

/** Every bundle that is actually present, most-specific location first. */
export function bundlePaths(): string[] {
  const fromEnv = process.env['SHELIAK_WCLAP'];
  if (fromEnv !== undefined && fromEnv !== '') {
    return fromEnv.split(':').filter((path) => path !== '');
  }
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    resolve(here, 'app/sheliak.wclap/module.wasm'),
    resolve(here, '../public/sheliak.wclap/module.wasm'),
    resolve(here, '../../public/sheliak.wclap/module.wasm'),
  ].filter(existsSync);
}

/**
 * Instantiates every bundle given, collecting rather than throwing: one
 * unloadable bundle must not take the others with it.
 */
export function loadBundles(paths: readonly string[]): {
  modules: WclapModule[];
  errors: string[];
} {
  const modules: WclapModule[] = [];
  const errors: string[] = [];
  for (const path of paths) {
    try {
      // Copied into an array of our own: as far as the types are concerned a
      // Node Buffer may be backed by a SharedArrayBuffer.
      const file = readFileSync(path);
      const bytes = new Uint8Array(file.byteLength);
      bytes.set(file);
      modules.push(WclapModule.instantiate(bytes));
    } catch (error) {
      errors.push(`${path}: ${(error as Error).message}`);
    }
  }
  return { modules, errors };
}

/** Every plugin id the bundles on this machine can play, deduplicated. */
export function availablePluginIds(): Set<string> {
  const ids = new Set<string>();
  for (const module of loadBundles(bundlePaths()).modules) {
    for (const descriptor of module.descriptors()) ids.add(descriptor.id);
  }
  return ids;
}
