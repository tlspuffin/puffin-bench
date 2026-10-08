#! /bin/bash
# tlspuffin_presets.sh <repository> <commit>: the vendor presets of tlspuffin at a commit, as JSON on stdout:
#   {"commit": "<sha>", "format": "presets.toml" | "none", "asan_link": true | false,
#    "vendors": {"wolfssl": [{"name": "wolfssl540-sdos2",
#     "version": "5.4.0", "asan": false, "sancov": true, "fix": ["CVE-2022-39173"], "postauth": false}, …], …}}
# Read from puffin-build/vendors/<vendor>/presets.toml (tlspuffin since 2024-09-12); before, "format": "none".
# asan_link: the commit contains tlspuffin 854dbaa11 ("build: dynamically register the PUT instrumentation"), from
# which an ASAN preset links the ASAN runtime by itself; before, only with the asan cargo feature.
# Exit status 2: the commit is not in the repository.
repo="$1"; commit="$2"
sha=$(git -C "${repo}" rev-parse --verify --quiet "${commit}^{commit}") || exit 2
files=$(git -C "${repo}" ls-tree --name-only "${sha}" -- puffin-build/vendors/ 2>/dev/null)
asan_link=false
asan_commit=$(git -C "${repo}" rev-parse --verify --quiet "854dbaa113192ecf6d2899714219ee40387757db^{commit}") &&
  git -C "${repo}" merge-base --is-ancestor "${asan_commit}" "${sha}" && asan_link=true
printf '{"commit":"%s","format":"%s","asan_link":%s,"vendors":{' "${sha}" \
  "$( [ -n "${files}" ] && echo presets.toml || echo none )" "${asan_link}"
first=1
for dir in ${files}; do
  vendor=$(basename "${dir}")
  content=$(git -C "${repo}" show "${sha}:${dir}/presets.toml" 2>/dev/null) || continue
  [ ${first} = 1 ] || printf ','
  first=0
  printf '"%s":' "${vendor}"
  printf '%s\n' "${content}" | awk '
    function esc(s) { gsub(/\\/, "\\\\", s); gsub(/"/, "\\\"", s); return s }
    function flush() {
      if (name == "") return
      printf "%s{\"name\":\"%s\",\"version\":\"%s\",\"asan\":%s,\"sancov\":%s,\"postauth\":%s,\"fix\":[%s]}",
             (count++ ? "," : ""), esc(name), esc(version), asan, sancov, postauth, fix
    }
    BEGIN { printf "["; count = 0; name = "" }
    /^[ \t]*\[[^]]+\][ \t]*$/ {
      flush()
      name = $0; gsub(/^[ \t]*\[|\][ \t]*$/, "", name)
      version = ""; asan = "false"; sancov = "false"; postauth = "true"; fix = ""
      next
    }
    name != "" && /^[ \t]*sources[ \t]*=/ { if (match($0, /version[ \t]*=[ \t]*"[^"]*"/)) { v = substr($0, RSTART, RLENGTH); sub(/^[^"]*"/, "", v); sub(/"$/, "", v); version = v } }
    name != "" && /^[ \t]*asan[ \t]*=/ { asan = ($0 ~ /true/) ? "true" : "false" }
    name != "" && /^[ \t]*sancov[ \t]*=/ { sancov = ($0 ~ /true/) ? "true" : "false" }
    name != "" && /^[ \t]*postauth[ \t]*=/ { postauth = ($0 ~ /true/) ? "true" : "false" }
    name != "" && /^[ \t]*fix[ \t]*=/ {
      list = $0; sub(/^[^[]*\[/, "", list); sub(/\].*$/, "", list)
      n = split(list, items, ","); fix = ""
      for (i = 1; i <= n; i++) { item = items[i]; gsub(/^[ \t]*"|"[ \t]*$/, "", item); if (item != "") fix = fix (fix == "" ? "" : ",") "\"" esc(item) "\"" }
    }
    END { flush(); printf "]" }'
done
printf '}}\n'
