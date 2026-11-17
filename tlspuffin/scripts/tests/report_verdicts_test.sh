#!/bin/bash
# report_verdicts_test.sh [<qjs>]: the verdicts objectives_report.sh writes into a report for the tools that do not run
# the pages (report_verdicts.js with bugs.js AnalyseReport, under QuickJS), what the history page shows of a task:
#   - Perf on a version whose known bugs it found (declared CVEs, validation by patch): known, its 🐞 plain;
#   - Perf with objectives on a version that declares no known bug: unexpected, its 🐞 gold (new when one is a real bug);
#   - a bug the validation finds with no known bug's signature: new (🚨), its 🐞 red, whatever the registry;
#   - a weak signature (SDOS2: any ASan SEGV) does not make a crash elsewhere known: new by its stack;
#   - a claim split by patch (SplitByPatch): a verdict that a failed control can have made false has no say there either;
#   - a custom crash target without patch nor known place, named by its signature: the find, its 🎯 weak;
#   - a custom crash target without a verdict that decides: a crash of its type at its place when known (elsewhere, not
#     the find), by its type alone when not (weak);
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
#   - timeouts: no replay past the time the fuzzer gives an execution, a timeout under load (puffin's: no bug, no
#     level, ⏱ apart, with its traces' sizes and replay times); a replay past it, the bug "timeout" (new where none is
#     declared);
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
    entries: { "CVE-2022-38152": { alias: "SDOS2", oracle: { kind: "crash", asan: "SEGV" },
                                   witness_frames: ["__memmove_avx_unaligned_erms", "DoTls13ClientHello", "DoTls13HandShakeMsgType", "DoTls13HandShakeMsg"] },
               "CVE-2022-42905": { alias: "HEAP", oracle: { kind: "crash", asan: "heap-buffer-overflow" } },
               "CVE-2022-25640": { alias: "SKIP", oracle: { kind: "claim", violation: "Authentication bypass" } } } }'
}

report known perf "[$( run 0 '["CVE-2022-38152","CVE-2022-42905"]' "[${heap},${segv}]" )]" \
  "$( validation '{ "0/h1": { "verdict": "confirmed", "entries": ["CVE-2022-42905"] }, "0/s1": { "verdict": "not-patched", "known_unpatched": ["CVE-2022-38152"] } }' )"
check 'Perf, the known bugs of its version: known, 🐞 plain' \
  '[ "$( verdicts known "[.verdicts.headline.level, .verdicts.history.level, .verdicts.headline.new]" )" == "[\"known\",null,0]" ]'
# an SDOS2 crash whose replay (ASan) crashes in glibc's __memmove_avx_unaligned_erms, its fuzzer's record in
# DoTls13ClientHello: one bug, keyed by the first frame that locates it (glibc's variants left out, as the place of a bug),
# with the fuzzer's record; the registry of known bugs (known_bugs.js) the same key
printf '%s\n' "import { AnalyseReport } from '${here}/../tools/objectives_page/bugs.js';" 'const a = AnalyseReport(JSON.parse(std.loadFile(scriptArgs[1])));' \
  'print(JSON.stringify(a.bugs.filter(b => b.type === "SEGV").map(b => [b.key, !!b.fuzzer])));' > "${work}/keys.js"
check "a crash in glibc's memmove: keyed by DoTls13ClientHello, with the fuzzer's record" \
  '[ "$( "${qjs}" --std -m "${work}/keys.js" "${work}/known.json" )" == "[[\"crash|DoTls13ClientHello\",true]]" ]'
