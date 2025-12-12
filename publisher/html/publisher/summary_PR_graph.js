import './plotly-3.3.0.min.js'
const Plotly = window.Plotly;
import { allCommits, availableTypes } from './summary_PR.js';

var metricsData = {};  // Structure: { type: { library: { metric: [{ commit_id, values, success }] } } }
var commitsTimeline = [];  // Ordered list of commits from oldest to newest

// Build metrics index from loaded commits
function buildMetricsIndex() {
  metricsData = {};
  commitsTimeline = [];

  // Build timeline from allCommits (already ordered from git_history)
  allCommits.forEach(commit => {
    commitsTimeline.push(commit.commit_id);

    // Process each type (Perf, Vuln, etc.)
    for (const type of availableTypes) {
      const typeData = commit.types[type];
      if (!typeData || !typeData.libs) continue;

      if (!metricsData[type]) metricsData[type] = {};

      // Process each library
      for (const [libName, libData] of Object.entries(typeData.libs)) {
        if (!metricsData[type][libName]) metricsData[type][libName] = {};

        const isSuccess = (libData.success_count > 0) && (typeData.global_status !== 'fail');

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
            // For fail metrics, include all data
            if (!metricsData[type][libName][metricName]) {
              metricsData[type][libName][metricName] = [];
            }
            metricsData[type][libName][metricName].push({
              commit_id: commit.commit_id,
              values: metricValues,
              success: isSuccess
            });
          } else {
            // For success metrics, only include if run was successful
            if (isSuccess) {
              if (!metricsData[type][libName][metricName]) {
                metricsData[type][libName][metricName] = [];
              }
              metricsData[type][libName][metricName].push({
                commit_id: commit.commit_id,
                values: metricValues,
                success: true
              });
            }
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

  // Populate library dropdown
  librarySelect.innerHTML = '<option value="">Select library...</option>';
  const libraries = Object.keys(metricsData[selectedType] || {}).sort();
  libraries.forEach(lib => {
    const option = document.createElement('option');
    option.value = lib;
    option.textContent = lib;
    librarySelect.appendChild(option);
  });

  const selectedLibrary = librarySelect.value;

  if (!selectedLibrary) {
    metricSelect.innerHTML = '<option value="">Select metric...</option>';
    document.getElementById('graph-container').innerHTML = '';
    return;
  }

  // Populate metric dropdown
  metricSelect.innerHTML = '<option value="">Select metric...</option>';
  const metrics = Object.keys(metricsData[selectedType][selectedLibrary] || {}).sort();
  metrics.forEach(metric => {
    const option = document.createElement('option');
    option.value = metric;
    option.textContent = metric;
    metricSelect.appendChild(option);
  });

  // Clear graph
  document.getElementById('graph-container').innerHTML = '';
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

  // Prepare data for Plotly box plot
  const traces = [];

  metricDataPoints.forEach(dataPoint => {
    const trace = {
      y: dataPoint.values,
      type: 'box',
      name: dataPoint.commit_id.substring(0, 7),
      boxmean: 'sd',  // Show mean and standard deviation
      marker: {
        color: dataPoint.success ? '#27ae60' : '#e74c3c'
      },
      hovertemplate:
        '<b>Commit:</b> ' + dataPoint.commit_id.substring(0, 7) + '<br>' +
        '<b>Value:</b> %{y}<br>' +
        '<extra></extra>'
    };
    traces.push(trace);
  });

  const layout = {
    title: {
      text: `${selectedLibrary} - ${selectedMetric} (${selectedType})`,
      font: { size: 18, weight: 600 }
    },
    xaxis: {
      title: 'Commits (oldest → newest)',
      tickangle: -45
    },
    yaxis: {
      title: selectedMetric
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

  Plotly.newPlot('graph-container', traces, layout, config);
}

// Close modal on ESC key
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeGraphModal();
  }
});