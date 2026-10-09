import { config } from './config.js'
import { ListInput } from './widget-listinput.js'
import { resolveCommits, parseTaskName, commitLineHTML } from '../../../common/commitinfo.js'
import { CheckScheduler } from '../../nav.js'

const link = document.createElement('link');
link.rel  = 'stylesheet';
link.href = new URL('./joblauncher.css', import.meta.url);
document.head.appendChild(link);

// short type of the tasks of each job type (jobsconfig.json), for the task descriptions (see describeTask)
const JOB_TYPE_PREFIXES = { 'perf': 'Perf', 'vuln-a': 'VulnA', 'vuln-b': 'VulnB', 'campaign': 'Camp' };

export class JobLauncher {
  #config;
  #data = { dev: [], pr_open: [], pr: [], all: [] };
  #prApiInfos = null;
  #jobDefs = [];
  #activeTab  = 'dev';
  #selectedType   = null;
  #selectedCommit = null;
  #skipNextModalClose = false;
  #titleModified = false;
  #timeoutModified = false;
  #isLoading = false;

  // DOM refs
  #overlay           = null;
  #chipsWrap         = null;
  #taskNameInput     = null;
  #commitInput       = null;
  #commitInputRowEl  = null;
  #refreshBtn        = null;
  #listEl            = null;
  #tablistEl         = null;
  #campaignExtra    = null;
  #campaignIdInput  = null;
  #launchCampaignId = null;   // the default campaign ID of the launch in progress (same for every sub-job)
  #timeoutSection   = null;
  #timeoutDayInput = null;
  #timeoutInput    = null;
  #timeoutMinInput = null;
  #vendorImpl      = 'c';   // 'c' | 'rust'
  #featuresInput   = null;
  #parametersInput = null;
  #nbAttemptsInput = null;
  #nbCoreInput     = null;
  #smtSelect       = null;
  #memMaxInput     = null;
  #vendorListInput = null;
  #vendorCatalog   = {};
  #vendorOptions   = [];
  // preset picker (C harness): the presets of the commit (git_restapi /api/git/presets), the library shown, the note
  #presets         = new Map();   // full or typed commit -> Promise of { commit, format, vendors } (null: error)
  #presetsData     = null;        // those of the current commit, once loaded
  #presetsFor      = null;
  #presetBtn       = null;
  #presetPanel     = null;
  #presetLib       = null;
  #vendorNote      = null;
  #asanRemoved     = false;       // the user removed the asan feature that the preset added
  #usernameInput  = null;
  #commitInfoEl   = null;
  #packageRow       = null;
  #packageListInput = null;
  #packageOptions   = [];
  #launchBtn           = null;
  #confirmUnknownEl    = null;
  #confirmUnknownCheck = null;
  #toast               = null;
  #tabBtns             = {};

