# installer — tlspuffin Job Scripts

`installer/scripts/` and `installer/data/tools/js/` contain the concrete tlspuffin implementation of a scheduler *step script* — the generic contract for step scripts (execution environment, `functions.sh` API, flow JSON schema) is documented in [scheduler/docs/step-script-reference.md](../../scheduler/docs/step-script-reference.md); this document covers only what's specific to these files. Both end up embedded and installed by `installer` (see [architecture.md](architecture.md)), though not directly: `installer/scripts/` is build-time input to `scripts/build.sh` (see below), which assembles it into `PR_perf_full.sh`/`PR_vulnerabilities_full.sh` under `data/html/jobsscripts/tlspuffin/` — that generated directory, not `installer/scripts/` itself, is what actually gets embedded and served from `<datapath>/html/jobsscripts/tlspuffin/` (downloaded by the browser-based job launcher — see below). `installer/data/tools/js/` is embedded as-is and ends up at `<datapath>/tools/js/`, run by the QuickJS CLI also installed at `<datapath>/tools/qjs`.

## Assembling the Step Script

A step script is a single bash file containing one function per flow step. The tlspuffin one is assembled from three pieces at build time (`scripts/build.sh`, invoked by the `generate_tlspuffin_scripts` CMake target — see [build.md](build.md)):

```
PR_common.sh  +  PR_perf.sh            →  PR_perf_full.sh
PR_common.sh  +  PR_vulnerabilities.sh →  PR_vulnerabilities_full.sh
```

`PR_common.sh` is the shared library: helpers that don't correspond to a flow step by themselves (`ExperimentCheckAllThreadsRunning`, `ExperimentCheckRun`, `ExperimentSetup(ForCargo)`, `ExperimentPostLaunchSetup`, `ExperimentReport`, `MonitorExperiment`, ...) plus the four steps common to both flows: `Init`, `Build`, `ForcedBuild`, `Clean`/`CleanAllRepo`. `PR_perf.sh` and `PR_vulnerabilities.sh` each add the three flow-specific steps: `Experiment`(`WithCargo`), `ExperimentEnd`, `SummaryRun` — same names, different bodies (perf tracks throughput/objective-count over a fixed time budget; vuln stops the instant an objective/crash trace appears).

`PR_debug_run.sh` is a fourth, standalone script — **not** part of the embedded/installed set (it's not referenced by `CMakeLists.txt`'s `EmbedDirectory` call). It's a local developer harness: it hardcodes `SERVER_PATH='/home/olivier/Desktop/restsrv'` and a specific `COMMIT_ID`/`experiment`/`vendor`, sources `PR_common.sh` + `PR_perf.sh` + an external `functions.sh` directly, and runs `Init` → `Build` → `Experiment` → `StopMonitor` in a temp directory — letting a step function be exercised without a running scheduler or a submitted task. Treat it as a template to copy and adapt, not a script to run as-is.

## Flow JSON → Step Function Mapping

The four flow configs in `data/html/jobsscripts/tlspuffin/` (`PR_perf_cargo.json`, `PR_campaign.json`, `PR_vulnerabilities-groupA_cargo.json`, `PR_vulnerabilities-groupB_cargo.json`) all follow the same shape — a serial `Init` → *(parallel per-library branch)* → `SummaryRun` → `CleanAllRepo` — where each parallel branch names one `"configurations"` entry (one per TLS library/vendor combination) and runs:

```
Init  →  [ ForcedBuild → Experiment(WithCargo) [monitored] → ExperimentEnd ]×N libraries  →  SummaryRun  →  CleanAllRepo
```

`"step"` values (`Init`, `ForcedBuild`, `ExperimentWithCargo`, `ExperimentEnd`, `SummaryRun`, `CleanAllRepo`) must match a bash function name defined somewhere in `PR_common.sh`+`PR_perf.sh`/`PR_vulnerabilities.sh` exactly, per the scheduler's step-script contract. `"configurations"` becomes per-branch `args` (`experiment`, `features`, `vendor`, `required_features`, `extra_flags`) — these arrive as plain bash variables (`$experiment`, `$features`, ...) inside the step function, same mechanism as any other step-script argument.

`PR_campaign.json` is the odd one out: a template, not a ready-to-submit config. `${RUNTIME_NB_CORES}`, `${RUNTIME_NB_RUN}`, `${RUNTIME_TIMEOUT}`, `${RUNTIME_MEMORY_CORE}`, `${RUNTIME_MEMORY_CONSUMPTION}`, and `${RUNTIME_RUN_CONFIG}` (the entire `"configurations"` object) are filled in by the job launcher UI (`joblauncher.js`) before submission, not by the installer's `ResolveVariables()` — a different, unrelated `${...}` substitution happening client-side in the browser. The other three ship fixed, concrete `"configurations"`:

