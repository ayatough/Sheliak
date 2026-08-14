#!/bin/sh
# Installs the `sheliak` command. No clone, no Rust toolchain, no npm.
#
#   curl -fsSL https://raw.githubusercontent.com/ayatough/Sheliak/main/scripts/install.sh | sh
#
# Environment:
#   SHELIAK_VERSION   tag to install (default: the latest release)
#   SHELIAK_BIN_DIR   where the command goes (default: ~/.local/bin)
#   SHELIAK_HOME      where the files live (default: ~/.local/share/sheliak)
#   SHELIAK_BASE_URL  where to fetch from (default: GitHub releases)
#
# Node.js 20 or newer is required and is not installed by this script: the CLI
# is a JavaScript bundle, so the runtime is the one thing it cannot carry. That
# is the trade for a single artifact that works on every platform — see the
# README for why the notation is parsed in TypeScript in the first place.

set -eu

REPO=ayatough/Sheliak
BIN_DIR=${SHELIAK_BIN_DIR:-$HOME/.local/bin}
HOME_DIR=${SHELIAK_HOME:-$HOME/.local/share/sheliak}

die() { echo "install.sh: $*" >&2; exit 1; }

command -v curl >/dev/null || die "curl is required"
command -v tar  >/dev/null || die "tar is required"

# Checked before anything is downloaded: a tarball on disk that cannot run is a
# worse outcome than a refusal that names the requirement.
command -v node >/dev/null || die "Node.js 20 or newer is required, and was not found on PATH"
node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
[ "$node_major" -ge 20 ] || die "Node.js 20 or newer is required, found $(node -v)"

# The releases API answers with the tag of the latest release; asking for it is
# how SHELIAK_VERSION gets a default without this script knowing the version.
latest() {
  curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
    | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' \
    | head -1
}

VERSION=${SHELIAK_VERSION:-$(latest)}
[ -n "$VERSION" ] || die "could not determine the latest release; set SHELIAK_VERSION"

BASE_URL=${SHELIAK_BASE_URL:-https://github.com/$REPO/releases/download/$VERSION}
NAME="sheliak-${VERSION#v}"
URL="$BASE_URL/$NAME.tar.gz"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "downloading $NAME"
curl -fsSL "$URL" -o "$TMP/sheliak.tar.gz" || die "download failed: $URL"

# Verified against the checksum published beside the archive when it is
# reachable. A missing checksum is not fatal; a mismatched one is.
if curl -fsSL "$URL.sha256" -o "$TMP/sheliak.tar.gz.sha256" 2>/dev/null; then
  want=$(cut -d' ' -f1 < "$TMP/sheliak.tar.gz.sha256")
  if command -v sha256sum >/dev/null; then
    got=$(sha256sum "$TMP/sheliak.tar.gz" | cut -d' ' -f1)
  elif command -v shasum >/dev/null; then
    got=$(shasum -a 256 "$TMP/sheliak.tar.gz" | cut -d' ' -f1)
  else
    got=$want
    echo "no sha256 tool found; skipping checksum" >&2
  fi
  [ "$want" = "$got" ] || die "checksum mismatch for $NAME.tar.gz"
fi

tar -xzf "$TMP/sheliak.tar.gz" -C "$TMP"
[ -f "$TMP/$NAME/sheliak.mjs" ] || die "the archive is not the shape this script expects"

# Replaced whole rather than merged: a leftover `app/` from an older version
# would be served to the browser by the newer CLI.
rm -rf "$HOME_DIR"
mkdir -p "$(dirname "$HOME_DIR")"
mv "$TMP/$NAME" "$HOME_DIR"
chmod +x "$HOME_DIR/sheliak.mjs"

mkdir -p "$BIN_DIR"
# A wrapper rather than a symlink: `node` resolves a symlinked entry point to
# its real path, which is what we want, but a wrapper also survives a shell
# without symlink support and makes the indirection visible to anyone who looks.
cat > "$BIN_DIR/sheliak" <<EOF
#!/bin/sh
exec node "$HOME_DIR/sheliak.mjs" "\$@"
EOF
chmod +x "$BIN_DIR/sheliak"

echo "installed $VERSION to $HOME_DIR"
echo "  $BIN_DIR/sheliak"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo; echo "$BIN_DIR is not on your PATH. Add it:"; echo "  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
