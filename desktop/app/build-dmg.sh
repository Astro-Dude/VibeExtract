#!/usr/bin/env bash
# Build the distributable, self-signed VibeExtract .app + .dmg.
#
# Prereqs (one-time):
#   ./setup-codesign.sh         # creates the stable "VibeExtract Dev" identity
#   cargo install tauri-cli --version "^2.0" --locked
#
# IMPORTANT: `cargo tauri build` silently falls back to AD-HOC signing for this
# untrusted self-signed cert (Tauri's `security find-identity -p codesigning`
# doesn't list it). Ad-hoc ⇒ the designated requirement is a bare CDHash that
# changes every build ⇒ macOS re-prompts for Accessibility/Screen-Recording on
# every update. So we **re-sign the .app explicitly** with the cert (stable,
# cert-anchored DR ⇒ grants persist) and **repackage the .dmg from the signed
# app** so the airdrop artifact carries the cert signature.

set -euo pipefail
cd "$(dirname "$0")"

IDENTITY_NAME="VibeExtract Dev"
if ! security find-certificate -c "$IDENTITY_NAME" >/dev/null 2>&1; then
  echo "Signing identity '$IDENTITY_NAME' not found — run ./setup-codesign.sh first." >&2
  exit 1
fi

# Assemble the bundled /replicate-ui plugin marketplace from the canonical skills
# (resources/plugin/) so the shipped .app always carries the current plugin + MCP config.
echo "==> build-plugin.py (assemble the bundled /replicate-ui plugin)"
python3 "$(dirname "$0")/build-plugin.py"

# The generated icon set (.icns/.ico/sized PNGs) is gitignored, so regenerate it
# from the committed source icon.png on every build (idempotent, ~1s).
echo "==> cargo tauri icon (regenerate icon set from icons/icon.png)"
cargo tauri icon src-tauri/icons/icon.png

echo "==> cargo tauri build (release; this takes a few minutes)"
# Only bundle the .app. Tauri's built-in DMG (bundle_dmg.sh) runs a Finder-driven
# AppleScript to prettify the DMG window, which fails in non-GUI/automation
# environments. We repackage the .dmg ourselves below (plain hdiutil, no Finder),
# so Tauri's DMG would be discarded anyway — skip it to keep the build headless-safe.
cargo tauri build --bundles app

BUNDLE_DIR="src-tauri/target/release/bundle"
APP=$(find "$BUNDLE_DIR/macos" -maxdepth 1 -name '*.app' 2>/dev/null | head -1)
[ -n "${APP:-}" ] || { echo "ERROR: no .app produced under $BUNDLE_DIR/macos" >&2; exit 1; }

# --- Cert-sign the .app (Tauri's signingIdentity falls back to ad-hoc here) ----
echo "==> cert-sign the .app with '$IDENTITY_NAME'"
codesign --force --deep --options runtime --timestamp=none --sign "$IDENTITY_NAME" "$APP"
if codesign -dvvv "$APP" 2>&1 | grep -qi 'Signature=adhoc'; then
  echo "ERROR: .app is still ad-hoc after re-sign — cert-signing failed; grants would not persist." >&2
  exit 1
fi
echo "   signed:"
codesign -dvvv "$APP" 2>&1 | grep -E 'Authority=|Identifier=' | sed 's/^/     /'
codesign --verify --deep --strict "$APP" && echo "   signature valid ✓"

# --- Repackage the .dmg FROM the signed app (so the airdrop artifact is signed) -
echo "==> repackage .dmg from the signed app"
VER=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist" 2>/dev/null || echo 0.0.0)
ARCH=$(uname -m); [ "$ARCH" = "arm64" ] && ARCH="aarch64"
OUTDMG="$BUNDLE_DIR/dmg/Echo Desktop_${VER}_${ARCH}.dmg"
STAGE=$(mktemp -d)
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
mkdir -p "$BUNDLE_DIR/dmg"; rm -f "$OUTDMG"
hdiutil create -volname "Echo Desktop" -srcfolder "$STAGE" -ov -format UDZO "$OUTDMG" >/dev/null
rm -rf "$STAGE"
codesign --force --sign "$IDENTITY_NAME" "$OUTDMG" 2>/dev/null || true

echo ""
echo "==> Outputs"
echo "    app: $APP"
echo "    dmg: $OUTDMG   (cert-signed, airdrop this)"
echo ""
echo "Airdrop the .dmg → recipient: right-click → Open once (self-signed) → grant"
echo "Accessibility + Screen Recording → restart Claude Code → /replicate-ui."
echo "(The app self-installs the skill + registers MCP on first launch.)"
