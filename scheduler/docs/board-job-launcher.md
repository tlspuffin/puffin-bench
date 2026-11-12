# Scheduler — Board Plugins and Job Launcher

The pages of the scheduler (the board, the task page, History) know no project. What a project adds to them — its
job launcher (the `+` button), its descriptions of the tasks and of their monitor messages, its buttons, filters and
help, and the top bar of its bench — comes from a **plugin** that the project installs under `<html>/board/custom/`.
Without any plugin the pages work on their own: their top bar shows the refresh, the help and the status light of the
scheduler, and the tasks are shown by their name and arguments.

This document covers what the scheduler ships for that (`frame.js`, `help.js`, `health.js`, `plugins.js`,
`launchers.css`), the plugin contract, and the server-side `/api/task/new` contract that a launcher ultimately has to
satisfy. The plugin of tlspuffin (`tlspuffin/data/html/board/custom/tlspuffin/`, installed by the tlspuffin installer)
is described in [tlspuffin/docs/web-assets.md](../../tlspuffin/docs/web-assets.md).

---

## What Ships

These files are embedded in the scheduler binary and extracted under `<html>/board/` (see `docs/build.md`):

| File | Role |
|---|---|
| `frame.js` | The frame of a page: the top bar, its refresh and help buttons, the keys, the layers of Esc; loads the plugins and lets them add their items |
| `help.js` | The hover helps (`data-help`) and the help panel (tabs: "This page", then those of the plugins) |
| `health.js` | The status light of the scheduler (`GET /api/health`) and the check a launcher makes before submitting |
| `plugins.js` | The loader of the plugins, the routing of their hooks, the `+` button |
| `launchers.css` | The style of the `+` button and of its menu |
| `tips.js` | One look for every hover (imported by `frame.js`) |

A page loads `frame.js` once, as its first script. The pages of the scheduler also import `plugins.js` for the hooks.

### `frame.js` — the top bar

On load (at once, or on `DOMContentLoaded`) it builds a bar `nav.pb-nav` at the top of the body, unless the page is
shown inside another one (an iframe) or already has a bar. The bar has, from left to right: a place `start` for the
plugins, a spacer, a place `end` for the plugins, the status light (when the page names a scheduler), 🔄 and ❔. It
sets `--pb-nav-height: 34px` on the document, for the sticky headers of the pages
(`top: var(--pb-nav-height, 0px)`). Then it imports `plugins.js` and calls `frame.barItems` of every plugin and adds
their `frame.helpTabs` to the help panel.

`ShowSchedulerHealth(url = window.location.origin)` (exported) shows the status light of the scheduler at `url` and makes
it the scheduler of `CheckScheduler`. The pages of the scheduler call it with their own origin, which stays right
through an alias or an SSH tunnel; a page served by another service has no way to know where the scheduler is, so a
plugin that knows it calls it there (tlspuffin: the default ports of the bench).

Events and keys, on `window`:

| Event / key | Meaning |
|---|---|
| `pb-refresh` (cancelable) | sent by 🔄 and Cmd/Ctrl+R; a page with its own refresh handles it and calls `preventDefault()`, otherwise the page is reloaded |
| `pb-refresh-state` | sent by a page, `{ detail: { level: 'gold' \| '', title } }`: colours 🔄 and sets its title (e.g. a refresh that costs GitHub credits) |
| `pb-modal-refresh` (cancelable) | sent first on Cmd/Ctrl+R: a popup refreshes itself instead of the page (e.g. the logs window) |
| `pb-escape` (cancelable) | sent on Esc, `{ detail: { layer } }`, layer by layer until one calls `preventDefault()`: `'help'` (the help panel), `'modal'` (logs, launcher, click windows), `'panel'` (a drawer, unfolded panels); a text field loses the focus |
| `pb-help` | sent by the help panel, `{ detail: { open } }` |
| `?` | opens or closes the help panel (not in a text field) |

A key a page already handled (`defaultPrevented`) is left alone.

### `help.js` — hovers and help panel

- `new Help(texts)`: an element with `data-help="<key>"` shows `texts[key]` on hover after 500 ms. The pages pass
  `{ ...helpTexts, ...Plugins.helpTexts }`: their own keys and those of the plugins.
- The help panel (❔ or `?`): its first tab "This page" shows the page's `<template id="help-panel">` (or "No help for
  this page"); the plugins add theirs with `AddHelpTab({ label, html })` (`html`: HTML text, or a function — maybe
  async — giving it). While it is open, the elements with a hover help are outlined (help mode). `ToggleHelp(open)` and
  `IsHelpOpen()` are exported.

