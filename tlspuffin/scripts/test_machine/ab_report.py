#!/usr/bin/env python3
"""Paired A/B report of the tasks submitted by ab_submit.sh: executions per library (successful runs), A (compat
rules applied) against B (rules disabled), pair by pair, with an exact two-sided sign test and a paired t statistic
on the log ratios.

Usage: python3 ab_report.py ~/ab-<commit>/tasks.txt [exports dir (default /srv/puffin-bench/data/exports)]
"""
import json, math, os, statistics as st, subprocess, sys

# two-sided 5 % critical values of Student's t, by degrees of freedom
T95 = {1: 12.71, 2: 4.30, 3: 3.18, 4: 2.78, 5: 2.57, 6: 2.45, 7: 2.36, 8: 2.31, 9: 2.26, 10: 2.23}


def summary(exports, tid):
    for d in (exports, os.path.join(exports, "Canceled")):
        z = os.path.join(d, f"{tid}.zip")
        if os.path.exists(z) and os.path.exists(os.path.join(d, f"{tid}.json")):
            names = subprocess.run(["unzip", "-Z1", z], capture_output=True, text=True).stdout.split()
            s = next((n for n in names if n.endswith("summary.json")), None)
            if s is None:
                return None, "no summary.json"
            return json.loads(subprocess.run(["unzip", "-p", z, s], capture_output=True, text=True).stdout), None
    return None, "not finished"


def main():
    tasks = sys.argv[1]
    exports = sys.argv[2] if len(sys.argv) > 2 else "/srv/puffin-bench/data/exports"
    execs = {}  # lib -> pair -> group -> executions
    for line in open(tasks):
        if not line.strip():
            continue
        grp, pair, tid = line.split()
        data, err = summary(exports, tid)
        if err:
            print(f"task {tid} ({grp}{pair}): {err}")
            continue
        for lib, l in data.get("libraries", {}).items():
            for a in l.get("data") or []:
                if a.get("state") == "success":
                    execs.setdefault(lib, {}).setdefault(pair, {})[grp] = a["global"][0]["tEnd"]["total_execs"]
    for lib in sorted(execs):
        full = [(p["A"], p["B"]) for p in execs[lib].values() if "A" in p and "B" in p]
        if not full:
            print(f"{lib}: no complete pair")
            continue
        n = len(full)
        a = [x for x, _ in full]
        b = [y for _, y in full]
        wins = sum(x > y for x, y in full)
        p = min(1.0, 2 * sum(math.comb(n, k) for k in range(max(wins, n - wins), n + 1)) / 2 ** n)
        logs = [math.log(x / y) for x, y in full]
        t = ''
        if n > 1 and st.stdev(logs) > 0:
            tv = st.mean(logs) / (st.stdev(logs) / math.sqrt(n))
            t = f" t={tv:.2f} (|t|>{T95.get(n - 1, 2.2)} ⇒ p<0.05)"
        print(f"{lib}: pairs={n} A(rules)={st.mean(a):,.0f} B(no rules)={st.mean(b):,.0f} ratio={st.mean(a) / st.mean(b):.3f}"
              f" geo-mean pair ratio={math.exp(st.mean(logs)):.3f} pairs: {', '.join(f'{x / y:.2f}' for x, y in full)}"
              f" | A>B in {wins}/{n}, sign test p={p:.3f}{t}")


if __name__ == "__main__":
    main()
