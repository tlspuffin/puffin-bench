/**
 * Sidebar DOM builders and graph-refresh helpers.
 *
 * Call initSidebar(deps) once at startup before any sidebar function is used.
 */

import { ICONS, TASK_TYPES, DASH_PALETTE } from './constants.js';
import { UI } from './ui.js';
import {
  resolveExperimentSlot,
  resolveMetricEntry,
  nextCommitColor,
  getKnownSubtasks,
  globalDynamicSubtasks,
  setModalCancel,
  clearModalCancel,
  dedupSubtasks,
  isVarReferenced,
} from './state.js';

// ============================================================
// DEPENDENCY INJECTION
// ============================================================

let _graphManager = null;
let _apirest      = null;
let _ui           = null;
let _enableMainUI = null;
let _errorManager = null;
let _allCommitsPromise   = Promise.resolve([]);
let _gitHistoryPromise   = Promise.resolve(null);

/**
 * @param {{
 *   graphManager: object,
 *   apirest: object,
 *   ui: object,
 *   enableMainUI: (enabled: boolean) => void,
 *   errorManager: object,
 *   allCommitsPromise: Promise<string[]>,
 *   gitHistoryPromise: Promise<object|null>,
 * }} deps
 */
export function initSidebar(deps) {
  _graphManager      = deps.graphManager;
  _apirest           = deps.apirest;
  _ui                = deps.ui;
  _enableMainUI      = deps.enableMainUI;
  _errorManager      = deps.errorManager;
  _allCommitsPromise = deps.allCommitsPromise;
  _gitHistoryPromise = deps.gitHistoryPromise ?? Promise.resolve(null);
}

// ============================================================
// INTERNAL DOM HELPERS
// ============================================================

/** Creates a sidebar section div with a title header and an Add (+) button. */
function buildSidebarSection(title, addTitle, onAdd) {
  const section = document.createElement('div');
  section.className = 'sidebar-section';
  const header = document.createElement('div');
  header.className = 'sidebar-section-title';
  header.textContent = title;
  const addBtn = document.createElement('button');
  addBtn.className = 'sidebar-add-btn';
  addBtn.textContent = '+';
  addBtn.title = addTitle;
  addBtn.addEventListener('click', onAdd);
  header.appendChild(addBtn);
  section.appendChild(header);
  return section;
}

// ============================================================
// METRIC PATH UTILITIES  (also exported for dialogs.js)
// ============================================================

