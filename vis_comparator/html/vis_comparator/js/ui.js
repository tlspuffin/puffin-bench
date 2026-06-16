import {CommitHelp} from "./commithelp.js";
import { ICONS, BRANCH_PR_PALETTE } from './constants.js';

function buildOption(configOption) {
  const option = document.createElement('option');
  option.value = configOption.value;
  option.defaultSelected = configOption?.selected ?? false;
  option.innerText = configOption?.text ?? configOption.value;
  option.disabled = configOption?.disabled ?? false;
  return option;
}

/**
 * DOM component factory for modal forms.
 * Uses an internal counter (#id) to generate unique element IDs.
 * Call Reset() before building each modal to restart the counter.
 */
class UI {
  #id;

  constructor() {
    this.Reset();
  }

  /** Resets the internal ID counter. Call before building a new modal. */
  Reset() {
    this.#id = 0;
  }

  /** Returns the current value of the ID counter (useful for anchoring time inputs). */
  ID() {
    return this.#id;
  }

  /**
   * Creates a heading element.
   * @param {string} text    - Heading text
   * @param {string} level   - HTML tag, e.g. 'h3'
   * @param {object} options - #ApplyOptions options (id, className)
   * @returns {HTMLElement}
   */
  CreateTitle(text, level, options) {
    const title = document.createElement(level);
    this.#ApplyOptions(title, options);
    title.innerText = text;
    return title;
  }

  /**
   * Creates a <select> element populated with options.
   * @param {Array<{value: string, text?: string, selected?: boolean, disabled?: boolean}>} configOptions
   * @param {object} options - #ApplyOptions options
   * @returns {HTMLSelectElement}
   */
  CreateSelect(configOptions, options) {
    const select = document.createElement('select');
    this.#ApplyOptions(select, options);
    for (const configOption of configOptions) select.appendChild(buildOption(configOption));
    return select;
  }

  /**
   * Replaces the options in an existing <select> element.
   * @param {HTMLSelectElement} element
   * @param {Array<{value: string, text?: string, selected?: boolean, disabled?: boolean}>} configOptions
   */
  UpdateSelect(element, configOptions) {
    element.innerHTML = '';
    for (const configOption of configOptions) element.appendChild(buildOption(configOption));
  }

