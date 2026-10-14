'use strict';
/* ===========================================================================
   EdgeDesk college baseball — the schedule and results spine.

   ONE ROW PER CONTEST that involves at least one Division I program that
   season. Non-D-I opponents are kept (their division is on the row) because
   a D-I team's run totals against them are real games, but every model
   treats them separately (lib/team_quality.js).

   TWO SOURCE SHAPES.
     2012-2023  one row per contest (home/away, conferences, divisions,
                neutral site, extra innings). The 2023 season file is
                incomplete in the source; the per-team files are unioned in.
     2024-2026  one row per TEAM per contest: "W 5-3", "@ Opponent",
                "Opponent @Site" (neutral). Both perspectives of a D-I vs
                D-I game exist and are reconciled field by field.

   RECONCILIATION, NEVER "LAST ONE WINS". Every critical field (home/away
   assignment, neutral site, both scores, innings, status) is collected from
   every perspective and every independent source (season file, per-team
   files, the games table, the inning-by-inning linescore, play-by-play).
   The rule, in order:
     1. all observations agree                -> VERIFIED (or SINGLE_SOURCE)
     2. the official schedule perspectives agree and an independent record
        (linescore / play-by-play) agrees with them -> VERIFIED
     3. a strict majority of independent observations agree -> RESOLVED_MAJORITY,
        the losing values kept in provenance
     4. otherwise -> CONFLICT: the game is QUARANTINED (data/quarantine/), it is
        never rated or scored, and the reason is printed.

   Inning truth. The result text marks innings only when they differ from the
   scheduled length (and the 2012-2022 files only mark extra innings), so a
   seven-inning doubleheader game looks exactly like a nine-inning one there.
   Innings PLAYED come from the linescore (2024+) or play-by-play (2017+);
   the SCHEDULED length is inferred from them with an explicit basis
   (lib/rules.js). Before 2017 it is UNKNOWN and says so.
   =========================================================================== */
const C = require('../config');
const K = require('./common');
const SRC = require('./sources');
const TEAMS = require('./teams');

const GAME_HEADER = ['game_id', 'contest_id', 'season', 'date', 'start_time_local', 'dh', 'weekday',
  'home_id', 'away_id', 'home_name', 'away_name', 'home_div', 'away_div', 'home_conf', 'away_conf', 'conf_game',
  'neutral', 'site', 'park_key', 'home_basis', 'bats_last', 'status', 'home_runs', 'away_runs', 'innings_marker', 'innings_played',
  'scheduled_innings', 'scheduled_basis', 'ended_early', 'ncaa_tourney_inferred', 'conf_tourney_window', 'pbp_key', 'lines_src', 'away_line', 'home_line',
  'sources', 'n_observations', 'quality', 'quality_notes', 'known_at', 'assumed_available_at', 'pit'];

const QUAR_HEADER = ['game_id', 'season', 'date', 'home_name', 'away_name', 'field', 'observations', 'reason'];
const PROV_HEADER = ['game_id', 'field', 'original_value', 'canonical_value', 'source', 'source_record_id', 'event_time', 'collected_at', 'available_at', 'validation_status', 'conflict_status', 'quality_status'];

