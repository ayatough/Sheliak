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
cd web && npm run build:cli  # bundle the CLI -> web/dist-cli/sheliak.mjs

./scripts/sheliak new song.md                 # start a song
./scripts/sheliak check song.md               # compile it and report every error
./scripts/sheliak fmt song.md                 # canonicalise every phrase grid
./scripts/sheliak render song.md -o out.wav   # render it offline (needs the wasm)
./scripts/sheliak serve song.md               # the app, pointed at that file

./scripts/sheliak render song.md --emit-job job.json   # compile only, no engine
./render/target/release/sheliak-render job.json -o out.wav   # synthesize natively
./scripts/check-render-parity.sh song.md      # how far the two builds disagree

# CLAP plugins, hosted natively (a .clap cannot be loaded in a browser):
./render/target/release/sheliak-render --list-clap /usr/lib/clap/x.clap
./render/target/release/sheliak-render job.json -o out.wav --clap /usr/lib/clap/x.clap
# The plugin tests skip when none is installed. On Debian/Ubuntu:
#   apt-get install dragonfly-reverb-clap lsp-plugins-clap
# or point SHELIAK_TEST_CLAP at one.

cargo test --manifest-path dsp/Cargo.toml     # offline DSP verification
cargo test --manifest-path render/Cargo.toml  # the native renderer's own checks
./scripts/build-wasm.sh                       # rebuild the wasm after a Rust change
./scripts/check-versions.sh                   # every version agrees
./scripts/build-release.sh                    # the release tarball, into dist-release/
./scripts/build-site.sh site                  # the published site, into site/
```

### Releasing

`scripts/build-release.sh` assembles one tarball for every platform — the CLI
bundle, the built app, and `dsp.wasm` inside it — because nothing in it is
platform-specific. `release.yml` runs that same script on a `v*` tag, extracts
the result somewhere unrelated to the repository, runs the CLI out of it, and
only then publishes the archive and its checksum. `workflow_dispatch` builds and
uploads the tarball as a run artifact without publishing anything, which is the
only way to check the packaging before a tag makes it permanent.

**Cutting a release is four commands, and they are in
[docs/releasing.md](releasing.md).** `./scripts/release.sh <version>` does every
mechanical part — the six version copies, the changelog, the gate — and then
stops, because what is left is a commit and a tag and those are not a script's
to make. The order is load-bearing: the site's root is built from the newest
tag, so tagging before CI goes green on the bump rebuilds the front page from
the release before last.

Two sites come out of one deployment, because GitHub Pages serves one directory
tree per repository: `/` is the latest tag, built from that tag's own checkout,
and `/next/` is the tip of `main`, marked as a working copy and carrying a
`noindex`. `pages.yml` is triggered by CI and Release *finishing* rather than by
the push that started them — run on the same event they race, and a commit with
a red suite can reach the site first. Both channels are built by
`scripts/build-site.sh`, which is also how you build either of them here:

```bash
VITE_BASE=/Sheliak/ VITE_SITE_CHANNEL=stable VITE_SITE_VERSION=v0.1.0 \
  ./scripts/build-site.sh site
```

`scripts/install.sh` is what the README's `curl | sh` runs: latest tag from the
releases API, checksum verified, extracted to `~/.local/share/sheliak`, with a
wrapper in `~/.local/bin`. It refuses before downloading anything when Node is
missing or older than 20 — a tarball on disk that cannot run is worse than a
refusal that names the requirement.

The CLI lives in `web/src/cli/` and is bundled by `vite.cli.config.ts`, because
it imports the DSL parser — the same `compile()` the browser runs, so a document
that passes `check` is a document the editor accepts. `./scripts/sheliak`
rebuilds the bundle whenever a source file is newer than it; nothing else needs
to remember to. Its tests are ordinary vitest files beside it and run as part of
`npm test`, and `src/cli/scaffold.test.ts` compiles the starter song and fails on
so much as a warning, which is what stops `sheliak new` writing a file that no
longer parses.

### The two package manifests

`web/package.json` is the app and owns the toolchain. The one at the repository
root exists for exactly one reason: npm cannot install a package from a
subdirectory of a git repository, so without a manifest at the root there is no
`npx github:ayatough/Sheliak` and no `npm link`. It is a distribution wrapper,
not a second project — nothing in the local workflow goes through it and CI does
not touch it. Its version is checked by `./scripts/check-versions.sh` like every
other copy.

Three things about it are load-bearing, and each of them is the shape it is
because the obvious version was tried and failed:

- **It bundles the CLI itself** (`prepare` runs `vite build`) rather than
  delegating to `web/`. An `npm` invoked from inside an `npm` lifecycle script
  inherits the outer install's config — including `--global`, which turns
  `cd web && npm install` into an attempt to install the package into itself,
  and rules out `--workspace` entirely ("Workspaces not supported for global
  packages"). The price is that Vite is named in two manifests, which
  `check-versions.sh` now compares.
- **`web/vite.cli.config.ts` resolves every path against itself**, not the
  working directory, because it is run from `web/` by `npm run build:cli` and
  from the repository root by this `prepare`.
- **`bin` points at `web/dist-cli/`, which is build output and git-ignored.**
  That is only safe because `prepare` runs before npm packs. Without it the
  entry is a link to a file that does not exist, which is exactly what
  `npm install -g` from a fresh clone produced before this.

What none of it buys is `npm install -g <git url>`: npm does not install
dependencies before running a *global* package's `prepare`, so the build has
nothing to build with, and neither `--include=dev` nor moving Vite into
`dependencies` changes that. `npx` and `npm link` both work because both install
locally first. The real fix is publishing to npm, where the tarball carries the
bundle already built and `prepare` never runs on the installing machine.

`npm run build` type-checks before bundling, so a type error is a build failure
rather than something the bundler shrugs at.

## Repository layout

```
dsp/                 Rust DSP core (cdylib for wasm32, rlib for native tests)
  src/params.rs        parameter block layout — contract file
  src/fx/              per-track effect chain, one file per effect
  tests/verify.rs      determinism, aliasing, DC, click
  tests/footprint.rs   what init() allocates, measured
render/              native renderer: a render job -> WAV, no browser, no wasm.
                     Exists so a CLAP plugin can be hosted later; a .clap is a
                     dynamic library and cannot be loaded in a tab
web/
  public/worklet.js    AudioWorkletProcessor (plain JS, outside the bundler)
  src/shared/params.ts parameter block layout — contract file
  src/dsl/             fence extraction, YAML subset, parsing, surgical edits
  src/gui/             step sequencer and parameter panel
  src/audio/           AudioContext, wasm loading, worklet messaging
  src/audio/offline.ts the same scheduling without an AudioContext, for the
                       end-to-end test and `sheliak render`
  src/cli/             the `sheliak` command, over the same parser
  src/cli/serve.ts     a static server for the built app, plus the document
                       endpoint and its event stream
  src/docFile.ts       the document when it is a file, under `sheliak serve`
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
  messages, documentation, and the application's own interface — button labels,
  status lines, hints, and the document the editor opens with. Japanese
  translations live under `docs/ja/` and are a convenience, never the source of
  truth.
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
