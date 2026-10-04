#!/usr/bin/env node
/* ===========================================================================
   THE LIVE SMOKE TEST — the only way a connector is ever switched on.

   An operator runs this against PRODUCTION with a real account of their own
   on the platform. Each stage is recorded (portfolio_svc_smoke_stage) and a
   stage can pass only after every stage before it has passed; the registry's
   switch can only be thrown by a test that PASSED all ten, for that exact
   connector version, in the last 30 days (supabase/portfolio_connect.sql).
   This script never throws the switch itself: it prints the statement to run
   once the platform's terms review is cleared.

   STAGES (some need the operator to act on the platform between them):
     CONNECT        connect through the deployed function, as an operator,
                    under this test (the platform is still off for readers)
     IMPORT         the first sync stored the account's history (it must have some)
     VERIFY         reconciled against the platform's own positions, AND the
                    operator compared the printed P&L with the platform's
                    statement (--confirmed)
     INCREMENTAL    a second sync adds nothing
     NEW_ACTIVITY   after the operator makes a small trade: it lands
     SETTLEMENT     after one of the account's markets settles: it lands
     RECONCILE      the latest sync reconciles
     DISCONNECT     the credential is deleted; history stays
     RECONNECT      the same account comes back
     NO_DUPLICATES  a full re-read of the history adds nothing

   ENVIRONMENT (never echoed):
     SB_URL, SB_SERVICE_ROLE           the production project
     EDGEDESK_OPERATOR_TOKEN           an operator's signed-in access token
     KALSHI_KEY_ID, KALSHI_PRIVATE_KEY_FILE    (Kalshi; a READ-ONLY key)
     POLYMARKET_WALLET                 (Polymarket; a public address)

   USAGE
     node tools/portfolio/connector_smoke.js begin kalshi
     node tools/portfolio/connector_smoke.js stage <test-id> CONNECT
     node tools/portfolio/connector_smoke.js stage <test-id> VERIFY --confirmed
     …
     node tools/portfolio/connector_smoke.js finish <test-id>
     node tools/portfolio/connector_smoke.js status <test-id>
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const K = require(path.join(__dirname, '..', '..', 'lib', 'edgedesk_portfolio_connect_core.js'));

const STAGES = K.SMOKE_STAGES;
function need(name) { const v = process.env[name]; if (!v) { console.error('missing ' + name + ' in the environment'); process.exit(2); } return v; }
function cfg() { return { url: need('SB_URL').replace(/\/+$/, ''), service: need('SB_SERVICE_ROLE') }; }

async function rpc(c, fn, args) {
  const r = await fetch(c.url + '/rest/v1/rpc/' + fn, { method: 'POST', headers: { apikey: c.service, authorization: 'Bearer ' + c.service, 'content-type': 'application/json' }, body: JSON.stringify(args || {}) });
  const t = await r.text();
  if (!r.ok) throw new Error(fn + ' ' + r.status + ' ' + t.slice(0, 200));
  return t ? JSON.parse(t) : null;
}
async function select(c, q) {
  const r = await fetch(c.url + '/rest/v1/' + q, { headers: { apikey: c.service, authorization: 'Bearer ' + c.service } });
  if (!r.ok) throw new Error('select ' + r.status);
  return r.json();
}
async function fn(c, body) {
  const r = await fetch(c.url + '/functions/v1/portfolio_connect', { method: 'POST', headers: { authorization: 'Bearer ' + need('EDGEDESK_OPERATOR_TOKEN'), 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function operatorId(c) {
  const r = await fetch(c.url + '/auth/v1/user', { headers: { apikey: c.service, authorization: 'Bearer ' + need('EDGEDESK_OPERATOR_TOKEN') } });
  const u = await r.json(); return u && u.id;
}
async function account(c, platform) {
  const uid = await operatorId(c);
  const rows = await select(c, 'platform_accounts?select=id,status,sync_cursor&user_id=eq.' + uid + '&platform=eq.' + platform + '&connection_type=eq.API');
  return rows[0] || null;
}
async function lastRun(c, acct) { return (await select(c, 'portfolio_sync_runs?select=*&platform_account_id=eq.' + acct + '&order=started_at.desc&limit=1'))[0] || null; }
async function txCount(c, acct) {
  const r = await fetch(c.url + '/rest/v1/portfolio_transactions?select=id&platform_account_id=eq.' + acct, { headers: { apikey: c.service, authorization: 'Bearer ' + c.service, prefer: 'count=exact', range: '0-0' } });
  return +(String(r.headers.get('content-range') || '').split('/')[1] || 0);
}
function connectBody(platform, test) {
  if (platform === 'kalshi') return { action: 'connect', platform, smoke_test: test, key_id: need('KALSHI_KEY_ID'), private_key: fs.readFileSync(need('KALSHI_PRIVATE_KEY_FILE'), 'utf8') };
  return { action: 'connect', platform, smoke_test: test, wallet: need('POLYMARKET_WALLET') };
}
async function waitTwoMinutes(c, acct) {
  const r = await lastRun(c, acct);
  const wait = r ? 125000 - (Date.now() - Date.parse(r.started_at)) : 0;
  if (wait > 0) { console.log('waiting ' + Math.ceil(wait / 1000) + ' s (one manual sync every two minutes)…'); await new Promise((ok) => setTimeout(ok, wait)); }
}

async function runStage(c, test, stage, flags) {
  const meta = (await select(c, 'portfolio_platform_registry?select=platform_key')).map((x) => x.platform_key);
  const info = await rpc(c, 'portfolio_svc_smoke_status', { p_test: test });
  if (!info) throw new Error('no such smoke test');
  const platform = info.platform_key;
  if (meta.indexOf(platform) < 0) throw new Error('unknown platform');
  let ok = false, detail = {};
  const acct = await account(c, platform);
  if (stage === 'CONNECT') {
    const r = await fn(c, connectBody(platform, test));
    ok = r.status === 200 && r.body.ok === true; detail = { status: r.status, reason: r.body.reason || null, first_sync: r.body.sync && r.body.sync.status };
  } else if (!acct) {
    detail = { error: 'no automatic account for the operator on ' + platform + ' — run CONNECT first' };
  } else if (stage === 'IMPORT') {
    const r = await lastRun(c, acct.id);
    ok = !!r && ['SUCCEEDED', 'PARTIAL'].indexOf(r.status) >= 0 && (await txCount(c, acct.id)) > 0; detail = { run: r && r.status, transactions: await txCount(c, acct.id) };
  } else if (stage === 'VERIFY') {
    const r = await lastRun(c, acct.id);
    const ps = await select(c, 'portfolio_positions?select=external_position_id,status,contracts,profit_loss,resolution&platform_account_id=eq.' + acct.id + '&order=external_position_id');
    console.table(ps.map((p) => ({ position: p.external_position_id, status: p.status, contracts: p.contracts, pnl: p.profit_loss, resolution: p.resolution })));
    ok = !!r && r.reconcile && r.reconcile.ok === true && flags.confirmed === true;
    detail = { reconciled: !!(r && r.reconcile && r.reconcile.ok), operator_confirmed_against_statement: flags.confirmed === true };
    if (!flags.confirmed) console.log('Compare the table above with the platform\'s own statement, then re-run with --confirmed.');
  } else if (['INCREMENTAL', 'NEW_ACTIVITY', 'SETTLEMENT', 'RECONCILE', 'NO_DUPLICATES'].indexOf(stage) >= 0) {
    const before = await txCount(c, acct.id);
    if (stage === 'NO_DUPLICATES') await rpc(c, 'portfolio_svc_reset_cursor', { p_account: acct.id });
    await waitTwoMinutes(c, acct.id);
    const r = await fn(c, { action: 'sync', account_id: acct.id });
    const after = await txCount(c, acct.id), run = await lastRun(c, acct.id);
    const settled = stage === 'SETTLEMENT' ? (await select(c, 'portfolio_positions?select=id&platform_account_id=eq.' + acct.id + '&resolution=not.is.null&settled_at=gte.' + encodeURIComponent(info.started_at))).length : null;
    detail = { sync: r.body.status || r.body.reason, before, after, reconciled: !!(run && run.reconcile && run.reconcile.ok), settled_since_test_began: settled };
    ok = r.status === 200 && ({ INCREMENTAL: after === before, NO_DUPLICATES: after === before, NEW_ACTIVITY: after > before,
      SETTLEMENT: settled > 0, RECONCILE: detail.reconciled })[stage];
  } else if (stage === 'DISCONNECT') {
    const r = await fn(c, { action: 'disconnect', account_id: acct.id, delete_history: false });
    const a = await account(c, platform);
    ok = r.status === 200 && r.body.credential_deleted === (platform === 'kalshi') && a && a.status === 'DISCONNECTED'; detail = { status: a && a.status };
  } else if (stage === 'RECONNECT') {
    const r = await fn(c, connectBody(platform, test));
    ok = r.status === 200 && r.body.account_id === acct.id; detail = { same_account: r.body.account_id === acct.id };
  }
  const stages = await rpc(c, 'portfolio_svc_smoke_stage', { p_test: test, p_stage: stage, p_ok: !!ok, p_detail: K.redact(detail) });
  console.log(stage + ': ' + (ok ? 'PASSED' : 'NOT PASSED') + ' ' + JSON.stringify(K.redact(detail)));
  return stages;
}

async function main() {
  const [cmd, a, b] = process.argv.slice(2), flags = { confirmed: process.argv.indexOf('--confirmed') > 0 };
  const c = cfg();
  if (cmd === 'begin') {
    const id = await rpc(c, 'portfolio_svc_smoke_begin', { p_platform: a, p_run_by: 'connector_smoke.js' });
    console.log('smoke test ' + id + ' for ' + a + '. Next: stage ' + id + ' CONNECT');
  } else if (cmd === 'stage') {
    if (STAGES.indexOf(b) < 0) { console.error('stage is one of ' + STAGES.join(', ')); process.exit(2); }
    await runStage(c, a, b, flags);
  } else if (cmd === 'finish') {
    const st = await rpc(c, 'portfolio_svc_smoke_finish', { p_test: a });
    console.log('smoke test ' + a + ': ' + st);
    if (st === 'PASSED') {
      const info = await rpc(c, 'portfolio_svc_smoke_status', { p_test: a });
      console.log('\nOnce the platform\'s terms review is cleared (docs/platform-connections.md), an operator switches it on with:\n'
        + "  update public.portfolio_platform_registry set automatic_enabled = true, enabled_by_smoke_test = '" + a + "', tos_review = 'CLEARED', enabled_at = now()\n"
        + "   where platform_key = '" + info.platform_key + "';");
    }
  } else if (cmd === 'status') {
    console.log(JSON.stringify(await rpc(c, 'portfolio_svc_smoke_status', { p_test: a }), null, 2));
  } else {
    console.log('usage: begin <platform> | stage <test-id> <STAGE> [--confirmed] | finish <test-id> | status <test-id>');
    process.exit(2);
  }
}
if (require.main === module) main().catch((e) => { console.error(String(K.redact(String(e && e.message || e)))); process.exit(1); });
module.exports = { runStage };
