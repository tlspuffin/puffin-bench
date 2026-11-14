#!/bin/bash
# report_verdicts_test.sh [<qjs>]: the verdicts objectives_report.sh writes into a report for the tools that do not run
# the pages (report_verdicts.js with bugs.js AnalyseReport, under QuickJS), what the history page shows of a task:
#   - Perf on a version whose known bugs it found (declared CVEs, validation by patch): known, its 🐞 plain;
#   - Perf with objectives on a version that declares no known bug: unexpected, its 🐞 gold (new when one is a real bug);
#   - a bug the validation finds with no known bug's signature: new (🚨), its 🐞 red, whatever the registry;
#   - a weak signature (SDOS2: any ASan SEGV) does not make a crash elsewhere known: new by its stack;
#   - a custom benchmark's experiments get their 🎯 (their target, recognised by validation; by its signature before),
#     also a configuration whose runs found nothing (🎯 0/n: the task is not all found);
#   - objectives but nothing reproduced and no fuzzer record: unclear, its 🐞 outlined (warning);
#   - a target known not to replay (CDOS, replayable = false), found by the fuzzer's record, inconclusive on the
#     validation builds: known, its 🐞 plain, the bug's verdict "does not replay, as known" (no-replay);
#   - with the catalogue of the validation (its second argument), its replayable flags and top frames go into the
#     report's entries, for the readers without catalogue (Results): CDOS known not to replay from an older validation;
#   - a bug's place is the first 3 frames of its witness's stack (R3, common/signatures.js): a crash there is a strong
#     signature, elsewhere a weak one;
#   - an older task, whose tlspuffin had no catalogue, read against the latest one (PB_CATALOGUE_LATEST): its crash at
#     the place of a known bug is recognised as that bug (strong, not validated), known; elsewhere, not;
#   - a bug of tlspuffin's harness, given by commits: recognised in a commit without its fix (from git), not after it;
#   - TaskLinks (objectives_report.sh) writes those levels into task_links.json.
set -euo pipefail
here=$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )
qjs="${1:-/srv/puffin-bench/data/tools/qjs}"
[ -x "${qjs}" ] || { echo "SKIP: no qjs at ${qjs}"; exit 0; }
work=$( mktemp -d ); trap 'rm -rf "${work}"' EXIT
fail=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fail=1; fi; }
verdicts() { "${qjs}" --std -m "${here}/../tools/report_verdicts.js" "${work}/$1.json" && jq -c "$2" "${work}/$1.json"; }
# a run of WolfSSL 5.4.0 (wolfssl540-sdos2-asan): declared SDOS2, HEAP; its objectives in groups
run() { # <attempt> <declared JSON> <groups JSON> [<custom JSON>]
  jq -nc --argjson a "$1" --argjson d "$2" --argjson g "$3" --argjson c "${4:-null}" '{ library: "WolfSSL", attempt: $a,
    found: ([$g[].count] | add), replayed: ([$g[].count] | add), reports: ([$g[] | select(.type != "no-crash") | .count] | add // 0),
    cli: ({ vendor: "wolfssl:wolfssl540-sdos2-asan", library: { name: "wolfssl", version: "540" } }
          + (if $d then { vulnerabilities: { declared: $d } } else {} end) + (if $c then { custom: $c } else {} end)),
    groups: $g }'
}
heap='{ "type": "heap-buffer-overflow", "frames": ["AddPacketInfo", "DoTls13HandShakeMsgType"], "count": 2, "traces": ["h1", "h2"] }'
segv='{ "type": "SEGV", "frames": ["__memmove_avx_unaligned_erms", "DoTls13ClientHello", "DoTls13HandShakeMsgType"], "count": 1, "traces": ["s1"],
        "fuzzer": { "kind": "crash", "detail": "SIGSEGV", "frames": ["DoTls13ClientHello"] } }'
