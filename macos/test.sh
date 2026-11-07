#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

architecture="${MACOS_ARCH:-$(uname -m)}"
case "$architecture" in
  arm64|x86_64) ;;
  *) echo "Unsupported macOS architecture: $architecture" >&2; exit 1 ;;
esac
mkdir -p .build/tests .build/ModuleCache

# Only FalClient and its URLProtocol mock are linked. The app and KeychainStore
# are deliberately excluded, so this executable cannot start the app or read
# the user's saved fal credential. Every request uses the injected mock session.
xcrun swiftc -swift-version 5 -target "$architecture-apple-macosx14.0" \
  -module-cache-path .build/ModuleCache -parse-as-library \
  Sources/FalClient.swift Tests/FalClientTests.swift \
  -o .build/tests/FalClientTests
.build/tests/FalClientTests
