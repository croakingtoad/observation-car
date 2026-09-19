#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
VERIFY_REQUIRED_TIPS="${VERIFY_REQUIRED_TIPS:-}"
if [[ -z "$VERIFY_REQUIRED_TIPS" ]] && git rev-parse --show-toplevel >/dev/null 2>&1; then
  VERIFY_REQUIRED_TIPS="$SCRIPT_DIR/verify-required-tips.sh"
fi

if [[ -z "$VERIFY_REQUIRED_TIPS" ]]; then
  printf 'FAIL: no verify-required-tips script to test\n' >&2
  exit 1
fi

ancestor_sha="0ecae4bca2bc70692356cacac9770c25945f3762"
another_ancestor_sha="c535ce975e82aba9481a85bb714f65eab2c2a603"
non_ancestor_sha="aa504070ac607d058d99b41f94b251547b80fae2"
diverged_sha="0c1996c7712dbb502880dbca578dcc5f5094f222"
root_sha="ed8f5ba869ec27ca7e8e0b785d0d2d20eac29101"
absent_sha="1111111111111111111111111111111111111111"

fixture_dir="$(mktemp -d "${TMPDIR:-/tmp}/verify-required-tips.XXXXXX")"
trap 'rm -rf -- "$fixture_dir"' EXIT

tests_run=0

run_case() {
  local name="$1"
  local expected_status="$2"
  local expected_output="$3"
  local fixture="$4"
  local head_ref="$5"
  local status
  local output

  tests_run=$((tests_run + 1))

  set +e
  output="$(REQUIRED_TIPS_FILE="$fixture" "$VERIFY_REQUIRED_TIPS" "$head_ref" 2>&1)"
  status=$?
  set -e

  if [[ "$status" -ne "$expected_status" ]]; then
    printf 'FAIL: %s: expected exit %s, got %s\n' "$name" "$expected_status" "$status" >&2
    if [[ -n "$output" ]]; then
      printf 'output:\n%s\n' "$output" >&2
    fi
    exit 1
  fi

  if [[ "$expected_status" -ne 0 && "$output" == *"All required tips are ancestors"* ]]; then
    printf 'FAIL: %s: success line printed with nonzero exit\n' "$name" >&2
    exit 1
  fi

  if [[ -n "$expected_output" && "$output" != *"$expected_output"* ]]; then
    printf 'FAIL: %s: expected output substring: %s\n' "$name" "$expected_output" >&2
    printf 'actual output:\n%s\n' "$output" >&2
    exit 1
  fi
}

write_fixture() {
  local name="$1"
  shift
  local fixture="$fixture_dir/$name"
  printf -- "$@" > "$fixture"
  printf '%s' "$fixture"
}

# Parser: accepted forms, from LOCO-1192/1194.
run_case "bare SHA" 0 "" \
  "$(write_fixture bare "$ancestor_sha\n")" HEAD
run_case "SHA with comment" 0 "All required tips are ancestors" \
  "$(write_fixture comment "$ancestor_sha # verified\n")" HEAD
run_case "SHA with tab comment" 0 "All required tips are ancestors" \
  "$(write_fixture tab-comment "$ancestor_sha\t# verified\n")" HEAD
run_case "trailing whitespace" 0 "All required tips are ancestors" \
  "$(write_fixture trailing "$ancestor_sha   \n")" HEAD
run_case "no final newline" 0 "All required tips are ancestors" \
  "$(write_fixture no-newline "$ancestor_sha")" HEAD
run_case "CRLF" 0 "All required tips are ancestors" \
  "$(write_fixture crlf "$ancestor_sha\r\n")" HEAD
run_case "ordinary comment" 0 "All required tips are ancestors" \
  "$(write_fixture ordinary "# prose with cafe0123\n$ancestor_sha\n")" HEAD
run_case "disabled comment" 0 "All required tips are ancestors" \
  "$(write_fixture disabled "# disabled: $non_ancestor_sha\n$ancestor_sha\n")" HEAD

# Parser: rejected forms, from LOCO-1192/1194.
run_case "39-hex" 1 "invalid required-tip entry" \
  "$(write_fixture short "${ancestor_sha:0:39}\n")" HEAD
run_case "41-hex" 1 "invalid required-tip entry" \
  "$(write_fixture long "${ancestor_sha}f\n")" HEAD
run_case "uppercase" 1 "invalid required-tip entry" \
  "$(write_fixture uppercase "${ancestor_sha^^}\n")" HEAD
