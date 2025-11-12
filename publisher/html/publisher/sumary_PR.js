var allCommits = [];
var currentFilter = 'all';
var dataType = 'Perf';

const config = {
  location: window.location.pathname.substring(0, window.location.pathname.lastIndexOf('/') + 1),
  detailURI: '/html/board/board.html'
};

function calculateStats(durations) {
  if (!durations || durations.length === 0) return null;
  if (durations.length === 1) return null;

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
  dataType = new URLSearchParams(window.location.search)?.get('type') ?? 'Perf';
  document.getElementById('header-title').textContent = `${dataType} Results`;
  loadData();
  setupFilters();
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

    const promises = batch.map(commitId => 
      fetch(`${config.location}/JSON/${dataType}/${commitId}.json`)
        .then(r => r.ok ? r.json() : { commit_id: commitId, global_status: 'no run' })
        .catch(() => ({ commit_id: commitId, global_status: 'no run' }))
    );

    const results = await Promise.all(promises);

    results.forEach(commitData => {
      allCommits.push(commitData);

      if (commitData.global_status === 'no run' && !commitData.libs) {
        renderNoRunCommit(commitData.commit_id, commitsInfos[commitData.commit_id], container);
      } else {
        renderCommit(commitData, commitsInfos[commitData.commit_id], container);
      }
    });
  }

  applyFilters();
}

function renderCommit(commit, commitInfos, container) {
  const commitDiv = document.createElement('div');
  commitDiv.className = `commit commit-${commit.global_status}`;
  commitDiv.dataset.commitId = commit.commit_id;
  commitDiv.dataset.status = commit.global_status;

  const header = document.createElement('div');
  header.className = 'commit-header';
  header.innerHTML = `
    <span class="pastille ${getPastilleClass(commit.global_status)}">
      ${getPastilleIcon(commit.global_status)}
    </span>
    <span class="commit-id">
      <a href="https://github.com/tlspuffin/tlspuffin/commit/${commit.commit_id}"
        target="_blank" rel="noopener noreferrer">
        ${commit.commit_id}
      </a>
    </span>
    <span class="date">${commitInfos?.date || 'no date'}</span>
  `;
  commitDiv.appendChild(header);

  if (commitInfos?.comment) {
    const commentEl = document.createElement('div');
    commentEl.className = 'commit-comment';
    commentEl.textContent = commitInfos.comment;
    commitDiv.appendChild(commentEl);
  }

  if (commit.libs && Object.keys(commit.libs).length > 0) {
    const libsDiv = document.createElement('div');
    libsDiv.className = 'libs-summary';

    for (const [libName, libData] of 
        Object.entries(commit.libs).sort((a,b)=> a[0].localeCompare(b[0]))) {
      const libItem = document.createElement('div');
      libItem.className = 'lib-item';

      const successDurations = libData.success_durations_ms || [];
      const successDurationsFormatted = successDurations.length > 0 ? 
          '✓ ' + successDurations.map(d => formatDuration(d)).join(', ') : '';

      const failDurations = libData.fail_durations_ms || [];
      const failDurationsFormatted = failDurations.length > 0 ?
          '✗ ' + failDurations.map(d => formatDuration(d)).join(', ') : '';

      const successStats = calculateStats(successDurations);
      const failStats = calculateStats(failDurations);

      const icon = getLibIcon(libData.success_count, libData.total_runs);
      libItem.innerHTML = `
        <span class="lib-name">${libName}</span>
        <span class="lib-stats">${libData.success_count}/${libData.total_runs}</span>
        <span class="lib-icon">${icon}</span>
        <div class="lib-durations">
          <span >
            <span class="duration-success">${successDurationsFormatted}</span>
            <span class="duration-fail">${failDurationsFormatted}</span>
          </span>
          ${successStats ? `<div class="duration-success">${formatStats(successStats, '✓')}</div>` : ''}
          ${failStats ? `<div class="duration-fail">${formatStats(failStats, '✗')}</div>` : ''}
        </div>
      `;

      libsDiv.appendChild(libItem);
    }

    commitDiv.appendChild(libsDiv);
  }

  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.innerHTML = `
    <button onclick="showDetails('${commit.commit_id}', '${commit.task_id}')">📊 Details</button>
    <button onclick="downloadResults('${commit.commit_id}', ${commit.task_id})">⬇️ Download</button>
  `;
  commitDiv.appendChild(actions);

  container.appendChild(commitDiv);
}

function renderNoRunCommit(commitId, commitInfos, container) {
  const commitDiv = document.createElement('div');
  commitDiv.className = 'commit commit-no-run';
  commitDiv.dataset.commitId = commitId;
  commitDiv.dataset.status = 'no run';

  const header = document.createElement('div');
  header.className = 'commit-header';
  header.innerHTML = `
    <span class="pastille pastille-gray">⚪</span>
    <span class="commit-id">
      <a href="https://github.com/tlspuffin/tlspuffin/commit/${commitId}"
        target="_blank" rel="noopener noreferrer">
        ${commitId}
      </a>
    </span>
    <span class="date">${commitInfos?.date || 'no date'}</span>
  `;
  commitDiv.appendChild(header);

  if (commitInfos?.comment) {
    const commentEl = document.createElement('div');
    commentEl.className = 'commit-comment';
    commentEl.textContent = commitInfos.comment;
    commitDiv.appendChild(commentEl);
  }

  const noRun = document.createElement('div');
  noRun.className = 'no-run';
  noRun.textContent = 'No resultats';
  commitDiv.appendChild(noRun);

  container.appendChild(commitDiv);
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
  if (success === total) return '✓';
  if (success > 0) return '⚠️';
  return '❌';
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

  commits.forEach(commit => {
    const commitId = commit.dataset.commitId.toLowerCase();
    const status = commit.dataset.status;

    let statusMatch;
    if (currentFilter === 'all') {
      statusMatch = true;
    } else if (currentFilter === 'with-results') {
      statusMatch = status !== 'no run';
    } else {
      statusMatch = status === currentFilter;
    }

    const searchMatch = commitId.includes(searchTerm);

    if (statusMatch && searchMatch) {
      commit.classList.remove('hidden');
      visibleCount++;
    } else {
      commit.classList.add('hidden');
    }
  });

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

function showDetails(commitId, taskId) {
  window.open(`${window.location.origin}${config.detailURI}?data=${config.location}/PR/${commitId}/${dataType}/${taskId}.json`);
}

function downloadResults(commitId, taskId) {
  window.location.href = `${config.location}/PR/${commitId}/${dataType}/${taskId}.tgz`;
}

function refreshData() {
  allCommits = [];
  currentFilter = 'all';

  document.querySelectorAll('.filter-btn').forEach((btn, idx) => {
    btn.classList.toggle('active', idx === 0);
  });

  document.getElementById('search-input').value = '';

  const container = document.getElementById('commits-list');
  container.innerHTML = '<div class="loading"><div class="spinner"></div><p>Chargement des commits...</p></div>';

  loadData();
}
