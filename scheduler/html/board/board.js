import { Terminal } from './terminal.js';
import { Logger } from './logs.js';

const dataSource = {
  mode: 'api',
  url: null,
  fileContent: null
};

function GetQueryParam(name) {
  const params = new URLSearchParams(window.location.search);
  return params.get(name);
}

function StepID(step) {
  return step.step_id + '-' + step.rank_id + '-' + step.attempt_id;
}

function Duration(step) {
  if (step.time_points_ms && step.time_points_ms[0]) {
    const startTime = step.time_points_ms[0];
    const now = step.time_points_ms[1] || Date.now();
    const duration = Math.floor((now - startTime) / 1000);
    const minutes = Math.floor(duration / 60);
    const seconds = duration % 60;
    return `${minutes}m ${seconds}s`;
  } else {
    return 'N/A';
  }
}

function ExitCodeLabel(step) {
  switch(step.exit_code) {
    case null:
    return 'N/A';
    case 0x0100:
    return 'Not set';
    case 0x0200:
    return 'Timedout';
    case 0x0400:
    return 'Cancelled';
    case 0x0800:
    return 'Launch Error';
    default:
    return step.exit_code;
  }
}

function TimeoutLabel(timeout) {
  if (timeout < 60) {
    return timeout + ' s';
  }
  const seconds = timeout % 60;
  let remainMinutes = timeout / 60;
  const minutes = remainMinutes % 60;
  remainMinutes -= minutes;
  const hours = remainMinutes / 60;

  let label = '';
  if (hours > 0) {
    label = hours + ' h';
  }
  if (minutes > 0) {
    if (label != '') {
      label += ' ';
    }
    label += minutes + ' m';
  }
  if (seconds > 0) {
    label += ' ' + seconds + ' s';
  }
  return label;
}

function DisableUI() {
  document.body.setAttribute('inert', '');
  document.body.setAttribute('aria-busy', 'true');
}

function EnableUI() {
  document.body.removeAttribute('inert');
  document.body.removeAttribute('aria-busy');
}

const logsInfos = {
  timerID: null,
  timerRun: false, 
  id: 0,
  step: null,
  type: 'stdout',
  stdout: {
    terminal: new Terminal('stdout-container'),
    decoder: new TextDecoder("utf-8"),
    lastoffset: 0,
    state: 0,
  },
  stderr: {
    terminal: new Terminal('stderr-container'),
    decoder: new TextDecoder("utf-8"),
    lastoffset: 0,
    state: 0,
  },
}

function CloseModal() {
  logsInfos.timerRun = false;
  if (logsInfos.timerID != null) {
    window.clearTimeout(logsInfos.timerID);
    logsInfos.timerID = null;
  }
  document.getElementById('logs-modal').classList.remove('show');
}

function SwitchOutput(newOutput) {
  document.getElementById(`log-${logsInfos.type}`).classList.toggle('active');
  document.getElementById(`${logsInfos.type}-container`).classList.toggle('active');
  document.getElementById(`${logsInfos.type}-content`).classList.add('active');
  logsInfos.type = newOutput;
  document.getElementById(`log-${logsInfos.type}`).classList.toggle('active');
  document.getElementById(`${logsInfos.type}-container`).classList.toggle('active');
  document.getElementById(`${logsInfos.type}-content`).classList.add('active');
  if ((logsInfos.timerID != null) && (logsInfos.timerRun)) {
    window.clearTimeout(logsInfos.timerID);
    RetrieveFullStepLogs(logsInfos, 10000000);
  }
}

async function RetrieveStepLogs(logsInfos, size) {
  const taskID = logsInfos.step.task_id;
  const stepUUID = logsInfos.step.uuid;
  const stepID = StepID(logsInfos.step);

  const type = logsInfos.type;

  console.log('query');
  var response = await fetch(
      `http://${window.location.host}/api/task/output/${taskID}/${stepUUID}/${stepID}/${type}/${size}/${logsInfos[type].lastoffset}`);

  if (!response.ok) {
    return [false, 0, null];
  }
  var data = await response.json();
  if (!data.success) {
    return [false, 0, null];
  }

  logsInfos[type].state = data.state;  
  logsInfos[type].lastoffset += data.size;

  return [true, data.state, atob(data.data)];
}

