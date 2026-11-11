// Custom Vuln benchmarks (job type "vuln-custom", jobsconfig.json custom_benchmark): the known bugs of tlspuffin's
// vulnerability catalogue (git_restapi /api/git/catalogue, dev's or the commit's) as a table to tick; each ticked bug
// becomes one experiment of the task, built and run the way it needs:
//   - on a preset of the commit where it is active (its version in `affected`, the build options of `requires`; ASan
//     presets only when `find.asan`), by default the newest one, ASan first;
//   - with every other known bug that has a patch at that version patched (`<preset>-only-<ID>`), or as in the preset;
//   - with the fuzzer flags and cargo features of its `find`;
//   - stopping on its own oracle (job scripts: target_bug, target_oracle), confirmed after each attempt by the
//     validation step (patch differential, or its signature when it has no patch).
// A bug's needs are footnote marks under the table, one per distinct set. Every field of a bug: the Bugs reference
// page. The experiments are the task's configurations (runtime RUNTIME_RUN_CONFIG, see runConfig), named
// <benchmark>_<alias or ID>, and the definition is recorded in the task (definition) so that it can be launched again.

const esc = text => String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const LIBRARY = { wolfssl: 'wolfSSL', openssl: 'OpenSSL', libressl: 'LibreSSL', boringssl: 'BoringSSL', libssh: 'libssh', wolfssh: 'wolfSSH' };
const libraryName = vendor => LIBRARY[vendor] ?? vendor;
const MARKS = ['*', '†', '‡', '§', '¶', '‖', '**', '††', '‡‡'];

// ── Versions and ranges, as the catalogue (puffin-build/src/catalogue/version.rs) ──
// A version: dotted numbers (missing ones are 0), then letters (a patch release after it, OpenSSL: 1.0.1 < 1.0.1a,
// 0.9.8z < 0.9.8za) or -<pre-release> (before it); not starting with a digit (master): newer than every release.
export function parseVersion(text) {
  const t = String(text ?? '').trim();
  if (!/^[0-9]/.test(t)) return { head: true };
  const m = /^([0-9]+(?:\.[0-9]+)*)(.*)$/.exec(t);
  const numbers = m[1].split('.').map(Number);
  while (numbers.length > 1 && numbers[numbers.length - 1] === 0) numbers.pop();
  const rest = m[2];
  const suffix = rest === '' ? { rank: 1 } : rest.startsWith('-') ? { rank: 0, text: rest.slice(1) } : { rank: 2, text: rest };
  return { numbers, suffix };
}
export function compareVersions(a, b) {
  const x = typeof a === 'string' ? parseVersion(a) : a, y = typeof b === 'string' ? parseVersion(b) : b;
  if (x.head || y.head) return (x.head ? 1 : 0) - (y.head ? 1 : 0);
  for (let i = 0; i < Math.min(x.numbers.length, y.numbers.length); i++) {
    if (x.numbers[i] !== y.numbers[i]) return x.numbers[i] < y.numbers[i] ? -1 : 1;
  }
  if (x.numbers.length !== y.numbers.length) return x.numbers.length < y.numbers.length ? -1 : 1;
  if (x.suffix.rank !== y.suffix.rank) return x.suffix.rank < y.suffix.rank ? -1 : 1;
  if (x.suffix.rank === 2 && x.suffix.text.length !== y.suffix.text.length) return x.suffix.text.length < y.suffix.text.length ? -1 : 1;
  return x.suffix.text === y.suffix.text ? 0 : (x.suffix.text ?? '') < (y.suffix.text ?? '') ? -1 : 1;
}
// a range: alternatives separated by ||, each comparisons separated by , that must all hold (>= 1.0.0, < 1.0.0p)
export function inRange(range, version) {
  if (!range) return false;
  return String(range).split('||').some(alternative => alternative.split(',').every(comparison => {
    const m = /^\s*(<=|>=|<|>|=)\s*(\S+)\s*$/.exec(comparison);
    if (!m) return false;
    const c = compareVersions(version, m[2]);
    return { '<': c < 0, '<=': c <= 0, '>': c > 0, '>=': c >= 0, '=': c === 0 }[m[1]];
  }));
}

