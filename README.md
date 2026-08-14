<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/brand/sheliak-banner-dark.svg">
  <img alt="Sheliak — songs that live in your repository" src="assets/brand/sheliak-banner-light.svg">
</picture>

# Sheliak

**Songs that live in your repository.** Write synth patches and note data in
Markdown code fences, and a Rust DSP core compiled to WebAssembly plays them in
the browser — hot-reloading as you type, and rendering the same samples on every
machine.

> Sheliak (β Lyrae) — from the Arabic name for the lyre, an instrument first
> strung across a tortoise shell.

**▶ [Play it in the browser](https://ayatough.github.io/Sheliak/)** — no install,
no account. It publishes from `main` after CI goes green, so the page is whatever
last passed the gate.

[Syntax](docs/syntax.md) · [Architecture](docs/architecture.md) · [Development](docs/development.md) · [Roadmap](docs/roadmap.md) · [Workstreams](docs/workstreams.md) · [Contributing](CONTRIBUTING.md) · [Agents](AGENTS.md) · [Brand](assets/brand/README.md) · [日本語](docs/ja/README.md)

<a href="https://www.buymeacoffee.com/qython" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-violet.png" alt="Buy Me a Coffee" style="height: 60px !important;width: 217px !important;" ></a>

---

## Why

Music tools make you choose. A DAW gives you control but stores the result as an
opaque project file: you cannot diff it, cannot merge it, cannot review it, and
cannot see why a setting is what it is. Text-based music languages are diffable,
but they are *programs* — the state lives in an interpreter, and a knob you turn
in a GUI has nowhere to go back to.

Sheliak is an attempt at both. The document is the entire state, declaratively:
no hidden model, no binary but the source material. So a song is something you
can put under version control, open a pull request against, and hand to a
colleague — or an agent — as plain text.

````markdown
```synth id=lead seed=42
osc:
  - { table: basic/saw,    level: -3dB, morph: 0%,  unison: 5, detune: 18c, spread: 80% }
  - { table: basic/square, level: -12dB, morph: 30%, tune: -12st }

filter: { type: lp12, cutoff: 900Hz, res: 0.28, drive: 0.15, key_track: 40% }

env:
  amp:    { a: 8ms, d: 220ms, s: 65%, r: 180ms }
  filter: { a: 2ms, d: 380ms, s: 10%, r: 140ms }

mod:
  - { from: env.filter, to: filter.cutoff, amount: +2600c }

fx:
  - { type: reverb, size: 65%, damp: 55%, mix: 16% }
```

```phrase id=verse-lead key=C scale=minor res=1/16 bars=1
grid:
  #     1...2...3...4...
  5'   |o-------........|
  b3'  |o-------........|
  1'   |o-------........|

detail:
  1.1o : { roll: +9ms }
```

```loop id=groove bars=1 bpm=126
lead: verse-lead
kick: four-floor
```
````

Every value carries a unit, because confusing milliseconds with seconds is the
kind of mistake a notation should make impossible. A bare number is a parse
error. In a phrase grid a row is a pitch and a column is a cell of time, so a
line has a shape you can read; the `detail:` block addresses expression by
coordinate rather than crowding the grid.

## How it works

```
Markdown editor (TypeScript)
        |  fenced code block extraction
        v
DSL parser (TypeScript)      syntax errors, unit validation, defaults
        |  normalized Patch IR -> flat f32 parameter block
        v  postMessage
AudioWorkletProcessor        sample-accurate event dispatch
        |
        v
DSP core (Rust -> wasm32)    audio only; knows nothing about the notation
        |
        v
    Float32Array (L/R)
```

The split is the point. The DSP core takes a flat block of normalized parameters
and note events and nothing else, so the notation can change freely and the core
can be reused in a native plugin later. Unit conversion, defaults and musical time
all happen on the TypeScript side.

## Features

| | |
|---|---|
| **Markdown is the project file** | Patches and notes in code fences; the document is the whole of the state |
| **Hot reload without stopping** | Edits recompile after 150 ms and apply while the transport runs |
| **Errors do not silence you** | A fence that fails to parse keeps playing its last valid patch, with the error reported by line and column |
| **A wavetable engine** | Six tables, FFT mipmaps per octave, Hermite interpolation, fixed-point phase |
| **Two oscillators and unison** | Up to 7 unison voices with detune and stereo spread, per oscillator |
| **Filter, envelopes, LFO, modulation** | TPT state-variable filter in four modes, two exponential ADSRs, an LFO, and an 8-slot modulation matrix |
| **Noise** | Seeded white or pink noise mixed in before the filter |
| **A master effect chain** | Distortion, EQ, chorus, phaser, flanger, delay, reverb and a 3-band compressor, in the order you write them |
| **Eight tracks** | One per `synth` fence, each with its own voices and effects |
| **A GUI that writes text** | The step sequencer and parameter panel edit the document itself, one token at a time, leaving comments and alignment untouched |
| **A CLI** | `sheliak new` starts a song, `sheliak check` reads one back — every error by line and column, and an exit code CI can gate on |
| **Bit-identical renders** | Same document, same seed, same samples — enforced by an offline test |
| **No binary but the source material** | Wavetables are generated procedurally; nothing about a song is opaque |

## Build and run

Rust with the `wasm32-unknown-unknown` target, and Node.js 20 or newer.

```bash
git clone https://github.com/ayatough/Sheliak
cd Sheliak

./scripts/build-wasm.sh     # DSP core -> web/public/dsp.wasm
cd web
npm install
npm run dev                 # development server
npm run build               # production build
```

The sound is in a browser: there is no native player yet. The published build is
at **<https://ayatough.github.io/Sheliak/>**, deployed by
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) once CI has passed
on `main`. See [docs/development.md](docs/development.md) for the full guide.

