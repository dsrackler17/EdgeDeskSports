'use strict';
/* ===========================================================================
   Identity: who is who, from explicit evidence only.

   TEAMS. D1 membership is per season. A team-season is D1 when the publisher's
   explicit-ID bridge lists its ESPN id with the D1 reference flag, or when a
   reviewed override (identity/team_overrides.json, each row with its
   evidence) supplies the ESPN id the bridge lacks. Anything else is UNKNOWN
   membership: probably a non-D1 opponent, but never asserted to be one.

   PLAYERS (2026). Possession and lineup rows carry NCAA player ids; box-score
   history carries ESPN athlete ids. They are linked by box-score
   FINGERPRINTS, never by fuzzy names: inside one game and one team (both
   explicit ESPN ids), an NCAA line and an ESPN line with the same 14 counted
   stats (pts, fgm, fga, 3pm, 3pa, ftm, fta, orb, drb, ast, stl, blk, tov, pf)
   are the same appearance when that line is unique on both sides and not all
   zeros. A link is accepted when it recurs in >= 2 games and >= 90% of the
   player's unique fingerprints agree and no other id claims the athlete.
   Everything else is quarantined with its evidence. Exact name agreement is
   reported as corroboration, not used as evidence.

   PUBLISHER PERSONS. The RAPM tables give person_id beside the season's NCAA
   player_id: an explicit link. Linking an earlier season's person to an ESPN
   athlete has no fingerprint (no 2024/2025 NCAA player box), so it uses the
   exact normalised full name inside a team-season mapped by explicit team
   ids, unique on both sides. Its error rate is MEASURED on 2026, where the
   fingerprint crosswalk is available, and published with the links.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const C = require('./config');
const T = require('./lib/table');
const { read } = require('./lib/pack');

/* ---------------------------------------------------------------- names */
const SUFFIX = new Set(['JR', 'SR', 'II', 'III', 'IV', 'V']);
function normName(s) {
  if (s == null) return null;
  const a = String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z]+/g, ' ').trim();
  return a.split(' ').filter((t) => t && !SUFFIX.has(t)).join(' ') || null;
}

/* ---------------------------------------------------------------- teams */
let MEMBERSHIP = null;
async function teamMembership() {
  if (MEMBERSHIP) return MEMBERSHIP;
  const bridge = T.rows(await read('team_season_identity_bridge', { season: 'num', ncaa_team_season_id: 'str', espn_team_id: 'str', native_ncaa_team_name: 'str', conference: 'str', listed_in_publisher_d1_team_reference: 'bool', mapping_source: 'str' }));
  const reference = {};
  for (const s of C.SEASONS) reference[s] = T.rows(await read('ncaa_mbb_team_ids_' + s, { team: 'str', conference: 'str', id: 'str', season: 'num' }));
  const overrides = JSON.parse(fs.readFileSync(path.join(__dirname, 'identity', 'team_overrides.json'), 'utf8')).rows;
  const map = new Map(); const byNcaa = new Map(); const conflicts = [];
  const put = (season, espn, rec) => {
    const k = season + ':' + espn;
    if (map.has(k) && map.get(k).ncaa_id !== rec.ncaa_id) { conflicts.push({ season, espn_team_id: espn, a: map.get(k), b: rec }); map.set(k, Object.assign({}, rec, { d1: null, mapping: 'CONFLICT' })); return; }
    map.set(k, rec); byNcaa.set(season + ':' + rec.ncaa_id, espn);
  };
  for (const b of bridge) {
    const espn = Number(b.espn_team_id);
    put(b.season, espn, { d1: b.listed_in_publisher_d1_team_reference === 1 ? true : null, conference: b.conference, ncaa_id: b.ncaa_team_season_id, ncaa_name: b.native_ncaa_team_name, mapping: 'publisher_bridge_explicit_ids' });
  }
  for (const o of overrides) {
    const ref = reference[o.season].find((r) => r.id === o.ncaa_team_season_id);
    if (!ref) { conflicts.push({ season: o.season, override: o, reason: 'override team-season id not in the NCAA D1 reference' }); continue; }
    put(o.season, o.espn_team_id, { d1: true, conference: ref.conference, ncaa_id: o.ncaa_team_season_id, ncaa_name: ref.team, mapping: 'reviewed_override' });
  }
  const unmapped = {};
  for (const s of C.SEASONS) unmapped[s] = reference[s].filter((r) => !byNcaa.has(s + ':' + r.id)).map((r) => ({ team: r.team, id: r.id, conference: r.conference }));
  MEMBERSHIP = {
    of(season, espn) { return map.get(season + ':' + espn) || { d1: null, conference: null, ncaa_id: null, ncaa_name: null, mapping: 'UNKNOWN_MEMBERSHIP' }; },
    espnOfNcaa(season, ncaaId) { return byNcaa.get(season + ':' + ncaaId) || null; },
    espnOfNcaaName(season, name) {
      for (const [k, v] of map) if (k.startsWith(season + ':') && v.ncaa_name === name) return Number(k.split(':')[1]);
      return null;
    },
    audit: { bridge_rows: bridge.length, overrides: overrides.length, conflicts, d1_reference_unmapped: unmapped, reference_counts: Object.fromEntries(C.SEASONS.map((s) => [s, reference[s].length])) },
  };
  return MEMBERSHIP;
}

