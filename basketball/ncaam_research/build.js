#!/usr/bin/env node
'use strict';
/* ===========================================================================
   Build the published research: every JSON the research pages read.

     node basketball/ncaam_research/build.js            full build
     node basketball/ncaam_research/build.js --check    rebuild in memory, compare index + league

   Inputs: the verified pack (datapack/ncaam_v1), the frozen team-model
   selection (selection_frozen.json), the player-layer choice
   (published/validation_player.json) and the interaction verdicts
   (published/validation_interactions.json). Outputs in published/:

     index.json            every D1 team, ratings and ranks, freshness, model status
     league.json           league constants, calibration, factor weights, verdicts
     teams/<espn id>.json  team research: rating, style, players, lineups, games
     matchups/*.json       pregame reports as of the moment before tip (2026 Final Four)
     upcoming.json         2026-27 opening games: preseason carry-forward projections
     audit.json            data QA, provenance, identity crosswalk results
     identity_quarantine.json

   Nothing here reads a sportsbook price unless a quotes file in the pack's
   market_quotes contract exists (market.js); without one every pricing
   section says "market comparison unavailable" and the research is complete.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const C = require('./config');
const U = require('./lib/util');
const I = require('./ingest');
const AUD = require('./audit');
const ID = require('./identity');
const WF = require('./walkforward');
const TM = require('./team_model');
const CAL = require('./lib/calibration');
const S = require('./style');
const PM = require('./player_model');
const PE = require('./player_eval');
const MN = require('./minutes');
const LU = require('./lineups');
const MK = require('./market');
const NR = require('../../lib/ncaam_research');
const { PROVENANCE } = require('./lib/pack');
const { readCsv } = require('../../engine/csv');

const r1 = (v) => U.r(v, 1); const r2 = (v) => U.r(v, 2); const r3 = (v) => U.r(v, 3); const r4 = (v) => U.r(v, 4);
const SEASON = 2026;

/* ---------------------------------------------------------------- team-model context (end of season or as of a moment) */
function teamContext(WD, frozen, asOfMs) {
  const full = WF.runCandidate(WD, frozen.chosen, 'holdout');
  const prev = full.states[2025].state;
  const now = asOfMs == null ? full.states[SEASON] : TM.runSeason(SEASON, WD.games.holdout, Object.assign({}, frozen.chosen, { stop_ms: asOfMs }), prev, WD.rosters);
  const form = TM.runSeason(SEASON, WD.games.holdout, Object.assign({}, frozen.chosen, { half_life: 30 }, asOfMs == null ? {} : { stop_ms: asOfMs }), prev, WD.rosters);
  const scored = WF.scored(full.rows, 'D1_D1');
  const pool = scored.filter((r) => asOfMs == null || r.start_ms + C.AVAILABLE_AFTER_MS < asOfMs);
  const cal = CAL.fit(pool);
  const early = CAL.fit(pool.filter((r) => r.season >= 2025 && Math.min(r.n_h, r.n_a) <= 4));
  return { full, now, form, prev, cal, early, scoredById: new Map(scored.map((r) => [r.game_id, r])), states: full.states };
}

function ratingsTable(E, Tm, ids) {
  const out = new Map();
  for (const id of ids) {
    const r = E.rating(id); const t = Tm.rating(id); if (!r) continue;
    const v = E.variance(id); const vt = Tm.variance(id);
    out.set(id, { off: r.off, allow: r.allow, net: r.off - r.allow, adj_o: E.mu + r.off, adj_d: E.mu + r.allow, tempo: Tm.mu + (t ? (t.off + t.allow) : 0), pace_off: t ? t.off : 0, pace_allow: t ? t.allow : 0, var_off: v.off, var_allow: v.allow, sd_net: Math.sqrt(v.off + v.allow), sd_tempo: Math.sqrt(vt.off + vt.allow), games: v.n_off });
  }
  const rank = (k, desc) => { const a = [...out.entries()].sort((x, y) => (desc ? y[1][k] - x[1][k] : x[1][k] - y[1][k])); a.forEach(([, v], i) => { v['rank_' + k] = i + 1; }); };
  rank('net', true); rank('adj_o', true); rank('adj_d', false); rank('tempo', true);
  return out;
}

/* ---------------------------------------------------------------- style context */
function styleContext(WD, asOfMs, P, PQ) {
  const c = WD.coef.holdout.c; const rel = {};
  for (const f of S.FACTORS) rel[f.key] = S.reliability(WD.TG, WD.G.byId, [2024, 2025], f, c);
  const prof = S.seasonProfiles(WD.TG, WD.G, SEASON, asOfMs, c, rel);
  const poss = S.possessionProfiles(P, PQ, WD.G, asOfMs);
  const ffw = S.fourFactorWeights(WD.TG, WD.G, [2024, 2025], c);
  return { c, rel, prof, poss, ffw };
}

