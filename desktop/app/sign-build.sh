#!/usr/bin/env bash
# Re-sign the release binary with the stable 'VibeExtract Dev' identity. Run
# this after every `cargo build --release` so the binary keeps the same CDHash
# and your macOS Accessibility / Screen-Recording grants survive the rebuild.
#
# First-time setup: run ./setup-codesign.sh once to create the identity.

set -euo pipefail

IDENTITY_NAME="VibeExtract Dev"
BINARY="$(dirname "$0")/src-tauri/target/release/vibe-extract-desktop"

if ! security find-certificate -c "$IDENTITY_NAME" >/dev/null 2>&1; then
  echo "Code-signing identity '$IDENTITY_NAME' not found."
  echo "Run ./setup-codesign.sh first."
  exit 1
fi

if [[ ! -f "$BINARY" ]]; then
  echo "Binary not found at $BINARY. Run 'cargo build --release' first."
  exit 1
fi

codesign --force --sign "$IDENTITY_NAME" --options runtime --timestamp=none "$BINARY"
echo "Signed. CDHash:"
codesign -dvvv "$BINARY" 2>&1 | grep 'CDHash'