function idStr(v) { const s = K.str(v); return s.replace(/\.0+$/, ''); }
/* tournament pages prefix seeds ("#3 UMES"); the seed is not part of the name */
function stripSeed(v) { return K.str(v).replace(/^#\d+\s+/, ''); }

/* ---------------------------------------------------------------- shape 1: one row per contest */
function fromGameRows(rows, season, source) {
  const out = [];
  for (const r of rows) {
    const d = K.parseDate(r.date);
    if (!d) continue;
    const hs = K.int(r.home_team_score); const as = K.int(r.away_team_score);
    out.push({
      key: K.str(r.contest_id) ? 'c' + idStr(r.contest_id) : null, contest_id: idStr(r.contest_id), pbp_id: idStr(r.game_pbp_id),
      date: d.date, time: d.time, dh: d.dh,
      home_id: idStr(r.home_team_id), away_id: idStr(r.away_team_id), home_name: stripSeed(r.home_team), away_name: stripSeed(r.away_team),
      home_div: K.int(r.home_team_division), away_div: K.int(r.away_team_division),
      home_conf: K.str(r.home_team_conference), away_conf: K.str(r.away_team_conference),
      neutral: K.str(r.neutral_site) ? 1 : 0, site: K.str(r.neutral_site),
      status: hs != null && as != null ? 'FINAL' : 'NO_RESULT', home_runs: hs, away_runs: as,
      innings_marker: K.int(r.innings), source, season, file: r._file || source,
    });
  }
  return out;
}

/* ---------------------------------------------------------------- shape 2: one row per team per contest */
function parseOpponent(s) {
  const t = K.str(s);
  let m = /^@\s*(.+)$/.exec(t);
  if (m) return { role: 'AWAY', name: m[1].trim(), site: '' };
  m = /^(.+?)\s+@\s*(.+)$/.exec(t);
  if (m) return { role: 'NEUTRAL', name: m[1].trim(), site: m[2].trim() };
  return { role: 'HOME', name: t, site: '' };
}
function parseResult(s) {
  const t = K.str(s);
  let m = /^([WLT])\s+(\d+)\s*-\s*(\d+)(?:\s*\((\d+)\))?/.exec(t);
  if (m) return { status: 'FINAL', outcome: m[1], team: Number(m[2]), opp: Number(m[3]), innings: m[4] ? Number(m[4]) : null };
  if (/^ppd|postpon/i.test(t)) return { status: 'POSTPONED' };
  if (/cancel/i.test(t)) return { status: 'CANCELED' };
  if (/susp/i.test(t)) return { status: 'SUSPENDED' };
  if (!t || t === '-') return { status: 'NO_RESULT' };
  return { status: 'UNPARSED', raw: t };
}

function fromTeamRows(rows, season, idx, problems) {
  const persp = [];
  for (const r of rows) {
    const d = K.parseDate(r.date);
    if (!d) { problems.push({ kind: 'DATE_UNPARSED', season, detail: K.str(r.date) }); continue; }
    const team = idx.seasonTeam(r.team_id);
    const opp = idx.seasonTeam(r.opponent_id);
    const o = parseOpponent(r.opponent);
    const res = parseResult(r.result);
    if (res.status === 'UNPARSED') problems.push({ kind: 'RESULT_UNPARSED', season, detail: res.raw });
    persp.push({
      contest_id: idStr(r.contest_id), date: d.date, time: d.time, dh: d.dh || K.int(r.game_number),
      team_id: team ? team.team_id : null, team_name: team ? team.name : K.str(r.team_name), team_div: team ? team.division : K.int(r.division),
      opp_id: opp ? opp.team_id : null, opp_name: opp ? opp.name : o.name, opp_div: opp ? opp.division : null,
      role: o.role, site: o.site, res, raw_team_id: K.str(r.team_id), raw_opp_id: K.str(r.opponent_id),
    });
    if (!team) problems.push({ kind: 'SEASON_TEAM_UNMAPPED', season, detail: K.str(r.team_id) + ' ' + K.str(r.team_name) });
  }
  /* group perspectives into contests */
  const groups = new Map();
  for (const p of persp) {
    const pair = [p.team_id || p.team_name, p.opp_id || K.normName(p.opp_name)].sort().join('~');
    const key = p.contest_id ? 'c' + p.contest_id : `d${p.date}|${pair}|${p.dh || 0}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  const out = [];
  for (const [key, ps] of groups) {
    const obs = { role: [], score: [], status: [], innings: [] };
    let home = null; let away = null; let site = ''; let neutral = 0;
    for (const p of ps) {
      const me = { id: p.team_id, name: p.team_name, div: p.team_div };
      const them = { id: p.opp_id, name: p.opp_name, div: p.opp_div };
      let h; let a;
      if (p.role === 'HOME') { h = me; a = them; } else if (p.role === 'AWAY') { h = them; a = me; } else { h = null; a = null; }
      obs.role.push({ src: 'team:' + (p.team_id || p.team_name), role: p.role, home: h && (h.id || K.normName(h.name)), site: p.site });
      if (p.res.status === 'FINAL') {
        const hs = p.role === 'AWAY' ? p.res.opp : p.res.team; const as = p.role === 'AWAY' ? p.res.team : p.res.opp;
        /* a neutral perspective scores from its own side; it is re-oriented below once home is known */
        obs.score.push({ src: 'team:' + (p.team_id || p.team_name), role: p.role, team: p.team_id || p.team_name, teamScore: p.res.team, oppScore: p.res.opp, hs, as });
        obs.innings.push({ src: 'team:' + (p.team_id || p.team_name), v: p.res.innings });
      }
      obs.status.push({ src: 'team:' + (p.team_id || p.team_name), v: p.res.status });
      if (h && !home) { home = h; away = a; }
      if (p.role === 'NEUTRAL') { neutral = 1; site = site || p.site; if (!home) { home = me; away = them; } }
    }
    const p0 = ps[0];
    out.push({
      key, contest_id: p0.contest_id, date: p0.date, time: ps.map((p) => p.time).find(Boolean) || null, dh: ps.map((p) => p.dh).find((x) => x != null) || null,
      home_id: home.id || '', away_id: away.id || '', home_name: home.name, away_name: away.name, home_div: home.div, away_div: away.div,
      neutral, site, obs, perspectives: ps.length, season,
    });
  }
  return out;
}

/* ---------------------------------------------------------------- reconciliation of shape-2 contests */
function majority(values) {
  const c = new Map(); for (const v of values) c.set(v, (c.get(v) || 0) + 1);
  const sorted = [...c.entries()].sort((a, b) => b[1] - a[1]);
  if (!sorted.length) return { value: null, agree: true, n: 0 };
  const agree = sorted.length === 1;
  const strict = sorted.length === 1 || sorted[0][1] > sorted[1][1];
  return { value: strict ? sorted[0][0] : null, agree, strict, n: values.length, counts: sorted };
}

function reconcileTeamContest(g, extra) {
  /* extra: {home_key, away_key, home_runs, away_runs, innings, src} from linescore/games/pbp, oriented by name->id */
  const notes = []; const conflicts = [];
  /* home/away: role observations are self-consistent if no two perspectives both say HOME, or one NEUTRAL and one not */
  const roles = g.obs.role.map((o) => o.role);
  const neutralVotes = roles.filter((r) => r === 'NEUTRAL').length;
  if (neutralVotes && neutralVotes !== roles.length) conflicts.push({ field: 'neutral', obs: roles.join('/'), reason: 'one perspective lists a neutral site, the other a home game' });
  if (roles.filter((r) => r === 'HOME').length > 1) conflicts.push({ field: 'home_away', obs: roles.join('/'), reason: 'both perspectives claim the home game' });
  if (roles.filter((r) => r === 'AWAY').length > 1) conflicts.push({ field: 'home_away', obs: roles.join('/'), reason: 'both perspectives claim the road game' });
  /* orientation for neutral games: the linescore / games table says who batted last */
  let home_basis = g.neutral ? 'FIRST_PERSPECTIVE' : 'SCHEDULE';
  let swapped = false; let batsLastCandidate = null;
  if (extra && extra.home_key && g.neutral) {
    const hk = extra.home_key;
    if (hk === (g.away_id || K.normName(g.away_name))) swapped = true;
    if (hk === (g.home_id || K.normName(g.home_name)) || swapped) home_basis = extra.src.toUpperCase() + '_BATS_LAST';
  } else if (extra && extra.home_key && !g.neutral) {
    /* the venue host is not always the side that bats last (NCAA tournament
       games at a host site designate home by bracket). One independent source
       saying so is a candidate; build.js confirms it with a second (pbp)
       before it is accepted, otherwise it is a conflict. */
    const hk = extra.home_key;
    if (hk !== (g.home_id || K.normName(g.home_name)) && hk === (g.away_id || K.normName(g.away_name))) batsLastCandidate = { side: 'A', src: extra.src };
  }
  if (swapped) {
    [g.home_id, g.away_id] = [g.away_id, g.home_id]; [g.home_name, g.away_name] = [g.away_name, g.home_name]; [g.home_div, g.away_div] = [g.away_div, g.home_div];
  }
  const hkey = g.home_id || K.normName(g.home_name);
  /* scores, oriented to the (possibly swapped) home side */
  const scoreObs = g.obs.score.map((s) => {
    if (s.role === 'NEUTRAL') return s.team === hkey ? `${s.teamScore}-${s.oppScore}` : `${s.oppScore}-${s.teamScore}`;
    return swapped ? `${s.as}-${s.hs}` : `${s.hs}-${s.as}`;
  });
  const statusObs = g.obs.status.map((s) => s.v);
  const st = majority(statusObs);
  let status = st.value || 'CONFLICT';
  if (!st.agree) {
    /* one side posted a final and the other did not update: the final wins only if it is the majority of finals with an independent check */
    if (statusObs.includes('FINAL') && extra && extra.home_runs != null) status = 'FINAL';
    else conflicts.push({ field: 'status', obs: statusObs.join('/'), reason: 'perspectives disagree on whether the game was played' });
    notes.push('status perspectives ' + statusObs.join('/'));
  }
  let home_runs = null; let away_runs = null; let quality = 'SINGLE_SOURCE';
  if (status === 'FINAL') {
    const all = scoreObs.slice();
    const ex = extra && extra.home_runs != null ? (batsLastCandidate ? `${extra.away_runs}-${extra.home_runs}` : `${extra.home_runs}-${extra.away_runs}`) : null;
    if (ex) all.push(ex);
    const m = majority(all);
    const sch = majority(scoreObs);
    if (m.agree) quality = all.length > 1 ? 'VERIFIED' : 'SINGLE_SOURCE';
    else if (sch.agree && ex && sch.value === ex) quality = 'VERIFIED';
    else if (m.strict) { quality = 'RESOLVED_MAJORITY'; notes.push('score observations ' + all.join('/')); }
    else conflicts.push({ field: 'score', obs: all.join('/'), reason: 'no strict majority among score observations' });
    const v = m.value || (m.strict ? m.value : null);
    if (v) { const [h, a] = v.split('-').map(Number); home_runs = h; away_runs = a; }
  }
  const inn = majority(g.obs.innings.map((o) => o.v == null ? 'none' : String(o.v)));
  const innings_marker = inn.value && inn.value !== 'none' ? Number(inn.value) : null;
  if (!inn.agree) notes.push('innings markers ' + g.obs.innings.map((o) => o.v).join('/'));
  if (conflicts.length) quality = 'CONFLICT';
  return { status, home_runs, away_runs, innings_marker, quality, notes, conflicts, home_basis, scoreObs, batsLastCandidate };
}

/* ---------------------------------------------------------------- shape-1 duplicates */
function reconcileGameRows(copies) {
  const notes = []; const conflicts = [];
  const g = Object.assign({}, copies[0]);
  /* MIRROR COPIES: each school's own page lists the game as its home game
     (conference tournaments at a host or neutral park). The scores agree once
     oriented; only the home designation is disputed. That is not a score
     conflict: the game is kept, treated as neutral (no home advantage is
     credited to either side), and play-by-play decides who batted last. */
  const mirrored = copies.some((c) => c.home_id && c.home_id === g.away_id && c.away_id === g.home_id);
  if (mirrored) {
    const oriented = copies.map((c) => (c.home_id === g.home_id ? `${c.home_runs}-${c.away_runs}` : `${c.away_runs}-${c.home_runs}`));
    const m = majority(oriented.filter((v) => !/null|undefined/.test(v)));
    if (m.agree && m.n) {
      const [h, a] = m.value.split('-').map(Number);
      Object.assign(g, { home_runs: h, away_runs: a, neutral: 1, site: g.site || 'home_disputed', status: 'FINAL' });
      const srcs = [...new Set(copies.map((c) => c.source))];
      return { g, notes: ['home designation disputed between copies (mirror); treated as neutral'], conflicts, quality: 'VERIFIED_MIRROR', sources: srcs, mirror: true };
    }
    conflicts.push({ field: 'score', obs: oriented.join('/'), reason: 'mirror copies disagree on the score' });
  }
  const fields = ['home_id', 'away_id', 'home_runs', 'away_runs', 'neutral', 'date'];
  for (const f of fields) {
    const vals = copies.map((c) => String(c[f]));
    const m = majority(vals);
    if (m.agree) continue;
    if (m.strict) { notes.push(`${f}: ${vals.join('/')}`); const pick = copies.find((c) => String(c[f]) === m.value); g[f] = pick[f]; }
    else {
      /* a copy with a missing score is an un-updated row, not a disagreement */
      const nonNull = copies.filter((c) => c[f] != null && c[f] !== '');
      const m2 = majority(nonNull.map((c) => String(c[f])));
      if (nonNull.length && m2.agree) { g[f] = nonNull[0][f]; notes.push(`${f}: filled from ${nonNull.length}/${copies.length} copies`); }
      else conflicts.push({ field: f, obs: vals.join('/'), reason: 'copies of the contest disagree' });
    }
  }
  if (g.home_runs != null && g.away_runs != null) g.status = 'FINAL';
  const srcs = [...new Set(copies.map((c) => c.source))];
  return { g, notes, conflicts, quality: conflicts.length ? 'CONFLICT' : (copies.length > 1 && srcs.length > 1 ? 'VERIFIED' : (copies.length > 1 ? 'VERIFIED_DUPLICATE' : 'SINGLE_SOURCE')), sources: srcs };
}

module.exports = { stripSeed, GAME_HEADER, QUAR_HEADER, PROV_HEADER, fromGameRows, fromTeamRows, parseOpponent, parseResult, reconcileTeamContest, reconcileGameRows, majority, idStr };