segvElsewhere='{ "type": "SEGV", "frames": ["ParseCertRelative", "ProcessPeerCerts"], "count": 1, "traces": ["x1"] }'
uaf='{ "type": "heap-use-after-free", "frames": ["FreeKeyExchange", "Caller"], "count": 1, "traces": ["u1"] }'
noCrash='{ "type": "no-crash", "frames": [], "count": 3, "traces": ["z1", "z2", "z3"] }'
cves='{ "CVE-2022-38152": { "alias": "SDOS2", "library": "wolfssl", "kind": "crash", "place": ["DoTls13ClientHello", "DoTls13HandShakeMsgType", "DoTls13HandShakeMsg"] },
        "CVE-2022-42905": { "alias": "HEAP", "library": "wolfssl", "kind": "crash", "place": ["AddPacketInfo", "DoTls13HandShakeMsgType", "DoTls13HandShakeMsg"] } }'
report() { # <name> <job type> <runs JSON> [<validation JSON>]
  jq -n --arg t "$2" --argjson r "$3" --argjson v "${4:-null}" --argjson cves "${cves}" '{ task: "9", commit: "abc", job_type: $t,
    runs: $r, cves: $cves, targets: {},
    libraries: [{ library: "WolfSSL", runs: ($r | length), outcomes: ([$r[] | { (.attempt | tostring): "success" }] | add),
                  validation: $v }] }' > "${work}/$1.json"
}
validation() { # <byTrace JSON>
  jq -nc --argjson b "$1" '{ catalogue: { source: "commit", commit: "abc" }, byTrace: $b,
    entries: { "CVE-2022-38152": { alias: "SDOS2", oracle: { kind: "crash", asan: "SEGV" } },
               "CVE-2022-42905": { alias: "HEAP", oracle: { kind: "crash", asan: "heap-buffer-overflow" } },
               "CVE-2022-25640": { alias: "SKIP", oracle: { kind: "claim", violation: "Authentication bypass" } } } }'
}

report known perf "[$( run 0 '["CVE-2022-38152","CVE-2022-42905"]' "[${heap},${segv}]" )]" \
  "$( validation '{ "0/h1": { "verdict": "confirmed", "entries": ["CVE-2022-42905"] }, "0/s1": { "verdict": "not-patched", "known_unpatched": ["CVE-2022-38152"] } }' )"
check 'Perf, the known bugs of its version: known, 🐞 plain' \
  '[ "$( verdicts known "[.verdicts.headline.level, .verdicts.history.level, .verdicts.headline.new]" )" == "[\"known\",null,0]" ]'

report none perf "[$( run 0 '[]' "[${noCrash}]" )]"
check 'Perf with objectives on a version that declares no known bug: unexpected, 🐞 gold' \
  '[ "$( verdicts none "[.verdicts.headline.level, .verdicts.history.level, (.verdicts.headline.nothingExpected | join(\",\"))]" )" == "[\"unexpected\",\"unexpected\",\"WolfSSL\"]" ]'
report nonenew perf "[$( run 0 '[]' "[${uaf}]" )]"
check 'a real bug on a version that declares no known bug: new (above unexpected)' \
  '[ "$( verdicts nonenew "[.verdicts.headline.level, .verdicts.history.level]" )" == "[\"new\",\"new\"]" ]'

report new perf "[$( run 0 '["CVE-2022-38152","CVE-2022-42905"]' "[${heap},${uaf}]" )]" \
  "$( validation '{ "0/h1": { "verdict": "confirmed", "entries": ["CVE-2022-42905"] }, "0/u1": { "verdict": "not-patched", "known_unpatched": [] } }' )"
echo '{ "WolfSSL|crash|FreeKeyExchange": { "task": "1" } }' > "${work}/known_bugs.json"
check 'validation finds no known signature: new, 🐞 red, whatever the registry says' \
  '[ "$( verdicts new "[.verdicts.headline.level, .verdicts.history.level, .verdicts.headline.new]" )" == "[\"new\",\"new\",1]" ] && verdicts new .verdicts.history.title | grep -q "NEW BUG"'
rm -f "${work}/known_bugs.json"

report weak perf "[$( run 0 '["CVE-2022-38152","CVE-2022-42905"]' "[${segvElsewhere}]" )]" \
  "$( validation '{ "0/x1": { "verdict": "not-patched", "known_unpatched": ["CVE-2022-38152"] } }' )"
