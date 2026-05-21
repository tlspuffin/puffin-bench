# git_restapi — Component Reference

## Source Layout

```
src/git_restapi/
├── main.cxx                        Entry point
├── config.hxx / config.cxx         Top-level configuration aggregate
├── server/
│   ├── config.hxx / config.cxx     HTTP server configuration
│   ├── server.hxx / server.cxx     Poco ServerApplication subclass
│   ├── request_handler_factory.hxx URL routing factory
│   ├── request_handler.hxx / .cxx  Base handler + concrete handler classes
│   └── parts_handler.hxx / .cxx    Multipart/form-data helper (shared infra)
├── api/
│   └── api.hxx / api.cxx           Repository map aggregator
├── git/
│   ├── config.hxx / config.cxx     Git storage and repository configuration
│   └── git_api.hxx / git_api.cxx   Core Git interface
└── utils/
    ├── logs.hxx                    Thread-safe logging
    └── rapidjson.hxx               Typed JSON access helpers

src/embeded/git_restapi/
└── tlspuffin_history_sh.h          Auto-generated: script compiled into binary

scripts/
└── tlspuffin_history.sh            Bash script generating commit history JSON
```

---

## `Config` (`config.hxx` / `config.cxx`)

Top-level configuration aggregate. Holds:

| Field | Type | Description |
|---|---|---|
| `logsLevel_` | `uint` | Log verbosity bitmask; applied via `logs.SetLevel()` in `Validate()`. |
| `server_` | `ns_Server::Config` | HTTP server settings. |
| `git_` | `ns_GIT::Config` | Git backend settings. |

`Validate(forceInstall)` delegates to `git_.Validate()` and calls `logs.SetLevel(logsLevel_)`.

---

## `ns_Server::Config` (`server/config.hxx`)

| Field | Type | Default |
|---|---|---|
| `port_` | `uint16_t` | `8080` / `8443` (TLS) |
| `secure_` | `bool` | `false` |
| `key_` | `path` | `security/site.key` |
| `cert_` | `path` | `security/site.pem` |
| `CA_` | `path` | `security/CA.pem` |
| `html_` | `path` | `html` |

`Validate()` calls `std::filesystem::canonical()` on all paths to verify they exist.

---

## `ns_Server::MyServerApp` (`server/server.hxx` / `server/server.cxx`)

Extends `Poco::Util::ServerApplication`.

`main()` behavior:
1. Opens a `Poco::Net::ServerSocket` (plain) or `Poco::Net::SecureServerSocket` (TLS, `VERIFY_NONE`) on the configured port.
2. Instantiates `Poco::Net::HTTPServer` with a `RequestHandlerFactory`.
3. Calls `waitForTerminationRequest()` — blocks until `SIGTERM` or `SIGINT`.
4. Stops the HTTP server and returns.

---

## `RequestHandlerFactory` (`server/request_handler_factory.hxx`)

Header-only implementation of `Poco::Net::HTTPRequestHandlerFactory`.

`createRequestHandler(request)`:
- Matches `request.getURI()` against three compile-time `std::regex` patterns in order.
- Constructs and returns the appropriate handler (heap-allocated; Poco takes ownership).
- Falls through to `RequestHandlerError` (HTTP 404) on no match.
- Calls `handler->Configure(config_, apis_)` to inject dependencies before returning.

Routing patterns (see [api.md](api.md) for the full table).

---

## `RequestHandler` and concrete handlers (`server/request_handler.hxx` / `.cxx`)

### Base class: `RequestHandler`

Extends `Poco::Net::HTTPRequestHandler`. Provides:
- `Configure(serverConfig, apis)` — dependency injection called by the factory.
- `ManageCORS(request, response)` — sends the CORS preflight response and returns `true` for `OPTIONS` requests; adds CORS headers and returns `false` for all others.

### Macro: `REQUESTHANDLER(name, ...)`

Generates a concrete handler class `RequestHandler<name>` with:
- A constructor accepting the listed argument types, stored in a `std::tuple`.
- A `handleRequest(request, response)` override (implemented manually in the `.cxx`).

This avoids virtual-function overhead while maintaining a uniform factory interface.

### `RequestHandlerError`

Returns HTTP 404 with a plain-text body containing the unmatched URI.

### `RequestHandlerHistory(repoName, fullURI)`

1. Calls `ManageCORS()` — returns early for `OPTIONS`.
2. Parses `?branches=` from `fullURI` (CSV, validated but not forwarded to the script).
3. Rejects any other query parameter with HTTP 400.
4. Calls `GitAPI::History(buffer, ignoreCache=false)` which checks the per-repo 10-minute cache.
5. If stale: calls `apis_.gitAPI_.at(repoName).History(buffer)`.
6. Writes `buffer` to the response stream.

Cache is managed inside `GitAPI::History()` — see the Git Backend section for details.

### `RequestHandlerLog(repoName, commitID)`

1. Calls `ManageCORS()`.
2. Validates `repoName` exists in `apis_.gitAPI_`.
3. Calls `apis_.gitAPI_.at(repoName).Logs({commitID}, buffer)`.
4. Writes `buffer` to the response stream.

### `RequestHandlerLogs(repoName)`

1. Calls `ManageCORS()`.
2. Reads the entire POST body via `Poco::StreamCopier::copyToString()`.
3. Parses the body as JSON with RapidJSON.
4. Extracts `commits` array; validates each ID against `[0-9a-fA-F]+` (rejects with HTTP 400 on failure).
5. Calls `apis_.gitAPI_.at(repoName).Logs(commitIDs, buffer)`.
6. Writes `buffer` to the response stream.

