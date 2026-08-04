import { Graph } from './summary_graph.js';
import { manageGraphs } from './summary_managegraphs.js';
import '../third-party/plotly/plotly-3.3.0.min.js';
const Plotly = window.Plotly;

class GraphCompare {
  static #overviewMetrics = {
    'Perf': ['corpus_size', 'coverage', 'total_execs'],
    'Vuln': ['durations_s', 'ratio_success_execution', 'total_execs'],
  }

  #config;
  #project;
  #dataPoints;
  #commits;
  #commitsID;
  #html;
  #type;
  #libs;
  #availableData;
  #graphContainer;
  #saveDocKeyDown;

  constructor(config, project, type, dataPoints, commits) {
    this.#Reset();
    this.#config = config;
    this.#project = project;
    this.#type = type;
    this.#dataPoints = dataPoints;
    this.#commits = commits;
    this.#commitsID = commits.map(value => value.id);

    const libs = new Set();
    this.#dataPoints.forEach(dataPoint => {
      Object.keys(dataPoint?.[this.#type] ?? {}).forEach(lib => libs.add(lib));
    });

    this.#libs = Array.from(libs).filter(lib =>
        (GraphCompare.#overviewMetrics[this.#type] ?? []).some(metric => 
            this.#HasCompareData(lib, metric)
        )
    );
    this.#availableData = null;
  }

  #Reset() {
    this.#html = null;
    this.#saveDocKeyDown = null;
    this.#graphContainer = null;
  }

  #BuildDialog() {
    this.#html = document.createElement('div');
    this.#html.classList.add('graph-modal');

    const closeWindow = document.createElement('div');
    closeWindow.classList.add('graph-modal-overlay');
    closeWindow.onclick = this.Close.bind(this);
    this.#html.appendChild(closeWindow);

    const content = document.createElement('div');
    content.classList.add('graph-modal-content', 'modal-content-wide');

    const header = document.createElement('div');
    header.className = 'graph-modal-header';

    const titleDiv = document.createElement('div');
    const title = document.createElement('h2');
    title.innerText = '📈 Compare';
    titleDiv.appendChild(title);
    titleDiv.appendChild(Graph.BuildCommitsLine(this.#config, this.#project, this.#commits));
    header.appendChild(titleDiv);

    const closeButton = document.createElement('button');
    closeButton.classList.add('graph-modal-close');
    closeButton.innerText = 'X';
    closeButton.onclick = this.Close.bind(this);
    header.appendChild(closeButton);
    content.appendChild(header);

    const body = document.createElement('div');
    body.classList.add('graph-modal-body');

    this.#graphContainer = document.createElement('div');
    this.#graphContainer.id = 'graph-overview-container';
    body.appendChild(this.#graphContainer);

    content.appendChild(body);
    this.#html.appendChild(content);

    this.#UpdateOverviewGraphs();
  }

  Open() {
    this.#BuildDialog();

    // Show modal
    document.body.appendChild(this.#html);
    this.#html.classList.add('visible');

    // Prevent body scroll
    document.body.style.overflow = 'hidden';

    // Close modal on ESC key
    this.#saveDocKeyDown = document.onkeydown;
    document.onkeydown = (event) => {if (event.key === 'Escape') { this.Close(); }};
  }

  Close() {
    manageGraphs.UnregisterAllGraphs();

    this.#html.classList.remove('visible');
    document.body.style.overflow = '';
    document.body.removeChild(this.#html);
    document.onkeydown = this.#saveDocKeyDown;

    this.#Reset();
  }

  #HasCompareData(lib, metric) {
    return this.#dataPoints.some(dp => dp?.[this.#type]?.[lib]?.[metric] != null);
  }

  #UpdateOverviewGraphs() {
    manageGraphs.UnregisterAllGraphs();

    if (this.#libs.length === 0) {
      this.#graphContainer.innerHTML = '<div class="no-selection">No Data</div>';
      return;
    }

    this.#graphContainer.innerHTML = '';

    // If multiple libraries, regroup them per metrics
    if (this.#libs.length > 1) {
      if (this.#availableData == null) {
        this.#availableData = (GraphCompare.#overviewMetrics[this.#type] ?? []).map(metric =>
            [metric,  this.#libs.filter(lib => this.#HasCompareData(lib, metric))]
        );
      }

      this.#availableData.forEach(data => {
          const [metric, libs] = data;

          const section = document.createElement('div');
          section.className = 'graph-overview-lib-section';

          const title = document.createElement('div');
          title.className = 'graph-overview-lib-section-title';
          title.textContent = metric;
          section.appendChild(title);

          const graphsContainer = document.createElement('div');
          graphsContainer.className = 'graph-overview-lib-graphs';

          libs.forEach(lib => {
              const graphDiv = document.createElement('div');
              graphDiv.className = 'graph-overview-lib-graph';
              graphDiv.id = `graph-overview-${lib}-${metric}`;
              graphsContainer.appendChild(graphDiv);
          });
          if (graphsContainer.children.length === 0) {
            return;
          }

          section.appendChild(graphsContainer);
          this.#graphContainer.appendChild(section);

          // Render graphs
          setTimeout(() => {
              libs.forEach(lib => {
                  this.#RenderGraph(lib, metric, `graph-overview-${lib}-${metric}`);
              });
          }, 0);
      });
    } else {
      // only one library, keep current layout (per lib)
      const lib = this.#libs[0];

      if (this.#availableData == null) {
        this.#availableData = 
            (GraphCompare.#overviewMetrics[this.#type] ?? []).filter(metric => 
                this.#HasCompareData(lib, metric)
            );
      }

      const section = document.createElement('div');
      section.className = 'graph-overview-lib-section';

      const graphsContainer = document.createElement('div');
      graphsContainer.className = 'graph-overview-lib-graphs';

      this.#availableData.forEach(metric => {
          const graphDiv = document.createElement('div');
          graphDiv.className = 'graph-overview-lib-graph';
          graphDiv.id = `graph-overview-${lib}-${metric}`;
          graphsContainer.appendChild(graphDiv);
      });
      if (graphsContainer.children.length === 0) {
        return;
      }

      section.appendChild(graphsContainer);
      this.#graphContainer.appendChild(section);

      setTimeout(() => {
          this.#availableData.forEach(metric => {
              this.#RenderGraph(lib, metric, `graph-overview-${lib}-${metric}`);
          });
      }, 0);
    }
  }

  #RenderGraph(lib, metric, containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    if (this.#dataPoints.length === 0) {
      container.innerHTML = `<div class="no-selection">${lib} no data for ${metric}</div>`;
      return;
    }

    let [layout, config] = Graph.GenerateEmptyGraphData(this.#type, lib, metric, this.#commitsID);
    let traces = [];
    this.#dataPoints.forEach(dataPoint => {
        [traces, layout] = Graph.AddGraphData([traces, layout], 
            dataPoint?.[this.#type]?.[lib]?.[metric]
        );
    })
    layout.title.font.size = 14;
    layout.margin = { l: 50, r: 20, t: 40, b: 125 };
    Plotly.newPlot(containerId, traces, layout, config);

    manageGraphs.RegisterGraph(containerId);
  }

};

export { GraphCompare };
