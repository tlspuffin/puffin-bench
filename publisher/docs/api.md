# REST API — restsrv.publisher

## Endpoints

### `POST /api/notify`

Submits archives for asynchronous processing.

**Content-Type**: `multipart/form-data`

| Field | Type | Description |
|-------|------|-------------|
| `src` | string (repeatable) | Filename(s) of the archive(s) to process — only the filename component is used, the rest of any provided path is ignored |
| `dst` | string | Directory path relative to `storagePath` where the archive(s) are located (must include the full subdirectory structure, e.g. `my_project/PR/abc1234/Perf`) |

**Response**:
```json
{"success": true}
{"success": false, "error": "message"}
```

**Behaviour**: the server resolves each file as `storagePath/dst/filename(src)` and checks that it exists. Files are then queued for processing by the publish thread. The response is immediate — processing is asynchronous. Notified files always trigger reprocessing even if already indexed.

The project name is taken as the first path segment of `dst` (e.g. `my_project` from `my_project/PR/abc1234/Perf`).

---

### `GET /api/project/{name}/data`

Returns the list of processed JSON files for a project.

| Parameter | Description |
|-----------|-------------|
| `name` | Project name (alphanumeric, dashes, underscores) |

**Response**:
```json
{"success": true,  "files": ["Perf/<commitID>.json", "..."]}
{"success": false, "error": "message"}
```

Returned paths are relative to `storagePath/name/.project/`. They are accessible via `GET /files/`.

---

### `POST /api/project/{name}/regenerate_cache`

Drops the index for a project (or a subdirectory) and reprocesses all archives from scratch.

| Parameter | Description |
|-----------|-------------|
| `name` | Project name |
| `directory` (query, optional) | Subdirectory to limit the regeneration scope |

**Example**:
```
POST /api/project/my_project/regenerate_cache?directory=Perf/abc1234
```

**Response**:
```json
{"success": true}
{"success": false, "error": "message"}
```

**Behaviour**: deletes cached output files for the specified scope, then reruns `ScanStorage()` with `regenCache=true`. This forces regeneration even for files already in `filesInError_`.

---

### `DELETE /api/project/{name}/data/{file}`

Deletes a result file from the index and from disk, along with associated source artefacts.

| Parameter | Description |
|-----------|-------------|
| `name` | Project name |
| `file` | Path of the cache file to delete (relative to `.project/`) |

**Response**:
```json
{"success": true}
{"success": false}
```

---

### `GET /api/project/{name}/campaigns`

Returns the list of campaigns available for a project. Only populated for rules with `"campaign": true`.

| Parameter | Description |
|-----------|-------------|
| `name` | Project name |

**Response**:
```json
{
  "success": true,
  "{user}": {
    "{campaign_id}": [
      {"task": "...", "file": "..."},
      ...
    ]
  }
}
```

---

### `GET /files/{path}`

Downloads a file. Routing depends on the path:

- If `path` is exactly `{project_name}` or `{project_name}/{subdirectory}`, and the corresponding directory in `storagePath` contains a `.rules` file with an `index` field → served from `htmlPath/publisher/{index_value}`
- Otherwise → served from `storagePath`

Example: `GET /files/my_project` with a `.rules` containing `"index": "summary.html"` serves `htmlPath/publisher/summary.html`.

| Parameter | Description |
|-----------|-------------|
| `path` | Relative path (automatically routed to `storagePath` or `htmlPath`) |

- MIME type detected by extension (`.html`, `.css`, `.js`, `.json`, `.jpg`, `.jpeg`, `.png`, `.svg`).
- Returns **404** if the file does not exist.
- Path traversal protection: the canonical path must remain within the allowed directory.

---

### `GET /html/{path}`

Downloads a static file from the `htmlPath` directory.

Same behaviour as `GET /files/`, confined to `htmlPath`.

---

### `OPTIONS *`

CORS preflight response for all routes.

**Returned headers**:
```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, PATCH, PUT, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type
```

---

## Server configuration

```json
{
  "server": {
    "port": 10083,
    "secure": false,
    "key":  "security/site.key",
    "cert": "security/site.pem",
    "CA":   "security/CA.pem"
  },
  "publisher": {
    "storagePath": "data",
    "htmlPath": "html",
    "orphanScanInterval": 3600
  },
  "logs_level": 15
}
```

| Field | Type | Description |
|-------|------|-------------|
| `server.port` | uint16 | Listening port |
| `server.secure` | bool | Enables HTTPS (Poco NetSSL) |
| `server.key/cert/CA` | string | SSL certificate paths (relative to CWD) |
| `publisher.storagePath` | path | Root directory for archives and results |
| `publisher.htmlPath` | path | Web files directory |
| `publisher.orphanScanInterval` | uint64 | Periodic scan interval (seconds) |
| `logs_level` | int | Bitmask: error=1, warning=2, info=4, debug=8 |

See `docs/configuration.md` for the complete configuration reference.

---

## Starting the server

```bash
./publisher [publisher_config.json]
./publisher --only-install [config.json]    # reserved; currently exits after validation
./publisher --force-install [config.json]   # accepted but currently has no effect
```

Without arguments, the server looks for `publisher_config.json` in the current directory. If the config file does not exist, it is created with default values and the server stops.

At startup, the server writes a `{config}.run` file (e.g. `publisher_config.json.run`) containing the **effective** configuration actually in use — notably `logs_level`, which may differ from the config file if `--logslevel` was passed as an argument.
