#!/usr/bin/env python3
# Runs of a commit: every task the publisher keeps for a tlspuffin commit and a type (Perf, Vuln), each with the
# puffin-bench version it ran with and its metrics, for the page /html/runs/runs.html?commit=<sha>&type=<type>
# (runs_page/, copied next to the data) and the "🕘 N runs" chips of Results (/html/runs/index.json: commit ->
# {"<category>/<type>": number of tasks}; data in /html/runs/<commit>-<category>-<type>.json).
#
# Read-only on the publisher's storage (<storage>/<category>/<commit>/<type>/<task>.json and .zip); the metrics of a
# task never change: computed once, kept in <PB_ROOT>/data/runs-cache/<task>.json. Meant to run from cron on core 0 at
# idle priority (objectives_report.sh --all calls it):
#   python3 -I runs_report.py [--all | <commit> ...]
#   PB_ROOT  install root (default /srv/puffin-bench)
#
# puffin-bench version of a task: the job scripts' commit it recorded (runs since 2026-10-07, bench.jobscripts),
# else the md5 of its job script (task.md5["."]) matched to a commit of the checkout's history (cat of the files
# build.sh joins), else unknown; and the deployed version it recorded (bench.commit, runs since 2026-10-06).
import os, sys, json, re, zipfile, gzip, hashlib, subprocess, statistics, datetime, shutil, itertools

PB_ROOT = os.environ.get('PB_ROOT', '/srv/puffin-bench')
STORAGE = f'{PB_ROOT}/data/publisher/tlspuffin'
OUT = f'{PB_ROOT}/data/html/runs'
CACHE = f'{PB_ROOT}/data/runs-cache'
HERE = os.path.dirname(os.path.realpath(__file__))
CHECKOUT = os.path.realpath(f'{HERE}/../../..')
CACHE_VERSION = 9
# the expected bugs and the claims set apart (vuln_targets.json, the one file to edit; read by main)
TARGETS_FILE = f'{CHECKOUT}/tlspuffin/data/html/jobsscripts/tlspuffin/vuln_targets.json'
# claim -> {cve, library, below}: set apart only on that library below that version, everywhere without library
NOT_TARGETED = {}
TS = re.compile(r'^(\d{4}-\d{2}-\d{2}T[0-9:.]+[+-]\d{2}:\d{2})\t(\w+)\t(.*)$')
OBJ = re.compile(r'^artefacts/([^/]+)/(\d+)-objective/(\d{8}-\d{9})-[0-9a-f]+\.trace$')


def write_json(path, data):
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(data, f, separators=(',', ':'))
    os.replace(tmp, path)


def git(*args):
    return subprocess.run(['git', '-C', CHECKOUT, '-c', 'gc.auto=0', *args], capture_output=True, text=True).stdout


def jobscript_versions():
    """md5 of the job scripts build.sh produced at each commit -> {commit, date}; cached per HEAD of the checkout."""
    head = git('rev-parse', 'HEAD').strip()
    path = f'{CACHE}/jobscripts-{head[:12]}.json'
    if os.path.exists(path):
        return json.load(open(path))
    table = {}
    files = ['tlspuffin/scripts/PR_common.sh', 'tlspuffin/scripts/PR_compat.sh', 'tlspuffin/scripts/PR_perf.sh',
             'tlspuffin/scripts/PR_vulnerabilities.sh']
    for line in git('log', '--all', '--format=%H %cs', '--', *files).splitlines():
        sha, date = line.split()
        parts = {}
        for f in files:
            r = subprocess.run(['git', '-C', CHECKOUT, '-c', 'gc.auto=0', 'show', f'{sha}:{f}'], capture_output=True)
            parts[os.path.basename(f)] = r.stdout if r.returncode == 0 else None
        for combo in (('PR_common.sh', 'PR_compat.sh', 'PR_vulnerabilities.sh'), ('PR_common.sh', 'PR_compat.sh', 'PR_perf.sh'),
                      ('PR_common.sh', 'PR_vulnerabilities.sh'), ('PR_common.sh', 'PR_perf.sh')):
            if any(parts[c] is None for c in combo):
                continue
            md5 = hashlib.md5(b''.join(parts[c] for c in combo)).hexdigest()
            table.setdefault(md5, {'commit': sha[:7], 'date': date})
    for old in os.listdir(CACHE):
        if old.startswith('jobscripts-'):
            os.remove(f'{CACHE}/{old}')
    write_json(path, table)
    return table


