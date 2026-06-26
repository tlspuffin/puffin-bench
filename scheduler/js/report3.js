import * as Utils from './utils.js';

function ExtractCli(summaryFile, outPath) {
  const readJSONError = {};
  const summary = Utils.ReadJSON(summaryFile, readJSONError);
  if (summary === null) {
    console.error(readJSONError.error);
  }
  if (summary?.libraries === undefined) {
    console.error(`No library record in ${summaryFile}`)
    return;
  }
  summary.libraries.forEach((library) => {
    if (library?.name === undefined) {
      console.error(`No name in library record: ${JSON.stringify(library)}`)
      return;
    }
    let buffer = '{}\n'
    if (library?.cli !== undefined) {
      buffer = JSON.stringify(library.cli) + '\n';
    }
    const saveRetVal = Utils.SaveFile(`${outPath}/cli-${library.name}.json`, buffer);
    if (saveRetVal !== null) {
      console.error(`Error while saving ${outPath}/cli-${library.name}.json: ${saveRetVal}`);
    }
  });
}

function Main() {
  if (scriptArgs.length < 2) {
    console.log(Utils.EndErrorMessage('Not enough arguments'));
    std.exit(1);
  }

  const summaryFile = scriptArgs[1];
  const outPath = scriptArgs[2];

  if (!Utils.IsFile(summaryFile)) {
    console.log(Utils.EndErrorMessage('Arguments 1 should be path to a summary file'));
    std.exit(1);
  }
  if (!Utils.IsString(outPath)) {
    console.log(Utils.EndErrorMessage('Arguments 2 should be path to job out data'));
    std.exit(1);
  }

  ExtractCli(summaryFile, outPath);
  std.exit(0);
}
Main();