#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

# Build locally for this Mac, or set MACOS_ARCH=arm64/x86_64 for a cross-build.
architecture="${MACOS_ARCH:-$(uname -m)}"
case "$architecture" in
  arm64|x86_64) ;;
  *) echo "Unsupported macOS architecture: $architecture" >&2; exit 1 ;;
esac
output="${1:-.build/release}"
mkdir -p "$output" .build/ModuleCache
output="$(cd "$output" && pwd)"
app="$output/DanceForge.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"

xcrun swiftc -swift-version 5 -O -target "$architecture-apple-macosx14.0" \
  -module-cache-path .build/ModuleCache -parse-as-library Sources/*.swift \
  -o "$app/Contents/MacOS/DanceForge" \
  -framework SwiftUI -framework AVKit -framework AppKit -framework Security \
  -framework Vision -framework CoreImage

cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>DanceForge</string>
<key>CFBundleIdentifier</key><string>com.djshortcut.DanceForge</string>
<key>CFBundleName</key><string>DanceForge</string>
<key>CFBundleDisplayName</key><string>DanceForge</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.0.2</string>
<key>CFBundleVersion</key><string>3</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>CFBundleDevelopmentRegion</key><string>nl</string>
<key>NSPrincipalClass</key><string>NSApplication</string>
<key>CFBundleIconFile</key><string>AppIcon</string>
</dict></plist>
PLIST

cp AppIcon.icns "$app/Contents/Resources/AppIcon.icns"
# Ad-hoc signing verifies the bundle without a developer identity or keychain.
codesign --force --sign - --identifier com.djshortcut.DanceForge "$app"
codesign --verify --deep --strict "$app"
echo "$app"
