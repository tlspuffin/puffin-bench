// Runs of a commit: every task the publisher keeps for a tlspuffin commit, per category and type (runs_report.py
// writes /html/runs/<commit>-<category>-<type>.json and index.json). #commit=<sha>&tab=<category>/<type> (a fragment:
// the publisher answers 404 to a URL with a query string)
import '../board/nav.js';
import { resolveCommits, commitLineHTML } from '../common/commitinfo.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const REPO = 'https://github.com/tlspuffin/puffin-bench';
const PALETTE = ['#ffb74d', '#a371f7', '#58a6ff', '#3fb950', '#f778ba', '#79c0ff', '#d29922', '#ff7b72'];
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs) => xs.length > 1 ? Math.sqrt(xs.reduce((a, x) => a + (x - mean(xs)) ** 2, 0) / (xs.length - 1)) : 0;
const fmtTime = (s) => s == null ? '—' : s < 10 ? s.toFixed(1) + ' s' : s < 120 ? Math.round(s) + ' s' : (s / 60).toFixed(1) + ' min';
const fmt = (x, p) => x == null || Number.isNaN(x) ? '—' : Math.abs(x) >= 1000 && p === 0 ? (x / 1000).toFixed(0) + 'k' : x.toFixed(p);
const dateUTC = (t) => t ? new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ') : '?';

// Mann-Whitney U, two-sided: exact (distribution of U by dynamic programming) for small samples, else the normal
// approximation with the correction for ties
function MannWhitney(a, b) {
  const n1 = a.length, n2 = b.length;
  if (n1 < 2 || n2 < 2) return null;
  const all = [...a.map(v => [v, 0]), ...b.map(v => [v, 1])].sort((x, y) => x[0] - y[0]);
  const ranks = new Array(all.length);
  let ties = 0;
  for (let i = 0; i < all.length;) {
    let j = i; while (j + 1 < all.length && all[j + 1][0] === all[i][0]) j++;
    for (let k = i; k <= j; k++) ranks[k] = (i + j) / 2 + 1;
    const t = j - i + 1; ties += t ** 3 - t; i = j + 1;
  }
  const r1 = all.reduce((s, x, i) => s + (x[1] === 0 ? ranks[i] : 0), 0);
  const u = r1 - n1 * (n1 + 1) / 2, umin = Math.min(u, n1 * n2 - u);
  if (ties === 0 && n1 * n2 <= 2500) {
    // count of arrangements with U = k: f(i, j, k) over i values of a and j of b
    let f = Array.from({ length: n2 + 1 }, () => [1]);
    for (let i = 1; i <= n1; i++) {
      const g = [[1]];
      for (let j = 1; j <= n2; j++) {
        const row = [];
        const left = g[j - 1], up = f[j];
        for (let k = 0; k <= i * j; k++) row[k] = (left[k] ?? 0) + (k >= j ? (up[k - j] ?? 0) : 0);
        g.push(row);
      }
      f = g;
    }
    const counts = f[n2], total = counts.reduce((x, y) => x + y, 0);
    let tail = 0; for (let k = 0; k <= Math.floor(umin); k++) tail += counts[k] ?? 0;
    return Math.min(1, 2 * tail / total);
  }
  const N = n1 + n2, mu = n1 * n2 / 2;
  const sigma = Math.sqrt(n1 * n2 / 12 * ((N + 1) - ties / (N * (N - 1))));
  if (sigma === 0) return 1;
  const z = (Math.abs(u - mu) - 0.5) / sigma;
  return Math.min(1, 2 * (1 - Phi(z)));
}
function Phi(z) { // normal CDF (Abramowitz-Stegun 7.1.26)
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const e = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z / 2);
  return z >= 0 ? (1 + e) / 2 : (1 - e) / 2;
}

function Version(task) {
  const js = task.jobscripts;
  const deployed = task.bench?.commit ? ` · deployed ${task.bench.commit.slice(0, 7)}` : '';
  if (js?.commit) {
    const how = js.from === 'md5' ? 'its job script matched to this commit (md5)' : 'recorded by the run';
    return `<a class="mono" href="${REPO}/commit/${esc(js.commit)}" target="_blank" rel="noopener" title="job scripts ${esc(js.commit)} (${esc(how)})${esc(deployed)}">${esc(js.commit.slice(0, 7))}</a>`
         + (js.dirty ? ' <span class="dirty" data-click-tip="the job scripts had local changes">+ local changes</span>' : '');
  }
  return `<span class="unk" data-click-tip="its job script (md5 ${esc(task.jobscript_md5)}) matches no commit of the history: local changes?${esc(deployed)}">unknown script <code>${esc((task.jobscript_md5 || '?').slice(0, 8))}</code></span>`;
}
const versionLabel = (k) => k.startsWith('md5:') ? `unknown script ${k.slice(4)}` : k;
const versionKey = (t) => t.jobscripts?.commit ? t.jobscripts.commit.slice(0, 7) + (t.jobscripts.dirty ? '+' : '') : 'md5:' + (t.jobscript_md5 || '?').slice(0, 8);

