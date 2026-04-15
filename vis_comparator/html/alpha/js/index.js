import './plotly-3.3.0.min.js'
const Plotly = window.Plotly;
import { ErrorManager } from "./error.js";
import { ApiREST } from "./apirest.js";
import { UI } from './ui.js'
import { GraphManager, COMMIT_PALETTE } from './graphmanager.js';
import { CommitHelp } from './commithelp.js';

// ============================================================
// CONFIGURATION
// ============================================================

const config = {
  apiBase: '/api/PR',
};

// ============================================================
// STATE
// ============================================================

let currentModalCancelFn = null;
function setModalCancel(fn) { currentModalCancelFn = fn; }
function clearModalCancel() { currentModalCancelFn = null; }

// Populated in the INITIALISATION section after apirest is created.
let allCommitsPromise = Promise.resolve([]);
const globalDynamicSubtasks = [];

const state = {
  title: 'No Title_' + Date.now(),
  graphSettings: new Map(),
  variables: {
    commits:  new Map(),  // name → { value: commitID | null, alias: string | null }
    subtasks: new Map(),  // name → { value: { tasktype, subtask } | null, alias: string | null }
    metrics:  new Map(),  // name → metricPath | null
  },
  legendFormat: {
    experiment: null,  // template string | null  (e.g. "${COMMIT_ALIAS} − ${SUBTASK_ALIAS}")
    metric:     null,  // template string | null  (e.g. "${METRIC:uppercase}")
  },
  commitRegistry: new Map(),
  metricLegend:   new Map(),  // metricPath → { displayName: string|null, dash: string|null }
};

// ============================================================
// STATE MANAGEMENT
// ============================================================

/**
 * Migrates a loaded state object from the old experiment-variable format
 * (variables.experiments) to the new split format (variables.commits / variables.subtasks).
 * Also ensures legendFormat is present.
 * @param {object|null} loadedState
 * @returns {object|null}
 */
function migrateStateIfNeeded(loadedState) {
  if (!loadedState) return loadedState;

  // ── Old format: variables.experiments exists ─────────────────────────────
  if (loadedState.variables?.experiments instanceof Map) {
    const oldExps    = loadedState.variables.experiments;
    const newCommits  = new Map();
    const newSubtasks = new Map();

    for (const [ename, def] of oldExps) {
      newCommits.set(`c_${ename}`, {
        value: def ? def.commit : null,
        alias: null,
      });
      newSubtasks.set(`s_${ename}`, {
        value: def ? { tasktype: def.type, subtask: def.subject } : null,
        alias: null,
      });
    }

    loadedState.variables = {
      commits:  newCommits,
      subtasks: newSubtasks,
      metrics:  loadedState.variables.metrics ?? new Map(),
    };

    // Migrate graph experiment slots
    if (loadedState.graphSettings instanceof Map) {
      for (const [, config] of loadedState.graphSettings) {
        if (!Array.isArray(config.experiments)) continue;
        config.experiments = config.experiments.map(slot => {
          if ('variable' in slot) {
            // Old { variable: "e1" } → { commitVar: "c_e1", subtaskVar: "s_e1" }
            return { commitVar: `c_${slot.variable}`, subtaskVar: `s_${slot.variable}` };
          }
          // Old manual { commit, type, subject } → { commit, tasktype, subtask }
          if (slot.commit !== undefined) {
            return { commit: slot.commit, tasktype: slot.type, subtask: slot.subject };
          }
          return slot;
        });
      }
    }
  } else if (loadedState.variables && !loadedState.variables.commits) {
    // Partial new state without commits/subtasks — initialise empty
    loadedState.variables.commits  = loadedState.variables.commits  ?? new Map();
    loadedState.variables.subtasks = loadedState.variables.subtasks ?? new Map();
  }

  // ── Ensure legendFormat exists ────────────────────────────────────────────
  if (!loadedState.legendFormat) {
    loadedState.legendFormat = { experiment: null, metric: null };
  }

  return loadedState;
}

/**
 * Resolves a graph-config experiment slot to a concrete { commit, tasktype, subtask } object.
 * Returns null if either side (commit or subtask) is unresolved.
 * @param {object} slot      - Experiment slot (may contain commitVar/subtaskVar for variable refs,
 *                             or commit/tasktype/subtask for manual values)
 * @param {object} variables - state.variables ({ commits, subtasks })
 * @returns {{ commit: string, tasktype: string, subtask: string } | null}
 */
function resolveExperimentSlot(slot, variables) {
  let commit   = null;
  let tasktype = null;
  let subtask  = null;

  if (slot.commitVar) {
    const entry = variables?.commits?.get(slot.commitVar);
    commit = entry?.value ?? null;
  } else {
    commit = slot.commit ?? null;
  }

  if (slot.subtaskVar) {
    const entry = variables?.subtasks?.get(slot.subtaskVar);
    const val   = entry?.value ?? null;
    if (val) { tasktype = val.tasktype; subtask = val.subtask; }
  } else {
    tasktype = slot.tasktype ?? null;
    subtask  = slot.subtask  ?? null;
  }

  if (commit && tasktype && subtask) return { commit, tasktype, subtask };
  return null;
}

async function ResetState(state, newState) {
  const migrated = migrateStateIfNeeded(newState);
  graphManager.DelAllGraph();
  state.title          = migrated?.title          ?? 'Vue_' + Date.now();
  state.graphSettings  = new Map();
  state.variables      = migrated?.variables      ?? {
    commits: new Map(), subtasks: new Map(), metrics: new Map(),
  };
  state.legendFormat   = migrated?.legendFormat   ?? { experiment: null, metric: null };
  state.commitRegistry = migrated?.commitRegistry ?? new Map();
  state.metricLegend   = migrated?.metricLegend   ?? new Map();
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
    const resolvedMetrics = [...new Set(graphConfig.metrics
      .map(m => {
        if (typeof m === 'object' && m !== null && 'variable' in m) {
          return state.variables.metrics.get(m.variable) ?? null;
        }
        if (typeof m === 'string') {
          try {
            const parsed = JSON.parse(m);
            if (parsed?.variable) return state.variables.metrics.get(parsed.variable) ?? null;
          } catch (_) {}
        }
        return m;
      })
      .filter(Boolean))];

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
        resolvedMetrics
      ))
    );

    const dataMap = new Map(
      resolved
        .map((exp, i) => ({ exp, data: results[i] }))
        .filter(p => p.data != null)
        .map(p => [`${p.exp.commit}:${p.exp.tasktype}:${p.exp.subtask}`, p.data])
    );

    if (dataMap.size === 0) continue;

    const id = await graphManager.AddGraph(graphConfig, dataMap);
    state.graphSettings.set(id, graphConfig);
  }
}

// ============================================================
// MODALS
// ============================================================

function ConfigBaseInformations(restoreUI = false) {
  const modalpage = document.getElementById('modalpage');
  modalpage.innerHTML = '';

  const container = document.createElement('div');
  ui.Reset();

  container.appendChild(ui.CreateTitle('1. View name', 'h3', null));
  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.className = 'modal_text_input';
  titleInput.placeholder = 'Auto-generated if left empty\u2026';
  container.appendChild(titleInput);

  setModalCancel(function() {
    clearModalCancel();
    modalpage.classList.remove('modalpage_visible');
    EnableMainUI(restoreUI);
  });

  const actions = ui.CreateActions(true, {
    ok: {
      callback: async function() {
        let title = titleInput.value.trim() || ('Vue_' + Date.now());

        // Check for duplicate names and auto-increment if needed
        const pages = await apirest.ListPages();
        if (pages?.files) {
          const existingNames = new Set(pages.files);
          if (existingNames.has(title)) {
            const baseTitle = title;
            let counter = 2;
            let candidate;
            do {
              candidate = `${baseTitle} (${counter++})`;
            } while (existingNames.has(candidate));
            title = candidate;
          }
        }

        clearModalCancel();
        modalpage.classList.remove('modalpage_visible');
        await ResetState(state, { title });
        EnableMainUI(true);
      },
    },
    cancel: {
      callback: function() {
        clearModalCancel();
        modalpage.classList.remove('modalpage_visible');
        EnableMainUI(restoreUI);
      }
    }
  });
  container.appendChild(actions);

  modalpage.appendChild(container);
  modalpage.classList.add('modalpage_visible');
}

const DEFAULT_DELTA_DIVISOR = 20_000;
const MAX_EXPERIMENTS = 4;

// Flatten a nested metric Map ({ metrics: Map }) to a Set of leaf dot-paths.
function flattenMetricPaths(metricsObj) {
  const paths = new Set();
  if (!metricsObj?.metrics) return paths;
  function walk(map, prefix) {
    map.forEach((child, key) => {
      const path = prefix ? `${prefix}.${key}` : key;
      if (child.size === 0) paths.add(path);
      else walk(child, path);
    });
  }
  walk(metricsObj.metrics, '');
  return paths;
}

// Build a nested Map from a flat Set of dot-paths, as expected by ui.CreateMetrics.
function buildSyntheticMetrics(paths) {
  const root = new Map();
  paths.forEach(path => {
    const parts = path.split('.');
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      if (!node.has(parts[i])) node.set(parts[i], new Map());
      node = node.get(parts[i]);
    }
  });
  return { metrics: root, maxTimeMicroS: 0 };
}

