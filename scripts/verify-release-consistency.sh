#!/usr/bin/env bash

set -euo pipefail

TAG="${1-}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# RELEASE_ROOT deliberately defaults relative to the repository, not the caller's cwd.
RELEASE_ROOT="${RELEASE_ROOT:-$(cd -- "${SCRIPT_DIR}/.." && pwd)}"

cd -- "$RELEASE_ROOT"

VERSION="${TAG#v}"
if ! [[ "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  echo "::error::Tag '${TAG}' is not a plugin version (expected '1.2.3' or 'v1.2.3')."
  exit 1
fi
MANIFEST_VERSION="$(jq -er '.version | select(type == "string" and length > 0)' manifest.json)"
MIN_APP_VERSION="$(jq -er '.minAppVersion | select(type == "string" and length > 0)' manifest.json)"
if [ "$MANIFEST_VERSION" != "$VERSION" ]; then
  echo "::error::manifest.json version '${MANIFEST_VERSION}' does not match tag '${TAG}' (normalized version '${VERSION}'). Bump manifest.json before tagging, or retag."
  exit 1
fi
# versions.json must be exactly one top-level JSON object: without
# this, an empty, non-object, or multi-document file would reach the
# version lookup below and fail with a misleading 'no entry' (or
# mangled multi-value) diagnostic instead of this one.
if ! jq -er -s 'select(length == 1 and (.[0] | type == "object"))' versions.json > /dev/null; then
  echo "::error::versions.json must contain exactly one top-level JSON object."
  exit 1
fi
# Obsidian's community-plugin format: keys are plugin versions,
# values are the minAppVersion that version requires. The shape
# guard above makes a direct key lookup sufficient.
ENTRY_MIN_APP="$(jq -er --arg v "$VERSION" '.[$v] // empty' versions.json || true)"
if [ -z "$ENTRY_MIN_APP" ]; then
  echo "::error::versions.json has no entry for plugin version '${VERSION}'. Add it (keyed by plugin version, with minAppVersion as the value) before tagging."
  exit 1
fi
if [ "$ENTRY_MIN_APP" != "$MIN_APP_VERSION" ]; then
  echo "::error::versions.json lists minAppVersion '${ENTRY_MIN_APP}' for plugin version '${VERSION}' but manifest.json minAppVersion is '${MIN_APP_VERSION}'."
  exit 1
fi
echo "Version consistency OK: tag '${TAG}' -> version '${VERSION}', minAppVersion '${MIN_APP_VERSION}'."
