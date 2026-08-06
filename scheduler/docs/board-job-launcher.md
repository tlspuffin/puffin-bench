# Scheduler — Board Job Launcher

This document covers the dashboard's job-launcher `+` button: what actually ships in this repository (`html/board/launchers/launchers.js` + `launchers.css`), the plugin contract it expects, and the server-side `/api/task/new` contract that any launcher plugin ultimately has to satisfy.

**Read this first**: unlike an earlier revision of this document, no concrete job launcher (job-type registry, commit picker, campaign fields, composite jobs, etc.) ships with this repository. `git ls-files html/board/launchers/` shows only `launchers.css` and `launchers.js` — no `config.js`, no `<project>/joblauncher.js`, no `jobsconfig.json`, no `git.json`. The pieces described below as "shipped" are the actual, current `launchers.js` source; the pieces described as "plugin contract" are inferred from what that source requires of a plugin, not from any example that exists in-tree.

---

## What Ships: `launchers.js`

`html/board/board.js` imports `./launchers/launchers.js` as a side-effecting module (`import './launchers/launchers.js';`) — it self-installs a floating `+` button (`#new-task`, styled by `launchers.css`) in the bottom-right corner of the board.

On load, `launchers.js`:

1. Injects `launchers.css` as a `<link>`.
2. `import`s `./config.js` and reads `config.projects` — expected to be an array of project-name strings.
3. For each name `p` in `config.projects`, dynamically `import()`s `./${p}/joblauncher.js` and instantiates `new module.JobLauncher()`. The project name doubles as both the subdirectory to import from and the label shown in the menu — there is no separate display-label field.
4. Wires the `+` button:
   - **Exactly one project registered**: clicking `+` calls that project's `launcher.open()` directly — no menu.
   - **More than one**: clicking `+` shows a small popup menu (one button per project label); clicking an entry closes the menu and calls that project's `.open()`.
   - Clicking outside an open menu closes it.

```js
// launchers.js, actual current logic
const mods = await Promise.all(config.projects.map(p => import(`./${p}/joblauncher.js`)));
export const launchers = mods.map((m, i) => {
  const instance = new m.JobLauncher();
  return { label: config.projects[i], open: () => instance.open() };
});
```

Nothing else in `launchers.js` is job-type-, campaign-, or commit-picker-specific — all of that lives inside each project's own `joblauncher.js`, which this repository does not provide.

## The Plugin Contract (inferred, not shipped)

To add a job launcher for a project `myproj`, based strictly on what `launchers.js` requires:

