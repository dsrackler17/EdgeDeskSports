#!/usr/bin/env node
'use strict';
/* ===========================================================================
   NCAAM-EARLY T2 features — unit suite. Synthetic players (no CBBD row is in
   the repository); the engine adapter runs on the committed hoopR/ESPN
   dataset (MIT) the NCAAM forecast already ships.

     config     the registered configuration is the one the registration pins
     values     D-I averages, the registered box formula, shrinkage, minimum
     translate  D-I to D-I by conference strength, usage, freshmen by stars,
                non-D-I with no source statistics, unknowns
     minutes    normalised to 200 a game, the 0.85 cap
     team       roster rating, returning / departed production, shares,
                variance multiplier, flags for what is missing
     helpers    coach tempo, continuity gap, availability, venue
     engine     real season-end ratings, crosswalk, conference strength
     ingest     the features part end to end on a cache, stored as derived rows
   =========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const FE = require('../features');
const RT = require('../ratings');
const C = require('../config');
const ING = require('../ingest');

let pass = 0, fail = 0; const fails = [];
const chk = (label, ok, detail) => { if (ok) pass++; else { fail++; fails.push(label + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 300) : '')); } };
const near = (a, b, e) => a != null && b != null && Math.abs(a - b) <= (e || 1e-9);

const cfg = FE.loadConfig();
const REG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'registration.json'), 'utf8'));
chk('config: the features read the configuration the registration pins (sha256)', cfg._sha256 === REG.spec.config_sha256);
chk('config: no number in features.js outside the registered configuration (the two literals are registered values)',
  (() => { const src = fs.readFileSync(path.join(__dirname, '..', 'features.js'), 'utf8'); return /NO_STATS_SD = 3\.0/.test(src) && /5: 0\.55, 4: 0\.40, 3: 0\.20, unrated: 0\.10/.test(src)
    && JSON.stringify(cfg.transfer_translation.no_usable_stats).includes('3.0') && /5: 0\.55, 4: 0\.40, 3: 0\.20, unrated 0\.10/.test(cfg.expected_minutes.rule); })());

/* ── a synthetic league: team 1 (two players), team 2 (two players) ───────── */
const P = (o) => Object.assign({ season: 2026, games: 30, minutes: 900, points: 300, assists: 60, orb: 30, drb: 90, steals: 30, blocks: 15, turnovers: 45, fouls: 60, fga: 250, fgm: 110, fta: 80, ftm: 60, usage: 20, orb_pct: 5 }, o);
const prev = [P({ team_id: 1, athlete_id: 10, name: 'Star A', minutes: 1000, points: 500, usage: 27 }), P({ team_id: 1, athlete_id: 11, name: 'Role B', minutes: 600, points: 120 }),
  P({ team_id: 2, athlete_id: 20, name: 'Mid C', minutes: 900 }), P({ team_id: 2, athlete_id: 21, name: 'Low D', minutes: 60, points: 10, games: 10 })];
const ctx = FE.leagueContext(prev, cfg);
{
  const t1 = ctx.teams.get(1);
  const poss = (p) => p.fga - p.orb + p.turnovers + 0.475 * p.fta;
  chk('context: team possessions are the sum of its players\' FGA - OREB + TOV + 0.475 FTA', near(t1.poss, poss(prev[0]) + poss(prev[1])) && t1.minutes === 1600);
  chk('context: the D-I average is production / on-floor possessions over players with >= 100 minutes (the 60-minute player is out)', (() => {
    let so = 0, sp = 0;
    for (const p of prev) { if (p.minutes < 100) continue; const t = ctx.teams.get(p.team_id); so += FE.production(p).off; sp += (p.minutes / t.minutes) * 5 * t.poss; }
    return near(ctx.avg_off, (100 * so) / sp); })());
  const pr = FE.production(prev[0]);
  chk('production: the registered box formula (points + 0.5 ast + 0.6 orb - 0.9 tov - 0.4 missed FG - 0.2 missed FT)', near(pr.off, 500 + 30 + 18 - 40.5 - 56 - 4) && near(pr.def, 54 + 30 + 10.5 - 12));
  const v = FE.playerValue(prev[0], ctx, cfg);
  const on = (1000 / 1600) * 5 * t1.poss, w = 1000 / (1000 + 250);
  chk('value: rate per 100 on-floor possessions minus the D-I average, shrunk toward replacement by minutes / (minutes + 250)',
    v.rate_ok && near(v.off, w * ((100 * pr.off) / on - ctx.avg_off) + (1 - w) * -2.0) && near(v.def, w * ((100 * pr.def) / on - ctx.avg_def) + (1 - w) * -0.5) && near(v.shrink_w, 0.8));
  const lo = FE.playerValue(prev[3], ctx, cfg);
  chk('value: under 100 minutes is replacement level, flagged, never a noisy rate', !lo.rate_ok && lo.off === -2.0 && lo.def === -0.5 && lo.flags.includes('BELOW_MIN_MINUTES_OR_NO_RATE'));
  const star = FE.playerValue(prev[0], ctx, cfg), role = FE.playerValue(prev[1], ctx, cfg);
  chk('value: the higher-scoring player is worth more on offense', star.off > role.off);
}

