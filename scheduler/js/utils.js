export function LogObject(object, sep ="") {
  let result = '';
  Object.keys(object).forEach(key => {
    if (object[key] === null) {
      result += `${sep}${key}: null\n`;
    } else if (object[key] === undefined) {
      result += `${sep}${key}: undefined\n`;
    }
    else if (typeof object[key] === 'object') {
      if (Array.isArray(object[key])) {
        result += `${sep}${key}: [\n${LogObject(object[key], sep+"  ")}${sep}]\n`;
      } else {
        result += `${sep}${key}: {\n${LogObject(object[key], sep+"  ")}${sep}}\n`;
      }
    } else {
      result += `${sep}${key}: ${object[key]}\n`;
    }
    //result += `${sep}${key}: ${object[key]}\n`;
  });
  return result;
}

export function PruneZeroFields(object) {
  Object.keys(object).forEach(key => {
    if (typeof object[key] === 'object') {
      if ((object[key] === null) || ((object[key] === undefined))) {
        return 1;
      }
      if (Array.isArray(object[key])) {
        if (!object[key].reduce((accumulator, item) => {
          if (typeof item === 'object') {
            return (PruneZeroFields(item) !== 0) || accumulator;
          }
          return ((item !== 0) && (item !== "0")) || accumulator;
        }, false)) {
          delete object[key];
        }
      } else {
        const size = PruneZeroFields(object[key]);
        if (size === 0) {
          delete object[key];    
        }
      }
    } else  if ((object[key] === 0) || (object[key] === "0")) {
      delete object[key];
    }
  });
  return Object.keys(object).length;
}

export function CompareVersionLesser(vRef, v0) {
  const aRef = vRef.split('.').map(Number);
  const a0 = v0.split('.').map(Number);
  const len = Math.max(aRef.length, a0.length);
  for (let i=0; i<len; ++i) {
    const valRef = aRef[i] ?? 0;
    const val0 = a0[i] ?? 0;
    if (val0 != valRef) {
      return val0 < valRef;
    }
  }
  return false;
}

export function ReadJSON(file, errorObj ={ errno: 0 }) {
  const fileObj = std.open(file, "r", errorObj);
  if (fileObj === null) {
    errorObj.error = `error accessing ${file}`;
    return null;
  }
  const fileBuffer = fileObj.readAsString();
  if (fileBuffer === "") {
    fileObj.close();
    errorObj.error = `error reading ${file}`;
    return null;
  }
  fileObj.close();
  try {
    return JSON.parse(fileBuffer);
  } catch(e) {
    errorObj.error = `error parsing ${file}`;
    return null;
  }
}

export function SaveFile(outFile, buffer) {
  const errorObj = { errno: 0 };
  const outFileObj = std.open(outFile, "w", errorObj);
  if (outFileObj === null) {
    return `Unable to create file ${outFile}, errno = ${errorObj.errno}`;
  }
  const writeSize = outFileObj.write(buffer);
  if (writeSize !== buffer.length) {
    outFileObj.close();
    return `Unable to write in file ${outFile}`;
  }
  const closeResult = outFileObj.close();
  if (closeResult != 0) {
    return `Unable to close file ${outFile}, errno = ${closeResult}`;
  }
  return null;
}

export function IsNumeric(value) {
  if (typeof value === 'number') return !Number.isNaN(value);
  if (typeof value === 'string') return value.trim() !== '' && !Number.isNaN(Number(value));
  return false;
}

export function IsString(value) {
  return typeof value === 'string' || value instanceof String;
}

export function IsFile(value) {
  if (!IsString(value)) {
    return false;
  }
  const [info, error] = os.stat(value);
  return ((info?.mode ?? 0) & os.S_IFMT) === os.S_IFREG;
}

export function IsDir(value) {
  if (!IsString(value)) {
    return false;
  }
  const [info, error] = os.stat(value);
  return ((info?.mode ?? 0) & os.S_IFMT) === os.S_IFDIR;
}

export function EndErrorMessage(message) {
  return JSON.stringify({
    args: [...scriptArgs], 
    error: message
  });
}

