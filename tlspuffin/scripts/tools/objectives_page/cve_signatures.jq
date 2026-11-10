# The signature of each known CVE (how its bug is recognized), from vuln_targets.json: {CVE: {alias, library, kind,
# match}}. library: the library the CVE is in (_cves, else the vendor of the target naming it, else _not_targeted).
# A CVE's own kind/match in _cves first (CVEs that are no target), else the target entry naming it (VulnA presets),
# else the claim of _not_targeted naming it. CVEs without a signature are left out: they cannot be recognized.
# Used by objectives_report.sh and objectives_live.sh (the "cves" of a report, see bugs.js NewBugs).
. as $t
| ($t._cves // {} | with_entries(select(.key | startswith("_") | not))) as $cves
| ([$t | to_entries[] | select((.key | startswith("_") | not) and (.value | type) == "object" and .value.cve != null)
    | { key: .value.cve, value: { kind: .value.kind, match: .value.match, library: (.key | split(":")[0]) } }] | from_entries) as $targets
| ([$t._not_targeted // {} | to_entries[] | { key: .value.cve, value: { kind: "claim", match: .key, library: .value.library } }] | from_entries) as $apart
| [($cves | keys[]), ($targets | keys[]), ($apart | keys[])] | unique
| map(. as $c | { key: $c, value: ({ alias: ($cves[$c].alias // null),
                                     library: ($cves[$c].library // $targets[$c].library // $apart[$c].library // null) }
      + (if $cves[$c].kind != null then { kind: $cves[$c].kind, match: $cves[$c].match }
         else (($targets[$c] // $apart[$c] // {}) | { kind, match }) end)) })
| from_entries | with_entries(select(.value.kind != null and .value.match != null))
