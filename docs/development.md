# Development guide

Everything a contributor needs: how to build, what the quality gates check, how
the two halves fit together, and how versions are handled.

## Setup

Rust with the `wasm32-unknown-unknown` target, and Node.js 20 or newer.

```bash
rustup target add wasm32-unknown-unknown

./scripts/build-wasm.sh     # DSP core -> web/public/dsp.wasm
cd web && npm install
```

`build-wasm.sh` builds with `--release` and `RUSTFLAGS="-C target-feature=+simd128"`,
then copies the artifact into `web/public/`. Run it before the web tests: the
end-to-end test loads the real binary.

## Common tasks

```bash
cd web && npm run dev        # development server
cd web && npm run build      # tsc --noEmit, then a production build
cd web && npm test           # vitest

cargo test --manifest-path dsp/Cargo.toml     # offline DSP verification
./scripts/build-wasm.sh                       # rebuild the wasm after a Rust change
./scripts/check-versions.sh                   # every version agrees
```

`npm run build` type-checks before bundling, so a type error is a build failure
rather than something the bundler shrugs at.

## Repository layout

```
dsp/                 Rust DSP core (cdylib for wasm32, rlib for native tests)
  src/params.rs        parameter block layout — contract file
  src/fx/              master effect chain, one file per effect
  tests/verify.rs      determinism, aliasing, DC, click
web/
  public/worklet.js    AudioWorkletProcessor (plain JS, outside the bundler)
  src/shared/params.ts parameter block layout — contract file
  src/dsl/             fence extraction, YAML subset, parsing, surgical edits
  src/gui/             step sequencer and parameter panel
  src/audio/           AudioContext, wasm loading, worklet messaging
scripts/             build helpers
docs/                architecture, syntax, roadmap, workstreams; ja/ translations
```

See [architecture.md](architecture.md) for how the pieces talk to each other and
for the ABI and parameter-block contracts.

## Quality gates

CI runs all of these on every push and every pull request.

| Gate | Location | What it protects |
|---|---|---|
| Determinism | `dsp/tests/verify.rs` | The same patch and seed render byte-for-byte identically. Without this, a song is not reproducible and nothing downstream — checksums, regression tests, "it sounds different on my machine" — can be answered |
| Aliasing | `dsp/tests/verify.rs` | A saw at C7, FFT'd, has no peak above −60 dB relative to the fundamental that is not a harmonic. This is what the wavetable mipmaps exist for, and it fails silently otherwise |
| DC and level | `dsp/tests/verify.rs` | Output DC offset near zero, peak at or below 1.0 |
| Clicks | `dsp/tests/verify.rs` | Sample-to-sample deltas stay under a threshold across `note_on`, `note_off` and `apply_patch`, which is what the parameter smoothing is for |
| Parser | `web/src/dsl/*.test.ts` | Units, defaults, expansion, error positions, and that surgical edits leave everything else byte-identical |
| End to end | `web/src/integration.test.ts` | Loads the real `dsp.wasm`. The only gate that catches a disagreement between `dsp/src/params.rs` and `web/src/shared/params.ts` |
| Types | `tsc --noEmit`, run by `npm run build` | |
| Lint | CI | `cargo fmt --check` and `cargo clippy` with warnings denied |
| Versions | `scripts/check-versions.sh` | Every file that writes the version down agrees with the manifest |

**You cannot hear these.** The four DSP checks are chosen precisely because they
cover failure modes that are invisible in a diff and inaudible in a quick listen.
When you add DSP, ask which of the four your change could break and extend the
test rather than assuming.

## Working with coding agents

[AGENTS.md](../AGENTS.md) is the entry point for agents: non-negotiables,
definition of done, layer ownership, and which streams can run in parallel without
colliding. `CLAUDE.md` points there too. Keep it in sync when the build commands
or quality gates change — an agent that follows a stale checklist will confidently
produce work that fails CI.

## Conventions

- **English everywhere in the repository**: code comments, identifiers, commit
  messages, documentation. Japanese translations live under `docs/ja/` and are a
  convenience, never the source of truth.
  **The application's own UI strings are the one exception, and an open
  question** — the editor and `web/src/defaultDoc.ts` are currently Japanese.
  That is a decision about who the app is for rather than about the repository,
  so it has not been made by this convention. Until it is, leave them.
