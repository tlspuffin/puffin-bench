# restsrv.publisher — Roadmap

Improvements identified from the current design. Items are independent unless noted.

---

## Error recovery API

**Current:** Files that fail to process are added to `filesInError_` and silently skipped by all subsequent periodic scans (`ScanStorage()`). The only way to retry a failed file is to re-POST it via `/api/notify`, which bypasses `filesInError_`.

**Problem:** There is no admin API to inspect or clear the error state. Operators have no visibility into which files failed without reading logs.

**Improvement:** Expose a `GET /api/project/{name}/errors` endpoint returning the current `filesInError_` list, and a `DELETE /api/project/{name}/errors` endpoint to clear it and trigger a re-scan.

---

## Rule hot-reload

**Current:** `.rules` files are loaded when a project is first scanned. Adding or modifying a `.rules` file requires a server restart to take effect.

**Improvement:** Watch `.rules` files with inotify (or stat-based polling) and reload them on change without restarting. The `shared_mutex` on the project list already provides the synchronization primitive needed.

---

## Parallel per-project processing

**Current:** The single `Publish` thread processes all archive notifications sequentially. A slow or large archive from one project blocks all other projects.

**Improvement:** Allow configurable per-project worker threads (or a bounded thread pool) so multiple projects can be processed concurrently.

---

## Authentication

**Current:** The REST API has no authentication mechanism. Any process with network access can submit archives or read results.

**Improvement:** Add at minimum a shared-secret header check (`Authorization: Bearer <token>`) or mTLS for deployments where the server is reachable beyond a trusted network.
