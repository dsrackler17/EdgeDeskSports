'use strict';
/* ===========================================================================
   NCAAM-EARLY — CBBD payloads -> T0 observation rows. Pure.

   One function per part. Each returns { rows, rejected } where a rejected row
   carries its index and the reason: a row is never repaired, guessed or
   filled with a zero. Field names follow the response schemas of CBBD 1.30.1
   (config/cbbd_endpoints.json).

   Every row carries the season as the END year (2026 = 2025-26). seasonOf()
   checks CBBD's `season` against its own `seasonLabel`, so a different
   convention is caught the first time it is read, not assumed.

   Possessions (box_team): FGA - OREB + TOV + 0.475 FTA, the estimate of the
   NCAAM forecast dataset (basketball/ncaam_forecast/dataset.js). CBBD's own
   `possessions` is kept beside it as `poss_src`, never mixed in.

   Rosters, portal entries, recruits and lines carry `captured_at` (when
   EdgeDesk read them) and `pit`:
     LIVE   captured before the event it describes (a roster before the
            season's first game, a line before the game's tip): usable as
            information that existed at the time
     RETRO  captured after: a reconstruction, never certified as known then
   =========================================================================== */
const C = require('./config');

const num = (v) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v) => (v === null || v === undefined || v === '' ? null : String(v).trim() || null);
const int = (v) => { const n = num(v); return n == null || !Number.isInteger(n) ? null : n; };
const isoS = (t) => new Date(t).toISOString().replace(/\.000Z$/, 'Z');
const sub = (o, k) => (o && typeof o === 'object' ? o[k] : null);

/** CBBD season + label -> the END-year season, or an error */
function seasonOf(r) {
  const s = int(r && r.season);
  if (s == null) return { err: 'no season' };
  const lab = str(r.seasonLabel);
  if (lab == null) return { season: s, unverified: true };
  const m = /^(\d{4})\s*[-/]\s*(\d{2}|\d{4})$/.exec(lab);
  if (!m) return { err: 'season label ' + lab + ' is not YYYY-YY' };
  const end = m[2].length === 2 ? Math.floor(+m[1] / 100) * 100 + +m[2] + (+m[2] < +m[1] % 100 ? 100 : 0) : +m[2];
  if (end !== s) return { err: 'season ' + s + ' does not end the label ' + lab + ' (the END-year convention is broken)' };
  return { season: s };
}

const STATUS = { scheduled: 'SCHEDULED', in_progress: 'IN_PROGRESS', final: 'FINAL', postponed: 'POSTPONED', cancelled: 'CANCELED' };

function teams(body, season) {
  const out = { rows: [], rejected: [] };
  if (!Array.isArray(body)) return { rows: [], rejected: [], refusal: 'not a list' };
  const seen = new Set();
  body.forEach((r, i) => {
    const id = int(r && r.id);
    if (id == null) { out.rejected.push({ index: i, reason: 'no team id' }); return; }
    if (seen.has(id)) { out.rejected.push({ index: i, reason: 'team ' + id + ' appears twice' }); return; }
    seen.add(id);
    out.rows.push({ season, team_id: id, source_id: str(r.sourceId), school: str(r.school), display_name: str(r.displayName), abbreviation: str(r.abbreviation),
      conference_id: int(r.conferenceId), conference: str(r.conference), venue_id: int(r.currentVenueId), venue: str(r.currentVenue), city: str(r.currentCity), state: str(r.currentState) });
  });
  return out;
}

/* conference history -> conferences + (conference, team, from, to) memberships */
function conferences(body) {
  const out = { rows: [], memberships: [], rejected: [] };
  if (!Array.isArray(body)) return Object.assign(out, { refusal: 'not a list' });
  body.forEach((c, i) => {
    const id = int(c && c.id);
    if (id == null) { out.rejected.push({ index: i, reason: 'no conference id' }); return; }
    out.rows.push({ conference_id: id, source_id: str(c.sourceId), name: str(c.name), abbreviation: str(c.abbreviation), short_name: str(c.shortName) });
    (Array.isArray(c.teams) ? c.teams : []).forEach((t, j) => {
      const tid = int(t && t.id); const from = int(t && t.startSeason);
      if (tid == null || from == null) { out.rejected.push({ index: i + '.' + j, reason: 'membership without team id or start season' }); return; }
      out.memberships.push({ conference_id: id, team_id: tid, team_source_id: str(t.sourceId), school: str(t.school), start_season: from, end_season: int(t.endSeason) });
    });
  });
  return out;
}

