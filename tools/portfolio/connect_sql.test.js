#!/usr/bin/env node
/* ===========================================================================
   supabase/portfolio_connect.sql — THE REGISTRY, THE INGEST AND THE VAULT,
   AGAINST A REAL POSTGRESQL, AS THE SERVICE ROLE AND AS REAL READERS.

   Proves:
     - no connector can be switched on without a passing ten-stage live smoke
       test of its exact version against production, and a cleared terms
       review; a new connector version switches it off again;
     - a reader can call no service function, read no credential, no smoke
       test and no connect session — and a service function refuses a reader
       even if it were granted by mistake;
     - connecting upgrades a reader's QUICK IMPORT account IN PLACE; the
       sealed credential round-trips through the vault and the reader sees
       only its hint;
     - the ingest is idempotent: the same payload twice adds nothing;
       an updated settlement lands on the stored position; an updated fee
       replaces the old one; a malformed position is rejected alone and
       reported, never dropped silently;
     - the P&L the database derives equals the connector core's, which
       equals Kalshi's own netted result;
     - runs: success, a refused key (ACTION REQUIRED, no retry storm),
       backoff, ERROR after five failures, one run at a time;
     - disconnect deletes the credential and keeps or deletes history as
       asked; reconnect reuses the account and duplicates nothing;
     - reader B sees none of it.

   Run: node tools/portfolio/connect_sql.test.js
   (PORTFOLIO_SQL_REQUIRED=1 makes a missing PostgreSQL a failure, for CI.)
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const cp = require('child_process');
const path = require('path');
const nodeCrypto = require('crypto');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const K = require(path.join(PG.ROOT, 'lib', 'edgedesk_portfolio_connect_core.js'));
const E = require(path.join(PG.ROOT, 'lib', 'edgedesk_portfolio.js'));

const T = PG.kit('portfolio connect SQL');
const chk = T.chk;
const L = PG.lit;
const BASE = path.join(PG.ROOT, 'supabase', 'portfolio.sql');
const JOURNAL = path.join(PG.ROOT, 'supabase', 'portfolio_journal.sql');
const FILE = path.join(PG.ROOT, 'supabase', 'portfolio_connect.sql');
const SRC = fs.readFileSync(FILE, 'utf8');

/* ═══ STATIC ═════════════════════════════════════════════════════════════ */
chk('every service function asserts its caller first', (SRC.match(/create or replace function public\.portfolio_svc_(?!assert)\w+/g) || []).length
  === (SRC.match(/perform public\.portfolio_svc_assert\(\);/g) || []).length, (SRC.match(/perform public\.portfolio_svc_assert/g) || []).length);
chk('no sportsbook row seeds an automatic method', !/\('(draftkings|fanduel|betmgm|williamhill_us|bet365)', '[^']+', 'SPORTSBOOK', '(OAUTH|API_KEY|PUBLIC_WALLET|AUTHORIZED_API)'/.test(SRC));
chk('the seed never writes automatic_enabled', !/automatic_enabled\s*=\s*excluded/.test(SRC) && !/insert into public\.portfolio_platform_registry \([^)]*automatic_enabled/.test(SRC));
chk('portfolio.sql\'s reader grant loop leaves the service functions alone', /not like 'portfolio\\_svc\\_%'/.test(fs.readFileSync(BASE, 'utf8')));
(function partsAreCurrent() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfc-parts-'));
  cp.execFileSync(process.execPath, [path.join(PG.ROOT, 'tools', 'sql', 'split_sql.js'), FILE, dir, '18000']);
  const fresh = fs.readdirSync(dir).filter((f) => /^portfolio_connect\.part/.test(f)).sort();
  const committed = fs.readdirSync(path.join(PG.ROOT, 'supabase', 'parts')).filter((f) => /^portfolio_connect\.part/.test(f)).sort();
  chk('supabase/parts/portfolio_connect.part*.sql are current (npm run portfolio:parts)', fresh.length > 0 && JSON.stringify(fresh) === JSON.stringify(committed)
    && fresh.every((f) => fs.readFileSync(path.join(dir, f), 'utf8') === fs.readFileSync(path.join(PG.ROOT, 'supabase', 'parts', f), 'utf8')), { fresh, committed });
  fs.rmSync(dir, { recursive: true, force: true });
}());

const db = PG.start('connect');
if (db.skip) {
  if (process.env.PORTFOLIO_SQL_REQUIRED === '1') chk('a PostgreSQL cluster starts (required in CI)', false, db.skip);
  console.log('NOTE | ' + db.skip + ' — LIVE layer skipped');
  process.exit(T.done());
}
const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';
const ADMIN = 'e7e46801-80c4-4f47-b718-4aff211c8d3a';
const one = (s) => String(s).split('\n')[0];
const json = (s) => JSON.parse(s || 'null');
const svcJson = (sql) => json(one(db.service(sql)));
const ingest = (acct, run, payload) => svcJson(`select public.portfolio_svc_ingest(${L(acct)}, ${run ? L(run) : 'null'}, ${L(JSON.stringify(payload))}::jsonb);`);
const count = (sql) => +db.sql(sql);
const stagesAll = () => JSON.stringify(Object.fromEntries(K.SMOKE_STAGES.map((s) => [s, { ok: true, at: '2026-10-04T00:00:00Z' }])));

