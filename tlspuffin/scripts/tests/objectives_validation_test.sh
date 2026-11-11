#!/bin/bash
# objectives_validation_test.sh: the objectives page (objectives_page/report.js, bugs.js AnalyseReport, BugValidation) with
# the validation of the objectives against tlspuffin's catalogue, in a headless Chrome, on a report written for it (the
# verdicts by "<attempt>/<trace>" as the summary scripts merge them; the catalogue answered in the page), in the words
# of common/verdicts.js:
#   - a claim shared by three bugs: its objectives confirmed by patch (✔), by signature only (≈, bugs without patch,
#     the signature itself shown), one not reproduced on the validation builds, each with how many; the bug named after
#     the one confirmed by patch, linked to the Bugs reference;
#   - a crash with no known signature on the build with every patch: 🚨, and when its stack looks like a bug patched
#     there (the catalogue's top frames), said beside it; the bug is 🚨 NEW;
#   - the claim of a bug with a patch there, not removed by it (signature_of_patched): ⚠ to review;
#   - a crash with the weak signature of a bug without patch (SDOS2: any ASan SEGV): ≈ weak, dashed, not named after it;
#   - a crash none of whose objectives was validated: ○ the signature of the catalogue's bug, not validated;
#   - a crash removed by the patch of a bug without giving its signature: ⚠ another signature, to review;
#   - a crash the validation builds could not run: ⛔ could not replay, what failed on click;
#   - objectives without verdict: ○ no verdict, why (a run without validation result, beyond those validated);
#   - the tiles; the line of the validation (catalogue, bench, errors); the title (🚨 new bugs).
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
command cp -f "${here}/../../data/html/common/"{commitinfo,verdicts}.js "${work}/html/common/"
echo '' > "${work}/html/board/nav.js"
echo '{}' > "${work}/html/jobsscripts/tlspuffin/vuln_targets.json"
sha=b1d572b94052db08f752a1bb7e37b96814878855
cat > "${pages}/catalogue.json" <<EOF
{ "commit": "${sha}", "format": "vulnerabilities.toml", "vendors": { "wolfssl": { "entries": {
  "CVE-2021-3336": { "oracle": { "kind": "claim", "violation": "Authentication bypass" }, "patches": [{ "versions": ">= 4.4.0, < 4.7.0" }] },
  "CVE-2022-25638": { "alias": "SIG", "oracle": { "kind": "claim", "violation": "Authentication bypass" } },
  "CVE-2022-25640": { "alias": "SKIP", "oracle": { "kind": "claim", "violation": "Authentication bypass" } },
  "CVE-2022-42905": { "alias": "HEAP", "oracle": { "kind": "crash", "asan": "heap-buffer-overflow" }, "top_frames": ["AddPacketInfo"] },
  "CVE-2022-39173": { "alias": "BUF", "oracle": { "kind": "crash", "asan": "stack-buffer-overflow" }, "top_frames": ["RefineSuites"] },
  "CVE-2022-38152": { "alias": "SDOS2", "oracle": { "kind": "crash", "asan": "SEGV" } },
  "CVE-2099-0001": { "alias": "UAF", "oracle": { "kind": "crash", "asan": "heap-use-after-free" }, "top_frames": ["UafPlace"] },
  "CVE-2022-38153": { "alias": "CDOS", "oracle": { "kind": "crash", "asan": "bad-free" }, "replayable": false },
  "CVE-2024-5814": { "oracle": { "kind": "claim", "violation": "Negotiated cipher is not in agent's configured ciphers list" } } } } } }