async function AddGraphique(prefill = null, editId = null) {
  const gitHistory = gitHistoryPromise;
  const allCommits = await allCommitsPromise;

  // Slots use the same format as graphConfig.experiments:
  // { commitVar, commit, subtaskVar, tasktype, subtask }
  function createEmptySlot() {
    return { commitVar: null, commit: null, subtaskVar: null, tasktype: null, subtask: null };
  }

  function resolveSlot(slot) {
    return resolveExperimentSlot(slot, state.variables);
  }

  function resolvedSlots() {
    return slots.map(resolveSlot).filter(Boolean);
  }

  const slots = prefill ? prefill.experiments.map(s => ({ ...s })) : [createEmptySlot()];
  let metricsMode = prefill?.metricsMode ?? 'AND';
  let selectedMetrics = [];
  let metricsPrefilled = false;
  let metricsUIContainer = null;
  let timeID = null;
  let btOk = null;
  let metricsRebuildGen = 0;
  // Indices of slots that resolved but had no data (for ⚠ badge in slot rows)
  let invalidSlotIndices = new Set();

  const modalpage = document.getElementById('modalpage');
  modalpage.innerHTML = '';

  const container = document.createElement('div');
  ui.Reset();

  // ── Section 1: Experiments ──────────────────────────────────────
  if (editId !== null) {
    container.appendChild(ui.CreateTitle('Edit graph', 'h3', null));
  }
  container.appendChild(ui.CreateTitle('1. Experiments', 'h3', null));
  const experimentList = document.createElement('div');
  experimentList.className = 'experiment-list';
  container.appendChild(experimentList);

  const addBtn = document.createElement('button');
  addBtn.className = 'experiment-row-add-btn';
  addBtn.textContent = '+ Add experiment';
  addBtn.onclick = function() {
    if (slots.length >= MAX_EXPERIMENTS) return;
    slots.push(createEmptySlot());
    renderExperiments();
    onExperimentChange();
  };
  container.appendChild(addBtn);

  // ── Section 2: Metrics ─────────────────────────────────────────
  container.appendChild(ui.CreateTitle('2. Metrics', 'h3', null));

  const modeRow = document.createElement('div');
  modeRow.className = 'metrics-mode-row';
  const modeLabel = document.createElement('span');
  modeLabel.textContent = 'Mode:';
  modeRow.appendChild(modeLabel);

  const btnAnd = document.createElement('button');
  btnAnd.className = 'graph-toggle-btn active';
  btnAnd.textContent = 'AND';
  btnAnd.title = 'Only metrics common to all experiments';
  const btnOr = document.createElement('button');
  btnOr.className = 'graph-toggle-btn';
  btnOr.textContent = 'OR';
  btnOr.title = 'All metrics; absent ones shown in orange';
  btnAnd.onclick = function() {
    metricsMode = 'AND';
    btnAnd.classList.add('active');
    btnOr.classList.remove('active');
    rebuildMetricsUI();
  };
  btnOr.onclick = function() {
    metricsMode = 'OR';
    btnOr.classList.add('active');
    btnAnd.classList.remove('active');
    rebuildMetricsUI();
  };
  modeRow.appendChild(btnAnd);
  modeRow.appendChild(btnOr);
  if (prefill?.metricsMode === 'OR') {
    btnAnd.classList.remove('active');
    btnOr.classList.add('active');
  }
  container.appendChild(modeRow);

  const metricsWrapper = document.createElement('div');
  container.appendChild(metricsWrapper);

  // ── Section 3: Time range ──────────────────────────────────────
  container.appendChild(ui.CreateTitle('3. Time range (\u03bcs)', 'h3', null));
  timeID = ui.ID();
  const time = ui.CreateTimeSelection(0, 0, 0, null);
  container.appendChild(time);

  if (prefill) {
    const s = time.querySelector('#time_start_' + timeID);
    const e = time.querySelector('#time_end_'   + timeID);
    const d = time.querySelector('#time_delta_' + timeID);
    const p = time.querySelector('#time_steps_' + timeID);
    if (s) s.value = prefill.min;
    if (e) e.value = prefill.max;
    if (d) d.value = prefill.delta;
    if (p && prefill.delta > 0) p.value = Math.floor((prefill.max - prefill.min) / prefill.delta);
  }

  setModalCancel(function() {
    clearModalCancel();
    modalpage.classList.remove('modalpage_visible');
    EnableMainUI(true);
  });

  // ── Actions ────────────────────────────────────────────────────
  const actions = ui.CreateActions(true, {
    ok: {
      callback: async function() {
        const resolved = resolvedSlots();
        if (resolved.length === 0 || selectedMetrics.length === 0) return;

        const min   = +document.getElementById('time_start_' + timeID).value;
        const max   = +document.getElementById('time_end_'   + timeID).value;
        const delta = +document.getElementById('time_delta_' + timeID).value;

        for (const exp of resolved) {
          const expKey = `${exp.commit}:${exp.tasktype}:${exp.subtask}`;
          if (!state.commitRegistry.has(expKey)) {
            const color = COMMIT_PALETTE[state.commitRegistry.size % COMMIT_PALETTE.length];
            state.commitRegistry.set(expKey, { color, displayName: null });
          }
        }

        const fetchMetrics = [...new Set(selectedMetrics.map(m => {
          if (typeof m === 'string') {
            try {
              const parsed = JSON.parse(m);
              if (parsed?.variable) return state.variables.metrics.get(parsed.variable) ?? null;
            } catch (_) {}
          }
          return m;
        }).filter(m => m != null))];

        if (fetchMetrics.length === 0) {
          BuildSidebar(state);
          clearModalCancel();
          modalpage.classList.remove('modalpage_visible');
          EnableMainUI(true);
          return;
        }

        const results = await Promise.all(
          resolved.map(exp => apirest.LoadCommitMetricsValues(
            exp.tasktype, exp.commit, exp.subtask, min, max, delta, fetchMetrics))
        );
        const validPairs = resolved
          .map((exp, i) => ({ exp, data: results[i] }))
          .filter(p => p.data != null);

        if (validPairs.length > 0) {
          const graphConfig = {
            experiments: slots.filter(s => s.commitVar || s.commit || s.subtaskVar || s.tasktype),
            metricsMode,
            metrics: selectedMetrics,
            min, max, delta,
            showRaw:   prefill ? prefill.showRaw   : (validPairs.length === 1),
            showCI:    prefill ? prefill.showCI    : false,
            splitAxes: prefill ? prefill.splitAxes : true,
          };

          const dataMap = new Map(
            validPairs.map(p => [`${p.exp.commit}:${p.exp.tasktype}:${p.exp.subtask}`, p.data])
          );

          if (editId !== null) {
            state.graphSettings.set(editId, graphConfig);
            await graphManager.UpdateGraph(editId, graphConfig, dataMap);
          } else {
            const id = await graphManager.AddGraph(graphConfig, dataMap);
            state.graphSettings.set(id, graphConfig);
          }
        }

        BuildSidebar(state);
        clearModalCancel();
        modalpage.classList.remove('modalpage_visible');
        EnableMainUI(true);
      },
      className: 'add-graph-ok-btn',
    },
    cancel: {
      callback: function() {
        clearModalCancel();
        modalpage.classList.remove('modalpage_visible');
        EnableMainUI(true);
      }
    }
  });
  container.appendChild(actions);
  modalpage.appendChild(container);

  btOk = container.querySelector('.add-graph-ok-btn');
  UI.DisableElement(btOk);

  renderExperiments();
  rebuildMetricsUI();

  modalpage.classList.add('modalpage_visible');

  // ── Renders ────────────────────────────────────────────────────

  function renderExperiments() {
    experimentList.innerHTML = '';
    addBtn.disabled = slots.length >= MAX_EXPERIMENTS;

    slots.forEach(function(slot, idx) {
      const row = document.createElement('div');
      row.className = 'experiment-row';

      renderSlotRow(row, slot, idx);

      const removeBtn = document.createElement('button');
      removeBtn.className = 'experiment-remove-btn';
      removeBtn.textContent = '\u2715';
      removeBtn.title = 'Remove this experiment';
      removeBtn.disabled = slots.length <= 1;
      removeBtn.onclick = function() {
        slots.splice(idx, 1);
        renderExperiments();
        onExperimentChange();
      };
      row.appendChild(removeBtn);

      experimentList.appendChild(row);
    });
  }

  function buildCommitOptions(selectedHash, selectedVar) {
    const options = [{ value: '', text: '(—)' }];
    // Commit variables first
    if (state.variables.commits.size > 0) {
      for (const [name, entry] of state.variables.commits) {
        const val = `_var_${name}`;
        const label = entry?.value
          ? `${name} = ${CommitHelp.ShortHash(entry.value)}${entry.alias ? ` (${entry.alias})` : ''}`
          : `${name} (undefined)`;
        options.push({ value: val, text: label, selected: selectedVar === name });
      }
      options.push({ value: '__sep__', text: '─────────', disabled: true });
    }
    // Raw commits
    for (const c of allCommits) {
      options.push({ value: c, text: CommitHelp.ShortHash(c), selected: !selectedVar && selectedHash === c });
    }
    return options;
  }

  function buildSubtaskOptions(selectedTasktype, selectedSubtask, selectedVar, dynamicKnown = null) {
    const options = [{ value: '', text: '(—)' }];
    // Subtask variables first
    if (state.variables.subtasks.size > 0) {
      for (const [name, entry] of state.variables.subtasks) {
        const val = `_var_${name}`;
        const label = entry?.value
          ? `${name} = ${entry.value.tasktype}/${entry.value.subtask}${entry.alias ? ` (${entry.alias})` : ''}`
          : `${name} (undefined)`;
        options.push({ value: val, text: label, selected: selectedVar === name });
      }
      options.push({ value: '__sep__', text: '─────────', disabled: true });
    }

    const allKnown = [];
    const seen = new Set();
    
    // Always include the currently selected subtask so the UI doesn't lose it if it hasn't loaded yet
    if (selectedTasktype && selectedSubtask) {
      const token = `${selectedTasktype}:${selectedSubtask}`;
      seen.add(token);
      allKnown.push({ tasktype: selectedTasktype, subtask: selectedSubtask });
    }

    if (dynamicKnown !== null) {
      for (const dk of dynamicKnown) {
        const token = `${dk.tasktype}:${dk.subtask}`;
        if (!seen.has(token)) { seen.add(token); allKnown.push(dk); }
      }
    }

    for (const { tasktype, subtask } of allKnown) {
      const val = `${tasktype}:${subtask}`;
      options.push({
        value: val,
        text: `${tasktype}/${subtask}`,
        selected: !selectedVar && selectedTasktype === tasktype && selectedSubtask === subtask,
      });
    }
    if (allKnown.length === 0) {
      options.push({ value: '__hint__', text: 'No subtasks loaded yet', disabled: true });
    }
    return options;
  }

  function renderSlotRow(row, slot, slotIdx) {
    // Commit selector
    const commitSel = ui.CreateSelect(
      buildCommitOptions(slot.commit, slot.commitVar), null
    );
    commitSel.title = 'Commit';

    // Enrich commit labels with git history once resolved
    gitHistory.then(function(history) {
      if (!history) return;
      const enriched = CommitHelp.Enrich(allCommits, history);
      // Rebuild options using enriched labels
      const current = commitSel.value;
      const options = [{ value: '', text: '(—)' }];
      if (state.variables.commits.size > 0) {
        for (const [name, entry] of state.variables.commits) {
          const val = `_var_${name}`;
          const label = entry?.value
            ? `${name} = ${CommitHelp.ShortHash(entry.value)}${entry.alias ? ` (${entry.alias})` : ''}`
            : `${name} (undefined)`;
          options.push({ value: val, text: label });
        }
        options.push({ value: '__sep__', text: '─────────', disabled: true });
      }
      for (const e of enriched) {
        options.push({ value: e.hash, text: e.label, selected: e.hash === current });
      }
      ui.UpdateSelect(commitSel, options);
      // Restore selection (UpdateSelect resets it)
      commitSel.value = current;
    });

    commitSel.onchange = function() {
      const val = commitSel.value;
      if (!val || val === '__sep__') {
        slot.commitVar = null; slot.commit = null;
      } else if (val.startsWith('_var_')) {
        slot.commitVar = val.slice(5); slot.commit = null;
      } else {
        slot.commitVar = null; slot.commit = val;
      }
      onExperimentChange();
      loadDynamicSubtasks();
    };

    // Subtask selector
    const subtaskSel = ui.CreateSelect(
      buildSubtaskOptions(slot.tasktype, slot.subtask, slot.subtaskVar), null
    );
    subtaskSel.title = 'Subtask';

    async function loadDynamicSubtasks() {
      let resolvedCommit = slot.commit;
      if (slot.commitVar) {
        resolvedCommit = state.variables.commits.get(slot.commitVar)?.value;
      }
      if (!resolvedCommit) {
        const options = buildSubtaskOptions(slot.tasktype, slot.subtask, slot.subtaskVar, []);
        const current = subtaskSel.value;
        ui.UpdateSelect(subtaskSel, options);
        subtaskSel.value = current;
        return;
      }

      // Fetch subjects for standard task types
      const dynamicKnown = [];
      const [perfSubjs, vulnSubjs] = await Promise.all([
        apirest.LoadCommitSubjects('Perf', resolvedCommit),
        apirest.LoadCommitSubjects('Vuln', resolvedCommit)
      ]);
      perfSubjs.forEach(s => dynamicKnown.push({ tasktype: 'Perf', subtask: s.value }));
      vulnSubjs.forEach(s => dynamicKnown.push({ tasktype: 'Vuln', subtask: s.value }));

      // Add to global cache
      dynamicKnown.forEach(entry => {
        if (!globalDynamicSubtasks.some(g => g.tasktype === entry.tasktype && g.subtask === entry.subtask)) {
          globalDynamicSubtasks.push(entry);
        }
      });

      const options = buildSubtaskOptions(slot.tasktype, slot.subtask, slot.subtaskVar, dynamicKnown);
      const current = subtaskSel.value;
      ui.UpdateSelect(subtaskSel, options);
      subtaskSel.value = current;
    }

    loadDynamicSubtasks();

    subtaskSel.onchange = function() {
      const val = subtaskSel.value;
      if (!val || val === '__sep__' || val === '__hint__') {
        slot.subtaskVar = null; slot.tasktype = null; slot.subtask = null;
      } else if (val.startsWith('_var_')) {
        slot.subtaskVar = val.slice(5); slot.tasktype = null; slot.subtask = null;
      } else {
        const fc = val.indexOf(':');
        slot.subtaskVar = null;
        slot.tasktype = val.slice(0, fc);
        slot.subtask  = val.slice(fc + 1);
      }
      onExperimentChange();
    };

    row.appendChild(commitSel);
    row.appendChild(subtaskSel);

    // ⚠ badge: resolved combination has no data from the server
    if (invalidSlotIndices.has(slotIdx)) {
      const resolved = resolveSlot(slot);
      const warn = document.createElement('span');
      warn.className = 'experiment-slot-warn';
      warn.textContent = '\u26a0';
      warn.title = resolved
        ? `No data for ${CommitHelp.ShortHash(resolved.commit)}/${resolved.tasktype}/${resolved.subtask}`
        : 'No data';
      row.appendChild(warn);
    }
  }

  function onExperimentChange() {
    rebuildMetricsUI();
    updateOkButton();
  }

  async function rebuildMetricsUI() {
    const previousMetrics = [...selectedMetrics];
    selectedMetrics = [];
    // Don't remove metricsUIContainer yet — keep it in place to prevent modal jitter
    // while the async fetch is in flight.
    updateOkButton();

    // Preserve original slot indices so we can mark invalid combinations
    const slotResolutions = slots.map((slot, idx) => ({ idx, resolved: resolveSlot(slot) }));
    const resolvedWithIdx = slotResolutions.filter(r => r.resolved);
    if (resolvedWithIdx.length === 0) {
      if (metricsUIContainer) {
        metricsUIContainer.remove();
        metricsUIContainer = null;
      }
      return;
    }

    const gen = ++metricsRebuildGen;

    const metricsResults = await Promise.all(
      resolvedWithIdx.map(({ resolved }) => apirest.LoadCommitMetrics(resolved.tasktype, resolved.commit, resolved.subtask))
    );

    if (gen !== metricsRebuildGen) return;

    // Mark slots whose combination has no data; update badges if the set changed
    const newInvalid = new Set(
      resolvedWithIdx
        .filter((_, i) => !metricsResults[i]?.metrics || metricsResults[i].metrics.size === 0)
        .map(r => r.idx)
    );
    const invalidChanged = newInvalid.size !== invalidSlotIndices.size
      || [...newInvalid].some(i => !invalidSlotIndices.has(i));
    invalidSlotIndices = newInvalid;
    if (invalidChanged) {
      const rows = experimentList.querySelectorAll('.experiment-row');
      slots.forEach((slot, idx) => {
        const row = rows[idx];
        if (!row) return;
        const existingWarn = row.querySelector('.experiment-slot-warn');
        if (invalidSlotIndices.has(idx)) {
          if (!existingWarn) {
            const resolved = resolveSlot(slot);
            const warn = document.createElement('span');
            warn.className = 'experiment-slot-warn';
            warn.textContent = '\u26a0';
            warn.title = resolved
              ? `No data for ${CommitHelp.ShortHash(resolved.commit)}/${resolved.tasktype}/${resolved.subtask}`
              : 'No data';
            const removeBtn = row.querySelector('.experiment-remove-btn');
            if (removeBtn) {
              row.insertBefore(warn, removeBtn);
            } else {
              row.appendChild(warn);
            }
          }
        } else if (existingWarn) {
          existingWarn.remove();
        }
      });
    }

    const resolved = resolvedWithIdx.map(r => r.resolved);
    const pathSets = metricsResults.map(flattenMetricPaths);

    const union = new Set();
    for (const s of pathSets) s.forEach(p => union.add(p));
    const intersection = pathSets.reduce((acc, s) => {
      return new Set([...acc].filter(p => s.has(p)));
    }, new Set(union));

    const absentPaths = new Set([...union].filter(p => !intersection.has(p)));
    const displayPaths = metricsMode === 'AND' ? intersection : union;
    const syntheticMetrics = buildSyntheticMetrics(displayPaths);

    if (!syntheticMetrics.metrics || syntheticMetrics.metrics.size === 0) {
      if (metricsUIContainer) { metricsUIContainer.remove(); metricsUIContainer = null; }
      return;
    }

    // Remove stale metrics UI now that fresh content is ready (avoids layout jitter)
    if (metricsUIContainer) { metricsUIContainer.remove(); metricsUIContainer = null; }

    const metricsTree = ui.CreateMetrics(syntheticMetrics, {
      absent: metricsMode === 'OR' ? absentPaths : new Set(),
      callback: function(event) {
        if (event.target.checked) {
          selectedMetrics.push(event.target.value);
        } else {
          const idx = selectedMetrics.indexOf(event.target.value);
          if (idx >= 0) selectedMetrics.splice(idx, 1);
        }
        updateOkButton();
      }
    });

    if (state.variables.metrics.size > 0) {
      const varSection = document.createElement('div');
      const varHeader = document.createElement('div');
      varHeader.style.cssText = 'font-weight:600;color:#555;font-size:0.85rem;margin-bottom:6px;';
      varHeader.textContent = 'Variables';
      varSection.appendChild(varHeader);
      state.variables.metrics.forEach((metricPath, name) => {
        const label = document.createElement('label');
        label.className = 'checkbox-label';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'metric-checkbox';
        cb.value = JSON.stringify({ variable: name });
        const span = document.createElement('span');
        span.textContent = metricPath ? `${name} (= ${metricPath})` : `${name} (undefined)`;
        cb.onchange = function() {
          const ref = JSON.stringify({ variable: name });
          if (cb.checked) selectedMetrics.push(ref);
          else { const i = selectedMetrics.indexOf(ref); if (i >= 0) selectedMetrics.splice(i, 1); }
          updateOkButton();
        };
        label.appendChild(cb);
        label.appendChild(span);
        varSection.appendChild(label);
      });
      const wrapper = document.createElement('div');
      wrapper.appendChild(varSection);
      wrapper.appendChild(metricsTree);
      metricsWrapper.appendChild(wrapper);
      metricsUIContainer = wrapper;
    } else {
      metricsWrapper.appendChild(metricsTree);
      metricsUIContainer = metricsTree;
    }

    if (!prefill) {
      const firstMetrics = metricsResults[0];
      if (firstMetrics?.maxTimeMicroS > 0) {
        const maxT = firstMetrics.maxTimeMicroS;
        const d = Math.max(1, Math.floor(maxT / DEFAULT_DELTA_DIVISOR));
        const startEl = document.getElementById('time_start_' + timeID);
        const endEl   = document.getElementById('time_end_'   + timeID);
        const deltaEl = document.getElementById('time_delta_' + timeID);
        const stepsEl = document.getElementById('time_steps_' + timeID);
        if (startEl) startEl.value = 0;
        if (endEl)   endEl.value   = maxT;
        if (deltaEl) deltaEl.value = d;
        if (stepsEl && d > 0) stepsEl.value = Math.floor(maxT / d);
      }
    }

    const toRestore = (prefill && !metricsPrefilled) ? prefill.metrics : previousMetrics;
    if (toRestore.length > 0) {
      metricsWrapper.querySelectorAll('.metric-checkbox').forEach(function(cb) {
        if (toRestore.includes(cb.value) && !cb.checked) {
          cb.checked = true;
          cb.closest('.checkbox-label').style.display = '';
          selectedMetrics.push(cb.value);
        }
      });
      if (prefill && !metricsPrefilled) metricsPrefilled = true;
    }

    updateOkButton();
  }

  function updateOkButton() {
    if (!btOk) return;
    const hasResolved = resolvedSlots().length > 0;
    const hasMetrics  = selectedMetrics.length > 0;
    if (hasResolved && hasMetrics) UI.EnableElement(btOk);
    else UI.DisableElement(btOk);
  }
}

