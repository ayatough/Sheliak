// What `public/worklet.js` needs from TypeScript, bundled for it.
//
// The worklet is plain JavaScript served verbatim, because bundlers rewrite
// module graphs in ways that break worklet scope. The CLAP host is TypeScript,
// because it is 700 lines of byte offsets that a type checker and a test suite
// should be looking at. Those two facts only meet through a build step:
// `npm run build:worklet-host` bundles this entry into
// `public/wclap-host.js`, which the engine loads with its own `addModule()`
// call before the worklet's — one `AudioWorkletGlobalScope`, so what this file
// puts on `globalThis` is what the worklet finds there.
//
// It is a generated file, like `dsp.wasm` and the brand artwork, and it is
// gitignored for the same reason.

export { WclapModule, WclapPlugin, installCallbacks } from './wclap.ts';
export { PluginRack } from './pluginRack.ts';
