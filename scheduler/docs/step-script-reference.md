# Step Script Reference

A step script is a bash file submitted alongside the flow JSON. It defines named functions that the scheduler calls — one function per step. This document describes the complete execution environment available to those functions.

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

The scheduler calls `executor.sh`, which sources the script and invokes the function by name. If the function is not defined, the step fails immediately.

---

## Execution Environment

`executor.sh` populates the following variables before calling the step function. They are available as plain bash variables — no export needed.

### Paths

| Variable | Content |
|----------|---------|
| `THEJOB_ROOT_PATH` | Task run root directory (`<runPath>/<taskID>/`) |
| `THEJOB_OUT_PATH` | Task outputs subdirectory |
| `THEJOB_ARTEFACTS_PATH` | Directory where artefact files should be placed |
| `THEJOB_ARTEFACTS_FILE` | JSON file to append artefact entries to (via `CreateArtefact`) |
| `THEJOB_USER_FILES_PATH` | Directory containing uploaded input files |
| `THEJOB_TOOLS_PATH` | Shared tools directory (read-only) |
| `THEJOB_FUNCTIONS_PATH` | Path to this script (already sourced — available for re-sourcing in subshells) |
| `THEJOB_ENV_PATH` | File storing global params shared between steps (`AddGlobalParam`) |
| `THEJOB_PARAMETERS_PATH` | File containing step args and task args (already evaluated by `SetupEnv`) |
| `THEJOB_USER_STATE_FILE` | File for end-of-step structured metadata (see User State below) |
| `THEJOB_STDOUT_PATH` | Path of the stdout log file |
| `THEJOB_STDERR_PATH` | Path of the stderr log file |

### Step Identity

| Variable | Content |
|----------|---------|
| `THEJOB_STEP_ID` | Step string ID (e.g. `"0-0-0"`) |
| `THEJOB_STEP_NUMID` | Step numeric index in the flow |
| `THEJOB_STEP_RANK_ID` | Rank within a parallel group (0 for non-grouped steps) |
| `THEJOB_STEP_ATTEMPT_ID` | Retry attempt number, 0-based |
| `THEJOB_RUN_ID` | Run ID within the task |
| `THEJOB_STEP_GROUP_ID` | Group ID — only present if the step belongs to a group |

### Resources

| Variable | Content |
|----------|---------|
| `THEJOB_CORES` | Comma-separated list of assigned CPU core indices (e.g. `"2,3,4,5"`) |
| `THEJOB_NB_CORES` | Number of assigned cores (derived from `THEJOB_CORES` by `executor.sh`) |
| `THEJOB_CACHE_PORT` | Port of the local cache HTTP server |

### Control

| Variable | Content |
|----------|---------|
| `THEJOB_UNIQ_STEP` | `1` if this step has no retries or is the last in its retry chain; `0` otherwise |
| `THEJOB_SHUTDOWN` | Set to `1` only when the scheduler calls the shutdown variant (see below) |
| `THEJOB_PID` | PID of the `executor.sh` process (= session ID of the step process group) |

### Step Arguments

Step `args` and task `args` from the flow JSON are evaluated into shell variables by `SetupEnv` at startup. They are directly accessible by name:

```bash
# Flow JSON: "args": {"COMMIT_ID": "abc123"}
Build() {
  echo "Building commit: ${COMMIT_ID}"
}
```

---

## API — `functions.sh`

Sourced automatically by `executor.sh`. All functions below are available without any `source` or `import`.

---

### `QueryCache [-q] <cache_id> [timeout_s]`

Polls the cache until the file for `cache_id` is ready, then prints its path.

```bash
local binary=$(QueryCache -q "abc123_openssl_asan" 300)
# $binary = /cache/storage/abc123_openssl_asan  (or empty on failure)
```

| Option | Effect |
|--------|--------|
| `-q` | Quiet: prints only the file path on success, nothing otherwise |
| (none) | Verbose: prints progress on each poll |

| Exit code | Meaning |
|-----------|---------|
| `0` | File ready, path printed to stdout |
| `1` | Missing `cache_id` parameter |
| `2` | File explicitly not available (`Not Available` state) |
| `3` | Unexpected response from cache server |
| `4` | Timeout reached before file became ready |

`timeout_s=0` (default) means wait forever.

---

### `SetCache <cache_id> <file>`

Registers a local file in the cache under `cache_id`.

```bash
SetCache "abc123_openssl_asan" "/path/to/tlspuffin"
```

- `file` must be readable; returns `64` immediately if not.
- The registration is **asynchronous** — the cache worker copies the file in the background. Use `QueryCache` to wait for it.
- Returns the `curl` exit code.

---

### `AddGlobalParam <key> <value>`

Exposes a key/value pair to all **subsequent** steps of the same task.

```bash
AddGlobalParam "AFL_CORES_GRAMMAR" "4"
```

**Important constraints:**
- Parameters accumulate in memory in `THEJOB_GLBPARMS` during the step.
- They are written to `THEJOB_ENV_PATH` **only at step end**, and **only if `THEJOB_UNIQ_STEP=1`** (i.e. no retries, or last attempt). Earlier attempts in a retry chain do not propagate their params.
- Parameters are available to later steps in the flow, **not** to parallel steps running concurrently.
- Values containing `"` are escaped automatically.

---

### `CreateArtefact <path> <name> [key:value ...]`

Registers an output file as a named artefact with optional metadata.

```bash
CreateArtefact "/work/stats.json" "stats" "run:0" "attempt:0"
CreateArtefact "/work/corpus.tar" "corpus" "size:1234" "compressed:true"
```

