import { JSONHelp } from './jsonhelp.js';

/**
 * REST API client for the analysis server.
 * All methods surface errors via the ErrorManager and return null/false/[] on failure.
 */
class ApiREST {
  #apiURI;
  #errorManager;

  /**
   * @param {string} apiURI - Base API URL, e.g. '/api/PR'
   * @param {ErrorManager} errorManager - Toast notification service
   */
  constructor(apiURI, errorManager) {
    this.#apiURI = apiURI;
    this.#errorManager = errorManager;
  }

  /**
   * Persists a dashboard view to the server.
   * @param {string} name - View filename (no extension)
   * @param {object} data - Serialisable dashboard state
   * @returns {Promise<boolean>} true on success
   */
  async SavePage(name, data) {
    try {
      const encodedName = encodeURIComponent(name);
      const response = await fetch(`${this.#apiURI}/userdata/${encodedName}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSONHelp.Stringify(data)
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return true;
    } catch (error) {
      this.#errorManager.Error('Failed to save data: ' + error.message);
    }
    return false;
  }

  /**
   * Loads a previously saved dashboard view from the server.
   * @param {string} name - View filename (no extension)
   * @returns {Promise<object|null>} Deserialised state, or null on failure
   */
  async LoadPage(name) {
    try {
      const encodedName = encodeURIComponent(name);
      const response = await fetch(`${this.#apiURI}/userdata/${encodedName}`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.text();
      return JSONHelp.Parse(data);
    } catch (error) {
      this.#errorManager.Error('Failed to load data: ' + error.message);
    }
    return null;
  }

  /**
   * Lists all saved dashboard views on the server.
   * @returns {Promise<{files: string[]}|null>} Object with a `files` array, or null on failure
   */
  async ListPages() {
    try {
      const response = await fetch(`${this.#apiURI}/userdata`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      this.#errorManager.Error('Failed to load data: ' + error.message);
    }
    return null;
  }

  /**
   * Deletes a saved dashboard view from the server.
   * @param {string} name - View filename (no extension)
   * @returns {Promise<boolean>} true on success
   */
  async DeletePage(name) {
    try {
      const encodedName = encodeURIComponent(name);
      const response = await fetch(`${this.#apiURI}/userdata/${encodedName}`, {
        method: 'DELETE'
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      return true;
    } catch (error) {
      this.#errorManager.Error('Failed to delete view: ' + error.message);
    }
    return false;
  }

  /**
   * Loads the list of available commit IDs for a given experiment type.
   * @param {string} commitType - Dataset type, e.g. 'Perf' or 'Vuln'
   * @returns {Promise<string[]>} Sorted commit IDs, or [] on failure
   */
  async LoadCommits(commitType) {
    const commitID = [];
    try {
      const response = await fetch(`${this.#apiURI}/commits/${commitType}`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      
      data.commits.forEach(commit => {
        commitID.push(commit);
      });
    } catch (error) {
      this.#errorManager.Error('Failed to load commits: ' + error.message);
    }
    return commitID;
  }
  
  /**
   * Loads the list of test subjects (benchmark names) for a given commit.
   * @param {string} commitType - Dataset type, e.g. 'Perf'
   * @param {string} commitID   - Commit hash
   * @returns {Promise<Array<{value: string, text: string}>>} Subject options, or [] on failure
   */
  async LoadCommitSubjects(commitType, commitID) {
    const subjects = [];
    try {
      const response = await fetch(`${this.#apiURI}/subjects/${commitType}/${commitID}`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      Object.entries(data).forEach(([subject, count]) => {
        subjects.push({value: subject, text:`${subject} (${count} runs)`});
      });
    } catch (error) {
      this.#errorManager.Error('Failed to load commit subjects: ' + error.message);
    }
    return subjects;
  }
  
  /**
   * Loads the metric tree and maximum run time for a given commit + subject.
   * Only metrics present in ALL runs are included.
   * @param {string} commitType    - Dataset type
   * @param {string} commitID      - Commit hash
   * @param {string} commitSubject - Subject (benchmark name)
   * @returns {Promise<{metrics: Map, maxTimeMicroS: number}>}
   *   metrics — nested Map representing the metric folder tree;
   *   maxTimeMicroS — upper bound of the time axis in microseconds.
   *   Returns {metrics: null, maxTimeMicroS: -1} on failure.
   */
  async LoadCommitMetrics(commitType, commitID, commitSubject) {
    try {
      const response = await fetch(
        `${this.#apiURI}/metrics/${commitType}/${commitID}/${commitSubject}`
      );
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      const metrics = new Map();
      data.runs.forEach(run => {
        run.metrics.forEach(m => {
          metrics.set(m, (metrics.get(m) ?? 0) + 1);
        });
      });
      metrics.forEach((count, key) => {
        if (count < data.runs.length) {
          metrics.delete(key);
        }
      });
      
      const metricsFolders = new Map();
      Array.from(metrics.keys()).sort().forEach(metric => {
        const pathElements = metric.split('.');
        let currentStorage = metricsFolders;
        for(let i=0; i<pathElements.length; ++i) {
          let elementMap = currentStorage.get(pathElements[i]);
          if (elementMap == null) {
            elementMap = new Map();
            currentStorage.set(pathElements[i], elementMap);
          }
          currentStorage = elementMap;
        }
      });
      const maxRunTime = Math.max(...data.runs.map(run => run.runTime));
      const maxTimeMicroS = Math.ceil(maxRunTime * 1.1);
      
      return { metrics: metricsFolders, maxTimeMicroS };
    } catch (error) {
      this.#errorManager.Error('Failed to load metrics: ' + error.message);
    }
    
    return { metrics: null, maxTimeMicroS: -1 };
  }
  
  /**
   * Fetches time-series data for selected metrics from the server.
   * The response uses a custom binary format (see #ParseBinaryResponse).
   * @param {string}   commitType      - Dataset type
   * @param {string}   commitID        - Commit hash
   * @param {string}   commitSubject   - Subject (benchmark name)
   * @param {number}   timeMin         - Start time in microseconds
   * @param {number}   timeMax         - End time in microseconds
   * @param {number}   timeStep        - Time step in microseconds
   * @param {string[]} selectedMetrics - Dot-path metric names to fetch
   * @returns {Promise<{header: object, series: object}|null>}
   *   header — JSON metadata from the binary response;
   *   series — map of metric name to array of run arrays.
   *   Returns null on failure.
   */
  async LoadCommitMetricsValues(commitType, commitID, commitSubject, timeMin, timeMax, timeStep,
      selectedMetrics) {
    try {
      const url = `${this.#apiURI}/values/${commitType}/${commitID}/${commitSubject}/${timeMin}/${timeMax}/${timeStep}`;
        
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          runs: [],
          clients: [],
          metrics: selectedMetrics,
          aggregate: 'sum'
        })
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
        
      const { header, series } = await this.#ParseBinaryResponse(response);
      return { header, series };
    } catch (error) {
      this.#errorManager.Error('Failed to load metrics: ' + error.message);
    }
    return null;
  }

  async #ParseBinaryResponse(response) {
    const buffer = await response.arrayBuffer();
    const view = new DataView(buffer);

    // Binary response format (little-endian):
    //   [8 bytes]  uint64: JSON header byte length
    //   [N bytes]  UTF-8 JSON: { metrics: [...], count: N, runs: [...] }
    //   [padding]  0–7 bytes to reach 8-byte alignment
    //   [data]     series values: Float64 or BigUint64, row-major (metric × run × point)
    const HEADER_SIZE = 8;
    if (buffer.byteLength < HEADER_SIZE) {
      throw new Error('Response too short to contain a binary header');
    }
    const jsonSize = Number(view.getBigUint64(0, true));
    if (jsonSize > 10_000_000 || HEADER_SIZE + jsonSize > buffer.byteLength) {
      throw new Error('Invalid JSON header size in binary response: ' + jsonSize);
    }

    const jsonBytes = new Uint8Array(buffer, HEADER_SIZE, jsonSize);
    const jsonText = new TextDecoder().decode(jsonBytes);
    const header = JSON.parse(jsonText);
  
    let offset = HEADER_SIZE + jsonSize;
    const remain = jsonSize % 8;
    if (remain != 0) {
      offset += 8 - remain;
    }
    const series = {};
  
    for (const metric of header.metrics) {
      const numSeries = metric.count;
      const dataPerSeries = header.count;

      const allData = [];

      for (let i=0; i<numSeries; ++i) {
        let data;
        if (metric.type === 'uint64') {
          const arr = new BigUint64Array(buffer, offset, dataPerSeries);
          data = Array.from(arr, x => Number(x));
          offset += dataPerSeries * 8;
        } else if (metric.type === 'double') {
          const arr = new Float64Array(buffer, offset, dataPerSeries);
          data = Array.from(arr);
          offset += dataPerSeries * 8;
        }
        allData.push(data);
      }

      series[metric.name] = allData;
    }
  
    return { header, series };
  }
    
};

export { ApiREST };