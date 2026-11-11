// Custom Vuln benchmarks (job type "vuln-custom", jobsconfig.json custom_benchmark): the known bugs of tlspuffin's
// vulnerability catalogue (git_restapi /api/git/catalogue, dev's or the commit's) as a table to tick; each ticked bug
// becomes one experiment of the task, built and run the way it needs:
//   - on a preset of the commit where it is active (its version in `affected`, the build options of `requires`; ASan
//     presets only when `find.asan`), by default the newest one, ASan first;
//   - with every other known bug that has a patch at that version patched (`<preset>-only-<ID>`), or as in the preset;
//   - with the fuzzer flags and cargo features of its `find`;
//   - stopping only on an objective with its own oracle (job scripts: target_bug, target_oracle) that validation
//     confirms during the attempt (patch differential, or its signature when it has no patch).
// A bug's needs are footnote marks under the table, one per distinct set. Every field of a bug: the Bugs reference
// page. The experiments are the task's configurations (runtime RUNTIME_RUN_CONFIG, see runConfig), named
// <benchmark>_<alias or ID>, and the definition is recorded in the task (definition) so that it can be launched again.
// Saved benchmarks: definitions kept by the scheduler under their name (/api/benchmarks/tlspuffin, shared by every
// user of the board), saved with 💾 Save, loaded on any commit, removed.

const MARKS = ['*', '†', '‡', '§', '¶', '‖', '**', '††', '‡‡'];

// versions, ranges, where a bug is and has a patch: the catalogue's rules (common/catalogue.js), also for the tests
import { parseVersion, compareVersions, inRange, presentOn, activeOn, needsAsan, patchedAt, runOptions, confirmation } from '../../../common/catalogue.js';
import { esc, libraryName, duration } from '../../../common/format.js';
export { parseVersion, compareVersions, inRange, presentOn, activeOn, needsAsan, patchedAt, runOptions, confirmation };

// the scheduler's store of saved benchmarks (scheduler/src/scheduler/api/benchmarks_api.hxx)
const SAVED_API = '/api/benchmarks/tlspuffin';
const answer = request => request.then(async r => ({ ok: r.ok, body: await r.json().catch(() => ({})) }))
  .catch(err => ({ ok: false, body: { error: `no answer from the scheduler (${err.message})` } }));


export class CustomBenchmark {
  node;
  #gitOrigin;
  #onChange;
  #sha = null;
  #presets = null;              // { vendors: { <lib>: [ { name, version, asan, postauth, fix, ... } ] } } of the commit
  #catalogues = { commit: null, dev: null };
  #source = 'dev';              // the catalogue the bugs come from: 'dev' or 'commit'
  #times = null;                // the bench's times to find (runs/bench_times.json of the data folder), when there are
  #picked = new Map();          // ID -> { preset } of the ticked bugs
  #saved = {};                  // the saved benchmarks: name -> { saved_at, definition }
  #savedError = '';
  #pending = null;              // a definition to apply once the commit's catalogue and presets are there
  #settings;                    // the launcher's own fields a benchmark keeps (timeout, CPU sharing): get() and set()
  #error = '';
  #loading = false;
  #els = {};

