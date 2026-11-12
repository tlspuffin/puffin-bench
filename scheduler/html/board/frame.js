// Frame of the pages: a bar on top of the page with the refresh (🔄), the help (❔) and, on the pages that name a
// scheduler, its status light; the plugins of the projects add their own items to it (frame.barItems, see
// plugins.js) and their tabs to the help panel (frame.helpTabs).
// A page includes it once, as its first script (<script type="module" src="…/board/frame.js"></script>, or
// import './frame.js'). Nothing is shown in a page shown inside another one (an iframe), or when a bar is already
// there.
// Refresh: 🔄 sends a cancelable "pb-refresh" event on window; a page with its own refresh handles it and calls
// preventDefault(), otherwise the page is reloaded. A page may color the button by sending "pb-refresh-state" with
// { detail: { level: 'gold' | '', title } } (e.g. a refresh that costs GitHub credits).
// Keys, on every page: Cmd/Ctrl+R = 🔄 (Shift for the browser's reload); ? = the help; Esc closes the topmost popup.
// A popup handles Cmd/Ctrl+R and Esc through cancelable events on window, sent from the top layer down until one
// calls preventDefault(): "pb-escape" with { detail: { layer } }, layer 'help' (the help panel, help.js), 'modal'
// (logs, launcher, click windows) then 'panel' (drawer, unfolded panels), and "pb-modal-refresh" (e.g. the logs
// window refreshes its logs instead of the page). A key a page already handled (defaultPrevented) is left alone.
// Sticky headers of the pages stay below the bar with top: var(--pb-nav-height, 0px).
// one look for every hover (tips.js)
import './tips.js';
import { AddHelpTab, ToggleHelp } from './help.js';
import { HealthPill, SetSchedulerURL } from './health.js';

const style = `
.pb-nav { position: sticky; top: 0; z-index: 1000; flex: 0 0 34px; height: 34px; display: flex; align-items: center;
  gap: 2px; padding: 0 10px; background: #0a0a0a; border-bottom: 1px solid #262626; overflow-x: auto; white-space: nowrap;
  font: 13px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #e8e8e8; box-sizing: border-box; }
.pb-nav * { box-sizing: border-box; }
.pb-nav .pb-start, .pb-nav .pb-end { display: flex; align-items: center; gap: 2px; }
.pb-nav .pb-spacer { flex: 1; }
.pb-nav .pb-btn { margin-left: 4px; width: 28px; height: 24px; padding: 0; border: 1px solid #333; border-radius: 6px;
  background: #161616; color: #e8e8e8; font-size: 14px; line-height: 1; cursor: pointer; }
.pb-nav .pb-btn:hover { background: #1f2937; border-color: #58a6ff; }
.pb-nav .pb-btn.on { background: #1f2937; border-color: #58a6ff; }
.pb-nav .pb-btn.gold { background: #ffc400; border-color: #ffc400; }
.pb-nav .pb-btn.spin { animation: pb-spin .6s linear; }
.pb-nav .pb-health { margin-left: 10px; display: flex; gap: 4px; align-items: center; padding: 2px 7px;
  border: 1px solid #333; border-radius: 999px; background: #161616; font-size: 11px; color: #8b8b8b;
  cursor: default; }
.pb-nav .pb-health.down { border-color: #a33; color: #ff9b9b; }
.pb-nav .pb-health.warn { border-color: #a97; color: #ffd089; }
@keyframes pb-spin { to { transform: rotate(360deg); } }
`;

// the bar and its places: start (left), end (right, before the status light and the buttons), health
let slots = null;
let schedulerURL = null;
let healthShown = false;

const typing = (event) => !!event.target.closest?.('input, textarea, select, [contenteditable]');

