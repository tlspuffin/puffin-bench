# Scheduler — Monitoring, Output Capture, Cache, and Archiver

## 1. Step Monitor System

### Purpose

A step can optionally run a **monitor function** in the background while it executes. The monitor writes human-readable status text to a file; the scheduler watches that file with inotify and surfaces its content on the Board dashboard (and via `GET /api/tasks/running`) as `message_from_run`.

### Monitor Configuration

Declared per-step in the flow JSON under `steps[].monitor` (parsed by `ns_Monitor::Task::ReadFromTaskJSON`, `src/scheduler/schedule/monitor/task.cxx`):

```json
"monitor": {
  "entry_point": "MonitorExperiment",
  "delay_start": "10s",
  "interval": "30s",
  "timeout": "2h"
}
```

| Field | Required | Default | Meaning |
|-------|----------|---------|---------|
| `entry_point` | yes | — | Bash function name called as the monitor |
| `interval` | yes | — | How often the monitor function re-runs |
| `timeout` | no | `"0s"` (no timeout) | Maximum duration for a single monitor invocation |
| `delay_start` | no | `"0ms"` | Delay after step start before the first monitor invocation |

All three duration fields accept human-readable duration strings (`"10s"`, `"2m"`, `"1h"`, ...), parsed by `ParseDurationToSeconds()` and stored internally as integer seconds. `ns_Monitor::Task::ToJSON()` re-serializes them with an explicit `"s"` suffix.

`ns_Monitor::Task::ToArgs()` builds the single space-joined string `"<entry_point> <interval_s> <timeout_s> <delay_start_s>"`, which is how the monitor configuration is threaded through to `executor.sh` as `THEJOB_MONITOR_PARAMETERS_PATH` content.

### Monitor File Path

```
<Step::monitors_path_>/<taskID>-<stepID>.txt
```

i.e. `Task::monitors_path_ / (taskID + "-" + Step::ID() + ".txt")`, for example `.../monitors/1713240000000-0-0-0.txt`. `Task::monitors_path_` derives from `Schedule::Config::monitorsPath_`, which is always `runPath_ / "monitors"` (not independently configurable via a JSON key).

The monitor function receives this path as `$1` and must write its status there:

```bash
MonitorExperiment() {
  local output_file="$1"
  echo "corpus: $(wc -l < corpus.txt)  objectives: $(ls objective/ | wc -l)" > "${output_file}.tmp"
  mv "${output_file}.tmp" "${output_file}"
}
```

The write-then-`mv` pattern is required, not just good practice — see the inotify event mask below.

### inotify Watcher (`Monitor`)

`src/scheduler/schedule/monitor/monitor.cxx`, run in a dedicated thread:

```
fd = inotify_init1(IN_NONBLOCK | IN_CLOEXEC)
inotify_add_watch(fd, <monitorsPath>, IN_MOVED_TO)
loop:
  read(fd, events, ...)
  for each event with mask IN_MOVED_TO:
    filename = event.name                      // e.g. "1713240000000-0-0-0.txt"
    step = stepsList_[filename]                 // lookup by exact filename
    if step found:
      content = read entire file
      monitorsMessage_[step] = content
```

Only `IN_MOVED_TO` is watched — plain writes (`IN_MODIFY`/`IN_CLOSE_WRITE`) are **not** watched. A monitor function that writes to the target file directly (without the atomic `mv` from a temp file) will never trigger the watcher; the file must be renamed into place from within the watched directory. `helpers.sh`'s `StartMonitor`/`StopMonitor` implement this correctly by writing to `<path>.tmp.<pid>` and `mv`-ing over the real path.

### Scheduler Integration

Inside the schedule loop:
- `Monitor::GetChange()` drains pending updates from `monitorsMessage_`.
- Each pending update is copied into `Step::message_from_run_`.
- `Step::ToJSON()` includes `message_from_run` (plus `monitor` and `monitor_path`) whenever the step has a configured monitor, making the latest status text visible in `GET /api/tasks/running`.

On step completion, `Monitor::Remove()` performs one final read of the file (capturing a last snapshot) and deletes it — this pairs with `functions.sh`'s `StopMonitor`, which runs the monitor function synchronously one last time before the step exits, guaranteeing a final status update is captured.

---

## 2. Output Capture

### Overview

