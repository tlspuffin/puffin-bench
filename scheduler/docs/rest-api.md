# REST API Reference

All endpoints are served under the prefix `/api/`. Static assets are served under `/files/`. The server handles `OPTIONS` pre-flight requests on all paths with appropriate CORS headers.

Base URL: `http[s]://<host>:<port>/api`

---

## Task Management

### Submit a Task

```
POST /api/task/new
Content-Type: multipart/form-data
```

**Form fields:**

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | Human-readable task name |
| `config` | yes | Flow JSON file (workflow definition, see below) |
| `script` | yes | Bash script file defining step functions |
| `files[]` | no | Additional input files (uploaded to `userPath/<id>/`) |
| `args[KEY]` | no | Global key/value arguments passed to all steps |
| `runtime[KEY]` | no | Runtime parameters (merged with args) |
| `user` | no | Username for task tracking |
| `job_type` | no | Job category for user index |

**Response `200 OK`:**
```json
{ "id": 1713240000000 }
```

**Response `400`** — malformed request or invalid flow JSON.

**Example:**
```bash
curl -X POST http://localhost:8080/api/task/new \
  -F "name=my-experiment" \
  -F "config=@./flow.json" \
  -F "script=@./run.sh" \
  -F "args[COMMIT_ID]=abc123" \
  -F "user=alice" \
  -F "job_type=perf"
```

---

### List Running Tasks

```
GET /api/tasks/running
```

Returns a JSON snapshot of all tasks and their steps read from `<exportPath>/tasksmanager.json`.

**Response `200 OK`:**
```json
{
  "tasks": [
    {
      "id": 1713240000000,
      "name": "my-experiment",
      "user": "alice",
      "job_type": "perf",
      "steps": [
        {
          "uuid": 9876543210,
          "step_id": 0,
          "name": "build",
          "state": "Done",
          "exit_code": 0,
          "nb_cores": 2,
          "time_points_ms": [1713240000000, 1713240120000]
        },
        {
          "uuid": 9876543211,
          "step_id": 1,
          "name": "run",
          "state": "Running",
          "exit_code": 256,
          "nb_cores": 8,
          "monitor_message": "corpus: 1234  objectives: 0"
        }
      ]
    }
  ]
}
```

---

### Get Step Output

```
GET /api/task/<taskID>/<stepUUID>/<stepID>/output/<stdout|stderr>/<size>/<offset>
```

**Path parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `taskID` | uint64 | Task ID |
| `stepUUID` | uint64 | Step UUID |
| `stepID` | string | Step logical ID (e.g. `"0-0-0"`) |
| `stdout\|stderr` | string | Output stream to read |
| `size` | uint64 | Maximum bytes to return |
| `offset` | int64 | Byte offset from beginning (-1 = end) |

For a **running** step, data is read from the in-memory or file ring buffer via `FDCaptureThread::Read()`.

For a **completed** step, data is read from the archived `.tgz` file via `file_tgz.cxx`.

**Response `200 OK`:**
```json
{
  "data": "<base64-encoded output>",
  "size": 4096,
  "offset": 0,
  "total": 32768
}
```

---

### Cancel a Task

```
DELETE /api/task/<taskID>
```

Sets `Task::request_cancel_ = true`. The scheduler loop will stop dispatching new steps and kill any running step on the next iteration.

**Response `200 OK`:**
```json
{ "cancelled": true }
```

---

### Cancel a Step

```
DELETE /api/task/<taskID>/step/<stepUUID>
```

Cancels a specific step within a task. If the step is running, `KillAndMarkCancel()` is called.

**Response `200 OK`:**
```json
{ "cancelled": true }
```

---

### Get Task Final State

```
GET /api/task/<taskID>/final_state
```

Returns metadata for a completed task, read from `<exportPath>/<taskID>/metadata.json`.

**Response `200 OK`:** Contents of `metadata.json` (task JSON at archival time).

**Response `404`** — task not yet completed or not found.

---

### Get Task Artefacts

```
GET /api/task/<taskID>/artefacts
```

Returns the list of artefacts registered by step functions via `CreateArtefact`. For completed tasks, artefacts are read from the `.tgz` archive.

