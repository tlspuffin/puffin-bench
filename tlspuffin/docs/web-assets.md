# installer — Web Assets (`data/html/`)

`installer/data/html/` holds every browser-facing asset specific to puffin-bench (as opposed to generic scheduler/publisher UI shipped by those projects themselves). It's embedded via the `InstallFiles` archive (see [architecture.md](architecture.md)) and extracted to `<datapath>/html/`, served by the scheduler (`/files/board/...`, `/files/jobsscripts/...`) and by the publisher (`/files/<project>/...`). This document covers the code that actually processes data — the landing page, the job-submission UI, and the results dashboard — not the accompanying `.css` files, which are pure styling and not described in detail here. `html/third-party/plotly/` is a vendored, unmodified copy of Plotly.js and likewise isn't covered.

## Landing Page (`index.html`)

A static page installed to `<datapath>/html/index.html`. Every page of the bench has the top bar of the bench (the
plugin below), so this page only redirects: to the scheduler board, or with `#results`, `#analyzer`, `#history`
(optionally `/<package>`, e.g. `#results/sshpuffin`) to that page, on the default ports of the services (10082,
10083, 10084) and the host of the page. No data processing of its own.

## Board Plugin (`board/custom/`)

The scheduler's pages know no project (see [scheduler/docs/board-job-launcher.md](../../scheduler/docs/board-job-launcher.md),
the plugin contract): what tlspuffin adds to them — its job launcher, the descriptions of its tasks and monitor
messages, its buttons and filters in History, its links on the task page, the top bar of the bench and its guide — is
its plugin, installed under `<datapath>/html/board/custom/`. The pages of the other services (Results, Bugs, the
objectives reports, Runs, Analyzer) load the same frame (`board/frame.js`) and so the same plugin: they all share the
`html` root.

- **`config.js`** — `{ projects: ['tlspuffin'] }`: the projects whose plugins the scheduler's `board/plugins.js` loads.
- **`tlspuffin/plugin.js`** — the plugin: `launcher` (a subclass of `JobLauncher` whose task descriptions also give the
  package to the search of History), `helpTexts` (those of `joblauncher.js`), `frame` (`bar.js`, and the tab
  "puffin-bench guide" of the help panel from `guide.js`), `history` (`history.js`), `task` (`relaunch`: the template of
  a task started without the launcher, from its job type, `COMMIT_ID` and `CAMPAIGN_ID`; `links`: **🕘 N runs**, the
  other tasks of the same commit and type kept by the publisher, from its `/html/runs/index.json`, shown when there are
  several) and `taskcard` (`resultsLink`: the published results with `&commit=<COMMIT_ID>`, so that Results shows the
  card of the commit when the publisher keeps a newer task of the same libraries).
- **`tlspuffin/bar.js`** — the items of the top bar: the bench (🐡 puffin-bench and its deployed version, from
  `version.json`), the services (Scheduler, Results, Analyzer, History; keys `g` then `s`/`r`/`a`/`h`) on the default
  ports and the host of the page, the yellow pill of the objectives found live (`/html/objectives/live.json`, not for
  VulnA/VulnB), the package shown by Results and Analyzer. On a page of another service it shows the status light of the
  scheduler on its default port; the scheduler's own pages show it at their address. It imports `hostlinks.js`: the
  links to this machine (a loopback host, or a port of the services) follow the address typed in the browser.
- **`tlspuffin/guide.js`** — the guide of the bench (pages, workflow, job types, words, symbols, services), including
  what tlspuffin adds to the pages of the scheduler.
- **`tlspuffin/history.js`** / **`history.css`** — on History: the buttons of a task from `task_links.json` (🐞 its
  objectives report, gold, plain for VulnA/VulnB whose objectives are expected, outlined when no bug is confirmed;
  🎯 the conclusion of a Vuln task, green / amber / red; a report with new bugs highlights the task and puts its title
  before the button); the package of each task (its `PACKAGE` argument, tlspuffin without one; read from the final
  state of the tasks and kept by the browser); the filters `all | tlspuffin | sshpuffin` (one at a time) and
  `🐞 with objectives` (with the states); the short job types (Perf, VulnA, VulnB, Camp) and their colours; the number
  of tasks with objectives in the counts.
