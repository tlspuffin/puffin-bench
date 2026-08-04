import { logsManager } from './logsmanager.js';
import { Clipboard } from './clipboard.js';

export class TaskCard {

  // Options
  #onRefresh;

  /**
   * @param {object}   options
   * @param {function} [options.onRefresh]      — called after a cancel action
   */
  constructor(options = {}) {
    this.#onRefresh = options.onRefresh ?? (() => {});
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

    const priorityUI = activeCount > 0 ? this.#CreatePriorityUI(task) : document.createElement('div');

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
        ['task-value-name', 'task-label-id', 'task-value-name', 'task-value-name'],
        [this.#CreateTaskQuickLink(task), 'Task ' + task.id, priorityUI, cancelButton]
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
        ['task-value-name', 'task-value-name', 'task-value-name', 'task-value-name'],
        [this.#CreateTaskQuickLink(task), task.name, priorityUI, cancelButton]
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

    if (task?.state === 'Pending') {
      let estimateStartTime = 18446744073709551615;
      for(let step of task?.root_steps) {
        if (task?.steps[step].estimated_start_time < estimateStartTime) {
          estimateStartTime = task?.steps[step].estimated_start_time;
        }
      }
      if (estimateStartTime == 18446744073709551615) {
        estimateStartTime = 0;
      }
      if (estimateStartTime > 0) {
        divCardHeader.appendChild(this.#CreateCardLine(
          null, 'task-est',
          ['task-est-label', 'task-est-value'],
          ['Estimated start time', new Date(estimateStartTime).toLocaleString()]
        ));
        const separator2 = document.createElement('div');
        separator2.classList.add('card-task-separator');
        divCardHeader.appendChild(separator2);
      }
    }
    else if (task?.state === 'Running') {
      const nbCores = Object.values(task?.steps || {}).reduce((total, step) => {
          if (step?.state === 'Running') {
            return total + (step?.executor_data?.cores?.length || 0);
          }
          return total;
      }, 0);

      const taskLoad = task.executor_data?.os_load;
      if (taskLoad) {
        divCardHeader.appendChild(this.#CreateCardLine(
          null, 'task-loads',
          ['task-loads-label', 'task-loads-value', 'task-loads-value'],
          ['Load', `Mem ${taskLoad.memory} %`, `CPU  ${taskLoad.cores} % on ${nbCores} cores`]
        ));
        const separator2 = document.createElement('div');
        separator2.classList.add('card-task-separator');
        divCardHeader.appendChild(separator2);
      }
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

      const divStepNameHeader = document.createElement('div');
      divStepNameHeader.classList.add('card-step-main-name');
      divStepNameHeader.style.cursor = 'default';

      const divStepName = document.createElement('div');
      divStepName.classList = 'card-attempt-header';
      const nameSpan = document.createElement('span');
      nameSpan.innerText = functionName;
      divStepName.appendChild(nameSpan);

      let estimateStartTime = 18446744073709551615;
      for (const attempts of byId.values()) {
        for (const attemp of attempts) {
          if (attemp.state !== 'Pending') {
            estimateStartTime = 0;
          } else if (attemp.estimated_start_time < estimateStartTime) {
            estimateStartTime = attemp.estimated_start_time;
          }
          if (estimateStartTime == 0) {
            break;
          }
        }
        if (estimateStartTime == 0) {
          break;
        }
      }
      if (estimateStartTime == 18446744073709551615) {
        estimateStartTime = 0;
      }
      if (estimateStartTime > 0) {
        const est = document.createElement('div');
        est.innerText = new Date(estimateStartTime).toLocaleString();
        divStepName.appendChild(est);
      }

      let size = 0;
      byId.forEach(attempts => size += attempts.length);
      if (size == 1) {
        const [ step ] = byId.values().next().value;
        const link = this.#CreateRunPathLink(step)
        if (link !== null) {
          divStepName.appendChild(link);
        }
      }

      const iconSpan = document.createElement('span');
      iconSpan.innerText = '➖';
      divStepNameHeader.appendChild(divStepName);
      divStepNameHeader.appendChild(iconSpan);
      divStepNameHeader.onclick = () => {
          divStep.classList.toggle('collapsed');
          iconSpan.innerText = divStep.classList.contains('collapsed') ? '➕' : ' ➖';
      };
      divStep.appendChild(divStepNameHeader);

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
      const link = this.#CreateRunPathLink(step);
      div.appendChild(this.#CreateCardLine(
          null, 'attempt-header',
          ['attempt-name', 'run-path'],
          [`Attempt ${step.attempt_id}`, link ?? ""]
      ));
    }

