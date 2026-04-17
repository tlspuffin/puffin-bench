# Scheduler — Architecture Overview

## Purpose

The scheduler is a C++ HTTP server that accepts task submissions via REST API, orchestrates multi-step workflow execution on local CPU cores, monitors progress in real time, archives results, and optionally publishes them to a remote server.

It is built on top of the Poco C++ libraries (HTTP server), RapidJSON (config/state serialization), libarchive (reading `.tgz` archives), and Linux-specific APIs (inotify, cgroup v2, `/proc`). Archive **creation** uses the system `tar` binary via `popen()` ; libarchive est utilisé uniquement en **lecture** (extraction de fichiers de logs depuis les archives via `FileTGZ`).

---

## Top-level Source Layout

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
│   └── jobs_config.json        Job-type registry (maps job types to flow JSON + scripts)
└── jobs_scripts/               Flow JSON files and bash step scripts for each job type
    ├── *.json                  Flow definitions (referenced by jobs_config.json)
    └── *.sh                    Step scripts (referenced by jobs_config.json)

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
│   ├── archiver.hxx/cxx        Archiver     — background .tgz creation thread
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
    ├── linux_memory.hxx/cxx    Memory       — /proc/meminfo reader
    └── linux_process.hxx/cxx   Process      — session-based PID lookup
```

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
           │  ┌─────────┐ │◄──────────────────────►│  cgroup stats   │
           │  │ Monitor │ │  Linux& (ref)           └────────┬────────┘
           │  │(inotify)│ │                                  │ Linux& (ref)
           │  └─────────┘ │                                  │
           │  ┌─────────┐ │                       ┌──────────▼───────┐
           │  │Archiver │ │    ┌──────────────┐   │   Local executor │
           │  │  (tar)  │ │    │  Tasks       │   │  core assignment │
           │  └─────────┘ │    │  Manager     │   │  fork/exec/cgroup│
           └──┬───────────┘    └──────┬───────┘   └──────────────────┘
              │                       │
              └───────────────────────┘
                          │
               ┌──────────▼───────────────────────────────┐
               │  Task → Steps (DAG)                      │
               │  StepConfigurations  Monitor::Task        │
               │  Publish (config, copied into ArchiveJob) │
               └──────────────────────────────────────────┘
```

Notes de lecture :
- `Monitor` et `Archiver` sont des **membres** de `Schedule`, pas des services indépendants
- `Linux` est **possédé** par `APIS` et passé par **référence** à `Schedule` et à `Local` — les deux s'en servent en même temps
- `Publish` est un objet de configuration porté par `Task`, copié passivement dans `ArchiveJob` ; il n'a pas de cycle de vie propre

---

## Startup Sequence

```
main()
  1. Parse CLI: config-file path, --install / --force-install, --logslevel

  2. if (!config.Load(configFile) && !file_exists(configFile)):
       config.Save(configFile)   — create a default config file
       exit(1)                   — user must edit it before first run

  3. config.Validate(forceInstall)  — create dirs, certs, install embedded HTML

  4. If --install: exit 0 (install only, don't start server)

  5. Apply --logslevel override (or read from config.logsLevel_)

  6. config.Save(configFile + ".run")  — snapshot of effective runtime config

  7. Construct APIS(configSchedule, configCache, serverPort)
       OSAPI_      = Linux(15s interval)
       cacheAPI_   = CacheAPI(configCache)
       usersAPI_   = UsersAPI(configSchedule)
       scheduleAPI_= ScheduleAPI(configSchedule, usersAPI_, OSAPI_, cachePort)
         → Schedule constructor starts ScheduleLoop() background thread

  8. Construct MyServerApp(config.server_, apis)

  9. app.run() — bind socket, start Poco HTTPServer
```

---

## Request Lifecycle (summary)

```
Client HTTP request
  → Poco HTTPServer thread
  → RequestHandlerFactory::createRequestHandler()
      regex match on URI  →  instantiate typed RequestHandler
  → RequestHandler::handleRequest()
      calls ScheduleAPI / CacheAPI / UsersAPI
      those call Schedule / Cache / UsersAPI domain objects
  → JSON / binary response written back
```

---

## Board Dashboard

The board is a browser-based dashboard served as static files. It communicates with the scheduler entirely through the REST API.

### Embedding and Installation

The board files (`board.html`, `board.js`, `taskcard.js`, `joblauncher.js`, `terminal.js`, CSS files) are embedded in the server binary at build time via `xxd -i`. On startup, `Server::Config::Validate()` extracts them to `<html_>/board/` if they are absent or if `--force-install` was passed.

### Static File Serving

`GET /files/*` is handled by `RequestHandlerFiles`, which resolves the request path relative to `config_->html_` (default: `html/`). Path traversal is blocked: `canonical()` + `relative()` check ensures the resolved path stays inside `html_/`. Supported MIME types: HTML, CSS, JS, JSON, images.

The board is accessible at `GET /files/board/board.html`.

### JavaScript Modules

| Module | Role |
|--------|------|
| `board.js` | Entry point: polls `GET /api/tasks/running`, renders the task list, instantiates `TaskCard` and `JobLauncher` |
| `taskcard.js` | Renders a single task card with step details, log modal (calls `GetOutput`), step attempt info |
| `joblauncher.js` | Job submission dialog: reads `jobs_config.json`, lets the user pick a job type and a commit, fetches the corresponding JSON + script files, then POSTs them as multipart to `POST /api/task/new` |
| `terminal.js` | Scrollable log viewer used inside the log modal |
| `logs.js` | Log chunk fetching helpers (offset-based streaming) |

