# git_restapi — Component Reference

## Source Layout

```
src/git_restapi/
├── main.cxx                        Entry point
├── config.hxx / config.cxx         Top-level configuration aggregate
├── server/
│   ├── config.hxx / config.cxx     HTTP server configuration
│   ├── server.hxx / server.cxx     Poco ServerApplication subclass
│   ├── request_handler_factory.hxx URL/method routing factory
│   ├── request_handler.hxx / .cxx  Base handler + concrete handler classes
│   └── parts_handler.hxx / .cxx    Multipart/form-data helper (shared infra, unused here)
├── api/
│   └── api.hxx / api.cxx           Repository map aggregator
├── git/
│   ├── config.hxx / config.cxx     Git storage and repository configuration
│   └── git_api.hxx / git_api.cxx   Core Git interface
└── (uses) src/utils/
    ├── dir.hxx / .cxx              Filesystem helpers (IsSubDir, DeleteFilesWithPrefix)
    ├── httpsclient.hxx / .cxx      Minimal Poco-based HTTPS GET client (used for GitHub API)
    ├── logs.hxx / .cxx             Thread-safe logging
    └── rapidjson.hxx / .cxx        Typed JSON access helpers + JSON file I/O

embeded/git_restapi/scripts/
└── tlspuffin_history_sh.h          Auto-generated at build time: script compiled into binary

scripts/
└── tlspuffin_history.sh            Bash script generating commit history JSON
```

---

## `Config` (`config.hxx` / `config.cxx`)

Top-level configuration aggregate. Holds:

| Field | Type | Description |
|---|---|---|
| `logsLevel_` | `uint` | Log verbosity bitmask; captured from the current `logs` singleton at construction, applied via `logs.SetLevel()` in `Validate()`. |
| `server_` | `ns_Server::Config` | HTTP server settings. |
| `git_` | `ns_GIT::Config` | Git backend settings. |

`Load(filepath)` returns `false` if the file is missing or not a valid JSON object (in which case an empty document is substituted and default values are used for `server_`/`git_`). `Validate(forceInstall)` delegates to `git_.Validate(forceInstall)`, `server_.Validate()`, and calls `logs.SetLevel(logsLevel_)`.

---

## `ns_Server::Config` (`server/config.hxx`)

| Field | Type | Default (plain) | Default (`secure: true`) |
|---|---|---|---|
| `port_` | `uint16_t` | `10081` | `8443` |
| `secure_` | `bool` | `false` | — |
| `key_` | `path` | `security/site.key` | same |
| `cert_` | `path` | `security/site.pem` | same |
| `CA_` | `path` | `security/CA.pem` | same |

There is no HTML/static-file root — this server only serves the JSON API endpoints. `key_`/`cert_`/`CA_` are only read from the config file when `secure: true`; `Validate()` calls `std::filesystem::canonical()` on all three paths (only when `secure_`) to verify they exist, throwing if not.

---

## `ns_Server::MyServerApp` (`server/server.hxx` / `server/server.cxx`)

Extends `Poco::Util::ServerApplication`.

`main()` behavior:
1. Opens a `Poco::Net::ServerSocket` (plain) or `Poco::Net::SecureServerSocket` (TLS, `VERIFY_NONE`) on the configured port.
2. Instantiates `Poco::Net::HTTPServer` with a `RequestHandlerFactory`.
3. Logs `"Server started on port <port>..."`.
4. Calls `waitForTerminationRequest()` — blocks until `SIGTERM` or `SIGINT`.
5. Stops the HTTP server and returns.

---

## `RequestHandlerFactory` (`server/request_handler_factory.hxx`)

Header-only implementation of `Poco::Net::HTTPRequestHandlerFactory`.

`createRequestHandler(request)`:
- Any `OPTIONS` request → `RequestHandlerCORSOptions`, regardless of path.
- `GET` requests are matched against the `history` then `log` `std::regex` patterns.
- `POST` requests are matched against the `logs` pattern.
- `PATCH`/`PUT`/`DELETE` are explicitly recognized but wired to nothing (handler stays `nullptr`).
- Falls through to `RequestHandlerError` (HTTP 404) on no match, or if a `std::runtime_error` is thrown while matching.
- Calls `handler->Configure(config_, apis_)` to inject dependencies before returning. Poco takes ownership of the heap-allocated handler.

Routing patterns (see [api.md](api.md) for the full table).

---

## `RequestHandler` and concrete handlers (`server/request_handler.hxx` / `.cxx`)