- `path` is resolved to an absolute path via `realpath`.
- Metadata values are typed automatically: integers and `true`/`false`/`null` become JSON primitives; anything else becomes a JSON string.
- The entry is appended (as one JSON line) to `THEJOB_ARTEFACTS_FILE`.
- The file must exist and be accessible at the time the artefact is registered.

---

### `AbortFail <command> [args...]`

Runs a command and fails if it returns non-zero.

```bash
AbortFail cargo build --release
AbortFail make -j${THEJOB_NB_CORES}
```

**Caveat:** `AbortFail` uses a subshell (`( cmd || false )`). If the command fails, the subshell exits with 1, but the parent script continues unless `set -e` is active or the call is part of an expression that propagates failure. Combine with `|| return 1` or `set -e` to ensure the step aborts:

```bash
set -e
AbortFail some_command   # step exits on failure
```

---

### `EndDirectChild <pid>`

Terminates a direct child process gracefully.

```bash
my_daemon &
MY_PID=$!
# ... later ...
EndDirectChild ${MY_PID}
```

- Sends `SIGTERM`, waits up to 4 s (8 × 0.5 s); if still alive, sends `SIGKILL`.
- **Only works on direct children** of the current shell — exits with error if `ppid ≠ $$`.
- Prints the process exit code to stdout on success.
- Returns `0` on success, `1` on failure (wrong parent or unkillable).

---

### `StartMonitor [args...]`

Starts the step's monitor function as a background loop.

```bash
StartMonitor   # no args
StartMonitor "${EXPERIMENT_DIR}"   # args forwarded to monitor function each call
```

- No-op if no `monitor` block was configured for this step in the flow JSON.
- No-op if the monitor is already running.
- The monitor function is called in a loop: `delay_start` wait, then every `interval`, each call wrapped in `timeout` if configured.
- Arguments passed to `StartMonitor` are forwarded to the monitor function on **every** invocation.

---

### `StopMonitor`

Stops the monitor background loop and runs the monitor function one final time.

```bash
StopMonitor   # usually not needed — called automatically by executor.sh at step end
```

Called automatically by `executor.sh` after the step function returns. Only call it manually if you need a final monitor snapshot before the step ends.

---

## Monitor Function

If the flow JSON declares a `monitor` block, the named function must be defined in the script:

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
  local output_file="$1"   # always the first argument — write status here
  # ... extra args passed from StartMonitor come as $2, $3, ...

  echo "lines compiled: $(wc -l < progress.txt)" > "${output_file}.tmp"
  mv "${output_file}.tmp" "${output_file}"
}
```

**Contract:**
- `$1` is the path to write the monitor status to. Write atomically (write to `.tmp` then `mv`) to avoid the scheduler reading a partial file.
- The function must complete within `timeout` seconds if configured; otherwise it is killed and `"monitor has timeouted"` is appended to the output file.
- The function is called in a separate bash subshell that re-sources `functions.sh` and the step script — avoid side effects that depend on the parent shell's state.
- The content written to `$1` becomes `Step::message_from_run_` and is visible in `GET /api/tasks/running` as `"monitor_message"`.

---

## Shutdown Variant

When the scheduler cancels a running step, it re-invokes `executor.sh` with `THEJOB_SHUTDOWN=1`. In that case, `executor.sh` calls `<FunctionName>__Shutdown` instead of `<FunctionName>`.

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
- The shutdown variant runs in a **new** process, not in the same shell as the original step. No shared variables; rely only on filesystem state.

---

## User State File

Write structured data to `THEJOB_USER_STATE_FILE` to attach end-of-step metadata to the step record:

```bash
Experiment() {
  # ... run fuzzer ...
  local exec_rate=$(compute_rate)
  echo "{\"exec_per_sec\": ${exec_rate}, \"corpus\": $(ls corpus/ | wc -l)}" \
      >> "${THEJOB_USER_STATE_FILE}"
}
```

- Multiple `>>` appends are allowed; the scheduler reads the whole file as a single string.
- The content appears in `GET /api/tasks/running` as `"user_run_state"` on the step.
- **Exception:** for the **last step** of a task, the scheduler overwrites this value with `"flow ended"` or `"flow cancelled"` regardless of what the script wrote.

---

## Global Parameters Between Steps

```bash
# Step A
Init() {
  local nb_clients=8
  AddGlobalParam "NB_CLIENTS" "${nb_clients}"
}

# Step B (runs after A)
Experiment() {
  echo "Using ${NB_CLIENTS} clients"   # available as a shell variable
}
```

- `AddGlobalParam` writes to `THEJOB_GLBPARMS` in memory.
- At step end, if `THEJOB_UNIQ_STEP=1`, the accumulated params are written to `THEJOB_ENV_PATH`.
- The next step's `SetupEnv` reads `THEJOB_ENV_PATH` and `eval`s it — each param becomes a shell variable.
- **`THEJOB_UNIQ_STEP=0`** (step has retries and this is not the last attempt): params are **not** written to disk. Only the last attempt in a retry chain propagates params to subsequent steps.

---

## Retry Behaviour

When `nb_retry > 1`, the scheduler creates `nb_retry` attempt instances at parse time. Each attempt calls the **same function from scratch** — there is no automatic state transfer between attempts.

The step function should be written idempotently, or check `THEJOB_STEP_ATTEMPT_ID` to resume:

```bash
Build() {
  if [ "${THEJOB_STEP_ATTEMPT_ID}" -gt 0 ]; then
    echo "Retry attempt ${THEJOB_STEP_ATTEMPT_ID}, cleaning previous output"
    rm -rf build/
  fi
  cargo build --release
}
```
