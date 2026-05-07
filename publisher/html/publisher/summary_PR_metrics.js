class Metrics {
  #commits = null;
  #metricsData = {};  // Structure: { type: { library: { metric: [{ commit_id, values, success }] } } }
  #commitNames = {};

  static #metricStatusSuccess = '#27ae60';
  static #metricStatusFail =  '#e74c3c';
  static #metricStatusMixed = '#f1c40f';

  constructor(availableTypes, commits) {
    this.#commits = commits;
    commits.forEach(commit => {
        availableTypes.forEach(type => {
            if (!this.#commitNames[commit.id]) {
              this.#commitNames[commit.id] = {};
            }
            const typeData = commit.infos?.get(type);
            if (!typeData || !typeData.libs) return;
            if (!this.#metricsData[type]) {
              this.#metricsData[type] = {};
            }

            const status = (typeData.global_status === 'success' ? 
                Metrics.#metricStatusSuccess : (typeData.global_status === 'fail' ? 
                    Metrics.#metricStatusFail : Metrics.#metricStatusMixed));

            for (const [libName, libData] of Object.entries(typeData.libs)) {
              if (!this.#metricsData[type][libName]) {
                this.#metricsData[type][libName] = {};
              }

              const cputs = libData?.cputs == 1 ? '⚙C' : (libData?.cputs == -1 ? '🦀' : '❓');
              this.#commitNames[commit.id][libName] = cputs;

              switch(type) {
                case 'Perf':
                  this.#BuildPerfMetrics(commit.id, status, cputs, libName, libData);
                  break;
                case 'Vuln':
                  this.#BuildVulnMetrics(commit.id, cputs, libName, libData);
                  break;
              }
            }
        });
    });
  }

  GenerateGraphData(type, library, metric) {
    // Prepare data for Plotly box plot
    const traces = [];

    let librarieDataPoints = this.#metricsData[type]?.[library] ?? {}
    const otherIds = new Set(
        Object.entries(librarieDataPoints)
            .filter(([key]) => key !== metric)
            .flatMap(([, points]) => points.map(element => element.commit_id))
    );

    let metricDataPoints = this.#metricsData[type]?.[library]?.[metric] ?? [];

    const metricIds = new Set(metricDataPoints.map(element => element.commit_id));
    const unusedCommitsList = new Set([...otherIds]
        .filter(id => !metricIds.has(id))
        .map(element => { 
            return (this.#commitNames[element]?.[library] ?? '') + ' ' + element.substring(0,14);
        })
    );

    const isDistribution = metricDataPoints.some(dataPoint => dataPoint.values.length > 1)
    if (isDistribution) {
      metricDataPoints.forEach(dataPoint => {
          const trace = {
              x: dataPoint.values.map(() => dataPoint.commit_id),
              y: dataPoint.values,
              type: 'box',
              boxmean: 'sd',  // Show mean and standard deviation
              boxpoints: false,
              marker: {
                  color: dataPoint.status
              },
              hoverinfo: 'y'
          };
          traces.push(trace);
      });
    } else {
      traces.push({
          x: metricDataPoints.map(dataPoint => dataPoint.commit_id),
          y: metricDataPoints.map(dataPoint => dataPoint.values[0]),
          type: 'scatter',
          mode: 'lines+markers',
          marker: { color: metricDataPoints.map(dataPoint => dataPoint.status) }, 
          line: { color: '#888' },
          hoverinfo: 'y'
      });
    }

    const commitsTimeline = this.#commits.toReversed();
    const layout = {
        title: {
            text: `${library} - ${metric} (${type})`,
            font: { size: 18, weight: 600 }
        },
        xaxis: {
            title: 'Commits (oldest → newest)',
            tickangle: -75,
            type: 'category',
            categoryorder: 'array',
            categoryarray: commitsTimeline.map(c => c.id),
            tickfont: { family: 'monospace' },
            tickvals: commitsTimeline.map(c => c.id),
            ticktext: commitsTimeline.map(c => 
                (this.#commitNames[c.id]?.[library] ?? '') + ' ' + c.id.substring(0,14)),
            range: [-0.5, commitsTimeline.length + 0.5],
        },
        yaxis: {
            title: metric,
            rangemode: 'tozero'
        },
        showlegend: false,
        hovermode: 'closest',
        margin: {
            l: 80,
            r: 50,
            t: 80,
            b: 130
        },
        plot_bgcolor: '#f8f9fa',
        paper_bgcolor: 'white'
    };

    const config = {
        responsive: true,
        displayModeBar: true,
        modeBarButtonsToRemove: ['lasso2d', 'select2d'],
        displaylogo: false
    };

    return [ traces, layout, config, unusedCommitsList ];
  }

  static ColorGraphXTicks(container, commitIds, color) {
    const toColor = new Set(commitIds);
    const tickTexts = container.querySelectorAll('.xaxislayer-above .xtick text');
    tickTexts.forEach(el => {
        const raw = el.getAttribute('data-unformatted') ?? el.textContent;
        if ([...toColor].some(id => raw.includes(id.substring(0, 14)))) {
            el.style.fill = color;
        }
    });
  }

  GetTypes() {
    return Object.keys(this.#metricsData);
  }

  GetValuesForType(type) {
    return this.#metricsData[type];
  }

  GetValuesForSubType(type, library) {
    return this.#metricsData[type]?.[library];
  }

  GetValues(type, library, metric) {
    return this.#metricsData[type]?.[library]?.[metric];
  }

  #BuildPerfMetrics(commitID, status, cputs, libName, libData) {
    const type = 'Perf'
            
    // Process each metric (numeric arrays only, excluding non-success runs)
    for (const [metricName, metricValues] of Object.entries(libData)) {
      // Skip non-arrays, empty arrays, non-numeric arrays, and metadata fields
      if (!Array.isArray(metricValues) ||
          metricValues.length === 0 ||
          typeof metricValues[0] !== 'number' ||
          metricName === 'warn_user' ||
          metricName === 'success_count' ||
          metricName === 'total_runs' ||
          metricName === 'cputs') {
        continue;
      }
            
      // Only include successful runs for non-fail metrics
      if (metricName.startsWith('fail_')) {
        const realMetricName = metricName.slice(5);
        // For fail metrics, include all data
        if (!this.#metricsData[type][libName][realMetricName]) {
          this.#metricsData[type][libName][realMetricName] = [];
        }
        this.#metricsData[type][libName][realMetricName].push({
            commit_id: commitID,
            values: metricValues,
            status: Metrics.#metricStatusFail,
            cputs
        });
      } else {
        // For success metrics, include all data
        if (!this.#metricsData[type][libName][metricName]) {
          this.#metricsData[type][libName][metricName] = [];
        }
        this.#metricsData[type][libName][metricName].push({
            commit_id: commitID,
            values: metricValues,
            status,
            cputs
        });
      }
    }
  }

  #BuildVulnMetrics(commitID, cputs, libName, libData) {
    const type = 'Vuln'

    const status = libData.success_count == 0 ? Metrics.#metricStatusFail : 
        (((libData.success_count === libData.total_runs) || ((libData.total_runs > 10) && (libData.success_count > 2))) ? 
            Metrics.#metricStatusSuccess : Metrics.#metricStatusMixed);

    // Process each metric (numeric arrays only, excluding non-success runs)
    for (const [metricName, metricValues] of Object.entries(libData)) {
      // Skip non-arrays, empty arrays, non-numeric arrays, and metadata fields
      if (!Array.isArray(metricValues) ||
          metricValues.length === 0 ||
          typeof metricValues[0] !== 'number' ||
          metricName === 'warn_user' ||
          metricName === 'success_count' ||
          metricName === 'total_runs' ||
          metricName === 'cputs') {
        continue;
      }
            
      // Only include successful runs for non-fail metrics
      if (metricName.startsWith('fail_')) {
        let realMetricName = metricName;
        /*if (status === Metrics.#metricStatusFail) {
          realMetricName = metricName.slice(5);
        }*/
        // For fail metrics, include all data
        if (!this.#metricsData[type][libName][realMetricName]) {
          this.#metricsData[type][libName][realMetricName] = [];
        }
        this.#metricsData[type][libName][realMetricName].push({
            commit_id: commitID,
            values: metricValues,
            status: Metrics.#metricStatusFail,
            cputs
        });
      } else {
        let realMetricName = metricName.substring(8);
        if (!this.#metricsData[type][libName][realMetricName]) {
          this.#metricsData[type][libName][realMetricName] = [];
        }
        this.#metricsData[type][libName][realMetricName].push({
            commit_id: commitID,
            values: metricValues,
            status,
            cputs
        });
      }
    }

    if ((libData.success_count != null) && (libData.total_runs != null)) {
      if (!this.#metricsData[type][libName]['ratio_success_execution']) {
        this.#metricsData[type][libName]['ratio_success_execution'] = []
      }
      this.#metricsData[type][libName]['ratio_success_execution'].push({
            commit_id: commitID,
            values: [(libData.success_count / libData.total_runs) * 100.0],
            status,
            cputs
        });
    }

  }

};

export { Metrics };