# The signature of each known CVE (how its bug is recognized), from vuln_targets.json: {CVE: {alias, kind, match}}.
# A CVE's own kind/match in _cves first (CVEs that are no target), else the target entry naming it (VulnA presets),
# else the claim of _not_targeted naming it. CVEs without a signature are left out: they cannot be recognized.
# Used by objectives_report.sh and objectives_live.sh (the "cves" of a report, see bugs.js NewBugs).
. as $t
| ($t._cves // {} | with_entries(select(.key | startswith("_") | not))) as $cves
| ([$t | to_entries[] | select((.key | startswith("_") | not) and (.value | type) == "object" and .value.cve != null)
    | { key: .value.cve, value: { kind: .value.kind, match: .value.match } }] | from_entries) as $targets
| ([$t._not_targeted // {} | to_entries[] | { key: .value.cve, value: { kind: "claim", match: .key } }] | from_entries) as $apart
| [($cves | keys[]), ($targets | keys[]), ($apart | keys[])] | unique
| map(. as $c | { key: $c, value: ({ alias: ($cves[$c].alias // null) }
      + (if $cves[$c].kind != null then { kind: $cves[$c].kind, match: $cves[$c].match }
         else ($targets[$c] // $apart[$c] // {}) end)) })
| from_entries | with_entries(select(.value.kind != null and .value.match != null))
