var fetchControllerGit = null;
var fetchControllerGitLogs = null;
var fetchControllerProject = null;

/*****************************************/

const dataDefinitions = {
  Perf: {
    coverage: {
      target: 'success',
      compute: {
        datapath: [ 'clients.tEnd.coverage' ],
        value: (coverages) => 
          coverages.map(coverage => (((coverage?.hit ?? coverage?.discovered ?? 0) / (coverage?.max ?? 1)) * 100))
      }
    },
    corpus_size: {
      target: 'success',
      compute: {
        datapath: [ 'global.tEnd.corpus_size' ]
      }
    },
    client_duration_s: {
      target: 'success',
      compute: {
        datapath: [ 'clients.tEnd.time.secs_since_epoch', 'clients.t0.time.secs_since_epoch' ],
        value: DiffArray,
      },
    },
    fail_client_duration_s: {
      target: 'fail',
      compute: {
        datapath: [ 'clients.tEnd.time.secs_since_epoch', 'clients.t0.time.secs_since_epoch' ],
        value: DiffArray,
      },
    },
    total_execs: {
      target: 'success',
      compute: {
        datapath: [ 'global.tEnd.total_execs' ]
      }
    },
    objective_size: {
      target: 'success',
      compute: {
        datapath: [ 'nb_objective_on_disk', 'global.tEnd.objective_size' ],
        value: (nbObjectiveOnDisk, objectiveSize) => { return [ Math.max(nbObjectiveOnDisk, objectiveSize) ]; }
      }
    },
    fail_duration_s: {
      target: 'fail',
      compute: {
        datapath: [ 'global.tEnd.time.secs_since_epoch', 'global.t0.time.secs_since_epoch' ],
        value: DiffArray
      }
    }
  },
  Vuln: {
    durations_s: {
      target: 'success',
      compute: {
        datapath: [ 'global.tEnd.time.secs_since_epoch', 'global.t0.time.secs_since_epoch' ],
        value: DiffArray
      }
    },
    fail_duration_s: {
      target: 'fail',
      compute: {
        datapath: [ 'global.tEnd.time.secs_since_epoch', 'global.t0.time.secs_since_epoch' ],
        value: DiffArray
      }
    },
    total_execs: {
      target: 'success',
      compute: {
        datapath: [ 'global.tEnd.total_execs' ],
      }
    },
    fail_total_execs: {
      target: 'fail',
      compute: {
        datapath: [ 'global.tEnd.total_execs' ],
      }
    }
  },
  Campaign: {
    coverage: {
      target: 'success',
      compute: {
        datapath: [ 'clients.tEnd.coverage' ],
        value: (coverages) => 
          coverages.map(coverage => (((coverage?.hit ?? coverage?.discovered ?? 0) / (coverage?.max ?? 1)) * 100))
      }
    },
    corpus_size: {
      target: 'success',
      compute: {
        datapath: [ 'global.tEnd.corpus_size' ]
      }
    },
    client_duration_s: {
      target: 'success',
      compute: {
        datapath: [ 'clients.tEnd.time.secs_since_epoch', 'clients.t0.time.secs_since_epoch' ],
        value: DiffArray,
      },
    },
    fail_client_duration_s: {
      target: 'fail',
      compute: {
        datapath: [ 'clients.tEnd.time.secs_since_epoch', 'clients.t0.time.secs_since_epoch' ],
        value: DiffArray,
      },
    },
    total_execs: {
      target: 'success',
      compute: {
        datapath: [ 'global.tEnd.total_execs' ]
      }
    },
    objective_size: {
      target: 'success',
      compute: {
        datapath: [ 'nb_objective_on_disk', 'global.tEnd.objective_size' ],
        value: (nbObjectiveOnDisk, objectiveSize) => { return [ Math.max(nbObjectiveOnDisk, objectiveSize) ]; }
      }
    },
    fail_duration_s: {
      target: 'fail',
      compute: {
        datapath: [ 'global.tEnd.time.secs_since_epoch', 'global.t0.time.secs_since_epoch' ],
        value: DiffArray
      }
    }
  }
}

