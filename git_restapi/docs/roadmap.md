# git_restapi — Roadmap

Improvements identified from the current design. Items are independent unless noted.

---

## Replace subprocess Git calls with libgit2

**Current:** `GitAPI::History()` uses `std::system()` and `GitAPI::Logs()` uses `popen()`. All Git operations go through shell subprocesses.

**Problem:**
- Subprocess overhead on every `/api/git/log` call.
- `tlspuffin_history.sh` requires `bash`, `git`, and `jq` to be installed and on `PATH` at runtime.
- The binary embeds and self-installs a shell script, which is a maintenance burden.
- Shell quoting must be audited carefully to avoid injection (commit IDs and repo paths appear in command strings).

**Improvement:** Replace with [libgit2](https://libgit2.org/). Commit log traversal (`Logs()`), branch enumeration, and merge-base computation (currently done in the shell script) all have direct libgit2 equivalents. The script would be eliminated entirely, and `jq`/`bash` would no longer be runtime dependencies.

**Trade-off:** Adds a C library dependency and build complexity; the history logic in `tlspuffin_history.sh` would need to be rewritten in C++.

---

## Fix the response cache — partially done

**Done:** The cache is now per-repo, implemented directly in `GitAPI::History()` via `historyBuffer_` / `historyBufferTS_` with a 10-minute TTL, protected by the per-instance `lock_`. The `ignoreCache` flag allows bypassing it explicitly.

**Remaining:** The `?branches=` query parameter is parsed and validated in `RequestHandlerHistory` but is not forwarded to `tlspuffin_history.sh` and has no effect on the cached result.

**Improvement:**
- Either forward `branches` to `tlspuffin_history.sh` (requires script changes), or implement branch filtering in C++ on the cached JSON after fetching the full history.

---

## Background repository initialization

**Current:** All repositories are cloned or fetched synchronously in `APIS::APIS()` before the HTTP server starts. A failure on any single repository aborts the entire process.

**Problems:**
- On first run with multiple large repositories, startup can take minutes.
- A temporarily unreachable remote blocks startup completely.

**Improvement:** Initialize repositories asynchronously in background threads. The HTTP server starts immediately; endpoints for a given repo return HTTP 503 (or a structured "initializing" response) until that repo's clone/fetch completes. Per-repo errors should be reported without killing the whole process.

---

## TLS client verification

**Current:** The TLS socket is created with `VERIFY_NONE` — client certificates are never checked, even when `secure: true`.

**Improvement:** Make client verification configurable: `VERIFY_NONE` (current default), `VERIFY_RELAXED`, or `VERIFY_STRICT`. This matters if the API should be restricted to known clients (CI systems, internal dashboards) rather than open to any TLS connection.

---

## Remove unused `PartsHandler` from this module

**Current:** `ns_Server::PartsHandler` is compiled into `git_restapi` but is never used by any of its request handlers. It exists here as shared infrastructure copy-pasted from the scheduler.

**Improvement:** Move `PartsHandler` to a shared static library consumed by both executables, and remove it from the `git_restapi`-specific source tree. This reduces the binary size and avoids diverging copies.
