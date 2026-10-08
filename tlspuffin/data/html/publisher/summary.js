import { urls as configURLS } from './summary_config.js'
import { LoadCommits, LoadGitData, LoadGitLogs, LoadProjectData, UpdateCommitInfo } from './summary_data.js'
import { RenderCommit, RenderCampaigns, ShowDetails, DownloadResults, SetPullRequests } from './summary_render.js'
import { registerCommits as RegisterCommits } from '../common/commitinfo.js'
import { Metrics } from './summary_metrics.js';
import { GraphMetrics } from './summary_graphmetrics.js';
import { GraphOverview } from './summary_graphoverview.js';

/*****************************************/

// the git repository of a package: sshpuffin is built from the tlspuffin repository
const REPOSITORY = { sshpuffin: 'tlspuffin' };
const Repository = (project) => REPOSITORY[project] ?? project;

const config = {
  urlData: (project) => `http://${window.location.host}/api/project/${project}/data`,
  urlDataFile: (project) => `http://${window.location.host}/files/${project}/.project`,

  urlGit: (project) => `${configURLS.git_restapi}/api/git/history/${Repository(project)}`,
  urlGitLogs: (project) => `${configURLS.git_restapi}/api/git/logs/${Repository(project)}`,

  taskInfoURL: `${configURLS.scheduler}/files/board/task.html`,
  artefactURL: (taskID) => `${configURLS.scheduler}/api/task/${taskID}/artefacts`,

  vis_comparator: (project) => configURLS.vis_comparator(project),
  vis_comparator_perf: (project, commitID, libraryName) => `${configURLS.vis_comparator(project)}?template=TwoTasksTemplate_2C1S&c1=${commitID}&c2=@dev-base&c2.alias=Dev&s1=Perf%3A${libraryName}`,
  vis_comparator_campaign: (project, user, campaignID) => `${configURLS.vis_comparator(project)}?k1=${encodeURIComponent(user+':'+campaignID.replace(/-(?=[^-]*$)/, ":"))}`,
  vis_comparator_perf_multiple: (project, commitID, librariesName) => {
    const libraries = librariesName.map((name, index) => `&s${index+1}=${encodeURIComponent(`Perf:${name}`)}`).join('');
    return `${configURLS.vis_comparator(project)}?template=PerfCompareTemplate&c1=${commitID}&c2=@dev-base&c2.alias=Dev${libraries}`
  },
  commit_url: (project, commit) => configURLS.commit_url(project, commit)
}

const availableTypes = ['Perf', 'Vuln'];
var project = ''
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
// the cards of a tab are built when it is first shown (a tab holds hundreds of commits, most without results:
// building the four tabs before showing the first one took most of the load time); see RenderTab
let tabRenderers = [];
let tabRendered = [];

function RenderTab(index) {
  if ((index < 0) || tabRendered[index] || !tabRenderers[index]) return;
  tabRendered[index] = true;
  tabRenderers[index]();
  ApplyOrder();
}
// status filter: 'all', 'with-results' (default: commits with at least one result) or 'status' (the statuses
// chosen among the colored dots, several at a time)
var statusFilter = { mode: 'with-results', statuses: new Set() };

function StatusShown(status) {
  if (statusFilter.mode === 'all') return true;
  if (statusFilter.mode === 'with-results') return !!status && (status !== 'no run');
  return statusFilter.statuses.has(status);
}
var selectedTypes = new Set(availableTypes);
var campaigns = null;

/*****************************************/

function DisableUI() {
  document.body.setAttribute('inert', '');
  document.body.setAttribute('aria-busy', 'true');
}

function EnableUI() {
  document.body.removeAttribute('inert');
  document.body.removeAttribute('aria-busy');
}

/*****************************************/

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

