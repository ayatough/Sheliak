import { defineConfig } from 'vite';

/**
 * Bundles the CLAP host for the AudioWorklet.
 *
 * `public/worklet.js` is plain JavaScript on purpose and cannot import
 * TypeScript; the host has to be TypeScript, because it is a page of struct
 * offsets that wants a type checker. This build is the join: one IIFE in
 * `public/`, loaded by its own `addModule()` call before the worklet's.
 *
 * The footer is the part that matters. `addModule()` loads a **module**
 * script, where a top-level `var` is module-scoped rather than global, so the
 * bundle's own binding would be invisible to `worklet.js`. Assigning it to
 * `globalThis` explicitly is what puts it in the scope both files share.
 */
export default defineConfig({
  // The output *is* the public directory; without this vite warns that it is
  // about to copy the folder into itself.
  publicDir: false,
  build: {
    outDir: 'public',
    emptyOutDir: false,
    target: 'es2022',
    // Readable in a worklet stack trace, and it is not on the critical path:
    // the file is only fetched by a document that names a plugin.
    minify: false,
    lib: {
      entry: 'src/audio/workletPlugins.ts',
      name: 'SheliakWclap',
      formats: ['iife'],
      fileName: () => 'wclap-host.js',
    },
    rollupOptions: {
      output: { footer: 'globalThis.SheliakWclap = SheliakWclap;' },
    },
  },
});
