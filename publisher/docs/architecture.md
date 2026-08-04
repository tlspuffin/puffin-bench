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
          Web interface (external — served from htmlPath)
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

Rules are defined in `.rules` JSON files placed in the project directory or its subdirectories. Each rule associates a regex pattern (`onFiles`) with an action (`action`). Rules with the `GenerateMergeJSON` action accept additional `parameters`.

```json
{
  "index": "summary.html",
  "Perf": {
    "onFiles": "PR/[0-9a-fA-F]+/Perf/[0-9]+\\.zip",
    "action": "GenerateMergeJSON",
    "parameters": {
      "src": "./artefacts/summary.json",
      "dst": "Perf/${FILE_RELATIVE_PATH_1}.json",
      "keep": ["type", "commit_id"],
      "merge": ["libraries"],
      "strategy": { "comparator": ">=", "field": "timestamp" },
      "generate_ZST": true
    }
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
| `action` | yes | `GenerateMergeJSON` or `NULL` |
| `onFiles` | yes | Regex on the archive path (relative to the `.rules` directory) |
| `parameters` | required for `GenerateMergeJSON` | Rule-specific parameters (see below) |

`GenerateMergeJSON` parameters:

| Parameter | Required | Description |
|-----------|----------|-------------|
| `src` | yes | Path of the JSON file to extract from the archive (template variables supported) |
| `dst` | yes | Output path relative to `.project/` (template variables supported). **This determines the merge granularity**: archives that resolve to the same `dst` are merged into a single JSON; archives that resolve to different `dst` values each produce an independent JSON. |
| `keep` | no | Array of field names that must be present in `src`; if `dst` already exists, their values must match what is stored there (consistency check) |
| `merge` | yes | Array of object keys to merge across files. The **first key** is the primary merge key: only entries updated under this key are tracked in the index (used by `HaveIndexed` to skip already-processed archives). |
| `strategy` | yes | Object with `comparator` (`>`, `>=`, `<`, `<=`, `==`, `!=`) and `field` (uint64 field in `src` JSON used to select the winning entry when merging). Guarantees a consistent result regardless of archive processing order. |
| `generate_ZST` | no | Boolean; if `true`, generates a seekable `.tar.zst` performance archive alongside the source archive by extracting stats JSON files, converting them to binary time series, and compressing the result; not regenerated during cache regeneration |
| `campaign` | no | Boolean; marks this rule as a campaign rule, enabling `GET /api/project/{name}/campaigns` |

Template variables available in `src` and `dst`:

| Variable | Value |
|----------|-------|
| `${FILE_RELATIVE_PATH_N}` | N-th path element of the archive path, relative to the rule's directory (0-based) |
| `${FILENAME}` | Archive filename stem (without extension) |

#### `Rule` (base class)
Associates a regex pattern with processing logic. Key methods:
- `Match(file)` — tests whether the rule applies (checks both path prefix and regex)
- `Apply()` — processes the archive, generates JSON, updates the index

Concrete subclasses:
| Class | `action` value | Role |
|-------|---------------|------|
| `RuleMergeJSON` | `GenerateMergeJSON` | Generic JSON merge rule; extracts a JSON file from an archive and merges it into a persistent output file using a configurable strategy |
| `RuleNULL` | `NULL` | No-op (silently ignores matching files) |

Dead code in `Rule` base class (defined but never called):
- `ExtractExperimentsFromFile/Buffer()` — parses task JSON metadata
- `MergeResults()` — merges multiple result documents into a single JSON document
- `UpdateJSON()` / `ValidateUpdatedJSON()` — atomic update via `.tmp` file + rename

#### `Index`
Persists processed state in `.project/.index.json`. Structure:
```json
{
  "{outputFile}": {
    "{timestamp}": {
      "file": "path/source.zip",
      "libs": ["lib1", "lib2"]
    }
  }
}
```
Methods: `HaveIndexed()`, `Add()`, `Load()`, `Save()`, `Remove()`, `Delete()`, `List()`.

`ScanStorage()` (periodic scan) skips a file if `HaveIndexed()` returns true (already indexed **and** output JSON present on disk) or if it is in `filesInError_`. `ScanFiles()` (`POST /api/notify` path) checks neither the index nor `filesInError_` — notified files are always reprocessed, allowing a forced retry via notify even after a failure.

`filesInError_` is an in-memory set and is **not persisted** across server restarts. A file that failed during a session will be retried automatically on the next startup scan.

`ScanStorage()` applies only the **first** matching rule for each file and stops; `ScanFiles()` applies **all** matching rules for each file. In practice this makes no difference if `onFiles` patterns are designed to be mutually exclusive, which is the recommended approach.

---

## Data flow

```
POST /api/notify  {src: "1234.zip", dst: "project/PR/abc1234/Perf"}
        │
        ▼
  Publish::NotifyFiles()  →  queue SNotifyFiles
        │
        ▼  (background thread)
  Project::ScanFiles()
        │
        ├── Rule::Match()  →  all matching rules applied
        │
        ▼
  RuleMergeJSON::Apply()
        ├── FileCompressed::ExtractFileData("artefacts/summary.json")
        ├── Parse JSON  (RapidJSON)
        ├── For each merge key: compare strategy.field vs stored merge_field
        │     → only update entries where comparator holds
        │     → result is identical regardless of archive processing order
        ├── Merge selected keys into output JSON
        ├── Atomic write via .tmp + rename
        └── Index::Add()  →  transfer lib ownership to latest timestamp
        │
        ▼
  storage/project/.project/{outputFile}.json
        (merged result of all archives resolving to the same dst)

        │  GET /api/project/{name}/data
        ▼
  {"success": true, "files": ["...json"]}
```

---

## Multithreading and security

- `Publish` runs in a dedicated thread. The queue is protected by `std::mutex` + `std::condition_variable`.
- Project list reads: `std::shared_mutex` (shared reads, exclusive writes).
- JSON updates are atomic: write to `.tmp`, then `rename()`.
- Path traversal protection: `std::filesystem::canonical()` verifies that the resolved path stays within the allowed directory.
- Files in error are stored in `filesInError_` and ignored by the periodic scan (`ScanStorage()`). A retry is possible via `POST /api/notify` since `ScanFiles()` ignores `filesInError_`.
