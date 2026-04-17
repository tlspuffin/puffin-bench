# Monitoring, Output Capture, Cache, and Archiver

## 1. Step Monitor System

### Purpose

Each step can optionally run a **monitor function** in the background while the step executes. The monitor writes human-readable status text to a designated file. The scheduler reads these updates via inotify and surfaces them on the Board dashboard as `monitor_message`.

### Monitor Configuration (`Monitor::Task`)

Defined in the flow JSON under `steps[].monitor`:

```json
"monitor": {
  "entry_point": "MonitorExperiment",
  "delay_start_s": 10,
  "interval_s": 30,
  "timeout_s": 7200
}
```

| Field | Meaning |
|-------|---------|
| `entry_point` | Bash function name called as the monitor |
| `delay_start_s` | Seconds to wait before starting the monitor after the step begins |
| `interval_s` | How often the monitor function re-runs |
| `timeout_s` | Maximum total monitoring duration |

`Monitor::Task::ToArgs()` serialises these fields as command-line arguments for `executor.sh`, which launches the monitor function in a background subshell.

### Monitor File Path

```
<runPath>/monitors/<taskID>-<stepID>.txt
```

The monitor function receives this path as `$1` and writes its output there. Example from `PR_common.sh`:

```bash
MonitorExperiment() {
  # $1 = monitor file path
  echo "corpus: $(wc -l < corpus.txt)  objectives: $(ls objective/ | wc -l)" > "$1"
}
```

### inotify Watcher (`Monitor`)

`Monitor::Main()` runs in a dedicated thread:

```
inotify_init1(IN_CLOEXEC)
inotify_add_watch(fd, <runPath>/monitors/, IN_CLOSE_WRITE)
loop:
  read(inotify_fd, events, sizeof(buf))
  for each inotify_event with IN_CLOSE_WRITE:
    filename (e.g. "1713240000000-1-0-0.txt")
    lookup step in stepsList_[filename]
    read file content into string
    { lock_guard lock_; }
      monitorsMessage_[step] = content
      changed_ = true
    cv_.notify_all()
```

### Scheduler Integration

Inside `Schedule::ScheduleLoop()`:
- `Monitor::GetChange()` returns `true` if any monitor file changed since the last call.
- `Monitor::GetMessage(step)` retrieves the latest message for a step.
- The message is stored in `Step::message_from_run_` and included in `Step::ToJSON()`, making it available in `GET /api/tasks/running`.

---

## 2. Output Capture

### Overview

When a step process is forked, its `stdout` and `stderr` are redirected to pipes. A background epoll thread (`FDCaptureThread`) reads from those pipes and writes data into per-fd ring buffers. The `GetOutput` API reads from these buffers for live data, or from archived files for completed steps.

### FDCaptureThread

```cpp
class FDCaptureThread {
  // Add/remove a pipe file descriptor with its associated buffer
  void AddFD(int fd, shared_ptr<OutputBuffer> buf);
  void RemoveFD(int fd);

  // Read captured data (offset/size-limited)
  string Read(int fd, uint64_t offset, uint64_t size);
};
```

Internally, `FDCaptureThreadImpl` runs an `epoll_wait` loop. On each readable event it calls `read(fd, chunk, 4096)` and passes the bytes to `OutputBuffer::Write()`.

One `FDCaptureThread` is shared across all concurrently running steps of a `Local` executor instance.

### OutputBuffer Hierarchy

```
OutputBuffer (abstract)
  ├─ MemoryRing   — seule implémentation instanciée (active)
  └─ FileRing     — implémentée mais jamais instanciée (dead code)
```

#### MemoryRing (active)

- Backed by `vector<uint8_t>` of capacity `maxSize_` (from `logsSize` in config).
- Writes append at the current `bufferStart_`; when full, oldest data is overwritten.
- `virtualSize_` tracks total bytes ever written (may exceed `maxSize_`).
- Protected by `std::mutex lock_`.
- **Flush on destruction:** the destructor writes the entire buffer to the log file (`step.stdout_` / `step.stderr_`) in a single `write()` call. No disk I/O occurs during step execution — if the server crashes mid-step, in-flight output is lost.

#### FileRing (dead code)

Fully implemented but never instantiated. Designed for rotating file-based output:
- Writes to files `<logs_path>/<stepID>.stdout.0.txt`, `.1.txt`, … up to `nbFiles_`.
- `RotateFile()` opens the next index when a file reaches `maxSize_`.
- Would persist output to disk continuously (survives server crash), at the cost of I/O on every captured chunk.

### Log File Locations

**During execution (live):**
```
<runPath>/<taskID>/logs/stdout.<stepID>-<confID>-<attempt>.txt
<runPath>/<taskID>/logs/stderr.<stepID>-<confID>-<attempt>.txt
```
These are the files written by FileRing. For MemoryRing the data is held in memory only.

**After archiving:**
Logs are included in `<exportPath>/<taskID>.tgz`. The `GetOutput` API extracts them on demand via `file_tgz.cxx::ReadFileFromTgz()`.

---

## 3. Cache System

### Design Goals

- **Content-addressed**: files are retrieved by an opaque string ID, not by path.
- **Non-blocking Put**: the caller returns immediately; background thread does the copy.
- **Concurrent Get**: multiple readers can query simultaneously without blocking each other.
- **Persistent index**: the ID→path mapping survives server restarts.

### Data Model

