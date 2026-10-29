#!/usr/bin/env node
/* ===========================================================================
   H-RADAR-01 — the registered holdout test, run ONCE.
   research/radar/registration_h_radar_01.json is the protocol; this file only
   carries it out. docs/prediction-radar.md §H-RADAR-01

     node research/radar/run_validation.js --live --out <dir>
         on a GitHub runner (.github/workflows/radar-validation.yml): every
         Polymarket request through the Radar gateway; everything read kept
         in <dir> (the run's artifact); the report printed between
         BEGIN/END H-RADAR-01 REPORT markers with its sha256, and written to
         <dir>/report.json. It is committed as research/radar/H-RADAR-01/
         report.json exactly as printed.
     node research/radar/run_validation.js --check
         offline: the registration is the registered one, and a committed
         report (if any) was run against it and says what it says.

   ONE LOOK. It refuses to fetch while research/radar/H-RADAR-01/report.json
   holds a completed report for this registration: a second look at the
   holdout needs a new registered version that counts this one.

   THE PROTOCOL, in the registration's words, step by step:
     1 the pool: the sports leaderboard, all time, by volume, top 200
     2 each wallet's activity from the training start to the holdout end
       (at most 30 pages of 1,000; more and the history is truncated)
     3 the markets those trades were in (Gamma), and which are covered
     4 the bets (lib/edgedesk_radar.js buildBets): training and holdout
     5 the training grade: style from every covered training trade; for the
       Directional wallets with 50+ resolved training bets, the close and
       the follow from the CLOB price history; the Radar Score; the top 25
     6 the holdout: the top 25's holdout bets, followed 5 (and 15) minutes
       after entry, against the close and the settlement
     7 the verdict (lib/edgedesk_radar.js evaluateHoldout): C1, C2, C3
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..', '..');
const R = require(path.join(ROOT, 'lib', 'edgedesk_radar.js'));
const G = require(path.join(ROOT, 'lib', 'edgedesk_poly_gateway.js'));

const REG_FILE = path.join(__dirname, 'registration_h_radar_01.json');
const REPORT_FILE = path.join(__dirname, 'H-RADAR-01', 'report.json');
/* the registration as committed at 184b2e3af (2026-10-29T01:18:53Z), before any data */
const REGISTERED_SHA256 = '56ca979aca235ce2dd6aceb31f0bab735f306c7a0f7e1f95f868fc900908cc5a';
const MIN = 60000, DAY = 864e5;

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function registration() {
  const raw = fs.readFileSync(REG_FILE, 'utf8');
  const h = sha(raw);
  if (h !== REGISTERED_SHA256) throw new Error('the registration was edited after it was registered (sha256 ' + h + ', registered ' + REGISTERED_SHA256 + '): refusing to run');
  return { R: JSON.parse(raw), sha: h };
}
const LEAGUE_PREFIX = /^(nfl|cfb|ncaaf|college-football|nba|nhl|mlb)-/;
/* every request the run makes, built in one place: tools/radar/fetch_sources.js
   asks these same forms on the runner before the one look */
const REQ = {
  leaderboard: (order, offset, rules) => ({ category: 'SPORTS', timePeriod: rules.pool_period, orderBy: order, limit: 50, offset }),
  activity: (wallet, fromMs, toMs, cursor) => ({ user: wallet, type: 'TRADE,REDEEM,SPLIT,MERGE', limit: 1000, sort_direction: 'ASC',
    start: Math.floor(fromMs / 1000), end: Math.floor(toMs / 1000) - 1, cursor }),
  /* Gamma answers a resolved market only when asked with closed=true (the
     probe, radar-sources run 40811733314: 23 resolved markets asked without
     it, none answered); only resolved markets can be graded */
  markets: (conditionIds) => ({ condition_ids: conditionIds, closed: true, limit: 50 }),
  prices: (token, fromMs, toMs) => ({ market: token, startTs: Math.floor(fromMs / 1000) - 900, endTs: Math.floor(toMs / 1000) + 60, fidelity: 1 })
};

