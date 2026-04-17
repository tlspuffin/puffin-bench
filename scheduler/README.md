🚀 C++ Task Scheduler & Orchestrator

An experimental C++ HTTP server designed to orchestrate multi-step workflows, manage local CPU resources, monitor execution in real-time, and archive results via a REST API.

Built for Linux environments, it provides precise control over task execution, resource allocation, and artifact management without the overhead of heavy containerization.

✨ Key Features

    DAG-Based Workflows: Define complex tasks with parallel sub-tasks and explicit sequencing via a JSON flow definition.

    Precise Resource Management: Executes steps using local fork/exec with Linux cgroup v2 and CPU core affinity for strict resource isolation.

    Real-Time Monitoring: Uses low-overhead Linux inotify and an epoll-based multiplexer to stream stdout/stderr and monitor step progress instantly.

    Content-Addressed Caching: Smart caching system allows workflows to skip redundant recompilations or computations based on file MD5 hashes.

    Asynchronous Archiving: Automatically packages completed (or failed) task logs and artifacts into `.zip` archives in a background thread, with optional publishing to remote servers.

    Web Dashboard: Built-in browser dashboard for submitting and monitoring tasks — served as static files embedded in the binary.

🛠 Technology Stack

    Core: C++17 / Linux Native APIs (inotify, cgroup v2, /proc)

    Networking: Poco C++ Libraries (HTTP Server & Routing)

    Serialization: RapidJSON (Configuration & State management)

    Compression: libarchive (read & write)

🌐 API Endpoints

| Method | Path | Description |
|---|---|---|
| POST | `/api/task/new` | Submit a new task (multipart: flow JSON + script) |
| GET | `/api/tasks/running` | Snapshot of all tasks and steps |
| GET | `/api/task/<id>/...` | Step output, final state, artefacts |
| DELETE | `/api/task/<id>` | Cancel a task |
| DELETE | `/api/task/<id>/step/<uuid>` | Cancel a single step |
| GET/PUT | `/api/cache/<id>` | Store or retrieve a cached file |
| GET | `/api/users`, `/api/user/...` | User and job-type tracking |
| GET | `/files/*` | Static file serving (dashboard, scripts) |

All endpoints support CORS preflight (`OPTIONS`). See `docs/api.md` for the full reference.

⚙️ How It Works

    Submission: A client submits a task (JSON workflow + scripts) via `POST /api/task/new`.

    Scheduling: The scheduling engine parses the workflow Directed Acyclic Graph (DAG) and allocates CPU cores based on `/proc/stat` load.

    Execution: The Local executor forks the process, applies cgroup limits, and runs the step script's bash function.

    Monitoring: Progress is written to monitor files (watched via inotify) and state is continuously persisted to a `tasksmanager.json` file.

    Completion: Artifacts and logs are gathered, archived asynchronously into a `.zip` file, and moved to the export directory. Optionally published to a remote server.

📂 Architecture at a Glance

    HTTP Server Layer (`server/`): Handles REST API routing and CORS using Poco.

    Domain APIs (`api/`): Bridges HTTP handlers with the core scheduling and caching logic.

    Core Engine (`schedule/` & `executor/`): The main non-blocking scheduling loop, task lifecycle manager, and local execution backend.

    Monitor (`schedule/monitor/`): inotify watcher surfacing real-time step status messages.

    Archiver (`schedule/archiver.hxx`): Background thread for `.zip` archive creation and result publishing.

    Cache (`cache/`): Content-addressed file store with persistent index.

See `docs/architecture.md` for the full design documentation and `docs/components.md` for the component reference.

🔨 Building

**Prerequisites:** CMake ≥ 3.21, Git, a C++17 compiler, `xxd` (for the `reserve_port` blob header), and OpenSSL development headers (`libssl-dev` or equivalent).

All other dependencies (Poco, RapidJSON, libarchive, zlib) are fetched from their upstream git repositories and built automatically during the first CMake configuration.

    cmake -B build -DCMAKE_BUILD_TYPE=Release
    cmake --build build -j$(nproc)

This produces two binaries in `build/`:
- `srv` — dynamically linked scheduler
- `srv-static` — fully static binary (suitable for deployment without shared libs)

See `docs/build.md` for the full build reference.

🚀 Running

**First run — install static files:**

    ./srv --install

This extracts the embedded board files into the `html/board/` directory configured in `config.json`. Run once, or with `--force-install` to overwrite existing files.

**Start the server:**

    ./srv config.json

**Open the board dashboard:**

    http://<host>:<port>/files/board/board.html

The dashboard polls `GET /api/tasks/running` automatically and shows running tasks, step progress, monitor messages, and live stdout/stderr.

**Submit a job from the dashboard:**

Click the `+` button to open the job launcher. Select a job type, pick or paste a commit hash, then click **Launch Task**. The available job types are defined in `html/board/jobs_config.json` — edit that file to add new job types without recompiling.

See `docs/configuration.md` for the full configuration reference.

---

📚 Documentation

- [API reference](docs/api.md)
- [Architecture](docs/architecture.md)
- [Components](docs/components.md)
- [Configuration](docs/configuration.md)
- [Build system](docs/build.md)
- [Roadmap](docs/roadmap.md)
- [Task & step lifecycle](docs/task-step-lifecycle.md)
- [Executor design](docs/executor.md)
- [Step script reference](docs/step-script-reference.md)
- [Monitoring, output, cache & archiver](docs/monitoring-output-cache.md)
- [Threading & synchronization](docs/threading-synchronization.md)
- [Board — job launcher](docs/board-job-launcher.md)

---

Note: This scheduler is optimized for Linux environments and relies on native OS features for process isolation and hardware monitoring.
