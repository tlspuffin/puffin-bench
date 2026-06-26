# Architecture — restsrv.publisher

## Overview

The publisher is a C++ REST server that receives experiment archives (`.zip`, `.tgz`) and runtime metadata files (`.json`), processes them through a rule engine, generates JSON result files and `.tar.zst` archives, and exposes them to a web interface.

```
Client / Scheduler
       │ POST /api/notify
       ▼
┌─────────────────────────────────────────────────────┐
│  HTTP Server (Poco)                                 │
│  RequestHandlerFactory  →  handlers per route       │
└────────────────────┬────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────┐
│  PublishAPI                                         │
│  └── Publish  (processing thread)                   │
│       └── Project[]                                 │
│            ├── Rule[]  (rule engine)                │
│            └── Index   (file cache / index)         │
└─────────────────────────────────────────────────────┘
                     │ JSON files
                     ▼
              storage/project/.project/
                     │
       GET /api/project/{name}/data
                     │
                     ▼
          Web interface (Plotly, JS modules)
```

---

## Components

### HTTP Server (`src/publisher/server/`)

- **`MyServerApp`** — `Poco::Util::ServerApplication` wrapper. Creates a `ServerSocket` (plain or SSL depending on config) and starts the `HTTPServer`.
- **`RequestHandlerFactory`** — routes by URI regex to handlers.
- **`RequestHandler`** subclasses — one handler per endpoint, created by the `REQUESTHANDLER` macro.
- **`PartsHandler`** — multipart/form-data parsing for `POST /api/notify`.

### Public API (`src/publisher/api/`)

- **`PublishAPI`** — facade exposed to handlers. Delegates to `Publish`. Also exposes the `Storage()` and `HTMLStorage()` paths.
- **`APIS`** — API container passed to the entire server layer.

### Publish engine (`src/publisher/publish/`)

#### `Publish`
Background processing thread. Receives `SNotifyFiles` via a queue, dispatches them to the corresponding projects. Wakes up on notification or periodically (`orphanScanInterval`).

#### `Project`
Represents a data directory for a given project. Holds:
- a list of `Rule` objects loaded from `.rules` files in the project directory (recursive scan)
- a persistent `Index` (`.project/.index.json`)
- the `ScanStorage()` and `ScanFiles()` methods for iterating archives

Rules are defined in `.rules` JSON files placed in the project directory or its subdirectories. Each rule associates a regex pattern (`onFiles`) with an action (`action`). The first rule whose pattern matches a file is applied.

```json
{
  "index": "summary_PR.html",
  "Vulnerabilities": {
    "action": "GenerateReportVuln3",
    "onFiles": "PR/[0-9a-f]+/Vuln/[0-9]+\\.zip",
    "parameters": { "folder": "subfolder" }
  },
  "Performance": {
    "action": "GenerateReportPerfFromSummary",
    "onFiles": "PR/[0-9a-f]+/Perf/[0-9]+\\.zip"
  }
}
```

The `index` field is a top-level field in the `.rules` file (not associated with a rule):

| Field | Required | Description |
|-------|----------|-------------|
| `index` | no | Path relative to `htmlPath/publisher/` of the HTML file served when accessing `GET /files/{project_name}` (or `GET /files/{project_name}/{subdirectory}` if the `.rules` is in a subdirectory) |

Rule fields:

| Field | Required | Description |
|-------|----------|-------------|
| `action` | yes | `GenerateReportVuln3`, `GenerateReportPerfFromSummary`, `GenerateReportCampaignFromSummary`, `NULL` |
| `onFiles` | yes | Regex on the archive path (relative to the `.rules` directory) |
| `parameters` | no | Rule-specific parameters |
| `parameters.folder` | no | Output subdirectory in `.project/` where the result JSON is written (default: `"Vuln"` for GenerateReportVuln3, `"Perf"` for GenerateReportPerfFromSummary) |
| `parameters.dataPath` | required for `GenerateReportCampaignFromSummary` | Path to the root directory containing campaign data folders; the file filter (`onFiles`) is automatically prefixed with the campaign folder structure |

