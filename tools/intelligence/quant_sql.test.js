#!/usr/bin/env node
/* ===========================================================================
   supabase/quant_desk.sql AGAINST A REAL POSTGRESQL.

   Applied twice to a throwaway cluster with the Supabase auth shim, then
   attacked as three different callers (two readers and the service role):
     - the report reads ok on both runs, and re-running keeps every row
     - a reader writes and reads only their own audit and estimate rows;
       anon reads nothing
     - the ledgers are write-once and a reader can never delete; the
       retention function is the one door and only the service role holds it
     - the unit errors the engine refuses are refused here too (a percent as
       a probability, 100 cents, -50 American odds)
     - a backtest whose training window overlaps its test window, or that
       recorded a look-ahead violation, cannot be stored
     - only the service role writes a fee schedule, and it needs an https
       source and a verifier
     - the grades view joins the close by sig_key and runs with the caller's
       rights
     - migration safety: no DROP TABLE / TRUNCATE / DELETE outside the
       retention function, and no psql meta-commands

   Run: node tools/intelligence/quant_sql.test.js
   (QUANT_SQL_REQUIRED=1 turns a missing PostgreSQL into a failure, as CI sets it.)
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const FILE = path.join(PG.ROOT, 'supabase', 'quant_desk.sql');

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
  const deletes = (code.match(/\bdelete\s+from\b/gi) || []).length;
  chk('the only DELETEs are the two inside the retention function', deletes === 2, deletes);
  chk('every table is created with IF NOT EXISTS', (code.match(/create table (?!if not exists)/gi) || []).length === 0);
  chk('it touches no billing, auth or entitlement relation', !/\b(subscriptions|billing_|stripe|auth\.users|my_billing_access|ai_usage)\b/i.test(code));
  chk('it ends in a report', /THE REPORT\.\s*\nselect /.test(text));
}

const db = PG.start('quantsql');
if (db.skip) {
  console.log('SKIP: ' + db.skip);
  if (process.env.QUANT_SQL_REQUIRED === '1') { fail++; failures.push({ name: 'PostgreSQL required', detail: db.skip }); }
  done(null);
}
const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const L = PG.lit;
/* the helper wraps each call in a transaction: every statement needs its semicolon */
const semi = (t) => /;\s*$/.test(t) ? t : t + ';';
['as', 'anon', 'service'].forEach((k) => { const f = db[k] && db[k].bind(db); if (f) db[k] = k === 'as' ? (u, t) => f(u, semi(t)) : (t) => f(semi(t)); });
try {
  /* a minimal signals table, as the deployed one carries these columns */
  db.sql(`create table public.signals (sig_key text primary key, closing_sharp_fair numeric, clv numeric, result text, graded_at timestamptz);
          insert into public.signals values ('k1', 0.55, 0.021, 'win', now());`);

  /* Supabase's own default: authenticated and anon are granted ALL on new public tables */
  db.sql('alter default privileges for role postgres in schema public grant all on tables to anon, authenticated;');

  /* ═══ 1. APPLY, TWICE ═════════════════════════════════════════════════ */
  const r1 = db.applyFile(FILE);
  chk('first apply: every report row ok', !/CHECK THIS/.test(r1) && (r1.match(/\|\s*ok/g) || []).length >= 9, r1.slice(-900));
  const audit = (id, uid, over) => `insert into public.opportunity_audits (audit_id, user_id, audited_at, candidate_id, sport, game_id, market, selection, odds_american, sig_key, fair_probability, status, reason, independent_ev, rounds, checks, classification, calc_version, audit_version)
    values (${L(id)}, ${L(uid)}, now(), 'baseball_mlb|g1|h2h|away', 'baseball_mlb', 'g1', 'h2h', 'Tampa Bay Rays', ${over && over.odds != null ? over.odds : 120}, 'k1', ${over && over.fair != null ? over.fair : 0.4655}, ${L(over && over.status || 'CONFIRMED')}, 'every check passed', 0.024, ${over && over.rounds || 1}, '[{"id":"A1_GAME_STATUS","result":"PASS"}]'::jsonb, 'VERIFIED_EDGE', 'fairodds_calc_1.0.0', 'edgedesk_audit_v1')`;
  db.as(A, audit('aud_1', A));
  /* an earlier apply of this file keyed the ledgers globally: emulate it, then re-apply */
  db.sql(`alter table public.opportunity_audits drop constraint opportunity_audits_user_audit_key; alter table public.opportunity_audits add constraint opportunity_audits_audit_id_key unique (audit_id);
          alter table public.fair_price_estimates drop constraint fair_price_estimates_user_estimate_key; alter table public.fair_price_estimates add constraint fair_price_estimates_estimate_id_key unique (estimate_id);`);
  const r2 = db.applyFile(FILE);
  chk('second apply: still ok (idempotent)', !/CHECK THIS/.test(r2), r2.slice(-600));
  chk('…and it replaced the old global keys with per-user keys', /per-user ledger keys\s*\|\s*ok/.test(r2), r2.slice(-900));
  chk('re-running kept the row', db.service('select count(*) from public.opportunity_audits').trim() === '1');

  /* ═══ 2. ROW LEVEL SECURITY ═══════════════════════════════════════════ */
  chk('a reader reads their own audit', db.as(A, 'select count(*) from public.opportunity_audits').trim() === '1');
  chk('another reader reads none of it', db.as(B, 'select count(*) from public.opportunity_audits').trim() === '0');
  chk('a reader cannot write a row as someone else', db.mustFail(() => db.as(B, audit('aud_2', A))) !== null);
  const anonRead = db.mustFail(() => db.anon('select count(*) from public.opportunity_audits'));
  chk('anon cannot read the audit trail', anonRead !== null || db.anon('select count(*) from public.opportunity_audits').trim() === '0', anonRead);
  chk('the service role reads everything', db.service('select count(*) from public.opportunity_audits').trim() === '1');

  /* ═══ 2b. PER-USER KEYS, NO TRUNCATE (security audit S8, S12) ══════════ */
  db.as(B, audit('aud_1', B) + ' on conflict (user_id, audit_id) do nothing');
  chk('another user\'s identical audit id is stored for them, not swallowed', db.as(B, "select count(*) from public.opportunity_audits where audit_id = 'aud_1'").trim() === '1');
  db.as(A, audit('aud_1', A) + ' on conflict (user_id, audit_id) do nothing');
  chk('the same user\'s repeat of an id is ignored (deduplicated)', db.as(A, "select count(*) from public.opportunity_audits where audit_id = 'aud_1'").trim() === '1');
  chk('a reader cannot TRUNCATE the audit trail (it would bypass the row triggers)', db.mustFail(() => db.as(A, 'truncate public.opportunity_audits')) !== null);
  chk('…nor the estimates', db.mustFail(() => db.as(A, 'truncate public.fair_price_estimates')) !== null);
  chk('…nor the fee schedules', db.mustFail(() => db.as(A, 'truncate public.market_execution_costs')) !== null);
  const grants = db.sql("select string_agg(distinct privilege_type, ',' order by privilege_type) from information_schema.role_table_grants where grantee = 'authenticated' and table_schema = 'public' and table_name in ('opportunity_audits','fair_price_estimates')");
  chk('authenticated holds only SELECT and INSERT on the ledgers', grants.trim() === 'INSERT,SELECT', grants);
  db.sql("select set_config('edgedesk.quant_prune', 'on', false); delete from public.opportunity_audits where user_id = '" + B + "';");

  /* ═══ 3. WRITE ONCE, NO READER DELETES, ONE RETENTION DOOR ═════════════ */
  chk('an audit row cannot be updated', /write-once/.test(db.mustFail(() => db.service("update public.opportunity_audits set status = 'REJECTED' where audit_id = 'aud_1'")) || ''));
  chk('a reader cannot delete an audit row', db.mustFail(() => db.as(A, "delete from public.opportunity_audits where audit_id = 'aud_1'")) !== null || db.service('select count(*) from public.opportunity_audits').trim() === '1');
  chk('even the service role cannot delete outside retention', /quant_desk_prune/.test(db.mustFail(() => db.service("delete from public.opportunity_audits where audit_id = 'aud_1'")) || ''));
  chk('a reader cannot run the retention function', db.mustFail(() => db.as(A, 'select * from public.quant_desk_prune(90)')) !== null);
  db.sql("alter table public.opportunity_audits disable trigger opportunity_audits_immutable_trg; update public.opportunity_audits set created_at = now() - interval '500 days' where audit_id = 'aud_1'; alter table public.opportunity_audits enable trigger opportunity_audits_immutable_trg;");
  db.as(A, audit('aud_3', A));
  const pr = db.service('select table_name, removed from public.quant_desk_prune(400)');
  chk('the service role prunes rows past retention, and only those', /opportunity_audits\s*\|\s*1/.test(pr) && db.service('select string_agg(audit_id, \',\') from public.opportunity_audits').trim() === 'aud_3', pr);
  const pr2 = db.service('select removed from public.quant_desk_prune(1) where table_name = \'opportunity_audits\'');
  chk('retention never goes below 90 days, whatever is asked', pr2.trim() === '0', pr2);
  chk('after pruning, a direct delete is refused again', db.mustFail(() => db.service("delete from public.opportunity_audits where audit_id = 'aud_3'")) !== null);

  /* ═══ 4. UNITS ════════════════════════════════════════════════════════ */
  chk('a percent as a probability is refused', db.mustFail(() => db.as(A, audit('aud_4', A, { fair: 46.55 }))) !== null);
  chk('-50 American odds are refused', db.mustFail(() => db.as(A, audit('aud_5', A, { odds: -50 }))) !== null);
  chk('an unknown audit status is refused', db.mustFail(() => db.as(A, audit('aud_6', A, { status: 'MAYBE' }))) !== null);
  chk('more than three audit rounds is refused', db.mustFail(() => db.as(A, audit('aud_7', A, { rounds: 5 }))) !== null);
  const est = (id, over) => `insert into public.fair_price_estimates (estimate_id, user_id, evaluated_at, kind, venue, side, selection, price_cents, american, market_probability, fair_probability, fair_kind, break_even_probability, gross_expected_value, net_expected_value, net_ev_per_dollar, expected_fee_per_contract, fee_status, maximum_entry_price, classification, decision, calc_version)
    values (${L(id)}, ${L(A)}, now(), ${L(over && over.kind || 'CONTRACT')}, 'kalshi', 'YES', 'Cleveland Guardians', ${over && over.cents !== undefined ? over.cents : 49}, ${over && over.american !== undefined ? over.american : 'null'}, 0.49, 0.5345, 'SHARP_NO_VIG', 0.51, 0.0445, 0.0245, 0.048, 0.02, 'UNVERIFIED', 0.51, 'POTENTIAL_EDGE', 'WATCH', 'fairodds_calc_1.0.0')`;
  db.as(A, est('fpe_1'));
  chk('a contract check is stored', db.as(A, 'select count(*) from public.fair_price_estimates').trim() === '1');
  chk('100 cents is not a contract price', db.mustFail(() => db.as(A, est('fpe_2', { cents: 100 }))) !== null);
  chk('a contract check needs its price', db.mustFail(() => db.as(A, est('fpe_3', { cents: 'null' }))) !== null);
  chk('a wager check needs American odds of at least 100 in size', db.mustFail(() => db.as(A, est('fpe_4', { kind: 'WAGER', cents: 'null', american: -50 }))) !== null);
  chk('an estimate is write-once', db.mustFail(() => db.service("update public.fair_price_estimates set decision = 'BUY'")) !== null);
  chk('another reader cannot see the estimate', db.as(B, 'select count(*) from public.fair_price_estimates').trim() === '0');
  chk('the same estimate id is not written twice', db.mustFail(() => db.as(A, est('fpe_1'))) !== null);

  /* ═══ 5. BACKTESTS: CHRONOLOGY AND NO LOOK-AHEAD ═══════════════════════ */
  const bt = (id, trainTo, testFrom, la) => `insert into public.model_backtests (backtest_id, sport, market, model_version, train_to, test_from, test_to, n, brier, baseline_brier, lookahead_violations, calibration_status)
    values (${L(id)}, 'americanfootball_nfl', 'spreads', 'edgedesk_football_v1', ${L(trainTo)}, ${L(testFrom)}, '2025-02-15', 272, 0.2489, 0.2493, ${la || 0}, 'NOT_CALIBRATED')`;
  db.service(bt('bt_1', '2024-02-15', '2024-09-01'));
  chk('a chronologically separated backtest is stored', db.service('select count(*) from public.model_backtests').trim() === '1');
  chk('a training window that reaches the test window is refused', db.mustFail(() => db.service(bt('bt_2', '2024-09-01', '2024-09-01'))) !== null);
  chk('a run with any look-ahead violation is refused', db.mustFail(() => db.service(bt('bt_3', '2024-02-15', '2024-09-01', 3))) !== null);
  chk('a reader reads backtests but cannot write one', db.as(A, 'select count(*) from public.model_backtests').trim() === '1' && db.mustFail(() => db.as(A, bt('bt_4', '2024-02-15', '2024-09-01'))) !== null);

  /* ═══ 6. FEE SCHEDULES ════════════════════════════════════════════════ */
  const fee = (src, by, coef) => `insert into public.market_execution_costs (venue, category, fee_kind, taker_coefficient, maker_coefficient, rounding, effective_from, source_url, verified_at, verified_by)
    values ('kalshi', 'sports', 'KALSHI_QUADRATIC', ${coef == null ? 0.07 : coef}, 0.0175, 'CEIL_CENT_PER_ORDER', '2026-01-01', ${L(src)}, now(), ${L(by)})`;
  chk('a reader cannot write a fee schedule', db.mustFail(() => db.as(A, fee('https://kalshi.com/docs/kalshi-fee-schedule.pdf', 'reader'))) !== null);
  db.service(fee('https://kalshi.com/docs/kalshi-fee-schedule.pdf', 'operator'));
  chk('the service role writes a verified schedule, and a reader can read it', db.as(A, "select taker_coefficient from public.market_execution_costs where venue = 'kalshi'").trim() === '0.07');
  chk('a schedule needs an https source', db.mustFail(() => db.service(fee('http://example.com', 'operator').replace("'2026-01-01'", "'2026-02-01'"))) !== null);
  chk('a schedule needs a verifier', db.mustFail(() => db.service(fee('https://kalshi.com/x', '').replace("'2026-01-01'", "'2026-03-01'"))) !== null);
  chk('a coefficient of 7 (a percent) is refused', db.mustFail(() => db.service(fee('https://kalshi.com/x', 'operator', 7).replace("'2026-01-01'", "'2026-04-01'"))) !== null);
  chk('the same venue, category and start is not written twice', db.mustFail(() => db.service(fee('https://kalshi.com/docs/kalshi-fee-schedule.pdf', 'operator'))) !== null);
  chk('a Kalshi schedule without its coefficient is refused', db.mustFail(() => db.service(fee('https://kalshi.com/x', 'operator', 'null').replace("'2026-01-01'", "'2026-05-01'"))) !== null);

  /* ═══ 7. THE GRADES VIEW ══════════════════════════════════════════════ */
  const g = db.as(A, "select audit_id, closing_fair, clv, result from public.opportunity_audit_grades");
  chk('the grade joins the close and the result by sig_key', /aud_3\s*\|\s*0\.55\s*\|\s*0\.021\s*\|\s*win/.test(g), g);
  chk('another reader sees no grades of A\'s audits', db.as(B, 'select count(*) from public.opportunity_audit_grades').trim() === '0');
  chk('the view runs with the caller\'s rights', db.sql("select reloptions::text from pg_class where relname = 'opportunity_audit_grades'").indexOf('security_invoker=true') >= 0);
} catch (e) {
  fail++; failures.push({ name: 'the suite threw', detail: String(e && (e.sqlMessage || e.message)).slice(0, 600) });
}
done(db);
