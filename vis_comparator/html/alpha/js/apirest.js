import { JSONHelp } from './jsonhelp.js';

class ApiREST {
  #apiURI;
  #errorManager;
  
  constructor(apiURI, errorManager) {
    this.#apiURI = apiURI;
    this.#errorManager = errorManager;
  }
  
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

    const jsonSize = Number(view.getBigUint64(0, true));
  
    const jsonBytes = new Uint8Array(buffer, 8, jsonSize);
    const jsonText = new TextDecoder().decode(jsonBytes);
    const header = JSON.parse(jsonText);
  
    let offset = 8 + jsonSize;
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