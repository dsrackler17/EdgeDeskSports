#!/usr/bin/env node
/* ===========================================================================
   supabase/research_engine.sql against a real PostgreSQL 16 (tools/personal/_pg.js),
   on top of supabase/research_intel.sql.

   Applied twice, then attacked: run memory read or written across readers, a
   run with predictions written after its event started, an outcome graded
   before its event or for a snapshot that was never frozen, a reader writing
   an outcome or raising a dollar cap, spend past the per-request, per-reader
   and global caps, a claim settled twice or by someone else, rows rewritten
   or deleted outside retention. And: nothing in research_intel.sql changes.

   Run: node tools/intelligence/research_engine_sql.test.js
   (RESEARCH_SQL_REQUIRED=1 makes a missing PostgreSQL a failure)
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const FILE = path.join(PG.ROOT, 'supabase', 'research_engine.sql');
const INTEL = path.join(PG.ROOT, 'supabase', 'research_intel.sql');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push({ name, detail }); }
function done(db) {
  if (db && db.stop) try { db.stop(); } catch (_) { /* ignore */ }
  failures.forEach((f) => console.log('FAIL | ' + f.name + '  ' + String(JSON.stringify(f.detail) || '').slice(0, 600)));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

/* ═══ 0. STATIC MIGRATION SAFETY ═════════════════════════════════════════ */
{
  const text = fs.readFileSync(FILE, 'utf8');
  const code = text.replace(/--[^\n]*/g, '');
  chk('no psql meta-commands', !/^\s*\\/m.test(code));
  chk('no DROP TABLE, TRUNCATE or DROP COLUMN', !/\bdrop\s+table\b|\btruncate\b|\bdrop\s+column\b/i.test(code));
  chk('the only DELETEs are the two inside the retention function', (code.match(/\bdelete\s+from\b/gi) || []).length === 2);
  chk('every table is created with IF NOT EXISTS', (code.match(/create table (?!if not exists)/gi) || []).length === 0);
  chk('it alters no table research_intel.sql owns (additive only)', !/alter table public\.(research_findings|prediction_snapshots|research_usage|research_provider_quota)\b/i.test(code) && !/create or replace function public\.(research_usage_claim|research_usage_settle|research_intel_\w+)\b/i.test(code));
  chk('its only write to research_provider_quota is an insert that never overwrites', (code.match(/insert into public\.research_provider_quota/gi) || []).length === 1 && /on conflict \(provider\) do nothing/i.test(code) && !/update public\.research_provider_quota/i.test(code));
  chk('it touches no billing, auth or entitlement relation', !/\b(subscriptions|billing_|stripe|auth\.users|my_billing_access|ai_usage|portfolio_)\b/i.test(code));
  chk('it says it does not retrain or adjust any model', /does not retrain or change any model/i.test(text) && /nothing reads it to adjust a\s+--\s+probability|nothing here adjusts a model/i.test(text));
  chk('it ends in a report', /THE REPORT\.\s*\nselect /.test(text));
}