mkdir -p "${work}/registry" && command cp -f "${work}/known.json" "${work}/registry/9.json"
"${qjs}" --std -m "${here}/../tools/known_bugs.js" "${work}/registry" > /dev/null
check 'the registry of known bugs: the same key, not "a crash in memmove" (known_bugs.js)' \
  'jq -e "has(\"WolfSSL|crash|DoTls13ClientHello\") and (keys | map(select(test(\"memmove\"))) | length == 0) and .[\"WolfSSL|crash|DoTls13ClientHello\"].task == \"9\"" "${work}/registry/known_bugs.json" > /dev/null'

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
# a bug two of whose objectives validation tells apart: one confirmed by patch (BUF), one with no known bug's signature
# on the build with every patch (another bug in the same function, grouped with it): the bug is new, the task's level
# new, whatever the confirmed one says
bufc='{ "benchmark": "C", "target": "CVE-2022-39173", "oracle": { "kind": "crash", "asan": "stack-buffer-overflow" } }'
bufg='{ "type": "stack-buffer-overflow", "frames": ["RefineSuites", "CheckPreSharedKeys", "DoTls13ClientHello"], "count": 2, "traces": ["b1", "b2"] }'
report mixed vuln-custom "[$( run 0 '["CVE-2022-39173"]' "[${bufg}]" "${bufc}" )]" \
  "$( validation '{ "0/b1": { "verdict": "confirmed", "entries": ["CVE-2022-39173"] }, "0/b2": { "verdict": "not-patched", "known_unpatched": [] } }' )"
check 'a bug with an objective confirmed by patch and one with no known signature: new, the task new' \
  '[ "$( verdicts mixed "[.verdicts.headline.level, .verdicts.headline.new, .verdicts.history.level]" )" == "[\"new\",1,\"new\"]" ]'
# a custom target without patch at the version built (SDOS2 on 5.4.0), named by its signature only: a crash elsewhere
# than its place is not the find, whatever its ASan type
report customelse vuln-custom "[$( run 0 '["CVE-2022-38152"]' "[${segvElsewhere}]" "${custom}" )]" \
  "$( validation '{ "0/x1": { "verdict": "not-patched", "known_unpatched": ["CVE-2022-38152"] } }' )"
check 'a custom target named by its signature only: a crash elsewhere is not the find, nor a known bug' \
  '[ "$( verdicts customelse "[.verdicts.conclusion.counted, .verdicts.headline.allKnown, .verdicts.headline.text]" )" == "[0,false,\"1 bug found\"]" ]'
# a Vuln group A target recognised by its place, the find validated as no known bug: not the target, new
heapPlaced='{ "type": "heap-buffer-overflow", "frames": ["AddPacketInfo", "DoTls13HandShakeMsgType", "DoTls13HandShakeMsg"], "count": 1, "traces": ["v1"] }'
report vulna vuln-a "[$( run 0 '["CVE-2022-42905"]' "[${heapPlaced}]" )]" \
  "$( validation '{ "0/v1": { "verdict": "not-patched", "known_unpatched": [] } }' )"
jq '.targets = { WolfSSL: { cve: "CVE-2022-42905", kind: "crash", place: ["AddPacketInfo", "DoTls13HandShakeMsgType", "DoTls13HandShakeMsg"] } }' \
  "${work}/vulna.json" > "${work}/vulna.tmp" && mv "${work}/vulna.tmp" "${work}/vulna.json"
check 'Vuln group A: a crash at the place of its target that validation finds no known bug in: not the target, new' \
  '[ "$( verdicts vulna "[.verdicts.conclusion.counted, .verdicts.headline.level, .verdicts.headline.new]" )" == "[0,\"new\",1]" ]'
jq '.libraries[0].validation = null' "${work}/vulna.json" > "${work}/vulna0.json"
check 'Vuln group A without validation: its target by its place, as before' \
  '[ "$( verdicts vulna0 "[.verdicts.conclusion.counted, .verdicts.headline.level]" )" == "[1,\"known\"]" ]'