// whether a bug is in the code a preset builds: its version is affected, it has the build options the bug requires,
// it does not fix it (PUT capabilities: the build tells, see PR_common.sh ForcedBuild)
export function presentOn(id, entry, preset) {
  if (entry.affected && !inRange(entry.affected, preset.version)) return false;
  for (const [option, value] of Object.entries(entry.requires ?? {})) if (preset[option] !== value) return false;
  return !(preset.fix ?? []).includes(id);
}
// whether a preset is offered to look for a bug: the bug is in its code, and it is an ASan build when the bug is only
// detected with ASan (find.asan)
export function activeOn(id, entry, preset) {
  return presentOn(id, entry, preset) && !(entry.find?.asan && !preset.asan);
}
// whether a bug is only recognised with ASan (its oracle is an ASan report, or find.asan): its experiments are built
// with ASan whatever the preset (mk_vendor make --asan, job scripts: asan_build)
export function needsAsan(entry) { return !!(entry.oracle?.asan || entry.find?.asan); }
// whether a bug has a patch at a version (its finds are then validated by patch differential)
export function patchedAt(entry, version) { return (entry.patches ?? []).some(p => p.versions && inRange(p.versions, version)); }

const duration = s => {
  if (s === null || s === undefined || !Number.isFinite(Number(s))) return '—';
  if (Number(s) < 1) return '< 1 s';
  const t = Math.round(Number(s));
  return t < 60 ? `${t} s` : t < 3600 ? `${Math.floor(t / 60)} min ${String(t % 60).padStart(2, '0')} s`
    : `${Math.floor(t / 3600)} h ${String(Math.floor(t % 3600 / 60)).padStart(2, '0')}`;
};

export class CustomBenchmark {
  node;
  #gitOrigin;
  #onChange;
  #sha = null;
  #presets = null;              // { vendors: { <lib>: [ { name, version, asan, postauth, fix, ... } ] } } of the commit
  #catalogues = { commit: null, dev: null };
  #source = 'dev';              // the catalogue the bugs come from: 'dev' or 'commit'
  #times = null;                // the bench's times to find (/html/runs/bench_times.json), when there are
  #picked = new Map();          // ID -> { preset } of the ticked bugs
  #error = '';
  #loading = false;
  #els = {};

