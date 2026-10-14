#!/usr/bin/env node
/* ===========================================================================
   JUICE REEL — THE LIVE CHECKS, against the deployed project (docs/juicereel.md).

   Run by an operator with network access to the project, AFTER Juice Reel has
   approved the EdgeDesk application (until then Juice Reel refuses its
   credentials and CONNECT cannot pass). Nothing here switches anything on.

   1. THE DEPLOYMENT. Is portfolio_connect deployed with the Juice Reel
      secrets, which redirect URI does it send (it must equal the one
      registered on the Juice Reel application, character for character),
      and is the callback page served there?
        node tools/portfolio/juicereel_smoke.js probe

   2. THE TEN-STAGE PRODUCTION SMOKE TEST (as connector_smoke.js does for
      Kalshi and Polymarket), with the operator's OWN real Juice Reel
      account. It is the evidence portfolio_registry_guard requires before
      the registry row 'juicereel' can be switched on for readers.
        node tools/portfolio/juicereel_smoke.js begin
        node tools/portfolio/juicereel_smoke.js stage <id> CONNECT        (connect in the app, Portfolio → Accounts → Juice Reel; run CONNECT again)
        node tools/portfolio/juicereel_smoke.js stage <id> IMPORT
        node tools/portfolio/juicereel_smoke.js stage <id> VERIFY         (compare with Juice Reel, then add --confirmed)
        node tools/portfolio/juicereel_smoke.js stage <id> INCREMENTAL
        node tools/portfolio/juicereel_smoke.js stage <id> NEW_ACTIVITY   (place a small bet Juice Reel tracks; once it shows in Juice Reel, add --synced)
        node tools/portfolio/juicereel_smoke.js stage <id> SETTLEMENT     (once one of your bets has settled in Juice Reel)
        node tools/portfolio/juicereel_smoke.js stage <id> RECONCILE
        node tools/portfolio/juicereel_smoke.js stage <id> DISCONNECT     (revokes at Juice Reel)
        node tools/portfolio/juicereel_smoke.js stage <id> RECONNECT      (connect again in the app; run RECONNECT again)
        node tools/portfolio/juicereel_smoke.js stage <id> NO_DUPLICATES
        node tools/portfolio/juicereel_smoke.js finish <id>

   ENVIRONMENT (never echoed):
     SB_URL, SB_SERVICE_ROLE      the project
     EDGEDESK_OPERATOR_TOKEN      the operator's signed-in access token
     EDGEDESK_SITE                optional; default https://edgedesksports.com
   =========================================================================== */
'use strict';
const path = require('path');
const K = require(path.join(__dirname, '..', '..', 'lib', 'edgedesk_portfolio_connect_core.js'));

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
async function status(c) {
  const s = await fn(c, { action: 'jr_status' });
  if (s.status !== 200 || !s.body.ok) throw new Error('portfolio_connect did not answer jr_status (' + s.status + ' ' + (s.body.reason || '') + '): is it deployed with this change?');
  return s.body;
}
async function grantRow(c, uid) { return rpc(c, 'portfolio_svc_jr_grant_for_user', { p_user: uid, p_env: 'production' }); }
async function bets(c, uid) {
  return select(c, 'portfolio_positions?select=id,external_position_id,platform,status,stake,odds_american,odds_decimal,profit_loss,placed_at,settled_at,selection,platform_account_id&user_id=eq.'
    + uid + '&external_position_id=like.juicereel:*&order=placed_at.asc');
}
async function books(c, uid) {
  const rows = await select(c, 'platform_accounts?select=id,platform,status,metadata&user_id=eq.' + uid + '&connection_type=eq.AGGREGATOR&order=created_at.asc');
  return rows.filter((a) => a.metadata && a.metadata.provider === 'juicereel');
}
async function waitTwoMinutes(g) {
  const wait = g && g.last_sync_at ? 125000 - (Date.now() - Date.parse(g.last_sync_at)) : 0;
  if (wait > 0) { console.log('waiting ' + Math.ceil(wait / 1000) + ' s (one manual sync every two minutes)…'); await new Promise((ok) => setTimeout(ok, wait)); }
}

