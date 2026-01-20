import { displayGraph, closeGraphModal, updateMetricsList, renderGraph } from './summary_PR_perf.js';
import { displayOverviewGraph, closeOverviewModal, toggleAllLibraries } from './summary_PR_overview.js';

var allCommits = [];
var currentFilter = 'all';
var selectedTypes = new Set(['Perf', 'Vuln']); // Types currently visible
var availableTypes = ['Perf', 'Vuln']; // Default types to load
var showAllCommits = false; // Show all commits regardless of type results

// Export variables for use in other modules
export { allCommits, availableTypes };

// Expose graph functions to global scope for onclick handlers
window.displayGraph = displayGraph;
window.closeGraphModal = closeGraphModal;
window.updateMetricsList = updateMetricsList;
window.renderGraph = renderGraph;
window.displayOverviewGraph = displayOverviewGraph;
window.closeOverviewModal = closeOverviewModal;
window.toggleAllLibraries = toggleAllLibraries;

const config = {
  location: window.location.pathname.substring(0, window.location.pathname.lastIndexOf('/') + 1),
  detailURI: '/html/board/board.html'
};

function calculateStats(durations) {
  if (!durations || durations.length === 0) return null;

  // Special case: single value - return it as stats with zero variance
  if (durations.length === 1) {
    const value = durations[0];
    return { min: value, max: value, median: value, mean: value, stddev: 0, singleValue: true };
  }

  const sorted = [...durations].sort((a, b) => a - b);
  const n = sorted.length;

  const min = sorted[0];
  const max = sorted[n - 1];
  const sum = sorted.reduce((acc, val) => acc + val, 0);
  const mean = sum / n;

  const median = n % 2 === 0
    ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2
    : sorted[Math.floor(n / 2)];

  const variance = sorted.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / n;
  const stddev = Math.sqrt(variance);

  return { min, max, median, mean, stddev };
}

function formatStats(stats, prefix) {
  if (!stats) return '';

  const minStr = formatDuration(stats.min);
  const maxStr = formatDuration(stats.max);
  const medStr = formatDuration(stats.median);
  const meanStr = formatDuration(stats.mean);
  const stddevStr = formatDuration(stats.stddev);

  return `${prefix} Stats: [${minStr}–${maxStr}] med:${medStr} μ:${meanStr}(±${stddevStr})`;
}

