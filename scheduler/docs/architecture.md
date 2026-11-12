# Scheduler — Architecture

## Purpose

The scheduler is a C++17 HTTP server that accepts multi-step DAG task submissions via a REST API, orchestrates their execution on local CPU cores, monitors progress in real time, archives results, and optionally publishes them to a remote server.

It is built on Poco (HTTP server, TLS sockets, URI parsing), RapidJSON (all config/state serialization), libarchive (reading `.zip`/`.tgz` archives), and Linux-specific APIs (inotify, cgroup v2, `/proc`). Note: libarchive is used only for **reading** archives (`FileCompressed`, `archive_read_*`); writing the result `.zip` is done by the `Archiver` shelling out to the external `zip` command-line tool (see `schedule/archiver.cxx`), not via libarchive's write API.

---

## Component Map

```
┌──────────────────────────────────────────────────────────────┐
│                        HTTP Server (Poco)                     │
│  RequestHandlerFactory  →  RequestHandler subclasses          │
└───────────────────────────────┬──────────────────────────────┘
                                │ calls
                ┌───────────────▼───────────────────┐
                │               APIS                │
                │  ScheduleAPI  CacheAPI  UsersAPI   │
                │  owns: Linux (OS monitor)          │
                └──────┬──────────────┬─────────────┘
                       │              │               Linux& (ref)
           ┌───────────▼──┐    ┌──────▼────────┐   ┌─────────────────┐
           │   Schedule   │    │     Cache     │   │  Linux          │
           │  (main loop) ├────┤  (file store) │   │  /proc/stat     │
           │              │    └───────────────┘   │  /proc/meminfo  │
           │  ┌─────────┐ │◄──────────────────────►│  cgroup/statvfs │
           │  │ Monitor │ │  Linux& (ref)           └────────┬────────┘
           │  │(inotify)│ │                                  │ Linux& (ref)
           │  └─────────┘ │                                  │
           │  ┌─────────┐ │    ┌──────────────┐   ┌──────────▼───────┐
           │  │Archiver │ │    │  Tasks       │   │   Local executor │
           │  │(zip cmd)│ │    │  Manager     │   │  core assignment │
           │  └─────────┘ │    └──────┬───────┘   │  fork/exec/cgroup│
           └──┬───────────┘           │           └──────────────────┘
              │                       │
              └───────────────────────┘
                          │
               ┌──────────▼───────────────────────────────┐
               │  Task → Steps (DAG)                      │
               │  StepConfigurations  Monitor::Task        │
               │  Publish (config, copied into ArchiveJob) │
               └──────────────────────────────────────────┘
```

Reading notes:
- `Monitor` and `Archiver` are **members** of `Schedule`, not independent services.
- `Linux` is **owned** by `APIS` and passed by **reference** to `Schedule` (and on to each `Executor`, e.g. `Local`) — both use it concurrently.
- `Publish` is a configuration object carried by `Task`, copied passively into `ArchiveJob`; it has no independent lifecycle.
- `Schedule` implements the `ExecutorsProvider` interface itself, and owns a map of named `Executor*` instances (currently always a single `"local"` entry, since `Local` is the only concrete `Executor`).
- `TasksManager` is a member of `Schedule` (registry, not shown nested above for space): it owns all live `Task*` objects and assigns task IDs.
- `FolderRemover` (background removal of the run folders of finished tasks) and `DurationHistory` (durations of the finished steps, for the estimated times) are process-wide singletons used by `Schedule`, `Task` and the executor; not shown above. See [components.md](components.md).

---

## Startup Sequence

```
main()
  1. Parse CLI: [config-file path], --force-install, --only-install, --logslevel <n>
     (config-file defaults to "config.json" if not given)

  2. if (!config.Load(configFile) && !file_exists(configFile)):
       config.Save(configFile)   — write out a default config file
       exit(1)                   — user must edit it before first run

  3. config.Validate(forceInstall)
       — server_: canonicalize html_ (and TLS key/cert/CA if secure_), create
         html_/board, html_/board/custom, html_/jobsscripts,
         install embedded board files (see "Board Dashboard" below)
       — schedule_: canonicalize toolsPath_/runPath_/userPath_/exportPath_
         (these must already exist — Validate() does not create them),
         create exportPath_/Canceled, validate each executor config
       — cache_: validate cache storage config

  4. If --only-install: return 0 (install only, don't start the server)

  5. Apply --logslevel override if given, else use config.logsLevel_

  6. config.Save(configFile + ".run")  — snapshot of the effective runtime config

  7. Construct APIS(config.schedule_, config.cache_, config.server_.port_)
       OSAPI_       = Linux(15s interval, {"run": runPath_, "export": exportPath_})
       cacheAPI_    = CacheAPI(configCache)
       usersAPI_    = UsersAPI(configSchedule)
       scheduleAPI_ = ScheduleAPI(configSchedule, usersAPI_, OSAPI_, serverPort)
         → constructs Schedule, which:
             - loads the step durations (DurationHistory::Load: duration_history.json,
               or seeded from steps_done.json)
             - removes the run folders a stop left being deleted, and logs the
               folders of tasks it no longer holds (FolderRemover)
             - builds one Executor per entry in schedule.executors_ (only "local"
               by default)
             - writes an initial tasksmanager.json / status.json
             - starts the ScheduleLoop() background thread
             - installs a SIGUSR1 handler that toggles whether running steps are
               killed on shutdown (shutdownTasksAtExit__)

  8. Construct MyServerApp(config.server_, apis)

  9. app.run() — bind plain or TLS ServerSocket, start Poco::Net::HTTPServer on its own
     thread pool (server: max_threads, max_queued, keep-alive limits), block on
     waitForTerminationRequest() (SIGINT/SIGTERM)
```

