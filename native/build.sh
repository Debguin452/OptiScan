#!/bin/sh
# OptiScan Pro — Native Build Script
# =====================================
# Compiles sharpness.c → WebAssembly (sharpness.wasm)
# Compiles optiscan_cli.cpp → native binary
#
# Requirements:
#   Wasm:  emscripten (emcc) OR wasi-sdk (clang with wasm32-wasi target)
#   CLI:   g++ with C++17 support
#
# Usage:
#   ./build.sh              # build both
#   ./build.sh --wasm-only  # only wasm
#   ./build.sh --cli-only   # only native CLI

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="$SCRIPT_DIR/../"

echo "=== OptiScan Pro — Native Build ==="

build_wasm_emcc() {
    echo "[WASM] Compiling with emscripten..."
    emcc "$SCRIPT_DIR/sharpness.c" \
        -O3 \
        -msimd128 \
        -ffast-math \
        -s WASM=1 \
        -s EXPORTED_FUNCTIONS='["_compute_sharpness","_kalman_reset","_kalman_update","_parabolic_peak_dist","_dominant_axis_deg","_alloc","_free_all"]' \
        -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap"]' \
        -s ALLOW_MEMORY_GROWTH=1 \
        -s INITIAL_MEMORY=16777216 \
        -s STANDALONE_WASM=0 \
        --no-entry \
        -o "$OUT_DIR/sharpness.wasm"
    echo "[WASM] Output: $OUT_DIR/sharpness.wasm"
}

build_wasm_clang() {
    echo "[WASM] Compiling with clang/wasi..."

    clang \
        --target=wasm32-wasi \
        --sysroot=$PREFIX/share/wasi-sysroot \
        -O3 \
        -ffast-math \
        -msimd128 \
        -Wl,--export=compute_sharpness \
        -Wl,--export=kalman_reset \
        -Wl,--export=kalman_update \
        -Wl,--export=parabolic_peak_dist \
        -Wl,--export=dominant_axis_deg \
        -Wl,--export=alloc \
        -Wl,--export=free_all \
        -Wl,--no-entry \
        "$SCRIPT_DIR/sharpness.c" \
        -o "$OUT_DIR/sharpness.wasm"

    echo "[WASM] Output: $OUT_DIR/sharpness.wasm"
}

build_wasm() {
    if command -v emcc > /dev/null 2>&1; then
        build_wasm_emcc
    elif command -v clang > /dev/null 2>&1; then
        build_wasm_clang
    else
        echo "[WASM] SKIP — neither emcc nor clang found."
        echo "  Install emscripten: https://emscripten.org/docs/getting_started/downloads.html"
        echo "  Or wasi-sdk:        https://github.com/WebAssembly/wasi-sdk/releases"
        return 1
    fi
}

build_cli() {
    echo "[CLI] Compiling optiscan_cli.cpp..."
    g++ -O3 -march=native -std=c++17 \
        -ffast-math \
        "$SCRIPT_DIR/optiscan_cli.cpp" \
        -o "$SCRIPT_DIR/optiscan_cli" \
        -lm
    echo "[CLI] Output: $SCRIPT_DIR/optiscan_cli"
    echo "[CLI] Usage:"
    echo "       $SCRIPT_DIR/optiscan_cli --ref ref.pgm --lens lens1.pgm lens2.pgm ..."
    echo "       ffmpeg -i video.mp4 -vf fps=5 frame_%04d.pgm"
}

# Parse args
WASM_ONLY=0
CLI_ONLY=0
for arg in "$@"; do
    case "$arg" in
        --wasm-only) WASM_ONLY=1 ;;
        --cli-only)  CLI_ONLY=1  ;;
    esac
done

if [ "$CLI_ONLY" = "0" ]; then build_wasm || true; fi
if [ "$WASM_ONLY" = "0" ]; then build_cli; fi

echo ""
echo "=== Build complete ==="
echo "Place sharpness.wasm alongside index.html for browser use."
echo "Run optiscan_cli --help for CLI usage."
