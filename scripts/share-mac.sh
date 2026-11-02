#!/bin/bash
# Builds an installer (.dmg) of MultiSpace Browser for your team and puts it on your Desktop.
# It works on every Mac (Apple chip and Intel). Send the .dmg by Google Drive, WhatsApp, email…
set -e
cd "$(dirname "$0")/.."
echo "→ Installing parts…"
npm install --no-fund --no-audit
echo "→ Building the installer for all Macs (takes a few minutes)…"
rm -rf dist
if [ -n "$APPLE_TEAM_ID" ]; then
  # Signed with your Apple Developer ID: opens without any warning on your team's Macs.
  npx electron-builder --mac dmg --universal -c.mac.notarize=true
else
  npx electron-builder --mac dmg --universal -c.mac.identity=-
fi
DMG=$(ls dist/*.dmg | head -1)
cp "$DMG" ~/Desktop/
echo "✓ Done: ~/Desktop/$(basename "$DMG")"
open -R ~/Desktop/"$(basename "$DMG")"
