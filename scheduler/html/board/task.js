import { TaskCard } from './taskcard.js';

let taskCard;
let dataUrl = null;
const btn = document.createElement('a');

function GetQueryParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}

function SetError(message) {
  const header = document.getElementById('header');
  const stat = document.getElementById('error-stat');
  if (message) {
    document.getElementById('error-message').textContent = message;
    header.style.display = '';
  } else {
    header.style.display = 'none';
  }
}

async function FetchTask() {
  if (!dataUrl) {
    SetError('No data source — add ?data=<url> to the query string');
    return null;
  }

  let resp;
  try {
    resp = await fetch(dataUrl, { cache: 'no-store' });
  } catch (e) {
    SetError('Fetch failed: ' + e.message);
    return null;
  }

  if (!resp.ok) {
    SetError(`HTTP ${resp.status} ${resp.statusText}`);
    return null;
  }

  let json;
  try {
    json = await resp.json();
  } catch (e) {
    SetError('Invalid JSON: ' + e.message);
    return null;
  }

  if (!json.task || typeof json.task !== 'object') {
    SetError('JSON has no top-level "task" object');
    return null;
  }

  return json.task;
}

async function Refresh() {
  SetError(null);
  const task = await FetchTask();

  const container = document.getElementById('container-running-steps');
  btn.style.display = 'none';
  container.innerHTML = '';
  if (task) {
    if ((task.state === 'Done') || (task.state === 'Cancelled')) {
      btn.style.display = '';
    }
    container.appendChild(taskCard.Create(task));
  }
}

function Main() {
  const id = GetQueryParam('id');
  dataUrl = id ? `/api/task/${id}/state` : GetQueryParam('data');

  if (id) {
    btn.className = 'btn-download-artefacts';
    btn.href = `/api/task/${id}/artefacts`;
    btn.download = `${id}-artefacts.tgz`;
    btn.textContent = '⛏ Download Artefacts';
    document.body.appendChild(btn);
  }

  taskCard = new TaskCard({ onRefresh: Refresh });

  Refresh();
}

Main();
