class GraphManager {
  #configs;
  #document;
  #apirest;
  #commits;
  static #nextid = 0;

  constructor(document, apirest) {
    this.#configs = new Map();
    this.#document = document;
    this.#apirest = apirest;
    this.#commits = new Map();
  }

  async AddGraph(config, header, series) {
    const id = GraphManager.#nextid++;
    const { container: graphContainer, graphArea } = this.#BuildGraphContainer(id, { showIcons: true, title: config.metrics.toString() });
    this.#document.appendChild(graphContainer);

    await this.#DrawGraph(graphArea, config.metrics, header, series, config.commit);

    const newconfig = { config, header, series, graphContainer };
    this.#configs.set(id, newconfig);

    for (const [commit, configs] of this.#commits) {
      await this.#AddLinkGraph(newconfig, commit, id);
    }

    return id;
  }

  DelGraph(id) {
    const container = this.#configs.get(id).graphContainer;
    Plotly.purge(container);
    container.remove();

    this.#commits.forEach(function(config, commit) {
      this.#DelLinkGraph(commit, id);
    }.bind(this));

    this.#configs.delete(id);
  }

  async LinkCommits(commits) {
    const currentCommits = new Set(this.#commits.keys());
    const commitsToRemove = currentCommits.difference(commits);
    const commitsToAdd = commits.difference(currentCommits);

    commitsToRemove.forEach(function(commit) {
      this.#commits.get(commit).forEach(function(config, id) {
        this.#DelLinkGraph(commit, id);
      }.bind(this));
      this.#commits.delete(commit);
    }.bind(this));

    for (const commit of commitsToAdd) {
      this.#commits.set(commit, new Map());
      for(const [id, config] of this.#configs) {
        await this.#AddLinkGraph(config, commit, id);
      }
    };
  }

  async #DrawGraph(container, metrics, header, series, commit) {
    const traces = this.#PrepareTracesForPlotly(metrics, header, series);
    const layout = {
      title: `${commit}`,
      xaxis: {
        title: 'Time (s)',
        type: 'linear',
        ticksuffix: 's'
      },
      yaxis: {
        title: 'Value',
        type: 'linear'
      },
      hovermode: 'x unified',
      hoverlabel: {
        namelength: -1
      },
      showlegend: true,
      legend: {
        x: 1,
        xanchor: 'right',
        y: 1
      },
      margin: {
        l: 60,
        r: 20,
        t: 40,
        b: 40
      },
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

  #BuildGraphContainer(id, options) {
    const container = document.createElement('div');
    container.id = 'graph_container_'+id;
    container.className = 'graph_container';
    container.style.width = '100%';

    const requireUI = options?.showIcons || options?.title;
    if (requireUI) {
      const ui = document.createElement('div');
      ui.id = 'graph_ui_'+id;
      ui.style.backgroundColor = 'yellow';

      if (options?.showIcons)  {
        const eltDelete = document.createElement('span');
        eltDelete.className = 'graph_ui_icons';
        eltDelete.id = 'graph_ui_delete_'+id;
        eltDelete.innerText = '➖';
        eltDelete.onclick =  this.DelGraph.bind(this, id);
        ui.appendChild(eltDelete);
        const eltConfig = document.createElement('span');
        eltConfig.className = 'graph_ui_icons';
        eltConfig.id = 'graph_ui_config_'+id;
        eltConfig.innerText = '🧾';
        ui.appendChild(eltConfig);
      }
      if (options?.title) {
        const title = document.createElement('span');
        title.innerText = options.title;
        ui.appendChild(title);
      }

      container.appendChild(ui);
    }

    const graphArea = document.createElement('div');
    graphArea.id = 'graph_area_'+id;
    graphArea.style.width = '100%';
    graphArea.style.height = '400px';
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
              x: timestamps,
              y: data,
              mode: 'lines',
              //name: `${metricName} (run ${header.runs[idx]})`,
              name: `${header.runs[idx]}`,
              line: { width: 1, dash: 'dot' },
              opacity: 0.5
            });
          });
        } else {
          traces.push({
            x: timestamps,
            y: rawData,
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
        
          traces.push({
            x: timestamps,
            y: ciUpper,
            mode: 'lines',
            name: `${metricName} CI (run ${runID})`,
            line: { width: 0 },
            showlegend: false,
            hoverinfo: 'skip'
          });
        
          traces.push({
            x: timestamps,
            y: meanData,
            mode: 'lines',
            name: `${metricName} Mean (run ${runID})`,
            line: { width: 3 },
            fill: 'tonexty',
            fillcolor: 'rgba(68, 68, 68, 0.2)'
          });
        
          traces.push({
            x: timestamps,
            y: ciLower,
            mode: 'lines',
            name: `${metricName} CI (run ${runID})`,
            line: { width: 0 },
            showlegend: false,
            fill: 'tonexty',
            fillcolor: 'rgba(68, 68, 68, 0.2)',
            hoverinfo: 'skip'
          });
        }
      }
    
      const globalMeanKey = `${metricName}.mean`;
      if (series[globalMeanKey]) {
        const meanData = Array.isArray(series[globalMeanKey][0]) ? series[globalMeanKey][0] : series[globalMeanKey];
        const ciLower = Array.isArray(series[`${metricName}.ci_lower`][0]) ? series[`${metricName}.ci_lower`][0] : series[`${metricName}.ci_lower`];
        const ciUpper = Array.isArray(series[`${metricName}.ci_upper`][0]) ? series[`${metricName}.ci_upper`][0] : series[`${metricName}.ci_upper`];
      
        traces.push({
          x: timestamps,
          y: ciUpper,
          mode: 'lines',
          line: { width: 0 },
          showlegend: false,
          hoverinfo: 'skip'
        });
      
        traces.push({
          x: timestamps,
          y: meanData,
          mode: 'lines',
          //name: `${metricName} Mean (all runs)`,
          name: `Mean`,
          line: { width: 3, color: 'rgb(31, 119, 180)' },
          fill: 'tonexty',
          fillcolor: 'rgba(31, 119, 180, 0.3)'
        });
      
        traces.push({
          x: timestamps,
          y: ciLower,
          mode: 'lines',
          line: { width: 0 },
          showlegend: false,
          fill: 'tonexty',
          fillcolor: 'rgba(31, 119, 180, 0.3)',
          hoverinfo: 'skip'
        });
      }
    }
  
    return traces;
  }

  async #AddLinkGraph(config, commit, id) {
    const data = await this.#RetrieveCommitData(config, commit);
    if (data == null) {
      return;
    }
    const { header, series } = data;

    const { container, graphArea } = this.#BuildGraphContainer(id+'_'+commit, { showIcons: false, title: commit });
    const node = this.#GetLastGraphContainer(id);
    node.parentNode.insertBefore(container, node.nextSibling);

    await this.#DrawGraph(graphArea, config.config.metrics, header, series, commit);

    this.#commits.get(commit).set(id, { container });
  }

  #DelLinkGraph(commit, id) {
    const container = this.#commits.get(commit).get(id).container;
    Plotly.purge(container);
    container.remove();
    this.#commits.get(commit).delete(id);
  }

  async #RetrieveCommitData(config, commit) {
    return await this.#apirest.LoadCommitMetricsValues(
        config.config.type, commit, config.config.subject, 
        config.config.min, config.config.max, config.config.step, 
        config.config.metrics);
  }

  #GetLastGraphContainer(id) {
    const selector = `[id^="graph_container_${id}"]`;
    const containers = this.#document.querySelectorAll(selector);
    return containers[containers.length - 1];
  }
}

export { GraphManager }