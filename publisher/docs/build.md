# Build system — restsrv.publisher

## Prerequisites

- CMake ≥ 3.21
- Git (for fetching dependencies)
- C++17 compiler
- OpenSSL installed on the system (not auto-fetched, static by default)
- `xxd` (for embedding `plotly-3.3.0.min.js`)

## Commands

```bash
cmake -B build
cmake --build build --target publisher          # main server
cmake --build build --target publisher-static   # statically linked version
cmake --build build --target test00             # test executable
```

## External dependencies

All dependencies (except OpenSSL) are downloaded and compiled automatically from git.

| Library | Version | Mode |
|---------|---------|------|
| zlib | v1.3.2 | static |
| OpenSSL | system | static (default) or shared — `OPENSSL_MODE` variable |
| Poco | poco-1.14.2-release | static |
| RapidJSON | v1.1.0 | header-only |
| LibArchive | v3.8.7 | static |
| ZStd | v1.5.7 | static |
| ZStdSeekable | (ZStd contrib) | static, compiled in place |

**Enabled Poco modules**: Net, NetSSL, Util, Crypto, Foundation, JSON.

---

## Dependency management (CMakeExternal.cmake)

### Principle

`FetchAndCreateExternalLib` is the single entry point. It:
1. Computes two MD5 hashes from the version and options
2. Determines the `src` and `install` directories
3. Looks for an existing installation via `GetLibs`
4. If not found, delegates clone + build to `FetchExternalProject`
5. Creates an imported CMake target usable in `target_link_libraries`

### Hashes

Two hashes separate use cases:

```
hash_src   = MD5(GIT_TAG + GIT_COMMIT)
hash_build = MD5(GIT_TAG + GIT_COMMIT + CMAKE_ARGS)
```

- **`hash_src`** — identifies sources. Two builds of the same tag share the same source directory.
- **`hash_build`** — identifies the version + compile options combination. Different `CMAKE_ARGS` produce separate `install` directories.

The build directory is automatically deleted after install (`file(REMOVE_RECURSE)`).

Resulting structure for ZStd with two configurations:
```
$DEPS_BASE_DIR/
├── ZStd-a1b2c3d4e5f6a7-src/          ← shared (same tag)
├── ZStd-e5f6a7b8c9d0e1-install/      ← MULTITHREAD=ON
└── ZStd-9c0d1e2f3a4b5c-install/      ← MULTITHREAD=OFF
```

### Base directory (`DEPS_BASE_DIR`)

```cmake
set(DEPS_BASE_DIR "${CMAKE_BINARY_DIR}/_deps" CACHE PATH "shared dependencies base directory")
```

By default, dependencies are stored in `build/_deps/`. To share across multiple projects, override in `CMakeLists.conf`:

```cmake
set(DEPS_BASE_DIR "/home/olivier/Desktop/shared-deps" CACHE PATH "" FORCE)
```

All projects sharing the same `DEPS_BASE_DIR` with the same versions and options will reuse the same builds.

### Installation metadata

After each install, `FetchExternalProject` writes a `.cmake-deps-meta.cmake` file in the install directory:

```cmake
set(ZStd_SRC_DIR     "/path/to/ZStd-a1b2c3d4e5f6a7-src")
set(ZStd_SRC_HASH    "a1b2c3d4e5f6a7")
set(ZStd_GIT_TAG     "v1.5.7")
set(ZStd_CMAKE_ARGS  "-DZSTD_MULTITHREAD_SUPPORT=ON")
set(ZStd_LIBTYPE     "STATIC")
```

This file allows finding the sources of an installation without recomputing hashes.

### Source directory access

After `FetchAndCreateExternalLib(NAME ZStd ...)`, the `ZStd_SOURCE_DIR` variable is exposed in the calling scope. It points to `$DEPS_BASE_DIR/ZStd-{src_hash_14chars}-src`.

Used notably for `ZStdSeekable` which requires the contrib headers:
```cmake
target_include_directories(ZStdSeekable PUBLIC
    "${ZStd_SOURCE_DIR}/lib/common")
target_include_directories(ZStdSeekable INTERFACE
    "${ZStd_SOURCE_DIR}/contrib/seekable_format")
```

---

## Web file embedding (CMakeTextEmbedding.cmake)

`EmbedTextFileScript` declares a build rule that generates a C header from a text file (HTML, CSS, JS). The header contains the content encoded as a C string:

```c
static const char Publisher_HTML_SummaryPR_HTML_data[] = "...";
static const size_t Publisher_HTML_SummaryPR_HTML_size = ...;
```

These headers are included in `src/publisher/publish/config.cxx` and written to disk at server startup. The binary is thus self-contained — no external HTML files are required at deployment.

**Note**: `plotly-3.3.0.min.js` is embedded via `xxd` (format `unsigned char[]` / `unsigned int`), different from the `EmbedTextFileScript` format. A `static_cast<size_t>` is required when using it in C++ code.

---

## ZStdSeekable

`ZStdSeekable` is a static library built directly in CMake from ZStd's contrib sources (not distributed as an installable library):

```cmake
add_library(ZStdSeekable STATIC
    "${ZStd_SOURCE_DIR}/contrib/seekable_format/zstdseek_compress.c"
    "${ZStd_SOURCE_DIR}/contrib/seekable_format/zstdseek_decompress.c")
target_link_libraries(ZStdSeekable PUBLIC ZStd)
```

It is linked into all executables for seekable `.tar.zst` archive handling.

---

## Versioning

`CMakeGenVersion.cmake` generates `version.c` from `src/version.c.in` at each build by reading the current git tag. The version is accessible via `src/version.h`.

---

## Build targets

| Target | Description |
|--------|-------------|
| `publisher` | Main server (dynamic linking) |
| `publisher-static` | Fully static server |
| `test00` | Development/test executable |
| `generate_version` | Automatic `version.c` generation |
