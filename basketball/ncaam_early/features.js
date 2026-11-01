'use strict';
/* ===========================================================================
   NCAAM-EARLY — the T2 features: deterministic transforms of T0 observations.

   Every number used here comes from the REGISTERED starting configuration,
   config/model_v0.json (pinned by sha256 in research/registration.json). No
   weight is learned in this file; a `selectable` value takes its registered
   starting value until the training-only selection freezes config/model_v1.
   An input a row does not have is never filled in: the feature is null and a
   flag names what is missing.

   Units. A player's VALUE is points per 100 possessions he is on the floor,
   relative to the D-I average of the season (config player_value). A team's
   roster rating is the sum over its players of value x on-floor fraction
   (expected minutes / 40), so five average players make 0 and the scale is
   points per 100 team possessions relative to D-I average.

     leagueContext(prevPlayers, cfg)               D-I average rates, team possessions
     playerValue(p, ctx, cfg)                      one player's OFF / DEF / VALUE
     translate(move, val, ctx, cfg)                a newcomer's translated value
     expectedMinutes(entries, cfg)                 minutes, normalised to 200 a game
     teamFeatures(teamId, season, inputs, cfg)     the preseason feature row
     continuityGap(a, b)                           the gap between two teams
     applyAvailability(row, outIds, cfg)           the row without players ruled out
     venue(game)                                   home / away / neutral, travel
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG_FILE = path.join(__dirname, 'config', 'model_v0.json');
function loadConfig() {
  const raw = fs.readFileSync(CONFIG_FILE);
  return Object.assign(JSON.parse(raw), { _sha256: crypto.createHash('sha256').update(raw).digest('hex') });
}
const val = (x) => (x && typeof x === 'object' && 'value' in x ? x.value : x);
const num = (x) => (x == null || !Number.isFinite(Number(x)) ? null : Number(x));
const round = (x, d) => (x == null ? null : Math.round(x * Math.pow(10, d == null ? 3 : d)) / Math.pow(10, d == null ? 3 : d));

/* the box-score production of the registered formula (season totals) */
function production(p) {
  const n = (k) => num(p[k]) || 0;
  const missFg = Math.max(0, n('fga') - n('fgm')), missFt = Math.max(0, n('fta') - n('ftm'));
  return {
    off: n('points') + 0.5 * n('assists') + 0.6 * n('orb') - 0.9 * n('turnovers') - 0.4 * missFg - 0.2 * missFt,
    def: 0.6 * n('drb') + 1.0 * n('steals') + 0.7 * n('blocks') - 0.2 * n('fouls'),
  };
}
const possOf = (p) => (num(p.fga) || 0) - (num(p.orb) || 0) + (num(p.turnovers) || 0) + 0.475 * (num(p.fta) || 0);

/** D-I averages and each team's possessions and player-minutes, one season */
function leagueContext(prevPlayers, cfg) {
  const teams = new Map();
  for (const p of prevPlayers) {
    if (!teams.has(p.team_id)) teams.set(p.team_id, { poss: 0, minutes: 0 });
    const t = teams.get(p.team_id); t.poss += possOf(p); t.minutes += num(p.minutes) || 0;
  }
  let so = 0, sd = 0, sp = 0;
  const minM = cfg.player_value.min_minutes_for_rate;
  for (const p of prevPlayers) {
    const on = onFloorPoss(p, teams.get(p.team_id));
    if (!(num(p.minutes) >= minM) || !(on > 0)) continue;
    const pr = production(p); so += pr.off; sd += pr.def; sp += on;
  }
  return { teams, avg_off: sp > 0 ? (100 * so) / sp : null, avg_def: sp > 0 ? (100 * sd) / sp : null, players: prevPlayers.length };
}
/* on-floor possessions = his share of the team's player-minutes x 5 x team possessions */
function onFloorPoss(p, team) {
  if (!team || !(team.minutes > 0)) return null;
  return ((num(p.minutes) || 0) / team.minutes) * 5 * team.poss;
}