function SettingChanges(a, b) {
  const out = [];
  const s1 = a.settings ?? {}, s2 = b.settings ?? {};
  const time = (v) => (v ?? []).map(x => x >= 3600 ? `${Math.floor(x / 3600)}h${String(Math.round(x % 3600 / 60)).padStart(2, '0')}` : `${Math.round(x / 60)} min`).join(', ');
  if (JSON.stringify(s1.timeout) !== JSON.stringify(s2.timeout)) out.push(`timeout ${time(s1.timeout)} → ${time(s2.timeout)}`);
  if (JSON.stringify(s1.cores) !== JSON.stringify(s2.cores)) out.push(`cores ${(s1.cores ?? []).join(',')} → ${(s2.cores ?? []).join(',')}`);
  if ((s1.compat ?? '') !== (s2.compat ?? '')) out.push(`compat rules “${esc(s1.compat || 'none')}” → “${esc(s2.compat || 'none')}”`);
  if ((s1.libafl ?? '') !== (s2.libafl ?? '')) out.push(`LibAFL ${esc(s1.libafl || '?')} → ${esc(s2.libafl || '?')}`);
  return out;
}

// ── Vuln ────────────────────────────────────────────────────────────────────────────────────────────────────
const vulnTimes = (task, lib) => (task.metrics?.[lib]?.runs ?? []).map(r => r.measured).filter(x => x != null);
function VulnCell(task, lib) {
  const m = task.metrics?.[lib];
  if (!m) return '<td class="m">—</td>';
  const xs = vulnTimes(task, lib);
  const runs = m.runs ?? [];
  const nt = runs.reduce((s, r) => s + (r.not_targeted ?? 0), 0);
  const target = m.target ? `expected ${m.target.cve}` : 'no target declared';
  const toTarget = runs.map(r => fmtTime(r.to_target)).join(', ');
  const title = `${target}\ntime to find, as measured: ${runs.map(r => fmtTime(r.measured)).join(', ')}\ntime to the expected bug (today's rules): ${toTarget}` + (nt ? `\n${nt} objective(s) of CVE-2024-5814 (not the target)` : '');
  return `<td data-click-tip="${esc(title)}"><b>${xs.length}/${runs.length}</b> <span class="m">${xs.length ? fmtTime(mean(xs)) : ''}${xs.length > 1 ? ` <span class="sd">± ${fmtTime(sd(xs))}</span>` : ''}</span>${nt ? `<div class="m">+${nt} ⦸</div>` : ''}</td>`;
}
// "mean ± sd" with the sd in the unit of the mean ("118 s ± 120 s", not "118 s ± 2.0 min")
function fmtMeanSd(m, s) {
  const mins = m >= 120;
  const unit = (x) => mins ? (x / 60).toFixed(1) : x < 10 && m < 10 ? x.toFixed(1) : String(Math.round(x));
  return `${fmtTime(m)} <span class="m">± ${unit(s)}${mins ? ' min' : ' s'}</span>`;
}
// a quantile of sorted values (linear interpolation, as Plotly's box plots)
function quantile(sorted, q) {
  const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}
