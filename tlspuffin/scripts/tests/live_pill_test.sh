#!/bin/bash
# live_pill_test.sh: the pill of the top bar for the objectives of running tasks (scheduler/html/board/nav.js, from
# objectives/live.json) in a headless Chrome, live.json answered in the page: a task whose bugs are all known is not
# announced, nor one without level; unexpected: yellow; new: red with 🚨 and the number of new bugs. And the bench's
# icon is declared (no /favicon.ico).
set -euo pipefail
here=$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )
bench=$( cd "${here}/../../.." && pwd )
chrome=$( command -v google-chrome || command -v chromium || command -v chromium-browser || true )
[ -n "${chrome}" ] || { echo "SKIP: no Chrome or Chromium"; exit 0; }
work=$( mktemp -d ); server=
trap '[ -n "${server}" ] && kill "${server}" 2> /dev/null; rm -rf "${work}"' EXIT
mkdir -p "${work}/board"
command cp -f "${bench}/scheduler/html/board/"{nav,hostlinks,tips}.js "${work}/board/"
cat > "${work}/board/test.html" <<'EOF'
<!doctype html><html><head><meta charset="utf-8"><title>running</title></head><body><pre id="out"></pre>
<script type="module">
const out = document.getElementById('out');
let fail = 0;
const check = (ok, what) => { out.textContent += `${ok ? 'ok  ' : 'FAIL'} ${what}\n`; if (!ok) fail = 1; };
const task = (name, job_type, level, extra = {}) => ({ task: name, name, job_type, level, found: 3, bugs: 1, new: 0, ...extra });
let live = { tasks: [] };
window.fetch = async (url) => {
  url = String(url);
  if (url.endsWith('/objectives/live.json')) return new Response(JSON.stringify(live), { status: 200 });
  return new Response('{}', { status: 404 });
};
const settle = (ms = 300) => new Promise(resolve => setTimeout(resolve, ms));
await import('./nav.js');
const pill = () => document.querySelector('.pb-live');
const poll = async (tasks) => { live = { tasks }; window.dispatchEvent(new Event('pb-refresh')); await settle(); };
check(!!document.querySelector('link[rel~="icon"]'), 'the bench\'s icon declared');
await poll([task('Perf known', 'perf', 'known')]);
check(pill()?.hidden === true, 'a task whose bugs are all known: not announced');
await poll([task('Perf known', 'perf', 'known'), task('Perf odd', 'perf', 'unexpected')]);
check(pill()?.hidden === false && !pill().classList.contains('new') && /1 bug found live \(1 task\)/.test(pill().textContent),
  `unexpected: announced, yellow (${pill()?.textContent})`);
await poll([task('Vuln C', 'vuln-custom', 'new', { new: 2 }), task('Perf odd', 'perf', 'unexpected')]);
check(pill()?.classList.contains('new') && /🚨 2 new bugs found live \(2 tasks\)/.test(pill().textContent),
  `a new bug, even in a Vuln job: red, 🚨 (${pill()?.textContent})`);
await poll([task('old Perf', 'perf', null), task('old VulnA', 'vuln-a', null)]);
check(pill()?.hidden === true, 'tasks without level: not announced');
document.title = fail ? 'FAILED' : 'PASSED';
</script></body></html>
EOF
port=$( python3 -I -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])' )
python3 -I -m http.server "${port}" --bind 127.0.0.1 --directory "${work}" > /dev/null 2>&1 & server=$!
for _ in $( seq 1 50 ); do python3 -I -c "import socket; socket.create_connection(('127.0.0.1', ${port}), 1)" 2> /dev/null && break; sleep 0.1; done
dom=$( timeout 60 "${chrome}" --headless=new --disable-gpu --no-sandbox --user-data-dir="${work}/chrome" \
  --virtual-time-budget=10000 --dump-dom "http://127.0.0.1:${port}/board/test.html" 2> /dev/null )
python3 -I -c '
import html, re, sys
dom = sys.stdin.read()
m = re.search(r"<pre id=\"out\">(.*?)</pre>", dom, re.S)
print(html.unescape(m.group(1)).rstrip() if m else "FAIL the page did not run")
sys.exit(0 if m and "<title>PASSED</title>" in dom else 1)' <<< "${dom}"