async function runStage(c, test, stage, flags) {
  const info = await rpc(c, 'portfolio_svc_smoke_status', { p_test: test });
  if (!info || info.platform_key !== 'juicereel' || info.environment !== 'PRODUCTION') throw new Error('no PRODUCTION Juice Reel smoke test ' + test);
  const uid = await operatorId(c);
  let g = await grantRow(c, uid), ok = false, detail = {};
  if (stage === 'CONNECT' || stage === 'RECONNECT') {
    const before = stage === 'RECONNECT' ? (await books(c, uid)).map((a) => a.id).sort().join() : null;
    if (!g || g.status !== 'CONNECTED' || g.smoke_test !== test) {
      console.log('\nSigned in to EdgeDesk as this operator, open Portfolio → Accounts. The Juice Reel panel says it is connecting under smoke test '
        + test.slice(0, 8) + '…; press Connect Juice Reel, approve on Juice Reel, come back, then run this stage again.\n');
      return null;
    }
    const after = (await books(c, uid)).map((a) => a.id).sort().join();
    ok = g.status === 'CONNECTED' && (stage === 'CONNECT' || after === before || before === '');
    detail = { status: g.status, scopes: g.scopes, books: +g.books, same_books: stage === 'RECONNECT' ? after === before : null };
  } else if (!g || g.status === 'DISCONNECTED' && stage !== 'DISCONNECT') {
    detail = { error: 'the operator has no Juice Reel connection — run CONNECT first' };
  } else if (stage === 'IMPORT') {
    const ps = await bets(c, uid);
    ok = !!g.imported && !!g.last_success_at && ps.length > 0; detail = { imported: !!g.imported, bets: ps.length, books: +g.books, issues: (g.issues || []).length };
  } else if (stage === 'VERIFY') {
    const ps = await bets(c, uid);
    console.table(ps.map((p) => ({ bet: p.external_position_id, book: p.platform, placed: p.placed_at, selection: String(p.selection).slice(0, 40), stake: p.stake,
      price: p.odds_american || p.odds_decimal, status: p.status, pnl: p.profit_loss })));
    ok = flags.confirmed === true && ps.length > 0;
    detail = { bets: ps.length, operator_confirmed_against_juice_reel: flags.confirmed === true };
    if (!flags.confirmed) console.log('Compare every row with your bet history in Juice Reel (stake, price, result, P&L, book), then re-run with --confirmed.');
  } else if (['INCREMENTAL', 'NEW_ACTIVITY', 'SETTLEMENT', 'RECONCILE', 'NO_DUPLICATES'].indexOf(stage) >= 0) {
    const before = (await bets(c, uid)).length;
    if (stage === 'NEW_ACTIVITY' && !flags.synced) { console.log('Place a small bet at a book Juice Reel tracks for you. When it shows in Juice Reel, run: stage ' + test + ' NEW_ACTIVITY --synced'); return null; }
    if (stage === 'NO_DUPLICATES') await rpc(c, 'portfolio_svc_jr_reset_cursor', { p_grant: g.grant_id });
    await waitTwoMinutes(g);
    let r = await fn(c, { action: 'jr_sync', reconcile: stage === 'RECONCILE' });
    for (let i = 0; i < 20 && r.status === 200 && r.body.complete === false; i++) { await waitTwoMinutes(await grantRow(c, uid)); r = await fn(c, { action: 'jr_sync' }); }
    g = await grantRow(c, uid);
    const ps = await bets(c, uid), after = ps.length;
    const dupes = (await select(c, 'portfolio_positions?select=external_position_id&user_id=eq.' + uid + '&external_position_id=like.juicereel:*'))
      .reduce((m, x) => { m[x.external_position_id] = (m[x.external_position_id] || 0) + 1; return m; }, {});
    const settled = stage === 'SETTLEMENT' ? (await select(c, 'portfolio_position_settlements?select=id&user_id=eq.' + uid + '&external_position_id=like.juicereel:*&recorded_at=gte.'
      + encodeURIComponent(info.started_at))).length : null;
    detail = { sync: r.body.status || r.body.reason, before, after, duplicates: Object.keys(dupes).filter((k) => dupes[k] > 1).length, settlements_since_test_began: settled,
      not_at_juice_reel: (g.issues || []).filter((x) => x.code === 'NOT_AT_JUICE_REEL').length };
    ok = r.status === 200 && r.body.ok !== false && ({ INCREMENTAL: after === before, NO_DUPLICATES: after === before && detail.duplicates === 0, NEW_ACTIVITY: after > before,
      SETTLEMENT: settled > 0, RECONCILE: detail.not_at_juice_reel === 0 })[stage];
  } else if (stage === 'DISCONNECT') {
    const r = await fn(c, { action: 'jr_disconnect', delete_history: false });
    g = await grantRow(c, uid);
    const bk = await books(c, uid);
    ok = r.status === 200 && r.body.provider_revoked === true && g.status === 'DISCONNECTED' && bk.every((a) => a.status === 'DISCONNECTED') && (await bets(c, uid)).length > 0;
    detail = { revoked_at_juice_reel: r.body.provider_revoked, status: g.status, history_kept: (await bets(c, uid)).length };
  }
  const stages = await rpc(c, 'portfolio_svc_smoke_stage', { p_test: test, p_stage: stage, p_ok: !!ok, p_detail: K.redact(detail) });
  console.log(stage + ': ' + (ok ? 'PASSED' : 'NOT PASSED') + ' ' + JSON.stringify(K.redact(detail)));
  return stages;
}

