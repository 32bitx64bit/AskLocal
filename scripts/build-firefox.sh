#!/usr/bin/env bash
# Compatibility wrapper — prefer: npm run build:firefox
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
npm run build:firefox
echo "Firefox package ready at build/firefox (and build/asklocal-firefox.zip)"
