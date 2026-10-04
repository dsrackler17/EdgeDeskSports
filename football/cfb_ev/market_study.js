#!/usr/bin/env node
/* ============================================================================
   EdgeDesk EV — the MARKET studies and the HISTORICAL EV REPLAY
   (docs/edgedesk-ev/DESIGN.md §§14-15, 70-72).

   1. De-vig benchmark study: proportional, power, additive and Shin on every
      two-sided archived price, scored against outcomes (Brier, log loss). The
      winner is used ONLY for market-benchmark displays, never for EdgeDesk's
      probability.
   2. Favourite-longshot diagnostics: by raw implied-probability bucket,
      favourite/underdog, book, checkpoint (open vs close) and market type:
      realized frequency, raw vs de-vigged probability, ROI after vig. A
      research module: no correction enters production EV.
   3. Historical EV replay at prices that EXISTED at the time, never the best
      price in hindsight:
        moneyline 2022-2025 (the champion out of sample): closing prices at
          each archived book; raw EV and walk-forward-calibrated EV (research —
          the moneyline calibrator is NOT validated); realized ROI by EV bucket;
        spread 2015-2019: the only seasons with archived spread prices. The
          champion saw these seasons (IN SAMPLE), so the replay shows the
          mechanics and how raw EV overstates, never evidence of an edge.
        spread 2022-2025: NO archived prices exist. Not replayed — an assumed
          −110 is never used.

     node football/cfb_ev/market_study.js --data DIR [--replay DIR/out/disagreement_replay.jsonl]
   Writes football/cfb_ev/reports/market_study_v1.json and replay_v1.json.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const ROOT = path.resolve(__dirname, '..', '..');
global.window = global.window || global;
const EV = require(path.join(ROOT, 'lib', 'edgedesk_ev.js'));
const RD = require(path.join(ROOT, 'lib', 'edgedesk_read.js'));
const DS = require('./dataset.js');
const C = require('./calibrators.js');
const TN = require('./tournament.js');

function arg(n, d) { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; }
const N = (x) => x === '' || x == null || x === 'NA' ? null : (isFinite(Number(x)) ? Number(x) : null);
const r = (x, k) => x == null || !isFinite(x) ? null : +x.toFixed(k == null ? 5 : k);
function mean(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : null; }
function splitLine(l) { const out = []; let cell = '', q = false; for (let i = 0; i < l.length; i++) { const ch = l[i]; if (q) { if (ch === '"' && l[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; } else if (ch === '"') q = true; else if (ch === ',') { out.push(cell); cell = ''; } else cell += ch; } out.push(cell); return out; }

/* ------------------------------------------------ the archive, oriented to the schedule's home side */
function loadArchive(dataDir) {
  const sched = {};
  fs.readdirSync(path.join(dataDir, 'sched')).forEach((f) => {
    const L = fs.readFileSync(path.join(dataDir, 'sched', f), 'utf8').split('\n'), h = splitLine(L[0]);
    const ix = (k) => h.indexOf(k);
    L.slice(1).forEach((l) => { if (!l) return; const c = splitLine(l); const g = String(N(c[ix('game_id')]));
      sched[g] = { home_id: String(N(c[ix('home_id')])), away_id: String(N(c[ix('away_id')])), season: N(c[ix('season')]), week: N(c[ix('week')]),
        hp: N(c[ix('home_points')]), ap: N(c[ix('away_points')]), home_fbs: c[ix('home_division')] === 'fbs', away_fbs: c[ix('away_division')] === 'fbs', kick: c[ix('start_date')] }; });
  });
  const text = zlib.gunzipSync(fs.readFileSync(path.join(dataDir, 'betting', 'cfb_line_odds.csv.gz'))).toString('utf8').split('\n');
  const h = splitLine(text[0]), I = {}; h.forEach((k, i) => { I[k] = i; });
  const rows = [], seen = new Set(), swapped = new Set();
  for (let i = 1; i < text.length; i++) {
    if (!text[i]) continue;
    const c = splitLine(text[i]);
    const mt = c[I.market_type]; if (mt !== 'spread' && mt !== 'money_line') continue;
    const g = String(N(c[I.game_id])), s = sched[g]; if (!s) continue;
    const hid = String(N(c[I.home_team_id])), aid = String(N(c[I.away_team_id]));
    if (hid === s.away_id && aid === s.home_id) { swapped.add(g); continue; }
    const k = [g, mt, c[I.book], c[I.abbr], c[I.lines], c[I.odds], c[I.opening_lines], c[I.opening_odds]].join('|');
    if (seen.has(k)) continue; seen.add(k);
    rows.push({ g: g, mt: mt, book: c[I.book], abbr: c[I.abbr], line: N(c[I.lines]), odds: N(c[I.odds]), oline: N(c[I.opening_lines]), oodds: N(c[I.opening_odds]), hid: hid, aid: aid });
  }
  /* abbreviation → team id: the id it appears with most often (build_market.py / disagreement_replay.js) */
  const cnt = {};
  rows.forEach((x) => { [x.hid, x.aid].forEach((t) => { const k = x.abbr + '|' + t; cnt[k] = (cnt[k] || 0) + 1; }); });
  const best = {};
  Object.keys(cnt).forEach((k) => { const i = k.lastIndexOf('|'), ab = k.slice(0, i), t = k.slice(i + 1); if (!best[ab] || cnt[k] > best[ab].n) best[ab] = { t: t, n: cnt[k] }; });
  const byGame = {};
  rows.forEach((x) => {
    const b = best[x.abbr]; if (!b) return;
    const side = b.t === x.hid ? 'home' : (b.t === x.aid ? 'away' : null); if (!side) return;
    const G = byGame[x.g] || (byGame[x.g] = {}), key = x.mt + '|' + x.book, Bk = G[key] || (G[key] = { mt: x.mt, book: x.book });
    Bk[side] = { line: x.line, odds: x.odds, oline: x.oline, oodds: x.oodds };
  });
  return { sched: sched, byGame: byGame, swapped: swapped.size };
}
const VALID = (a) => a != null && isFinite(a) && Math.abs(a) >= 100 && Math.abs(a) <= 5000;