### `health.js` — status light of the scheduler

`HealthPill()` polls `<scheduler>/api/health` every 10 s and on every `pb-refresh` (8 s deadline per request): 🟢 up,
🟠 slow or busy, 🔴 no answer; the details on click. A scheduler older than `/api/health` (404) is shown up.
`CheckScheduler()` reads it once and returns `{ health, warning }`, `warning` being what a launcher should tell the user
before submitting (null when the scheduler looks healthy). `SetSchedulerURL(url)` names the scheduler (the origin of
the page by default); `frame.js`'s `ShowSchedulerHealth` calls it.

### `plugins.js` — loader and routing

On load it:

1. injects `launchers.css`;
2. imports `./custom/config.js` and reads `config.projects`, the names of the projects in order; absent or invalid:
   no plugin, and no error;
3. imports `./custom/<name>/plugin.js` for each name and takes its default export; a plugin that does not load is
   left out with a warning in the console;
4. merges the `helpTexts` of the plugins (a key defined twice: warning, the last one wins).

The launcher of a plugin is created on first use only (its form is built then), so that the pages of other services
that load the plugins do not build it.

The `+` button (`BuildUI()`, called by the board): none without a launcher; with one launcher, a click opens it; with
several, a small menu of their names. The board also opens a launcher from its address:
`board.html#launch=<project>&<key>=<value>…` calls `open()` of that project's launcher with the other parameters
(`{ key: value, … }`), which the project reads — e.g. a page of the project that proposes to launch a task.

## Installation

Nothing under `<html>/board/custom/` is shipped or extracted by the scheduler, and `--force-install` never touches it.
`Config::Validate()` only creates the empty directory.

```
<html>/board/custom/
├── config.js                export { config }, config = { projects: ['<name>', …] }   (written by the project)
├── <name>/plugin.js         the plugin of the project: export default { … }            (written by the project)
├── <name>/…                 its other files: modules, styles, and data files it reads
└── header.html              optional, independent of the plugins (below)
```

A plugin may read data files written next to it by other tools of its project (tlspuffin: `task_links.json`, written by
its objectives report); the installer of the project writes its own files and leaves those alone.

`header.html` is a separate extension point, for the machine rather than a project: `board.js` fetches
`custom/header.html` and puts it in `#custom_header` on the board. Absent, the fetch gets an empty 404 and nothing is
shown.

Pages of other services can load the same frame and plugins: the services of a bench share one `html` root, so a page of
the publisher loads `/html/board/frame.js` and vis_comparator serves `board/…` from that root for every protocol
(`request_handler.cxx`). Their plugins are then those of `<html>/board/custom/`.

## The Plugin Contract

`custom/<name>/plugin.js` exports an object; every part is optional:

```js
export default {
  launcher,   // a class: the launch form and the descriptions of the project's tasks
  helpTexts,  // { key: text }: hover helps of the elements with data-help="<key>" the plugin creates
  frame,      // { barItems(slots), helpTabs: [{ label, html }] }
  history,    // { load(tasks), card(task), typeLabel(task), filters: [...], stats(tasks) }
  task,       // { relaunch(task), links(task, steps) }
  taskcard,   // { resultsLink(task, link) }
};
```

### `launcher`

A class with a constructor without arguments, created on first use, and these methods (only `open` is required):

| Method | Returns | Used by |
|---|---|---|
| `open(params)` | — | the `+` button (no params), a relaunch (`task.launcher.custom`, or what `task.relaunch` gave), `board.html#launch=…` (its parameters) |
| `describeTask(task)` (async) | `{ title, commit, custom, search, args }` or `null` | board, task page, History |
| `describeMonitor(task, message)` (sync) | `{ summary, level, text, highlight, badge, taskLink }` or `null` | board, task page, History (task cards) |
| `describeSettings(task)` (sync) | `[{ label, html }]` or `null` | task page |
| `prefetchTasks(tasks)` (async) | — | History, before describing many tasks |

`describeTask`: `title` (HTML) replaces the name of the task; `commit` (HTML) is its commit line, shown for the argument
marked `commitLine`; `custom` its custom name; `search` more words for the search of History; `args` how to show each
argument on the one-line argument list of a card and in the drawer of History:
`{ KEY: { bare, level, label, hidden, inTitle, commitLine } }` — `bare` its value alone, `level: 'warning'` on its own
highlighted line with `label`, `hidden` not shown, `inTitle` not repeated when the title of the project is shown,
`commitLine` shown as `commit`. Without a description, a task shows its name and its arguments as `KEY=value`.
History calls it with `{ id, name, type, args }` (its lists carry no more); the other pages with the whole task.

