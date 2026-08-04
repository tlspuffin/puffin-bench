# Scheduler — Task and Step Lifecycle

## Overview

A **Task** is the top-level unit of work submitted by a client. It owns a directed acyclic graph (DAG)
of **Steps**, each of which maps to a single bash function executed by an executor (see
[executor.md](executor.md)). `Schedule::ScheduleLoop()` walks the DAG, dispatches steps whose
dependencies are satisfied, and archives the result once the last step of a task finishes.

Source of truth for this document: `src/scheduler/schedule/task.hxx/.cxx`,
`src/scheduler/schedule/step.hxx/.cxx`, `src/scheduler/schedule/step_configurations.hxx/.cxx`,
`src/scheduler/schedule/tasksmanager.hxx/.cxx`, `src/scheduler/schedule/schedule.cxx`.

---

## Task

### Identity and Paths

A Task is identified by a `uint64_t id_`. `TasksManager::CreateTask()` sets it to the current
submission timestamp in milliseconds, bumped forward if a previous task already claimed that
millisecond (`next_task_id_`, protected by `TasksManager::lock_`). Filesystem paths derived from
the ID:

```
run_root_path_  = <runPath>/<id>
logs_path_      = <run_root_path_>/logs
outputs_path_   = <run_root_path_>/output
artefacts_path_ = <run_root_path_>/artefacts
env_path_       = <run_root_path_>/.taskenv

files_path_     = <userPath>/<id>              (uploaded input files)
functions_path_ = <userPath>/<id>/<id>.sh       (uploaded step-function script)
tools_path_     = <toolsPath>                   (shared, not per-task)
monitors_path_  = <monitorsRootPath>            (shared, not per-task)
```

`run_root_path_`, `logs_path_`, `outputs_path_` and `artefacts_path_` are created lazily by
`Task::PrepareToRun()` → `CreateRunFolders()`, the first time a root step of the task actually
executes — not at task-creation time.

### Notable Fields

| Field | Type | Description |
|-------|------|-------------|
| `id_` | uint64_t | Millisecond timestamp at submission (monotonic, deduplicated) |
| `name_` | string | Human-readable label, template-expanded from `args_` + `task_id` |
| `user_`, `job_type_` | string | Ownership and categorisation |
| `executor_name_` | string | Which executor handles this task (`"default"` if unset) |
| `executor_` | `Executor*` | Resolved pointer to the executor instance |
| `executor_data_` | `ExecutorTaskData*` | Per-task executor state (e.g. cgroup path, `LocalTaskData`) |
| `root_steps_` | `list<Step*>` | Entry points (no dependencies) |
| `args_` | `unordered_map` | Global key/value parameters, merged with the JSON `args` block |
| `configurations_` | `StepConfigurations` | Named step configuration profiles with defaults |
| `state_` | `Task::State` | `Pending`, `Running`, `Done`, `Cancelled` |
| `publish_` | `Publish` | Result publication config (server, storage path, goal) |
| `publish_link_` | string | View URL built from `publish_.ViewLink()` after archival |
| `flag_` | string | JSON string set by `Flag()` in step scripts; read from `THEJOB_FLAG_FILE` by `Local::TaskFinalize()` |
| `request_cancel_`, `cancel_source_` | bool, string | Set by `Task::Cancel()`, polled by the schedule loop |
| `md5_` | `map<string,string>` | MD5 checksums of the uploaded functions script and input files |
| `priority_` | int64_t | Determines position in `Schedule::steps_` (higher runs first) |
| `metadata_index_lock_` | `std::mutex` | Serialises appends to `artefacts/metadata.json` across concurrent steps of the same task (taken in `Local::SaveArtefacts()`) |

### Lifecycle

