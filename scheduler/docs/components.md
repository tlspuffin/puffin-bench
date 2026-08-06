# Scheduler — Component Reference

## Source Layout

```
html/
├── board/                      Web dashboard (served as static files under /files/board/)
│   ├── board.html / board.js / board.css     Entry point, polling loop, task list rendering
│   ├── taskcard.html/js/css                  Task card component: step display, log modal
│   ├── task.html / task.js / task.css        Single-task detail view
│   ├── history.html / history.js / history.css  Task history view
│   ├── terminal.js                           In-browser log viewer (stdout/stderr streaming)
│   ├── logsmanager.js                        Log chunk streaming helpers
│   ├── clipboard.js                          Copy-to-clipboard helper
│   └── launchers/
│       ├── launchers.css / launchers.js      Generic launcher menu; reads project list from
│       │                                     ./config.js, dynamically imports
│       │                                     ./<project>/joblauncher.js (not shipped here)
│       └── <project>/...                     Per-deployment plugin, not part of this repo

src/scheduler/
├── main.cxx                    Entry point: parse CLI, load config, start server
├── config.hxx / config.cxx     Root Config aggregating sub-configs
├── api/                        High-level API objects wiring HTTP handlers to domain logic
│   ├── api.hxx                 APIS aggregate struct
│   ├── schedule_api.hxx/cxx    ScheduleAPI  — task submission, output, cancellation, priority
│   ├── cache_api.hxx/cxx       CacheAPI     — store/retrieve cached files
│   └── users_api.hxx/cxx       UsersAPI     — per-user/job-type task index
├── server/                     HTTP server layer
│   ├── server.hxx/cxx          MyServerApp  — Poco socket + HTTPServer setup
│   ├── request_handler.hxx/cxx RequestHandler base, CORS, static file helpers, all handlers
│   ├── request_handler_factory.hxx  URL regex routing → typed handler classes
│   └── parts_handler.hxx/cxx   Poco::Net::PartHandler implementation for multipart uploads
├── schedule/                   Core scheduling engine
│   ├── schedule.hxx/cxx        Schedule     — main loop, step dispatch
│   ├── task.hxx/cxx            Task         — workflow container
│   ├── step.hxx/cxx            Step         — single executable unit, state machine
│   ├── tasksmanager.hxx/cxx    TasksManager — task registry + ID assignment + state serialization
│   ├── step_configurations.hxx/cxx  StepConfigurations / GroupStepConfigurations
│   ├── config.hxx/cxx          Schedule::Config (paths, executors_, publishers_)
│   ├── archiver.hxx/cxx        Archiver     — background archive-creation thread (shells out to `zip`)
│   ├── publish.hxx/cxx         Publish      — local move/symlink or HTTP upload to remote server
│   ├── ressources_summary.hxx  SRessourcesSummary — helper for picking which task to kill under load
│   ├── monitor/
│   │   ├── monitor.hxx/cxx     Monitor      — inotify watcher on monitor files
│   │   └── task.hxx/cxx        Monitor::Task — per-step monitor entrypoint/interval/timeout config
│   └── executor/
│       ├── executor.hxx/cxx    Executor     — abstract execution backend, ExecutorData/-TaskData
│       ├── executors_provider.hxx  ExecutorsProvider interface (implemented by Schedule)
│       ├── local.hxx/cxx       Local        — local fork/exec backend, LocalData/LocalTaskData
│       ├── config.hxx/cxx      ns_Executor::Config / LocalConfig
│       └── output_ring.hxx/cxx OutputBuffer, FileRing (unused), MemoryRing, FDCaptureThread
├── cache/
│   ├── cache.hxx/cxx           Cache        — content-addressed file store
│   └── config.hxx/cxx          Cache::Config
└── system/
    ├── linux.hxx/cxx           Linux        — aggregated OS monitor
    ├── linux_cores.hxx/cxx     CoresMonitor / CoreStats / CoresStats — /proc/stat-based CPU load
    ├── linux_memory.hxx/cxx    MemoryMonitor  — /proc/meminfo reader
    └── linux_process.hxx/cxx   ProcessMonitor — session-based PID lookup

src/utils/                      Cross-cutting helpers: logs, rapidjson helpers, MD5, file I/O,
                                 file_compressed (libarchive read wrapper), variable substitution,
                                 directory helpers
```

