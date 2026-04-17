# Scheduler — Build System

## Prerequisites

- CMake ≥ 3.21
- Git (for fetching dependencies)
- C++17 compiler
- OpenSSL development headers (`libssl-dev` or equivalent)
- `xxd` (for embedding the `reserve_port` binary as a blob header)

## Commands

```bash
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j$(nproc)
```

## External Dependencies

All dependencies except OpenSSL are fetched from their upstream git repositories and built automatically during the first CMake configuration.

| Library | Version | Mode |
|---------|---------|------|
| Poco | 1.14.2 | static |
| RapidJSON | 1.1.0 | header-only |
| libarchive | 3.8.7 | static |
| zlib | 1.3.2 | static |
| OpenSSL | system | via Poco TLS |

**Enabled Poco modules**: Net, NetSSL, Util, Crypto, Foundation, JSON.

## Embedded Resources

All resources are embedded in the binary at build time as C string literals via `EmbedTextFileScript` (`CMakeTextEmbedding.cmake`) and extracted by `Server::Config::Validate()` on first run (or `--force-install`).

Two distinct extraction policies apply:

**Overwritten by `--force-install`** (board UI + job scripts — treated as code):
- Board dashboard: `board.html`, `board.js`, `taskcard.js`, `joblauncher.js`, `terminal.js`, CSS files
- Shell scripts: `executor.sh`, `functions.sh`
- Job scripts: `html/jobs_scripts/PR_perf_full.sh`, `PR_vulnerabilities_full.sh`, `shell.nix`, `wolfssl_put.c.patch` (installed by server)
- Job flow configs: `samples/jobs/tlspuffin/PR_campaign.json`, `PR_perf_cargo.json`, `PR_vulnerabilities-groupA_cargo.json`

**Never overwritten** (even by `--force-install`):
- `board/launchers/tlspuffin/jobsconfig.json` — the job type registry; users may customize it to add/remove job types or change labels without recompiling.

## Build Targets

| Target | Description |
|--------|-------------|
| `srv` | Main scheduler (dynamic linking) |
| `srv-static` | Fully static binary (suitable for deployment without shared libs) |
