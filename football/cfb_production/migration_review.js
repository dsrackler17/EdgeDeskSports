#!/usr/bin/env node
/* ============================================================================
   CFB production — migration safety review of every supabase/cfb_*.sql
   (docs/cfb-production/DEPLOYMENT.md §3).

   STATIC (always): every top-level statement (tools/sql/split_sql.js, so a
   function body is never mistaken for DDL) and the dynamic SQL inside DO
   blocks is classified:
     destructive      DROP TABLE / COLUMN / VIEW / FUNCTION / INDEX, TRUNCATE,
                      DELETE, ALTER COLUMN ... TYPE     -> must be empty
     recreate         DROP TRIGGER / POLICY IF EXISTS followed by CREATE: not
                      destructive, but ACCESS EXCLUSIVE on a live table
     rls_enable       ALTER TABLE ... ENABLE ROW LEVEL SECURITY (ACCESS
                      EXCLUSIVE) — guarded (only when not yet enabled) or not
     index_plain      CREATE INDEX without CONCURRENTLY: SHARE lock while it
                      builds (fine at today's sizes; see OPERATIONS.md §3)
     not_null_add     ADD COLUMN ... NOT NULL without a DEFAULT (fails on a
                      table with rows)
     volatile_default ADD COLUMN ... DEFAULT <volatile> (rewrites the table)
     lock_timeout     whether the file bounds how long it may wait for a lock

   MEASURED (--measure, needs PostgreSQL): each file is applied to a
   throwaway database in dependency order, then RE-APPLIED as one transaction
   (the SQL editor) with its locks read from pg_locks before commit: the tables
   it holds in ACCESS EXCLUSIVE, and how long each apply took.

     node football/cfb_production/migration_review.js [--measure] [--write]
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const { statements } = require('../../tools/sql/split_sql.js');

const REPO = path.resolve(__dirname, '..', '..');
const ORDER = ['cfb_lab', 'cfb_lab_cron', 'cfb_weekly', 'cfb_personnel', 'cfb_decision', 'cfb_v2_model', 'cfb_market_integrity', 'cfb_matchup', 'cfb_market', 'cfb_production'];

function files() {
  const all = fs.readdirSync(path.join(REPO, 'supabase')).filter((f) => /^cfb_[a-z0-9_]+\.sql$/.test(f)).map((f) => f.replace(/\.sql$/, ''));
  return ORDER.filter((f) => all.includes(f)).concat(all.filter((f) => !ORDER.includes(f)).sort());
}

function stripComments(s) { return s.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, ''); }

function review(name) {
  const text = fs.readFileSync(path.join(REPO, 'supabase', name + '.sql'), 'utf8');
  const st = statements(text).map((s) => stripComments(s).trim()).filter(Boolean);
  const out = { file: 'supabase/' + name + '.sql', bytes: Buffer.byteLength(text), statements: st.length, destructive: [], recreate: 0, rls_enable: { guarded: 0, unguarded: 0 },
    index_plain: 0, index_concurrent: 0, not_null_add: [], volatile_default: [], lock_timeout: /\bset\s+(local\s+)?lock_timeout\b/i.test(stripComments(text)) };
  for (const s of st) {
    const l = s.toLowerCase().replace(/\s+/g, ' ');
    const isFn = /^create (or replace )?function /.test(l);
    /* DDL inside a function body runs only when called; a report query (select / with) changes nothing */
    const scope = isFn || /^(select|with) /.test(l) ? '' : l;
    for (const re of [/\bdrop table\b/, /\bdrop column\b/, /\bdrop view\b/, /\bdrop materialized view\b/, /\bdrop function\b/, /\bdrop index\b/, /\btruncate\b(?! on)(?!\s*\))/, /\bdelete from\b/, /\balter column [a-z_"]+ (set data )?type\b/, /\bdrop schema\b/]) {
      const m = re.exec(scope);
      /* the append-only guards themselves mention truncate / delete only in trigger definitions and messages */
      if (m && !/before (update|delete|truncate)|for each statement execute|raise exception|is never (deleted|truncated)|revoke/.test(scope.slice(Math.max(0, m.index - 60), m.index + 80))) out.destructive.push(s.slice(0, 160));
    }
    out.recreate += (scope.match(/drop (trigger|policy) if exists/g) || []).length;
    const rls = (scope.match(/enable row level security/g) || []).length;
    if (rls) { if (/relrowsecurity/.test(scope)) out.rls_enable.guarded += rls; else out.rls_enable.unguarded += rls; }
    out.index_plain += (scope.match(/create (unique )?index (?!concurrently)/g) || []).length;
    out.index_concurrent += (scope.match(/create (unique )?index concurrently/g) || []).length;
    for (const m of scope.matchAll(/add column (if not exists )?([a-z_]+) [^,;]*/g)) {
      if (/not null/.test(m[0]) && !/default/.test(m[0])) out.not_null_add.push(m[0].slice(0, 120));
      if (/default [^,;]*(clock_timestamp|random\(|gen_random_uuid|uuid_generate)/.test(m[0])) out.volatile_default.push(m[0].slice(0, 120));
    }
  }
  out.destructive = Array.from(new Set(out.destructive));
  return out;
}

