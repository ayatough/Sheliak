# Working on Sheliak

Instructions for coding agents (and humans who like checklists). Read this before
changing anything; it is short on purpose.

## What this project is

A Markdown-based music workstation. A song is a `.md` file: synth patches and
note data live in fenced code blocks, a Rust DSP core compiled to WebAssembly
renders them in an AudioWorklet, and the document — not a binary project file —
is the whole of the state. See [README](README.md) for the user view,
[docs/architecture.md](docs/architecture.md) for the design, and
[docs/development.md](docs/development.md) for the full contributor guide.

## Non-negotiables

1. **The DSP core must not know the DSL.** The WASM side takes a flat block of
   normalized `f32` parameters and note events, nothing else. That is what lets
   the notation change freely and the core be reused natively later. A string, a
   field name, or a unit conversion inside `dsp/` is a bug.
2. **No allocation inside `process()`.** Voices, buffers, delay lines and
   wavetables are allocated in `init()` and never again. `process()` is called on
   the audio thread; an allocation there is a dropout waiting for a busy machine.
3. **`dsp/src/params.rs` and `web/src/shared/params.ts` are one file written
   twice.** They are the contract between the two halves. Change both in the same
   commit or neither — a silent disagreement produces a patch that sounds wrong
   with nothing failing.
4. **The document is the single source of truth.** Every GUI gesture becomes the
   smallest possible text patch and flows back through the normal
   compile → hot-reload path (`web/src/dsl/edit.ts`). Nothing outside the targeted
   token is touched: comments, alignment and unrelated fields survive
   byte-for-byte. Never let the GUI hold state the document does not.
5. **Determinism is a feature, not an accident.** The same document and the same
   seed must produce bit-identical audio. Every random value comes from the
   patch seed (`dsp/src/rng.rs`); nothing reads a clock or a global RNG.
   `dsp/tests/verify.rs` enforces this — do not weaken it.
6. **English everywhere in the repository**: comments, identifiers, commit
   messages, docs. `docs/ja/` holds Japanese translations and is never the source
   of truth.
7. **Do not weaken a test to make it pass.** If a quality gate fails, either the
   change is wrong or the expectation genuinely moved — and if it moved, say so
   in the commit message.

## Definition of done

A change is finished when all of these hold:

```bash
export RUSTFLAGS="-D warnings"                       # CI sets this; without it clippy only advises
cargo test --manifest-path dsp/Cargo.toml            # determinism, aliasing, DC, click
cargo clippy --manifest-path dsp/Cargo.toml --all-targets
cargo fmt --manifest-path dsp/Cargo.toml --all -- --check

./scripts/build-wasm.sh                              # the wasm build is a gate of its own
cd web && npm ci && npm test && npm run build        # vitest incl. the wasm end-to-end test
```

`npm run build` runs `tsc --noEmit` first, so a type error fails the build rather
than reaching the browser. The web test suite includes
`web/src/integration.test.ts`, which loads the real `dsp.wasm` — so it only passes
after `build-wasm.sh` has run.

**Run these on the same toolchain CI does.** CI uses `dtolnay/rust-toolchain@stable`,
which is often newer than what is installed here, and each release adds lints. A
clean local run on an older compiler is not evidence. If `rustc --version` is
behind, `rustup toolchain install stable` and run the gate with `cargo +stable`.

plus, when the change is user-visible:

- a line in `CHANGELOG.md` under `[Unreleased]`
- DSL changes documented in [docs/syntax.md](docs/syntax.md) and shown in
  `web/src/defaultDoc.ts`, which is the document the editor opens with and
  therefore the first thing anybody sees
- parameter-layout changes reflected in **both** `params.rs` and `params.ts`, and
  in the table in [docs/architecture.md](docs/architecture.md)

**Then push it to `main`.** There is no second reader waiting on a branch, and
the preview site publishes from `main` and nowhere else, so a change parked on a
branch cannot be listened to where it matters. This makes the gate above the whole
of the review: run it before you push, not after. If something does land broken,
`git revert` it — reverting a small commit costs less than the branch dance would
have cost every commit that was fine.

## You cannot hear the output. Act accordingly.

This is the constraint that shapes how work is verified here. An agent can build
the project, run every test, and still have no idea whether a patch sounds like a
kick drum or a burst of noise. Three consequences:

- **The offline checks in `dsp/tests/verify.rs` are the substitute for ears**, and
  they are deliberately about the failure modes that are inaudible in a diff:
  determinism, aliasing above the Nyquist limit, DC offset, and clicks at note
  boundaries and patch changes. When you add a DSP feature, ask which of those
  four it could break and extend the test rather than assuming.
- **Say what you did not verify.** "The tests pass and the wasm builds; I have not
  heard it" is a complete and useful report. Claiming a sound is right when
  nothing could have told you is not.
- **Name where to listen.** When a change is audible, say which patch in
  `web/src/defaultDoc.ts` to play and what should be different about it. The
  author reviews by opening `/next/` and pressing play, often from a phone.

## Where things live