/* ---------------------------------------------------------------- players: fingerprint crosswalk */
const FP = ['pts', 'fgm', 'fga', 'tpm', 'tpa', 'ftm', 'fta', 'orb', 'drb', 'ast', 'stl', 'blk', 'tov', 'pf'];
function fingerprint(r) {
  const v = FP.map((k) => r[k]);
  if (v.some((x) => x == null)) return null;
  if (v.every((x) => x === 0)) return null; // an empty line identifies nobody
  return v.join(',');
}

/** ncaaRows: NCAA player games (pid, game_id, team, name, mins, stats); espnRows: ESPN player games (athlete, ...) */
function playerCrosswalk(ncaaRows, espnRows) {
  const espnBy = new Map();
  for (const r of espnRows) {
    if (r.season !== 2026) continue;
    const k = r.game_id + ':' + r.team; if (!espnBy.has(k)) espnBy.set(k, []); espnBy.get(k).push(r);
  }
  const ncaaBy = new Map();
  for (const r of ncaaRows) { const k = r.game_id + ':' + r.team; if (!ncaaBy.has(k)) ncaaBy.set(k, []); ncaaBy.get(k).push(r); }
  const votes = new Map(); // pid -> Map(athlete -> {n, minutes_diff})
  const games = { groups: 0, groups_without_espn: 0, ncaa_lines: 0, informative: 0, unique_matches: 0, ambiguous_lines: 0, unmatched_lines: 0 };
  const info = new Map(); // pid -> {name, team, lines}
  for (const [k, ns] of ncaaBy) {
    games.groups++;
    const es = espnBy.get(k);
    if (!es) { games.groups_without_espn++; continue; }
    const eCount = new Map(); const eRow = new Map();
    for (const e of es) { const f = fingerprint(e); if (!f) continue; eCount.set(f, (eCount.get(f) || 0) + 1); eRow.set(f, e); }
    const nCount = new Map();
    for (const r of ns) { const f = fingerprint(r); if (f) nCount.set(f, (nCount.get(f) || 0) + 1); }
    for (const r of ns) {
      games.ncaa_lines++;
      if (!info.has(r.pid)) info.set(r.pid, { name: r.name, team: r.team, informative: 0 });
      const f = fingerprint(r); if (!f) continue;
      games.informative++; info.get(r.pid).informative++;
      if (nCount.get(f) !== 1 || (eCount.get(f) || 0) > 1) { games.ambiguous_lines++; continue; }
      if (!eCount.get(f)) { games.unmatched_lines++; continue; }
      games.unique_matches++;
      const e = eRow.get(f);
      if (!votes.has(r.pid)) votes.set(r.pid, new Map());
      const v = votes.get(r.pid); const cur = v.get(e.athlete) || { n: 0, name: e.name, min_abs_diff: 0 };
      cur.n++; if (r.mins != null && e.min != null) cur.min_abs_diff += Math.abs(r.mins - e.min);
      v.set(e.athlete, cur);
    }
  }
  const proposals = [];
  for (const [pid, v] of votes) {
    const list = [...v.entries()].sort((a, b) => b[1].n - a[1].n);
    const total = list.reduce((s, x) => s + x[1].n, 0);
    const [athlete, best] = list[0];
    proposals.push({ pid, athlete, n: best.n, total, share: best.n / total, espn_name: best.name, mean_min_diff: best.min_abs_diff / best.n, rivals: list.slice(1).map(([a, x]) => ({ athlete: a, n: x.n })) });
  }
  const claimed = new Map();
  for (const p of proposals) if (p.n >= 2 && p.share >= 0.9) { if (!claimed.has(p.athlete)) claimed.set(p.athlete, []); claimed.get(p.athlete).push(p.pid); }
  const links = new Map(); const quarantine = [];
  let nameAgree = 0;
  for (const p of proposals) {
    const i = info.get(p.pid);
    const rec = { ncaa_player_id: p.pid, espn_athlete_id: p.athlete, fingerprint_games: p.n, fingerprint_share: Math.round(p.share * 1000) / 1000, ncaa_name: i.name, espn_name: p.espn_name, mean_abs_minutes_diff: Math.round(p.mean_min_diff * 100) / 100 };
    if (p.n < 2 || p.share < 0.9) { quarantine.push(Object.assign(rec, { reason: p.n < 2 ? 'ONE_FINGERPRINT_ONLY' : 'CONFLICTING_FINGERPRINTS', rivals: p.rivals })); continue; }
    if (claimed.get(p.athlete).length > 1) { quarantine.push(Object.assign(rec, { reason: 'ATHLETE_CLAIMED_BY_SEVERAL_NCAA_IDS', claimants: claimed.get(p.athlete) })); continue; }
    rec.name_agrees = normName(i.name) === normName(p.espn_name);
    if (rec.name_agrees) nameAgree++;
    links.set(p.pid, rec);
  }
  const noEvidence = [...info.entries()].filter(([pid]) => !votes.has(pid)).map(([pid, x]) => ({ ncaa_player_id: pid, ncaa_name: x.name, team: x.team, informative_lines: x.informative }));
  const athleteOf = new Map([...links.values()].map((l) => [l.ncaa_player_id, l.espn_athlete_id]));
  const pidOf = new Map([...links.values()].map((l) => [l.espn_athlete_id, l.ncaa_player_id]));
  return {
    links, athleteOf, pidOf, quarantine, no_evidence: noEvidence,
    audit: Object.assign(games, { ncaa_players: info.size, linked: links.size, quarantined: quarantine.length, without_any_fingerprint: noEvidence.length, linked_name_agreement: links.size ? Math.round((nameAgree / links.size) * 10000) / 10000 : null }),
  };
}

