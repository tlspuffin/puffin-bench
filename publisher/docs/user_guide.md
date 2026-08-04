# User guide — restsrv.publisher

## 1. Build and installation

### System prerequisites

- CMake ≥ 3.5, Git, C++17 compiler
- OpenSSL installed (`libssl-dev` on Debian/Ubuntu)

### Compilation

```bash
git clone <repo> restsrv.publisher
cd restsrv.publisher
cmake -B build
cmake --build build --target publisher
```

The build system automatically downloads and compiles into `third-party/`: zlib, Poco, RapidJSON, LibArchive, ZStd.
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
    "port": 10083
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
| `publisher.htmlPath` | Directory from which static web files are served |
| `publisher.orphanScanInterval` | Automatic scan interval in seconds |

If the config file does not exist, the server creates one with default values and stops.

See `docs/configuration.md` for the complete configuration reference.

---

## 3. First start

```bash
./publisher publisher_config.json
```

On first start, the server validates paths and begins serving. Web files (HTML/CSS/JS) are **not** managed by the publisher — they must be deployed separately into `htmlPath` by the web interface project.

---

## 4. Creating a project

A project is a directory inside `storagePath` containing a `.rules` file that describes how to process archives.

### Minimal structure

```
storagePath/
└── my_project/
    ├── .rules              ← required
    └── PR/                 ← your archive files
```

### `.rules` file

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
  },
  "Vuln": {
    "onFiles": "PR/[0-9a-fA-F]+/Vuln/[0-9]+\\.zip",
    "action": "GenerateMergeJSON",
    "parameters": {
      "src": "./artefacts/summary.json",
      "dst": "Vuln/${FILE_RELATIVE_PATH_1}.json",
      "keep": ["type", "commit_id"],
      "merge": ["libraries"],
      "strategy": { "comparator": ">=", "field": "timestamp" },
      "generate_ZST": false
    }
  }
}
```

| Field | Description |
|-------|-------------|
| `index` | Path relative to `htmlPath/publisher/` of the HTML file served when accessing `GET /files/{project_name}` |
| `{RuleName}.action` | `GenerateMergeJSON` or `NULL` |
| `{RuleName}.onFiles` | Regex on the archive path (relative to the `.rules` directory) |
| `{RuleName}.parameters.src` | Path of the JSON file to extract from the archive (template variables supported) |
| `{RuleName}.parameters.dst` | Output file path relative to `.project/` (template variables supported). Determines merge granularity: archives resolving to the same `dst` are merged; archives resolving to different `dst` values each produce an independent JSON. |
| `{RuleName}.parameters.keep` | Array of field names that must be present in `src`; if `dst` already exists, their values must match what is stored there |
| `{RuleName}.parameters.merge` | Array of object keys to merge across archives |
| `{RuleName}.parameters.strategy` | Object with `comparator` (`>`, `>=`, `<`, `<=`, `==`, `!=`) and `field` (uint64 field in `src` JSON used to select the winning entry when merging) |
| `{RuleName}.parameters.generate_ZST` | If `true`, generates a seekable `.tar.zst` performance archive alongside the source archive (extracts stats JSON files, converts to binary time series); not regenerated during cache regeneration |
| `{RuleName}.parameters.campaign` | If `true`, lists this rule's data in `GET /api/project/{name}/campaigns` |

The **first rule whose pattern matches** is applied by the periodic scan. `NULL` silently ignores the file. Notified files (via `POST /api/notify`) are tested against all rules.

`.rules` files can also be placed in subdirectories to refine matching per zone of the project. The `index` field in a subdirectory `.rules` is then served when accessing `GET /files/{project_name}/{subdirectory}`.

### Template variables

In `src` and `dst` parameter values, the following variables are replaced with values derived from the archive path:

| Variable | Value |
|----------|-------|
| `${FILE_RELATIVE_PATH_N}` | N-th path segment of the archive path relative to the rule's directory (0-based) |
| `${FILENAME}` | Archive filename stem (without extension) |

Example: for archive `PR/abc1234/Perf/42.zip` matched by a rule in `my_project/`:
- `${FILE_RELATIVE_PATH_0}` = `PR`
- `${FILE_RELATIVE_PATH_1}` = `abc1234`
- `${FILE_RELATIVE_PATH_2}` = `Perf`
- `${FILENAME}` = `42`

---

## 5. Submitting archives

Once the server is running, submit an archive for processing:

```bash
curl -X POST http://localhost:10083/api/notify \
  -F "dst=my_project/PR/abc1234/Perf" \
  -F "src=1.zip"