#### `Rule` (base class)
Associates a regex pattern with processing logic. Key methods:
- `Match(file)` — tests whether the rule applies
- `Apply()` — processes the archive, generates JSON, updates the index

Concrete subclasses:
| Class | Role |
|-------|------|
| `RuleVuln3` | Vulnerability analysis (multi-task, aggregation per library) |
| `RulePerfUseSummary` | Performance metrics, `.tar.zst` generation |
| `RuleCampaignUseSummary` | Campaign metrics; aggregates per-campaign results; requires `dataPath` parameter |
| `RuleNULL` | No-op (default rule) |

Utilities in `Rule`:
- `ExtractExperimentsFromFile/Buffer()` — parses task JSON metadata
- `MergeResults()` — merges multiple results into a single JSON document
- `UpdateJSON()` / `UpdateTempJSON()` / `ValidateTempJSON()` — atomic update via `.tmp` file + rename

#### `Index`
Persists processed state in `.project/.index.json`. Structure:
```json
{
  "{commitID}": {
    "{timestamp}": {
      "file": "path/source.zip",
      "libs": ["lib1", "lib2"]
    }
  }
}
```
Methods: `HaveIndexed()`, `Add()`, `Load()`, `Save()`.

`ScanStorage()` (periodic scan) skips a file if `HaveIndexed()` returns true (already indexed **and** output JSON present on disk) or if it is in `filesInError_`. `ScanFiles()` (`POST /api/notify` path) checks neither the index nor `filesInError_` — notified files are always reprocessed, allowing a forced retry via notify even after a failure.

---

## Data flow

```
POST /api/notify  {src: "1234.zip", dst: "project"}
        │
        ▼
  Publish::NotifyFiles()  →  queue SNotifyFiles
        │
        ▼  (background thread)
  Project::ScanFiles()
        │
        ├── Rule::Match()  →  first matching rule
        │
        ▼
  Rule::Apply()
        ├── FileCompressed::ExtractFileData("run-summary.json")
        ├── Parse JSON  (RapidJSON)
        ├── Aggregation per library
        ├── MergeResults()  if result already exists
        ├── UpdateTempJSON()  →  atomic write
        └── Index::Add()  →  save .index.json
        │
        ▼
  storage/project/.project/{commitID}.json

        │  GET /api/project/{name}/data
        ▼
  {"success": true, "files": ["...json"]}
        │
        ▼  (browser)
  Load JSON  →  display summary_PR
```

---

## Embedded web files (EmbedTextFileScript)

The HTML/CSS/JS files from the `html/publisher/` directory are **embedded in the binary** at compile time via `CMakeTextEmbedding.cmake`. At startup, `Config::Validate()` installs them in `htmlPath/publisher/` according to two rules:

- **Application files**: written if absent, or unconditionally with `--force-install` — `summary_PR.html`, `.css`, `.js`, `summary_PR_metrics.js`, `summary_PR_graphoverview.js/css`, `summary_PR_graphmetrics.js/css`, `plotly-3.3.0.min.js`.
- **Configuration file**: written only if absent, **never overwritten** even with `--force-install` — `summary_PR_config.js`.

`summary_PR_config.js` contains the `config` object imported by `summary_PR.js` and defines the URLs of the three services the page contacts: the publisher server (this server), the git REST API (port 10083), and the scheduler/board (port 10081). It can be edited directly in `htmlPath/publisher/` without recompiling.

The binary is thus self-contained: `htmlPath` can be empty on first run.

---

## Multithreading and security

- `Publish` runs in a dedicated thread. The queue is protected by `std::mutex` + `std::condition_variable`.
- Project list reads: `std::shared_mutex` (shared reads, exclusive writes).
- JSON updates are atomic: write to `.tmp`, then `rename()`.
- Path traversal protection: `std::filesystem::canonical()` verifies that the resolved path stays within the allowed directory.
- Files in error are stored in `filesInError_` and ignored by the periodic scan (`ScanStorage()`). A retry is possible via `POST /api/notify` since `ScanFiles()` ignores `filesInError_`.
