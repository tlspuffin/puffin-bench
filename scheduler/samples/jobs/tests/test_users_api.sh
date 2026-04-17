#!/bin/bash
#
# Test script for the users API endpoints:
#   GET /api/users
#   GET /api/user/<user>/job_types
#   GET /api/user/<user>/<job_type>/tasks
#
# Usage:
#   ./test_users_api.sh [host] [port]
#
# Prerequisites:
#   - Server running with samples/config.json
#   - samples/users.json copied to <exportPath>/users.json
#     e.g.: cp samples/users.json exports/schedule/users.json

HOST="${1:-127.0.0.1}"
PORT="${2:-8080}"
BASE="http://${HOST}:${PORT}"

PASS=0
FAIL=0

check() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  if echo "${actual}" | grep -q "${expected}"; then
    echo "OK   ${label}"
    PASS=$((PASS + 1))
  else
    echo "FAIL ${label}"
    echo "     expected to contain: ${expected}"
    echo "     got: ${actual}"
    FAIL=$((FAIL + 1))
  fi
}

check_absent() {
  local label="$1"
  local absent="$2"
  local actual="$3"
  if echo "${actual}" | grep -q "${absent}"; then
    echo "FAIL ${label} (should not contain '${absent}')"
    echo "     got: ${actual}"
    FAIL=$((FAIL + 1))
  else
    echo "OK   ${label}"
    PASS=$((PASS + 1))
  fi
}

echo "=== Users API tests against ${BASE} ==="
echo ""

# ── GET /api/users ─────────────────────────────────────────────────────────────
echo "--- GET /api/users"
resp=$(curl -sf "${BASE}/api/users")
check        "users: success=true"  '"success": true'  "${resp}"
check        "users: alice present" '"alice"'           "${resp}"
check        "users: bob present"   '"bob"'             "${resp}"
check_absent "users: no unknown"    '"unknown"'         "${resp}"
echo ""

# ── GET /api/user/alice/job_types ──────────────────────────────────────────────
echo "--- GET /api/user/alice/job_types"
resp=$(curl -sf "${BASE}/api/user/alice/job_types")
check        "alice job_types: success=true"              '"success": true'  "${resp}"
check        "alice job_types: perf present"              '"perf"'           "${resp}"
check        "alice job_types: vulnerabilities present"   '"vulnerabilities"' "${resp}"
check_absent "alice job_types: no debug"                  '"debug"'          "${resp}"
echo ""

# ── GET /api/user/bob/job_types ────────────────────────────────────────────────
echo "--- GET /api/user/bob/job_types"
resp=$(curl -sf "${BASE}/api/user/bob/job_types")
check        "bob job_types: success=true"    '"success": true' "${resp}"
check        "bob job_types: perf present"    '"perf"'          "${resp}"
check        "bob job_types: debug present"   '"debug"'         "${resp}"
check_absent "bob job_types: no perf-extra"   '"perf-extra"'    "${resp}"
echo ""

# ── GET /api/user/alice/perf/tasks ────────────────────────────────────────────
echo "--- GET /api/user/alice/perf/tasks"
resp=$(curl -sf "${BASE}/api/user/alice/perf/tasks")
check        "alice/perf tasks: success=true"      '"success": true' "${resp}"
check        "alice/perf tasks: id 1712000000000"  '1712000000000'   "${resp}"
check        "alice/perf tasks: id 1712200000000"  '1712200000000'   "${resp}"
check        "alice/perf tasks: name PR_perf_full" 'PR_perf_full'    "${resp}"
check        "alice/perf tasks: running flag"      '"running"'       "${resp}"
check        "alice/perf tasks: cancelled flag"    '"cancelled"'     "${resp}"
echo ""

# ── GET /api/user/alice/vulnerabilities/tasks ─────────────────────────────────
echo "--- GET /api/user/alice/vulnerabilities/tasks"
resp=$(curl -sf "${BASE}/api/user/alice/vulnerabilities/tasks")
check        "alice/vuln tasks: success=true"    '"success": true'         "${resp}"
check        "alice/vuln tasks: cancelled entry" '"cancelled":true'        "${resp}"
check        "alice/vuln tasks: name vuln_full"  'PR_vulnerabilities_full' "${resp}"
echo ""

# ── GET /api/user/bob/debug/tasks ─────────────────────────────────────────────
echo "--- GET /api/user/bob/debug/tasks"
resp=$(curl -sf "${BASE}/api/user/bob/debug/tasks")
check        "bob/debug tasks: success=true"      '"success": true' "${resp}"
check        "bob/debug tasks: id 1712020000000"  '1712020000000'   "${resp}"
check        "bob/debug tasks: name PR_debug_run" 'PR_debug_run'    "${resp}"
echo ""

# ── Unknown user ───────────────────────────────────────────────────────────────
echo "--- GET /api/user/nobody/job_types (unknown user)"
resp=$(curl -s "${BASE}/api/user/nobody/job_types")
check_absent "unknown user: no success=true" '"success": true' "${resp}"
echo ""

# ── Unknown job_type ───────────────────────────────────────────────────────────
echo "--- GET /api/user/alice/nojobtype/tasks (unknown job_type)"
resp=$(curl -s "${BASE}/api/user/alice/nojobtype/tasks")
check_absent "unknown job_type: no success=true" '"success": true' "${resp}"
echo ""

# ── Summary ────────────────────────────────────────────────────────────────────
echo "=========================="
echo "Result: ${PASS} passed, ${FAIL} failed"
if [ "${FAIL}" -eq 0 ]; then
  echo "ALL CHECKS PASSED"
  exit 0
else
  echo "SOME CHECKS FAILED"
  exit 1
fi
