📦 restsrv.publisher

A C++ REST server that processes experiment result archives and exposes them as structured JSON for web dashboards.

It accepts archives (`.zip`, `.tgz`) and metadata files (`.json`) submitted by the scheduler or other clients, processes them through a configurable rule engine, generates JSON result files, and serves them to a web interface.

✨ Key Features

    Asynchronous Processing: Archives are validated and queued immediately — `POST /api/notify` returns at once. Processing happens in a dedicated background thread.

    Rule-Based Engine: `.rules` JSON files map archive path patterns (regex) to processing actions. Rules can be placed in subdirectories for fine-grained per-zone matching.

    Generic JSON Merge: The `GenerateMergeJSON` action extracts a JSON file from an archive and merges it into a persistent output file using a fully configurable strategy (comparator, field, keep, merge keys). Adding a new report type requires only a new `.rules` entry — no recompilation.

    Content-Addressed Index: Processed results are tracked in a per-project `.index.json`; already-processed files are skipped automatically by the periodic scanner, but can be reprocessed on demand via `POST /api/notify`.

    Optional TLS: Plain HTTP and HTTPS modes, configurable via a single JSON file.

    Path Traversal Protection: All file access uses `std::filesystem::canonical()` to confine paths to their allowed directory.

🛠 Technology Stack

    Core: C++17 / Linux

    Networking: Poco C++ Libraries (HTTP/HTTPS server & routing)

    Serialization: RapidJSON (configuration & API responses)

    Compression: libarchive (archive extraction) + ZStd (seekable `.tar.zst` archives)

    Dashboard: web files (HTML/CSS/JS) are served from `htmlPath` — managed externally by the web interface project

🌐 API Endpoints

| Method | Path | Description |
|---|---|---|
| POST | `/api/notify` | Submit archives for asynchronous processing |
| GET | `/api/project/{name}/data` | List processed result files for a project |
| GET | `/api/project/{name}/campaigns` | List campaigns available for a project |
| POST | `/api/project/{name}/regenerate_cache` | Drop index and reprocess all archives from scratch |
| DELETE | `/api/project/{name}/data/{file}` | Remove a result file from index and disk |
| GET | `/files/{path}` | Download a file from storage (with `index` routing for project roots) |
| GET | `/html/{path}` | Download a static file from `htmlPath` |

All endpoints include `Access-Control-Allow-Origin: *` and respond to CORS preflight (`OPTIONS`). See `docs/api.md` for the full reference.

⚙️ How It Works

    Submission: A client (typically the scheduler) POSTs a `multipart/form-data` request to `/api/notify` with `dst` (full directory path relative to `storagePath`, e.g. `my_project/PR/abc1234/Perf`) and one or more `src` filenames.

    Queuing: Paths are validated (existence, confinement within `storagePath`) and enqueued in the `Publish` background thread. The HTTP response is immediate.

    Rule matching: The `Publish` thread wakes up, looks up the project's `.rules` files, and matches each archive path against the defined regex patterns. All matching rules are applied for notified files.

    Processing: The matched rule action (`GenerateMergeJSON`) extracts a JSON file from the archive, merges it into a persistent output file under `storagePath/<project>/.project/` using the configured strategy, and updates `.index.json` atomically.

    Serving: The web interface (or any HTTP client) calls `GET /api/project/{name}/data` for the list of result files, then fetches each file individually via `GET /files/`.

📂 Architecture at a Glance

    HTTP Server Layer (`server/`): REST routing, CORS, and request handlers using Poco.

    Public API (`api/`): `PublishAPI` and `APIS` facades connecting HTTP handlers to the publish engine.

    Publish Engine (`publish/`): `Publish` background thread, `Project` data directories, `Rule` subclasses (`RuleMergeJSON`, `RuleNULL`), `Index` persistence.

See `docs/architecture.md` for the full design documentation and `docs/components.md` for the component reference.

🔨 Building

**Prerequisites:** CMake ≥ 3.5, Git, a C++17 compiler, OpenSSL (`libssl-dev`).

All other dependencies (Poco, RapidJSON, libarchive, zlib, ZStd) are fetched and built automatically during the first CMake configuration.

    cmake -B build -DCMAKE_BUILD_TYPE=Release
    cmake --build build --target publisher -j$(nproc)

This produces two binaries:
- `publisher` — dynamically linked
- `publisher-static` — fully static binary (suitable for deployment without shared libs)

See `docs/build.md` for the full build reference and dependency management details.

🚀 Running

**First run — generate a default config:**

    ./publisher

If `publisher_config.json` does not exist, a default configuration is written and the process exits. Edit the file to set `storagePath` and `htmlPath`, then restart.

**Start the server:**

    ./publisher publisher_config.json

The server listens on port `10083` by default. Web files (HTML/CSS/JS) are **not** managed by the publisher — they must be deployed separately into `htmlPath` by the web interface project.

See `docs/configuration.md` for the full configuration reference and `docs/user_guide.md` for end-to-end usage including project setup and archive submission.

---

📚 Documentation

- [API reference](docs/api.md)
- [Architecture](docs/architecture.md)
- [Components](docs/components.md)
- [Configuration](docs/configuration.md)
- [Build system](docs/build.md)
- [User guide](docs/user_guide.md)
- [Roadmap](docs/roadmap.md)