/* apply in order, then re-apply each as ONE transaction and read its ACCESS EXCLUSIVE table locks */
function measure(names) {
  const PG = require('../../tools/personal/_pg.js');
  const db = PG.start('cfbmigrev');
  if (!db || db.skip) return { skipped: (db && db.skip) || 'no postgres' };
  const res = {};
  try {
    for (const n of names) {
      const p = path.join(REPO, 'supabase', n + '.sql');
      const t0 = Date.now();
      try { db.applyFile(p); res[n] = { apply_ms: Date.now() - t0 }; } catch (e) { res[n] = { apply_error: String(e.message).split('\n').filter((l) => /ERROR/.test(l)).join(' ').slice(0, 300) }; continue; }
      const body = fs.readFileSync(p, 'utf8');
      const probe = "\nselect '__LOCKS__' || coalesce(string_agg(distinct c.relname, ','), '') from pg_locks l join pg_class c on c.oid = l.relation where l.pid = pg_backend_pid() and l.mode = 'AccessExclusiveLock' and c.relkind in ('r','p');\n";
      const t1 = Date.now();
      try {
        const tmpf = path.join(require('os').tmpdir(), 'cfbmigrev-' + process.pid + '-' + n + '.sql');
        fs.writeFileSync(tmpf, body + probe);
        const out = db.applyFileAtomic(tmpf);                  /* psql -1: ONE transaction, locks held to the end */
        fs.unlinkSync(tmpf);
        const m = /__LOCKS__([^\n]*)/.exec(out);
        res[n].reapply_ms = Date.now() - t1;
        res[n].reapply_access_exclusive_tables = m && m[1] ? m[1].split(',').filter(Boolean).sort() : [];
      } catch (e) { res[n].reapply_error = String(e.message).split('\n').filter((l) => /ERROR/.test(l)).join(' ').slice(0, 300); }
    }
  } finally { db.stop(); }
  return res;
}

module.exports = { files, review, measure };

if (require.main === module) {
  const a = process.argv.slice(2);
  const names = files();
  const rep = { generated_at: new Date().toISOString(), files: names.map(review) };
  if (a.includes('--measure')) {
    /* one transaction per re-apply: psql -1 semantics come from the file being a single db.sql() script with BEGIN/COMMIT around it */
    const m = measure(names);
    rep.measured = m;
  }
  if (a.includes('--write')) {
    fs.writeFileSync(path.join(__dirname, 'reports', 'migration_review.json'), JSON.stringify(rep, null, 1) + '\n');
    console.log('wrote football/cfb_production/reports/migration_review.json');
  }
  rep.files.forEach((f) => console.log(f.file.padEnd(36) + ' stmts ' + String(f.statements).padStart(3) + '  destructive ' + f.destructive.length + '  recreate ' + f.recreate
    + '  rls unguarded ' + f.rls_enable.unguarded + '  plain index ' + f.index_plain + '  lock_timeout ' + (f.lock_timeout ? 'yes' : 'no')
    + (rep.measured && rep.measured[f.file.slice(9, -4)] ? '  re-apply AE tables: ' + JSON.stringify(rep.measured[f.file.slice(9, -4)].reapply_access_exclusive_tables || rep.measured[f.file.slice(9, -4)]) : '')));
}
