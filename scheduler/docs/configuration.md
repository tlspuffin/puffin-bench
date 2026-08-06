# Scheduler — Configuration Reference

## Config File

Default filename: `config.json` (overridable via the first non-flag command-line argument).

Startup logic (`src/scheduler/main.cxx`):

- If the file **doesn't exist**, a default configuration is written to that path and the process exits with status `1`. Edit the file and restart.
- If the file **exists but fails to parse** (I/O error or invalid JSON), the error is logged and the process continues with built-in defaults for whichever sections failed to load — the file is *not* overwritten and the process does *not* exit. Fix the file and restart to pick up the intended values.
- On every startup (not only the first), a fully-resolved snapshot of the configuration in effect — including any `--logslevel` override, and with all filesystem paths resolved via `weakly_canonical` — is written to `<config-file>.run`. Useful for diagnosing what the process actually parsed.
- `Config::Validate()` also runs on every startup (see `docs/build.md`, Embedded Resources): it (re)writes embedded board/script files that are missing (or unconditionally with `--force-install`), and creates a handful of *sub*-directories (`<html>/board/...`, `<html>/jobsscripts`, `<exportPath>/Canceled`). It does **not** create the top-level roots themselves — see "Required Directories" below.

## Command-Line Arguments

| Argument | Description |
|---|---|
| `<config-file>` | Path to the JSON config file (first argument not starting with `-`). Default: `config.json`. |
| `--force-install` | Force-(re)write every embedded/extracted file (board dashboard, `executor.sh`/`functions.sh`) even if already present, then continue to normal startup. |
| `--only-install` | Run `Config::Validate()` (extracts missing embedded files, creates a few sub-directories — see below) and exit immediately — the HTTP server never starts. Combine with `--force-install` to force-refresh files without starting the server. |
| `--logslevel <N>` | Override the log level bitmask at runtime (see `logs_level` below); does not change the value saved back to the config file, only the `.run` snapshot and the live process. |

There is no `--install` flag — `--only-install` is the flag that performs a one-shot install-and-exit.

## First Run / Required Directories

Two things trip up a first-time install, verified against `main.cxx` and each sub-config's `Validate()`, and empirically against a built binary:

1. **On a config file that doesn't exist yet, the process writes a default `config.json` and exits with status 1 — before running `Config::Validate()` at all.** `--force-install`/`--only-install` have no effect on this first invocation; they're only read *after* the "config file not found" branch. You always need a second invocation once a config file is present (the one just written, or your own) for install/startup to actually happen.

2. **Six top-level paths must already exist on disk before that second invocation succeeds — the process does not create them for you**: `schedule.toolsPath` (default `tools`), `schedule.runPath` (`runs`), `schedule.userPath` (`users_data`), `schedule.exportPath` (`exports`), `cache.storagePath` (`cache`), and `schedule.executors.local.scriptPath` (`scripts`); `server.html` (`html`) too, though that one usually already exists if you're running from a checkout. Each is passed through `std::filesystem::canonical()` during `Validate()`, which throws if the path is missing.

   That exception is not caught anywhere between `Config::Validate()` and `main()` (the `try`/`catch` in `main.cxx` only wraps `app.run(...)`, which runs later), so a missing directory **aborts the process** (`SIGABRT`, non-zero/"crashed" exit status) rather than exiting cleanly. The abort message is explicit, though, and names the missing path, e.g.:
   ```
   terminate called after throwing an instance of 'std::filesystem::filesystem_error'
     what():  filesystem error: cannot make canonical path: No such file or directory [tools]
   ```
   `Validate()` checks these paths in a fixed order and stops at the first missing one — expect to iterate (create one, rerun, see the next one named) rather than getting the full list of missing paths in a single run. `Config::Validate()` *does* auto-create a few things once its root exists: `<html>/board/`, `<html>/board/custom/`, `<html>/board/launchers/`, `<html>/jobsscripts/`, and `<exportPath>/Canceled/` — but never the six roots themselves.

