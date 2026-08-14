#!/usr/bin/env bash
# Assemble the release tarball.
#
#   ./scripts/build-release.sh [version]
#
# One artifact for every platform, because nothing in it is platform-specific:
# the CLI is a JavaScript bundle, `dsp.wasm` is wasm, and the app is static
# files. That is the whole argument for shipping a Node program rather than a
# native binary — a matrix of four targets, each only as tested as the machine
# that built it, collapses into one file.
#
# CI runs exactly this script, so a tarball built here and one built by
# `release.yml` differ only in the version they are told.
set -euo pipefail
cd "$(dirname "$0")/.."

version=${1:-$(grep -m1 '"version"' package.json | cut -d'"' -f4)}
name="sheliak-${version}"
out="dist-release"

echo "building $name"

./scripts/build-wasm.sh >/dev/null
(cd web && npm run build >/dev/null && npm run build:cli >/dev/null)

rm -rf "$out"
mkdir -p "$out/$name"

# The layout the CLI resolves against: the bundle, with the built app beside it
# in `app/`. `dsp.wasm` is inside the app because Vite copies `public/` there,
# and `render` reads that same copy rather than a second one — one file, so
# there is no way for the page and the renderer to disagree about the engine.
cp web/dist-cli/sheliak.mjs "$out/$name/sheliak.mjs"
chmod +x "$out/$name/sheliak.mjs"
cp -R web/dist "$out/$name/app"
cp README.md LICENSE "$out/$name/"

test -f "$out/$name/app/dsp.wasm" || { echo "error: app/dsp.wasm missing" >&2; exit 1; }
test -f "$out/$name/app/index.html" || { echo "error: app/index.html missing" >&2; exit 1; }

tar -czf "$out/$name.tar.gz" -C "$out" "$name"
(cd "$out" && sha256sum "$name.tar.gz" > "$name.tar.gz.sha256")
rm -rf "${out:?}/${name:?}"

ls -la "$out"
