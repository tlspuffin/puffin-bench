import * as Utils from './utils.js';

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

  const stats = Utils.GetLastStats(statsFile, taskInfo.nbCore);
  if (stats.error !== null) {
    console.log(Utils.EndErrorMessage(stats.error));
    std.exit(1);
  }
  if ((stats.nb === 0) || (!Utils.IsClientArrayFull(stats.infos, stats.nb))) {
    const stats_1 = Utils.GetLastStats(statsFile + '.1', stats.nb);
    if (stats.nb === 0) stats.nb = stats_1.nb;
    if (!Utils.IsClientArrayFull(stats.infos, stats.nb)) {
      // every index IsClientArrayFull checks: 0 (global) and the clients 1..nb at index id + 1 (up to nb + 1); the loop
      // stopped at nb, so a client found only in stats.json.1 (after the truncation of stats.json, e.g. a client that
      // stopped reporting) was never taken and the run had no summary ("Error with stats.json")
      for (let i=0; i<(stats.nb+2); ++i) {
        if (stats.infos[i] === undefined) stats.infos[i] = stats_1.infos[i]
      }
    }
  }
  if ((stats.nb === 0) || (!Utils.IsClientArrayFull(stats.infos, stats.nb))) {
    console.log(Utils.EndErrorMessage('Error with stats.json'));
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

  const globalObjectiveSize = result.global[0]?.tEnd?.objective_size ?? 0;
  // job scripts since 2026-10-06 also give the targeted and not targeted objectives (a known CVE found besides the
  // one the experiment looks for, PR_common.sh OBJECTIVES_NOT_TARGETED): success needs a targeted one
  const targeted = Utils.IsNumeric(scriptArgs[8] ?? '') ? Number(scriptArgs[8]) : null;
  const notTargeted = Utils.IsNumeric(scriptArgs[9] ?? '') ? Number(scriptArgs[9]) : 0;
  if (targeted !== null) {
    result.nb_objective_targeted = targeted;
    result.nb_objective_not_targeted = notTargeted;
  }
  // time to find: when the fuzzer saved the first targeted objective (ms since the epoch, its name), from the start of
  // the experiment's stats (as the durations of older results, which end at the last stats: up to a minute later)
  const firstTargetedMs = Utils.IsNumeric(scriptArgs[10] ?? '') ? Number(scriptArgs[10]) : null;
  // the expected bug of the configuration (vuln_targets.json): its CVE, and the objectives of another bug
  if (Utils.IsString(scriptArgs[12] ?? null) && scriptArgs[12] !== '') {
    result.expected_cve = scriptArgs[12];
    result.nb_objective_unexpected = Utils.IsNumeric(scriptArgs[11] ?? '') ? Number(scriptArgs[11]) : 0;
  }
  const start = result.global[0]?.t0?.time?.secs_since_epoch;
  if ((firstTargetedMs !== null) && (typeof start === 'number')) {
    result.first_targeted_objective_ms = firstTargetedMs;
    result.time_to_find_s = Math.max(0, firstTargetedMs / 1000 - start);
    // execs to find: the total execs when the fuzzer saved that objective (not at the end of the run, which comes after
    // the monitor saw it and the fuzzer stopped)
    const execs = Utils.GlobalExecsAt([`${statsFile}.0`, `${statsFile}.1`, statsFile], firstTargetedMs);
    if (execs !== null) result.execs_to_find = execs;
  }
  const found = (targeted !== null) ? (targeted > 0) : ((globalObjectiveSize > 0) || (nbObjectiveOnDisk > 0));
  result.state = ((result.state === "Done") && found) ? 'success' : 'fail';

  const saveRetVal = Utils.SaveFile(outFile, JSON.stringify(result)+'\n');
  if (saveRetVal !== null) {
    console.error(Utils.EndErrorMessage(saveRetVal))
    std.exit(1);
  }

  std.exit(0);
}

Main();