# one claim, two bugs: objectives of "Authentication bypass" confirmed by patch as CVE-2021-3336 in one run and as SKIP in
# another: two bugs, each named after its own, counted as two
auth1='{ "type": "security-violation", "frames": ["Authentication bypass"], "count": 1, "traces": ["c1"], "fuzzer": { "kind": "claim", "detail": "Authentication bypass", "frames": [] } }'
auth2='{ "type": "security-violation", "frames": ["Authentication bypass"], "count": 1, "traces": ["c2"], "fuzzer": { "kind": "claim", "detail": "Authentication bypass", "frames": [] } }'
report twoclaims perf "[$( run 0 '["CVE-2021-3336","CVE-2022-25640"]' "[${auth1}]" ), $( run 1 '["CVE-2021-3336","CVE-2022-25640"]' "[${auth2}]" )]" \
  "$( validation '{ "0/c1": { "verdict": "confirmed", "entries": ["CVE-2021-3336"] }, "1/c2": { "verdict": "confirmed", "entries": ["CVE-2022-25640"] } }' )"
printf '%s\n' "import { AnalyseReport } from '${here}/../tools/objectives_page/bugs.js';" 'const a = AnalyseReport(JSON.parse(std.loadFile(scriptArgs[1])));' \
  'print(JSON.stringify(a.bugs.map(b => b.validation?.ids ?? []).sort()));' > "${work}/named.js"
check 'one claim confirmed by patch as two bugs: two bugs, each its own name, "2 known bugs found"' \
  '[ "$( verdicts twoclaims "[.verdicts.bugs.count, .verdicts.headline.text]" )" == "[2,\"2 known bugs found\"]" ] &&
   [ "$( "${qjs}" --std -m "${work}/named.js" "${work}/twoclaims.json" )" == "[[\"CVE-2021-3336\"],[\"CVE-2022-25640\"]]" ]'
# the split of a claim by patch (SplitByPatch) follows the rule of the failed controls too: with 3336's control failed
# in run 0, its "confirmed 3336" has no say, so no row is keyed after it (a row with nothing under it): one bug, its
# objectives confirmed SKIP by patch (run 1) and could not validate (run 0)
printf '%s\n' "import { AnalyseReport } from '${here}/../tools/objectives_page/bugs.js';" 'const a = AnalyseReport(JSON.parse(std.loadFile(scriptArgs[1])));' \
  'print(JSON.stringify(a.bugs.map(b => [b.key, b.count, b.validation?.ids ?? [], (b.validation?.parts ?? []).map(p => p.kind + (p.why ? ":" + p.why : "") + "x" + p.count).join(",")])));' > "${work}/split.js"
jq '.libraries[0].validation.failed_controls = { "0": [{ entry: "CVE-2021-3336", triggers_unpatched: false, triggers_patched: false }] }' \
  "${work}/twoclaims.json" > "${work}/twoclaimsfailed.json"
check "a claim split by patch, 3336's control failed: one bug, confirmed SKIP ×1 and could not validate ×1, no row named 3336" \
  '[ "$( "${qjs}" --std -m "${work}/split.js" "${work}/twoclaimsfailed.json" )" == "[[\"claim|Authentication bypass\",2,[\"CVE-2022-25640\"],\"patchx1,none:controlsx1\"]]" ]'
# failed controls (by side; of HEAP's 2 objectives one has a verdict, the other is "not chosen"): HEAP's witness
# did not trigger without its patch: a "confirmed HEAP" has no verdict;
# HEAP's witness triggered with every patch: a crash with HEAP's signature found on that build has none either (it may
# be HEAP, not a new bug); the verdict of SDOS2 beside them stands
printf '%s\n' "import { AnalyseReport } from '${here}/../tools/objectives_page/bugs.js';" 'const a = AnalyseReport(JSON.parse(std.loadFile(scriptArgs[1])));' \
  'print(JSON.stringify(a.bugs.map(b => [b.type, b.validation?.kind ?? null, (b.validation?.parts ?? []).map(p => p.kind + (p.why ? ":" + p.why : "")).join(","), !!b.isNew])));' > "${work}/parts.js"
