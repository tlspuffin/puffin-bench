# git_restapi — Configuration Reference

## Config File

Default filename: `git_restapi-config.json` (overridable via the first positional command-line argument).

If the file does not exist at startup, a default configuration is written to disk and the process exits (status 1). Inspect and edit the file, then restart.

If the file **exists but cannot be parsed** (invalid JSON, or not a JSON object), the process logs `Config file <path> corrupted, exiting` and exits (status 1) without modifying the file on disk.

If the file exists and parses correctly, but resolves to **no usable repositories** — `git.repositories` missing, empty, not an object, or containing any entry with an invalid `name`/`url` — the process aborts immediately with an unhandled exception describing the specific problem (e.g. `Configuration error, no repositories configured`). This is a harder failure than the two cases above: it exits with a non-zero status but without the same clean `LOGA`-logged message, since a repository-less server has nothing to serve. All other individual fields (`server.secure`, `server.port`, `git.storage`, `git.scripts`, etc.) fall back silently to their documented defaults if missing or of the wrong type — only `git.repositories` is treated as mandatory.

A runtime snapshot of the fully-resolved configuration (with all defaults filled in, paths canonicalized, and the effective log level) is saved as `<configfile>.run` on each startup. This file is useful for diagnostics.

## Command-Line Arguments

| Argument | Description |
|---|---|
| `<config-file>` | Path to the JSON config file. Default: `git_restapi-config.json`. Any argument not starting with `-` is treated as this path. |
| `--force-install` | Force-reinstall the embedded `tlspuffin_history.sh` script even if it already exists on disk, then continue normal startup. |
| `--only-install` | Run configuration validation (create storage/script directories, install the script if needed) and then exit — no repositories are cloned/fetched and the HTTP server never starts. Combine with `--force-install` to force a reinstall without touching any repository. |
| `--logslevel <N>` | Override the log level bitmask at runtime (see `logs_level` below). Overrides the value in the config file for this run only (not persisted). |

There is no `--install` flag — earlier versions of this tool used that name; it has been split into `--force-install` and `--only-install`.

## Top-Level Keys

```json
{
  "logs_level": 15,
  "server": { ... },
  "git": { ... }
}
```

| Key | Type | Default | Description |
|---|---|---|---|
| `logs_level` | uint | `15` | Bitmask: `1`=error, `2`=warning, `4`=info, `8`=debug. `15` enables all levels. |

---

## `server` Section

```json
"server": {
  "secure": false,
  "port": 10081,
  "key":  "security/site.key",
  "cert": "security/site.pem",
  "CA":   "security/CA.pem"
}
```

| Key | Type | Default (plain) | Default (TLS) | Description |
|---|---|---|---|---|
| `secure` | bool | `false` | — | Enable TLS. When `true`, `key`, `cert`, and `CA` are read from this section (and required to exist). |
| `port` | uint16 | `10081` | `8443` | TCP port to listen on. |
| `key` | path | `security/site.key` | same | Path to the server private key (PEM). Only read/validated when `secure: true`. |
| `cert` | path | `security/site.pem` | same | Path to the server certificate (PEM). Only read/validated when `secure: true`. |
| `CA` | path | `security/CA.pem` | same | Path to the CA bundle (PEM). Only read/validated when `secure: true`. |

`key`/`cert`/`CA` paths are resolved with `std::filesystem::canonical()` at startup **only when `secure: true`** — a missing path then aborts startup. There is no `html` key and no static-file serving in this version: the server only exposes the JSON API endpoints.

TLS uses `VERIFY_NONE` (client certificate verification is disabled) on the server socket.

---

## `git` Section

```json
"git": {
  "storage": "repo",
  "scripts": "repo/.scripts",
  "repositories": {
    "myrepo": {
      "url": "https://github.com/org/repo.git"
    }
  }
}
```

| Key | Type | Default | Description |
|---|---|---|---|
| `storage` | path | `repo` (relative to CWD) | Directory where repositories are cloned. Each repository gets a `<name>/repo` subdirectory, plus its own cache files (see below). Must already exist — it is only canonicalized, not created. |
| `scripts` | path | `repo/.scripts` (relative to CWD) | Directory where the embedded script is installed. Auto-created if it resolves under `storage`; otherwise it must already exist. |
| `repositories` | object | *(none — mandatory)* | Map of repository name → object with `url` and optional fields. Must be present, be a JSON object, and contain at least one valid entry — otherwise the process aborts at startup (see below). |