---

## `Config` (`config.hxx` / `config.cxx`)

Root configuration aggregate: `logsLevel_` plus `ns_Server::Config server_`, `ns_Schedule::Config schedule_`, `ns_Cache::Config cache_`. `Load()`/`Save()` (de)serialize to/from a single JSON file. `Validate(forceInstall)` delegates to each sub-config's own `Validate()` — creates required runtime directories, installs the embedded board HTML/JS/CSS into `html_/board/` if absent (or unconditionally with `--force-install`).

---

## `APIS` (`api/api.hxx`)

Aggregate struct owning all domain API objects, constructed once in `main()`:

```cpp
struct APIS {
  ns_System::Linux OSAPI_;        // OS monitor (owned), 15s sample interval
  ns_API::CacheAPI cacheAPI_;
  ns_API::UsersAPI usersAPI_;
  ns_API::ScheduleAPI scheduleAPI_;
};
```

`OSAPI_` (`Linux`) is owned here and passed by reference into `ScheduleAPI` → `Schedule` → each `Executor` (e.g. `Local`) — all read it concurrently, protected internally by `Linux`'s own lock.

---

## `ScheduleAPI` (`api/schedule_api.hxx` / `.cxx`)

Facade for task management operations, owning the `Schedule` instance directly (not a pointer).

Key methods called by HTTP handlers:
- `AddTask(name, flow, functions, files, args, runtimeConfig, user, jobType)` — parses the multipart upload and enqueues a new task.
- `GetOutput(type, taskID, stepUUID, stepID, data)` — reads live or archived stdout/stderr.
- `CancelTask(taskID)` / `CancelStep(taskID, stepUUID)` — forwards to `Schedule`, tagging the cancel source as `"rest api request"`.
- `TaskUpdatePriority(taskID, newPriority)` — re-orders a task's steps in the pending queue.
- `GetTaskData(taskID, ...)` / `GetTaskFinalData(taskID, ...)` — resolve state/artefact file paths for a running or archived task.
- `TaskManagerStateFile()` — path to `tasksmanager.json`, streamed directly by `/api/tasks/running`.

---

## `CacheAPI` (`api/cache_api.hxx`)

Thin facade over `Cache`, translating `Cache::GetStatus` to the strings `"Ok"` / `"Locked"` / `"Not Available"` used in the JSON response.

---

## `UsersAPI` (`api/users_api.hxx` / `.cxx`)

Maintains a per-user, per-job-type task index as an in-memory RapidJSON document. Protected by `std::shared_mutex lockDB_` (shared for reads, unique for `Save()`). Persists to `<userPath>/users.json`; `Add(task, running)` is called on submission and again when the task ends.

---

## `MyServerApp` (`server/server.hxx` / `.cxx`)

Extends `Poco::Util::ServerApplication`. Builds a plain `Poco::Net::ServerSocket` or, if `config_.secure_`, a `SecureServerSocket` with a TLS `Context` (key/cert/CA from config, `VERIFY_NONE`). Starts `Poco::Net::HTTPServer` backed by `RequestHandlerFactory`, then blocks on `waitForTerminationRequest()`.

---

## `RequestHandlerFactory` (`server/request_handler_factory.hxx`)

Matches HTTP method + URI against a fixed set of compile-time `std::regex` patterns (see `docs/architecture.md` for the full table). Instantiates the matching typed `RequestHandler` (heap-allocated; Poco takes ownership) and calls `Configure(config, apis)` on it. Falls through to `RequestHandlerError` (404) on no match.

## `RequestHandler` / handler classes (`server/request_handler.hxx` / `.cxx`)

