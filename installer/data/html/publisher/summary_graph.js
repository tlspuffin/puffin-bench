import { Metrics } from './summary_metrics.js'

export class Graph {
  static GenerateEmptyGraphData(type, library, metric, commits) {
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
            categoryarray: commits,
            tickfont: { family: 'monospace' },
            tickvals: commits,
            ticktext: commits.map(c => c.substring(0,14)),
            range: Metrics.ComputeXRange(commits.length),
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
        displaylogo: false,
        dragmode: 'pan'
    };

    return [ layout, config ];
  }

  static AddGraphData(graphData, dataPoint) {
    const [ traces, layout ] = graphData;
    if (dataPoint == null) {
      return [ traces, layout ];
    }

    const commitId = dataPoint.commit_id;
    const tickLabel = (dataPoint.cputs ?? '') + ' ' + commitId.substring(0, 14);

    const idx = layout.xaxis.categoryarray.indexOf(commitId);
    if (idx !== -1) {
      layout.xaxis.ticktext[idx] = tickLabel;
    } else {
      layout.xaxis.categoryarray.push(commitId);
      layout.xaxis.tickvals.push(commitId);
      layout.xaxis.ticktext.push(tickLabel);
      layout.xaxis.range = Metrics.ComputeXRange(layout.xaxis.categoryarray.length);
    }

    if (dataPoint.values.length > 1) {
      traces.push({
          x: dataPoint.values.map(() => commitId),
          y: dataPoint.values,
          type: 'box',
          boxmean: 'sd',
          boxpoints: false,
          marker: { color: dataPoint.status },
          hoverinfo: 'y'
      });
    } else {
      traces.push({
          x: [commitId],
          y: [dataPoint.values[0]],
          type: 'scatter',
          mode: 'markers',
          marker: { color: dataPoint.status, symbol: 'diamond', size: 10 },
          hoverinfo: 'y'
      });
    }

    return [traces, layout];
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

  static StyleGraphXTicks(container, commitIds, style) {
    const toStyle = new Set(commitIds);
    const tickTexts = container.querySelectorAll('.xaxislayer-above .xtick text');
    tickTexts.forEach(el => {
        const raw = el.getAttribute('data-unformatted') ?? el.textContent;
        if ([...toStyle].some(id => raw.includes(id.substring(0, 14)))) {
            Object.assign(el.style, style);
        }
    });
  }

  #metrics;

  constructor(metrics) {
    this.#metrics = metrics
  }

  GenerateGraphData(type, library, metric) {
    // Prepare data for Plotly box plot
    const traces = [];

    let librarieDataPoints = this.#metrics.GetValuesForSubType(type, library) ?? {}
    const otherIds = new Set(
        Object.entries(librarieDataPoints)
            .filter(([key]) => key !== metric)
            .flatMap(([, points]) => points.map(element => element.commit_id))
    );

    let metricDataPoints = this.#metrics.GetValues(type, library, metric) ?? [];

    const metricIds = new Set(metricDataPoints.map(element => element.commit_id));
    const unusedCommitsList = new Set([...otherIds]
        .filter(id => !metricIds.has(id))
        .map(element => { 
            return (this.#metrics.HaveCommit(element)?.[library] ?? '') + ' ' + element.substring(0,14);
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

    const commitsTimeline = this.#metrics.GetCommits().toReversed();
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
                (this.#metrics.HaveCommit(c.id)?.[library] ?? '') + ' ' + c.id.substring(0,14)),
            range: Metrics.ComputeXRange(commitsTimeline.length),
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
        displaylogo: false,
        dragmode: 'pan'
    };

    return [ traces, layout, config, unusedCommitsList ];
  }

  InsertComparaisonData(graphData, dataPoint, baseCommit) {
    const [traces, layout, config, unusedCommitsList] = graphData;
    if (dataPoint == null) {
      return [traces, layout, config, unusedCommitsList, -1];
    }

    const commitId = dataPoint.commit_id;
    const tickLabel = (dataPoint.cputs ?? '') + ' ' + commitId.substring(0, 14);

    const categoryArray = layout.xaxis.categoryarray;
    const baseIdx = categoryArray.indexOf(baseCommit);
    const insertIdx = baseIdx === -1 ? categoryArray.length : baseIdx + 1;

    categoryArray.splice(insertIdx, 0, commitId);
    layout.xaxis.tickvals.splice(insertIdx, 0, commitId);
    layout.xaxis.ticktext.splice(insertIdx, 0, tickLabel);
    layout.xaxis.range = Metrics.ComputeXRange(categoryArray.length, insertIdx);

    if (dataPoint.values.length > 1) {
      traces.push({
          x: dataPoint.values.map(() => commitId),
          y: dataPoint.values,
          type: 'box',
          boxmean: 'sd',
          boxpoints: false,
          marker: { color: dataPoint.status },
          hoverinfo: 'y'
      });
    } else {
      traces.push({
          x: [commitId],
          y: [dataPoint.values[0]],
          type: 'scatter',
          mode: 'markers',
          marker: { color: dataPoint.status, symbol: 'diamond', size: 10 },
          hoverinfo: 'y'
      });
    }

    return [traces, layout, config, unusedCommitsList, insertIdx];
  }
}