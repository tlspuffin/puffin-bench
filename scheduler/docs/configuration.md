# Scheduler — Configuration Reference

## Config File

Default filename: `config.json` (overridable via the first positional command-line argument).

If the file does not exist at startup, a default configuration is written to disk and the process exits. Edit the file, then restart.

A runtime snapshot of the fully-resolved configuration is saved as `<configfile>.run` on each startup. This file reflects the exact parameters in use — including any `--logslevel` override — and is useful for diagnostics.

## Command-Line Arguments

| Argument | Description |
|---|---|
| `<config-file>` | Path to the JSON config file. Default: `config.json`. |
| `--install` | Install embedded board files to `html/board/`, then exit (do not start server). |
| `--force-install` | Force-overwrite embedded board files, then continue normal startup. |
| `--logslevel <N>` | Override the log level bitmask at runtime (see `logs_level` below). |

## Top-Level Keys

```json
{
  "logs_level": 15,
  "server": { ... },
  "schedule": { ... },
  "cache": { ... }
}
```

| Key | Type | Default | Description |
|---|---|---|---|
| `logs_level` | uint | `15` | Bitmask: `1`=error, `2`=warn, `4`=info, `8`=debug. `15` enables all levels. |

---

## `server` Section

```json
"server": {
  "port": 8080,
  "secure": false,
  "key":  "security/site.key",
  "cert": "security/site.pem",
  "CA":   "security/CA.pem",
  "html": "html"
}
```

| Key | Type | Default (plain) | Default (TLS) | Description |
|---|---|---|---|---|
| `port` | uint16 | `8080` | `8443` | TCP port to listen on. |
| `secure` | bool | `false` | — | Enable TLS. When `true`, `key`, `cert`, and `CA` are required. |
| `key` | path | `security/site.key` | same | Server private key (PEM). Required when `secure: true`. |
| `cert` | path | `security/site.pem` | same | Server certificate (PEM). Required when `secure: true`. |
| `CA` | path | `security/CA.pem` | same | CA bundle (PEM). Required when `secure: true`. |
| `html` | path | `html` | same | Root directory for static file serving (`GET /files/*`). Board files are installed under `<html>/board/`. |

TLS uses `VERIFY_NONE` (client certificate verification is disabled).

---

## `schedule` Section

```json
"schedule": {
  "runPath":      "run",
  "exportPath":   "export",
  "userPath":     "users",
  "toolsPath":    "tools",
  "loopSleepMs":  100,
  "publishers": {
    "results-server": {
      "server":  "https://publisher.example.com",
      "storage": "/results/${JOB_TYPE}/${COMMIT_ID}/"
    }
  },
  "executors": {
    "local": {
      "type":         1,
      "nbCores":      4,
      "excludeCores": [0],
      "scriptPath":   "scripts",
      "logsSize":     10485760
    }
  }
}
```

### Paths

| Key | Type | Description |
|---|---|---|
| `runPath` | path | Root for live task working directories (`<runPath>/<taskID>/`). |
| `exportPath` | path | Destination for completed task archives and `tasksmanager.json`. |
| `userPath` | path | Directory for uploaded input files (`<userPath>/<taskID>/script.sh`, etc.). |
| `toolsPath` | path | Shared read-only tools directory injected into all steps as `THEJOB_TOOLS_PATH`. |

### Scheduling

| Key | Type | Default | Description |
|---|---|---|---|
| `loopSleepMs` | uint | `100` | Milliseconds to sleep between scheduling loop iterations. |

### `publishers` subsection

Named publisher targets referenced by `publish.publisher` in flow JSON files.

```json
"publishers": {
  "<name>": {
    "server":  "<URL>",
    "storage": "<path-template>"
  }
}
```

| Key | Type | Description |
|---|---|---|
| `server` | URL | HTTP(S) URL of the remote publish server (e.g. `restsrv.publisher`). |
| `storage` | path template | Local or remote destination path. Supports `${VAR}` variable substitution (e.g. `${JOB_TYPE}`, `${COMMIT_ID}`). |

### `executors` subsection — Local executor

```json
"executors": {
  "local": {
    "type":         1,
    "nbCores":      4,
    "excludeCores": [0],
    "scriptPath":   "scripts",
    "logsSize":     10485760
  }
}
```