/* ------------------------------------------------------------ the run */
async function run(opts) {
  const reg = registration();
  const S = reg.R, rules = R.rules(S.spec.rules);
  const W = S.machine.window_dates;
  const T0 = Date.parse(W.training[0] + 'T00:00:00Z'), T1 = Date.parse(W.training[1] + 'T00:00:00Z');
  const H0 = Date.parse(W.holdout[0] + 'T00:00:00Z'), H1 = Date.parse(W.holdout[1] + 'T00:00:00Z');
  const out = opts.out;
  fs.mkdirSync(path.join(out, 'raw'), { recursive: true });
  const manifest = [];
  let n = 0;
  const keep = (label, url, data) => {
    const body = JSON.stringify(data);
    const f = 'raw/' + String(++n).padStart(6, '0') + '_' + label + '.json';
    fs.writeFileSync(path.join(out, f), body);
    manifest.push({ f, url, sha256: sha(body), bytes: body.length });
  };
  const gw = opts.gateway;
  const deviations = [];
  const log = (s) => console.log('[' + new Date().toISOString() + '] ' + s);
  async function get(label, endpoint, params) {
    const r = await gw.get(endpoint, params);
    if (r.ok) keep(label, r.url, r.data);
    return r;
  }
  async function pool(n, f) {   /* n at a time, in order */
    const items = n.items, res = new Array(items.length); let i = 0;
    await Promise.all(Array.from({ length: n.width }, async () => { for (;;) { const k = i++; if (k >= items.length) return; res[k] = await f(items[k], k); } }));
    return res;
  }

  /* 1. the pool */
  let order = rules.pool_order, wallets = [];
  for (let off = 0; off < rules.pool_size; off += 50) {
    const r = await get('leaderboard', 'leaderboard', REQ.leaderboard(order, off, rules));
    if (!r.ok && off === 0 && order === 'VOL') { order = 'PNL'; deviations.push('the leaderboard could not be ordered by volume (' + r.decision + '): the registered fallback, profit ordering, was used'); off -= 50; continue; }
    if (!r.ok) throw new Error('the leaderboard failed at offset ' + off + ': ' + r.decision + ' ' + (r.reason || ''));
    const rows = R.page(r.data).rows.map(R.leaderRow).filter(Boolean);
    wallets.push(...rows);
    if (rows.length < 50) break;
  }
  wallets = wallets.filter((w, i, a) => a.findIndex((x) => x.wallet === w.wallet) === i).slice(0, rules.pool_size);
  log('pool: ' + wallets.length + ' wallets (' + order + ')');
  if (!wallets.length) throw new Error('the pool is empty');

  /* 2. activity */
  const acts = {}, trunc = {};
  await pool({ items: wallets, width: 4 }, async (w) => {
    const rows = [];
    let cursor = null, pages = 0, ok = true;
    for (;;) {
      const r = await get('activity', 'activity', REQ.activity(w.wallet, T0, H1, cursor));
      if (!r.ok) { ok = false; break; }
      pages++;
      const pg = R.page(r.data);
      for (const a of pg.rows) {
        const x = R.activityRow(a, w.wallet);
        /* only what a covered league's event could be: Polymarket files a game event under its league's slug */
        if (x && (LEAGUE_PREFIX.test(String(x.event_slug || '')) || LEAGUE_PREFIX.test(String(x.slug || '')))) rows.push(x);
      }
      if (!pg.has_more) break;
      if (pages >= rules.wallet_max_pages) { trunc[w.wallet] = true; break; }
      cursor = pg.next_cursor;
    }
    acts[w.wallet] = ok ? rows : null;
  });
  const failedWallets = wallets.filter((w) => acts[w.wallet] === null).map((w) => w.wallet);
  if (failedWallets.length) deviations.push(failedWallets.length + ' wallet(s) whose activity could not be read were left out: ' + failedWallets.slice(0, 10).join(', '));
  log('activity: ' + Object.values(acts).filter(Boolean).reduce((a, r) => a + r.length, 0) + ' league rows; truncated ' + Object.keys(trunc).length);

  /* 3. markets */
  const conds = Array.from(new Set([].concat(...Object.values(acts).filter(Boolean).map((rows) => rows.map((t) => t.condition_id)))));
  const markets = {};
  const chunks = []; for (let i = 0; i < conds.length; i += 50) chunks.push(conds.slice(i, i + 50));
  await pool({ items: chunks, width: 3 }, async (c) => {
    const r = await get('markets', 'markets', REQ.markets(c));
    if (!r.ok) return;
    for (const raw of R.page(r.data).rows) { const m = R.marketRow(raw); if (m) markets[m.condition_id] = m; }
  });
  const covered = Object.values(markets).filter((m) => R.covered(m, rules));
  log('markets: ' + conds.length + ' conditions, ' + Object.keys(markets).length + ' read, ' + covered.length + ' covered');

  /* 4. bets, and 5. the training grade */
  const hist = {};
  async function prices(bets) {
    const want = bets.filter((b) => !hist[b.token_id]);
    const byTok = {};
    for (const b of want) { const k = b.token_id; byTok[k] = byTok[k] || { from: b.entry_at, to: b.game_start_at }; byTok[k].from = Math.min(byTok[k].from, b.entry_at); }
    await pool({ items: Object.keys(byTok), width: 4 }, async (tok) => {
      const w = byTok[tok];
      const r = await get('prices', 'prices_history', REQ.prices(tok, w.from, w.to));
      hist[tok] = r.ok ? R.priceHistory(r.data) : [];
    });
  }
  const per = {};
  for (const w of wallets) {
    if (!acts[w.wallet]) continue;
    const b = R.buildBets(acts[w.wallet], markets, rules);
    const trainTrades = acts[w.wallet].filter((t) => markets[t.condition_id] && markets[t.condition_id].game_start_at >= T0 && markets[t.condition_id].game_start_at < T1);
    per[w.wallet] = {
      style: R.styleOf(trainTrades, markets, rules),
      train: b.bets.filter((x) => x.game_start_at >= T0 && x.game_start_at < T1 && x.settle != null),
      hold: b.bets.filter((x) => x.entry_at >= H0 && x.game_start_at >= H0 && x.game_start_at < H1),
      skipped: b.skipped
    };
  }
  const candidates = Object.keys(per).filter((w) => per[w].style.style === 'Directional' && !trunc[w] && per[w].train.length >= rules.min_graded);
  log('candidates (Directional, complete history, 50+ resolved training bets): ' + candidates.length);
  const grades = [];
  for (const w of Object.keys(per)) {
    let bets = per[w].train;
    if (candidates.indexOf(w) >= 0) {
      bets = bets.slice().sort((a, b) => b.entry_at - a.entry_at).slice(0, rules.max_bets_per_wallet);
      await prices(bets);
      bets = bets.map((b) => R.gradeBet(b, hist[b.token_id] || [], rules));
    }
    const g = R.gradeWallet(bets, per[w].style, rules);
    g.wallet = w; g.history_truncated = !!trunc[w];
    if (candidates.indexOf(w) < 0 && g.sample === 'ranked') { g.radar_score = null; g.sample = 'not_scored'; }  /* not Directional, or truncated: never selected, no prices fetched */
    grades.push(g);
  }
  const ranked = R.rankWallets(grades.filter((g) => g.sample === 'ranked'), rules);
  const selected = ranked.filter((g) => g.top_directional);
  log('ranked ' + ranked.length + ', selected ' + selected.length);

  /* 6. the holdout */
  const holdBets = [].concat(...selected.map((g) => per[g.wallet].hold));
  await prices(holdBets);
  const graded = holdBets.map((b) => R.gradeBet(b, hist[b.token_id] || [], rules));
  const verdict = R.evaluateHoldout(graded, rules);
  /* secondary: every ranked directional wallet, not only the top 25 (reported, never tested) */
  const allHold = [].concat(...ranked.map((g) => per[g.wallet].hold));
  await prices(allHold);
  const allVerdict = R.evaluateHoldout(allHold.map((b) => R.gradeBet(b, hist[b.token_id] || [], rules)), rules);

  /* 7. the report */
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest));
  const inputsSha = sha(manifest.map((m) => m.sha256).join('\n'));
  const pct = (x) => x == null ? 'n/a' : (x * 100).toFixed(1) + '%';
  const status = selected.length ? 'complete' : 'insufficient';
  const headline = status !== 'complete' ? 'H-RADAR-01 could not be evaluated: no wallet qualified for selection.'
    : 'H-RADAR-01 ' + (verdict.passed ? 'PASSED' : 'FAILED') + ' on its registered holdout: ' + verdict.followed + ' followed bets over ' + verdict.games + ' games; beat-close rate '
      + pct(verdict.beat_close.rate) + ' (95% CI ' + pct(verdict.beat_close.lo) + ' to ' + pct(verdict.beat_close.hi) + '); follow ROI ' + pct(verdict.follow_roi.mean)
      + ' (95% CI ' + pct(verdict.follow_roi.lo) + ' to ' + pct(verdict.follow_roi.hi) + ').';
  return {
    schema: 'edgedesk_radar_validation_report_v1', hypothesis_id: 'H-RADAR-01', version: S.version, registration_sha256: reg.sha, status, headline,
    run: { github_run_id: process.env.GITHUB_RUN_ID || null, commit: process.env.GITHUB_SHA || null, started_at: opts.started_at, finished_at: new Date().toISOString(),
      gateway: gw.stats(), inputs_sha256: inputsSha, inputs_files: manifest.length },
    data: { pool: wallets.length, pool_order_used: order, wallets_read: Object.keys(per).length, wallets_failed: failedWallets.length, wallets_truncated: Object.keys(trunc).length,
      conditions_with_league_slug: conds.length, markets_read: Object.keys(markets).length, covered_markets: covered.length,
      bets_skipped: Object.values(per).reduce((o, p) => { Object.keys(p.skipped).forEach((k) => { o[k] = (o[k] || 0) + p.skipped[k]; }); return o; }, {}) },
    training: { candidates: candidates.length, ranked: ranked.length,
      styles: Object.values(per).reduce((o, p) => { o[p.style.style] = (o[p.style.style] || 0) + 1; return o; }, {}) },
    selected: selected.map((g) => ({ wallet: g.wallet, rank: g.rank, radar_score: g.radar_score, score_parts: g.score_parts, graded_bets: g.graded_bets, roi: g.roi,
      clv_pp: g.clv_pp, follow5_roi: g.follow5_roi, follow5_n: g.follow5_n, holdout_bets: per[g.wallet].hold.length })),
    holdout: verdict,
    secondary_all_ranked_directional: { wallets: ranked.length, followed: allVerdict.followed, beat_close_rate: allVerdict.beat_close.rate, follow_roi: allVerdict.follow_roi.mean },
    deviations
  };
}