Practical sequence for a fresh checkout, run from the repository root (where `html/` and `scripts/` already exist as source):
```bash
mkdir -p tools runs users_data exports cache
./scheduler config.json          # writes a default config.json and exits 1 (first time only)
./scheduler config.json --only-install   # now succeeds: extracts board files, executor.sh/functions.sh
./scheduler config.json          # starts the server
```
For a binary-only deployment (see `docs/build.md`), also copy `html/`, `scripts/` (or point `server.html`/`executors.local.scriptPath` elsewhere) alongside the six directories above.

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
| `logs_level` | uint | `15` | Bitmask: `1`=error, `2`=warning, `4`=info, `8`=debug. `15` enables all levels; `LOGA` (startup banner) is always printed regardless of this bitmask. |

---

## `server` Section

```json
"server": {
  "secure":   false,
  "hostname": "localhost",
  "port":     10082,
  "key":  "security/site.key",
  "cert": "security/site.pem",
  "CA":   "security/CA.pem",
  "html": "html"
}
```

| Key | Type | Default (plain) | Default (`secure: true`) | Description |
|---|---|---|---|---|
| `secure` | bool | `false` | — | Enable TLS. When `true`, `key`, `cert` and `CA` are read (and must resolve via `std::filesystem::canonical`, i.e. must exist). |
| `hostname` | string | `"localhost"` | same | Used only to build `apiURL_` (`http(s)://<hostname>:<port>/api`), the base URL handed to internal API consumers and usable in publisher `${...}` templates. The HTTP listener itself binds to all interfaces on `port` — `hostname` does **not** restrict the bind address. |
| `port` | uint16 | `10082` | `8443` | TCP port to listen on. |
| `key` | path | `security/site.key` | same | Server private key (PEM). Required (must exist) when `secure: true`. |
| `cert` | path | `security/site.pem` | same | Server certificate (PEM). Required (must exist) when `secure: true`. |
| `CA` | path | `security/CA.pem` | same | CA bundle (PEM). Required (must exist) when `secure: true`. |
| `html` | path | `html` | same | Root directory for static file serving (`GET /files/*` maps directly onto `<html>/...`, no extra `files/` segment on disk) and for the extracted board dashboard (`<html>/board/...`). Must already exist — `Validate()` calls `std::filesystem::canonical(html_)`, which throws if it doesn't. |

TLS uses `Poco::Net::Context::VERIFY_NONE` (client certificate verification is disabled).

---

## `schedule` Section

```json
"schedule": {
  "toolsPath":  "tools",
  "runPath":    "runs",
  "userPath":   "users_data",
  "exportPath": "exports",
  "publisher": {
    "default": {
      "base_url":                "https://publisher.example.com",
      "notify_endpoint":         "/api/notify",
      "view_endpoint":           "/files/${PROJECT}#${TASK_ID}",
      "storage":                 "/var/lib/results",
      "check_server_certificat": false
    }
  },
  "executors": {
    "local": {
      "type":         1,
      "nbCores":      4,
      "excludeCores": [0],
      "scriptPath":   "scripts",
      "logsSize":     16777216
    }
  }
}
```

### Paths

All four paths are resolved with `weakly_canonical` on load, and then each is passed through `std::filesystem::canonical` in `Validate()` — meaning **they must already exist** on disk before startup (the server does not create them, other than an automatic `<exportPath>/Canceled` subdirectory).

| Key | Type | Default | Description |
|---|---|---|---|
| `toolsPath` | path | `tools` | Shared read-only tools directory injected into every step (exposed to step scripts as an environment variable; see the executor docs). |
| `runPath` | path | `runs` | Root for live task working directories. Also implicitly defines `<runPath>/monitors` (`monitorsPath_`, not independently configurable) used by the inotify-based monitor. |
| `userPath` | path | `users_data` | Directory for uploaded input files (flow JSON, step script, extra files from `/api/task/new`). |
| `exportPath` | path | `exports` | Destination for completed task archives and the `tasksmanager.json` state file. `<exportPath>/Canceled` is created automatically at startup for cancelled tasks. |

### `publisher` subsection

Named publisher targets referenced by `publish.server` in flow JSON files. Every field except `check_server_certificat` is mandatory — a `publisher.<name>` entry missing `base_url`, `notify_endpoint`, `view_endpoint` or `storage` throws at load time.

