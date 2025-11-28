import './plotly-3.3.0.min.js'
const Plotly = window.Plotly;
import { ErrorManager } from "./error.js";
import { ApiREST } from "./apirest.js";
import { UI } from './ui.js'
import { GraphManager } from './graphmanager.js';

const config = {
  apiBase: '/api/PR',
};

const state = {
  type: '',
  commit: '',
  subject: '',
  commits: [],
  subjects: [],
  metrics: [],
  title: 'No Title',
  graphSettings: new Map(),
  linkedCommits: new Set(),
};

function SetBaseInformations(newState) {
  Object.assign(state, newState);
  header.innerText = `${state.type} (${state.commit}) : ${state.title}`;
  UI.EnableElement(mainUI);
  console.log(state);
}

function ConfigBaseInformations(oldState) {
  const currentState = oldState ?? {
    type: '',
    commit: '',
    subject: '',
    commits: [],
    subjects: [],
    metrics: [],
  };
  currentState.metrics = [];

  const modalpage = document.getElementById('modalpage');
  modalpage.innerHTML = '';

  const elements = [];

  const container = document.createElement('div');
  
  ui.Reset();

  container.appendChild(ui.CreateTitle("1. Select XP type", 'h3'));
  const selectType = ui.CreateSelect([
    { value:'', text: 'Select XP...' }, 
    { value:'Perf', selected: currentState.type == 'Perf' }, 
    { value:'Vuln', selected: currentState.type == 'Vuln' },
  ]);
  container.appendChild(selectType);
  elements.push(selectType);

  container.appendChild(ui.CreateTitle("2. Select commit", 'h3'));
  const selectCommit = ui.CreateSelect(
    [ { value:'', text:'Select commit...' } ]
        .concat((currentState?.commits ?? []).map(function(commit) {
            return { value: commit, selected: commit == currentState?.commit };
        })
    )
  );
  if (currentState.commits.length == 0) {
    UI.DisableElement(selectCommit);
  }
  container.appendChild(selectCommit);
  elements.push(selectCommit);

  container.appendChild(ui.CreateTitle("3. Select subject", 'h3'));
  const selectSubject = ui.CreateSelect(
    [ { value:'', text:'Select subject...' } ]
        .concat((currentState?.subjects ?? []).map(function(subject) {
            return { value: subject.value, text: subject.text, selected: subject.value == currentState?.subject };
        })
    )
  );
  if (currentState.subjects.length == 0) {
    UI.DisableElement(selectSubject);
  }
  container.appendChild(selectSubject);
  elements.push(selectSubject);

  const actions = ui.CreateActions(false, {
    ok: {
      callback: function(event) {
        apirest.LoadCommitMetrics(currentState.type, currentState.commit, currentState.subject).then(function(metrics) { 
            currentState.metrics = metrics;
            modalpage.style.visibility = 'collapse';
            SetBaseInformations(currentState);
        });
      }
    }
  });
  UI.DisableElement(actions);
  container.appendChild(actions);
  elements.push(actions);


  selectType.onchange = function(event) {
    if (event.target.value == currentState.type) {
      return;
    }
    currentState.type = '';
    currentState.commit = '';
    currentState.subject = '';
    currentState.commits = [];
    currentState.subjects = [];
    if (event.target.value == '') {
      UI.EnableElement(selectType);
      UI.DisableElement(selectCommit);
      UI.DisableElement(selectSubject);
      UI.DisableElement(actions);
      return;
    }
    elements.forEach(function(element) {
      UI.DisableElement(element);
    });
    apirest.LoadCommits(event.target.value).then(function(commits) {
      UI.EnableElement(selectType);
      currentState.type = event.target.value;
      currentState.commits = commits;
      if (commits.length == 0) {
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
    if (event.target.value == currentState.commit) {
      return;
    }
    currentState.commit = '';
    currentState.subject = '';
    currentState.subjects = [];
    if (event.target.value == '') {
      UI.EnableElement(selectType);
      UI.EnableElement(selectCommit);
      UI.DisableElement(selectSubject);
      UI.DisableElement(actions);
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
      if (subjects.length == 0) {
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
    if (event.target.value == currentState.subject) {
      return;
    }
    currentState.subject = event.target.value;
    if (currentState.subject == '') {
      UI.DisableElement(actions);
    } else {
      UI.EnableElement(actions);
    }
  };

  modalpage.appendChild(container);
  modalpage.style.visibility = 'visible';
}

function AddGrahique(currentState) {
  const selectedMetrics = [];
  const modalpage = document.getElementById('modalpage');
  modalpage.innerHTML = '';

  const container = document.createElement('div');
  
  ui.Reset();

  container.appendChild(ui.CreateTitle("Set time span (μs)", 'h3'));
  const time = ui.CreateTimeSelection(
      0, currentState.metrics.maxTimeMicroS, Math.floor(currentState.metrics.maxTimeMicroS / 20_000));
  container.appendChild(time);

  container.appendChild(ui.CreateTitle("Select metric(s)", 'h3'));
  const metricsUI = ui.CreateMetrics(currentState.metrics, {
    callback: function(event) {
      let anyChecked = true;
      if (event.target.checked) {
        selectedMetrics.push(event.target.value);
      } else {
        const elementToRemove = function(element) { return element == event.target.value };
        selectedMetrics.splice(selectedMetrics.findIndex(elementToRemove), 1);
        anyChecked = metricsUI.querySelector('.metric-checkbox:checked');
      }
      if (anyChecked) {
        UI.EnableElement(btOk);
      } else {
        UI.DisableElement(btOk);
      }
    }
  });
  container.appendChild(metricsUI);

  const btOkID = 'ui_' + ui.ID();
  const actions = ui.CreateActions(true, {
    ok: {
      callback: function(event) {
        if (selectedMetrics.length != 0) {
          const min = document.getElementById('time_start_1').value;
          const max = document.getElementById('time_end_1').value;
          const step = document.getElementById('time_step_1').value;
          apirest.LoadCommitMetricsValues(
              currentState.type, currentState.commit, currentState.subject, min, max, step, selectedMetrics)
          .then(function(data) {
            if (data == null) {
              modalpage.style.visibility = 'collapse';
              UI.EnableElement(mainUI);
              return;
            }
            const { header, series } = data;

            const graphSetting = { metrics: selectedMetrics, type: currentState.type, 
                commit: currentState.commit, subject: currentState.subject, min, max, step };
            graphManager.AddGraph(graphSetting, header, series).then(function(id) {
                currentState.graphSettings.set(id, graphSetting);
                modalpage.style.visibility = 'collapse';
                UI.EnableElement(mainUI);
            });
          });
          return;
        }
        modalpage.style.visibility = 'collapse';
        UI.EnableElement(mainUI);
      }
    },
    cancel: {
      callback: function(event) {
        modalpage.style.visibility = 'collapse';
        UI.EnableElement(mainUI);
      }
    }
  });
  container.appendChild(actions);

  modalpage.appendChild(container);
  const btOk = document.getElementById(btOkID);
  UI.DisableElement(btOk);
  modalpage.style.visibility = 'visible';
}

function LinkCommits(currentState) {
  const selectedCommits = currentState.linkedCommits;
  const modalpage = document.getElementById('modalpage');
  modalpage.innerHTML = '';

  const container = document.createElement('div');

  ui.Reset();

  container.appendChild(ui.CreateTitle("Select commit(s)", 'h3'));

  const commitsSet = new Set(currentState.commits).difference(new Set(currentState.commit));
  const commitsUI = ui.CreateCommits(Array.from(commitsSet), currentState.linkedCommits, {
    callback: function(event) {
      if (event.target.checked) {
        selectedCommits.add(event.target.value);
      } else {
        selectedCommits.delete(event.target.value);
      }
    }
  });
  container.appendChild(commitsUI);

  const actions = ui.CreateActions(true, {
    ok: {
      callback: function(event) {
        currentState.linkedCommits = selectedCommits;
        graphManager.LinkCommits(selectedCommits);
        modalpage.style.visibility = 'collapse';
        UI.EnableElement(mainUI);
      }
    },
    cancel: {
      callback: function(event) {
        modalpage.style.visibility = 'collapse';
        UI.EnableElement(mainUI);
      }
    }
  });
  container.appendChild(actions);

  modalpage.appendChild(container);
  modalpage.style.visibility = 'visible';
}

const header = document.getElementById('header');
const main = document.getElementById('main');

const errorManager = new ErrorManager();
const apirest = new ApiREST(config.apiBase, errorManager);
const ui = new UI();
const graphManager = new GraphManager(main, apirest);

const mainUI = document.createElement('div');
mainUI.id = 'ui_icons';
const uiAddGraph = document.createElement('span');
uiAddGraph.className = 'ui_icons';
uiAddGraph.innerText = '➕';
uiAddGraph.onclick = function(event) {
  UI.DisableElement(mainUI);
  AddGrahique(state);
}
mainUI.appendChild(uiAddGraph);
const uiManageCommits = document.createElement('span');
uiManageCommits.className = 'ui_icons';
uiManageCommits.innerText = '📌';
uiManageCommits.onclick = function(event) {
  UI.DisableElement(mainUI);
  LinkCommits(state);
}
mainUI.appendChild(uiManageCommits);
const uiSaveView = document.createElement('span');
uiSaveView.className = 'ui_icons';
uiSaveView.innerText = '💾';
uiSaveView.onclick = function(event) {
  UI.DisableElement(mainUI);
}
mainUI.appendChild(uiSaveView);
UI.DisableElement(mainUI);
main.appendChild(mainUI);

ConfigBaseInformations();

console.log('done');