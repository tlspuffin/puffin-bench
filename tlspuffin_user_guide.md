# tlspuffin — User Guide

This guide explains how to use the puffin-bench suite to run tlspuffin fuzzing campaigns, monitor them in real time, and exploit their results. It covers only the tlspuffin-specific job types, scripts, and dashboards — for the generic mechanisms behind each service, see the per-service docs linked throughout and the root [README.md](README.md).

---

## Architecture overview

```
┌─────────────────────┐   submit job    ┌──────────────────────┐
│                     │ ──────────────► │  Scheduler            │
│                     │                 │  :10082               │
│                     │                 └──────────┬────────────┘
│   User / Browser    │                            │ fork/exec
│                     │                 ┌──────────▼──────────┐
│                     │                 │  Nix shell + cargo  │
│                     │                 │  tlspuffin binary   │
│                     │                 └──────────┬──────────┘
│                     │                            │ POST /api/notify
│                     │  browse results ┌──────────▼──────────┐
│                     │ ◄─────────────► │  Publisher           │
│                     │                 │  :10083               │
│                     │                 └──────────┬────────────┘
│                     │  commit history ┌──────────▼──────────┐
│                     │ ◄─────────────► │  Git REST API :10081 │
│                     │                 └─────────────────────┘
│                     │  compare runs   ┌─────────────────────┐
│                     │ ◄─────────────► │  vis_comparator :10084│
└─────────────────────┘                 └─────────────────────┘
```

- **Scheduler** (`scheduler`): receives job submissions, allocates CPU cores, runs job scripts step by step, archives outputs. See [scheduler/docs/api.md](scheduler/docs/api.md).
- **Git REST API** (`git_restapi`): exposes the tlspuffin git history so the launcher UI can list available commits.
- **Publisher** (`publisher`): merges completed campaign summaries into a per-commit, browsable JSON tree.
- **vis_comparator**: overlays and compares metrics across commits/campaigns, reading the publisher's storage directly.

Ports above are the installer's defaults (`--port-git`/`--port-scheduler`/`--port-publisher`/`--port-vis`); see the root [README.md](README.md) for the full service/port table and standalone-build defaults.

---

## Prerequisites on the machine running campaigns

- The scheduler must be running (and reachable from wherever you submit jobs); publisher/git_restapi/vis_comparator are only needed if you want results browsing/history/comparison.
- **Nix** must be installed — the job scripts run inside a Nix shell.
- Enough CPU cores: performance/vulnerability configurations each reserve a fixed core count per attempt (see the retry×timeout table below) — the scheduler's `schedule.executors.local.nbCores` bounds how many attempts run in parallel.

---

## Job types

The following job types are declared in `jobsconfig.json`, served with the rest of the tlspuffin job-launcher UI (installed under `<datapath>/html/board/launchers/tlspuffin/` — see [installer/docs/web-assets.md](installer/docs/web-assets.md)):

