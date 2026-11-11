// words_markdown.js: the words of the pages (common/verdicts.js) as the Markdown of the user guide's section "Words of
// the pages" (tlspuffin_user_guide.md, between <!-- words:begin --> and <!-- words:end -->). words_doc_test.sh checks
// that the guide has exactly this; to update the guide after a change of verdicts.js:
//   qjs --std -m tlspuffin/scripts/tools/words_markdown.js > words.md, then put it between the two markers.
import { TERMS, VERDICTS, VERDICT_ORDER, NO_VERDICT, TAGS, LEVELS } from './common/verdicts.js';

const cell = text => String(text).replace(/\|/g, '\\|').replace(/\n/g, ': ');
const out = [];
out.push('| term | meaning |', '|---|---|');
for (const [term, text] of TERMS) out.push(`| **${cell(term)}** | ${cell(text)} |`);
out.push('', 'The verdicts of the validation, per objective, strongest first (a bug\'s verdict is its strongest part):', '');
out.push('| badge | meaning |', '|---|---|');
for (const kind of VERDICT_ORDER) {
  const v = VERDICTS[kind];
  out.push(`| ${v.mark} **${cell(v.word)}** | ${cell(v.tip.split('\n').slice(1).join('; '))} |`);
}
out.push('', 'Why an objective has no verdict:', '');
for (const text of Object.values(NO_VERDICT)) out.push(`- ${text}`);
out.push('', 'What a bug is for its task:', '');
out.push('| tag | meaning |', '|---|---|');
for (const t of Object.values(TAGS)) out.push(`| ${t.mark} **${cell(t.word)}** | ${cell(t.tip)} |`);
out.push('', 'The level of a task: the title of its objectives page, the colour of its 🐞 on the scheduler\'s History, of its objectives on the board (its card, attempts and button) and of the top bar\'s live pill (red with 🚨 for a new bug, gold unexpected, plain otherwise):', '');
out.push('| level | meaning |', '|---|---|');
for (const l of Object.values(LEVELS)) out.push(`| ${l.mark ? `${l.mark} ` : ''}**${cell(l.word)}** | ${cell(l.tip)} |`);
std.out.puts(out.join('\n') + '\n');
