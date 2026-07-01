class MetricsCampaign {

  static #metricStatusSuccess = '#27ae60';
  static #metricStatusFail =  '#e74c3c';
  static #metricStatusMixed = '#f1c40f';

  static GetMetrics(campaign) {
    const result = { Perf: {} };
    const status = campaign.global_status === 'success' ? MetricsCampaign.#metricStatusSuccess :
        (campaign.global_status === 'fail' ? MetricsCampaign.#metricStatusFail : MetricsCampaign.#metricStatusMixed);
    for (const [libName, libData] of Object.entries(campaign.libs ?? {})) {
        const name = libData?.library ?? libName;

        const regularName = name.toLowerCase();
        result.Perf[regularName] = {};
        const cputs = libData?.cputs == 1 ? '⚙C' : (libData?.cputs == -1 ? '🦀' : '❓');
        const commitId = campaign.commit_id;
        for (const [metricName, metricValues] of Object.entries(libData)) {
            if (!Array.isArray(metricValues) || !metricValues.length || 
                typeof metricValues[0] !== 'number') continue;
            result.Perf[regularName][metricName] = { commit_id: commitId, values: metricValues, status, cputs };
        }
    }
    return result;
  }

};

export { MetricsCampaign };