  constructor() {
    if (config?.commitsUrl == null) {
      console.error('Fatal error, missing commitsUrl in config.js')
      return;
    }
    this.#config = {
      commitsUrl:    config.commitsUrl,
      jobsConfigUrl: new URL('./jobsconfig.json', import.meta.url).href,
      launchUrl:     '/api/task/new',
    };
    this.#buildDOM();
    // Esc (top bar, board/nav.js): the commit list first, then the launcher
    window.addEventListener('pb-escape', (event) => {
      if ((event.detail?.layer !== 'modal') || event.defaultPrevented || !this.#overlay.classList.contains('open')) return;
      event.preventDefault();
      if (this.#tablistEl.classList.contains('open')) this.#closeTablist();
      else this.close();
    });
  }

  open(custom = null)  {
    this.#overlay.classList.add('open');
    this.#refreshCampaignPlaceholder();
    const commitsPromise = this.#loadCommits();
    const jobsConfigPromise = this.#jobDefs.length ? Promise.resolve() : this.#loadJobsConfig();
    if (custom) {
      Promise.all([commitsPromise, jobsConfigPromise]).then(() => this.#applyCustom(custom));
    }
  }
  close() { this.#overlay.classList.remove('open'); this.#reset(); }

  // The commits of many tasks (history) in one git_restapi request: describeTask then finds them in the cache
  async prefetchTasks(tasks) {
    const shas = (tasks ?? []).map(task => (task?.args ?? []).find(arg => arg.key === 'COMMIT_ID')?.value
        ?? /\b[0-9a-f]{40}\b/i.exec(task?.name ?? '')?.[0]).filter(Boolean);
    if (shas.length === 0) return;
    await resolveCommits(new URL(this.#config.commitsUrl).origin, 'tlspuffin', shas);
  }

  // One-line summary of a MonitorExperiment message (PR_common.sh) for the board, the task page and the history (see
  // launchers.js DescribeMonitor): corpus, objectives (link to the live objectives page), errors, logs, ASAN, stats
  // age; the details in the hovers; the message without its #MONITOR_JSON line for the full view.
  // level: 'error' (fuzzing errors), 'warning' (stale stats, log volume, ASAN not instrumented), 'success'
  // (objectives found). null when the message is not a MonitorExperiment one.
  describeMonitor(task, message) {
    const text = String(message ?? '');
    const facts = JobLauncher.#MonitorFacts(text);
    // VulnA/VulnB look for known bugs: objectives are their expected outcome, shown without 🎉 nor highlight
    const expected = JobLauncher.#ObjectivesExpected(task);
    if (!facts) return null;
    const esc = (value) => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    const chip = (label, title, cls = '', href = null) => href
        ? `<a class="tp-mon ${cls}" href="${esc(href)}" target="_blank" rel="noopener" title="${esc(title)}">${label}</a>`
        : `<span class="tp-mon ${cls}" data-click-tip="${esc(title)}">${label}</span>`;
    const minutes = (value) => { const n = Number(value); return n < 60 ? `${n} min` : `${Math.floor(n / 60)}h${String(n % 60).padStart(2, '0')}`; };
    const count = (value) => Number(value).toLocaleString('en-US');
    const chips = [];
    let level = '';
    const raise = (newLevel) => {
      const rank = { '': 0, success: 1, warning: 2, error: 3 };
      if (rank[newLevel] > rank[level]) level = newLevel;
    };
    const context = [facts.experiment && `experiment ${facts.experiment}${facts.port ? ` (port ${facts.port})` : ''}`,
        facts.build && `build: ${facts.build}`, facts.put && facts.put].filter(Boolean).join('\n');

    if (facts.corpus?.count != null) {
      // no new corpus entry for a while: the fuzzer may be stuck (or done exploring, late in a long campaign)
      const stalled = facts.corpus.age_min > JobLauncher.#corpusStalledMin;
      chips.push(chip(`corpus ${count(facts.corpus.count)}${facts.corpus.age_min != null ? ` (${minutes(facts.corpus.age_min)})` : ''}${stalled ? ' ⚠️' : ''}`,
          `${facts.corpus.count} corpus entries${facts.corpus.age_min != null ? `, the last one ${facts.corpus.age_min} min ago` : ''}` +
          (stalled ? `\n⚠️ no new corpus entry for ${facts.corpus.age_min} min (more than ${JobLauncher.#corpusStalledMin})` : '') +
          (context ? `\n${context}` : ''), stalled ? 'tp-mon-warning' : ''));
      if (stalled) raise('warning');
    }
    if (facts.objectives?.count > 0) {
      const recent = (facts.objectives.recent ?? []).map(o => `${o.age_min} min ago: ${o.name}`);
      chips.push(chip(`${expected ? '' : '🎉 '}${count(facts.objectives.count)} obj${facts.objectives.age_min != null ? ` (${minutes(facts.objectives.age_min)})` : ''}`,
          `${facts.objectives.count} objectives${facts.objectives.age_min != null ? `, the last one ${facts.objectives.age_min} min ago` : ''}` +
          (recent.length ? `\n${recent.join('\n')}` : '') + (facts.objectives.live ? '\nClick: live objectives, grouped by bug' : ''),
          expected ? 'tp-mon-objective-expected' : 'tp-mon-objective', facts.objectives.live || null));
      if (!expected) raise('success');
    } else if (facts.objectives) {
      chips.push(chip('no obj', 'no objective yet', 'tp-mon-muted'));
    }
    if (facts.errors?.count > 0 || facts.errors?.crashes > 0) {
      chips.push(chip(`❌ ${count(facts.errors.count)} err${facts.errors.crashes > 0 ? ` / ${count(facts.errors.crashes)} crash` : ''}`,
          `${facts.errors.count} errors, ${facts.errors.crashes} crashes in error.log${facts.errors.last ? `\nlast: ${facts.errors.last}` : ''}`,
          'tp-mon-error'));
      raise('error');
    }
    if (facts.logs?.mb != null) {
      const warning = facts.logs.warning;
      chips.push(chip(`logs ${facts.logs.mb} MB${warning ? ' ⚠️' : ''}`,
          `~${facts.logs.mb} MB of logs${facts.logs.rate != null ? `, ${facts.logs.rate} MB per hour per core` : ''}${warning ? `\n⚠️ ${warning}` : ''}`,
          warning ? 'tp-mon-warning' : ''));
      if (warning) raise('warning');
    }
    if (facts.asan) {
      const ok = facts.asan.startsWith('✓');
      const bad = facts.asan.startsWith('✗');
      chips.push(chip(`ASAN${ok ? '✓' : bad ? '✗' : '?'}`, `ASAN: ${facts.asan}`, ok ? 'tp-mon-muted' : 'tp-mon-warning'));
      if (bad) raise('warning');
    }
    if (facts.lost_clients > 0) {
      chips.push(chip(`⚠️ ${facts.lost_clients} client${facts.lost_clients > 1 ? 's' : ''} lost`,
          `${facts.lost_clients} client(s) crashed and the fuzzer could not restart them ("Storing state in crashed fuzzer instance did not work", old LibAFL): the experiment ends at the next check, its cores freed`,
          'tp-mon-warning'));
      raise('warning');
    }
    if (facts.stats_age_s != null) {
      const age = Number(facts.stats_age_s);
      const stale = age > 300;
      chips.push(chip(stale ? `stats ${minutes(Math.round(age / 60))} old ⚠️` : `stats ${age}s`,
          `last stats.json update ${age} s ago${stale ? ': the fuzzer may be stuck' : ''}`, stale ? 'tp-mon-warning' : 'tp-mon-muted'));
      if (stale) raise('warning');
    }
    if (chips.length === 0) return null;
    const readable = text.split('\n').filter(line => !line.startsWith('#MONITOR_JSON')).join('\n');
    const found = facts.objectives?.count > 0;
    // The live page is deleted when the task ends; its final report (objectives_report.sh, every 10 minutes) takes
    // its place: objectives/<task>.html next to it. The card says "report pending" until that page exists.
    const running = Object.values(task?.steps ?? {}).some(step => ['Running', 'Pending'].includes(step.state));
    const live = facts.objectives?.live || null;
    const url = live && !running ? live.replace(/\/live-(\d+)\.html$/, '/$1.html') : live;
    return {
      summary: chips.join(' · '), level, text: readable,
      // objectives found: the attempt stands out (not in VulnA/VulnB, where they are expected), and the task gets a
      // button to its objectives page
      highlight: found && !expected ? 'objective' : null,
      taskLink: found ? {
        key: 'objectives', count: facts.objectives.count, url, highlight: expected ? null : 'objective',
        label: `${expected ? '' : '🎉 '}{count} objectives${!url ? '' : running ? ' · live ↗' : ' · report ↗'}`,
        title: running ? 'Objectives of the running attempts; click: live objectives of this task, replayed and grouped by bug'
            : 'Objectives of the task; click: its final report, replayed and grouped by bug',
        pending: url && !running ? {
          label: `${expected ? '' : '🎉 '}{count} objectives · report pending`,
          title: 'The final report of the objectives is written within 10 minutes of the end of the task',
        } : null,
      } : null,
    };
  }

  static #ObjectivesExpected(task) {
    return ['vuln-a', 'vuln-b'].includes(task?.job_type);
  }

  // The settings of a tlspuffin task for the task page (see launchers.js DescribeSettings): job type, commit, package,
  // timeout, configurations and attempts, campaign settings, compat rules. From the launcher settings it was started
  // with (task.launcher.custom) and its arguments; what is unknown is left out (the page also lists every argument).
  describeSettings(task) {
    const esc = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const chips = (values) => values.map(value => `<span class="chip">${esc(value)}</span>`).join('');
    const custom = task?.launcher?.custom ?? {};
    const args = Object.fromEntries((task?.args ?? []).filter(arg => arg?.key).map(arg => [arg.key, arg.value]));
    const types = { 'perf': 'Perf', 'vuln-a': 'VulnA (Vuln group A)', 'vuln-b': 'VulnB (Vuln group B)', 'campaign': 'Campaign' };
    const rows = [];
    const type = custom.jobType ?? task?.job_type;
    if (type) rows.push({ label: 'job type', html: esc(types[type] ?? type) });
    const commit = args.COMMIT_ID ?? custom.commit;
    if (commit) rows.push({ label: 'commit', html: `<span class="mono">${esc(String(commit).slice(0, 12))}</span>` });
    rows.push({ label: 'package', html: esc(args.PACKAGE || custom.package || 'tlspuffin') });
    if (custom.timeout) {
      const { d = 0, h = 0, m = 0 } = custom.timeout;
      rows.push({ label: 'timeout per experiment', html: esc(`${d ? `${d} d ` : ''}${h}h${String(m).padStart(2, '0')}`) });
    }
    const experiments = Object.values(task?.steps ?? {}).filter(step => ['ExperimentWithCargo', 'Experiment'].includes(step.name));
    const configurations = [...new Set(experiments.map(step => step.id))].sort();
    if (configurations.length) {
      rows.push({ label: 'configurations', html: chips(configurations) });
      const attempts = Math.max(...configurations.map(c => experiments.filter(step => step.id === c).length));
      const cores = [...new Set(experiments.map(step => step.nb_cores).filter(Boolean))];
      rows.push({ label: 'attempts × cores', html: esc(`${attempts} × ${cores.join('/') || '?'} per configuration`) });
    }
    // latest-asan: the preset it was resolved to at launch is in the run configuration
    const ranVendor = /:latest-asan$/.test(custom.vendor ?? '') ? custom.vendorResolved : null;
    if (custom.vendor) rows.push({ label: 'vendor', html: `<span class="mono">${esc(custom.vendor)}</span>`
        + (ranVendor ? ` → <span class="mono">${esc(ranVendor)}</span>` : '') });
    if (custom.features) rows.push({ label: 'features', html: `<span class="mono">${esc(custom.features)}</span>` });
    if (custom.parameters) rows.push({ label: 'parameters', html: `<span class="mono">${esc(custom.parameters)}</span>` });
    if (custom.campaignId || args.CAMPAIGN_ID) rows.push({ label: 'campaign', html: esc(custom.campaignId || args.CAMPAIGN_ID) });
    if (args.COMPAT_APPLIED) rows.push({ label: 'compat rules applied', html: chips(args.COMPAT_APPLIED.split(',').filter(Boolean)) });
    if (args.LIBAFL_VERSION) rows.push({ label: 'LibAFL', html: esc(args.LIBAFL_VERSION) });
    return rows;
  }

  // minutes without a new corpus entry after which the corpus is shown as stalled
  static #corpusStalledMin = 60;

  // Facts of a MonitorExperiment message: its #MONITOR_JSON line (the last one), or else read from its text
  // (messages of runs started before that line existed)
  static #MonitorFacts(text) {
    const jsonLine = text.split('\n').filter(line => line.startsWith('#MONITOR_JSON ')).pop();
    if (jsonLine) {
      try {
        return JSON.parse(jsonLine.slice('#MONITOR_JSON '.length));
      } catch (error) {
        // read the text
      }
    }
    if (!/# Experiment:|Corpus:|Objective/.test(text)) return null;
    const lines = text.split('\n');
    const find = (re) => { for (const line of lines) { const m = re.exec(line); if (m) return m; } return null; };
    const experiment = find(/# Experiment:\s*(\S+)\s*(.*)$/);
    const corpusIndex = lines.findIndex(line => /Corpus:/.test(line));
    const corpus = find(/Corpus:\s*(\d+) file\(s\), last modified:\s*(-?\d+) minutes ago/);
    const objectives = find(/Objective:\s*(\d+) file\(s\), last modified:\s*(-?\d+) minutes ago/);
    const errors = find(/Errors while fuzzing:\s*(\d+) errors, (\d+) crashes/);
    const errorIndex = lines.findIndex(line => /Errors while fuzzing/.test(line));
    const logs = find(/Logs:\s*~(\d+) MB(?: \(([\d.]+) MB per hour per core\))?(?:\s*⚠️\s*(.*))?/);
    const stats = find(/Time since last stats.json update:\s*(\d+)s/);
    return {
      experiment: experiment?.[1] ?? '',
      port: experiment?.[2]?.trim() ?? '',
      stats_age_s: stats ? Number(stats[1]) : null,
      build: find(/^\s*Build:\s*(.*)$/)?.[1] ?? '',
      asan: find(/ASAN:\s*(.*)$/)?.[1]?.trim() ?? '',
      logs: logs ? { mb: Number(logs[1]), rate: logs[2] ? Number(logs[2]) : null, warning: logs[3] ?? '' } : null,
      // the default PUT is the only unlabelled line of the header (before the corpus line)
      put: lines.slice(1, corpusIndex < 0 ? lines.length : corpusIndex).map(line => line.trim())
          .find(line => line && !/^(# Experiment|Build:|ASAN:|Logs:|Time since|Log file|Could not)/.test(line)) ?? '',
      corpus: corpus ? { count: Number(corpus[1]), age_min: Number(corpus[2]) } : null,
      errors: errors ? { count: Number(errors[1]), crashes: Number(errors[2]), last: (lines[errorIndex + 1] ?? '').trim() }
          : { count: 0, crashes: 0, last: '' },
      objectives: objectives ? {
        count: Number(objectives[1]), age_min: Number(objectives[2]),
        live: /(https?:\/\/\S+\/objectives\/live-\d+\.html)/.exec(text)?.[1] ?? '',
        recent: lines.map(line => /^\s*(\d+) min ago: (\S+)/.exec(line)).filter(Boolean)
            .map(m => ({ age_min: Number(m[1]), name: m[2] })),
      } : (/No objective yet/.test(text) ? { count: 0 } : null),
    };
  }

  // Description of a tlspuffin task for the board, the task page and the history (see launchers.js DescribeTask):
  //   title:  "Perf@dcf9ff #453 [TLS:Mapper] reduce …" for a default name ("Performance - <commit>"), or the custom
  //           name followed by the commit line ("my test · Perf@dcf9ff #453 …"; the type is unknown then)
  //   commit: the commit line without prefix, for the COMMIT_ID argument
  // The commit comes from the COMMIT_ID argument, or from the task name (the history only has the name).
  async describeTask(task) {
    const fromArgs = (task?.args ?? []).find(arg => arg.key === 'COMMIT_ID')?.value;
    const sha = /^[0-9a-f]{7,40}$/i.test(fromArgs ?? '') ? fromArgs : /\b[0-9a-f]{40}\b/i.exec(task?.name ?? '')?.[0];
    if (!sha) return null;
    const gitRestApi = new URL(this.#config.commitsUrl).origin;
    const desc = (await resolveCommits(gitRestApi, 'tlspuffin', [sha])).get(sha);
    if (!desc || desc.kind === 'unknown') return null;
    const { type, custom } = parseTaskName(task?.name ?? '', sha);
    // custom names: the type from the launcher settings, else the job type (board: job_type, history: type)
    const jobType = task?.launcher?.custom?.jobType ?? task?.job_type ?? task?.type;
    const prefix = type || JOB_TYPE_PREFIXES[jobType] || '';
    return {
      custom,
      title: commitLineHTML(desc, { prefix, custom }),
      commit: commitLineHTML(desc, { max: 80 }),
      // how the board shows the arguments: the package alone, the compat warning on its own line
      args: {
        PACKAGE: { bare: true },
        COMPAT_WARNING: { level: 'warning', label: 'compat' },
      },
    };
  }

  // ── Restore from a previous task's launcher.custom ──────────────────────────

  #applyCustom(custom) {
    if (custom.jobType) {
      const input = this.#overlay.querySelector(`#jl-chip-${CSS.escape(custom.jobType)}`);
      if (input) {
        input.checked = true;
        input.dispatchEvent(new Event('change'));
      }
    }

    if (custom.commit) {
      const item = this.#data.all.find(i => i.id === custom.commit) ?? null;
      this.#selectedCommit = item;
      this.#commitInput.value = item ? item.id.slice(0, 14) : custom.commit;
      this.#updateCommitInfo(item);
    }

    if (custom.package) this.#packageListInput.value = custom.package;

    if (custom.vendorImpl) {
      this.#vendorImpl = custom.vendorImpl;
      const implInput = this.#overlay.querySelector(`#jl-impl-${CSS.escape(custom.vendorImpl)}`);
      if (implInput) implInput.checked = true;
      this.#updateVendorAppearance();
      this.#updateVendorOptions();
    }
    if (custom.vendor)     this.#vendorListInput.value  = custom.vendor;
    if (custom.features)   this.#featuresInput.value    = custom.features;
    if (custom.parameters) this.#parametersInput.value  = custom.parameters;
    if (custom.campaignId) this.#campaignIdInput.value  = custom.campaignId;

    if (custom.timeout) {
      this.#timeoutModified = true;
      this.#timeoutDayInput.value = String(custom.timeout.d ?? 0);
      this.#timeoutInput.value    = String(custom.timeout.h ?? 0);
      this.#timeoutMinInput.value = String(custom.timeout.m ?? 0);
    }
    if (custom.nbAttempts != null) this.#nbAttemptsInput.value = String(custom.nbAttempts);
    if (custom.nbCore     != null) this.#nbCoreInput.value     = String(custom.nbCore);
    if (custom.memMax     != null) this.#memMaxInput.value     = String(custom.memMax);
    if (custom.smt        != null) this.#smtSelect.value       = custom.smt;

    if (custom.name) {
      this.#taskNameInput.value = custom.name;
      this.#titleModified = true;
    }

    this.#trackTemplateEdits();
    this.#validate();
  }

  // Launcher pre-filled from a task (relaunch as template): a field changed from the task's setting is outlined
  #templateInputs() {
    return [this.#commitInput, this.#packageListInput, this.#taskNameInput, this.#vendorListInput, this.#featuresInput,
      this.#parametersInput, this.#campaignIdInput, this.#timeoutDayInput, this.#timeoutInput, this.#timeoutMinInput,
      this.#nbAttemptsInput, this.#nbCoreInput, this.#memMaxInput, this.#smtSelect]
        // a ListInput widget: its text field
        .map(input => (input instanceof HTMLElement) ? input : input?.input)
        .filter(input => input instanceof HTMLElement);
  }

  #trackTemplateEdits() {
    for (const input of this.#templateInputs()) {
      input.dataset.template = input.value;
      input.classList.remove('jl-edited');
      if (!input.dataset.trackEdits) {
        input.dataset.trackEdits = '1';
        input.addEventListener('input', () => {
          if (input.dataset.template !== undefined) input.classList.toggle('jl-edited', input.value !== input.dataset.template);
        });
      }
    }
  }

  // ── Build DOM ─────────────────────────────────────────────────────────────

  #buildDOM() {
    this.#overlay = this.#el('div', 'jl-overlay');
    const modal = this.#el('div', 'jl-modal');
    modal.addEventListener('click', e => e.stopPropagation());
    this.#overlay.addEventListener('mousedown', () => {
      if (this.#tablistEl?.classList.contains('open'))
        this.#skipNextModalClose = true;
    });
    this.#overlay.addEventListener('click', () => {
      if (this.#skipNextModalClose) { this.#skipNextModalClose = false; return; }
      this.close();
    });
    modal.appendChild(this.#buildHeader());
    modal.appendChild(this.#buildBody());
    this.#overlay.appendChild(modal);
    document.body.appendChild(this.#overlay);
  }

  #buildHeader() {
    const hdr = this.#el('div', 'jl-header');
    this.#taskNameInput = this.#el('input', 'jl-task-name');
    this.#taskNameInput.type = 'text';
    this.#taskNameInput.placeholder = 'New Task';
    this.#taskNameInput.spellcheck = false;
    this.#taskNameInput.autocomplete = 'off';
    this.#taskNameInput.addEventListener('input', () => { this.#titleModified = true; });
    const editIcon = this.#el('span', 'jl-edit-icon');
    editIcon.textContent = '✏️';
    const closeBtn = this.#el('button', 'jl-close');
    closeBtn.textContent = '×';
    closeBtn.title = 'Close';
    closeBtn.addEventListener('click', () => this.close());
    hdr.append(editIcon, this.#taskNameInput, closeBtn);
    return hdr;
  }

  #buildBody() {
    const body = this.#el('div', 'jl-body');

    // ── Username ──
    const userSection = this.#el('div', 'jl-field-row');
    const userLabel = this.#el('span', 'jl-label');
    userLabel.textContent = 'User';
    this.#usernameInput = this.#el('input', 'jl-commit-input');
    this.#usernameInput.type = 'text';
    this.#usernameInput.placeholder = 'your name';
    this.#usernameInput.spellcheck = false;
    this.#usernameInput.autocomplete = 'off';
    this.#usernameInput.value = localStorage.getItem('jl-username') ?? '';
    this.#usernameInput.addEventListener('input', () => {
      this.#rejectInput(this.#usernameInput);
      localStorage.setItem('jl-username', this.#usernameInput.value.trim());
      this.#refreshCampaignPlaceholder();
      this.#validate();
    });
    userSection.append(userLabel, this.#usernameInput);
    body.appendChild(userSection);

    // ── Job type chips ──
    const chipSection = this.#el('div');
    const chipLabel = this.#el('span', 'jl-label');
    chipLabel.textContent = 'Job type';
    chipSection.append(chipLabel, this.#buildChips());
    body.appendChild(chipSection);

    // ── Commit ──
    const commitSection = this.#el('div');
    const commitLabel = this.#el('span', 'jl-label');
    commitLabel.textContent = 'Commit';
    this.#commitInput = this.#el('input', 'jl-commit-input');
    this.#commitInput.type = 'text';
    this.#commitInput.placeholder = 'Type a hash or pick from the list…';
    this.#commitInput.autocomplete = 'off';
    this.#commitInput.spellcheck = false;
    this.#commitInput.addEventListener('input', () => {
      this.#selectedCommit = null;
      this.#updateCommitInfo(null);
      const q = this.#commitInput.value.trim();
      this.#applyFilter(q);
      this.#scrollToMatch(q);
      this.#autoUpdateTitle();
      this.#validate();
    });
    this.#commitInput.addEventListener('focus', () => this.#openTablist());
    this.#commitInput.addEventListener('blur',  () => this.#closeTablist());

    const clearBtn = this.#el('button', 'jl-icon-btn');
    clearBtn.type  = 'button';
    clearBtn.title = 'Clear';
    clearBtn.textContent = '🧹';
    clearBtn.addEventListener('mousedown', e => e.preventDefault());
    clearBtn.addEventListener('click', () => this.#clearCommit());

    this.#refreshBtn = this.#el('button', 'jl-icon-btn', 'jl-refresh-btn');
    this.#refreshBtn.type  = 'button';
    this.#refreshBtn.title = 'Refresh commit list';
    this.#refreshBtn.textContent = '↻';
    this.#refreshBtn.addEventListener('mousedown', e => e.preventDefault());
    this.#refreshBtn.addEventListener('click', () => this.#refreshCommits());

    const inputWrap = this.#el('div', 'jl-commit-input-wrap');
    inputWrap.append(this.#commitInput, this.#refreshBtn);

    this.#commitInputRowEl = this.#el('div', 'jl-commit-input-row');
    this.#commitInputRowEl.append(clearBtn, inputWrap);

    this.#commitInfoEl = this.#el('div', 'jl-commit-info');
    const commitWrapper = this.#el('div', 'jl-commit-wrapper');
    commitWrapper.append(this.#commitInputRowEl, this.#buildTablist());
    commitSection.append(commitLabel, commitWrapper, this.#commitInfoEl);
    body.appendChild(commitSection);

    // ── Package (only for job types that declare a "package" list) ──
    this.#packageRow = this.#el('div', 'jl-field-row', 'jl-package-row');
    const packageLabel = this.#el('span', 'jl-label');
    packageLabel.textContent = 'Package';
    this.#packageListInput = new ListInput(
      () => this.#packageOptions,
      () => { this.#updateVendorOptions(); this.#validate(); },
      'jl',
    );
    this.#packageListInput.placeholder = 'e.g. tlspuffin';
    this.#packageRow.append(packageLabel, this.#packageListInput.node);
    body.appendChild(this.#packageRow);

    // ── Timeout (campaign jobs, plus any job type that declares "timeout": true) ──
    this.#timeoutSection = this.#el('div', 'jl-field-row', 'jl-timeout-section');
    const timeoutLabel = this.#el('span', 'jl-label');
    timeoutLabel.textContent = 'Timeout';
    this.#timeoutSection.append(timeoutLabel, this.#buildTimeout());
    body.appendChild(this.#timeoutSection);

    // ── CPU sharing (every job type): how the scheduler chooses the CPUs of each run (task argument SMT_MODE) ──
    const smtRow = this.#el('div', 'jl-field-row');
    const smtLabel = this.#el('span', 'jl-label');
    smtLabel.textContent = 'CPU sharing';
    this.#smtSelect = this.#el('select', 'jl-select');
    for (const [value, text] of [
      ['', 'default: whole physical cores, shared within the run'],
      ['one', 'one client per physical core (twice the CPUs)'],
      ['any', 'logical CPUs, as before (to reproduce older runs)'],
    ]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      this.#smtSelect.appendChild(option);
    }
    this.#smtSelect.title = 'The machine has 2 hardware threads per physical core: a fuzzer client runs slower when the other '
        + 'thread of its core is busy. Default: each run gets whole physical cores, its clients share them only with each '
        + 'other (the same for every run: comparable). One client per core: each client alone on its core (faster per '
        + 'client, closest to a machine running nothing else), the other threads reserved and idle. Logical CPUs: as '
        + 'before 2026-10-09, two runs may share a physical core.';
    smtRow.append(smtLabel, this.#smtSelect);
    body.appendChild(smtRow);

    // ── Campaign-only fields ──
    this.#campaignExtra = this.#el('div', 'jl-campaign-extra');
    this.#campaignExtra.append(this.#buildCampaignFields());
    body.appendChild(this.#campaignExtra);

    // ── Separator + Launch ──
    body.appendChild(this.#el('hr', 'jl-sep'));

    this.#confirmUnknownEl = this.#el('div', 'jl-confirm-unknown');
    this.#confirmUnknownCheck = this.#el('input');
    this.#confirmUnknownCheck.type = 'checkbox';
    this.#confirmUnknownCheck.id = 'jl-confirm-unknown-check';
    this.#confirmUnknownCheck.addEventListener('change', () => this.#validate());
    const confirmLabel = this.#el('label');
    confirmLabel.htmlFor = 'jl-confirm-unknown-check';
    confirmLabel.textContent = 'Unknown commit — launch anyway';
    this.#confirmUnknownEl.append(this.#confirmUnknownCheck, confirmLabel);
    body.appendChild(this.#confirmUnknownEl);

    this.#launchBtn = this.#el('button', 'jl-launch-btn');
    this.#launchBtn.textContent = 'Launch Task';
    this.#launchBtn.disabled = true;
    this.#launchBtn.addEventListener('click', () => this.#onLaunch());
    body.appendChild(this.#launchBtn);

    this.#toast = this.#el('div', 'jl-toast');
    body.appendChild(this.#toast);

    return body;
  }

  #buildChips() {
    this.#chipsWrap = this.#el('div', 'jl-chips');
    return this.#chipsWrap;
  }

  #populateChips() {
    this.#chipsWrap.innerHTML = '';
    for (const job of this.#jobDefs) {
      const input = this.#el('input', 'jl-chip-input');
      input.type  = 'radio';
      input.name  = 'jl-job-type';
      input.id    = `jl-chip-${job.value}`;
      input.value = job.value;
      input.addEventListener('change', () => {
        this.#selectedType = job.value;
        this.#campaignExtra.classList.toggle('visible', !!job.campaign);
        this.#timeoutSection.classList.toggle('visible', !!job.campaign || !!job.timeout);
        const timeoutJob = job.timeout ? job
          : this.#jobDefs.find(j => job.composite?.includes(j.value) && j.timeout);
        this.#applyTimeoutDefault(timeoutJob ?? job);
        this.#updatePackageOptions(job);
        this.#autoUpdateTitle();
        this.#validate();
      });
      const lbl = this.#el('label');
      lbl.htmlFor = `jl-chip-${job.value}`;
      lbl.style.setProperty('--jl-chip-color', job.color ?? '#888');
      const dot = this.#el('span', 'jl-dot');
      lbl.append(dot, ' ' + job.label);
      this.#chipsWrap.append(input, lbl);
    }
  }

  #updatePackageOptions(job) {
    this.#packageOptions = Array.isArray(job?.package) ? job.package : [];
    this.#packageRow.classList.toggle('visible', this.#packageOptions.length > 0);
    this.#packageListInput.value = this.#packageOptions[0] ?? '';
    this.#updateVendorOptions();
  }

  #updateVendorOptions() {
    const pkg = this.#packageListInput.value.trim();
    const catalog = this.#vendorCatalog[pkg]?.[this.#vendorImpl] ?? [];
    // <vendor>:latest-asan of each library of the package, first
    const protocol = JobLauncher.#PROTOCOLS[pkg];
    const libs = this.#vendorImpl !== 'c' ? []
        : this.#presetsData?.vendors ? Object.keys(this.#presetsData.vendors).filter(v => !protocol || protocol.test(v))
        : [...new Set(catalog.map(v => v.split(':')[0]))];
    this.#vendorOptions = [...libs.map(v => `${v}:${JobLauncher.#LATEST}`), ...catalog];
  }

  // the vendor of the run: <vendor>:latest-asan resolved at the commit, otherwise the field as typed
  #resolvedVendor() {
    const value = this.#vendorListInput.value.trim();
    const preset = this.#currentPreset();
    return preset?.latest ? `${preset.vendor}:${preset.name}` : value;
  }

  async #loadJobsConfig() {
    try {
      const res = await fetch(this.#config.jobsConfigUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      this.#jobDefs = json.jobs ?? [];
      this.#vendorCatalog = (json.vendors && typeof json.vendors === 'object') ? json.vendors : {};
      this.#populateChips();
    } catch (err) {
      console.warn('[JobLauncher] failed to load jobs config:', err);
    }
  }

  #buildTablist() {
    this.#tablistEl = this.#el('div', 'jl-dropdown');
    this.#listEl = this.#el('div', 'jl-list');
    this.#tablistEl.appendChild(this.#listEl);

    // prevent blur on commit input when interacting with the tablist
    this.#tablistEl.addEventListener('mousedown', e => e.preventDefault());
    this.#tablistEl.addEventListener('wheel', e => {
      e.preventDefault();
      this.#listEl.scrollTop += e.deltaY;
    }, { passive: false });

    const footer = this.#el('div', 'jl-tabs-footer');
    const tabs = [
      { key: 'dev',     label: 'main/dev' },
      { key: 'pr_open', label: 'PR' },
      { key: 'pr',      label: 'branches' },
      { key: 'all',     label: 'All' },
    ];
    for (const t of tabs) {
      const btn = this.#el('button', 'jl-tab-btn');
      btn.textContent = t.label;
      btn.type = 'button';
      if (t.key === this.#activeTab) btn.classList.add('active');
      btn.addEventListener('click', () => {
        this.#activeTab = t.key;
        Object.values(this.#tabBtns).forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.#renderList();
        this.#applyFilter(this.#commitInput.value.trim());
        this.#updateRefreshBtnStyle();
      });
      this.#tabBtns[t.key] = btn;
      footer.appendChild(btn);
    }
    this.#tablistEl.appendChild(footer);
    return this.#tablistEl;
  }

  #openTablist() {
    const rect = this.#commitInputRowEl.getBoundingClientRect();
    this.#tablistEl.style.top   = (rect.bottom + 4) + 'px';
    this.#tablistEl.style.left  = rect.left + 'px';
    this.#tablistEl.style.width = rect.width + 'px';
    this.#tablistEl.classList.add('open');
    this.#refreshBtn.classList.add('visible');
    this.#updateRefreshBtnStyle();
  }
  #closeTablist() {
    if (this.#isLoading) return;
    this.#tablistEl.classList.remove('open');
    this.#refreshBtn.classList.remove('visible');
  }

  #buildTimeout() {
    const row = this.#el('div', 'jl-timeout-row');

    this.#timeoutDayInput = this.#el('input', 'jl-timeout-input');
    this.#timeoutDayInput.type = 'number';
    this.#timeoutDayInput.min = '0';
    this.#timeoutDayInput.step = '1';
    this.#timeoutDayInput.value = '0';
    const unitD = this.#el('span', 'jl-timeout-unit');
    unitD.textContent = 'd';

    this.#timeoutInput = this.#el('input', 'jl-timeout-input');
    this.#timeoutInput.type = 'number';
    this.#timeoutInput.min = '0';
    this.#timeoutInput.max = '23';
    this.#timeoutInput.step = '1';
    this.#timeoutInput.value = '3';
    const unitH = this.#el('span', 'jl-timeout-unit');
    unitH.textContent = 'h';

    this.#timeoutMinInput = this.#el('input', 'jl-timeout-input');
    this.#timeoutMinInput.type = 'number';
    this.#timeoutMinInput.min = '0';
    this.#timeoutMinInput.max = '59';
    this.#timeoutMinInput.step = '1';
    this.#timeoutMinInput.value = '0';
    const unitM = this.#el('span', 'jl-timeout-unit');
    unitM.textContent = 'min';

    for (const inp of [this.#timeoutDayInput, this.#timeoutInput, this.#timeoutMinInput]) {
      inp.addEventListener('input', () => { this.#timeoutModified = true; });
    }

    row.append(this.#timeoutDayInput, unitD, this.#timeoutInput, unitH, this.#timeoutMinInput, unitM);
    return row;
  }

  #applyTimeoutDefault(job) {
    if (this.#timeoutModified) return;
    const def = job?.timeout_default ?? {};
    this.#timeoutDayInput.value = String(def.d ?? 0);
    this.#timeoutInput.value    = String(def.h ?? 3);
    this.#timeoutMinInput.value = String(def.m ?? 0);
  }

  #buildCampaignFields() {
    const wrap = this.#el('div', 'jl-campaign-fields');

    const campaignIdRow = this.#el('div', 'jl-field-row');
    const campaignIdLabel = this.#el('span', 'jl-label');
    campaignIdLabel.textContent = 'Campaign ID';
    this.#campaignIdInput = this.#el('input', 'jl-commit-input');
    this.#campaignIdInput.type = 'text';
    // optional: empty = camp-<user>-<date>-<time> (the folder of the campaign's results, one per launch)
    this.#campaignIdInput.placeholder = this.#defaultCampaignId();
    this.#campaignIdInput.spellcheck = false;
    this.#campaignIdInput.autocomplete = 'off';
    this.#campaignIdInput.addEventListener('input', () => {
      this.#rejectInput(this.#campaignIdInput, /[^a-zA-Z0-9_@-]/g);
      this.#autoUpdateTitle();
      this.#validate();
    });
    campaignIdRow.append(campaignIdLabel, this.#campaignIdInput);

    const implRow = this.#el('div', 'jl-field-row');
    const implLabel = this.#el('span', 'jl-label');
    implLabel.textContent = 'Impl';
    const implChips = this.#el('div', 'jl-chips');
    for (const impl of [{ value: 'c', label: 'C' }, { value: 'rust', label: 'Rust' }]) {
      const input = this.#el('input', 'jl-chip-input');
      input.type  = 'radio';
      input.name  = 'jl-vendor-impl';
      input.id    = `jl-impl-${impl.value}`;
      input.value   = impl.value;
      input.checked = impl.value === this.#vendorImpl;
      input.addEventListener('change', () => {
        this.#vendorImpl = impl.value;
        // Rust harness: the asan feature selects the ASAN build of the in-tree library; on by default
        if (impl.value === 'rust' && !this.#featuresInput.value.trim()) this.#featuresInput.value = 'asan';
        this.#updateVendorAppearance();
        this.#updateVendorOptions();
        this.#validate();
      });
      const lbl = this.#el('label');
      lbl.htmlFor = `jl-impl-${impl.value}`;
      const dot = this.#el('span', 'jl-dot');
      lbl.append(dot, ' ' + impl.label);
      implChips.append(input, lbl);
    }
    implRow.append(implLabel, implChips);

    const vendorRow = this.#el('div', 'jl-field-row');
    const vendorLabel = this.#el('span', 'jl-label');
    vendorLabel.textContent = 'Vendor';
    this.#vendorListInput = new ListInput(
      () => this.#vendorOptions,
      () => { this.#validate(); this.#onVendorChange(false); },
      'jl',
    );
    this.#vendorListInput.placeholder = 'e.g. wolfssl:wolfssl540';
    this.#vendorListInput.input.addEventListener('input', () => this.#onVendorChange(false));
    this.#presetBtn = this.#el('button', 'jl-preset-btn');
    this.#presetBtn.type = 'button';
    this.#presetBtn.textContent = '＋ presets of this commit';
    this.#presetBtn.title = 'Pick a vendor preset among those of the chosen commit (puffin-build/vendors/*/presets.toml)';
    this.#presetBtn.addEventListener('click', () => this.#togglePresetPanel());
    const vendorLine = this.#el('div', 'jl-vendor-line');
    vendorLine.append(this.#vendorListInput.node, this.#presetBtn);
    this.#presetPanel = this.#el('div', 'jl-presets');
    this.#vendorNote = this.#el('div', 'jl-vendor-note');
    const vendorField = this.#el('div', 'jl-vendor-field');
    vendorField.append(vendorLine, this.#presetPanel, this.#vendorNote);
    vendorRow.append(vendorLabel, vendorField);

    const featRow = this.#el('div', 'jl-field-row');
    const featLabel = this.#el('span', 'jl-label');
    featLabel.textContent = 'Features';
    this.#featuresInput = this.#el('input', 'jl-commit-input');
    this.#featuresInput.type = 'text';
    this.#featuresInput.placeholder = 'e.g. introspection';
    this.#featuresInput.spellcheck = false;
    this.#featuresInput.autocomplete = 'off';
    this.#featuresInput.addEventListener('input', () => {
      const preset = this.#currentPreset();
      if (preset?.asan && !this.#features().includes('asan')) this.#asanRemoved = true;
      this.#updateVendorNote();
    });
    featRow.append(featLabel, this.#featuresInput);

    const paramsRow = this.#el('div', 'jl-field-row');
    const paramsLabel = this.#el('span', 'jl-label');
    paramsLabel.textContent = 'Parameters';
    this.#parametersInput = this.#el('input', 'jl-commit-input');
    this.#parametersInput.type = 'text';
    this.#parametersInput.placeholder = 'e.g. --put-use-clear';
    this.#parametersInput.spellcheck = false;
    this.#parametersInput.autocomplete = 'off';
    paramsRow.append(paramsLabel, this.#parametersInput);

    const resourcesRow = this.#el('div', 'jl-field-row');
    const resourcesLabel = this.#el('span', 'jl-label');
    resourcesLabel.textContent = 'Resources';

    const attemptsSubLabel = this.#el('span', 'jl-mem-sublabel');
    attemptsSubLabel.textContent = 'Attempts';
    this.#nbAttemptsInput = this.#el('input', 'jl-timeout-input');
    this.#nbAttemptsInput.type = 'number';
    this.#nbAttemptsInput.min = '1';
    this.#nbAttemptsInput.step = '1';
    this.#nbAttemptsInput.value = '1';

    const coreSubLabel = this.#el('span', 'jl-mem-sublabel');
    coreSubLabel.textContent = 'Cores';
    this.#nbCoreInput = this.#el('input', 'jl-timeout-input');
    this.#nbCoreInput.type = 'number';
    this.#nbCoreInput.min = '1';
    this.#nbCoreInput.step = '1';
    this.#nbCoreInput.value = '1';

    const memSubLabel = this.#el('span', 'jl-mem-sublabel');
    memSubLabel.textContent = 'Memory';
    this.#memMaxInput = this.#el('input', 'jl-timeout-input');
    this.#memMaxInput.type = 'number';
    this.#memMaxInput.min = '0';
    this.#memMaxInput.step = '256';
    this.#memMaxInput.value = '0';
    const memMaxUnit = this.#el('span', 'jl-timeout-unit');
    memMaxUnit.textContent = 'MB';

    const resourcesInputs = this.#el('div', 'jl-mem-inputs');
    resourcesInputs.append(
      attemptsSubLabel, this.#nbAttemptsInput,
      coreSubLabel, this.#nbCoreInput,
      memSubLabel, this.#memMaxInput, memMaxUnit,
    );
    resourcesRow.append(resourcesLabel, resourcesInputs);

    wrap.append(campaignIdRow, implRow, vendorRow, featRow, paramsRow, resourcesRow);
    return wrap;
  }

  #updateVendorAppearance() {
    const isRust = this.#vendorImpl === 'rust';
    this.#vendorListInput.placeholder = isRust ? 'e.g. wolfssl540' : 'e.g. wolfssl:wolfssl540';
    this.#featuresInput.placeholder = isRust ? 'e.g. asan,introspection' : 'e.g. introspection';
  }

  // ── Load commits ──────────────────────────────────────────────────────────

  async #loadCommits(refreshParam = null) {
    try {
      const url = refreshParam
        ? `${this.#config.commitsUrl}?refresh=${refreshParam}`
        : this.#config.commitsUrl;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();

      const commits = json.commits  ?? [];
      const pr      = json.branches ?? [];
      const prOpen  = (json.PR ?? []).filter(p => p.state === 'open');
      this.#prApiInfos = json.PR_API_Infos ?? null;

      this.#data.dev     = commits.filter(c => c.branch === 'dev' || c.branch === 'main');
      this.#data.pr_open = prOpen;
      this.#data.pr      = pr;
      this.#data.all = [
        ...commits,
        ...prOpen.map(p => ({ id: p.id, date: p.date, comment: p.comment, _branch: p.branch })),
        ...pr.map(p    => ({ id: p.id, date: p.date, comment: p.comment, _branch: p.branch })),
      ].sort((a, b) => (b.date > a.date ? 1 : -1));

      this.#renderList();
    } catch (err) {
      console.warn('[JobLauncher] failed to load commits:', err);
      this.#listEl.innerHTML = '';
      const msg = this.#el('div', 'jl-list-empty');
      msg.textContent = 'Failed to load commits.';
      this.#listEl.appendChild(msg);
    }
  }

  // ── Render list ───────────────────────────────────────────────────────────

  #renderList() {
    this.#listEl.innerHTML = '';
    const items = this.#currentItems();

    if (items.length === 0) {
      const msg = this.#el('div', 'jl-list-empty');
      msg.textContent = 'No commits available.';
      this.#listEl.appendChild(msg);
      return;
    }

    for (const item of items) {
      const isPR = this.#activeTab === 'pr' || this.#activeTab === 'pr_open' || item._branch !== undefined;
      const row  = this.#el('div', 'jl-item');
      if (this.#selectedCommit?.id === item.id) row.classList.add('selected');

      // first cell: optional badge + hash stacked
      const hashWrap = this.#el('div', 'jl-item-hash-wrap');
      if (item.branch) {
        const badge = this.#el('span', 'jl-item-badge',
          item.branch === 'main' ? 'jl-branch-main' : 'jl-branch-dev');
        badge.textContent = item.branch;
        hashWrap.appendChild(badge);
      } else if (isPR) {
        const badge = this.#el('span', 'jl-item-badge', 'jl-branch-pr');
        badge.textContent = item.branch ?? item._branch ?? 'pr';
        hashWrap.appendChild(badge);
      }
      const hash = this.#el('span', 'jl-item-hash');
      hash.textContent = item.id.slice(0, 14);
      hashWrap.appendChild(hash);

      const date = this.#el('span', 'jl-item-date');
      date.textContent = item.date;

      const comment = this.#el('span', 'jl-item-comment');
      comment.textContent = item.comment;

      row.append(hashWrap, date, comment);

      row.addEventListener('click', () => {
        this.#selectedCommit = item;
        this.#commitInput.value = item.id.slice(0, 14);
        this.#updateCommitInfo(item);
        this.#listEl.querySelectorAll('.jl-item').forEach(r => r.classList.remove('selected'));
        row.classList.add('selected');
        this.#closeTablist();
        this.#autoUpdateTitle();
        this.#validate();
      });

      this.#listEl.appendChild(row);
    }

    const q = this.#commitInput?.value.trim();
    if (q) this.#scrollToMatch(q);
  }

  #currentItems() {
    switch (this.#activeTab) {
      case 'dev':     return this.#data.dev;
      case 'pr_open': return this.#data.pr_open;
      case 'pr':      return this.#data.pr;
      case 'all':     return this.#data.all;
      default:        return [];
    }
  }

  // ── Commit field actions ──────────────────────────────────────────────────

  #clearCommit() {
    this.#commitInput.value = '';
    this.#selectedCommit    = null;
    this.#updateCommitInfo(null);
    this.#autoUpdateTitle();
    this.#validate();
  }

  async #refreshCommits() {
    const param = this.#activeTab === 'pr_open' ? 'all' : 'local';
    this.#isLoading = true;
    this.#refreshBtn.classList.add('loading');
    this.#tablistEl.classList.add('loading');
    this.#listEl.innerHTML = '';
    this.#listEl.appendChild(this.#el('div', 'jl-list-spinner'));
    try {
      await this.#loadCommits(param);
    } finally {
      this.#isLoading = false;
      this.#refreshBtn.classList.remove('loading');
      this.#tablistEl.classList.remove('loading');
    }
  }

  #updateRefreshBtnStyle() {
    if (!this.#refreshBtn) return;
    const isPR = this.#activeTab === 'pr_open';
    this.#refreshBtn.classList.toggle('jl-refresh-pr', isPR);
    if (isPR && this.#prApiInfos) {
      //const reset = new Date(this.#prApiInfos.apiResetTS * 1000).toLocaleString();
      const resetDate = new Date(this.#prApiInfos.apiResetTS * 1000).toLocaleString(navigator.languages, { 
          month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', hour12: false});
      this.#refreshBtn.title =
        `Refresh PRs (GitHub API)\nCredits remaining: ${this.#prApiInfos.apiRemaining}\nReset: ${resetDate}`;
    } else {
      this.#refreshBtn.title = 'Refresh commit list';
    }
  }

  // ── Scroll to match ───────────────────────────────────────────────────────

  #scrollToMatch(text) {
    if (!text) return;
    const items = this.#currentItems();
    const rows  = this.#listEl.querySelectorAll('.jl-item');
    for (let i = 0; i < items.length; i++) {
      if (items[i].id.startsWith(text)) {
        const row = rows[i];
        if (row) {
          const offset = row.offsetTop
            - this.#listEl.clientHeight / 2
            + row.clientHeight / 2;
          this.#listEl.scrollTop = Math.max(0, offset);
        }
        break;
      }
    }
  }

  // ── Commit info ───────────────────────────────────────────────────────────

  #updateCommitInfo(item) {
    this.#commitInfoEl.innerHTML = '';
    if (!item) { this.#commitInfoEl.classList.remove('visible'); return; }

    const branchName = item.branch ?? item._branch ?? null;
    if (branchName) {
      const cls = branchName === 'main' ? 'jl-branch-main'
                : branchName === 'dev'  ? 'jl-branch-dev'
                : 'jl-branch-pr';
      const badge = this.#el('span', 'jl-item-badge', cls);
      badge.textContent = branchName;
      this.#commitInfoEl.appendChild(badge);
    }

    const msg = this.#el('span', 'jl-commit-info-msg');
    msg.textContent = item.comment;
    const date = this.#el('span', 'jl-commit-info-date');
    date.textContent = item.date;
    this.#commitInfoEl.append(msg, date);
    this.#commitInfoEl.classList.add('visible');
  }

  // ── Filter list ───────────────────────────────────────────────────────────

  #applyFilter(text) {
    const q = text.toLowerCase();
    const rows  = this.#listEl.querySelectorAll('.jl-item');
    const items = this.#currentItems();
    rows.forEach((row, i) => {
      const item = items[i];
      const match = !q
        || item.id.toLowerCase().includes(q)
        || item.comment.toLowerCase().includes(q)
        || (item.branch ?? item._branch ?? '').toLowerCase().includes(q);
      row.style.display = match ? '' : 'none';
    });
  }

  // ── Vendor presets ────────────────────────────────────────────────────────
  // The picker: library (of the protocol of the package: TLS or SSH) → version → variant (plain, asan, perf, CVE
  // presets…), from puffin-build/vendors/*/presets.toml at the chosen commit. A vendor typed by hand that is not a
  // preset there is flagged. ASAN: an ASAN preset gets the asan feature (needed before tlspuffin 854dbaa11,
  // 2024-10-03, which links the ASAN runtime only with it; harmless after); the asan feature with a non-ASAN preset
  // is flagged (before that commit it links the ASAN runtime against a library built without ASAN).

  static #ASAN_LINK_DATE = '2024-10-03';
  // protocol of a vendor from its name (libssh, wolfssh…: SSH; OPC UA vendors of other branches apart; the others:
  // TLS), so that a new vendor shows up
  static #OPCUA = /^(open62541|s2opc)/i;
  static #PROTOCOLS = { tlspuffin: { label: 'TLS', test: (v) => !/ssh/i.test(v) && !JobLauncher.#OPCUA.test(v) },
                        sshpuffin: { label: 'SSH', test: (v) => /ssh/i.test(v) } };
  static #LIBRARY_NAMES = { openssl: 'OpenSSL', boringssl: 'BoringSSL', libressl: 'LibreSSL', wolfssl: 'wolfSSL',
                            libssh: 'libssh', wolfssh: 'wolfSSH' };

  #features() {
    return this.#featuresInput.value.split(/[\s,]+/).filter(Boolean);
  }

  #commitSha() {
    return this.#selectedCommit?.id ?? (/^[0-9a-f]{7,40}$/i.test(this.#commitInput.value.trim()) ? this.#commitInput.value.trim() : null);
  }

  // the preset of the vendor field, when the presets of the commit are known: { vendor, preset } or null
  // <vendor>:latest-asan: the ASAN preset of the vendor's newest release at the commit (latest: true)
  #currentPreset() {
    const [vendor, name] = this.#vendorListInput.value.trim().split(':');
    const presets = this.#presetsData?.vendors?.[vendor];
    if (name === JobLauncher.#LATEST) {
      const latest = presets ? JobLauncher.#latestAsan(presets) : null;
      return latest ? { vendor, ...latest, latest: true } : null;
    }
    const preset = presets?.find(p => p.name === name);
    return preset ? { vendor, ...preset } : null;
  }

  static #LATEST = 'latest-asan';

  #refreshPresets() {
    const sha = this.#commitSha();
    if (this.#vendorImpl !== 'c' || !sha) {
      this.#presetsData = null;
      this.#presetsFor = null;
      this.#renderPresetPanel();
      this.#updateVendorNote();
      return;
    }
    if (this.#presetsFor === sha) return;
    this.#presetsFor = sha;
    this.#presetsData = null;
    if (!this.#presets.has(sha)) {
      const url = `${new URL(this.#config.commitsUrl).origin}/api/git/presets/tlspuffin/${sha}`;
      this.#presets.set(sha, fetch(url).then(r => r.ok ? r.json() : null).catch(() => null));
    }
    this.#renderPresetPanel();
    this.#presets.get(sha).then(data => {
      if (this.#presetsFor !== sha) return;
      if (!data) this.#presets.delete(sha);  // retried next time
      this.#presetsData = data ?? { error: true };
      this.#updateVendorOptions();
      this.#renderPresetPanel();
      this.#updateVendorNote();
    });
  }