function teamStyle(st, team) {
  const out = {};
  for (const f of S.FACTORS) {
    const t = st.prof.factors[f.key][team]; if (!t) continue;
    const rankGood = (role) => { if (!t[role] || f.good == null) return null; const of = t[role].of; const rk = t[role].rank; const goodHigh = role === 'off' ? f.good === 'high' : f.good === 'low'; return goodHigh ? rk : of - rk + 1; };
    out[f.key] = {
      label: f.label, group: f.group, good: f.good, league: r4(st.prof.league[f.key]),
      reliability: { off: st.rel[f.key].offense ? st.rel[f.key].offense.full_season_reliability : null, def: st.rel[f.key].defense ? st.rel[f.key].defense.full_season_reliability : null },
      off: t.off ? { observed: r4(t.off.observed), adjusted: r4(t.off.adjusted), sustainable: r4(t.off.sustainable), sd: r4(t.off.sd), rank: t.off.rank, rank_good: rankGood('off'), of: t.off.of, weight: r1(t.off.weight) } : null,
      def: t.def ? { observed: r4(t.def.observed), adjusted: r4(t.def.adjusted), sustainable: r4(t.def.sustainable), sd: r4(t.def.sd), rank: t.def.rank, rank_good: rankGood('def'), of: t.def.of, weight: r1(t.def.weight) } : null,
    };
  }
  for (const k of Object.keys(st.poss)) {
    const t = st.poss[k].teams[team]; if (!t) continue;
    const good = k === 'transition_share' ? null : 'high';
    out[k] = { label: S.POSS_FACTORS.find((f) => f.key === k).label, group: 'transition', good, league: r4(st.poss[k].league), source: '2026 publisher possession classification',
      off: { observed: r4(t.off.observed), sustainable: r4(t.off.sustainable), sd: r4(t.off.sd), rank: t.off.rank, rank_good: good ? t.off.rank : null, of: t.off.of },
      def: { observed: r4(t.def.observed), sustainable: r4(t.def.sustainable), sd: r4(t.def.sd), rank: t.def.rank, rank_good: good ? t.def.of - t.def.rank + 1 : null, of: t.def.of } };
  }
  return out;
}

/** what the four factors say about where a team's efficiency comes from */
function explain(style, ffw, rating) {
  const parts = [];
  for (const [k, w, good] of [['efg', ffw.efg, 1], ['tov_pct', ffw.tov_pct, 1], ['orb_pct', ffw.orb_pct, 1], ['ftr', ffw.ftr, 1]]) {
    const s = style[k]; if (!s || !s.off) continue;
    parts.push({ side: 'offense', factor: k, label: s.label, value: s.off.sustainable, league: s.league, points_per_100: r2(w * (s.off.sustainable - s.league) * good) });
    if (s.def) parts.push({ side: 'defense', factor: k, label: s.label, value: s.def.sustainable, league: s.league, points_per_100: r2(-w * (s.def.sustainable - s.league)) });
  }
  parts.sort((a, b) => Math.abs(b.points_per_100) - Math.abs(a.points_per_100));
  const fmt = (p) => `${p.side === 'offense' ? 'Offense' : 'Defense'}: ${p.label} ${(100 * p.value).toFixed(1)}% vs D1 ${(100 * p.league).toFixed(1)}% (${p.points_per_100 >= 0 ? '+' : ''}${p.points_per_100.toFixed(1)} per 100)`;
  const strengths = parts.filter((p) => p.points_per_100 > 0.5).slice(0, 3).map(fmt);
  const weaknesses = parts.filter((p) => p.points_per_100 < -0.5).slice(0, 2).map(fmt);
  return { contributions: parts, strengths, weaknesses, note: 'Four-factor weights are a regression of points per 100 on eFG%, TOV%, ORB% and FTA/FGA over 2024-25 team-games (R2 ' + U.r(ffw.r2, 3) + '); rates are opponent-adjusted and shrunk by their measured reliability. Net rating ' + (rating ? r1(rating.net) : '?') + '.' };
}

/* ---------------------------------------------------------------- players */
async function playerContext(asOfMs) {
  const D = await PE.load();
  const valP = JSON.parse(fs.readFileSync(C.PATHS.outFile('validation_player.json'), 'utf8'));
  const chosen = valP.possession_level.chosen;
  let B = PM.buildUnits(D.P, D.keep(['EXACT', 'WITHIN_3']), D.G.byId);
  if (asOfMs != null) B = PM.subset(B, (u) => D.G.byId.get(B.units.game[u]).start_ms + C.AVAILABLE_AFTER_MS < asOfMs);
  const box = PM.boxRates(D.NP, asOfMs); const prev = PE.previousSeasonPrior(D.R, SEASON);
  const fv = PE.fitVariant(B, chosen.variant, chosen.lambda, box, prev); const f = fv.fit;
  const teams = PM.playerTeams(B); const post = PM.teamBlocks(B, f, (pid) => teams[B.index.get(pid)]);
  const ex = PM.exposure(B);
  // raw on/off per player: team totals minus on-court
  const tOff = new Map(); const tDef = new Map(); const Ut = B.units;
  for (let u = 0; u < Ut.n; u++) {
    const a = tOff.get(Ut.offTeam[u]) || { poss: 0, pts: 0 }; a.poss += Ut.cnt[u]; a.pts += Ut.pts[u]; tOff.set(Ut.offTeam[u], a);
    const b = tDef.get(Ut.defTeam[u]) || { poss: 0, pts: 0 }; b.poss += Ut.cnt[u]; b.pts += Ut.pts[u]; tDef.set(Ut.defTeam[u], b);
  }
  const PGrows = asOfMs == null ? D.PG : { rows: D.PG.rows.filter((r) => r.start_ms + C.AVAILABLE_AFTER_MS < asOfMs) };
  const book = MN.walkSeason(PGrows, SEASON, valP.minutes_and_rates.chosen_on_2025.half_life_games);
  const tags = LU.roleTags(box);
  const pub = new Map(D.R[SEASON].map((r) => [r.player_id, r]));
  const names = new Map(); for (const r of D.NP.rows) if (!names.has(r.pid)) names.set(r.pid, r.name);
  return { D, B, f, fv, chosen, teams, post, ex, tOff, tDef, book, tags, box, prev, pub, valP, names };
}

function careers(PG) {
  const by = new Map();
  for (const r of PG.rows) {
    if (r.dnp || !(r.min > 0)) continue;
    const k = r.athlete + ':' + r.season + ':' + r.team; let a = by.get(k);
    if (!a) { a = { athlete: r.athlete, season: r.season, team: r.team, games: 0, min: 0, pts: 0 }; by.set(k, a); }
    a.games++; a.min += r.min; a.pts += r.pts || 0;
  }
  const out = new Map(); for (const a of by.values()) { if (!out.has(a.athlete)) out.set(a.athlete, []); out.get(a.athlete).push({ season: a.season, team: a.team, games: a.games, mpg: r1(a.min / a.games), ppg: r1(a.pts / a.games) }); }
  for (const v of out.values()) v.sort((a, b) => a.season - b.season);
  return out;
}

