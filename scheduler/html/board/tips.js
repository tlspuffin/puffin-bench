// Hovers of the bench, one look everywhere (that of the details panels of Results): every element with a title
// shows it in a dark panel with a blue border instead of the browser's plain tooltip. The text keeps its meaning and
// gets a light structure: with several lines, the first is a title; "key: value" lines form a grid; lines starting
// with ⚠ are orange, with ✓ green; "- " lines are a list. The title is put back when the mouse leaves, for the code
// that reads it. The same for the <title> of SVG elements (charts of the runs page, commit ticks of the graphs).
// The other tooltips of the bench take the same colours: help hovers (help.js), load of the cores (board), the
// configuration hover of the Analyzer, and the hovers of the data points of the plotly charts (dark, with the border
// of their trace).
//
// Two kinds of information, told apart by the cursor:
// - hover (title, SVG <title>): links, buttons and controls, the charts; shown after 500 ms. The "?" cursor (help) on
//   the elements that do nothing on click; links and buttons keep the hand.
// - click (data-click-tip, or OpenClickTip(anchor, html) from the code): an element that does nothing else on click
//   opens a small window with its information; the cursor is "context-menu" (an arrow with a small box). The window
//   stays until another click, Esc, or a click on the element again.
// Imported once by nav.js, which every page loads.

const DELAY_MS = 500;
const esc = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// the HTML of a hover text
export function FormatTip(text) {
  const lines = String(text).split('\n').map(line => line.trimEnd()).filter((line, i, all) => line || (i > 0 && all[i - 1]));
  // one line: the look of every window all the same, a title ("name: what it says": the name, then what it says)
  if (lines.length <= 1) {
    const one = lines[0] ?? '';
    const named = /^([^:⚠✓•\-][^:]{0,60}):\s+(\S.*)$/.exec(one);
    if (named && !/^https?$/i.test(named[1])) {
      return `<div class="pb-tip-title">${Line(named[1])}</div><div class="pb-tip-line">${Line(named[2])}</div>`;
    }
    return `<div class="pb-tip-title">${Line(one)}</div>`;
  }
  let html = `<div class="pb-tip-title">${Line(lines[0])}</div>`;
  let grid = [], list = [];
  const flush = () => {
    if (grid.length) html += `<div class="pb-tip-grid">${grid.join('')}</div>`;
    if (list.length) html += `<ul class="pb-tip-list">${list.join('')}</ul>`;
    grid = []; list = [];
  };
  for (const line of lines.slice(1)) {
    const kv = /^\s*([^:⚠✓•\-][^:]{0,28}):\s+(\S.*)$/.exec(line);
    const item = /^\s*[-•]\s+(.*)$/.exec(line);
    if (kv && !/^https?$/i.test(kv[1])) { if (list.length) flush(); grid.push(`<span class="pb-tip-key">${esc(kv[1])}</span><span>${Line(kv[2])}</span>`); }
    else if (item) { if (grid.length) flush(); list.push(`<li>${Line(item[1])}</li>`); }
    else { flush(); html += line ? `<div class="pb-tip-line">${Line(line)}</div>` : '<div class="pb-tip-gap"></div>'; }
  }
  flush();
  return html;
}

function Line(line) {
  const text = esc(line);
  if (/^\s*(⚠|⛔|✗|✖)/.test(line)) return `<span class="pb-tip-warn">${text}</span>`;
  if (/^\s*(✓|✅)/.test(line)) return `<span class="pb-tip-ok">${text}</span>`;
  return text;
}

const style = document.createElement('style');
style.textContent = `
  .pb-tip, ._hp_Tooltip, .exec-tooltip {
    background: #151515 !important; color: #e8e8e8 !important; border: 1px solid #4b6bd6 !important;
    border-radius: 8px !important; box-shadow: 0 4px 16px #000a !important; font-size: 12px; line-height: 1.45;
  }
  .pb-tip { position: fixed; z-index: 10000; max-width: min(460px, 92vw); padding: 6px 10px; pointer-events: none;
    font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; white-space: normal; overflow-wrap: anywhere; }
  .pb-tip-title { font-weight: 700; margin-bottom: 3px; }
  .pb-tip-grid { display: grid; grid-template-columns: auto 1fr; gap: 1px 10px; margin: 2px 0; }
  .pb-tip-key { color: #8b8b8b; white-space: nowrap; }
  .pb-tip-list { margin: 2px 0; padding-left: 16px; }
  .pb-tip-gap { height: 5px; }
  .pb-tip-warn { color: #d29922; } .pb-tip-ok { color: #3fb950; }
  ._hp_Tooltip { padding: 6px 10px !important; }
  :where([title]):not(:where(a, button, input, select, textarea, label, summary, option, [role="button"])) { cursor: help; }
  [data-click-tip] { cursor: context-menu !important; }
  .pb-tip.pb-click { position: absolute; pointer-events: auto; max-height: 70vh; overflow-y: auto; }
  .header-config-tooltip { background: #151515 !important; color: #e8e8e8 !important; border: 1px solid #4b6bd6 !important;
    border-radius: 8px !important; box-shadow: 0 4px 16px #000a !important; }
  .js-plotly-plot .hovertext path, .js-plotly-plot .axistext path { fill: #151515 !important; }
  .js-plotly-plot .hovertext text, .js-plotly-plot .axistext text, .js-plotly-plot .hovertext tspan { fill: #e8e8e8 !important; }
`;
document.head.appendChild(style);

let tip = null, owner = null, timer = null, svgTitle = null;