/** one player's value from last season's record, shrunk toward replacement */
function playerValue(p, ctx, cfg) {
  const PV = cfg.player_value, rep = PV.replacement_level;
  const min = num(p.minutes) || 0, on = onFloorPoss(p, ctx.teams.get(p.team_id));
  if (ctx.avg_off == null || !(on > 0) || min < PV.min_minutes_for_rate) {
    return { off: rep.off, def: rep.def, value: rep.off + rep.def, minutes: min, rate_ok: false, flags: ['BELOW_MIN_MINUTES_OR_NO_RATE'] };
  }
  const pr = production(p);
  const offRaw = (100 * pr.off) / on - ctx.avg_off, defRaw = (100 * pr.def) / on - ctx.avg_def;
  const w = min / (min + val(PV.shrink_minutes));
  const off = w * offRaw + (1 - w) * rep.off, def = w * defRaw + (1 - w) * rep.def;
  return { off, def, value: off + def, minutes: min, rate_ok: true, shrink_w: w, usage: num(p.usage), blk_rate: (100 * (num(p.blocks) || 0)) / on, orb_pct: num(p.orb_pct), flags: [] };
}

/** a newcomer's value at his new school: last season's value x the registered
    factor for the level he came from; with no record, a replacement prior */
function translate(move, v, ctx, cfg) {
  const T = cfg.transfer_translation;
  const flags = [];
  if (move.kind === 'FRESHMAN') {
    const s = move.stars != null && cfg.freshmen.value_by_stars[String(move.stars)] != null ? String(move.stars) : 'unrated';
    const total = cfg.freshmen.value_by_stars[s];
    /* the registered value is a total; it is split off/def in the registered replacement-level ratio */
    const rep = cfg.player_value.replacement_level, k = rep.off / (rep.off + rep.def);
    return { off: total * k, def: total * (1 - k), value: total, sd_mult: cfg.freshmen.sd_inflation, basis: 'freshman_stars_' + s, flags };
  }
  if (move.kind === 'TRANSFER_D1' && v && v.rate_ok) {
    let f = 1;
    const src = ctx.confStrength && move.from_conference_id != null ? ctx.confStrength.get(move.from_conference_id) : null;
    const dst = ctx.confStrength && move.to_conference_id != null ? ctx.confStrength.get(move.to_conference_id) : null;
    if (src && dst) f = 1 + val(T.d1_to_d1.w) * (src.strength / dst.strength - 1);
    else flags.push('NO_CONFERENCE_STRENGTH');
    let fo = f;
    const U = v.usage;
    if (U != null && U >= 25 && src && dst && dst.strength > src.strength) fo *= 0.9;
    else if (U != null && U <= 15) fo *= 1.05;
    return { off: v.off * fo, def: v.def * f, value: v.off * fo + v.def * f, sd_mult: 1, factor_off: fo, factor_def: f, basis: 'd1_to_d1', flags };
  }
  if (move.kind === 'TRANSFER_PORTAL' && move.from_level && move.from_level !== 'D1') {
    /* CBBD carries no statistics below Division I: the registered level
       factors have no value to multiply, so the prior is replacement level
       with the level's registered uncertainty */
    const L = T.fixed_level_factors[move.from_level] || T.fixed_level_factors.NON_D1_UNCLASSIFIED;
    const rep = cfg.player_value.replacement_level;
    return { off: rep.off, def: rep.def, value: rep.off + rep.def, sd_mult: L.sd_inflation, basis: 'level_' + move.from_level + '_no_source_stats', flags: ['NO_SOURCE_STATS'] };
  }
  const rep = cfg.player_value.replacement_level;
  return { off: rep.off, def: rep.def, value: rep.off + rep.def, sd_mult: NO_STATS_SD, basis: 'unknown', flags: ['UNKNOWN'] };
}

