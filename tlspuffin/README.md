🧰 installer

A self-contained bootstrapper for the puffin-bench suite: it embeds copies of `scheduler`, `git_restapi`, `publisher`, and `vis_comparator` — dynamically-linked in the `installer` binary, statically-linked in `installer-static` — plus every web asset, job script, and config template each of them needs, and lays them all out on disk with a single command.

It also owns the tlspuffin-specific pieces that plug into the other projects' generic extension points: the step-script implementation the scheduler runs (`scripts/`, `data/tools/js/`), the job-launcher UI the scheduler's board loads per-project, and the results dashboard the publisher serves as `htmlPath`.

✨ Key Features

    Self-Contained Binary: embeds the 4 server binaries plus every web/job asset they need — a fresh machine needs nothing else cloned or installed to stand up the whole suite.

    Directory Bootstrap: creates every runtime directory (cache, runs, exports, scripts, publisher rules, users_data, ...) each service expects, so none of their own startup validation fails on a missing path.

    Templated Configs: `${VARIABLE}` substitution across 10 config/HTML/JS templates, wiring the 4 services' ports and paths together automatically from one set of CLI flags.

    tlspuffin Job Scripts + Dashboard: the concrete, ready-to-run instantiation of the scheduler's step-script contract and the publisher's per-project dashboard extension point — see the dedicated docs below.

    Idempotent, Re-runnable: skips files that already exist; `--force-files`/`--force-config` to overwrite binaries or configs after a rebuild.

🛠 Technology Stack

    Core: C++17 / Linux

    Embedding: assembler `.incbin` for the 4 large server binaries (avoids OOM-killing the compiler on an `xxd`-style C-array embedding), C string literals for text templates, `zip` + LibArchive for whole directory trees

    Compression: LibArchive (archive extraction at install time) + zlib

    Bundled Tools: QuickJS-ng's `qjs` CLI, embedded for the tlspuffin job scripts' post-run JSON processing

🖥 Command-Line Interface

| Flag | Purpose |
|---|---|
| `--rootpath <dir>` \| `--binpath <dir>` + `--datapath <dir>` | Where to write binaries/configs and runtime data (required) |
| `--force-files` / `--force-config` | Overwrite existing binaries/archives, or existing config templates |
| `--nb-cores`, `--username` | Scheduler core count and systemd unit user (defaulted if omitted) |
| `--port-git`, `--port-scheduler`, `--port-publisher`, `--port-vis` | Per-service listen ports (default `10081`–`10084`) |

Any defaulted value triggers an interactive `Y/n` confirmation before anything is written. Full reference: [docs/configuration.md](docs/configuration.md).

⚙️ How It Works

    Parse flags, default anything missing (cores, user, binary/data paths), and ask for confirmation if it did.

    Create the full directory skeleton under the data path.

    Extract the embedded archives and write the 4 embedded server binaries.

    Resolve `${VARIABLE}` templates and write each service's config file plus the systemd unit sample.

    Re-exec each freshly-written binary with `--only-install`/`--install` so it extracts its own embedded resources using the config just written for it.

📂 Architecture at a Glance

    Entry Point (`src/installer/main.cxx`): a single linear `main()` — no class hierarchy, no server loop.

    Embedding (`CMake*Embedding*.cmake`): three mechanisms (asm `.incbin`, C string literals, zip archives) wiring the 4 sibling binaries and the entire `data/`/`samples/` trees into the executable.

    tlspuffin Job Scripts (`scripts/`, `data/tools/js/`): the step-script bash functions the scheduler calls, plus the QuickJS tools that post-process each run's `stats.json`.

    Web Assets (`data/html/`): the job-launcher UI and the publisher results dashboard.

See [docs/architecture.md](docs/architecture.md) for the full design and [docs/components.md](docs/components.md) for the component reference.

🔨 Building

**This project cannot be configured standalone** — it embeds the build outputs of `scheduler`, `git_restapi`, `publisher`, and `vis_comparator` by CMake target name, so it must be built from the repository root, which adds those four subdirectories before `installer/`.

**Prerequisites:** CMake ≥ 3.21, Git, a C++17 compiler with an assembler, the `zip` CLI. No OpenSSL dependency (installer links none of Poco/OpenSSL).

    cmake -B build -DCMAKE_BUILD_TYPE=Release
    cmake --build build -j$(nproc)

This produces two binaries in `build/installer/`:
- `installer` — dynamically linked
- `installer-static` — same, additionally linked with `-static-libgcc -static-libstdc++`

See [docs/build.md](docs/build.md) for the full build reference.

🚀 Running

    ./installer --rootpath /srv/puffin-bench

Creates `/srv/puffin-bench/{bin,data}`, writes the 4 binaries and their configs, then bootstraps each service in turn. Re-run with `--force-config` after editing a template, or `--force-files` after rebuilding with newer embedded binaries.

See [docs/configuration.md](docs/configuration.md) for the full flag/variable reference.

---

📚 Documentation

- [Architecture](docs/architecture.md)
- [Components](docs/components.md)
- [Configuration](docs/configuration.md)
- [Build system](docs/build.md)
- [tlspuffin job scripts](docs/tlspuffin-job-scripts.md)
- [Web assets](docs/web-assets.md)
- [Roadmap](docs/roadmap.md)

---

Note: designed to co-locate all four puffin-bench services on a single host with non-conflicting ports; see the root [README](../README.md) for running a service standalone.