function ApplyFiltersCampaigns() {
  const termCommit = ui.searchCommitCampaign.value.toLowerCase();
  const termUser = ui.searchUserCampaign.value.toLowerCase();
  const termCampaign = ui.searchCampaignCampaign.value.toLowerCase();
  const commits = ui.commitsDiv[tabIndex].querySelectorAll('.commit');
  const statusCounts = { success: 0, mixed: 0, fail: 0, 'no run': 0 };
  let visibleCount = 0;

  commits.forEach(commit => {
    // sha, PR numbers and message (see CommitSearchText)
    const commitId = (commit.dataset.search ?? commit.dataset.commitId).toLowerCase();
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
    // sha, PR numbers and message (see CommitSearchText)
    const commitId = (commit.dataset.search ?? commit.dataset.commitId).toLowerCase();
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
      pastille.style.display = StatusShown(statuses[idx]) ? '' : 'none';
    });

    const typeSections = commit.querySelectorAll('.type-section');
    typeSections.forEach(section => {
      const type = section.dataset.type;
      if (!(showAllCommits || selectedTypes.has(type))) {
        section.style.display = 'none';
        return;
      }
      const typeIdx = availableTypes.indexOf(type);
      section.style.display = StatusShown(statuses[typeIdx]) ? '' : 'none';
    });

    // STEP 2: Filter by status (among the candidates from step 1)
    let statusMatch = false;

    if (isEmptyCommit) {
      // commits without results: shown by "All" and by the ⚪ dot
      statusMatch = (statusFilter.mode === 'all') ||
          ((statusFilter.mode === 'status') && statusFilter.statuses.has('no run'));
    } else {
      // at least one shown type with a shown status
      statusMatch = availableTypes.some((type, typeIdx) =>
          (showAllCommits || selectedTypes.has(type)) && StatusShown(statuses[typeIdx]));
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

function UpdateCounter(visibleCount, statusCounts) {
  const counterDiv = document.getElementById('total-commits');
  if (!counterDiv) return;

  // compact: "214 commits · 🟢 120 🟡 30 🔴 4 ⚪ 60", the words in the hover
  const icons = { success: '🟢', mixed: '🟡', fail: '🔴', 'no run': '⚪' };
  const words = { success: 'success', mixed: 'mixed', fail: 'fail', 'no run': 'no run' };
  const present = Object.keys(icons).filter(status => statusCounts[status] > 0);

  let label = 'commits';
  if (tabIndex == 4) {
    label = 'campaigns';
  }

  counterDiv.textContent = `${visibleCount} ${label}` +
      (present.length ? ' · ' + present.map(status => `${icons[status]} ${statusCounts[status]}`).join(' ') : '');
  counterDiv.dataset.clickTip = `Displaying ${visibleCount} ${label}` +
      (present.length ? ': ' + present.map(status => `${words[status]} ${statusCounts[status]}`).join(', ') : '');
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

/*****************************************/

function ChangeTab(newTabIndex) {
  RenderTab(newTabIndex);
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
    let title = ui.refreshInfos[tabIndex].type === 'gold'
        ? 'Refresh this tab: fetches the pull requests from GitHub (costs API credits)' : 'Refresh this tab';
    if (infos) {
      const infosUI = document.getElementById('refresh-infos');
      const resetDate = new Date(infos.apiResetTS * 1000).toLocaleString([], {
          month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', hour12: false});
      infosUI.innerHTML = `🪙 ${infos.apiRemaining}credits<br>⏱ reset: ${resetDate}`;
      infosUI.classList.remove('hidden');
      title += `\n🪙 ${infos.apiRemaining} credits left, reset ${resetDate}`;
    } else {
      document.getElementById('refresh-infos').classList.add('hidden');
    }
    // the refresh button is the one of the top bar (nav.js)
    window.dispatchEvent(new CustomEvent('pb-refresh-state',
        { detail: { level: ui.refreshInfos[tabIndex].type, title } }));
  } else {
    document.getElementById('refresh-btn').dataset.type = '';
    document.getElementById('refresh-infos').classList.add('hidden');
    window.dispatchEvent(new CustomEvent('pb-refresh-state', { detail: { level: '', title: '' } }));
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

function ScrollToTarget() {
  let ref = document.getElementById(window.location.hash.slice(1));
  if (!ref && window.location.hash.length > 1) {
    // the card may be in a tab not built yet: build them all, then look again
    tabRenderers.forEach((renderer, i) => RenderTab(i));
    ref = document.getElementById(window.location.hash.slice(1));
  }
  const pageIndex = ref?.closest('.page')?.dataset.index;
  if ((pageIndex === undefined) || (pageIndex === null)) {
    return;
  }
  ChangeTab(+pageIndex);
  ref.scrollIntoView();
}

/*****************************************/

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

/*****************************************/

// Loading failed or there is nothing to show: say so in place of the spinner (a package without results, e.g.
// sshpuffin, used to show "Loading..." for ever)
function ShowLoadEnd(text) {
  const divLoading = document.getElementById('loading');
  divLoading.classList.add('ended');
  divLoading.querySelector('h1').textContent = text;
  EnableUI();
}

// Order of the commit rows: 'commit' (as listed: git order) or 'run' (latest run first, see RunDate); remembered
let order = (() => { try { return localStorage.getItem('pb-results-order') || 'commit'; } catch (error) { return 'commit'; } })();

function ApplyOrder() {
  document.querySelectorAll('.order-toggle [data-order]').forEach(button => button.classList.toggle('active', button.dataset.order === order));
  Array.from(ui.commitsDiv).forEach(div => {
    const rows = [...div.querySelectorAll(':scope > .commit')];
    rows.sort((a, b) => (order === 'run' ? (Number(b.dataset.run) || 0) - (Number(a.dataset.run) || 0) : 0)
        || (Number(a.dataset.order) - Number(b.dataset.order)));
    rows.forEach(row => div.appendChild(row));
  });
}

document.querySelectorAll('.order-toggle [data-order]').forEach(button => button.addEventListener('click', () => {
  order = button.dataset.order;
  try { localStorage.setItem('pb-results-order', order); } catch (error) { /* a convenience only */ }
  ApplyOrder();
}));

async function RefreshData(refreshGit) {
  DisableUI();

  const divHeader = document.getElementsByClassName('header-top')[0];
  divHeader.classList.add('hidden');
  const divFilters = document.getElementById('filters');
  divFilters.classList.add('hidden');
  const divLoading = document.getElementById('loading');
  divLoading.classList.remove('hidden', 'ended');
  divLoading.querySelector('h1').textContent = 'Loading...';

  ui.commitsDiv.forEach(div => {
      div.classList.add('hidden');
      div.innerHTML = '';
  });

  const promiseGitData = LoadGitData(refreshGit, config, project);
  const promiseProjectData = LoadProjectData(config, project);
  const [{ error: errorGit, data: dataGit }, { error: errorProject, data: dataProject }] = 
      await Promise.all([promiseGitData, promiseProjectData]);
  if (!errorProject && (Object.keys(dataProject ?? {}).length === 0)) {
    ShowLoadEnd(`No results for ${project} yet.`);
    return;
  }
  if (errorGit){
    console.log(dataGit);
    ShowLoadEnd(`No results shown for ${project}: its commit history is not available (${dataGit}).`);
    return;
  }
  if (errorProject){
    console.log(dataProject);
    ShowLoadEnd(`No results shown for ${project}: its results are not available (${dataProject}).`);
    return;
  }

  const infos = await LoadCommits(dataProject, config, project);

  const unknownCommitID = new Map();
  infos.forEach((typeMap, commitID) => {
      if (commitID == "unknown") {
        return;
      }
      typeMap.forEach((data, commitType) => {
          let found = false;
          for(let i=0; i<dataGit.commits.length; ++i) {
            if (dataGit.commits[i].id == commitID) {
              UpdateCommitInfo(dataGit.commits[i], commitType, data)
              found = true;
              break;
            }
          }
          if (found) {
            return;
          }
          for(let i=0; i<dataGit.PR.length; ++i) {
            if (dataGit.PR[i].id == commitID) {
              UpdateCommitInfo(dataGit.PR[i], commitType, data)
              found = true;
              break;
            }
          }
          if (found) {
            return;
          }
          for(let i=0; i<dataGit.branches.length; ++i) {
            if (dataGit.branches[i].id == commitID) {
              UpdateCommitInfo(dataGit.branches[i], commitType, data)
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

  const { error: errorGitLogs, data: dataGitLogs } = await LoadGitLogs([...(unknownCommitID.keys())], config, project);
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

  new Map(Object.entries(dataGit)
      .filter(key => key[0] !== 'PR_API_Infos')
      .flatMap(([, value]) => value)
      .map(obj => [obj.id, obj]))
      .forEach((value, key, variable) => {
      if (!value.branch) {
        value.branch = variable.get(value.base)?.branch ?? '?';
  }});

  // PR of each commit (merge, tip): see commitinfo.js
  SetPullRequests(dataGit.PR);
  RegisterCommits([...dataGit.commits, ...dataGit.PR, ...dataGit.branches, ...dataGit.users], dataGit.PR);
  metrics[0] = new Metrics(availableTypes, dataGit.commits);
  metrics[1] = new Metrics(availableTypes, dataGit.PR);
  metrics[2] = new Metrics(availableTypes, dataGit.branches);
  metrics[3] = new Metrics(availableTypes, dataGit.users);

  tabRenderers = [];
  tabRendered = [];
  tabRenderers[0] = () => dataGit.commits.forEach(element => {
      // main line commits, no base to compare to
      RenderCommit(config, project, availableTypes, element, metrics, ui.commitsDiv[0], null);
  });
  graphs.metrics.push(new GraphMetrics(metrics[0]));
  graphs.overview.push(new GraphOverview(config, project, metrics[0]));

  tabRenderers[1] = () => dataGit.PR.forEach(element => {
      RenderCommit(config, project, availableTypes, element, metrics, ui.commitsDiv[1], metrics[1]);
  });
  graphs.metrics.push(new GraphMetrics(metrics[1]));
  graphs.overview.push(new GraphOverview(config, project, metrics[1]));
  ui.refreshInfos[1]["infos"] = dataGit.PR_API_Infos;

  tabRenderers[2] = () => dataGit.branches.forEach(element => {
      RenderCommit(config, project, availableTypes, element, metrics, ui.commitsDiv[2], metrics[2]);
  });
  graphs.metrics.push(new GraphMetrics(metrics[2]));
  graphs.overview.push(new GraphOverview(config, project, metrics[2]));

  tabRenderers[3] = () => dataGit.users.forEach(element => {
      RenderCommit(config, project, availableTypes, element, metrics, ui.commitsDiv[3], metrics[3]);
  });
  graphs.metrics.push(new GraphMetrics(metrics[3]));
  graphs.overview.push(new GraphOverview(config, project, metrics[3]));

  campaigns = [];
  tabRenderers[4] = () => {
    [dataGit.commits, dataGit.PR, dataGit.users].forEach(dataSrc => {
        dataSrc.forEach(commit => {
            let campaignList = commit?.infos?.get('Campaign');
            if (!campaignList ) {
              return;
            }
            RenderCampaigns(config, project, commit, metrics, ui.commitsDiv[4]);
            campaigns.push(...campaignList.map(info => ({commitID: info.commit_id, user: info.user, campaignID: info.campaign_id})));
        });
    });
    SetupCombobox('search-commit-campaign', 'dl-commit-campaign', [...new Set(campaigns.map(c => c.commitID))]);
    SetupCombobox('search-user-campaign', 'dl-user-campaign', [...new Set(campaigns.map(c => c.user))]);
    SetupCombobox('search-campaign-campaign', 'dl-campaign-campaign', [...new Set(campaigns.map(c => c.campaignID))]);
  };

  if (tabIndex == -1) {
    ChangeTab(0);
  } else {
    RenderTab(tabIndex);
    ApplyFilters();
    ui.commitsDiv[tabIndex].classList.remove('hidden');
  }

  divFilters.classList.remove('hidden');
  divHeader.classList.remove('hidden');

  divLoading.classList.add('hidden');

  EnableUI();
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

  // "All" and "📊 results" are exclusive; the colored dots can be combined (none left: back to "📊 results")
  const filterButtons = [...document.querySelectorAll('.filter-btn')];
  const ShowStatusFilter = () => filterButtons.forEach(b => b.classList.toggle('active',
      (b.dataset.filter === statusFilter.mode) ||
      ((statusFilter.mode === 'status') && statusFilter.statuses.has(b.dataset.filter))));
  filterButtons.forEach(btn => {
      btn.addEventListener('click', () => {
          const filter = btn.dataset.filter;
          if ((filter === 'all') || (filter === 'with-results')) {
            statusFilter = { mode: filter, statuses: new Set() };
          } else {
            const statuses = statusFilter.mode === 'status' ? statusFilter.statuses : new Set();
            statuses.has(filter) ? statuses.delete(filter) : statuses.add(filter);
            statusFilter = statuses.size ? { mode: 'status', statuses } : { mode: 'with-results', statuses };
          }
          ShowStatusFilter();
          ApplyFilters();
      });
  });
  ShowStatusFilter();

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
  for(let i=0; i<ui.tabListsDiv.length; ++i) {
    ui.tabListsDiv[i].onclick = ClickTab;
  }

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
  ];
  for(let i=0; i<ui.commitsDiv.length; ++i) {
    ui.commitsDiv[i].classList.add('hidden');
    ui.commitsDiv[i].dataset.index = i;
  }

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

  window.ShowDetails = ShowDetails.bind(null, config);
  window.DownloadResults = DownloadResults.bind(null, config);
  window.addEventListener('pb-refresh', (event) => { event.preventDefault(); window.BtnRefreshData(); });
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

  if (window.location.hash) {
    ScrollToTarget();
  } else if (tabIndex != initialTab) {
    ChangeTab(initialTab);
  }

  window.onhashchange = ScrollToTarget;
}

Main();

// Esc (top bar, board/nav.js): fold the unfolded 🐞 panels
window.addEventListener('pb-escape', (event) => {
  if ((event.detail?.layer !== 'panel') || event.defaultPrevented) return;
  const open = document.querySelectorAll('tr.lib-panel-row:not([hidden])');
  if (!open.length) return;
  event.preventDefault();
  open.forEach(row => { row.hidden = true; });
});
