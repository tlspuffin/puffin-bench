import * as Utils from './utils.js';

const TAIL_SIZE = 65536; // 64K, same window as the previous `tail -c 64K` pipeline

function Main() {
  if (scriptArgs.length < 2) {
    std.exit(1);
  }

  const statsFile = scriptArgs[1];
  if (!Utils.IsFile(statsFile)) {
    std.exit(0);
  }

  const errorObj = { errno: 0 };
  const statFile = std.open(statsFile, "r", errorObj);
  if (statFile === null) {
    std.exit(0);
  }

  errorObj.errno = statFile.seek(0, std.SEEK_END);
  if (errorObj.errno != 0) {
    statFile.close();
    std.exit(0);
  }
  const size = statFile.tell();
  const readSize = Math.min(TAIL_SIZE, size);

  errorObj.errno = statFile.seek(size - readSize, std.SEEK_SET);
  if (errorObj.errno != 0) {
    statFile.close();
    std.exit(0);
  }
  const buffer = statFile.readAsString(readSize);
  statFile.close();

  const lines = Utils.SplitObjects(buffer);

  const lineIndex = lines.length - 1;
  let infos = null;
  try {
    infos = JSON.parse(lines[lineIndex]);
  } catch(e) {
    try {
       infos = JSON.parse(lines[lineIndex - 1]);
    } catch(e0) {
      std.exit(0);
    }
  }

  lines.pop();
  const lastLine = lines[lines.length - 1];
  if (lastLine === undefined) {
    std.exit(0);
  }

  try {
    const infos = JSON.parse(lastLine);
    const secsSinceEpoch = infos?.time?.secs_since_epoch;
    if (secsSinceEpoch !== undefined) {
      console.log(secsSinceEpoch);
    }
  } catch (e) {
    // not a complete JSON object, print nothing
  }

  std.exit(0);
}

Main();