/* ── translation ─────────────────────────────────────────────────────────── */
{
  const v = FE.playerValue(prev[0], ctx, cfg);
  const cs = new Map([[7, { strength: 110 }], [8, { strength: 100 }]]);
  const up = FE.translate({ kind: 'TRANSFER_D1', from_conference_id: 8, to_conference_id: 7 }, v, Object.assign({}, ctx, { confStrength: cs }), cfg);
  const f = 1 + 0.5 * (100 / 110 - 1);
  chk('translate: D-I to a stronger conference: factor 1 + 0.5 (src / dst - 1), regressed halfway to 1', near(up.factor_def, f) && near(up.def, v.def * f));
  chk('translate: a high-usage (>= 25%) scorer moving up keeps 0.9 of that on offense', near(up.factor_off, f * 0.9) && near(up.off, v.off * f * 0.9));
  const down = FE.translate({ kind: 'TRANSFER_D1', from_conference_id: 7, to_conference_id: 8 }, v, Object.assign({}, ctx, { confStrength: cs }), cfg);
  chk('translate: moving down a level the factor is above 1, and no usage cut', down.factor_def > 1 && near(down.factor_off, down.factor_def));
  const low = FE.translate({ kind: 'TRANSFER_D1', from_conference_id: 8, to_conference_id: 8 }, Object.assign({}, v, { usage: 12 }), Object.assign({}, ctx, { confStrength: cs }), cfg);
  chk('translate: a low-usage (<= 15%) role player keeps 1.05 on offense', near(low.factor_off, 1.05) && near(low.factor_def, 1));
  const none = FE.translate({ kind: 'TRANSFER_D1', from_conference_id: 9, to_conference_id: 7 }, v, Object.assign({}, ctx, { confStrength: cs }), cfg);
  chk('translate: an unknown conference strength is flagged, never guessed (factor 1)', none.flags.includes('NO_CONFERENCE_STRENGTH') && near(none.factor_def, 1));
  const d2 = FE.translate({ kind: 'TRANSFER_PORTAL', from_level: 'D2' }, null, ctx, cfg);
  chk('translate: a D2 transfer has no source statistics: replacement level with D2\'s registered uncertainty (2.0)', d2.off === -2.0 && d2.sd_mult === 2.0 && d2.flags.includes('NO_SOURCE_STATS'));
  const juco = FE.translate({ kind: 'TRANSFER_PORTAL', from_level: 'NON_D1_UNCLASSIFIED' }, null, ctx, cfg);
  chk('translate: an unclassified non-D-I transfer takes the unclassified uncertainty (2.5)', juco.sd_mult === 2.5);
  const fr5 = FE.translate({ kind: 'FRESHMAN', stars: 5 }, null, ctx, cfg), frU = FE.translate({ kind: 'FRESHMAN', stars: null }, null, ctx, cfg);
  chk('translate: a freshman by stars (5 stars +1.0; unrated -2.0), with the freshman uncertainty (2.5)', near(fr5.value, 1.0) && near(frU.value, -2.0) && fr5.sd_mult === 2.5 && near(fr5.off + fr5.def, fr5.value));
  const unk = FE.translate({ kind: 'NEW_UNKNOWN_SOURCE' }, null, ctx, cfg);
  chk('translate: no usable statistics: replacement level, uncertainty 3.0, flagged unknown', unk.sd_mult === 3.0 && unk.flags.includes('UNKNOWN'));
}