/** is a team in a listed conference in `season` (memberships from conferences()) */
function memberOf(memberships, teamId, season) {
  return memberships.filter((m) => m.team_id === teamId && m.start_season <= season && (m.end_season == null || m.end_season >= season)).map((m) => m.conference_id);
}

function venues(body) {
  const out = { rows: [], rejected: [] };
  if (!Array.isArray(body)) return Object.assign(out, { refusal: 'not a list' });
  body.forEach((v, i) => {
    const id = int(v && v.id);
    if (id == null) { out.rejected.push({ index: i, reason: 'no venue id' }); return; }
    out.rows.push({ venue_id: id, source_id: str(v.sourceId), name: str(v.name), city: str(v.city), state: str(v.state), country: str(v.country) });
  });
  return out;
}

function games(body) {
  const out = { rows: [], rejected: [] };
  if (!Array.isArray(body)) return Object.assign(out, { refusal: 'not a list' });
  const seen = new Map();
  body.forEach((g, i) => {
    const id = int(g && g.id);
    if (id == null) { out.rejected.push({ index: i, reason: 'no game id' }); return; }
    const so = seasonOf(g); if (so.err) { out.rejected.push({ index: i, game_id: id, reason: so.err }); return; }
    const t = Date.parse(g.startDate);
    if (!Number.isFinite(t)) { out.rejected.push({ index: i, game_id: id, reason: 'no start time' }); return; }
    const h = int(g.homeTeamId), a = int(g.awayTeamId);
    if (h == null || a == null || h === a) { out.rejected.push({ index: i, game_id: id, reason: 'teams missing or identical' }); return; }
    const status = STATUS[String(g.status || '').toLowerCase()] || 'OTHER';
    const hp = status === 'FINAL' ? num(g.homePoints) : null, ap = status === 'FINAL' ? num(g.awayPoints) : null;
    if (status === 'FINAL' && (hp == null || ap == null || hp < 0 || ap < 0 || hp > 200 || ap > 200 || hp === ap)) { out.rejected.push({ index: i, game_id: id, reason: 'a final without a valid decided score' }); return; }
    const row = { game_id: id, source_id: str(g.sourceId), season: so.season, season_type: str(g.seasonType), start_utc: isoS(t), start_tbd: g.startTimeTbd === true,
      status, neutral: g.neutralSite === true, conf_game: g.conferenceGame === true, game_type: str(g.gameType), tournament: str(g.tournament),
      home_team_id: h, away_team_id: a, home_conference_id: int(g.homeConferenceId), away_conference_id: int(g.awayConferenceId), home_points: hp, away_points: ap,
      venue_id: int(g.venueId), venue: str(g.venue), city: str(g.city), state: str(g.state),
      assumed_available_at: status === 'FINAL' ? isoS(t + C.AVAILABLE_AFTER_MS) : null };
    if (seen.has(id)) { out.rows[seen.get(id)] = row; out.rejected.push({ index: i, game_id: id, reason: 'duplicate id: the later row is kept' }); return; }
    seen.set(id, out.rows.length); out.rows.push(row);
  });
  return out;
}

function possessions(s) {
  if ([s.fga, s.orb, s.tov, s.fta].some((x) => x == null)) return null;
  return Math.round((s.fga - s.orb + s.tov + C.POSS_FTA * s.fta) * 100) / 100;
}