async function RetrieveFullStepLogs(logsInfos, size) {
  logsInfos.timerID = null;

  var success = true;
  var state = 1;
  var data;
  while(success && (state == 1)) {
    [success, state, data] = await RetrieveStepLogs(logsInfos, size);
    if (success && (data.length > 0)) {
      console.log('update', data.length);
      //document.getElementById(`${logsInfos.type}-content`).innerText += 
      logsInfos[logsInfos.type].terminal.AppendText(
          logsInfos[logsInfos.type].decoder.decode(
              Uint8Array.from(data, c => c.charCodeAt(0)),
              { stream: state != 2 }
          )
      );
    }
  }
  if (state == 2) {
    logsInfos.timerRun = false;
  }

  if (logsInfos.timerRun) {
    logsInfos.timerID = window.setTimeout(RetrieveFullStepLogs, 5000, logsInfos, size);
  }
}

async function StepLogs(step, taskName) {
  const id = step.task_id + '-' + step.uuid;
  if (logsInfos.id != id) {
    logsInfos.id = id;
    logsInfos.step = step;
    logsInfos.type = 'stdout',
    logsInfos.stdout.terminal.SetText("");
    logsInfos.stdout.decoder = new TextDecoder("utf-8");
    logsInfos.stdout.lastoffset = 0;
    logsInfos.stdout.state = 0;
    logsInfos.stderr.terminal.SetText("");
    logsInfos.stderr.decoder = new TextDecoder("utf-8");
    logsInfos.stderr.lastoffset = 0;
    logsInfos.stderr.state = 0;
    //document.getElementById('stdout-content').innerText = '';
    //document.getElementById('stderr-content').innerText = '';
  }

  let stepName = step.name;
  if ((step.id != '') && (step.id != '.')) {
    stepName += ` ${step.id}`;
  }
  stepName += ` (${taskName})`;

  document.getElementById(`log-${logsInfos.type}`).classList.add('active');
  document.getElementById(`${logsInfos.type}-container`).classList.add('active');
  document.getElementById(`${logsInfos.type}-content`).classList.add('active');
  let inactiveType = logsInfos.type === 'stdout' ? 'stderr' : 'stdout';
  document.getElementById(`log-${inactiveType}`).classList.remove('active');
  document.getElementById(`${inactiveType}-container`).classList.remove('active');
  document.getElementById(`${inactiveType}-content`).classList.remove('active');

  document.getElementById('step-name').innerText = stepName;
  document.getElementById('logs-modal').classList.add('show');

  logsInfos.timerRun = true;
  await RetrieveFullStepLogs(logsInfos, 10000000);
}

async function CancelTask(taskID) {
  DisableUI();

  let response = await fetch(
      `http://${window.location.host}/api/task/${taskID}`,
      { method: 'DELETE' }
  );
  let data = { success: false };
  if (response.ok) {
    data = await response.json();
  }

  EnableUI();

  if (data.success) {
    await RefreshBoard();
  }
}

async function CancelStep(taskID, stepUUID) {
  DisableUI();

  let response = await fetch(
      `http://${window.location.host}/api/task/${taskID}/step/${stepUUID}`,
      { method: 'DELETE' }
  );
  let data = { success: false };
  if (response.ok) {
    data = await response.json();
  }

  EnableUI();
  if (data.success) {
    await RefreshBoard();
  }
}

function CreateCardLine(id, type, style, infos) {
  const div = document.createElement('div');
  if (id != null) {
    div.id = id;
  }
  if (type instanceof Array) {
    type.forEach(value => {
        div.classList.add('card-'+value);
    });
  } else {
    div.classList.add('card-'+type);
  }
  infos.forEach((info, index) => {
      const element = document.createElement('div');
      if (info instanceof HTMLElement) {
        element.appendChild(info);
      } else {
        element.innerHTML = info;
      }
      element.classList.add('card-'+style[index]);
      div.appendChild(element);
  });
  return div;
}

