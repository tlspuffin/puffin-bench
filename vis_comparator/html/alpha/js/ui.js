import {CommitHelp} from "./commithelp.js";
import { ICONS } from './constants.js';

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
    for (const configOption of configOptions) {
      const option = document.createElement('option');
      option.value = configOption.value;
      option.defaultSelected = configOption?.selected ?? false;
      option.innerText = configOption?.text ?? configOption.value;
      option.disabled = configOption?.disabled ?? false;
      select.appendChild(option);
    }
    return select;
  }

  /**
   * Replaces the options in an existing <select> element.
   * @param {HTMLSelectElement} element
   * @param {Array<{value: string, text?: string, selected?: boolean, disabled?: boolean}>} configOptions
   */
  UpdateSelect(element, configOptions) {
    element.innerHTML = '';
    for (let configOption of configOptions) {
      const option = document.createElement('option');
      option.value = configOption.value;
      option.defaultSelected = configOption?.selected ?? false;
      option.innerText = configOption?.text ?? configOption.value;
      option.disabled = configOption?.disabled ?? false;
      element.appendChild(option);
    }
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
          toggle.innerText = ICONS.FOLDER_SHUT;
          toggle.dataset.open = 'false';
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
        // Unchecked metrics start hidden (folder is closed by default).
        // They become visible when the folder is opened, or when the metric is selected.
        label.style.display = 'none';
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
        results.push(stackLeaf.pop());
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