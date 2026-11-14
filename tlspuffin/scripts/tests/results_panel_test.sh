#!/bin/bash
# results_panel_test.sh: Results' 🐞 of a configuration (publisher/summary_render.js ShowReportBugs: the button and the
# panel of its row, from the task's objectives report through bugs.js AnalyseReport), under node with the page's own
# code (results_page.mjs), on reports made here:
#   - objectives never replayed (beyond the replays of the experiment) are not "not reproduced": the button and
#     the panel count them apart, "not replayed";
#   - a bug of several configurations: each row's verdict badges count its objectives there, not the task's (F20).
set -euo pipefail
here=$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )
command -v node > /dev/null || { echo "SKIP: no node"; exit 0; }
work=$( mktemp -d ); trap 'rm -rf "${work}"' EXIT
command cp -f "${here}/results_page.mjs" "${work}/results_page.mjs"
cat > "${work}/test.mjs" <<'JS'
import { Prepare, InstallShims, WriteFixture, FakeEl } from './results_page.mjs';
const root = process.env.WORK, repo = process.env.REPO;
let fail = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fail = 1; };
const page = Prepare(root, repo);
InstallShims(root);
const { ShowReportBugs } = await import(page);
// ShowReportBugs on a row of the configuration: what its panel and its button show
async function Panel(task, library) {
  const panel = new FakeEl('div'), button = new FakeEl('button'), parent = new FakeEl('td');
  button.parentNode = parent;
  await ShowReportBugs(panel, button, task, library, { runs: [] });
  return { panel: panel.innerHTML, button: button.textContent, title: button.title };
}
// a Perf task: one bug replayed 2 times (reproduced) with 3 objectives beyond the replays, one bug never replayed
const crash = { kind: 'crash', detail: 'SIGABRT · ASan heap-buffer-overflow', frames: ['ParseOne', 'ParseTwo'] };
WriteFixture(root, 'objectives/101.json', { task: '101', commit: 'c', job_type: 'perf', libraries: [{ library: 'WolfSSL', runs: 1 }],
  runs: [{ library: 'WolfSSL', attempt: 0, found: 9, replayed: 2, reports: 2, cli: { vendor: 'wolfssl:wolfssl540-asan', library: { name: 'wolfssl', version: '540' } },
    groups: [
      { type: 'heap-buffer-overflow', frames: ['ParseOne', 'ParseTwo', 'ParseThree'], count: 2, traces: ['r1', 'r2'], excerpt: '', fuzzer: crash },
      { type: 'not-replayed', frames: [], count: 3, traces: ['p1', 'p2', 'p3'], excerpt: '', replay_reasons: [{ reason: '', count: 3 }], fuzzer: crash },
      { type: 'not-replayed', frames: [], count: 4, traces: ['q1', 'q2', 'q3', 'q4'], excerpt: '', replay_reasons: [{ reason: '', count: 4 }],
        fuzzer: { kind: 'claim', detail: 'Some claim', frames: [] } }] }] });
const p = await Panel('101', 'WolfSSL');
check(/9 objective\(s\), 2 bug\(s\)/.test(p.panel), 'the panel: the 9 objectives and 2 bugs of the configuration');
check(!/not reproduced/.test(p.panel) && !/not reproduced/.test(p.title), `objectives never replayed are not "not reproduced": ${p.title}`);
check(/3 not replayed/.test(p.panel) && /objective-not-replayed[^>]*>not replayed</.test(p.panel), 'they are counted as not replayed, a bug none of whose was replayed says so');
// a claim of CVE-2024-5814 in two experiments of a custom task: 1 objective in custom2_SIG, 4 in custom2_SKIP, each with
// its validation verdict (not removed by the patches here, its signature: CVE-2024-5814, no patch at this version)
const claim = "Negotiated cipher is not in agent's configured ciphers list";
const unpatched = { verdict: 'not-patched', entries: [], known_unpatched: ['CVE-2024-5814'] };
const lib = (name, traces) => ({ library: name, runs: 1, validation: { catalogue: { source: 'commit', commit: 'c' },
  entries: { 'CVE-2024-5814': { oracle: { kind: 'claim', violation: claim } } },
  byTrace: Object.fromEntries(traces.map(t => [`0/${t}`, unpatched])) } });
const run = (name, traces) => ({ library: name, attempt: 0, found: traces.length, replayed: traces.length, reports: traces.length,
  cli: { vendor: 'wolfssl:wolfssl511-asan', library: { name: 'wolfssl', version: '511' } },
  groups: [{ type: 'security-violation', frames: [claim], count: traces.length, traces, excerpt: '', fuzzer: { kind: 'claim', detail: claim, frames: [] } }] });
WriteFixture(root, 'objectives/102.json', { task: '102', commit: 'c', job_type: 'vuln-custom',
  libraries: [lib('custom2_SIG', ['s1']), lib('custom2_SKIP', ['k1', 'k2', 'k3', 'k4'])],
  runs: [run('custom2_SIG', ['s1']), run('custom2_SKIP', ['k1', 'k2', 'k3', 'k4'])] });
const sig = await Panel('102', 'custom2_SIG'), skip = await Panel('102', 'custom2_SKIP');
const badge = p => (/class="objective-validation validation-signature[^"]*"[^>]*>([^<]*)</.exec(p.panel) ?? [])[1] ?? '';
check(/×1$/.test(badge(sig)), `custom2_SIG: its badge counts its 1 objective, not the task's 5: ${badge(sig)}`);
check(/×4$/.test(badge(skip)), `custom2_SKIP: its badge counts its 4: ${badge(skip)}`);
process.exit(fail);
JS
WORK="${work}" REPO="$( cd "${here}/../../.." && pwd )" node "${work}/test.mjs"