function statLine(t) {
  const fg = sub(t, 'fieldGoals'), tp = sub(t, 'threePointFieldGoals'), ft = sub(t, 'freeThrows'), rb = sub(t, 'rebounds'), to = sub(t, 'turnovers');
  return { pts: num(sub(t, 'points') && typeof t.points === 'object' ? t.points.total : t && t.points), fgm: num(sub(fg, 'made')), fga: num(sub(fg, 'attempted')),
    tpm: num(sub(tp, 'made')), tpa: num(sub(tp, 'attempted')), ftm: num(sub(ft, 'made')), fta: num(sub(ft, 'attempted')),
    orb: num(sub(rb, 'offensive')), drb: num(sub(rb, 'defensive')), tov: num(sub(to, 'total')), ast: num(sub(t, 'assists')), stl: num(sub(t, 'steals')),
    blk: num(sub(t, 'blocks')), pf: num(sub(t, 'fouls') && typeof t.fouls === 'object' ? t.fouls.total : t && t.fouls), poss_src: num(sub(t, 'possessions')) };
}

/* one row per team per game; a line that cannot give possessions is kept with
   box_ok = false and its reason, so coverage is measured, never hidden */
function boxTeam(body) {
  const out = { rows: [], rejected: [] };
  if (!Array.isArray(body)) return Object.assign(out, { refusal: 'not a list' });
  const seen = new Map();
  body.forEach((b, i) => {
    const gid = int(b && b.gameId), tid = int(b && b.teamId);
    if (gid == null || tid == null) { out.rejected.push({ index: i, reason: 'no game or team id' }); return; }
    const so = seasonOf(b); if (so.err) { out.rejected.push({ index: i, game_id: gid, reason: so.err }); return; }
    const s = statLine(b.teamStats), o = statLine(b.opponentStats);
    const reasons = [];
    for (const k of ['pts', 'fga', 'fta', 'orb', 'tov']) if (s[k] == null) reasons.push('NO_' + k.toUpperCase());
    if (s.fgm != null && s.fga != null && s.fgm > s.fga) reasons.push('FGM_GT_FGA');
    if (s.pts != null && s.fgm != null && s.tpm != null && s.ftm != null && s.pts !== 2 * s.fgm + s.tpm + s.ftm) reasons.push('POINTS_NE_SHOTS');
    const poss = possessions(s);
    if (poss != null && (poss < 40 || poss > 110)) reasons.push('POSSESSIONS_IMPLAUSIBLE');
    const row = Object.assign({ game_id: gid, team_id: tid, season: so.season, start_utc: Number.isFinite(Date.parse(b.startDate)) ? isoS(Date.parse(b.startDate)) : null,
      opponent_id: int(b.opponentId), is_home: b.isHome === true, neutral: b.neutralSite === true, conf_game: b.conferenceGame === true, game_minutes: num(b.gameMinutes), pace_src: num(b.pace) }, s,
      { opp_pts: o.pts, opp_fga: o.fga, opp_fta: o.fta, opp_orb: o.orb, opp_drb: o.drb, opp_tov: o.tov,
        possessions: poss, opp_possessions: possessions(o), box_ok: reasons.length === 0, box_issues: reasons.join('|') || null });
    const k = gid + ':' + tid;
    if (seen.has(k)) { out.rows[seen.get(k)] = row; out.rejected.push({ index: i, game_id: gid, reason: 'duplicate team line: the later row is kept' }); return; }
    seen.set(k, out.rows.length); out.rows.push(row);
  });
  return out;
}

/* asOf: null for a whole-season pull, else the end of the date range asked
   (an "as of" pull for point-in-time features later) */