| Label in UI | Job type key | Flow JSON | Purpose |
|-------------|--------------|-----------|---------|
| Perf | `perf` | `PR_perf_cargo.json` | Measures exec/s, coverage, corpus over a fixed duration, per library |
| Vuln group A | `vuln-a` | `PR_vulnerabilities-groupA_cargo.json` | Reproduces 5 known WolfSSL CVEs, one per configuration (its `target_bug`); a run stops when it finds that bug (see Vuln below) |
| Vuln group B | `vuln-b` | `PR_vulnerabilities-groupB_cargo.json` | 2 harder-to-trigger CVE repros with a much longer retry budget |
| Vuln — custom | `vuln-custom` | `PR_vulnerabilities-custom_cargo.json` | Template flow — one experiment per known bug ticked in the launcher (see [Custom Vuln benchmarks](#custom-vuln-benchmarks)) |
| Evaluate PR | `evaluate-pr` | *(composite)* | Not a flow of its own — submits `vuln-a` **and** `perf` as two separate tasks and reports on both |
| Campaign | `campaign` | `PR_campaign.json` | Template flow — libraries/timeout/cores/retries are filled in at submission time from the launcher UI's campaign form, not fixed in the file |

All step scripts and flow configs are installed under `<datapath>/html/jobsscripts/tlspuffin/`, tracked in this repo at `installer/data/html/jobsscripts/tlspuffin/`. Full reference: [installer/docs/tlspuffin-job-scripts.md](installer/docs/tlspuffin-job-scripts.md).

**Regenerating the step script** (if you modify `PR_common.sh`, `PR_perf.sh`, or `PR_vulnerabilities.sh` under `installer/scripts/`):
```bash
cd installer/scripts
bash build.sh
# Produces PR_perf_full.sh and PR_vulnerabilities_full.sh, copied by the CMake build
# into installer/data/html/jobsscripts/tlspuffin/ (the `generate_tlspuffin_scripts` target)
```
Rebuild `scheduler`/`installer` (or re-run `installer --force-files`) afterwards to redeploy the updated scripts.

---

## Submitting a campaign

### Via the Board web UI

1. Open `http://<scheduler-host>:10082/files/board/board.html` in a browser.
2. Click the floating **+** button. With only tlspuffin registered, this opens its launcher directly.
3. Pick a commit from the tabbed picker (`main/dev`, `PR`, `branches`, `All`) — PR data can be refreshed on demand (`?refresh=all` hits the GitHub API and consumes its rate limit; `?refresh=local` is free/cached).
4. Pick a job type (see table above); for `campaign`, fill in the extra fields (timeout, vendor/features, per-attempt core/memory limits).
5. Launch. The board streams live stdout/stderr per step (auto-tailed, refreshed every 5s).

### Via curl (API)

```bash
SCRIPTS=installer/data/html/jobsscripts/tlspuffin

curl -X POST http://localhost:10082/api/task/new \
  -F "name=Perf - main" \
  -F "config=@${SCRIPTS}/PR_perf_cargo.json" \
  -F "script=@${SCRIPTS}/PR_perf_full.sh" \
  -F "files[]=@${SCRIPTS}/shell.nix" \
  -F "files[]=@${SCRIPTS}/wolfssl_put.c.patch" \
  -F "args[COMMIT_ID]=main" \
  -F "user=alice" \
  -F "job_type=perf"
```

`config` and `script` are required; `files[]`/`args[KEY]`/`runtime[RUNTIME_KEY]` are repeatable and optional (note the `runtime[]` field name must include the `RUNTIME_` prefix inside the brackets, e.g. `runtime[RUNTIME_TIMEOUT]`); `user`/`job_type` default to `"anonymous"`/`"unknown"` if omitted. The response contains the task ID **as a string**:
```json
{ "success": true, "task_id": "1713240000000" }
```
Full endpoint reference: [scheduler/docs/api.md](scheduler/docs/api.md).

### Key parameters

| Parameter | Where | Description |
|-----------|-------|--------------|
| `COMMIT_ID` | `args[COMMIT_ID]` | Git commit hash or branch name to test. |
| `features` | flow JSON, per configuration | Cargo feature flags built into the binary (e.g. `asan,wolfssl540`). |
| `vendor` | flow JSON, per configuration | Vendor preset in format `library:version` (e.g. `wolfssl:wolfssl580-asan`). |
| `experiment` | flow JSON, per configuration | Experiment name passed to `tlspuffin experiment`. |
| `required_features` | flow JSON, per configuration | Extra cargo feature the `Experiment*` step requires present (e.g. `introspection`, used by every `PR_perf_cargo.json` entry). |
| `SMT_MODE` | `args[SMT_MODE]` (launcher: **CPU sharing**) | How the scheduler chooses the CPUs of each run, see below; the machine's default (`smt` of the executor, `pairs`) when absent. Perf fixes its own. |

### CPU sharing (hardware threads)

The machines have two hardware threads per physical core (SMT). A fuzzer client runs slower when the other thread of
its physical core is busy: measured on cassis, wolfSSL clients made ~22 % fewer execs/s with a busy twin thread, and
before 2026-10-09 the scheduler gave logical CPUs without regard to it (on cacio, 80 % of the fuzzing time ran on a
physical core shared with another run). Each run now gets:

- **default (`pairs`)**: whole physical cores, all their threads to the run, on one NUMA node when possible. Its
  clients share cores only with each other, the same way in every run: results are comparable between runs and tasks.
  A run of 3 CPUs takes 2 physical cores (4 CPUs, one idle).
- **one client per physical core (`one`)**: each client alone on its core, the other threads reserved and idle.
  Faster per client (0–30 % depending on the library) and closest to a machine running nothing else, but twice the CPUs:
  fewer runs at once. For absolute figures (e.g. a paper).
- **logical CPUs (`any`)**: as before, two runs may share a physical core; to reproduce older conditions.

**Perf: twin**, fixed by the Perf job (the choice at launch does not apply to its runs):

- each library is built once; then each step holds the two threads of one physical core and runs two one-client runs
  of that build, one per thread (runs 2k and 2k+1 of step k): 20 runs of each library on 10 physical cores, each next
  to another run of the same build;
- why: a run varies by about 12 % from its fuzzing path alone, so more runs on the same cores make a change visible.
  Measured in 2026-11 on cassis, cacio and pesto, the smallest change Results sees between two tasks is 6–15 % per
  library and about 6 % for all libraries at once, against 15–41 % per library before (5 runs of 3 clients on 2
  physical cores);
- the price: a one-client run does a quarter of the work of a 4-client run in the same time and shares no corpus: at
  70 minutes it reaches 0.5–2.6 % less coverage (the same at equal work);
- its runs record the CPU sharing `twin` and Perf's major version 2: Results marks the Perf results of the earlier
  runs (major version 1) as not comparable; a commit run again is measured the new way.

The CPUs of the runs are also kept from the other processes of the machine (users, services, Docker containers),
when the scheduler's sudo rules allow it (see the scheduler's configuration). Each run records its CPUs, the mode,
its NUMA nodes and whether a thread of its cores was outside it (`cli.cpus`); Results marks two runs compared with a
different mode or sharing as ⚠ not comparable. Runs in different modes are not comparable for speed (execs,
time to find). The noise floors of Results were measured before this and are to be measured again (Perf: from its twin
runs, under major version 2).

---

## Flow of a campaign

```
Init
 └─ Clone tlspuffin at COMMIT_ID, https-ify submodules, update them
 └─ Init/patch nix-shell (faketime for commits ≤ 8b29ce76d, WolfSSL timeout patch if needed)
 └─ Detect LibAFL version (sets AFL_CORES_GRAMMAR for cores > 0.15.3)
 └─ Evaluate the compat rules (fuzzer flags, reference client_log_config.yml, log levels and build fixes
    patched in the sources), see "Compat Rules" in tlspuffin/docs/tlspuffin-job-scripts.md

[parallel branch per library/configuration]
 ForcedBuild
  └─ cargo build --release --features=… inside nix-shell, fresh checkout, no cache
  └─ seed + help once, to warm/validate the binary
  (Perf: BuildOnce, one ForcedBuild per library before its runs; then TwinExperiment and TwinExperimentEnd, two
   runs per step in its folders twin0 and twin1, each as below; then, once every run of every library ended,
   PerfObjectives: the replays and the validation of their objectives, so that nothing heavy runs while runs measure)

 Experiment / ExperimentWithCargo   (monitored — see below)
  └─ reserve a loopback TCP port (embedded reserve_port tool)
  └─ launch the fuzzer in the background
  └─ archive README.md, stats.json(.1), logs, objective/ as they appear

 ExperimentEnd
  └─ release the port, read task state from the API, run the QuickJS post-processor
     → summary-<step>-<attempt>.json

SummaryRun
 └─ aggregate every library's per-attempt summaries into one summary.json

CleanAllRepo
 └─ ipcrm --all (SysV IPC left by a killed AFL/LibAFL process)
```

### Perf vs Vuln termination

- **Perf**: the fuzzer runs for the full `timeout` — reaching it without dying counts as `success`; dying earlier (crash, hang-kill) counts as `fail`. Default `70m` in `PR_perf_cargo.json`, 10 twin steps of 2 runs per library (see CPU sharing).
- **Vuln**: a VulnA run stops when the fuzzer records the **expected bug** of its configuration (declared in `vuln_targets.json`, see [Expected bugs](#expected-bugs-and-new-bugs)); other objectives are kept, and the known CVE-2024-5814 is set apart on wolfSSL < 5.7.2 (it never ends a run there; elsewhere its claim is a bug). A configuration without declared target (VulnB) stops at its first objective that is not set apart. Each configuration of group A and B also names its bug of tlspuffin's catalogue (`target_bug`): on a commit with the catalogue (tlspuffin `pr/vuln-catalogue` on), the objective that would end the run ends it only once validation recognises it as that bug (replayed on the builds of the configuration's validation set: by patch differential, else by its signature on the build with every patch), and its time to find is when the fuzzer saved it; an objective not recognised lets the run go on. When validation cannot decide (a commit without the catalogue, a bug whose objectives do not replay such as CDOS), the fuzzer's record decides, as before. Results flags the change of monitor (⚠ not comparable: "run ends on targeted → confirmed find"). A run is `success` only if the task reached `Done` **and** the expected bug (any objective without target) was found — a plain timeout is `fail`. Default `190m`/5 retries (group A) or up to `2890m` (~48h)/90 retries (group B).

---

## Monitoring a running campaign

### Board dashboard

Open `http://<scheduler-host>:10082/files/board/board.html` — the board shows all running and completed tasks with per-step status, refreshed on load, on manual refresh, and after a cancel action.

### Hang detection

Two independent mechanisms run once a minute while a perf experiment is monitored:
- **Immediate kill**: if the global `stats.json` timestamp hasn't advanced by more than 300s, or `"Timeout in fuzz run"` shows up in `error.log`, the process is killed on that same round.
- **5-consecutive-round kill**: if one specific fuzzer client stops appearing in the newly-appended `stats.json` bytes for 5 consecutive rounds (~5 minutes), the process is killed even though other clients are still reporting.

Set `DISABLE_KILL_ON_HANG=1` in the flow's `args` to disable both and rely only on the step's own `timeout`.

### Reading step logs

From the board, click a step card to open the live-tail terminal view: STDOUT, STDERR and **COMMANDS**, every command
the step ran, for every type of task. COMMANDS starts with the variables of the step (its environment and the settings
of its job; a variable named like a secret is shown `<hidden>`), then one line per command: its time, its function and
line, `$` and the command as it ran (variables expanded), indented per nested level (a command substitution, the
monitor's own bash). Assignments and `export`s are commands too: what set a variable is in the list. "hide shell
internals" hides tests, `echo`, `read`, local variables and the like; `export`, `source`, `exec` and every program stay.
A program started by a command does not trace its own commands (e.g. the setup of a `nix-shell`): its command line, with
the commands given to it (`--run "…"`), is the line. The file is `logs/commands.<step>.txt` of the task, archived with
stdout and stderr; steps that ran before 2026-10-12 have none (the tab is grey). Via API:
```bash
curl "http://localhost:10082/api/task/<taskID>/<stepUUID>/<stepID>/output/stdout/65536/0"
# also output/stderr/… and output/commands/…
# Response: {"success":true,"data":"<base64 chunk>", "partial":..., "live":..., ...}
```
See [scheduler/docs/api.md](scheduler/docs/api.md) for the full response shape and offset/seek semantics.

### Cancelling a task

```bash
# Cancel entire task
curl -X DELETE http://localhost:10082/api/task/<taskID>

# Cancel one step only
curl -X DELETE http://localhost:10082/api/task/<taskID>/step/<stepUUID>
```

---

## Artefacts produced

Each experiment attempt registers the following artefacts (downloadable as one archive via `GET /api/task/<taskID>/artefacts`, or browsable per-project once merged by the publisher):

| Artefact | Content |
|----------|---------|
| `README.md` | Fuzzer experiment metadata (commit, PUT, port, date) |
| `stats.json`(`.1`) | LibAFL statistics stream (back-to-back JSON objects, no newlines) |
| logs | Fuzzer stdout/stderr/error.log |
| `objective/` | Objective traces (`.trace` files) — non-empty means a vulnerability was triggered |
| `summary.json` | One file per task, aggregating every library's per-attempt records (produced by `SummaryRun`) |

### Reading `summary.json`

Both perf and vuln share the same per-attempt record shape (`{id, state, nb_objective_on_disk, global, clients, others}`, one `t0`/`tEnd` snapshot pair per global/per-client reporter), aggregated per library:

```json
{
  "version": 1,
  "type": "perf",
  "commit_id": "abc1234",
  "timestamp": 1713240000,
  "flag_objective": false,
  "libraries": {
    "OpenSSL": {
      "name": "OpenSSL",
      "cli": { "library": { "name": "openssl", "version": "340" } },
      "trust_objective": 1,
      "flag_objective": false,
      "data": [
        {
          "id": 0,
          "state": "success",
          "nb_objective_on_disk": 0,
          "global": [ { "id": 0, "t0": { "...": "..." }, "tEnd": { "...": "..." } } ],
          "clients": [ { "id": 1, "t0": { "...": "..." }, "tEnd": { "...": "..." } } ],
          "others": []
        }
      ]
    }
  }
}
```

`trust_objective` is `-1` for `wolfssl` builds at version ≤ 540 (a known-unreliable-crash-detection cutoff) — an objective found there doesn't set `flag_objective`. This is the file the publisher's `.rules` pick up (see below); full field-by-field reference: [installer/docs/tlspuffin-job-scripts.md](installer/docs/tlspuffin-job-scripts.md).

---

## Accessing results in the publisher

Once the scheduler notifies the publisher (`POST /api/notify`), the tlspuffin project's `.rules` (`GenerateMergeJSON` action) merges each `summary.json` into a persistent per-commit file under `.project/` — e.g. `Perf/<commit>.json`, `Vuln/<commit>.json`.

Browse the dashboard at `http://<publisher-host>:10083/files/tlspuffin` (served index: `summary.html`), or fetch the merged files directly:
```bash
curl http://localhost:10083/api/project/tlspuffin/data
curl http://localhost:10083/files/tlspuffin/.project/Perf/abc1234.json
```
Full reference: [publisher/docs/user_guide.md](publisher/docs/user_guide.md), and [installer/docs/web-assets.md](installer/docs/web-assets.md) for how the tlspuffin dashboard JS consumes these files (data extraction schema, graphing, campaigns tab).

---

## Comparing runs in vis_comparator

From a result card on the publisher dashboard, the **📈 Compare** button deep-links into vis_comparator with the commit/library preselected:
```
http://<host>:10084/files/tlspuffin/index.html?template=TwoTasksTemplate_2C1S&c1=<commit>&c2=@dev-base&c2.alias=Dev&s1=Perf%3A<library>
```
vis_comparator reads the publisher's storage tree directly and proxies git_restapi for commit metadata — no separate campaign/PR-specific setup needed beyond the config in the root [README.md](README.md#vis_comparator-vis_comparator-configjson).

---

## Build cache

The scheduler's generic cache endpoints (`GET`/`PUT /api/cache/<id>`, see [scheduler/docs/step-script-reference.md](scheduler/docs/step-script-reference.md)) back the `QueryCache`/`SetCache` shell helpers used by the `Build` step (not `ForcedBuild`, which every current flow uses instead and never queries the cache). Cache key: `md5(PACKAGE-COMMIT_ID-features-vendor)`. `COMMIT_ID == "main"` is never treated as cacheable, since it moves.

---

## Vulnerability configurations (group A)

`PR_vulnerabilities-groupA_cargo.json` tests five known WolfSSL vulnerabilities in parallel, 5 retries × 190-minute timeout each. The expected bug of each preset (the CVE left in it, and how the fuzzer records it) is declared in `vuln_targets.json`:

| Config | Vendor preset | Expected CVE | Recognised by |
|--------|----------------|-----|-----|
| BUF | `wolfssl:wolfssl540-buf` | CVE-2022-39173 | crash in `RefineSuites` |
| CDOS | `wolfssl:wolfssl530-cdos` | CVE-2022-38153 | crash in `AddSessionToCache` |
| HEAP | `wolfssl:wolfssl540-heap` (+asan) | CVE-2022-42905 | crash in `AddPacketInfo` |
| SDOS2 | `wolfssl:wolfssl540-sdos2` | CVE-2022-38152 | crash in `DoTls13ClientHello` |
| SKIP | `wolfssl:wolfssl510-skip` | CVE-2022-25640 | claim `Authentication bypass` |

## Vulnerability configurations (group B)

`PR_vulnerabilities-groupB_cargo.json` tests two harder-to-trigger cases in parallel, 90 retries × 2890-minute (~48h) timeout each — a long, patient search rather than a broad sweep:

| Config | Vendor preset | Target |
|--------|----------------|--------|
| SDOS1 | `openssl:openssl111j` | OpenSSL 111j |
| SIG | `wolfssl:wolfssl510-sig` | CVE-2022-25640 + CVE-2022-39173 |

No target is declared for group B: a run ends at its first objective that is not set apart.

## Words of the pages

Every page of the bench says what a task found, and how the bench knows, with the same words: the objectives pages, the
🐞 panel of Results, the Bugs reference (its last section repeats this one), the 🐞 of the scheduler's History, and the
help panels. They come from one module, `tlspuffin/data/html/common/verdicts.js`; the decisions (which verdict, which
level) from the validation of the job scripts (`PR_validate.sh`) and from the pages' `objectives_page/bugs.js`
(`AnalyseReport`: the same for the objectives page, Results and History). This section is generated from the module
(`qjs --std -m tlspuffin/scripts/tools/words_markdown.js`); `words_doc_test.sh` fails when they differ.

Two replays tell different things: an objective is **reproduced** by a replay on the build of its own run (the pages
replay every objective, up to 100 a run); it is **validated** by replays on the validation builds, which name the bug.
"Confirmed" is said only of patch differential. A bug's **signature** is what the catalogue recognises it by, shown
with its content ("a crash with an ASan SEGV report", "the claim “Authentication bypass”"); for a crash, its **place**
(the first 3 frames of its witness's stack) makes the signature **strong** (green) when the stack has it, else it is
**weak** (yellow). How a find is named after a known bug, step by step, and why: [Known bugs: how a find is
validated](#known-bugs-how-a-find-is-validated).

<!-- words:begin -->
| term | meaning |
|---|---|
| **objective** | an input the fuzzer saved because its oracle fired: a crash (with an ASan report when the build has ASan), a violated claim of the protocol, a panic |
| **bug** | the objectives with the same failure: the same ASan report type and top stack frames, or the same violated claim |
| **reproduced** | a replay of the objective, on the build of its own run, gave that failure again (else: not reproduced, or a replay error when the replay could not run) |
| **fuzzer only** | the fuzzer's own log recorded the failure when it saved the objective, but no replay reproduces it (the fuzzer runs every input in one process: state, memory layout) |
| **signature** | how tlspuffin's catalogue recognises a known bug (its oracle): a crash with a given ASan report type or signal, a violated claim with its message, a panic with its message; for a crash, also its place: the first frames of the stack of its witness, else its top frames in the catalogue |
| **strong signature** | a crash with the bug's ASan report type whose stack has the bug's own place: its first 3 frames, outside the sanitizer runtime, libc and the fuzzer, are those of the bug's witness (validation runs it, symbolized), else its top frames in the catalogue, in order: as well as a signature can tell (only a patch is certain); green |
| **weak signature** | a signature without stack: a claim or a panic (one message, which several bugs can share: Authentication bypass is CVE-2021-3336's, SIG's and SKIP's), or a crash told by its ASan report type or signal alone (neither top frames in the catalogue nor a witness's stack, or a stack without them): it names a bug without telling it apart from another failure of the same kind; yellow |
| **validated** | the objective was replayed on the validation builds (F: every known bug with a patch patched; V_X: F without the patch of X) and got a verdict |
| **confirmed** | by patch differential only: the objective goes away with the patch of X and gives the signature of X without it; certain |
| **known bug** | a bug of tlspuffin's catalogue (a CVE, an alias such as BUF), active at the version tested |
| **expected** | for a configuration: its target (Vuln jobs), and the known bugs tlspuffin declares for the version it built |
| **unexpected** | objectives in a configuration where no known bug is expected (no bug declared for its version), or a bug that is neither its target nor a known bug declared for it |
| **recognised** | a find without validation verdict (an older task, whose tlspuffin had no catalogue: then the latest catalogue; or objectives not validated) whose crash has the ASan report type and the place of a known bug in what its run built (its declared bugs, else the version it built): named after it, "≈ X · by its signature with its stack · not validated"; known, not proven (validation by patch would confirm it) |
| **new bug** | a bug no one knows: on the build with every patch, the signature of no known bug; or, without validation, a signature no earlier task had and no known bug of its version |

The verdicts of the validation, per objective, strongest first (a bug's verdict is its strongest part):

| badge | meaning |
|---|---|
| ✔ **confirmed by patch** | the patch of this bug removes the objective, and without it the objective gives its signature: it is this bug (certain) |
| ≈ **by its signature** | on the build with every patch, the objective gives the signature of a known bug without patch at this version: one of them; strong (green) when its stack has that bug's place (the first frames of its witness's stack, else its top frames in the catalogue), weak (yellow) otherwise: a claim, a panic, a crash told by its type alone or elsewhere (a patch would make it certain) |
| ⚠ **signature of a bug its patch does not remove** | the objective stays on the build with every patch: not this bug, or its patch is incomplete; to review |
| 🚨 **no known bug's signature** | the objective stays on the build with every patch, with the signature of no bug of the catalogue: a new bug, or one missing from the catalogue |
| ⚠ **another signature** | the patch of the bug(s) named removes the objective, but without it the objective does not give their signature: to review, never counted as them |
| ⛔ **could not replay** | a validation build could not run the objective (its command line refused, it crashed before the trace, it timed out): no verdict, never read as "not reproduced" |
| ◌ **does not replay, as known** | the catalogue says the objectives of this bug do not replay on their own (they need the state of the fuzzer, replayable = false): not reproducing them on the validation builds is expected, nothing to worry about; the fuzzer's record of the crash is the evidence |
| ? **not reproduced on the validation builds** | the replays ran, without the failure: it needs the state of the fuzzer, another layout, or two bugs at once |
| … **not validated** | the validation's time budget was spent before this objective |
| ○ **no verdict** | this objective has no validation verdict (why: on the badge) |

Why an objective has no verdict:

- not validated yet (the run is going on)
- no validation result for its run (its validation step failed or did not run)
- the validation of its run failed
- not among the objectives validated in its run (at most 20 a run, the first of each bug first)
- not validated at this commit (the reason follows: its tlspuffin has no catalogue, or dev, whose catalogue validation trusts, has none yet); its crashes are still recognised by their stack against the latest catalogue

What a bug is for its task:

| tag | meaning |
|---|---|
| 🎯 **expected** | the bug this configuration is meant to find (its target) |
| ⦸ **set apart** | a known CVE of old library versions that is never a target: in a run that looks for a target (a Vuln job, or a configuration with a target), it does not end the run and is named after its CVE |
| 📋 **known** | a CVE tlspuffin declares for what this configuration built, whose signature the bug has: not a new bug |
| ⚠ **unexpected** | neither the target of its configuration nor a known bug declared for it |
| 🚨 **NEW BUG** | a bug no one knows (see "new bug") |

The level of a task: the title of its objectives page, the colour of its 🐞 on the scheduler's History, of its objectives on the board (its card, attempts and button) and of the top bar's live pill (red with 🚨 for a new bug, gold unexpected, plain otherwise):

| level | meaning |
|---|---|
| 🚨 **new bug** | a bug no one knows: the signature of no known bug |
| ⚡ **unexpected** | objectives where no known bug is expected (none declared for the version tested), or bugs other than those expected there |
| **known bugs** | every bug found is expected there: a target, or a known bug of the version tested |
| **nothing reproduced** | objectives, but no replay reproduced a bug and the fuzzer recorded none |
<!-- words:end -->

## Expected bugs and new bugs

- **The file to edit**: `tlspuffin/data/html/jobsscripts/tlspuffin/vuln_targets.json` — the expected bug of each VulnA preset (`cve`, `kind`: `crash` with its `place`, the first 3 frames of its witness's stack, which the fuzzer's backtrace or the replay's stack must have, in order, as everywhere else ([The place of a bug](#the-place-of-a-bug-rule-r3)), or `claim` with the violation message `match`; `note`: where the rule comes from) and, under `_not_targeted`, the claims of known CVEs that are never a target, each with its scope (CVE-2024-5814: set apart only on wolfSSL < 5.7.2, which all have it; on any other library or version the claim is a bug like any other), set apart where a run looks for a target, as the job scripts do: a Vuln job, or any configuration with a target (a Vuln flow launched as a live test included; in Perf and campaigns, without target, the claim is one of the CVEs its build declares, 📋 known); under `_cves`, the reference table of the CVEs of the Vuln jobs (alias, CVSS, type, version, TLS), with an optional signature (`kind`, `match`) for a CVE no target names and `replayable: false` for a bug whose objectives do not replay on their own (CDOS: its crash depends on the fuzzer's session cache), which every report of every commit then shows as "◌ does not replay, as known" (Results, the objectives pages, History), also the reports of commits without tlspuffin's catalogue. `scripts/build.sh` writes both into the job scripts (`PR_targets.sh`); new tasks and the objectives reports written afterwards use them.
- **To read it**: the **🎯 Bugs reference** page, `http://<host>:10083/html/publisher/bugs.html` (linked from the help of Results, from every objectives report and from the guide of the bench): the targets, the CVEs set apart, and the bugs found so far per library.
- **On the pages**: 🎯 expected (VulnA: `🎯 k/n` on Results and on the objectives report, the same count: runs that found it; `· k untimed`: those of them that did not succeed, e.g. ended by their timeout or without end-of-run summary: counted, but without a time to find in the statistics (which come from the end-of-run summaries), why on click of the row's status icon and listed on the report; green every run, amber every configuration but not every run, red a configuration in no run; the report's banner, the 🎯 pill of the task on the scheduler's history page and the Runs page give the conclusion with the same counts (one verdict, `bugs.js`, written into the report; `check_verdicts.py` checks them all after each cron pass); a task whose job scripts had no target (before 2026-10-07) is marked "before targets": its runs succeeded on any objective; a faint `· no replay` when no replay reproduced it in some runs, the fuzzer's log being the evidence; the failed-runs row of Results lists the runs without end-of-run summary), ⦸ set apart, ⚠ unexpected (another bug of a configuration with a target), 📋 known (a CVE tlspuffin declares for the build of a plain version), 🚨 **new bug**.
- **New bugs**: `scripts/tools/known_bugs.js` (run by `objectives_report.sh --all`) rebuilds `/html/objectives/known_bugs.json` from every final objectives report, oldest first: `<library>|<signature>` → the first task with it, the signature being the claim or the top function of the crash. A real bug (fuzzer record or replay), neither expected nor set apart, is marked 🚨 NEW BUG on its report and 🚨🚨🚨 on Results:
  - in a configuration with an expected bug (an alias: BUF, SKIP…), when no earlier task had its signature in that configuration, whatever the job (VulnA, VulnB, Perf, campaigns);
  - in a plain version (e.g. Perf's wolfSSL 5.8.0, a campaign on wolfssl540), when it is none of the CVEs tlspuffin declares for that build — the build's `vendorinfo.sh` (puffin-build): known vulnerabilities of the version (the library's `builder.cmake`) minus those the preset fixes, recorded by `ForcedBuild` as `cli.vulnerabilities` — whose signature `vuln_targets.json` gives (a CVE's own `kind` and `place` or `match` in `_cves`, else its target's, else its claim in `_not_targeted`; `objectives_page/cve_signatures.jq`). Such a bug is shown as 📋 known · CVE; any other is new on every task until it is added to the file. A run without declaration (built before puffin-build, Rust harness, job scripts before 2026-10-09): next item.
  - in a plain version whose build declared no CVEs: when it is none of the CVEs of the library it built in the CVE table of `vuln_targets.json` (`_cves`: `library` and signature) and no earlier task had its signature in that configuration. A bug recognised this way is marked **📋 known (inferred)**.
- **Validation first** ([Known bugs: how a find is validated](#known-bugs-how-a-find-is-validated)): a bug validation names by patch, or by a signature that is not weak, is known, and so is a find without verdict recognised by its stack (an older task: against the latest catalogue); one whose objectives stay on the build with every patch with the signature of no known bug is 🚨 new in each of its configurations; a weak signature decides nothing (the rules above do).
- **The level of a task** (`bugs.js BugsHeadline`, written into the report by `report_verdicts.js`, see [Words of the pages](#words-of-the-pages)): **🚨 new bug** when a bug is new; **⚡ unexpected** when objectives come from a configuration where no known bug is expected (no target and its build declares no known bug) or, but in a Vuln job, when a real bug is not expected there; **known bugs** when every bug found is expected given the tested version (🎯 expected, 📋 known, or named by validation); **nothing reproduced** otherwise. The title of a report says **N known bugs found** for known, **⚡ N bugs found** for unexpected (or **⚡ objectives where no known bug is expected (…)**), with **🚨 N NEW BUG(S)** before it for new. The history page of the scheduler colours the task's 🐞 by that level: **red, 🚨 and the row highlighted** for a new bug (with the report's title on the button), **gold** for unexpected, **plain** for known bugs (outlined when nothing was reproduced); the board does the same for a running task once its live report has a level (its attempts, the steps' squares and its `🐞 N objectives` button: no colour before, the monitor only counts objectives), and so does the pill of the top bar (only the running tasks whose level is new, red, or unexpected, yellow); a custom benchmark's experiments have their 🎯 like Vuln group A (their target: the catalogue's bug they name, recognised by validation).

## Known bugs: how a find is validated

### In short

tlspuffin's vulnerability catalogue (`puffin-build/vendors/<vendor>/vulnerabilities.toml` in tlspuffin, listed on the
**Bugs reference** page) gives each known bug its affected versions, a patch per version range when there is one, its
**signature** (the catalogue's oracle: a crash with a given ASan report type or signal, a claim of the security oracle
with its message, a panic) and a **witness** (a trace that triggers it). A find (an objective of a run) is named after a
known bug X in one of four ways, from the most certain to the least:

| how | what is checked | badge | worth |
|---|---|---|---|
| 1. **patch differential** | the objective goes away on F (the library with every known bug's patch), and on V_X (every patch but X's) it fails again, with X's signature | ✔ X · confirmed by patch (green) | certain: it is X |
| 2. **strong signature** | X has no patch at this version; on F the objective still fails, with X's signature, **and its stack has X's place** (below) | ≈ X · by its signature with its stack (green) | as well as a signature can tell; X is known |
| 3. **weak signature** | the same, without stack to compare: a claim or a panic (one message, several bugs can share it), a crash of X's type whose stack lacks X's place, or a bug with no known place | ≈ X · by its signature · weak (yellow, dashed) | a candidate only: never makes a bug known on its own |
| 4. **recognised, not validated** | no validation verdict (an older task, or objectives not validated): X is in what the run built (below), and the crash has X's ASan report type and X's place, in the latest catalogue | ≈ X · by its signature with its stack · not validated (green) | X is known, not proven: a validation by patch would confirm it |

Anything else is said as such: ⚠ to review (X's patch removes the objective but X's signature does not show without it;
or the claim of a bug whose patch does not remove it), 🚨 no known bug's signature (a new bug, or one missing from the
catalogue), ⛔ could not replay (a validation build could not run it), ? not reproduced on the validation builds, ◌ does
not replay, as known (CDOS: its objectives need the fuzzer's state, `replayable = false`), ○ no verdict (with why). A
bug's verdict on the pages is its strongest part; the words and badges are in [Words of the pages](#words-of-the-pages).

### Step by step

1. **Which catalogue.** dev's (its `vulnerabilities.toml` files and the patches they name, over the run's own checkout),
   else the commit's (`VALIDATION_CATALOGUE=commit`, or a custom benchmark launched with the commit's catalogue). While
   dev has no catalogue, a run validated against dev's gets no verdict ("not validated at this commit").
2. **The validation builds** (`ValidateObjectives`, after each run; Perf: after all its runs, in `PerfObjectives`):
   the run's library at the run's commit, with ASan, once with every patch (F) and once per patched bug X with all but
   X's patch (V_X). They are made once: the libraries of a set in a folder shared by the tasks
   (`data/validation-libs/`, named after what they are made from; a folder unused for 30 days goes), the binary in the
   scheduler's cache per the sources it is built from.
3. **The controls.** Each X's witness runs first on V_X (it must fail with X's signature) and on F (it must not): when it
   does not behave, the verdicts say "controls failed". The executions are symbolized (`llvm-symbolizer` of the tree), so
   the stack of each witness is recorded with the validation (`witness_frames`); the witness of a crash bug without
   patch runs once on F for its stack. That stack gives the bug's place (below).
4. **The objectives.** A run's first 20 objectives are replayed on F and the V_X: the targeted ones, then one of each
   bug (by the fuzzer's record), then by time, within 30 min of executions (the rest: "… not validated").
5. **The verdict of each objective**, from those replays:
   - gone on F, back on V_X with X's signature: ✔ confirmed X;
   - still there on F: with the signature of a bug without patch at this version, ≈ by its signature (then weighed by
     its stack, step 6); with the claim or panic of a bug that has a patch here, ⚠ (its patch does not remove it); with
     no known bug's signature, 🚨;
   - gone on F, back on V_X without X's signature: ⚠ another signature, never counted as X;
   - no outcome from a build (its command line refused, a crash before the trace, a timeout): ⛔ could not replay, with
     what failed (never read as "not reproduced"; an in-run confirmation then leaves the find to the fuzzer's record);
   - the replays ran without the failure: ? not reproduced on the validation builds (◌ for a bug known not to replay).
6. **Strong or weak**: validation compares the signature (oracle) only; the pages then compare the objective's stack
   (its replay's, else the fuzzer's record) with the bug's place: strong when it has it, weak otherwise.
7. **The level of the task** follows (new, unexpected, known, unclear: [Expected bugs and new bugs](#expected-bugs-and-new-bugs)):
   a bug named by patch or by a strong signature (also recognised, not validated) is known, never 🚨 new.

Each validation file records the bench that made it (`bench`: the deployed version and the commit of the job scripts),
shown below the tiles of the objectives page and on the validation line of Results; a run with objectives and no
validation file is an error of its configuration ("no validation result"), and its objectives show "no verdict" with
why. An experiment that names its bug (custom benchmarks, Vuln group A and B) prepares its validation in a step before
it (`PrepareValidation`), so that the run ends on a find only once validation recognises it; during the run, a bug
without patch is recognised by its oracle alone (weak).

### The place of a bug (rule R3)

A bug's **place** is what its crashes are recognised by: **the first 3 frames of its witness's stack**, leaving out the
sanitizer runtime (`__asan_*`, interceptors), libc's memory and string functions with glibc's variants
(`__memmove_avx_unaligned_erms`…) and the fuzzer's own code; when no validation recorded its witness's stack, its top
frames in the catalogue. A crash has the place when its first frames, filtered the same way, are those, in the same
order (the reports keep 3 frames of a stack, of which glibc can take one: then 2 are compared, never fewer unless the
place is a single frame). The places of wolfSSL's crash bugs as they stood on 2026-11-12 (the Bugs reference shows
each bug's current place, in bold, computed by the same code):

| bug | its place | from |
|---|---|---|
| SDOS2 (CVE-2022-38152, SEGV) | DoTls13ClientHello < DoTls13HandShakeMsgType < DoTls13HandShakeMsg | its witness's stack |
| CDOS (CVE-2022-38153, bad-free) | wolfSSL_Free < AddSessionToCache < AddSession | its witness's stack |
| HEAP (CVE-2022-42905, heap-buffer-overflow) | AddPacketInfo < DoTls13HandShakeMsgType < DoTls13HandShakeMsg | its witness's stack |
| BUF (CVE-2022-39173, stack-buffer-overflow) | RefineSuites < CheckPreSharedKeys < DoTls13ClientHello | its witness's stack |
| CALLB (CVE-2023-6936, heap-buffer-overflow) | AddPacketInfo < DoTls13HandShakeMsgType | the catalogue's top frames (no witness): HEAP's place too, so a crash there is named after both; only their patches tell them apart |
| SDOS1 (CVE-2021-3449, OpenSSL, SEGV) | none known | neither top frames nor a recorded witness's stack: its signature is weak |

Why 3 frames, in order (chosen 2026-11-12 from the 2302 crashes of 132 runs on cassis, their stacks read from the runs'
logs): the former rule looked for the place anywhere among a crash's first 3 frames, so 564 BUF
crashes of builds without ASan (a SIGSEGV in `RefineSuites`, called by `DoTls13ClientHello`) were taken for SDOS2, whose
place was `DoTls13ClientHello`. With the first 2 or 3 frames in order, every crash of SDOS2, CDOS, BUF and HEAP is
recognised and none is taken for another; 3 is the stricter. Line numbers are not compared: they move between builds of
the same code.

One rule, one definition, `tlspuffin/data/html/common/signatures.js`, for every page, tool and job script:
- what the Bugs reference shows of a bug (the place in bold in its witness's stack, else the catalogue's top frames,
  said so) and what its "bugs found so far" recognise a crash by;
- what the objectives pages show in a bug's column and on the hover of its name, and what they, Results and History
  compare a crash with: the strength of a signature verdict, a find recognised without validation, the 🎯 of Vuln group
  A's targets and the 📋 known CVEs (the targets' `place` in `vuln_targets.json`, the first 3 frames of their witnesses'
  stacks);
- what the job scripts end a Vuln group A run on and count as its target (`PR_common.sh TargetMatches`, which asks the
  module through `tools/js/has_place.js` and the bench's qjs: no copy of the rule in shell).

`signatures_test.sh` fails when a page or the job scripts keep a rule of their own (the former "a frame among the first
3" included), when a page shows the catalogue's top frames as a place without the module, or when a place of
`vuln_targets.json` is not its witness's first 3 frames (on the witnesses' stacks of cassis, and on those the bench
recorded when readable). Changing the rule (its depth, the frames left out) is done in `signatures.js` only.

### Older tasks and finds without verdict

A task whose tlspuffin had no catalogue (before tlspuffin's catalogue, #563) has no validation. Its page is read against
the **latest catalogue** (dev's, else that of the newest open pull request of tlspuffin that has one, as the Bugs
reference shows), every time it is made: a crash with the ASan report type and the place of a known bug that is in
what its run built is **recognised** as it (case 4 above: green, known, never 🚨 new). In what its run built: among the
bugs its build declared, when it declared them (puffin-build: the bugs of its version minus those its preset fixes),
else in the bug's affected versions at the library version it built (a crash at BUF's place on wolfSSL 5.8.0, which BUF
does not affect, is not BUF: a new bug or a regression). A bug the catalogue gives by commits (a bug of tlspuffin's
harness, `affected_commits = "not containing <commit of its fix>"`: the LibreSSL crash in
`tls13_hkdf_expand_label_with_length` of the commits before f896d56) is in a task's commit when git says that commit
lacks the fix (`objectives_report.sh CommitAffected`, in the clone of git_restapi): the finds of those commits are named
after it, known. Any other find stays as before (📋 known by the CVE
signatures of `vuln_targets.json`, else unexpected or new). The same holds for a find none of whose objectives was
validated in a task with validation. Validating older finds by patch (rebuilding the validation builds of their
commit) is done on demand only.

### On the pages

The objectives pages (and the 🐞 panel of Results) show, on each bug, one badge per verdict with how many objectives:
the signature itself, the place and why weak on click. The bug's column gives the full signature of the bug it is or
may be: its oracle and its place, with the witness's stack, the place in bold. One claim can be several bugs
(CVE-2021-3336, SIG and SKIP share "Authentication bypass" on wolfSSL 4.4.0). A bug validation names (by patch, or by
a strong signature) is named after the catalogue's entry (alias · ID), linked to the Bugs reference, its signature on
hover; a bug none of whose objectives was validated and that is not recognised shows the catalogue's bugs with its
signature, "not validated". To add a known bug: an entry, a patch and a witness trace in tlspuffin (see its
puffin-build/README.md).

### The Bugs reference

The **Bugs reference** page shows dev's catalogue; while dev has none, that of the open pull request updated last that
has one (said so at the top), and `?commit=<sha>` any commit's. Its overview gives each bug as the launcher's custom
benchmarks do: the presets of the catalogue's commit it can run on (the first: the one the launcher picks), the bench's
time to find it (Vuln group A/B, `runs/bench_times.json`), how a find is recognised (✔ confirmed by its patch, ≈ its
signature only: weak, the oracle alone decides during the run; the fuzzer's record), its **signature** (the catalogue's
oracle in words, "with its stack" for a crash with top frames or a witness, which make a verdict strong on the reports,
else "weak"; its place, the one the pages compare: in bold in its witness's stack, else the catalogue's top frames, said so; the witnesses' stacks: `objectives/witness_frames.json`, published by the
cron from the validations) and the bugs with the same signature; filters by library,
category, ★ first found by puffin, bugs without witness; its last section, the words of the pages, with their badges as every page shows them. Every field of a bug: its card at the end of the page. A bug of tlspuffin's harness of past commits
(`affected_commits = "not containing <commit of the fix>"`, e.g. the LibreSSL 3.3.3 claim of 2022–2026) is in no build of
the commit: the launcher never offers it, and the bugs found so far name the finds of older commits after it.

## Custom Vuln benchmarks

The launcher's **Vuln — custom** job builds a benchmark from tlspuffin's vulnerability catalogue (the bugs of
`puffin-build/vendors/<vendor>/vulnerabilities.toml`, every detail on the **Bugs reference** page, linked from the panel
and from each bug):

1. Pick the commit: the panel shows nothing else before (the saved benchmarks, the catalogue and the presets come from
   it).
2. **Saved benchmarks**, at the top of the panel: **VulnA** and **VulnB** first, built in (Vuln group A and B as
   configured: each configuration's bug on its preset as it is, the group's attempts, cores per attempt and timeout;
   never removed, their names never saved over), then the benchmarks saved with 💾 Save (below). **Load** ticks the same
   bugs again with the same settings, on the commit chosen (a bug that commit's catalogue does not have is left out, and
   named; a benchmark saved before the launcher kept the timeout gets the one already set, else the job's default, and
   says so: Save it again to keep one); **🗑 Remove** takes a saved one out of the list (the tasks it launched and their
   results stay).
3. Below them, what a saved benchmark keeps: **Timeout**, **Attempts** and **Cores per attempt**, **CPU sharing**.
4. **Catalogue**: dev's by default (what validation trusts); **Load bugs from this commit** takes the commit's own (a PR
   adding a bug), each bug marked against dev (only in this commit, differs from dev). **Show**: a library, a category,
   ★ first found by puffin; **hide bugs without witness** is ticked by default (nothing shows the fuzzer can reach them;
   untick it to see them: one with a patch and a signature, CALLB, can be ticked, with a warning, its finds still
   confirmed by its patch; one without patch, Heartbleed, FREAK, cannot).
5. Tick the bugs to look for: one experiment each. **Run on** offers the presets of the commit that have the bug (its
   version affected, the build options it requires), the newest first, ASan first; a version without patch for it is
   marked "signature only". The bug's needs (build options, PUT options, fuzzer flags, cargo features, ASan) are footnote
   marks under the table. **Time to find on the bench**: Vuln group A/B's own measurement of that bug at the newest
   commit they ran on (`/html/runs/bench_times.json`, written by `runs_report.py`; hover for the task), with whether
   that build had ASan, flagged when the build chosen here differs (BUF: measured without ASan, a custom experiment of
   BUF has ASan, its signature being an ASan report: expect another time).
6. **Other known bugs in the build**: **patch them** (recommended: `<preset>-only-<ID>`, the build keeps only the bug
   looked for, besides the known bugs without patch at that version) or **keep the preset as it is** (only the fixes of
   its own list; the fuzzer may find one of the other known bugs first, which does not end the attempt). **What will
   run** lists each experiment's vendor, build, flags, the signature it stops on ("weak" where it alone decides: no
   patch at that version) and the known bugs left in its build, and warns when one of them has the same signature (a stop on it is not
   a find).
7. **Benchmark**: its name. The experiments are named `<benchmark>_<alias or ID>` (e.g. `VulnC_BUF`): launching it again
   with the same name continues their series on Results. The definition is recorded with the task ("New task…" from it
   launches the same). **💾 Save** keeps the benchmark under its name in the scheduler (launching does not), for every
   user of the board, with its bugs, attempts, cores per attempt, timeout and CPU sharing (`/api/benchmarks/tlspuffin`,
   stored in `exports/benchmarks.json`). Saving under the name of a saved benchmark replaces it, once confirmed.

Each experiment builds its vendor with mk_vendor (ASan when the bug's oracle is an ASan report) and its validation set
(before the attempt, cached), runs with the bug's flags, and stops only on a recognised find: an objective whose signature
is the bug's oracle is replayed on the validation builds while the fuzzer goes on, and ends the attempt when validation
recognises it (confirmed by patch differential; a bug without patch: its signature on the build with every patch); one
it does not recognise leaves the attempt going. The time to find is when the fuzzer saved the first recognised objective (its name),
not when the attempt stopped. A preset that turns out not to have the bug (a PUT capability the launcher cannot know)
makes the experiment "unsupported" instead of running for nothing. When the validation builds cannot run an objective
(⛔ could not replay), validation does not decide: the fuzzer's record does, as on a commit without the catalogue.
The objectives page, Results and History give each experiment its 🎯 (runs that found its target, as for Vuln group
A): an objective is the target when validation names the target for it, else, until validation says, when it has the
target's signature.

## Performance configurations

`PR_perf_cargo.json` runs four libraries in parallel, each built once, then 20 one-client runs of 70 minutes (10 twin steps, two runs per physical core, see CPU sharing), all requiring the `introspection` cargo feature:

| Config | Vendor preset |
|--------|---------------|
| LibreSSL | `libressl:libressl421-asan` |
| BoringSSL | `boringssl:boringssl20260508-asan` |
| OpenSSL | `openssl:openssl340-asan` |
| WolfSSL | `wolfssl:wolfssl580-asan` |

---

## Adding a new tlspuffin configuration

1. Copy one of the flow JSONs under `installer/data/html/jobsscripts/tlspuffin/` (e.g. `PR_perf_cargo.json`) to a local file.
2. Add a new entry to the `configurations` object, matching the shape of a neighboring one:
   ```json
   "MyLib": {
     "args": {
       "experiment": "MyLib",
       "features": "mylib_feature,asan",
       "required_features": "introspection",
       "vendor": "mylib:mylib100-asan"
     }
   }
   ```
3. Every step in the parallel group carries a `"run"` array (the scheduler's generic mechanism for fanning a step out into one rank per named `configurations` entry — see [scheduler/docs/step-script-reference.md](scheduler/docs/step-script-reference.md)); the shipped tlspuffin flow files ship it empty rather than listing each library explicitly, so don't assume you need to edit it — copy the file's existing pattern rather than guessing.
4. The vendor preset (e.g. `mylib:mylib100-asan`) must exist on the tlspuffin side — that's outside this repo, see the tlspuffin project itself.
5. Submit the modified flow JSON the same way as the curl example above, swapping `config=@my_modified_flow.json`.

---

## Service ports (installer defaults)

| Service | Port | URL |
|---------|------|-----|
| Scheduler (board) | 10082 | `http://<host>:10082/files/board/board.html` |
| Publisher (results) | 10083 | `http://<host>:10083/files/tlspuffin` |
| Git REST API | 10081 | used internally by the board/dashboard UIs |
| vis_comparator | 10084 | `http://<host>:10084/files/tlspuffin/index.html` |

These are the ports the `installer` sets by default (`--port-scheduler`/`--port-publisher`/`--port-git`/`--port-vis`); each service falls back to its own compiled-in default when run standalone without those flags — see the root [README.md](README.md) and each service's `docs/configuration.md`.