### Base class: `RequestHandler`

Extends `Poco::Net::HTTPRequestHandler`. Provides:
- `Configure(serverConfig, apis)` — dependency injection called by the factory.

### Free function: `ManageCORS(request, response)`

Sends `Access-Control-Allow-*` headers on every response. For `OPTIONS` requests it also sets HTTP 200 and sends the response immediately, returning `true` (used defensively inside each handler even though the factory already routes `OPTIONS` to `RequestHandlerCORSOptions` directly).

### Macro: `REQUESTHANDLER(name, ...)`

Generates a concrete handler class `RequestHandler<name>` with:
- A constructor accepting the listed argument types, stored in a `std::tuple`.
- A `handleRequest(request, response)` override (implemented manually in the `.cxx`).

This avoids virtual-function overhead while maintaining a uniform factory interface. Declared handlers: `Error`, `CORSOptions`, `History(repo, fullURI)`, `Log(repo, commitID)`, `Logs(repo)`.

### `RequestHandlerError`

Returns HTTP 404 with a plain-text body containing the unmatched URI.

### `RequestHandlerCORSOptions`

Calls `ManageCORS()` and nothing else — the entire OPTIONS preflight response.

### `RequestHandlerHistory(repoName, fullURI)`

1. `ManageCORS()`.
2. Sets chunked JSON content type plus `Cache-Control: no-store, no-cache, must-revalidate` and `Pragma: no-cache`.
3. Parses `fullURI`'s query string with `Poco::URI`. Any key other than `refresh` → HTTP 400. `refresh=local`/`refresh=all` map to `GitAPI::ERefresh::Local`/`All`; anything else (including absent) → `ERefresh::None`.
4. 404 if `repoName` is not in `apis_->gitAPI_`.
5. Calls `GitAPI::History(buffer, refresh)`. 500 on failure.
6. Writes `buffer` to the response stream.

### `RequestHandlerLog(repoName, commitID)`

1. `ManageCORS()`.
2. Validates `repoName` exists in `apis_->gitAPI_` (404 otherwise).
3. Calls `apis_->gitAPI_.at(repoName).Logs({commitID}, buffer)`. 500 on failure.
4. Writes `buffer` to the response stream.

### `RequestHandlerLogs(repoName)`

1. `ManageCORS()`.
2. Reads the entire POST body via `Poco::StreamCopier::copyToString()`.
3. Parses the body as JSON with RapidJSON; requires a `commits` array of hex strings (400 otherwise).
4. Validates `repoName` exists (404 otherwise).
5. Calls `apis_->gitAPI_.at(repoName).Logs(commitIDs, buffer)`. 500 on failure.
6. Writes `buffer` to the response stream.

---

## `ns_Server::PartsHandler` (`server/parts_handler.hxx` / `.cxx`)

Extends `Poco::Net::PartHandler` for multipart/form-data parsing. Reads each part's `Content-Disposition` header (`name`, `filename`, `Content-Type`) and streams the body into a `std::vector<uint8_t>`. Results are stored in an `unordered_multimap<string, PartData>`.

Not used by any `git_restapi` request handler; it is shared infrastructure also present in the scheduler module and is compiled into this binary regardless.

---

## `ns_API::APIS` (`api/api.hxx` / `api/api.cxx`)

```cpp
struct APIS {
  std::unordered_map<std::string, ns_GIT::GitAPI> gitAPI_;
};
```

Constructor iterates `configGit.repositories_` (a `vector<pair<string, unordered_map<string,string>>>` of name → `{url[, url_pr]}`) and uses `try_emplace` to construct each `GitAPI` in-place, which triggers that repository's initial `fetch`/`clone`.

---

## `ns_GIT::Config` (`git/config.hxx` / `git/config.cxx`)

| Field | Type | Default | JSON key |
|---|---|---|---|
| `scriptsPath_` | `path` | `repo/.scripts` | `"scripts"` |
| `storage_` | `path` | `repo` | `"storage"` |
| `repositories_` | `vector<pair<string, unordered_map<string,string>>>` | `[]` | `"repositories"` |

Both defaults are **relative paths**, resolved against the process's current working directory — there is no per-process temp directory involved.