`describeMonitor`: `summary` (HTML) is the line shown for the last message of an attempt instead of its first line;
`level` (`'error'`, `'warning'`, `'success'`) the colour of its marker; `text` the message shown in full on click;
`highlight` (`'notable'` or `'error'`) makes the attempt and its square in the step header stand out; `badge`
(`{ text, title }`) is shown on the chip of the attempt on the task page; `taskLink`
(`{ key, label, url, title, count, highlight, pending }`) is a button of the task: on its card (state strip) and on the
task page, the links of the same `key` are merged over the attempts and their `count`s summed into the `{count}` of
`label`. `pending` (`{ label, title, fallback: { url, label, title } }`): while the page at `url` does not exist (a page
written after the task, e.g. a final report), the button opens `fallback.url` if that page exists, else shows
`pending.label` without link.

### `frame`

`barItems({ bar, start, end })` adds the plugin's items to the top bar: `start` on the left, `end` on the right before
the status light and the buttons. `helpTabs` are added to the help panel after "This page".

### `history`

| Hook | Returns | Meaning |
|---|---|---|
| `load(tasks)` (async) | — | called each time History reads its list, before it renders: reads what the other hooks need (e.g. its data files; its style for the page) |
| `card(task)` | `{ buttons: [{ label, url, title, cls }], cls }` or `null` | buttons of the task's row and drawer (`url` relative to the History page, opened in a new tab), a class added to its row |
| `typeLabel(task)` | `{ label, cls }` or `null` | the job type as shown on its badge and in the type filter, a class of the badge |
| `filters` | `[{ label, values, single, group, match(task, value) }]` | filters of the list, shown as chips |
| `stats(tasks)` | HTML or `null` | added to the counts of the last 30 days (`tasks`: those tasks) |

A filter with `values` (an array, or a function of the tasks giving it) shows one chip per value: several may be
selected, a task matching any of them; with `single: true`, one value at a time after an "all" chip, selected by
default. A filter without `values` is one chip, on or off. `group: 'users' | 'types' | 'states'` shows its chips with
that group of History; otherwise they come first in the row.

While a filter is on, History calls its `match` for **every** task shown, whatever its project: `match` returns `false`
for a task its plugin does not know, so a task of another project is left out. The active filters and the groups of
History combine (and); a group with nothing selected does not filter.

### `task` and `taskcard`

| Hook | Returns | Meaning |
|---|---|---|
| `task.relaunch(task)` | `{ custom, title }` or `null` | "↻ Relaunch as template" of the task page, for a task without launcher record (started by the API or a script): `custom` is given to `open()` of the plugin's launcher, `title` explains it |
| `task.links(task, steps)` | `[{ label, url, title, hidden, update(element) }]` or `null` | more links of the task page; `update` (maybe async) may change the link once shown (e.g. show it after reading a count) |
| `taskcard.resultsLink(task, link)` | a link or `null` | the link to the published results of the task, from its `publish_link` (`null`: the link as it is) |

### Two kinds of hooks, and their routing

- **Hooks of a page** — `helpTexts`, `frame`, `prefetchTasks`, `history.load`, `history.filters`, `history.stats`:
  every plugin contributes.
- **Hooks of a task** — `describeTask`, `describeMonitor`, `describeSettings`, `history.card`, `history.typeLabel`,
  `task.relaunch`, `task.links`, `taskcard.resultsLink`: one plugin answers. When the task names its project
  (`task.launcher.project`, below) only that plugin is asked; otherwise the plugins are asked in the order of
  `custom/config.js` and the first answer that is not `null` is taken. A plugin returns `null` for a task it does not
  know. (A task without launcher record goes to the first plugin that knows it; with one project installed, that is
  always the right one.)

A hook that throws is logged in the console and counts as `null`.

### The launcher record of a task

A launcher records itself in the task it submits: the field `runtime[RUNTIME_LAUNCHER]` of the submission, a JSON
object `{ "project": "<name>", "custom": { … } }`, `custom` being what its form needs to open again with the same
settings. The scheduler checks it (a JSON object with a non-empty string `project`, else the task is refused), adds it
to the task as its `launcher` — it is not substituted in the flow, and the flow JSON itself must not have a `launcher`
key — and returns it in the task's JSON (`/api/tasks/running`, `/api/task/<id>/state`, `/api/task/<id>/final_state`).
A task submitted without it has `launcher: {}`. The pages route the task's hooks by `launcher.project`, and their
relaunch buttons (the `...` menu of a card, the drawer of History, the task page) call `open(launcher.custom)` of that
project's launcher.

