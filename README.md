# puffin-bench

A suite of three C++ services for orchestrating, storing, and visualizing [tlspuffin](https://github.com/tlspuffin/tlspuffin) fuzzing campaigns.

## Architecture

```
┌──────────────────────┐   submit job    ┌─────────────────────┐
│                      │ ──────────────► │  Scheduler  :8080   │
│                      │                 └──────────┬──────────┘
│                      │                            │ fork/exec + cgroup v2
│                      │                 ┌──────────▼──────────┐
│   Browser / curl     │                 │  Nix shell + cargo  │
│                      │                 │  tlspuffin binary   │
│                      │                 └──────────┬──────────┘
│                      │                            │ POST /api/notify
│                      │  browse results ┌──────────▼──────────┐
│                      │ ◄─────────────► │  Publisher  :8081   │
│                      │                 └─────────────────────┘
│                      │  commit history ┌─────────────────────┐
│                      │ ◄─────────────► │  Git REST API :10083│
└──────────────────────┘                 └─────────────────────┘
```

| Service | Source | Default port | Binaries |
|---------|--------|-------------|---------|
| **Scheduler** | [`scheduler/`](scheduler/) | 8080 | `srv`, `srv-static` |
| **Git REST API** | [`git_restapi/`](git_restapi/) | 10083 | `git_restapi`, `git_restapi-static` |
| **Publisher** | [`publisher/`](publisher/) | 8081 | `publisher`, `publisher-static` |

Prefer the `-static` variants for deployment (no shared-lib dependencies).

---

## Prerequisites

| Tool | Notes |
|------|-------|
| CMake ≥ 3.21 | required by `CMakeExternal.cmake` |
| GCC or Clang (C++17) | |
| Git | fetches dependencies at configure time |
| OpenSSL dev headers | `libssl-dev` on Debian/Ubuntu |
| `xxd` | embeds binaries and scripts into the executable (`vim-common` package) |
| **Nix** | required at runtime by the job scripts |
| `git`, `jq` on `PATH` | required at runtime by the Git REST API |

```bash
sudo apt install cmake git g++ libssl-dev xxd   # Debian/Ubuntu
```

All other C++ dependencies are fetched from upstream git and compiled automatically on first configure — nothing else to install.

---

## Build

### Build

Building from the root fetches and compiles shared dependencies only once.

```bash
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j$(nproc)
```

Binaries are written to:

```
build/scheduler/srv               build/scheduler/srv-static
build/git_restapi/git_restapi     build/git_restapi/git_restapi-static
build/publisher/publisher         build/publisher/publisher-static
```

- **`third-party/`** — fetched and compiled dependencies (Poco, RapidJSON, libarchive, zlib, ZStd)
- **`embeded/`** — generated C headers that embed scripts and web assets into the binaries

### CMake options

All three sub-projects expose the same OpenSSL options:

| Option | Default | Description |
|--------|---------|-------------|
| `OPENSSL_SEARCH_ROOT` | `/usr/lib` | Directory containing `libssl` and `libcrypto` |
| `OPENSSL_SEARCH_ROOT_INCLUDE` | `/usr/include` | Directory containing `openssl/ssl.h` |
| `OPENSSL_MODE` | `STATIC` | `STATIC` or `SHARED` |

Example for a non-standard OpenSSL location:

```bash
cmake -B build -DCMAKE_BUILD_TYPE=Release \
  -DOPENSSL_SEARCH_ROOT=/usr/lib/x86_64-linux-gnu \
  -DOPENSSL_SEARCH_ROOT_INCLUDE=/usr/include
```

---

## Configuration

Each service reads a JSON config file. If the file is absent at startup, a default is written to disk and the process exits — edit it, then restart. Sample files are in each project's `samples/` directory.

### Scheduler (`config.json`)

Essential fields:

| Key | Description |
|-----|-------------|
| `server.port` | HTTP port (default `8080`) |
| `server.html` | Directory where board files are extracted (default `"html"`) |
| `schedule.runPath` | Working directories for live tasks |
| `schedule.exportPath` | Destination for completed task archives |
| `schedule.userPath` | Directory for uploaded input files |
| `schedule.toolsPath` | Read-only tools directory injected into all steps |
| `schedule.executors.local.nbCores` | CPU cores available for job steps |
| `schedule.executors.local.scriptPath` | Directory containing `executor.sh` and `functions.sh` |
| `schedule.publishers.<name>.server` | URL of the publisher to notify on task completion |
| `schedule.publishers.<name>.storage` | Root path prepended to the per-job destination sent to the publisher |

> **Scheduler ↔ Publisher path contract**: when a job completes, the scheduler resolves the per-job `storage` template from the flow JSON (e.g. `"${PROJECT}/${JOB_TYPE}/${COMMIT_ID}/"`) and prepends `publishers.<name>.storage` to produce the final destination path. That path is sent to the publisher as `dst`. The publisher strips its own `storagePath` prefix and uses the **first remaining path segment as the project name**. If `dst` does not fall under `storagePath`, the notification is rejected.
>
> The simplest setup (both services on the same machine): set `publishers.<name>.storage` to the **same absolute path** as the publisher's `storagePath`. The scheduler deposits the files there, then notifies the publisher which processes them in place.
>
> **Project name**: the first path segment after `storagePath` is the publisher project name. It must match the repository name declared in the Git REST API config (`git.repositories.<name>`) — the dashboard uses that name to query commit history.

Minimal example:

```json
{
  "server": { "port": 8080, "html": "html" },
  "schedule": {
    "runPath": "run", "exportPath": "export",
    "userPath": "users", "toolsPath": "tools",
    "publishers": {
      "results": {
        "server":  "http://publisher-host:8081",
        "storage": "/var/lib/publisher/data"
      }
    },
    "executors": {
      "local": { "type": 1, "nbCores": 4, "excludeCores": [0], "scriptPath": "scripts" }
    }
  },
  "cache": { "storagePath": "cache" }
}
```

Full reference: [scheduler/docs/configuration.md](scheduler/docs/configuration.md)

### Git REST API (`git_restapi-config.json`)

Essential fields:

| Key | Description |
|-----|-------------|
| `server.port` | HTTP port (default `10083`) |
| `git.storage` | Directory where repositories are cloned |
| `git.repositories.<name>.url` | Git remote URL of the repository to expose |

Minimal example:

```json
{
  "server": { "port": 10083 },
  "git": {
    "storage": "/var/lib/git_restapi",
    "repositories": {
      "tlspuffin": { "url": "https://github.com/tlspuffin/tlspuffin.git" }
    }
  }
}
```

Full reference: [git_restapi/docs/configuration.md](git_restapi/docs/configuration.md)

### Publisher (`publisher_config.json`)

Essential fields:

| Key | Description |
|-----|-------------|
| `server.port` | HTTP port (default `8081`) |
| `publisher.storagePath` | Root directory for project subdirectories and archives |
| `publisher.htmlPath` | Directory where dashboard web files are extracted at startup |

Minimal example:

```json
{
  "server": { "port": 8081 },
  "publisher": {
    "storagePath": "/var/lib/publisher/data",
    "htmlPath": "/var/lib/publisher/html"
  }
}
```

Full reference: [publisher/docs/configuration.md](publisher/docs/configuration.md)

### Publisher projects

A project is a directory inside `storagePath` containing a `.rules` file. Create one manually before sending the first archive:

```
storagePath/
└── tlspuffin/          ← project name (must match git.repositories.<name> in Git REST API)
    └── .rules
```

The `.rules` file maps archive path patterns (regex) to processing actions:

```json
{
  "index": "summary_PR.html",
  "Vulnerabilities": {
    "action": "GenerateReportVuln3",
    "onFiles": "PR/[0-9a-fA-F]+/Vuln/[0-9]+\\.zip"
  },
  "Performance": {
    "action": "GenerateReportPerfFromSummary",
    "onFiles": "PR/[0-9a-fA-F]+/Perf/[0-9]+\\.zip"
  }
}
```

| Field | Description |
|-------|-------------|
| `index` | HTML file (relative to `htmlPath/publisher/`) served when browsing the project root |
| `{RuleName}.action` | `GenerateReportVuln3`, `GenerateReportPerfFromSummary`, or `NULL` (ignore) |
| `{RuleName}.onFiles` | Regex matched against the archive path relative to the project directory |

The first matching rule is applied. Full reference: [publisher/docs/user_guide.md](publisher/docs/user_guide.md)

---

## Start

Each binary embeds its web assets and shell scripts, extracted automatically on first start.

```bash
./build/scheduler/srv-static        config.json
./build/git_restapi/git_restapi-static  git_restapi-config.json
./build/publisher/publisher-static  publisher_config.json
```

Use `--force-install` to re-extract embedded files after a binary update without stopping the service.

---

## Usage

Open the board dashboard:

```
http://<host>:8080/files/board/board.html
```

Click **+** to submit a job: select a job type, pick a commit from the Git REST API, launch. The board streams live stdout/stderr per step.

Browse published results:

```
http://<host>:8081/files/tlspuffin
```

Submit a job via curl:

```bash
curl -X POST http://localhost:8080/api/task/new \
  -F "name=Perf - main" \
  -F "config=@scheduler/html/jobs_scripts/PR_perf_cargo.json" \
  -F "script=@scheduler/html/jobs_scripts/PR_perf_full.sh" \
  -F "args[COMMIT_ID]=main" \
  -F "user=alice" \
  -F "job_type=perf"
```

---

## Documentation

| Topic | Document |
|-------|----------|
| Scheduler — API | [scheduler/docs/api.md](scheduler/docs/api.md) |
| Scheduler — Architecture | [scheduler/docs/architecture.md](scheduler/docs/architecture.md) |
| Scheduler — Configuration | [scheduler/docs/configuration.md](scheduler/docs/configuration.md) |
| Scheduler — Build | [scheduler/docs/build.md](scheduler/docs/build.md) |
| Scheduler — Task & step lifecycle | [scheduler/docs/task-step-lifecycle.md](scheduler/docs/task-step-lifecycle.md) |
| Scheduler — Executor | [scheduler/docs/executor.md](scheduler/docs/executor.md) |
| Scheduler — Step script reference | [scheduler/docs/step-script-reference.md](scheduler/docs/step-script-reference.md) |
| Git REST API — API | [git_restapi/docs/api.md](git_restapi/docs/api.md) |
| Git REST API — Configuration | [git_restapi/docs/configuration.md](git_restapi/docs/configuration.md) |
| Git REST API — Architecture | [git_restapi/docs/architecture.md](git_restapi/docs/architecture.md) |
| Publisher — User guide | [publisher/docs/user_guide.md](publisher/docs/user_guide.md) |
| Publisher — API | [publisher/docs/api.md](publisher/docs/api.md) |
| Publisher — Configuration | [publisher/docs/configuration.md](publisher/docs/configuration.md) |
| Publisher — Architecture | [publisher/docs/architecture.md](publisher/docs/architecture.md) |
| Third-party notices | [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) |
