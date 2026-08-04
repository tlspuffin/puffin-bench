# Scheduler — Build System

## Prerequisites

- CMake ≥ 3.21 (the top-level `cmake_minimum_required` says 3.5.0, but `CMakeExternal.cmake` and `CMakeBinaryEmbedding.cmake` — both `include()`-d unconditionally — require 3.21; treat 3.21 as the real floor)
- Git (dependencies are fetched with `git clone`, not CMake's `FetchContent`)
- A C++17 compiler
- OpenSSL development headers (`libssl-dev` or equivalent) — searched under `/usr/include` / `/usr/lib` by default
- `xxd` — required by `CMakeBinaryEmbedding.cmake` (`find_program(XXD xxd REQUIRED)`, evaluated at configure time even though the current `CMakeLists.txt` doesn't call any of that file's binary-embedding functions)
- `zip` — required by `CMakeDirectoryEmbedding.cmake` (`find_program(ZIP zip REQUIRED)`), for the same reason as `xxd`

Both `xxd` and `zip` are pulled in because `CMakeLists.txt` unconditionally `include()`s `CMakeBinaryEmbedding.cmake` and `CMakeDirectoryEmbedding.cmake`. Neither `EmbedBinaryTarget`/`EmbedBinaryFile`/`EmbedDirectory` is actually invoked anywhere today (the only embedding mechanism in use is the text embedder, see below), but the `find_program(... REQUIRED)` calls still run at configure time, so both tools must be installed or configuration fails.

## Commands

```bash
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j$(nproc)
```

`CMAKE_BUILD_TYPE` defaults to `Release` if unset on single-config generators.

All dependencies except OpenSSL are cloned from their upstream git repositories into `<build-dir>/_deps/` and built there on first configure (see `CMakeExternal.cmake`'s `FetchExternalProject`/`FetchAndCreateExternalLib`). Rebuilds are skipped once a matching source/build hash is found under `_deps/`, so subsequent `cmake -B build` runs are fast unless a `GIT_TAG`/`CMAKE_ARGS` combination changes.

There is no `install()` target — nothing runs `cmake --install`. Deployment is manual: copy the built binary, a `config.json`, and (for systemd) the files under `samples/system/` to the target host. See `docs/configuration.md`.

## External Dependencies

| Library | Version (git tag) | Mode |
|---------|--------------------|------|
| Poco | `poco-1.14.2-release` | static |
| RapidJSON | `v1.1.0` | header-only |
| libarchive | `v3.8.7` | static |
| zlib | `v1.3.2` | static |
| OpenSSL | system-installed | static by default (`OPENSSL_MODE` cache var, `STATIC` or `SHARED`), consumed via Poco's NetSSL/Crypto |

**Enabled Poco modules**: `PocoNetSSL`, `PocoNet`, `PocoUtil`, `PocoCrypto`, `PocoFoundation`, `PocoJSON` (XML, Data/ODBC/SQLite/MySQL/PostgreSQL, Zip, MongoDB, Redis, Prometheus, JWT, ActiveRecord and PageCompiler are all disabled in `POCO_CMAKE_ARGS`).

libarchive is built with bzip2, libxml2, lz4, lzma, OpenSSL, zstd and ACL support all disabled — only its own zlib-backed zip/tar handling is enabled, linked against the fetched `zlib` target.

Search roots for OpenSSL are configurable via the cache variables `OPENSSL_SEARCH_ROOT` (default `/usr/lib`), `OPENSSL_SEARCH_ROOT_INCLUDE` (default `/usr/include`) and `OPENSSL_MODE` (`STATIC`/`SHARED`, default `STATIC`). If your distribution only ships shared OpenSSL libs, pass `-DOPENSSL_MODE=SHARED`.

## CMake Helper Scripts

| File | Role |
|------|------|
| `CMakeUtils.cmake` | Low-level library discovery: `GetLibs` (finds headers/`.a`/`.so`/`.dll` under a path and records `MYLIBSEARCH_*` variables), `CreateExternalLib` (wraps the result in an `IMPORTED`/`INTERFACE` CMake target), `PrintTargetProperties` (debug dump). |
| `CMakeExternal.cmake` | `FetchExternalProject` (git clone + external `cmake`/`--build`/`--install` into `_deps/<name>-<hash>-{src,bld,install}`, hashed by tag+args so rebuild is skipped once satisfied) and `FetchAndCreateExternalLib` (fetch-if-missing, then `GetLibs`/`CreateExternalLib`). Used for zlib, OpenSSL, Poco, RapidJSON and libarchive. |
| `CMakeTextEmbedding.cmake` | `EmbedTextFileScript(input, output.h, VARPREFIX)` — declares a build rule that generates a header with `VARPREFIX_data`/`VARPREFIX_size` C string literals from a text file. This is the mechanism actually used for all embedded resources today. |
| `CMakeBinaryEmbedding.cmake` | `EmbedBinaryTarget`/`EmbedBinaryFile`/`EmbedBinaryTargets` — `xxd -i`-based embedding of a built target's binary or an arbitrary file into a C array. Not currently called from `CMakeLists.txt`. |
| `CMakeDirectoryEmbedding.cmake` | `EmbedDirectory` — zips a set of files then embeds the archive via `EmbedBinaryFile`. Not currently called from `CMakeLists.txt`. |
| `CMakeGenVersion.cmake` | Configure-time script invoked as a custom target (`generate_version`) that renders `src/version.c.in` → `<build>/version.c`, filling in build date/time and `git rev-parse --short=12 HEAD`; sets `buildGitDirty` if `git diff`/`git diff --cached` report changes. Produces the `buildID` string and `buildGitDirty` flag printed at startup (`main.cxx`: `LOGA << "Version: " << buildID << (buildGitDirty ? "-dev" : "")`). |

## Embedded Resources

All embedded resources today go through `EmbedTextFileScript`, declared in `CMakeLists.txt`:

- Shell scripts: `scripts/executor.sh`, `scripts/functions.sh`
- Board dashboard files: `html/board/logsmanager.js`, `terminal.js`, `clipboard.js`, `board.html`, `board.css`, `board.js`, `taskcard.css`, `taskcard.js`, `launchers/launchers.css`, `launchers/launchers.js`, `task.html`, `task.css`, `task.js`, `history.html`, `history.css`, `history.js`

Each generates a `<name>_h.h` header (`<VARPREFIX>_data`/`<VARPREFIX>_size`) under `embeded/scheduler/...`, `#include`d directly by the two `Validate()` implementations that extract them to disk:

- `ns_Server::Config::Validate()` (`src/scheduler/server/config.cxx`) writes the board files listed above under `<server.html>/board/...`, and creates the empty directories `<server.html>/board/custom` and `<server.html>/jobsscripts` (both are user-populated extension points — see `docs/board-job-launcher.md`).
- `ns_Executor::LocalConfig::Validate()` (`src/scheduler/schedule/executor/config.cxx`) writes `executor.sh` and `functions.sh` under `<executors.local.scriptPath>`.

Extraction policy is the same for every one of these files, and it runs on **every startup**, not just the first: a file is (re)written if it doesn't exist yet, or unconditionally if the process was started with `--force-install`. There is currently no file that is exempt from `--force-install` — unlike an older revision of this doc set, the job-type/launcher registry is not an embedded resource at all (it isn't shipped by the server; see `docs/board-job-launcher.md` for how that extension point actually works).

## Build Targets

| Target | Description |
|--------|-------------|
| `scheduler` | Main scheduler binary, dynamically linked against libc/libstdc++ (statically against Poco/RapidJSON/libarchive/zlib/OpenSSL, which are always built `STATIC`). Entry point `src/scheduler/main.cxx`. |
| `scheduler-static` | Same binary, built with `-static-libgcc -static-libstdc++` for deployment without a matching libstdc++ on the target host. |
| `scheduler.lib` | Static library containing all scheduler sources except `main.cxx`; both `scheduler` and `scheduler-static` link against it. |
| `testcpu` | Small standalone CLI exercising `src/scheduler/system/linux_cores.cxx` (core/CPU stats). |
| `testFilesRing`, `testOutputRing` | Standalone test binaries for `src/scheduler/schedule/executor/output_ring.cxx` (the per-step output ring buffer). |

Both `scheduler` and `scheduler-static` end up in `build/` (or `build/<Config>/` on multi-config generators).
