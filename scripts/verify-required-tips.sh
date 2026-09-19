#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REQUIRED_TIPS_FILE="${REQUIRED_TIPS_FILE:-$SCRIPT_DIR/required-tips.txt}"
HEAD_REF="${1:-HEAD}"

if [[ ! -f "$REQUIRED_TIPS_FILE" ]]; then
  echo "error: required-tips file not found: $REQUIRED_TIPS_FILE" >&2
  exit 2
fi

if ! git cat-file -e "$HEAD_REF^{commit}" 2>/dev/null; then
  echo "cannot verify — head not present, fetch full history: $HEAD_REF" >&2
  exit 2
fi

failed=0
checked=0
while IFS= read -r line || [[ -n "$line" ]]; do
  [[ -z "$line" ]] && continue
  if [[ "$line" =~ ^#+[[:space:]]*[[:punct:]]*[[:space:]]*[0-9a-f]{40} ]]; then
    echo "error: commented-out required tip declares nothing: $line" >&2
    failed=1
    continue
  fi
  [[ "$line" == \#* ]] && continue
  if [[ ! "$line" =~ ^([0-9a-f]{40})([[:space:]]|$) ]]; then
    echo "error: invalid required-tip entry: $line" >&2
    failed=1
    continue
  fi
  sha="${BASH_REMATCH[1]}"
  remainder="${line#"$sha"}"
  while [[ "$remainder" == [[:space:]]* ]]; do
    remainder="${remainder:1}"
  done
  if [[ -n "$remainder" && "$remainder" != \#* ]]; then
    echo "error: invalid required-tip entry: $line" >&2
    failed=1
    continue
  fi
  if ! git cat-file -e "$sha^{commit}"; then
    echo "cannot verify — object not present, fetch full history: $sha" >&2
    (( failed == 1 )) || failed=2
    continue
  fi
  if ! git merge-base --is-ancestor "$sha" "$HEAD_REF" 2>/dev/null; then
    echo "error: required tip is missing from $HEAD_REF: $sha" >&2
    failed=1
  else
    (( checked += 1 ))
  fi
done < "$REQUIRED_TIPS_FILE"

if (( failed )); then
  if (( checked == 0 )); then
    echo "error: no required tips declared in $REQUIRED_TIPS_FILE" >&2
    exit 2
  fi
  exit "$failed"
fi

if (( checked == 0 )); then
  echo "error: no required tips declared in $REQUIRED_TIPS_FILE" >&2
  exit 2
fi

echo "All required tips are ancestors of $HEAD_REF."
