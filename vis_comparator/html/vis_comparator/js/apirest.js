import { JSONHelp } from './jsonhelp.js';
import { DEFAULT_DELTA_DIVISOR, TASK_TYPES } from './constants.js';

/**
 * REST API client for the analysis server.
 * All methods surface errors via the ErrorManager and return null/false/[] on failure.
 */
class ApiREST {
  #apiURI;
  #errorManager;
  #onLoading;
  // "type/commit" -> latest timestamp, populated by LoadCommits. Lets commit-mode
  // callers omit the timestamp and have it resolved to the newest run.
  #commitLatest = new Map();
  // "type/commit" -> number of runs, populated by LoadCommits. Summed across all
  // loaded types by RunCountSync to drive the commit picker's "×N" badge.
  #commitRunCount = new Map();
  // Session cache of the campaign run list.
  #campaigns = null;

  /**
   * @param {string}   apiURI       - Base API URL, e.g. '/api/PR'
   * @param {ErrorManager} errorManager - Toast notification service
   * @param {function} [onLoading]  - Optional callback(delta: +1|-1, label?: string)
   *   called before/after heavy async fetches to drive a loading indicator.
   */
  constructor(apiURI, errorManager, onLoading = null) {
    this.#apiURI = apiURI;
    this.#errorManager = errorManager;
    this.#onLoading = onLoading;
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
          body: JSONHelp.Stringify(data, 2)
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
   * Persists a template to the server (variables are stored as null).
   * @param {string} name - Template filename (no extension)
   * @param {object} data - Serialisable template state
   * @returns {Promise<boolean>} true on success
   */
  async SaveTemplate(name, data) {
    try {
      const encodedName = encodeURIComponent(name);
      const response = await fetch(`${this.#apiURI}/userdata/templates/${encodedName}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSONHelp.Stringify(data, 2),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      return true;
    } catch (error) {
      this.#errorManager.Error('Failed to save template: ' + error.message);
    }
    return false;
  }

  /**
   * Loads a previously saved template from the server.
   * @param {string} name - Template filename (no extension)
   * @returns {Promise<object|null>} Deserialised template state, or null on failure
   */
  async LoadTemplate(name) {
    this.#onLoading?.(+1, 'Chargement du template…');
    try {
      const encodedName = encodeURIComponent(name);
      const response = await fetch(`${this.#apiURI}/userdata/templates/${encodedName}`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const data = await response.text();
      return JSONHelp.Parse(data);
    } catch (error) {
      this.#errorManager.Error('Failed to load template: ' + error.message);
    } finally {
      this.#onLoading?.(-1);
    }
    return null;
  }

  /**
   * Lists all saved templates on the server.
   * @returns {Promise<{files: string[]}|null>} Object with a `files` array, or null on failure
   */
  async ListTemplates() {
    try {
      const response = await fetch(`${this.#apiURI}/userdata/templates`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      return await response.json();
    } catch (error) {
      this.#errorManager.Error('Failed to list templates: ' + error.message);
    }
    return null;
  }

  /**
   * Lists the variable names of every saved template (per category), without
   * fetching the full template definitions — used to match templates to a URL.
   * @returns {Promise<{templates: Object<string, {commits:string[], subtasks:string[], campaigns:string[], metrics:string[]}>}|null>}
   */
  async ListTemplateVariables() {
    try {
      const response = await fetch(`${this.#apiURI}/userdata/templates-variables`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      return await response.json();
    } catch (error) {
      this.#errorManager.Error('Failed to list template variables: ' + error.message);
    }
    return null;
  }

  /**
   * Deletes a saved template from the server.
   * @param {string} name - Template filename (no extension)
   * @returns {Promise<boolean>} true on success
   */
  async DeleteTemplate(name) {
    try {
      const encodedName = encodeURIComponent(name);
      const response = await fetch(`${this.#apiURI}/userdata/templates/${encodedName}`, {
        method: 'DELETE',
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      return true;
    } catch (error) {
      this.#errorManager.Error('Failed to delete template: ' + error.message);
    }
    return false;
  }

  /**
   * Loads the list of available commit IDs for a given experiment type.
   * @param {string} commitType - Dataset type, e.g. 'Perf' or 'Vuln'
   * @returns {Promise<string[]>} Sorted commit IDs, or [] on failure
   */
  async LoadCommits(commitType) {
    try {
      const response = await fetch(`${this.#apiURI}/commits/${commitType}`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const data = await response.json();
      // Server now returns [{ commit, timestamp }]. Cache the latest timestamp
      // per commit and return the bare commit id list (back-compat for callers).
      const commits = [];
      for (const entry of data.commits ?? []) {
        this.#commitLatest.set(`${commitType}/${entry.commit}`, entry.timestamp);
        if (entry.count != null) {
          this.#commitRunCount.set(`${commitType}/${entry.commit}`, entry.count);
        }
        commits.push(entry.commit);
      }
      return commits;
    } catch (error) {
      this.#errorManager.Error('Failed to load commits: ' + error.message);
    }
    return [];
  }

  /**
   * Synchronous latest-timestamp lookup from the cache populated by LoadCommits
   * (called for all types at startup). Returns null if not cached.
   * @param {string} commitType
   * @param {string} commitID
   * @returns {number|null}
   */
  LatestTimestampSync(commitType, commitID) {
    return this.#commitLatest.get(`${commitType}/${commitID}`) ?? null;
  }

  /**
   * Total number of runs for a commit across all loaded types (Perf + Vuln),
   * from the counts cached by LoadCommits. Drives the commit picker "×N" badge.
   * Returns 0 when the commit is unknown / not yet loaded.
   * @param {string} commitID
   * @returns {number}
   */
  RunCountSync(commitID) {
    let total = 0;
    for (const type of Object.values(TASK_TYPES)) {
      total += this.#commitRunCount.get(`${type}/${commitID}`) ?? 0;
    }
    return total;
  }

  /**
   * Loads every run of a commit across all types (type-agnostic), newest first.
   * Used by the commit picker to list runs when a commit has more than one.
   * @param {string} commitID
   * @returns {Promise<Array<{timestamp: number, type: string}>>} newest-first, or [] on failure
   */
  async LoadRuns(commitID) {
    try {
      const response = await fetch(`${this.#apiURI}/runs/${encodeURIComponent(commitID)}`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const data = await response.json();
      return data.runs ?? [];
    } catch (error) {
      this.#errorManager.Error('Failed to load runs: ' + error.message);
    }
    return [];
  }

  /**
   * Resolves the latest timestamp for a (type, commit) run, fetching the commit
   * list once if not already cached. Returns null when the run is unknown.
   * @param {string} commitType
   * @param {string} commitID
   * @returns {Promise<number|null>}
   */
  async #latestTimestamp(commitType, commitID) {
    const key = `${commitType}/${commitID}`;
    if (!this.#commitLatest.has(key)) {
      await this.LoadCommits(commitType);
    }
    return this.#commitLatest.get(key) ?? null;
  }

  /**
   * Loads the list of campaign runs (one entry per run/zst), cached for the session.
   * @returns {Promise<Array<{type,user,campaign,commit,timestamp,subjects:string[]}>>}
   */
  async LoadCampaigns() {
    if (this.#campaigns) return this.#campaigns;
    try {
      const response = await fetch(`${this.#apiURI}/campaigns`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      this.#campaigns = await response.json();
      return this.#campaigns;
    } catch (error) {
      this.#errorManager.Error('Failed to load campaigns: ' + error.message);
    }
    return [];
  }
  
  /**
   * Loads git commit history from the configured git_history_url proxy.
   * @returns {Promise<object|null>} pesto-calc history object, or null on failure/unavailable
   */
  async LoadGitHistory() {
    try {
      const response = await fetch(`${this.#apiURI}/git/history`);
      if (!response.ok) return null;
      return await response.json();
    } catch (_) {
      return null;
    }
  }

  /**
   * Loads the git-log entry for a single commit via the backend proxy. Used to
   * resolve a feature/PR commit's dev base (the response carries a `base` key).
   * @param {string} commit - Commit hash
   * @returns {Promise<object|null>} git-log object, or null on failure/unavailable
   */
  async LoadGitLog(commit) {
    try {
      const response = await fetch(`${this.#apiURI}/git/log/${encodeURIComponent(commit)}`);
      if (!response.ok) return null;
      return await response.json();
    } catch (_) {
      return null;
    }
  }

  /**
   * Loads the list of test subjects (benchmark names) for a given commit.
   * @param {string} commitType - Dataset type, e.g. 'Perf'
   * @param {string} commitID   - Commit hash
   * @returns {Promise<Array<{value: string, text: string}>>} Subject options, or [] on failure
   */
  async LoadCommitSubjects(commitType, commitID, timestamp) {
    this.#onLoading?.(+1, 'Chargement des subtasks…');
    try {
      const ts = timestamp ?? await this.#latestTimestamp(commitType, commitID);
      // No run of this type for the commit (e.g. a Perf-only commit probed for Vuln):
      // return no subjects rather than erroring.
      if (ts == null) return [];
      const response = await fetch(`${this.#apiURI}/subjects/${commitType}/${commitID}/${ts}`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const data = await response.json();
      return Object.entries(data).map(([subject, count]) => ({
        value: subject,
        text:  `${subject} (${count} runs)`,
      }));
    } catch (error) {
      this.#errorManager.Error('Failed to load commit subjects: ' + error.message);
    } finally {
      this.#onLoading?.(-1);
    }
    return [];
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
  async LoadCommitMetrics(commitType, commitID, commitSubject, timestamp) {
    this.#onLoading?.(+1, 'Chargement des métriques…');
    try {
      const ts = timestamp ?? await this.#latestTimestamp(commitType, commitID);
      if (ts == null) return { metrics: null, maxTimeMicroS: -1 };
      const response = await fetch(
        `${this.#apiURI}/metrics/${commitType}/${commitID}/${ts}/${commitSubject}`
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
      const maxRunTime = data.runs.reduce((m, r) => Math.max(m, r.runTime), -Infinity);
      const maxTimeMicroS = Math.ceil(maxRunTime * 1.01);
      
      return { metrics: metricsFolders, maxTimeMicroS };
    } catch (error) {
      this.#errorManager.Error('Failed to load metrics: ' + error.message);
    } finally {
      this.#onLoading?.(-1);
    }

    return { metrics: null, maxTimeMicroS: -1 };
  }

  /**
   * Probes the actual data extent of the given resolved experiments and derives a
   * fitting time range. Takes the largest extent across all experiments so no series
   * is truncated. Used to recompute a graph's range on template load / experiment change.
   * @param {Array<{tasktype: string, commit: string, subtask: string, timestamp?: number}>} resolvedExps
   * @returns {Promise<{min: number, max: number, delta: number}|null>}
   *   A range derived from real data, or null if the extent is unknown (<= 0).
   */
  async ComputeTimeRange(resolvedExps) {
    if (!resolvedExps || resolvedExps.length === 0) return null;
    const metas = await Promise.all(resolvedExps.map(e =>
      this.LoadCommitMetrics(e.tasktype, e.commit, e.subtask, e.timestamp)));
    const max = metas.reduce((m, r) => Math.max(m, r?.maxTimeMicroS ?? -1), -1);
    if (!(max > 0)) return null;
    const delta = Math.max(1, Math.floor(max / DEFAULT_DELTA_DIVISOR));
    return { min: 0, max, delta };
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
      selectedMetrics, timestamp) {
    this.#onLoading?.(+1, 'Chargement des données…');
    try {
      const ts = timestamp ?? await this.#latestTimestamp(commitType, commitID);
      if (ts == null) return null;
      const url = `${this.#apiURI}/values/${commitType}/${commitID}/${ts}/${commitSubject}/${timeMin}/${timeMax}/${timeStep}`;

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
    } finally {
      this.#onLoading?.(-1);
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