def steps_of(task):
    s = task.get('steps') or []
    return list(s.values()) if isinstance(s, dict) else s


def snapshots(text):
    dec, i, n = json.JSONDecoder(), 0, len(text)
    while i < n:
        while i < n and text[i] in ' \r\n\t':
            i += 1
        if i >= n:
            return
        try:
            obj, i = dec.raw_decode(text, i)
        except ValueError:
            return
        yield obj


def mean(xs):
    return statistics.mean(xs) if xs else None


def perf_metrics(z, summary):
    """per library: values per client (as Results: coverage %, corpus, total execs, plus execs/s, successful executions %
    and coverage at 10 min from the stats; 3 clients x 5 runs = 15 values for a Perf task) and their means per run"""
    out = {}
    names = set(z.namelist())
    for lib, info in (summary.get('libraries') or {}).items():
        v = {'runs': 0, 'runs_total': len(info.get('data') or []), 'coverage': [], 'corpus': [], 'execs': [], 'execs_s': [],
             'success': [], 'coverage_10min': [], 'per_run': {}}
        for d in info.get('data') or []:
            if d.get('state') != 'success':
                continue
            v['runs'] += 1
            before = {k: len(v[k]) for k in ('coverage', 'corpus', 'execs', 'execs_s', 'success')}
            for c in d.get('clients') or []:
                e, b = c.get('tEnd') or {}, c.get('t0') or {}
                cov = e.get('coverage') or {}
                if not cov.get('max'):
                    continue
                v['coverage'].append(cov.get('hit', cov.get('discovered', 0)) / cov['max'] * 100)
                v['corpus'].append(e.get('corpus_size', 0))
                v['execs'].append(e.get('total_execs', 0))
                dt = (e.get('time') or {}).get('secs_since_epoch', 0) - (b.get('time') or {}).get('secs_since_epoch', 0)
                if dt > 0:
                    v['execs_s'].append(e.get('total_execs', 0) / dt)
                er = e.get('errors') or {}
                if er.get('all_exec'):
                    v['success'].append(er.get('all_exec_success', 0) / er['all_exec'] * 100)
            # the mean of the run's clients: the unit of the tests (the clients of a run are not independent)
            for k, n in before.items():
                if len(v[k]) > n:
                    v['per_run'].setdefault(k, []).append(statistics.mean(v[k][n:]))
            stats = f'artefacts/{lib}/{d.get("id")}-stats.json'
            if stats in names:
                last, t0 = {}, None
                for s in snapshots(z.read(stats).decode('utf-8', 'replace')):
                    if s.get('type') != 'client':
                        continue
                    cov = s.get('coverage') or {}
                    t = (s.get('time') or {}).get('secs_since_epoch')
                    if not cov.get('max') or t is None:
                        continue
                    t0 = t if t0 is None else t0
                    if t - t0 > 600:
                        break
                    last[s.get('id')] = cov.get('hit', 0) / cov['max'] * 100
                if last:
                    v['coverage_10min'].extend(last.values())  # each client's coverage at 10 min
                    v['per_run'].setdefault('coverage_10min', []).append(statistics.mean(last.values()))
        out[lib] = v
    return out


def global_execs_at(z, name, time_ms):
    """total execs of the run at that moment (ms since the epoch): interpolated between the two global snapshots of its
    stats around it (as utils.js GlobalExecsAt), None when the stats do not cover it"""
    if name not in z.namelist():
        return None
    prev = None
    for s in snapshots(z.read(name).decode('utf-8', 'replace')):
        if s.get('type') != 'global' or s.get('total_execs') is None or not s.get('time'):
            continue
        t = s['time']['secs_since_epoch'] * 1000 + s['time'].get('nanos_since_epoch', 0) // 1000000
        if t >= time_ms:
            if prev is None:
                return s['total_execs']  # before the first snapshot (a seed that finds it at once): an upper bound
            f = 1 if t == prev[0] else (time_ms - prev[0]) / (t - prev[0])
            return round(prev[1] + f * (s['total_execs'] - prev[1]))
        prev = (t, s['total_execs'])
    return None


