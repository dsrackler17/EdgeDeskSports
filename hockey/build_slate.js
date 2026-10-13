#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk NHL — the slate: a fair price for every market of every upcoming
   game, with the evidence, the uncertainty and the record behind it.

     node hockey/build_slate.js [--offline] [--hours 72] [--now 2026-10-13T16:00:00Z]
     node hockey/build_slate.js --check

   Reads the committed team-game table, the live parameters
   (hockey/model/params/live.json, fitted only on completed seasons), the
   season schedule (sportsdataverse, refreshed daily) and — when reachable —
   the NHL's own schedule API for today's times and states. Writes
   hockey/slate.json (schema edgedesk_nhl_slate_v1) and appends changed
   pregame sheets to hockey/ledger/<season>.jsonl.

   WHAT A PRICE HERE IS. EdgeDesk's own fair line from the validated model
   (hockey/validation/nhl_walkforward.json). It is NOT a betting opinion:
   NHL prices are not captured by default, the model has never been tested
   against the closing market, and so every market's `value_claims` is
   DISABLED. The cross-sport board (lib/edgedesk_xboard.js) reads this file
   and refuses to call any NHL price an edge until both change.

   GOALIES. Starters are rarely confirmed when a price is posted. The sheet is
   priced with the chosen model; the goalie block shows who is projected to
   start (recent usage, the league's back-to-back rule) and how the moneyline
   and total move under each realistic pairing, from the goalie-aware variant
   of the same model. A starter recorded in hockey/data/confirmed_starters.json
   (with its source and time) replaces the projection.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const C = require('./config');
const io = require('./lib/io');
const W = require('./model/walkforward');
const GLM = require('./model/glm');
const DIST = require('./model/distribution');
const V = require('../engine/validation');
const NHLAPI = require('./sources/nhl_api');
const { dayNum } = require('./model/ratings');

function arg(name, dflt) { const i = process.argv.indexOf('--' + name); return i >= 0 ? process.argv[i + 1] : dflt; }
function flag(name) { return process.argv.includes('--' + name); }
function r4(v) { return v == null || !isFinite(v) ? null : Math.round(v * 10000) / 10000; }
function r2(v) { return v == null || !isFinite(v) ? null : Math.round(v * 100) / 100; }
function readJson(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return d; } }
const am = DIST.probToAmerican;

async function loadSchedule(offline) {
  const url = C.SOURCES.schedule(C.CURRENT_SEASON);
  const local = path.join(C.PATHS.cacheSrc, path.basename(new URL(url).pathname));
  let src;
  if (offline) src = fs.existsSync(local) ? { ok: true, file: local, url, fetched_at: fs.statSync(local).mtime.toISOString(), offline: true } : { ok: false, url };
  else src = await io.fetchSource(url, { ttlMs: 3 * 3600e3 });
  const games = [];
  if (src.ok) {
    const { rows } = await io.parquetAll(src.file, C.SCHEDULE_COLUMNS);
    for (const r of rows) games.push({ game_id: io.num(r.game_id), game_type: r.game_type, date: r.game_date, start_utc: r.game_time, home: r.home_team_abbr, away: r.away_team_abbr, state: r.game_state, venue: r.venue, source: 'sportsdataverse_schedule' });
  }
  return { games, source: { url, fetched_at: src.fetched_at || null, ok: !!src.ok, sha256: src.sha256 || null } };
}

async function refreshFromApi(games, now, hours, offline) {
  if (offline) return { used: false, reason: 'offline run' };
  const days = new Set();
  for (let t = now - 864e5; t <= now + hours * 3600e3; t += 864e5) days.add(new Date(t).toISOString().slice(0, 10));
  const byId = new Map(games.map((g) => [g.game_id, g]));
  let fetched = 0, updated = 0, failed = null;
  for (const d of [...days].sort()) {
    const res = await NHLAPI.fetchWeek(d); /* a week per call: one or two calls cover the horizon */
    if (!res.ok) { failed = res.error; break; }
    fetched++;
    for (const g of res.games) {
      if (g.game_type !== 'R' && g.game_type !== 'P') continue;
      const cur = byId.get(g.game_id);
      if (cur) { if (cur.state !== g.state || cur.start_utc !== g.start_utc) updated++; Object.assign(cur, { state: g.state, start_utc: g.start_utc || cur.start_utc, source: 'nhl_api' }); }
      else { games.push(g); byId.set(g.game_id, g); updated++; }
    }
    if (fetched >= 2) break;
  }
  return { used: fetched > 0, fetched, updated, error: failed };
}