```
TasksManager::CreateTask()
  - allocate id_, write uploaded functions/files to <userPath>/<id>/, compute MD5s
  - new Task(...) -> CreateStepsFromJson() builds the full Step DAG (all retry
    attempts pre-created, see "Retries" below)
  |
  v
Schedule::AddTask()
  - inserts task->root_steps_ into Schedule::steps_ (position ordered by priority_)
  - starts the ScheduleLoop thread if it was not already running
  |
  v
Schedule::ScheduleLoop()  [background thread]
  - Executor::FindRunnableSteps() selects ready steps that fit current resources
  - first time a task's root step runs: Task::PrepareToRun()
      -> Local::TaskPrepareToRun() (create per-task cgroup dir)
      -> Task::CreateRunFolders()  (run_root_path_, logs_path_, outputs_path_, artefacts_path_)
      -> state_ = Task::State::Running
  - each step goes through its own state machine (see below)
  |
  v
Step::TaskLastStep() true for the step that completes the task
  -> Task::FinalizeAndArchive(savePath)
       - moves artefacts/ and logs/ into <exportPath|exportCanceledPath>/<id>/
       - writes <exportPath>/<id>.json (task snapshot)
       - Local::TaskFinalize() reads the per-task flag file into Task::flag_
       - removes run_root_path_, functions_path_, files_path_
       - returns an ArchiveJob describing what to zip
  -> Archiver::AddJob() (async .zip creation + optional publish, see below)
  -> TasksManager::TaskEnded() (task and all its Step objects are deleted)
```

Cancellation (`Task::Cancel(source)`) sets `state_ = Cancelled` and `request_cancel_ = true`
immediately — it does not itself touch any Step. It is called under `Schedule::lockThread_`
(from `Schedule::CancelTask()` or from `Schedule::LimitRessourcesUsages()` on resource pressure).
The schedule loop, on its next iteration (also under `lockThread_`), scans `steps_` and kills or
cancels every step of a task with `request_cancel_` set — see the Execution Flow section.

### Task JSON persistence

`Task::ToJSON()` serialises the full task (paths, args, publish config, MD5s, state, flag, and —
unless called with a non-null `step` pointer — the entire `steps` map keyed by step UUID) into
`tasksmanager.json` on every scheduling iteration via `Schedule::SaveStatus()`. A second
constructor, `Task(rapidjson::Value const& config, ...)`, rebuilds a `Task` and its `Step` graph
from that same JSON shape; it is used only by `TasksManager::LoadStatus()`, which is **currently
disabled** — see "State Persistence and Reload" below.

---

## Step

### Identity

Each Step carries two identifiers:
- `uint64_t uuid_` — globally unique, assigned from a static `std::atomic<uint64_t> next_uuid_`
  counter at construction.
- `std::string id_` — the configuration name/id resolved by `StepConfigurations` (informational,
  not unique).

Hierarchical coordinates:

| Field | Meaning |
|-------|---------|
| `step_id_` | Index of this step's position in the flow definition |
| `run_id_` | Position within a `run` (parallel parameterisation) instance list |
| `rank_id_` | Rank within a run (distinguishes parallel instances of the same step) |
| `attempt_id_` | Retry counter (0-based) |
| `group_id_` | Non-zero if the step belongs to a parallel group (`flow` array-of-arrays entry) |

`ID()` returns `"<step_id>-<rank_id>-<attempt_id>"` and identifies one execution attempt.
`GID()` returns `"<group_id-1>-<rank_id>-<attempt_id>"` and identifies a group's shared
run-directory / artefacts-file key (all steps of a group share one working directory).

### State Machine

```
                    ┌─────────┐
                    │ Pending │  ← initial state
                    └────┬────┘
                         │ MarkRunning() (via Step::Execute())
         MarkCancel()    │
       (Pending only)    │           KillAndMarkCancel()
              ┌──────────┤           (Pending or Running;
              │          │            Running -> Shutdown() first)
              ▼          ▼
        ┌───────────┐ ┌─────────┐
        │ Cancelled │◄┤ Running │
        └───────────┘ └────┬────┘
                       ┌────┼─────────────┬───────────────────┐
                  MarkDone()      KillAndMarkTimedout()   Step::Shutdown()
                  (exit code,      (executor timeout       (server shutdown,
                   any value)       check in loop)          only if state==Running)
                       │                  │                        │
                       ▼                  ▼                        ▼
                  ┌────────┐        ┌───────────┐           ┌──────────┐
                  │  Done  │        │ TimedOut  │           │ Shutdown │
                  └────────┘        └───────────┘           └──────────┘

  (fork/exec failure inside Executor::Execute -> MarkLaunchError() -> LaunchError,
   independent of the diagram above; the step never reaches Running)
```

`State` values (private enum, `step.hxx`): `Pending`, `Running`, `Done`, `TimedOut`, `Cancelled`,
`Shutdown`, `LaunchError`. `IsDone()` is `state_ >= State::Done` — the enum order makes every
terminal state true, including `Done` itself.