async function EditGraph(id) {
  const existingConfig = state.graphSettings.get(id);
  if (!existingConfig) return;
  EnableMainUI(false);
  await AddGraphique(existingConfig, id);
}

// ============================================================
// SIDEBAR
// ============================================================

// Returns true if any graph's configuration references the given variable name depending on the type.
function isVarReferenced(state, varName, type) {
  for (const [, config] of state.graphSettings) {
    if (type === 'commit' && config.experiments.some(s => s.commitVar === varName)) return true;
    if (type === 'subtask' && config.experiments.some(s => s.subtaskVar === varName)) return true;
    if (type === 'metric' && config.metrics.some(m => {
      if (typeof m === 'string') {
        try { return JSON.parse(m)?.variable === varName; } catch (_) {}
      }
      return false;
    })) return true;
  }
  return false;
}

function BuildSidebar(state) {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;
  sidebar.innerHTML = '';

  sidebar.appendChild(buildCommitVariableSection(state));
  sidebar.appendChild(buildSubtaskVariableSection(state));
  sidebar.appendChild(buildMetricVariableSection(state));
  sidebar.appendChild(buildExperimentLegend(state));
  sidebar.appendChild(buildMetricLegend(state));
}

// Re-renders traces for all graphs (appearance only, no re-fetch).
// Called when aliases or display names change.
function refreshAllGraphAppearances(state) {
  for (const id of state.graphSettings.keys()) {
    graphManager.RefreshGraphAppearance(id);
  }
}

