#!/bin/bash
# Builds MultiSpace Browser as a normal Mac app and puts it in Applications.
# After this you open it from Launchpad / Applications / the Dock — no Terminal needed.
set -e
cd "$(dirname "$0")/.."
APP_NAME="MultiSpace Browser"
echo "→ Installing parts…"
npm install --no-fund --no-audit
echo "→ Building the app (takes a minute)…"
npx electron-builder --mac dir -c.mac.identity=null
BUILT=$(ls -d dist/mac*/"$APP_NAME.app" 2>/dev/null | head -1)
if [ -z "$BUILT" ]; then echo "Build failed: no app found in dist/"; exit 1; fi
echo "→ Copying to Applications…"
osascript -e "quit app \"$APP_NAME\"" >/dev/null 2>&1 || true
sleep 1
rm -rf "/Applications/$APP_NAME.app"
cp -R "$BUILT" /Applications/
codesign --force --deep --sign - "/Applications/$APP_NAME.app" >/dev/null 2>&1 || true
xattr -dr com.apple.quarantine "/Applications/$APP_NAME.app" >/dev/null 2>&1 || true
echo "✓ Installed. Opening $APP_NAME…"
open "/Applications/$APP_NAME.app"