async function probe(c) {
  const r = await fetch(c.url + '/functions/v1/portfolio_connect').catch((e) => ({ status: 0, json: async () => ({ error: String(e) }) }));
  const h = await r.json().catch(() => ({}));
  const j = h.configured && h.configured.juicereel;
  console.log('portfolio_connect GET ' + r.status + (r.status === 404 ? ' — not deployed' : r.status === 401 ? ' — deployed WITH JWT verification; redeploy with --no-verify-jwt' : ''));
  console.log('juicereel: ' + JSON.stringify(j || 'not in this build'));
  if (j && j.redirect_uri) {
    console.log('\nRegister EXACTLY this redirect URI on the Juice Reel application:\n  ' + j.redirect_uri + '\n');
    const p = await fetch(j.redirect_uri).catch(() => null);
    const t = p ? await p.text() : '';
    console.log('callback page at that URI: ' + (p ? p.status : 'unreachable') + (/edgedesk\.jr\.callback/.test(t) ? ' (the EdgeDesk callback page)' : ' — NOT the EdgeDesk callback page; is the site deployed?'));
  }
}

async function main() {
  const [cmd, a, b] = process.argv.slice(2), flags = { confirmed: process.argv.indexOf('--confirmed') > 0, synced: process.argv.indexOf('--synced') > 0 };
  const c = cfg();
  if (cmd === 'probe') return probe(c);
  if (cmd === 'begin') {
    const st = await status(c);
    if (!st.operator) throw new Error('EDGEDESK_OPERATOR_TOKEN is not an operator\'s');
    const id = await rpc(c, 'portfolio_svc_ag_smoke_begin', { p_provider: 'juicereel', p_env: 'production', p_run_by: 'juicereel_smoke.js' });
    console.log('smoke test ' + id + ' (PRODUCTION). Next: stage ' + id + ' CONNECT');
  } else if (cmd === 'stage') {
    if (K.SMOKE_STAGES.indexOf(b) < 0) { console.error('stage is one of ' + K.SMOKE_STAGES.join(', ')); process.exit(2); }
    await runStage(c, a, b, flags);
  } else if (cmd === 'finish') {
    const st = await rpc(c, 'portfolio_svc_smoke_finish', { p_test: a });
    console.log('smoke test ' + a + ': ' + st);
    if (st === 'PASSED') console.log('\nOnce Juice Reel has approved the application AND EdgeDesk\'s commercial use in writing, and the terms review is cleared (docs/juicereel.md § Switching on), an operator switches it on with:\n'
      + "  update public.portfolio_platform_registry set automatic_enabled = true, enabled_by_smoke_test = '" + a + "', tos_review = 'CLEARED', enabled_at = now()\n   where platform_key = 'juicereel';");
  } else if (cmd === 'status') {
    console.log(JSON.stringify(await rpc(c, 'portfolio_svc_smoke_status', { p_test: a }), null, 2));
  } else {
    console.log('usage: probe | begin | stage <test-id> <STAGE> [--confirmed|--synced] | finish <test-id> | status <test-id>');
    process.exit(2);
  }
}
if (require.main === module) main().catch((e) => { console.error(String(K.redact(String(e && e.message || e)))); process.exit(1); });
module.exports = { runStage };
