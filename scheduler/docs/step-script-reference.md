# Scheduler — Step Script Reference

A step script is the bash file uploaded as the `script` part of `POST /api/task/new`. It defines one function per step; the scheduler calls `scripts/executor.sh`, which sources `scripts/functions.sh`, sources the step script, and invokes the named function. This document covers the complete authoring surface: the execution environment, the `functions.sh` API, the monitor/shutdown contracts, and the flow JSON schema.

---

## Function Naming

The function name in the script must match the `"step"` key in the flow JSON exactly:

```json
{ "step": "Build" }
```
```bash
Build() {
  # implementation
}
```

`executor.sh` checks the function exists with `declare -F "${THEJOB_ENTRYPOINT}"` before calling it; if it doesn't, the step fails with a non-zero exit and the message `"<name> does not exist"`.

---

## Execution Environment

Before running the step function, the local executor (`src/scheduler/schedule/executor/local.cxx`) writes a per-step config file containing `KEY="value"` assignments for every variable below; `functions.sh`'s `SetupEnv` (invoked automatically when `functions.sh` is sourced) `eval`s that file, so all of these arrive as plain bash variables — no `export`/`source` needed in the step function itself.

### Paths

| Variable | Content |
|----------|---------|
| `THEJOB_ROOT_PATH` | Task run root directory; the step's current working directory |
| `THEJOB_OUT_PATH` | Task outputs subdirectory |
| `THEJOB_ARTEFACTS_PATH` | Directory where artefact files should be placed |
| `THEJOB_ARTEFACTS_FILE` | JSON-lines file `CreateArtefact` appends to |
| `THEJOB_USER_FILES_PATH` | Directory containing uploaded input files (`files[]` from `POST /api/task/new`) |
| `THEJOB_TOOLS_PATH` | Shared tools directory (read-only) |
| `THEJOB_FUNCTIONS_PATH` | Path to the **step script itself** (despite the name — it is not `functions.sh`); useful to re-source in subshells |
| `THEJOB_ENV_PATH` | File holding task-level args and accumulated `AddGlobalParam` values, shared between steps |
| `THEJOB_PARAMETERS_PATH` | File holding this step's own `args` (from the flow JSON `configuration`/`run` entry), already evaluated by `SetupEnv` |
| `THEJOB_USER_STATE_FILE` | File for end-of-step structured metadata (see User State below) |
| `THEJOB_FLAG_FILE` | Task-level flag file shared across all steps (written by `Flag()`) |
| `THEJOB_DONE_FILE` | Step-level sentinel file, written by `executor.sh` at step exit with the step's exit code |
| `THEJOB_STDOUT_PATH` / `THEJOB_STDERR_PATH` | Paths of the stdout/stderr log files the step's output is (eventually) flushed to |

### Identity

| Variable | Content |
|----------|---------|
| `THEJOB_USER` | Submitting user (task-level `user` form field) |
| `THEJOB_API_URL` | Base API URL configured on the server |
| `THEJOB_TASK_ID` | Numeric task ID |
| `THEJOB_STEP_UUID` | This step's unique UUID |
| `THEJOB_STEP_ID` | Step string ID, `"<step_id>-<rank_id>-<attempt_id>"` (e.g. `"0-0-0"`) |
| `THEJOB_STEP_NUMID` | Step numeric index in the flow |
| `THEJOB_STEP_RANK_ID` | Rank within a fan-out (`run`) — 0 for non-fanned-out steps |
| `THEJOB_STEP_ATTEMPT_ID` | Retry attempt number, 0-based |
| `THEJOB_RUN_ID` | Run ID within the task |
| `THEJOB_STEP_GROUP_ID` | Group ID — **only set** when the step belongs to a group (`flow[]` array element) |

### Resources