`Validate(forceInstall)`:
1. Canonicalizes `storage_` (must already exist).
2. If `scriptsPath_` is a subdirectory of `storage_` (`IsSubDir()`), creates it with `create_directories()`; otherwise canonicalizes it (must already exist).
3. Creates a `storage_ / <name>` directory for each configured repository (throws `std::runtime_error` if that fails for a reason other than "already exists").
4. If `tlspuffin_history.sh` is missing in `scriptsPath_`, or `forceInstall` is true: extracts `TLSPuffinHistory_Script_data[]` from the compiled-in blob and writes it with permissions `rwxr-x---`.

---

## `ns_GIT::GitAPI` (`git/git_api.hxx` / `git/git_api.cxx`)

The core Git interface. One instance per configured repository.

### Constructor

```cpp
GitAPI(ns_GIT::Config const config, std::string const& name,
    std::unordered_map<std::string, std::string> const& parameters)
```

Sets `directory_ = config.storage_ / name` and `scriptsPath_ = config.scriptsPath_`.

Runs (via `popen()`, output captured for diagnostics):
```sh
git -C "<directory_>/repo" fetch --all >/dev/null 2>&1 \
  || git clone --filter=blob:none <parameters["url"]> "<directory_>/repo"
```
Throws `std::runtime_error` on failure.

If `parameters` contains `url_pr`: parses it with `Poco::URI`, points an `HTTPSClient` at its host/port, remembers its path+query as `prURLPath_`, and reloads `<directory_>/pr_infos_cache.json` (rate-limit reset timestamp + remaining calls) if present.

If `<directory_>/git_cache.json` exists and parses as valid JSON, it is loaded into `historyBuffer_`; `historyBufferTS_` is backdated using the file's `last_write_time()` so the 24-hour freshness check behaves correctly across restarts. A corrupt cache file is deleted.

### `enum ERefresh { None, Local, All }`

Passed to `History()` to control cache bypass — see [api.md](api.md) and [architecture.md](architecture.md).

### `bool History(std::string& result, ERefresh refresh)`

- If `refresh == None`: takes a shared lock and returns the in-memory cache directly if it's non-empty and under 24 hours old.
- Otherwise (or on a cold/expired cache): takes an exclusive lock and runs, via `std::system()`:
  ```sh
  <scriptsPath_>/tlspuffin_history.sh <directory_>/tlspuffin_history_cache.json \
    --no-standalone "<directory_>/repo" 1>/dev/null
  ```
- Reads and parses that output file.
- If `url_pr` was configured, calls `ManageExternalPR()` to merge in PR data (see below); its result replaces `result`.
- Persists the final `result` to `<directory_>/git_cache.json` and updates `historyBuffer_`/`historyBufferTS_`.
- Returns `false` (with a human-readable message in `result`) on subprocess failure, I/O error, or JSON-parse error.

### `bool ManageExternalPR(rapidjson::Document& json, std::string& result, ERefresh refresh)` (private)

- Uses the cached `<directory_>/pr_cache.json` array unless `refresh == All`, or unless the cached rate-limit state (`apiResetTS_`, `apiRemaining_`) shows the quota is currently exhausted (in which case it also falls back to cache).
- Otherwise pages through the GitHub REST pulls API via `HTTPSClient::Get()`, following the `Link: rel="next"` header, capturing `x-ratelimit-reset`/`x-ratelimit-remaining` from each response.
- Per PR object: keeps only `{title, number, id, created_at, updated_at, head, base, state}`, then renames/reshapes: `id`→`idPR`, `title`→`comment`, `created_at` truncated to date →`date`, `head.sha`→`id`, `head.ref`→`branch`, `base.sha`→`base`, `base.ref`→`base_ref`.
- Persists the resulting array to `pr_cache.json` and the rate-limit counters to `pr_infos_cache.json`.
- Adds `PR` and `PR_API_Infos` members to `json`, then serializes it (pretty-printed) into `result`.
- Returns `false` if the very first page request fails, or if any page's response is not a JSON array.

### `bool Logs(std::vector<std::string> commitIDs, std::string& result)`

- Returns `{"commits":[]}` immediately if `commitIDs` is empty (no subprocess run).
- Takes a shared lock, then runs:
  ```sh
  git -C <directory_>/repo log --oneline --no-walk \
    --pretty=tformat:"%H\x1F%ad\x1F%s" --date=short <id1> <id2> ... 2>&1
  ```
  via `popen()`, parsing each line on the `\x1F` (unit separator) delimiter into `(hash, date, subject)`.
- For **each** parsed commit, additionally runs `git -C <directory_>/repo merge-base <hash> origin/dev` and, if it succeeds, attaches a `base` field.
- Serializes with RapidJSON into `{"commits":[{"id","date","comment"[,"base"]},...]}`.
- Returns `false` on subprocess or parse failure.

