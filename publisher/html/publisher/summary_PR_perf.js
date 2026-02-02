import './plotly-3.3.0.min.js'
const Plotly = window.Plotly;
import { allCommits, availableTypes } from './summary_PR.js';

var metricsData = {};  // Structure: { type: { library: { metric: [{ commit_id, values, success }] } } }
var commitNames = {};

const metricStatusSuccess = '#27ae60';
const metricStatusFail =  '#e74c3c';
const metricStatusMixed = '#f1c40f';

// Build metrics index from loaded commits
function buildMetricsIndex() {
  metricsData = {};
  commitNames = {};

  // Build timeline from allCommits (already ordered from git_history)
  allCommits.forEach(commit => {

    // Process each type (Perf, Vuln, etc.)
    for (const type of availableTypes) {
      if (type != 'Perf') continue;

      if (!commitNames[commit.commit_id]) {
        commitNames[commit.commit_id] = {};
      }

      const typeData = commit.types[type];
      if (!typeData || !typeData.libs) continue;

      if (!metricsData[type]) metricsData[type] = {};

      // Process each library
      for (const [libName, libData] of Object.entries(typeData.libs)) {
        if (!metricsData[type][libName]) metricsData[type][libName] = {};

        const status = (typeData.global_status === 'success' ? 
            metricStatusSuccess : (typeData.global_status === 'fail' ? metricStatusFail : metricStatusMixed));
        const cputs = libData?.cputs == 1 ? '⚙C' : (libData?.cputs == -1 ? '🦀' : '❓');

        commitNames[commit.commit_id][libName] = cputs;

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
            if (!metricsData[type][libName][realMetricName]) {
              metricsData[type][libName][realMetricName] = [];
            }
            metricsData[type][libName][realMetricName].push({
              commit_id: commit.commit_id,
              values: metricValues,
              status: metricStatusFail,
              cputs
            });
          } else {
            // For success metrics, include all data
            if (!metricsData[type][libName][metricName]) {
              metricsData[type][libName][metricName] = [];
            }
            metricsData[type][libName][metricName].push({
              commit_id: commit.commit_id,
              values: metricValues,
              status,
              cputs
            });
          }
        }
      }
    }
  });
}

// Open graph modal
export function displayGraph() {
  // Build metrics index if not already done
  if (Object.keys(metricsData).length === 0) {
    buildMetricsIndex();
  }

  // Populate type dropdown
  const typeSelect = document.getElementById('type-select');
  typeSelect.innerHTML = '<option value="">Select type...</option>';
  Object.keys(metricsData).sort().forEach(type => {
    const option = document.createElement('option');
    option.value = type;
    option.textContent = type;
    typeSelect.appendChild(option);
  });

  // Reset other dropdowns
  document.getElementById('library-select').innerHTML = '<option value="">Select library...</option>';
  document.getElementById('metric-select').innerHTML = '<option value="">Select metric...</option>';
  document.getElementById('graph-container').innerHTML = '';

  // Show modal
  document.getElementById('graph-modal').classList.add('visible');

  // Prevent body scroll
  document.body.style.overflow = 'hidden';
}

// Close graph modal
export function closeGraphModal() {
  document.getElementById('graph-modal').classList.remove('visible');
  document.body.style.overflow = '';
}

// Update libraries list when type changes
export function updateMetricsList() {
  const typeSelect = document.getElementById('type-select');
  const librarySelect = document.getElementById('library-select');
  const metricSelect = document.getElementById('metric-select');

  const selectedType = typeSelect.value;

  if (!selectedType) {
    librarySelect.innerHTML = '<option value="">Select library...</option>';
    metricSelect.innerHTML = '<option value="">Select metric...</option>';
    document.getElementById('graph-container').innerHTML = '';
    return;
  }

  const selectedLibrary = librarySelect.value;

  // Populate library dropdown
  librarySelect.innerHTML = '<option value="">Select library...</option>';
  const libraries = Object.keys(metricsData[selectedType] || {}).sort();
  libraries.forEach(lib => {
    const option = document.createElement('option');
    option.value = lib;
    option.textContent = lib;
    if (lib == selectedLibrary) option.selected = true;
    librarySelect.appendChild(option);
  });

  if (selectedLibrary != librarySelect.value) {
    selectedLibrary = '';
  }

  if (!selectedLibrary) {
    metricSelect.innerHTML = '<option value="">Select metric...</option>';
    document.getElementById('graph-container').innerHTML = '';
    return;
  }

  let selectedMetric = metricSelect.value;

  // Populate metric dropdown
  metricSelect.innerHTML = '<option value="">Select metric...</option>';
  const metrics = Object.keys(metricsData[selectedType][selectedLibrary] || {}).sort();
  metrics.forEach(metric => {
    const option = document.createElement('option');
    option.value = metric;
    option.textContent = metric;
    if (metric == selectedMetric) {
      option.selected = true;
    }
    metricSelect.appendChild(option);
  });

  if (selectedMetric != metricSelect.value) {
    selectedMetric = '';
  }

  if (!selectedMetric) {
    // Clear graph
    document.getElementById('graph-container').innerHTML = '';
  } else {
    renderGraph();
  }
}

function GenerateGraphData(type, library, metric, metricDataPoints) {
  // Prepare data for Plotly box plot
  const traces = [];

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

  const commitsTimeline = allCommits.reverse();
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
      categoryarray: commitsTimeline.map(c => c.commit_id),
      tickfont: { family: 'monospace' },
      tickvals: commitsTimeline.map(c => c.commit_id),
      ticktext: commitsTimeline.map(c => 
        (commitNames[c.commit_id]?.[library] ?? '') + ' ' + c.commit_id),
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
      b: 120
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

  return [ traces, layout, config ];
}

// Render graph with Plotly
export function renderGraph() {
  const typeSelect = document.getElementById('type-select');
  const librarySelect = document.getElementById('library-select');
  const metricSelect = document.getElementById('metric-select');

  const selectedType = typeSelect.value;
  const selectedLibrary = librarySelect.value;
  const selectedMetric = metricSelect.value;

  if (!selectedType || !selectedLibrary || !selectedMetric) {
    return;
  }

  const metricDataPoints = metricsData[selectedType][selectedLibrary][selectedMetric];

  if (!metricDataPoints || metricDataPoints.length === 0) {
    document.getElementById('graph-container').innerHTML =
      '<div style="text-align: center; padding: 50px; color: #999;">No data available for this metric</div>';
    return;
  }

  Plotly.newPlot('graph-container', ...GenerateGraphData(selectedType, selectedLibrary, selectedMetric, metricDataPoints));
}

// Close modal on ESC key
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeGraphModal();
  }
});

export { metricsData, buildMetricsIndex, GenerateGraphData };