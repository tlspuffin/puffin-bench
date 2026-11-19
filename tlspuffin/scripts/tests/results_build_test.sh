#!/bin/bash
# results_build_test.sh: Results' build cell of a run (publisher/summary_render.js GetBuildCell, GetAsanBadge), under node
# with the page's own code (results_page.mjs), for a vendor in puffin-build's short form (wolfssl:584,asan):
#   - its hover says the vendor as the task gave it and the build mk_vendor made of it (cli.vendor_build: its slug and
#     canonical name), the build named by its slug; a dashed vendor (its own slug): no such line, as before;
#   - an older result (ASan not checked on the binary): ASan requested when the name says it in either form (-asan,
#     ,asan) or mk_vendor's build has it (wolfssl540-heap), not otherwise.
set -euo pipefail
here=$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )
command -v node > /dev/null || { echo "SKIP: no node"; exit 0; }
work=$( mktemp -d ); trap 'rm -rf "${work}"' EXIT
command cp -f "${here}/results_page.mjs" "${work}/results_page.mjs"
cat > "${work}/test.mjs" <<'JS'
import { Prepare, InstallShims } from './results_page.mjs';
const root = process.env.WORK, repo = process.env.REPO;
let fail = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fail = 1; };
const page = Prepare(root, repo);
InstallShims(root);
const { GetBuildCell, GetAsanBadge } = await import(page);
const asan = { requested: true, instrumented: true, runtime: 'shared', asan_report_refs: 12 };
const short = GetBuildCell({ vendor: 'wolfssl:584,asan', cputs: true, build: 'C harness, wolfssl584-asan', asan,
  vendor_build: { slug: 'wolfssl584-asan', canonical: 'wolfssl:5.8.4,asan', version: '5.8.4', asan: true, base: null } });
check(short.includes('wolfssl584-asan\nC harness, wolfssl584-asan\nvendor: wolfssl:584,asan (its build wolfssl584-asan, wolfssl:5.8.4,asan)'),
  `a vendor in the short form: the build by its slug, the vendor as given and its build in the hover (${short})`);
const dashed = GetBuildCell({ vendor: 'wolfssl:wolfssl584-asan', cputs: true, build: 'C harness, wolfssl584-asan', asan,
  vendor_build: { slug: 'wolfssl584-asan', canonical: 'wolfssl:5.8.4,asan', version: '5.8.4', asan: true, base: null } });
check(!dashed.includes('vendor:'), 'a dashed vendor, its own slug: no vendor line, as before');
const requested = cli => /ASAN not verified \(older result\); requested/.test(GetAsanBadge(cli));
check(requested({ vendor: 'wolfssl:wolfssl540-asan' }) && requested({ vendor: 'wolfssl:584,asan' })
  && requested({ vendor: 'wolfssl:wolfssl540-heap', vendor_build: { asan: true } }),
  'an older result: ASan requested by the name (-asan, ,asan) or by the build mk_vendor made');
check(!requested({ vendor: 'wolfssl:wolfssl540' }) && !requested({ vendor: 'wolfssl:wolfssl540-asan-nope', vendor_build: { asan: false } }),
  'not requested otherwise (mk_vendor says no ASan: its name does not count)');
process.exit(fail);
JS
WORK="${work}" REPO="$( cd "${here}/../../.." && pwd )" node "${work}/test.mjs"
