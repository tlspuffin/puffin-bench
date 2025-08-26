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

      return data.data.running_steps;  // Return the status.json content
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
  async GetStepOutput(params) {
    try {
      const endpoint = Config.API_ENDPOINTS.TASK_OUTPUTS;
      const url = Config.API_BASE_URL + endpoint.path + 
          '/' + params.taskId + 
          '/' + (params.type || 'stdout') +
          '/' + params.stepId +
          '/' + params.rankId +
          '/' + params.attemptId +
          '/' + (params.size || Config.OUTPUT_CHUNK_SIZE.toString()) +
          '/' + (params.offset || '0');
      const response = await fetch(url, {
        method: endpoint.method
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
  * @param {Object} tasksData - Raw status data from API
  * @returns {Object} Parsed tasks by status
  */
  ParseTasksData(tasksData) {
    const result = {
      running: [],
      completed: [],
      failed: [],
      all: []
    };

    if (!tasksData) {
      return result;
    }

    const runningTask = new Map();
    tasksData.forEach(step => {
      if (step.task && step.task.id) {
        const task  = step.task;
        const steps = runningTask.get(task) || new Set();
        steps.add(step);
        runningTask.set(task, steps);
      }
    });

    runningTask.forEach((steps, task) => {
      const taskInfo = {
          id: task.id,
          name: task.name || `Task ${task.id}`,
          status: 'Running',
          startTime: task?.time_points_ms?.[0] ?? 0,
          endTime: task?.time_points_ms?.[1] ?? 0,
          currentStep: steps,
          totalSteps: 0,
          completedSteps: 0,
          steps: steps
      };
      result.all.push(taskInfo);
      if (taskInfo.status === 'Running') {
        result.running.push(taskInfo);
      } else if (taskInfo.status === 'Success' || taskInfo.status === 'Completed') {
        result.completed.push(taskInfo);
      } else if (taskInfo.status === 'Error' || taskInfo.status === 'Fatal' || taskInfo.status === 'Timeout') {
        result.failed.push(taskInfo);
      }
    });

    return result;
  }
};
