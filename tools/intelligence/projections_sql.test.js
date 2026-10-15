#!/usr/bin/env node
/* ===========================================================================
   supabase/independent_projections.sql AGAINST A REAL POSTGRESQL.

   Applied twice to a throwaway cluster with the Supabase auth shim, then
   attacked as two readers, anon and the service role:
     - the report reads ok on both runs, and re-running keeps every row
     - a reader writes and reads only their own snapshots and comparisons
     - THE ORDER: a comparison is refused unless the same reader stored,
       earlier, the snapshot it names, frozen at the stated time, holding the
       projection with the same id AND hash; a comparison stamped before the
       freeze is refused; another reader's snapshot cannot be borrowed
     - INDEPENDENCE: a snapshot whose projection carries a market input is
       refused, and so is a probability outside [0, 1]
     - a VERIFIED POSITIVE EV row needs a live, timestamped book quote
     - write-once, no reader deletes, one retention door (service role only)
     - the rollback file removes exactly what the migration added
     - migration safety: no DROP TABLE / TRUNCATE in the migration

   Run: node tools/intelligence/projections_sql.test.js
   (QUANT_SQL_REQUIRED=1 turns a missing PostgreSQL into a failure, as CI sets it.)
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const EDPROJ = require(path.join(PG.ROOT, 'lib', 'edgedesk_projections.js'));
const FILE = path.join(PG.ROOT, 'supabase', 'independent_projections.sql');
const ROLLBACK = path.join(PG.ROOT, 'supabase', 'independent_projections_rollback.sql');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push({ name, detail }); }
function done(db) {
  if (db) db.stop();
  failures.forEach((f) => console.log('FAIL | ' + f.name + '  ' + String(JSON.stringify(f.detail)).slice(0, 500)));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

/* ═══ 0. STATIC MIGRATION SAFETY ═════════════════════════════════════════ */
{
  const text = fs.readFileSync(FILE, 'utf8');
  const code = text.replace(/--[^\n]*/g, '');
  chk('no psql meta-commands', !/^\s*\\/m.test(code));
  chk('no DROP TABLE, TRUNCATE or ALTER ... DROP COLUMN', !/\bdrop\s+table\b|\btruncate\b|\bdrop\s+column\b/i.test(code));
  chk('the only DELETEs are the two inside the retention function', (code.match(/\bdelete\s+from\b/gi) || []).length === 2);
  chk('every table is created with IF NOT EXISTS', (code.match(/create table (?!if not exists)/gi) || []).length === 0);
  chk('it touches no billing, auth, betting-record or entitlement relation', !/\b(subscriptions|billing_|stripe|auth\.users|my_billing_access|ai_usage|portfolio_positions|recommendation_ledger|signals)\b/i.test(code));
  chk('it ends in a report', /THE REPORT\.\s*\nselect /.test(text));
  chk('a rollback file exists and drops only these two ledgers and their functions', /drop table if exists public\.market_comparisons;/.test(fs.readFileSync(ROLLBACK, 'utf8')) && !/drop table if exists public\.(?!market_comparisons|projection_snapshots)/.test(fs.readFileSync(ROLLBACK, 'utf8')));
}

const db = PG.start('projsql');
if (db.skip) {
  console.log('SKIP: ' + db.skip);
  if (process.env.QUANT_SQL_REQUIRED === '1') { fail++; failures.push({ name: 'PostgreSQL required', detail: db.skip }); }
  done(null);
}
const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const L = PG.lit;
const semi = (t) => /;\s*$/.test(t) ? t : t + ';';
['as', 'anon', 'service'].forEach((k) => { const f = db[k] && db[k].bind(db); if (f) db[k] = k === 'as' ? (u, t) => f(u, semi(t)) : (t) => f(semi(t)); });