| Variable | Content |
|----------|---------|
| `THEJOB_CORES` | Comma-separated list of assigned CPU core indices (e.g. `"2,3,4,5"`) |
| `THEJOB_NB_CORES` | Number of assigned cores; computed by `executor.sh` itself by counting `THEJOB_CORES` entries (not sent by the C++ side) |
| `THEJOB_CACHE_PORT` | Port of the local cache HTTP server (`http://localhost:${THEJOB_CACHE_PORT}/api/cache`) |

### Control

| Variable | Content |
|----------|---------|
| `THEJOB_UNIQ_STEP` | `1` if this step is the last in its retry chain (or has no retries); `0` for an earlier retry attempt. Set by the executor as `(step.next_ == &step)` |
| `THEJOB_SHUTDOWN` | Only present, set to `1`, when `executor.sh` is invoked to run the shutdown variant (see below) |
| `THEJOB_PID` | PID of the forked step process (also the session ID, since the executor calls `setsid()`) |
| `THEJOB_ENTRYPOINT` | The function name `executor.sh` resolves and calls; internal, but readable from within the step |

### Step and Task Arguments

Flow JSON step `args` (via `configuration`/`run`) and task-level `args` (from `POST /api/task/new` `args[KEY]` fields) are both written to disk as `KEY="value" ...` and `eval`'d by `SetupEnv` — task args from `THEJOB_ENV_PATH`, step args from `THEJOB_PARAMETERS_PATH`. Both therefore appear as ordinary shell variables:

```bash
# Flow JSON: "configuration": {"args": {"COMMIT_ID": "abc123"}}
Build() {
  echo "Building commit: ${COMMIT_ID}"
}
```

---

## API — `functions.sh`

Sourced automatically by `executor.sh`. All functions below are available without any `source`/`import` inside a step function. `SetupEnv` (also in this file) runs automatically at source time and does not need to be called manually.

| Function | Signature | Purpose |
|----------|-----------|---------|
| `QueryCache` | `QueryCache [-q] <cache_id> [timeout_s]` | Poll the cache until `cache_id` is ready; print its path |
| `SetCache` | `SetCache <cache_id> <file>` | Register a local file in the cache under `cache_id` (async) |
| `AddGlobalParam` | `AddGlobalParam <key> <value>` | Expose a key/value pair to all subsequent steps of the task |
| `CreateArtefact` | `CreateArtefact <path> <name> [key:value ...]` | Register an output file as a named artefact with optional metadata |
| `AbortFail` | `AbortFail <command> [args...]` | Run a command, print `Fail: ...` and return non-zero if it fails |
| `EndDirectChild` | `EndDirectChild <pid>` | Gracefully terminate a direct child process (TERM, then KILL) |
| `StartMonitor` | `StartMonitor [args...]` | Start the step's monitor function as a background loop |
| `StopMonitor` | `StopMonitor` | Stop the monitor loop and run the monitor function once more, synchronously |
| `Flag` | `Flag <json-string>` | Atomically write a JSON string to `THEJOB_FLAG_FILE` |

---

### `QueryCache [-q] <cache_id> [timeout_s]`

Polls `GET http://localhost:${THEJOB_CACHE_PORT}/api/cache/<cache_id>` and inspects the response's `state` field (`Ok`, `Locked`, `Not Available` — the exact strings `CacheAPI::Get()` returns, see `docs/monitoring-output-cache.md`).

```bash
local binary=$(QueryCache -q "abc123_openssl_asan" 300)
# $binary = /cache/storage/abc123_openssl_asan  (or empty on failure)
```

| Option | Effect |
|--------|--------|
| `-q` | Quiet: print only the resolved file path on success |
| (none) | Verbose: print progress on each poll |

| Exit code | Meaning |
|-----------|---------|
| `0` | File ready (`state == "Ok"`), path printed |
| `1` | Missing `cache_id` parameter |
| `2` | `state == "Not Available"` |
| `3` | Unexpected/unknown `state` value |
| `4` | Timeout reached before the file became ready |

Retries every second while `state == "Locked"`. `timeout_s=0` (default) waits forever.

---

### `SetCache <cache_id> <file>`

