#!/usr/bin/env bash
# Plays a plugin track in a real browser and reports what came out.
#
#   ./scripts/check-worklet-plugin.sh
#
# Everything below the AudioWorklet is covered by `npm test`: the plugin against
# the engine (`wclap/tests/native.rs`), the host against the plugin
# (`wclap.test.ts`), and a whole document rendered through both
# (`pluginRack.test.ts`). What none of those touch is the worklet itself — the
# global scope shared between `wclap-host.js` and `worklet.js`, the message that
# carries the bundle across, and the audio thread actually calling a plugin.
#
# That needs a browser, so it is a script rather than a test: CI has no browser
# for the web app, and a test that silently skips everywhere is worse than a
# command a person runs when they touched the worklet. It renders offline
# (OfflineAudioContext) rather than to a speaker, so the result is a number.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "building…"
./scripts/build-wasm.sh >/dev/null
./scripts/build-wclap.sh >/dev/null
(cd web && npm run build:worklet-host >/dev/null && npx vite build >/dev/null)

# Playwright is not a dependency of this project — it is needed by this script
# and by the brand PNGs, and both are occasional.
if ! node -e "import('playwright')" >/dev/null 2>&1; then
  echo "this needs Playwright: npm i --no-save playwright" >&2
  echo "and a Chromium; set PLAYWRIGHT_CHROMIUM=<path> to use one already installed" >&2
  exit 2
fi

node scripts/check-worklet-plugin.mjs