function formatDuration(durationMs) {
  const seconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h${minutes % 60}m`;
  } else if (minutes > 0) {
    return `${minutes}m${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

function formatDurationsList(durations) {
  if (!durations || durations.length === 0) return '-';
  return durations.map(d => formatDuration(d)).join(', ');
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelector('.dropdown').addEventListener('mouseleave', () => {
      document.getElementById('graph-menu').style.display = 'none';
  });

  // Parse types from query params if provided
  const urlParams = new URLSearchParams(window.location.search);
  const typesParam = urlParams.get('types');
  if (typesParam) {
    availableTypes = typesParam.split(',').map(t => t.trim());
    selectedTypes = new Set(availableTypes);
  }

  document.getElementById('header-title').textContent = `Results`;
  loadData();
  setupFilters();
  setupTypeFilters();
  setupSearch();
});

function loadData() {
  fetch(`${config.location}/git_history.json`)
    .then(response => {
      if (!response.ok) {
        throw new Error('Failed to load git_history.json');
      }
      return response.json();
    })
    .then(data => {
      document.getElementById('total-commits').textContent = 
        `${data.commits.length} commits in history`;

      document.querySelector('.loading')?.remove();

      loadCommits(data);
    })
    .catch(error => {
      console.error('Error loading git_index.json:', error);
      document.getElementById('commits-list').innerHTML = 
        '<div class="error">❌ Error loading git index</div>';
    });
}

async function loadCommits(commitsInfos) {
  const commitIds = commitsInfos.commits;
  const container = document.getElementById('commits-list');
  const batchSize = 10;

  for (let i = 0; i < commitIds.length; i += batchSize) {
    const batch = commitIds.slice(i, i + batchSize);

    // For each commit, fetch all types in parallel
    const commitPromises = batch.map(async commitId => {
      const commitData = {
        commit_id: commitId,
        types: {}
      };

      // Fetch all types for this commit
      const typePromises = availableTypes.map(type =>
        fetch(`${config.location}/JSON/${type}/${commitId}.json`)
          .then(r => r.ok ? r.json() : null)
          .catch(() => null)
          .then(data => ({ type, data }))
      );

      const typeResults = await Promise.all(typePromises);

      // Store results by type
      typeResults.forEach(({ type, data }) => {
        if (data) {
          commitData.types[type] = data;
        }
      });

      return commitData;
    });

    const results = await Promise.all(commitPromises);

    results.forEach(commitData => {
      allCommits.push(commitData);
      renderCommit(commitData, commitsInfos[commitData.commit_id], container);
    });
  }

  applyFilters();
}

function renderCommit(commit, commitInfos, container) {
  const commitDiv = document.createElement('div');
  commitDiv.className = 'commit';
  commitDiv.dataset.commitId = commit.commit_id;

  // Store all statuses for filtering (including "no run" for missing types)
  const statuses = [];

  for (const type of availableTypes) {
    if (commit.types[type]) {
      statuses.push(commit.types[type].global_status);
    } else {
      statuses.push('no run');
    }
  }
  commitDiv.dataset.statuses = JSON.stringify(statuses);

  // Create header with pastilles
  const header = document.createElement('div');
  header.className = 'commit-header';

  // Create pastilles container
  const pastillesDiv = document.createElement('div');
  pastillesDiv.className = 'pastilles';

  for (const type of availableTypes) {
    const typeData = commit.types[type];
    if (typeData) {
      const pastille = document.createElement('div');
      pastille.className = 'pastille-item';
      pastille.innerHTML = `
        <span class="pastille ${getPastilleClass(typeData.global_status)}">
          ${getPastilleIcon(typeData.global_status)}
        </span>
        <span class="pastille-label">${type}</span>
      `;
      pastillesDiv.appendChild(pastille);
    }
  }

  header.appendChild(pastillesDiv);

  // Add commit info
  const commitInfo = document.createElement('div');
  commitInfo.className = 'commit-info';

  const commentText = commitInfos?.comment ? `<span class="commit-comment">${commitInfos.comment}</span>` : '';

  commitInfo.innerHTML = `
    <span class="commit-id">
      <a href="https://github.com/tlspuffin/tlspuffin/commit/${commit.commit_id}"
        target="_blank" rel="noopener noreferrer">
        ${commit.commit_id}
      </a>
    </span>
    <div class="commit-meta">
      ${commentText}
      <span class="date">${commitInfos?.date || 'no date'}</span>
    </div>
  `;
  header.appendChild(commitInfo);

  commitDiv.appendChild(header);

  // Render sections for each type (or show "no results" if none)
  let hasSections = false;
  for (const type of availableTypes) {
    const typeData = commit.types[type];
    if (typeData) {
      const typeSection = renderTypeSection(type, typeData);
      typeSection.dataset.type = type;
      commitDiv.appendChild(typeSection);
      hasSections = true;
    }
  }

  // If no sections at all, show "No results" message
  if (!hasSections) {
    const noResultsDiv = document.createElement('div');
    noResultsDiv.className = 'no-run';
    noResultsDiv.textContent = 'No results available for this commit';
    commitDiv.appendChild(noResultsDiv);
  }

  container.appendChild(commitDiv);
}

function renderTypeSection(type, typeData) {
  const section = document.createElement('div');
  section.className = 'type-section';

  const typeHeader = document.createElement('div');
  typeHeader.className = 'type-header';
  typeHeader.innerHTML = `<h3>${type}</h3>`;
  section.appendChild(typeHeader);

  if (typeData.libs && Object.keys(typeData.libs).length > 0) {
    const libsDiv = document.createElement('div');
    libsDiv.className = 'libs-summary';

    const noStatsFields = typeData.no_stats || [];

    for (const [libName, libData] of Object.entries(typeData.libs).sort((a,b)=> a[0].localeCompare(b[0]))) {
      const libItem = document.createElement('div');
      libItem.className = 'lib-item';

      // Prepare display data with stats
      const displayData = prepareLibDisplay(libData, noStatsFields);

      // Count success/fail if available
      const successCount = libData.success_count ?? '?';
      const totalRuns = libData.total_runs ?? '?';
      const icon = getLibIcon(successCount, totalRuns);

      // Check for warning
      const warnUser = libData.warn_user;
      const warningIcon = warnUser ? getWarningIcon(warnUser) : '';

      const libItemHeader = document.createElement('div');
      libItemHeader.className = 'lib-item-header';
      // Add lib name, stats, icon directly to libItem
      libItemHeader.innerHTML = `
        <span class="lib-icon">${icon}</span>
        <span class="lib-harnesskind">${libData.cputs == 1 ? '⚙C' : libData.cputs == -1 ? '🦀' : '❓'}</span>
        <span class="lib-name">${libName}${warningIcon}</span>
        <span class="lib-stats">${successCount}/${totalRuns}</span>
      `;
      libItem.appendChild(libItemHeader);

      // Add compact stats display inline
      if (Object.keys(displayData.withStats).length > 0) {
        const libItemStats = document.createElement('div');
        libItemStats.className = 'lib-item-stats';

        const libItemStatsSuccess = document.createElement('div');
        libItemStatsSuccess.className = 'lib-item-stats';
        const libItemStatsFail = document.createElement('div');
        libItemStatsFail.className = 'lib-item-stats lib-item-stats-fail';

        for (const [field, data] of Object.entries(displayData.withStats)) {
          const statEl = document.createElement('div');
          statEl.className = 'stat-item';
          statEl.innerHTML = `
            <span class="stat-field">${field}:</span>
            <span class="stat-value">${formatStatsCompact(data.stats)}</span>
          `;

          // Add hover tooltip only if not a single value
          if (!data.stats || !data.stats.singleValue) {
            const tooltip = createStatsTooltip(field, data, displayData.withoutStats);
            statEl.appendChild(tooltip);
            statEl.addEventListener('mouseenter', () => tooltip.classList.add('visible'));
            statEl.addEventListener('mouseleave', () => tooltip.classList.remove('visible'));
            statEl.style.cursor = 'help';
          } else {
            statEl.style.cursor = 'default';
          }

          if (field.startsWith('fail_')) {
            libItemStatsFail.appendChild(statEl);
          } else {
            libItemStatsSuccess.appendChild(statEl);
          }
        }
        libItemStats.appendChild(libItemStatsSuccess);
        libItemStats.appendChild(libItemStatsFail);
        libItem.appendChild(libItemStats);
      }

      libsDiv.appendChild(libItem);
    }

    section.appendChild(libsDiv);
  }

  // Add actions for this type
  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.innerHTML = `
    <button onclick="showDetails('${typeData.commit_id}', '${typeData.task_id}', '${type}')">📊 Details</button>
    <button onclick="downloadResults('${typeData.commit_id}', ${typeData.task_id}, '${type}')">⬇️ Download</button>
  `;
  section.appendChild(actions);

  return section;
}

function prepareLibDisplay(libData, noStatsFields = []) {
  const display = {
    withStats: {},
    withoutStats: {},
    hidden: []
  };

  for (const [key, value] of Object.entries(libData)) {
    // Skip non-array or empty arrays
    if (!Array.isArray(value) || value.length === 0) {
      display.hidden.push(key);
      continue;
    }

    // Skip non-numeric arrays
    if (typeof value[0] !== 'number') {
      display.hidden.push(key);
      continue;
    }

    // Categorize based on no_stats
    if (noStatsFields.includes(key)) {
      display.withoutStats[key] = { values: value };
    } else if (key != 'warn_user') {
      display.withStats[key] = {
        values: value,
        stats: calculateStats(value)
      };
    }
  }

  return display;
}

function formatStatsCompact(stats) {
  if (!stats) return '-';

  const formatNum = (num) => num < 10000 ? num.toFixed(2) : num.toExponential(2);

  // Special case: single value
  if (stats.singleValue) {
    return `${formatNum(stats.mean)}`;
  }

  const meanStr = formatNum(stats.mean);
  const stddevStr = formatNum(stats.stddev);
  return `μ:${meanStr}(±${stddevStr})`;
}

function createStatsTooltip(field, withStatsData, withoutStatsData) {
  const formatNum = (num) => num < 10000 ? num.toFixed(2) : num.toExponential(2);

  const tooltip = document.createElement('div');
  tooltip.className = 'stats-tooltip';

  let content = `<div class="tooltip-title">${field}</div>`;

  // Show full stats
  if (withStatsData.stats) {
    const s = withStatsData.stats;
    content += `
      <div class="tooltip-section">
        <div>Values: ${withStatsData.values.map(v => formatNum(v)).join(', ')}</div>
        <div>Range: [${formatNum(s.min)}–${formatNum(s.max)}]</div>
        <div>Median: ${formatNum(s.median)}</div>
        <div>Mean: ${formatNum(s.mean)} (±${formatNum(s.stddev)})</div>
      </div>
    `;
  }

  // Show no_stats fields
  if (Object.keys(withoutStatsData).length > 0) {
    content += '<div class="tooltip-section">';
    for (const [noStatField, data] of Object.entries(withoutStatsData)) {
      content += `
        <div class="tooltip-nostats">
          <strong>${noStatField}</strong> (no statistics)
          <div>Values: ${data.values.join(', ')}</div>
        </div>
      `;
    }
    content += '</div>';
  }

  tooltip.innerHTML = content;
  return tooltip;
}


function getPastilleClass(status) {
  const mapping = {
    'success': 'pastille-green',
    'fail': 'pastille-red',
    'mixed': 'pastille-yellow',
    'no run': 'pastille-gray'
  };
  return mapping[status] || 'pastille-gray';
}

function getPastilleIcon(status) {
  const icons = {
    'success': '🟢',
    'fail': '🔴',
    'mixed': '🟡',
    'no run': '⚪'
  };
  return icons[status] || '⚪';
}

function getLibIcon(success, total) {
  if (success === total) return '✅';
  if (success > 0) return '⚠️';
  return '⛔';
}

function getWarningIcon(warnUser) {
  if (!warnUser || !Array.isArray(warnUser) || warnUser.length === 0) return '';

  // warnUser is an array of numbers
  // Array length determines warning level
  // Hover shows the array values

  const warnLevel = warnUser.length;

  let icon = '';
  let title = '';
  let cssClass = 'warn-icon';

  // Format the array values for display
  const valuesStr = warnUser.join(', ');

  if (warnLevel < 2) {
    icon = '🚨';
    title = `Objectif found in run: [${valuesStr}]`;
    cssClass += ' warn-low';
  } else if (warnLevel <= 4) {
    icon = '🚨🚨';
    title = `Objectif found in runs: [${valuesStr}]`;
    cssClass += ' warn-medium';
  } else {
    icon = '🚨🚨🚨';
    title = `Objectif found in runs: [${valuesStr}]`;
    cssClass += ' warn-high';
  }

  return ` <span class="${cssClass}" title="${title}">${icon}</span>`;
}

function setupFilters() {
  const filterButtons = document.querySelectorAll('.filter-btn');

  filterButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      filterButtons.forEach(b => b.classList.remove('active'));

      btn.classList.add('active');

      currentFilter = btn.dataset.filter;
      applyFilters();
    });
  });
}

