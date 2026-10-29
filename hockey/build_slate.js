#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk NHL — the slate: a fair price for every market of every upcoming
   game, with the evidence, the uncertainty and the record behind it.

     node hockey/build_slate.js [--offline] [--hours 120] [--now 2026-10-13T16:00:00Z]
     node hockey/build_slate.js --check

   Reads the committed team-game table, the live parameters
   (hockey/model/params/live.json, fitted only on completed seasons), the
   season schedule (sportsdataverse, refreshed daily) and — when reachable —
   the NHL's own schedule API for today's times and states. Writes
   hockey/slate.json (schema edgedesk_nhl_slate_v1) and appends changed
   pregame sheets to hockey/ledger/<season>.jsonl.

   STARTED GAMES KEEP THEIR RESEARCH. The slate lists upcoming games only, so
   a game leaves it at puck drop. Before the new slate is written, every game
   the previous slate priced that has now started moves, exactly as it was
   priced, to hockey/recent.json (schema edgedesk_nhl_recent_v1) with the
   time it was frozen, and stays there for C.RECENT_HOURS. Nothing in it is
   re-priced after the start; Today's Games links a live or final game to it.

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

   STARTERS BETWEEN BUILDS (docs/engine/NHL_GOALIES.md). The build also writes
   hockey/goalie_inputs.json (schema edgedesk_nhl_goalie_inputs_v1): for every
   upcoming game the goalie-aware variant's linear predictor without its goalie
   term, the goalie coefficient, the pair calibration, each realistic goalie's
   rating at the game date and the usage projection. With it the
   nhl_goalie_sync edge function re-prices any pairing exactly as the goalie
   scenarios here are priced (`--check` proves it for every scenario), and
   versions the game card when a starter is reported, confirmed or changed.
   Nothing in the production price reads it.

   THE SPLIT FACTOR (hockey/model/split_shadow.js). Since 2026-10-29 the
   published 2026-27 price uses the pair recalibration's split factor fitted
   on the moneyline (b = 1.125, from live.json; the goal-split 0.9 is kept
   there as goal_split_b), by the owner's decision. Before that it ran as a
   shadow (calibration_shadow, frozen in hockey/ledger/split_shadow_<season>.jsonl);
   a shadow that is not production still prices there, and this one no longer does.
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
const X = require('./slate_extras');
const EX = require('./model/explain');
const CTX = require('./lab/context');
const GC = require('./goalies/core');
const SH = require('./model/split_shadow');

const GOALIE_INPUTS = path.join(C.HOCKEY, 'goalie_inputs.json');
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

/* THE STARTERS A GAME IS PRICED WITH (the goalie scenarios; the headline price
   has no goalie term). A confirmation replaces one side's projection, and the
   game is CONFIRMED only when BOTH sides are: lib/edgedesk_nhl_market.js opens
   its goalie gate on that word, and a one-sided entry once opened it. A goalie
   the operator file lists as unavailable (hockey/data/confirmed_starters.json
   `unavailable`, by goalie id, with reason, source and time) is never an
   assumed starter: he leaves the projection, the others are renormalised and
   the removal is stated; a confirmation naming him is a CONFLICT, not a
   confirmed start. No NHL injury feed exists, so a projected goalie's
   availability is UNVERIFIED, never assumed. */
function startersFor(conf, projH, projA, unavailable) {
  const out = { gH: null, gA: null, certainty: null, availability: {}, removed: [], conflicts: [] };
  const un = unavailable || {};
  for (const [k, proj] of [['home', projH], ['away', projA]]) {
    const cg = conf && conf[k] != null ? conf[k] : null;
    if (cg != null && un[cg]) {
      out.conflicts.push({ side: k, goalie: cg, reason: un[cg].reason || null, source: un[cg].source || null });
      out.availability[k] = 'CONFLICT';
    } else if (cg != null) { out[k === 'home' ? 'gH' : 'gA'] = [{ goalie: cg, p: 1, confirmed: true }]; out.availability[k] = 'CONFIRMED'; continue; }
    const keep = proj.filter((x) => !un[x.goalie]);
    for (const x of proj) if (un[x.goalie]) out.removed.push({ side: k, goalie: x.goalie, p_start_before: x.p, reason: un[x.goalie].reason || null, source: un[x.goalie].source || null, recorded_at: un[x.goalie].recorded_at || null });
    const s = keep.reduce((a, x) => a + x.p, 0);
    out[k === 'home' ? 'gH' : 'gA'] = s > 0 ? keep.map((x) => ({ goalie: x.goalie, p: x.p / s })) : [];
    if (!out.availability[k]) out.availability[k] = 'UNVERIFIED';
  }
  const gH = out.gH, gA = out.gA;
  out.certainty = out.availability.home === 'CONFIRMED' && out.availability.away === 'CONFIRMED' ? 'CONFIRMED'
    : (gH[0] && gH[0].p >= 0.8 && gA[0] && gA[0].p >= 0.8 && !out.conflicts.length ? 'PROJECTED_LIKELY' : 'PROJECTED_UNCERTAIN');
  return out;
}

/* a goalie's rating at `day` WITHOUT ageing the accumulator (RatingState.goalieRating ages it in place):
   the same arithmetic, so it equals goalieRating(id, day).rate for every day at or after the last game absorbed */
function peekGoalieRate(rs, id, day) {
  if (id == null) return rs.p.goalie_prior_rate;
  const g = rs.goalie.get(id) || rs.goalie.get(Number(id));
  const k = rs.p.goalie_prior_xg;
  if (!g) return rs.p.goalie_prior_rate;
  const f = g.t != null && day > g.t ? Math.pow(0.5, Math.max(0, day - g.t) / rs.p.goalie_half_life_days) : 1;
  const xg = (g.s.xga || 0) * f, ga = (g.s.ga || 0) * f;
  return ((xg - ga) + rs.p.goalie_prior_rate * k) / (xg + k);
}

