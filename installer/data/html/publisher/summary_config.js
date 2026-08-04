const urls = {
  git_restapi: `http://${window.location.hostname}:${GIT_RESTAPI_PORT}`,
  scheduler: `http://${window.location.hostname}:${SCHEDULER_PORT}`,
  vis_comparator: (project) => `http://${window.location.hostname}:${VIS_COMPARATOR_PORT}/files/${project}/index.html`
}

export { urls };
