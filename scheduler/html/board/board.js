import { JobLauncher } from './joblauncher.js';
import { TaskCard } from './taskcard.js';

let taskCard;

function DisableUI() {
  document.body.setAttribute('inert', '');
  document.body.setAttribute('aria-busy', 'true');
}

function EnableUI() {
  document.body.removeAttribute('inert');
  document.body.removeAttribute('aria-busy');
}

async function GetServerStatus() {
  var response = await fetch(`http://${window.location.host}/api/tasks/running`);
  if (!response.ok) {
    return [ false, [] ];
  }
  var data = await response.json();
  if (!data.success) {
    return [ data.error === 'Server can\'t read schedule status', [] ];
  }
  return [ true, data.data.tasksmanager.tasks, data.data.executors ];
}

function CreateMetric(label, value, perCores) {
  const metric = document.createElement('div');
  metric.classList.add('executor-stat-metric');

  const lbl = document.createElement('div');
  lbl.classList.add('executor-stat-label');
  lbl.textContent = label;

  const bar = document.createElement('div');
  bar.classList.add('exec-bar');
  const fill = document.createElement('div');
  fill.classList.add('exec-bar-fill');
  fill.style.width = Math.min(value, 100) + '%';
  if (value > 80) fill.classList.add('high');
  else if (value > 50) fill.classList.add('medium');
  bar.appendChild(fill);

  const val = document.createElement('div');
  val.classList.add('executor-stat-value');
  val.textContent = value + '%';

  metric.append(lbl, bar, val);

  // Tooltip per-core on CPU bar
  if (perCores && perCores.length > 0) {
    const tooltip = document.getElementById('exec-tooltip');

    bar.addEventListener('mouseenter', (e) => {
      tooltip.innerHTML = '';

      const ROW_HEIGHT_PX = 18;
      const availableHeight = window.innerHeight - e.clientY - 24;
      const MAX_ROWS = Math.max(1, Math.floor(availableHeight / ROW_HEIGHT_PX));
      const cols = Math.ceil(perCores.length / MAX_ROWS);
      const rows = Math.ceil(perCores.length / cols);
      tooltip.style.gridTemplateRows = `repeat(${rows}, auto)`;

      perCores.forEach((load, i) => {
        const row = document.createElement('div');
        row.classList.add('tooltip-core-row');

        const coreLbl = document.createElement('div');
        coreLbl.classList.add('tooltip-core-label');
        coreLbl.textContent = `Core ${i}`;

        const coreBar = document.createElement('div');
        coreBar.classList.add('tooltip-core-bar');
        const coreFill = document.createElement('div');
        coreFill.classList.add('tooltip-core-fill');
        coreFill.style.width = Math.min(load, 100) + '%';
        if (load > 80) coreFill.classList.add('high');
        else if (load > 50) coreFill.classList.add('medium');
        coreBar.appendChild(coreFill);

        const coreVal = document.createElement('div');
        coreVal.classList.add('tooltip-core-value');
        coreVal.textContent = load + '%';

        row.append(coreLbl, coreBar, coreVal);
        tooltip.appendChild(row);
      });
      tooltip.classList.add('visible');
    });

    bar.addEventListener('mousemove', (e) => {
      const rect = tooltip.getBoundingClientRect();
      const left = (e.clientX + 12 + rect.width > window.innerWidth)
          ? e.clientX - rect.width - 12 : e.clientX + 12;
      tooltip.style.left = left + 'px';
      tooltip.style.top  = (e.clientY + 12) + 'px';
    });

    bar.addEventListener('mouseleave', () => {
      tooltip.classList.remove('visible');
    });
  }

  return metric;
}

function SetHeader(counters, executors) {
  document.getElementById('done-count').innerText = counters['Done'] ?? 0;
  document.getElementById('running-count').innerText = counters['Running'] ?? 0;
  document.getElementById('queued-count').innerText = counters['Pending'] ?? 0;
  document.getElementById('last-update').innerText = new Date().toLocaleString("fr-FR");

  const container = document.getElementById('executors-stats');
  container.innerHTML = '';
  if (!executors) return;
  executors.forEach(executor => {
    const row = document.createElement('div');
    row.classList.add('executor-stat-row');

    const name = document.createElement('div');
    name.classList.add('executor-stat-name');
    name.textContent = executor.name;

    row.append(name, CreateMetric('CPU', executor.stats.load_cores, executor.stats.load_per_core), 
        CreateMetric('MEM', executor.stats.load_memory));
    container.appendChild(row);
  });
}

async function RefreshBoard() {
  DisableUI();
  const [success, tasks, executors] = await GetServerStatus();
  EnableUI();
  if (!success) {
    return;
  }
  document.getElementById('container-running-steps').innerHTML = '';
  const stateCount = {};
  tasks.forEach((task, _) => {
      Object.entries(task.steps).forEach(([_, step]) => {
          if (!stateCount[step.state]) {
            stateCount[step.state] = 0;
          }
          stateCount[step.state]++;
      });
      document.getElementById('container-running-steps').appendChild(taskCard.Create(task));
  });
  SetHeader(stateCount, executors);
}

function Main() {
  taskCard = new TaskCard({ onRefresh: RefreshBoard });
  const launcher = new JobLauncher({
        commitsUrl: `http://${window.location.hostname}:10083/api/git/history/tlspuffin`
    });

  document.getElementById('refresh-button').onclick = RefreshBoard;
  document.getElementById('new-task').onclick = () => { launcher.open() };

  RefreshBoard();
}

Main();