### Repository Entry

```json
"<repo-name>": {
  "url":    "<git-remote-url>",
  "url_pr": "<github-api-pulls-url>"
}
```

| Key | Type | Required | Description |
|---|---|---|---|
| `url` | string | Yes | Any URL accepted by `git clone`. Supports HTTPS and SSH remotes. |
| `url_pr` | string | No | HTTPS URL of the GitHub REST API pull-requests endpoint (e.g. `https://api.github.com/repos/org/repo/pulls`). When present, `GET /api/git/history/:repo` responses include a `PR` field with open pull requests fetched from this endpoint, and a `PR_API_Infos` field with GitHub rate-limit metadata. PR results are cached in `<storage>/<name>/pr_cache.json`, and rate-limit state in `<storage>/<name>/pr_infos_cache.json`. |

Entries missing `url`, or whose name isn't a string, **abort startup** with an unhandled exception (`Configuration error, url attribute is invalide in repository <name>` / `Configuration error, name error in repositories`) — a single malformed entry takes down the whole server, even if the other configured repositories are valid. The repository name (`<repo-name>`) must match `[0-9a-zA-Z-_.%]+` to be reachable via the API; it becomes the `:repo` path segment in every endpoint.

### Per-Repository Files on Disk

Under `<storage>/<name>/`:

| File | Contents |
|---|---|
| `repo/` | The local clone (blobless: `--filter=blob:none`). |
| `git_cache.json` | Persisted 24h history cache (merged commits/branches/PR result), reloaded at startup. |
| `pr_cache.json` | Persisted GitHub PR list (raw array), only when `url_pr` is configured. |
| `pr_infos_cache.json` | Persisted GitHub rate-limit state (`<resetTS> <remaining>`), only when `url_pr` is configured. |

### Repository Initialization

At startup, for each configured repository, the server runs:

```
git -C <storage>/<name>/repo fetch --all
```

If that fails (e.g., first run — the directory does not exist yet), it falls back to:

```
git clone --filter=blob:none <url> <storage>/<name>/repo
```

`--filter=blob:none` performs a blobless clone: commit and tree objects are fetched immediately, but file contents are fetched lazily. This speeds up the initial clone for large repositories. If any repository fails to initialize, the server aborts startup — unless `--only-install` was passed, in which case repository initialization is skipped entirely.

### Script Installation

At startup, `ns_GIT::Config::Validate()` checks whether `tlspuffin_history.sh` exists in `scriptsPath_`. If it is missing, or `--force-install` was passed, the script is extracted from the compiled-in binary blob and written to disk with permissions `rwxr-x---`.

---

## Example: Minimal Configuration

```json
{
  "logs_level": 7,
  "server": {
    "port": 10081
  },
  "git": {
    "storage": "/var/lib/git_restapi",
    "repositories": {
      "tlspuffin": {
        "url":    "https://github.com/tlspuffin/tlspuffin.git",
        "url_pr": "https://api.github.com/repos/tlspuffin/tlspuffin/pulls"
      }
    }
  }
}
```

(`/var/lib/git_restapi` must exist beforehand; `scripts` defaults to `repo/.scripts` relative to the working directory unless overridden.)

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
  "git": {
    "storage": "/var/lib/git_restapi",
    "repositories": {
      "myrepo": {
        "url": "git@github.com:org/repo.git"
      }
    }
  }
}
```

## Example: `samples/gitapi/git_restapi-config.json`

The repository ships a working sample configuration, useful as a starting point:

```json
{
  "logs_level": 15,
  "server": {
    "secure": false,
    "key": "security/site.key",
    "cert": "security/site.pem",
    "CA": "security/CA.pem",
    "port": 10081
  },
  "git": {
    "storage": "../repo/tlspuffin",
    "scripts": "../repo/.scripts",
    "repositories": {
      "tlspuffin": {
        "url": "https://github.com/tlspuffin/tlspuffin.git",
        "url_pr": "https://api.github.com/repos/tlspuffin/tlspuffin/pulls"
      }
    }
  }
}
```
