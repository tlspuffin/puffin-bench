const Tasks = {
  // Polling intervals
  runningInterval: null,
  completedInterval: null,
  
  // Current tasks data
  currentTasks: {
    running: [],
    completed: [],
    failed: []
  },
  
  /**
  * Initialize tasks module
  */
  init() {
    this.startPolling();
    this.loadTasks();
  },
  
  /**
  * Start polling for task updates
  */
  startPolling() {
    // Poll running tasks frequently
    this.runningInterval = setInterval(() => {
      if (document.querySelector('.tab-panel#running.active')) {
        this.loadRunningTasks();
      }
    }, Config.POLL_INTERVAL_RUNNING);
    
    // Poll completed tasks less frequently
    this.completedInterval = setInterval(() => {
      if (document.querySelector('.tab-panel#completed.active')) {
        this.loadCompletedTasks();
      }
    }, Config.POLL_INTERVAL_COMPLETED);
  },
  
  /**
  * Stop polling
  */
  stopPolling() {
    if (this.runningInterval) {
      clearInterval(this.runningInterval);
      this.runningInterval = null;
    }
    if (this.completedInterval) {
      clearInterval(this.completedInterval);
      this.completedInterval = null;
    }
  },
  
  /**
  * Load all tasks
  */
  async loadTasks() {
    try {
      const statusData = await API.getRunningTasks();
      const tasks = API.parseStatusData(statusData);
      
      this.currentTasks = tasks;
      
      // Update UI
      this.displayRunningTasks(tasks.running);
      this.displayCompletedTasks([...tasks.completed, ...tasks.failed]);
      
      // Update badges
      UI.UpdateBadges({
        running: tasks.running.length,
        completed: tasks.completed.length + tasks.failed.length
      });
      
    } catch (error) {
      console.error('Error loading tasks:', error);
      UI.ShowToast('Error loading tasks', 'error');
    }
  },
  
  /**
  * Load only running tasks
  */
  async loadRunningTasks() {
    try {
      const statusData = await API.getRunningTasks();
      const tasks = API.parseStatusData(statusData);
      
      this.currentTasks.running = tasks.running;
      this.displayRunningTasks(tasks.running);
      
      // Update badge
      document.getElementById('running-count').textContent = tasks.running.length;
      
    } catch (error) {
      console.error('Error loading running tasks:', error);
    }
  },
  
  /**
  * Load only completed tasks
  */
  async loadCompletedTasks() {
    try {
      const statusData = await API.getRunningTasks();
      const tasks = API.parseStatusData(statusData);
      
      this.currentTasks.completed = tasks.completed;
      this.currentTasks.failed = tasks.failed;
      
      this.displayCompletedTasks([...tasks.completed, ...tasks.failed]);
      
      // Update badge
      document.getElementById('completed-count').textContent = 
      tasks.completed.length + tasks.failed.length;
      
    } catch (error) {
      console.error('Error loading completed tasks:', error);
    }
  },
  
  /**
  * Display running tasks
  * @param {Array} tasks - Array of running tasks
  */
  displayRunningTasks(tasks) {
    const container = document.getElementById('running-tasks');
    const emptyState = document.getElementById('no-running-tasks');
    
    if (tasks.length === 0) {
      container.innerHTML = '';
      emptyState.style.display = 'block';
    } else {
      emptyState.style.display = 'none';
      container.innerHTML = '';
      
      tasks.forEach(task => {
        const card = UI.CreateTaskCard(task);
        container.appendChild(card);
      });
    }
  },
  
  /**
  * Display completed tasks
  * @param {Array} tasks - Array of completed tasks
  */
  displayCompletedTasks(tasks) {
    const container = document.getElementById('completed-tasks');
    const emptyState = document.getElementById('no-completed-tasks');
    const filterSelect = document.getElementById('filter-status');
    
    // Apply filter if selected
    let filteredTasks = tasks;
    if (filterSelect && filterSelect.value !== 'all') {
      const filterMap = {
        'success': ['Success', 'Completed'],
        'failed': ['Error', 'Fatal', 'Failed'],
        'cancelled': ['Cancelled', 'Timeout']
      };
      
      const allowedStatuses = filterMap[filterSelect.value] || [];
      filteredTasks = tasks.filter(task => 
        allowedStatuses.includes(task.status)
      );
    }
    
    if (filteredTasks.length === 0) {
      container.innerHTML = '';
      emptyState.style.display = 'block';
    } else {
      emptyState.style.display = 'none';
      container.innerHTML = '';
      
      // Sort by end time (most recent first)
      filteredTasks.sort((a, b) => {
        const timeA = new Date(a.endTime || a.startTime || 0);
        const timeB = new Date(b.endTime || b.startTime || 0);
        return timeB - timeA;
      });
      
      filteredTasks.forEach(task => {
        const item = UI.CreateTaskListItem(task);
        container.appendChild(item);
      });
    }
  },
  
  /**
  * Submit a new task
  * @param {FormData} formData - Form data for the new task
  */
  async submitNewTask(formData) {
    try {
      // Show loading state
      const submitButton = document.querySelector('#new-task-form button[type="submit"]');
      const originalText = submitButton.innerHTML;
      submitButton.disabled = true;
      submitButton.innerHTML = '<span class="spinner"></span> Sending in progress...';
      
      // Submit task
      const response = await API.submitTask(formData);
      
      // Success
      UI.ShowToast(
        `Experiment started with ID: ${response.task_id}`,
        'success',
        'Success'
      );
      
      // Reset form
      document.getElementById('new-task-form').reset();
      
      // Clear file labels
      document.querySelectorAll('.file-label .file-text').forEach(text => {
        text.textContent = text.parentElement.dataset.defaultText || 'Select a file...';
      });
      document.getElementById('selected-files').innerHTML = '';
      
      // Switch to running tasks tab
      UI.SwitchTab('running');
      
      // Reload tasks immediately
      await this.loadTasks();
      
    } catch (error) {
      UI.ShowToast(
        error.message || 'An error occurred while submitting the task',
        'error',
        'Error'
      );
    } finally {
      // Restore button state
      const submitButton = document.querySelector('#new-task-form button[type="submit"]');
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.innerHTML = '<span class="btn-icon">🚀</span> Start task';
      }
    }
  },
  
  /**
  * Refresh running tasks manually
  */
  async refreshRunning() {
    const button = document.getElementById('refresh-running');
    button.disabled = true;
    button.innerHTML = '<span class="spinner"></span> Refreshing...';
    
    await this.loadRunningTasks();
    
    button.disabled = false;
    button.innerHTML = '<span class="btn-icon">🔄</span> Refresh';
    
    UI.ShowToast('Active tasks updated', 'success');
  },
  
  /**
  * Refresh completed tasks manually
  */
  async refreshCompleted() {
    const button = document.getElementById('refresh-completed');
    button.disabled = true;
    button.innerHTML = '<span class="spinner"></span> Refreshing...';
    
    await this.loadCompletedTasks();
    
    button.disabled = false;
    button.innerHTML = '<span class="btn-icon">🔄</span> Refresh';
    
    UI.ShowToast('Completed tasks updated', 'success');
  },
  
  /**
  * Get task logs (stdout/stderr)
  * @param {string} taskId - Task ID
  * @param {string} stepId - Step ID
  * @param {string} type - 'stdout' or 'stderr'
  * @param {number} offset - Read offset
  */
  async getTaskLogs(taskId, stepId, type = 'stdout', offset = 0) {
    try {
      const params = {
        taskId: taskId,
        stepId: stepId,
        type: type,
        rankId: '0',
        attemptId: '0',
        offset: offset,
        size: Config.OUTPUT_CHUNK_SIZE,
        executor: 'Local'
      };
      
      const result = await API.getTaskOutput(params);
      
      return {
        content: result.decodedData || '',
        hasMore: result.state === 1,  // state 1 = more data available
        isDone: result.state === 3,   // state 3 = finished
        isUpToDate: result.state === 2, // state 2 = up to date but not finished
        nextOffset: offset + (result.decodedData ? result.decodedData.length : 0)
      };
      
    } catch (error) {
      console.error('Error fetching logs:', error);
      throw error;
    }
  },
  
  /**
  * Stream logs for a running step (based on task_running.html logic)
  * @param {Object} step - Step object with all necessary data
  * @param {string} stdoutElementId - ID of stdout pre element
  * @param {string} stderrElementId - ID of stderr pre element
  */
  async streamStepLogs(step, stdoutElementId, stderrElementId) {
    const outputStates = {
      stdout: { offset: 0, done: false },
      stderr: { offset: 0, done: false }
    };
    
    // Function to fetch a chunk of output
    const fetchChunk = async (type, elementId) => {
      const state = outputStates[type === 'error' ? 'stderr' : type];
      if (state.done) return;
      
      const preEl = document.getElementById(elementId);
      if (!preEl) return; // Element might have been removed
      
      // Clear initial loading text
      if (preEl.textContent === '(loading...)') {
        preEl.textContent = '';
      }
      
      try {
        while (true) {
          const params = {
            taskId: step.task.id,
            stepId: step.step_id,
            type: type,
            rankId: step.rank_id || '0',
            attemptId: step.attempt_id || '0',
            offset: state.offset,
            size: Config.OUTPUT_CHUNK_SIZE,
            executor: step.executor || 'Local'
          };
          
          const result = await API.getTaskOutput(params);
          
          if (!result.success) {
            preEl.textContent += `\n❌ Error: ${result.error || 'unknown'}`;
            state.done = true;
            break;
          }
          
          // Add decoded content
          if (result.decodedData && result.decodedData.length > 0) {
            preEl.textContent += result.decodedData;
            preEl.scrollTop = preEl.scrollHeight; // Auto-scroll
            state.offset += result.decodedData.length;
          }
          
          // Check state
          if (result.state === 3) { // Finished
            state.done = true;
            break;
          } else if (result.state === 2) { // Up to date but not finished
            break; // Will retry on next poll
          }
          // If state === 1, continue loop (more data available)
          
          if (result.state !== 1) {
            break;
          }
        }
      } catch (error) {
        preEl.textContent += `\n❌ Error: ${error.message}`;
        state.done = true;
      }
    };
    
    // Initial fetch
    await fetchChunk('stdout', stdoutElementId);
    await fetchChunk('error', stderrElementId);
    
    // Set up polling for updates
    const pollInterval = setInterval(async () => {
      // Check if modal is still open and elements exist
      const modal = document.getElementById('task-modal');
      if (!modal || !modal.classList.contains('active')) {
        clearInterval(pollInterval);
        return;
      }
      
      await fetchChunk('stdout', stdoutElementId);
      await fetchChunk('error', stderrElementId);
      
      // Stop polling if both are done
      if (outputStates.stdout.done && outputStates.stderr.done) {
        clearInterval(pollInterval);
      }
    }, Config.POLL_INTERVAL_RUNNING);
  },
  
  /**
  * Stream logs for a running task (legacy compatibility)
  * @param {string} taskId - Task ID
  * @param {string} stepId - Step ID
  * @param {Function} callback - Callback for each chunk
  */
  async streamLogs(taskId, stepId, callback) {
    let offset = 0;
    let hasMore = true;
    
    while (hasMore) {
      try {
        const result = await this.getTaskLogs(taskId, stepId, 'stdout', offset);
        
        if (result.content) {
          callback(result.content);
        }
        
        hasMore = !result.isDone && !result.isUpToDate;
        offset = result.nextOffset;
        
        // Wait a bit before next chunk
        if (hasMore && result.isUpToDate) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
      } catch (error) {
        console.error('Error streaming logs:', error);
        break;
      }
    }
  },
  
  /**
  * Export task results
  * @param {string} taskId - Task ID
  */
  async exportTaskResults(taskId) {
    try {
      // Get task details
      const statusData = await API.getRunningTasks();
      const tasks = API.parseStatusData(statusData);
      const task = tasks.all.find(t => t.id === taskId);
      
      if (!task) {
        throw new Error('Task not found');
      }
      
      // Create JSON export
      const exportData = {
        task: task,
        exportDate: new Date().toISOString(),
        serverUrl: Config.API_BASE_URL
      };
      
      // Download as JSON file
      const blob = new Blob([JSON.stringify(exportData, null, 2)], {
        type: 'application/json'
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `task_${taskId}_export.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      UI.ShowToast('Successful export', 'success');
      
    } catch (error) {
      console.error('Error exporting task:', error);
      UI.ShowToast('Error exporting task', 'error');
    }
  },
  
  /**
  * Compare multiple tasks
  * @param {Array} taskIds - Array of task IDs to compare
  */
  async compareTasks(taskIds) {
    try {
      const statusData = await API.getRunningTasks();
      const tasks = API.parseStatusData(statusData);
      
      const tasksToCompare = tasks.all.filter(t => taskIds.includes(t.id));
      
      if (tasksToCompare.length < 2) {
        UI.ShowToast('Select at least two tasks to compare', 'warning');
        return;
      }
      
      // Create comparison view (placeholder for future implementation)
      console.log('Comparing tasks:', tasksToCompare);
      UI.ShowToast('Comparison feature under development', 'info');
      
    } catch (error) {
      console.error('Error comparing tasks:', error);
      UI.ShowToast('Error comparing tasks', 'error');
    }
  },
  
  /**
  * Clean up old completed tasks from display
  * @param {number} daysOld - Remove tasks older than this many days
  */
  cleanupOldTasks(daysOld = 7) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysOld);
    
    this.currentTasks.completed = this.currentTasks.completed.filter(task => {
      const taskDate = new Date(task.endTime || task.startTime);
      return taskDate > cutoffDate;
    });
    
    this.displayCompletedTasks(this.currentTasks.completed);
    UI.ShowToast(`Tasks older than ${daysOld} days hidden`, 'info');
  }
};
