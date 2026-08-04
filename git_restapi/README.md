🔍 Git REST API Server

A lightweight, read-only C++ HTTP server that exposes Git repository data as structured JSON over a REST API.

Built for Linux environments, it allows external tools — dashboards, CI visualizers, reporting pipelines — to query commit history and metadata without requiring direct Git access. The binary is self-contained: the history generation script is embedded at build time and extracted automatically on first run.

✨ Key Features

    Read-Only REST API: Three endpoints covering full branch history, single-commit lookup, and batch commit metadata retrieval.

    Per-Repository Cache: History results are cached per repository with a 24-hour TTL, persisted to disk and reloaded on startup, protected by a per-instance mutex.

    Self-Contained Binary: The `tlspuffin_history.sh` script is compiled into the binary and auto-installed at startup — no manual deployment of scripts required.

    Optional TLS: Plain HTTP and HTTPS modes, configurable via a single JSON file.

    Safe JSON Error Responses: All error payloads are serialized through RapidJSON, ensuring correct escaping regardless of the error message content.

🛠 Technology Stack

    Core: C++17 / Linux

    Networking: Poco C++ Libraries (HTTP/HTTPS server & routing)

    Serialization: RapidJSON (configuration & API responses)

    Git operations: Git CLI via subprocess (`popen` / `std::system`)

    History generation: embedded Bash script (`tlspuffin_history.sh`), requires `git` and `jq` at runtime

🌐 API Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/api/git/history/:repo` | Full branch history: dev commits, main commits, local branches, and optionally GitHub PRs |
| GET | `/api/git/log/:repo?commit=HASH` | Metadata for a single commit |
| POST | `/api/git/logs/:repo` | Metadata for a batch of commits |

All responses are JSON. All endpoints support CORS, including a dedicated `OPTIONS` preflight handler. See `docs/api.md` for the full reference.

⚙️ How It Works

    Startup: For each configured repository, the server runs `git fetch --all`, falling back to `git clone --filter=blob:none` on first run. All repositories must be reachable before the server starts accepting connections.

    History (`GET /api/git/history`): Runs the embedded `tlspuffin_history.sh` script against the local clone and caches the result for 24 hours (persisted to disk, reloaded on startup). Returns commits on `dev`, a range of `main` commits, local branches not yet merged, and optionally open GitHub pull requests when `url_pr` is configured for the repository.

    Log lookup (`GET /api/git/log`, `POST /api/git/logs`): Runs `git log --no-walk` against the local clone and returns full commit hash, date, and commit message for each requested commit, plus its merge-base with `origin/dev`.

📂 Architecture at a Glance

    HTTP Server Layer (`server/`): REST routing, CORS, and request handlers using Poco.

    API Bridge (`api/`): Owns the map of per-repository `GitAPI` instances.

    Git Backend (`git/`): Each `GitAPI` instance manages one local clone, serializes subprocess calls via a mutex, and maintains the response cache.

See `docs/architecture.md` for the full design documentation and `docs/components.md` for the component reference.

🔨 Building

**Prerequisites:** CMake ≥ 3.21, Git, a C++17 compiler, and OpenSSL development headers (`libssl-dev` or equivalent). At runtime: `git` and `jq` must be on `PATH`.

All other dependencies (Poco, RapidJSON) are fetched from their upstream repositories and built automatically during the first CMake configuration.

    cmake -B build -DCMAKE_BUILD_TYPE=Release
    cmake --build build -j$(nproc)

This produces two binaries in `build/`:
- `git_restapi` — Poco/RapidJSON linked statically, libgcc/libstdc++ linked dynamically
- `git_restapi-static` — same, plus `-static-libgcc -static-libstdc++` for deployment without matching system runtime libs

See `docs/build.md` for the full build reference.

🚀 Running

**First run — generate a default config:**

    ./git_restapi

If `git_restapi-config.json` does not exist, a default configuration is written and the process exits. Edit the file to set your repository URL and storage path, then restart.

**Start the server:**

    ./git_restapi git_restapi-config.json

**Force-reinstall the embedded script (server starts normally afterward):**

    ./git_restapi --force-install

**Install/validate only (create storage & scripts directories, install the script) and exit without starting the server or touching any repository:**

    ./git_restapi --only-install

See `docs/configuration.md` for the full configuration reference.

---

📚 Documentation

- [API reference](docs/api.md)
- [Architecture](docs/architecture.md)
- [Components](docs/components.md)
- [Configuration](docs/configuration.md)
- [Build system](docs/build.md)
- [Roadmap](docs/roadmap.md)

---

Note: The server clones all configured repositories to local disk at startup. A blobless clone (`--filter=blob:none`) is used to minimize disk usage for large repositories.