function bin(bins, p) { return (bins || []).find((b) => p >= b.lo && p < b.hi) || null; }

function build(o) {
  const live = readJson(path.join(C.HOCKEY, 'model', 'params', 'live.json'), null);
  const val = readJson(path.join(C.PATHS.validation, 'nhl_walkforward.json'), null);
  if (!live || !val) throw new Error('no live parameters or validation record: run hockey/model/walkforward.js');
  const now = o.now;
  const seasons = []; for (let s = C.FIRST_SEASON; s <= C.CURRENT_SEASON; s++) seasons.push(s);
  const { rows, games } = W.loadGames(seasons);
  const P = W.seasonParams(rows, seasons, false);
  const { state: rs } = W.ratingsPass(games, P, live.ratings);
  const goalieNames = readJson(C.PATHS.goalies, {});
  const confirmed = readJson(path.join(C.HOCKEY, 'data', 'confirmed_starters.json'), { starters: {} }).starters || {};
  const lastCompleted = games.length ? games[games.length - 1] : null;
  const completedIds = new Set(games.map((g) => g.game_id));

  const sched = o.schedule.slice().filter((g) => g.game_type === 'R' || g.game_type === 'P');
  /* the schedule's own view of each team's previous game (completed or not) for rest and back-to-backs */
  const byTeam = new Map();
  for (const g of sched) for (const t of [g.home, g.away]) { if (!byTeam.has(t)) byTeam.set(t, []); byTeam.get(t).push(g.date); }
  for (const v of byTeam.values()) v.sort();
  const prevDate = (team, date) => { const d = byTeam.get(team) || []; let best = null; for (const x of d) if (x < date) best = x; return best; };

  const horizon = now + o.hours * 3600e3;
  const upcoming = sched.filter((g) => {
    const t = Date.parse(g.start_utc);
    return isFinite(t) && t > now && t <= horizon && !completedIds.has(g.game_id) && !/^(LIVE|CRIT|FINAL|OFF)$/.test(String(g.state || ''));
  }).sort((a, b) => Date.parse(a.start_utc) - Date.parse(b.start_utc) || a.game_id - b.game_id);
  /* results the schedule calls final but the play-by-play has not delivered yet */
  const lagging = sched.filter((g) => /^(FINAL|OFF)$/.test(String(g.state || '')) && !completedIds.has(g.game_id) && Date.parse(g.start_utc) < now - 6 * 3600e3);

  const chosen = live.model, gfit = live.glm[chosen], gGoalie = live.glm.xg_goalie_confirmed, gGoals = live.glm.goals_only;
  const cal = live.pair_calibration || {};
  const eff = live.effects || DIST.neutralEffects();
  const bins = val.windows && val.windows.confirmation && val.windows.confirmation.by_candidate[chosen] ? val.windows.confirmation.by_candidate[chosen].moneyline.bins : [];
  const out = [];
  for (const g of upcoming) {
    const day = dayNum(g.date);
    const fh = rs.snapshot(g.home, g.away, true, g.date, null);
    const fa = rs.snapshot(g.away, g.home, false, g.date, null);
    /* rest from the schedule, not only from completed games */
    for (const [f, team, opp] of [[fh, g.home, g.away], [fa, g.away, g.home]]) {
      const pd = prevDate(team, g.date), po = prevDate(opp, g.date);
      f.rest = pd ? Math.min(5, day - dayNum(pd)) : 5; f.rest_opp = po ? Math.min(5, day - dayNum(po)) : 5;
      f.b2b = f.rest === 1 ? 1 : 0; f.b2b_opp = f.rest_opp === 1 ? 1 : 0;
    }
    const ot = g.game_type === 'P' ? { format: 'PO' } : live.ot;
    const price = (model, calib, sh, sa) => {
      const raw = { lh: GLM.predict(model, sh), la: GLM.predict(model, sa) };
      const c = GLM.applyPairCalibration(raw.lh, raw.la, calib);
      return DIST.game({ lamH: c.lh, lamA: c.la, effects: eff, ot });
    };
    const D = price(gfit, cal[chosen], fh, fa);
    const sheet = DIST.sheet(D);
    /* goalie scenarios from the goalie-aware variant */
    const projH = rs.projectStarters(g.home, day).slice(0, 2), projA = rs.projectStarters(g.away, day).slice(0, 2);
    const conf = confirmed[String(g.game_id)] || null;
    const scen = [];
    const gH = conf && conf.home ? [{ goalie: conf.home, p: 1, confirmed: true }] : projH;
    const gA = conf && conf.away ? [{ goalie: conf.away, p: 1, confirmed: true }] : projA;
    const sumH = gH.reduce((a, x) => a + x.p, 0) || 1, sumA = gA.reduce((a, x) => a + x.p, 0) || 1;
    for (const h of gH.length ? gH : [{ goalie: null, p: 1 }]) for (const a of gA.length ? gA : [{ goalie: null, p: 1 }]) {
      const sh = Object.assign({}, fh, { opp_goalie_act: rs.goalieRating(a.goalie, day).rate });
      const sa = Object.assign({}, fa, { opp_goalie_act: rs.goalieRating(h.goalie, day).rate });
      const Dg = price(gGoalie, cal.xg_goalie_confirmed, sh, sa);
      scen.push({ home_goalie: h.goalie, home_goalie_name: goalieNames[h.goalie] || null, away_goalie: a.goalie, away_goalie_name: goalieNames[a.goalie] || null, p_scenario: r4((h.p / sumH) * (a.p / sumA)), p_home: r4(Dg.p_home), exp_total: r2(DIST.expectedTotal(Dg)) });
    }
    const Dgoals = price(gGoals, cal.goals_only, fh, fa);
    const variants = [D.p_home, Dgoals.p_home].concat(scen.map((x) => x.p_home));
    const mean = variants.reduce((a, v) => a + v, 0) / variants.length;
    const sdPP = Math.sqrt(variants.reduce((a, v) => a + (v - mean) * (v - mean), 0) / variants.length) * 100;
    const totals = [DIST.expectedTotal(D), DIST.expectedTotal(Dgoals)].concat(scen.map((x) => x.exp_total));
    const tm = totals.reduce((a, v) => a + v, 0) / totals.length;
    const totSd = Math.sqrt(totals.reduce((a, v) => a + (v - tm) * (v - tm), 0) / totals.length);
    const b = bin(bins, D.p_home);
    const pct = (v) => r4(v);
    const goalieCertainty = conf ? 'CONFIRMED' : (gH[0] && gH[0].p >= 0.8 && gA[0] && gA[0].p >= 0.8 ? 'PROJECTED_LIKELY' : 'PROJECTED_UNCERTAIN');
    const weights = Math.min(fh.weight || 0, fa.weight || 0);
    out.push({
      game_id: g.game_id, event_key: 'NHL|' + g.game_id, date: g.date, start_utc: g.start_utc, type: g.game_type, home: g.home, away: g.away, venue: g.venue || null, state: g.state || null, schedule_source: g.source,
      lambda: { home: r4(D.lamH), away: r4(D.lamA) },
      prices: {
        moneyline: { home: pct(sheet.moneyline.home), away: pct(sheet.moneyline.away), fair_home: sheet.moneyline.fair_home, fair_away: sheet.moneyline.fair_away, settles: sheet.moneyline.settles },
        regulation: { home: pct(sheet.regulation.home), draw: pct(sheet.regulation.draw), away: pct(sheet.regulation.away), fair_home: sheet.regulation.fair_home, fair_draw: sheet.regulation.fair_draw, fair_away: sheet.regulation.fair_away, settles: sheet.regulation.settles },
        puck_line: {
          home_minus_1_5: pct(sheet.puck_line.home_minus_1_5), away_plus_1_5: pct(sheet.puck_line.away_plus_1_5), away_minus_1_5: pct(sheet.puck_line.away_minus_1_5), home_plus_1_5: pct(sheet.puck_line.home_plus_1_5),
          fair_home_minus_1_5: sheet.puck_line.fair_home_minus_1_5, fair_away_plus_1_5: sheet.puck_line.fair_away_plus_1_5, fair_away_minus_1_5: sheet.puck_line.fair_away_minus_1_5, fair_home_plus_1_5: sheet.puck_line.fair_home_plus_1_5, settles: sheet.puck_line.settles,
        },
        total: { expected: r2(sheet.total.expected), fair_line: sheet.total.fair_line, lines: Object.fromEntries(Object.entries(sheet.total.lines).map(([L, t]) => [L, { over: pct(t.over), under: pct(t.under), push: pct(t.push), fair_over: t.fair_over, fair_under: t.fair_under }])), settles: sheet.total.settles },
        team_total: { home: Object.fromEntries(Object.entries(sheet.team_total.home).map(([L, t]) => [L, { over: pct(t.over), under: pct(t.under), push: pct(t.push), fair_over: t.fair_over, fair_under: t.fair_under }])), away: Object.fromEntries(Object.entries(sheet.team_total.away).map(([L, t]) => [L, { over: pct(t.over), under: pct(t.under), push: pct(t.push), fair_over: t.fair_over, fair_under: t.fair_under }])) },
        p_overtime: pct(sheet.p_overtime), p_shootout: pct(sheet.p_shootout),
      },
      uncertainty: {
        moneyline_sd_pp: r2(sdPP), total_sd_goals: r2(totSd),
        basis: 'spread of the home win probability and expected total across the validated variants (chosen model, goals-only, goalie-aware under each projected goalie pairing). A sensitivity, not a confidence interval.',
        calibration_bin: b ? { range: [b.lo, b.hi], n: b.n, model_mean: b.mean_p, observed: b.observed, wilson95: [b.wilson_low, b.wilson_high], window: 'confirmation 2020-21 to 2025-26' } : null,
      },
      goalies: { certainty: goalieCertainty, home: gH.map((x) => ({ goalie: x.goalie, name: goalieNames[x.goalie] || null, p_start: r4(x.p), confirmed: !!x.confirmed, gsax_rate: r4(rs.goalieRating(x.goalie, day).rate) })), away: gA.map((x) => ({ goalie: x.goalie, name: goalieNames[x.goalie] || null, p_start: r4(x.p), confirmed: !!x.confirmed, gsax_rate: r4(rs.goalieRating(x.goalie, day).rate) })), scenarios: scen, confirmed_source: conf ? { source: conf.source, url: conf.url || null, recorded_at: conf.recorded_at } : null },
      evidence: {
        home: { ev_xg_for_vs_league: r4(fh.ev_off), ev_xg_against_vs_league: r4(fa.ev_def_opp), goals_for_vs_league: r4(fh.g_off), goals_against_vs_league: r4(fa.g_def_opp), pp_vs_league: r4(fh.pp_off), pk_xga_vs_league: r4(fa.pk_def_opp), pp_minutes_vs_league: r4(fh.pp_draw), rest_days: fh.rest, back_to_back: !!fh.b2b, history_weight_games: r2(fh.weight) },
        away: { ev_xg_for_vs_league: r4(fa.ev_off), ev_xg_against_vs_league: r4(fh.ev_def_opp), goals_for_vs_league: r4(fa.g_off), goals_against_vs_league: r4(fh.g_def_opp), pp_vs_league: r4(fa.pp_off), pk_xga_vs_league: r4(fh.pk_def_opp), pp_minutes_vs_league: r4(fa.pp_draw), rest_days: fa.rest, back_to_back: !!fa.b2b, history_weight_games: r2(fa.weight) },
        league: { ev_xg_per60: r2(fh.league_ev_xg60), goals_per_team_game: r2(fh.league_g_pg) },
        notes: [
          'Ratios are to the league\'s running average (1.00 = average); xG ratings are score-adjusted and opponent-adjusted.',
          'Ratings decay with a 180-day half-life and are shrunk toward average by a 32-game prior; early-season ratings lean on last season.',
        ],
      },
      data_quality: {
        history_weight_games: r2(weights), early_season: weights < 40,
        goalie_certainty: goalieCertainty,
        missing: [].concat(gH.length ? [] : ['no starter history for ' + g.home]).concat(gA.length ? [] : ['no starter history for ' + g.away]),
      },
      invalidators: [
        'A starting goalie other than the projected one (see the goalie scenarios for the size of the move).',
        'A late scratch of a top-line forward or top-pair defenceman: skater availability is NOT modelled.',
        'A price posted by a book that settles the market differently (a 60-minute line is not the 2-way moneyline).',
      ].concat(fh.b2b || fa.b2b ? ['A back-to-back: the second-game effect is in the model, but the rested starter decision is not known yet.'] : []),
    });
  }

  const statusOf = (k) => (val.markets && val.markets[k] ? { status: val.markets[k].status, failed: val.markets[k].failed || [], market_status: val.markets[k].market_status } : null);
  const quotes = readJson(path.join(C.PATHS.market, 'quotes.json'), null);
  const quotesByGame = {};
  if (quotes && (quotes.status === 'LIVE' || quotes.status === 'CACHED')) {
    const Q = require('./market/quotes');
    for (const e of quotes.events || []) {
      const ml = (e.books || []).filter((b) => b.h2h);
      if (!ml.length) continue;
      const best = (side) => ml.slice().sort((x, y) => Q.amToDec(y.h2h[side]) - Q.amToDec(x.h2h[side]))[0];
      const nvs = ml.map((b) => Q.noVig(b.h2h.home, b.h2h.away)).filter(Boolean).map((x) => x.a).sort((x, y) => x - y);
      quotesByGame[e.game_id] = { captured_at: quotes.generated_at, ml_best: { home: { book: best('home').book, american: best('home').h2h.home }, away: { book: best('away').book, american: best('away').h2h.away } }, ml_novig_home: nvs.length ? r4(nvs[Math.floor(nvs.length / 2)]) : null, books: ml.length };
    }
  }
  const latestDate = lastCompleted ? lastCompleted.date : null;
  const dataAgeH = lastCompleted ? (now - Date.parse(lastCompleted.known_at)) / 3600e3 : null;
  return {
    schema: C.SCHEMA.slate, sport: 'NHL', sport_key: 'icehockey_nhl', generated_at: new Date(now).toISOString(), horizon_hours: o.hours,
    model: { id: 'edgedesk_nhl_v1:' + chosen, chosen, glm_train_seasons: live.glm_train_seasons, params_generated_at: live.generated_at, validation_generated_at: val.generated_at, pair_calibration: cal[chosen] || null },
    readiness: {
      data: { state: dataAgeH != null && dataAgeH <= 48 ? 'FRESH' : 'STALE', latest_completed_game: latestDate, hours_since_latest_result: r2(dataAgeH), results_lagging: lagging.map((g) => ({ game_id: g.game_id, date: g.date, home: g.home, away: g.away })), schedule: o.scheduleSource, nhl_api: o.api },
      model: { moneyline: statusOf('moneyline'), puck_line: statusOf('puck_line_home_minus_1_5'), total: statusOf('total_over_5_5'), regulation_3way: statusOf('regulation_3way'), team_total: statusOf('team_total') },
      market: quotes && quotes.status === 'LIVE' ? { state: 'CAPTURED', captured_at: quotes.generated_at } : { state: quotes ? quotes.status : 'NOT_CAPTURED', reason: quotes ? quotes.reason : 'NHL prices are not captured: icehockey_nhl is not enabled in the odds gateway (supabase/odds_api_gateway.sql) and the repository variable NHL_PRICES is not on' },
      value_claims: { state: 'DISABLED', reasons: ['the NHL model has not been tested against closing prices (no licensed closing-price archive)'].concat(quotes && quotes.status === 'LIVE' ? [] : ['no verified current NHL prices are captured']) },
    },
    record: { moneyline: val.markets && val.markets.moneyline, comparisons: val.comparisons, leakage: val.leakage, live_games_graded: (val.live_games || []).length },
    quotes_by_game: quotesByGame,
    attribution: 'NHL game data: sportsdataverse fastRhockey (compiled from the NHL\'s public game feeds). ' + C.LICENSE.sportsdataverse,
    games: out,
  };
}