function CreateAttemptCard(step, taskName) {
  const div = document.createElement('div');
  div.classList.add('card-attempt-item');

  const state = step.state.toLowerCase();
  div.classList.add('card-attempt-item', `state-${state}`);

  if (step.nb_retry > 1) {
    div.appendChild(CreateCardLine(
        null, 'attempt-header', 
        ['attempt-name'], 
        [`Attempt ${step.attempt_id}`]));
  }

  const details = document.createElement('div');
  details.classList.add('card-attempt-details');

  if (step.state == 'Pending') {
    details.appendChild(CreateCardLine(
        null, 'attempt-detail-item',
        ['attempt-detail-value-state'],
        ['Pending']
    ));
  } else {
    details.appendChild(CreateCardLine(
        null, 'attempt-detail-item',
        ['attempt-detail-label', 'attempt-detail-value', 'attempt-detail-value-state'],
        ['PID', step.executor_data?.pid || 'N/A', step.state]
    ));

    if (step.state == 'Running') {
      const coresList = document.createElement('div');
      coresList.classList.add('cores-list');
      step.executor_data?.cores.forEach(core => {
          const chip = document.createElement('div');
          chip.classList.add('core-chip');
          chip.textContent = core;
          coresList.appendChild(chip);
      }); 
      details.appendChild(CreateCardLine(
          null, 'attempt-detail-item',
          ['attempt-detail-label', 'attempt-detail-value'],
          ['Cores', coresList]
      ));
    } else {
      details.appendChild(CreateCardLine(
          null, 'attempt-detail-item',
          ['attempt-detail-label', 'attempt-detail-value'],
          ['Exit Code', ExitCodeLabel(step)]
      ));
    }

    details.appendChild(CreateCardLine(
        null, 'attempt-detail-item',
        ['attempt-detail-label', 'attempt-detail-value'],
        ['Duration', Duration(step)]
    ));

    const logsButton = document.createElement('button');
    logsButton.classList.add('card-attempt-logs-btn');
    logsButton.textContent = 'Logs';
    logsButton.onclick = () => {
        StepLogs(step, taskName);
        //Logger.Show(step, taskName);
    };
    if (dataSource.mode === 'url') {
      logsButton.style.display = 'none';
    }
    if (step.state == 'Running') {
      const cancelButton = document.createElement('button');
      cancelButton.classList.add('card-attempt-cancel-btn');
      cancelButton.textContent = 'Cancel';
      cancelButton.onclick = async (event) => {
          await CancelStep(step.task_id, step.uuid);
      };
      details.appendChild(CreateCardLine(
          null, 'attempt-detail-item-grid',
          ['attempt-detail-label', 'attempt-detail-value', 'attempt-detail-value'],
          ['Action', logsButton, cancelButton]
      ));
    } else {
      details.appendChild(CreateCardLine(
          null, 'attempt-detail-item-grid',
          ['attempt-detail-label', 'attempt-detail-value'],
          ['Action', logsButton]
      ));
    }
  } 

  div.appendChild(details);

  if ((step.state != 'Pending') && (step?.message_from_run)) {
    const monitor = document.createElement('div');
    monitor.classList.add('card-attempt-details');
    monitor.appendChild(CreateCardLine(
        null, 'attempt-detail-item',
        ['attempt-detail-label', 'attempt-detail-value-monitor'],
        ['Monitor', step.message_from_run],
    ));
    div.appendChild(monitor);
  }

  return div;
}

