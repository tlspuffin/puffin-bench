import { logsManager } from './logsmanager.js';
import { Clipboard } from './clipboard.js';
import { DropMenu } from './dropmenu.js';

// The published results of a task (publish_link: the Results page at #<task id>), with its commit (&commit=<sha>):
// Results shows the card of the commit when the publisher keeps a newer task of the same libraries instead
export function ResultsLink(task) {
  const link = task?.publish_link || null;
  const commit = (task?.args ?? []).find(arg => arg.key === 'COMMIT_ID')?.value;
  if (!link || !/^[0-9a-f]{7,40}$/i.test(commit ?? '') || !/#[^#&=]+$/.test(link)) return link;
  return `${link}&commit=${commit}`;
}

export class TaskCard {

  // Options
  #onRefresh;
  #launchers;
  #describeTask;
  #describeMonitor;
  #task = null;  // task of the card being built (Create)
  #taskLinks = new Map();  // links of the card being built, gathered from its monitor summaries (see #CreateMonitor)

  /**
   * @param {object}   options
   * @param {function} [options.onRefresh]      — called after a cancel action
   * @param {function} [options.describeTask]   — async task -> { title, commit } HTML or null (see launchers.js)
   * @param {function} [options.describeMonitor] — (task, message) -> { summary HTML, level } or null: one-line summary
   *                                               of a step's monitor message (see launchers.js)
   */
  constructor(options = {}) {
    this.#onRefresh = options.onRefresh ?? (() => {});
    this.#launchers = options.launchers ??  [];
    this.#describeTask = options.describeTask ?? null;
    this.#describeMonitor = options.describeMonitor ?? null;

    DropMenu.CreateStyle({
      label: `
        ._dm_Label {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 26px;
          height: 26px;
          border-radius: 6px;
          color: #aaa;
          font-weight: bold;
          user-select: none;
          cursor: pointer;
          transition: background 0.2s, color 0.2s;
        }
        ._dm_Label:hover {
          background: rgba(255,255,255,0.08);
          color: #fff;
        }`,
      actions: `
        ._dm_Actions {
          width: max-content;
          position: absolute;
          right: 0px;
          display: flex;
          flex-direction: column;
          align-items: center;
          z-index: 8000;
          background: #2d2d2d;
          border: 1px solid #404040;
          border-radius: 10px;
          padding: 10px;
          box-shadow: 0 8px 24px rgba(0,0,0,0.45);
          gap: 8px;
        }`
    });
  }

  // ── Public ───────────────────────────────────────────────────

  // Where a task stands: 'cancelling', 'running' (a step runs), 'waiting' (started, the next steps wait for
  // cores), 'scheduled' (no step started yet) or 'done'; with its step counts and its estimated start
  static Status(task) {
    const steps = Object.values(task?.steps ?? {});
    const count = (state) => steps.filter(step => step.state === state).length;
    const pending = steps.filter(step => step.state === 'Pending');
    const starts = pending.map(step => step.estimated_start_time).filter(time => time > 0);
    const status = {
      total: steps.length,
      running: count('Running'),
      pending: pending.length,
      finished: steps.length - count('Running') - pending.length,
      start: starts.length > 0 ? Math.min(...starts) : 0,
      end: task?.estimated_end_time > 0 ? task.estimated_end_time : 0,
    };
    if (task?.request_cancel) status.state = 'cancelling';
    else if (status.running > 0) status.state = 'running';
    else if (status.pending === 0) status.state = 'done';
    else status.state = status.finished > 0 ? 'waiting' : 'scheduled';
    return status;
  }

  // "in 2h05" / "5 min ago"
  static #Relative(time) {
    const minutes = Math.round((time - Date.now()) / 60000);
    const abs = Math.abs(minutes);
    const text = abs < 60 ? `${abs} min` : `${Math.floor(abs / 60)}h${String(abs % 60).padStart(2, '0')}`;
    return minutes >= 0 ? `in ${text}` : `${text} ago`;
  }

  static #Time(time) {
    const date = new Date(time);
    const sameDay = date.toDateString() === new Date().toDateString();
    return sameDay ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : date.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  }

  // Top strip of a card: state, progress (steps), estimated start (scheduled) and end
  #CreateStatusStrip(task) {
    const status = TaskCard.Status(task);
    const strip = document.createElement('div');
    strip.className = `card-task-status card-task-status-${status.state}`;
    strip.dataset.help = 'task.status';
    const labels = {
      cancelling: '✖ CANCELLING', running: '▶ RUNNING', waiting: '⏸ WAITING FOR CORES',
      scheduled: '⏳ SCHEDULED', done: '✔ DONE'
    };
    const badge = document.createElement('span');
    badge.className = 'card-task-status-badge';
    badge.textContent = labels[status.state];
    strip.appendChild(badge);

    const times = document.createElement('span');
    times.className = 'card-task-status-times';
    const parts = [];
    if ((status.state === 'scheduled') && status.start) {
      parts.push(`starts ${TaskCard.#Time(status.start)} (${TaskCard.#Relative(status.start)})`);
    }
    if (status.end && (status.state !== 'done')) {
      parts.push(`ends ~${TaskCard.#Time(status.end)} (${TaskCard.#Relative(status.end)})`);
    }
    times.textContent = parts.join(' · ');
    times.dataset.clickTip = [status.start && (status.state === 'scheduled') && `estimated start: ${new Date(status.start).toLocaleString()}`,
        status.end && `estimated end: ${new Date(status.end).toLocaleString()}`].filter(Boolean).join('\n');
    strip.appendChild(times);

    const progress = document.createElement('div');
    progress.className = 'card-task-progress';
    progress.dataset.clickTip = `${status.finished} of ${status.total} steps finished, ${status.running} running, ${status.pending} pending`;
    const done = document.createElement('div');
    done.className = 'card-task-progress-done';
    done.style.width = `${status.total ? 100 * status.finished / status.total : 0}%`;
    const running = document.createElement('div');
    running.className = 'card-task-progress-running';
    running.style.width = `${status.total ? 100 * status.running / status.total : 0}%`;
    progress.append(done, running);
    const count = document.createElement('span');
    count.className = 'card-task-progress-count';
    count.textContent = `${status.finished}/${status.total}`;
    strip.append(progress, count);
    return { strip, status };
  }

  // Returns an HTMLElement for the full task — caller inserts it into the DOM
  // for the task page: the priority control and the cancellation of a running task, as on its card
  PriorityUI(task) { return this.#CreatePriorityUI(task); }
  async Cancel(taskID) { return this.#CancelTask(taskID); }

  Create(task) {
    this.#task = task;
    this.#taskLinks = new Map();
    const steps = this.#BuildSteps(task);

    const div = document.createElement('div');
    div.classList.add('card-task-running');
    if (task.request_cancel) {
      div.classList.add('card-task-cancelling');
    }
    const { strip, status } = this.#CreateStatusStrip(task);
    div.classList.add(`card-task-${status.state}`);
    div.dataset.taskState = status.state;
    div.appendChild(strip);

    let activeCount = 0;
    steps.forEach(byId => byId.forEach(attempts =>
      attempts.forEach(s => { if (s.state === 'Running' || s.state === 'Pending') activeCount++; })
    ));
    const taskRunning = (activeCount > 0) && (!task.request_cancel);

    const actions = [];
    if (taskRunning) {
      actions.push(this.#CreatePriorityUI(task));

      const cancelButton = document.createElement('button');
      cancelButton.classList.add('card-attempt-cancel-btn');
      cancelButton.dataset.help = 'task.cancel';
      cancelButton.textContent = 'Cancel';
      cancelButton.onclick = async () => {
          if (!confirm(`Cancel task "${task.name || task.id}" ?`)) {
            return;
          }
          await this.#CancelTask(task.id);
      };
      actions.push(cancelButton);
    }

    if (task?.launcher?.project) {
      const restartButton = document.createElement('button');
      restartButton.className = 'card-task-restart-btn';
      restartButton.dataset.help = 'task.launchagain';
      restartButton.textContent = 'New task ...';
      restartButton.onclick = (event) => {
        const launcherEntry = 
            this.#launchers.find(launcher => launcher.label === task.launcher.project);
        if (launcherEntry) {
          launcherEntry.open(task.launcher?.custom ?? null);
        }
      };
      actions.push(restartButton);
    }

    const dropmenu = (actions.length > 0) ? 
      (new DropMenu({label: '...', actions: actions, helpKey: 'task.menu'})).Get() : document.createElement('div');

    let username = '';
    if (task?.user && (task.user != '')) {
      username = task.user;
    }

    const divCardHeader = document.createElement('div');
    divCardHeader.id = 'card-task-header';
    // elements the project's description of the task replaces once resolved (see options.describeTask)
    const describeTargets = { title: null };
    let taskName = task.name;
    if (taskName === '') {
      taskName = task.id;
      divCardHeader.appendChild(this.#CreateCardLine(
        null, 'task-id',
        ['task-value-name', 'task-label-id', 'task-value-name'],
        [this.#CreateTaskLinks(task), 'Task ' + task.id, dropmenu]
      ));
      if (username != '') {
        divCardHeader.appendChild(this.#CreateCardLine(
          null, 'task-name',
          ['task-label-id', 'task-value-id'],
          ['User', username]
        ));
      }
    } else {
      const nameSpan = document.createElement('span');
      nameSpan.textContent = task.name;
      nameSpan.title = task.name;
      divCardHeader.appendChild(this.#CreateCardLine(
        null, 'task-id',
        ['task-value-name', 'task-value-name', 'task-value-name'],
        [this.#CreateTaskLinks(task), nameSpan, dropmenu]
      ));
      describeTargets.title = nameSpan;
      divCardHeader.appendChild(this.#CreateCardLine(
        null, 'task-name',
        ['task-label-id', 'task-value-id'],
        ['Task / User: ', task.id + ' / ' + username]
      ));
    }

    const separator = document.createElement('div');
    separator.classList.add('card-task-separator');
    divCardHeader.appendChild(separator);

    // the estimated start of a scheduled task is in its status strip
    if (task?.state === 'Running') {
      const nbCores = Object.values(task?.steps || {}).reduce((total, step) => {
          if (step?.state === 'Running') {
            return total + (step?.executor_data?.cores?.length || 0);
          }
          return total;
      }, 0);

      const taskLoad = task.executor_data?.os_load;
      // a task waiting for cores has no load of its own
      if (taskLoad && (nbCores > 0)) {
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
    // the estimated end of an unfinished task is in its status strip
    const isFinished = task?.state === 'Done' || task?.state === 'Cancelled';
    if (isFinished && (task?.estimated_end_time > 0)) {
      const label = 'End time';
      divCardHeader.appendChild(this.#CreateCardLine(
          null, 'task-est',
          ['task-est-label', 'task-est-value'],
          [label, new Date(task?.estimated_end_time).toLocaleString()]
      ));
      const separator2 = document.createElement('div');
      separator2.classList.add('card-task-separator');
      divCardHeader.appendChild(separator2);
    }

    // arguments: one line (warnings on their own lines), refined by the project's description of the task
    const argsBox = document.createElement('div');
    argsBox.className = 'card-task-args-box';
    divCardHeader.appendChild(argsBox);
    this.#RenderArgs(argsBox, task, null, false);
    if (this.#describeTask) {
      this.#describeTask(task).then(description => {
          const titled = Boolean(description?.title && describeTargets.title);
          if (titled) describeTargets.title.innerHTML = description.title;
          this.#RenderArgs(argsBox, task, description, titled);
      }).catch(() => {});
    }
    div.appendChild(divCardHeader);

    const divCardSteps = document.createElement('div');
    divCardSteps.id = 'card-task-steps';
    steps.forEach((byId, functionName) => {
      const divStep = document.createElement('div');
      divStep.classList.add('card-step');

      const divStepNameHeader = document.createElement('div');
      divStepNameHeader.classList.add('card-step-main-name');
      divStepNameHeader.style.cursor = 'pointer';
      divStepNameHeader.dataset.help = 'step.toggle';

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
        est.dataset.help = 'step.estimate';
        est.innerText = TaskCard.#Time(estimateStartTime);
        est.title = new Date(estimateStartTime).toLocaleString();
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

      // one square per attempt, colored by state: readable when the step is folded
      const squares = document.createElement('span');
      squares.className = 'card-step-squares';
      byId.forEach(attempts => attempts.forEach(attempt => {
          const square = document.createElement('span');
          square.className = `card-step-square state-${String(attempt.state).toLowerCase()}`;
          if ((attempt.state === 'Done') && (attempt.exit_code !== 0)) square.classList.add('failed');
          // highlighted by its monitor summary (e.g. objectives found): visible when the step is folded
          if (attempt.message_from_run && this.#describeMonitor) {
            try {
              const highlight = this.#describeMonitor(task, attempt.message_from_run)?.highlight;
              if (highlight) square.classList.add(`highlight-${highlight}`);
            } catch (error) {
              // no highlight
            }
          }
          square.title = `${attempt.id && attempt.id !== '.' ? attempt.id + ' ' : ''}attempt ${attempt.attempt_id}: ${attempt.state}`;
          squares.appendChild(square);
      }));
      divStepName.appendChild(squares);

      const iconSpan = document.createElement('span');
      iconSpan.className = 'card-step-toggle';
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
      divStep.dataset.active = hasRunning ? 'true' : 'false';
      if (!hasRunning) {
        divStep.classList.add('collapsed');
        iconSpan.innerText = '➕';
      }
      divCardSteps.appendChild(divStep);
    });
    div.appendChild(divCardSteps);

    this.#RenderTaskLinks(strip);
    return div;
  }

  // Buttons of the task's state strip gathered from the monitor summaries of its attempts (taskLink: e.g. the live
  // objectives page with the objectives of every running attempt)
  #RenderTaskLinks(strip) {
    if (this.#taskLinks.size === 0) return;
    const box = document.createElement('div');
    box.className = 'card-task-links-strip';
    for (const link of this.#taskLinks.values()) {
      const button = document.createElement(link.url ? 'a' : 'span');
      button.className = `card-task-link-badge ${link.highlight ? `highlight-${link.highlight}` : ''}`;
      button.textContent = String(link.label ?? '').replace('{count}', link.count.toLocaleString('en-US'));
      button.title = link.title ?? '';
      if (link.url) {
        button.href = link.url;
        button.target = '_blank';
        button.rel = 'noopener';
      }
      // a page written later (e.g. the final objectives report): shown as pending, without link, until it exists
      if (link.url && link.pending) {
        TaskCard.#PageExists(link.url).then(exists => {
          if (exists) return;
          button.removeAttribute('href');
          button.textContent = String(link.pending.label ?? '').replace('{count}', link.count.toLocaleString('en-US'));
          button.title = link.pending.title ?? '';
        });
      }
      box.appendChild(button);
    }
    strip.appendChild(box);
  }

  // url -> { time, promise of whether the page exists }: a page found stays found, a missing one is asked again
  // after a minute (the cards are redrawn at every refresh of the board)
  static #pages = new Map();

  static #PageExists(url) {
    const known = TaskCard.#pages.get(url);
    if (known && (known.exists || (Date.now() - known.time < 60000))) return known.promise;
    const entry = { time: Date.now(), exists: false };
    // GET: the publisher answers 404 to HEAD even for an existing page
    entry.promise = fetch(url, { cache: 'no-store' })
        .then(response => { entry.exists = response.ok; return response.ok; })
        // no answer: keep the link rather than claim the report is missing
        .catch(() => { entry.exists = true; return true; });
    TaskCard.#pages.set(url, entry);
    return entry.promise;
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
      if (duration >= 3600) {
        return `${Math.floor(duration / 3600)}h${String(Math.floor(duration / 60) % 60).padStart(2, '0')}`;
      }
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
          element.textContent = info;
        }
        element.classList.add('card-'+style[index]);
        div.appendChild(element);
    });
    return div;
  }

  // Task arguments in one line: "KEY=value · …", a bare value for the keys the project marks so (PACKAGE:
  // "tlspuffin"), warnings on their own lines; the full values in the hovers.
  // description (see options.describeTask): { commit, args: { KEY: { bare, level: 'warning', label, hidden } } };
  // titled: the title shows the commit line, so COMMIT_ID is not repeated
  #RenderArgs(container, task, description, titled) {
    container.replaceChildren();
    const options = description?.args ?? {};
    const line = document.createElement('div');
    line.className = 'card-task-args-line';
    const shorten = (text, max = 60) => text.length > max ? text.slice(0, max - 1) + '…' : text;
    for (const arg of task.args ?? []) {
      const option = options[arg.key] ?? {};
      if (option.hidden || ((arg.key === 'COMMIT_ID') && titled)) {
        continue;
      }
      if (option.level === 'warning') {
        const warning = document.createElement('div');
        warning.className = 'card-task-args-warning';
        warning.textContent = `⚠️ ${option.label ?? arg.key}: ${arg.value}`;
        container.appendChild(warning);
        continue;
      }
      const item = document.createElement('span');
      item.className = 'card-task-arg';
      item.title = `${arg.key}=${arg.value}`;
      if ((arg.key === 'COMMIT_ID') && description?.commit) {
        item.innerHTML = description.commit;
      } else {
        item.textContent = option.bare ? shorten(arg.value) : `${arg.key}=${shorten(arg.value)}`;
      }
      if (line.childElementCount > 0) line.append(' · ');
      line.appendChild(item);
    }
    if (line.childElementCount > 0) container.appendChild(line);
    container.hidden = container.childElementCount === 0;
  }

  #CreateAttemptCard(step, taskName, taskCancelRequested) {
    /*const div = document.createElement('div');
    div.innerText = `**** ${step} ${taskName} ${taskCancelRequested}`
    return div;*/
    const div = document.createElement('div');
    div.classList.add('card-attempt-item', `state-${step.state.toLowerCase()}`);

    // one line per attempt: name, state and duration (running: cores and load too), logs; PID in the hover
    div.classList.add('card-attempt-compact');
    const label = document.createElement('span');
    label.className = 'card-attempt-compact-name';
    label.textContent = step.nb_retry > 1 ? `Attempt ${step.attempt_id}` : step.state;
    if (step.state === 'Running') div.classList.add('card-attempt-running');
    const info = document.createElement('span');
    info.className = 'card-attempt-compact-info';
    if (step.state === 'Running') {
      const cancelling = step.request_cancel || taskCancelRequested;
      const parts = [`${cancelling ? '✖ cancelling · ' : '▶ '}${this.#Duration(step)}`];
      const cores = step.executor_data?.cores ?? [];
      if (cores.length > 0) parts.push(`${cores.length} core${cores.length > 1 ? 's' : ''}`);
      // the load is executor-wide (header, task Load line): in the hover only
      const osLoad = step.executor_data?.os_load;
      const cpu = osLoad ? Math.round(osLoad.cores.reduce((a, b) => a + b, 0) / Math.max(1, osLoad.cores.length)) : null;
      info.textContent = parts.join(' · ');
      info.dataset.clickTip = `PID ${step.executor_data?.pid || 'N/A'}` + (cores.length ? `, cores ${cores.join(',')}` : '') +
          (osLoad ? `; executor load MEM ${osLoad.memory}%, CPU ${cpu}%` : '');
      const logsButton = document.createElement('button');
      logsButton.classList.add('card-attempt-logs-btn');
      logsButton.dataset.help = 'step.logs';
      logsButton.textContent = 'Logs';
      logsButton.onclick = () => { logsManager.Open(step, taskName); };
      const link = this.#CreateRunPathLink(step);
      div.append(label, info);
      if (link) div.appendChild(link);
      div.appendChild(logsButton);
      if (!step.request_cancel && !taskCancelRequested) {
        const cancelButton = document.createElement('button');
        cancelButton.classList.add('card-attempt-cancel-btn');
        cancelButton.dataset.help = 'step.cancel';
        cancelButton.textContent = 'Cancel';
        cancelButton.onclick = async () => {
            if (!confirm(`Cancel step "${step.name}" ?`)) {
              return;
            }
            await this.#CancelStep(step.task_id, step.uuid);
        };
        div.appendChild(cancelButton);
      }
    } else if (step.state === 'Pending') {
      info.dataset.help = 'step.estimate';
      info.textContent = (step.nb_retry > 1 ? 'Pending' : '') + ((step.estimated_start_time > 0)
          ? ` starts ${TaskCard.#Time(step.estimated_start_time)}` : '');
      div.append(label, info);
    } else {
      const exit = this.#ExitCodeLabel(step);
      info.textContent = `${step.nb_retry > 1 ? step.state + ' · ' : ''}${this.#Duration(step)}` +
          ((exit === 0) ? '' : ` · exit ${exit}`);
      info.dataset.clickTip = `PID ${step.executor_data?.pid || 'N/A'}, exit code ${exit}`;
      const logsButton = document.createElement('button');
      logsButton.classList.add('card-attempt-logs-btn');
      logsButton.dataset.help = 'step.logs';
      logsButton.textContent = 'Logs';
      logsButton.onclick = () => { logsManager.Open(step, taskName); };
      const link = this.#CreateRunPathLink(step);
      div.append(label, info);
      if (link) div.appendChild(link);
      div.appendChild(logsButton);
    }
    if (step?.message_from_run && step.state !== 'Pending') {
      div.appendChild(this.#CreateMonitor(step.message_from_run, div));
    }
    return div;
  }

  // Monitor message of an attempt: one line (the project's summary, or the first line of the message), the full
  // message on click
  // attempt: the attempt's element, highlighted when the summary asks for it (e.g. objectives found)
  #CreateMonitor(message, attempt = null) {
    const monitor = document.createElement('div');
    monitor.className = 'card-attempt-monitor';
    let description = null;
    try {
      description = this.#describeMonitor?.(this.#task, message) ?? null;
    } catch (error) {
      description = null;
    }
    if (description?.highlight && attempt) {
      attempt.classList.add('card-attempt-highlight', `highlight-${description.highlight}`);
    }
    const taskLink = description?.taskLink;
    if (taskLink?.key) {
      const known = this.#taskLinks.get(taskLink.key);
      if (known) {
        known.count += taskLink.count ?? 0;
        known.url ??= taskLink.url;
      } else {
        this.#taskLinks.set(taskLink.key, { ...taskLink, count: taskLink.count ?? 0 });
      }
    }
    const summary = document.createElement('div');
    summary.className = 'card-attempt-monitor-summary';
    summary.dataset.help = 'step.monitor';
    if (description?.level) summary.classList.add(`level-${description.level}`);
    const text = document.createElement('span');
    if (description?.summary) {
      text.innerHTML = description.summary;
    } else {
      text.textContent = message.split('\n').map(line => line.trim()).find(line => line) ?? '';
    }
    const toggle = document.createElement('span');
    toggle.className = 'card-attempt-monitor-toggle';
    toggle.textContent = '▸';
    summary.append(toggle, text);
    const full = document.createElement('pre');
    full.className = 'card-attempt-monitor-full';
    full.hidden = true;
    full.textContent = (description?.text ?? message).trimEnd();
    summary.onclick = (event) => {
      if (event.target.closest('a')) return;
      full.hidden = !full.hidden;
      toggle.textContent = full.hidden ? '▸' : '▾';
    };
    monitor.append(summary, full);
    return monitor;
  }

  #CreateStepsCard(steps, taskName, taskCancelRequested) {
    /*const div = document.createElement('div');
    div.innerText = `**** ${steps} ${taskName} ${taskCancelRequested}`
    return div;*/
    const div = document.createElement('div');
    div.classList.add('card-step-running');

    // one line: configuration, timeout, attempts by state
    const parts = [];
    if (steps.length > 1) {
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
      parts.push(`${steps.length} attempts: ` + Object.entries(counts)
          .filter(([, v]) => v > 0)
          .map(([k, v]) => `${k} ${v}`)
          .join(', '));
    }
    if (steps[0].timeout > 0) {
      parts.push(`timeout ${this.#TimeoutLabel(steps[0].timeout)}`);
    }
    // the step arguments, KEY=value
    Object.entries(steps[0].args ?? {}).forEach(([key, value]) => parts.push(`${key}=${value}`));
    const hasId = steps[0].id !== '' && steps[0].id !== '.';
    if (hasId || parts.length > 0) {
      const line = document.createElement('div');
      line.className = 'card-step-summary';
      if (hasId) {
        const id = document.createElement('span');
        id.className = 'card-step-value-name';
        id.textContent = steps[0].id;
        line.appendChild(id);
      }
      const rest = document.createElement('span');
      rest.textContent = parts.join(' · ');
      line.appendChild(rest);
      div.appendChild(line);
    }

    steps.forEach(step => {
        div.appendChild(this.#CreateAttemptCard(step, taskName, taskCancelRequested));
    });

    return div;
  }

  #CreatePriorityUI(task) {
    const div = document.createElement('div');
    div.className = 'card-task-priority';
    if (task.priority === undefined) {
      div.innerText = 'N/A';
      return div;
    }

    div.dataset.help = 'task.priority';

    const label = document.createElement('div');
    label.className = 'card-priority-label';
    label.innerText = 'priority'
    div.appendChild(label);

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
    div.appendChild(input);

    const button = document.createElement('button');
    button.className = 'card-priority-set-btn';
    button.innerText = 'Set'
    div.appendChild(button);

    return div;
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
          `http://${window.location.host}/api/task/${taskID}/priority/${newPriority}`,
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

  #CreateTaskLinks(task) {
    const div = document.createElement('div');
    div.className = 'card-task-links';
    div.append(this.#CreateTaskQuickLink(task.id));
    const publishLink = ResultsLink(task);
    if (publishLink) {
      div.append(this.#CreatePublishQuickLink(publishLink));
    }
    return div;
  }

  #CreateTaskQuickLink(id) {
    const link = document.createElement('p');
    link.classList = 'card-run-path-details';
    link.innerText = '🔗';
    link.dataset.help = 'task.quicklink';
    link.dataset.url = `${window.location.origin}/files/board/task.html?id=${id}`;
    // click: copy the link of the task page; Cmd/Ctrl+click or middle click: open it in a new tab
    link.onclick = async (event) => {
      event.stopPropagation();
      if (event.metaKey || event.ctrlKey) {
        window.open(event.currentTarget.dataset.url, '_blank', 'noopener');
        return;
      }
      Clipboard.Set(event.currentTarget.dataset.url);
    }
    link.onauxclick = (event) => {
      if (event.button !== 1) return;
      event.preventDefault();
      event.stopPropagation();
      window.open(event.currentTarget.dataset.url, '_blank', 'noopener');
    }
    return link;
  }

  #CreatePublishQuickLink(publishLink) {
    const link = document.createElement('p');
    link.classList = 'card-run-path-details';
    link.innerText = '🗂️';
    link.dataset.help = 'task.publishlink';
    link.dataset.url = publishLink;
    link.onclick = (event) => {
      event.stopPropagation();
      Clipboard.Set(event.currentTarget.dataset.url);
      window.open(event.currentTarget.dataset.url, '_blank');
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
    link.dataset.help = 'task.steprunpath';
    link.dataset.url = step?.executor_data?.run_path ?? '';
    link.onclick = async (event) => {
      event.stopPropagation();
      Clipboard.Set(event.currentTarget.dataset.url);
    }
    return link;
  }

}
