export const helpTexts = {
  'task.quicklink': 'Copy the link to this task page',
  'task.publishlink': 'Copy the link to the published results and open it in a new tab',
  'task.steprunpath': 'Copy the run directory of this step on the executor',
  'task.menu': 'Task actions: priority, cancel, new task',
  'task.cancel': 'Cancel every running and pending step of this task',
  'task.launchagain': 'Open the launcher of this project, pre-filled with this task\'s settings',
  'task.priority': 'Higher priority is scheduled first. Press Enter to apply.',
  'step.toggle': 'Show or hide the attempts of this step',
  'step.estimate': 'Estimated start time',
  'step.cores': 'CPU cores allocated to this step on the executor',
  'step.load': 'Executor-wide memory and average CPU load, not this step alone',
  'step.logs': 'Open the output logs of this attempt',
  'step.cancel': 'Cancel only this step attempt',
  'step.exitcode': 'Exit code of the process (0 = success). Not set, Timedout, Cancelled and Launch Error are set by the scheduler, not by the process.',
  'board.counters': 'Number of steps (not tasks) in each state',
  'board.lastupdate': 'Time of the last refresh. The page does not refresh on its own.',
  'board.cpu': 'Executor CPU load. Yellow above 50%, red above 80%. Hover the bar for per-core load.',
  'board.mem': 'Executor memory usage. Yellow above 50%, red above 80%.',
  'board.storage': 'Used space on this storage. Yellow above 50%, red above 80%.',
  'launcher.new': 'Start a new task: choose a project, then fill in its launch form',
  'launcher.project': 'Open the launch form of this project',
  'history.sort': 'Sort the timeline by start or end time. Tasks are grouped under the date of the chosen time.',
  'history.card': 'Show the final state of this task',
  'history.delete': 'Delete this task\'s archived results, including the copy on the publish server. Cannot be undone.',
  'history.jobtype': 'Show this user\'s finished tasks for this job type',
  'history.all': 'Show the finished tasks of every user and job type',
  'history.alljobtype': 'Show the finished tasks of every user for this job type',
};

export class Help {
  static { Help.#CreateStyle(); }
  static #styleDefault = { 'visible': '_hp_Visible', 'tooltip': '_hp_Tooltip',  'url': '_hp_Url', 
      'panel': '_hp_Panel', 'panelOpen': '_hp_PanelOpen', 'panelClose': '_hp_PanelClose', 
      'helpMode': '_hp_HelpMode'
   };

  #style;
  #texts;
  #tooltip;
  #current;
  #panel;
  #toggle;
  