/* ── minutes ─────────────────────────────────────────────────────────────── */
{
  const m = FE.expectedMinutes([0.9, 0.8, 0.5, 0.5, 0.4, 0.3, 0.1].map((b) => ({ base: b })));
  chk('minutes: normalised to 200 a game (sum 5 of 40-minute games)', near(m.reduce((a, b) => a + b, 0), 5, 1e-6));
  chk('minutes: no player above the 0.85 cap', m.every((x) => x <= 0.85 + 1e-12) && near(m[0], 0.85, 1e-9));
  const s = FE.expectedMinutes([0.5, 0.5].map((b) => ({ base: b })));
  chk('minutes: a roster too short to fill 200 minutes is capped, not inflated', s.every((x) => near(x, 0.85)));
}

/* ── a team ──────────────────────────────────────────────────────────────── */
{
  const moves = [
    { season: 2027, player_id: 10, to_team_id: 1, to_conference_id: 7, kind: 'RETURNING', from_team_id: 1, name: 'Star A', prev_minutes_share: 0.625, prev_points: 500 },
    { season: 2027, player_id: 20, to_team_id: 1, to_conference_id: 7, kind: 'TRANSFER_D1', from_team_id: 2, from_conference_id: 8, name: 'Mid C', prev_minutes_share: 0.9375 },
    { season: 2027, player_id: 30, to_team_id: 1, kind: 'FRESHMAN', stars: 4, name: 'Fresh E' },
    { season: 2027, player_id: 31, to_team_id: 1, kind: 'TRANSFER_PORTAL', from_level: 'JUCO', name: 'Juco F' },
    { season: 2027, player_id: 32, to_team_id: 1, kind: 'NEW_UNKNOWN_SOURCE', name: 'Walk G' },
  ];
  const departed = [{ season: 2027, player_id: 11, from_team_id: 1, name: 'Role B', destination: 'LEFT_OR_UNKNOWN', prev_minutes_share: 0.375, prev_points: 120 }];
  const rosters = [{ team_id: 1, player_id: 10, height_in: 78 }, { team_id: 1, player_id: 20, height_in: 80 }, { team_id: 1, player_id: 30, height_in: 82 }];
  const cs = new Map([[7, { strength: 105 }], [8, { strength: 100 }]]);
  const prevRating = new Map([[1, { off: 4, allow: 1, net: 3, tempo: 1.5 }]]);
  const coach = { coach_change: true, tenure_years: 1, prior_level: 'D1', career: [] };
  const row = FE.teamFeatures(1, 2027, { moves, departed, prevPlayers: prev, rosters, coach, coachTempo: 2.25, ctx: Object.assign({}, ctx, { confStrength: cs, prevRating }) }, cfg);
  const ps = row.detail.players;
  chk('team: the roster rating is the sum of value x on-floor fraction', near(row.roster_off, ps.reduce((a, p) => a + p.off * p.exp_min_frac, 0), 0.01) && near(row.roster_net, row.roster_off + row.roster_def, 1e-6));
  chk('team: five players cannot fill 200 minutes at the 0.85 cap: every one capped, and the row says so', ps.every((p) => near(p.exp_min_frac, 0.85, 1e-4)) && row.flags.includes('ROSTER_CANNOT_FILL_200_MINUTES'));
  chk('team: returning minutes share is last season\'s minutes that came back (1000 of 1600)', near(row.returning_minutes_share, 0.625, 1e-4));
  chk('team: returning value share is between 0 and 1 and above the minutes share when the star returns', row.returning_value_share > row.returning_minutes_share && row.returning_value_share <= 1);
  chk('team: departed production lists who left, with points and minutes share', row.departed_points === 120 && near(row.departed_minutes_share, 0.375) && row.detail.departed[0].name === 'Role B');
  chk('team: minutes shares by origin add to 1', near(row.minutes_share_returning + row.minutes_share_transfer_d1 + row.minutes_share_non_d1 + row.minutes_share_freshman + row.minutes_share_unknown, 1, 1e-3));
  const A = cfg.variance.a;
  chk('team: the registered variance multiplier', near(row.variance_multiplier, 1 + A.a1 * row.minutes_share_unknown + A.a2 * row.minutes_share_non_d1 + A.a3 * row.minutes_share_freshman + A.a4 + A.a5 * (1 - row.returning_minutes_share), 1e-3));
  chk('team: prior-season rating, coach facts and tempo carried', row.prev_net === 3 && row.prev_tempo === 1.5 && row.coach_change === true && row.coach_tempo_resid === 2.25);
  chk('team: minutes-weighted height from the roster (players without a height are left out)', row.height_in_avg > 78 && row.height_in_avg < 82);
  chk('team: the row names the configuration it was computed with', row.config_sha256 === REG.spec.config_sha256 && row.config_version === '0.1.0');
  const bare = FE.teamFeatures(1, 2027, { moves, departed, prevPlayers: prev, rosters, coach: null, coachTempo: null, ctx: Object.assign({}, ctx, { confStrength: new Map(), prevRating: new Map() }) }, cfg);
  chk('team: no coach record, no rating, no conference strength: null features and flags, never zeros', bare.coach_change === null && bare.prev_net === null
    && ['COACH_UNKNOWN', 'NO_PRIOR_SEASON_RATING', 'NO_CONFERENCE_STRENGTH', 'NO_SOURCE_STATS', 'UNKNOWN'].every((f) => bare.flags.includes(f)), bare.flags);
  chk('team: a coach change counts in the variance only when a record says so', bare.variance_multiplier < row.variance_multiplier);
  chk('team: a team with no roster rows has no features (null)', FE.teamFeatures(99, 2027, { moves, departed, prevPlayers: prev, rosters, ctx }, cfg) === null);
  const av = FE.applyAvailability(row, [10]);
  chk('availability: a player ruled out is removed and his minutes re-spread', av.removed === 1 && av.roster_off < row.roster_off);
  chk('availability: nobody out changes nothing', near(FE.applyAvailability(row, []).roster_net, row.roster_net, 0.01));
  const other = Object.assign({}, row, { returning_minutes_share: 0.1, returning_value_share: 0.05 });
  const g = FE.continuityGap(row, other);
  chk('continuity gap: the absolute difference of both shares; unknown -> null', near(g.minutes, 0.525, 1e-4) && FE.continuityGap(row, Object.assign({}, row, { returning_minutes_share: null })).minutes === null);
}
chk('coach tempo: mean of the earlier head-coaching seasons only', near(FE.coachTempo([{ role: 'HEAD', team_id: 5, from_season: 2020, to_season: 2022 }, { role: 'ASSISTANT', team_id: 6, from_season: 2015, to_season: 2019 }, { role: 'HEAD', team_id: 7, from_season: 2023, to_season: null }],
  2025, (t, y) => (t === 5 ? 2 : t === 7 ? 4 : 99)), (2 * 3 + 4 * 2) / 5));