/* a real projection id and SHA-256, as EDPROJ writes them */
const H1 = EDPROJ.sha256('projection one'), H2 = EDPROJ.sha256('projection two'), SNAPH = EDPROJ.sha256(H1 + '|' + H2);
const PJ1 = 'pj_' + EDPROJ.sha256('nhl|2026020118').slice(0, 24), PJ2 = 'pj_' + EDPROJ.sha256('nhl|2026020117').slice(0, 24);
const SNAP = 'pjs_' + SNAPH.slice(0, 32);
/* every time is anchored to the database's own clock: the freeze must not be in the server's future */
let BASE = 0; const at = (sec) => new Date(BASE + sec * 1000).toISOString();
let FROZEN = null;
const proj = (id, h, over) => Object.assign({ projection_id: id, projection_hash: h, sport: 'nhl', event_id: '2026020118', p_home: 0.664, p_away: 0.336, p_draw: null, market_inputs: [], model_id: 'edgedesk_nhl_v1:xg_core', research_outcome: 'RESEARCH_CONDITIONAL' }, over || {});
const snapshot = (uid, over) => {
  const o = Object.assign({ id: SNAP, hash: SNAPH, frozen: FROZEN, projections: [proj(PJ1, H1), proj(PJ2, H2, { event_id: '2026020117' })] }, over || {});
  return `insert into public.projection_snapshots (snapshot_id, user_id, snapshot_hash, frozen_at, window_from, window_to, timezone, question, contract_version, projections_count, projections)
    values (${L(o.id)}, ${L(uid)}, ${L(o.hash)}, ${L(o.frozen)}, ${L(o.frozen)}, ${L(at(15 * 3600))}, 'America/Chicago', 'best researched opportunity tonight', 'edgedesk_independent_projection_v1', ${o.projections.length}, ${L(JSON.stringify(o.projections))}::jsonb)`;
};
const cmp = (uid, over) => {
  const o = Object.assign({ id: 'mc_' + EDPROJ.sha256(JSON.stringify(over || {})).slice(0, 16), snap: SNAP, pj: PJ1, h: H1, frozen: FROZEN, compared: at(-119), outcome: 'STALE_PRICE', kind: 'CAPTURED_SPORTSBOOK_QUOTE', odds: -180, captured: at(-120 - 165 * 60), ev: 'null', sport: 'nhl', event: '2026020118', pw: 0.664 }, over || {});
  return `insert into public.market_comparisons (comparison_id, user_id, snapshot_id, projection_id, projection_hash, frozen_at, compared_at, sport, event_id, market, side, line, model_probability, model_push, model_fair_american, quote_kind, book, odds_american, quote_captured_at, quote_source, break_even, ev_per_dollar, outcome, reasons, gates, engine_version)
    values (${L(o.id)}, ${L(uid)}, ${L(o.snap)}, ${L(o.pj)}, ${L(o.h)}, ${L(o.frozen)}, ${L(o.compared)}, ${L(o.sport)}, ${L(o.event)}, 'moneyline', 'home', null, ${o.pw}, 0, -198, ${o.kind == null ? 'null' : L(o.kind)}, 'DraftKings', ${o.odds == null ? 'null' : o.odds}, ${o.captured == null ? 'null' : L(o.captured)}, 'today/slate.json markets', 0.643, ${o.ev}, ${L(o.outcome)}, '["captured 165 min ago against a 60 min limit"]'::jsonb, '[]'::jsonb, 'edgedesk_market_compare_v1')`;
};

