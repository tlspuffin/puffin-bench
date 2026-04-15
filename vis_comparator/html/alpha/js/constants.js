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
