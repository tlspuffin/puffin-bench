# installer — Build System

## Prerequisites

- CMake ≥ 3.21 (per the root project; `installer/CMakeLists.txt` itself only requires 3.5)
- Git (fetches dependencies at configure time)
- C++17 compiler + an assembler (`enable_language(ASM)` — needed for the `.incbin`-based binary embedding)
- `zip` CLI (`EmbedDirectory` shells out to it — see [components.md](components.md))
- `xxd` is **not** required by this project specifically (unlike the sibling services), because binary embedding here uses the assembler `.incbin` route instead — see below.

**This project cannot be configured standalone.** `installer/CMakeLists.txt` embeds the build outputs of the `scheduler`, `scheduler-static`, `git_restapi`, `git_restapi-static`, `publisher`, `publisher-static`, `vis_comparator`, and `vis_comparator-static` CMake *targets* by name, but does not `add_subdirectory()` any of those projects itself. They must already exist in the same CMake project — which only happens when building from the repository root, where the top-level `CMakeLists.txt` adds `scheduler/`, `git_restapi/`, `publisher/`, and `vis_comparator/` **before** `installer/`:

```cmake
add_subdirectory(scheduler)
add_subdirectory(git_restapi)
add_subdirectory(publisher)
add_subdirectory(vis_comparator)
add_subdirectory(installer)
```

## Commands

From the repository root:

```bash
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j$(nproc)
```

This builds all five projects; `installer`/`installer-static` end up depending (transitively, via the embedding custom commands) on every other target having finished first. Binaries are written to `build/installer/installer` and `build/installer/installer-static`.

There are no installer-specific CMake cache variables — the OpenSSL search-path options documented in the root [README](../../README.md) apply to `scheduler`, `git_restapi`, and `publisher` individually, not to `installer` (which links none of Poco/OpenSSL).

## External Dependencies

Fetched and built automatically on first configure via `FetchAndCreateExternalLib` (`CMakeExternal.cmake`), scoped to this project:

| Library | Version | Mode | Used for |
|---|---|---|---|
| QuickJS-ng | v0.16.1 | static | Its `qjs` CLI binary is copied into `data/tools/qjs` and embedded as part of the `InstallFiles` data archive — the job scripts run JS post-processing steps with it. |
| zlib | v1.3.2 | static | Dependency of LibArchive. |
| LibArchive | v3.8.7 | static (bzip2/xml2/lz4/lzma/OpenSSL/zstd/ACL support all disabled) | `FileCompressed` (`utils/file_compressed.cxx`) uses it to read the embedded zip archives at runtime. |

## Generated / Embedded Sources

1. **Version stamp** (`src/version.c.in` → `${CMAKE_BINARY_DIR}/version.c`, via `CMakeGenVersion.cmake`, same mechanism as the sibling projects): embeds build date/time, short git commit hash, and a dirty-tree flag into `buildID`/`buildGitDirty`. Compiled into `installer.lib`, but — unlike the sibling projects' `main.cxx`, which log `Version: <buildID>` at startup — **`installer`'s `main()` never reads these symbols**; see [roadmap.md](roadmap.md).

2. **`data/tools/qjs`**: a build-time `add_custom_command` copies the fetched QuickJS CLI binary into the source tree at `data/tools/qjs` so it can be picked up by the `EmbedDirectory` call below. This means a successful build writes into `installer/data/` — the file is `.gitignore`d.

3. **tlspuffin job scripts** (`generate_tlspuffin_scripts` target): runs `scripts/build.sh`, then copies the two generated outputs (`PR_perf_full.sh`, `PR_vulnerabilities_full.sh`) into `data/html/jobsscripts/tlspuffin/`, where they're picked up by the same `EmbedDirectory` call. Depends on `scripts/build.sh` and the three `PR_*.sh` scripts it assembles from.

4. **The four static server binaries** (`EmbedBinaryTargetAsm`, one call per binary × dynamic/static variant): each generates an assembly file with `.incbin "<path-to-binary>"` plus a companion `<VARPREFIX>.h` declaring `<VARPREFIX>_Start[]`/`<VARPREFIX>_End[]` as `extern`. This route (rather than the sibling projects' `xxd -i` C-array embedding, see `CMakeTextEmbedding.cmake`/`CMakeBinaryEmbedding.cmake`) exists specifically because an `xxd`-style embedding of tens-of-megabytes binaries produces a source file 6-7x larger than the input and reliably OOM-kills the compiler front-end — `.incbin` streams the file from disk at assemble time instead.

5. **Config/HTML templates** (`EmbedTextFileScript`, one call per file — `config.json`, `git_restapi-config.json`, `publisher_config.json`, `vis_comparator-config.json`, two `config.js` files, `summary_config.js`, `index.html`, two `.rules` files): each becomes a `<VARPREFIX>_data`/`<VARPREFIX>_size` C string pair, resolved against runtime variables by `ResolveVariables()` before being written to disk — see [configuration.md](configuration.md).

6. **Two directory archives** (`EmbedDirectory`, backed by `zip` + the binary-embedding path): `InstallFiles` (dashboard/job-script/JS-tool assets from `data/`, explicit file list in `CMakeLists.txt`) and `SampleFiles` (`samples/scheduler.service`, `samples/scheduler.sudoers`).

7. **`reserve_port` / `reserve_port-static`**: built from `src/reserve_port.c`, embedded via `EmbedBinaryTargets` (note: plural — a different macro than the per-target `EmbedBinaryTargetAsm` used for the four server binaries) into `ReservePort_Binary`.

## Build Targets

| Target | Description |
|--------|-------------|
| `reserve_port` / `reserve_port-static` | The standalone port-reservation tool (see [components.md](components.md)); `-static` is the variant actually embedded. |
| `deploy_qjs_cli` | Copies the fetched QuickJS CLI into `data/tools/qjs` (prerequisite step, not an installable artifact). |
| `generate_tlspuffin_scripts` | Runs `scripts/build.sh` to produce the two `_full.sh` job scripts consumed by `EmbedDirectory`. |
| `installer.lib` | Static library with all embedding-generated `.c` files plus `utils/`, `installer/system/linux_cores.cxx`, and the generated `version.c`. Linked against `LibArchiveTN`. |
| `installer` | Main executable (dynamically linked). |
| `installer-static` | Same executable, additionally linked with `-static-libgcc -static-libstdc++` for deployment without matching system C/C++ runtime libraries. |