const db = PG.start('researchengine');
if (db.skip) {
  console.log('SKIP: ' + db.skip);
  if (process.env.RESEARCH_SQL_REQUIRED === '1') { fail++; failures.push({ name: 'PostgreSQL required', detail: db.skip }); }
  done(null);
}
const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const L = PG.lit;
const semi = (t) => /;\s*$/.test(t) ? t : t + ';';
['as', 'anon', 'service'].forEach((k) => { const f = db[k] && db[k].bind(db); if (f) db[k] = k === 'as' ? (u, t) => f(u, semi(t)) : (t) => f(semi(t)); });
const J = (s) => JSON.parse(String(s).trim());
try {
  db.sql('alter default privileges for role postgres in schema public grant all on tables to anon, authenticated;');
  db.sql(`create table public.signals (sig_key text primary key, closing_sharp_fair numeric, clv numeric, result text, graded_at timestamptz);`);

  /* ═══ 1. ORDER, THEN APPLY TWICE ══════════════════════════════════════ */
  const early = db.mustFail(() => db.applyFile(FILE));
  chk('without research_intel.sql it refuses, and says which file to apply first', /apply supabase\/research_intel\.sql first/.test(early || ''), early);
  db.applyFile(INTEL);
  const quotaBefore = db.service("select count(*) from public.research_provider_quota where provider not in ('claude_web_search','perplexity_search')").trim();
  const r1 = db.applyFile(FILE);
  chk('first apply: every report row ok', !/CHECK THIS/.test(r1) && (r1.match(/\|\s*ok/g) || []).length >= 11, r1.slice(-1200));
  const r2 = db.applyFile(FILE);
  chk('second apply: still ok (idempotent)', !/CHECK THIS/.test(r2), r2.slice(-600));
  chk('research_intel.sql\'s provider rows are untouched; the two search providers are added paid and disabled', db.service("select count(*) from public.research_provider_quota where provider not in ('claude_web_search','perplexity_search')").trim() === quotaBefore
    && db.service("select count(*) from public.research_provider_quota where provider in ('claude_web_search','perplexity_search') and paid and not enabled").trim() === '2');
  const qc = J(db.as(A, "select public.research_usage_claim('claude_web_search')"));
  chk('the existing quota door still governs the new providers: disabled until the operator enables them', qc.ok === false && /not enabled/.test(qc.why), qc);

  /* ═══ 2. RESEARCH RUNS ════════════════════════════════════════════════ */
  const run = (id, uid, o) => {
    o = Object.assign({ start: "now() + interval '1 day'", snaps: "'{ps_00000000000000aa}'", path: 'ENGINE_RESEARCH', q: "What's the best bet this weekend?", sources: "'[]'::jsonb" }, o || {});
    return `insert into public.research_runs (run_id, user_id, question, route, path, research_level, plan, plan_actual, sources, model_snapshot, market_snapshot, conclusions, final_status, verification, snapshot_ids, cost_usd, cost_estimate_usd, providers, engine_versions, latency_ms, earliest_event_start)
      values (${L(id)}, ${L(uid)}, ${L(o.q)}, 'SCAN', ${L(o.path)}, 'L3', '{"path":"ENGINE_RESEARCH"}'::jsonb, '[{"stage":"FIND_EVENTS","actual":"done"}]'::jsonb, ${o.sources},
        '[{"game_id":"g1","probability":0.52}]'::jsonb, '[{"book":"FanDuel","american":-105}]'::jsonb, '[{"classification":"VERIFIED_CANDIDATE"}]'::jsonb, 'VERIFIED CANDIDATE', '{"verdict":"VERIFIED"}'::jsonb,
        ${o.snaps}, 0.0722, 0.084, '{claude_web_search}', '{"orchestrator":"edgedesk_orchestrator_v1"}'::jsonb, 1800, ${o.start})`;
  };
  db.as(A, run('rr_0000000000000001', A));
  chk('a reader writes their own run; another reads none', db.as(A, 'select count(*) from public.research_runs').trim() === '1' && db.as(B, 'select count(*) from public.research_runs').trim() === '0');
  chk('a reader cannot write a run as someone else', db.mustFail(() => db.as(B, run('rr_0000000000000002', A))) !== null);
  chk('a run with predictions for an event that has started is refused (no look-ahead)', /has started/.test(db.mustFail(() => db.as(A, run('rr_0000000000000003', A, { start: "now() - interval '1 minute'" }))) || ''));
  db.as(A, run('rr_0000000000000004', A, { start: "now() - interval '1 hour'", snaps: "'{}'" }));
  chk('…but research with no prediction (memory only) may be recorded after the game', db.as(A, "select count(*) from public.research_runs where run_id = 'rr_0000000000000004'").trim() === '1');
  chk('an unknown path is refused', db.mustFail(() => db.as(A, run('rr_0000000000000005', A, { path: 'VIBES' }))) !== null);
  chk('a question over 300 characters is refused', db.mustFail(() => db.as(A, run('rr_0000000000000006', A, { q: 'x'.repeat(301) }))) !== null);
  chk('more than 60 sources is refused', db.mustFail(() => db.as(A, run('rr_0000000000000007', A, { sources: "(select jsonb_agg(i) from generate_series(1, 61) i)" }))) !== null);
  chk('the same run id twice for one reader is refused; another reader may hold it', db.mustFail(() => db.as(A, run('rr_0000000000000001', A))) !== null && (db.as(B, run('rr_0000000000000001', B)), db.as(B, 'select count(*) from public.research_runs').trim() === '1'));
  const cols = db.sql("select string_agg(column_name, ',') from information_schema.columns where table_schema = 'public' and table_name = 'research_runs'");
  chk('a run has no outcome column (outcomes live apart)', !/\b(result|outcome|closing|won|profit|clv)\b/.test(cols), cols);
  chk('a run is write-once', /write-once/.test(db.mustFail(() => db.service("update public.research_runs set final_status = 'PASS'")) || ''));
  chk('a reader cannot delete or truncate runs; even the service role deletes only through retention', db.mustFail(() => db.as(A, 'truncate public.research_runs')) !== null && /research_engine_prune/.test(db.mustFail(() => db.service('delete from public.research_runs')) || ''));

  /* ═══ 3. OUTCOMES, APART FROM PREDICTIONS ═════════════════════════════ */
  const snap = (id, uid, start, sig) => `insert into public.prediction_snapshots (snapshot_id, user_id, sport, event_id, event_start, market, selection, line, sig_key, book, odds_american, odds_decimal, quote_captured_at, fair_probability, fair_kind, net_ev_per_dollar, classification, reasons, finding_ids, research_level)
    values (${L(id)}, ${L(uid)}, 'americanfootball_nfl', 'g1', ${start}, 'spreads', 'Buffalo Bills', -2.5, ${L(sig)}, 'FanDuel', -105, 1.95, now() - interval '1 minute', 0.532, 'SHARP_NO_VIG', 0.0374, 'VERIFIED_CANDIDATE', '[]'::jsonb, '{}', 'L3')`;
  db.as(A, snap('ps_00000000000000aa', A, "now() + interval '2 seconds'", 'k1'));
  db.as(A, snap('ps_00000000000000bb', A, "now() + interval '1 day'", 'k2'));
  const outcome = (id, uid, start, over) => `insert into public.research_run_outcomes (snapshot_id, user_id, event_start, result, closing_fair, clv, source) values (${L(id)}, ${L(uid)}, ${start}, ${L((over && over.result) || 'WIN')}, 0.55, 0.018, 'test grader')`;
  const startOf = (id) => db.service(`select event_start from public.prediction_snapshots where snapshot_id = ${L(id)}`).trim();
  chk('a reader cannot write an outcome', db.mustFail(() => db.as(A, outcome('ps_00000000000000aa', A, L(startOf('ps_00000000000000aa'))))) !== null);
  chk('an outcome before its event started is refused', /before its event started/.test(db.mustFail(() => db.service(outcome('ps_00000000000000bb', A, L(startOf('ps_00000000000000bb'))))) || ''));
  db.sql('select pg_sleep(2.2)');
  chk('an outcome for a snapshot that was never frozen is refused', /no frozen snapshot/.test(db.mustFail(() => db.service(outcome('ps_00000000000000cc', A, 'now() - interval \'1 hour\''))) || ''));
  chk('an outcome whose event start differs from the snapshot\'s is refused', db.mustFail(() => db.service(outcome('ps_00000000000000aa', A, "now() - interval '3 days'"))) !== null);
  db.service("insert into public.signals values ('k1', 0.55, 0.018, 'win', now())");
  chk('a reader cannot run the grader', db.mustFail(() => db.as(A, 'select public.research_runs_grade(10)')) !== null);
  const gr = J(db.service('select public.research_runs_grade(10)'));
  chk('the grader writes outcomes only from signals the pipeline graded, for events that started', gr.ok === true && gr.graded === 1 && db.service("select result from public.research_run_outcomes where snapshot_id = 'ps_00000000000000aa'").trim() === 'WIN', gr);
  chk('grading twice writes nothing twice', J(db.service('select public.research_runs_grade(10)')).graded === 0);
  chk('an outcome is write-once', /write-once/.test(db.mustFail(() => db.service("update public.research_run_outcomes set result = 'LOSS'")) || ''));
  const cal = db.as(A, 'select snapshot_id, fair_probability, outcome, clv from public.research_run_calibration');
  chk('the calibration view pairs the frozen probability with its outcome and CLV — for its owner only', /ps_00000000000000aa\s*\|\s*0\.532\s*\|\s*1\s*\|\s*0\.018/.test(cal) && db.as(B, 'select count(*) from public.research_run_calibration').trim() === '0', cal);
  chk('the snapshot itself is unchanged by grading', db.service("select classification || '|' || fair_probability from public.prediction_snapshots where snapshot_id = 'ps_00000000000000aa'").trim() === 'VERIFIED_CANDIDATE|0.532');

  /* ═══ 4. THE DOLLAR BUDGET ════════════════════════════════════════════ */
  const pol = db.as(A, 'select per_request_usd, per_user_daily_usd, global_daily_usd from public.research_budget_policy').trim();
  chk('the default caps: $0.25 per request, $1 per subscriber per day, $20 per day', /0\.25\s*\|\s*1\.00\s*\|\s*20\.00/.test(pol), pol);
  chk('a reader cannot raise a cap', db.mustFail(() => db.as(A, 'update public.research_budget_policy set global_daily_usd = 2000')) !== null);
  chk('a reader cannot write ledger rows directly', db.mustFail(() => db.as(A, `insert into public.research_cost_ledger (user_id, provider, state, estimate_usd) values ('${A}', 'claude_web_search', 'SETTLED', 0)`)) !== null);
  const cc = (uid, usd, p) => J(db.as(uid, `select public.research_cost_claim(${L(p || 'claude_web_search')}, ${usd})`));
  const k0 = cc(A, 0.30);
  chk('an estimate over the per-request cap is refused outright', k0.ok === false && /per-request budget/.test(k0.why), k0);
  const k1 = cc(A, 0.084);
  chk('an estimate inside every cap is claimed, with today\'s committed total', k1.ok === true && Number(k1.committed_today_usd) === 0.084, k1);
  const s1 = J(db.as(A, `select public.research_cost_settle(${k1.claim_id}, 0.0722)`));
  chk('it settles once, with the actual cost; not twice; not by another reader', s1.ok && !J(db.as(A, `select public.research_cost_settle(${k1.claim_id}, 0.01)`)).ok && !J(db.as(B, `select public.research_cost_settle(${cc(A, 0.05).claim_id}, 0.01)`)).ok, s1);
  const ks = [0.2, 0.2, 0.2, 0.2].map((u) => cc(A, u));
  const kOver = cc(A, 0.2);
  chk('the per-subscriber daily cap stops the next claim (settled actuals and open estimates both count)', ks.every((k) => k.ok) && kOver.ok === false && /your research budget for today/.test(kOver.why), [ks.map((k) => k.committed_today_usd), kOver]);
  db.as(A, `select public.research_cost_settle(${ks[3].claim_id}, null, 'RELEASED')`);
  chk('a released claim (no call made) frees its estimate', cc(A, 0.15).ok === true);
  db.service("update public.research_budget_policy set global_daily_usd = 0.90 where scope = 'global'");
  const kB = cc(B, 0.2);
  chk('the global daily cap stops every subscriber once reached', kB.ok === false && /across subscribers/.test(kB.why), kB);
  db.service("update public.research_budget_policy set global_daily_usd = 20 where scope = 'global'");
  chk('a settled claim\'s cost cannot be rewritten', db.mustFail(() => db.service(`update public.research_cost_ledger set actual_usd = 0 where id = ${k1.claim_id}`)) !== null);
  chk('a reader sees only their own claims', db.as(B, 'select count(*) from public.research_cost_ledger').trim() === db.service(`select count(*) from public.research_cost_ledger where user_id = '${B}'`).trim());
  chk('an unknown provider and a nonsense estimate are refused', /unknown research provider/.test(cc(A, 0.01, 'magic_search').why) && /between 0 and 25/.test(cc(A, -1).why));
  const anon = db.mustFail(() => db.anon("select public.research_cost_claim('claude_web_search', 0.01)"));
  chk('anon cannot claim research dollars', anon !== null || /sign in/.test(db.anon("select public.research_cost_claim('claude_web_search', 0.01)")), anon);
  chk('a reader cannot call the committed-total helper directly', db.mustFail(() => db.as(A, `select public.research_cost_committed('${B}')`)) !== null);

  /* ═══ 5. RETENTION ════════════════════════════════════════════════════ */
  chk('a reader cannot run retention', db.mustFail(() => db.as(A, 'select * from public.research_engine_prune(180)')) !== null);
  db.sql("alter table public.research_runs disable trigger research_runs_immutable_trg; update public.research_runs set created_at = now() - interval '400 days' where run_id = 'rr_0000000000000004'; alter table public.research_runs enable trigger research_runs_immutable_trg;");
  const pr = db.service('select table_name, removed from public.research_engine_prune(200)');
  chk('the service role prunes runs past retention, and only those', /research_runs\s*\|\s*1/.test(pr) && db.service('select count(*) from public.research_runs').trim() === '2', pr);
  chk('retention never goes below 180 days', db.service("select removed from public.research_engine_prune(1) where table_name = 'research_runs'").trim() === '0');
  chk('outcomes are never pruned', db.service('select count(*) from public.research_run_outcomes').trim() === '1');
} catch (e) {
  fail++; failures.push({ name: 'the suite threw', detail: String(e && (e.sqlMessage || e.message)).slice(0, 600) });
}
done(db);