    const details = document.createElement('div');
    details.classList.add('card-attempt-details');

    if (step.state === 'Pending') {
      const estimateStartTime = ((step.estimated_start_time !== undefined) && (step.estimated_start_time > 0)) ? 
          new Date(step.estimated_start_time).toLocaleString() : 'N/A';
      details.appendChild(this.#CreateCardLine(
          null, 'attempt-detail-item',
          ['attempt-detail-value-state', 'attempt-detail-value-state'],
          ['Pending', estimateStartTime]
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
      logsButton.onclick = () => { logsManager.Open(step, taskName); };

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

  #CreatePriorityUI(task) {
    if (task.priority === undefined) {
      const div = document.createElement('div');
      div.innerText = 'N/A';
      return div;
    }

    const input = document.createElement('input');
    input.type = 'number';
    input.classList.add('card-priority-input');
    input.step = 1;
    input.value = task.priority;

    input.onclick = (event) => event.stopPropagation();
    input.onchange = async (event) => {
      event.stopPropagation();
      const newPriority = Math.round(Number(input.value));
      input.value = newPriority;
      if (newPriority === task.priority) {
        return;
      }
      await this.#TaskUpdatePriority(task.id, newPriority);
    };
    input.onkeydown = (event) => {
      if (event.key === 'Enter') {
        input.blur();
      }
    };

    return input;
  }

  // ── Private — API calls ──────────────────────────────────────

  async #CancelTask(taskID) {
    this.#DisableUI();

    try {
      let response = await fetch(
          `http://${window.location.host}/api/task/${taskID}`,
          { method: 'DELETE' }
      );
      let data = { success: false };
      if (response.ok) {
        data = await response.json();
      }
    } catch(e) {}

    this.#EnableUI();

    //if (data.success) {
      await this.#onRefresh();
    //}
  }

  async #CancelStep(taskID, stepUUID) {
    this.#DisableUI();

    try {
      let response = await fetch(
          `http://${window.location.host}/api/task/${taskID}/step/${stepUUID}`,
          { method: 'DELETE' }
      );
      let data = { success: false };
      if (response.ok) {
        data = await response.json();
      }
    } catch(e) {}

    this.#EnableUI();
    //if (data.success) {
      await this.#onRefresh();
    //}
  }

  async #TaskUpdatePriority(taskID, newPriority) {
    this.#DisableUI();

    try {
      let response = await fetch(
          `http://${window.location.host}/api/task/${taskID}/${newPriority}`,
          { method: 'PATCH' }
      );
      let data = { success: false };
      if (response.ok) {
        data = await response.json();
      }
    } catch(e) {}

    this.#EnableUI();
    await this.#onRefresh();
  }

  // ── Private — link helper ──────────────────────────────────

  #CreateTaskQuickLink(task) {
    const link = document.createElement('p');
    link.classList = 'card-run-path-details';
    link.innerText = '🔗';
    link.title = `${window.location.origin}/files/board/task.html?id=${task.id}`;
    link.onclick = async (event) => {
      event.stopPropagation();
      Clipboard.Set(event.currentTarget.title);
    }
    return link;
  }

  #CreateRunPathLink(step) {
    if (step?.state !== 'Running') {
      return null;
    }
    const link = document.createElement('p');
    link.classList = 'card-run-path-details';
    link.innerText = '📋';
    link.title = step?.executor_data?.run_path;
    link.onclick = async (event) => {
      event.stopPropagation();
      Clipboard.Set(event.currentTarget.title);
    }
    return link;
  }

}