/* ---------------------------------------------------------------- publisher persons */
/** publisher RAPM rows of one season -> ESPN athletes of that season, by exact normalised name inside an explicitly mapped team-season */
function personToEspnByName(season, rapmRows, espnRows, membership) {
  const roster = new Map(); // espn team -> Map(normName -> Set(athlete))
  for (const r of espnRows) {
    if (r.season !== season || r.dnp || !(r.min > 0)) continue;
    if (!roster.has(r.team)) roster.set(r.team, new Map());
    const m = roster.get(r.team); const nm = normName(r.name); if (!nm) continue;
    if (!m.has(nm)) m.set(nm, new Set()); m.get(nm).add(r.athlete);
  }
  const out = new Map(); const stat = { rows: rapmRows.length, team_unmapped: 0, no_name_match: 0, ambiguous: 0, linked: 0 };
  const used = new Map();
  for (const r of rapmRows) {
    const team = membership.espnOfNcaaName(season, r.team);
    if (team == null) { stat.team_unmapped++; continue; }
    const nm = normName(String(r.player).replace(/\./g, ' '));
    const cands = roster.get(team) && roster.get(team).get(nm);
    if (!cands) { stat.no_name_match++; continue; }
    if (cands.size !== 1) { stat.ambiguous++; continue; }
    const a = [...cands][0];
    if (used.has(a)) { stat.ambiguous++; out.delete(used.get(a)); continue; }
    used.set(a, r.person_id); out.set(r.person_id, { athlete: a, team, player_id: r.player_id }); stat.linked++;
  }
  return { links: out, audit: stat };
}

module.exports = { normName, fingerprint, teamMembership, playerCrosswalk, personToEspnByName, FP };
