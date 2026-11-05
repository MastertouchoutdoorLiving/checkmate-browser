#!/bin/bash
# Builds an installer (.dmg) of CheckMate Browser for your team and puts it on your Desktop.
# It works on every Mac (Apple chip and Intel). Send the .dmg by Google Drive, WhatsApp, email…
set -e
cd "$(dirname "$0")/.."
BUILD_NAME="CheckMate Browser"
APP_NAME="CheckMate Browser"
VERSION=$(node -p "require('./package.json').version")
echo "→ Installing parts…"
npm install --no-fund --no-audit
echo "→ Building the app for all Macs (takes a few minutes)…"
rm -rf dist
if [ -n "$APPLE_TEAM_ID" ]; then
  # Signed with your Apple Developer ID: opens without any warning on your team's Macs.
  npx electron-builder --mac dir --universal -c.mac.notarize=true
else
  npx electron-builder --mac dir --universal -c.mac.identity=-
fi
BUILT=$(ls -d dist/mac*/"$BUILD_NAME.app" | head -1)
STAGE=dist/dmg-stage
rm -rf "$STAGE" && mkdir -p "$STAGE"
cp -R "$BUILT" "$STAGE/$APP_NAME.app"
[ -z "$APPLE_TEAM_ID" ] && codesign --force --deep --sign - "$STAGE/$APP_NAME.app" >/dev/null 2>&1 || true
ln -s /Applications "$STAGE/Applications"
DMG="dist/CheckMate-Browser-$VERSION.dmg"
echo "→ Making the installer…"
hdiutil create -volname "$APP_NAME" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
cp "$DMG" ~/Desktop/
echo "✓ Done: ~/Desktop/$(basename "$DMG")"
open -R ~/Desktop/"$(basename "$DMG")"
