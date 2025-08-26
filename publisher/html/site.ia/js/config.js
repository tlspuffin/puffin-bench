const Config = {
  API_BASE_URL: 'http://localhost:8080/api',
  API_ENDPOINTS: {
    TASK_NEW: { path: '/task/new', method: 'POST' },
    TASKS_RUNNING: { path: '/tasks/running', method: 'GET' },
    TASK_OUTPUTS: { path: '/task/output', method: 'GET' },
    CACHE_PUT: { path: '/cache/put/', method: 'PUT' },
    CACHE_GET: { path: '/cache/get/', method: 'GET' }
  },
  
  POLL_INTERVAL_RUNNING: 5000,
  POLL_INTERVAL_COMPLETED: 30000,
  
  MAX_TOAST_DURATION: 5000,
  MAX_FILE_SIZE: 10 * 1024 * 1024,
  OUTPUT_CHUNK_SIZE: 1024 * 64,
  
  STATUS_LABELS: {
    'QUEUED': 'En attente',
    'RUNNING': 'En cours',
    'COMPLETED': 'Terminé',
    'SUCCESS': 'Succès',
    'FAILED': 'Échec',
    'CANCELLED': 'Annulé',
    'TIMEOUT': 'Timeout',
    'Pending': 'En attente',
    'Running': 'En cours',
    'Success': 'Succès',
    'Error': 'Erreur',
    'Fatal': 'Fatal',
    'Timeout': 'Timeout'
  },
  
  STATUS_ICONS: {
    'QUEUED': '⏳',
    'RUNNING': '▶️',
    'COMPLETED': '✅',
    'SUCCESS': '✅',
    'FAILED': '❌',
    'CANCELLED': '⚠️',
    'TIMEOUT': '⏱️',
    'Pending': '⏳',
    'Running': '▶️',
    'Success': '✅',
    'Error': '❌',
    'Fatal': '💀',
    'Timeout': '⏱️'
  },
  
  DATE_FORMAT: {
    locale: 'fr-FR',
    options: {
      dateStyle: 'short',
      timeStyle: 'medium'
    }
  }
};