report ctlunpatched perf "[$( run 0 '["CVE-2022-38152","CVE-2022-42905"]' "[${heap},${segv}]" )]" \
  "$( validation '{ "0/h1": { "verdict": "confirmed", "entries": ["CVE-2022-42905"] }, "0/s1": { "verdict": "not-patched", "known_unpatched": ["CVE-2022-38152"] } }' )"
jq '.libraries[0].validation.failed_controls = { "0": [{ entry: "CVE-2022-42905", triggers_unpatched: false, triggers_patched: false }] }' \
  "${work}/ctlunpatched.json" > "${work}/ctl.tmp" && mv "${work}/ctl.tmp" "${work}/ctlunpatched.json"
check "HEAP's witness did not trigger without its patch: its confirmed find has no verdict, SDOS2's stands" \
  '[ "$( "${qjs}" --std -m "${work}/parts.js" "${work}/ctlunpatched.json" )" == "[[\"heap-buffer-overflow\",null,\"none:not-chosen,none:controls\",false],[\"SEGV\",\"signature\",\"signature\",false]]" ]'
report ctlpatched perf "[$( run 0 '["CVE-2022-38152","CVE-2022-42905"]' "[${heap}]" )]" \
  "$( validation '{ "0/h1": { "verdict": "not-patched", "known_unpatched": [] } }' )"
jq '.libraries[0].validation.failed_controls = { "0": [{ entry: "CVE-2022-42905", triggers_unpatched: true, triggers_patched: true }] }' \
  "${work}/ctlpatched.json" > "${work}/ctl.tmp" && mv "${work}/ctl.tmp" "${work}/ctlpatched.json"
check "HEAP's witness triggered with every patch: a crash of its signature there has no verdict, not new" \
  '[ "$( "${qjs}" --std -m "${work}/parts.js" "${work}/ctlpatched.json" )" == "[[\"heap-buffer-overflow\",null,\"none:not-chosen,none:controls\",false]]" ]'
jq 'del(.libraries[0].validation.failed_controls)' "${work}/ctlpatched.json" > "${work}/ctlnone.json"
check 'the same crash with the controls passed: no known signature, new' \
  '[ "$( "${qjs}" --std -m "${work}/parts.js" "${work}/ctlnone.json" )" == "[[\"heap-buffer-overflow\",\"new\",\"new,none:not-chosen\",true]]" ]'
# the target of a run (🎯) by a verdict whose control failed: that verdict has no say there either (as on the bug's
# badge), the target is recognised as without validation, by its place: a crash elsewhere "confirmed HEAP" is not the
# find when HEAP's witness did not trigger without its patch; a crash at HEAP's place is, by its place
tHeap='{ "WolfSSL": { "cve": "CVE-2022-42905", "kind": "crash",
                     "place": ["AddPacketInfo", "DoTls13HandShakeMsgType", "DoTls13HandShakeMsg"] } }'
heapFailed='{ "0": [{ "entry": "CVE-2022-42905", "triggers_unpatched": false, "triggers_patched": false }] }'
report ctltarget vuln-a "[$( run 0 '["CVE-2022-38152","CVE-2022-42905"]' "[${uaf}]" )]" \
  "$( validation '{ "0/u1": { "verdict": "confirmed", "entries": ["CVE-2022-42905"] } }' )"
jq --argjson t "${tHeap}" '.targets = $t' "${work}/ctltarget.json" > "${work}/ctl.tmp" \
  && mv "${work}/ctl.tmp" "${work}/ctltarget.json"
check 'Vuln group A: a crash elsewhere that validation confirms as the target by patch, the controls passed: the find' \
  '[ "$( verdicts ctltarget "[.verdicts.conclusion.counted, .verdicts.conclusion.level]" )" == "[1,\"all\"]" ]'
jq --argjson c "${heapFailed}" '.libraries[0].validation.failed_controls = $c' "${work}/ctltarget.json" \
  > "${work}/ctltargetfailed.json"
