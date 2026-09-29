/* ===========================================================================
   EdgeDesk player props — LIVE SCORING (Phases E-G for upcoming games).

   upcoming game → candidate players (recent role, not ruled out) → point-in-
   time features AS OF NOW → the production model's distribution (widened
   for what is not yet known) → every observed quote priced against that one
   distribution → market view, movement, alternate ladders, line shopping,
   confidence, data quality, decision label, drivers, plain-English why.

   The model never sees a price. The quotes enter only after the
   distribution is fixed, which is what lets MODEL, MARKET and EDGE stay
   three separate things all the way to the page.
   =========================================================================== */
'use strict';
const path = require('path');
const crypto = require('crypto');
const EDP = require('../../lib/player_props.js');
const io = require('./lib/io.js');
const F = require('./features.js');
const M = require('./model.js');
const identity = require('./identity.js');
const cfbSrc = require('./sources/cfb.js');

const SCORE_VERSION = 'props_score_v1';
const ROOT = io.ROOT;
function isNum(x) { return typeof x === 'number' && isFinite(x); }
function r(x, d) { return isNum(x) ? Math.round(x * Math.pow(10, d == null ? 3 : d)) / Math.pow(10, d == null ? 3 : d) : null; }
function sha(x) { return crypto.createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex'); }

/* ------------------------------------------------------------ live context */
function liveContext(league, season) {
  const ctx = { injuries: new Map(), starters: new Map(), availability: new Map(), forecasts: new Map(), sources: [] };
  if (league === 'NFL') {
    const inj = io.readJson(path.join(ROOT, 'football', 'injuries', 'nfl_' + season + '.json'));
    if (inj && inj.teams) {
      Object.keys(inj.teams).forEach((code) => (inj.teams[code].players || []).forEach((p) => { if (p.gsis_id) ctx.injuries.set(p.gsis_id, { status: p.status, injury: p.injury, team: code, name: p.name, position: p.position, week: inj.teams[code].week }); }));
      ctx.sources.push({ source: 'football/injuries/nfl_' + season + '.json', as_of: inj.retrieved_at || inj.published || null });
    }
    const st = io.readJson(path.join(ROOT, 'football', 'starters', 'nfl_' + season + '.json'));
    if (st && st.teams) { Object.keys(st.teams).forEach((k) => { const t = st.teams[k]; ctx.starters.set(String(t.team || k).toUpperCase(), t); }); ctx.sources.push({ source: 'football/starters/nfl_' + season + '.json', as_of: st.generated_at || null }); }
    const slate = io.readJson(path.join(ROOT, 'football', 'nfl', 'slate.json'));
    if (slate && slate.games) { slate.games.forEach((g) => { if (g.forecast) ctx.forecasts.set(g.game_id, g.forecast); }); ctx.sources.push({ source: 'football/nfl/slate.json (forecast)', as_of: slate.generated_at || null }); }
  } else {
    const st = io.readJson(path.join(ROOT, 'football', 'starters', 'cfb_' + season + '.json'));
    const keyToId = new Map(Array.from(cfbSrc.TEAM.values()).map((t) => [t.key, String(t.espn_team_id)]));
    if (st && st.teams) { Object.keys(st.teams).forEach((k) => { const id = keyToId.get(k); if (id) ctx.starters.set(id, st.teams[k]); }); ctx.sources.push({ source: 'football/starters/cfb_' + season + '.json', as_of: st.generated_at || null }); }
    const av = io.readJson(path.join(ROOT, 'football', 'availability', 'current.json'));
    if (av && av.teams) { Object.keys(av.teams).forEach((tid) => ctx.availability.set(String(tid), av.teams[tid])); ctx.sources.push({ source: 'football/availability/current.json', as_of: av.generated_at || null }); }
    const fc = io.readJson(path.join(ROOT, 'football', 'venues', 'forecasts.json'));
    if (fc && fc.by_game) { Object.keys(fc.by_game).forEach((gid) => ctx.forecasts.set(gid, fc.by_game[gid])); ctx.sources.push({ source: 'football/venues/forecasts.json', as_of: fc.generated_at || null }); }
  }
  return ctx;
}
/* a CFB availability record, resolved to a player by name WITHIN one team's
   recent players (team-scoped, never a global name match) */
function cfbStatusFor(ctx, teamId, name) {
  const t = ctx.availability.get(String(teamId));
  if (!t || !t.players) return null;
  const k = identity.normName(name);
  const hit = t.players.find((p) => identity.normName(p.player_name) === k);
  return hit ? { status: hit.availability_status, practice: hit.practice_status || null, confidence: hit.confidence || null } : null;
}
const OUT_RE = /^(out|ir|injured reserve|suspended|pup|nfi|doubtful|inactive)/i;
const Q_RE = /^(questionable|game[- ]time|probable|limited|day[- ]to[- ]day)/i;
const NONE_RE = /^(available|active|healthy|full)/i;
/* the positions whose absence vacates targets, carries or snaps a prop depends on */
const SKILL_RE = /^(QB|RB|FB|HB|WR|TE)$/i;

/* ------------------------------------------------------------ candidates
   A player is a candidate for a team's upcoming game when he played for that
   team in two of its last three games (or its last game, early season) with a
   real opportunity, and is not ruled out. The quarterback markets go to the
   expected starter only. */
/* a role, not a roster: past the starter, the most-used backs, receivers
   and tight ends by recent opportunity (the players books list props for),
   plus anyone a book has actually quoted for this game */
const ROLE_CAP = { QB: 1, RB: 3, WR: 5, TE: 2 };
const MIN_OPP_PER_GAME = 2;
function candidates(eng, league, team, byTeam, startingQb, quoted) {
  const th = eng.teamHistory(team);
  const recent = th.slice(-3).map((e) => e.kickoff);
  if (!recent.length) return [];
  const out = [];
  (byTeam.get(team) || []).forEach((pid) => {
    const h = eng.history(pid);
    if (!h.length) return;
    const last = h[h.length - 1];
    if (last.team_id !== team || recent.indexOf(last.kickoff) < 0) return;
    const inWindow = h.filter((e) => e.team_id === team && recent.indexOf(e.kickoff) >= 0);
    const opp = inWindow.reduce((a, e) => a + (e.s.targets || 0) + (e.s.carries || 0) + (e.s.attempts || 0) + (league === 'CFB' ? (e.s.receptions || 0) : 0), 0);
    if (inWindow.length < Math.min(2, recent.length) || opp < inWindow.length) return;
    const c = { pid, pg: last.pg, games: inWindow.length, opp_per_game: opp / inWindow.length };
    if (c.pg === 'QB') {
      /* quarterback markets go to the expected starter; without a starter file,
         to the incumbent (the most recent game's passer with 10+ attempts) */
      if (startingQb) { if (startingQb !== pid) return; }
      else if (!(last.s.attempts >= 10)) return;
      c.qb_basis = startingQb ? 'starter file' : 'incumbent (no starter file)';
    }
    out.push(c);
  });
  const keep = [];
  ['QB', 'RB', 'WR', 'TE'].forEach((pg) => {
    out.filter((c) => c.pg === pg).sort((a, b) => b.opp_per_game - a.opp_per_game || (a.pid < b.pid ? -1 : 1)).forEach((c, i) => {
      const listed = quoted && quoted.has(c.pid);
      if (listed || (i < ROLE_CAP[pg] && (pg === 'QB' || c.opp_per_game >= MIN_OPP_PER_GAME))) { if (listed) c.quoted = true; keep.push(c); }
    });
  });
  return keep;
}
/* team -> players whose latest game was for that team (built once per league) */
function teamIndex(eng, pids) {
  const m = new Map();
  pids.forEach((pid) => { const h = eng.history(pid); if (!h.length) return; const t = h[h.length - 1].team_id; let a = m.get(t); if (!a) { a = []; m.set(t, a); } a.push(pid); });
  return m;
}

/* ------------------------------------------------------------ driver text */
const LABEL = {
  team_implied_points: 'team implied points', game_total: 'game total', team_spread: 'team spread', target_share_l5: 'target share (last 5)', target_share_l3: 'target share (last 3)',
  air_yard_share_l5: 'air-yard share (last 5)', rush_share_l5: 'rush share (last 5)', rush_share_l3: 'rush share (last 3)', snap_share_l5: 'snap share (last 5)',
  teammate_target_vacated_share: 'targets vacated by inactive teammates', teammate_rush_vacated_share: 'carries vacated by inactive teammates',
  teammate_air_yards_vacated_share: 'air yards vacated by inactive teammates', opp_pass_yards_allowed_per_att_l8: 'opponent yards per pass allowed',
  opp_rush_yards_allowed_per_carry_l8: 'opponent yards per carry allowed', opp_rec_yards_allowed_wr_l8: 'opponent receiving yards allowed to WRs',
  opp_rec_yards_allowed_te_l8: 'opponent receiving yards allowed to TEs', opp_rec_yards_allowed_rb_l8: 'opponent receiving yards allowed to RBs',
  opp_pressure_rate_l8: 'opponent pressure rate', opp_epa_per_dropback_allowed_l8: 'opponent EPA per dropback allowed', weather_wind_mph: 'wind', qb_change: 'quarterback change',
  yards_per_target_l8: 'yards per target (last 8, shrunk)', yards_per_carry_l8: 'yards per carry (last 8, shrunk)', yards_per_attempt_l8: 'yards per attempt (last 8, shrunk)',
  catch_rate_l8: 'catch rate (last 8, shrunk)', epa_per_dropback_l8: 'EPA per dropback (last 8)', proe_l5: 'team pass rate over expectation', neutral_pass_rate_l5: 'neutral pass rate',
  pace_seconds_per_play_l5: 'team pace (sec/play)', team_plays_l5: 'team plays per game', rookie_flag: 'rookie', draft_capital_log: 'draft capital', rest_days: 'rest days', home_flag: 'home field'
};
function driverLabel(n) {
  if (LABEL[n]) return LABEL[n];
  const m = /^(.*)_(eb|avg_l3|avg_l5|avg_l8|season_avg|prev_season_avg)$/.exec(n);
  if (m) return m[1].replace(/_/g, ' ') + ' ' + ({ eb: '(weighted form)', avg_l3: '(last 3)', avg_l5: '(last 5)', avg_l8: '(last 8)', season_avg: '(season)', prev_season_avg: '(last season)' })[m[2]];
  return n.replace(/_/g, ' ');
}
function drivers(model, frow, n) {
  return M.contributions(model, frow).slice(0, n || 5).map((c) => {
    const pct = (Math.exp(c.effect) - 1) * 100;
    const d = { feature: c.feature, label: driverLabel(c.feature), value: r(c.value, 3), effect: r(c.effect, 4), pct: r(pct, 1) };
    d.text = EDP.wire.driverText(d);
    return d;
  });
}

/* ------------------------------------------------------------ context blocks */
function formBlock(f, stats) {
  const out = {};
  stats.forEach((s) => { out[s] = { l3: r(f[F.IDX.get(s + '_avg_l3')], 2), l5: r(f[F.IDX.get(s + '_avg_l5')], 2), l8: r(f[F.IDX.get(s + '_avg_l8')], 2), season: r(f[F.IDX.get(s + '_season_avg')], 2), weighted: r(f[F.IDX.get(s + '_eb')], 2) }; });
  return out;
}
function pick(f, names) { const o = {}; names.forEach((n) => { const v = f[F.IDX.get(n)]; o[n] = isFinite(v) ? r(v, 4) : null; }); return o; }
const FORM_STATS = { QB: ['passing_yards', 'attempts', 'completions', 'passing_tds', 'interceptions', 'rushing_yards', 'carries'], RB: ['rushing_yards', 'carries', 'receptions', 'receiving_yards', 'targets', 'tds'],
  WR: ['receiving_yards', 'receptions', 'targets', 'receiving_tds', 'longest_reception'], TE: ['receiving_yards', 'receptions', 'targets', 'receiving_tds', 'longest_reception'] };

/* ------------------------------------------------------------ scoring */
/* sigma on the mean for what is not yet known at scoring time */
function uncertaintyFor(c) {
  let s = 0; const why = [];
  if (c.injury && Q_RE.test(c.injury.status || '')) { s += 0.12; why.push('listed ' + c.injury.status); }
  if (c.qb_uncertain) { s += 0.08; why.push('starting quarterback not confirmed'); }
  if (c.games < 2) { s += 0.10; why.push('fewer than two recent games in this role'); }
  if (c.rookie) { s += 0.05; why.push('rookie'); }
  return { sigma: Math.min(0.35, s), why };
}

function predictionId(p) { return 'pp_' + sha([p.game_id, p.player_id, p.market_key, p.asof_at, p.model_version]).slice(0, 28); }

/* score one league. models: {byKey:{'<PG>|<market>': model}}; quotes:
   observed quotes for the league (normalised: game_id, player_id, market_key,
   sportsbook, side, line, american_price, snapshot_at, is_main_line, lineage). */
function scoreLeague(wh, league, models, opts) {
  opts = opts || {};
  const now = opts.now || Date.now();
  const nowIso = new Date(now).toISOString();
  const season = opts.season || io.currentSeason(now);
  const windowMs = (opts.windowH || 192) * 3600e3;
  const hist = F.buildHistorical(wh, league, { minSeason: Infinity });
  const eng = hist.engine;
  eng.advance(now);
  const L = wh.leagues[league];
  const playersById = new Map(wh.identity.players.map((p) => [p.player_id, p]));
  const allPids = new Set(L.playerGames.filter((x) => x.season >= season - 1).map((x) => x.player_id).filter(Boolean));
  const byTeam = teamIndex(eng, allPids);
  const ctx = liveContext(league, season);
  const nflRes = identity.resolver(wh.identity.idMap);
  const upcoming = L.games.filter((g) => g.status === 'scheduled' && Date.parse(g.kickoff_utc) > now && Date.parse(g.kickoff_utc) - now <= windowMs)
    .filter((g) => league !== 'CFB' || g.home_division === 'fbs' || g.away_division === 'fbs')
    .sort((a, b) => Date.parse(a.kickoff_utc) - Date.parse(b.kickoff_utc));
  const quotesBy = new Map(), listingsBy = new Map();
  (opts.quotes || []).forEach((q) => { if (q.lineage !== 'observed') return; const k = q.game_id + '|' + q.player_id + '|' + q.market_key; let a = quotesBy.get(k); if (!a) { a = []; quotesBy.set(k, a); } a.push(q); });
  (opts.listings || []).forEach((l) => { const k = l.game_id + '|' + l.player_id + '|' + l.market_key; let a = listingsBy.get(k); if (!a) { a = []; listingsBy.set(k, a); } a.push(l); });
  const quotedPids = new Map();
  quotesBy.forEach((qs, k) => { const gid = k.split('|')[0]; let st = quotedPids.get(gid); if (!st) { st = new Set(); quotedPids.set(gid, st); } st.add(qs[0].player_id); });
  const tiers = opts.tiers || {};
  const predictions = [], props = [], games = [];
  upcoming.forEach((g) => {
    const gameOut = { game_id: g.game_id, kickoff_utc: g.kickoff_utc, home: g.home_team_id, away: g.away_team_id, home_name: g.home_team_name || g.home_team_id,
      away_name: g.away_team_name || g.away_team_id, neutral_site: !!g.neutral_site, venue: g.venue_name || null, roof: g.roof || null, market_context: g.market || null,
      forecast: ctx.forecasts.get(g.game_id) || null, n_props: 0 };
    /* absences known now */
    const absences = [];
    if (league === 'NFL') ctx.injuries.forEach((v, gsis) => { if (OUT_RE.test(v.status || '') && (v.team === g.home_team_id || v.team === g.away_team_id)) absences.push({ player_id: nflRes.nfl(gsis), team_id: v.team, status: v.status, name: v.name, position: v.position || null }); });
    [g.home_team_id, g.away_team_id].forEach((team) => {
      const opp = team === g.home_team_id ? g.away_team_id : g.home_team_id;
      if (league === 'CFB' && (team === g.home_team_id ? g.home_division : g.away_division) !== 'fbs') return;
      const st = league === 'NFL' ? ctx.starters.get(team) : ctx.starters.get(String(team));
      const startingQb = st && st.player_id ? (league === 'NFL' ? nflRes.nfl(st.player_id) : 'espn:' + st.player_id) : null;
      const qbUncertain = !st || !/ANNOUNCED|CONFIRMED|EXPECTED|DEPTH_CHART|PREVIOUS_GAME/.test(String(st.status || '')) || st.status === 'COMPETITION' || st.status === 'UNKNOWN';
      const cands = candidates(eng, league, team, byTeam, startingQb, quotedPids.get(g.game_id));
      /* CFB absences: a regular listed OUT on the team's availability report */
      if (league === 'CFB') cands.forEach((c) => { const p = playersById.get(c.pid); const s = p ? cfbStatusFor(ctx, team, p.full_name) : null; if (s && OUT_RE.test(s.status || '')) absences.push({ player_id: c.pid, team_id: team, status: s.status, name: p.full_name, position: c.pg }); });
      cands.forEach((c) => {
        const p = playersById.get(c.pid) || { player_id: c.pid, full_name: c.pid };
        /* a report row with no game designation (practice-only, AVAILABLE) is not an injury */
        const listed = league === 'NFL' ? (p.nfl_gsis_id ? ctx.injuries.get(p.nfl_gsis_id) : null) : cfbStatusFor(ctx, team, p.full_name);
        const injury = listed && listed.status && !NONE_RE.test(listed.status) ? listed : null;
        if (injury && OUT_RE.test(injury.status || '')) return;                     /* ruled out: no prop is priced */
        const pg = c.pg;
        const fc = ctx.forecasts.get(g.game_id);
        /* a forecast is quantised (wind 2.5 mph, temperature 5 °F, precipitation
           0.2) — far finer than a multi-day forecast's own error — so an hourly
           forecast wobble does not re-mint every prediction in the game */
        const q = (x, step) => (isNum(x) ? Math.round(x / step) * step : null);
        const weather = fc ? { temp_f: q(fc.temp_f, 5), wind_mph: q(fc.wind_mph, 2.5), precip_prob: isNum(fc.precip_pct) ? q(fc.precip_pct / 100, 0.2) : null } : null;
        const row = eng.row({ game: g, player_id: c.pid, team_id: team, opponent_id: opp, position_group: pg, asof: now, absences, starting_qb: startingQb, player: p, weather });
        if (!eng.assertPit(row)) return;                                            /* Q008: never scored */
        const unc = uncertaintyFor({ injury, qb_uncertain: qbUncertain && (pg === 'QB' || pg === 'WR' || pg === 'TE'), games: c.games, rookie: isNum(p.nfl_first_season) && p.nfl_first_season === season });
        M.marketsFor(league, pg).forEach((market) => {
          const model = models.byKey[pg + '|' + market];
          if (!model) return;
          const pr = M.predictDist(model, row.f, { sigmaMu: unc.sigma, recalibrate: model.use_recalibration !== false });
          /* the published precision is the precision every consumer prices with */
          pr.dist = EDP.wire.roundDist(pr.dist);
          const sum = EDP.dist.summary(pr.dist);
          if (!sum) return;
          const pred = { prediction_id: null, game_id: g.game_id, player_id: c.pid, market_key: market, league, asof_at: nowIso, scored_at: nowIso,
            model_name: model.model_name, model_version: model.model_version, feature_version: model.feature_version, training_cutoff: model.training.cutoff,
            projected_mean: sum.mean, projected_median: sum.median, projected_p10: sum.p10, projected_p25: sum.p25, projected_p75: sum.p75, projected_p90: sum.p90, projected_sd: sum.sd,
            uncertainty: r(isNum(sum.mean) && sum.mean > 0.05 ? (sum.p90 - sum.p10) / Math.max(sum.mean, 1) : (sum.p90 - sum.p10), 4), sigma_mu: r(unc.sigma, 3),
            dist: pr.dist, source_max_timestamp: row.source_max_ms ? new Date(row.source_max_ms).toISOString() : null, imputed: M.imputedOf(model, row.f),
            feature_completeness: r(M.completeness(model, row.f), 4) };
          pred.prediction_id = predictionId(pred);
          predictions.push(pred);
          props.push(buildProp({ league, g, team, opp, p, pg, market, model, row, pred, sum, injury, unc, qbUncertain, startingQb, absences, quotes: quotesBy.get(g.game_id + '|' + c.pid + '|' + market) || [], listings: listingsBy.get(g.game_id + '|' + c.pid + '|' + market) || [],
            now, tier: tiers[pg + '|' + market] || { outcome_tier: 'RESEARCH', market_tier: 'RESEARCH' } }));
          gameOut.n_props++;
        });
      });
    });
    games.push(gameOut);
  });
  return { league, generated_at: nowIso, season, games, props, predictions, sources: ctx.sources, version: SCORE_VERSION };
}

/* ------------------------------------------------------------ one prop */
function buildProp(a) {
  const { league, g, team, opp, p, pg, market, model, row, pred, sum, injury, unc, qbUncertain, startingQb, absences, quotes, listings, now, tier } = a;
  const f = row.f;
  const d = pred.dist;
  const drv = drivers(model, f, 5);
  const availability = { status: injury && injury.status ? injury.status : 'no designation on file', starting_qb: startingQb, qb_confirmed: !qbUncertain,
    teammates_out: absences.filter((x) => x.team_id === team && x.player_id !== p.player_id && (!x.position || SKILL_RE.test(x.position))).map((x) => ({ name: x.name, status: x.status, position: x.position || null })),
    vacated: pick(f, ['teammate_target_vacated_share', 'teammate_rush_vacated_share', 'teammate_air_yards_vacated_share', 'teammate_rz_vacated_share']),
    widened_for: unc.why };
  /* the market-independent confidence components; the market ones are filled by repriceProp */
  const base = EDP.confidence({
    sample_size: EDP.sampleCertainty(f[F.IDX.get('games_l8')]),
    model_calibration: tier.calibration_score != null ? tier.calibration_score : (tier.outcome_tier === 'OUTCOME_VALIDATED' ? 0.75 : tier.outcome_tier === 'OUTCOME_LEAN' ? 0.55 : 0.35),
    role_certainty: roleCertainty(f, pg), injury_certainty: injury ? (Q_RE.test(injury.status || '') ? 0.5 : 0.85) : 1,
    qb_certainty: pg === 'RB' ? null : (qbUncertain ? 0.5 : 1),
    model_agreement: agreement(f, market, sum),
    market_depth: null, book_dispersion: null,
    source_quality: Math.min(p.identity_confidence == null ? 1 : p.identity_confidence, 1),
    notes: { injury_certainty: injury ? 'listed ' + injury.status : null, qb_certainty: qbUncertain ? 'starter not confirmed' : null }
  });
  const prop = {
    id: g.game_id + '|' + p.player_id + '|' + market, league, game_id: g.game_id, kickoff_utc: g.kickoff_utc,
    matchup: (g.away_team_name || g.away_team_id) + ' @ ' + (g.home_team_name || g.home_team_id), team, opponent: opp, is_home: team === g.home_team_id,
    player_id: p.player_id, player: p.full_name, position: pg, headshot: p.headshot || null,
    market_key: market, market_label: EDP.marketLabel(market), family: d.t,
    model: { prediction_id: pred.prediction_id, model_version: model.model_version, feature_version: model.feature_version, training_cutoff: model.training.cutoff, scored_at: pred.scored_at,
      mean: sum.mean, median: sum.median, p10: sum.p10, p25: sum.p25, p75: sum.p75, p90: sum.p90, sd: sum.sd, uncertainty: pred.uncertainty,
      ref_line: null, over_prob: null, under_prob: null, fair_over: null, fair_under: null,
      outcome_tier: tier.outcome_tier, market_tier: tier.market_tier, recalibrated: !!model.pit_map && model.use_recalibration !== false, dist: d },
    market: null, movement: null, focus: null, ladders: null, n_quotes: 0,
    confidence: base, data_quality: null, decision: null, playable_to: null,
    context: {
      form: formBlock(f, FORM_STATS[pg] || []),
      usage: pick(f, ['snap_share_l3', 'snap_share_l5', 'target_share_l3', 'target_share_l5', 'air_yard_share_l5', 'rush_share_l3', 'rush_share_l5', 'reception_share_l5', 'rz_opportunity_share_l5', 'goal_line_opportunity_share_l5', 'designed_qb_rush_rate_l5', 'scramble_rate_l5', 'red_zone_touches_avg_l5']),
      efficiency: pick(f, ['yards_per_attempt_l8', 'epa_per_dropback_l8', 'cpoe_l8', 'yards_per_carry_l8', 'yards_per_target_l8', 'catch_rate_l8', 'explosive_rec_rate_l8', 'explosive_rush_rate_l8']),
      matchup: pick(f, ['opp_pass_yards_allowed_per_att_l8', 'opp_epa_per_dropback_allowed_l8', 'opp_explosive_pass_rate_allowed_l8', 'opp_pressure_rate_l8', 'opp_sack_rate_l8', 'opp_rush_yards_allowed_per_carry_l8', 'opp_rush_epa_allowed_l8', 'opp_explosive_rush_rate_allowed_l8', 'opp_target_rate_allowed_rb_l8', 'opp_target_rate_allowed_te_l8', 'opp_rec_yards_allowed_wr_l8', 'opp_rec_yards_allowed_te_l8', 'opp_rec_yards_allowed_rb_l8']),
      environment: Object.assign(pick(f, ['team_spread', 'game_total', 'team_implied_points', 'pace_seconds_per_play_l5', 'team_plays_l5', 'neutral_pass_rate_l5', 'proe_l5', 'weather_wind_mph', 'weather_temp_f', 'weather_precip_prob', 'roof_closed_flag', 'rest_days', 'home_flag']),
        { market_context_source: g.market ? g.market.source : null, market_context_basis: g.market ? g.market.basis : null }),
      availability,
      transition: pick(f, ['rookie_flag', 'years_experience', 'draft_capital_log', 'cfb_career_rec_ypg', 'cfb_final_rec_yards_share', 'cfb_career_rush_ypg', 'cfb_seasons'])
    },
    drivers: drv,
    imputed: pred.imputed.slice(0, 20),
    as_of: pred.asof_at, source_max_timestamp: pred.source_max_timestamp,
    _dq_inputs: { feature_completeness: pred.feature_completeness, identity_confidence: p.identity_confidence == null ? 1 : p.identity_confidence, source_quality: 1,
      availability_freshness: league === 'NFL' ? 0.9 : 0.6 },
    _invalidators: invalidators(availability, pg)
  };
  return repriceProp(prop, quotes, { listings, now });
}

/* THE MARKET HALF OF A PROP is the kernel's reprice() (lib/player_props.js):
   the page and the AI desk run the same function on the published card and
   quotes, so nothing here can drift from what a reader is shown. */
function repriceProp(prop, quotes, opts) { return EDP.reprice(prop, quotes, opts); }
function roleCertainty(f, pg) {
  const share = pg === 'QB' ? null : (pg === 'RB' ? f[F.IDX.get('rush_share_l5')] : f[F.IDX.get('target_share_l5')]);
  const l3 = pg === 'RB' ? f[F.IDX.get('rush_share_l3')] : f[F.IDX.get('target_share_l3')];
  const n = f[F.IDX.get('games_l8')];
  if (pg === 'QB') return isFinite(n) ? Math.min(1, 0.5 + n / 16) : 0.5;
  if (!isFinite(share) || !isFinite(l3)) return isFinite(n) ? Math.min(0.7, 0.3 + n / 20) : 0.3;
  /* a stable share is a certain role; a big swing between l3 and l5 is not */
  const swing = Math.abs(l3 - share) / Math.max(0.05, share);
  return Math.max(0.2, Math.min(1, 1 - swing));
}
/* agreement: the model's median against the player's own weighted form for the
   same stat (a second, simpler estimator) — far apart = lower agreement */
const FORM_OF = { pass_yards: 'passing_yards', pass_attempts: 'attempts', pass_completions: 'completions', pass_tds: 'passing_tds', pass_interceptions: 'interceptions', rush_yards: 'rushing_yards',
  rush_attempts: 'carries', receiving_yards: 'receiving_yards', receptions: 'receptions', targets: 'targets', rush_rec_yards: 'rush_rec_yards', pass_rush_yards: 'pass_rush_yards',
  receiving_tds: 'receiving_tds', rush_tds: 'rushing_tds', longest_reception: 'longest_reception', longest_rush: 'longest_rush', pass_longest_completion: 'longest_completion',
  pass_rush_rec_yards: 'pass_rush_rec_yards', receptions_rush_attempts: 'receptions_rush_attempts', anytime_td: 'tds' };
function agreement(f, market, sum) {
  const k = FORM_OF[market]; if (!k) return null;
  const eb = f[F.IDX.get(k + '_eb')];
  if (!isFinite(eb) || !isNum(sum.mean) || !isNum(sum.sd) || sum.sd <= 0) return null;
  return Math.max(0, Math.min(1, 1 - Math.abs(sum.mean - eb) / (1.5 * sum.sd)));
}
function invalidators(av, pg) {
  const out = [];
  (av.teammates_out || []).forEach((t) => out.push('If ' + t.name + ' (' + t.status + ') plays, the vacated opportunity in this projection disappears.'));
  if (!av.qb_confirmed && pg !== 'RB') out.push('A different starting quarterback than ' + (av.starting_qb ? 'the expected one' : 'assumed') + ' changes the passing volume and efficiency inputs.');
  if (/questionable/i.test(av.status || '')) out.push('The player is listed ' + av.status + ': a limited snap count would cut the projection.');
  return out;
}

module.exports = { scoreLeague, repriceProp, liveContext, candidates, teamIndex, uncertaintyFor, drivers, driverLabel, SCORE_VERSION, predictionId };
