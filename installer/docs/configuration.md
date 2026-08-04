# installer — Configuration

`installer` has no config file of its own — everything is driven by command-line flags. Its job is to *produce* the four sibling services' config files from embedded templates.

## Command-Line Flags

```
installer --rootpath <path> | --binpath <path> --datapath <path>
```

One of `--rootpath` **or** the pair `--binpath`+`--datapath` is required (see the mixing note below).

| Flag | Argument | Default | Effect |
|---|---|---|---|
| `--help` | — | — | Print usage and exit 0. |
| `--rootpath` | path | — | Sets `binpath = <path>/bin`, `datapath = <path>/data`. |
| `--binpath` | path | `<rootpath>/bin` | Root for the 4 binaries, 4 `*.json` configs, and `samples/`. |
| `--datapath` | path | `<rootpath>/data` | Root for extracted web assets, job scripts, and per-user state. |
| `--force-files` | — | off | Overwrite existing binaries and extracted archive files that already exist on disk. |
| `--force-config` | — | off | Overwrite existing `*.json`/`.js`/`.html`/`.rules` config templates. |
| `--nb-cores` | string | `nproc / 2` | `schedule.executors.local.nbCores` in the generated `config.json`. |
| `--username` | string | current effective user (`geteuid()`/`getpwuid()`) | `User=` in the generated `scheduler.service`. |
| `--port-git` | string | `10081` | git_restapi listen port. |
| `--port-scheduler` | string | `10082` | scheduler listen port. |
| `--port-publisher` | string | `10083` | publisher listen port. |
| `--port-vis` | string | `10084` | vis_comparator listen port. |

**No validation of numeric flags.** `--nb-cores` and the `--port-*` values are stored and substituted as raw strings — a non-numeric value is written verbatim into the JSON template, producing an invalid config file with no error from `installer` itself (the failure only surfaces when the corresponding service tries to parse its config).

**`--rootpath` / `--binpath` / `--datapath` mixing is only partially rejected.** The stated contract ("can not mix arguments") is enforced by two checks: (1) error if `rootpath` is empty and *either* `binpath` or `datapath` is empty; (2) error if `rootpath` is non-empty and *both* `binpath` and `datapath` are non-empty. A call that sets `--rootpath` together with **only one** of `--binpath`/`--datapath` (e.g. `--rootpath /srv/x --binpath /custom/bin`) satisfies neither check and is accepted silently: the explicitly-given path is used as-is, and the other one falls back to `<rootpath>/{bin,data}`.

## Interactive Confirmation

If `--username`, `--nb-cores`, or either path was left to its default, the installer prints the resolved values and blocks on:

```
Want to use scheduler with <N> cores as <user>
Want to use directories:
	for binaries/configs: <binpath>
	for data: <datapath>
[Y/y]es or [N/n]o:
```

Anything other than `Y`/`y` aborts with exit 0 and writes nothing. There is no flag to skip this prompt — every fully-explicit invocation (`--binpath` + `--datapath` + `--nb-cores` + `--username` all given) skips it automatically, but that's the only way to run non-interactively.

## Variable Substitution

`ResolveVariables()` (see [components.md](components.md)) performs a single left-to-right scan for `${NAME}` tokens. The full set of names it knows about:

| Variable | Value | Used in |
|---|---|---|
| `${ROOT_PATH}` | `--rootpath` (may be empty if `--binpath`/`--datapath` were used instead) | *(reserved — not referenced by any current template)* |
| `${BINARY_PATH}` | resolved `binpath` | `scheduler.service` (`WorkingDirectory`, `ExecStart`) |
| `${DATA_PATH}` | resolved `datapath` | `config.json`, `git_restapi-config.json`, `publisher_config.json`, `vis_comparator-config.json` |
| `${GIT_RESTAPI_PORT}` | `--port-git` | `git_restapi-config.json`, `launchers/tlspuffin/config.js`, `publisher/summary_config.js` |
| `${SCHEDULER_PORT}` | `--port-scheduler` | `config.json`, `index.html` |
| `${PUBLISHER_PORT}` | `--port-publisher` | `publisher_config.json`, `index.html` |
| `${VIS_COMPARATOR_PORT}` | `--port-vis` | `vis_comparator-config.json`, `index.html`, `publisher/summary_config.js` |
| `${NB_CORES}` | `--nb-cores` (or the default) | `config.json` |
| `${USERNAME}` | `--username` (or the default) | `scheduler.service` |

**Unknown `${NAME}` tokens are left untouched — and several templates rely on this.** JS template-literal syntax like `` `${window.location.hostname}` `` in `config.js`/`index.html`, and publisher rule placeholders like `${FILE_RELATIVE_PATH_1}` in the `.rules` files (resolved later by the publisher itself, not by `installer`), share the exact `${NAME}` syntax `ResolveVariables()` scans for. Because there's no escaping mechanism, this only works by coincidence — none of those runtime-only names happen to collide with the 9 names above.

## Generated Files

| Template (embedded) | Written to | Overwrite gate |
|---|---|---|
| `config/config.json` | `<binpath>/config.json` | `--force-config` |
| `data/html/board/launchers/config.js` | `<datapath>/html/board/launchers/config.js` | `--force-config` |
| `data/html/board/launchers/tlspuffin/config.js` | `<datapath>/html/board/launchers/tlspuffin/config.js` | `--force-config` |
| `config/git_restapi-config.json` | `<binpath>/git_restapi-config.json` | `--force-config` |
| `config/publisher_config.json` | `<binpath>/publisher_config.json` | `--force-config` |
| `data/html/publisher/summary_config.js` | `<datapath>/html/publisher/summary_config.js` | `--force-config` |
| `data/html/index.html` | `<datapath>/html/index.html` | `--force-config` |
| `data/publisher/tlspuffin/.rules` | `<datapath>/publisher/tlspuffin/.rules` | `--force-config` |
| `data/publisher/sshpuffin/.rules` | `<datapath>/publisher/sshpuffin/.rules` | `--force-config` |
| `config/vis_comparator-config.json` | `<binpath>/vis_comparator-config.json` | `--force-config` |
| `samples/scheduler.service` (via archive extraction, then re-resolved) | `<binpath>/samples/scheduler.service` | `--force-files` (extraction) |
| `samples/scheduler.sudoers` | `<binpath>/samples/scheduler.sudoers` | `--force-files` (no variables — copied as-is) |

Every scheduler/git_restapi/publisher/vis_comparator config generated this way is a **minimal starting point** — see the root [README](../../README.md#configuration) for the full field reference of each, and each project's own `docs/configuration.md` for exhaustive coverage:

- [scheduler/docs/configuration.md](../../scheduler/docs/configuration.md)
- [git_restapi/docs/configuration.md](../../git_restapi/docs/configuration.md)
- [publisher/docs/configuration.md](../../publisher/docs/configuration.md)

## Samples

`<binpath>/samples/scheduler.service` and `scheduler.sudoers` are systemd/sudoers snippets for running the scheduler under a cgroup-managed user slice with `AllowedCPUs` control (matching `schedule.executors.local.cgroupPath` in the generated `config.json`). They are not installed automatically — copy them into `/etc/systemd/system/` and `/etc/sudoers.d/` manually and adjust the `User=` line if `--username` wasn't what you wanted.
