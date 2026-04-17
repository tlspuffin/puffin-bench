import { Terminal } from './terminal.js';

const FileReadState = Object.freeze({
  Error_Access: 0, Error_Open: 1, Error_OverFlow: 2,
  NotExecuted: 3, Ok: 4, EndOfFile: 5
});

export class TaskCard {

  // Modal DOM references
  #modal;
  #modalStepName;
  #logButtons;  // { stdout: HTMLElement, stderr: HTMLElement }
  #containers;  // { stdout: HTMLElement, stderr: HTMLElement }
  #contents;    // { stdout: HTMLElement, stderr: HTMLElement }

  // Logs state — one per instance
  #logsInfos;

  // Options
  #onRefresh;

  static #sharedModal = null;

  /**
   * @param {object}   options
   * @param {function} [options.onRefresh]      — called after a cancel action
   */
  constructor(options = {}) {
    this.#onRefresh = options.onRefresh ?? (() => {});

    this.#CreateModal();

    this.#logsInfos = {
        timerID: null,
        abortController: null,
        id: 0,
        step: null,
        type: 'stdout',
        stdout: {
            terminal: new Terminal('stdout-container'),
            decoder: new TextDecoder("utf-8"),
            lastoffset: 0,
            state: 0,
            supportSeek: true,
            startOffset: 0,
        },
        stderr: {
            terminal: new Terminal('stderr-container'),
            decoder: new TextDecoder("utf-8"),
            lastoffset: 0,
            state: 0,
            supportSeek: true,
            startOffset: 0,
        },
    };
  }

  // ── Public ───────────────────────────────────────────────────

  // Returns an HTMLElement for the full task — caller inserts it into the DOM
  Create(task) { 
    const steps = this.#BuildSteps(task);

    const div = document.createElement('div');
    div.classList.add('card-task-running');
    if (task.request_cancel) {
      div.classList.add('card-task-cancelling');
    }

    const cancelButton = document.createElement('button');
    cancelButton.classList.add('card-attempt-cancel-btn');
    cancelButton.textContent = 'Cancel';
    cancelButton.onclick = async () => { 
        if (!confirm(`Cancel task "${task.name || task.id}" ?`)) {
          return;
        }
        await this.#CancelTask(task.id);
    };

    // Count active steps to decide whether to show the cancel button
    let activeCount = 0;
    steps.forEach(byId => byId.forEach(attempts =>
      attempts.forEach(s => { if (s.state === 'Running' || s.state === 'Pending') activeCount++; })
    ));
    if (activeCount === 0 || task.request_cancel) {
      cancelButton.style.display = 'none';
    }

    let username = '';
    if (task?.user && (task.user != '')) {
      username = task.user;
    }

    const divCardHeader = document.createElement('div');
    divCardHeader.id = 'card-task-header';
    let taskName = task.name;
    if (taskName === '') {
      taskName = task.id;
      divCardHeader.appendChild(this.#CreateCardLine(
        null, 'task-id',
        ['task-label-id', 'task-value-name'],
        ['Task ' + task.id, cancelButton]
      ));
      if (username != '') {
        divCardHeader.appendChild(this.#CreateCardLine(
          null, 'task-name',
          ['task-label-id', 'task-value-id'],
          ['User', username]
        ));
      }
    } else {
      divCardHeader.appendChild(this.#CreateCardLine(
        null, 'task-id',
        ['task-value-name', 'task-value-name'],
        [task.name, cancelButton]
      ));
      divCardHeader.appendChild(this.#CreateCardLine(
        null, 'task-name',
        ['task-label-id', 'task-value-id'],
        ['Task / User: ', task.id + ' / ' + username]
      ));
    }

    const separator = document.createElement('div');
    separator.classList.add('card-task-separator');
    divCardHeader.appendChild(separator);

    const taskLoad = task.executor_data?.os_load;
    if (taskLoad) {
      divCardHeader.appendChild(this.#CreateCardLine(
        null, 'task-loads',
        ['task-loads-label', 'task-loads-value', 'task-loads-value'],
        ['Load', 'Mem ' + taskLoad.memory + '%', 'CPU ' + taskLoad.cores + '%']
      ));
      const separator2 = document.createElement('div');
      separator2.classList.add('card-task-separator');
      divCardHeader.appendChild(separator2);
    }

    divCardHeader.appendChild(this.#CreateCardLine(
      null, 'task-label-args',
      ['task-args-label'],
      ['Arguments:']
    ));
    task.args.forEach(arg => {
      divCardHeader.appendChild(this.#CreateCardLine(
        null, 'task-args',
        ['task-args-name', 'task-args-name'],
        [arg.key, arg.value]
      ));
    });
    div.appendChild(divCardHeader);

    const divCardSteps = document.createElement('div');
    divCardSteps.id = 'card-task-steps';
    steps.forEach((byId, functionName) => {
      const divStep = document.createElement('div');
      divStep.classList.add('card-step');

      const divStepName = document.createElement('div');
      divStepName.classList.add('card-step-main-name');
      divStepName.style.cursor = 'default';
      const nameSpan = document.createElement('span');
      nameSpan.innerText = functionName;
      const iconSpan = document.createElement('span');
      iconSpan.innerText = '➖';
      divStepName.appendChild(nameSpan);
      divStepName.appendChild(iconSpan);
      divStepName.onclick = () => {
          divStep.classList.toggle('collapsed');
          iconSpan.innerText = divStep.classList.contains('collapsed') ? '➕' : ' ➖';
      };
      divStep.appendChild(divStepName);

      let hasRunning = false
      byId.forEach(attempts => {
        hasRunning = attempts.reduce(
            (accumulator, attempt) => accumulator || (attempt.state === 'Running'),
            hasRunning);
        divStep.appendChild(this.#CreateStepsCard(attempts, taskName, task.request_cancel));
      });
      if (!hasRunning) {
        divStep.classList.add('collapsed');
        iconSpan.innerText = '➕';
      }
      divCardSteps.appendChild(divStep);
    });
    div.appendChild(divCardSteps);

    return div;
  }


  CloseModal() {
    if (this.#logsInfos.timerID != null) {
      window.clearTimeout(this.#logsInfos.timerID);
      this.#logsInfos.timerID = null;
    }
    if (this.#logsInfos.abortController != null) {
      this.#logsInfos.abortController.abort();
      this.#logsInfos.abortController = null;
    }
    this.#modal.classList.remove('show');
  }

  SwitchOutput(newOutput) {
    const prev = this.#logsInfos.type;
    if (prev == newOutput) {
      return;
    }
    this.#logButtons[prev].classList.remove('active');
    this.#containers[prev].classList.remove('active');
    this.#contents[prev].classList.remove('active');

    this.#logsInfos.type = newOutput;

    this.#logButtons[newOutput].classList.add('active');
    this.#containers[newOutput].classList.add('active');
    this.#contents[newOutput].classList.add('active');

    if (this.#logsInfos.timerID != null) {
      window.clearTimeout(this.#logsInfos.timerID);
    }
    this.#RetrieveFullStepLogs(this.#logsInfos, 10000000);
  }

  // ── Private — modal setup ────────────────────────────────────

  // Creates the modal DOM and appends it to document.body
  #CreateModal() {
    if (!TaskCard.#sharedModal) {
      const modal = document.createElement('div');
      modal.classList.add('modal-overlay');
      modal.innerHTML = `
          <div class="modal-content">
            <div class="modal-header">
              <h3>Step Logs - <span id="step-name"></span></h3>
              <button class="modal-close" id="modal-close">&times;</button>
            </div>
            <div class="modal-body">
              <div class="logs-tabs">
                <button class="tab-btn active" id="log-stdout">STDOUT</button>
                <button class="tab-btn"        id="log-stderr">STDERR</button>
              </div>
              <div class="logs-content">
                <div class="logs-container active" id="stdout-container">
                  <div class="logs-scroll-overlay" id="stdout-scroll-overlay"></div>
                  <pre id="stdout-content"></pre>
                </div>
              <div class="logs-container" id="stderr-container">
                <div class="logs-scroll-overlay" id="stderr-scroll-overlay"></div>
                  <pre id="stderr-content"></pre>
                </div>
              </div>
            </div>
          </div>`;
      document.body.appendChild(modal);
      modal.addEventListener('wheel', e => e.preventDefault(), { passive: false });

      modal.querySelector(`#modal-close`).onclick = () => this.CloseModal();
      TaskCard.#sharedModal = modal;
    }

    this.#modal = TaskCard.#sharedModal;
    this.#modalStepName = this.#modal.querySelector(`#step-name`);
    this.#logButtons = {
        stdout: this.#modal.querySelector(`#log-stdout`),
        stderr: this.#modal.querySelector(`#log-stderr`),
    };
    this.#containers = {
        stdout: this.#modal.querySelector(`#stdout-container`),
        stderr: this.#modal.querySelector(`#stderr-container`),
    };
    this.#contents = {
        stdout: this.#modal.querySelector(`#stdout-content`),
        stderr: this.#modal.querySelector(`#stderr-content`),
    };

    this.#logButtons.stdout.onclick = () => this.SwitchOutput('stdout');
    this.#logButtons.stderr.onclick = () => this.SwitchOutput('stderr');
  }

  // ── Private — step grouping ──────────────────────────────────

  // Groups task.steps (uuid-keyed) into Map<name, Map<id, step[]>>
  #BuildSteps(task) {
    const result = new Map();
    Object.values(task.steps).forEach(step => {
        if (!result.has(step.name)) {
          result.set(step.name, new Map());
        }
        if (!result.get(step.name).has(step.id)) {
          result.get(step.name).set(step.id, []);
        }
        result.get(step.name).get(step.id).push(step);
    });
    return result;
  }

  // ── Private — pure helpers ───────────────────────────────────

  #StepID(step) {
    return step.step_id + '-' + step.rank_id + '-' + step.attempt_id;
  }

  #Duration(step) {
    if (step.time_points_ms && step.time_points_ms[0]) {
      const startTime = step.time_points_ms[0];
      const now = step.time_points_ms[1] || Date.now();
      const duration = Math.floor((now - startTime) / 1000);
      return `${Math.floor(duration / 60)}m ${duration % 60}s`;
    }
    return 'N/A';
  }

  #ExitCodeLabel(step) {
    switch (step.exit_code) {
      case null:   return 'N/A';
      case 0x0100: return 'Not set';
      case 0x0200: return 'Timedout';
      case 0x0400: return 'Cancelled';
      case 0x0800: return 'Launch Error';
      default:     return step.exit_code;
    }
  }

  #TimeoutLabel(timeout) {
    if (timeout < 60) return timeout + ' s';
    const seconds = timeout % 60;
    const remainMinutes = timeout / 60;
    const minutes = remainMinutes % 60;
    const hours   = (remainMinutes - minutes) / 60;
    let label = '';
    if (hours   > 0) label  = hours   + ' h';
    if (minutes > 0) label += (label ? ' ' : '') + minutes + ' m';
    if (seconds > 0) label += ' ' + seconds + ' s';
    return label;
  }

  #EnableUI() {
    document.body.removeAttribute('inert');
    document.body.removeAttribute('aria-busy');
  }

  #DisableUI() {
    document.body.setAttribute('inert', '');
    document.body.setAttribute('aria-busy', 'true');
  }

  // ── Private — DOM builders ───────────────────────────────────

  #CreateCardLine(id, type, style, infos) {
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

  #CreateAttemptCard(step, taskName, taskCancelRequested) {
    /*const div = document.createElement('div'); 
    div.innerText = `**** ${step} ${taskName} ${taskCancelRequested}`
    return div;*/
    const div = document.createElement('div');
    div.classList.add('card-attempt-item', `state-${step.state.toLowerCase()}`);

    if (step.nb_retry > 1) {
      div.appendChild(this.#CreateCardLine(
          null, 'attempt-header',
          ['attempt-name'],
          [`Attempt ${step.attempt_id}`]
      ));
    }

    const details = document.createElement('div');
    details.classList.add('card-attempt-details');

    if (step.state === 'Pending') {
      details.appendChild(this.#CreateCardLine(
          null, 'attempt-detail-item',
          ['attempt-detail-value-state'],
          ['Pending']
      ));
    } else {
      const info = document.createElement('div');
      info.classList.add('card-attempt-details-info');
      info.appendChild(this.#CreateCardLine(
          null, 'attempt-detail-item',
          ['attempt-detail-label', 'attempt-detail-value', 'attempt-detail-value-state'],
          ['PID', step.executor_data?.pid || 'N/A', step.state]));
      info.appendChild(this.#CreateCardLine(
          null, 'attempt-detail-item',
          ['attempt-detail-label', 'attempt-detail-value'],
          ['Duration', this.#Duration(step)]));
      if (step.state !== 'Running' || step.request_cancel || taskCancelRequested) {
        info.appendChild(this.#CreateCardLine(
            null, 'attempt-detail-item',
            ['attempt-detail-label', 'attempt-detail-value'],
            ['Exit Code', this.#ExitCodeLabel(step)]));
      }
      // CPU cores and load — only when running
      if (step.state === 'Running') {
        const coresList = document.createElement('div');
        coresList.classList.add('cores-list');
        step.executor_data?.cores.forEach(core => {
            const chip = document.createElement('div');
            chip.classList.add('core-chip');
            chip.textContent = core;
            coresList.appendChild(chip);
        });
        info.appendChild(this.#CreateCardLine(
            null, 'attempt-detail-item',
            ['attempt-detail-label', 'attempt-detail-value'],
            ['Cores', coresList]
        ));
        let loadMemory = '';
        let loadCores  = '';
        if (step.executor_data?.os_load) {
          loadMemory = 'MEM:' + step.executor_data.os_load.memory + ' %';
          const cpuLoad = step.executor_data.os_load.cores.reduce((a, b) => a + b, 0)
              / step.executor_data.os_load.cores.length;
          loadCores = 'CPU:' + cpuLoad + ' %';
        }
        info.appendChild(this.#CreateCardLine(
            null, 'attempt-detail-item',
            ['attempt-detail-label', 'attempt-detail-value', 'attempt-detail-value'],
            ['Load', loadMemory, loadCores]
        ));
      }
      details.appendChild(info);

      const action = document.createElement('div');
      action.classList.add('card-attempt-details-action');

      const actionLabel = document.createElement('div');
      actionLabel.classList.add('card-attempt-detail-label');
      actionLabel.textContent = 'Action';
      action.appendChild(actionLabel);

      const logsButton = document.createElement('button');
      logsButton.classList.add('card-attempt-logs-btn');
      logsButton.textContent = 'Logs';
      logsButton.onclick = () => { this.#OpenLogs(step, taskName); };

      action.appendChild(logsButton);

      if (step.state === 'Running' && !step.request_cancel && !taskCancelRequested) {
        const cancelButton = document.createElement('button');
        cancelButton.classList.add('card-attempt-cancel-btn');
        cancelButton.textContent = 'Cancel';
        cancelButton.onclick = async () => {
            if (!confirm(`Cancel step "${step.name}" ?`)) {
              return;
            }
            await this.#CancelStep(step.task_id, step.uuid); 
        };
        action.appendChild(cancelButton);
      }
      details.appendChild(action);
    }
    div.appendChild(details);

    // Monitor message — shown when available and step not pending
    if (step.state !== 'Pending' && step?.message_from_run) {
      const monitor = document.createElement('div');
      monitor.classList.add('card-attempt-details');
      monitor.appendChild(this.#CreateCardLine(
          null, 'attempt-detail-item',
          ['attempt-detail-label', 'attempt-detail-value-monitor'],
          ['Monitor', step.message_from_run]
      ));
      div.appendChild(monitor);
    }

    return div;
  }


  #CreateStepsCard(steps, taskName, taskCancelRequested) { 
    /*const div = document.createElement('div'); 
    div.innerText = `**** ${steps} ${taskName} ${taskCancelRequested}`
    return div;*/
    const div = document.createElement('div');
    div.classList.add('card-step-running');

    // Configuration id — hidden when default ('.')
    if (steps[0].id !== '' && steps[0].id !== '.') {
      div.appendChild(this.#CreateCardLine(
          null, 'step-name',
          ['step-attempts-detail-name', 'step-value-id'],
          ['Configuration', steps[0].id]
      ));
    }

    if (steps[0].timeout > 0) {
      div.appendChild(this.#CreateCardLine(
          null, ['step-attempts-detail', 'step-attempts-detail-end'],
          ['step-attempts-detail-name', 'step-attempts-detail-value'],
          ['Timeout', this.#TimeoutLabel(steps[0].timeout)]
      ));
    }

    if (steps.length > 1) {
      div.appendChild(this.#CreateCardLine(
          null, ['step-attempts-detail', 'step-attempts-detail'],
          ['step-attempts-detail-name', 'step-attempts-detail-value'],
          ['NB Attempts', steps.length]
      ));

      const counts = steps.reduce((acc, step) => {
          switch ((step.state || '').toLowerCase()) {
            case 'pending':   acc.pending++;   break;
            case 'running':   acc.running++;   break;
            case 'timedout':  acc.timedout++;  break;
            case 'cancelled': acc.cancelled++; break;
            case 'done': step.exit_code === 0 ? acc.done++ : acc.fail++; break;
          }
          return acc;
          }, { pending: 0, running: 0, timedout: 0, cancelled: 0, done: 0, fail: 0 });

      const summary = Object.entries(counts)
          .filter(([, v]) => v > 0)
          .map(([k, v]) => `${k}:${v}`)
          .join(' ');
      div.appendChild(this.#CreateCardLine(
          null, ['step-attempts-detail', 'step-attempts-detail-end'],
          ['step-attempts-detail-name', 'step-attempts-detail-value'],
          ['', summary]
      ));
    }

    if (Object.keys(steps[0].args).length) {
      div.appendChild(this.#CreateCardLine(
          null, 'step-attempts-detail',
          ['step-attempts-detail-name'], 
          ['Arguments:']
      ));
      const argEntries = Object.entries(steps[0].args);
      argEntries.forEach(([key, value], index) => {
          const style = index === argEntries.length - 1
              ? ['step-attempts-detail', 'step-attempts-detail-end']
              : 'step-attempts-detail';
          div.appendChild(this.#CreateCardLine(
              null, style,
              ['step-attempts-detail-name', 'step-attempts-detail-value'],
              ['', key + ': ' + value]
          ));
      });
    }

    steps.forEach(step => {
        div.appendChild(this.#CreateAttemptCard(step, taskName, taskCancelRequested));
    });

    return div;
  }

  // ── Private — API calls ──────────────────────────────────────

  async #CancelTask(taskID) {
    this.#DisableUI();

    let response = await fetch(
        `http://${window.location.host}/api/task/${taskID}`,
        { method: 'DELETE' }
    );
    let data = { success: false };
    if (response.ok) {
      data = await response.json();
    }

    this.#EnableUI();

    //if (data.success) {
      await this.#onRefresh();
    //}
  }

  async #CancelStep(taskID, stepUUID) {
    this.#DisableUI();

    let response = await fetch(
        `http://${window.location.host}/api/task/${taskID}/step/${stepUUID}`,
        { method: 'DELETE' }
    );
    let data = { success: false };
    if (response.ok) {
      data = await response.json();
    }

    this.#EnableUI();
    //if (data.success) {
      await this.#onRefresh();
    //}
  }

  // ── Private — log retrieval ──────────────────────────────────

  async #RetrieveStepLogs(logsInfos, type, size) {
    const taskID = logsInfos.step.task_id;
    const stepUUID = logsInfos.step.uuid;
    const stepID = this.#StepID(logsInfos.step);

    console.log('query');
    var response = await fetch(
        `http://${window.location.host}/api/task/${taskID}/${stepUUID}/${stepID}/output/${type}/${size}/${logsInfos[type].lastoffset}`, 
        { signal: logsInfos.abortController.signal });

    if (!response.ok) {
      return [false, 0, null];
    }
    var data = await response.json();
    if (!data.success) {
      return [false, 0, null];
    }

    logsInfos[type].state = data.state;
    logsInfos[type].supportSeek = data.support_seek;
    logsInfos[type].startOffset = data.start_offset;
    if (data.support_seek) {
      logsInfos[type].lastoffset += data.size;
    }

    return [true, data.state, atob(data.data)];
  }

  async #RetrieveFullStepLogs(logsInfos, size) {
    if (logsInfos.timerID != null) {
      window.clearTimeout(logsInfos.timerID);
      logsInfos.timerID = null;
    }
    if (logsInfos.abortController != null) {
      logsInfos.abortController.abort();
    }
    logsInfos.abortController = new AbortController();

    const type = logsInfos.type;
    const channel = logsInfos[type];

    var success = true;
    var state = FileReadState.Ok;
    var data;
    while(success && (state === FileReadState.Ok)) {
      const wasLive = !channel.supportSeek;

      try {
        [success, state, data] = await this.#RetrieveStepLogs(logsInfos, type, size);
      } catch(error) {
        return [false, 0, null];
      }

      if (!success || data.length === 0) {
        break;
      }

      if (wasLive && logsInfos[type].supportSeek) {
        logsInfos[type].terminal.SetText("");
        logsInfos[type].decoder = new TextDecoder("utf-8");
        logsInfos[type].lastoffset = 0;
        [success, state, data] = await this.#RetrieveStepLogs(logsInfos, type, size);
        if (!success || data.length === 0) break;
      }

      console.log('update', data.length);

      const decoded = channel.decoder.decode(
          Uint8Array.from(data, c => c.charCodeAt(0)),
          { stream: state === FileReadState.Ok }
      );

      if (channel.supportSeek) {
        //document.getElementById(`${type}-content`).innerText += 
        channel.terminal.AppendText(decoded);
      } else  {
        //document.getElementById(`${type}-content`).innerText = 
        channel.terminal.SetText(decoded);
      }
    }
    if ((!channel.supportSeek) || (state !== FileReadState.EndOfFile)) {
      logsInfos.timerID = window.setTimeout(() => this.#RetrieveFullStepLogs(logsInfos, size), 5000);
    }
  }

  async #OpenLogs(step, taskName) {
    const id = step.task_id + '-' + step.uuid;
    if (this.#logsInfos.id !== id) {
      if (this.#logsInfos.timerID != null) {
        window.clearTimeout(this.#logsInfos.timerID);
      }
      if (this.#logsInfos.abortController != null) {
        this.#logsInfos.abortController.abort();
      }
      this.#logsInfos.timerID         = null;
      this.#logsInfos.abortController = null;
      this.#logsInfos.id              = id;
      this.#logsInfos.step            = step;
      this.#logsInfos.type            = 'stdout';
      for (const type of ['stdout', 'stderr']) {
        this.#logsInfos[type].terminal.SetText('');
        this.#logsInfos[type].decoder     = new TextDecoder('utf-8');
        this.#logsInfos[type].lastoffset  = 0;
        this.#logsInfos[type].state       = 0;
        this.#logsInfos[type].supportSeek = true;
        this.#logsInfos[type].startOffset = 0;
      }
    }

    let stepName = step.name;
    if (step.id !== '' && step.id !== '.') stepName += ` ${step.id}`;
    stepName += ` (${taskName})`;

    // Activate current tab, deactivate the other
    const active = this.#logsInfos.type;
    const inactive = active === 'stdout' ? 'stderr' : 'stdout';
    this.#logButtons[active].classList.add('active');
    this.#containers[active].classList.add('active');
    this.#contents[active].classList.add('active');
    this.#logButtons[inactive].classList.remove('active');
    this.#containers[inactive].classList.remove('active');
    this.#contents[inactive].classList.remove('active');

    this.#modalStepName.innerText = stepName;
    this.#modal.classList.add('show');

    await this.#RetrieveFullStepLogs(this.#logsInfos, 10000000);
  }
}