A step's `stdout`/`stderr` are redirected to pipes when the process is forked (local executor). A shared `FDCaptureThread` (`src/scheduler/schedule/executor/output_ring.hxx/.cxx`) runs an `epoll_wait` loop across all captured file descriptors of concurrently running steps; on each readable event it reads up to 4096 bytes and forwards them to the fd's associated `OutputBuffer`.

```cpp
class FDCaptureThread {
  bool AddFD(int fd, OutputBuffer* outputBuffer);
  bool RemoveFD(int fd);
  bool HaveFD(int fd);
  void Read(int fd, struct FileExtractedText& data);   // fills data in place
};
```

### OutputBuffer Hierarchy

```
OutputBuffer (abstract: Write(), Read())
  ├─ MemoryRing   — the only implementation actually instantiated (executor/local.cxx)
  └─ FileRing     — fully implemented, never instantiated anywhere; dead code
```

#### MemoryRing (active)

- Backed by a `std::vector<uint8_t>` of capacity `maxSize_`, sourced from the executor config field `logsSize` (`ns_Executor::Config::logsSize_`, default 16 MiB).
- Circular writes at `bufferStart_`; once full, new data overwrites the oldest bytes. `virtualSize_` tracks the total number of bytes ever written (can exceed `maxSize_`).
- `Read(FileExtractedText& data)` honors `data.requestReadOffset`/`data.requestReadSize` (negative offset reads from the tail) and fills `data.buffer`, `data.startOffset`, `data.fileStartOffset`, `data.filesize`.
- Guarded by a `std::mutex`.
- **Flush on destruction:** if a target file path (`step.stdout_` / `step.stderr_`) was given, the destructor writes the entire retained window to that file in one `ofstream` write. No disk I/O happens while the step is running — if the server crashes mid-step, any output beyond the last flush is lost.

#### FileRing (dead code)

Implements rotating on-disk log files (`<path>.0.txt`, `.1.txt`, ... up to `nbFiles_`, `RotateFile()` on reaching `maxSize_`), and would persist output continuously (crash-safe, at the cost of per-chunk I/O). Its `Read()` is not even implemented (commented out). No code path constructs a `FileRing` today.

### Reading Output — `GET /api/task/.../output/...`

`Schedule::GetOutput()` first asks `TasksManager::GetRunningOutput()` whether the step is still in memory:
- `type == "stdout"`/`"stderr"`: delegates to the local executor, which reads from the step's pipe fd via `FDCaptureThread::Read()` (i.e. the in-memory `MemoryRing`). Response marked `partial=true`.
- `type` numeric: interpreted as an index into `Step::readable_files_` (the flow JSON `streams` array, see `docs/api.md`); the corresponding file is read live off disk (`data.live = true`). This lets a step advertise arbitrary progress/log files (not just stdout/stderr) for the dashboard to tail in real time.

If the step is not in memory (task finished), `Schedule::GetOutput()` falls back to reading `logs/<type>.<stepID>.txt` out of the task's archive (`.zip`, with `.tgz` accepted for legacy tasks) via `FileCompressed::ExtractFileData()`. Numeric stream types are not resolvable once a task is archived.

---

## 3. Cache System

### Design Goals

- **Content-addressed**: files are retrieved by an opaque string ID (`[a-zA-Z0-9_-]+`, enforced only by the HTTP routing regex — `Cache`/`CacheAPI` themselves do not validate the ID).
- **Non-blocking `Put`**: the caller returns immediately; a background thread performs the copy.
- **Concurrent `Get`**: readers use a shared lock and don't block each other.
- **Persistent index**: the ID→path mapping survives server restarts.

### Data Model (`src/scheduler/cache/cache.hxx/.cxx`)

```cpp
struct FileInformations {
  std::filesystem::path path_;   // location in cache storage
  std::string md5_;              // currently always "" — see note below
  bool full_;                    // true once the background copy has completed
};
std::unordered_map<std::string, FileInformations> data_;   // id -> file info
std::shared_mutex dataLock_;                                 // guards data_
```

A separate mutex/condition-variable pair guards the `dataToAdd_` work queue consumed by the background `CacheLoop()` thread.

### Put Flow

