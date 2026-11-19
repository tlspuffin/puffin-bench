# Scheduler — Threading Model and Synchronization

This document is built directly from `grep -rn "std::thread\|std::mutex\|std::lock_guard\|
std::unique_lock\|std::shared_lock\|std::condition_variable\|std::atomic\|std::shared_mutex"`
across `src/scheduler/` plus a read of every call site, not carried over from any earlier
document. Where earlier documentation described a design that no longer matches the code, the
mismatch is called out explicitly.

## Thread Inventory

| Thread | Owner class | Started | Purpose |
|--------|------------|---------|---------|
| HTTP worker pool | own `Poco::ThreadPool` (4 to `max_threads`) of the `Poco::Net::HTTPServer` (`ns_Server::MyServerApp::main`) | `server.start()` | Accept and serve HTTP requests |
| Schedule loop | `ns_Schedule::Schedule` | `Schedule` constructor (member of `ScheduleAPI`) | Dispatch steps, detect completion, manage resources |
| inotify monitor | `ns_Monitor::Monitor` | `Monitor` constructor (member of `Schedule`) | Watch step monitor files for updates |
| Archiver | `ns_Schedule::Archiver` | `Archiver` constructor (member of `Schedule`) | Build `.zip` archives and publish results |
| FD capture (pooled) | `ns_Executor::FDCaptureThread::FDCaptureThreadImpl` | lazily, first `Local::Execute()` needing a fresh slot | epoll over step stdout/stderr pipes; instances pooled and shared across up to ~4 concurrent steps each |
| System monitor | `ns_System::Linux` | `Linux` constructor | Periodic `/proc/stat` / `/proc/meminfo` sampling |
| Cache worker | `ns_Cache::Cache` | `Cache` constructor | Copy files into cache storage, compute MD5s, persist the mapping |
| Folder remover | `ns_Schedule::FolderRemover` (singleton) | first `FolderRemover::Instance()` (the `Schedule` constructor) | Delete the run folders of finished tasks in the background |
| Step shutdowns at exit | `ns_Schedule::Schedule::ShutdownAtExit` | end of `ScheduleLoop()`, one temporary thread per running step | Shut the running steps down in parallel when the scheduler stops |

There is no single "main scheduling lock held for the whole loop body" — `Schedule::ScheduleLoop()`
takes and releases `lockThread_` multiple times per iteration, deliberately keeping fork/exec,
`waitpid`, and inotify polling **outside** the lock. See section 2.

---

## Thread Details

### 1. HTTP Worker Pool

- `Poco::Net::HTTPServer` with its own `Poco::ThreadPool` (4 to `max_threads` threads, declared
  before the server so that it outlives it) and bounded keep-alive (`keep_alive_timeout`,
  `max_keep_alive_requests`, `max_queued`; see [configuration.md](configuration.md)). Each
  connection is served by a pool thread running `RequestHandlerFactory::createRequestHandler()` → a
  `RequestHandler` that dispatches into `ScheduleAPI` / `CacheAPI` / `UsersAPI`.
- The running server is registered in an `std::atomic<Poco::Net::HTTPServer*>`
  (`SetRunningServer()`), so that `GET /api/health` can read its counters (`GetHTTPStats()`:
  threads, queued and refused connections).
- These handlers take whichever locks the target subsystem defines (`Schedule::lockThread_`,
  `TasksManager::lock_`, `Cache::dataLock_`/`cacheThreadLock_`, `UsersAPI::lockDB_`) — there is no
  additional HTTP-layer lock.

### 2. Schedule Loop (`Schedule::ScheduleLoop`)

Started as `thread_ = std::thread(&Schedule::ScheduleLoop, this)`, both at construction and again
by `AddTask()` if the loop had stopped (it stops when `steps_` last emptied out and
`threadRunning_` was left false — `AddTask()` restarts it before inserting the new task's root
steps). Per iteration, actual locking (from `schedule.cxx`):

