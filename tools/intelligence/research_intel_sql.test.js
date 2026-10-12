#!/usr/bin/env node
/* ===========================================================================
   supabase/research_intel.sql against a real PostgreSQL 16 (tools/personal/_pg.js).

   Applied twice, then attacked: a reader reading or writing someone else's
   research, a finding with no https source, an EdgeDesk-written conclusion
   stored as evidence, a speculative report stored as verified, a prediction
   snapshot taken after kickoff, a ledger row rewritten or deleted, a reader
   raising a provider cap or spending past it, a claim settled twice.
   Applied over the older desk table production holds under research_findings,
   and refused, with nothing written, when another table holds a name it owns.

   Run: node tools/intelligence/research_intel_sql.test.js
   (RESEARCH_SQL_REQUIRED=1 makes a missing PostgreSQL a failure)
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const { preflightChecks } = require(path.join(__dirname, '_preflight.js'));
const FILE = path.join(PG.ROOT, 'supabase', 'research_intel.sql');

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
  chk('it touches no billing, auth or entitlement relation', !/\b(subscriptions|billing_|stripe|auth\.users|my_billing_access|ai_usage|portfolio_)\b/i.test(code));
  chk('it ends in a report', /THE REPORT\.\s*\nselect /.test(text));
}

const db = PG.start('researchintel');
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
try {
  db.sql('alter default privileges for role postgres in schema public grant all on tables to anon, authenticated;');
  db.sql(`create table public.signals (sig_key text primary key, closing_sharp_fair numeric, clv numeric, result text, graded_at timestamptz);
          insert into public.signals values ('k1', 0.55, 0.021, 'win', now());`);
  /* Production already holds an older desk table named research_findings (rememberSession() in edgedesk_ai).
     Run #19 of Deploy intelligence stopped on it after replacing its comment with the findings table's. */
  const PHASE2_COMMENT = "Write-once sourced findings the research chain used (supabase/functions/edgedesk_ai/_agents.js). A reader''s own research memory.";
  db.sql(`create table public.research_findings (id bigint generated always as identity primary key, created_at timestamptz default now(), entity text, fact_type text, claim text, fact_value text,
            source text, source_timestamp timestamptz, verification_status text, confidence text, valid_until timestamptz, sport text);
          insert into public.research_findings (entity, fact_type, claim, source, sport) values ('Buffalo Bills', 'injury', 'Josh Allen questionable', 'nflverse', 'americanfootball_nfl');
          comment on table public.research_findings is '${PHASE2_COMMENT}';`);
  const legacyCols = () => db.sql("select string_agg(attname::text, ',' order by attnum) from pg_attribute where attrelid = 'public.research_findings'::regclass and attnum > 0 and not attisdropped").trim();
  const legacyBefore = legacyCols();
  const legacyComment = () => db.sql("select obj_description('public.research_findings'::regclass, 'pg_class')").trim();

  /* ═══ 1. APPLY, TWICE ═════════════════════════════════════════════════ */
  const r1 = db.applyFile(FILE);
  chk('first apply: every report row ok', !/CHECK THIS/.test(r1) && (r1.match(/\|\s*ok/g) || []).length >= 9, r1.slice(-900));
  chk('the older desk table research_findings is untouched: same columns, its row kept', legacyCols() === legacyBefore && db.sql('select count(*) from public.research_findings').trim() === '1', legacyCols());
  chk('…and the comment run #19 left on it is replaced by a true description', /rememberSession\(\)/.test(legacyComment()) && !/research chain used/.test(legacyComment()), legacyComment());
  db.sql("comment on table public.research_findings is 'owner note'");
  preflightChecks(db, FILE, chk);
  const finding = (id, uid, over) => {
    const o = Object.assign({ provider: 'nflverse_injuries', topic: 'availability', claim: 'Josh Allen (QB) Out', url: 'https://github.com/nflverse/nflverse-data/releases/download/injuries/injuries_2026.csv', reliability: 'OFFICIAL', verified: true, speculative: false, retrieved: 'now()', published: "now() - interval '1 hour'" }, over || {});
    return `insert into public.research_chain_findings (finding_id, user_id, provider, sport, event_ref, team, player, topic, claim, status, source_url, publisher, published_at, retrieved_at, reliability, verified, speculative)
      values (${L(id)}, ${L(uid)}, ${L(o.provider)}, 'americanfootball_nfl', 'ev-det-buf', 'Buffalo Bills', 'Josh Allen', ${L(o.topic)}, ${L(o.claim)}, 'OUT', ${L(o.url)}, 'github.com', ${o.published}, ${o.retrieved}, ${L(o.reliability)}, ${o.verified}, ${o.speculative})`;
  };
  db.as(A, finding('f_00000001', A));
  const r2 = db.applyFile(FILE);
  chk('second apply: still ok (idempotent), the row kept', !/CHECK THIS/.test(r2) && db.service('select count(*) from public.research_chain_findings').trim() === '1', r2.slice(-600));
  chk('…and a comment anyone else wrote on the older table is left alone', legacyComment() === 'owner note', legacyComment());

  /* ═══ 2. FINDINGS ═════════════════════════════════════════════════════ */
  chk('a reader reads their own finding; another reads none', db.as(A, 'select count(*) from public.research_chain_findings').trim() === '1' && db.as(B, 'select count(*) from public.research_chain_findings').trim() === '0');
  chk('a reader cannot write a finding as someone else', db.mustFail(() => db.as(B, finding('f_00000002', A))) !== null);
  chk('an EdgeDesk-written conclusion is refused as evidence', db.mustFail(() => db.as(A, finding('f_00000003', A, { provider: 'edgedesk_ai' }))) !== null);
  chk('a source that is not https is refused', db.mustFail(() => db.as(A, finding('f_00000004', A, { url: 'http://example.com/x' }))) !== null);
  chk('a speculative finding cannot be stored as verified', db.mustFail(() => db.as(A, finding('f_00000005', A, { reliability: 'SPECULATION', speculative: true, verified: true }))) !== null);
  chk('a finding with no retrieval time is refused', db.mustFail(() => db.as(A, finding('f_00000006', A, { retrieved: 'null' }))) !== null);
  chk('an unknown reliability class is refused', db.mustFail(() => db.as(A, finding('f_00000007', A, { reliability: 'TRUST_ME' }))) !== null);
  chk('the same finding id twice for one reader is refused', db.mustFail(() => db.as(A, finding('f_00000001', A))) !== null);
  db.as(B, finding('f_00000001', B));
  chk('…but another reader may hold the same id (keys are per user)', db.as(B, "select count(*) from public.research_chain_findings where finding_id = 'f_00000001'").trim() === '1');
  chk('a finding is write-once', /write-once/.test(db.mustFail(() => db.service("update public.research_chain_findings set claim = 'edited'")) || ''));
  chk('a reader cannot delete it', db.mustFail(() => db.as(A, 'delete from public.research_chain_findings')) !== null || db.service('select count(*) from public.research_chain_findings').trim() === '2');
  chk('even the service role cannot delete outside retention', /research_intel_prune/.test(db.mustFail(() => db.service('delete from public.research_chain_findings')) || ''));
  chk('a reader cannot TRUNCATE research memory', db.mustFail(() => db.as(A, 'truncate public.research_chain_findings')) !== null);

  /* ═══ 3. PREDICTION SNAPSHOTS ═════════════════════════════════════════ */
  const snap = (id, uid, start, over) => {
    const o = Object.assign({ cls: 'WATCHLIST', captured: "now() - interval '5 minutes'" }, over || {});
    return `insert into public.prediction_snapshots (snapshot_id, user_id, sport, event_id, event_start, market, selection, line, sig_key, book, odds_american, odds_decimal, quote_captured_at, fair_probability, fair_kind, model_version, model_tier, net_ev_per_dollar, classification, reasons, finding_ids, research_level)
      values (${L(id)}, ${L(uid)}, 'americanfootball_nfl', 'ev-det-buf', ${start}, 'spreads', 'Buffalo Bills', -2.5, 'k1', 'FanDuel', -105, 1.95, ${o.captured}, 0.532, 'SHARP_NO_VIG', null, null, 0.0374, ${L(o.cls)}, '["strategist: CAUTION"]'::jsonb, '{f_00000001}', 'L3')`;
  };
  db.as(A, snap('ps_0000000000000001', A, "now() + interval '1 day'"));
  chk('a pregame snapshot is stored', db.as(A, 'select count(*) from public.prediction_snapshots').trim() === '1');
  chk('a snapshot for an event that has started is refused (no look-ahead)', /started/.test(db.mustFail(() => db.as(A, snap('ps_0000000000000002', A, "now() - interval '1 minute'"))) || ''));
  chk('a snapshot pricing a quote captured after the start is refused', db.mustFail(() => db.as(A, snap('ps_0000000000000003', A, "now() + interval '1 hour'", { captured: "now() + interval '2 hours'" }))) !== null);
  chk('an unknown classification is refused', db.mustFail(() => db.as(A, snap('ps_0000000000000004', A, "now() + interval '1 day'", { cls: 'MAYBE' }))) !== null);
  const cols = db.sql("select string_agg(column_name, ',') from information_schema.columns where table_schema = 'public' and table_name = 'prediction_snapshots'");
  chk('a snapshot table has no outcome column (grading joins the close later)', !/\b(result|outcome|closing|won|profit)\b/.test(cols), cols);
  chk('a snapshot is write-once', db.mustFail(() => db.service("update public.prediction_snapshots set classification = 'VERIFIED_CANDIDATE'")) !== null);
  chk('another reader sees none of A\'s snapshots', db.as(B, 'select count(*) from public.prediction_snapshots').trim() === '0');
  const g = db.as(A, 'select snapshot_id, closing_fair, result from public.prediction_snapshot_grades');
  chk('the grade joins the close and the result by sig_key', /ps_0000000000000001\s*\|\s*0\.55\s*\|\s*win/.test(g), g);

  /* ═══ 4. PROVIDER QUOTAS AND THE USAGE LEDGER ═════════════════════════ */
  const claim = (uid, p) => JSON.parse(db.as(uid, `select public.research_usage_claim(${L(p)})`).trim());
  const c0 = claim(A, 'perplexity_sonar');
  chk('a paid provider is disabled until the operator enables it', c0.ok === false && /not enabled/.test(c0.why), c0);
  chk('a reader cannot enable it (no write on the quota table)', db.mustFail(() => db.as(A, "update public.research_provider_quota set enabled = true where provider = 'perplexity_sonar'")) !== null);
  chk('a reader cannot write usage rows directly', db.mustFail(() => db.as(A, "insert into public.research_usage (user_id, provider, state) values ('" + A + "', 'perplexity_sonar', 'OK')")) !== null);
  db.service("update public.research_provider_quota set enabled = true, daily_limit = 3, per_user_daily = 2 where provider = 'perplexity_sonar'");
  const c1 = claim(A, 'perplexity_sonar'), c2 = claim(A, 'perplexity_sonar'), c3 = claim(A, 'perplexity_sonar');
  chk('claims inside the caps are granted, with the cost estimate', c1.ok && c2.ok && Number(c1.cost_estimate_usd) > 0, [c1, c2]);
  chk('the per-user daily allowance stops the third', c3.ok === false && /your daily allowance/.test(c3.why), c3);
  const c4 = claim(B, 'perplexity_sonar'), c5 = claim(B, 'perplexity_sonar');
  chk('the provider daily limit stops everyone once reached', c4.ok === true && c5.ok === false && /daily limit/.test(c5.why), [c4, c5]);
  const s1 = JSON.parse(db.as(A, `select public.research_usage_settle(${c1.claim_id}, 'OK', 420)`).trim());
  const s2 = JSON.parse(db.as(A, `select public.research_usage_settle(${c1.claim_id}, 'ERROR', 10)`).trim());
  const s3 = JSON.parse(db.as(B, `select public.research_usage_settle(${c2.claim_id}, 'OK', 10)`).trim());
  chk('a claim is settled once, by its owner only', s1.ok === true && s2.ok === false && s3.ok === false, [s1, s2, s3]);
  chk('a settled ledger row cannot be rewritten', db.mustFail(() => db.service(`update public.research_usage set state = 'CLAIMED' where id = ${c1.claim_id}`)) !== null);
  chk('a reader sees only their own usage', db.as(B, 'select count(*) from public.research_usage').trim() === db.service(`select count(*) from public.research_usage where user_id = '${B}'`).trim());
  chk('an unknown provider is refused', /unknown research provider/.test(claim(A, 'magic_search').why));
  const anonClaim = db.mustFail(() => db.anon("select public.research_usage_claim('open_meteo')"));
  chk('anon cannot claim research', anonClaim !== null || /sign in/.test(db.anon("select public.research_usage_claim('open_meteo')")), anonClaim);

  /* ═══ 5. RETENTION ════════════════════════════════════════════════════ */
  chk('a reader cannot run the retention function', db.mustFail(() => db.as(A, 'select * from public.research_intel_prune(90)')) !== null);
  db.sql("alter table public.research_chain_findings disable trigger research_chain_findings_immutable_trg; update public.research_chain_findings set created_at = now() - interval '400 days' where user_id = '" + A + "'; alter table public.research_chain_findings enable trigger research_chain_findings_immutable_trg;");
  const pr = db.service('select table_name, removed from public.research_intel_prune(200)');
  chk('the service role prunes findings past retention, and only those', /research_chain_findings\s*\|\s*1/.test(pr) && db.service('select count(*) from public.research_chain_findings').trim() === '1', pr);
  chk('snapshots are not pruned', db.service('select count(*) from public.prediction_snapshots').trim() === '1');
  const pr2 = db.service("select removed from public.research_intel_prune(1) where table_name = 'research_chain_findings'");
  chk('retention never goes below 90 days', pr2.trim() === '0', pr2);

  /* ═══ 6. PREFLIGHT ════════════════════════════════════════════════════ */
  db.sql(`alter table public.research_chain_findings rename to rcf_keep;
          create table public.research_chain_findings (entity text, claim text);
          comment on table public.research_provider_quota is 'marker';`);
  const refused = db.mustFail(() => db.applyFile(FILE));
  chk('PREFLIGHT: another table under a name the file owns stops it, and names the table', /stopped before changing anything: public\.research_chain_findings already exists[\s\S]*it has no/.test(refused || ''), refused);
  chk('PREFLIGHT: …before anything was written', db.sql("select obj_description('public.research_provider_quota'::regclass, 'pg_class')").trim() === 'marker');
  db.sql('drop table public.research_chain_findings; alter table public.rcf_keep rename to research_chain_findings;');
  const back = db.applyFile(FILE);
  chk('PREFLIGHT: with the name free again, it applies', !/CHECK THIS/.test(back) && db.service('select count(*) from public.research_chain_findings').trim() === '1', back.slice(-300));
} catch (e) {
  fail++; failures.push({ name: 'the suite threw', detail: String(e && (e.sqlMessage || e.message)).slice(0, 600) });
}
done(db);
