// Help of the pages, two parts:
// - hovers: an element with data-help="<key>" shows the text of that key (helpTexts, and those of the plugins) after
//   500 ms, as every hover (tips.js); a page creates one Help with its texts;
// - the help panel (❔ of the top bar or the ? key, frame.js): tabs, "This page" first (the page's
//   <template id="help-panel">, read when the panel opens), then the tabs of the plugins (AddHelpTab). While it is
//   open, the elements with a hover help are outlined (help mode). Esc closes it before any other popup (pb-escape,
//   layer 'help'). Its state is sent on window: "pb-help" with { detail: { open } }.
import { FormatTip } from './tips.js';
export const helpTexts = {
  'task.quicklink': 'Click: copy the link of the task page · Cmd/Ctrl+click or middle click: open it in a new tab',
  'task.publishlink': 'Copy the link to the published results and open it in a new tab',
  'task.steprunpath': 'Copy the run directory of this step on the executor',
  'task.menu': 'Task actions: priority, cancel, new task',
  'task.cancel': 'Cancel every running and pending step of this task',
  'task.launchagain': 'Open the launcher of this project, pre-filled with this task\'s settings',
  'task.status': 'Running: a step runs. Waiting for cores: started, its next steps wait for free cores. Scheduled: no step started yet, with its estimated start. The bar counts the finished (green) and running (white) steps; ends ~ is the estimated end.',
  'step.monitor': 'Last message of the step monitor, summarized; click for the full message',
  'board.fold': 'Fold the steps of every task',
  'board.unfold': 'Unfold the steps of every task',
  'board.foldactive': 'Unfold only the steps that run an attempt, fold the others',
  'task.priority': 'Higher priority is scheduled first. Press Enter to apply.',
  'step.toggle': 'Show or hide the attempts of this step',
  'step.estimate': 'Estimated start time',
  'step.cores': 'CPU cores allocated to this step on the executor',
  'step.load': 'Executor-wide memory and average CPU load, not this step alone',
  'step.logs': 'Open the output logs of this attempt',
  'step.cancel': 'Cancel only this step attempt',
  'step.exitcode': 'Exit code of the process (0 = success). Not set, Timedout, Cancelled and Launch Error are set by the scheduler, not by the process.',
  'board.counters': 'Number of tasks; the hover gives their steps',
  'board.done12': 'Tasks finished or cancelled in the last 12 hours (History)',
  'board.done': 'Finished tasks in the History',
  'board.lastupdate': 'Time of the last refresh. The page does not refresh on its own: 🔄 in the top bar.',
  'board.cpu': 'Executor CPU load. Yellow above 50%, red above 80%. Hover the bar for per-core load.',
  'board.mem': 'Executor memory usage. Yellow above 50%, red above 80%.',
  'board.storage': 'Used space on this storage. Yellow above 50%, red above 80%.',
  'launcher.new': 'Start a new task: choose a project, then fill in its launch form',
  'launcher.project': 'Open the launch form of this project',
  'history.stats': 'Finished tasks in total · in the last 30 days: number of tasks · their core-hours (cores × run time of their steps), then what the projects count',
  'history.search': 'Matches the task name, id, user, type and what its project shows of it (all the words)',
  'history.filter': 'Show only these users, types or states, or what the filters of the projects select; with none selected in a group, the group does not filter',
  'history.sort': 'Sort the timeline by start or end time. Tasks are grouped under the date of the chosen time.',
  'history.card': 'Show the details of this task on the right: actions, times, arguments, configurations, task card',
  'history.delete': 'Delete this task\'s archived results, including the copy on the publish server. Cannot be undone.',
  'history.jobtype': 'Show this user\'s finished tasks for this job type',
  'history.all': 'Show the finished tasks of every user and job type',
  'history.alljobtype': 'Show the finished tasks of every user for this job type',
};

const helpModeClass = '_hp_HelpMode';

// ── Hovers ───────────────────────────────────────────────────────────────────────────────────────────────────

