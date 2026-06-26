// Shared commit colour palette — imported by index.js for commitRegistry assignment.
import {CommitHelp} from "./commithelp.js";
import { ICONS, COMMIT_PALETTE, DASH_PALETTE } from './constants.js';
import { resolveMetricEntry, resolveExperimentSlot, experimentKey } from './state.js';

/**
 * Manages Plotly graph instances displayed in the main area.
 * Each graph is identified by a numeric ID issued at creation time.
 *
 * New unified model (Phase C):
 *   - AddGraph(graphConfig, dataMap) handles any number of experiments (1 to 4).
 *   - graphConfig = { experiments, metricsMode, metrics, min, max, delta, showRaw, showCI, splitAxes }
 *   - dataMap = Map<"commit:type:subject", { header, series }>
 *   - ExperimentVarRef slots are resolved at render time via callbacks.getState().
 */
class GraphManager {
  #configs;
  #document;
  #callbacks;
  // Re-entrant scroll-anchoring suppression for MoveGraph: count in-flight restores so
  // rapid moves capture the true prior value once and restore only after the last one.
  #moveAnchorPending = 0;
  #moveAnchorPrev = '';
  static #nextid = 0;

  // Four distinct colours for up to 4 experiments. Beyond 4, colours cycle.
  static #PALETTE = COMMIT_PALETTE;

  // Four distinct dash styles, one per metric. Beyond 4 metrics, styles cycle.
  static #DASH_PALETTE = DASH_PALETTE;

  /**
   * @param {HTMLElement} container  - Container element where graph divs are appended
   * @param {object}      callbacks  - {
   *   delete(id),               called when a graph is removed
   *   duplicate(newId, config), called after a graph is duplicated (optional)
   *   reorder(),                called after graphs are reordered on screen (optional)
   *   getState(),               returns current app state ({ variables, commitRegistry })
   *   editGraph(id),            called when the ⚙ button is clicked (optional)
   * }
   */
  constructor(container, callbacks) {
    this.#configs   = new Map();
    this.#document  = container;
    this.#callbacks = callbacks;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Adds a graph (single or multi-experiment) to the page.
   * @param {object}              graphConfig - Canonical config (experiments array, metricsMode, metrics, …)
   * @param {Map<string, object>} dataMap     - "commit:type:subject" → { header, series }
   * @param {number|null}         afterId     - Insert the new container right after this graph's
   *                                            container; appended to the end when null/unknown.
   * @returns {Promise<number>} Numeric graph ID
   */
  async AddGraph(graphConfig, dataMap, afterId = null) {
    const id = GraphManager.#nextid++;
    const resolvedEntries = this.#ResolveExperiments(graphConfig);

    const { container: graphContainer, graphArea } = this.#BuildGraphContainer(id, {
      showIcons:      true,
      showAxesToggle: true,
      showRawToggle:  true,
      showCIToggle:   true,
    });
    const afterEl = afterId != null ? this.#configs.get(afterId)?.graphContainer : null;
    if (afterEl) afterEl.after(graphContainer);
    else this.#document.appendChild(graphContainer);

    const stored = { graphConfig, dataMap, graphContainer, graphArea, hiddenGroups: new Set() };
    this.#configs.set(id, stored);

    const titleSpan = graphContainer.querySelector('.graph-title-text');
    if (titleSpan) this.#UpdateTitleDom(titleSpan, graphConfig, resolvedEntries, dataMap);

    await this.#Draw(graphArea, graphConfig, dataMap, stored);

    // Set initial toggle button states
    const eltSplit = document.getElementById('graph_ui_split_' + id);
    if (eltSplit) {
      if (graphConfig.metrics.length <= 1) {
        eltSplit.disabled = true;
      } else if (graphConfig.splitAxes) {
        eltSplit.classList.add('active');
      }
    }
    if (graphConfig.showRaw !== false) {
      document.getElementById('graph_ui_raw_' + id)?.classList.add('active');
    }
    if (graphConfig.showCI !== false) {
      document.getElementById('graph_ui_ci_' + id)?.classList.add('active');
    }

