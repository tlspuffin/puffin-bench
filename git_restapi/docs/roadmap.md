# git_restapi — Roadmap

Improvements identified from the current design. Items are independent unless noted.

---

## Replace subprocess Git calls with libgit2

**Current:** `GitAPI::History()` uses `std::system()`, and `GitAPI::Logs()` uses `popen()` — once for the batched `git log`, then **once more per commit** for `git merge-base <id> origin/dev`. All Git operations go through shell subprocesses.

**Problem:**
- Subprocess overhead on every `/api/git/log(s)` call, multiplied by the number of commits requested (see the dedicated item below).
- `tlspuffin_history.sh` requires `bash`, `git`, and `jq` to be installed and on `PATH` at runtime.
- The binary embeds and self-installs a shell script, which is a maintenance burden.
- Shell quoting must be audited carefully to avoid injection (commit IDs and repo paths appear in command strings).

**Improvement:** Replace with [libgit2](https://libgit2.org/). Commit log traversal (`Logs()`), branch enumeration, and merge-base computation (currently done partly in the shell script, partly via extra `popen()` calls) all have direct libgit2 equivalents. The script would be eliminated entirely, and `jq`/`bash` would no longer be runtime dependencies.

**Trade-off:** Adds a C library dependency and build complexity; the history logic in `tlspuffin_history.sh` would need to be rewritten in C++.

---

## `git merge-base` fan-out in `GitAPI::Logs()`

**Current:** For each commit ID passed to `GET /api/git/log` or `POST /api/git/logs`, `GitAPI::Logs()` spawns one `git log` (batched, once) plus one additional `git merge-base <id> origin/dev` subprocess **per commit**. A batch of N commits therefore costs N+1 subprocess invocations.

**Problem:** For large batches (dashboards commonly request dozens of commits at once), this scales linearly in process-spawn overhead and can dominate request latency.

**Improvement:** Compute all merge-bases in a single pass — either with one `git for-each-ref`/`git merge-base --octopus`-style batched invocation, or, longer-term, via libgit2 in-process. Alternatively, only compute `base` when the caller opts in (e.g. a query parameter), since not every consumer needs it.

---

## Background repository initialization

**Current:** All repositories are cloned or fetched synchronously in `APIS::APIS()` before the HTTP server starts. A failure on any single repository aborts the entire process (except when `--only-install` is used, which skips this step entirely).

**Problems:**
- On first run with multiple large repositories, startup can take minutes.
- A temporarily unreachable remote blocks startup completely.

**Improvement:** Initialize repositories asynchronously in background threads. The HTTP server starts immediately; endpoints for a given repo return HTTP 503 (or a structured "initializing" response) until that repo's clone/fetch completes. Per-repo errors should be reported without killing the whole process.

---

## TLS client verification

**Current:** The TLS socket is created with `VERIFY_NONE` — client certificates are never checked, even when `secure: true`.

**Improvement:** Make client verification configurable: `VERIFY_NONE` (current default), `VERIFY_RELAXED`, or `VERIFY_STRICT`. This matters if the API should be restricted to known clients (CI systems, internal dashboards) rather than open to any TLS connection.

---

## Hardcoded `main` commit range in `tlspuffin_history.sh`

**Current:** The `commits` section's `main`-branch range is pinned between two literal commit hashes inside the script (`3bc37034a^...0b44eed3b` at the time of writing), not derived from any tag, branch, or config value.

**Problem:** The range silently stops advancing as `main` moves forward; someone has to remember to bump the hashes by hand, and there is no validation that they're still meaningful (e.g. still ancestors of `main`).

**Improvement:** Either derive the range from something that moves automatically (e.g. "last N commits on `main`", or a config-driven tag/ref), or make the endpoints configurable per-repository instead of hardcoded in the script.

---

## Silent fallback on malformed config file

**Current:** `Config::Load()` only writes a default config and exits when the config file is **missing**. If the file exists but contains invalid JSON (or isn't a JSON object), the process logs an error but continues, using default values for whatever section failed to parse.

**Problem:** A typo in an existing config file can silently downgrade the server to defaults (wrong port, no repositories, etc.) instead of failing loudly, which is easy to miss in an automated deployment.

**Improvement:** Treat a malformed-but-present config file the same as a missing one (or otherwise fail fast) instead of silently falling back to defaults.

---

## Remove unused `PartsHandler` from this module

**Current:** `ns_Server::PartsHandler` is compiled into `git_restapi` but is never used by any of its request handlers. It exists here as shared infrastructure copy-pasted from the scheduler.

**Improvement:** Move `PartsHandler` to a shared static library consumed by both executables, and remove it from the `git_restapi`-specific source tree. This reduces the binary size and avoids diverging copies.

---

## Resolved since the previous revision of this document

- **Per-repo response cache** is now fully implemented and consistent: a 24-hour in-memory + on-disk (`git_cache.json`) cache per repository, explicitly bypassable via `?refresh=local`/`?refresh=all`. The previous dead `?branches=` query parameter (parsed but never forwarded to the script) has been removed entirely in favor of this `refresh` mechanism.
