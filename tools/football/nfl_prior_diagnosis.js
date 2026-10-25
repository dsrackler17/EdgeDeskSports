#!/usr/bin/env node
/* ===========================================================================
   THE NFL PRIOR-WEIGHT DIAGNOSIS (docs/nfl-prior-decay/DIAGNOSIS.md) —
   reproducible, read-only.

   WHAT IT ANSWERS. Week 7, KC @ SEA: the card had SEA -4.4 / 65.8% against a
   market near SEA -3 / 58.5%. Does the served model lean on 2025 and under-react
   to 2026 quarterback play? For every 2026 game in weeks 1-7 it rebuilds the
   served rating state exactly as the board does (football/nfl_model.js from the
   v2 seeds, one season break, every completed 2026 game through the one absorb
   path) and prices the game PREGAME, strictly before any game that kicked off
   at the same time or later is absorbed. Beside it, the same arithmetic on 2026
   data ALONE: every team prior, every club QB level and every quarterback value
   zeroed before week 1 (the league means kept), then the same 2026 games.

   Per game:
     replay        the served model's margin, win probability and seven card
                   rows, each team-rating row split into its 2025-prior and
                   2026 points, and each row's data window (nfl_model.js
                   cardWindows: the share of its inputs' weight on each season)
     current_only  the same rows from 2026 data alone
     published     the card the site published (record/football/nfl_2026.json:
                   first publication and the price-locked pick; weeks 2-7)
     market        the closing consensus (nflverse games.csv), de-vigged from
                   its moneylines; a game not yet played reads its latest line
     clv           the record's graded spread CLV (points the market moved
                   toward the card's side, recorded quote -> close) and the
                   moneyline CLV in win-probability points from the first
                   captured opener to the close (football/pricing/openers_nfl.json)
     top_chip      the card row with the largest contribution toward the model's
                   side of the market (home field excluded: it is one constant
                   for every home team), its data window and its 2026-only value

   Kalshi prices live only in Supabase (supabase/kalshi_market_data.sql), so the
   market here is the sportsbook consensus; for KC @ SEA the two agree within
   0.2 points of win probability (58.3% consensus, 58.5% Kalshi).

   Usage
     node tools/football/nfl_prior_diagnosis.js            # writes football/validation/nfl_prior_diagnosis.json
     node tools/football/nfl_prior_diagnosis.js --offline  # cached games.csv only
     node tools/football/nfl_prior_diagnosis.js --md       # also prints the report's tables
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
require(path.join(ROOT, 'football', 'params.js'));
const E = require(path.join(ROOT, 'football', 'engine.js'));
const V2 = require(path.join(ROOT, 'football', 'nfl_model.js'));
const PV = require(path.join(ROOT, 'football', 'nfl_params_v2.js'));
const FEEDS = require('./fetch_nfl_feeds.js');
const { parseCsv } = require(path.join(ROOT, 'football', 'nfl', 'build_team_week.js'));

const SEASON = 2026, WEEKS = [1, 7], GAP_PP = 5, FOCUS = '2026_07_KC_SEA';
const OUT = path.join(ROOT, 'football', 'validation', 'nfl_prior_diagnosis.json');
const num = (x) => (x == null || x === '' || x === 'NA' ? null : (Number.isFinite(+x) ? +x : null));
const r1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);
const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
const r3 = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);
const r4 = (x) => (Number.isFinite(x) ? Math.round(x * 10000) / 10000 : null);

/* ------------------------------------------------------------ market */
const amProb = (a) => (a > 0 ? 100 / (a + 100) : -a / (-a + 100));
function noVigHome(hml, aml) {
  if (!Number.isFinite(hml) || !Number.isFinite(aml)) return null;
  const h = amProb(hml), a = amProb(aml);
  return h / (h + a);
}

