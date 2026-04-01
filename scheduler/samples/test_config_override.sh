#!/bin/bash

# Helper: write pass/fail result to shared results file
check() {
  local step="$1" rank="$2" varname="$3" expected="$4" actual="$5"
  local key="${step}_rank${rank}_${varname}"
  if [ "${actual}" = "${expected}" ]; then
    echo "OK   ${key}: '${actual}'" >> "${THEJOB_OUT_PATH}/results.txt"
  else
    echo "FAIL ${key}: expected='${expected}' got='${actual}'" >> "${THEJOB_OUT_PATH}/results.txt"
  fi
}

# ─── Mechanism 1: Named configuration ────────────────────────────────────────
#
# run: ["Conf_Base", "Conf_Fast"]
#
# Each entry is a string → selects a named config from the task-level
# "configurations" block.  nb_cores is also set per config.
#
# Expected:
#   rank 0 (Conf_Base): source=named_config  speed=normal  nb_cores=1
#   rank 1 (Conf_Fast): source=named_config  speed=fast    nb_cores=2
#
ByNamedConfig() {
  local rank="${THEJOB_STEP_RANK_ID}"
  echo "=== ByNamedConfig rank=${rank} | source=${source} speed=${speed} nb_cores=${THEJOB_NB_CORES}" 1>&2

  check "ByNamedConfig" "${rank}" "source" "named_config" "${source}"
  case "${rank}" in
    0)
      check "ByNamedConfig" "${rank}" "speed"    "normal" "${speed}"
      check "ByNamedConfig" "${rank}" "nb_cores" "1"      "${THEJOB_NB_CORES}"
      ;;
    1)
      check "ByNamedConfig" "${rank}" "speed"    "fast"   "${speed}"
      check "ByNamedConfig" "${rank}" "nb_cores" "2"      "${THEJOB_NB_CORES}"
      ;;
  esac
}

# ─── Mechanism 2: Inline anonymous override ───────────────────────────────────
#
# run: [
#   {"args": {"source": "inline", "color": "red"}},
#   {"args": {"source": "inline", "color": "blue"}}
# ]
#
# Each entry is a plain object → applied as an override on top of the
# default (empty) configuration.  No named config is involved.
#
# Expected:
#   rank 0: source=inline  color=red
#   rank 1: source=inline  color=blue
#
ByInlineOverride() {
  local rank="${THEJOB_STEP_RANK_ID}"
  echo "=== ByInlineOverride rank=${rank} | source=${source} color=${color}" 1>&2

  check "ByInlineOverride" "${rank}" "source" "inline" "${source}"
  case "${rank}" in
    0) check "ByInlineOverride" "${rank}" "color" "red"  "${color}" ;;
    1) check "ByInlineOverride" "${rank}" "color" "blue" "${color}" ;;
  esac
}

# ─── Mechanism 3: Named config + explicit override ────────────────────────────
#
# run: [
#   {"configuration": "Conf_Base", "override": {"args": {"speed": "boosted", "extra": "yes"}}},
#   {"configuration": "Conf_Fast", "override": {"args": {"extra": "turbo"}}}
# ]
#
# Each entry has both "configuration" (selects the named base) and "override"
# (merged on top).  Inherited args that are not re-specified remain unchanged.
#
# Expected:
#   rank 0: source=named_config  speed=boosted  extra=yes   (Conf_Base with speed overridden)
#   rank 1: source=named_config  speed=fast     extra=turbo (Conf_Fast with extra added)
#
ByNamedAndOverride() {
  local rank="${THEJOB_STEP_RANK_ID}"
  echo "=== ByNamedAndOverride rank=${rank} | source=${source} speed=${speed} extra=${extra}" 1>&2

  check "ByNamedAndOverride" "${rank}" "source" "named_config" "${source}"
  case "${rank}" in
    0)
      check "ByNamedAndOverride" "${rank}" "speed" "boosted" "${speed}"
      check "ByNamedAndOverride" "${rank}" "extra" "yes"     "${extra}"
      ;;
    1)
      check "ByNamedAndOverride" "${rank}" "speed" "fast"    "${speed}"
      check "ByNamedAndOverride" "${rank}" "extra" "turbo"   "${extra}"
      ;;
  esac
}

