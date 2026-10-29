#!/usr/bin/env node
/* ===========================================================================
   research/radar/run_validation.js, end to end, OFFLINE: the registered
   protocol run against a scripted Polymarket (a SCENARIO built here, in the
   shapes the parsers read), so the one live look is never spent on a bug.

     protocol   the pool (volume, top 200, 50 a page), activity in the windows,
                the markets, bets, the training grade, the top 25 directional
                wallets, the holdout, the verdict
     fallback   a leaderboard that cannot order by volume: the registered
                profit fallback, said in the report's deviations
     selection  market makers, hedgers, truncated histories and small samples
                are never selected; the holdout reads only the selected
     report     its shape, its numbers equal evaluateHoldout's, the inputs'
                sha256, the registration's sha256; --check accepts it
     guard      an edited registration is refused before anything is asked

   Run: node tools/radar/validation.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const ROOT = path.join(__dirname, '..', '..');
const V = require(path.join(ROOT, 'research', 'radar', 'run_validation.js'));
const G = require(path.join(ROOT, 'lib', 'edgedesk_poly_gateway.js'));
const R = require(path.join(ROOT, 'lib', 'edgedesk_radar.js'));
let pass = 0, fail = 0;
const failures = [];
const chk = (name, ok, detail) => { if (ok) pass++; else { fail++; failures.push({ name, detail }); } };

/* ── the scripted Polymarket ─────────────────────────────────────────── */
const H = 3600e3, DAY = 864e5, MIN = 60e3;
const w = (i) => '0x' + String(i).padStart(40, '0');
const cid = (s) => '0x' + crypto.createHash('sha256').update('c' + s).digest('hex');
const tx = (s) => '0x' + crypto.createHash('sha256').update('t' + s).digest('hex');
const tok = (c, o) => String(BigInt('0x' + crypto.createHash('sha256').update(c + o).digest('hex').slice(0, 18)));
/* 80 training games (2026-03-01 on, NBA) and 40 holdout games (2026-09-05 on, NFL); outcome 0 wins when g is even */
const games = [];
for (let g = 0; g < 80; g++) games.push({ id: 'tr' + g, start: Date.parse('2026-03-01T23:00:00Z') + g * DAY, league: 'nba', win0: g % 2 === 0 });
for (let g = 0; g < 40; g++) games.push({ id: 'ho' + g, start: Date.parse('2026-09-05T17:00:00Z') + g * DAY, league: 'nfl', win0: g % 3 !== 0 });
games.forEach((m) => { m.c = cid(m.id); m.tokens = [tok(m.c, 0), tok(m.c, 1)]; m.slug = m.league + '-aaa-bbb-' + m.id; });
/* the price: 0.50 until 1 h 40 m before the start, then 0.53 to the start (a follower 5 minutes after a 2-hour entry pays 0.50; the close is 0.53) */
const priceAt = (m, t, oi) => { const p0 = t < m.start - 100 * MIN ? 0.5 : 0.53; return oi === 0 ? p0 : Math.round((1 - p0) * 100) / 100; };
/* 40 wallets: 0-29 and 38-39 directional (buy outcome 0, 2 h before), 30-34 market makers, 35-36 small samples, 37 (w(38)) truncated */
const WALLETS = Array.from({ length: 40 }, (_, i) => w(i + 1));
function activity(user) {
  const i = WALLETS.indexOf(user), rows = [];
  const tr = (m, oi, size, k) => rows.push({ proxy_wallet: user, type: 'TRADE', side: 'BUY', size, price: 0.5, timestamp: Math.floor((m.start - 2 * H + k * 1000) / 1000),
    transaction_hash: tx(user + m.id + oi + k), condition_id: m.c, asset: m.tokens[oi], outcome_index: oi, slug: m.slug, event_slug: m.slug });
  if (i < 30) games.forEach((m) => tr(m, 0, 100 + i, 0));
  else if (i < 35) games.forEach((m) => { for (let k = 0; k < 4; k++) { tr(m, 0, 100, k); tr(m, 1, 98, k + 10); } });
  else if (i < 37) games.slice(0, 20).forEach((m) => tr(m, 0, 100, 0));
  else games.forEach((m) => tr(m, 0, 100, 0));
  rows.push({ proxy_wallet: user, type: 'TRADE', side: 'BUY', size: 5, price: 0.4, timestamp: Math.floor(Date.parse('2026-04-01T00:00:00Z') / 1000), transaction_hash: tx(user + 'pol'),
    condition_id: cid('politics'), asset: '1', outcome_index: 0, slug: 'presidential-election', event_slug: 'presidential-election' });
  return rows;
}
const calls = [], marketQueries = [];
let volumeWorks = true;
async function fetchStub(url) {
  const u = new URL(url), p = u.pathname, q = (k) => u.searchParams.get(k);
  calls.push(p);
  const ok = (b) => ({ status: 200, headers: { get: () => null }, text: async () => JSON.stringify(b) });
  if (p === '/v1/leaderboard') {
    if (q('orderBy') === 'VOL' && !volumeWorks) return { status: 400, headers: { get: () => null }, text: async () => '{"error":"orderBy"}' };
    const off = +q('offset'), lim = +q('limit');
    return ok(WALLETS.slice(off, off + lim).map((x, k) => ({ rank: off + k + 1, proxyWallet: x, vol: 1e6 - off - k, pnl: 0 })));
  }
  if (p === '/v2/activity') {
    const user = q('user');
    if (user === w(38)) return ok({ data: [], pagination: { has_more: true, next_cursor: 'more' } });
    const rows = activity(user).filter((r) => r.timestamp >= +q('start') && r.timestamp <= +q('end'));
    return ok({ data: rows, pagination: { has_more: false } });
  }
  if (p === '/markets') {
    const ids = u.searchParams.getAll('condition_ids');
    marketQueries.push(u.search);
    /* as the real Gamma does (radar-sources run 40811733314): these markets are
       all resolved, and Gamma answers a resolved market only with closed=true */
    if (q('closed') !== 'true') return ok([]);
    return ok(games.filter((m) => ids.includes(m.c)).map((m) => ({ conditionId: m.c, question: 'A vs. B', slug: m.slug, outcomes: '["A","B"]', outcomePrices: JSON.stringify(m.win0 ? ['1', '0'] : ['0', '1']),
      clobTokenIds: JSON.stringify(m.tokens), sportsMarketType: 'moneyline', gameStartTime: new Date(m.start).toISOString(), closed: true, events: [{ id: 'e' + m.id, slug: m.slug, tags: [{ slug: m.league }] }] })));
  }
  if (p === '/prices-history') {
    const m = games.find((x) => x.tokens.includes(q('market'))), oi = m ? m.tokens.indexOf(q('market')) : 0, pts = [];
    if (m) for (let t = +q('startTs'); t <= +q('endTs'); t += 60) pts.push({ t, p: priceAt(m, t * 1000, oi) });
    return ok({ history: pts });
  }
  return { status: 404, headers: { get: () => null }, text: async () => 'unscripted' };
}