export function ExtractStep(stepUUID, taskFilename) {
  if (stepUUID === -1) {
    return 'step uuid unknown'
  }
  const errorObj = { errno: 0 };
  const taskFile = std.open(taskFilename, "r", errorObj);
  if (taskFile === null) {
    return `error accessing ${taskFilename}, errno: ${errorObj.errno}`;
  }
  const taskBuffer = taskFile.readAsString();
  if (taskBuffer === "") {
    taskFile.close();
    return `error reading ${taskFilename}`;
  }
  taskFile.close();
  try {
    const task = JSON.parse(taskBuffer);
    if (typeof task?.task?.steps !== 'object') {
      return `error in ${taskFilename}, no steps array`;
    }
    const step = Object.keys(task?.task?.steps).find((key) => task.task.steps[key]?.uuid === stepUUID);
    if (step === undefined) {
      return `no step ${stepUUID} in task ${taskFilename}`;
    }
    return task.task.steps[step];

  } catch(e) {
    return `error parsing ${taskFilename}`
  }
}

export function SplitObjects(buffer) {
  const lines = [];
  let start = 0;
  let idx;
  while ((idx = buffer.indexOf('}{', start)) !== -1) {
    lines.push(buffer.substring(start, idx + 1));
    start = idx + 1;
  }
  lines.push(buffer.substring(start));
  return lines;
}

const CHUNK_SIZE = 131072;

export function GetLastStats(file, libAflVersion, clientsNb =0) {
  let clients = { error: null, nb: clientsNb, infos: [] };
  let errorObj = { errno: 0 };

  const statFile = std.open(file, "r", errorObj);
  if (statFile === null) {
    clients.error = `Unable to open ${file}, errno = ${errorObj.errno}`;
    return clients;
  }

  errorObj.errno = statFile.seek(0, std.SEEK_END);
  if (errorObj.errno != 0) {
    statFile.close();
    clients.error = `Seek at end of ${file} returned ${errorObj.errno}`;
    return clients;
  }
  const size = statFile.tell();

  const oldAflBehaviour = CompareVersionLesser("0.12.0", libAflVersion);

  let standardLine = false;
  let retval = 0;
  let currentFilePtr = size;
  let buffer = "";
  let previousBuffer = "";
  do {
    const readSize = Math.min(CHUNK_SIZE, currentFilePtr);
    currentFilePtr -= readSize;

    errorObj.errno = statFile.seek(currentFilePtr, std.SEEK_SET);
    if (errorObj.errno != 0) {
      statFile.close();
      clients.error = `Seek at offset ${currentFilePtr} of ${file} returned ${errorObj.errno}`;
      return clients;
    }

    buffer = statFile.readAsString(readSize);
    if (buffer === "") {
      statFile.close();
      clients.error = `Unable to read ${readSize} bytes from offset ${currentFilePtr} of ${file}`;
      return clients;
    }
    buffer += previousBuffer;

    const lines = SplitObjects(buffer);

    previousBuffer = "";
    for(let i = (lines.length - 1); i>=0; --i) {
      try {

        let type = null;
        let id = null;
        if (i == 0) {
          const infos = JSON.parse(lines[i]);
          type = infos.type;
          id = infos.id;
        } else {
          if (lines[i].indexOf('"type":"client"') !== -1) {
            type = 'client';
            const idIdx = lines[i].indexOf('"id":');
            id = idIdx !== -1 ? parseInt(lines[i].substring(idIdx + 5)) : undefined;
            if (id === undefined) {
              continue;
            }
          } else if (lines[i].indexOf('"type":"global"') !== -1) {
            type = 'global';
            id = 0;
          } else {
            if ((lines[i][0] == '{') && (lines[i][lines[i].length - 1] == '}') && (JSON.parse(lines[i]))) {
              continue;
            } else {
              throw 'not a json object'
            }
          }
        }

        if (!(clients.infos[id])) {
          clients.infos[id] = JSON.parse(lines[i]);
          if (id === 0) {
            if (clients.infos[id]?.clients !== undefined) {
              clients.nb = clients.infos[id].clients + (oldAflBehaviour ? 0 : 1);
            }
          }

          if ((clients.nb > 0) && (clients.infos.length == clients.nb)) {
            let stop = true;
            for (let j=0; j<clients.infos.length; ++j) {
              if (clients.infos[j] === undefined) {
                stop = false;
                break;
              }
            }
            if (stop) {
              statFile.close();
              return clients;
            }
          }

        }
      } catch(e) {
        if (i === 0) {
          previousBuffer = lines[0];
        } else if ((standardLine) || (i != lines.length - 1)) {
          statFile.close();
          clients.error = `JSON parse failed for '${lines[i]}'. offset: ${currentFilePtr} / ${i} / ${lines[i].length} (${e})`;
          return clients;
        }
      }
      standardLine = true;
    }

  } while(currentFilePtr > 0)

  statFile.close();
  return clients;
}