- Comments explain *why*, not *what*. The surrounding code already says what.
- Every new DSL field needs three things: a parser test, a row in
  [syntax.md](syntax.md), and an appearance in `web/src/defaultDoc.ts` — the
  document the editor opens with, and therefore the first thing anybody sees.
- Anything touching the parameter block moves `dsp/src/params.rs` and
  `web/src/shared/params.ts` in the same commit, and the table in
  [architecture.md](architecture.md) with them.
- Effect type ids and modulation enum values are appended, never renumbered.

## Versioning

Sheliak is pre-1.0 and versioned as `0.MINOR.PATCH`. The Rust crate and the web
package carry the same number.

- **`0.x` means the notation can change.** Breaking changes to the DSL are allowed
  in a minor bump, and they must be listed in [`CHANGELOG.md`](../CHANGELOG.md).
- **Which digit moves is read off the changelog**, so it is not a judgement call
  made twice: `[Unreleased]` carrying an `### Added`, `### Changed` or
  `### Removed` is a minor bump, because any of the three can move the notation
  under someone; a section that is only `### Fixed` is a patch.
- The version is written in `dsp/Cargo.toml`, `dsp/Cargo.lock`,
  `web/package.json`, the closed heading in `CHANGELOG.md`, and the status
  sentence in both `README.md` and [`roadmap.md`](roadmap.md).
  `./scripts/check-versions.sh` is the check, and CI runs it on every push.
- Nothing is published to crates.io or npm. Depend on a git tag or commit.
- `1.0` is reserved for the point where the notation is stable enough that songs
  written today will keep playing. See the [roadmap](roadmap.md) for what still
  has to land first.

### When to release, and why not more often

**A release is not what happens when a feature lands.** Every push to `main`
republishes the app on GitHub Pages, so anyone who wants the newest behaviour has
it without a version number. A tag does not build anything extra; it marks a point
somebody can pin and a moment when the documentation was checked against the
software.

Release when there is **a reason to pin**, not when there is a change:

- a notation change that songs written before it will not survive — so that the
  version before it stays reachable;
- enough accumulated features that the changelog reads like news — batched, on
  the order of a month;
- never merely because a piece of work finished.

The two expensive parts of a release are done by hand and do not get cheaper with
frequency: writing a changelog section somebody would actually read, and checking
that the documentation still describes the software.

### `main` is the development branch

There is no `develop`. A long-lived integration branch earns its cost when `main`
must stay releasable at every commit — because releases are cut continuously, or
because hotfixes have to bypass in-flight work. Neither is true here: nothing is
released without someone asking for it, and every push to `main` already runs the
full gate before it reaches Pages.

Use a branch when work is genuinely speculative, or when two agents are editing
the same file — which is what the ownership tables in
[AGENTS.md](../AGENTS.md#running-several-agents-at-once) exist to prevent.

## Release checklist

1. `cargo fmt --manifest-path dsp/Cargo.toml --all -- --check`,
   `cargo clippy --manifest-path dsp/Cargo.toml --all-targets` with
   `RUSTFLAGS="-D warnings"`, and `cargo test --manifest-path dsp/Cargo.toml` are
   clean
2. `./scripts/build-wasm.sh` succeeds, then `npm ci && npm test && npm run build`
   in `web/`
3. Write the version into `dsp/Cargo.toml`, `dsp/Cargo.lock`, `web/package.json`,
   and the status sentence in `README.md` and `docs/roadmap.md`; close
   `[Unreleased]` in `CHANGELOG.md` into a dated section with a fresh empty one
   above it. `./scripts/check-versions.sh` confirms all of it
4. **Read what you are about to release.** Nothing writes the prose. Read the
   dated changelog section as a stranger would, and open the deployed app and
   press play — that is the release candidate
5. **Land the commit on `main`.** A release is cut from `main`, so a bump sitting
   on a branch cannot be tagged. `git commit -am "Release vX.Y.Z"`, saying in the
   body why this bump rather than what changed, then `git push origin HEAD:main`
6. `git tag vX.Y.Z && git push origin vX.Y.Z`

   **Pushing a tag is refused for an agent** (403; the credentials are scoped to
   branches). An agent does steps 1 to 5 and says the tag is the remaining step,
   rather than working around it.
