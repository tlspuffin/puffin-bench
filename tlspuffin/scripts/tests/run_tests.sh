#!/bin/bash
# run_tests.sh <tlspuffin clone> [<commit>]: the quick tests of the bench, one after the other, and a summary: the
# scheduler's and the publisher's unit tests, a throwaway scheduler (scheduler/tests), and the tests of tlspuffin's job
# scripts and pages (this folder) on <commit> of the clone, a commit with tlspuffin's catalogue (default HEAD). Nothing
# real is built or run: the tests that build tlspuffin or a library are listed at the end, to run by hand.
# Environment:
#   BUILD_DIR  the CMake build folder of the bench (default <bench>/build): the unit tests and the scheduler binary
#   MK_VENDOR  mk_vendor of the clone (default <clone>/target/debug/mk_vendor), for custombench_test.sh
#   QJS        QuickJS (default /srv/puffin-bench/data/tools/qjs), for attach_validation_test.sh
# A test that lacks what it needs (Chrome, node, QuickJS, a binary) says SKIP. Exit status: 1 when a test failed.
set -uo pipefail
here=$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )
bench=$( cd "${here}/../../.." && pwd )
clone=$( realpath "${1:?usage: run_tests.sh <tlspuffin clone> [<commit>]}" ); commit="${2:-HEAD}"
build=$( realpath -m "${BUILD_DIR:-${bench}/build}" )
logs=$( mktemp -d ); trap 'rm -rf "${logs}"' EXIT
failed=(); skipped=(); passed=0

mk_vendor=$( realpath -m "${MK_VENDOR:-${clone}/target/debug/mk_vendor}" ); qjs=$( realpath -m "${QJS:-/srv/puffin-bench/data/tools/qjs}" )

# Run <name> <command...>: the test run from a folder of its own (some write in theirs: testFilesRing), its output kept
# for a failure, its verdict printed
Run() {
  local name="$1"; shift
  local log="${logs}/${name//\//_}.log" start=${SECONDS}
  if [[ "$1" == */* ]] && [ ! -x "$1" ] && [ ! -f "$1" ]; then
    printf 'SKIP %-40s (no %s)\n' "${name}" "$1"; skipped+=("${name}"); return
  fi
  mkdir -p "${logs}/${name}.cwd"
  ( cd "${logs}/${name}.cwd" && "$@" ) < "${INPUT:-/dev/null}" > "${log}" 2>&1; local status=$?
  if [ "${status}" -ne 0 ]; then
    printf 'FAIL %-40s %3ds\n' "${name}" "$(( SECONDS - start ))"; grep -E 'FAIL|rror|panicked|assert' "${log}" | head -20 | sed 's/^/       /'
    failed+=("${name}")
  elif grep -q '^SKIP' "${log}"; then
    printf 'SKIP %-40s %s\n' "${name}" "$( grep -m1 '^SKIP' "${log}" )"; skipped+=("${name}")
  else
    printf 'ok   %-40s %3ds\n' "${name}" "$(( SECONDS - start ))"; passed=$(( passed + 1 ))
  fi
}

# the services
Run testStepParameters "${build}/scheduler/testStepParameters"
Run testBenchmarksAPI "${build}/scheduler/testBenchmarksAPI"
# the output rings read their standard input to its end (throughput tools): 8 MB
head -c 8M /dev/zero > "${logs}/8M"
INPUT="${logs}/8M" Run testFilesRing "${build}/scheduler/testFilesRing"
INPUT="${logs}/8M" Run testOutputRing "${build}/scheduler/testOutputRing"
Run testFilePath "${build}/publisher/testFilePath"
Run testCpuTopology "${build}/scheduler/testCpuTopology"
Run history_cancelled_test bash "${bench}/scheduler/tests/history_cancelled_test.sh" "${build}/scheduler/scheduler"

# the job scripts and the pages
Run attach_validation_test bash "${here}/attach_validation_test.sh" "" "${qjs}"
Run bugs_page_test bash "${here}/bugs_page_test.sh" "${clone}" "${commit}"
Run custombench_test env MK_VENDOR="${mk_vendor}" bash "${here}/custombench_test.sh" "${clone}" "${commit}"
Run custom_target_test bash "${here}/custom_target_test.sh" "${clone}" "${commit}"
Run launcher_custom_test bash "${here}/launcher_custom_test.sh" "${clone}" "${commit}"
Run saved_benchmarks_test bash "${here}/saved_benchmarks_test.sh" "${clone}" "${commit}"
Run objectives_placeholder_test bash "${here}/objectives_placeholder_test.sh"
Run objectives_validation_test bash "${here}/objectives_validation_test.sh"
Run validation_cache_test bash "${here}/validation_cache_test.sh"
Run validation_choice_test bash "${here}/validation_choice_test.sh"
Run live_validation_test bash "${here}/live_validation_test.sh"
Run perf_objectives_test bash "${here}/perf_objectives_test.sh"
Run validation_verdict_test bash "${here}/validation_verdict_test.sh"
Run words_doc_test bash "${here}/words_doc_test.sh" "${qjs}"
Run report_verdicts_test bash "${here}/report_verdicts_test.sh" "${qjs}"
Run live_pill_test bash "${here}/live_pill_test.sh"
Run asan_type_test bash "${here}/asan_type_test.sh"
Run results_validation_test bash "${here}/results_validation_test.sh"

echo
echo "${passed} passed, ${#failed[@]} failed${failed[*]:+ (${failed[*]})}, ${#skipped[@]} skipped${skipped[*]:+ (${skipped[*]})}"
echo "Not run here (real builds of tlspuffin and of libraries, long): validate_step_test.sh, inrun_confirm_test.sh;"
echo "compat_selftest.sh <unshallowed clone> (every first-parent commit of dev)."
[ "${#failed[@]}" -eq 0 ]