(async () => {
  try {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'hradar-'));
    const gw = G.make({ enabled: true, fetch: fetchStub, sleep: async () => {}, budget: G.fixedBudget(100000), pace_ms: { data: 0, gamma: 0, clob: 0 } });
    const rep = await V.run({ out, gateway: gw, started_at: new Date().toISOString() });
    chk('the run completes on the registered protocol', rep.status === 'complete' && rep.hypothesis_id === 'H-RADAR-01' && rep.version === '0.1.0', rep.status);
    chk('the report names the registration it ran against', rep.registration_sha256 === V.REGISTERED_SHA256);
    chk('the markets are asked with closed=true, the only way Gamma answers a resolved one', marketQueries.length > 0 && marketQueries.every((s) => /[?&]closed=true(&|$)/.test(s)), marketQueries.slice(0, 2));
    chk('the pool: every leaderboard wallet, by volume, read 50 a page', rep.data.pool === 40 && rep.data.pool_order_used === 'VOL' && calls.filter((c) => c === '/v1/leaderboard').length === 1, rep.data);
    chk('only league game markets are looked up (the politics trade is not)', rep.data.conditions_with_league_slug === 120 && rep.data.covered_markets === 120);
    chk('a history over 30 pages is truncated, counted', rep.data.wallets_truncated === 1);
    chk('styles: market makers found', rep.training.styles['Market Maker'] === 5, rep.training.styles);
    chk('the candidates: directional, complete history, 50+ resolved training bets (32)', rep.training.candidates === 32, rep.training);
    const never = WALLETS.slice(30, 38);   /* the market makers, the small samples, the truncated history */
    chk('the selection: the top 25 by Radar Score, none of them a market maker, a small sample or truncated', rep.selected.length === 25
      && rep.selected.every((s) => never.indexOf(s.wallet) < 0) && rep.selected.every((s, k) => s.rank === k + 1), rep.selected.map((s) => s.wallet).slice(0, 3));
    /* each selected wallet entered 40 holdout games 2 h before; the follow 5 min later is 0.50 and the close 0.53: every follow beats the close.
       Outcome 0 wins 26 of 40 (g % 3 != 0): ROI = (26 x 1 / 0.5 - 40) / 40 = +30% */
    chk('the holdout: 25 wallets x 40 games followed', rep.holdout.followed === 1000 && rep.holdout.games === 40, { f: rep.holdout.followed, g: rep.holdout.games });
    chk('beat-close 100%, follow ROI +30% (worked by hand)', rep.holdout.beat_close.rate === 1 && Math.abs(rep.holdout.follow_roi.mean - 0.3) < 1e-6, rep.holdout);
    chk('the verdict is evaluateHoldout\'s: C1, C2, C3 and passed', rep.holdout.criteria.length === 3 && rep.holdout.passed === rep.holdout.criteria.every((c) => c.met));
    /* 1,000 bets but only 40 games: the bootstrap resamples games, and 26 wins in 40 puts the follow ROI's lower bound at 0.0% (not
       above zero), so C3 fails and the test FAILS although its point estimates support the hypothesis: the registered rule, honestly */
    chk('40 games are 40 clusters: C1 and C2 pass, C3\'s lower bound is 0.0%, so it fails', rep.holdout.criteria[0].met && rep.holdout.criteria[1].met && !rep.holdout.criteria[2].met
      && rep.holdout.passed === false && rep.holdout.point_estimates_support_hypothesis === true, rep.holdout.criteria);
    chk('the headline says what the numbers say', /^H-RADAR-01 FAILED on its registered holdout: 1000 followed bets over 40 games; beat-close rate 100\.0% .*follow ROI 30\.0% \(95% CI 0\.0% to/.test(rep.headline), rep.headline);
    chk('everything read is kept, with a manifest and its sha256', fs.existsSync(path.join(out, 'manifest.json')) && /^[0-9a-f]{64}$/.test(rep.run.inputs_sha256) && rep.run.inputs_files > 100);
    const man = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
    chk('each kept body is gzipped and unzips to the JSON its manifest sha256 names', man.length === rep.run.inputs_files && man.every((m) => {
      const body = zlib.gunzipSync(fs.readFileSync(path.join(out, m.f))).toString('utf8');
      return /\.json\.gz$/.test(m.f) && body.length === m.bytes && crypto.createHash('sha256').update(body).digest('hex') === m.sha256 && JSON.parse(body) !== undefined;
    }));
    chk('no deviation on a clean run', rep.deviations.length === 0, rep.deviations);
    chk('the secondary (all ranked directional) is reported, never tested', rep.secondary_all_ranked_directional.wallets >= 25 && !('passed' in rep.secondary_all_ranked_directional));
    /* the fallback */
    volumeWorks = false; calls.length = 0;
    const out2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hradar-'));
    const rep2 = await V.run({ out: out2, gateway: G.make({ enabled: true, fetch: fetchStub, sleep: async () => {}, budget: G.fixedBudget(100000), pace_ms: { data: 0, gamma: 0, clob: 0 } }), started_at: 'x' });
    chk('volume ordering refused: the registered profit fallback, said in the deviations', rep2.data.pool_order_used === 'PNL' && /registered fallback/.test(rep2.deviations[0] || ''), rep2.deviations);
    volumeWorks = true;
    /* the budget */
    const rep3 = await V.run({ out: fs.mkdtempSync(path.join(os.tmpdir(), 'hradar-')), gateway: G.make({ enabled: true, fetch: fetchStub, sleep: async () => {}, budget: G.fixedBudget(3), pace_ms: { data: 0, gamma: 0, clob: 0 } }), started_at: 'x' }).catch((e) => ({ error: e.message }));
    chk('a run starved of requests fails loudly or reports what it could not read, never a silent pass', !!rep3.error || rep3.status !== 'complete' || rep3.deviations.length > 0, rep3.error || rep3.status);
    /* --check on a report written the way the live run writes it */
    const ok = R.evaluateHoldout([], R.rules(require(path.join(ROOT, 'research', 'radar', 'registration_h_radar_01.json')).spec.rules));
    chk('a report with no data never passes', ok.passed === false);
    /* the guard */
    const regFile = path.join(ROOT, 'research', 'radar', 'registration_h_radar_01.json');
    const raw = fs.readFileSync(regFile, 'utf8');
    let refused = null;
    try { fs.writeFileSync(regFile, raw.replace('"min_graded": 50', '"min_graded": 40')); V.registration(); } catch (e) { refused = e.message; } finally { fs.writeFileSync(regFile, raw); }
    chk('an edited registration is refused before anything is asked', /edited after it was registered/.test(refused || ''), refused);
    chk('(the registration is restored, byte for byte)', crypto.createHash('sha256').update(fs.readFileSync(regFile, 'utf8')).digest('hex') === V.REGISTERED_SHA256);
  } catch (e) {
    chk('the suite ran to the end', false, String(e && e.stack || e).slice(0, 1200));
  }
  failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 500) : '')));
  console.log((fail ? 'FAILED' : 'ALL GREEN') + ' H-RADAR-01 runner — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