1. Create `html/board/launchers/config.js` exporting `config.projects`, e.g. `export const config = { projects: ["myproj"] };`.
2. Create `html/board/launchers/myproj/joblauncher.js` exporting a `JobLauncher` class with a no-throw, no-arg constructor and an `open()` method (called when the user picks `myproj` from the menu, or immediately if it's the only registered project). Everything past that point — modal markup, job-type selection, commit picker, form validation, and the actual submission — is entirely up to that module; `launchers.js` does not constrain it further.
3. Whatever flow JSON / step script / auxiliary files the launcher needs, serve them from `<html>/jobsscripts/` (created empty by `Config::Validate()`, reachable at `GET /files/jobsscripts/...`) or embed them directly in the plugin module.
4. Since none of these files are part of the embedded-resource set (`docs/build.md`), nothing here is touched by `--force-install` — you own the files once you drop them under `<html>/board/launchers/`.

This mirrors the other declared extension point, `<html>/board/custom/header.html`, which `board.js` fetches (`fetch('custom/header.html')`) to inject a custom header fragment into `#custom_header` — also not shipped, also silently a no-op (fetch failure is swallowed) if absent.

## Flow JSON Shape (for reference)

Whatever a `joblauncher.js` plugin submits as the `config` part of `/api/task/new` is a **flow JSON** document — the same format the scheduling engine consumes directly via `POST /api/task/new`. Real examples ship under `samples/jobs/tests/*.json`. For example, `samples/jobs/tests/test_publish.json`:

```json
{
  "publish": {
    "server": "default",
    "storage": "Y/Tests/${COMMIT_ID}/",
    "goal": "Mesurer PR/Commit ${COMMIT_ID}"
  },
  "name": "Test Monitor",
  "flow": [
    { "step": "Step1", "run": [{"Conf_A": {}}, {"Conf_B": {}}], "configuration": {"nb_retry": 2} },
    { "step": "Step2" },
    {
      "step": "Step3",
      "configuration": { "timeout": "15s", "args": {"features": "..."} },
      "monitor": { "entry_point": "MonitorStep3", "delay_start": "1s", "interval": "5s", "timeout": "10s" }
    }
  ]
}
```

`publish.storage` and `publish.goal` (and any other flow field) support `${VAR}` substitution from the `args[...]` the launcher POSTs alongside the flow — see below. `publish.server` must name a key under the server's `schedule.publisher` config section (see `docs/configuration.md`).

## Server-Side Contract: `POST /api/task/new`

This part **is** real, current code (`ns_Server::RequestHandlerTaskNew::handleRequest`, `src/scheduler/server/request_handler.cxx`) — any launcher plugin, present or future, has to assemble a `multipart/form-data` body matching it:

| Form field | Required | Meaning |
|---|---|---|
| `name` | no (defaults to `""`) | Task display name. |
| `user` | no (defaults to `"anonymous"`) | Submitting user; tracked per-user by the Users API (`GET /api/users`, `GET /api/user/<u>/job_types`, `GET /api/user/<u>/<jobType>/tasks`). |
| `job_type` | no (defaults to `"unknown"`) | Arbitrary string identifying the job type; used purely for grouping/history, not validated against any registry server-side. |
| `config` | **yes** | The flow JSON file (see above). Request fails with `{"success": false, "error": "Missing config or script file."}` if absent. |
| `script` | **yes** | The step script file (bash, sourced by `executor.sh`/`functions.sh`). Same failure mode if absent. |
| `files[]` | no, repeatable | Extra files (patches, configs, etc.), keyed by their uploaded filename. |
| `args[<KEY>]` | no, repeatable | Free-form key/value pairs, parsed by stripping the `args[...]` wrapper off each form field name. Duplicate keys throw a 500 (`"args[] value duplicate key found"`). These become the `${KEY}` substitution variables available inside the flow JSON. |
| `runtime[<KEY>]` | no, repeatable | Same parsing as `args[...]` (`runtime[...]` wrapper stripped), merged into the task's runtime/step configuration ahead of dispatch. Duplicate keys throw the analogous 500. |

On success the handler returns `{"success": true, "task_id": "<id>"}`; on any exception, HTTP 500 with `{"success": false, "error": "<message>"}`.

All board API routes (including `/api/task/new`) go through `ManageCORS`, which sets `Access-Control-Allow-Origin: *` and answers `OPTIONS` preflight requests with `200 OK` — so a launcher plugin can be served from, or POST to, an origin other than the board's own if needed.

## Building a Working Launcher

Since the plugin isn't provided, if you're standing one up from scratch the practical shape (derived from the contract above, not copied from any existing UI) is:

1. `JobLauncher.open()` renders a modal: job-type selector, a way to pick or type a commit/reference, and whatever campaign-style parameters your `args`/`runtime` fields need.
2. On submit, `fetch()` your flow JSON and step script (e.g. from `/files/jobsscripts/...`), build a `FormData` with the fields in the table above, and `POST` it to `/api/task/new`.
3. Handle the JSON `{success, task_id}` / `{success: false, error}` response to give the user feedback.

There is nothing in the current codebase constraining how the commit picker, campaign fields, or multi-job composition work beyond this — that entire UI layer is project-specific and lives outside this repository's shipped `html/board/` tree.