/* config transfer_translation.no_usable_stats: "replacement level, sd_inflation 3.0" */
const NO_STATS_SD = 3.0;
/* the share of a 40-minute game each player is expected to play (config expected_minutes) */
const PRIOR_SHARE = { 5: 0.55, 4: 0.40, 3: 0.20, unrated: 0.10 };
function expectedMinutes(entries) {
  const cap = 0.85;
  const m = entries.map((e) => Math.max(0, Math.min(cap, e.base)));
  for (let it = 0; it < 50; it++) {
    const free = m.map((x, i) => (x < cap - 1e-12 ? i : -1)).filter((i) => i >= 0);
    const tot = m.reduce((a, b) => a + b, 0);
    if (Math.abs(tot - 5) < 1e-9 || !free.length) break;
    const freeSum = free.reduce((a, i) => a + m[i], 0);
    if (!(freeSum > 0)) break;
    const scale = (5 - (tot - freeSum)) / freeSum;
    for (const i of free) m[i] = Math.min(cap, m[i] * scale);
  }
  return m;
}

/** the preseason feature row of one team. inputs:
      moves, departed       moves.derive() rows of this season
      prevPlayers           every D-I player season of S-1 (for values and context)
      rosters               this season's roster rows (heights)
      ctx                   leagueContext(prevPlayers) + confStrength (Map) + prevRating (Map cbbd id -> rating)
      coach                 manual.coachFacts() or null
      coachTempo            mean tempo residual of the coach's earlier head-coaching seasons, or null */
