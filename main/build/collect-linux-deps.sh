#!/usr/bin/env bash
# Collect Linux binary dependencies for AppImage bundling.
#
# Copies ydotool, ydotoold, wl-copy, and wl-paste (plus their shared
# library deps) into build/linux-bin/ so electron-builder can pack them
# into the AppImage via extraFiles.
#
# Run this BEFORE `npm run package`:
#   cd main && bash build/collect-linux-deps.sh
#
# Requires: ydotool wl-clipboard installed on the build system.
#   sudo pacman -S ydotool wl-clipboard

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$SCRIPT_DIR/linux-bin"

rm -rf "$DEST"
mkdir -p "$DEST/lib"

BINARIES=(ydotool ydotoold wl-copy wl-paste)
MISSING=()

for bin in "${BINARIES[@]}"; do
    src="$(command -v "$bin" 2>/dev/null || true)"
    if [ -z "$src" ]; then
        MISSING+=("$bin")
        continue
    fi
    echo "Copying $src"
    cp "$src" "$DEST/"

    # Copy shared library dependencies (skip vdso and ld-linux)
    ldd "$src" 2>/dev/null | grep "=> /" | awk '{print $3}' | while read -r lib; do
        basename_lib="$(basename "$lib")"
        if [ ! -f "$DEST/lib/$basename_lib" ]; then
            echo "  lib: $basename_lib"
            cp "$lib" "$DEST/lib/"
        fi
    done
done

if [ ${#MISSING[@]} -gt 0 ]; then
    echo ""
    echo "ERROR: The following binaries were not found:"
    for m in "${MISSING[@]}"; do
        echo "  - $m"
    done
    echo ""
    echo "Install them with: sudo pacman -S ydotool wl-clipboard"
    exit 1
fi

# Make all binaries executable
chmod +x "$DEST"/ydotool "$DEST"/ydotoold "$DEST"/wl-copy "$DEST"/wl-paste

echo ""
echo "Done. Binaries collected in $DEST"
ls -lh "$DEST"
echo ""
echo "Libraries:"
ls -lh "$DEST/lib/" | head -20
