class GraphManager {
  #config;
  static #nextid = 0;

  constructor() {
    this.#config = new Map();
  }

  AddGraph(config, metrics, header, series) {
    const id = GraphManager.#nextid++;
    this.#config.set(id, { config, metrics, header, series });
    return id;
  }

  async DrawGraph(id, container) {
    const { config, metrics, header, series } = this.#config.get(id);
    const traces = this.#PrepareTracesForPlotly(metrics, header, series);
    const layout = {
      title: `Title`,
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
      }
    };
    
    const plotlyConfig = {
      responsive: true,
      displayModeBar: true,
      modeBarButtonsToRemove: ['lasso2d', 'select2d']
    };
    await Plotly.newPlot(container, traces, layout, plotlyConfig);
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
              name: `${metricName} (run ${header.runs[idx]})`,
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
          name: `${metricName} Mean (all runs)`,
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

}

export { GraphManager }