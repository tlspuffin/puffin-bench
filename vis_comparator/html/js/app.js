import './plotly-3.3.0.min.js'
const Plotly = window.Plotly;

// API Base URL
const API_BASE = '/api/PR';

// State
const state = {
  commitType: 'Perf',
  commitId: null,
  subject: null,
  runs: [],
  clients: [],
  metrics: [],
  aggregate: 'sum',
  timeRange: { min: 0, max: 10000, step: 100 }
};

// DOM Elements
const els = {
  commitType: document.getElementById('commit-type'),
  commitId: document.getElementById('commit-id'),
  subject: document.getElementById('subject'),
  runsContainer: document.getElementById('runs-container'),
  clientsContainer: document.getElementById('clients-container'),
  metricsContainer: document.getElementById('metrics-container'),
  timeMin: document.getElementById('time-min'),
  timeMax: document.getElementById('time-max'),
  timeStep: document.getElementById('time-step'),
  plotBtn: document.getElementById('plot-btn'),
  loading: document.getElementById('loading'),
  chart: document.getElementById('chart'),
  error: document.getElementById('error')
};

// Initialize
async function init() {
  setupEventListeners();
  await loadCommits();
}

function setupEventListeners() {
  els.commitType.addEventListener('change', onCommitTypeChange);
  els.commitId.addEventListener('change', onCommitChange);
  els.subject.addEventListener('change', onSubjectChange);
  els.plotBtn.addEventListener('click', generatePlot);
  
  document.querySelectorAll('input[name="aggregate"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
      state.aggregate = e.target.value;
    });
  });
  
  els.timeMin.addEventListener('change', () => {
    state.timeRange.min = parseInt(els.timeMin.value);
  });
  
  els.timeMax.addEventListener('change', () => {
    state.timeRange.max = parseInt(els.timeMax.value);
  });
  
  els.timeStep.addEventListener('change', () => {
    state.timeRange.step = parseInt(els.timeStep.value);
  });
}

// API Functions
async function loadCommits() {
  try {
    const response = await fetch(`${API_BASE}/commits/${state.commitType}`);
    const data = await response.json();
    
    els.commitId.innerHTML = '<option value="">Select a commit</option>';
    data.commits.forEach(commit => {
      const option = document.createElement('option');
      option.value = commit;
      option.textContent = commit.substring(0, 8);
      els.commitId.appendChild(option);
    });
    
    els.commitId.disabled = false;
  } catch (error) {
    showError('Failed to load commits: ' + error.message);
  }
}

async function loadSubjects() {
  try {
    const response = await fetch(
      `${API_BASE}/subjects/${state.commitType}/${state.commitId}`
    );
    const data = await response.json();
    
    els.subject.innerHTML = '<option value="">Select a subject</option>';
    Object.entries(data).forEach(([subject, count]) => {
      const option = document.createElement('option');
      option.value = subject;
      option.textContent = `${subject} (${count} runs)`;
      els.subject.appendChild(option);
    });
    
    els.subject.disabled = false;
  } catch (error) {
    showError('Failed to load subjects: ' + error.message);
  }
}

async function loadMetrics() {
  try {
    const response = await fetch(
      `${API_BASE}/metrics/${state.commitType}/${state.commitId}/${state.subject}`
    );
    const data = await response.json();

    // Populate runs
    els.runsContainer.innerHTML = '';
    data.runs.forEach(run => {
      const label = document.createElement('label');
      label.className = 'checkbox-label';
      label.innerHTML = `
        <input type="checkbox" class="run-checkbox" value="${run.id}" checked>
        <span>Run ${run.id}</span>
      `;
      els.runsContainer.appendChild(label);
    });

    // Calculate max runTime across all runs and set default time-max
    const maxRunTime = Math.max(...data.runs.map(run => run.runTime));
    // Convert from microseconds to milliseconds and add 10% buffer
    const maxTimeMs = Math.ceil(maxRunTime / 1000 * 1.1);

    // Update time-max input and state
    els.timeMax.value = maxTimeMs;
    state.timeRange.max = maxTimeMs;

    // Populate clients (from first run)
    const firstRun = data.runs[0];
    els.clientsContainer.innerHTML = '';
    for (let i = 1; i <= firstRun.nbClient; i++) {
      const label = document.createElement('label');
      label.className = 'checkbox-label';
      label.innerHTML = `
        <input type="checkbox" class="client-checkbox" value="${i}" checked>
        <span>Client ${i}</span>
      `;
      els.clientsContainer.appendChild(label);
    }

    // Populate metrics
    els.metricsContainer.innerHTML = '';
    const metrics = new Set();
    firstRun.metrics.forEach(m => metrics.add(m));

    Array.from(metrics).sort().forEach(metric => {
      const label = document.createElement('label');
      label.className = 'checkbox-label';
      label.innerHTML = `
        <input type="checkbox" class="metric-checkbox" value="${metric}" checked>
        <span>${metric}</span>
      `;
      els.metricsContainer.appendChild(label);
    });

    els.plotBtn.disabled = false;
  } catch (error) {
    showError('Failed to load metrics: ' + error.message);
  }
}