function teamPlayers(team, PC, X, teamNames, careerMap, rating) {
  const P = PC.B.players.length; const x = PC.f.x; const s2 = PC.f.s2;
  const idxs = []; for (let i = 0; i < P; i++) if (PC.teams[i] === team) idxs.push(i);
  const tOff = PC.tOff.get(team) || { poss: 0, pts: 0 }; const tDef = PC.tDef.get(team) || { poss: 0, pts: 0 };
  const tempo = rating ? rating.tempo : 68;
  const rotationRows = PC.book.rotation(team);
  const byAthlete = new Map(rotationRows.map((r) => [r.athlete, r]));
  const players = [];
  const priorSd = Math.sqrt(s2 / PC.chosen.lambda);
  for (const i of idxs) {
    const pid = PC.B.players[i]; const athlete = X.athleteOf.get(pid); const m = athlete != null ? byAthlete.get(athlete) : null;
    const bx = PC.box.get(pid); const ps = PC.post.get(i);
    const onO = PC.ex.offPoss[i]; const onD = PC.ex.defPoss[i];
    const onNet = onO && onD ? PC.ex.offPts[i] / onO - PC.ex.defPts[i] / onD : null;
    const offO = tOff.poss - onO; const offD = tDef.poss - onD;
    const offNet = offO > 0 && offD > 0 ? (tOff.pts - PC.ex.offPts[i]) / offO - (tDef.pts - PC.ex.defPts[i]) / offD : null;
    const pub = PC.pub.get(pid);
    const name = bx ? bx_name(PC, pid) : null;
    const rates = bx ? bx.rates : null;
    players.push({
      id: pid, athlete: athlete == null ? null : athlete, name: (m && m.name) || name || String(pid), pos: m ? m.pos : null,
      identity: { ncaa_player_id: pid, espn_athlete_id: athlete == null ? null : athlete, link: athlete == null ? 'none' : 'fingerprint' },
      minutes: m ? { games: m.games, team_games: m.team_games, appearance_rate: r3(m.appearance_rate), expected: r1(m.expected_minutes), season_mpg: r1(m.season_mpg), baseline: r1(m.baseline_minutes), cap: r1(m.cap), start_rate: r3(m.start_rate), fouls_per_40: r2(m.fouls_per_40), foul_outs: m.foul_outs, last5_mpg: r1(m.last5_mpg) } : null,
      per40: m ? { pts: r1(m.per40.pts), reb: r1(m.per40.reb), ast: r1(m.per40.ast) } : null,
      box: bx ? boxSummary(bx) : null,
      impact: { o: r2(x[i]), d: r2(x[P + i]), net: r2(x[i] + x[P + i]), sd_o: r2(ps ? ps.sd_o : priorSd), sd_d: r2(ps ? ps.sd_d : priorSd), sd_net: r2(ps ? ps.sd_net : priorSd * Math.SQRT2), off_poss: onO, def_poss: onD, prior: bx ? priorOf(PC, i) : null },
      on_off: { on_net: r1(onNet), off_net: r1(offNet), difference: onNet != null && offNet != null ? r1(onNet - offNet) : null, on_poss: onO + onD, off_poss: offO + offD },
      publisher_rapm: pub ? { net: r2(pub.rapm_net), o: r2(pub.orapm), d: r2(pub.drapm), possessions: pub.off_poss } : null,
      roles: (PC.tags.get(pid) || { tags: [] }).tags,
      history: athlete != null ? (careerMap.get(athlete) || []).map((h) => Object.assign({}, h, { team_name: teamNames(h.team) })) : [],
    });
  }
  // contribution, separability, replacement, transfer flags
  const rotation = players.filter((p) => p.minutes && p.minutes.baseline > 0).map((p) => ({ id: p.id, name: p.name, pos: p.pos, baseline: p.minutes.baseline, expected: p.minutes.expected, cap: p.minutes.cap, starter: p.minutes.start_rate > 0.5, o: p.impact.o, d: p.impact.d, sd_o: p.impact.sd_o, sd_d: p.impact.sd_d, roles: p.roles }));
  for (const p of players) {
    const mins = p.minutes ? p.minutes.baseline : 0;
    p.contribution = { points_per_100_team: r2((p.impact.net * mins) / 40), points_per_game: r2(((p.impact.net * mins) / 40) * (tempo / 100)) };
    // separability: the teammate he shares the most possessions with
    const i = PC.B.index.get(p.id); let best = null;
    for (const q of players) {
      if (q === p) continue; const k = PC.B.index.get(q.id); const key = i < k ? i * 100000 + k : k * 100000 + i;
      const shared = PC.ex.pair.get(key) || 0; const share = shared / Math.max(1, PC.ex.offPoss[i] + PC.ex.defPoss[i]); // pairs count offense and defense possessions
      if (!best || share > best.share) best = { name: q.name, id: q.id, share, k };
    }
    if (best) {
      const corr = PM.netCorrelation(PC.post, i, best.k, PC.f.s2);
      p.separability = { top_teammate: best.name, shared_share: r3(best.share), posterior_corr: r3(corr), separable: !(best.share > 0.85 || (corr != null && corr < -0.5)) };
    }
    if (p.minutes && p.minutes.baseline > 0 && rotation.length >= 6) {
      const sc = NR.scenario(rotation, { out: [p.id] });
      const usual = new Map(sc.usual.players.map((q) => [q.id, q.minutes]));
      p.replacement = { delta_net_per_100: r2(sc.delta_vs_usual.net), sd: r2(sc.delta_vs_usual.sd_net), points_per_game: r2((sc.delta_vs_usual.net * tempo) / 100), minutes_to: sc.minutes.players.filter((q) => !q.out && q.minutes - usual.get(q.id) > 0.5).sort((a, b) => (b.minutes - usual.get(b.id)) - (a.minutes - usual.get(a.id))).slice(0, 3).map((q) => ({ name: q.name, extra_minutes: r1(q.minutes - usual.get(q.id)) })) };
    }
    const hist = p.history || []; const prevSeason = hist.filter((h) => h.season === SEASON - 1);
    p.transfer_in = prevSeason.length > 0 && prevSeason.every((h) => h.team !== team);
    p.returning = prevSeason.some((h) => h.team === team);
  }
  players.sort((a, b) => (b.minutes ? b.minutes.baseline : 0) - (a.minutes ? a.minutes.baseline : 0) || b.impact.off_poss - a.impact.off_poss);
  return { players, rotation };
}
function bx_name(PC, pid) { return PC.names.get(pid) || null; }
function priorOf(PC, i) { const bp = PC.fv.box_prior; if (!bp) return null; const P = PC.B.players.length; const m = PM.priorMeans({ players: [PC.B.players[i]], index: new Map([[PC.B.players[i], 0]]) }, PC.box, PC.prev, bp); void P; return { o: r2(m[0]), d: r2(m[1]), net: r2(m[0] + m[1]) }; }
function boxSummary(b) {
  const per = 100 / b.poss; const tsa = b.fga + 0.44 * b.fta;
  return {
    games: b.games, minutes: r1(b.mins), possessions: b.poss,
    usage: r1(b.rates.usage), ts_pct: tsa > 0 ? r3(b.pts / (2 * tsa)) : null, efg: b.fga ? r3((b.fgm + 0.5 * b.tpm) / b.fga) : null,
    three_rate: b.fga ? r3(b.tpa / b.fga) : null, three_pct: b.tpa ? r3(b.tpm / b.tpa) : null, three_attempts: b.tpa,
    ft_rate: b.fga ? r3(b.fta / b.fga) : null, ft_pct: b.fta ? r3(b.ftm / b.fta) : null,
    rim_share: b.fga ? r3(b.rima / b.fga) : null, rim_pct: b.rima ? r3(b.rimm / b.rima) : null, mid_share: b.fga ? r3(b.mida / b.fga) : null, mid_pct: b.mida ? r3(b.midm / b.mida) : null,
    unassisted_share_of_makes: b.fgm ? r3(b.fgm_unast / b.fgm) : null, transition_share_of_fga: b.fga ? r3(b.fga_trans / b.fga) : null, putback_attempts: b.pbacka,
    per100: { pts: r1(b.pts * per), ast: r1(b.ast * per), tov: r1(b.tov * per), orb: r1(b.orb * per), drb: r1(b.drb * per), stl: r1(b.stl * per), blk: r1(b.blk * per), pf: r1(b.pf * per) },
    sample_note: b.tpa < 40 ? '3-point percentage on fewer than 40 attempts is mostly noise' : null,
  };
}

