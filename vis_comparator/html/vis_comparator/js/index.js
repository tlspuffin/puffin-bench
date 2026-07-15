import '../third-party/plotly/plotly-3.3.0.min.js'
const Plotly = window.Plotly;
import { ErrorManager } from "./error.js";
import { ApiREST } from "./apirest.js";
import { UI } from './ui.js'
import { GraphManager } from './graphmanager.js';
import { TASK_TYPES, ICONS, DEFAULT_LEGEND_FORMAT } from './constants.js';
import { state, globalDynamicSubtasks, globalCampaigns, getModalCancelFn, clearModalCancel, dedupSubtasks, resolveExperimentSlot, resolveMetricEntry, nextCommitColor, experimentKey, slotKey, removeGraph, fetchMetricSet } from './state.js';
import { initSidebar, BuildSidebar, flattenMetricPaths, reloadGraphData } from './sidebar.js';
import { initDialogs, ConfigBaseInformations, AddGraphique, EditGraph, OpenView, OpenTemplate, SaveAsTemplate, tryLoadViewFromURL, tryLoadTemplateFromURL, SuggestTemplatesFromURL, OpenInfoModal } from './dialogs.js';

// ============================================================
// CONFIGURATION
// ============================================================

// The protocol is the segment right after "files" in the page URL
// (/files/<protocol>[/index.html]); it scopes every API call to that dataset.
const protocol = window.location.pathname.split('/').filter(Boolean)[1];
if (!protocol) {
  document.body.textContent =
    'No protocol in URL. Open this page as /files/<protocol> (e.g. /files/tlspuffin).';
  throw new Error('Missing protocol segment in URL path');
}

const config = {
  apiBase: `/api/${encodeURIComponent(protocol)}/PR`,
};

// ============================================================
// HEADER & DOM SETUP
// ============================================================

const header = document.getElementById('header');
const main = document.getElementById('main');

// Header: read-only title + edit button
const headerTitle = document.createElement('span');
headerTitle.className = 'header-title-text';

const headerEditBtn = document.createElement('button');
headerEditBtn.className = 'header-edit-btn';
headerEditBtn.textContent = ICONS.PENCIL + ' Edit';
headerEditBtn.title = 'Rename this view';
headerEditBtn.style.display = 'none';
let headerEditInput = null;

const serverName = window.location.hostname;
const headerBrand = document.createElement('div');
headerBrand.className = 'header-brand';
headerBrand.textContent = `Experiment Analyzer on ${serverName}`;

function commitTitleEdit() {
  if (headerEditBtn.dataset.editing !== 'true' || !headerEditInput) return;
  const newTitle = headerEditInput.value.trim() || state.title;
  state.title = newTitle;
  headerTitle.textContent = newTitle;
  headerTitle.style.display = '';
  headerEditInput.remove();
  headerEditInput = null;
  headerEditBtn.style.display = '';
  headerEditBtn.dataset.editing = 'false';
}

headerEditBtn.onclick = function() {
  if (headerEditBtn.dataset.editing === 'true') {
    if (headerEditInput) headerEditInput.onblur = null; // avoid double commit
    commitTitleEdit();
  } else {
    // Start editing
    headerEditInput = document.createElement('input');
    headerEditInput.type = 'text';
    headerEditInput.className = 'header-edit-input';
    headerEditInput.value = state.title;
    headerEditInput.onkeydown = function(e) {
      if (e.key === 'Enter') {
        headerEditInput.onblur = null;
        commitTitleEdit();
      }
      if (e.key === 'Escape') {
        headerEditInput.onblur = null; // prevent commit on blur when cancelling
        headerTitle.style.display = '';
        headerEditInput.remove();
        headerEditInput = null;
        headerEditBtn.style.display = '';
        headerEditBtn.dataset.editing = 'false';
      }
    };
    headerTitle.style.display = 'none';
    headerEditBtn.style.display = 'none';
    headerTitle.insertAdjacentElement('afterend', headerEditInput);
    headerEditInput.focus();
    headerEditInput.select();
    headerEditInput.onblur = function() { commitTitleEdit(); };
    headerEditBtn.dataset.editing = 'true';
  }
};

const headerLeft = document.createElement('div');
headerLeft.className = 'header-center';
headerLeft.appendChild(headerTitle);
headerLeft.appendChild(headerEditBtn);
header.appendChild(headerBrand);
header.appendChild(headerLeft);