```
CacheAPI::Put(path, id, force, computeMD5)
  -> Cache::Put():
       shared/unique_lock(dataLock_):
         if id exists and !force: return false
         data_[id] = { path=storagePath_/id, md5="", full=false }   // placeholder
       push FileToStore{id, srcPath, computeMD5} onto dataToAdd_, notify
       return true   // caller does not wait for the copy

CacheLoop() background thread:
  for each FileToStore:
    std::filesystem::copy_file(srcPath, storagePath_/id)
    on success: data_[id].full_ = true
    on failure: erase data_[id]
    SaveCopyLog() / SaveData() (index persistence, see below)
```

**MD5 is accepted but not implemented for the cache path.** The `computeMD5` request field is parsed and threaded through as `FileToStore::md5_`, but `Cache.cxx` never calls into `utils/md5_poco.hxx`'s `MD5()` functions to actually hash the copied file — `FileInformations::md5_` is hardcoded to `""` regardless of the flag. `MD5()` (via `Poco::MD5Engine`) is used elsewhere in the codebase (e.g. `tasksmanager.cxx`), but not to verify or record cached file content today.

### Get Flow

```
Cache::Get(id, &outPath) -> GetStatus { OK, PARTIAL, NO }
  shared_lock(dataLock_):
    if not found: return NO
    if !full_: return PARTIAL
    outPath = path_; return OK
```

`CacheAPI::Get()` maps `GetStatus` to the exact strings returned over HTTP: `OK`→`"Ok"`, `PARTIAL`→`"Locked"`, `NO`/default→`"Not Available"`.

### Persistence

`Cache::Config` (`src/scheduler/cache/config.hxx`) provides `storagePath_` (flat directory — cached files are stored directly as `storagePath_/id`, no sharding/subdirectories) and `mappingFile_`.

`SaveData()` writes the index atomically (`<mappingFile_>.tmp` then `rename()`) as pretty-printed JSON, an object keyed by ID:
```json
{
  "abc123": { "path": "/cache/storage/abc123", "md5": "", "full": true },
  "...": { }
}
```
`LoadData()` parses this at startup; for each entry it keeps the file if it exists and `full==true`, otherwise attempts recovery from a companion append-only log (`<mappingFile_>.copy`, three lines per in-flight copy: id/path/md5, written by `SaveCopyLog()` and cleared by `DeleteCopyLog()` once a batch completes), and drops/logs anything unrecoverable.

### Usage from Step Scripts

`functions.sh`'s `QueryCache`/`SetCache` wrap the HTTP API (see `docs/step-script-reference.md` for full semantics):

```bash
local binary=$(QueryCache -q "abc123_openssl111_asan" 300)   # GET /api/cache/<id>, polls on state="Locked"
SetCache "abc123_openssl111_asan" "/path/to/tlspuffin"        # PUT /api/cache/<id>
```

`QueryCache` reads the JSON response's `state` field and compares it literally against `"Ok"`, `"Locked"`, and `"Not Available"` — matching `CacheAPI::Get()`'s output exactly.

---

## 4. Archiver

### Purpose

When a task finishes (or is cancelled), the scheduler builds an `ArchiveJob` and hands it to the `Archiver`, which zips and optionally publishes the result on a dedicated background thread so the schedule loop is never blocked by I/O.

### ArchiveJob

```cpp
struct ArchiveJob {
  Publish publish_;
  std::unordered_map<std::string, std::string> variables_;   // ${VAR} substitution values
  std::filesystem::path archivePath_;                        // destination .zip
  std::vector<std::filesystem::path> sources_;                // [0] is always task.json
  std::filesystem::path deleteDir_;                            // removed after archiving
  std::filesystem::path baseDir_;                               // zip is built relative to this
  bool doPublish_;
};
```

Built by `Task::FinalizeAndArchive()`: it moves `artefacts_path_` → `<finalSavePath>/artefacts` and `logs_path_` → `<finalSavePath>/logs`, writes the task's final JSON to `<finalSavePath>.json`, and constructs the job with `sources_ = {taskJSONfile, artefacts dir, logs dir}`, `archivePath_ = <finalSavePath>.zip`, `deleteDir_ = baseDir_ = finalSavePath`. `finalSavePath` is under `exportPath_` normally, or `exportCanceledPath_` (always `exportPath_/"Canceled"` — not independently configurable) when the task was cancelled.

### Archiver Thread

