import * as Utils from './utils.js';

function IsArrayFull(array, size) {
  for (let i=0; i<size; ++i) {
    if (array[i] === undefined) return false;
  }
  return true;
}

function Main() {
  if (scriptArgs.length < 8) {
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

  let errorFileExist = scriptArgs[5];
  if (!Utils.IsString(errorFileExist)) {
    console.log(Utils.EndErrorMessage('Arguments 5 should status of error.log: true/false'));
    std.exit(1);
  }
  errorFileExist = errorFileExist === "true";

  let stepUUID = scriptArgs[6];
  if (!Utils.IsNumeric(stepUUID)) {
    console.log(Utils.EndErrorMessage('Arguments 6 should be the step uuid number'));
    std.exit(1);
  }
  stepUUID = Number(stepUUID);

  const outFile = scriptArgs[7];
  if (!Utils.IsString(outFile)) {
    console.log(Utils.EndErrorMessage('Arguments 7 should be summary file to save'));
    std.exit(1);
  }

  const stats = Utils.GetLastStats(statsFile, libAflVersion);
  if (stats.error !== null) {
    console.log(Utils.EndErrorMessage(stats.error));
    std.exit(1);
  }
  if ((stats.nb === 0) || (!IsArrayFull(stats.infos, stats.nb))) {
    const stats_1 = Utils.GetLastStats(statsFile + '.1', libAflVersion, stats.nb);
    if (stats.nb === 0) stats.nb = stats_1.nb;
    if (!IsArrayFull(stats.infos, stats.nb)) {
      for (let i=0; i<stats.nb; ++i) {
        if (stats.infos[i] === undefined) stats.infos[i] = stats_1.infos[i]
      }
    }
  }
  if ((stats.nb === 0) || (!IsArrayFull(stats.infos, stats.nb))) {
    console.log(Utils.EndErrorMessage('Error with stats.json'));
    std.exit(1);
  }

  let taskInfo = Utils.ExtractStep(stepUUID, taskFilename);
  let taskInfoError = (typeof taskInfo !== 'object') || (taskInfo?.state === undefined) || 
      (taskInfo?.nb_cores === undefined) || (taskInfo?.attempt_id === undefined);
  if (!taskInfoError) {
    taskInfo = {
        state: taskInfo.state,
        nbCore: taskInfo.nb_cores,
        attemptID: taskInfo.attempt_id
    }
  } else {
    console.log(Utils.EndErrorMessage(
        (typeof taskInfo !== 'object') ? taskInfo : `Missing required fields in ${taskFilename}`));
    std.exit(1);
  }

  console.log(JSON.stringify({
    nb_cores:  taskInfo.nbCore,
    nb_clients: stats.nb,
    execPerSec: stats.infos[0]?.exec_per_sec ?? 0
  }));

  let beginStatsFile = statsFile + '.0';
  if (!Utils.IsFile(beginStatsFile)) {
    beginStatsFile = statsFile
  }
  const firstStats = Utils.GetFirstStats(beginStatsFile, stats.nb);
  if (firstStats.error !== null) {
    console.log(Utils.EndErrorMessage(firstStats.error));
    std.exit(1);
  }

  Utils.PruneZeroFields(firstStats);
  let result = { 
    id: taskInfo.attemptID, 
    state: taskInfo.state, 
    nb_objective_on_disk: nbObjectiveOnDisk, 
    error_file_exist: errorFileExist,
    global: [], 
    clients: [], 
    others: []
  };
  for(let i=0; i<stats.infos.length; ++i) {
    const type = stats.infos[i].type;
    const id = stats.infos[i].id;
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

  const globalObjectiveSize = result.global[0]?.tEnd?.objective_size ?? 0;
  result.state = ((result.state === "Done") && ((globalObjectiveSize > 0) || (nbObjectiveOnDisk > 0))) ? 
      'success' : 'fail';

  const saveRetVal = Utils.SaveFile(outFile, JSON.stringify(result)+'\n');
  if (saveRetVal !== null) {
    console.error(Utils.EndErrorMessage(saveRetVal))
    std.exit(1);
  }

  std.exit(0);
}

Main();
