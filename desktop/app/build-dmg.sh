#!/usr/bin/env bash
# Build the distributable, self-signed VibeExtract .app + .dmg.
#
# Prereqs (one-time):
#   ./setup-codesign.sh         # creates the stable "VibeExtract Dev" identity
#   cargo install tauri-cli --version "^2.0" --locked
#
# tauri.conf.json already points bundle.macOS.signingIdentity at "VibeExtract Dev"
# and bundle.macOS.entitlements at entitlements.plist, so `cargo tauri build` signs
# the .app for us. This script runs the build, then locates + verifies the outputs.

set -euo pipefail
cd "$(dirname "$0")"

IDENTITY_NAME="VibeExtract Dev"
if ! security find-certificate -c "$IDENTITY_NAME" >/dev/null 2>&1; then
  echo "Signing identity '$IDENTITY_NAME' not found — run ./setup-codesign.sh first." >&2
  exit 1
fi

# The generated icon set (.icns/.ico/sized PNGs) is gitignored, so regenerate it
# from the committed source icon.png on every build (idempotent, ~1s).
echo "==> cargo tauri icon (regenerate icon set from icons/icon.png)"
cargo tauri icon src-tauri/icons/icon.png

echo "==> cargo tauri build (release; this takes a few minutes)"
cargo tauri build

BUNDLE_DIR="src-tauri/target/release/bundle"
APP=$(find "$BUNDLE_DIR/macos" -maxdepth 1 -name '*.app' 2>/dev/null | head -1)
DMG=$(find "$BUNDLE_DIR/dmg"   -maxdepth 1 -name '*.dmg' 2>/dev/null | head -1)

echo ""
echo "==> Outputs"
echo "    app: ${APP:-<none>}"
echo "    dmg: ${DMG:-<none>}"

if [[ -n "${APP:-}" ]]; then
  echo ""
  echo "==> Signature"
  codesign -dvvv "$APP" 2>&1 | grep -E 'Authority|Identifier|CDHash' | head -4
  echo "==> Verify"
  codesign --verify --deep --strict --verbose=2 "$APP" 2>&1 | tail -3 || true
fi

echo ""
echo "Distribute the .dmg. Devs: right-click → Open the first time (self-signed),"
echo "then grant Accessibility + Screen Recording (see ONBOARDING.md)."