`RequestHandler` is the common base (holds `config_`/`apis_` pointers, `ManageCORS()`, `SendFile()`). Each concrete handler is generated by the `REQUESTHANDLER(name, ...)` macro, which stores its regex-captured arguments in a `std::tuple` and declares `handleRequest()`. Notable handlers:
- `RequestHandlerTaskNew` — parses the multipart form (`PartsHandler`, `server/parts_handler.hxx`) for `config`/`script`/`files[]` parts and `args[...]`/`runtime[...]` fields, then calls `ScheduleAPI::AddTask`.
- `RequestHandlerTaskOutputs` — reads a slice of stdout/stderr (live or archived), Base64-encodes it into the JSON response.
- `RequestHandlerFiles` — static file server for `/files/*`, canonicalizes and checks the resolved path stays under `config_->html_`.

---

## `Schedule` (`schedule/schedule.hxx` / `.cxx`)

The central scheduling engine. Implements `ExecutorsProvider`. Owns `TasksManager tasksManager_`, `Monitor monitor_`, `Archiver archiver_`, and a `std::unordered_map<std::string, Executor*> executors_` (built from `config.executors_`, normally just `"local"`).

`ScheduleLoop()` runs in a dedicated background thread, started from the constructor and restarted from `AddTask()` if it had stopped:
1. `SearchTasksToRun()` — asks every executor's `FindRunnableSteps()` for steps in `steps_` that can start now.
2. `step->Execute()` for each — calls into the assigned `Executor`.
3. `LimitRessourcesUsages()` — per-executor CPU/memory pressure check; may `CancelTask()` the worst offender.
4. `SaveStatus(true)` — writes `tasksmanager.json` + `status.json`.
5. `sleep_for(500ms)`.
6. Per-executor `CheckFinishedSteps()` — reaps completed processes (`waitpid(WNOHANG)`-style, executor-specific); OS-killed steps (e.g. cgroup OOM) trigger `CancelTask()` with a memory-pressure reason.
7. Timed-out running steps are killed via `KillAndMarkTimedout()`.
8. `Monitor::GetChange()` — pulls newly-changed monitor messages.
9. Cancel-flagged steps are killed/marked, dependent steps promoted, `ManageEndOfStep()` finalizes finished tasks (moves logs/artefacts, enqueues an `ArchiveJob`, notifies `UsersAPI`/`TasksManager`).

`lockThread_` is **not** held for the whole iteration: it is acquired only around the short queue-mutation sections (step selection, status save, cancel/finalize processing), and released during step dispatch, the 500 ms sleep, and finished-step reaping. `AddTask()`, `CancelTask()`, `CancelStep()`, and `TaskUpdatePriority()` (all callable from HTTP threads) each take `lockThread_` for their own short critical section.

---

## `Task` (`schedule/task.hxx` / `.cxx`)

Workflow container. `id_` is a `uint64_t` assigned by `TasksManager::CreateTask()` as the submission time in milliseconds since epoch (monotonically bumped if two tasks land in the same millisecond). Holds `root_steps_` (the DAG entry points), `configurations_` (`StepConfigurations`), `args_`, `publish_` (a `Publish` config copy), `executor_`/`executor_data_`, and per-task filesystem paths (`run_root_path_`, `logs_path_`, `artefacts_path_`, ...). Two constructors: one builds a task from a submitted flow JSON (`CreateStepsFromJson`), the other rebuilds a task from a previously-serialized JSON blob (used by the disabled crash-recovery path). `FinalizeAndArchive()` moves `logs/`/`artefacts/` into the export directory, writes the task JSON snapshot, and returns an `ArchiveJob` for the `Archiver`.

---

## `Step` (`schedule/step.hxx` / `.cxx`)

Single executable unit with a private state machine: `Pending → Running → Done / TimedOut / Cancelled / Shutdown / LaunchError`. `IsReady()` is true when `state_ == Pending && depend_from_.empty()`. Steps are linked both as a retry chain (`next_`/`previous_`) and as a DAG (`dependencies_`/`depend_from_`). `ID()` is `"<step_id>-<rank_id>-<attempt_id>"`, used to name log/monitor files. `Execute()` calls `Task::PrepareToRun()` on the first step of a task, then delegates to `task_->executor_->Execute(*this)`.

