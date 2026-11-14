#!/bin/bash
# launcher_custom_test.sh <tlspuffin clone with the catalogue> [<commit>]: the whole launcher (joblauncher.js with its
# custom benchmark panel, custombench.js) in a headless Chrome, on the catalogue and presets of the commit
# (git_restapi's scripts), the scheduler's store of saved benchmarks answered in the page:
#   - Load sets everything the benchmark was saved with: its bugs, attempts, cores per attempt, and the launcher's own
#     timeout and CPU sharing;
#   - 💾 Save keeps the launcher's timeout and CPU sharing with the panel's settings;
#   - a timeout loaded stays when the job type changes and comes back;
#   - Load of a benchmark saved before the launcher kept the timeout: the job's default, and a note saying so (the one
#     set here kept when one was set);
#   - the board's summary of a monitor message (describeMonitor): objectives counted, coloured only by the level of the
#     task's objectives report (live.json, task_links.json): red with 🚨 new, gold unexpected, plain known or unjudged;
#   - the panel asks for a commit first; then the saved benchmarks, the launcher's timeout, attempts and cores, its CPU
#     sharing, the bugs (those without witness hidden by default); the timeout goes back to its place for other jobs;
#   - Vuln group A and B are built-in benchmarks (their configurations: bugs, presets as they are, attempts, cores,
#     timeout), listed first, never removed, their names not saved over.
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
mkdir -p "${work}/html/board/launchers/tlspuffin" "${work}/html/common" "${work}/git" "${work}/files/jobsscripts/tlspuffin"
command cp -f "${bench}/tlspuffin/data/html/jobsscripts/tlspuffin/PR_vulnerabilities-group"[AB]"_cargo.json" "${work}/files/jobsscripts/tlspuffin/"
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
  Old: { saved_at: Date.now() - 86400000, definition: { name: 'Old', description: 'saved before the timeout was kept', others: 'patched',
    catalogue: { source: 'commit', commit: SHA }, attempts: 1, cores: 2, experiments: [{ bug: 'CVE-2021-3336' }] } },
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
  if (url.endsWith('/objectives/live.json')) return json(200, { tasks: [{ task: 11, level: 'new', new: 1 }, { task: 12, level: 'known' }] });
  if (url.endsWith('/custom/task_links.json')) return json(200, { 13: [{ source: 'objectives_report', label: '🐞', count: 2, level: 'unexpected' }],
                                                                   14: [{ source: 'objectives_report', label: '🐞', count: 2, level: 'warning' }] });
  if (url.includes('/html/board/') || url.includes('/html/common/') || url.includes('/files/jobsscripts/')) return realFetch(url);
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
const before = (a, b) => !!(a && b && (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING));
const shown = el => !!el && el.getClientRects().length > 0;
try {
  // without a commit: the panel only asks for one; the launcher's timeout and CPU sharing are in its slots
  launcher.open({ jobType: 'vuln-custom' });
  await settle(800);
  check($('.jl-custom').classList.contains('no-commit') && shown($('.jl-custom-first')) && !shown($('.jl-custom-main'))
    && !shown($('.jl-timeout-section')), 'no commit yet: only the prompt for one (no timeout, no bugs)');
  check($('.jl-custom-timeoutslot').contains($('.jl-timeout-section')) && $('.jl-custom-sharingslot').contains(smt()),
    'the timeout and the CPU sharing are in the panel');
  launcher.close();
  // the launcher on the commit, job type Vuln — custom (as "New task…" opens it)
  launcher.open({ jobType: 'vuln-custom', commit: SHA });
  check(await until(() => document.querySelectorAll('.jl-custom-bugs tr[data-id]').length > 0), 'the custom panel lists the bugs of the commit');
  check(await until(() => [...$('.jl-custom-saved').options].some(o => o.value === 'VulnT')), 'VulnT among the saved benchmarks');
  check(!$('.jl-custom').classList.contains('no-commit') && shown($('.jl-custom-main')) && shown($('.jl-timeout-section')), 'a commit: the panel is shown');
  check(before($('.jl-custom-savedrow'), $('.jl-timeout-section')) && before($('.jl-timeout-section'), $('.jl-custom-attempts'))
    && before($('.jl-custom-attempts'), smt()) && before(smt(), $('.jl-custom-bugs')),
    'order: saved benchmarks, timeout, attempts and cores, CPU sharing, the bugs');
  check($('.jl-custom-hidewitness').checked && /hide bugs without witness/.test($('.jl-custom-hidewitness').parentElement.textContent),
    'the bugs without witness are hidden by default ("hide bugs without witness" ticked)');
  // without witness: with a patch and a signature (CALLB) it can be ticked, with a warning; without patch (Heartbleed,
  // FREAK) it cannot
  check(!document.querySelector('.jl-custom-bugs tr[data-id="CVE-2023-6936"]'), 'CALLB (no witness) hidden by default');
  $('.jl-custom-hidewitness').click(); await settle();
  const callb = document.querySelector('.jl-custom-bugs tr[data-id="CVE-2023-6936"]');
  const heartbleed = document.querySelector('.jl-custom-bugs tr[data-id="CVE-2014-0160"]');
  check(!!callb && callb.querySelector('input').disabled === !callb.querySelector('select'),
    `CALLB shown once unticked, tickable where a preset has it (${callb?.querySelector('select') ? 'a preset' : 'no preset'})`);
  check(!heartbleed || heartbleed.querySelector('input').disabled, 'Heartbleed (no witness, no patch): never tickable');
  if (callb?.querySelector('select')) {
    callb.querySelector('input').click(); await settle();
    check(/CALLB<\/b> has no witness/.test($('.jl-custom-warnings').innerHTML), 'CALLB ticked: the warning that it has no witness');
    callb.querySelector('input').click(); await settle();
  }
  $('.jl-custom-hidewitness').click(); await settle();
  // the task's name: "Vuln C - <commit>" while the benchmark has the default name
  check(/^Vuln C - /.test($('.jl-task-name').value), `the task is named Vuln C until the benchmark has a name (${$('.jl-task-name').value})`);
  $('.jl-custom-saved').value = 'VulnT'; $('.jl-custom-saved').dispatchEvent(new Event('change'));
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

  // a timeout loaded stays when the job type changes and comes back
  $('.jl-custom-saved').value = 'VulnT'; $('.jl-custom-open').click(); await settle();
  const chip = value => document.getElementById(`jl-chip-${value}`);
  chip('vuln-a').click(); await settle(200); chip('vuln-custom').click(); await settle();
  check(timeout() === '1:2:30', `a timeout loaded stays across a change of job type (${timeout()})`);

  // a benchmark saved before the launcher kept the timeout: the one set here is kept, said; on a fresh launcher, the
  // job's default, said
  $('.jl-custom-saved').value = 'Old'; $('.jl-custom-saved').dispatchEvent(new Event('change')); $('.jl-custom-open').click(); await settle();
  check(timeout() === '1:2:30' && /saved without a timeout: the one set here is kept \(1 d 2 h 30\)/.test($('.jl-custom-savestatus').textContent),
    `Old, after VulnT: the timeout set here kept, and said (${timeout()}: ${$('.jl-custom-savestatus').textContent})`);
  launcher.close();
  launcher.open({ jobType: 'vuln-custom', commit: SHA });
  await until(() => document.querySelectorAll('.jl-custom-bugs tr[data-id]').length > 0);
  await settle();
  $('.jl-custom-saved').value = 'Old'; $('.jl-custom-saved').dispatchEvent(new Event('change')); $('.jl-custom-open').click(); await settle();
  check(timeout() === '0:3:10' && /saved without a timeout: the job's default \(3 h 10\) is set/.test($('.jl-custom-savestatus').textContent),
    `Old on a fresh launcher: the job's default, and said (${timeout()}: ${$('.jl-custom-savestatus').textContent})`);
  // the built-in benchmarks: Vuln group A and B as configured, first, never removed
  const names = [...$('.jl-custom-saved').options].map(o => o.value);
  check(names[0] === 'VulnA' && names[1] === 'VulnB' && /built in/.test($('.jl-custom-saved').options[0].textContent),
    `Vuln group A and B first, built in (${names.join(', ')})`);
  $('.jl-custom-saved').value = 'VulnA'; $('.jl-custom-saved').dispatchEvent(new Event('change'));
  check($('.jl-custom-remove').disabled && /built in/.test($('.jl-custom-savedinfo').textContent), 'a built-in benchmark cannot be removed');
  $('.jl-custom-open').click(); await settle();
  const rows = [...document.querySelectorAll('.jl-custom-bugs tr[data-id]')].filter(r => r.querySelector('input').checked);
  const picked = Object.fromEntries(rows.map(r => [r.dataset.id, r.querySelector('select')?.value]));
  check(picked['CVE-2022-39173'] === 'wolfssl540-buf' && picked['CVE-2022-38153'] === 'wolfssl530-cdos' && picked['CVE-2022-42905'] === 'wolfssl540-heap'
    && picked['CVE-2022-38152'] === 'wolfssl540-sdos2' && picked['CVE-2022-25640'] === 'wolfssl510-skip' && rows.length === 5,
    `VulnA: its five bugs on the group's presets (${JSON.stringify(picked)})`);
  check($('.jl-custom-attempts').value === '5' && $('.jl-custom-cores').value === '4' && timeout() === '0:3:10'
    && document.querySelector('input[name="jl-custom-others"][value="preset"]').checked,
    `VulnA: 5 attempts × 4 cores, 3 h 10, the presets as they are (${$('.jl-custom-attempts').value} × ${$('.jl-custom-cores').value}, ${timeout()})`);
  $('.jl-custom-saved').value = 'VulnB'; $('.jl-custom-saved').dispatchEvent(new Event('change')); $('.jl-custom-open').click(); await settle();
  check($('.jl-custom-attempts').value === '90' && $('.jl-custom-cores').value === '1' && timeout() === '2:0:10',
    `VulnB: 90 attempts × 1 core, 2 d 0 h 10 (${$('.jl-custom-attempts').value} × ${$('.jl-custom-cores').value}, ${timeout()})`);
  $('.jl-custom-name').value = 'VulnA'; $('.jl-custom-save').click(); await settle();
  check(!store.VulnA && /built in/.test($('.jl-custom-savestatus').textContent), `a built-in name is not saved over (${$('.jl-custom-savestatus').textContent})`);
  // another job: the timeout and the CPU sharing back in their place, outside the panel
  document.getElementById('jl-chip-vuln-a').click(); await settle(200);
  check(!$('.jl-custom').contains($('.jl-timeout-section')) && !$('.jl-custom').contains(smt()) && shown($('.jl-timeout-section')),
    'another job: the timeout and the CPU sharing back in their place');
  document.getElementById('jl-chip-vuln-custom').click(); await settle();

  // the board's summary of a monitor message: coloured by the level of the task's objectives report only
  const message = '# Experiment: WolfSSL\n    ==> 🐞 Objective: 3 file(s), last modified: 2 minutes ago - x.trace';
  const describe = (id, job_type) => launcher.describeMonitor({ id, job_type, steps: {} }, message);
  const n = describe(11, 'vuln-a'), k = describe(12, 'perf'), u = describe(13, 'perf'), w = describe(14, 'perf'), x = describe(15, 'perf');
  check(n.highlight === 'new' && n.taskLink.highlight === 'new' && /🚨 🐞 3 obj/.test(n.summary) && n.summary.includes('tp-mon-objective-new'),
    `a new bug (live report), even in a Vuln job: red, 🚨 (${n.highlight}: ${n.taskLink.label})`);
  check(k.highlight === null && k.taskLink.highlight === null && /🐞 3 obj/.test(k.summary) && !k.summary.includes('🎉'),
    `known bugs (live report): counted, no colour, no 🎉 (${k.taskLink.label})`);
  check(u.highlight === 'objective' && u.taskLink.highlight === 'objective', 'unexpected (final report): gold');
  check(w.highlight === null && w.summary.includes('nothing reproduced') && x.highlight === null && x.summary.includes('not judged yet'),
    'nothing reproduced (final report), or no report yet: no colour, said');
  // the objectives chip links to the live page while the task runs, to the final report once it ended
  const json = '#MONITOR_JSON ' + JSON.stringify({ objectives: { count: 8, age_min: 0, live: 'http://h:10083/html/objectives/live-16.html' } });
  const running = launcher.describeMonitor({ id: 16, job_type: 'vuln-custom', steps: { s: { state: 'Running' } } }, json);
  const ended = launcher.describeMonitor({ id: 16, job_type: 'vuln-custom', steps: { s: { state: 'TimedOut' } } }, json);
  check(/objectives\/live-16\.html/.test(running.summary) && /objectives\/16\.html/.test(ended.summary) && !/live-16/.test(ended.summary),
    'the objectives chip: the live page while the task runs, its final report once it ended');
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
