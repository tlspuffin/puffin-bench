# Scheduler — Roadmap

Known weaknesses and planned improvements. Items are independent unless noted.

---

## Crash recovery

**Current:** `TasksManager::LoadStatus()` and the reload path in `Schedule` are present but deliberately disabled (commented out). A server restart loses all in-flight task state.

**Improvement:** Implement the reload path properly, including group-based retry logic, to allow hot restarts. The `tasksmanager.json` snapshot already contains the full serialized state needed to reconstruct the in-memory graph.

---

## Scheduling loop lock granularity

**Current:** `ScheduleLoop()` holds `lockThread_` for the entire body of each iteration. Any HTTP call that needs the lock (e.g. `AddTask`) blocks for the full duration of step-dispatch + file I/O.

**Improvement:** Split the critical section — hold the lock only for queue/state mutations, and release it before I/O operations (file writes, subprocess calls). This would improve responsiveness under load.

---

## Authentication and authorization

**Current:** The REST API has no authentication mechanism. Any process with network access can submit tasks, cancel jobs, or read output.

**Improvement:** Add at minimum a shared-secret header check or mTLS, advisable for any non-local deployment.

---

## `WaitForCompletion()` busy-wait

**Current:** `Archiver::WaitForCompletion()` polls with `sleep_for(100ms)` instead of waiting on a condition variable.

**Improvement:** Replace with a `std::condition_variable` wait, signalled when `jobsProcessed_` reaches the expected count.

---

## `FileRing` — dead code

**Current:** `FileRing` (rotating file-based output buffer) is fully implemented but never instantiated. `MemoryRing` is the only buffer used.

**Options:**
- Remove `FileRing` to reduce code surface.
- Wire it in as a fallback when `logsSize_` is very large and heap pressure is a concern (output persisted to disk continuously, survives server crash).

---

## Single executor backend

**Current:** The `Executor` abstraction was designed for multiple backends, but only `Local` exists.

**Improvement:** Implement remote execution (SSH, container, cluster) by fulfilling the full `Executor` interface and wiring it into the config.

---

## Cache ID character set restriction

**Current:** Cache IDs are restricted to `[a-zA-Z0-9_-]` by the HTTP routing regex. IDs derived from hashes or paths with other characters (`.`, `/`) are silently rejected with a 404 instead of a proper error.

**Improvement:** Either expand the allowed character set in the routing regex, or validate and reject with HTTP 400 at the API level.