/** Flatten a nested metric Map ({ metrics: Map }) to a Set of leaf dot-paths. */
export function flattenMetricPaths(metricsObj) {
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

/** Build a nested Map from a flat Set of dot-paths, as expected by ui.CreateMetrics. */
export function buildSyntheticMetrics(paths) {
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

// ============================================================
// SIDEBAR ENTRY POINT
// ============================================================

export function BuildSidebar(state) {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;
  sidebar.innerHTML = '';

  sidebar.appendChild(buildCommitVariableSection(state));
  sidebar.appendChild(buildSubtaskVariableSection(state));
  sidebar.appendChild(buildMetricVariableSection(state));
  sidebar.appendChild(buildExperimentLegend(state));
  sidebar.appendChild(buildMetricLegend(state));
}

// ============================================================
// GRAPH REFRESH HELPERS
// ============================================================

/** Re-renders traces for all graphs (appearance only, no re-fetch). */
export function refreshAllGraphAppearances(state) {
  for (const id of state.graphSettings.keys()) {
    _graphManager.RefreshGraphAppearance(id);
  }
}

/** Re-fetches and redraws all graphs that reference the given variable name. */
export function refreshGraphsUsingVariable(state, varName) {
  for (const [id, config] of state.graphSettings) {
    const usesVar = config.experiments.some(s => s.commitVar === varName || s.subtaskVar === varName)
      || config.metrics.some(m => {
        if (typeof m === 'string') {
          try { return JSON.parse(m)?.variable === varName; } catch (_) {}
        }
        return false;
      });
    if (usesVar) {
      _refetchAndRedrawGraph(state, id, config).catch(err => console.error('[sidebar] refetch error:', err));
    }
  }
}

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

/** Re-colours/renames traces for all graphs using the given experiment (no re-fetch). */
export function refreshGraphsUsingExperiment(state, expKey) {
  for (const id of getGraphIDsUsingExperiment(state, expKey)) {
    _graphManager.RefreshGraphAppearance(id);
  }
}

function getGraphIDsUsingMetric(state, metricPath) {
  const ids = [];
  for (const [id, config] of state.graphSettings) {
    const uses = config.metrics.some(m =>
      resolveMetricEntry(m, state.variables.metrics) === metricPath
    );
    if (uses) ids.push(id);
  }
  return ids;
}

/** Re-renders traces for all graphs using the given metric (no re-fetch). */
export function refreshGraphsUsingMetric(state, metricPath) {
  for (const id of getGraphIDsUsingMetric(state, metricPath)) {
    _graphManager.RefreshGraphAppearance(id);
  }
}

/** Resolves variables and re-fetches data for a graph, then redraws it in place. */
async function _refetchAndRedrawGraph(state, id, config) {
  const resolved = config.experiments
    .map(slot => resolveExperimentSlot(slot, state.variables))
    .filter(Boolean);
  if (resolved.length === 0) return;

  // Deduplicate: two variables may resolve to the same path
  const resolvedMetrics = [...new Set(
    config.metrics
      .map(m => resolveMetricEntry(m, state.variables.metrics))
      .filter(m => m != null)
  )];
  if (resolvedMetrics.length === 0) return;

  const results = await Promise.all(
    resolved.map(exp => _apirest.LoadCommitMetricsValues(
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
  await _graphManager.UpdateGraph(id, config, dataMap);
}

// ============================================================
// SIDEBAR CARD BUILDERS
// ============================================================

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
    resetBtn.textContent = ICONS.RESET;
    resetBtn.title = 'Reset to undefined';
    resetBtn.addEventListener('click', onReset);
    cardHeader.appendChild(resetBtn);
  }

  const delBtn = document.createElement('button');
  delBtn.className = 'sidebar-delete-btn';
  delBtn.textContent = ICONS.CLOSE;
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
  const section = buildSidebarSection('Variables: Commits', 'Add commit variable', () => {
    let n = 1;
    while (state.variables.commits.has(`c${n}`)) n++;
    state.variables.commits.set(`c${n}`, { value: null, alias: null });
    BuildSidebar(state);
  });

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
          _errorManager.Error(`Variable "${name}" is used by one or more graphs — remove it from the graphs before deleting.`);
          return;
        }
        state.variables.commits.delete(name);
        BuildSidebar(state);
      }
    );

    // Commit picker — rich single-select with branch badge / date / comment
    const commitPicker = _ui.CreateCommitPicker(
      _gitHistoryPromise,
      _allCommitsPromise,
      { selected: entry?.value ?? null }
    );
    commitPicker.addEventListener('change', () => {
      const newValue = commitPicker.value || null;
      state.variables.commits.set(name, { value: newValue, alias: entry?.alias ?? null });
      refreshGraphsUsingVariable(state, name);
      BuildSidebar(state);

      if (newValue) {
        Promise.all([
          _apirest.LoadCommitSubjects(TASK_TYPES.PERF, newValue),
          _apirest.LoadCommitSubjects(TASK_TYPES.VULN, newValue)
        ]).then(([p, v]) => {
          const before = globalDynamicSubtasks.length;
          dedupSubtasks(globalDynamicSubtasks, (p ?? []).map(s => ({ tasktype: TASK_TYPES.PERF, subtask: s.value })));
          dedupSubtasks(globalDynamicSubtasks, (v ?? []).map(s => ({ tasktype: TASK_TYPES.VULN, subtask: s.value })));
          if (globalDynamicSubtasks.length > before) BuildSidebar(state);
        });
      }
    });
    card.appendChild(commitPicker);

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
  const section = buildSidebarSection('Variables: Subtasks', 'Add subtask variable', () => {
    let n = 1;
    while (state.variables.subtasks.has(`s${n}`)) n++;
    state.variables.subtasks.set(`s${n}`, { value: null, alias: null });
    BuildSidebar(state);
  });

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
          _errorManager.Error(`Variable "${name}" is used by one or more graphs — remove it from the graphs before deleting.`);
          return;
        }
        state.variables.subtasks.delete(name);
        BuildSidebar(state);
      }
    );

    const knownSubtasks = getKnownSubtasks(state);
    const currentToken  = entry?.value ? `${entry.value.tasktype}:${entry.value.subtask}` : null;

    const subtaskOpts = [
      { value: '', text: knownSubtasks.length === 0 ? '(no subtasks loaded yet)' : '(undefined)', selected: !currentToken },
      ...knownSubtasks.map(({ tasktype, subtask }) => ({
        value: `${tasktype}:${subtask}`,
        text:  `${tasktype}/${subtask}`,
        selected: `${tasktype}:${subtask}` === currentToken,
      })),
    ];
    const select = _ui.CreateSimpleDropdown(subtaskOpts, null);

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
  const section = buildSidebarSection('Variables: Metrics', 'Add metric variable', () => {
    let n = 1;
    while (state.variables.metrics.has(`m${n}`)) n++;
    state.variables.metrics.set(`m${n}`, null);
    BuildSidebar(state);
  });

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
          _errorManager.Error(`Variable "${name}" is used by one or more graphs — remove it from the graphs before deleting.`);
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
  fmtInput.placeholder = '\${COMMIT_ALIAS} − \${SUBTASK_ALIAS}';
  fmtInput.value = state.legendFormat.experiment ?? '';
  fmtInput.title = 'Tokens: ${COMMIT_HASH}, ${SUBTASK_TYPE}, ${SUBTASK_NAME}, ${COMMIT_ALIAS}, ${SUBTASK_ALIAS}\nTransforms (chain with :): uppercase, lowercase, camelcase, pascalcase, kebabcase, snakecase, beforeFirst(regex), afterLast(regex)\nExample: ${SUBTASK_ALIAS:afterLast(_):pascalcase}';
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
      entry = { color: nextCommitColor(state.commitRegistry), displayName: null, visible: true };
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
    eyeBtn.textContent = entry.visible !== false ? ICONS.BULLET_FILL : ICONS.BULLET_EMPTY;
    eyeBtn.title = entry.visible !== false ? 'Hide' : 'Show';
    eyeBtn.addEventListener('click', () => {
      entry.visible = entry.visible === false;
      eyeBtn.textContent = entry.visible !== false ? ICONS.BULLET_FILL : ICONS.BULLET_EMPTY;
      eyeBtn.title = entry.visible !== false ? 'Hide' : 'Show';
      refreshGraphsUsingExperiment(state, expKey);
    });

    topLine.appendChild(colorInput);
    topLine.appendChild(identSpan);
    topLine.appendChild(eyeBtn);

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'commit-legend-name';
    nameInput.placeholder = 'Display name…';
    nameInput.value = entry.displayName ?? '';
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
function getMetricDefaultDash(state, metricPath) {
  for (const [, config] of state.graphSettings) {
    const seen = new Set();
    let idx = 0;
    for (const m of config.metrics) {
      const path = resolveMetricEntry(m, state.variables.metrics);
      if (!path || seen.has(path)) continue;
      seen.add(path);
      if (path === metricPath) return DASH_PALETTE[idx % DASH_PALETTE.length];
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
      const path = resolveMetricEntry(m, state.variables.metrics);
      if (path) paths.add(path);
    }
  }
  return paths;
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
    eyeBtn.textContent = entry.visible !== false ? ICONS.BULLET_FILL : ICONS.BULLET_EMPTY;
    eyeBtn.title = entry.visible !== false ? 'Hide' : 'Show';
    eyeBtn.addEventListener('click', () => {
      entry.visible = entry.visible === false;
      eyeBtn.textContent = entry.visible !== false ? ICONS.BULLET_FILL : ICONS.BULLET_EMPTY;
      eyeBtn.title = entry.visible !== false ? 'Hide' : 'Show';
      refreshGraphsUsingMetric(state, metricPath);
    });
    topLine.appendChild(eyeBtn);

    row.appendChild(topLine);

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'commit-legend-name';
    nameInput.placeholder = 'Display name…';
    nameInput.value = entry.displayName ?? '';
    nameInput.addEventListener('change', (e) => {
      entry.displayName = e.target.value.trim() || null;
      refreshGraphsUsingMetric(state, metricPath);
    });
    row.appendChild(nameInput);
    section.appendChild(row);
  }

  return section;
}

