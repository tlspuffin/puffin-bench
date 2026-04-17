# Executor Design

## Role

An **Executor** is the pluggable backend responsible for actually launching a Step's bash function as a system process, managing its resources, capturing its output, and detecting its completion. The scheduler calls the executor through an abstract interface, keeping the scheduling logic independent of the execution environment.

Currently only the **Local** executor is implemented (type `1` in config). The abstraction anticipates future remote or container-based backends.

---

## Abstract Interface (`Executor`)

Defined in `src/scheduler/schedule/executor/executor.hxx`.

```cpp
class Executor {
public:
  // Called once before the first step of a task runs
  virtual void TaskPrepareToRun(Task&) = 0;

  // Called after the last step of a task finishes
  virtual void TaskFinalize(Task&) = 0;

  // Returns steps (from the ready list) that can start given current resources
  virtual std::vector<Step*> FindRunnableSteps(std::vector<Step*>&) = 0;

  // Launches a step (non-blocking: fork/exec then return)
  virtual bool Execute(Step&) = 0;

  // Polls running steps for completion (non-blocking: WNOHANG)
  // Returns steps that have finished since last call
  virtual std::vector<Step*> CheckFinishedSteps(std::list<Step*>&) = 0;

  // Terminates a running step gracefully (SIGTERM → SIGKILL)
  virtual void Shutdown(Step&) = 0;

  // Copies step outputs from the executor's working dir to task.logs_path_
  virtual void GatherFilesToLocal(Step&) = 0;

  // Re-attaches to a step that was running before a server restart
  virtual void CheckReloadRunning(Step&) = 0;

  // Reads live stdout/stderr from a running step (writes into FileExtractedText)
  virtual void GetRunningOutput(Step const&, std::string const& type, FileExtractedText&) const = 0;

  // Resource monitoring
  // UpdateTaskStats: returns (memory_ok, cores_ok) pair
  virtual std::pair<int8_t,int8_t> UpdateTaskStats(ExecutorTaskData*, std::vector<ExecutorData*>) const = 0;
  virtual void UpdateStepStats(ExecutorData*) const = 0;
  // RetrieveStats: returns (memory_overloaded, cores_overloaded)
  virtual std::pair<bool,bool> RetrieveStats() = 0;

  // Serialise executor state to JSON
  virtual void ToJSON(rapidjson::Value&, rapidjson::Document::AllocatorType&) = 0;

  // Factory: constructs the correct subclass from config
  static Executor* Build(Config const&, Linux&, ns_Cache::Cache&, uint16_t cachePort);
};
```

`OSLoad` is a plain struct carrying `memory_load`, `cores_load` snapshot values for dashboard / resource-limit decisions.

---

## Per-Step Executor State (`ExecutorData`)

Each Step carries an `executor_data_` pointer to a backend-specific struct. The abstract base is:

```cpp
struct ExecutorData {
  virtual ~ExecutorData() = default;
};
```

The Local backend uses `LocalData`:

```cpp
struct LocalData : ExecutorData {
  vector<uint64_t> cores_;           // assigned core indices
  path     run_path_;                // <runPath>/<taskID>/
  path     artefacts_path_;
  pid_t    pid_;
  string   launcher_file_;           // generated launcher .sh (string, not path)
  string   user_state_file_;         // persistent key/value for step
  string   step_parameters_file_;    // JSON env file for executor.sh
  enum EProcessStatus { Internal, External, External_Running } process_status_;
  path     fatalerror_path_;         // written if step crashes fatally
  path     done_path_;               // sentinel file written at step exit
  vector<string> arguments_;         // argv passed to exec
  path     cgroup_path_;             // /sys/fs/cgroup/…/<taskID>/<stepID>
  FDCaptureThread fdCaptureThread_;
  int      pipeFDOut[2], pipeFDErr[2];
  int8_t   os_memory_load_;          // % memory usage (signed byte, 0-100)
  vector<int8_t> os_cores_load_;     // per-core load (one entry per assigned core)
  int8_t   os_memory_max_load_;
  int8_t   os_cores_max_load_;
};
```

Per-task state uses `LocalTaskData`:

```cpp
struct LocalTaskData : ExecutorTaskData {
  path   cgroupPath_;             // task-level cgroup root
  int8_t os_memory_load_;
  int8_t os_cores_load_;
  int8_t os_memory_max_load_;
  int8_t os_cores_max_load_;     // all as signed bytes (0-100 %)
};
```

---

## Local Executor (`Local`)

### Configuration

```json
"executors": {
  "local": {
    "type": 1,
    "nbCores": 4,
    "excludeCores": [0],
    "scriptPath": "../scripts",
    "logsSize": 10485760
  }
}
```

| Key | Default | Meaning |
|-----|---------|---------|
| `nbCores` | all available | Maximum simultaneous cores |
| `excludeCores` | `[0]` | Cores never assigned (keep OS responsive) |
| `scriptPath` | — | Directory containing `executor.sh`, `functions.sh` |
| `logsSize` | 10 MB | Size limit for the output ring buffer per step |

### CPU Core Management

The executor maintains a `vector<bool> coresFree_` of size `nbCoresMax_`.

**AssignCores(step):**
1. Query `CoresMonitor::SelectMostIdleCores(n)` — returns the `n` least-loaded cores from `/proc/stat` deltas.
2. Mark those cores as taken in `coresFree_`.
3. Store assigned indices in `LocalData::cores_`.
4. After `fork()`, call `PinCoresToProcess(pid, cores)` which writes to `/proc/<pid>/cpuset` or uses `sched_setaffinity`.

**ReleaseCores(step):**
- Mark `coresFree_[core] = true` for each core in `LocalData::cores_`.

