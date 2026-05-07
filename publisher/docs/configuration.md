# restsrv.publisher — Configuration Reference

## Config File

Default filename: `publisher_config.json` (overridable via the first positional command-line argument).

If the file does not exist at startup, a default configuration is written to disk and the process exits. Inspect and edit the file, then restart.

A runtime snapshot of the effective configuration is saved as `{configfile}.run` (e.g. `publisher_config.json.run`) on each startup. This file reflects the exact parameters in use — including any `--logslevel` override — and is useful for diagnostics.

## Command-Line Arguments

| Argument | Description |
|---|---|
| `<config-file>` | Path to the JSON config file. Default: `publisher_config.json`. |
| `--install` | Force-reinstall all embedded web files into `htmlPath/publisher/`, then exit without starting the server. |
| `--force-install` | Force-reinstall all embedded web files into `htmlPath/publisher/`, then continue normal startup. |
| `--logslevel <N>` | Override the log level bitmask at runtime (see `logs_level` below). |

## Top-Level Keys

```json
{
  "logs_level": 15,
  "server": { ... },
  "publisher": { ... }
}
```

| Key | Type | Default | Description |
|---|---|---|---|
| `logs_level` | int | `15` | Bitmask: `1`=error, `2`=warning, `4`=info, `8`=debug. `15` enables all levels. |

---

## `server` Section

```json
"server": {
  "port": 8081,
  "secure": false,
  "key":  "security/site.key",
  "cert": "security/site.pem",
  "CA":   "security/CA.pem"
}
```

| Key | Type | Default (plain) | Default (TLS) | Description |
|---|---|---|---|---|
| `port` | uint16 | `8081` | `8443` | TCP port to listen on. |
| `secure` | bool | `false` | — | Enable TLS. When `true`, `key`, `cert`, and `CA` are required. |
| `key` | path | `security/site.key` | same | Server private key (PEM). Required when `secure: true`. |
| `cert` | path | `security/site.pem` | same | Server certificate (PEM). Required when `secure: true`. |
| `CA` | path | `security/CA.pem` | same | CA bundle (PEM). Required when `secure: true`. |

All paths are resolved with `std::filesystem::canonical()` at startup. Missing TLS paths cause startup to fail.

TLS uses `VERIFY_NONE` (client certificate verification is disabled).

---

## `publisher` Section

```json
"publisher": {
  "storagePath": "data",
  "htmlPath": "html",
  "orphanScanInterval": 3600
}
```

| Key | Type | Default | Description |
|---|---|---|---|
| `storagePath` | path | `"data"` | Root directory containing project subdirectories and archives. Each project is a subdirectory of this path. |
| `htmlPath` | path | `"html"` | Directory where embedded web files are written at startup. Files go into `htmlPath/publisher/`. |
| `orphanScanInterval` | uint64 | `3600` | Periodic background scan interval in seconds. Set to `0` to disable the periodic scanner. |

### `storagePath` structure

```
storagePath/
└── my_project/
    ├── .rules              ← rule engine configuration
    ├── .project/           ← created automatically
    │   ├── .index.json     ← internal processing cache (do not modify)
    │   └── <commitID>.json ← per-commit result files
    └── PR/
        └── <commitID>/
            └── ...         ← source archives
```

### `htmlPath` structure

```
htmlPath/
└── publisher/
    ├── summary_PR.html         ← main dashboard (overwritten by --force-install)
    ├── summary_PR.css / .js    ← styles and logic (overwritten by --force-install)
    ├── plotly-3.3.0.min.js     ← graphing library (overwritten by --force-install)
    └── summary_PR_config.js    ← external service URLs (written ONCE, never overwritten)
```

`summary_PR_config.js` must be edited directly to change the URLs of the three services the dashboard contacts (publisher, git REST API, scheduler/board). See `docs/user_guide.md` for the full format.

---

## Example: Minimal Configuration

```json
{
  "logs_level": 7,
  "server": {
    "port": 8081
  },
  "publisher": {
    "storagePath": "/var/lib/publisher/data",
    "htmlPath": "/var/lib/publisher/html"
  }
}
```

## Example: TLS Configuration

```json
{
  "logs_level": 7,
  "server": {
    "secure": true,
    "port": 8443,
    "key":  "/etc/ssl/private/server.key",
    "cert": "/etc/ssl/certs/server.pem",
    "CA":   "/etc/ssl/certs/ca-bundle.pem"
  },
  "publisher": {
    "storagePath": "/var/lib/publisher/data",
    "htmlPath":    "/var/lib/publisher/html",
    "orphanScanInterval": 1800
  }
}
```
