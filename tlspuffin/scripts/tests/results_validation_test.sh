#!/bin/bash
# results_validation_test.sh: the Results page keeps each configuration's validation (publisher/summary_data.js
# BuildDataSet: status[library].validation), which its 🐞 panel shows (summary_render.js ValidationLine and the verdict
# of each bug); and a Vuln cell gives one value per run (execs to find, time to find), also for a run without the
# record of its find: its clients' total, not one value per client averaged with the others. Under node.
set -euo pipefail
here=$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )
command -v node > /dev/null || { echo "SKIP: no node"; exit 0; }
work=$( mktemp -d ); trap 'rm -rf "${work}"' EXIT
command cp -f "${here}/../../data/html/publisher/summary_data.js" "${work}/summary_data.mjs"
cat > "${work}/test.mjs" <<'EOF'
import { BuildDataSet } from './summary_data.mjs';
let fail = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fail = 1; };
const validation = { verdicts: { confirmed: 1 }, confirmed: { 'CVE-1': 1 }, byTrace: { '0/a': { verdict: 'confirmed', entries: ['CVE-1'] } },
                     bench: [{ commit: 'c787eb8', jobscripts: 'a18f4d0' }] };
const summary = (libraries) => ({ data: { commit_id: 'abc', type: 'vuln', libraries } });
const run = { id: 0, state: 'success', global: [], clients: [] };
const set = BuildDataSet('PR', summary({ X: { cli: {}, validation, data: [run] }, Y: { cli: {}, data: [run] } }));
check(set.status?.X?.validation?.byTrace?.['0/a']?.verdict === 'confirmed' && set.status.X.validation.bench[0].jobscripts === 'a18f4d0',
  'a configuration keeps its validation (the verdicts by trace, the bench)');
check(set.status?.Y?.validation === null, 'one without validation: null');
// Vuln: a run with its execs and time to find, one without (its two clients' totals and durations at the stop)
const client = (execs, t0, t1) => ({ t0: { time: { secs_since_epoch: t0 } }, tEnd: { total_execs: execs, time: { secs_since_epoch: t1 } } });
const vuln = BuildDataSet('Vuln', { data: { commit_id: 'abc', type: 'vuln', libraries: { X: { cli: {}, data: [
  { id: 0, state: 'success', execs_to_find: 100, time_to_find_s: 10, global: [], clients: [client(70, 0, 20), client(60, 0, 20)] },
  { id: 1, state: 'success', global: [], clients: [client(30, 0, 5), client(50, 0, 7)] }] } } } });
check(JSON.stringify(vuln.metrics?.X?.total_execs) === '[[100],[80]]', `execs to find: one value per run, the clients' total without its record: ${JSON.stringify(vuln.metrics?.X?.total_execs)}`);
check(JSON.stringify(vuln.metrics?.X?.durations_s) === '[[10],[7]]', `time to find: one value per run, how long its clients ran without its record: ${JSON.stringify(vuln.metrics?.X?.durations_s)}`);
process.exit(fail);
EOF
node "${work}/test.mjs"
