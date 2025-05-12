#!/bin/bash

set -euo pipefail

# Change to the codex-cli directory.
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# First argument is where to stage the release. Creates a temporary directory
# if not provided.
RELEASE_DIR="${1:-$(mktemp -d)}"
# Read original version from package.json and store as OG_VERSION
OG_VERSION=$(jq -r '.version' package.json)
[ -n "${1-}" ] && shift

# Compile the JavaScript.
pnpm install
pnpm build
mkdir "$RELEASE_DIR/bin"
cp -r bin/codex.js "$RELEASE_DIR/bin/codex.js"
cp -r dist "$RELEASE_DIR/dist"
cp -r src "$RELEASE_DIR/src" # important if we want sourcemaps to continue to work
cp ../README.md "$RELEASE_DIR"
# TODO: Derive version from Git tag.
VERSION=$(printf '0.1.%d' "$(date +%y%m%d%H%M)")
jq --arg version "$VERSION" '.version = $version' package.json > "$RELEASE_DIR/package.json"
find "$RELEASE_DIR/dist" -type f -exec sed -i '' -e "s/$OG_VERSION/$VERSION/g" {} +

# Copy the native dependencies.
./scripts/install_native_deps.sh "$RELEASE_DIR"

echo "Staged version $VERSION for release in $RELEASE_DIR"
