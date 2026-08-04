# puffin-bench

A suite of four C++ services — plus a bootstrapper that deploys all of them — for orchestrating, storing, visualizing, and comparing [tlspuffin](https://github.com/tlspuffin/tlspuffin) fuzzing campaigns.

## Architecture

```
┌──────────────────────┐   submit job    ┌─────────────────────┐
│                      │ ──────────────► │  Scheduler  :10082  │
│                      │                 └──────────┬──────────┘
│                      │                            │ fork/exec + cgroup v2
│                      │                 ┌──────────▼──────────┐
│   Browser / curl     │                 │  Nix shell + cargo  │
│                      │                 │  tlspuffin binary   │
│                      │                 └──────────┬──────────┘
│                      │                            │ POST /api/notify
│                      │  browse results ┌──────────▼──────────┐
│                      │ ◄─────────────► │  Publisher  :10083  │
│                      │                 └──────────┬──────────┘
│                      │  commit history ┌──────────▼──────────┐
│                      │ ◄─────────────► │  Git REST API :10081│◄────┐
│                      │                 └─────────────────────┘     │ history
│                      │  compare runs   ┌─────────────────────┐     │
│                      │ ◄─────────────► │  vis_comparator      │────┘
└──────────────────────┘                 │  :10084 (reads Publisher's storage)
                                          └─────────────────────┘
```

| Service | Source | Default port | Binaries |
|---------|--------|-------------|---------|
| **Scheduler** | [`scheduler/`](scheduler/) | 10082 | `scheduler`, `scheduler-static` |
| **Git REST API** | [`git_restapi/`](git_restapi/) | 10081 | `git_restapi`, `git_restapi-static` |
| **Publisher** | [`publisher/`](publisher/) | 10083 | `publisher`, `publisher-static` |
| **vis_comparator** | [`vis_comparator/`](vis_comparator/) | 10084 | `vis_comparator`, `vis_comparator-static` |

Prefer the `-static` variants for deployment (no shared-lib dependencies). A fifth project, [`installer/`](installer/) (see [installer/README.md](installer/README.md)), embeds copies of the four binaries above — dynamically-linked in `installer`, statically-linked in `installer-static` — plus every asset they need, and bootstraps a co-located deployment with a single command. The manual build/configure/start steps below are the standalone path for running (or developing) one service at a time.

---

## Prerequisites

| Tool | Notes |
|------|-------|
| CMake ≥ 3.21 | required by `CMakeExternal.cmake` |
| GCC or Clang (C++17) | |
| Git | fetches dependencies at configure time |
| OpenSSL dev headers | `libssl-dev` on Debian/Ubuntu |
| `xxd` | scheduler/git_restapi/publisher/vis_comparator embed their scripts and web assets with it (`vim-common` package) |
| An assembler | `installer` embeds the four static binaries via `.incbin` (`enable_language(ASM)`) instead of `xxd` — needed because building from the root always includes `installer` |
| `zip` CLI | `installer` shells out to it to archive whole directory trees before embedding them |
| **Nix** | required at runtime by the job scripts |
| `git`, `jq` on `PATH` | required at runtime by the Git REST API |

```bash
sudo apt install cmake git g++ libssl-dev xxd zip   # Debian/Ubuntu — a C/C++ toolchain normally ships an assembler already
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
build/scheduler/scheduler             build/scheduler/scheduler-static
build/git_restapi/git_restapi         build/git_restapi/git_restapi-static
build/publisher/publisher             build/publisher/publisher-static
build/vis_comparator/vis_comparator   build/vis_comparator/vis_comparator-static
build/installer/installer             build/installer/installer-static
```

The `installer` binaries are a bootstrapper, not a fifth standalone service — see [installer/README.md](installer/README.md) if you just want a working deployment without following the manual steps below.

- **`third-party/`** — fetched and compiled dependencies (Poco, RapidJSON, libarchive, zlib, ZStd)
- **`embeded/`** — generated C headers that embed scripts and web assets into the binaries

### CMake options

Scheduler, git_restapi, publisher, and vis_comparator each expose the same OpenSSL options (`installer` links none of Poco/OpenSSL, so these don't apply to it):

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
| `server.port` | HTTP port (default `10082`) |
| `server.html` | Directory where board files are extracted (default `"html"`) |
| `schedule.runPath` | Working directories for live tasks |
| `schedule.exportPath` | Destination for completed task archives |
| `schedule.userPath` | Directory for uploaded input files |
| `schedule.toolsPath` | Read-only tools directory injected into all steps |
| `schedule.executors.local.nbCores` | CPU cores available for job steps |
| `schedule.executors.local.scriptPath` | Directory containing `executor.sh` and `functions.sh` |
| `schedule.publisher.<name>.base_url` | Base URL of the publisher to notify on task completion |
| `schedule.publisher.<name>.notify_endpoint` | Path appended to `base_url` for the notification POST (typically `/api/notify`) |
| `schedule.publisher.<name>.view_endpoint` | Path template appended to `base_url` to build the task's `publish_link`; supports `${PROJECT}`/`${TASK_ID}` substitution |
| `schedule.publisher.<name>.storage` | Root path prepended to the per-job destination sent to the publisher |

All four `publisher.<name>` fields above are required — a named publisher entry missing any of them throws at load time. `check_server_certificat` (bool, default `false`) is the one optional field, for validating the publisher's TLS certificate when `base_url` is `https://`.

> **Scheduler ↔ Publisher path contract**: when a job completes, the scheduler resolves the per-job `storage` template from the flow JSON (e.g. `"${PROJECT}/${JOB_TYPE}/${COMMIT_ID}/"`) and prepends `publisher.<name>.storage` to produce the final destination path. That path is sent to the publisher as `dst` on `notify_endpoint`. The publisher strips its own `storagePath` prefix and uses the **first remaining path segment as the project name**. If `dst` does not fall under `storagePath`, the notification is rejected.
>
> The simplest setup (both services on the same machine): set `publisher.<name>.storage` to the **same absolute path** as the publisher's `storagePath`. The scheduler deposits the files there, then notifies the publisher which processes them in place.
>
> **Project name**: the first path segment after `storagePath` is the publisher project name. It must match the repository name declared in the Git REST API config (`git.repositories.<name>`) — the dashboard uses that name to query commit history.

Minimal example:

```json
{
  "server": { "port": 10082, "html": "html" },
  "schedule": {
    "runPath": "run", "exportPath": "export",
    "userPath": "users", "toolsPath": "tools",
    "publisher": {
      "results": {
        "base_url":        "http://publisher-host:10083",
        "notify_endpoint": "/api/notify",
        "view_endpoint":   "/files/${PROJECT}#${TASK_ID}",
        "storage":         "/var/lib/publisher/data"
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
| `server.port` | HTTP port (default `10081`) |
| `git.storage` | Directory where repositories are cloned |
| `git.repositories.<name>.url` | Git remote URL of the repository to expose |

Minimal example:

```json
{
  "server": { "port": 10081 },
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
| `server.port` | HTTP port (default `10083`) |
| `publisher.storagePath` | Root directory for project subdirectories and archives |
| `publisher.htmlPath` | Directory holding the dashboard web files served under `/files/{project}` — externally deployed, the publisher itself never writes into it |

Minimal example:

```json
{
  "server": { "port": 10083 },
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

The `.rules` file maps archive path patterns (regex) to processing actions — the only real action is `GenerateMergeJSON` (extracts a JSON file from the archive and merges it into a persistent output under `.project/`); `NULL` silently ignores matching files:

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

| Field | Description |
|-------|-------------|
| `index` | HTML file (relative to `htmlPath/publisher/`) served when browsing the project root |
| `{RuleName}.action` | `GenerateMergeJSON` or `NULL` (ignore) |
| `{RuleName}.onFiles` | Regex matched against the archive path relative to the `.rules` directory |
| `{RuleName}.parameters.*` | Required for `GenerateMergeJSON` — see full reference below for `src`/`dst`/`keep`/`merge`/`strategy`/`generate_ZST`/`campaign` |

The first matching rule is applied. Full reference: [publisher/docs/user_guide.md](publisher/docs/user_guide.md)

### vis_comparator (`vis_comparator-config.json`)

Reads the publisher's storage tree directly (one subfolder per project, e.g. `<data>/tlspuffin/`) to let a human overlay and compare metrics across commits/campaigns, and proxies the Git REST API for commit metadata. No `docs/` directory ships for this project yet — the fields below come straight from its config-loading code.

Essential fields:

| Key | Description |
|-----|-------------|
| `server.port` | HTTP port (default `8080` standalone; the installer sets `10084`) |
| `server.html` | Root directory for the embedded web assets, installed under `<html>/vis_comparator/` |
| `server.userdata` | Root for saved comparison views and shared templates |
| `server.git_history_url` | Base URL of a Git REST API instance to proxy for commit history (must be `http://` or `https://`) |
| `data.data` | Base path holding one subfolder per project — point this at the publisher's `storagePath` |

Minimal example:

```json
{
  "server": {
    "secure": false,
    "port": 10084,
    "html": "/var/lib/vis_comparator/html",
    "userdata": "/var/lib/vis_comparator/users_data",
    "git_history_url": "http://git-restapi-host:10081"
  },
  "data": { "data": "/var/lib/publisher/data" }
}
```

Open the comparison UI at `http://<host>:10084/files/<project>/index.html` (e.g. `.../files/tlspuffin/index.html`). The publisher's tlspuffin dashboard deep-links into it per commit/library, e.g. `?template=TwoTasksTemplate_2C1S&c1=<commit>&c2=@dev-base&c2.alias=Dev&s1=Perf%3A<library>`.

---

## Start

Each binary embeds its web assets and shell scripts, extracted automatically on first start.

```bash
./build/scheduler/scheduler-static  config.json
./build/git_restapi/git_restapi-static  git_restapi-config.json
./build/publisher/publisher-static  publisher_config.json
./build/vis_comparator/vis_comparator-static  vis_comparator-config.json
```

Use `--force-install` to re-extract embedded files after a binary update without stopping the service.

---

## Usage

Open the board dashboard:

```
http://<host>:10082/files/board/board.html
```

Click **+** to submit a job: select a job type, pick a commit from the Git REST API, launch. The board streams live stdout/stderr per step.

Browse published results:

```
http://<host>:10083/files/tlspuffin
```

Compare runs in vis_comparator:

```
http://<host>:10084/files/tlspuffin/index.html
```

Submit a job via curl (paths below are the tlspuffin job scripts installed under `installer/data/html/jobsscripts/tlspuffin/` — see [installer/docs/tlspuffin-job-scripts.md](installer/docs/tlspuffin-job-scripts.md); `PR_perf_full.sh` only exists after a build, generated by `scripts/build.sh`):

```bash
SCRIPTS=installer/data/html/jobsscripts/tlspuffin

curl -X POST http://localhost:10082/api/task/new \
  -F "name=Perf - main" \
  -F "config=@${SCRIPTS}/PR_perf_cargo.json" \
  -F "script=@${SCRIPTS}/PR_perf_full.sh" \
  -F "files[]=@${SCRIPTS}/shell.nix" \
  -F "files[]=@${SCRIPTS}/wolfssl_put.c.patch" \
  -F "args[COMMIT_ID]=main" \
  -F "user=alice" \
  -F "job_type=perf"
```

Response: `{"success":true,"task_id":"<id>"}`. See [scheduler/docs/api.md](scheduler/docs/api.md) for reading step output, cancelling a task/step, and downloading a task's artefact archive (`GET /api/task/<id>/artefacts`).

---

## Documentation

| Topic | Document |
|-------|----------|
| tlspuffin — User guide | [tlspuffin_user_guide.md](tlspuffin_user_guide.md) |
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
| Installer — Architecture | [installer/docs/architecture.md](installer/docs/architecture.md) |
| Installer — Components | [installer/docs/components.md](installer/docs/components.md) |
| Installer — Configuration | [installer/docs/configuration.md](installer/docs/configuration.md) |
| Installer — Build | [installer/docs/build.md](installer/docs/build.md) |
| Installer — tlspuffin job scripts | [installer/docs/tlspuffin-job-scripts.md](installer/docs/tlspuffin-job-scripts.md) |
| Installer — Web assets | [installer/docs/web-assets.md](installer/docs/web-assets.md) |
| Third-party notices | [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) |