EOF
cat > "${pages}/7.json" <<EOF
{ "task": "7", "commit": "${sha}", "name": "Vuln C - test", "job_type": "vuln-custom",
  "libraries": [{ "library": "custom_X", "runs": 2, "validation": { "catalogue": { "source": "commit", "commit": "${sha}" },
    "bench": [{ "commit": "c787eb89dd", "jobscripts": "2f35e8c1aa" }],
    "errors": [{ "attempt": 1, "error": "no validation result (its validation step failed or did not run)" }],
    "byTrace": {
    "0/a1": { "verdict": "confirmed", "entries": ["CVE-2021-3336"], "known_unpatched": [] },
    "0/a2": { "verdict": "confirmed", "entries": ["CVE-2021-3336"], "known_unpatched": [] },
    "0/a3": { "verdict": "not-patched", "entries": [], "known_unpatched": ["CVE-2022-25638", "CVE-2022-25640"] },
    "0/a4": { "verdict": "inconclusive", "entries": [], "known_unpatched": [] },
    "0/h1": { "verdict": "not-patched", "entries": [], "known_unpatched": [] },
    "0/n1": { "verdict": "not-patched", "entries": [], "known_unpatched": [] },
    "0/o1": { "verdict": "other-signature", "entries": [], "known_unpatched": [], "other_signature": ["CVE-2022-39173"] },
    "0/c1": { "verdict": "not-patched", "entries": [], "known_unpatched": [], "signature_of_patched": ["CVE-2024-5814"] },
    "0/s1": { "verdict": "not-patched", "entries": [], "known_unpatched": ["CVE-2022-38152"] },
    "0/u1": { "verdict": "not-patched", "entries": [], "known_unpatched": ["CVE-2099-0001"] },
    "0/u2": { "verdict": "not-patched", "entries": [], "known_unpatched": ["CVE-2099-0001"] },
    "0/d1": { "verdict": "inconclusive", "entries": [], "known_unpatched": [] },
    "0/e1": { "verdict": "error", "entries": [], "known_unpatched": [], "failure": { "build": "F", "message": "no outcome, exit status 2: error: unrecognized subcommand" } } } } }],
  "runs": [{ "library": "custom_X", "attempt": 0, "found": 16, "replayed": 16, "reports": 15,
    "cli": { "vendor": "wolfssl:wolfssl440-asan-only-CVE-2021-3336", "library": { "name": "wolfssl", "version": "440" } },
    "groups": [
      { "type": "security-violation", "frames": ["Authentication bypass"], "count": 4, "traces": ["a1", "a2", "a3", "a4"], "excerpt": "",
        "fuzzer": { "kind": "claim", "detail": "Authentication bypass", "frames": [] } },
      { "type": "heap-buffer-overflow", "frames": ["AddPacketInfo", "DoTls13HandShakeMsgType"], "count": 1, "traces": ["h1"], "excerpt": "" },
      { "type": "heap-buffer-overflow", "frames": ["NewFunction", "Caller"], "count": 1, "traces": ["n1"], "excerpt": "" },
      { "type": "stack-buffer-overflow", "frames": ["RefineSuites", "CheckPreSharedKeys"], "count": 1, "traces": ["b1"], "excerpt": "" },
      { "type": "heap-use-after-free", "frames": ["FreeKeyExchange", "Caller"], "count": 1, "traces": ["o1"], "excerpt": "" },
      { "type": "security-violation", "frames": ["Negotiated cipher is not in agent's configured ciphers list"], "count": 1, "traces": ["c1"], "excerpt": "" },
      { "type": "SEGV", "frames": ["__memmove_avx_unaligned_erms", "DoTls13ClientHello"], "count": 2, "traces": ["s1", "s2"], "excerpt": "" },
      { "type": "heap-use-after-free", "frames": ["UafPlace", "Caller"], "count": 1, "traces": ["u1"], "excerpt": "" },
      { "type": "heap-use-after-free", "frames": ["ElsewhereFn", "Caller"], "count": 1, "traces": ["u2"], "excerpt": "" },
      { "type": "no-crash", "frames": [], "count": 1, "traces": ["d1"], "excerpt": "",
        "fuzzer": { "kind": "crash", "detail": "SIGABRT · ASan bad-free", "frames": ["wolfSSL_Free", "AddSessionToCache"] } },
      { "type": "global-buffer-overflow", "frames": ["ParseThing", "Caller"], "count": 1, "traces": ["e1"], "excerpt": "" } ] },
    { "library": "custom_X", "attempt": 1, "found": 1, "replayed": 1, "reports": 1,
    "cli": { "vendor": "wolfssl:wolfssl440-asan-only-CVE-2021-3336", "library": { "name": "wolfssl", "version": "440" } },
    "groups": [
      { "type": "global-buffer-overflow", "frames": ["ParseThing", "Caller"], "count": 1, "traces": ["e2"], "excerpt": "" } ] }] }
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
check('the claim: confirmed by patch x2', 'val val-patch' in claim and 'CVE-2021-3336</a> · confirmed by patch ×2' in claim)
check('the claim: by its signature, SIG or SKIP x1, the signature shown, weak (one message, no stack)', 'val val-signature val-weak' in claim
      and re.search(r'SIG · CVE-2022-25638</a> or <a[^>]*>SKIP · CVE-2022-25640</a> · by its signature \(the claim “Authentication bypass”\) · weak: one message, no stack ×1', claim) is not None)
check('a crash whose stack has the top frame of the bug its signature names: strong, green, named after it',
      re.search(r'val val-signature"[^>]*>≈ <a[^>]*>UAF · CVE-2099-0001</a> · by its signature \(a crash with an ASan heap-use-after-free report\) · with its stack \(top frame UafPlace\) ×1', dom) is not None
      and re.search(r'class="bugletter"><span class="chev"[^>]*>▸</span> UAF', dom) is not None)
