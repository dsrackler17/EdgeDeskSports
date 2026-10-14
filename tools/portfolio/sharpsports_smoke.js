#!/usr/bin/env node
/* ===========================================================================
   SHARPSPORTS BETSYNC — THE LIVE CHECKS, against the deployed project.

   Two jobs, one script, run by an operator with network access to the
   project and to SharpSports (docs/sharpsports-betsync.md):

   1. THE WEBHOOK (Phase 1). Is sharpsports-webhook deployed at the URL the
      subscriptions name, what is it configured with, does it refuse an
      unsigned post, and did genuine SharpSports deliveries arrive — and
      which header carried their signature?
        node tools/portfolio/sharpsports_smoke.js probe
        node tools/portfolio/sharpsports_smoke.js webhooks

   2. THE TEN-STAGE SMOKE TEST (as tools/portfolio/connector_smoke.js does
      for Kalshi and Polymarket), in whichever environment the deployed
      portfolio_connect reads. In SANDBOX it is a rehearsal, recorded as
      DEMO: it can never switch production on. In PRODUCTION it is the
      evidence the registry's switch requires.
        node tools/portfolio/sharpsports_smoke.js begin
        node tools/portfolio/sharpsports_smoke.js stage <id> CONNECT     (prints SharpSports' link; open it, link, run CONNECT again)
        node tools/portfolio/sharpsports_smoke.js stage <id> IMPORT
        node tools/portfolio/sharpsports_smoke.js stage <id> VERIFY --confirmed
        node tools/portfolio/sharpsports_smoke.js stage <id> INCREMENTAL
        node tools/portfolio/sharpsports_smoke.js stage <id> NEW_ACTIVITY   (asks SharpSports to refresh; in sandbox a refresh adds bets)
        node tools/portfolio/sharpsports_smoke.js stage <id> SETTLEMENT     (once a bet has settled)
        node tools/portfolio/sharpsports_smoke.js stage <id> RECONCILE
        node tools/portfolio/sharpsports_smoke.js stage <id> DISCONNECT
        node tools/portfolio/sharpsports_smoke.js stage <id> RECONNECT      (prints the link again; relink, run RECONNECT again)
        node tools/portfolio/sharpsports_smoke.js stage <id> NO_DUPLICATES
        node tools/portfolio/sharpsports_smoke.js finish <id>

   ENVIRONMENT (never echoed):
     SB_URL, SB_SERVICE_ROLE      the project
     EDGEDESK_OPERATOR_TOKEN      an operator's signed-in access token
     SHARPSPORTS_BOOK             optional: the platform key of the book to
                                  test when several are linked (e.g. draftkings)
   =========================================================================== */
'use strict';
const path = require('path');
const K = require(path.join(__dirname, '..', '..', 'lib', 'edgedesk_portfolio_connect_core.js'));

