# git_restapi — Build System

## Prerequisites

- CMake ≥ 3.21
- Git (for fetching dependencies)
- C++17 compiler
- OpenSSL development headers (`libssl-dev` or equivalent)

**Runtime requirements** (not needed at build time):
- `git` — required for all Git operations (fetch, clone, log)
- `jq` — required by `tlspuffin_history.sh`
- `bash` — required to execute `tlspuffin_history.sh`

## Commands

```bash
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j$(nproc)
```

## External Dependencies

All dependencies except OpenSSL are fetched from their upstream repositories and built automatically during the first CMake configuration.

| Library | Version | Mode |
|---------|---------|------|
| Poco | 1.14.2 | static |
| RapidJSON | 1.1.0 | header-only |
| OpenSSL | system | via Poco TLS |

## Embedded Resources

`tlspuffin_history.sh` is compiled into the binary as a C string literal via `CMakeTextEmbedding.cmake`. The auto-generated header (`src/embeded/git_restapi/tlspuffin_history_sh.h`) contains:

```c
static const char TLSPuffinHistory_Script_data[] = "...";
static const size_t TLSPuffinHistory_Script_size = ...;
```

At startup, `ns_GIT::Config::Validate()` extracts this script to `scriptsPath_` if the file is missing or if `--install` was passed. Permissions set to `rwxr-x---`.

Passing `--install` on the command line forces re-extraction even if the script already exists on disk — useful after a binary update.

## Build Targets

| Target | Description |
|--------|-------------|
| `git_restapi` | Main server (dynamic linking) |
| `git_restapi-static` | Fully static binary (suitable for deployment without shared libs) |
