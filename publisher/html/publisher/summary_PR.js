import { config } from './summary_PR_config.js'
import { Metrics } from './summary_PR_metrics.js';
import { MetricsCampaign } from './summary_PR_metrics_campaign.js';
import { GraphMetrics } from './summary_PR_graphmetrics.js';
import { GraphOverview } from './summary_PR_graphoverview.js';

const availableTypes = ['Perf', 'Vuln'];
var project = ''
var fetchControllerGit = null;
var fetchControllerGitLogs = null;
var fetchControllerProject = null;
var ui = {
  tabListsDiv: [],
  commitsDiv: [],
  searchInput: null,
  filterShowAllType: null,
  filterTypeCheckbox: [],
  commonFilters: null,
  campaignsFilters: null,
  searchCommitCampaign: null,
  searchUserCampaign: null,
  searchCampaignCampaign: null,
  prState: null,
  refreshInfos: [],
};
var metrics = [];
var graphs = { metrics: [], overview: [] };
var tabIndex = -1;
var currentFilter = 'all';
var selectedTypes = new Set(availableTypes);
var campaigns = null;

async function LoadGitLogs(commitsArray) {
  try {
    const payload = {
        commits: commitsArray
    };
    fetchControllerGitLogs = new AbortController();
    const response = await fetch(config.urlGitLogs(project), {
        signal: fetchControllerGitLogs.signal,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
    });
    if (!response.ok) {
      throw(`network or server error, status : ${response.status}`);
    }
    const body = await response.json();
    return { error: false, data: body.commits };
  } catch(error) {
    return { error: true, data: error };
  }
}

async function LoadGitData(refresh) {
  try {
    fetchControllerGit = new AbortController();
    const response = await fetch(config.urlGit(project)+refresh, 
        {cache: 'no-store', signal: fetchControllerGit.signal});
    if ((!response.ok) || (response.status != 200)) {
      throw(`Network or server error, status ${response.status}`);
    }
    const body = await response.json();
    if ((body?.success != null) && (!body.success)) {
      throw(`Server error ${body?.error}`);
    }
    return { error: false, data: {
      'commits': body.commits, 
      'PR': body.PR,
      'PR_API_Infos': body.PR_API_Infos, 
      'branches': body.branches
     } };
  } catch(error) {
    return { error: true, data: error };
  }
}

async function LoadProjectData() {
  try {
    fetchControllerProject = new AbortController();
    const response = await fetch(config.urlData(project), 
        {cache: 'no-store', signal: fetchControllerProject.signal});
    if ((!response.ok) || (response.status != 200)) {
      throw(`Network or server error, status ${response.status}`);
    }
    const body = await response.json();
    if (!(body?.success)) {
      throw(`Server error ${body?.error}`);
    }
    return { error: false, data: body?.files };
  } catch(error) {
    return { error: true, data: error };
  }
}

function NormalizeType(type) {
  let result = "unknown";
  if (type) {
    result = type;
    if (result.startsWith("perf")) {
      result = "Perf";
    } else if (result.startsWith("vuln")) {
      result = "Vuln";
    }
  }
  return result;
}

async function LoadCommits(commits) {
  const result = new Map();
  const batchSize = 10;
  for (let i = 0; i < commits.length; i += batchSize) {
    const batch = commits.slice(i, i + batchSize);
    const promises = batch.map(async file => {
        try {
          const response = await fetch(`${config.urlDataFile(project)}/${file}`);
          if (response.ok) {
            const json = await response.json();
            let gitState = result.get(json.commit_id);
            if (!gitState) {
              gitState = new Map();
              result.set(json.commit_id, gitState);
            }
            const type = NormalizeType(json?.type);
            if (type != 'Campaign') {
              gitState.set(type, json);
            } else {
              let campaignArray = gitState.get(type);
              if (!campaignArray) {
                campaignArray = [];
                gitState.set(type, campaignArray);
              }
              campaignArray.push(json);
            }
          } else {
            throw(`Network or server error: ${response.status}`)
          }
        } catch(error) {
          let unknowState = result.get("unknown");
          if (!unknowState) {
            unknowState = new Map();
            result.set("unknown", unknowState);
          }
          unknowState.set(file, { type: 'error', error });
        }
    });
    await Promise.all(promises);
  }
  return result;
}

function GetPastilleClass(status) {
  const mapping = {
    'success': 'pastille-green',
    'fail': 'pastille-red',
    'mixed': 'pastille-yellow',
    'no run': 'pastille-gray'
  };
  return mapping[status] || 'pastille-gray';
}