Transition methods (`step.hxx`, all `inline`):
- `MarkRunning()` — Pending → Running only; throws otherwise. Records `time_points_[0]`.
- `MarkDone(exit_code)` — Running → Done only; throws otherwise. Records `time_points_[1]`.
- `MarkCancel()` — Pending → Cancelled only; throws otherwise (no process exists to kill).
- `KillAndMarkCancel()` — if Running, calls `Executor::Shutdown()` first, then → Cancelled from
  either Pending or Running.
- `KillAndMarkTimedout()` — unconditionally calls `Executor::Shutdown()`, then → TimedOut.
- `MarkLaunchError()` — → LaunchError, exit code `exitCode_LaunchError_`.
- `Shutdown()` — only acts if `state_ == Running`: calls `Executor::Shutdown()`, → `Shutdown`.
- `MarkPending()` — resets to Pending and deletes `executor_data_`; used only by
  `Local::CheckReloadRunning()` when a previously-running step cannot be reattached after a
  restart (reload path, currently unused in practice — see below).

`IsReady()` returns `state_ == Pending && depend_from_.empty()` — a step becomes runnable purely
by having no more unmet upstream dependencies, independent of resources; resource fit is checked
separately by `Executor::FindRunnableSteps()`.

### Exit Code Flags (`exit_code_`, bitfield)

| Hex | Constant | Meaning |
|-----|----------|---------|
| `0x0100` | `exitCode_NotSet_` | Step never ran |
| `0x0200` | `exitCode_Timedout_` | Timed out |
| `0x0400` | `exitCode_Cancelled_` | Cancelled |
| `0x0800` | `exitCode_LaunchError_` | fork/exec failed |
| `0x1000` | `exitCode_NoExitCode_` | Process ended without a readable exit status |
| `0x2000` | `exitCode_Killed_` | Killed by SIGKILL (`IsOSKilled()` — triggers task cancel, see below) |
| `0x4000` | `exitCode_Lost_` | Process disappeared without a trace during reload check |

`MarkDone(code)` with a plain 0–255 process exit status stores that value directly (no flag bit
set for a clean or non-zero exit). `IsOSKilled()` is `state_ == Done && exit_code_ ==
exitCode_Killed_`; `ScheduleLoop()` reacts to it by calling `CancelTask(..., "Killed by SIGKILL
(maybe cgroup memory.max)")` on the whole task — a single OOM-killed step cancels its entire task.

### Group Status Flags (`group_status_`)

| Hex | Constant | Meaning |
|-----|----------|---------|
| `0x0000` | `stepsGroup_None_` | Not part of a group |
| `0x0001` | `stepsGroup_In_` | Middle step of a group |
| `0x0003` | `stepsGroup_Begin_` | First step of a group |
| `0x0005` | `stepsGroup_End_` | Last step of a group |

Steps of a group share one working directory and artefacts file, keyed by `GID()` instead of
`ID()` (see `Local::Execute()`). `Local::EndRun()` only flushes artefacts and removes the run
directory when `group_status_` is `None` or `End` (or the task is cancelled) — intermediate group
steps leave the shared directory in place for the next step in the group.

### Dependency Graph

```cpp
step.dependencies_   // list<Step*> — downstream steps waiting on this step ("down")
step.depend_from_    // list<Step*> — upstream steps this step is still waiting for ("up")
step.previous_       // Step*       — previous node in the retry/rank ring (see below)
step.next_           // Step*       — next node in the retry/rank ring
```

`previous_`/`next_` form a circular linked list over every duplicate of a logical step: retry
attempts (`attempt_id_`) and, for a `run` list, parallel rank instances (`rank_id_`) are chained
together via `next_`, and the ring closes back to the first instance via `previous_`. This is how
`Step::TaskFirstStep()` / `TaskLastStep()` walk "all copies of this logical step" to decide
whether every rank/attempt has finished.

`Schedule::ManageEndOfStep()` removes the finished step from `dependencies_child->depend_from_`
for every downstream step; once a downstream step's `depend_from_` list is empty it is spliced
back into `Schedule::steps_` right before the just-removed step's position, making it eligible for
`IsReady()` / dispatch on the next loop iteration.

### Notable Fields

