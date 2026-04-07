import './plotly-3.3.0.min.js'
const Plotly = window.Plotly;
import { ErrorManager } from "./error.js";
import { ApiREST } from "./apirest.js";
import { UI } from './ui.js'
import { GraphManager } from './graphmanager.js';

const config = {
  apiBase: '/api/PR',
};

let currentModalCancelFn = null;
function setModalCancel(fn) { currentModalCancelFn = fn; }
function clearModalCancel() { currentModalCancelFn = null; }

const state = {
  type: '',
  commit: '',
  subject: '',
  commits: [],
  subjects: [],
  metrics: [],
  title: 'No Title_' + Date.now(),
  graphSettings: new Map(),
};

async function ResetState(state, newState) {
  graphManager.DelAllGraph();

  state.type = newState?.type ?? '';
  state.commit = newState?.commit ?? '';
  state.subject = newState?.subject ?? '';
  state.commits = newState?.commits ?? [];
  state.subjects = newState?.subjects ?? [];
  state.metrics = newState?.metrics ?? [];
  state.title = newState?.title ?? 'No Title_' + Date.now();
  state.graphSettings = newState?.graphSettings ?? new Map();

  const graphSettings = new Map();
  for (const [_, config] of state.graphSettings) {
    if (config.mode === 'compare') {
      const results = await Promise.all(
        config.compareCommits.map(c => apirest.LoadCommitMetricsValues(
          config.type, c, config.subject, config.min, config.max, config.step, config.metrics
        ))
      );
      const commitsData = new Map(
        config.compareCommits
          .map((c, i) => [c, results[i]])
          .filter(([_, d]) => d != null)
      );
      if (commitsData.size === 0) continue;
      const validCommits = config.compareCommits.filter((_, i) => results[i] != null);
      const validConfig = { ...config, compareCommits: validCommits };
      const id = await graphManager.AddCompareGraph(validConfig, commitsData);
      graphSettings.set(id, validConfig);
    } else {
      const data = await apirest.LoadCommitMetricsValues(
        config.type, config.commit, config.subject, config.min, config.max, config.step, config.metrics);
      if (data == null) continue;
      const { header, series } = data;
      const id = await graphManager.AddGraph(config, header, series);
      graphSettings.set(id, config);
    }
  }
  state.graphSettings = graphSettings;

  UpdateHeader();
}

function SetBaseInformations(state, newState) {
  Object.assign(state, newState);
  UpdateHeader();
  EnableMainUI(true);
}

