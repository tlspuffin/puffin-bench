// results_page.mjs: Results' page code (publisher/summary_render.js) under node, for the tests of what it shows. A copy
// of the page's files (Prepare: html/publisher, html/common, html/objectives/bugs.js, the folder's own tips.js and
// frame.js stubbed), with the graph modules stubbed and the internal functions exported; the least DOM those functions
// need (FakeEl: HTML kept as strings), and a fetch answered from <root>/html/ (the test's fixtures). Nothing else of the
// page changes. Used by results_regression_test.sh.
import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync } from 'node:fs';
import { dirname, join } from 'node:path';

const escapeText = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export class FakeEl {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase(); this.dataset = {}; this._classes = new Set(); this.innerHTML = '';
    this.title = ''; this.before = []; this.children = []; this.listeners = {}; this.scope = {}; this.style = {};
  }
  get classList() {
    const s = this._classes;
    return { add: (...c) => c.forEach(x => s.add(x)), remove: (...c) => c.forEach(x => s.delete(x)),
             toggle: (c, f) => { if (f === undefined) f = !s.has(c); f ? s.add(c) : s.delete(c); return f; }, contains: c => s.has(c) };
  }
  set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get className() { return [...this._classes].join(' '); }
  set textContent(v) { this.innerHTML = escapeText(v); this.children = []; }
  get textContent() {
    return this.innerHTML.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  }
  querySelector(sel) { return this.scope[sel] ?? null; }
  querySelectorAll(sel) { return this.scope[sel] ?? []; }
  insertAdjacentHTML(pos, html) {
    if (pos === 'beforeend') this.innerHTML += html; else if (pos === 'afterbegin') this.innerHTML = html + this.innerHTML; else throw new Error(`pos ${pos}`);
  }
  closest(sel) { return this.up?.[sel] ?? null; }
  get previousElementSibling() { return this.before.at(-1) ?? null; }
  get nextElementSibling() { return (this.afterEls ??= [])[0] ?? null; }
  after(el) { (this.afterEls ??= []).unshift(el); }
  remove() { this.removed = true; }
  append(...els) { this.children.push(...els); }
  appendChild(el) { this.children.push(el); return el; }
  insertBefore(el, ref) { if (ref) ref.before.push(el); else this.children.push(el); return el; }
  addEventListener(type, f) { (this.listeners[type] ??= []).push(f); }
  setAttribute(k, v) { (this.attrs ??= {})[k] = v; }
  click() { (this.listeners.click ?? []).forEach(f => f({ stopPropagation() {} })); }
}

// Prepare(root, repo): the page's files under <root>/html, instrumented; returns the module's URL to import
export function Prepare(root, repo) {
  const html = join(root, 'html');
  for (const dir of ['publisher', 'common']) cpSync(join(repo, 'tlspuffin/data/html', dir), join(html, dir), { recursive: true });
  mkdirSync(join(html, 'objectives'), { recursive: true });
  cpSync(join(repo, 'tlspuffin/scripts/tools/objectives_page/bugs.js'), join(html, 'objectives/bugs.js'));
  mkdirSync(join(html, 'board'), { recursive: true });
  // the page's files are ES modules, as the browser loads them
  writeFileSync(join(html, 'package.json'), '{ "type": "module" }\n');
  // the small windows of the bench (tips.js): what they would show, kept
  writeFileSync(join(html, 'board/tips.js'), "export function OpenClickTip(anchor, text, cls) { (globalThis.__tips ??= []).push({ anchor, text, cls }); }\n");
  writeFileSync(join(html, 'board/frame.js'), '');
  const file = join(html, 'publisher/summary_render.js');
  let src = readFileSync(file, 'utf8');
  const must = (from, to) => { if (!src.includes(from)) throw new Error(`results_page.mjs: not in summary_render.js: ${from}`); src = src.replace(from, to); };
  must("import { GraphOverview } from './summary_graphoverview.js';", 'const GraphOverview = class {};');
  must("import { GraphCompare } from './summary_graphcompare.js';", 'const GraphCompare = class {};');
  must("import { MetricsCampaign } from './summary_metricscampaign.js';", 'const MetricsCampaign = { GetMetrics: () => null };');
  must("import('/html/objectives/bugs.js')", "import(new URL('../objectives/bugs.js', import.meta.url).href)");
  src += '\nexport { RegressionFloor, ApplyRegression, ShowReportBugs, ValidationLine, GetObjectivesButton };\n';
  writeFileSync(join(html, 'publisher/summary_render.test.js'), src);
  return new URL(`file://${join(html, 'publisher/summary_render.test.js')}`).href;
}