| Key | Type | Default | Description |
|---|---|---|---|
| `type` | uint | `1` | Executor type. Currently only `1` (Local) is supported. |
| `nbCores` | uint | all available | Maximum number of CPU cores available for assignment. |
| `excludeCores` | array | `[0]` | Core indices to never assign (keep core 0 for the OS). |
| `scriptPath` | path | — | Directory containing `executor.sh` and `functions.sh`. |
| `logsSize` | uint | `10485760` | Per-step in-memory output ring buffer size in bytes (default: 10 MB). |

---

## `cache` Section

```json
"cache": {
  "storagePath": "cache",
  "mappingFile": "cache-mapping.json"
}
```

| Key | Type | Default | Description |
|---|---|---|---|
| `storagePath` | path | `"cache"` | Directory where cached files are stored (one file per cache ID). |
| `mappingFile` | filename | `"cache.json"` | JSON file inside `storagePath` mapping IDs to file paths and MD5 hashes. Rebuilt at startup. |

---

## HTML/JavaScript Configuration

The web dashboard (`html/board/`) has its own configuration files that are separate from the main server config:

### Job Launcher Configuration

**File**: `html/board/launchers/tlspuffin/jobsconfig.json`

Defines available job types in the launcher UI:
```json
{
  "jobs": [
    {
      "value":    "vuln-a",
      "label":    "Vuln group A",
      "job_type": "vuln-a", 
      "color":    "#FF9800",
      "campaign": false,
      "config":   "/files/jobsscripts/tlspuffin/PR_vulnerabilities-groupA_cargo.json",
      "script":   "/files/jobsscripts/tlspuffin/PR_vulnerabilities_full.sh",
      "files":    ["/files/jobsscripts/tlspuffin/shell.nix", "..."]
    }
  ]
}
```

| Field | Description |
|-------|-------------|
| `config` | Flow JSON file path (served via `/files/jobsscripts/`) |
| `script` | Step script path (served via `/files/jobsscripts/`) |  
| `files` | Additional files to attach (patches, configs, etc.) |
| `campaign` | Enable campaign-specific UI fields (timeout, vendor, features) |

### Git History Configuration

**File**: `html/board/launchers/tlspuffin/git.json` (fallback)

Provides commit history when external git service unavailable:
```json
{
  "commits": [
    { "id": "abc1234", "date": "2026-04-17", "comment": "fix: something", "branch": "main" }
  ],
  "PR": [
    { "id": "def5678", "date": "2026-04-16", "comment": "feat: new feature", "branch": "pr/42" }
  ]
}
```

### Installation

- Job configs embedded in launcher JavaScript at build time
- Server installs HTML files to `<server.html>/board/` on startup
- Scripts installed to `<server.html>/jobs_scripts/` and served via `/files/jobsscripts/`

**See [board-job-launcher.md](board-job-launcher.md) for detailed configuration reference.**

---

## Example: Minimal Configuration

```json
{
  "logs_level": 7,
  "server": {
    "port": 8080,
    "html": "html"
  },
  "schedule": {
    "runPath":    "/var/lib/scheduler/run",
    "exportPath": "/var/lib/scheduler/export",
    "userPath":   "/var/lib/scheduler/users",
    "toolsPath":  "/var/lib/scheduler/tools",
    "executors": {
      "local": {
        "type": 1,
        "nbCores": 8,
        "excludeCores": [0],
        "scriptPath": "/var/lib/scheduler/scripts"
      }
    }
  },
  "cache": {
    "storagePath": "/var/lib/scheduler/cache"
  }
}
```

## Example: With Publisher

```json
{
  "logs_level": 7,
  "server": { "port": 8080, "html": "html" },
  "schedule": {
    "runPath":    "run",
    "exportPath": "export",
    "userPath":   "users",
    "toolsPath":  "tools",
    "publishers": {
      "results": {
        "server":  "http://publisher.internal:8081",
        "storage": "results/${JOB_TYPE}/${COMMIT_ID}/"
      }
    },
    "executors": {
      "local": {
        "type": 1, "nbCores": 16, "excludeCores": [0],
        "scriptPath": "scripts", "logsSize": 20971520
      }
    }
  },
  "cache": { "storagePath": "cache" }
}
```
