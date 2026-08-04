# installer — Components

## Entry Point (`src/installer/main.cxx`)

Everything runs in a single `main()` — there is no class hierarchy, config object, or server loop; the installer is a linear script.

### Argument Parsing

A hand-rolled `std::unordered_map<std::string, std::any>` maps each flag string to either a `bool*` (presence flags), a `std::string*`, or a `std::filesystem::path*`. The parse loop looks up `argv[i]` in that map and, based on `typeid(*)`, either flips the bool, or consumes the next `argv[i+1]` as the value. An unrecognized flag is a hard error (exit 1); `--help` (mapped to a sentinel `void*` entry) prints usage and exits 0.

| Flag | Type | Purpose |
|---|---|---|
| `--rootpath <dir>` | path | Sets both binary and data roots to `<dir>/bin` and `<dir>/data` |
| `--binpath <dir>` | path | Executables + `*.json` configs + `samples/` |
| `--datapath <dir>` | path | Runtime web assets, scripts, per-user state |
| `--force-files` | bool | Overwrite existing non-config files (binaries, extracted archives) |
| `--force-config` | bool | Overwrite existing `*.json` config files |
| `--nb-cores <n>` | string | `schedule.executors.local.nbCores` in the generated `config.json` |
| `--username <name>` | string | `User=` in the generated systemd unit |
| `--port-git <n>` | string | git_restapi listen port (default `10081`) |
| `--port-scheduler <n>` | string | scheduler listen port (default `10082`) |
| `--port-publisher <n>` | string | publisher listen port (default `10083`) |
| `--port-vis <n>` | string | vis_comparator listen port (default `10084`) |

`--nb-cores` and the `--port-*` values are stored as raw strings and substituted directly into JSON templates — see [configuration.md](configuration.md) for the validation gap this leaves.

### Defaulting and Confirmation

If `--username` is omitted, it is read via `geteuid()` / `getpwuid()`. If `--nb-cores` is omitted, it defaults to half the machine's core count (`ns_System::CoresMonitor::NbCores() / 2`). Either substitution — or leaving `--binpath`/`--datapath` unset so they're derived from `--rootpath` — sets `needValidate = true`, which triggers a printed summary of the resolved cores/username/paths and a blocking `std::getline(std::cin, answer)` prompt; anything other than `Y`/`y` aborts with exit 0.

### Directory Creation

A fixed list of subdirectories is created under `<datapath>` (`cache`, `exports`, `html`, `publisher/tlspuffin`, `publisher/sshpuffin`, `repo/.scripts`, `runs`, `scripts`, `tools/js`, `users_data/scheduler`, `users_data/vis_comparator`) via `std::filesystem::create_directories`. Any `std::error_code` failure aborts the whole run (exit 1) — this is the only fatal check after argument parsing.

### File Extraction, Binary Writes, Config Templating

Three back-to-back loops, each iterating a `std::vector<std::tuple<...>>` of `{source, destination}` pairs:

1. **Archives** (`InstallFiles` → `<datapath>`, `SampleFiles` → `<binpath>`) via `FileCompressed(...).ExtractAll(path, override)`, gated by `--force-files`.
2. **Binaries** (the 4 server binaries, embedded dynamically-linked in `installer` and statically-linked in `installer-static` + `reserve_port`) via `WriteBinary`, gated by `!exists() || --force-files`. Permissions are set to `0750` (owner rwx, group r-x).
3. **Config templates** (the 4 `*.json` configs, `index.html`, the 3 `.js` config files, the 2 `.rules` files) via `ResolveVariables` + `WriteFile`, gated by `!exists() || --force-config`. Permissions are set to `0660`.

If step 1 happened to (re)extract `samples/scheduler.service`, a fourth pass re-reads that file from disk and re-resolves its variables — see `utils/variables.cxx` below.

### Sub-Binary Bootstrapping