// InstallShims(root): window, document, fetch (GET of /html/<path> answered from <root>/html/<path>)
export function InstallShims(root) {
  globalThis.GIT_RESTAPI_PORT = 1; globalThis.SCHEDULER_PORT = 2; globalThis.VIS_COMPARATOR_PORT = 3;
  globalThis.window = { location: { host: 'h', hostname: 'h', href: 'http://h/files/tlspuffin/', hash: '', search: '', protocol: 'http:' }, addEventListener() {} };
  globalThis.document = { createElement: tag => new FakeEl(tag), createTextNode: t => ({ text: t }), addEventListener() {},
                          querySelectorAll: () => [], body: new FakeEl('body'), getElementById: () => null };
  globalThis.CSS = { escape: s => String(s) };
  globalThis.fetch = async (url) => {
    const m = /\/html\/([^?#]+)/.exec(String(url));
    const file = m ? join(root, 'html', decodeURIComponent(m[1])) : null;
    return file && existsSync(file)
      ? { ok: true, status: 200, json: async () => JSON.parse(readFileSync(file, 'utf8')), text: async () => readFileSync(file, 'utf8') }
      : { ok: false, status: 404, json: async () => { throw new Error('404'); } };
  };
}

// WriteFixture(root, path, value): <root>/html/<path>, JSON
export function WriteFixture(root, path, value) {
  const file = join(root, 'html', path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

// RegressionTable(rows, fields): a table as RenderLibrariesTable makes it, as far as ApplyRegression reads it: a row per
// library (tr.lib-row, data-library) with its name cell (.col-lib) and one cell per field (td[data-field])
export function RegressionTable(rows, fields) {
  const table = new FakeEl('table');
  table.parentNode = new FakeEl('div');
  table.scope['tr.lib-row'] = rows.map(library => {
    const row = new FakeEl('tr');
    row.dataset.library = library;
    row.scope['.col-lib'] = new FakeEl('td');
    for (const field of fields) row.scope[`td[data-field="${field}"]`] = new FakeEl('td');
    return row;
  });
  return table;
}

// Shown(table, field): what ApplyRegression put in the table: the line above it (head: its text, the text of its
// details), and per library its ⚠ mark and, for the field, the cell's text, class and details
export function Shown(table, field) {
  const head = table.before[0] ?? null;
  const details = (el) => { globalThis.__tips = []; el.click(); return globalThis.__tips[0]?.text ?? null; };
  const rows = Object.fromEntries(table.scope['tr.lib-row'].map(row => {
    const span = row.scope[`td[data-field="${field}"]`]?.children[0] ?? null;
    return [row.dataset.library, { warn: row.scope['.col-lib'].innerHTML.includes('reg-warn'),
                                   text: span?.textContent ?? null, cls: span?.className ?? null, details: span ? details(span) : null }];
  }));
  return { head: head ? head.textContent : null, headDetails: head ? details(head) : null, rows };
}

// RunsPage(root, repo, hash): the Runs page (tools/runs_page/runs.js, as served from /html/runs/) rendered under node
// for location.hash, on the data files of <root>/html/runs/ (index.json, <commit>-<category>-<type>.json); git_restapi
// does not answer (the commit line stays the bare commit). Returns the HTML the page put in #runs. Each call loads a
// fresh copy of the module (the page renders once when loaded)
let runsPages = 0;
export async function RunsPage(root, repo, hash) {
  const html = join(root, 'html');
  mkdirSync(join(html, 'runs'), { recursive: true });
  cpSync(join(repo, 'tlspuffin/scripts/tools/runs_page/runs.js'), join(html, 'runs/runs.js'));
  if (!existsSync(join(html, 'common'))) cpSync(join(repo, 'tlspuffin/data/html/common'), join(html, 'common'), { recursive: true });
  mkdirSync(join(html, 'board'), { recursive: true });
  writeFileSync(join(html, 'board/frame.js'), '');
  writeFileSync(join(html, 'package.json'), '{ "type": "module" }\n');
  const elements = { runs: new FakeEl('div'), 'commit-line': new FakeEl('span') };
  globalThis.location = { hash, search: '', protocol: 'http:', hostname: 'h', host: 'h' };
  globalThis.window = { location: globalThis.location, addEventListener() {} };
  globalThis.document = { title: '', getElementById: id => elements[id] ?? null, createElement: tag => new FakeEl(tag), querySelectorAll: () => [], addEventListener() {} };
  globalThis.fetch = async (url) => {
    url = String(url);
    const file = /^[\w.-]+\.json$/.test(url) ? join(html, 'runs', url) : null;
    return file && existsSync(file)
      ? { ok: true, status: 200, json: async () => JSON.parse(readFileSync(file, 'utf8')) }
      : (() => { throw new Error(`no answer for ${url}`); })();
  };
  await import(`${new URL(`file://${join(html, 'runs/runs.js')}`).href}?${++runsPages}`);
  // Render is async: let it finish (its fetches are answered at once)
  for (let i = 0; i < 50 && !elements.runs.innerHTML.includes('class="wrap"'); i++) await new Promise(r => setTimeout(r, 10));
  return elements.runs.innerHTML;
}