chk('coach tempo: no seasons known -> null', FE.coachTempo([{ role: 'HEAD', team_id: 5, from_season: 2020, to_season: 2022 }], 2025, () => null) === null);
chk('venue: home/away/neutral owned; travel not owned (null with the reason)', (() => { const v = FE.venue({ neutral: true, home_team_id: 1, away_team_id: 2 }); return v.site === 'NEUTRAL' && v.travel_km === null && /NOT_OWNED/.test(v.travel_reason); })());

/* ── the engine on the committed data ─────────────────────────────────────── */
{
  const st = RT.seasonStates([2025, 2026]);
  const s26 = st[2026];
  chk('engine: season-end ratings for 2026, every D-I team (300+), centred near zero', s26 && s26.teams.size > 300 && Math.abs([...s26.teams.values()].reduce((a, r) => a + r.net, 0) / s26.teams.size) < 3);
  chk('engine: tempo residuals exist and league pace is plausible (60-75)', s26.tau > 60 && s26.tau < 75 && [...s26.teams.values()].every((r) => r.tempo == null || Math.abs(r.tempo) < 15));
  const ids = [...s26.teams.keys()].slice(0, 4);
  const cb = ids.map((id, i) => ({ team_id: 1000 + i, source_id: id, conference_id: i < 2 ? 7 : 8 }));
  cb.push({ team_id: 2000, source_id: '999999999', conference_id: 8 });
  const xw = RT.crosswalk(cb, s26);
  chk('engine: CBBD ids are crosswalked by sourceId (ESPN id); an unknown id is left out', xw.size === 4 && xw.get(1000).espn_id === ids[0] && !xw.has(2000));
  const cs = RT.conferenceStrength(cb, xw);
  chk('engine: conference strength = 100 + the mean net of its members', near(cs.get(7).strength, 100 + (xw.get(1000).net + xw.get(1001).net) / 2) && cs.get(7).teams === 2);
}

