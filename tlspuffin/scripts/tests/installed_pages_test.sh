#!/bin/bash
# installed_pages_test.sh: every module the installed pages import is installed. The installers embed the files they
# list in the CMakeLists.txt of each component (EmbedDirectory's FILES, EmbedTextFileScript); a new module that a page
# imports but no list names is missing on the bench, and its page fails to load. Before: the deploy of 2026-11-15
# installed the launcher (joblauncher.js) without common/buildname.js, which it imports: the board of then awaited
# every project's launcher (launchers.js), and the board, its History and its task pages did not load; with the
# plugins (board/plugins.js), the board loads without tlspuffin's plugin.
#   - each relative import (static, or dynamic with a literal) of an installed JavaScript module names an installed file;
#   - each shared module of the pages (tlspuffin/data/html/common/*.js) is installed.
# The tests load the pages from the source tree, where every file is: only this test sees what the installers leave out.
set -euo pipefail
here=$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )
bench=$( cd "${here}/../../.." && pwd )
python3 -I - "${bench}" <<'EOF'
import os, re, sys
bench = sys.argv[1]
fail = 0
def check(ok, what):
    global fail
    print(f"{'ok  ' if ok else 'FAIL'} {what}")
    if not ok: fail = 1
# the installed pages: html/<path> named by a CMakeLists.txt, with its source (the component's folder, or its data/)
installed = {}
for component in ('scheduler', 'tlspuffin', 'publisher', 'vis_comparator', 'git_restapi'):
    cmake = os.path.join(bench, component, 'CMakeLists.txt')
    if not os.path.exists(cmake): continue
    text = open(cmake).read()
    for m in re.finditer(r'(?:^|[\s"/])(html/[\w./@+-]+\.(?:js|mjs|css|html|json))', text, re.M):
        rel = m.group(1)
        for base in (os.path.join(bench, component, 'data'), os.path.join(bench, component)):
            if os.path.exists(os.path.join(base, rel)):
                installed.setdefault(rel, os.path.join(base, rel))
                break
check(len(installed) > 50, f'{len(installed)} page files installed by the CMakeLists.txt')
# their relative imports
missing = []
pattern = re.compile(r"""(?:\bimport\s+(?:[\w*{}\s,]+\s+from\s+)?|\bimport\s*\(\s*|\bexport\s+[\w*{}\s,]+\s+from\s+)['"](\.{1,2}/[^'"]+)['"]""")
for rel, source in sorted(installed.items()):
    if not rel.endswith(('.js', '.mjs')): continue
    for imp in pattern.findall(open(source, errors='replace').read()):
        target = os.path.normpath(os.path.join(os.path.dirname(rel), imp))
        if target not in installed:
            missing.append(f'{rel} imports {imp} ({target}, not installed)')
check(not missing, 'every relative import of an installed module is installed' + (': ' + '; '.join(missing) if missing else ''))
# the shared modules of the pages
common = sorted(f'html/common/{f}' for f in os.listdir(os.path.join(bench, 'tlspuffin/data/html/common')) if f.endswith('.js'))
absent = [f for f in common if f not in installed]
check(not absent, f'each shared module ({len(common)}, html/common) is installed' + (': missing ' + ', '.join(absent) if absent else ''))
sys.exit(fail)
EOF
