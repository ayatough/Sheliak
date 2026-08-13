# Contributing

Thank you for looking. Please read this before opening a pull request — the
answer for issues and the answer for code are deliberately different here.

## Issues: yes, please

**Bug reports, questions and feature requests are all welcome**, and they are the
most useful thing you can send. A patch that sounds wrong, a piece of notation
that surprised you, a phrase that will not play on your phone: those are hard to
find from the inside.

Include the Markdown that reproduces it. A song is a text file, so a bug report
can usually *be* the song — paste the fences and say what you expected to hear.
For audio bugs, the browser and OS matter, because audio dropouts and worklet
loading differ between them.

## Pull requests: open an issue first

Not because contributions are unwelcome — because of how this repository is
written.

Sheliak is built by a single author working with an AI assistant, and that shows
in the code: comments explain *why* a thing is the way it is rather than what it
does, the DSP core is verified offline rather than by listening, and the notation
is treated as the expensive part. It is a consistent style, and consistency is
most of what makes a small codebase readable. A patch that is perfectly good on
its own terms can still cost more to absorb than it saves.

So:

- **A fix under about twenty lines** — a typo, a wrong path, an off-by-one, a
  broken link — just send it. Please match the surrounding style.
- **Anything with a design decision in it** — new notation, a new DSL field, a
  change to the parameter layout — **open an issue first** and describe what you
  want to be able to write in a song. Notation is the part that is expensive to
  get wrong, because every song written against it becomes a thing that must keep
  playing.

An issue costs you far less than a rejected pull request does, and the answer may
be "yes, and here is the shape it should take", which is worth having before you
write anything.

**Branch from `main`, but expect it to move.** The author commits to `main`
directly — see [How this repository is
developed](README.md#how-this-repository-is-developed) — so it is the working
branch rather than a stable one. Rebase before you open a pull request. Your
changes still come in as pull requests; the direct-push policy covers the
author's own commits only.

## The bar

Everything below runs in CI on every push, and a pull request is expected to pass
all of it:

```bash
cargo test --manifest-path dsp/Cargo.toml
cargo clippy --manifest-path dsp/Cargo.toml --all-targets   # with RUSTFLAGS="-D warnings"
cargo fmt --manifest-path dsp/Cargo.toml --all -- --check
./scripts/build-wasm.sh
cd web && npm ci && npm test && npm run build
```

Three of these are unusual and worth knowing about before you start:

- **`dsp/tests/verify.rs`** is the project's substitute for listening. It renders
  the engine offline on the native target and checks determinism (the same patch
  and seed twice, byte for byte), aliasing, DC offset and clicks. If you change
  DSP, ask which of those four your change could break.
- **`web/src/integration.test.ts`** loads the real `dsp.wasm`, so it fails until
  `./scripts/build-wasm.sh` has run. It is the only thing that catches a
  disagreement between `dsp/src/params.rs` and `web/src/shared/params.ts`.
- **`npm run build` type-checks first** (`tsc --noEmit`), so a type error is a
  build failure rather than something the bundler shrugs at.

[AGENTS.md](AGENTS.md) is the fuller version of the working agreement: the
non-negotiables, where each layer's responsibility ends, and what "done" means. It
is written for coding agents, but it is the same bar for everyone, and it is the
most accurate description of the house style there is.

[docs/development.md](docs/development.md) covers the build, the layout and the
versioning policy.

## What is planned

[docs/workstreams.md](docs/workstreams.md) is the plan of record. Each stream is a
brief with the reasoning behind it, not just a title — if you want to know why
something is the way it is, or what is coming, that is the file to read.

Issues are the inbox; the workstreams file is what has been accepted and thought
through. An issue that turns into work becomes a stream there.
