# Scheduler — Executor Design

## Role

An **Executor** is the pluggable backend responsible for launching a Step's bash function as a
system process, managing its resources, capturing its output, and detecting its completion. The
scheduler (`Schedule::ScheduleLoop`, see [task-step-lifecycle.md](task-step-lifecycle.md)) calls
the executor through an abstract interface, keeping scheduling logic independent of the execution
environment.

Only the **Local** executor is implemented (`Config::Type::Local`, JSON `"type": 1`). The
abstraction anticipates future remote or container-based backends but `Executor::Build()` only
knows how to construct a `Local` instance today.

Source of truth: `src/scheduler/schedule/executor/executor.hxx/.cxx`,
`executors_provider.hxx`, `config.hxx/.cxx`, `local.hxx/.cxx`, `output_ring.hxx/.cxx`,
`../../system/linux_cores.hxx/.cxx`.

---

## Abstract Interface (`Executor`)

```cpp
class Executor {
public:
  static Executor* Build(ns_Executor::Config* config, uint16_t cachePort, ns_System::Linux& os);

  virtual bool TaskPrepareToRun(ns_Schedule::Task* task) = 0;
  virtual bool TaskFinalize(ns_Schedule::Task* task, ExecutorTaskData* data) = 0;

  virtual std::list<ns_Schedule::Step*> FindRunnableSteps(std::list<ns_Schedule::Step*> const& steps) = 0;
  virtual void Execute(ns_Schedule::Step& step) = 0;
  virtual std::list<ns_Schedule::Step*> CheckFinishedSteps(std::list<ns_Schedule::Step*>& runningSteps) = 0;
  virtual void Shutdown(ns_Schedule::Step& step) = 0;
  virtual void GatherFilesToLocal(ns_Schedule::Step& step) = 0;
  virtual void CheckReloadRunning(ns_Schedule::Step& step) = 0;

  virtual void GetRunningOutput(ns_Schedule::Step const& step,
      std::string const& type, struct FileExtractedText& data) const = 0;

  virtual ExecutorTaskData* CreateLocalTaskData(rapidjson::Value const& config) const = 0;
  virtual ExecutorData* CreateLocalData(rapidjson::Value const& config) const = 0;

  virtual std::pair<bool, bool> LimitsState() = 0;                                     // (cpu_overloaded, memory_overloaded)
  virtual std::pair<int8_t, int8_t> UpdateTaskStats(ExecutorTaskData*,
      std::vector<ExecutorData*> stepsData) const = 0;                                 // (cores_load, memory_load)
  virtual void UpdateStepStats(ExecutorData* data) const = 0;
  virtual void ToJSON(rapidjson::Value& root, rapidjson::MemoryPoolAllocator<>& alloc) const = 0;
};
```

Every method that mutates process state (`Execute`, `CheckFinishedSteps`, `Shutdown`) is called
by `Schedule::ScheduleLoop()` **without** `Schedule::lockThread_` held — fork/exec, waitpid and
signal delivery all happen outside the scheduler's own lock (see
[threading-synchronization.md](threading-synchronization.md)).

`Executor::OSLoad` is a plain struct (`memory`, `cores`, `perCores`, `freeMemory`, `totalMemory`,
`storages`) used to snapshot the last `GatherStats()` reading for dashboard/limit decisions.

`GatherFilesToLocal(Step&)` — despite the name suggesting a copy step — is a **no-op** in the
current `Local` implementation (`local.cxx`, empty body). Output/artefact placement is instead
handled entirely by `Local::EndRun()` → `SaveArtefacts()` at process-exit time (see below); nothing
runs at `Step::GatherFilesToLocal()` call time in `ManageEndOfStep()` today.

---

## Per-Step / Per-Task Executor State

`ExecutorData` (per step) and `ExecutorTaskData` (per task) are opaque abstract base classes
(`virtual ~()` + `virtual ToJSON()`); the scheduler core only stores and serialises pointers to
them via `Step::executor_data_` / `Task::executor_data_`.

### `LocalData` (per step)