| Path | Owns | Touch it when |
|---|---|---|
| `dsp/src/lib.rs` | Raw WASM exports, the ABI surface | The engine gains an entry point |
| `dsp/src/engine.rs`, `multi.rs` | Voice allocation, track mixing, master guard | Polyphony, track routing |
| `dsp/src/oscillator.rs`, `tables.rs` | Wavetable playback, mipmaps, unison | Oscillator behaviour, new tables |
| `dsp/src/filter.rs`, `envelope.rs`, `lfo.rs`, `noise.rs` | Per-voice modules | Their own behaviour |
| `dsp/src/fx/` | Master FX chain, one file per effect | Adding or changing an effect |
| `dsp/src/params.rs` | Parameter block layout — **contract** | Only alongside `params.ts` |
| `web/src/dsl/` | Fence extraction, YAML subset, patch/loop parsing, surgical edits | Anything about notation |
| `web/src/gui/` | Step sequencer and parameter panel, as projections of text | Editor behaviour |
| `web/src/audio/` | AudioContext lifecycle, wasm loading, worklet messaging | Transport, loading |
| `web/public/worklet.js` | The AudioWorkletProcessor | Scheduling, event dispatch |
| `web/src/shared/params.ts` | Parameter block layout — **contract** | Only alongside `params.rs` |
| `web/src/defaultDoc.ts` | The document the editor opens with | A DSL feature needs showing |

`web/public/worklet.js` is plain JavaScript, not TypeScript, and lives in
`public/` rather than `src/`. That is deliberate: an AudioWorklet module is loaded
by URL at runtime, outside the bundler's graph, so it has to be self-contained and
dependency-free. Keep it that way.

## Running several agents at once

Work splits cleanly along the DSP/web boundary, and inside the web layer along
`dsl/` versus `gui/`. These streams rarely collide:

| Stream | Files | Notes |
|---|---|---|
| DSP modules | `dsp/src/{oscillator,filter,envelope,lfo,noise}.rs` | Pure DSP, tested offline |
| Effects | `dsp/src/fx/` | One file per effect; only `fx/mod.rs` connects them |
| Notation | `web/src/dsl/` | Pure functions, heavily unit-tested |
| Editor | `web/src/gui/`, `web/src/main.ts` | Projections over text |
| Transport | `web/src/audio/`, `web/public/worklet.js` | Scheduling and loading |
| Docs | `docs/`, `README.md` | Prose |

**Contention hotspots.** Coordinate before two agents edit these at once:

- `dsp/src/params.rs` **and** `web/src/shared/params.ts` — the pair has to move
  together, so two agents adding parameters will conflict in two files at once
- `web/src/defaultDoc.ts` — every DSL feature wants a line in it
- `CHANGELOG.md` — append-only, but still a merge conflict if edited simultaneously
- `dsp/src/engine.rs` — the seam every per-voice module passes through

**Splitting work.** Give each agent a whole vertical slice — DSL parsing plus IR
plus parameter mapping plus a line in the default document — rather than one layer
of several features. A slice that ends with green quality gates can be merged
independently; half a feature cannot.

## Playbooks

**Add a synth parameter.** Reserve a slot in `dsp/src/params.rs` → mirror it in
`web/src/shared/params.ts` → read it in the Rust module that uses it → parse and
validate the DSL field in `web/src/dsl/synth.ts` with a unit → add the default to
`web/src/dsl/ir.ts` → map IR to the parameter block → document it in
`docs/syntax.md` → show it in `web/src/defaultDoc.ts`.

**Add an effect.** New file in `dsp/src/fx/` → register the type id in `fx/mod.rs`
and both `params` files → parse it in `web/src/dsl/fx.ts` → defaults in `ir.ts` →
`docs/syntax.md` and the architecture table. Effect ids are part of the contract:
append, never renumber.

**Change the parameter layout.** This is the one change that breaks silently.
`PARAM_COUNT` and every base offset are duplicated by hand across two languages.
Move both files in one commit, run the wasm end-to-end test (which is the only
thing that would catch a disagreement), and say in the commit message what moved.

**Fix an audio bug.** Reproduce it offline first — `dsp/tests/verify.rs` runs the
engine on the native target with no browser involved, which is far faster than a
manual listen and is the only way to make the bug a permanent test. Only reach for
the browser when the bug is in scheduling or loading.

**Cut a release.** See the [release checklist](docs/development.md#release-checklist).
Short version: `./scripts/check-versions.sh` has to pass, the changelog gets
closed, and the tag is made from `main`.

## Things that will waste your time

- **Do not post `WebAssembly.Module` to the worklet — post the bytes.** Chrome
  drops a `Module` sent through `postMessage` without cross-origin isolation
  (COOP/COEP), silently, and the worklet simply never boots. The project
  deliberately avoids COOP/COEP because it breaks embedding, so
  `web/src/audio/engine.ts` transfers an `ArrayBuffer` and the worklet compiles
  it. This was already found and fixed once; do not undo it.
- **`dsp.wasm` and `worklet.js` have stable names, so browsers cache them.** The
  build appends a build id as a query string. If you change how assets are
  referenced, keep the cache-busting or you will spend an afternoon debugging a
  stale binary.
- **`cargo test` for the DSP core runs on the native target, not wasm.** The crate
  is both a `cdylib` and an `rlib` for exactly this reason. `cargo test --target
  wasm32-unknown-unknown` is not a thing that will work here.
- **`AudioContext` must be created and resumed inside a user gesture**, and the
  sample rate must come from the context — never hardcode 44100 or 48000. Musical
  time to samples is converted on the TypeScript side, always.
- **No `setTimeout`/`setInterval` scheduling.** The worklet counts samples and
  splits the 128-frame render quantum at event boundaries. Anything else is not
  sample-accurate and will drift.
- **Bare numbers in the DSL are a parse error on purpose.** Units are how the
  notation stops you from confusing milliseconds with seconds. When adding a
  field, pick its unit deliberately and add it to `web/src/dsl/units.ts`; only
  fields that are genuinely normalized ratios may take a bare `0.0`–`1.0`.
- **A parse error must not stop the audio.** The rule is that the last valid patch
  keeps playing and only the broken fence freezes. If you add a failure path,
  route it through `web/src/dsl/errors.ts` rather than throwing.