/* ── the features part end to end ──────────────────────────────────────────── */
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ncaam-early-fe-'));
  const real = C.PATHS.cache, realRaw = C.PATHS.raw;
  C.PATHS.cache = tmp; C.PATHS.raw = (s, p) => path.join(tmp, 'raw', String(s), p + '.json.gz');
  try {
    const zlib = require('zlib');
    const put = (s, part, body) => { const f = C.PATHS.raw(s, part); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, zlib.gzipSync(Buffer.from(JSON.stringify(body)))); };
    const ps = (o) => Object.assign({ season: 2026, seasonLabel: '2025-26', games: 30, minutes: 900, points: 300, assists: 60, turnovers: 45, fouls: 60, steals: 30, blocks: 15, usage: 20,
      rebounds: { total: 120, offensive: 30, defensive: 90 }, fieldGoals: { made: 110, attempted: 250 }, freeThrows: { made: 60, attempted: 80 } }, o);
    put(2026, 'player_seasons', [ps({ teamId: 1, athleteId: 10, name: 'Synthetic A' }), ps({ teamId: 2, athleteId: 20, name: 'Synthetic B' })]);
    put(2026, 'teams', [{ id: 1, sourceId: 'e1', conferenceId: 7 }, { id: 2, sourceId: 'e2', conferenceId: 8 }]);
    put(2027, 'teams', [{ id: 1, sourceId: 'e1', conferenceId: 7 }, { id: 2, sourceId: 'e2', conferenceId: 8 }, { id: 3, sourceId: 'e3', conferenceId: null }]);
    put(2027, 'rosters', [{ teamId: 1, season: 2027, players: [{ id: 10, name: 'Synthetic A', startSeason: 2025, height: 77 }, { id: 20, name: 'Synthetic B', startSeason: 2027, height: 80 }] }]);
    const states = { 2026: { mu: 105, tau: 68, teams: new Map([['e1', { off: 3, allow: 1, net: 2, tempo: 1 }], ['e2', { off: -1, allow: 2, net: -3, tempo: -2 }]]) } };
    const calls = [];
    const db = { async rpc(name, args) { calls.push({ name, args }); if (name === 'ncaam_es_begin_run') return 'run-1'; if (name === 'ncaam_es_put') return { inserted: args.p_rows.length }; return {}; } };
    const m = await ING.run({ api: { state: { calls: 0, remaining: null, log: [] } }, db, parts: ['features'], seasons: [2027], mode: 'test', now: '2026-11-01T12:00:00Z', codeSha: 'x', offline: true, ratingStates: () => states });
    const r = m.results[0];
    chk('ingest: the features part derives one row per D-I team with a roster, stores them, replaces stale ones', r.status === 'ok' && r.rows === 1 && calls.some((c) => c.name === 'ncaam_es_put' && c.args.p_table === 'ncaam_es_team_features')
      && calls.some((c) => c.name === 'ncaam_es_replace_derived'), r);
    const row = calls.find((c) => c.args && c.args.p_table === 'ncaam_es_team_features').args.p_rows[0];
    chk('ingest: the stored row carries the prior rating crosswalked from the engine and the transfer\'s conference translation', row.prev_net === 2 && row.minutes_share_transfer_d1 > 0
      && row.detail.players.find((p) => p.kind === 'TRANSFER_D1').basis === 'd1_to_d1', row);
    chk('ingest: the checks report the crosswalk and the conference strengths', r.meta.checks.prior_ratings_crosswalked === 2 && r.meta.checks.conferences_with_strength === 2 && r.meta.checks.config_sha256 === REG.spec.config_sha256);
    /* the project part: priors from those features, a final and a scheduled game from a fake dataset */
    const states2 = { 2026: Object.assign({}, states[2026], { eta: 2, s2: 11000, lambda: 300 }) };
    const nowMs = Date.parse('2026-11-05T12:00:00Z');
    const fakeD = { load: () => [], engineGames: () => [
      { game_id: 501, home: 'e1', away: 'e2', neutral: false, regime: 'D1_D1', yH: 112, yA: 98, poss: 70, tempo: 70, start_ms: nowMs - 2 * 86400e3 },
      { game_id: 502, home: 'e2', away: 'e1', neutral: false, regime: 'D1_D1', scheduled: true, start_ms: nowMs + 10 * 3600e3 },
      { game_id: 503, home: 'e2', away: 'e1', neutral: false, regime: 'D1_D1', scheduled: true, start_ms: nowMs + 100 * 3600e3 } ] };
    put(2027, 'teams', [{ id: 1, sourceId: 'e1', conferenceId: 7 }, { id: 2, sourceId: 'e2', conferenceId: 8 }]);
    put(2027, 'rosters', [{ teamId: 1, season: 2027, players: [{ id: 10, name: 'Synthetic A', startSeason: 2025, height: 77 }] }, { teamId: 2, season: 2027, players: [{ id: 20, name: 'Synthetic B', startSeason: 2024, height: 79 }] }]);
    const calls2 = [];
    const db2 = { async rpc(name, args) { calls2.push({ name, args }); if (name === 'ncaam_es_begin_run') return 'run-2'; if (name === 'ncaam_es_put') return { inserted: args.p_rows.length }; return {}; } };
    const m2 = await ING.run({ api: { state: { calls: 0, remaining: null, log: [] } }, db: db2, parts: ['project'], seasons: [2027], mode: 'test', now: new Date(nowMs).toISOString(), codeSha: 'abc', offline: true, ratingStates: () => states2, dataset: fakeD });
    const r2 = m2.results[0];
    const pr = (calls2.find((c) => c.args && c.args.p_table === 'ncaam_es_projections') || { args: { p_rows: [] } }).args.p_rows;
    chk('project part: only the game in the next 48 hours is projected and stored, append-only', r2.status === 'ok' && pr.length === 1 && pr[0].espn_game_id === '502' && r2.meta.checks.targets === 1, r2);
    chk('project part: it used the one final known before its time, and names model, version, config and code', pr[0] && pr[0].finals_used === 1 && pr[0].model_id === 'edgedesk_ncaam_early_v1' && pr[0].model_version === REG.version
      && pr[0].config_sha256 === REG.spec.config_sha256 && pr[0].code_sha === 'abc' && pr[0].projection_id === 'run-2:502');
    chk('project part: a fair spread, total and win probability with its sd, and the angle tags', pr[0] && Number.isFinite(pr[0].fair_spread_home) && pr[0].fair_total > 100 && pr[0].win_prob_home > 0 && pr[0].win_prob_home < 1 && pr[0].sd_margin > 11 && Array.isArray(pr[0].angles));
    chk('ingest: features then project are in the daily and weekly schedules, after moves', ING.DAILY.indexOf('features') > ING.DAILY.indexOf('moves') && ING.DAILY.indexOf('project') > ING.DAILY.indexOf('features') && ING.WEEKLY.includes('project'));
  } catch (e) {
    chk('ingest end to end ran', false, String(e && e.stack || e).slice(0, 600));
  } finally {
    C.PATHS.cache = real; C.PATHS.raw = realRaw;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  fails.forEach((f) => console.log('FAIL | ' + f));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'NCAAM-EARLY features — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})();
