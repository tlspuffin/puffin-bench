# REST API — restsrv.publisher

## Endpoints

### `POST /api/notify`

Submits archives for asynchronous processing.

**Content-Type**: `multipart/form-data`

| Field | Type | Description |
|-------|------|-------------|
| `src` | string (repeatable) | Source filename(s), relative to `storagePath/dst` |
| `dst` | string | Destination project path (relative to `storagePath`) |

**Response**:
```json
{"success": true}
{"success": false, "error": "message"}
```

**Behaviour**: files are validated (existence, confinement within `storagePath`), then queued for processing by the publish thread. The response is immediate — processing is asynchronous.

---

### `GET /api/project/{name}/data`

Returns the list of processed JSON files for a project.

| Parameter | Description |
|-----------|-------------|
| `name` | Project name (alphanumeric, dashes, underscores) |

**Response**:
```json
{"success": true,  "files": ["<commitID>.json", "..."]}
{"success": false, "error": "message"}
```

Returned paths are relative to `storagePath/name/.project/`. They are accessible via `GET /files/`.

---

### `GET /files/{path}`

Downloads a file. Routing depends on the path:

- If `path` is exactly `{project_name}` or `{project_name}/{subdirectory}`, and the corresponding directory in `storagePath` contains a `.rules` file with an `index` field → served from `htmlPath/publisher/{index_value}`
- Otherwise → served from `storagePath`

Example: `GET /files/my_project` with a `.rules` containing `"index": "summary_PR.html"` serves `htmlPath/publisher/summary_PR.html`.

| Parameter | Description |
|-----------|-------------|
| `path` | Relative path (automatically routed to `storagePath` or `htmlPath`) |

- MIME type detected by extension (`.html`, `.css`, `.js`, `.json`, `.jpg`, `.png`, `.svg`).
- Returns **404** if the file does not exist.
- Path traversal protection: the canonical path must remain within the allowed directory.

---

### `GET /api/project/{name}/campaigns`

Returns the list of campaigns available for a project. Only populated when the project has archives processed by `RuleCampaignUseSummary`.

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
    "port": 8081,
    "secure": false,
    "key":  "security/site.key",
    "cert": "security/site.pem",
    "CA":   "security/CA.pem"
  },
  "publisher": {
    "storagePath": "data",
    "htmlPath": "/path/to/html",
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
| `publisher.htmlPath` | path | Web files directory — embedded files are written here at startup if absent |
| `publisher.orphanScanInterval` | uint64 | Periodic scan interval (seconds) |
| `logs_level` | int | Bitmask: error=1, warning=2, info=4, debug=8 |

See `docs/configuration.md` for the complete configuration reference.

---

## Starting the server

```bash
./publisher [publisher_config.json]
./publisher --install [config.json]         # force-reinstall all web files, then exit
./publisher --force-install [config.json]   # overwrite all web files in htmlPath, then start
```

Without arguments, the server looks for `publisher_config.json` in the current directory. If the config file does not exist, it is created with default values and the server stops.

At startup, the server writes a `{config}.run` file (e.g. `publisher_config.json.run`) containing the **effective** configuration actually in use — notably `logs_level`, which may differ from the config file if `--logslevel` was passed as an argument. This file can be used to inspect the exact parameters of the running process.
