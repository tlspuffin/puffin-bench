/**
 * Application state definition and pure state utilities.
 * No DOM, no network, no side effects — only data and pure transformations.
 */

import { TASK_TYPES, DEFAULT_LEGEND_FORMAT, COMMIT_PALETTE } from './constants.js';

// ============================================================
// MODAL CANCEL MANAGEMENT
// ============================================================

let _currentModalCancelFn = null;

export function setModalCancel(fn) { _currentModalCancelFn = fn; }
export function clearModalCancel() { _currentModalCancelFn = null; }
export function getModalCancelFn() { return _currentModalCancelFn; }

// ============================================================
// SHARED RUNTIME DATA
// ============================================================

/** Dynamic subtask cache populated at startup and on commit-select changes. */
export const globalDynamicSubtasks = [];

// ============================================================
// APPLICATION STATE
// ============================================================

export const state = {
  title: 'No Title_' + Date.now(),
  graphSettings: new Map(),
  variables: {
    commits:  new Map(),  // name → { value: commitID | null, alias: string | null }
    subtasks: new Map(),  // name → { value: { tasktype, subtask } | null, alias: string | null }
    metrics:  new Map(),  // name → metricPath | null
  },
  legendFormat: { ...DEFAULT_LEGEND_FORMAT },
  commitRegistry: new Map(),
  metricLegend:   new Map(),  // metricPath → { displayName: string|null, dash: string|null }
};

// ============================================================
// PURE STATE UTILITIES
// ============================================================

/**
 * Appends entries from `incoming` to `target`, skipping duplicates.
 * @param {{ tasktype: string, subtask: string }[]} target
 * @param {{ tasktype: string, subtask: string }[]} incoming
 */
export function dedupSubtasks(target, incoming) {
  for (const e of incoming) {
    if (!target.some(g => g.tasktype === e.tasktype && g.subtask === e.subtask)) {
      target.push(e);
    }
  }
}

/**
 * Migrates a loaded state object from the old experiment-variable format
 * (variables.experiments) to the new split format (variables.commits / variables.subtasks).
 * Also ensures legendFormat is present.
 * @param {object|null} loadedState
 * @returns {object|null}
 */
export function migrateStateIfNeeded(loadedState) {
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

  // ── Upgrade string-form MetricVarRefs to object form ─────────────────────
  if (loadedState.graphSettings instanceof Map) {
    for (const [, config] of loadedState.graphSettings) {
      if (!Array.isArray(config.metrics)) continue;
      config.metrics = config.metrics.map(m => {
        if (typeof m !== 'string') return m;
        try { const p = JSON.parse(m); if (p?.variable) return { variable: p.variable }; } catch (_) {}
        return m;
      });
    }
  }

  // ── Ensure legendFormat exists ────────────────────────────────────────────
  if (!loadedState.legendFormat) {
    loadedState.legendFormat = { ...DEFAULT_LEGEND_FORMAT };
  }

  return loadedState;
}

/**
 * Resolves a metric entry (plain path string or JSON-encoded {variable:name}) to a
 * concrete metric path. Returns null for unresolved VarRefs or unparseable values.
 * @param {string|object} m           - Raw metric entry from graphConfig.metrics
 * @param {Map|null}      metricsMap  - state.variables.metrics
 * @returns {string|null}
 */
export function resolveMetricEntry(m, metricsMap) {
  if (typeof m === 'object' && m !== null && 'variable' in m) {
    return metricsMap?.get(m.variable) ?? null;
  }
  if (typeof m === 'string') {
    return m;
  }
  return null;
}

/**
 * Returns the next color from the commit palette for a new registry entry.
 * Must be called before inserting the new entry (uses current .size as index).
 * @param {Map} commitRegistry - state.commitRegistry
 * @returns {string}
 */
export function nextCommitColor(commitRegistry) {
  return COMMIT_PALETTE[commitRegistry.size % COMMIT_PALETTE.length];
}

/**
 * Resolves a graph slot's commit/tasktype/subtask from variables or direct values.
 * Returns null if any required field is missing.
 */
export function resolveExperimentSlot(slot, variables) {
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

/**
 * Returns true if any graph's configuration references the given variable name.
 * @param {'commit'|'subtask'|'metric'} type
 */
export function isVarReferenced(state, varName, type) {
  for (const [, config] of state.graphSettings) {
    if (type === 'commit' && config.experiments.some(s => s.commitVar === varName)) return true;
    if (type === 'subtask' && config.experiments.some(s => s.subtaskVar === varName)) return true;
    if (type === 'metric' && config.metrics.some(m => m?.variable === varName)) return true;
  }
  return false;
}

/**
 * Returns all known { tasktype, subtask } pairs across commitRegistry,
 * subtask variables, and the dynamic subtask cache.
 */
export function getKnownSubtasks(state) {
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