// Returns all known { tasktype, subtask } pairs across commitRegistry and subtask variables.
function getKnownSubtasks(state) {
  const seen   = new Set();
  const result = [];
  for (const key of state.commitRegistry.keys()) {
    const parts = key.split(':');
    if (parts.length < 3) continue;
    const tasktype = parts[1];
    const subtask  = parts.slice(2).join(':');
    const token    = `${tasktype}:${subtask}`;
    if (!seen.has(token)) { seen.add(token); result.push({ tasktype, subtask }); }
  }
  for (const [, entry] of state.variables.subtasks) {
    if (!entry?.value) continue;
    const token = `${entry.value.tasktype}:${entry.value.subtask}`;
    if (!seen.has(token)) { seen.add(token); result.push(entry.value); }
  }
  for (const entry of globalDynamicSubtasks) {
    const token = `${entry.tasktype}:${entry.subtask}`;
    if (!seen.has(token)) { seen.add(token); result.push(entry); }
  }
  return result;
}

/** Builds and appends the card header (name + optional reset + delete) to a card element. */
function buildVarCardHeader(card, name, hasValue, onReset, onDelete) {
  const cardHeader = document.createElement('div');
  cardHeader.className = 'sidebar-variable-header';

  const nameSpan = document.createElement('span');
  nameSpan.className = 'sidebar-variable-name';
  nameSpan.textContent = name;
  cardHeader.appendChild(nameSpan);

  if (hasValue) {
    const resetBtn = document.createElement('button');
    resetBtn.className = 'sidebar-reset-btn';
    resetBtn.textContent = '\u21ba';
    resetBtn.title = 'Reset to undefined';
    resetBtn.addEventListener('click', onReset);
    cardHeader.appendChild(resetBtn);
  }

  const delBtn = document.createElement('button');
  delBtn.className = 'sidebar-delete-btn';
  delBtn.textContent = '\u2715';
  delBtn.title = 'Delete variable';
  delBtn.addEventListener('click', onDelete);
  cardHeader.appendChild(delBtn);

  card.appendChild(cardHeader);
}

/** Builds and appends an alias row (label + text input) to a card element. */
function buildAliasRow(card, currentAlias, onAliasChange) {
  const row = document.createElement('div');
  row.className = 'sidebar-alias-row';

  const label = document.createElement('span');
  label.className = 'sidebar-alias-label';
  label.textContent = 'Alias:';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'sidebar-alias-input';
  input.placeholder = 'e.g. DEV';
  input.value = currentAlias ?? '';
  input.addEventListener('change', () => onAliasChange(input.value.trim() || null));

  row.appendChild(label);
  row.appendChild(input);
  card.appendChild(row);
}

function buildCommitVariableSection(state) {
  const section = document.createElement('div');
  section.className = 'sidebar-section';

  const header = document.createElement('div');
  header.className = 'sidebar-section-title';
  header.textContent = 'Variables: Commits';

  const addBtn = document.createElement('button');
  addBtn.className = 'sidebar-add-btn';
  addBtn.textContent = '+';
  addBtn.title = 'Add commit variable';
  addBtn.addEventListener('click', () => {
    let n = 1;
    while (state.variables.commits.has(`c${n}`)) n++;
    state.variables.commits.set(`c${n}`, { value: null, alias: null });
    BuildSidebar(state);
  });
  header.appendChild(addBtn);
  section.appendChild(header);

  for (const [name, entry] of state.variables.commits) {
    const card = document.createElement('div');
    card.className = 'sidebar-variable-card';

    buildVarCardHeader(card, name, entry?.value !== null && entry?.value !== undefined,
      () => {
        state.variables.commits.set(name, { value: null, alias: entry?.alias ?? null });
        refreshGraphsUsingVariable(state, name);
        BuildSidebar(state);
      },
      () => {
        if (isVarReferenced(state, name, 'commit')) {
          errorManager.Error(`Variable "${name}" is used by one or more graphs — remove it from the graphs before deleting.`);
          return;
        }
        state.variables.commits.delete(name);
        BuildSidebar(state);
      }
    );

    // Commit select — initially shows current value; all commits loaded asynchronously
    const select = document.createElement('select');
    select.className = `sidebar-pill-select${!entry?.value ? ' undefined-value' : ''}`;

    const buildOptions = (allCommits) => {
      select.innerHTML = '';
      const none = document.createElement('option');
      none.value = '';
      none.textContent = '(undefined)';
      none.selected = !entry?.value;
      select.appendChild(none);
      for (const commit of allCommits) {
        const opt = document.createElement('option');
        opt.value   = commit;
        opt.textContent = CommitHelp.ShortHash(commit);
        opt.selected    = commit === entry?.value;
        select.appendChild(opt);
      }
    };
    // Show current value immediately (without full list)
    buildOptions(entry?.value ? [entry.value] : []);
    // Populate full list once fetched
    allCommitsPromise.then(buildOptions);

    select.addEventListener('change', () => {
      const newValue = select.value || null;
      state.variables.commits.set(name, { value: newValue, alias: entry?.alias ?? null });
      refreshGraphsUsingVariable(state, name);
      BuildSidebar(state);

      if (newValue) {
        Promise.all([
          apirest.LoadCommitSubjects('Perf', newValue),
          apirest.LoadCommitSubjects('Vuln', newValue)
        ]).then(([p, v]) => {
          let added = false;
          p.forEach(s => {
            if (!globalDynamicSubtasks.some(g => g.tasktype === 'Perf' && g.subtask === s.value)) {
              globalDynamicSubtasks.push({tasktype: 'Perf', subtask: s.value});
              added = true;
            }
          });
          v.forEach(s => {
            if (!globalDynamicSubtasks.some(g => g.tasktype === 'Vuln' && g.subtask === s.value)) {
              globalDynamicSubtasks.push({tasktype: 'Vuln', subtask: s.value});
              added = true;
            }
          });
          if (added) BuildSidebar(state);
        });
      }
    });
    card.appendChild(select);

    buildAliasRow(card, entry?.alias, (newAlias) => {
      const cur = state.variables.commits.get(name) ?? { value: null, alias: null };
      state.variables.commits.set(name, { value: cur.value, alias: newAlias });
      refreshAllGraphAppearances(state);
    });

    section.appendChild(card);
  }

  return section;
}

