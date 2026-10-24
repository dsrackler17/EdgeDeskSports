'use strict';
/* ===========================================================================
   Data quality for the NCAAW forecast dataset: pure functions, tested offline
   (basketball/ncaaw_forecast/tests/model.test.js). The men's rules
   (basketball/ncaam_forecast/quality.js) with the women's facts: the event
   headlines and tournament ids of the women's postseason, the women's NCAA
   region names (city regions to 2022, "Regional N in City" from 2023), four
   quarters from 2016, and the two-shot-bonus possession constant.

   Nothing is silently dropped. A row that cannot be used is QUARANTINED: it
   stays in the dataset with its reasons, it is counted in the coverage report,
   and the model never reads it. Two levels, because a game can have a usable
   final score but no usable box score:

     score_ok  final score present, plausible, both team ids, not a duplicate:
               usable by a scores-only model (the incumbent baseline)
     box_ok    score_ok AND both team box lines present, paired and agreeing
               with the final score: usable by the possession-based model

   Identity. ESPN team ids are the stable entity ids (they persist across
   seasons and renames); names are labels only. Division I membership is per
   SEASON from the season-specific conference id each game carries: a team is
   D1 in season S when any of its games lists a conference for it (the men's
   rule, validated there against the NCAA's D1 reference; no women's reference
   is owned, so the women's counts per season are reported in the manifest and
   checked for plausibility by a test). A team
   without a conference is NOT asserted to be lower-division: it is UNKNOWN and
   is rated in the separate non-D1 regime (one pooled opponent per season).
   =========================================================================== */

const STATUS = { STATUS_FINAL: 'FINAL', STATUS_SCHEDULED: 'SCHEDULED', STATUS_POSTPONED: 'POSTPONED', STATUS_CANCELED: 'CANCELED', STATUS_CANCELLED: 'CANCELED',
  STATUS_FORFEIT: 'FORFEIT', STATUS_IN_PROGRESS: 'IN_PROGRESS', STATUS_HALFTIME: 'IN_PROGRESS', STATUS_END_PERIOD: 'IN_PROGRESS', STATUS_DELAYED: 'DELAYED', STATUS_SUSPENDED: 'SUSPENDED', STATUS_TBD: 'SCHEDULED' };
function statusOf(name, completed) {
  const s = STATUS[String(name || '')];
  if (s) return s === 'FINAL' && completed === false ? 'OTHER' : s;
  return 'OTHER';
}

