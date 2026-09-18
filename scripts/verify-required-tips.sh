#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REQUIRED_TIPS_FILE="${REQUIRED_TIPS_FILE:-$SCRIPT_DIR/required-tips.txt}"
HEAD_REF="${1:-HEAD}"

if [[ ! -f "$REQUIRED_TIPS_FILE" ]]; then
  echo "error: required-tips file not found: $REQUIRED_TIPS_FILE" >&2
  exit 2
fi

failed=0
while IFS= read -r line || [[ -n "$line" ]]; do
  [[ -z "$line" || "$line" == \#* ]] && continue
  sha="${line%%[[:space:]]#*}"
  sha="${sha%%[[:space:]]*}"
  if [[ ! "$sha" =~ ^[0-9a-f]{40}$ ]]; then
    echo "error: invalid required-tip entry: $line" >&2
    failed=1
    continue
  fi
  if ! git merge-base --is-ancestor "$sha" "$HEAD_REF" 2>/dev/null; then
    echo "error: required tip is missing from $HEAD_REF: $sha" >&2
    failed=1
  fi
done < "$REQUIRED_TIPS_FILE"

if (( failed )); then
  exit 1
fi

echo "All required tips are ancestors of $HEAD_REF."