function ConfigBaseInformations() {
  const currentState = { type: '', commit: '', subject: '', commits: [], subjects: [], metrics: [], title: state.title, graphSettings: new Map() };

  const modalpage = document.getElementById('modalpage');
  modalpage.innerHTML = '';

  const elements = [];

  const container = document.createElement('div');

  ui.Reset();

  container.appendChild(ui.CreateTitle("1. Select XP type", 'h3'));
  const selectType = ui.CreateSelect([
    { value:'', text: 'Select XP...' },
    { value:'Perf', selected: currentState.type === 'Perf' },
    { value:'Vuln', selected: currentState.type === 'Vuln' },
  ]);
  container.appendChild(selectType);
  elements.push(selectType);

  container.appendChild(ui.CreateTitle("2. Select commit", 'h3'));
  const selectCommit = ui.CreateSelect(
    [ { value:'', text:'Select commit...' } ]
        .concat((currentState?.commits ?? []).map(function(commit) {
            return { value: commit, selected: commit === currentState?.commit };
        })
    )
  );
  if (currentState.commits.length === 0) {
    UI.DisableElement(selectCommit);
  }
  container.appendChild(selectCommit);
  elements.push(selectCommit);

  container.appendChild(ui.CreateTitle("3. Select subject", 'h3'));
  const selectSubject = ui.CreateSelect(
    [ { value:'', text:'Select subject...' } ]
        .concat((currentState?.subjects ?? []).map(function(subject) {
            return { value: subject.value, text: subject.text, selected: subject.value === currentState?.subject };
        })
    )
  );
  if (currentState.subjects.length === 0) {
    UI.DisableElement(selectSubject);
  }
  container.appendChild(selectSubject);
  elements.push(selectSubject);

  container.appendChild(ui.CreateTitle("4. Dashboard title", 'h3'));
  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.className = 'modal_text_input';
  titleInput.value = currentState.title;
  titleInput.placeholder = 'Dashboard title…';
  container.appendChild(titleInput);

  setModalCancel(function() {
    modalpage.classList.remove('modalpage_visible');
    NewGraph();
  });

  const actions = ui.CreateActions(true, {
    ok: {
      callback: function(event) {
        apirest.LoadCommitMetrics(currentState.type, currentState.commit, currentState.subject).then(function(metrics) {
            currentState.metrics = metrics;
            currentState.title = titleInput.value.trim() || currentState.title;
            clearModalCancel();
            modalpage.classList.remove('modalpage_visible');
            ResetState(state, currentState).then(function() {
              EnableMainUI(true);
            });
        });
      },
      className: "ok_button"
    },
    cancel: {
      callback: function (event) {
        clearModalCancel();
        modalpage.classList.remove('modalpage_visible');
        NewGraph();
      }
    }
  });
  const ok_action = actions.getElementsByClassName("ok_button").item(0);
  UI.DisableElement(ok_action);
  container.appendChild(actions);
  elements.push(ok_action);


  selectType.onchange = function(event) {
    if (event.target.value === currentState.type) {
      return;
    }
    currentState.type = '';
    currentState.commit = '';
    currentState.subject = '';
    currentState.commits = [];
    currentState.subjects = [];
    if (event.target.value === '') {
      UI.EnableElement(selectType);
      UI.DisableElement(selectCommit);
      UI.DisableElement(selectSubject);
      UI.DisableElement(ok_action);
      return;
    }
    elements.forEach(function(element) {
      UI.DisableElement(element);
    });
    apirest.LoadCommits(event.target.value).then(function(commits) {
      UI.EnableElement(selectType);
      currentState.type = event.target.value;
      currentState.commits = commits;
      if (commits.length === 0) {
        return;
      }
      ui.UpdateSelect(selectCommit,
        [ { value:'', text:'Select commit...' } ].concat(
          commits.map(function(commit) {
            return { value: commit };
          })
        )
      );
      UI.EnableElement(selectCommit);
    });
  };

  selectCommit.onchange = function(event) {
    if (event.target.value === currentState.commit) {
      return;
    }
    currentState.commit = '';
    currentState.subject = '';
    currentState.subjects = [];
    if (event.target.value === '') {
      UI.EnableElement(selectType);
      UI.EnableElement(selectCommit);
      UI.DisableElement(selectSubject);
      UI.DisableElement(ok_action);
      return;
    }
    elements.forEach(function(element) {
      UI.DisableElement(element);
    });
    apirest.LoadCommitSubjects(currentState.type, event.target.value).then(function(subjects) {
      UI.EnableElement(selectType);
      UI.EnableElement(selectCommit);
      currentState.commit = event.target.value;
      currentState.subjects = subjects;
      if (subjects.length === 0) {
        return;
      }
      ui.UpdateSelect(selectSubject,
        [ { value:'', text:'Select subject...' } ].concat(
          subjects.map(function(subject) {
            return { value: subject.value, text: subject.text };
          })
        )
      );
      UI.EnableElement(selectSubject);
    });
  };
  selectSubject.onchange = function(event) {
    if (event.target.value === currentState.subject) {
      return;
    }
    currentState.subject = event.target.value;
    if (currentState.subject === '') {
      UI.DisableElement(ok_action);
    } else {
      UI.EnableElement(ok_action);
    }
  };

  modalpage.appendChild(container);
  modalpage.classList.add('modalpage_visible');
}