// Per configuration, one row per task: its runs (dots), and from 2 runs the box of the overview graphs of Results:
// quartiles (box) with the median (line), whiskers to the extreme runs, mean (dashed) ± sd (thin bar), and the
// numbers on the right; rows whose boxes overlap differ by less than their spread
function VulnStrips(tasks, libs, colors) {
  return libs.map(lib => {
    const stats = tasks.map(t => vulnTimes(t, lib)).map(xs => xs.length > 1 ? { m: mean(xs), s: sd(xs) } : null);
    const max = Math.max(60, ...tasks.flatMap(t => vulnTimes(t, lib)), ...stats.filter(Boolean).map(({ m, s }) => m + s));
    const pc = (x) => (Math.min(Math.max(x, 0), max) / max * 100).toFixed(1);
    const rows = tasks.map((t, i) => {
      const xs = vulnTimes(t, lib), color = colors.get(versionKey(t));
      const dots = xs.map(x => `<span class="dot" style="left:${pc(x)}%;background:${color}" title="${esc(t.id)}: ${fmtTime(x)}"></span>`).join('');
      let box = '', label = xs.length === 1 ? `<span class="stat">${fmtTime(xs[0])} <span class="m">(1 run)</span></span>` : '<span class="stat m">—</span>';
      if (stats[i]) {
        const sorted = [...xs].sort((a, b) => a - b), { m, s } = stats[i];
        const q1 = quantile(sorted, 0.25), med = quantile(sorted, 0.5), q3 = quantile(sorted, 0.75);
        const tip = `${esc(t.id)}: ${xs.length} runs · mean ${fmtTime(m)} ± sd ${fmtTime(s)} · median ${fmtTime(med)} · quartiles ${fmtTime(q1)}–${fmtTime(q3)} · ${fmtTime(sorted[0])} to ${fmtTime(sorted[sorted.length - 1])}`;
        box = `<span class="whisk" style="left:${pc(sorted[0])}%;width:${(pc(sorted[sorted.length - 1]) - pc(sorted[0])).toFixed(1)}%"></span>`
            + `<span class="iqr" style="left:${pc(q1)}%;width:${(pc(q3) - pc(q1)).toFixed(1)}%;border-color:${color}" title="${tip}"></span>`
            + `<span class="med" style="left:${pc(med)}%;background:${color}"></span>`
            // ± sd within the runs: with a skewed distribution (one long run) mean - sd falls below the fastest run,
            // even below 0: the bar is cut at the extreme runs, an open end where it is
            + (() => {
              const lo = Math.max(m - s, sorted[0]), hi = Math.min(m + s, sorted[sorted.length - 1]);
              const cut = `${m - s < sorted[0] ? ' cut-lo' : ''}${m + s > sorted[sorted.length - 1] ? ' cut-hi' : ''}`;
              return `<span class="sdbar${cut}" style="left:${pc(lo)}%;width:${(pc(hi) - pc(lo)).toFixed(1)}%" title="mean ± sd: ${fmtTime(Math.max(0, m - s))} to ${fmtTime(m + s)}${m - s < 0 ? ' (mean - sd below 0)' : ''}; shown within the runs"></span>`;
            })()
            + `<span class="meanl" style="left:${pc(m)}%"></span>`;
        label = `<span class="stat" title="${tip}">${fmtMeanSd(m, s)}</span>`;
      }
      return `<div class="strip"><span class="lbl">${esc(t.id.slice(-5))}</span><div class="axis">${box}${dots}</div>${label}</div>`;
    }).join('');
    return `<div class="box"><b>${esc(lib)}</b> <span class="m">time to find of each run (0 → ${fmtTime(max)}) · box: quartiles and median, whiskers: extreme runs, dashed: mean, thin bar: ± sd within the runs (open end: cut)</span>${rows}<div class="scale"><span>0</span><span>${fmtTime(max / 2)}</span><span>${fmtTime(max)}</span></div></div>`;
  }).join('');
}

// ── Perf ────────────────────────────────────────────────────────────────────────────────────────────────────
const PERF_METRICS = [
  ['coverage', 'coverage at the end', '%', 2, true], ['coverage_10min', 'coverage at 10 min', '%', 2, true],
  ['corpus', 'corpus at the end', '', 0, false], ['execs', 'total execs', '', 0, false],
  ['execs_s', 'execs / s', '', 0, false], ['success', 'successful executions', '%', 1, false],
];
function PerfCell(task, lib) {
  const m = task.metrics?.[lib];
  if (!m || !m.coverage?.length) return `<td class="m">${m ? `${m.runs}/${m.runs_total} runs` : '—'}</td>`;
  return `<td><b>${fmt(mean(m.coverage), 2)}</b><span class="sd">±${fmt(sd(m.coverage), 2)}</span> %<div class="m">${fmt(mean(m.execs_s), 0)} execs/s · ${m.runs}/${m.runs_total} runs</div></td>`;
}
function Bars(tasks, lib, key, unit, prec, zoom, colors) {
  const W = 170, H = 118, L = 6, B = 16, T = 14;
  const vals = tasks.filter(t => t.metrics?.[lib]?.[key]?.length).map(t => [mean(t.metrics[lib][key]), sd(t.metrics[lib][key]), t]);
  if (!vals.length) return '<span class="m">—</span>';
  let hi = Math.max(...vals.map(([m, s]) => m + s)), lo = Math.min(...vals.map(([m, s]) => m - s));
  const base = 0;  // every axis starts at 0: a zoomed axis makes bars look more different than they are
  hi = hi + (hi - base) * 0.05 || 1;
  const Y = (v) => T + (H - T - B) * (1 - (v - base) / (hi - base));
  const bw = (W - 2 * L) / vals.length;
  const g = [`<line x1="${L}" y1="${H - B}" x2="${W - L}" y2="${H - B}" stroke="#333"/>`];
  vals.forEach(([m, s, t], i) => {
    const x = L + i * bw + bw * 0.18, w = bw * 0.64, cx = x + w / 2;
    g.push(`<rect x="${x.toFixed(1)}" y="${Y(m).toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(0, (H - B) - Y(m)).toFixed(1)}" fill="${colors.get(versionKey(t))}" opacity=".85"><title>${esc(t.id)} · ${esc(versionKey(t))}: ${fmt(m, prec)}${unit} ± ${fmt(s, prec)}</title></rect>`);
    g.push(`<line x1="${cx.toFixed(1)}" y1="${Y(m + s).toFixed(1)}" x2="${cx.toFixed(1)}" y2="${Y(Math.max(base, m - s)).toFixed(1)}" stroke="#e8e8e8"/>`);
    g.push(`<text x="${cx.toFixed(1)}" y="${(Y(m + s) - 3).toFixed(1)}" class="v" text-anchor="middle">${fmt(m, prec)}</text>`);
    if (vals.length <= 8) g.push(`<text x="${cx.toFixed(1)}" y="${H - 4}" class="ax" text-anchor="middle">${esc(t.id.slice(-5))}</text>`);
  });
  return `<svg width="${W}" height="${H}">${g.join('')}</svg>`;
}

