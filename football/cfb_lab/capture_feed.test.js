#!/usr/bin/env node
/* ===========================================================================
   The CFB Model Lab feed inside the Supabase `capture` function.

   The DEPLOYED file is imported (supabase/functions/capture/index.ts), with a
   Deno shim and a mocked network, the way tools/capture/capture.test.js does
   it. Checked here:

     - the home line is the HOME team's number, whichever order the book
       lists the outcomes in, and the away price goes with the away side;
     - decimal prices become American, rounded half away from zero;
     - a spread or total whose two sides disagree is skipped, never averaged;
     - a game that has started sends nothing (no in-play number is recorded);
     - every quote it sends passes the lab's own refusal rule
       (lab_core.quoteRefusal), so Postgres and the JS ledger accept it;
     - end to end: one RPC per chunk to cfb_lab_ingest_quotes with
       {p_quotes: [...]}, only for americanfootball_ncaaf;
     - FAIL-SOFT: the RPC failing (e.g. the migration not applied) is reported
       under `cfb_lab` and does not change the run's status;
     - CAPTURE_CFB_LAB=false turns it off.

   Run: node football/cfb_lab/capture_feed.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const L = require('./lab_core.js');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (ok) { pass++; return; }
  fail++; failures.push({ name, detail });
}
function done() {
  failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 600) : '')));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

const ENV = {
  CRON_SECRET: 'test-secret', ODDS_API_KEY: 'test-odds-key',
  SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'test-service-key',
  CAPTURE_NO_SERVE: '1', CAPTURE_SPORTS: 'americanfootball_ncaaf,americanfootball_nfl', CAPTURE_AUTO_PREFIXES: '',
};
globalThis.Deno = { env: { get: (k) => ENV[k] } };

const net = { calls: [], odds: {}, rpc: null };
function res(status, body, headers) {
  const h = headers || {};
  return { ok: status < 300, status, headers: { get: (n) => h[String(n).toLowerCase()] ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), json: async () => (typeof body === 'string' ? JSON.parse(body) : body) };
}
globalThis.fetch = async function (url, init) {
  const u = String(url), method = (init && init.method) || 'GET';
  net.calls.push({ url: u, method, body: init && init.body ? JSON.parse(init.body) : null });
  if (u.indexOf('api.the-odds-api.com/v4/sports/?') >= 0) return res(200, ['americanfootball_ncaaf', 'americanfootball_nfl'].map((k) => ({ key: k, active: true })));
  const m = /\/v4\/sports\/([^/]+)\/odds/.exec(u);
  if (m) return res(200, net.odds[decodeURIComponent(m[1])] || [], { 'x-requests-remaining': '4321', 'x-requests-used': '1', 'x-requests-last': '1' });
  if (u.indexOf('/rpc/cfb_lab_ingest_quotes') >= 0) return net.rpc ? net.rpc(u, init) : res(200, { received: 0, written: 0 });
  if (u.indexOf('sb.test') >= 0) return res(200, [], { 'content-range': '*/0' });
  return res(404, 'nope');
};

const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const KICK = iso(NOW + 30 * 3600e3);
function game(o) {
  o = o || {};
  const upd = iso(NOW - 120e3);
  return {
    id: o.id || 'oa_1', sport_key: 'americanfootball_ncaaf', commence_time: o.kick || KICK,
    home_team: 'Texas Longhorns', away_team: 'Oklahoma Sooners',
    bookmakers: o.bookmakers || [
      { key: 'draftkings', last_update: upd, markets: [
        /* away listed first: the home line must still be the home number */
        { key: 'spreads', last_update: upd, outcomes: [{ name: 'Oklahoma Sooners', price: 1.95, point: 6.5 }, { name: 'Texas Longhorns', price: 1.87, point: -6.5 }] },
        { key: 'totals', last_update: upd, outcomes: [{ name: 'Over', price: 1.91, point: 55.5 }, { name: 'Under', price: 1.91, point: 55.5 }] },
        { key: 'h2h', last_update: upd, outcomes: [{ name: 'Texas Longhorns', price: 1.36, point: null }, { name: 'Oklahoma Sooners', price: 3.25 }] },
      ] },
      { key: 'fanduel', last_update: upd, markets: [
        { key: 'spreads', last_update: upd, outcomes: [{ name: 'Texas Longhorns', price: 1.91, point: -7 }, { name: 'Oklahoma Sooners', price: 1.91, point: 6.5 }] },
        { key: 'totals', last_update: upd, outcomes: [{ name: 'Over', price: 1.9, point: 55.5 }, { name: 'Under', price: 1.92, point: 56 }] },
      ] },
    ],
  };
}

