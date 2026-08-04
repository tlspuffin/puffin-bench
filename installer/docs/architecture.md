# installer — Architecture

## Purpose

`installer` is a self-contained bootstrapper for the puffin-bench suite. It embeds copies of the four sibling binaries — `scheduler`, `git_restapi`, `publisher`, `vis_comparator` — dynamically-linked in the `installer` binary, statically-linked in `installer-static` (see [build.md](build.md)) — plus every web asset, job script, and default config template each of them needs, and lays them all out on disk with a single command. Running `installer` on a fresh machine (with no clone of any of the four source repos) produces a working, co-located deployment of the whole suite.

It is not a package manager: there is no manifest, no versioning of installed state, and no uninstall path. It writes files idempotently (skipping ones that already exist unless told to overwrite) and can be re-run safely to pick up a newer embedded build.

## High-Level Flow

```
installer --rootpath <dir> [options]
  │
  ├─ 1. Parse argv into options (paths, ports, --nb-cores, --username, --force-*)
  ├─ 2. Fill in unset username / nb-cores / binpath / datapath from system defaults
  ├─ 3. If anything was defaulted, print a summary and prompt for interactive Y/n confirmation
  ├─ 4. Create the directory skeleton under <datapath> (cache, runs, exports, scripts, ...)
  ├─ 5. Extract embedded archives (InstallFiles → datapath, SampleFiles → binpath/samples)
  ├─ 6. Write the four embedded binaries to <binpath>
  ├─ 7. Resolve ${VARIABLE} templates and write the four config.json files + systemd unit
  └─ 8. Re-exec each freshly-written binary with --only-install / --install
        so it extracts its OWN embedded resources using the config just written
```

## Directory Layout Produced

Two independent roots are used throughout: `<binpath>` (executables + service configs) and `<datapath>` (everything the services read/write at runtime — web assets, job scripts, per-user state). They can be the same directory tree (`--rootpath` sets both to `<rootpath>/bin` and `<rootpath>/data`) or given separately.

```
<binpath>/
├── scheduler, git_restapi, publisher, vis_comparator      (embedded binaries — dynamic or static depending on whether `installer` or `installer-static` was run)
├── config.json                    (scheduler)
├── git_restapi-config.json
├── publisher_config.json
├── vis_comparator-config.json
└── samples/
    ├── scheduler.service          (systemd unit, ${USERNAME}/${BINARY_PATH} resolved)
    └── scheduler.sudoers

<datapath>/
├── cache/                         (scheduler's cache.json store)
├── exports/                       (scheduler task export archives)
├── html/                          (dashboard assets: board, publisher, third-party/plotly, index.html)
├── publisher/{tlspuffin,sshpuffin}/.rules   (per-project publisher processing rules)
├── repo/.scripts/                 (git_restapi clone storage + embedded history script)
├── runs/                          (scheduler live task working directories)
├── scripts/                       (scheduler executor.sh / functions.sh)
├── tools/{js,qjs,reserve_port}    (JS helper scripts + QuickJS CLI + port-reservation tool)
└── users_data/{scheduler,vis_comparator}/    (per-user uploaded/private state)
```

`reserve_port` (see [components.md](components.md)) is the one embedded tool that is not one of the four sibling services — it is a small standalone TCP-port-reservation daemon used by the scheduler's job scripts, written to `<datapath>/tools/`.

## Embedded Resources

Everything the installer writes to disk originates from a `CMakeLists.txt`-time embedding step — the installer binary carries no external file dependencies. Three embedding mechanisms are used, each suited to a different payload size/shape:

| Mechanism | Macro | Payload | Symbol shape |
|---|---|---|---|
| Assembly `.incbin` | `EmbedBinaryTargetAsm` (`CMakeBinaryEmbeddingAsm.cmake`) | The 4 server binaries, one call per dynamic/static variant (tens of MB each) | `VARPREFIX_Start[]` / `VARPREFIX_End[]` |
| C string literal | `EmbedTextFileScript` (`CMakeTextEmbedding.cmake`) | Individual small text files: the 4 config.json templates, 3 `.js` config files, `index.html`, 2 `.rules` files | `VARPREFIX_data` / `VARPREFIX_size` |
| Zip archive | `EmbedDirectory` (`CMakeDirectoryEmbedding.cmake`, wraps `EmbedBinaryTargetAsm`) | Two whole directory trees: `data/` (dashboard assets, job scripts, JS tools, `qjs`) and `samples/` (systemd unit + sudoers) | Same `_Start`/`_End` pair, extracted at runtime via `FileCompressed` (libarchive) |

See [build.md](build.md) for why the `.incbin` route exists (an `xxd`-style C-array embedding of binaries this size reliably OOM-kills the compiler).

## Design Notes

**No package/version tracking.** The installer does not record what it previously installed or at what version. Re-running it with `--force-files`/`--force-config` blindly overwrites; without those flags it only fills gaps (missing files), so upgrading a binary always requires `--force-files` (or manually deleting the stale binary) even though the embedded payload inside a newly-built `installer` may be newer.

**Sub-binary bootstrapping via `std::system()`.** After writing its own embedded resources, the installer shells out to each just-written binary (`--only-install` for scheduler/git_restapi, `--install` for vis_comparator) so that binary can extract *its own* embedded resources (e.g. git_restapi's `tlspuffin_history.sh`) using the `config.json` the installer just resolved for it. This keeps per-service embedded-resource logic inside each service rather than duplicating it here — see [roadmap.md](roadmap.md) for the unquoted-path risk this introduces.

**Interactive by default.** Any time a value is defaulted rather than explicitly passed on the command line (`--username`, `--nb-cores`, `--binpath`, `--datapath`), the installer asks for a `Y/y`/`N/n` confirmation on stdin before writing anything. There is no `--yes`/non-interactive flag — see [configuration.md](configuration.md) and [roadmap.md](roadmap.md).

**Port defaults mostly mirror each service's own compiled-in default, with one deliberate override.** git_restapi, scheduler, and publisher each already default to `10081`/`10082`/`10083` respectively when built standalone (`server/config.cxx` in each project) — the installer's own `--port-git`/`--port-scheduler`/`--port-publisher` defaults just reuse those same values. `vis_comparator` alone defaults to `8080` when built standalone; the installer overrides it to `10084` so all four services land in the same `1008x` block instead of colliding with the very commonly-used `8080`.