(async function main() {
  try {
    db.applyFileAtomic(BASE);
    db.applyFileAtomic(JOURNAL);
    let out = db.applyFileAtomic(FILE);
    chk('the connect migration applies over portfolio.sql and the journal', true);
    chk('every report row reads ok', !/CHECK THIS/.test(out) && (out.match(/\|ok$/gm) || []).length === 6, out.slice(-900));
    out = db.applyFileAtomic(FILE);
    chk('and applies a second time, still all ok', !/CHECK THIS/.test(out));
    db.applyFileAtomic(BASE); db.applyFileAtomic(JOURNAL);
    chk('re-running portfolio.sql and the journal after it keeps every service function closed to readers and anon',
      db.sql(`select count(*) from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname like 'portfolio\\_svc\\_%'
               and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'));`) === '0');
    db.sql(`insert into auth.users (id, email) values (${L(A)}, 'a@example.com'), (${L(B)}, 'b@example.com'), (${L(ADMIN)}, 'op@example.com');`);

    /* ═══ THE REGISTRY AND ITS SWITCH ════════════════════════════════════ */
    chk('the registry is seeded: Kalshi by key, Polymarket by wallet, five sportsbooks by import, all off',
      db.sql(`select string_agg(platform_key || ':' || coalesce(automatic_method, '-') || ':' || automatic_enabled, ',' order by platform_key) from public.portfolio_platform_registry;`)
      === 'bet365:-:false,betmgm:-:false,draftkings:-:false,fanduel:-:false,kalshi:API_KEY:false,polymarket:PUBLIC_WALLET:false,williamhill_us:-:false');
    const enable = (testId) => db.mustFail(() => db.service(`update public.portfolio_platform_registry set automatic_enabled = true, enabled_by_smoke_test = ${testId ? L(testId) : 'null'}, tos_review = 'CLEARED', enabled_at = now() where platform_key = 'kalshi';`));
    chk('no smoke test: refused', /cannot be enabled|enabled_evidence/.test(enable(null) || ''));
    const smoke = (o) => one(db.service(`insert into portfolio_private.connector_smoke_tests (platform_key, connector_version, environment, stages, status, finished_at)
      values ('kalshi', ${L(o.version || 'kalshi_v1')}, ${L(o.env || 'PRODUCTION')}, ${L(o.stages || '{}')}::jsonb, ${L(o.status || 'RUNNING')}, ${o.status && o.status !== 'RUNNING' ? 'now()' : 'null'}) returning id;`));
    const running = smoke({});
    chk('a running smoke test is not a pass: refused', /cannot be enabled/.test(enable(running) || ''));
    const nine = JSON.stringify(Object.fromEntries(K.SMOKE_STAGES.slice(0, 9).map((s) => [s, { ok: true }])));
    chk('PASSED with nine of ten stages cannot even be recorded', /smoke_passed/.test(db.mustFail(() => smoke({ status: 'PASSED', stages: nine })) || ''));
    chk('PASSED against the demo environment cannot be recorded', /smoke_passed/.test(db.mustFail(() => smoke({ status: 'PASSED', stages: stagesAll(), env: 'DEMO' })) || ''));
    const otherVersion = smoke({ status: 'PASSED', stages: stagesAll(), version: 'kalshi_v0' });
    chk('a pass of another connector version: refused', /cannot be enabled/.test(enable(otherVersion) || ''));
    const passed = smoke({ status: 'PASSED', stages: stagesAll() });
    chk('a pass, but the terms review not cleared: refused', /enabled_evidence/.test(db.mustFail(() => db.service(`update public.portfolio_platform_registry set automatic_enabled = true, enabled_by_smoke_test = ${L(passed)}, enabled_at = now() where platform_key = 'kalshi';`)) || ''));
    chk('a reader cannot throw the switch at all', /permission denied/.test(db.mustFail(() => db.as(A, `update public.portfolio_platform_registry set automatic_enabled = true where platform_key = 'kalshi';`)) || ''));
    chk('all ten stages, this version, production, terms cleared: it switches on', enable(passed) === null
      && db.sql(`select automatic_enabled from public.portfolio_platform_registry where platform_key = 'kalshi';`) === 't');
    db.applyFileAtomic(FILE);
    chk('re-running the file keeps the switch where it was', db.sql(`select automatic_enabled from public.portfolio_platform_registry where platform_key = 'kalshi';`) === 't');
    db.service(`update public.portfolio_platform_registry set connector_version = 'kalshi_v2' where platform_key = 'kalshi';`);
    chk('a new connector version switches it off again', db.sql(`select automatic_enabled::text || ':' || coalesce(enabled_by_smoke_test::text, 'none') from public.portfolio_platform_registry where platform_key = 'kalshi';`) === 'false:none');
    db.applyFileAtomic(FILE);   /* back to the shipped version, off */

    /* the smoke test, stage by stage, in order */
    const st = one(db.service(`select public.portfolio_svc_smoke_begin('kalshi', 'operator');`));
    chk('a smoke test begins for the shipped connector version', db.sql(`select connector_version || ':' || status from portfolio_private.connector_smoke_tests where id = ${L(st)};`) === 'kalshi_v1:RUNNING');
    chk('a sportsbook has no connector to smoke-test', /no automatic connector/.test(db.mustFail(() => db.service(`select public.portfolio_svc_smoke_begin('fanduel');`)) || ''));
    chk('a stage cannot pass before the stages ahead of it', /cannot pass before CONNECT/.test(db.mustFail(() => db.service(`select public.portfolio_svc_smoke_stage(${L(st)}, 'IMPORT', true);`)) || ''));
    chk('a stage may be recorded as failed at any time', db.mustFail(() => db.service(`select public.portfolio_svc_smoke_stage(${L(st)}, 'SETTLEMENT', false, '{"why":"nothing settled yet"}');`)) === null);
    K.SMOKE_STAGES.slice(0, 9).forEach((s) => db.service(`select public.portfolio_svc_smoke_stage(${L(st)}, ${L(s)}, true, '{}');`));
    chk('nine passed stages finish as FAILED, never PASSED', one(db.service(`select public.portfolio_svc_smoke_finish(${L(st)});`)) === 'FAILED');
    const st2 = one(db.service(`select public.portfolio_svc_smoke_begin('kalshi', 'operator');`));
    K.SMOKE_STAGES.forEach((s) => db.service(`select public.portfolio_svc_smoke_stage(${L(st2)}, ${L(s)}, true, '{}');`));
    chk('all ten, in order: PASSED', one(db.service(`select public.portfolio_svc_smoke_finish(${L(st2)});`)) === 'PASSED');
    chk('…and its record reads back for the operator', JSON.parse(one(db.service(`select public.portfolio_svc_smoke_status(${L(st2)});`))).status === 'PASSED');
    chk('a finished test takes no more stages', /no running smoke test/.test(db.mustFail(() => db.service(`select public.portfolio_svc_smoke_stage(${L(st2)}, 'CONNECT', true);`)) || ''));

    /* ═══ WHO MAY CALL WHAT ═════════════════════════════════════════════ */
    chk('a reader reads the registry', +one(db.as(A, `select count(*) from public.portfolio_platform_registry;`)) === 7);
    chk('anon reads nothing', /permission denied/.test(db.mustFail(() => db.anon(`select count(*) from public.portfolio_platform_registry;`)) || ''));
    chk('a reader cannot call a service function', /permission denied/.test(db.mustFail(() => db.as(A, `select public.portfolio_svc_due_accounts(10);`)) || ''));
    chk('a reader cannot read the private schema (credentials, smoke tests, sessions)', ['platform_credentials', 'connector_smoke_tests', 'connect_sessions']
      .every((t) => /permission denied/.test(db.mustFail(() => db.as(A, `select count(*) from portfolio_private.${t};`)) || '')));
    db.sql(`grant execute on function public.portfolio_svc_disconnect(uuid, boolean) to authenticated;`);
    chk('…and a service function granted by mistake still refuses a reader', /not a reader's|permission denied for function portfolio_svc_assert/.test(db.mustFail(() => db.as(A, `select public.portfolio_svc_disconnect('00000000-0000-0000-0000-000000000001', false);`)) || ''));
    db.sql(`revoke execute on function public.portfolio_svc_disconnect(uuid, boolean) from authenticated;`);

    /* ═══ CONNECT: upgrade in place, the vault ═══════════════════════════ */
    const csvAcct = one(db.as(A, `insert into public.platform_accounts (platform, platform_label, platform_type, connection_type) values ('kalshi', 'Kalshi', 'PREDICTION_MARKET', 'CSV') returning id;`));
    chk('while the platform is off, connecting is refused', /not enabled/.test(db.mustFail(() => db.service(`select public.portfolio_svc_account_connect(${L(A)}, 'kalshi', 'API_KEY', 'kalshi-member-1');`)) || ''));
    chk('a sportsbook has no automatic connection to make', /has no API_KEY connection/.test(db.mustFail(() => db.service(`select public.portfolio_svc_account_connect(${L(A)}, 'draftkings', 'API_KEY', 'x');`)) || ''));
    const run0 = smoke({});
    const acct = one(db.service(`select public.portfolio_svc_account_connect(${L(A)}, 'kalshi', 'API_KEY', 'kalshi-member-1', null, ${L(run0)});`));
    chk('connecting during a smoke test upgrades the QUICK IMPORT account IN PLACE: same id, API key, tier 2, SYNCING', acct === csvAcct
      && db.sql(`select connection_type || ':' || ingestion_method || ':' || connection_tier || ':' || status from public.platform_accounts where id = ${L(acct)};`) === 'API:API_KEY:2:SYNCING');
    const key = nodeCrypto.randomBytes(32).toString('base64');
    const secret = { key_id: 'a952bcbe-ec3b-4b5b-b8f9-11dae589608c', private_key: 'PRIVATE-' + 'x'.repeat(60) };
    const sealed = await K.sealCredential(secret, { keyB64: key, keyVersion: 1, userId: A, accountId: acct, kind: 'API_KEY' });
    db.service(`select public.portfolio_svc_store_credential(${L(acct)}, 'API_KEY', ${L(sealed.ciphertext_b64)}, ${L(sealed.nonce_b64)}, 1, ${L(K.keyHint(secret.key_id))}, array['read']);`);
    const back = json(one(db.service(`select row_to_json(c) from public.portfolio_svc_credential(${L(acct)}) c;`)));
    const opened = await K.openCredential(back, { keyB64: key, userId: A, accountId: acct });
    chk('the sealed credential round-trips through the database and opens for its account', opened.private_key === secret.private_key);
    chk('the database holds ciphertext only', !db.sql(`select encode(ciphertext, 'escape') from portfolio_private.platform_credentials where platform_account_id = ${L(acct)};`).includes('PRIVATE-'));
    const meta = json(one(db.as(A, `select metadata->'credential' from public.platform_accounts where id = ${L(acct)};`)));
    chk('the reader sees the hint, the scopes and when — never the key', meta.hint === '…608c' && JSON.stringify(meta.scopes) === '["read"]' && meta.stored_at && !('ciphertext' in meta));
    chk('…and cannot change what the connector wrote about the account', db.mustFail(() => db.as(A, `update public.platform_accounts set status = 'CONNECTED', metadata = '{}' where id = ${L(acct)};`)) !== null
      && db.sql(`select status || ':' || (metadata ? 'credential')::text from public.platform_accounts where id = ${L(acct)};`) === 'SYNCING:true');

    /* ═══ THE INGEST ═════════════════════════════════════════════════════ */
    const TS = (d) => '2026-09-1' + d + 'T15:00:00Z';
    const fills = [
      { fill_id: 'f1', ticker: 'NFL-KC', outcome_side: 'yes', count_fp: '10.00', yes_price_dollars: '0.4000', no_price_dollars: '0.6000', fee_cost: '0.07', created_time: TS(1) },
      { fill_id: 'f2', ticker: 'NFL-KC', outcome_side: 'yes', count_fp: '5.50', yes_price_dollars: '0.4200', no_price_dollars: '0.5800', fee_cost: '0.04', created_time: TS(2) },
      { fill_id: 'f3', ticker: 'NFL-KC', outcome_side: 'no', count_fp: '20.00', yes_price_dollars: '0.3000', no_price_dollars: '0.7000', fee_cost: '0.12', created_time: TS(3) }];
    const markets = { 'NFL-KC': { event_ticker: 'NFL-25W3', title: 'Will the Chiefs win?', yes_sub_title: 'Chiefs' } };
    const events = { 'NFL-25W3': { title: 'Chiefs at Bills' } };
    const run1 = one(db.service(`select public.portfolio_svc_run_begin(${L(acct)}, 'INITIAL');`));
    chk('a run begins; a second one for the same account waits its turn', /^[0-9a-f-]{36}$/.test(run1) && db.service(`select public.portfolio_svc_run_begin(${L(acct)}, 'INCREMENTAL') is null;`).trim() === 't');
    let res = ingest(acct, run1, K.ingestPayload(K.kalshiNormalize({ fills, markets, events }), { fetched: 3 }));
    chk('the first sync inserts two positions (YES and NO) and four transactions', res.positions_inserted === 2 && res.transactions_inserted === 4 && res.rejected === 0, res);
    const pos = json(one(db.as(A, `select json_object_agg(external_position_id, json_build_object('status', status, 'contracts', contracts::text, 'pl', profit_loss::text, 'source', source, 'event', event_name, 'market', market_name, 'fees', fees::text)) from public.portfolio_positions;`)));
    chk('they are the reader\'s, synced, named from the market and the event, open until settled',
      pos['kalshi:NFL-KC:YES'].source === 'SYNC' && pos['kalshi:NFL-KC:YES'].event === 'Chiefs at Bills' && pos['kalshi:NFL-KC:YES'].market === 'Chiefs'
      && pos['kalshi:NFL-KC:YES'].status === 'SETTLED' && pos['kalshi:NFL-KC:YES'].contracts === '0' && pos['kalshi:NFL-KC:NO'].status === 'OPEN' && pos['kalshi:NFL-KC:NO'].contracts === '4.5', pos);
    res = ingest(acct, run1, K.ingestPayload(K.kalshiNormalize({ fills, markets, events })));
    chk('the same payload again adds nothing (no duplicate positions or fills)', res.positions_inserted === 0 && res.transactions_inserted === 0 && res.transactions_unchanged === 4
      && count(`select count(*) from public.portfolio_transactions where platform_account_id = ${L(acct)};`) === 4, res);
    const settle = { settlements: [{ ticker: 'NFL-KC', market_result: 'no', revenue: 450, fee_cost: '0.02', settled_time: '2026-09-20T03:00:00Z' }],
      known: { 'NFL-KC:YES': true, 'NFL-KC:NO': true }, heldAtSettle: { 'NFL-KC': 'NO' }, markets, events };
    res = ingest(acct, run1, K.ingestPayload(K.kalshiNormalize(settle)));
    chk('a later settlement lands on the positions an earlier sync stored, and is counted as two settlements', res.positions_inserted === 0 && res.positions_updated === 2 && res.transactions_inserted === 1
      && res.positions_settled === 2, res);
    const pl = json(one(db.sql(`select json_object_agg(external_position_id, profit_loss::text) from public.portfolio_positions where platform_account_id = ${L(acct)};`)));
    const jsN = K.kalshiNormalize(Object.assign({ fills }, settle));
    const jsPl = (side) => { const p = jsN.positions.find((x) => x.side === side); return E.derive({ platform_type: 'PREDICTION_MARKET', side: p.side, resolution: p.resolution, settlement_price: p.settlement_price },
      p.fills.map((f) => ({ transaction_type: f.action, quantity: f.quantity, price: f.price, fee: f.fee })).concat(p.fees.map((f) => ({ transaction_type: 'FEE', fee: f.fee })))).profit_loss; };
    chk('the database\'s P&L equals the core\'s, which equals Kalshi\'s netting: −1.863 + 1.303 = −0.56',
      pl['kalshi:NFL-KC:YES'] === '-1.863' && pl['kalshi:NFL-KC:NO'] === '1.303' && jsPl('YES') === '-1.863' && jsPl('NO') === '1.303', pl);
    const updated = Object.assign({}, settle, { settlements: [{ ticker: 'NFL-KC', market_result: 'yes', fee_cost: '0.02', settled_time: '2026-09-21T03:00:00Z' }] });
    ingest(acct, run1, K.ingestPayload(K.kalshiNormalize(updated)));
    chk('an UPDATED settlement (a corrected result) replaces the earlier one', db.sql(`select resolution || ':' || profit_loss::text from public.portfolio_positions where external_position_id = 'kalshi:NFL-KC:NO';`) === 'YES:-3.197'
      && count(`select count(*) from public.portfolio_transactions where platform_account_id = ${L(acct)} and transaction_type = 'FEE';`) === 1);
    ingest(acct, run1, K.ingestPayload(K.kalshiNormalize(settle)));
    res = ingest(acct, run1, K.ingestPayload(K.kalshiNormalize(settle)));
    chk('the same settlement read again is not counted again', res.positions_settled === 0 && res.positions_updated === 2, res);
    const bad = K.ingestPayload(K.kalshiNormalize({ fills: [{ fill_id: 'g1', ticker: 'NBA-X', outcome_side: 'yes', count_fp: '2', yes_price_dollars: '0.5', fee_cost: '0', created_time: TS(5) }], markets: { 'NBA-X': { title: 'X' } } }));
    bad.positions.push({ platform: 'kalshi', external_position_id: 'kalshi:BROKEN:YES', event_name: 'Broken', market_name: 'Broken', selection: 'YES', side: 'YES',
      fills: [{ external_transaction_id: 'kalshi:b1:c', action: 'SELL', quantity: '3', price: '0.5', fee: '0', executed_at: TS(5) }], fees: [] });
    bad.positions.push({ platform: 'polymarket', external_position_id: 'polymarket:1', event_name: 'Wrong platform', market_name: 'x', selection: 'Yes', side: 'Yes', fills: [], fees: [] });
    res = ingest(acct, run1, bad);
    chk('a malformed position is rejected ALONE and reported; the good one in the same payload lands', res.positions_inserted === 1 && res.rejected === 2
      && res.issues.filter((i) => i.code === 'REJECTED').map((i) => i.ref).join() === 'kalshi:BROKEN:YES,polymarket:1'
      && /at least one buy/.test(res.issues[0].message) && count(`select count(*) from public.portfolio_positions where external_position_id = 'kalshi:BROKEN:YES';`) === 0, res);
    db.service(`select public.portfolio_svc_run_finish(${L(run1)}, 'PARTIAL', null, null, 'cursor-1', '{"ok": true}'::jsonb);`);
    const r1 = json(one(db.as(A, `select row_to_json(r) from public.portfolio_sync_runs r where id = ${L(run1)};`)));
    chk('the reader sees their run: counts, rejected, the reasons, the reconciliation', r1.status === 'PARTIAL' && r1.positions_inserted === 3 && r1.rejected === 2 && r1.fetched === 3
      && r1.issues.length === 2 && r1.reconcile.ok === true && r1.duration_ms >= 0, r1);
    chk('a successful run: CONNECTED, the cursor kept, the next run in 30 minutes', db.sql(`select status || ':' || sync_cursor || ':' || (next_sync_at between now() + interval '29 minutes' and now() + interval '31 minutes')::text || ':' || consecutive_failures from public.platform_accounts where id = ${L(acct)};`) === 'CONNECTED:cursor-1:true:0');
    chk('a synced position is the connector\'s: the reader cannot rewrite, add fills to or delete it',
      /read-only|synced/.test(db.mustFail(() => db.as(A, `update public.portfolio_positions set event_name = 'Edited' where external_position_id = 'kalshi:NFL-KC:YES';`)) || '')
      && db.mustFail(() => db.as(A, `delete from public.portfolio_positions where external_position_id = 'kalshi:NFL-KC:YES';`)) === null
      && count(`select count(*) from public.portfolio_positions where external_position_id = 'kalshi:NFL-KC:YES';`) === 1);
    chk('every synced position has its journal entry, marked as history without a pre-entry decision',
      count(`select count(*) from public.portfolio_positions p where platform_account_id = ${L(acct)} and not exists (select 1 from public.portfolio_journal_entries j where j.position_id = p.id);`) === 0
      && one(db.as(A, `select evidence from public.portfolio_facts(null, null, 'UTC') where platform = 'kalshi' limit 1;`)) === 'RESULT_ONLY');

    /* Polymarket: an entry fee that changes is replaced, not duplicated */
    const pmRun = smoke({});
    db.service(`update portfolio_private.connector_smoke_tests set platform_key = 'polymarket', connector_version = 'polymarket_v1' where id = ${L(pmRun)};`);
    const pmAcct = one(db.service(`select public.portfolio_svc_account_connect(${L(A)}, 'polymarket', 'PUBLIC_WALLET', '0xabc0000000000000000000000000000000000001', null, ${L(pmRun)});`));
    const act = [{ type: 'TRADE', timestamp: 1757692800, condition_id: 'c1', token_id: '7132', side: 'BUY', size: 100, price: 0.4, outcome: 'Yes', title: 'Will X?', transaction_hash: '0xh1' }];
    const pmPayload = (fee) => K.ingestPayload(K.polymarketNormalize({ activity: act, positions: [{ token_id: '7132', outcome: 'Yes', title: 'Will X?', status: 'OPEN', current_price: 0.55, entry_fees_usdc: fee }], asOf: '2026-10-04T12:00:00Z' }));
    ingest(pmAcct, null, pmPayload('0.35'));
    res = ingest(pmAcct, null, pmPayload('0.40'));
    chk('Polymarket: a corrected entry fee replaces the old one in place', res.transactions_inserted === 1 && res.transactions_unchanged === 1
      && db.sql(`select fees::text || ':' || unrealized_profit_loss::text || ':' || count(*) over () from public.portfolio_positions where platform_account_id = ${L(pmAcct)};`) === '0.4:15:1');
    chk('a wallet account is tier 2 by public wallet, and holds no credential', db.sql(`select ingestion_method || ':' || connection_tier from public.platform_accounts where id = ${L(pmAcct)};`) === 'PUBLIC_WALLET:2'
      && count(`select count(*) from portfolio_private.platform_credentials where platform_account_id = ${L(pmAcct)};`) === 0);

    /* ═══ RUNS: refused keys, backoff, ERROR ═════════════════════════════ */
    let r = one(db.service(`select public.portfolio_svc_run_begin(${L(pmAcct)}, 'INCREMENTAL');`));
    db.service(`select public.portfolio_svc_run_finish(${L(r)}, 'FAILED', 'PLATFORM_DOWN', 'The platform did not answer.');`);
    chk('a failure before anything ever synced reads SYNCING (not CONNECTED), retried in 5 minutes', db.sql(`select status || ':' || consecutive_failures || ':' || (next_sync_at between now() + interval '4 minutes' and now() + interval '6 minutes')::text from public.platform_accounts where id = ${L(pmAcct)};`) === 'SYNCING:1:true');
    for (let i = 0; i < 4; i++) { r = one(db.service(`select public.portfolio_svc_run_begin(${L(pmAcct)}, 'INCREMENTAL');`)); db.service(`select public.portfolio_svc_run_finish(${L(r)}, 'FAILED', 'PLATFORM_DOWN', 'The platform did not answer.');`); }
    chk('backoff doubles (5 → 80 minutes by the fifth) and five failures in a row read ERROR', db.sql(`select status || ':' || consecutive_failures || ':' || (next_sync_at between now() + interval '79 minutes' and now() + interval '81 minutes')::text from public.platform_accounts where id = ${L(pmAcct)};`) === 'ERROR:5:true');
    r = one(db.service(`select public.portfolio_svc_run_begin(${L(acct)}, 'INCREMENTAL');`));
    db.service(`select public.portfolio_svc_run_finish(${L(r)}, 'FAILED', 'BAD_CREDENTIAL', ${L(K.readerError('BAD_CREDENTIAL').message)});`);
    chk('a key the platform refused: ACTION REQUIRED, the reason in plain words, no automatic retry', db.sql(`select status || ':' || (next_sync_at is null)::text from public.platform_accounts where id = ${L(acct)};`) === 'ACTION_REQUIRED:true'
      && /rejected the key/.test(db.sql(`select last_error from public.platform_accounts where id = ${L(acct)};`)));
    db.service(`update public.platform_accounts set status = 'CONNECTED', next_sync_at = now() - interval '1 minute' where id = ${L(acct)};`);
    chk('the scheduler takes only accounts on a switched-on platform', db.service(`select count(*) from public.portfolio_svc_due_accounts(50);`).trim() === '0');
    const pass2 = smoke({ status: 'PASSED', stages: stagesAll() });
    db.service(`update public.portfolio_platform_registry set automatic_enabled = true, enabled_by_smoke_test = ${L(pass2)}, tos_review = 'CLEARED', enabled_at = now() where platform_key = 'kalshi';`);
    chk('…due, connected, not waiting on the reader', one(db.service(`select string_agg(platform, ',') from public.portfolio_svc_due_accounts(50);`)) === 'kalshi');

    /* ═══ ISOLATION ══════════════════════════════════════════════════════ */
    chk('reader B sees none of A\'s accounts, runs or synced positions', one(db.as(B, `select (select count(*) from public.platform_accounts) || ':' || (select count(*) from public.portfolio_sync_runs) || ':' || (select count(*) from public.portfolio_positions);`)) === '0:0:0');
    chk('reader B cannot disconnect A\'s account', /no such account/.test(db.mustFail(() => db.as(B, `select public.portfolio_disconnect(${L(acct)}, true);`)) || ''));
    chk('the operator view is the operator\'s only', /operators only/.test(db.mustFail(() => db.as(A, `select public.portfolio_admin_connector_health(24);`)) || ''));
    const health = json(one(db.as(ADMIN, `select public.portfolio_admin_connector_health(24);`)));
    const k = health.platforms.find((x) => x.platform === 'kalshi'), p = health.platforms.find((x) => x.platform === 'polymarket');
    chk('…which counts runs, failures by code and timings per platform, and names no reader or position', k.runs === 2 && k.failed === 1 && k.errors.BAD_CREDENTIAL === 1 && p.failed === 5
      && health.registry.length === 7 && !/a@example|NFL-KC|kalshi-member|\b0x[0-9a-f]{40}\b/.test(JSON.stringify(health)), health);
    chk('…and what the syncs moved: discovered, inserted, duplicates rejected, settlements recorded (a re-read counts none), rejected, reconciliations',
      k.discovered >= 3 && k.positions_inserted >= 2 && k.transactions_inserted >= 4 && k.duplicates_rejected >= 4 && k.settlements === 6 && k.rejected >= 2
      && typeof k.reconciled === 'number' && typeof k.reconcile_mismatches === 'number', k);
    /* connection attempts: counts written by the connect function, never a reader */
    chk('a reader cannot record a connector event', /permission denied/.test(db.mustFail(() => db.as(A, `select public.portfolio_svc_connector_event('kalshi', 'ATTEMPT');`)) || ''));
    db.service(`select public.portfolio_svc_connector_event('kalshi', 'ATTEMPT'); select public.portfolio_svc_connector_event('kalshi', 'FAILED', 'WRITE_SCOPE');
      select public.portfolio_svc_connector_event('kalshi', 'ATTEMPT'); select public.portfolio_svc_connector_event('kalshi', 'CONNECTED');
      select public.portfolio_svc_connector_event('kalshi', 'DISCONNECTED');`);
    chk('an unknown event kind is refused', /connector_events_kind/.test(db.mustFail(() => db.service(`select public.portfolio_svc_connector_event('kalshi', 'GUESS');`)) || ''));
    chk('the private connector events table has no reader column at all', db.sql(`select count(*) from information_schema.columns where table_schema = 'portfolio_private' and table_name = 'connector_events' and column_name like '%user%';`) === '0');
    /* imports: files, parser failures, and a layout the platform had not exported before */
    /* (the import guard sets status and dates itself; a fixture of past imports bypasses it) */
    db.sql(`set session_replication_role = replica;
      insert into public.portfolio_imports (user_id, platform, platform_type, importer, status, rows_total, rows_invalid, header_signature, created_at) values
      (${L(A)}, 'draftkings', 'SPORTSBOOK', 'sportsbook_wagers', 'COMMITTED', 20, 0, 'bet id|odds|payout|stake', now() - interval '10 days'),
      (${L(A)}, 'draftkings', 'SPORTSBOOK', 'sportsbook_wagers', 'COMMITTED', 30, 3, 'bet id|odds|payout|stake|wager type', now() - interval '2 hours'),
      (${L(B)}, 'draftkings', 'SPORTSBOOK', 'sportsbook_wagers', 'FAILED', 10, 10, 'bet id|odds|payout|stake|wager type', now() - interval '1 hour');
      set session_replication_role = origin;`);
    const h2 = json(one(db.as(ADMIN, `select public.portfolio_admin_connector_health(24);`)));
    const kc = h2.connections.find((x) => x.platform === 'kalshi'), dk = h2.imports.find((x) => x.platform === 'draftkings');
    chk('connection attempts, successes and failures by code', kc && kc.attempts === 2 && kc.connected === 1 && kc.failed === 1 && kc.disconnected === 1 && kc.failures.WRITE_SCOPE === 1, h2.connections);
    chk('imports: files, failures, rows that could not be read, and one new layout flagged as a possible format change', dk && dk.files === 2 && dk.committed === 1 && dk.failed === 1
      && dk.parser_failures === 13 && dk.files_with_parser_failures === 2 && dk.new_layouts === 1, h2.imports);
    chk('…naming no reader or file', !/a@example|b@example|00000000-0000-0000-0000-00000000000[ab]|bet id/.test(JSON.stringify(h2.imports) + JSON.stringify(h2.connections)));

    /* ═══ TIME TO VALUE (operators) ══════════════════════════════════════ */
    chk('time to value: operators only', /operators only/.test(db.mustFail(() => db.as(A, `select public.portfolio_admin_ttv(30);`)) || ''));
    chk('…and without the funnel installed it says so rather than inventing numbers', JSON.parse(one(db.as(ADMIN, `select public.portfolio_admin_ttv(30);`))).events === false);
    db.sql(`create table public.user_events (id bigint generated always as identity, user_id uuid, event_name text not null, event_properties jsonb not null default '{}', created_at timestamptz not null default now());
      insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000c1', 'c1@x'), ('00000000-0000-0000-0000-0000000000c2', 'c2@x'), ('00000000-0000-0000-0000-0000000000c3', 'c3@x');
      insert into public.user_events (user_id, event_name, created_at) values
        ('00000000-0000-0000-0000-0000000000c1', 'portfolio_onboarding_started', now() - interval '10 days'),
        ('00000000-0000-0000-0000-0000000000c1', 'first_position_created', now() - interval '10 days' + interval '4 minutes'),
        ('00000000-0000-0000-0000-0000000000c1', 'portfolio_ready', now() - interval '10 days' + interval '9 minutes'),
        ('00000000-0000-0000-0000-0000000000c2', 'portfolio_onboarding_started', now() - interval '9 days'),
        ('00000000-0000-0000-0000-0000000000c2', 'first_position_created', now() - interval '9 days' + interval '8 minutes'),
        ('00000000-0000-0000-0000-0000000000c3', 'portfolio_onboarding_started', now() - interval '8 days'),
        ('00000000-0000-0000-0000-0000000000c1', 'connection_started', now() - interval '10 days'),
        ('00000000-0000-0000-0000-0000000000c1', 'connection_completed', now() - interval '10 days' + interval '1 minute'),
        ('00000000-0000-0000-0000-0000000000c2', 'connection_started', now() - interval '9 days');`);
    const ttv = JSON.parse(one(db.as(ADMIN, `select public.portfolio_admin_ttv(30);`)));
    chk('time to value: setups started, median minutes to a first position and to ready, abandonment, connection failures',
      ttv.events === true && ttv.onboarding_started === 3 && +ttv.time_to_first_position_minutes_median === 6 && +ttv.time_to_portfolio_ready_minutes_median === 9
      && +ttv.onboarding_abandonment === 0.6667 && +ttv.connection_failure_rate === 0.5 && ttv.import_failure_rate !== undefined, ttv);
    chk('…and names no reader', !/c1@x|0000000000c1/.test(JSON.stringify(ttv)));

    /* ═══ SESSIONS ═══════════════════════════════════════════════════════ */
    const state = nodeCrypto.createHash('sha256').update('state-1').digest('hex');
    db.service(`select public.portfolio_svc_session_begin(${L(A)}, 'polymarket', 'PUBLIC_WALLET', ${L(state)}, 'Sign to prove you own this wallet: 1234');`);
    chk('a connect session is consumed once, by its reader, inside its window',
      one(db.service(`select count(*) from public.portfolio_svc_session_consume(${L(B)}, ${L(state)});`)) === '0'
      && one(db.service(`select challenge from public.portfolio_svc_session_consume(${L(A)}, ${L(state)});`)) === 'Sign to prove you own this wallet: 1234'
      && one(db.service(`select count(*) from public.portfolio_svc_session_consume(${L(A)}, ${L(state)});`)) === '0');

    /* ═══ DISCONNECT, RECONNECT, NO DUPLICATES ═══════════════════════════ */
    const before = count(`select count(*) from public.portfolio_transactions where platform_account_id = ${L(acct)};`);
    const d = json(one(db.as(A, `select public.portfolio_disconnect(${L(acct)}, false);`)));
    chk('disconnect deletes the credential, keeps the history, and reads DISCONNECTED', d.credential_deleted === true && d.positions_deleted === 0
      && count(`select count(*) from portfolio_private.platform_credentials where platform_account_id = ${L(acct)};`) === 0
      && db.sql(`select status || ':' || (metadata ? 'credential')::text from public.platform_accounts where id = ${L(acct)};`) === 'DISCONNECTED:false'
      && count(`select count(*) from public.portfolio_positions where platform_account_id = ${L(acct)};`) === 3,
      [d, db.sql(`select status || ':' || (metadata ? 'credential')::text from public.platform_accounts where id = ${L(acct)};`), count(`select count(*) from public.portfolio_positions where platform_account_id = ${L(acct)};`)]);
    chk('a disconnected account is never scheduled', !one(db.service(`select coalesce(string_agg(platform, ','), '') from public.portfolio_svc_due_accounts(50);`)).includes('kalshi'));
    const again = one(db.service(`select public.portfolio_svc_account_connect(${L(A)}, 'kalshi', 'API_KEY', 'kalshi-member-1');`));
    chk('reconnecting reuses the same account', again === acct);
    ingest(acct, null, K.ingestPayload(K.kalshiNormalize(Object.assign({ fills }, settle))));
    chk('…and a full re-sync after it duplicates nothing', count(`select count(*) from public.portfolio_transactions where platform_account_id = ${L(acct)};`) === before
      && count(`select count(*) from public.portfolio_positions where platform_account_id = ${L(acct)};`) === 3);
    const del = json(one(db.as(A, `select public.portfolio_disconnect(${L(pmAcct)}, true);`)));
    chk('disconnect AND delete history: the synced positions, their fills and the account are gone', del.positions_deleted === 1
      && count(`select count(*) from public.platform_accounts where id = ${L(pmAcct)};`) === 0 && count(`select count(*) from public.portfolio_transactions where platform = 'polymarket';`) === 0);
    chk('a manual or import account is not "disconnected" — it has nothing to disconnect', /only an automatic account/.test(db.mustFail(() => db.as(A, `select public.portfolio_disconnect(
      (select id from public.platform_accounts where connection_type = 'MANUAL' limit 1), false);`)) || '') || count(`select count(*) from public.platform_accounts where user_id = ${L(A)} and connection_type = 'MANUAL';`) === 0);
  } catch (e) {
    chk('unexpected failure', false, String(e && (e.sqlMessage || e.stack) || e).slice(0, 1200));
  } finally {
    db.stop();
  }
  process.exit(T.done());
}());