| Key | Type | Default | Description |
|---|---|---|---|
| `base_url` | URL | — (required) | HTTP(S) base URL of the remote publish server. |
| `notify_endpoint` | path | — (required) | Endpoint appended to `base_url` for the HTTP notification POST sent after archival. |
| `view_endpoint` | path template | — (required) | Endpoint appended to `base_url` to build the task's `publish_link`. Supports `${VAR}` substitution (e.g. `${PROJECT}`, `${TASK_ID}`). |
| `storage` | path | — (required) | Root directory on the publish server where task archives are stored; the flow's own `publish.storage` value is appended underneath it. |
| `check_server_certificat` | bool | `false` | Whether to validate the publish server's TLS certificate when `base_url` is `https://`. |

### `executors` subsection — Local executor

The only supported executor `type` is `1` (Local); any other value throws `"Executor config type unknown"` at load time. If no `executors` object is present, a single `local` executor with all defaults is created automatically.

```json
"executors": {
  "local": {
    "type":            1,
    "nbCores":         4,
    "excludeCores":    [0],
    "scriptPath":      "scripts",
    "logsSize":        16777216,
    "cgroupPath":      "/sys/fs/cgroup/scheduler.service",
    "cpuMaxLoad":      90,
    "memMinimumRatio": 0.15
  }
}
```

| Key | Type | Default | Description |
|---|---|---|---|
| `nbCores` / `excludeCores` | uint / array | `1` core, `excludeCores: [0]` | Together select which cores the executor may assign: start from all cores, keep `nbCores` of them, excluding the indices in `excludeCores`. Used only when `cores` is absent. |
| `cores` | array of uint | — | Alternative, explicit form: the exact list of core indices the executor may use (overrides `nbCores`/`excludeCores` when present). |
| `scriptPath` | path | `scripts` | Directory containing `executor.sh` and `functions.sh`; must already exist (`canonical()`), the two scripts themselves are auto-extracted if missing. |
| `logsSize` | uint | `16777216` (16 MiB) | Per-step in-memory output ring buffer size in bytes. |
| `cgroupPath` | string (template) | `/sys/fs/cgroup/scheduler.service` | Symbolic cgroup v2 path used for CPU/resource isolation; supports `${euid}`/`${uid}` substitution (effective/real UID of the running process), then resolved with `weakly_canonical`. |
| `cpuMaxLoad` | uint (0-100) | `90` | Ceiling on overall CPU load percentage used by the scheduler when deciding whether to start new steps. |
| `memMinimumRatio` | double | `0.15` | Minimum fraction of free memory that must remain available for a new step to be scheduled. |

If `cores_.size()` or `nbCores` exceeds the number of cores actually present on the machine, `Validate()`/`DoLoad()` throws `"Config of Local executor requires more cores than system have"`.

---

## `cache` Section

```json
"cache": {
  "storagePath": "cache",
  "mappingFile": "cache.json"
}
```

| Key | Type | Default | Description |
|---|---|---|---|
| `storagePath` | path | `cache` | Directory where cached files are stored (one file per cache ID). Must already exist — resolved with `canonical()` at `Validate()`. |
| `mappingFile` | filename | `cache.json` | JSON file, always resolved *inside* `storagePath` regardless of the value's own directory component, mapping cache IDs to file paths and MD5 hashes. Rebuilt at startup. |

---

## Job Launcher / Board Extension Points

The web dashboard's job-launcher UI is not driven by a server-side config key — it is a set of files the operator drops under the `html` root after `Config::Validate()` has created the empty extension directories:

- `<html>/board/launchers/` — per-project launcher modules (see `docs/board-job-launcher.md`)
- `<html>/board/custom/` — optional `header.html` fetched by `board.js` to inject a custom header fragment
- `<html>/jobsscripts/` — served at `/files/jobsscripts/...`; where flow JSON / step scripts / extra files referenced by a launcher module typically live

None of these are populated by the server itself and none are part of the embedded-resource extraction described in `docs/build.md`. See `docs/board-job-launcher.md` for the full mechanism and file formats.

---

## Example: `samples/scheduler/config.json`

This is the repository's real sample config, annotated:

```json
{
  "server": {
    "secure": false,
    "key": "scheduler/security/site.key",
    "cert": "scheduler/security/site.pem",
    "CA": "scheduler/security/CA.pem",
    "hostname": "localhost",
    "port": 10082,
    "html": "scheduler/html"
  },
  "schedule": {
    "runPath": "scheduler/runs",
    "userPath": "scheduler/users_data",
    "exportPath": "scheduler/exports",
    "toolsPath": "scheduler/tools",
    "executors": {
      "local": {
        "name": "local",
        "type": 1,
        "nbCores": 1,
        "excludeCores": [0],
        "scriptPath": "scheduler/scripts",
        "logsSize": 16777216,
        "cgroupPath": "/sys/fs/cgroup/scheduler.service",
        "cpuMaxLoad": 90,
        "memMinimumRatio": 0.15
      }
    },
    "publisher": {
      "default": {
        "base_url": "http://127.0.0.1:10083",
        "notify_endpoint": "/api/notify",
        "view_endpoint": "/files/${PACKAGE}#${TASK_ID}",
        "storage": "publisher"
      }
    }
  },
  "cache": {
    "storagePath": "scheduler/cache",
    "mappingFile": "cache.json"
  }
}
```

Notes on this example:
- `executors.local.name` is redundant (the executor's name already comes from the JSON object key, `"local"`) but harmless — it is not read back by `DoLoad`.
- The `local` executor here restricts to a single core (core `0` excluded, `nbCores: 1`), suitable for a small dev box; production deployments typically raise `nbCores` and widen `excludeCores` to just the OS-reserved core(s).
- `publisher.default.view_endpoint` uses `${PACKAGE}`, a project-defined template variable substituted at publish time — the set of substitutable variables is up to the flow/executor context, not fixed by the scheduler itself. `publisher.default.storage` (`"publisher"`) is a relative path too, but it names a location on the *remote* publish server, not something resolved/checked locally by `Validate()`.
- **Deployment layout**: every local filesystem path here (`html`, `key`/`cert`/`CA`, `scriptPath`, `runPath`/`userPath`/`exportPath`/`toolsPath`, `cache.storagePath`) shares the same `scheduler/` prefix, all relative to the current working directory at launch (paths are never resolved relative to the config file's own location — there is no `chdir` to it anywhere in `main.cxx`). That means a single working directory containing one `scheduler/` subdirectory with the usual layout satisfies every path at once:
  ```
  <cwd>/
    scheduler/
      security/{site.key,site.pem,CA.pem}   # only read if server.secure = true
      html/
      scripts/
      tools/ runs/ users_data/ exports/ cache/
  ```
  No ambiguity and no shared/sibling directory needed — just create `scheduler/` (and its subdirectories, per "First Run / Required Directories" above) under wherever you'll launch the process from, or copy the whole `scheduler/` tree from this repository's root and rename it. Verified by reproducing this exact layout and running `scheduler config.json --only-install` from `<cwd>`: install succeeds.

---

## Deployment Files (`samples/system/`)

Not read by the scheduler at runtime — templates for running it as a systemd service with cgroup v2 delegation.

**`scheduler.service`**:
```ini
[Unit]
Description=Scheduler XP
After=network-online.target

[Service]
Slice=-.slice
User=<user>
WorkingDirectory=<working_dir>
ExecStart=<srv_path>
Restart=always
Delegate=yes

[Install]
WantedBy=multi-user.target
```
`Slice=-.slice` + `Delegate=yes` gives the unit its own cgroup (`/sys/fs/cgroup/scheduler.service` under systemd's default hierarchy) that it's allowed to manage sub-cgroups under — matching the `executors.local.cgroupPath` default above. Fill in `<user>`, `<working_dir>` and `<srv_path>` (the built `scheduler`/`scheduler-static` binary) before installing.

**`scheduler.sudoers`**:
```
<user> ALL=(root) NOPASSWD: /usr/bin/systemctl set-property user.slice AllowedCPUs=*
```
Lets the service user adjust the `user.slice` `AllowedCPUs` cgroup property without a password, needed when the executor reassigns CPU affinity outside its own delegated slice.
