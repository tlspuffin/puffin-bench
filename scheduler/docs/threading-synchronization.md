# Threading Model and Synchronization

## Thread Inventory

The server runs the following concurrent threads at steady state:

| Thread | Owner class | Purpose |
|--------|------------|---------|
| Poco HTTP worker pool | `MyServerApp` | Accept and serve HTTP requests |
| Schedule loop | `Schedule` | Dispatch steps, detect completion, manage resources |
| inotify monitor | `Monitor` | Watch monitor files for step status updates |
| Archiver | `Archiver` | Create `.tgz` archives and publish results |
| FD capture | `FDCaptureThreadImpl` | epoll over process stdout/stderr pipes |
| System monitor | `Linux` | Periodic `/proc/stat` and `/proc/meminfo` sampling |
| Cache worker | `Cache` | Copy files into the cache storage and compute MD5s |

---

## Thread Details

### 1. Poco HTTP Worker Pool

- Created and managed by Poco's `HTTPServer`.
- Each incoming connection is handled by one pool thread.
- Calls `RequestHandlerFactory::createRequestHandler()` which regex-matches the URI and instantiates the right handler.
- Handler calls into `ScheduleAPI`, `CacheAPI`, or `UsersAPI` — these all acquire their own locks internally.
- Pool threads are **read-only** w.r.t. scheduling state: they only enqueue work (via `Schedule::AddTask()`) or read already-serialised JSON.

### 2. Schedule Loop (`Schedule::ScheduleLoop`)

Started in `ScheduleAPI` constructor. Runs continuously until the server shuts down.

```cpp
void Schedule::ScheduleLoop() {
  while (threadRunning_) {
    { std::lock_guard lock(lockThread_);
      SearchTasksToRun();
      // ... execute, check finished, manage end of step
      SaveStatus();
    }
    std::this_thread::sleep_for(loopSleepMs);
  }
}
```

- Holds `lockThread_` for the entire body of each iteration.
- **AddTask()** (called from HTTP thread) also acquires `lockThread_` before inserting into `tasks_`.
- **CancelTask()** / **CancelStep()** set an atomic flag on the Task/Step without acquiring `lockThread_` — they are deliberately lock-free so cancellation is instantaneous.

### 3. inotify Monitor (`Monitor::Main`)

```
thread:
  inotify_init1(IN_CLOEXEC)
  inotify_add_watch(fd, monitorsPath_, IN_CLOSE_WRITE)
  loop:
    read(fd, events)
    for each event:
      filename → step lookup in stepsList_
      read monitor file content
      { lock_guard lock(lock_); }
        monitorsMessage_[step] = content
        changed_ = true
      cv_.notify_all()
```

- **Add(step)** / **Remove(step)** acquire `lock_` to update `stepsList_` and `monitorsMessage_`.
- **GetChange()** acquires `lock_`, reads `changed_`, resets it, returns bool.
- Coordination with the schedule loop: `GetChange()` is called inside the loop; the inotify thread only writes to the message map.

### 4. Archiver (`Archiver::ThreadLoop`)

```
thread:
  while (threadRunning_):
    { unique_lock lk(queueMutex_); }
    queueCV_.wait(lk, [&]{ return !jobs_.empty() || !threadRunning_; })
    job = jobs_.front(); jobs_.pop();
    lk.unlock()
    ProcessJob(job)   // libarchive .tgz + optional HTTP publish
```

- **AddJob()** (called from schedule loop): `lock_guard(queueMutex_)`, push, `queueCV_.notify_one()`.
- **WaitForCompletion()** (called at shutdown): spins on `PendingJobs()`.
- `ProcessJob` runs entirely outside any lock — it does I/O only on its own copy of `ArchiveJob`.

### 5. FD Capture (`FDCaptureThreadImpl`)

```
thread:
  epoll_fd = epoll_create1(0)
  loop:
    epoll_wait(epoll_fd, events, timeout)
    for each ready fd:
      { lock_guard lk(lockFDs_); }
        buf = fds_[fd]
      lk.unlock()
      buf->Write(readBytes)
```

