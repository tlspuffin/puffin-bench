// dashboard.js

class SchedulerDashboard {
  constructor() {
    this.data = null;
    this.refreshInterval = null;
    this.init();
  }

  init() {
    this.setupEventListeners();
    this.loadSampleData();
  }

  setupEventListeners() {
    document.getElementById('loadFileBtn').addEventListener('click', () => {
      document.getElementById('fileInput').click();
    });

    document.getElementById('fileInput').addEventListener('change', (e) => {
      this.handleFileLoad(e);
    });

    document.getElementById('refreshBtn').addEventListener('click', () => {
      this.refresh();
    });
  }

  async handleFileLoad(event) {
    const file = event.target.files[0];
    if (!file) return;

    try {
      const text = await file.text();
      const data = JSON.parse(text);
      this.updateDashboard(data);
      this.showSuccess('Fichier chargé avec succès!');
    } catch (error) {
      this.showError('Erreur lors du chargement du fichier: ' + error.message);
    }
  }

  updateDashboard(data) {
    this.data = data;

    if (!data.success || !data.data || !data.data.running_steps) {
      this.showError('Format de données invalide');
      return;
    }

    const runningSteps = data.data.running_steps;

    this.updateStats(runningSteps);
    this.updateTaskOverview(runningSteps);
    this.updateCommitList(runningSteps);
    this.updateStepsTable(runningSteps);
    this.updateTaskDetails(runningSteps);
  }

  updateStats(runningSteps) {
    // Nombre total d'étapes en cours
    document.getElementById('runningSteps').textContent = runningSteps.length;

    // Nombre de tâches distinctes
    const distinctTasks = new Set(runningSteps.map(step => step.task.id)).size;
    document.getElementById('distinctTasks').textContent = distinctTasks;

    // Total CPU cores utilisés
    const totalCores = runningSteps.reduce((total, step) => {
      return total + (step.executor_data.cores ? step.executor_data.cores.length : 0);
    }, 0);
    document.getElementById('totalCores').textContent = totalCores;

    // Nombre d'étapes Build
    const buildSteps = runningSteps.filter(step => step.name === 'Build').length;
    document.getElementById('buildSteps').textContent = buildSteps;
  }

  updateTaskOverview(runningSteps) {
    const statusCounts = {};
    runningSteps.forEach(step => {
      const status = step.state || 'Unknown';
      statusCounts[status] = (statusCounts[status] || 0) + 1;
    });

    const overviewDiv = document.getElementById('taskOverview');
    overviewDiv.innerHTML = '';

    Object.entries(statusCounts).forEach(([status, count]) => {
      const statusClass = status.toLowerCase();
      const div = document.createElement('div');
      div.className = 'status-item';
      div.innerHTML = `
                <span class="status-dot ${statusClass}"></span>
                <span>${status}: <strong>${count}</strong></span>
            `;
      overviewDiv.appendChild(div);
    });
  }

  updateCommitList(runningSteps) {
    const commitCounts = {};

    runningSteps.forEach(step => {
      const commitArg = step.task.args.find(arg => arg.key === 'COMMIT_ID');
      if (commitArg) {
        const commit = commitArg.value;
        const shortCommit = commit.substring(0, 8);
        if (!commitCounts[shortCommit]) {
          commitCounts[shortCommit] = {
            full: commit,
            count: 0,
            tasks: new Set()
          };
        }
        commitCounts[shortCommit].count++;
        commitCounts[shortCommit].tasks.add(step.task.id);
      }
    });

    const commitListDiv = document.getElementById('commitList');
    commitListDiv.innerHTML = '';

    Object.entries(commitCounts).forEach(([shortCommit, info]) => {
      const div = document.createElement('div');
      div.className = 'commit-item';
      div.innerHTML = `
                <div class="commit-hash">${shortCommit}</div>
                <div class="commit-tasks">${info.count} étapes sur ${info.tasks.size} tâche(s)</div>
            `;
      div.title = info.full;
      commitListDiv.appendChild(div);
    });
  }

  updateStepsTable(runningSteps) {
    const tbody = document.querySelector('#stepsTable tbody');
    tbody.innerHTML = '';

    runningSteps.forEach(step => {
      const row = document.createElement('tr');

      const commitArg = step.task.args.find(arg => arg.key === 'COMMIT_ID');
      const commitHash = commitArg ? commitArg.value.substring(0, 8) : 'N/A';

      const cores = step.executor_data.cores || [];
      const coresText = cores.length > 0 ? cores.join(', ') : 'N/A';

      const duration = this.calculateDuration(step.time_points_ms[0]);

      row.innerHTML = `
                <td><span class="task-id">${step.task.id}</span></td>
                <td>${step.name}</td>
                <td>${step.id}</td>
                <td><span class="commit-short">${commitHash}</span></td>
                <td>${step.function}</td>
                <td>${step.executor_data.pid || 'N/A'}</td>
                <td><span class="cores-list">${coresText}</span></td>
                <td><span class="status-badge status-${step.state.toLowerCase()}">${step.state}</span></td>
                <td><span class="duration">${duration}</span></td>
                <td>${step.attempt_id + 1}/${step.nb_retry}</td>
            `;

      tbody.appendChild(row);
    });
  }