// Event Handlers
async function onCommitTypeChange(e) {
  state.commitType = e.target.value;
  state.commitId = null;
  state.subject = null;
  
  els.subject.disabled = true;
  els.plotBtn.disabled = true;
  
  await loadCommits();
}

async function onCommitChange(e) {
  state.commitId = e.target.value;
  state.subject = null;
  
  if (!state.commitId) {
    els.subject.disabled = true;
    els.plotBtn.disabled = true;
    return;
  }
  
  await loadSubjects();
}

async function onSubjectChange(e) {
  state.subject = e.target.value;
  
  if (!state.subject) {
    els.plotBtn.disabled = true;
    return;
  }
  
  await loadMetrics();
}

// Binary Parser for your API format
async function parseBinaryResponse(response) {
  const buffer = await response.arrayBuffer();
  const view = new DataView(buffer);
  
  // Read JSON size (first 8 bytes, little-endian uint64)
  const jsonSize = Number(view.getBigUint64(0, true));
  
  // Read JSON header
  const jsonBytes = new Uint8Array(buffer, 8, jsonSize);
  const jsonText = new TextDecoder().decode(jsonBytes);
  const header = JSON.parse(jsonText);
  
  // Parse binary data
  let offset = 8 + jsonSize;
  let remain = jsonSize % 8;
  if (remain != 0) {
    offset += 8 - remain;
  }
  const series = {};
  
  for (const metric of header.metrics) {
    const count = header.count;
    let data;
    
    if (metric.type === 'uint64') {
      // Read uint64 array
      const arr = new BigUint64Array(buffer, offset, count);
      data = Array.from(arr, x => Number(x));
      offset += count * 8;
    } else if (metric.type === 'double') {
      // Read double array
      const arr = new Float64Array(buffer, offset, count);
      data = Array.from(arr);
      offset += count * 8;
    }
    
    series[metric.name] = data;
  }
  
  return { header, series };
}

