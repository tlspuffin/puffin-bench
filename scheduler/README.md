🚀 C++ Task Scheduler & Orchestrator

An experimental C++ HTTP server designed to orchestrate multi-step workflows, manage local CPU resources, monitor execution in real-time, and archive results via a REST API.

Built for Linux environments, it provides precise control over task execution, resource allocation, and artifact management without the overhead of heavy containerization.

✨ Key Features

    DAG-Based Workflows: Define complex tasks with parallel sub-tasks and explicit sequencing.

    Precise Resource Management: Executes steps using local fork/exec with Linux cgroup v2 and CPU core affinity for strict resource isolation.

    Real-Time Monitoring: Uses low-overhead Linux inotify and an epoll-based multiplexer to stream stdout/stderr and monitor step progress instantly.

    Content-Addressed Caching: Smart caching system allows workflows to skip redundant recompilations or computations based on file MD5 hashes.

    Asynchronous Archiving: Automatically packages completed (or failed) task logs and artifacts into .tgz archives in a background thread, with optional publishing to remote servers.

🛠 Technology Stack

    Core: C++17 / Linux Native APIs (inotify, cgroup v2, /proc)

    Networking: Poco C++ Libraries (HTTP Server & Routing)

    Serialization: RapidJSON (Configuration & State management)

    Compression: libarchive (for extraction) & system tar (for archiving)

⚙️ How It Works

    Submission: A client submits a task (JSON workflow + scripts) via the POST /api/task/new endpoint.

    Scheduling: The scheduling engine parses the workflow Directed Acyclic Graph (DAG) and allocates CPU cores based on /proc/stat load.

    Execution: The Local executor forks the process, applies cgroup limits, and runs the step.

    Monitoring: Progress is written to monitor files (watched via inotify) and state is continuously persisted to a tasksmanager.json file.

    Completion: Artifacts and logs are gathered, archived asynchronously into a .tgz file, and moved to the export directory.

📂 Architecture at a Glance

The system is decoupled into three main layers:

    HTTP Server Layer (server/): Handles REST API routing and CORS using Poco.

    Domain APIs (api/): Bridges HTTP handlers with the core scheduling and caching logic.

    Core Engine (schedule/ & executor/): The main non-blocking scheduling loop, task lifecycle manager, and local execution backend.


🌐 Web Dashboard

The scheduler ships with a built-in browser dashboard for submitting and monitoring tasks.

**First run — install static files:**

    ./scheduler --install

This extracts the embedded board files into the `html/board/` directory configured in `config.json`. Run once, or with `--force-install` to overwrite existing files.

**Start the server:**

    ./scheduler config.json

**Open the board:**

    http://<host>:<port>/files/board/board.html

The dashboard polls `GET /api/tasks/running` automatically and shows running tasks, step progress, monitor messages, and live stdout/stderr.

**Submit a job:**

Click the `+` button to open the job launcher. Select a job type, pick or paste a commit hash, then click **Launch Task**. The available job types are defined in `html/board/jobs_config.json` — edit that file to add new job types without recompiling. Each entry points to a flow JSON and a step script served from `html/jobs_scripts/`.

See `docs/board-job-launcher.md` for the full `jobs_config.json` format and campaign mode options.

---

Note: This scheduler is optimized for Linux environments and relies on native OS features for process isolation and hardware monitoring.