export class Help {
  static { Help.#CreateStyle(); }
  static #styleDefault = { 'visible': '_hp_Visible', 'tooltip': '_hp_Tooltip',  'url': '_hp_Url' };

  #style;
  #texts;
  #tooltip;
  #timer = null;
  #current;

  constructor(texts = {}, style = {}) {
    this.#style = { ...Help.#styleDefault, ...style};
    this.#texts = texts;

    this.#tooltip = document.createElement('div');
    this.#tooltip.className = this.#style.tooltip;
    this.#tooltip.setAttribute('role', 'tooltip');
    document.body.appendChild(this.#tooltip);

    this.#current = null;

    document.addEventListener('pointerover', this.#Show.bind(this));
    document.addEventListener('pointerout', this.#Leave.bind(this));
    document.addEventListener('focusin', this.#Show.bind(this));
    document.addEventListener('focusout', this.#Leave.bind(this));
    document.addEventListener('click', this.#Hide.bind(this), true);
    window.addEventListener('scroll', this.#Hide.bind(this), true);
  }

  #Show(event) {
    const target = event.target.closest?.('[data-help]');
    if (!target || (target === this.#current)) {
      return;
    }
    // an element (itself or inside it) with its own hover or click window (tips.js) wins: one window at a time
    const inner = event.target.closest?.('[title], [data-pb-tip], [data-click-tip]');
    if (inner && target.contains(inner)) {
      this.#Hide();
      return;
    }
    const text = this.#texts[target.dataset.help];
    if (!text) {
      console.warn(`Help: no text for "${target.dataset.help}"`);
      return;
    }
    this.#current = target;
    // after 500 ms, as every hover of the bench (tips.js)
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      if (this.#current !== target) return;

      const main = document.createElement('div');
      main.innerHTML = FormatTip(text);
      this.#tooltip.replaceChildren(main);
      if (target.dataset.url) {
        const url = document.createElement('div');
        url.className = this.#style.url;
        url.textContent = target.dataset.url;
        this.#tooltip.appendChild(url);
      }
      this.#tooltip.classList.add(this.#style.visible);
      this.#Place(target);
    }, 500);
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
    clearTimeout(this.#timer);
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
    `;
    document.head.appendChild(style);
  }
};

// ── Help panel ───────────────────────────────────────────────────────────────────────────────────────────────

const panelStyle = `
.pb-help { position: fixed; z-index: 1001; top: var(--pb-nav-height, 0px); right: 0; bottom: 0; width: min(620px, 100vw);
  display: none; flex-direction: column; background: #111; color: #e0e0e0; border-left: 1px solid #333;
  box-shadow: -8px 0 24px #000a; font: 13px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  box-sizing: border-box; }
.pb-help.open { display: flex; }
.pb-help * { box-sizing: border-box; }
.pb-help .pb-help-tabs { display: flex; align-items: center; gap: 4px; padding: 6px 10px; border-bottom: 1px solid #262626; }
.pb-help .pb-help-tabs button { padding: 3px 12px; border: 1px solid #333; border-radius: 999px; background: transparent;
  color: #bbb; font: inherit; cursor: pointer; }
.pb-help .pb-help-tabs button.on { background: #1d2a52; border-color: #4b6bd6; color: #fff; }
.pb-help .pb-help-tabs .pb-help-close { margin-left: auto; border: none; font-size: 15px; }
.pb-help .pb-help-body { flex: 1; overflow: auto; padding: 4px 16px 24px; }
.pb-help h2 { font-size: 14px; color: #fff; margin: 16px 0 4px; border-bottom: 1px solid #262626; padding-bottom: 2px; }
.pb-help h3, .pb-help h4 { font-size: 13px; color: #ddd; margin: 10px 0 2px; }
.pb-help p { margin: 4px 0; }
.pb-help ul { margin: 4px 0; padding-left: 20px; }
.pb-help li { margin: 2px 0; }
.pb-help code, .pb-help kbd { font: 12px ui-monospace, Menlo, monospace; background: #1f1f1f; border: 1px solid #2a2a2a;
  border-radius: 4px; padding: 0 4px; }
.pb-help table { border-collapse: collapse; margin: 4px 0; width: 100%; }
.pb-help th, .pb-help td { text-align: left; padding: 2px 6px; border-bottom: 1px solid #222; vertical-align: top; }
.pb-help th { color: #8b8b8b; font-weight: 600; }
.pb-help a { color: #58a6ff; }
.pb-help .pb-help-none { color: #8b8b8b; font-style: italic; margin-top: 12px; }
.${helpModeClass} [data-help] { outline: 1px dashed rgba(102, 126, 234, 0.7); outline-offset: 2px; }
`;

// the tabs: "This page", then those of the plugins ({ label, html: HTML text, or a function giving it, maybe async })
const tabs = [{ label: 'This page', html: PageHelp }];
let current = 0;
let panel = null;

function PageHelp() {
  const template = document.getElementById('help-panel');
  if (template) return template.content.cloneNode(true);
  return `<p class="pb-help-none">No help for this page${tabs.length > 1 ? ': see the other tabs' : ''}.</p>`;
}

export function AddHelpTab(tab) {
  if (!tab?.label || (tab.html == null)) {
    console.warn('Help: a tab needs a label and its html', tab);
    return;
  }
  tabs.push(tab);
  if (panel) RenderTabs();
}

function Panel() {
  if (panel) return panel;
  const css = document.createElement('style');
  css.textContent = panelStyle;
  document.head.appendChild(css);

  panel = document.createElement('aside');
  panel.className = 'pb-help';
  panel.setAttribute('aria-label', 'Help');
  panel.innerHTML = '<div class="pb-help-tabs"></div><div class="pb-help-body"></div>';
  document.body.appendChild(panel);
  RenderTabs();
  return panel;
}

function RenderTabs() {
  const bar = panel.querySelector('.pb-help-tabs');
  bar.replaceChildren(...tabs.map((tab, i) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = tab.label;
    button.classList.toggle('on', i === current);
    button.onclick = () => { current = i; RenderTabs(); RenderBody(); };
    return button;
  }));
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'pb-help-close';
  close.title = 'Close (Esc)';
  close.textContent = '✕';
  close.onclick = () => ToggleHelp(false);
  bar.appendChild(close);
}

async function RenderBody() {
  const body = panel.querySelector('.pb-help-body');
  const tab = tabs[current] ?? tabs[0];
  try {
    const content = await (typeof tab.html === 'function' ? tab.html() : tab.html);
    if (content instanceof Node) body.replaceChildren(content);
    else body.innerHTML = String(content ?? '');
  } catch (error) {
    body.textContent = `This help could not be loaded: ${error.message}`;
  }
  body.scrollTop = 0;
}

export function IsHelpOpen() {
  return !!panel?.classList.contains('open');
}

// open (true), close (false) or switch (null) the help panel
export async function ToggleHelp(open = null) {
  const show = open ?? !IsHelpOpen();
  if (!show && !panel) return;
  Panel().classList.toggle('open', show);
  document.body.classList.toggle(helpModeClass, show);
  window.dispatchEvent(new CustomEvent('pb-help', { detail: { open: show } }));
  if (show) await RenderBody();
}

// Esc: the help panel first
window.addEventListener('pb-escape', (event) => {
  if ((event.detail?.layer !== 'help') || event.defaultPrevented || !IsHelpOpen()) return;
  event.preventDefault();
  ToggleHelp(false);
});
