#!/bin/bash
# results_panel_test.sh: Results' 🐞 of a configuration (publisher/summary_render.js ShowReportBugs: the button and the
# panel of its row, from the task's objectives report through bugs.js AnalyseReport), under node with the page's own
# code (results_page.mjs), on reports made here:
#   - objectives never replayed (beyond the replays of the experiment) are not "not reproduced": the button and
#     the panel count them apart, "not replayed";
#   - a bug of several configurations: each row's verdict badges count its objectives there, not the task's;
#   - the validation line of a row tells weak signatures (a claim, a crash elsewhere than the bug's place) from strong
#     ones, as the badges do;
#   - it counts a verdict that a failed control can have made false as could not validate, as the badges and the 🎯 do
#     (bugs.js UntrustedBy): a "confirmed X" when X's control failed, a "not patched" with X's signature when X's
#     witness triggered with every patch; the others stand;
#   - a target found by its signature alone (a custom crash target without patch nor known place): its 🎯 says weak.
set -euo pipefail
here=$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )
command -v node > /dev/null || { echo "SKIP: no node"; exit 0; }
work=$( mktemp -d ); trap 'rm -rf "${work}"' EXIT
command cp -f "${here}/results_page.mjs" "${work}/results_page.mjs"
cat > "${work}/test.mjs" <<'JS'
import { Prepare, InstallShims, WriteFixture, FakeEl } from './results_page.mjs';
import { readFileSync } from 'node:fs';
const root = process.env.WORK, repo = process.env.REPO;
let fail = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fail = 1; };
const page = Prepare(root, repo);
InstallShims(root);
const { ShowReportBugs } = await import(page);
// ShowReportBugs on a row of the configuration: what its panel and its button show
// (status: the configuration's status on Results, BuildDataSet: its validation from the task's summary, the same record)
async function Panel(task, library, validation = null) {
  const panel = new FakeEl('div'), button = new FakeEl('button'), parent = new FakeEl('td');
  button.parentNode = parent;
  await ShowReportBugs(panel, button, task, library, { runs: [], validation });
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
const sig = await Panel('102', 'custom2_SIG', lib('custom2_SIG', ['s1']).validation), skip = await Panel('102', 'custom2_SKIP');
const badge = p => (/class="objective-validation validation-signature[^"]*"[^>]*>([^<]*)</.exec(p.panel) ?? [])[1] ?? '';
check(/×1$/.test(badge(sig)), `custom2_SIG: its badge counts its 1 objective, not the task's 5: ${badge(sig)}`);
check(/×4$/.test(badge(skip)), `custom2_SKIP: its badge counts its 4: ${badge(skip)}`);
const line = p => (/<div class="lib-validation">[\s\S]*?<\/div>/.exec(p.panel) ?? [''])[0];
check(/class="validation-signature validation-weak"[^>]*>≈ 1 by its signature · weak \(CVE-2024-5814\)/.test(line(sig)),
  `the line: a claim's signature is weak, in the weak colour: ${line(sig).replace(/<[^>]*>/g, '')}`);
// SDOS2 (no patch at 5.4.0): one crash at its place (strong), one elsewhere (weak)
WriteFixture(root, 'objectives/103.json', { task: '103', commit: 'c', job_type: 'vuln-custom',
  libraries: [{ library: 'custom_SDOS2', runs: 1, validation: { catalogue: { source: 'commit', commit: 'c' },
    entries: { 'CVE-2022-38152': { alias: 'SDOS2', oracle: { kind: 'crash', asan: 'SEGV' },
                                   witness_frames: ['DoTls13ClientHello', 'DoTls13HandShakeMsgType', 'DoTls13HandShakeMsg'] } },
    byTrace: { '0/a1': { verdict: 'not-patched', entries: [], known_unpatched: ['CVE-2022-38152'] },
               '0/b1': { verdict: 'not-patched', entries: [], known_unpatched: ['CVE-2022-38152'] } } } }],
  runs: [{ library: 'custom_SDOS2', attempt: 0, found: 2, replayed: 2, reports: 2,
    cli: { vendor: 'wolfssl:wolfssl540-sdos2-asan-only-CVE-2022-38152', library: { name: 'wolfssl', version: '540' } },
    groups: [
      { type: 'SEGV', frames: ['__memmove_avx_unaligned_erms', 'DoTls13ClientHello', 'DoTls13HandShakeMsgType', 'DoTls13HandShakeMsg'], count: 1, traces: ['a1'], excerpt: '' },
      { type: 'SEGV', frames: ['ParseOther', 'Caller', 'Outer'], count: 1, traces: ['b1'], excerpt: '' }] }] });
const sdos2 = line(await Panel('103', 'custom_SDOS2', JSON.parse(readFileSync(`${root}/html/objectives/103.json`, 'utf8')).libraries[0].validation));
check(/class="validation-signature"[^>]*>≈ 1 by its signature with its stack \(CVE-2022-38152\)/.test(sdos2)
      && /class="validation-signature validation-weak"[^>]*>≈ 1 by its signature · weak \(CVE-2022-38152\)/.test(sdos2),
  `the line: the crash at the place strong, the one elsewhere weak: ${sdos2.replace(/<[^>]*>/g, '')}`);
// HEAP's control failed in run 0 (its witness did not trigger without its patch): a use-after-free elsewhere "confirmed
// HEAP" there has no say (its badge and the 🎯 already said so): the line counts it as could not validate
const heapControl = (unpatched, patched, byTrace) => ({ catalogue: { source: 'commit', commit: 'c' }, controls_failed: [0],
  failed_controls: { 0: [{ entry: 'CVE-2022-42905', triggers_unpatched: unpatched, triggers_patched: patched }] },
  entries: { 'CVE-2022-42905': { alias: 'HEAP', oracle: { kind: 'crash', asan: 'heap-buffer-overflow' } } }, byTrace,
  confirmed: Object.fromEntries(Object.values(byTrace).flatMap(v => v.entries ?? []).map(id => [id, 1])),
  verdicts: Object.values(byTrace).reduce((c, v) => ({ ...c, [v.verdict]: (c[v.verdict] ?? 0) + 1 }), {}) });
const heapReport = (task, validation, groups) => WriteFixture(root, `objectives/${task}.json`, { task, commit: 'c', job_type: 'vuln-a',
  targets: { HEAP: { cve: 'CVE-2022-42905', kind: 'crash', place: ['AddPacketInfo', 'DoTls13HandShakeMsgType', 'DoTls13HandShakeMsg'] } },
  libraries: [{ library: 'HEAP', runs: 1, outcomes: { 0: 'success' }, validation }],
  runs: [{ library: 'HEAP', attempt: 0, found: groups.length, replayed: groups.length, reports: groups.length,
    cli: { vendor: 'wolfssl:wolfssl540-heap', library: { name: 'wolfssl', version: '540' } }, groups }] });
const uaf = { type: 'heap-use-after-free', frames: ['FreeKeyExchange', 'Caller'], count: 1, traces: ['u1'], excerpt: '' };
const untrusted = heapControl(false, false, { '0/u1': { verdict: 'confirmed', entries: ['CVE-2022-42905'] } });
heapReport('104', untrusted, [uaf]);
const ctl = line(await Panel('104', 'HEAP', untrusted)).replace(/<[^>]*>/g, '');
check(!/confirmed by patch/.test(ctl) && /○ 1 could not validate \(failed control of CVE-2022-42905\)/.test(ctl) && /controls failed \(runs 0\)/.test(ctl),
  `HEAP's control failed: its "confirmed" there counts as could not validate, as on its badge: ${ctl}`);
// HEAP's witness triggered with every patch: a "not patched" with HEAP's signature (a heap-buffer-overflow) may be HEAP,
// it has no say; one with another signature (the use-after-free) stands
const heapCrash = { type: 'heap-buffer-overflow', frames: ['ParseCertRelative', 'ProcessPeerCerts'], count: 1, traces: ['h1'], excerpt: '' };
const patchedSide = heapControl(true, true, { '0/h1': { verdict: 'not-patched', entries: [], known_unpatched: [] },
                                              '0/u1': { verdict: 'not-patched', entries: [], known_unpatched: [] } });
heapReport('105', patchedSide, [heapCrash, uaf]);
const side = line(await Panel('105', 'HEAP', patchedSide)).replace(/<[^>]*>/g, '');
check(/🚨 1 no known bug's signature/.test(side) && /○ 1 could not validate \(failed control of CVE-2022-42905\)/.test(side),
  `HEAP's witness triggered with every patch: the one with its signature could not validate, the other stands: ${side}`);
// a custom crash target without patch nor known place, named by its signature (N2): 🎯 1/1 · weak, why in its hover
const weakValidation = { catalogue: { source: 'commit', commit: 'c' },
  entries: { 'CVE-2022-42905': { alias: 'HEAP', oracle: { kind: 'crash', asan: 'heap-use-after-free' } } },
  byTrace: { '0/u1': { verdict: 'not-patched', entries: [], known_unpatched: ['CVE-2022-42905'] } } };
WriteFixture(root, 'objectives/106.json', { task: '106', commit: 'c', job_type: 'vuln-custom',
  libraries: [{ library: 'C_HEAP', runs: 1, outcomes: { 0: 'success' }, validation: weakValidation }],
  runs: [{ library: 'C_HEAP', attempt: 0, found: 1, replayed: 1, reports: 1,
    cli: { vendor: 'wolfssl:wolfssl540-asan-only-CVE-2022-42905', library: { name: 'wolfssl', version: '540' },
           custom: { benchmark: 'C', target: 'CVE-2022-42905', oracle: { kind: 'crash', asan: 'heap-use-after-free' } } },
    groups: [{ type: 'heap-use-after-free', frames: ['FreeKeyExchange', 'Caller'], count: 1, traces: ['u1'], excerpt: '' }] }] });
const weak = await Panel('106', 'C_HEAP', weakValidation);
check(/🎯 1\/1 · weak/.test(weak.button) && /· weak: this run found it by its signature alone/.test(weak.title),
  `a target found by its signature alone (no place known): 🎯 1/1 · weak, why in its hover (${weak.button}; ${weak.title.split('\n')[2] ?? ''})`);
process.exit(fail);
JS
WORK="${work}" REPO="$( cd "${here}/../../.." && pwd )" node "${work}/test.mjs"