- **`tlspuffin/task_links.json`** — not installed: written by `scripts/tools/objectives_report.sh` after each call
  (see [tlspuffin-job-scripts.md](tlspuffin-job-scripts.md)); urls relative to the History page.
- **`tlspuffin/version.json`** — not installed: the deployed version of the bench, written by
  `scripts/test_machine/deploy.sh`; read by the top bar, by the Bugs page and by the job scripts (`SummaryAddBench`,
  `scripts/PR_common.sh`), which record it in each summary.

### The job launcher (`tlspuffin/joblauncher.js`)

The launcher builds and submits a `POST /api/task/new` multipart request — the same request shape described in the root
[README](../../README.md#usage).

- **`tlspuffin/config.js`** — one constant: `commitsUrl`, pointing at git_restapi's `/api/git/history/tlspuffin` (port resolved by the installer). Consumed only by `joblauncher.js`.
- **`tlspuffin/jobsconfig.json`** — declares the five job types offered in the launcher UI (`vuln-a`, `vuln-b`, `perf`, `evaluate-pr`, `campaign`), each naming which flow-config/step-script/support-files to fetch from `<datapath>/html/jobsscripts/tlspuffin/` (see [tlspuffin-job-scripts.md](tlspuffin-job-scripts.md)) and submit as the task's `config`/`script`/`files[]` parts. `evaluate-pr` is a **composite**: it has no `config`/`script` of its own, only `"composite": ["vuln-a", "perf"]`, meaning the launcher submits two separate tasks and reports on both.
- **`tlspuffin/joblauncher.js`** (`JobLauncher` class, styled by `tlspuffin/joblauncher.css`, loaded when the launcher is created — only on the pages of the scheduler, so that the other pages keep their own look of the commit lines) — builds its own modal DOM (no framework), then:
  1. Fetches `jobsconfig.json` to populate the job-type chips, and the commit history from `commitsUrl` to populate a searchable, tabbed commit picker (`main/dev`, `PR`, `branches`, `All`) — PR data can be refreshed on demand against git_restapi's `?refresh=all`/`?refresh=local` (rate-limited GitHub API calls, credit/reset info surfaced in the refresh button's tooltip). `open(custom)` pre-fills the form with the settings of a previous task (`task.launcher.custom`), or with `{ job, commit }` from the board's `#launch=tlspuffin&job=<job type>&commit=<sha>` (e.g. "no Perf run" on Results).
  2. For `campaign` jobs, exposes extra fields (timeout, vendor/features/impl, per-attempt core/memory limits) that get folded into `runtime[RUNTIME_*]` form fields — these are the `${RUNTIME_*}` placeholders `PR_campaign.json` expects (see [tlspuffin-job-scripts.md](tlspuffin-job-scripts.md)), substituted by the scheduler when it creates the task, unrelated to the installer's own `${...}` substitution.
  3. On launch, checks the scheduler (`CheckScheduler()` of `board/health.js`), fetches the job's `config`/`script`/`files` as blobs and posts them as multipart form parts alongside `args[COMMIT_ID]`, `args[PACKAGE]`, and (for campaigns) `args[CAMPAIGN_ID]`/`args[SAVE_CORPUS]`/`args[DISABLE_KILL_ON_HANG]`. Its record, `{ "project": "tlspuffin", "custom": { … } }` (`custom`: every setting of the form), goes in `runtime[RUNTIME_LAUNCHER]`: the scheduler adds it to the task as its `launcher`, which the pages use to route the task to this plugin and to relaunch it with the same settings; the job file is sent as it is.
  4. `describeTask(task)` — called by the scheduler's board, task page and history (through `plugins.js`'s `DescribeTask`; the scheduler itself stays project-agnostic): resolves the task's commit (`COMMIT_ID` argument, or the commit id in the task name) with git_restapi and returns the commit line for the task title (`Perf@5c588a #540 [title]`, or `my test · Perf@…` for a custom name; type from the default name or the job type), the commit line shown for the `COMMIT_ID` argument (`commitLine`, not repeated when the title shows it: `inTitle`), the hover of its commit line for the search of History (full id, PR, date, whole message), and how to show `PACKAGE` (its value alone) and `COMPAT_WARNING` (a warning line). An unknown commit (or git_restapi down) keeps the task name.
  5. `describeMonitor(task, message)` — the one-line summary of a running experiment on the board: corpus size and age (⚠️ amber after 60 min without a new entry), objectives (🎉, linked to the live objectives page; plain, without 🎉, in VulnA/VulnB tasks, which look for known bugs), fuzzing errors and crashes, log volume, ASAN, age of the stats; the details in the hovers, the full message on click; red for errors, amber for warnings (stale stats, log volume, ASAN not instrumented). An attempt that found objectives is highlighted (`notable`: gold box, gold square in the step header; not in VulnA/VulnB) and its chip on the task page counts them (`badge`); the task gets a `🎉 N objectives · live ↗` button (objectives of all its attempts, on its card and on its task page) to the live objectives page; once the task is finished, `· report ↗` to its final page — until `objectives_report.sh` has written it, the live page (`· live ⏳`) while it exists, else `· report pending`. It reads the `#MONITOR_JSON` line that `MonitorExperiment` (`scripts/PR_common.sh`) appends to its message, or the message text for runs started before that line existed.
  6. `describeSettings(task)` — the settings of the task in readable form for the task page: job type, commit, package, timeout, configurations, attempts × cores, vendor (and the preset a `:latest-asan` vendor ran with), features, parameters, campaign, compat rules applied, LibAFL.

