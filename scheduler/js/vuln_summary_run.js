import * as Utils from './utils.js';

function BuildSummary(commitID, timestamp, type, artefactsPath, outPath) {
  const result = {
    version: 1,
    type,
    commit_id: commitID,
    timestamp,
    libraries: {}
  };

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
        data: []
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

  return result;
}

function Main() {
  if (scriptArgs.length < 7) {
    console.log(Utils.EndErrorMessage('Not enough arguments'));
    std.exit(1);
  }

  const commitID = scriptArgs[1];
  let timestamp = scriptArgs[2];
  const type = scriptArgs[3];
  const artefactsPath = scriptArgs[4];
  const outPath = scriptArgs[5];
  const outFile = scriptArgs[6];

  if (!Utils.IsString(commitID)) {
    console.log(Utils.EndErrorMessage('Arguments 1 should be a commitID'));
    std.exit(1);
  }
  if (!Utils.IsNumeric(timestamp)) {
    console.log(Utils.EndErrorMessage('Arguments 2 should be a timestamp'));
    std.exit(1);
  }
  timestamp = Number(timestamp);
  if (!Utils.IsString(type)) {
    console.log(Utils.EndErrorMessage('Arguments 3 should be type'));
    std.exit(1);
  }
  if (!Utils.IsDir(artefactsPath)) {
    console.log(Utils.EndErrorMessage('Arguments 4 should be path to artefacts'));
    std.exit(1);
  }
  if (!Utils.IsDir(outPath)) {
    console.log(Utils.EndErrorMessage('Arguments 5 should be path to job out data'));
    std.exit(1);
  }
  if (!Utils.IsString(outFile)) {
    console.log(Utils.EndErrorMessage('Arguments 6 should be out file'));
    std.exit(1);
  }

  const summary = BuildSummary(commitID, timestamp, type, artefactsPath, outPath);
  if (summary === false) {
    console.error(Utils.EndErrorMessage('BuildSummary failed'))
    std.exit(1);
  }

  const saveRetVal = Utils.SaveFile(outFile, JSON.stringify(summary)+'\n');
  if (saveRetVal !== null) {
    console.error(Utils.EndErrorMessage(saveRetVal))
    std.exit(1);
  }
  std.exit(0);
}
Main();
