# Task and Step Lifecycle

## Overview

A **Task** is the top-level unit of work submitted by a client. It contains a directed acyclic graph (DAG) of **Steps**, each of which maps to a single bash function executed by an executor. The scheduler walks the DAG, runs steps whose dependencies are satisfied, and archives the result when the last step finishes.

---

## Task

### Identity and Paths

A Task is identified by a `uint64_t id_` set to the submission timestamp in milliseconds. All filesystem paths are derived from this ID:

```
run_root_path_  = <runPath>/<id>
logs_path_      = <runPath>/<id>/logs
artefacts_path_ = <runPath>/<id>/artefacts
outputs_path_   = <runPath>/<id>/outputs
env_path_       = <runPath>/<id>/env

files_path_     = <userPath>/<id>          (uploaded input files)
functions_path_ = <userPath>/<id>/script.sh
tools_path_     = <toolsPath>
```

### Notable Fields

| Field | Type | Description |
|-------|------|-------------|
| `id_` | uint64_t | Millisecond timestamp at submission |
| `name_` | string | Human-readable label |
| `user_`, `job_type_` | string | Ownership and categorisation |
| `executor_name_` | string | Which executor handles this task |
| `executor_` | Executor* | Pointer to the executor instance |
| `executor_data_` | ExecutorTaskData* | Per-task executor state (e.g. cgroup path) |
| `root_steps_` | list\<Step*\> | Entry points (no dependencies) |
| `args_` | unordered_map | Global key/value parameters |
| `configurations_` | StepConfigurations | Named step configs with defaults |
| `publish_` | Publish | Result publication config |
| `request_cancel_` | bool | Set by `Cancel()`, polled by scheduler loop |
| `md5_` | map\<string,string\> | MD5 checksums of uploaded input files |

### Lifecycle

```
Created by TasksManager::CreateTask()
  ↓  (files saved, MD5s computed, steps parsed from JSON)
AddTask() enqueues it in Schedule::tasks_
  ↓
ScheduleLoop() picks up root steps and dispatches them
  ↓  (each step goes through its own state machine — see below)
When last step ends:
  Task::FinalizeAndArchive()
    → builds ArchiveJob
    → Archiver::AddJob()          (async .tgz + optional publish)
    → TasksManager::DeleteTask()  (removed from memory)
```

Cancellation can happen at any point via `Task::Cancel()` which sets `request_cancel_ = true`. The scheduler loop checks this flag before dispatching each next step and calls `KillAndMarkCancel()` on any running step.

---

## Step

### Identity

A Step carries two identifiers:
- `uint64_t uuid_` — globally unique, assigned from a static atomic counter at construction.
- `std::string id_` — set by the executor from other coordinate fields (informational).

The hierarchical coordinates are:

| Field | Meaning |
|-------|---------|
| `step_id_` | Index within the flow definition |
| `run_id_` | Run group (steps with same `run_id_` share a retry budget) |
| `rank_id_` | Rank within the run (ordering within a parallel group) |
| `attempt_id_` | Retry counter (0-based) |
| `group_id_` | Group membership for grouped retry |

`ID()` returns `"<step_id>-<rank_id>-<attempt_id>"` — identifies this execution attempt.
`GID()` returns `"<group_id-1>-<rank_id>-<attempt_id>"` — identifies the step within its group.

### State Machine

```
              ┌─────────┐
              │ Pending │  ← initial state
              └────┬────┘
    MarkCancel()   │  MarkRunning()
    KillAndMark-   │
    Cancel()       │
      ┌────────────┘
      ▼                    ▼
┌───────────┐         ┌─────────┐
│ Cancelled │◄────────│ Running │
└───────────┘  Kill   └────┬────┘
             AndMark   ┌───┼──────────────────────┐
             Cancel()  │   │        │              │
                  exit=0  exit≠0/ timeout       server
                       │  OS kill exceeded      shutdown
                       ▼      ▼       │              │
                    ┌──────┐ ┌──────┐ │              │
                    │ Done │ │ Done │ │              │
                    │(ok)  │ │(fail)│ │              │
                    └──────┘ └──────┘ ▼              ▼
                                ┌──────────┐  ┌──────────┐
                                │ TimedOut │  │ Shutdown │
                                └──────────┘  └──────────┘
```

Transitions vers `Cancelled` :
- `MarkCancel()` — depuis `Pending` uniquement (pas de process à tuer)
- `KillAndMarkCancel()` — depuis `Pending` ou `Running` ; si `Running`, appelle `Shutdown()` pour tuer le process d'abord

