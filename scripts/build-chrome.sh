#!/usr/bin/env bash
# Compatibility wrapper — prefer: npm run build:chrome
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
npm run build:chrome
echo "Chrome package ready at build/chrome (and build/asklocal-chrome.zip)"
