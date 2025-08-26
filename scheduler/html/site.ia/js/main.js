document.addEventListener('DOMContentLoaded', () => {
  
  Init();
  
  function Init() {
    SetupEventListeners();
    
    Tasks.init();
    
    SetupFileInputs();
    
    CheckAPIConnection();
  }
  
  /**
  * Setup all event listeners
  */
  function SetupEventListeners() {
    // Tab switching
    document.querySelectorAll('.tab-button').forEach(button => {
      button.addEventListener('click', (e) => {
        const tabName = e.currentTarget.dataset.tab;
        UI.SwitchTab(tabName);
      });
    });
    
    // Form submission
    const form = document.getElementById('new-task-form');
    if (form) {
      form.addEventListener('submit', HandleFormSubmit);
    }
    
    // Refresh buttons
    const refreshRunning = document.getElementById('refresh-running');
    if (refreshRunning) {
      refreshRunning.addEventListener('click', () => Tasks.refreshRunning());
    }
    
    const refreshCompleted = document.getElementById('refresh-completed');
    if (refreshCompleted) {
      refreshCompleted.addEventListener('click', () => Tasks.refreshCompleted());
    }
    
    // Filter change
    const filterSelect = document.getElementById('filter-status');
    if (filterSelect) {
      filterSelect.addEventListener('change', () => Tasks.loadCompletedTasks());
    }
    
    // Modal close
    const modalClose = document.querySelector('.modal-close');
    if (modalClose) {
      modalClose.addEventListener('click', CloseModal);
    }
    
    // Click outside modal to close
    const modal = document.getElementById('task-modal');
    if (modal) {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) {
          CloseModal();
        }
      });
    }
    
    // Git commit selector
    const gitCommitSelect = document.getElementById('git-commit');
    const gitCommitManual = document.getElementById('git-commit-manual');
    
    if (gitCommitSelect && gitCommitManual) {
      // When selecting from dropdown, clear manual input
      gitCommitSelect.addEventListener('change', () => {
        if (gitCommitSelect.value) {
          gitCommitManual.value = '';
        }
      });
      
      // When typing manually, reset dropdown
      gitCommitManual.addEventListener('input', () => {
        if (gitCommitManual.value) {
          gitCommitSelect.value = '';
        }
      });
    }
    
    // Refresh commits button (placeholder for future implementation)
    const refreshCommits = document.getElementById('refresh-commits');
    if (refreshCommits) {
      refreshCommits.addEventListener('click', () => {
        UI.ShowToast('Git feature under development', 'info');
      });
    }
  }
  
  /**
  * Setup file input labels
  */
  function SetupFileInputs() {
    // Store default text for file labels
    document.querySelectorAll('.file-label').forEach(label => {
      const text = label.querySelector('.file-text');
      if (text) {
        label.dataset.defaultText = text.textContent;
      }
    });
    
    // Setup file input change listeners
    document.querySelectorAll('input[type="file"]').forEach(input => {
      input.addEventListener('change', (e) => {
        UI.UpdateFileLabel(e.target);
      });
    });
  }
  
  /**
  * Handle form submission
  * @param {Event} e - Submit event
  */
  async function HandleFormSubmit(e) {
    e.preventDefault();
    
    const form = e.target;
    const formData = new FormData();
    
    // Get task name
    const taskName = form.querySelector('#task-name').value;
    formData.append('name', taskName);
    
    // Get git commit (from select or manual input)
    const gitCommitSelect = form.querySelector('#git-commit');
    const gitCommitManual = form.querySelector('#git-commit-manual');
    const gitCommit = gitCommitManual.value || gitCommitSelect.value || 'main';
    
    // Add commit to args
    formData.append('args[git_commit]', gitCommit);
    
    // Get config file
    const configFile = form.querySelector('#config-file').files[0];
    if (configFile) {
      formData.append('config', configFile);
    } else {
      UI.ShowToast('Veuillez sélectionner un fichier de configuration', 'error');
      return;
    }
    
    // Get script file
    const scriptFile = form.querySelector('#script-file').files[0];
    if (scriptFile) {
      formData.append('script', scriptFile);
    } else {
      UI.ShowToast('Veuillez sélectionner un fichier de script', 'error');
      return;
    }
    
    // Get additional files
    const additionalFiles = form.querySelector('#additional-files').files;
    if (additionalFiles.length > 0) {
      Array.from(additionalFiles).forEach(file => {
        formData.append('files[]', file);
      });
    }
    
    // Validate file sizes
    let totalSize = configFile.size + scriptFile.size;
    Array.from(additionalFiles).forEach(file => {
      totalSize += file.size;
    });
    
    if (totalSize > Config.MAX_FILE_SIZE * 10) {
      UI.ShowToast(
        'La taille totale des fichiers dépasse la limite autorisée',
        'error'
      );
      return;
    }
    
    // Submit the task
    await Tasks.submitNewTask(formData);
  }
  
  /**
  * Close the modal
  */
  function CloseModal() {
    const modal = document.getElementById('task-modal');
    if (modal) {
      modal.classList.remove('active');
    }
  }
  
  /**
  * Check API connection
  */
  async function CheckAPIConnection() {
    const statusDot = document.querySelector('.status-dot');
    const statusText = document.getElementById('connection-status');
    
    try {
      // Try to fetch tasks to check connection
      await API.GetRunningTasks();
      
      statusDot.style.background = 'var(--success-color)';
      statusText.textContent = 'Connected';
      
    } catch (error) {
      statusDot.style.background = 'var(--error-color)';
      statusText.textContent = 'Disconnected';
      
      UI.ShowToast(
        'Unable to connect to the server. Ensure the server is running.',
        'error',
        'Connection error'
      );
    }
  }
  
  /**
  * Global error handler
  */
  window.addEventListener('error', (e) => {
    console.error('Global error:', e);
    UI.ShowToast(
      'An unexpected error occurred',
      'error'
    );
  });
  
  /**
  * Handle visibility change (pause polling when tab is hidden)
  */
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      // Pause polling when page is hidden
      Tasks.stopPolling();
    } else {
      // Resume polling when page is visible
      Tasks.startPolling();
      Tasks.loadTasks();
    }
  });
  
});