check 'a weak signature (SDOS2) does not make a SEGV elsewhere known: new by its stack' \
  '[ "$( verdicts weak "[.verdicts.headline.level, .verdicts.headline.new]" )" == "[\"new\",1]" ]'
report weakhere perf "[$( run 0 '["CVE-2022-38152","CVE-2022-42905"]' "[${segv}]" )]" \
  "$( validation '{ "0/s1": { "verdict": "not-patched", "known_unpatched": ["CVE-2022-38152"] } }' )"
check 'the same weak signature where SDOS2 crashes (its CVE signature in vuln_targets.json): known' \
  '[ "$( verdicts weakhere "[.verdicts.headline.level, .verdicts.headline.new]" )" == "[\"known\",0]" ]'

custom='{ "benchmark": "C", "target": "CVE-2022-38152", "oracle": { "kind": "crash", "asan": "SEGV" } }'
report custom vuln-custom "[$( run 0 '["CVE-2022-38152"]' "[${segv}]" "${custom}" ), $( run 1 '["CVE-2022-38152"]' "[${uaf}]" "${custom}" )]" \
  "$( validation '{ "0/s1": { "verdict": "not-patched", "known_unpatched": ["CVE-2022-38152"] }, "1/u1": { "verdict": "not-patched", "known_unpatched": [] } }' )"
check 'a custom benchmark: its 🎯, the runs whose objectives validation names its target' \
  '[ "$( verdicts custom "[.verdicts.conclusion.configurations, .verdicts.conclusion.counted, .verdicts.conclusion.runs, (.verdicts.libraries.WolfSSL.found | join(\",\"))]" )" == "[1,1,2,\"0\"]" ]'
# a configuration of the same benchmark whose runs found nothing (no run in runs[]: its target only in its entry,
# libraries[].cli.custom, as objectives_report.sh and objectives_live.sh LiveLibraries record it): 🎯 0/1, not left out
jq --argjson c "${custom}" '.libraries += [{ library: "Empty", runs: 1, ends: { "0": "TimedOut" }, outcomes: { "0": "fail" },
    cli: { vendor: "wolfssl:wolfssl540-sdos2-asan-only-CVE-2022-38152", custom: $c } }]' "${work}/custom.json" > "${work}/customempty.json"
check 'a custom configuration whose runs found nothing: its 🎯 0/1 counts (the task is not all found)' \
  '[ "$( verdicts customempty "[.verdicts.conclusion.configurations, .verdicts.conclusion.hit, .verdicts.conclusion.runs, .verdicts.conclusion.level, .verdicts.libraries.Empty.cve, (.verdicts.libraries.Empty.runs | length), (.verdicts.libraries.Empty.found | length)]" )" == "[2,1,3,\"none\",\"CVE-2022-38152\",1,0]" ]'