## Commit Context (`common/commitinfo.js`)

Shared by the dashboard and the tlspuffin launcher (served as `/files/common/commitinfo.js` next to `board/` and `publisher/`). It describes a commit as one line, `5c588a #540 [title]`: the short hash links to the commit, `#540` to the PR, the full id, kind, date and message are in the hover, and the message is capped.

- **merge**: a `dev` commit that merged a PR, from its message (`… (#540)` squash merge, or `Merge pull request #540 from …`).
- **tip**: the head of a PR: of an open PR (git_restapi history), or of any PR (`pulls` of the git_restapi logs, `index == total`); several PRs, newest first.
- **member**: an intermediate commit of a PR, `#453·3/7` (3rd of the 7 commits of the PR, `pulls` of the git_restapi logs).
- otherwise `[NO_PR]`; a commit git_restapi does not know shows its hash only (no claim about its PR).

sshpuffin is in the same repository: same links.

## Publisher Results Dashboard (`publisher/`)

Served by the publisher as a project's `index` page (`summary.html`, per the tlspuffin `.rules` file's `"index"` key — see the root [README](../../README.md#publisher-projects) and [publisher/docs/architecture.md](../../publisher/docs/architecture.md)). This is the largest piece here (~3100 lines across 11 JS files) — a single-page app with five tabs (main/dev, PR, branches, other users, campaigns).

### How a Result Reaches the Dashboard

```
scheduler task → summary.json artefact (see tlspuffin-job-scripts.md)
  → publisher rule "GenerateMergeJSON" (tlspuffin/.rules, one rule per PR/Vuln/Campaign)
      merges the new summary.json's "libraries" into a persistent per-commit file:
        Perf/<commit>.json, Vuln/<commit>.json, Campaign/<user>/<campaign>-<file>.json
      (mechanism documented in publisher/docs/architecture.md, not repeated here)
  → publisher's "files list" endpoint lists these merged files
  → summary_data.js fetches and normalizes them for the dashboard
```

### Data Layer (`summary_data.js`)

- `LoadProjectData` / `LoadCommits` — lists the publisher project's merged JSON files (`/api/project/<project>/data`) and fetches each one (`/files/<project>/.project/<file>`), in batches of 10 concurrent requests.
- `LoadGitData` / `LoadGitLogs` — commit/branch/PR history and per-commit log lookups from git_restapi, same endpoints the job launcher uses.
- **`dataDefinitions`** — the metric extraction schema, one entry per result type (`Perf`, `Vuln`, `Campaign`). Each metric names a `target` (`success` or `fail` — which attempts to include), a `datapath` (dotted path(s) into the per-attempt record produced by `perf_experiment_end.js`/`vuln_experiment_end.js`, e.g. `clients.tEnd.coverage`), and an optional `value` reducer (e.g. `DiffArray` for `tEnd - t0` durations). This is the direct consumer of the `{global, clients, others}` shape documented in [tlspuffin-job-scripts.md](tlspuffin-job-scripts.md)'s QuickJS section.
- **`BuildDataSet`** — for one commit's merged file, walks every library and every attempt, applies `dataDefinitions` to produce per-library metric arrays, and derives `global_status` (`success` if every attempt across every library succeeded, `fail` if all failed, `mixed` otherwise, `no run` if there's no data).