function AddGrahique(currentState) {
  let selectedCommits = [currentState.commit];
  let selectedMetrics = [];
  let metricsUIContainer = null;
  let btOk = null;

  const modalpage = document.getElementById('modalpage');
  modalpage.innerHTML = '';

  const container = document.createElement('div');
  ui.Reset();

  // 1. Commit selection
  container.appendChild(ui.CreateTitle("1. Select commit(s)", 'h3'));
  const commitsUI = ui.CreateCommits(currentState.commits, new Set(selectedCommits), {
    maxSelect: 4,
    callback: function(event) {
      if (event.target.checked) {
        selectedCommits.push(event.target.value);
      } else {
        const idx = selectedCommits.indexOf(event.target.value);
        if (idx >= 0) selectedCommits.splice(idx, 1);
      }
      rebuildMetricsUI();
    }
  });
  container.appendChild(commitsUI);

  // 2. Metrics (rebuilt dynamically when commit selection changes)
  container.appendChild(ui.CreateTitle("2. Select metric(s)", 'h3'));
  const metricsWrapper = document.createElement('div');
  container.appendChild(metricsWrapper);

  // 3. Time range
  container.appendChild(ui.CreateTitle("3. Time range (μs)", 'h3'));
  const timeID = ui.ID();
  const time = ui.CreateTimeSelection(
      0, currentState.metrics.maxTimeMicroS, Math.floor(currentState.metrics.maxTimeMicroS / 20_000));
  container.appendChild(time);

  setModalCancel(function() {
    clearModalCancel();
    modalpage.classList.remove('modalpage_visible');
    EnableMainUI(true);
  });

  // 4. Actions
  const btOkContainerID = 'ui_' + ui.ID();
  const actions = ui.CreateActions(true, {
    ok: {
      callback: async function(event) {
        if (selectedMetrics.length === 0 || selectedCommits.length === 0) return;

        const min = document.getElementById('time_start_' + timeID).value;
        const max = document.getElementById('time_end_' + timeID).value;
        const step = document.getElementById('time_step_' + timeID).value;

        if (selectedCommits.length >= 2) {
          // COMPARE mode: one merged graph
          const results = await Promise.all(
            selectedCommits.map(c => apirest.LoadCommitMetricsValues(
              currentState.type, c, currentState.subject, min, max, step, selectedMetrics
            ))
          );
          const commitsData = new Map(
            selectedCommits.map((c, i) => [c, results[i]]).filter(([_, d]) => d != null)
          );
          if (commitsData.size > 0) {
            const validCommits = selectedCommits.filter((_, i) => results[i] != null);
            const graphConfig = {
              mode: 'compare',
              compareCommits: validCommits,
              metrics: selectedMetrics,
              type: currentState.type,
              subject: currentState.subject,
              min, max, step,
              showRaw: false,
              splitAxes: true
            };
            const id = await graphManager.AddCompareGraph(graphConfig, commitsData);
            currentState.graphSettings.set(id, graphConfig);
          }
        } else {
          // NORMAL mode: single commit graph
          const theCommit = selectedCommits[0];
          const data = await apirest.LoadCommitMetricsValues(
            currentState.type, theCommit, currentState.subject, min, max, step, selectedMetrics);
          if (data != null) {
            const { header, series } = data;
            const graphSetting = {
              mode: 'normal',
              metrics: selectedMetrics,
              type: currentState.type,
              commit: theCommit,
              subject: currentState.subject,
              min, max, step,
              showRaw: true,
              showCI: true,
              splitAxes: true
            };
            const id = await graphManager.AddGraph(graphSetting, header, series);
            currentState.graphSettings.set(id, graphSetting);
          }
        }

        clearModalCancel();
        modalpage.classList.remove('modalpage_visible');
        EnableMainUI(true);
      }
    },
    cancel: {
      callback: function(event) {
        clearModalCancel();
        modalpage.classList.remove('modalpage_visible');
        EnableMainUI(true);
      }
    }
  });
  container.appendChild(actions);

  modalpage.appendChild(container);

  btOk = document.getElementById(btOkContainerID);
  UI.DisableElement(btOk);

  // Build initial metrics UI after btOk is set
  rebuildMetricsUI();

  modalpage.classList.add('modalpage_visible');

  function rebuildMetricsUI() {
    selectedMetrics = [];
    const isCompare = selectedCommits.length >= 2;
    if (metricsUIContainer) metricsUIContainer.remove();
    metricsUIContainer = ui.CreateMetrics(currentState.metrics, {
      maxSelect: isCompare ? 4 : Infinity,
      callback: function(event) {
        if (event.target.checked) {
          selectedMetrics.push(event.target.value);
        } else {
          const idx = selectedMetrics.indexOf(event.target.value);
          if (idx >= 0) selectedMetrics.splice(idx, 1);
        }
        updateOkButton();
      }
    });
    metricsWrapper.appendChild(metricsUIContainer);
    updateOkButton();
  }

  function updateOkButton() {
    if (!btOk) return;
    if (selectedMetrics.length > 0 && selectedCommits.length >= 1) {
      UI.EnableElement(btOk);
    } else {
      UI.DisableElement(btOk);
    }
  }
}

