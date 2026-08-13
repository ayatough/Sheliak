Thanks for this. Two questions before the diff, from
[CONTRIBUTING.md](../CONTRIBUTING.md):

- **Is there an issue for it?** Small fixes need none. Anything with a design
  decision in it — new notation, a new DSL field, a change to the parameter
  layout — should have been discussed first, because the notation is the part
  that is expensive to get wrong.
- **Does the gate pass?** `cargo test --manifest-path dsp/Cargo.toml`, clippy and
  `cargo fmt --check` on the same crate, then `./scripts/build-wasm.sh` and
  `npm ci && npm test && npm run build` in `web/`. The web suite loads the real
  wasm, so it only passes after the wasm build has run.

**What this changes, and why.** The why is the part that is hard to recover
later; the diff already says the what.

**How you know it works.** Not which tests exist — what you did to convince
yourself. If it is audible, say what you listened to, or say plainly that you did
not listen.
