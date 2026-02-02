import './plotly-3.3.0.min.js';
const Plotly = window.Plotly;
import { metricsData, buildMetricsIndex, GenerateGraphData } from './summary_PR_perf.js';

const overviewMetrics = ['corpus_size', 'coverage', 'total_execs'];

// Open overview modal
export function displayOverviewGraph() {
  // Réutilise buildMetricsIndex de summary_PR_perf.js
  if (Object.keys(metricsData).length === 0) {
    buildMetricsIndex();
  }

  populateLibraryCheckboxes();
  document.getElementById('overview-modal').classList.add('visible');
  document.body.style.overflow = 'hidden';
}

// Close overview modal
export function closeOverviewModal() {
  document.getElementById('overview-modal').classList.remove('visible');
  document.body.style.overflow = '';
}

// Populate library checkboxes
function populateLibraryCheckboxes() {
  const container = document.getElementById('lib-checkboxes');
  container.innerHTML = '';

  const libraries = Object.keys(metricsData['Perf'] || {}).sort();

  libraries.forEach(lib => {
    const label = document.createElement('label');
    label.className = 'lib-checkbox';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = lib;
    checkbox.onchange = updateOverviewGraphs;
    label.appendChild(checkbox);
    label.appendChild(document.createTextNode(` ${lib}`));
    container.appendChild(label);
  });

  /*// Reset
  document.getElementById('lib-all').checked = false;
  document.getElementById('overview-graphs').innerHTML = 
    '<div class="no-selection">Select libraries to display</div>';*/
  // Check all by default
  document.getElementById('lib-all').checked = true;
  const checkboxes = document.querySelectorAll('#lib-checkboxes input[type="checkbox"]');
  checkboxes.forEach(cb => cb.checked = true);
  updateOverviewGraphs();
}

// Toggle all libraries
export function toggleAllLibraries() {
  const allChecked = document.getElementById('lib-all').checked;
  const checkboxes = document.querySelectorAll('#lib-checkboxes input[type="checkbox"]');
  checkboxes.forEach(cb => cb.checked = allChecked);
  updateOverviewGraphs();
}

// Update graphs based on selection
function updateOverviewGraphs() {
  const selectedLibs = [];
  document.querySelectorAll('#lib-checkboxes input:checked').forEach(cb => {
    selectedLibs.push(cb.value);
  });

  // Update "All" checkbox state
  const allCheckboxes = document.querySelectorAll('#lib-checkboxes input');
  const allChecked = allCheckboxes.length > 0 && [...allCheckboxes].every(cb => cb.checked);
  document.getElementById('lib-all').checked = allChecked;

  const container = document.getElementById('overview-graphs');

  if (selectedLibs.length === 0) {
    container.innerHTML = '<div class="no-selection">Select libraries to display</div>';
    return;
  }

  container.innerHTML = '';

  // Si plusieurs librairies : grouper par métrique
  if (selectedLibs.length > 1) {
    overviewMetrics.forEach(metric => {
      const section = document.createElement('div');
      section.className = 'lib-section';

      const title = document.createElement('div');
      title.className = 'lib-section-title';
      title.textContent = metric;
      section.appendChild(title);

      const graphsContainer = document.createElement('div');
      graphsContainer.className = 'lib-graphs';

      selectedLibs.forEach(lib => {
        const graphDiv = document.createElement('div');
        graphDiv.className = 'lib-graph';
        graphDiv.id = `graph-${metric}-${lib}`;
        graphsContainer.appendChild(graphDiv);
      });

      section.appendChild(graphsContainer);
      container.appendChild(section);

      // Render graphs
      setTimeout(() => {
        selectedLibs.forEach(lib => {
          renderLibraryMetricGraph(lib, metric, `graph-${metric}-${lib}`);
        });
      }, 0);
    });
  } else {
    // Une seule librairie : garder le layout actuel (par lib)
    const lib = selectedLibs[0];
    const section = document.createElement('div');
    section.className = 'lib-section';

    const graphsContainer = document.createElement('div');
    graphsContainer.className = 'lib-graphs';

    overviewMetrics.forEach(metric => {
      const graphDiv = document.createElement('div');
      graphDiv.className = 'lib-graph';
      graphDiv.id = `graph-${lib}-${metric}`;
      graphsContainer.appendChild(graphDiv);
    });

    section.appendChild(graphsContainer);
    container.appendChild(section);

    setTimeout(() => {
      overviewMetrics.forEach(metric => {
        renderLibraryMetricGraph(lib, metric, `graph-${lib}-${metric}`);
      });
    }, 0);
  }
}


// Render a single graph for a library/metric
function renderLibraryMetricGraph(lib, metric, containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const dataPoints = metricsData['Perf']?.[lib]?.[metric];

  if (!dataPoints || dataPoints.length === 0) {
    container.innerHTML = `<div class="no-selection">No data for ${metric}</div>`;
    return;
  }

  const [traces, layout, config] = GenerateGraphData('Perf', lib, metric, dataPoints);  
  layout.title.font.size = 14;
  layout.margin = { l: 50, r: 20, t: 40, b: 90 };
  Plotly.newPlot(containerId, traces, layout, config);
}

// Close on ESC
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeOverviewModal();
  }
});