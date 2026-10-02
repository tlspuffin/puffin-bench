# Handover state — fair comparison of historical tlspuffin commits

> Working notes so that anyone can resume this work. **Drop this file before merging the PR(s).**
> Update it (and commit) at the end of every step.

## Goal (requirements from the maintainer)

1. All **perf** tasks for **LibreSSL** must run with ASAN.
2. **WO-BIT**: tlspuffin commits in `[47c97cd7ac2c…, e13983d6a6e1…)` enable bit-level mutations by default
   (opt-out `--wo-bit`). Experiments on these commits must be launched with `--wo-bit`.
3. **LOG**: tlspuffin commits in `[60b3f3185edd…, e13983d6a6e1…)` use a debug-level `client_log_config.yml`
   that biases throughput. Before launching, overwrite `./client_log_config.yml` with the one of `e13983d`.
4. Record the effective ASAN status in the experiment JSON and show a small tick in the results.
5. Warn (and display in results) when experiment logs are larger than a reasonable threshold.
6. Everything is submitted as PRs. **No mention of LLMs/assistants in commit messages: no Co-Authored-By / session trailers; author and committer = `HIRSCHI Lucca <lucca.hirschi@inria.fr>` (set in the repo-local git config).**

## CURRENT STATE (2026-10-02) — read this first

### History rewritten a third time (2026-10-05 evening, before human review)
The day's follow-ups were folded: broker-log rotations and the per-hour-per-core rate into "Record the log volume"
(ExperimentSaveLaunchInfo introduced there, extended with the stderr path by "Record the client crash restarts"),
notes squashed into this last commit; "Record which library build each experiment ran" kept as its own commit.
pr/objectives-report rebuilt linearly (6 commits). Trees identical to the pre-rewrite heads. On cassis-calc:
`git fetch origin && git reset --hard origin/pr/objectives-report` once.
Review order for a human auditor: tlspuffin#545 and tlspuffin#544 (small, independent), then puffin-bench#9
commit by commit (skip this notes commit), then puffin-bench#10 commit by commit.

### History rewritten again (2026-10-05, maintainer request)
Fixups folded: stats_monitor_heartbeat moved next to the other rules (its validation_report line folded into the
test-machine commit), the broker-log change folded into the log-volume commit, the notes commits merged into one.
pr/objectives-report rebuilt linearly on top (no merge commits): replay, pages, landing pages, history 🐞 button.
Trees verified identical to the pre-rewrite heads. On cassis-calc: `git fetch origin && git reset --hard
origin/pr/objectives-report` once.