/* ------------------------------------------------------------ the command */
async function main() {
  if (process.argv.includes('--check')) {
    const reg = registration();
    if (!fs.existsSync(REPORT_FILE)) { console.log('ok      the registration is the registered one; no report yet (the holdout has not been looked at)'); return 0; }
    const rep = JSON.parse(fs.readFileSync(REPORT_FILE, 'utf8'));
    const bad = [];
    if (rep.registration_sha256 !== reg.sha) bad.push('the report was run against another registration');
    if (rep.hypothesis_id !== 'H-RADAR-01') bad.push('not an H-RADAR-01 report');
    if (rep.status === 'complete') {
      const h = rep.holdout || {};
      const crit = (h.criteria || []).map((c) => c.met);
      if (crit.length !== 3 || h.passed !== crit.every(Boolean)) bad.push('passed is not the three criteria together');
      if (h.criteria && h.criteria[0].value !== h.followed) bad.push('C1 is not the followed count');
    }
    if (bad.length) { console.log('FAIL    ' + bad.join('; ')); return 1; }
    console.log('ok      the report (' + rep.status + ') was run against the registered H-RADAR-01 and says what its numbers say');
    return 0;
  }
  if (!process.argv.includes('--live')) { console.log('usage: --live --out <dir> | --check'); return 2; }
  const reg = registration();
  if (fs.existsSync(REPORT_FILE)) {
    const rep = JSON.parse(fs.readFileSync(REPORT_FILE, 'utf8'));
    if (rep.status === 'complete' && rep.registration_sha256 === reg.sha) {
      console.log('ONE LOOK: research/radar/H-RADAR-01/report.json already holds a completed report for this registration. Nothing was fetched.');
      return 0;
    }
  }
  const out = arg('--out', path.join(__dirname, 'out'));
  const started = new Date().toISOString();
  const gw = G.make({ enabled: true, budget: G.fixedBudget(Number(arg('--budget', 80000))), pace_ms: { data: 110, gamma: 90, clob: 110 } });
  const rep = await run({ out, gateway: gw, started_at: started });
  const body = JSON.stringify(rep, null, 1) + '\n';
  fs.writeFileSync(path.join(out, 'report.json'), body);
  console.log('BEGIN H-RADAR-01 REPORT sha256=' + sha(body));
  process.stdout.write(body);
  console.log('END H-RADAR-01 REPORT');
  console.log(rep.headline);
  return 0;
}
if (require.main === module) main().then((c) => process.exit(c), (e) => { console.log('FAILED H-RADAR-01 run — ' + (e && e.stack || e)); process.exit(1); });
module.exports = { run, registration, REGISTERED_SHA256, REQ, LEAGUE_PREFIX };
