#!/bin/bash
# launcher_custom_test.sh <tlspuffin clone with the catalogue> [<commit>]: the whole launcher (joblauncher.js with its
# custom benchmark panel, custombench.js) in a headless Chrome, on the catalogue and presets of the commit
# (git_restapi's scripts), the scheduler's store of saved benchmarks answered in the page:
#   - Load sets everything the benchmark was saved with: its bugs, attempts, cores per attempt, and the launcher's own
#     timeout and CPU sharing;
#   - 💾 Save keeps the launcher's timeout and CPU sharing with the panel's settings.
# The board's navigation bar is left out (nav.js: a stub), as in bugs_page_test.sh.
set -euo pipefail
here=$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )
bench=$( cd "${here}/../../.." && pwd )
clone="${1:?usage: launcher_custom_test.sh <tlspuffin clone> [<commit>]}"; commit="${2:-HEAD}"
chrome=$( command -v google-chrome || command -v chromium || command -v chromium-browser || true )
[ -n "${chrome}" ] || { echo "SKIP: no Chrome or Chromium"; exit 0; }
work=$( mktemp -d ); server=
trap '[ -n "${server}" ] && kill "${server}" 2> /dev/null; rm -rf "${work}"' EXIT
sha=$( git -C "${clone}" rev-parse "${commit}" )
mkdir -p "${work}/html/board/launchers/tlspuffin" "${work}/html/common" "${work}/git"
command cp -f "${bench}/tlspuffin/data/html/board/launchers/tlspuffin/"*.{js,json,css} "${work}/html/board/launchers/tlspuffin/"
command cp -f "${bench}/tlspuffin/data/html/common/"*.js "${work}/html/common/"
echo 'export async function CheckScheduler() { return {}; }' > "${work}/html/board/nav.js"
"${bench}/git_restapi/scripts/tlspuffin_catalogue.sh" "${clone}" "${sha}" > "${work}/git/catalogue.json"
"${bench}/git_restapi/scripts/tlspuffin_presets.sh" "${clone}" "${sha}" > "${work}/git/presets.json"
date=$( git -C "${clone}" log -1 --format=%cs "${sha}" )
printf '{ "commits": [ { "id": "%s", "date": "%s", "comment": "the commit under test", "branch": "dev" } ], "branches": [], "PR": [] }\n' \
  "${sha}" "${date}" > "${work}/git/history.json"