```cpp
struct LocalData : ExecutorData {
  vector<uint64_t> cores_;             // assigned core indices
  path     run_path_;                  // <task run_path>/executor/<ID or GID>/
  path     artefacts_file_;            // <run_path>/<ID or GID>-artefacts.json
  pid_t    pid_;
  string   launcher_file_;             // <run_path>/<ID>-launcher   (env vars sourced by executor.sh)
  string   user_state_file_;           // <run_path>/<ID>-userstate
  string   step_parameters_file_;      // <run_path>/<ID>-parameters (step args, THEJOB_RUNPARMS)
  EProcessStatus process_status_;      // Internal | External | External_Running
  path     fatalerror_file_;           // <run_path>/fe-<ID>
  path     done_file_;                 // <run_path>/.done-<ID>
  vector<string> arguments_;           // argv used to re-verify a reloaded process (/proc/<pid>/cmdline)
  path     cgroup_path_;               // <cgroupRoot>/<taskID>/<stepID>
  FDCaptureThread fdCaptureThread_;    // wraps a pooled epoll-thread reference, capacity 2 FDs
  int      pipeFDOut[2], pipeFDErr[2];
  int8_t   os_memory_load_;
  vector<int8_t> os_cores_load_;       // one entry per assigned core
  int8_t   os_memory_max_load_, os_cores_max_load_;   // running peak
};
```

For a step in a group, `run_path_` and `artefacts_file_` are keyed by `step.GID()` instead of
`step.ID()` — all steps of a group share one working directory.

### `LocalTaskData` (per task)

```cpp
struct LocalTaskData : ExecutorTaskData {
  path   cgroupPath_;    // <cgroupRoot>/<taskID>/    (task-level cgroup, empty if cgroups unavailable)
  path   run_path_;      // <run_root_path_>/executor/  (shared by all steps of the task)
  path   flag_file_;     // <run_path>/.flag  (written by Flag() in step scripts)
  int8_t os_memory_load_, os_cores_load_, os_memory_max_load_, os_cores_max_load_;
};
```

`Local::TaskFinalize()` reads `flag_file_` after all steps complete and stores its content
verbatim in `Task::flag_`, later serialised into the task JSON and exposed via the users API.

---

## Local Executor (`Local`)

### Configuration (`ns_Executor::LocalConfig`)

```json
"executors": {
  "local": {
    "type": 1,
    "nbCores": 4,
    "excludeCores": [0],
    "scriptPath": "../scripts",
    "logsSize": 10485760,
    "cgroupPath": "/sys/fs/cgroup/scheduler.service",
    "cpuMaxLoad": 90,
    "memMinimumRatio": 0.15
  }
}
```

| Key | Default | Meaning |
|-----|---------|---------|
| `cores` | — | Explicit whitelist of usable core indices (mutually exclusive with `nbCores`/`excludeCores`) |
| `nbCores` / `excludeCores` | all cores except core 0 | Number of cores usable, and cores never assigned (keep OS responsive) |
| `scriptPath` | `scripts` | Directory containing `executor.sh` / `functions.sh`; `LocalConfig::Validate()` writes them there (embedded in the binary, see below) if missing or `forceInstall` is set |
| `logsSize` | 16 MiB | Capacity of the in-memory output ring buffer per step, per stream |
| `cgroupPath` | `/sys/fs/cgroup/scheduler.service` | cgroup v2 root the scheduler tries to use (symbolic, `${euid}`/`${uid}` resolved) |
| `cpuMaxLoad` | 90 | CPU load percent above which no new step starts (only enforced when cgroup `cpuset` control is unavailable — see below) |
| `memMinimumRatio` | 0.15 | Fraction of total memory that must stay free; scheduling stops below it |

`executor.sh` and `functions.sh` are embedded in the binary at build time
(`embeded/scheduler/scripts/executor_sh.h`, `functions_sh.h`) and written out to `scriptPath` by
`LocalConfig::Validate()` if absent.

### CPU Core Management

`Local` maintains `vector<bool> coresFree_` (size `nbCoresMax_`) and a running count
`nbCoresFree_`.

**`AssignCores(nbCores)`** (called from `Execute()`, before `fork()`):
1. If `config_.nbCores_ == 0` (explicit `cores` list mode), take the first N free indices in
   order.
2. Otherwise call `os_.Cores().SelectMostIdleCores(nbCores, &coresFree_)` — reads the current
   `/proc/stat` delta ratios cached in `CoresMonitor` (refreshed by the `Linux` system-monitor
   thread, not by this call) and returns the `nbCores` least-loaded free indices.
