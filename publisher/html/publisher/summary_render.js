import { GraphOverview } from './summary_graphoverview.js';
import { GraphCompare } from './summary_graphcompare.js';
import { MetricsCampaign } from './summary_metricscampaign.js';

/*****************************************/

function DisableUI() {
  document.body.setAttribute('inert', '');
  document.body.setAttribute('aria-busy', 'true');
}

function EnableUI() {
  document.body.removeAttribute('inert');
  document.body.removeAttribute('aria-busy');
}

function CopyInClipboard(text) {
  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.style.position = "absolute";
  textArea.style.left = "-999999px";
  document.body.prepend(textArea);
  textArea.select();
  try {
    document.execCommand('copy');
  } catch (error) {
    console.error(error);
  } finally {
    textArea.remove();
  }
}

/*****************************************/

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

function ComputeBasicStats(data) {
  if (data.length === 1) {
    const value = data[0];
    return { min: value, max: value, median: value, mean: value, stddev: 0, values: data, singleValue: true };
  }

  const sorted = [...data].sort((a, b) => a - b);
  const n = sorted.length;

  const min = sorted[0];
  const max = sorted[n - 1];
  if (min === max) {
    const value = data[0];
    return { min: value, max: value, median: value, mean: value, stddev: 0, values: data, singleValue: true };
  }

  const sum = sorted.reduce((acc, val) => acc + val, 0);
  const mean = sum / n;

  const median = n % 2 === 0
    ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2
    : sorted[Math.floor(n / 2)];

  const variance = sorted.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / n;
  const stddev = Math.sqrt(variance);

  return { min, max, median, mean, stddev, values: data };
}

function CalculateStats(data) {
  if (!data || data.length === 0) return null;
  const result = {
    global: ComputeBasicStats(data.flat())
  }
  if (data.some((values => values.length > 1))) {
    result.perRun = ComputeBasicStats(data.map(run => run.reduce((a, b) => a + b, 0) / run.length));
  }
  return result;
}

/*****************************************/

function CreateStatsTooltip(label, data) {
  const formatNum = (num) => num < 10000 ? num.toFixed(2) : num.toExponential(2);

  const tooltip = document.createElement('div');
  tooltip.className = 'stats-tooltip';

  let content = `<div class="tooltip-title">${label}</div>`;

  content += `
    <div class="tooltip-section global">
      <div>Values: ${data.global.values.map(v => formatNum(v)).join(', ')}</div>
      <div>Range: [${formatNum(data.global.min)}–${formatNum(data.global.max)}]</div>
      <div>Median: ${formatNum(data.global.median)}</div>
      <div>Mean: ${formatNum(data.global.mean)} (±${formatNum(data.global.stddev)})</div>
    </div>
  `;
  if (data?.perRun !== undefined) {
    content += `
      <div class="tooltip-section perrun hidden">
        <div>Values: ${data.perRun.values.map(v => formatNum(v)).join(', ')}</div>
        <div>Range: [${formatNum(data.perRun.min)}–${formatNum(data.perRun.max)}]</div>
        <div>Median: ${formatNum(data.perRun.median)}</div>
        <div>Mean: ${formatNum(data.perRun.mean)} (±${formatNum(data.perRun.stddev)})</div>
      </div>
    `;
  }

  tooltip.innerHTML = content;
  return tooltip;
}