(async () => {
  const M = await import(path.join(__dirname, '..', '..', 'supabase', 'functions', 'capture', 'index.ts'));

  /* ---- the pure builder ---------------------------------------------- */
  chk('decimal 1.87 -> American -115, 1.95 -> -105, 3.25 -> +225, 2.00 -> +100', M.decimalToAmerican(1.87) === -115 && M.decimalToAmerican(1.95) === -105
    && M.decimalToAmerican(3.25) === 225 && M.decimalToAmerican(2) === 100, [M.decimalToAmerican(1.87), M.decimalToAmerican(1.95), M.decimalToAmerican(3.25)]);
  chk('an impossible decimal price is null, never a number', M.decimalToAmerican(1) === null && M.decimalToAmerican('x') === null && M.decimalToAmerican(0.5) === null);
  chk('the rounding matches the lab (half away from zero, via the same decimal rule)',
    [1.5, 1.8, 2.5, 1.909].every((d) => M.decimalToAmerican(d) === L.roundHalfAway(L.fromDecimal(d))));
  const out = M.cfbLabQuotes([game()], iso(NOW), NOW);
  const q = (book, mt) => out.quotes.find((x) => x.book === book && x.market_type === mt);
  const dks = q('draftkings', 'spread');
  chk('home line is the home team\'s number even when the book lists the away side first', dks && dks.home_line === -6.5, dks);
  chk('prices follow their sides: home -115, away -105', dks && dks.price_home === -115 && dks.price_away === -105, dks);
  const dkt = q('draftkings', 'total');
  chk('total: the number and the over/under prices', dkt && dkt.total_points === 55.5 && dkt.price_over === -110 && dkt.price_under === -110, dkt);
  const dkm = q('draftkings', 'moneyline');
  chk('moneyline: home -278, away +225', dkm && dkm.price_home === -278 && dkm.price_away === 225, dkm);
  chk('a spread whose sides disagree (-7 / +6.5) is skipped, not averaged', !q('fanduel', 'spread') && out.skipped['spread sides disagree about the number'] === 1, out.skipped);
  chk('a total whose sides disagree is skipped', !q('fanduel', 'total') && out.skipped['total sides disagree about the number'] === 1);
  chk('quotes carry the provider event, the kickoff, the teams and the observation time; game_id is left to the event map',
    out.quotes.every((x) => x.source === 'odds_api' && x.provider_event_id === 'oa_1' && x.game_id === null && x.kickoff_ts === KICK
      && x.home_team === 'Texas Longhorns' && x.observed_at === iso(NOW) && x.is_pregame === true && x.is_provider_close === false));
  chk('every quote passes the lab\'s own refusal rule', out.quotes.every((x) => L.quoteRefusal(Object.assign({ game_id: null }, x)) === null),
    out.quotes.map((x) => L.quoteRefusal(x)).filter(Boolean));
  const started = M.cfbLabQuotes([game({ kick: iso(NOW - 60e3) })], iso(NOW), NOW);
  chk('a game that has started sends nothing', started.quotes.length === 0 && started.skipped['started (in-play numbers are never recorded)'] === 1);
  chk('an event without teams or kickoff is skipped and counted', M.cfbLabQuotes([{ id: 'x' }], iso(NOW), NOW).skipped['event without id, teams or kickoff'] === 1);

  /* ---- end to end through handle() -------------------------------------- */
  const rq = () => new Request('https://fn.test/capture', { headers: { 'x-cron-secret': 'test-secret' } });
  net.odds = { americanfootball_ncaaf: [game()], americanfootball_nfl: [Object.assign(game({ id: 'nfl1' }), { sport_key: 'americanfootball_nfl' })] };
  {
    net.calls = []; net.rpc = (u, init) => res(200, { received: JSON.parse(init.body).p_quotes.length, written: 3 });
    const j = await (await M.handle(rq())).json();
    const rpc = net.calls.filter((c) => c.url.indexOf('/rpc/cfb_lab_ingest_quotes') >= 0);
    chk('one RPC to cfb_lab_ingest_quotes with {p_quotes: [...]}', rpc.length === 1 && Array.isArray(rpc[0].body.p_quotes) && rpc[0].method === 'POST', rpc.map((c) => c.body && Object.keys(c.body)));
    chk('only college quotes are sent', rpc.length === 1 && rpc[0].body.p_quotes.every((x) => x.provider_event_id === 'oa_1'));
    chk('the run log reports what was sent', j.cfb_lab && j.cfb_lab.sent === 3 && j.cfb_lab.errors.length === 0 && j.cfb_lab.results[0].written === 3, j.cfb_lab);
  }
  {
    net.rpc = () => res(404, '{"message":"Could not find the function public.cfb_lab_ingest_quotes"}');
    const before = await (async () => { const saved = ENV.CAPTURE_CFB_LAB; ENV.CAPTURE_CFB_LAB = 'false'; const r = await (await M.handle(rq())).json(); ENV.CAPTURE_CFB_LAB = saved; return r; })();
    const j = await (await M.handle(rq())).json();
    chk('FAIL-SOFT: a missing function is reported under cfb_lab', j.cfb_lab.errors.length === 1 && /HTTP 404/.test(j.cfb_lab.errors[0]), j.cfb_lab);
    chk('FAIL-SOFT: and the run status is what it would have been without the feed', j.status === before.status && j.ok === before.ok && !(j.write_errors || []).some((e) => /cfb_lab/.test(e)), { with: j.status, without: before.status });
  }
  {
    net.calls = [];
    ENV.CAPTURE_CFB_LAB = 'false';
    const j = await (await M.handle(rq())).json();
    delete ENV.CAPTURE_CFB_LAB;
    chk('CAPTURE_CFB_LAB=false sends nothing', !net.calls.some((c) => c.url.indexOf('cfb_lab') >= 0) && j.cfb_lab.enabled === false && j.cfb_lab.sent === 0);
  }
  done();
})().catch((e) => { console.error(e); process.exit(1); });
