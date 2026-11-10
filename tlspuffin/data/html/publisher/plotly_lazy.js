// The chart library (plotly, 4.8 MB) loaded on first use, not with the page: imported at startup it held up the
// whole page (downloaded and compiled before any result was fetched). Same calls as Plotly, each one waiting for it.
let loading = null;

export function LoadPlotly() {
  if (window.Plotly) return Promise.resolve(window.Plotly);
  loading ??= import('../third-party/plotly/plotly-3.3.0.min.js').then(() => window.Plotly);
  return loading;
}

export const Plotly = {
  newPlot: (...args) => LoadPlotly().then(P => P.newPlot(...args)),
  relayout: (...args) => LoadPlotly().then(P => P.relayout(...args)),
  toImage: (...args) => LoadPlotly().then(P => P.toImage(...args)),
  // nothing to purge before it is loaded
  purge: (graph) => window.Plotly?.purge(graph),
};
