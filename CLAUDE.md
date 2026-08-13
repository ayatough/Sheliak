See [AGENTS.md](AGENTS.md) for how to work in this repository: the
non-negotiables, the definition of done, where each layer's responsibility ends,
and how to split work across several agents without colliding.

Three things worth repeating here because they are easy to skip:

- **You cannot hear the output.** Run `cargo test --manifest-path dsp/Cargo.toml`
  — determinism, aliasing, DC and click checks are the substitute for ears — and
  then say plainly what you did not verify. Do not report an audible fix you have
  not heard.
- **`dsp/src/params.rs` and `web/src/shared/params.ts` are one file written
  twice.** Change both in the same commit or neither.
- **Run the full gate before saying you are done**: the Rust tests, clippy with
  `RUSTFLAGS="-D warnings"`, `./scripts/build-wasm.sh`, then `npm test` and
  `npm run build` in `web/`. The web suite loads the real wasm, so it only passes
  after the wasm build has run.