function DiffArray(a, b) {
  const result = [];
  if (a.length != b.length) {
    const maxSize = Math.max(a.length, b.length);
    for(let i=0; i<maxSize; ++i) {
      result.push(NaN);
    }
  } else {
    for(let i=0; i<a.length; ++i) {
      result.push(a[i] - b[i]); 
    }
  }
  return result;
}

/*****************************************/

function ExtractValue(path, obj) {
  let acc = { current: [ obj ] };
  return path.split('.').reduce((acc, element) => {
      if (acc.current !== undefined) {
        if (Array.isArray(acc.current)) {
          acc.current = acc.current.map(item => item[element]).flat();
        } else {
          acc.current = acc.current[element];
        }
      }
      return acc;
  }, acc).current;
}

function BuildDataSet(source, json) {
  if (json?.data === undefined) {
    return {};
  }
  const commitID = json.data?.commit_id;
  if (commitID === undefined) {
    return {};
  }
  const type = NormalizeType(json.data?.type);
  if (type === undefined) {
    return {};
  }
  const definition = dataDefinitions[type];
  if (definition === undefined) {
    return {}
  }
  const libraries = json.data?.libraries
  if (libraries === undefined) {
    return {}
  }
  const libratriesKey = Object.keys(libraries);
 
  if (libratriesKey.some(
      library => {
        if (libraries[library]?.error !== undefined) {
          return false;
        }
        return (!Array.isArray(libraries[library].data)) ||
              libraries[library].data.some((attempt) => {
            return (((!Array.isArray(attempt?.global)) || (!Array.isArray(attempt?.clients))) && 
                (attempt?.error === undefined));
        });
      })) {
    return {};
  }

  const metrics = {};
  const errors = {};
  const status = {}
  const result = {
      commit_id: commitID, 
      source, 
      index: json?.index, 
      type, 
      metrics, 
      errors, 
      global_status: 'no run', 
      status
  };
  if (type === 'Campaign') {
    result.user = json.data?.user ?? "unknown";
    result.campaign_id = json.data?.campaign_id ?? "unknown campaign";
  }

  libratriesKey.forEach(library => {
      if (libraries[library]?.error !== undefined) {
        errors[library] = libraries[library].error;
        return;
      }

      metrics[library] = {};
      status[library] = { 
        state: [], 
        success: 0, 
        cli: libraries[library]?.cli ?? 'N/A', 
        trust_objective: libraries[library]?.trust_objective ?? 0
      };
      libraries[library].data.forEach(attempt => {
        if (attempt?.error !== undefined) {
          if (errors[library] === undefined) {
            errors[library] = {};
          }
          errors[library][attempt.id] = attempt.error;
        }
        status[library].state.push(attempt?.state);
      });
      Object.keys(definition).forEach(metric => {
          metrics[library][metric] = [];
          libraries[library].data.forEach(attempt => {
              if (attempt?.error !== undefined) {
                return;
              }
              if (attempt?.state !== definition[metric].target) {
                return;
              }
              let allArgs = [];
              definition[metric].compute.datapath.forEach(path => {
                allArgs.push(ExtractValue(path, attempt));
              });
              if (definition[metric].compute?.value != undefined) {
                metrics[library][metric].push(definition[metric].compute.value(...allArgs));
              } else {
                metrics[library][metric].push(...allArgs);
              }
          });
      });
  });

  const states = Object.keys(status).reduce((acc, library) => {
    const states = status[library].state.reduce((accLib, state) => {
        ++accLib.total;
        switch(state) {
          case 'success': 
            ++status[library].success;
            ++accLib.success; 
            break;
          case 'fail': 
            ++accLib.fail; 
            break;
        }
        return accLib;
      }, { success: 0, fail: 0, total: 0 });
    metrics[library].ratio_success_execution = [ (states.success / (states.total > 0 ? states.total : 1)) * 100 ];
    acc.success += states.success;
    acc.fail += states.fail;
    acc.total += states.total;
    return acc;
  }, { success: 0, fail: 0, total: 0 });
  if (states.success === states.total) {
    result.global_status = 'success';
  } else if (states.fail === states.total) {
    result.global_status = 'fail';
  } else if (states.total > 0) {
    result.global_status = 'mixed';
  }
  return result;
}

/*****************************************/

