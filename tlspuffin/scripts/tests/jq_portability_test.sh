#!/bin/bash
# jq_portability_test.sh: the jq programs of the bench (its shell scripts and .jq files) run under jq 1.6, pesto's
# (Debian 12), as under jq 1.7, cassis's. Two constructs of 1.7 do not:
#   - a variable named after a keyword (`.oracle as $or`: "syntax error, unexpected or, expecting IDENT"; 1.6 refuses
#     and or if then elif else end as def reduce foreach try catch label import include module __loc__ break): the two
#     programs of ValidationVerdict would not compile, and no objective still there on F would get a verdict;
#   - first(…), limit(…), nth(…), isempty(…) around a try or a `?`: 1.6 does not stop at the first value (the try
#     catches the internal break; nth even gives another value): the record of what a run built would come out as
#     several JSON texts, and the report as an empty file. Written […][0] instead.
# A check of the text (the suite under pesto's own jq, with its shim first in PATH, runs the programs themselves).
set -euo pipefail
here=$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )
bench=$( cd "${here}/../../.." && pwd )
python3 -I - "${bench}" <<'PY'
import os, re, sys
bench = sys.argv[1]
KEYWORDS = 'and|or|if|then|elif|else|end|as|def|reduce|foreach|try|catch|label|import|include|module|__loc__|break'
# every way jq defines a variable, to a keyword: … as $x (destructuring … as [$x] / {k: $x} too), def f($x):, and the
# command line's --arg x, --argjson x, --slurpfile x, --rawfile x; \$ in a shell string
binding = re.compile(r'\bas\s+(?:[\[{][^|;]*?)?\\?\$(' + KEYWORDS + r')\b|\bdef\s+\w+\([^)]*\\?\$(' + KEYWORDS + r')\b'
                     r'|--(?:arg|argjson|slurpfile|rawfile)\s+(' + KEYWORDS + r')\s')
stopper = re.compile(r'\b(first|limit|nth|isempty)\(')
files = []
for root in ('tlspuffin', 'scheduler', 'publisher', 'git_restapi', 'installer'):
    for d, dirs, names in os.walk(os.path.join(bench, root)):
        dirs[:] = [x for x in dirs if x not in ('third-party', 'node_modules', '.git', 'target')]
        files += [os.path.join(d, n) for n in names if n.endswith(('.sh', '.jq'))]
def argument(text, start):
    """the text between the parenthesis at start and its match"""
    depth = 0
    for i in range(start, len(text)):
        if text[i] == '(':
            depth += 1
        elif text[i] == ')':
            depth -= 1
            if depth == 0:
                return text[start + 1:i]
    return text[start + 1:]
bad = []
for f in sorted(files):
    text = open(f, errors='replace').read()
    # shell comments say what the code does, they are not jq
    code = '\n'.join('' if l.lstrip().startswith('#') else l for l in text.split('\n'))
    rel = os.path.relpath(f, bench)
    for m in binding.finditer(code):
        bad.append(f'{rel}:{code.count(chr(10), 0, m.start()) + 1}: a jq variable named after a keyword, ${m.group(1) or m.group(2) or m.group(3)} (jq 1.6 refuses it)')
    for m in stopper.finditer(code):
        arg = argument(code, m.end() - 1)
        if re.search(r'\btry\b|\?', arg):
            bad.append(f'{rel}:{code.count(chr(10), 0, m.start()) + 1}: {m.group(1)}(…) around a try or ? (jq 1.6 does not stop at its first value)')
for b in bad:
    print('FAIL', b)
print(f'{"ok  " if not bad else "FAIL"} the jq programs of {len(files)} files: {len(bad)} construct(s) jq 1.6 runs otherwise')
sys.exit(1 if bad else 0)
PY