---

## `TasksManager` (`schedule/tasksmanager.hxx` / `.cxx`)

Task registry, guarded by its own `std::mutex lock_` (independent of `Schedule::lockThread_`). `CreateTask()` assigns the millisecond-timestamp ID, writes the uploaded functions script and `files[]` uploads to `<userPath>/<id>/`, computes per-file and aggregate MD5s, then constructs the `Task`. `LoadStatus()` (rebuild tasks from a serialized `tasksmanager.json`) exists and is functional but is not called anywhere (see `docs/roadmap.md`). `ToJSON()` / `GetTaskState()` serialize live task state for the API and dashboard.

---

## `Monitor` (`schedule/monitor/monitor.hxx` / `.cxx`)

inotify watcher on `<runPath>/monitors/` (single flat directory shared by all tasks; filenames are `<taskID>-<stepID>.txt`). Runs in a dedicated thread reading `IN_MOVED_TO` events (monitor scripts write to a temp file then rename, avoiding partial-read races).

- `Add(steps)` / `Remove(steps)` — register/unregister steps by their `monitor_path_` filename; `Remove()` also does a final synchronous read into `step->message_from_run_` and deletes the file.
- `GetChange()` — swaps out the accumulated `monitorsMessage_` map, writes each message into the corresponding `step->message_from_run_`, returns whether anything changed (drives `SaveStatus` in `ScheduleLoop`).

`Monitor::Task` (`monitor/task.hxx`) is a small per-step value type (entry point, interval/timeout/delay-start, all stored as strings) built from a step's `monitor` JSON block; `ToArgs()` renders it as the argument string passed to the step's launcher.

---

## `Archiver` (`schedule/archiver.hxx` / `.cxx`)

Background thread (started in the constructor, joined in the destructor) for async archive creation and result publishing, driven by a `std::queue<ArchiveJob>` behind a mutex + condition variable.

- `AddJob(job)` — enqueues (called from `Schedule::ManageEndOfStep`, non-blocking).
- `ThreadLoop()` — waits on the condition variable, pops a job, calls `ProcessJob()`, then `job.publish_.PublishResults()` if `doPublish_`.
- `ProcessJob(job)` — verifies all `sources_` exist, then builds the archive by shelling out to the `zip` command via `popen()` (`cd <baseDir> ; zip -r <tmp path> <relative sources...>`), renames the `.tmp` file into place, and optionally removes `deleteDir_`. **Not** libarchive-based despite the historical assumption that write-side archiving used `archive_write_*`.
- `WaitForCompletion()` — called at shutdown; polls the queue size with `sleep_for(100ms)` until empty (busy-wait, no condition-variable signal on drain — see `docs/roadmap.md`).

---

## `Publish` (`schedule/publish.hxx` / `.cxx`)

Configuration + execution object for result publishing, carried by `Task` and copied into `ArchiveJob`. Called by `Archiver::ThreadLoop()` after a successful archive.

