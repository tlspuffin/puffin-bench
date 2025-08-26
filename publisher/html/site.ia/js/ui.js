const UI = {
  /**
  * Show a toast notification
  * @param {string} message - Message to display
  * @param {string} type - Type of toast (success, error, warning, info)
  * @param {string} title - Optional title
  */
  ShowToast(message, type = 'info', title = '') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    const icons = {
      success: '✅',
      error: '❌',
      warning: '⚠️',
      info: 'ℹ️'
    };
    
    toast.innerHTML = `
            <span class="toast-icon">${icons[type]}</span>
            <div class="toast-content">
                ${title ? `<div class="toast-title">${title}</div>` : ''}
                <div class="toast-message">${message}</div>
            </div>
            <button class="toast-close">&times;</button>
        `;
    
    container.appendChild(toast);
    
    // Auto-remove after duration
    setTimeout(() => {
      toast.style.animation = 'slideOut 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, Config.MAX_TOAST_DURATION);
    
    // Manual close
    toast.querySelector('.toast-close').addEventListener('click', () => {
      toast.remove();
    });
  },
  
  /**
  * Switch between tabs
  * @param {string} tabName - Name of the tab to activate
  */
  SwitchTab(tabName) {
    // Update tab buttons
    document.querySelectorAll('.tab-button').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });
    
    // Update tab panels
    document.querySelectorAll('.tab-panel').forEach(panel => {
      panel.classList.toggle('active', panel.id === tabName);
    });
  },
  
  /**
  * Update file input labels
  * @param {HTMLInputElement} input - File input element
  */
  UpdateFileLabel(input) {
    const label = input.nextElementSibling;
    const textElement = label.querySelector('.file-text');
    const files = Array.from(input.files);
    
    if (files.length === 0) {
      textElement.textContent = label.dataset.defaultText || 'Select a file...';
    } else if (files.length === 1) {
      textElement.textContent = files[0].name;
    } else {
      textElement.textContent = `${files.length} files selected`;
    }
    
    // Update selected files display for multiple files
    if (input.multiple && input.id === 'additional-files') {
      this.DisplaySelectedFiles(files);
    }
  },
  
  /**
  * Display selected files as tags
  * @param {Array} files - Array of File objects
  */
  DisplaySelectedFiles(files) {
    const container = document.getElementById('selected-files');
    container.innerHTML = '';
    
    files.forEach((file, index) => {
      const tag = document.createElement('div');
      tag.className = 'file-tag';
      tag.innerHTML = `
                📎 ${file.name}
                <button type="button" data-index="${index}">&times;</button>
            `;
      
      tag.querySelector('button').addEventListener('click', (e) => {
        this.RemoveFile(e.target.dataset.index);
      });
      
      container.appendChild(tag);
    });
  },
  
  /**
  * Remove a file from the input
  * @param {number} index - Index of file to remove
  */
  RemoveFile(index) {
    const input = document.getElementById('additional-files');
    const dt = new DataTransfer();
    const files = Array.from(input.files);
    
    files.forEach((file, i) => {
      if (i !== parseInt(index)) {
        dt.items.add(file);
      }
    });
    
    input.files = dt.files;
    this.UpdateFileLabel(input);
  },
  
  /**
  * Create a task card element
  * @param {Object} task - Task data
  * @returns {HTMLElement} Task card element
  */
  CreateTaskCard(task) {
    const card = document.createElement('div');
    card.className = 'task-card';
    card.dataset.taskId = task.id;
    
    const statusClass = task.status.toLowerCase().replace(' ', '-');
    const statusIcon = Config.STATUS_ICONS[task.status] || '❓';
    const statusLabel = Config.STATUS_LABELS[task.status] || task.status;
    
    const progress = task.totalSteps > 0 
    ? Math.round((task.completedSteps / task.totalSteps) * 100)
    : 0;
    
    card.innerHTML = `
            <div class="task-card-header">
                <span class="task-id">${task.id}</span>
                <span class="task-status ${statusClass}">${statusIcon} ${statusLabel}</span>
            </div>
            <div class="task-name">${task.name}</div>
            <div class="task-meta">
                ${task.startTime ? `
                    <div class="task-meta-item">
                        🕐 Démarré: ${this.FormatDate(task.startTime)}
                    </div>
                ` : ''}
                ${task.currentStep ? `
                    <div class="task-meta-item">
                        📍 Étape: ${task.currentStep}
                    </div>
                ` : ''}
            </div>
            ${task.status === 'Running' && task.totalSteps > 0 ? `
                <div class="task-progress">
                    <div class="progress-label">
                        <span>Progression</span>
                        <span>${task.completedSteps}/${task.totalSteps}</span>
                    </div>
                    <div class="progress-bar">
                        <div class="progress-fill" style="width: ${progress}%"></div>
                    </div>
                </div>
            ` : ''}
            <div class="task-actions">
                <button class="btn btn-small" onclick="UI.ShowTaskDetails('${task.id}')">
                    👁️ Détails
                </button>
                ${task.status === 'Running' ? `
                    <button class="btn btn-small" onclick="UI.ShowTaskLogs('${task.id}')">
                        📄 Logs
                    </button>
                ` : ''}
            </div>
        `;
    
    return card;
  },
  
  /**
  * Create a task list item element
  * @param {Object} task - Task data
  * @returns {HTMLElement} Task list item element
  */
  CreateTaskListItem(task) {
    const item = document.createElement('div');
    item.className = 'task-list-item';
    item.dataset.taskId = task.id;
    
    const statusClass = task.status.toLowerCase().replace(' ', '-');
    const statusIcon = Config.STATUS_ICONS[task.status] || '❓';
    const statusLabel = Config.STATUS_LABELS[task.status] || task.status;
    
    item.innerHTML = `
            <div class="task-list-info">
                <span class="task-status ${statusClass}">${statusIcon} ${statusLabel}</span>
                <div class="task-list-details">
                    <div class="task-name">${task.name}</div>
                    <div class="task-meta">
                        <span class="task-id">${task.id}</span>
                        ${task.endTime ? ` • Finished: ${this.FormatDate(task.endTime)}` : ''}
                    </div>
                </div>
            </div>
            <div class="task-list-actions">
                <button class="btn btn-small" onclick="UI.ShowTaskDetails('${task.id}')">
                    👁️ Details
                </button>
            </div>
        `;
    
    return item;
  },
  
  /**
  * Show task details in modal
  * @param {string} taskId - Task ID
  */
  async ShowTaskDetails(taskId) {
    const modal = document.getElementById('task-modal');
    const modalTitle = document.getElementById('modal-title');
    const modalBody = document.getElementById('modal-body');
    
    modalTitle.textContent = `Task ${taskId}`;
    modalBody.innerHTML = '<div class="spinner"></div> Chargement...';
    modal.classList.add('active');
    
    try {
      // Get task details from current status
      const statusData = await API.GetRunningTasks();
      const tasks = API.parseStatusData(statusData);
      const task = tasks.all.find(t => t.id === taskId);
      
      if (!task) {
        throw new Error('Task not found');
      }
      
      modalBody.innerHTML = `
                <div class="detail-group">
                    <div class="detail-label">Name</div>
                    <div class="detail-value">${task.name}</div>
                </div>
                <div class="detail-group">
                    <div class="detail-label">Status</div>
                    <div class="detail-value">
                        ${Config.STATUS_ICONS[task.status]} ${Config.STATUS_LABELS[task.status] || task.status}
                    </div>
                </div>
                <div class="detail-group">
                    <div class="detail-label">ID</div>
                    <div class="detail-value code-block">${task.id}</div>
                </div>
                ${task.startTime ? `
                    <div class="detail-group">
                        <div class="detail-label">Start time</div>
                        <div class="detail-value">${this.FormatDate(task.startTime)}</div>
                    </div>
                ` : ''}
                ${task.endTime ? `
                    <div class="detail-group">
                        <div class="detail-label">End time</div>
                        <div class="detail-value">${this.FormatDate(task.endTime)}</div>
                    </div>
                ` : ''}
                ${task.steps && task.steps.length > 0 ? `
                    <div class="detail-group">
                        <div class="detail-label">Steps</div>
                        <div class="detail-value">
                            ${task.steps.map(step => `
                                <div style="margin: 4px 0;">
                                    ${Config.STATUS_ICONS[step.state] || '•'} 
                                    ${step.name} - ${Config.STATUS_LABELS[step.state] || step.state}
                                </div>
                            `).join('')}
                        </div>
                    </div>
                ` : ''}
            `;
    } catch (error) {
      modalBody.innerHTML = `
                <div class="error-message">
                    ❌ Error loading details: ${error.message}
                </div>
            `;
    }
  },
  
  /**
  * Show task logs in modal
  * @param {string} taskId - Task ID
  */
  async ShowTaskLogs(taskId) {
    const modal = document.getElementById('task-modal');
    const modalTitle = document.getElementById('modal-title');
    const modalBody = document.getElementById('modal-body');
    
    modalTitle.textContent = `Logs - Task ${taskId}`;
    modalBody.innerHTML = '<div class="spinner"></div> Loading logs...';
    modal.classList.add('active');
    
    try {
      // Get running steps for this task
      const statusData = await API.GetRunningTasks();
      const runningSteps = statusData.running_steps || [];
      
      // Filter steps for this task
      const taskSteps = runningSteps.filter(step => step.task && step.task.id === taskId);
      
      if (taskSteps.length === 0) {
        modalBody.innerHTML = `
                    <div class="empty-state">
                        <p>No active steps for this task</p>
                    </div>
                `;
        return;
      }
      
      // Create logs container
      modalBody.innerHTML = '';
      
      for (const step of taskSteps) {
        const stepContainer = document.createElement('div');
        stepContainer.className = 'log-step-container';
        stepContainer.innerHTML = `
                    <div class="detail-group">
                        <div class="detail-label">Step: ${step.name}</div>
                        <div class="detail-value">
                            State: ${Config.STATUS_LABELS[step.state] || step.state} | 
                            PID: ${step.executor_data?.pid || 'n/a'} | 
                            CPU: ${step.executor_data?.cores?.join(', ') || 'n/a'}
                        </div>
                    </div>
                    
                    <details open class="log-section">
                        <summary>🟢 stdout</summary>
                        <pre class="log-output" id="stdout-${step.uuid}">(chargement...)</pre>
                    </details>
                    
                    <details open class="log-section">
                        <summary>🔴 stderr</summary>
                        <pre class="log-output error" id="stderr-${step.uuid}">(chargement...)</pre>
                    </details>
                `;
        modalBody.appendChild(stepContainer);
        
        // Start streaming logs for this step
        Tasks.streamStepLogs(step, `stdout-${step.uuid}`, `stderr-${step.uuid}`);
      }
      
    } catch (error) {
      modalBody.innerHTML = `
                <div class="error-message">
                    ❌ Error loading logs: ${error.message}
                </div>
            `;
    }
  },
  
  /**
  * Format date for display
  * @param {string|number} date - Date to format
  * @returns {string} Formatted date
  */
  FormatDate(date) {
    if (!date) return '';
    const d = new Date(date);
    return d.toLocaleString(Config.DATE_FORMAT.locale, Config.DATE_FORMAT.options);
  },
  
  /**
  * Update badges with task counts
  * @param {Object} counts - Task counts by status
  */
  UpdateBadges(counts) {
    document.getElementById('running-count').textContent = counts.running || 0;
    document.getElementById('completed-count').textContent = counts.completed || 0;
  }
};
