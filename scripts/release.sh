#!/usr/bin/env bash
# Prepare a release. Edits files; pushes nothing, tags nothing.
#
#   ./scripts/release.sh 0.2.0
#
# The version is written down in six places and the changelog has to be closed,
# and getting one of them wrong produces a release whose `--version` disagrees
# with its own tag. This does all of it, then runs the gate, then prints the two
# commands that are left — which are the irreversible ones, and stay in a human's
# hands (see docs/releasing.md).
#
# Each edit is a no-op when it is already right, so nothing here compounds. The
# dirty-tree guard means a failed gate is fixed one of two ways: keep the edits
# and re-run just the gate, or `git checkout -- .` and run this again.
set -euo pipefail
cd "$(dirname "$0")/.."

version=${1:-}
if [ -z "$version" ]; then
  echo "usage: ./scripts/release.sh <version>   e.g. ./scripts/release.sh 0.2.0" >&2
  exit 1
fi
case "$version" in
  v*) echo "error: write the version without the leading v, e.g. 0.2.0" >&2; exit 1 ;;
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "error: '$version' is not a MAJOR.MINOR.PATCH version" >&2; exit 1 ;;
esac

# Refusals before edits: a half-prepared release in a dirty tree is harder to
# back out of than one that never started.
[ -z "$(git status --porcelain)" ] || { echo "error: the working tree has uncommitted changes" >&2; exit 1; }
branch=$(git rev-parse --abbrev-ref HEAD)
[ "$branch" = "main" ] || { echo "error: on branch '$branch'; releases are cut from main" >&2; exit 1; }
if git rev-parse -q --verify "refs/tags/v$version" >/dev/null; then
  echo "error: v$version is already tagged" >&2
  exit 1
fi

today=$(date -u +%Y-%m-%d)
echo "preparing v$version ($today)"

bump() { # file, sed expression
  local file=$1 expr=$2
  local before after
  before=$(cat "$file")
  after=$(printf '%s\n' "$before" | sed -E "$expr")
  if [ "$before" != "$after" ]; then
    printf '%s\n' "$after" > "$file"
    echo "  updated $file"
  fi
}

# The six places `check-versions.sh` compares. It is the check; this is the fix.
bump dsp/Cargo.toml       "0,/^version = \"[0-9]+\.[0-9]+\.[0-9]+\"/s//version = \"$version\"/"
bump package.json         "0,/\"version\": \"[0-9]+\.[0-9]+\.[0-9]+\"/s//\"version\": \"$version\"/"
bump web/package.json     "0,/\"version\": \"[0-9]+\.[0-9]+\.[0-9]+\"/s//\"version\": \"$version\"/"
bump README.md            "s/Sheliak is at \`v[0-9]+\.[0-9]+\.[0-9]+\`/Sheliak is at \`v$version\`/"
bump docs/roadmap.md      "s/Sheliak is at \`v[0-9]+\.[0-9]+\.[0-9]+\`/Sheliak is at \`v$version\`/"

# Cargo.lock records the crate's own version; `cargo update -p` rewrites it
# without touching anything else.
cargo update -p sheliak-dsp --manifest-path dsp/Cargo.toml --offline >/dev/null 2>&1 || true
echo "  updated dsp/Cargo.lock"

# Close the changelog: `## [Unreleased]` becomes this version, and a fresh
# empty `## [Unreleased]` takes its place for whatever lands next.
if grep -q "^## \[$version\]" CHANGELOG.md; then
  echo "  CHANGELOG.md already has a [$version] section"
else
  python3 - "$version" "$today" <<'PY'
import re
import sys

version, today = sys.argv[1], sys.argv[2]
path = 'CHANGELOG.md'
text = open(path).read()

# Anchored to the start of a line, and required to be the only such line: the
# preamble talks *about* `## [Unreleased]`, and a plain substring replace
# rewrote that sentence instead of the heading.
heading = re.compile(r'^## \[Unreleased\]$', re.M)
found = heading.findall(text)
if len(found) != 1:
    sys.exit(f'error: {path} has {len(found)} `## [Unreleased]` headings, expected exactly 1')

text = heading.sub(f'## [Unreleased]\n\n## [{version}] - {today}', text, count=1)
open(path, 'w').write(text)
print('  closed CHANGELOG.md [Unreleased] -> [%s]' % version)
PY
fi

echo
echo "checking every copy agrees"
./scripts/check-versions.sh

echo
echo "running the gate"
export RUSTFLAGS="-D warnings"
cargo fmt --manifest-path dsp/Cargo.toml --all -- --check
cargo clippy --manifest-path dsp/Cargo.toml --all-targets
cargo test --manifest-path dsp/Cargo.toml
./scripts/build-wasm.sh >/dev/null
(cd web && npm ci --no-audit --no-fund >/dev/null && npm test && npm run build >/dev/null)

cat <<EOF

v$version is prepared and the gate is green. Two steps are left, in this order —
the second one publishes, so read the first one's CI result first:

  git commit -am "Release v$version" && git push origin main
  # wait for CI to pass on that commit, then cut it, either way:
  git tag v$version && git push origin v$version   # if you can push tags
  gh workflow run release.yml -f publish=true      # if you cannot

Cutting it before CI finishes rebuilds the site's front page from the release
before last. docs/releasing.md says why.
EOF
