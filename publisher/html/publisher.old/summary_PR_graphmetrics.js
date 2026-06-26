import { Metrics } from './summary_PR_metrics.js';
import { manageGraphs } from './summary_PR_managegraphs.js';
import '../third-party/plotly/plotly-3.3.0.min.js';
const Plotly = window.Plotly;

class GraphMetrics {
  #metrics;
  #html;
  #selectType;
  #selectSubType;
  #selectMetric;
  #graphContainer;
  #saveDocKeyDown;

  constructor(metrics) {
    this.#metrics = metrics;
    this.#Reset();
  }

  #Reset() {
    this.#html = null;
    this.#selectType = null;
    this.#selectSubType = null;
    this.#selectMetric = null;
    this.#graphContainer = null;
    this.#saveDocKeyDown = null;
  }

  #BuildDialog() {
    this.#html = document.createElement('div');
    this.#html.classList.add('graph-modal');
    const closeWindow = document.createElement('div');
    closeWindow.classList.add('graph-modal-overlay');
    closeWindow.onclick = this.Close.bind(this);
    this.#html.appendChild(closeWindow);
    const content = document.createElement('div');
    content.classList.add('graph-modal-content');

    const header = document.createElement('div');
    header.classList.add('graph-modal-header');
    header.innerHTML = '<h2>📈 Metrics Evolution</h2>';
    const closeButton = document.createElement('button');
    closeButton.classList.add('graph-modal-close');
    closeButton.innerText = 'X';
    closeButton.onclick = this.Close.bind(this);
    header.appendChild(closeButton);
    content.appendChild(header);

    const body = document.createElement('div');
    body.classList.add('graph-modal-body');

    const controls = document.createElement('div');
    controls.classList.add('graph-controls');

    let controlsGroup = null;
    [controlsGroup, this.#selectType] = this.#BuildControlDiv('type', 'Type', this.#UpdateMetricsList.bind(this));
    controls.appendChild(controlsGroup);
    [controlsGroup, this.#selectSubType] = this.#BuildControlDiv('library', 'Library / Vuln', this.#UpdateMetricsList.bind(this));
    controls.appendChild(controlsGroup);
    [controlsGroup, this.#selectMetric] = this.#BuildControlDiv('metric', 'Metric', this.#RenderGraph.bind(this));
    controls.appendChild(controlsGroup);

    body.appendChild(controls);

    this.#graphContainer = document.createElement('div');
    this.#graphContainer.id = 'graph-container';
    body.appendChild(this.#graphContainer);

    content.appendChild(body);
    this.#html.appendChild(content);
  }

  #BuildControlDiv(prefix, info, onChange) {
    const controlsGroup = document.createElement('div');
    controlsGroup.classList.add('graph-control-group');

    const label = document.createElement('label');
    label.setAttribute('for', prefix+'-select')
    label.textContent = info + ':';
    controlsGroup.appendChild(label);

    const select = document.createElement('select');
    select.id = prefix+'-select';
    select.onchange = onChange;

    const options = document.createElement('option');
    options.value = '';
    options.textContent = 'Select '+ info;

    select.appendChild(options);

    controlsGroup.appendChild(select);
    return [ controlsGroup, select ];
  }

  Open() {
    this.#BuildDialog();

    this.#selectType.innerHTML = '<option value="">Select type...</option>';
    this.#metrics.GetTypes().sort().forEach(type => {
        const option = document.createElement('option');
        option.value = type;
        option.textContent = type;
        this.#selectType.appendChild(option);
    });

    this.#selectSubType.innerHTML = '<option value="">Select library / vuln...</option>';
    this.#selectMetric.innerHTML = '<option value="">Select metric...</option>';
    this.#graphContainer.innerHTML = '';

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

  // Update libraries list when type changes
  #UpdateMetricsList() {
    const selectedType = this.#selectType.value;
    if (!selectedType) {
      this.#selectSubType.innerHTML = '<option value="">Select library / vuln...</option>';
      this.#selectMetric.innerHTML = '<option value="">Select metric...</option>';
      this.#graphContainer.innerHTML = '';
      return;
    }

    let selectedLibrary = this.#selectSubType.value;
    // Populate library dropdown
    this.#selectSubType.innerHTML = '<option value="">Select library / vuln...</option>';
    const libraries = Object.keys(this.#metrics.GetValuesForType(selectedType) || {}).sort();
    libraries.forEach(lib => {
        const option = document.createElement('option');
        option.value = lib;
        option.textContent = lib;
        if (lib == selectedLibrary) option.selected = true;
        this.#selectSubType.appendChild(option);
    });

    if (selectedLibrary != this.#selectSubType.value) {
      selectedLibrary = '';
    }

    if (!selectedLibrary) {
      this.#selectMetric.innerHTML = '<option value="">Select metric...</option>';
      this.#graphContainer.innerHTML = '';
      return;
    }

    let selectedMetric = this.#selectMetric.value;
    // Populate metric dropdown
    this.#selectMetric.innerHTML = '<option value="">Select metric...</option>';
    const metrics = Object.keys(this.#metrics.GetValuesForSubType(selectedType, selectedLibrary) || {}).sort();
    metrics.forEach(metric => {
        const option = document.createElement('option');
        option.value = metric;
        option.textContent = metric;
        if (metric == selectedMetric) {
          option.selected = true;
        }
        this.#selectMetric.appendChild(option);
    });

    if (selectedMetric != this.#selectMetric.value) {
      selectedMetric = '';
    }

    if (!selectedMetric) {
      // Clear graph
      this.#graphContainer.innerHTML = '';
    } else {
      this.#RenderGraph();
    }
  }

  // Render graph with Plotly
  #RenderGraph() {
    const selectedType = this.#selectType.value;
    const selectedLibrary = this.#selectSubType.value;
    const selectedMetric = this.#selectMetric.value;

    if (!selectedType || !selectedLibrary || !selectedMetric) {
      return;
    }

    const metricDataPoints = this.#metrics.GetValues(selectedType, selectedLibrary, selectedMetric);

    if (!metricDataPoints || metricDataPoints.length === 0) {
      this.#graphContainer.innerHTML = 
          '<div style="text-align: center; padding: 50px; color: #999;">No data available for this metric</div>';
      return;
    }
    
    const [ traces, layout, config, unusedCommitsList ] = 
        this.#metrics.GenerateGraphData(selectedType, selectedLibrary, selectedMetric);
    const ApplyColors = () => Metrics.ColorGraphXTicks(this.#graphContainer, unusedCommitsList, '#e74c3c');
    Plotly.newPlot('graph-container', traces, layout, config)
        .then((result) => { ApplyColors(); this.#graphContainer.on('plotly_afterplot', ApplyColors); });

    manageGraphs.RegisterGraph(this.#graphContainer);
  }
};

export { GraphMetrics };