  #togglePresetPanel() {
    const open = !this.#presetPanel.classList.contains('open');
    this.#presetPanel.classList.toggle('open', open);
    this.#presetBtn.classList.toggle('on', open);
    this.#presetBtn.textContent = open ? '－ presets of this commit' : '＋ presets of this commit';
    if (open) {
      this.#presetLib = null;
      this.#refreshPresets();
      this.#renderPresetPanel();
    }
  }

  // name → { base: 'wolfssl540', variant: 'sdos2' | 'plain' }
  static #splitPreset(name) {
    const i = name.indexOf('-');
    return i < 0 ? { base: name, variant: 'plain' } : { base: name.slice(0, i), variant: name.slice(i + 1) };
  }

  // build modifiers of a version (plain, or made of asan, perf, gcov: asan-perf…); any other suffix is a custom
  // library (its own modifications, e.g. a CVE preset)
  static #isModifier(variant) {
    return variant === 'plain' || variant.split('-').every(part => ['asan', 'perf', 'gcov'].includes(part));
  }

  static #compareVersions(a, b) {
    const rank = (v) => /^(master|main)$/.test(v) ? 1 : 0;
    if (rank(a) !== rank(b)) return rank(b) - rank(a);
    return b.localeCompare(a, 'en', { numeric: true });
  }

  // latest-asan of a library: the ASAN preset of its newest release at the commit (master/main left out: moving
  // branches), or null
  static #latestAsan(presets) {
    const asan = presets.filter(p => JobLauncher.#splitPreset(p.name).variant === 'asan' && !/^(master|main)$/.test(p.version));
    return asan.sort((a, b) => JobLauncher.#compareVersions(a.version, b.version))[0] ?? null;
  }

  #renderPresetPanel() {
    const panel = this.#presetPanel;
    if (!panel) return;
    this.#presetBtn.hidden = this.#vendorImpl !== 'c';
    if (!panel.classList.contains('open')) return;
    panel.innerHTML = '';
    const status = (text) => { const el = this.#el('div', 'jl-presets-status'); el.textContent = text; panel.appendChild(el); };
    if (!this.#commitSha()) return status('Choose a commit first.');
    const data = this.#presetsData;
    if (!data) return status('Loading the presets of this commit…');
    if (data.error) return status('The presets could not be read (git_restapi). Type the vendor.');
    if (data.format === 'none') return status('No presets file at this commit (puffin-build/vendors/*/presets.toml, tlspuffin since autumn 2024): type the vendor.');

    const pkg = this.#packageListInput.value.trim() || 'tlspuffin';
    const protocol = JobLauncher.#PROTOCOLS[pkg];
    const vendors = Object.keys(data.vendors).filter(v => !protocol || protocol.test(v));
    const current = this.#currentPreset();
    const [typedVendor] = this.#vendorListInput.value.trim().split(':');
    const lib = this.#presetLib ?? (vendors.includes(typedVendor) ? typedVendor : vendors[0]);
    const currentSplit = current ? JobLauncher.#splitPreset(current.name) : null;

    const row = (label, chips) => {
      const line = this.#el('div', 'jl-presets-row');
      const title = this.#el('span', 'jl-presets-label');
      title.textContent = label;
      const list = this.#el('div', 'jl-presets-chips');
      list.append(...chips);
      line.append(title, list);
      panel.appendChild(line);
    };
    const chip = (text, on, title, onClick, extra = '') => {
      const button = this.#el('button', 'jl-preset-chip', ...(on ? ['on'] : []), ...extra.split(' ').filter(Boolean));
      button.type = 'button';
      button.textContent = text;
      button.title = title;
      button.addEventListener('click', onClick);
      return button;
    };

    row(protocol ? protocol.label : 'Library', vendors.map(v => chip(
        JobLauncher.#LIBRARY_NAMES[v] ?? v, v === lib,
        `${data.vendors[v].length} presets at this commit: ${data.vendors[v].map(p => p.name).join(', ')}`,
        () => { this.#presetLib = v; this.#renderPresetPanel(); })));

    // a preset is a build modifier of a version (plain, asan, perf, asan-perf) or a custom library: a version with
    // its own modifications (CVE presets such as buf, heap, sdos2), listed apart
    const presets = data.vendors[lib] ?? [];
    const bases = new Map();
    const custom = [];
    for (const preset of presets) {
      const { base, variant } = JobLauncher.#splitPreset(preset.name);
      if (!JobLauncher.#isModifier(variant)) {
        custom.push({ base, variant, preset });
        continue;
      }
      if (!bases.has(base)) bases.set(base, { version: preset.version || base, variants: [] });
      bases.get(base).variants.push({ variant, preset });
    }
    const ordered = [...bases.entries()].sort((a, b) => JobLauncher.#compareVersions(a[1].version, b[1].version));
    const isCustom = !!current && current.vendor === lib && !JobLauncher.#isModifier(currentSplit.variant);
    const shownBase = (current && current.vendor === lib && !isCustom) ? currentSplit.base : null;
    const pick = (preset) => {
      this.#vendorListInput.value = `${lib}:${preset.name}`;
      this.#onVendorChange(true);
      this.#validate();
      this.#renderPresetPanel();
    };
    const describe = (preset) => `${preset.name}${preset.asan ? ' · ASAN' : ''}`
        + (preset.fix.length ? ' · patches ' + preset.fix.join(', ') : ' · no patch')
        + (preset.postauth === false ? ' · postauth off' : '');
    const latest = JobLauncher.#latestAsan(presets);
    const latestOn = !!current?.latest && current.vendor === lib;
    const latestChip = latest ? [chip(`latest-asan · ${latest.version}`, latestOn,
        `${lib}:latest-asan, the newest release of ${JobLauncher.#LIBRARY_NAMES[lib] ?? lib} at the commit, with ASAN `
        + `(here ${latest.name}); resolved at launch, so a relaunch on another commit takes its latest. `
        + 'The default for fuzzing the latest version.',
        () => pick({ ...latest, name: JobLauncher.#LATEST }), 'latest')] : [];
    row('Version', [...latestChip, ...ordered.map(([base, info]) => chip(info.version, base === shownBase && !latestOn, base, () => {
      const plain = info.variants.find(v => v.variant === 'plain') ?? info.variants[0];
      pick(plain.preset);
    }))]);
    if (shownBase && bases.has(shownBase) && !latestOn) {
      const order = (v) => v === 'plain' ? 0 : v.split('-').length;
      const variants = [...bases.get(shownBase).variants].sort((a, b) => order(a.variant) - order(b.variant) || a.variant.localeCompare(b.variant));
      row('Modifier', variants.map(({ variant, preset }) => chip(variant, preset.name === current.name, describe(preset),
          () => pick(preset), preset.asan ? 'asan' : '')));
    }
    if (custom.length) {
      custom.sort((a, b) => JobLauncher.#compareVersions(a.preset.version, b.preset.version) || a.variant.localeCompare(b.variant));
      row('Custom', custom.map(({ variant, preset }) => chip(`${variant} ${preset.version}`, isCustom && preset.name === current.name,
          describe(preset), () => pick(preset), preset.asan ? 'cve asan' : 'cve')));
    }
    if (current) {
      const info = this.#el('div', 'jl-presets-info');
      info.innerHTML = (current.latest ? `<b>${current.vendor}:latest-asan</b> → ` : '') + `<b>${current.vendor}:${current.name}</b> · ${current.version}`
        + ` · ${current.asan ? '<span class="jl-asan-on">ASAN✓</span>' : 'ASAN✗'}`
        + (current.fix.length ? ` · patches ${current.fix.join(', ')}` : ' · no patch')
        + (current.postauth === false ? ' · postauth off' : '');
      panel.appendChild(info);
    }
  }

  // byPicker: chosen in the picker (adds the asan feature for an ASAN preset); typed: only the note
  #onVendorChange(byPicker) {
    const preset = this.#currentPreset();
    const asanName = /-asan(-|$)/.test(this.#vendorListInput.value.trim());
    if (byPicker) this.#asanRemoved = false;
    if (byPicker && (preset?.asan ?? asanName) && !this.#features().includes('asan')) {
      this.#featuresInput.value = [...this.#features(), 'asan'].join(',');
    }
    if (!byPicker) this.#presetLib = null;  // the picker follows a vendor typed by hand
    this.#renderPresetPanel();
    this.#updateVendorNote();
  }

  #updateVendorNote() {
    const note = this.#vendorNote;
    if (!note) return;
    const notes = [];
    const value = this.#vendorListInput.value.trim();
    const data = this.#presetsData;
    const sha = this.#commitSha();
    if (this.#vendorImpl === 'c' && value && data?.format === 'presets.toml' && !this.#currentPreset()) {
      notes.push(`⚠ <b>${value.replace(/</g, '&lt;')}</b> is not a preset at ${sha.slice(0, 7)}: the build will fail. `
               + 'See ＋ presets of this commit.');
    }
    // the commit contains tlspuffin 854dbaa11 (git_restapi: asan_link), else its date when unknown
    const date = this.#selectedCommit?.date ?? null;
    const before = typeof data?.asan_link === 'boolean' ? !data.asan_link
                 : date ? date < JobLauncher.#ASAN_LINK_DATE : null;
    const when = before === null ? 'on a commit without tlspuffin 854dbaa11 (2024-10-03)'
               : before ? 'at this commit (without tlspuffin 854dbaa11, 2024-10-03)' : null;
    const preset = this.#currentPreset();
    // the presets of the commit known: only an existing preset counts (an unknown one is flagged above)
    const known = data?.format !== 'presets.toml';
    const asanPreset = this.#vendorImpl === 'c' && (preset ? preset.asan : (known && /-asan(-|$)/.test(value)));
    const asanFeature = this.#features().includes('asan');
    if (asanPreset && !asanFeature) {
      notes.push(when ? `⚠ ASAN preset without the <b>asan</b> feature: ${when} the ASAN runtime is then not linked.`
                      : '<span class="jl-note-ok">ASAN preset without the <b>asan</b> feature: fine at this commit (the runtime is linked from the preset).</span>');
    }
    if (this.#vendorImpl === 'c' && value && asanFeature && !asanPreset && (preset || known)) {
      notes.push(when ? `⚠ <b>asan</b> feature with a preset built without ASAN: ${when} the ASAN runtime is linked against a library that is not instrumented.`
                      : '<span class="jl-note-ok"><b>asan</b> feature with a preset built without ASAN: no effect at this commit.</span>');
    }
    note.innerHTML = notes.map(n => `<div>${n}</div>`).join('');
  }

  // ── Auto title ────────────────────────────────────────────────────────────

  #resolveLabel(template, commit) {
    return template
      .replace(/\$?\{COMMIT:(\d+)\}/g, (_, n) => commit.slice(0, +n))
      .replace(/\$\{CAMPAIGN-ID\}/g, () => this.#campaignId());
  }

  // Campaign ID when none is typed: camp-<user>-<YYYYMMDD-HHMM>; the results of a campaign are stored under
  // <package>/Campaign/<user>/<campaign ID>/, so one per launch (a typed ID can group several launches)
  #defaultCampaignId(date = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    const user = (this.#usernameInput?.value.trim() || 'user').replace(/[^a-zA-Z0-9_@-]/g, '');
    return `camp-${user}-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
         + `-${pad(date.getHours())}${pad(date.getMinutes())}`;
  }
  #campaignId() {
    return this.#campaignIdInput.value.trim() || this.#launchCampaignId || this.#defaultCampaignId();
  }
  #refreshCampaignPlaceholder() {
    if (!this.#campaignIdInput) return;
    this.#campaignIdInput.placeholder = this.#defaultCampaignId();
    this.#campaignIdInput.title = 'Optional. Empty: ' + this.#defaultCampaignId() + ' (the time of the launch)';
    this.#autoUpdateTitle();
  }

  #autoUpdateTitle() {
    if (this.#titleModified) return;
    const commit = this.#commitInput.value.trim().slice(0, 14);
    const label  = this.#selectedCommit?.state !== undefined
      ? (this.#selectedCommit.branch ?? commit)
      : commit;
    if (this.#selectedType) {
      const jobDef = this.#jobDefs.find(j => j.value === this.#selectedType);
      if (jobDef) {
        if (typeof jobDef.job_label === 'string') {
          this.#taskNameInput.value = this.#resolveLabel(jobDef.job_label, commit);
          return;
        }
        this.#taskNameInput.value = jobDef.composite?.length
          ? [jobDef.label, label].filter(Boolean).join(' ')
          : [jobDef.label, label].filter(Boolean).join(' - ');
        return;
      }
    }
    this.#taskNameInput.value = label;
  }

  // ── Validation ────────────────────────────────────────────────────────────

  #validate() {
    const raw      = this.#commitInput.value.trim();
    const isHex    = /^[0-9a-f]{7,}$/i.test(raw);
    const isKnown  = this.#selectedCommit !== null;
    const isUnknown = isHex && !isKnown;

    this.#confirmUnknownEl.classList.toggle('visible', isUnknown);
    if (!isUnknown) this.#confirmUnknownCheck.checked = false;

    const userOk    = this.#usernameInput.value.trim().length > 0;
    const typeOk    = this.#selectedType !== null;
    const commitOk  = isKnown || isHex;
    const confirmOk = !isUnknown || this.#confirmUnknownCheck.checked;
    const jobDef        = this.#jobDefs.find(j => j.value === this.#selectedType);
    const vendorOk      = !jobDef?.campaign || this.#vendorListInput.value.trim().length > 0;
    const packageOk     = !jobDef?.package?.length || this.#packageListInput.value.trim().length > 0;
    this.#launchBtn.disabled = !(userOk && typeOk && commitOk && confirmOk && vendorOk && packageOk);
    if (jobDef?.campaign) this.#refreshPresets();
  }

  // ── Launch ────────────────────────────────────────────────────────────────

  async #onLaunch() {
    const commit  = this.#selectedCommit?.id ?? this.#commitInput.value.trim();
    const jobType = this.#selectedType;
    if (!commit || !jobType) return;

    const jobDef = this.#jobDefs.find(j => j.value === jobType);
    if (!jobDef) return;

    this.#showToast('', '');
    this.#launchBtn.disabled = true;
    this.#launchBtn.textContent = 'Launching…';

    this.#launchCampaignId = this.#defaultCampaignId();
    try {
      const baseName = this.#taskNameInput.value.trim() || 'New Task';
      const custom = this.#captureCustom(commit, baseName);
      if (jobDef.composite?.length) {
        const subJobs = jobDef.composite.map(v => this.#jobDefs.find(j => j.value === v)).filter(Boolean);
        const results = await Promise.all(
          subJobs.map((sub, i) => {
            const subName = Array.isArray(jobDef.job_label) && jobDef.job_label[i]
              ? this.#resolveLabel(jobDef.job_label[i], commit)
              : `${baseName} - ${sub.label}`;
            return this.#launchSingleJob(commit, sub, subName, custom);
          })
        );
        const allOk = results.every(r => r.ok);
        const lines = results.map((r, i) =>
          `${subJobs[i].label}: ${r.ok ? 'OK' + (r.task_id ? ` (${r.task_id})` : '') : 'FAILED - ' + r.error}`
        );
        this.#showToast(allOk ? 'success' : 'error', lines.join('\n'));
      } else {
        const result = await this.#launchSingleJob(commit, jobDef, baseName, custom);
        if (result.ok) {
          this.#showToast('success',
            `Task queued.\nCommit  : ${commit}\nType    : ${jobType}` +
            (result.task_id ? `\nTask ID : ${result.task_id}` : '')
          );
        } else {
          this.#showToast('error', `Launch failed: ${result.error}`);
        }
      }
    } catch (err) {
      this.#showToast('error', `Request failed:\n${err.message}`);
    } finally {
      this.#launchBtn.disabled = false;
      this.#launchBtn.textContent = 'Launch Task';
      this.#launchBtn.title = '';
      this.#launchCampaignId = null;
      this.#validate();
    }
  }

  // Captures the current form state so the task can be reopened identically
  // via the board's "New task..." restart button (task.launcher.custom).
  #captureCustom(commit, name) {
    return {
      jobType:    this.#selectedType,
      commit,
      name,
      package:    this.#packageListInput.value.trim(),
      vendorImpl: this.#vendorImpl,
      vendor:     this.#vendorListInput.value.trim(),
      vendorResolved: this.#resolvedVendor(),  // <vendor>:latest-asan: the preset it ran with
      features:   this.#featuresInput.value.trim(),
      parameters: this.#parametersInput.value.trim(),
      campaignId: this.#campaignIdInput.value.trim(),
      timeout: {
        d: parseInt(this.#timeoutDayInput.value, 10) || 0,
        h: parseInt(this.#timeoutInput.value,    10) || 0,
        m: parseInt(this.#timeoutMinInput.value, 10) || 0,
      },
      nbAttempts: parseInt(this.#nbAttemptsInput.value, 10) || 1,
      nbCore:     parseInt(this.#nbCoreInput.value,     10) || 1,
      memMax:     parseInt(this.#memMaxInput.value,     10) || 0,
      smt:        this.#smtSelect.value,
    };
  }

  async #launchSingleJob(commit, jobDef, name, custom) {
    try {
      const isCampaign = !!jobDef.campaign;
      const hasTimeout = isCampaign || !!jobDef.timeout;
      const timeoutD   = hasTimeout ? (parseInt(this.#timeoutDayInput.value,  10) || 0) : 0;
      const timeoutH   = hasTimeout ? (parseInt(this.#timeoutInput.value,    10) || 0) : 0;
      const timeoutM   = hasTimeout ? (parseInt(this.#timeoutMinInput.value,  10) || 0) : 0;
      const timeoutStr = hasTimeout ? `${timeoutD * 1440 + timeoutH * 60 + timeoutM}m` : null;
      const vendor     = isCampaign ? (this.#resolvedVendor() || null) : null;
      if (isCampaign && /:latest-asan$/.test(this.#vendorListInput.value.trim()) && !this.#currentPreset()) {
        return { ok: false, error: `${this.#vendorListInput.value.trim()}: no ASAN release of this library in the presets of the commit` };
      }
      const features   = isCampaign ? (this.#featuresInput.value.trim()   || null) : null;
      const parameters = isCampaign ? (this.#parametersInput.value.trim() || null) : null;

      this.#launchStage('Fetching the job files…');
      const configRes = await fetch(jobDef.config);
      if (!configRes.ok) throw new Error(`Failed to fetch ${jobDef.config}: HTTP ${configRes.status}`);
      const configText = await configRes.text();

      const otherPaths = [jobDef.script, ...(jobDef.files ?? [])];
      const blobs = await Promise.all(otherPaths.map(async path => {
        const res = await fetch(path);
        if (!res.ok) throw new Error(`Failed to fetch ${path}: HTTP ${res.status}`);
        return res.blob();
      }));

      // The config file is a JSON template with unresolved ${RUNTIME_*} tokens
      // (resolved server-side), so it can't be JSON.parse'd here — the launcher
      // metadata is spliced in as raw text instead, right after the root '{'.
      const launcherJSON = JSON.stringify({ project: 'tlspuffin', custom });
      const configWithLauncher = configText.replace('{', `{"launcher":${launcherJSON},`);
      const configBlob = new Blob([configWithLauncher], { type: 'application/json' });

      const fd = new FormData();
      fd.append('name',     name);
      fd.append('user',     this.#usernameInput.value.trim());
      fd.append('job_type', jobDef.job_type ?? jobDef.value);
      fd.append('config',   configBlob, jobDef.config.split('/').pop());
      fd.append('script',   blobs[0], jobDef.script.split('/').pop());
      for (let i = 0; i < (jobDef.files ?? []).length; i++)
        fd.append('files[]', blobs[1 + i], jobDef.files[i].split('/').pop());

      fd.append('args[COMMIT_ID]', commit);
      fd.append('args[PACKAGE]', this.#packageListInput.value.trim() || 'tlspuffin');
      // CPU sharing: the machine's default unless asked
      if (this.#smtSelect.value) fd.append('args[SMT_MODE]', this.#smtSelect.value);
      if (isCampaign) {
        fd.append('args[CAMPAIGN_ID]', this.#campaignId());
        fd.append('args[SAVE_CORPUS]', 1);
        fd.append('args[DISABLE_KILL_ON_HANG]', 1);
      }
      const nbAttempts = isCampaign ? (parseInt(this.#nbAttemptsInput.value, 10) || null) : null;
      const nbCore     = isCampaign ? (parseInt(this.#nbCoreInput.value,     10) || null) : null;
      const memMax     = isCampaign ? (parseInt(this.#memMaxInput.value,     10) || null) : null;
      if (timeoutStr != null) fd.append('runtime[RUNTIME_TIMEOUT]',           timeoutStr);
      if (nbAttempts != null) fd.append('runtime[RUNTIME_NB_RUN]',            String(nbAttempts));
      if (nbCore     != null) fd.append('runtime[RUNTIME_NB_CORES]',          String(nbCore));
      if (memMax     > 0)     fd.append('runtime[RUNTIME_MEMORY_CORE]',        String(memMax));
      if (memMax     > 0)     fd.append('runtime[RUNTIME_MEMORY_CONSUMPTION]', String(memMax));
      if (isCampaign) {
        const configName = vendor ? vendor.split(':').pop() : 'campaign';
        const conf = { args: {} };
        if (this.#vendorImpl === 'c'    && vendor)   conf.args.vendor             = vendor;
        if (this.#vendorImpl === 'rust' && vendor)   conf.args.features           = vendor;
        else                                         conf.args.features           = '';
        if (features)                                conf.args.required_features  = features;
        if (parameters)                              conf.args.extra_flags        = parameters;
        conf.args.experiment = vendor || features;
        if (nbCore > 0)     conf.nb_cores         = nbCore;
        fd.append('runtime[RUNTIME_RUN_CONFIG]', JSON.stringify({ [configName]: conf }));
      }

      // A submission waits for the schedule lock, so ask the scheduler how it is before
      // sending one: a stopping or saturated scheduler is then named plainly instead of
      // surfacing later as an opaque "no answer from the scheduler (NetworkError)".
      this.#launchStage('Checking the scheduler…');
      const health = await CheckScheduler();
      if (health.warning) {
        if (health.health.state === 'down') {
          return { ok: false, error: health.warning };
        }
        this.#showToast('warn', health.warning);
      }

      this.#launchStage('Submitting to the scheduler…');
      const slow = setTimeout(() => this.#launchStage('Waiting for the scheduler (busy, e.g. ending a task)…'), 10000);
      const response = await fetch(this.#config.launchUrl, { method: 'POST', body: fd }).finally(() => clearTimeout(slow));
      if (response.ok) {
        const data = await response.json().catch(() => ({}));
        // the scheduler answers 200 with success false when the task is refused
        if (data.success === false) return { ok: false, error: data.error ?? 'refused by the scheduler' };
        return { ok: true, task_id: data.task_id };
      }
      const text = await response.text().catch(() => response.statusText);
      return { ok: false, error: `${response.status}: ${text}` };
    } catch (err) {
      // the request got no answer (connection closed or timed out): the scheduler may have queued it anyway
      if (err instanceof TypeError)
        return { ok: false, error: `no answer from the scheduler (${err.message}).\n` +
            'The task may have been queued anyway: check the board before launching it again.' };
      return { ok: false, error: err.message };
    }
  }

  // what the launch is waiting for, on the button (a launch waits for the scheduler while it ends a task)
  #launchStage(text) {
    this.#launchBtn.textContent = text;
    this.#launchBtn.title = text;
  }

  // ── Toast ─────────────────────────────────────────────────────────────────

  #showToast(type, msg) {
    this.#toast.className = 'jl-toast';
    this.#toast.textContent = msg;
    if (type) {
      this.#toast.classList.add(type);
      if (type === 'success') {
        setTimeout(() => { this.#toast.className = 'jl-toast'; }, 12000);
      }
    }
  }

  // ── Reset ─────────────────────────────────────────────────────────────────

  #reset() {
    for (const input of this.#templateInputs()) { delete input.dataset.template; input.classList.remove('jl-edited'); }
    this.#selectedType   = null;
    this.#selectedCommit = null;
    this.#titleModified  = false;
    this.#timeoutModified = false;
    this.#updateCommitInfo(null);
    this.#taskNameInput.value = '';
    this.#overlay.querySelectorAll('input[name="jl-job-type"]').forEach(i => i.checked = false);
    this.#commitInput.value = '';
    this.#packageListInput.value = '';
    this.#packageOptions = [];
    this.#packageRow.classList.remove('visible');
    this.#campaignExtra.classList.remove('visible');
    this.#timeoutSection.classList.remove('visible');
    this.#timeoutDayInput.value  = '0';
    this.#timeoutInput.value     = '3';
    this.#timeoutMinInput.value  = '0';
    this.#vendorImpl = 'c';
    this.#overlay.querySelectorAll('input[name="jl-vendor-impl"]').forEach(i => i.checked = i.value === 'c');
    this.#updateVendorAppearance();
    this.#campaignIdInput.value  = '';
    this.#vendorListInput.value  = '';
    this.#vendorOptions = [];
    this.#featuresInput.value    = '';
    this.#parametersInput.value  = '';
    this.#asanRemoved = false;
    this.#presetPanel?.classList.remove('open');
    if (this.#vendorNote) this.#vendorNote.innerHTML = '';
    this.#nbAttemptsInput.value  = '1';
    this.#nbCoreInput.value      = '1';
    this.#memMaxInput.value      = '0';
    this.#confirmUnknownCheck.checked = false;
    this.#confirmUnknownEl.classList.remove('visible');
    this.#launchBtn.disabled = true;
    this.#launchBtn.textContent = 'Launch Task';
    this.#showToast('', '');
    this.#activeTab = 'dev';
    Object.entries(this.#tabBtns).forEach(([k, b]) => b.classList.toggle('active', k === 'dev'));
    this.#updateRefreshBtnStyle();
    this.#renderList();
  }

  // ── Utils ─────────────────────────────────────────────────────────────────

  #rejectInput(el, allowed = /[^a-zA-Z0-9_-]/g) {
    const raw       = el.value;
    const start     = el.selectionStart;
    const sanitized = raw.replace(allowed, '');
    if (sanitized === raw) return;
    el.value = sanitized;
    const newCursor = raw.slice(0, start).replace(allowed, '').length;
    el.setSelectionRange(newCursor, newCursor);
    el.classList.remove('jl-input-reject');
    void el.offsetWidth; // force reflow to restart animation
    el.classList.add('jl-input-reject');
    el.addEventListener('animationend', () => el.classList.remove('jl-input-reject'), { once: true });
  }

  #el(tag, ...classes) {
    const el = document.createElement(tag);
    if (classes.length) el.classList.add(...classes);
    return el;
  }
}