report customlive vuln-custom "[$( run 0 '["CVE-2022-38152"]' "[${segv}]" "${custom}" )]"
# a custom benchmark of the claim set apart on wolfSSL < 5.7.2 (CVE-2024-5814): its claim is its target there, not set apart
c5814='{ "benchmark": "C", "target": "CVE-2024-5814", "oracle": { "kind": "claim", "violation": "Negotiated cipher is not in agent'"'"'s configured ciphers list" } }'
claim5814='{ "type": "security-violation", "frames": ["Negotiated cipher is not in agent'"'"'s configured ciphers list"], "count": 2, "traces": ["n1", "n2"],
            "fuzzer": { "kind": "claim", "detail": "Negotiated cipher is not in agent'"'"'s configured ciphers list", "frames": [] } }'
report custom5814 vuln-custom "[$( run 0 '["CVE-2024-5814"]' "[${claim5814}]" "${c5814}" )]"
jq '.not_targeted = { "Negotiated cipher is not in agent'"'"'s configured ciphers list": { cve: "CVE-2024-5814", library: "wolfssl", below: "5.7.2" } }' \
  "${work}/custom5814.json" > "${work}/custom5814.tmp" && mv "${work}/custom5814.tmp" "${work}/custom5814.json"
printf '%s\n' "import { AnalyseReport } from '${here}/../tools/objectives_page/bugs.js';" 'const a = AnalyseReport(JSON.parse(std.loadFile(scriptArgs[1])));' \
  'print(JSON.stringify(a.bugs.map(b => [!!b.expected, b.notTarget ?? null])));' > "${work}/apart.js"
check 'a custom benchmark of CVE-2024-5814: its claim is its target, never set apart (+k ⦸)' \
  '[ "$( "${qjs}" --std -m "${work}/apart.js" "${work}/custom5814.json" )" == "[[true,null]]" ]'
# the same claim where a run looks for a target (a Vuln flow launched as a live test, its configuration's target BUF): set
# apart, as the job scripts do (named after its CVE, not unexpected); in a campaign (no target): a CVE of its build
nt5814='{ "Negotiated cipher is not in agent'"'"'s configured ciphers list": { "cve": "CVE-2024-5814", "library": "wolfssl", "below": "5.7.2" } }'
report livetest livetest "[$( run 0 '["CVE-2022-39173","CVE-2024-5814"]' "[${claim5814}]" )]"
jq --argjson nt "${nt5814}" '.not_targeted = $nt | .targets = { WolfSSL: { cve: "CVE-2022-39173", kind: "crash", place: ["RefineSuites", "CheckPreSharedKeys", "DoTls13ClientHello"] } }' \
  "${work}/livetest.json" > "${work}/livetest.tmp" && mv "${work}/livetest.tmp" "${work}/livetest.json"
report campaign5814 campaign "[$( run 0 '["CVE-2024-5814"]' "[${claim5814}]" )]"
jq --argjson nt "${nt5814}" '.not_targeted = $nt' "${work}/campaign5814.json" > "${work}/campaign5814.tmp" && mv "${work}/campaign5814.tmp" "${work}/campaign5814.json"
check 'a run looking for a target, whatever its job (livetest): the claim of CVE-2024-5814 set apart there, not unexpected' \
  '[ "$( "${qjs}" --std -m "${work}/apart.js" "${work}/livetest.json" )" == "[[false,\"CVE-2024-5814\"]]" ] && [ "$( verdicts livetest .verdicts.headline.level )" != "\"unexpected\"" ]'
check 'a campaign (no target): the claim is not set apart' \
  '[ "$( "${qjs}" --std -m "${work}/apart.js" "${work}/campaign5814.json" )" == "[[false,null]]" ]'
check 'a custom benchmark before validation: its target by its signature (provisional until validation says)' \
  '[ "$( verdicts customlive "[.verdicts.conclusion.counted, .verdicts.conclusion.runs]" )" == "[1,1]" ]'

report unclear perf "[$( run 0 '["CVE-2022-38152"]' "[${noCrash}]" )]"
check 'objectives, nothing reproduced, no fuzzer record: unclear, History outlined (warning)' \
  '[ "$( verdicts unclear "[.verdicts.headline.level, .verdicts.history.level]" )" == "[\"unclear\",\"warning\"]" ]'

cdosRecord='{ "type": "no-crash", "frames": [], "count": 1, "traces": ["c1"],
              "fuzzer": { "kind": "crash", "detail": "SIGABRT · ASan bad-free", "frames": ["wolfSSL_Free", "AddSessionToCache"] } }'
cdos='{ "benchmark": "C", "target": "CVE-2022-38153", "oracle": { "kind": "crash", "asan": "bad-free" } }'
report cdos vuln-custom "[$( run 0 '["CVE-2022-38153"]' "[${cdosRecord}]" "${cdos}" )]" \
  "$( jq -nc '{ catalogue: { source: "commit", commit: "abc" }, byTrace: { "0/c1": { verdict: "inconclusive", entries: [] } },
               entries: { "CVE-2022-38153": { alias: "CDOS", oracle: { kind: "crash", asan: "bad-free" }, replayable: false } } }' )"
check 'a target known not to replay (CDOS), found by the fuzzer: known, History plain' \
  '[ "$( verdicts cdos "[.verdicts.headline.level, .verdicts.history.level]" )" == "[\"known\",null]" ]'