function CreateMetricWidget(label, data) {
  if (data.length === 0) {
    return null;
  }
  const stats = CalculateStats(data);

  const statEl = document.createElement('div');
  statEl.className = 'stat-item';
  statEl.innerHTML = `
      <span class="stat-field">${label} ${stats?.perRun ? '(global)' : ''}:</span>
      <span class="stat-value global">${FormatStatsCompact(stats.global)}</span>
  `;
  if (stats?.perRun !== undefined) {
    statEl.innerHTML += `<span class="stat-value perrun hidden">${FormatStatsCompact(stats.perRun)}</span>`;
  }

  // Add hover tooltip only if not a single value
  if (!stats.global.singleValue || (stats.perRun && !stats.perRun.singleValue)) {
    const tooltip = CreateStatsTooltip(label, stats);
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

  if (stats?.perRun) {
    const fieldEl = statEl.querySelector('.stat-field');
    const globalEl = statEl.querySelectorAll('.global');
    const perRunEl = statEl.querySelectorAll('.perrun');
    const toggle = (event) => {
        event.stopPropagation();
        globalEl.forEach(element => element.classList.toggle('hidden'));
        let status = true;
        perRunEl.forEach(element => status = element.classList.toggle('hidden'));
        fieldEl.textContent = `${label} (${status ? 'global' : 'per run'}):`;
    };
    fieldEl.onclick = toggle;
    globalEl.forEach(element => element.onclick = toggle);
    perRunEl.forEach(element => element.onclick = toggle);
  }

  return statEl;
}

function GetReferencedTasks(typeData) {
  if ((typeData?.index === undefined) || (typeData.index?.files === undefined) || 
      (typeData.index?.references === undefined) || (typeData.index.references?.libraries === undefined) || 
      (typeData?.metrics === undefined)) 
    return [];

  // Collect unique details_id from all libs
  const detailsIds = new Set();
  const libPerTask = {};
  for (const lib of Object.keys(typeData.index.references.libraries)) {
    const index = typeData.index.references.libraries[lib];
    if (!libPerTask[index]) {
      libPerTask[index] = [];
    }
    libPerTask[index].push(lib);
    detailsIds.add(index);
  }

  // Get unique tasks at those indices, deduplicate by task_id
  const tasks = [];
  for (const index of detailsIds) {
    const task = typeData.index.files[index];
    if (task && task.file && task.task_id) {
      tasks.push( { task, libs: libPerTask[index] });
    }
  }
  return tasks;
}

function CreateActionDropdown(label, btnClass, tasks, onclickBuilder) {
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
    const libs = task.libs || [];
    item.textContent = libs.join(', ');
    item.setAttribute('onclick', onclickBuilder(task.task));
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
    const taskId = tasks.length === 1 ? tasks[0].task.task_id : '';
    actions.innerHTML = `
      <button class="btn-details" onclick="ShowDetails('${taskId}')">📊 Details</button>
      <button class="btn-download" onclick="DownloadResults('${taskId}')">⬇️ Download</button>
    `;
    return actions;
  }

  // Multiple tasks → dropdown for each button
  actions.appendChild(CreateActionDropdown('📊 Details', 'btn-details', tasks, (task) => `ShowDetails('${task.task_id}')`));
  actions.appendChild(CreateActionDropdown('⬇️ Download', 'btn-download', tasks, (task) => `DownloadResults('${task.task_id}')`));

  return actions;
}

/*****************************************/

