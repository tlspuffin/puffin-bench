const urls = {
  git_restapi: `http://${window.location.hostname}:10081`,
  scheduler: `http://${window.location.hostname}:10082`,
  vis_comparator: `http://${window.location.hostname}:10084/files/vis_comparator/index.html`
}

const config = {
  urlData: (project) => `http://${window.location.host}/api/project/${project}/data`,
  urlDataFile: (project) => `http://${window.location.host}/files/${project}/.project`,

  urlGit: (project) => `${urls.git_restapi}/api/git/history/${project}`,
  urlGitLogs: (project) => `${urls.git_restapi}/api/git/logs/${project}`,

  taskInfoURL: `${urls.scheduler}/files/board/task.html`,
  artefactURL: (taskID) => `${urls.scheduler}/api/task/${taskID}/artefacts`,

  vis_comparator: urls.vis_comparator,
  vis_comparator_details: (commitID, libraryName) => `${urls.vis_comparator}?template=SingleTaskTemplate&c1=${commitID}&c1.alias=${commitID.substring(0, 14)}&s1=Perf%3A${libraryName}`
}

export { config };
