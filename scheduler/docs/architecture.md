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
         html_/board, html_/board/custom, html_/board/launchers, html_/jobsscripts,
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
       scheduleAPI_ = ScheduleAPI(configSchedule, usersAPI_, OSAPI_, cachePort)
         → constructs Schedule, which:
             - builds one Executor per entry in schedule.executors_ (only "local"
               by default)
             - writes an initial tasksmanager.json / status.json
             - starts the ScheduleLoop() background thread
             - installs a SIGUSR1 handler that toggles whether running steps are
               killed on shutdown (shutdownTasksAtExit__)

  8. Construct MyServerApp(config.server_, apis)

  9. app.run() — bind plain or TLS ServerSocket, start Poco::Net::HTTPServer,
     block on waitForTerminationRequest() (SIGINT/SIGTERM)
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
| GET | `/api/task/<id>/<uuid>/<step>/output/(stdout\|stderr\|N)/<size>/<offset>` | `RequestHandlerTaskOutputs` |
| GET | `/api/task/<id>/artefacts` | `RequestHandlerTaskGetArtefacts` |
| GET | `/api/task/<id>/final_state` | `RequestHandlerTaskGetState` (final) |
| GET | `/api/task/<id>/state` | `RequestHandlerTaskGetState` |
| GET | `/api/tasks/running` | `RequestHandlerTasksRunning` |
| GET | `/api/cache/<id>` | `RequestHandlerCacheGet` |
| GET | `/api/users` | `RequestHandlerUsersList` |
| GET | `/api/user/<user>/job_types` | `RequestHandlerUserJobsTypeList` |
| GET | `/api/user/<user>/<job_type>/tasks` | `RequestHandlerUserTasksList` |
| GET | `/files/*` | `RequestHandlerFiles` |
| POST | `/api/task/new` | `RequestHandlerTaskNew` |
| PUT | `/api/cache/<id>` | `RequestHandlerCachePut` |
| PATCH | `/api/task/<id>/<priority>` | `RequestHandlerTaskUpdatePriority` |
| DELETE | `/api/task/<id>` | `RequestHandlerTaskCancel` |
| DELETE | `/api/task/<id>/step/<uuid>` | `RequestHandlerTaskCancelStep` |

Any unmatched request falls through to `RequestHandlerError` (404). Cache and user path segments are restricted to `[a-zA-Z0-9_-]` by the routing regex — see `docs/roadmap.md`. CORS (`Access-Control-Allow-Origin: *`, `OPTIONS` preflight) is handled per-handler via `RequestHandler::ManageCORS`, not globally.

---

## Board Dashboard

The board is a browser-based dashboard served as static files under `/files/board/`. It communicates with the scheduler entirely through the REST API (mainly polling `GET /api/tasks/running`).

### Embedding and installation

The core board files are embedded in the server binary at build time as C string literals via `EmbedTextFileScript` (`CMakeTextEmbedding.cmake`), listed in `CMakeLists.txt`:
`board.html`, `board.css`, `board.js`, `taskcard.css`, `taskcard.js`, `logsmanager.js`, `terminal.js`, `clipboard.js`, `task.html`, `task.css`, `task.js`, `history.html`, `history.css`, `history.js`, and `launchers/launchers.css` / `launchers/launchers.js`.

On startup, `ns_Server::Config::Validate()` extracts these into `<html_>/board/` (and creates the empty `<html_>/board/custom/`, `<html_>/board/launchers/`, `<html_>/jobsscripts/` directories) if the files are absent, or unconditionally if `--force-install` was passed.

### Static file serving

`GET /files/*` is handled by `RequestHandlerFiles`, which resolves the request path relative to `config_->html_` (default: `html/`). Path traversal is blocked: the path is `canonical()`-resolved and then checked with `relative()` to ensure it stays inside `html_`. Supported MIME types: `.html`, `.css`, `.js`, `.json`, `.txt`, `.jpg`/`.jpeg`, `.png`, `.svg` (anything else falls back to `application/octet-stream`).

The board is accessible at `GET /files/board/board.html`.

### JavaScript modules (current `html/board/` tree)

| Module | Role |
|--------|------|
| `board.js` | Entry point: polls `GET /api/tasks/running`, renders the running-step list and per-executor CPU/memory/storage stats, instantiates `TaskCard` and imports `launchers/launchers.js` |
| `taskcard.js` | Renders a single task card with step details, log modal, step attempt info |
| `launchers/launchers.js` | Generic launcher menu (the `+` button). It reads a **project registry from `./config.js`** (`config.projects`, a list of project names) and dynamically imports `./<project>/joblauncher.js` for each — one menu entry per project. Neither `config.js` nor any `<project>/` subfolder ships in this repository; they are a per-deployment extension point supplied alongside the board install |
| `terminal.js` | Scrollable in-browser log viewer |
| `logsmanager.js` | Log chunk fetching/streaming helpers (offset-based) used by the log modal |
| `clipboard.js` | Small "copy to clipboard" helper |
| `task.html` / `task.js` / `task.css` | Single-task detail view |
| `history.html` / `history.js` / `history.css` | Task history view |

Drift note: an earlier revision of this documentation set referenced `html/board/joblauncher.js` and `board/launchers/tlspuffin/jobsconfig.json` as if a single fixed job launcher shipped with the scheduler. That was never accurate for this codebase: the launcher is a generic per-project plugin loader (`launchers/launchers.js` + `launchers/<project>/joblauncher.js`), and no `jobs_config.json`/`jobsconfig.json` file exists anywhere in this repository. See `docs/board-job-launcher.md` for the actual mechanism.

---

## Runtime Filesystem Layout

```
<runPath>/
  <taskID>/
    logs/          stdout.<stepID>-<rankID>-<attemptID>.txt  (live, via MemoryRing)
                   stderr.<stepID>-<rankID>-<attemptID>.txt
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
| Content-addressed cache | Steps can skip recompilation by ID; MD5 verification is optional; `Cache::Put` is non-blocking (background copy) |
| State written to `tasksmanager.json` | Allows external tools (dashboard, scripts) to read state without hitting the API — the board's `GET /api/tasks/running` handler literally streams this file back |
| Cancelled tasks archived separately | `<exportPath>/Canceled/` keeps cancelled tasks distinct from completed runs |
| Task priority is mutable at runtime | `PATCH /api/task/<id>/<priority>` re-splices a task's pending steps within the shared `steps_` queue, which is kept sorted by descending `Task::priority_` |