const headerToolbar = document.createElement('div');
headerToolbar.className = 'header-toolbar';
header.appendChild(headerToolbar);

function UpdateHeader() {
  headerTitle.textContent = state.title;
  headerEditBtn.style.display = '';
  if (headerEditInput) { headerEditInput.value = state.title; }
}

// ============================================================
// TOOLBAR BUTTONS & ENABLE/DISABLE
// ============================================================

const UIElt = [];

function EnableMainUI(enabled) {
  UIElt.forEach(el => enabled ? UI.EnableElement(el) : UI.DisableElement(el));
}

// ============================================================
// SAVE / LOAD
// ============================================================

const TITLE_MAX_LENGTH = 100;
const TITLE_VALID_RE = /^[\S ]+$/;

function ValidateTitle(title) {
  if (!title || title.length === 0) return 'View name cannot be empty.';
  if (title.length > TITLE_MAX_LENGTH) return `View name must be at most ${TITLE_MAX_LENGTH} characters.`;
  if (!TITLE_VALID_RE.test(title)) return 'View name can only contain any printable characters and spaces';
  return null;
}

function Save(state) {
  commitTitleEdit();
  const err = ValidateTitle(state.title);
  if (err) {
    errorManager.Error(err);
    EnableMainUI(true);
    return;
  }
  apirest.SavePage(state.title, state).then(function(ok) {
    if (ok) {
      errorManager.Success('View saved: ' + state.title);
    }
    EnableMainUI(true);
  });
}

// ============================================================
// STATE ORCHESTRATION
// ============================================================

async function ResetState(state, newState, templateName = null) {
  const migrated = newState;
  graphManager.DelAllGraph();
  state.title          = migrated?.title          ?? 'Vue_' + Date.now();
  state.graphSettings  = [];
  state.variables      = migrated?.variables      ?? {
    commits: new Map(), subtasks: new Map(), campaigns: new Map(), metrics: new Map(),
  };
  // Ensure the campaigns map exists (safe default for views saved before it existed).
  if (!(state.variables.campaigns instanceof Map)) state.variables.campaigns = new Map();
  state.legendFormat   = migrated?.legendFormat   ?? { ...DEFAULT_LEGEND_FORMAT };
  state.commitRegistry = migrated?.commitRegistry ?? new Map();
  state.metricLegend   = migrated?.metricLegend   ?? new Map();

  if (migrated?.titleFormat) {
    const resolved = GraphManager.InterpolateTitleFormat(
      migrated.titleFormat, state.variables, templateName
    );
    if (resolved) state.title = resolved;
  }

  UpdateHeader();
  const configList = asConfigList(migrated?.graphSettings);
  if (configList.length > 0) {
    // Templates carry an authored time range that rarely matches the experiments they
    // resolve to at load time; recompute it from real data. Views keep their saved range.
    await restoreGraphs(configList, /*recomputeRange=*/ templateName != null);
  }
  BuildSidebar(state);
}

/**
 * Normalises a loaded graphSettings value into an ordered list of graph configs.
 * New files store an array of { id, config }; legacy files store a Map<id, config>
 * (revived by JSONHelp). Saved ids are discarded — fresh ids are issued on render.
 * @param {Map|Array|undefined} saved
 * @returns {object[]} ordered graph configs
 */
function asConfigList(saved) {
  if (saved instanceof Map) return [...saved.values()];          // legacy files
  if (Array.isArray(saved)) return saved.map(e => e.config ?? e); // new ({id,config}) or bare
  return [];
}

/** Re-orders state.graphSettings to match the current on-screen (DOM) order. */
function resyncGraphOrder() {
  const order = graphManager.GetDomOrderedIds();
  state.graphSettings.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
}

/**
 * Re-fetches data and recreates all graphs from an ordered list of graph configs.
 * Called by ResetState after the global state (variables, commitRegistry) is applied.
 * @param {object[]} configList - ordered graph configs (ids are issued fresh on render)
 * @param {boolean} [recomputeRange=false] - When true (template load), refit each graph's
 *   time range to the real data extent of its resolved experiments.
 */