  updateTaskDetails(runningSteps) {
    const taskGroups = {};

    runningSteps.forEach(step => {
      const taskId = step.task.id;
      if (!taskGroups[taskId]) {
        taskGroups[taskId] = {
          task: step.task,
          steps: []
        };
      }
      taskGroups[taskId].steps.push(step);
    });

    const detailsDiv = document.getElementById('taskDetails');
    detailsDiv.innerHTML = '';

    Object.entries(taskGroups).forEach(([taskId, group]) => {
      const card = document.createElement('div');
      card.className = 'task-detail-card';

      const commitArg = group.task.args.find(arg => arg.key === 'COMMIT_ID');
      const commitHash = commitArg ? commitArg.value : 'N/A';

      const totalCores = group.steps.reduce((sum, step) => {
        return sum + (step.executor_data.cores ? step.executor_data.cores.length : 0);
      }, 0);

      card.innerHTML = `
                <div class="task-detail-header">
                    <div class="task-detail-id">${taskId}</div>
                    <div class="status-badge status-running">${group.steps.length} étapes</div>
                </div>
                <div class="task-detail-info">
                    <dt>Commit:</dt>
                    <dd>${commitHash.substring(0, 12)}</dd>
                    <dt>CPU cores:</dt>
                    <dd>${totalCores}</dd>
                    <dt>Répertoire:</dt>
                    <dd>${group.task.run_root_path.split('/').pop()}</dd>
                    <dt>Étapes actives:</dt>
                    <dd>${group.steps.map(s => s.name).join(', ')}</dd>
                </div>
            `;

      detailsDiv.appendChild(card);
    });
  }

  calculateDuration(startTimeMs) {
    if (!startTimeMs || startTimeMs === 0) return 'N/A';

    const now = Date.now();
    const diffMs = now - startTimeMs;
    const diffSeconds = Math.floor(diffMs / 1000);
    const diffMinutes = Math.floor(diffSeconds / 60);
    const diffHours = Math.floor(diffMinutes / 60);

    if (diffHours > 0) {
      return `${diffHours}h ${diffMinutes % 60}m`;
    } else if (diffMinutes > 0) {
      return `${diffMinutes}m ${diffSeconds % 60}s`;
    } else {
      return `${diffSeconds}s`;
    }
  }

  refresh() {
    if (this.data) {
      this.updateDashboard(this.data);
      this.showSuccess('Dashboard actualisé');
    } else {
      this.showError('Aucune donnée à actualiser');
    }
  }

  showError(message) {
    const errorDiv = document.getElementById('errorMessage');
    const errorText = document.getElementById('errorText');
    errorText.textContent = message;
    errorDiv.style.display = 'flex';

    setTimeout(() => {
      errorDiv.style.display = 'none';
    }, 5000);
  }

  showSuccess(message) {
    // Utilise le même système que les erreurs mais avec un style différent
    const errorDiv = document.getElementById('errorMessage');
    const errorText = document.getElementById('errorText');
    errorText.textContent = message;
    errorDiv.style.background = '#22c55e';
    errorDiv.style.display = 'flex';

    setTimeout(() => {
      errorDiv.style.display = 'none';
      errorDiv.style.background = '#ef4444'; // Reset to error color
    }, 3000);
  }

  loadSampleData() {
    // Données d'exemple pour démonstration
    const sampleData = {
      "success": true,
      "data": {
        "running_steps": [
          {
            "task": {
              "id": 1755871906343,
              "run_root_path": "/home/demengeo/XP/runs/1755871906343",
              "args": [{"key": "COMMIT_ID", "value": "3f648f016c84884d6470fc906735bb8c5da7891b"}]
            },
            "name": "Build",
            "id": "SDOS2",
            "function": "Build",
            "state": "Running",
            "executor_data": {"cores": [24, 47], "pid": 70450},
            "time_points_ms": [Date.now() - 120000, 0],
            "attempt_id": 0,
            "nb_retry": 3
          },
          {
            "task": {
              "id": 1755871906343,
              "run_root_path": "/home/demengeo/XP/runs/1755871906343",
              "args": [{"key": "COMMIT_ID", "value": "3f648f016c84884d6470fc906735bb8c5da7891b"}]
            },
            "name": "Experiment",
            "id": "BUF",
            "function": "Experiment",
            "state": "Running",
            "executor_data": {"cores": [42, 50, 29], "pid": 70987},
            "time_points_ms": [Date.now() - 300000, 0],
            "attempt_id": 1,
            "nb_retry": 5
          }
        ]
      }
    };

    this.updateDashboard(sampleData);
  }
}

// Fonction globale pour masquer les erreurs
function hideError() {
  document.getElementById('errorMessage').style.display = 'none';
}

// Initialisation quand le DOM est chargé
document.addEventListener('DOMContentLoaded', () => {
  new SchedulerDashboard();
});