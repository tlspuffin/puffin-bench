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

**Current:** The REST API has no authentication mechanism — confirmed no `Authorization`/API-key/HMAC check anywhere in `server/`. Any process with network access can submit tasks, cancel jobs, change priority or args, or read output. CORS is wide open (`Access-Control-Allow-Origin: *`).

Since `DELETE /api/task/<id>` also deletes an archived task's results (see "Task deletion" below), the API now exposes an **irreversible** operation with no caller identity: anyone who can reach the port can destroy any user's stored results, including the copies held on the publisher's storage. The task's `user` field is not an identity either — it is free text taken from the multipart form at task creation (`request_handler.cxx`, `form.get("user", "anonymous")`) and never verified.

**Improvement:** Add at minimum a shared-secret header check or mTLS, advisable for any non-local deployment. `RequestHandlerFactory::createRequestHandler()` is the single dispatch point every route passes through before its handler is constructed, so one check there covers the whole API. Ownership enforcement on destructive routes (compare the caller against the `user` recorded in `<id>.json`) requires a real identity first and is a separate step.

---

## Task deletion — a task being archived is indistinguishable from an unknown one

**Current:** `Schedule::ManageEndOfStep()` queues the archive job, records the task in `users.json` (`users_.Add(task, false)`), then destroys the in-memory `Task` — all before the background `Archiver` thread has produced `<id>.zip`. During that window the task is listed in the dashboard's history but has no archive on disk, so `Schedule::DeleteTaksDone()` finds nothing and fails with `artefact not found`, the same answer it gives for a task ID that never existed. The window lasts as long as the archive job takes (queue depth × zip time), and the API's single `success: false` cannot distinguish the two cases either.

The same gap hides archive *failures*: if `Archiver::ProcessJob()` fails, `<id>.json` is left with no `<id>.zip` and nothing ever revisits it. Such a task stays listed, cannot be deleted (the lookup requires an archive), and nothing in the codebase enumerates `exportPath_` to find these leftovers.

**Improvement:** Have `Archiver` keep a small drainable structure of finished jobs (task ID + success/failure, the task's `user`/`job_type` are already in `ArchiveJob::variables_`), protected by its existing mutex and consumed by `Schedule`'s loop with a swap-under-lock, as `TasksManager::DeleteTasks()` already does. `Schedule` then writes an explicit status into `users.json` — archiving / archived / archive failed — since it is the only component that writes that file today, which avoids coupling `Archiver` to `UsersAPI`. The delete path can then refuse an in-progress task explicitly and allow cleanup of a failed one. A crash between a job finishing and the next drain would leave a status stuck at "archiving"; a reconciliation pass at startup, checking such entries against the filesystem the way `UsersAPI::UserTasks()` already self-heals missing ones, closes that without adding durability machinery.

---

## Task deletion — remaining limitations

**Current:** `Schedule::DeleteTaksDone()` deletes published files before their local symlinks, and pairs them per file so that a failed remote deletion keeps its symlink — nothing is silently orphaned. The residual gaps:

- **A partial failure is sound but not replayable.** If one of the two files (archive, JSON) is deleted and the other's remote deletion failed, no data is lost and no orphan is created, but the function requires *both* `<id>.zip`/`.tgz` and `<id>.json` at entry, so a retry exits on `artefact not found` or `json not found`. The leftover then needs manual cleanup.
- **An unreadable `<id>.json` blocks deletion even with nothing remote.** The publisher is resolved from `task.publish` in that file, so a truncated, hand-edited, or older archived JSON fails the request — including for a task that was never published and therefore has no remote side to protect. Checking `is_symlink()` on both files first would let a purely local task be deleted without the JSON.
- **No synchronisation with the archiver thread.** `DeleteTaksDone()` runs on the HTTP thread without `lockThread_` (it touches neither `steps_` nor `tasks_`). A delete landing while `Publish::PublishResults()` is moving files can interleave with it — `PublishResults` moves the archive and creates its symlink before doing the same for the JSON, and it ignores the return value of `MoveFileAndCreateSymLink()` (`publish.cxx`), so a half-published task is possible. The window is narrow and the worst case is one orphaned JSON on the publisher's storage.
- **The failure mode is a single boolean.** `success: false` covers unknown task, in-progress archiving, filesystem error and publish-server error alike; only the server log tells them apart. This matches the rest of the API (`CancelTask`, `CancelStep`), so it is a consistency choice rather than an oversight.

**Improvement:** The first two are small and independent — carry the lookup result into the retry path, and fall back to a filesystem-only decision when the JSON cannot be read. The third needs the delete path to coordinate with the archiver, which the drainable-status work above would make possible. The fourth only becomes worth changing if the API adopts finer status codes generally.

---

## Task deletion — the publish server's `DELETE` endpoint does not exist yet

**Current:** `Publish::DeleteResults()` sends `DELETE` to `base_url + notify_endpoint` with `link` and `task_id` as multipart fields (see `docs/api.md`). Nothing implements the receiving side — that server is outside this repository. Until it does, the behaviour of deleting a *published* task depends entirely on what it returns for an unhandled method on that route: a `404` is read as "not handled" and the scheduler deletes the published files itself (deletion works), while a `405` or a 5xx is read as an error and **every deletion of a published task is refused**.

Two details will matter when implementing it: the endpoint must resolve a task from its view link (`/files/${PACKAGE}#${TASK_ID}`) or from `task_id`, not from the storage paths it received at publication time; and some HTTP frameworks discard the body of a `DELETE` request, in which case the fallback is a dedicated `delete_endpoint` in the publisher configuration carrying the same form over `POST`.

**Improvement:** Implement the endpoint, then confirm the mapping end to end. If the publisher is expected to keep its own index, returning `2xx` (it deletes) is preferable to `404` (the scheduler reaches into its storage tree), since only the former keeps that index consistent.

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

---

## History view — no pagination, no virtualisation

**Current:** `GET /api/user/<u>/<t>/tasks` returns every task recorded for that pair in a single response — the route takes no offset/limit and no time range. The board's history view renders whatever comes back as one DOM subtree per task, with no windowing: `BuildTimesLine()` (`html/board/history.js`) builds the whole list into a `DocumentFragment` and commits it with one `replaceChildren()`, which keeps insertion down to a single reflow but leaves node creation proportional to the task count. Past roughly 10 000 tasks the view freezes for seconds on every render and sort change; 100 000 is unusable.

The aggregated **All** view compounds this on the request side: it issues one `tasks` call per user × job\_type pair, ten in flight at a time, and merges the responses client-side. Server side each of those calls also prunes stale entries and may rewrite `users.json` wholesale. That is correct under concurrency — `UsersAPI::UserTasks()` takes `lockDB_` shared to read and upgrades to a unique lock around `SaveNoLock()` — but the parallel calls serialise on that one mutex, and each rewrite covers the entire index rather than the pair that changed.

**Improvement:** Add offset/limit (or a time range) to the tasks route and page the timeline against it — that bounds both the response size and the number of DOM nodes, and is the only option that also helps the server. Failing that, virtualising the board's timeline so only visible cards exist in the DOM is a client-side-only change that raises the ceiling without touching the API. The `users.json` rewrite is a throughput concern rather than a correctness one, and only becomes worth addressing if the user count grows enough for the aggregated view's ten concurrent calls to contend visibly.
