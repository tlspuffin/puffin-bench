/**
 * Help modal content.
 * Exported as an HTML string so it can be maintained here independently of dialog logic.
 */

export const HELP_HTML = `
<div class="help-section">
  <h4>Overview</h4>
  <p>
    This tool lets you compare benchmark metrics (performance, vulnerability) across git commits.
    You build a <strong>view</strong> made of one or more graphs, each plotting one or more
    experiments (commit × subtask pairs) against one or more metrics over time.
  </p>
</div>

<div class="help-section">
  <h4>Header toolbar</h4>
  <table class="help-table">
    <tr><td><strong>+ Graph</strong></td><td>Add a new graph to the current view.</td></tr>
    <tr><td><strong>Save view</strong></td><td>Persist the current view (graphs, variables, legend settings) to the server under the view's name.</td></tr>
    <tr><td><strong>Open view</strong></td><td>Load a previously saved view from the server. Double-click a name or select + OK to open it.</td></tr>
    <tr><td><strong>New view</strong></td><td>Start a blank view. Enter a name (auto-generated if left empty).</td></tr>
    <tr><td><strong>Open template</strong></td><td>Load a template. Templates use variables as placeholders — set them in the sidebar after loading.</td></tr>
    <tr><td><strong>Save template</strong></td><td>Save the current view as a reusable template. Optionally provide a <em>title format string</em> (see <em>Title Format</em> below).</td></tr>
    <tr><td><strong>Help</strong></td><td>Open this dialog.</td></tr>
  </table>
  <p>Click the pencil <strong>✏ Edit</strong> button next to the view title to rename it inline. Press <kbd>Enter</kbd> to confirm or <kbd>Escape</kbd> to cancel.</p>
</div>

<div class="help-section">
  <h4>Adding and editing graphs</h4>
  <p>Click <strong>+ Graph</strong> to open the graph dialog. It has three sections:</p>

  <p><strong>1. Experiments</strong> — pick up to 4 commit + subtask pairs. Each row is one experiment.</p>
  <ul>
    <li>Select a <em>commit</em> from the rich picker (shows branch, PR number, date, commit message). Type to search, or use the <em>main/dev</em>, <em>branches</em>, <em>PRs</em>, and <em>All</em> tabs to filter.</li>
    <li>Select a <em>subtask</em> (task type / benchmark name). The list populates once a commit is chosen.</li>
    <li>Either field can reference a <em>variable</em> defined in the sidebar (see <em>Variables</em> below).</li>
    <li>Use the <strong>mode button</strong> at the start of a row to switch it between <em>Commit</em> and <em>Campaign</em> mode. In Campaign mode you pick a single campaign run (or campaign variable) that supplies the commit, subtype, and timestamp together, instead of a commit + subtask.</li>
    <li>A <span style="color:#e08c00">⚠</span> badge means the selected combination has no data on the server.</li>
    <li>Click <strong>+ Add experiment</strong> to add more rows (max 4). Click ✕ to remove one.</li>
  </ul>

  <p><strong>2. Metrics</strong> — choose which metrics to plot.</p>
  <ul>
    <li><strong>AND mode</strong>: only metrics common to all selected experiments are shown.</li>
    <li><strong>OR mode</strong>: all metrics are shown; those absent from some experiments appear in orange.</li>
    <li>Metric variables defined in the sidebar appear at the top of the list.</li>
  </ul>

  <p><strong>3. Time range (μs)</strong> — set the window of data to fetch.</p>
  <ul>
    <li><em>Start / End</em>: time bounds in microseconds. Auto-filled from the data on first load.</li>
    <li><em>Delta</em>: bucket size in microseconds. Determines resolution.</li>
    <li><em>Steps</em>: read-only computed value (End − Start) ÷ Delta.</li>
  </ul>

  <p>Once added, each graph has a title bar with three controls:</p>
  <ul>
    <li><strong>⚙</strong> — re-open the dialog to edit experiments, metrics, or time range.</li>
    <li><strong>➖ / ➕</strong> — minimize or expand the graph.</li>
    <li><strong>✖</strong> — delete the graph permanently.</li>
  </ul>

  <p>Below the title bar, three toggle buttons control rendering options:</p>
  <ul>
    <li><strong>Split Y-Axes</strong> — give each metric its own Y-axis (useful when scales differ). Disabled for single-metric graphs.</li>
    <li><strong>All Runs</strong> — overlay every individual client run as a faint dotted trace.</li>
    <li><strong>Confidence Bands</strong> — shade the 95% confidence interval around the mean.</li>
  </ul>
</div>

<div class="help-section">
  <h4>Sidebar — Variables</h4>
  <p>
    The <strong>Configuration</strong> sidebar (right edge — click the tab to toggle, drag the handle to resize)
    lets you define named variables. Once defined, a variable can be picked anywhere a commit, subtask, or
    metric is expected. Changing a variable's value instantly re-fetches and redraws all graphs that use it.
  </p>
  <p>Use the <strong>+</strong> button in each section header to add a variable. Auto-named <code>c1</code>, <code>s1</code>, <code>k1</code>, <code>m1</code>…</p>

  <p><strong>Commit variables</strong> (e.g. <code>c1</code>)</p>
  <ul>
    <li>Select a commit from the same rich picker used in the graph dialog.</li>
    <li>Set an optional <em>Alias</em> (e.g. <code>DEV</code>) — used in legend labels.</li>
    <li>↺ resets the value to undefined without deleting the variable.</li>
    <li>✕ deletes the variable. Not allowed if any graph still references it.</li>
  </ul>

  <p><strong>Subtask variables</strong> (e.g. <code>s1</code>)</p>
  <ul>
    <li>Select a task type + subtask pair. The list is populated from commits already loaded.</li>
    <li>Set an optional <em>Alias</em> (e.g. <code>BASELINE</code>).</li>
    <li>Same ↺ / ✕ behaviour as commit variables.</li>
  </ul>

  <p><strong>Campaign variables</strong> (e.g. <code>k1</code>)</p>
  <ul>
    <li>Pick a campaign run from the campaign picker — search or filter by user, campaign, commit, or subtype, and sort by any column.</li>
    <li>A selected run supplies its commit, subtype, and timestamp together; the chosen run is shown below the picker.</li>
    <li>Set an optional <em>Alias</em>. Same ↺ / ✕ behaviour (✕ blocked if used by a graph).</li>
  </ul>

  <p><strong>Metric variables</strong> (e.g. <code>m1</code>)</p>
  <ul>
    <li>Click the pill to open a metric picker showing all metrics available across current graphs.</li>
    <li>Single selection only.</li>
    <li>↺ resets, ✕ deletes (blocked if used by a graph).</li>
  </ul>
</div>

<div class="help-section">
  <h4>Sidebar — Experiment Legend</h4>
  <p>One row per resolved experiment (commit × subtask) currently loaded across all graphs.</p>
  <ul>
    <li><strong>Color swatch</strong> — click to pick a custom color for all traces of this experiment.</li>
    <li><strong>● / ○</strong> — toggle experiment visibility across all graphs.</li>
    <li><strong>Display name</strong> — override the generated label in graph legends (leave blank to use the format template).</li>
    <li><strong>Format</strong> — a template string applied to all experiments without an explicit display name.</li>
  </ul>
  <p>Experiment format tokens: <code>${"${COMMIT_HASH}"}</code>, <code>${"${SUBTASK_TYPE}"}</code>, <code>${"${SUBTASK_NAME}"}</code>, <code>${"${COMMIT_ALIAS}"}</code>, <code>${"${SUBTASK_ALIAS}"}</code>, <code>${"${USER}"}</code>, <code>${"${CAMPAIGN_NAME}"}</code>, <code>${"${DATE}"}</code>, <code>${"${TIME}"}</code>, <code>${"${DATETIME}"}</code>.</p>
  <p>Date/time tokens accept <code>:format(&lt;pattern&gt;)</code> with <code>YYYY MM DD HH mm ss</code> (e.g. <code>${"${DATE:format(YYYY/MM/DD)}"}</code>); without it they default to <code>YYYY-MM-DD</code> / <code>HH:mm:ss</code> / <code>YYYY-MM-DD HH:mm:ss</code>. <code>${"${USER}"}</code> and <code>${"${CAMPAIGN_NAME}"}</code> are empty for non-campaign experiments.</p>
  <p>Default: <code>${"${COMMIT_ALIAS} − ${SUBTASK_ALIAS}"}</code></p>
</div>

<div class="help-section">
  <h4>Sidebar — Metric Legend</h4>
  <p>One row per resolved metric path currently loaded across all graphs.</p>
  <ul>
    <li><strong>Line style</strong> — choose solid, dot, dash, or dashdot for all traces of this metric.</li>
    <li><strong>● / ○</strong> — toggle metric visibility across all graphs.</li>
    <li><strong>Display name</strong> — override the metric label in graph legends.</li>
    <li><strong>Format</strong> — template applied to all metrics without an explicit display name.</li>
  </ul>
  <p>Metric format token: <code>${"${METRIC}"}</code>. Default: <code>${"${METRIC}"}</code>.</p>
</div>

<div class="help-section">
  <h4>Format transforms</h4>
  <p>
    Any token in a format template can be followed by one or more chained transforms separated by <code>:</code>.
    Example: <code>${"${SUBTASK_ALIAS:afterLast(_):pascalcase}"}</code>
  </p>
  <table class="help-table">
    <tr><td><code>uppercase</code></td><td>ALL CAPS</td></tr>
    <tr><td><code>lowercase</code></td><td>all lower</td></tr>
    <tr><td><code>camelcase</code></td><td>firstWordLower</td></tr>
    <tr><td><code>pascalcase</code></td><td>FirstWordUpper</td></tr>
    <tr><td><code>kebabcase</code></td><td>words-with-hyphens</td></tr>
    <tr><td><code>snakecase</code></td><td>words_with_underscores</td></tr>
    <tr><td><code>beforeFirst(regex)</code></td><td>Substring before the first regex match</td></tr>
    <tr><td><code>afterLast(regex)</code></td><td>Substring after the last regex match</td></tr>
  </table>
  <p>Example: <code>${"${METRIC:afterLast(\\.):uppercase}"}</code> → last dot-segment of the metric path, uppercased.</p>
</div>

<div class="help-section">
  <h4>Views vs. Templates</h4>
  <table class="help-table">
    <tr>
      <th>View</th>
      <th>Template</th>
    </tr>
    <tr>
      <td>Fully concrete — all commits and subtasks are hard-coded.</td>
      <td>Uses variables as placeholders. Shared with others who supply their own values.</td>
    </tr>
    <tr>
      <td>Saved/loaded under a unique name.</td>
      <td>Loaded, then variables are filled in via the sidebar or URL parameters.</td>
    </tr>
    <tr>
      <td>Not shareable via URL.</td>
      <td>Shareable: click the 🔗 button in <em>Open template</em> to copy a URL with current variable values encoded.</td>
    </tr>
  </table>
  <p>
    When saving a template, the optional <strong>Title format</strong> field lets the view title be
    computed from variables when the template is loaded.
    Title tokens: <code>${"${TEMPLATE}"}</code>, <code>${"${DATE}"}</code>,
    <code>${"${&lt;varname&gt;_HASH}"}</code> / <code>${"${&lt;varname&gt;_ALIAS}"}</code> (commit vars),
    <code>${"${&lt;varname&gt;_NAME}"}</code> / <code>${"${&lt;varname&gt;_TYPE}"}</code> / <code>${"${&lt;varname&gt;_ALIAS}"}</code> (subtask vars),
    <code>${"${&lt;varname&gt;_USER}"}</code> / <code>${"${&lt;varname&gt;_CAMPAIGN}"}</code> / <code>${"${&lt;varname&gt;_COMMIT}"}</code> / <code>${"${&lt;varname&gt;_SUBTYPE}"}</code> / <code>${"${&lt;varname&gt;_DATE}"}</code> / <code>${"${&lt;varname&gt;_ALIAS}"}</code> (campaign vars),
    <code>${"${&lt;varname&gt;}"}</code> (metric vars). Same transforms apply;
    <code>${"${DATE}"}</code> and a campaign <code>${"${&lt;varname&gt;_DATE}"}</code> accept <code>:format(&lt;pattern&gt;)</code> (default <code>YYYY-MM-DD</code>).
  </p>
</div>

<div class="help-section">
  <h4>URL sharing (templates)</h4>
  <p>A template URL has the form:</p>
  <pre class="help-code">?template=&lt;name&gt;&amp;&lt;varname&gt;=&lt;commitHash&gt;&amp;&lt;varname&gt;.alias=&lt;alias&gt;
&amp;&lt;varname&gt;=&lt;tasktype&gt;:&lt;subtask&gt;&amp;&lt;varname&gt;=&lt;metricPath&gt;</pre>
  <p>Any variable listed in the URL overrides the template's default value. Omitted variables keep their saved defaults.</p>
  <p>Use the 🔗 button in <em>Open template</em> to generate this URL automatically from current variable values.</p>
</div>

<div class="help-section">
  <h4>Keyboard &amp; mouse shortcuts</h4>
  <table class="help-table">
    <tr><td>Escape</td><td>Close the current modal dialog.</td></tr>
    <tr><td>Click backdrop</td><td>Close the current modal dialog.</td></tr>
    <tr><td>Sidebar tab</td><td>Click to collapse/expand the Configuration sidebar.</td></tr>
    <tr><td>Sidebar handle</td><td>Drag the left edge of the sidebar to resize it (160 px – 600 px).</td></tr>
    <tr><td>Legend click</td><td>Click a trace name in a graph legend to hide/show that trace.</td></tr>
  </table>
</div>
`;