check "Vuln group A: the same with HEAP's control failed: not the find (🎯 0/1), as without validation" \
  '[ "$( verdicts ctltargetfailed "[.verdicts.conclusion.counted, .verdicts.conclusion.level]" )" == "[0,\"none\"]" ]'
report ctlplace vuln-a "[$( run 0 '["CVE-2022-38152","CVE-2022-42905"]' "[${heapPlaced}]" )]" \
  "$( validation '{ "0/v1": { "verdict": "confirmed", "entries": ["CVE-2022-42905"] } }' )"
jq --argjson t "${tHeap}" --argjson c "${heapFailed}" '.targets = $t | .libraries[0].validation.failed_controls = $c' \
  "${work}/ctlplace.json" > "${work}/ctl.tmp" && mv "${work}/ctl.tmp" "${work}/ctlplace.json"
check "Vuln group A: a crash at HEAP's place with HEAP's control failed: the find, by its place" \
  '[ "$( verdicts ctlplace "[.verdicts.conclusion.counted, .verdicts.conclusion.level]" )" == "[1,\"all\"]" ]'
# a custom crash target without patch at its version nor known place (no witness stack, no top frames): a crash that
# validation names by its signature only (any crash of its ASan type: the run ends on it, the launcher takes it) is the
# find, counted weak (the 🎯 says so); before, never (🎯 0/1)
customU='{ "benchmark": "C", "target": "CVE-2022-42905", "oracle": { "kind": "crash", "asan": "heap-use-after-free" } }'
report weaktarget vuln-custom "[$( run 0 '["CVE-2022-42905"]' "[${uaf}]" "${customU}" )]" \
  "$( validation '{ "0/u1": { "verdict": "not-patched", "known_unpatched": ["CVE-2022-42905"] } }' )"
check 'a custom crash target without patch nor place, named by its signature: the find (🎯 1/1), weak' \
  '[ "$( verdicts weaktarget "[.verdicts.conclusion.counted, .verdicts.conclusion.level, .verdicts.libraries.WolfSSL.weak]" )" == "[1,\"all\",[0]]" ]'
# a custom crash target whose place is known (its witness's stack in the validation's record), no verdict that decides
# (none, inconclusive): a crash of its type elsewhere is not the find, as the run does not end on it (F1 of the audit of
# 2026-11-16: the place, when known, as Vuln group A); at its place, the find, not weak; its place not known: its type
# alone, weak
customH='{ "benchmark": "C", "target": "CVE-2022-42905", "oracle": { "kind": "crash", "asan": "heap-buffer-overflow" } }'
hboElsewhere='{ "type": "heap-buffer-overflow", "frames": ["ParseCertRelative", "ProcessPeerCerts"], "count": 1, "traces": ["e1"] }'
hboAtPlace='{ "type": "heap-buffer-overflow", "frames": ["AddPacketInfo", "DoTls13HandShakeMsgType", "DoTls13HandShakeMsg"], "count": 1, "traces": ["e1"] }'
heapWitness='.libraries[0].validation.entries["CVE-2022-42905"].witness_frames = ["AddPacketInfo", "DoTls13HandShakeMsgType", "DoTls13HandShakeMsg", "ProcessReplyEx"]'
custom_case() { # <name> <group> <byTrace JSON> <with its place: yes|no>
  report "$1" vuln-custom "[$( run 0 '["CVE-2022-42905"]' "[$2]" "${customH}" )]" "$( validation "$3" )"
  [ "$4" == yes ] && { jq "${heapWitness}" "${work}/$1.json" > "${work}/t.json" && mv "${work}/t.json" "${work}/$1.json"; }
  verdicts "$1" "[.verdicts.conclusion.counted, .verdicts.libraries.WolfSSL.weak]"
}
check 'custom target, its place known, a crash of its type elsewhere without verdict: not the find (🎯 0/1)' \
  '[ "$( custom_case f1none "${hboElsewhere}" "{}" yes )" == "[0,[]]" ]'