// Shows the status light of a scheduler in the bar: the origin of the page by default (the pages of the scheduler),
// another one for a page served by another service. Once per page; also the scheduler of CheckScheduler (health.js).
export function ShowSchedulerHealth(url = window.location.origin) {
  schedulerURL = url;
  SetSchedulerURL(url);
  if (slots && !healthShown) {
    healthShown = true;
    slots.health.appendChild(HealthPill());
  }
}

function Build() {
  // the page is already shown under a bar (in a frame of the bench)
  if (window.self !== window.top || document.querySelector('.pb-nav')) return;

  const css = document.createElement('style');
  css.textContent = style;
  document.head.appendChild(css);

  const nav = document.createElement('nav');
  nav.className = 'pb-nav';
  const start = document.createElement('span');
  start.className = 'pb-start';
  const spacer = document.createElement('span');
  spacer.className = 'pb-spacer';
  const end = document.createElement('span');
  end.className = 'pb-end';
  const health = document.createElement('span');
  nav.append(start, spacer, end, health);
  slots = { bar: nav, start, end, health };
  if (schedulerURL) ShowSchedulerHealth(schedulerURL);

  // refresh: the page's own refresh (pb-refresh event), or a reload
  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.className = 'pb-btn';
  refresh.textContent = '🔄';
  refresh.title = 'Refresh this page (Cmd/Ctrl+R)';
  refresh.onclick = () => {
    refresh.classList.remove('spin');
    void refresh.offsetWidth;
    refresh.classList.add('spin');
    const event = new CustomEvent('pb-refresh', { cancelable: true });
    window.dispatchEvent(event);
    if (!event.defaultPrevented) window.location.reload();
  };
  window.addEventListener('pb-refresh-state', (event) => {
    refresh.classList.toggle('gold', event.detail?.level === 'gold');
    refresh.title = `${event.detail?.title || 'Refresh this page'} (Cmd/Ctrl+R)`;
  });
  nav.appendChild(refresh);

  const help = document.createElement('button');
  help.type = 'button';
  help.className = 'pb-btn';
  help.textContent = '❔';
  help.title = 'Help (?)';
  help.onclick = () => ToggleHelp();
  window.addEventListener('pb-help', (event) => help.classList.toggle('on', !!event.detail?.open));
  nav.appendChild(help);

  // on window, after the page's own handlers (document): a key they handled is left alone
  window.addEventListener('keydown', (event) => {
    if (event.defaultPrevented) return;
    const command = event.metaKey || event.ctrlKey;
    // Cmd/Ctrl+R: the logs window (or another popup) first, else 🔄; with Shift, the browser's reload
    if (command && !event.shiftKey && !event.altKey && (event.key.toLowerCase() === 'r')) {
      event.preventDefault();
      const modal = new CustomEvent('pb-modal-refresh', { cancelable: true });
      window.dispatchEvent(modal);
      if (!modal.defaultPrevented) refresh.click();
      return;
    }
    if (event.key === 'Escape') {
      for (const layer of ['help', 'modal', 'panel']) {
        const escape = new CustomEvent('pb-escape', { cancelable: true, detail: { layer } });
        window.dispatchEvent(escape);
        if (escape.defaultPrevented) {
          if (layer === 'help') return;
          break;
        }
      }
      // out of a text field
      if (typing(event)) event.target.blur();
      return;
    }
    if (command || event.altKey || typing(event)) return;
    if (event.key === '?') {
      event.preventDefault();
      ToggleHelp();
    }
  });

  document.body.prepend(nav);
  document.documentElement.style.setProperty('--pb-nav-height', '34px');

  // the items and help tabs of the plugins, once they are loaded (the bar is shown meanwhile)
  import('./plugins.js').then(({ FrameBarItems, FrameHelpTabs }) => {
    FrameBarItems({ bar: nav, start, end });
    for (const tab of FrameHelpTabs()) AddHelpTab(tab);
  }).catch(error => console.warn('Frame: the plugins could not be loaded', error));
}

if (document.body) Build();
else document.addEventListener('DOMContentLoaded', Build);
