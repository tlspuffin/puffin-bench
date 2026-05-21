# Scheduler — Architecture

## Purpose

The scheduler is a C++ HTTP server that accepts task submissions via REST API, orchestrates multi-step workflow execution on local CPU cores, monitors progress in real time, archives results, and optionally publishes them to a remote server.

It is built on top of the Poco C++ libraries (HTTP server), RapidJSON (config/state serialization), libarchive (reading and writing archives), and Linux-specific APIs (inotify, cgroup v2, `/proc`). libarchive is used for both **writing** (`.zip` archives via `archive_write_*`) and **reading** (extracting log files via `FileCompressed`; also supports legacy `.tgz` archives for backward compatibility).

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
           │  │  (zip)  │ │    │  Tasks       │   │  core assignment │
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

Reading notes:
- `Monitor` and `Archiver` are **members** of `Schedule`, not independent services.
- `Linux` is **owned** by `APIS` and passed by **reference** to `Schedule` and `Local` — both use it concurrently.
- `Publish` is a configuration object carried by `Task`, copied passively into `ArchiveJob`; it has no independent lifecycle.

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

## Request Lifecycle

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

The board files (`board.html`, `board.js`, `taskcard.js`, `joblauncher.js`, `terminal.js`, CSS files) are embedded in the server binary at build time as C string literals via `EmbedTextFileScript` (`CMakeTextEmbedding.cmake`). On startup, `Server::Config::Validate()` extracts them to `<html_>/board/` if they are absent or if `--force-install` was passed.

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

See `docs/board-job-launcher.md` for the full `jobs_config.json` format, campaign parameters, and how to add new job types.

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
  <taskID>.zip               completed task archive (success or failed steps)
  <taskID>.json              task metadata (post-archive)
  Canceled/
    <taskID>.zip             archive for cancelled tasks
    <taskID>.json            metadata for cancelled tasks

<userPath>/
  <taskID>/                  uploaded input files (script, configs, …)

<toolsPath>/                 shared tools injected into all steps
```

---

## External Dependencies

| Dependency | How Used |
|---|---|
| **Poco** (1.14.2) | HTTP server, TLS sockets, URI parsing, `ServerApplication` |
| **RapidJSON** (1.1.0) | All JSON parsing and serialization |
| **OpenSSL** | Transitively via Poco TLS |
| **libarchive** | Reading and writing archives (`FileCompressed`); writes `.zip`, reads `.zip` and `.tgz` (backward compatibility) |
| **zlib** | Compression support |
| **Linux inotify** | Real-time monitor file watching |
| **Linux cgroup v2** | Per-step CPU and memory isolation |

---

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Steps form a DAG | Enables parallel sub-tasks and explicit sequencing without a scripting DSL |
| Single scheduling thread | Avoids lock contention on the step queue; executor calls are non-blocking |
| Local executor uses fork/exec + cgroup v2 | Precise CPU affinity and memory limits per step without containers |
| inotify for monitor files | Low-overhead, kernel-push notification instead of polling |
| FDCaptureThread + epoll | Single thread multiplexes stdout/stderr of all running processes |
| Archiver runs in a separate thread | Archive creation and HTTP publish do not block the scheduling loop |
| Content-addressed cache | Steps can skip recompilation by ID; MD5 verification is optional |
| State written to `tasksmanager.json` | Allows external tools (dashboard, scripts) to read state without hitting the API |
| Cancelled tasks archived separately | `<exportPath>/Canceled/` keeps cancelled tasks distinct from completed runs |
