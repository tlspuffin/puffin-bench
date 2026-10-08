// Guide of the bench, shown by the help panel of the navigation bar (nav.js, tab "puffin-bench guide").
// Each page documents itself in its own <template id="help-panel"> (tab "This page").
export const benchGuide = `
<h2>What puffin-bench is</h2>
<p>A test bench for the <b>tlspuffin</b> fuzzer (and <b>sshpuffin</b>): it builds a given commit of the fuzzer,
runs experiments on it (performance measurements, searches for known vulnerabilities, long campaigns) on reserved
CPU cores, publishes the results per commit, and compares commits with each other. Results of different commits
are made comparable by the <i>compat rules</i> (see below).</p>

<h2>The pages (top bar)</h2>
<table>
  <tr><th>Page</th><th>What for</th></tr>
  <tr><td>🗓️ Scheduler</td><td>Tasks running or waiting, their steps and attempts, the load of the machine.
    <b>+</b> (bottom right) launches a new task. A click on a task title opens its own page.</td></tr>
  <tr><td>🗂️ Results</td><td>Results of every commit, one card per commit (Perf on the left, Vuln on the right):
    runs, metrics, builds, objectives found, and the change of each metric against the nearest ancestor with results
    (coloured when significant). “no Perf run” launches it. Tabs: Dev/Main, PR, Branches, Others, Campaigns.
    📊 Overview and 📈 Metrics plot a metric over the commits.</td></tr>
  <tr><td>🔬 Analyzer</td><td>Detailed comparison of runs: metrics over time, several commits or campaigns side by side.</td></tr>
  <tr><td>📰 History</td><td>Every finished task (done or cancelled) of every user, by day, with search and filters
    (package, users, types, states, objectives);
    a click opens its details (times, core-hours, arguments, configurations, relaunch).</td></tr>
  <tr><td>🐞 Objectives</td><td>Opened from a 🐞 button: the objectives of a task grouped by bug, with the reports and
    traces. While the task runs, the <i>live</i> page is updated every few minutes.</td></tr>
  <tr><td>🕘 Runs of a commit</td><td>Opened from <b>🕘 N runs</b> (Results, task page): every task of a commit and type,
    the puffin-bench version of each, what changed between two of them, charts.</td></tr>
  <tr><td>🎯 Bugs reference</td><td><a href="http://localhost:10083/html/publisher/bugs.html" target="_blank">/html/publisher/bugs.html</a>: the
    expected bug of each Vuln configuration and the CVEs set apart (from the one file to edit,
    <code>vuln_targets.json</code>), and the bugs found so far per library (🚨 new bugs).</td></tr>
</table>
<p>The <b>package</b> selector chooses the fuzzer shown by Results and Analyzer. The short hash after
<b>puffin-bench</b> is the deployed version of the bench (link to the commit). <b>🔄</b> refreshes the page,
<b>❔</b> or <kbd>?</kbd> opens this help, <kbd>Esc</kbd> closes it. Links between the pages keep the address you typed
(alias, SSH tunnel, localhost).</p>

<h2>Keyboard</h2>
<ul>
  <li><b>Cmd/Ctrl+R</b>: 🔄 of the page (its own refresh); in the logs window, refresh the logs. <b>Shift+Cmd/Ctrl+R</b>: the browser's reload.</li>
  <li><b>Esc</b>: close the topmost popup (help, logs, launcher, then a drawer or unfolded panels).</li>
  <li><b>g</b> then <b>s</b> / <b>r</b> / <b>a</b> / <b>h</b>: Scheduler, Results, Analyzer, History.</li>
  <li><b>?</b>: this help.</li>
</ul>

<h2>Typical workflow</h2>
<ol>
  <li><b>Launch</b>: Scheduler → <b>+</b> → tlspuffin → a job type → a commit (a PR, a branch tip, or any sha) → Launch.
    Or from Results (“no Perf run”), or ↻ Relaunch as template on a task page.
    A task name like <code>Perf@5c588a</code> is proposed; a custom name keeps the commit in the task description.</li>
  <li><b>Wait</b>: the task is <i>scheduled</i> (estimated start shown), then <i>waits for cores</i>, then <i>runs</i>.
    Its card shows each step, its attempts, a summary of the monitor (execs, corpus, objectives) and the estimated end.</li>
  <li><b>Read the results</b>: once finished, the task appears in History and its results on the Results card of its commit.
    Objectives found are replayed and grouped by bug: 🐞 opens the report.</li>
  <li><b>Compare</b>: Results → 📊 Overview / 📈 Metrics, or 🔬 Analyzer, to see a metric across commits.</li>
</ol>

<h2>Job types (tlspuffin)</h2>
<table>
  <tr><th>Type</th><th>What it does</th><th>Success</th></tr>
  <tr><td>Perf</td><td>Fuzzes each library (BoringSSL, LibreSSL, OpenSSL, WolfSSL, with ASAN) for a fixed time
    (70 min), 5 runs each; measures coverage, corpus size, executions, objectives.</td>
    <td>the run lasts the full time</td></tr>
  <tr><td>Vuln group A</td><td>Searches five known WolfSSL vulnerabilities (BUF, CDOS, HEAP, SDOS2, SKIP), 5 runs of up to
    190 min each; a run stops when it finds the CVE of its configuration (other objectives are kept, CVE-2024-5814 is
    set apart on wolfSSL &lt; 5.7.2 only). Measured: execs and time to find.</td><td>the expected CVE is found</td></tr>
  <tr><td>Vuln group B</td><td>Two harder cases (SDOS1 on OpenSSL 1.1.1j, SIG on WolfSSL), up to 90 runs of 48 h; no
    target declared: a run stops at its first objective that is not set apart.</td>
    <td>an objective is found</td></tr>
  <tr><td>PR</td><td>Vuln group A and Perf on the same commit (two tasks).</td><td></td></tr>
  <tr><td>Campaign</td><td>A long fuzzing run with the libraries, duration, cores and runs chosen in the launch form;
    its corpus is kept.</td><td></td></tr>
</table>

<h2>Words used everywhere</h2>
<table>
  <tr><td><b>Task</b></td><td>One launch: a job type on a commit. It is made of steps.</td></tr>
  <tr><td><b>Step</b></td><td>One stage of a task: Init (clone, checks, compat rules), Build of a library,
    Experiment of a library, Summary. A step of a library is a <i>configuration</i> (e.g. WolfSSL, SDOS2).</td></tr>
  <tr><td><b>Attempt / run</b></td><td>One execution of an experiment step; a configuration has several runs
    (e.g. 5/5 = 5 successful runs out of 5).</td></tr>
  <tr><td><b>Cores</b></td><td>Each attempt gets its own CPU cores. Core 0 is never given to experiments: the tools of
    the bench (replays of objectives, reports) run there at idle priority. The steps use at most 80 % of the machine's
    cores by default (the rest stays with the users); the Scheduler's <b>change max</b> sets another maximum for a
    while.</td></tr>
  <tr><td><b>Estimated times</b></td><td>A step is estimated at the median of the last 5 runs of the same step and
    configuration on the same commit; else of the last 15 runs on other commits that did not time out; capped by its
    timeout. A running step past its estimate: to its timeout if that kind of step timed out before, else within a
    minute.</td></tr>
  <tr><td><b>Objective</b></td><td>An input saved by the fuzzer because it triggered the oracle: a crash, an
    AddressSanitizer error, a security claim violation.</td></tr>
  <tr><td><b>Replay</b></td><td>Each objective is run again with exactly the binary, flags and environment of the
    experiment, to get its report.</td></tr>
  <tr><td><b>Bug</b></td><td>Objectives with the same error type and top stack frames (or the same violated claim).
    <i>Confirmed</i> (🐞 red): the replay reproduced an ASAN error, a security violation or a panic.
    <i>Fuzzer only</i> (🐞 orange): the fuzzer's own log recorded it (crash, ASan error, claim) but no replay
    reproduced it. Every objective gets the fuzzer's category, replayed or not.</td></tr>
  <tr><td><b>Expected bug</b></td><td>The CVE a VulnA configuration looks for (🎯); <b>⦸ set apart</b>: a known CVE that
    is never a target; <b>⚠ unexpected</b>: any other bug of a configuration with a target; <b>🚨 new bug</b>: with a target, a bug
    never seen in that configuration before; in a plain version, none of the CVEs tlspuffin declares for the build
    (<b>📋 known</b>). See 🎯 Bugs reference.</td></tr>
  <tr><td><b>Noise floor</b></td><td>How much a metric changes between two tasks of the same commit; Results colours a
    change against the previous commit only beyond it and with p ≤ 0.016 (file
    <code>/html/publisher/regression_floors.json</code>).</td></tr>
  <tr><td><b>Compat rules</b></td><td>Small, recorded adaptations that let old commits build and run under the same
    conditions as new ones (fuzzer flags, log levels, build fixes). A task that used one shows a
    <code>compat</code> warning; the rules are listed in its arguments and its results.</td></tr>
  <tr><td><b>Commit line</b></td><td><code>5c588a #540 message</code>: short hash (link to the commit), the PR
    (<code>#540</code> merged or tip of the PR, <code>#545·1/2</code> first of the two commits of a PR,
    <code>[NO_PR]</code> none), the message (full text on hover).</td></tr>
</table>

<h2>Colors and symbols</h2>
<ul>
  <li>Results status: 🟢 success, 🟡 mixed, 🔴 fail, ⚪ no run.</li>
  <li>Libraries: ✅ all runs fine, ⚠️ some runs failed, ⛔ not run (e.g. ASAN unsupported); warning icons have
    their explanation on hover.</li>
  <li>Steps: <span style="color:#FF9800">■</span> pending, <span style="color:white">■</span> running,
    <span style="color:#4CAF50">■</span> done, <span style="color:#45D0D4">■</span> timed out,
    <span style="color:red">■</span> cancelled.</li>
  <li>Builds: <code>⚙C</code> C harness, <code>🦀</code> Rust harness, <code>ASAN✓</code> AddressSanitizer on,
    <code>preset@commit</code> library version built.</li>
  <li><b>Details, two ways</b>, told by the cursor: the <b>box cursor</b> (an arrow with a small box) means a
    <b>click</b> opens a small window with the details (Esc, a click elsewhere or a second click closes it); the
    <b>? cursor</b>, a link or a button: its details show on <b>hover</b>, after half a second. Charts keep their
    hovers.</li>
  <li><b>❓ N</b> (Results, objectives reports): N objectives <b>without category</b> — no replay confirmed them and
    the fuzzer's log has no record of them (no log, or the record lost), or a crash without location; the click says
    why. They could hide a bug.</li>
</ul>

<h2>Machine and services</h2>
<table>
  <tr><th>Port</th><th>Service</th></tr>
  <tr><td>10082</td><td>scheduler: runs the tasks, serves Scheduler, History, task pages, objectives pages</td></tr>
  <tr><td>10083</td><td>publisher: stores and serves the results (Results page)</td></tr>
  <tr><td>10084</td><td>vis_comparator: Analyzer</td></tr>
  <tr><td>10081</td><td>git_restapi: commits, branches and PRs of the fuzzer repositories</td></tr>
</table>

<h2>More documentation</h2>
<ul>
  <li><a href="https://github.com/tlspuffin/puffin-bench/blob/main/tlspuffin_user_guide.md" target="_blank">tlspuffin user guide</a>:
    job types, configurations, flow of a task, artefacts, API.</li>
  <li><a href="https://github.com/tlspuffin/puffin-bench/blob/main/tlspuffin/docs/tlspuffin-job-scripts.md" target="_blank">Job scripts</a>:
    steps, compat rules, recorded conditions, objectives replay and grouping.</li>
  <li><a href="https://github.com/tlspuffin/puffin-bench/tree/main/scheduler/docs" target="_blank">Scheduler documentation</a>:
    architecture, API, configuration, task and step life cycle.</li>
  <li><a href="https://github.com/tlspuffin/puffin-bench" target="_blank">puffin-bench repository</a>.</li>
</ul>
`;
