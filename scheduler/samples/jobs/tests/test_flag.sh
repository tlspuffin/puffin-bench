#!/bin/bash
#
# Test: Flag() utility from functions.sh + flag file mechanism
#
# Flag() is injected by executor.sh via functions.sh.  It writes a string to
# THEJOB_FLAG_FILE atomically: the content goes to a per-step temp file first
# (<THEJOB_FLAG_FILE>.<stepNumId>.<rank>.<attempt>) then renamed into place.
#
# The scheduler reads THEJOB_FLAG_FILE once after all steps complete and saves
# its content to the "flag" field of the task entry in users.json.
#
# This test covers:
#   1. Flag() with no argument: exits 1 and prints an error message
#   2. Flag() writes the given string to THEJOB_FLAG_FILE
#   3. The atomic temp file does not survive the rename
#   4. Content written in one step persists to the next step (shared file)
#   5. A second Flag() call overwrites the previous content
#
# Submit with:
#   user     = <any>
#   job_type = <any>
#
# Expected: all checks pass; artefact "flag_results.txt" created.

check() {
  local step="$1" varname="$2" expected="$3" actual="$4"
  local key="${step}_${varname}"
  if [ "${actual}" = "${expected}" ]; then
    echo "OK   ${key}: '${actual}'" >> "${THEJOB_OUT_PATH}/results.txt"
  else
    echo "FAIL ${key}: expected='${expected}' got='${actual}'" >> "${THEJOB_OUT_PATH}/results.txt"
  fi
}

# ─── CheckFlagNoArg ───────────────────────────────────────────────────────────
#
# Flag() called without argument must exit 1 and print an error message to
# both stdout and stderr.
#
CheckFlagNoArg() {
  echo "=== CheckFlagNoArg" 1>&2

  local out
  out=$(Flag 2>/dev/null)
  local rc=$?
  check "CheckFlagNoArg" "exit_code" "1" "${rc}"
  check "CheckFlagNoArg" "error_msg" "Flag require a string as parameter" "${out}"
}

# ─── SetFlag ──────────────────────────────────────────────────────────────────
#
# Flag() writes the string atomically; the temp file must not survive after
# the mv.
#
SetFlag() {
  echo "=== SetFlag | flag_file=${THEJOB_FLAG_FILE}" 1>&2

  check "SetFlag" "flag_file_set" "yes" \
    "$([ -n "${THEJOB_FLAG_FILE}" ] && echo 'yes' || echo 'no')"

  Flag '{"status":"started","step":1}'

  check "SetFlag" "flag_file_exists" "yes" \
    "$([ -f "${THEJOB_FLAG_FILE}" ] && echo 'yes' || echo 'no')"

  local tmpfile="${THEJOB_FLAG_FILE}.${THEJOB_STEP_NUMID}.${THEJOB_STEP_RANK_ID}.${THEJOB_STEP_ATTEMPT_ID}"
  check "SetFlag" "tmp_file_cleaned_up" "no" \
    "$([ -f "${tmpfile}" ] && echo 'yes' || echo 'no')"

  local content
  content=$(cat "${THEJOB_FLAG_FILE}")
  check "SetFlag" "content" '{"status":"started","step":1}' "${content}"
}

# ─── OverwriteFlag ────────────────────────────────────────────────────────────
#
# The flag file from SetFlag must still be readable.  A second Flag() call
# must replace the content completely.
#
OverwriteFlag() {
  echo "=== OverwriteFlag | flag_file=${THEJOB_FLAG_FILE}" 1>&2

  local prev_content
  prev_content=$(cat "${THEJOB_FLAG_FILE}" 2>/dev/null || echo "")
  check "OverwriteFlag" "prev_content" '{"status":"started","step":1}' "${prev_content}"

  Flag '{"status":"done","step":2,"result":"passed"}'

  local content
  content=$(cat "${THEJOB_FLAG_FILE}")
  check "OverwriteFlag" "content" '{"status":"done","step":2,"result":"passed"}' "${content}"
}

# ─── Summary ──────────────────────────────────────────────────────────────────
#
# Report results.  The flag file content at this point is what the scheduler
# persists to users.json under the task's "flag" key after the task finishes.
#
Summary() {
  echo "=== Summary ===" 1>&2

  local results="${THEJOB_OUT_PATH}/results.txt"
  if [ ! -f "${results}" ]; then
    echo "ERROR: results file not found at ${results}" 1>&2
    return 1
  fi

  cat "${results}" 1>&2
  echo "" 1>&2
  echo "Final flag content: $(cat "${THEJOB_FLAG_FILE}" 2>/dev/null || echo '<empty>')" 1>&2

  local total fails passed
  total=$(wc -l < "${results}")
  fails=$(grep -c "^FAIL" "${results}" || true)
  passed=$((total - fails))

  echo "Result: ${passed}/${total} checks passed" 1>&2
  CreateArtefact "${results}" "flag_results.txt"

  if [ "${fails}" -eq 0 ]; then
    echo "ALL CHECKS PASSED" 1>&2
    return 0
  else
    echo "FAILED: ${fails} check(s) failed" 1>&2
    return 1
  fi
}
