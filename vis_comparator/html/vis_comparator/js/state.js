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

/** Campaign run list populated once at startup (one entry per run/zst). */
export const globalCampaigns = [];

// ============================================================
// APPLICATION STATE
// ============================================================

export const state = {
  title: 'No Title_' + Date.now(),
  graphSettings: [],  // ordered [{ id, config }] — array order == DOM order == save order
  variables: {
    commits:   new Map(),  // name → { value: commitID | null, alias: string | null }
    subtasks:  new Map(),  // name → { value: { tasktype, subtask } | null, alias: string | null }
    campaigns: new Map(),  // name → { value: runRef | null, alias: string | null }
    metrics:   new Map(),  // name → metricPath | null
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
 * Whether a slot is configured in campaign or commit mode.
 * @returns {'campaign'|'commit'}
 */
export function slotMode(slot) {
  return (slot.mode === 'campaign' || slot.campaignVar || slot.campaignRun) ? 'campaign' : 'commit';
}

/**
 * Resolves a graph slot to a concrete run descriptor.
 * Commit mode → { commit, tasktype, subtask, timestamp:null, user:null, campaign:null }.
 * Campaign mode → fields taken from the selected run (tasktype='Campaign').
 * Returns null if any required field is missing.
 */
export function resolveExperimentSlot(slot, variables) {
  // ── Campaign mode: a single run reference supplies everything ──────────────
  if (slotMode(slot) === 'campaign') {
    const run = slot.campaignVar
      ? (variables?.campaigns?.get(slot.campaignVar)?.value ?? null)
      : (slot.campaignRun ?? null);
    if (run && run.commit && run.timestamp != null) {
      if (run.subject) {
        return {
          commit:    run.commit,
          tasktype:  run.type ?? 'Campaign',
          subtask:   run.subject,
          timestamp: run.timestamp,
          user:      run.user ?? null,
          campaign:  run.campaign ?? null,
        };
      }
      // A selected campaign run that resolves but has no subject can't be plotted
      // (its archive metadata.json was missing/unreadable). Flag it so it's
      // distinguishable from a genuinely unset variable rather than silently empty.
      console.warn('Campaign run has no subject and cannot be plotted:', run);
    }
    return null;
  }

  // ── Commit mode ────────────────────────────────────────────────────────────
  let commit   = null;
  let tasktype = null;
  let subtask  = null;
  // Pinned run timestamp: from the slot for a literal commit, or carried by the
  // commit variable. null = latest (dynamic). See CreateCommitPicker.
  let pinnedTs = null;

  if (slot.commitVar) {
    const entry = variables?.commits?.get(slot.commitVar);
    commit = entry?.value ?? null;
    pinnedTs = entry?.timestamp ?? null;
  } else {
    commit = slot.commit ?? null;
    pinnedTs = slot.timestamp ?? null;
  }

  if (slot.subtaskVar) {
    const entry = variables?.subtasks?.get(slot.subtaskVar);
    const val   = entry?.value ?? null;
    if (val) { tasktype = val.tasktype; subtask = val.subtask; }
  } else {
    tasktype = slot.tasktype ?? null;
    subtask  = slot.subtask  ?? null;
  }

  if (commit && tasktype && subtask) {
    // `pinned` distinguishes an explicit run from the latest timestamp that
    // graphmanager fills in for ${DATE} — only pinned runs affect the keys below.
    return { commit, tasktype, subtask, timestamp: pinnedTs, pinned: pinnedTs != null,
        user: null, campaign: null };
  }
  return null;
}

/**
 * Stable identity key for a resolved experiment. Commit-mode runs key on
 * commit:tasktype:subtask; campaign runs append the timestamp so two runs of the
 * same campaign (same commit+subject, different timestamp) stay distinct.
 * @param {{commit,tasktype,subtask,timestamp?}|null} resolved
 * @returns {string|null}
 */
export function experimentKey(resolved) {
  if (!resolved) return null;
  const base = `${resolved.commit}:${resolved.tasktype}:${resolved.subtask}`;
  // Campaigns always disambiguate by timestamp; commit-mode keys stay 3-part
  // unless a specific run is pinned (so two pinned runs of the same commit +
  // subtask stay distinct). The auto-filled latest timestamp (not pinned) never
  // widens the key.
  const includeTs = (resolved.tasktype === 'Campaign' || resolved.pinned) && resolved.timestamp != null;
  return includeTs ? `${base}:${resolved.timestamp}` : base;
}

/**
 * Stable appearance key for a slot's resolved experiment. Unlike experimentKey
 * (which always keys on resolved values and is used for data lookup), this
 * substitutes the variable name ($c1, $s1, $k1) for any part the slot defines via
 * a variable, so colour/visibility follow the variable rather than the URL-supplied
 * value. Slots that define every part literally produce a key identical to
 * experimentKey(resolved), so colours saved against literal experiments still match.
 * @param {object} slot           - graph experiment slot
 * @param {object|null} resolved  - result of resolveExperimentSlot(slot, …)
 * @returns {string|null}
 */
export function slotKey(slot, resolved) {
  if (!resolved) return null;
  if (slotMode(slot) === 'campaign') {
    return slot.campaignVar
      ? `$${slot.campaignVar}`
      : `${resolved.commit}:${resolved.tasktype}:${resolved.subtask}:${resolved.timestamp}`;
  }
  // A commit variable carries its own pinned run, so `$c1` already encodes it;
  // only a literal pinned commit needs the timestamp appended so two pinned runs
  // of the same commit get distinct colours/visibility.
  const commitPart  = slot.commitVar
    ? `$${slot.commitVar}`
    : (resolved.pinned ? `${resolved.commit}@${resolved.timestamp}` : resolved.commit);
  const subtaskPart = slot.subtaskVar ? `$${slot.subtaskVar}` : `${resolved.tasktype}:${resolved.subtask}`;
  return `${commitPart}:${subtaskPart}`;
}

/** Returns the { id, config } graph entry with the given id, or undefined. */
export function findGraph(state, id) {
  return state.graphSettings.find(g => g.id === id);
}

/** Removes the graph entry with the given id from state.graphSettings (in place). */
export function removeGraph(state, id) {
  const i = state.graphSettings.findIndex(g => g.id === id);
  if (i >= 0) state.graphSettings.splice(i, 1);
}

/**
 * Returns true if any graph's configuration references the given variable name.
 * @param {'commit'|'subtask'|'campaign'|'metric'} type
 */
export function isVarReferenced(state, varName, type) {
  for (const { config } of state.graphSettings) {
    if (type === 'commit' && config.experiments.some(s => s.commitVar === varName)) return true;
    if (type === 'subtask' && config.experiments.some(s => s.subtaskVar === varName)) return true;
    if (type === 'campaign' && config.experiments.some(s => s.campaignVar === varName)) return true;
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
    if (key.startsWith('$') || key.includes(':$')) continue;  // variable-keyed entries aren't literal subtasks
    const parts = key.split(':');
    if (parts.length < 3) continue;
    const tasktype = parts[1];
    if (tasktype === 'Campaign') continue;  // campaign keys carry a timestamp; not commit subtasks
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
