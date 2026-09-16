#!/usr/bin/env node
/* ===========================================================================
   The Collective's schema, as the database actually serves it.

   Every job that writes the collective schema reads the OpenAPI document
   PostgREST serves for it and writes only the columns that are there. When
   a job refuses -- "collective.games carries no home_score column", "no
   table holds a final score" -- the next question is always "so what IS
   there?", and the answer lives behind a service credential that no
   workstation holds. This prints it: every relation the schema exposes with
   its column names, and every routine, and nothing else. No row is read and
   no value is printed; the credential goes into a header and nowhere else.

   Run (from a workflow, with the repository secrets):
     EDGD_SB_SERVICE=... EDGD_SB_URL=... node tools/collective/schema_report.js
     node tools/collective/schema_report.js --json     # machine-readable
   =========================================================================== */
'use strict';

const S = require('./settle_finals.js');

function report(openapi) {
  const defs = (openapi && openapi.definitions) || {};
  const paths = (openapi && openapi.paths) || {};
  const relations = Object.keys(defs).sort().map(name => ({
    name,
    columns: Object.keys((defs[name] && defs[name].properties) || {}),
  }));
  const routines = Object.keys(paths).filter(p => p.indexOf('/rpc/') === 0)
    .map(p => p.slice('/rpc/'.length)).sort();
  return { relations, routines };
}

function render(r) {
  const out = [];
  out.push(`${r.relations.length} relation(s) in the collective schema`);
  r.relations.forEach(t => out.push(`  ${t.name}: ${t.columns.join(', ') || '(no columns listed)'}`));
  out.push(`${r.routines.length} routine(s)`);
  r.routines.forEach(f => out.push(`  rpc/${f}`));
  const scoreHolders = r.relations.filter(t =>
    t.columns.indexOf('home_score') >= 0 && t.columns.indexOf('away_score') >= 0);
  out.push('relations carrying home_score and away_score: ' +
    (scoreHolders.map(t => t.name).join(', ') || 'NONE'));
  return out.join('\n');
}

async function main() {
  const cfg = S.directConfig(process.env);
  if (!cfg) {
    console.error('No service credential: set EDGD_SB_SERVICE and EDGD_SB_URL (SB_SERVICE_ROLE / SB_URL in the workflow).');
    return 1;
  }
  const db = S.dbClient(cfg);
  const res = await fetch(`${cfg.url}/rest/v1/`, {
    headers: { apikey: cfg.key, authorization: `Bearer ${cfg.key}`, 'accept-profile': 'collective' },
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`GET /rest/v1/ (collective schema) -> ${res.status}: ${text.slice(0, 300)}`);
    return 1;
  }
  const r = report(JSON.parse(text));
  if (process.argv.indexOf('--json') >= 0) console.log(JSON.stringify(r, null, 2));
  else console.log(render(r));
  void db;
  return 0;
}

module.exports = { report, render };

if (require.main === module) {
  main().then(c => process.exit(c)).catch(e => { console.error(`[schema] ${e.message}`); process.exit(1); });
}
