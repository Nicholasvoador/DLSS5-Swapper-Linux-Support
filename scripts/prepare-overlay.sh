#!/usr/bin/env bash
# Linux twin of prepare-overlay.ps1: the same pinned compiler release and the
# same pinned ReShade / ImGui headers, so a Linux checkout builds the in-game
# add-on byte-for-byte from the same sources a Windows one does. Zig cross
# compiles the x86_64-windows add-on natively; nothing is installed system-wide
# and nothing unverified is ever executed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOOLS="$ROOT/tools"
SDK="$TOOLS/reshade-6.8.0"
mkdir -p "$TOOLS" "$SDK"

ZIG_VERSION=0.14.1
ZIG_DIR="$TOOLS/zig-x86_64-linux-$ZIG_VERSION"
ZIG_ARCHIVE="$TOOLS/zig-x86_64-linux-$ZIG_VERSION.tar.xz"
# From https://ziglang.org/download/index.json - the same index that lists the
# Windows archive digest prepare-overlay.ps1 pins (554f5378...).
ZIG_SHA256=24aeeec8af16c381934a6cd7d95c807a8cb2cf7df9fa40d359aa884195c4716c

if [ ! -x "$ZIG_DIR/zig" ]; then
  [ -f "$ZIG_ARCHIVE" ] || curl -sSfL -o "$ZIG_ARCHIVE" "https://ziglang.org/download/$ZIG_VERSION/zig-x86_64-linux-$ZIG_VERSION.tar.xz"
  if [ "$(sha256sum "$ZIG_ARCHIVE" | cut -d' ' -f1)" != "$ZIG_SHA256" ]; then
    rm -f "$ZIG_ARCHIVE"
    echo "Zig archive checksum mismatch. Nothing was executed." >&2
    exit 1
  fi
  tar -xJf "$ZIG_ARCHIVE" -C "$TOOLS"
fi

RESHADE_REV=18deaa52de0c425a78b329e9cb3c497281cd00ec
for h in reshade.hpp reshade_api.hpp reshade_api_device.hpp reshade_api_format.hpp reshade_api_pipeline.hpp reshade_api_resource.hpp reshade_events.hpp reshade_overlay.hpp; do
  curl -sSfL -o "$SDK/$h" "https://raw.githubusercontent.com/crosire/reshade/$RESHADE_REV/include/$h"
done
curl -sSfL -o "$SDK/LICENSE-ReShade.md" "https://raw.githubusercontent.com/crosire/reshade/$RESHADE_REV/LICENSE.md"

IMGUI_REV=3912b3d9a9c1b3f17431aebafd86d2f40ee6e59c
curl -sSfL -o "$SDK/imgui.h" "https://raw.githubusercontent.com/ocornut/imgui/$IMGUI_REV/imgui.h"
curl -sSfL -o "$SDK/imconfig.h" "https://raw.githubusercontent.com/ocornut/imgui/$IMGUI_REV/imconfig.h"
curl -sSfL -o "$SDK/LICENSE-ImGui.txt" "https://raw.githubusercontent.com/ocornut/imgui/$IMGUI_REV/LICENSE.txt"

echo "Portable compiler and pinned ReShade SDK ready in $TOOLS"