function teamFeatures(teamId, season, inputs, cfg) {
  const flags = new Set();
  const prevBy = new Map(inputs.prevPlayers.map((p) => [p.athlete_id + ':' + p.team_id, p]));
  const heights = new Map((inputs.rosters || []).filter((r) => r.team_id === teamId).map((r) => [r.player_id, r.height_in]));
  const mine = inputs.moves.filter((m) => m.season === season && m.to_team_id === teamId);
  if (!mine.length) return null;
  const players = mine.map((m) => {
    const prev = m.from_team_id != null ? prevBy.get(m.player_id + ':' + m.from_team_id) : null;
    const v = prev ? playerValue(prev, inputs.ctx, cfg) : null;
    let t, base, cls;
    if (m.kind === 'RETURNING' && v) { t = { off: v.off, def: v.def, value: v.value, sd_mult: v.rate_ok ? 1 : NO_STATS_SD, basis: 'returning', flags: v.flags }; cls = 'returning'; }
    else { t = translate(m, v, inputs.ctx, cfg); cls = m.kind === 'FRESHMAN' ? 'freshman' : m.kind === 'TRANSFER_D1' ? 'transfer_d1' : m.kind === 'TRANSFER_PORTAL' && m.from_level && m.from_level !== 'D1' ? 'non_d1' : 'unknown'; }
    if (prev && num(prev.games) > 0) base = (num(prev.minutes) || 0) / num(prev.games) / 40;
    else base = PRIOR_SHARE[m.stars != null && PRIOR_SHARE[m.stars] != null ? m.stars : 'unrated'];
    (t.flags || []).forEach((f) => flags.add(f));
    return { player_id: m.player_id, name: m.name, kind: m.kind, cls, from_level: m.from_level, off: t.off, def: t.def, value: t.value, sd_mult: t.sd_mult, basis: t.basis,
      base, height_in: heights.get(m.player_id) == null ? null : heights.get(m.player_id), blk_rate: v && v.rate_ok ? v.blk_rate : null, orb_pct: v && v.rate_ok ? v.orb_pct : null,
      prev_minutes_share: m.prev_minutes_share, prev_points: m.prev_points,
      /* how far the translation moved a D-I transfer from his own value (the angle tag reads it) */
      translation_shift: m.kind === 'TRANSFER_D1' && v && v.rate_ok ? t.value - v.value : null };
  });
  const m = expectedMinutes(players.map((p) => ({ base: p.base })));
  players.forEach((p, i) => { p.exp_min_frac = round(m[i], 4); });
  const tot = m.reduce((a, b) => a + b, 0);
  if (tot < 5 - 1e-6) flags.add('ROSTER_CANNOT_FILL_200_MINUTES');
  const share = (pred) => players.reduce((a, p) => a + (pred(p) ? p.exp_min_frac : 0), 0) / (tot || 1);
  const wavg = (key) => { let s = 0, w = 0; for (const p of players) if (p[key] != null) { s += p[key] * p.exp_min_frac; w += p.exp_min_frac; } return w > 0 ? s / w : null; };

  /* returning production, from last season's team (minutes and value) */
  const prevTeam = inputs.prevPlayers.filter((p) => p.team_id === teamId);
  let retMin = null, retVal = null;
  if (prevTeam.length) {
    const back = new Set(players.filter((p) => p.kind === 'RETURNING').map((p) => p.player_id));
    const minTot = prevTeam.reduce((a, p) => a + (num(p.minutes) || 0), 0);
    const prodOf = (p) => { const pr = production(p); return Math.max(0, pr.off + pr.def); };
    const prodTot = prevTeam.reduce((a, p) => a + prodOf(p), 0);
    retMin = minTot > 0 ? prevTeam.filter((p) => back.has(p.athlete_id)).reduce((a, p) => a + (num(p.minutes) || 0), 0) / minTot : null;
    retVal = prodTot > 0 ? prevTeam.filter((p) => back.has(p.athlete_id)).reduce((a, p) => a + prodOf(p), 0) / prodTot : null;
  } else flags.add('NO_PRIOR_SEASON_TEAM');

  /* departed production */
  const gone = (inputs.departed || []).filter((d) => d.season === season && d.from_team_id === teamId);
  const goneVal = gone.map((d) => {
    const p = prevBy.get(d.player_id + ':' + teamId); const v = p ? playerValue(p, inputs.ctx, cfg) : null;
    const frac = p && num(p.games) > 0 ? (num(p.minutes) || 0) / num(p.games) / 40 : 0;
    return { player_id: d.player_id, name: d.name, destination: d.destination, to_team_id: d.to_team_id, prev_minutes_share: d.prev_minutes_share, prev_points: d.prev_points, value: v ? round(v.value, 2) : null, team_value_lost: v ? v.value * frac : 0 };
  }).sort((a, b) => (b.prev_minutes_share || 0) - (a.prev_minutes_share || 0));

  /* the roster rating (per 100 team possessions vs D-I average) */
  const rosterOff = players.reduce((a, p) => a + p.off * p.exp_min_frac, 0);
  const rosterDef = players.reduce((a, p) => a + p.def * p.exp_min_frac, 0);

  /* coaching */
  const coach = inputs.coach || null;
  if (!coach) flags.add('COACH_UNKNOWN');

  /* the registered variance multiplier (config variance.a) */
  const A = cfg.variance.a;
  const shares = { unknown: share((p) => p.cls === 'unknown'), non_d1: share((p) => p.cls === 'non_d1'), freshman: share((p) => p.cls === 'freshman'), transfer_d1: share((p) => p.cls === 'transfer_d1'), returning: share((p) => p.cls === 'returning') };
  const varMult = 1 + A.a1 * shares.unknown + A.a2 * shares.non_d1 + A.a3 * shares.freshman + A.a4 * (coach && coach.coach_change ? 1 : 0) + A.a5 * (1 - (retMin == null ? 0 : retMin));
  const prevR = inputs.ctx.prevRating ? inputs.ctx.prevRating.get(teamId) : null;
  if (!prevR) flags.add('NO_PRIOR_SEASON_RATING');

  const transShift = players.reduce((a, p) => a + (p.translation_shift == null ? 0 : p.translation_shift * p.exp_min_frac), 0);
  return {
    season, team_id: teamId, as_of_key: 'PRESEASON', config_version: cfg.config_version, config_sha256: cfg._sha256,
    roster_off: round(rosterOff, 3), roster_def: round(rosterDef, 3), roster_net: round(rosterOff + rosterDef, 3),
    prev_off: prevR ? round(prevR.off, 3) : null, prev_allow: prevR ? round(prevR.allow, 3) : null, prev_net: prevR ? round(prevR.net, 3) : null, prev_tempo: prevR && prevR.tempo != null ? round(prevR.tempo, 3) : null,
    returning_minutes_share: round(retMin, 4), returning_value_share: round(retVal, 4),
    minutes_share_returning: round(shares.returning, 4), minutes_share_transfer_d1: round(shares.transfer_d1, 4), minutes_share_non_d1: round(shares.non_d1, 4),
    minutes_share_freshman: round(shares.freshman, 4), minutes_share_unknown: round(shares.unknown, 4),
    departed_minutes_share: round(gone.reduce((a, d) => a + (d.prev_minutes_share || 0), 0), 4), departed_points: gone.reduce((a, d) => a + (d.prev_points || 0), 0),
    departed_value_lost: round(goneVal.reduce((a, d) => a + d.team_value_lost, 0), 3),
    coach_change: coach ? coach.coach_change : null, coach_tenure_years: coach ? coach.tenure_years : null, coach_prior_level: coach ? coach.prior_level : null,
    coach_tempo_resid: inputs.coachTempo == null ? null : round(inputs.coachTempo, 3),
    height_in_avg: round(wavg('height_in'), 2), blk_rate: round(wavg('blk_rate'), 3), orb_pct: round(wavg('orb_pct'), 3),
    player_uncertainty: round(wavg('sd_mult'), 3), variance_multiplier: round(varMult, 4),
    translation_shift: round(transShift, 3),
    flags: [...flags].sort(),
    detail: { players: players.map((p) => ({ player_id: p.player_id, name: p.name, kind: p.kind, from_level: p.from_level || null, basis: p.basis, off: round(p.off, 2), def: round(p.def, 2), exp_min_frac: p.exp_min_frac, sd_mult: p.sd_mult })),
      departed: goneVal.slice(0, 8).map((d) => ({ player_id: d.player_id, name: d.name, destination: d.destination, to_team_id: d.to_team_id, prev_minutes_share: d.prev_minutes_share, prev_points: d.prev_points, value: d.value })) },
  };
}