printf '%s\n' "import { AnalyseReport } from '${here}/../tools/objectives_page/bugs.js';" \
  'const a = AnalyseReport(JSON.parse(std.loadFile(scriptArgs[1])));' \
  'print(JSON.stringify(a.bugs.map(b => [b.validation?.kind, b.validation?.parts.map(p => p.ids.join()), b.noReplay])));' > "${work}/kind.js"
# a validation written before the entries had their replayable flag: the catalogue gives it
jq '.libraries[0].validation.entries["CVE-2022-38153"] |= del(.replayable)' "${work}/cdos.json" > "${work}/cdosold.json"
echo '{ "format": "vulnerabilities.toml", "vendors": { "wolfssl": { "entries": {
  "CVE-2022-38153": { "alias": "CDOS", "oracle": { "kind": "crash", "asan": "bad-free" }, "replayable": false, "top_frames": ["AddSessionToCache"] } } } } }' > "${work}/catalogue.json"
"${qjs}" --std -m "${here}/../tools/report_verdicts.js" "${work}/cdosold.json" "${work}/catalogue.json"
check 'with the catalogue: its replayable flag and top frames into the entries of the report' \
  '[ "$( jq -c ".libraries[0].validation.entries[\"CVE-2022-38153\"] | [.replayable, .top_frames]" "${work}/cdosold.json" )" == "[false,[\"AddSessionToCache\"]]" ]'
# a validation without entries (older, or unsupported): the catalogue's digest in the report says it
jq '.libraries[0].validation.entries = {}' "${work}/cdos.json" > "${work}/cdosnoentries.json"
"${qjs}" --std -m "${here}/../tools/report_verdicts.js" "${work}/cdosnoentries.json" "${work}/catalogue.json"
check 'without entries: the digest of the catalogue in the report, CDOS known not to replay from it' \
  '[ "$( jq -c ".catalogue_digest.vendors.wolfssl.entries[\"CVE-2022-38153\"].replayable" "${work}/cdosnoentries.json" )" == false ] \
   && "${qjs}" --std -m "${work}/kind.js" "${work}/cdosnoentries.json" | grep -qF "[\"CVE-2022-38153\"]]]"'
# a report of a commit without catalogue nor validation (an old Vuln group A task): the bench's table of CVEs says it
jq '.libraries[0].validation = null | .cves = { "CVE-2022-38153": { alias: "CDOS", library: "wolfssl", kind: "crash", place: ["wolfSSL_Free", "AddSessionToCache", "AddSession"], replayable: false } }' \
  "${work}/cdos.json" > "${work}/cdosnocatalogue.json"
check 'no catalogue, no validation: CDOS known not to replay from vuln_targets.json (report.cves)' \
  '"${qjs}" --std -m "${work}/kind.js" "${work}/cdosnocatalogue.json" | grep -qF "[\"CVE-2022-38153\"]]]"'
# the stack of SDOS2's witness (tools/witness_stacks.py, PB_WITNESS_FRAMES): a SEGV where it crashes is a strong signature
echo '{ "CVE-2022-38152": { "frames": ["__memmove_avx_unaligned_erms", "DoTls13ClientHello", "DoTls13HandShakeMsgType", "DoTls13HandShakeMsg"] } }' > "${work}/witness_frames.json"
cp "${work}/weakhere.json" "${work}/strong.json"; cp "${work}/weak.json" "${work}/weakelsewhere.json"
echo '{ "format": "vulnerabilities.toml", "vendors": { "wolfssl": { "entries": { "CVE-2022-38152": { "alias": "SDOS2", "affected": "< 5.5.0", "oracle": { "kind": "crash", "asan": "SEGV" } } } } } }' > "${work}/catalogue-sdos2.json"
PB_WITNESS_FRAMES="${work}/witness_frames.json" "${qjs}" --std -m "${here}/../tools/report_verdicts.js" "${work}/strong.json" "${work}/catalogue-sdos2.json"
PB_WITNESS_FRAMES="${work}/witness_frames.json" "${qjs}" --std -m "${here}/../tools/report_verdicts.js" "${work}/weakelsewhere.json" "${work}/catalogue-sdos2.json"
printf '%s\n' "import { AnalyseReport } from '${here}/../tools/objectives_page/bugs.js';" \
  'const a = AnalyseReport(JSON.parse(std.loadFile(scriptArgs[1])));' \
  'print(JSON.stringify(a.bugs.map(b => b.validation?.parts?.filter(p => p.kind === "signature").map(p => [p.weak, p.references?.["CVE-2022-38152"]])).flat()));' > "${work}/strength.js"