# ─── Mechanism 4: Step-level configuration ───────────────────────────────────
#
# "configuration": {"args": {"source": "step_level", "base": "common", "mode": "default"}}
# run: [
#   {"args": {"variant": "A", "mode": "overridden"}},
#   {"args": {"variant": "B"}}
# ]
#
# The step-level "configuration" is pushed onto the override stack first,
# then the run entry is applied on top.
#
# - Keys present only in the step-level config are inherited by all runs.
# - Keys present in both are won by the run entry.
# - Keys present only in the run entry are added.
#
# Expected:
#   rank 0: source=step_level  base=common  variant=A  mode=overridden  (run entry wins on mode)
#   rank 1: source=step_level  base=common  variant=B  mode=default     (no run-level mode → step wins)
#
ByStepConfig() {
  local rank="${THEJOB_STEP_RANK_ID}"
  echo "=== ByStepConfig rank=${rank} | source=${source} base=${base} variant=${variant} mode=${mode}" 1>&2

  check "ByStepConfig" "${rank}" "source"  "step_level" "${source}"
  check "ByStepConfig" "${rank}" "base"    "common"     "${base}"
  case "${rank}" in
    0)
      check "ByStepConfig" "${rank}" "variant" "A"          "${variant}"
      check "ByStepConfig" "${rank}" "mode"    "overridden" "${mode}"
      ;;
    1)
      check "ByStepConfig" "${rank}" "variant" "B"       "${variant}"
      check "ByStepConfig" "${rank}" "mode"    "default" "${mode}"
      ;;
  esac
}

# ─── nb_retry: intentional first-attempt failure ─────────────────────────────
#
# run: [
#   {"nb_retry": 2, "args": {"label": "with_retry"}},
#   {"nb_retry": 1, "args": {"label": "no_retry"}}
# ]
#
# nb_retry=2 means 2 attempts are created; the scheduler runs attempt 1 only
# if attempt 0 exits non-zero.  nb_retry=1 means a single attempt (no retry).
#
# The step intentionally fails on attempt_id=0 for rank 0 to exercise the
# retry path.  A marker file is written so that attempt 1 can prove it ran
# after a real failure.
#
# Expected:
#   rank 0 attempt 0: returns 1  (triggers retry, writes marker)
#   rank 0 attempt 1: attempt=1  marker exists
#   rank 1 attempt 0: attempt=0  label=no_retry  (no retry ever runs)
#
ByNbRetry() {
  local rank="${THEJOB_STEP_RANK_ID}"
  local attempt="${THEJOB_STEP_ATTEMPT_ID}"
  local marker="${THEJOB_OUT_PATH}/retry_marker_rank${rank}.txt"
  echo "=== ByNbRetry rank=${rank} attempt=${attempt} | label=${label}" 1>&2

  if [ "${label}" = "with_retry" ]; then
    if [ "${attempt}" = "0" ]; then
      echo "attempt 0: intentional failure to trigger retry" 1>&2
      echo "failed" > "${marker}"
      return 1
    fi
    # attempt 1: the retry
    check "ByNbRetry" "${rank}" "attempt"      "1"   "${attempt}"
    check "ByNbRetry" "${rank}" "marker_exists" "yes" \
      "$([ -f "${marker}" ] && echo 'yes' || echo 'no')"
  else
    # no_retry: single attempt, must be attempt 0
    check "ByNbRetry" "${rank}" "attempt" "0"        "${attempt}"
    check "ByNbRetry" "${rank}" "label"   "no_retry" "${label}"
  fi
}

# ─── Summary ──────────────────────────────────────────────────────────────────
Summary() {
  echo "=== Summary ===" 1>&2

  local results="${THEJOB_OUT_PATH}/results.txt"
  if [ ! -f "${results}" ]; then
    echo "ERROR: results file not found at ${results}" 1>&2
    return 1
  fi

  cat "${results}" 1>&2
  echo "" 1>&2

  local total
  local fails
  total=$(wc -l < "${results}")
  fails=$(grep -c "^FAIL" "${results}" || true)
  local passed=$((total - fails))

  echo "Result: ${passed}/${total} checks passed" 1>&2
  CreateArtefact "${results}" "config_override_results.txt"

  if [ "${fails}" -eq 0 ]; then
    echo "ALL CHECKS PASSED" 1>&2
    return 0
  else
    echo "FAILED: ${fails} check(s) failed" 1>&2
    return 1
  fi
}