// differences between two consecutive tasks that are significant (p < 0.05)
function Significant(a, b, type, libs) {
  const out = [];
  for (const lib of libs) {
    const pairs = type === 'Vuln' ? [['time to find', vulnTimes(a, lib), vulnTimes(b, lib)]]
        // per run (the mean of its 3 clients), not per client: the clients of a run share its coverage map and corpus
        // (ICC 0.55 to 1.00 on the 27 Perf tasks of cassis, 2026-10-07); per client, 18 to 28 % of the tests of two
        // samples of the same task came out "significant" at p < 0.05, per run 3 %
        : PERF_METRICS.map(([k, label]) => [label, a.metrics?.[lib]?.per_run?.[k] ?? [], b.metrics?.[lib]?.per_run?.[k] ?? []]);
    for (const [label, x, y] of pairs) {
      const p = MannWhitney(x, y);
      if (p != null && p < 0.05) out.push(`${esc(lib)} ${esc(label)} ${mean(y) > mean(x) ? '↑' : '↓'} ${p < 0.001 ? 'p<0.001' : 'p=' + p.toFixed(3)}`);
    }
  }
  return out;
}

async function Render() {
  const root = document.getElementById('runs');
  const params = new URLSearchParams(location.hash.slice(1) || location.search);
  const commit = (params.get('commit') ?? '').toLowerCase();
  let index = {};
  try { index = await (await fetch('index.json', { cache: 'no-store' })).json(); } catch (error) {}
  const full = Object.keys(index).find(c => c === commit || (commit.length >= 7 && c.startsWith(commit)));
  if (!full) {
    root.innerHTML = `<div class="wrap"><p class="unk">No runs kept for commit ${esc(commit)}.</p></div>`;
    return;
  }
  const tabs = Object.keys(index[full]).sort((x, y) => (x.startsWith('PR/') ? 0 : 1) - (y.startsWith('PR/') ? 0 : 1) || x.localeCompare(y));
  const tab = tabs.includes(params.get('tab')) ? params.get('tab') : tabs.find(t => t.endsWith('/' + params.get('type'))) ?? tabs[0];
  const [category, type] = tab.split('/');
  let data;
  try { data = await (await fetch(`${full}-${category}-${type}.json`, { cache: 'no-store' })).json(); } catch (error) {
    root.innerHTML = `<div class="wrap"><p class="unk">Cannot read the runs: ${esc(error.message)}</p></div>`;
    return;
  }
  const tasks = data.tasks ?? [];
  const libs = [...new Set(tasks.flatMap(t => Object.keys(t.metrics ?? {})))].sort();
  const colors = new Map();
  tasks.forEach(t => { if (!colors.has(versionKey(t))) colors.set(versionKey(t), PALETTE[colors.size % PALETTE.length]); });
  const latest = [...tasks].reverse().find(t => t.metrics);
  const scheduler = `${location.protocol}//${location.hostname}:10082`;
  const rows = [];
  tasks.forEach((t, i) => {
    const prev = tasks[i - 1];
    if (prev) {
      const changed = versionKey(prev) !== versionKey(t);
      const settings = SettingChanges(prev, t);
      const sig = prev.metrics && t.metrics ? Significant(prev, t, type, libs) : [];
      const what = changed
          ? `⚙ job scripts ${esc(versionLabel(versionKey(prev)))} → ${esc(versionLabel(versionKey(t)))}` + (prev.jobscripts?.commit && t.jobscripts?.commit ? ` · <a href="${REPO}/compare/${esc(prev.jobscripts.commit)}...${esc(t.jobscripts.commit)}" target="_blank" rel="noopener">compare ↗</a>` : '')
          : 'same job scripts';
      if (changed || settings.length || sig.length) {
        rows.push(`<tr class="sep${changed ? '' : ' same'}"><td colspan="${3 + libs.length}">${what}${settings.length ? ' · ' + settings.join(' · ') : ''}`
          + (prev.metrics && t.metrics ? (sig.length ? ` · significant: ${sig.join(', ')}` : ' · no significant difference') : '') + '</td></tr>');
      }
    }
    const cells = t.metrics ? libs.map(lib => type === 'Vuln' ? VulnCell(t, lib) : PerfCell(t, lib)).join('')
        : `<td colspan="${libs.length}" class="m">no results (the task has no summary: cancelled or failed)</td>`;
    rows.push(`<tr><td class="date">${dateUTC(t.start)}</td><td><a href="${scheduler}/files/board/task.html?id=${esc(t.id)}" target="_blank" rel="noopener">${esc(t.id)}</a>${t === latest ? '<span class="shown">shown on Results</span>' : ''}<div class="m">${esc(t.user)}${/^PR@/.test(t.name) ? ' · PR job' : ''}</div></td><td>${Version(t)}</td>${cells}</tr>`);
  });
  const legend = [...colors.entries()].map(([k, c]) => `<span><i style="background:${c}"></i>${esc(k.startsWith('md5:') ? 'unknown script ' + k.slice(4) : k)}</span>`).join('');
  const charts = type === 'Vuln'
      ? `<h2>Time to find of each run, per configuration (colour: job scripts)</h2><div class="legend">${legend}</div><div class="libs">${VulnStrips(tasks, libs, colors)}</div>`
      : `<h2>The runs side by side (X: the tasks, oldest first) · mean ± sd over the clients of their runs</h2><div class="legend">${legend}</div>
         <table class="bars"><tr><th></th>${libs.map(l => `<th>${esc(l)}</th>`).join('')}</tr>${PERF_METRICS.map(([k, label, unit, prec, zoom]) =>
           `<tr><th class="mt">${label}${unit ? ` (${unit})` : ''}</th>${libs.map(l => `<td>${Bars(tasks.filter(t => t.metrics), l, k, unit, prec, zoom, colors)}</td>`).join('')}</tr>`).join('')}</table>`;
  const head = type === 'Vuln' ? 'runs that found the bug / runs, time to find (mean ± sd) as measured by that run' : 'coverage at the end (mean ± sd over the clients), execs/s, successful runs';
  document.title = `Runs of ${full.slice(0, 7)} · ${tab}`;
  root.innerHTML = `<div class="wrap">
    <h1>Runs of tlspuffin <span id="commit-line"><a class="mono" href="https://github.com/tlspuffin/tlspuffin/commit/${esc(full)}" target="_blank" rel="noopener">${esc(full.slice(0, 7))}</a></span></h1>
    <div class="muted">${tasks.length} task(s) kept by the publisher · ${head} · between two rows: what changed and the significant differences (two-sided Mann-Whitney, p &lt; 0.05, ${type === 'Vuln' ? 'on the runs: 5 per configuration' : 'on the runs (the mean of their 3 clients): 5 per library'}; with many tests, a lone p near 0.05 can be chance)</div>
    <div class="tabs">${tabs.map(t => `<a class="tab${t === tab ? ' on' : ''}" href="#commit=${esc(full)}&tab=${esc(t)}">${esc(t.startsWith('PR/') ? t.slice(3) : t.replace('/', ' '))} (${index[full][t]})</a>`).join('')}</div>
    <table class="runs"><tr><th>run (UTC)</th><th>task</th><th>puffin-bench</th>${libs.map(l => `<th>${esc(l)}</th>`).join('')}</tr>${rows.join('')}</table>
    ${charts}
  </div>`;
  // the commit line: PR and message (git_restapi)
  try {
    const desc = (await resolveCommits(`${location.protocol}//${location.hostname}:10081`, 'tlspuffin', [full]))?.get(full);
    if (desc && desc.kind !== 'unknown') document.getElementById('commit-line').innerHTML = commitLineHTML(desc, { link: true });
  } catch (error) {}
}

Render();
window.addEventListener('hashchange', () => Render());
