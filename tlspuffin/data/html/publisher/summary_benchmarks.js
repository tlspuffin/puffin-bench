// Custom Vuln benchmarks on Results: their experiments are named <benchmark>_<bug> (the launcher, custombench.js:
// benchmark names are letters, digits and -; VulnA and VulnB name theirs after the bug alone). Their rows come after the
// others, one block per benchmark under a header (summary_render.js).

// the benchmark of an experiment of the Vuln table ('' for VulnA, VulnB, and every other type)
export function BenchmarkOf(type, name) {
  if (type !== 'Vuln') return '';
  const match = /^([A-Za-z0-9-]+)_(.+)$/.exec(name ?? '');
  return match ? match[1] : '';
}

// the row label of an experiment: the bug alone in its benchmark's block
export function ExperimentLabel(type, name) {
  const benchmark = BenchmarkOf(type, name);
  return benchmark ? name.slice(benchmark.length + 1) : name;
}

// [name, metrics] entries in table order: the plain ones first, then each benchmark's, by name
export function OrderLibraries(type, entries) {
  return [...entries].sort((a, b) => BenchmarkOf(type, a[0]).localeCompare(BenchmarkOf(type, b[0])) || a[0].localeCompare(b[0]));
}