place='["DoTls13ClientHello","DoTls13HandShakeMsgType","DoTls13HandShakeMsg"]'
check "SDOS2 without top frames in the catalogue: its place is its witness's first 3 frames (R3, the runtime and glibc's __memmove left out); a SEGV there is strong" \
  '[ "$( "${qjs}" --std -m "${work}/strength.js" "${work}/strong.json" )" == "[[false,${place}]]" ]'
check 'a SEGV elsewhere stays weak' \
  '[ "$( "${qjs}" --std -m "${work}/strength.js" "${work}/weakelsewhere.json" )" == "[[true,${place}]]" ]'
# an older task, whose tlspuffin had no catalogue: read against the latest one (objectives_report.sh, PB_CATALOGUE_LATEST),
# its crash at SDOS2's place is recognised as SDOS2, not validated, known; a SEGV elsewhere is not
report old perf "[$( run 0 null "[${segv}]" )]"
report oldelsewhere perf "[$( run 0 null "[${segvElsewhere}]" )]"
# the same crash on wolfSSL 5.8.0, which SDOS2 does not affect (< 5.5.0): never named SDOS2 (a new bug or a regression)
jq '.runs[].cli.library.version = "580"' "${work}/old.json" > "${work}/oldnewer.json"
for f in old oldelsewhere oldnewer; do
  PB_CATALOGUE_LATEST=1 PB_WITNESS_FRAMES="${work}/witness_frames.json" "${qjs}" --std -m "${here}/../tools/report_verdicts.js" "${work}/${f}.json" "${work}/catalogue-sdos2.json"
done
printf '%s\n' "import { AnalyseReport } from '${here}/../tools/objectives_page/bugs.js';" \
  'const r = JSON.parse(std.loadFile(scriptArgs[1])); const a = AnalyseReport(r);' \
  'print(JSON.stringify([r.catalogue_digest?.latest, a.headline.level, a.bugs.flatMap(b => (b.validation?.parts ?? []).filter(p => p.recognised).map(p => [p.ids, p.weak, p.latest]))]));' > "${work}/recognised.js"
check 'an older task without catalogue: its crash at the place of SDOS2 in the latest catalogue is recognised as SDOS2 (strong, not validated): known' \
  '[ "$( "${qjs}" --std -m "${work}/recognised.js" "${work}/old.json" )" == "[true,\"known\",[[[\"CVE-2022-38152\"],false,true]]]" ]'
# a bug of tlspuffin's harness, given by commits (affected_commits): recognised in a commit without its fix
# (PB_COMMIT_AFFECTED, from git: objectives_report.sh CommitAffected), not in one that has it
hkdf='{ "type": "global-buffer-overflow", "frames": ["MemcmpInterceptorCommon(void*,", "tls13_hkdf_expand_label_with_length", "tls13_hkdf_expand_label"], "count": 1, "traces": ["k1"] }'
jq -nc --argjson g "[${hkdf}]" '{ task: "9", commit: "abc", job_type: "perf", cves: {}, targets: {},
  runs: [{ library: "LibreSSL", attempt: 0, found: 1, replayed: 1, reports: 1, groups: $g,
           cli: { vendor: "libressl:libressl333-asan", library: { name: "libressl", version: "333" } } }],
  libraries: [{ library: "LibreSSL", runs: 1, outcomes: { "0": "success" }, validation: null }] }' > "${work}/harness.json"