def set_apart_claims(vendor):
    """the claims set apart (NOT_TARGETED) for what a run of that vendor preset builds ("wolfssl:wolfssl540-buf":
    wolfssl 540), as NotTargetedCVE in PR_common.sh"""
    m = re.search(r'([a-z]+)(\d{3,})', vendor.split(':')[-1])
    claims = set()
    for claim, e in NOT_TARGETED.items():
        if not e.get('library'):
            claims.add(claim)
        elif m and m.group(1) == e['library'] and int(m.group(2)) < int(str(e.get('below', '0')).replace('.', '')):
            claims.add(claim)
    return claims


def log_events(z, prefix, claims):
    """times (ms) of the claims set apart (claims) and of the crashes in the fuzzer's logs of a run"""
    warns, crashes = [], []
    for name in z.namelist():
        if not name.startswith(prefix) or not re.search(r'/(warn|error)(\.log|\..*\.gz)$', name):
            continue
        data = z.read(name)
        if name.endswith('.gz'):
            data = gzip.decompress(data)
        for line in data.decode('utf-8', 'replace').splitlines():
            m = TS.match(line)
            if not m:
                continue
            frac = re.search(r'\.(\d+)', m.group(1))
            t = datetime.datetime.fromisoformat(re.sub(r'\.\d+', '', m.group(1))).timestamp() + (float('0.' + frac.group(1)) if frac else 0)
            if m.group(2) == 'WARN' and m.group(3).strip() in claims:
                warns.append(t * 1000)
            elif m.group(2) == 'ERROR' and m.group(3).startswith('Crashed with'):
                crashes.append(t * 1000)
    # tlspuffin before ac3b89aff aborts right after logging a claim: that crash is the claim, not another bug (as
    # FuzzerVerdict in PR_common.sh, which also checks that the crash is in the harness)
    crashes = [c for c in crashes if not any(0 <= c - w <= 1000 for w in warns)]
    return warns, crashes


def name_time(name):
    """ms since the epoch of an objective, from its name: <UTC yyyymmdd-HHMMSSmmm>-<hash>"""
    try:
        return datetime.datetime.strptime(name[:15], '%Y%m%d-%H%M%S').replace(tzinfo=datetime.timezone.utc).timestamp() * 1000 + int(name[15:18])
    except (ValueError, TypeError):
        return None