3. Mark those indices `false` in `coresFree_`, decrement `nbCoresFree_`.
4. `UpdateUserSliceCpuset()` — best-effort `sudo -n systemctl set-property user.slice
   AllowedCPUs=...` to keep the desktop/login session off the cores reserved for jobs (silently
   disabled if `sudo` is unavailable or the cgroup root is itself under `/user.slice/`).

Actual pinning happens **inside the forked child**, after `setsid()`: `PinCoresToProcess(cores)`
calls `sched_setaffinity(0, ...)` and then reads back `sched_getaffinity` to confirm every
requested core stuck.

**`ReleaseCores(cores)`** — called from `Local::EndRun()` (after a step finishes or is killed):
marks the indices free again, `UpdateUserSliceCpuset()`.

**`ReAssignCores(cores)`** — reserves cores for a step found still running by
`CheckReloadRunning()` (reload path).

**`FindRunnableSteps(steps)`**:
1. `GatherStats()` refreshes `stats_` (global CPU %, free memory, per-core %, storage) from
   `os_.GetLoad()`.
2. Bails out (returns empty) if `stats_.cores > cpuMaxLoad_` or free memory is below
   `memMinAllowed_ = totalMemory * memMinRatio_`.
3. Walks `steps` in priority order (the caller, `Schedule::steps_`, is already priority-sorted);
   for each ready step whose `nb_cores_`/`memory_max_` still fit the running free-resource
   counters, accepts it and decrements the counters. Once a step at a given priority is skipped
   for lack of resources, no step of a *lower* priority is considered (`stepSkiped` short-circuit)
   — resources are exhausted top-down by priority, not opportunistically back-filled from lower
   priority work.

### Execution Sequence (`Execute(step)`)

```
1. Build run_path_, artefacts_file_ (keyed by ID or GID), fatalerror_file_, done_file_,
   launcher_file_, user_state_file_, step_parameters_file_ under
   <task LocalTaskData::run_path_>/<ID or GID>/. Create the directory (0755-ish perms
   if UPDATE_CHILD_UMASK is defined, which it is).

2. pipe(pipeFDOut), pipe(pipeFDErr); fcntl(F_SETPIPE_SZ, 1MiB) on each write end (best effort).
   fdCaptureThread_.AddFD(readEnd, new MemoryRing{stdout_/stderr_ path, logsSize_}) for both —
   this is the ONLY OutputBuffer type ever instantiated; FileRing exists but is dead code
   (see Output Capture below).

3. AssignCores(step.nb_cores_)

4. fork()
   |- child:
   |    umask(0022)
   |    if cgroup root available:
   |      mkdir <cgroupRoot>/<taskID>/<stepID>
   |      write memory.max        (if step.memory_max_ > 0 and "memory" capability detected)
   |      write cpuset.cpus       (if "cpuset" capability detected)
   |      write cgroup.procs = self pid
   |    setsid()                              -- new session, enables SIGKILL-by-session/cgroup
   |    PinCoresToProcess(cores)               -- sched_setaffinity
   |    chdir(run_path_)
   |    write step_parameters_file_           -- step.args_ as KEY="VALUE" pairs
   |    write launcher_file_                  -- THEJOB_* environment variables (see below)
   |    RedirectOutput(pipeFDOut[1], pipeFDErr[1])   -- dup2 onto fd 1 / fd 2
   |    close_range(3, ~0U, 0)                -- close everything except stdin/stdout/stderr
   |    execv(<scriptPath>/executor.sh, {"task", launcher_file_, "---"})
   |    (on execv failure: write fatalerror_file_, sync(), exit(-1))
   |
   |- parent:
        localData->pid_ = pid
        step.MarkRunning(); ++nbChild_
```