```
Archiver::ThreadLoop():
  wait on queueCV_ for a queued job or shutdown
  job = jobs_.front(); jobs_.pop()
  ok = ProcessJob(job)
  if ok: jobsProcessed_++; if job.doPublish_: job.publish_.PublishResults(job.variables_, job.sources_[0], {job.archivePath_})
  else:  jobsFailed_++
```

**`ProcessJob` does not use libarchive.** It shells out to the `zip` command line via `popen()`:
```
cd <baseDir_> && zip -r <archivePath>.tmp <sources, relative to baseDir_> 2>&1
```
Any source path outside `baseDir_` is first copied in. After a non-empty temp archive is produced it is renamed to `archivePath_`; then, if `deleteDir_` is set, `std::filesystem::remove_all(deleteDir_)` cleans up the run directory.

### Publish

`Publish::PublishResults(taskVariables, taskJSONfile, sources)`:

1. Resolves the destination directory: `storage_` (task-level, from the flow JSON `publish.storage` field) has `${VAR}` placeholders substituted via `ResolveVariables()` against `taskVariables`; if the matched named publisher (`publishers_[server]` from `config.json`) has a `rootStorage_`, it is prefixed onto the resolved path.
2. **Local storage:** for each file (task JSON + archive), `MoveFileAndCreateSymLink()` moves it into the destination (rename, or copy+remove as fallback) and creates a symlink **back at the original location** pointing to the new destination — so the original run directory keeps a link to where the artifact ended up.
3. **Remote HTTP** (only if the matched publisher has a non-empty `base_url`): `PublishToServer()` opens a `Poco::Net::HTTPClientSession`/`HTTPSClientSession` (HTTPS chosen by URL scheme) with a 30s timeout, TLS verification set to `VERIFY_STRICT` or `VERIFY_NONE` depending on the publisher's `check_server_certificat` flag, and sends a multipart **POST** to `<base_url><notify_endpoint>` with one `src` field per uploaded file plus a single `dst` field set to the resolved destination path.

### Publisher Configuration

Configured under the server config's `"publisher"` object (note: singular key), keyed by publisher name; each entry maps to `PublisherConfig`:

| JSON field | Struct field | Meaning |
|------------|--------------|---------|
| `base_url` | `baseURL_` | Remote server base URL |
| `notify_endpoint` | `notifyEndpoint_` | POST path for publish notification |
| `view_endpoint` | `viewEndpoint_` | Path used to build `publish_link` for humans |
| `storage` | `storage_` | Root storage path prefix on the publish target |
| `check_server_certificat` | `checkServerCertificat_` | Validate the remote TLS certificate (default `false`) |

A task's flow JSON `publish` block (`goal`, `server`, `storage`, `check_server_certificat`) selects a named publisher by `server` and can override `storage`/certificate-checking locally; `goal` and the task-local `storage` value always come from the flow JSON itself. `${VAR}` placeholders in `storage`/`goal` are resolved from task/runtime arguments.

`Publish::ViewLink()` resolves `${VAR}` placeholders in `view_endpoint` the same way and appends it to `base_url` to build the `publish_link` field exposed via `GET /api/user/<user>/<jobType>/tasks`.

---

## 5. Putting It All Together: End-to-End Flow

```
Task's last step reaches Done/Cancelled
  -> Schedule marks the step done, evaluates end-of-task
  -> Task::FinalizeAndArchive(exportPath or exportCanceledPath)
       moves artefacts/ and logs/ into <finalSavePath>/
       writes <finalSavePath>.json
       returns an ArchiveJob{ sources = [task.json, artefacts/, logs/], archivePath = <finalSavePath>.zip, deleteDir = finalSavePath }
  -> Archiver::AddJob() (non-blocking enqueue)

[Archiver thread]
  -> ProcessJob(): `zip -r` writes <taskID>.zip, then remove_all(deleteDir)
  -> if publish configured: Publish::PublishResults()
       move + symlink into local storage, and/or multipart HTTP POST to a remote publisher

[Later: GET /api/task/<taskID>/<uuid>/<stepID>/output/stdout/<size>/<offset>]
  -> Schedule::GetOutput()
       task no longer in memory
       -> locate <taskID>.zip (or exportCanceledPath/<taskID>.zip, or legacy .tgz variants)
       -> FileCompressed::ExtractFileData("logs/stdout.<stepID>.txt")
       -> return base64-encoded chunk
```