/* ---------------------------------------------------------------- lineups per team */
function teamLineups(team, rows, PC, stintMin, nameOf) {
  return rows.filter((r) => r.team === team).sort((a, b) => b.off_poss + b.def_poss - (a.off_poss + a.def_poss)).slice(0, 15).map((r) => ({
    players: r.players.map(nameOf), ids: r.players, minutes: r1(stintMin.get(team + '|' + r.players.slice().sort((a, b) => a - b).join(',')) || null), games: r.games,
    off_poss: r.off_poss, def_poss: r.def_poss, raw_off: r1(r.raw_off), raw_def: r1(r.raw_def), raw_net: r.raw_off != null && r.raw_def != null ? r1(r.raw_off - r.raw_def) : null,
    adjusted_net: r1(r.adj_net), player_sum: r1(r.player_sum), pooled_net: r1(r.pooled), weight_on_own_results: r3(r.shrink),
  }));
}

/* ---------------------------------------------------------------- team document */
function teamDoc(id, ctx) {
  const { G, ratings, form, prevRatings, st, PC, X, lineupRows, stintMin, teamName, careerMap, scoredById, gamesAll, asOf } = ctx;
  const tm = G.teams.get(id); const season = tm.seasons[SEASON] || {};
  const rt = ratings.get(id); if (!rt) return null;
  const fr = form.get(id);
  const style = teamStyle(st, id);
  const { players, rotation } = teamPlayers(id, PC, X, teamName, careerMap, rt);
  const nameOf = (pid) => { const p = players.find((q) => q.id === pid); return p ? p.name : String(pid); };
  const lineups = teamLineups(id, lineupRows, PC, stintMin, nameOf);
  // games
  const games = []; let w = 0; let l = 0; let cw = 0; let cl = 0; const oppNets = []; const ncNets = [];
  const venueSplit = { home: { n: 0, net: 0 }, away: { n: 0, net: 0 }, neutral: { n: 0, net: 0 } };
  const shooting = { tp: [], otp: [] };
  for (const g of gamesAll) {
    if (g.season !== SEASON || (g.home !== id && g.away !== id)) continue;
    if (asOf != null && g.start_ms + C.AVAILABLE_AFTER_MS >= asOf) continue;
    const home = g.home === id; const opp = home ? g.away : g.home; const pts = home ? g.hs : g.as; const opts = home ? g.as : g.hs;
    const won = pts > opts; if (won) w++; else l++; if (g.conference_game) { if (won) cw++; else cl++; }
    const oppR = ratings.get(opp); if (oppR && g.regime === 'D1_D1') { oppNets.push(oppR.net); if (!g.conference_game) ncNets.push(oppR.net); }
    const venue = g.neutral ? 'neutral' : home ? 'home' : 'away';
    const off = home ? g.yH : g.yA; const def = home ? g.yA : g.yH;
    venueSplit[venue].n++; venueSplit[venue].net += off - def;
    const box = home ? g.box.h : g.box.a; const obox = home ? g.box.a : g.box.h;
    if (box.tpa > 0) shooting.tp.push(box.tpm / box.tpa); if (obox.tpa > 0) shooting.otp.push(obox.tpm / obox.tpa);
    const pre = scoredById.get(g.game_id);
    games.push({
      game_id: g.game_id, date: new Date(g.start_ms).toISOString().slice(0, 10), opp, opp_name: teamName(opp), venue, regime: g.regime, event: g.event, conference: g.conference_game,
      result: won ? 'W' : 'L', pts, opp_pts: opts, ot: g.n_ot || 0, possessions: r1(g.poss), off_eff: r1(off), def_eff: r1(def),
      pregame: pre && pre.cal ? { margin: r1(home ? pre.cal.margin_mu : -pre.cal.margin_mu), win_prob: r3(home ? pre.cal.p_home : 1 - pre.cal.p_home), margin_sd: r1(pre.cal.margin_sd) } : null,
    });
  }
  games.sort((a, b) => (a.date < b.date ? -1 : 1));
  for (const k of Object.keys(venueSplit)) venueSplit[k] = { games: venueSplit[k].n, raw_net_per_100: venueSplit[k].n ? r1(venueSplit[k].net / venueSplit[k].n) : null };
  const tpSd = U.sd(shooting.tp); const otpSd = U.sd(shooting.otp);
  const bxpg = boxPerGame(gamesAll, id, asOf);
  const three = style.three_pct; const fga = bxpg ? bxpg.fga : null;
  const luck = three && three.off && fga ? { team_three_pct_vs_sustainable_points_per_game: r2(3 * (three.off.observed - three.off.sustainable) * (style.three_rate ? style.three_rate.off.observed : 0.38) * fga), opponent_three_pct_vs_sustainable_points_per_game: three.def && bxpg.opp_fga ? r2(3 * (three.def.observed - three.def.sustainable) * (style.three_rate && style.three_rate.def ? style.three_rate.def.observed : 0.38) * bxpg.opp_fga) : null } : null;
  const rot = rotation.slice().sort((a, b) => b.baseline - a.baseline);
  const totalBase = U.sum(rot.map((p) => p.baseline)) || 1;
  const contributions = players.filter((p) => p.contribution).map((p) => p.contribution.points_per_100_team);
  const best = players.filter((p) => p.impact.off_poss >= 500).sort((a, b) => b.impact.net - a.impact.net)[0] || null;
  const prod = players.filter((p) => p.contribution).sort((a, b) => b.contribution.points_per_game - a.contribution.points_per_game)[0] || null;
  const hard = players.filter((p) => p.replacement).sort((a, b) => a.replacement.points_per_game - b.replacement.points_per_game)[0] || null;
  const cont = prevContinuity(ctx, id);
  return {
    schema: 'edgedesk_ncaam_team_v1', season: SEASON, as_of: asOf == null ? ctx.dataThrough : new Date(asOf).toISOString(),
    team: { id, name: tm.display, short: tm.location || tm.display, nickname: tm.nickname, abbrev: tm.abbrev, color: tm.color ? '#' + tm.color : null, conference: season.conference || null, d1: season.d1 === true, ncaa_team_season_id: season.ncaa_team_season_id || null, membership_mapping: season.mapping || null },
    record: { w, l, conf_w: cw, conf_l: cl },
    rating: {
      adj_o: r1(rt.adj_o), adj_d: r1(rt.adj_d), net: r1(rt.net), tempo: r1(rt.tempo), sd_net: r2(rt.sd_net), sd_o: r2(Math.sqrt(rt.var_off)), sd_d: r2(Math.sqrt(rt.var_allow)), sd_tempo: r2(rt.sd_tempo),
      rank_net: rt.rank_net, rank_o: rt.rank_adj_o, rank_d: rt.rank_adj_d, rank_tempo: rt.rank_tempo, of: ratings.size, games: rt.games,
      current_form: fr ? { net: r1(fr.net), adj_o: r1(fr.adj_o), adj_d: r1(fr.adj_d), half_life_days: 30, difference_from_season: r1(fr.net - rt.net), note: 'recency-weighted refit; the season-long rating predicted better in selection (no recency weighting was chosen)' } : null,
      previous: prevRatings.map((pr) => { const v = pr.table.get(id); return v ? { season: pr.season, net: r1(v.net), adj_o: r1(v.adj_o), adj_d: r1(v.adj_d), tempo: r1(v.tempo), rank_net: v.rank_net } : null; }).filter(Boolean),
      schedule: { opponents_mean_net: r1(U.mean(oppNets)), nonconference_opponents_mean_net: r1(U.mean(ncNets)), d1_games: oppNets.length },
      venue_splits_observed: Object.assign(venueSplit, { note: 'raw (unadjusted) efficiency margin by venue; the model uses one D1-wide home advantage' }),
    },
    matchup_rating: { off: r3(rt.off), allow: r3(rt.allow), pace_off: r3(rt.pace_off), pace_allow: r3(rt.pace_allow), var_off: r4(rt.var_off), var_allow: r4(rt.var_allow) },
    style, explanation: explain(style, st.ffw, rt),
    style_variance: { three_pct_game_sd: r4(tpSd), opponent_three_pct_game_sd: r4(otpSd), luck, note: 'game-to-game spread of 3-point percentage; luck = observed minus the reliability-shrunk estimate, in points per game' },
    box_per_game: bxpg,
    rotation_summary: {
      players_10_plus_mpg: rot.filter((p) => p.expected >= 10).length,
      top5_minutes_share: r3(U.sum(rot.slice(0, 5).map((p) => p.baseline)) / totalBase),
      bench_minutes_share: r3(1 - U.sum(rot.slice(0, 5).map((p) => p.baseline)) / totalBase),
      returning_minutes_share: cont.returning, transfers_in: players.filter((p) => p.transfer_in).map((p) => p.name),
      top_player_share_of_positive_contribution: contributions.length ? r3(Math.max(...contributions) / Math.max(1e-9, U.sum(contributions.filter((v) => v > 0)))) : null,
    },
    questions: {
      best_player: best ? { name: best.name, impact_net: best.impact.net, sd: best.impact.sd_net, why: 'highest estimated impact per possession among players with 500+ offensive possessions' } : null,
      most_productive: prod ? { name: prod.name, points_per_game: prod.contribution.points_per_game, why: 'impact multiplied by the share of the game he plays' } : null,
      hardest_to_replace: hard ? { name: hard.name, points_per_game: hard.replacement.points_per_game, sd: hard.replacement.sd, why: 'largest loss when his minutes are redistributed to the players who would actually take them (conditional estimate)' } : null,
    },
    players, scenario_rotation: rotation, lineups,
    lineup_note: 'Pooled net = the five players\' impact sum plus the lineup\'s own adjusted result shrunk toward it; a small sample barely moves it.',
    games,
  };
}