`launcher_file_` carries the environment `executor.sh` needs, one `KEY="VALUE"` line per variable,
sourced as shell — not passed as `execv` argv (only 3 fixed args are passed: `"task"`, the
launcher file path, and the literal `"---"` sentinel). Notable variables: `THEJOB_ROOT_PATH`,
`THEJOB_FUNCTIONS_PATH`, `THEJOB_ENV_PATH`, `THEJOB_USER_FILES_PATH`, `THEJOB_OUT_PATH`,
`THEJOB_ARTEFACTS_FILE`, `THEJOB_ARTEFACTS_PATH`, `THEJOB_TOOLS_PATH`, `THEJOB_CORES`,
`THEJOB_ENTRYPOINT`, `THEJOB_PARAMETERS_PATH`, `THEJOB_STDOUT_PATH`, `THEJOB_STDERR_PATH`,
`THEJOB_CACHE_PORT`, `THEJOB_USER_STATE_FILE`, `THEJOB_FLAG_FILE`, `THEJOB_DONE_FILE`,
`THEJOB_MONITOR_PARAMETERS_PATH` (if the step has a monitor), `THEJOB_STEP_GROUP_ID` (if grouped).

### `executor.sh` / `functions.sh` (`scripts/executor.sh`, `scripts/functions.sh`)

`executor.sh` runs as `bash -l`, validates every required `THEJOB_*` variable is present, sources
`functions.sh` (which itself calls `SetupEnv` at the bottom — evaluates the task-level config file,
the persisted task env (`THEJOB_ENV_PATH`), and the step parameters file into shell variables),
then:

```bash
${THEJOB_ENTRYPOINT} "$@"          # or ENTRYPOINT__Shutdown if THEJOB_SHUTDOWN=1
THEJOB_RETVAL=$?
StopMonitor                        # wait for/collect the background monitor loop, if any
[[ "$THEJOB_UNIQ_STEP" == 1 ]] && echo "$THEJOB_GLBPARMS" > "$THEJOB_ENV_PATH"   # persist AddGlobalParam()
echo "$THEJOB_RETVAL" > "$THEJOB_DONE_FILE.tmp" && mv ... "$THEJOB_DONE_FILE"    # atomic sentinel
exit "$THEJOB_RETVAL"
```

`functions.sh` provides the step-script API: `QueryCache`/`SetCache` (talk to the cache HTTP
server on `THEJOB_CACHE_PORT`), `AddGlobalParam` (persist a variable across steps via
`THEJOB_ENV_PATH`), `CreateArtefact` (append a JSON line to `THEJOB_ARTEFACTS_FILE`, later consumed
by `Local::SaveArtefacts()`), `Flag` (atomically write the task-level flag file), and
`StartMonitor`/`StopMonitor` (spawn/reap the background monitor loop that periodically calls the
step's `monitor.entry_point` function and atomically publishes its output to the monitor file
watched by the inotify Monitor thread — see [threading-synchronization.md](threading-synchronization.md)).

### Shutdown Runner (`RunShutdown`)

When `Local::Shutdown()` is invoked on a running step (timeout, cancel, or process-manager
shutdown), after killing the original session it forks a **second**, short-lived process that
re-execs `executor.sh` with `THEJOB_SHUTDOWN=1` appended to the launcher file. `executor.sh`
resolves the entry point to `<function>__Shutdown` (falling back to a clean exit if that function
does not exist) — this lets step scripts define a cleanup hook that only runs when a step is being
torn down early.

### Completion Detection (`CheckFinishedSteps`)

```
for each step in stepsRunning (belonging to this executor, not yet Done):
  if process_status_ == Internal:
    waitpid(-pid, &status, WNOHANG)                 -- waits on the whole session group
  else (External / External_Running, reload path):
    CheckExternalProcessIsRunning(pid, arguments_, fatalerror_file_, done_file_)
                                                      -- kill(pid,0) + fatal/done sentinel files

  if a child actually finished:
    --nbChild_
    if fatalerror_file_ exists:      step.MarkLaunchError()
    else:
      if not External:               KillSession(pid, cgroup_path_, "Step run")  -- reap + cgroup.kill
      if killed by SIGKILL:           step.MarkDone(exitCode_Killed_)
      else:                           step.MarkDone(WIFEXITED ? WEXITSTATUS : exitCode_NoExitCode_)
    EndRun(step, localData, releaseCores=true)
```

### `EndRun` (shared cleanup for normal completion and Shutdown)

1. If a cgroup path was set, `KillCGroupSession()` (write `1` to `cgroup.kill`, retry-remove the
   directory up to 20× on `EBUSY`).
2. Remove both pipe FDs from `fdCaptureThread_` (triggers the `MemoryRing` destructor, which
   flushes the buffered output to `step.stdout_`/`step.stderr_` on disk — see Output Capture).
