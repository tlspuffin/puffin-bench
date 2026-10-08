import { Metrics } from './summary_metrics.js'
import { knownCommit, describeCommit, commitPlotlyLabel, commitTooltip, commitLineHTML } from '../common/commitinfo.js';

export class Graph {
  // colors of the dark pages (summary.css); axes keep their own settings, the theme only colors them
  static darkTheme = {
    plot_bgcolor: '#0f0f0f',
    paper_bgcolor: '#0b0b0b',
    font: { color: '#d0d0d0' },
  };

  static DarkAxes(layout) {
    for (const axis of ['xaxis', 'yaxis']) {
      layout[axis] = { gridcolor: '#262626', zerolinecolor: '#3a3a3a', linecolor: '#3a3a3a', ...layout[axis] };
    }
    return layout;
  }

  static GenerateEmptyGraphData(type, library, metric, commits) {
    const layout = {
        title: {
            text: `${library} - ${metric} (${type})`,
            font: { size: 18, weight: 600 }
        },
        xaxis: {
            title: 'Commits (oldest → newest)',
            tickangle: -90,
            type: 'category',
            categoryorder: 'array',
            categoryarray: [...commits],
            tickfont: { family: 'monospace', size: 10 },
            automargin: true,
            tickvals: [...commits],
            ticktext: commits.map(c => Graph.TickLabel(c)),
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
        ...Graph.darkTheme
    };

    const config = {
        responsive: true,
        displayModeBar: true,
        modeBarButtonsToRemove: ['lasso2d', 'select2d'],
        displaylogo: false,
        dragmode: 'pan'
    };

    return [ Graph.DarkAxes(layout), config ];
  }

  static AddGraphData(graphData, dataPoint) {
    const [ traces, layout ] = graphData;
    if (dataPoint == null) {
      return [ traces, layout ];
    }

    const commitId = dataPoint.commit_id;
    const tickLabel = Graph.TickLabel(commitId, dataPoint.cputs);

    const idx = layout.xaxis.categoryarray.indexOf(commitId);
    if (idx !== -1) {
      layout.xaxis.ticktext[idx] = tickLabel;
    } else {
      layout.xaxis.categoryarray.push(commitId);
      layout.xaxis.tickvals.push(commitId);
      layout.xaxis.ticktext.push(tickLabel);
      layout.xaxis.range = Metrics.ComputeXRange(layout.xaxis.categoryarray.length);
    }

    traces.push(...Graph.#BuildDataPointTraces(dataPoint, commitId));

    return [traces, layout];
  }

  // Tick label of a commit: "<harness> <3 chars of the sha>·#<PR>·<mm/yy>" with links (see commitinfo.js);
  // the raw label keeps the full commit id (in the commit link), which ColorGraphXTicks/StyleGraphXTicks look for
  static TickLabel(commitId, prefix = '') {
    // the harness as a letter: emoji are not rotated with the vertical labels (C harness, Rust harness, unknown)
    prefix = { '⚙C': 'C', '🦀': '<span style="color:#f0883e">R</span>', '❓': '?' }[prefix] ?? prefix;
    const desc = knownCommit(commitId);
    if (desc) return commitPlotlyLabel(desc, prefix);
    if (/^[0-9a-f]{40}$/i.test(commitId ?? '')) return commitPlotlyLabel(describeCommit({ id: commitId }), prefix);
    return `${prefix ?? ''} ${String(commitId ?? '').substring(0, 14)}`;
  }

  // Hover of the tick labels (full commit id, PR, date, message); plotly redraws the ticks: call it on plotly_afterplot
  // The commits without data in this graph are dimmed. A click on the commit (its first link, not its PR) shows its
  // card on the Results page: the event pb-show-commit closes the chart's window (graph-modal) and summary.js scrolls
  // to the card; with Ctrl, Shift or the middle button, the link opens the commit on GitHub as before.
  static DecorateGraphXTicks(container) {
    const withData = new Set((container.data ?? []).flatMap(trace => trace.x ?? []));
    container.querySelectorAll('.xaxislayer-above .xtick text').forEach(el => {
        const raw = el.getAttribute('data-unformatted') ?? '';
        const sha = /\/commit\/([0-9a-f]{40})/i.exec(raw)?.[1];
        if (sha) el.style.opacity = withData.has(sha) ? '' : '0.5';
        if (!sha || el.querySelector('title')) return;
        const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
        title.textContent = commitTooltip(knownCommit(sha) ?? describeCommit({ id: sha }),
            'click on the commit: its card on this page\nCtrl+click: the commit on GitHub');
        el.appendChild(title);
        el.querySelector('a')?.addEventListener('click', event => {
          if (event.ctrlKey || event.metaKey || event.shiftKey || (event.button !== 0)) return;
          event.preventDefault();
          el.dispatchEvent(new CustomEvent('pb-show-commit', { bubbles: true, detail: { sha } }));
        });
    });
  }

  static ColorGraphXTicks(container, commitIds, color) {
    const toColor = new Set(commitIds);
    const tickTexts = container.querySelectorAll('.xaxislayer-above .xtick text');
    tickTexts.forEach(el => {
        const raw = el.getAttribute('data-unformatted') ?? el.textContent;
        if ([...toColor].some(id => raw.includes(id.substring(0, 14)))) {
            el.style.fill = color;
            el.querySelectorAll('a').forEach(link => { link.style.fill = color; });
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

  static #BuildCITrace(ci, commitId, color) {
    return {
        x: [ commitId ],
        y: [ ci.mean ],
        type: 'scatter',
        mode: 'markers',
        marker: { color, symbol: 'line-ew-open', size: 14, line: { width: 2 } },
        error_y: { type: 'data', array: [ ci.half ], visible: true, color, thickness: 2, width: 6 },
        hovertemplate: `moyenne %{y:.4g}<br>IC95 ±${ci.half.toPrecision(3)} (n=${ci.n})<extra></extra>`
    };
  }

  static #BuildDataPointTraces(dataPoint, commitId) {
    const traces = [];
    const ci = Metrics.ComputeCI(dataPoint.values);

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
          x: [ commitId ],
          y: [ dataPoint.values[0] ],
          type: 'scatter',
          mode: 'markers',
          marker: { color: dataPoint.status, symbol: 'diamond', size: 10 },
          hoverinfo: 'y'
      });
    }

    if (ci !== null) {
      traces.push(Graph.#BuildCITrace(ci, commitId, dataPoint.status));
    }

    return traces;
  }

  static BuildCommitsLine(config, project, commits) {
    const line = document.createElement('div');
    line.className = 'graph-compare-commits';
    commits.forEach((commit, index) => {
        if (index > 0) {
          const arrow = document.createElement('span');
          arrow.textContent = '→';
          line.appendChild(arrow);
        }
        const branch = document.createElement(/*commit?.branch ? 'a' :*/ 'span');
        branch.className = 'branch-name';
        branch.textContent = `🌿 ${commit?.branch ?? '?'}`;
        /*if (commit?.branch) {
          branch.href = config.commit_url(project, commit.id);
          branch.target = '_blank';
          branch.rel = 'noopener noreferrer';
        }*/
        line.appendChild(branch);

        const id = document.createElement('span');
        id.className = 'graph-commit-id';
        if (commit?.id) {
          id.innerHTML = commitLineHTML(knownCommit(commit.id) ?? describeCommit(commit), { max: 50 });
        } else {
          id.textContent = '?';
        }
        line.appendChild(id);
    });
    return line;
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
            return element;
        })
    );