  // templateId: <template> holding the page help, toggleId: button opening the panel
  constructor(texts = {}, style = {}, templateId = null, toggleId = null) {
    this.#style = { ...Help.#styleDefault, ...style};
    this.#texts = texts;

    this.#tooltip = document.createElement('div');
    this.#tooltip.className = this.#style.tooltip;
    this.#tooltip.setAttribute('role', 'tooltip');
    document.body.appendChild(this.#tooltip);

    this.#current = null;
    this.#panel = null;
    this.#toggle = null;

    document.addEventListener('pointerover', this.#Show.bind(this));
    document.addEventListener('pointerout', this.#Leave.bind(this));
    document.addEventListener('focusin', this.#Show.bind(this));
    document.addEventListener('focusout', this.#Leave.bind(this));
    document.addEventListener('click', this.#Hide.bind(this), true);
    window.addEventListener('scroll', this.#Hide.bind(this), true);

    if ((templateId !== null) && (toggleId !== null)) {
      this.#EnablePanel(templateId, toggleId);
    }
  }

  TogglePanel() {
    if (this.#panel?.classList.contains(this.#style.panelOpen)) {
      this.ClosePanel();
    } else {
      this.OpenPanel();
    }
  }

  OpenPanel() {
    if (!this.#panel) {
      return;
    }
    const MARGIN = 8;
    const top = Math.max(0, this.#toggle.getBoundingClientRect().bottom + MARGIN);
    this.#panel.style.top = top + 'px';
    this.#panel.classList.add(this.#style.panelOpen);
    document.body.classList.add(this.#style.helpMode);
    this.#toggle.setAttribute('aria-expanded', 'true');
  }

  ClosePanel() {
    if (!this.#panel) {
      return;
    }
    this.#panel.classList.remove(this.#style.panelOpen);
    document.body.classList.remove(this.#style.helpMode);
    this.#toggle.setAttribute('aria-expanded', 'false');
  }

  #EnablePanel(templateId, toggleId) {
    const template = document.getElementById(templateId);
    const toggle = document.getElementById(toggleId);
    if (!template || !toggle) {
      console.warn(`Help: panel "${templateId}" or toggle "${toggleId}" not found`);
      return;
    }
    this.#panel = document.createElement('aside');
    this.#panel.className = this.#style.panel;
    this.#panel.setAttribute('aria-label', 'Help');

    const close = document.createElement('button');
    close.className = this.#style.panelClose;
    close.textContent = '✕';
    close.onclick = this.ClosePanel.bind(this);

    this.#panel.append(close, template.content.cloneNode(true));
    document.body.appendChild(this.#panel);

    this.#toggle = toggle;
    this.#toggle.setAttribute('aria-expanded', 'false');
    this.#toggle.onclick = this.TogglePanel.bind(this);
    document.addEventListener('keydown', this.#KeyDown.bind(this));
  }

  #KeyDown(event) {
    if (event.target.closest?.('input, textarea, select, [contenteditable]')) {
      return;
    }
    if (event.key === '?') {
      event.preventDefault();
      this.TogglePanel();
    } else if (event.key === 'Escape') {
      this.ClosePanel();
    }
  }

  #Show(event) {
    const target = event.target.closest?.('[data-help]');
    if (!target || (target === this.#current)) {
      return;
    }
    const text = this.#texts[target.dataset.help];
    if (!text) {
      console.warn(`Help: no text for "${target.dataset.help}"`);
      return;
    }
    this.#current = target;

    const main = document.createElement('div');
    main.textContent = text;
    this.#tooltip.replaceChildren(main);
    if (target.dataset.url) {
      const url = document.createElement('div');
      url.className = this.#style.url;
      url.textContent = target.dataset.url;
      this.#tooltip.appendChild(url);
    }
    this.#tooltip.classList.add(this.#style.visible);
    this.#Place(target);
  }

  #Leave(event) {
    if (!this.#current || !this.#current.contains(event.target)) {
      return;
    }
    if (event.relatedTarget && this.#current.contains(event.relatedTarget)) {
      return;
    }
    this.#Hide();
  }

  #Hide() {
    this.#current = null;
    this.#tooltip?.classList.remove(this.#style.visible);
  }

  #Place(target) {
    const MARGIN = 6;
    const anchor = target.getBoundingClientRect();
    const tip = this.#tooltip.getBoundingClientRect();
    let top = anchor.bottom + MARGIN;
    if (top + tip.height > window.innerHeight) {
      top = anchor.top - tip.height - MARGIN;
    }
    const left = Math.max(MARGIN, Math.min(anchor.left, window.innerWidth - tip.width - MARGIN));
    this.#tooltip.style.left = left + 'px';
    this.#tooltip.style.top = Math.max(MARGIN, top) + 'px';
  }

  static #CreateStyle() {
    const style = document.createElement('style');
    style.innerHTML = `
      ._hp_Tooltip {
        position: fixed;
        display: none;
        max-width: 320px;
        background: #1a1a1a;
        border: 1px solid #555;
        border-radius: 6px;
        padding: 6px 10px;
        color: #ddd;
        font-size: 12px;
        z-index: 9999;
        pointer-events: none;
      }
      ._hp_Visible {
        display: block;
      }
      ._hp_Url {
        margin-top: 4px;
        color: #999;
        font-family: monospace;
        font-size: 11px;
        word-break: break-all;
      }

      ._hp_Panel {
        position: fixed;
        top: 0;
        right: 0;
        bottom: 0;
        width: min(380px, 100vw);
        box-sizing: border-box;
        overflow-y: auto;
        padding: 16px 20px;
        background: #1f1f1f;
        border-left: 1px solid #555;
        box-shadow: -8px 0 24px rgba(0,0,0,0.45);
        color: #ddd;
        font-size: 13px;
        line-height: 1.5;
        z-index: 9000;
        transform: translateX(100%);
        visibility: hidden;
        transition: transform 0.2s ease, visibility 0.2s;
      }
      ._hp_PanelOpen {
        transform: translateX(0);
        visibility: visible;
      }
      ._hp_PanelClose {
        position: absolute;
        top: 10px;
        right: 12px;
        background: none;
        border: none;
        color: #aaa;
        font-size: 16px;
        cursor: pointer;
      }
      ._hp_Panel h2 {
        margin: 16px 0 6px;
        color: #fff;
        font-size: 14px;
      }
      ._hp_HelpMode [data-help] {
        outline: 1px dashed rgba(102, 126, 234, 0.7);
        outline-offset: 2px;
      }
    `;
    document.head.appendChild(style);
  }
};