/* the second source: the NHL data pack's ESPN 2024-25 season, reconciled event by event (hockey/crosscheck/espn.js) */
function secondSource() {
  const x = readJson(path.join(C.PATHS.validation, 'nhl_crosscheck_espn.json'), null);
  if (!x || x.schema !== 'edgedesk_nhl_crosscheck_v2') return null;
  return { season: x.season_label, source: 'ESPN (the NHL data pack, datapack/nhl_v1)', games_matched: x.results.compared, games: x.games.espn_club_games, finals_agree: x.results.final_agree, decided_agree: x.results.decided_agree,
    attempts_matched: x.events.matched, attempts: x.events.espn_attempts, blocked_credited_to_shooter: x.events.blocked.espn_shooter_team_is_shooter_view_team, blocked: x.events.blocked.matched,
    skater_toi_within_5s: x.skaters.player_toi_within_5s, skater_rows: x.skaters.player_rows, file: 'hockey/validation/nhl_crosscheck_espn.json' };
}

function build(o) {
  const live = readJson(path.join(C.HOCKEY, 'model', 'params', 'live.json'), null);
  const val = readJson(path.join(C.PATHS.validation, 'nhl_walkforward.json'), null);
  if (!live || !val) throw new Error('no live parameters or validation record: run hockey/model/walkforward.js');
  const now = o.now;
  const seasons = []; for (let s = C.FIRST_SEASON; s <= C.CURRENT_SEASON; s++) seasons.push(s);
  const { rows, games } = W.loadGames(seasons);
  const P = W.seasonParams(rows, seasons, false);
  /* lineups: this season's and last season's box scores, when the lineup ingest has run */
  const LU = require('./ingest/lineups').loadLineups([C.CURRENT_SEASON - 1, C.CURRENT_SEASON]);
  const luOk = LU.map.size > 0;
  const { state: rs, lineups: ls } = W.ratingsPass(games, P, live.ratings, luOk ? LU.map : null);
  const gLineup = live.glm.xg_lineup_confirmed || null;
  const luCmp = val.comparisons && val.comparisons.xg_lineup_confirmed_vs_xg_no_goalie;
  const luNote = 'The price uses the chosen model (ratings only). The lineup-aware variant is a sensitivity: projected lineups did not clear the selection bar' +
    (luCmp ? '; confirmed lineups changed held-out log loss by ' + luCmp.mean_diff + ' (95% CI ' + luCmp.ci95.join(' to ') + ')' : '') + '.';
  const goalieNames = readJson(C.PATHS.goalies, {});
  const confFile = readJson(path.join(C.HOCKEY, 'data', 'confirmed_starters.json'), { starters: {} }) || {};
  const confirmed = confFile.starters || {}, unavailableGoalies = confFile.unavailable || {};
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

  const chosen = live.model, gfit = live.glm[chosen], gGoalie = live.glm.xg_goalie_confirmed, gGoals = live.glm.goals_only, gAll = live.glm.xg_all_confirmed || null;
  const cal = live.pair_calibration || {};
  const eff = live.effects || DIST.neutralEffects();
  const bins = val.windows && val.windows.confirmation && val.windows.confirmation.by_candidate[chosen] ? val.windows.confirmation.by_candidate[chosen].moneyline.bins : [];
  /* the research layers (hockey/slate_extras.js): statuses, challengers, schedule context, the league-average club */
  const lab = readJson(path.join(C.PATHS.validation, 'nhl_lab.json'), null);
  const labLive = readJson(path.join(C.HOCKEY, 'model', 'params', 'lab_live.json'), null);
  const statuses = X.marketStatuses(val, lab);
  const challengers = labLive && labLive.for_season === C.CURRENT_SEASON ? X.challengerSet(labLive, lab, games) : null;
  const contextOf = X.contextBuilder(games, sched);
  const active = Object.entries(readJson(path.join(C.HOCKEY, 'data', 'teams.json'), { teams: {} }).teams).filter(([, t]) => !t.inactive_since).map(([k]) => k);
  const neutralByDay = new Map();
  const neutralFor = (day) => { if (!neutralByDay.has(day)) neutralByDay.set(day, EX.leagueNeutral(active.map((t) => rs.teamRatings(t, day)))); return neutralByDay.get(day); };
  const quotesRaw = readJson(path.join(C.PATHS.market, 'quotes.json'), null);
  const quotesLive = quotesRaw && (quotesRaw.status === 'LIVE' || quotesRaw.status === 'CACHED') ? quotesRaw : null;
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
    /* schedule context and results form (measured; not in the production price — hockey/lab/run.js) */
    const cxH = contextOf(g.home, g.home, g.date), cxA = contextOf(g.away, g.home, g.date);
    Object.assign(fh, CTX.pairFeatures(cxH, cxA), { playoff: g.game_type === 'P' ? 1 : 0 });
    Object.assign(fa, CTX.pairFeatures(cxA, cxH), { playoff: g.game_type === 'P' ? 1 : 0 });
    const ot = g.game_type === 'P' ? { format: 'PO' } : live.ot;
    const price = (model, calib, sh, sa) => {
      const raw = { lh: GLM.predict(model, sh), la: GLM.predict(model, sa) };
      const c = GLM.applyPairCalibration(raw.lh, raw.la, calib);
      return DIST.game({ lamH: c.lh, lamA: c.la, effects: eff, ot, periods: true });
    };
    const D = price(gfit, cal[chosen], fh, fa);
    const sheet = DIST.sheet(D);
    /* the pre-registered split-factor shadow: production's raw λ under the shadow's recalibration, never the price */
    const Dsh = SH.active(C.CURRENT_SEASON) ? price(gfit, SH.shadowCal(cal[chosen]), fh, fa) : null;
    /* goalie scenarios from the goalie-aware variant */
    const projH = rs.projectStarters(g.home, day).slice(0, 2), projA = rs.projectStarters(g.away, day).slice(0, 2);
    const conf = confirmed[String(g.game_id)] || null;
    const scen = [];
    const st = startersFor(conf, projH, projA, unavailableGoalies);
    const gH = st.gH, gA = st.gA;
    const sumH = gH.reduce((a, x) => a + x.p, 0) || 1, sumA = gA.reduce((a, x) => a + x.p, 0) || 1;
    for (const h of gH.length ? gH : [{ goalie: null, p: 1 }]) for (const a of gA.length ? gA : [{ goalie: null, p: 1 }]) {
      const sh = Object.assign({}, fh, { opp_goalie_act: rs.goalieRating(a.goalie, day).rate });
      const sa = Object.assign({}, fa, { opp_goalie_act: rs.goalieRating(h.goalie, day).rate });
      const Dg = price(gGoalie, cal.xg_goalie_confirmed, sh, sa);
      /* the pairing's puck lines and totals, so the edge gate can ask every pairing (hockey/goalies/core.js nhlgEdgeGate) */
      const mk = GC.nhlgMarkets(Dg, DIST);
      scen.push({ home_goalie: h.goalie, home_goalie_name: goalieNames[h.goalie] || null, away_goalie: a.goalie, away_goalie_name: goalieNames[a.goalie] || null, p_scenario: r4((h.p / sumH) * (a.p / sumA)), p_home: r4(Dg.p_home), exp_total: r2(DIST.expectedTotal(Dg)), lambda: { home: r4(Dg.lamH), away: r4(Dg.lamA) },
        fair_home: mk.fair_home, fair_away: mk.fair_away, fair_total_line: mk.fair_total_line, puck_line: mk.puck_line, total: mk.total });
    }
    /* the goalie inputs (hockey/goalie_inputs.json): the goalie-aware variant without its goalie term, and every realistic goalie's rating at this date */
    if (o.collect) {
      const eta = (f) => Math.log(GLM.predict(gGoalie, Object.assign({}, f, { opp_goalie_act: 0, opp_goalie_proj: 0 })));
      const projAll = (team) => rs.projectStarters(team, day).map((x) => ({ goalie_id: String(x.goalie), goalie_name: goalieNames[x.goalie] || null, p: r4(x.p) }));
      const pool = new Set();
      for (const t of [g.home, g.away]) { for (const id of rs.starts.get(t) || []) pool.add(String(id)); for (const x of rs.projectStarters(t, day)) pool.add(String(x.goalie)); }
      const confG = confirmed[String(g.game_id)] || null;
      if (confG) for (const k of ['home', 'away']) if (confG[k] != null) pool.add(String(confG[k]));
      const rates = {};
      for (const id of pool) rates[id] = peekGoalieRate(rs, Number(id), day);
      /* the lineup-lock inputs (hockey/goalies/core.js nhlgLockPrice): the variant that knows tonight's lineups and goalies, with
         its goalie and lineup terms at zero, and each club's typical lineup value. `check` prices each club's previous lineup with the
         likeliest starters through this file's own GLM path, so --check proves the sync's arithmetic reproduces it */
      let lineup = null;
      const sH = luOk ? ls.snapshot(g.home, null) : null, sA = luOk ? ls.snapshot(g.away, null) : null;
      if (gAll && sH && sA && sH.known && sA.known) {
        const zero = { opp_goalie_act: 0, opp_goalie_proj: 0, lu_own_conf: 0, lu_opp_conf: 0 };
        const etaAll = (f) => Math.log(GLM.predict(gAll, Object.assign({}, f, zero)));
        const lastIds = (team) => { const h = ls.hist(team); return h && h.length ? h[h.length - 1].map(String) : []; };
        const gh = projH[0] ? projH[0].goalie : null, ga = projA[0] ? projA[0].goalie : null;
        const rH = rs.goalieRating(gh, day).rate, rA = rs.goalieRating(ga, day).rate;
        const Dchk = price(gAll, cal.xg_all_confirmed, Object.assign({}, fh, zero, { opp_goalie_act: rA, lu_own_conf: sH.proj, lu_opp_conf: sA.proj }), Object.assign({}, fa, zero, { opp_goalie_act: rH, lu_own_conf: sA.proj, lu_opp_conf: sH.proj }));
        lineup = { eta: { home: etaAll(fh), away: etaAll(fa) }, typical: { home: sH.typical, away: sA.typical }, last: { home: lastIds(g.home), away: lastIds(g.away) },
          check: { home_goalie_id: gh != null ? String(gh) : null, away_goalie_id: ga != null ? String(ga) : null, p_home: r4(Dchk.p_home), basis: 'each club\'s previous lineup and the likeliest starters, priced by build_slate.js' } };
      }
      o.collect.games.push({ game_id: g.game_id, date: g.date, start_utc: g.start_utc, type: g.game_type, home: g.home, away: g.away, state: g.state || null,
        eta: { home: eta(fh), away: eta(fa) }, rates, lineup,
        projection: { home: projAll(g.home), away: projAll(g.away) },
        confirmed: confG ? { home: confG.home != null ? { goalie_id: String(confG.home), goalie_name: goalieNames[confG.home] || null } : null, away: confG.away != null ? { goalie_id: String(confG.away), goalie_name: goalieNames[confG.away] || null } : null, source: confG.source || null, url: confG.url || null, recorded_at: confG.recorded_at || null } : null });
    }
    const Dgoals = price(gGoals, cal.goals_only, fh, fa);
    /* lineups: the previous game's dressed skaters against each club's typical lineup (projected; confirmed only at warmups) */
    const luH = luOk ? ls.snapshot(g.home, null) : { known: false }, luA = luOk ? ls.snapshot(g.away, null) : { known: false };
    const missing = (team) => (luOk ? ls.missingRegulars(team, null, 900).slice(0, 5).map((m) => ({ player_id: m.player_id, name: LU.names[m.player_id] || null, toi_per_game: Math.floor(m.toi_per_game_s / 60) + ':' + String(m.toi_per_game_s % 60).padStart(2, '0'), dressed_in_last_10: m.dressed_in_window, absent_last_games: m.absent_last_games, reading: m.absent_last_games >= 5 ? 'a long absence: injury or no longer on the roster (no feed says which)' : 'absent from the most recent game(s)' })) : []);
    let Dlu = null;
    if (luH.known && luA.known) { Object.assign(fh, W.lineupFeatures(luH, luA)); Object.assign(fa, W.lineupFeatures(luA, luH)); }
    if (gLineup && luH.known && luA.known) {
      const sh = Object.assign({}, fh, W.lineupFeatures(luH, luA)), sa = Object.assign({}, fa, W.lineupFeatures(luA, luH));
      Dlu = price(gLineup, cal.xg_lineup_confirmed, sh, sa);
    }
    const lineupState = luH.known && luA.known ? 'PROJECTED_FROM_LAST_GAME' : 'UNKNOWN';
    const variants = [D.p_home, Dgoals.p_home].concat(scen.map((x) => x.p_home)).concat(Dlu ? [Dlu.p_home] : []);
    const mean = variants.reduce((a, v) => a + v, 0) / variants.length;
    const sdPP = Math.sqrt(variants.reduce((a, v) => a + (v - mean) * (v - mean), 0) / variants.length) * 100;
    const totals = [DIST.expectedTotal(D), DIST.expectedTotal(Dgoals)].concat(scen.map((x) => x.exp_total));
    const tm = totals.reduce((a, v) => a + v, 0) / totals.length;
    const totSd = Math.sqrt(totals.reduce((a, v) => a + (v - tm) * (v - tm), 0) / totals.length);
    const b = bin(bins, D.p_home);
    const pct = (v) => r4(v);
    const goalieCertainty = st.certainty;
    const weights = Math.min(fh.weight || 0, fa.weight || 0);
    out.push({
      game_id: g.game_id, event_key: 'NHL|' + g.game_id, date: g.date, start_utc: g.start_utc, type: g.game_type, home: g.home, away: g.away, venue: g.venue || null, state: g.state || null, schedule_source: g.source,
      lambda: { home: r4(D.lamH), away: r4(D.lamA) },
      explanation: (() => { const e = EX.explainGame({ model: gfit, cal: cal[chosen], effects: eff, ot, fh, fa, home: g.home, away: g.away, neutral: neutralFor(day) }); e.narrative = EX.narrative(e, g); return e; })(),
      markets: X.fullMarkets(D, statuses),
      repricing: { base: { home: r4(D.lamH), away: r4(D.lamA) }, lineup_variant: Dlu ? { home: r4(Dlu.lamH), away: r4(Dlu.lamA) } : null, ot: g.game_type === 'P' ? 'playoff' : 'regular', basis: 'the expected regulation goals of each variant; the page re-prices every market from them with hockey/model/distribution.js and the slate\'s distribution block' },
      challengers: challengers ? challengers({ fh, fa, price, season: C.CURRENT_SEASON, home: g.home, away: g.away, production_p: D.p_home }) : null,
      context: {
        home: { travel_km: cxH.travel_km, tz_shift: cxH.tz_shift, games_in_prior_3_days: cxH.games_3d, road_trip_game: cxH.road_len, recent_5v5_xg_for_vs_last_40: r4(Math.exp(cxH.form_off)), recent_5v5_xg_against_vs_last_40: r4(Math.exp(cxH.form_def)), goals_vs_xg_last_20: r4(Math.exp(cxH.luck_fin)), goals_against_vs_xg_last_20: r4(Math.exp(cxH.luck_sv)) },
        away: { travel_km: cxA.travel_km, tz_shift: cxA.tz_shift, games_in_prior_3_days: cxA.games_3d, road_trip_game: cxA.road_len, recent_5v5_xg_for_vs_last_40: r4(Math.exp(cxA.form_off)), recent_5v5_xg_against_vs_last_40: r4(Math.exp(cxA.form_def)), goals_vs_xg_last_20: r4(Math.exp(cxA.luck_fin)), goals_against_vs_xg_last_20: r4(Math.exp(cxA.luck_sv)) },
        note: 'Measured, not in the price: travel, time zones, congestion, road trips, recent form and finishing luck were each tested out of sample (hockey/validation/nhl_lab.json) and none cleared the bar.',
      },
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
      calibration_shadow: Dsh ? { protocol: SH.PROTOCOL.id, status: 'SHADOW', b: SH.PROTOCOL.b, production_b: cal[chosen] ? cal[chosen].b : null,
        p_home: pct(Dsh.p_home), p_away: pct(Dsh.p_away), fair_home: am(Dsh.p_home), fair_away: am(Dsh.p_away), pl_home_minus_1_5: pct(DIST.spread(Dsh, -1.5).win), lambda: { home: r4(Dsh.lamH), away: r4(Dsh.lamA) },
        note: 'Not the price. A pre-registered challenger: the split factor fitted on the moneyline instead of on goals (hockey/model/split_shadow.js). It is graded beside production on unseen games and changes nothing unless its rule is met and a person promotes it.' } : null,
      uncertainty: {
        moneyline_sd_pp: r2(sdPP), total_sd_goals: r2(totSd),
        basis: 'spread of the home win probability and expected total across the validated variants (chosen model, goals-only, goalie-aware under each projected goalie pairing, lineup-aware with each club\'s last lineup). A sensitivity, not a confidence interval.',
        calibration_bin: b ? { range: [b.lo, b.hi], n: b.n, model_mean: b.mean_p, observed: b.observed, wilson95: [b.wilson_low, b.wilson_high], window: 'confirmation 2020-21 to 2025-26' } : null,
      },
      goalies: { certainty: goalieCertainty, home: gH.map((x) => ({ goalie: x.goalie, name: goalieNames[x.goalie] || null, p_start: r4(x.p), confirmed: !!x.confirmed, gsax_rate: r4(rs.goalieRating(x.goalie, day).rate) })), away: gA.map((x) => ({ goalie: x.goalie, name: goalieNames[x.goalie] || null, p_start: r4(x.p), confirmed: !!x.confirmed, gsax_rate: r4(rs.goalieRating(x.goalie, day).rate) })), scenarios: scen, confirmed_source: conf ? { source: conf.source, url: conf.url || null, recorded_at: conf.recorded_at } : null,
        availability: st.availability, availability_basis: 'CONFIRMED: a recorded starter (hockey/data/confirmed_starters.json); UNVERIFIED: a usage projection, and no NHL injury or roster feed exists to say the goalie is available; CONFLICT: a confirmation names a goalie listed unavailable',
        removed_unavailable: st.removed.map((x) => Object.assign({}, x, { name: goalieNames[x.goalie] || null })), conflicts: st.conflicts.map((x) => Object.assign({}, x, { name: goalieNames[x.goalie] || null })) },
      lineups: {
        state: lineupState,
        basis: 'each club\'s previous game\'s dressed skaters against its typical lineup (box scores; hockey/model/lineups.js). Confirmed lineups are known only at warmups, and no pregame lineup feed is wired.',
        home: { projected_delta: luH.known ? r4(luH.proj) : null, regulars_absent: missing(g.home) },
        away: { projected_delta: luA.known ? r4(luA.proj) : null, regulars_absent: missing(g.away) },
        p_home_lineup_variant: Dlu ? r4(Dlu.p_home) : null,
        note: luNote,
      },
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
        warnings: [].concat(['home', 'away'].filter((k) => st.availability[k] === 'UNVERIFIED').map((k) => 'starting goalie unconfirmed for ' + g[k] + ': a usage projection, availability unverified (no injury feed)'))
          .concat(st.removed.map((x) => (goalieNames[x.goalie] || x.goalie) + ' (' + g[x.side] + ') listed unavailable' + (x.reason ? ' (' + x.reason + ')' : '') + ': removed from the projection'))
          .concat(st.conflicts.map((x) => 'a confirmation names ' + (goalieNames[x.goalie] || x.goalie) + ' (' + g[x.side] + '), who is listed unavailable' + (x.reason ? ' (' + x.reason + ')' : '') + ': not priced as confirmed')),
      },
      invalidators: [
        'A starting goalie other than the projected one (see the goalie scenarios for the size of the move).',
        'A late scratch or return of a regular: lineups are measured but not in this price (no pregame lineup feed); the lineup block lists regulars absent from each club\'s last game and for how long.',
        'A price posted by a book that settles the market differently (a 60-minute line is not the 2-way moneyline).',
      ].concat(fh.b2b || fa.b2b ? ['A back-to-back: the second-game effect is in the model, but the rested starter decision is not known yet.'] : []),
    });
  }

  if (o.collect) {
    o.collect.rs = rs; o.collect.goalieNames = goalieNames; o.collect.gGoalie = gGoalie; o.collect.cal = cal.xg_goalie_confirmed || null; o.collect.effects = eff; o.collect.ot = live.ot;
    o.collect.gAll = gAll; o.collect.calAll = cal.xg_all_confirmed || null; o.collect.ls = luOk ? ls : null;
    o.collect.prior_rate = rs.p.goalie_prior_rate; o.collect.ratings = live.ratings; o.collect.firstDay = out.length ? dayNum(out[0].date) : dayNum(new Date(now).toISOString().slice(0, 10));
  }
  /* each captured price against the model (lib/edgedesk_nhl_market.js) */
  const dataStateNow = lastCompleted && (now - Date.parse(lastCompleted.available_at)) / 3600e3 <= 48 ? 'FRESH' : 'STALE';
  for (const gm of out) {
    const ev = quotesLive ? (quotesLive.events || []).find((e) => e.game_id === gm.game_id) : null;
    gm.market_check = quotesLive ? X.marketChecks(gm, ev, statuses, { now, data_state: dataStateNow, captured_at: quotesLive.generated_at }) : { state: 'NOT_CAPTURED', checks: [], reason: (quotesRaw && quotesRaw.reason) || 'NHL prices are not captured' };
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
  const dataAgeH = lastCompleted ? (now - Date.parse(lastCompleted.available_at)) / 3600e3 : null; /* games carry the row's assumed_available_at as available_at (walkforward.loadGames) */
  return {
    schema: C.SCHEMA.slate, sport: 'NHL', sport_key: 'icehockey_nhl', generated_at: new Date(now).toISOString(), horizon_hours: o.hours,
    model: { id: 'edgedesk_nhl_v1:' + chosen, chosen, glm_train_seasons: live.glm_train_seasons, params_generated_at: live.generated_at, validation_generated_at: val.generated_at, pair_calibration: cal[chosen] || null },
    readiness: {
      data: { state: dataAgeH != null && dataAgeH <= 48 ? 'FRESH' : 'STALE', latest_completed_game: latestDate, hours_since_latest_result: r2(dataAgeH), results_lagging: lagging.map((g) => ({ game_id: g.game_id, date: g.date, home: g.home, away: g.away })), schedule: o.scheduleSource, nhl_api: o.api },
      model: { moneyline: statusOf('moneyline'), puck_line: statusOf('puck_line_home_minus_1_5'), total: statusOf('total_over_5_5'),
        regulation_3way: statuses.regulation_3way ? { status: statuses.regulation_3way.status, failed: statuses.regulation_3way.failed, market_status: 'NOT_TESTED' } : statusOf('regulation_3way'),
        team_total: ['team_total:home:2.5', 'team_total:away:2.5'].every((k) => statuses[k]) ? { status: ['team_total:home:2.5', 'team_total:away:2.5'].every((k) => statuses[k].status === 'OUTCOME_VALIDATED') ? 'OUTCOME_VALIDATED' : 'PROVISIONAL', failed: [].concat(statuses['team_total:home:2.5'].failed, statuses['team_total:away:2.5'].failed), market_status: 'NOT_TESTED', basis: 'hockey/validation/nhl_lab.json markets_extended' } : statusOf('team_total'),
        first_period: statuses.first_period_3way ? { status: statuses.first_period_3way.status, failed: statuses.first_period_3way.failed, market_status: 'NOT_TESTED' } : null },
      market: quotes && quotes.status === 'LIVE' ? { state: 'CAPTURED', captured_at: quotes.generated_at } : { state: quotes ? quotes.status : 'NOT_CAPTURED', reason: quotes ? quotes.reason : 'NHL prices are not captured: icehockey_nhl is not enabled in the odds gateway (supabase/odds_api_gateway.sql) and the repository variable NHL_PRICES is not on' },
      value_claims: { state: 'DISABLED', reasons: ['the NHL model has not been tested against closing prices (no licensed closing-price archive)'].concat(quotes && quotes.status === 'LIVE' ? [] : ['no verified current NHL prices are captured']) },
    },
    record: { moneyline: val.markets && val.markets.moneyline, comparisons: val.comparisons, leakage: val.leakage, live_games_graded: (val.live_games || []).length, second_source: secondSource() },
    quotes_by_game: quotesByGame,
    market_statuses: statuses,
    challenger_records: X.challengerRecords(lab),
    distribution: { effects: eff, ot: live.ot, ot_playoff: { format: 'PO' }, code: 'hockey/model/distribution.js (EDNHLDist), the same code that priced this file' },
    lab: lab ? { decision: lab.promotion, period_profile: lab.period_profile ? lab.period_profile.verdict : null, shape: lab.shape ? lab.shape.verdict : null,
      ablation: (lab.ablation ? [].concat(lab.ablation.dropblock || [], lab.ablation.add || []) : []).map((a) => ({ feature: a.feature, selection_delta: a.selection_ml_delta, confirmation_delta: a.confirmation_ml_delta, verdict: a.verdict })), generated_at: lab.generated_at } : null,
    attribution: 'NHL game data: sportsdataverse fastRhockey (compiled from the NHL\'s public game feeds). ' + C.LICENSE.sportsdataverse,
    games: out,
  };
}

