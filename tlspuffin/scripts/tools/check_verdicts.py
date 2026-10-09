#!/usr/bin/env python3
"""check_verdicts.py: every page and tool tells the same about the Vuln runs, checked on every finished task.

For each final objectives report with verdicts (report_verdicts.js, the pages' code bugs.js):
  outcomes   the outcome of each run in the report is its state in the summary Results shows (the publisher's copy)
  counted    🎯 counts the runs that found the expected bug and succeeded, no other
  scripts    the job scripts (ObjectiveCounts, nb_objective_targeted) and the report agree on the expected bug
  history    the 🎯 of the scheduler's history page (task_links.json) is the conclusion of the report
  runs       the Runs page measures a time to find for the runs 🎯 counts, no other (runs-cache)

Prints one line per difference, then a summary; exit status 1 when there is a difference. Run by objectives_report.sh
--all after the reports (its log: pb-objectives-cron.log), and by hand: PB_ROOT=/srv/puffin-bench python3 -I check_verdicts.py
"""
import glob
import json
import os
import sys
import zipfile

PB_ROOT = os.environ.get('PB_ROOT', '/srv/puffin-bench')
REPORTS = f'{PB_ROOT}/data/html/objectives'
STORAGE = f'{PB_ROOT}/data/publisher'
LINKS = f'{PB_ROOT}/data/html/board/custom/task_links.json'
CACHE = f'{PB_ROOT}/data/runs-cache'


def load(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def summary_of(task):
    """the summary of a task as Results shows it: artefacts/summary.json of the publisher's archive"""
    for z in glob.glob(f'{STORAGE}/*/*/*/*/{task}.zip'):
        try:
            with zipfile.ZipFile(z) as f:
                return json.loads(f.read('artefacts/summary.json'))
        except (OSError, KeyError, ValueError, zipfile.BadZipFile):
            return None
    return None


def main():
    links = load(LINKS) or {}
    issues, checked = [], 0
    for path in sorted(glob.glob(f'{REPORTS}/[0-9]*.json')):
        task = os.path.basename(path)[:-5]
        report = load(path)
        if not report or report.get('live') or report.get('pending_final') or not report.get('verdicts'):
            continue
        verdicts = report['verdicts']
        libs = {lib.get('library'): lib for lib in report.get('libraries') or []}
        summary = summary_of(task)
        checked += 1
        # outcomes: the report's against the summary of Results
        if summary is not None:
            for name, lib in (summary.get('libraries') or {}).items():
                states = {str(d.get('id')): d.get('state') for d in lib.get('data') or [] if d.get('id') is not None}
                if 'error' not in lib and (libs.get(name) or {}).get('outcomes', states) != states:
                    issues.append(f'{task} {name} outcomes: report {libs[name].get("outcomes")} vs summary {states}')
        for name, v in (verdicts.get('libraries') or {}).items():
            outcomes = (libs.get(name) or {}).get('outcomes')
            # counted: found and succeeded
            if outcomes is not None:
                expect = sorted(a for a in v.get('found', []) if outcomes.get(str(a)) == 'success')
                if sorted(v.get('counted', [])) != expect:
                    issues.append(f'{task} {name} counted {v.get("counted")} but found and succeeded are {expect}')
            # scripts: the job scripts and the report on the expected bug
            for d in v.get('script_disagrees') or []:
                issues.append(f'{task} {name} run {d["attempt"]}: job scripts {"found" if d["script"] else "did not find"} '
                              f'the expected bug, the report {"found" if d["report"] else "did not find"} it')
            # runs: the Runs page measures the runs 🎯 counts
            cache = load(f'{CACHE}/{task}.json')
            runs = (((cache or {}).get('metrics') or {}).get(name) or {}).get('runs')
            if runs is not None:
                measured = sorted(r['attempt'] for r in runs if r.get('measured') is not None)
                if measured != sorted(v.get('counted', [])):
                    issues.append(f'{task} {name} Runs page measures runs {measured}, 🎯 counts {sorted(v.get("counted", []))}')
        # history: the 🎯 of the history page
        c = verdicts.get('conclusion')
        pill = next((l for l in links.get(task, []) if str(l.get('label', '')).startswith('🎯')), None)
        if c and (pill is None or pill.get('level') != f'expected-{c["level"]}'
                  or not str(pill.get('label', '')).startswith(f'🎯 {c["hit"]}/{c["configurations"]} · {c["counted"]}/{c["runs"]} runs')):
            issues.append(f'{task} history 🎯 {pill and pill.get("label")} ({pill and pill.get("level")}) vs report {c}')
    for line in issues:
        print(line)
    print(f'check_verdicts: {checked} reports, {len(issues)} difference(s)')
    return 1 if issues else 0


if __name__ == '__main__':
    sys.exit(main())
