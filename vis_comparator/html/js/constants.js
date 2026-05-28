/**
 * Shared application constants.
 */

/** Known task type identifiers used by the REST API. */
export const TASK_TYPES = Object.freeze({
  PERF: 'Perf',
  VULN: 'Vuln',
});

/** Unicode icon characters used in button labels and badges. */
export const ICONS = Object.freeze({
  RESET:        '↺',
  CLOSE:        '✕',
  CLOSE_HEAVY:  '✖',
  DELETE:       '🗑',
  WARN:         '⚠',
  ARROW_RIGHT:  '→',
  BULLET_FILL:  '●',
  BULLET_EMPTY: '○',
  PENCIL:       '✏',
  LINK:         '🔗',
  CHECK:        '✓',
  CLOCK:        '🕐',
  GEAR:         '⚙',
  PLUS:         '➕',
  MINUS:        '➖',
  FOLDER_OPEN:  '➖',
  FOLDER_SHUT:  '➕',
});

/** Commit series color palette (up to 4 experiments; cycles beyond 4). */
export const COMMIT_PALETTE = Object.freeze(['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728']);

/** Deterministic branch color palette for commit picker branch badges. */
export const BRANCH_PR_PALETTE = Object.freeze(['#7b5ea7', '#9b5de5', '#6a4c93', '#5e548e', '#7678ed', '#8338ec', '#c77dff']);

/** Default legend format templates applied when no explicit override is set. */
export const DEFAULT_LEGEND_FORMAT = Object.freeze({
  experiment: '${COMMIT_ALIAS} − ${SUBTASK_ALIAS}',
  metric:     '${METRIC}',
});