| Field | Type | Description |
|-------|------|-------------|
| `task_` | `Task*` | Parent task |
| `function_` | string | Bash function name to call |
| `args_` | `unordered_map` | Step-local key/value parameters (from configuration + `run` override) |
| `nb_cores_` | uint32_t | CPU cores requested |
| `nb_retry_` | uint32_t | Number of attempts pre-generated for this logical step |
| `memory_max_` | uint64_t | cgroup `memory.max` in bytes (derived, see StepConfigurations) |
| `timeout_` | uint64_t | Execution timeout in seconds (0 = unlimited) |
| `stdout_`, `stderr_` | path | `<logs_path_>/stdout.<ID>.txt` / `stderr.<ID>.txt` |
| `monitor_` | `shared_ptr<ns_Monitor::Task>` | Optional periodic monitor configuration |
| `monitor_count_` | int32_t | Present in the model for delayed end-of-step cleanup while a monitor is still active; always constructed at `0` and never incremented anywhere in the current codebase, so `ManageEndOfStep()` always takes the immediate path today (see Execution Flow) |
| `executor_data_` | `ExecutorData*` | Per-step executor state (pid, cores, pipes, cgroup path — `LocalData`) |
| `user_run_state_` | string | Structured metadata written by the step script at end of run |
| `readable_files_` | `vector<Stream>` | Named extra output streams (`streams` config), readable via `GetRunningOutput()` with a numeric `type` index |

### User Run State — file-based side channel

At step end, `Local::EndRun()` reads the file `THEJOB_USER_STATE_FILE` (path injected by
`executor.sh` into the shell environment) and stores its content verbatim via
`Step::SetUserRunState()`. It is serialised into `Step::ToJSON()` as `"user_run_state"` and
exposed through the running-steps API.

### Step Configuration (`StepConfigurations`)

`Task::configurations_` holds named profiles read from the flow JSON's `configurations` block, via
`StepConfigurations::ReadFromTaskJSON()`. At step creation, `Step::ReadFromTaskJSON()` calls
`StepConfigurations::MakeWithOverrides(name, stack)`, which merges in order:

1. The built-in default (`nb_cores=1, nb_retry=1, timeout=0`, no memory limit).
2. The named configuration (`configurations_.find(name)`) if the step references one by name.
3. Every entry in the `overrides` stack, applied in order — group-level `configuration`, then
   step-level inline `configuration`, then (pushed last, so highest priority) the per-`run`
   override object.

`memory_max_` is derived, not set directly: `memory_core + memory_consumption * timeout`.

#### `nb_retry` inside a group

Outside a group, `nb_retry_` follows the merge above unmodified. **Inside** a group
(`group_status_ != stepsGroup_None_`), `Step::ReadFromTaskJSON()` immediately overwrites the
merged `nb_retry_` with `GroupStepConfigurations::NbRetry(configName)` — any `nb_retry` set in the
step's own `configuration` block is silently discarded in favor of the group's `configuration` /
`configuration.custom.<name>` value.

#### Retries and `run` — static structure

Both are resolved entirely inside `Task::CreateStepsFromJson()` at task-submission time, not at
execution time:
- A `run` array with N entries creates N sibling `Step` instances (distinct `rank_id_`), chained
  via `next_`/`previous_`.
- `nb_retry_ = R` creates R attempt copies per rank (distinct `attempt_id_`), also chained via
  `next_`/`previous_`, all sharing the same `depend_from_`/`dependencies_` set as the first
  attempt.

If `attempt_id=0` fails, `attempt_id=1` becomes ready via the same downstream/upstream removal
logic used for any dependency — note that this is NOT automatic in the current code: a failed
attempt still counts as satisfying a downstream dependency once processed by
`ManageEndOfStep()`, since dependency clearing is driven by "this step instance finished", not by
"the logical step's last attempt succeeded". Steps inside a group cannot carry their own `run`
field — `Task::CreateStepsFromJson()` throws `"step inside a group can not have a run field"` (the
`run` list is only valid at the group level or on standalone steps).

---

## Execution Flow (`Schedule::ScheduleLoop`, per iteration)

Locking is fine-grained, not one big loop-body lock — see
[threading-synchronization.md](threading-synchronization.md) for the full picture. Summarised:

