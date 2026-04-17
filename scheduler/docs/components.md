# Scheduler — Component Reference

## Source Layout

```
html/
├── board/                      Web dashboard (served as static files under /files/board/)
│   ├── board.html              Entry point — dashboard page
│   ├── board.js                Main module: polling loop, task list rendering
│   ├── taskcard.js             Task card component: step display, log modal
│   ├── joblauncher.js          Job submission dialog
│   ├── terminal.js             In-browser log viewer (stdout/stderr streaming)
│   ├── logs.js                 Log streaming helpers
│   ├── board.css / taskcard.css / joblauncher.css   Styles
│   └── launchers/tlspuffin/jobsconfig.json  Job-type registry (embedded in launcher)
└── jobs_scripts/               Flow JSON files and bash step scripts (installed by server)
    ├── *.json                  Flow definitions (referenced by jobsconfig.json)
    └── *.sh                    Step scripts (referenced by jobsconfig.json)

src/scheduler/
├── main.cxx                    Entry point: parse CLI, load config, start server
├── config.hxx / config.cxx     Root Config aggregating sub-configs
├── api/                        High-level API objects wiring HTTP handlers to domain logic
│   ├── api.hxx                 APIS aggregate struct
│   ├── schedule_api.hxx/cxx    ScheduleAPI  — task submission, output, cancellation
│   ├── cache_api.hxx/cxx       CacheAPI     — store/retrieve cached files
│   └── users_api.hxx/cxx       UsersAPI     — per-user/job-type task index
├── server/                     HTTP server layer
│   ├── server.hxx/cxx          MyServerApp  — Poco socket + HTTPServer setup
│   ├── request_handler.hxx     RequestHandler base, CORS, static file helpers
│   └── request_handler_factory.hxx  URL regex routing → typed handler classes
├── schedule/                   Core scheduling engine
│   ├── schedule.hxx/cxx        Schedule     — main loop, step dispatch
│   ├── task.hxx/cxx            Task         — workflow container
│   ├── step.hxx/cxx            Step         — single executable unit, state machine
│   ├── tasksmanager.hxx/cxx    TasksManager — task registry + state persistence
│   ├── step_configurations.hxx StepConfigurations / GroupStepConfigurations
│   ├── config.hxx/cxx          Schedule::Config
│   ├── archiver.hxx/cxx        Archiver     — background archive creation thread
│   ├── publish.hxx/cxx         Publish      — HTTP upload to remote server
│   ├── monitor/
│   │   ├── monitor.hxx/cxx     Monitor      — inotify watcher on monitor files
│   │   └── task.hxx/cxx        Monitor::Task — per-step monitor config
│   └── executor/
│       ├── executor.hxx/cxx    Executor     — abstract execution backend
│       ├── local.hxx/cxx       Local        — local fork/exec backend
│       ├── config.hxx/cxx      Local::Config
│       ├── linux_cores.hxx/cxx CoresMonitor — /proc/stat-based CPU load
│       └── output_ring.hxx/cxx OutputBuffer, FileRing, MemoryRing, FDCaptureThread
├── cache/
│   ├── cache.hxx/cxx           Cache        — content-addressed file store
│   └── config.hxx/cxx          Cache::Config
└── system/
    ├── linux.hxx/cxx           Linux        — aggregated OS monitor
    ├── linux_cores.hxx/cxx     CoresMonitor — per-core utilisation
    ├── linux_memory.hxx/cxx    MemoryMonitor  — /proc/meminfo reader
    └── linux_process.hxx/cxx   ProcessMonitor — session-based PID lookup
```

---

## `Config` (`config.hxx` / `config.cxx`)

Root configuration aggregate. Aggregates `ns_Server::Config`, `Schedule::Config`, and `Cache::Config`.

`Validate(forceInstall)`:
- Creates required runtime directories.
- Installs embedded board HTML/JS/CSS into `html_/board/` if absent or `--force-install` passed.

---

## `APIS` (`api/api.hxx`)

Aggregate struct owning all domain API objects:

```cpp
struct APIS {
  Linux        OSAPI_;        // OS monitor (owned)
  CacheAPI     cacheAPI_;
  UsersAPI     usersAPI_;
  ScheduleAPI  scheduleAPI_;
};
```

`Linux` is owned here and passed by reference to `Schedule` and the `Local` executor — both use it concurrently.

---

## `ScheduleAPI` (`api/schedule_api.hxx` / `.cxx`)

Facade for task management operations. Owns the `Schedule` instance.

Key methods called by HTTP handlers:
- `AddTask(task)` — enqueues a parsed task into the schedule loop.
- `GetOutput(taskID, stepUUID, stepID, type, size, offset)` — reads live or archived output.
- `CancelTask(taskID)` / `CancelStep(taskID, stepUUID)` — sets cancel flags.
- `GetFinalState(taskID)` — reads metadata from the archived `.json` file.
- `GetArtefacts(taskID)` — lists registered step artefacts.

---

## `CacheAPI` (`api/cache_api.hxx` / `.cxx`)

Facade over the `Cache` content-addressed store.

- `Put(id, srcPath, computeMD5, force)` — delegates to `Cache::Put()` (non-blocking).
- `Get(id, outPath)` — delegates to `Cache::Get()` (returns `OK`, `PARTIAL`, or `NO`).

---

## `UsersAPI` (`api/users_api.hxx` / `.cxx`)

Maintains a per-user, per-job-type task index. Protected by `std::shared_mutex lockDB_`.

Persists to `<userPath>/users.json`. Updated on each task submission.

---

## `MyServerApp` (`server/server.hxx` / `.cxx`)

