import { TaskCard } from './taskcard.js';
import { Clipboard } from './clipboard.js';

const ui = {
  users: document.getElementById('container-users'),
  timesline: document.getElementById('container-timesline'),
  tasks: document.getElementById('container-tasks'),
}

const taskCard = new TaskCard({ onRefresh: () => {} });

const currentSelection = {
  name: null,
  jobType: null,
  task: null,
};

function DisableUI() {
  document.body.setAttribute('inert', '');
  document.body.setAttribute('aria-busy', 'true');
}

function EnableUI() {
  document.body.removeAttribute('inert');
  document.body.removeAttribute('aria-busy');
}

async function DeleteTask(task) {
  if (!confirm(`Delete experiment results of task ${task.id}:\n\t${task.name}`)) {
    return;
  }
  DisableUI();
  EnableUI();
  alert('Not yet implemented');
}

function CreateErrorMessage(message) {
  const div = document.createElement('div');
  div.className = 'tasks-error';
  div.textContent = message;
  return div;
}

async function SelectTask(task) {
  DisableUI();
  try {
    const response = await fetch(`http://${window.location.host}/api/task/${task.id}/final_state`);
    const json = await response.json();
    ui.tasks.innerHTML = '';
    if (json.task) {
      ui.tasks.appendChild(taskCard.Create(json.task));
    } else if (json.error) {
      ui.tasks.appendChild(CreateErrorMessage(`${task.id}: ${json.error}`));
    } else {
      ui.tasks.appendChild(CreateErrorMessage(`${task.id}: Unknown server error`));
    }
    currentSelection.task = task;
  } catch (e) {
    console.error(`Unable to load ${task.id}: ${e.message()}`);
  }
  EnableUI();
}

function CreateTimelinesCard(task) {
  const time = new Date(task.id).toLocaleTimeString(navigator.languages, { hour: '2-digit', minute: '2-digit' });

  const div = document.createElement('div');
  div.className = 'timesline-content';
  div.onclick = (event) => {
      event.stopPropagation();
      SelectTask(task);
  }

  const state = task.cancelled ? 'cancelled' : 'done';
  div.classList.add('state-' + state);

  const timeSpan = document.createElement('span');
  timeSpan.textContent = time;
  div.appendChild(timeSpan);

  const publishSpan = document.createElement('span');
  const publishLink = task?.publish_link;
  if (publishLink) {
    publishSpan.textContent = '🗂️';
    publishSpan.onclick = (event) => {
      event.stopPropagation();
      Clipboard.Set(publishLink);
      window.open(publishLink, '_blank');
    }
  }
  div.appendChild(publishSpan);

  const nameSpan = document.createElement('span');
  nameSpan.textContent = task.name;
  div.appendChild(nameSpan);

  const flagColor = task?.flag?.color;
  if (flagColor) {
    div.style.setProperty('--flag-color', flagColor);
  }

  const deleteButton = document.createElement('button');
  deleteButton.innerText = '💣👾';
  deleteButton.onclick = (event) => {
      event.stopPropagation();
      DeleteTask(task);
  }
  div.appendChild(deleteButton);

  return div;
}

function CreateTimelinesDateSeparator(ts) {
  // const date = new Date(ts).toLocaleDateString(navigator.languages, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const date = new Date(ts).toLocaleDateString(navigator.languages);

  const div = document.createElement('div');
  div.className = 'timesline-date-separator';
  div.textContent = date;

  return div;
}

function BuildTimesLine(tasks) {
  ui.timesline.innerHTML = '';
  let lastTS = null;

  tasks.history.forEach((task) => {
    let currentTS = new Date(task.id).toDateString();
    if ((lastTS == null) || (lastTS !== currentTS)) {
      ui.timesline.appendChild(CreateTimelinesDateSeparator(task.id));
      lastTS = currentTS;
    }
    ui.timesline.appendChild(CreateTimelinesCard(task));
  });
}

async function SelectUsers(name, jobType) {
  const results = {
    running: [],
    done: [],
    cancelled: [],
    all: [],
    history: [],
    min: 0,
    max: 0,
  }

  DisableUI();

  try {
    const response = await fetch(`http://${window.location.host}/api/user/${name}/${jobType}/tasks`);
    const json = await response.json();
    if (json.success) {
      if (json.data.length > 0) {
        json.data.sort((a, b) => b.id - a.id);
        results.min = json.data[0].id;
        results.max = json.data[json.data.length - 1].id;
        json.data.reduce((acc, task) => {
            acc.all.push(task);
            if (task.running) {
              acc.running.push(task);
            } else if (task.cancelled) {
              acc.cancelled.push(task);
              acc.history.push(task);
            } else {
              acc.done.push(task);
              acc.history.push(task);
            }
            return acc;
        }, results);
      }
    }
  } catch (e) {
  }

  currentSelection.name = name;
  currentSelection.jobType = jobType;
  BuildTimesLine(results);

  EnableUI();
}

function BuildUserSelection(user, userData) {
  const userDiv = document.createElement('div');
  userDiv.className = 'user-global';

  const userNameDiv = document.createElement('span');
  userNameDiv.className = 'user-name';
  userNameDiv.innerText = `${user}:`;
  userDiv.appendChild(userNameDiv);

  userData.jobs_type.forEach(jobType => {
      const userSelection = document.createElement('button');
      userSelection.className = 'user-selection';
      userSelection.innerText = jobType;
      userSelection.onclick = SelectUsers.bind(null, user, jobType);
      userDiv.appendChild(userSelection);
  });
  return userDiv;
}

async function ListUsersJobsType(users) {
  const result = {};
  let promises = [];
  for(let user of users) {
    promises.push((async () => {
        try {
          const response = await fetch(`http://${window.location.host}/api/user/${user}/job_types`)
          const json = await response.json();
          if (json.success) {
            result[user] = {
              jobs_type: json.data,
            };
          }
        } catch(e) {
          console.error(`Server error while retrieving user ${user}: e.message()`);
        }
    })());
    if (promises.length >= 10) {
      await Promise.all(promises);
      promises = [];
    }
  }
  if (promises.length > 0) {
    await Promise.all(promises);
    promises = [];
  }
  return result;
}

async function ListUsers() {
  const response = await fetch(`http://${window.location.host}/api/users`);
  const json = await response.json();
  if (json.success) {
    return ListUsersJobsType(json.data);
  }
  return [];
}

async function BuildUsersMenu() {
  DisableUI();
  ui.users.innerHTML = '';
  ui.timesline.innerHTML = '';
  ui.tasks.innerHTML = '';
  let users = await ListUsers();
  for(let user in users) {
    ui.users.appendChild(BuildUserSelection(user, users[user]));
  }
  EnableUI();
}

async function Refresh() {
  await BuildUsersMenu();
  if ((currentSelection.name !== null) && (currentSelection.jobType != null)) {
    await SelectUsers(currentSelection.name, currentSelection.jobType);
    if (currentSelection.task !== null) {
      await SelectTask(currentSelection.task);
    }
  }
}

function Main() {
  document.getElementById('refresh-button').onclick = Refresh;
  Refresh();
}

Main();