function RenderTypeSection(config, project, type, typeData, label, allMetrics, comparaisonElement) {
  const section = document.createElement('div');
  section.className = 'type-section';

  typeData?.index?.files?.forEach(file => {
    const span = document.createElement('span');
    span.id = `${file.task_id}`
    span.className = 'result-anchor';
    section.appendChild(span);
  })

  const typeHeaders = document.createElement('div');
  typeHeaders.className = 'type-headers';

  const headerLabel = document.createElement('div');
  headerLabel.className = 'type-header';

  const permanentLink = document.createElement('h3');
  const taskID = typeData.index?.files[0]?.task_id;
  if (taskID) {
    permanentLink.textContent = `🔗`;
    permanentLink.onclick = (event) => {
        const url = new URL(window.location.href);
        url.hash = taskID;
        CopyInClipboard(url.toString());
    }
  }
  headerLabel.appendChild(permanentLink); 

  if (type == "Campaign") {
    const displayLabel = document.createElement('a');
    displayLabel.textContent = label;
    displayLabel.href = config.vis_comparator_campaign(typeData.user, typeData.campaign_id);
    headerLabel.appendChild(displayLabel);
  } else {
    const displayLabel = document.createElement('span');
    displayLabel.textContent = label;
    headerLabel.appendChild(displayLabel);
  }

  typeHeaders.appendChild(headerLabel);

  const headerActions = document.createElement('div');
  headerActions.className = 'type-header-actions';
  if ((type == 'Perf') || (type == 'Campaign')) {
    const btnAnalyze = document.createElement('button');
    btnAnalyze.className = 'type-header-action';
    btnAnalyze.textContent = '🔬 Analyze';
    let libs = [];
    Object.keys(typeData.metrics).forEach(lib => libs.push(lib));
    btnAnalyze.onclick = (event) => {
      window.open(config.vis_comparator_perf_multiple(typeData.commit_id, libs), "_blank");
    }
    headerActions.appendChild(btnAnalyze);
  }
  if (comparaisonElement && typeData.global_status != 'fail') {
    const index = allMetrics.findIndex(metric => metric.HaveCommit(comparaisonElement.baseCommitID));
    if (index != -1) {
      const btnCompare = document.createElement('button');
      btnCompare.className = 'type-header-action';
      btnCompare.textContent = '📈 Compare';
      btnCompare.onclick = () => {
          if (index == 0) {
            new GraphOverview(allMetrics[0], comparaisonElement).Open(true, comparaisonElement.type);
          } else {
            new GraphCompare(comparaisonElement.type, [ 
                allMetrics[index].GetCommitMetrics(comparaisonElement.baseCommitID), 
                comparaisonElement.dataPoints 
            ], [ comparaisonElement.baseCommitID, comparaisonElement.srcCommitID ]).Open();
          }
      };
      headerActions.appendChild(btnCompare);
    }
  }
  if (type === 'Campaign') {
    const headerDelete = document.createElement('button');
    headerDelete.className = 'type-header-action';
    headerDelete.innerHTML = `<h3>💣👾</h3>`;
    headerDelete.onclick = DeleteResults.bind(this, config, project, section, typeData.source_file);
    headerActions.appendChild(headerDelete);
  }
  typeHeaders.appendChild(headerActions);

  section.appendChild(typeHeaders);

  if (typeData.metrics && Object.keys(typeData.metrics).length > 0) {
    const libsDiv = document.createElement('div');
    libsDiv.className = 'libs-summary';

    const noStatsFields = typeData.no_stats || [];

    for (const [libName, metrics] of Object.entries(typeData.metrics).sort((a,b)=> a[0].localeCompare(b[0]))) {
      const libItem = document.createElement('div');
      libItem.className = 'lib-item';

      const status = typeData.status[libName];

      // Count success/fail if available
      const successCount = status?.success ?? '?';
      const totalRuns = status?.state.length ?? '?';
      const icon = GetLibIcon(successCount, totalRuns);

      // Check for warning
      const warnUser = [];
      if ((type !== 'Vuln') && (status?.trust_objective === 1)) {
        if (metrics?.objective_size) {
          metrics.objective_size.forEach((attempt, index) => { 
              if ((attempt.length === 1) && (attempt[0] > 0)) warnUser.push(index);
          });
        }
      }
      const warningIcon = GetWarningIcon(warnUser);
      if (warningIcon != '') {
        libItem.classList.add('alert');
      }

      let libNameLabel = libName;
      if (type == "Perf") {
        libNameLabel = `<a href=${config.vis_comparator_perf(typeData.commit_id, libName)}>${libName}</a>`;
      }

      const libItemsHeader = document.createElement('div');
      libItemsHeader.className = 'lib-items-header';

      const libItem1Header = document.createElement('div');
      libItem1Header.className = 'lib-item-header';
      libItem1Header.innerHTML = `
        <span class="lib-icon">${icon}</span>
        <span class="lib-harnesskind">${status?.cli?.cputs === true ? '⚙C' : status?.cli?.cputs === false ? '🦀' : '❓'}</span>
        <span class="lib-name">${libNameLabel} ${warningIcon}</span>
        <span class="lib-stats">${successCount}/${totalRuns}</span>
      `;
      libItemsHeader.appendChild(libItem1Header);

      if (status.cli) {
        const libItem2Header = document.createElement('div');
        libItem2Header.className = 'lib-item-header';
        libItem2Header.innerHTML = `
            ${status.cli?.features ? `features: ${status.cli?.features}<br>` : ''}
            ${status.cli?.flags ? `flags: ${status.cli?.flags}` : ''}
        `
        libItemsHeader.appendChild(libItem2Header);
      }

      libItem.appendChild(libItemsHeader);

      // Add compact stats display inline
      if (Object.keys(metrics).length > 0) {
        const libItemStats = document.createElement('div');
        libItemStats.className = 'lib-item-stats';

        const libItemStatsSuccess = document.createElement('div');
        libItemStatsSuccess.className = 'lib-item-stats';
        const libItemStatsFail = document.createElement('div');
        libItemStatsFail.className = 'lib-item-stats lib-item-stats-fail';

        for (const [field, data] of Object.entries(metrics)) {
          const statEl = CreateMetricWidget(field, data);
          if (statEl === null) {
            continue;
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

/*****************************************/

export function RenderCommit(config, project, availableTypes, commit, allMetrics, container, metrics =null) {
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
      let comparaisonElement = null;
      if ((commit?.base) && (commit.base != commit.id)) {
        comparaisonElement = {
            type: type,
            highlights: [commit.base, commit.id],
            baseCommitID: commit.base,
            srcCommitID: commit.id,
            dataPoints: metrics.GetCommitMetrics(commit.id)
        };
      }
      const typeSection = RenderTypeSection(config, project, type, typeData, type, allMetrics, comparaisonElement);
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

export function RenderCampaigns(config, project, commit, allMetrics, container) {
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
    const timestamp = Number(campaign.campaign_id.split('-').pop());
    let date = '';
    if (timestamp) {
      date = ' / [' + new Date(timestamp).toLocaleString(navigator.languages, {
          month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', hour12: false}) + ']';
    }

    let comparaisonElement = null;
    if ((commit?.base) && (commit.base != commit.id)) {
      comparaisonElement = {
          type: 'Perf', 
          highlights: [commit.base, commit.id],
          baseCommitID: commit.base,
          srcCommitID: commit.id,
          dataPoints: MetricsCampaign.GetMetrics(campaign)
      };
    }

    const typeSection = RenderTypeSection(
        config, project, 
        'Campaign', 
        campaign, `👤 ${campaign.user} / ${campaign.campaign_id}${date}`,
        allMetrics, 
        comparaisonElement
    );
    typeSection.dataset.user = campaign.user;
    typeSection.dataset.campaignId = campaign.campaign_id;
    typeSection.dataset.status = campaign.global_status ?? 'no run';
    campaignDiv.appendChild(typeSection);
  }
  container.appendChild(campaignDiv);
}

/*****************************************/

export function ShowDetails(config, taskID) {
  window.open(`${config.taskInfoURL}?id=${taskID}`);
}

export function DownloadResults(config, taskID) {
  const a = document.createElement('a');
  a.href = config.artefactURL(taskID);
  a.download = `${taskID}-artefacts.tgz`;
  a.click();
}

async function DeleteResults(config, project, div, data, event) {
  if (!confirm(`Delete results file:\n\t${data} ?`)) return;

  DisableUI();
  try {
    const response = await fetch(`${config.urlData(project)}/${data}`, { method: 'DELETE' });
    const json = await response.json();
    if (json.success) {
      const commitDiv = div.parentElement;
      div.remove();
      if (commitDiv && !commitDiv.querySelector('.type-section')) {
        commitDiv.remove();
      }
    } else {
      alert(`Server denied deletion of: ${data}\n${json.error ?? ''}`);
    }
  } catch(e) {
    alert('Fatal error while trying remove results: ' + e.name + ' : ' + e.message);
  }
  EnableUI();
}