function buildSubtaskVariableSection(state) {
  const section = document.createElement('div');
  section.className = 'sidebar-section';

  const header = document.createElement('div');
  header.className = 'sidebar-section-title';
  header.textContent = 'Variables: Subtasks';

  const addBtn = document.createElement('button');
  addBtn.className = 'sidebar-add-btn';
  addBtn.textContent = '+';
  addBtn.title = 'Add subtask variable';
  addBtn.addEventListener('click', () => {
    let n = 1;
    while (state.variables.subtasks.has(`s${n}`)) n++;
    state.variables.subtasks.set(`s${n}`, { value: null, alias: null });
    BuildSidebar(state);
  });
  header.appendChild(addBtn);
  section.appendChild(header);

  for (const [name, entry] of state.variables.subtasks) {
    const card = document.createElement('div');
    card.className = 'sidebar-variable-card';

    buildVarCardHeader(card, name, entry?.value !== null && entry?.value !== undefined,
      () => {
        state.variables.subtasks.set(name, { value: null, alias: entry?.alias ?? null });
        refreshGraphsUsingVariable(state, name);
        BuildSidebar(state);
      },
      () => {
        if (isVarReferenced(state, name, 'subtask')) {
          errorManager.Error(`Variable "${name}" is used by one or more graphs — remove it from the graphs before deleting.`);
          return;
        }
        state.variables.subtasks.delete(name);
        BuildSidebar(state);
      }
    );

    const knownSubtasks = getKnownSubtasks(state);
    const currentToken  = entry?.value ? `${entry.value.tasktype}:${entry.value.subtask}` : null;

    const select = document.createElement('select');
    select.className = `sidebar-pill-select${!entry?.value ? ' undefined-value' : ''}`;

    const none = document.createElement('option');
    none.value = '';
    none.textContent = knownSubtasks.length === 0 ? '(no subtasks loaded yet)' : '(undefined)';
    none.selected = !entry?.value;
    select.appendChild(none);

    for (const { tasktype, subtask } of knownSubtasks) {
      const token = `${tasktype}:${subtask}`;
      const opt   = document.createElement('option');
      opt.value       = token;
      opt.textContent = `${tasktype}/${subtask}`;
      opt.selected    = token === currentToken;
      select.appendChild(opt);
    }

    select.addEventListener('change', () => {
      const token = select.value;
      let newValue = null;
      if (token) {
        const firstColon = token.indexOf(':');
        newValue = {
          tasktype: token.slice(0, firstColon),
          subtask:  token.slice(firstColon + 1),
        };
      }
      state.variables.subtasks.set(name, { value: newValue, alias: entry?.alias ?? null });
      refreshGraphsUsingVariable(state, name);
      BuildSidebar(state);
    });
    card.appendChild(select);

    buildAliasRow(card, entry?.alias, (newAlias) => {
      const cur = state.variables.subtasks.get(name) ?? { value: null, alias: null };
      state.variables.subtasks.set(name, { value: cur.value, alias: newAlias });
      refreshAllGraphAppearances(state);
    });

    section.appendChild(card);
  }

  return section;
}

function buildMetricVariableSection(state) {
  const section = document.createElement('div');
  section.className = 'sidebar-section';

  const header = document.createElement('div');
  header.className = 'sidebar-section-title';
  header.textContent = 'Variables: Metrics';

  const addBtn = document.createElement('button');
  addBtn.className = 'sidebar-add-btn';
  addBtn.textContent = '+';
  addBtn.title = 'Add metric variable';
  addBtn.addEventListener('click', () => {
    let n = 1;
    while (state.variables.metrics.has(`m${n}`)) n++;
    state.variables.metrics.set(`m${n}`, null);
    BuildSidebar(state);
  });
  header.appendChild(addBtn);
  section.appendChild(header);

  for (const [name, value] of state.variables.metrics) {
    const card = document.createElement('div');
    card.className = 'sidebar-variable-card';

    buildVarCardHeader(card, name, value !== null,
      () => {
        state.variables.metrics.set(name, null);
        refreshGraphsUsingVariable(state, name);
        BuildSidebar(state);
      },
      () => {
        if (isVarReferenced(state, name, 'metric')) {
          errorManager.Error(`Variable "${name}" is used by one or more graphs — remove it from the graphs before deleting.`);
          return;
        }
        state.variables.metrics.delete(name);
        BuildSidebar(state);
      }
    );

    const pill = document.createElement('button');
    pill.className = `sidebar-pill${value === null ? ' undefined' : ''}`;
    pill.textContent = value || '(undefined)';
    pill.title = 'Click to edit';
    pill.addEventListener('click', () => openMetricVarModal(name, value, state));
    card.appendChild(pill);

    section.appendChild(card);
  }

  return section;
}

// Returns the set of experiment keys ("commit:type:subject") currently used in graphs.
// Resolves variable slots; ignores unresolved variables.
function getActiveExperimentKeys(state) {
  const keys = new Set();
  for (const [, config] of state.graphSettings) {
    for (const slot of config.experiments) {
      const def = resolveExperimentSlot(slot, state.variables);
      if (def) keys.add(`${def.commit}:${def.tasktype}:${def.subtask}`);
    }
  }
  return keys;
}

function buildExperimentLegend(state) {
  const section = document.createElement('div');
  section.className = 'sidebar-section';

  const header = document.createElement('div');
  header.className = 'sidebar-section-title';
  header.textContent = 'Experiment Legend';
  section.appendChild(header);

  // Format template input
  const fmtRow = document.createElement('div');
  fmtRow.className = 'sidebar-format-template-row';
  const fmtLabel = document.createElement('span');
  fmtLabel.className = 'sidebar-format-template-label';
  fmtLabel.textContent = 'Format:';
  const fmtInput = document.createElement('input');
  fmtInput.type = 'text';
  fmtInput.className = 'sidebar-format-template-input';
  fmtInput.placeholder = '\${COMMIT_ALIAS} \u2212 \${SUBTASK_ALIAS}';
  fmtInput.value = state.legendFormat.experiment ?? '';
  fmtInput.title = 'Tokens: ${COMMIT}, ${TASKTYPE}, ${SUBTASK}, ${COMMIT_ALIAS}, ${SUBTASK_ALIAS}\nTransforms (chain with :): uppercase, lowercase, camelcase, pascalcase, kebabcase, snakecase, beforeFirst(regex), afterLast(regex)\nExample: ${SUBTASK_ALIAS:afterLast(_):pascalcase}';
  fmtInput.addEventListener('change', () => {
    state.legendFormat.experiment = fmtInput.value.trim() || null;
    refreshAllGraphAppearances(state);
  });
  fmtRow.appendChild(fmtLabel);
  fmtRow.appendChild(fmtInput);
  section.appendChild(fmtRow);

  const activeKeys = getActiveExperimentKeys(state);

  if (activeKeys.size === 0) {
    const empty = document.createElement('p');
    empty.style.cssText = 'font-size:0.75rem;color:#aaa;font-style:italic;margin:0';
    empty.textContent = 'No experiments loaded';
    section.appendChild(empty);
    return section;
  }

  for (const expKey of activeKeys) {
    let entry = state.commitRegistry.get(expKey);
    if (!entry) {
      const color = COMMIT_PALETTE[state.commitRegistry.size % COMMIT_PALETTE.length];
      entry = { color, displayName: null, visible: true };
      state.commitRegistry.set(expKey, entry);
    }
    // expKey format: "commitHash:type:subject"
    const parts = expKey.split(':');
    const commitShort = parts[0].substring(0, 7);
    const type    = parts[1] ?? '';
    const subject = parts.slice(2).join(':');  // subject may contain colons

    const row = document.createElement('div');
    row.className = 'commit-legend-row';

    const topLine = document.createElement('div');
    topLine.className = 'commit-legend-top';

    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.value = entry.color;
    colorInput.className = 'commit-legend-color';
    colorInput.title = 'Change color';
    colorInput.addEventListener('input', (e) => {
      entry.color = e.target.value;
      refreshGraphsUsingExperiment(state, expKey);
    });

    const identSpan = document.createElement('span');
    identSpan.className = 'commit-legend-ident';
    identSpan.title = expKey;
    identSpan.textContent = `${commitShort} · ${type} · ${subject}`;

    const eyeBtn = document.createElement('button');
    eyeBtn.className = 'legend-eye-btn';
    eyeBtn.textContent = entry.visible !== false ? '\u25cf' : '\u25cb';
    eyeBtn.title = entry.visible !== false ? 'Hide' : 'Show';
    eyeBtn.addEventListener('click', () => {
      entry.visible = entry.visible === false ? true : false;
      eyeBtn.textContent = entry.visible !== false ? '\u25cf' : '\u25cb';
      eyeBtn.title = entry.visible !== false ? 'Hide' : 'Show';
      refreshGraphsUsingExperiment(state, expKey);
    });

    topLine.appendChild(colorInput);
    topLine.appendChild(identSpan);
    topLine.appendChild(eyeBtn);

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'commit-legend-name';
    nameInput.placeholder = 'Display name\u2026';
    nameInput.value = entry.displayName || '';
    nameInput.addEventListener('change', (e) => {
      entry.displayName = e.target.value.trim() || null;
      refreshGraphsUsingExperiment(state, expKey);
    });

    row.appendChild(topLine);
    row.appendChild(nameInput);
    section.appendChild(row);
  }

  return section;
}

