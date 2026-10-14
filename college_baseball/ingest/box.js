'use strict';
/* ===========================================================================
   EdgeDesk college baseball — box scores (2024-2026), checked before use.

   The source's box score has three row families per team per contest
   (batting, pitching, fielding), each ending in a TEAM TOTAL row whose name is
   the team's name. That total row is how a per-contest team id is tied to a
   program, and it is also a free reconciliation: the players must add up to
   it. A box whose players do not add up to their own total is flagged, and a
   pitching total whose outs cannot fit the innings played is flagged again in
   build.js once innings are known.

   INNINGS PITCHED ARE NOT DECIMALS. "5.1" is five innings and one out = 16
   outs. Everything is stored in outs; a value like "5.3" is invalid and
   flagged, never rounded.

   THE STARTER is the first pitcher listed for a team. That is the box-score
   convention; it is cross-checked against play-by-play pitching changes
   ("X to p for Y": the first Y is the starter) in validation/data_quality.json.

   PEOPLE. Roster player ids are re-issued every season (measured: zero ids
   shared between the 2024 and 2025 rosters), so a pitcher's history across
   seasons is linked by exact (name, hometown, high school) — which also
   follows transfers — and, failing that, by (program, name). An unlinked
   pitcher starts from the population prior; he is never guessed onto
   someone else's record.
   =========================================================================== */
const C = require('../config');
const K = require('./common');
const SRC = require('./sources');

const BAT = ['ab', 'r', 'h', '2b', '3b', 'hr', 'rbi', 'bb', 'hbp', 'sf', 'sh', 'k', 'sb', 'cs', 'ibb', 'opp_dp'];
const PIT = ['h', 'r', 'er', 'bb', 'so', 'bf', 'hr_a', 'hb', '2b_a', '3b_a', 'wp', 'bk', 'inh_run', 'inh_run_score', 'sha', 'sfa'];
const FLD = ['po', 'a', 'e', 'pb', 'sba', 'csb', 'idp', 'ci'];
const COLS = ['contest_id', 'team_id', 'name', 'position', 'category', 'ip'].concat([...new Set(BAT.concat(PIT).concat(FLD))]);

const TEAM_HEADER = ['game_id', 'season', 'date', 'team_id', 'team_name', 'side', 'opp_id', 'opp_name']
  .concat(BAT.map((k) => 'bat_' + k)).concat(['pit_outs'], PIT.map((k) => 'pit_' + k)).concat(FLD.map((k) => 'fld_' + k))
  .concat(['n_pitchers', 'n_batters', 'starter_person', 'starter_outs', 'starter_bf', 'total_checks', 'box_quality']);
const PITCHER_HEADER = ['game_id', 'season', 'date', 'team_id', 'opp_id', 'side', 'seq', 'starter', 'name', 'person_id', 'roster_id', 'class', 'outs', 'ip_raw']
  .concat(PIT);
const BATTER_HEADER = ['game_id', 'season', 'team_id', 'side', 'seq', 'name', 'person_id', 'position'].concat(BAT);

/* ---------------------------------------------------------------- people */
function rosterIndex(rosterRowsBySeason, idx) {
  /* person id = first season's roster id; later seasons linked by exact (name, hometown, high school) */
  const byBio = new Map();      // name|hometown|hs -> person id (null if ambiguous)
  const byTeamName = new Map(); // season:org:name -> {person, roster}
  const seasons = Object.keys(rosterRowsBySeason).map(Number).sort();
  for (const s of seasons) {
    const seenBio = new Map();
    for (const r of rosterRowsBySeason[s]) {
      const team = idx.seasonTeam(r.team_id);
      const org = team ? team.team_id : null;
      const nk = K.personKey(r.player_name);
      const bio = nk + '|' + K.normName(r.hometown) + '|' + K.normName(r.high_school);
      const hasBio = K.str(r.hometown) && K.str(r.high_school);
      let person = null;
      if (hasBio && byBio.has(bio) && byBio.get(bio)) person = byBio.get(bio);
      if (!person) person = `r${s}_${K.str(r.player_id)}`;
      if (hasBio) { if (seenBio.has(bio) && seenBio.get(bio) !== person) byBio.set(bio, null); else { seenBio.set(bio, person); if (!byBio.has(bio)) byBio.set(bio, person); } }
      if (org) {
        const tk = s + ':' + org + ':' + nk;
        if (byTeamName.has(tk) && byTeamName.get(tk).person !== person) byTeamName.set(tk, { person: null, ambiguous: true });
        else byTeamName.set(tk, { person, roster: K.str(r.player_id), cls: K.str(r.player_class), pos: K.str(r.position) });
      }
    }
  }
  return {
    find(season, org, name) {
      const hit = byTeamName.get(season + ':' + org + ':' + K.personKey(name));
      if (hit && hit.person) return hit;
      return { person: org ? `n:${org}:${K.personKey(name)}` : null, roster: '', cls: '', pos: '', unlinked: true };
    },
  };
}

