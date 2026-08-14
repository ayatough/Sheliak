// Bundles `src/cli/` into one Node script, `dist-cli/sheliak.mjs`.
//
// A bundle rather than "run the TypeScript directly": the DSL is a tree of `.ts`
// modules importing each other with explicit `.ts` extensions, which Node will
// not resolve, and stripping types at runtime needs a Node newer than the one
// the README asks for. Bundling costs one build step and works everywhere.

import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    ssr: 'src/cli/bin.ts',
    outDir: 'dist-cli',
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