function NewGraph() {
  const modalpage = document.getElementById('modalpage');
  modalpage.innerHTML = '';

  const container = document.createElement('div');

  ui.Reset();
  container.appendChild(ui.CreateTitle("Create / Load graph", 'h3'));

  const listFiles = ui.CreateListFiles(null, {
    callback: function(event) {
      apirest.LoadPage(event.target.innerText).then(function(newstate) {
        ResetState(state, newstate).then(function() {
          modalpage.classList.remove('modalpage_visible');
          EnableMainUI(true);
        });
      });
    }
  });
  container.appendChild(listFiles);
  setModalCancel(function() {
    clearModalCancel();
    modalpage.classList.remove('modalpage_visible');
    if (state.commit === '') {
      UI.EnableElement(uiLoadView);
    } else {
      EnableMainUI(true);
    }
  });

  const btOkID = 'ui_' + ui.ID();
  container.appendChild(ui.CreateActions(true, {
    ok: {
      text: 'New',
      callback: function(event) {
        clearModalCancel();
        modalpage.classList.remove('modalpage_visible');
        ConfigBaseInformations();
      }
    },
    cancel: {
      callback: function(event) {
        clearModalCancel();
        modalpage.classList.remove('modalpage_visible');
        if (state.commit === '') {
          UI.EnableElement(uiLoadView);
        } else {
          EnableMainUI(true);
        }
      }
    }
  }));

  apirest.ListPages().then(function(answer) {
    ui.UpdateListFiles(listFiles, answer.files);
  });

  modalpage.appendChild(container);
  modalpage.classList.add('modalpage_visible');
}

function OpenInfoModal() {
  const modalpage = document.getElementById('modalpage');
  modalpage.innerHTML = '';

  const container = document.createElement('div');
  ui.Reset();

  container.appendChild(ui.CreateTitle('How to use this tool', 'h3'));

  const body = document.createElement('div');
  body.className = 'info-modal-body';
  body.innerHTML = `
    <p>This dashboard visualises performance and vulnerability test results as interactive time-series graphs. Follow the steps below to explore your data.</p>

    <h3>1 — Getting started (📋)</h3>
    <p>Click <strong>📋</strong> (bottom right) to open a saved view or start fresh.</p>
    <ul>
      <li><strong>New</strong> — opens the view creator to generate a new blank view.</li>
      <li><strong>File name</strong> — click a listed name to restore a saved view.</li>
    </ul>

    <h3>2 — View Creator</h3>
    <p>Select/Fill four values in order — each step unlocks the next:</p>
    <ol>
      <li><strong>XP Type</strong> — choose <em>Perf</em> (performance) or <em>Vuln</em> (vulnerability).</li>
      <li><strong>Commit</strong> — select the commit whose data will be based on (available metrics) and default commit to be selected.</li>
      <li><strong>Library</strong> — pick the library (benchmark name) for that commit.</li>
      <li><strong>View name</strong> — keep the default or fill in a specific name for this view</li>
    </ol>
    <p>Click <strong>OK</strong> to confirm. A new view with those parameters will be created</p>

    <h3>3 — Add a graph (➕)</h3>
    <p>Click <strong>➕</strong> to add a new graph panel. Three steps:</p>
    <ol>
      <li><strong>Commit(s)</strong> — select one commit for a standard graph, or 2–4 commits to compare them stacked.</li>
      <li><strong>Metric(s)</strong> — browse the metric tree (click <strong>➕</strong> to expand a folder). Unlimited metrics but be careful to the readability.</li>
      <li><strong>Time range</strong> — set Start, End, and Step in microseconds (µs). Smaller step = more detail, slower load.</li>
    </ol>

    <h3>4 — Graph controls</h3>
    <p>Each graph panel has a toolbar with these controls:</p>
    <ul>
      <li><strong>✖ Delete</strong> — remove the graph.</li>
      <li><strong>➖ / ➕ Minimize / Expand</strong> — hide or show the plot area.</li>
      <li><strong>📐 Split Y axes</strong> — give each metric its own Y-axis (useful for different scales).</li>
      <li><strong>📈 Raw traces</strong> — overlay individual run data.</li>
      <li><strong>🌫 Conf. Int.</strong> — show 95% confidence interval shading around means.</li>
    </ul>

    <h3>5 — Save and load (💾 / 📋)</h3>
    <ul>
      <li><strong>💾</strong> saves the entire dashboard (all graphs and settings) under the title shown in the header.</li>
      <li>The header title is the save file name, it can be updated if you want to create new views with the same view parameters but different graphs.</li>
      <li><strong>📋</strong> lists all saved views; click a name to restore it.</li>
    </ul>

    <h3>Tips</h3>
    <ul>
      <li>CI bands use a 95% t-distribution confidence interval (Bessel-corrected variance).</li>
      <li>Hover over any graph for a unified tooltip showing all metric values at that time point.</li>
    </ul>
  `;
  container.appendChild(body);

  const closeFn = function() {
    clearModalCancel();
    modalpage.classList.remove('modalpage_visible');
  };
  setModalCancel(closeFn);

  container.appendChild(ui.CreateActions(false, {
    ok: { text: 'Close', callback: closeFn }
  }));

  modalpage.appendChild(container);
  modalpage.classList.add('modalpage_visible');
}

