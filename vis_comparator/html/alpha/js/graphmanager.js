class GraphManager {
  #configs;
  #document;
  #callbacks;
  static #nextid = 0;
  static #PALETTE = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728'];

  constructor(document, callbacks) {
    this.#configs = new Map();
    this.#document = document;
    this.#callbacks = callbacks;
  }

  async AddGraph(config, header, series) {
    const id = GraphManager.#nextid++;
    const { container: graphContainer, graphArea } = this.#BuildGraphContainer(id, { showIcons: true, title: config.metrics.toString() });
    this.#document.appendChild(graphContainer);

    await this.#DrawGraph(graphArea, config.metrics, header, series, config.commit);

    this.#configs.set(id, { config, header, series, graphContainer, graphArea });

    return id;
  }

  async AddCompareGraph(config, commitsData) {
    const id = GraphManager.#nextid++;
    const shortHashes = config.compareCommits.map(c => c.slice(0, 8)).join(', ');
    const title = `${config.metrics.join(', ')} [${shortHashes}]`;
    const { container: graphContainer, graphArea } = this.#BuildGraphContainer(id, {
      showIcons: true,
      showRawToggle: true,
      showCIToggle: true,
      title
    });
    this.#document.appendChild(graphContainer);

    await this.#DrawCompareGraph(graphArea, config, commitsData);

    this.#configs.set(id, { config, graphContainer, graphArea, mode: 'compare', commitsData });

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
    if (!stored || stored.mode !== 'compare') return;
    stored.config.showRaw = !stored.config.showRaw;
    const eltRaw = document.getElementById('graph_ui_raw_' + id);
    if (eltRaw) eltRaw.classList.toggle('graph_ui_icons_active', stored.config.showRaw);
    this.#DrawCompareGraph(stored.graphArea, stored.config, stored.commitsData);
  }

  ToggleCIShadow(id) {
    const stored = this.#configs.get(id);
    if (!stored || stored.mode !== 'compare') return;
    stored.config.showCI = !(stored.config.showCI ?? true);
    const eltCI = document.getElementById('graph_ui_ci_' + id);
    if (eltCI) eltCI.classList.toggle('graph_ui_icons_active', stored.config.showCI !== false);
    this.#DrawCompareGraph(stored.graphArea, stored.config, stored.commitsData);
  }

  async #DrawGraph(container, metrics, header, series, commit) {
    const traces = this.#PrepareTracesForPlotly(metrics, header, series);
    const layout = {
      title: `${commit}`,
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
    const plotlyConfig = {
      responsive: true,
      displayModeBar: true,
      modeBarButtonsToRemove: ['lasso2d', 'select2d']
    };
    await Plotly.newPlot(container, traces, layout, plotlyConfig);
  }

  async #DrawCompareGraph(container, config, commitsData) {
    const traces = this.#PrepareTracesForCompare(config, commitsData);
    const hasDualAxis = config.metrics.length === 2;
    const layout = {
      title: `Compare: ${config.metrics.join(' | ')}`,
      xaxis: { title: 'Time (s)', type: 'linear', ticksuffix: 's' },
      yaxis: { title: hasDualAxis ? config.metrics[0] : 'Value', type: 'linear' },
      hovermode: 'x unified',
      hoverlabel: { namelength: -1 },
      showlegend: true,
      legend: { x: 1.12, xanchor: 'left', y: 1 },
      margin: { l: 60, r: hasDualAxis ? 80 : 20, t: 40, b: 40 },
      autosize: true,
      height: 400
    };
    if (hasDualAxis) {
      layout.yaxis2 = { title: config.metrics[1], type: 'linear', overlaying: 'y', side: 'right' };
    }
    const plotlyConfig = {
      responsive: true,
      displayModeBar: true,
      modeBarButtonsToRemove: ['lasso2d', 'select2d']
    };
    await Plotly.newPlot(container, traces, layout, plotlyConfig);
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

    const requireUI = options?.showIcons || options?.title || options?.showRawToggle || options?.showCIToggle;
    if (requireUI) {
      const ui = document.createElement('div');
      ui.id = 'graph_ui_' + id;

      if (options?.showIcons) {
        const eltDelete = document.createElement('span');
        eltDelete.className = 'graph_ui_icons';
        eltDelete.id = 'graph_ui_delete_' + id;
        eltDelete.innerHTML = '<span>✖</span><span class="graph_ui_icon_label">Delete</span>';
        eltDelete.onclick = this.DelGraph.bind(this, id);
        ui.appendChild(eltDelete);

        const eltCollapse = document.createElement('span');
        eltCollapse.className = 'graph_ui_icons';
        eltCollapse.id = 'graph_ui_collapse_' + id;
        eltCollapse.innerHTML = '<span>➖</span><span class="graph_ui_icon_label">Minimize</span>';
        eltCollapse.onclick = function() {
          const isVisible = graphArea.style.display !== 'none';
          graphArea.style.display = isVisible ? 'none' : '';
          eltCollapse.innerHTML = isVisible
            ? '<span>➕</span><span class="graph_ui_icon_label">Expand</span>'
            : '<span>➖</span><span class="graph_ui_icon_label">Minimize</span>';
          if (!isVisible) {
            Plotly.Plots.resize(graphArea);
          }
        };
        ui.appendChild(eltCollapse);

        const eltConfig = document.createElement('span');
        eltConfig.className = 'graph_ui_icons';
        eltConfig.id = 'graph_ui_config_' + id;
        eltConfig.innerHTML = '<span>🧾</span><span class="graph_ui_icon_label">Config</span>';
        ui.appendChild(eltConfig);
      }

      if (options?.showRawToggle) {
        const eltRaw = document.createElement('span');
        eltRaw.className = 'graph_ui_icons';
        eltRaw.id = 'graph_ui_raw_' + id;
        eltRaw.innerHTML = '<span>📈</span><span class="graph_ui_icon_label">Raw</span>';
        eltRaw.onclick = this.ToggleRawTraces.bind(this, id);
        ui.appendChild(eltRaw);
      }

      if (options?.showCIToggle) {
        const eltCI = document.createElement('span');
        eltCI.className = 'graph_ui_icons graph_ui_icons_active';
        eltCI.id = 'graph_ui_ci_' + id;
        eltCI.innerHTML = '<span>🌫️</span><span class="graph_ui_icon_label">CI</span>';
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

  #PrepareTracesForPlotly(metrics, header, series) {
    const timestamps = [];
    for (let t = header.min; t < header.max; t += header.step) {
      timestamps.push(t / 1_000_000);
    }

    const traces = [];
    for (const metricName of metrics) {
      const rawData = series[metricName];
      if (rawData) {
        if (Array.isArray(rawData[0])) {
          rawData.forEach((data, idx) => {
            traces.push({
              x: timestamps, y: data,
              mode: 'lines',
              name: `${header.runs[idx]}`,
              line: { width: 1, dash: 'dot' },
              opacity: 0.5
            });
          });
        } else {
          traces.push({
            x: timestamps, y: rawData,
            mode: 'lines',
            name: metricName,
            line: { width: 2 }
          });
        }
      }

      for (const runID of header.runs) {
        const meanKey = `${metricName}_${runID}.mean`;
        const ciLowerKey = `${metricName}_${runID}.ci_lower`;
        const ciUpperKey = `${metricName}_${runID}.ci_upper`;

        if (series[meanKey]) {
          const meanData = Array.isArray(series[meanKey][0]) ? series[meanKey][0] : series[meanKey];
          const ciLower = Array.isArray(series[ciLowerKey][0]) ? series[ciLowerKey][0] : series[ciLowerKey];
          const ciUpper = Array.isArray(series[ciUpperKey][0]) ? series[ciUpperKey][0] : series[ciUpperKey];

          traces.push({ x: timestamps, y: ciUpper, mode: 'lines', name: `${metricName} CI (run ${runID})`, line: { width: 0 }, showlegend: false, hoverinfo: 'skip' });
          traces.push({ x: timestamps, y: meanData, mode: 'lines', name: `${metricName} Mean (run ${runID})`, line: { width: 3 }, fill: 'tonexty', fillcolor: 'rgba(68, 68, 68, 0.2)' });
          traces.push({ x: timestamps, y: ciLower, mode: 'lines', name: `${metricName} CI (run ${runID})`, line: { width: 0 }, showlegend: false, fill: 'tonexty', fillcolor: 'rgba(68, 68, 68, 0.2)', hoverinfo: 'skip' });
        }
      }

      const globalMeanKey = `${metricName}.mean`;
      if (series[globalMeanKey]) {
        const meanData = Array.isArray(series[globalMeanKey][0]) ? series[globalMeanKey][0] : series[globalMeanKey];
        const ciLower = Array.isArray(series[`${metricName}.ci_lower`][0]) ? series[`${metricName}.ci_lower`][0] : series[`${metricName}.ci_lower`];
        const ciUpper = Array.isArray(series[`${metricName}.ci_upper`][0]) ? series[`${metricName}.ci_upper`][0] : series[`${metricName}.ci_upper`];

        traces.push({ x: timestamps, y: ciUpper, mode: 'lines', line: { width: 0 }, showlegend: false, hoverinfo: 'skip' });
        traces.push({ x: timestamps, y: meanData, mode: 'lines', name: 'Mean', line: { width: 3, color: 'rgb(31, 119, 180)' }, fill: 'tonexty', fillcolor: 'rgba(31, 119, 180, 0.3)' });
        traces.push({ x: timestamps, y: ciLower, mode: 'lines', line: { width: 0 }, showlegend: false, fill: 'tonexty', fillcolor: 'rgba(31, 119, 180, 0.3)', hoverinfo: 'skip' });
      }
    }

    return traces;
  }

  #PrepareTracesForCompare(config, commitsData) {
    const showCI = config.showCI !== false;
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
        // 2e métrique sur l'axe Y droit
        const yAxis = (config.metrics.length > 1 && metricIdx === 1) ? 'y2' : 'y';

        const meanKey = `${metricName}.mean`;
        const lowerKey = `${metricName}.ci_lower`;
        const upperKey = `${metricName}.ci_upper`;

        const meanData = series[meanKey];
        if (!meanData) return;
        const meanArr = Array.isArray(meanData[0]) ? meanData[0] : meanData;

        const traceName = config.metrics.length === 1
          ? shortHash
          : `${shortHash}/${metricName}`;
        const dash = (config.metrics.length > 1 && metricIdx === 1) ? 'dash' : 'solid';

        if (showCI && series[lowerKey] && series[upperKey]) {
          const ciLower = Array.isArray(series[lowerKey][0]) ? series[lowerKey][0] : series[lowerKey];
          const ciUpper = Array.isArray(series[upperKey][0]) ? series[upperKey][0] : series[upperKey];

          traces.push({ x: timestamps, y: ciUpper, mode: 'lines', line: { width: 0 }, showlegend: false, hoverinfo: 'skip', yaxis: yAxis });
          traces.push({ x: timestamps, y: meanArr, mode: 'lines', name: traceName, line: { width: 2.5, color }, fill: 'tonexty', fillcolor: fillColor, yaxis: yAxis });
          traces.push({ x: timestamps, y: ciLower, mode: 'lines', line: { width: 0 }, showlegend: false, fill: 'tonexty', fillcolor: fillColor, hoverinfo: 'skip', yaxis: yAxis });
        } else {
          traces.push({ x: timestamps, y: meanArr, mode: 'lines', name: traceName, line: { width: 2.5, color, dash }, yaxis: yAxis });
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
                yaxis: yAxis
              });
            });
          }
        }
      });
    });

    return traces;
  }

  static #HexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
}

export { GraphManager };
