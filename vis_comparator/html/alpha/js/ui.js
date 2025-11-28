class UI {
  #id;

  constructor() {
    this.Reset();
  }

  Reset() {
    this.#id = 0;
  }

  ID() {
    return this.#id;
  }

  CreateTitle(text, level, options) {
    const title = document.createElement(level);
    this.#ApplyOptions(title, options);
    title.innerText = text;
    return title;
  }

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

  CreateActions(cancelSupport, options) {
    const container = document.createElement('div');

    const btOK = document.createElement('button');
    this.#ApplyOptions(btOK, options?.ok);
    btOK.innerText = options?.ok?.text ?? 'Ok';
    btOK.onclick = options?.ok?.callback ?? null;
    container.appendChild(btOK);

    if (!cancelSupport) {
      return container;
    }

    const btCancel = document.createElement('button');
    this.#ApplyOptions(btCancel, options?.cancel);
    btCancel.innerText = 'Cancel';
    btCancel.onclick = options?.cancel?.callback ?? null;
    container.appendChild(btCancel);

    return container;
  }

  CreateTimeSelection(min, max, step, options) {
    const container = document.createElement('div');
    const id = this.#id;
    this.#ApplyOptions(container, options);

    [ { label:'Start', value: min },  
      { label:'End', value: max }, 
      { label:'Step', value: step } ].forEach(function(data) {
        const label = document.createElement('label');
        label.innerHTML = `
            <span>${data.label}</span>
            <input type="text" size="10" class="" value="${data.value}" id="time_${data.label.toLocaleLowerCase()}_${id}">
        `;
        container.appendChild(label);
    });
    return container;
  }

  CreateMetrics(metrics, options) {
    let currentPath = '';
    const container = document.createElement('div');
    this.#ApplyOptions(container, options?.container);
    let folder = document.createElement('div');
    folder.style.display = 'none';
    this.#OrganizeMetrics(metrics).forEach(metric => {
        if (currentPath != metric.parentPath) {
          currentPath = metric.parentPath;
          if (folder.children.length > 0) {
            container.appendChild(folder);
            folder = document.createElement('div');
            folder.style.display = 'none';
          }
          folder.id = 'folder_'+currentPath;

          const separator = document.createElement('div');
          
          const toggle = document.createElement('span');
          toggle.id = 'toggle_'+currentPath;
          toggle.className = 'metrics_toggle';
          toggle.innerText = '➕';
          toggle.dataset.open = 'false';
          separator.appendChild(toggle);
    
          const label = document.createElement('span');
          label.innerText = currentPath || 'Root';
          separator.appendChild(label);

          const currentFolder = folder;
          separator.onclick = function(event) {
              const isOpen = toggle.dataset.open === 'true';
              currentFolder.style.display = isOpen ? 'none' : 'block';
              toggle.innerText = isOpen ? '➕' : '➖';
              toggle.dataset.open = isOpen ? 'false' : 'true';
          };

          container.appendChild(separator);
        }
        const label = document.createElement('label');
        label.className = 'checkbox-label';
        label.innerHTML = `
            <input type="checkbox" class="metric-checkbox" value="${metric.path}">
            <span>${metric.name}</span>
        `;
        folder.appendChild(label);
    });
    container.appendChild(folder);

    const checkboxes = container.querySelectorAll('.metric-checkbox');
    checkboxes.forEach(cb => {
        cb.onchange = options.callback;
    });

    return container;
  }

  CreateCommits(commits, selectedCommits, options) {
    const container = document.createElement('div');
    this.#ApplyOptions(container, options?.container);

    commits.forEach(function(commit) {
        const checked = selectedCommits.has(commit) ? "checked" : "";
        const label = document.createElement('label');
        label.className = 'checkbox-label-inline';
        label.innerHTML = `
            <input type="checkbox" class="commit-checkbox" value="${commit}" ${checked}>
            <span>${commit}</span>
        `;
        container.appendChild(label);
    });

    const checkboxes = container.querySelectorAll('.commit-checkbox');
    checkboxes.forEach(cb => {
        cb.onchange = options.callback;
    });

    return container;
  }

  CreateListFiles(files, options) {
    const container = document.createElement('div');
    container.__callback = options?.callback;
    this.#ApplyOptions(container, options?.container);
    if (files != null) {
      this.UpdateListFiles(container, files);
      return container;
    }

    const waitSpan = document.createElement('span');
    waitSpan.innerText = '🕛';
    waitSpan.className = 'modal_wait';
    container.append(waitSpan);

    return container;
  }

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

  static DisableElement(element) {
    element.style.pointerEvents = 'none';
  }

  static EnableElement(element) {
    element.style.pointerEvents = '';
  }

  #ApplyOptions(element, options) {
    element.id = options?.id ?? 'ui_' + this.#id;
    element.className = options?.className ?? ('modal_' + element.tagName.toLowerCase());
    this.#id++;
  }

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