3. Read `user_state_file_` into `Step::user_run_state_`.
4. `ReleaseCores()` if requested.
5. If this was the last step of its group (`stepsGroup_None_`/`stepsGroup_End_`) or the task was
   cancelled: `SaveArtefacts(step)` then remove the whole `run_path_` tree. Otherwise the shared
   group directory is left in place for the next step in the group.
6. Remove `step_parameters_file_`, `user_state_file_`, `launcher_file_`, `done_file_`,
   `fatalerror_file_`.

### Termination (`Shutdown(step)`)

```
1. KillSession(pid, cgroup_path_, "Step timeout run")
     - if cgroup_path_ set: KillCGroupSession() -- write "1" to cgroup.kill (kills entire subtree)
     - else: kill(-sid, SIGTERM), sleep 4s, kill(-sid, SIGKILL) if still alive
     - WaitSessionEnd(): waitpid(-sid, ...) loop + reap any pid still reported for that sid by
       /proc scanning (os_.Process().GetPidsBySid())
2. If no fatalerror_file_ was left behind by the killed run:
     RunShutdown()   -- fork the THEJOB_SHUTDOWN=1 cleanup pass described above
     waitpid() on it, KillSession() on it too (in case the cleanup pass itself hangs)
3. EndRun(step, localData, releaseCores=true)
```

### cgroup v2 Support (`DetectCGroupSupport`)

At `Local` construction:
1. Checks write+execute access to the configured `cgroupPath_`.
2. Creates a `server/` subdirectory under it and self-registers the scheduler process's pid into
   `server/cgroup.procs` (moves the scheduler itself out of the root so its own subtree controllers
   can be enabled).
3. Attempts to enable `+memory +cpuset +pids` in `cgroup.subtree_control`, one at a time; each
   failure clears the corresponding bit of the returned capability bitmask (bit 0 = memory, bit 1
   = cpuset, bit 2 = pids). If none succeed, cgroups are disabled entirely.
4. Creates a uniquely-named working root `<cgroupPath_>/scheduler-<pid>/` and writes the resolved
   capability string into its own `cgroup.subtree_control`.

When cgroups are available: each task gets `<cgroupRoot>/<taskID>/`, each step gets
`<cgroupRoot>/<taskID>/<stepID>/`. Memory is capped via `memory.max` (only if the `memory`
capability was granted and `step.memory_max_ > 0`); CPU pinning is additionally expressed via
`cpuset.cpus` (only if the `cpuset` capability was granted) alongside the `sched_setaffinity` call
in-process. The whole step subtree is killed atomically via `cgroup.kill`. `Local::LimitsState()`
only enforces the CPU-load config threshold when the `cpuset` capability is **not** available —
if cgroup CPU pinning is active, the scheduler trusts it to keep load bounded per job and skips the
global CPU check.

Without cgroup access, termination falls back to `kill(-sid, SIGTERM)` then `kill(-sid, SIGKILL)`
against the whole process group/session, and there is no hard memory cap — only the
`memMinimumRatio_` scheduling gate.

### Artefacts (`SaveArtefacts`)

At `EndRun()` (for the last step of a group, or any ungrouped step), if `artefacts_file_` exists,
each line is parsed as one JSON object written by the shell `CreateArtefact` helper
(`{"path": ..., "name": ..., "metadata": {...}}`). For each entry: the source file is moved
(same filesystem) or recursively copied (cross-filesystem) into `task->artefacts_path_`, and the
entry is appended to `<artefacts_path_>/metadata.json` under a top-level key equal to the step's
`ID()`/`GID()`. `Task::metadata_index_lock_` (a plain `std::mutex`, not a rename-based lock)
serialises this append across steps of the same task that may finish concurrently.

---

## Output Capture

### Architecture

```
forked step process
  |  stdout -> pipe write end
  |  stderr -> pipe write end
  v
FDCaptureThread (per-step wrapper; LocalData::fdCaptureThread_)
  |  AddFD()/RemoveFD() route to a pooled FDCaptureThreadImpl (shared epoll OS thread)
  v
FDCaptureThreadImpl::threadMain()   -- one epoll_wait loop, shared across MULTIPLE steps
  |  reads up to 64KiB per readable fd, forwards to the registered OutputBuffer
  v
MemoryRing (per fd)   -- the ONLY OutputBuffer subclass ever instantiated by Local::Execute()
```

