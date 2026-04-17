# Board — Job Launcher Configuration

This document explains how to configure new job types in the web dashboard and how the job submission flow works end to end.

---

## Overview

The job launcher is a modal dialog opened from the board's `+` button. It lets the user:
1. Pick a **job type** (defined in `jobs_config.json`)
2. Pick or enter a **commit hash** (loaded from a git history feed)
3. Fill in optional **campaign parameters** (only for `"campaign": true` job types)
4. Submit — the launcher fetches the flow JSON and script from the server, then POSTs them to `/api/task/new`

---

## `jobs_config.json` — Job Type Registry

Located at `html/board/launchers/tlspuffin/jobsconfig.json`, embedded in the launcher JavaScript.

### Format

```json
{
  "jobs": [
    {
      "value":    "vuln-a",
      "label":    "Vuln group A",
      "job_type": "vuln-a",
      "color":    "#FF9800",
      "campaign": false,
      "config":   "/files/jobsscripts/tlspuffin/PR_vulnerabilities-groupA_cargo.json",
      "script":   "/files/jobsscripts/tlspuffin/PR_vulnerabilities_full.sh",
      "files":    [
        "/files/jobsscripts/tlspuffin/shell.nix",
        "/files/jobsscripts/tlspuffin/wolfssl_put.c.patch"
      ]
    }
  ]
}
```

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `value` | string | Internal identifier, used as the chip's radio value |
| `label` | string | Display name shown on the chip in the UI |
| `job_type` | string | Value sent as `job_type` in the POST form (used by `UsersAPI` to index tasks) |
| `color` | string | CSS color for the chip dot |
| `campaign` | bool | `true` enables the campaign extra fields (timeout, vendor, features, cores, memory) |
| `config` | URL path | Flow JSON file to submit (fetched from `/files/…`) |
| `script` | URL path | Bash step script to submit (fetched from `/files/…`) |
| `files` | array of URL paths | Additional files to attach (e.g. patches, Nix expressions) |
| `composite` | array of `value` | If set, this job type launches each listed sub-job in parallel; `config`/`script` are unused |

All URL paths are resolved by the browser relative to the board origin, so `/files/jobsscripts/…` maps to `GET /files/jobsscripts/…` on the scheduler.

### Adding a new job type

1. Place the flow JSON and step script in `html/jobs_scripts/` (installed by the server).
2. Add an entry to `jobsconfig.json` with `"config"` and `"script"` pointing to their `/files/jobsscripts/` paths.
3. Reload the board — the configuration is embedded in the launcher JavaScript.

---

## Commit Source — `git.json`

The commit picker loads a JSON feed from `commitsUrl`. In `board.js` this is configured to point to an external git history service:

```js
commitsUrl: `http://${window.location.hostname}:10083/api/git/history/tlspuffin`
```

The fallback (when constructing `JobLauncher` without `commitsUrl`) is `./git.json` — a static file served from the board directory.

### Expected format

```json
{
  "commits": [
    { "id": "abc1234def...", "date": "2026-04-17", "comment": "fix: something", "branch": "main" },
    { "id": "789abcdef0...", "date": "2026-04-16", "comment": "feat: other",    "branch": "dev"  }
  ],
  "branches": [
    { "id": "a1b2c3d4e5...", "date": "2026-04-15", "comment": "feat: wip",      "branch": "my-branch" }
  ],
  "PR": [
    { "id": "b2c3d4e5f6...", "date": "2026-04-14", "comment": "pr: my feature", "branch": "pr/42", "state": "open" }
  ],
  "PR_API_Infos": {
    "apiRemaining": 58,
    "apiResetTS": 1718000000
  }
}
```

The UI splits commits into four tabs:

| Tab | Key | Content |
|-----|-----|---------|
| **main/dev** | `dev` | `commits` entries with `branch = main` or `dev` |
| **PR** | `pr_open` | `PR` entries filtered to `state = "open"` (GitHub API) |
| **branches** | `pr` | All `branches` entries |
| **All** | `all` | All of the above sorted by date |

The **PR** tab refresh button calls `commitsUrl?refresh=all` (hits GitHub API); other tabs use `?refresh=local`. The button tooltip shows `PR_API_Infos.apiRemaining` credits and reset time when on the PR tab.

---

## Submission Flow

When the user clicks **Launch Task**, `joblauncher.js` branches on whether the selected job type is composite.

### Composite job types (`"composite": [...]`)

The launcher resolves each `value` in `composite` to its job definition and calls `#launchSingleJob()` for each **in parallel** (`Promise.all`). The `config`, `script`, and `files` fields on the composite entry itself are unused — they are carried by each sub-job definition.

Each sub-task is submitted with name `"<baseName> - <sub.label>"` (e.g. `"Evaluate PR abc12345 - Vuln group A"`).

After all launches complete, a single toast summarises each sub-job result:

```
Vuln group A: OK (task_id: 42)
Perf: FAILED - 500: internal error
```

The toast is `success` only if every sub-job returned HTTP 2xx.

### Simple job types

1. Fetches `config`, `script`, and each file in `files` in parallel (`Promise.all`).
2. Assembles a `FormData` and POSTs it to `/api/task/new`.

### Standard form fields (all job types)

| Form field | Value |
|------------|-------|
| `name` | Task name from the title input (defaults to `"<label> - <commit7>"`) |
| `user` | Username (persisted in `localStorage`) |
| `job_type` | `job_type` from the job definition |
| `config` | Flow JSON blob (filename = basename of `config` path) |
| `script` | Step script blob (filename = basename of `script` path) |
| `files[]` | Each additional file blob (one entry per item in `files`) |
| `args[COMMIT_ID]` | Selected commit hash |

### Campaign-only form fields (`"campaign": true`)

| Form field | Value |
|------------|-------|
| `runtime[RUNTIME_TIMEOUT]` | Total timeout as `"<N>m"` (days×1440 + hours×60 + minutes) |
| `runtime[RUNTIME_NB_RUN]` | Number of attempts (integer) |
| `runtime[RUNTIME_NB_CORES]` | Cores per step (integer) |
| `runtime[RUNTIME_MEMORY_CORE]` | Base memory in MB (omitted if 0) |
| `runtime[RUNTIME_MEMORY_CONSUMPTION]` | Max memory in MB (omitted if 0) |
| `runtime[RUNTIME_RUN_CONFIG]` | JSON string — a named step configuration block (see below) |

### Campaign `RUNTIME_RUN_CONFIG`

For campaign jobs, the launcher derives a configuration name from the `vendor` field:

```
"wolfssl:wolfssl540"  →  config name "wolfssl540"
```

The generated `RUNTIME_RUN_CONFIG` value:

```json
{
  "wolfssl540": {
    "nb_cores": 8,
    "args": {
      "vendor":      "wolfssl:wolfssl540",
      "features":    "cputs",
      "extra_flags": "--put-use-clear"
    }
  }
}
```

This is passed as a JSON string in the form field. The server-side parser reads `runtime` fields and merges them into the task configuration before dispatching the flow.

---

## Validation Rules

The **Launch Task** button is disabled unless:
- `user` is non-empty
- A job type chip is selected
- The commit field contains a known commit or a hex string ≥ 7 characters
- If the commit is unknown (hex but not in the list): the "Unknown commit — launch anyway" checkbox is checked
- For campaign jobs: `vendor` is non-empty
