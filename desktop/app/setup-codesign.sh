#!/usr/bin/env bash
# Create a stable self-signed code-signing identity in the login keychain and
# then re-sign the dev binary with it. macOS keys Accessibility/Screen-Recording
# permission by the binary's CDHash, which changes on every cargo build (ad-hoc
# signing uses a random UUID). With a stable identity, the CDHash is the same
# across rebuilds and the TCC grant survives.
#
# Run this once. After that, every rebuild followed by `./sign-build.sh` will
# preserve the user's permission grant.
#
# This is the same approach Desktop_Pluck uses (see its setup-codesign.sh /
# build.sh in https://github.com/superover-googly/Desktop_Pluck).

set -euo pipefail

IDENTITY_NAME="VibeExtract Dev"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

# 1. If the identity already exists, do nothing.
if security find-certificate -c "$IDENTITY_NAME" "$KEYCHAIN" >/dev/null 2>&1; then
  echo "Code-signing identity '$IDENTITY_NAME' already exists. Skipping."
else
  echo "Creating self-signed code-signing identity '$IDENTITY_NAME'..."

  # macOS's `certtool` is gone; we use openssl to build the cert and then
  # import it. The cert needs `codeSigning` extended key usage.
  TMPDIR_LOCAL=$(mktemp -d)
  CONF="$TMPDIR_LOCAL/cert.cnf"
  cat >"$CONF" <<EOF
[req]
distinguished_name = req_distinguished_name
prompt = no
x509_extensions = v3_req

[req_distinguished_name]
CN = $IDENTITY_NAME

[v3_req]
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
basicConstraints = critical, CA:FALSE
EOF

  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -keyout "$TMPDIR_LOCAL/key.pem" -out "$TMPDIR_LOCAL/cert.pem" \
    -config "$CONF" -extensions v3_req >/dev/null 2>&1

  openssl pkcs12 -export -inkey "$TMPDIR_LOCAL/key.pem" -in "$TMPDIR_LOCAL/cert.pem" \
    -out "$TMPDIR_LOCAL/identity.p12" -passout pass:vibe >/dev/null

  security import "$TMPDIR_LOCAL/identity.p12" -k "$KEYCHAIN" -P vibe -A >/dev/null

  rm -rf "$TMPDIR_LOCAL"
  echo "Created '$IDENTITY_NAME' in $KEYCHAIN."
fi

# 2. Sign the freshly-built release binary so it picks up the stable CDHash.
BINARY="$(dirname "$0")/src-tauri/target/release/vibe-extract-desktop"
if [[ -f "$BINARY" ]]; then
  echo "Signing $BINARY with '$IDENTITY_NAME'..."
  codesign --force --sign "$IDENTITY_NAME" --options runtime --timestamp=none "$BINARY"
  echo "Done. CDHash:"
  codesign -dvvv "$BINARY" 2>&1 | grep 'CDHash'
else
  echo "Note: $BINARY doesn't exist yet. Run 'cargo build --release' first, then re-run this script (or call ./sign-build.sh)."
fi

echo ""
echo "Next steps:"
echo "  1. Open System Settings → Privacy & Security → Accessibility."
echo "  2. Remove the existing 'vibe-extract-desktop' row with '-'."
echo "  3. Add it back via '+', point to:"
echo "     $BINARY"
echo "  4. Toggle it on, then 'Quit & Reopen' the app."
echo "  5. Future rebuilds: just run ./sign-build.sh (no re-grant needed)."
