#!/usr/bin/env bash
# Renders one document both ways and reports how far apart the results are.
#
#   ./scripts/check-render-parity.sh song.md
#
# The two renderers drive the same engine through the same ABI — `sheliak
# render` loads `dsp.wasm` into Node, `sheliak-render` links the crate natively
# — so any difference is the two *builds* of the DSP core disagreeing, not the
# two renderers. That is worth measuring rather than assuming, because
# "determinism" in this project means the document and the seed decide the
# audio, and a renderer that quietly disagreed with the browser would make a
# rendered preview a different song from the one anybody heard.
#
# What it does not do is fail on a difference. The two builds are not expected
# to be bit-identical: the wasm one is compiled with `+simd128` and reaches a
# different libm for `tanh`, `exp` and `sin`, so effects that use them can land
# on the far side of a rounding boundary. The measurement that matters is *how
# far* — see docs/workstreams.md §9. This prints it; a human decides.
set -euo pipefail

doc="${1:-}"
if [[ -z "$doc" ]]; then
  echo "usage: $0 <song.md> [render args...]" >&2
  exit 2
fi
shift || true

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "building the native renderer..."
cargo build --manifest-path "$root/render/Cargo.toml" --release >/dev/null

echo "rendering through wasm (the canonical path)..."
"$root/scripts/sheliak" render "$doc" -o "$work/wasm.wav" "$@" >/dev/null

echo "emitting the render job..."
"$root/scripts/sheliak" render "$doc" --emit-job "$work/job.json" "$@" >/dev/null

echo "rendering natively..."
"$root/render/target/release/sheliak-render" "$work/job.json" -o "$work/native.wav" >/dev/null

if cmp -s "$work/wasm.wav" "$work/native.wav"; then
  echo
  echo "identical: the two builds agree bit for bit."
  exit 0
fi

echo
python3 - "$work/wasm.wav" "$work/native.wav" <<'PY'
import math
import struct
import sys
import wave


def samples(path):
    with wave.open(path) as w:
        return struct.unpack(f"<{w.getnframes() * w.getnchannels()}h", w.readframes(w.getnframes()))


a, b = samples(sys.argv[1]), samples(sys.argv[2])
if len(a) != len(b):
    print(f"different lengths: {len(a)} vs {len(b)} samples — that is a real bug, not rounding")
    sys.exit(1)

diffs = [abs(x - y) for x, y in zip(a, b) if x != y]
worst = max(diffs)
print(f"{len(diffs)} of {len(a)} samples differ ({100 * len(diffs) / len(a):.1f}%)")
print(f"largest difference: {worst} LSB at 16 bits = {20 * math.log10(worst / 32768):.1f} dBFS")
if worst > 1:
    print()
    print("MORE THAN ONE LSB. That is past what a rounding boundary explains;")
    print("something in the two builds is computing a different number.")
    sys.exit(1)
print()
print("Every difference is a single least-significant bit: the two builds agree")
print("to within one 16-bit quantisation step, which is what floating point")
print("landing either side of a rounding boundary looks like.")
PY