Extends `Poco::Util::ServerApplication`. Opens a plain or TLS `ServerSocket` and starts `Poco::Net::HTTPServer` backed by `RequestHandlerFactory`. Blocks until `SIGTERM` / `SIGINT`.

---

## `RequestHandlerFactory` (`server/request_handler_factory.hxx`)

Matches URI against compile-time regex patterns in order. Instantiates the appropriate typed `RequestHandler` (heap-allocated; Poco takes ownership). Falls through to a 404 handler on no match.

---

## `Schedule` (`schedule/schedule.hxx` / `.cxx`)

The central scheduling engine. Owns `Monitor`, `Archiver`, and an `Executor*`.

`ScheduleLoop()` runs in a dedicated background thread:
1. `SearchTasksToRun()` — promotes ready steps from `steps_` to the runnable list.
2. `Executor::FindRunnableSteps()` — filters by available resources.
3. `Executor::Execute()` — fork/exec each runnable step.
4. `Executor::CheckFinishedSteps()` — `waitpid(WNOHANG)` on running steps.
5. `ManageEndOfStep()` — activates dependent steps; archives completed tasks.
6. `Monitor::GetChange()` — pulls new monitor messages.
7. `LimitRessourcesUsages()` — kills steps exceeding memory limits.
8. `SaveStatus()` — writes `tasksmanager.json` + `status.json`.

`lockThread_` is held for the **entire body** of each iteration. `AddTask()` (HTTP thread) also acquires this lock. `CancelTask()` / `CancelStep()` set atomic flags without locking.

---

## `Task` (`schedule/task.hxx` / `.cxx`)

Workflow container. Identified by a `uint64_t id_` (submission timestamp in milliseconds). Holds the DAG of `Step*` root steps, global `args_`, `StepConfigurations`, and `Publish` config.

---

## `Step` (`schedule/step.hxx` / `.cxx`)

Single executable unit with a state machine: `Pending → Running → Done / Cancelled / TimedOut / LaunchError / Shutdown`.

`IsReady()` returns true when `state_ == Pending && depend_from_.empty()`.

See `docs/task-step-lifecycle.md` for the full state machine and DAG traversal details.

---

## `TasksManager` (`schedule/tasksmanager.hxx` / `.cxx`)

Task registry. Maps `task ID → Task*`. Handles creation (assigns ID, parses flow JSON, computes MD5s of uploaded files), deletion, and JSON serialization (`ToJSON()` / `LoadStatus()`).

---

## `Monitor` (`schedule/monitor/monitor.hxx` / `.cxx`)

inotify watcher on `<runPath>/monitors/`. Runs in a dedicated thread.

- `Add(step)` / `Remove(step)` — register/unregister steps.
- `GetChange()` — returns `true` if any monitor file changed since last call (used by `ScheduleLoop`).
- `GetMessage(step)` — retrieves the latest monitor message for a step.

---

## `Archiver` (`schedule/archiver.hxx` / `.cxx`)

Background thread for async `.zip` archive creation and result publishing.

- `AddJob(ArchiveJob)` — enqueues a job (called from the schedule loop, non-blocking).
- `ProcessJob(job)` — runs libarchive write, then calls `Publish::PublishResults()` if configured.
- `WaitForCompletion()` — called at shutdown to drain pending jobs.

---

## `Publish` (`schedule/publish.hxx` / `.cxx`)

Configuration + execution object for result publishing. Called by `Archiver::ProcessJob()`.

- **Local storage**: moves the `.zip` archive to a configured path and creates a symlink.
- **Remote HTTP**: POSTs the archive via `Poco::Net::HTTPSClientSession` (or plain HTTP) as multipart.

Variable substitution: `${VAR}` placeholders in destination paths are expanded using `taskVariables` (e.g. `${JOB_TYPE}`, `${COMMIT_ID}`).

---

## `Executor` / `Local` (`schedule/executor/`)

Abstract execution backend. Only one implementation exists: `Local`.

`Local::Execute(step)`:
1. Writes a `step_parameters_file.json` with all environment variables for the step.
2. Assigns CPU cores via `CoresMonitor::SelectMostIdleCores()`.
3. `fork()` + `exec("bash", "executor.sh", ...)`.
4. Sets up cgroup v2 subtree for CPU/memory isolation (if available).
5. Registers stdout/stderr pipe ends with `FDCaptureThread`.

See `docs/executor.md` for the full executor design and output capture details.

---

## `Cache` (`cache/cache.hxx` / `.cxx`)

Content-addressed file store. Identified by opaque string IDs.

- **Put**: non-blocking insert — a background worker thread copies the file and optionally computes MD5.
- **Get**: `shared_lock` read — returns `OK` (ready), `PARTIAL` (copying), or `NO` (not found).
- **Persistence**: ID→path mapping stored in `<storagePath>/<mappingFile>` as JSON; rebuilt at startup.

---

## `Linux` (`system/linux.hxx` / `.cxx`)

Aggregated OS monitor. Owns `CoresMonitor`, `MemoryMonitor`, and `ProcessMonitor`. Runs a background thread sampling `/proc/stat`, `/proc/meminfo`, and storage partitions (via `statvfs`) at a configurable interval (default 15 s).

Sub-system members are private; accessed via thread-safe inline methods `Cores()`, `Memory()` (each holding `lock_`), and `Process()` (lock-free, stateless).

Constructor takes a `storages` map (`name → path`) — storage usage is polled and reported per named partition (e.g. `"run"`, `"export"`).

Used by:
- `Local::GatherStats()` — per-step cgroup memory stats.
- `Schedule::LimitRessourcesUsages()` — resource limit enforcement.
- `CoresMonitor::SelectMostIdleCores()` — core assignment for new steps.
