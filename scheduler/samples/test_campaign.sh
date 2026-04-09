#!/bin/bash

# Test script for samples/PR_campaign.json
#
# Verifies the campaign mechanism end-to-end:
#   - RUNTIME_NB_CORES applied to Init
#   - RUNTIME_RUN_CONFIG injected as a named configuration → vendor/features/extra_flags
#     and nb_cores are correctly inherited by all group steps
#   - COMMIT_ID available throughout
#   - Only 1 rank produced (single config injected)
#
# Submit with:
#   runtime[RUNTIME_NB_CORES]          = 4
#   runtime[RUNTIME_NB_RUN]            = 1
#   runtime[RUNTIME_TIMEOUT]           = "5m"
#   runtime[RUNTIME_MEMORY_CORE]       = 512
#   runtime[RUNTIME_MEMORY_CONSUMPTION]= 128
#   runtime[RUNTIME_RUN_CONFIG]        = {"wolfssl540":{"args":{"vendor":"wolfssl:wolfssl540","features":"test-feature","extra_flags":"--test-flag"},"nb_cores":2}}
#   args[COMMIT_ID]                    = abc1234def5678

check() {
  local step="$1" varname="$2" expected="$3" actual="$4"
  local key="${step}_${varname}"
  if [ "${actual}" = "${expected}" ]; then
    echo "OK   ${key}: '${actual}'" >> "${THEJOB_OUT_PATH}/results.txt"
  else
    echo "FAIL ${key}: expected='${expected}' got='${actual}'" >> "${THEJOB_OUT_PATH}/results.txt"
  fi
}

# ─── Init ─────────────────────────────────────────────────────────────────────
#
# Runs outside the group, with nb_cores=${RUNTIME_NB_CORES} (4).
# COMMIT_ID must be available as a global arg.
#
Init() {
  echo "=== Init | nb_cores=${THEJOB_NB_CORES} commit=${COMMIT_ID}" 1>&2
  check "Init" "nb_cores"      "4"   "${THEJOB_NB_CORES}"
  check "Init" "commit_id_set" "yes" "$([ -n "${COMMIT_ID}" ] && echo 'yes' || echo 'no')"
}

# ─── ForcedBuild ──────────────────────────────────────────────────────────────
#
# First step of the group.  No inline configuration → all args and nb_cores
# come from the named configuration injected via RUNTIME_RUN_CONFIG ("wolfssl540").
#
# Expected:
#   rank=0 (single config)  vendor=wolfssl:wolfssl540
#   features=test-feature   extra_flags=--test-flag   nb_cores=2
#
ForcedBuild() {
  local rank="${THEJOB_STEP_RANK_ID}"
  echo "=== ForcedBuild rank=${rank} | vendor=${vendor} features=${features} extra_flags=${extra_flags} nb_cores=${THEJOB_NB_CORES}" 1>&2

  check "ForcedBuild" "rank"        "0"                   "${rank}"
  check "ForcedBuild" "vendor"      "wolfssl:wolfssl540"   "${vendor}"
  check "ForcedBuild" "features"    "test-feature"         "${features}"
  check "ForcedBuild" "extra_flags" "--test-flag"          "${extra_flags}"
  check "ForcedBuild" "nb_cores"    "2"                    "${THEJOB_NB_CORES}"
}

# ─── ExperimentWithCargo ──────────────────────────────────────────────────────
#
# Inline configuration adds timeout/memory but no nb_cores → nb_cores=2 inherited
# from the named config.  Args (vendor/features/extra_flags) are also inherited.
#
ExperimentWithCargo() {
  local rank="${THEJOB_STEP_RANK_ID}"
  echo "=== ExperimentWithCargo rank=${rank} | vendor=${vendor} features=${features} extra_flags=${extra_flags} nb_cores=${THEJOB_NB_CORES}" 1>&2

  check "ExperimentWithCargo" "rank"        "0"                   "${rank}"
  check "ExperimentWithCargo" "vendor"      "wolfssl:wolfssl540"   "${vendor}"
  check "ExperimentWithCargo" "features"    "test-feature"         "${features}"
  check "ExperimentWithCargo" "extra_flags" "--test-flag"          "${extra_flags}"
  check "ExperimentWithCargo" "nb_cores"    "2"                    "${THEJOB_NB_CORES}"
}

MonitorExperiment() {
  echo "monitor: running" > "$1"
}

# ─── ExperimentEnd ────────────────────────────────────────────────────────────
#
# Closing step of the group; args still inherited from the named config.
#
ExperimentEnd() {
  local rank="${THEJOB_STEP_RANK_ID}"
  echo "=== ExperimentEnd rank=${rank} | vendor=${vendor}" 1>&2

  check "ExperimentEnd" "rank"   "0"                   "${rank}"
  check "ExperimentEnd" "vendor" "wolfssl:wolfssl540"   "${vendor}"
}

# ─── SummaryRun ───────────────────────────────────────────────────────────────
#
# Runs after the group.  COMMIT_ID must still be available.
# Collects and prints the full check report.
#
SummaryRun() {
  echo "=== SummaryRun | commit=${COMMIT_ID}" 1>&2
  check "SummaryRun" "commit_id_set" "yes" "$([ -n "${COMMIT_ID}" ] && echo 'yes' || echo 'no')"

  local results="${THEJOB_OUT_PATH}/results.txt"
  if [ ! -f "${results}" ]; then
    echo "ERROR: results file not found at ${results}" 1>&2
    return 1
  fi

  cat "${results}" 1>&2
  echo "" 1>&2

  local total fails passed
  total=$(wc -l < "${results}")
  fails=$(grep -c "^FAIL" "${results}" || true)
  passed=$((total - fails))

  echo "Result: ${passed}/${total} checks passed" 1>&2
  CreateArtefact "${results}" "campaign_results.txt"

  if [ "${fails}" -eq 0 ]; then
    echo "ALL CHECKS PASSED" 1>&2
    return 0
  else
    echo "FAILED: ${fails} check(s) failed" 1>&2
    return 1
  fi
}

# ─── CleanAllRepo ─────────────────────────────────────────────────────────────
CleanAllRepo() {
  echo "=== CleanAllRepo" 1>&2
}