    const isDistribution = metricDataPoints.some(dataPoint => dataPoint.values.length > 1)
    if (isDistribution) {
      metricDataPoints.forEach(dataPoint => {
          traces.push(...Graph.#BuildDataPointTraces(dataPoint, dataPoint.commit_id));
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
            tickangle: -90,
            type: 'category',
            categoryorder: 'array',
            categoryarray: commitsTimeline.map(c => c.id),
            tickfont: { family: 'monospace', size: 10 },
            automargin: true,
            tickvals: commitsTimeline.map(c => c.id),
            ticktext: commitsTimeline.map(c => Graph.TickLabel(c.id, this.#metrics.HaveCommit(c.id)?.[library])),
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
        ...Graph.darkTheme
    };

    const config = {
        responsive: true,
        displayModeBar: true,
        modeBarButtonsToRemove: ['lasso2d', 'select2d'],
        displaylogo: false,
        dragmode: 'pan'
    };

    return [ traces, Graph.DarkAxes(layout), config, unusedCommitsList ];
  }

  InsertComparaisonData(graphData, dataPoint, baseCommit) {
    const [traces, layout, config, unusedCommitsList] = graphData;
    if (dataPoint == null) {
      return [traces, layout, config, unusedCommitsList, -1];
    }

    const commitId = dataPoint.commit_id;
    const tickLabel = Graph.TickLabel(commitId, dataPoint.cputs);

    const categoryArray = layout.xaxis.categoryarray;
    const baseIdx = categoryArray.indexOf(baseCommit);
    const insertIdx = baseIdx === -1 ? categoryArray.length : baseIdx + 1;

    categoryArray.splice(insertIdx, 0, commitId);
    layout.xaxis.tickvals.splice(insertIdx, 0, commitId);
    layout.xaxis.ticktext.splice(insertIdx, 0, tickLabel);
    layout.xaxis.range = Metrics.ComputeXRange(categoryArray.length, insertIdx);

    traces.push(...Graph.#BuildDataPointTraces(dataPoint, commitId));

    return [traces, layout, config, unusedCommitsList, insertIdx];
  }
}