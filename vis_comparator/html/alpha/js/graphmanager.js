// Shared commit colour palette — imported by index.js for commitRegistry assignment.
import {CommitHelp} from "./commithelp.js";

const COMMIT_PALETTE = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728'];

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
  static #nextid = 0;

  // Four distinct colours for up to 4 experiments. Beyond 4, colours cycle.
  static #PALETTE = COMMIT_PALETTE;

  // Four distinct dash styles, one per metric. Beyond 4 metrics, styles cycle.
  static #DASH_PALETTE = ['solid', 'dot', 'dash', 'dashdot'];

  /**
   * @param {HTMLElement} container  - Container element where graph divs are appended
   * @param {object}      callbacks  - {
   *   delete(id),          called when a graph is removed
   *   getState(),          returns current app state ({ variables, commitRegistry })
   *   editGraph(id),       called when the ⚙ button is clicked (optional)
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
   * @returns {Promise<number>} Numeric graph ID
   */
  async AddGraph(graphConfig, dataMap) {
    const id = GraphManager.#nextid++;
    const resolvedEntries = this.#ResolveExperiments(graphConfig);
    const title = this.#BuildTitle(graphConfig, resolvedEntries);

    const { container: graphContainer, graphArea } = this.#BuildGraphContainer(id, {
      showIcons:     true,
      showAxesToggle: true,
      showRawToggle:  true,
      showCIToggle:   true,
      title,
    });
    this.#document.appendChild(graphContainer);

    const stored = { graphConfig, dataMap, graphContainer, graphArea, hiddenGroups: new Set() };
    this.#configs.set(id, stored);

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
   * Recolours/renames traces without re-fetching data.
   * Call after modifying state.commitRegistry (colour or displayName).
   * @param {number} id
   */
  async RefreshGraphAppearance(id) {
    const stored = this.#configs.get(id);
    if (!stored) return;
    const resolvedEntries = this.#ResolveExperiments(stored.graphConfig);
    const newTitle = this.#BuildTitle(stored.graphConfig, resolvedEntries);
    const titleSpan = stored.graphContainer.querySelector('.graph_title_text');
    if (titleSpan) titleSpan.textContent = newTitle;
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
    const newTitle = this.#BuildTitle(graphConfig, resolvedEntries);
    const titleSpan = stored.graphContainer.querySelector('.graph_title_text');
    if (titleSpan) titleSpan.textContent = newTitle;

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

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Resolves experiment slots to concrete ExperimentDef objects.
   * VarRefs are looked up in state.variables.experiments; undefined → null.
   * @returns {Array<{ resolved: object|null, slot, idx, isVar, varName }>}
   */
  #ResolveExperiments(graphConfig) {
    const state = this.#callbacks?.getState?.();
    return graphConfig.experiments.map((slot, idx) => {
      if ('variable' in slot) {
        const def = state?.variables?.experiments?.get(slot.variable) ?? null;
        return { resolved: def, slot, idx, isVar: true, varName: slot.variable };
      }
      return { resolved: slot, slot, idx, isVar: false, varName: null };
    });
  }

  /**
   * Builds the display title for the graph container header.
   * Uses commitRegistry displayName when available.
   */
  #BuildTitle(graphConfig, resolvedEntries) {
    const state = this.#callbacks?.getState?.();
    const expLabels = resolvedEntries.map(({ resolved, isVar, varName }) => {
      if (!resolved) return isVar ? `${varName}(?)` : '(?)';
      const displayName = state?.commitRegistry?.get(resolved.commit)?.displayName;
      const short = CommitHelp.ShortHash(resolved.commit);
      return displayName ?? `${short}/${resolved.type}/${resolved.subject}`;
    });
    const metricStr = graphConfig.metrics.join(' \u2022 ');
    return expLabels.length === 1
      ? `[${expLabels[0]}] ${metricStr}`
      : `[${expLabels.join(', ')}] ${metricStr}`;
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
    const metrics = graphConfig.metrics.map(m => {
      if (typeof m === 'object' && m !== null && 'variable' in m) {
        return state?.variables?.metrics?.get(m.variable) ?? null;
      }
      if (typeof m === 'string') {
        try {
          const parsed = JSON.parse(m);
          if (parsed?.variable) return state?.variables?.metrics?.get(parsed.variable) ?? null;
        } catch (_) {}
      }
      return m;
    }).filter(Boolean);

    // Compute timestamps from first available data entry
    let timestamps = [];
    for (const { resolved } of resolvedEntries) {
      if (!resolved) continue;
      const expKey = `${resolved.commit}:${resolved.type}:${resolved.subject}`;
      const data = dataMap?.get(expKey);
      if (data?.header) {
        const { min, max, step } = data.header;
        for (let t = min; t < max; t += step) timestamps.push(t / 1_000_000);
        break;
      }
    }

    const traces = [];

    resolvedEntries.forEach(({ resolved, isVar, varName, idx }) => {
      // ── Placeholder: undefined variable ──────────────────────────
      if (!resolved) {
        traces.push({
          x: [], y: [],
          mode: 'lines',
          name: `\u2717 ${isVar ? varName : `exp${idx + 1}`} (undefined)`,
          line: { color: '#d62728', width: 2, dash: 'dot' },
          showlegend: true,
        });
        return;
      }

      const expKey = `${resolved.commit}:${resolved.type}:${resolved.subject}`;
      const data   = dataMap?.get(expKey);

      // ── Placeholder: resolved experiment but data unavailable ─────
      if (!data) {
        const short = CommitHelp.ShortHash(resolved.commit);
        traces.push({
          x: [], y: [],
          mode: 'lines',
          name: `\u2717 ${short}/${resolved.type}/${resolved.subject} (no data)`,
          line: { color: '#ff7f0e', width: 2, dash: 'dot' },
          showlegend: true,
        });
        return;
      }

      const { series } = data;
      const color = state?.commitRegistry?.get(resolved.commit)?.color
        ?? GraphManager.#PALETTE[idx % GraphManager.#PALETTE.length];
      const fillColor = GraphManager.#HexToRgba(color, 0.2);
      const expLabel  = state?.commitRegistry?.get(resolved.commit)?.displayName
        ?? `${CommitHelp.ShortHash(resolved.commit)}/${resolved.type}/${resolved.subject}`;

      // ── Render: mean + CI per experiment ───────────────────────
      metrics.forEach((metricName, metricIdx) => {
        const yAxis = splitAxes
          ? (metricIdx === 0 ? 'y' : 'y' + (metricIdx + 1))
          : 'y';
        const dash  = GraphManager.#DASH_PALETTE[metricIdx % GraphManager.#DASH_PALETTE.length];
        const group = `e${idx}_m${metricIdx}`;

        const meanKey  = `${metricName}.mean`;
        const lowerKey = `${metricName}.ci_lower`;
        const upperKey = `${metricName}.ci_upper`;
        const meanData = series[meanKey];

        if (!meanData) {
          // OR mode: absent metric → zero-value trace with ⚠ marker
          if (metricsMode === 'OR') {
            const traceName = metrics.length === 1 ? expLabel : `${expLabel}/${metricName}`;
            traces.push({
              x: timestamps,
              y: Array(timestamps.length).fill(0),
              mode: 'lines',
              name: `\u26a0 ${traceName} (absent)`,
              line: { width: 1.5, color, dash: 'dot' },
              opacity: 0.4,
              yaxis: yAxis,
              legendgroup: group,
            });
          }
          return;
        }

        const meanArr   = Array.isArray(meanData[0]) ? meanData[0] : meanData;
        const traceName = metrics.length === 1 ? expLabel : `${expLabel}/${metricName}`;

        if (showCI === true && series[lowerKey] && series[upperKey]) {
          const ciLower = Array.isArray(series[lowerKey][0]) ? series[lowerKey][0] : series[lowerKey];
          const ciUpper = Array.isArray(series[upperKey][0]) ? series[upperKey][0] : series[upperKey];
          traces.push({ x: timestamps, y: ciUpper, mode: 'lines', line: { width: 0 }, showlegend: false, hoverinfo: 'skip', yaxis: yAxis, legendgroup: group });
          traces.push({ x: timestamps, y: meanArr, mode: 'lines', name: traceName, line: { width: 2.5, color, dash }, fill: 'tonexty', fillcolor: fillColor, yaxis: yAxis, legendgroup: group });
          traces.push({ x: timestamps, y: ciLower, mode: 'lines', line: { width: 0 }, showlegend: false, fill: 'tonexty', fillcolor: fillColor, hoverinfo: 'skip', yaxis: yAxis, legendgroup: group });
        } else {
          traces.push({ x: timestamps, y: meanArr, mode: 'lines', name: traceName, line: { width: 2.5, color, dash }, yaxis: yAxis, legendgroup: group });
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

    const { metrics, splitAxes } = graphConfig;
    const splitActive = splitAxes && metrics.length > 1;

    const layout = {
      xaxis:     { title: 'Time (s)', type: 'linear', ticksuffix: 's' },
      yaxis:     { title: splitActive ? metrics[0] : 'Value', type: 'linear' },
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
      const { xDomain, axes } = GraphManager.#BuildSplitAxisLayout(metrics);
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

  #BuildGraphContainer(id, options) {
    const container = document.createElement('div');
    container.id        = 'graph_container_' + id;
    container.className = 'graph_container';
    container.style.width = '100%';

    // graphArea created first so collapse button closure can reference it
    const graphArea = document.createElement('div');
    graphArea.id           = 'graph_area_' + id;
    graphArea.style.width  = '100%';
    graphArea.style.height = '400px';

    const requireUI = options?.showIcons || options?.title || options?.showRawToggle
      || options?.showCIToggle || options?.showAxesToggle;

    if (requireUI) {
      // ── Title bar ───────────────────────────────────────────────
      const titleBar = document.createElement('div');
      titleBar.className = 'graph_title_bar';

      const titleSpan = document.createElement('span');
      titleSpan.className   = 'graph_title_text';
      titleSpan.textContent = options?.title ?? '';
      titleBar.appendChild(titleSpan);

      if (options?.showIcons) {
        const controlsDiv = document.createElement('div');
        controlsDiv.className = 'graph_title_controls';

        // ⚙ Edit button (Phase E) — only when editGraph callback is provided
        if (this.#callbacks?.editGraph) {
          const eltEdit = document.createElement('button');
          eltEdit.className   = 'graph_icon_btn graph_icon_btn_edit';
          eltEdit.id          = 'graph_ui_edit_' + id;
          eltEdit.textContent = '\u2699';
          eltEdit.title       = 'Edit graph settings';
          eltEdit.onclick     = () => this.#callbacks.editGraph(id);
          controlsDiv.appendChild(eltEdit);
        }

        // ➖ Collapse button
        const eltCollapse = document.createElement('button');
        eltCollapse.className   = 'graph_icon_btn';
        eltCollapse.id          = 'graph_ui_collapse_' + id;
        eltCollapse.textContent = '\u2796';
        eltCollapse.title       = 'Minimize';
        eltCollapse.onclick = function() {
          const isVisible = graphArea.style.display !== 'none';
          graphArea.style.display = isVisible ? 'none' : '';
          // Also collapse/expand the toggle bar (Split Y-Axes / All Runs / Confidence Bands)
          const toggleBar = container.querySelector('.graph_toggle_bar');
          if (toggleBar) toggleBar.style.display = isVisible ? 'none' : '';
          eltCollapse.textContent = isVisible ? '\u2795' : '\u2796';
          eltCollapse.title       = isVisible ? 'Expand'  : 'Minimize';
          if (!isVisible) Plotly.Plots.resize(graphArea);
        };
        controlsDiv.appendChild(eltCollapse);

        // ✖ Delete button
        const eltDelete = document.createElement('button');
        eltDelete.className   = 'graph_icon_btn graph_icon_btn_delete';
        eltDelete.id          = 'graph_ui_delete_' + id;
        eltDelete.textContent = '\u2716';
        eltDelete.title       = 'Delete graph';
        eltDelete.onclick     = this.DelGraph.bind(this, id);
        controlsDiv.appendChild(eltDelete);

        titleBar.appendChild(controlsDiv);
      }

      container.appendChild(titleBar);

      // ── Toggle bar ──────────────────────────────────────────────
      const showAnyToggle = options?.showAxesToggle || options?.showRawToggle || options?.showCIToggle;
      if (showAnyToggle) {
        const toggleBar = document.createElement('div');
        toggleBar.className = 'graph_toggle_bar';

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

export { GraphManager, COMMIT_PALETTE };