After all files exist, `main()` shells out (`std::system`) to each freshly-written binary from within `<binpath>`:
```
./scheduler [--force-install] --only-install
./git_restapi [--force-install] --only-install
./vis_comparator [--force-install] --install
```
`publisher` is **not** invoked here — it has no separate embedded-resource install step of its own (its `htmlPath` is populated entirely by the installer's own `InstallFiles` archive). Each `std::system()` return code is logged on failure but does not abort the installer or affect its own exit code — see [roadmap.md](roadmap.md).

## `utils/variables.{hxx,cxx}` — `ResolveVariables`

A single free function: linear scan for `${NAME}` tokens in a string, replaced from a `std::unordered_map<std::string, std::string>` lookup. Unknown variable names are left as literal `${NAME}` text in the output (no error, no warning) — a typo in a template silently passes through into the written config file.

## `utils/file_compressed.{hxx,cxx}` — `FileCompressed`

Thin wrapper over libarchive (`archive_read_*`) supporting two constructions: from a file on disk, or directly from an in-memory `unsigned char const*` buffer (used for the embedded `InstallFiles`/`SampleFiles` blobs, which are zip archives per [architecture.md](architecture.md)).

- `ListFiles(pattern)` — enumerate entries whose path matches a regex (default: everything).
- `ExtractFileData(...)` / `ExtractFile(...)` — stream a single named entry to a buffer or to a destination file, reopening the archive if the requested entry differs from the last one read (archives are forward-only).
- `ExtractAll(targetDir, overwrite)` — extract every entry, creating parent directories as needed; skips entries whose destination already exists unless `overwrite` is set. Returns the list of files actually written, which the installer uses to detect whether `samples/scheduler.service` was (re)created.

## `utils/logs.{hxx,cxx}` — `Logs`

Same leveled, thread-safe stream-logger used across all four sibling projects (`LOGA`/`LOGE`/`LOGW`/`LOGI`/`LOGD` macros over a bitmask `sLevel`). `main()` unconditionally calls `logs.SetLevel({1,1,1,1})` at startup — the installer has no config file of its own to source a log level from, so all levels are always enabled.

## `installer/system/linux_cores.{hxx,cxx}` — `ns_System::CoresMonitor`

Parses `/proc/stat` into per-core and aggregate `CoreStats`. The installer only calls `CoresMonitor::NbCores()` (a static count derived once from the number of `cpuN` lines in `/proc/stat`) to compute the default `--nb-cores` value. The rest of the class — `Init()`/`Update()` (delta-based idle-ratio tracking) and `SelectMostIdleCores()` — is dead code from the installer's point of view; it mirrors the scheduler's own core-monitoring logic (which actually uses it to pick idle cores for job execution) but nothing here calls those entry points.

## `src/reserve_port.c`

A minimal standalone C daemon, unrelated to the installer's install logic but embedded and deployed by it (to `<datapath>/tools/reserve_port`) for job scripts to use. It binds an ephemeral TCP port on loopback (`bind(..., port=0)`), prints `RESERVED_PORT=<n>`, daemonizes (double-fork + redirect std streams to `/dev/null`, printing `RESERVED_PORT_PID=<pid>` from the parent before exiting), and then blocks in `pause()` — holding the port reserved — until killed (`SIGTERM`/`SIGINT`/`SIGHUP`), at which point it closes the socket and exits. Built twice: `reserve_port` (dynamic) and `reserve_port-static` (`-static` linked); only the static variant is embedded and installed (`ReservePort_Binary` in the `EmbedBinaryTargets` call in `CMakeLists.txt`).

## CMake Embedding Macros

Three helper modules, shared with (or modeled on) the sibling projects' build systems:

- **`CMakeBinaryEmbedding.cmake`** / **`CMakeBinaryEmbeddingAsm.cmake`** — embed a CMake target's build output as a byte blob. The asm variant (`.incbin`) is used here specifically because `xxd -i`-style C-array embedding of tens-of-megabytes binaries reliably OOM-kills the compiler front-end when several are built in the same project.
- **`CMakeTextEmbedding.cmake`** — embed a text file as a C string literal (`EmbedTextFile`/`EmbedTextFileScript`), with a `.c`/`.h` split so the symbol has external linkage and other translation units can `#include` the header.
- **`CMakeDirectoryEmbedding.cmake`** — zips an explicit file list from a source directory (`zip` CLI, required) and feeds the resulting archive through the binary-embedding path (`EmbedBinaryFile`), so a whole directory tree becomes a single extractable blob at runtime via `FileCompressed`.

See [build.md](build.md) for how these are wired into the `installer` and `installer-static` targets.