/** a coach's tempo signature: the mean tempo residual of his earlier
    head-coaching seasons (career rows with a CBBD team id); tempoOf(teamId,
    season) returns a rating's tempo or null */
function coachTempo(career, season, tempoOf) {
  let s = 0, n = 0;
  for (const c of career || []) {
    if (c.role !== 'HEAD' || c.team_id == null) continue;
    const to = c.to_season == null ? season - 1 : Math.min(c.to_season, season - 1);
    for (let y = c.from_season; y <= to; y++) { const t = tempoOf(c.team_id, y); if (t != null) { s += t; n++; } }
  }
  return n ? s / n : null;
}

/** the continuity gap of a game: the difference in returning-minutes and
    returning-value shares; null when either team's share is unknown */
function continuityGap(a, b) {
  const d = (k) => (a && b && a[k] != null && b[k] != null ? round(Math.abs(a[k] - b[k]), 4) : null);
  return { minutes: d('returning_minutes_share'), value: d('returning_value_share') };
}

/** the roster rating with ruled-out players removed and minutes re-spread */
function applyAvailability(row, outIds) {
  const out = new Set(outIds || []);
  const ps = row.detail.players.filter((p) => !out.has(p.player_id));
  const m = expectedMinutes(ps.map((p) => ({ base: p.exp_min_frac })));
  const off = ps.reduce((a, p, i) => a + p.off * m[i], 0), def = ps.reduce((a, p, i) => a + p.def * m[i], 0);
  return { roster_off: round(off, 3), roster_def: round(def, 3), roster_net: round(off + def, 3), removed: row.detail.players.length - ps.length };
}

/** venue facts EdgeDesk owns: home / away / neutral. Travel distance and time
    zones need venue coordinates, which no owned source carries (CBBD /venues
    has city, state, country only): null, with the reason */
function venue(game) {
  return { site: game.neutral ? 'NEUTRAL' : 'HOME_AWAY', home_team_id: game.home_team_id, away_team_id: game.away_team_id,
    travel_km: null, time_zones_crossed: null, overseas: null, travel_reason: 'NOT_OWNED: no venue coordinates in any owned source' };
}

module.exports = { loadConfig, production, leagueContext, playerValue, translate, expectedMinutes, teamFeatures, coachTempo, continuityGap, applyAvailability, venue, CONFIG_FILE };
