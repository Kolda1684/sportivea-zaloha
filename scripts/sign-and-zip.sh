#!/bin/sh
# Signs the packaged app with the stable Sportivea certificate and zips it for another Mac. Signing happens in a temp folder: when the project
# lives in an iCloud-synced folder (Desktop/Documents), File Provider re-adds com.apple.FinderInfo to bundles,
# which breaks `codesign --verify --strict` and makes Gatekeeper call the app damaged.
# Usage: sh scripts/sign-and-zip.sh "<packaged .app>" "<output .zip>"
set -eu
APP="$1"
ZIP="$2"
NAME="$(basename "$APP")"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/sportivea-zaloha-sign.XXXXXX")"
# the signed copy is ~400 MB; the zip is what stays
trap 'rm -rf "$WORK"' EXIT
ditto --norsrc --noextattr --noqtn "$APP" "$WORK/$NAME"
xattr -cr "$WORK/$NAME"
sign_stable() {
  # Same certificate for every build (scripts/setup-signing.sh): macOS then keeps Keychain access across updates.
  KC="$HOME/.sportivea-zaloha-signing/signing.keychain-db"
  ENV_FILE="$(cd "$(dirname "$0")/.." && pwd)/.env"
  PW="$(sed -n 's/^SIGNING_KEYCHAIN_PASSWORD=//p' "$ENV_FILE" 2>/dev/null | tail -1)"
  if [ ! -e "$KC" ] || [ -z "$PW" ]; then
    echo "FAIL no signing identity: run 'sh scripts/setup-signing.sh' once (an ad-hoc build would lose Keychain access on update)" >&2
    exit 1
  fi
  ID="$(security find-identity -p codesigning "$KC" | awk '/"Sportivea Zaloha Code Signing"/ {print $2; exit}')"
  [ -n "$ID" ] || { echo "FAIL signing identity not found in $KC" >&2; exit 1; }
  security unlock-keychain -p "$PW" "$KC"
  # codesign only finds identities in the search list: add the signing keychain for this call, then restore the list
  BEFORE="$(security list-keychains -d user | sed 's/^ *"//; s/"$//')"
  { echo "$BEFORE"; echo "$KC"; } | tr '\n' '\0' | xargs -0 security list-keychains -d user -s
  STATUS=0
  codesign --force --deep --keychain "$KC" --sign "$ID" "$WORK/$NAME" || STATUS=$?
  echo "$BEFORE" | tr '\n' '\0' | xargs -0 security list-keychains -d user -s
  security lock-keychain "$KC"
  return $STATUS
}
sign_stable
node "$(dirname "$0")/check-bundle.mjs" "$WORK/$NAME"
rm -f "$ZIP"
ditto -c -k --keepParent "$WORK/$NAME" "$ZIP"
# the zip must unpack into a bundle that still verifies
mkdir "$WORK/unzipped"
ditto -x -k "$ZIP" "$WORK/unzipped"
codesign --verify --deep --strict "$WORK/unzipped/$NAME"
echo "OK   zip unpacks to a valid bundle: $ZIP"
