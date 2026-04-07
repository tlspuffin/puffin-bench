class GraphManager {
  #configs;
  #document;
  #callbacks;
  static #nextid = 0;
  static #PALETTE = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728'];
  static #DASH_PALETTE = ['solid', 'dot', 'dash', 'dashdot'];

  constructor(document, callbacks) {
    this.#configs = new Map();
    this.#document = document;
    this.#callbacks = callbacks;
  }

  async AddGraph(config, header, series) {
    const id = GraphManager.#nextid++;
    const shortHash = config.commit.slice(0, 8);
    const { container: graphContainer, graphArea } = this.#BuildGraphContainer(id, {
      showIcons: true,
      showAxesToggle: true,
      showRawToggle: true,
      showCIToggle: true,
      title: `[${shortHash}] ${config.metrics.join(' \u2022 ')}`
    });
    this.#document.appendChild(graphContainer);

    const stored = { config, header, series, graphContainer, graphArea, hiddenGroups: new Set() };
    this.#configs.set(id, stored);

    await this.#DrawGraph(graphArea, config, header, series, stored);

    const eltSplit = document.getElementById('graph_ui_split_' + id);
    if (eltSplit) {
      if (config.metrics.length <= 1) {
        eltSplit.disabled = true;
      } else if (config.splitAxes) {
        eltSplit.classList.add('active');
      }
    }
    if (config.showRaw !== false) {
      document.getElementById('graph_ui_raw_' + id)?.classList.add('active');
    }
    if (config.showCI !== false) {
      document.getElementById('graph_ui_ci_' + id)?.classList.add('active');
    }

    return id;
  }

  async AddCompareGraph(config, commitsData) {
    const id = GraphManager.#nextid++;
    const shortHashes = config.compareCommits.map(c => c.slice(0, 8)).join(', ');
    const title = `[${shortHashes}] ${config.metrics.join(' \u2022 ')}`;
    const { container: graphContainer, graphArea } = this.#BuildGraphContainer(id, {
      showIcons: true,
      showAxesToggle: true,
      showRawToggle: true,
      showCIToggle: true,
      title
    });
    this.#document.appendChild(graphContainer);

    const stored = { config, graphContainer, graphArea, mode: 'compare', commitsData, hiddenGroups: new Set() };
    this.#configs.set(id, stored);

    await this.#DrawCompareGraph(graphArea, config, commitsData, stored);

    const eltSplit = document.getElementById('graph_ui_split_' + id);
    if (eltSplit) {
      if (config.metrics.length <= 1) {
        eltSplit.disabled = true;
      } else if (config.splitAxes) {
        eltSplit.classList.add('active');
      }
    }

    return id;
  }

  DelGraph(id) {
    const stored = this.#configs.get(id);
    Plotly.purge(stored.graphArea);
    stored.graphContainer.remove();
    this.#configs.delete(id);
    this.#callbacks?.delete?.(id);
  }

  DelAllGraph() {
    const ids = Array.from(this.#configs.keys());
    for (const id of ids) {
      this.DelGraph(id);
    }
  }

  ToggleRawTraces(id) {
    const stored = this.#configs.get(id);
    if (!stored) return;
    stored.config.showRaw = !stored.config.showRaw;
    document.getElementById('graph_ui_raw_' + id)
      ?.classList.toggle('active', stored.config.showRaw);
    stored.mode === 'compare'
      ? this.#DrawCompareGraph(stored.graphArea, stored.config, stored.commitsData, stored)
      : this.#DrawGraph(stored.graphArea, stored.config, stored.header, stored.series, stored);
  }

  ToggleCIShadow(id) {
    const stored = this.#configs.get(id);
    if (!stored) return;
    stored.config.showCI = !(stored.config.showCI ?? false);
    document.getElementById('graph_ui_ci_' + id)
      ?.classList.toggle('active', stored.config.showCI !== false);
    stored.mode === 'compare'
      ? this.#DrawCompareGraph(stored.graphArea, stored.config, stored.commitsData, stored)
      : this.#DrawGraph(stored.graphArea, stored.config, stored.header, stored.series, stored);
  }

  ToggleSplitAxes(id) {
    const stored = this.#configs.get(id);
    if (!stored) return;
    stored.config.splitAxes = !stored.config.splitAxes;
    const eltSplit = document.getElementById('graph_ui_split_' + id);
    if (eltSplit) eltSplit.classList.toggle('active', stored.config.splitAxes);
    if (stored.mode === 'compare') {
      this.#DrawCompareGraph(stored.graphArea, stored.config, stored.commitsData, stored);
    } else {
      this.#DrawGraph(stored.graphArea, stored.config, stored.header, stored.series, stored);
    }
  }

  async #DrawGraph(container, config, header, series, stored = null) {
    // Capture hidden traces before the redraw wipes them out
    const hiddenBefore = stored?.hiddenGroups ? new Set(stored.hiddenGroups) : new Set();

    const traces = this.#PrepareTracesForPlotly(config, header, series);
    const layout = {
      title: `${config.commit}`,
      xaxis: { title: 'Time (s)', type: 'linear', ticksuffix: 's' },
      yaxis: { title: 'Value', type: 'linear' },
      hovermode: 'x unified',
      hoverlabel: { namelength: -1 },
      showlegend: true,
      legend: { x: 1, xanchor: 'right', y: 1 },
      margin: { l: 60, r: 20, t: 40, b: 40 },
      autosize: true,
      height: 400
    };
    if (config.splitAxes && config.metrics.length > 1) {
      const { xDomain, axes } = GraphManager.#BuildSplitAxisLayout(config.metrics);
      layout.xaxis.domain = xDomain;
      Object.assign(layout, axes);
      layout.margin.r = 80;
      layout.legend = { x: 1.12, xanchor: 'left', y: 1 };
    }
    const plotlyConfig = {
      responsive: true,
      displayModeBar: true,
      modeBarButtonsToRemove: ['lasso2d', 'select2d']
    };
    await Plotly.newPlot(container, traces, layout, plotlyConfig);

    // Re-attach legend click tracker (newPlot resets listeners)
    if (stored) {
      container.on('plotly_legendclick', function(data) {
        const trace = data.data[data.curveNumber];
        const key = trace?.legendgroup ?? trace?.name;
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

  async #DrawCompareGraph(container, config, commitsData, stored = null) {
    // Capture hidden traces before the redraw wipes them out
    const hiddenBefore = stored?.hiddenGroups ? new Set(stored.hiddenGroups) : new Set();

    const traces = this.#PrepareTracesForCompare(config, commitsData);
    const splitAxes = config.splitAxes && config.metrics.length > 1;
    const layout = {
      title: `Compare: ${config.metrics.join(' | ')}`,
      xaxis: { title: 'Time (s)', type: 'linear', ticksuffix: 's' },
      yaxis: { title: splitAxes ? config.metrics[0] : 'Value', type: 'linear' },
      hovermode: 'x unified',
      hoverlabel: { namelength: -1 },
      showlegend: true,
      legend: { x: splitAxes ? 1.12 : 1, xanchor: splitAxes ? 'left' : 'right', y: 1 },
      margin: { l: 60, r: splitAxes ? 80 : 20, t: 40, b: 40 },
      autosize: true,
      height: 400
    };
    if (splitAxes) {
      const { xDomain, axes } = GraphManager.#BuildSplitAxisLayout(config.metrics);
      layout.xaxis.domain = xDomain;
      Object.assign(layout, axes);
    }
    const plotlyConfig = {
      responsive: true,
      displayModeBar: true,
      modeBarButtonsToRemove: ['lasso2d', 'select2d']
    };
    await Plotly.newPlot(container, traces, layout, plotlyConfig);

    // Re-attach legend click tracker (newPlot resets listeners)
    if (stored) {
      container.on('plotly_legendclick', function(data) {
        const trace = data.data[data.curveNumber];
        const key = trace?.legendgroup ?? trace?.name;
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
    container.id = 'graph_container_' + id;
    container.className = 'graph_container';
    container.style.width = '100%';

    // graphArea created first so collapse button closure can reference it
    const graphArea = document.createElement('div');
    graphArea.id = 'graph_area_' + id;
    graphArea.style.width = '100%';
    graphArea.style.height = '400px';

    const requireUI = options?.showIcons || options?.title || options?.showRawToggle || options?.showCIToggle || options?.showAxesToggle;
    if (requireUI) {
      const ui = document.createElement('div');
      ui.id = 'graph_ui_' + id;

      if (options?.showIcons) {
        const eltDelete = document.createElement('span');
        eltDelete.className = 'graph_ui_icons';
        eltDelete.id = 'graph_ui_delete_' + id;
        eltDelete.innerHTML = '<span>\u2716</span><span class="graph_ui_icon_label">Delete</span>';
        eltDelete.onclick = this.DelGraph.bind(this, id);
        ui.appendChild(eltDelete);

        const eltCollapse = document.createElement('span');
        eltCollapse.className = 'graph_ui_icons';
        eltCollapse.id = 'graph_ui_collapse_' + id;
        eltCollapse.innerHTML = '<span>\u2796</span><span class="graph_ui_icon_label">Minimize</span>';
        eltCollapse.onclick = function() {
          const isVisible = graphArea.style.display !== 'none';
          graphArea.style.display = isVisible ? 'none' : '';
          eltCollapse.innerHTML = isVisible
            ? '<span>\u2795</span><span class="graph_ui_icon_label">Expand</span>'
            : '<span>\u2796</span><span class="graph_ui_icon_label">Minimize</span>';
          if (!isVisible) {
            Plotly.Plots.resize(graphArea);
          }
        };
        ui.appendChild(eltCollapse);
      }

      if (options?.showAxesToggle) {
        const eltSplit = document.createElement('button');
        eltSplit.className = 'graph-toggle-btn';
        eltSplit.id = 'graph_ui_split_' + id;
        eltSplit.textContent = 'Split Y-Axes';
        eltSplit.title = 'Use one Y-axis per metric (useful when scales differ)';
        eltSplit.onclick = this.ToggleSplitAxes.bind(this, id);
        ui.appendChild(eltSplit);
      }

      if (options?.showRawToggle) {
        const eltRaw = document.createElement('button');
        eltRaw.className = 'graph-toggle-btn';
        eltRaw.id = 'graph_ui_raw_' + id;
        eltRaw.textContent = 'All Runs';
        eltRaw.title = 'Show each individual run as a separate trace';
        eltRaw.onclick = this.ToggleRawTraces.bind(this, id);
        ui.appendChild(eltRaw);
      }

      if (options?.showCIToggle) {
        const eltCI = document.createElement('button');
        eltCI.className = 'graph-toggle-btn';
        eltCI.id = 'graph_ui_ci_' + id;
        eltCI.textContent = 'Confidence Bands';
        eltCI.title = 'Show 95% confidence interval around the mean';
        eltCI.onclick = this.ToggleCIShadow.bind(this, id);
        ui.appendChild(eltCI);
      }

      if (options?.title) {
        const title = document.createElement('span');
        title.innerText = options.title;
        ui.appendChild(title);
      }

      container.appendChild(ui);
    }

    container.appendChild(graphArea);
    return { container, graphArea };
  }

  #PrepareTracesForPlotly(config, header, series) {
    const { metrics, splitAxes } = config;
    const timestamps = [];
    for (let t = header.min; t < header.max; t += header.step) {
      timestamps.push(t / 1_000_000);
    }

    const traces = [];
    for (let metricIdx = 0; metricIdx < metrics.length; metricIdx++) {
      const metricName = metrics[metricIdx];
      const yAxis = splitAxes && metricIdx > 0 ? 'y' + (metricIdx + 1) : 'y';
      const dash = GraphManager.#DASH_PALETTE[metricIdx % GraphManager.#DASH_PALETTE.length];

      const rawData = series[metricName];
      if (rawData) {
        if (config.showRaw !== false && Array.isArray(rawData[0])) {
          rawData.forEach((data, idx) => {
            const group = `m${metricIdx}_${header.runs[idx]}`;
            traces.push({
              x: timestamps, y: data,
              mode: 'lines',
              name: `${header.runs[idx]}`,
              line: { width: 1, dash: 'dot' },
              opacity: 0.5,
              yaxis: yAxis,
              legendgroup: group,
              showlegend: config.showCI === false,
            });
          });
        } else if (!Array.isArray(rawData[0])) {
          traces.push({
            x: timestamps, y: rawData,
            mode: 'lines',
            name: metricName,
            line: { width: 2, dash },
            yaxis: yAxis
          });
        }
      }

      if (config.showCI !== false) {
        for (const runID of header.runs) {
          const meanKey = `${metricName}_${runID}.mean`;
          const ciLowerKey = `${metricName}_${runID}.ci_lower`;
          const ciUpperKey = `${metricName}_${runID}.ci_upper`;

          if (series[meanKey]) {
            const meanData = Array.isArray(series[meanKey][0]) ? series[meanKey][0] : series[meanKey];
            const ciLower = Array.isArray(series[ciLowerKey][0]) ? series[ciLowerKey][0] : series[ciLowerKey];
            const ciUpper = Array.isArray(series[ciUpperKey][0]) ? series[ciUpperKey][0] : series[ciUpperKey];
            const group = `m${metricIdx}_${runID}`;

            traces.push({ x: timestamps, y: ciUpper, mode: 'lines', name: `${metricName} CI (run ${runID})`, line: { width: 0 }, showlegend: false, hoverinfo: 'skip', yaxis: yAxis, legendgroup: group });
            traces.push({ x: timestamps, y: meanData, mode: 'lines', name: `${metricName} Mean (run ${runID})`, line: { width: 3, dash }, fill: 'tonexty', fillcolor: 'rgba(68, 68, 68, 0.2)', yaxis: yAxis, legendgroup: group });
            traces.push({ x: timestamps, y: ciLower, mode: 'lines', name: `${metricName} CI (run ${runID})`, line: { width: 0 }, showlegend: false, fill: 'tonexty', fillcolor: 'rgba(68, 68, 68, 0.2)', hoverinfo: 'skip', yaxis: yAxis, legendgroup: group });
          }
        }

        const globalMeanKey = `${metricName}.mean`;
        if (series[globalMeanKey]) {
          const meanData = Array.isArray(series[globalMeanKey][0]) ? series[globalMeanKey][0] : series[globalMeanKey];
          const ciLower = Array.isArray(series[`${metricName}.ci_lower`][0]) ? series[`${metricName}.ci_lower`][0] : series[`${metricName}.ci_lower`];
          const ciUpper = Array.isArray(series[`${metricName}.ci_upper`][0]) ? series[`${metricName}.ci_upper`][0] : series[`${metricName}.ci_upper`];
          const globalGroup = `m${metricIdx}_global`;

          traces.push({ x: timestamps, y: ciUpper, mode: 'lines', line: { width: 0 }, showlegend: false, hoverinfo: 'skip', yaxis: yAxis, legendgroup: globalGroup });
          traces.push({ x: timestamps, y: meanData, mode: 'lines', name: 'Mean', line: { width: 3, color: 'rgb(31, 119, 180)', dash }, fill: 'tonexty', fillcolor: 'rgba(31, 119, 180, 0.3)', yaxis: yAxis, legendgroup: globalGroup });
          traces.push({ x: timestamps, y: ciLower, mode: 'lines', line: { width: 0 }, showlegend: false, fill: 'tonexty', fillcolor: 'rgba(31, 119, 180, 0.3)', hoverinfo: 'skip', yaxis: yAxis, legendgroup: globalGroup });
        }
      }
    }

    return traces;
  }

  #PrepareTracesForCompare(config, commitsData) {
    const showCI = config.showCI === true;
    const splitAxes = config.splitAxes && config.metrics.length > 1;
    const traces = [];

    const firstData = commitsData.values().next().value;
    if (!firstData) return traces;
    const { min, max, step } = firstData.header;
    const timestamps = [];
    for (let t = min; t < max; t += step) {
      timestamps.push(t / 1_000_000);
    }

    config.compareCommits.forEach((commit, commitIdx) => {
      const color = GraphManager.#PALETTE[commitIdx % GraphManager.#PALETTE.length];
      const fillColor = GraphManager.#HexToRgba(color, 0.2);
      const shortHash = commit.slice(0, 8);
      const data = commitsData.get(commit);
      if (!data) return;
      const { series } = data;

      config.metrics.forEach((metricName, metricIdx) => {
        const yAxis = splitAxes
          ? (metricIdx === 0 ? 'y' : 'y' + (metricIdx + 1))
          : 'y';
        const dash = GraphManager.#DASH_PALETTE[metricIdx % GraphManager.#DASH_PALETTE.length];
        const group = `c${commitIdx}_m${metricIdx}`;

        const meanKey = `${metricName}.mean`;
        const lowerKey = `${metricName}.ci_lower`;
        const upperKey = `${metricName}.ci_upper`;

        const meanData = series[meanKey];
        if (!meanData) return;
        const meanArr = Array.isArray(meanData[0]) ? meanData[0] : meanData;

        const traceName = config.metrics.length === 1
          ? shortHash
          : `${shortHash}/${metricName}`;

        if (showCI && series[lowerKey] && series[upperKey]) {
          const ciLower = Array.isArray(series[lowerKey][0]) ? series[lowerKey][0] : series[lowerKey];
          const ciUpper = Array.isArray(series[upperKey][0]) ? series[upperKey][0] : series[upperKey];

          traces.push({ x: timestamps, y: ciUpper, mode: 'lines', line: { width: 0 }, showlegend: false, hoverinfo: 'skip', yaxis: yAxis, legendgroup: group });
          traces.push({ x: timestamps, y: meanArr, mode: 'lines', name: traceName, line: { width: 2.5, color, dash }, fill: 'tonexty', fillcolor: fillColor, yaxis: yAxis, legendgroup: group });
          traces.push({ x: timestamps, y: ciLower, mode: 'lines', line: { width: 0 }, showlegend: false, fill: 'tonexty', fillcolor: fillColor, hoverinfo: 'skip', yaxis: yAxis, legendgroup: group });
        } else {
          traces.push({ x: timestamps, y: meanArr, mode: 'lines', name: traceName, line: { width: 2.5, color, dash }, yaxis: yAxis, legendgroup: group });
        }

        if (config.showRaw) {
          const rawData = series[metricName];
          if (rawData && Array.isArray(rawData[0])) {
            rawData.forEach((runData) => {
              traces.push({
                x: timestamps, y: runData,
                mode: 'lines',
                name: `${shortHash} raw`,
                line: { width: 1, color, dash: 'dot' },
                opacity: 0.3,
                showlegend: false,
                yaxis: yAxis,
                legendgroup: group
              });
            });
          }
        }
      });
    });

    return traces;
  }

  static #BuildSplitAxisLayout(metrics) {
    const n = metrics.length;
    const PAD = 0.08;

    // metrics[1],[3],[5]... → right axes
    // metrics[2],[4],[6]... → extra left axes
    const rightCount     = Math.ceil((n - 1) / 2);
    const extraLeftCount = Math.floor((n - 1) / 2);

    const domainStart = extraLeftCount > 0 ? extraLeftCount * PAD : 0;
    // first right axis sits at domainEnd; each extra right axis goes PAD further out
    const domainEnd = rightCount > 1 ? 1 - (rightCount - 1) * PAD : 1;

    const axes = { yaxis: { title: { text: metrics[0], standoff: 8 }, type: 'linear' } };

    metrics.slice(1).forEach((metric, i) => {
      const axisKey = 'yaxis' + (i + 2);
      const isRight = i % 2 === 0; // i=0,2,4... → right; i=1,3,5... → extra left

      const position = isRight
        ? domainEnd + (i / 2) * PAD              // right: domainEnd, domainEnd+PAD, ...
        : domainStart - ((i - 1) / 2 + 1) * PAD; // left:  domainStart-PAD, domainStart-2*PAD, ...

      axes[axisKey] = {
        overlaying: 'y',
        side: isRight ? 'right' : 'left',
        title: { text: metric, standoff: 8 },
        type: 'linear',
        anchor: 'free',
        position
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
