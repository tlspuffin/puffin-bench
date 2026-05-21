# tlspuffin — User Guide

This guide explains how to use the restsrv suite to run tlspuffin fuzzing campaigns, monitor them in real time, and exploit their results.

---

## Architecture overview

```
┌─────────────────────┐   submit job    ┌──────────────────────┐
│                     │ ──────────────► │  Scheduler (srv)     │
│                     │                 │  port 8080           │
│                     │                 └──────────┬───────────┘
│   User / Browser    │                            │ fork/exec
│                     │                 ┌──────────▼──────────┐
│                     │                 │  Nix shell + cargo  │
│                     │                 │  tlspuffin binary   │
│                     │                 └──────────┬──────────┘
│                     │                            │ POST /api/notify
│                     │  browse results ┌──────────▼──────────┐
│                     │ ◄─────────────► │  Publisher          │
│                     │                 │  port 8081          │
│                     │                 └─────────────────────┘
│                     │  commit history ┌─────────────────────┐
│                     │ ◄─────────────► │  Git REST API       │
└─────────────────────┘                 │  port 10083         │
                                        └─────────────────────┘
```

- **Scheduler** (`srv`): receives job submissions, allocates CPU cores, runs job scripts step by step, archives outputs.
- **Git REST API** (`git_restapi`): exposes the tlspuffin git history so the launcher UI can list available commits.
- **Publisher** (`publisher`): stores completed campaign results (stats, objectives, summaries) in a structured directory tree, accessible to analysis tools.

---

## Prerequisites on the machine running campaigns

- The three services must be running (see [README.md](README.md)).
- **Nix** must be installed — the job scripts run inside a Nix shell.
- Enough CPU cores: performance campaigns typically use 3 cores per configuration, vulnerability campaigns 4 cores.

---

## Job types

The following job types are pre-configured in the Board UI (defined in `html/board/jobs_config.json`):

| Label in UI | Flow JSON | Script | Purpose |
|-------------|-----------|--------|---------|
| **Perf** | `PR_perf_cargo.json` | `PR_perf_full.sh` | Measures exec/s, corpus size, coverage over a fixed duration |
| **Vuln group A** | `PR_vulnerabilities-groupA_cargo.json` | `PR_vulnerabilities_full.sh` | Stops as soon as an objective (`.trace`) is found |
| **Vuln group B** | `PR_vulnerabilities-groupB_cargo.json` | `PR_vulnerabilities_full.sh` | Stops as soon as an objective (`.trace`) is found |
| **Campaign** | `PR_campaign.json` | `PR_perf_full.sh` | Generic campaign with runtime-configurable configurations |
| **Evaluate PR** | `PR_perf.json` | `PR_perf.sh` | Lighter performance evaluation for a PR |

All scripts are embedded in the `srv` binary and served at `/files/jobs_scripts/`. The Board UI fetches them automatically when launching a job.

The `_cargo` suffix means the experiment is run with `cargo run` instead of a pre-compiled binary — useful for commits that are not yet in the binary cache.

**Regenerating full scripts** (if you modify `PR_common.sh`, `PR_perf.sh`, or `PR_vulnerabilities.sh`):
```bash
cd scheduler/samples/jobs/tlspuffin
bash build.sh
# Produces PR_perf_full.sh and PR_vulnerabilities_full.sh

# Option A — update a running server in place (no rebuild needed):
cp PR_perf_full.sh PR_vulnerabilities_full.sh <html>/jobs_scripts/
# where <html> is the directory configured in server.html of config.json

# Option B — update the binary (for redistribution or fresh deployments):
cp PR_perf_full.sh PR_vulnerabilities_full.sh ../../html/jobs_scripts/
# then rebuild srv and run --force-install to extract the new embedded scripts
```

---

## Submitting a campaign

### Via the Board web UI

1. Open `http://<scheduler-host>:8080/files/board/board.html` in a browser.
2. Click **Launch job**.
3. Fill in the form:
   - **Commit ID**: the tlspuffin git commit or branch to test (e.g. `main`, `abc1234`).
   - **Job type**: `perf` or `vulnerabilities`.
   - **Nb cores**, **timeout**, **memory** — pre-filled with defaults from `jobs_config.json`.
4. Click **Submit**.

### Via curl (API)