/* ------------------------------------------------ 1-2: de-vig benchmark + favourite-longshot */
function devigStudy(A) {
  const methods = EV.DEVIG_METHODS, rows = [];
  Object.keys(A.byGame).forEach((g) => {
    const s = A.sched[g]; if (!s || s.hp == null || s.ap == null || !(s.home_fbs && s.away_fbs) || s.season < 2015) return;
    const m = s.hp - s.ap;
    Object.values(A.byGame[g]).forEach((B) => {
      if (!B.home || !B.away) return;
      [['close', 'odds', 'line'], ['open', 'oodds', 'oline']].forEach(([cp, ok, lk]) => {
        const ph = B.home[ok], pa = B.away[ok];
        if (!VALID(ph) || !VALID(pa)) return;
        let y;
        if (B.mt === 'money_line') { if (m === 0) return; y = m > 0 ? 1 : 0; }
        else {
          const hl = B.home[lk], al = B.away[lk];
          if (hl == null || al == null || Math.abs(hl + al) > 1e-9) return;       /* both sides of ONE number */
          const c = m + hl; if (c === 0) return; y = c > 0 ? 1 : 0;
        }
        const dh = EV.americanToDecimal(ph), da = EV.americanToDecimal(pa), p = {};
        let ok2 = true;
        methods.forEach((mm) => { const d = EV.devig([dh, da], mm); p[mm] = d.ok ? d.p[0] : null; if (!d.ok && mm !== 'additive') ok2 = false; });
        if (!ok2) return;
        rows.push({ g: g, season: s.season, week: s.week, book: B.book, mt: B.mt === 'money_line' ? 'moneyline' : 'spread', cp: cp, ph: ph, pa: pa, qh: 1 / dh, qa: 1 / da, over: 1 / dh + 1 / da - 1, p: p, y: y });
      });
    });
  });
  const out = { n_rows: rows.length, by_market: {} };
  ['moneyline', 'spread'].forEach((mt) => {
    ['close', 'open'].forEach((cp) => {
      const R = rows.filter((x) => x.mt === mt && x.cp === cp);
      if (!R.length) return;
      const k = mt + '|' + cp, res = { n: R.length, games: new Set(R.map((x) => x.g)).size, books: [...new Set(R.map((x) => x.book))].length, seasons: [...new Set(R.map((x) => x.season))].sort(), mean_overround: r(mean(R.map((x) => x.over)), 4), methods: {} };
      methods.forEach((mm) => {
        const S = R.filter((x) => x.p[mm] != null);
        res.methods[mm] = { n: S.length, brier: r(C.brier(S.map((x) => x.p[mm]), S.map((x) => x.y)), 6), log_loss: r(C.logloss(S.map((x) => x.p[mm]), S.map((x) => x.y)), 6),
          guard_tripped: R.length - S.length };
      });
      const bestM = methods.filter((mm) => res.methods[mm].n === R.length).sort((a, b) => res.methods[a].log_loss - res.methods[b].log_loss)[0];
      /* paired, game-clustered comparison of the best against proportional */
      if (bestM && bestM !== 'proportional') {
        const d = R.map((x) => lossRow(x.p[bestM], x.y) - lossRow(x.p.proportional, x.y));
        const bt = TN.clusterBoot(d, R.map((x) => x.g), 1000, 4242);
        res.best_vs_proportional = { method: bestM, delta_log_loss: r(bt.mean, 7), ci95: [r(bt.ci95[0], 7), r(bt.ci95[1], 7)] };
      }
      res.best_method = bestM;
      /* favourite-longshot: every selection (both sides) by raw implied probability */
      const sel = [];
      R.forEach((x) => { sel.push({ q: x.qh, pp: x.p.proportional, pw: x.p.power, y: x.y, price: x.ph, book: x.book, fav: x.qh > x.qa }); sel.push({ q: x.qa, pp: 1 - x.p.proportional, pw: 1 - x.p.power, y: 1 - x.y, price: x.pa, book: x.book, fav: x.qa > x.qh }); });
      const edges = mt === 'moneyline' ? [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.01] : [0, 0.46, 0.48, 0.5, 0.52, 0.54, 0.56, 1.01];
      res.favorite_longshot = edges.slice(0, -1).map((lo, i) => {
        const hi = edges[i + 1], S = sel.filter((x) => x.q >= lo && x.q < hi);
        const units = S.map((x) => x.y ? EV.americanToDecimal(x.price) - 1 : -1);
        const roi = mean(units), sd = units.length > 1 ? Math.sqrt(units.reduce((a, v) => a + (v - roi) * (v - roi), 0) / (units.length - 1)) : null;
        return { bucket: lo.toFixed(2) + '–' + Math.min(1, hi).toFixed(2), n: S.length, mean_raw_implied: r(mean(S.map((x) => x.q)), 4), mean_devig_proportional: r(mean(S.map((x) => x.pp)), 4),
          mean_devig_power: r(mean(S.map((x) => x.pw)), 4), realized: r(mean(S.map((x) => x.y)), 4), wilson95: C.wilson(S.reduce((a, x) => a + x.y, 0), S.length),
          roi_after_vig: r(roi, 4), roi_ci95: roi != null && sd != null ? [r(roi - 1.96 * sd / Math.sqrt(units.length), 4), r(roi + 1.96 * sd / Math.sqrt(units.length), 4)] : null };
      });
      const favdog = (f) => { const S = sel.filter((x) => x.fav === f); const u = S.map((x) => x.y ? EV.americanToDecimal(x.price) - 1 : -1); return { n: S.length, realized: r(mean(S.map((x) => x.y)), 4), mean_devig: r(mean(S.map((x) => x.pp)), 4), roi_after_vig: r(mean(u), 4) }; };
      res.favorite = favdog(true); res.underdog = favdog(false);
      const byBook = {};
      sel.forEach((x) => { (byBook[x.book] = byBook[x.book] || []).push(x); });
      res.by_book = Object.keys(byBook).filter((b) => byBook[b].length >= 400).map((b) => { const S = byBook[b]; const u = S.map((x) => x.y ? EV.americanToDecimal(x.price) - 1 : -1);
        return { book: b, n: S.length, roi_after_vig: r(mean(u), 4), calibration_gap: r(mean(S.map((x) => x.y - x.pp)), 4) }; }).sort((a, b) => b.n - a.n);
      out.by_market[k] = res;
    });
  });
  out.rule = 'De-vigged market probabilities are a BENCHMARK. The best method by log loss is used for market-benchmark displays only; no favourite-longshot correction enters EdgeDesk EV.';
  return out;
}
function lossRow(p, y) { const q = Math.min(1 - 1e-6, Math.max(1e-6, p)); return -(y * Math.log(q) + (1 - y) * Math.log(1 - q)); }