check('the same signature with another stack: weak, its stack without their top frames',
      re.search(r'val val-signature val-weak[^>]*>≈ <a[^>]*>UAF · CVE-2099-0001</a> · by its signature \(a crash with an ASan heap-use-after-free report\) · weak: its stack has none of their top frames \(UafPlace\) ×1', dom) is not None)
check('the claim: not reproduced on the validation builds x1, 4 of 4 validated', '? not reproduced on the validation builds ×1' in claim and '4 of 4 objectives validated' in claim)
check('the claim: names link to the Bugs reference, with their signature', 'bugs.html#CVE-2021-3336' in claim and 'its signature, the claim “Authentication bypass”' in claim)
check('the claim: named after the bug confirmed by patch', re.search(r'class="bugletter"><span class="chev"[^>]*>▸</span> CVE-2021-3336</span>', claim) is not None)
check('a crash without known signature whose stack looks like HEAP, patched there: 🚨, said beside it',
      re.search(r"val val-new[^>]*>🚨 no known bug.s signature ×1</span> <span class=\"val-note\"[^>]*>its stack looks like <a[^>]*>HEAP · CVE-2022-42905</a> \(patched here\): to review", dom) is not None)
check('a crash without known signature: 🚨 NEW BUG', dom.count('class="new-bug-badge"') >= 2)
check('the claim of a bug patched there, not removed by its patch: to review',
      re.search(r'val val-unpatched[^>]*>⚠ signature of <a[^>]*>CVE-2024-5814</a>, not removed by its patch ×1', dom) is not None)
check('a crash with the weak signature of SDOS2: weak, dashed, not named after it',
      re.search(r'val val-signature val-weak[^>]*>≈ <a[^>]*>SDOS2 · CVE-2022-38152</a> · by its signature \(a crash with an ASan SEGV report\) · weak: any crash with an ASan SEGV report matches ×1', dom) is not None
      and re.search(r'class="bugletter"><span class="chev"[^>]*>▸</span> SDOS2', dom) is None)
check('a crash not validated: the signature of BUF, without proof',
      re.search(r'val val-none[^>]*>○ the signature of <a[^>]*>BUF · CVE-2022-39173</a> · not validated', dom) is not None)
check('a crash removed by the patch of BUF without its signature: to review',
      re.search(r'val val-other[^>]*>⚠ removed by the patch of <a[^>]*>BUF · CVE-2022-39173</a>, another signature ×1', dom) is not None)
check('a crash the validation builds could not run: could not replay, what failed on click',
      re.search(r'val val-error" data-click-tip="[^"]*unrecognized subcommand[^"]*">⛔ could not replay ×1', dom) is not None)
check('an objective of a run without validation result: no verdict, why',
      re.search(r'val val-none[^>]*>○ no verdict: no validation result for its run \(its validation step failed or did not run\) ×1', dom) is not None)
check('an objective beyond those validated in its run: no verdict, why',
      re.search(r'val val-none[^>]*>○ no verdict: not among the objectives validated in its run[^<]*×1', dom) is not None)
for n, tile in [(1, 'bug confirmed by patch'), (1, 'bug by its signature and stack'), (3, 'bugs by a weak signature'), (2, 'to review'),
                (2, 'without known signature'), (1, 'could not replay')]:
    check('tile: %d %s' % (n, tile), '<b>%d</b><span>%s</span>' % (n, tile) in dom)
check('a bug confirmed by validation is never flagged new', 'class="new-bug-badge"' not in claim)
cdos = re.search(r'<details class="bug"[^>]*data-kind="no-replay"[^>]*>.*?</details>', dom, re.S)
check('a bug known not to replay (CDOS): shown under its own filter, "does not replay, as known", no warning',
      cdos is not None and ' hidden' not in cdos.group(0)[:200] and 'data-kind="no-replay"' in dom.split('id="bugs"')[0]
      and 'does not replay, as known' in cdos.group(0) and '⚠ not reproduced' not in cdos.group(0))
check('the line of the validation: its catalogue, the bench that validated, a run without result',
      'validated by the bench c787eb8 (job scripts 2f35e8c)' in dom and 'custom_X run 1: no validation result' in dom)
check('the title: the new bugs', re.search(r'<h1>🚨 2 NEW BUGS · ', dom) is not None)
check('the help: the words of the pages', '<dt>weak signature</dt>' in dom and 'could not replay' in dom)
sys.exit(fail)
PY