  constructor({ gitOrigin, onChange, settings }) {
    this.#gitOrigin = gitOrigin;
    this.#onChange = onChange ?? (() => {});
    this.#settings = { get: () => ({}), set: () => {}, ...settings };
    this.node = document.createElement('div');
    this.node.className = 'jl-custom';
    this.node.innerHTML = `
      <div class="jl-custom-row jl-custom-savedrow">
        <span class="jl-label" title="Saved benchmarks: kept by the scheduler under their name, for every user of the board; Load ticks the same bugs with the same settings on the commit chosen">Saved benchmarks</span>
        <select class="jl-select jl-custom-saved"><option value="">none saved yet</option></select>
        <button type="button" class="jl-custom-load jl-custom-open" title="Its bugs, versions and settings, on the commit chosen above">Load</button>
        <button type="button" class="jl-custom-load jl-custom-remove" title="No longer among the saved benchmarks (the tasks it launched and their results stay)">🗑 Remove</button>
        <span class="jl-custom-savedinfo"></span>
      </div>
      <div class="jl-custom-row">
        <span class="jl-label" title="Catalogue: where the bugs come from: dev's (what validation trusts) or the chosen commit's (a PR adding a bug)">Catalogue</span>
        <label><input type="radio" name="jl-custom-source" value="dev"> <span class="jl-custom-dev">dev's</span></label>
        <label><input type="radio" name="jl-custom-source" value="commit"> this commit's</label>
        <button type="button" class="jl-custom-load jl-custom-loadcommit" title="The catalogue of the chosen commit (e.g. a PR adding a bug): its bugs, compared with dev's">Load bugs from this commit</button>
        <span class="jl-custom-badge"></span>
        <a class="jl-custom-details" target="_blank" rel="noopener" title="Bugs reference: every field of each bug of the catalogue (new tab)">📖 Every detail of each bug: Bugs reference ↗</a>
        <span class="jl-custom-about">ⓘ how it works</span>
      </div>
      <div class="jl-custom-row">
        <span class="jl-label" title="Show: only the bugs of a library or a category; ★ the bugs first found by puffin; the bugs without witness (never targets) are hidden unless ticked">Show</span>
        <select class="jl-select jl-custom-lib"><option value="">all libraries</option></select>
        <select class="jl-select jl-custom-cat"><option value="">all categories</option></select>
        <label><input type="checkbox" class="jl-custom-puffin"> ★ first found by puffin only</label>
        <label><input type="checkbox" class="jl-custom-nowitness"> bugs without witness</label>
      </div>
      <div class="jl-custom-status"></div>
      <table class="jl-custom-bugs"></table>
      <div class="jl-custom-footnotes"></div>
      <div class="jl-custom-row">
        <span class="jl-label" title="Other known bugs: the known bugs of each experiment's build other than its own: patched where a patch exists (it can only stop on its own bug), or left as in the preset">Other known bugs</span>
        <label><input type="radio" name="jl-custom-others" value="patched" checked> patched where a patch exists (recommended: an experiment can only stop on its own bug)</label>
        <label title="The chosen preset as it is: only the fixes of its own fix list (none for wolfssl540-asan, HEAP for wolfssl540-buf); every other known bug stays in the build, and the fuzzer may find one of them first (the attempt then goes on)"><input type="radio" name="jl-custom-others" value="preset"> only the preset's own fixes (the other known bugs stay in the build)</label>
      </div>
      <h4 class="jl-custom-h">What will run</h4>
      <table class="jl-custom-runs"></table>
      <div class="jl-custom-warnings"></div>
      <div class="jl-custom-note">An attempt stops only on a confirmed find: an objective with the bug's signature is first replayed on the
        validation builds, prepared before the attempt, while the fuzzer goes on (patch differential; a bug without patch: its signature on the
        build with every patch); one validation does not confirm leaves the attempt going. The time to find is when the fuzzer saved the
        confirmed objective.</div>
      <div class="jl-custom-row">
        <span class="jl-label" title="Attempts: runs of each experiment, each until it finds its bug (confirmed) or times out">Attempts</span><input type="number" class="jl-commit-input jl-custom-attempts" min="1" max="50" value="5">
        <span class="jl-label" title="Cores per attempt: fuzzer clients of each attempt, one core each">Cores per attempt</span><input type="number" class="jl-commit-input jl-custom-cores" min="1" max="64" value="4">
        <span class="jl-custom-cost"></span>
      </div>
      <div class="jl-custom-row">
        <span class="jl-label" title="Benchmark: its name (letters, digits, -): the experiments are named <benchmark>_<bug>, followed across commits on Results">Benchmark</span><input type="text" class="jl-commit-input jl-custom-name" value="custom" maxlength="24" spellcheck="false"
          title="Its name (letters, digits, -): the experiments are named <benchmark>_<bug>; launching it again with the same name continues its series on Results">
        <input type="text" class="jl-commit-input jl-custom-description" placeholder="description (optional)" maxlength="200">
        <button type="button" class="jl-custom-load jl-custom-save" title="Save: keep this benchmark under its name, for every user of the board, to Load it again later on any commit (Saved benchmarks, above); launching does not save it">💾 Save</button>
        <span class="jl-custom-savestatus"></span>
      </div>`;
    const $ = selector => this.node.querySelector(selector);
    this.#els = {
      badge: $('.jl-custom-badge'), details: $('.jl-custom-details'), status: $('.jl-custom-status'), bugs: $('.jl-custom-bugs'),
      footnotes: $('.jl-custom-footnotes'), runs: $('.jl-custom-runs'), lib: $('.jl-custom-lib'), cat: $('.jl-custom-cat'),
      puffin: $('.jl-custom-puffin'), nowitness: $('.jl-custom-nowitness'), attempts: $('.jl-custom-attempts'),
      cores: $('.jl-custom-cores'), cost: $('.jl-custom-cost'), name: $('.jl-custom-name'), description: $('.jl-custom-description'),
      dev: $('.jl-custom-dev'), load: $('.jl-custom-loadcommit'),
      warnings: $('.jl-custom-warnings'), saved: $('.jl-custom-saved'), open: $('.jl-custom-open'), remove: $('.jl-custom-remove'),
      about: $('.jl-custom-about'), savedinfo: $('.jl-custom-savedinfo'), save: $('.jl-custom-save'), savestatus: $('.jl-custom-savestatus'),
    };
    this.#els.saved.addEventListener('change', () => this.#renderSavedInfo());
    this.#els.open.addEventListener('click', () => {
      const saved = this.#saved[this.#els.saved.value];
      if (saved) this.restore(saved.definition);
    });
    this.#els.remove.addEventListener('click', () => this.#remove(this.#els.saved.value));
    this.#els.save.addEventListener('click', () => this.save());
    this.#refreshSaved();
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
    // the data folder: /files/ on the scheduler's board, /html/ on the publisher; the module is in board/launchers/tlspuffin
    fetch(new URL('../../../runs/bench_times.json', import.meta.url), { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null)
      .then(times => { this.#times = times; if (this.#sha) this.#render(); });
  }

  show(visible) { this.node.classList.toggle('visible', visible); }

  // where the launcher puts the help of the panel (its "ⓘ how it works")
  get helpAnchor() { return this.#els.about; }

  reset() {
    this.#picked.clear();
    this.#pending = null;
    this.#saveStatus('', '');
    this.#refreshSaved();
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
      if (this.#pending) {
        const definition = this.#pending;
        this.#pending = null;
        this.#apply(definition);
      } else {
        this.#render();
      }
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
      // the launcher's: timeout { d, h, m }, smt (CPU sharing)
      ...this.#settings.get(),
      experiments: this.#experiments().map(x => ({ name: x.name, bug: x.id, vendor: x.args.vendor, preset: x.preset.name,
        version: x.preset.version, asan: !!x.preset.asan || needsAsan(x.entry), oracle: x.entry.oracle, flags: x.entry.find?.flags ?? [],
        features: x.entry.find?.features ?? [], fingerprint: x.entry.fingerprint ?? null })),
    };
  }

  // a definition recorded with an earlier task ("New task…" from it) or saved (Saved benchmarks): the same bugs, versions
  // and settings, on the commit chosen (once its catalogue and presets are there)
  restore(definition) {
    if (!definition) return;
    this.#els.name.value = String(definition.name ?? 'custom').replace(/[^A-Za-z0-9-]/g, '').slice(0, 24) || 'custom';
    this.#els.description.value = definition.description ?? '';
    this.#els.attempts.value = definition.attempts ?? 5;
    this.#els.cores.value = definition.cores ?? 4;
    const others = this.node.querySelector(`input[name="jl-custom-others"][value="${definition.others === 'preset' ? 'preset' : 'patched'}"]`);
    if (others) others.checked = true;
    this.#settings.set({ timeout: definition.timeout, smt: definition.smt });
    if (!this.#sha || this.#loading) {
      this.#pending = definition;
      this.#saveStatus(`${definition.name ?? 'the benchmark'}: its bugs are ticked once a commit is chosen`, '');
      return;
    }
    this.#apply(definition);
  }

  // ticks the bugs of a definition in the catalogue shown: its own (dev's or the commit's) when there is one
  #apply(definition) {
    const wanted = definition.catalogue?.source;
    if (wanted && this.#catalogues[wanted]?.format === 'vulnerabilities.toml') this.#source = wanted;
    this.#picked.clear();
    for (const x of definition.experiments ?? []) this.#picked.set(x.bug, { preset: x.preset });
    this.#render();
    const here = new Set(this.#entries().map(x => x.id));
    const missing = (definition.experiments ?? []).filter(x => !here.has(x.bug)).map(x => x.bug);
    for (const id of missing) this.#picked.delete(id);
    if (missing.length) {
      this.#renderRuns();
      this.#saveStatus(`not in this catalogue, left out: ${missing.join(', ')}`, 'warn');
    } else {
      this.#saveStatus('', '');
    }
  }

  // ── saved benchmarks ──
  async #refreshSaved(select = null) {
    const { ok, body } = await answer(fetch(SAVED_API, { cache: 'no-store' }));
    this.#saved = ok && body.success ? (body.data ?? {}) : {};
    this.#savedError = ok && body.success ? '' : `the scheduler did not list them${body.error ? ` (${body.error})` : ''}`;
    const names = Object.keys(this.#saved).sort((a, b) => a.localeCompare(b));
    const keep = select ?? this.#els.saved.value;
    this.#els.saved.innerHTML = names.length
      ? names.map(n => `<option value="${esc(n)}">${esc(n)}${this.#saved[n].definition?.description ? ` — ${esc(this.#saved[n].definition.description)}` : ''}</option>`).join('')
      : '<option value="">none saved yet</option>';
    this.#els.saved.value = names.includes(keep) ? keep : (names[0] ?? '');
    this.#els.open.disabled = this.#els.remove.disabled = !names.length;
    this.#renderSavedInfo();
  }

  #renderSavedInfo() {
    const saved = this.#saved[this.#els.saved.value];
    if (!saved) { this.#els.savedinfo.textContent = this.#savedError; return; }
    const d = saved.definition ?? {};
    const bugs = (d.experiments ?? []).map(x => String(x.name ?? '').startsWith(`${d.name}_`) ? x.name.slice(`${d.name}_`.length) : x.bug);
    const when = Number.isFinite(saved.saved_at) ? new Date(saved.saved_at).toISOString().slice(0, 16).replace('T', ' ') : '?';
    const timeout = d.timeout ? ` · timeout ${d.timeout.d ? `${d.timeout.d} d ` : ''}${d.timeout.h ?? 0} h ${String(d.timeout.m ?? 0).padStart(2, '0')}` : '';
    const smt = d.smt === undefined ? '' : ` · CPU sharing ${d.smt || 'default'}`;
    this.#els.savedinfo.textContent = `${bugs.length} bug(s): ${bugs.join(', ') || 'none'} · ${d.attempts ?? '?'} attempt(s) × ${d.cores ?? '?'} core(s)`
      + `${timeout}${smt} · other known bugs ${d.others === 'preset' ? 'as in the preset' : 'patched'} · saved ${when} UTC`;
  }

  #saveStatus(text, kind) {
    this.#els.savestatus.textContent = text;
    this.#els.savestatus.className = `jl-custom-savestatus${kind ? ` ${kind}` : ''}`;
  }

  // keeps the benchmark under its name (replacing a saved one of that name, once confirmed); false: not saved
  async save() {
    if (!this.#experiments().length) { this.#saveStatus('nothing to save: tick at least one bug', 'warn'); return false; }
    const definition = this.definition();
    if (this.#saved[definition.name] && !window.confirm(`Replace the saved benchmark ${definition.name}?`)) return false;
    const { ok, body } = await answer(fetch(`${SAVED_API}/${encodeURIComponent(definition.name)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(definition) }));
    if (!ok || body.success === false) {
      this.#saveStatus(`not saved: ${body.error ?? 'refused by the scheduler'}`, 'warn');
      return false;
    }
    this.#saveStatus(`saved as ${definition.name}`, 'ok');
    await this.#refreshSaved(definition.name);
    return true;
  }

  async #remove(name) {
    if (!name || !window.confirm(`Remove the saved benchmark ${name}? The tasks it launched and their results stay.`)) return;
    const { ok, body } = await answer(fetch(`${SAVED_API}/${encodeURIComponent(name)}`, { method: 'DELETE' }));
    this.#saveStatus(ok && body.success !== false ? `${name} removed` : `not removed: ${body.error ?? 'refused by the scheduler'}`, ok ? 'ok' : 'warn');
    await this.#refreshSaved();
  }

  // ── data ──
  #catalogue() { return this.#catalogues[this.#source]; }
  #others() { return this.node.querySelector('input[name="jl-custom-others"]:checked')?.value ?? 'patched'; }

  // every entry of the catalogue shown, with where it can run
  #entries() {
    const catalogue = this.#catalogue();
    if (!catalogue || catalogue.format !== 'vulnerabilities.toml') return [];
    return Object.entries(catalogue.vendors ?? {}).flatMap(([lib, v]) => Object.entries(v.entries ?? {}).map(([id, entry]) => {
      // the safest first: a version where the bug has a patch (finds validated by patch differential), then the newest, ASan
      const options = runOptions(id, entry, this.#presets?.vendors?.[lib]);
      const reference = options.find(p => p.name === entry.reference) ?? options[0] ?? null;
      return { lib, id, entry, options, reference };
    }));
  }

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
    // the Bugs reference is a page of the publisher (the launcher is the scheduler's): its port, this host
    els.details.href = `${location.protocol}//${location.hostname}:10083/html/publisher/bugs.html${this.#source === 'commit' && this.#sha ? `?commit=${encodeURIComponent(this.#sha)}` : ''}`;

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
      const how = confirmation(x.entry);
      const confirm = `<span class="jl-badge ${how.kind === 'patch' ? 'ok' : 'warn'}">${esc(how.text)}</span>`;
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
    els.bugs.innerHTML = `<tr><th></th><th title="bug: its ID (↗ every field, Bugs reference), alias, category and summary">bug</th>`
      + '<th title="CVSS: the base score of the bug">CVSS</th>'
      + '<th title="run on: the presets of the commit that have the bug (version, build options, ASan); the safest first: a version where it has a patch">run on</th>'
      + `<th title="time to find on the bench: median of the Vuln group A/B attempts that found it, found/attempts; hover a value for its task">time to find on the bench${this.#times ? ' ⁽ᵗ⁾' : ''}</th>`
      + '<th title="a find is confirmed by: how validation recognises a find of this bug (its patch: patch differential; else its signature only)">a find is confirmed by</th></tr>'
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
    this.#els.runs.innerHTML = '<tr><th title="experiment: <benchmark>_<bug>, its name on Results">experiment</th>'
      + '<th title="vendor: the build given to mk_vendor (<preset>-only-<ID>: every other bug with a patch patched)">vendor</th>'
      + '<th title="build: library, version, ASan and the bugs patched">build</th>'
      + '<th title="run with: the fuzzer flags and cargo features the bug needs">run with</th>'
      + '<th title="stops on its oracle: the objectives that end an attempt, once validation confirms them">stops on its oracle</th>'
      + '<th title="known bugs left in the build: other known bugs the fuzzer may find first (an attempt goes on after them)">known bugs left in the build</th></tr>'
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
    // the experiments whose finds cannot be validated by patch differential, and how they will be confirmed
    const describe = o => !o ? 'none' : o.kind === 'claim' ? `the claim "${o.violation ?? ''}"`
      : `a crash${o.signal ? ` (${o.signal})` : ''}${o.asan ? ` with an ASan report ${o.asan}` : ''}${o.panic ? ` (panic ${o.panic})` : ''}`;
    this.#els.warnings.innerHTML = experiments.flatMap(x => {
      const label = esc(x.entry.alias ?? x.id), version = esc(x.preset.version);
      const twins = this.#sameOracle(x).map(y => esc(y.entry.alias ?? y.id));
      if (x.entry.replayable === false) {
        return [`⚠ <b>${label}</b>: its objectives do not replay on their own: a find is the fuzzer's own record of ${esc(describe(x.entry.oracle))}, not validated.`];
      }
      if (!x.preset.patched) {
        return [`⚠ <b>${label}</b> has no patch at ${version}: a find is confirmed by its signature only: the objective must reproduce, with
          ${esc(describe(x.entry.oracle))}, on the build with every other patch${twins.length ? `; ${twins.join(', ')}, left in that build with the same
          signature, would be taken for it` : ''}. A patch for it in tlspuffin's catalogue would make it a patch differential.`];
      }
      return [];
    }).map(w => `<div>${w}</div>`).join('');
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
