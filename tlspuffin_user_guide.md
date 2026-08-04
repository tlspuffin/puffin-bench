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
| Vuln group A | `vuln-a` | `PR_vulnerabilities-groupA_cargo.json` | Reproduces 5 known WolfSSL CVEs, stops per-library as soon as an objective (`.trace`) is found |
| Vuln group B | `vuln-b` | `PR_vulnerabilities-groupB_cargo.json` | 2 harder-to-trigger CVE repros with a much longer retry budget |
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

---

## Flow of a campaign

```
Init
 └─ Clone tlspuffin at COMMIT_ID, https-ify submodules, update them
 └─ Init/patch nix-shell (faketime for commits ≤ 8b29ce76d, WolfSSL timeout patch if needed)
 └─ Detect LibAFL version (sets AFL_CORES_GRAMMAR for cores > 0.15.3)

[parallel branch per library/configuration]
 ForcedBuild
  └─ cargo build --release --features=… inside nix-shell, fresh checkout, no cache
  └─ seed + help once, to warm/validate the binary

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

- **Perf**: the fuzzer runs for the full `timeout` — reaching it without dying counts as `success`; dying earlier (crash, hang-kill) counts as `fail`. Default `70m` in `PR_perf_cargo.json`, 5 retries.
- **Vuln**: stops as soon as at least one `.trace` file appears under `experiments/*/objective/`; a run is `success` only if the task reached `Done` **and** an objective was actually found (on-disk count or in the last stats snapshot) — a plain timeout is `fail`. Default `190m`/5 retries (group A) or up to `2890m` (~48h)/90 retries (group B).

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

From the board, click a step card to open the live-tail terminal view. Via API:
```bash
curl "http://localhost:10082/api/task/<taskID>/<stepUUID>/<stepID>/output/stdout/65536/0"
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

`PR_vulnerabilities-groupA_cargo.json` tests five known WolfSSL vulnerabilities in parallel, 5 retries × 190-minute timeout each:

| Config | Vendor preset | CVE |
|--------|----------------|-----|
| BUF | `wolfssl:wolfssl540-buf` | CVE-2022-42905 |
| CDOS | `wolfssl:wolfssl530-cdos` | CVE-2022-39173 |
| HEAP | `wolfssl:wolfssl540-heap` (+asan) | CVE-2022-39173 |
| SDOS2 | `wolfssl:wolfssl540-sdos2` | CVE-2022-39173 |
| SKIP | `wolfssl:wolfssl510-skip` | CVE-2022-25638 + CVE-2022-39173 |

## Vulnerability configurations (group B)

`PR_vulnerabilities-groupB_cargo.json` tests two harder-to-trigger cases in parallel, 90 retries × 2890-minute (~48h) timeout each — a long, patient search rather than a broad sweep:

| Config | Vendor preset | Target |
|--------|----------------|--------|
| SDOS1 | `openssl:openssl111j` | OpenSSL 111j |
| SIG | `wolfssl:wolfssl510-sig` | CVE-2022-25640 + CVE-2022-39173 |

## Performance configurations

`PR_perf_cargo.json` runs four libraries in parallel, 5 retries × 70-minute timeout each, all requiring the `introspection` cargo feature:

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