```bash
SCRIPTS=scheduler/html/jobs_scripts

curl -X POST http://localhost:8080/api/task/new \
  -F "name=Perf - main" \
  -F "config=@${SCRIPTS}/PR_perf_cargo.json" \
  -F "script=@${SCRIPTS}/PR_perf_full.sh" \
  -F "files[]=@${SCRIPTS}/shell.nix" \
  -F "files[]=@${SCRIPTS}/wolfssl_put.c.patch" \
  -F "args[COMMIT_ID]=main" \
  -F "user=alice" \
  -F "job_type=perf"
```

The response contains the task ID:
```json
{ "id": 1713240000000 }
```

### Key parameters

| Parameter | Where | Description |
|-----------|-------|-------------|
| `COMMIT_ID` | `args[COMMIT_ID]` | Git commit hash or branch name to test. Defaults to `main`. |
| `features` | set in the flow JSON per configuration | Cargo feature flags (e.g. `asan,openssl111k`). |
| `vendor` | set in the flow JSON per configuration | Vendor preset in format `library:version` (e.g. `wolfssl:wolfssl580-asan`). Triggers `mk_vendor` build. |
| `experiment` | set in the flow JSON per configuration | Experiment name passed to `tlspuffin experiment -d/-t`. |
| `PREFIX_FAKETIME` | auto-detected by Init | Set to `faketime 2022-12-24` for commits before `8b29ce76d`. |

---

## Flow of a campaign

```
Init
 └─ Clone tlspuffin at COMMIT_ID
 └─ Init nix shell, patch wolfssl if needed
 └─ Detect LibAFL version (sets AFL_CORES_GRAMMAR)

[parallel for each configuration: LibreSSL, BoringSSL, OpenSSL, WolfSSL]
 ForcedBuild
  └─ cargo run --features=… -- seed        (generate seed corpus)
  └─ cargo run --features=… -- help        (validate build)

 ExperimentWithCargo  (or Experiment if binary was pre-built)
  └─ reserve TCP port
  └─ cargo run --features=… -- experiment  (launch fuzzer)
  └─ monitor: archive README.md, stats.json, logs, corpus, objectives

 ExperimentEndCommon / ExperimentEnd
  └─ release port, clean IPC, write per-run summary

SummaryRun
 └─ aggregate all run stats into summary.json / run-summary.json

CleanAllRepo
 └─ delete cloned repo from working directory
```

### Perf vs Vuln termination

- **Perf**: the fuzzer runs until it stalls (no `stats.json` update for >300 s) or a client thread disappears for 4+ consecutive health checks. Duration is bounded by `timeout` (default 70 min in `PR_perf_cargo.json`).
- **Vuln**: the fuzzer stops as soon as at least one `.trace` file appears in `experiments/*/objective/`. Duration is bounded by `timeout` (default 190 min in `PR_vulnerabilities-groupA_cargo.json`).

---

## Monitoring a running campaign

### Board dashboard

Open `http://<scheduler-host>:8080/files/board/board.html` → the Board shows all running and completed tasks with their step status.

Each step card displays the **monitor output** updated every 60 s, including:

```
# Experiment: <experiment-name>  Port: <N>
  Time since last stats.json update: 42s
  Default PUT: openssl111k
  Corpus: 127 file(s), last modified: 3 minutes ago
    No error ✅
    No objective yet ✓
```

Or when a vulnerability is found:
```
    ==> 🎉 Objective: 2 file(s), last modified: 12 minutes ago
```

### Reading step logs

From the Board UI, click a step card to open the terminal view (stdout / stderr streamed in real time via the API).

Via API:
```bash
curl "http://localhost:8080/api/task/output/<taskID>/<stepUUID>/<stepID>/stdout/65536/0"
# Response: base64-encoded log chunk
```

### Cancelling a task

```bash
# Cancel entire task
curl -X DELETE http://localhost:8080/api/task/<taskID>

# Cancel one step only
curl -X DELETE http://localhost:8080/api/task/<taskID>/step/<stepUUID>
```

---

## Artefacts produced

Each experiment step registers the following artefacts (accessible via the publisher or directly in `exports/`):

| Artefact | Content |
|----------|---------|
| `<stepID>/<attemptID>-README.md` | Fuzzer experiment metadata (commit, PUT, port, date) |
| `<stepID>/<attemptID>-stats.json` | LibAFL statistics stream (JSON objects concatenated) |
| `<stepID>/<attemptID>-tlspuffin.log` | Fuzzer log |
| `<stepID>/<attemptID>-tlspuffin.out` | Fuzzer stdout |
| `<stepID>/<attemptID>-log` | Full log directory |
| `<stepID>/<attemptID>-objective` | Objective traces (`.trace` files) — non-empty means a vulnerability was triggered |
| `<stepID>/<attemptID>-corpus` | Corpus (perf campaigns only) |
| `summary.json` | Aggregated perf metrics (exec/s, corpus size, coverage per configuration) |
| `run-summary.json` | Aggregated vuln metrics (objective count, run duration per configuration) |

