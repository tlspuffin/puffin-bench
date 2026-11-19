class MetricsCampaign {

  static #metricStatusSuccess = '#27ae60';
  static #metricStatusFail =  '#e74c3c';
  static #metricStatusMixed = '#f1c40f';

  static GetMetrics(campaign) {
    const result = { Perf: {} };
    const status = campaign.global_status === 'success' ? MetricsCampaign.#metricStatusSuccess :
        (campaign.global_status === 'fail' ? MetricsCampaign.#metricStatusFail : MetricsCampaign.#metricStatusMixed);
    for (const [libName, metrics] of Object.entries(campaign.metrics ?? {})) {
        const libStatus = campaign.status?.[libName];
        const regularName = (libStatus?.cli?.library?.name ?? libName).toLowerCase();
        result.Perf[regularName] = {};
        const cputs = libStatus?.cli?.cputs === true ? '⚙C' : (libStatus?.cli?.cputs === false ? '🦀' : '❓');
        const commitId = campaign.commit_id;
        for (const [metricName, metricValues] of Object.entries(metrics)) {
            if (!Array.isArray(metricValues) || metricValues.length === 0) continue;
            result.Perf[regularName][metricName] = { commit_id: commitId, values: metricValues.flat(), status, cputs,
                major: libStatus?.major ?? 1 };
        }
    }
    return result;
  }

};

export { MetricsCampaign };