/* ---------- started games: the research frozen before puck drop ---------- */
/**
 * The next hockey/recent.json: every game the previous slate priced that has
 * started by `now`, as it was priced (frozen_at = that slate's build time,
 * always before the start), plus the previous file's games still inside
 * C.RECENT_HOURS. A game back on the new slate (a postponement) is dropped;
 * for a game held twice the later pregame freeze wins.
 */
function carryRecent(prevSlate, prevRecent, nextSlate, now, hours) {
  const win = (hours || C.RECENT_HOURS) * 3600e3;
  const upcoming = new Set(((nextSlate && nextSlate.games) || []).map((g) => String(g.game_id)));
  const keep = new Map();
  const add = (g, frozenAt, modelId) => {
    const t = Date.parse(g && g.start_utc), f = Date.parse(frozenAt);
    if (!isFinite(t) || !isFinite(f) || t > now || now - t > win || !(f < t) || upcoming.has(String(g.game_id))) return;
    const prev = keep.get(String(g.game_id));
    if (prev && Date.parse(prev.frozen_at) >= f) return;
    keep.set(String(g.game_id), Object.assign({}, g, { frozen_at: new Date(f).toISOString(), model_id: g.model_id || modelId || null }));
  };
  if (prevRecent && prevRecent.schema === C.SCHEMA.recent) (prevRecent.games || []).forEach((g) => add(g, g.frozen_at, g.model_id));
  if (prevSlate && prevSlate.schema === C.SCHEMA.slate) (prevSlate.games || []).forEach((g) => add(g, prevSlate.generated_at, prevSlate.model && prevSlate.model.id));
  const games = Array.from(keep.values()).sort((a, b) => Date.parse(a.start_utc) - Date.parse(b.start_utc) || a.game_id - b.game_id);
  return {
    schema: C.SCHEMA.recent, sport: 'NHL', generated_at: new Date(now).toISOString(), window_hours: hours || C.RECENT_HOURS,
    note: 'Games that have started, each exactly as the slate priced it before puck drop (frozen_at). Nothing here is re-priced after the start. Research, not picks.',
    attribution: (nextSlate && nextSlate.attribution) || (prevSlate && prevSlate.attribution) || null,
    games,
  };
}
/** Write hockey/recent.json only when its games changed (a build with nothing new adds no commit noise). */
function writeRecent(rec) {
  const old = readJson(C.PATHS.recent, null);
  const same = old && old.schema === rec.schema && JSON.stringify(old.games) === JSON.stringify(rec.games);
  if (!same) fs.writeFileSync(C.PATHS.recent, JSON.stringify(rec) + '\n');
  return !same;
}