// Returns the effective dash style for a metric path as actually rendered on the first graph
// that uses it (i.e. the palette default for its deduped index). Used to seed the legend select.
const _DASH_PALETTE = ['solid', 'dot', 'dash', 'dashdot'];
function getMetricDefaultDash(state, metricPath) {
  for (const [, config] of state.graphSettings) {
    const seen = new Set();
    let idx = 0;
    for (const m of config.metrics) {
      let path = m;
      if (typeof m === 'string') {
        try { const p = JSON.parse(m); if (p?.variable) path = state.variables.metrics.get(p.variable) ?? null; } catch (_) {}
      }
      if (!path || seen.has(path)) continue;
      seen.add(path);
      if (path === metricPath) return _DASH_PALETTE[idx % _DASH_PALETTE.length];
      idx++;
    }
  }
  return 'solid';
}

// Returns the set of resolved metric paths currently active across all graphs.
function getActiveMetrics(state) {
  const paths = new Set();
  for (const [, config] of state.graphSettings) {
    for (const m of config.metrics) {
      if (typeof m === 'string') {
        let path = m;
        try {
          const p = JSON.parse(m);
          if (p?.variable) path = state.variables.metrics.get(p.variable) ?? null;
        } catch (_) {}
        if (path) paths.add(path);
      }
    }
  }
  return paths;
}

// Returns graph IDs whose resolved metrics include the given metricPath.
function getGraphIDsUsingMetric(state, metricPath) {
  const ids = [];
  for (const [id, config] of state.graphSettings) {
    const uses = config.metrics.some(m => {
      if (typeof m === 'string') {
        let path = m;
        try {
          const p = JSON.parse(m);
          if (p?.variable) path = state.variables.metrics.get(p.variable) ?? null;
        } catch (_) {}
        return path === metricPath;
      }
      return false;
    });
    if (uses) ids.push(id);
  }
  return ids;
}

// Re-renders traces for all graphs using the given metric (no re-fetch).
function refreshGraphsUsingMetric(state, metricPath) {
  for (const id of getGraphIDsUsingMetric(state, metricPath)) {
    graphManager.RefreshGraphAppearance(id);
  }
}

function buildMetricLegend(state) {
  const section = document.createElement('div');
  section.className = 'sidebar-section';

  const header = document.createElement('div');
  header.className = 'sidebar-section-title';
  header.textContent = 'Metric Legend';
  section.appendChild(header);

  // Format template input
  const fmtRow = document.createElement('div');
  fmtRow.className = 'sidebar-format-template-row';
  const fmtLabel = document.createElement('span');
  fmtLabel.className = 'sidebar-format-template-label';
  fmtLabel.textContent = 'Format:';
  const fmtInput = document.createElement('input');
  fmtInput.type = 'text';
  fmtInput.className = 'sidebar-format-template-input';
  fmtInput.placeholder = '\${METRIC}';
  fmtInput.value = state.legendFormat.metric ?? '';
  fmtInput.title = 'Token: ${METRIC}\nTransforms (chain with :): uppercase, lowercase, camelcase, pascalcase, kebabcase, snakecase, beforeFirst(regex), afterLast(regex)\nExample: ${METRIC:afterLast(\\.):uppercase}  →  last segment, uppercased';
  fmtInput.addEventListener('change', () => {
    state.legendFormat.metric = fmtInput.value.trim() || null;
    refreshAllGraphAppearances(state);
  });
  fmtRow.appendChild(fmtLabel);
  fmtRow.appendChild(fmtInput);
  section.appendChild(fmtRow);

  const activePaths = getActiveMetrics(state);

  if (activePaths.size === 0) {
    const empty = document.createElement('p');
    empty.style.cssText = 'font-size:0.75rem;color:#aaa;font-style:italic;margin:0';
    empty.textContent = 'No metrics loaded';
    section.appendChild(empty);
    return section;
  }

  for (const metricPath of activePaths) {
    if (!state.metricLegend.has(metricPath)) {
      state.metricLegend.set(metricPath, { displayName: null, dash: null });
    }
    const entry = state.metricLegend.get(metricPath);

    const row = document.createElement('div');
    row.className = 'commit-legend-row';

    const topLine = document.createElement('div');
    topLine.className = 'commit-legend-top';

    const dashSelect = document.createElement('select');
    dashSelect.className = 'metric-legend-dash-select';
    dashSelect.title = 'Line style';
    const effectiveDash = entry.dash ?? getMetricDefaultDash(state, metricPath);
    for (const style of ['solid', 'dot', 'dash', 'dashdot']) {
      const opt = document.createElement('option');
      opt.value = style;
      opt.textContent = style;
      if (effectiveDash === style) opt.selected = true;
      dashSelect.appendChild(opt);
    }
    dashSelect.addEventListener('change', (e) => {
      entry.dash = e.target.value;  // store explicitly (including 'solid' as override)
      refreshGraphsUsingMetric(state, metricPath);
    });
    topLine.appendChild(dashSelect);

    const identSpan = document.createElement('span');
    identSpan.className = 'commit-legend-ident';
    identSpan.title = metricPath;
    identSpan.textContent = metricPath;
    topLine.appendChild(identSpan);

    const eyeBtn = document.createElement('button');
    eyeBtn.className = 'legend-eye-btn';
    eyeBtn.textContent = entry.visible !== false ? '\u25cf' : '\u25cb';
    eyeBtn.title = entry.visible !== false ? 'Hide' : 'Show';
    eyeBtn.addEventListener('click', () => {
      entry.visible = entry.visible === false ? true : false;
      eyeBtn.textContent = entry.visible !== false ? '\u25cf' : '\u25cb';
      eyeBtn.title = entry.visible !== false ? 'Hide' : 'Show';
      refreshGraphsUsingMetric(state, metricPath);
    });
    topLine.appendChild(eyeBtn);

    row.appendChild(topLine);

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'commit-legend-name';
    nameInput.placeholder = 'Display name\u2026';
    nameInput.value = entry.displayName || '';
    nameInput.addEventListener('change', (e) => {
      entry.displayName = e.target.value.trim() || null;
      refreshGraphsUsingMetric(state, metricPath);
    });
    row.appendChild(nameInput);
    section.appendChild(row);
  }

  return section;
}

// Returns graph IDs whose resolved experiments match the given expKey ("commit:type:subject").
function getGraphIDsUsingExperiment(state, expKey) {
  const ids = [];
  for (const [id, config] of state.graphSettings) {
    for (const slot of config.experiments) {
      const def = resolveExperimentSlot(slot, state.variables);
      if (def && `${def.commit}:${def.tasktype}:${def.subtask}` === expKey) { ids.push(id); break; }
    }
  }
  return ids;
}

// Re-colours/renames traces for all graphs using the given experiment (no re-fetch).
function refreshGraphsUsingExperiment(state, expKey) {
  for (const id of getGraphIDsUsingExperiment(state, expKey)) {
    graphManager.RefreshGraphAppearance(id);
  }
}

// Re-fetches and redraws all graphs that reference the given variable name.
function refreshGraphsUsingVariable(state, varName) {
  for (const [id, config] of state.graphSettings) {
    const usesVar = config.experiments.some(s => s.commitVar === varName || s.subtaskVar === varName)
      || config.metrics.some(m => {
        if (typeof m === 'string') {
          try { const p = JSON.parse(m); return p?.variable === varName; } catch (_) {}
        }
        return false;
      });
    if (usesVar) {
      refetchAndRedrawGraph(state, id, config).catch(err => console.error('[sidebar] refetch error:', err));
    }
  }
}

// Resolves variables and re-fetches data for a graph, then redraws it in place.
async function refetchAndRedrawGraph(state, id, config) {
  const resolved = config.experiments
    .map(slot => resolveExperimentSlot(slot, state.variables))
    .filter(Boolean);
  if (resolved.length === 0) return;

  // Deduplicate: two variables may resolve to the same path
  const resolvedMetrics = [...new Set(config.metrics
    .map(m => {
      if (typeof m === 'string') {
        try {
          const parsed = JSON.parse(m);
          if (parsed?.variable) return state.variables.metrics.get(parsed.variable) ?? null;
        } catch (_) {}
      }
      return m;
    })
    .filter(m => m != null))];
  if (resolvedMetrics.length === 0) return;

  const results = await Promise.all(
    resolved.map(exp => apirest.LoadCommitMetricsValues(
      exp.tasktype, exp.commit, exp.subtask,
      config.min, config.max, config.delta,
      resolvedMetrics
    ))
  );

  const dataMap = new Map(
    resolved
      .map((exp, i) => ({ exp, data: results[i] }))
      .filter(p => p.data != null)
      .map(p => [`${p.exp.commit}:${p.exp.tasktype}:${p.exp.subtask}`, p.data])
  );

  if (dataMap.size === 0) return;
  await graphManager.UpdateGraph(id, config, dataMap);
}