def vuln_metrics(z, summary, report, targets, vendors):
    """per library and run: when the fuzzer saved its first objective and its first targeted one (s from the start of its
    stats), what that run's monitor measured (first targeted for job scripts that record it, else first objective)"""
    out = {}
    objs = {}
    for name in z.namelist():
        m = OBJ.match(name)
        if m:
            s = m.group(3)
            t = datetime.datetime.strptime(s[:15], '%Y%m%d-%H%M%S').replace(tzinfo=datetime.timezone.utc).timestamp() * 1000 + int(s[15:])
            objs.setdefault((m.group(1), int(m.group(2))), []).append((t, f'{s}-'))
    # the first objective of the expected bug of each run: the verdicts of the pages' code (bugs.js) written into the
    # objectives report (report_verdicts.js), so that the Runs page tells the same as Results and the report
    verdicts = (((report or {}).get('verdicts') or {}).get('libraries') or {})
    for lib, info in (summary.get('libraries') or {}).items():
        runs = []
        monitors = set()
        for d in info.get('data') or []:
            a = d.get('id'); g = (d.get('global') or [{}])[0]
            t0 = ((g.get('t0') or {}).get('time') or {}).get('secs_since_epoch')
            end = ((g.get('tEnd') or {}).get('time') or {}).get('secs_since_epoch')
            if a is None:
                continue
            if t0 is None:
                # no end-of-run summary (the run timed out, or its summary failed): a run all the same, not counted
                runs.append({'attempt': a, 'state': d.get('state'), 'duration': None, 'objectives': len(objs.get((lib, a), [])),
                             'execs_to_find': None, 'not_targeted': 0, 'first_objective': None, 'first_targeted': None,
                             'to_target': None, 'measured': None})
                continue
            times = sorted(objs.get((lib, a), []))
            warns, crashes = log_events(z, f'artefacts/{lib}/{a}-log/', set_apart_claims(vendors.get(lib, ''))) if times else ([], [])
            targeted = []
            for t, name in times:
                nt = any(abs(t - w) <= 500 for w in warns) and not any(-2000 <= t - c <= 2000 for c in crashes)
                if not nt:
                    targeted.append(t)
            first_expected = ((verdicts.get(lib) or {}).get('first_expected') or {}).get(str(a))
            to_target = [name_time(first_expected)] if first_expected and name_time(first_expected) is not None else []
            first_any = (times[0][0] / 1000 - t0) if times else None
            first_targeted = (targeted[0] / 1000 - t0) if targeted else None
            new_monitor = d.get('nb_objective_targeted') is not None
            if new_monitor:
                monitors.add('targeted')
            elif d.get('state') == 'success':
                monitors.add('first objective')
            measured = d.get('time_to_find_s') if d.get('time_to_find_s') is not None else (first_targeted if new_monitor else first_any)
            # in the statistics only the runs that 🎯 counts (found the expected bug and succeeded, report_verdicts.js), as
            # on Results and on the objectives report; a run of job scripts without target (before 2026-10-07: it ended
            # on any objective) is measured at its first objective of the expected bug
            counted = (verdicts.get(lib) or {}).get('counted')
            if counted is not None and a not in counted:
                measured = None
            elif counted is not None and not new_monitor and to_target:
                measured = to_target[0] / 1000 - t0
            # execs to find: the total execs when the objective that ended the run was saved (recorded by job scripts since
            # 2026-10-07, else from the run's stats over time), not when the run stopped
            etf = d.get('execs_to_find')
            if counted is not None and a not in counted:
                etf = None
            elif (etf is None or (counted is not None and not new_monitor)) and measured is not None and d.get('state') == 'success':
                etf = global_execs_at(z, f'artefacts/{lib}/{a}-stats.json', (t0 + measured) * 1000)
            runs.append({'attempt': a, 'state': d.get('state'), 'duration': (end - t0) if end else None, 'objectives': len(times),
                         'execs_to_find': etf if d.get('state') == 'success' else None,
                         'not_targeted': len(times) - len(targeted), 'first_objective': first_any, 'first_targeted': first_targeted,
                         'to_target': (min(to_target) / 1000 - t0) if to_target else None,
                         'measured': measured if d.get('state') == 'success' else None})
        out[lib] = {'runs': runs, 'target': targets.get(vendors.get(lib, '')), 'monitor': sorted(monitors)}
    return out