// Generate Plot
async function generatePlot() {
  try {
    showLoading(true);
    hideError();
    
    // Collect selected values
    const selectedRuns = Array.from(
      document.querySelectorAll('.run-checkbox:checked')
    ).map(cb => parseInt(cb.value));
    
    const selectedClients = Array.from(
      document.querySelectorAll('.client-checkbox:checked')
    ).map(cb => parseInt(cb.value));
    
    const selectedMetrics = Array.from(
      document.querySelectorAll('.metric-checkbox:checked')
    ).map(cb => cb.value);
    
    if (selectedRuns.length === 0) {
      throw new Error('Please select at least one run');
    }
    
    if (selectedMetrics.length === 0) {
      throw new Error('Please select at least one metric');
    }
    
    // Build API URL
    const url = `${API_BASE}/values/${state.commitType}/${state.commitId}/${state.subject}/${state.timeRange.min}/${state.timeRange.max}/${state.timeRange.step}`;
    
    // Fetch data
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        runs: selectedRuns,
        clients: selectedClients,
        metrics: selectedMetrics,
        aggregate: state.aggregate
      })
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    // Parse binary response
    const { header, series } = await parseBinaryResponse(response);
    
    // Generate timestamps
    const timestamps = Array.from(
      { length: header.count },
      (_, i) => (header.min + i * header.step) / 1000  // Convert to seconds
    );
    
    // Create Plotly traces
    const traces = [];
    const colors = [
      '#2563eb', '#dc2626', '#16a34a', '#ea580c', '#9333ea',
      '#0891b2', '#ca8a04', '#db2777', '#65a30d', '#0284c7'
    ];
    
    // Group metrics by base name (before .mean/.ci_lower/.ci_upper)
    const metricGroups = {};
    Object.keys(series).forEach(metricName => {
      const baseName = metricName.replace(/\.(mean|ci_lower|ci_upper)$/, '');
      if (!metricGroups[baseName]) {
        metricGroups[baseName] = {};
      }
      
      if (metricName.endsWith('.mean')) {
        metricGroups[baseName].mean = series[metricName];
      } else if (metricName.endsWith('.ci_lower')) {
        metricGroups[baseName].ci_lower = series[metricName];
      } else if (metricName.endsWith('.ci_upper')) {
        metricGroups[baseName].ci_upper = series[metricName];
      } else {
        // Raw metric without stats
        metricGroups[baseName].raw = series[metricName];
      }
    });
    
    // Create traces for each metric
    let colorIndex = 0;
    Object.entries(metricGroups).forEach(([metricName, data]) => {
      const color = colors[colorIndex % colors.length];
      colorIndex++;
      
      if (data.mean && data.ci_lower && data.ci_upper) {
        // Add confidence interval band
        traces.push({
          x: timestamps.concat(timestamps.slice().reverse()),
          y: data.ci_upper.concat(data.ci_lower.slice().reverse()),
          fill: 'toself',
          fillcolor: color.replace(')', ', 0.15)').replace('rgb', 'rgba'),
          line: { color: 'transparent' },
          name: `${metricName} (95% CI)`,
          showlegend: true,
          type: 'scatter',
          hoverinfo: 'skip'
        });
        
        // Add mean line
        traces.push({
          x: timestamps,
          y: data.mean,
          mode: 'lines',
          name: metricName,
          line: { color: color, width: 2 },
          type: 'scatter'
        });
      } else if (data.raw) {
        // Raw data without statistics
        traces.push({
          x: timestamps,
          y: data.raw,
          mode: 'lines',
          name: metricName,
          line: { color: color, width: 2 },
          type: 'scatter'
        });
      }
    });
    
    // Plot layout
    const layout = {
      title: {
        text: `${state.subject} - Commit ${state.commitId.substring(0, 8)}`,
        font: { size: 18 }
      },
      xaxis: {
        title: 'Time (seconds)',
        gridcolor: '#e2e8f0',
        zeroline: false
      },
      yaxis: {
        title: 'Value',
        gridcolor: '#e2e8f0',
        zeroline: false
      },
      hovermode: 'x unified',
      plot_bgcolor: '#ffffff',
      paper_bgcolor: '#ffffff',
      margin: { l: 60, r: 40, t: 60, b: 60 },
      legend: {
        orientation: 'v',
        x: 1.02,
        y: 1,
        xanchor: 'left',
        yanchor: 'top'
      }
    };
    
    const config = {
      responsive: true,
      displayModeBar: true,
      modeBarButtonsToRemove: ['lasso2d', 'select2d'],
      toImageButtonOptions: {
        format: 'png',
        filename: `${state.subject}_${state.commitId.substring(0, 8)}`,
        height: 800,
        width: 1200,
        scale: 2
      }
    };
    
    // Render plot
    Plotly.newPlot('chart', traces, layout, config);
    
  } catch (error) {
    showError(error.message);
    console.error('Plot generation failed:', error);
  } finally {
    showLoading(false);
  }
}

// UI Helpers
function showLoading(show) {
  els.loading.classList.toggle('hidden', !show);
  els.chart.style.opacity = show ? '0.3' : '1';
}

function showError(message) {
  els.error.textContent = `Error: ${message}`;
  els.error.classList.remove('hidden');
}

function hideError() {
  els.error.classList.add('hidden');
}

// Initialize on load
document.addEventListener('DOMContentLoaded', init);