function boxPerGame(gamesAll, id, asOf) {
  let n = 0; const s = { fga: 0, fta: 0, tpa: 0, tov: 0, orb: 0, pts: 0, opp_fga: 0 };
  for (const g of gamesAll) {
    if (g.season !== SEASON || (g.home !== id && g.away !== id) || g.regime !== 'D1_D1') continue;
    if (asOf != null && g.start_ms + C.AVAILABLE_AFTER_MS >= asOf) continue;
    const b = g.home === id ? g.box.h : g.box.a; const o = g.home === id ? g.box.a : g.box.h;
    n++; s.fga += b.fga; s.fta += b.fta; s.tpa += b.tpa; s.tov += b.tov; s.orb += b.orb; s.pts += b.pts; s.opp_fga += o.fga;
  }
  if (!n) return null; const out = { games: n }; for (const k of Object.keys(s)) out[k] = r1(s[k] / n); return out;
}

function prevContinuity(ctx, id) {
  const tr = ctx.tctx.now.track; if (tr) { const c = tr.continuity(id); return { returning: c == null ? null : r3(c) }; }
  const last = ctx.WD.rosters.minutes.get(SEASON - 1); const now = ctx.WD.rosters.minutes.get(SEASON);
  if (!last || !now || !last.get(id) || !now.get(id)) return { returning: null };
  let tot = 0; let ret = 0; const cur = now.get(id);
  for (const [a, m] of last.get(id)) { tot += m; if (cur.has(a)) ret += m; }
  return { returning: tot ? r3(ret / tot) : null };
}

