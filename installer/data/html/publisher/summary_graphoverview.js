import { Metrics } from './summary_metrics.js';
import { Graph } from './summary_graph.js';
import { manageGraphs } from './summary_managegraphs.js';
import '../third-party/plotly/plotly-3.3.0.min.js';
const Plotly = window.Plotly;

class GraphOverview {
  #metrics;
  #graph;
  #html;
  #type;
  #selectLib;
  #subtypeCheckBox;
  #allLibrariesCheckBox
  #librariesCheckbox;
  #graphContainer;
  #saveDocKeyDown;
  #compareCommit;

  static #overviewMetrics = {
    'Perf': ['corpus_size', 'coverage', 'total_execs'],
    'Vuln': ['durations_s', 'ratio_success_execution', 'total_execs'],
  }

  constructor(metrics, compareCommit =null) {
    this.#Reset();
    this.#metrics = metrics;
    this.#graph = new Graph(metrics);
    this.#compareCommit = compareCommit;
  }

  #Reset() {
    this.#html = null;
    this.#type = null;
    this.#saveDocKeyDown = null;
    this.#selectLib = null;
    this.#subtypeCheckBox = null;
    this.#allLibrariesCheckBox = null;
    this.#librariesCheckbox = null;
    this.#graphContainer = null;
  }

  #BuildDialog(defaultType, hideDetailsSelection) {
    this.#html = document.createElement('div');
    this.#html.classList.add('graph-modal');

    const closeWindow = document.createElement('div');
    closeWindow.classList.add('graph-modal-overlay');
    closeWindow.onclick = this.Close.bind(this);
    this.#html.appendChild(closeWindow);

    const content = document.createElement('div');
    content.classList.add('graph-modal-content', 'modal-content-wide');

    const header = document.createElement('div');
    header.classList.add('graph-modal-header');
    header.innerHTML = '<h2>📈 Performance Overview</h2>';
    const closeButton = document.createElement('button');
    closeButton.classList.add('graph-modal-close');
    closeButton.innerText = 'X';
    closeButton.onclick = this.Close.bind(this);
    header.appendChild(closeButton);
    content.appendChild(header);

    const body = document.createElement('div');
    body.classList.add('graph-modal-body');

    const controls = document.createElement('div');
    controls.classList.add('graph-overview-controls');

    this.#selectLib = document.createElement('select');
    this.#selectLib.innerHTML = 
        `<option value="Perf" ${defaultType == 'Perf' ? 'selected' : ''}>Perf</option>\
        <option value="Vuln" ${defaultType == 'Vuln' ? 'selected' : ''}>Vuln</option>`
    this.#selectLib.onchange = this.#PopulateLibraryCheckboxes.bind(this);
    controls.appendChild(this.#selectLib);

    this.#subtypeCheckBox = document.createElement('div');
    this.#subtypeCheckBox.className = 'graph-overview-controls-subtype';
    if (hideDetailsSelection) {
      this.#subtypeCheckBox.classList.add('hidden');
    }

    const label = document.createElement('label');
    label.classList.add('graph-overview-checkbox');

    this.#allLibrariesCheckBox = document.createElement('input');
    this.#allLibrariesCheckBox.type = 'checkbox';
    this.#allLibrariesCheckBox.onchange = this.#ToggleAllLibraries.bind(this);
    label.appendChild(this.#allLibrariesCheckBox);

    const strong = document.createElement('strong');
    strong.textContent = 'All';
    label.appendChild(strong);

    this.#subtypeCheckBox.appendChild(label);

    this.#librariesCheckbox = document.createElement('div');
    this.#librariesCheckbox.classList.add('graph-overview-libs');
    this.#subtypeCheckBox.appendChild(this.#librariesCheckbox);

    controls.appendChild(this.#subtypeCheckBox);

    body.appendChild(controls);

    this.#graphContainer = document.createElement('div');
    this.#graphContainer.id = 'graph-overview-container';
    body.appendChild(this.#graphContainer);

    content.appendChild(body);
    this.#html.appendChild(content);

    this.#PopulateLibraryCheckboxes();
  }

  Open(hideDetailsSelection =false, defaultType ="Perf") {
    this.#BuildDialog(defaultType, hideDetailsSelection);

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

  #ToggleAllLibraries() {
    const allChecked = this.#allLibrariesCheckBox.checked;
    const checkboxes = this.#librariesCheckbox.querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach(cb => cb.checked = allChecked);
    this.#UpdateOverviewGraphs();
  }

  #PopulateLibraryCheckboxes(event) {
    if (event == null) {
      this.#type = this.#selectLib.value;
    } else {
      if (this.#type === event.currentTarget.value) {
        return;
      }
      this.#type = event.currentTarget.value;
    }
    this.#librariesCheckbox.innerHTML = '';
    this.#subtypeCheckBox.style.display = '';

    const libraries = Object.keys(this.#metrics.GetValuesForType(this.#type) || {}).sort();
    libraries.forEach(lib => {
        const label = document.createElement('label');
        label.className = 'graph-overview-lib-checkbox';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.value = lib;
        checkbox.onchange = this.#UpdateOverviewGraphs.bind(this);
        label.appendChild(checkbox);
        label.appendChild(document.createTextNode(` ${lib}`));
        this.#librariesCheckbox.appendChild(label);
    });

    /*// Reset
    this.#allLibrariesCheckBox.checked = false;
    this.#graphContainer.innerHTML = 
        '<div class="no-selection">Select libraries to display</div>';*/
    // Check all by default
    this.#allLibrariesCheckBox.checked = true;
    const checkboxes = this.#librariesCheckbox.querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach(cb => cb.checked = true);
    this.#UpdateOverviewGraphs();
  }

  #HasCompareData(lib, metric) {
    return !this.#compareCommit || 
        !!this.#compareCommit.dataPoints?.[this.#type]?.[lib]?.[metric];
  }

  #UpdateOverviewGraphs() {
    const selectedLibs = [];
    this.#librariesCheckbox.querySelectorAll('input:checked').forEach(cb => {
        selectedLibs.push(cb.value);
    });

    // Update "All" checkbox state
    const allCheckboxes = this.#librariesCheckbox.querySelectorAll('input');
    const allChecked = allCheckboxes.length > 0 && [...allCheckboxes].every(cb => cb.checked);
    this.#allLibrariesCheckBox.checked = allChecked;

    if (selectedLibs.length === 0) {
      this.#graphContainer.innerHTML = '<div class="no-selection">Select libraries to display</div>';
      return;
    }

    this.#graphContainer.innerHTML = '';

    // Si plusieurs librairies : grouper par métrique
    if (selectedLibs.length > 1) {
      GraphOverview.#overviewMetrics[this.#type].forEach(metric => {
          const section = document.createElement('div');
          section.className = 'graph-overview-lib-section';

          const title = document.createElement('div');
          title.className = 'graph-overview-lib-section-title';
          title.textContent = metric;
          section.appendChild(title);

          const graphsContainer = document.createElement('div');
          graphsContainer.className = 'graph-overview-lib-graphs';

          selectedLibs.forEach(lib => {
              if (!this.#HasCompareData(lib, metric)) return;

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
              selectedLibs.forEach(lib => {
                  this.#RenderGraph(lib, metric, `graph-overview-${lib}-${metric}`);
              });
          }, 0);
      });
    } else {
      // Une seule librairie : garder le layout actuel (par lib)
      const lib = selectedLibs[0];
      const section = document.createElement('div');
      section.className = 'graph-overview-lib-section';

      const graphsContainer = document.createElement('div');
      graphsContainer.className = 'graph-overview-lib-graphs';

      GraphOverview.#overviewMetrics[this.#type].forEach(metric => {
          if (!this.#HasCompareData(lib, metric)) return;

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
          GraphOverview.#overviewMetrics[this.#type].forEach(metric => {
              this.#RenderGraph(lib, metric, `graph-overview-${lib}-${metric}`);
          });
      }, 0);
    }
  }

  #RenderGraph(lib, metric, containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const dataPoints = this.#metrics.GetValues(this.#type, lib, metric);

    if (!dataPoints || dataPoints.length === 0) {
      container.innerHTML = `<div class="no-selection">${lib} no data for ${metric}</div>`;
      return;
    }

    let [traces, layout, config, unusedCommitsList] = this.#graph.GenerateGraphData(this.#type, lib, metric);
    let highlightIndex = -1;
    let highlights = [];
    if (this.#compareCommit) {
      [traces, layout, config, unusedCommitsList, highlightIndex] = this.#graph.InsertComparaisonData(
          [traces, layout, config, unusedCommitsList], 
          this.#compareCommit.dataPoints?.[this.#type]?.[lib]?.[metric], 
          this.#compareCommit.baseCommitID
      );
      highlights = this.#compareCommit?.highlights;
      container.dataset.highlightIndex = highlightIndex;
    }
    layout.title.font.size = 14;
    layout.margin = { l: 50, r: 20, t: 40, b: 125 };
    const ApplyColors = () => {
      Graph.ColorGraphXTicks(container, unusedCommitsList, '#e74c3c');
      Graph.StyleGraphXTicks(container, highlights, { fontWeight: 'bold' });
    };
    Plotly.newPlot(containerId, traces, layout, config)
        .then(() => { ApplyColors(); container.on('plotly_afterplot', ApplyColors); });

    manageGraphs.RegisterGraph(containerId);
  }
};

export { GraphOverview };
