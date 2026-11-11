#!/bin/bash
# results_validation_test.sh: the Results page keeps each configuration's validation (publisher/summary_data.js
# BuildDataSet: status[library].validation), which its 🐞 panel shows (summary_render.js ValidationLine and the verdict
# of each bug). Under node.
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
process.exit(fail);
EOF
node "${work}/test.mjs"
