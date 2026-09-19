#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
original_working_dir="$(pwd)"
VERIFY_REQUIRED_TIPS="${VERIFY_REQUIRED_TIPS:-}"
fixture_dir=""
scratch_repo=""
repo_working_dir=""

cleanup() {
  if [[ -n "$scratch_repo" ]]; then
    rm -rf -- "$scratch_repo"
  fi
  if [[ -n "$fixture_dir" ]]; then
    rm -rf -- "$fixture_dir"
  fi
}
trap cleanup EXIT

if ! git rev-parse --show-toplevel >/dev/null 2>&1; then
  printf 'FAIL: this harness requires one integration case inside the repository checkout\n' >&2
  exit 1
fi

if [[ -z "$VERIFY_REQUIRED_TIPS" ]]; then
  VERIFY_REQUIRED_TIPS="$SCRIPT_DIR/verify-required-tips.sh"
fi


shipped_tips=()
while IFS= read -r tip_line; do
  [[ -z "$tip_line" ]] && continue
  [[ "$tip_line" == \#* ]] && continue
  tip_token="${tip_line%%[[:space:]]*}"
  if [[ -z "$tip_token" ]]; then
    printf 'FAIL: invalid required-tip entry in required-tips.txt: %s\n' "$tip_line" >&2
    exit 1
  fi
  shipped_tips+=("$tip_token")
done < "$SCRIPT_DIR/required-tips.txt"

if (( ${#shipped_tips[@]} == 0 )); then
  printf 'FAIL: no tips declared in required-tips.txt\n' >&2
  exit 1
fi
shipped_tips_fixture="$(printf '%s\n' "${shipped_tips[@]}")"
absent_sha="1111111111111111111111111111111111111111"

fixture_dir="$(mktemp -d "${TMPDIR:-/tmp}/verify-required-tips.XXXXXX")"
scratch_repo="$(mktemp -d "${TMPDIR:-/tmp}/verify-required-tips-repo.XXXXXX")"

tests_run=0
failures=0

run_case() {
  local name="$1"
  local expected_status="$2"
  local expected_output="$3"
  local fixture="$4"
  local head_ref="$5"
  local status
  local output
  local case_dir="$repo_working_dir"
  local target="$VERIFY_REQUIRED_TIPS"

  tests_run=$((tests_run + 1))

  if [[ "$expected_status" -ne 0 && -z "$expected_output" ]]; then
    printf 'FAIL: %s: nonzero exit requires non-empty expected_output\n' "$name" >&2
    failures=$((failures + 1))
    return
  fi

  set +e
  output="$(cd -- "$case_dir" && REQUIRED_TIPS_FILE="$fixture" "$target" "$head_ref" 2>&1)"
  status=$?
  set -e

  if [[ "$status" -ne "$expected_status" ]]; then
    printf 'FAIL: %s: expected exit %s, got %s\n' "$name" "$expected_status" "$status" >&2
    if [[ -n "$output" ]]; then
      printf 'output:\n%s\n' "$output" >&2
    fi
    failures=$((failures + 1))
  fi

  if [[ "$expected_status" -ne 0 && "$output" == *"All required tips are ancestors"* ]]; then
    printf 'FAIL: %s: success line printed with nonzero exit\n' "$name" >&2
    failures=$((failures + 1))
  fi

  if [[ -n "$expected_output" && "$output" != *"$expected_output"* ]]; then
    printf 'FAIL: %s: expected output substring: %s\n' "$name" "$expected_output" >&2
    printf 'actual output:\n%s\n' "$output" >&2
    failures=$((failures + 1))
  fi
}

write_fixture() {
  local name="$1"
  shift
  local fixture="$fixture_dir/$name"
  printf '%b' "$1" > "$fixture"
  printf '%s' "$fixture"
}

git init --quiet "$scratch_repo"
repo_working_dir="$scratch_repo"
cd -- "$scratch_repo"
git config user.email "test@example.invalid"
git config user.name "Required Tips Harness"
printf 'one\n' > file.txt
git add file.txt
git -c commit.gpgsign=false commit --quiet -m "A"
git tag harness-a
printf 'two\n' >> file.txt
git add file.txt
git -c commit.gpgsign=false commit --quiet -m "B"
git tag harness-b
printf 'three\n' >> file.txt
git add file.txt
git -c commit.gpgsign=false commit --quiet -m "C"
git tag harness-c
git checkout --quiet -B harness-d harness-a
printf 'diverged\n' > file.txt
git add file.txt
git -c commit.gpgsign=false commit --quiet -m "D"
git checkout --quiet -B harness-e harness-a
printf 'also diverged\n' > file.txt
git add file.txt
git -c commit.gpgsign=false commit --quiet -m "E"
git checkout --quiet harness-d
ancestor_sha="$(git rev-parse harness-a)"
another_ancestor_sha="$(git rev-parse harness-b)"
non_ancestor_sha="$(git rev-parse refs/heads/harness-d)"
second_non_ancestor_sha="$(git rev-parse refs/heads/harness-e)"

# Parser: accepted forms, from LOCO-1192/1194.
run_case "bare SHA" 0 "" \
  "$(write_fixture bare "$(git rev-parse harness-a)\n")" harness-c
run_case "SHA with comment" 0 "All required tips are ancestors" \
  "$(write_fixture comment "$(git rev-parse harness-a) # verified\n")" harness-c
run_case "SHA with tab comment" 0 "All required tips are ancestors" \
  "$(write_fixture tab-comment "$(git rev-parse harness-a)\t# verified\n")" harness-c
run_case "trailing whitespace" 0 "All required tips are ancestors" \
  "$(write_fixture trailing "$(git rev-parse harness-a)   \n")" harness-c
run_case "no final newline" 0 "All required tips are ancestors" \
  "$(write_fixture no-newline "$(git rev-parse harness-a)")" harness-c
run_case "CRLF" 0 "All required tips are ancestors" \
  "$(write_fixture crlf "$(git rev-parse harness-a)\r\n")" harness-c
run_case "ordinary comment" 0 "All required tips are ancestors" \
  "$(write_fixture ordinary "# prose with cafe0123\n$(git rev-parse harness-a)\n")" harness-c
run_case "disabled comment" 0 "All required tips are ancestors" \
  "$(write_fixture disabled "# disabled: $(git rev-parse harness-c)\n$(git rev-parse harness-a)\n")" harness-c

# Parser: rejected forms, from LOCO-1192/1194.
run_case "39-hex" 1 "invalid required-tip entry" \
  "$(write_fixture short "${ancestor_sha:0:39}\n")" harness-c
run_case "41-hex" 1 "invalid required-tip entry" \
  "$(write_fixture long "${ancestor_sha}f\n")" harness-c
run_case "uppercase" 1 "invalid required-tip entry" \
  "$(write_fixture uppercase "${ancestor_sha^^}\n")" harness-c
run_case "no-space comment" 1 "invalid required-tip entry" \
  "$(write_fixture no-space "$ancestor_sha#verified\n")" harness-c
run_case "plain garbage" 1 "invalid required-tip entry" \
  "$(write_fixture garbage "$ancestor_sha garbage\n")" harness-c
run_case "two SHAs" 1 "invalid required-tip entry" \
  "$(write_fixture two-shas "$ancestor_sha $another_ancestor_sha\n")" harness-c
run_case "whitespace-only" 1 "invalid required-tip entry" \
  "$(write_fixture whitespace "   \n")" harness-c
run_case "indented entry" 1 "invalid required-tip entry" \
  "$(write_fixture indented "    $non_ancestor_sha\n")" harness-c

# Comment trap, from LOCO-1194/1196.
run_case "single-hash comment" 1 "commented-out required tip declares nothing" \
  "$(write_fixture single-hash "# $ancestor_sha\n")" harness-c
run_case "double-hash comment" 1 "commented-out required tip declares nothing" \
  "$(write_fixture double-hash "## $ancestor_sha\n")" harness-c
run_case "hash punctuation comment" 1 "commented-out required tip declares nothing" \
  "$(write_fixture punctuation "#- $ancestor_sha\n")" harness-c
run_case "unterminated single-hash comment" 1 "commented-out required tip declares nothing" \
  "$(write_fixture unterminated-single "# $ancestor_sha")" harness-c
run_case "unterminated double-hash comment" 1 "commented-out required tip declares nothing" \
  "$(write_fixture unterminated-double "## $ancestor_sha")" harness-c

# Empty declarations, from LOCO-1192/1194.
run_case "empty file" 2 "no required tips declared" \
  "$(write_fixture empty "")" harness-c
run_case "ordinary comments only" 2 "no required tips declared" \
  "$(write_fixture comments-only "# one\n# two with cafe0123\n")" harness-c
run_case "39-hex comment only" 2 "no required tips declared" \
  "$(write_fixture short-comment "# ${ancestor_sha:0:39}\n")" harness-c

# Environment and object failures, from LOCO-1192/1196.
run_case "missing file" 2 "required-tips file not found" \
  "$fixture_dir/does-not-exist" harness-c
run_case "missing head" 2 "cannot verify — head not present" \
  "$(write_fixture valid "$ancestor_sha\n")" not-a-real-ref
run_case "absent object" 2 "cannot verify — object not present" \
  "$(write_fixture absent "$absent_sha\n")" harness-c

# Precedence, from LOCO-1194/1196.
run_case "all tips genuinely missing" 1 "required tip is missing from harness-c" \
  "$(write_fixture all-tips-missing "$non_ancestor_sha\n$second_non_ancestor_sha\n")" harness-c
run_case "non-ancestor before absent object" 1 "required tip is missing from harness-c: $non_ancestor_sha" \
  "$(write_fixture missing-before-absent "$non_ancestor_sha\n$absent_sha\n")" harness-c
run_case "absent object before non-ancestor" 1 "required tip is missing from harness-c: $non_ancestor_sha" \
  "$(write_fixture absent-before-missing "$absent_sha\n$non_ancestor_sha\n")" harness-c
run_case "malformed plus non-ancestor" 1 "invalid required-tip entry" \
  "$(write_fixture malformed-missing "garbage\n$non_ancestor_sha\n")" harness-c
run_case "commented SHA plus non-ancestor" 1 "required tip is missing from harness-c: $non_ancestor_sha" \
  "$(write_fixture commented-missing "# $another_ancestor_sha\n$non_ancestor_sha\n")" harness-c
run_case "both tips versus root" 1 "required tip is missing from harness-a: $another_ancestor_sha" \
  "$(write_fixture root-misses "$ancestor_sha\n$another_ancestor_sha\n")" harness-a

# Governing property across all verification counts, from LOCO-1196.
run_case "non-ancestor with zero verified" 1 "required tip is missing from harness-c: $non_ancestor_sha" \
  "$(write_fixture zero-verified "$non_ancestor_sha\n")" harness-c
run_case "real tip plus non-ancestor" 1 "required tip is missing from harness-c: $non_ancestor_sha" \
  "$(write_fixture partial-verified "$ancestor_sha\n$non_ancestor_sha\n")" harness-c

# Integration: the shipped tips declared in required-tips.txt.
repo_working_dir="$original_working_dir"
cd -- "$original_working_dir"
run_case "shipped tips versus main" 0 "All required tips are ancestors of origin/main" \
  "$(write_fixture shipped-tips "${shipped_tips_fixture}")" origin/main

if (( tests_run != 36 )); then
  printf 'FAIL: expected 36 test cases, ran %s\n' "$tests_run" >&2
  exit 1
fi

if (( failures )); then
  exit 1
fi

printf 'PASS: %s required-tips verification cases\n' "$tests_run"
