#!/bin/bash
# objectives_placeholder_test.sh: the objectives pages of a task exist from its first objective (ObjectivesPlaceholders,
# PR_common.sh), as placeholders until the bench's tools write them, and the pages say when they come:
#   - the run's monitor writes live-<task>.html and <task>.html with their JSON, never over a page already there;
#   - in a headless Chrome (objectives_page/report.js): the live placeholder says its first replays are in progress and
#     by when; the final one, for a task the scheduler does not run, that its report is being written; a live page
#     says when its next update comes.
set -euo pipefail
here=$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )
scripts=$( cd "${here}/.." && pwd )
work=$( mktemp -d ); server=
trap '[ -n "${server}" ] && kill "${server}" 2> /dev/null; rm -rf "${work}"' EXIT
fail=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fail=1; fi; }

pages="${work}/html/objectives"
mkdir -p "${pages}" "${work}/html/board" "${work}/html/common"
source <( sed -n '/^ObjectivesPlaceholders()/,/^}/p' "${scripts}/PR_common.sh" )
# a task without page: both placeholders; a second call changes nothing
OBJECTIVES_PAGES_DIR="${pages}" THEJOB_TASK_ID=1700000000001 COMMIT_ID=b1d572b94052db08f752a1bb7e37b96814878855 ObjectivesPlaceholders
check 'the live placeholder and its JSON' '[ -s "${pages}/live-1700000000001.html" ] && jq -e ".placeholder == \"live\" and .live" "${pages}/live-1700000000001.json" > /dev/null'
check 'the final placeholder, pending its report, with the live page' 'jq -e ".placeholder == \"final\" and .pending_final and .live_page == \"live-1700000000001.html\"" "${pages}/1700000000001.json" > /dev/null'
check 'the schedule of the tools in them' 'jq -e ".refresh.live_every_s == 300 and .refresh.report_every_s == 600" "${pages}/1700000000001.json" > /dev/null'
sum=$( cat "${pages}"/*1700000000001* | md5sum )
OBJECTIVES_PAGES_DIR="${pages}" THEJOB_TASK_ID=1700000000001 ObjectivesPlaceholders
check 'a second call changes nothing' '[ "$( cat "${pages}"/*1700000000001* | md5sum )" == "${sum}" ]'
# a task whose live page the cron already wrote: kept as it is
echo '{"task":"1700000000002","live":true,"runs":[{"library":"x"}]}' > "${pages}/live-1700000000002.json"
OBJECTIVES_PAGES_DIR="${pages}" THEJOB_TASK_ID=1700000000002 ObjectivesPlaceholders
check 'never over a page the tools wrote' 'jq -e ".placeholder == null and (.runs | length) == 1" "${pages}/live-1700000000002.json" > /dev/null && [ -s "${pages}/1700000000002.json" ]'
check 'no temporary file left' '[ -z "$( find "${pages}" -name ".*" -type f )" ]'
check 'nothing without the pages folder' 'OBJECTIVES_PAGES_DIR="${work}/none" THEJOB_TASK_ID=1 ObjectivesPlaceholders && [ ! -e "${work}/none" ]'
# a live page written by the cron, with its schedule
jq -n --argjson now "$( date +%s )" '{ task: "1700000000003", live: true, updated: "now", runs: [],
    refresh: { live_every_s: 300, live_budget_s: 240, report_every_s: 600, updated_epoch: $now } }' > "${pages}/live-1700000000003.json"
cp "${pages}/live-1700000000001.html" "${pages}/live-1700000000003.html"
sed -i 's/live-1700000000001.json/live-1700000000003.json/' "${pages}/live-1700000000003.html"

chrome=$( command -v google-chrome || command -v chromium || command -v chromium-browser || true )
if [ -z "${chrome}" ]; then echo "SKIP the pages: no Chrome or Chromium"; exit "${fail}"; fi
command cp -f "${scripts}/tools/objectives_page/"{report.js,report.css,bugs.js} "${pages}/"
command cp -f "${scripts}/../data/html/common/"{commitinfo,verdicts}.js "${work}/html/common/"
echo '' > "${work}/html/board/nav.js"   # the navigation bar needs the bench
mkdir -p "${work}/html/jobsscripts/tlspuffin" && echo '{}' > "${work}/html/jobsscripts/tlspuffin/vuln_targets.json"
port=$( python3 -I -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])' )
python3 -I -m http.server "${port}" --bind 127.0.0.1 --directory "${work}" > /dev/null 2>&1 & server=$!
for _ in $( seq 1 50 ); do python3 -I -c "import socket; socket.create_connection(('127.0.0.1', ${port}), 1)" 2> /dev/null && break; sleep 0.1; done
page() { timeout 60 "${chrome}" --headless=new --disable-gpu --no-sandbox --user-data-dir="${work}/chrome" --virtual-time-budget=8000 \
  --dump-dom "http://127.0.0.1:${port}/html/objectives/$1" 2> /dev/null | tr '\n' ' '; }
live=$( page live-1700000000001.html )
check 'the live placeholder: first replays in progress, by when' 'grep -q "first replays are in progress" <<< "${live}" && grep -q "by about <b>" <<< "${live}"'
final=$( page 1700000000001.html )
check 'the final placeholder of a task not running: its report is being written, the live page meanwhile' \
  'grep -q "Its final report" <<< "${final}" && grep -q "href=\"live-1700000000001.html\"" <<< "${final}"'
next=$( page live-1700000000003.html )
check 'a live page says when its next update comes' 'grep -q "next update by about" <<< "${next}"'
exit "${fail}"