`FileRing` is fully implemented (rotating on-disk files, optional tail-merge on close) but is
**never constructed anywhere in the codebase** — dead code kept for a possible future large-output
mode.

### Thread pooling (`FDCaptureThread` / `FDCaptureThreadImpl`)

Each `LocalData` owns its own `FDCaptureThread` instance, constructed with `nbFileDescriptor = 2`
(one stdout + one stderr). `FDCaptureThread`'s constructor does **not** always spin up a new OS
thread: it consults a process-wide static pool (`FDCaptureThread::threadsPoll__`, guarded by
`FDCaptureThread::threadsLock__`) and reuses any existing `FDCaptureThreadImpl` whose load
(`Load(nbFileDescriptor)`) still fits under a cap of 8 — i.e. up to 4 concurrently-running steps
share one real epoll thread before a new `FDCaptureThreadImpl` is created. `~FDCaptureThread()`
calls `Unload()` and removes the impl from the pool only once its load reaches 0. So the number of
live epoll threads scales roughly with `ceil(concurrent_steps / 4)`, not with 1 (a single global
thread) nor with N (one per step).

`FDCaptureThread` itself also keeps its own `fds_`/`lockFDs_` (a thin per-wrapper mirror of what
it registered, used so `Read()` can look up the buffer without going through the shared impl's
lock) — this is a **different mutex** from `FDCaptureThreadImpl::lockFDs_`, which guards the
shared `fd -> OutputBuffer` map actually touched by the epoll thread.

### `MemoryRing`

Circular buffer backed by `vector<uint8_t> buffer_`:
- Capacity = `logsSize_` from config (default 16 MiB).
- `Write()` overwrites the oldest bytes once full; `virtualSize_` tracks total bytes ever written
  (can exceed capacity — used to compute correct offsets for tail reads).
- All access guarded by its own `std::mutex lock_`.

**Flush on destruction**: the destructor computes the currently-buffered window (last `maxSize_`
bytes if `full_`, else everything) and writes it in one shot to `file_` (`step.stdout_` /
`step.stderr_`), truncating any prior content. Consequences:
- Zero disk I/O while a step is running — output only hits disk once, when the fd is removed from
  capture (`Local::EndRun()`), i.e. essentially at step completion.
- If the server crashes while a step is running, all buffered output for that step is lost (never
  flushed).
- Live tailing (`GET .../output`) reads directly from the in-memory ring via
  `Local::GetRunningOutput()` → `FDCaptureThread::Read()`, so it is unaffected by the
  flush-on-destruction behavior.

---

## Resource Monitoring

`ns_System::Linux` (one instance shared by all executors) owns:
- `CoresMonitor` — periodically diffs `/proc/stat` snapshots into per-core utilisation ratios.
- `MemoryMonitor` — parses `/proc/meminfo` for total/available/swap.
- A configured set of storage paths, polled via `std::filesystem::space()` for capacity/available.

`Local::GatherStats()` calls `os_.GetLoad()` (which locks `Linux::lock_` internally) to refresh
`Local::stats_` on every `FindRunnableSteps()` call — i.e. once per scheduling iteration, not on a
separate timer inside `Local` itself.

`Local::CGroupMemoryUsed()` reads `anon` + `shmem` from a cgroup's `memory.stat` file to compute a
percent-of-total-memory figure; used by `UpdateTaskStats()`/`UpdateStepStats()` in preference to
the global OS memory percentage whenever the cgroup `memory` capability is available.

`Local::LimitsState()` returns `(cpu_overloaded, memory_overloaded)`:
- `cpu_overloaded` = `stats_.cores > cpuMaxLoad_`, **only** evaluated when the `cpuset` cgroup
  capability is unavailable (see cgroup section above).
- `memory_overloaded` = `stats_.freeMemory < memMinAllowed_`.

`Schedule::LimitRessourcesUsages()` (called once per scheduling loop iteration, from
`ScheduleLoop`) consumes `LimitsState()` plus per-task `UpdateStats()` results and, independently
for memory pressure and CPU overload, picks one running task to cancel via
`SRessourcesSummary::ToKillMem()` / `ToKillCPU()` — the task with the worst
resource-consumed-per-millisecond-running score (ties broken by shortest running time, i.e. prefer
killing the task that got the least work done for the resources it used).