function playerSeasons(body, asOf) {
  const out = { rows: [], rejected: [] };
  if (!Array.isArray(body)) return Object.assign(out, { refusal: 'not a list' });
  const seen = new Set();
  body.forEach((p, i) => {
    const aid = int(p && p.athleteId), tid = int(p && p.teamId);
    if (aid == null || tid == null) { out.rejected.push({ index: i, reason: 'no athlete or team id' }); return; }
    const so = seasonOf(p); if (so.err) { out.rejected.push({ index: i, athlete_id: aid, reason: so.err }); return; }
    const k = aid + ':' + tid;
    if (seen.has(k)) { out.rejected.push({ index: i, athlete_id: aid, reason: 'the athlete appears twice for one team' }); return; }
    seen.add(k);
    const min = num(p.minutes), gp = num(p.games);
    if (min != null && (min < 0 || (gp != null && gp > 0 && min / gp > 45))) { out.rejected.push({ index: i, athlete_id: aid, reason: 'implausible minutes' }); return; }
    const fg = p.fieldGoals, tp = p.threePointFieldGoals, ft = p.freeThrows, rb = p.rebounds, ws = p.winShares;
    out.rows.push({ season: so.season, team_id: tid, athlete_id: aid, athlete_source_id: str(p.athleteSourceId), name: str(p.name), position: str(p.position),
      as_of: asOf || null, games: gp, starts: num(p.starts), minutes: min, points: num(p.points), rebounds: num(sub(rb, 'total')), orb: num(sub(rb, 'offensive')), drb: num(sub(rb, 'defensive')),
      assists: num(p.assists), steals: num(p.steals), blocks: num(p.blocks), turnovers: num(p.turnovers), fouls: num(p.fouls),
      fgm: num(sub(fg, 'made')), fga: num(sub(fg, 'attempted')), tpm: num(sub(tp, 'made')), tpa: num(sub(tp, 'attempted')), ftm: num(sub(ft, 'made')), fta: num(sub(ft, 'attempted')),
      usage: num(p.usage), ortg: num(p.offensiveRating), drtg: num(p.defensiveRating), net_rtg: num(p.netRating), porpag: num(p.PORPAG),
      efg: num(p.effectiveFieldGoalPct), ts: num(p.trueShootingPct), ftr: num(p.freeThrowRate), orb_pct: num(p.offensiveReboundPct),
      ws: num(sub(ws, 'total')), ows: num(sub(ws, 'offensive')), dws: num(sub(ws, 'defensive')) });
  });
  return out;
}

/* firstTip: the season's first scheduled tip (from games), which decides LIVE vs RETRO */
function pitOf(capturedAt, eventAt) {
  if (!eventAt) return 'RETRO';
  return Date.parse(capturedAt) < Date.parse(eventAt) ? 'LIVE' : 'RETRO';
}

function rosters(body, season, capturedAt, firstTip) {
  const out = { rows: [], rejected: [] };
  if (!Array.isArray(body)) return Object.assign(out, { refusal: 'not a list' });
  const pit = pitOf(capturedAt, firstTip);
  body.forEach((t, i) => {
    const tid = int(t && t.teamId);
    if (tid == null) { out.rejected.push({ index: i, reason: 'no team id' }); return; }
    if (int(t.season) != null && int(t.season) !== season) { out.rejected.push({ index: i, team_id: tid, reason: 'roster of season ' + t.season + ', asked for ' + season }); return; }
    const seen = new Set();
    (Array.isArray(t.players) ? t.players : []).forEach((p, j) => {
      const pid = int(p && p.id);
      if (pid == null) { out.rejected.push({ index: i + '.' + j, team_id: tid, reason: 'no player id' }); return; }
      if (seen.has(pid)) { out.rejected.push({ index: i + '.' + j, team_id: tid, reason: 'player listed twice' }); return; }
      seen.add(pid);
      const ht = num(p.height); const ho = p.hometown || {};
      out.rows.push({ season, team_id: tid, player_id: pid, player_source_id: str(p.sourceId), name: str(p.name), position: str(p.position), jersey: str(p.jersey),
        /* height is inches in the source; outside 60-96 it is not a basketball player's height and is not used */
        height_in: ht != null && ht >= 60 && ht <= 96 ? ht : null, weight_lb: num(p.weight), dob: str(p.dateOfBirth),
        start_season: int(p.startSeason), end_season: int(p.endSeason),
        home_city: str(ho.city), home_state: str(ho.state), home_country: str(ho.country), home_lat: num(ho.latitude), home_lon: num(ho.longitude),
        captured_at: capturedAt, pit });
    });
  });
  return out;
}