**ReAssignCores(step):**
- Called during server reload if a step was already running when the server started.

**FindRunnableSteps(ready):**
- Returns the subset of `ready` steps for which `nbCoresFree_ >= step.nb_cores_`.

### Execution Sequence (`Execute(step)`)

```
1. BuildExecutorArgs(step)
     → write <step_parameters_file>.json with:
          THEJOB_STEP_ID, THEJOB_NB_CORES, THEJOB_CORES,
          THEJOB_OUT_PATH, THEJOB_TOOLS_PATH,
          THEJOB_USER_FILES_PATH, THEJOB_ARTEFACTS_PATH,
          THEJOB_USER_STATE_FILE,
          step function name, step args, task args

2. AssignCores(step)

3. pipe(pipeFDOut), pipe(pipeFDErr)

4. fork()
   ├─ child:
   │    dup2(pipeFDOut[1], STDOUT_FILENO)
   │    dup2(pipeFDErr[1], STDERR_FILENO)
   │    close unused pipe ends
   │    setsid()                    — new session (enables cgroup kill)
   │    exec("bash", "executor.sh", step_parameters_file, …)
   └─ parent:
        close write ends of pipes
        fdCaptureThread_.AddFD(pipeFDOut[0], outBuffer)
        fdCaptureThread_.AddFD(pipeFDErr[0], errBuffer)
        record pid in LocalData

5. If cgroup v2 available:
     SetupCGroup(step)
       → mkdir /sys/fs/cgroup/<cgroupRoot>/<taskID>/<stepID>
       → write pid to cgroup.procs
       → write memory.max if memory_max_ set
```

`executor.sh` (embedded in the binary via `xxd -i`) sets up the shell environment, sources `functions.sh`, and calls the step's bash function by name.

### Completion Detection (`CheckFinishedSteps`)

```
for each step in stepsRunning:
  waitpid(pid, &status, WNOHANG)
  if WIFEXITED or WIFSIGNALED:
    record exit_code (raw OS code + flag bits)
    ReleaseCores(step)
    fdCaptureThread_.RemoveFD(stdout_fd)
    fdCaptureThread_.RemoveFD(stderr_fd)
    SaveArtefacts(step)     — copy artefacts dir to exportPath
    move step to finished list
```

### Termination (`Shutdown(step)`)

```
1. kill(pid, SIGTERM)
2. WaitSessionEnd(sid, timeout=5s)
     → poll waitpid until exit or timeout
3. If still alive:
     KillCGroupSession(step)
       → write "1" to <cgroupPath>/cgroup.kill  (kills whole cgroup)
     or kill(-sid, SIGKILL) if cgroup not available
4. EndRun(step)
     → fdCaptureThread_.RemoveFD()
     → ReleaseCores()
     → cleanup cgroup dir
```

### cgroup v2 Support

`DetectCGroupSupport()` at startup checks:
- `/sys/fs/cgroup/cgroup.controllers` exists
- configured `cgroupPath_` is writable

When available:
- Each task gets `<cgroupRoot>/<taskID>/` and each step gets `<cgroupRoot>/<taskID>/<stepID>/`.
- Memory limit set via `memory.max`.
- Entire subtree killed atomically on cancel/timeout via `cgroup.kill`.

Without cgroup, fallback is `kill(-sid, SIGKILL)` targeting the process group.

---

## Output Capture

### Architecture

```
fork'd process
  │  stdout (pipe write end)
  │  stderr (pipe write end)
  │
  ▼
FDCaptureThread (epoll loop, shared across all running steps)
  │  reads chunks from pipe read ends
  ▼
MemoryRing (per fd)   — only implementation currently instantiated
```

`FileRing` existe et est entièrement implémentée mais n'est jamais instanciée dans le code actuel (dead code).

### FDCaptureThread

- A single `FDCaptureThreadImpl` thread runs an `epoll_wait` loop over all registered file descriptors.
- `AddFD(fd, buffer)` registers a pipe end; `RemoveFD(fd)` unregisters it.
- On readability, reads up to 4096 bytes and calls `buffer->Write(data)`.
- `Read(fd, offset, size)` retrieves buffered data for the `GetOutput` API.

### MemoryRing

Circular buffer backed by `vector<uint8_t>`:
- Capacity = `logsSize_` (from config, default 10 MB).
- When full, overwrites oldest data from `bufferStart_`.
- `virtualSize_` tracks total bytes ever written (can exceed capacity).
- Protected by `std::mutex lock_`.

**Important — flush on destruction:** the destructor writes the entire buffer to disk in a single `write()` to the log file path (`step.stdout_` / `step.stderr_`). This means:
- Zero disk I/O during step execution (pure RAM capture).
- If the server crashes while a step is running, in-flight output is lost.

### FileRing

Rotating file buffer for large / persistent output:
- Writes to `<logs_path>/stdout.<ID>.0.txt`, `.1.txt`, etc.
- When a file reaches `maxSize_`, rotates to the next index mod `nbFiles_`.
- On retrieval (`mergeAtEnd_` mode), concatenates all files in order.
- Efficient for archiving: files are already on disk.

---

## Resource Monitoring

`Linux` (system monitor) maintains:
- `CoresMonitor`: reads `/proc/stat` periodically, computes per-core utilisation ratios.
- `Memory`: reads `/proc/meminfo` for total / available / swap stats.

`Local::GatherStats()` reads cgroup `memory.current` for each running step. Results stored in `LocalData::os_memory_load_` and exposed through `RetrieveStats()` → `OSLoad`.

`Schedule::LimitRessourcesUsages()` compares `os_memory_load_` against `step.memory_max_` and kills the step if exceeded.