/* ---------- the goalie inputs: what nhl_goalie_sync needs to price any pairing ---------- */
/**
 * hockey/goalie_inputs.json (edgedesk_nhl_goalie_inputs_v1), from the slate
 * just built and what build() collected. Per game: the goalie-aware
 * variant's log expected goals with its goalie term at zero (eta), the
 * rating of every goalie who could start (each club's last 30 starters and
 * the projection) at the game date, the usage projection, a manual
 * confirmation if one is on file, the production headline (copied, so the
 * card can show it unchanged) and the captured market when prices flow.
 * The league-wide pool rates every goalie with recent work at the first
 * game date, for a starter the club's history does not show yet.
 */
function goalieInputsFile(slate, collect) {
  const rs = collect.rs, names = collect.goalieNames || {}, gG = collect.gGoalie;
  const gA = collect.gAll && collect.calAll && collect.ls ? collect.gAll : null;
  const beta = (m, k) => m.beta[1 + m.names.indexOf(k)];
  /* every skater's value for the lineup lock: recent time on ice per game, shrunk toward the depth-player prior (hockey/model/lineups.js) */
  const skaterValues = {};
  if (gA) for (const id of collect.ls.player.keys()) skaterValues[String(id)] = r2(collect.ls.value(id));
  const teamsOf = {};
  for (const [team, ids] of rs.starts) for (const id of ids || []) { const k = String(id); (teamsOf[k] = teamsOf[k] || []).indexOf(team) < 0 && teamsOf[k].push(team); }
  const pool = {};
  for (const [id, acc] of rs.goalie) {
    const k = String(id), recent = (acc.s.xga || 0) * (acc.t != null && collect.firstDay > acc.t ? Math.pow(0.5, (collect.firstDay - acc.t) / rs.p.goalie_half_life_days) : 1);
    if (!(recent >= 1) && !teamsOf[k]) continue;
    pool[k] = { name: names[id] || names[k] || null, rate: GC.nhlgR(peekGoalieRate(rs, id, collect.firstDay), 7), xg_weight: r2(recent), teams: (teamsOf[k] || []).slice().sort() };
  }
  const byId = new Map(slate.games.map((g) => [g.game_id, g]));
  const games = collect.games.map((c) => {
    const g = byId.get(c.game_id), P = g.prices;
    return Object.assign({}, c, {
      game_id: String(c.game_id),
      rates: Object.fromEntries(Object.entries(c.rates).map(([k, v]) => [k, GC.nhlgR(v, 7)])),
      headline: { model_id: slate.model.id, p_home: P.moneyline.home, p_away: P.moneyline.away, fair_home: P.moneyline.fair_home, fair_away: P.moneyline.fair_away,
        exp_total: P.total.expected, fair_total_line: P.total.fair_line, puck_line: { home_minus_1_5: P.puck_line.home_minus_1_5, away_minus_1_5: P.puck_line.away_minus_1_5, fair_home_minus_1_5: P.puck_line.fair_home_minus_1_5, fair_away_minus_1_5: P.puck_line.fair_away_minus_1_5 },
        settles: P.moneyline.settles, goalie_free: true },
      slate_goalies: { certainty: g.goalies.certainty, scenarios: g.goalies.scenarios.map((x) => ({ home_goalie: String(x.home_goalie), away_goalie: String(x.away_goalie), p_home: x.p_home, exp_total: x.exp_total, lambda: x.lambda })) },
      quote: slate.quotes_by_game && slate.quotes_by_game[c.game_id] ? slate.quotes_by_game[c.game_id] : null,
    });
  });
  return {
    schema: 'edgedesk_nhl_goalie_inputs_v1', generated_at: slate.generated_at, slate_generated_at: slate.generated_at,
    model: { id: slate.model.id, chosen: slate.model.chosen, params_generated_at: slate.model.params_generated_at, goalie_variant: 'xg_goalie_confirmed',
      goalie_feature: 'goalie_conf', goalie_beta: gG.beta[1 + gG.names.indexOf('goalie_conf')], pair_calibration: collect.cal,
      basis: 'eta = log expected regulation goals of the goalie-aware variant with its goalie term at zero; a pairing prices as exp(eta + goalie_beta × the opposing goalie\'s rating), pair-calibrated, through hockey/model/distribution.js',
      /* the lineup-lock variant (hockey/goalies/core.js nhlgLockPrice): known only when the box scores are cached */
      all_variant: gA ? 'xg_all_confirmed' : null, all_model_id: gA ? 'edgedesk_nhl_v1:xg_all_confirmed' : null,
      all_beta: gA ? { goalie: beta(gA, 'goalie_conf'), lu_own: beta(gA, 'lu_own_conf'), lu_opp: beta(gA, 'lu_opp_conf') } : null, all_pair_calibration: gA ? collect.calAll : null,
      all_basis: 'at lineup lock: exp(lineup.eta + all_beta.goalie × the opposing goalie\'s rating + all_beta.lu_own × ln(own lineup value / own typical) + all_beta.lu_opp × the same for the opponent), pair-calibrated; a lineup value is the sum of skater_values over the dressed skaters (hockey/model/lineups.js)' },
    distribution: { effects: collect.effects, ot: collect.ot, ot_playoff: { format: 'PO' } },
    ratings: { goalie_prior_rate: collect.prior_rate, goalie_prior_xg: collect.ratings && collect.ratings.goalie_prior_xg, goalie_half_life_days: collect.ratings && collect.ratings.goalie_half_life_days,
      basis: 'hockey/model/ratings.js goalieRating: goals saved above expected per xG faced, decayed with the half-life and shrunk toward the replacement-level prior (the v1 rating; unchanged)' },
    goalie_prior_rate: collect.prior_rate,
    goalies: pool,
    skater_prior_s: gA ? collect.ls.p.prior_toi_s : null,
    skater_values: gA ? skaterValues : null,
    games,
    attribution: slate.attribution,
  };
}
/** the inputs re-price every goalie scenario on the slate exactly (the same λ and the same probability to four decimals) */
function checkGoalieInputs(slate, gin) {
  const fails = [];
  if (!gin || gin.schema !== 'edgedesk_nhl_goalie_inputs_v1') return ['goalie_inputs.json is not edgedesk_nhl_goalie_inputs_v1'];
  if (gin.slate_generated_at !== slate.generated_at) fails.push('goalie_inputs.json was built with another slate (' + gin.slate_generated_at + ' vs ' + slate.generated_at + ')');
  const byId = new Map(gin.games.map((g) => [String(g.game_id), g]));
  for (const g of slate.games) {
    const gi = byId.get(String(g.game_id));
    if (!gi) { fails.push(g.game_id + ' has no goalie inputs'); continue; }
    if (gi.headline.p_home !== g.prices.moneyline.home) fails.push(g.game_id + ' headline is not the slate\'s');
    for (const x of g.goalies.scenarios) {
      const pr = GC.nhlgPrice(gi, gin, x.home_goalie == null ? null : String(x.home_goalie), x.away_goalie == null ? null : String(x.away_goalie), DIST);
      if (Math.abs(pr.p_home - x.p_home) > 1.5e-4 || Math.abs(pr.lambda.home - x.lambda.home) > 1.5e-4 || Math.abs(pr.lambda.away - x.lambda.away) > 1.5e-4) fails.push(g.game_id + ' pairing ' + x.home_goalie + '/' + x.away_goalie + ' re-prices to ' + pr.p_home + ', not ' + x.p_home);
    }
    /* the lineup lock: each club's previous lineup with the likeliest starters re-prices to the slate's own GLM path */
    const L = gi.lineup;
    if (L && L.check && gin.model && gin.model.all_beta) {
      const both = { home: { status: 'confirmed', goalie_id: L.check.home_goalie_id, goalie_name: 'check' }, away: { status: 'confirmed', goalie_id: L.check.away_goalie_id, goalie_name: 'check' } };
      const lk = GC.nhlgLockPrice(gi, gin, both, L.last, DIST);
      if (!lk) fails.push(g.game_id + ' lineup-lock inputs do not price (' + (L.last.home.length + '/' + L.last.away.length) + ' skaters)');
      else if (Math.abs(lk.p_home - L.check.p_home) > 1.5e-4) fails.push(g.game_id + ' lineup lock re-prices to ' + lk.p_home + ', not ' + L.check.p_home);
    }
  }
  return fails;
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
      exp_total: g.prices.total.expected, over_5_5: g.prices.total.lines['5.5'] ? g.prices.total.lines['5.5'].over : null, over_6_5: g.prices.total.lines['6.5'] ? g.prices.total.lines['6.5'].over : null, goalie_certainty: g.goalies.certainty,
      /* the pairing this sheet led with (confirmed, or the likeliest projected): a later grade or CLV row reads the sheet that existed, not the latest */
      goalie_pairing: { home: g.goalies.home[0] ? String(g.goalies.home[0].goalie) : null, away: g.goalies.away[0] ? String(g.goalies.away[0].goalie) : null } };
    /* the market at this moment, when prices are captured: the best price per side and the no-vig consensus (for CLV later) */
    const q = slate.quotes_by_game ? slate.quotes_by_game[g.game_id] : null;
    if (q) rec.market = q;
    const prev = last.get(g.game_id);
    const moved = !prev || Math.abs(prev.p_home - rec.p_home) >= 0.01 || Math.abs((prev.exp_total || 0) - (rec.exp_total || 0)) >= 0.1 || prev.model !== rec.model || prev.goalie_certainty !== rec.goalie_certainty
      || (prev.goalie_pairing && JSON.stringify(prev.goalie_pairing) !== JSON.stringify(rec.goalie_pairing))
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
      const sh = g.calibration_shadow;
      if (sh && (sh.status !== 'SHADOW' || sh.b !== SH.PROTOCOL.b || !(Math.abs(sh.p_home + sh.p_away - 1) < 1e-3))) fails.push(g.game_id + ' calibration_shadow is not the registered shadow');
    }
    /* started games: research frozen strictly before the start, never re-priced */
    const rec = readJson(C.PATHS.recent, null);
    if (rec) {
      if (rec.schema !== C.SCHEMA.recent || !Array.isArray(rec.games)) fails.push('recent.json is not ' + C.SCHEMA.recent);
      else rec.games.forEach((g) => { if (!(Date.parse(g.frozen_at) < Date.parse(g.start_utc))) fails.push('recent ' + g.game_id + ' frozen at or after its start'); });
    }
    /* the goalie inputs re-price every goalie scenario exactly (nhl_goalie_sync prices with them) */
    const gin = readJson(GOALIE_INPUTS, null);
    if (gin) fails.push(...checkGoalieInputs(s, gin));
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
    fails.push(...SH.checkLedger());
  }
  if (fails.length) { console.error('[nhl slate --check] FAILED: ' + fails.slice(0, 10).join('; ')); process.exit(1); }
  console.log('[nhl slate --check] ok: ' + s.games.length + ' games, value claims ' + s.readiness.value_claims.state);
}

