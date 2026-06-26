/**
 * Modal dialog builders for Add Graph, Edit Graph, Open/Save View, Templates, and Help.
 *
 * Call initDialogs(deps) once at startup before any dialog function is used.
 */

import { ICONS, TASK_TYPES, DEFAULT_DELTA_DIVISOR } from './constants.js';
import { HELP_HTML } from './help.js';
import { resolveExperimentSlot, slotMode, resolveMetricEntry, nextCommitColor, setModalCancel, clearModalCancel, dedupSubtasks, globalDynamicSubtasks, globalCampaigns, experimentKey, findGraph } from './state.js';
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
  // Require a live metrics UI: a preserved selection (kept across transient
  // states) must not enable OK while no checkboxes are shown, e.g. when the
  // resolved experiment has no metrics.
  const hasMetrics  = ctx.selectedMetrics.length > 0 && ctx.metricsUIContainer != null;
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

async function rebuildMetricsUI(ctx, forceTimeRecalc = false) {
  // Snapshot the current selection but DON'T clear it yet: clearing is deferred
  // until we are actually about to rebuild the checkbox tree (see below). This
  // preserves the selection through transient states where no usable metrics UI
  // is built (no resolved experiment, or an experiment with no data), so it can
  // be restored once a valid experiment is defined again.
  const previousMetrics = [...ctx.selectedMetrics];

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
    updateOkButton(ctx);
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
    updateOkButton(ctx);
    return;
  }

  if (ctx.metricsUIContainer) { ctx.metricsUIContainer.remove(); ctx.metricsUIContainer = null; }

  // About to rebuild the tree: now clear the selection so checkbox callbacks
  // start from an empty array. The restoration loop below re-adds the preserved
  // entries from previousMetrics (or ctx.prefill on first edit).
  ctx.selectedMetrics = [];
  updateOkButton(ctx);

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

  if (forceTimeRecalc || !ctx.prefill) {
    // Largest extent across all experiments, so no series is truncated.
    const maxT = metricsResults.reduce((m, r) => Math.max(m, r?.maxTimeMicroS ?? -1), -1);
    if (maxT > 0) {
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
            const entry = findGraph(_state, editId);
            if (entry) entry.config = graphConfig;
            await _graphManager.UpdateGraph(editId, graphConfig, dataMap);
          } else {
            const id = await _graphManager.AddGraph(graphConfig, dataMap);
            _state.graphSettings.push({ id, config: graphConfig });
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
    const mode = slotMode(slot);

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
    rebuildMetricsUI(ctx, true);
    updateOkButton(ctx);
  }
}

export async function EditGraph(id) {
  const existingConfig = findGraph(_state, id)?.config;
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
    extraRowBtns: function(name) {
      return [makeCopyURLBtn(() => buildViewURL(name), 'Copy shareable view URL')];
    },
  });
}

/**
 * Copies text to the clipboard. Falls back to a temporary textarea +
 * execCommand on non-secure contexts (e.g. served over plain HTTP from a
 * non-localhost host) where navigator.clipboard is undefined.
 * @returns {Promise<void>} resolves on success, rejects on failure
 */
function copyTextToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }
  return new Promise(function(resolve, reject) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    // Keep it out of view and out of the layout/scroll flow.
    textarea.style.position = 'fixed';
    textarea.style.top = '-9999px';
    textarea.setAttribute('readonly', '');
    document.body.appendChild(textarea);
    textarea.select();
    try {
      if (document.execCommand('copy')) resolve();
      else reject(new Error('Copy command was rejected'));
    } catch (err) {
      reject(err);
    } finally {
      document.body.removeChild(textarea);
    }
  });
}

/**
 * Builds a row-action button that copies a generated URL to the clipboard,
 * flashing a checkmark on success and surfacing an error toast on failure.
 * @param {() => string|Promise<string>} urlFactory - produces the URL to copy when clicked
 * @param {string} title - button tooltip
 * @returns {HTMLButtonElement}
 */
function makeCopyURLBtn(urlFactory, title) {
  const copyBtn = document.createElement('button');
  copyBtn.className = 'view-list-action-btn';
  copyBtn.textContent = ICONS.LINK;
  copyBtn.title = title;
  copyBtn.onclick = function(e) {
    e.stopPropagation();
    Promise.resolve(urlFactory()).then(copyTextToClipboard).then(function() {
      copyBtn.textContent = ICONS.CHECK;
      setTimeout(function() { copyBtn.textContent = ICONS.LINK; }, 2000);
    }).catch(function(err) {
      _errorManager.Error('Failed to copy URL: ' + err.message);
    });
  };
  return copyBtn;
}