/* ---------------------------------------------------------------- one contest */
function sumRows(rows, keys) { const o = {}; for (const k of keys) { let s = 0; let any = false; for (const r of rows) { const v = K.num(r[k]); if (v != null) { s += v; any = true; } } o[k] = any ? s : null; } return o; }

/** pure: the rows of one contest -> {teams:[...], pitchers:[...], batters:[...], problems:[...]} */
function foldContest(contestId, rows, ctx) {
  const problems = [];
  const g = ctx.games.get(contestId);   // {home_name, away_name, home_final, away_final}
  const byTeam = new Map();
  for (const r of rows) { const t = K.str(r.team_id); if (!byTeam.has(t)) byTeam.set(t, []); byTeam.get(t).push(r); }
  const names = g ? [K.normName(g.home_name), K.normName(g.away_name)] : [];
  const teams = []; const pitchers = []; const batters = [];
  for (const [tid, trs] of byTeam) {
    const cat = { batting: [], pitching: [], fielding: [] };
    for (const r of trs) if (cat[r.category]) cat[r.category].push(r);
    /* the team total row: named like a team. Prefer the games-table names; else the last pitching row */
    const isTotal = (r) => names.includes(K.normName(r.name));
    let total = { batting: cat.batting.find(isTotal), pitching: cat.pitching.find(isTotal), fielding: cat.fielding.find(isTotal) };
    if (!total.pitching && cat.pitching.length) total.pitching = cat.pitching[cat.pitching.length - 1];
    const teamName = total.pitching ? K.str(total.pitching.name) : (total.batting ? K.str(total.batting.name) : '');
    let side = null;
    if (g && K.normName(teamName) === K.normName(g.home_name)) side = 'H';
    else if (g && K.normName(teamName) === K.normName(g.away_name)) side = 'A';
    if (!side) problems.push({ kind: 'BOX_TEAM_UNRESOLVED', contest: contestId, detail: teamName });
    const org = ctx.idx.byName(ctx.season, teamName);
    const pl = { batting: cat.batting.filter((r) => r !== total.batting), pitching: cat.pitching.filter((r) => r !== total.pitching), fielding: cat.fielding.filter((r) => r !== total.fielding) };
    /* players must add up to the total row */
    const checks = [];
    const cmp = (label, rowsA, tot, keys) => {
      if (!tot) { checks.push(label + ':NO_TOTAL'); return; }
      const s = sumRows(rowsA, keys);
      const bad = keys.filter((k) => s[k] != null && K.num(tot[k]) != null && s[k] !== K.num(tot[k]));
      if (bad.length) checks.push(label + ':' + bad.join('+'));
    };
    cmp('bat', pl.batting, total.batting, ['ab', 'r', 'h', 'bb', 'k']);
    /* not ER: a team's earned runs legitimately differ from the sum of its
       pitchers' earned runs (reliever-inherited errors are charged to the
       team, not the pitcher), so that comparison would flag correct boxes */
    cmp('pit', pl.pitching, total.pitching, ['h', 'r', 'bb', 'so']);
    /* outs from IP text, per pitcher and in total */
    let outsSum = 0; let invalidIp = 0;
    const pitchRows = pl.pitching.map((r, i) => {
      const o = K.outsFromIp(r.ip);
      let outs = null;
      if (o && typeof o === 'object') invalidIp++; else if (o != null) { outs = o; outsSum += o; }
      return { r, outs, seq: i + 1 };
    });
    const totOuts = total.pitching ? K.outsFromIp(total.pitching.ip) : null;
    if (typeof totOuts === 'number' && totOuts !== outsSum) checks.push('pit:OUTS');
    if (invalidIp) checks.push('pit:INVALID_IP');
    for (const p of pitchRows) { if (K.num(p.r.er) != null && K.num(p.r.r) != null && K.num(p.r.er) > K.num(p.r.r)) checks.push('pit:ER_GT_R'); }
    const tb = total.batting || sumRows(pl.batting, BAT);
    const tp = total.pitching || sumRows(pl.pitching, PIT);
    const tf = total.fielding || sumRows(pl.fielding, FLD);
    const team = { game_id: 'ncaa_' + contestId, season: ctx.season, date: g ? g.date : '', team_id: org || '', team_name: teamName, side: side || '', opp_id: '', opp_name: '' };
    for (const k of BAT) team['bat_' + k] = K.num(tb[k]);
    team.pit_outs = typeof totOuts === 'number' ? totOuts : outsSum;
    for (const k of PIT) team['pit_' + k] = K.num(tp[k]);
    for (const k of FLD) team['fld_' + k] = K.num(tf[k]);
    team.n_pitchers = pl.pitching.length; team.n_batters = pl.batting.length;
    const st = pitchRows[0];
    const stPerson = st ? ctx.people.find(ctx.season, org, st.r.name) : null;
    team.starter_person = stPerson ? stPerson.person : ''; team.starter_outs = st ? st.outs : null; team.starter_bf = st ? K.num(st.r.bf) : null;
    team.total_checks = checks.join(' ');
    team.box_quality = !side ? 'UNRESOLVED_TEAM' : (checks.length ? 'CHECK_FAILED' : 'OK');
    teams.push(team);
    for (const p of pitchRows) {
      const who = ctx.people.find(ctx.season, org, p.r.name);
      const row = { game_id: team.game_id, season: ctx.season, date: team.date, team_id: org || '', opp_id: '', side: side || '', seq: p.seq, starter: p.seq === 1 ? 1 : 0,
        name: K.str(p.r.name), person_id: who.person || '', roster_id: who.roster || '', class: who.cls || '', outs: p.outs, ip_raw: K.str(p.r.ip) };
      for (const k of PIT) row[k] = K.num(p.r[k]);
      pitchers.push(row);
    }
    pl.batting.forEach((r, i) => {
      const who = ctx.people.find(ctx.season, org, r.name);
      const row = { game_id: team.game_id, season: ctx.season, team_id: org || '', side: side || '', seq: i + 1, name: K.str(r.name), person_id: who.person || '', position: K.str(r.position) };
      for (const k of BAT) row[k] = K.num(r[k]);
      batters.push(row);
    });
  }
  /* opponents */
  for (const t of teams) { const o = teams.find((x) => x !== t); if (o) { t.opp_id = o.team_id; t.opp_name = o.team_name; } }
  for (const p of pitchers) { const t = teams.find((x) => x.side === p.side); const o = teams.find((x) => x !== t); p.opp_id = o ? o.team_id : ''; }
  if (byTeam.size !== 2) problems.push({ kind: 'BOX_TEAM_COUNT', contest: contestId, detail: String(byTeam.size) });
  if (teams.length === 2 && teams[0].side && teams[0].side === teams[1].side) problems.push({ kind: 'BOX_SIDES_DUPLICATED', contest: contestId, detail: teams.map((t) => t.team_name).join(' / ') });
  return { teams, pitchers, batters, problems };
}