    return id;
  }

  /**
   * Removes a graph from the page and cleans up Plotly state.
   * @param {number} id
   */
  DelGraph(id) {
    const stored = this.#configs.get(id);
    if (!stored) return;
    Plotly.purge(stored.graphArea);
    stored.graphContainer.remove();
    this.#configs.delete(id);
    this.#callbacks?.delete?.(id);
  }

  /** Removes all graphs from the page. */
  DelAllGraph() {
    for (const id of Array.from(this.#configs.keys())) {
      this.DelGraph(id);
    }
  }

  /**
   * Creates a copy of an existing graph directly below it, reusing the source's
   * already-fetched data (no server round trip). The config is deep-cloned so the
   * copy can be edited independently. Notifies the duplicate callback so app state
   * can track the new graph.
   * @param {number} id
   */
  async DuplicateGraph(id) {
    const stored = this.#configs.get(id);
    if (!stored) return;
    const clonedConfig = structuredClone(stored.graphConfig);
    const newId = await this.AddGraph(clonedConfig, stored.dataMap, /*afterId=*/ id);
    this.#callbacks?.duplicate?.(newId, clonedConfig);
  }

  /**
   * Moves a graph one slot up or down on the page, then notifies the reorder callback.
   * @param {number} id
   * @param {number} dir  -1 = up, +1 = down
   */
  MoveGraph(id, dir) {
    const el = this.#configs.get(id)?.graphContainer;
    if (!el) return;
    const sibling = dir < 0 ? el.previousElementSibling : el.nextElementSibling;
    if (!sibling) return;                       // already at an end — nothing to do

    // Reordering mutates the DOM, which makes the browser's scroll anchoring nudge
    // scrollTop and visually shift the page. Disable anchoring on the container so the
    // scroll position stays put across the move. It must stay disabled *through* the
    // layout that processes this mutation: rAF callbacks run before that frame's layout,
    // so we restore on the frame after (double rAF) to keep deletes/redraws anchoring.
    // Capture the prior value only when no restore is in flight, so rapid consecutive
    // moves don't capture the transient 'none' and leave anchoring stranded off.
    const container = el.parentNode;
    if (this.#moveAnchorPending === 0) this.#moveAnchorPrev = container.style.overflowAnchor;
    this.#moveAnchorPending++;
    container.style.overflowAnchor = 'none';

    if (dir < 0) container.insertBefore(el, sibling);
    else         container.insertBefore(sibling, el);

    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (--this.#moveAnchorPending === 0) container.style.overflowAnchor = this.#moveAnchorPrev;
    }));
    this.#callbacks?.reorder?.();
  }

  /** Returns graph IDs in their current on-screen (DOM) order. */
  GetDomOrderedIds() {
    return Array.from(this.#document.querySelectorAll(':scope > .graph-container'))
      .map(el => Number(el.id.replace('graph-container_', '')))
      .filter(domId => this.#configs.has(domId));
  }

  /** Notifies Plotly of a container size change for all graphs. */
  ResizeAll() {
    for (const { graphArea } of this.#configs.values()) {
      if (graphArea.style.display !== 'none') Plotly.Plots.resize(graphArea);
    }
  }

  /**
   * Recolours/renames traces without re-fetching data.
   * Call after modifying state.commitRegistry (colour or displayName).
   * @param {number} id
   */
  async RefreshGraphAppearance(id) {
    const stored = this.#configs.get(id);
    if (!stored) return;
    const resolvedEntries = this.#ResolveExperiments(stored.graphConfig);
    const titleSpan = stored.graphContainer.querySelector('.graph-title-text');
    if (titleSpan) this.#UpdateTitleDom(titleSpan, stored.graphConfig, resolvedEntries, stored.dataMap);
    await this.#Draw(stored.graphArea, stored.graphConfig, stored.dataMap, stored);
  }

  /**
   * Updates an existing graph in-place with new config and data (Phase E — Edit).
   * @param {number}              id
   * @param {object}              graphConfig
   * @param {Map<string, object>} dataMap
   */
  async UpdateGraph(id, graphConfig, dataMap) {
    const stored = this.#configs.get(id);
    if (!stored) return;
    stored.graphConfig = graphConfig;
    stored.dataMap     = dataMap;
    stored.hiddenGroups.clear();  // legendgroups may have changed

    // Update DOM title
    const resolvedEntries = this.#ResolveExperiments(graphConfig);
    const titleSpan = stored.graphContainer.querySelector('.graph-title-text');
    if (titleSpan) this.#UpdateTitleDom(titleSpan, graphConfig, resolvedEntries, dataMap);

    // Update toggle button states
    const eltSplit = document.getElementById('graph_ui_split_' + id);
    if (eltSplit) {
      eltSplit.disabled = graphConfig.metrics.length <= 1;
      eltSplit.classList.toggle('active', graphConfig.splitAxes === true && graphConfig.metrics.length > 1);
    }
    document.getElementById('graph_ui_raw_' + id)
      ?.classList.toggle('active', graphConfig.showRaw !== false);
    document.getElementById('graph_ui_ci_' + id)
      ?.classList.toggle('active', graphConfig.showCI !== false);

    await this.#Draw(stored.graphArea, graphConfig, dataMap, stored);
  }

  /**
   * Toggles visibility of individual run traces on a graph.
   * @param {number} id
   */
  ToggleRawTraces(id) {
    const stored = this.#configs.get(id);
    if (!stored) return;
    stored.graphConfig.showRaw = !stored.graphConfig.showRaw;
    document.getElementById('graph_ui_raw_' + id)
      ?.classList.toggle('active', stored.graphConfig.showRaw);
    this.#Draw(stored.graphArea, stored.graphConfig, stored.dataMap, stored);
  }

  /**
   * Toggles the 95% confidence interval shading on a graph.
   * @param {number} id
   */
  ToggleCIShadow(id) {
    const stored = this.#configs.get(id);
    if (!stored) return;
    stored.graphConfig.showCI = !(stored.graphConfig.showCI ?? false);
    document.getElementById('graph_ui_ci_' + id)
      ?.classList.toggle('active', stored.graphConfig.showCI !== false);
    this.#Draw(stored.graphArea, stored.graphConfig, stored.dataMap, stored);
  }

  /**
   * Toggles split Y-axes mode (one axis per metric).
   * Disabled automatically when a graph has only one metric.
   * @param {number} id
   */
  ToggleSplitAxes(id) {
    const stored = this.#configs.get(id);
    if (!stored) return;
    stored.graphConfig.splitAxes = !stored.graphConfig.splitAxes;
    const eltSplit = document.getElementById('graph_ui_split_' + id);
    if (eltSplit) eltSplit.classList.toggle('active', stored.graphConfig.splitAxes);
    this.#Draw(stored.graphArea, stored.graphConfig, stored.dataMap, stored);
  }

  /** Returns the dash style for a resolved metric path as it would be rendered. */
  getMetricDash(metricPath) {
    for (const { graphConfig } of this.#configs.values()) {
      const metrics = this.#ResolveMetrics(graphConfig);
      const idx = metrics.indexOf(metricPath);
      if (idx !== -1) return GraphManager.#DASH_PALETTE[idx % GraphManager.#DASH_PALETTE.length];
    }
    return 'solid';
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Resolves experiment slots to concrete { commit, tasktype, subtask } objects.
   * commitVar/subtaskVar refs are looked up in state.variables; null values → unresolved.
   * @returns {Array<{ resolved: object|null, slot, idx, commitVarName: string|null, subtaskVarName: string|null }>}
   */
  #ResolveExperiments(graphConfig) {
    const vars = this.#callbacks?.getState?.()?.variables;
    return graphConfig.experiments.map((slot, idx) => {
      const resolved = resolveExperimentSlot(slot, vars);
      // Commit-mode runs resolve with timestamp:null; fill the latest timestamp so
      // ${DATE}/${TIME}/${DATETIME} render (does not affect experimentKey).
      if (resolved && resolved.tasktype !== 'Campaign' && resolved.timestamp == null) {
        resolved.timestamp = this.#callbacks?.getLatestTimestamp?.(resolved.tasktype, resolved.commit) ?? null;
      }
      return {
        resolved, slot, idx,
        commitVarName:  slot.commitVar  ?? null,
        subtaskVarName: slot.subtaskVar ?? null,
      };
    });
  }

  /**
   * Resolves metric entries (JSON-encoded VarRefs or plain strings) to concrete metric paths.
   * VarRefs are looked up in state.variables.metrics; undefined → filtered out.
   * @returns {string[]}
   */
  #ResolveMetrics(graphConfig) {
    const metricsMap = this.#callbacks?.getState?.()?.variables?.metrics;
    const seen = new Set();
    return graphConfig.metrics
      .map(m => resolveMetricEntry(m, metricsMap))
      .filter(path => {
        if (!path) return false;
        if (seen.has(path)) return false;  // deduplicate: first occurrence wins
        seen.add(path);
        return true;
      });
  }

  /** Returns true if any resolved metric path appears more than once in graphConfig.metrics. */
  #HasDuplicateMetrics(graphConfig) {
    const metricsMap = this.#callbacks?.getState?.()?.variables?.metrics;
    const seen = new Set();
    for (const m of graphConfig.metrics) {
      const path = resolveMetricEntry(m, metricsMap);
      if (!path) continue;
      if (seen.has(path)) return true;
      seen.add(path);
    }
    return false;
  }

  /** Returns the display name for a resolved metric path (falls back to the raw path). */
  #MetricDisplayName(metricPath) {
    const state = this.#callbacks?.getState?.();
    const override = state?.metricLegend?.get(metricPath)?.displayName;
    if (override) return override;
    const fmt = state?.legendFormat?.metric;
    if (fmt) return GraphManager.#InterpolateMetric(fmt, metricPath);
    return metricPath;
  }

  /**
   * Returns the display name for a resolved experiment.
   * Priority (lowest → highest):
   *   1. Default: shortHash/tasktype/subtask
   *   2. legendFormat.experiment template
   *   3. commitRegistry[key].displayName (individual override)
   */
  #ExperimentDisplayName(resolved, slot, state) {
    const expKey = experimentKey(resolved);
    const entry  = state?.commitRegistry?.get(expKey);
    if (entry?.displayName) return entry.displayName;
    const fmt = state?.legendFormat?.experiment;
    if (fmt) return GraphManager.#InterpolateExperiment(fmt, resolved, slot, state);
    return `${CommitHelp.ShortHash(resolved.commit)}/${resolved.tasktype}/${resolved.subtask}`;
  }

  /**
   * Splits a transform chain on `:` while respecting parentheses depth,
   * so that regex arguments like `afterLast(:)` are not split.
   */
  static #SplitTransforms(transformStr) {
    const parts = [];
    let depth = 0, start = 0;
    for (let i = 0; i < transformStr.length; i++) {
      if      (transformStr[i] === '(') depth++;
      else if (transformStr[i] === ')') depth--;
      else if (transformStr[i] === ':' && depth === 0) {
        parts.push(transformStr.slice(start, i).trim());
        start = i + 1;
      }
    }
    parts.push(transformStr.slice(start).trim());
    return parts.filter(Boolean);
  }

  /**
   * Applies one or more chained transforms (separated by `:`) to a string value.
   * Supported transforms:
   *   uppercase, lowercase, camelcase, pascalcase, kebabcase, snakecase
   *   beforeFirst(regex)  — substring before first match of regex
   *   afterLast(regex)    — substring after last match of regex
   * Example: ${METRIC:afterLast(\\.):uppercase}  →  last dot-segment, uppercased
   */
  static #ApplyTransform(value, transformStr) {
    if (!transformStr) return value;
    return GraphManager.#SplitTransforms(transformStr)
      .reduce((v, t) => GraphManager.#ApplySingleTransform(v, t), value);
  }

  /**
   * Expands a DATE/TIME/DATETIME token from an epoch-ms source `ms`.
   * Returns '' when ms is null/undefined. Applies the token's default pattern
   * unless the transform chain already contains a format(...) call, then runs
   * the remaining transforms.
   */
  static #ExpandDateToken(token, transform, ms) {
    if (ms == null) return '';
    const defaults = { DATE: 'YYYY-MM-DD', TIME: 'HH:mm:ss', DATETIME: 'YYYY-MM-DD HH:mm:ss' };
    const hasFormat = transform && /(^|:)\s*format\(/i.test(transform);
    const chain = hasFormat
      ? transform
      : (transform ? `format(${defaults[token]}):${transform}` : `format(${defaults[token]})`);
    return GraphManager.#ApplyTransform(String(ms), chain);
  }

  static #ApplySingleTransform(value, str) {
    // format(pattern) — interpret value as epoch-ms and format it (for DATE/TIME/DATETIME)
    const fmtMatch = str.match(/^format\((.+)\)$/);
    if (fmtMatch) {
      return CommitHelp.FormatTimestamp(Number(value), fmtMatch[1]);
    }

    // beforeFirst(regex)
    const bfMatch = str.match(/^beforeFirst\((.+)\)$/);
    if (bfMatch) {
      const idx = value.search(new RegExp(bfMatch[1]));
      return idx === -1 ? value : value.substring(0, idx);
    }

    // afterLast(regex)
    const alMatch = str.match(/^afterLast\((.+)\)$/);
    if (alMatch) {
      const re = new RegExp(alMatch[1], 'g');
      let lastIdx = -1, lastLen = 0, m;
      while ((m = re.exec(value)) !== null) { lastIdx = m.index; lastLen = m[0].length; }
      return lastIdx === -1 ? value : value.substring(lastIdx + lastLen);
    }

    switch (str) {
      case 'uppercase':  return value.toUpperCase();
      case 'lowercase':  return value.toLowerCase();
      case 'camelcase':  return value
        .replace(/[\s_\-]+(.)/g, (_, c) => c.toUpperCase())
        .replace(/^(.)/, c => c.toLowerCase());
      case 'pascalcase': return value
        .replace(/[\s_\-]+(.)/g, (_, c) => c.toUpperCase())
        .replace(/^(.)/, c => c.toUpperCase());
      case 'kebabcase':  return value
        .replace(/([a-z])([A-Z])/g, '$1-$2')
        .replace(/[\s_]+/g, '-')
        .toLowerCase();
      case 'snakecase':  return value
        .replace(/([a-z])([A-Z])/g, '$1_$2')
        .replace(/[\s\-]+/g, '_')
        .toLowerCase();
      default: return value;
    }
  }

  /**
   * Interpolates a legend format template for an experiment.
   * Tokens: ${COMMIT_HASH}, ${SUBTASK_TYPE}, ${SUBTASK_NAME}, ${COMMIT_ALIAS},
   *   ${SUBTASK_ALIAS}, ${USER}, ${CAMPAIGN_NAME}, ${DATE}, ${TIME}, ${DATETIME}.
   * Any token accepts an optional transform chain (e.g. :uppercase, :beforeFirst(regex)).
   * DATE/TIME/DATETIME additionally accept :format(<pattern>) with YYYY/MM/DD/HH/mm/ss;
   * without it they default to YYYY-MM-DD / HH:mm:ss / YYYY-MM-DD HH:mm:ss.
   */
  static #InterpolateExperiment(fmt, resolved, slot, state) {
    const shortHash = CommitHelp.ShortHash(resolved.commit);

    let commitAlias = shortHash;
    if (slot?.commitVar) {
      const entry = state?.variables?.commits?.get(slot.commitVar);
      commitAlias = entry?.alias || shortHash;
    }

    let subtaskAlias = `${resolved.subtask}`;
    if (slot?.subtaskVar) {
      const entry = state?.variables?.subtasks?.get(slot.subtaskVar);
      subtaskAlias = entry?.alias || subtaskAlias;
    }

    const tokens = {
      COMMIT_HASH:   shortHash,
      SUBTASK_TYPE:  resolved.tasktype,
      SUBTASK_NAME:  resolved.subtask,
      COMMIT_ALIAS:  commitAlias,
      SUBTASK_ALIAS: subtaskAlias,
      USER:          resolved.user ?? '',
      CAMPAIGN_NAME: resolved.campaign ?? '',
    };

    const ts = resolved.timestamp;

    return fmt.replace(
      /\$\{(COMMIT_HASH|SUBTASK_TYPE|SUBTASK_NAME|COMMIT_ALIAS|SUBTASK_ALIAS|USER|CAMPAIGN_NAME|DATE|TIME|DATETIME)(?::([^}]*))?\}/gi,
      (_, token, transform) => {
        const T = token.toUpperCase();
        if (T === 'DATE' || T === 'TIME' || T === 'DATETIME') {
          return GraphManager.#ExpandDateToken(T, transform, ts);
        }
        return GraphManager.#ApplyTransform(tokens[T] ?? '', transform);
      });
  }

  /**
   * Interpolates a legend format template for a metric.
   * Token: ${METRIC} with optional transform: ${METRIC:transformName} or ${METRIC:beforeFirst(regex)}
   */
  static #InterpolateMetric(fmt, metricPath) {
    return fmt.replace(/\$\{METRIC(?::([^}]*))?\}/gi, (_, transform) => {
      return GraphManager.#ApplyTransform(metricPath, transform);
    });
  }

  /**
   * Resolves a title format string when loading a template.
   * Tokens (case-insensitive): ${TEMPLATE}, ${DATE} (DD-MM-YYYY),
   *   ${<varname>_HASH}, ${<varname>_ALIAS} for commit variables,
   *   ${<varname>_NAME}, ${<varname>_TYPE}, ${<varname>_ALIAS} for subtask variables,
   *   ${<varname>_USER}, ${<varname>_CAMPAIGN}, ${<varname>_COMMIT},
   *   ${<varname>_SUBTYPE}, ${<varname>_DATE}, ${<varname>_ALIAS} for campaign variables,
   *   ${<varname>} for metric variables.
   * ${<varname>_DATE} accepts a format(...) transform like ${DATE} (default YYYY-MM-DD).
   * Transforms (chained with :) are the same as legend format.
   * Unknown tokens are left as-is. Variables with no value → empty string.
   */
  static InterpolateTitleFormat(fmt, variables, templateName) {
    const now = Date.now();

    const map = {
      TEMPLATE: templateName ?? '',
    };
    // Date-valued tokens hold a raw epoch-ms (or null); expanded via #ExpandDateToken
    // so they honour a format(...) transform and fall back to the DATE default.
    const dateTokens = {};

    for (const [name, entry] of variables.commits) {
      const k    = name.toUpperCase();
      const hash = entry?.value ? CommitHelp.ShortHash(entry.value) : '';
      map[`${k}_HASH`]  = hash;
      map[`${k}_ALIAS`] = entry?.alias || hash;
    }
    for (const [name, entry] of variables.subtasks) {
      const k    = name.toUpperCase();
      const sub  = entry?.value?.subtask  ?? '';
      const type = entry?.value?.tasktype ?? '';
      map[`${k}_NAME`]  = sub;
      map[`${k}_TYPE`]  = type;
      map[`${k}_ALIAS`] = entry?.alias || sub;
    }
    for (const [name, entry] of (variables.campaigns ?? [])) {
      const k   = name.toUpperCase();
      const run = entry?.value ?? null;
      map[`${k}_USER`]     = run?.user ?? '';
      map[`${k}_CAMPAIGN`] = run?.campaign ?? '';
      map[`${k}_COMMIT`]   = run?.commit ? CommitHelp.ShortHash(run.commit) : '';
      map[`${k}_SUBTYPE`]  = run?.subject ?? '';
      dateTokens[`${k}_DATE`] = run?.timestamp ?? null;
      map[`${k}_ALIAS`]    = entry?.alias || (run?.campaign ?? '');
    }
    for (const [name, path] of variables.metrics) {
      map[name.toUpperCase()] = path ?? '';
    }

    return fmt.replace(/\$\{([^:}]+)(?::([^}]*))?\}/gi, (match, token, transform) => {
      const T = token.trim().toUpperCase();
      if (T === 'DATE' || T === 'TIME' || T === 'DATETIME') {
        return GraphManager.#ExpandDateToken(T, transform, now);
      }
      if (T in dateTokens) {
        return GraphManager.#ExpandDateToken('DATE', transform, dateTokens[T]);
      }
      const val = map[T];
      if (val === undefined) return match;
      return GraphManager.#ApplyTransform(val, transform);
    });
  }

  /** Returns the dash style for a resolved metric path (falls back to palette by index). */
  #MetricDash(metricPath, fallbackIdx) {
    const state = this.#callbacks?.getState?.();
    return state?.metricLegend?.get(metricPath)?.dash
      ?? GraphManager.#DASH_PALETTE[fallbackIdx % GraphManager.#DASH_PALETTE.length];
  }

  /**
   * Populates the graph title span with experiment + metric labels.
   * Variable-sourced entries get pill badges showing the variable name(s).
   * @param {Map<string,object>|null} dataMap - current data; used to show ⚠ when data is missing
   */
  #UpdateTitleDom(titleSpan, graphConfig, resolvedEntries, dataMap) {
    titleSpan.innerHTML = '';
    const state = this.#callbacks?.getState?.();

    // ── Experiment labels ───────────────────────────────────────
    resolvedEntries.forEach(({ resolved, slot, commitVarName, subtaskVarName }, i) => {
      if (i > 0) titleSpan.appendChild(document.createTextNode(' \u2022 '));

      // Show variable name badges for any variable-sourced sides
      if (commitVarName) {
        const badge = document.createElement('span');
        badge.className = 'graph-title-var-badge';
        badge.textContent = commitVarName;
        titleSpan.appendChild(badge);
        titleSpan.appendChild(document.createTextNode('\u00a0'));
      }
      if (subtaskVarName) {
        const badge = document.createElement('span');
        badge.className = 'graph-title-var-badge';
        badge.textContent = subtaskVarName;
        titleSpan.appendChild(badge);
        titleSpan.appendChild(document.createTextNode('\u00a0'));
      }

      if (!resolved) {
        const u = document.createElement('span');
        u.className = 'graph-title-undefined';
        u.textContent = 'undefined';
        titleSpan.appendChild(u);
      } else {
        const label = this.#ExperimentDisplayName(resolved, slot, state);
        titleSpan.appendChild(document.createTextNode(label));
      }
    });

    // ── Separator between experiments and metrics ────────────────
    const sep = document.createElement('span');
    sep.className = 'graph-title-section-sep';
    sep.textContent = '\u2502';  // │
    titleSpan.appendChild(sep);

    // ── Metric labels ────────────────────────────────────────────
    graphConfig.metrics.forEach((m, i) => {
      if (i > 0) titleSpan.appendChild(document.createTextNode(' \u2022 '));
      let varName = null;
      if (typeof m === 'object' && m !== null && m.variable) varName = m.variable;
      if (varName) {
        const badge = document.createElement('span');
        badge.className = 'graph-title-var-badge';
        badge.textContent = varName;
        titleSpan.appendChild(badge);
        // Show resolved metric name (or display name if set) after the badge
        const resolvedPath = state?.variables?.metrics?.get(varName);
        titleSpan.appendChild(document.createTextNode('\u00a0'));
        if (resolvedPath) {
          titleSpan.appendChild(document.createTextNode(this.#MetricDisplayName(resolvedPath)));
        } else {
          const u = document.createElement('span');
          u.className = 'graph-title-undefined';
          u.textContent = 'undefined';
          titleSpan.appendChild(u);
        }
      } else {
        const metricPath = typeof m === 'string' ? m : '?';
        titleSpan.appendChild(document.createTextNode(this.#MetricDisplayName(metricPath)));
      }
    });

    // ── Duplicate-metric warning ─────────────────────────────────
    if (this.#HasDuplicateMetrics(graphConfig)) {
      const warn = document.createElement('span');
      warn.className = 'graph-title-warn-badge';
      warn.textContent = ICONS.WARN;
      warn.title = 'Duplicate metrics — only the first occurrence is displayed';
      titleSpan.appendChild(warn);
    }

    // ── Missing-data warning ──────────────────────────────────────
    // Show ⚠ if any resolved experiment has no data available (fetch failed or combination unknown)
    const missingExps = resolvedEntries
      .filter(({ resolved }) => resolved && !dataMap?.get(experimentKey(resolved)))
      .map(({ resolved }) => `${CommitHelp.ShortHash(resolved.commit)}/${resolved.tasktype}/${resolved.subtask}`);
    if (missingExps.length > 0) {
      const warn = document.createElement('span');
      warn.className = 'graph-title-warn-badge';
      warn.textContent = ICONS.WARN;
      warn.title = `No data: ${missingExps.join(', ')}`;
      titleSpan.appendChild(warn);
    }
  }

  /**
   * Builds the Plotly trace array for all experiments and metrics.
   *
   * Rendering strategy:
   *   - Undefined variable / missing data → placeholder trace (red/orange, no fetch needed)
   *   - Any number of resolved experiments → mean + CI per experiment
   *   - OR mode + metric absent from an experiment → zero-value trace marked ⚠
   */
  #PrepareTraces(graphConfig, dataMap, resolvedEntries) {
    const state    = this.#callbacks?.getState?.();
    const { splitAxes, metricsMode, showCI, showRaw } = graphConfig;

    // Resolve MetricVarRef entries (stored as JSON-encoded {variable:name} strings)
    const metrics = this.#ResolveMetrics(graphConfig);

    // Compute timestamps from first available data entry
    let timestamps = [];
    for (const { resolved } of resolvedEntries) {
      if (!resolved) continue;
      const expKey = experimentKey(resolved);
      const data = dataMap?.get(expKey);
      if (data?.header) {
        const { min, max, step } = data.header;
        for (let t = min; t < max; t += step) timestamps.push(t / 1_000_000);
        break;
      }
    }

    const traces = [];

    resolvedEntries.forEach(({ resolved, slot, commitVarName, subtaskVarName, idx }) => {
      const anyVarName = commitVarName ?? subtaskVarName;
      // ── Placeholder: undefined variable ──────────────────────────
      if (!resolved) {
        traces.push({
          x: [], y: [],
          mode: 'lines',
          name: `\u2717 ${anyVarName ? anyVarName : `exp${idx + 1}`} (undefined)`,
          line: { color: '#d62728', width: 2, dash: 'dot' },
          showlegend: true,
        });
        return;
      }

      const expKey = experimentKey(resolved);
      const data   = dataMap?.get(expKey);

      // ── Placeholder: resolved experiment but data unavailable ─────
      if (!data) {
        const short    = CommitHelp.ShortHash(resolved.commit);
        const regEntry = state?.commitRegistry?.get(expKey);
        traces.push({
          x: [], y: [],
          mode: 'lines',
          name: `\u2717 ${short}/${resolved.tasktype}/${resolved.subtask} (no data)`,
          line: { color: '#ff7f0e', width: 2, dash: 'dot' },
          showlegend: true,
          visible: regEntry?.visible === false ? 'legendonly' : true,
        });
        return;
      }

      const { series } = data;
      const regEntry  = state?.commitRegistry?.get(expKey);
      const expHidden = regEntry?.visible === false;

      const color     = regEntry?.color ?? GraphManager.#PALETTE[idx % GraphManager.#PALETTE.length];
      const fillColor = GraphManager.#HexToRgba(color, 0.2);
      const expLabel  = this.#ExperimentDisplayName(resolved, slot, state);

      // ── Render: mean + CI per experiment ───────────────────────
      metrics.forEach((metricName, metricIdx) => {
        const metricHidden   = state?.metricLegend?.get(metricName)?.visible === false;
        const traceVisible   = (expHidden || metricHidden) ? 'legendonly' : true;

        const yAxis = splitAxes
          ? (metricIdx === 0 ? 'y' : 'y' + (metricIdx + 1))
          : 'y';
        const dash  = this.#MetricDash(metricName, metricIdx);
        const group = `e${idx}_m${metricIdx}`;
        const metricLabel = this.#MetricDisplayName(metricName);

        const meanKey  = `${metricName}.mean`;
        const lowerKey = `${metricName}.ci_lower`;
        const upperKey = `${metricName}.ci_upper`;
        const meanData = series[meanKey];

        if (!meanData) {
          // OR mode: absent metric → zero-value trace with ⚠ marker
          if (metricsMode === 'OR') {
            const traceName = graphConfig.metrics.length === 1 ? expLabel : `${expLabel} \u00b7 ${metricLabel}`;
            traces.push({
              x: timestamps,
              y: Array(timestamps.length).fill(0),
              mode: 'lines',
              name: `â  ${traceName} (absent)`,
              line: { width: 1.5, color, dash: 'dot' },
              opacity: 0.4,
              yaxis: yAxis,
              legendgroup: group,
              visible: traceVisible,
            });
          }
          return;
        }

        const meanArr   = Array.isArray(meanData[0]) ? meanData[0] : meanData;
        const traceName = graphConfig.metrics.length === 1 ? expLabel : `${expLabel} \u00b7 ${metricLabel}`;

        if (showCI === true && series[lowerKey] && series[upperKey]) {
          const ciLower = Array.isArray(series[lowerKey][0]) ? series[lowerKey][0] : series[lowerKey];
          const ciUpper = Array.isArray(series[upperKey][0]) ? series[upperKey][0] : series[upperKey];
          traces.push({ x: timestamps, y: ciUpper, mode: 'lines', line: { width: 0 }, showlegend: false, hoverinfo: 'skip', yaxis: yAxis, legendgroup: group, visible: traceVisible });
          traces.push({ x: timestamps, y: meanArr, mode: 'lines', name: traceName, line: { width: 2.5, color, dash }, fill: 'tonexty', fillcolor: fillColor, yaxis: yAxis, legendgroup: group, visible: traceVisible });
          traces.push({ x: timestamps, y: ciLower, mode: 'lines', line: { width: 0 }, showlegend: false, fill: 'tonexty', fillcolor: fillColor, hoverinfo: 'skip', yaxis: yAxis, legendgroup: group, visible: traceVisible });
        } else {
          traces.push({ x: timestamps, y: meanArr, mode: 'lines', name: traceName, line: { width: 2.5, color, dash }, yaxis: yAxis, legendgroup: group, visible: traceVisible });
        }

        if (showRaw) {
          const rawData = series[metricName];
          if (rawData && Array.isArray(rawData[0])) {
            rawData.forEach(runData => {
              traces.push({
                x: timestamps, y: runData,
                mode: 'lines',
                name: `${expLabel} raw`,
                line: { width: 1, color, dash: 'dot' },
                opacity: 0.3,
                showlegend: false,
                yaxis: yAxis,
                legendgroup: group,
                visible: traceVisible,
              });
            });
          }
        }
      });
    });

    return traces;
  }

  /** Unified draw function — replaces the former #DrawGraph / #DrawCompareGraph pair. */
  async #Draw(container, graphConfig, dataMap, stored = null) {
    const hiddenBefore = stored?.hiddenGroups ? new Set(stored.hiddenGroups) : new Set();

    const resolvedEntries = this.#ResolveExperiments(graphConfig);
    const traces = this.#PrepareTraces(graphConfig, dataMap, resolvedEntries);

    const resolvedMetrics = this.#ResolveMetrics(graphConfig);
    const { splitAxes } = graphConfig;
    const splitActive = splitAxes && resolvedMetrics.length > 1;

    const layout = {
      xaxis:     { title: 'Time (s)', type: 'linear', ticksuffix: 's' },
      yaxis:     { title: splitActive ? this.#MetricDisplayName(resolvedMetrics[0]) : 'Value', type: 'linear' },
      hovermode: 'x unified',
      hoverlabel: { namelength: -1 },
      showlegend: true,
      // Legend always sits outside the plot area to the right so traces are never covered.
      // Split: further right to clear the extra Y-axes; non-split: just past the right edge.
      legend:    { x: splitActive ? 1.12 : 1.01, xanchor: 'left', y: 1 },
      margin:    { l: 60, r: splitActive ? 80 : 160, t: 40, b: 40 },
      autosize:  true,
      height:    400,
    };

    if (splitActive) {
      const metricLabels = resolvedMetrics.map(m => this.#MetricDisplayName(m));
      const { xDomain, axes } = GraphManager.#BuildSplitAxisLayout(metricLabels);
      layout.xaxis.domain = xDomain;
      Object.assign(layout, axes);
    }

    const plotlyConfig = {
      responsive: true,
      displayModeBar: true,
      modeBarButtonsToRemove: ['lasso2d', 'select2d'],
    };

    await Plotly.newPlot(container, traces, layout, plotlyConfig);

    // Re-attach legend-click tracker (newPlot resets all listeners)
    if (stored) {
      container.on('plotly_legendclick', function(data) {
        const trace = data.data[data.curveNumber];
        const key   = trace?.legendgroup ?? trace?.name;
        if (!key) return;
        const currentlyHidden = trace.visible === 'legendonly' || trace.visible === false;
        if (currentlyHidden) {
          stored.hiddenGroups.delete(key);
        } else {
          stored.hiddenGroups.add(key);
        }
      });
    }

    // Restore previously hidden traces by legendgroup (or name as fallback)
    if (hiddenBefore.size > 0) {
      const toHide = (container.data ?? [])
        .map((t, i) => hiddenBefore.has(t.legendgroup ?? t.name) ? i : -1)
        .filter(i => i >= 0);
      if (toHide.length > 0) {
        Plotly.restyle(container, { visible: 'legendonly' }, toHide);
      }
    }
  }

  /** Builds a title-bar icon button. */
  static #MakeIconBtn({ id, icon, title, onclick, className = 'graph-icon-btn' }) {
    const btn = document.createElement('button');
    btn.className   = className;
    btn.id          = id;
    btn.textContent = icon;
    btn.title       = title;
    btn.onclick     = onclick;
    return btn;
  }

  #BuildGraphContainer(id, options) {
    const container = document.createElement('div');
    container.id        = 'graph-container_' + id;
    container.className = 'graph-container';
    container.style.width = '100%';

    // graphArea created first so collapse button closure can reference it
    const graphArea = document.createElement('div');
    graphArea.id        = 'graph_area_' + id;
    graphArea.className = 'graph-area';

    const requireUI = options?.showIcons || options?.title || options?.showRawToggle
      || options?.showCIToggle || options?.showAxesToggle;

    if (requireUI) {
      // ── Title bar ───────────────────────────────────────────────
      const titleBar = document.createElement('div');
      titleBar.className = 'graph-title-bar';

      const titleSpan = document.createElement('span');
      titleSpan.className   = 'graph-title-text';
      titleSpan.textContent = options?.title ?? '';
      titleBar.appendChild(titleSpan);

      if (options?.showIcons) {
        const controlsDiv = document.createElement('div');
        controlsDiv.className = 'graph-title-controls';

        // ▲ Move up · ▼ Move down · ⧉ Duplicate
        controlsDiv.appendChild(GraphManager.#MakeIconBtn({
          id: 'graph_ui_up_' + id, icon: ICONS.ARROW_UP, title: 'Move up',
          onclick: this.MoveGraph.bind(this, id, -1),
        }));
        controlsDiv.appendChild(GraphManager.#MakeIconBtn({
          id: 'graph_ui_down_' + id, icon: ICONS.ARROW_DOWN, title: 'Move down',
          onclick: this.MoveGraph.bind(this, id, +1),
        }));
        controlsDiv.appendChild(GraphManager.#MakeIconBtn({
          id: 'graph_ui_duplicate_' + id, icon: ICONS.COPY, title: 'Duplicate graph',
          onclick: () => this.DuplicateGraph(id),
        }));

        // ⚙ Edit button (Phase E) — only when editGraph callback is provided
        if (this.#callbacks?.editGraph) {
          controlsDiv.appendChild(GraphManager.#MakeIconBtn({
            id: 'graph_ui_edit_' + id, icon: ICONS.GEAR, title: 'Edit graph settings',
            className: 'graph-icon-btn graph-icon-btn-edit',
            onclick: () => this.#callbacks.editGraph(id),
          }));
        }

        // ➖ Collapse button
        const eltCollapse = GraphManager.#MakeIconBtn({
          id: 'graph_ui_collapse_' + id, icon: ICONS.MINUS, title: 'Minimize',
          onclick: function() {
            const isVisible = graphArea.style.display !== 'none';
            graphArea.style.display = isVisible ? 'none' : '';
            // Also collapse/expand the toggle bar (Split Y-Axes / All Runs / Confidence Bands)
            const toggleBar = container.querySelector('.graph-toggle-bar');
            if (toggleBar) toggleBar.style.display = isVisible ? 'none' : '';
            eltCollapse.textContent = isVisible ? ICONS.PLUS : ICONS.MINUS;
            eltCollapse.title       = isVisible ? 'Expand'  : 'Minimize';
            if (!isVisible) Plotly.Plots.resize(graphArea);
          },
        });
        controlsDiv.appendChild(eltCollapse);

        // ✖ Delete button
        controlsDiv.appendChild(GraphManager.#MakeIconBtn({
          id: 'graph_ui_delete_' + id, icon: ICONS.CLOSE_HEAVY, title: 'Delete graph',
          className: 'graph-icon-btn graph-icon-btn-delete',
          onclick: this.DelGraph.bind(this, id),
        }));

        titleBar.appendChild(controlsDiv);
      }

      container.appendChild(titleBar);

      // ── Toggle bar ──────────────────────────────────────────────
      const showAnyToggle = options?.showAxesToggle || options?.showRawToggle || options?.showCIToggle;
      if (showAnyToggle) {
        const toggleBar = document.createElement('div');
        toggleBar.className = 'graph-toggle-bar';

        if (options?.showAxesToggle) {
          const eltSplit = document.createElement('button');
          eltSplit.className = 'graph-toggle-btn';
          eltSplit.id        = 'graph_ui_split_' + id;
          eltSplit.textContent = 'Split Y-Axes';
          eltSplit.title     = 'Use one Y-axis per metric (useful when scales differ)';
          eltSplit.onclick   = this.ToggleSplitAxes.bind(this, id);
          toggleBar.appendChild(eltSplit);
        }

        if (options?.showRawToggle) {
          const eltRaw = document.createElement('button');
          eltRaw.className = 'graph-toggle-btn';
          eltRaw.id        = 'graph_ui_raw_' + id;
          eltRaw.textContent = 'All Runs';
          eltRaw.title     = 'Show each individual run as a separate trace';
          eltRaw.onclick   = this.ToggleRawTraces.bind(this, id);
          toggleBar.appendChild(eltRaw);
        }

        if (options?.showCIToggle) {
          const eltCI = document.createElement('button');
          eltCI.className = 'graph-toggle-btn';
          eltCI.id        = 'graph_ui_ci_' + id;
          eltCI.textContent = 'Confidence Bands';
          eltCI.title     = 'Show 95% confidence interval around the mean';
          eltCI.onclick   = this.ToggleCIShadow.bind(this, id);
          toggleBar.appendChild(eltCI);
        }

        container.appendChild(toggleBar);
      }
    }

    container.appendChild(graphArea);
    return { container, graphArea };
  }

  static #BuildSplitAxisLayout(metrics) {
    const n   = metrics.length;
    const PAD = 0.08;

    // metrics[1],[3],[5]... → right axes; metrics[2],[4],[6]... → extra left axes
    const rightCount     = Math.ceil((n - 1) / 2);
    const extraLeftCount = Math.floor((n - 1) / 2);

    const domainStart = extraLeftCount > 0 ? extraLeftCount * PAD : 0;
    const domainEnd   = rightCount > 1 ? 1 - (rightCount - 1) * PAD : 1;

    const axes = { yaxis: { title: { text: metrics[0], standoff: 8 }, type: 'linear' } };

    metrics.slice(1).forEach((metric, i) => {
      const axisKey = 'yaxis' + (i + 2);
      const isRight = i % 2 === 0;

      const position = isRight
        ? domainEnd + (i / 2) * PAD
        : domainStart - ((i - 1) / 2 + 1) * PAD;

      axes[axisKey] = {
        overlaying: 'y',
        side:       isRight ? 'right' : 'left',
        title:      { text: metric, standoff: 8 },
        type:       'linear',
        anchor:     'free',
        position,
      };
    });

    return { xDomain: [domainStart, domainEnd], axes };
  }

  static #HexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
}

export { GraphManager };