```bash
SetCache "abc123_openssl_asan" "/path/to/tlspuffin"
```
Issues `PUT /api/cache/<cache_id>` with `{"path": "<file>"}`. Returns `64` immediately if `cache_id` is empty or `file` is not readable; otherwise returns curl's own exit status. The registration is asynchronous server-side (the cache worker copies the file in the background) — use `QueryCache` to wait for completion. Note: MD5 verification of cached files is not implemented server-side today regardless of any `computeMD5` flag (see `docs/monitoring-output-cache.md`); `SetCache` itself does not expose a way to request it.

---

### `AddGlobalParam <key> <value>`

```bash
AddGlobalParam "AFL_CORES_GRAMMAR" "4"
```

- Values accumulate in `THEJOB_GLBPARMS` for the duration of the step (double quotes in `value` are escaped automatically).
- Written to `THEJOB_ENV_PATH` **only at step end, and only if `THEJOB_UNIQ_STEP=1`** — an earlier attempt in a retry chain does not propagate its params.
- Available to later steps of the same task as plain shell variables (via `SetupEnv`'s `eval`), **not** to concurrently running parallel steps.

---

### `CreateArtefact <path> <name> [key:value ...]`

```bash
CreateArtefact "/work/stats.json" "stats" "run:0" "attempt:0"
```

- `path` is resolved to an absolute path via `realpath`.
- Optional `key:value` pairs become a `metadata` object; numeric values and `true`/`false`/`null` are emitted as JSON primitives, everything else as a JSON string.
- One compact JSON line is appended to `THEJOB_ARTEFACTS_FILE` (surfaced via `GET /api/task/<id>/artefacts`).

---

### `AbortFail <command> [args...]`

```bash
AbortFail cargo build --release
```

Runs the command; on failure prints `Fail: <command...>` and returns non-zero. Combine with `set -e` or `|| return 1` to make the whole step abort on failure — `AbortFail` alone only reports, it does not exit the script for you.

---

### `EndDirectChild <pid>`

```bash
my_daemon &
MY_PID=$!
EndDirectChild ${MY_PID}
```

- Only works on **direct children** of the current shell (checks the process's parent is `$$`); returns `1` otherwise, or if `pid` is missing/not running.
- Sends `SIGTERM`, then `SIGKILL`, polling up to 8 × 0.5s for the process to die.
- On success, `wait`s on the pid, prints its exit code to stdout, returns `0`.

---

### `StartMonitor [args...]`

```bash
StartMonitor
StartMonitor "${EXPERIMENT_DIR}"   # forwarded to the monitor function on every call
```

- No-op if the step has no `monitor` block configured, or if a monitor loop is already running.
- Reads `entry_point`, `interval`, `timeout`, `delay_start` from `THEJOB_MONITOR_PARAMETERS_PATH`; sleeps `delay_start`, then loops: run the monitor function (wrapped in `timeout <timeout_s>` when configured, re-sourcing `functions.sh`/the step script in a fresh subshell), write its output atomically (`.tmp.<pid>` then `mv`), sleep `interval`, repeat.
- If the monitor function times out, `"monitor has timeouted"` is appended to the output file (internal `timeout` exit code `124`); `"timeout internal fail"` on `125`.
- Arguments passed to `StartMonitor` are forwarded to the monitor function on **every** invocation.

---

### `StopMonitor`

```bash
StopMonitor   # called automatically by executor.sh after the step function returns
```

Kills the background monitor loop, then runs the monitor function **one final time, synchronously**, with the same trailing arguments as the last `StartMonitor` call, guaranteeing a final status snapshot before the step ends. You rarely need to call this yourself.

---

### `Flag <json-string>`

```bash
Flag '{"color": "#6f6f00"}'
Flag '{"status": "done", "result": "passed"}'
```

- Writes atomically: to `<THEJOB_FLAG_FILE>.<step_numid>.<rank_id>.<attempt_id>`, then `mv`ed into place.
- Returns `1` (and prints `"Flag require a string as parameter"` to both stdout and stderr) only if the argument is genuinely missing — an empty string argument is accepted.
- Shared across all steps of the task; later calls (from any step) overwrite earlier ones.
- After all steps finish, the scheduler reads `THEJOB_FLAG_FILE` into `Task::flag_`, serialized as the `flag` field in the task JSON and in `GET /api/user/<user>/<jobType>/tasks`. The Board history view uses `flag.color` to color task entries.

---

## Monitor Function

If the flow JSON declares a `monitor` block for a step, the named function must exist in the script:

```json
"monitor": {
  "entry_point": "MonitorBuild",
  "delay_start": "5s",
  "interval": "30s",
  "timeout": "10s"
}
```

```bash
MonitorBuild() {
  local output_file="$1"          # always the first argument
  # extra args passed to StartMonitor arrive as $2, $3, ...
  echo "lines compiled: $(wc -l < progress.txt)" > "${output_file}.tmp"
  mv "${output_file}.tmp" "${output_file}"
}
```

**Contract:**
- `$1` is the path to write status to (`<runPath>/monitors/<taskID>-<stepID>.txt`). **Write atomically** (temp file + `mv`) — the scheduler's inotify watch listens for `IN_MOVED_TO` only, not plain writes; a direct `echo ... > "$1"` will never be picked up.
- The function must complete within `timeout` if configured, or it is killed (`"monitor has timeouted"` is appended to the output).
- Runs in a separate bash subshell that re-sources `functions.sh` and the step script — do not rely on parent-shell state.
- The written content becomes `Step::message_from_run_`, exposed as `message_from_run` in `GET /api/tasks/running`.

See `samples/jobs/tests/test_monitor.sh`/`.json` for a working example (`Step3` calls `StartMonitor 1 2 3` and defines `MonitorStep3`).

---

## Shutdown Variant

When the scheduler cancels a running step (or it times out), it re-invokes `executor.sh` with `THEJOB_SHUTDOWN=1`, which causes it to look up and call `<FunctionName>__Shutdown` instead of `<FunctionName>`:

```bash
Experiment() {
  fuzzer &
  FUZZER_PID=$!
  wait ${FUZZER_PID}
}

Experiment__Shutdown() {
  # graceful cleanup — called on cancel/timeout
  pkill -f tlspuffin || true
}
```

- If `<FunctionName>__Shutdown` is not defined, `executor.sh` exits `0` silently — no error.
- The shutdown variant runs in a **new** process, not the original step's shell. There is no shared in-memory state; coordinate only through the filesystem.

---

## User State File

Write structured data to `THEJOB_USER_STATE_FILE` to attach end-of-step metadata to the step record:

```bash
Experiment() {
  local exec_rate=$(compute_rate)
  echo "{\"exec_per_sec\": ${exec_rate}, \"corpus\": $(ls corpus/ | wc -l)}" \
      >> "${THEJOB_USER_STATE_FILE}"
}
```

- Multiple `>>` appends are allowed; the scheduler reads the whole file as one string.
- Exposed as `user_run_state` on the step in `GET /api/tasks/running`.
- **Exception:** for the task's **last** step, the scheduler overwrites this with `"flow ended"` or `"flow cancelled"` regardless of what the script wrote.

---

## Global Parameters Between Steps

```bash
# Step A
Init() {
  AddGlobalParam "NB_CLIENTS" "8"
}

# Step B (runs after A)
Experiment() {
  echo "Using ${NB_CLIENTS} clients"
}
```

- `AddGlobalParam` accumulates into `THEJOB_GLBPARMS` in memory.
- At step end, if `THEJOB_UNIQ_STEP=1`, the accumulated params are appended/rewritten to `THEJOB_ENV_PATH`.
- The next step's `SetupEnv` reads and `eval`s `THEJOB_ENV_PATH` — each param becomes a real shell variable.
- Task-level `args` (submitted at `POST /api/task/new`) are seeded into `THEJOB_ENV_PATH` the same way, once, before the first step runs (`Task::PrepareToRun()`), so they are indistinguishable from global params to later steps.
- When a step has retries (`nb_retry > 1`) and `THEJOB_UNIQ_STEP=0` (not the last attempt), params are **not** written to disk — only the final attempt in a retry chain propagates params forward.

---

## Retry Behaviour

When `nb_retry > 1`, the scheduler creates `nb_retry` attempt instances at parse time, chained via `next_`. Each attempt calls the **same function from scratch** — there is no automatic state transfer between attempts.

```bash
Build() {
  if [ "${THEJOB_STEP_ATTEMPT_ID}" -gt 0 ]; then
    echo "Retry attempt ${THEJOB_STEP_ATTEMPT_ID}, cleaning previous output"
    rm -rf build/
  fi
  cargo build --release
}
```

---

## Flow JSON Schema

### Top-level fields

| Field | Required | Meaning |
|-------|----------|---------|
| `name` | no | Task name |
| `flow` | yes | Array describing the step DAG (see below) |
| `priority` | no | `int64`; higher runs sooner. Often supplied as `${RUNTIME_PRIORITY}` |
| `configurations` | no | Object of named, reusable `configuration` blocks, referenced from `run` |
| `publish` | no | `{ "server": "<publisher name>", "storage": "...", "goal": "...", "check_server_certificat": bool }` |

**Runtime placeholder substitution.** Before the flow JSON is parsed, the scheduler textually substitutes a **fixed** set of `${RUNTIME_*}` placeholders (`Schedule::AddTask()`), sourced from the `runtime[KEY]` multipart fields of the submit request, with defaults if omitted:

| `runtime[KEY]` | Placeholder | Default |
|----------------|-------------|---------|
| `NB_RUN` | `${RUNTIME_NB_RUN}` | `1` |
| `NB_CORES` | `${RUNTIME_NB_CORES}` | `1` |
| `TIMEOUT` | `${RUNTIME_TIMEOUT}` | `3h` |
| `MEMORY_CORE` | `${RUNTIME_MEMORY_CORE}` | `0` |
| `MEMORY_CONSUMPTION` | `${RUNTIME_MEMORY_CONSUMPTION}` | `0` |
| `RUN_SELECT` | `${RUNTIME_RUN_SELECT}` | `""` |
| `RUN_CONFIG` | `${RUNTIME_RUN_CONFIG}` | `""` |
| `PRIORITY` | `${RUNTIME_PRIORITY}` | `0` |

No other runtime keys are substituted at this stage. Example (`samples/jobs/tests/test_priority_flow.json`):
```json
{
  "name": "Priority Test",
  "priority": ${RUNTIME_PRIORITY},
  "flow": [
    { "step": "Sleep", "configuration": { "nb_cores": ${RUNTIME_NB_CORES}, "nb_retry": 1 } }
  ]
}
```

A **separate** substitution happens later, at archive/publish time, for `${VAR}` placeholders inside the `publish` block (`storage`, `goal`) — these resolve against a variable map built from accumulated global params, the task's own `args[KEY]` (from submission), and `TASK_ID`/`TASK_USER`/`TASK_JOB_TYPE`. Example (`samples/jobs/tests/test_publish.json`):
```json
"publish": {
  "server": "default",
  "storage": "Y/Tests/${COMMIT_ID}/",
  "goal": "Mesurer PR/Commit ${COMMIT_ID}"
}
```
(here `${COMMIT_ID}` resolves from `args[COMMIT_ID]` submitted with the task, not from `runtime[...]`).

### `flow[]` elements — steps and groups

Each element of `flow` is either:
- **a step object** — `{"step": "<FunctionName>", "run": [...], "configuration": {...}, "monitor": {...}, "streams": [...]}`, or
- **a group** — a raw JSON array of step objects that run sequentially and share a common working directory/dependency chain. A group may open with an anonymous fan-out entry (an object with no `"step"` key) applying a shared `run`/`configuration` to the whole group.

Dependencies are **implicit** from the position in `flow`/inside a group: each element (or group) depends on the previous one; steps in a fanned-out `run` all depend on the previous element and are all depended upon by the next one. There is no explicit `depends_on`/`dependencies` field to set from the flow JSON author's side — it is derived purely from array nesting and ordering, then exposed read-only as `dependencies`/`uuid` links in `Step::ToJSON()`.

Group example (`samples/jobs/tests/test_steps_group.json`):
```json
{
  "flow": [
    { "step": "Init", "configuration": { "nb_retry": 1 } },
    [
      { "run": ["Conf_A", "Conf_B", "Conf_C"],
        "configuration": { "nb_retry": 2, "custom": { "Conf_A": { "nb_retry": 3 } } } },
      { "step": "Build" },
      { "step": "Test", "configuration": { "timeout": "2m" } },
      { "step": "Verify" }
    ],
    { "step": "Summary", "configuration": { "nb_retry": 1 } }
  ]
}
```
`Init` runs first; `Build`/`Test`/`Verify` then each run once per rank (`Conf_A`/`Conf_B`/`Conf_C`, exposed to the script as `THEJOB_STEP_RANK_ID`), sharing a working directory per group; `Summary` runs once after the whole group completes. Inside the step function, `THEJOB_STEP_GROUP_ID` is set (non-empty) only for steps inside the group.

### `configuration` object (per step, per group, or named under top-level `configurations`)

| Field | Type | Meaning |
|-------|------|---------|
| `id` | string | Name for this configuration (defaults to the step name) |
| `executor_name` | string | Executor backend to use |
| `nb_cores` | uint32 | CPU cores to assign |
| `nb_retry` | uint32 | Number of attempts |
| `timeout` | duration string (`"30s"`, `"2m"`, `"3h"`) | Step timeout |
| `memory_core` / `memory_consumption` | uint64 | cgroup memory hints |
| `args` | object | Step arguments, become shell variables (see above) |
| `custom` | object, keyed by config name | Per-named-config overrides, e.g. `"custom": {"Conf_A": {"nb_retry": 3}}` |

### `run` — fanning a step out into ranks

`run` is an array; each entry becomes one rank (`THEJOB_STEP_RANK_ID`) of the step, all running the same function:
- a plain string names a top-level `configurations` entry: `"run": ["Conf_Base", "Conf_Fast"]`;
- an inline object supplies ad-hoc overrides: `"run": [{"args": {"source": "inline"}}]`;
- `{"configuration": "<name>", "override": {"args": {...}}}` starts from a named configuration and overrides specific fields (the `override` wins over the named configuration, which wins over the step/group-level `configuration`);
- each run entry may set its own `nb_retry`.

See `samples/jobs/tests/test_config_override.sh`/`.json` for a complete illustration of this merge order, and `samples/jobs/tests/test_heavy_stdout.json` for fanning one step over several named `configurations` entries.

### `monitor` object — see "Monitor Function" above for the field table (`entry_point`, `interval`, `timeout`, `delay_start`).

### `streams` — live file tailing

```json
"streams": [
  { "name": "growing", "path": "log/growing.log" },
  { "name": "status",  "path": "log/status.json" }
]
```
Declares extra files (relative to the step's run directory) that the dashboard can tail live in addition to stdout/stderr, fetched via `GET /api/task/<id>/<uuid>/<stepID>/output/<streamIndex>/<size>/<offset>` (see `docs/api.md`). See `samples/jobs/tests/test_stream_display.sh`/`.json`.

### Priority

```json
{ "name": "Priority Test", "priority": ${RUNTIME_PRIORITY}, "flow": [ ... ] }
```
`priority` is a signed 64-bit integer; higher values are scheduled sooner. It can also be changed after submission via `PATCH /api/task/<taskID>/<priority>`.