run_case "no-space comment" 1 "invalid required-tip entry" \
  "$(write_fixture no-space "$ancestor_sha#verified\n")" HEAD
run_case "plain garbage" 1 "invalid required-tip entry" \
  "$(write_fixture garbage "$ancestor_sha garbage\n")" HEAD
run_case "two SHAs" 1 "invalid required-tip entry" \
  "$(write_fixture two-shas "$ancestor_sha $another_ancestor_sha\n")" HEAD
run_case "whitespace-only" 1 "invalid required-tip entry" \
  "$(write_fixture whitespace "   \n")" HEAD

# Comment trap, from LOCO-1194/1196.
run_case "single-hash comment" 1 "commented-out required tip declares nothing" \
  "$(write_fixture single-hash "# $non_ancestor_sha\n")" HEAD
run_case "double-hash comment" 1 "commented-out required tip declares nothing" \
  "$(write_fixture double-hash "## $non_ancestor_sha\n")" HEAD
run_case "hash punctuation comment" 1 "commented-out required tip declares nothing" \
  "$(write_fixture punctuation "#- $non_ancestor_sha\n")" HEAD
run_case "unterminated single-hash comment" 1 "commented-out required tip declares nothing" \
  "$(write_fixture unterminated-single "# $non_ancestor_sha")" HEAD
run_case "unterminated double-hash comment" 1 "commented-out required tip declares nothing" \
  "$(write_fixture unterminated-double "## $non_ancestor_sha")" HEAD

# Empty declarations, from LOCO-1192/1194.
run_case "empty file" 2 "no required tips declared" \
  "$(write_fixture empty "")" HEAD
run_case "ordinary comments only" 2 "no required tips declared" \
  "$(write_fixture comments-only "# one\n# two with cafe0123\n")" HEAD
run_case "39-hex comment only" 2 "no required tips declared" \
  "$(write_fixture short-comment "# ${ancestor_sha:0:39}\n")" HEAD

# Environment and object failures, from LOCO-1192/1196.
run_case "missing file" 2 "required-tips file not found" \
  "$fixture_dir/does-not-exist" HEAD
run_case "missing head" 2 "cannot verify — head not present" \
  "$(write_fixture valid "$ancestor_sha\n")" not-a-real-ref
run_case "absent object" 2 "cannot verify — object not present" \
  "$(write_fixture absent "$absent_sha\n")" HEAD

# Precedence, from LOCO-1194/1196.
run_case "all tips genuinely missing" 1 "required tip is missing from $diverged_sha" \
  "$(write_fixture all-tips-missing "$ancestor_sha\n$another_ancestor_sha\n")" "$diverged_sha"
run_case "non-ancestor before absent object" 1 "required tip is missing from HEAD: $non_ancestor_sha" \
  "$(write_fixture missing-before-absent "$non_ancestor_sha\n$absent_sha\n")" HEAD
run_case "absent object before non-ancestor" 1 "required tip is missing from HEAD: $non_ancestor_sha" \
  "$(write_fixture absent-before-missing "$absent_sha\n$non_ancestor_sha\n")" HEAD
run_case "malformed plus non-ancestor" 1 "invalid required-tip entry" \
  "$(write_fixture malformed-missing "garbage\n$non_ancestor_sha\n")" HEAD
run_case "commented SHA plus non-ancestor" 1 "required tip is missing from HEAD: $non_ancestor_sha" \
  "$(write_fixture commented-missing "# $another_ancestor_sha\n$non_ancestor_sha\n")" HEAD
run_case "both tips versus root" 1 "required tip is missing from $root_sha: $another_ancestor_sha" \
  "$(write_fixture root-misses "$ancestor_sha\n$another_ancestor_sha\n")" "$root_sha"

# Governing property across all verification counts, from LOCO-1196.
run_case "non-ancestor with zero verified" 1 "required tip is missing from HEAD: $non_ancestor_sha" \
  "$(write_fixture zero-verified "$non_ancestor_sha\n")" HEAD
run_case "real tip plus non-ancestor" 1 "required tip is missing from HEAD: $non_ancestor_sha" \
  "$(write_fixture partial-verified "$ancestor_sha\n$non_ancestor_sha\n")" HEAD

if (( tests_run != 34 )); then
  printf 'FAIL: expected 34 test cases, ran %s\n' "$tests_run" >&2
  exit 1
fi

printf 'PASS: 34 required-tips verification cases\n'