/** Builds a shareable URL that loads a saved view by name on page load. */
function buildViewURL(viewName) {
  const params = new URLSearchParams({ view: viewName });
  return `${window.location.origin}${window.location.pathname}?${params.toString()}`;
}

/**
 * If the URL carries a `view` param, loads that saved view as a full-state snapshot
 * (no variable overlay, unlike templates). Mirrors tryLoadTemplateFromURL.
 * @returns {Promise<boolean>} true if a view was loaded
 */
export async function tryLoadViewFromURL() {
  const params = new URLSearchParams(window.location.search);
  const viewName = params.get('view');
  if (!viewName) return false;

  // Clean URL immediately so a failed load doesn't loop on every reload.
  history.replaceState(null, '', window.location.pathname);

  const newstate = await _apirest.LoadPage(viewName);
  if (!newstate) return false;

  await _resetState(_state, newstate);
  _enableMainUI(true);
  return true;
}

// ============================================================
// TEMPLATES
// ============================================================

/**
 * Builds a self-documenting "fill-in-the-blanks" URL for a template: it lists every
 * variable the template defines with a placeholder token showing the expected format,
 * so a recipient can see what they may fill in. The placeholders (and their `:`/`<>`
 * separators) are kept raw — we assemble the query string by hand rather than via
 * URLSearchParams.toString(), which would percent-encode them and ruin readability.
 * @param {string} templateName
 * @returns {Promise<string>}
 */
