# git_restapi — Build System

## Prerequisites

- CMake ≥ 3.21
- Git (for fetching dependencies, and to stamp the build's git commit into the version string)
- C++17 compiler
- OpenSSL development headers (`libssl-dev` or equivalent)

**Runtime requirements** (not needed at build time):
- `git` — required for all Git operations (fetch, clone, log, merge-base)
- `jq` — required by `tlspuffin_history.sh`
- `bash` — required to execute `tlspuffin_history.sh`

## Commands

```bash
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j$(nproc)
```

Useful cache variables:

| Variable | Default | Description |
|---|---|---|
| `OPENSSL_SEARCH_ROOT` | `/usr/lib` | Where to look for the OpenSSL library. |
| `OPENSSL_SEARCH_ROOT_INCLUDE` | `/usr/include` | Where to look for OpenSSL headers. |
| `OPENSSL_MODE` | `STATIC` | `STATIC` or `SHARED` — which OpenSSL build to link against. |

## External Dependencies

All dependencies except OpenSSL are fetched from their upstream repositories and built automatically during the first CMake configuration (via `FetchAndCreateExternalLib` in `CMakeExternal.cmake`).

| Library | Version | Mode |
|---------|---------|------|
| Poco | 1.14.2 (`poco-1.14.2-release`) | static, with only `NetSSL`, `Net`, `Util`, `Crypto`, `Foundation`, `JSON` components enabled |
| RapidJSON | 1.1.0 (`v1.1.0`) | header-only |
| OpenSSL | system | linked into Poco's TLS support |

## Generated / Embedded Sources

Two things are generated at configure/build time and compiled into every target:

1. **Version info** (`src/version.c.in` → `${CMAKE_BINARY_DIR}/version.c`, via `CMakeGenVersion.cmake`): stamps the build date/time and the current short git commit hash (`git rev-parse --short=12 HEAD`) into `buildID`, and sets `buildGitDirty` to `1` if the working tree (or index) has uncommitted changes. `main.cxx` logs this as `Version: <buildID>[-dev]` at startup.

2. **Embedded script** (`scripts/tlspuffin_history.sh` → `embeded/git_restapi/scripts/tlspuffin_history_sh.h`, via `EmbedTextFileScript` in `CMakeTextEmbedding.cmake`): compiles the script into a C string literal:
   ```c
   static const char TLSPuffinHistory_Script_data[] = "...";
   static const size_t TLSPuffinHistory_Script_size = ...;
   ```
   At startup, `ns_GIT::Config::Validate()` extracts this script to the configured `scripts` directory if the file is missing there, or if `--force-install` was passed. Permissions are set to `rwxr-x---`.

   Pass `--force-install` on the command line to force re-extraction even if the script already exists on disk (useful after a binary update); pass `--only-install` to install and exit without starting the server or touching any repository — see [configuration.md](configuration.md).

## Build Targets

| Target | Description |
|--------|-------------|
| `git_restapi.lib` | Static library containing all application logic (linked by both executables below). |
| `git_restapi` | Main server executable. |
| `git_restapi-static` | Same executable, additionally linked with `-static-libgcc -static-libstdc++` for easier deployment without matching system C/C++ runtime libraries. Poco/RapidJSON are already linked statically into both targets; this target only changes the libgcc/libstdc++ linkage. |