try {
  db.sql('alter default privileges for role postgres in schema public grant all on tables to anon, authenticated;');
  BASE = Date.parse(db.sql("select to_char(now() at time zone 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')").trim());
  FROZEN = at(-120);

  /* ═══ 1. APPLY, TWICE ═════════════════════════════════════════════════ */
  const r1 = db.applyFile(FILE);
  chk('first apply: every report row ok', !/CHECK THIS/.test(r1) && (r1.match(/\|\s*ok/g) || []).length >= 10, r1.slice(-900));
  db.as(A, snapshot(A));
  const r2 = db.applyFile(FILE);
  chk('second apply: still ok (idempotent)', !/CHECK THIS/.test(r2), r2.slice(-600));
  chk('re-running kept the snapshot', db.service('select count(*) from public.projection_snapshots').trim() === '1');

  /* ═══ 2. ROW LEVEL SECURITY ═══════════════════════════════════════════ */
  chk('a reader reads their own snapshot', db.as(A, 'select count(*) from public.projection_snapshots').trim() === '1');
  chk('another reader reads none of it', db.as(B, 'select count(*) from public.projection_snapshots').trim() === '0');
  chk('a reader cannot write a snapshot as someone else', db.mustFail(() => db.as(B, snapshot(A).replace(L(SNAP), L('pjs_' + 'b'.repeat(32))))) !== null);
  const anonRead = db.mustFail(() => db.anon('select count(*) from public.projection_snapshots'));
  chk('anon cannot read the snapshots', anonRead !== null || db.anon('select count(*) from public.projection_snapshots').trim() === '0', anonRead);
  const grants = db.sql("select string_agg(distinct privilege_type, ',' order by privilege_type) from information_schema.role_table_grants where grantee = 'authenticated' and table_schema = 'public' and table_name in ('projection_snapshots','market_comparisons')");
  chk('authenticated holds only SELECT and INSERT on the ledgers', grants.trim() === 'INSERT,SELECT', grants);
  chk('a reader cannot TRUNCATE (it would bypass the row triggers)', db.mustFail(() => db.as(A, 'truncate public.projection_snapshots')) !== null && db.mustFail(() => db.as(A, 'truncate public.market_comparisons')) !== null);

  /* ═══ 3. THE ORDER: FROZEN FIRST ══════════════════════════════════════ */
  db.as(A, cmp(A));
  chk('a comparison against the reader\'s own frozen projection is stored', db.as(A, 'select count(*) from public.market_comparisons').trim() === '1');
  const noSnap = db.mustFail(() => db.as(A, cmp(A, { id: 'mc_' + '1'.repeat(16), snap: 'pjs_' + 'c'.repeat(32) })));
  chk('a comparison naming a snapshot that was never stored is refused', /no snapshot/.test(noSnap || ''), noSnap);
  const wrongHash = db.mustFail(() => db.as(A, cmp(A, { id: 'mc_' + '2'.repeat(16), h: EDPROJ.sha256('a projection changed after the price') })));
  chk('a comparison whose projection hash differs from the frozen one is refused (the projection moved)', /no snapshot/.test(wrongHash || ''), wrongHash);
  const before = db.mustFail(() => db.as(A, cmp(A, { id: 'mc_' + '3'.repeat(16), compared: at(-200) })));
  chk('a comparison stamped before the freeze is refused', before !== null, before);
  const otherFrozen = db.mustFail(() => db.as(A, cmp(A, { id: 'mc_' + '4'.repeat(16), frozen: at(-180) })));
  chk('a comparison claiming a different freeze time is refused', /no snapshot/.test(otherFrozen || ''), otherFrozen);
  const borrow = db.mustFail(() => db.as(B, cmp(B, { id: 'mc_' + '5'.repeat(16) })));
  chk('another reader cannot compare against A\'s snapshot', /no snapshot/.test(borrow || ''), borrow);
  const unknownPj = db.mustFail(() => db.as(A, cmp(A, { id: 'mc_' + '6'.repeat(16), pj: 'pj_' + 'd'.repeat(24) })));
  chk('a projection the snapshot does not hold is refused', /no snapshot/.test(unknownPj || ''), unknownPj);
  /* the server's clock: nothing is back-dated to look frozen first */
  const oldFreeze = db.mustFail(() => db.as(A, snapshot(A, { id: 'pjs_' + '9'.repeat(32), frozen: at(-7 * 86400) })));
  chk('a snapshot back-dated a week (frozen_at long before the write) is refused', /never back-dated/.test(oldFreeze || ''), oldFreeze);
  const futureFreeze = db.mustFail(() => db.as(A, snapshot(A, { id: 'pjs_' + '8'.repeat(32), frozen: at(3600) }).replace(/\(snapshot_id, user_id,/, '(snapshot_id, user_id, created_at,').replace(/values \(([^,]+), ([^,]+),/, "values ($1, $2, now() + interval '2 hours',")));
  chk('a client-supplied created_at cannot lift the future-freeze limit (created_at is the server\'s)', futureFreeze !== null && db.as(A, "select count(*) from public.projection_snapshots where snapshot_id = 'pjs_" + '8'.repeat(32) + "'").trim() === '0', futureFreeze);
  const oldCmp = db.mustFail(() => db.as(A, cmp(A, { id: 'mc_' + 'c'.repeat(16), compared: at(-3 * 3600) })));
  chk('a comparison back-dated hours before its write is refused', /not the time of the write/.test(oldCmp || ''), oldCmp);
  const wrongEvent = db.mustFail(() => db.as(A, cmp(A, { id: 'mc_' + 'd'.repeat(16), event: '2026020999' })));
  chk('a comparison naming another event than its projection\'s is refused', /not nhl event 2026020999/.test(wrongEvent || ''), wrongEvent);
  const wrongSport = db.mustFail(() => db.as(A, cmp(A, { id: 'mc_' + 'e'.repeat(16), sport: 'nba' })));
  chk('a comparison naming another sport than its projection\'s is refused', /not nba event/.test(wrongSport || ''), wrongSport);
  const wrongP = db.mustFail(() => db.as(A, cmp(A, { id: 'mc_' + 'f'.repeat(16), pw: 0.71 })));
  chk('a moneyline comparison carrying a probability other than the frozen one is refused', /not the frozen projection/.test(wrongP || ''), wrongP);
  const stamped = db.as(A, "select (abs(extract(epoch from (created_at - now()))) < 120)::text from public.market_comparisons order by id limit 1").trim();
  chk('created_at is the server\'s clock', stamped === 'true', stamped);

  /* ═══ 4. INDEPENDENCE AND UNITS ═══════════════════════════════════════ */
  const contaminated = db.mustFail(() => db.as(A, snapshot(A, { id: 'pjs_' + 'e'.repeat(32), projections: [proj(PJ1, H1, { market_inputs: ['consensus spread'] })] })));
  chk('a snapshot whose projection carries a market input is refused', /market inputs/.test(contaminated || ''), contaminated);
  const missingInputs = db.mustFail(() => db.as(A, snapshot(A, { id: 'pjs_' + 'f'.repeat(32), projections: [(() => { const p = proj(PJ1, H1); delete p.market_inputs; return p; })()] })));
  chk('a projection that does not state its (empty) market inputs is refused', /market inputs/.test(missingInputs || ''), missingInputs);
  chk('a percent passed as a probability is refused', /outside \[0, 1\]/.test(db.mustFail(() => db.as(A, snapshot(A, { id: 'pjs_' + '1'.repeat(32), projections: [proj(PJ1, H1, { p_home: 66.4, p_away: 33.6 })] }))) || ''));
  chk('probabilities summing past 1 are refused', /sum past 1/.test(db.mustFail(() => db.as(A, snapshot(A, { id: 'pjs_' + '2'.repeat(32), projections: [proj(PJ1, H1, { p_home: 0.7, p_away: 0.5 })] }))) || ''));
  chk('a projection without a SHA-256 hash is refused', /SHA-256/.test(db.mustFail(() => db.as(A, snapshot(A, { id: 'pjs_' + '3'.repeat(32), projections: [proj(PJ1, 'abc')] }))) || ''));
  chk('a count that does not match the array is refused', db.mustFail(() => db.as(A, snapshot(A, { id: 'pjs_' + '4'.repeat(32) }).replace(/, 2, '\[/, ", 5, '["))) !== null);
  chk('-50 American odds are refused', db.mustFail(() => db.as(A, cmp(A, { id: 'mc_' + '7'.repeat(16), odds: -50 }))) !== null);
  chk('an unknown outcome is refused', db.mustFail(() => db.as(A, cmp(A, { id: 'mc_' + '8'.repeat(16), outcome: 'LOCK' }))) !== null);
  const verCaptured = db.mustFail(() => db.as(A, cmp(A, { id: 'mc_' + '9'.repeat(16), outcome: 'VERIFIED_POSITIVE_EV', ev: '0.031' })));
  chk('VERIFIED POSITIVE EV on a previously captured quote is refused (it needs a live quote)', /verified_needs_live_quote/.test(verCaptured || ''), verCaptured);
  db.as(A, cmp(A, { id: 'mc_' + 'a'.repeat(16), outcome: 'VERIFIED_POSITIVE_EV', kind: 'LIVE_SPORTSBOOK_QUOTE', captured: at(-140), ev: '0.031' }));
  chk('VERIFIED POSITIVE EV on a live, timestamped quote is stored', db.as(A, "select count(*) from public.market_comparisons where outcome = 'VERIFIED_POSITIVE_EV'").trim() === '1');
  chk('NO CURRENT ODDS cannot carry an EV', db.mustFail(() => db.as(A, cmp(A, { id: 'mc_' + 'b'.repeat(16), outcome: 'NO_CURRENT_ODDS', kind: null, odds: null, captured: null, ev: '0.02' }))) !== null);

  /* ═══ 5. WRITE ONCE, NO READER DELETES, ONE RETENTION DOOR ═════════════ */
  chk('a snapshot cannot be updated (not even by the service role)', /write-once/.test(db.mustFail(() => db.service("update public.projection_snapshots set frozen_at = now()")) || ''));
  chk('a comparison cannot be updated', /write-once/.test(db.mustFail(() => db.service("update public.market_comparisons set outcome = 'VERIFIED_POSITIVE_EV'")) || ''));
  chk('a reader cannot delete a snapshot', db.mustFail(() => db.as(A, 'delete from public.projection_snapshots')) !== null || db.service('select count(*) from public.projection_snapshots').trim() === '1');
  chk('even the service role cannot delete outside retention', /independent_projections_prune/.test(db.mustFail(() => db.service('delete from public.market_comparisons')) || ''));
  chk('a reader cannot run the retention function', db.mustFail(() => db.as(A, 'select public.independent_projections_prune(90)')) !== null);
  chk('retention never goes below 90 days', db.service('select public.independent_projections_prune(1)').trim() === '0');
  db.sql("alter table public.market_comparisons disable trigger market_comparisons_immutable_trg; update public.market_comparisons set created_at = now() - interval '500 days'; alter table public.market_comparisons enable trigger market_comparisons_immutable_trg;"
    + " alter table public.projection_snapshots disable trigger projection_snapshots_immutable_trg; update public.projection_snapshots set created_at = created_at - interval '500 days', frozen_at = frozen_at - interval '500 days', window_from = window_from - interval '500 days', window_to = window_to - interval '500 days'; alter table public.projection_snapshots enable trigger projection_snapshots_immutable_trg;");
  const pr = db.service('select public.independent_projections_prune(400)').trim();
  chk('the service role prunes rows past retention (comparisons, then their snapshot)', pr === '3' && db.service('select count(*) from public.projection_snapshots').trim() === '0', pr);

  /* ═══ 6. ROLLBACK ═════════════════════════════════════════════════════ */
  const rb = db.applyFile(ROLLBACK);
  chk('the rollback removes the two ledgers', /\|\s*ok/.test(rb) && db.sql("select to_regclass('public.projection_snapshots') is null and to_regclass('public.market_comparisons') is null").trim() === 't', rb);
  const r3 = db.applyFile(FILE);
  chk('…and the migration applies cleanly again afterwards', !/CHECK THIS/.test(r3), r3.slice(-400));
} catch (e) {
  fail++; failures.push({ name: 'the suite threw', detail: String(e && e.message || e).slice(0, 600) });
}
done(db);