def task_record(path_json, ctype, md5table, targets):
    tid = os.path.basename(path_json)[:-5]
    cache = f'{CACHE}/{tid}.json'
    zpath = path_json[:-5] + '.zip'
    stamp = [CACHE_VERSION, os.path.getmtime(path_json), os.path.getmtime(zpath) if os.path.exists(zpath) else 0]
    report = f'{PB_ROOT}/data/html/objectives/{tid}.json'
    if ctype == 'Vuln':
        stamp.append(os.path.getmtime(report) if os.path.exists(report) else 0)
        # an edit of the expected bugs or of the claims set apart counts again
        stamp.append(os.path.getmtime(TARGETS_FILE) if os.path.exists(TARGETS_FILE) else 0)
    if os.path.exists(cache):
        rec = json.load(open(cache))
        if rec.get('stamp') == stamp:
            return rec
    task = json.load(open(path_json)).get('task') or {}
    steps = steps_of(task)
    times = [t for s in steps for t in (s.get('time_points_ms') or []) if t]
    args = {a.get('key'): a.get('value') for a in (task.get('args') or []) if isinstance(a, dict)}
    exp = [s for s in steps if s.get('name') in ('ExperimentWithCargo', 'Experiment')]
    vendors = {s.get('id'): (s.get('args') or {}).get('vendor', '') for s in exp}
    rec = {'stamp': stamp, 'id': tid, 'name': task.get('name', ''), 'user': task.get('user', ''), 'job_type': task.get('job_type', ''),
           'start': min(times) / 1000 if times else None, 'end': max(times) / 1000 if times else None,
           'settings': {'timeout': sorted({s.get('timeout') for s in exp if s.get('timeout')}),
                        'cores': sorted({s.get('nb_cores') for s in exp if s.get('nb_cores')}),
                        'compat': args.get('COMPAT_APPLIED', ''), 'libafl': args.get('LIBAFL_VERSION', '')},
           'jobscript_md5': (task.get('md5') or {}).get('.', ''), 'bench': None, 'jobscripts': None, 'metrics': None}
    m = md5table.get(rec['jobscript_md5'])
    if m:
        rec['jobscripts'] = {'commit': m['commit'], 'date': m['date'], 'from': 'md5'}
    if os.path.exists(zpath):
        z = zipfile.ZipFile(zpath)
        if 'artefacts/summary.json' in z.namelist():
            summary = json.loads(z.read('artefacts/summary.json'))
            bench = next((l.get('bench') for l in (summary.get('libraries') or {}).values() if l.get('bench')), None)
            # what each library built (for the comparability of two tasks) and the machine load of the runs (since 2026-10-07)
            rec['builds'] = {}
            rec['load'] = {}
            for lib, info in (summary.get('libraries') or {}).items():
                cli = info.get('cli') or {}; lb = cli.get('library') or {}
                rec['builds'][lib] = {'library': lb.get('name'), 'version': lb.get('version'), 'harness': 'C' if cli.get('cputs') else 'Rust',
                                      # None: not recorded (older runs), not "without ASan"
                                      'asan': (cli.get('asan') or {}).get('instrumented')}
                # per core of the machine: only from runs that recorded its cores (cores_of, since 2026-10-09; the
                # earlier ones have the cores of the step, which gives a load several times too high)
                loads = [(d.get('load') or {}) for d in info.get('data') or [] if (d.get('load') or {}).get('cores_of') == 'machine']
                if loads:
                    rec['load'][lib] = round(statistics.mean(l['mean'] / max(1, l.get('cores') or 1) for l in loads), 3)
            if bench:
                rec['bench'] = {k: bench.get(k) for k in ('commit', 'branch', 'date', 'deployed')}
                if bench.get('jobscripts'):
                    rec['jobscripts'] = {**bench['jobscripts'], 'from': 'recorded'}
            if ctype == 'Perf':
                rec['metrics'] = perf_metrics(z, summary)
            elif ctype == 'Vuln':
                rep = json.load(open(report)) if os.path.exists(report) else None
                rec['metrics'] = vuln_metrics(z, summary, rep, targets, vendors)
    write_json(cache, rec)
    return rec


def mann_whitney(a, b):
    """two-sided Mann-Whitney U: exact without ties for small samples (the distribution of U), else the normal approximation
    with the correction for ties (as runs.js; the same p-values as scipy)"""
    n1, n2 = len(a), len(b)
    if n1 < 2 or n2 < 2:
        return None
    allv = sorted([(v, 0) for v in a] + [(v, 1) for v in b])
    ranks, ties, i = [0.0] * len(allv), 0, 0
    while i < len(allv):
        j = i
        while j + 1 < len(allv) and allv[j + 1][0] == allv[i][0]:
            j += 1
        for k in range(i, j + 1):
            ranks[k] = (i + j) / 2 + 1
        t = j - i + 1; ties += t ** 3 - t; i = j + 1
    r1 = sum(r for r, (_, g) in zip(ranks, allv) if g == 0)
    u = r1 - n1 * (n1 + 1) / 2; umin = min(u, n1 * n2 - u)
    if ties == 0 and n1 * n2 <= 2500:
        f = [[1] for _ in range(n2 + 1)]
        for i in range(1, n1 + 1):
            g = [[1]]
            for j in range(1, n2 + 1):
                left, up = g[j - 1], f[j]
                g.append([(left[k] if k < len(left) else 0) + (up[k - j] if k >= j and k - j < len(up) else 0) for k in range(i * j + 1)])
            f = g
        counts = f[n2]; total = sum(counts)
        return min(1.0, 2 * sum(counts[:int(umin) + 1]) / total)
    import math
    N = n1 + n2; mu = n1 * n2 / 2
    sigma = math.sqrt(n1 * n2 / 12 * ((N + 1) - ties / (N * (N - 1))))
    if sigma == 0:
        return 1.0
    z = (abs(u - mu) - 0.5) / sigma
    return min(1.0, math.erfc(z / math.sqrt(2)))