/* ---------------------------------------------------------------- league document */
function leagueDoc(tctx, st, ratings, interactions, valP) {
  const E = tctx.now.E; const Tm = tctx.now.Tm; const cal = tctx.cal;
  return {
    schema: 'edgedesk_ncaam_league_v1', season: SEASON,
    mu: r3(E.mu), eta: r3(E.eta), tau: r3(Tm.mu), home_court_points_per_100: r2(2 * E.eta),
    cal: calOut(cal), cal_early_season: calOut(tctx.early),
    factor_league: Object.fromEntries(Object.entries(st.prof.league).map(([k, v]) => [k, r4(v)]).concat(Object.entries(st.poss).map(([k, v]) => [k, r4(v.league)]))),
    four_factor_weights: { efg: r2(st.ffw.efg), tov_pct: r2(st.ffw.tov_pct), orb_pct: r2(st.ffw.orb_pct), ftr: r2(st.ffw.ftr), r2: r3(st.ffw.r2), n: st.ffw.n },
    reliability: st.rel,
    interactions: interactions ? interactions.status : null,
    interactions_summary: interactions ? { status: interactions.status, holdout: interactions.holdout_2026_squared_error_with_minus_without, rule: interactions.rule } : null,
    player_layer: { variant: valP.possession_level.chosen.variant, lambda: valP.possession_level.chosen.lambda, prior_sd_per_100: r2(Math.sqrt(13500 / valP.possession_level.chosen.lambda)) },
    non_d1: { off: r2(tctx.now.nond1.off), allow: r2(tctx.now.nond1.allow), pace: r2(tctx.now.nond1.pace), games: tctx.now.nond1.games, note: 'one pooled opponent for teams outside the D1 reference: a separate regime' },
    teams_rated: ratings.size,
  };
}
function calOut(c) { if (!c) return null; return { n: c.n, margin: { a: r3(c.margin.a), b: r4(c.margin.b) }, total: { a: r3(c.total.a), b: r4(c.total.b) }, var_margin: { s0: r2(c.var_margin.s0), k: r3(c.var_margin.k) }, var_total: { s0: r2(c.var_total.s0), k: r3(c.var_total.k) }, rho: r3(c.rho) }; }