---

## Accessing results in the publisher

The publisher stores results under `storage_path` as defined in the flow JSON:

- **Perf**: `tlspuffin/PR/<COMMIT_ID>/Perf/`
- **Vuln**: `tlspuffin/PR/<COMMIT_ID>/Vuln/`

Browse the publisher web UI at `http://<publisher-host>:8081/` or fetch files directly from the storage path.

### Reading summary.json (perf)

```json
{
  "type": "perf",
  "libraries": [
    {
      "name": "OpenSSL",
      "data": [
        {
          "id": "1",
          "duration": 4198,
          "corpus_size": 312,
          "total_execs": 8742150,
          "coverage": [72.45, 71.88, 72.01],
          "objective_size": 0,
          "client_average_duration_s": 4180
        }
      ]
    }
  ]
}
```

### Reading run-summary.json (vuln)

```json
{
  "type": "vuln",
  "libraries": [
    {
      "name": "BUF",
      "data": [
        {
          "id": "1",
          "duration": 2345,
          "total_execs": 3412000,
          "objective_size": 1,
          "valid": true
        }
      ],
      "cputs": "false"
    }
  ]
}
```

`objective_size > 0` means the vulnerability was found. `duration` is in seconds.

---

## Build cache

The scheduler maintains a binary cache keyed on `(COMMIT_ID, features, vendor)`. For non-`main` commits, a pre-built `tlspuffin` binary is reused across campaigns with the same configuration, avoiding redundant `cargo build` runs.

- **Cache stored in**: `cache/` (path from `config.json`)
- **Cache query/set**: `QueryCache` / `SetCache` shell helpers available in step scripts
- **Cache bypass**: use `ForcedBuild` step (builds unconditionally with `cargo run`) instead of `Build`

---

## Vulnerability configurations (group A)

The `PR_vulnerabilities-groupA_cargo.json` flow tests five known WolfSSL vulnerabilities simultaneously:

| Config | WolfSSL version |
|--------|-----------------|
| BUF | wolfssl540-buf |
| CDOS | wolfssl530-cdos |
| HEAP | wolfssl540-heap (asan) |
| SDOS2 | wolfssl540-sdos2 |
| SKIP | wolfssl510-skip |

Each configuration runs in parallel 5 times with 4 cores and a 190-minute timeout.

---

## Vulnerability configurations (group B)

The `PR_vulnerabilities-groupB_cargo.json` flow tests simultaneously:

| Config | WolfSSL version |
|--------|-----------------|
| SIG | wolfssl510-sig |
| SDOS1 | openssl111j |

Each configuration runs in parallel 90 times with 1 core and a 48-hour timeout.

---

## Adding a new tlspuffin configuration

1. Copy one of the existing flow JSONs (e.g. `scheduler/scheduler/html/jobs_scripts/PR_perf_cargo.json`) to a local file.
2. Add a new entry in the `configurations` object:
   ```json
   "MyLib": {
     "args": {
       "experiment": "MyLib experiment name",
       "features": "mylib_feature,introspection",
       "vendor": "mylib:mylib100-asan"
     }
   }
   ```
3. Add `"MyLib"` to the `"run"` array in the parallel step.
4. If using a custom vendor, ensure the vendor preset exists in `puffin-build/vendors/mylib/presets.toml` in the tlspuffin repo.
5. Submit the modified flow JSON via curl:
   ```bash
   SCRIPTS=scheduler/html/jobs_scripts
   curl -X POST http://localhost:8080/api/task/new \
     -F "name=MyLib test" \
     -F "config=@my_modified_flow.json" \
     -F "script=@${SCRIPTS}/PR_perf_full.sh" \
     -F "files[]=@${SCRIPTS}/shell.nix" \
     -F "files[]=@${SCRIPTS}/wolfssl_put.c.patch" \
     -F "args[COMMIT_ID]=main" \
     -F "user=alice" \
     -F "job_type=perf"
   ```

## Service ports (default configuration)

| Service | Port | URL |
|---------|------|-----|
| Scheduler (board) | 8080 | `http://<host>:8080/files/board/board.html` |
| Publisher (results) | 8081 | `http://<host>:8081/files/tlspuffin` |
| Git REST API | 10083 | used internally by the publisher UI |

Ports are configured in each service's `config.json` / `publisher_config.json` / `git_restapi-config.json`.