function Hide() {
  clearTimeout(timer);
  timer = null;
  tip?.remove();
  if (svgTitle) { svgTitle.textContent = svgTitle.dataset.pbTip ?? svgTitle.textContent; delete svgTitle.dataset.pbTip; svgTitle = null; }
  if (owner?.dataset && owner.dataset.pbTip !== undefined && !(owner instanceof SVGElement)) {
    if (!owner.getAttribute('title')) owner.setAttribute('title', owner.dataset.pbTip);
    delete owner.dataset.pbTip;
  }
  if (owner instanceof SVGElement) delete owner.dataset.pbTip;
  owner = null;
}

function Show(element, x, y) {
  tip ??= Object.assign(document.createElement('div'), { className: 'pb-tip', role: 'tooltip' });
  tip.innerHTML = FormatTip(element.dataset.pbTip ?? '');
  document.body.appendChild(tip);
  const rect = element.getBoundingClientRect();
  const box = tip.getBoundingClientRect();
  let top = rect.bottom + 6;
  if (top + box.height > window.innerHeight - 8) top = Math.max(8, rect.top - box.height - 6);
  const left = Math.max(8, Math.min(x - 12, window.innerWidth - box.width - 8));
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

// the nearest SVG element with a <title> child, from the hovered one
function SvgWithTitle(target) {
  for (let el = target; el instanceof SVGElement; el = el.parentElement) {
    const title = [...el.children].find(child => child.tagName.toLowerCase() === 'title');
    if (title && (title.dataset.pbTip ?? title.textContent).trim()) return [el, title];
  }
  return [null, null];
}

document.addEventListener('mouseover', (event) => {
  const [svgElement, title] = event.target instanceof SVGElement ? SvgWithTitle(event.target) : [null, null];
  if (svgElement) {
    if (svgElement === owner) return;
    Hide();
    owner = svgElement;
    svgTitle = title;
    title.dataset.pbTip = title.textContent;
    title.textContent = '';  // no native tooltip
    owner.dataset.pbTip = title.dataset.pbTip;
    const { clientX: x, clientY: y } = event;
    timer = setTimeout(() => { if (owner === svgElement) Show(svgElement, x, y); }, DELAY_MS);
    return;
  }
  const element = event.target instanceof Element ? event.target.closest('[title]') : null;
  if (element === owner) return;
  Hide();
  // not the plots (their own hovers), not an empty title
  if (!element || !element.getAttribute('title')?.trim() || element.closest('.js-plotly-plot, svg')) return;
  owner = element;
  element.dataset.pbTip = element.getAttribute('title');
  element.removeAttribute('title');
  // the "?" cursor on an element whose information is a hover and that does nothing on click, also when a style of
  // the page set it a plain cursor (the CSS rule above has no priority); links, buttons and clickable rows keep theirs
  if (!element.closest('a, button, input, select, textarea, label, summary, [role="button"], [onclick]')
      && ['auto', 'default', 'text'].includes(getComputedStyle(element).cursor)) {
    element.style.cursor = 'help';
  }
  const { clientX: x, clientY: y } = event;
  timer = setTimeout(() => { if (owner === element) Show(element, x, y); }, DELAY_MS);
}, true);
document.addEventListener('mouseout', (event) => {
  if (owner && !owner.contains(event.relatedTarget)) Hide();
}, true);
for (const type of ['mousedown', 'scroll', 'keydown', 'blur']) window.addEventListener(type, Hide, true);

// ── click windows ───────────────────────────────────────────────────────────────────────────────────────────────
let clickTip = null, clickOwner = null;

export function CloseClickTip() {
  clickTip?.remove();
  clickTip = null;
  clickOwner = null;
}

// a small window under the anchor (above when there is no room), with html (already escaped by the caller); a second
// call for the same anchor closes it
export function OpenClickTip(anchor, html, className = '') {
  if (clickOwner === anchor) { CloseClickTip(); return; }
  CloseClickTip();
  Hide();
  clickOwner = anchor;
  clickTip = Object.assign(document.createElement('div'), { className: `pb-tip pb-click ${className}`.trim(), role: 'dialog' });
  clickTip.innerHTML = html;
  clickTip.addEventListener('click', (event) => event.stopPropagation());
  document.body.appendChild(clickTip);
  const rect = anchor.getBoundingClientRect();
  const box = clickTip.getBoundingClientRect();
  let top = rect.bottom + 6;
  if (top + box.height > window.innerHeight - 8 && rect.top - box.height - 6 > 8) top = rect.top - box.height - 6;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - box.width - 8));
  clickTip.style.left = `${left + window.scrollX}px`;
  clickTip.style.top = `${top + window.scrollY}px`;
  return clickTip;
}

document.addEventListener('click', (event) => {
  const anchor = event.target instanceof Element ? event.target.closest('[data-click-tip]') : null;
  // a link or a button inside the element keeps its own click
  const control = event.target instanceof Element ? event.target.closest('a, button, input, select, textarea') : null;
  if (anchor && !(control && control !== anchor && anchor.contains(control))) {
    event.stopPropagation();
    event.preventDefault();  // e.g. a badge inside a <summary> does not fold its bug
    OpenClickTip(anchor, FormatTip(anchor.dataset.clickTip));
    return;
  }
  if (clickTip && !clickTip.contains(event.target)) CloseClickTip();
}, true);
// Esc (nav.js: pb-escape, the topmost layer first): closes the window, and only it
window.addEventListener('pb-escape', (event) => {
  if (!clickTip || event.defaultPrevented || (event.detail?.layer && event.detail.layer !== 'modal')) return;
  event.preventDefault();
  CloseClickTip();
});
