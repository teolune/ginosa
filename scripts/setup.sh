#!/usr/bin/env bash
# First-time setup: installs the project's npm dependencies.
# The first run adds the current versions to package.json; after that, plain
# `npm install` reproduces exactly the same versions from package-lock.json.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -f package-lock.json ]] && grep -q '"electron"' package.json; then
  echo "Installing locked dependencies…"
  npm install
else
  echo "Adding dependencies for the first time…"
  npm install --save-dev electron electron-vite typescript vitest @types/node @webgpu/types
  npm install --save mediabunny
fi

echo
echo "Done. Next:"
echo "  npm run check        # typecheck + unit tests"
echo "  npm run test-media   # generate test clips"
echo "  npm run dev          # open the app"
