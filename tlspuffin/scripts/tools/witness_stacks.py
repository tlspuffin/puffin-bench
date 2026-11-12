#!/usr/bin/env python3
"""witness_stacks.py <tlspuffin checkout with the catalogue> [<data folder> (default /srv/puffin-bench/data)]

The stack of the witness of each known bug that crashes (its first 3 frames are its place, rule R3 of
html/common/signatures.js, whatever the catalogue's top frames), computed once for the reports validated before
validation recorded it itself (its controls give
witness_frames since the symbolized executions): the witness runs on the validation build of a preset the bench used
for that bug (an experiment's vendor) without its patch (<preset>-only-<ID>), else with every patch (<preset>-fix-all), with the validation builds of the
bench's cache (data/cache/validation-*) and ASan's symbolizer of the checkout's nix-shell. Written to
<data>/catalogue-cache/witness_frames.json ({ID: {frames, put, binary, at}}), which report_verdicts.js adds to the entries
of every report (objectives_report.sh Verdicts, PB_WITNESS_FRAMES). A bug already there is kept; run it at deploy time,
on core 0 at idle priority (taskset -c 0 nice -n 19)."""
import datetime, glob, json, os, re, subprocess, sys, tempfile

checkout = os.path.abspath(sys.argv[1])
data = sys.argv[2] if len(sys.argv) > 2 else '/srv/puffin-bench/data'
out_file = f'{data}/catalogue-cache/witness_frames.json'
known = json.load(open(out_file)) if os.path.exists(out_file) else {}

# the catalogues the bench has (git_restapi's answers, cached per commit): the crash bugs without top frames, with a witness
entries = {}
for f in glob.glob(f'{data}/catalogue-cache/*.json'):
    if f.endswith('witness_frames.json'):
        continue
    try:
        cat = json.load(open(f))
    except Exception:
        continue
    if cat.get('format') != 'vulnerabilities.toml':
        continue
    for vendor, v in (cat.get('vendors') or {}).items():
        for id_, e in (v.get('entries') or {}).items():
            if (e.get('oracle') or {}).get('kind') == 'crash' and not e.get('no_witness'):
                entries[id_] = vendor
# the stacks validations recorded (objectives/witness_frames.json, published by objectives_report.sh --all): not again
try:
    recorded = {k: v for k, v in json.load(open(f'{data}/html/objectives/witness_frames.json')).items()
                if 'the validation of task' in str(v.get('from', ''))}
except Exception:
    recorded = {}

# the presets the bench ran each of them on (the experiments' vendors), base names: <preset>[-only-<ID>]
presets = {}
for f in glob.glob(f'{data}/html/objectives/[0-9]*.json'):
    try:
        report = json.load(open(f))
    except Exception:
        continue
    targets = report.get('targets') or {}
    for run in report.get('runs') or []:
        vendor = str((run.get('cli') or {}).get('vendor') or '')
        target = ((run.get('cli') or {}).get('custom') or {}).get('target') or (targets.get(run.get('library')) or {}).get('cve')
        if target in entries and ':' in vendor:
            base = re.sub(r'-only-.*$', '', vendor.split(':', 1)[1])
            presets.setdefault(target, set()).add(base)

symbolizer = subprocess.run(['nix-shell', '--run', 'command -v llvm-symbolizer'], cwd=checkout, capture_output=True,
                            text=True).stdout.strip().splitlines()[-1:] or ['']
env = dict(os.environ, PUFFIN_BUILD_DIR=f'{checkout}/puffin-build', ASAN_SYMBOLIZER_PATH=symbolizer[0],
           ASAN_OPTIONS='verify_asan_link_order=1:detect_leaks=0:abort_on_error=1')
binaries = sorted(glob.glob(f'{data}/cache/validation-*'), key=os.path.getmtime, reverse=True)
for id_ in sorted(entries):
    if id_ in known:
        print(f'{id_}: kept ({" < ".join(known[id_]["frames"][:3])})')
        continue
    if id_ in recorded:
        print(f'{id_}: recorded by {recorded[id_]["from"]} ({" < ".join(recorded[id_]["frames"][:3])})')
        continue
    found = None
    # the build without its patch (<preset>-only-<ID>: a bug with a patch crashes only there), else with every patch (a
    # bug without patch at that version)
    for put in [p for base in sorted(presets.get(id_, [])) for p in (f'{base}-only-{id_}', f'{base}-fix-all')]:
        for binary in binaries:
            with tempfile.TemporaryDirectory() as tmp:
                outcome = f'{tmp}/w.json'
                subprocess.run(['timeout', '-k', '5', '120', binary, '--put', put, 'witness', id_, '--runs', '1', '--outcome', outcome],
                               env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                try:
                    runs = json.load(open(outcome))
                except Exception:
                    continue
            frames = next((o.get('asan', {}).get('frames') for r in runs if r.get('matches_oracle') for o in r.get('outcomes', [])
                           if (o.get('asan') or {}).get('frames')), None)
            if frames and any(not f.startswith('validation-') and f != 'tlspuffin' for f in frames):
                found = {'frames': frames, 'put': put, 'binary': os.path.basename(binary),
                         'at': datetime.datetime.now().astimezone().isoformat(timespec='seconds')}
                break
            if runs:
                break  # the PUT is in this binary, but its witness gave no symbolized stack of the bug there
        if found:
            break
    if found:
        known[id_] = found
        print(f'{id_}: {" < ".join(found["frames"][:3])} ({found["put"]})')
    else:
        print(f'{id_}: no stack (presets {sorted(presets.get(id_, [])) or "none"})')

os.makedirs(os.path.dirname(out_file), exist_ok=True)
tmp = f'{out_file}.tmp'
json.dump(known, open(tmp, 'w'), indent=1, sort_keys=True)
os.replace(tmp, out_file)