cat > "${work}/html/test.html" <<EOF
<!doctype html><html><head><meta charset="utf-8"><title>running</title>
<link rel="stylesheet" href="board/launchers/tlspuffin/joblauncher.css"></head><body><pre id="out"></pre>
<script>globalThis.GIT_RESTAPI_PORT = 1; globalThis.SCHEDULER_PORT = 2; globalThis.VIS_COMPARATOR_PORT = 3; const SHA = '${sha}';</script>
<script type="module">
EOF
cat >> "${work}/html/test.html" <<'EOF'
const out = document.getElementById('out');
let fail = 0;
const check = (ok, what) => { out.textContent += `${ok ? 'ok  ' : 'FAIL'} ${what}\n`; if (!ok) fail = 1; };
const store = {
  VulnT: { saved_at: Date.now(), definition: { name: 'VulnT', description: 'saved with everything', others: 'patched',
    catalogue: { source: 'commit', commit: SHA }, attempts: 2, cores: 7, timeout: { d: 0, h: 1, m: 5 }, smt: 'one',
    experiments: [{ bug: 'CVE-2021-3336' }, { bug: 'CVE-2021-3449' }] } },
};
const realFetch = window.fetch.bind(window);
window.fetch = async (url, options = {}) => {
  url = String(url);
  const method = options.method ?? 'GET';
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  let m;
  if (url.includes('/api/git/history/')) return realFetch('/git/history.json');
  if (url.includes(`/api/git/presets/tlspuffin/${SHA}`)) return realFetch('/git/presets.json');
  if (url.includes(`/api/git/catalogue/tlspuffin/${SHA}`)) return realFetch('/git/catalogue.json');
  if (url.includes('/api/git/catalogue/tlspuffin/dev')) return json(200, { commit: '0'.repeat(40), format: 'none' });
  if (url.endsWith('/api/benchmarks/tlspuffin')) return json(200, { success: true, data: structuredClone(store) });
  if ((m = /\/api\/benchmarks\/tlspuffin\/([A-Za-z0-9-]+)$/.exec(url)) && method === 'PUT') {
    store[m[1]] = { saved_at: Date.now(), definition: JSON.parse(options.body) };
    return json(200, { success: true });
  }
  if (url.includes('/html/board/') || url.includes('/html/common/')) return realFetch(url);
  return new Response('', { status: 404 });
};
window.confirm = () => true;
const settle = (ms = 400) => new Promise(resolve => setTimeout(resolve, ms));
const until = async (test, ms = 8000) => { for (let t = 0; t < ms && !test(); t += 100) await settle(100); return test(); };
const { JobLauncher } = await import('./board/launchers/tlspuffin/joblauncher.js');
const launcher = new JobLauncher();
const $ = selector => document.querySelector(selector);
const timeout = () => [...document.querySelectorAll('.jl-timeout-section input')].map(i => i.value).join(':');
const smt = () => [...document.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === 'pairs'));
try {
  // the launcher on the commit, job type Vuln — custom (as "New task…" opens it)
  launcher.open({ jobType: 'vuln-custom', commit: SHA });
  check(await until(() => document.querySelectorAll('.jl-custom-bugs tr[data-id]').length > 0), 'the custom panel lists the bugs of the commit');
  check(await until(() => $('.jl-custom-saved').value === 'VulnT'), 'VulnT among the saved benchmarks');
  // the task's name: "Vuln C - <commit>" while the benchmark has the default name
  check(/^Vuln C - /.test($('.jl-task-name').value), `the task is named Vuln C until the benchmark has a name (${$('.jl-task-name').value})`);
  $('.jl-custom-open').click();
  await settle();
  const ticked = [...document.querySelectorAll('.jl-custom-bugs tr[data-id]')].filter(r => r.querySelector('input').checked).map(r => r.dataset.id);
  check(ticked.sort().join() === 'CVE-2021-3336,CVE-2021-3449', `Load ticks its bugs (${ticked.join(', ')})`);
  check(/^Vuln VulnT - /.test($('.jl-task-name').value), `then after its name (${$('.jl-task-name').value})`);
  check($('.jl-custom-attempts').value === '2' && $('.jl-custom-cores').value === '7',
    `Load sets attempts and cores per attempt (${$('.jl-custom-attempts').value} × ${$('.jl-custom-cores').value})`);
  check(timeout() === '0:1:5', `Load sets the launcher's timeout (${timeout()})`);
  check(smt()?.value === 'one', `Load sets the launcher's CPU sharing (${smt()?.value})`);
  check($('.jl-custom-savedinfo').textContent.includes('timeout 1 h 05') && $('.jl-custom-savedinfo').textContent.includes('CPU sharing one'),
    'the saved benchmark says its timeout and CPU sharing');

  // 💾 Save keeps the launcher's fields with the panel's
  const [d, h, m] = document.querySelectorAll('.jl-timeout-section input');
  d.value = '1'; h.value = '2'; m.value = '30';
  smt().value = 'pairs';
  $('.jl-custom-attempts').value = '3';
  $('.jl-custom-save').click();
  await settle();
  const saved = store.VulnT.definition;
  check(saved.timeout?.d === 1 && saved.timeout?.h === 2 && saved.timeout?.m === 30 && saved.smt === 'pairs' && saved.attempts === 3,
    `💾 Save keeps the timeout, the CPU sharing and the attempts (${JSON.stringify({ timeout: saved.timeout, smt: saved.smt, attempts: saved.attempts })})`);
} catch (err) {
  check(false, `error: ${err.stack ?? err}`);
}
document.title = fail ? 'FAILED' : 'PASSED';
</script></body></html>
EOF
port=$( python3 -I -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])' )
python3 -I -m http.server "${port}" --bind 127.0.0.1 --directory "${work}" > /dev/null 2>&1 & server=$!
for _ in $( seq 1 50 ); do python3 -I -c "import socket; socket.create_connection(('127.0.0.1', ${port}), 1)" 2> /dev/null && break; sleep 0.1; done
dom=$( timeout 120 "${chrome}" --headless=new --disable-gpu --no-sandbox --user-data-dir="${work}/chrome" --window-size=1600,1000 \
  --virtual-time-budget=30000 --dump-dom "http://127.0.0.1:${port}/html/test.html" 2> /dev/null )
python3 -I -c '
import html, re, sys
dom = sys.stdin.read()
m = re.search(r"<pre id=\"out\">(.*?)</pre>", dom, re.S)
print(html.unescape(m.group(1)) if m else dom[:2000], end="")
t = re.search(r"<title>(.*?)</title>", dom)
print(t.group(1) if t else "no result")
sys.exit(0 if t and t.group(1) == "PASSED" else 1)
' <<< "${dom}"