// Opens a mini-modal to define or edit a metric variable (single selection).
async function openMetricVarModal(name, currentVal, state) {
  EnableMainUI(false);

  // Collect all unique resolved experiments across all graphs and variables
  const uniqueExps = new Map();
  for (const [, config] of state.graphSettings) {
    for (const slot of config.experiments) {
      const def = resolveExperimentSlot(slot, state.variables);
      if (def) uniqueExps.set(`${def.commit}:${def.tasktype}:${def.subtask}`, def);
    }
  }
  // Also include all commit×subtask variable combinations
  for (const [, commitEntry] of state.variables.commits) {
    if (!commitEntry?.value) continue;
    for (const [, subtaskEntry] of state.variables.subtasks) {
      if (!subtaskEntry?.value) continue;
      const { tasktype, subtask } = subtaskEntry.value;
      const def = { commit: commitEntry.value, tasktype, subtask };
      uniqueExps.set(`${def.commit}:${def.tasktype}:${def.subtask}`, def);
    }
  }

  const experiments = Array.from(uniqueExps.values());
  const metricsResults = experiments.length > 0
    ? await Promise.all(experiments.map(exp => apirest.LoadCommitMetrics(exp.tasktype, exp.commit, exp.subtask)))
    : [];

  const union = new Set();
  for (const mr of metricsResults) flattenMetricPaths(mr).forEach(p => union.add(p));

  const modalpage = document.getElementById('modalpage');
  modalpage.innerHTML = '';
  const container = document.createElement('div');
  ui.Reset();

  container.appendChild(ui.CreateTitle(`Metric Variable: ${name}`, 'h3', null));

  let selectedMetric = currentVal;
  let btOk = null;

  function updateOk() {
    if (!btOk) return;
    if (selectedMetric) UI.EnableElement(btOk);
    else UI.DisableElement(btOk);
  }

  if (union.size === 0) {
    const msg = document.createElement('p');
    msg.style.cssText = 'color:#aaa;font-style:italic;font-size:0.9rem;margin:8px 0;';
    msg.textContent = 'No metrics available. First add graphs with resolved experiments.';
    container.appendChild(msg);
  } else {
    const syntheticMetrics = buildSyntheticMetrics(union);
    const metricsTree = ui.CreateMetrics(syntheticMetrics, {
      callback: function(event) {
        if (event.target.checked) {
          // Single selection: uncheck all others
          container.querySelectorAll('.metric-checkbox').forEach(cb => {
            if (cb !== event.target) cb.checked = false;
          });
          selectedMetric = event.target.value;
        } else {
          selectedMetric = null;
        }
        updateOk();
      }
    });
    container.appendChild(metricsTree);

    // Pre-select currentVal if set
    if (currentVal) {
      container.querySelectorAll('.metric-checkbox').forEach(cb => {
        if (cb.value === currentVal) {
          cb.checked = true;
          const label = cb.closest('.checkbox-label');
          if (label) label.style.display = '';
        }
      });
    }
  }

  setModalCancel(function() {
    clearModalCancel();
    modalpage.classList.remove('modalpage_visible');
    EnableMainUI(true);
  });

  const actions = ui.CreateActions(true, {
    ok: {
      callback: function() {
        if (!selectedMetric) return;
        state.variables.metrics.set(name, selectedMetric);
        refreshGraphsUsingVariable(state, name);
        BuildSidebar(state);
        clearModalCancel();
        modalpage.classList.remove('modalpage_visible');
        EnableMainUI(true);
      },
      className: 'metric-var-ok-btn',
    },
    cancel: {
      callback: function() {
        clearModalCancel();
        modalpage.classList.remove('modalpage_visible');
        EnableMainUI(true);
      }
    }
  });
  container.appendChild(actions);

  modalpage.appendChild(container);
  btOk = container.querySelector('.metric-var-ok-btn');
  updateOk();
  modalpage.classList.add('modalpage_visible');
}

/**
 * Builds and opens a filterable/sortable file-list modal.
 * @param {boolean} restoreUI - whether to re-enable the main UI on dismiss
 * @param {{
 *   title: string,
 *   filterPlaceholder: string,
 *   emptyText: {empty: string, filtered: string, failed: string},
 *   fetchFiles: () => Promise<{files: string[]}|null>,
 *   onLoad: (name: string, closeModal: () => void) => void,
 *   onDelete: (name: string, rerender: () => void) => void,
 *   extraRowBtns?: (name: string) => HTMLElement[],
 * }} opts
 */
function buildFileListModal(restoreUI, opts) {
  const modalpage = document.getElementById('modalpage');
  modalpage.innerHTML = '';

  const container = document.createElement('div');
  ui.Reset();
  container.appendChild(ui.CreateTitle(opts.title, 'h3'));

  const viewControls = document.createElement('div');
  viewControls.className = 'view-controls';

  const filterInput = document.createElement('input');
  filterInput.type = 'text';
  filterInput.className = 'modal_text_input view-filter-input';
  filterInput.placeholder = opts.filterPlaceholder;
  viewControls.appendChild(filterInput);

  const sortBtn = document.createElement('button');
  sortBtn.className = 'view-sort-btn';
  sortBtn.textContent = 'A \u2192 Z';
  sortBtn.title = 'Toggle sort order';
  let sortAsc = true;
  viewControls.appendChild(sortBtn);
  container.appendChild(viewControls);

  const listContainer = document.createElement('div');
  listContainer.className = 'view-list-container';
  const loadingSpan = document.createElement('span');
  loadingSpan.className = 'modal_wait';
  loadingSpan.textContent = '\u{1F550}';
  listContainer.appendChild(loadingSpan);
  container.appendChild(listContainer);

  let allFiles = [];

  function closeModal() {
    clearModalCancel();
    modalpage.classList.remove('modalpage_visible');
    EnableMainUI(true);
  }

  function dismissModal() {
    clearModalCancel();
    modalpage.classList.remove('modalpage_visible');
    EnableMainUI(restoreUI);
  }

  function renderList() {
    listContainer.innerHTML = '';
    const filterText = filterInput.value.toLowerCase();
    let files = allFiles.filter(f => f.toLowerCase().includes(filterText));
    files = [...files].sort((a, b) => sortAsc ? a.localeCompare(b) : b.localeCompare(a));

    if (files.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'view-list-empty';
      empty.textContent = filterText ? opts.emptyText.filtered : opts.emptyText.empty;
      listContainer.appendChild(empty);
      return;
    }

    files.forEach(function(name) {
      const row = document.createElement('div');
      row.className = 'view-list-row';

      const nameBtn = document.createElement('button');
      nameBtn.className = 'view-list-name-btn';
      nameBtn.textContent = name;
      nameBtn.onclick = function() {
        listContainer.querySelectorAll('.view-list-row').forEach(function(r) {
          r.classList.remove('selected');
        });
        row.classList.add('selected');
      };
      nameBtn.ondblclick = function() { opts.onLoad(name, closeModal); };

      const delBtn = document.createElement('button');
      delBtn.className = 'view-list-delete-btn';
      delBtn.textContent = '\u{1F5D1}';
      delBtn.title = 'Delete';
      delBtn.onclick = function(e) {
        e.stopPropagation();
        opts.onDelete(name, function() {
          allFiles = allFiles.filter(f => f !== name);
          renderList();
        });
      };

      row.appendChild(nameBtn);
      if (opts.extraRowBtns) opts.extraRowBtns(name).forEach(btn => row.appendChild(btn));
      row.appendChild(delBtn);
      listContainer.appendChild(row);
    });
  }

  filterInput.oninput = renderList;
  sortBtn.onclick = function() {
    sortAsc = !sortAsc;
    sortBtn.textContent = sortAsc ? 'A \u2192 Z' : 'Z \u2192 A';
    renderList();
  };

  setModalCancel(dismissModal);

  container.appendChild(ui.CreateActions(false, {
    ok: { text: 'Close', callback: dismissModal }
  }));

  opts.fetchFiles().then(function(answer) {
    if (answer?.files) {
      allFiles = answer.files;
      renderList();
    } else {
      listContainer.innerHTML = '';
      const p = document.createElement('p');
      p.className = 'view-list-empty';
      p.textContent = opts.emptyText.failed;
      listContainer.appendChild(p);
    }
  });

  modalpage.appendChild(container);
  modalpage.classList.add('modalpage_visible');
}

function OpenView(restoreUI = false) {
  buildFileListModal(restoreUI, {
    title: 'Open a View',
    filterPlaceholder: 'Filter views\u2026',
    emptyText: {
      empty:    'No saved views yet.',
      filtered: 'No views match your filter.',
      failed:   'Failed to load views.',
    },
    fetchFiles: () => apirest.ListPages(),
    onLoad: function(name, closeModal) {
      apirest.LoadPage(name).then(function(newstate) {
        if (newstate == null) return;
        ResetState(state, newstate).then(function() {
          closeModal();
          errorManager.Success('View loaded: ' + name);
        });
      });
    },
    onDelete: function(name, rerender) {
      if (!confirm(`Delete view \u201c${name}\u201d? This cannot be undone.`)) return;
      apirest.DeletePage(name).then(function(ok) {
        if (ok) {
          rerender();
          errorManager.Success('View deleted: ' + name);
        }
      });
    },
  });
}

