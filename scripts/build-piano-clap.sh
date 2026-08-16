#!/usr/bin/env bash
# Build the physically modelled piano as a native CLAP plugin.
#
# A `.clap` on Linux and Windows is the shared library under another name; on
# macOS it is a bundle directory with the dylib inside. The output lands in
# `piano/dist/` — copy it into a host's search path (`~/.clap`,
# `/usr/lib/clap`, or wherever `CLAP_PATH` points) or hand it to
# `sheliak-render --clap-instrument` directly.
set -euo pipefail
cd "$(dirname "$0")/.."

cargo build --manifest-path piano/Cargo.toml --release

dist="piano/dist"
mkdir -p "$dist"

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
