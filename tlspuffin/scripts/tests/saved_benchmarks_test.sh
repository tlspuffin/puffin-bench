#!/bin/bash
# saved_benchmarks_test.sh <tlspuffin clone with the catalogue> [<commit>]: the launcher's saved custom benchmarks
# (data/html/board/launchers/tlspuffin/custombench.js) in a headless Chrome, against a store that answers as the
# scheduler's /api/benchmarks/tlspuffin (scheduler/src/scheduler/api/benchmarks_api.hxx; its own test:
# build/scheduler/testBenchmarksAPI) and the catalogue and presets of the commit (git_restapi's scripts):
#   - "Save now" keeps the ticked bugs under the benchmark's name; a launch saves it only with "save for later";
#   - "Load" ticks the same bugs again, on the commit shown or, chosen before a commit, once one is;
#   - a bug the catalogue shown does not have is left out, and said so;
#   - "Remove" takes it out of the store.
set -euo pipefail
here=$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )
bench=$( cd "${here}/../../.." && pwd )
clone="${1:?usage: saved_benchmarks_test.sh <tlspuffin clone> [<commit>]}"; commit="${2:-HEAD}"
chrome=$( command -v google-chrome || command -v chromium || command -v chromium-browser || true )
[ -n "${chrome}" ] || { echo "SKIP: no Chrome or Chromium"; exit 0; }
work=$( mktemp -d ); server=
trap '[ -n "${server}" ] && kill "${server}" 2> /dev/null; rm -rf "${work}"' EXIT
sha=$( git -C "${clone}" rev-parse "${commit}" )
mkdir -p "${work}/html/board/launchers/tlspuffin" "${work}/html/common" "${work}/git/api/git/presets/tlspuffin" "${work}/git/api/git/catalogue/tlspuffin"
"${bench}/git_restapi/scripts/tlspuffin_catalogue.sh" "${clone}" "${sha}" > "${work}/git/api/git/catalogue/tlspuffin/${sha}"
"${bench}/git_restapi/scripts/tlspuffin_presets.sh" "${clone}" "${sha}" > "${work}/git/api/git/presets/tlspuffin/${sha}"
echo '{ "commit": "0000000000000000000000000000000000000000", "format": "none" }' > "${work}/git/api/git/catalogue/tlspuffin/dev"
command cp -f "${bench}/tlspuffin/data/html/board/launchers/tlspuffin/custombench.js" "${work}/html/board/launchers/tlspuffin/"
command cp -f "${bench}/tlspuffin/data/html/common/catalogue.js" "${work}/html/common/"
cat > "${work}/test.html" <<EOF
<!doctype html><html><head><meta charset="utf-8"><title>running</title></head><body><pre id="out"></pre>
<script type="module">
const SHA = '${sha}';
EOF
cat >> "${work}/test.html" <<'EOF'
const out = document.getElementById('out');
let fail = 0;
const check = (ok, what) => { out.textContent += `${ok ? 'ok  ' : 'FAIL'} ${what}\n`; if (!ok) fail = 1; };
// the scheduler's store, and git_restapi: files of this page's server
const store = {};
const puts = [];
const realFetch = window.fetch.bind(window);
window.fetch = async (url, options = {}) => {
  const method = options.method ?? 'GET';
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  let m;
  if (url === '/api/benchmarks/tlspuffin' && method === 'GET') return json(200, { success: true, data: structuredClone(store) });
  if ((m = /^\/api\/benchmarks\/tlspuffin\/([A-Za-z0-9-]{1,24})$/.exec(url))) {
    if (method === 'PUT') {
      const definition = JSON.parse(options.body);
      if (definition.name !== m[1]) return json(400, { success: false, error: 'name' });
      puts.push(m[1]);
      store[m[1]] = { saved_at: Date.now(), definition };
      return json(200, { success: true });
    }
    if (method === 'DELETE') {
      if (!store[m[1]]) return json(404, { success: false, error: 'none' });
      delete store[m[1]];
      return json(200, { success: true });
    }
  }
  if (url.startsWith('http://git/')) return realFetch(url.replace('http://git/', '/git/'));
  return new Response('', { status: 404 });
};
window.confirm = () => true;
const settle = () => new Promise(resolve => setTimeout(resolve, 300));
const { CustomBenchmark } = await import('./html/board/launchers/tlspuffin/custombench.js');
const panel = new CustomBenchmark({ gitOrigin: 'http://git' });
document.body.appendChild(panel.node);
panel.show(true);
const $ = selector => panel.node.querySelector(selector);
try {
  await settle();
  check($('.jl-custom-saved').textContent.includes('none saved yet') && $('.jl-custom-open').disabled, 'none saved: Load and Remove disabled');
  panel.setCommit(SHA);
  await settle();
  const rows = [...panel.node.querySelectorAll('.jl-custom-bugs tr[data-id]')].filter(r => !r.querySelector('input').disabled);
  check(rows.length >= 2, `bugs to tick (${rows.length})`);
  const tick = row => { const box = row.querySelector('input'); box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true })); };
  tick(rows[0]); tick(rows[1]);
  const ticked = [rows[0].dataset.id, rows[1].dataset.id];
  $('.jl-custom-name').value = 'VulnT';
  $('.jl-custom-description').value = 'two bugs';
  check(await panel.saveIfKept() && puts.length === 0, 'a launch without "save for later" saves nothing');
  $('.jl-custom-savenow').click();
  await settle();
  check(store.VulnT && store.VulnT.definition.experiments.map(x => x.bug).sort().join() === [...ticked].sort().join(),
    `"Save now" keeps the ticked bugs under the name (${ticked.join(', ')})`);
  check($('.jl-custom-saved').value === 'VulnT' && $('.jl-custom-savedinfo').textContent.includes('2 bug(s)'), 'listed, with its bugs');
  check($('.jl-custom-savestatus').textContent === 'saved as VulnT', 'and said so');
  $('.jl-custom-keep').checked = true;
  check(await panel.saveIfKept() && puts.length === 2, 'a launch with "save for later" saves it (again)');

  // another benchmark, then VulnT loaded on the commit shown
  panel.reset();
  await settle();
  check(panel.definition().experiments.length === 0 && !$('.jl-custom-keep').checked, 'reset: nothing ticked, "save for later" off');
  $('.jl-custom-saved').value = 'VulnT';
  $('.jl-custom-open').click();
  await settle();
  check(panel.definition().experiments.map(x => x.bug).sort().join() === [...ticked].sort().join() && panel.name === 'VulnT',
    'Load ticks its bugs again, under its name');

  // loaded before a commit is chosen: ticked once one is
  panel.setCommit(null);
  panel.reset();
  await settle();
  $('.jl-custom-saved').value = 'VulnT';
  $('.jl-custom-open').click();
  check($('.jl-custom-savestatus').textContent.includes('once a commit is chosen'), 'before a commit: waits for one');
  panel.setCommit(SHA);
  await settle();
  check(panel.definition().experiments.length === 2, 'then ticks its bugs on the commit chosen');

  // a bug the catalogue shown does not have
  store.Gone = { saved_at: Date.now(), definition: { ...structuredClone(store.VulnT.definition), name: 'Gone',
    experiments: [...structuredClone(store.VulnT.definition.experiments), { bug: 'CVE-1999-0000', preset: 'none' }] } };
  panel.reset();
  await settle();
  $('.jl-custom-saved').value = 'Gone';
  $('.jl-custom-open').click();
  await settle();
  check(panel.definition().experiments.length === 2 && $('.jl-custom-savestatus').textContent.includes('CVE-1999-0000'),
    'a bug not in the catalogue is left out, and said so');

  $('.jl-custom-saved').value = 'VulnT';
  $('.jl-custom-remove').click();
  await settle();
  check(!store.VulnT && !$('.jl-custom-saved').textContent.includes('VulnT'), 'Remove takes it out of the store and the list');
} catch (err) {
  check(false, `error: ${err.stack ?? err}`);
}
document.title = fail ? 'FAILED' : 'PASSED';
</script></body></html>
EOF
# a free port, then the page's server
port=$( python3 -I -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])' )
python3 -I -m http.server "${port}" --bind 127.0.0.1 --directory "${work}" > /dev/null 2>&1 & server=$!
for _ in $( seq 1 50 ); do python3 -I -c "import socket; socket.create_connection(('127.0.0.1', ${port}), 1)" 2> /dev/null && break; sleep 0.1; done
dom=$( timeout 120 "${chrome}" --headless=new --disable-gpu --no-sandbox --user-data-dir="${work}/chrome" --virtual-time-budget=20000 \
  --dump-dom "http://127.0.0.1:${port}/test.html" 2> /dev/null )
python3 -I -c '
import html, re, sys
dom = sys.stdin.read()
m = re.search(r"<pre id=\"out\">(.*?)</pre>", dom, re.S)
print(html.unescape(m.group(1)) if m else dom[:2000], end="")
t = re.search(r"<title>(.*?)</title>", dom)
print(t.group(1) if t else "no result")
sys.exit(0 if t and t.group(1) == "PASSED" else 1)
' <<< "${dom}"