| Config | Targets (`"configurations"` keys → `vendor`/`features`) | Retries × timeout |
|---|---|---|
| `PR_perf_cargo.json` | `LibreSSL` (libressl421-asan), `BoringSSL` (boringssl20260508-asan), `OpenSSL` (openssl340-asan), `WolfSSL` (wolfssl580-asan) — all with `required_features: introspection` | 5 × 70m |
| `PR_vulnerabilities-groupA_cargo.json` | 5 known-CVE repros, all WolfSSL: `BUF` (CVE-2022-42905), `CDOS`/`SDOS2` (CVE-2022-39173), `HEAP` (CVE-2022-39173+asan), `SKIP` (CVE-2022-25638+CVE-2022-39173) | 5 × 190m |
| `PR_vulnerabilities-groupB_cargo.json` | 2 targets, deliberately given much more budget: `SDOS1` (OpenSSL 111j) and `SIG` (WolfSSL, CVE-2022-25640+CVE-2022-39173) | 90 × 2890m (~48h) — harder-to-trigger cases that need a long, patient search rather than a broad sweep |

All three are referenced by `jobsconfig.json`'s job types (`perf`, `vuln-a`, `vuln-b` respectively) — see [web-assets.md](web-assets.md).

## Step Walkthrough

| Step | What it does |
|---|---|
| **`Init`** | Clones `tlspuffin` into `$THEJOB_OUT_PATH/repo`, checks out `$COMMIT_ID`, rewrites `.gitmodules` to use `https://` instead of `git@`, recursively updates submodules. Decides whether to prefix the run with `faketime` (only for commits that are ancestors of a fixed pre-fix commit, `8b29ce76d`) and patches `shell.nix`'s nixpkgs pin / adds `libfaketime` accordingly. Conditionally applies `wolfssl_put.c.patch` to `tlspuffin/harness/wolfssl/src/put.c` if it doesn't already contain `MyTimeoutCallBack` (idempotent: `patch --dry-run` gates the real `patch`). Computes `LIBAFL_VERSION` (via `cargo pkgid libafl` inside `nix-shell`) and `AFL_CORES_GRAMMAR` (whether that version is strictly greater than `0.15.3` — `0.15.3` itself still uses the old syntax — which changes CLI core-selection syntax later), publishing both as global step params via `AddGlobalParam` so later steps in the same task can read them. |
| **`Build`** | Builds the tlspuffin binary with `cargo build --release --features=$features` inside `nix-shell`. Content-addressed cache: keyed on `md5(PACKAGE-COMMIT_ID-features-vendor)`, looked up via `QueryCache` — only called when `COMMIT_ID != "main"`, i.e. skipped when `COMMIT_ID == "main"` (a `main`-pinned build is never treated as cacheable, since it moves). On a cache miss, builds and registers the binary path with `SetCache`; either way copies the resulting binary to `$THEJOB_OUT_PATH/$PACKAGE-$THEJOB_STEP_ID`. |
| **`ForcedBuild`** | The variant actually used by every current flow JSON (`Build` itself isn't referenced from any flow config here) — same build, but always from a fresh copy of the cloned repo into the step's own working directory, no cache, and additionally runs `seed` and `help` once to warm/validate the binary before handing off to the experiment step. |
| **`Experiment` / `ExperimentWithCargo`** | Launches the built binary (or `cargo run` directly, for the `WithCargo` variant) in the background inside `nix-shell`, reserving a loopback TCP port first via the embedded `reserve_port` tool (see [components.md](components.md)). `ExperimentPostLaunchSetup` polls (up to ~16 min: 100×10s waiting for the experiment directory + `README.md`, then 30×10s for `stats.json`) and archives `README.md`, `stats.json`(`.1`), logs, and `objective/` (crash traces) as task artefacts via `CreateArtefact` as they appear. Perf's `Experiment` then calls `ExperimentCheckRun`, which polls once a minute until the process dies naturally, times out, or is judged hung (see Monitoring below) — then kills it via `EndDirectChild`. Vuln's `Experiment` instead calls `CheckObjectif`, identical polling but exits immediately (success) the moment a `*.trace` file appears under `experiments/*/objective/`. |
| **`ExperimentEnd`** | Kills the reserved port's holder process, calls `ExperimentReport` to read task state from the API (`$THEJOB_API_URL/task/$THEJOB_TASK_ID/state`) and count objective traces, then runs `qjs .../perf_experiment_end.js` or `.../vuln_experiment_end.js` against the raw `stats.json` to produce a normalized `summary-$THEJOB_STEP_ID-$THEJOB_STEP_ATTEMPT_ID.json` (see below). |
| **`SummaryRun`** | Runs `qjs .../perf_summary_run.js` or `.../vuln_summary_run.js`, which walks `$THEJOB_ARTEFACTS_PATH` (one subdirectory per library, populated by the parallel branches above) and aggregates every per-attempt `summary-<library>-<attempt>.json` into one `summary.json`, archived as the task's `summary.json` artefact. This is the file the publisher's `.rules` pick up — see [architecture.md](architecture.md) and the root [README](../../README.md#publisher-projects). Perf's variant exits `0` if any library flagged an objective (crash) and `1` otherwise, which `PR_perf.sh` turns into a colored `Flag` on the task. |
| **`Clean` / `CleanAllRepo`** | `Clean` removes the cloned repo working tree (`rm -rf "$THEJOB_OUT_PATH/repo"`). `CleanAllRepo` also does `ipcrm --all` first (SysV IPC segments left behind by a killed AFL/LibAFL process); its own `rm -rf "$THEJOB_OUT_PATH/repo*"` uses a quoted `*`, which the shell does not glob-expand — as written this removal only matches a literal `repo*`-named path, so in practice `CleanAllRepo` relies on `ipcrm` for its real effect. |

## Monitoring: Hang Detection

`ExperimentCheckAllThreadsRunning` (in `PR_common.sh`) runs once a minute during `ExperimentCheckRun` and implements two independent kill paths:

- **Immediate kill.** It shells out to `qjs get_last_stats_time.js "$stats"`, which tails the last 64 KiB of `stats.json`, finds the last *complete* JSON object in it (deliberately skipping the very last chunk, since the file is being appended to concurrently — see `data/tools/js/get_last_stats_time.js`), and prints its `time.secs_since_epoch`. If that global timestamp hasn't advanced by more than 300s since the previous check, or a `"Timeout in fuzz run"` line shows up in `error.log`, the function returns failure right away and `ExperimentCheckRun` kills the process on that same round — no waiting for repeated occurrences.
- **5-consecutive-round kill.** Separately, each round it extracts which fuzzer client `"id"` values appear in the bytes newly appended to `stats.json`. A client ID missing from that set for two consecutive rounds counts as an issue (`nbissues` increments); once the *same* client has gone quiet for `nbissues > 4` consecutive rounds (~5 minutes), the process is killed via `EndDirectChild`.

Set `DISABLE_KILL_ON_HANG=1` in the flow's `args` to disable this entirely and rely only on the step's own `timeout` (from `functions.sh`).

## QuickJS Post-Processing (`data/tools/js/`)

All five scripts are run via `qjs --std <script>.js <args...>` and share `utils.js` (an ES module: JSON I/O helpers, `stat.json`-log parsing, argument validation). They communicate failure uniformly: `Utils.EndErrorMessage(msg)` builds `{"args":[...], "error": msg}`, printed to stdout by the caller (`console.log(Utils.EndErrorMessage(...))`) before the script exits non-zero — the calling shell function doesn't parse this specially, it just ends up in the step's captured output/logs.

| Script | Role |
|---|---|
| `get_last_stats_time.js` | See Monitoring above. Takes one arg (`stats.json` path), prints one number (unix seconds) or nothing. |
| `perf_experiment_end.js` / `vuln_experiment_end.js` | Parse the full `stats.json` via `Utils.GetLastStats`/`GetFirstStats` (see below) into a `{id, state, nb_objective_on_disk, global, clients, others}` record — one `t0`/`tEnd` snapshot pair per client/global reporter, with `t0` (but not `tEnd`) having its zero-valued fields pruned (`PruneZeroFields`). Both scripts remap the raw task state rather than passing it through as-is — perf maps `TimedOut` → `success` (any other state → `fail`); vuln instead derives `state` from whether any objective was found (`Done` + objective ⇒ `success`) and takes an extra `error_file_exist` argument folded into the record. |
| `perf_summary_run.js` / `vuln_summary_run.js` | Aggregate step: list subdirectories of `$THEJOB_ARTEFACTS_PATH` (one per library) to enumerate which per-attempt files exist, then read the corresponding `cli-<library>.json` (compile info) and `summary-<library>-<n>.json` (per-attempt record from the step above) from `$THEJOB_OUT_PATH`, and emit one `summary.json`. Perf's variant additionally computes `flag_objective` per library and overall — `wolfssl` builds at version ≤ 540 have `trust_objective = -1` (a known-unreliable-crash-detection cutoff), so an objective found there doesn't count. |

### `stats.json` Parsing (`Utils.GetLastStats` / `GetFirstStats`)

LibAFL writes `stats.json` as a stream of back-to-back JSON objects (`}{`-separated, no newlines) — one "global" record plus one per fuzzer client. `SplitObjects` splits on that boundary. `GetLastStats` seeks from **end of file** backward in 128 KiB chunks until it has found a complete, non-duplicate record for every expected client ID (`IsClientArrayFull`); `GetFirstStats` does the same from the start, forward. `CompareVersionLesser` adjusts client-ID offsetting for LibAFL versions older than `0.12.0` (an extra phantom broker entry at index 1 in newer versions). Both stop early once every expected slot is filled, so the cost is proportional to how far back in the file the last record for the slowest-reporting client is, not the whole file size.

## Supporting Files

- **`shell.nix`** (`data/html/jobsscripts/tlspuffin/`) — the nix-shell environment (`cargo`, toolchain, `libfaketime` when patched in by `Init`) used by every `nix-shell --run "..."` invocation in the step functions. `Init` copies this in only if the checked-out commit doesn't already ship its own.
- **`wolfssl_put.c.patch`** — a 60-line patch adding `MyTimeoutCallBack` to the WolfSSL harness, applied conditionally by `Init` (see above).
