import { Metrics } from './summary_metrics.js';
import '../third-party/plotly/plotly-3.3.0.min.js';
const Plotly = window.Plotly;

class ManageGraphs {
  #registeredGraphs;
  #timerID;

  constructor() {
    this.#registeredGraphs = new Set();
    this.#timerID = null;
    window.addEventListener('resize', this.#OnResize.bind(this));
  }

  #OnResize(event) {
    if (this.#timerID != null) {
      window.clearTimeout(this.#timerID);
    }
    this.#timerID = window.setTimeout(this.#OnResizeManaged.bind(this, event), 200);
  }

  #OnResizeManaged(event) {
    console.log(event);
    this.#registeredGraphs.forEach(containerID => {
      console.log(containerID, event);
      const container = document.getElementById(containerID);
      const maxSize = container.layout.xaxis.categoryarray.length;
      const highlightIndex = container.dataset?.highlightIndex;
      const range = Metrics.ComputeXRange(maxSize, highlightIndex !== undefined ? Number(highlightIndex) : null);
      Plotly.relayout(containerID, {
          'xaxis.range': range
      });
    })
  }

  RegisterGraph(containerID) {
    this.#registeredGraphs.add(containerID);
  }

  UnregisterAllGraphs() {
    this.#registeredGraphs = new Set();
  }

};

const manageGraphs = new ManageGraphs();

export { manageGraphs };