function GetPastilleIcon(status) {
  const icons = {
    'success': '🟢',
    'fail': '🔴',
    'mixed': '🟡',
    'no run': '⚪'
  };
  return icons[status] || '⚪';
}

function PrepareLibDisplay(libData, noStatsFields = []) {
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
        stats: CalculateStats(value)
      };
    }
  }

  return display;
}

function CalculateStats(durations) {
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

function GetLibIcon(success, total) {
  if (success === total) return '✅';
  if (success > 0) return '⚠️';
  return '⛔';
}

function GetWarningIcon(warnUser) {
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

function FormatStatsCompact(stats) {
  if (!stats) return '-';

  const formatNum = (num) => num < 10000 ? num.toFixed(2) : num.toExponential(2);

  if (stats.singleValue) {
    return `${formatNum(stats.mean)}`;
  }

  const meanStr = formatNum(stats.mean);
  const stddevStr = formatNum(stats.stddev);
  return `μ:${meanStr}(±${stddevStr})`;
}

function CreateStatsTooltip(field, withStatsData, withoutStatsData) {
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

function GetReferencedTasks(typeData) {
  if (!typeData.tasks || !typeData.libs) return [];

  // Collect unique details_id from all libs
  const detailsIds = new Set();
  for (const libData of Object.values(typeData.libs)) {
    if (libData.details_id !== undefined) {
      detailsIds.add(libData.details_id);
    }
  }

  // Get unique tasks at those indices, deduplicate by task_id
  const seen = new Set();
  const tasks = [];
  for (const idx of detailsIds) {
    const task = typeData.tasks[idx];
    if (task && !seen.has(task.task_id)) {
      seen.add(task.task_id);
      tasks.push(task);
    }
  }
  return tasks;
}

function ShowDetails(taskID) {
  window.open(`${config.taskInfoURL}?id=${taskID}`);
}

function DownloadResults(taskID) {
  const a = document.createElement('a');
  a.href = config.artefactURL(taskID);
  a.download = `${taskID}-artefacts.tgz`;
  a.click();
}


function CreateActionDropdown(label, btnClass, tasks, taskLibs, onclickBuilder) {
  const wrapper = document.createElement('div');
  wrapper.className = 'action-dropdown';

  const trigger = document.createElement('button');
  trigger.textContent = `${label}`;
  trigger.className = btnClass;
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    // Close any other open dropdown
    document.querySelectorAll('.action-dropdown-menu.visible').forEach(m => {
      if (m !== menu) m.classList.remove('visible');
    });
    menu.classList.toggle('visible');
  });

  const menu = document.createElement('div');
  menu.className = 'action-dropdown-menu';

  for (const task of tasks) {
    const item = document.createElement('button');
    item.className = `action-dropdown-item ${btnClass}`;
    const libs = taskLibs[task.task_id] || [];
    item.textContent = libs.join(', ');
    item.setAttribute('onclick', onclickBuilder(task));
    item.addEventListener('click', () => menu.classList.remove('visible'));
    menu.appendChild(item);
  }

  wrapper.appendChild(trigger);
  wrapper.appendChild(menu);
  return wrapper;
}

function CreateActionButtons(typeData, type) {
  const actions = document.createElement('div');
  actions.className = 'actions';

  const tasks = GetReferencedTasks(typeData);

  // Fallback: no tasks array or single task → direct buttons
  if (tasks.length <= 1) {
    const taskId = tasks.length === 1 ? tasks[0].task_id : '';
    actions.innerHTML = `
      <button class="btn-details" onclick="ShowDetails('${taskId}')">📊 Details</button>
      <button class="btn-download" onclick="DownloadResults('${taskId}')">⬇️ Download</button>
    `;
    return actions;
  }

  // Build map: task_id → list of lib names
  const taskLibs = {};
  for (const [libName, libData] of Object.entries(typeData.libs)) {
    if (libData.details_id !== undefined) {
      const task = typeData.tasks[libData.details_id];
      if (task) {
        if (!taskLibs[task.task_id]) taskLibs[task.task_id] = [];
        taskLibs[task.task_id].push(libName);
      }
    }
  }

  // Multiple tasks → dropdown for each button
  actions.appendChild(CreateActionDropdown('📊 Details', 'btn-details', tasks, taskLibs, (task) =>
    `ShowDetails('${task.task_id}')`
  ));
  actions.appendChild(CreateActionDropdown('⬇️ Download', 'btn-download', tasks, taskLibs, (task) =>
    `DownloadResults('${task.task_id}')`
  ));

  return actions;
}

function RenderTypeSection(type, typeData) {
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
      const displayData = PrepareLibDisplay(libData, noStatsFields);

      // Count success/fail if available
      const successCount = libData.success_count ?? '?';
      const totalRuns = libData.total_runs ?? '?';
      const icon = GetLibIcon(successCount, totalRuns);

      // Check for warning
      const warnUser = libData.warn_user;
      const warningIcon = warnUser ? GetWarningIcon(warnUser) : '';

      let libNameLabel = libName;
      if (type == "Perf") {
        libNameLabel = `<a href=${config.vis_comparator_details(typeData.commit_id, libName)}>${libName}</a>`;
      }

      const libItemHeader = document.createElement('div');
      libItemHeader.className = 'lib-item-header';
      // Add lib name, stats, icon directly to libItem
      libItemHeader.innerHTML = `
        <span class="lib-icon">${icon}</span>
        <span class="lib-harnesskind">${libData.cputs == 1 ? '⚙C' : libData.cputs == -1 ? '🦀' : '❓'}</span>
        <span class="lib-name">${libNameLabel} ${warningIcon}</span>
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
            <span class="stat-value">${FormatStatsCompact(data.stats)}</span>
          `;

          // Add hover tooltip only if not a single value
          if (!data.stats || !data.stats.singleValue) {
            const tooltip = CreateStatsTooltip(field, data, displayData.withoutStats);
            statEl.appendChild(tooltip);
            statEl.addEventListener('mouseenter', () => {
                tooltip.style.cssText = '';
                tooltip.classList.add('visible');
                const rect = tooltip.getBoundingClientRect();
                if (rect.right > window.innerWidth) {
                  tooltip.style.left = 'auto';
                  tooltip.style.right = '100%';
                  tooltip.style.marginLeft = '0';
                  tooltip.style.marginRight = '10px';
                }
                if (rect.bottom > window.innerHeight) {
                  tooltip.style.top = 'auto';
                  tooltip.style.bottom = '0';
                }
            });
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
  const actions = CreateActionButtons(typeData, type);
  section.appendChild(actions);

  return section;
}

function RenderCommit(commit, container) {
  const commitDiv = document.createElement('div');
  commitDiv.className = 'commit';
  commitDiv.dataset.commitId = commit.id;

  const statuses = [];
  for (const type of availableTypes) {
    if (commit.infos?.has(type)) {
      statuses.push(commit.infos.get(type).global_status);
    } else {
      statuses.push('no run');
    }
  }
  commitDiv.dataset.statuses = JSON.stringify(statuses);

  const header = document.createElement('div');
  header.className = 'commit-header';

  const pastillesDiv = document.createElement('div');
  pastillesDiv.className = 'pastilles';

  for (const type of availableTypes) {
    const typeData = commit.infos?.get(type);
    if (typeData) {
      const pastille = document.createElement('div');
      pastille.className = 'pastille-item';
      pastille.innerHTML = `
        <span class="pastille ${GetPastilleClass(typeData.global_status)}">
          ${GetPastilleIcon(typeData.global_status)}
        </span>
        <span class="pastille-label">${type}</span>
      `;
      pastillesDiv.appendChild(pastille);
    }
  }

  header.appendChild(pastillesDiv);

  const commitInfo = document.createElement('div');
  commitInfo.className = 'commit-info';

  const commentText = commit.comment ? `<span class="commit-comment">${commit.comment}</span>` : '';

  commitInfo.innerHTML = `
    <div class="commit-id-row">
    <span class="commit-id">
      <a href="https://github.com/tlspuffin/tlspuffin/commit/${commit.id}"
        target="_blank" rel="noopener noreferrer">
        ${commit.id}
      </a>
    </span>
    <span class="branch-name">🌿 ${commit.branch ?? ''}</span>
    </div>
    <div class="commit-meta">
      ${commentText}
      <span class="date">${commit.date || 'no date'}</span>
    </div>
  `;
  header.appendChild(commitInfo);

  commitDiv.appendChild(header);

  let hasSections = false;
  for (const type of availableTypes) {
    const typeData = commit.infos?.get(type);
    if (typeData) {
      const typeSection = RenderTypeSection(type, typeData);
      typeSection.dataset.type = type;
      commitDiv.appendChild(typeSection);
      hasSections = true;
    }
  }

  if (!hasSections) {
    const noResultsDiv = document.createElement('div');
    noResultsDiv.className = 'no-run';
    noResultsDiv.textContent = 'No results available for this commit';
    commitDiv.appendChild(noResultsDiv);
  }

  if (commit?.state) {
    commitDiv.dataset.state = commit.state;
  }

  container.appendChild(commitDiv);
}

function RenderCampaigns(commit, container) {
  const campaignList = commit.infos?.get('Campaign');
  if (!campaignList || campaignList.length === 0) return;

  const campaignDiv = document.createElement('div');
  campaignDiv.className = 'commit';
  campaignDiv.dataset.commitId = commit.id;

  const header = document.createElement('div');
  header.className = 'commit-header';

  const campaignInfo = document.createElement('div');
  campaignInfo.className = 'commit-info';
  const commentText = commit.comment ? `<span class="commit-comment">${commit.comment}</span>` : '';
  campaignInfo.innerHTML = `
    <div class="commit-id-row">
      <span class="commit-id">
        <a href="https://github.com/tlspuffin/tlspuffin/commit/${commit.id}"
          target="_blank" rel="noopener noreferrer">
          ${commit.id}
        </a>
      </span>
    </div>
    <div class="commit-meta">
      ${commentText}
      <span class="date">${commit.date || 'no date'}</span>
    </div>
  `;
  header.appendChild(campaignInfo);
  campaignDiv.appendChild(header);

  for (const campaign of campaignList) {
    const typeSection = RenderTypeSection(`👤 ${campaign.user} / ${campaign.campaign_id}`, campaign);
    typeSection.dataset.user = campaign.user;
    typeSection.dataset.campaignId = campaign.campaign_id;
    typeSection.dataset.status = campaign.global_status ?? 'no run';
    campaignDiv.appendChild(typeSection);
  }
  container.appendChild(campaignDiv);
}

function ChangeTab(newTabIndex) {
  if ((newTabIndex != tabIndex) && (tabIndex != -1)) {
    ui.tabListsDiv[tabIndex].classList.remove('active');
    ui.commitsDiv[tabIndex].classList.add('hidden');
  }
  tabIndex = newTabIndex;
  if (tabIndex != -1) {
    ui.tabListsDiv[tabIndex].classList.add('active');
    ui.commitsDiv[tabIndex].classList.remove('hidden');

    document.getElementById('refresh-btn').dataset.type = ui.refreshInfos[tabIndex].type;
    const infos = ui.refreshInfos[tabIndex]?.infos;
    if (infos) {
      const infosUI = document.getElementById('refresh-infos');
      const resetDate = new Date(infos.apiResetTS * 1000).toLocaleString([], { 
          month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', hour12: false});
      infosUI.innerHTML = `🪙 ${infos.apiRemaining}credits<br>⏱ reset: ${resetDate}`;
      infosUI.classList.remove('hidden');
    } else {
      document.getElementById('refresh-infos').classList.add('hidden');
    }
  } else {
    document.getElementById('refresh-btn').dataset.type = '';
    document.getElementById('refresh-infos').classList.add('hidden');
  }

  if (tabIndex == 4) {
    document.getElementById('overview-graph-btn').classList.add('hidden');
    document.getElementById('metrics-graph-btn').classList.add('hidden');
    ui.commonFilters.classList.add('hidden');
    ui.campaignsFilters.classList.remove('hidden');
  } else {
    if (tabIndex == 1) {
      ui.prState.classList.remove('hidden');
    } else {
      ui.prState.classList.add('hidden');
    }
    document.getElementById('overview-graph-btn').classList.remove('hidden');
    document.getElementById('metrics-graph-btn').classList.remove('hidden');
    ui.commonFilters.classList.remove('hidden');
    ui.campaignsFilters.classList.add('hidden');
  }

  ApplyFilters();
}

function ClickTab(event) {
  ChangeTab(ui.tabListsDiv.findIndex((element) => element === event.currentTarget));
}

function UpdateCommitInfo(commit, commitType, files) {
  if (!(commit?.infos)) {
    commit.infos = new Map();
  }
  if (commitType != 'Campaign') {
    commit.infos.set(commitType, files)
  } else {
    let campaignArray = commit.infos.get(commitType);
    if (!campaignArray) {
      campaignArray = [];
      commit.infos.set(commitType, campaignArray);
    }
    campaignArray.push(...files);
  }
}

function SetComboboxOptions(listId, values) {
  const list = document.getElementById(listId);
  list._values = values;
  list.replaceChildren();
  for (const val of values) {
    const li = document.createElement('li');
    li.textContent = val;
    li.onmousedown = (e) => {
      e.preventDefault();
      list.previousElementSibling.value = val;
      list.classList.add('hidden');
      RefreshComboboxOptions();
      ApplyFilters();
    };
    list.appendChild(li);
  }
}

function SetupCombobox(inputId, listId, values) {
  const input = document.getElementById(inputId);
  const list  = document.getElementById(listId);
  list._values = values;

  const render = (filter) => {
    const filtered = filter
      ? list._values.filter(v => v.toLowerCase().includes(filter.toLowerCase()))
      : list._values;
    SetComboboxOptions(listId, filtered);
    list.classList.toggle('hidden', filtered.length === 0);
  };

  input.addEventListener('focus', () => render(input.value));
  input.addEventListener('input', () => render(input.value));
  input.addEventListener('blur', () => { list.classList.add('hidden'); RefreshComboboxOptions(); ApplyFilters(); });
  document.addEventListener('click', e => { if (!input.contains(e.target)) list.classList.add('hidden'); });
}

function RefreshComboboxOptions() {
  const termCommit = ui.searchCommitCampaign.value.toLowerCase();
  const termUser = ui.searchUserCampaign.value.toLowerCase();
  const termCampaign = ui.searchCampaignCampaign.value.toLowerCase();

  const filtered = campaigns.filter(r =>
    (!termCommit || r.commitID.toLowerCase().includes(termCommit)) &&
    (!termUser || r.user.toLowerCase().includes(termUser)) &&
    (!termCampaign || r.campaignID.toLowerCase().includes(termCampaign))
  );

  SetComboboxOptions('dl-commit-campaign', [...new Set(filtered.map(c => c.commitID))]);
  SetComboboxOptions('dl-user-campaign', [...new Set(filtered.map(c => c.user))]);
  SetComboboxOptions('dl-campaign-campaign', [...new Set(filtered.map(c => c.campaignID))]);
}

async function RefreshData(refreshGit) {
  const divHeader = document.getElementsByClassName('header-top')[0];
  divHeader.classList.add('hidden');
  const divFilters = document.getElementById('filters');
  divFilters.classList.add('hidden');
  const divLoading = document.getElementById('loading');
  divLoading.classList.remove('hidden');

  ui.commitsDiv.forEach(div => {
      div.classList.add('hidden');
      div.innerHTML = '';
  });

  const promiseGitData = LoadGitData(refreshGit);
  const promiseProjectData = LoadProjectData()
  const [{ error: errorGit, data: dataGit }, { error: errorProject, data: dataProject }] = 
      await Promise.all([promiseGitData, promiseProjectData]);
  if (errorGit){
    console.log(dataGit);
    return;
  }
  if (errorProject){
    console.log(dataProject);
    return;
  }

  const infos = await LoadCommits(dataProject);

  const unknownCommitID = new Map();
  infos.forEach((typeMap, commitID) => {
      if (commitID == "unknown") {
        return;
      }
      typeMap.forEach((files, commitType) => {
          let found = false;
          for(let i=0; i<dataGit.commits.length; ++i) {
            if (dataGit.commits[i].id == commitID) {
              UpdateCommitInfo(dataGit.commits[i], commitType, files)
              found = true;
              break;
            }
          }
          if (found) {
            return;
          }
          for(let i=0; i<dataGit.PR.length; ++i) {
            if (dataGit.PR[i].id == commitID) {
              UpdateCommitInfo(dataGit.PR[i], commitType, files)
              found = true;
              break;
            }
          }
          if (found) {
            return;
          }
          for(let i=0; i<dataGit.branches.length; ++i) {
            if (dataGit.branches[i].id == commitID) {
              UpdateCommitInfo(dataGit.branches[i], commitType, files)
              found = true;
              break;
            }
          }
          if (!found) {
            if (unknownCommitID.has(commitID)) {
              unknownCommitID.get(commitID).push(commitType);
            } else {
              unknownCommitID.set(commitID, [commitType]);
            }
          }
      })

  })

  const { error: errorGitLogs, data: dataGitLogs } = await LoadGitLogs([...(unknownCommitID.keys())]);
  if (errorGitLogs) {
    console.log(dataGitLogs);
    return;
  }
  dataGitLogs.forEach(element => {
      if (infos.has(element.id)) {
        element.infos = infos.get(element.id);
      }
  });
  dataGit.users = dataGitLogs;

  dataGit.commits.forEach(element => {
      RenderCommit(element, ui.commitsDiv[0]);
  });
  metrics[0] = new Metrics(availableTypes, dataGit.commits);
  graphs.metrics.push(new GraphMetrics(metrics[0]));
  graphs.overview.push(new GraphOverview(metrics[0]));

  dataGit.PR.forEach(element => {
      RenderCommit(element, ui.commitsDiv[1]);
  });
  metrics[1] = new Metrics(availableTypes, dataGit.PR);
  graphs.metrics.push(new GraphMetrics(metrics[1]));
  graphs.overview.push(new GraphOverview(metrics[1]));
  ui.refreshInfos[1]["infos"] = dataGit.PR_API_Infos;

  dataGit.branches.forEach(element => {
      RenderCommit(element, ui.commitsDiv[2]);
  });
  metrics[2] = new Metrics(availableTypes, dataGit.branches);
  graphs.metrics.push(new GraphMetrics(metrics[2]));
  graphs.overview.push(new GraphOverview(metrics[2]));
  dataGit.users.forEach(element => {
      RenderCommit(element, ui.commitsDiv[3]);
  });
  metrics[3] = new Metrics(availableTypes, dataGit.users);
  graphs.metrics.push(new GraphMetrics(metrics[3]));
  graphs.overview.push(new GraphOverview(metrics[3]));
  campaigns = [];
  [dataGit.commits, dataGit.PR, dataGit.users].forEach(dataSrc => {
      dataSrc.forEach(commit => {
          let campaignList = commit?.infos?.get('Campaign');
          if (!campaignList ) {
            return;
          }
          RenderCampaigns(commit, ui.commitsDiv[4]);
          campaigns.push(...campaignList.map(info => ({commitID: info.commit_id, user: info.user, campaignID: info.campaign_id})));
      });
  });
  SetupCombobox('search-commit-campaign', 'dl-commit-campaign', [...new Set(campaigns.map(c => c.commitID))]);
  SetupCombobox('search-user-campaign', 'dl-user-campaign', [...new Set(campaigns.map(c => c.user))]);
  SetupCombobox('search-campaign-campaign', 'dl-campaign-campaign', [...new Set(campaigns.map(c => c.campaignID))]);

  if (tabIndex == -1) {
    ChangeTab(0);
  } else {
    ui.commitsDiv[tabIndex].classList.remove('hidden');
  }

  divFilters.classList.remove('hidden');
  divHeader.classList.remove('hidden');

  divLoading.classList.add('hidden');
}

function ToggleGraphMenu() {
  const menu = document.getElementById('menu-graph');
  menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
}

function DisplayOverviewGraph() {
  if (tabIndex == -1) {
    return;
  }
  graphs.overview[tabIndex].Open();
}

function DisplayMetricsGraph() {
  if (tabIndex == -1) {
    return;
  }
  graphs.metrics[tabIndex].Open();
}

function UpdateCounter(visibleCount, statusCounts) {
  const counterDiv = document.getElementById('total-commits');
  if (!counterDiv) return;

  const parts = [];
  if (statusCounts.success > 0) parts.push(`Success: ${statusCounts.success}`);
  if (statusCounts.mixed > 0) parts.push(`Mixed: ${statusCounts.mixed}`);
  if (statusCounts.fail > 0) parts.push(`Fail: ${statusCounts.fail}`);
  if (statusCounts['no run'] > 0) parts.push(`No run: ${statusCounts['no run']}`);

  let label = 'commits';
  if (tabIndex == 4) {
    label = 'campaigns';
  }

  const summary = parts.length > 0 ? parts.join(', ') : `No ${label}`;
  counterDiv.textContent = `Displaying ${visibleCount} ${label}: ${summary}`;
}

function ApplyFiltersCampaigns() {
  const termCommit = ui.searchCommitCampaign.value.toLowerCase();
  const termUser = ui.searchUserCampaign.value.toLowerCase();
  const termCampaign = ui.searchCampaignCampaign.value.toLowerCase();
  const commits = ui.commitsDiv[tabIndex].querySelectorAll('.commit');
  const statusCounts = { success: 0, mixed: 0, fail: 0, 'no run': 0 };
  let visibleCount = 0;

  commits.forEach(commit => {
    const commitId = commit.dataset.commitId.toLowerCase();
    if (termCommit && !commitId.includes(termCommit)) {
      commit.classList.add('hidden');
      return;
    }
    const sections = commit.querySelectorAll('.type-section');
    let anyVisible = false;
    sections.forEach(section => {
      const userMatch = !termUser || section.dataset.user?.toLowerCase().includes(termUser);
      const campaignMatch = 
          !termCampaign || section.dataset.campaignId?.toLowerCase().includes(termCampaign);
      section.style.display = (userMatch && campaignMatch) ? '' : 'none';
      if (userMatch && campaignMatch) {
        anyVisible = true;
        visibleCount++;
        const status = section.dataset.status;
        if (statusCounts.hasOwnProperty(status)) {
          statusCounts[status]++;
        }
      }
    });
    commit.classList.toggle('hidden', !anyVisible);
  });

  UpdateCounter(visibleCount, statusCounts);
}

function ApplyFilters() {
  if (tabIndex == -1) return;

  if (tabIndex == 4) {
    return ApplyFiltersCampaigns();
  }

  const searchTerm = ui.searchInput.value.toLowerCase();
  const showAllCommits = ui.filterShowAllType.checked;
  const commits = ui.commitsDiv[tabIndex].querySelectorAll('.commit');
  let visibleCount = 0;
  const statusCounts = { success: 0, mixed: 0, fail: 0, 'no run': 0 };

  const filterOpenOnly = document.getElementById('pr-state-toggle').classList.contains('active');

  commits.forEach(commit => {
    const commitId = commit.dataset.commitId.toLowerCase();
    const statuses = JSON.parse(commit.dataset.statuses || '[]');

    // Check if commit has "no results" message (no sections at all)
    const noRunMessage = commit.querySelector('.no-run');
    const isEmptyCommit = !!noRunMessage;

    if (commit.dataset.state && filterOpenOnly && commit.dataset.state !== 'open') {
      commit.classList.add('hidden');
      return;
    }

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
    const pastilles = commit.querySelectorAll('.pastille-item');
    pastilles.forEach((pastille, idx) => {
      if (!(showAllCommits || selectedTypes.has(availableTypes[idx]))) {
        pastille.style.display = 'none';
        return;
      }
      const sectionStatus = statuses[idx];
      if (currentFilter === 'all') {
        pastille.style.display = '';
      } else if (currentFilter === 'with-results') {
        pastille.style.display = (sectionStatus && sectionStatus !== 'no run') ? '' : 'none';
      } else {
        pastille.style.display = (sectionStatus === currentFilter) ? '' : 'none';
      }
    });

    const typeSections = commit.querySelectorAll('.type-section');
    typeSections.forEach(section => {
      const type = section.dataset.type;
      if (!(showAllCommits || selectedTypes.has(type))) {
        section.style.display = 'none';
        return;
      }
      const typeIdx = availableTypes.indexOf(type);
      const sectionStatus = statuses[typeIdx];
      if (currentFilter === 'all') {
        section.style.display = '';
      } else if (currentFilter === 'with-results') {
        section.style.display = (sectionStatus && sectionStatus !== 'no run') ? '' : 'none';
      } else {
        section.style.display = (sectionStatus === currentFilter) ? '' : 'none';
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

  UpdateCounter(visibleCount, statusCounts);

  /*const noResults = document.getElementById('no-results');
  if (visibleCount === 0 && commits.length > 0) {
    noResults.style.display = 'block';
  } else {
    noResults.style.display = 'none';
  }*/
}

function ClearSearch(widgetID) {
  document.getElementById(widgetID).value = '';
  if (tabIndex == 4) {
    RefreshComboboxOptions();
  }
  ApplyFilters();
}

function SelectAllType(event) {
  const checked = event.currentTarget.checked;
  ui.filterTypeCheckbox.forEach(element => { element.checked = checked; });
  if (checked) {
    availableTypes.forEach(type => selectedTypes.add(type));
  } else {
    selectedTypes.clear();
  }
  ApplyFilters();
}

async function Main() {
  const title = document.getElementById('header-title');
  title.innerText = `Results browser on ${window.location.hostname}`;

  const match = window.location.pathname.match(/\/files\/([^/]+)\/*/);
  project = match?.[1];

  ui.searchInput = document.getElementById('search-input');
  ui.searchInput.addEventListener('input', () => {
    ApplyFilters();
  });

  const filterButtons = document.querySelectorAll('.filter-btn');
  filterButtons.forEach(btn => {
      btn.addEventListener('click', () => {
          filterButtons.forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          currentFilter = btn.dataset.filter;
          ApplyFilters();
      });
  });

  const typeFiltersContainer = document.getElementById('type-filters');
  typeFiltersContainer.innerHTML = '';
  // Add "All" checkbox first
  const allLabel = document.createElement('label');
  allLabel.className = 'type-filter-label';
  allLabel.style.fontWeight = '600';
  ui.filterShowAllType = document.createElement('input');
  ui.filterShowAllType.type = 'checkbox';
  ui.filterShowAllType.value = 'all';
  ui.filterShowAllType.checked = true;
  ui.filterShowAllType.onchange = SelectAllType;
  allLabel.appendChild(ui.filterShowAllType);
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
      checkbox.addEventListener('change', (event) => {
        const previousAllChecked = ui.filterShowAllType.checked;
        if (event.target.checked) {
          selectedTypes.add(type);
        } else {
          selectedTypes.delete(type);
        }
        if (selectedTypes.size == availableTypes.length && (!previousAllChecked)) {
          ui.filterShowAllType.checked = true;
        } else if (selectedTypes.size != availableTypes.length && previousAllChecked) {
          ui.filterShowAllType.checked = false;
        }
        ApplyFilters();
      });

      label.appendChild(checkbox);
      label.appendChild(document.createTextNode(` ${type}`));
      typeFiltersContainer.appendChild(label);

      ui.filterTypeCheckbox.push(checkbox);
  });

  const urlParams = new URLSearchParams(window.location.search);
  const tabParam = parseInt(urlParams.get('tab'));

  ui.tabListsDiv = [
      document.getElementById('maindevTab'),
      document.getElementById('prTab'),
      document.getElementById('branchesTab'),
      document.getElementById('othersTab'),
      document.getElementById('campaignsTab')
  ];
  ui.tabListsDiv[0].onclick = ClickTab;
  ui.tabListsDiv[1].onclick = ClickTab;
  ui.tabListsDiv[2].onclick = ClickTab;
  ui.tabListsDiv[3].onclick = ClickTab;
  ui.tabListsDiv[4].onclick = ClickTab;

  ui.refreshInfos[0] = { type: 'free', parameter: '?refresh=local' }
  ui.refreshInfos[1] = { type: 'gold', parameter: '?refresh=all' }
  ui.refreshInfos[2] = { type: 'free', parameter: '?refresh=local' }
  ui.refreshInfos[3] = { type: 'free', parameter: '?refresh=local' }
  ui.refreshInfos[4] = { type: 'free', parameter: '?refresh=local' }

  ui.commitsDiv = [
      document.getElementById('maindevCommits'),
      document.getElementById('prCommits'),
      document.getElementById('branchesCommits'),
      document.getElementById('usersCommits'),
      document.getElementById('campaignsCommits'),
  ]
  ui.commitsDiv[0].classList.add('hidden');
  ui.commitsDiv[1].classList.add('hidden');
  ui.commitsDiv[2].classList.add('hidden');
  ui.commitsDiv[3].classList.add('hidden');
  ui.commitsDiv[4].classList.add('hidden');

  const initialTab = (!isNaN(tabParam) && tabParam >= 0 && tabParam < ui.tabListsDiv.length) ? tabParam : 0;

  ui.commonFilters = document.getElementById('common-filters');
  ui.campaignsFilters = document.getElementById('campaigns-filters');
  ui.searchCommitCampaign = document.getElementById('search-commit-campaign');
  ui.searchUserCampaign = document.getElementById('search-user-campaign');
  ui.searchCampaignCampaign = document.getElementById('search-campaign-campaign');
  ui.prState = document.getElementById('filter-PR-state');

  document.getElementById('pr-state-toggle').addEventListener('click', (e) => {
    e.currentTarget.classList.toggle('active');
    ApplyFilters();
  });

  window.ShowDetails = ShowDetails;
  window.DownloadResults = DownloadResults;
  window.BtnRefreshData = () => {
    if ((tabIndex >= 0) && (tabIndex < ui.refreshInfos.length)) {
      RefreshData(ui.refreshInfos[tabIndex].parameter);
    } else {
      RefreshData("");
    }
  }
  window.ToggleGraphMenu = ToggleGraphMenu;
  window.DisplayOverviewGraph = DisplayOverviewGraph;
  window.DisplayMetricsGraph = DisplayMetricsGraph;
  window.ClearSearch = ClearSearch;

  await RefreshData("");
  if (tabIndex != initialTab) {
    ChangeTab(initialTab);
  }
}

Main();