/* ------------------------------------------------------------ inputs */
async function gamesCsv(offline) {
  const url = FEEDS.FEEDS(SEASON)[0], p = FEEDS.key(url);
  if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  if (offline) throw new Error('offline and games.csv is not cached: run node tools/football/fetch_nfl_feeds.js');
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error('games.csv HTTP ' + r.status);
  const t = await r.text();
  fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t);
  return t;
}
function byGame(file) {
  const o = {};
  if (!fs.existsSync(file)) return o;
  parseCsv(fs.readFileSync(file, 'utf8')).rows.forEach((r) => { (o[r.game_id] = o[r.game_id] || []).push(r); });
  return o;
}
function readJson(rel, dflt) { try { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')); } catch (_) { return dflt; } }
function loadInputs(csvText) {
  const all = parseCsv(csvText).rows;
  const games = all.filter((g) => num(g.season) === SEASON).map((g) => Object.assign({}, g, { _kick: String(g.gameday) + 'T' + String(g.gametime || '13:00') }))
    .sort((a, b) => a._kick.localeCompare(b._kick) || String(a.game_id).localeCompare(String(b.game_id)));
  const stadiums = V2.indexStadiums(readJson('football/venues/nfl_stadiums.json', { stadiums: [] }));
  const intl = {};
  (readJson('football/venues/nfl_stadiums.json', { stadiums: [] }).stadiums || []).forEach((s) => {
    if (s.international) [s.name].concat(s.aliases || []).forEach((n) => { intl[String(n).toLowerCase()] = 1; });
  });
  return {
    games, stadiums, intl,
    stw: byGame(path.join(ROOT, 'football', 'nfl', `stats_team_week_${SEASON}.csv`)),
    qbg: byGame(path.join(ROOT, 'football', 'nfl', `qb_games_${SEASON}.csv`)),
    record: readJson(`record/football/nfl_${SEASON}.json`, { games: {} }).games || {},
    openers: readJson('football/pricing/openers_nfl.json', { games: {} }).games || {},
  };
}
const done = (g) => num(g.home_score) != null && num(g.away_score) != null;
const neutralOf = (g, intl) => g.location === 'Neutral' || !!(g.stadium && intl[String(g.stadium).toLowerCase()]);
/* the board's game request (app.html fbNflGameReq), quarterbacks from the schedule feed */
function gameReq(g, I) {
  const neutral = neutralOf(g, I.intl);
  return { home: g.home_team, away: g.away_team, week: num(g.week), season: SEASON,
    travel: V2.travelFor(I.stadiums, { season: SEASON, gameday: g.gameday, gametime: g.gametime, home: g.home_team, away: g.away_team, neutral, stadium: g.stadium }),
    home_rest: num(g.home_rest), away_rest: num(g.away_rest), roof: g.roof, surface: g.surface,
    div_game: num(g.div_game), temp: num(g.temp), wind: num(g.wind),
    home_qb_id: g.home_qb_id || null, away_qb_id: g.away_qb_id || null, neutral };
}
/* who took the snaps: the club's QB with the most dropbacks (training's credit rule, engine.js nfl.qbStarts) */
function actualStarter(rows, team) {
  let best = null, bd = -1;
  (rows || []).forEach((r) => {
    if (r.team !== team || String(r.position) !== 'QB') return;
    const d = num(r.attempts) + num(r.sacks_suffered);
    if (d > bd) { bd = d; best = r; }
  });
  return best ? { id: best.player_id, name: best.player_display_name, dropbacks: bd } : null;
}

/* ------------------------------------------------------------ states */
function servedState() {
  const st = V2.fromSeeds(V2.config(PV.cfg), PV.seeds);
  st.seededThrough = PV.seeds.season;
  for (let y = PV.seeds.season; y < SEASON; y++) V2.seasonBreak(st, y + 1);
  return st;
}
/* 2026 alone: no team prior, no club QB level, no quarterback history; league means kept */
function currentOnlyState() {
  const st = servedState();
  for (const t of Object.keys(st.team)) for (const f of V2.RATE_FEATS) st.team[t][f].p = 0;
  for (const t of Object.keys(st.teamQb)) st.teamQb[t] = 0;
  st.qb = {}; st.starts = {}; st.mr = {};
  return st;
}
function predict(st, req) {
  return E.predictGame({ sport: 'nfl', state: { v2: st, seededThrough: st.seededThrough }, season: SEASON, game: req, market: {} });
}
const rowsOf = (p) => (p && p.card ? p.card.rows.map((r) => ({ key: r.key, label: r.label, points: r4(r.points),
  prior: r.prior == null ? null : r4(r.prior), current: r.current == null ? null : r4(r.current),
  window: r.window ? { prior_share: r3(r.window.prior_share), current_share: r3(r.window.current_share) } : null })) : []);

/* THE REPLAY. Each kickoff slot is priced from a state holding exactly the
   games that kicked off before it, absorbed in the board's own order (gameday,
   then game_id: app.html fbLoadNfl, the order the arithmetic was trained in), so
   a card built after every earlier game is reproduced to the cent and no game
   sees a result from its own slot or later. */
function absorbInto(st, g, I) {
  V2.absorbCompleted(st, g, I.stw[g.game_id] || [], I.qbg[g.game_id] || []);
  V2.afterGame(st, { home: E.nfl.franchise(g.home_team), away: E.nfl.franchise(g.away_team), neutral: neutralOf(g, I.intl),
    close_home_margin: num(g.spread_line), home_score: num(g.home_score), away_score: num(g.away_score) });
}
function replay(mkState, I, keep) {
  const out = {};
  const boardOrder = I.games.filter(done).slice().sort((a, b) => String(a.gameday).localeCompare(String(b.gameday)) || String(a.game_id).localeCompare(String(b.game_id)));
  const slots = [...new Set(I.games.filter((g) => num(g.week) >= WEEKS[0] && num(g.week) <= WEEKS[1]).map((g) => g._kick))].sort();
  for (const slot of slots) {
    const st = mkState();
    boardOrder.forEach((g) => { if (g._kick < slot) absorbInto(st, g, I); });
    I.games.filter((g) => g._kick === slot && num(g.week) >= WEEKS[0] && num(g.week) <= WEEKS[1]).forEach((g) => {
      const req = gameReq(g, I);
      out[g.game_id] = { p: predict(st, req), req, extra: keep && keep(g.game_id) ? snapshotFocus(st, req) : null };
    });
  }
  return { out };
}

/* ------------------------------------------------------------ the focus game's raw inputs */
const FOCUS_FEATS = ['off_epa_play', 'def_epa_play', 'pass_epa_db', 'def_pass_epa_db', 'rush_epa_att', 'def_rush_epa_att', 'pts_for', 'pts_against'];
function teamInputs(st, t) {
  const o = {};
  FOCUS_FEATS.forEach((f) => {
    const x = st.team[t][f], w = V2.priorWeight(st.cfg, f, x.n);
    o[f] = { rating: r4(V2.rating(st, t, f)), carried_prior: r4(x.p), prior_weight: r3(w), season_mean: x.W > 0 ? r4(x.S / x.W) : null, games: x.n };
  });
  return o;
}
function qbInputs(st, t, id) {
  const q = st.qb[id] || null;
  return { id, value: q ? r4(q.v) : null, career_starts: q ? q.n : 0, season_starts: (st.qbSeason && st.qbSeason[id]) || 0,
    effective: r4(V2.qbEff(st, id)), club_level: r4(st.teamQb[t] || 0), adjust: r4(V2.qbAdjust(st, t, id)) };
}
function ranksOf(st, valueOf) {
  const teams = Object.keys(st.team).filter((t) => (st.games[t] || 0) > 0 || st.team[t].off_epa_play.p !== 0);
  const v = teams.map((t) => [t, valueOf(t)]).sort((a, b) => b[1] - a[1]);
  const out = {}; v.forEach(([t, x], i) => { out[t] = { rank: i + 1, of: v.length, value: r4(x) }; });
  return out;
}
function snapshotFocus(st, req) {
  const h = req.home, a = req.away;
  const cur = (t, f) => { const x = st.team[t][f]; return x.W > 0 ? x.S / x.W : 0; };
  const blend = ranksOf(st, (t) => V2.rating(st, t, 'off_epa_play') - V2.rating(st, t, 'def_epa_play'));
  const prior = ranksOf(st, (t) => st.team[t].off_epa_play.p - st.team[t].def_epa_play.p);
  const season = ranksOf(st, (t) => cur(t, 'off_epa_play') - cur(t, 'def_epa_play'));
  const pick = (R) => ({ [h]: R[h], [a]: R[a] });
  return {
    teams: { [h]: teamInputs(st, h), [a]: teamInputs(st, a) },
    qb: { [h]: qbInputs(st, h, req.home_qb_id), [a]: qbInputs(st, a, req.away_qb_id) },
    overall_efficiency_rank: { as_served: pick(blend), prior_only_2025: pick(prior), season_2026_mean: pick(season) },
  };
}

/* ------------------------------------------------------------ attribution */
/* the card row pushing hardest toward the model's side of the market. Home field
   is one fitted constant for every home team, so it is named only when no other
   row pushes that way. */
function topChip(rows, gapSign) {
  let best = null, hf = null;
  rows.forEach((r) => {
    if (!Number.isFinite(r.points)) return;
    const toward = gapSign * r.points;
    if (!(toward > 0)) return;
    const c = { key: r.key, label: r.label, points: r.points, toward: r4(toward), prior: r.prior, current: r.current, window: r.window };
    if (r.key === 'home_field') { hf = c; return; }
    if (!best || toward > best.toward) best = c;
  });
  return best || hf;
}
/* the season's first QB line for one passer: completions, attempts, yards, INT, EPA per dropback */
function seasonLine(I, id) {
  const tot = { games: 0, dropbacks: 0, epa: 0 };
  Object.keys(I.qbg).forEach((gid) => (I.qbg[gid] || []).forEach((r) => {
    if (r.player_id !== id) return;
    const d = num(r.attempts) + num(r.sacks_suffered); if (!(d > 0)) return;
    tot.games++; tot.dropbacks += d; tot.epa += num(r.passing_epa) || 0;
  }));
  return { games: tot.games, dropbacks: tot.dropbacks, epa_per_dropback: tot.dropbacks ? r3(tot.epa / tot.dropbacks) : null };
}

function analyze(I) {
  const served = replay(servedState, I, (id) => id === FOCUS);
  const cold = replay(currentOnlyState, I, (id) => id === FOCUS);
  const games = [];
  for (const g of I.games) {
    const sv = served.out[g.game_id]; if (!sv) continue;
    const cv = cold.out[g.game_id], wk = num(g.week);
    const rec = I.record[g.game_id] || null, op = I.openers[g.game_id] || null;
    const closeH = num(g.home_moneyline), closeA = num(g.away_moneyline);
    const mkt = noVigHome(closeH, closeA);
    const pub = rec ? (rec.pick || rec.first) : null;
    const pubP = pub && Number.isFinite(pub.home_win_prob) ? pub.home_win_prob : null;
    const rp = sv.p.model.home_win_prob, cp = cv.p.model.home_win_prob;
    const rows = rowsOf(sv.p), crow = rowsOf(cv.p);
    const gapRep = mkt == null ? null : (rp - mkt) * 100, gapPub = mkt == null || pubP == null ? null : (pubP - mkt) * 100;
    /* rows and gap from the same model: the served v2.1 replay */
    const tc = gapRep == null ? null : topChip(rows, Math.sign(gapRep));
    if (tc) { const c = crow.find((x) => x.key === tc.key); tc.current_only_points = c ? c.points : null; }
    /* moneyline CLV, win-probability points toward the card's side: from the card's
       own price lock (the quote it was published against) to the close; a card
       with no lock reads from the first captured opener */
    let mlClv = null;
    const lock = pub && pub.price_lock && pub.price_lock.moneyline && pub.price_lock.moneyline.prices;
    const from = lock && Number.isFinite(lock.home_ml) ? { h: lock.home_ml, a: lock.away_ml, basis: 'card price lock (' + (pub.price_lock.moneyline.book || 'book') + ')' }
      : (op && op.open ? { h: num(op.open.home_moneyline), a: num(op.open.away_moneyline), basis: 'first captured opener' } : null);
    if (from && pubP != null) {
      const o = noVigHome(from.h, from.a), c = mkt;
      if (o != null && c != null) { const side = pubP > o ? 1 : -1; mlClv = { side: side > 0 ? 'home' : 'away', basis: from.basis, from_no_vig_home: r4(o), close_no_vig_home: r4(c), pp: r2(side * (c - o) * 100) }; }
    }
    const grade = rec && rec.grade ? rec.grade : null;
    games.push({
      game_id: g.game_id, week: wk, matchup: `${g.away_team} @ ${g.home_team}`, played: done(g),
      starters: { feed: { home: g.home_qb_name || null, away: g.away_qb_name || null },
        took_the_snaps: done(g) ? { home: (actualStarter(I.qbg[g.game_id], g.home_team) || {}).name || null, away: (actualStarter(I.qbg[g.game_id], g.away_team) || {}).name || null } : null },
      replay: { model_version: PV.model_version, home_margin: r2(sv.p.model.fair_spread), home_win_prob: r4(rp), rows },
      current_only: { home_margin: r2(cv.p.model.fair_spread), home_win_prob: r4(cp), rows: crow.map((r) => ({ key: r.key, points: r.points })) },
      published: rec ? { first: rec.first ? { at: rec.first.at, home_win_prob: rec.first.home_win_prob, model_version: rec.first.model_version } : null,
        pick: rec.pick ? { at: rec.pick.at, home_win_prob: rec.pick.home_win_prob, model_version: rec.pick.model_version } : null } : null,
      market: { source: done(g) ? 'nflverse games.csv closing consensus' : 'nflverse games.csv latest consensus (game not yet final)',
        home_line: num(g.spread_line) == null ? null : -num(g.spread_line), home_ml: closeH, away_ml: closeA, no_vig_home: r4(mkt) },
      gap_pp: { published: r1(gapPub), replay: r1(gapRep), current_only: mkt == null ? null : r1((cp - mkt) * 100) },
      large_gap: { published: gapPub != null && Math.abs(gapPub) > GAP_PP, replay: gapRep != null && Math.abs(gapRep) > GAP_PP },
      top_chip: tc,
      clv: { spread_pts_entry: grade && grade.clv_entry && grade.clv_entry.spread ? grade.clv_entry.spread.pts : null,
        spread_pts_pick: grade && grade.clv_pick && grade.clv_pick.spread ? grade.clv_pick.spread.pts : null,
        grade_status: grade ? grade.status : null, moneyline: mlClv },
      outcome: done(g) ? { home_margin: num(g.home_score) - num(g.away_score) } : null,
    });
  }
  const focus = served.out[FOCUS], focusCold = cold.out[FOCUS];
  return { games, focus: focus ? { req: focus.req, served: focus.extra, current_only: focusCold && focusCold.extra,
    rows: rowsOf(focus.p), current_only_rows: rowsOf(focusCold.p), model: focus.p.model, current_only_model: focusCold.p.model,
    qb_lines: { [focus.req.home_qb_id]: seasonLine(I, focus.req.home_qb_id), [focus.req.away_qb_id]: seasonLine(I, focus.req.away_qb_id) } } : null };
}

/* ------------------------------------------------------------ summary */
function summarize(games) {
  const flag = (k) => games.filter((g) => g.large_gap[k]);
  const clvSign = (list, f) => { const v = list.map(f).filter((x) => x != null); return { n: v.length, positive: v.filter((x) => x > 0).length, zero: v.filter((x) => x === 0).length, negative: v.filter((x) => x < 0).length, mean: v.length ? r2(v.reduce((a, b) => a + b, 0) / v.length) : null }; };
  const chips = (list) => { const o = {}; list.forEach((g) => { const k = g.top_chip ? g.top_chip.key : 'none'; o[k] = (o[k] || 0) + 1; }); return o; };
  const playedRows = games.filter((g) => g.played && g.market.no_vig_home != null);
  const brier = (f) => { const v = playedRows.filter((g) => g.outcome.home_margin !== 0); return v.length ? r4(v.reduce((a, g) => a + Math.pow(f(g) - (g.outcome.home_margin > 0 ? 1 : 0), 2), 0) / v.length) : null; };
  const mae = (f) => (playedRows.length ? r2(playedRows.reduce((a, g) => a + Math.abs(f(g) - g.outcome.home_margin), 0) / playedRows.length) : null);
  const pubFlag = flag('published'), repFlag = flag('replay');
  const meanOf = (list, f) => { const v = list.map(f).filter((x) => x != null && Number.isFinite(x)); return v.length ? r3(v.reduce((a, b) => a + b, 0) / v.length) : null; };
  const byWeek = [];
  for (let w = WEEKS[0]; w <= WEEKS[1]; w++) {
    const L = games.filter((g) => g.week === w), P = L.filter((g) => g.played && g.market.no_vig_home != null && g.outcome.home_margin !== 0);
    const bw = (f) => (P.length ? r4(P.reduce((a, g) => a + Math.pow(f(g) - (g.outcome.home_margin > 0 ? 1 : 0), 2), 0) / P.length) : null);
    const winOf = (g, k) => { const r = g.replay.rows.find((x) => x.key === k); return r && r.window ? r.window.prior_share : null; };
    byWeek.push({ week: w, games: L.length, flagged_replay: L.filter((g) => g.large_gap.replay).length,
      prior_share: { base_strength: meanOf(L, (g) => winOf(g, 'base_strength')), passing: meanOf(L, (g) => winOf(g, 'passing')), quarterback: meanOf(L, (g) => winOf(g, 'quarterback')) },
      mean_abs_gap_pp: { replay: meanOf(L, (g) => g.gap_pp.replay == null ? null : Math.abs(g.gap_pp.replay)), current_only: meanOf(L, (g) => g.gap_pp.current_only == null ? null : Math.abs(g.gap_pp.current_only)) },
      brier: { n: P.length, replay: bw((g) => g.replay.home_win_prob), current_only: bw((g) => g.current_only.home_win_prob), close: bw((g) => g.market.no_vig_home) } });
  }
  return {
    by_week: byWeek,
    games: games.length, played: playedRows.length, gap_threshold_pp: GAP_PP,
    published: { flagged: pubFlag.length, top_chip: chips(pubFlag), clv_spread_pick: clvSign(pubFlag, (g) => g.clv.spread_pts_pick), clv_spread_entry: clvSign(pubFlag, (g) => g.clv.spread_pts_entry), clv_moneyline_pp: clvSign(pubFlag, (g) => g.clv.moneyline && g.clv.moneyline.pp) },
    replay: { flagged: repFlag.length, top_chip: chips(repFlag), clv_moneyline_pp: clvSign(repFlag, (g) => g.clv.moneyline && g.clv.moneyline.pp) },
    all_published_clv_spread_pick: clvSign(games.filter((g) => g.published), (g) => g.clv.spread_pts_pick),
    mean_abs_gap_pp: { replay: r2(games.filter((g) => g.gap_pp.replay != null).reduce((a, g) => a + Math.abs(g.gap_pp.replay), 0) / Math.max(1, games.filter((g) => g.gap_pp.replay != null).length)),
      current_only: r2(games.filter((g) => g.gap_pp.current_only != null).reduce((a, g) => a + Math.abs(g.gap_pp.current_only), 0) / Math.max(1, games.filter((g) => g.gap_pp.current_only != null).length)) },
    played_2026_reported_only: { n: playedRows.length,
      brier: { replay: brier((g) => g.replay.home_win_prob), current_only: brier((g) => g.current_only.home_win_prob), close: brier((g) => g.market.no_vig_home) },
      margin_mae: { replay: mae((g) => g.replay.home_margin), current_only: mae((g) => g.current_only.home_margin), close: mae((g) => -g.market.home_line) },
      note: '2026 weeks 1-7 is the live season: reported, never used to choose anything' },
  };
}

/* ------------------------------------------------------------ markdown */
const pct = (x) => (x == null ? '—' : (100 * x).toFixed(1) + '%');
const sg = (x, d) => (x == null ? '—' : (x > 0 ? '+' : '') + x.toFixed(d == null ? 1 : d));
const win = (w) => (w ? `2025 ${Math.round(100 * w.prior_share)}% / 2026 ${Math.round(100 * w.current_share)}%` : '—');
function markdown(doc) {
  const L = [];
  const pubList = doc.games.filter((g) => g.large_gap.published || g.large_gap.replay)
    .sort((a, b) => a.week - b.week || Math.abs(b.gap_pp.replay || 0) - Math.abs(a.gap_pp.replay || 0));
  L.push('| wk | game | flag | published (version) | v2.1 replay | 2026 only | close no-vig | gap pub / replay (pp) | top chip toward model (v2.1) | chip window | chip on 2026 only | spread CLV, pts (lock → close) | ML CLV, pp (lock → close) |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  pubList.forEach((g) => {
    const pv = g.published && (g.published.pick || g.published.first);
    const tc = g.top_chip, fl = (g.large_gap.published ? 'P' : '') + (g.large_gap.replay ? 'R' : '');
    L.push(`| ${g.week} | ${g.matchup} | ${fl} | ${pv ? pct(pv.home_win_prob) + ' (' + String(pv.model_version).replace('edgedesk_', '') + ')' : '— (no record)'} | ${pct(g.replay.home_win_prob)} | ${pct(g.current_only.home_win_prob)} | ${pct(g.market.no_vig_home)} | ${sg(g.gap_pp.published)} / ${sg(g.gap_pp.replay)} | ${tc ? tc.label + ' ' + sg(tc.points, 2) : '—'} | ${tc ? win(tc.window) : '—'} | ${tc && tc.current_only_points != null ? sg(tc.current_only_points, 2) : '—'} | ${g.clv.spread_pts_pick == null ? (g.clv.grade_status ? g.clv.grade_status.toLowerCase().replace('_', ' ') : '—') : sg(g.clv.spread_pts_pick)} | ${g.clv.moneyline ? sg(g.clv.moneyline.pp) : '—'} |`);
  });
  L.push('');
  L.push('| week | games | replay cards > 5 pp | prior share: base strength / passing / QB | mean abs gap, replay / 2026 only (pp) | Brier, replay / 2026 only / close (n) |');
  L.push('|---|---|---|---|---|---|');
  (doc.summary.by_week || []).forEach((w) => {
    const p = (x) => (x == null ? '—' : Math.round(100 * x) + '%');
    L.push(`| ${w.week} | ${w.games} | ${w.flagged_replay} | ${p(w.prior_share.base_strength)} / ${p(w.prior_share.passing)} / ${p(w.prior_share.quarterback)} | ${w.mean_abs_gap_pp.replay} / ${w.mean_abs_gap_pp.current_only} | ${w.brier.replay} / ${w.brier.current_only} / ${w.brier.close} (${w.brier.n}) |`);
  });
  return L.join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const I = loadInputs(await gamesCsv(argv.includes('--offline')));
  const A = analyze(I);
  const doc = { schema: 'edgedesk_nfl_prior_diagnosis_v1', generated_at: new Date().toISOString(), season: SEASON, weeks: WEEKS,
    served_model: PV.model_version, config_sha: PV.config_sha, gap_threshold_pp: GAP_PP,
    sources: { schedule_and_close: 'nflverse/nfldata games.csv (cached by tools/football/fetch_nfl_feeds.js)',
      team_rows: `football/nfl/stats_team_week_${SEASON}.csv`, qb_rows: `football/nfl/qb_games_${SEASON}.csv`,
      published: `record/football/nfl_${SEASON}.json`, openers: 'football/pricing/openers_nfl.json',
      kalshi: 'not in the repository (Supabase kalshi_closing_snapshot); the consensus moneyline is the market here' },
    summary: summarize(A.games), focus: A.focus, games: A.games };
  fs.writeFileSync(OUT, JSON.stringify(doc, null, 1) + '\n');
  console.log(`wrote ${path.relative(ROOT, OUT)}: ${doc.games.length} games, ${doc.summary.published.flagged} published cards and ${doc.summary.replay.flagged} replayed cards beyond ${GAP_PP} pp`);
  if (argv.includes('--md')) console.log('\n' + markdown(doc));
}
module.exports = { noVigHome, servedState, currentOnlyState, replay, loadInputs, topChip, actualStarter, rowsOf, summarize, markdown, GAP_PP };
if (require.main === module) main().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