function CreateStepsCard(steps, taskName) {
  const div = document.createElement('div');
  div.classList.add('card-step-running');

  if ((steps[0].id != '') && (steps[0].id != '.')) {
    div.appendChild(CreateCardLine(
        null, 'step-name', 
        [/*'step-value-name'*/'step-attempts-detail-name', 'step-value-id'], 
        [/*steps[0].name*/'Configuration', steps[0].id]
    ));
  }

  if (steps[0].timeout > 0) {
    div.appendChild(CreateCardLine(
        null, ['step-attempts-detail', 'step-attempts-detail-end'], 
        ['step-attempts-detail-name', 'step-attempts-detail-value'], 
        ['Timeout', TimeoutLabel(steps[0].timeout)]
    ));
  }

  if (steps.length > 1) {
    div.appendChild(CreateCardLine(
        null, ['step-attempts-detail', 'step-attempts-detail'], 
        ['step-attempts-detail-name', 'step-attempts-detail-value'], 
        ['NB Attempts', steps.length]
    ));

    const counts = steps.reduce((acc, step) => 
        {
          const state = (step.state || "").toLowerCase();
          switch (state) {
            case "pending":
              acc.pending++;
              break;
            case "running":
              acc.running++;
              break;
            case "timedout":
              acc.timedout++;
              break;
            case "cancelled":
              acc.cancelled++;
              break;
            case "done":
              if (step.exit_code === 0) {
                acc.done++;
              } else {
                acc.fail++;
              }
            break;
          }
          return acc; 
        },
        {
          pending: 0,
          running: 0,
          timedout: 0,
          cancelled: 0,
          done: 0,
          fail: 0
        }
    );
    const parts = Object.entries(counts)
        .filter(([_, v]) => v > 0)
        .map(([k, v]) => `${k}:${v}`);
    const summary = parts.join(" ");
    div.appendChild(CreateCardLine(
            null, ['step-attempts-detail', 'step-attempts-detail-end'], 
            ['step-attempts-detail-name', 'step-attempts-detail-value'], 
            ['', summary]
        ));
  }

  if (Object.keys(steps[0].args).length) {
    div.appendChild(CreateCardLine(
        null, 'step-attempts-detail', 
        ['step-attempts-detail-name'], 
        ['Arguments:']
    ));

    Object.entries(steps[0].args || {}).map(([key, value], index, array) => {
        let style = 'step-attempts-detail';
        if (index == (array.length-1)) {
          style = ['step-attempts-detail', 'step-attempts-detail-end'];
        }
        console.log(index, array);
        div.appendChild(CreateCardLine(
            null, style, 
            ['step-attempts-detail-name', 'step-attempts-detail-value'], 
            ['', key+': '+value]
        ));

    })
  }

  steps.forEach(step => {
      //if (step.state != 'Pending') {
      div.appendChild(CreateAttemptCard(step, taskName));
      //}
  });

  return div
}

function CreateTaksCard(task, steps) {
  const div = document.createElement('div');
  div.classList.add('card-task-running');

  const cancelButton = document.createElement('button');
  cancelButton.classList.add('card-attempt-cancel-btn');
  cancelButton.textContent = 'Cancel';
  cancelButton.onclick = async (event) => {
      await CancelTask(task.id);
  };

  let count = 0;
  for (const [, someSteps] of steps) {
    count += someSteps.filter(step => step.state === 'Running' || step.state === 'Pending').length;
  }
  if (count == 0) {
    cancelButton.style.display = 'none';
  }

  let taskName = task.name;
  if (taskName === '') {
    taskName = task.id;
    div.appendChild(CreateCardLine(
        null, 'task-id', 
        ['task-label-id', 'task-value-name'], 
        ['Task '+task.id, cancelButton]
    ));
  } else {
    div.appendChild(CreateCardLine(
        null, 'task-id', 
        ['task-value-name', 'task-value-name'], 
        [task.name, cancelButton]
    ));
    div.appendChild(CreateCardLine(
        null, 'task-name', 
        ['task-label-id', 'task-value-id'], 
        ['Task', task.id]
    ));
  }

  const separator = document.createElement('div')
  separator.classList.add('card-task-separator');
  div.appendChild(separator);

  div.appendChild(CreateCardLine(
      null, 'task-label-args', 
      ['task-args-label'], 
      ['Arguments:']
  ));
  task.args.forEach(arg => {
      div.appendChild(CreateCardLine(
          null, 'task-args', 
          ['task-args-name', 'task-args-name'], 
          [arg.key, arg.value]
      ));
  });

  /*console.log("Steps:", steps);
  steps.forEach(step => {
      console.log(step.name, step.id);
      console.log("Step:", step);
      div.appendChild(CreateStepsCard(step, taskName));
  });*/
  const regroupedSteps = new Map();
  steps.forEach(attemps => {
      attemps.forEach(attemp => {
          if (!regroupedSteps.get(attemp.name)) {
            regroupedSteps.set(attemp.name, new Map());
          }
          if (!regroupedSteps.get(attemp.name).get(attemp.id)) {
            regroupedSteps.get(attemp.name).set(attemp.id, []);
          }
          regroupedSteps.get(attemp.name).get(attemp.id).push(attemp);
      });
  });
  console.log("Steps:", regroupedSteps);
  regroupedSteps.forEach((steps, functionID) => {
      const divStep = document.createElement('div');
      divStep.classList.add('card-step');

      const divStepName = document.createElement('div');
      divStepName.innerText = functionID;
      divStepName.classList.add('card-step-main-name');
      divStep.appendChild(divStepName);

      steps.forEach((step, functionID) => {
          console.log(" - Step:", functionID, steps);
          divStep.appendChild(CreateStepsCard(step, taskName));
      });
      div.appendChild(divStep);
  });

  document.getElementById('container-running-steps').appendChild(div);
 }

