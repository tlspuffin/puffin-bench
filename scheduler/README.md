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

    Compression: `zip` CLI (invoked via `popen()`) for writing task archives; libarchive for reading them back (log extraction)

🌐 API Endpoints

| Method | Path | Description |
|---|---|---|
| POST | `/api/task/new` | Submit a new task (multipart: flow JSON + script) |
| GET | `/api/tasks/running` | Snapshot of all tasks and steps |
| GET | `/api/task/<id>/...` | Step output, final state, artefacts |
| PATCH | `/api/task/<id>/<priority>` | Update a task's scheduling priority |
| DELETE | `/api/task/<id>` | Cancel a task |
| DELETE | `/api/task/<id>/step/<stepUUID>` | Cancel a single step (`stepUUID` is the step's globally-unique `uuid_`, not its per-task `step_id_`) |
| GET/PUT | `/api/cache/<id>` | Store or retrieve a cached file |
| GET | `/api/users`, `/api/user/...` | User and job-type tracking |
| GET | `/files/*` | Static file serving (dashboard, scripts) |

Note: no route actually handles `OPTIONS` today — every handler sends CORS headers on real requests, but preflight requests fall through to a 404. See `docs/api.md` for the full reference and this caveat in detail.

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

**Prerequisites:** CMake ≥ 3.21, Git, a C++17 compiler, `xxd` and `zip` (both required at configure time by unconditionally-included CMake helper scripts, even though neither is currently invoked by any embedding target), and OpenSSL development headers (`libssl-dev` or equivalent).

All other dependencies (Poco, RapidJSON, libarchive, zlib) are fetched from their upstream git repositories and built automatically during the first CMake configuration.

    cmake -B build -DCMAKE_BUILD_TYPE=Release
    cmake --build build -j$(nproc)

This produces two binaries in `build/`:
- `scheduler` — dynamically linked scheduler
- `scheduler-static` — same binary, statically linked against libgcc/libstdc++ (suitable for deployment without a matching libstdc++ on the target host)

There is no `cmake --install` target; deployment is a manual copy of the binary, a `config.json`, and (for systemd) the files under `samples/system/`. See `docs/build.md` for the full build reference.

🚀 Running

**First run:**

`config.json` must exist and six directories it points at must already exist on disk — the process extracts embedded files into some of them but does not create the directories themselves (a missing one aborts the process with an explicit `filesystem_error` naming the path, one at a time). From a repository checkout (where `html/` and `scripts/` already exist as source):

    mkdir -p tools runs users_data exports cache
    ./scheduler config.json                    # no config.json yet: writes a default one and exits — run again
    ./scheduler config.json --only-install      # extracts the embedded board dashboard and step-runner scripts, exits
    ./scheduler config.json                     # starts the server

`--force-install` (combinable with `--only-install`) overwrites embedded files that already exist; without it, only missing files are (re)written. See `docs/configuration.md` (First Run / Required Directories) for the full explanation, including the binary-only deployment case.

**Start the server:**

    ./scheduler config.json

**Open the board dashboard:**

    http://<host>:<port>/files/board/board.html

The dashboard polls `GET /api/tasks/running` automatically and shows running tasks, step progress, monitor messages, and live stdout/stderr.

**Submit a job from the dashboard:**

The `+` button opens `html/board/launchers/launchers.js`, a generic per-project plugin loader — not a fixed job launcher. It reads a project registry from `./config.js` (`config.projects`) and dynamically imports a `joblauncher.js` module per project. Neither `config.js` nor any project subfolder ships in this repository; you supply them yourself under `html/board/launchers/<project>/` to add a launcher UI without recompiling the server. See `docs/board-job-launcher.md` for the exact plugin contract, and `samples/jobs/tests/*.json` for example flow JSON that any launcher (or a plain `curl` to `POST /api/task/new`) can submit.

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