function applyFilters() {
  const searchTerm = document.getElementById('search-input').value.toLowerCase();
  const commits = document.querySelectorAll('.commit');
  let visibleCount = 0;
  const statusCounts = { success: 0, mixed: 0, fail: 0, 'no run': 0 };

  commits.forEach(commit => {
    const commitId = commit.dataset.commitId.toLowerCase();
    const statuses = JSON.parse(commit.dataset.statuses || '[]');

    // Check if commit has "no results" message (no sections at all)
    const noRunMessage = commit.querySelector('.no-run');
    const isEmptyCommit = !!noRunMessage;

    // STEP 1: Filter by "Show types" (which commits to consider)
    // With the new logic: selecting types means "I want to see the state of these types"
    // So we show ALL commits (to display their state for selected types)
    let typeFilterMatch = false;

    if (showAllCommits) {
      // If "All" is checked, all commits pass the type filter
      typeFilterMatch = true;
    } else if (selectedTypes.size === 0) {
      // No types selected = hide all commits
      typeFilterMatch = false;
    } else {
      // At least one type is selected = show all commits
      // (we want to see their state for the selected types, even if "no run")
      typeFilterMatch = true;
    }

    // If type filter doesn't match, hide and skip
    if (!typeFilterMatch) {
      commit.classList.add('hidden');
      return;
    }

    // Update sections and pastilles visibility based on selected types
    const typeSections = commit.querySelectorAll('.type-section');
    typeSections.forEach(section => {
      const type = section.dataset.type;
      if (showAllCommits || selectedTypes.has(type)) {
        section.style.display = '';
      } else {
        section.style.display = 'none';
      }
    });

    const pastilles = commit.querySelectorAll('.pastille-item');
    pastilles.forEach((pastille, idx) => {
      const type = availableTypes[idx];
      if (type && (showAllCommits || selectedTypes.has(type))) {
        pastille.style.display = '';
      } else {
        pastille.style.display = 'none';
      }
    });

    // STEP 2: Filter by status (among the candidates from step 1)
    let statusMatch = false;

    if (isEmptyCommit) {
      // Empty commits match "all" and "no run"
      statusMatch = (currentFilter === 'all' || currentFilter === 'no run');
    } else if (currentFilter === 'all') {
      statusMatch = true;
    } else if (currentFilter === 'with-results') {
      // At least one visible type must have actual results (not "no run")
      let typeIdx = 0;
      for (const type of availableTypes) {
        if ((showAllCommits || selectedTypes.has(type)) && statuses[typeIdx] && statuses[typeIdx] !== 'no run') {
          statusMatch = true;
          break;
        }
        typeIdx++;
      }
    } else {
      // At least one visible type must match the filter status (OR logic)
      let typeIdx = 0;
      for (const type of availableTypes) {
        if ((showAllCommits || selectedTypes.has(type)) && statuses[typeIdx] === currentFilter) {
          statusMatch = true;
          break;
        }
        typeIdx++;
      }
    }

    const searchMatch = commitId.includes(searchTerm);

    if (statusMatch && searchMatch) {
      commit.classList.remove('hidden');
      visibleCount++;

      // Count statuses for visible types only
      if (isEmptyCommit) {
        statusCounts['no run']++;
      } else {
        let typeIdx = 0;
        for (const type of availableTypes) {
          if ((showAllCommits || selectedTypes.has(type)) && statuses[typeIdx]) {
            const status = statuses[typeIdx];
            if (statusCounts.hasOwnProperty(status)) {
              statusCounts[status]++;
            }
          }
          typeIdx++;
        }
      }
    } else {
      commit.classList.add('hidden');
    }
  });

  updateCounter(visibleCount, statusCounts);

  const noResults = document.getElementById('no-results');
  if (visibleCount === 0 && commits.length > 0) {
    noResults.style.display = 'block';
  } else {
    noResults.style.display = 'none';
  }
}