## The CLI

`sheliak` starts a song and reads one back without opening anything. No clone
and no Rust toolchain — Node.js 20 or newer is the only requirement:

```bash
npx github:ayatough/Sheliak new song.md      # the smallest song that makes a sound
npx github:ayatough/Sheliak check song.md    # every error, by line and column
```

For `sheliak` as a command that stays, link it from a working copy:

```bash
git clone https://github.com/ayatough/Sheliak && cd Sheliak
npm install && npm link      # `sheliak` on your PATH, built as it installs
```

`npm install -g <git url>` is the one way in that does **not** work, and it is
worth saying why: npm does not install a package's dependencies before running
its `prepare` when the install is global, and the CLI is bundled by `prepare`.
Publishing to npm is what fixes that — the registry tarball ships the bundle
already built — and that is a job for the first release, which has not happened.

It is a Node program rather than a second binary beside the DSP core, because
the notation is parsed in TypeScript and the Rust side does not know the DSL — a
second parser would be a second copy of the contract to keep in step. The cost
of that is this: there is no single self-contained executable to `curl` yet, so
the machine running `sheliak` needs Node the way the machine running the app
needs a browser.

`new` writes one `synth` fence, one `phrase` and the `loop` that binds them —
short enough to read in full, so that everything left out is visibly taking a
default. `--empty` writes a blank file instead, and neither ever overwrites a
file that is already there.

`check` compiles the document exactly as the browser does and exits non-zero on
any error, so a repository of songs can be gated in CI the way a repository of
code is. It also reports the two things compiling cannot call an error, because
both are legal and both are silent — a track no loop line binds, and a phrase
nothing plays:

```
song.md — 2 tracks of 3 · 4 phrases · 126bpm · 1 bar
  song.md:12:32  error    bare numbers are not allowed for "level" — expected a gain in dB (e.g. -6dB)
  song.md:41:1   warning  phrase `bridge` is never bound by a loop line, so it never plays
```

`--strict` fails on the warnings too, and `--format json` emits the same run as
records for something that is going to act on them rather than read them.

From a working copy, `./scripts/sheliak` runs the same commands against the
sources you are editing, rebuilding the bundle whenever it is out of date — so a
clone never checks a song against a stale copy of the checker.

## Test

```bash
cargo test --manifest-path dsp/Cargo.toml   # determinism, aliasing, DC, clicks
cd web && npm test                          # parser and GUI, plus a wasm end-to-end test
```

The Rust suite runs on the native target, not on wasm — the crate is built as
both a `cdylib` and an `rlib` so the DSP can be verified offline, which is how
audio bugs are found here rather than by listening. The web suite loads the real
`dsp.wasm`, so run `./scripts/build-wasm.sh` first.

## Status

Sheliak is at `v0.1.0`. **Nothing has been released yet** — there is no tag, and
`main` is what exists. It is `0.x` and pre-release: the notation will keep
changing.

- **Working:** the `synth`, `phrase` and `loop` fences, hot reload, eight tracks,
  the wavetable engine, filter, envelopes, LFO, modulation matrix, noise, the
  eight-effect master chain, the two-way-synced step sequencer and parameter
  panel, `sheliak new` and `sheliak check`, offline verification, and a GitHub
  Pages deployment
- **Next:** the note-event ABI (Track B of
  [docs/workstreams.md](docs/workstreams.md)) — `note_on` gains a glide time and
  a legato flag, which is what makes a written `gliss` actually slide
- **After that:** frontmatter as a song header, headings as arrangement sections,
  and hierarchical automation. See the [roadmap](docs/roadmap.md)

## How this repository is developed

**`main` is the working branch, not a stable one.** Development happens on it
directly: this is a single author working with an AI assistant, so a pull request
has no second reader to wait for, and holding changes on a branch only delays the
one review that does happen — opening the deployed app and pressing play.

The gate still runs on every push: the Rust tests, clippy, formatting, the wasm
build, the TypeScript type check and the web suite, on `main` as well as on pull
requests. `main` being the working branch does not mean it is allowed to be
broken — it means it is allowed to change under you.

What that means if you are using Sheliak:

- **Depend on a release, not on `main`** — once there are releases. Until then,
  pin a commit.
- **Bug reports against `main` are welcome**; say which commit, since there may
  not be a version number to name.

Contributions still go through pull requests — see
[CONTRIBUTING.md](CONTRIBUTING.md). The direct-push policy is about the author's
own commits, not a closed door.

## Contributing

**Bug reports and feature requests are very welcome** — a song is a text file, so
a bug report can usually be the song. For code, please read
[CONTRIBUTING.md](CONTRIBUTING.md) first: small fixes are fine to send straight
in, but anything with a design decision in it wants an issue first, because the
notation is the expensive part to get wrong.

## Brand

The logo, icon and social artwork live in [assets/brand/](assets/brand/README.md),
along with the palette and the rules for using them. They are generated by
`scripts/build-brand.mjs` rather than drawn by hand, so the mark cannot drift
between the eight files it appears in — edit the script and re-run it.

## License

MIT. See [LICENSE](LICENSE).
