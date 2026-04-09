export class JobLauncher {
  #config;
  #data = { dev: [], pr: [], all: [] };
  #jobDefs = [];
  #activeTab  = 'dev';
  #selectedType   = null;
  #selectedCommit = null;
  #skipNextModalClose = false;
  #titleModified = false;

  // DOM refs
  #overlay        = null;
  #chipsWrap      = null;
  #taskNameInput  = null;
  #commitInput    = null;
  #listEl         = null;
  #tablistEl      = null;
  #campaignExtra   = null;
  #timeoutSection  = null;
  #timeoutDayInput = null;
  #timeoutInput    = null;
  #timeoutMinInput = null;
  #featuresInput   = null;
  #parametersInput = null;
  #nbAttemptsInput = null;
  #nbCoreInput     = null;
  #memBaseInput    = null;
  #memMaxInput     = null;
  #vendorInput     = null;
  #usernameInput  = null;
  #commitInfoEl   = null;
  #launchBtn           = null;
  #confirmUnknownEl    = null;
  #confirmUnknownCheck = null;
  #toast               = null;
  #tabBtns             = {};

  constructor(config = {}) {
    this.#config = {
      commitsUrl:    config.commitsUrl    ?? './git.json',
      jobsConfigUrl: config.jobsConfigUrl ?? './jobs_config.json',
      launchUrl:     config.launchUrl     ?? '/api/task/new',
    };
    this.#buildDOM();
  }

  open()  {
    this.#overlay.classList.add('open');
    this.#loadCommits();
    if (!this.#jobDefs.length) this.#loadJobsConfig();
  }
  close() { this.#overlay.classList.remove('open'); this.#reset(); }

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
    const closeBtn = this.#el('button', 'jl-close');
    closeBtn.textContent = '×';
    closeBtn.title = 'Close';
    closeBtn.addEventListener('click', () => this.close());
    hdr.append(this.#taskNameInput, closeBtn);
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
      localStorage.setItem('jl-username', this.#usernameInput.value.trim());
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
    this.#commitInput.addEventListener('wheel', e => {
      if (this.#tablistEl.classList.contains('open')) {
        e.preventDefault();
        this.#listEl.scrollTop += e.deltaY;
      }
    }, { passive: false });

    this.#commitInfoEl = this.#el('div', 'jl-commit-info');
    const commitWrapper = this.#el('div', 'jl-commit-wrapper');
    commitWrapper.append(this.#commitInput, this.#buildTablist());
    commitSection.append(commitLabel, commitWrapper, this.#commitInfoEl);
    body.appendChild(commitSection);

    // ── Campaign-only fields ──
    this.#campaignExtra = this.#el('div', 'jl-campaign-extra');

    this.#timeoutSection = this.#el('div', 'jl-field-row');
    const timeoutLabel = this.#el('span', 'jl-label');
    timeoutLabel.textContent = 'Timeout';
    this.#timeoutSection.append(timeoutLabel, this.#buildTimeout());

    this.#campaignExtra.append(this.#timeoutSection, this.#buildCampaignFields());
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

  async #loadJobsConfig() {
    try {
      const res = await fetch(this.#config.jobsConfigUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      this.#jobDefs = json.jobs ?? [];
      this.#populateChips();
    } catch (err) {
      console.warn('[JobLauncher] failed to load jobs config:', err);
    }
  }

  #buildTablist() {
    this.#tablistEl = this.#el('div', 'jl-tablist');
    this.#listEl = this.#el('div', 'jl-list');
    this.#tablistEl.appendChild(this.#listEl);

    // prevent blur on commit input when interacting with the tablist
    this.#tablistEl.addEventListener('mousedown', e => e.preventDefault());

    const footer = this.#el('div', 'jl-tabs-footer');
    const tabs = [
      { key: 'dev', label: 'main/dev' },
      { key: 'pr',  label: 'PR heads' },
      { key: 'all', label: 'All' },
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
      });
      this.#tabBtns[t.key] = btn;
      footer.appendChild(btn);
    }
    this.#tablistEl.appendChild(footer);
    return this.#tablistEl;
  }

  #openTablist() {
    const rect = this.#commitInput.getBoundingClientRect();
    this.#tablistEl.style.top   = (rect.bottom + 4) + 'px';
    this.#tablistEl.style.left  = rect.left + 'px';
    this.#tablistEl.style.width = rect.width + 'px';
    this.#tablistEl.classList.add('open');
  }
  #closeTablist() { this.#tablistEl.classList.remove('open'); }

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

    row.append(this.#timeoutDayInput, unitD, this.#timeoutInput, unitH, this.#timeoutMinInput, unitM);
    return row;
  }

  #buildCampaignFields() {
    const wrap = this.#el('div', 'jl-campaign-fields');

    const vendorRow = this.#el('div', 'jl-field-row');
    const vendorLabel = this.#el('span', 'jl-label');
    vendorLabel.textContent = 'Vendor';
    this.#vendorInput = this.#el('input', 'jl-commit-input');
    this.#vendorInput.type = 'text';
    this.#vendorInput.placeholder = 'e.g. wolfssl:wolfssl540';
    this.#vendorInput.spellcheck = false;
    this.#vendorInput.autocomplete = 'off';
    this.#vendorInput.addEventListener('input', () => this.#validate());
    vendorRow.append(vendorLabel, this.#vendorInput);

    const featRow = this.#el('div', 'jl-field-row');
    const featLabel = this.#el('span', 'jl-label');
    featLabel.textContent = 'Features';
    this.#featuresInput = this.#el('input', 'jl-commit-input');
    this.#featuresInput.type = 'text';
    this.#featuresInput.placeholder = 'e.g. cputs';
    this.#featuresInput.spellcheck = false;
    this.#featuresInput.autocomplete = 'off';
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

    const nbAttemptsRow = this.#el('div', 'jl-field-row');
    const nbAttemptsLabel = this.#el('span', 'jl-label');
    nbAttemptsLabel.textContent = 'Attempts';
    this.#nbAttemptsInput = this.#el('input', 'jl-timeout-input');
    this.#nbAttemptsInput.type = 'number';
    this.#nbAttemptsInput.min = '1';
    this.#nbAttemptsInput.step = '1';
    this.#nbAttemptsInput.value = '1';
    nbAttemptsRow.append(nbAttemptsLabel, this.#nbAttemptsInput);

    const nbCoreRow = this.#el('div', 'jl-field-row');
    const nbCoreLabel = this.#el('span', 'jl-label');
    nbCoreLabel.textContent = 'Cores';
    this.#nbCoreInput = this.#el('input', 'jl-timeout-input');
    this.#nbCoreInput.type = 'number';
    this.#nbCoreInput.min = '1';
    this.#nbCoreInput.step = '1';
    this.#nbCoreInput.value = '1';
    nbCoreRow.append(nbCoreLabel, this.#nbCoreInput);

    const memRow = this.#el('div', 'jl-field-row');
    const memLabel = this.#el('span', 'jl-label');
    memLabel.textContent = 'Memory';
    const memInputs = this.#el('div', 'jl-mem-inputs');
    const memBaseLabel = this.#el('span', 'jl-mem-sublabel');
    memBaseLabel.textContent = 'base';
    this.#memBaseInput = this.#el('input', 'jl-timeout-input');
    this.#memBaseInput.type = 'number';
    this.#memBaseInput.min = '0';
    this.#memBaseInput.step = '256';
    this.#memBaseInput.value = '0';
    const memBaseUnit = this.#el('span', 'jl-timeout-unit');
    memBaseUnit.textContent = 'MB';
    const memMaxLabel = this.#el('span', 'jl-mem-sublabel');
    memMaxLabel.textContent = 'max';
    this.#memMaxInput = this.#el('input', 'jl-timeout-input');
    this.#memMaxInput.type = 'number';
    this.#memMaxInput.min = '0';
    this.#memMaxInput.step = '256';
    this.#memMaxInput.value = '0';
    const memMaxUnit = this.#el('span', 'jl-timeout-unit');
    memMaxUnit.textContent = 'MB';
    memInputs.append(memBaseLabel, this.#memBaseInput, memBaseUnit, memMaxLabel, this.#memMaxInput, memMaxUnit);
    memRow.append(memLabel, memInputs);

    wrap.append(vendorRow, featRow, paramsRow, nbAttemptsRow, nbCoreRow, memRow);
    return wrap;
  }

  // ── Load commits ──────────────────────────────────────────────────────────

  async #loadCommits() {
    try {
      const res = await fetch(this.#config.commitsUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();

      const commits = json.commits ?? [];
      const pr      = json.PR      ?? [];

      this.#data.dev = commits.filter(c => c.branch === 'dev' || c.branch === 'main');
      this.#data.pr  = pr;
      this.#data.all = [
        ...commits,
        ...pr.map(p => ({ id: p.id, date: p.date, comment: p.comment, _branch: p.branch })),
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
      const isPR = this.#activeTab === 'pr' || item._branch !== undefined;
      const row  = this.#el('div', 'jl-list-item');
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
      hash.textContent = item.id;
      hashWrap.appendChild(hash);

      const date = this.#el('span', 'jl-item-date');
      date.textContent = item.date;

      const comment = this.#el('span', 'jl-item-comment');
      comment.textContent = item.comment;

      row.append(hashWrap, date, comment);

      row.addEventListener('click', () => {
        this.#selectedCommit = item;
        this.#commitInput.value = item.id;
        this.#updateCommitInfo(item);
        this.#listEl.querySelectorAll('.jl-list-item').forEach(r => r.classList.remove('selected'));
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
      case 'dev': return this.#data.dev;
      case 'pr':  return this.#data.pr;
      case 'all': return this.#data.all;
      default:    return [];
    }
  }

  // ── Scroll to match ───────────────────────────────────────────────────────

  #scrollToMatch(text) {
    if (!text) return;
    const items = this.#currentItems();
    const rows  = this.#listEl.querySelectorAll('.jl-list-item');
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
    const rows  = this.#listEl.querySelectorAll('.jl-list-item');
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

  // ── Auto title ────────────────────────────────────────────────────────────

  #autoUpdateTitle() {
    if (this.#titleModified) return;
    const parts = [];
    if (this.#selectedType) {
      const jobDef = this.#jobDefs.find(j => j.value === this.#selectedType);
      if (jobDef) parts.push(jobDef.label);
    }
    const commit = this.#commitInput.value.trim();
    if (commit) parts.push(commit.slice(0, 7));
    this.#taskNameInput.value = parts.join(' - ');
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
    const jobDef    = this.#jobDefs.find(j => j.value === this.#selectedType);
    const vendorOk  = !jobDef?.campaign || this.#vendorInput.value.trim().length > 0;
    this.#launchBtn.disabled = !(userOk && typeOk && commitOk && confirmOk && vendorOk);
  }

  // ── Launch ────────────────────────────────────────────────────────────────

  async #onLaunch() {
    const commit  = this.#selectedCommit?.id ?? this.#commitInput.value.trim();
    const jobType = this.#selectedType;
    if (!commit || !jobType) return;

    const jobDef = this.#jobDefs.find(j => j.value === jobType);
    if (!jobDef) return;

    const isCampaign = !!jobDef.campaign;
    const timeoutD   = isCampaign ? (parseInt(this.#timeoutDayInput.value,  10) || 0) : 0;
    const timeoutH   = isCampaign ? (parseInt(this.#timeoutInput.value,    10) || 0) : 0;
    const timeoutM   = isCampaign ? (parseInt(this.#timeoutMinInput.value,  10) || 0) : 0;
    const timeoutStr = isCampaign ? `${timeoutD * 1440 + timeoutH * 60 + timeoutM}m` : null;
    const vendor     = isCampaign ? (this.#vendorInput.value.trim()      || null) : null;
    const features   = isCampaign ? (this.#featuresInput.value.trim()   || null) : null;
    const parameters = isCampaign ? (this.#parametersInput.value.trim() || null) : null;

    this.#showToast('', '');
    this.#launchBtn.disabled = true;
    this.#launchBtn.textContent = 'Launching…';

    try {
      // fetch all job files in parallel
      const allPaths = [jobDef.config, jobDef.script, ...(jobDef.files ?? [])];
      const blobs = await Promise.all(allPaths.map(async path => {
        const res = await fetch(path);
        if (!res.ok) throw new Error(`Failed to fetch ${path}: HTTP ${res.status}`);
        return res.blob();
      }));

      const fd = new FormData();
      fd.append('name',     this.#taskNameInput.value.trim() || 'New Task');
      fd.append('user',     this.#usernameInput.value.trim());
      fd.append('job_type', jobDef.job_type ?? jobDef.value);
      fd.append('config',   blobs[0], jobDef.config.split('/').pop());
      fd.append('script',   blobs[1], jobDef.script.split('/').pop());
      for (let i = 0; i < (jobDef.files ?? []).length; i++)
        fd.append('files[]', blobs[2 + i], jobDef.files[i].split('/').pop());

      fd.append('args[COMMIT_ID]', commit);
      const nbAttempts = isCampaign ? (parseInt(this.#nbAttemptsInput.value, 10) || null) : null;
      const nbCore     = isCampaign ? (parseInt(this.#nbCoreInput.value,     10) || null) : null;
      const memBase    = isCampaign ? (parseInt(this.#memBaseInput.value,    10) || null) : null;
      const memMax     = isCampaign ? (parseInt(this.#memMaxInput.value,     10) || null) : null;
      if (timeoutStr != null) fd.append('runtime[RUNTIME_TIMEOUT]',           timeoutStr);
      if (nbAttempts != null) fd.append('runtime[RUNTIME_NB_RUN]',            String(nbAttempts));
      if (nbCore     != null) fd.append('runtime[RUNTIME_NB_CORES]',          String(nbCore));
      if (memBase    > 0)     fd.append('runtime[RUNTIME_MEMORY_CORE]',        String(memBase));
      if (memMax     > 0)     fd.append('runtime[RUNTIME_MEMORY_CONSUMPTION]', String(memMax));
      if (isCampaign) {
        // Derive config name from vendor: "wolfssl:wolfssl540" → "wolfssl540"
        const configName = vendor ? vendor.split(':').pop() : 'campaign';
        const conf = { args: {} };
        if (vendor)         conf.args.vendor      = vendor;
        if (features)       conf.args.features    = features;
        if (parameters)     conf.args.extra_flags = parameters;
        if (nbCore > 0)     conf.nb_cores         = nbCore;
        fd.append('runtime[RUNTIME_RUN_CONFIG]', JSON.stringify({ [configName]: conf }));
      }

      const response = await fetch(this.#config.launchUrl, { method: 'POST', body: fd });

      if (response.ok) {
        const data = await response.json().catch(() => ({}));
        this.#showToast('success',
          `Task queued.\n` +
          `Commit  : ${commit}\n` +
          `Type    : ${jobType}\n` +
          (timeoutStr != null ? `Timeout : ${timeoutStr}\n` : '') +
          (data.task_id   ? `Task ID : ${data.task_id}` : '')
        );
      } else {
        const text = await response.text().catch(() => response.statusText);
        this.#showToast('error', `Server error ${response.status}:\n${text}`);
      }
    } catch (err) {
      this.#showToast('error', `Request failed:\n${err.message}`);
    } finally {
      this.#launchBtn.disabled = false;
      this.#launchBtn.textContent = 'Launch Task';
      this.#validate();
    }
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
    this.#selectedType   = null;
    this.#selectedCommit = null;
    this.#titleModified  = false;
    this.#updateCommitInfo(null);
    this.#taskNameInput.value = '';
    this.#overlay.querySelectorAll('input[name="jl-job-type"]').forEach(i => i.checked = false);
    this.#commitInput.value = '';
    this.#campaignExtra.classList.remove('visible');
    this.#timeoutDayInput.value  = '0';
    this.#timeoutInput.value     = '3';
    this.#timeoutMinInput.value  = '0';
    this.#vendorInput.value      = '';
    this.#featuresInput.value    = '';
    this.#parametersInput.value  = '';
    this.#nbAttemptsInput.value  = '1';
    this.#nbCoreInput.value      = '1';
    this.#memBaseInput.value     = '0';
    this.#memMaxInput.value      = '0';
    this.#confirmUnknownCheck.checked = false;
    this.#confirmUnknownEl.classList.remove('visible');
    this.#launchBtn.disabled = true;
    this.#launchBtn.textContent = 'Launch Task';
    this.#showToast('', '');
    this.#activeTab = 'dev';
    Object.entries(this.#tabBtns).forEach(([k, b]) => b.classList.toggle('active', k === 'dev'));
    this.#renderList();
  }

  // ── Utils ─────────────────────────────────────────────────────────────────

  #el(tag, ...classes) {
    const el = document.createElement(tag);
    if (classes.length) el.classList.add(...classes);
    return el;
  }
}