export function GetFirstStats(file, nbClients) {
  let clients = { error: null, nb: nbClients, infos: [] };
  let errorObj = { errno: 0 };

  const statFile = std.open(file, "r", errorObj);
  if (statFile === null) {
    clients.error = `Unable to open ${file}, errno = ${errorObj.errno}`;
    return clients;
  }

  errorObj.errno = statFile.seek(0, std.SEEK_END);
  if (errorObj.errno != 0) {
    statFile.close();
    clients.error = `Seek at end of ${file} returned ${errorObj.errno}`;
    return clients;
  }
  const size = statFile.tell();
  errorObj.errno = statFile.seek(0, std.SEEK_SET);
  if (errorObj.errno != 0) {
    statFile.close();
    clients.error = `Seek at start of ${file} returned ${errorObj.errno}`;
    return clients;
  }

  let standardLine = false;
  let retval = 0;
  let currentFilePtr = 0;
  let buffer = "";
  let previousBuffer = "";
  do {
    const readSize = Math.min(CHUNK_SIZE, size - currentFilePtr);
    currentFilePtr += readSize;

    buffer = statFile.readAsString(readSize);
    if (buffer === "") {
      statFile.close();
      clients.error = `Unable to read ${readSize} bytes from offset ${currentFilePtr} of ${file}`;
      return clients;
    }
    buffer = previousBuffer + buffer;
    previousBuffer = "";

    const lines = SplitObjects(buffer);

    for(let i=0; i<lines.length; ++i) {
      try {

        let type = null;
        let id = null;
        if (i == (lines.length - 1)) {
          const infos = JSON.parse(lines[i]);
          type = infos.type;
          id = infos.id;
        } else {
          if (lines[i].indexOf('"type":"client"') !== -1) {
            type = 'client';
            const idIdx = lines[i].indexOf('"id":');
            id = idIdx !== -1 ? parseInt(lines[i].substring(idIdx + 5)) : undefined;
            if (id === undefined) {
              continue;
            }
          } else if (lines[i].indexOf('"type":"global"') !== -1) {
            type = 'global';
            id = 0;
          } else {
            if ((lines[i][0] == '{') && (lines[i][lines[i].length - 1] == '}') && (JSON.parse(lines[i]))) {
              continue;
            } else {
              throw 'not a json object'
            }
          }
        }

        if (!(clients.infos[id])) {
          clients.infos[id] = JSON.parse(lines[i]);

          if ((clients.nb > 0) && (clients.infos.length == clients.nb)) {
            let stop = true;
            for (let j=0; j<clients.infos.length; ++j) {
              if (clients.infos[j] === undefined) {
                stop = false;
                break;
              }
            }
            if (stop) {
              statFile.close();
              return clients;
            }
          }

        }
      } catch(e) {
        if (i === (lines.length - 1)) {
          previousBuffer = lines[i];
        } else if ((standardLine) || (i != 0)) {
          statFile.close();
          clients.error = `JSON parse failed for '${lines[i]}'. offset: ${currentFilePtr} / ${i} / ${lines[i].length} (${e})`;
          return clients;
        }
      }
      standardLine = true;
    }

  } while(currentFilePtr < size)

  statFile.close();
  return clients;
}