### History rewritten (2026-10-02 evening, maintainer request)
Both branches were squashed into atomic commits (force-pushed); commit hashes quoted in older notes below refer
to the previous history. pr/fair-comparison-compat = 12 commits on main + this notes commit (last, to drop before
merging #9): Init serialization, compat framework (wo_bit/wo_trunc/log_config), log-level patches, toml_cli_locked,
ASAN status, LibreSSL ASAN, no ASLR, log volume, crash restarts, vendor sources, test-machine scripts, A/B scripts.
pr/objectives-report = that branch + the objectives commits. On cassis-calc the checkout must be reset once
(`git fetch origin && git reset --hard origin/pr/objectives-report`), then `git pull --ff-only` works again.
Workflow unchanged: commit on pr/fair-comparison-compat, then merge it into pr/objectives-report.

### Branches and PRs (all pushed; author/committer HIRSCHI Lucca, no assistant mention anywhere)
- puffin-bench `pr/fair-comparison-compat` → PR tlspuffin/puffin-bench#9 (draft): compat rules, ASAN + log
  recording, test-machine scripts, validation report, no-ASLR launch (`setarch -R`, `NoAslrPrefix`).
- puffin-bench `pr/objectives-report` = the branch above + objectives feature (replay/grouping at ExperimentEnd,
  🐞 dashboard button, `scripts/tools/objectives_report.sh` page for finished tasks, `scripts/tools/objectives_live.sh`
  live page). **No PR yet** (maintainer to decide: separate PR, stacked on #9). cassis-calc runs this branch.
  Keep it in sync: commit on pr/fair-comparison-compat, then merge it into pr/objectives-report.
- tlspuffin `pr/quiet-eval-errors` → PR tlspuffin/tlspuffin#544: CI green, waiting for a reviewer approval.
  When merged: set its merge commit as the end of `codec_warn` and `wolfssl_reseed_warn` in PR_compat.sh,
  update the pinned checks in tests/compat_selftest.sh.
- tlspuffin `pr/monitor-heartbeat` → PR tlspuffin/tlspuffin#545 (2026-10-05, maintainer approved): StatsMonitor
  ignores the broker heartbeat (unregistered ClientId(0)) instead of registering a phantom client (dev, since
  2f06dfef8 / #486). Tests test_display_with_unregistered_client_id_0 + test_display_with_registered_client.
- Push only to these 4 branches (created in this work). Never rewrite others' branches.

### Compat rules (PR_compat.sh; self-test `bash tlspuffin/scripts/tests/compat_selftest.sh <unshallowed tlspuffin clone>` → 1644 checks, 0 failures)
wo_bit, wo_trunc, log_config, reseed_warn, codec_warn (open), wolfssl_reseed_warn (open), wolfssl_reseed_error,
openssl_descriptor_info, wolfssl_descriptor_info, boringssl_clear_info (open), stats_monitor_heartbeat (fix of aborted runs, see item 2), toml_cli_locked (build fix: installs
toml-cli 0.2.3 --locked with the **stable** toolchain, installed first; `~/.cargo/bin` appended to mk_vendor's PATH), libressl_asan (perf, build-time). Source patches are declared
in `COMPAT_PATCH` ("file|text|from|to[|line offset]"). Docs table: tlspuffin/docs/tlspuffin-job-scripts.md.

### Results so far (cassis-calc, 70 min runs, 3 cores per run)
- A/B 2f38bf22a log_config (successful runs only): ×1.28 (BoringSSL), ×1.33 (WolfSSL), ×1.38 (LibreSSL),
  ×1.43 (OpenSSL) executions with the rule; without it 8/20 runs killed by hang detection, with it 0/20.
- dev 5c588ab11: clean (18/20 full runs, logs ≤ 5 MB).
- 1957fba63 re-run with wolfssl_reseed_error: WolfSSL 5/5 runs, logs 106 → 4 MB, ×1.10 executions; OpenSSL still
  failed (toml-cli locked deps broken on the commit's nightly) → fixed by 755a543, re-run pending.
- Startup crashes "AddressSanitizer:DEADLYSIGNAL ... nested bug" = LLVM < 18 ASAN vs vm.mmap_rnd_bits=32 → fixed by
  setarch -R (every launch) + vm.mmap_rnd_bits=28 on cassis-calc.

### Running / pending on cassis-calc (results are written on the machine; ask the maintainer to paste them)
| Task | What | Report file (in ~ of the maintainer) |
|---|---|---|
| 1790889684385 | 1957fba63 with toml_cli_locked via stable: OpenSSL must build and run | ~/pb-validation-report-1957b.txt |
| 1790889316584 | 2f38bf22a with the 3 new log rules: logs of BoringSSL/OpenSSL/WolfSSL must drop below 50 MB | ~/pb-validation-report-2f38.txt |
| 1790889342265 | dev with COMPAT_DISABLE=all, compared with 1790851751074 (dev with rules): speed-up on dev | ~/pb-validation-report-dev-ab.txt |
Early check of the OpenSSL builds: `curl -s http://127.0.0.1:10082/api/task/1790889684385/state | jq ...`
(ForcedBuild steps with id OpenSSL; their `.stderr` path; grep "Cannot build OpenSSL").

### Results of the 3 re-runs (2026-10-02)
- dev with vs without fixes (1790851751074 vs 1790889342265, COMPAT_DISABLE=all), mean of full runs:
  BoringSSL ×1.34, WolfSSL ×1.21, OpenSSL ×0.99, LibreSSL ×0.97; logs without fixes 28–67 MB (≤ 5 MB with).
  Indicative only: different times/load; only the run without fixes had setarch -R.
  On dev only codec_warn changes anything (C PUTs already log the reseed failure at debug; wolfssl-sys is the unused
  Rust PUT). Its expected cost: ~30 codec WARN records/s for 3 cores (cloud measurement D), each = formatting a
  ~2.3 KB term + 2 flushed writes (~10-100 µs) → well under 1 % of throughput. A ×1.21-1.34 gain would need ~20 ms per
  record → the BoringSSL/WolfSSL differences (Mann-Whitney p=0.03, 5 vs 5) are most likely confounded (load, ASLR),
  not caused by the rule. Clean A/B: `test_machine/ab_submit.sh <commit> [pairs=6] [disable=all]` submits alternate
  A/B tasks of 1 attempt per library (paired by submission order → same load), stored under tlspuffin/AB/<commit>/
  (not indexed by the dashboard); `ab_report.py ~/ab-<commit9>/tasks.txt` → paired ratios, sign test, paired t.
  SUBMITTED 2026-10-02 ~16:00 local: dev 5c588ab11, 6 pairs, ~/ab-5c588ab11/tasks.txt on cassis-calc
  (A1 1790950669870 … B6 1790950671359). Result pending.
  NOTE: the earlier A/B tasks were stored under PR/<commit>/Perf/ → the dashboard shows the newest per library, so
  dev (1790889342265, COMPAT_DISABLE=all) and 2f38bf22a (1790851755113, log_config disabled) currently display results
  WITHOUT the rules: purge them (DELETE /api/task/<id>, irreversible) only with the maintainer's approval. Log sizes
  28-67 MB are lower bounds (rotation window), the cloud rate gives ~600 MB per run.
- 2f38bf22a with the 3 new log rules (1790889316584): 20/20 full runs, all 9 rules applied, but the report found no
  summary.json in its export (stored as exports/1790889316584/1790889316584.{json,zip}, a subfolder unlike the
  others): check the export layout / SummaryRun output, then read log volumes and executions.
- 1957fba63 (1790889684385): WolfSSL 5/5, 3 MB logs; OpenSSL STILL fails 5/5 despite toml-cli via stable.
  Cause found (reproduced locally): the nix shell's rustup is 1.26 (nixos-23.11), which answers `cargo +stable`
  with "toolchain 'stable-…' is not installed" (no auto-install before rustup 1.28) → fallback to the commit's
  nightly → fails as before. Also the services' PATH has no ~/.cargo/bin, so an installed `toml` would not be found.
  Fix 082a8b8: patched line = append ~/.cargo/bin to PATH; if no toml: flock + `rustup toolchain install stable
  --profile minimal && cargo +stable install toml-cli --locked --version 0.2.3` (no nightly fallback). Tested with
  rustup 1.26, no stable, toml off PATH: installs (45 s), `mk_vendor locate openssl:openssl111u` OK; 2nd run 0.3 s.
  Re-run 1790940562353 (with 082a8b8): OpenSSL STILL failed 5/5, same proc_macro_span_shrink error: here
  mk_vendor runs from the openssl-src-111 build script inside cargo build, where cargo sets RUSTC=<nightly rustc>,
  which `cargo +stable install` honours. Reproduced locally with a build script; fix: `env -u RUSTC -u RUSTFLAGS …`
  for the install (tested in a build script: toml-cli installed, vendor located). Hot update ba393c4; re-run 1957fba63 = task **1790948258052**.
  Confirmed on cassis-calc: no stable toolchain in /srv/puffin-bench/home/.rustup/toolchains (only 1.94.0 and the
  two nightlies). Hot update done (8c81e23); 1957fba63 re-run = task **1790940562353** (report ~/pb-validation-report-1957c.txt).
- 2f38bf22a (1790889316584) "no summary.json": the scheduler finalizes a task by moving it to exports/<id>/,
  copying <id>.json there, zipping to exports/<id>.zip.tmp, renaming, then deleting exports/<id>/
  (scheduler/src/scheduler/schedule/{task,archiver}.cxx). The report's `find -maxdepth 2` picked the working copy
  exports/<id>/<id>.json while the zip was being written (or zip failed). Fixed in validation_report.sh (082a8b8) and
  objectives_report.sh (c014115): a task is finished when exports[/Canceled]/<id>.{json,zip} both exist. To check
  on the machine: zip present now, else "[Archiver]" errors in the scheduler journal.
  Confirmed: zip written 01:54:59 → 01:56:22 (80 s), the report ran in between. Re-run of the report: **0 failures**,
  20/20 full runs, logs ≤ 3 MB (were 95–261 MB): BoringSSL 0.81–0.88 M, LibreSSL 1.18–1.38 M, OpenSSL 0.53–0.82 M,
  WolfSSL 0.88–1.03 M executions.
- validation_report.sh fixed: expected rules of 2f38bf22a, COMPAT_DISABLE=all.

### Crash restarts and vendor sources (2026-10-02, maintainer request)
- The tlspuffin LibreSSL harness will be fixed later in the fork: presets fetch `tlspuffin/libressl` branch
  `fuzz-v3.3.3` by NAME (not pinned), so new builds of old commits get the fix automatically.
  Fork history (linear, no tags): f2b4d4f "Apply fuzzing changes" (broken harness: memcmp with the incoming label's
  length → reads past 'ext_binder') → 0f4d2b0 (fix) → **2f36ce3** (hardening: exact label match by length+bytes,
  claim callback NULL check, transcript length bound) = branch head since 2026-10-02. Results built from f2b4d4f
  (all LibreSSL 3.3.3 Rust-harness results so far) are the ones to redo.
- Implemented: `ExperimentCrashStats` (ExperimentEnd; `"crashes"` in logs-<lib>-<n>.json; 💥⚠️ above
  CRASH_WARN_RESTARTS=100; counts "Spawning next client (id N>0)" + ASAN reports; the experiment step saves
  THEJOB_STDERR_PATH in .experiment_stderr_path because LibAFL 0.11 commits do not redirect the clients' stderr) and
  `DetectVendorSources` (end of ForcedBuild; `"vendor_sources"` in cli json; dashboard line "sources: …").
  Tested on fake layouts + render helpers; NOT yet on cassis-calc (hot update, then check on the next task).
- Counting checked on the old dcf9ff4e7 export (attempt 2): restarts=28644 asan=28773 (raw grep earlier: 28663
  "Spawning" lines incl. 19 with id 0, 28775 ASAN lines incl. 2 not at line start, interleaved output) → OK.
- dcf9ff4e7 re-run with the fixed harness (2f36ce3) and the new recording: task **1790947254471** (duplicate 1790947223012 to cancel). Expect LibreSSL
  sources fuzz-v3.3.3@2f36ce392, ~0 restarts, no ext_binder objectives; compare executions with 1790851749055.
- After the fork fix: re-run LibreSSL perf of [cd649d6bf, 8f05ae581) and select superseded results by
  vendor_sources (absent or f2b4d4f70 = broken harness).

### Open items (in priority order)
1. Read the 3 reports above; fix what fails (same method: export zip → logs/stderr.<g>-<s>-<a>.txt, step ids from
   the export json `.task.steps[] | .executor_data.launcher_file`; fuzzer logs in artefacts/<lib>/<n>-log_root/).
2. dcf9ff4e7 — SOLVED (2026-10-05), to validate by a re-run. Root cause of the early ends (10/20 runs of
   1790947254471): broker panic in tlspuffin's StatsMonitor. LibAFL's broker (`on_timeout`, 30 s without client
   messages) calls `monitor.display(.., "Broker Heartbeat", ClientId(0))`; ClientId(0) is never registered, and the
   monitor of [92251a295, 2f06dfef8) looks its stats up → KeyNotFound → panic → broker dies → run ends. dev
   (2f06dfef8, #486) avoids the panic by registering the sender, which counts a phantom client in the global stats;
   #545 ignores unregistered senders instead. Rule stats_monitor_heartbeat backports the guard (line patch).
   Log volume at dcf9ff4e7: ~40-50 MB per run is stats_puffin_main_broker.log (the broker's monitor log, grows with
   time × clients, not with the log level) → excluded from the estimate, recorded as "monitor_mb" (D11). Remaining:
   `reservoir_sample` WARNs (present on dev too, not a rule). Unverified hypothesis: the 30 s silences come from slow
   clients (large terms; trace growth fixed by tlspuffin #531) → check timestamps around "Broker Heartbeat".
   Older analysis (task 1790851749055) — analysis so far (code reading): `<n>-log/puffin_main_broker_stderr.log` is
   the Launcher `stderr_file`, i.e. the **clients'** stderr (ASAN reports, panics), not the broker's; at dcf9ff4e7
   claim violations still crash the client (feedback instead of crash from ac3b89aff, after dcf9ff4e7), so the
   LibreSSL 3.3.3 false objectives (item 3) likely fill it with ASAN reports and cost client restarts.
   MEASURED (2026-10-02): stats.json per run: dev 1790851751074 16–26 MB; 2f38bf22a 1790851753092 337–691 MB;
   dcf9ff4e7 1790851749055 44 MB–1.24 GB. dcf LibreSSL attempt 0: 104,835 global + 104,835 client records,
   events = 104,400 UserStats, 332 Testcase, 94 PerfMonitor, 12 Objective (UserStats ≈ 25/s dominate); its clients'
   stderr 82 KB = 12 ASAN global-buffer-overflow reports (ext_binder, item 3) + "Spawning next client"; broker log
   stats_puffin_main_broker.log 27 MB. Attempt 2's 196 MB stderr not yet inspected.
   Throttle on dev since dc3bbd3a2 (#489, merge of 47c23313b): EVERY commit before it writes unthrottled stats.json.
   47c23313b does not cherry-pick cleanly even on dcf9ff4e7 (stats_monitor.rs conflict), and LibAFL 0.11 commits have
   another monitor → a rule = a per-monitor-version backport, not a line patch. Cost is in the broker (JSON
   serialization ~0.3 MB/s, inside the task's cpuset) → proposed: no rule unless an A/B shows a throughput bias;
   maintainer to decide. Estimate given to the maintainer: marginal (the broker receives the same events on dev,
   only the JSON/log writing differs: ~50 records/s, well under 1 % of one of the task's cores, far below the ±15 %
   run-to-run spread); its real costs are operational (1.2 GB files, 80 s zip, summary parsing).
   dcf LibreSSL attempt 2's 196 MB clients' stderr = 28,775 ASAN global-buffer-overflow reports (memcmp reading
   12 bytes past 'ext_binder', from tls13_server_hello_sent / tls13_server_engage_record_protection) and 28,663
   client respawns in 70 min (~7/s): THE real bias for LibreSSL 3.3.3 Rust-harness commits [cd649d6bf, 8f05ae581)
   — each crash restarts a client. Appears only with ASAN (requirement 1), so it is item 3, not a log rule.
   Earlier analysis:
   stats.json: before 47c23313b (2026-05-18, "stats.json and broker logging interval, default 250 ms") the broker
   writes a global + a client record on EVERY monitor event (testcase, objective, stats); dcf9ff4e7 lacks it, dev has
   it, 2f38bf22a (LibAFL 0.11.2) has its own older monitor. Not a client-side bias by itself (broker work), so no
   rule yet: waiting for the maintainer's numbers (stats.json sizes of the 3 tasks, records/s, event names, top
   stderr lines). Original note:
   log volume up to 899 MB is NOT in log_root: `artefacts/LibreSSL/<n>-stats.json`
   is 1.0–1.2 GB and `<n>-log/puffin_main_broker_stderr.log` up to 196 MB. Compare stats.json sizes with dev
   (1790851751074) and 2f38bf22a (1790851753092); find what fills the broker stderr; decide whether a rule is needed
   (stats interval/format of that commit?). Also many early ends there (ASLR crash, mid-run aborts "Abandon"):
   re-run dcf9ff4e7 with the current scripts.
3. LibreSSL 3.3.3 objectives (global-buffer-overflow reading past 'ext_binder', tls13_key_schedule.c:183) come from
   tlspuffin's claim instrumentation in the fork github.com/tlspuffin/libressl branch fuzz-v3.3.3
   (`memcmp(label, ext_binder, labellen)` with labellen of the incoming label) → false objectives in perf results
   of the LibreSSL 3.3.3 Rust harness. Being investigated in another session (prompt given to the maintainer).
4. Before marking #9 ready: validation checked, drop this file. PR body rewritten on 2026-10-02 (rules table, 1506
   checks, setarch, recorded conditions, validation results). Older note: its rule table lacks
   openssl_descriptor_info, wolfssl_descriptor_info, boringssl_clear_info and the stable-toolchain toml_cli_locked,
   it says 1097 self-test checks (now 1506), and it does not mention setarch -R / "aslr" in cli json or the
   validation results (A/B log_config ×1.28–1.43, dev with/without fixes). No footer or assistant mention.
4b. Objectives feature (pr/objectives-report): tested on synthetic data and partly on cassis-calc (live page works,
   symbolized via nix-shell). Not yet seen on a real finished task: the 🐞 button and objectives-<lib>-<n>.json
   (first task run with the new ExperimentEnd that finds objectives: 1957fba63 WolfSSL in 1790889684385 → check
   the dashboard there). Ask the maintainer whether to open a PR for it (stacked on #9).
5. Optional: re-run perf on the affected commits on production; purge superseded results only with approval.

### cassis-calc operations (Ubuntu 24.04, 40 cores, services as the maintainer's user, PB_ROOT=/srv/puffin-bench)
- Board http://cassis-calc.loria.fr:10082/files/index.html, dashboard http://cassis-calc.loria.fr:10083/files/tlspuffin,
  live objectives http://cassis-calc.loria.fr:10083/html/objectives/live.html, finished task pages
  …/html/objectives/<task>.html.
- **Never restart the services while tasks are queued or running** (the scheduler forgets them). Prefer the hot
  update: in the checkout (`find ~ -path '*tlspuffin/scripts/test_machine/validation_report.sh'` → repo root),
  `git pull`, `bash tlspuffin/scripts/build.sh`, copy `tlspuffin/scripts/PR_{perf,vulnerabilities}_full.sh` to
  /srv/puffin-bench/data/html/jobsscripts/tlspuffin/ and changed dashboard/summary files to
  /srv/puffin-bench/data/html/publisher/ and /srv/puffin-bench/data/tools/js/ (only new tasks use new job scripts).
  A full deploy (stop target → deploy.sh → start target) only when nothing is queued.
- Submitting a task: see the 2026-10-01 entry below (curl -F … /api/task/new). Validation:
  `PB_WAIT_MIN=0 bash tlspuffin/scripts/test_machine/validation_report.sh <task ids>`.
- Cron jobs of the maintainer's user, pinned to core 0 (never given to experiments) at idle priority:
  `objectives_live.sh` every 5 min (HOME=/srv/puffin-bench/home), `objectives_report.sh --all` every 10 min.
  Rule from the maintainer: nothing may take CPU from the fuzzing cores.
- The maintainer prefers one copy-paste block per step, root (sudo) steps separated, commands wrapped in
  `bash <<'EOF' … EOF` (their shell is zsh), and no placeholder starting with '<' inside commands.

## Decisions taken

| # | Decision |
|---|----------|
| D1 | Commits before `cd649d6bf` (Oct 2024): LibreSSL+ASAN cannot be built (`libressl-src` panics "ASAN not yet supported") → **fail fast and mark "LibreSSL: ASAN unsupported"** in results. No backport. |
| D2 | WO-BIT and LOG rules apply to all job types (perf, vuln, campaign), with opt-out task arg `COMPAT_DISABLE=<id,…|all>`. LibreSSL-ASAN rule: perf only. |
| D3 | WO-BIT range end `e13983d` is **exclusive** (at e13983d `--wo-bit` is only an `execute` option; top-level use breaks the CLI). |
| D4 | This handover file is dropped before merge. |
| D5 | Finally: one puffin-bench PR (#9) for the compat work, a separate branch for the objectives feature, and one tlspuffin PR (#544) for the log levels. |
| D6 | (2026-10-02) A perf re-run of a commit before `cd649d6bf` overrides its older non-ASAN LibreSSL results on the dashboard with "ASAN unsupported" (newest per library and experiment type, as for any re-run). Kept as is. |
| D7 | (2026-10-02) flock is mandatory on scheduler hosts (Init cancels the task with "flock is required" otherwise; setup_root.sh installs util-linux, deploy.sh checks it). ASLR can be turned back on per task with COMPAT_DISABLE=no_aslr (included in all). |
| D8 | (2026-10-02) A commit inside a declared range whose probe does not match (e.g. side-branch PR commits) runs with the probe's decision and a visible warning (COMPAT_WARNING on the scheduler board, ⚖️⚠️ on the dashboard, "mismatch" in compat.json) instead of being cancelled. |
| D9 | (2026-10-02) flock guards kept as they are (flock comes with util-linux, essential on Debian/Ubuntu). |
| D10 | (2026-10-05) Fix root causes, not symptoms: the dcf9ff4e7 aborts are fixed in tlspuffin (#545) and backported by the stats_monitor_heartbeat rule, not by relaunching runs. |
| D11 | (2026-10-05) The broker's monitor log (stats_puffin_main_broker.log*) is not counted in the log-volume warning; recorded as "monitor_mb". |
| D12 | (2026-10-05) Log-volume warning per hour and per fuzzing core: LOG_WARN_MB_PER_CORE_HOUR, default 15 (= 50 MB for a 70 min perf run on 3 cores), from 10 min of run on; LOG_WARN_MB stays an absolute override. The broker log's rotations ./log<N> count as monitor log. |
| D13 | (2026-10-05) `[reservoir_sample] Skipping term because it is too large` (WARN, many per second when terms grow huge, e.g. dcf9ff4e7 LibreSSL ~25 MB/h/core) gets no rule: solved on dev (terms stay small), not fixed for earlier commits; such runs keep their log warning. |

## Repositories / branches

- puffin-bench: work branch **`pr/fair-comparison-compat`** (created from `main` v1.01). Maintainer rule: push ONLY to branches created in this work, never to others. Job scripts live only on `main` under
  `tlspuffin/scripts/` (`PR_common.sh`, `PR_perf.sh`, `PR_vulnerabilities.sh`, assembled by `build.sh`),
  QuickJS post-processing in `tlspuffin/data/tools/js/`, dashboard in `tlspuffin/data/html/publisher/`.
  Component branches (`scheduler`, `publisher`, `git_restapi`, `vis_comparator`) are squashed into `main`
  (see `UPDATE.howto`). History of the job configs: `scheduler` branch, `scheduler/samples/jobs/tlspuffin/`.
- tlspuffin: read-only reference. **The clone is shallow by default → `git fetch --unshallow origin`.**
- PRs: puffin-bench https://github.com/tlspuffin/puffin-bench/pull/9 (draft, pr/fair-comparison-compat → main; single PR,
  the LibreSSL rule was not split out as it builds on the same framework); tlspuffin
  https://github.com/tlspuffin/tlspuffin/pull/544 (pr/quiet-eval-errors → dev). PR texts contain no assistant mention.

## Verified facts (with evidence)

### WO-BIT
- Top-level `arg!(--"wo-bit" "Disable bit-level mutations")` in `puffin/src/cli.rs` on all 35 first-parent
  commits 47c97cd…2f38bf22a; default `MutationConfig.with_bit_level: true`.
- Switched to opt-in `--with-bit` by 49d815540 (merged as e13983d).
- tlspuffin errors if both `--wo-bit` and `--wo-dy` are given; clap rejects a repeated flag → dedupe.

### LOG
- `client_log_config.yml` on dev: blob `4d2fd2a5dde35771cd65ad9cdb3304b086d45b68` (from 60b3f31, root=debug +
  `puffin::algebra::term` debug → terms.log; `error`/`warn` loggers are target names → error/warn.log empty)
  and blob `fb844b8b74f5089b02ca66669662e85689247514` (from e13983d = current dev, root=info).
- In `[60b3f31, e13983d)` (20 first-parent commits) every client calls
  `log_handle.set_config(load_fuzzing_client())` (libafl_setup.rs). From e13983d, experiment mode uses
  `set_experiment_fuzzing_client(log_folder, Info)` and ignores the yml. Before 60b3f31 clients capped at Warn.
- log4rs 1.2.0 everywhere in range: flush per record; synchronous gzip roll; `policy.kind` defaults to
  `compound`; threshold filter in default features → e13983d yml parses in range.
- e13983d yml: nothing below INFO anywhere, no console output, creates `log/{info,warn,error,fuzzer,harness}.log`
  and an empty `log/terms.log` (appender files are opened when the config is built).
- Side-branch yml variants (not on dev): ed6e91e38, 7b49dcd53, 2fcc513e0, be205fecb.

### LibreSSL / ASAN
- puffin-bench perf config for LibreSSL: `features: libressl` (no ASAN) until b153ffc (2026-04-17),
  `asan,libressl` from d1f9e5d, `vendor: libressl:libressl421-asan` from 06924ed (2026-06-26).
  Deployed configs lagged: a run on 2026-06-22 of tlspuffin dcf9ff4e7 still used `features: libressl`.
  → Select results to re-run by `cli.features` lacking `asan`, not by date.
- tlspuffin: `< cd649d6bf` → libressl-src panics with asan; `[cd649d6bf, 8f05ae581)` → Rust harness, libressl-src
  passes `asan` to `builder.cmake` (`-fsanitize=address`); `≥ 8f05ae581` → C harness `libressl421-asan`.
- VERIFIED (2026-09-30): the Rust path with ASAN works. dcf9ff4e7 built with
  `cargo build --release --bin tlspuffin --features=introspection,asan,libressl` (clang 18 + libclang-rt-18-dev,
  no nix in the cloud container) → binary links `libclang_rt.asan-x86_64.so`, has 18 `__asan_report*` refs
  (instrumented LibreSSL), and `ASAN_OPTIONS=help=1 ./tlspuffin --version` prints the AddressSanitizer flags.
  So D1's "ASAN unsupported" applies only to commits before cd649d6bf.
- ASAN detection method for `DetectAsan`: `ldd` shows `libclang_rt.asan`/`libasan` (runtime) +
  `readelf -Ws` count of `__asan_report` (instrumented code); optional runtime probe `ASAN_OPTIONS=help=1 <bin> --version`.
  Do NOT rely on the "Running with shared ASAN support" log line: `asan_info()` runs before log4rs is initialised.
- `MonitorExperiment` prints "(asan?)" whenever Default PUT comes from README — not an ASAN indicator.

### Existing commit-dependent logic in puffin-bench (`tlspuffin/scripts/PR_common.sh`)
faketime (ancestor of 8b29ce76d, l.637), shell.nix pin (l.647-668), wolfssl patch (l.670-673),
LibAFL version → AFL_CORES_GRAMMAR (l.676-680), C vendor vs Rust features (ComputeBuildRuntimeInfo l.120-177),
file layout probes (FindFile), utils.js:410 (libafl < 0.12.0), perf_summary_run.js:31 (wolfssl ≤ 540).

## Measurements (cloud container, 4 cores, not the benchmark host)

Mini A/B on 2f38bf22a (`--features=introspection,asan,libressl`, `--cores 0-2 --wo-bit`, 150 s each, sequential, with the
`.cargo/config.toml` ASAN_OPTIONS `verify_asan_link_order=1:detect_leaks=0:abort_on_error=1` — without them the broker
panics in libafl 0.11.2 monitors/mod.rs:545):
- A, original debug-level yml: 66,203 execs, ≥114 MB logs estimated (rotation window of 5 saturated → lower bound).
- B, reference yml (e13983d): 90,978 execs (+37 %; A is 27 % slower), 17 MB logs.
- In B, `[RNG] reseed failed (tcp): not supported` is logged at WARN once per execution (puffin/src/put_registry.rs
  default impl) → ~8 MB / 150 s in both info.log and warn.log. Present as WARN from 29e90ea78 (2024-10) to d1f510dcb
  (2025-08, turned into DEBUG for tcp); absent on current dev. NOT covered by any rule — reported to the maintainer.
  One sample each on a noisy machine: to be confirmed on the benchmark host (step 6).
- Correction: the per-execution WARN exists only in [2f38bf22a, d1f510dcb) (4 first-parent commits; DEBUG before, tcp
  override at DEBUG from d1f510dcb). Rule `reseed_warn` added (maintainer approved): Init patches
  `puffin/src/put_registry.rs` `log::warn!` → `log::debug!`.
- C, all rules (patched source + reference yml + --wo-bit): 106,601 execs in 149 s (+17 % vs B, +61 % vs A), ~1.8 MB of logs,
  almost only `ERROR Truncating trace at step N` (+ backtraces), written 3× (error/info/warn.log).
- DONE (maintainer approved) rule `wo_trunc`: trace truncation is ON by default (opt-out `--wo-trunc`) in [2ed7077aa (PR #408, 2025-07-17),
  24f7f10c2 (2026-01-22)), opt-in `--with-trunc` afterwards → same kind of default flip as wo_bit.

- D, calibration on current dev 5c588ab11 (C vendor libressl421-asan, `--features=introspection,cputs`, same setup,
  150 s, default flags): 67,094 execs (different PUT version, not comparable with A–C), **~22 MB of logs**:
  info.log 11.2 MB + warn.log 11.1 MB = 4,822 × `WARN [evaluate_config_wrap] FnError::Codec Error on <full term>`
  (~2.3 KB each, written twice). Source: puffin/src/algebra/term.rs, `log::warn!` for FnError::Codec (and
  FnError::Unknown), introduced by e13983d (the FnError::Codec branch does not exist before) → all commits since
  e13983d, dev included, pay it; older ones do not (bias against recent commits). ~620 MB / 70 min.
  → LOG_WARN_MB default NOT changed (100): dev runs would be flagged, correctly. OPEN: maintainer to decide
  (fix in tlspuffin: log these at debug, and stop writing WARN/ERROR records into info.log too).

- E, dev + tlspuffin fix (branch `pr/quiet-eval-errors`, commit 6bc0e2a90: FnError::Codec and the reseed
  failures of the default PUT factory and wolfssl-sys logged at debug; info.log duplication NOT changed, on
  maintainer request): 64,852 execs (D: 67,094, −3 %, noise), logs 22 MB → 0.18 MB (broker [Monitor] lines).
  → LOG_WARN_MB default set to 50.
- puffin-bench rules `codec_warn` [2f38bf22a, open) and `wolfssl_reseed_warn` [29e90ea78, open) patch the same lines at
  Init (generic COMPAT_LOWER_WARN helper, also used by reseed_warn). Open range ("-"): probe decides, no cancel.
  **TODO when the tlspuffin fix is merged: set the merge commit as the end of both ranges.** The self-test will
  remind it: once dev contains the fix, its probe is false while the open range still expects true.

## Design (compat-rules layer)

New `tlspuffin/scripts/PR_compat.sh`, concatenated by `build.sh` (add to CMake DEPENDS). Rule = id, scope,
declared range (docs + self-test), probe (decides), action, verification, record.

| Rule | Probe | Action | Hook |
|---|---|---|---|
| wo_bit | top-level `--wo-bit` present, no `--with-bit` | add `--wo-bit` to extra_flags (dedupe, skip with `--wo-dy`) | Init → launch; verify in ForcedBuild `help` |
| log_config | libafl_setup.rs loads yml, no `set_experiment_fuzzing_client` | `git show e13983d:client_log_config.yml` (check blob fb844b8…) over `./client_log_config.yml` | Init + ExperimentSetup* |
| libressl_asan | TYPE=perf and library libressl | require ASAN vendor/feature; fail "ASAN unsupported" if impossible | end of ComputeBuildRuntimeInfo |

Also: `DetectAsan` after ForcedBuild (`__asan_report_*` refs + ldd/`__asan_init`) → `.asan_info.json` → `cli-<step>.json`
`"asan"` → summary.json → tick in `summary_render.js` (~l.457, next to ⚙C/🦀), optional graph tick labels;
monitor prints real ASAN status. `ExperimentLogStats` in ExperimentEnd → `logs` per attempt → `log_warning` per
library → ⚠ icon; threshold `LOG_WARN_MB` (calibrate on dev runs), rotation/verbose files always warn.
Record `"compat"` in cli json; `compat.json` artefact.

## Steps

- [x] 0. Handover file created.
- [x] 1. Framework (`tlspuffin/scripts/PR_compat.sh`, evaluated in `Init` → `compat.json` artefact + global param `COMPAT_APPLIED`; task cancelled on range/probe mismatch) + self-test `tlspuffin/scripts/tests/compat_selftest.sh /path/to/tlspuffin` (275 checks OK). No action taken yet by the rules.
- [x] 1b. Log-volume stats + warning. `ExperimentLogStats`/`ExperimentSaveLogStats` (PR_common.sh) called in perf and
      vuln `ExperimentEnd` → `logs-<lib>-<attempt>.json` (estimated MB = live files + 10 MB per .gz archive; verbose =
      non-empty debug/trace/terms/puffin.N logs; warning above `LOG_WARN_MB`, default 100, **to calibrate on dev runs**)
      → `Utils.AttachLogStats` (utils.js) in both summary scripts → per-attempt `logs`, per-library `log_warning`/`log_max_mb`
      → dashboard `summary_data.js` status + `GetLogWarningIcon` (summary_render.js, 📜⚠️ with tooltip). Monitor prints
      `Logs: ~N MB`. Tested on fake layouts (bash) and with node (qjs not built locally); not yet run on the scheduler.
- [x] 1c. ASAN detection. `DetectAsan` (PR_common.sh) at the end of `ForcedBuild` on `./target/release/$PACKAGE`
      → `./.asan_info.json` `{requested, instrumented (true/false/null), runtime shared|static|none|unknown,
      asan_report_refs}` → `"asan"` in `cli-<step>.json` (ExperimentSetupForCargo) → summary.json → dashboard badge
      `GetAsanBadge` (summary_render.js, ASAN✓ / ASAN✗ / ASAN? for older results; CSS in summary.css). Monitor prints
      `ASAN: ✓/✗/?` and no longer the misleading "(asan?)". Needs `readelf` and `ldd` on the scheduler host (else
      instrumented=null → "?"). Graph tick labels not changed (optional). Tested on the dcf9ff4e7 ASAN build (✓, 18 refs),
      a plain binary (✗) and a missing one (null).
- [x] 2. wo_bit rule: `CompatApplyFlags` (adds `--wo-bit` once, not with `--wo-dy`) before setup in `ExperimentRun*`; `CompatVerifyHelp` on `ForcedBuild` help output (`./.fuzzer_help.txt`). Unit-tested; end-to-end OK on a 2f38bf22a asan,libressl build (help lists `--wo-bit`, experiment dir name contains `wo-bit`).
- [x] 3. log_config rule: `CompatPrepare` (Init, extracts e13983d yml to `$THEJOB_OUT_PATH/compat/`, blob-checked) + `CompatApplyFiles` (after setup, before launch). Unit-tested; end-to-end + mini A/B done (see Measurements). `cli-<step>.json` gets `"compat": [ids]`.
- [x] 4. libressl_asan rule: `CompatBuildRules` (PR_compat.sh) at the end of `ComputeBuildRuntimeInfo`; TYPE=perf +
      libressl only; adds `asan` feature on the Rust path; sets COMPAT_UNSUPPORTED for non -asan C vendor or libressl-src
      "ASAN not yet supported" (< cd649d6bf) → ForcedBuild writes cli json with "unsupported" + `.unsupported` marker and
      returns 0 (no build, no failure of the flow); perf ExperimentWithCargo/ExperimentEnd skip; perf_summary_run.js adds
      unsupported libraries from `cli-*.json`; dashboard ⛔ "not run" + "ASAN unsupported" badge. Tested: 8 rule cases,
      ForcedBuild chain on 1957fba63 (no nix-shell call), summary (node shim), BuildDataSet. Opt-out COMPAT_DISABLE=libressl_asan.
- [x] 5. Docs: sections "Compat Rules" and "Recorded Experiment Conditions" in `tlspuffin/docs/tlspuffin-job-scripts.md`; flow line in `tlspuffin_user_guide.md`. (LibreSSL rule docs to add with step 4.)
- [~] 6. Validation on cassis-calc: mostly done (see CURRENT STATE); 3 re-runs pending.
- [x] 7. PRs (#9 draft, tlspuffin #544).
- [ ] 8. Re-run affected commits; purge superseded per-task results (`DELETE /api/notify?task_id=…`) only with approval.

## Session log

- 2026-09-30: research done (branches, docs, scripts, tlspuffin ranges); plan agreed; decisions D1–D5.
  Test build of dcf9ff4e7 with asan,libressl: OK, ASAN active (see LibreSSL facts).
  Commit/push of this file was blocked by the session's permission settings → file only in the container.
  Next: get commit/push permission, then step 1.
- 2026-09-30 (later): commit/push allowed only on self-created branches → created the work branch, renamed `pr/fair-comparison-compat` on request (branch names must not mention the assistant either; branches cannot be deleted from the working environment; tlspuffin fix branch: `pr/quiet-eval-errors`). Obsolete branches deleted by the maintainer.
  Step 1 done. Next: step 1b (log-volume stats) or 1c (ASAN detection), then rule actions (steps 2–3).
- 2026-09-30: step 1b done (see checklist). Next: 1c ASAN detection + tick.
- 2026-09-30: step 1c done. Next: step 2 (wo_bit action), step 3 (log_config action).
- 2026-09-30: steps 2, 3, 5 committed; end-to-end + mini A/B done. Next: step 4 (LibreSSL ASAN rule).
- 2026-09-30: reseed_warn rule added (self-test 412 checks OK). Waiting on maintainer: truncation default flip.
- 2026-09-30: wo_trunc rule added (flags generalized via COMPAT_FLAG; self-test 549 checks OK; 2f38bf22a build lists --wo-trunc).
- 2026-09-30: step 4 done. Calibration build of dev (libressl421-asan C vendor) running for LOG_WARN_MB.
- 2026-09-30: calibration on dev → dev itself logs ~22 MB/150 s (FnError::Codec WARN with full term). Asked maintainer.
- 2026-09-30: tlspuffin fix pushed (pr/quiet-eval-errors, no PR yet); rules codec_warn + wolfssl_reseed_warn; LOG_WARN_MB=50.
- 2026-10-01: test machine deployment, split on maintainer request (root only where needed):
  `tlspuffin/scripts/test_machine/setup_root.sh` (sudo, once: apt packages, Nix multi-user, PB_ROOT owned by the user,
  systemd units grouped by `puffin-bench.target`, services run as that user, sudoers) and
  `tlspuffin/scripts/test_machine/deploy.sh` (no root: build + install; refuses root and running services).
  Commands: clone the branch; `sudo bash .../setup_root.sh "$USER"`; `bash .../deploy.sh`;
  `sudo systemctl start puffin-bench.target`. Updates: stop target, git pull, deploy.sh, start target.
  Tested in the Ubuntu 24.04 container: deploy.sh as a non-root user (with a stub nix-shell and a dummy unit file):
  refuses root / missing setup; full build + install into a user-owned root; re-run keeps edited config.json and
  refreshes the job scripts. NOT testable here: setup_root.sh (apt part tested earlier; Nix, systemd, sudoers not).
- 2026-10-01: test machine **cassis-calc.loria.fr** (Ubuntu 24.04, Dell R630) deployed by the maintainer with
  setup_root.sh + deploy.sh (after fix 95ca633: Ubuntu's own Nix packages were already installed, nixbld GID 995).
  All 4 services + puffin-bench.target active; job scripts contain the compat rules. Board:
  http://cassis-calc.loria.fr:10082/files/index.html. Next: step 6 validation jobs (2f38bf22a, 1957fba63, dcf9ff4e7,
  dev, 2f38bf22a with COMPAT_DISABLE=log_config) — results to be checked against the rules.
- 2026-10-01: first jobs on cassis-calc finished in < 1 s with empty logs: executor.sh is `#!/bin/bash -l` and the
  maintainer's ~/.profile starts with `exec /usr/bin/zsh -l` → fixed by giving the services HOME=<PB_ROOT>/home
  (commit 8635595; setup_root.sh checks a login bash runs commands). Jobs now run.
  Validation jobs relaunched; A/B job (2f38bf22a, COMPAT_DISABLE=log_config) submitted via the API: task 1790843829480.
  Submitting with extra task args (the board has no field for them): curl -X POST http://localhost:10082/api/task/new
  with -F config=@PR_perf_cargo.json -F script=@PR_perf_full.sh -F files[]=@shell.nix -F files[]=@wolfssl_put.c.patch
  -F args[COMMIT_ID]=… -F args[PACKAGE]=tlspuffin -F args[COMPAT_DISABLE]=… -F user=… -F job_type=perf
  (files in /srv/puffin-bench/data/html/jobsscripts/tlspuffin; never put a value starting with '<' in -F).
  Collecting a finished task: /srv/puffin-bench/data/exports/<id>.json + <id>.zip (logs/stdout|stderr.<step>.txt).
- 2026-10-01: PRs opened: puffin-bench #9 (draft), tlspuffin #544. Before merging #9: validation results, remove this file.
- 2026-10-01: several tasks launched together installed their Rust toolchains concurrently into the fresh
  services HOME → 1.94.0 without cargo, nightly-2024-10-03 half installed → Init got an empty LIBAFL_VERSION and
  all builds failed. Repaired on cassis-calc by hand (HOME=/srv/puffin-bench/home nix-shell <shell.nix> --run
  'rustup toolchain install --profile default …'; a broken toolchain dir must first be removed from
  /srv/puffin-bench/home/.rustup/{toolchains,update-hashes}). Fix in the job scripts: commit 068ab80 (Init serializes
  its first cargo call with flock and cancels the task when the LibAFL version cannot be read). NOT yet deployed on
  cassis-calc (needs stop target → deploy.sh → start target, after the running tasks).
  Tasks: 1957fba63 = 1790843764181 (BoringSSL/WolfSSL attempts 1-4 to cancel); relaunched dcf9ff4e7 = 1790844627884;
  dev, 2f38bf22a and 2f38bf22a with COMPAT_DISABLE=log_config being relaunched 5 min apart.
- 2026-10-01: validation tasks on cassis-calc (relaunched after the toolchain repair, LibAFL 0.15.4 readable):
  dcf9ff4e7 = 1790844627884, dev = 1790844927913, 2f38bf22a = 1790845227931,
  2f38bf22a with COMPAT_DISABLE=log_config = 1790845527954; 1957fba63 = 1790843764181 (earlier, still running).
- 2026-10-01: the redeploy of 67bb8c1 (068ab80 included) at 09:16 UTC restarted the scheduler: it killed the running
  validation task 1790843764181 and dropped the 4 queued ones (the scheduler keeps no task across a restart;
  /api/task/<id>/state → "task does not exist", nothing exported). Validation tasks relaunched; never restart the
  services while validation tasks are queued.
- 2026-10-01 10:49 UTC: validation tasks relaunched (job scripts with 068ab80): 1957fba63 = 1790851747037,
  dcf9ff4e7 = 1790851749055, dev 5c588ab11 = 1790851751074, 2f38bf22a = 1790851753092,
  2f38bf22a with COMPAT_DISABLE=log_config = 1790851755113. Report: ~/pb-validation-report.txt on cassis-calc.
- 2026-10-01: validation of 1957fba63 (task 1790851747037): BoringSSL OK; LibreSSL unsupported as planned;
  OpenSSL: all 5 builds failed (mk_vendor `cargo install toml-cli` without --locked → unicode-segmentation 1.13.3
  needs rustc 1.85, toolchain nightly-2024-09-05); WolfSSL: 106 MB of logs per run, 1.1 M ×
  `ERROR [determinism_reseed] Not yet implemented.`. New rules wolfssl_reseed_error [2a0619f4a, a914ff56a) and
  toml_cli_locked [c3a6d8a94, 5586c58b1) (commit 3a238db; patches generalized as COMPAT_PATCH). Self-test 1097 checks.
  To do: deploy after the running validation tasks, re-run 1957fba63. Note: in the export, task args are
  [{key, value}] (validation_report.sh fixed); a step's stdout/stderr are logs/{stdout,stderr}.<g>-<s>-<a>.txt,
  the fuzzer's own output is artefacts/<lib>/<attempt>-tlspuffin.{out,log}.
- 2026-10-01: 1957fba63 WolfSSL attempts 3 and 4 died at startup (ASAN DEADLYSIGNAL SEGV, "nested bug in the
  same thread", same offsets in both): known incompatibility of LLVM < 18 ASAN runtimes (here clang 14) with
  vm.mmap_rnd_bits > 28 (Ubuntu 24.04 kernels use 32). setup_root.sh now sets 28 (/etc/sysctl.d), deploy.sh and
  Init warn otherwise. Objective replay works (ExperimentEnd stdout): attempt 0 → 39 × stack-buffer-overflow in
  RefineSuites (tls13.c), 6 × heap-buffer-overflow in __asan_memcpy, as expected for wolfSSL 5.4.0.
- 2026-10-01: fuzzer launches now go through `setarch <arch> -R` (no ASLR, commit 819818d), recorded as "aslr" in
  cli-<step>.json. Objectives display: branch pr/objectives-report (stacked on this one, commit 74bd55b):
  replay + grouping by ASAN signature at ExperimentEnd, 🐞 button on the dashboard. To deploy on cassis-calc
  with the 1957fba63 re-run (deploy from pr/objectives-report, which contains this branch).
- 2026-10-01 evening: validation report of the 5 tasks. dev clean (logs ≤ 5 MB). A/B 2f38bf22a log_config
  (successful runs only): ×1.28 (BoringSSL) to ×1.43 (OpenSSL) executions with the rule. Still uncovered log
  sources: 2f38bf22a with all rules BoringSSL 95 MB, OpenSSL 154 MB, WolfSSL 261 MB; dcf9ff4e7 LibreSSL 899 MB,
  others 78–121 MB → identify the lines (artefacts/<lib>/<n>-tlspuffin.log of the exports) and add rules.
  dcf9ff4e7 and the A/B task have many early-ended runs (ASLR startup crash / aborts; submitted before setarch).
- 2026-10-02: new session. (a) 1957fba63 OpenSSL: rustup 1.26 has no auto-install for `+stable` → fix 082a8b8.
  (b) 2f38bf22a no summary.json: report read an archive in progress → fix 082a8b8 / c014115. Item 2 analysed from
  the code (see open item 2), numbers requested from the maintainer. Subscribing to PR events failed in this
  environment: #544 is checked by periodic check-ins instead.
- 2026-10-02: maintainer's diagnostics: (a) confirmed (no stable toolchain), hot update, 1957fba63 re-run 1790940562353;
  (b) confirmed (archive in progress), 2f38bf22a with the 3 new log rules: 0 failures. Item 2 measured (see item 2).
- 2026-10-04: results. (1) 1957fba63 re-run 1790948258052: OpenSSL builds and runs 5/5 (toml_cli_locked fixed;
  sources openssl111k fuzz-OpenSSL_1_1_1k@fe549ac3d), all libs 0 restarts, logs ≤ 3 MB, WolfSSL objectives grouped (1
  group) → 🐞 data present. (2) dev paired A/B (6 pairs, ab_report.py): no significant difference for any library
  (ratios with/without rules 0.91-0.99, sign test p ≥ 0.22, |t| < 0.9) → the earlier ×1.21-1.34 on dev was confounded;
  on dev the rules only cut logs. (3) dcf9ff4e7 re-run 1790947254471 with the fixed LibreSSL harness (2f36ce392):
  0 client restarts (28,663 before), but every library still logs 89-126 MB per run (warning) and many runs end
  early (LibreSSL 5/5, BoringSSL 3/5, WolfSSL 2/5): cause being diagnosed (log source not covered by a rule?
  hang-detection kills?). validation_report.sh expected rules of dcf9ff4e7/dev updated (+boringssl_clear_info).
- 2026-10-02 evening: backward-compatibility review. Side-branch (PR) commits inside a declared range whose probe is
  false were CANCELLED by Init (20 of 351 since 47c97cd, e.g. 49d815540) although they ran before → now warned (D8). no_aslr and mandatory flock done (D7, squashed
  into the ASLR and Init commits). objectives_live.sh bug: TaskActive required "success": true, absent from the
  state of a live task, so no live page was ever written since "active tasks only" → fixed (squashed into the
  objectives pages commit). Live page: commit/name from the task state, library version/harness/ASAN, task link;
  scheduler board button via board/custom/header.html (only when live pages exist). cacio-calc and pesto-calc: services run as demengeo (/home/demengeo/puffin-bench,
  /local-unsafe/demengeo/XP/build); deployment to be agreed with demengeo, preferably from main after #9.
- 2026-10-01 evening: uncovered logs at 2f38bf22a identified: C harness "descriptor ... type: ..." at INFO
  (OpenSSL/wolfSSL, DEBUG from e13983d) and the BoringSSL Rust PUT "does not support clearing mode" at INFO.
  Rules openssl_descriptor_info, wolfssl_descriptor_info, boringssl_clear_info (COMPAT_PATCH gets an optional
  line offset: the level is on the line before the message). Self-test 1506 checks. A/B (successful runs):
  ×1.28–1.43; the 8 A/B early ends are hang-detection kills (client 3 silent 5 min), only without log_config.
  To do: dcf9ff4e7 logs (899 MB LibreSSL) are not in <n>-log_root: find where they are.
- 2026-10-05: dcf9ff4e7 diagnostics (maintainer's pastes): early ends = broker panic `KeyNotFound` in
  stats_monitor.rs on the "Broker Heartbeat" (ClientId(0)), 8 dev commits [92251a295, 2f06dfef8). tlspuffin PR #545
  (branch pr/monitor-heartbeat), rule stats_monitor_heartbeat (patch verified to apply and parse on dcf9ff4e7,
  2f38bf22a, 1957fba63; self-test 1644 checks). CompatPrepare's verification is now per line (a line still holding
  the text must contain <to>), as this patch keeps the text. Broker monitor log excluded from the log estimate (D11).
  Next: hot update on cassis-calc and re-run dcf9ff4e7 (expect 20/20 full runs, stats_monitor_heartbeat applied).
- 2026-10-05: scheduler UI (pr/objectives-report): landing page opens on the scheduler board, history opens on All,
  🐞 button on history cards from board/custom/task_links.json (written by objectives_report.sh). Both branches
  squashed again (see "History rewritten again").
- 2026-10-05: "build" recorded per library (BuildDescription: C harness + vendor preset, or Rust harness + features
  with "vendor … not available at this commit"), on the monitor (Build:), dashboard (build: line, harness icon
  tooltip) and objectives pages (derived for old tasks; --all rebuilds pages older than the script). Prompted by
  1957fba63 WolfSSL objectives looking like wolfSSL 5.8.0 bugs: the run used the Rust harness with wolfSSL 5.4.0
  (no wolfssl580 preset at that commit) and the groups are CVE-2022-39173 (RefineSuites) and CVE-2022-42905
  (AddPacketInfo), already flagged as untrusted for wolfssl <= 540 by perf_summary_run.js. Verified on cassis-calc.
- 2026-10-05: dcf9ff4e7 re-run 1791198024452: 20/20 full runs (stats_monitor_heartbeat validated), 0 restarts. Log
  warnings: mostly the broker log's 100 MB rotations ./log<N> counted as logs (fixed, D12); LibreSSL runs 0-1 real
  (reservoir_sample, D13). Security violations (claims) now recognized by ObjectiveSignature ("security-violation",
  grouped by oracle message; replays with RUST_LOG=info).
- 2026-10-05 evening: review (13 comments on #9/#10): 12 fixed and folded into their commits (sign test
  ties, systemctl cat, validation report early ends + COMPAT_DISABLE matching, objectives merge across attempts,
  env for the direct live replay (real bug: replays never ran with a symbolizer), keyboard buttons, vuln fallback
  link, replay timeouts = replay-error, live budget cap, block splitter, legend); handover-file thread left open
  (dropped before merge). Replies' auto-added footers removed by the maintainer. New commit on #10: confirmed vs
  unconfirmed objectives (red / orange 🐞 everywhere, objectives.confirmed). tlspuffin#545: rustfmt fixed
  (d9b09ff44), CI green, waiting for review; #544 green, waiting for review.
