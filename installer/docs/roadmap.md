# installer — Roadmap

Improvements identified from the current design. Items are independent unless noted.

---

## Unquoted paths in the sub-binary bootstrap commands

**Current:** After writing files, `main()` runs three `std::system()` calls of the shape:
```cpp
std::system(("cd " + binaryPath.string() + "; ./scheduler " + (override ? "--force-install " : "") + "--only-install").c_str());
```
`binaryPath` (and, transitively, `--rootpath`/`--binpath`) comes straight from `argv` with no shell-quoting.

**Problem:** A path containing a space or a shell metacharacter (`;`, `$`, `` ` ``, etc.) either breaks the `cd` (silently running the install step against the wrong/current directory, since the failure isn't checked before the `;./scheduler ...` part still executes) or, in the metacharacter case, executes attacker-controlled or accidental shell syntax. This is a local operator running the tool against a path they chose, not a remote-input vector, but it's still a real footgun — the same class of issue git_restapi's roadmap flags for its own `popen()`/`std::system()` calls.

**Improvement:** Quote the path (`"'" + path + "'"` with embedded-quote escaping, or switch to `fork()`/`execv()` with an argument vector instead of a shell string) for all three invocations.

---

## Sub-binary bootstrap failures don't abort or affect exit status

**Current:** Each of the three `std::system()` calls above checks `rc != 0` and logs an error via `LOGE`, but execution always falls through to the final `std::cout << "... Install done\n\n"` and `return 0`.

**Problem:** If, say, `git_restapi --only-install` fails (e.g. it can't create its storage directory due to a permissions issue), the operator sees an error line buried in the log output but the process still reports success (`Install done`, exit code 0). A CI/deployment script that only checks the exit code has no way to detect a partial install.

**Improvement:** Track whether any of the three sub-installs failed and reflect it in the final message and exit code (e.g. exit 1 if any failed), rather than always exiting 0.

---

## No validation of `--nb-cores` / `--port-*` values

**Current:** These flags are stored as `std::string` and substituted verbatim into JSON templates by `ResolveVariables()` — see [configuration.md](configuration.md).

**Problem:** `--nb-cores abc` or `--port-scheduler eighty` produces a `config.json`/`git_restapi-config.json`/etc. containing `"nbCores": abc` — invalid JSON — with no error from `installer`. The failure only surfaces later, when the corresponding service fails to parse its config at startup, far from the actual mistake.

**Improvement:** Validate `--nb-cores` and each `--port-*` as a positive integer at parse time and fail fast with a clear message.

---

## No non-interactive mode

**Current:** Any defaulted value (`--username`, `--nb-cores`, or either path derived from `--rootpath`) triggers a blocking `std::getline(std::cin, answer)` confirmation prompt, with no flag to skip it.

**Problem:** Scripted/automated deployments (Ansible, CI, Docker `RUN` steps) either have to pass every single flag explicitly to dodge the prompt, or pipe a literal `y` into stdin — fragile, and easy to silently misconfigure since a piped `echo y` skips the printed summary the human would otherwise have read.

**Improvement:** Add a `--yes`/`--non-interactive` flag that skips the confirmation while still printing the resolved summary to stderr for logging.

---

## `--rootpath`/`--binpath`/`--datapath` mixing is inconsistently enforced

**Current:** As detailed in [configuration.md](configuration.md), the two exclusivity checks let `--rootpath` combined with exactly one of `--binpath`/`--datapath` through silently, even though the help text and the second check's intent describe the two forms as mutually exclusive.

**Problem:** Undocumented, easy-to-stumble-into behavior: a user who adds `--binpath` to an existing `--rootpath`-based command line (e.g. to relocate just the binaries) gets no error and no confirmation that `--datapath` silently fell back to `<rootpath>/data`.

**Improvement:** Either explicitly support and document partial overrides (probably the more useful behavior), or make the exclusivity check symmetric — reject `--rootpath` combined with *any* of `--binpath`/`--datapath`.

---

## `version.c`'s `buildID`/`buildGitDirty` are generated but never used

**Current:** `src/version.c.in` is templated and compiled into `installer.lib` exactly as in the sibling projects (build date/time, short git commit hash, dirty-tree flag). Unlike `scheduler`, `git_restapi`, and `publisher` — which each log `Version: <buildID>[-dev]` at startup — `installer`'s `main()` never references `buildID` or `buildGitDirty`.

**Problem:** There is no way to tell, from a running (or crashed) `installer` binary's output, which build produced a given deployment — useful when diagnosing "this install has an old config template" reports.

**Improvement:** Log `buildID`/`buildGitDirty` at the start of `main()`, matching the sibling projects.

---

## No re-install / drift detection

**Current:** Binaries are rewritten only if missing or `--force-files`; configs only if missing or `--force-config`. There is no record of which embedded-payload version produced the files currently on disk.

**Problem:** After rebuilding `installer` with newer sibling binaries, re-running it without `--force-files` silently leaves the old binaries in place (the intended idempotent behavior for configs, but easy to assume also refreshes binaries). There's also no way to detect that a config file was hand-edited on disk and diverges from what the current template would produce.

**Improvement:** Print a clear "N files already exist and were left untouched (use --force-files to overwrite)" summary at the end of a run, so an upgrade attempt that changed nothing is visibly different from a fresh install.