function NormalizeType(type) {
  if (type === undefined) {
    return undefined;
  }
  let result = "unknown";
  if (type) {
    const lower = type.toLowerCase();
    if (lower.startsWith("perf")) {
      result = "Perf";
    } else if (lower.startsWith("vuln")) {
      result = "Vuln";
    } else if (lower.startsWith("campaign")) {
      result = "Campaign";
    } else {
      result = type;
    }
  }
  return result;
}

export async function LoadCommits(runResults, config, project) {
  const result = new Map();
  const batchSize = 10;
  for (let i = 0; i < runResults.length; i += batchSize) {
    const batch = runResults.slice(i, i + batchSize);
    const promises = batch.map(async file => {
        try {
          const response = await fetch(`${config.urlDataFile(project)}/${file}`);
          if (response.ok) {
            const json = await response.json();
            if (json?.data?.type === undefined) {
              throw('Missing field data.type')
            }
            if (json?.data?.commit_id === undefined) {
              throw('Missing field data.commit_id')
            }
            json.source_file = file;
            let gitState = result.get(json.data.commit_id);
            if (!gitState) {
              gitState = new Map();
              result.set(json.data.commit_id, gitState);
            }
            const type = NormalizeType(json.data.type);
            if (type != 'Campaign') {
              gitState.set(type, BuildDataSet(file, json));
            } else {
              let campaignArray = gitState.get(type);
              if (!campaignArray) {
                campaignArray = [];
                gitState.set(type, campaignArray);
              }
              campaignArray.push(BuildDataSet(file, json));
            }
          } else {
            throw(`Network or server error: ${response.status}`)
          }
        } catch(error) {
          console.error(file + ': ' + error);
          let unknowState = result.get("unknown");
          if (!unknowState) {
            unknowState = new Map();
            result.set("unknown", unknowState);
          }
          unknowState.set(file, { type: 'error', error });
        }
    });
    await Promise.all(promises);
  }
  return result;
}

export async function LoadGitLogs(commitsArray, config, project) {
  try {
    const payload = {
        commits: commitsArray
    };
    fetchControllerGitLogs = new AbortController();
    const response = await fetch(config.urlGitLogs(project), {
        signal: fetchControllerGitLogs.signal,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
    });
    if (!response.ok) {
      throw(`network or server error, status : ${response.status}`);
    }
    const body = await response.json();
    return { error: false, data: body.commits };
  } catch(error) {
    return { error: true, data: error };
  }
}

export async function LoadGitData(refresh, config, project) {
  try {
    fetchControllerGit = new AbortController();
    const response = await fetch(config.urlGit(project)+refresh, 
        {cache: 'no-store', signal: fetchControllerGit.signal});
    if ((!response.ok) || (response.status != 200)) {
      throw(`Network or server error, status ${response.status}`);
    }
    const body = await response.json();
    if ((body?.success != null) && (!body.success)) {
      throw(`Server error ${body?.error}`);
    }
    return { error: false, data: {
      'commits': body.commits, 
      'PR': body.PR,
      'PR_API_Infos': body.PR_API_Infos, 
      'branches': body.branches
     } };
  } catch(error) {
    return { error: true, data: error };
  }
}

export async function LoadProjectData(config, project) {
  try {
    fetchControllerProject = new AbortController();
    const response = await fetch(config.urlData(project), 
        {cache: 'no-store', signal: fetchControllerProject.signal});
    if ((!response.ok) || (response.status != 200)) {
      throw(`Network or server error, status ${response.status}`);
    }
    const body = await response.json();
    if (!(body?.success)) {
      throw(`Server error ${body?.error}`);
    }
    return { error: false, data: body?.files };
  } catch(error) {
    return { error: true, data: error };
  }
}

/*****************************************/

export function UpdateCommitInfo(commit, commitType, files) {
  if (!(commit?.infos)) {
    commit.infos = new Map();
  }
  if (commitType != 'Campaign') {
    commit.infos.set(commitType, files)
  } else {
    let campaignArray = commit.infos.get(commitType);
    if (!campaignArray) {
      campaignArray = [];
      commit.infos.set(commitType, campaignArray);
    }
    campaignArray.push(...files);
  }
}

/*****************************************/