check 'custom target, its place known, a crash of its type elsewhere, inconclusive: not the find (🎯 0/1)' \
  '[ "$( custom_case f1inconclusive "${hboElsewhere}" "{ \"0/e1\": { \"verdict\": \"inconclusive\", \"entries\": [] } }" yes )" == "[0,[]]" ]'
check 'custom target, its place known, a crash at its place without verdict: the find, not weak (🎯 1/1)' \
  '[ "$( custom_case f1atplace "${hboAtPlace}" "{}" yes )" == "[1,[]]" ]'
check 'custom target, its place not known (no witness stack, no top frames), a crash of its type without verdict: the find, weak' \
  '[ "$( custom_case f1noplace "${hboElsewhere}" "{}" no )" == "[1,[0]]" ]'
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
check "History's 🐞: one count of the bugs, those set apart said (the report's title leaves them out of its count)" \
  '[ "$( verdicts livetest "[.verdicts.bugs.count, .verdicts.bugs.not_target, .verdicts.headline.real]" )" == "[1,1,0]" ] &&
   verdicts livetest .verdicts.history.title | grep -q "1 bug (1 of them not the target: a known CVE set apart)"'
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
# a bug of two stacks, recognised by any of them: CALLB on wolfSSL 5.5.2, its crashes in AddPacketInfo on the TLS 1.2
# path first (3 objectives, not its place), then on the TLS 1.3 one (2, its place): one bug (the fuzzer's key: the
# first frame), recognised as CALLB by the 2, not validated, known; before, by its first stack only: 🚨 new (task
# 1794741331008, live)
callbGroup() { # <second frame> <count> <trace prefix>
  jq -nc --arg f "$1" --argjson n "$2" --arg t "$3" '{ type: "heap-buffer-overflow", frames: ["AddPacketInfo", $f, ($f | sub("Type$"; ""))],
    count: $n, traces: [range($n) | "\($t)\(.)"],
    fuzzer: { kind: "crash", detail: "SIGABRT · ASan heap-buffer-overflow", frames: ["AddPacketInfo", $f, ($f | sub("Type$"; ""))] } }'
}
jq -n --argjson g "[$( callbGroup DoHandShakeMsgType 3 t ), $( callbGroup DoTls13HandShakeMsgType 2 u )]" '{ task: "9", commit: "abc", job_type: "vuln-custom",
  catalogue_digest: { format: "vulnerabilities.toml", commit: "abc", vendors: { wolfssl: { entries: { "CVE-2023-6936": { alias: "CALLB",
    oracle: { kind: "crash", asan: "heap-buffer-overflow" }, top_frames: ["AddPacketInfo", "DoTls13HandShakeMsgType"], affected: ">= 5.5.2, < 5.6.6" } } } } },
  runs: [{ library: "WolfSSL", attempt: 0, found: 5, replayed: 0, reports: 0, groups: $g,
           cli: { vendor: "wolfssl:wolfssl552-asan", library: { name: "wolfssl", version: "552" }, vulnerabilities: { declared: ["CVE-2023-6936"] } } }],
  libraries: [{ library: "WolfSSL", runs: 1 }] }' > "${work}/twostacks.json"
printf '%s\n' "import { AnalyseReport } from '${here}/../tools/objectives_page/bugs.js';" \
  'const r = JSON.parse(std.loadFile(scriptArgs[1])); const a = AnalyseReport(r, null, r.catalogue_digest);' \
  'print(JSON.stringify([a.headline.level, a.bugs.length, a.bugs.flatMap(b => (b.validation?.parts ?? []).filter(p => p.recognised).map(p => [p.ids, p.count, p.of ?? null]))]));' > "${work}/twostacks.js"
