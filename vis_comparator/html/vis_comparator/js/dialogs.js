/**
 * Modal dialog builders for Add Graph, Edit Graph, Open/Save View, Templates, and Help.
 *
 * Call initDialogs(deps) once at startup before any dialog function is used.
 */

import { ICONS, TASK_TYPES } from './constants.js';
import { HELP_HTML } from './help.js';
import { resolveExperimentSlot, resolveMetricEntry, nextCommitColor, setModalCancel, clearModalCancel, dedupSubtasks, globalDynamicSubtasks, globalCampaigns, experimentKey } from './state.js';
import { UI } from './ui.js';
import { CommitHelp } from './commithelp.js';
import { BuildSidebar, flattenMetricPaths, buildSyntheticMetrics } from './sidebar.js';

// ============================================================
// DEPENDENCY INJECTION
// ============================================================

let _state          = null;
let _graphManager   = null;
let _apirest        = null;
let _ui             = null;
let _enableMainUI   = null;
let _errorManager   = null;
let _resetState     = null;
let _updateHeader   = null;
let _gitHistoryPromise   = Promise.resolve(null);
let _allCommitsPromise   = Promise.resolve([]);

/**
 * @param {{
 *   state: object,
 *   graphManager: object,
 *   apirest: object,
 *   ui: object,
 *   enableMainUI: (enabled: boolean) => void,
 *   errorManager: object,
 *   resetState: (state: object, newState: object) => Promise<void>,
 *   updateHeader: () => void,
 *   gitHistoryPromise: Promise,
 *   allCommitsPromise: Promise<string[]>,
 * }} deps
 */
export function initDialogs(deps) {
  _state             = deps.state;
  _graphManager      = deps.graphManager;
  _apirest           = deps.apirest;
  _ui                = deps.ui;
  _enableMainUI      = deps.enableMainUI;
  _errorManager      = deps.errorManager;
  _resetState        = deps.resetState;
  _updateHeader      = deps.updateHeader;
  _gitHistoryPromise = deps.gitHistoryPromise;
  _allCommitsPromise = deps.allCommitsPromise;
}

// ============================================================
// CONSTANTS (dialog-local)
// ============================================================

const DEFAULT_DELTA_DIVISOR = 20_000;
const MAX_EXPERIMENTS = 4;

// ============================================================
// NEW VIEW DIALOG
// ============================================================

export function ConfigBaseInformations(restoreUI = false) {
  const modalpage = document.getElementById('modalpage');
  modalpage.innerHTML = '';

  const container = document.createElement('div');
  _ui.Reset();

  container.appendChild(_ui.CreateTitle('View name', 'h3', null));
  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.className = 'modal-text-input';
  titleInput.placeholder = 'Auto-generated if left empty…';
  container.appendChild(titleInput);

  setModalCancel(function() {
    clearModalCancel();
    modalpage.classList.remove('modalpage-visible');
    _enableMainUI(restoreUI);
  });

  const actions = _ui.CreateActions(true, {
    ok: {
      callback: async function() {
        let title = titleInput.value.trim() || ('Vue_' + Date.now());

        // Check for duplicate names and auto-increment if needed
        const pages = await _apirest.ListPages();
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
        modalpage.classList.remove('modalpage-visible');
        await _resetState(_state, { title });
        _enableMainUI(true);
      },
    },
    cancel: {
      callback: function() {
        clearModalCancel();
        modalpage.classList.remove('modalpage-visible');
        _enableMainUI(restoreUI);
      }
    }
  });
  container.appendChild(actions);

  modalpage.appendChild(container);
  modalpage.classList.add('modalpage-visible');
}

// ============================================================
// ADD / EDIT GRAPH DIALOG — module-level helpers
// ============================================================

/**
 * Builds the options array for a subtask <select> element.
 */