/* ---------------------------------------------------------------- everything */
async function buildAll(o) {
  const t0 = Date.now(); const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);
  const AU = await AUD.run(); log('audit');
  const WD = await WF.prepare(); const frozen = JSON.parse(fs.readFileSync(C.PATHS.frozen, 'utf8'));
  const interactions = fs.existsSync(C.PATHS.outFile('validation_interactions.json')) ? JSON.parse(fs.readFileSync(C.PATHS.outFile('validation_interactions.json'), 'utf8')) : null;
  const P = await I.loadPossessions(); const S_ = await I.loadStints();
  const teamName = (id) => { const t = WD.G.teams.get(id); return t ? t.location || t.display : String(id); };
  const careerMap = careers(WD.PG);
  const dataThrough = new Date(Math.max(...WD.G.games.filter((g) => g.status === 'FINAL').map((g) => g.start_ms))).toISOString();

  async function contextAt(asOf) {
    const tctx = teamContext(WD, frozen, asOf);
    const d1 = [...WD.G.teams.values()].filter((t) => t.seasons[SEASON] && t.seasons[SEASON].d1 === true).map((t) => t.id);
    const ratings = ratingsTable(tctx.now.E, tctx.now.Tm, d1);
    const formT = ratingsTable(tctx.form.E, tctx.form.Tm, d1);
    const prevRatings = asOf == null ? [2025, 2024].map((s) => ({ season: s, table: ratingsTable(tctx.states[s].E, tctx.states[s].Tm, [...WD.G.teams.values()].filter((t) => t.seasons[s] && t.seasons[s].d1 === true).map((t) => t.id)) })) : [];
    const st = styleContext(WD, asOf, P, AU.PQ);
    const PC = await playerContext(asOf);
    const lineupRows = LU.lineupTable(PC.B, PC.f); const poolInfo = LU.pool(lineupRows, PC.f.s2, 40);
    const stint = LU.stintMinutes(S_, P, WD.G);
    return { G: WD.G, WD, tctx, ratings, form: formT, prevRatings, st, PC, X: AU.X, lineupRows, poolInfo, stintMin: stint.minutes, stintInfo: stint, teamName, careerMap, scoredById: tctx.scoredById, gamesAll: WD.games.holdout, asOf, dataThrough };
  }

  const ctx = await contextAt(null); log('season context');
  const league = leagueDoc(ctx.tctx, ctx.st, ctx.ratings, interactions, ctx.PC.valP);
  const docs = new Map();
  for (const id of ctx.ratings.keys()) { const d = teamDoc(id, ctx); if (d) docs.set(id, d); }
  log('team documents ' + docs.size);

  // lineup tests (season)
  const gameStart = (g) => WD.G.byId.get(g).start_ms;
  const split = Date.parse('2026-01-20T10:00:00Z');
  const persistence = LU.persistence(ctx.PC.B, (B1) => PE.fitVariant(B1, ctx.PC.chosen.variant, ctx.PC.chosen.lambda, PM.boxRates(ctx.PC.D.NP, split), ctx.PC.prev).fit, gameStart, split, 100);
  const roleTest = LU.roleTest(ctx.lineupRows, ctx.PC.tags, 80);
  const lineupValidation = { pooling: { tau_per_100: r2(ctx.poolInfo.tau), lineups_used: ctx.poolInfo.lineups_used }, persistence, role_composition: roleTest, stint_mapping: { mapped: ctx.stintInfo.mapped_lineup_stints, unmapped: ctx.stintInfo.unmapped_lineup_stints, ambiguous_name_keys: ctx.stintInfo.ambiguous_name_keys } };
  log('lineup tests');

  // market layer
  const market = MK.load();

  // as-of matchup reports: the 2026 national semifinals and final
  const ncaa = WD.G.games.filter((g) => g.season === SEASON && g.event === 'ncaa_tournament' && g.status === 'FINAL').sort((a, b) => b.start_ms - a.start_ms).slice(0, 3);
  const matchups = [];
  for (const g of ncaa) {
    const asOf = g.start_ms - C.PREDICT_BEFORE_MS;
    const c2 = await contextAt(asOf);
    const lg = leagueDoc(c2.tctx, c2.st, c2.ratings, interactions, c2.PC.valP);
    const h = teamDoc(g.home, c2); const a = teamDoc(g.away, c2);
    const rep = NR.matchupReport(h, a, lg, { neutral: g.neutral, as_of: new Date(asOf).toISOString(), rest: restDays(WD.G, g) });
    const pr = NR.project(h.matchup_rating, a.matchup_rating, lg, { neutral: g.neutral });
    rep.market = NR.compareMarket(pr, market.byGame.get(g.game_id) || [], { now: asOf, unavailable_reason: market.reason || 'no stored price for this game' });
    rep.result = { home_points: g.hs, away_points: g.as, margin_home: g.hs - g.as, total: g.hs + g.as, overtime: g.n_ot || 0, note: 'recorded after the report: the report used only games finished before tip' };
    rep.event = g.event_name; rep.game_id = g.game_id; rep.date = new Date(g.start_ms).toISOString().slice(0, 10);
    matchups.push(rep);
    log('as-of report ' + rep.teams.home.short + ' vs ' + rep.teams.away.short);
  }

  // upcoming 2026-27 games (existing schedule feed): preseason carry-forward, team level only
  const upcoming = upcomingGames(ctx, league, market);
  log('upcoming ' + upcoming.games.length);

  const index = {
    schema: 'edgedesk_ncaam_index_v1', generated_from: 'datapack/ncaam_v1 (verified by hash)', season: SEASON, data_through: dataThrough,
    status: {
      team_model: 'VALIDATED: beats the incumbent points model and unadjusted efficiency on held-out 2026 games (validation_team.json)',
      player_impact: 'MODEST SIGNAL: with box-score and prior-season priors, held-out possessions are predicted better than by team ratings alone; pure on-court RAPM is not (validation_player.json)',
      scenarios: 'EXPERIMENTAL: conditional estimates; with after-the-fact availability they did not improve game predictions',
      lineups: 'DESCRIPTIVE + POOLED: lineup results beyond player impacts did not persist across the season halves',
      interactions: 'NOT SUPPORTED: no style interaction improved held-out predictions; shown as hypotheses only',
      market: market.status === 'UNAVAILABLE' ? 'UNAVAILABLE: ' + market.reason : market.status,
    },
    teams: [...docs.values()].map((d) => ({ id: d.team.id, name: d.team.name, short: d.team.short, abbrev: d.team.abbrev, conference: d.team.conference, color: d.team.color, w: d.record.w, l: d.record.l, net: d.rating.net, adj_o: d.rating.adj_o, adj_d: d.rating.adj_d, tempo: d.rating.tempo, sd_net: d.rating.sd_net, rank: d.rating.rank_net, rank_o: d.rating.rank_o, rank_d: d.rating.rank_d, best_player: d.questions.best_player ? d.questions.best_player.name : null })).sort((a, b) => a.rank - b.rank),
    matchups: matchups.map((m) => ({ file: 'matchups/' + m.game_id + '.json', date: m.date, event: m.event, home: m.teams.home.short, away: m.teams.away.short })),
  };

  const audit = Object.assign({}, AU.report, { provenance: PROVENANCE, lineups_validation: lineupValidation, market_layer: { status: market.status, reason: market.reason || null, source: market.source || null, quotes: market.quotes || 0, refused: market.refused || null } });
  const quarantine = { schema: 'edgedesk_ncaam_identity_quarantine_v1', player_links: AU.X.quarantine, players_without_fingerprint: AU.X.no_evidence, team_membership: AU.M.audit, rule: 'quarantined ids are kept out of cross-source joins; their possession data still counts in the NCAA id space' };
  return { index, league, docs, matchups, upcoming, audit, quarantine };
}