def ancestors_with_data(commits):
    """for each commit, its nearest ancestor among the given ones (git ancestry in the bench's clone of tlspuffin,
    read-only): {commit: (ancestor, number of commits between, git rev-list --count ancestor..commit)}; cached per
    pair"""
    repo = f'{PB_ROOT}/data/repo/tlspuffin/repo'
    path = f'{CACHE}/ancestry.json'
    cache = json.load(open(path)) if os.path.exists(path) else {}
    def run(*a):
        return subprocess.run(['git', '-C', repo, '-c', 'gc.auto=0', *a], capture_output=True, text=True)
    out = {}
    for c in commits:
        best = None
        for b in commits:
            if b == c:
                continue
            key = f'{b}..{c}'
            if key not in cache:
                anc = run('merge-base', '--is-ancestor', b, c).returncode == 0
                cache[key] = int(run('rev-list', '--count', key).stdout.strip() or 0) if anc else None
            gap = cache[key]
            if gap and (best is None or gap < best[1]):
                best = (b, gap)
        if best:
            out[c] = best
    write_json(path, cache)
    return out


def task_values(task, ctype):
    """per library: the per-run values of the metrics compared on Results"""
    out = {}
    for lib, m in (task.get('metrics') or {}).items():
        if ctype == 'Perf':
            pr = m.get('per_run') or {}
            out[lib] = {'coverage': pr.get('coverage', []), 'corpus': pr.get('corpus', []), 'execs': pr.get('execs', []),
                        '_runs': (m.get('runs'), m.get('runs_total'))}
        else:
            runs = m.get('runs') or []
            out[lib] = {'execs_to_find': [r['execs_to_find'] for r in runs if r.get('execs_to_find') is not None],
                        'time_to_find': [r['measured'] for r in runs if r.get('measured') is not None],
                        '_runs': (sum(1 for r in runs if r.get('measured') is not None), len(runs)), '_monitor': m.get('monitor')}
    return out


def load_warning():
    """the difference of machine load per core above which two tasks are not comparable: load_warning of the deployed
    publisher/regression_floors.json (edited on the machine), else 0.25"""
    try:
        return float(json.load(open(f'{PB_ROOT}/data/html/publisher/regression_floors.json')).get('load_warning', 0.25))
    except (OSError, ValueError, TypeError, AttributeError):
        return 0.25


