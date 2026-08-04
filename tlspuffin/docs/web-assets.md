# installer — Web Assets (`data/html/`)

`installer/data/html/` holds every browser-facing asset specific to puffin-bench (as opposed to generic scheduler/publisher UI shipped by those projects themselves). It's embedded via the `InstallFiles` archive (see [architecture.md](architecture.md)) and extracted to `<datapath>/html/`, served by the scheduler (`/files/board/...`, `/files/jobsscripts/...`) and by the publisher (`/files/<project>/...`). This document covers the code that actually processes data — the landing page, the job-submission UI, and the results dashboard — not the accompanying `.css` files, which are pure styling and not described in detail here. `html/third-party/plotly/` is a vendored, unmodified copy of Plotly.js and likewise isn't covered.

## Landing Page (`index.html`)

A static page installed to `<datapath>/html/index.html`, with `${SCHEDULER_PORT}`/`${PUBLISHER_PORT}`/`${VIS_COMPARATOR_PORT}` resolved by the installer at install time (see [configuration.md](configuration.md)). It renders a left-hand nav (`#navitems`) built from a hardcoded `services` array — Scheduler board, Publisher results, vis_comparator, and the scheduler's history page — each opening in the `#content` iframe. Purely navigational; no data processing of its own.

## Job Launcher (`board/launchers/`)

`board/launchers/` holds two layers: a generic, per-project plugin registry directly under it, and the concrete tlspuffin launcher one level down in `board/launchers/tlspuffin/`.

- **`config.js`** (directly under `board/launchers/`) — `{ projects: ['tlspuffin'] }`, the plugin registry consumed by the scheduler's own `board/launchers/launchers.js`, which drives the "+" button's launcher menu and dynamically `import()`s `./<project>/joblauncher.js` for each listed project.

The tlspuffin launcher itself, under `board/launchers/tlspuffin/`, is a self-contained UI module, embedded into the scheduler's board page, that builds and submits a `POST /api/task/new` multipart request — the same request shape described in the root [README](../../README.md#usage).

- **`tlspuffin/config.js`** — one constant: `commitsUrl`, pointing at git_restapi's `/api/git/history/tlspuffin` (port resolved by the installer). Consumed only by `joblauncher.js`.
- **`tlspuffin/jobsconfig.json`** — declares the five job types offered in the launcher UI (`vuln-a`, `vuln-b`, `perf`, `evaluate-pr`, `campaign`), each naming which flow-config/step-script/support-files to fetch from `<datapath>/html/jobsscripts/tlspuffin/` (see [tlspuffin-job-scripts.md](tlspuffin-job-scripts.md)) and submit as the task's `config`/`script`/`files[]` parts. `evaluate-pr` is a **composite**: it has no `config`/`script` of its own, only `"composite": ["vuln-a", "perf"]`, meaning the launcher submits two separate tasks and reports on both.
- **`tlspuffin/joblauncher.js`** (`JobLauncher` class, styled by `tlspuffin/joblauncher.css`) — builds its own modal DOM (no framework), then:
  1. Fetches `jobsconfig.json` to populate the job-type chips, and the commit history from `commitsUrl` to populate a searchable, tabbed commit picker (`main/dev`, `PR`, `branches`, `All`) — PR data can be refreshed on demand against git_restapi's `?refresh=all`/`?refresh=local` (rate-limited GitHub API calls, credit/reset info surfaced in the refresh button's tooltip).
  2. For `campaign` jobs, exposes extra fields (timeout, vendor/features/impl, per-attempt core/memory limits) that get folded into `runtime[RUNTIME_*]` form fields — these are the `${RUNTIME_*}` placeholders `PR_campaign.json` expects (see [tlspuffin-job-scripts.md](tlspuffin-job-scripts.md)); this substitution is entirely client-side JS template literals, unrelated to the installer's own `${...}` substitution.
  3. On launch, fetches the job's `config`/`script`/`files` as blobs and posts them as multipart form parts alongside `args[COMMIT_ID]`, `args[PACKAGE]`, and (for campaigns) `args[CAMPAIGN_ID]`/`args[SAVE_CORPUS]`/`args[DISABLE_KILL_ON_HANG]`.

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

`RenderCommit`/`RenderCampaigns` build the per-commit DOM cards: a colored "pastille" per result type (success/fail/mixed/no-run), metric widgets with hover tooltips (mean/stddev computed client-side via `ComputeBasicStats`/`CalculateStats`), and action buttons/dropdowns linking out to the scheduler's task page (`ShowDetails`), a result-archive download (`DownloadResults`, streams the scheduler's `/api/task/:id/artefacts`), and vis_comparator (deep-linked with the commit/library as query params — see `summary.js`'s `config.vis_comparator_*` URL builders).

### Graphing (`summary_graph.js`, `summary_graphmetrics.js`, `summary_graphoverview.js`, `summary_graphcompare.js`, `summary_managegraphs.js`)

All four graph modals are thin wrappers around Plotly (`third-party/plotly/`), sharing the same trace-building static helpers in `Graph` (`summary_graph.js`): multi-attempt metrics render as box plots, single-value ones as diamond scatter markers, x-axis ticks are commit hashes ordered oldest→newest and annotated with a "compiled vs. cargo" (`⚙C`/`🦀`) marker from each attempt's `cli.json`.

| Module | Opened from | Shows |
|---|---|---|
| `GraphMetrics` | "📊 Métriques" button | One metric at a time, picked by type/library/metric, across every commit in the active tab. |
| `GraphOverview` | "📊 Overview" button | Multiple metrics/types at once for a health-at-a-glance view; accepts an optional `compareCommit` to overlay a baseline. |
| `GraphCompare` | "📈 Compare" button on a Perf/Campaign result card (`summary_render.js`) — not from within `GraphMetrics`/`GraphOverview` | A focused two-commit comparison for one metric (`InsertComparaisonData` in `Graph` builds the overlay trace). When the compare target is the dev/main tab, this button opens `GraphOverview` instead. |
| `manageGraphs` (`summary_managegraphs.js`) | n/a (singleton) | Not a graph itself — tracks every currently-open Plotly container ID and re-applies `Metrics.ComputeXRange` to all of them (debounced 200ms) on window resize, since Plotly doesn't do this on its own for a `category`-type x-axis. |

### Page Orchestration (`summary.js`, `summary_config.js`, `summary.html`)

`summary_config.js` holds the three cross-service base URLs (git_restapi, scheduler, vis_comparator), same `${PORT}`-in-template-literal pattern as `index.html` (see [configuration.md](configuration.md)'s note on `ResolveVariables()` and JS template-literal syntax coexisting). `summary.js`'s `Main()` wires up tabs, filters (status/type/search/PR-open-only), and the refresh button (`?refresh=local` for git_restapi's free/cached path, `?refresh=all` for the PR tab's GitHub-API-backed one — see [git_restapi/docs/architecture.md](../../git_restapi/docs/architecture.md)), then drives `RefreshData()`: fetch git history + project files in parallel, resolve unmatched commit IDs via a batched `git logs` call, build one `Metrics`/`GraphMetrics`/`GraphOverview` per tab, and render every commit's card. `summary.html` is the static shell (filters, tab bar, five empty containers) `summary.js` populates.