function buildSubtaskOptions(selectedTasktype, selectedSubtask, selectedVar, dynamicKnown = null) {
  const options = [{ value: '', text: '(—)' }];
  if (_state.variables.subtasks.size > 0) {
    for (const [name, entry] of _state.variables.subtasks) {
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

/**
 * Fetches available subtasks for the given slot's resolved commit and populates
 * the subtask <select> element.
 * @param {Object}      slot       - Experiment slot (commitVar/commit/subtaskVar/tasktype/subtask)
 * @param {HTMLElement} subtaskSel - The <select> element to update
 */
async function loadDynamicSubtasks(slot, subtaskSel) {
  let resolvedCommit = slot.commit;
  if (slot.commitVar) {
    resolvedCommit = _state.variables.commits.get(slot.commitVar)?.value;
  }
  if (!resolvedCommit) {
    const options = buildSubtaskOptions(slot.tasktype, slot.subtask, slot.subtaskVar, []);
    const current = subtaskSel.value;
    _ui.UpdateSimpleDropdown(subtaskSel, options);
    subtaskSel.value = current;
    return;
  }
  const dynamicKnown = [];
  subtaskSel.disabled = true;
  subtaskSel.classList.add('select-loading');
  try {
    const [perfSubjs, vulnSubjs] = await Promise.all([
      _apirest.LoadCommitSubjects(TASK_TYPES.PERF, resolvedCommit),
      _apirest.LoadCommitSubjects(TASK_TYPES.VULN, resolvedCommit)
    ]);
    perfSubjs.forEach(s => dynamicKnown.push({ tasktype: TASK_TYPES.PERF, subtask: s.value }));
    vulnSubjs.forEach(s => dynamicKnown.push({ tasktype: TASK_TYPES.VULN, subtask: s.value }));
  } finally {
    subtaskSel.disabled = false;
    subtaskSel.classList.remove('select-loading');
  }
  dedupSubtasks(globalDynamicSubtasks, dynamicKnown);
  const options = buildSubtaskOptions(slot.tasktype, slot.subtask, slot.subtaskVar, dynamicKnown);
  const current = subtaskSel.value;
  _ui.UpdateSimpleDropdown(subtaskSel, options);
  subtaskSel.value = current;
}

/**
 * Enables or disables the OK button based on current dialog selection state.
 * @param {Object} ctx - Live AddGraphique dialog context
 */
function updateOkButton(ctx) {
  if (!ctx.btOk) return;
  const hasResolved = ctx.slots.some(s => resolveExperimentSlot(s, _state.variables) != null);
  const hasMetrics  = ctx.selectedMetrics.length > 0;
  if (hasResolved && hasMetrics) UI.EnableElement(ctx.btOk);
  else UI.DisableElement(ctx.btOk);
}

/**
 * Fetches available metrics for the resolved experiments and rebuilds the
 * metrics selection UI. Updates invalid-slot badges and auto-fills the time
 * range on first load.
 * @param {Object} ctx - Live AddGraphique dialog context
 */
function metricsMatch(a, b) {
  if (typeof a === 'string' && typeof b === 'string') return a === b;
  if (a?.variable && b?.variable) return a.variable === b.variable;
  return false;
}

async function rebuildMetricsUI(ctx) {
  const previousMetrics = [...ctx.selectedMetrics];
  ctx.selectedMetrics = [];
  updateOkButton(ctx);

  const slotResolutions = ctx.slots.map((slot, idx) => ({
    idx,
    resolved: resolveExperimentSlot(slot, _state.variables),
  }));
  const resolvedWithIdx = slotResolutions.filter(r => r.resolved);
  if (resolvedWithIdx.length === 0) {
    if (ctx.metricsUIContainer) {
      ctx.metricsUIContainer.remove();
      ctx.metricsUIContainer = null;
    }
    return;
  }

  const gen = ++ctx.metricsRebuildGen;

  if (ctx.metricsUIContainer) { ctx.metricsUIContainer.remove(); ctx.metricsUIContainer = null; }
  const loadingDiv = document.createElement('div');
  loadingDiv.className = 'metrics-loading';
  loadingDiv.innerHTML = '<div class="spinner"></div>';
  ctx.metricsWrapper?.appendChild(loadingDiv);

  const metricsResults = await Promise.all(
    resolvedWithIdx.map(({ resolved }) =>
      _apirest.LoadCommitMetrics(resolved.tasktype, resolved.commit, resolved.subtask, resolved.timestamp))
  );

  loadingDiv.remove();
  if (gen !== ctx.metricsRebuildGen) return;

  const newInvalid = new Set(
    resolvedWithIdx
      .filter((_, i) => !metricsResults[i]?.metrics || metricsResults[i].metrics.size === 0)
      .map(r => r.idx)
  );
  const invalidChanged = newInvalid.size !== ctx.invalidSlotIndices.size
    || [...newInvalid].some(i => !ctx.invalidSlotIndices.has(i));
  ctx.invalidSlotIndices = newInvalid;
  if (invalidChanged) {
    const rows = ctx.experimentList.querySelectorAll('.experiment-row');
    ctx.slots.forEach((slot, idx) => {
      const row = rows[idx];
      if (!row) return;
      const existingWarn = row.querySelector('.experiment-slot-warn');
      if (ctx.invalidSlotIndices.has(idx)) {
        if (!existingWarn) {
          const resolved = resolveExperimentSlot(slot, _state.variables);
          const warn = document.createElement('span');
          warn.className = 'experiment-slot-warn';
          warn.textContent = ICONS.WARN;
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

  const pathSets = metricsResults.map(flattenMetricPaths);
  const union = new Set();
  for (const s of pathSets) s.forEach(p => union.add(p));
  const intersection = pathSets.reduce((acc, s) => {
    return new Set([...acc].filter(p => s.has(p)));
  }, new Set(union));

  const absentPaths = new Set([...union].filter(p => !intersection.has(p)));
  const displayPaths = ctx.metricsMode === 'AND' ? intersection : union;
  const syntheticMetrics = buildSyntheticMetrics(displayPaths);

  if (!syntheticMetrics.metrics || syntheticMetrics.metrics.size === 0) {
    if (ctx.metricsUIContainer) { ctx.metricsUIContainer.remove(); ctx.metricsUIContainer = null; }
    return;
  }

  if (ctx.metricsUIContainer) { ctx.metricsUIContainer.remove(); ctx.metricsUIContainer = null; }

  const metricsTree = _ui.CreateMetrics(syntheticMetrics, {
    absent: ctx.metricsMode === 'OR' ? absentPaths : new Set(),
    callback: function(event) {
      if (event.target.checked) {
        ctx.selectedMetrics.push(event.target.value);
      } else {
        const idx = ctx.selectedMetrics.indexOf(event.target.value);
        if (idx >= 0) ctx.selectedMetrics.splice(idx, 1);
      }
      updateOkButton(ctx);
    }
  });

  if (_state.variables.metrics.size > 0) {
    const varSection = document.createElement('div');
    const varHeader = document.createElement('div');
    varHeader.style.cssText = 'font-weight:600;color:#555;font-size:0.85rem;margin-bottom:6px;';
    varHeader.textContent = 'Variables';
    varSection.appendChild(varHeader);
    _state.variables.metrics.forEach((metricPath, name) => {
      const label = document.createElement('label');
      label.className = 'checkbox-label';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'metric-checkbox';
      cb.dataset.varref = name;
      const span = document.createElement('span');
      span.textContent = metricPath ? `${name} (= ${metricPath})` : `${name} (undefined)`;
      cb.onchange = function() {
        if (cb.checked) ctx.selectedMetrics.push({ variable: name });
        else { const i = ctx.selectedMetrics.findIndex(m => m?.variable === name); if (i >= 0) ctx.selectedMetrics.splice(i, 1); }
        updateOkButton(ctx);
      };
      label.appendChild(cb);
      label.appendChild(span);
      varSection.appendChild(label);
    });
    const wrapper = document.createElement('div');
    wrapper.appendChild(varSection);
    wrapper.appendChild(metricsTree);
    ctx.metricsWrapper.appendChild(wrapper);
    ctx.metricsUIContainer = wrapper;
  } else {
    ctx.metricsWrapper.appendChild(metricsTree);
    ctx.metricsUIContainer = metricsTree;
  }

  if (!ctx.prefill) {
    const firstMetrics = metricsResults[0];
    if (firstMetrics?.maxTimeMicroS > 0) {
      const maxT = firstMetrics.maxTimeMicroS;
      const d = Math.max(1, Math.floor(maxT / DEFAULT_DELTA_DIVISOR));
      const startEl = document.getElementById('time_start_' + ctx.timeID);
      const endEl   = document.getElementById('time_end_'   + ctx.timeID);
      const deltaEl = document.getElementById('time_delta_' + ctx.timeID);
      const stepsEl = document.getElementById('time_steps_' + ctx.timeID);
      if (startEl) startEl.value = 0;
      if (endEl)   endEl.value   = maxT;
      if (deltaEl) deltaEl.value = d;
      if (stepsEl && d > 0) stepsEl.value = Math.floor(maxT / d);
    }
  }

  const toRestore = (ctx.prefill && !ctx.metricsPrefilled) ? ctx.prefill.metrics : previousMetrics;
  if (toRestore.length > 0) {
    ctx.metricsWrapper.querySelectorAll('.metric-checkbox').forEach(function(cb) {
      const cbMetric = cb.dataset.varref ? { variable: cb.dataset.varref } : cb.value;
      if (toRestore.some(m => metricsMatch(m, cbMetric)) && !cb.checked) {
        cb.checked = true;
        cb.closest('.checkbox-label').style.display = '';
        ctx.selectedMetrics.push(cbMetric);
      }
    });
    if (ctx.prefill && !ctx.metricsPrefilled) ctx.metricsPrefilled = true;
  }

  updateOkButton(ctx);
}

// ============================================================
// ADD / EDIT GRAPH DIALOG
// ============================================================

export async function AddGraphique(prefill = null, editId = null) {
  const gitHistory = _gitHistoryPromise;
  const allCommits = await _allCommitsPromise;

  // Slots use the same format as graphConfig.experiments:
  // { commitVar, commit, subtaskVar, tasktype, subtask }
  function createEmptySlot() {
    return { commitVar: null, commit: null, subtaskVar: null, tasktype: null, subtask: null };
  }

  function resolveSlot(slot) {
    return resolveExperimentSlot(slot, _state.variables);
  }

  function resolvedSlots() {
    return slots.map(resolveSlot).filter(Boolean);
  }

  const slots = prefill ? prefill.experiments.map(s => ({ ...s })) : [createEmptySlot()];
  // Mutable dialog state shared with module-level helpers (rebuildMetricsUI, updateOkButton)
  const ctx = {
    slots,
    prefill,
    metricsMode: prefill?.metricsMode ?? 'AND',
    selectedMetrics: [],
    metricsPrefilled: false,
    metricsUIContainer: null,
    metricsRebuildGen: 0,
    invalidSlotIndices: new Set(),
    // DOM refs — assigned after element creation below
    experimentList: null,
    metricsWrapper: null,
    btOk: null,
    timeID: null,
  };

  const modalpage = document.getElementById('modalpage');
  modalpage.innerHTML = '';

  const container = document.createElement('div');
  container.className = 'modal-dialog-scrollable';
  _ui.Reset();

  const modalBody = document.createElement('div');
  modalBody.className = 'modal-body';

  // ── Section 1: Experiments ──────────────────────────────────────
  if (editId !== null) {
    modalBody.appendChild(_ui.CreateTitle('Edit graph', 'h3', null));
  }
  modalBody.appendChild(_ui.CreateTitle('1. Experiments', 'h3', null));
  const experimentList = document.createElement('div');
  experimentList.className = 'experiment-list';
  modalBody.appendChild(experimentList);
  ctx.experimentList = experimentList;

  const addBtn = document.createElement('button');
  addBtn.className = 'experiment-row-add-btn';
  addBtn.textContent = '+ Add experiment';
  addBtn.onclick = function() {
    if (slots.length >= MAX_EXPERIMENTS) return;
    slots.push(createEmptySlot());
    renderExperiments();
    onExperimentChange();
  };
  modalBody.appendChild(addBtn);

  // ── Section 2: Metrics ─────────────────────────────────────────
  modalBody.appendChild(_ui.CreateTitle('2. Metrics', 'h3', null));

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
    ctx.metricsMode = 'AND';
    btnAnd.classList.add('active');
    btnOr.classList.remove('active');
    rebuildMetricsUI(ctx);
  };
  btnOr.onclick = function() {
    ctx.metricsMode = 'OR';
    btnOr.classList.add('active');
    btnAnd.classList.remove('active');
    rebuildMetricsUI(ctx);
  };
  modeRow.appendChild(btnAnd);
  modeRow.appendChild(btnOr);
  if (prefill?.metricsMode === 'OR') {
    btnAnd.classList.remove('active');
    btnOr.classList.add('active');
  }
  modalBody.appendChild(modeRow);

  const metricsWrapper = document.createElement('div');
  modalBody.appendChild(metricsWrapper);
  ctx.metricsWrapper = metricsWrapper;

  // ── Section 3: Time range ──────────────────────────────────────
  modalBody.appendChild(_ui.CreateTitle('3. Time range (μs)', 'h3', null));
  ctx.timeID = _ui.ID();
  const time = _ui.CreateTimeSelection(0, 0, 0, null);
  modalBody.appendChild(time);

  if (prefill) {
    const s = time.querySelector('#time_start_' + ctx.timeID);
    const e = time.querySelector('#time_end_'   + ctx.timeID);
    const d = time.querySelector('#time_delta_' + ctx.timeID);
    const p = time.querySelector('#time_steps_' + ctx.timeID);
    if (s) s.value = prefill.min;
    if (e) e.value = prefill.max;
    if (d) d.value = prefill.delta;
    if (p && prefill.delta > 0) p.value = Math.floor((prefill.max - prefill.min) / prefill.delta);
  }

  setModalCancel(function() {
    clearModalCancel();
    modalpage.classList.remove('modalpage-visible');
    _enableMainUI(true);
  });

  // ── Actions ────────────────────────────────────────────────────
  const actions = _ui.CreateActions(true, {
    ok: {
      callback: async function() {
        const resolved = resolvedSlots();
        if (resolved.length === 0 || ctx.selectedMetrics.length === 0) return;

        const min   = +document.getElementById('time_start_' + ctx.timeID).value;
        const max   = +document.getElementById('time_end_'   + ctx.timeID).value;
        const delta = +document.getElementById('time_delta_' + ctx.timeID).value;

        for (const exp of resolved) {
          const expKey = experimentKey(exp);
          if (!_state.commitRegistry.has(expKey)) {
            _state.commitRegistry.set(expKey, { color: nextCommitColor(_state.commitRegistry), displayName: null });
          }
        }

        const fetchMetrics = [...new Set(
          ctx.selectedMetrics
            .map(m => resolveMetricEntry(m, _state.variables.metrics))
            .filter(m => m != null)
        )];

        if (fetchMetrics.length === 0) {
          BuildSidebar(_state);
          clearModalCancel();
          modalpage.classList.remove('modalpage-visible');
          _enableMainUI(true);
          return;
        }

        const results = await Promise.all(
          resolved.map(exp => _apirest.LoadCommitMetricsValues(
            exp.tasktype, exp.commit, exp.subtask, min, max, delta, fetchMetrics, exp.timestamp))
        );
        const validPairs = resolved
          .map((exp, i) => ({ exp, data: results[i] }))
          .filter(p => p.data != null);

        if (validPairs.length > 0) {
          const graphConfig = {
            experiments: slots.filter(s => s.commitVar || s.commit || s.subtaskVar || s.tasktype || s.campaignVar || s.campaignRun),
            metricsMode: ctx.metricsMode,
            metrics: ctx.selectedMetrics,
            min, max, delta,
            showRaw:   prefill ? prefill.showRaw   : (validPairs.length === 1),
            showCI:    prefill ? prefill.showCI    : false,
            splitAxes: prefill ? prefill.splitAxes : true,
          };

          const dataMap = new Map(
            validPairs.map(p => [experimentKey(p.exp), p.data])
          );

          if (editId !== null) {
            _state.graphSettings.set(editId, graphConfig);
            await _graphManager.UpdateGraph(editId, graphConfig, dataMap);
          } else {
            const id = await _graphManager.AddGraph(graphConfig, dataMap);
            _state.graphSettings.set(id, graphConfig);
          }
        }

        BuildSidebar(_state);
        clearModalCancel();
        modalpage.classList.remove('modalpage-visible');
        _enableMainUI(true);
      },
      className: 'add-graph-ok-btn',
    },
    cancel: {
      callback: function() {
        clearModalCancel();
        modalpage.classList.remove('modalpage-visible');
        _enableMainUI(true);
      }
    }
  });
  container.appendChild(modalBody);
  container.appendChild(actions);
  modalpage.appendChild(container);

  ctx.btOk = container.querySelector('.add-graph-ok-btn');
  UI.DisableElement(ctx.btOk);

  renderExperiments();
  rebuildMetricsUI(ctx);

  modalpage.classList.add('modalpage-visible');

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
      removeBtn.textContent = ICONS.CLOSE;
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

  function slotField(labelText, el) {
    const field = document.createElement('div');
    field.className = 'slot-field';
    const label = document.createElement('span');
    label.className = 'slot-field-label';
    label.textContent = labelText;
    field.appendChild(label);
    field.appendChild(el);
    return field;
  }

  function renderSlotRow(row, slot, slotIdx) {
    const mode = slot.mode || ((slot.campaignVar || slot.campaignRun) ? 'campaign' : 'commit');

    // ── Mode toggle (commit ⇄ campaign) ──────────────────────────
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'experiment-mode-toggle';
    toggle.textContent = mode === 'campaign' ? 'Campaign' : 'Commit';
    toggle.title = 'Toggle commit / campaign mode';
    toggle.onclick = function() {
      if (mode === 'campaign') {
        slot.mode = 'commit';
        slot.campaignVar = null; slot.campaignRun = null;
      } else {
        slot.mode = 'campaign';
        slot.commit = null; slot.commitVar = null;
        slot.tasktype = null; slot.subtask = null; slot.subtaskVar = null;
      }
      renderExperiments();
      onExperimentChange();
    };
    row.appendChild(toggle);

    if (mode === 'campaign') renderCampaignSlot(row, slot);
    else renderCommitSlot(row, slot);

    // ⚠ badge: resolved combination has no data from the server
    if (ctx.invalidSlotIndices.has(slotIdx)) {
      const resolved = resolveSlot(slot);
      const warn = document.createElement('span');
      warn.className = 'experiment-slot-warn';
      warn.textContent = ICONS.WARN;
      warn.title = resolved
        ? `No data for ${CommitHelp.ShortHash(resolved.commit)}/${resolved.tasktype}/${resolved.subtask}`
        : 'No data';
      row.appendChild(warn);
    }
  }

  function renderCommitSlot(row, slot) {
    // Commit picker
    const initialSelected = slot.commitVar ? `_var_${slot.commitVar}` : (slot.commit ?? null);
    const commitSel = _ui.CreateCommitPicker(gitHistory, allCommits, {
      selected: initialSelected,
      variables: _state.variables.commits,
    });

    commitSel.addEventListener('change', function() {
      const val = commitSel.value;
      if (!val) {
        slot.commitVar = null; slot.commit = null;
      } else if (val.startsWith('_var_')) {
        slot.commitVar = val.slice(5); slot.commit = null;
      } else {
        slot.commitVar = null; slot.commit = val;
      }
      onExperimentChange();
      loadDynamicSubtasks(slot, subtaskSel);
    });

    // Subtask selector
    const subtaskSel = _ui.CreateSimpleDropdown(
      buildSubtaskOptions(slot.tasktype, slot.subtask, slot.subtaskVar), null
    );
    subtaskSel.title = 'Subtask';

    loadDynamicSubtasks(slot, subtaskSel);

    subtaskSel.addEventListener('change', function() {
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
    });

    row.appendChild(slotField('Commit', commitSel));
    row.appendChild(slotField('Subtask', subtaskSel));
  }

  function renderCampaignSlot(row, slot) {
    // Single selector: campaign variables appear as rows alongside the direct runs
    // (mirrors the commit picker). .value is a `_var_NAME` string or a direct runRef.
    const initialSelected = slot.campaignVar ? `_var_${slot.campaignVar}` : (slot.campaignRun ?? null);
    const runSel = _ui.CreateCampaignPicker(globalCampaigns, {
      selected: initialSelected,
      variables: _state.variables.campaigns,
    });
    runSel.addEventListener('change', function() {
      const v = runSel.value;
      if (typeof v === 'string' && v.startsWith('_var_')) {
        slot.campaignVar = v.slice(5); slot.campaignRun = null;
      } else if (v) {
        slot.campaignRun = v; slot.campaignVar = null;
      } else {
        slot.campaignVar = null; slot.campaignRun = null;
      }
      onExperimentChange();
    });
    row.appendChild(slotField('Campaign', runSel));
  }

  function onExperimentChange() {
    rebuildMetricsUI(ctx);
    updateOkButton(ctx);
  }
}

export async function EditGraph(id) {
  const existingConfig = _state.graphSettings.get(id);
  if (!existingConfig) return;
  _enableMainUI(false);
  await AddGraphique(existingConfig, id);
}

// ============================================================
// FILE LIST MODAL (shared by Open View and Open Template)
// ============================================================

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
export function buildFileListModal(restoreUI, opts) {
  const modalpage = document.getElementById('modalpage');
  modalpage.innerHTML = '';

  const container = document.createElement('div');
  _ui.Reset();
  container.appendChild(_ui.CreateTitle(opts.title, 'h3'));

  const viewControls = document.createElement('div');
  viewControls.className = 'view-controls';

  const filterInput = document.createElement('input');
  filterInput.type = 'text';
  filterInput.className = 'modal-text-input view-filter-input';
  filterInput.placeholder = opts.filterPlaceholder;
  viewControls.appendChild(filterInput);

  const sortBtn = document.createElement('button');
  sortBtn.className = 'view-sort-btn';
  sortBtn.textContent = 'A → Z';
  sortBtn.title = 'Toggle sort order';
  let sortAsc = true;
  viewControls.appendChild(sortBtn);
  container.appendChild(viewControls);

  const listContainer = document.createElement('div');
  listContainer.className = 'view-list-container';
  const loadingSpan = document.createElement('span');
  loadingSpan.className = 'modal-wait';
  loadingSpan.textContent = ICONS.CLOCK;
  listContainer.appendChild(loadingSpan);
  container.appendChild(listContainer);

  let allFiles = [];

  function closeModal() {
    clearModalCancel();
    modalpage.classList.remove('modalpage-visible');
    _enableMainUI(true);
  }

  function dismissModal() {
    clearModalCancel();
    modalpage.classList.remove('modalpage-visible');
    _enableMainUI(restoreUI);
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
      delBtn.textContent = ICONS.DELETE;
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
    sortBtn.textContent = sortAsc ? 'A → Z' : 'Z → A';
    renderList();
  };

  setModalCancel(dismissModal);

  container.appendChild(_ui.CreateActions(false, {
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
  modalpage.classList.add('modalpage-visible');
}

// ============================================================
// OPEN VIEW
// ============================================================

export function OpenView(restoreUI = false) {
  buildFileListModal(restoreUI, {
    title: 'Open a View',
    filterPlaceholder: 'Filter views…',
    emptyText: {
      empty:    'No saved views yet.',
      filtered: 'No views match your filter.',
      failed:   'Failed to load views.',
    },
    fetchFiles: () => _apirest.ListPages(),
    onLoad: function(name, closeModal) {
      _apirest.LoadPage(name).then(function(newstate) {
        if (newstate == null) return;
        _resetState(_state, newstate).then(function() {
          closeModal();
          _errorManager.Success('View loaded: ' + name);
        });
      });
    },
    onDelete: function(name, rerender) {
      if (!confirm(`Delete view "${name}"? This cannot be undone.`)) return;
      _apirest.DeletePage(name).then(function(ok) {
        if (ok) {
          rerender();
          _errorManager.Success('View deleted: ' + name);
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

export function OpenTemplate(restoreUI = false) {
  buildFileListModal(restoreUI, {
    title: 'Open a Template',
    filterPlaceholder: 'Filter templates…',
    emptyText: {
      empty:    'No saved templates yet.',
      filtered: 'No templates match your filter.',
      failed:   'Failed to load templates.',
    },
    fetchFiles: () => _apirest.ListTemplates(),
    onLoad: function(name, closeModal) {
      _apirest.LoadTemplate(name).then(function(tpl) {
        if (tpl == null) return;
        _resetState(_state, tpl, name).then(function() {
          closeModal();
          _errorManager.Success('Template loaded: ' + name);
        });
      });
    },
    onDelete: function(name, rerender) {
      if (!confirm(`Delete template "${name}"? This cannot be undone.`)) return;
      _apirest.DeleteTemplate(name).then(function(ok) {
        if (ok) {
          rerender();
          _errorManager.Success('Template deleted: ' + name);
        }
      });
    },
    extraRowBtns: function(name) {
      const copyBtn = document.createElement('button');
      copyBtn.className = 'view-list-action-btn';
      copyBtn.textContent = ICONS.LINK;
      copyBtn.title = 'Copy shareable URL (uses current variable values)';
      copyBtn.onclick = function(e) {
        e.stopPropagation();
        const url = buildTemplateURL(name, _state);
        navigator.clipboard.writeText(url).then(function() {
          copyBtn.textContent = ICONS.CHECK;
          setTimeout(function() { copyBtn.textContent = ICONS.LINK; }, 2000);
        });
      };
      return [copyBtn];
    },
  });
}

export function SaveAsTemplate(state) {
  const modalpage = document.getElementById('modalpage');
  modalpage.innerHTML = '';
  const container = document.createElement('div');
  _ui.Reset();

  container.appendChild(_ui.CreateTitle('Save as Template', 'h3'));

  const nameLabel = document.createElement('label');
  nameLabel.className = 'modal-field-label';
  nameLabel.textContent = 'Template name';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'modal-text-input';
  nameInput.placeholder = 'Template name…';
  container.appendChild(nameLabel);
  container.appendChild(nameInput);

  const fmtLabel = document.createElement('label');
  fmtLabel.className = 'modal-field-label';
  fmtLabel.textContent = 'View title format (optional)';
  const fmtInput = document.createElement('input');
  fmtInput.type = 'text';
  fmtInput.className = 'modal-text-input';
  fmtInput.placeholder = state.title;
  fmtInput.title =
    'Tokens: ${TEMPLATE}, ${DATE}, ${TIME}, ${DATETIME}, ${C1_HASH}, ${C1_ALIAS}, ${S1_NAME}, ${S1_TYPE}, ${S1_ALIAS}, ${M1}…\n' +
    'Transforms (chain with :): uppercase, lowercase, camelcase, kebabcase, beforeFirst(regex), afterLast(regex), format(pattern)\n' +
    'Date/time default to YYYY-MM-DD / HH:mm:ss; override with :format(YYYY/MM/DD)\n' +
    'Ex: ${C1_ALIAS} − ${C2_ALIAS} (${DATE})';
  container.appendChild(fmtLabel);
  container.appendChild(fmtInput);

  const close = function() {
    clearModalCancel();
    modalpage.classList.remove('modalpage-visible');
    _enableMainUI(true);
  };

  setModalCancel(close);

  const actions = _ui.CreateActions(true, {
    ok: {
      text: 'Save',
      callback: async function() {
        const trimmedName = nameInput.value.trim();
        if (!trimmedName) { nameInput.focus(); return; }

        const titleFormat = fmtInput.value.trim() || null;

        close();

        const tpl = {
          title:       state.title,
          titleFormat,
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

        const ok = await _apirest.SaveTemplate(trimmedName, tpl);
        if (ok) _errorManager.Success('Template saved: ' + trimmedName);
      },
    },
    cancel: { callback: close },
  });
  container.appendChild(actions);

  modalpage.appendChild(container);
  modalpage.classList.add('modalpage-visible');
  nameInput.focus();
}

export async function tryLoadTemplateFromURL() {
  const params = new URLSearchParams(window.location.search);
  const templateName = params.get('template');
  if (!templateName) return false;

  // Clean URL immediately so a failed load doesn't loop on every reload.
  history.replaceState(null, '', window.location.pathname);

  const raw = await _apirest.LoadTemplate(templateName);
  if (!raw) return false;

  const tpl = raw;

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

  await _resetState(_state, tpl, templateName);
  _enableMainUI(true);
  return true;
}

// ============================================================
// INFO / HELP MODAL
// ============================================================

export function OpenInfoModal() {
  const modalpage = document.getElementById('modalpage');
  modalpage.innerHTML = '';

  const container = document.createElement('div');
  _ui.Reset();

  container.appendChild(_ui.CreateTitle('How to use this tool', 'h3'));

  const body = document.createElement('div');
  body.className = 'info-modal-body';
  body.innerHTML = HELP_HTML;
  container.appendChild(body);

  const closeFn = function() {
    clearModalCancel();
    modalpage.classList.remove('modalpage-visible');
  };
  setModalCancel(closeFn);

  container.appendChild(_ui.CreateActions(false, {
    ok: { text: 'Close', callback: closeFn }
  }));

  modalpage.appendChild(container);
  modalpage.classList.add('modalpage-visible');
}
