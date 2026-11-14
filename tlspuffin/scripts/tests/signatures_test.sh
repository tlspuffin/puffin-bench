#!/bin/bash
# signatures_test.sh [<qjs>]: the stack part of a signature has one definition, common/signatures.js, which every page
# and tool uses: what the Bugs reference shows of a bug (its place, its witness's stack in bold) is what the objectives
# pages, Results and History compare a crash with, and what the Bugs reference's "bugs found so far" recognise a crash
# by, and what Vuln group A's targets, the CVE signatures and the job scripts recognise a crash by. Checked: the rule on
# the witnesses' stacks of cassis (2026-11-12) and on the crashes found live; each user of a stack signature imports the
# module and keeps no rule of its own; the places of Vuln group A's targets (vuln_targets.json) are their witnesses'
# (here, and on the bench's recorded stacks when readable); the job scripts ask the module (tools/js/has_place.js through
# qjs), which answers as the pages do; the installer installs both.
set -euo pipefail
here=$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )
qjs="${1:-/srv/puffin-bench/data/tools/qjs}"
[ -x "${qjs}" ] || { echo "SKIP: no qjs at ${qjs}"; exit 0; }
work=$( mktemp -d ); trap 'rm -rf "${work}"' EXIT
fail=0
cat > "${work}/test.js" <<EOF
import { PlaceOf, HasPlace, SignatureFrames } from '${here}/../../data/html/common/signatures.js';
let fail = 0;
const check = (ok, what) => { print(\`\${ok ? 'ok  ' : 'FAIL'} \${what}\`); if (!ok) fail = 1; };
// the witnesses, replayed symbolized on the validation builds
const sdos2 = ['__memmove_avx_unaligned_erms', 'DoTls13ClientHello', 'DoTls13HandShakeMsgType', 'DoTls13HandShakeMsg', 'ProcessReplyEx'];
const cdos = ['__interceptor_free.part.0', 'wolfSSL_Free', 'AddSessionToCache', 'AddSession', 'DoSessionTicket'];
const heap = ['__asan_memcpy', 'AddPacketInfo', 'DoTls13HandShakeMsgType', 'DoTls13HandShakeMsg', 'ProcessReplyEx'];
const buf = ['RefineSuites', 'CheckPreSharedKeys', 'DoTls13ClientHello', 'DoTls13HandShakeMsgType', 'DoTls13HandShakeMsg'];
check(JSON.stringify(SignatureFrames(sdos2)) === '["DoTls13ClientHello","DoTls13HandShakeMsgType","DoTls13HandShakeMsg"]',
  'the frames a signature looks at: without the runtime and glibc (__memmove_avx_unaligned_erms)');
check(JSON.stringify(PlaceOf([], sdos2)) === '["DoTls13ClientHello","DoTls13HandShakeMsgType","DoTls13HandShakeMsg"]'
  && JSON.stringify(PlaceOf(null, cdos)) === '["wolfSSL_Free","AddSessionToCache","AddSession"]',
  "R3: a bug's place is the first 3 frames of its witness's stack (SDOS2, CDOS)");
check(JSON.stringify(PlaceOf(['RefineSuites'], buf)) === '["RefineSuites","CheckPreSharedKeys","DoTls13ClientHello"]',
  "the witness's 3 frames before the catalogue's top frames (BUF)");
check(JSON.stringify(PlaceOf(['AddPacketInfo', 'DoTls13HandShakeMsgType'], null)) === '["AddPacketInfo","DoTls13HandShakeMsgType"]',
  "no witness's stack recorded: the catalogue's top frames");
check(HasPlace(PlaceOf([], heap), ['AddPacketInfo', 'DoTls13HandShakeMsgType', 'DoTls13HandShakeMsg']), 'HEAP: its stack has its place');
check(!HasPlace(PlaceOf([], heap), ['AddPacketInfo', 'Other', 'DoTls13HandShakeMsg']), 'HEAP: a stack with its first frame only is not its place');
check(!HasPlace(PlaceOf([], sdos2), buf), 'BUF (DoTls13ClientHello its 3rd frame) is not SDOS2: the confusion of the former rule');
check(HasPlace(PlaceOf([], sdos2), ['__memcpy_avx_unaligned_erms', 'DoTls13ClientHello', 'DoTls13HandShakeMsgType']),
  "SDOS2 found live (memcpy variant of glibc): its witness's place");
check(!HasPlace(PlaceOf([], sdos2), ['ParseCertRelative', 'ProcessPeerCerts']), 'a SEGV elsewhere: not its place');
check(!HasPlace(PlaceOf([], cdos), ['RefineSuites', 'CheckPreSharedKeys']), 'not CDOS');
// the places of Vuln group A's crash targets: their witnesses' first frames (R3)
const targets = JSON.parse(std.loadFile('${here}/../../data/html/jobsscripts/tlspuffin/vuln_targets.json'));
const witness = { 'CVE-2022-38152': sdos2, 'CVE-2022-38153': cdos, 'CVE-2022-42905': heap, 'CVE-2022-39173': buf };
const crashTargets = Object.entries(targets).filter(([k, t]) => !k.startsWith('_') && t.kind === 'crash');
for (const [preset, t] of crashTargets) {
  check(JSON.stringify(t.place) === JSON.stringify(PlaceOf([], witness[t.cve])), \`vuln_targets.json \${preset}: its place is its witness's (\${(t.place ?? []).join(' < ')})\`);
  check(!('match' in t), \`vuln_targets.json \${preset}: no frame rule of its own (match)\`);
}
// the same on the stacks the bench recorded, when readable
let recorded = null;
try { recorded = JSON.parse(std.loadFile('/srv/puffin-bench/data/html/objectives/witness_frames.json')); } catch (error) {}
for (const [preset, t] of crashTargets.filter(([, t]) => recorded?.[t.cve]?.frames)) {
  check(JSON.stringify(t.place) === JSON.stringify(PlaceOf([], recorded[t.cve].frames)), \`(live) \${preset}: its place is its witness's recorded stack\`);
}
std.exit(fail);
EOF
"${qjs}" --std -m "${work}/test.js" || fail=1
# every user of a stack signature takes it from the module and keeps no rule of its own; and every place it shows is the
# module's (PlaceOf), never the catalogue's top frames printed as they are (a place shown that is not what is compared)
for f in "${here}/../../data/html/publisher/bugs.js" "${here}/../tools/objectives_page/bugs.js" "${here}/../tools/objectives_page/report.js" \
         "${here}/../../data/html/board/launchers/tlspuffin/custombench.js"; do
  name="$( basename "$( dirname "${f}" )" )/$( basename "${f}" )"
  grep -qE "from '(\.\./)+common/signatures.js'" "${f}" && echo "ok   ${name} imports common/signatures.js" || { echo "FAIL ${name} does not import common/signatures.js"; fail=1; }
  if grep -nE 'LIBC_VARIANT *=|RUNTIME_FRAME *=|__\(mem\|str' "${f}"; then echo "FAIL ${name} has a rule of its own"; fail=1; else echo "ok   ${name} has no rule of its own"; fi
  if grep -nE 'top_frames\??\.(join|slice|map)|not used to decide' "${f}"; then echo "FAIL ${name} shows the catalogue's top frames as a place without PlaceOf"; fail=1;
  else echo "ok   ${name} shows places through PlaceOf only"; fi
done
# the job scripts: the module through tools/js/has_place.js, as installed (<data>/tools beside <data>/html), the same answers
data="${work}/data"; mkdir -p "${data}/tools" "${data}/html"; ln -s "${qjs}" "${data}/tools/qjs"
cp -r "${here}/../../data/tools/js" "${data}/tools/js"; cp -r "${here}/../../data/html/common" "${data}/html/common"
cli() { "${qjs}" --std -m "${data}/tools/js/has_place.js" "$1" "$2"; }
cli 'RefineSuites < CheckPreSharedKeys < DoTls13ClientHello' '__asan_memcpy < RefineSuites < CheckPreSharedKeys' &&
  ! cli 'DoTls13ClientHello < DoTls13HandShakeMsgType < DoTls13HandShakeMsg' 'RefineSuites < CheckPreSharedKeys < DoTls13ClientHello' &&
  cli 'DoTls13ClientHello < DoTls13HandShakeMsgType < DoTls13HandShakeMsg' '__memmove_avx_unaligned_erms < DoTls13ClientHello < DoTls13HandShakeMsgType' &&
  echo "ok   tools/js/has_place.js answers as the module (BUF with ASan's frame first, BUF not SDOS2, SDOS2 in glibc)" ||
  { echo "FAIL tools/js/has_place.js does not answer as the module"; fail=1; }
sed -n '/^TargetMatches()/,/^}/p' "${here}/../PR_common.sh" | grep -q 'HasPlace ' && grep -q 'js/has_place.js' "${here}/../PR_common.sh" &&
  echo "ok   PR_common.sh TargetMatches asks HasPlace (tools/js/has_place.js)" || { echo "FAIL PR_common.sh TargetMatches has a rule of its own"; fail=1; }
# the frame rule of before (a frame among the first 3), nowhere
if grep -nE 'includes\((t|target|c)\??\.match\)|slice\(0, 3\)\.(some|findIndex)|grep -qF -- "\$\{match\}"' "${here}/../PR_common.sh" \
    "${here}/../../data/html/publisher/bugs.js" "${here}/../tools/objectives_page/bugs.js" "${here}/../tools/objectives_page/report.js"; then
  echo "FAIL the frame rule of before (a frame among the first 3) is still there"; fail=1
else echo "ok   no frame rule of before (a frame among the first 3) in the job scripts or the pages"; fi
for f in html/common/signatures.js tools/js/has_place.js; do
  grep -q "${f}" "${here}/../../CMakeLists.txt" && echo "ok   the installer installs ${f}" || { echo "FAIL the installer does not install ${f}"; fail=1; }
done
exit "${fail}"