---

## `ns_Server::PartsHandler` (`server/parts_handler.hxx` / `.cxx`)

Extends `Poco::Net::PartHandler` for multipart/form-data parsing. Reads each part's `Content-Disposition` header (`name`, `filename`, `Content-Type`) and streams the body into a `std::vector<uint8_t>`. Results are stored in an `unordered_multimap<string, PartData>`.

Not currently used by `git_restapi`; it is shared infrastructure also present in the scheduler module.

---

## `ns_API::APIS` (`api/api.hxx` / `api/api.cxx`)

```cpp
struct APIS {
  std::unordered_map<std::string, ns_GIT::GitAPI> gitAPI_;
};
```

Constructor iterates `configGit.repositories_` (a `vector<pair<string,string>>` of name→URL) and uses `try_emplace` to construct each `GitAPI` in-place.

---

## `ns_GIT::Config` (`git/config.hxx` / `git/config.cxx`)

| Field | Type | Default | JSON key |
|---|---|---|---|
| `scriptsPath_` | `path` | process temp dir | `"scripts"` |
| `storage_` | `path` | process temp dir | `"storage"` |
| `repositories_` | `vector<pair<string,string>>` | `[]` | `"repositories"` |

`Validate(forceInstall)`:
1. Canonicalizes `scriptsPath_` and `storage_`.
2. Creates `storage_ / name` subdirectories for each repository.
3. If `tlspuffin_history.sh` is missing in `scriptsPath_` or `forceInstall` is true: extracts `TLSPuffinHistory_Script_data[]` from the compiled-in blob and writes it with permissions `rwxr-x---`.

---

## `ns_GIT::GitAPI` (`git/git_api.hxx` / `git/git_api.cxx`)

The core Git interface. One instance per configured repository.

### Constructor

```cpp
GitAPI(const ns_GIT::Config& config, const std::string& name, const std::string& url)
```

Sets:
- `directory_ = config.storage_ / name`
- `scriptsPath_ = config.scriptsPath_`

Runs:
```sh
git -C "<directory_>/repo" fetch --all \
  || git clone --filter=blob:none <url> "<directory_>/repo"
```

Via `popen()`. Throws `std::runtime_error` on failure.

### `bool History(std::string& result)`

- Acquires `lock_` (per-instance `std::mutex`).
- Runs via `std::system()`:
  ```sh
  <scriptsPath_>/tlspuffin_history.sh \
    <directory_>/git_cache.json --no-standalone <directory_>/repo
  ```
- Reads `git_cache.json` into `result`.
- Returns `false` on process failure or I/O error.

### `bool Logs(std::vector<std::string> commitIDs, std::string& result)`

- Acquires `lock_`.
- Builds command:
  ```sh
  git -C <directory_>/repo log --oneline --no-walk \
    --pretty=format:"%H§%ad§%s" --date=short <id1> <id2> ...
  ```
- Runs via `popen()`.
- Parses each output line split on `§` into `(hash, date, subject)`.
- Serializes with RapidJSON into `{"commits":[{"id":"...","date":"...","comment":"..."},...]}`.
- Returns `false` on subprocess or parse failure.

---

## `tlspuffin_history.sh` (`scripts/tlspuffin_history.sh`)

Bash script; the primary history-generation engine. Invoked as:
```
tlspuffin_history.sh <output.json> [--no-standalone] <repo_dir>
```

Produces three sections:

### `commits`

Commits on `dev` not yet in `main`, plus a pinned range of `main` commits. For each commit, `alias` is set if the commit is diff-quiet identical to its second parent (i.e., a merge where the result matches one parent exactly).

### `standalone`

Commits found by iterating a "commit folder" of named directories. Always skipped in server mode (`--no-standalone`); `standalone` is always `[]` in API responses.

### `PR`

All remote-tracking branches not merged into `main` or `dev`. For each, reports the tip commit (`id`, `date`, `comment`) and the merge-base with `main` (`base`).

Uses `jq` for JSON manipulation in the `standalone` and `PR` sections; raw `awk`/`sed` for the `commits` section.

---

## Utility: `Logs` (`utils/logs.hxx`)

Thread-safe logging infrastructure.

| Macro | Level |
|---|---|
| `LOGE(...)` | Error |
| `LOGW(...)` | Warning |
| `LOGI(...)` | Info |
| `LOGD(...)` | Debug |
| `LOGA(...)` | Always (not masked) |

Each `Log` instance acquires its per-instance mutex on the first `<<` and releases it when `Log::Flags::End` is streamed, ensuring atomic log lines under concurrency. A global `extern Logs logs` instance is used throughout.

---

## Utility: `rapidjson.hxx` (`utils/rapidjson.hxx`)

Typed helper templates wrapping RapidJSON member lookups:

| Function | Description |
|---|---|
| `GetOrDefault<T>(doc, key, default)` | Returns member value or `default` if absent. |
| `Get<T>(doc, key)` | Returns member value; throws if absent. |
| `GetOrDefaultPath(doc, key, default)` | Like `GetOrDefault` for `std::filesystem::path`. |
| `GetPath(doc, key)` | Like `Get` for `std::filesystem::path`. |

Also declares `ParseDurationToSeconds()` and `ParseDurationToMilliSeconds()` (used by the scheduler module, not by `git_restapi`).
