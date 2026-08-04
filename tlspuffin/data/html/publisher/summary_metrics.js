class Metrics {
  static #metricStatusSuccess = '#27ae60';
  static #metricStatusFail =  '#e74c3c';
  static #metricStatusMixed = '#f1c40f';

  static #graphPixelPerCommit = 25;
  static #containerRatioSize = 0.8;

  static #minVisibleSlots = 6;

  static #tTable95 = {
    1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365, 8: 2.306,
    9: 2.262, 10: 2.228, 11: 2.201, 12: 2.179, 13: 2.160, 14: 2.145, 15: 2.131,
    16: 2.120, 17: 2.110, 18: 2.101, 19: 2.093, 20: 2.086, 21: 2.080, 22: 2.074,
    23: 2.069, 24: 2.064, 25: 2.060, 26: 2.056, 27: 2.052, 28: 2.048, 29: 2.045,
    30: 2.042, 40: 2.021, 50: 2.009, 60: 2.000, 80: 1.990, 100: 1.984, 120: 1.980
  };

  static #StudentT95(df) {
    if (df < 1) return null;
    if (df <= 30) return Metrics.#tTable95[df];
    for (const step of [ 120, 100, 80, 60, 50, 40, 30 ]) {
      if (df >= step) return Metrics.#tTable95[step];
    }
    return 1.960;
  }

  static ComputeCI(values) {
    const sample = values.filter(Number.isFinite);
    const n = sample.length;
    if (n < 2) return null;
    const mean = sample.reduce((acc, value) => acc + value, 0) / n;
    const variance = sample.reduce((acc, value) => acc + ((value - mean) ** 2), 0) / (n - 1);
    return { mean, half: Metrics.#StudentT95(n - 1) * Math.sqrt(variance / n), n };
  }

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

  GetCommit(commitID) {
    return this.#commits.find(commit => commit.id === commitID) ?? null;
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

    if (categoryLength <= windowNbElementWidth) {
      const span = Math.max(categoryLength, Metrics.#minVisibleSlots);
      const center = (categoryLength - 1) / 2;
      return [center - (span / 2), center + (span / 2)];
    }

    const range = [categoryLength + 0.5 - windowNbElementWidth, categoryLength + 0.5];
    if ((highlightIndex != null) && (highlightIndex < range[0])) {
      range[1] = highlightIndex + (windowNbElementWidth / 2);
      range[0] = range[1] - windowNbElementWidth;
    }
    if (range[0] < -0.5) {
      range[1] = windowNbElementWidth - 0.5;
      range[0] = -0.5;
    }
    return range;
  }

};

export { Metrics };
