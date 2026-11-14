#!/bin/bash
# results_panel_test.sh: Results' 🐞 of a configuration (publisher/summary_render.js ShowReportBugs: the button and the
# panel of its row, from the task's objectives report through bugs.js AnalyseReport), under node with the page's own
# code (results_page.mjs), on reports made here:
#   - objectives never replayed (beyond the replays of the experiment) are not "not reproduced": the button and
#     the panel count them apart, "not replayed".
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
process.exit(fail);
JS
WORK="${work}" REPO="$( cd "${here}/../../.." && pwd )" node "${work}/test.mjs"
