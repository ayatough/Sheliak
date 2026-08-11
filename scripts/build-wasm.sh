#!/usr/bin/env bash
# Build the DSP core to wasm32 with SIMD and copy it into the web app.
set -euo pipefail
cd "$(dirname "$0")/.."

RUSTFLAGS="-C target-feature=+simd128" \
  cargo build --manifest-path dsp/Cargo.toml --release --target wasm32-unknown-unknown

mkdir -p web/public
cp dsp/target/wasm32-unknown-unknown/release/sheliak_dsp.wasm web/public/dsp.wasm
ls -la web/public/dsp.wasm