function portal(body, capturedAt) {
  const out = { rows: [], rejected: [] };
  if (!Array.isArray(body)) return Object.assign(out, { refusal: 'not a list' });
  const seen = new Set();
  body.forEach((t, i) => {
    const id = int(t && t.id), yr = int(t && t.year);
    if (id == null || yr == null) { out.rejected.push({ index: i, reason: 'no portal id or year' }); return; }
    if (seen.has(id)) { out.rejected.push({ index: i, reason: 'portal entry ' + id + ' twice' }); return; }
    seen.add(id);
    const o = t.origin || {}, d = t.destination || {};
    out.rows.push({ portal_id: id, source_id: str(t.sourceId), year: yr, first_name: str(t.firstName), last_name: str(t.lastName), position: str(t.position),
      origin_team_id: int(o.id), origin_name: str(o.name), origin_conference: str(o.conference),
      dest_team_id: int(d.id), dest_name: str(d.name), dest_conference: str(d.conference),
      eligibility: str(t.eligibility), years_remaining: int(t.yearsRemaining), stars: int(t.stars), rating: num(t.rating), captured_at: capturedAt });
  });
  return out;
}

function recruits(body, capturedAt) {
  const out = { rows: [], rejected: [] };
  if (!Array.isArray(body)) return Object.assign(out, { refusal: 'not a list' });
  const seen = new Set();
  body.forEach((r, i) => {
    const id = int(r && r.id), yr = int(r && r.year);
    if (id == null || yr == null) { out.rejected.push({ index: i, reason: 'no recruit id or year' }); return; }
    if (seen.has(id)) { out.rejected.push({ index: i, reason: 'recruit ' + id + ' twice' }); return; }
    seen.add(id);
    const c = r.committedTo || {}; const ht = num(r.heightInches);
    out.rows.push({ recruit_id: id, source_id: str(r.sourceId), year: yr, athlete_id: int(r.athleteId), name: str(r.name), position: str(r.position), school: str(r.school),
      committed_team_id: int(c.id), committed_name: str(c.name), committed_conference: str(c.conference),
      height_in: ht != null && ht >= 60 && ht <= 96 ? ht : null, weight_lb: num(r.weightPounds), stars: int(r.stars), rating: num(r.rating), ranking: int(r.ranking), captured_at: capturedAt });
  });
  return out;
}

/* lines: CBBD gives a provider's line and its opening values, with NO times.
   A line read after tip is RETRO: the last value the provider holds, not a
   certified close. tipById: game_id -> start_utc. */
function lines(body, capturedAt, tipById) {
  const out = { rows: [], rejected: [] };
  if (!Array.isArray(body)) return Object.assign(out, { refusal: 'not a list' });
  const seen = new Set();
  body.forEach((g, i) => {
    const gid = int(g && g.gameId);
    if (gid == null) { out.rejected.push({ index: i, reason: 'no game id' }); return; }
    const so = seasonOf(g); if (so.err) { out.rejected.push({ index: i, game_id: gid, reason: so.err }); return; }
    const tip = (tipById && tipById.get(gid)) || (Number.isFinite(Date.parse(g.startDate)) ? isoS(Date.parse(g.startDate)) : null);
    (Array.isArray(g.lines) ? g.lines : []).forEach((l, j) => {
      const prov = str(l && l.provider);
      if (!prov) { out.rejected.push({ index: i + '.' + j, game_id: gid, reason: 'no provider' }); return; }
      const k = gid + ':' + prov;
      if (seen.has(k)) { out.rejected.push({ index: i + '.' + j, game_id: gid, reason: 'provider twice for one game' }); return; }
      seen.add(k);
      out.rows.push({ game_id: gid, season: so.season, provider: prov, spread: num(l.spread), over_under: num(l.overUnder), home_ml: num(l.homeMoneyline), away_ml: num(l.awayMoneyline),
        spread_open: num(l.spreadOpen), over_under_open: num(l.overUnderOpen), tip_utc: tip, captured_at: capturedAt, pit: pitOf(capturedAt, tip) });
    });
  });
  return out;
}

module.exports = { seasonOf, teams, conferences, memberOf, venues, games, boxTeam, possessions, playerSeasons, rosters, portal, recruits, lines, pitOf, STATUS };