### `jobs_config.json` — Job Type Registry

`joblauncher.js` loads `jobs_config.json` (served from `GET /files/board/jobs_config.json`) at startup. Each entry describes one submittable job type:

```json
{
  "jobs": [
    {
      "value":    "vuln-a",
      "label":    "Vuln group A",
      "job_type": "vuln-a",
      "color":    "#FF9800",
      "campaign": false,
      "config":   "/files/jobs_scripts/PR_vulnerabilities-groupA_cargo.json",
      "script":   "/files/jobs_scripts/PR_vulnerabilities_full.sh",
      "files":    ["/files/jobs_scripts/shell.nix"]
    }
  ]
}
```

When the user submits a job, `joblauncher.js` GETs each `config`, `script`, and `files` URL (all served from `html/jobs_scripts/`), then assembles a multipart form and POSTs it to `/api/task/new`.

### `html/jobs_scripts/` — Job Scripts

This directory holds the flow JSON files and bash step scripts that define each job type. They are not embedded in the binary — they are served as plain static files and can be updated independently of the server binary.

For a complete reference on `jobs_config.json` format, campaign parameters, the commit source feed, and how to add a new job type, see [board-job-launcher.md](board-job-launcher.md).

---

## Runtime Filesystem Layout

```
<runPath>/
  <taskID>/
    logs/          stdout.<stepID>-<confID>-<attempt>.txt  (live)
                   stderr.<stepID>-<confID>-<attempt>.txt
    artefacts/     step outputs registered via CreateArtefact
    task.json      task metadata snapshot
  monitors/
    <taskID>-<stepID>.txt   written by step monitor functions

<exportPath>/
  tasksmanager.json          full task/step state (updated continuously)
  status.json                running steps snapshot
  <taskID>.tgz               completed task archive (success or failed steps)
  <taskID>.json              task metadata (post-archive)
  Canceled/
    <taskID>.tgz             archive for cancelled tasks
    <taskID>.json            metadata for cancelled tasks

<userPath>/
  <taskID>/                  uploaded input files (script, configs, …)

<toolsPath>/                 shared tools injected into all steps
```

---

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Steps form a DAG | Enables parallel sub-tasks and explicit sequencing without a scripting DSL |
| Single scheduling thread | Avoids lock contention on the step queue; executor calls are non-blocking |
| Local executor uses fork/exec + cgroup v2 | Precise CPU affinity and memory limits per step without containers |
| inotify for monitor files | Low-overhead, kernel-push notification instead of polling |
| FDCaptureThread + epoll | Single thread multiplexes stdout/stderr of all running processes |
| Archiver runs in a separate thread | `tar` call and HTTP publish do not block the scheduling loop |
| Content-addressed cache | Steps can skip recompilation by ID; MD5 verification is optional |
| State written to `tasksmanager.json` | Allows external tools (dashboard, scripts) to read state without hitting the API |
| Cancelled tasks archived separately | `<exportPath>/Canceled/` keeps annulées distinct from completed runs |

---

## Known Weaknesses and Areas for Improvement

### Archive creation — `popen("tar -czf …")`
The archiver builds a shell command string and executes it via `popen()`. This has two problems:
- **Fragility**: paths containing spaces or special characters will break the command without explicit quoting.
- **Security**: if any path comes from user-controlled input, the construction is a command-injection vector.
libarchive is already a dependency of the project (used for reading archives via `FileTGZ`), so migrating archive creation to `archive_write_*` would be straightforward and would fix both issues.

### No Crash Recovery
`TasksManager::LoadStatus()` and the reload path in `Schedule` are present but **deliberately disabled** (commented out). A server restart loses all in-flight task state. Implementing the reload path properly (including group-based retry logic) would allow hot restarts.

### Scheduling Loop Holds Lock for Full Iteration
`ScheduleLoop()` holds `lockThread_` for the entire body of each iteration. Any HTTP call that needs the lock (e.g. `AddTask`) blocks for the full duration of step-dispatch + file I/O. Splitting the critical section would improve responsiveness under load.

### Timestamp-based Task IDs with Sleep
`TasksManager::CreateTask()` uses the current millisecond timestamp as the task ID and sleeps 100 ms to avoid collisions. This is fragile under load (two submissions within 100 ms would still collide) and introduces latency. A proper atomic counter would be more robust.

### No Authentication or Authorization
The REST API has no authentication mechanism. Any process with network access can submit tasks, cancel jobs, or read output. Adding at minimum a shared-secret header check or mTLS would be advisable for any non-local deployment.

### `WaitForCompletion()` Uses Busy-Wait
`Archiver::WaitForCompletion()` polls with `sleep_for(100ms)` instead of waiting on a condition variable. Fine for shutdown, but wasteful if called frequently.

### `FileRing` — dead code
`FileRing` (rotating file-based output buffer) is fully implemented but never instantiated. `MemoryRing` is the only buffer used. `FileRing` could either be removed, or wired in as a fallback when `logsSize_` is very large and heap pressure is a concern.

### Single Executor Backend
The `Executor` abstraction was designed for multiple backends, but only `Local` exists. Remote execution (SSH, container, cluster) would require implementing the full interface and wiring it into the config.

### Cache ID Character Set Restriction
Cache IDs are restricted to `[a-zA-Z0-9_-]` by the HTTP routing regex. IDs derived from hashes or paths with other characters (`.`, `/`) are silently rejected with a 404 instead of a proper error.