/* ---------- the append-only pregame ledger ---------- */
function ledgerAppend(slate, now) {
  fs.mkdirSync(C.PATHS.ledger, { recursive: true });
  const file = path.join(C.PATHS.ledger, C.CURRENT_SEASON + '.jsonl');
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const last = new Map();
  for (const line of old.split('\n')) { if (!line) continue; const r = JSON.parse(line); last.set(r.game_id, r); }
  let added = 0; let text = old;
  for (const g of slate.games) {
    if (!(Date.parse(g.start_utc) > now)) continue;
    const rec = { schema: C.SCHEMA.ledger, game_id: g.game_id, start_utc: g.start_utc, home: g.home, away: g.away, model: slate.model.id, recorded_at: slate.generated_at,
      p_home: g.prices.moneyline.home, reg: [g.prices.regulation.home, g.prices.regulation.draw, g.prices.regulation.away], pl_home_minus_1_5: g.prices.puck_line.home_minus_1_5,
      exp_total: g.prices.total.expected, over_5_5: g.prices.total.lines['5.5'] ? g.prices.total.lines['5.5'].over : null, over_6_5: g.prices.total.lines['6.5'] ? g.prices.total.lines['6.5'].over : null, goalie_certainty: g.goalies.certainty };
    /* the market at this moment, when prices are captured: the best price per side and the no-vig consensus (for CLV later) */
    const q = slate.quotes_by_game ? slate.quotes_by_game[g.game_id] : null;
    if (q) rec.market = q;
    const prev = last.get(g.game_id);
    const moved = !prev || Math.abs(prev.p_home - rec.p_home) >= 0.01 || Math.abs((prev.exp_total || 0) - (rec.exp_total || 0)) >= 0.1 || prev.model !== rec.model || prev.goalie_certainty !== rec.goalie_certainty
      || JSON.stringify((prev.market || {}).ml_best || null) !== JSON.stringify((rec.market || {}).ml_best || null);
    if (!moved) continue;
    rec.id = crypto.createHash('sha256').update(JSON.stringify(rec)).digest('hex').slice(0, 16);
    text += JSON.stringify(rec) + '\n'; added++;
  }
  if (added) { const tmp = file + '.tmp'; fs.writeFileSync(tmp, text); if (!fs.readFileSync(tmp, 'utf8').startsWith(old)) throw new Error('ledger prefix check failed'); fs.renameSync(tmp, file); }
  return added;
}