```cpp
struct FileInformations {
  filesystem::path path;    // location in cache storage
  string md5;               // optional checksum
  atomic<bool> full;        // true = file copy complete
};
unordered_map<string, FileInformations> data_;   // id → file info
```

### Put Flow

```
Cache::Put(srcPath, id, force, computeMD5)
  1. { unique_lock(dataLock_) }
       if id exists and !force: return
       insert data_[id] = { path="", md5="", full=false }   // stub
     unlock
  2. Push FileToStore{srcPath, id, computeMD5} to dataToAdd_
  3. cacheThreadCV_.notify_one()
  4. Return immediately

CacheLoop thread picks up FileToStore:
  1. dstPath = storagePath_ / id
  2. filesystem::copy(srcPath, dstPath)
  3. if computeMD5: md5 = compute_md5(dstPath)
  4. { unique_lock(dataLock_) }
       data_[id] = { dstPath, md5, full=true }
     unlock
  5. SaveData()   // rewrite mapping file
```

### Get Flow

```
Cache::Get(id, &outPath)  →  GetStatus
  1. { shared_lock(dataLock_) }   // non-exclusive: readers don't block each other
       it = data_.find(id)
       if not found: return NO
       if !it->second.full: return PARTIAL
       outPath = it->second.path
       return OK
     unlock
```

### Persistence

`SaveData()` writes `<storagePath>/<mappingFile>` as JSON:
```json
{
  "files": [
    { "id": "abc123", "path": "/cache/storage/abc123", "md5": "d41d8…" },
    …
  ]
}
```

`LoadData()` reads this file at startup and rebuilds `data_` with `full=true` for all entries.

`SaveCopyLog()` / `DeleteCopyLog()` maintain a per-operation transaction file so interrupted copies can be detected on restart.

### Usage in Step Scripts

The `QueryCache` / `SetCache` functions in `scripts/functions.sh` wrap the cache API:

```bash
# Wait up to 300s for ID to appear, return path
local binary=$(QueryCache -q "abc123_openssl111_asan" 300)

# Register a file in the cache
SetCache "abc123_openssl111_asan" "/path/to/tlspuffin"
```

These call `GET /api/cache/<id>` and `PUT /api/cache/<id>` respectively.

---

## 4. Archiver

### Purpose

After all steps of a task complete, the scheduler creates an `ArchiveJob` and hands it to the `Archiver`. The archiver runs in a dedicated thread to avoid blocking the schedule loop.

### ArchiveJob

```cpp
struct ArchiveJob {
  Publish    publish_;         // where to publish (server URL, storage path)
  unordered_map<string,string> variables_;  // template variables for publish paths
  path       archivePath_;     // destination .tgz path
  vector<path> sources_;       // files to include (first = task.json)
  path       deleteDir_;       // directory to remove after archiving
  path       baseDir_;         // base for relative paths inside the archive
  bool       doPublish_;       // whether to publish after archiving
};
```

### Archiver Thread

```
Archiver::ThreadLoop():
  while threadRunning_:
    wait on queueCV_ until jobs_.empty() == false
    job = jobs_.front(); jobs_.pop()
    ProcessJob(job)

ProcessJob(job):
  1. Open archive at job.archivePath_ with libarchive (write mode, gzip)
  2. For each path in job.sources_:
       add file or directory recursively to archive
  3. Close archive
  4. if job.doPublish_:
       Publish::PublishResults(job.variables_, task.json, job.sources_)
  5. if job.deleteDir_ not empty:
       filesystem::remove_all(job.deleteDir_)
  6. jobsProcessed_++  (atomic)
```

### Publish

`Publish::PublishResults()` can both copy to a local storage path and/or HTTP POST to a remote server.

**Local storage:**
```
MoveFileAndCreateSymLink(archive, rootStorage_/goal_/archive_name)
  → moves .tgz to storage, creates symlink with canonical name
```

**Remote HTTP:**
```
PublishToServer(files, archivePath)
  → Poco HTTPSClientSession (or plain HTTP)
  → Multipart POST with archive file
  → If checkServerCertificat_=false: skip TLS cert validation
```

The `server_` URL and `storage_` path are read from the `publishers` section of `config.json` and referenced by name in the flow JSON `publish.publisher` field.

### Variable Substitution

`Publish::PublishResults()` receives `taskVariables` (a map of `string→string`) which are used to expand `${VAR}` placeholders in destination paths. This is handled by `ns_Utils::Variables::Replace()`.

Example: `storage_/${JOB_TYPE}/${COMMIT_ID}/` with variables `JOB_TYPE=perf`, `COMMIT_ID=abc123` → `storage_/perf/abc123/`.

---

## 5. Putting It All Together: End-to-End Flow

```
Task completes (last step Done)
  ↓
Schedule::ManageEndOfStep()
  → Task::FinalizeAndArchive()
      → build ArchiveJob:
           sources = [task.json, artefacts/**, logs/**]
           archivePath = <exportPath>/<taskID>.tgz
           deleteDir = <runPath>/<taskID>
      → Archiver::AddJob(job)     (non-blocking enqueue)
      → TasksManager::DeleteTask() (freed from memory)

[Archiver thread]
  → ProcessJob:
       libarchive writes <taskID>.tgz
       Publish::PublishResults() [if configured]
         → move/symlink in local storage
         → HTTP POST to remote server

[Later: GET /api/task/<taskID>/output]
  → Schedule::GetOutput()
      → file_tgz.cxx::ReadFileFromTgz(<taskID>.tgz, "logs/stdout.<stepID>…")
      → return base64-encoded content
```