### `bool SaveFile(std::string const& file, std::string const& content)` (private)

Trivial `ofstream` write helper used to persist `pr_infos_cache.json`.

---

## `tlspuffin_history.sh` (`scripts/tlspuffin_history.sh`)

Bash script; the primary history-generation engine. Invoked as:
```
tlspuffin_history.sh <output.json> [--no-standalone|<commit-folder>] <repo_dir>
```
`git_restapi` always passes `--no-standalone`.

Produces three top-level sections:

### `commits`

Commits on `origin/dev` (`--first-parent`) not in `origin/main`, plus a **pinned range** of `origin/main` commits between two hardcoded commit hashes (`3bc37034a^...0b44eed3b` at the time of writing) — this range does not move automatically and must be updated by hand in the script as the project progresses. For each commit, `alias` is set to the SHA of its second parent when the commit is diff-quiet identical to it (a merge whose result matches one parent exactly).

### `standalone`

Populated by iterating a "commit folder" of named directories, only when the script is **not** invoked with `--no-standalone`. Always `[]` in `git_restapi` responses since the server always passes that flag.

### `branches`

All remote-tracking branches not merged into `origin/main` or `origin/dev`. For each, reports the tip commit (`id`, `date`, `comment`) and the merge-base with `origin/dev` (falling back to `origin/main`) as `base`.

Uses `jq` for JSON manipulation in the `standalone` and `branches` sections; raw `awk`/`sed` for the `commits` section. Note: this is a different (and independent) data source from the GitHub `PR` array added by `GitAPI::ManageExternalPR()` in the C++ layer.

---

## Utility: `Logs` (`utils/logs.hxx` / `.cxx`)

Thread-safe logging infrastructure.

| Macro | Level bit | Prefix |
|---|---|---|
| `LOGA(...)` | always on, not masked | none |
| `LOGE(...)` | `1` (error) | `[X] ` |
| `LOGW(...)` | `2` (warning) | `/!\ ` |
| `LOGI(...)` | `4` (info) | none |
| `LOGD(...)` | `8` (debug) | `** ` |

Each `LogInstance` acquires its per-instance mutex on the first `<<` and releases it when `Log::Flags::End` is streamed, ensuring atomic log lines under concurrency. A global `extern Logs logs` instance is used throughout; its default level is `0` (nothing enabled) until `SetLevel()` is called.

---

## Utility: `httpsclient.hxx` / `.cxx`

`HTTPSClient` is a minimal wrapper around `Poco::Net::HTTPSClientSession` for simple GET requests (used exclusively to talk to the GitHub REST API for pull-request data). `Remote(site)` opens a session against `host:port`; `Get(path, result, headers)` sends the request with `Accept: application/vnd.github+json`, reads the body into `result`, and back-fills any header names already present as keys in the `headers` map. TLS verification uses `VERIFY_RELAXED`.

---

## Utility: `rapidjson.hxx` / `.cxx`

Typed helper templates wrapping RapidJSON member lookups:

| Function | Description |
|---|---|
| `GetOrDefault<T>(doc, key, default)` | Returns member value or `default` if absent/wrong type. |
| `Get<T>(doc, key)` | Returns member value; throws if absent. |
| `GetOrDefaultPath(doc, key, default)` | Like `GetOrDefault` for `std::filesystem::path` (weakly-canonicalizes the result). |
| `GetPath(doc, key)` | Like `Get` for `std::filesystem::path`. |
| `ReadJSONFile(file, doc)` / `SaveJSONFile(file, value, pretty)` | Load/save a `rapidjson::Document`/`Value` to/from a file, logging on failure instead of throwing. |

Also declares `ParseDurationToSeconds()` / `ParseDurationToMilliSeconds()` (`"1h"`, `"30m"`, etc.) — used by the scheduler module, not by `git_restapi`.

---

## Utility: `dir.hxx` / `.cxx`

| Function | Description |
|---|---|
| `IsSubDir(parentDir, subDir)` | Path-component comparison (no filesystem access) used by `ns_GIT::Config::Validate()` to decide whether `scriptsPath_` should be auto-created (if under `storage_`) or must already exist. |
| `DeleteFilesWithPrefix(files)` | Removes every regular file in `files.parent_path()` whose name starts with `files.filename()`. Not called anywhere in `git_restapi` itself. |