cp "${work}/harness.json" "${work}/harnessfixed.json"
echo '{ "format": "vulnerabilities.toml", "vendors": { "libressl": { "entries": { "PUFFIN-HKDF": { "alias": "HKDFCLAIM", "bug_in_harness": true,
  "affected_commits": "not containing 0123abc", "oracle": { "kind": "crash", "asan": "global-buffer-overflow" }, "top_frames": ["tls13_hkdf_expand_label_with_length"] } } } } }' > "${work}/catalogue-harness.json"
PB_COMMIT_AFFECTED='{"PUFFIN-HKDF":true}' "${qjs}" --std -m "${here}/../tools/report_verdicts.js" "${work}/harness.json" "${work}/catalogue-harness.json"
PB_COMMIT_AFFECTED='{"PUFFIN-HKDF":false}' "${qjs}" --std -m "${here}/../tools/report_verdicts.js" "${work}/harnessfixed.json" "${work}/catalogue-harness.json"
check "a bug of tlspuffin's harness in a commit without its fix: recognised by its place, known" \
  '[ "$( "${qjs}" --std -m "${work}/recognised.js" "${work}/harness.json" )" == "[false,\"known\",[[[\"PUFFIN-HKDF\"],false,false]]]" ] && jq -e ".verdicts.headline.level == \"known\"" "${work}/harness.json" > /dev/null'
check "the same crash in a commit with the fix: not that bug" \
  '[ "$( "${qjs}" --std -m "${work}/recognised.js" "${work}/harnessfixed.json" )" == "[false,\"unexpected\",[]]" ]'
check 'an older task without catalogue: the same crash on a version SDOS2 does not affect is not SDOS2' \
  '"${qjs}" --std -m "${work}/recognised.js" "${work}/oldnewer.json" | grep -qF ",[]]"'
check 'an older task without catalogue: a SEGV elsewhere is recognised as no known bug (not known)' \
  '[ "$( "${qjs}" --std -m "${work}/recognised.js" "${work}/oldelsewhere.json" )" == "[true,\"unexpected\",[]]" ]'
check 'its verdict: does not replay, as known (CDOS), not inconclusive' \
  '[ "$( "${qjs}" --std -m "${work}/kind.js" "${work}/cdos.json" )" == "[[\"no-replay\",[\"CVE-2022-38153\"],[\"CVE-2022-38153\"]]]" ] \
   && [ "$( "${qjs}" --std -m "${work}/kind.js" "${work}/cdosold.json" )" == "[[\"no-replay\",[\"CVE-2022-38153\"],[\"CVE-2022-38153\"]]]" ]'

# TaskLinks: the levels into task_links.json (objectives_report.sh, its function alone)
mkdir -p "${work}/root/data/html/board/custom" "${work}/out"
command cp -f "${work}/known.json" "${work}/out/101.json"; command cp -f "${work}/none.json" "${work}/out/102.json"
command cp -f "${work}/new.json" "${work}/out/103.json"; command cp -f "${work}/unclear.json" "${work}/out/104.json"
command cp -f "${work}/cdos.json" "${work}/out/105.json"
for id in 101 102 103 104 105; do touch "${work}/out/${id}.html"; done
(
  source <( sed -n '/^TaskLinks()/,/^}/p' "${here}/../tools/objectives_report.sh" )
  PB_ROOT="${work}/root" OUT="${work}/out"; TaskFile() { echo x; }
  TaskLinks
)
links="${work}/root/data/html/board/custom/task_links.json"
check 'TaskLinks: plain for known, gold for unexpected, red for new, warning for nothing reproduced' \
  '[ "$( jq -c "[.\"101\"[0].level, .\"102\"[0].level, .\"103\"[0].level, .\"104\"[0].level, .\"103\"[0].label]" "${links}" )" == "[null,\"unexpected\",\"new\",\"warning\",\"🚨 🐞\"]" ]'
check 'TaskLinks: plain for a known bug that no replay reproduces (CDOS, its 🎯 then its 🐞)' \
  '[ "$( jq -c "[.\"105\"[] | .level]" "${links}" )" == "[\"expected-all\",null]" ]'
exit "${fail}"