async function restoreGraphs(configList, recomputeRange = false) {
  // Renders a tracked placeholder graph (no data) so the config stays in
  // state.graphSettings for later variable resolution / redraw.
  const addPlaceholder = async (graphConfig) => {
    const id = await graphManager.AddGraph(graphConfig, new Map());
    state.graphSettings.push({ id, config: graphConfig });
  };

  for (const graphConfig of configList) {
    // Resolve each slot once, keeping the slot→resolved pairing (needed for slotKey
    // when seeding the commit registry below); drop slots that don't resolve.
    const pairs = graphConfig.experiments
      .map(slot => ({ slot, exp: resolveExperimentSlot(slot, state.variables) }))
      .filter(p => p.exp);
    const resolved = pairs.map(p => p.exp);

    if (resolved.length === 0) {
      // All experiment variables unresolved (template with null vars).
      await addPlaceholder(graphConfig);
      continue;
    }

    // Resolve MetricVarRef entries before fetching (deduplicate: same path from two variables)
    const resolvedMetrics = [...new Set(
      graphConfig.metrics
        .map(m => resolveMetricEntry(m, state.variables.metrics))
        .filter(Boolean)
    )];

    if (resolvedMetrics.length === 0) {
      // All metric variables unresolved.
      await addPlaceholder(graphConfig);
      continue;
    }

    // When the x-axis is a metric (not time), fetch it too so its resampled series
    // (and .mean) is available for #PrepareTraces. Deduplicated against the y-metrics.
    const fetchMetrics = fetchMetricSet(resolvedMetrics, graphConfig);

    if (recomputeRange) {
      const range = await apirest.ComputeTimeRange(resolved);
      if (range) Object.assign(graphConfig, range);
    }

    const results = await Promise.all(
      resolved.map(exp => apirest.LoadCommitMetricsValues(
        exp.tasktype, exp.commit, exp.subtask,
        graphConfig.min, graphConfig.max, graphConfig.delta,
        fetchMetrics, exp.timestamp, graphConfig.ciLevel ?? 95
      ))
    );

    const dataMap = new Map(
      resolved
        .map((exp, i) => ({ exp, data: results[i] }))
        .filter(p => p.data != null)
        .map(p => [experimentKey(p.exp), p.data])
    );

    if (dataMap.size === 0) {
      // Experiments resolved but no data came back (e.g. the referenced commit/subtask
      // has no results on this server). Show a placeholder rather than silently dropping it.
      await addPlaceholder(graphConfig);
      continue;
    }

    for (const { slot, exp } of pairs) {
      const key = slotKey(slot, exp);
      if (!state.commitRegistry.has(key)) {
        state.commitRegistry.set(key, { color: nextCommitColor(state.commitRegistry), displayName: null, visible: true });
      }
    }

    const id = await graphManager.AddGraph(graphConfig, dataMap);
    state.graphSettings.push({ id, config: graphConfig });
  }
}

// ============================================================
// INITIALISATION
// ============================================================

const errorManager = new ErrorManager();

const statusBarEl = document.getElementById('status-bar');
const statusBarText = statusBarEl.querySelector('.status-bar-text');
let _loadingCount = 0;
function onLoading(delta, label) {
  _loadingCount = Math.max(0, _loadingCount + delta);
  if (label && delta > 0) statusBarText.textContent = label;
  statusBarEl.classList.toggle('visible', _loadingCount > 0);
}