def regression(groups):
    """each commit's latest task against the latest task of its nearest ancestor with results (same category and type):
    per library and metric the change of the mean and the Mann-Whitney p on the runs, and what differs between the two
    (build, monitor, job scripts, compat rules, timeout, cores, machine load). Results applies the floors
    (publisher/regression_floors.json) when it shows them."""
    out = {}
    max_load_diff = load_warning()
    for (category, ctype), commits in groups.items():
        latest = {c: next((t for t in reversed(ts) if t.get('metrics')), None) for c, ts in commits.items()}
        latest = {c: t for c, t in latest.items() if t}
        for c, (base, gap) in ancestors_with_data(sorted(latest)).items():
            a, b = latest[base], latest[c]
            va, vb = task_values(a, ctype), task_values(b, ctype)
            notes = []
            label = lambda t: ((t.get('jobscripts') or {}).get('commit') or '')[:7] or 'unknown script ' + (t.get('jobscript_md5') or '?')[:8]
            ka, kb = label(a), label(b)
            if ka != kb:
                notes.append(f'job scripts {ka} → {kb}')
            sa, sb = a.get('settings') or {}, b.get('settings') or {}
            if (sa.get('compat') or '') != (sb.get('compat') or ''):
                plus = sorted(set(filter(None, (sb.get('compat') or '').split(','))) - set(filter(None, (sa.get('compat') or '').split(','))))
                minus = sorted(set(filter(None, (sa.get('compat') or '').split(','))) - set(filter(None, (sb.get('compat') or '').split(','))))
                notes.append('compat rules' + (f' +{",".join(plus)}' if plus else '') + (f' −{",".join(minus)}' if minus else ''))
            for k, label in (('timeout', 'timeout'), ('cores', 'cores'), ('libafl', 'LibAFL')):
                if sa.get(k) != sb.get(k):
                    notes.append(f'{label} {sa.get(k)} → {sb.get(k)}')
            libs = {}
            for lib in sorted(set(va) & set(vb)):
                warn = []
                ba, bb = (a.get('builds') or {}).get(lib), (b.get('builds') or {}).get(lib)
                # only what both runs recorded: an older record without library, version or ASan is not "another build"
                known = lambda k: ba.get(k) is not None and bb.get(k) is not None
                if ba and bb and any(known(k) and ba[k] != bb[k] for k in ('library', 'version', 'harness', 'asan')):
                    warn.append('build ' + ' '.join(f'{x}' for x in (ba['library'], ba['version'], ba['harness'], 'ASan' if ba['asan'] else '') if x)
                                + ' → ' + ' '.join(f'{x}' for x in (bb['library'], bb['version'], bb['harness'], 'ASan' if bb['asan'] else '') if x))
                if ctype == 'Vuln' and va[lib].get('_monitor') != vb[lib].get('_monitor'):
                    warn.append(f'monitor: run ends on {"/".join(va[lib].get("_monitor") or ["?"])} → {"/".join(vb[lib].get("_monitor") or ["?"])}')
                la, lb_ = (a.get('load') or {}).get(lib), (b.get('load') or {}).get(lib)
                if la is not None and lb_ is not None and abs(lb_ - la) > max_load_diff:
                    warn.append(f'machine load per core {la:.2f} → {lb_:.2f}')
                metrics = {}
                for key, x in va[lib].items():
                    if key.startswith('_'):
                        continue
                    y = vb[lib].get(key) or []
                    if len(x) < 2 or len(y) < 2 or statistics.mean(x) == 0:
                        continue
                    metrics[key] = {'value': statistics.mean(y), 'base': statistics.mean(x), 'delta': (statistics.mean(y) / statistics.mean(x) - 1) * 100,
                                    'p': mann_whitney(x, y), 'n': len(y), 'n_base': len(x)}
                libs[lib] = {'warn': warn, 'metrics': metrics, 'runs': vb[lib]['_runs'], 'runs_base': va[lib]['_runs']}
            out.setdefault(c, {})[f'{category}/{ctype}'] = {'base': base, 'gap': gap, 'task': b['id'], 'base_task': a['id'], 'notes': notes, 'libs': libs}
    return out


def measured_floors(groups):
    """the floors of this machine: 95th percentile of the change between two tasks of the same commit (same build and
    settings), per metric and per library (with at least 8 pairs), for regression_floors.json (never applied by itself)"""
    diffs = {}
    for (category, ctype), commits in groups.items():
        for c, ts in commits.items():
            for a, b in itertools.combinations([t for t in ts if t.get('metrics')], 2):
                if (a.get('settings') or {}).get('timeout') != (b.get('settings') or {}).get('timeout'):
                    continue
                va, vb = task_values(a, ctype), task_values(b, ctype)
                for lib in set(va) & set(vb):
                    if (a.get('builds') or {}).get(lib) != (b.get('builds') or {}).get(lib):
                        continue
                    # Vuln: the same monitor (since bf0392b a run ends on its targeted bug, before on any objective)
                    if ctype == 'Vuln' and va[lib].get('_monitor') != vb[lib].get('_monitor'):
                        continue
                    for key, x in va[lib].items():
                        if key.startswith('_'):
                            continue
                        y = vb[lib].get(key) or []
                        if len(x) >= 3 and len(y) >= 3 and statistics.mean(x) > 0:
                            d = abs(statistics.mean(y) / statistics.mean(x) - 1) * 100
                            diffs.setdefault((ctype, key, None), []).append(d); diffs.setdefault((ctype, key, lib), []).append(d)
    out = {'measured': datetime.datetime.now().isoformat(timespec='seconds'), 'floors': {}, 'per_library': {}, 'pairs': {}}
    for (ctype, key, lib), v in sorted(diffs.items(), key=lambda kv: (kv[0][0], kv[0][1], kv[0][2] or '')):
        if len(v) < 8:
            continue
        v = sorted(v); q = round(v[int(0.95 * (len(v) - 1))], 2)
        if lib is None:
            out['floors'].setdefault(ctype, {})[key] = q; out['pairs'][f'{ctype}/{key}'] = len(v)
        else:
            out['per_library'].setdefault(ctype, {}).setdefault(lib, {})[key] = q
    return out


