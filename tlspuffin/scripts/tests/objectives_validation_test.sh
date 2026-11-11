#!/bin/bash
# objectives_validation_test.sh: the objectives page (objectives_page/report.js, bugs.js BugValidation) with the
# validation of the objectives against tlspuffin's catalogue, in a headless Chrome, on a report written for it (the
# verdicts by "<attempt>/<trace>" as the summary scripts merge them; the catalogue answered in the page):
#   - a claim shared by three bugs: its objectives confirmed by patch (✔), by signature only (≈, bugs without patch), one
#     inconclusive, each with how many; the bug named after the one confirmed by patch, linked to the Bugs reference;
#   - a crash with the signature of a bug that has a patch there, not removed by it: ⚠ to review;
#   - a crash with no known signature on the build with every patch: 🚨;
#   - a crash none of whose objectives was validated: ○ the signature of the catalogue's bug, not validated;
#   - a crash removed by the patch of a bug without giving its signature: ⚠ another signature, to review;
#   - the tiles: confirmed by patch, by signature, to review, without known signature; a bug confirmed is never 🚨 new.
set -euo pipefail
here=$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )
tools=$( cd "${here}/../tools" && pwd )
chrome=$( command -v google-chrome || command -v chromium || command -v chromium-browser || true )
[ -n "${chrome}" ] || { echo "SKIP: no Chrome or Chromium"; exit 0; }
work=$( mktemp -d ); server=
trap '[ -n "${server}" ] && kill "${server}" 2> /dev/null; rm -rf "${work}"' EXIT
pages="${work}/html/objectives"
mkdir -p "${pages}" "${work}/html/board" "${work}/html/common" "${work}/html/jobsscripts/tlspuffin"
command cp -f "${tools}/objectives_page/"{report.js,report.css,bugs.js} "${pages}/"
command cp -f "${here}/../../data/html/common/commitinfo.js" "${work}/html/common/"
echo '' > "${work}/html/board/nav.js"
echo '{}' > "${work}/html/jobsscripts/tlspuffin/vuln_targets.json"
sha=b1d572b94052db08f752a1bb7e37b96814878855
cat > "${pages}/catalogue.json" <<EOF
{ "commit": "${sha}", "format": "vulnerabilities.toml", "vendors": { "wolfssl": { "entries": {
  "CVE-2021-3336": { "oracle": { "kind": "claim", "violation": "Authentication bypass" }, "patches": [{ "versions": ">= 4.4.0, < 4.7.0" }] },
  "CVE-2022-25638": { "alias": "SIG", "oracle": { "kind": "claim", "violation": "Authentication bypass" } },
  "CVE-2022-25640": { "alias": "SKIP", "oracle": { "kind": "claim", "violation": "Authentication bypass" } },
  "CVE-2022-42905": { "alias": "HEAP", "oracle": { "kind": "crash", "asan": "heap-buffer-overflow" }, "top_frames": ["AddPacketInfo"] },
  "CVE-2022-39173": { "alias": "BUF", "oracle": { "kind": "crash", "asan": "stack-buffer-overflow" }, "top_frames": ["RefineSuites"] } } } } }
EOF
cat > "${pages}/7.json" <<EOF
{ "task": "7", "commit": "${sha}", "name": "Vuln C - test", "job_type": "vuln-custom",
  "libraries": [{ "library": "custom_X", "runs": 1, "validation": { "catalogue": { "source": "commit", "commit": "${sha}" }, "byTrace": {
    "0/a1": { "verdict": "confirmed", "entries": ["CVE-2021-3336"], "known_unpatched": [] },
    "0/a2": { "verdict": "confirmed", "entries": ["CVE-2021-3336"], "known_unpatched": [] },
    "0/a3": { "verdict": "not-patched", "entries": [], "known_unpatched": ["CVE-2022-25638", "CVE-2022-25640"] },
    "0/a4": { "verdict": "inconclusive", "entries": [], "known_unpatched": [] },
    "0/h1": { "verdict": "not-patched", "entries": [], "known_unpatched": [] },
    "0/n1": { "verdict": "not-patched", "entries": [], "known_unpatched": [] },
    "0/o1": { "verdict": "other-signature", "entries": [], "known_unpatched": [], "other_signature": ["CVE-2022-39173"] } } } }],
  "runs": [{ "library": "custom_X", "attempt": 0, "found": 8, "replayed": 8, "reports": 8,
    "cli": { "vendor": "wolfssl:wolfssl440-asan-only-CVE-2021-3336", "library": { "name": "wolfssl", "version": "440" } },
    "groups": [
      { "type": "security-violation", "frames": ["Authentication bypass"], "count": 4, "traces": ["a1", "a2", "a3", "a4"], "excerpt": "",
        "fuzzer": { "kind": "claim", "detail": "Authentication bypass", "frames": [] } },
      { "type": "heap-buffer-overflow", "frames": ["AddPacketInfo", "DoTls13HandShakeMsgType"], "count": 1, "traces": ["h1"], "excerpt": "" },
      { "type": "heap-buffer-overflow", "frames": ["NewFunction", "Caller"], "count": 1, "traces": ["n1"], "excerpt": "" },
      { "type": "stack-buffer-overflow", "frames": ["RefineSuites", "CheckPreSharedKeys"], "count": 1, "traces": ["b1"], "excerpt": "" },
      { "type": "heap-use-after-free", "frames": ["FreeKeyExchange", "Caller"], "count": 1, "traces": ["o1"], "excerpt": "" } ] }] }
