#!/usr/bin/env bash
# Removes the local harness created by setup.sh.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
rm -rf "$ROOT/src/app/dev/player-qa" "$ROOT/public/qa-media"
rmdir "$ROOT/src/app/dev" 2>/dev/null || true