const apirest = new ApiREST(config.apiBase, errorManager, onLoading);
// Loaded once at startup; reused as a resolved Promise by all dropdowns.
const gitHistoryPromise = apirest.LoadGitHistory();
// Pre-fetch all available commits once for use in sidebar pill-selectors. Resolves
// to the bare commit-id list as soon as the two commit lists arrive; the subject
// prefetch below is a detached sidebar-warming side-effect and must NOT gate this
// promise (callers such as template-from-URL loading await it on the render path).
let allCommitsPromise = Promise.all([
  apirest.LoadCommits(TASK_TYPES.PERF),
  apirest.LoadCommits(TASK_TYPES.VULN),
]).then(([perf, vuln]) => {
  const recentPerf = perf.slice(0, 10);
  const recentVuln = vuln.slice(0, 10);

  const fetches = [];
  recentPerf.forEach(c => fetches.push(
    apirest.LoadCommitSubjects(TASK_TYPES.PERF, c).then(res => res.map(s => ({tasktype: TASK_TYPES.PERF, subtask: s.value})))
  ));
  recentVuln.forEach(c => fetches.push(
    apirest.LoadCommitSubjects(TASK_TYPES.VULN, c).then(res => res.map(s => ({tasktype: TASK_TYPES.VULN, subtask: s.value})))
  ));

  // Fire-and-forget: warm the dynamic-subtask cache and refresh the sidebar when done.
  Promise.all(fetches).then(results => {
    const before = globalDynamicSubtasks.length;
    dedupSubtasks(globalDynamicSubtasks, results.flat());
    if (globalDynamicSubtasks.length > before) BuildSidebar(state);
  });

  return [...new Set([...perf, ...vuln])];
});
// Load the campaign run list once; refresh the sidebar when it arrives. The promise is
// awaited before template-from-URL handling so campaign URL params can be resolved.
const campaignsReady = apirest.LoadCampaigns().then(list => {
  globalCampaigns.length = 0;
  globalCampaigns.push(...(list ?? []));
  BuildSidebar(state);
});
const ui = new UI();
const graphManager = new GraphManager(main, {
  delete:    function(id) { removeGraph(state, id); BuildSidebar(state); },
  duplicate: function(newId, config) {
    state.graphSettings.push({ id: newId, config }); // appended; resync sorts it into place
    resyncGraphOrder();
    BuildSidebar(state);
  },
  reorder:   function() { resyncGraphOrder(); },
  getState:  function()   { return state; },
  editGraph: function(id) { EditGraph(id); },
  getLatestTimestamp: function(type, commit) { return apirest.LatestTimestampSync(type, commit); },
  // Re-fetch + redraw a graph after its x-axis metric changed (needs a new series).
  // Returns whether the redraw happened so the caller can roll back on failure.
  reloadGraph: function(id, preserveView = false) {
    return reloadGraphData(state, id, preserveView).catch(err => {
      console.error('[xaxis] reload error:', err);
      return false;
    });
  },
  // All metric paths available across the given resolved experiments (union), for the
  // per-graph x-axis dropdown. Same source as the edit dialog's metric picker.
  getMetricOptions: async function(resolvedExps) {
    if (!resolvedExps || resolvedExps.length === 0) return [];
    const metricsResults = await Promise.all(resolvedExps.map(e =>
      apirest.LoadCommitMetrics(e.tasktype, e.commit, e.subtask, e.timestamp)));
    const union = new Set();
    for (const r of metricsResults) flattenMetricPaths(r).forEach(p => union.add(p));
    return [...union].sort();
  },
});

// Wire up module dependencies now that all objects are created.
initSidebar({
  graphManager,
  apirest,
  ui,
  enableMainUI: EnableMainUI,
  errorManager,
  allCommitsPromise,
  gitHistoryPromise,
});
initDialogs({
  state,
  graphManager,
  apirest,
  ui,
  enableMainUI: EnableMainUI,
  errorManager,
  resetState:   ResetState,
  updateHeader: UpdateHeader,
  gitHistoryPromise,
  allCommitsPromise,
});

// ============================================================
// HEADER TOOLBAR BUTTONS
// ============================================================

const uiAddGraph = UI.CreateToolbarBtn('+ Graph', 'Add a new graph');
uiAddGraph.onclick = function() {
  EnableMainUI(false);
  AddGraphique();
};
headerToolbar.appendChild(uiAddGraph);
UIElt.push(uiAddGraph);

const uiSaveView = UI.CreateToolbarBtn('Save view', 'Save the current view');
uiSaveView.onclick = function() {
  EnableMainUI(false);
  Save(state);
};
headerToolbar.appendChild(uiSaveView);
UIElt.push(uiSaveView);

const uiOpenView = UI.CreateToolbarBtn('Open view', 'Open a saved view');
uiOpenView.onclick = function() {
  const restoreUI = !uiAddGraph.classList.contains('is-disabled');
  EnableMainUI(false);
  OpenView(restoreUI);
};
headerToolbar.appendChild(uiOpenView);

const uiNewView = UI.CreateToolbarBtn('New view', 'Create a new blank view');
uiNewView.onclick = function() {
  const restoreUI = !uiAddGraph.classList.contains('is-disabled');
  EnableMainUI(false);
  ConfigBaseInformations(restoreUI);
};
headerToolbar.appendChild(uiNewView);

// Sidebar toggle is handled by the vertical tab (#sidebar-tab), not a header button.
// Wire up the tab click here so it has access to the UIElt enable/disable flow.
const sidebarTab = document.getElementById('sidebar-tab');
const sidebarResizeHandle = document.getElementById('sidebar-resize');
const sidebarWrapperEl = document.getElementById('sidebar-wrapper');
const sidebarPanelEl = document.getElementById('sidebar');