async function buildTemplateURL(templateName) {
  const tpl = await _apirest.LoadTemplate(templateName);
  const vars = tpl?.variables;
  const parts = [`template=${encodeURIComponent(templateName)}`];
  for (const [name] of vars?.commits   ?? []) parts.push(`${name}=<commit_hash>`, `${name}.alias=<alias>`);
  for (const [name] of vars?.subtasks  ?? []) parts.push(`${name}=<tasktype>:<subtask>`, `${name}.alias=<alias>`);
  for (const [name] of vars?.campaigns ?? []) parts.push(`${name}=<user>:<campaign>:<timestamp>`, `${name}.alias=<alias>`);
  for (const [name] of vars?.metrics   ?? []) parts.push(`${name}=<metric_path>`);
  return `${window.location.origin}${window.location.pathname}?${parts.join('&')}`;
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
      return [makeCopyURLBtn(() => buildTemplateURL(name), 'Copy a fill-in-the-blanks URL listing this template’s variables')];
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
          // A template is a blank shell: keep only the variable names, never their
          // current values/aliases. The null bodies are dropped by the serializer
          // (jsonhelp), and readers infer empty variables on load.
          variables: {
            commits:   new Map([...state.variables.commits.keys()].map(k => [k, { value: null, alias: null }])),
            subtasks:  new Map([...state.variables.subtasks.keys()].map(k => [k, { value: null, alias: null }])),
            campaigns: new Map([...state.variables.campaigns.keys()].map(k => [k, { value: null, alias: null }])),
            metrics:   new Map([...state.variables.metrics.keys()].map(k => [k, null])),
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

/**
 * Overlays URL query parameters onto a loaded template's variable Maps, in place.
 * Only variable names that already exist in the template are affected; URL params
 * for unknown variables are ignored. An empty value (e.g. c1=) clears to null.
 * Formats: commits <name>=<hash> + <name>.alias; subtasks <name>=<tasktype>:<subtask>
 * + <name>.alias; campaigns <name>=<user>:<campaign>:<timestamp> + <name>.alias;
 * metrics <name>=<path>.
 *
 * Any param that can't be turned into a usable value — an unfilled `<…>` placeholder, a
 * malformed subtask, or a campaign run with no match in globalCampaigns — is reported via
 * an error toast naming the variable, and that variable is left unset.
 * @param {object} tpl - template with .variables.{commits,subtasks,campaigns,metrics} Maps
 * @param {URLSearchParams} params
 * @param {string[]} fullHashes - known full commit hashes, to resolve shortened ones
 */
function applyURLParamsToTemplate(tpl, params, fullHashes = []) {
  // A value still wrapped in angle brackets is an unedited placeholder from a copied URL.
  const isPlaceholder = (v) => typeof v === 'string' && /^<.*>$/.test(v.trim());
  const failures = [];
  const fail = (name, reason) => failures.push(`Variable "${name}" could not be loaded from the URL: ${reason}.`);
  // Placeholder aliases (e.g. c1.alias=<alias>) are treated as "not provided".
  const readAlias = (name, entry) => {
    if (!params.has(`${name}.alias`)) return entry?.alias ?? null;
    const raw = params.get(`${name}.alias`);
    return isPlaceholder(raw) ? null : (raw || null);
  };

  if (tpl.variables?.commits instanceof Map) {
    for (const [name, entry] of tpl.variables.commits) {
      const hasVal = params.has(name);
      const alias = readAlias(name, entry);
      if (hasVal) {
        const raw = params.get(name);
        if (isPlaceholder(raw)) {
          fail(name, `value is still a placeholder (${raw})`);
          tpl.variables.commits.set(name, { value: null, alias });
        } else if (parseDynamicRef(raw)) {
          // A dynamic reference (e.g. @dev-base) is resolved in a later async pass
          // (resolveDynamicCommitRefs), once anchor commits hold their literal hashes.
          // Keep any alias the URL/template already carries.
          tpl.variables.commits.set(name, { value: null, alias });
        } else {
          tpl.variables.commits.set(name, { value: raw ? CommitHelp.ResolveFullHash(raw, fullHashes) : null, alias });
        }
      } else if (params.has(`${name}.alias`)) {
        tpl.variables.commits.set(name, { value: entry?.value ?? null, alias });
      }
    }
  }
  if (tpl.variables?.subtasks instanceof Map) {
    for (const [name, entry] of tpl.variables.subtasks) {
      const hasVal = params.has(name);
      const alias = readAlias(name, entry);
      if (hasVal) {
        const raw = params.get(name);
        if (!raw) {
          tpl.variables.subtasks.set(name, { value: null, alias });
        } else if (isPlaceholder(raw)) {
          fail(name, `value is still a placeholder (${raw})`);
          tpl.variables.subtasks.set(name, { value: null, alias });
        } else {
          const firstColon = raw.indexOf(':');
          if (firstColon > 0 && firstColon < raw.length - 1) {
            tpl.variables.subtasks.set(name, {
              value: { tasktype: raw.slice(0, firstColon), subtask: raw.slice(firstColon + 1) },
              alias,
            });
          } else {
            fail(name, `expected <tasktype>:<subtask>, got "${raw}"`);
            tpl.variables.subtasks.set(name, { value: null, alias });
          }
        }
      } else if (params.has(`${name}.alias`)) {
        tpl.variables.subtasks.set(name, { value: entry?.value ?? null, alias });
      }
    }
  }
  if (tpl.variables?.campaigns instanceof Map) {
    for (const [name, entry] of tpl.variables.campaigns) {
      const hasVal = params.has(name);
      const alias = readAlias(name, entry);
      if (hasVal) {
        const raw = params.get(name);
        if (!raw) {
          tpl.variables.campaigns.set(name, { value: null, alias });
        } else if (isPlaceholder(raw)) {
          fail(name, `value is still a placeholder (${raw})`);
          tpl.variables.campaigns.set(name, { value: null, alias });
        } else {
          const run = findCampaignRun(raw);
          if (!run) fail(name, `no campaign run matches "${raw}"`);
          tpl.variables.campaigns.set(name, { value: run, alias });
        }
      } else if (params.has(`${name}.alias`)) {
        tpl.variables.campaigns.set(name, { value: entry?.value ?? null, alias });
      }
    }
  }
  if (tpl.variables?.metrics instanceof Map) {
    for (const [name] of tpl.variables.metrics) {
      if (!params.has(name)) continue;
      const raw = params.get(name);
      if (isPlaceholder(raw)) {
        fail(name, `value is still a placeholder (${raw})`);
        tpl.variables.metrics.set(name, null);
      } else {
        tpl.variables.metrics.set(name, raw || null);
      }
    }
  }

  for (const msg of failures) _errorManager.Error(msg);
}

/**
 * Resolves a `<user>:<campaign>:<timestamp>` URL token to a full campaign run object
 * by matching it against the loaded globalCampaigns list. Returns null if the token is
 * malformed or no run matches (e.g. the run list isn't loaded or the run is gone).
 * @param {string} raw
 * @returns {{type,commit,timestamp,user,campaign,subject}|null}
 */
function findCampaignRun(raw) {
  const i = raw.indexOf(':'), j = raw.lastIndexOf(':');
  if (i === -1 || i === j) return null;  // need exactly 3 parts
  const user = raw.slice(0, i);
  const campaign = raw.slice(i + 1, j);
  const ts = Number(raw.slice(j + 1));
  const r = globalCampaigns.find(c =>
    String(c.user) === user && String(c.campaign) === campaign && Number(c.timestamp) === ts);
  if (!r) return null;
  return {
    type:      'Campaign',
    commit:    r.commit,
    timestamp: r.timestamp,
    user:      r.user,
    campaign:  r.campaign,
    subject:   (r.subjects && r.subjects[0]) || null,
  };
}

/**
 * Second pass over a template's commit variables: any whose URL value is a dynamic
 * reference (e.g. `c2=@dev-base`) is resolved to a concrete data-layer hash, anchored
 * to the resolved value of its anchor commit var (default c1). Must run after
 * applyURLParamsToTemplate, so anchors already hold their literal hashes. Async because
 * dev-base may hit the git-log endpoint. Unresolvable refs are reported via an error
 * toast naming the variable and left unset, mirroring applyURLParamsToTemplate.
 * @param {object} tpl
 * @param {URLSearchParams} params
 * @param {object} ctx - { commits, gitHistory, perfByShort, loadGitLog }
 */
/** True when any of the template's commit vars has an @-token URL value to resolve. */
function templateHasDynamicRef(tpl, params) {
  const commits = tpl.variables?.commits;
  if (!(commits instanceof Map)) return false;
  for (const [name] of commits) if (parseDynamicRef(params.get(name))) return true;
  return false;
}

async function resolveDynamicCommitRefs(tpl, params, ctx) {
  const commits = tpl.variables?.commits;
  if (!(commits instanceof Map)) return;
  for (const [name] of commits) {
    const ref = parseDynamicRef(params.get(name));
    if (!ref) continue;
    const anchorHash = commits.get(ref.anchor)?.value ?? params.get(ref.anchor) ?? null;
    const value = await CommitHelp.ResolveDynamicRef(ref.token, anchorHash, ctx);
    const existing = commits.get(name);
    if (!value) {
      _errorManager.Error(`Variable "${name}" could not be loaded from the URL: dynamic reference "@${ref.token}" could not be resolved.`);
      continue;
    }
    commits.set(name, { value, alias: existing?.alias ?? DYN_REF_DEFAULT_ALIAS[ref.token] });
  }
}

export async function tryLoadTemplateFromURL() {
  const params = new URLSearchParams(window.location.search);
  const templateName = params.get('template');
  if (!templateName) return false;

  // Clean URL immediately so a failed load doesn't loop on every reload.
  history.replaceState(null, '', window.location.pathname);

  const raw = await _apirest.LoadTemplate(templateName);
  if (!raw) return false;

  const fullHashes = await _allCommitsPromise;
  applyURLParamsToTemplate(raw, params, fullHashes);

  // git history + the Perf commit list are needed only to resolve dynamic commit
  // refs; skip both fetches when no commit var carries an @-token (the common case).
  if (templateHasDynamicRef(raw, params)) {
    const [gitHistory, perfList] = await Promise.all([
      _gitHistoryPromise,
      _apirest.LoadCommits(TASK_TYPES.PERF),
    ]);
    await resolveDynamicCommitRefs(raw, params, {
      commits: gitHistory?.commits ?? [],
      gitHistory,
      perfByShort: new Map((perfList ?? []).map(h => [CommitHelp.ShortHash(h), h])),
      loadGitLog: (c) => _apirest.LoadGitLog(c),
    });
  }

  await _resetState(_state, raw, templateName);
  _enableMainUI(true);
  return true;
}

// ============================================================
// TEMPLATE SUGGESTION PANEL (URL with variables but no template)
// ============================================================

const URL_VAR_PATTERNS = [
  [/^c\d+$/, 'commits'],
  [/^s\d+$/, 'subtasks'],
  [/^k\d+$/, 'campaigns'],
  [/^m\d+$/, 'metrics'],
];

// Dynamic commit references usable as a commit variable's URL value instead of a
// literal hash, e.g. `c2=@dev-base` or `c2=@dev-base:c3`. `main-tip`/`dev-tip` are
// absolute; `dev-base` is computed relative to an anchor commit var (default c1).
const DYN_REF_TOKENS = ['main-tip', 'dev-tip', 'dev-base'];
const DYN_REF_RE = /^@([a-z-]+)(?::(c\d+))?$/i;
const DYN_REF_DEFAULT_ALIAS = { 'main-tip': 'main', 'dev-tip': 'dev', 'dev-base': 'base' };

/**
 * Parses a commit variable's URL value as a dynamic reference. Returns
 * { token, anchor } (anchor defaulting to 'c1') for a recognised `@token[:cX]`,
 * or null for a literal hash / placeholder / unknown token.
 * @param {string|null} raw
 */
function parseDynamicRef(raw) {
  const m = typeof raw === 'string' && raw.trim().match(DYN_REF_RE);
  if (!m) return null;
  const token = m[1].toLowerCase();
  if (!DYN_REF_TOKENS.includes(token)) return null;
  return { token, anchor: m[2] || 'c1' };
}

/**
 * Classifies the variable names present in a URL by category (commits/subtasks/
 * campaigns/metrics), based on their auto-naming prefix. Ignores `*.alias` keys
 * and the `template` key.
 * @param {URLSearchParams} params
 * @returns {{commits:string[], subtasks:string[], campaigns:string[], metrics:string[]}}
 */
function parseURLVariables(params) {
  const out = { commits: [], subtasks: [], campaigns: [], metrics: [] };
  for (const key of params.keys()) {
    if (key === 'template' || key.endsWith('.alias')) continue;
    for (const [re, cat] of URL_VAR_PATTERNS) {
      if (re.test(key)) { if (!out[cat].includes(key)) out[cat].push(key); break; }
    }
  }
  return out;
}

/** Builds fresh variable Maps directly from URL params (no template defaults). */
function buildVariablesFromParams(params, fullHashes = []) {
  const commits = new Map(), subtasks = new Map(), campaigns = new Map(), metrics = new Map();
  const defined = parseURLVariables(params);
  for (const name of defined.commits) {
    const raw = params.get(name);
    commits.set(name, { value: raw ? CommitHelp.ResolveFullHash(raw, fullHashes) : null, alias: params.get(`${name}.alias`) || null });
  }
  for (const name of defined.subtasks) {
    const val = params.get(name);
    let value = null;
    if (val) {
      const i = val.indexOf(':');
      if (i !== -1) value = { tasktype: val.slice(0, i), subtask: val.slice(i + 1) };
    }
    subtasks.set(name, { value, alias: params.get(`${name}.alias`) || null });
  }
  for (const name of defined.campaigns) {
    campaigns.set(name, { value: null, alias: params.get(`${name}.alias`) || null });
  }
  for (const name of defined.metrics) metrics.set(name, params.get(name) || null);
  return { commits, subtasks, campaigns, metrics };
}

/** Deep-clones a template's variable Maps so previews can be mutated safely. */
function cloneTemplate(tpl) {
  const cloneMap = (cat) => {
    const src = tpl.variables?.[cat];
    if (!(src instanceof Map)) return new Map();
    return new Map([...src].map(([k, v]) =>
      [k, (v && typeof v === 'object') ? { ...v } : v]));
  };
  return {
    ...tpl,
    variables: {
      commits:   cloneMap('commits'),
      subtasks:  cloneMap('subtasks'),
      campaigns: cloneMap('campaigns'),
      metrics:   cloneMap('metrics'),
    },
  };
}

/**
 * True if a template (described by its per-category variable name lists, as
 * returned by ListTemplateVariables) defines every variable name in `defined`.
 * The template may define additional variables.
 */
function templateMatches(vars, defined) {
  return ['commits', 'subtasks', 'campaigns', 'metrics'].every(cat =>
    defined[cat].every(name => (vars?.[cat] ?? []).includes(name)));
}

/** Short, human-readable value for a single variable entry (for chips/preview). */
function describeVarValue(cat, entry) {
  if (cat === 'metrics') return entry || '(unset)';
  const val = entry?.value;
  if (val == null) return '(unset)';
  if (cat === 'commits') {
    return CommitHelp.ShortHash(val) + (entry.alias ? ` (${entry.alias})` : '');
  }
  if (cat === 'subtasks') {
    return `${val.tasktype}:${val.subtask}` + (entry.alias ? ` (${entry.alias})` : '');
  }
  if (cat === 'campaigns') {
    return (val.commit ? CommitHelp.CampaignRunLabel(val) : '(set)') + (entry.alias ? ` (${entry.alias})` : '');
  }
  return '(set)';
}

/**
 * On-load panel shown when the URL carries variables but no template. Lists
 * templates whose variable set is a superset of the URL's, lets the user drop
 * URL variables, and (when only c1 is defined) offers "Compare with" actions
 * that add a c2 commit variable. Returns false if the URL defines no variables.
 * @returns {Promise<boolean>} true if the panel was shown
 */
export async function SuggestTemplatesFromURL() {
  const params = new URLSearchParams(window.location.search);
  const urlVars = parseURLVariables(params);
  const total = urlVars.commits.length + urlVars.subtasks.length
    + urlVars.campaigns.length + urlVars.metrics.length;
  if (total === 0) return false;

  // Clean the URL now that we've captured the variables.
  history.replaceState(null, '', window.location.pathname);

  // Working state (mutated by the panel).
  const pendingParams = new URLSearchParams(params.toString());
  let pendingC2 = null;          // { value, alias, source } | null
  let selected  = null;          // { name, vars } | null

  // Dynamic @-tokens (e.g. c2=@dev-base) are only resolved on the template-URL
  // path; here, where no template is named, comparison targets are chosen via the
  // "Compare with" buttons instead. Drop any such commit values and tell the user.
  const ignoredRefs = [];
  for (const name of parseURLVariables(pendingParams).commits) {
    if (!parseDynamicRef(pendingParams.get(name))) continue;
    ignoredRefs.push(`${name}=${pendingParams.get(name)}`);
    pendingParams.delete(name);
    pendingParams.delete(`${name}.alias`);
  }
  if (ignoredRefs.length) {
    _errorManager.Error(`Ignored dynamic reference${ignoredRefs.length > 1 ? 's' : ''} ${ignoredRefs.join(', ')}: they only work with a template in the URL. Use the "Compare with" buttons below.`);
  }

  // These are independent — fetch concurrently so the panel opens fast.
  const [gitHistory, perfList, index, fullHashes] = await Promise.all([
    _gitHistoryPromise,
    _apirest.LoadCommits(TASK_TYPES.PERF),
    _apirest.ListTemplateVariables(),
    _allCommitsPromise,
  ]);
  const commits = gitHistory?.commits ?? [];

  // Perf commits indexed by short hash → the exact data-layer hash. Used to skip
  // compare targets with no Perf run (stepping to the next older one that has
  // one) and to return the commit in the form the data backend expects.
  const perfByShort = new Map((perfList ?? []).map(h => [CommitHelp.ShortHash(h), h]));

  // Shared context for the dynamic compare-target resolvers in CommitHelp.
  const dynCtx = { commits, gitHistory, perfByShort, loadGitLog: (c) => _apirest.LoadGitLog(c) };

  // `index` (template variable names, for matching) was fetched above; full
  // definitions are loaded lazily when a template is selected.
  const catalog = Object.entries(index?.templates ?? {})
    .map(([name, vars]) => ({ name, vars }));

  // Cache of full template definitions, loaded on demand. A `null` value means
  // the load was attempted and failed (so we don't retry on every render).
  const templateCache = new Map();   // name -> tpl | null
  async function ensureTpl(name) {
    if (templateCache.has(name)) return templateCache.get(name);
    const tpl = await _apirest.LoadTemplate(name);
    templateCache.set(name, tpl ?? null);
    return templateCache.get(name);
  }

  const modalpage = document.getElementById('modalpage');
  modalpage.innerHTML = '';
  _ui.Reset();
  const container = document.createElement('div');
  container.className = 'suggest-panel';

  const close = function() {
    clearModalCancel();
    modalpage.classList.remove('modalpage-visible');
  };

  // Escape / backdrop dismissal falls back to an empty default view so the app
  // is never left blank.
  const dismiss = async function() {
    close();
    await _resetState(_state, {
      title: 'Vue_' + Date.now(),
      variables: { commits: new Map(), subtasks: new Map(), campaigns: new Map(), metrics: new Map() },
    }, null);
    _enableMainUI(true);
  };

  function effectiveDefined() {
    const d = parseURLVariables(pendingParams);
    if (pendingC2 && !d.commits.includes('c2')) d.commits.push('c2');
    return d;
  }

  async function loadResult(tpl, name) {
    close();
    await _resetState(_state, tpl, name);
    _enableMainUI(true);
  }

  // Clones the (cached) selected template and overlays the URL params + the
  // compare-with c2. Caller must ensure the template is loaded.
  function buildSelectedClone() {
    const clone = cloneTemplate(templateCache.get(selected.name));
    applyURLParamsToTemplate(clone, pendingParams, fullHashes);
    if (pendingC2 && clone.variables.commits instanceof Map) {
      clone.variables.commits.set('c2', { value: pendingC2.value, alias: pendingC2.alias });
    }
    return clone;
  }

  // ── Render ──────────────────────────────────────────────────
  function render() {
    container.innerHTML = '';
    container.appendChild(_ui.CreateTitle('Open from link', 'h3'));

    const intro = document.createElement('p');
    intro.className = 'suggest-intro';
    intro.textContent = 'Select a template and pick a commit to compare to if wanted.';
    container.appendChild(intro);

    // ── Variables from the link ──
    const varsTitle = document.createElement('div');
    varsTitle.className = 'suggest-section-title';
    varsTitle.textContent = 'Variables from this link';
    container.appendChild(varsTitle);

    const chips = document.createElement('div');
    chips.className = 'suggest-var-chips';
    const defined = parseURLVariables(pendingParams);
    const definedVars = buildVariablesFromParams(pendingParams, fullHashes);
    let chipCount = 0;
    for (const cat of ['commits', 'subtasks', 'campaigns', 'metrics']) {
      for (const name of defined[cat]) {
        const entry = definedVars[cat].get(name);
        chips.appendChild(buildChip(name, describeVarValue(cat, entry), () => {
          pendingParams.delete(name);
          pendingParams.delete(`${name}.alias`);
          // The compare-with c2 is resolved relative to c1; if c1 is removed,
          // drop the dangling comparator so it can't be loaded without a base.
          if (name === 'c1') pendingC2 = null;
          render();
        }));
        chipCount++;
      }
    }
    if (chipCount === 0) {
      const none = document.createElement('span');
      none.className = 'suggest-empty';
      none.textContent = 'No variables — all removed.';
      chips.appendChild(none);
    }
    container.appendChild(chips);

    // ── Compare with (only when c1 is the sole commit defined variable, others can be) ──
    // The c2 comparator lives here as a toggle group: at most one selected,
    // and clicking the active option again clears it back to none.
    const onlyC1 = defined.commits.length === 1 && defined.commits[0] === 'c1';
    if (onlyC1) {
      const c1 = pendingParams.get('c1');
      const cmpTitle = document.createElement('div');
      cmpTitle.className = 'suggest-section-title';
      cmpTitle.textContent = 'Compare with commit on branch';
      container.appendChild(cmpTitle);

      const compare_helper = document.createElement('p');
      compare_helper.className = 'suggest-compare-helper';
      compare_helper.textContent = 'main tip / dev tip: the latest commit on that branch. dev base: the dev commit this branch started from. If a commit has no Perf run, the next older one with a run is used.';
      container.appendChild(compare_helper);

      const row = document.createElement('div');
      row.className = 'suggest-compare-row';

      // main tip / dev tip resolve synchronously from the history; dev base may
      // need an async git-log lookup, so it resolves on click.
      const mainTip = CommitHelp.ResolveBranchTip('main', commits, perfByShort);
      const devTip  = CommitHelp.ResolveBranchTip('dev',  commits, perfByShort);
      const opts = [
        { id: 'main', label: 'main tip', alias: 'main', value: mainTip, async: false },
        { id: 'dev',  label: 'dev tip',  alias: 'dev',  value: devTip,  async: false },
        { id: 'base', label: 'dev base', alias: 'base', value: null,    async: true  },
      ];
      for (const o of opts) {
        const btn = document.createElement('button');
        const active = pendingC2?.source === o.id;
        btn.className = 'suggest-compare-btn' + (active ? ' selected' : '');
        btn.textContent = o.label;
        const enabled = o.async ? !!(c1 && gitHistory) : !!o.value;
        if (!enabled) {
          btn.disabled = true;
          btn.title = 'Not available in git history';
        } else if (o.async) {
          if (active) btn.onclick = () => { pendingC2 = null; render(); };
          else btn.onclick = async () => {
            const value = await CommitHelp.ResolveDevBase(c1, dynCtx);
            if (!value) { _errorManager.Error('Could not resolve a dev base for this commit.'); return; }
            pendingC2 = { value, alias: o.alias, source: o.id };
            render();
          };
        } else {
          btn.title = `c2 = ${CommitHelp.ShortHash(o.value)}`;
          btn.onclick = () => {
            pendingC2 = active ? null : { value: o.value, alias: o.alias, source: o.id };
            render();
          };
        }
        row.appendChild(btn);
      }
      container.appendChild(row);
    }

    // ── Matching templates ──
    const eff = effectiveDefined();
    const matches = catalog.filter(t => templateMatches(t.vars, eff));
    if (selected && !matches.some(m => m.name === selected.name)) selected = null;
    // Default to the first match so a preview shows immediately.
    if (!selected && matches.length) selected = matches[0];

    const tplTitle = document.createElement('div');
    tplTitle.className = 'suggest-section-title';
    tplTitle.textContent = `Matching templates (${matches.length})`;
    container.appendChild(tplTitle);

    const listBox = document.createElement('div');
    listBox.className = 'suggest-template-list';
    if (matches.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'suggest-empty';
      empty.textContent = 'No saved template defines these variables.';
      listBox.appendChild(empty);
    } else {
      for (const m of matches) {
        const rowBtn = document.createElement('button');
        rowBtn.className = 'suggest-template-row' + (selected?.name === m.name ? ' selected' : '');
        rowBtn.textContent = m.name;
        rowBtn.onclick = () => { selected = m; render(); };
        listBox.appendChild(rowBtn);
      }
    }
    container.appendChild(listBox);

    // ── Preview of the selected template ──
    if (selected) {
      const prevTitle = document.createElement('div');
      prevTitle.className = 'suggest-section-title';
      prevTitle.textContent = `Preview · ${selected.name}`;
      container.appendChild(prevTitle);

      const preview = document.createElement('div');
      preview.className = 'suggest-preview';

      if (!templateCache.has(selected.name)) {
        // Not loaded yet — show a placeholder and fetch, then re-render.
        const loading = document.createElement('p');
        loading.className = 'suggest-empty';
        loading.textContent = 'Loading preview…';
        preview.appendChild(loading);
        ensureTpl(selected.name).then(render);
      } else if (!templateCache.get(selected.name)) {
        const failed = document.createElement('p');
        failed.className = 'suggest-empty';
        failed.textContent = 'Failed to load this template.';
        preview.appendChild(failed);
      } else {
        const clone = buildSelectedClone();
        for (const cat of ['commits', 'subtasks', 'campaigns', 'metrics']) {
          const map = clone.variables[cat];
          if (!(map instanceof Map)) continue;
          for (const [name, entry] of map) {
            let tagText, tagClass;
            if (name === 'c2' && pendingC2) {
              tagText = 'compare with'; tagClass = 'compare';
            } else if (pendingParams.has(name)) {
              tagText = 'from link'; tagClass = 'from-url';
            } else {
              tagText = 'template default'; tagClass = 'from-template';
            }
            const pr = document.createElement('div');
            pr.className = 'suggest-preview-row';
            const nm = document.createElement('span');
            nm.className = 'suggest-preview-name';
            nm.textContent = name;
            const vl = document.createElement('span');
            vl.className = 'suggest-preview-value';
            vl.textContent = describeVarValue(cat, entry);
            const tag = document.createElement('span');
            tag.className = 'suggest-source-tag ' + tagClass;
            tag.textContent = tagText;
            pr.append(nm, vl, tag);
            preview.appendChild(pr);
          }
        }
      }
      container.appendChild(preview);
    }

    // ── Actions ──
    const actions = document.createElement('div');
    actions.className = 'modal-actions';

    const loadBtn = document.createElement('button');
    loadBtn.className = 'modal-button-ok';
    loadBtn.textContent = 'Load template';
    // Enabled only once the selected template's full definition is loaded.
    loadBtn.disabled = !selected || !templateCache.get(selected.name);
    loadBtn.onclick = () => loadResult(buildSelectedClone(), selected.name);
    actions.appendChild(loadBtn);

    const blankBtn = document.createElement('button');
    blankBtn.className = 'modal-button-cancel';
    blankBtn.textContent = 'Continue without a template';
    blankBtn.onclick = () => {
      const vars = buildVariablesFromParams(pendingParams, fullHashes);
      if (pendingC2) vars.commits.set('c2', { value: pendingC2.value, alias: pendingC2.alias });
      loadResult({ title: 'Vue_' + Date.now(), variables: vars }, null);
    };
    actions.appendChild(blankBtn);

    container.appendChild(actions);
  }

  function buildChip(name, valueText, onDelete) {
    const chip = document.createElement('span');
    chip.className = 'suggest-var-chip';
    const label = document.createElement('span');
    label.textContent = `${name} = ${valueText}`;
    const del = document.createElement('button');
    del.className = 'suggest-chip-del';
    del.textContent = ICONS.CLOSE;
    del.title = 'Remove this variable';
    del.onclick = onDelete;
    chip.append(label, del);
    return chip;
  }

  render();
  setModalCancel(dismiss);
  modalpage.appendChild(container);
  modalpage.classList.add('modalpage-visible');
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
