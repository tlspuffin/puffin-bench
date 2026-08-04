import * as Utils from './utils.js';

function Main() {
  if (scriptArgs.length < 7) {
    console.log(Utils.EndErrorMessage('Not enough arguments'));
    std.exit(1);
  }

  const taskFilename = scriptArgs[1];
  if (!Utils.IsFile(taskFilename)) {
    console.log(Utils.EndErrorMessage('Arguments 1 should be json task file'));
    std.exit(1);
  }

  const libAflVersion = scriptArgs[2];
  if (!Utils.IsString(libAflVersion)) {
    console.log(Utils.EndErrorMessage('Arguments 2 should be the libafl version'));
    std.exit(1);
  }

  const statsFile = scriptArgs[3];
  if (!Utils.IsFile(statsFile)) {
    console.log(Utils.EndErrorMessage('Arguments 3 should be json stats file'));
    std.exit(1);
  }

  let nbObjectiveOnDisk = scriptArgs[4];
  if (!Utils.IsNumeric(nbObjectiveOnDisk)) {
    console.log(Utils.EndErrorMessage('Arguments 4 should be the number of objective file'));
    std.exit(1);
  }
  nbObjectiveOnDisk = Number(nbObjectiveOnDisk);

  let stepUUID = scriptArgs[5];
  if (!Utils.IsNumeric(stepUUID)) {
    console.log(Utils.EndErrorMessage('Arguments 5 should be the step uuid number'));
    std.exit(1);
  }
  stepUUID = Number(stepUUID);

  const outFile = scriptArgs[6];
  if (!Utils.IsString(outFile)) {
    console.log(Utils.EndErrorMessage('Arguments 6 should be summary file to save'));
    std.exit(1);
  }

  let taskInfo = Utils.ExtractStep(stepUUID, taskFilename);
  let taskInfoError = (typeof taskInfo !== 'object') || (taskInfo?.state === undefined) || 
      (taskInfo?.nb_cores === undefined) || (taskInfo?.attempt_id === undefined);
  if (!taskInfoError) {
    taskInfo = {
      state: (taskInfo.state === "TimedOut") ? 'success' : 'fail',
      nbCore: taskInfo.nb_cores,
      attemptID: taskInfo.attempt_id
    }
  } else {
    console.log(Utils.EndErrorMessage(
        (typeof taskInfo !== 'object') ? taskInfo : `Missing required fields in ${taskFilename}`));
    std.exit(1);
  }

  const nbCores = Utils.AdjustNbCore(libAflVersion, taskInfo.nbCore);
  const stats = Utils.GetLastStats(statsFile, nbCores);
  if (stats.error !== null) {
    console.log(Utils.EndErrorMessage(stats.error));
    std.exit(1);
  }
  console.log(JSON.stringify({
    nb_cores:  taskInfo.nbCore,
    nb_clients: stats.nb,
    execPerSec: stats.infos[0]?.exec_per_sec ?? 0
  }));

  const firstStats = Utils.GetFirstStats(statsFile, stats.nb);
  if (firstStats.error !== null) {
    console.log(Utils.EndErrorMessage(firstStats.error));
    std.exit(1);
  }

  Utils.PruneZeroFields(firstStats);
  let result = { 
    id: taskInfo.attemptID, 
    state: taskInfo.state, 
    nb_objective_on_disk: nbObjectiveOnDisk, 
    global: [], 
    clients: [], 
    others: []
  };
  for(let i=0; i<stats.infos.length; ++i) {
    if (stats.infos[i] === undefined) {
      continue;
    }
    const type = stats.infos[i].type;
    const id = i - 1;
    if ((id === 0) && (type === 'client')) {
      continue;
    }
    // a client that reports very late (or the run ends almost immediately)
    // can be missing from the first snapshot even though it's in the last one
    if (firstStats.infos[i] === undefined) firstStats.infos[i] = {};
    delete firstStats.infos[i].type;
    delete firstStats.infos[i].id;
    delete stats.infos[i].type;
    delete stats.infos[i].id;
    if (type === 'global') {
      result.global.push({
        id: 0,
        t0: firstStats.infos[i],
        tEnd: stats.infos[i],
      });
    } else if (type === 'client') {
      result.clients.push({
        id,
        t0: firstStats.infos[i],
        tEnd: stats.infos[i],
      });
    } else {
      result.others.push({
        type,
        id,
        t0: firstStats.infos[i],
        tEnd: stats.infos[i],
      });
    }
  }

  const saveRetVal = Utils.SaveFile(outFile, JSON.stringify(result)+'\n');
  if (saveRetVal !== null) {
    console.error(Utils.EndErrorMessage(saveRetVal))
    std.exit(1);
  }

  std.exit(0);
}

Main();
