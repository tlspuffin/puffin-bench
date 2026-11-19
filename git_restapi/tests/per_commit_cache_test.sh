#!/bin/bash
# per_commit_cache_test.sh <git_restapi binary>: git_restapi's answers per commit (presets, catalogue: GitAPI::PerCommit)
# are cached for ever, by the script as it is. Before, a cache written by a former version of the script answered for
# ever: after a deploy that changed tlspuffin_presets.sh, the commits asked before kept answers without what it gives
# now (the latest releases, the kinds of builds, the modifiers, the names). On a repository made here, git_restapi on a
# port of its own, its script made to say when it runs:
#   - the script changed (a deploy installs it again), git_restapi restarted: the commit answered by the script;
#   - restarted with the same script: answered from the cache (the script not run);
#   - a cache of the former format (no "#script"): dropped, the commit answered by the script.
set -euo pipefail
binary="${1:?usage: per_commit_cache_test.sh <git_restapi binary>}"
[ -x "${binary}" ] || { echo "SKIP: no git_restapi at ${binary}"; exit 0; }
work=$( mktemp -d ); pid=''
trap '[ -n "${pid}" ] && kill "${pid}" 2> /dev/null; rm -rf "${work}"' EXIT
fail=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fail=1; fi; }
# a tlspuffin with presets
repo="${work}/tlspuffin"; mkdir -p "${repo}/puffin-build/vendors/lib"
printf 'format = 2\n[library]\nrepo = "x"\nbuilder = "lib"\nref = "{version}"\n[versions]\n"1.0.0" = {}\n' > "${repo}/puffin-build/vendors/lib/presets.toml"
git -C "${repo}" init -q && git -C "${repo}" add -A && git -C "${repo}" -c user.name=t -c user.email=t@t commit -q -m presets
sha=$( git -C "${repo}" rev-parse HEAD )
port=$( python3 -I -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])' )
storage="${work}/storage"; mkdir -p "${storage}"
cat > "${work}/config.json" <<EOF
{ "logs_level": 15, "server": { "secure": false, "port": ${port} },
  "git": { "scripts": "${storage}/.scripts", "storage": "${storage}",
           "repositories": { "tlspuffin": { "url": "file://${repo}", "url_pr": "http://127.0.0.1:1/pulls" } } } }
EOF
export RUNS="${work}/runs"; : > "${RUNS}"
start() {
  ( cd "${work}" && exec "${binary}" "${work}/config.json" ) >> "${work}/log" 2>&1 & pid=$!
  for _ in $( seq 1 100 ); do curl -s -o /dev/null "http://127.0.0.1:${port}/" && return 0; sleep 0.1; done
  echo "git_restapi did not start:"; tail -20 "${work}/log"; exit 1
}
stop() { kill "${pid}" 2> /dev/null; wait "${pid}" 2> /dev/null || true; pid=''; }
ask() { curl -s "http://127.0.0.1:${port}/api/git/presets/tlspuffin/${sha}"; }
runs() { wc -l < "${RUNS}"; }

start
check 'the presets of a commit (the script installed by git_restapi)' '[ "$( ask | jq -r .commit )" == "${sha}" ]'
stop
# a deploy: the script changes (here: it says when it runs)
script="${storage}/.scripts/tlspuffin_presets.sh"
sed -i '1a echo run >> "${RUNS}"' "${script}"
start
answer=$( ask )
check 'the script changed, git_restapi restarted: the commit answered by the script, not by the former cache' \
  '[ "$( jq -r .commit <<< "${answer}" )" == "${sha}" ] && [ "$( runs )" -eq 1 ]'
stop; start
check 'restarted with the same script: answered from the cache (the script not run)' \
  '[ "$( ask )" == "${answer}" ] && [ "$( runs )" -eq 1 ]'
stop
# a cache of the former format: commits only
printf '{"%s": {"commit": "%s", "former": true}}' "${sha}" "${sha}" > "${storage}/tlspuffin/presets_cache.json"
start
check 'a cache of the former format (no "#script"): dropped, the commit answered by the script' \
  '[ "$( ask | jq -r ".former // false" )" == false ] && [ "$( runs )" -eq 2 ]'
stop
exit "${fail}"