/* ---------------------------------------------------------------- linescore (independent of the box) */
function foldLinescore(rows) {
  const by = new Map();
  for (const r of rows) {
    const c = K.str(r.contest_id); if (!by.has(c)) by.set(c, { home: null, away: null, venue: '', date: '' });
    const g = by.get(c); const side = K.str(r.home_away) === 'home' ? 'home' : 'away';
    if (!g[side]) g[side] = { name: K.str(r.team), runs_total: K.int(r.runs_total), hits: K.int(r.hits), errors: K.int(r.errors), inn: [] };
    const inn = K.int(r.inning);
    if (inn) g[side].inn[inn - 1] = K.num(r.runs) == null ? 'x' : K.num(r.runs);
    g.venue = g.venue || K.str(r.venue) || K.str(r.location);
    const d = K.parseDate(r.game_date); g.date = g.date || (d ? d.date : '');
  }
  const out = new Map();
  for (const [c, g] of by) {
    if (!g.home || !g.away) continue;
    const played = Math.max(g.home.inn.length, g.away.inn.length);
    const line = (x) => { const a = []; for (let i = 0; i < played; i++) a.push(x.inn[i] === undefined ? 'x' : x.inn[i]); return a; };
    out.set(c, { home_name: g.home.name, away_name: g.away.name, home_runs: g.home.runs_total, away_runs: g.away.runs_total, home_hits: g.home.hits, away_hits: g.away.hits,
      home_errors: g.home.errors, away_errors: g.away.errors, innings_played: played, home_line: line(g.home), away_line: line(g.away), venue: g.venue, date: g.date });
  }
  return out;
}