check 'a bug of two stacks, the first not at the place of CALLB: recognised as CALLB by the objectives at its place (2 of 5), known' \
  '[ "$( "${qjs}" --std -m "${work}/twostacks.js" "${work}/twostacks.json" )" == "[\"known\",1,[[[\"CVE-2023-6936\"],2,5]]]" ]'
jq '.runs[0].groups |= map(select(.frames[1] == "DoHandShakeMsgType"))' "${work}/twostacks.json" > "${work}/onestack.json"
check 'its TLS 1.2 objectives alone: not at its place, not recognised (validation tells)' \
  '[ "$( "${qjs}" --std -m "${work}/twostacks.js" "${work}/onestack.json" )" == "[\"new\",1,[]]" ]'
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

# a bug in what a run built, by the release its build recorded (cli.library.release): a two-digit part read (wolfSSL
# 5.10.0, whose preset name gives 5100, ambiguous: not read, the safe side)
printf '%s\n' "import { PresentInRun } from '${here}/../tools/objectives_page/bugs.js';" \
  "const e = { affected: '>= 5.9.0, < 5.11.0' }, run = (library) => ({ cli: { library } });" \
  "print(JSON.stringify([PresentInRun('X', e, run({ version: '5100', release: '5.10.0' })), PresentInRun('X', e, run({ version: '5100' })), PresentInRun('X', e, run({ version: '540' })), PresentInRun('X', { affected: '< 5.5.0' }, run({ version: '540' }))]));" > "${work}/present.js"
check 'a bug in what a run built: by its release when recorded (5.10.0), the compact 5100 alone not read, 540 read' \
  '[ "$( "${qjs}" --std -m "${work}/present.js" )" == "[true,false,false,true]" ]'
# TaskLinks: the levels into task_links.json (objectives_report.sh, its function alone)
mkdir -p "${work}/root/data/html/board/custom/tlspuffin" "${work}/out"
# timeouts (the user's rule, 2026-11-17): the fuzzer's timeout of an objective whose replays run under the time it gives
# an execution is a timeout under load, puffin's: no bug, no objective of the level, said apart (⏱); one whose replay
# runs past it is the bug "timeout" of its configuration, new on a version that declares no known bug
load='{ "type": "no-crash", "frames": ["error in PUT : decryption failed"], "count": 3, "traces": ["l1", "l2", "l3"],
        "fuzzer": { "kind": "timeout", "detail": "Timeout in fuzz run.", "frames": [] },
        "timing": { "replay_ms": [2100, 3900], "limit_ms": 5000, "size": [5196709, 7591124] } }'
lost='{ "type": "no-crash", "frames": ["error in PUT : decryption failed"], "count": 2, "traces": ["m1", "m2"],
        "fuzzer": { "kind": "timeout", "detail": "no line logged, the client restarted", "frames": [] },
        "timing": { "replay_ms": [2400, 2600], "limit_ms": 5000, "size": [5196744, 5196833] } }'
dos='{ "type": "timeout", "frames": [], "summary": "replay ran 7.2 s, past the fuzzer timeout (5.0 s)", "count": 1, "traces": ["t1"],
       "fuzzer": { "kind": "timeout", "detail": "Timeout in fuzz run.", "frames": [] },
       "timing": { "replay_ms": [7210, 7210], "limit_ms": 5000, "size": [612000, 612000] } }'
report underload campaign "[$( run 0 '[]' "[${load},${lost}]" )]"
check 'timeouts no replay reproduces: no bug, no level, said apart (⏱ 5 timeouts under load)' \
  '[ "$( verdicts underload "[.verdicts.headline.level, .verdicts.headline.real, .verdicts.headline.new, .verdicts.headline.underLoad]" )" == "[null,0,0,5]" ] &&
   verdicts underload .verdicts.headline.text | grep -q "⏱ 5 timeouts under load"'