async function main() {
  if (flag('check')) return check();
  const offline = flag('offline');
  const now = arg('now') ? Date.parse(arg('now')) : Date.now();
  const hours = Number(arg('hours', C.SLATE_HORIZON_HOURS)); /* every day Today's Games lists (hockey/config.js) */
  const { games: schedule, source } = await loadSchedule(offline);
  const api = await refreshFromApi(schedule, now, hours, offline);
  const collect = { games: [] };
  const slate = build({ now, hours, schedule, scheduleSource: source, api, collect });
  const recent = carryRecent(readJson(C.PATHS.slate, null), readJson(C.PATHS.recent, null), slate, now);
  fs.writeFileSync(C.PATHS.slate, JSON.stringify(slate, null, 1) + '\n');
  writeRecent(recent);
  fs.writeFileSync(GOALIE_INPUTS, JSON.stringify(goalieInputsFile(slate, collect)) + '\n');
  const added = flag('no-ledger') ? 0 : ledgerAppend(slate, now);
  const addedShadow = flag('no-ledger') ? 0 : SH.ledgerAppend(slate, now);
  console.log('[nhl slate] ' + slate.games.length + ' upcoming games priced; data ' + slate.readiness.data.state + ' (latest result ' + slate.readiness.data.latest_completed_game + '); NHL API ' + (api.used ? 'used' : 'not used (' + (api.reason || (api.error && api.error.code) || 'unreachable') + ')') + '; ledger +' + added + ', shadow ledger +' + addedShadow + '; value claims ' + slate.readiness.value_claims.state + '; started games with frozen research ' + recent.games.length);
}

if (require.main === module) main().catch((e) => { console.error(e.stack || e); process.exit(1); });
module.exports = { build, ledgerAppend, carryRecent, goalieInputsFile, checkGoalieInputs, peekGoalieRate, startersFor };