function check() {
  const s = readJson(C.PATHS.slate, null); const fails = [];
  if (!s || s.schema !== C.SCHEMA.slate) fails.push('schema');
  else {
    if (s.readiness.value_claims.state !== 'DISABLED' && !(s.record.moneyline && s.record.moneyline.market_status === 'TESTED')) fails.push('value claims enabled without a market test');
    for (const g of s.games) {
      const m = g.prices.moneyline;
      if (!(Math.abs(m.home + m.away - 1) < 1e-3)) fails.push(g.game_id + ' moneyline does not sum to 1');
      const r = g.prices.regulation; if (!(Math.abs(r.home + r.draw + r.away - 1) < 1e-3)) fails.push(g.game_id + ' 3-way does not sum to 1');
      if (!(g.prices.puck_line.home_minus_1_5 < m.home)) fails.push(g.game_id + ' -1.5 is not below the moneyline');
    }
    const file = path.join(C.PATHS.ledger, C.CURRENT_SEASON + '.jsonl');
    if (fs.existsSync(file)) {
      const seen = new Set();
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line) continue; const r = JSON.parse(line); const id = r.id; delete r.id;
        if (crypto.createHash('sha256').update(JSON.stringify(r)).digest('hex').slice(0, 16) !== id) fails.push('ledger record ' + id + ' was edited');
        if (!(Date.parse(r.recorded_at) < Date.parse(r.start_utc))) fails.push('ledger record ' + id + ' recorded at or after the start');
        if (seen.has(id)) fails.push('duplicate ledger record ' + id); seen.add(id);
      }
    }
  }
  if (fails.length) { console.error('[nhl slate --check] FAILED: ' + fails.slice(0, 10).join('; ')); process.exit(1); }
  console.log('[nhl slate --check] ok: ' + s.games.length + ' games, value claims ' + s.readiness.value_claims.state);
}

async function main() {
  if (flag('check')) return check();
  const offline = flag('offline');
  const now = arg('now') ? Date.parse(arg('now')) : Date.now();
  const hours = Number(arg('hours', 72));
  const { games: schedule, source } = await loadSchedule(offline);
  const api = await refreshFromApi(schedule, now, hours, offline);
  const slate = build({ now, hours, schedule, scheduleSource: source, api });
  fs.writeFileSync(C.PATHS.slate, JSON.stringify(slate, null, 1) + '\n');
  const added = flag('no-ledger') ? 0 : ledgerAppend(slate, now);
  console.log('[nhl slate] ' + slate.games.length + ' upcoming games priced; data ' + slate.readiness.data.state + ' (latest result ' + slate.readiness.data.latest_completed_game + '); NHL API ' + (api.used ? 'used' : 'not used (' + (api.reason || (api.error && api.error.code) || 'unreachable') + ')') + '; ledger +' + added + '; value claims ' + slate.readiness.value_claims.state);
}

if (require.main === module) main().catch((e) => { console.error(e.stack || e); process.exit(1); });
module.exports = { build, ledgerAppend };
