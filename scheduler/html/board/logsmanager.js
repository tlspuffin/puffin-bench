import { Terminal } from './terminal.js';

// COMMANDS: every command of the step (executor.sh, functions.sh StartCommandsTrace: logs/commands.<step>.txt). Its
// lines: "# …" headers, the variables of the step ("NAME=value", a value can span lines), then from "# commands:" one
// line per command, "+ <time> <function>:<line> <command>" with one + per nested level (a command substitution, the
// monitor's own bash), and the lines that continue a command of several lines (they belong to it: same colour, hidden
// with it). Shown as "<time> <function>:<line>  $ <command>", indented per level. meta: { commands (the commands
// part), internal (a command the filter hides, and its continuation lines) }
const ESC = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// the time is bash's EPOCHREALTIME, whose decimal separator follows the locale ("1791806668,758540" in French)
const TRACE = /^(\++) (\d+)[.,](\d+) (\S+) (.*)$/;
function CommandLine(raw, previous) {
  const m = TRACE.exec(raw);
  if (m) {
    const date = new Date(Number(m[2]) * 1000);
    const time = `${date.toTimeString().slice(0, 8)}.${m[3].slice(0, 3)}`;
    const indent = '  '.repeat(m[1].length - 1);
    const where = m[4].padEnd(28);
    return { text: `${time} ${where} ${indent}$ ${m[5]}`,
             html: `<span class="cmd-time">${time}</span> <span class="cmd-where">${ESC(where)}</span> ${indent}<span class="cmd-prompt">$</span> <span class="cmd-text">${ESC(m[5])}</span>`,
             meta: { commands: true, internal: IsInternal(m[5]) } };
  }
  if (raw.startsWith('# ')) {
    return { text: raw, html: `<span class="cmd-head">${ESC(raw)}</span>`,
             meta: { commands: raw.startsWith('# commands:') || !!previous?.commands, internal: false } };
  }
  // a line that continues a command
  if (previous?.commands) return { text: raw, html: `<span class="cmd-text">${ESC(raw)}</span>`, meta: previous };
  const v = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(raw);
  if (v) return { text: raw, html: `<span class="cmd-var">${ESC(v[1])}</span>=${ESC(v[2])}`, meta: { commands: false } };
  return { text: raw, html: ESC(raw), meta: { commands: false } };
}
// what "hide shell internals" hides: the commands of the shell itself that start nothing and set nothing outside it
// (tests, output, reading, local variables, control); assignments to shell variables. export, source, exec, eval,
// command, kill, wait, cd and every program stay.
const INTERNALS = new Set(['[', '[[', 'test', ':', 'true', 'false', 'echo', 'printf', 'read', 'readarray', 'mapfile',
  'local', 'declare', 'typeset', 'readonly', 'unset', 'return', 'break', 'continue', 'shift', 'set', 'shopt', 'let',
  '((', 'getopts', 'pushd', 'popd', 'dirs', 'caller', 'type', 'hash']);
function IsInternal(command) {
  if (/^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/.test(command)) return true;
  // the first word as the trace quotes it ('[' for [)
  return INTERNALS.has(command.split(/\s/, 1)[0].replace(/^'(.*)'$/, '$1'));
}

const FileReadState = Object.freeze({
  Error_Access: 0, Error_Open: 1, Error_OverFlow: 2,
  NotExecuted: 3, Ok: 4, EndOfFile: 5
});

class Output {
  terminal;
  decoder;
  lastoffset;
  state;
  supportSeek;
  partial;
  live;
  file_start_offset;
  startOffset;
  tab;
  container;
  content;
    constructor(containerID, tab, container, content) {
      this.terminal = new Terminal(containerID);
      this.decoder = new TextDecoder("utf-8");
      this.lastoffset = 0;
      this.state = 0;
      this.supportSeek = true;
      this.partial = 1;
      this.live = false;
      this.file_start_offset = 0;
      this.startOffset = 0;
      this.tab = tab;
      this.container = container;
      this.content = content;
    }

};

class LogsManager {
  static #modal = null;

  #timerID;
  #abortController;
  #id;
  #step;
  #type;
  #outputs;