```
lockThread_.lock()
  SearchTasksToRun()                          -- calls Executor::FindRunnableSteps() per executor
lockThread_.unlock()

for step in toRun: step->Execute()            -- fork/exec, UNLOCKED
stepsRunning_ += toRun; monitor_.Add(toRun)
LimitRessourcesUsages()                       -- reads OS load; may call CancelTask() (re-locks internally)

lockThread_.lock()
  SaveStatus(true)                            -- write tasksmanager.json + status.json
lockThread_.unlock()

sleep(500ms)

for executor: executor->CheckFinishedSteps(stepsRunning_)   -- waitpid(WNOHANG), UNLOCKED
for step in stepsRunning_: IsTimedOut() check -> KillAndMarkTimedout()   -- UNLOCKED, may Shutdown() (blocking waitpid inside)
monitor_.GetChange()                          -- drains inotify messages, UNLOCKED

lockThread_.lock()
  scan steps_ for request_cancel_ -> KillAndMarkCancel()/MarkCancel()
  ProcessDelayedCleanup() / monitor_.Remove(stepsDone_) / ManageEndOfStep() for each done step
lockThread_.unlock()
```

`ManageEndOfStep()` runs under `lockThread_` and calls `Task::FinalizeAndArchive()` (renames
directories, writes the task JSON — filesystem I/O, but no HTTP or archive-compression work) and
`Archiver::AddJob()` (just pushes onto the archiver's own queue and returns) — the actual `zip`
subprocess and HTTP publish happen later, entirely on the Archiver thread, never under
`lockThread_`.

`AddTask()` (HTTP thread) takes `lockThread_` to insert the new task's root steps into `steps_` in
priority order and to restart the loop thread if needed. It first checks `stopping_`
(`std::atomic<bool>`, set as the very first action of `~Schedule()`): a submission still in flight
when the stop begins is refused ("The scheduler is stopping…") instead of adding a task to a
scheduler that is going away.

`lockThread_` is a `std::timed_mutex`, so that `ProbeLock(timeoutMs, waitedMs)` can measure how
long a submission would wait for it: `GET /api/health` calls it with a 2 s limit
(`try_lock_for`), releases it at once, and reports the wait (or that the lock could not be taken).

`ExecutorSetMaxCores()` (HTTP thread, `PATCH /api/executor/<name>/max_cores/...`) also takes
`lockThread_` before calling `Executor::SetMaxCores()`.

`CancelStep()`, `CancelTask()`, and `TaskUpdatePriority()` (HTTP thread, called from the API layer)
**do take `lockThread_`** (`std::lock_guard`) before scanning `steps_` and mutating
`Step::request_cancel_` / calling `Task::Cancel()` / reordering `steps_`. This differs from an
earlier design note claiming these were lock-free — in the current code they are not: they briefly
contend with the schedule loop's own locked sections, but never block on the unlocked
fork/exec/waitpid sections in between.

`Schedule::~Schedule()` sets `stopping_`, takes `lockThread_`, clears `threadRunning_`, releases
the lock to `join()` the loop thread, re-acquires it to call `tasksManager_.DeleteTasks()` and
delete every executor.

On its way out, `ScheduleLoop()` calls `ShutdownAtExit()` with `lockThread_` held: it collects the
running steps (when `shutdownTasksAtExit__` is set), **releases** `lockThread_`, shuts them down in
parallel (one `std::thread` per step, each costing the kill grace of its session plus its shutdown
script), joins them, waits for the archiver (`WaitForCompletion()`), then re-takes the lock. The
shutdowns used to run one after the other with the lock held.

`ManageEndOfStep()` (under `lockThread_`) records the step's duration with
`DurationHistory::Add()`, and `Executor::EstimatedStepsStartTime()` (also under `lockThread_`)
reads the estimates; `DurationHistory` guards its data with its own `lock_` (see the inventory).

### 3. inotify Monitor (`Monitor::Main`)

```cpp
Monitor::Monitor(path) {
  inotify_init1(IN_NONBLOCK | IN_CLOEXEC);
  inotify_add_watch(fd, path, IN_MOVED_TO);          // step scripts atomically mv into place
  thread_ = std::thread(&Monitor::Main, this, fd, wd);
}

void Monitor::Main(fd, wd) {
  loop:
    read(fd, buffer)                                  // may return EAGAIN (non-blocking fd)
    { lock_guard lock(lock_); if (!running_) break; }
    if EAGAIN: { unique_lock lk(lock_); cv_.wait_for(lk, 1s); continue; }
    parse IN_MOVED_TO events -> filenames
    { lock_guard lock(lock_); resolve filenames -> Step* via stepsList_ }
    GetMessage(path) for each resolved step             // file read, UNLOCKED
    { lock_guard lock(lock_); monitorsMessage_[step] = message }
}
```

- `Add(steps)` / `Remove(steps)` (called from the schedule loop) take `lock_` to insert/erase
  `stepsList_` entries (keyed by the monitor file's basename). `Remove()` also reads
  `step->message_from_run_ = GetMessage(...)` and deletes the monitor file, **outside** the lock.
- `GetChange()` (called from the schedule loop, unlocked context) takes `lock_`, swaps
  `monitorsMessage_` into a local map, and copies each message into the corresponding
  `Step::message_from_run_` — returns `true` if anything changed.
- `Shutdown()` (called from `~Monitor()`) takes `lock_`, clears `running_`, `cv_.notify_one()`,
  releases the lock, then joins. The read loop itself is woken by the notify only while it is
  inside the `EAGAIN` `cv_.wait_for` branch; a blocking `read()` in progress is instead unblocked
  because inotify delivers `length == 0`/`running_ == false` is checked right after each `read()`
  returns, whether from data or from the 1s wait timeout.

### 4. Archiver (`Archiver::ThreadLoop`)

```cpp
void Archiver::ThreadLoop() {
  while (threadRunning_.load()) {
    { unique_lock lock(queueMutex_);
      queueCV_.wait(lock, [] { return !jobs_.empty() || !threadRunning_; });
      job = move(jobs_.front()); jobs_.pop(); }
    ProcessJob(job);              // shells out to `zip`, then optional HTTP publish -- UNLOCKED
  }
}
```

- `AddJob(job)`: `lock_guard(queueMutex_)`, push, `queueCV_.notify_one()`.
- `PendingJobs()`: `lock_guard(queueMutex_)`, returns `jobs_.size()`.
- **`WaitForCompletion()`** (called once, from the end of `ScheduleLoop()` on shutdown) is a
  **busy-wait poll loop**, not a condition-variable wait: it repeatedly takes `queueMutex_`,
  checks `jobs_.size() == 0`, and if not, sleeps 100ms and retries. This is a real drift from a
  cleaner condition-variable design — worth knowing if archiver shutdown latency ever matters.
- `ProcessJob()` runs entirely outside any lock: it `popen()`s a `zip -r ...` shell command
  (not a linked compression library — `libarchive` is not used here) to build the archive, renames
  the temp file into place, optionally removes `deleteDir_`, and if `doPublish_` is set, calls
  `Publish::PublishResults()` synchronously on the same thread.

### 5. FD Capture (`FDCaptureThread` / `FDCaptureThreadImpl`)

Two distinct classes share the name "FD capture," each with its own mutex:

- **`FDCaptureThread`** — a thin per-step handle. `LocalData::fdCaptureThread_` is one of these,
  constructed with capacity 2 (stdout + stderr). It keeps its own `fds_`/`lockFDs_` mirror purely
  so `Read()` can look up the right buffer without touching the shared impl's lock.
- **`FDCaptureThreadImpl`** — the actual OS thread running `epoll_wait()`. It is **pooled**: a
  process-wide static list `FDCaptureThread::threadsPoll__` (guarded by
  `FDCaptureThread::threadsLock__`) hands out references to existing impls that still have spare
  `Load()` capacity (cap 8, so up to 4 concurrently-running steps × 2 fds share one impl) before
  spawning a new one. This means the number of live epoll threads scales with concurrent step
  count, not a fixed "one thread total."

```cpp
void FDCaptureThreadImpl::threadMain() {
  loop:
    epoll_wait(epollID_, events, -1)
    for each ready fd:
      if fd == stopFD_: return                      // shutdown eventfd
      if EPOLLERR|EPOLLHUP: RemoveFD(fd)
      if EPOLLIN|EPOLLPRI:
        { lock_guard lock(lockFDs_);                 // FDCaptureThreadImpl::lockFDs_
          read() in a loop until EAGAIN, forwarding each chunk to buffer->Write() }
}
```

- `AddFD(fd, buffer)` / `RemoveFD(fd)`: `lock_guard(lockFDs_)` + `epoll_ctl`, called from
  `Local::Execute()` / `Local::EndRun()` (schedule-loop-adjacent code, not the epoll thread itself).
- `Read(fd, data)` (via the outer `FDCaptureThread::Read`, called by
  `Local::GetRunningOutput()` from an HTTP handler thread): takes the outer `lockFDs_`, looks up
  the `OutputBuffer*`, then calls `buffer->Read(data)` which — for the only buffer type actually in
  use, `MemoryRing` — has its own independent `std::mutex lock_`. The epoll thread's `Write()` and
  an HTTP thread's `Read()` on the same `MemoryRing` therefore contend on `MemoryRing::lock_`, not
  on either `lockFDs_`.
- Shutdown: `~FDCaptureThreadImpl()` writes to an `eventfd` (`stopFD_`) and joins; this only
  happens when the pool's load for that impl instance drops to 0 (`~FDCaptureThread()` →
  `Unload()`).

### 6. System Monitor (`Linux::ThreadLoop`)

```cpp
void Linux::ThreadLoop() {
  while (ThreadWaitOrStop(time_interval_)) {     // sleeps in 1s increments, checks threadRunning_
    lock_.lock();
    cores_.Update(); memory_.Update();           // parse /proc/stat, /proc/meminfo
    lock_.unlock();
  }
}
```

- `GetLoad()` (called once per `Local::FindRunnableSteps()`, i.e. once per schedule-loop
  iteration, from the unlocked section) takes `lock_` around `cores_.CoresValuesRatio()` and
  `memory_.Stats()`; storage-space polling (`std::filesystem::space()`) happens outside the lock,
  per configured path.
- `Cores()` / `Memory()` accessors each take `lock_` independently for the duration of the call
  (they return const references while holding the lock only for the lookup itself — callers using
  the returned reference after the lock is released are relying on the referenced object not being
  mutated concurrently in a way that matters for their read, which holds in practice since
  `CoresMonitor`/`MemoryMonitor` are themselves internally locked, see `linux_cores.hxx`
  `CoreStats::lock_` / `CoresMonitor::lock_`).
- `~Linux()` sets `threadRunning_ = false` (atomic) and joins — no notify needed since
  `ThreadWaitOrStop` polls the flag every second.

### 7. Cache Worker (`Cache::CacheLoop`)

```cpp
void Cache::CacheLoop() {
  unique_lock lock(cacheThreadLock_);
  while (true) {
    cacheThreadCV_.wait(lock, [this] {
      return !threadRunning_ || !dataToAdd_.empty();
    });                                            // predicate wait: immune to lost/spurious wakeups
    if (dataToAdd_.empty()) break;                 // woke up because threadRunning_ went false
    dataToAdd.swap(dataToAdd_);
    lock.unlock();
      { lock_guard(dataLock_); insert stub FileInformations{full_=false} for each pending id }
      SaveData();                                  // write cache mapping JSON, UNLOCKED
      for each file: copy_file() (UNLOCKED I/O), then { lock_guard(dataLock_); mark full_=true }
      SaveData(); DeleteCopyLog();
    lock.lock();
  }
  threadRunning_ = false;                           // reasserted unlocked on the way out
}
```

- `Put(path, id, force, computeMD5)` (HTTP thread): calls `Get()` first (see below) to check for
  an existing entry, then `lock_guard(cacheThreadLock_)` to push a `FileToStore` onto
  `dataToAdd_` and notify the worker.
- `Get(id, path)` (HTTP thread, read path): `std::shared_lock(dataLock_)` — concurrent readers do
  not block each other; only `full_` (itself `std::atomic<bool>`) is checked without a second lock.
- `dataLock_` is a `std::shared_mutex`: `Get()` takes it shared, `CacheLoop()`'s mutations take it
  exclusive (`std::lock_guard<std::shared_mutex>`, i.e. always exclusive-mode from that call site —
  there is no shared/upgrade dance here, just plain mutual exclusion for writers against readers).
- `~Cache()` sets `threadRunning_ = false` under `cacheThreadLock_`, notifies, joins.

### 8. Folder Remover (`FolderRemover::ThreadLoop`)

The run folder of a finished task (checkouts and builds, several GB) used to be removed in place,
under `lockThread_`, which held up the schedule loop and the submissions waiting for it for
minutes.

- `Remove(path)` (called by `Task` when it deletes its run folder, under `lockThread_`) renames the
  folder next to itself (`.<name>.deleting`, instant), then pushes it onto `queue_` under `lock_`
  and notifies `cv_`. If the rename fails, it returns false and the caller removes the folder
  itself.
- The thread waits on `cv_` for a queued folder and deletes it entry by entry, outside `lock_`,
  checking `running_` (`std::atomic<bool>`) between two files: a stop does not wait for the end of
  a removal of several GB. What is left is removed at the next start (`RemoveLeftovers()`, called
  from the `Schedule` constructor).
- `UnknownFolders()` / `RemoveUnknown()` (`GET /api/runs/unknown`, `POST /api/runs/cleanup`, HTTP
  threads) list and remove the folders of tasks the scheduler no longer holds; they compare with
  `TasksManager::TaskIDs()` (under `TasksManager::lock_`).
- `~FolderRemover()` (static singleton, at process exit) clears `running_` under `lock_`, notifies,
  joins.

---

## Full Lock / Atomic Inventory

Built from the grep above plus reading every call site — not carried over from any prior document.

| Symbol | Type | Owning class | Protects | Contention pattern |
|--------|------|---------------|----------|---------------------|
| `lockThread_` | `std::timed_mutex` | `Schedule` | `steps_`, `stepsRunning_`, `stepsDone_`, `tasksManager_` mutations, `threadRunning_` | HTTP threads (`AddTask`, `CancelStep`, `CancelTask`, `TaskUpdatePriority`, `ExecutorSetMaxCores`; `ProbeLock` for `/api/health`, which only tries it for up to 2 s) vs. the schedule loop's own locked sections |
| `Schedule::stopping_` | `std::atomic<bool>` | `Schedule` | "The stop has begun" | Set by `~Schedule()`, read by `AddTask()` (HTTP thread) without the lock |
| `DurationHistory::lock_` | `mutable std::mutex` | `DurationHistory` (singleton) | `durations_` (the samples) and the writes of `duration_history.json` | `Add()` from `ManageEndOfStep()` vs. `Estimate()` / `EstimatedEnd()` from `EstimatedStepsStartTime()`, both under `lockThread_` |
| `Local::coresLock_` | `std::mutex` | `ns_Executor::Local` | Cores bookkeeping (`nbCoresUsed_`, the temporary maximum) and the `user.slice` cpuset derived from it | Schedule loop (`AssignCores`, `ReAssignCores`, `ReleaseCores`, `CheckMaxCoresExpiry`) vs. HTTP thread (`SetMaxCores`) vs. the step shutdowns running in parallel at exit (`ReleaseCores`) |
| `FolderRemover::lock_` | `std::mutex` | `FolderRemover` (singleton) | `queue_` | `Remove()` (schedule loop) vs. the remover thread |
| `FolderRemover::cv_` | `std::condition_variable` | `FolderRemover` | Wakes the remover thread when a folder is queued or on shutdown | `Remove()`/destructor notify vs. `ThreadLoop()` wait |
| `FolderRemover::running_` | `std::atomic<bool>` | `FolderRemover` | Loop continuation flag, also read between two files of a removal | Destructor vs. `ThreadLoop()` / `RemoveTree()` |
| `runningServer__` | `std::atomic<Poco::Net::HTTPServer*>` | `ns_Server` (file scope) | The running HTTP server, for its counters | `MyServerApp::main()` (set/clear) vs. `/api/health` handler (`GetHTTPStats()`) |
| `TasksManager::lock_` | `std::mutex` | `TasksManager` | `tasks_` list, `next_task_id_` | HTTP thread (`CreateTask`, `GetTaskState`) vs. schedule loop (`DeleteTask`/`TaskEnded` via `ManageEndOfStep`, `LoadStatus` — currently unused) |
| `Task::metadata_index_lock_` | `std::mutex` | `Task` | Appends to `<artefacts_path_>/metadata.json` | Multiple steps of the same task finishing concurrently (`Local::SaveArtefacts`) |
| `Monitor::lock_` | `std::mutex` | `Monitor` | `stepsList_`, `monitorsMessage_`, `running_` | inotify thread vs. schedule loop (`Add`, `Remove`, `GetChange`) |
| `Monitor::cv_` | `std::condition_variable` | `Monitor` | Wakes the inotify thread's `EAGAIN` backoff wait early on shutdown | `Shutdown()` notify vs. `Main()` wait |
| `Archiver::queueMutex_` | `std::mutex` | `Archiver` | `jobs_` queue | Schedule loop (`AddJob`) vs. archiver thread; polled (not waited on) by `WaitForCompletion()` |
| `Archiver::queueCV_` | `std::condition_variable` | `Archiver` | Wakes the archiver thread when a job is queued or on shutdown | `AddJob`/destructor notify vs. `ThreadLoop` wait |
| `Archiver::threadRunning_`, `jobsProcessed_`, `jobsFailed_` | `std::atomic` | `Archiver` | Loop continuation flag, counters | Set by destructor / `ThreadLoop`, read anywhere without further locking |
| `FDCaptureThread::lockFDs_` | `std::mutex` | `FDCaptureThread` (per-step wrapper) | The wrapper's own `fds_` mirror | `AddFD`/`RemoveFD`/`Read` on the same step's wrapper (effectively single-threaded per step, since only the owning `Local` code and the HTTP-triggered `GetRunningOutput` call it) |
| `FDCaptureThreadImpl::lockFDs_` | `std::mutex` | `FDCaptureThreadImpl` (pooled, shared) | The shared `fd -> OutputBuffer` map actually iterated by `epoll_wait` | epoll thread vs. `AddFD`/`RemoveFD` callers (potentially several steps sharing one impl) |
| `FDCaptureThread::threadsLock__` | `std::mutex` (static) | `FDCaptureThread` | The static pool `threadsPoll__` | Every step's constructor/destructor when joining/leaving the shared-impl pool |
| `MemoryRing::lock_` | `std::mutex` | `MemoryRing` | `buffer_`, `bufferStart_`, `virtualSize_`, `full_` | epoll thread (`Write`) vs. HTTP thread (`Read`, via `GetRunningOutput`) vs. the flush-on-destruction `Read()` call in `~MemoryRing()` |
| `Linux::lock_` | `std::mutex` | `ns_System::Linux` | `cores_` / `memory_` monitor state | System-monitor thread (`ThreadLoop`) vs. `GetLoad()`/`Cores()`/`Memory()` callers (schedule loop via `Local::GatherStats`, `Local::CGroupMemoryUsed` indirectly via `os_.Memory()`) |
| `Linux::threadRunning_` | `std::atomic<bool>` | `ns_System::Linux` | Loop continuation flag | Destructor vs. `ThreadLoop`/`ThreadWaitOrStop` |
| `CoreStats::lock_` (static) | `std::mutex` | `ns_System::CoreStats` | Lazily-initialised static `nb_cores__`/`nb_values_per_core__` | Any first caller of `CoreStats::NbCores()`/`NbInfoPerCores()` (e.g. `LocalConfig` construction, `Local::Validate`) |
| `CoresMonitor::lock_` | `mutable std::mutex` | `ns_System::CoresMonitor` | Internal ratio buffers | `Update()` vs. `SelectMostIdleCores()`/`CoresValuesRatio()` |
| `MemoryMonitor::lock_` | `mutable std::mutex` | `ns_System::MemoryMonitor` | Internal memory stats | `Update()` vs. `Stats()` (called under `Linux::lock_` already, so this is largely a second layer of the same protection) |
| `Cache::dataLock_` | `std::shared_mutex` | `Cache` | `data_` map | `Get()` (shared) vs. `CacheLoop()` mutations (exclusive) |
| `Cache::cacheThreadLock_` | `std::mutex` | `Cache` | `dataToAdd_`, `threadRunning_` | `Put()`/destructor vs. `CacheLoop()` |
| `Cache::cacheThreadCV_` | `std::condition_variable` | `Cache` | Wakes the cache worker | `Put()`/destructor notify vs. `CacheLoop()` wait |
| `Cache::FileInformations::full_` | `std::atomic<bool>` | `Cache` (per entry) | Whether a cache entry's file copy has completed | Read by `Get()` under `dataLock_` (shared), written by `CacheLoop()` under `dataLock_` (exclusive) — the atomic is arguably redundant given the surrounding lock, but harmless |
| `UsersAPI::lockDB_` | `std::shared_mutex` | `UsersAPI` | `doc_` (the in-memory users/tasks JSON document) | Task creation/completion (`Add()`, exclusive) vs. API reads (`Users()`, `UserJobTypes()`, `UserTasks()`, shared) |
| `Step::next_uuid_` | `std::atomic<uint64_t>` (static) | `Step` | Global UUID counter | Every `Step` constructor, potentially from the HTTP thread (`AddTask` → `CreateStepsFromJson`) and, historically, the reload path — currently only ever called from one thread at a time in practice since task creation happens under `TasksManager::lock_`/`Schedule::lockThread_`, but the type is atomic regardless |
| `Task::request_cancel_`, `Step::request_cancel_` | plain `bool` (no lock, no atomic) | `Task`/`Step` | Cancel flags | Written by `Task::Cancel()`/`Schedule::CancelStep()` **under `lockThread_`**, read by the schedule loop's cancel-scan **also under `lockThread_`** — unlike an earlier design note, these are not accessed lock-free; both the writer and the reader currently go through `lockThread_` |

---

## Deadlock Avoidance

- No nested locking across subsystems: `lockThread_`, `Monitor::lock_`, `Archiver::queueMutex_`,
  `Cache::dataLock_`/`cacheThreadLock_`, `UsersAPI::lockDB_`, and `Linux::lock_` are never held
  simultaneously by the same thread. Each subsystem's public methods take and release their own
  lock before returning or before calling into another subsystem.
- `lockThread_` is never held across `fork()`/`execv()`, `waitpid()`, `zip`/`popen()`, or any
  filesystem-heavy archive step — those are pushed to the Archiver thread (`AddJob` just enqueues)
  or run in the schedule loop's unlocked sections.
- `FDCaptureThread::lockFDs_` and `FDCaptureThreadImpl::lockFDs_` are distinct mutexes on distinct
  objects; a caller through the outer wrapper never holds both at once — `Read()` releases the
  outer lock's critical section (it's a `lock_guard` scoped to the lookup) before the buffer's own
  `MemoryRing::lock_` is taken inside `buffer->Read()`.
