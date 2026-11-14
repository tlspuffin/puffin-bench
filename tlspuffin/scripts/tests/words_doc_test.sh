#!/bin/bash
# words_doc_test.sh [<qjs>]: the user guide's "Words of the pages" (tlspuffin_user_guide.md, between <!-- words:begin -->
# and <!-- words:end -->) is what tools/words_markdown.js writes from common/verdicts.js, the words of every page: one
# vocabulary, documented as the pages say it. On a difference: the diff, and how to update the guide.
set -euo pipefail
here=$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )
qjs="${1:-/srv/puffin-bench/data/tools/qjs}"
[ -x "${qjs}" ] || { echo "SKIP: no qjs at ${qjs}"; exit 0; }
guide="${here}/../../../tlspuffin_user_guide.md"
work=$( mktemp -d ); trap 'rm -rf "${work}"' EXIT
"${qjs}" --std -m "${here}/../tools/words_markdown.js" > "${work}/want.md"
sed -n '/^<!-- words:begin -->$/,/^<!-- words:end -->$/p' "${guide}" | sed '1d;$d' > "${work}/got.md"
if [ -s "${work}/got.md" ] && diff -u "${work}/got.md" "${work}/want.md" > "${work}/diff"; then
  echo "ok   the guide's words are those of common/verdicts.js ($( grep -c '^| ' "${work}/want.md" ) rows)"
else
  echo "FAIL the guide's words differ from common/verdicts.js:"; cat "${work}/diff"
  echo "update: qjs --std -m tlspuffin/scripts/tools/words_markdown.js, between the markers of tlspuffin_user_guide.md"
  exit 1
fi
# every page that shows verdicts takes its words from the module (no second vocabulary)
fail=0
for f in "${here}/../tools/objectives_page/report.js" "${here}/../../data/html/publisher/summary_render.js" \
         "${here}/../../data/html/publisher/bugs.js" "${here}/../tools/report_verdicts.js" "${here}/../tools/objectives_page/bugs.js"; do
  if grep -q "common/verdicts.js'" "${f}"; then echo "ok   $( basename "$( dirname "${f}" )" )/$( basename "${f}" ) imports common/verdicts.js"
  else echo "FAIL $( basename "${f}" ) does not import common/verdicts.js"; fail=1; fi
done
grep -q 'html/common/verdicts.js' "${here}/../../CMakeLists.txt" && echo "ok   the installer installs common/verdicts.js" || { echo "FAIL the installer does not install common/verdicts.js"; fail=1; }
exit "${fail}"
