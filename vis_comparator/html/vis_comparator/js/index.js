import '../../third-party/plotly/plotly-3.3.0.min.js'
const Plotly = window.Plotly;
import { ErrorManager } from "./error.js";
import { ApiREST } from "./apirest.js";
import { UI } from './ui.js'
import { GraphManager } from './graphmanager.js';
import { TASK_TYPES, ICONS, DEFAULT_LEGEND_FORMAT } from './constants.js';
import { state, globalDynamicSubtasks, globalCampaigns, getModalCancelFn, clearModalCancel, dedupSubtasks, resolveExperimentSlot, resolveMetricEntry, nextCommitColor, experimentKey } from './state.js';
import { initSidebar, BuildSidebar } from './sidebar.js';
import { initDialogs, ConfigBaseInformations, AddGraphique, EditGraph, OpenView, OpenTemplate, SaveAsTemplate, tryLoadTemplateFromURL, OpenInfoModal } from './dialogs.js';

// ============================================================
// CONFIGURATION
// ============================================================

const config = {
  apiBase: '/api/PR',
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
  state.graphSettings  = new Map();
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
  if (migrated?.graphSettings?.size > 0) {
    await restoreGraphs(migrated.graphSettings);
  }
  BuildSidebar(state);
}

/**
 * Re-fetches data and recreates all graphs from a saved graphSettings Map.
 * Called by ResetState after the global state (variables, commitRegistry) is applied.
 * @param {Map<number, object>} savedSettings
 */
async function restoreGraphs(savedSettings) {
  for (const [, graphConfig] of savedSettings) {
    // Resolve concrete experiment entries (skip unresolvable slots)
    const resolved = graphConfig.experiments
      .map(slot => resolveExperimentSlot(slot, state.variables))
      .filter(Boolean);

    if (resolved.length === 0) {
      // All experiment variables unresolved (template with null vars) — render placeholders
      // so the config is tracked in state.graphSettings for later variable resolution.
      const id = await graphManager.AddGraph(graphConfig, new Map());
      state.graphSettings.set(id, graphConfig);
      continue;
    }

    // Resolve MetricVarRef entries before fetching (deduplicate: same path from two variables)
    const resolvedMetrics = [...new Set(
      graphConfig.metrics
        .map(m => resolveMetricEntry(m, state.variables.metrics))
        .filter(Boolean)
    )];

    if (resolvedMetrics.length === 0) {
      // All metric variables unresolved — render placeholders.
      const id = await graphManager.AddGraph(graphConfig, new Map());
      state.graphSettings.set(id, graphConfig);
      continue;
    }

    const results = await Promise.all(
      resolved.map(exp => apirest.LoadCommitMetricsValues(
        exp.tasktype, exp.commit, exp.subtask,
        graphConfig.min, graphConfig.max, graphConfig.delta,
        resolvedMetrics, exp.timestamp
      ))
    );

    const dataMap = new Map(
      resolved
        .map((exp, i) => ({ exp, data: results[i] }))
        .filter(p => p.data != null)
        .map(p => [experimentKey(p.exp), p.data])
    );

    if (dataMap.size === 0) continue;

    for (const exp of resolved) {
      const expKey = experimentKey(exp);
      if (!state.commitRegistry.has(expKey)) {
        state.commitRegistry.set(expKey, { color: nextCommitColor(state.commitRegistry), displayName: null, visible: true });
      }
    }

    const id = await graphManager.AddGraph(graphConfig, dataMap);
    state.graphSettings.set(id, graphConfig);
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
// Pre-fetch all available commits once for use in sidebar pill-selectors.
let allCommitsPromise = Promise.all([
  apirest.LoadCommits(TASK_TYPES.PERF),
  apirest.LoadCommits(TASK_TYPES.VULN),
]).then(async ([perf, vuln]) => {
  const all = [...new Set([...perf, ...vuln])];

  const recentPerf = perf.slice(0, 10);
  const recentVuln = vuln.slice(0, 10);

  const fetches = [];
  recentPerf.forEach(c => fetches.push(
    apirest.LoadCommitSubjects(TASK_TYPES.PERF, c).then(res => res.map(s => ({tasktype: TASK_TYPES.PERF, subtask: s.value})))
  ));
  recentVuln.forEach(c => fetches.push(
    apirest.LoadCommitSubjects(TASK_TYPES.VULN, c).then(res => res.map(s => ({tasktype: TASK_TYPES.VULN, subtask: s.value})))
  ));

  const results = await Promise.all(fetches);
  const before = globalDynamicSubtasks.length;
  dedupSubtasks(globalDynamicSubtasks, results.flat());
  if (globalDynamicSubtasks.length > before) BuildSidebar(state);

  return all;
});
// Load the campaign run list once; refresh the sidebar when it arrives.
apirest.LoadCampaigns().then(list => {
  globalCampaigns.length = 0;
  globalCampaigns.push(...(list ?? []));
  BuildSidebar(state);
});
const ui = new UI();
const graphManager = new GraphManager(main, {
  delete:    function(id) { state.graphSettings.delete(id); BuildSidebar(state); },
  getState:  function()   { return state; },
  editGraph: function(id) { EditGraph(id); },
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

tryLoadTemplateFromURL().then(function(loaded) {
  if (!loaded) {
    // No URL template — create a default view so the user can start immediately.
    const defaultTitle = 'Vue_' + Date.now();
    ResetState(state, { title: defaultTitle }).then(function() {
      EnableMainUI(true);
    });
  }
});
console.log('done');
