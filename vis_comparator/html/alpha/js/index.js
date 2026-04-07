import './plotly-3.3.0.min.js'
const Plotly = window.Plotly;
import { ErrorManager } from "./error.js";
import { ApiREST } from "./apirest.js";
import { UI } from './ui.js'
import { GraphManager } from './graphmanager.js';

// ============================================================
// CONFIGURATION
// ============================================================

const config = {
  apiBase: '/api/PR',
};

// ============================================================
// STATE
// ============================================================

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

// ============================================================
// STATE MANAGEMENT
// ============================================================

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

// ============================================================
// MODALS
// ============================================================

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

  container.appendChild(ui.CreateTitle("4. View name", 'h3'));
  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.className = 'modal_text_input';
  titleInput.placeholder = 'Auto-generated once subject is selected…';
  titleInput.disabled = true;
  let titleWasEdited = false;
  titleInput.addEventListener('input', function() { titleWasEdited = true; });
  container.appendChild(titleInput);

  setModalCancel(function() {
    modalpage.classList.remove('modalpage_visible');
    NewGraph();
  });

  const actions = ui.CreateActions(true, {
    ok: {
      callback: async function(event) {
        let title = titleInput.value.trim() || (`${currentState.type} \u2013 ${currentState.subject} (${currentState.commit.slice(0, 8)})`);

        // Check for duplicate names and auto-increment if needed
        const pages = await apirest.ListPages();
        if (pages?.files) {
          const existingNames = new Set(pages.files);
          if (existingNames.has(title)) {
            const baseTitle = title;
            let counter = 2;
            let candidate;
            do {
              candidate = `${baseTitle} (${counter++})`;
            } while (existingNames.has(candidate));
            title = candidate;
            titleInput.value = title;
          }
        }

        currentState.metrics = await apirest.LoadCommitMetrics(currentState.type, currentState.commit, currentState.subject);
        currentState.title = title;
        clearModalCancel();
        modalpage.classList.remove('modalpage_visible');
        await ResetState(state, currentState);
        EnableMainUI(true);
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
    titleWasEdited = false;
    titleInput.disabled = true;
    titleInput.value = '';
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
    titleWasEdited = false;
    titleInput.disabled = true;
    titleInput.value = '';
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
      titleInput.disabled = true;
      UI.DisableElement(ok_action);
    } else {
      titleInput.disabled = false;
      if (!titleWasEdited) {
        const shortHash = currentState.commit.slice(0, 8);
        titleInput.value = `${currentState.type} \u2013 ${currentState.subject} (${shortHash})`;
      }
      UI.EnableElement(ok_action);
    }
  };

  modalpage.appendChild(container);
  modalpage.classList.add('modalpage_visible');
}

const DEFAULT_STEP_DIVISOR = 20_000;

function AddGraphique(currentState) {
  let selectedSubject = currentState.subject;
  let currentMetrics = currentState.metrics;
  let selectedCommits = [currentState.commit];
  let selectedMetrics = [];
  let metricsUIContainer = null;
  let btOk = null;

  const modalpage = document.getElementById('modalpage');
  modalpage.innerHTML = '';

  const container = document.createElement('div');
  ui.Reset();

  // 1. PUT selection
  container.appendChild(ui.CreateTitle("1. Select PUT", 'h3'));
  const selectSubject = ui.CreateSelect(
    (currentState.subjects ?? []).map(function(s) {
      return { value: s.value, text: s.text, selected: s.value === currentState.subject };
    })
  );
  container.appendChild(selectSubject);

  // 2. Commit selection
  container.appendChild(ui.CreateTitle("2. Select commit(s)", 'h3'));
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

  // 3. Metrics (rebuilt dynamically when commit or PUT selection changes)
  container.appendChild(ui.CreateTitle("3. Select metric(s)", 'h3'));
  const metricsWrapper = document.createElement('div');
  container.appendChild(metricsWrapper);

  // 4. Time range
  container.appendChild(ui.CreateTitle("4. Time range (\u03bcs)", 'h3'));
  const timeID = ui.ID();
  const time = ui.CreateTimeSelection(
      0, currentState.metrics.maxTimeMicroS, Math.floor(currentState.metrics.maxTimeMicroS / DEFAULT_STEP_DIVISOR));
  container.appendChild(time);

  setModalCancel(function() {
    clearModalCancel();
    modalpage.classList.remove('modalpage_visible');
    EnableMainUI(true);
  });

  // 5. Actions
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
              currentState.type, c, selectedSubject, min, max, step, selectedMetrics
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
              subject: selectedSubject,
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
            currentState.type, theCommit, selectedSubject, min, max, step, selectedMetrics);
          if (data != null) {
            const { header, series } = data;
            const graphSetting = {
              mode: 'normal',
              metrics: selectedMetrics,
              type: currentState.type,
              commit: theCommit,
              subject: selectedSubject,
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

  // PUT change: reload metrics for the new subject
  selectSubject.onchange = async function(event) {
    const newSubject = event.target.value;
    if (newSubject === selectedSubject || newSubject === '') return;
    selectedSubject = newSubject;
    UI.DisableElement(selectSubject);
    const commit = selectedCommits[0] ?? currentState.commit;
    const newMetrics = await apirest.LoadCommitMetrics(currentState.type, commit, newSubject);
    UI.EnableElement(selectSubject);
    if (newMetrics && newMetrics.metrics) {
      currentMetrics = newMetrics;
      const startInput = document.getElementById('time_start_' + timeID);
      const endInput = document.getElementById('time_end_' + timeID);
      const stepInput = document.getElementById('time_step_' + timeID);
      if (startInput) startInput.value = 0;
      if (endInput) endInput.value = newMetrics.maxTimeMicroS;
      if (stepInput) stepInput.value = Math.floor(newMetrics.maxTimeMicroS / DEFAULT_STEP_DIVISOR);
      rebuildMetricsUI();
    }
  };

  function rebuildMetricsUI() {
    selectedMetrics = [];
    const isCompare = selectedCommits.length >= 2;
    if (metricsUIContainer) metricsUIContainer.remove();
    metricsUIContainer = ui.CreateMetrics(currentMetrics, {
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
  container.appendChild(ui.CreateTitle("Create / Load view", 'h3'));

  // Sort + filter controls
  const viewControls = document.createElement('div');
  viewControls.className = 'view-controls';

  const filterInput = document.createElement('input');
  filterInput.type = 'text';
  filterInput.className = 'modal_text_input view-filter-input';
  filterInput.placeholder = 'Filter views\u2026';
  viewControls.appendChild(filterInput);

  const sortBtn = document.createElement('button');
  sortBtn.className = 'view-sort-btn';
  sortBtn.textContent = 'A \u2192 Z';
  sortBtn.title = 'Toggle sort order';
  let sortAsc = true;
  viewControls.appendChild(sortBtn);
  container.appendChild(viewControls);

  // View list
  const listContainer = document.createElement('div');
  listContainer.className = 'view-list-container';
  const loadingSpan = document.createElement('span');
  loadingSpan.className = 'modal_wait';
  loadingSpan.textContent = '\u{1F550}';
  listContainer.appendChild(loadingSpan);
  container.appendChild(listContainer);

  let allFiles = [];

  function renderList() {
    listContainer.innerHTML = '';
    const filterText = filterInput.value.toLowerCase();
    let files = allFiles.filter(f => f.toLowerCase().includes(filterText));
    files = [...files].sort((a, b) => sortAsc ? a.localeCompare(b) : b.localeCompare(a));

    if (files.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'view-list-empty';
      empty.textContent = filterText ? 'No views match your filter.' : 'No saved views yet.';
      listContainer.appendChild(empty);
      return;
    }

    files.forEach(function(name) {
      const row = document.createElement('div');
      row.className = 'view-list-row';

      const nameBtn = document.createElement('button');
      nameBtn.className = 'view-list-name-btn';
      nameBtn.textContent = name;
      nameBtn.onclick = function() {
        apirest.LoadPage(name).then(function(newstate) {
          if (newstate == null) return;
          ResetState(state, newstate).then(function() {
            modalpage.classList.remove('modalpage_visible');
            clearModalCancel();
            EnableMainUI(true);
            errorManager.Success('View loaded: ' + name);
          });
        });
      };

      const delBtn = document.createElement('button');
      delBtn.className = 'view-list-delete-btn';
      delBtn.textContent = '\u{1F5D1}';
      delBtn.title = 'Delete this view';
      delBtn.onclick = function(e) {
        e.stopPropagation();
        if (!confirm(`Delete view \u201c${name}\u201d? This cannot be undone.`)) return;
        apirest.DeletePage(name).then(function(ok) {
          if (ok) {
            allFiles = allFiles.filter(f => f !== name);
            renderList();
            errorManager.Success('View deleted: ' + name);
          }
        });
      };

      row.appendChild(nameBtn);
      row.appendChild(delBtn);
      listContainer.appendChild(row);
    });
  }

  filterInput.oninput = renderList;
  sortBtn.onclick = function() {
    sortAsc = !sortAsc;
    sortBtn.textContent = sortAsc ? 'A \u2192 Z' : 'Z \u2192 A';
    renderList();
  };

  setModalCancel(function() {
    clearModalCancel();
    modalpage.classList.remove('modalpage_visible');
    if (state.commit !== '') EnableMainUI(true);
  });

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
        if (state.commit !== '') EnableMainUI(true);
      }
    }
  }));

  apirest.ListPages().then(function(answer) {
    if (answer?.files) {
      allFiles = answer.files;
      renderList();
    } else {
      listContainer.innerHTML = '';
      const p = document.createElement('p');
      p.className = 'view-list-empty';
      p.textContent = 'Failed to load views.';
      listContainer.appendChild(p);
    }
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

    <h3>1 — Getting started</h3>
    <p>Use the toolbar in the top-right header to manage views:</p>
    <ul>
      <li><strong>Ouvrir vue</strong> — open a saved view or start fresh (click <strong>New</strong> inside the dialog).</li>
      <li><strong>Nouvelle vue</strong> — jump directly to the view creator for a blank dashboard.</li>
    </ul>

    <h3>2 — View Creator</h3>
    <p>Select/fill four values in order — each step unlocks the next:</p>
    <ol>
      <li><strong>XP Type</strong> — choose <em>Perf</em> (performance) or <em>Vuln</em> (vulnerability).</li>
      <li><strong>Commit</strong> — select the commit to base available metrics and the default selection on.</li>
      <li><strong>Library (PUT)</strong> — pick the programme under test (benchmark name) for that commit.</li>
      <li><strong>View name</strong> — auto-generated from your selections; edit for a custom name.</li>
    </ol>
    <p>Click <strong>OK</strong> to confirm. A new view with those parameters will be created.</p>

    <h3>3 — Add a graph (+ Graphe)</h3>
    <p>Click <strong>+ Graphe</strong> in the toolbar to add a new graph panel. Four steps:</p>
    <ol>
      <li><strong>PUT</strong> — pre-selected from the global config; change to graph a different library.</li>
      <li><strong>Commit(s)</strong> — select one commit for a standard graph, or 2–4 commits to compare.</li>
      <li><strong>Metric(s)</strong> — browse the metric tree (click <strong>➕</strong> to expand a folder).</li>
      <li><strong>Time range</strong> — set Start, End, and Step in microseconds (µs). Smaller step = more detail, slower load.</li>
    </ol>

    <h3>4 — Graph controls</h3>
    <p>Each graph panel has controls in its title bar and a toggle row below:</p>
    <ul>
      <li><strong>✖</strong> (red) — delete the graph.</li>
      <li><strong>➖ / ➕</strong> — minimize or expand the plot area.</li>
      <li><strong>Split Y-Axes</strong> — give each metric its own Y-axis (useful for different scales).</li>
      <li><strong>All Runs</strong> — overlay individual run data as dotted lines.</li>
      <li><strong>Confidence Bands</strong> — show 95% confidence interval shading around means.</li>
    </ul>

    <h3>5 — Save and load</h3>
    <ul>
      <li><strong>Sauvegarder</strong> — saves the entire dashboard (all graphs and settings) under the title shown in the header.</li>
      <li>Click <strong>✏ Edit</strong> next to the title to rename before saving.</li>
      <li><strong>Ouvrir vue</strong> — lists all saved views; search, sort, load, or delete them.</li>
    </ul>

    <h3>Tips</h3>
    <ul>
      <li>CI bands use a 95% t-distribution confidence interval (Bessel-corrected variance).</li>
      <li>Hover over any graph for a unified tooltip showing all metric values at that time point.</li>
      <li>Hidden legend items are preserved when you toggle All Runs / Confidence Bands / Split Y-Axes.</li>
    </ul>

    <hr style="margin: 28px 0; border: none; border-top: 2px solid #e0e0e0;">

    <h3>Plain-language guide</h3>

    <h4 style="margin-top:16px; color:#555;">Starting from scratch</h4>
    <p>Click <strong>Ouvrir vue</strong> (top-right toolbar) to open a saved view, or <strong>Nouvelle vue</strong> to start a blank dashboard. The view ties together a test type, a code commit, and a benchmark library (PUT).</p>

    <h4 style="margin-top:16px; color:#555;">Setting up a view</h4>
    <p>Fill the four fields in order — each one unlocks the next. The name auto-fills once you pick a subject; change it if you want something more memorable.</p>

    <h4 style="margin-top:16px; color:#555;">Adding a graph</h4>
    <p>Click <strong>+ Graphe</strong>, choose the PUT, pick one or more commits, select your metrics, and set a time window. Two or more commits produces a comparison chart.</p>

    <h4 style="margin-top:16px; color:#555;">What the toggle buttons actually show you</h4>
    <ul>
      <li><strong>All Runs</strong> — shows every individual benchmark run as a faint dotted line. Wide spread = inconsistent results.</li>
      <li><strong>Confidence Bands</strong> — adds a shaded area around each mean. The wider the band, the less certain the result (95% CI).</li>
      <li><strong>Split Y-Axes</strong> — gives each metric its own vertical scale. Useful when comparing metrics with very different units or magnitudes.</li>
    </ul>
    <p>Clicking a trace name in the legend hides/shows it. That hidden state is preserved when you toggle the buttons above.</p>

    <h4 style="margin-top:16px; color:#555;">Saving and loading</h4>
    <p>Click <strong>Sauvegarder</strong> to save your dashboard. Click <strong>✏ Edit</strong> in the header to rename it first. Use <strong>Ouvrir vue</strong> to manage saved views: search, sort, load, or delete.</p>
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

// ============================================================
// SAVE / LOAD
// ============================================================

const TITLE_MAX_LENGTH = 100;
const TITLE_VALID_RE = /^[\S ]+$/;

function ValidateTitle(title) {
  if (!title || title.length === 0) return 'View name cannot be empty.';
  if (title.length > TITLE_MAX_LENGTH) return `View name must be at most ${TITLE_MAX_LENGTH} characters.`;
  if (!TITLE_VALID_RE.test(title)) return 'View name can only contain any printable characters and spaces';
  return null;
}

function Save(state) {
  const err = ValidateTitle(state.title);
  if (err) {
    errorManager.Error(err);
    EnableMainUI(true);
    return;
  }
  apirest.SavePage(state.title, state).then(function(ok) {
    if (ok) {
      errorManager.Success('View saved: ' + state.title);
    }
    EnableMainUI(true);
  });
}

// ============================================================
// HEADER & DOM SETUP
// ============================================================

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

// Header: config icon (with hover tooltip) + read-only title + edit button
const headerConfigIcon = document.createElement('span');
headerConfigIcon.className = 'header-config-icon';
headerConfigIcon.textContent = '\u2699\uFE0F';
headerConfigIcon.style.display = 'none';

const headerConfigTooltip = document.createElement('div');
headerConfigTooltip.className = 'header-config-tooltip';
headerConfigIcon.appendChild(headerConfigTooltip);

const headerTitle = document.createElement('span');
headerTitle.className = 'header-title-text';

const headerEditBtn = document.createElement('button');
headerEditBtn.className = 'header-edit-btn';
headerEditBtn.textContent = '\u270F Edit';
headerEditBtn.title = 'Rename this view';
headerEditBtn.style.display = 'none';
let headerEditInput = null;

headerEditBtn.onclick = function() {
  if (headerEditBtn.dataset.editing === 'true') {
    // Commit the edit
    const newTitle = headerEditInput.value.trim() || state.title;
    state.title = newTitle;
    headerTitle.textContent = newTitle;
    headerTitle.style.display = '';
    headerEditInput.remove();
    headerEditInput = null;
    headerEditBtn.textContent = '\u270F Edit';
    headerEditBtn.dataset.editing = 'false';
  } else {
    // Start editing
    headerEditInput = document.createElement('input');
    headerEditInput.type = 'text';
    headerEditInput.className = 'header-edit-input';
    headerEditInput.value = state.title;
    headerEditInput.onkeydown = function(e) {
      if (e.key === 'Enter') { headerEditBtn.onclick(); }
      if (e.key === 'Escape') {
        headerTitle.style.display = '';
        headerEditInput.remove();
        headerEditInput = null;
        headerEditBtn.textContent = '\u270F Edit';
        headerEditBtn.dataset.editing = 'false';
      }
    };
    headerTitle.style.display = 'none';
    headerTitle.insertAdjacentElement('afterend', headerEditInput);
    headerEditInput.focus();
    headerEditInput.select();
    headerEditBtn.textContent = '\u2714 Done';
    headerEditBtn.dataset.editing = 'true';
  }
};

const headerLeft = document.createElement('div');
headerLeft.className = 'header-left';
headerLeft.appendChild(headerConfigIcon);
headerLeft.appendChild(headerTitle);
headerLeft.appendChild(headerEditBtn);
header.appendChild(headerLeft);

const headerToolbar = document.createElement('div');
headerToolbar.className = 'header-toolbar';
header.appendChild(headerToolbar);

function UpdateHeader() {
  if (state.type) {
    const shortCommit = state.commit.length > 16 ? state.commit.slice(0, 16) + '\u2026' : state.commit;
    headerConfigTooltip.replaceChildren(
      ...['Type', 'Commit', 'Subject'].map(function(label, i) {
        const values = [state.type, shortCommit, state.subject];
        const b = document.createElement('b');
        b.textContent = label + ':';
        const frag = document.createDocumentFragment();
        frag.appendChild(b);
        frag.appendChild(document.createTextNode(' ' + values[i]));
        if (i < 2) frag.appendChild(document.createElement('br'));
        return frag;
      })
    );
    headerConfigIcon.style.display = '';
  } else {
    headerConfigIcon.style.display = 'none';
  }
  headerTitle.textContent = state.title;
  headerEditBtn.style.display = state.type ? '' : 'none';
  if (headerEditInput) { headerEditInput.value = state.title; }
}

// ============================================================
// INITIALISATION
// ============================================================

const errorManager = new ErrorManager();
const apirest = new ApiREST(config.apiBase, errorManager);
const ui = new UI();
const graphManager = new GraphManager(main, {
  delete: function(id) {
    state.graphSettings.delete(id);
  }
});

// ============================================================
// HEADER TOOLBAR BUTTONS
// ============================================================

const UIElt = [];

const uiAddGraph = UI.CreateToolbarBtn('+ Graphe', 'Add a new graph');
uiAddGraph.onclick = function() {
  EnableMainUI(false);
  AddGraphique(state);
};
headerToolbar.appendChild(uiAddGraph);
UIElt.push(uiAddGraph);

const uiSaveView = UI.CreateToolbarBtn('Sauvegarder', 'Save the current view');
uiSaveView.onclick = function() {
  EnableMainUI(false);
  Save(state);
};
headerToolbar.appendChild(uiSaveView);
UIElt.push(uiSaveView);

const uiOpenView = UI.CreateToolbarBtn('Ouvrir vue', 'Open a saved view');
uiOpenView.onclick = function() {
  EnableMainUI(false);
  NewGraph();
};
headerToolbar.appendChild(uiOpenView);

const uiNewView = UI.CreateToolbarBtn('Nouvelle vue', 'Create a new blank view');
uiNewView.onclick = function() {
  EnableMainUI(false);
  ConfigBaseInformations();
};
headerToolbar.appendChild(uiNewView);

const uiInfo = UI.CreateToolbarBtn('Aide', 'Help');
uiInfo.onclick = OpenInfoModal;
headerToolbar.appendChild(uiInfo);

UIElt.forEach(function(element) {
  UI.DisableElement(element);
});

const modalpage = document.getElementById('modalpage');

// ============================================================
// GLOBAL KEYBOARD / BACKDROP HANDLERS
// ============================================================

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