// ============================================================
// METRIC VARIABLE MODAL
// ============================================================

/** Opens a mini-modal to define or edit a metric variable (single selection). */
async function openMetricVarModal(name, currentVal, state) {
  _enableMainUI(false);

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

  const modalpage = document.getElementById('modalpage');
  modalpage.innerHTML = '';
  if (experiments.length > 0) {
    const loadingContainer = document.createElement('div');
    loadingContainer.className = 'modal-dialog-scrollable';
    loadingContainer.innerHTML = '<div class="modal-body metrics-loading"><div class="spinner" style="width:32px;height:32px;border-width:3px;margin:0"></div></div>';
    modalpage.appendChild(loadingContainer);
    modalpage.classList.add('modalpage-visible');
  }

  const metricsResults = experiments.length > 0
    ? await Promise.all(experiments.map(exp => _apirest.LoadCommitMetrics(exp.tasktype, exp.commit, exp.subtask)))
    : [];

  const union = new Set();
  for (const mr of metricsResults) flattenMetricPaths(mr).forEach(p => union.add(p));

  modalpage.innerHTML = '';
  const container = document.createElement('div');
  container.className = 'modal-dialog-scrollable';
  _ui.Reset();

  const modalBody = document.createElement('div');
  modalBody.className = 'modal-body';

  modalBody.appendChild(_ui.CreateTitle(`Metric Variable: ${name}`, 'h3', null));

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
    modalBody.appendChild(msg);
  } else {
    const syntheticMetrics = buildSyntheticMetrics(union);
    const metricsTree = _ui.CreateMetrics(syntheticMetrics, {
      callback: function(event) {
        if (event.target.checked) {
          // Single selection: uncheck all others
          modalBody.querySelectorAll('.metric-checkbox').forEach(cb => {
            if (cb !== event.target) cb.checked = false;
          });
          selectedMetric = event.target.value;
        } else {
          selectedMetric = null;
        }
        updateOk();
      }
    });
    modalBody.appendChild(metricsTree);

    // Pre-select currentVal if set
    if (currentVal) {
      modalBody.querySelectorAll('.metric-checkbox').forEach(cb => {
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
    modalpage.classList.remove('modalpage-visible');
    _enableMainUI(true);
  });

  const actions = _ui.CreateActions(true, {
    ok: {
      callback: function() {
        if (!selectedMetric) return;
        state.variables.metrics.set(name, selectedMetric);
        refreshGraphsUsingVariable(state, name);
        BuildSidebar(state);
        clearModalCancel();
        modalpage.classList.remove('modalpage-visible');
        _enableMainUI(true);
      },
      className: 'metric-var-ok-btn',
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
  btOk = container.querySelector('.metric-var-ok-btn');
  updateOk();
  modalpage.classList.add('modalpage-visible');
}
