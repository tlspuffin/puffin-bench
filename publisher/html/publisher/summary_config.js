const urls = {
  git_restapi: `http://${window.location.hostname}:10081`,
  scheduler: `http://${window.location.hostname}:10082`,
  vis_comparator: (project) => `http://${window.location.hostname}:10084/files/${project}/index.html`
}

export { urls };