function setupSearch() {
  const searchInput = document.getElementById('search-input');

  searchInput.addEventListener('input', () => {
    applyFilters();
  });
}

function clearSearch() {
  const searchInput = document.getElementById('search-input');
  searchInput.value = '';
  applyFilters();
}

function setupTypeFilters() {
  const typeFiltersContainer = document.getElementById('type-filters');
  if (!typeFiltersContainer) return;

  typeFiltersContainer.innerHTML = '';

  // Add "All" checkbox first
  const allLabel = document.createElement('label');
  allLabel.className = 'type-filter-label';
  allLabel.style.fontWeight = '600';

  const allCheckbox = document.createElement('input');
  allCheckbox.type = 'checkbox';
  allCheckbox.value = 'all';
  allCheckbox.checked = showAllCommits;
  allCheckbox.addEventListener('change', (e) => {
    showAllCommits = e.target.checked;
    applyFilters();
  });

  allLabel.appendChild(allCheckbox);
  allLabel.appendChild(document.createTextNode(' All'));
  typeFiltersContainer.appendChild(allLabel);

  // Add type checkboxes
  availableTypes.forEach(type => {
    const label = document.createElement('label');
    label.className = 'type-filter-label';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = type;
    checkbox.checked = selectedTypes.has(type);
    checkbox.addEventListener('change', (e) => {
      if (e.target.checked) {
        selectedTypes.add(type);
      } else {
        selectedTypes.delete(type);
      }
      applyFilters();
    });

    label.appendChild(checkbox);
    label.appendChild(document.createTextNode(` ${type}`));
    typeFiltersContainer.appendChild(label);
  });
}

