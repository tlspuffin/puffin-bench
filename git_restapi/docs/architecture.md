# git_restapi — Architecture

## Purpose

`git_restapi` is a lightweight, read-only HTTP server that exposes Git repository data as structured JSON over a REST API. It allows external tools (dashboards, CI visualizers) to query commit history and commit metadata without requiring direct Git access.

## High-Level Architecture

The application is a three-layer stack:

```
main.cxx
  └── Config
        ├── ns_Server::MyServerApp          (Poco-based HTTP server)
        │     └── RequestHandlerFactory     (URL / method routing)
        │           ├── RequestHandlerCORSOptions  OPTIONS (any path)
        │           ├── RequestHandlerHistory       GET /api/git/history/:repo
        │           ├── RequestHandlerLog            GET /api/git/log/:repo?commit=...
        │           └── RequestHandlerLogs           POST /api/git/logs/:repo
        └── ns_API::APIS
              └── unordered_map<name, ns_GIT::GitAPI>
                    ├── GitAPI::History()   → runs tlspuffin_history.sh (+ optional GitHub PR fetch)
                    └── GitAPI::Logs()      → runs git log / git merge-base via popen()
```

## Layers

### Entry Point (`main.cxx`)

- Enables all log levels (`logs.SetLevel({1,1,1,1})`) before anything else, so problems during config parsing are visible even if `logs_level` ends up disabling them later.
- Parses command-line arguments: an optional positional config file path (default `git_restapi-config.json`), `--force-install`, `--only-install`, `--logslevel <N>`.
- Loads the JSON config file. If loading fails **and** the file does not exist, writes a default config to that path and exits (status 1). If the file exists but is malformed, the process does **not** abort — it silently falls back to default values for whatever couldn't be parsed and continues.
- Calls `Config::Validate(forceInstall)`, which creates storage/script directories and (re)installs the embedded `tlspuffin_history.sh` script.
- If `--only-install` was passed, returns immediately after `Validate()` — no repositories are cloned/fetched and the HTTP server never starts. This lets an operator bootstrap the script/directories without a reachable Git remote.
- Otherwise applies the effective log level (`--logslevel` override, or `logs_level` from the config) and writes a resolved runtime snapshot to `<configfile>.run`.
- Calls `Poco::Net::initializeSSL()` (needed both for the optional HTTPS server socket and for the outbound GitHub API client), then constructs `ns_API::APIS` and `ns_Server::MyServerApp` and runs the server.
- A `std::runtime_error` thrown anywhere during startup (e.g. a repository that can't be fetched/cloned) is caught, logged, and turns into exit status 1.

There is no per-process temp directory and no cleanup-on-exit step — all storage/script paths come from the config (with relative defaults, see [configuration.md](configuration.md)).

### Configuration Layer (`config.hxx` / `config.cxx`)

Top-level `Config` struct aggregates:
- `logsLevel_` (`uint`) — bitmask controlling log verbosity.
- `server_` (`ns_Server::Config`) — HTTP server settings.
- `git_` (`ns_GIT::Config`) — Git storage and repository list.

All config types implement symmetric `Load(name, doc)` / `Save(name, doc, alloc)` methods for round-trip JSON serialization.

### Server Layer (`server/`)

`ns_Server::MyServerApp` extends `Poco::Util::ServerApplication`. Depending on `config_.secure_`, it opens either a plain `Poco::Net::ServerSocket` or a `Poco::Net::SecureServerSocket` (TLS, `VERIFY_NONE`), then starts a `Poco::Net::HTTPServer` backed by `RequestHandlerFactory`.

`RequestHandlerFactory` picks a handler based on HTTP method first, then URI:
- Any `OPTIONS` request (regardless of path) → `RequestHandlerCORSOptions`.
- `GET` requests are matched against the `history` and `log` `std::regex` patterns.
- `POST` requests are matched against the `logs` pattern.
- `PATCH`/`PUT`/`DELETE` are recognized but have no handler wired up (fall through to 404).
- No match, or a `std::runtime_error` raised while matching/constructing → `RequestHandlerError` (404).

See [api.md](api.md) for the routing table.

All request handlers:
- Are generated via the `REQUESTHANDLER(name, ...)` macro, which stores handler arguments in a `std::tuple`.
- Call the shared `ManageCORS()` free function first; for `history`/`log`/`logs` handlers this only adds CORS response headers (the actual OPTIONS short-circuit is handled earlier, at the factory level, by the dedicated `RequestHandlerCORSOptions`).
- Return `Content-Type: application/json; charset=utf-8` with chunked transfer encoding.

`ns_Server::PartsHandler` (multipart/form-data parsing) is compiled in but not used by any handler here — it's shared infrastructure also used by the scheduler module.

### API Bridge Layer (`api/`)

`ns_API::APIS` owns an `unordered_map<string, ns_GIT::GitAPI>` keyed by repository name. Its constructor iterates `configGit.repositories_` and constructs each `GitAPI` in-place with `try_emplace`, which triggers an immediate `git fetch`/`git clone` for every configured repository, synchronously, before the HTTP server starts.

### Git Backend (`git/`)

`ns_GIT::GitAPI` is the core Git interface, one instance per configured repository:

- **Constructor** — Takes the resolved `Config`, the repository name, and a `url`/`url_pr` parameter map. Runs `git fetch --all`, falling back to `git clone --filter=blob:none <url>` on first use (via `popen()`, output captured for the error message). Throws `std::runtime_error` on failure. If `url_pr` is present, initializes an `HTTPSClient` pointed at that host and reloads any cached GitHub rate-limit state from `pr_infos_cache.json`. Also reloads a persisted history result from `git_cache.json` if present and valid, using the file's mtime to seed the in-memory cache's age.
- **`History(result, refresh)`** — Acquires the per-instance `std::shared_mutex`, runs `tlspuffin_history.sh` via `std::system()` (unless `refresh == None` and the in-memory cache is still fresh), reads the script's output, optionally merges in GitHub PR data, persists the merged result to `git_cache.json`, and updates the in-memory cache.
- **`Logs(commitIDs, result)`** — Acquires the same mutex (shared, since it only reads), runs `git log --no-walk --pretty=tformat:"%H%x1F%ad%x1F%s"` via `popen()`, and for **each** requested commit also runs a separate `git merge-base <id> origin/dev` to attach a `base` field.

## Data Flows

### Startup

```
main()
  → logs.SetLevel({1,1,1,1})
  → Config::Load()
  → Config::Validate(forceInstall)
      → ns_Server::Config::Validate()   # canonicalize TLS paths (only if secure_)
      → ns_GIT::Config::Validate()      # create storage/scripts dirs, extract script
  → [if --only-install: exit here]
  → apply effective log level, save <configfile>.run
  → Poco::Net::initializeSSL()
  → ns_API::APIS(config.git_)
      → for each repo: GitAPI(config, name, parameters)
          → git fetch --all || git clone --filter=blob:none
          → reload git_cache.json / pr_infos_cache.json if present
  → ns_Server::MyServerApp::main()
      → Poco::Net::HTTPServer::start()
      → waitForTerminationRequest()
```

### GET /api/git/history/:repo

```
HTTP GET
  → RequestHandlerHistory(repoName, fullURI)
  → ManageCORS() (adds headers)
  → parse query string with Poco::URI
      → any key other than "refresh" → HTTP 400
      → refresh=local → ERefresh::Local, refresh=all → ERefresh::All, absent/other → ERefresh::None
  → 404 if repoName unknown
  → GitAPI::History(buffer, refresh)
      → refresh==None and in-memory cache <24h old → return cached buffer, done
      → else: std::system("tlspuffin_history.sh tlspuffin_history_cache.json --no-standalone <repo>")
          → read script output
          → if url_pr configured: ManageExternalPR() (see below)
          → write merged result to git_cache.json, update in-memory cache
  → write buffer to HTTP response (Cache-Control: no-store, no-cache, must-revalidate; Pragma: no-cache)
```

`ManageExternalPR`: reuses the cached `pr_cache.json` unless `refresh==All`; even with `refresh==All` it still falls back to cache if the last known GitHub rate-limit state says the quota is exhausted and not yet reset. Otherwise it pages through the GitHub pulls API (following `Link: rel="next"` headers), rewrites each PR object's fields, and persists both `pr_cache.json` (the PR array) and `pr_infos_cache.json` (rate-limit reset timestamp + remaining calls).

### GET /api/git/log/:repo?commit=HASH

```
HTTP GET
  → RequestHandlerLog(repoName, commitID)
  → ManageCORS()
  → 404 if repoName unknown
  → GitAPI::Logs({commitID}, buffer)
      → popen("git log --no-walk --pretty=tformat:'%H\x1F%ad\x1F%s' <hash>")
      → for the commit: popen("git merge-base <hash> origin/dev") → base field
      → build {"commits":[{"id","date","comment","base"}]} JSON
  → write buffer to HTTP response
```

### POST /api/git/logs/:repo

```
HTTP POST  body: {"commits":["abc","def",...]}
  → RequestHandlerLogs(repoName)
  → ManageCORS()
  → StreamCopier::copyToString(body)
  → RapidJSON parse body; validate "commits" is an array of [0-9a-fA-F]+ strings (400 otherwise)
  → 404 if repoName unknown
  → GitAPI::Logs(commitIDs, buffer)   # same per-commit merge-base lookup as above
  → write buffer to HTTP response
```

## Embedded Resources

`tlspuffin_history.sh` is compiled into the binary as a C string literal via `CMakeTextEmbedding.cmake`. At startup, `ns_GIT::Config::Validate()` extracts it to `scriptsPath_` if missing or if `--force-install` was passed, making the binary fully self-contained.

## External Dependencies

| Dependency | How Used |
|---|---|
| **Poco** (1.14.2) | HTTP server, TLS sockets (server + outbound GitHub client), URI parsing, `ServerApplication` |
| **RapidJSON** (1.1.0) | All JSON parsing and serialization |
| **OpenSSL** | Transitively via Poco TLS |
| **git** (CLI) | All Git operations via `popen()` / `std::system()` |
| **jq** (CLI) | Used inside `tlspuffin_history.sh` |
| **bash** | Required to run `tlspuffin_history.sh` |

## Design Notes

**No libgit2** — All Git operations are delegated to CLI subprocesses. This simplifies the build and avoids a heavy C dependency, at the cost of subprocess overhead and shell-injection risk if inputs are not validated (commit IDs are validated against `[0-9a-fA-F]+`; repo names against `[0-9a-zA-Z-_.%]+`).

**Startup-time repository initialization** — All repositories are cloned/fetched synchronously before the server starts. There is no lazy or background initialization. A failure on any repo aborts startup (unless `--only-install` is used, which skips repository initialization entirely).

**Per-repo, two-tier history cache** — `GitAPI::History()` keeps a 24-hour in-memory cache (`historyBuffer_`/`historyBufferTS_`, guarded by the per-instance `std::shared_mutex`) plus a matching on-disk copy (`<storage>/<name>/git_cache.json`) reloaded at process startup. `?refresh=local` regenerates history but reuses cached GitHub PR data; `?refresh=all` additionally forces a fresh GitHub API call unless the last known quota is exhausted.

**Per-commit `git merge-base` calls** — `GitAPI::Logs()` issues one extra `git merge-base <id> origin/dev` subprocess per requested commit ID (in addition to the batched `git log`). For `POST /api/git/logs` with a large commit list this means N+1 subprocess invocations for N commits.

**Macro-generated handler classes** — `REQUESTHANDLER(name, ...)` generates concrete handler classes storing their arguments in a `std::tuple`, avoiding virtual-function dispatch overhead while keeping the factory interface uniform.

**No static file / HTML serving** — the server only exposes the three JSON API endpoints; there is no HTML root or static asset handler.