```
lockThread_ held:  SearchTasksToRun()
lockThread_ free:  step->Execute() for each runnable step (fork/exec happens unlocked)
                   stepsRunning_.insert(...); monitor_.Add(toRun)
                   LimitRessourcesUsages() (reads OS load, may CancelTask() -> re-locks briefly)
lockThread_ held:  SaveStatus(true)                      (write tasksmanager.json + status.json)
                   -- sleep 500ms --
lockThread_ free:  executor->CheckFinishedSteps(stepsRunning_) for each executor (waitpid, WNOHANG)
                   timeout check: for each running step, IsTimedOut() -> KillAndMarkTimedout()
                   monitor_.GetChange()                   (drain inotify messages)
lockThread_ held:  scan steps_ for request_cancel_ -> KillAndMarkCancel()/MarkCancel()
                   ProcessDelayedCleanup(stepDelayedDelete)  (steps whose monitor_count_ dropped to 0)
                   monitor_.Remove(stepsDone_)
                   for each done step: if monitor_count_ > 0, defer; else ManageEndOfStep()
```

`ManageEndOfStep(step)`:
1. Append the step's JSON to `task->steps_file_` and to the shared `steps_done.json` log.
2. Remove it from `stepsRunning_` and `steps_`.
3. If the task was not cancelled: for each downstream step in `dependencies_`, remove this step
   from that downstream step's `depend_from_`; if now empty, splice the downstream step back into
   `steps_` (becomes eligible for `IsReady()`).
4. `step->GatherFilesToLocal()` (no-op in the current `Local` executor — see executor.md).
5. If `step->TaskLastStep()`: `Task::FinalizeAndArchive()` → `Archiver::AddJob()` (if any sources
   were produced) → `users_.Add(task, false)` → `TasksManager::TaskEnded(task)` (deletes the Task
   and every Step in its DAG).
6. `SaveStatus(false)`.

`SearchTasksToRun()` simply concatenates `Executor::FindRunnableSteps(steps_)` across all
configured executors — resource-fit filtering (cores, memory, priority-band skipping) lives
entirely in the executor, see [executor.md](executor.md).

---

## Task JSON Format (flow definition, submitted by client)

Top-level keys: `name`, `publish`, `configurations` (optional), `flow`, `priority` (optional),
`args` (optional), `executor_name` (optional).

Dependencies between steps are implicit from position in the `flow` array.

### Simple sequential flow

```json
{
  "name": "my-workflow",
  "publish": {
    "server": "results-server",
    "storage": "results/${COMMIT_ID}/",
    "goal": "experiment"
  },
  "flow": [
    { "step": "Build", "configuration": { "nb_cores": 2, "nb_retry": 1 } },
    {
      "step": "Experiment",
      "configuration": { "nb_cores": 8, "timeout": "2h", "args": { "COMMIT_ID": "abc123" } },
      "monitor": { "entry_point": "MonitorExperiment", "delay_start": "10s", "interval": "30s", "timeout": "2h" }
    },
    { "step": "Summary" }
  ]
}
```

### Parallel runs (one step, multiple parameterised instances)

```json
{
  "flow": [
    { "step": "Step1", "run": [ {"Conf_A": {}}, {"Conf_B": {}} ], "configuration": { "nb_retry": 2 } }
  ]
}
```

### Group (multiple steps in parallel, sharing a run list)

```json
{
  "flow": [
    [
      { "configuration": { "nb_retry": 1 }, "run": [ {"Cfg1": {}}, {"Cfg2": {}} ] },
      { "step": "Build" },
      { "step": "Experiment", "configuration": { "timeout": "1h" } }
    ]
  ]
}
```

Individual steps inside a group cannot carry their own `run` field — parsing throws.

---

## State Persistence and Reload

After every scheduling iteration, `Schedule::SaveStatus(exportRunningSteps)` writes:

- **`<exportPath>/tasksmanager.json`** — every live task and step, via `TasksManager::ToJSON()` /
  `Task::ToJSON()` / `Step::ToJSON()`, plus a snapshot of each executor's stats.
- **`<exportPath>/status.json`** — only `stepsRunning_`, a lightweight snapshot for dashboards
  (written whenever `exportRunningSteps` is true, which is every full iteration).

`TasksManager::LoadStatus()` — the deserialisation path that would reconstruct the in-memory Task
and Step graph from `tasksmanager.json`, including reattaching to already-running OS processes via
`Executor::CheckReloadRunning()` — still exists and compiles, but its call site in the `Schedule`
constructor (`schedule.cxx`) is **entirely commented out**: on every process start the scheduler
begins stateless (`steps_`, `stepsRunning_`, `stepsDone_` all empty), regardless of what is on
disk from a previous run. The comment in the source (`"step group not managed by Executor::Local
reload system"`) explains why: the reload path predates step groups and was never updated for
them. On an abnormal shutdown, the JSON on disk is therefore historical record only — it is not
read back on the next start.
