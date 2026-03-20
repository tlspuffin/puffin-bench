export class JobLauncher {
  #config;
  #data = { dev: [], pr: [], all: [] };
  #activeTab  = 'dev';
  #selectedType   = null;
  #selectedCommit = null;
  #skipNextModalClose = false;

  // DOM refs
  #overlay        = null;
  #taskNameInput  = null;
  #commitInput    = null;
  #listEl         = null;
  #tablistEl      = null;
  #timeoutSection  = null;
  #timeoutInput    = null;
  #timeoutMinInput = null;
  #commitInfoEl   = null;
  #launchBtn      = null;
  #toast          = null;
  #tabBtns        = {};

  constructor(config = {}) {
    this.#config = {
      commitsUrl: config.commitsUrl ?? './git.json',
      launchUrl:  config.launchUrl  ?? '/api/job/launch',
    };
    this.#buildDOM();
  }

  open()  { 
    this.#overlay.classList.add('open');
    this.#loadCommits();
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
    const closeBtn = this.#el('button', 'jl-close');
    closeBtn.textContent = '×';
    closeBtn.title = 'Close';
    closeBtn.addEventListener('click', () => this.close());
    hdr.append(this.#taskNameInput, closeBtn);
    return hdr;
  }

  #buildBody() {
    const body = this.#el('div', 'jl-body');

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
      this.#validate();
    });
    this.#commitInput.addEventListener('focus', () => this.#openTablist());
    this.#commitInput.addEventListener('blur',  () => this.#closeTablist());

    this.#commitInfoEl = this.#el('div', 'jl-commit-info');
    const commitWrapper = this.#el('div', 'jl-commit-wrapper');
    commitWrapper.append(this.#commitInput, this.#buildTablist());
    commitSection.append(commitLabel, commitWrapper, this.#commitInfoEl);
    body.appendChild(commitSection);

    // ── Timeout (Campaign only) ──
    this.#timeoutSection = this.#el('div', 'jl-timeout');
    const timeoutLabel = this.#el('span', 'jl-label');
    timeoutLabel.textContent = 'Timeout';
    this.#timeoutSection.append(timeoutLabel, this.#buildTimeout());
    body.appendChild(this.#timeoutSection);

    // ── Separator + Launch ──
    body.appendChild(this.#el('hr', 'jl-sep'));

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
    const defs = [
      { id: 'jl-chip-vuln-a',   value: 'vuln-a',   label: 'Vuln group A' },
      { id: 'jl-chip-vuln-b',   value: 'vuln-b',   label: 'Vuln group B' },
      { id: 'jl-chip-perf',     value: 'perf',     label: 'Perf' },
      { id: 'jl-chip-campaign', value: 'campaign', label: 'Campaign' },
    ];
    const wrap = this.#el('div', 'jl-chips');
    for (const c of defs) {
      const input = this.#el('input', 'jl-chip-input');
      input.type = 'radio';
      input.name = 'jl-job-type';
      input.id = c.id;
      input.value = c.value;
      input.addEventListener('change', () => {
        this.#selectedType = c.value;
        this.#timeoutSection.classList.toggle('visible', c.value === 'campaign');
        this.#validate();
      });
      const lbl = this.#el('label');
      lbl.htmlFor = c.id;
      const dot = this.#el('span', 'jl-dot');
      lbl.append(dot, ' ' + c.label);
      wrap.append(input, lbl);
    }
    return wrap;
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

    this.#timeoutInput = this.#el('input', 'jl-timeout-input');
    this.#timeoutInput.type = 'number';
    this.#timeoutInput.min = '0';
    this.#timeoutInput.step = '1';
    this.#timeoutInput.placeholder = '0';
    const unitH = this.#el('span', 'jl-timeout-unit');
    unitH.textContent = 'h';

    this.#timeoutMinInput = this.#el('input', 'jl-timeout-input');
    this.#timeoutMinInput.type = 'number';
    this.#timeoutMinInput.min = '0';
    this.#timeoutMinInput.max = '59';
    this.#timeoutMinInput.step = '1';
    this.#timeoutMinInput.placeholder = '0';
    const unitM = this.#el('span', 'jl-timeout-unit');
    unitM.textContent = 'min';

    row.append(this.#timeoutInput, unitH, this.#timeoutMinInput, unitM);
    return row;
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
      const isPR  = this.#activeTab === 'pr' || item._branch !== undefined;
      const isDev = this.#activeTab === 'dev';
      const row   = this.#el('div', 'jl-list-item');
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

  // ── Validation ────────────────────────────────────────────────────────────

  #validate() {
    const commitOk = this.#selectedCommit !== null
      || this.#commitInput.value.trim().length >= 7;
    const typeOk = this.#selectedType !== null;
    this.#launchBtn.disabled = !(commitOk && typeOk);
  }

  // ── Launch ────────────────────────────────────────────────────────────────

  async #onLaunch() {
    const commit  = this.#selectedCommit?.id ?? this.#commitInput.value.trim();
    const jobType = this.#selectedType;
    const timeoutH = jobType === 'campaign'
      ? (parseInt(this.#timeoutInput.value, 10) || 0)
      : 0;
    const timeoutM = jobType === 'campaign'
      ? (parseInt(this.#timeoutMinInput.value, 10) || 0)
      : 0;
    const timeoutMinutes = timeoutH * 60 + timeoutM || null;

    if (!commit || !jobType) return;

    const taskName = this.#taskNameInput.value.trim() || 'New Task';
    const payload = { name: taskName, commit, job_type: jobType, timeout_minutes: timeoutMinutes };
    this.#showToast('', '');
    this.#launchBtn.disabled = true;
    this.#launchBtn.textContent = 'Launching…';

    try {
      // placeholder — replace/extend with real endpoint when ready
      const response = await fetch(this.#config.launchUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        const data = await response.json().catch(() => ({}));
        this.#showToast('success',
          `Task queued.\n` +
          `Commit  : ${commit}\n` +
          `Type    : ${jobType}\n` +
          (timeoutMinutes != null ? `Timeout : ${timeoutH}h ${timeoutM}min\n` : '') +
          (data.task_id ? `Task ID : ${data.task_id}` : '')
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
    this.#updateCommitInfo(null);
    this.#taskNameInput.value = '';
    this.#overlay.querySelectorAll('input[name="jl-job-type"]').forEach(i => i.checked = false);
    this.#commitInput.value = '';
    this.#timeoutSection.classList.remove('visible');
    this.#timeoutInput.value = '';
    this.#timeoutMinInput.value = '';
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