/* measured in the source 2010-2026: 22 NCAA Women's Championship, 37 Women's NIT, 38 WBI, 62 WBIT (2024-) */
const TOURNAMENT = { NCAA: 22, NIT: 37, WBI: 38, WBIT: 62 };
function classifyEvent(r) {
  const h = String(r.notes_headline || '');
  if (Number(r.tournament_id) === TOURNAMENT.NCAA || /^NCAA WOMEN'S (BASKETBALL )?CHAMPIONSHIP/i.test(h)) return 'ncaa_tournament';
  if (Number(r.season_type) === 3) return Number(r.tournament_id) === TOURNAMENT.NIT || /^(WOMEN'S NIT|WNIT)\b/i.test(h) ? 'nit' : 'other_postseason';
  const month = Number(String(r.date || '').slice(5, 7));
  if (h && month >= 2 && month <= 4 && /(Tournament|Championship|Playoffs?)\b/i.test(h) && !/Invitational|Classic|Showcase/i.test(h)) return 'conference_tournament';
  if (h || String(r.type_abbreviation || '') === 'TRNMNT') return 'multi_team_event';
  return 'regular';
}

/** the region named in an NCAA headline, or null: "... - Albany Region - 1st Round"
    (to 2022) gives "Albany"; "... - Regional 1 in Spokane - 1st Round" (2023-,
    two regional sites with two regions each) gives "Spokane 1" */
const title = (x) => x.trim().replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\B\w+/g, (w) => w.toLowerCase());
function ncaaRegion(headline) {
  const h = String(headline || '');
  const n = /-\s*REGIONAL\s+(\d)\s+IN\s+([A-Za-z .]+?)\s*(-|$)/i.exec(h);
  if (n) return title(n[2]) + ' ' + n[1];
  const m = /-\s*([A-Za-z .]+?)\s+REGION\b/i.exec(h);
  return m ? title(m[1]) : null;
}

/* ------------------------------------------------------------------ NCAA bracket
   Rounds are derived from the bracket's STRUCTURE, never from headline names
   (the NCAA renamed its rounds in 2016: "First Round" meant the First Four in
   2011-2015). The final is the last game; every other game is the previous
   tournament game of a team in a later game, one level deeper. depth 0
   championship, 1 Final Four, 2 Elite 8, 3 Sweet 16, 4 second round (R32),
   5 first round (R64), 6 First Four. A slot that was never played (a
   no-contest walkover, 2021) is simply absent below its parent. */
const ROUND_BY_DEPTH = ['NC', 'F4', 'E8', 'S16', 'R32', 'R64', 'FF'];
function ncaaRounds(games) {
  const t = games.filter((g) => g.event === 'ncaa_tournament' && g.status === 'FINAL').slice().sort((a, b) => (a.start_utc < b.start_utc ? -1 : a.start_utc > b.start_utc ? 1 : String(a.game_id) < String(b.game_id) ? -1 : 1));
  const out = new Map(); const issues = [];
  if (!t.length) return { rounds: out, issues, games: 0 };
  const prevOf = (team, before) => { let p = null; for (const g of t) { if (g.start_utc >= before.start_utc || g === before) break; if (g.home_id === team || g.away_id === team) p = g; } return p; };
  const final = t[t.length - 1];
  const stack = [[final, 0]]; const seen = new Set();
  while (stack.length) {
    const [g, d] = stack.pop();
    if (seen.has(g.game_id)) { issues.push('game ' + g.game_id + ' reached twice'); continue; }
    seen.add(g.game_id);
    if (d >= ROUND_BY_DEPTH.length) { issues.push('game ' + g.game_id + ' deeper than the First Four'); continue; }
    out.set(g.game_id, ROUND_BY_DEPTH[d]);
    for (const team of [g.home_id, g.away_id]) {
      const p = prevOf(team, g);
      if (!p) continue;
      const winner = p.hs > p.as ? p.home_id : p.away_id;
      if (winner !== team) { issues.push('team ' + team + ' lost game ' + p.game_id + ' but played ' + g.game_id); continue; }
      stack.push([p, d + 1]);
    }
  }
  for (const g of t) if (!out.has(g.game_id)) issues.push('game ' + g.game_id + ' is not on any path to the final');
  return { rounds: out, issues, games: t.length };
}

/* Seeds. ESPN's tournament-game rank field carries the SEED during the NCAA
   tournament. It is accepted as a seed only when the whole season passes:
   every value is an integer 1-16, every first-round pair sums to 17, and every
   team shows one seed in all its tournament games. Otherwise no seed is
   recorded for that season (with the reason): an AP rank is never a seed. */
function ncaaSeeds(games, rounds) {
  const t = games.filter((g) => rounds.has(g.game_id));
  const have = t.filter((g) => g.home_rank != null && g.away_rank != null);
  if (!have.length) return { ok: false, reason: 'no tournament-game rank field in the source for this season', seeds: new Map() };
  const seeds = new Map(); const fail = [];
  for (const g of t) {
    for (const [team, s] of [[g.home_id, g.home_rank], [g.away_id, g.away_rank]]) {
      if (s == null) { fail.push('game ' + g.game_id + ' lacks a rank'); continue; }
      if (!(Number.isInteger(s) && s >= 1 && s <= 16)) { fail.push('rank ' + s + ' outside 1-16 in game ' + g.game_id); continue; }
      if (seeds.has(team) && seeds.get(team) !== s) fail.push('team ' + team + ' shows seeds ' + seeds.get(team) + ' and ' + s);
      seeds.set(team, s);
    }
    if (rounds.get(g.game_id) === 'R64' && g.home_rank + g.away_rank !== 17) fail.push('first-round game ' + g.game_id + ' seeds ' + g.home_rank + '+' + g.away_rank + ' != 17');
    if (rounds.get(g.game_id) === 'FF' && g.home_rank !== g.away_rank) fail.push('First Four game ' + g.game_id + ' pairs seeds ' + g.home_rank + ' and ' + g.away_rank);
  }
  const r64 = t.filter((g) => rounds.get(g.game_id) === 'R64').length;
  if (r64 < 31) fail.push('only ' + r64 + ' first-round games');
  return fail.length ? { ok: false, reason: fail.slice(0, 5).join('; '), seeds: new Map() } : { ok: true, reason: null, seeds, verified_by: 'every first-round pair sums to 17 and each team keeps one seed' };
}

/* ------------------------------------------------------------------ duplicates */
/** same two teams on the same game day under different ids: the later id is a suspect */
function duplicateSuspects(games) {
  const by = new Map(); const out = new Map();
  for (const g of games) {
    if (g.status !== 'FINAL' && g.status !== 'SCHEDULED') continue;
    const k = g.day + '|' + [g.home_id, g.away_id].sort().join('|');
    if (by.has(k)) {
      const first = by.get(k);
      /* a genuine doubleheader in one day does not happen in D1 basketball; a
         second id with the SAME final score is a duplicate record */
      out.set(g.game_id, { of: first.game_id, same_score: first.status === 'FINAL' && g.status === 'FINAL' && first.hs + first.as === g.hs + g.as });
    } else by.set(k, g);
  }
  return out;
}

/* ------------------------------------------------------------------ box scores */
/* the free-throw-trip constant of the possession estimate: 0.44, Dean Oliver's
   constant for a two-shot bonus (women's college basketball since 2015-16 has
   no one-and-one; the men's college constant 0.475 counts one-and-ones).
   External, never fitted on an outcome. */
const POSS_FTA = 0.44;
const BOX = ['fgm', 'fga', 'tpm', 'tpa', 'ftm', 'fta', 'orb', 'drb', 'tov', 'pf'];
/** pair the two box lines of a game and check them against the final score */
function boxCheck(g, lines) {
  if (!lines || !lines.length) return { ok: false, reason: 'BOX_MISSING' };
  if (lines.length !== 2) return { ok: false, reason: 'BOX_LINES_' + lines.length };
  const h = lines.find((l) => l.team_id === g.home_id); const a = lines.find((l) => l.team_id === g.away_id);
  if (!h || !a) return { ok: false, reason: 'BOX_TEAM_MISMATCH' };
  if (h.opp_id !== g.away_id || a.opp_id !== g.home_id) return { ok: false, reason: 'BOX_PAIR_FAIL' };
  if (h.pts !== g.hs || a.pts !== g.as) return { ok: false, reason: 'BOX_SCORE_MISMATCH' };
  for (const l of [h, a]) for (const k of BOX) if (!(Number.isFinite(l[k]) && l[k] >= 0)) return { ok: false, reason: 'BOX_FIELD_MISSING:' + k };
  for (const l of [h, a]) {
    if (l.fgm > l.fga || l.tpm > l.tpa || l.ftm > l.fta || l.tpa > l.fga) return { ok: false, reason: 'BOX_INCONSISTENT' };
    if (2 * (l.fgm - l.tpm) + 3 * l.tpm + l.ftm !== l.pts) return { ok: false, reason: 'BOX_POINTS_NE_SHOTS' };
  }
  const poss = (l) => l.fga - l.orb + l.tov + POSS_FTA * l.fta;
  const ph = poss(h); const pa = poss(a);
  if (!(ph > 40 && pa > 40 && ph < 140 && pa < 140)) return { ok: false, reason: 'BOX_POSSESSIONS_IMPLAUSIBLE' };
  return { ok: true, h, a };
}

/* ------------------------------------------------------------------ score sanity */
function scoreCheck(g) {
  const r = [];
  if (!g.home_id || !g.away_id) r.push('TEAM_ID_MISSING');
  if (g.home_id && g.home_id === g.away_id) r.push('SELF_GAME');
  if (g.status === 'FINAL') {
    if (!Number.isFinite(g.hs) || !Number.isFinite(g.as)) r.push('MISSING_SCORE');
    else {
      if (g.hs === g.as) r.push('TIED_FINAL');
      if (g.hs < 15 || g.as < 15 || g.hs > 200 || g.as > 200) r.push('IMPLAUSIBLE_SCORE');
    }
    /* regulation is 2 halves through 2015, 4 quarters from 2016 (the source's
       format_regulation_periods when present) */
    if (!(g.periods >= (g.regulation_periods || 2))) r.push('PERIODS_INVALID');
  }
  return r;
}

/* ------------------------------------------------------------------ membership */
/** season -> team -> { d1, conference, games } from the season-specific conference ids */
function membership(games) {
  const out = new Map();
  for (const g of games) {
    if (!out.has(g.season)) out.set(g.season, new Map());
    const m = out.get(g.season);
    for (const [t, c] of [[g.home_id, g.home_conf], [g.away_id, g.away_conf]]) {
      if (!t) continue;
      if (!m.has(t)) m.set(t, { confs: new Map(), games: 0 });
      const x = m.get(t); x.games++;
      if (c != null && c !== '') x.confs.set(c, (x.confs.get(c) || 0) + 1);
    }
  }
  const res = new Map();
  for (const [s, m] of out) {
    const r = new Map();
    for (const [t, x] of m) {
      const top = [...x.confs.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
      r.set(t, { d1: !!top, conference: top ? top[0] : null, conference_changes: x.confs.size > 1 ? [...x.confs.keys()] : null, games: x.games });
    }
    res.set(s, r);
  }
  return res;
}

module.exports = { statusOf, classifyEvent, ncaaRegion, ncaaRounds, ncaaSeeds, ROUND_BY_DEPTH, duplicateSuspects, boxCheck, scoreCheck, membership, BOX, TOURNAMENT, POSS_FTA };