// Position the resize handle right after the sidebar-tab (absolute inside sticky wrapper)
function positionSidebarHandle() {
  if (!sidebarResizeHandle || !sidebarTab) return;
  sidebarResizeHandle.style.left = sidebarTab.offsetWidth + 'px';
}
positionSidebarHandle();

let sidebarSavedWidth = null; // custom width set by drag, saved across collapse/expand

if (sidebarTab) {
  sidebarTab.addEventListener('click', () => {
    if (sidebarWrapperEl.classList.contains('collapsed')) {
      // Expanding: restore dragged width if any
      sidebarWrapperEl.classList.remove('collapsed');
      if (sidebarSavedWidth !== null) {
        sidebarPanelEl.style.width = sidebarSavedWidth;
      }
    } else {
      // Collapsing: save then clear inline width so CSS width:0 applies
      sidebarSavedWidth = sidebarPanelEl.style.width || null;
      sidebarPanelEl.style.width = '';
      sidebarWrapperEl.classList.add('collapsed');
    }
  });
}

// Resize sidebar by dragging the handle
if (sidebarResizeHandle && sidebarPanelEl) {
  let isResizing = false;
  let resizeStartX = 0;
  let resizeStartWidth = 0;

  sidebarResizeHandle.addEventListener('mousedown', function(e) {
    if (sidebarWrapperEl.classList.contains('collapsed')) return;
    isResizing = true;
    resizeStartX = e.clientX;
    resizeStartWidth = sidebarPanelEl.offsetWidth;
    sidebarResizeHandle.classList.add('is-dragging');
    sidebarPanelEl.style.transition = 'none';
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', function(e) {
    if (!isResizing) return;
    const delta = resizeStartX - e.clientX;
    const newWidth = Math.max(160, Math.min(600, resizeStartWidth + delta));
    sidebarPanelEl.style.width = newWidth + 'px';
  });

  document.addEventListener('mouseup', function() {
    if (!isResizing) return;
    isResizing = false;
    sidebarResizeHandle.classList.remove('is-dragging');
    sidebarPanelEl.style.transition = '';
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    graphManager.ResizeAll();
  });
}

const uiOpenTpl = UI.CreateToolbarBtn('Open template', 'Open a saved template');
uiOpenTpl.onclick = function() {
  const restoreUI = !uiAddGraph.classList.contains('is-disabled');
  EnableMainUI(false);
  OpenTemplate(restoreUI);
};
headerToolbar.appendChild(uiOpenTpl);
// Not pushed to UIElt — remains enabled at page load so templates can be opened without a view.

const uiSaveTpl = UI.CreateToolbarBtn('Save template', 'Save current view as template');
uiSaveTpl.onclick = function() {
  EnableMainUI(false);
  SaveAsTemplate(state);
};
headerToolbar.appendChild(uiSaveTpl);
UIElt.push(uiSaveTpl);

const uiInfo = UI.CreateToolbarBtn('Help', 'Explains how this webapp works');
uiInfo.onclick = OpenInfoModal;
headerToolbar.appendChild(uiInfo);

UIElt.forEach(function(element) {
  UI.DisableElement(element);
});

const modalpage = document.getElementById('modalpage');

// ============================================================
// GLOBAL KEYBOARD / BACKDROP HANDLERS
// ============================================================

document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape' && getModalCancelFn()) {
    const fn = getModalCancelFn();
    clearModalCancel();
    fn();
  }
});

modalpage.addEventListener('click', function(e) {
  if (e.target === modalpage && getModalCancelFn()) {
    const fn = getModalCancelFn();
    clearModalCancel();
    fn();
  }
});

tryLoadViewFromURL().then(async function(loaded) {
  if (loaded) return;
  // No explicit view — try an explicit template link. Campaign URL params resolve against
  // globalCampaigns, so make sure the run list has arrived first.
  await campaignsReady;
  if (await tryLoadTemplateFromURL()) return;
  // No explicit template — if the URL carries variables, offer matching templates.
  if (await SuggestTemplatesFromURL()) return;
  // Otherwise create a default view so the user can start immediately.
  const defaultTitle = 'Vue_' + Date.now();
  await ResetState(state, { title: defaultTitle });
  EnableMainUI(true);
});
console.log('done');
