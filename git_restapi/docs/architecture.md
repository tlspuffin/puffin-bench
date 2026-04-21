# git_restapi — Architecture

## Purpose

`git_restapi` is a lightweight, read-only HTTP server that exposes Git repository data as structured JSON over a REST API. It allows external tools (dashboards, CI visualizers) to query commit history and commit metadata without requiring direct Git access.

## High-Level Architecture

The application is a three-layer stack:

```
main.cxx
  └── Config
        ├── ns_Server::MyServerApp          (Poco-based HTTP server)
        │     └── RequestHandlerFactory     (URL routing)
        │           ├── RequestHandlerHistory   GET /api/git/history/:repo
        │           ├── RequestHandlerLog       GET /api/git/log/:repo?commit=...
        │           └── RequestHandlerLogs      POST /api/git/logs/:repo
        └── ns_API::APIS
              └── unordered_map<name, ns_GIT::GitAPI>
                    ├── GitAPI::History()   → runs tlspuffin_history.sh
                    └── GitAPI::Logs()      → runs git log via popen()
```

## Layers

### Entry Point (`main.cxx`)

- Parses command-line arguments: config file path (default `git_restapi-config.json`), `--install`, `--logslevel <N>`.
- Creates a per-process temporary directory under `/tmp/<progname>-<pid>`.
- Loads the JSON config file; writes a default one and exits if absent.
- Calls `Config::Validate()` to install embedded scripts to disk.
- Saves a diagnostic runtime snapshot of the config as `<configfile>.run`.
- Registers `CleanTMP` as a termination callback to delete the temp directory on exit.
- Constructs `ns_API::APIS` and `ns_Server::MyServerApp`, then runs the server.

### Configuration Layer (`config.hxx` / `config.cxx`)

Top-level `Config` struct aggregates:
- `logsLevel_` (`uint`) — bitmask controlling log verbosity.
- `server_` (`ns_Server::Config`) — HTTP server settings.
- `git_` (`ns_GIT::Config`) — Git storage and repository list.

All config types implement symmetric `Load(name, doc)` / `Save(name, doc, alloc)` methods for round-trip JSON serialization.

### Server Layer (`server/`)

`ns_Server::MyServerApp` extends `Poco::Util::ServerApplication`. Depending on `config_.secure_`, it opens either a plain `Poco::Net::ServerSocket` or a `Poco::Net::SecureServerSocket` (TLS, `VERIFY_NONE`), then starts a `Poco::Net::HTTPServer` backed by `RequestHandlerFactory`.

`RequestHandlerFactory` routes incoming requests by matching the URI path against three compile-time `std::regex` patterns (see [api.md](api.md)).

All request handlers:
- Are generated via the `REQUESTHANDLER(name, ...)` macro, which stores handler arguments in a `std::tuple`.
- Handle CORS preflight (`OPTIONS`) requests at the top of every `handleRequest()` via a shared `ManageCORS()` free function.
- Return `Content-Type: application/json; charset=utf-8` with chunked transfer encoding.

### API Bridge Layer (`api/`)

`ns_API::APIS` owns an `unordered_map<string, ns_GIT::GitAPI>` keyed by repository name. Its constructor iterates `configGit.repositories_` and constructs each `GitAPI` in-place (which triggers an immediate `git fetch` or `git clone`).

### Git Backend (`git/`)

`ns_GIT::GitAPI` is the core Git interface:

- **Constructor** — Runs `git fetch --all` on the local clone, falling back to `git clone --filter=blob:none` on first use. Throws `std::runtime_error` on failure; all repos must be reachable at startup.
- **`History(result)`** — Acquires a per-instance mutex, runs `tlspuffin_history.sh` via `std::system()`, reads the output JSON file into `result`.
- **`Logs(commitIDs, result)`** — Acquires the same mutex, runs `git log --oneline --no-walk --pretty=format:"%h§%ad§%s"` via `popen()`, parses `§`-separated lines, and returns a `{"commits":[...]}` JSON string.