- **Local storage**: `MoveFileAndCreateSymLink()` moves the `.zip` to a configured path and creates a symlink.
- **Remote HTTP**: `PublishToServer()` POSTs the archive via `Poco::Net::HTTPSClientSession` (or plain HTTP), optionally skipping certificate verification (`checkServerCertificat_`).
- `ViewLink()` expands `${VAR}` placeholders (`ResolveVariables`, `utils/variables.hxx`) in `viewEndpoint_` against per-task variables (e.g. `TASK_ID`, `TASK_USER`, `TASK_JOB_TYPE`, plus the task's own `args_`).

---

## `Executor` / `Local` (`schedule/executor/`)

`Executor` is an abstract execution backend (`executor.hxx`); `ExecutorsProvider::GetExecutor(name)` is implemented by `Schedule`. `Executor::Build()` currently only handles `Config::Type::Local`, throwing on anything else — `Local` is the only concrete backend (see `docs/roadmap.md`).

`Local::Execute(step)`:
1. Allocates a `LocalData` (per-step) from the task's `LocalTaskData`; builds per-step file paths (`run_path_`, `artefacts_file_`, `fatalerror_file_`, `done_file_`, launcher/state/parameters files).
2. Creates stdout/stderr pipes, bumps their kernel buffer to 1 MiB, and registers the read ends with `FDCaptureThread` backed by a `MemoryRing` sized from `Local::Config::logsSize_`.
3. Assigns CPU cores via `CoresMonitor::SelectMostIdleCores()` (`AssignCores()`).
4. `fork()`: the child joins a new cgroup v2 leaf (`memory.max` / `cpuset.cpus` if the cgroup subtree is writable), calls `setsid()`, pins itself to its assigned cores (`PinCoresToProcess`), `chdir()`s into its run path, writes a `THEJOB_*` environment file (`-launcher`), then `execv()`s the embedded `executor.sh` script (`config_.scriptPath_/executor.sh`) which in turn sources `functions.sh` and invokes the step's bash entry point.
5. The parent stores the child PID, releases cores on fork failure, and later reaps it through `CheckFinishedSteps()` / `WaitSessionEnd()`.

`Local` also implements crash-reload hooks (`CheckReloadRunning`, `VerifyProcessArgs`, `CheckExternalProcessIsRunning`) for re-attaching to still-running child processes after a restart — functional but unreachable today since the `Schedule`-level reload call is disabled.

`output_ring.hxx` (`executor/output_ring.hxx` / `.cxx`) provides the buffering primitives used by `FDCaptureThread`:
- `MemoryRing` — the buffer actually used everywhere (bounded in-memory ring, thread-safe `Write`/`Read`).
- `FileRing` — a fully implemented rotating file-based buffer, but never instantiated anywhere in the codebase (not even by the standalone `testFilesRing` test binary, which actually exercises `MemoryRing`). Dead code — see `docs/roadmap.md`.
- `FDCaptureThread` — pools a small number of shared epoll threads (`FDCaptureThreadImpl`, load-balanced via a static `threadsPoll__`) that multiplex many step file descriptors.

---

## `Cache` (`cache/cache.hxx` / `.cxx`)

Content-addressed file store identified by opaque string IDs (restricted to `[a-zA-Z0-9_-]` by the HTTP routing regex — see `docs/roadmap.md`).

- **Put**: enqueues onto `dataToAdd_` and returns immediately; a background `CacheLoop()` thread copies the file and optionally computes an MD5, then flips `FileInformations::full_`.
- **Get**: `shared_lock` on `dataLock_`; returns `OK` (ready), `PARTIAL` (still copying), or `NO` (unknown ID).
- **Persistence**: ID→path (+MD5) mapping stored under the configured storage path as JSON, rebuilt (`LoadData()`) at startup; a copy log (`SaveCopyLog`/`DeleteCopyLog`) tracks in-flight copies for crash diagnostics.

---

## `Linux` (`system/linux.hxx` / `.cxx`)

Aggregated OS monitor. Owns `CoresMonitor`, `MemoryMonitor`, `ProcessMonitor`, and a `storages_` map (`name → path`, e.g. `"run"` / `"export"`, configured from `APIS`'s constructor). Runs a background thread (`ThreadLoop`) sampling `/proc/stat`, `/proc/meminfo`, and storage usage (via `statvfs`) every `time_interval_` seconds (15 s in `main.cxx`).

- `Cores()` / `Memory()` — thread-safe accessors (each takes `lock_`); `Process()` is lock-free/stateless.
- `GetLoad(global, perCores, memory, storages)` — one-shot snapshot used to populate the dashboard's per-executor stats block.
- `CoresMonitor::SelectMostIdleCores()` — used by `Local::AssignCores()` for core assignment.

Used by: `Local` (core assignment, cgroup memory stats), `Schedule::LimitRessourcesUsages()` (resource-pressure enforcement), and the `/api/tasks/running` executor-stats payload consumed by `board.js`.
