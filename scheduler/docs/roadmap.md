# Scheduler — Roadmap

Known weaknesses and planned improvements. Items are independent unless noted. No `TODO`/`FIXME`/`XXX` markers exist anywhere in `src/`, `scripts/`, or `html/` at the time of writing — every item below was found by reading the relevant code path, not by grepping comments.

---

## Crash recovery

**Current:** `TasksManager::LoadStatus()` and `Task`'s JSON-loading constructor (which rebuilds the full step DAG, including `next_`/`previous_`/`dependencies_`/`depend_from_` links) are fully implemented, along with `Executor::CheckReloadRunning()` / `Local::CheckReloadRunning()` to re-attach to still-running child processes. But the call site in `Schedule`'s constructor (`schedule.cxx`) is commented out, along with the code that would seed `steps_`/`stepsRunning_`/`stepsDone_` from it. A server restart still loses all in-flight task state — every restart starts from an empty `tasksmanager.json`.

**Improvement:** Re-enable the reload path. The main risk called out in-code is that "step group" (parallel `run` array) retry/rejoin bookkeeping was not validated against the reload path, so that needs re-verification before turning it back on.

---

## Scheduling loop lock granularity — improved, not fully resolved

**Current:** `ScheduleLoop()` no longer holds `lockThread_` for the entire iteration body. It now acquires the lock only around short state-mutation sections — step selection (`SearchTasksToRun`), `SaveStatus()`, and the cancel/finalize processing block at the end of the loop — and releases it during step dispatch (`step->Execute()`), the fixed 500 ms poll sleep, and finished-step reaping (`CheckFinishedSteps`). `AddTask()`, `CancelTask()`, `CancelStep()`, and `TaskUpdatePriority()` each take `lockThread_` only for their own short critical section, so HTTP calls no longer block for a full loop iteration.

**Remaining gap:** The loop still has a fixed 500 ms `sleep_for` between dispatch and reaping regardless of load, and `SearchTasksToRun()` / `SaveStatus()` still run serially inside the lock — under a very large `steps_` list this could still add up. No condition-variable-driven wake-up exists; the loop is still a fixed-interval poll.

---

## Authentication and authorization

**Current:** The REST API has no authentication mechanism — confirmed no `Authorization`/API-key/HMAC check anywhere in `server/`. Any process with network access can submit tasks, cancel jobs, change priority, or read output. CORS is wide open (`Access-Control-Allow-Origin: *`).

**Improvement:** Add at minimum a shared-secret header check or mTLS, advisable for any non-local deployment.

---

## `Archiver::WaitForCompletion()` busy-wait

**Current:** Still polls the job queue size with `sleep_for(100ms)` instead of waiting on the existing `queueCV_` condition variable — the condition variable is used for job intake in `ThreadLoop()` but not for signalling drain/completion.

**Improvement:** Track processed-vs-queued counts and notify `queueCV_` (or a dedicated CV) when the queue drains, replacing the poll loop.

---

## Archiving now shells out to `zip` via `popen()` instead of using libarchive

**Current:** This is a change since earlier revisions, not merely a documentation gap: `Archiver::ProcessJob()` (`schedule/archiver.cxx`) builds the result archive by constructing a shell command string (`cd <baseDir> ; zip -r <tmp path> <relative sources...>`) and running it through `popen()`. libarchive is linked and still used, but only for **reading** (`FileCompressed`, `archive_read_*`) when serving logs out of an already-archived task. The `zip` binary is therefore now a runtime dependency that is not fetched/pinned by CMake and not checked at startup — if it's missing, every task archive silently fails (`ProcessJob` returns `false`, logged as a warning, task JSON/logs/artefacts are left in the export directory unzipped).
Additionally, path components are concatenated into the shell command without quoting, so an export/base directory or task path containing a space or shell metacharacter would break (or, in a hypothetically more attacker-influenced deployment, be risky) — today the interpolated paths are numeric task IDs and fixed subdirectory names, so this is currently a robustness issue more than an active vulnerability, but it is fragile.

**Improvement:** Either check for `zip` at startup (fail fast with a clear error), quote the shell command's path arguments, or switch write-side archiving to libarchive's `archive_write_*` API to remove the external-process dependency and the shell-quoting concern entirely.

---

## `FileRing` — dead code

**Current:** `FileRing` (rotating file-based output buffer, `executor/output_ring.hxx`/`.cxx`) is fully implemented but never instantiated anywhere in the codebase — not in `Local::Execute()`, and not even in the standalone `testFilesRing` test binary (which, despite its name, exercises `FDCaptureThread` with `MemoryRing`). `MemoryRing` is the only `OutputBuffer` actually wired into `Local::Execute()` (via `config_.logsSize_`).

**Options:**
- Remove `FileRing` to reduce code surface.
- Wire it in as a fallback when `logsSize_` is very large and heap pressure is a concern (output persisted to disk continuously, survives server crash).

---

## Single executor backend

**Current:** The `Executor` abstraction is fully generic (`FindRunnableSteps`, `Execute`, `CheckFinishedSteps`, `Shutdown`, `GatherFilesToLocal`, `CheckReloadRunning`, stats/JSON hooks), and `Schedule` already supports a named map of executors with per-task `executor_name_` selection — but `Executor::Build()` (`executor/executor.cxx`) only handles `Config::Type::Local` and throws `"Unknown executor type"` for anything else. `Local` remains the only concrete backend.

**Improvement:** Implement remote execution (SSH, container, cluster) by fulfilling the full `Executor` interface and wiring a new `Config::Type` into `Executor::Build()` and `ns_Executor::Config::BuildConfig()`.

---

## Cache ID character set restriction

**Current:** Cache IDs are restricted to `[a-zA-Z0-9_-]+` by the HTTP routing regex (`regexCacheGet`/`regexCachePut` in `request_handler_factory.hxx`) for both `GET` and `PUT /api/cache/<id>`. IDs derived from hashes or paths with other characters (`.`, `/`) are silently rejected with a 404 from `RequestHandlerFactory`, rather than a proper 400 from `CacheAPI`/`Cache`.

**Improvement:** Either expand the allowed character set in the routing regex, or route to a handler that validates and rejects with HTTP 400 at the API level.

---

## Board launcher extension point has no in-repo example or fallback

**Current:** `html/board/launchers/launchers.js` unconditionally imports `./config.js` (for `config.projects`) at module top level, and `board.js` unconditionally imports `launchers.js`. Neither `launchers/config.js` nor any `launchers/<project>/joblauncher.js` exists anywhere in this repository or is installed by `Server::Config::Validate()` — the launcher menu is a pure per-deployment plugin point. On a fresh install (`--force-install` / `--only-install`) with no operator-supplied `config.js`, that ES module import fails to resolve, which fails the whole `launchers.js` module and, transitively, `board.js`'s import of it — the dashboard's module graph does not load at all until an operator supplies their own `launchers/config.js` and `launchers/<project>/joblauncher.js`.

**Improvement:** Ship a minimal example project, or make `board.js`'s import of `launchers.js` (and `launchers.js`'s import of `config.js`) tolerant of a missing config — e.g. a dynamic `import()` with a catch that renders an explicit "no launchers configured" empty state — so a fresh install's dashboard isn't broken out of the box.