A per-`GitAPI` `std::mutex` serializes all subprocess calls for a given repository.

## Data Flows

### Startup

```
main()
  → Config::Load()
  → Config::Validate()
      → ns_GIT::Config::Validate()     # create storage dirs, extract script
  → ns_API::APIS(config.git_)
      → for each repo: GitAPI(config, name, url)
          → git fetch --all || git clone --filter=blob:none
  → ns_Server::MyServerApp::main()
      → Poco::Net::HTTPServer::start()
      → waitForTerminationRequest()
  → CleanTMP() on exit
```

### GET /api/git/history/:repo

```
HTTP GET
  → RequestHandlerHistory(repoName, fullURI)
  → ManageCORS()
  → parse optional ?branches= query parameter (validated but not forwarded)
  → check per-repo 10-minute cache (historyBuffer_ in GitAPI, ignoreCache=false)
  → if stale:
      GitAPI::History(buffer, ignoreCache=false)
        → std::system("tlspuffin_history.sh git_cache.json --no-standalone <repo>")
        → read git_cache.json into buffer
        → store result in historyBuffer_
  → write buffer to HTTP response
```

### GET /api/git/log/:repo?commit=HASH

```
HTTP GET
  → RequestHandlerLog(repoName, commitID)
  → ManageCORS()
  → GitAPI::Logs({commitID}, buffer)
      → popen("git log --oneline --no-walk --pretty=format:'%h§%ad§%s' <hash>")
      → parse § fields → build {"commits":[...]} JSON
  → write buffer to HTTP response
```

### POST /api/git/logs/:repo

```
HTTP POST  body: {"commits":["abc","def",...]}
  → RequestHandlerLogs(repoName)
  → ManageCORS()
  → StreamCopier::copyToString(body)
  → RapidJSON parse body
  → validate each commit ID against [0-9a-fA-F]+
  → GitAPI::Logs(commitIDs, buffer)
  → write buffer to HTTP response
```

## Embedded Resources

`tlspuffin_history.sh` is compiled into the binary as a C string literal via `CMakeTextEmbedding.cmake`. At startup, `ns_GIT::Config::Validate()` extracts it to `scriptsPath_` if missing or if `--install` was passed, making the binary fully self-contained.

## External Dependencies

| Dependency | How Used |
|---|---|
| **Poco** (1.14.2) | HTTP server, TLS sockets, URI parsing, `ServerApplication` |
| **RapidJSON** (1.1.0) | All JSON parsing and serialization |
| **OpenSSL** | Transitively via Poco TLS |
| **git** (CLI) | All Git operations via `popen()` / `std::system()` |
| **jq** (CLI) | Used inside `tlspuffin_history.sh` |
| **bash** | Required to run `tlspuffin_history.sh` |

## Design Notes

**No libgit2** — All Git operations are delegated to CLI subprocesses. This simplifies the build and avoids a heavy C dependency, at the cost of subprocess overhead and shell-injection risk if inputs are not validated (commit IDs are validated against `[0-9a-fA-F]+`; repo names against `[0-9a-zA-Z-_.]+`).

**Startup-time repository initialization** — All repositories are cloned/fetched synchronously before the server starts. There is no lazy or background initialization. A failure on any repo aborts startup.

**Per-repo in-process cache** — `GitAPI::History()` caches the last history result in `historyBuffer_` with a 10-minute TTL, protected by the per-instance `lock_`. The cache is per-repo (one `GitAPI` per configured repository) and can be bypassed with `ignoreCache=true`. The `?branches=` parameter is parsed and validated in `RequestHandlerHistory` but is not forwarded to the history script and has no effect on the cached result.

**Macro-generated handler classes** — `REQUESTHANDLER(name, ...)` generates concrete handler classes storing their arguments in a `std::tuple`, avoiding virtual-function dispatch overhead while keeping the factory interface uniform.
