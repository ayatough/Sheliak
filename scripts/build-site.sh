#!/usr/bin/env bash
# Build the app into a directory, for GitHub Pages.
#
#   ./scripts/build-site.sh site              # -> site/index.html, site/dsp.wasm ...
#   VITE_BASE=/Sheliak/next/ ./scripts/build-site.sh site/next
#
# One script, so the site CI publishes and the site you can build here are the
# same thing — and so that a *tag's* site can be built by checking that tag out
# and running its own copy of this file. `pages.yml` does exactly that.
#
# Environment:
#   VITE_BASE           where the site will be served from (default: /)
#   VITE_SITE_CHANNEL   `stable` or `dev`; `dev` marks the page a working copy
#                       and asks not to be indexed
#   VITE_SITE_VERSION   what to show as the version, e.g. `v0.1.0` or
#                       `v0.1.0 +3 · a1b2c3d`
set -euo pipefail
cd "$(dirname "$0")/.."

out=${1:-site}
case "$out" in
  /*) target=$out ;;
  *)  target=$PWD/$out ;;
esac

echo "building the site into $target (base ${VITE_BASE:-/}, channel ${VITE_SITE_CHANNEL:-none})"

./scripts/build-wasm.sh >/dev/null
# The WCLAP bundle ships with the app: a `plugin` fence naming one of Sheliak's
# own plugins is played in the browser, and cannot be without this.
./scripts/build-wclap.sh >/dev/null
(cd web && npm ci --no-audit --no-fund >/dev/null && npm run build >/dev/null)

# Cleared and rewritten, so a file dropped from the app does not linger in a
# published site. Anything nested under it goes too — which is why the root has
# to be built before `site/next`, never after.
rm -rf "$target"
mkdir -p "$target"
cp -R web/dist/. "$target/"

test -f "$target/index.html" || { echo "error: no index.html in $target" >&2; exit 1; }
test -f "$target/dsp.wasm" || { echo "error: no dsp.wasm in $target" >&2; exit 1; }
test -f "$target/wclap-host.js" || { echo "error: no wclap-host.js in $target" >&2; exit 1; }
test -f "$target/sheliak.wclap/module.wasm" || { echo "error: no sheliak.wclap in $target" >&2; exit 1; }
