#!/bin/sh
# Ad-hoc signs the packaged app and zips it for another Mac. Signing happens in a temp folder: when the project
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
codesign --force --deep --sign - "$WORK/$NAME"
node "$(dirname "$0")/check-bundle.mjs" "$WORK/$NAME"
rm -f "$ZIP"
ditto -c -k --keepParent "$WORK/$NAME" "$ZIP"
# the zip must unpack into a bundle that still verifies
mkdir "$WORK/unzipped"
ditto -x -k "$ZIP" "$WORK/unzipped"
codesign --verify --deep --strict "$WORK/unzipped/$NAME"
echo "OK   zip unpacks to a valid bundle: $ZIP"
