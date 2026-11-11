#! /bin/bash
# tlspuffin_catalogue.sh <repository> <commit|dev|main>: the vulnerability catalogue of tlspuffin at a commit, as JSON on
# stdout:
#   {"commit": "<sha>", "date": "<committer date>", "subject": "<its subject>", "format": "vulnerabilities.toml" | "none",
#    "vendors": {"wolfssl": {"fingerprint": "<sha256>", "repository": "<the library's repository>",
#      "preamble": "<the comments heading the file>", "entries": {"CVE-2022-39173": {<the entry's fields>,
#      "fingerprint": "<sha256>", "patch_hashes": {"patches/fix-CVE-2022-39173.patch": "<sha256>"},
#      "toml": "<the entry's text in the file, with its comments>"}, …}}, …}}
# Read from puffin-build/vendors/<vendor>/vulnerabilities.toml and its patch files (tlspuffin pr/vuln-catalogue); before,
# "format": "none". The fingerprint of an entry hashes its fields and its patch files: the bench compares entries of two
# commits with it (the same entry at dev and at a PR's commit); toml (the source text, for people) is not part of it.
# repository: the sources.repo of the vendor's presets.toml (for links to upstream commits). Exit status 2: the commit is
# not in the repository.
repo="$1"; commit="$2"
# `dev` and `main`: the heads of the branches as last fetched (the clone's remote-tracking branches)
case "${commit}" in dev|main) commit="origin/${commit}";; esac
sha=$(git -C "${repo}" rev-parse --verify --quiet "${commit}^{commit}") || exit 2
exec python3 -I - "${repo}" "${sha}" <<'EOF'
import hashlib, json, re, subprocess, sys, tomllib

repo, sha = sys.argv[1], sys.argv[2]

def git(*args):
    return subprocess.run(["git", "-C", repo, *args], capture_output=True)

# a table header and the entry it belongs to: [ID], [ID.find], [[ID.patches]], ["ID"]
HEADER = re.compile(r'^\s*\[\[?\s*(?:"([^"]+)"|([A-Za-z0-9_-]+))')

def sections(text):
    """The text of each entry (its tables, and the comment lines right above its first header) and the comments
    heading the file."""
    chunks, current, preamble = {}, None, []
    for line in text.splitlines():
        match = HEADER.match(line)
        if match and (match.group(1) or match.group(2)) != current:
            previous = preamble if current is None else chunks[current]
            carried = []
            while previous and previous[-1].lstrip().startswith("#"):
                carried.insert(0, previous.pop())
            current = match.group(1) or match.group(2)
            chunks.setdefault(current, []).extend(carried)
        (preamble if current is None else chunks[current]).append(line)
    return {k: "\n".join(v).strip("\n") for k, v in chunks.items()}, "\n".join(preamble).strip("\n")

def repository(d):
    presets = git("show", f"{sha}:{d}/presets.toml")
    if presets.returncode != 0:
        return None
    try:
        for preset in tomllib.loads(presets.stdout.decode()).values():
            repo_url = isinstance(preset, dict) and preset.get("sources", {}).get("repo")
            if repo_url:
                return repo_url.removesuffix(".git")
    except tomllib.TOMLDecodeError:
        pass
    return None

dirs = git("ls-tree", "--name-only", sha, "--", "puffin-build/vendors/").stdout.decode().split()
vendors, fmt = {}, "none"
for d in dirs:
    toml = git("show", f"{sha}:{d}/vulnerabilities.toml")
    if toml.returncode != 0:
        continue
    fmt = "vulnerabilities.toml"
    catalogue = tomllib.loads(toml.stdout.decode())
    texts, preamble = sections(toml.stdout.decode())
    vendor_hash = hashlib.sha256(toml.stdout)
    entries = {}
    for entry_id in sorted(catalogue):
        entry = dict(catalogue[entry_id])
        patch_hashes = {}
        for patch in entry.get("patches", []):
            for f in patch.get("files", []):
                blob = git("show", f"{sha}:{d}/{f}")
                patch_hashes[f] = hashlib.sha256(blob.stdout).hexdigest() if blob.returncode == 0 else "missing"
        canonical = json.dumps(entry, sort_keys=True) + "\n" + json.dumps(patch_hashes, sort_keys=True)
        entry["fingerprint"] = hashlib.sha256(canonical.encode()).hexdigest()
        entry["patch_hashes"] = patch_hashes
        if entry_id in texts:
            entry["toml"] = texts[entry_id]
        entries[entry_id] = entry
        vendor_hash.update(entry["fingerprint"].encode())
    vendors[d.rsplit("/", 1)[-1]] = {"fingerprint": vendor_hash.hexdigest(), "repository": repository(d),
                                     "preamble": preamble, "entries": entries}

date, _, subject = git("log", "-1", "--format=%cI%x1f%s", sha).stdout.decode().strip().partition("\x1f")
json.dump({"commit": sha, "date": date, "subject": subject, "format": fmt, "vendors": vendors}, sys.stdout,
          separators=(",", ":"))
print()
EOF
