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


const state = {
  title: 'No Title_' + Date.now(),
  graphSettings: new Map(),
  variables: {
    experiments: new Map(),
    metrics: new Map(),
  },
  commitRegistry: new Map(),
};

// ============================================================
// STATE MANAGEMENT
// ============================================================

async function ResetState(state, newState) {
  graphManager.DelAllGraph();
  state.title          = newState?.title          ?? 'Vue_' + Date.now();
  state.graphSettings  = new Map();
  state.variables      = newState?.variables      ?? { experiments: new Map(), metrics: new Map() };
  state.commitRegistry = newState?.commitRegistry ?? new Map();
  UpdateHeader();
  if (newState?.graphSettings?.size > 0) {
    await restoreGraphs(newState.graphSettings);
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
    // Resolve concrete ExperimentDef entries (skip unresolvable VarRefs)
    const resolved = graphConfig.experiments
      .map(slot => {
        if ('variable' in slot) return state.variables.experiments.get(slot.variable) ?? null;
        return (slot.commit && slot.type && slot.subject) ? slot : null;
      })
      .filter(Boolean);

    if (resolved.length === 0) {
      // All experiment variables unresolved (template with null vars) — render placeholders
      // so the config is tracked in state.graphSettings for later variable resolution.
      const id = await graphManager.AddGraph(graphConfig, new Map());
      state.graphSettings.set(id, graphConfig);
      continue;
    }

    // Resolve MetricVarRef entries before fetching
    const resolvedMetrics = graphConfig.metrics
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
      .filter(Boolean);

    if (resolvedMetrics.length === 0) {
      // All metric variables unresolved — render placeholders.
      const id = await graphManager.AddGraph(graphConfig, new Map());
      state.graphSettings.set(id, graphConfig);
      continue;
    }

    const results = await Promise.all(
      resolved.map(exp => apirest.LoadCommitMetricsValues(
        exp.type, exp.commit, exp.subject,
        graphConfig.min, graphConfig.max, graphConfig.delta,
        resolvedMetrics
      ))
    );

    const dataMap = new Map(
      resolved
        .map((exp, i) => ({ exp, data: results[i] }))
        .filter(p => p.data != null)
        .map(p => [`${p.exp.commit}:${p.exp.type}:${p.exp.subject}`, p.data])
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

  // Pre-load all available commits (both Perf and Vuln) for the commit dropdown
  const [perfCommits, vulnCommits] = await Promise.all([
    apirest.LoadCommits('Perf'),
    apirest.LoadCommits('Vuln'),
  ]);
  const allCommits = [...new Set([...perfCommits, ...vulnCommits])];

  // Each slot: { mode: 'manual'|'variable', commit, type, subjects, subject, varName }
  const slots = prefill
    ? prefill.experiments.map(expSlot =>
        'variable' in expSlot
          ? { mode: 'variable', varName: expSlot.variable, commit: '', type: '', subjects: [], subject: '' }
          : { mode: 'manual', commit: expSlot.commit, type: expSlot.type, subjects: [], subject: expSlot.subject }
      )
    : [createEmptySlot()];
  let metricsMode = prefill?.metricsMode ?? 'AND';
  let selectedMetrics = [];
  let metricsPrefilled = false;
  let metricsUIContainer = null;
  let timeID = null;
  let btOk = null;
  let metricsRebuildGen = 0;  // incremented each call; stale async results are discarded

  function createEmptySlot() {
    return { mode: 'manual', commit: '', type: '', subjects: [], subject: '' };
  }

  // Returns ExperimentDef for a slot, or null if incomplete
  function resolveSlot(slot) {
    if (slot.mode === 'variable') {
      const def = state.variables.experiments.get(slot.varName) ?? null;
      return def;
    }
    if (slot.commit && slot.type && slot.subject) {
      return { commit: slot.commit, type: slot.type, subject: slot.subject };
    }
    return null;
  }

  function resolvedSlots() {
    return slots.map(resolveSlot).filter(Boolean);
  }

  const modalpage = document.getElementById('modalpage');
  modalpage.innerHTML = '';

  const container = document.createElement('div');
  ui.Reset();

  // ── Section 1: Experiments ──────────────────────────────────────
  container.appendChild(ui.CreateTitle(editId !== null ? 'Edit graph' : '1. Experiments', 'h3', null));
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

  // Pre-fill time range when editing an existing graph.
  // Use querySelector on `time` directly: `container` is not yet in the document at this point.
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

        // Register new experiments into commitRegistry (keyed by commit:type:subject)
        for (const exp of resolved) {
          const expKey = `${exp.commit}:${exp.type}:${exp.subject}`;
          if (!state.commitRegistry.has(expKey)) {
            const color = COMMIT_PALETTE[state.commitRegistry.size % COMMIT_PALETTE.length];
            state.commitRegistry.set(expKey, { color, displayName: null });
          }
        }

        // Resolve metric variable references before fetching (keep selectedMetrics as-is for storage)
        const fetchMetrics = selectedMetrics.map(m => {
          if (typeof m === 'string') {
            try {
              const parsed = JSON.parse(m);
              if (parsed?.variable) return state.variables.metrics.get(parsed.variable) ?? null;
            } catch (_) {}
          }
          return m;
        }).filter(m => m != null);

        if (fetchMetrics.length === 0) {
          BuildSidebar(state);
          clearModalCancel();
          modalpage.classList.remove('modalpage_visible');
          EnableMainUI(true);
          return;
        }

        // Fetch data for all resolved experiments in parallel
        const results = await Promise.all(
          resolved.map(exp => apirest.LoadCommitMetricsValues(
            exp.type, exp.commit, exp.subject, min, max, delta, fetchMetrics))
        );
        const validPairs = resolved
          .map((exp, i) => ({ exp, data: results[i] }))
          .filter(p => p.data != null);

        if (validPairs.length === 0) {
          // All fetches failed — nothing to render
        } else {
          // When editing, preserve existing toggle states; for new graphs use defaults
          const graphConfig = {
            experiments: slots
              .filter(s => s.mode === 'variable' || (s.commit && s.type && s.subject))
              .map(s => s.mode === 'variable'
                ? { variable: s.varName }
                : { commit: s.commit, type: s.type, subject: s.subject }
              ),
            metricsMode,
            metrics: selectedMetrics,
            min, max, delta,
            showRaw: prefill ? prefill.showRaw : (validPairs.length === 1),
            showCI:  prefill ? prefill.showCI  : false,   // off by default for new graphs
            splitAxes: prefill ? prefill.splitAxes : true,
          };

          const dataMap = new Map(
            validPairs.map(p => [`${p.exp.commit}:${p.exp.type}:${p.exp.subject}`, p.data])
          );

          if (editId !== null) {
            // Editing an existing graph: update in place
            state.graphSettings.set(editId, graphConfig);
            await graphManager.UpdateGraph(editId, graphConfig, dataMap);
          } else {
            // Creating a new graph
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

      if (slot.mode === 'manual') {
        renderManualRow(row, slot, idx);
      } else {
        renderVariableRow(row, slot, idx);
      }

      // Remove button (always shown; disabled when only 1 slot)
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

  function renderManualRow(row, slot, idx) {
    // All three elements declared first; cross-referencing callbacks attached below.

    // Commit select (simple <select>, single-selection per slot)
    const commitSelect = ui.CreateSelect(
      [{ value: '', text: 'Commit\u2026' }].concat(
        allCommits.map(c => ({ value: c, text: CommitHelp.ShortHash(c), selected: c === slot.commit }))
      ), null
    );
    row.appendChild(commitSelect);

    // Enrich labels once git history resolves (shows branch + date)
    gitHistory.then(function(history) {
      if (!history) return;
      const enriched = CommitHelp.Enrich(allCommits, history);
      const labelMap = new Map(enriched.map(e => [e.hash, e.label]));
      ui.UpdateSelect(commitSelect,
        [{ value: '', text: 'Commit\u2026' }].concat(
          enriched.map(e => ({ value: e.hash, text: e.label, selected: e.hash === slot.commit }))
        )
      );
    });

    // Type select
    const typeSelect = ui.CreateSelect([
      { value: '', text: 'Type\u2026' },
      { value: 'Perf', selected: slot.type === 'Perf' },
      { value: 'Vuln', selected: slot.type === 'Vuln' },
    ], null);
    if (!slot.commit) UI.DisableElement(typeSelect);

    // Subject select
    const subjectSelect = ui.CreateSelect(
      [{ value: '', text: 'Subject\u2026' }].concat(
        slot.subjects.map(s => ({ value: s.value, text: s.text, selected: s.value === slot.subject }))
      ), null
    );
    if (!slot.type || slot.subjects.length === 0) UI.DisableElement(subjectSelect);

    // Commit change
    commitSelect.onchange = function() {
      const newCommit = commitSelect.value;
      if (newCommit === slot.commit) return;
      slot.commit = newCommit;
      slot.type = '';
      slot.subjects = [];
      slot.subject = '';
      ui.UpdateSelect(typeSelect, [
        { value: '', text: 'Type\u2026' },
        { value: 'Perf' },
        { value: 'Vuln' },
      ]);
      UI.DisableElement(typeSelect);
      ui.UpdateSelect(subjectSelect, [{ value: '', text: 'Subject\u2026' }]);
      UI.DisableElement(subjectSelect);
      if (newCommit) UI.EnableElement(typeSelect);
      onExperimentChange();
    };

    typeSelect.onchange = async function() {
      const newType = typeSelect.value;
      if (newType === slot.type) return;
      slot.type = newType;
      slot.subjects = [];
      slot.subject = '';
      ui.UpdateSelect(subjectSelect, [{ value: '', text: 'Subject\u2026' }]);
      UI.DisableElement(subjectSelect);
      onExperimentChange();
      if (!newType || !slot.commit) return;
      UI.DisableElement(typeSelect);
      const subjects = await apirest.LoadCommitSubjects(newType, slot.commit);
      UI.EnableElement(typeSelect);
      slot.subjects = subjects;
      if (subjects.length === 0) return;
      ui.UpdateSelect(subjectSelect,
        [{ value: '', text: 'Subject\u2026' }].concat(subjects.map(s => ({ value: s.value, text: s.text })))
      );
      UI.EnableElement(subjectSelect);
    };

    subjectSelect.onchange = function() {
      slot.subject = subjectSelect.value;
      onExperimentChange();
    };

    row.appendChild(typeSelect);
    row.appendChild(subjectSelect);

    // Pre-fill: if slot has commit+type but subjects not yet loaded, trigger async load
    if (slot.commit && slot.type && slot.subjects.length === 0 && slot.subject) {
      UI.DisableElement(typeSelect);
      apirest.LoadCommitSubjects(slot.type, slot.commit).then(function(subjects) {
        UI.EnableElement(typeSelect);
        slot.subjects = subjects;
        if (subjects.length > 0) {
          ui.UpdateSelect(subjectSelect,
            [{ value: '', text: 'Subject\u2026' }].concat(
              subjects.map(s => ({ value: s.value, text: s.text, selected: s.value === slot.subject }))
            )
          );
          UI.EnableElement(subjectSelect);
        }
      });
    }

    // Switch to variable mode (only if variables exist)
    if (state.variables.experiments.size > 0) {
      const varBtn = document.createElement('button');
      varBtn.className = 'experiment-var-toggle';
      varBtn.textContent = 'Var';
      varBtn.title = 'Switch to variable mode';
      varBtn.onclick = function() {
        slot.mode = 'variable';
        slot.varName = state.variables.experiments.keys().next().value;
        renderExperiments();
        onExperimentChange();
      };
      row.appendChild(varBtn);
    }
  }

  function renderVariableRow(row, slot, idx) {
    const varSelect = ui.CreateSelect(
      Array.from(state.variables.experiments.entries()).map(([name, def]) => ({
        value: name,
        text: def ? `${name} (= ${def.commit.slice(0, 7)}/${def.type}/${def.subject})` : `${name} (undefined)`,
        selected: name === slot.varName,
      })), null
    );
    varSelect.onchange = function() {
      slot.varName = varSelect.value;
      onExperimentChange();
    };
    row.appendChild(varSelect);

    // Switch back to manual mode
    const manualBtn = document.createElement('button');
    manualBtn.className = 'experiment-var-toggle';
    manualBtn.textContent = 'Manuel';
    manualBtn.title = 'Switch to manual mode';
    manualBtn.onclick = function() {
      slot.mode = 'manual';
      slot.commit = '';
      slot.type = '';
      slot.subjects = [];
      slot.subject = '';
      renderExperiments();
      onExperimentChange();
    };
    row.appendChild(manualBtn);
  }

  function onExperimentChange() {
    rebuildMetricsUI();
    updateOkButton();
  }

  async function rebuildMetricsUI() {
    const previousMetrics = [...selectedMetrics];  // preserve across experiment changes
    selectedMetrics = [];
    if (metricsUIContainer) {
      metricsUIContainer.remove();
      metricsUIContainer = null;
    }
    updateOkButton();

    const resolved = resolvedSlots();
    if (resolved.length === 0) return;

    const gen = ++metricsRebuildGen;

    // Load metrics for each resolved experiment
    const metricsResults = await Promise.all(
      resolved.map(exp => apirest.LoadCommitMetrics(exp.type, exp.commit, exp.subject))
    );

    if (gen !== metricsRebuildGen) return;  // a newer call was started; discard this result

    const pathSets = metricsResults.map(flattenMetricPaths);

    // Build union and intersection
    const union = new Set();
    for (const s of pathSets) s.forEach(p => union.add(p));
    const intersection = pathSets.reduce((acc, s) => {
      return new Set([...acc].filter(p => s.has(p)));
    }, new Set(union));

    // Metrics absent from at least one experiment (union \ intersection)
    const absentPaths = new Set([...union].filter(p => !intersection.has(p)));

    // Build a synthetic metrics object for CreateMetrics
    const displayPaths = metricsMode === 'AND' ? intersection : union;
    const syntheticMetrics = buildSyntheticMetrics(displayPaths);

    if (!syntheticMetrics.metrics || syntheticMetrics.metrics.size === 0) return;

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

    // Variable metrics section (if any) — wrapped together with metricsTree for easy cleanup
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

    // Update time range from first resolved experiment — skip if prefill already set it
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

    // Restore metrics: prefill on first call, or keep previously selected ones.
    // Making the label visible is required because all labels start hidden (folder closed).
    const toRestore = (prefill && !metricsPrefilled) ? prefill.metrics : previousMetrics;
    if (toRestore.length > 0) {
      metricsWrapper.querySelectorAll('.metric-checkbox').forEach(function(cb) {
        if (toRestore.includes(cb.value) && !cb.checked) {
          cb.checked = true;
          cb.closest('.checkbox-label').style.display = '';  // always show selected metrics
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

// Returns true if any graph's experiments or metrics reference the given variable name.
function isVarReferenced(state, varName) {
  for (const [, config] of state.graphSettings) {
    if (config.experiments.some(s => s.variable === varName)) return true;
    if (config.metrics.some(m => {
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

  sidebar.appendChild(buildVariableSection(
    'Experiments',
    state.variables.experiments,
    (name, def) => openExperimentVarModal(name, def, state),
    (name) => {
      state.variables.experiments.set(name, null);
      BuildSidebar(state);
    },
    (name) => {
      if (isVarReferenced(state, name)) {
        errorManager.Error(`Variable "${name}" est utilisée par un ou plusieurs graphes — retirez-la des graphes avant de la supprimer.`);
        return;
      }
      state.variables.experiments.delete(name);
      BuildSidebar(state);
    },
    'e',
    (def) => def ? `${def.commit.substring(0, 7)} \u00b7 ${def.type} \u00b7 ${def.subject}` : '(undefined)'
  ));

  sidebar.appendChild(buildVariableSection(
    'Métriques',
    state.variables.metrics,
    (name, val) => openMetricVarModal(name, val, state),
    (name) => {
      state.variables.metrics.set(name, null);
      BuildSidebar(state);
    },
    (name) => {
      if (isVarReferenced(state, name)) {
        errorManager.Error(`Variable "${name}" est utilisée par un ou plusieurs graphes — retirez-la des graphes avant de la supprimer.`);
        return;
      }
      state.variables.metrics.delete(name);
      BuildSidebar(state);
    },
    'm',
    (val) => val || '(undefined)'
  ));

  sidebar.appendChild(buildExperimentLegend(state));
}

function buildVariableSection(title, varMap, onEdit, onAdd, onDelete, prefix, formatValue) {
  const section = document.createElement('div');
  section.className = 'sidebar-section';

  const header = document.createElement('div');
  header.className = 'sidebar-section-title';
  header.textContent = title;

  const addBtn = document.createElement('button');
  addBtn.className = 'sidebar-add-btn';
  addBtn.textContent = '+';
  addBtn.title = `Ajouter une variable ${prefix}`;
  addBtn.addEventListener('click', () => {
    let n = 1;
    while (varMap.has(`${prefix}${n}`)) n++;
    onAdd(`${prefix}${n}`);
  });
  header.appendChild(addBtn);
  section.appendChild(header);

  for (const [name, value] of varMap) {
    const card = document.createElement('div');
    card.className = 'sidebar-variable-card';

    const cardHeader = document.createElement('div');
    cardHeader.className = 'sidebar-variable-header';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'sidebar-variable-name';
    nameSpan.textContent = name;

    const delBtn = document.createElement('button');
    delBtn.className = 'sidebar-delete-btn';
    delBtn.textContent = '\u2715';
    delBtn.title = 'Supprimer la variable';
    delBtn.addEventListener('click', () => onDelete(name));

    cardHeader.appendChild(nameSpan);
    cardHeader.appendChild(delBtn);

    const pill = document.createElement('button');
    pill.className = `sidebar-pill${value === null ? ' undefined' : ''}`;
    pill.textContent = formatValue(value);
    pill.title = 'Cliquer pour modifier';
    pill.addEventListener('click', () => onEdit(name, value));

    card.appendChild(cardHeader);
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
      let def = slot;
      if ('variable' in slot) def = state.variables.experiments.get(slot.variable) ?? null;
      if (def?.commit && def.type && def.subject) {
        keys.add(`${def.commit}:${def.type}:${def.subject}`);
      }
    }
  }
  return keys;
}

function buildExperimentLegend(state) {
  const section = document.createElement('div');
  section.className = 'sidebar-section';

  const header = document.createElement('div');
  header.className = 'sidebar-section-title';
  header.textContent = 'Légende experiments';
  section.appendChild(header);

  const activeKeys = getActiveExperimentKeys(state);

  if (activeKeys.size === 0) {
    const empty = document.createElement('p');
    empty.style.cssText = 'font-size:0.75rem;color:#aaa;font-style:italic;margin:0';
    empty.textContent = 'Aucun experiment chargé';
    section.appendChild(empty);
    return section;
  }

  for (const expKey of activeKeys) {
    const entry = state.commitRegistry.get(expKey);
    if (!entry) continue;
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
    colorInput.title = 'Changer la couleur';
    colorInput.addEventListener('input', (e) => {
      entry.color = e.target.value;
      refreshGraphsUsingExperiment(state, expKey);
    });

    const identSpan = document.createElement('span');
    identSpan.className = 'commit-legend-ident';
    identSpan.title = expKey;
    identSpan.textContent = `${commitShort} · ${type} · ${subject}`;

    topLine.appendChild(colorInput);
    topLine.appendChild(identSpan);

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'commit-legend-name';
    nameInput.placeholder = 'Nom d\'affichage\u2026';
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

// Returns graph IDs whose resolved experiments match the given expKey ("commit:type:subject").
function getGraphIDsUsingExperiment(state, expKey) {
  const ids = [];
  for (const [id, config] of state.graphSettings) {
    for (const slot of config.experiments) {
      let def = slot;
      if ('variable' in slot) {
        def = state.variables.experiments.get(slot.variable) ?? null;
      }
      if (def && `${def.commit}:${def.type}:${def.subject}` === expKey) { ids.push(id); break; }
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
    const usesVar = config.experiments.some(s => s.variable === varName)
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
    .map(slot => {
      if ('variable' in slot) return state.variables.experiments.get(slot.variable) ?? null;
      return (slot.commit && slot.type && slot.subject) ? slot : null;
    })
    .filter(Boolean);
  if (resolved.length === 0) return;

  const resolvedMetrics = config.metrics
    .map(m => {
      if (typeof m === 'string') {
        try {
          const parsed = JSON.parse(m);
          if (parsed?.variable) return state.variables.metrics.get(parsed.variable) ?? null;
        } catch (_) {}
      }
      return m;
    })
    .filter(m => m != null);
  if (resolvedMetrics.length === 0) return;

  const results = await Promise.all(
    resolved.map(exp => apirest.LoadCommitMetricsValues(
      exp.type, exp.commit, exp.subject,
      config.min, config.max, config.delta,
      resolvedMetrics
    ))
  );

  const dataMap = new Map(
    resolved
      .map((exp, i) => ({ exp, data: results[i] }))
      .filter(p => p.data != null)
      .map(p => [`${p.exp.commit}:${p.exp.type}:${p.exp.subject}`, p.data])
  );

  if (dataMap.size === 0) return;
  await graphManager.UpdateGraph(id, config, dataMap);
}

// Opens a mini-modal to define or edit an experiment variable.
async function openExperimentVarModal(name, currentDef, state) {
  EnableMainUI(false);

  const [perfCommits, vulnCommits] = await Promise.all([
    apirest.LoadCommits('Perf'),
    apirest.LoadCommits('Vuln'),
  ]);
  const allCommits = [...new Set([...perfCommits, ...vulnCommits])];
  const gitHistory = gitHistoryPromise;

  const slot = currentDef
    ? { commit: currentDef.commit, type: currentDef.type, subjects: [], subject: currentDef.subject }
    : { commit: '', type: '', subjects: [], subject: '' };

  const modalpage = document.getElementById('modalpage');
  modalpage.innerHTML = '';
  const container = document.createElement('div');
  ui.Reset();

  container.appendChild(ui.CreateTitle(`Variable\u00a0: ${name}`, 'h3', null));

  const row = document.createElement('div');
  row.className = 'experiment-row';

  const commitSelect = ui.CreateSelect(
    [{ value: '', text: 'Commit\u2026' }].concat(
      allCommits.map(c => ({ value: c, text: CommitHelp.ShortHash(c), selected: c === slot.commit }))
    ), null
  );
  row.appendChild(commitSelect);

  gitHistory.then(function(history) {
    if (!history) return;
    const enriched = CommitHelp.Enrich(allCommits, history);
    ui.UpdateSelect(commitSelect,
      [{ value: '', text: 'Commit\u2026' }].concat(
        enriched.map(e => ({ value: e.hash, text: e.label, selected: e.hash === slot.commit }))
      )
    );
  });

  const typeSelect = ui.CreateSelect([
    { value: '', text: 'Type\u2026' },
    { value: 'Perf', selected: slot.type === 'Perf' },
    { value: 'Vuln', selected: slot.type === 'Vuln' },
  ], null);
  if (!slot.commit) UI.DisableElement(typeSelect);
  row.appendChild(typeSelect);

  const subjectSelect = ui.CreateSelect(
    [{ value: '', text: 'Subject\u2026' }].concat(
      slot.subjects.map(s => ({ value: s.value, text: s.text, selected: s.value === slot.subject }))
    ), null
  );
  if (!slot.type || slot.subjects.length === 0) UI.DisableElement(subjectSelect);
  row.appendChild(subjectSelect);

  let btOk = null;

  function updateOk() {
    if (!btOk) return;
    if (slot.commit && slot.type && slot.subject) UI.EnableElement(btOk);
    else UI.DisableElement(btOk);
  }

  commitSelect.onchange = function() {
    slot.commit = commitSelect.value;
    slot.type = '';
    slot.subjects = [];
    slot.subject = '';
    ui.UpdateSelect(typeSelect, [
      { value: '', text: 'Type\u2026' },
      { value: 'Perf' },
      { value: 'Vuln' },
    ]);
    UI.DisableElement(typeSelect);
    ui.UpdateSelect(subjectSelect, [{ value: '', text: 'Subject\u2026' }]);
    UI.DisableElement(subjectSelect);
    if (slot.commit) UI.EnableElement(typeSelect);
    updateOk();
  };

  typeSelect.onchange = async function() {
    slot.type = typeSelect.value;
    slot.subjects = [];
    slot.subject = '';
    ui.UpdateSelect(subjectSelect, [{ value: '', text: 'Subject\u2026' }]);
    UI.DisableElement(subjectSelect);
    updateOk();
    if (!slot.type || !slot.commit) return;
    UI.DisableElement(typeSelect);
    try {
      const subjects = await apirest.LoadCommitSubjects(slot.type, slot.commit);
      slot.subjects = subjects;
      if (subjects.length === 0) return;
      ui.UpdateSelect(subjectSelect,
        [{ value: '', text: 'Subject\u2026' }].concat(subjects.map(s => ({ value: s.value, text: s.text })))
      );
      UI.EnableElement(subjectSelect);
    } finally {
      UI.EnableElement(typeSelect);
    }
  };

  subjectSelect.onchange = function() {
    slot.subject = subjectSelect.value;
    updateOk();
  };

  // Pre-fill subjects if editing an existing def
  if (slot.commit && slot.type && slot.subjects.length === 0 && slot.subject) {
    UI.DisableElement(typeSelect);
    apirest.LoadCommitSubjects(slot.type, slot.commit).then(function(subjects) {
      slot.subjects = subjects;
      if (subjects.length > 0) {
        ui.UpdateSelect(subjectSelect,
          [{ value: '', text: 'Subject\u2026' }].concat(
            subjects.map(s => ({ value: s.value, text: s.text, selected: s.value === slot.subject }))
          )
        );
        UI.EnableElement(subjectSelect);
      }
    }).finally(() => UI.EnableElement(typeSelect));
  }

  container.appendChild(row);

  setModalCancel(function() {
    clearModalCancel();
    modalpage.classList.remove('modalpage_visible');
    EnableMainUI(true);
  });

  const actions = ui.CreateActions(true, {
    ok: {
      callback: function() {
        if (!slot.commit || !slot.type || !slot.subject) return;
        // Register experiment in registry (keyed by commit:type:subject)
        const expKey = `${slot.commit}:${slot.type}:${slot.subject}`;
        if (!state.commitRegistry.has(expKey)) {
          const color = COMMIT_PALETTE[state.commitRegistry.size % COMMIT_PALETTE.length];
          state.commitRegistry.set(expKey, { color, displayName: null });
        }
        state.variables.experiments.set(name, { commit: slot.commit, type: slot.type, subject: slot.subject });
        refreshGraphsUsingVariable(state, name);
        BuildSidebar(state);
        clearModalCancel();
        modalpage.classList.remove('modalpage_visible');
        EnableMainUI(true);
      },
      className: 'exp-var-ok-btn',
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
  btOk = container.querySelector('.exp-var-ok-btn');
  UI.DisableElement(btOk);
  updateOk();
  modalpage.classList.add('modalpage_visible');
}

// Opens a mini-modal to define or edit a metric variable (single selection).
async function openMetricVarModal(name, currentVal, state) {
  EnableMainUI(false);

  // Collect all unique resolved experiments across all graphs and variables
  const uniqueExps = new Map();
  for (const [, config] of state.graphSettings) {
    for (const slot of config.experiments) {
      let def = slot;
      if ('variable' in slot) def = state.variables.experiments.get(slot.variable) ?? null;
      if (def?.commit && def.type && def.subject) {
        uniqueExps.set(`${def.commit}:${def.type}:${def.subject}`, def);
      }
    }
  }
  for (const [, def] of state.variables.experiments) {
    if (def?.commit && def.type && def.subject) {
      uniqueExps.set(`${def.commit}:${def.type}:${def.subject}`, def);
    }
  }

  const experiments = Array.from(uniqueExps.values());
  const metricsResults = experiments.length > 0
    ? await Promise.all(experiments.map(exp => apirest.LoadCommitMetrics(exp.type, exp.commit, exp.subject)))
    : [];

  const union = new Set();
  for (const mr of metricsResults) flattenMetricPaths(mr).forEach(p => union.add(p));

  const modalpage = document.getElementById('modalpage');
  modalpage.innerHTML = '';
  const container = document.createElement('div');
  ui.Reset();

  container.appendChild(ui.CreateTitle(`Variable m\u00e9trique\u00a0: ${name}`, 'h3', null));

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
    msg.textContent = 'Aucune m\u00e9trique disponible. Ajoutez d\u2019abord des graphes avec des experiments r\u00e9solus.';
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
    title: 'Ouvrir une vue',
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
  for (const [name, def] of state.variables.experiments) {
    if (def) params.set(name, `${def.commit}:${def.type}:${def.subject}`);
  }
  for (const [name, val] of state.variables.metrics) {
    if (val) params.set(name, val);
  }
  return `${window.location.origin}${window.location.pathname}?${params.toString()}`;
}

function OpenTemplate(restoreUI = false) {
  buildFileListModal(restoreUI, {
    title: 'Ouvrir un template',
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
  const name = prompt('Nom du template :');
  if (!name?.trim()) return;
  const trimmedName = name.trim();

  const tpl = {
    title: state.title,
    variables: {
      experiments: new Map([...state.variables.experiments.keys()].map(k => [k, null])),
      metrics:     new Map([...state.variables.metrics.keys()].map(k => [k, null])),
    },
    graphSettings:  state.graphSettings,
    commitRegistry: state.commitRegistry,
  };

  const ok = await apirest.SaveTemplate(trimmedName, tpl);
  if (ok) errorManager.Success('Template saved: ' + trimmedName);
}

async function tryLoadTemplateFromURL() {
  const params = new URLSearchParams(window.location.search);
  const templateName = params.get('template');
  if (!templateName) return;

  // Clean URL immediately so a failed load doesn't loop on every reload.
  history.replaceState(null, '', window.location.pathname);

  const tpl = await apirest.LoadTemplate(templateName);
  if (!tpl) return;

  if (tpl.variables?.experiments instanceof Map) {
    for (const [name] of tpl.variables.experiments) {
      const raw = params.get(name);
      if (!raw) continue;
      // Split on first two colons only — subject may itself contain ':'
      const firstColon  = raw.indexOf(':');
      const secondColon = raw.indexOf(':', firstColon + 1);
      if (firstColon !== -1 && secondColon !== -1) {
        const commit  = raw.slice(0, firstColon);
        const type    = raw.slice(firstColon + 1, secondColon);
        const subject = raw.slice(secondColon + 1);
        tpl.variables.experiments.set(name, { commit, type, subject });
      }
    }
  }
  if (tpl.variables?.metrics instanceof Map) {
    for (const [name] of tpl.variables.metrics) {
      const raw = params.get(name);
      if (raw) tpl.variables.metrics.set(name, raw);
    }
  }

  await ResetState(state, tpl);
  EnableMainUI(true);
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
    <p>This dashboard visualises performance and vulnerability test results as interactive time-series graphs. Follow the steps below to explore your data.</p>

    <h3>1 — Getting started</h3>
    <p>Use the toolbar in the top-right header to manage views:</p>
    <ul>
      <li><strong>Ouvrir vue</strong> — open a saved view or start fresh (click <strong>New</strong> inside the dialog).</li>
      <li><strong>Nouvelle vue</strong> — jump directly to the view creator for a blank dashboard.</li>
    </ul>

    <h3>2 — View Creator</h3>
    <p>Select/fill four values in order — each step unlocks the next:</p>
    <ol>
      <li><strong>XP Type</strong> — choose <em>Perf</em> (performance) or <em>Vuln</em> (vulnerability).</li>
      <li><strong>Commit</strong> — select the commit to base available metrics and the default selection on.</li>
      <li><strong>Library (PUT)</strong> — pick the programme under test (benchmark name) for that commit.</li>
      <li><strong>View name</strong> — auto-generated from your selections; edit for a custom name.</li>
    </ol>
    <p>Click <strong>OK</strong> to confirm. A new view with those parameters will be created.</p>

    <h3>3 — Add a graph (+ Graphe)</h3>
    <p>Click <strong>+ Graphe</strong> in the toolbar to add a new graph panel. Four steps:</p>
    <ol>
      <li><strong>PUT</strong> — pre-selected from the global config; change to graph a different library.</li>
      <li><strong>Commit(s)</strong> — select one commit for a standard graph, or 2–4 commits to compare.</li>
      <li><strong>Metric(s)</strong> — browse the metric tree (click <strong>➕</strong> to expand a folder).</li>
      <li><strong>Time range</strong> — set Start, End, and Step in microseconds (µs). Smaller step = more detail, slower load.</li>
    </ol>

    <h3>4 — Graph controls</h3>
    <p>Each graph panel has controls in its title bar and a toggle row below:</p>
    <ul>
      <li><strong>✖</strong> (red) — delete the graph.</li>
      <li><strong>➖ / ➕</strong> — minimize or expand the plot area.</li>
      <li><strong>Split Y-Axes</strong> — give each metric its own Y-axis (useful for different scales).</li>
      <li><strong>All Runs</strong> — overlay individual run data as dotted lines.</li>
      <li><strong>Confidence Bands</strong> — show 95% confidence interval shading around means.</li>
    </ul>

    <h3>5 — Save and load</h3>
    <ul>
      <li><strong>Sauvegarder</strong> — saves the entire dashboard (all graphs and settings) under the title shown in the header.</li>
      <li>Click <strong>✏ Edit</strong> next to the title to rename before saving.</li>
      <li><strong>Ouvrir vue</strong> — lists all saved views; search, sort, load, or delete them.</li>
    </ul>

    <h3>Tips</h3>
    <ul>
      <li>CI bands use a 95% t-distribution confidence interval (Bessel-corrected variance).</li>
      <li>Hover over any graph for a unified tooltip showing all metric values at that time point.</li>
      <li>Hidden legend items are preserved when you toggle All Runs / Confidence Bands / Split Y-Axes.</li>
    </ul>

    <hr style="margin: 28px 0; border: none; border-top: 2px solid #e0e0e0;">

    <h3>Plain-language guide</h3>

    <h4 style="margin-top:16px; color:#555;">Starting from scratch</h4>
    <p>Click <strong>Ouvrir vue</strong> (top-right toolbar) to open a saved view, or <strong>Nouvelle vue</strong> to start a blank dashboard. The view ties together a test type, a code commit, and a benchmark library (PUT).</p>

    <h4 style="margin-top:16px; color:#555;">Setting up a view</h4>
    <p>Fill the four fields in order — each one unlocks the next. The name auto-fills once you pick a subject; change it if you want something more memorable.</p>

    <h4 style="margin-top:16px; color:#555;">Adding a graph</h4>
    <p>Click <strong>+ Graphe</strong>, choose the PUT, pick one or more commits, select your metrics, and set a time window. Two or more commits produces a comparison chart.</p>

    <h4 style="margin-top:16px; color:#555;">What the toggle buttons actually show you</h4>
    <ul>
      <li><strong>All Runs</strong> — shows every individual benchmark run as a faint dotted line. Wide spread = inconsistent results.</li>
      <li><strong>Confidence Bands</strong> — adds a shaded area around each mean. The wider the band, the less certain the result (95% CI).</li>
      <li><strong>Split Y-Axes</strong> — gives each metric its own vertical scale. Useful when comparing metrics with very different units or magnitudes.</li>
    </ul>
    <p>Clicking a trace name in the legend hides/shows it. That hidden state is preserved when you toggle the buttons above.</p>

    <h4 style="margin-top:16px; color:#555;">Saving and loading</h4>
    <p>Click <strong>Sauvegarder</strong> to save your dashboard. Click <strong>✏ Edit</strong> in the header to rename it first. Use <strong>Ouvrir vue</strong> to manage saved views: search, sort, load, or delete.</p>
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
  headerEditBtn.textContent = '\u270F Edit';
  headerEditBtn.dataset.editing = 'false';
}

headerEditBtn.onclick = function() {
  if (headerEditBtn.dataset.editing === 'true') {
    commitTitleEdit();
  } else {
    // Start editing
    headerEditInput = document.createElement('input');
    headerEditInput.type = 'text';
    headerEditInput.className = 'header-edit-input';
    headerEditInput.value = state.title;
    headerEditInput.onkeydown = function(e) {
      if (e.key === 'Enter') { headerEditBtn.onclick(); }
      if (e.key === 'Escape') {
        headerTitle.style.display = '';
        headerEditInput.remove();
        headerEditInput = null;
        headerEditBtn.textContent = '\u270F Edit';
        headerEditBtn.dataset.editing = 'false';
      }
    };
    headerTitle.style.display = 'none';
    headerTitle.insertAdjacentElement('afterend', headerEditInput);
    headerEditInput.focus();
    headerEditInput.select();
    headerEditBtn.textContent = '\u2714 Done';
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

const uiAddGraph = UI.CreateToolbarBtn('+ Graphe', 'Add a new graph');
uiAddGraph.onclick = function() {
  EnableMainUI(false);
  AddGraphique();
};
headerToolbar.appendChild(uiAddGraph);
UIElt.push(uiAddGraph);

const uiSaveView = UI.CreateToolbarBtn('Sauvegarder', 'Save the current view');
uiSaveView.onclick = function() {
  EnableMainUI(false);
  Save(state);
};
headerToolbar.appendChild(uiSaveView);
UIElt.push(uiSaveView);

const uiOpenView = UI.CreateToolbarBtn('Ouvrir vue', 'Open a saved view');
uiOpenView.onclick = function() {
  const restoreUI = !uiAddGraph.classList.contains('is-disabled');
  EnableMainUI(false);
  OpenView(restoreUI);
};
headerToolbar.appendChild(uiOpenView);

const uiNewView = UI.CreateToolbarBtn('Nouvelle vue', 'Create a new blank view');
uiNewView.onclick = function() {
  const restoreUI = !uiAddGraph.classList.contains('is-disabled');
  EnableMainUI(false);
  ConfigBaseInformations(restoreUI);
};
headerToolbar.appendChild(uiNewView);

const btnSidebar = UI.CreateToolbarBtn('\u229e Variables', 'Panneau Variables & Légende');
btnSidebar.addEventListener('click', () => {
  const sidebar = document.getElementById('sidebar');
  sidebar.classList.toggle('collapsed');
});
headerToolbar.appendChild(btnSidebar);
UIElt.push(btnSidebar);

const uiOpenTpl = UI.CreateToolbarBtn('Ouvrir template', 'Open a saved template');
uiOpenTpl.onclick = function() {
  const restoreUI = !uiAddGraph.classList.contains('is-disabled');
  EnableMainUI(false);
  OpenTemplate(restoreUI);
};
headerToolbar.appendChild(uiOpenTpl);
UIElt.push(uiOpenTpl);

const uiSaveTpl = UI.CreateToolbarBtn('Sauvegarder template', 'Save current view as template');
uiSaveTpl.onclick = function() {
  EnableMainUI(false);
  SaveAsTemplate(state).finally(() => EnableMainUI(true));
};
headerToolbar.appendChild(uiSaveTpl);
UIElt.push(uiSaveTpl);

const uiInfo = UI.CreateToolbarBtn('Aide', 'Help');
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

tryLoadTemplateFromURL();
console.log('done');
