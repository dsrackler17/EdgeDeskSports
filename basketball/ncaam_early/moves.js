'use strict';
/* ===========================================================================
   NCAAM-EARLY — who returned, who arrived from where, who left. Pure (T0
   observations in, derived observation rows out; no estimate, no weight).

     derive({ season, rosters, prevPlayers, curTeams, prevTeams, portal,
              recruits, schoolLevels, portalOffset, recruitOffset })
       -> { moves, departed, unmatched, counts }

   For every player on a team's roster in season S, the first rule that holds:

     RETURNING            played for the same team in S-1 (player-season record)
     TRANSFER_D1          played for another D-I team in S-1 (player-season
                          record: the athlete id is the same, the team is not)
     TRANSFER_PORTAL      matched to a portal entry into this team (exact
                          normalised full name, one candidate only); the origin
                          gives the source level: a D-I team of S-1, or a school
                          in manual/school_levels.json (D2, D3, NAIA, JUCO,
                          INTERNATIONAL, PREP), else NON_D1_UNCLASSIFIED
     FRESHMAN             a recruit committed to this team for this season
                          (CBBD athlete id, else exact name)
     NEW_UNKNOWN_SOURCE   first season on the roster, no record above
     RETURNING_NO_STATS   on the roster before S, no S-1 minutes for anyone
                          (redshirt, injury, walk-on): continuity, zero value
     UNKNOWN              nothing at all

   DEPARTED: every S-1 player of a team who is not on its S roster, with where
   he went if he is on another S roster, else LEFT_OR_UNKNOWN (graduated,
   professional, non-D-I or out of basketball: the sources do not say which).

   Portal and recruiting `year` are matched to the END-year season by an
   offset VERIFIED from the data (verifyOffset: which offset puts more portal
   destinations on the destination's roster). An unverified offset means the
   portal is not used at all (counts.portal_used = false), never guessed.

   Minutes share = the player's S-1 minutes / the sum of S-1 minutes of every
   player of that team (player-season records).
   =========================================================================== */

const LEVELS = ['D1', 'D2', 'D3', 'NAIA', 'JUCO', 'INTERNATIONAL', 'PREP', 'NON_D1_UNCLASSIFIED'];