def main():
    os.makedirs(OUT, exist_ok=True); os.makedirs(CACHE, exist_ok=True)
    for asset in ('runs.html', 'runs.js', 'runs.css'):
        src = f'{HERE}/runs_page/{asset}'
        if os.path.exists(src) and (not os.path.exists(f'{OUT}/{asset}') or open(src, 'rb').read() != open(f'{OUT}/{asset}', 'rb').read()):
            shutil.copyfile(src, f'{OUT}/{asset}.tmp'); os.replace(f'{OUT}/{asset}.tmp', f'{OUT}/{asset}')
    md5table = jobscript_versions()
    table = json.load(open(TARGETS_FILE)) if os.path.exists(TARGETS_FILE) else {}
    targets = {k: v for k, v in table.items() if not k.startswith('_')}
    NOT_TARGETED.update(table.get('_not_targeted') or {})
    wanted = set(a for a in sys.argv[1:] if a != '--all')
    index = {}
    groups = {}  # (category, type) -> {commit: tasks}, for the regression view
    for category in sorted(os.listdir(STORAGE)) if os.path.isdir(STORAGE) else []:
        cdir = f'{STORAGE}/{category}'
        if not os.path.isdir(cdir):
            continue
        for commit in sorted(os.listdir(cdir)):
            if not re.fullmatch(r'[0-9a-f]{40}', commit) or (wanted and commit not in wanted and commit[:7] not in {w[:7] for w in wanted}):
                continue
            for ctype in sorted(os.listdir(f'{cdir}/{commit}')):
                tdir = f'{cdir}/{commit}/{ctype}'
                files = sorted(f for f in os.listdir(tdir) if re.fullmatch(r'\d+\.json', f)) if os.path.isdir(tdir) else []
                if not files:
                    continue
                tasks = [task_record(f'{tdir}/{f}', ctype, md5table, targets) for f in files]
                tasks.sort(key=lambda t: t.get('start') or 0)
                for t in tasks:
                    t.pop('stamp', None)
                groups.setdefault((category, ctype), {})[commit] = tasks
                # one file per category (PR, AB: the publisher's storage) and type
                write_json(f'{OUT}/{commit}-{category}-{ctype}.json', {'commit': commit, 'type': ctype, 'category': category,
                                                             'updated': datetime.datetime.now().isoformat(timespec='seconds'), 'tasks': tasks})
                index.setdefault(commit, {})[f'{category}/{ctype}'] = len(tasks)
                print(f'{commit[:7]} {category}/{ctype}: {len(tasks)} run(s)')
    if not wanted:
        write_json(f'{OUT}/index.json', index)
        # Results: each commit against its nearest ancestor; the floors measured on this machine (suggestions)
        import socket
        write_json(f'{OUT}/regression.json', {'machine': socket.gethostname().split('.')[0],
                                               'commits': regression({k: v for k, v in groups.items() if k[0] == 'PR'})})
        write_json(f'{OUT}/regression_floors.measured.json', measured_floors(groups))
    else:
        old = json.load(open(f'{OUT}/index.json')) if os.path.exists(f'{OUT}/index.json') else {}
        old.update(index); write_json(f'{OUT}/index.json', old)


if __name__ == '__main__':
    main()