```

- `dst`: full directory path relative to `storagePath` where the archive is located (must include all subdirectories, not just the project name)
- `src`: archive **filename only** — only the last path component is used; any leading path is ignored (repeatable for multiple files in the same directory)

The server resolves the file as `storagePath/dst/src` and checks it exists. The project name is taken as the first segment of `dst`.

**Immediate response** — processing is asynchronous:
```json
{"success": true}
```

The server processes the archive in the background: JSON extraction, merge, index update. Notified files are always reprocessed (bypassing the index cache and error list), allowing forced retries. Re-submitting an already-processed archive is idempotent: `RuleMergeJSON` overwrites existing entries with the same data, leaving the output JSON unchanged.

In practice, archives are placed in the project directory tree by the scheduler before the notification is sent. The scheduler constructs `dst` from the full path it used when writing the archive.

### Submitting multiple files from the same directory

```bash
curl -X POST http://localhost:10083/api/notify \
  -F "dst=my_project/PR/abc1234/Vuln" \
  -F "src=1.zip" \
  -F "src=2.zip"
```

Files from different directories must be submitted in separate requests.

---

## 6. Accessing results

### Via the API

List processed output files for a project:
```bash
curl http://localhost:10083/api/project/my_project/data
```
```json
{"success": true, "files": ["Perf/abc1234.json", "Vuln/abc1234.json"]}
```

Download a result:
```bash
curl http://localhost:10083/files/my_project/.project/Perf/abc1234.json
```

### Via the web interface

Open in a browser (requires web files deployed in `htmlPath/publisher/`):
```
http://localhost:10083/files/my_project
```

The server automatically serves the HTML file configured in the `.rules` `index` field. The page fetches its data in two steps:
1. `GET /api/project/{project_name}/data` → list of result JSON files
2. `GET /files/{project_name}/.project/{file}` → content of each result

---

## 7. Cache management

### Regenerating the cache

To force reprocessing of all archives for a project (e.g. after a rules change):

```bash
curl -X POST "http://localhost:10083/api/project/my_project/regenerate_cache"
```

To limit regeneration to a specific subdirectory:
```bash
curl -X POST "http://localhost:10083/api/project/my_project/regenerate_cache?directory=Perf/abc1234"
```

This drops the index for the specified scope, deletes the corresponding output JSON files, and reruns the full scan.

### Deleting a result

To remove a specific result file from the index and from disk:

```bash
curl -X DELETE "http://localhost:10083/api/project/my_project/data/Perf/abc1234.json"
```

Associated source artefacts (files sharing the same path stem) are also deleted.

---

## 8. Generated file structure

The publisher creates `.project/` and all output subdirectories automatically. Source directories (`PR/`, `Campaign/`, etc.) and the archives they contain are written by the scheduler — the publisher only reads them.

```
storagePath/
└── my_project/
    ├── .rules
    ├── .project/                     ← created automatically by the publisher
    │   ├── .index.json               ← internal cache (do not modify)
    │   ├── Perf/abc1234.json         ← merged performance result
    │   └── Vuln/abc1234.json         ← merged vulnerability result
    └── PR/                           ← written by the scheduler
        └── abc1234/
            ├── Perf/
            │   └── 1.zip             ← source archive
            └── Vuln/
                └── 1.zip             ← source archive
```

The output file path under `.project/` is determined by the `dst` parameter of the matching rule.

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

## 10. Campaigns

Rules with `"campaign": true` in their parameters are treated as campaign rules. Their output data can be queried via:

```bash
curl http://localhost:10083/api/project/my_project/campaigns
```

The endpoint returns the list of `.zst` files found under the rule's data path, grouped by user and campaign ID (inferred from the directory structure: `{user}/{campaign}/{file}.zst`).

---

## 11. Logs

Control verbosity via `logs_level` (bitmask):

| Value | Level |
|-------|-------|
| 1 | Errors only |
| 3 | Errors + warnings |
| 7 | Errors + warnings + info |
| 15 | Everything (debug included) |

To override the log level at runtime without editing the config file:
```bash
./publisher --logslevel 15 publisher_config.json
```

To check the log level actually used by the running process, consult the `{config}.run` file (e.g. `publisher_config.json.run`) written at startup with the effective configuration.

---

## 12. Diagnosing processing errors

There is no API endpoint to inspect which files failed processing. Files that fail are added to an in-memory `filesInError_` list (not persisted, cleared on restart) and silently skipped by subsequent periodic scans.

The only diagnostic tool is the server logs (`LOGE` entries). Set `logs_level` to at least `3` (errors + warnings) to capture failures.

To retry a failed file without restarting:
```bash
curl -X POST http://localhost:10083/api/notify \
  -F "dst=my_project/PR/abc1234/Perf" \
  -F "src=1.zip"
```

`POST /api/notify` bypasses `filesInError_` and forces reprocessing regardless of prior failure.