**Response `200 OK`:**
```json
{
  "artefacts": [
    {
      "name": "stats",
      "path": "experiment/0-0-0-0-stats.json",
      "meta": { "run": "0", "attempt": "0" }
    }
  ]
}
```

---

## User and Job Type Tracking

### List Users

```
GET /api/users
```

**Response `200 OK`:**
```json
{ "users": ["alice", "bob"] }
```

---

### List Job Types for a User

```
GET /api/user/<username>/job_types
```

**Response `200 OK`:**
```json
{ "job_types": ["perf", "vulnerabilities"] }
```

---

### List Tasks for a User and Job Type

```
GET /api/user/<username>/<jobType>/tasks
```

**Response `200 OK`:**
```json
{
  "tasks": [
    {
      "id": 1713240000000,
      "name": "my-experiment",
      "running": false,
      "cancelled": false
    }
  ]
}
```

---

## Cache

### Store a File in Cache

```
PUT /api/cache/<id>
Content-Type: application/json
```

**Body:**
```json
{
  "path": "/absolute/path/to/file",
  "computeMD5": true,
  "force": false
}
```

| Field | Default | Meaning |
|-------|---------|---------|
| `path` | required | Absolute path of the source file |
| `computeMD5` | false | Compute and store MD5 hash |
| `force` | false | Overwrite if ID already exists |

**Response `200 OK`:**
```json
{ "stored": true }
```

---

### Retrieve a Cached File

```
GET /api/cache/<id>
```

**Response `200 OK`:**
```json
{
  "status": "OK",
  "path": "/cache/storage/abc123",
  "md5": "d41d8cd98f00b204e9800998ecf8427e"
}
```

**Status values:**

| Value | Meaning |
|-------|---------|
| `OK` | File is available |
| `PARTIAL` | File is being written (locked) |
| `NO` | Not found in cache |

---

## Static Files

```
GET /files/<path>
```

Serves files from the directory configured in `server.html`. MIME type is detected from the file extension. Common types: `.html`, `.css`, `.js`, `.json`, `.png`, `.svg`.

---

## Error Responses

All endpoints return JSON error bodies on failure:

```json
{ "error": "description of what went wrong" }
```

Common HTTP status codes:

| Code | Meaning |
|------|---------|
| 200 | Success |
| 400 | Bad request (missing fields, invalid JSON) |
| 404 | Resource not found |
| 500 | Internal server error |

---

## URL Routing

Routing is implemented in `src/scheduler/server/request_handler_factory.hxx` using regex matching. Each route maps to a typed `RequestHandler` subclass generated by the `REQUESTHANDLER` macro. Captured groups in the regex become constructor arguments to the handler.

Example routing table (abbreviated):

```
POST   /api/task/new                                              → RequestHandlerTaskNew
GET    /api/tasks/running                                         → RequestHandlerTasksRunning
GET    /api/task/(\d+)/(\d+)/(\d+-\d+-\d+)/output/(stdout|stderr)/(\d+)/(-?\d+)
                                                                  → RequestHandlerTaskOutputs(taskID, uuid, stepID, type, size, offset)
DELETE /api/task/(\d+)                                            → RequestHandlerTaskCancel(taskID)
DELETE /api/task/(\d+)/step/(\d+)                                 → RequestHandlerTaskCancelStep(taskID, stepUUID)
GET    /api/task/(\d+)/final_state                                → RequestHandlerTaskGetFinalState(taskID)
GET    /api/task/(\d+)/artefacts                                  → RequestHandlerTaskGetArtefacts(taskID)
GET    /api/users                                                  → RequestHandlerUsersList
GET    /api/user/([a-zA-Z0-9_-]+)/job_types                       → RequestHandlerUserJobsTypeList(user)
GET    /api/user/([a-zA-Z0-9_-]+)/([a-zA-Z0-9_-]+)/tasks         → RequestHandlerUserTasksList(user, jobType)
PUT    /api/cache/([a-zA-Z0-9_-]+)                                → RequestHandlerCachePut(id)
GET    /api/cache/([a-zA-Z0-9_-]+)                                → RequestHandlerCacheGet(id)
GET    /files/.*                                                   → RequestHandlerFiles
```
