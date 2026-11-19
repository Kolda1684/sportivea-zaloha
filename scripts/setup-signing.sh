#!/bin/sh
# One-time setup of a stable, self-signed code-signing identity for Sportivea Záloha.
# Why: an ad-hoc signature changes with every build, so macOS treats each new version as a different app and
# refuses it the Keychain item that safeStorage created ("Error while encrypting… safeStorage.encryptStringAsync").
# Signing every build with the same certificate keeps the designated requirement, and with it Keychain access.
#
# Creates ~/.sportivea-zaloha-signing/signing.keychain-db (outside iCloud and git) holding the private key, and
# appends SIGNING_KEYCHAIN_PASSWORD to the project's .env (gitignored). Touches neither the login keychain nor
# trust settings, and leaves the keychain search list as it was. Never prints the password.
# Usage: sh scripts/setup-signing.sh
set -eu
DIR="$HOME/.sportivea-zaloha-signing"
KC="$DIR/signing.keychain-db"
NAME="Sportivea Zaloha Code Signing"
ENV_FILE="$(cd "$(dirname "$0")/.." && pwd)/.env"

if [ -e "$KC" ]; then
  echo "Already set up: $KC"
  exit 0
fi
if grep -q '^SIGNING_KEYCHAIN_PASSWORD=' "$ENV_FILE" 2>/dev/null; then
  echo "SIGNING_KEYCHAIN_PASSWORD is in .env but $KC is missing; fix by hand (remove the line or restore the keychain)." >&2
  exit 1
fi

mkdir -m 700 "$DIR"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
PW="$(openssl rand -hex 24)"

cat > "$WORK/cert.cnf" <<EOF
[req]
distinguished_name = dn
prompt = no
x509_extensions = ext
[dn]
CN = $NAME
O = Sportivea
[ext]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
subjectKeyIdentifier = hash
EOF
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -config "$WORK/cert.cnf" \
  -keyout "$WORK/key.pem" -out "$WORK/cert.pem" 2>/dev/null
openssl pkcs12 -export -inkey "$WORK/key.pem" -in "$WORK/cert.pem" -name "$NAME" \
  -out "$WORK/identity.p12" -passout "pass:$PW"

# create-keychain may add the new keychain to the user's search list: put the list back afterwards
BEFORE="$(security list-keychains -d user | sed 's/^ *"//; s/"$//')"
security create-keychain -p "$PW" "$KC"
security set-keychain-settings "$KC"
security import "$WORK/identity.p12" -k "$KC" -P "$PW" -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$PW" "$KC" >/dev/null
# shellcheck disable=SC2086
echo "$BEFORE" | tr '\n' '\0' | xargs -0 security list-keychains -d user -s

printf '\n# Stable code signing (scripts/setup-signing.sh); keychain at %s\nSIGNING_KEYCHAIN_PASSWORD=%s\n' "$KC" "$PW" >> "$ENV_FILE"
echo "Created $NAME in $KC (valid 10 years). Password stored in .env as SIGNING_KEYCHAIN_PASSWORD."