function restDays(G, g) {
  const last = (team) => { let best = null; for (const x of G.games) if (x.status === 'FINAL' && x.start_ms < g.start_ms && (x.home === team || x.away === team)) best = x.start_ms; return best == null ? null : r1((g.start_ms - best) / 864e5); };
  return { home: last(g.home), away: last(g.away) };
}

function upcomingGames(ctx, league, market) {
  const file = path.join(C.ROOT, 'basketball', 'data', 'ncaam', (SEASON + 1) + '.csv');
  if (!fs.existsSync(file)) return { games: [], note: 'no 2026-27 schedule file' };
  const rows = readCsv(file).rows.filter((r) => r.status === 'SCHEDULED');
  const first = rows.length ? Math.min(...rows.map((r) => Date.parse(r.start_utc))) : 0;
  const lg = Object.assign({}, league, { cal: league.cal_early_season || league.cal });
  const games = [];
  for (const r of rows) {
    const t = Date.parse(r.start_utc); if (t > first + 14 * 864e5) continue;
    const h = Number(r.home_id); const a = Number(r.away_id);
    const H = ctx.ratings.get(h); const A = ctx.ratings.get(a);
    const doc = (id, R) => (R ? { team: { short: ctx.teamName(id) }, rating: R, matchup_rating: { off: R.off, allow: R.allow, pace_off: R.pace_off, pace_allow: R.pace_allow, var_off: R.var_off, var_allow: R.var_allow } } : null);
    const nd = { off: league.non_d1.off, allow: league.non_d1.allow, pace_off: league.non_d1.pace, pace_allow: 0, var_off: 4, var_allow: 4 };
    const HD = doc(h, H); const AD = doc(a, A);
    if (!HD && !AD) continue;
    const pr = NR.project(HD ? HD.matchup_rating : nd, AD ? AD.matchup_rating : nd, lg, { neutral: r.neutral === '1' });
    games.push({
      game_id: Number(r.game_id), start_utc: r.start_utc, neutral: r.neutral === '1', home: h, home_name: ctx.teamName(h), away: a, away_name: ctx.teamName(a),
      regime: HD && AD ? 'D1_D1' : 'D1_OTHER',
      projection: { margin_home: r1(pr.margin.mean), margin_sd: r1(pr.margin.sd), total: r1(pr.total.mean), total_sd: r1(pr.total.sd), win_home: r3(pr.win_home), possessions: r1(pr.possessions), points_home: r1(pr.points_home), points_away: r1(pr.points_away) },
      market: NR.compareMarket(pr, market.byGame.get(Number(r.game_id)) || [], { unavailable_reason: market.reason || 'no stored price for this game' }).status,
    });
  }
  games.sort((x, y) => (x.start_utc < y.start_utc ? -1 : 1));
  return {
    schema: 'edgedesk_ncaam_upcoming_v1', season: SEASON + 1, games,
    basis: 'PRESEASON CARRY-FORWARD: each team\'s final 2025-26 rating (the frozen model carries it unregressed) with the early-season calibration (games where a team had played 0-4 games, 2025-2026). No 2026-27 roster, transfer, recruit or availability data is in the pack, so roster turnover is not in these numbers; on held-out 2026 the first-games margin intervals covered 76% where 80% was intended.',
    schedule_source: 'basketball/data/ncaam/' + (SEASON + 1) + '.csv (sportsdataverse ESPN schedule, scheduled games)',
  };
}

async function main() {
  const out = await buildAll();
  if (process.argv.includes('--check')) {
    const committed = JSON.parse(fs.readFileSync(C.PATHS.outFile('index.json'), 'utf8'));
    const a = JSON.stringify(committed.teams.slice(0, 50)); const b = JSON.stringify(out.index.teams.slice(0, 50));
    if (a !== b) { console.error('published/index.json does not rebuild'); process.exit(1); }
    console.log('published research rebuilds'); return;
  }
  const dir = C.PATHS.out; fs.mkdirSync(path.join(dir, 'teams'), { recursive: true }); fs.mkdirSync(path.join(dir, 'matchups'), { recursive: true });
  for (const f of fs.readdirSync(path.join(dir, 'teams'))) fs.unlinkSync(path.join(dir, 'teams', f));
  for (const f of fs.readdirSync(path.join(dir, 'matchups'))) fs.unlinkSync(path.join(dir, 'matchups', f));
  const w = (f, v, pretty) => fs.writeFileSync(path.join(dir, f), JSON.stringify(v, null, pretty ? 1 : 0) + '\n');
  w('methodology.json', { schema: 'edgedesk_ncaam_methodology_v1', sources: 'docs/ncaam/METHODOLOGY_SOURCES.md', topics: require('./methodology').TOPICS }, true);
  w('index.json', out.index, true); w('league.json', out.league, true); w('audit.json', out.audit, true); w('identity_quarantine.json', out.quarantine, false); w('upcoming.json', out.upcoming, false);
  for (const [id, d] of out.docs) w('teams/' + id + '.json', d, false);
  for (const m of out.matchups) w('matchups/' + m.game_id + '.json', m, true);
  console.log('wrote', out.docs.size, 'team documents,', out.matchups.length, 'matchup reports,', out.upcoming.games.length, 'upcoming projections');
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { buildAll, teamDoc, leagueDoc };