async function run(season, idx, o) {
  o = o || {};
  const off = { offline: o.offline };
  const gamesRes = await SRC.parquet(C.SOURCE.urls.games(season), ['contest_id', 'away_team', 'away_final', 'home_team', 'home_final'], off);
  const lsRes = await SRC.parquet(C.SOURCE.urls.linescore(season), ['contest_id', 'team', 'home_away', 'inning', 'runs', 'runs_total', 'hits', 'errors', 'game_date', 'venue', 'location'], off);
  const linescore = foldLinescore(lsRes.rows);
  const games = new Map();
  for (const r of gamesRes.rows) {
    const c = K.str(r.contest_id);
    const ls = linescore.get(c);
    games.set(c, { home_name: K.str(r.home_team), away_name: K.str(r.away_team), home_final: K.int(r.home_final), away_final: K.int(r.away_final), date: ls ? ls.date : '' });
  }
  const rosters = {};
  for (let s = C.SEASONS.rosters[0]; s <= season; s++) {
    const rr = await SRC.parquet(C.SOURCE.urls.rosters(s), ['team_id', 'player_id', 'player_name', 'player_class', 'position', 'hometown', 'high_school'], off);
    rosters[s] = rr.rows;
  }
  const people = rosterIndex(rosters, idx);
  const ctx = { season, idx, games, people };
  const teams = []; const pitchers = []; const batters = []; const problems = [];
  let cur = null; let buf = []; const closed = new Set(); const split = [];
  const flush = () => {
    if (cur === null) return;
    if (closed.has(cur)) split.push(cur);
    closed.add(cur);
    const f = foldContest(cur, buf, ctx);
    teams.push(...f.teams); pitchers.push(...f.pitchers); batters.push(...f.batters); problems.push(...f.problems);
    buf = [];
  };
  const res = await SRC.parquetEach(C.SOURCE.urls.playerStats(season), COLS, (r) => {
    const c = K.str(r.contest_id); if (c !== cur) { flush(); cur = c; } buf.push(r);
  }, off);
  flush();
  if (!res.ok) return { ok: false, season, error: res.prov && res.prov.error };
  for (const k of split) problems.push({ kind: 'BOX_CONTEST_SPLIT', contest: k, detail: 'rows for this contest are not contiguous; both parts kept, flagged' });
  if (!o.check) {
    K.writeCsv(C.PATHS.teamGames(season), TEAM_HEADER, teams);
    K.writeCsv(C.PATHS.pitchers(season), PITCHER_HEADER, pitchers);
    K.writeCsv(C.PATHS.teamGames(season).replace('_team_games', '_batters'), BATTER_HEADER, batters);
  }
  return { ok: true, season, teams, pitchers, batters: batters.length, problems, linescore, gamesTable: games, missing_columns: res.missing };
}

module.exports = { run, foldContest, foldLinescore, rosterIndex, TEAM_HEADER, PITCHER_HEADER, BATTER_HEADER, COLS };