- `Linux::lock_` and the inner `CoresMonitor::lock_`/`MemoryMonitor::lock_` do nest (`GetLoad()`
  takes `Linux::lock_` then calls into `cores_.CoresValuesRatio()`/`memory_.Stats()`, which take
  their own inner locks) — this is a single consistent outer→inner order used everywhere those
  types are touched, so it does not create a cycle.
- `DurationHistory::lock_`, `Local::coresLock_` and `FolderRemover::lock_` are leaf locks: taken
  under `lockThread_` (or alone), never the other way round, and the code holding them calls no
  other subsystem.

---

## Shutdown Sequence

```
1. Poco HTTPServer stops (server.stopAll(true), after waitForTerminationRequest()): it stops
   accepting connections and also closes the open keep-alive ones; a plain stop() left them
   served, and the pool's destructor then waited up to 10 s for each busy thread
2. ~ScheduleAPI() -> ~Schedule():
     stopping_ = true (submissions still in flight are refused);
     lockThread_.lock(); threadRunning_ = false; unlock(); thread_.join();
     -- ScheduleLoop(), upon seeing threadRunning_ == false, exits its while loop, and before
        returning: SaveStatus(true); ShutdownAtExit(): releases lockThread_, and if
        shutdownTasksAtExit__ (toggled by SIGUSR1) shuts every still-running step down in
        parallel (one thread each); archiver_.WaitForCompletion() (busy-wait poll, see above);
        re-takes lockThread_
     lockThread_.lock(); tasksManager_.DeleteTasks(); delete every executor; unlock()
     -- ~Monitor() (member of Schedule, destroyed after Schedule's own body): Shutdown() -> join
     -- ~Archiver() (member of Schedule): sets threadRunning_ = false, notifies, joins
        (a second, redundant stop after WaitForCompletion() already drained the queue)
3. ~Cache(): threadRunning_ = false under cacheThreadLock_, notify, join
4. ~Linux(): threadRunning_.store(false), join (loop wakes within at most 1s via ThreadWaitOrStop)
5. Any still-referenced LocalData objects' ~FDCaptureThread() decrement the shared pool's load;
   the last user of a given FDCaptureThreadImpl triggers its destructor (eventfd write + join)
6. At process exit, the static FolderRemover singleton: running_ = false, notify, join (a removal
   in progress stops after its current file; the rest is removed at the next start)
```

`Schedule::HandlerUSR1` (installed once via `sigaction(SIGUSR1, ...)`) flips a static
`shutdownTasksAtExit__` flag — when true (the default), a normal shutdown kills every still-running
step before the process exits; toggling it off via `SIGUSR1` lets running steps survive a scheduler
restart attempt (though, per [task-step-lifecycle.md](task-step-lifecycle.md), the reload path
that would reattach to them on the next start is currently disabled, so in practice they become
orphaned processes rather than being picked back up).
