class Metrics {
  static #metricStatusSuccess = '#27ae60';
  static #metricStatusFail =  '#e74c3c';
  static #metricStatusMixed = '#f1c40f';

  static #graphPixelPerCommit = 25;
  static #containerRatioSize = 0.8;

  #commits = null;
  #metricsData = {};  // Structure: { type: { library: { metric: [{ commit_id, values, success }] } } }
  #commitNames = {};

  constructor(availableTypes, commits) {
    this.#commits = commits;
    commits.forEach(commit => {
        availableTypes.forEach(type => {
            if (!this.#commitNames[commit.id]) {
              this.#commitNames[commit.id] = {};
            }
            const typeData = commit.infos?.get(type);
            if (!typeData || !typeData.metrics) return;
            if (!this.#metricsData[type]) {
              this.#metricsData[type] = {};
            }

            const status = (typeData.global_status === 'success' ? 
                Metrics.#metricStatusSuccess : (typeData.global_status === 'fail' ? 
                    Metrics.#metricStatusFail : Metrics.#metricStatusMixed));

            for (const [libName, metrics] of Object.entries(typeData.metrics)) {
              const regularLibName = libName.toLowerCase();
              if (!this.#metricsData[type][regularLibName]) {
                this.#metricsData[type][regularLibName] = {};
              }

              const cputs = typeData?.status[libName]?.cli?.cputs === true ? 
                  '⚙C' : (typeData?.status[libName]?.cli?.cputs === false ? '🦀' : '❓');
              this.#commitNames[commit.id][regularLibName] = cputs;

              for (const [metricName, runsData] of Object.entries(metrics)) {
                if (!Array.isArray(runsData) || runsData.length === 0) continue;
                if (!this.#metricsData[type][regularLibName][metricName]) {
                  this.#metricsData[type][regularLibName][metricName] = [];
                }
                this.#metricsData[type][regularLibName][metricName].push({
                    commit_id: commit.id,
                    values: runsData.flat(),
                    status: metricName.startsWith('fail_') ? Metrics.#metricStatusFail : status,
                    cputs
                });
              }

            }
        });
    });
  }

  GetCommits() {
    return this.#commits;
  }

  HaveCommit(commitID) {
    return this.#commitNames[commitID];
  }

  GetTypes() {
    return Object.keys(this.#metricsData);
  }

  GetValuesForType(type) {
    return this.#metricsData[type];
  }

  GetValuesForSubType(type, library) {
    return this.#metricsData[type]?.[library];
  }

  GetValues(type, library, metric) {
    return this.#metricsData[type]?.[library]?.[metric];
  }

  GetCommitMetrics(commitID) {
    if (!this.#commitNames[commitID]) {
      return {};
    }
    const result = {};
    for (const [typeName, typeData] of Object.entries(this.#metricsData)) {
      result[typeName] = {};
      for (const [libName, libData] of Object.entries(typeData)) {
        result[typeName][libName] = {};
        for (const [valueName, valueData] of Object.entries(libData)) {
          result[typeName][libName][valueName] = 
              valueData.find(entry => entry.commit_id === commitID) ?? null;
        }
      }
    }
    return result;
  }

  static ComputeXRange(categoryLength, highlightIndex) {
    const nbElementOnScreen = (window.innerWidth * Metrics.#containerRatioSize) / Metrics.#graphPixelPerCommit;
    const windowNbElementWidth = nbElementOnScreen + 1;
    const range = [-0.5, nbElementOnScreen + 0.5];
    if (categoryLength > windowNbElementWidth) {
      range[1] = categoryLength + 0.5
      range[0] = range[1] - windowNbElementWidth;
    }
    if (highlightIndex != null) {
      if (highlightIndex < range[0]) {
        range[1] = highlightIndex + (windowNbElementWidth / 2);
        range[0] = range[1] - windowNbElementWidth;
      }
    }
    if (range[0] < -0.5) {
      range[1] = windowNbElementWidth - 0.5;
      range[0] = -0.5;
    }
    return range;
  }

};

export { Metrics };
