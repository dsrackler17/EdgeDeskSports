'use strict';
/* ===========================================================================
   EdgeDesk college baseball — the experiment pages, generated from the
   registry (never typed), so a rejected hypothesis cannot quietly disappear.

     node college_baseball/research_docs.js           write research/EXPERIMENTS.md and FAILED_EXPERIMENTS.md
     node college_baseball/research_docs.js --check   fail if they are out of date
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const C = require('./config');
const REG = require('./lib/registry');

function short(v) { const s = JSON.stringify(v); return s && s.length > 220 ? s.slice(0, 217) + '…' : s; }

function build() {
  const all = REG.readAll(); const latest = REG.latest();
  const by = (d) => latest.filter((x) => x.decision === d).sort((a, b) => (a.id < b.id ? -1 : 1));
  const L = ['# Experiment registry (generated)', '', 'Generated from `research/experiments.jsonl` by `node college_baseball/research_docs.js`. ' + all.length + ' records, ' + latest.length + ' experiments (latest revision shown). Chain verified: ' + (REG.verify().ok ? 'yes' : '**NO**') + '.', ''];
  for (const d of REG.DECISIONS) {
    const xs = by(d); if (!xs.length) continue;
    L.push('## ' + d, '', '| Experiment | Hypothesis | Windows | Key metrics | Justification | Rev. | Holdout |', '|---|---|---|---|---|---|---|');
    for (const x of xs) L.push(`| **${x.id}** ${x.title} | ${x.hypothesis} | ${short(x.windows)} | ${short(x.metrics)} | ${x.justification} | ${x.revision} | ${x.holdout_evaluated ? 'yes' : ''} |`);
    L.push('');
  }
  const F = ['# Failed and inconclusive experiments (generated)', '', 'Every hypothesis that did not earn its place, with the evidence. Nothing is deleted: a later revision that changes a decision appears in `EXPERIMENTS.md` and both revisions stay in the registry.', ''];
  const failed = latest.filter((x) => x.decision === 'REJECT' || x.decision === 'INCONCLUSIVE').sort((a, b) => (a.id < b.id ? -1 : 1));
  if (!failed.length) F.push('None recorded.');
  for (const x of failed) {
    F.push(`## ${x.id} — ${x.title}`, '', `- **Hypothesis:** ${x.hypothesis}`, `- **Decision:** ${x.decision} (revision ${x.revision}, ${String(x.created_at).slice(0, 10)}, commit ${x.code && x.code.commit ? x.code.commit.slice(0, 10) : 'n/a'})`, `- **Why:** ${x.justification}`, `- **Metrics:** \`${short(x.metrics)}\``, `- **Uncertainty:** \`${short(x.uncertainty)}\``, '');
  }
  const revs = all.filter((x) => x.revision > 1);
  if (revs.length) { F.push('## Revisions (a result that changed)', ''); for (const x of revs) F.push(`- ${x.id} revision ${x.revision} (${String(x.created_at).slice(0, 16)}): decision ${x.decision}`); F.push(''); }
  return { experiments: L.join('\n') + '\n', failed: F.join('\n') + '\n' };
}

function main() {
  const out = build();
  const files = [[path.join(C.PATHS.research, 'EXPERIMENTS.md'), out.experiments], [path.join(C.PATHS.research, 'FAILED_EXPERIMENTS.md'), out.failed]];
  if (process.argv.includes('--check')) { const bad = files.filter(([f, t]) => !fs.existsSync(f) || fs.readFileSync(f, 'utf8') !== t); if (bad.length) { console.error('out of date: ' + bad.map((b) => b[0]).join(', ')); process.exit(1); } console.log('experiment pages up to date'); return; }
  for (const [f, t] of files) fs.writeFileSync(f, t);
  console.log('wrote EXPERIMENTS.md and FAILED_EXPERIMENTS.md');
}

if (require.main === module) main();
module.exports = { build };