function updateCounter(visibleCount, statusCounts) {
  const counterEl = document.getElementById('total-commits');
  if (!counterEl) return;

  const parts = [];
  if (statusCounts.success > 0) parts.push(`Success: ${statusCounts.success}`);
  if (statusCounts.mixed > 0) parts.push(`Mixed: ${statusCounts.mixed}`);
  if (statusCounts.fail > 0) parts.push(`Fail: ${statusCounts.fail}`);
  if (statusCounts['no run'] > 0) parts.push(`No run: ${statusCounts['no run']}`);

  const summary = parts.length > 0 ? parts.join(', ') : 'No commits';
  counterEl.textContent = `Displaying ${visibleCount} commits: ${summary}`;
}

function showDetails(commitId, taskId, type) {
  window.open(`${window.location.origin}${config.detailURI}?data=${config.location}/PR/${commitId}/${type}/${taskId}.json`);
}

function downloadResults(commitId, taskId, type) {
  window.location.href = `${config.location}/PR/${commitId}/${type}/${taskId}.tgz`;
}

function refreshData() {
  allCommits = [];
  currentFilter = 'all';

  document.querySelectorAll('.filter-btn').forEach((btn, idx) => {
    btn.classList.toggle('active', idx === 0);
  });

  document.getElementById('search-input').value = '';

  const container = document.getElementById('commits-list');
  container.innerHTML = '<div class="loading"><div class="spinner"></div><p>Loading commits...</p></div>';

  loadData();
}

function toggleGraphMenu() {
  const menu = document.getElementById('graph-menu');
  menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
}

// Expose functions on the global window for inline HTML onclick handlers
window.showDetails = showDetails;
window.downloadResults = downloadResults;
window.clearSearch = clearSearch;
window.refreshData = refreshData;
window.toggleGraphMenu = toggleGraphMenu;