Note: the embedded crash-recovery reload path (`TasksManager::LoadStatus`, `Task`'s JSON-loading constructor) is fully implemented but the call site in `Schedule`'s constructor is commented out — every restart starts with an empty task list. See `docs/roadmap.md`.

---

## Request Lifecycle

```
Client HTTP request
  → Poco HTTPServer thread
  → RequestHandlerFactory::createRequestHandler()
      regex match on method + URI  →  instantiate typed RequestHandler
  → RequestHandler::handleRequest()
      calls ScheduleAPI / CacheAPI / UsersAPI
      those call Schedule / Cache / UsersAPI domain objects
  → JSON (or binary/file) response written back
```

Routing (`server/request_handler_factory.hxx`) matches on HTTP method first, then a compile-time `std::regex` on the URI:

| Method | Path pattern | Handler |
|---|---|---|
| GET | `/api/task/<id>/<uuid>/<step>/output/(stdout\|stderr\|commands\|N)/<size>/<offset>` | `RequestHandlerTaskOutputs` |
| GET | `/api/task/<id>/artefacts` | `RequestHandlerTaskGetArtefacts` |
| GET | `/api/task/<id>/final_state` | `RequestHandlerTaskGetState` (final) |
| GET | `/api/task/<id>/state` | `RequestHandlerTaskGetState` |
| GET | `/api/tasks/running` | `RequestHandlerTasksRunning` |
| GET | `/api/runs/unknown` | `RequestHandlerRunsUnknown` |
| GET | `/api/cache/<id>` | `RequestHandlerCacheGet` |
| GET | `/api/users` | `RequestHandlerUsersList` |
| GET | `/api/user/<user>/job_types` | `RequestHandlerUserJobsTypeList` |
| GET | `/api/user/<user>/<job_type>/tasks` | `RequestHandlerUserTasksList` |
| GET | `/files/*` | `RequestHandlerFiles` |
| POST | `/api/task/new` | `RequestHandlerTaskNew` |
| PUT | `/api/cache/<id>` | `RequestHandlerCachePut` |
| PATCH | `/api/task/<id>/priority/<priority>` | `RequestHandlerTaskUpdatePriority` |
| PATCH | `/api/executor/<name>/max_cores/<max>/<seconds>` | `RequestHandlerExecutorMaxCores` |
| POST | `/api/runs/cleanup` | `RequestHandlerRunsCleanup` |
| PATCH | `/api/task/<id>/args` | `RequestHandlerTaskUpdateArgs` |
| DELETE | `/api/task/<id>` | `RequestHandlerTaskCancelOrDelete` |
| DELETE | `/api/task/<id>/step/<uuid>` | `RequestHandlerTaskCancelStep` |
| OPTIONS | any path | `RequestHandlerOptions` |

Any unmatched `GET`/`POST`/`PUT`/`PATCH`/`DELETE` request falls through to `RequestHandlerError` (404). `OPTIONS` is dispatched separately, on method alone (independent of URI), to `RequestHandlerOptions`. Cache and user path segments are restricted to `[a-zA-Z0-9_-]` by the routing regex — see `docs/roadmap.md`. CORS (`Access-Control-Allow-Origin: *`, `OPTIONS` preflight) is handled by every handler via `RequestHandler::ManageCORS`, called first thing in each `handleRequest()` — not a global Poco-level filter, but applied uniformly across all handlers including `RequestHandlerOptions`.

---

## Board Dashboard

The board is a browser-based dashboard served as static files under `/files/board/`. It communicates with the scheduler entirely through the REST API (mainly polling `GET /api/tasks/running`).

### Embedding and installation

The core board files are embedded in the server binary at build time as C string literals via `EmbedTextFileScript` (`CMakeTextEmbedding.cmake`), listed in `CMakeLists.txt`:
`board.html`, `board.css`, `board.js`, `taskcard.css`, `taskcard.js`, `logsmanager.js`, `terminal.js`, `clipboard.js`, `dropmenu.js`, `frame.js`, `help.js`, `health.js`, `tips.js`, `plugins.js`, `launchers.css`, `task.html`, `task.css`, `task.js`, `history.html`, `history.css`, `history.js`.

On startup, `ns_Server::Config::Validate()` extracts these into `<html_>/board/` (and creates the empty `<html_>/board/custom/` and `<html_>/jobsscripts/` directories) if the files are absent, or unconditionally if `--force-install` was passed. `<html_>/board/custom/` holds the plugins of the projects (`docs/board-job-launcher.md`), which the scheduler never writes.

### Static file serving

`GET /files/*` is handled by `RequestHandlerFiles`, which resolves the request path relative to `config_->html_` (default: `html/`). Path traversal is blocked: the path is `canonical()`-resolved and then checked with `relative()` to ensure it stays inside `html_`. Supported MIME types: `.html`, `.css`, `.js`, `.json`, `.txt`, `.jpg`/`.jpeg`, `.png`, `.svg` (anything else falls back to `application/octet-stream`).

The board is accessible at `GET /files/board/board.html`.

### JavaScript modules (current `html/board/` tree)

| Module | Role |
|--------|------|
| `frame.js` | The frame of every page, loaded first: the top bar (🔄, ❔, the status light of a scheduler named by `ShowSchedulerHealth`, the items of the plugins), the keys (Cmd/Ctrl+R, `?`, Esc) and their events (`pb-refresh`, `pb-escape` by layer, …); also loaded by the pages of the other services of a bench |
| `plugins.js` | Loader of the plugins of the projects (`custom/config.js`, `custom/<project>/plugin.js`, absent = none), the routing of their hooks (a task's hooks to the plugin of its project), the `+` button (none without a launcher); see `docs/board-job-launcher.md` |
| `health.js` | Status light of the scheduler (`GET /api/health`) and `CheckScheduler()`, the check a launcher makes before submitting |
| `board.js` | Entry point: polls `GET /api/tasks/running`, renders the running-step list and per-executor CPU/memory/storage stats, instantiates `TaskCard` with the hooks of `plugins.js`, builds the `+` button, opens a launcher from `#launch=<project>&…` |
| `taskcard.js` | Renders a single task card with step details, log modal, step attempt info; the description, arguments, monitor summaries and buttons of a task as its plugin gives them |
| `terminal.js` | Scrollable in-browser log viewer |
| `logsmanager.js` | Log chunk fetching/streaming helpers (offset-based) used by the log modal |
| `clipboard.js` | Small "copy to clipboard" helper |
| `dropmenu.js` | Drop-down menu widget (task actions) |
| `help.js` | Hover helps of the pages (`data-help` keys, with those of the plugins) and the help panel (tabs: "This page", then those of the plugins; outlines the elements with a hover help while open) |
| `tips.js` | One look for every hover: an element's `title` is shown in a styled panel (title line, `key: value` grid, ⚠/✓ lines) instead of the browser's plain tooltip |
| `task.html` / `task.js` / `task.css` | Single-task detail view: header, actions (relaunch as template, results, the links and buttons of its plugin), settings, a grid of steps × configurations, the task card |
| `history.html` / `history.js` / `history.css` | Task history view: browses archived tasks per user and job type (`GET /api/user/<u>/job_types`, `GET /api/user/<u>/<t>/tasks`), renders every finished task of every user in one list grouped by day, sortable on start time (`id`) or end time (`end_timestamp`), and loads the selected task through `GET /api/task/<id>/final_state` into a drawer. The list is gathered client-side — one request per user × job\_type pair, ten in flight at a time. Filters: a search, chips of users, job types and states, and the filters of the plugins; the plugins also add buttons and a class to the rows, name the job types and add to the counts (`history` hooks, `docs/board-job-launcher.md`). See `roadmap.md` for the scaling limit this pattern carries |

The scheduler ships no job launcher and nothing of a project: the launcher of a project, and all it adds to the pages, is a plugin under `<html>/board/custom/<project>/`, installed by the project (tlspuffin: `tlspuffin/data/html/board/custom/tlspuffin/`). See `docs/board-job-launcher.md` for the mechanism.

---

## Runtime Filesystem Layout

```
<runPath>/
  <taskID>/
    logs/          stdout.<stepID>-<rankID>-<attemptID>.txt  (live, via MemoryRing)
                   stderr.<stepID>-<rankID>-<attemptID>.txt
                   commands.<stepID>-<rankID>-<attemptID>.txt  every command of the step (executor.sh)
                   .steps.json           append-only per-task step-finish log
    output/        created but not currently archived (rename to final storage
                   is commented out in Task::FinalizeAndArchive)
    artefacts/     step outputs registered via functions.sh's CreateArtefact()
    .taskenv       global key=value parameters shared across steps
  monitors/
    <taskID>-<stepID>.txt   written by step monitor functions, watched via inotify

<exportPath>/
  tasksmanager.json          full task/step state, rewritten every loop iteration
  status.json                running-steps snapshot
  steps_done.json            append-only log of every step that finished
  duration_history.json      last durations of each kind of step, for the estimated times (see task-step-lifecycle.md)
  <taskID>.zip               completed task archive (built by `zip`, moved here)
  <taskID>.json              task metadata snapshot (post-archive)
  Canceled/
    <taskID>.zip             archive for cancelled tasks
    <taskID>.json            metadata for cancelled tasks

<userPath>/
  <taskID>/                  uploaded input files: <id>.sh (functions script),
                              <id>.json (resolved flow JSON), any files[] uploads
  users.json                  UsersAPI per-user/job-type index

<toolsPath>/                 shared tools injected into all steps (read-only)
```

`.zip` remains the sole archive format written today; `.tgz` is still recognized when *reading* archived output (`Schedule::GetOutput`, `Publish`) for backward compatibility with older archives.

---

## External Dependencies

All dependencies below (except OpenSSL and the `zip`/`xxd` command-line tools) are fetched from their upstream git repositories and built automatically on first CMake configuration (`FetchAndCreateExternalLib` in `CMakeExternal.cmake`).

| Dependency | Version pinned | How used |
|---|---|---|
| **Poco** | poco-1.14.2 | HTTP server/TLS sockets (`PocoNetSSL`, `PocoNet`), `Poco::Util::ServerApplication`, URI parsing, JSON stringify helper, multipart form parsing |
| **RapidJSON** | v1.1.0 | All JSON parsing/serialization (config, task/step state, API responses) |
| **libarchive** | v3.8.7 | Reading archives only (`FileCompressed`, `archive_read_*`) — extracting logs from a completed task's `.zip`/`.tgz` for the output API |
| **zlib** | v1.3.2 | Compression backend for libarchive |
| **OpenSSL** | system-provided (`libssl-dev`) | TLS, used transitively by Poco's `NetSSL`/`Crypto` |
| **`zip` CLI** | system-provided | Invoked via `popen()` by `Archiver::ProcessJob()` to build the result `.zip` (not a fetched/linked library — must be installed on the host) |
| **Linux inotify** | kernel API | Real-time monitor file watching (`Monitor`) |
| **Linux cgroup v2** | kernel API | Per-step CPU (`cpuset.cpus`) and memory (`memory.max`) isolation, if the cgroup subtree is writable |
| **`xxd`** | build-time only | Required at CMake configure time by `CMakeBinaryEmbedding.cmake` (`find_program(... REQUIRED)`), but not currently invoked by any target |

---

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Steps form a DAG | Enables parallel sub-tasks and explicit sequencing without a scripting DSL |
| Single scheduling thread, segmented locking | `ScheduleLoop()` releases `lockThread_` around step-dispatch, the fixed 500 ms poll sleep, and finished-step reaping, re-acquiring it only for short state-mutation sections (queue insert/removal, `SaveStatus`) — `AddTask()` and cancel/priority calls from HTTP threads only block for those short sections, not the whole iteration |
| Local executor uses fork/exec + cgroup v2 | Precise CPU affinity and memory limits per step without containers |
| inotify for monitor files | Low-overhead, kernel-push notification instead of polling |
| FDCaptureThread + epoll | Single thread multiplexes stdout/stderr of all running step processes via `MemoryRing` buffers |
| Archiver runs in a separate thread | Archive creation (`zip` subprocess) and HTTP publish do not block the scheduling loop |
| Content-addressed cache | Steps can skip recompilation by ID; `computeMD5` is accepted on `Put` but not currently implemented (no MD5 is ever computed or checked); `Cache::Put` is non-blocking (enqueues and returns — the background `CacheLoop()` thread does the actual copy) |
| State written to `tasksmanager.json` | Allows external tools (dashboard, scripts) to read state without hitting the API — the board's `GET /api/tasks/running` handler literally streams this file back |
| Cancelled tasks archived separately | `<exportPath>/Canceled/` keeps cancelled tasks distinct from completed runs |
| Task priority is mutable at runtime | `PATCH /api/task/<id>/priority/<priority>` re-splices a task's pending steps within the shared `steps_` queue, which is kept sorted by descending `Task::priority_` |
| Task args are mutable at runtime | `PATCH /api/task/<id>/args` queues new key/values in `Task::argsToUpdate_`; they're merged into `Task::args_` (and `THEJOB_ENV_PATH` if the task is `Running`) by `Task::ApplyPendingArgs()`, called around the task's next unique step rather than synchronously from the HTTP thread |
