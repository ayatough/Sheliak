#!/usr/bin/env bash
# Build the physically modelled piano as a native CLAP plugin.
#
# A `.clap` on Linux and Windows is the shared library under another name; on
# macOS it is a bundle directory with the dylib inside. The output lands in
# `piano/dist/` — copy it into a host's search path (`~/.clap` or
# `/usr/lib/clap` on Linux, `C:\Program Files\Common Files\CLAP` on Windows,
# `~/Library/Audio/Plug-Ins/CLAP` on macOS) or hand it to
# `sheliak-render --clap-instrument` directly.
#
#   ./scripts/build-piano-clap.sh             build for this machine
#   ./scripts/build-piano-clap.sh --windows   cross-build a Windows .clap
#
# --windows exists because "I develop in WSL, Reaper runs on Windows" is the
# common setup, and a WSL build without it produces a Linux binary that a
# Windows host cannot load — the scan just says "failed". It needs the
# mingw-w64 linker and the Rust target once:
#
#   sudo apt install mingw-w64
#   rustup target add x86_64-pc-windows-gnu
set -euo pipefail
cd "$(dirname "$0")/.."

dist="piano/dist"
mkdir -p "$dist"

if [ "${1:-}" = "--windows" ]; then
  rustup target list --installed | grep -q x86_64-pc-windows-gnu || {
    echo "missing Rust target — run: rustup target add x86_64-pc-windows-gnu" >&2
    exit 1
  }
  command -v x86_64-w64-mingw32-gcc > /dev/null || {
    echo "missing mingw-w64 linker — run: sudo apt install mingw-w64" >&2
    exit 1
  }
  cargo build --manifest-path piano/Cargo.toml --release --target x86_64-pc-windows-gnu
  cp piano/target/x86_64-pc-windows-gnu/release/sheliak_piano.dll "$dist/sheliak-piano.clap"
  echo "Windows build — copy to C:\\Program Files\\Common Files\\CLAP\\ and rescan."
  ls -la "$dist/sheliak-piano.clap"
  exit 0
fi

cargo build --manifest-path piano/Cargo.toml --release

case "$(uname -s)" in
  Darwin)
    bundle="$dist/Sheliak Piano.clap"
    mkdir -p "$bundle/Contents/MacOS"
    cp piano/target/release/libsheliak_piano.dylib "$bundle/Contents/MacOS/Sheliak Piano"
    cat > "$bundle/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>Sheliak Piano</string>
  <key>CFBundleIdentifier</key><string>io.github.ayatough.sheliak.piano</string>
  <key>CFBundleName</key><string>Sheliak Piano</string>
  <key>CFBundlePackageType</key><string>BNDL</string>
  <key>CFBundleVersion</key><string>0.1.0</string>
</dict>
</plist>
PLIST
    ls -la "$bundle/Contents/MacOS"
    ;;
  MINGW*|MSYS*|CYGWIN*)
    cp piano/target/release/sheliak_piano.dll "$dist/sheliak-piano.clap"
    ls -la "$dist/sheliak-piano.clap"
    ;;
  *)
    cp piano/target/release/libsheliak_piano.so "$dist/sheliak-piano.clap"
    ls -la "$dist/sheliak-piano.clap"
    ;;
esac
