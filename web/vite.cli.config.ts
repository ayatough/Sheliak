// Bundles `src/cli/` into one Node script, `dist-cli/sheliak.mjs`.
//
// A bundle rather than "run the TypeScript directly": the DSL is a tree of `.ts`
// modules importing each other with explicit `.ts` extensions, which Node will
// not resolve, and stripping types at runtime needs a Node newer than the one
// the README asks for. Bundling costs one build step and works everywhere.
//
// Every path here is absolute, resolved against this file rather than the
// working directory, because the build runs from two places: `npm run build:cli`
// inside `web/`, and the root manifest's `prepare` — which is what a global
// install runs, from the repository root.

import { defineConfig } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  // The app's `public/` is the browser's — dsp.wasm, the icons, the manifest.
  // Left on, every one of them is copied next to the bundle and published with
  // it, which is 780 kB of an npm package that has no use for any of it.
  publicDir: false,
  build: {
    ssr: resolve(here, 'src/cli/bin.ts'),
    outDir: resolve(here, 'dist-cli'),
    emptyOutDir: true,
    target: 'node20',
    // Read by a person the moment anything is wrong with it, and small enough
    // that nothing is gained by making it unreadable.
    minify: false,
    rollupOptions: {
      output: {
        entryFileNames: 'sheliak.mjs',
        banner: '#!/usr/bin/env node',
      },
    },
  },
});
