#!/usr/bin/env node
/* ============================================================================
   VERIFY A STORED DRAFT AGAINST THE FILES IT SAYS IT READ.

   A draft's data_snapshot names, for every source, the file and the commit.
   This re-reads each file AT THAT COMMIT (git show), checks its digest, and
   re-runs every number's query and every fact's query. It is the answer to
   "where did this number come from?" for any published article, at any time,
   without trusting the draft's own copy of the value.

     node tools/desk/verify.js DRAFT.json            at the commits recorded
     node tools/desk/verify.js DRAFT.json --tree     against the working tree
   ========================================================================== */
'use strict';
const fs = require('fs');
const D = require('../../lib/edgedesk_desk.js');
const SRC = require('./sources.js');

function verifyRow(row, opts) {
  opts = opts || {};
  const snap = row.data_snapshot || {};
  const sources = Object.create(null), problems = [];
  (snap.sources || []).forEach(p => {
    if (!opts.tree && !p.commit) { problems.push({ key: p.id, why: p.file + ' was read from an uncommitted file, so there is no commit to re-read it at (verify with --tree)' }); return; }
    const s = SRC.load(p.id, { season: row.season || 2026, commit: opts.tree ? null : p.commit });
    if (!s) { problems.push({ key: p.id, why: 'source file ' + p.file + ' not found' + (opts.tree ? '' : ' at ' + p.commit) }); return; }
    if (!opts.tree && s.sha256 !== p.sha256) problems.push({ key: p.id, why: 'digest at ' + p.commit + ' is ' + s.sha256.slice(0, 12) + ', the draft recorded ' + String(p.sha256).slice(0, 12) });
    sources[p.id] = s;
  });
  const draft = { title: row.title, lead: row.lead, highlights: row.highlights, description: row.description,
    body_md: row.generated_body, numbers: snap.numbers, facts: snap.facts };
  const v = D.verifyDraft(draft, sources);
  return { ok: !problems.length && v.ok, checked: v.checked, problems: problems.concat(v.problems) };
}

if (require.main === module) {
  const file = process.argv[2];
  if (!file) { console.error('usage: node tools/desk/verify.js DRAFT.json [--tree]'); process.exit(2); }
  const row = JSON.parse(fs.readFileSync(file, 'utf8'));
  const r = verifyRow(row, { tree: process.argv.indexOf('--tree') >= 0 });
  console.log((r.ok ? 'OK   ' : 'FAIL ') + row.article_key + ': ' + r.checked + ' value(s) re-derived from source'
    + (r.problems.length ? '\n' + r.problems.map(p => '  ' + p.key + ': ' + p.why).join('\n') : ''));
  process.exit(r.ok ? 0 : 1);
}
module.exports = { verifyRow };