  /**
   * Creates a custom single-select dropdown whose trigger reuses .commit-picker-trigger,
   * making it visually identical to the commit picker.
   *
   * The returned element exposes:
   *   .value          — get/set the selected option value
   *   'change' event  — dispatched on every user selection
   *
   * @param {Array<{value:string, text?:string, selected?:boolean, disabled?:boolean}>} configOptions
   * @param {object} _domOptions - reserved, unused (kept for API symmetry with CreateSelect)
   * @returns {HTMLDivElement}
   */
  CreateSimpleDropdown(configOptions, _domOptions) {
    const wrapper = document.createElement('div');
    wrapper.className = 'simple-dropdown';

    let _value = null;

    // ── Trigger (reuses commit-picker-trigger for free visual identity) ──
    const trigger = document.createElement('div');
    trigger.className = 'commit-picker-trigger';
    trigger.tabIndex = 0;
    const label = document.createElement('span');
    label.className = 'simple-dropdown-label';
    trigger.appendChild(label);
    wrapper.appendChild(trigger);

    // ── Panel ────────────────────────────────────────────────────────────
    const panel = document.createElement('div');
    panel.className = 'simple-dropdown-panel hidden';
    wrapper.appendChild(panel);

    function updateLabel() {
      if (!_value) {
        label.textContent = '(—)';
        trigger.classList.add('empty');
        return;
      }
      const match = Array.from(panel.querySelectorAll('.simple-dropdown-option'))
        .find(r => r.dataset.value === _value && !r.classList.contains('is-disabled'));
      if (match) {
        label.textContent = match.textContent;
        trigger.classList.remove('empty');
      } else {
        label.textContent = '(—)';
        trigger.classList.add('empty');
        _value = null;
      }
    }

    function buildPanel(opts) {
      panel.replaceChildren();
      for (const opt of opts) {
        const row = document.createElement('div');
        row.className = 'simple-dropdown-option'
          + (opt.disabled ? ' is-disabled' : '')
          + (opt.value === _value ? ' is-selected' : '');
        row.dataset.value = opt.value;
        row.textContent = opt.text ?? opt.value;
        if (!opt.disabled) row.addEventListener('click', () => selectValue(opt.value));
        panel.appendChild(row);
      }
    }

    function openPanel() {
      const rect = trigger.getBoundingClientRect();
      const w = Math.max(rect.width, 160);
      let left = rect.left;
      if (left + w > window.innerWidth - 8) left = Math.max(8, window.innerWidth - w - 8);
      panel.style.top   = (rect.bottom + 2) + 'px';
      panel.style.left  = left + 'px';
      panel.style.width = w + 'px';
      panel.classList.remove('hidden');
    }

    function closePanel() { panel.classList.add('hidden'); }

    function selectValue(val) {
      _value = val;
      panel.querySelectorAll('.simple-dropdown-option')
        .forEach(r => r.classList.toggle('is-selected', r.dataset.value === val));
      updateLabel();
      closePanel();
      wrapper.dispatchEvent(new Event('change'));
    }

    trigger.addEventListener('click', () =>
      panel.classList.contains('hidden') ? openPanel() : closePanel()
    );
    trigger.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closePanel();
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPanel(); }
    });

    const outsideHandler = (e) => {
      if (!document.contains(wrapper)) { document.removeEventListener('click', outsideHandler, true); return; }
      if (!wrapper.contains(e.target)) closePanel();
    };
    document.addEventListener('click', outsideHandler, true);

    Object.defineProperty(wrapper, 'value', {
      get: () => _value,
      set: (v) => {
        _value = v;
        panel.querySelectorAll('.simple-dropdown-option')
          .forEach(r => r.classList.toggle('is-selected', r.dataset.value === v));
        updateLabel();
      },
    });

    // Exposed for UpdateSimpleDropdown — rebuilds options, preserving current value if still valid.
    wrapper._rebuildOptions = function(opts) {
      const stillValid = _value !== null && opts.some(o => o.value === _value && !(o.disabled ?? false));
      if (!stillValid) {
        const sel = opts.find(o => o.selected);
        _value = sel ? sel.value : null;
      }
      buildPanel(opts);
      updateLabel();
    };

    // Initial population
    const initial = configOptions.find(o => o.selected);
    _value = initial ? initial.value : null;
    buildPanel(configOptions);
    updateLabel();

    return wrapper;
  }

  /**
   * Replaces the options in an existing simple dropdown (from CreateSimpleDropdown).
   * Preserves the current selected value if it still appears in the new options.
   * @param {HTMLDivElement} element
   * @param {Array<{value:string, text?:string, selected?:boolean, disabled?:boolean}>} configOptions
   */
  UpdateSimpleDropdown(element, configOptions) {
    if (typeof element._rebuildOptions === 'function') element._rebuildOptions(configOptions);
  }

  /**
   * Creates a row of action buttons (OK, and optionally Cancel).
   * @param {boolean} cancelSupport - If true, adds a Cancel button
   * @param {object}  options       - { ok: {text, callback, className}, cancel: {callback} }
   * @returns {HTMLDivElement}
   */
  CreateActions(cancelSupport, options) {
    const container = document.createElement('div');
    container.className = 'modal-actions';

    const btOK = document.createElement('button');
    this.#ApplyOptions(btOK, options?.ok);
    btOK.classList.add('modal-button-ok');
    btOK.innerText = options?.ok?.text ?? 'Ok';
    btOK.onclick = options?.ok?.callback ?? null;
    container.appendChild(btOK);

    if (!cancelSupport) {
      return container;
    }

    const btCancel = document.createElement('button');
    this.#ApplyOptions(btCancel, options?.cancel);
    btCancel.classList.add('modal-button-cancel');
    btCancel.innerText = 'Cancel';
    btCancel.onclick = options?.cancel?.callback ?? null;
    container.appendChild(btCancel);

    return container;
  }

  /**
   * Creates four number inputs for Start / End / Delta / Steps time values.
   * Delta and Steps are linked: changing one recalculates the other.
   * Inputs are labelled with IDs like `time_start_<id>`, `time_delta_<id>` for later retrieval.
   * Note: the backend API URL still uses the term "step" — only the UI label changes.
   * @param {number} min    - Initial start value (µs)
   * @param {number} max    - Initial end value (µs)
   * @param {number} delta  - Initial delta value (µs)
   * @param {object} options - #ApplyOptions options for the container
   * @returns {HTMLDivElement}
   */
  CreateTimeSelection(min, max, delta, options) {
    const container = document.createElement('div');
    const id = this.#id;
    this.#ApplyOptions(container, options);

    const initialSteps = delta > 0 ? Math.floor((max - min) / delta) : 0;
    const inputs = {};

    [ { key: 'start', label: 'Start', value: min },
      { key: 'end',   label: 'End',   value: max },
      { key: 'delta', label: 'Delta', value: delta },
      { key: 'steps', label: 'Steps', value: initialSteps },
    ].forEach(function(data) {
      const label = document.createElement('label');
      const span = document.createElement('span');
      span.textContent = data.label;
      const input = document.createElement('input');
      input.type = 'number';
      input.size = 10;
      input.value = data.value;
      input.id = 'time_' + data.key + '_' + id;
      inputs[data.key] = input;
      label.appendChild(span);
      label.appendChild(input);
      container.appendChild(label);
    });

    // Linked recalculation: Delta ↔ Steps
    const recalcSteps = () => {
      const d = +inputs.delta.value;
      if (d > 0) inputs.steps.value = Math.floor((+inputs.end.value - +inputs.start.value) / d);
    };
    const recalcDelta = () => {
      const s = +inputs.steps.value;
      if (s > 0) inputs.delta.value = Math.floor((+inputs.end.value - +inputs.start.value) / s);
    };
    inputs.start.addEventListener('input', recalcSteps);
    inputs.end.addEventListener('input', recalcSteps);
    inputs.delta.addEventListener('input', recalcSteps);
    inputs.steps.addEventListener('input', recalcDelta);

    return container;
  }

  /**
   * Creates a collapsible metric tree with checkboxes.
   * Metrics are grouped by their dot-path parent folder (e.g. 'cpu.usage' → folder 'cpu').
   * @param {{metrics: Map}} metrics       - Nested metric Map from ApiREST.LoadCommitMetrics
   * @param {object}          options
   * @param {object}          options.container  - #ApplyOptions for the outer container
   * @param {number}          [options.maxSelect] - Max simultaneous selections (default: Infinity)
   * @param {Function}        [options.callback]  - Called on each checkbox change event
   * @param {Set<string>}     [options.absent]    - Dot-paths of metrics absent from some experiments (OR mode)
   * @returns {HTMLDivElement}
   */
  CreateMetrics(metrics, options) {
    let currentPath = '';
    const container = document.createElement('div');
    this.#ApplyOptions(container, options?.container);
    let folder = document.createElement('div');

    this.#OrganizeMetrics(metrics).forEach(metric => {
        if (currentPath != metric.parentPath) {
          currentPath = metric.parentPath;
          if (folder.children.length > 0) {
            container.appendChild(folder);
            folder = document.createElement('div');
          }
          folder.id = 'folder_' + currentPath;
          folder.className = 'metric-folder';

          const separator = document.createElement('div');

          const toggle = document.createElement('span');
          toggle.id = 'toggle_' + currentPath;
          toggle.className = 'metrics-toggle';
          toggle.innerText = ICONS.FOLDER_OPEN;
          toggle.dataset.open = 'true';
          separator.appendChild(toggle);

          const label = document.createElement('span');
          label.innerText = currentPath || 'Root';
          separator.appendChild(label);

          // Toggle: show/hide only the UNCHECKED metric rows.
          // Checked (selected) rows are always visible regardless of open/close state.
          const currentFolder = folder;
          separator.onclick = function() {
            const isOpen = toggle.dataset.open === 'true';
            const nowOpen = !isOpen;
            currentFolder.querySelectorAll('.metric-checkbox:not(:checked)').forEach(function(cb) {
              cb.closest('.checkbox-label').style.display = nowOpen ? '' : 'none';
            });
            toggle.innerText = nowOpen ? ICONS.FOLDER_OPEN : ICONS.FOLDER_SHUT;
            toggle.dataset.open = nowOpen ? 'true' : 'false';
          };

          container.appendChild(separator);
        }
        const label = document.createElement('label');
        label.className = 'checkbox-label';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'metric-checkbox';
        cb.value = metric.path;
        const span = document.createElement('span');
        span.textContent = metric.name;
        if (options?.absent?.has(metric.path)) {
          cb.classList.add('metric-absent-cb');
          span.classList.add('metric-absent');
        }
        label.appendChild(cb);
        label.appendChild(span);
        folder.appendChild(label);
    });
    container.appendChild(folder);

    const maxSelect = options?.maxSelect ?? Infinity;
    const checkboxes = container.querySelectorAll('.metric-checkbox');
    checkboxes.forEach(function(cb) {
      cb.onchange = function(event) {
        // When unchecked: hide the row if the folder is currently closed.
        // Checked rows are always kept visible.
        if (!cb.checked) {
          const parentFolder = cb.closest('[id^="folder_"]');
          const toggleEl = parentFolder?.previousElementSibling?.querySelector('.metrics-toggle');
          if (toggleEl && toggleEl.dataset.open !== 'true') {
            cb.closest('.checkbox-label').style.display = 'none';
          }
        }
        if (maxSelect !== Infinity) {
          const checkedCount = container.querySelectorAll('.metric-checkbox:checked').length;
          checkboxes.forEach(function(other) {
            if (!other.checked) other.disabled = checkedCount >= maxSelect;
          });
        }
        options?.callback?.(event);
      };
    });

    return container;
  }

  /**
   * Creates an inline list of commit checkboxes.
   * @param {string[]}  commits         - All available commit hashes
   * @param {Set<string>} selectedCommits - Commits that should be pre-checked
   * @param {object}    options
   * @param {object}    options.container  - #ApplyOptions for the outer container
   * @param {number}    [options.maxSelect] - Max simultaneous selections (default: Infinity)
   * @param {Function}  [options.callback]  - Called on each checkbox change event
   * @returns {HTMLDivElement}
   */
  CreateCommits(commits, selectedCommits, options) {
    const container = document.createElement('div');
    this.#ApplyOptions(container, options?.container);

    commits.forEach(function(commit) {
        const label = document.createElement('label');
        label.className = 'checkbox-label-inline';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'commit-checkbox';
        cb.value = commit;
        cb.checked = selectedCommits.has(commit);
        const span = document.createElement('span');
        span.textContent = commit;
        label.appendChild(cb);
        label.appendChild(span);
        container.appendChild(label);
    });

    const maxSelect = options?.maxSelect ?? Infinity;
    const checkboxes = container.querySelectorAll('.commit-checkbox');
    checkboxes.forEach(cb => {
        cb.onchange = function(event) {
            if (maxSelect !== Infinity) {
                const checkedCount = container.querySelectorAll('.commit-checkbox:checked').length;
                checkboxes.forEach(other => {
                    if (!other.checked) other.disabled = checkedCount >= maxSelect;
                });
            }
            options?.callback?.(event);
        };
    });

    return container;
  }

  /**
   * Creates a searchable commit dropdown with optional git history enrichment.
   * Entries show `[date] hash7 — branch` when gitHistory is available, otherwise `hash7`.
   * Sorted by date descending; commits not found in history appear last.
   * @param {string[]}      commits     - Full commit hashes
   * @param {Promise<object|null>}   gitHistory  - pesto-calc history object with `commits` and `PR` arrays
   * @param {object}        options
   * @param {object}        [options.container] - #ApplyOptions for the outer container
   * @param {number}        [options.maxSelect] - Max simultaneous selections (default: Infinity)
   * @param {Set<string>}   [options.selected]  - Pre-selected commit hashes
   * @param {Function}      [options.callback]  - Called on each checkbox change event
   * @returns {HTMLDivElement}
   */
  CreateCommitDropdown(commits, gitHistory, options) {
    const container = document.createElement('div');
    this.#ApplyOptions(container, options?.container);

    // Search input
    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.placeholder = 'Rechercher un commit…';
    searchInput.className = 'commit-dropdown-search';
    container.appendChild(searchInput);

    // Scrollable list
    const listDiv = document.createElement('div');
    listDiv.className = 'commit-dropdown-list';
    container.appendChild(listDiv);

    // Build rows
    this.UpdateCommitDropdown(container, commits, gitHistory, options);

    // Search filter — query DOM at input time (rows are populated asynchronously)
    searchInput.oninput = () => {
      const q = searchInput.value.toLowerCase();
      listDiv.querySelectorAll('label.checkbox-label-inline').forEach(label => {
        label.style.display = label.textContent.toLowerCase().includes(q) ? '' : 'none';
      });
    };

    return container;
  }

  /**
   * Replaces the options in an existing commit dropdown element.
   * @param {HTMLDivElement} element
   * @param {string[]}      commits
   * @param {Promise<object|null>}   gitHistory
   * @param {object|null}        options
   * @param {Set<string>}   [options.selected]  - Pre-selected commit hashes
   * @param {number}        [options.maxSelect] - Max simultaneous selections (default: Infinity)
   * @param {Function}      [options.callback]  - Called on each checkbox change event
   */
  UpdateCommitDropdown(element, commits, gitHistory, options) {
    gitHistory.then(history => {
      let enrichedCommits = CommitHelp.Enrich(commits, history);

      const maxSelect = options?.maxSelect ?? Infinity;
      const preSelected = options?.selected ?? new Set();

      let divList = element.querySelector('.commit-dropdown-list');

      // Build rows
      const rows = enrichedCommits.map((commit) => {
        const rowLabel = document.createElement('label');
        rowLabel.className = 'checkbox-label-inline';

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'commit-checkbox';
        cb.value = commit.hash;
        cb.checked = preSelected.has(commit.hash);

        const span = document.createElement('span');
        span.textContent = commit.label;

        rowLabel.appendChild(cb);
        rowLabel.appendChild(span);
        return { el: rowLabel, cb, label: commit.label.toLowerCase() };
      });

      divList.replaceChildren(); // remove all elements before adding new ones
      rows.forEach(r => divList.appendChild(r.el));

      // Enforce maxSelect
      const updateDisabled = () => {
        if (maxSelect === Infinity) return;
        const checkedCount = divList.querySelectorAll('.commit-checkbox:checked').length;
        rows.forEach(r => {
          if (!r.cb.checked) {
            r.cb.disabled = checkedCount >= maxSelect;
            checkedCount >= maxSelect ? UI.DisableElement(r.el) : UI.EnableElement(r.el);
          }
        });
      };
      updateDisabled();

      // Checkbox change
      rows.forEach(r => {
        r.cb.onchange = (event) => {
          updateDisabled();
          options?.callback?.(event);
          element.dispatchEvent(new Event('change'));
        };
      });
    })
  }

  /**
   * Creates a rich single-select commit picker:
   * search input + scrollable list (branch badge / date / comment) + filter tabs.
   *
   * The returned element exposes a `.value` property (selected hash, `_var_NAME`, or `''`)
   * and dispatches a native `change` event on each selection.
   *
   * @param {Promise<object|null>}       gitHistoryPromise - resolves to {commits, standalone, PR}
   * @param {string[]|Promise<string[]>} allCommits        - valid commit hashes (or Promise of them)
   * @param {object}                     options
   * @param {string|null}  [options.selected]   - pre-selected value (hash or `_var_NAME`)
   * @param {Map|null}     [options.variables]  - commit variables Map<name,{value,alias}>
   * @param {Function}     [options.callback]   - called with new value on each selection
   * @param {object}       [options.container]  - #ApplyOptions for the outer wrapper
   * @returns {HTMLDivElement}
   */
  CreateCommitPicker(gitHistoryPromise, allCommits, options) {
    const wrapper = document.createElement('div');
    wrapper.className = 'commit-picker';
    this.#ApplyOptions(wrapper, options?.container);

    let _value = options?.selected ?? null;
    let _activeTab = 'all';
    let _rows = [];   // populated asynchronously from gitHistoryPromise
    let _query = '';

    Object.defineProperty(wrapper, 'value', {
      get: () => _value,
      set: (v) => { _value = v; updateTrigger(); },
    });

    // ── Trigger ───────────────────────────────────────────────
    const trigger = document.createElement('div');
    trigger.className = 'commit-picker-trigger';
    trigger.tabIndex = 0;
    wrapper.appendChild(trigger);

    // ── Panel ─────────────────────────────────────────────────
    const panel = document.createElement('div');
    panel.className = 'commit-picker-panel hidden';
    wrapper.appendChild(panel);

    const search = document.createElement('input');
    search.type = 'text';
    search.placeholder = 'Type a hash or pick from the list…';
    search.className = 'commit-picker-search';
    panel.appendChild(search);

    const list = document.createElement('div');
    list.className = 'commit-picker-list';
    panel.appendChild(list);

    // ── Filter tabs ───────────────────────────────────────────
    const tabs = document.createElement('div');
    tabs.className = 'commit-picker-tabs';
    [{ id: 'main', label: 'main/dev' }, { id: 'branch', label: 'branches' }, { id: 'pr', label: 'PRs' }, { id: 'all', label: 'All' }].forEach(def => {
      const btn = document.createElement('button');
      btn.className = 'commit-picker-tab' + (def.id === _activeTab ? ' active' : '');
      btn.textContent = def.label;
      btn.type = 'button';
      btn.dataset.tab = def.id;
      btn.onclick = () => {
        _activeTab = def.id;
        tabs.querySelectorAll('.commit-picker-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === _activeTab));
        renderRows();
      };
      tabs.appendChild(btn);
    });
    panel.appendChild(tabs);

    // ── Event wiring ──────────────────────────────────────────
    trigger.addEventListener('click', () => panel.classList.contains('hidden') ? openPanel() : closePanel());
    trigger.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPanel(); }
      if (e.key === 'Escape') closePanel();
    });
    search.addEventListener('input', () => { _query = search.value.toLowerCase(); renderRows(); });

    // Close on outside click; self-cleans when wrapper leaves the DOM.
    const outsideHandler = (e) => {
      if (!document.contains(wrapper)) {
        document.removeEventListener('click', outsideHandler, true);
        return;
      }
      if (!wrapper.contains(e.target)) closePanel();
    };
    document.addEventListener('click', outsideHandler, true);

    // ── Helpers ───────────────────────────────────────────────
    function openPanel() {
      const rect = trigger.getBoundingClientRect();
      const panelW = Math.max(rect.width, 480);
      let left = rect.left;
      if (left + panelW > window.innerWidth - 8) left = Math.max(8, window.innerWidth - panelW - 8);
      panel.style.top    = (rect.bottom + 4) + 'px';
      panel.style.left   = left + 'px';
      panel.style.width  = panelW + 'px';
      panel.classList.remove('hidden');
      search.value = '';
      _query = '';
      renderRows();
      search.focus();
    }
    function closePanel() { panel.classList.add('hidden'); }

    function updateTrigger() {
      if (!_value) {
        trigger.textContent = '(—)';
        trigger.classList.add('empty');
        return;
      }
      trigger.classList.remove('empty');
      if (_value.startsWith('_var_')) {
        const name = _value.slice(5);
        const entry = options?.variables?.get(name);
        if (entry?.value) {
          trigger.textContent = `${name} = ${CommitHelp.ShortHash(entry.value)}${entry.alias ? ` (${entry.alias})` : ''}`;
        } else {
          trigger.textContent = `${name} (undefined)`;
        }
      } else {
        trigger.textContent = CommitHelp.ShortHash(_value);
      }
    }

    function renderRows() {
      list.replaceChildren();

      // ── Unset + variable rows (always visible, tab-independent) ──
      list.appendChild(buildSimpleRow('', '(—)'));

      if (options?.variables?.size > 0) {
        for (const [name, entry] of options.variables) {
          const val = `_var_${name}`;
          const label = entry?.value
            ? `${name} = ${CommitHelp.ShortHash(entry.value)}${entry.alias ? ` (${entry.alias})` : ''}`
            : `${name} (undefined)`;
          const row = buildSimpleRow(val, label);
          if (_query && !label.toLowerCase().includes(_query)) row.style.display = 'none';
          list.appendChild(row);
        }
      }

      const sep = document.createElement('div');
      sep.className = 'commit-picker-sep';
      list.appendChild(sep);

      // ── Commit rows (filtered by tab + query) ─────────────────
      const visible = _rows.filter(r => {
        if (_activeTab !== 'all' && !r.categories.includes(_activeTab)) return false;
        if (_query) {
          const num = r.number != null ? `#${r.number}` : '';
          const haystack = `${r.hash} ${r.branch ?? ''} ${r.comment ?? ''} ${r.date ?? ''} ${num}`.toLowerCase();
          if (!haystack.includes(_query)) return false;
        }
        return true;
      });

      visible.forEach(r => list.appendChild(buildCommitRow(r)));

      if (visible.length === 0 && _rows.length > 0) {
        const empty = document.createElement('div');
        empty.className = 'commit-picker-empty';
        empty.textContent = 'No commits match';
        list.appendChild(empty);
      } else if (_rows.length === 0) {
        const loading = document.createElement('div');
        loading.className = 'commit-picker-empty';
        loading.textContent = 'Loading commits…';
        list.appendChild(loading);
      }
    }

    function buildSimpleRow(val, label) {
      const row = document.createElement('div');
      row.className = 'commit-picker-row commit-picker-row-simple' + (!val ? ' empty' : '') + (val === _value ? ' selected' : '');
      row.textContent = label;
      row.onclick = () => selectValue(val);
      return row;
    }

    function buildCommitRow(r) {
      const row = document.createElement('div');
      row.className = 'commit-picker-row' + (r.value === _value ? ' selected' : '');
      row.onclick = () => selectValue(r.value);

      const left = document.createElement('div');
      left.className = 'commit-picker-row-left';

      if (r.branch) {
        const badge = document.createElement('span');
        badge.className = 'commit-branch-badge';
        badge.textContent = r.branch;
        badge.style.background = branchColor(r.branch);
        left.appendChild(badge);
      }

      const hashEl = document.createElement('span');
      hashEl.className = 'commit-hash-label';
      hashEl.textContent = CommitHelp.ShortHash(r.value);
      left.appendChild(hashEl);

      if (r.number != null) {
        const prEl = document.createElement('span');
        prEl.className = 'commit-pr-number';
        prEl.textContent = `#${r.number}`;
        left.appendChild(prEl);
      }

      const mid = document.createElement('div');
      mid.className = 'commit-picker-date';
      mid.textContent = r.date ?? '';

      const right = document.createElement('div');
      right.className = 'commit-picker-comment';
      right.textContent = r.comment ?? '';

      row.appendChild(left);
      row.appendChild(mid);
      row.appendChild(right);
      return row;
    }

    function selectValue(val) {
      _value = val;
      updateTrigger();
      closePanel();
      options?.callback?.(val);
      wrapper.dispatchEvent(new Event('change'));
    }

    function branchColor(branch) {
      const b = branch.toLowerCase();
      if (b === 'dev' || b === 'develop') return '#2a9d8f';
      if (b === 'main' || b === 'master') return '#457b9d';
      // Deterministic color from branch name hash
      let h = 0;
      for (let i = 0; i < branch.length; i++) h = (h * 31 + branch.charCodeAt(i)) | 0;
      return BRANCH_PR_PALETTE[Math.abs(h) % BRANCH_PR_PALETTE.length];
    }

    // ── Async population ──────────────────────────────────────
    Promise.all([gitHistoryPromise, Promise.resolve(allCommits)]).then(([history, commits]) => {

      if (!history) {
        _rows = commits.map(hash => ({ value: hash, hash, branch: null, date: null, comment: null, number: null, categories: [] }));
      } else {
        // A local commit can appear in several git categories (e.g. a PR head that
        // is also a branch tip); track all of them so it shows under each tab.
        const entryMap = new Map();  // shortHash -> { branch, date, comment, number, categories:Set }
        const add = (e, cat) => {
          const k = CommitHelp.ShortHash(e.id);
          let m = entryMap.get(k);
          if (!m) { m = { categories: new Set() }; entryMap.set(k, m); }
          m.categories.add(cat);
          m.branch  = m.branch  ?? e.branch  ?? null;
          m.date    = m.date    ?? e.date    ?? null;
          m.comment = m.comment ?? e.comment ?? null;
          if (e.number != null) m.number = e.number;
        };
        (history.commits  ?? []).forEach(e => add(e, 'main'));
        (history.branches ?? []).forEach(e => add(e, 'branch'));
        (history.PR       ?? []).forEach(e => add(e, 'pr'));
        _rows = commits
          .map(hash => {
            const m = entryMap.get(CommitHelp.ShortHash(hash));
            return {
              value: hash, hash,
              branch:  m?.branch  ?? null,
              date:    m?.date    ?? null,
              comment: m?.comment ?? null,
              number:  m?.number  ?? null,
              categories: m ? [...m.categories] : [],
            };
          })
          .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
      }
      if (!panel.classList.contains('hidden')) renderRows();
    }).catch(err => console.error('[CommitPicker] failed to load commits', err));

    updateTrigger();
    return wrapper;
  }

  /**
   * Rich campaign run selector (mirrors the commit picker style).
   * Columns: username, campaign, commit (short), date, subtype (tag).
   * Search bar + sortable column headers + per-column value filters.
   * Each row is one campaign run (one zst).
   *
   * `.value` is a runRef { type:'Campaign', commit, timestamp, user, campaign, subject }
   * or null; dispatches a native `change` event on selection.
   *
   * @param {Array<{type,user,campaign,commit,timestamp,subjects:string[]}>} campaigns
   * @param {object} options
   * @param {object|null} [options.selected] - pre-selected runRef
   * @returns {HTMLDivElement}
   */
  CreateCampaignPicker(campaigns, options) {
    const wrapper = document.createElement('div');
    wrapper.className = 'commit-picker campaign-picker';
    this.#ApplyOptions(wrapper, options?.container);

    let _value   = options?.selected ?? null;
    let _query   = '';
    let _sortKey = 'date';
    let _sortDir = -1;  // -1 desc (newest first), 1 asc
    const _filters = { user: '', campaign: '', subject: '' };

    Object.defineProperty(wrapper, 'value', {
      get: () => _value,
      set: (v) => { _value = v; updateTrigger(); },
    });

    // ── Normalised rows ───────────────────────────────────────
    const fmtDate = (ts) => new Date(Number(ts)).toISOString().slice(0, 16).replace('T', ' ');
    const rows = [...(campaigns ?? [])].map(r => ({
      ref: {
        type: 'Campaign', commit: r.commit, timestamp: r.timestamp,
        user: r.user, campaign: r.campaign,
        subject: (r.subjects && r.subjects[0]) || null,
      },
      user:        r.user ?? '',
      campaign:    r.campaign ?? '',
      commitShort: CommitHelp.ShortHash(r.commit ?? ''),
      date:        fmtDate(r.timestamp),
      subject:     (r.subjects && r.subjects[0]) || '',
      timestamp:   Number(r.timestamp),
    }));
    const distinct = (key) => [...new Set(rows.map(r => r[key]).filter(Boolean))].sort();

    // ── Trigger + panel ───────────────────────────────────────
    const trigger = document.createElement('div');
    trigger.className = 'commit-picker-trigger';
    trigger.tabIndex = 0;
    wrapper.appendChild(trigger);

    const panel = document.createElement('div');
    panel.className = 'commit-picker-panel hidden';
    wrapper.appendChild(panel);

    const search = document.createElement('input');
    search.type = 'text';
    search.placeholder = 'Search user / campaign / commit / subtype…';
    search.className = 'commit-picker-search';
    panel.appendChild(search);

    // Per-column value filters. These are custom in-DOM dropdowns (CreateSimpleDropdown)
    // rather than native <select>s: a native <select>'s OS popup renders outside the panel
    // DOM, so picking an option counted as an outside-click and closed the whole picker.
    const FILTER_ALL = ' all';  // sentinel for the "no filter" row (truthy, can't collide with a real value)
    const filterBar = document.createElement('div');
    filterBar.className = 'campaign-filter-bar';
    const makeFilter = (key, label) => {
      const opts = [{ value: FILTER_ALL, text: `all ${label}`, selected: true }];
      distinct(key).forEach(v => opts.push({ value: v, text: v }));
      const dd = this.CreateSimpleDropdown(opts);
      dd.addEventListener('change', () => {
        _filters[key] = dd.value === FILTER_ALL ? '' : (dd.value ?? '');
        renderRows();
      });
      filterBar.appendChild(dd);
    };
    makeFilter('user', 'users');
    makeFilter('campaign', 'campaigns');
    makeFilter('subject', 'subtypes');
    panel.appendChild(filterBar);

    const table = document.createElement('div');
    table.className = 'campaign-picker-table';
    panel.appendChild(table);

    // ── Wiring ────────────────────────────────────────────────
    trigger.addEventListener('click', () => panel.classList.contains('hidden') ? openPanel() : closePanel());
    trigger.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPanel(); }
      if (e.key === 'Escape') closePanel();
    });
    search.addEventListener('input', () => { _query = search.value.toLowerCase(); renderRows(); });

    // Dismiss when clicking outside the picker. The filter dropdowns are in-DOM
    // descendants of the wrapper, so selecting one never registers as an outside click.
    const outsideHandler = (e) => {
      if (!document.contains(wrapper)) { document.removeEventListener('click', outsideHandler, true); return; }
      if (!wrapper.contains(e.target)) closePanel();
    };
    document.addEventListener('click', outsideHandler, true);

    function openPanel() {
      const rect = trigger.getBoundingClientRect();
      const panelW = Math.max(rect.width, 560);
      let left = rect.left;
      if (left + panelW > window.innerWidth - 8) left = Math.max(8, window.innerWidth - panelW - 8);
      panel.style.top   = (rect.bottom + 4) + 'px';
      panel.style.left  = left + 'px';
      panel.style.width = panelW + 'px';
      panel.classList.remove('hidden');
      search.value = ''; _query = '';
      renderRows();
      search.focus();
    }
    function closePanel() { panel.classList.add('hidden'); }

    // One-line summary of a campaign runRef, including the date so two runs of the
    // same campaign are distinguishable once selected.
    function runSummary(ref) {
      if (!ref) return '(undefined)';
      const date = ref.timestamp != null ? ` (${fmtDate(ref.timestamp)})` : '';
      const subj = ref.subject ? ` · ${ref.subject}` : '';
      return `${ref.user}/${ref.campaign} — ${CommitHelp.ShortHash(ref.commit)}${date}${subj}`;
    }
    const isVarValue = (v) => typeof v === 'string' && v.startsWith('_var_');

    function updateTrigger() {
      if (!_value) { trigger.textContent = '(—)'; trigger.classList.add('empty'); return; }
      trigger.classList.remove('empty');
      if (isVarValue(_value)) {
        const name  = _value.slice(5);
        const entry = options?.variables?.get(name);
        trigger.textContent = entry?.value ? `${name} = ${runSummary(entry.value)}` : `${name} (undefined)`;
      } else {
        trigger.textContent = runSummary(_value);
      }
    }

    const COLS = [
      { key: 'user',        label: 'User' },
      { key: 'campaign',    label: 'Campaign' },
      { key: 'commitShort', label: 'Commit' },
      { key: 'date',        label: 'Date', sortKey: 'timestamp' },
      { key: 'subject',     label: 'Subtype' },
    ];

    function renderRows() {
      table.replaceChildren();

      // Header (sortable).
      const header = document.createElement('div');
      header.className = 'campaign-picker-row campaign-picker-header';
      COLS.forEach(col => {
        const cell = document.createElement('div');
        cell.className = `campaign-cell campaign-cell-${col.key}`;
        const sk = col.sortKey ?? col.key;
        cell.textContent = col.label + (_sortKey === sk ? (_sortDir === 1 ? ' ▲' : ' ▼') : '');
        cell.onclick = () => {
          if (_sortKey === sk) { _sortDir = -_sortDir; } else { _sortKey = sk; _sortDir = 1; }
          renderRows();
        };
        header.appendChild(cell);
      });
      table.appendChild(header);

      // Unset row.
      const unset = document.createElement('div');
      unset.className = 'campaign-picker-row campaign-picker-unset' + (_value ? '' : ' selected');
      unset.textContent = '(—)';
      unset.onclick = () => selectRef(null);
      table.appendChild(unset);

      // Campaign-variable rows (single selector — like the commit picker's variable rows).
      if (options?.variables?.size > 0) {
        for (const [name, entry] of options.variables) {
          const val   = `_var_${name}`;
          const label = `${name} = ${entry?.value ? runSummary(entry.value) : '(undefined)'}`;
          if (_query && !label.toLowerCase().includes(_query)) continue;
          const vrow = document.createElement('div');
          vrow.className = 'campaign-picker-row campaign-picker-var' + (_value === val ? ' selected' : '');
          vrow.textContent = label;
          vrow.onclick = () => selectRef(val);
          table.appendChild(vrow);
        }
      }

      // Filter + search.
      let visible = rows.filter(r => {
        if (_filters.user && r.user !== _filters.user) return false;
        if (_filters.campaign && r.campaign !== _filters.campaign) return false;
        if (_filters.subject && r.subject !== _filters.subject) return false;
        if (_query) {
          const hay = `${r.user} ${r.campaign} ${r.commitShort} ${r.date} ${r.subject}`.toLowerCase();
          if (!hay.includes(_query)) return false;
        }
        return true;
      });

      // Sort.
      visible.sort((a, b) => {
        const va = a[_sortKey], vb = b[_sortKey];
        const cmp = (typeof va === 'number' && typeof vb === 'number')
          ? va - vb : String(va).localeCompare(String(vb));
        return cmp * _sortDir;
      });

      visible.forEach(r => {
        const row = document.createElement('div');
        const isSel = _value && typeof _value === 'object' && _value.timestamp === r.timestamp;
        row.className = 'campaign-picker-row' + (isSel ? ' selected' : '');
        row.onclick = () => selectRef(r.ref);
        COLS.forEach(col => {
          const cell = document.createElement('div');
          cell.className = `campaign-cell campaign-cell-${col.key}`;
          if (col.key === 'subject') {
            const tag = document.createElement('span');
            tag.className = 'campaign-subtype-tag';
            tag.textContent = r.subject;
            cell.appendChild(tag);
          } else {
            cell.textContent = r[col.key];
          }
          row.appendChild(cell);
        });
        table.appendChild(row);
      });

      if (visible.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'commit-picker-empty';
        empty.textContent = rows.length === 0 ? 'No campaign runs' : 'No runs match';
        table.appendChild(empty);
      }
    }

    function selectRef(ref) {
      _value = ref;
      updateTrigger();
      closePanel();
      options?.callback?.(ref);
      wrapper.dispatchEvent(new Event('change'));
    }

    updateTrigger();
    return wrapper;
  }

  /**
   * Creates a file list container, optionally pre-populated.
   * If files is null, shows a spinner until UpdateListFiles is called.
   * @param {string[]|null} files   - File names, or null to show loading spinner
   * @param {object}        options
   * @param {object}        options.container - #ApplyOptions for the outer container
   * @param {Function}      [options.callback] - onclick handler for each file button
   * @returns {HTMLDivElement}
   */
  CreateListFiles(files, options) {
    const container = document.createElement('div');
    container.__callback = options?.callback;
    this.#ApplyOptions(container, options?.container);
    if (files != null) {
      this.UpdateListFiles(container, files);
      return container;
    }

    const waitSpan = document.createElement('span');
    waitSpan.innerText = ICONS.CLOCK;
    waitSpan.className = 'modal-wait';
    container.append(waitSpan);

    return container;
  }

  /**
   * Replaces the contents of a file list container with new file buttons.
   * @param {HTMLDivElement} container - Container from CreateListFiles
   * @param {string[]}       files     - Updated file names
   */
  UpdateListFiles(container, files) {
    container.innerHTML = '';
    files.forEach(function(file) {
      const button = document.createElement('button');
      button.innerText = file;
      button.className = 'checkbox-label-inline';
      button.onclick = container.__callback;
      container.appendChild(button);
    });
  }

  /**
   * Visually disables an element by blocking pointer events and reducing opacity.
   * @param {HTMLElement} element
   */
  static DisableElement(element) {
    element.style.pointerEvents = 'none';
    element.classList.add('is-disabled');
  }

  /**
   * Re-enables an element disabled with DisableElement.
   * @param {HTMLElement} element
   */
  static EnableElement(element) {
    element.style.pointerEvents = '';
    element.classList.remove('is-disabled');
  }

  /**
   * Creates a styled header toolbar button.
   * @param {string} label - Button text
   * @param {string} title - Tooltip text
   * @returns {HTMLButtonElement}
   */
  static CreateToolbarBtn(label, title) {
    const btn = document.createElement('button');
    btn.className = 'header-toolbar-btn';
    btn.textContent = label;
    btn.title = title;
    return btn;
  }

  #ApplyOptions(element, options) {
    element.id = options?.id ?? 'ui_' + this.#id;
    element.className = options?.className ?? ('modal-' + element.tagName.toLowerCase());
    this.#id++;
  }

  /**
   * Flattens the nested metric Map into an ordered array of leaf entries.
   *
   * Algorithm — two-stack DFS:
   *   - `stack`     holds folder nodes yet to be expanded (non-empty Maps)
   *   - `stackLeaf` holds leaf nodes ready to emit (empty Maps = actual metrics)
   *
   * At each step: if stackLeaf is non-empty, pop and emit a leaf; otherwise pop
   * a folder, push its children onto the appropriate stack (folders → stack,
   * leaves → stackLeaf). This interleaves folders and their leaves so the
   * rendered tree groups leaves under their immediate parent before moving on.
   *
   * @param {{metrics: Map}} metrics - Nested metric Map from ApiREST.LoadCommitMetrics
   * @returns {Array<{name: string, path: string, parentPath: string}>}
   */
  #OrganizeMetrics(metrics) {
    const results = [];
    const stack = [];
    const stackLeaf = [];
    metrics.metrics.forEach((metric, path) => {
        if (metric.size > 0) {
          stack.push({metric, path, parentPath: ''})
        } else {
          stackLeaf.push({name:path, path, parentPath: ''})
        }
    });
    while((stack.length + stackLeaf.length) > 0) {
      if (stackLeaf.length > 0) {
        results.push(stackLeaf.shift());
      } else {
        const metric = stack.pop();
        const currentPath = metric.path;
        metric.metric.forEach((metric, path) => {
            if (metric.size > 0) {
              stack.push({metric, path:`${currentPath}.${path}`, parentPath: currentPath})
            } else {
              stackLeaf.push({name:path, path:`${currentPath}.${path}`, parentPath: currentPath})
            }
        });
      }
    }
    return results;
  }

}

export { UI };