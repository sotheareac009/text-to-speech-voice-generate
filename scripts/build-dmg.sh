#!/usr/bin/env bash
#
# Build the distributable DMG, then prove it is actually distributable.
#
#   ./scripts/build-dmg.sh              # build at the current version
#   ./scripts/build-dmg.sh 0.3.0        # set the version first, then build
#
# The build itself is one command (`npm run tauri build`). Everything else
# here is verification, and it is the reason this script exists rather than a
# line in the README: a DMG that builds successfully can still be one that
# refuses to open on someone else's Mac. That has already happened on this
# project — Tauri produced a bundle whose signature was invalid, every machine
# it was sent to said "Voice Studio is damaged and can't be opened", and the
# build log showed nothing wrong at all. The checks below are the ones that
# would have caught it.
#
# Checks run against the app *inside the mounted DMG*, not the staging folder
# next to it. Those are different files, and only one of them is what the
# recipient gets. Verifying the wrong one has also already happened here.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$PWD"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; FAILED=1; }
FAILED=0

# ---------------------------------------------------------------- version ---
if [[ ${1:-} != "" ]]; then
  NEW="$1"
  [[ "$NEW" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Version must look like 1.2.3"; exit 1; }
  bold "Setting version to $NEW"
  # Both files must agree or the bundle and the binary disagree about what
  # they are. Matched narrowly so no other "version" key is caught.
  /usr/bin/sed -i '' -E "s/(\"version\"[[:space:]]*:[[:space:]]*)\"[0-9]+\.[0-9]+\.[0-9]+\"/\1\"$NEW\"/" src-tauri/tauri.conf.json
  /usr/bin/sed -i '' -E "s/^version = \"[0-9]+\.[0-9]+\.[0-9]+\"/version = \"$NEW\"/" src-tauri/Cargo.toml
fi

VERSION=$(python3 -c "import json;print(json.load(open('src-tauri/tauri.conf.json'))['version'])")
CARGO=$(grep -m1 '^version = ' src-tauri/Cargo.toml | cut -d'"' -f2)
[[ "$VERSION" == "$CARGO" ]] || { echo "tauri.conf.json ($VERSION) and Cargo.toml ($CARGO) disagree"; exit 1; }

# ------------------------------------------------------------------ build ---
bold "Building Voice Studio $VERSION"
echo "  (a release Rust compile — several minutes the first time)"
npm run tauri build

ARCH=$(uname -m); [[ "$ARCH" == "arm64" ]] && ARCH=aarch64
DMG="src-tauri/target/release/bundle/dmg/Voice Studio_${VERSION}_${ARCH}.dmg"
APP="src-tauri/target/release/bundle/macos/Voice Studio.app"
[[ -f "$DMG" ]] || { echo "No DMG at $DMG"; exit 1; }

# ------------------------------------------------------------- verify app ---
echo
bold "Checking the built app"
if codesign --verify --deep --strict "$APP" 2>/dev/null; then
  ok "signature valid"
else
  bad "SIGNATURE INVALID — this build would say \"Voice Studio is damaged\" on another Mac"
  echo "     check that tauri.conf.json has  \"macOS\": { \"signingIdentity\": \"-\" }"
fi

# Bytecode written into a signed bundle breaks the seal at runtime. The engine
# sets PYTHONPYCACHEPREFIX to keep it out; this proves it worked.
if [[ -z "$(find "$APP" \( -name '__pycache__' -o -name '*.pyc' \) -print -quit)" ]]; then
  ok "no stray bytecode in the bundle"
else
  bad "__pycache__ inside the bundle — it will invalidate the signature"
fi

# ------------------------------------------------- verify the real artifact --
echo
bold "Checking the app inside the DMG (what the recipient actually gets)"
for vol in "/Volumes/Voice Studio"*; do
  [[ -d "$vol" ]] && hdiutil detach "$vol" -quiet 2>/dev/null || true
done
MNT=$(hdiutil attach "$DMG" -nobrowse -readonly | grep -o '/Volumes/.*$' | tail -1)
trap 'hdiutil detach "$MNT" -quiet 2>/dev/null || true' EXIT
INNER="$MNT/Voice Studio.app"

codesign --verify --deep --strict "$INNER" 2>/dev/null \
  && ok "signature valid inside the DMG" \
  || bad "signature INVALID inside the DMG"

GOT=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$INNER/Contents/Info.plist")
[[ "$GOT" == "$VERSION" ]] && ok "reports version $GOT" || bad "reports $GOT, expected $VERSION"

# Every Python module the engine imports has to be in there. A missing one
# does not fail the build — it fails on the recipient's machine, at the
# moment they press Generate.
RES="$INNER/Contents/Resources/python"
MISSING=()
for f in $(cd "$ROOT/python" && ls *.py) requirements.txt; do
  [[ -f "$RES/$f" ]] || MISSING+=("$f")
done
if [[ ${#MISSING[@]} -eq 0 ]]; then
  ok "all $(cd "$ROOT/python" && ls *.py | wc -l | tr -d ' ') python modules + requirements.txt bundled"
else
  bad "missing from the bundle: ${MISSING[*]}"
fi

# The engine imports these at startup; if one is not declared, the recipient's
# install completes and then the engine will not boot.
for pkg in voxcpm scipy librosa fastapi uvicorn demucs; do
  grep -qi "^$pkg" "$RES/requirements.txt" || bad "requirements.txt does not list $pkg"
done
ok "requirements.txt lists the engine's imports"

# A key must never travel inside a bundle that gets copied between machines.
if [[ -n "$(find "$INNER" -name '*.key' -print -quit)" ]]; then
  bad "a .key file is inside the bundle — remove it before sending this to anyone"
else
  ok "no credentials in the bundle"
fi

# ----------------------------------------------------------------- result ---
echo
if [[ $FAILED -eq 0 ]]; then
  bold "Ready to send"
  echo "  $ROOT/$DMG"
  echo "  $(du -h "$DMG" | cut -f1), version $VERSION, $ARCH"
  echo
  echo "  The recipient needs Python 3.10-3.13 and about 10 GB free. On first"
  echo "  launch the app installs its engine (~420 MB download, ~2.2 GB on"
  echo "  disk); the voice model (~4.6 GB) arrives the first time they press"
  echo "  Generate, and the voice separator (~80 MB) the first time they clone."
  echo
  echo "  It is ad-hoc signed, not notarised, so the first open is still"
  echo "  right-click > Open, or Open Anyway in System Settings > Privacy."
else
  bold "Build finished but FAILED its checks — do not send this file"
  exit 1
fi