// ============================================================
// TEMPLATES
// ============================================================

function buildTemplateURL(templateName, state) {
  const params = new URLSearchParams({ template: templateName });
  for (const [name, entry] of state.variables.commits) {
    if (entry?.value) params.set(name, entry.value);
    if (entry?.alias) params.set(`${name}.alias`, entry.alias);
  }
  for (const [name, entry] of state.variables.subtasks) {
    if (entry?.value) params.set(name, `${entry.value.tasktype}:${entry.value.subtask}`);
    if (entry?.alias) params.set(`${name}.alias`, entry.alias);
  }
  for (const [name, val] of state.variables.metrics) {
    if (val) params.set(name, val);
  }
  return `${window.location.origin}${window.location.pathname}?${params.toString()}`;
}

function OpenTemplate(restoreUI = false) {
  buildFileListModal(restoreUI, {
    title: 'Open a Template',
    filterPlaceholder: 'Filter templates\u2026',
    emptyText: {
      empty:    'No saved templates yet.',
      filtered: 'No templates match your filter.',
      failed:   'Failed to load templates.',
    },
    fetchFiles: () => apirest.ListTemplates(),
    onLoad: function(name, closeModal) {
      apirest.LoadTemplate(name).then(function(tpl) {
        if (tpl == null) return;
        ResetState(state, tpl).then(function() {
          closeModal();
          errorManager.Success('Template loaded: ' + name);
        });
      });
    },
    onDelete: function(name, rerender) {
      if (!confirm(`Delete template \u201c${name}\u201d? This cannot be undone.`)) return;
      apirest.DeleteTemplate(name).then(function(ok) {
        if (ok) {
          rerender();
          errorManager.Success('Template deleted: ' + name);
        }
      });
    },
    extraRowBtns: function(name) {
      const copyBtn = document.createElement('button');
      copyBtn.className = 'view-list-action-btn';
      copyBtn.textContent = '\uD83D\uDD17';
      copyBtn.title = 'Copy shareable URL (uses current variable values)';
      copyBtn.onclick = function(e) {
        e.stopPropagation();
        const url = buildTemplateURL(name, state);
        navigator.clipboard.writeText(url).then(function() {
          copyBtn.textContent = '\u2713';
          setTimeout(function() { copyBtn.textContent = '\uD83D\uDD17'; }, 2000);
        });
      };
      return [copyBtn];
    },
  });
}

async function SaveAsTemplate(state) {
  const name = prompt('Template name:');
  if (!name?.trim()) return;
  const trimmedName = name.trim();

  const tpl = {
    title: state.title,
    variables: {
      commits:  new Map([...state.variables.commits.entries()].map(([k, v]) => [k, { value: v?.value ?? null, alias: v?.alias ?? null }])),
      subtasks: new Map([...state.variables.subtasks.entries()].map(([k, v]) => [k, { value: v?.value ?? null, alias: v?.alias ?? null }])),
      metrics:  new Map([...state.variables.metrics.entries()]),
    },
    legendFormat:   state.legendFormat,
    graphSettings:  state.graphSettings,
    commitRegistry: state.commitRegistry,
    metricLegend:   state.metricLegend,
  };

  const ok = await apirest.SaveTemplate(trimmedName, tpl);
  if (ok) errorManager.Success('Template saved: ' + trimmedName);
}

async function tryLoadTemplateFromURL() {
  const params = new URLSearchParams(window.location.search);
  const templateName = params.get('template');
  if (!templateName) return false;

  // Clean URL immediately so a failed load doesn't loop on every reload.
  history.replaceState(null, '', window.location.pathname);

  const raw = await apirest.LoadTemplate(templateName);
  if (!raw) return false;

  // Migrate to new format before applying URL params
  const tpl = migrateStateIfNeeded(raw);

  // Populate commit variables from URL params (format: <varName>=<commitHash>, <varName>.alias=<alias>)
  // An empty value (e.g. c1=) explicitly clears the default to null.
  if (tpl.variables?.commits instanceof Map) {
    for (const [name, entry] of tpl.variables.commits) {
      const hasVal   = params.has(name);
      const hasAlias = params.has(`${name}.alias`);
      const alias = hasAlias ? (params.get(`${name}.alias`) || null) : (entry?.alias ?? null);
      if (hasVal) {
        tpl.variables.commits.set(name, { value: params.get(name) || null, alias });
      } else if (hasAlias) {
        tpl.variables.commits.set(name, { value: entry?.value ?? null, alias });
      }
    }
  }
  // Populate subtask variables from URL params (format: <varName>=<tasktype>:<subtask>, <varName>.alias=<alias>)
  // An empty value explicitly clears the default to null.
  if (tpl.variables?.subtasks instanceof Map) {
    for (const [name, entry] of tpl.variables.subtasks) {
      const hasVal   = params.has(name);
      const hasAlias = params.has(`${name}.alias`);
      const alias = hasAlias ? (params.get(`${name}.alias`) || null) : (entry?.alias ?? null);
      if (hasVal) {
        const val = params.get(name);
        if (val) {
          const firstColon = val.indexOf(':');
          if (firstColon !== -1) {
            tpl.variables.subtasks.set(name, {
              value: { tasktype: val.slice(0, firstColon), subtask: val.slice(firstColon + 1) },
              alias,
            });
          }
        } else {
          tpl.variables.subtasks.set(name, { value: null, alias });
        }
      } else if (hasAlias) {
        tpl.variables.subtasks.set(name, { value: entry?.value ?? null, alias });
      }
    }
  }
  if (tpl.variables?.metrics instanceof Map) {
    for (const [name] of tpl.variables.metrics) {
      if (params.has(name)) tpl.variables.metrics.set(name, params.get(name) || null);
    }
  }

  await ResetState(state, tpl);
  EnableMainUI(true);
  return true;
}

function OpenInfoModal() {
  const modalpage = document.getElementById('modalpage');
  modalpage.innerHTML = '';

  const container = document.createElement('div');
  ui.Reset();

  container.appendChild(ui.CreateTitle('How to use this tool', 'h3'));

  const body = document.createElement('div');
  body.className = 'info-modal-body';
  body.innerHTML = `
    <p>Help content to be written later.</p>
  `;
  container.appendChild(body);

  const closeFn = function() {
    clearModalCancel();
    modalpage.classList.remove('modalpage_visible');
  };
  setModalCancel(closeFn);

  container.appendChild(ui.CreateActions(false, {
    ok: { text: 'Close', callback: closeFn }
  }));

  modalpage.appendChild(container);
  modalpage.classList.add('modalpage_visible');
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
// HEADER & DOM SETUP
// ============================================================

function EnableMainUI(enabled) {
  UIElt.forEach(function(element) {
    if (enabled) {
      UI.EnableElement(element);
    } else {
      UI.DisableElement(element);
    }
  });
}

const header = document.getElementById('header');
const main = document.getElementById('main');

// Header: read-only title + edit button
const headerTitle = document.createElement('span');
headerTitle.className = 'header-title-text';

const headerEditBtn = document.createElement('button');
headerEditBtn.className = 'header-edit-btn';
headerEditBtn.textContent = '\u270F Edit';
headerEditBtn.title = 'Rename this view';
headerEditBtn.style.display = 'none';
let headerEditInput = null;

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
headerLeft.className = 'header-left';
headerLeft.appendChild(headerTitle);
headerLeft.appendChild(headerEditBtn);
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
// INITIALISATION
// ============================================================

const errorManager = new ErrorManager();
const apirest = new ApiREST(config.apiBase, errorManager);
// Loaded once at startup; reused as a resolved Promise by all dropdowns.
const gitHistoryPromise = apirest.LoadGitHistory();
// Pre-fetch all available commits once for use in sidebar pill-selectors.
allCommitsPromise = Promise.all([
  apirest.LoadCommits('Perf'),
  apirest.LoadCommits('Vuln'),
]).then(async ([perf, vuln]) => {
  const all = [...new Set([...perf, ...vuln])];

  const recentPerf = perf.slice(0, 10);
  const recentVuln = vuln.slice(0, 10);
  
  const fetches = [];
  recentPerf.forEach(c => fetches.push(
    apirest.LoadCommitSubjects('Perf', c).then(res => res.map(s => ({tasktype: 'Perf', subtask: s.value})))
  ));
  recentVuln.forEach(c => fetches.push(
    apirest.LoadCommitSubjects('Vuln', c).then(res => res.map(s => ({tasktype: 'Vuln', subtask: s.value})))
  ));
  
  const results = await Promise.all(fetches);
  results.flat().forEach(entry => {
    if (!globalDynamicSubtasks.some(g => g.tasktype === entry.tasktype && g.subtask === entry.subtask)) {
      globalDynamicSubtasks.push(entry);
    }
  });

  BuildSidebar(state);

  return all;
});
const ui = new UI();
const graphManager = new GraphManager(main, {
  delete:    function(id) { state.graphSettings.delete(id); BuildSidebar(state); },
  getState:  function()   { return state; },
  editGraph: function(id) { EditGraph(id); },
});

// ============================================================
// HEADER TOOLBAR BUTTONS
// ============================================================

const UIElt = [];

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
  SaveAsTemplate(state).finally(() => EnableMainUI(true));
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
  if (e.key === 'Escape' && currentModalCancelFn) {
    const fn = currentModalCancelFn;
    currentModalCancelFn = null;
    fn();
  }
});

modalpage.addEventListener('click', function(e) {
  if (e.target === modalpage && currentModalCancelFn) {
    const fn = currentModalCancelFn;
    currentModalCancelFn = null;
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