  constructor({ gitOrigin, onChange }) {
    this.#gitOrigin = gitOrigin;
    this.#onChange = onChange ?? (() => {});
    this.node = document.createElement('div');
    this.node.className = 'jl-custom';
    this.node.innerHTML = `
      <div class="jl-custom-row">
        <span class="jl-label">Catalogue</span>
        <label><input type="radio" name="jl-custom-source" value="dev"> <span class="jl-custom-dev">dev's</span></label>
        <label><input type="radio" name="jl-custom-source" value="commit"> this commit's</label>
        <button type="button" class="jl-custom-load" title="The catalogue of the chosen commit (e.g. a PR adding a bug): its bugs, compared with dev's">Load bugs from this commit</button>
        <span class="jl-custom-badge"></span>
        <a class="jl-custom-details" target="_blank" rel="noopener">📖 Every detail of each bug: Bugs reference ↗</a>
      </div>
      <div class="jl-custom-row">
        <span class="jl-label">Show</span>
        <select class="jl-select jl-custom-lib"><option value="">all libraries</option></select>
        <select class="jl-select jl-custom-cat"><option value="">all categories</option></select>
        <label><input type="checkbox" class="jl-custom-puffin"> ★ first found by puffin only</label>
        <label><input type="checkbox" class="jl-custom-nowitness"> bugs without witness</label>
      </div>
      <div class="jl-custom-status"></div>
      <table class="jl-custom-bugs"></table>
      <div class="jl-custom-footnotes"></div>
      <div class="jl-custom-row">
        <span class="jl-label">Other known bugs</span>
        <label><input type="radio" name="jl-custom-others" value="patched" checked> patched where a patch exists (recommended: an experiment can only stop on its own bug)</label>
        <label><input type="radio" name="jl-custom-others" value="preset"> as in the preset</label>
      </div>
      <h4 class="jl-custom-h">What will run</h4>
      <table class="jl-custom-runs"></table>
      <div class="jl-custom-note">An attempt counts as "found at t" only when the validation step confirms its stop (patch differential),
        or, for a bug without patch, when the stop has the bug's signature. A stop it does not confirm is shown as such, never as a find.
        <label class="jl-custom-disabled"><input type="checkbox" disabled> Confirm during the attempt (replay on the build with every patch before stopping): not available yet</label></div>
      <div class="jl-custom-row">
        <span class="jl-label">Attempts</span><input type="number" class="jl-commit-input jl-custom-attempts" min="1" max="50" value="5">
        <span class="jl-label">Cores per attempt</span><input type="number" class="jl-commit-input jl-custom-cores" min="1" max="64" value="4">
        <span class="jl-custom-cost"></span>
      </div>
      <div class="jl-custom-row">
        <span class="jl-label">Benchmark</span><input type="text" class="jl-commit-input jl-custom-name" value="custom" maxlength="24" spellcheck="false"
          title="Its name (letters, digits, -): the experiments are named <benchmark>_<bug>; launching it again with the same name continues its series on Results">
        <input type="text" class="jl-commit-input jl-custom-description" placeholder="description (optional)" maxlength="200">
      </div>`;
    const $ = selector => this.node.querySelector(selector);
    this.#els = {
      badge: $('.jl-custom-badge'), details: $('.jl-custom-details'), status: $('.jl-custom-status'), bugs: $('.jl-custom-bugs'),
      footnotes: $('.jl-custom-footnotes'), runs: $('.jl-custom-runs'), lib: $('.jl-custom-lib'), cat: $('.jl-custom-cat'),
      puffin: $('.jl-custom-puffin'), nowitness: $('.jl-custom-nowitness'), attempts: $('.jl-custom-attempts'),
      cores: $('.jl-custom-cores'), cost: $('.jl-custom-cost'), name: $('.jl-custom-name'), description: $('.jl-custom-description'),
      dev: $('.jl-custom-dev'), load: $('.jl-custom-load'),
    };
    this.node.querySelectorAll('input[name="jl-custom-source"]').forEach(radio =>
      radio.addEventListener('change', () => { this.#source = radio.value; this.#picked.clear(); this.#render(); }));
    this.#els.load.addEventListener('click', () => { this.#source = 'commit'; this.#picked.clear(); this.#render(); });
    for (const el of [this.#els.lib, this.#els.cat, this.#els.puffin, this.#els.nowitness]) el.addEventListener('change', () => this.#render());
    this.node.querySelectorAll('input[name="jl-custom-others"]').forEach(radio => radio.addEventListener('change', () => this.#render()));
    for (const el of [this.#els.attempts, this.#els.cores]) el.addEventListener('input', () => this.#renderRuns());
    this.#els.name.addEventListener('input', () => {
      this.#els.name.value = this.#els.name.value.replace(/[^A-Za-z0-9-]/g, '');
      this.#renderRuns();
    });
    this.#els.bugs.addEventListener('change', event => {
      const row = event.target.closest('tr[data-id]');
      if (!row) return;
      const id = row.dataset.id;
      if (event.target.matches('input[type="checkbox"]')) {
        if (event.target.checked) this.#picked.set(id, { preset: row.querySelector('select').value });
        else this.#picked.delete(id);
        row.classList.toggle('picked', event.target.checked);
      } else if (event.target.matches('select') && this.#picked.has(id)) {
        this.#picked.get(id).preset = event.target.value;
      }
      this.#renderRuns();
    });
    fetch('/html/runs/bench_times.json', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null)
      .then(times => { this.#times = times; if (this.#sha) this.#render(); });
  }

  show(visible) { this.node.classList.toggle('visible', visible); }

  reset() {
    this.#picked.clear();
    this.#els.name.value = 'custom';
    this.#els.description.value = '';
    this.#render();
  }

  // the commit whose presets and catalogue are offered (null: none chosen yet)
  setCommit(sha) {
    if (sha === this.#sha) return;
    this.#sha = sha;
    this.#presets = null;
    this.#catalogues = { commit: null, dev: null };
    this.#picked.clear();
    this.#error = '';
    if (!sha) { this.#render(); return; }
    this.#loading = true;
    this.#render();
    const get = url => fetch(url).then(r => r.ok ? r.json() : null).catch(() => null);
    Promise.all([get(`${this.#gitOrigin}/api/git/presets/tlspuffin/${sha}`), get(`${this.#gitOrigin}/api/git/catalogue/tlspuffin/${sha}`),
                 get(`${this.#gitOrigin}/api/git/catalogue/tlspuffin/dev`)]).then(([presets, commit, dev]) => {
      if (this.#sha !== sha) return;
      this.#loading = false;
      this.#presets = presets;
      this.#catalogues = { commit, dev };
      if (!presets || !commit) this.#error = 'git_restapi did not answer the presets or the catalogue of this commit';
      // dev's catalogue by default (what validation trusts), the commit's when dev has none
      this.#source = dev?.format === 'vulnerabilities.toml' ? 'dev' : 'commit';
      this.#render();
    });
  }

  get valid() { return !this.#loading && this.#experiments().length > 0 && this.#els.name.value.length > 0; }
  get attempts() { return Math.max(1, parseInt(this.#els.attempts.value, 10) || 1); }
  get cores() { return Math.max(1, parseInt(this.#els.cores.value, 10) || 1); }
  get name() { return this.#els.name.value || 'custom'; }

  // the task's configurations (runtime RUNTIME_RUN_CONFIG): one per experiment
  runConfig() {
    return Object.fromEntries(this.#experiments().map(x => [x.name, { args: x.args, nb_cores: this.cores }]));
  }

  // what is recorded with the task (launcher.custom.customBenchmark): enough to launch it again and to compare its runs
  definition() {
    const catalogue = this.#catalogue();
    return {
      name: this.name, description: this.#els.description.value.trim(), others: this.#others(),
      catalogue: { source: this.#source, commit: catalogue?.commit ?? null },
      attempts: this.attempts, cores: this.cores,
      experiments: this.#experiments().map(x => ({ name: x.name, bug: x.id, vendor: x.args.vendor, preset: x.preset.name,
        version: x.preset.version, asan: !!x.preset.asan || needsAsan(x.entry), oracle: x.entry.oracle, flags: x.entry.find?.flags ?? [],
        features: x.entry.find?.features ?? [], fingerprint: x.entry.fingerprint ?? null })),
    };
  }

  // a definition recorded with an earlier task ("New task…" from it): the same bugs, versions and settings
  restore(definition) {
    if (!definition) return;
    this.#els.name.value = definition.name ?? 'custom';
    this.#els.description.value = definition.description ?? '';
    this.#els.attempts.value = definition.attempts ?? 5;
    this.#els.cores.value = definition.cores ?? 4;
    const others = this.node.querySelector(`input[name="jl-custom-others"][value="${definition.others === 'preset' ? 'preset' : 'patched'}"]`);
    if (others) others.checked = true;
    const apply = () => {
      if (definition.catalogue?.source) this.#source = definition.catalogue.source;
      this.#picked.clear();
      for (const x of definition.experiments ?? []) this.#picked.set(x.bug, { preset: x.preset });
      this.#render();
    };
    if (this.#loading) {
      const wait = setInterval(() => { if (!this.#loading) { clearInterval(wait); apply(); } }, 100);
    } else {
      apply();
    }
  }

  // ── data ──
  #catalogue() { return this.#catalogues[this.#source]; }
  #others() { return this.node.querySelector('input[name="jl-custom-others"]:checked')?.value ?? 'patched'; }

  // every entry of the catalogue shown, with where it can run
  #entries() {
    const catalogue = this.#catalogue();
    if (!catalogue || catalogue.format !== 'vulnerabilities.toml') return [];
    return Object.entries(catalogue.vendors ?? {}).flatMap(([lib, v]) => Object.entries(v.entries ?? {}).map(([id, entry]) => {
      const presets = (this.#presets?.vendors?.[lib] ?? []).filter(p => this.#active(id, entry, p));
      const options = presets.map(p => ({ ...p, patched: this.#patchedAt(entry, p.version),
                                          witness: !entry.witness_versions || inRange(entry.witness_versions, p.version) }))
        .sort((a, b) => compareVersions(b.version, a.version) || (b.asan ? 1 : 0) - (a.asan ? 1 : 0)
                       || (a.fix?.length ?? 0) - (b.fix?.length ?? 0) || a.name.length - b.name.length);
      const reference = options.find(p => p.name === entry.reference) ?? options[0] ?? null;
      return { lib, id, entry, options, reference };
    }));
  }

  #active(id, entry, preset) { return activeOn(id, entry, preset); }
  #patchedAt(entry, version) { return patchedAt(entry, version); }

  // the ticked bugs, as experiments
  #experiments() {
    const bench = this.name, others = this.#others();
    return this.#entries().filter(x => this.#picked.has(x.id)).flatMap(x => {
      const preset = x.options.find(p => p.name === this.#picked.get(x.id).preset) ?? x.reference;
      if (!preset) return [];
      const name = `${bench}_${x.entry.alias ?? x.id}`;
      const find = x.entry.find ?? {};
      return [{ ...x, preset, name, args: {
        experiment: name,
        vendor: others === 'preset' ? `${x.lib}:${preset.name}` : `${x.lib}:${preset.name}-only-${x.id}`,
        features: '',
        ...((find.features ?? []).length ? { required_features: find.features.join(',') } : {}),
        ...((find.flags ?? []).length ? { extra_flags: find.flags.map(f => `'${f}'`).join(' ') } : {}),
        ...(needsAsan(x.entry) && !preset.asan ? { asan_build: 'true' } : {}),
        target_bug: x.id,
        target_oracle: JSON.stringify(x.entry.oracle ?? null),
        catalogue_source: this.#source,
        benchmark: bench,
      } }];
    });
  }

  // the other known bugs of an experiment's build: patched by the derivation or by the preset, left without patch
  #neighbours(x) {
    const patched = [], left = [];
    for (const y of this.#entries()) {
      if (y.lib !== x.lib || y.id === x.id) continue;
      const inPreset = x.options.length && (x.preset.fix ?? []).includes(y.id);
      if (!inPreset && !presentOn(y.id, y.entry, x.preset)) continue;
      const label = y.entry.alias ?? y.id;
      if (inPreset || (this.#others() === 'patched' && this.#patchedAt(y.entry, x.preset.version))) patched.push(label);
      else left.push(`${label}${this.#patchedAt(y.entry, x.preset.version) ? '' : ' (no patch)'}`);
    }
    return { patched, left };
  }

  // the footnote marks: one per distinct set of needs (build options, PUT options, fuzzer flags, cargo features, ASan)
  #needs(entry) {
    const find = entry.find ?? {};
    const parts = [];
    const requires = Object.entries(entry.requires ?? {});
    if (requires.length) parts.push(`built with ${requires.map(([k, v]) => `<code>${esc(k)} = ${esc(v)}</code>`).join(', ')}`);
    const putOptions = Object.entries(entry.put_options ?? {});
    if (putOptions.length) parts.push(`PUT option${putOptions.length > 1 ? 's' : ''} ${putOptions.map(([k, v]) => `<code>${esc(k)} = ${esc(v)}</code>`).join(', ')}`);
    if ((find.flags ?? []).length) parts.push(`fuzzer flag${find.flags.length > 1 ? 's' : ''} ${find.flags.map(f => `<code>${esc(f)}</code>`).join(' ')}`);
    if ((find.features ?? []).length) parts.push(`cargo feature${find.features.length > 1 ? 's' : ''} ${find.features.map(f => `<code>${esc(f)}</code>`).join(', ')}`);
    if (find.asan) parts.push('only detected with ASan: ASan builds only');
    return parts.length ? parts.join(', ') : null;
  }

  // ── rendering ──
  #render() {
    const els = this.#els;
    const dev = this.#catalogues.dev, commit = this.#catalogues.commit;
    const devRadio = this.node.querySelector('input[name="jl-custom-source"][value="dev"]');
    const devHas = dev?.format === 'vulnerabilities.toml';
    devRadio.disabled = !devHas;
    els.dev.textContent = !dev ? "dev's" : devHas ? `dev's (${dev.commit.slice(0, 7)})` : `dev's — none yet (${dev.commit.slice(0, 7)} has no vulnerabilities.toml)`;
    for (const radio of this.node.querySelectorAll('input[name="jl-custom-source"]')) radio.checked = radio.value === this.#source;
    els.details.href = `/html/publisher/bugs.html${this.#source === 'commit' && this.#sha ? `?commit=${encodeURIComponent(this.#sha)}` : ''}`;

    if (!this.#sha) { this.#status('Choose a commit: the bugs of its catalogue and the presets it can build come from it.'); return; }
    if (this.#loading) { this.#status('Loading the presets and the catalogue of the commit…'); return; }
    if (this.#error) { this.#status(this.#error); return; }
    const catalogue = this.#catalogue();
    if (!catalogue || catalogue.format !== 'vulnerabilities.toml') {
      this.#status(`${this.#source === 'dev' ? 'dev' : `This commit (${this.#sha.slice(0, 7)})`} has no vulnerability catalogue (before tlspuffin pr/vuln-catalogue): no custom benchmark.`);
      return;
    }
    els.status.textContent = '';
    const entries = this.#entries();
    // compared with dev's catalogue: the same entry (fingerprint), another version of it, not in dev
    const devEntry = (lib, id) => devHas ? dev.vendors?.[lib]?.entries?.[id] : null;
    const versus = x => this.#source === 'dev' ? '' : !devEntry(x.lib, x.id) ? 'new' : devEntry(x.lib, x.id).fingerprint === x.entry.fingerprint ? 'same' : 'differs';
    const count = kind => entries.filter(x => versus(x) === kind).length;
    els.badge.innerHTML = this.#source === 'dev' ? `<span class="jl-badge">${entries.length} bugs</span>`
      : `<span class="jl-badge new">${count('new')} only in this commit</span> <span class="jl-badge warn">${count('differs')} differ from dev</span> <span class="jl-badge">${count('same')} same as dev</span>`;

    // filters
    const libs = [...new Set(entries.map(x => x.lib))], cats = [...new Set(entries.map(x => x.entry.category))].sort();
    const keep = (select, values, label, show = v => v) => {
      const value = select.value;
      select.innerHTML = `<option value="">${label}</option>` + values.map(v => `<option value="${esc(v)}">${esc(show(v))}</option>`).join('');
      select.value = values.includes(value) ? value : '';
    };
    keep(els.lib, libs, 'all libraries', libraryName);
    keep(els.cat, cats, 'all categories');
    const shown = entries.filter(x => (!els.lib.value || x.lib === els.lib.value) && (!els.cat.value || x.entry.category === els.cat.value)
      && (!els.puffin.checked || x.entry.find?.by_puffin) && (els.nowitness.checked || !x.entry.no_witness));
    const hidden = entries.filter(x => x.entry.no_witness && !els.nowitness.checked);

    // footnote marks, in table order
    const marks = new Map();
    for (const x of shown) { const needs = this.#needs(x.entry); if (needs && !marks.has(needs)) marks.set(needs, MARKS[marks.size] ?? `(${marks.size + 1})`); }
    const timeOf = x => this.#times?.bugs?.[x.entry.alias ?? x.id] ?? this.#times?.bugs?.[x.id];
    const harness = shown.filter(x => x.entry.bug_in_harness), library = shown.filter(x => !x.entry.bug_in_harness);
    const row = x => {
      const picked = this.#picked.get(x.id);
      const needs = this.#needs(x.entry);
      const t = timeOf(x);
      const options = x.options.map(p => `<option value="${esc(p.name)}"${(picked?.preset ?? x.reference?.name) === p.name ? ' selected' : ''}>`
        + `${esc(p.version)} · ${p.asan ? 'ASan · ' : ''}${esc(p.name)}${!p.asan && needsAsan(x.entry) ? ' + ASan' : ''}`
        + `${p.patched ? '' : ' (no patch: signature only)'}${p.witness ? '' : ' (witness does not reach it)'}</option>`).join('');
      const confirm = !x.entry.oracle ? '<span class="jl-badge warn">no oracle: cannot be recognised</span>'
        : x.entry.replayable === false ? '<span class="jl-badge warn">the fuzzer\'s record only: not replayable</span>'
        : (x.entry.patches ?? []).length ? `<span class="jl-badge ok">its patch (${(x.entry.patches ?? []).map(p => esc(p.versions ?? p.commits ?? '')).join(' · ')})</span>`
        : '<span class="jl-badge warn">signature only: no patch</span>';
      const twins = this.#sameOracle(x).map(y => esc(y.entry.alias ?? y.id));
      const vs = versus(x);
      return `<tr data-id="${esc(x.id)}" class="${picked ? 'picked' : ''}${x.options.length ? '' : ' na'}">
        <td><input type="checkbox"${picked ? ' checked' : ''}${x.options.length && !x.entry.no_witness && x.entry.oracle ? '' : ' disabled'}></td>
        <td><a class="jl-custom-id" href="${esc(els.details.href)}#${esc(x.id)}" target="_blank" rel="noopener" title="Every field of this bug (Bugs reference)">${esc(x.id)} ↗</a>`
        + `${x.entry.alias ? ` <b>${esc(x.entry.alias)}</b>` : ''}${needs ? `<span class="jl-custom-mark">${esc(marks.get(needs))}</span>` : ''}`
        + `${x.entry.find?.by_puffin ? ' <span class="jl-custom-star" title="first found by puffin">★</span>' : ''} <span class="jl-tag">${esc(x.entry.category)}</span>`
        + `${vs === 'new' ? ' <span class="jl-badge new">only in this commit</span>' : vs === 'differs' ? ' <span class="jl-badge warn">differs from dev</span>' : ''}`
        + `<div class="jl-custom-summary">${esc(x.entry.summary)}</div></td>
        <td class="num">${x.entry.cvss ? esc(x.entry.cvss.score) : '—'}</td>
        <td>${x.options.length ? `<select class="jl-select">${options}</select>` : '<span class="jl-muted">no preset of this commit has it</span>'}
          <div class="jl-muted">affected ${esc(x.entry.affected ?? x.entry.affected_commits ?? '—')}</div></td>
        <td>${t ? `<span title="${esc(`task ${t.task} (${t.job}) at tlspuffin ${String(t.commit ?? '').slice(0, 9)} of ${String(t.date ?? '').slice(0, 10)}: ${t.cores} cores per attempt, ${duration(t.budget_s)} budget`)}">`
          + `${t.found ? duration(t.median_s) : 'not found'} · ${esc(t.found)}/${esc(t.runs)}</span>` : '<span class="jl-muted">—</span>'}</td>
        <td>${confirm}${twins.length ? `<br><span class="jl-badge warn">same oracle as ${twins.join(', ')}</span>` : ''}</td></tr>`;
    };
    const group = (title, list) => list.length ? `<tr class="group"><td colspan="6">${title}</td></tr>${list.map(row).join('')}` : '';
    els.bugs.innerHTML = `<tr><th></th><th>bug</th><th>CVSS</th><th>run on</th><th>time to find on the bench${this.#times ? ' ⁽ᵗ⁾' : ''}</th><th>a find is confirmed by</th></tr>`
      + libs.filter(lib => library.some(x => x.lib === lib)).map(lib => group(`${esc(libraryName(lib))} — ${library.filter(x => x.lib === lib).length} bug(s)`,
          library.filter(x => x.lib === lib))).join('')
      + group('🔧 Bugs of the fuzzing harness', harness)
      + (shown.length ? '' : '<tr><td colspan="6" class="jl-muted">no bug to show</td></tr>');
    els.footnotes.innerHTML = [...marks].map(([needs, mark]) => `<div><span class="jl-custom-mark">${esc(mark)}</span> ${needs}.</div>`).join('')
      + (this.#times ? `<div><span class="jl-custom-mark">⁽ᵗ⁾</span> ${esc(this.#times.source ?? 'the bench\'s own measurements')}.</div>` : '')
      + (hidden.length ? `<div class="jl-muted">${hidden.length} bug(s) without witness hidden (${hidden.map(x => esc(x.entry.alias ?? x.id)).join(', ')}): cannot be checked, never targets.</div>` : '')
      + '<div class="jl-muted">★ first found by puffin · ↗ every field of the bug: Bugs reference page.</div>';
    this.#renderRuns();
  }

  // known bugs left in the same build with the same oracle: a stop on them is not a find (validation tells)
  #sameOracle(x) {
    const preset = this.#picked.get(x.id)?.preset ? x.options.find(p => p.name === this.#picked.get(x.id).preset) : x.reference;
    if (!preset || !x.entry.oracle) return [];
    return this.#entries().filter(y => y.lib === x.lib && y.id !== x.id && presentOn(y.id, y.entry, preset)
      && JSON.stringify(y.entry.oracle) === JSON.stringify(x.entry.oracle)
      && !(this.#others() === 'patched' && this.#patchedAt(y.entry, preset.version)));
  }

  #renderRuns() {
    const experiments = this.#experiments();
    const oracle = o => !o ? '—' : o.kind === 'claim' ? `claim <code>${esc(o.violation ?? '')}</code>`
      : `crash${o.signal ? ` <code>${esc(o.signal)}</code>` : ''}${o.asan ? `, ASan <code>${esc(o.asan)}</code>` : ''}${o.panic ? `, panic <code>${esc(o.panic)}</code>` : ''}`;
    this.#els.runs.innerHTML = '<tr><th>experiment</th><th>vendor</th><th>build</th><th>run with</th><th>stops on its oracle</th><th>known bugs left in the build</th></tr>'
      + (experiments.map(x => {
        const { patched, left } = this.#neighbours(x);
        const find = x.entry.find ?? {};
        const twins = this.#sameOracle(x).map(y => esc(y.entry.alias ?? y.id));
        return `<tr><td><b>${esc(x.name)}</b></td><td><code>${esc(x.args.vendor)}</code></td>
          <td>${esc(libraryName(x.lib))} ${esc(x.preset.version)}${x.preset.asan ? ', ASan' : needsAsan(x.entry) ? ', + ASan (its oracle is an ASan report)' : ''}${patched.length ? `, ${esc(patched.join(', '))} patched` : ''}</td>
          <td>${[...(find.flags ?? []).map(f => `<code>${esc(f)}</code>`), ...(find.features ?? []).map(f => `feature <code>${esc(f)}</code>`)].join(' ') || '<span class="jl-muted">—</span>'}</td>
          <td>${oracle(x.entry.oracle)}</td>
          <td>${left.length ? esc(left.join(', ')) : 'none'}${twins.length ? `<br><span class="jl-badge warn">a stop on ${twins.join(' or ')} is not a find</span>` : ''}</td></tr>`;
      }).join('') || '<tr><td colspan="6" class="jl-muted">Tick the bugs to look for above: one experiment each.</td></tr>');
    const n = experiments.length;
    this.#els.cost.textContent = n ? `${n} experiment(s) × ${this.attempts} attempt(s) × ${this.cores} core(s), until each attempt finds its bug or times out` : '';
    this.#onChange();
  }

  #status(text) {
    this.#els.status.textContent = text;
    this.#els.bugs.innerHTML = '';
    this.#els.footnotes.innerHTML = '';
    this.#els.badge.innerHTML = '';
    this.#renderRuns();
  }
}
