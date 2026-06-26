import { Terminal } from './terminal.js';

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
    }
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
      LogsManager.#modal = {
        div: modal,
        stepName: modal.querySelector(`#step-name`),
        logsTabs: modal.getElementsByClassName('logs-tabs')[0],
        logsContent: modal.getElementsByClassName('logs-content')[0],
      };
      LogsManager.#modal.logsTabs.querySelector('#log-stdout').onclick = this.#SwitchOutput.bind(this, 'stdout');
      LogsManager.#modal.logsTabs.querySelector('#log-stderr').onclick = this.#SwitchOutput.bind(this, 'stderr');
    }
    return {
        stdout: [ LogsManager.#modal.logsTabs.querySelector('#log-stdout'), 
            LogsManager.#modal.logsContent.querySelector('#stdout-container'), 
            LogsManager.#modal.logsContent.querySelector('#stdout-content') ],
        stderr: [ LogsManager.#modal.logsTabs.querySelector('#log-stderr'), 
            LogsManager.#modal.logsContent.querySelector('#stderr-container'), 
            LogsManager.#modal.logsContent.querySelector('#stderr-content') ]
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
        LogsManager.#modal.logsTabs.appendChild(tab);
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
          { if ((type != 'stdout') && (type != 'stderr')) { 
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

    
    this.#UpdateActiveTab();

    LogsManager.#modal.stepName.innerText = stepName;
    LogsManager.#modal.div.classList.add('show');

    await this.#RetrieveFullStepLogs(10000000);
  }

}

export const logsManager = new LogsManager();

