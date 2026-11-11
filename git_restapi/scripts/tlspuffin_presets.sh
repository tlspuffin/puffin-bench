#! /bin/bash
# tlspuffin_presets.sh <repository> <commit>: the vendor presets of tlspuffin at a commit, as JSON on stdout:
#   {"commit": "<sha>", "format": "presets.toml" | "none", "presets_format": 1 | 2, "asan_link": true | false,
#    "vendors": {"wolfssl": [{"name": "wolfssl540-sdos2",
#     "version": "5.4.0", "asan": false, "sancov": true, "fix": ["CVE-2022-39173"], "postauth": false}, …], …}}
# Read from puffin-build/vendors/<vendor>/presets.toml (tlspuffin since 2024-09-12); before, "format": "none". Format 2
# (tlspuffin pr/vuln-catalogue: [library], [versions], [modifiers], [aliases]) is listed as format 1 was: the build of
# each version under its name, the same with ASan (<name>-asan, a name of puffin-build's grammar), and the aliases.
# asan_link: the commit contains tlspuffin 854dbaa11 ("build: dynamically register the PUT instrumentation"), from
# which an ASAN preset links the ASAN runtime by itself; before, only with the asan cargo feature.
# Exit status 2: the commit is not in the repository.
repo="$1"; commit="$2"
sha=$(git -C "${repo}" rev-parse --verify --quiet "${commit}^{commit}") || exit 2
asan_link=false
asan_commit=$(git -C "${repo}" rev-parse --verify --quiet "854dbaa113192ecf6d2899714219ee40387757db^{commit}") &&
  git -C "${repo}" merge-base --is-ancestor "${asan_commit}" "${sha}" && asan_link=true
exec python3 -I - "${repo}" "${sha}" "${asan_link}" <<'PY'
import json, subprocess, sys, tomllib

repo, sha, asan_link = sys.argv[1], sys.argv[2], sys.argv[3] == "true"

def git(*args):
    return subprocess.run(["git", "-C", repo, *args], capture_output=True)

def expand(template, version):
    return (template.replace("{version_}", version.replace(".", "_"))
            .replace("{compact}", version.replace(".", "")).replace("{version}", version))

def format1(table):
    builds = []
    for name, p in table.items():
        if not isinstance(p, dict):
            continue
        builds.append({"name": name, "version": str((p.get("sources") or {}).get("version", "")),
                       "asan": p.get("asan") is True, "sancov": p.get("sancov") is True,
                       "postauth": p.get("postauth") is not False, "fix": [str(i) for i in p.get("fix") or []]})
    return builds

def format2(vendor, table):
    library, modifiers = table.get("library") or {}, table.get("modifiers") or {}
    plain = {m: bool((d or {}).get("default")) for m, d in modifiers.items()}
    def build(name, version, said, fix):
        value = lambda m, default: said.get(m, plain.get(m, default))
        return {"name": name, "version": version, "asan": value("asan", False), "sancov": value("sancov", True),
                "postauth": value("postauth", True), "fix": fix}
    builds, by_version = [], {}
    for version, entry in (table.get("versions") or {}).items():
        name = (entry or {}).get("name") or expand(library.get("name", vendor + "{compact}"), version)
        by_version[version] = name
        builds.append(build(name, version, {}, []))
        builds.append(build(name + "-asan", version, {"asan": True}, []))
    for alias, text in (table.get("aliases") or {}).items():
        tokens = [t.strip() for t in str(text).split(",")]
        if not tokens or tokens[0] not in by_version:
            continue
        said, fix = {}, []
        for token in tokens[1:]:
            if token.startswith("fix-"):
                fix += token[4:].split("+")
            elif token.startswith("no-"):
                said[token[3:]] = False
            else:
                said[token] = True
        builds.append(build(alias, tokens[0], said, fix))
    return builds

listing = git("ls-tree", "--name-only", sha, "--", "puffin-build/vendors/")
dirs = listing.stdout.decode().split() if listing.returncode == 0 else []
vendors, versions_format = {}, 1
for d in dirs:
    vendor = d.rsplit("/", 1)[-1]
    content = git("show", f"{sha}:{d}/presets.toml")
    if content.returncode != 0:
        continue
    try:
        table = tomllib.loads(content.stdout.decode())
    except tomllib.TOMLDecodeError:
        continue
    if table.get("format") == 2:
        versions_format = 2
        vendors[vendor] = format2(vendor, table)
    else:
        vendors[vendor] = format1(table)
print(json.dumps({"commit": sha, "format": "presets.toml" if dirs else "none", "presets_format": versions_format,
                  "asan_link": asan_link, "vendors": vendors}, separators=(",", ":")))
PY