Autres transitions terminales depuis `Running` :
- `MarkDone(0)` → `Done` (succès)
- `MarkDone(n)` → `Done` (échec, exit code non nul)
- `KillAndMarkTimedout()` → `TimedOut` (timeout dépassé, process tué)
- `MarkLaunchError()` → `LaunchError` (fork/exec échoué)
- `Step::Shutdown()` → `Shutdown` (arrêt serveur, distinct d'un cancel utilisateur)

`IsDone()` returns true for all terminal states (`Done`, `TimedOut`, `Cancelled`, `Shutdown`, `LaunchError`): the enum is ordered so `state_ >= State::Done` covers them all.

### Exit Code Flags (bitfield in `exit_code_`)

| Hex | Meaning |
|-----|---------|
| `0x0000` | Success (exit 0) |
| `0x0100` | NotSet (step never ran) |
| `0x0200` | Timed out |
| `0x0400` | Cancelled |
| `0x0800` | Launch error (fork/exec failed) |
| `0x1000` | No exit code retrieved |
| `0x2000` | Killed by OS signal |
| `0x4000` | Lost (process disappeared without exit) |

State query helpers: `IsPending()`, `IsRunning()`, `IsDone()`, `IsTimedOut()`, `IsOSKilled()`, `IsCancelled()`, `IsReady()`.

### Group Status Flags

Steps can form a retry group. `group_status_` uses bitmask:

| Bits | Meaning |
|------|---------|
| `0x0001` | Step belongs to a group |
| `0x0003` | First step in group (begin) |
| `0x0005` | Last step in group (end) |

### Dependency Graph

```cpp
step.dependencies_   // list<Step*> — steps this step waits for
step.depend_from_    // list<Step*> — steps that wait for this step
step.previous_       // Step*       — immediately preceding step
step.next_           // Step*       — immediately following step
```

`IsReady()` returns `state_ == Pending && depend_from_.empty()`. The `depend_from_` list holds the prerequisites still blocking this step; as prerequisites complete they are removed from it, and when the list is empty the step is ready to run.

### Notable Fields

| Field | Type | Description |
|-------|------|-------------|
| `task_` | Task* | Parent task |
| `function_` | string | Bash function name to call |
| `args_` | unordered_map | Step-local key/value parameters |
| `nb_cores_` | uint32_t | CPU cores requested |
| `memory_max_` | uint64_t | Memory limit (bytes) |
| `timeout_` | uint32_t | Execution timeout (seconds) |
| `stdout_`, `stderr_` | path | Output file paths |
| `monitor_` | shared_ptr\<Monitor::Task\> | Optional monitor config |
| `executor_data_` | ExecutorData* | Per-step executor state (pid, cores, pipes…) |
| `user_run_state_` | string | Structured metadata written by the step script at end of run (see below) |

### User Run State — file-based side channel

At step end, the scheduler reads the file `$THEJOB_USER_STATE_FILE` (injected by `executor.sh`) and stores its content verbatim in `user_run_state_`. The field is then serialised into `Step::ToJSON()` as `"user_run_state"` and visible in `GET /api/tasks/running`.

This is a lightweight side-channel that allows a step script to communicate structured end-of-step metadata back to the scheduler — independently of stdout/stderr and the monitor file. In practice the scripts write JSON:

```bash
# In a step function (PR_common.sh):
echo '{"nb_cores": 8, "exec_per_sec": 1234}' >> "${THEJOB_USER_STATE_FILE}"
echo '{"objective_count": 2, "last_objective": "foo.trace"}' >> "${THEJOB_USER_STATE_FILE}"
```

Multiple `>>` appends are allowed — the scheduler reads the whole file as a single string.

**Special case — last step:** `ManageEndOfStep()` overrides `user_run_state_` with `"flow ended"` or `"flow cancelled"` for the terminal step, regardless of what the script wrote. The script-provided value is therefore only preserved for non-terminal steps.

---

## Step Configuration (StepConfigurations)

The flow JSON can define a `configurations` block with named profiles. At step creation, `StepConfigurations::MakeWithOverrides()` merges in order:

1. The built-in default: `nb_cores=1`, `nb_retry=1`, `timeout=0` (unlimited), no memory limit
2. The named configuration (if referenced by the step)
3. Step-level inline `configuration` block overrides
4. `run`-level overrides (one per parallel run instance)

Fields configurable at each level:

```
executor_name, nb_cores, nb_retry, timeout,
memory_core, memory_consumption, args
```

(`memory_max` is derived: `memory_core + memory_consumption × timeout`, not set directly.)

### nb_retry — cas particulier des steps dans un groupe

Pour un step **hors groupe**, `nb_retry` suit la règle générale ci-dessus.

Pour un step **dans un groupe**, `nb_retry_` est calculé par `MakeWithOverrides()` puis **immédiatement écrasé** par `GroupStepConfigurations::NbRetry(configName)`. Le `nb_retry` éventuellement défini dans la configuration du step est **silencieusement ignoré**.

`GroupStepConfigurations` est alimenté par le bloc `configuration` du groupe :

```json
[
  {
    "configuration": {
      "nb_retry": 2,
      "custom": {
        "Conf_A": { "nb_retry": 3 }
      }
    },
    "run": [{"Conf_A": {}}, {"Conf_B": {}}]
  },
  { "step": "Build" }
]
```

Ici, un step utilisant `Conf_A` aura `nb_retry=3`, les autres auront `nb_retry=2`. Tout `nb_retry` écrit directement dans la `configuration` du step est ignoré.

### Retries — structure statique

Les retries sont créés **à l'analyse du JSON**, pas à l'exécution. `nb_retry=3` génère 3 instances `Step` en chaîne (`attempt_id` 0, 1, 2) dès la soumission de la tâche. Si `attempt_id=0` échoue, `attempt_id=1` est disponible dans la file, etc.

**Steps inside a group** cannot carry a `run` field — the parser raises an error. Parallel parameterisation via `run` is only available at the group level or on standalone steps.

`GroupStepConfigurations` holds per-named-configuration retry counts for the group as a whole.

---

## Execution Flow (detailed)

```
Schedule::ScheduleLoop()  [background thread, runs continuously]

  1. SearchTasksToRun()
       for each step in steps_ (pending):
         if IsReady(): move to runnable list

  2. For each runnable step:
       a. Executor::FindRunnableSteps()  — check resource availability
       b. step.MarkRunning()
       c. If first step of task: Task::PrepareToRun()
            → create run_root_path, logs_path, artefacts_path dirs
            → link tools, copy uploaded files
       d. Executor::Execute(*step)
            → assigns CPU cores, fork/execs launcher script
            → creates LocalData (pid, cores, pipes, cgroup)
       e. Monitor::Add(*step) if step has monitor config
       f. move step from steps_ to stepsRunning_

  3. Executor::CheckFinishedSteps(stepsRunning_)
       → waitpid(WNOHANG) on each running process
       → for finished: ReleaseCores(), record exit_code
       → returns list of completed steps

  4. For each completed step: ManageEndOfStep(*step)
       a. step.GatherFilesToLocal()  — copy outputs from run dir
       b. move step to stepsDone_
       c. Activate depend_from_ steps (mark them pending)
       d. If all steps done: Task::FinalizeAndArchive()

  5. Monitor::GetChange()  — check inotify for new monitor messages
       → used by LimitRessourcesUsages() to decide kills

  6. LimitRessourcesUsages()
       → read memory/CPU from OS monitor
       → if task exceeds memory_max: KillAndMarkTimedout()

  7. SaveStatus(true)
       → write tasksmanager.json + status.json

  8. sleep briefly then repeat
```

---

## Task JSON Format (flow definition, submitted by client)

Top-level keys: `name`, `publish`, `configurations` (optional), `flow`.

**Dependencies between steps are implicit from position in the `flow` array**

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
    {
      "step": "Build",
      "configuration": { "nb_cores": 2, "nb_retry": 1 }
    },
    {
      "step": "Experiment",
      "configuration": {
        "nb_cores": 8,
        "timeout": "2h",
        "args": { "COMMIT_ID": "abc123" }
      },
      "monitor": {
        "entry_point": "MonitorExperiment",
        "delay_start": "10s",
        "interval": "30s",
        "timeout": "2h"
      }
    },
    { "step": "Summary" }
  ]
}
```

### Parallel runs (one step, multiple parameterised instances)

```json
{
  "flow": [
    {
      "step": "Step1",
      "run": [
        {"Conf_A": {}},
        {"Conf_B": {}}
      ],
      "configuration": { "nb_retry": 2 }
    }
  ]
}
```

### Group (multiple steps in parallel, sharing a run list)

```json
{
  "flow": [
    [
      { "configuration": { "nb_retry": 1 }, "run": [{"Cfg1": {}}, {"Cfg2": {}}] },
      { "step": "Build" },
      { "step": "Experiment", "configuration": { "timeout": "1h" } }
    ]
  ]
}
```

Individual steps inside a group **cannot** carry a `run` field — the parser raises an error. The `run` list is defined at group level only.

---

## State Persistence

After each scheduling iteration, `Schedule::SaveStatus(true)` writes:

- **`<exportPath>/tasksmanager.json`** — all tasks and all their steps, serialised via `Task::ToJSON()` / `Step::ToJSON()`.
- **`<exportPath>/status.json`** — only currently running steps (lightweight snapshot for dashboards).

On an abnormal shutdown the JSON on disk captures the last known state. Reload is not currently active but the deserialization path (`TasksManager::LoadStatus()`) exists and can reconstruct the in-memory graph from the JSON.