/* ------------------------------------------------ 3: the historical EV replay */
function replay(A, dsRows, calArtifact) {
  const byG = {};
  dsRows.forEach((x) => { if (x.checkpoint === 'close') byG[x.game_id] = x; });
  const bucketOf = (e) => e < -0.05 ? '< −5%' : (e < 0 ? '−5% to 0' : (e < 0.02 ? '0 to +2%' : (e < 0.05 ? '+2% to +5%' : (e < 0.10 ? '+5% to +10%' : '≥ +10%'))));
  const ORDER = ['< −5%', '−5% to 0', '0 to +2%', '+2% to +5%', '+5% to +10%', '≥ +10%'];
  function summarize(bets, evKey) {
    const by = {};
    bets.forEach((b) => { const k = bucketOf(b[evKey]); (by[k] = by[k] || []).push(b); });
    return ORDER.filter((k) => by[k]).map((k) => { const S = by[k], u = S.map((b) => b.units), m = mean(u), sd = u.length > 1 ? Math.sqrt(u.reduce((a, v) => a + (v - m) * (v - m), 0) / (u.length - 1)) : null;
      const clv = S.filter((b) => b.clv_pts != null).map((b) => b.clv_pts);
      return { bucket: k, n: S.length, avg_stated_ev: r(mean(S.map((b) => b[evKey])), 4), realized_roi: r(m, 4), roi_ci95: sd != null ? [r(m - 1.96 * sd / Math.sqrt(u.length), 4), r(m + 1.96 * sd / Math.sqrt(u.length), 4)] : null,
        avg_clv_pts: clv.length ? r(mean(clv), 3) : null, positive_clv_rate: clv.length ? r(clv.filter((v) => v > 0).length / clv.length, 3) : null }; });
  }
  const out = {};
  /* MONEYLINE 2022-2025: the champion out of sample, closing prices at every archived book */
  const mlBets = [];
  const oosMl = dsRows.filter((x) => x.window === 'OOS' && x.checkpoint === 'close' && x.p_home_ml !== '' && (x.y_home_win === '0' || x.y_home_win === '1'));
  /* the walk-forward moneyline map (research: the tournament did NOT validate one) — Platt fitted on the OOS seasons before */
  const mlMaps = {};
  [2023, 2024, 2025].forEach((s) => { const t = oosMl.filter((x) => N(x.season) < s); mlMaps[s] = C.fitPlatt(t.map((x) => N(x.p_home_ml)), t.map((x) => N(x.y_home_win))); });
  Object.keys(A.byGame).forEach((g) => {
    const d = byG[g]; if (!d || d.window !== 'OOS' || N(d.season) < 2023) return;
    const s = A.sched[g]; if (!s || s.hp == null) return;
    const m = s.hp - s.ap; if (m === 0) return;
    const ph = N(d.p_home_ml), map = mlMaps[N(d.season)];
    Object.values(A.byGame[g]).forEach((B) => {
      if (B.mt !== 'money_line' || !B.home || !B.away || !VALID(B.home.odds) || !VALID(B.away.odds)) return;
      ['home', 'away'].forEach((side) => {
        const price = B[side].odds, dd = EV.americanToDecimal(price), p = side === 'home' ? ph : 1 - ph;
        const pc0 = C.apply(map, ph), pc = side === 'home' ? pc0 : 1 - pc0;
        const win = side === 'home' ? m > 0 : m < 0;
        mlBets.push({ g: g, season: N(d.season), book: B.book, side: side, price: price, raw_ev: EV.twoWayEv(p, 0, dd), cal_ev: EV.twoWayEv(pc, 0, dd), units: win ? dd - 1 : -1, clv_pts: null });
      });
    });
  });
  const pickBest = (bets, key) => { const by = {}; bets.forEach((b) => { const k = b.g + '|' + b.book; if (!by[k] || b[key] > by[k][key]) by[k] = b; }); return Object.values(by); };
  const mlRaw = pickBest(mlBets, 'raw_ev'), mlCal = pickBest(mlBets, 'cal_ev');
  out.moneyline_2023_2025 = {
    window: '2023-2025 (the champion out of sample; the walk-forward map needs a prior OOS season, so 2022 only trains)', books: [...new Set(mlBets.map((b) => b.book))],
    selection: 'each (game, book): the side with the higher EV at THAT book’s closing price (no cross-book shopping); every row a hypothetical 1u',
    raw_ev_buckets: summarize(mlRaw, 'raw_ev'),
    calibrated_ev_buckets: summarize(mlCal, 'cal_ev'),
    positive_raw_ev: { n: mlRaw.filter((b) => b.raw_ev > 0).length, roi: r(mean(mlRaw.filter((b) => b.raw_ev > 0).map((b) => b.units)), 4) },
    positive_cal_ev: { n: mlCal.filter((b) => b.cal_ev > 0).length, roi: r(mean(mlCal.filter((b) => b.cal_ev > 0).map((b) => b.units)), 4) },
    note: 'RESEARCH: the moneyline calibrator is NOT validated (tournament); the "calibrated" column is a walk-forward Platt map shown only to see whether calibration moves EV toward realized ROI. CLV is not available: the archive carries no moneyline openers after 2019.'
  };
  /* SPREAD 2015-2019: the only priced spread seasons — IN SAMPLE for the champion */
  const spBets = [], consClose = {};
  dsRows.forEach((x) => { if (x.checkpoint === 'close' && x.window === 'IN_SAMPLE') consClose[x.game_id] = x; });
  Object.keys(A.byGame).forEach((g) => {
    const d = consClose[g]; if (!d || N(d.season) > 2019) return;
    const s = A.sched[g]; if (!s || s.hp == null) return;
    const m = s.hp - s.ap, curve = DS.curveFor(N(d.fair_margin), N(d.sigma), N(d.cond_margin)).curve, closeH = N(d.close_home_line);
    Object.values(A.byGame[g]).forEach((B) => {
      if (B.mt !== 'spread' || !B.home || !B.away) return;
      [['close', 'odds', 'line'], ['open', 'oodds', 'oline']].forEach(([cp, ok, lk]) => {
        ['home', 'away'].forEach((side) => {
          const L = B[side][lk], price = B[side][ok];
          if (L == null || !VALID(price) || Math.abs(L * 2 - Math.round(L * 2)) > 1e-9) return;
          const p = RD.sideProb(curve, side, L); if (!p) return;
          const dd = EV.americanToDecimal(price), c = (side === 'home' ? m : -m) + L;
          const closeSide = side === 'home' ? closeH : -closeH;
          spBets.push({ g: g, season: N(d.season), book: B.book, cp: cp, side: side, line: L, price: price, raw_ev: EV.twoWayEv(p.win, p.push, dd),
            units: c > 0 ? dd - 1 : (c < 0 ? -1 : 0), clv_pts: cp === 'open' && closeSide != null ? L - closeSide : null });
        });
      });
    });
  });
  const spClose = pickBest(spBets.filter((b) => b.cp === 'close'), 'raw_ev'), spOpen = pickBest(spBets.filter((b) => b.cp === 'open'), 'raw_ev');
  out.spread_2015_2019 = {
    window: '2015-2019 — IN SAMPLE for the champion (its PMF was fitted on 2006-2021 and layers B/C tuned on 2014-2021): mechanics and raw-EV overstatement only, never evidence of an edge',
    books_close: [...new Set(spBets.filter((b) => b.cp === 'close').map((b) => b.book))].length, opener_book: '5Dimes (the only archived opener prices)',
    close: { selection: 'each (game, book): the side with the higher raw EV at that book’s closing line and price', raw_ev_buckets: summarize(spClose, 'raw_ev') },
    open: { selection: 'each game at the 5Dimes opener: the side with the higher raw EV; CLV to the consensus close', raw_ev_buckets: summarize(spOpen, 'raw_ev') },
    note: 'Raw EV only: no calibrator was fitted on seasons before 2015 (they are in sample too), and a calibrator from 2022-2025 would use the future.'
  };
  out.spread_2022_2025 = { status: 'NOT REPLAYED', why: 'the archive carries no spread prices after 2019; an assumed −110 is never used. The probability-level evaluation at the close is the calibration tournament.' };
  return out;
}