### A minimal plugin

```js
// <html>/board/custom/myproj/plugin.js, with config.js = { projects: ['myproj'] }
class Launcher {
  open(params) { /* show a form; on submit, POST /api/task/new (below) with runtime[RUNTIME_LAUNCHER] = { project: 'myproj', … } */ }
  async describeTask(task) {
    return task.job_type === 'build' ? { title: `🔨 ${task.name}` } : null;
  }
}
export default {
  launcher: Launcher,
  history: { typeLabel: (task) => task.type === 'build' ? { label: 'Build', cls: '' } : null },
};
```

## Flow JSON Shape (for reference)

Whatever a launcher submits as the `config` part of `/api/task/new` is a **flow JSON** document — the same format the
scheduling engine consumes directly via `POST /api/task/new`. Real examples ship under `samples/jobs/tests/*.json`. For
example, `samples/jobs/tests/test_publish.json`:

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

`publish.storage` and `publish.goal` (and any other flow field) support `${VAR}` substitution from the `args[...]` the
launcher POSTs alongside the flow — see below. `publish.server` must name a key under the server's `schedule.publisher`
config section (see `docs/configuration.md`). The flow JSON has no `launcher` key: a launcher sends its record as
`runtime[RUNTIME_LAUNCHER]` (above).

## Server-Side Contract: `POST /api/task/new`

This part is real, current code (`ns_Server::RequestHandlerTaskNew::handleRequest`,
`src/scheduler/server/request_handler.cxx`) — any launcher has to assemble a `multipart/form-data` body matching it:

| Form field | Required | Meaning |
|---|---|---|
| `name` | no (defaults to `""`) | Task display name. |
| `user` | no (defaults to `"anonymous"`) | Submitting user; tracked per-user by the Users API (`GET /api/users`, `GET /api/user/<u>/job_types`, `GET /api/user/<u>/<jobType>/tasks`). |
| `job_type` | no (defaults to `"unknown"`) | Arbitrary string identifying the job type; used purely for grouping/history, not validated against any registry server-side. |
| `config` | **yes** | The flow JSON file (see above). Request fails with `{"success": false, "error": "Missing config or script file."}` if absent. |
| `script` | **yes** | The step script file (bash, sourced by `executor.sh`/`functions.sh`). Same failure mode if absent. |
| `files[]` | no, repeatable | Extra files (patches, configs, etc.), keyed by their uploaded filename. |
| `args[<KEY>]` | no, repeatable | Free-form key/value pairs, parsed by stripping the `args[...]` wrapper off each form field name. Duplicate keys throw a 500 (`"args[] value duplicate key found"`). These become the `${KEY}` substitution variables available inside the flow JSON. |
| `runtime[<KEY>]` | no, repeatable | Field names `runtime[RUNTIME_<KEY>]`: the values of the `${RUNTIME_<KEY>}` placeholders of the flow JSON (`NB_RUN`, `NB_CORES`, `TIMEOUT`, `MEMORY_CORE`, `MEMORY_CONSUMPTION`, `RUN_SELECT`, `RUN_CONFIG`, `PRIORITY`), substituted textually before the flow JSON is parsed; and `runtime[RUNTIME_LAUNCHER]`, the record of the launcher, added to the task (above), not substituted. Duplicate keys throw the analogous 500. |

On success the handler returns `{"success": true, "task_id": "<id>"}`; on any exception, HTTP 500 with
`{"success": false, "error": "<message>"}`.

All board API routes, including `/api/task/new`, go through `ManageCORS`, which sets `Access-Control-Allow-Origin: *`
on every response — so a launcher can be served from, or POST to, an origin other than the board's own. Preflight is
handled too: any `OPTIONS` request is dispatched to a dedicated `RequestHandlerOptions` (matched on method alone,
independent of the URI), which answers `200 OK` with the CORS headers. See `docs/api.md` for the full CORS/OPTIONS
picture.

A launcher should check the scheduler before submitting (`CheckScheduler()` of `health.js`): a submission waits for the
schedule lock, so a busy or stopping scheduler is then named plainly instead of surfacing later as an opaque network
error.