printf '%s\n' "import { AnalyseReport, TimingText, FuzzerText } from '${here}/../tools/objectives_page/bugs.js';" \
  'const a = AnalyseReport(JSON.parse(std.loadFile(scriptArgs[1])));' \
  'print(JSON.stringify(a.bugs.map(b => [b.key, b.type, !!b.underLoad, b.count, TimingText(b.timing), FuzzerText(b.fuzzer)])));' > "${work}/timeouts.js"
check 'one bug of puffin per configuration, its traces and replay times (TimingText)' \
  '[ "$( "${qjs}" --std -m "${work}/timeouts.js" "${work}/underload.json" )" == "[[\"timeout-under-load|WolfSSL\",\"timeout-under-load\",true,5,\"traces 5.2–7.6 MB · replays 2.1–3.9 s, start of the binary included (the fuzzer gives the execution 5.0 s)\",\"timeout (Timeout in fuzz run.)\"]]" ]'
report dos campaign "[$( run 0 '[]' "[${load},${dos}]" )]"
check 'a timeout a replay reproduces: the bug "timeout", new on a version that declares none; the others still apart' \
  '[ "$( verdicts dos "[.verdicts.headline.level, .verdicts.headline.real, .verdicts.headline.new, .verdicts.headline.underLoad]" )" == "[\"new\",1,1,3]" ]'
check 'its type and summary: the replay past the fuzzer timeout' \
  '"${qjs}" --std -m "${work}/timeouts.js" "${work}/dos.json" | jq -e "map(select(.[0] == \"timeout|WolfSSL\" and .[1] == \"timeout\" and (.[2] | not) and .[3] == 1)) | length == 1" > /dev/null'
# a bug of puffin itself: validation names a catalogue entry with a PUFFIN- id (LibreSSL's HKDFCLAIM), tagged so
printf '%s\n' "import { PuffinIds } from '${here}/../tools/objectives_page/bugs.js';" \
  'print(JSON.stringify([PuffinIds({ validation: { parts: [{ kind: "patch", ids: ["PUFFIN-LIBRESSL333-HKDF-CLAIM"] }, { kind: "signature", ids: ["CVE-2022-25640"] }] } }),' \
  '  PuffinIds({ validation: { parts: [{ kind: "new", ids: ["PUFFIN-X"] }] } }), PuffinIds({})]));' > "${work}/puffin.js"
check 'a bug validation names by a PUFFIN- entry is a bug of puffin (only by patch or signature)' \
  '[ "$( "${qjs}" --std -m "${work}/puffin.js" )" == "[[\"PUFFIN-LIBRESSL333-HKDF-CLAIM\"],[],[]]" ]'
command cp -f "${work}/known.json" "${work}/out/101.json"; command cp -f "${work}/none.json" "${work}/out/102.json"
command cp -f "${work}/new.json" "${work}/out/103.json"; command cp -f "${work}/unclear.json" "${work}/out/104.json"
command cp -f "${work}/cdos.json" "${work}/out/105.json"
for id in 101 102 103 104 105; do touch "${work}/out/${id}.html"; done
(
  source <( sed -n '/^TaskLinks()/,/^}/p' "${here}/../tools/objectives_report.sh" )
  PB_ROOT="${work}/root" OUT="${work}/out"; TaskFile() { echo x; }
  TaskLinks
)
links="${work}/root/data/html/board/custom/tlspuffin/task_links.json"
check 'TaskLinks: plain for known, gold for unexpected, red for new, warning for nothing reproduced' \
  '[ "$( jq -c "[.\"101\"[0].level, .\"102\"[0].level, .\"103\"[0].level, .\"104\"[0].level, .\"103\"[0].label]" "${links}" )" == "[null,\"unexpected\",\"new\",\"warning\",\"🚨 🐞\"]" ]'
check 'TaskLinks: plain for a known bug that no replay reproduces (CDOS, its 🎯 then its 🐞)' \
  '[ "$( jq -c "[.\"105\"[] | .level]" "${links}" )" == "[\"expected-all\",null]" ]'
exit "${fail}"
