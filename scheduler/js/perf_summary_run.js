import * as Utils from './utils.js';

function BuildSummary(result, artefactsPath, outPath) {
  result.libraries = {};
  result.flag_objective = false;

  const [content, errno] = os.readdir(artefactsPath);
  if (errno != 0) {
    console.error(`Unable to read dir ${artefactsPath}, errno = ${errno}`);
    return false;
  }
  const libraries = content.filter((file) => {
      if ((file === '.') || (file === '..')) return false;
      const [status, errno] = os.stat(`${artefactsPath}/${file}`);
      if (errno != 0) {
        console.error(`Unable to access status of ${artefactsPath}/${file}, errno = ${errno}`);
        return false;
      }
      return (status.mode & os.S_IFMT) === os.S_IFDIR;
  });

  libraries.forEach((library => {
      const readJSONError = {};
      const libResult = {
        name: library,
        cli: Utils.ReadJSON(`${outPath}/cli-${library}.json`, readJSONError) ?? readJSONError,
        trust_objective: 1,
        data: [],
        flag_objective: false
      };
      if ((libResult.cli?.library?.name === 'wolfssl') && (Number(libResult.cli?.library?.version ?? 541) <= 540)) {
        libResult.trust_objective = -1
      }

      const [content, errno] = os.readdir(`${artefactsPath}/${library}`);
      if (errno != 0) {
        libResult.error = `Unable to read dir ${artefactsPath}/${library}, errno = ${errno}`;
        console.error(libResult.error);
        result.libraries[library] = libResult;
        return;
      }
      const attemps = content.filter(file => file.endsWith('.json')).sort((a, b) => parseInt(a) - parseInt(b));
      attemps.forEach((file) => {
          const readJSONError = {};
          const json = Utils.ReadJSON(`${outPath}/summary-${library}-${parseInt(file)}.json`, readJSONError);
          if (json !== null) {
            if ((libResult.trust_objective === 1) && (!libResult.flag_objective) &&  
                ((json?.global?.tEnd?.objective_size !== undefined) && (json.global.tEnd.objective_size > 0) || 
                (json?.clients?.some((item => (item?.tEnd?.objective_size !== undefined) && (item.tEnd.objective_size > 0)))))) {
              libResult.flag_objective = true;
            }
            libResult.data.push(json);
          } else {
            readJSONError.id = parseInt(file);
            libResult.data.push(readJSONError);
          }
          
      });
      result.libraries[library] = libResult;
  }));
  result.flag_objective = Object.keys(result.libraries).some((library) => result.libraries[library].flag_objective)

  return result;
}

function Main() {
  if (scriptArgs.length < 9) {
    console.log(Utils.EndErrorMessage('Not enough arguments'));
    std.exit(2);
  }

  const commitID = scriptArgs[1];
  const user = scriptArgs[2];
  let timestamp = scriptArgs[3];
  const type = scriptArgs[4];
  const campaignID = scriptArgs[5];

  const artefactsPath = scriptArgs[6];
  const outPath = scriptArgs[7];
  const outFile = scriptArgs[8];

  if (!Utils.IsString(commitID)) {
    console.log(Utils.EndErrorMessage('Arguments 1 should be a commitID'));
    std.exit(2);
  }
  if (!Utils.IsString(user)) {
    console.log(Utils.EndErrorMessage('Arguments 2 should be a user'));
    std.exit(2);
  }
  if (!Utils.IsNumeric(timestamp)) {
    console.log(Utils.EndErrorMessage('Arguments 3 should be a timestamp'));
    std.exit(2);
  }
  timestamp = Number(timestamp);
  if (!Utils.IsString(type)) {
    console.log(Utils.EndErrorMessage('Arguments 4 should be type'));
    std.exit(2);
  }
  if (!Utils.IsString(campaignID)) {
    console.log(Utils.EndErrorMessage('Arguments 5 should be a campaignID'));
    std.exit(2);
  }
  if (!Utils.IsDir(artefactsPath)) {
    console.log(Utils.EndErrorMessage('Arguments 6 should be path to artefacts'));
    std.exit(2);
  }
  if (!Utils.IsDir(outPath)) {
    console.log(Utils.EndErrorMessage('Arguments 7 should be path to job out data'));
    std.exit(2);
  }
  if (!Utils.IsString(outFile)) {
    console.log(Utils.EndErrorMessage('Arguments 8 should be out file'));
    std.exit(2);
  }

  let summary = {
    version: 1,
    user,
    type,
    commit_id: commitID,
    timestamp,
  };
  if (type === 'campaign') {
    summary.campaign_id = campaignID;
  }
  summary = BuildSummary(summary, artefactsPath, outPath);
  if (summary === false) {
    console.error(Utils.EndErrorMessage('BuildSummary failed'))
    std.exit(2);
  }

  const saveRetVal = Utils.SaveFile(outFile, JSON.stringify(summary)+'\n');
  if (saveRetVal !== null) {
    console.error(Utils.EndErrorMessage(saveRetVal))
    std.exit(2);
  }
  std.exit((summary?.flag_objective ?? false) ? 0 : 1);
}
Main();
