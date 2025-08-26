const API = {
  /**
  * Submit a new task
  * @param {FormData} formData - Form data with config, script, and files
  * @returns {Promise<Object>} Response with task_id
  */
  async submitTask(formData) {
    try {
      const response = await fetch(Config.API_BASE_URL + Config.API_ENDPOINTS.TASK_NEW, {
        method: 'POST',
        body: formData
      });
      
      const data = await response.json();
      
      if (!data.success) {
        throw new Error(data.error || 'Failed to submit task');
      }
      
      return data;
    } catch (error) {
      console.error('Error submitting task:', error);
      throw error;
    }
  },
  
  /**
  * Get running tasks status
  * @returns {Promise<Object>} Current status of all tasks
  */
  async GetRunningTasks() {
    try {
      const endpoint = Config.API_ENDPOINTS.TASKS_RUNNING;
      const response = await fetch(Config.API_BASE_URL + endpoint.path, {
        method: endpoint.method,
      });
      
      const data = await response.json();
      
      if (!data.success) {
        throw new Error(data.error || 'Failed to fetch running tasks');
      }
      
      return data.data;  // Return the status.json content
    } catch (error) {
      console.error('Error fetching running tasks:', error);
      throw error;
    }
  },
  
  /**
  * Get task output (stdout/stderr)
  * @param {Object} params - Parameters for fetching output
  * @returns {Promise<Object>} Output data and state
  */
  async getTaskOutput(params) {
    try {
      const formData = new FormData();
      formData.append('type', params.type || 'stdout');
      formData.append('task_id', params.taskId);
      formData.append('step_id', params.stepId);
      formData.append('rank_id', params.rankId || '0');
      formData.append('attempt_id', params.attemptId || '0');
      formData.append('read_offset', params.offset || '0');
      formData.append('read_size', params.size || Config.OUTPUT_CHUNK_SIZE.toString());
      formData.append('executor', params.executor || 'Local');
      
      const response = await fetch(Config.API_BASE_URL + Config.API_ENDPOINTS.TASK_OUTPUTS, {
        method: 'POST',
        body: formData
      });
      
      const data = await response.json();
      
      if (!data.success) {
        throw new Error(data.error || 'Failed to fetch task output');
      }
      
      // Decode base64 output
      if (data.data) {
        data.decodedData = atob(data.data);
      }
      
      return data;
    } catch (error) {
      console.error('Error fetching task output:', error);
      throw error;
    }
  },
  
  /**
  * Put file in cache
  * @param {string} id - Cache ID
  * @param {string} path - File path
  * @param {boolean} force - Force overwrite
  * @param {boolean} computeMD5 - Compute MD5 hash
  * @returns {Promise<Object>} Success status
  */
  async cachePut(id, path, force = false, computeMD5 = false) {
    try {
      const formData = new FormData();
      formData.append('id', id);
      formData.append('path', path);
      formData.append('force', force ? 'true' : 'false');
      formData.append('computeMD5', computeMD5 ? 'true' : 'false');
      
      const response = await fetch(Config.API_BASE_URL + Config.API_ENDPOINTS.CACHE_PUT, {
        method: 'POST',
        body: formData
      });
      
      const data = await response.json();
      
      if (!data.success) {
        throw new Error(data.error || 'Failed to put file in cache');
      }
      
      return data;
    } catch (error) {
      console.error('Error putting file in cache:', error);
      throw error;
    }
  },
  
  /**
  * Get file from cache
  * @param {string} id - Cache ID
  * @returns {Promise<Object>} File path and state
  */
  async cacheGet(id) {
    try {
      const formData = new FormData();
      formData.append('id', id);
      
      const response = await fetch(Config.API_BASE_URL + Config.API_ENDPOINTS.CACHE_GET, {
        method: 'POST',
        body: formData
      });
      
      const data = await response.json();
      
      if (!data.success) {
        throw new Error(data.error || 'Failed to get file from cache');
      }
      
      return data;
    } catch (error) {
      console.error('Error getting file from cache:', error);
      throw error;
    }
  },
  
  /**
  * Parse status JSON to extract tasks
  * @param {Object} statusData - Raw status data from API
  * @returns {Object} Parsed tasks by status
  */
  parseStatusData(statusData) {
    const result = {
      running: [],
      completed: [],
      failed: [],
      all: []
    };
    
    if (!statusData) {
      return result;
    }
    
    // Parse running_steps if available (for detailed logs view)
    if (statusData.running_steps) {
      result.runningSteps = statusData.running_steps;
    }
    
    // Parse tasks from status.json structure
    if (statusData.tasks && statusData.tasks.length > 0) {
      statusData.tasks.forEach(task => {
        const taskInfo = {
          id: task.id,
          name: task.name || `Task ${task.id}`,
          status: task.state || 'Unknown',
          startTime: task.start_time,
          endTime: task.end_time,
          currentStep: task.current_step,
          totalSteps: task.total_steps || 0,
          completedSteps: task.completed_steps || 0,
          steps: task.steps || []
        };
        
        result.all.push(taskInfo);
        
        // Categorize by status
        if (taskInfo.status === 'Running') {
          result.running.push(taskInfo);
        } else if (taskInfo.status === 'Success' || taskInfo.status === 'Completed') {
          result.completed.push(taskInfo);
        } else if (taskInfo.status === 'Error' || taskInfo.status === 'Fatal' || taskInfo.status === 'Timeout') {
          result.failed.push(taskInfo);
        }
      });
    }

    // IMPORTANT: Also process running_steps even if tasks is empty/missing
    
    // Also check for running_steps to identify running tasks
    if (result.runningSteps && result.runningSteps.length > 0) {
      // Extract unique task IDs from running steps
      const runningTaskIds = new Set();
      result.runningSteps.forEach(step => {
        if (step.task && step.task.id) {
          runningTaskIds.add(step.task.id);
        }
      });
      
      // Add any missing running tasks
      runningTaskIds.forEach(taskId => {
        // Check if task already exists in result.all
        let existingTask = result.all.find(t => t.id === taskId);
        
        if (!existingTask) {
          // Task doesn't exist in result.all, create it from running_steps
          const runningStep = result.runningSteps.find(s => s.task && s.task.id === taskId);
          if (runningStep && runningStep.task) {
            const newTask = {
              id: taskId,
              name: runningStep.task.name || `Task ${taskId}`,
              status: 'Running',
              currentStep: runningStep.name,
              hasRunningSteps: true,
              startTime: runningStep.task.start_time,
              totalSteps: 1,
              completedSteps: 0,
              steps: [runningStep]
            };
            
            // Add to all collections
            result.all.push(newTask);
            
            // Also add to running if not already there
            if (!result.running.find(t => t.id === taskId)) {
              result.running.push(newTask);
            }
          }
        } else {
          // Task exists, update it with running_steps info if needed
          if (!existingTask.hasRunningSteps) {
            existingTask.hasRunningSteps = true;
            existingTask.currentStep = result.runningSteps.find(s => s.task && s.task.id === taskId)?.name;
          }
        }
      });
    }
    
    return result;
  }
};
