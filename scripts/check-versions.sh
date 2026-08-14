#!/usr/bin/env bash
# Every place the version is written down has to agree with the manifest.
#
#   ./scripts/check-versions.sh
#
# The number lives in several files and nothing but somebody's memory keeps them
# in step — a drift no test can see, because nothing is broken, only untrue. This
# is that memory, run in CI.
#
# Exits non-zero naming every file that disagrees.
set -euo pipefail

cd "$(dirname "$0")/.."

# dsp/Cargo.toml is the manifest: the first `version` line in [package].
manifest=$(grep -m1 '^version' dsp/Cargo.toml | cut -d'"' -f2)

lock=$(awk '/^name = "sheliak-dsp"$/{found=1; next} found && /^version = /{print; exit}' \
  dsp/Cargo.lock | cut -d'"' -f2)

pkg=$(grep -m1 '"version"' web/package.json | cut -d'"' -f4)

# The root manifest exists only so `npm i -g <this repo>` has something to
# install; it carries a version because npm requires one, which makes it one
# more copy to keep honest.
root_pkg=$(grep -m1 '"version"' package.json | cut -d'"' -f4)

# The topmost *released* heading. `[Unreleased]` sits above it and is skipped by
# requiring a digit, so this is the version the changelog last closed. Empty
# until the first release, which is not a disagreement — it is a project that
# has not shipped yet.
changelog=$(grep -m1 -E '^## \[[0-9]' CHANGELOG.md | sed -E 's/^## \[([^]]+)\].*/\1/' || true)

status_line() { # file -> the version its status sentence claims
  grep -m1 -oE 'Sheliak is at `v[0-9]+\.[0-9]+\.[0-9]+`' "$1" \
    | sed -E 's/^Sheliak is at `v([^`]+)`/\1/'
}
readme=$(status_line README.md || true)
roadmap=$(status_line docs/roadmap.md || true)

fail=0
report() { # label, found
  if [ "$2" = "$manifest" ]; then
    printf '  ok    %-24s %s\n' "$1" "$2"
  else
    printf '  FAIL  %-24s %s (expected %s)\n' "$1" "${2:-<not found>}" "$manifest"
    fail=1
  fi
}

echo "manifest (dsp/Cargo.toml): $manifest"
report 'dsp/Cargo.lock' "$lock"
report 'package.json' "$root_pkg"
report 'web/package.json' "$pkg"
report 'README.md' "$readme"
report 'docs/roadmap.md' "$roadmap"

# The root manifest bundles the CLI itself rather than shelling out to the web
# package — npm-inside-npm inherits `--global` from the install that triggered
# it, which is how a global install ends up trying to install the package into
# itself. The cost is that Vite is named in two manifests, and nothing but this
# keeps the two ranges the same.
root_vite=$(grep -m1 '"vite": "' package.json | cut -d'"' -f4)
web_vite=$(grep -m1 '"vite": "' web/package.json | cut -d'"' -f4)
if [ "$root_vite" = "$web_vite" ]; then
  printf '  ok    %-24s %s\n' 'vite range (both)' "$root_vite"
else
  printf '  FAIL  %-24s %s (web/package.json has %s)\n' 'vite range' "$root_vite" "$web_vite"
  fail=1
fi

if [ -z "$changelog" ]; then
  printf '  skip  %-24s no released section yet\n' 'CHANGELOG.md'
else
  report 'CHANGELOG.md' "$changelog"
fi

exit "$fail"