EOF
# the page, with the git_restapi of the catalogue answered from the file
cat > "${pages}/7.html" <<'EOF'
<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="report.css"><title>loading</title></head>
<body><div id="report" data-json="7.json"></div>
<script>
const realFetch = window.fetch.bind(window);
window.fetch = (url, options) => String(url).includes('/api/git/catalogue/') ? realFetch('catalogue.json') : realFetch(url, options);
</script>
<script type="module" src="report.js"></script></body></html>
EOF
port=$( python3 -I -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])' )
python3 -I -m http.server "${port}" --bind 127.0.0.1 --directory "${work}" > /dev/null 2>&1 & server=$!
for _ in $( seq 1 50 ); do python3 -I -c "import socket; socket.create_connection(('127.0.0.1', ${port}), 1)" 2> /dev/null && break; sleep 0.1; done
timeout 90 "${chrome}" --headless=new --disable-gpu --no-sandbox --user-data-dir="${work}/chrome" --virtual-time-budget=10000 \
  --dump-dom "http://127.0.0.1:${port}/html/objectives/7.html" > "${work}/dom.html" 2> /dev/null || true
python3 -I - "${work}/dom.html" <<'PY'
import re, sys
dom = open(sys.argv[1], encoding='utf-8').read()
fail = 0
def check(what, ok):
    global fail
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fail = 1
def row(letter):
    m = re.search(r'id="bug-%s".*?</details>' % letter, dom, re.S)
    return m.group(0) if m else ''
claim = row('A')
check('the claim: confirmed by patch x2', 'val val-patch' in claim and 'CVE-2021-3336</a> ×2' in claim)
check('the claim: signature only, SIG or SKIP x1', 'val val-signature' in claim
      and re.search(r'SIG · CVE-2022-25638</a> or <a[^>]*>SKIP · CVE-2022-25640</a> · signature ×1', claim) is not None)
check('the claim: inconclusive x1, 4 of 4 validated', '? inconclusive ×1' in claim and '4 of 4 objectives validated' in claim)
check('the claim: names link to the Bugs reference', 'bugs.html#CVE-2021-3336' in claim)
check('the claim: named after the bug confirmed by patch', re.search(r'class="bugletter"><span class="chev"[^>]*>▸</span> CVE-2021-3336</span>', claim) is not None)
check('a crash with the signature of HEAP, which has a patch there, not removed by it: to review',
      re.search(r'val val-unpatched[^>]*>⚠ signature of <a[^>]*>HEAP · CVE-2022-42905</a>, not removed by its patch ×1', dom) is not None)
check('a crash without known signature on the build with every patch', re.search(r"val val-new[^>]*>🚨 no known bug.s signature ×1", dom) is not None)
check('a crash not validated: the signature of BUF, without proof',
      re.search(r'val val-none[^>]*>○ the signature of <a[^>]*>BUF · CVE-2022-39173</a> · not validated', dom) is not None)
check('a crash removed by the patch of BUF without its signature: to review',
      re.search(r'val val-other[^>]*>⚠ removed by the patch of <a[^>]*>BUF · CVE-2022-39173</a>, another signature ×1', dom) is not None)
for n, tile in [(1, 'bug confirmed by patch'), (1, 'by their signature only'), (2, 'to review'), (1, 'without known signature')]:
    check('tile: %d %s' % (n, tile), '<b>%d</b><span>%s</span>' % (n, tile) in dom)
check('a bug confirmed by validation is never flagged new', 'new-bug-badge' not in claim)
sys.exit(fail)
PY
