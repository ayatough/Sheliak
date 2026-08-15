#!/usr/bin/env bash
# Build Sheliak's own effects as a WCLAP bundle and put it where the app can
# fetch it.
#
# A WCLAP bundle is a directory holding `module.wasm`, so the output is
# `web/public/sheliak.wclap/module.wasm`. The build differs from
# `build-wasm.sh` in exactly one flag:
#
#   --export-table   exports the module's function table, which is how a
#                    browser host installs its own callbacks — a JS function
#                    cannot be called by wasm unless it is *in* the table, and
#                    the table cannot be reached unless it is exported.
#
# Everything else the draft asks for falls out of the target and the source:
# the module exports its own (unshared) memory, imports nothing, and exports
# `clap_entry` as a global holding the entry struct's address. `malloc`/`free`
# come from `wclap/src/alloc.rs`, because a host outside the module's address
# space cannot make room inside it.
set -euo pipefail
cd "$(dirname "$0")/.."

# +simd128 matches build-wasm.sh: the plugin and the engine should reach the
# same `tanh` on the same instruction set, so a difference between running an
# effect internally and running it as a plugin is not a build difference.
RUSTFLAGS="-C target-feature=+simd128 -C link-arg=--export-table -C link-arg=--growable-table" \
  cargo build --manifest-path wclap/Cargo.toml --release --target wasm32-unknown-unknown

bundle="web/public/sheliak.wclap"
mkdir -p "$bundle"
cp wclap/target/wasm32-unknown-unknown/release/sheliak_wclap.wasm "$bundle/module.wasm"
ls -la "$bundle/module.wasm"
