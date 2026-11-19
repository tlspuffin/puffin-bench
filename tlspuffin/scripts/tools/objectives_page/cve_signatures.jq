# The signature of each known CVE (how its bug is recognized), from vuln_targets.json: {CVE: {alias, library, kind,
# place (a crash: the first frames of its witness's stack, HasPlace of common/signatures.js) or match (a claim: its
# message), replayable}} (replayable: false when its objectives do not replay on their own, _cves: CDOS; else null). library: the library the CVE is in (_cves, else the vendor of the target naming it, else _not_targeted).
# A CVE's own kind/match in _cves first (CVEs that are no target), else the target entry naming it (VulnA presets),
# else the claim of _not_targeted naming it. CVEs without a signature are left out: they cannot be recognized.
# Used by objectives_report.sh and objectives_live.sh (the "cves" of a report, see bugs.js NewBugs).
. as $t
| ($t._cves // {} | with_entries(select(.key | startswith("_") | not))) as $cves
| ([$t | to_entries[] | select((.key | startswith("_") | not) and (.value | type) == "object" and .value.cve != null)
    | { key: .value.cve, value: { kind: .value.kind, place: .value.place, match: .value.match, library: (.key | split(":")[0]) } }] | from_entries) as $targets
| ([$t._not_targeted // {} | to_entries[] | { key: .value.cve, value: { kind: "claim", match: .key, library: .value.library } }] | from_entries) as $apart
| [($cves | keys[]), ($targets | keys[]), ($apart | keys[])] | unique
| map(. as $c | { key: $c, value: ({ alias: ($cves[$c].alias // null), replayable: (if $cves[$c].replayable == false then false else null end),
                                     library: ($cves[$c].library // $targets[$c].library // $apart[$c].library // null) }
      + (if $cves[$c].kind != null then { kind: $cves[$c].kind, place: $cves[$c].place, match: $cves[$c].match }
         else (($targets[$c] // $apart[$c] // {}) | { kind, place, match }) end)) })
| from_entries | map_values(with_entries(select(.value != null)))
| with_entries(select(.value.kind != null and (if .value.kind == "crash" then (.value.place | length) > 0 else .value.match != null end)))