function main() {
  const dataDir = arg('data');
  if (!dataDir || !fs.existsSync(path.join(dataDir, 'betting', 'cfb_line_odds.csv.gz'))) { console.error('need --data DIR with betting/cfb_line_odds.csv.gz and sched/'); process.exit(2); }
  const A = loadArchive(dataDir);
  const ds = TN.readCsv(fs.readFileSync(path.join(__dirname, 'data', 'cfb_ev_calibration_rows_v1.csv.gz')));
  const study = devigStudy(A);
  const rep = replay(A, ds, null);
  const now = new Date().toISOString();
  fs.mkdirSync(path.join(__dirname, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'reports', 'market_study_v1.json'), JSON.stringify(Object.assign({ schema: 'edgedesk_ev_market_study_v1', built_at: now, archive: 'sportsdataverse/cfbfastR-data betting/cfb_line_odds.csv.gz', swapped_games_excluded: A.swapped }, study), null, 1) + '\n');
  fs.writeFileSync(path.join(__dirname, 'reports', 'replay_v1.json'), JSON.stringify(Object.assign({ schema: 'edgedesk_ev_replay_v1', built_at: now, rule: 'quotes that existed at the time, at their own book and price; never the best price in hindsight' }, rep), null, 1) + '\n');
  const mk = study.by_market;
  console.log(JSON.stringify({ devig: Object.keys(mk).map((k) => [k, mk[k].n, mk[k].best_method, mk[k].best_vs_proportional || null]),
    ml_raw: rep.moneyline_2023_2025.raw_ev_buckets, ml_cal: rep.moneyline_2023_2025.calibrated_ev_buckets, sp_close: rep.spread_2015_2019.close.raw_ev_buckets, sp_open: rep.spread_2015_2019.open.raw_ev_buckets }, null, 1));
}
if (require.main === module) main();