async function GetServerStatus() {
  if (dataSource.mode === 'url' && dataSource.url) {
    const resp = await fetch(dataSource.url, { cache: 'no-store' });
    if (!resp.ok) return [false, []];
    const json = await resp.json();
    let success = (json.task && (typeof json.task === 'object'));
    return [success, success ? [json.task] : []];
  }

  var response = await fetch(`http://${window.location.host}/api/tasks/running`);
  if (!response.ok) {
    return [ false, [] ];
  }
  var data = await response.json();
  if (!data.success) {
    return [ data.error === 'Server can\'t read schedule status', [] ];
  }
  data = data.data.tasks;
  return [ true, data ];
}

function SetHeader(counters) {
  document.getElementById('done-count').innerText = counters['Done'] ?? 0;
  document.getElementById('running-count').innerText = counters['Running'] ?? 0;
  document.getElementById('queued-count').innerText = counters['Pending'] ?? 0;
  document.getElementById('last-update').innerText = new Date().toLocaleString("fr-FR");
}

async function RefreshBoard() {
  DisableUI();
  const [success, tasks] = await GetServerStatus();
  EnableUI();
  if (!success) {
    return;
  }
  document.getElementById('container-running-steps').innerHTML = '';
  const stateCount = {};
  const state = {};
  tasks.forEach((task, taskindex) => {
      Object.entries(task.steps).forEach(([stepuuid, step]) => {
          if (state[step.state] == null) {
            state[step.state] = {}
            stateCount[step.state] = 0;
          }
          stateCount[step.state]++;
          if (state[step.state][taskindex] == null) {
            state[step.state][taskindex] = new Map();
          }
          if (!state[step.state][taskindex].has(step.step_id+'-'+step.rank_id)) {
            state[step.state][taskindex].set(step.step_id+'-'+step.rank_id, []);
          }
          state[step.state][taskindex].get(step.step_id+'-'+step.rank_id).push(step);
      });

      const steps = new Map();
      Object.entries(task.steps).forEach(([stepid, step]) => {
          if (!steps.has(step.step_id+'-'+step.rank_id)) {
            steps.set(step.step_id+'-'+step.rank_id, []);
          }
          steps.get(step.step_id+'-'+step.rank_id, []).push(step);
      });
      CreateTaksCard(task, steps);
  });
  console.log(state);
  SetHeader(stateCount);
  /*if (state['Running']) {
    Object.entries(state['Running']).forEach(([taskid, steps]) => {
        CreateTaksCard(tasks[taskid], steps);
    });
  }*/
}

function main() {
  const fileInURL = GetQueryParam('data');
  if (fileInURL) {
    dataSource.mode = 'url';
    dataSource.url = fileInURL;
    document.getElementById('refresh-button').style.display = 'none';
  }

  RefreshBoard();
  document.getElementById('refresh-button').onclick = RefreshBoard;

  document.getElementById('log-stdout').onclick = SwitchOutput.bind(null, 'stdout');
  document.getElementById('log-stderr').onclick = SwitchOutput.bind(null, 'stderr');

  document.getElementById('modal-close').onclick = CloseModal;
}

main();

console.log('done');
