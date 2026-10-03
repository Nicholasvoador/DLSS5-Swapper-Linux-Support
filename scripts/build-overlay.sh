#!/usr/bin/env bash
# Linux twin of build-overlay.ps1. Same compiler, same flags, same outputs:
#   scripts/build-overlay.sh                 dist/overlay/dlss5-lab-overlay.addon64
#   scripts/build-overlay.sh --smoke         dist/overlay-smoke/  (LAB_OVERLAY_SMOKE)
#   scripts/build-overlay.sh --renodx-probe  dist/renodx-probe/   (LAB_RENODX_PROBE)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODE="${1:-}"
OVERLAY_PROFILE=dlss5-swapper
ZIG="$ROOT/tools/zig-x86_64-linux-0.14.1/zig"
SDK="$ROOT/tools/reshade-6.8.0"
if [ ! -x "$ZIG" ] || [ ! -f "$SDK/reshade.hpp" ]; then
  echo "Run scripts/prepare-overlay.sh first." >&2
  exit 1
fi

case "$MODE" in
  --renodx-probe) OUT="$ROOT/dist/renodx-probe"; EXTRA=(-DLAB_RENODX_PROBE -ladvapi32) ;;
  --smoke)        OUT="$ROOT/dist/overlay-smoke"; EXTRA=(-DLAB_OVERLAY_SMOKE) ;;
  "")             OUT="$ROOT/dist/overlay"; EXTRA=() ;;
  *) echo "unknown option: $MODE" >&2; exit 2 ;;
esac
mkdir -p "$OUT"
# The sources include <Windows.h>, as written for Windows' case-insensitive
# filesystem; the MinGW headers zig ships name it windows.h. A one-line
# forwarder keeps the sources identical for both build hosts.
SHIM="$ROOT/tools/case-shim"
mkdir -p "$SHIM"
printf '#pragma once\n#include <windows.h>\n' > "$SHIM/Windows.h"
export ZIG_GLOBAL_CACHE_DIR="$ROOT/tools/zig-cache"
export ZIG_LOCAL_CACHE_DIR="$ROOT/tools/zig-local-cache"

# The tiny ImVec2 return adapter, compiled with ReShade's MSVC ABI, no CRT.
"$ZIG" cc -target x86_64-windows-msvc -x c++ -std=c++17 -O2 -fno-exceptions -fno-rtti -nostdinc -nostdlib \
  -c "$ROOT/overlay/imgui-abi.cpp" -o "$OUT/imgui-abi.obj"

"$ZIG" c++ -target x86_64-windows-gnu -std=c++17 -O2 -shared -static -fms-extensions \
  -DWIN32_LEAN_AND_MEAN -DNOMINMAX "-DLAB_OVERLAY_PROFILE=$OVERLAY_PROFILE" -I "$SDK" -I "$SHIM" \
  "$ROOT/overlay/overlay.cpp" -o "$OUT/dlss5-lab-overlay.addon64" \
  "${EXTRA[@]}" "$OUT/imgui-abi.obj" -ladvapi32

cp "$SDK/LICENSE-ReShade.md" "$SDK/LICENSE-ImGui.txt" "$OUT/"
cp "$ROOT/overlay/README.md" "$ROOT/overlay/LICENSE" "$OUT/"
echo "Built $OUT/dlss5-lab-overlay.addon64 (SHA-256 $(sha256sum "$OUT/dlss5-lab-overlay.addon64" | cut -d' ' -f1))"