function need(name) { const v = process.env[name]; if (!v) { console.error('missing ' + name + ' in the environment'); process.exit(2); } return v; }
function cfg() { return { url: need('SB_URL').replace(/\/+$/, ''), service: need('SB_SERVICE_ROLE') }; }
async function rpc(c, fn, args, asOperator) {
  const key = asOperator ? need('EDGEDESK_OPERATOR_TOKEN') : c.service;
  const r = await fetch(c.url + '/rest/v1/rpc/' + fn, { method: 'POST', headers: { apikey: c.service, authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body: JSON.stringify(args || {}) });
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
/* the operator's linked account under test, in the environment being tested */
async function account(c, env) {
  const uid = await operatorId(c);
  const rows = await select(c, 'platform_accounts?select=id,platform,status,metadata,external_account_id&user_id=eq.' + uid + '&connection_type=eq.AGGREGATOR&order=created_at.asc');
  const mine = rows.filter((a) => a.metadata && a.metadata.provider === 'sharpsports' && a.metadata.environment === env
    && (!process.env.SHARPSPORTS_BOOK || a.platform === process.env.SHARPSPORTS_BOOK));
  return mine[0] || null;
}
async function lastRun(c, acct) { return (await select(c, 'portfolio_sync_runs?select=*&platform_account_id=eq.' + acct + '&order=started_at.desc&limit=1'))[0] || null; }
async function positions(c, acct) { return select(c, 'portfolio_positions?select=external_position_id,status,stake,odds_american,odds_decimal,profit_loss,settled_at,placed_at,selection&platform_account_id=eq.' + acct + '&order=placed_at.asc'); }
async function waitTwoMinutes(c, acct) {
  const r = await lastRun(c, acct);
  const wait = r ? 125000 - (Date.now() - Date.parse(r.started_at)) : 0;
  if (wait > 0) { console.log('waiting ' + Math.ceil(wait / 1000) + ' s (one manual sync every two minutes)…'); await new Promise((ok) => setTimeout(ok, wait)); }
}
async function environment(c) {
  const s = await fn(c, { action: 'ss_status' });
  if (s.status !== 200 || !s.body.ok) throw new Error('portfolio_connect did not answer ss_status (' + s.status + ' ' + (s.body.reason || '') + '): is it deployed with this change?');
  return s.body;
}

async function linkOrDiscover(c, test, env, wantSame) {
  const d = await fn(c, { action: 'ss_discover', smoke_test: test });
  const acct = await account(c, env);
  if (d.status === 200 && acct && acct.status !== 'DISCONNECTED' && (!wantSame || acct.id === wantSame)) return { ok: acct.metadata.provider_state && acct.metadata.provider_state.verified === true, acct, discover: d.body };
  const l = await fn(c, { action: 'ss_link', smoke_test: test });
  if (l.status === 200 && l.body.url) {
    console.log('\nOpen this SharpSports page, link ' + (env === 'sandbox' ? 'a TEST user (gooduser / Test1)' : 'your own account') + ', then run this stage again:\n  ' + l.body.url + '\n');
  } else console.log('ss_link answered ' + l.status + ' ' + JSON.stringify(l.body));
  return { ok: false, acct: null, pending: true };
}

async function runStage(c, test, stage, flags) {
  const info = await rpc(c, 'portfolio_svc_smoke_status', { p_test: test });
  if (!info || info.platform_key !== 'sharpsports') throw new Error('no SharpSports smoke test ' + test);
  const env = info.environment === 'PRODUCTION' ? 'production' : 'sandbox';
  const st = await environment(c);
  if (st.environment !== env) throw new Error('the deployed function reads ' + st.environment + '; this test is ' + env);
  let ok = false, detail = {};
  let acct = await account(c, env);
  if (stage === 'CONNECT' || stage === 'RECONNECT') {
    const before = acct && acct.id;
    const r = await linkOrDiscover(c, test, env, stage === 'RECONNECT' ? before : null);
    if (r.pending) return null;   /* nothing recorded until the reader has linked */
    ok = r.ok && (stage === 'CONNECT' || r.acct.id === before);
    detail = { platform: r.acct && r.acct.platform, verified: r.ok, same_account: stage === 'RECONNECT' ? r.acct.id === before : null };
  } else if (!acct) {
    detail = { error: 'no linked SharpSports account for the operator in ' + env + ' — run CONNECT first' };
  } else if (stage === 'IMPORT') {
    if (!(await lastRun(c, acct.id))) await fn(c, { action: 'sync', account_id: acct.id, smoke_test: test });
    const r = await lastRun(c, acct.id), ps = await positions(c, acct.id);
    ok = !!r && ['SUCCEEDED', 'PARTIAL'].indexOf(r.status) >= 0 && ps.length > 0; detail = { run: r && r.status, bets: ps.length, issues: r && (r.issues || []).length };
  } else if (stage === 'VERIFY') {
    const ps = await positions(c, acct.id);
    console.table(ps.map((p) => ({ bet: p.external_position_id, placed: p.placed_at, selection: String(p.selection).slice(0, 40), stake: p.stake,
      price: p.odds_american || p.odds_decimal, status: p.status, pnl: p.profit_loss })));
    const r = await lastRun(c, acct.id);
    ok = !!r && r.reconcile && r.reconcile.ok === true && flags.confirmed === true;
    detail = { reconciled: !!(r && r.reconcile && r.reconcile.ok), operator_confirmed_against_book: flags.confirmed === true, bets: ps.length };
    if (!flags.confirmed) console.log('Compare the table with the book\'s own bet history (or SharpSports\' dashboard in sandbox), then re-run with --confirmed.');
  } else if (['INCREMENTAL', 'NEW_ACTIVITY', 'SETTLEMENT', 'RECONCILE', 'NO_DUPLICATES'].indexOf(stage) >= 0) {
    const before = (await positions(c, acct.id)).length;
    if (stage === 'NO_DUPLICATES') await rpc(c, 'portfolio_svc_reset_cursor', { p_account: acct.id });
    if (stage === 'NEW_ACTIVITY' && !flags.synced) {
      const rf = await fn(c, { action: 'ss_refresh', account_id: acct.id, smoke_test: test });
      console.log('refresh: ' + rf.status + ' ' + (rf.body.status || rf.body.reason || '') + '. ' + (env === 'sandbox' ? 'In sandbox each refresh adds a few bets. ' : 'Place a small bet at the book first. ')
        + 'When SharpSports has answered (a few minutes; refreshResponse.created), run: stage ' + test + ' NEW_ACTIVITY --synced');
      return null;
    }
    await waitTwoMinutes(c, acct.id);
    const r = await fn(c, { action: 'sync', account_id: acct.id, smoke_test: test });
    const after = (await positions(c, acct.id)).length, run = await lastRun(c, acct.id);
    const settled = stage === 'SETTLEMENT' ? (await select(c, 'portfolio_position_settlements?select=id&platform=eq.' + acct.platform + '&recorded_at=gte.' + encodeURIComponent(info.started_at))).length : null;
    detail = { sync: r.body.status || r.body.reason, before, after, reconciled: !!(run && run.reconcile && run.reconcile.ok), settlements_since_test_began: settled };
    ok = r.status === 200 && ({ INCREMENTAL: after === before, NO_DUPLICATES: after === before, NEW_ACTIVITY: after > before, SETTLEMENT: settled > 0, RECONCILE: detail.reconciled })[stage];
  } else if (stage === 'DISCONNECT') {
    const r = await fn(c, { action: 'disconnect', account_id: acct.id, delete_history: false, smoke_test: test });
    const a = await account(c, env);
    ok = r.status === 200 && a && a.status === 'DISCONNECTED'; detail = { status: a && a.status };
  }
  const stages = await rpc(c, 'portfolio_svc_smoke_stage', { p_test: test, p_stage: stage, p_ok: !!ok, p_detail: K.redact(detail) });
  console.log(stage + ': ' + (ok ? 'PASSED' : 'NOT PASSED') + ' ' + JSON.stringify(K.redact(detail)));
  return stages;
}

async function probe(c) {
  for (const name of ['sharpsports-webhook', 'portfolio_connect']) {
    const r = await fetch(c.url + '/functions/v1/' + name).catch((e) => ({ status: 0, text: async () => String(e) }));
    const t = await r.text();
    console.log(name + ' GET ' + r.status + ' ' + t.slice(0, 500) + (r.status === 404 ? '\n  → 404: no function by this name is deployed (deploy it: see docs/sharpsports-betsync.md).'
      : r.status === 401 ? '\n  → 401: deployed WITH JWT verification; redeploy with --no-verify-jwt.' : ''));
  }
  const body = JSON.stringify({ type: 'edgedesk.probe', data: { note: 'unsigned probe from tools/portfolio/sharpsports_smoke.js' } });
  const r = await fetch(c.url + '/functions/v1/sharpsports-webhook', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  const t = await r.text();
  console.log('unsigned POST ' + r.status + ' ' + t.slice(0, 300) + '\n  → required mode answers 401; observe mode records it as FETCH_BACK and IGNORED (it names nothing EdgeDesk holds).');
}

async function main() {
  const [cmd, a, b] = process.argv.slice(2), flags = { confirmed: process.argv.indexOf('--confirmed') > 0, synced: process.argv.indexOf('--synced') > 0 };
  const c = cfg();
  if (cmd === 'probe') return probe(c);
  if (cmd === 'webhooks') { console.log(JSON.stringify(await rpc(c, 'portfolio_admin_aggregator_health', { p_hours: +(a || 24) }, true), null, 2)); return; }
  if (cmd === 'begin') {
    const st = await environment(c);
    if (!st.available) throw new Error('BetSync is not available to this operator: ' + (st.reason || '') + ' ' + (st.message || ''));
    const id = await rpc(c, 'portfolio_svc_ag_smoke_begin', { p_provider: 'sharpsports', p_env: st.environment, p_run_by: 'sharpsports_smoke.js' });
    console.log('smoke test ' + id + ' (' + st.environment + (st.environment === 'sandbox' ? ': a rehearsal, recorded DEMO — it cannot switch production on' : '') + '). Next: stage ' + id + ' CONNECT');
  } else if (cmd === 'stage') {
    if (K.SMOKE_STAGES.indexOf(b) < 0) { console.error('stage is one of ' + K.SMOKE_STAGES.join(', ')); process.exit(2); }
    await runStage(c, a, b, flags);
  } else if (cmd === 'finish') {
    const info = await rpc(c, 'portfolio_svc_smoke_status', { p_test: a });
    const st = await rpc(c, 'portfolio_svc_smoke_finish', { p_test: a });
    const all = K.SMOKE_STAGES.every((s) => info && info.stages && info.stages[s] && info.stages[s].ok);
    if (info && info.environment === 'DEMO') console.log('sandbox rehearsal ' + a + ': ' + (all ? 'all ten stages passed' : 'not all stages passed') + ' (recorded as DEMO; it cannot switch production on).');
    else {
      console.log('smoke test ' + a + ': ' + st);
      if (st === 'PASSED') console.log('\nOnce the SharpSports terms review is cleared (docs/sharpsports-betsync.md § Production), an operator switches it on with:\n'
        + "  update public.portfolio_platform_registry set automatic_enabled = true, enabled_by_smoke_test = '" + a + "', tos_review = 'CLEARED', enabled_at = now()\n   where platform_key = 'sharpsports';");
    }
  } else if (cmd === 'status') {
    console.log(JSON.stringify(await rpc(c, 'portfolio_svc_smoke_status', { p_test: a }), null, 2));
  } else {
    console.log('usage: probe | webhooks [hours] | begin | stage <test-id> <STAGE> [--confirmed|--synced] | finish <test-id> | status <test-id>');
    process.exit(2);
  }
}
if (require.main === module) main().catch((e) => { console.error(String(K.redact(String(e && e.message || e)))); process.exit(1); });
module.exports = { runStage };
