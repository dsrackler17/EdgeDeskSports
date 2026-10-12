'use strict';
/* ===========================================================================
   The preflight block at the top of research_intel.sql and research_engine.sql
   lists, for each table and view the file creates, every column it gives it.
   A table already holding one of those names with other columns stops the file
   before anything is written (production holds an older research_findings).

   preflightChecks() keeps those lists honest after the file is applied: every
   relation the file creates is listed, and each list is exactly the columns
   the relation came out with.
   =========================================================================== */
const fs = require('fs');

function preflightOf(text) {
  return [...text.matchAll(/\('([a-z_]+)', '([rv])', array\[([^\]]*)\]\)/g)]
    .map((m) => ({ name: m[1], kind: m[2], cols: m[3].split(',').map((c) => c.trim().replace(/'/g, '')) }));
}

function preflightChecks(db, file, chk) {
  const text = fs.readFileSync(file, 'utf8');
  const list = preflightOf(text);
  const created = [...new Set([...text.matchAll(/create table if not exists public\.([a-z_]+)|create or replace view public\.([a-z_]+)/g)].map((m) => m[1] || m[2]))].sort();
  chk('preflight: it lists every table and view the file creates', list.map((e) => e.name).sort().join(',') === created.join(','), { listed: list.map((e) => e.name), created });
  list.forEach((e) => {
    const got = db.sql(`select c.relkind::text || ':' || string_agg(a.attname::text, ',' order by a.attname) from pg_attribute a join pg_class c on c.oid = a.attrelid
      where a.attrelid = 'public.${e.name}'::regclass and a.attnum > 0 and not a.attisdropped group by c.relkind`).trim();
    chk('preflight: its column list for ' + e.name + ' is exactly what the file creates', got === e.kind + ':' + e.cols.slice().sort().join(','), { got, listed: e.cols });
  });
}

module.exports = { preflightOf, preflightChecks };
