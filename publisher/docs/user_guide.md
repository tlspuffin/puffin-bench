# User guide — restsrv.publisher

## 1. Build and installation

### System prerequisites

- CMake ≥ 3.21, Git, C++17 compiler
- OpenSSL installed (`libssl-dev` on Debian/Ubuntu)
- `xxd` (usually included in `vim-common`)

### Compilation

```bash
git clone <repo> restsrv.publisher
cd restsrv.publisher
cmake -B build
cmake --build build --target publisher
```

The build system automatically downloads and compiles: zlib, Poco, RapidJSON, LibArchive, ZStd.
OpenSSL is the only system prerequisite that is not auto-fetched.

**Customise OpenSSL mode** (static by default):
```bash
cmake -B build -DOPENSSL_MODE=SHARED
```

**Share dependencies across projects** (avoids recompiling everything for each project):
```bash
cmake -B build -DDEPS_BASE_DIR=/home/olivier/Desktop/shared-deps
```

See `docs/build.md` for full build system details.

---

## 2. Configuration

Create or edit `publisher_config.json`:

```json
{
  "logs_level": 7,
  "server": {
    "secure": false,
    "port": 8081
  },
  "publisher": {
    "storagePath": "data",
    "htmlPath": "html",
    "orphanScanInterval": 3600
  }
}
```

| Field | Description |
|-------|-------------|
| `logs_level` | Bitmask: `1`=error, `2`=warning, `4`=info, `8`=debug (e.g. `7` = all except debug) |
| `server.port` | HTTP listening port |
| `server.secure` | `true` for HTTPS — requires `key`, `cert`, `CA` |
| `publisher.storagePath` | Root directory containing projects and archives |
| `publisher.htmlPath` | Directory where web files are written at startup |
| `publisher.orphanScanInterval` | Automatic scan interval in seconds |

If the config file does not exist, the server creates one with default values and stops.

See `docs/configuration.md` for the complete configuration reference.

---

## 3. First start

```bash
./publisher publisher_config.json
```

On first start, the server automatically writes the web files (`summary_PR.html`, `.css`, `.js`, `plotly-3.3.0.min.js`, etc.) into `htmlPath/publisher/`. These files are embedded in the binary — `htmlPath` can be empty initially.

To force-reinstall web files without starting the server (e.g. after a binary update, without running the server):
```bash
./publisher --install publisher_config.json
```

To force rewriting of web files (after a binary update):
```bash
./publisher --force-install publisher_config.json
```

---

## 4. Creating a project

A project is a directory inside `storagePath` containing a `.rules` file that describes how to process archives.

### Minimal structure

```
storagePath/
└── my_project/
    ├── .rules              ← required
    └── archives/           ← your .zip/.json archives
```

### `.rules` file

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
| `index` | Path relative to `htmlPath/publisher/` of the HTML file served when accessing `GET /files/{project_name}` |
| `{RuleName}.action` | Action to apply: `GenerateReportVuln3`, `GenerateReportPerfFromSummary`, `GenerateReportCampaignFromSummary`, `NULL` |
| `{RuleName}.onFiles` | Regex on the archive path (relative to the project) |
| `{RuleName}.parameters.dataPath` | Required for `GenerateReportCampaignFromSummary`: root directory containing campaign data folders |

The **first rule whose pattern matches** is applied. `NULL` silently ignores the file.

`.rules` files can also be placed in subdirectories to refine matching per zone of the project.

---

## 5. Submitting archives

Once the server is running, submit an archive for processing:

```bash
curl -X POST http://localhost:8081/api/notify \
  -F "dst=my_project" \
  -F "src=PR/abc1234/Vuln/1.zip"
```

- `dst`: project name (directory in `storagePath`)
- `src`: archive path **relative to `storagePath/dst`** (repeatable for multiple files)

**Immediate response** — processing is asynchronous:
```json
{"success": true}
```

The server processes the archive in the background: result extraction, JSON generation, index update. Already-processed files are automatically skipped.

### Submitting multiple files

```bash
curl -X POST http://localhost:8081/api/notify \
  -F "dst=my_project" \
  -F "src=PR/abc1234/Vuln/1.zip" \
  -F "src=PR/abc1234/Vuln/2.zip" \
  -F "src=PR/abc1234/Perf/1.zip"
```

---

## 6. Accessing results

### Via the API

List processed files for a project:
```bash
curl http://localhost:8081/api/project/my_project/data
```
```json
{"success": true, "files": ["abc1234.json", "def5678.json"]}
```

Download a result:
```bash
curl http://localhost:8081/files/my_project/.project/abc1234.json
```

### Via the web interface

Open in a browser:
```
http://localhost:8081/files/my_project
```

The server automatically serves the HTML file configured in the `.rules` `index` field (e.g. `summary_PR.html`). `summary_PR.html` displays results per commit, with:
- 5 tabs: **Dev/Main**, **PR**, **Branches**, **Others**, **Campaigns**
- Status filters (Success / Fail / Mixed / No run)
- PR state filter (Open / Closed) — visible on the PR tab only
- Metrics and overview graphs (Plotly)
- Commit ID search

#### Refresh and GitHub API cost

The **Refresh** button behaviour differs per tab:

- **PR tab**: the button turns **gold** and triggers a full refresh that calls the external GitHub API (`?refresh=all`). This consumes GitHub API credits. Remaining credits and next reset time are displayed below the button.
- **All other tabs**: the button is standard and performs a local refresh (`?refresh=local`) with no external API call and no cost.

The page loads its data in two steps:
1. `GET /api/project/{project_name}/data` → list of JSON result files
2. `GET /files/{project_name}/.project/{commitID}.json` → content of each result

---

## 7. Web interface — operation and customisation

### Embedded files

At startup, the server writes the following files into `htmlPath/publisher/` according to two installation rules:

**Overwritten by `--force-install`** (updated with each new binary version):

| File | Role |
|------|------|
| `summary_PR.html` | Main page |
| `summary_PR.css` | Styles |
| `summary_PR.js` | Main logic |
| `summary_PR_metrics.js` | Metrics component |
| `summary_PR_graphoverview.js/css` | Overview graph |
| `summary_PR_graphmetrics.js/css` | Metrics graph |
| `plotly-3.3.0.min.js` | Graphing library |

**Never overwritten** (preserved even with `--force-install`):

| File | Role |
|------|------|
| `summary_PR_config.js` | External service URL configuration |

To update application files after a binary update:
```bash
./publisher --force-install publisher_config.json
```

### External service configuration (`summary_PR_config.js`)

`summary_PR_config.js` is installed once in `htmlPath/publisher/` and never overwritten. It can be edited directly to adapt URLs without recompiling or running `--force-install`.

```js
const config = {
  urlGit:      (project) => `http://${window.location.hostname}:10083/api/git/history/${project}`,
  urlGitLogs:  (project) => `http://${window.location.hostname}:10083/api/git/logs/${project}`,
  urlData:     (project) => `http://${window.location.host}/api/project/${project}/data`,
  urlDataFile: (project) => `http://${window.location.host}/files/${project}/.project`,
  taskInfoURL: `http://${window.location.hostname}:10081/files/board/task.html`,
  artefactURL: (taskID)  => `http://${window.location.hostname}:10081/api/task/${taskID}/artefacts`
}
```

**Publisher server (this server)** — uses `window.location.host`, adapts automatically:

| Field | Required | Description |
|-------|----------|-------------|
| `urlData` | yes | `GET /api/project/{project}/data` — list of result files |
| `urlDataFile` | yes | `GET /files/{project}/.project/{file}` — content of a result per commit |

**Git REST API** (port 10083) — uses `window.location.hostname` + fixed port:

| Field | Required | Description |
|-------|----------|-------------|
| `urlGit` | yes | `GET /api/git/history/{project}` — git history of the project |
| `urlGitLogs` | yes | `POST /api/git/logs/{project}` — git logs for a list of commits |

**Scheduler / board** (port 10081) — uses `window.location.hostname` + fixed port:

| Field | Required | Description |
|-------|----------|-------------|
| `taskInfoURL` | no | `GET /files/board/task.html?id={taskID}` — task detail page (opened on click) |
| `artefactURL` | no | `GET /api/task/{taskID}/artefacts` — task artefact download |

If `urlGit`, `urlGitLogs`, `urlData` or `urlDataFile` fail, the page does not render. Unavailability of `taskInfoURL` / `artefactURL` only affects the corresponding user interactions.

### Custom HTML

The `.rules` `index` field can point to any file present in `htmlPath/publisher/`. To use a custom page:

1. Place the file in `htmlPath/publisher/` (e.g. `htmlPath/publisher/my_page.html`)
2. Reference it in `.rules`:
```json
{
  "index": "my_page.html",
  ...
}
```

A custom page can call the server APIs:

| API | Description |
|-----|-------------|
| `GET /api/project/{project_name}/data` | List of result files (paths relative to `.project/`) |
| `GET /files/{project_name}/.project/{commitID}.json` | Content of a per-commit result |
| `GET /html/{path}` | Any static file from `htmlPath` |

### Direct HTML file access

It is also possible to access an HTML file directly without going through the `index` routing:
```
http://localhost:8081/files/my_project/summary_PR.html
```
In this case the file is served from `storagePath` — the file must therefore exist physically in the project directory, unlike routing via `index` which serves from `htmlPath/publisher/`.

---

## 8. Generated file structure

```
storagePath/
└── my_project/
    ├── .rules
    ├── .project/                     ← created automatically
    │   ├── .index.json               ← internal cache (do not modify)
    │   ├── abc1234def5678.json       ← per-commit result
    │   └── ...
    └── PR/
        └── abc1234/
            └── Vuln/
                └── 1.zip             ← source archive
                └── 1.json            ← experiment status
```

---

## 9. HTTPS

Enable TLS in the configuration:

```json
{
  "server": {
    "secure": true,
    "port": 8443,
    "key":  "security/site.key",
    "cert": "security/site.pem",
    "CA":   "security/CA.pem"
  }
}
```

Certificate paths are relative to the binary's working directory.

---

## 10. Logs

Control verbosity via `logs_level` (bitmask):

| Value | Level |
|-------|-------|
| 1 | Errors only |
| 3 | Errors + warnings |
| 7 | Errors + warnings + info |
| 15 | Everything (debug included) |

Restart the server after modifying the config to apply the change.

To check the log level actually used by the running process, consult the `{config}.run` file (e.g. `publisher_config.json.run`) written at startup with the effective configuration.