### Aggregation (`summary_metrics.js`, `summary_metricscampaign.js`)

`Metrics` reshapes a whole tab's worth of commits (one instance per tab: dev, PR, branches, users) into time series: `{type: {library: {metric: [{commit_id, values, status, cputs}]}}}`, ready to plot in commit order. `Metrics.ComputeXRange` computes the visible x-axis window for a graph based on viewport width, shared by every graph module below (and re-invoked on window resize). `MetricsCampaign` is the analogous, smaller aggregator used by the campaigns tab.

### Rendering (`summary_render.js`)

`RenderCommit`/`RenderCampaigns` build the per-commit DOM cards: a one-line header (a colored "pastille" per result type — success/fail/mixed/no-run —, the commit line of `common/commitinfo.js`, branch and date), then the result types side by side when they fit (stacked otherwise), each a table with one row per library: the library and its warnings and 🐞 objectives button, the build (harness, ASAN, preset@commit, flags; sources and description in the hover), the successful/total runs, and one column per metric (mean±sd in short form; values, range, median and exact mean in the hover, computed client-side via `ComputeBasicStats`/`CalculateStats`; a click on a column header switches it to per-run values), plus a row with the metrics of the failed runs, and action buttons/dropdowns linking out to the scheduler's task page (`ShowDetails`), a result-archive download (`DownloadResults`, streams the scheduler's `/api/task/:id/artefacts`), and vis_comparator (deep-linked with the commit/library as query params — see `summary.js`'s `config.vis_comparator_*` URL builders).

### Graphing (`summary_graph.js`, `summary_graphmetrics.js`, `summary_graphoverview.js`, `summary_graphcompare.js`, `summary_managegraphs.js`)

All four graph modals are thin wrappers around Plotly (`third-party/plotly/`), sharing the same trace-building static helpers in `Graph` (`summary_graph.js`): multi-attempt metrics render as box plots, single-value ones as diamond scatter markers, x-axis ticks are commits ordered oldest→newest, `⚙C 5c588a #540`: a "compiled vs. cargo" (`⚙C`/`🦀`) marker from each attempt's `cli.json`, the short hash and the PR (links), the full commit line in the hover (`Graph.TickLabel`, `Graph.DecorateGraphXTicks`).

| Module | Opened from | Shows |
|---|---|---|
| `GraphMetrics` | "📊 Métriques" button | One metric at a time, picked by type/library/metric, across every commit in the active tab. |
| `GraphOverview` | "📊 Overview" button | Multiple metrics/types at once for a health-at-a-glance view; accepts an optional `compareCommit` to overlay a baseline. |
| `GraphCompare` | "📈 Compare" button on a Perf/Campaign result card (`summary_render.js`) — not from within `GraphMetrics`/`GraphOverview` | A focused two-commit comparison for one metric (`InsertComparaisonData` in `Graph` builds the overlay trace). When the compare target is the dev/main tab, this button opens `GraphOverview` instead. |
| `manageGraphs` (`summary_managegraphs.js`) | n/a (singleton) | Not a graph itself — tracks every currently-open Plotly container ID and re-applies `Metrics.ComputeXRange` to all of them (debounced 200ms) on window resize, since Plotly doesn't do this on its own for a `category`-type x-axis. |

### Page Orchestration (`summary.js`, `summary_config.js`, `summary.html`)

`summary_config.js` holds the three cross-service base URLs (git_restapi, scheduler, vis_comparator), same `${PORT}`-in-template-literal pattern as `index.html` (see [configuration.md](configuration.md)'s note on `ResolveVariables()` and JS template-literal syntax coexisting). `summary.js`'s `Main()` wires up tabs, filters (status/type/search/PR-open-only), and the refresh button (`?refresh=local` for git_restapi's free/cached path, `?refresh=all` for the PR tab's GitHub-API-backed one — see [git_restapi/docs/architecture.md](../../git_restapi/docs/architecture.md)), then drives `RefreshData()`: fetch git history + project files in parallel, resolve unmatched commit IDs via a batched `git logs` call, build one `Metrics`/`GraphMetrics`/`GraphOverview` per tab, and render every commit's card. `summary.html` is the static shell (filters, tab bar, five empty containers) `summary.js` populates.