  constructor() {
    const ui = this.#CreateModal();

    this.#timerID = null;
    this.#abortController = null;
    this.#id =  0;
    this.#step =  null;
    this.#type = 'stdout';
    this.#outputs = {
      'stdout' : new Output('stdout-container', ...ui.stdout),
      'stderr' : new Output('stderr-container', ...ui.stderr),
      'commands' : new Output('commands-container', ...ui.commands),
    }
    this.#outputs.commands.terminal.SetView({ format: CommandLine });
  }

  CloseModal() {
    if (this.#timerID != null) {
      window.clearTimeout(this.#timerID);
      this.#timerID = null;
    }
    if (this.#abortController != null) {
      this.#abortController.abort();
      this.#abortController = null;
    }
    LogsManager.#modal.div.classList.remove('show');
  }

  #StepID(step) {
    return step.step_id + '-' + step.rank_id + '-' + step.attempt_id;
  }

  #CreateModal() {
    if (LogsManager.#modal === null) {
      const modal = document.createElement('div');
      modal.classList.add('modal-overlay');
      modal.innerHTML = `
          <div class="modal-content">
            <div class="modal-header">
              <h3>Step Logs - <span id="step-name"></span></h3>
              <span class="modal-actions">
                <button class="modal-refresh" id="modal-refresh" title="Refresh the logs (Cmd/Ctrl+R)">🔄</button>
                <button class="modal-close" id="modal-close" title="Close (Esc)">&times;</button>
              </span>
            </div>
            <div class="modal-body">
              <div class="logs-tabs">
                <button class="tab-btn active" id="log-stdout">STDOUT</button>
                <button class="tab-btn"        id="log-stderr">STDERR</button>
                <button class="tab-btn"        id="log-commands" title="Every command of the step, with its time, its function and line, and first the variables of the step (its environment and the settings of its job)">COMMANDS</button>
                <label class="logs-filter" id="commands-filter" title="Hide the commands of the shell itself that start nothing and set nothing outside it: tests, echo/printf, read, local variables and assignments, return… export, source, exec and every program stay"><input type="checkbox" id="commands-internals"> hide shell internals</label>
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
                <div class="logs-container" id="commands-container">
                  <div class="logs-scroll-overlay" id="commands-scroll-overlay"></div>
                  <pre id="commands-content" class="commands"></pre>
                </div>
              </div>
            </div>
          </div>`;
      document.body.appendChild(modal);
      modal.addEventListener('wheel', e => e.preventDefault(), { passive: false });

      modal.querySelector(`#modal-close`).onclick = () => this.CloseModal();
      modal.querySelector(`#modal-refresh`).onclick = () => this.Refresh();
      // keys of the top bar (board/nav.js): Esc closes the logs, Cmd/Ctrl+R refreshes them instead of the page
      const shown = () => modal.classList.contains('show');
      window.addEventListener('pb-escape', (event) => {
        if ((event.detail?.layer !== 'modal') || event.defaultPrevented || !shown()) return;
        event.preventDefault();
        this.CloseModal();
      });
      window.addEventListener('pb-modal-refresh', (event) => {
        if (event.defaultPrevented || !shown()) return;
        event.preventDefault();
        this.Refresh();
      });
      LogsManager.#modal = {
        div: modal,
        stepName: modal.querySelector(`#step-name`),
        logsTabs: modal.getElementsByClassName('logs-tabs')[0],
        logsContent: modal.getElementsByClassName('logs-content')[0],
      };
      LogsManager.#modal.logsTabs.querySelector('#log-stdout').onclick = this.#SwitchOutput.bind(this, 'stdout');
      LogsManager.#modal.logsTabs.querySelector('#log-stderr').onclick = this.#SwitchOutput.bind(this, 'stderr');
      LogsManager.#modal.logsTabs.querySelector('#log-commands').onclick = this.#SwitchOutput.bind(this, 'commands');
      LogsManager.#modal.logsTabs.querySelector('#commands-internals').onchange = (event) =>
          this.#outputs.commands.terminal.SetView({ format: CommandLine, filter: event.target.checked ? (line => !line.meta?.internal) : null });
    }
    return {
        stdout: [ LogsManager.#modal.logsTabs.querySelector('#log-stdout'), 
            LogsManager.#modal.logsContent.querySelector('#stdout-container'), 
            LogsManager.#modal.logsContent.querySelector('#stdout-content') ],
        stderr: [ LogsManager.#modal.logsTabs.querySelector('#log-stderr'), 
            LogsManager.#modal.logsContent.querySelector('#stderr-container'), 
            LogsManager.#modal.logsContent.querySelector('#stderr-content') ],
        commands: [ LogsManager.#modal.logsTabs.querySelector('#log-commands'),
            LogsManager.#modal.logsContent.querySelector('#commands-container'),
            LogsManager.#modal.logsContent.querySelector('#commands-content') ]
    };
  }

  #SwitchOutput(newOutput) {
    const prev = this.#type;
    if (prev == newOutput) {
      return;
    }
    this.#type = newOutput;

    this.#UpdateActiveTab();

    if (this.#timerID != null) {
      window.clearTimeout(this.#timerID);
      this.#timerID = null;
    }
    this.#RetrieveFullStepLogs(10000000);
  }

  async #RetrieveStepLogs(type, size) {
    const taskID = this.#step.task_id;
    const stepUUID = this.#step.uuid;
    const stepID = this.#StepID(this.#step);

    var response = await fetch(
        `http://${window.location.host}/api/task/${taskID}/${stepUUID}/${stepID}/output/${type}/${size}/${this.#outputs[type].lastoffset}`,
        { signal: this.#abortController.signal });

    if (!response.ok) {
      return [false, 0, null];
    }
    var data = await response.json();
    if (!data.success) {
      return [false, 0, null];
    }

    this.#outputs[type].state = data.state;
    this.#outputs[type].supportSeek = data.support_seek === 1;
    this.#outputs[type].partial = data.partial === 1;
    this.#outputs[type].live = data.live === 1;
    this.#outputs[type].startOffset = data.start_offset;
    this.#outputs[type].file_start_offset = data.file_start_offset;
    if (data.support_seek) {
      if (this.#outputs[type].lastoffset != data.start_offset) {
        this.#outputs[type].decoder = new TextDecoder("utf-8");
      }
      this.#outputs[type].lastoffset = data.start_offset + data.size;
    }

    return [true, data.state, atob(data.data)];
  }

  async #RetrieveFullStepLogs(size) {
    if (this.#timerID != null) {
      window.clearTimeout(this.#timerID);
      this.#timerID = null;
    }
    if (this.#abortController != null) {
      this.#abortController.abort();
    }
    this.#abortController = new AbortController();

    const type = this.#type;
    const output = this.#outputs[type];

    var success = true;
    var state = FileReadState.Ok;
    var data;
    while(success && (state === FileReadState.Ok)) {
      const wasLive = output.live;

      try {
        [success, state, data] = await this.#RetrieveStepLogs(type, size);
      } catch(error) {
        if (error.name !== 'AbortError') {
          console.error('LogsManager: failed to fetch step logs, retrying', error);
          this.#timerID = window.setTimeout(() => this.#RetrieveFullStepLogs(size), 5000);
        }
        return [false, 0, null];
      }

      if (!success || data.length === 0) {
        break;
      }

      if (wasLive && (!this.#outputs[type].live)) {
        this.#outputs[type].terminal.SetText("");
        this.#outputs[type].decoder = new TextDecoder("utf-8");
        this.#outputs[type].lastoffset = 0;
        [success, state, data] = await this.#RetrieveStepLogs(type, size);
        if (!success || data.length === 0) {
          break;
        }
      }

      const decoded = output.decoder.decode(
          Uint8Array.from(data, c => c.charCodeAt(0)),
          { stream: state === FileReadState.Ok }
      );

      if (output.supportSeek) {
        output.terminal.AppendText(decoded);
      } else  {
        output.terminal.SetText(decoded);
      }
    }
    if (output.live || (state !== FileReadState.EndOfFile)) {
      this.#timerID = window.setTimeout(() => this.#RetrieveFullStepLogs(size), 5000);
    }
  }

  #UpdateFilesList() {
    this.#step.streams.forEach((file, index) => {
        const tab = document.createElement('button');
        tab.className = 'tab-btn';
        tab.id = `log-${index}`;
        tab.innerText = file.name;
        tab.onclick = this.#SwitchOutput.bind(this, index);
        LogsManager.#modal.logsTabs.insertBefore(tab, LogsManager.#modal.logsTabs.querySelector('#commands-filter'));
        const container = document.createElement('div');
        container.className = 'logs-container';
        container.id = `${index}-container`;
        container.innerHTML = `<div class="logs-scroll-overlay" id="${index}-scroll-overlay"></div>`;
        const content = document.createElement('pre');
        content.id = `${index}-content`;
        container.appendChild(content);
        LogsManager.#modal.logsContent.appendChild(container);
        this.#outputs[index] = new Output(`${index}-container`, tab, container, content);
    });
  }

  #UpdateActiveTab() {
    // the filter of the commands, with them only
    LogsManager.#modal.logsTabs.querySelector('#commands-filter').classList.toggle('shown', this.#type === 'commands');
    // Activate current tab, deactivate the other
    Object.keys(this.#outputs).forEach((type) => {
      if (this.#type == type) {
        this.#outputs[type].tab.classList.add('active');
        this.#outputs[type].container.classList.add('active');
        this.#outputs[type].content.classList.add('active');
      } else {
        this.#outputs[type].tab.classList.remove('active');
        this.#outputs[type].container.classList.remove('active');
        this.#outputs[type].content.classList.remove('active');
      }
    });
  }

  async Open(step, taskName) {
    const id = step.task_id + '-' + step.uuid;
    if (this.#id !== id) {
      if (this.#timerID != null) {
        window.clearTimeout(this.#timerID);
      }
      if (this.#abortController != null) {
        this.#abortController.abort();
      }
      this.#timerID         = null;
      this.#abortController = null;
      this.#id              = id;
      this.#step            = step;
      this.#type            = 'stdout';
      Object.keys(this.#outputs).forEach((type) => 
          { if ((type != 'stdout') && (type != 'stderr') && (type != 'commands')) { 
              LogsManager.#modal.logsTabs.removeChild(this.#outputs[type].tab);
              LogsManager.#modal.logsContent.removeChild(this.#outputs[type].container);
              this.#outputs[type].terminal.Destroy();
              delete this.#outputs[type] } 
          }
      );

      if ((step?.streams) && (step.streams.length > 0)) {
        this.#UpdateFilesList();
      }

      Object.keys(this.#outputs).forEach((type) => {
        this.#outputs[type].terminal.SetText('');
        this.#outputs[type].decoder     = new TextDecoder('utf-8');
        this.#outputs[type].lastoffset  = 0;
        this.#outputs[type].state       = 0;
        this.#outputs[type].supportSeek = true;
        this.#outputs[type].startOffset = 0;
        this.#outputs[type].live        = false;
        this.#outputs[type].partial     = 1;
      });
    }

    let stepName = step.name;
    if (step.id !== '' && step.id !== '.') stepName += ` ${step.id}`;
    stepName += ` (${taskName})`;

    LogsManager.#modal.stepName.innerText = stepName;
    LogsManager.#modal.div.classList.add('show');

    // a tab without content is grey and cannot be clicked: no click to find it empty, and an empty view is not a
    // display error; the first tab with content is shown
    const available = await this.#ProbeTabs(step);
    if (!available.includes(this.#type) && available.length) this.#type = available[0];
    this.#UpdateActiveTab();

    await this.#RetrieveFullStepLogs(10000000);
  }

  // Reload every output of the step from the start (and which ones have content), keeping the tab shown
  async Refresh() {
    if (!this.#step) return;
    const button = LogsManager.#modal.div.querySelector('#modal-refresh');
    button.classList.remove('spin');
    void button.offsetWidth;
    button.classList.add('spin');
    if (this.#timerID != null) {
      window.clearTimeout(this.#timerID);
      this.#timerID = null;
    }
    if (this.#abortController != null) {
      this.#abortController.abort();
      this.#abortController = null;
    }
    Object.values(this.#outputs).forEach((output) => {
      output.terminal.SetText('');
      output.decoder     = new TextDecoder('utf-8');
      output.lastoffset  = 0;
      output.state       = 0;
      output.supportSeek = true;
      output.startOffset = 0;
      output.live        = false;
      output.partial     = 1;
    });
    const available = await this.#ProbeTabs(this.#step);
    if (!available.includes(this.#type) && available.length) this.#type = available[0];
    this.#UpdateActiveTab();
    await this.#RetrieveFullStepLogs(10000000);
  }

  // Which outputs of the step have content (1 byte asked for each): the others are greyed out, with why in the hover
  async #ProbeTabs(step) {
    const stepID = this.#StepID(step);
    const types = Object.keys(this.#outputs);
    const results = await Promise.all(types.map(async type => {
      try {
        const response = await fetch(
            `http://${window.location.host}/api/task/${step.task_id}/${step.uuid}/${stepID}/output/${type}/1/0`,
            { cache: 'no-store' });
        const data = response.ok ? await response.json() : null;
        if (!data?.success) return [type, false, 'not available: not kept for this step (finished before it was archived), or never written'];
        if (!(data.filesize > 0)) return [type, false, data.live ? 'empty so far' : 'empty'];
        return [type, true, ''];
      } catch (error) {
        return [type, true, ''];  // unknown: leave it usable
      }
    }));
    for (const [type, ok, why] of results) {
      const tab = this.#outputs[type].tab;
      tab.disabled = !ok;
      tab.classList.toggle('empty', !ok);
      tab.dataset.baseTitle ??= tab.title;
      tab.title = ok ? tab.dataset.baseTitle : `${tab.textContent}: ${why}`;
    }
    return results.filter(([, ok]) => ok).map(([type]) => type);
  }

}

export const logsManager = new LogsManager();