function Save(state) {
  apirest.SavePage(state.title, state).then(function() {
      EnableMainUI(true);
  });
}

function EnableMainUI(state) {
  UIElt.forEach(function(element) {
    if (state) {
      UI.EnableElement(element);
    } else {
      UI.DisableElement(element);
    }
  });
}

const header = document.getElementById('header');
const main = document.getElementById('main');

const headerStatic = document.createElement('span');
const headerTitle = document.createElement('span');
headerTitle.contentEditable = 'true';
headerTitle.style.outline = 'none';
headerTitle.style.cursor = 'text';
headerTitle.onblur = function() { state.title = headerTitle.innerText.trim() || state.title; };
headerTitle.onkeydown = function(e) { if (e.key === 'Enter') { e.preventDefault(); headerTitle.blur(); } };
header.appendChild(headerStatic);
header.appendChild(headerTitle);

function UpdateHeader() {
  headerStatic.innerText = state.type ? `${state.type} (${state.commit}) : ` : '';
  headerTitle.innerText = state.title;
}

const errorManager = new ErrorManager();
const apirest = new ApiREST(config.apiBase, errorManager);
const ui = new UI();
const graphManager = new GraphManager(main, {
  delete: function(id) {
    state.graphSettings.delete(id);
  }
});

const UIElt = [];
const mainUI = document.createElement('div');
mainUI.id = 'ui_icons';

const uiAddGraph = document.createElement('span');
uiAddGraph.className = 'ui_icons';
uiAddGraph.innerText = '➕';
uiAddGraph.onclick = function(event) {
  EnableMainUI(false);
  AddGrahique(state);
}
UIElt.push(uiAddGraph);

const uiSaveView = document.createElement('span');
uiSaveView.className = 'ui_icons';
uiSaveView.innerText = '💾';
uiSaveView.onclick = function(event) {
  EnableMainUI(false);
  Save(state);
}
UIElt.push(uiSaveView);

UIElt.forEach(function(element) {
  UI.DisableElement(element);
});

const uiLoadView = document.createElement('span');
uiLoadView.className = 'ui_icons';
uiLoadView.innerText = '📋';
uiLoadView.onclick = function(event) {
  EnableMainUI(false);
  NewGraph();
}
UI.EnableElement(uiLoadView);
UIElt.push(uiLoadView);

UIElt.forEach(function(element) {
  mainUI.appendChild(element);
});

const uiInfo = document.createElement('span');
uiInfo.className = 'ui_icons';
uiInfo.innerText = 'ℹ';
uiInfo.title = 'Help';
uiInfo.onclick = OpenInfoModal;
mainUI.appendChild(uiInfo);

main.appendChild(mainUI);

const modalpage = document.getElementById('modalpage');

document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape' && currentModalCancelFn) {
    const fn = currentModalCancelFn;
    currentModalCancelFn = null;
    fn();
  }
});

modalpage.addEventListener('click', function(e) {
  if (e.target === modalpage && currentModalCancelFn) {
    const fn = currentModalCancelFn;
    currentModalCancelFn = null;
    fn();
  }
});

console.log('done');