function normName(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[.'’`-]/g, '').replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '').replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
}
const normSchool = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();

/** which year offset (season = year + offset) puts more entries on their destination's roster */
function verifyOffset(entries, rostersBySeason, teamOf, nameOf) {
  const score = {};
  for (const off of [0, 1]) {
    let hit = 0, asked = 0;
    for (const e of entries) {
      const tid = teamOf(e); if (tid == null) continue;
      const ros = rostersBySeason.get(e.year + off); if (!ros) continue;
      asked++;
      const names = ros.get(tid);
      if (names && names.has(normName(nameOf(e)))) hit++;
    }
    score[off] = { asked, hit, rate: asked ? hit / asked : null };
  }
  const a = score[0], b = score[1];
  /* verified only when one offset matches clearly more often, on enough entries */
  const pick = (x, y) => x.asked >= 50 && x.rate != null && x.rate >= 0.5 && (y.rate == null || x.rate >= 2 * y.rate);
  const offset = pick(b, a) ? 1 : pick(a, b) ? 0 : null;
  return { offset, score };
}

function rosterNameIndex(rosters) {
  const bySeason = new Map();
  for (const r of rosters) {
    if (!bySeason.has(r.season)) bySeason.set(r.season, new Map());
    const m = bySeason.get(r.season);
    if (!m.has(r.team_id)) m.set(r.team_id, new Set());
    m.get(r.team_id).add(normName(r.name));
  }
  return bySeason;
}

function derive(o) {
  const S = o.season;
  const rosters = (o.rosters || []).filter((r) => r.season === S);
  const prev = o.prevPlayers || [];
  /* D-I in S-1 = a team CBBD lists WITH a conference that season. The team
     list can also carry non-D-I opponents (no conference): they are never D-I
     here. The rule is checked against the ESPN D-I membership on the first
     real run (ingest crosswalk). */
  const d1Prev = new Map((o.prevTeams || []).filter((t) => t.conference_id != null).map((t) => [t.team_id, t]));
  const cur = new Map((o.curTeams || []).map((t) => [t.team_id, t]));
  const levels = new Map(((o.schoolLevels && o.schoolLevels.entries) || []).map((e) => [normSchool(e.name), e]));
  const counts = { roster_players: rosters.length, portal_used: o.portalOffset != null, recruits_used: o.recruitOffset != null, by_kind: {}, departed: 0, unmatched_portal_names: 0, ambiguous_portal_names: 0 };

  /* S-1 minutes by athlete and team totals */
  const teamMin = new Map(); const prevBy = new Map();
  for (const p of prev) {
    teamMin.set(p.team_id, (teamMin.get(p.team_id) || 0) + (p.minutes || 0));
    if (!prevBy.has(p.athlete_id)) prevBy.set(p.athlete_id, []);
    prevBy.get(p.athlete_id).push(p);
  }
  const share = (p) => { const t = teamMin.get(p.team_id); return t > 0 && p.minutes != null ? Math.round((p.minutes / t) * 10000) / 10000 : null; };

  /* portal entries into each team for this season, by normalised name */
  const portalIn = new Map();
  if (o.portalOffset != null) for (const e of o.portal || []) {
    if (e.year + o.portalOffset !== S || e.dest_team_id == null) continue;
    const k = e.dest_team_id + '|' + normName((e.first_name || '') + ' ' + (e.last_name || ''));
    if (!portalIn.has(k)) portalIn.set(k, []);
    portalIn.get(k).push(e);
  }
  const recruitBy = new Map(); const recruitName = new Map();
  if (o.recruitOffset != null) for (const r of o.recruits || []) {
    if (r.year + o.recruitOffset !== S || r.committed_team_id == null) continue;
    if (r.athlete_id != null) recruitBy.set(r.athlete_id + '|' + r.committed_team_id, r);
    const k = r.committed_team_id + '|' + normName(r.name);
    recruitName.set(k, recruitName.has(k) ? null : r);   // two recruits with one name: neither by name
  }

  const moves = []; const onRoster = new Map();
  for (const r of rosters) {
    onRoster.set(r.player_id, r.team_id);
    const base = { season: S, player_id: r.player_id, name: r.name, to_team_id: r.team_id, to_conference_id: (cur.get(r.team_id) || {}).conference_id || null, roster_captured_at: r.captured_at, roster_pit: r.pit };
    const hist = prevBy.get(r.player_id) || [];
    const same = hist.find((p) => p.team_id === r.team_id);
    const best = (arr) => arr.slice().sort((a, b) => (b.minutes || 0) - (a.minutes || 0))[0];
    let m;
    if (same) {
      m = { kind: 'RETURNING', from_team_id: r.team_id, from_level: 'D1', evidence: 'player_season_same_team', prev: same };
    } else if (hist.length) {
      const p = best(hist);
      m = { kind: 'TRANSFER_D1', from_team_id: p.team_id, from_level: d1Prev.has(p.team_id) ? 'D1' : 'NON_D1_UNCLASSIFIED', from_conference_id: (d1Prev.get(p.team_id) || {}).conference_id || null, evidence: 'player_season_team_change', prev: p };
    } else {
      const cands = portalIn.get(r.team_id + '|' + normName(r.name)) || [];
      if (cands.length > 1) counts.ambiguous_portal_names++;
      const e = cands.length === 1 ? cands[0] : null;
      const rec = recruitBy.get(r.player_id + '|' + r.team_id) || recruitName.get(r.team_id + '|' + normName(r.name)) || null;
      if (e) {
        let lvl = 'NON_D1_UNCLASSIFIED', how = 'origin not classified';
        if (e.origin_team_id != null && d1Prev.has(e.origin_team_id)) { lvl = 'D1'; how = 'origin is a D-I team in ' + (S - 1); }
        else { const L = levels.get(normSchool(e.origin_name)); if (L) { lvl = L.level; how = 'manual/school_levels.json'; } }
        m = { kind: 'TRANSFER_PORTAL', from_team_id: e.origin_team_id, from_name: e.origin_name, from_level: lvl, from_level_basis: how, portal_id: e.portal_id, stars: e.stars, rating: e.rating, evidence: 'portal_exact_name' };
      } else if (rec) {
        m = { kind: 'FRESHMAN', from_level: 'PREP', from_name: rec.school, recruit_id: rec.recruit_id, stars: rec.stars, rating: rec.rating, ranking: rec.ranking, evidence: rec.athlete_id === r.player_id ? 'recruit_athlete_id' : 'recruit_exact_name' };
      } else if (r.start_season === S) {
        m = { kind: 'NEW_UNKNOWN_SOURCE', evidence: 'roster_start_season' };
      } else if (r.start_season != null && r.start_season < S) {
        m = { kind: 'RETURNING_NO_STATS', from_team_id: r.team_id, evidence: 'roster_start_season_before' };
      } else {
        m = { kind: 'UNKNOWN', evidence: 'none' };
      }
    }
    const p = m.prev; delete m.prev;
    const row = Object.assign(base, { from_team_id: null, from_name: null, from_level: null, from_level_basis: null, from_conference_id: null, portal_id: null, recruit_id: null, stars: null, rating: null, ranking: null }, m,
      { prev_season: p ? S - 1 : null, prev_games: p ? p.games : null, prev_minutes: p ? p.minutes : null, prev_minutes_share: p ? share(p) : null, prev_usage: p ? p.usage : null, prev_porpag: p ? p.porpag : null, prev_points: p ? p.points : null });
    counts.by_kind[row.kind] = (counts.by_kind[row.kind] || 0) + 1;
    moves.push(row);
  }
  /* departures, only for teams whose S roster we hold (otherwise unknown) */
  const haveRoster = new Set(rosters.map((r) => r.team_id));
  const departed = [];
  for (const p of prev) {
    if (!haveRoster.has(p.team_id)) continue;
    const now = onRoster.get(p.athlete_id);
    if (now === p.team_id) continue;
    departed.push({ season: S, player_id: p.athlete_id, name: p.name, from_team_id: p.team_id, to_team_id: now == null ? null : now, destination: now == null ? 'LEFT_OR_UNKNOWN' : 'D1_ROSTER',
      prev_games: p.games, prev_minutes: p.minutes, prev_minutes_share: share(p), prev_points: p.points, prev_usage: p.usage, prev_porpag: p.porpag });
  }
  counts.departed = departed.length;
  counts.unmatched_portal_names = [...portalIn.values()].flat().length - moves.filter((m) => m.kind === 'TRANSFER_PORTAL').length;
  return { moves, departed, counts };
}

module.exports = { derive, verifyOffset, rosterNameIndex, normName, normSchool, LEVELS };