- **AddFD(fd, buffer)** / **RemoveFD(fd)**: `lock_guard(lockFDs_)` + `epoll_ctl`.
- **Read(fd, offset, size)**: `lock_guard(lockFDs_)` to retrieve buffer pointer, then calls `buffer->Read()` which has its own internal lock (MemoryRing) or is file-based (FileRing).
- One `FDCaptureThreadImpl` instance is shared across all concurrent steps of the same executor.

### 6. System Monitor (`Linux::ThreadLoop`)

```
thread:
  while (running_):
    { lock_guard lk(lock_); }
      cores_.Update()    // parse /proc/stat
      memory_.Update()   // parse /proc/meminfo
    sleep(time_interval_)
```

- **GetLoad()**: `lock_guard(lock_)`, returns snapshot.
- Called from the schedule loop (via `LimitRessourcesUsages()`) and from `Local::GatherStats()`.

### 7. Cache Worker (`Cache::CacheLoop`)

```
thread:
  while (threadRunning_):
    { unique_lock lk(cacheThreadLock_); }
    cacheThreadCV_.wait(lk, ...)
    drain dataToAdd_ under lock into local batch
    lk.unlock()
    for each file in batch:
      copy file to storagePath_
      compute MD5 if requested
      { unique_lock wl(dataLock_); }
        data_[id] = { path, md5, full=true }
      wl.unlock()
    SaveData()
```

- **Put(path, id, …)**: `unique_lock(dataLock_)` to insert stub with `full=false`, push to `dataToAdd_`, notify worker.
- **Get(id, &path)**: `shared_lock(dataLock_)` — multiple readers concurrently.
- `dataLock_` is a `shared_mutex`: reads are non-blocking against each other; writes (Put, CacheLoop update) are exclusive.

---

## Synchronization Summary

| Protected resource | Primitive | Contention pattern |
|-------------------|-----------|-------------------|
| `Schedule::tasks_`, step queues | `std::mutex lockThread_` | HTTP threads (AddTask) vs. schedule loop |
| `Monitor::stepsList_`, `monitorsMessage_` | `std::mutex lock_` | inotify thread vs. schedule loop (GetChange) |
| `Archiver::jobs_` | `std::mutex queueMutex_` | Schedule loop (AddJob) vs. archiver thread |
| `FDCaptureThreadImpl::fds_` | `std::mutex lockFDs_` | epoll thread vs. HTTP (Read) vs. executor (AddFD/RemoveFD) |
| `Linux` cpu/mem data | `std::mutex lock_` | system monitor thread vs. schedule loop |
| `Cache::data_` | `std::shared_mutex dataLock_` | cache worker (write) vs. many readers |
| `Cache::dataToAdd_` | `std::mutex cacheThreadLock_` | Put() vs. cache worker |
| `UsersAPI::doc_` | `std::shared_mutex lockDB_` | task creation (write) vs. API reads |
| `MemoryRing::buffer_` | `std::mutex lock_` | FDCapture (write) vs. GetRunningOutput (read) |
| `Task::request_cancel_` | `bool` (no lock) | Cancel() write vs. schedule loop read — benign race (flag only set once) |

---

## Deadlock Avoidance

- No nested locking: each shared resource has exactly one lock; no code acquires two locks simultaneously.
- `lockThread_` in the schedule loop is never held while calling into external I/O (file operations, libarchive, HTTP). These are all delegated to the Archiver thread or done after releasing the lock.
- `FDCaptureThread::Read()` releases `lockFDs_` before accessing the buffer, which has its own separate lock — correct ordering by separation.

---

## Shutdown Sequence

```
1. HTTP server stops accepting new connections (Poco destructor)
2. Schedule::ScheduleLoop() — threadRunning_ = false, join thread
3. Archiver::WaitForCompletion() — drain remaining archive jobs
4. FDCaptureThread — destructor stops epoll thread
5. Monitor — destructor stops inotify thread
6. Cache — destructor stops cache worker
7. Linux monitor — destructor stops system monitor thread
```

All threads use an `atomic<bool> threadRunning_` pattern: the thread checks the flag at each iteration, and the destructor sets it to `false` then joins. Condition variable threads receive an additional `notify_all()` to unblock a waiting `wait()`.
