'use strict';
/* ===========================================================================
   Ingestion: the data pack, typed, identified and flagged — never rewritten.

   Every table is read from datapack/ncaam_v1 after its SHA-256 matches the
   pack inventory (a mismatch stops the run: source releases change, and a
   changed file needs an explicit version review). Each load returns its
   provenance: file, delivered hash, source release URL and update time, and
   when this repository observed it (the import date). Source values are kept;
   every interpretation is a separate, named field.

   Namespaces are never mixed:
     ESPN       game_id, team_id, athlete_id            (stable across seasons)
     NCAA       contest_id, team-season id, player_id   (season-specific)
     publisher  person_id                               (RAPM tables only)
   Joins use explicit ids or the crosswalks in identity.js. Names are labels.

   Game context: game day = UTC start - 10 h (a late tip keeps its evening's
   date); halves and 5-minute overtimes from the native period count; neutral,
   conference, multi-team event, conference tournament, NCAA, NIT and other
   postseason; postponed and canceled games are kept and labelled, never
   scored. D1 membership is per season (identity.js); a failed match is
   UNKNOWN membership, never proof of a lower division.
   =========================================================================== */
const C = require('./config');
const T = require('./lib/table');
const ID = require('./identity');

const memo = new Map();
function once(key, fn) { if (!memo.has(key)) memo.set(key, fn()); return memo.get(key); }

const { read, verify, PROVENANCE } = require('./lib/pack');

/* ---------------------------------------------------------------- helpers */
const isNum = (v) => typeof v === 'number' && !Number.isNaN(v);
const nn = (v) => (isNum(v) ? v : null);
const gameDay = (ms) => new Date(ms - 10 * 3600e3).toISOString().slice(0, 10);
function parseUtc(s) {
  if (!s) return NaN;
  const t = String(s).replace(/Z$/, ':00Z').replace(/:(\d\d):00Z$/, ':$1Z');
  const ms = Date.parse(/T\d\d:\d\d(:\d\d)?Z$/.test(t) ? t : s);
  return ms;
}

/* men's rules: two 20-minute halves; periods 3+ are 5-minute overtimes */
function overtimes(status, periods) { return status === 'FINAL' && periods != null && periods >= C.RULES.halves ? periods - C.RULES.halves : null; }
function gameMinutes(nOt) { return nOt == null ? null : C.RULES.regulation_minutes + C.RULES.overtime_minutes * nOt; }

function classifyEvent(seasonType, typeAbbr, headline, month) {
  const h = headline || '';
  if (seasonType === 3) {
    if (/^NCAA Men's Basketball Championship/i.test(h)) return 'ncaa_tournament';
    if (/^NIT\b/.test(h)) return 'nit';
    return 'other_postseason';
  }
  if (typeAbbr === 'TRNMNT') {
    if (month >= 2 && month <= 4 && /(Tournament|Championship|Playoffs)/i.test(h)) return 'conference_tournament';
    return 'multi_team_event';
  }
  return 'regular';
}

/* ---------------------------------------------------------------- games */
const SCHED_COLS = {
  game_id: 'num', season: 'num', season_type: 'num', date: 'str', status_type_name: 'str', status_type_completed: 'bool',
  status_period: 'num', format_regulation_periods: 'num', neutral_site: 'bool', conference_competition: 'bool', type_abbreviation: 'str',
  notes_headline: 'str', tournament_id: 'num', venue_id: 'num', venue_full_name: 'str', venue_address_city: 'str', venue_address_state: 'str',
  home_id: 'num', home_display_name: 'str', home_location: 'str', home_name: 'str', home_abbreviation: 'str', home_color: 'str', home_conference_id: 'num', home_score: 'num',
  away_id: 'num', away_display_name: 'str', away_location: 'str', away_name: 'str', away_abbreviation: 'str', away_color: 'str', away_conference_id: 'num', away_score: 'num',
};

function loadGames() {
  return once('games', async () => {
    const membership = await ID.teamMembership();
    const games = []; const teams = new Map(); const stats = {};
    for (const season of C.SEASONS) {
      const t = await read('espn_mbb_schedule_' + season, SCHED_COLS); const c = t.cols;
      const st = stats[season] = { rows: t.n, final: 0, postponed: 0, canceled: 0, scheduled: 0, other_status: 0, duplicate_ids: 0 };
      const seen = new Set();
      for (let i = 0; i < t.n; i++) {
        const id = c.game_id[i];
        if (seen.has(id)) { st.duplicate_ids++; continue; } seen.add(id);
        const name = c.status_type_name[i] || '';
        const status = name === 'STATUS_FINAL' ? 'FINAL' : name === 'STATUS_POSTPONED' ? 'POSTPONED' : name === 'STATUS_CANCELED' ? 'CANCELED' : name === 'STATUS_SCHEDULED' ? 'SCHEDULED' : 'OTHER';
        st[status === 'OTHER' ? 'other_status' : status.toLowerCase()]++;
        const start = parseUtc(c.date[i]);
        const periods = nn(c.status_period[i]);
        const regPeriods = nn(c.format_regulation_periods[i]);
        const nOt = overtimes(status, periods);
        const month = new Date(start).getUTCMonth() + 1;
        const home = c.home_id[i]; const away = c.away_id[i];
        const mh = membership.of(season, home); const ma = membership.of(season, away);
        const g = {
          game_id: id, season, start_ms: start, start_utc: new Date(start).toISOString(), day: gameDay(start), status,
          season_type: c.season_type[i], event: classifyEvent(c.season_type[i], c.type_abbreviation[i], c.notes_headline[i], month),
          event_name: c.notes_headline[i] || null, tournament_id: nn(c.tournament_id[i]),
          neutral: c.neutral_site[i] === 1, conference_game: c.conference_competition[i] === 1,
          venue: { id: nn(c.venue_id[i]), name: c.venue_full_name[i], city: c.venue_address_city[i], state: c.venue_address_state[i] },
          home, away, hs: nn(c.home_score[i]), as: nn(c.away_score[i]),
          periods, regulation_periods_native: regPeriods, n_ot: nOt,
          minutes: gameMinutes(nOt),
          home_d1: mh.d1, away_d1: ma.d1,
          regime: mh.d1 === true && ma.d1 === true ? 'D1_D1' : (mh.d1 === true || ma.d1 === true) ? 'D1_OTHER' : 'OTHER_OTHER',
        };
        if (regPeriods != null && regPeriods !== C.RULES.halves) g.rule_flag = 'native regulation periods ' + regPeriods + ' (expected 2 halves)';
        games.push(g);
        for (const side of ['home', 'away']) {
          const tid = c[side + '_id'][i]; if (!isNum(tid)) continue;
          if (!teams.has(tid)) teams.set(tid, { id: tid, names: new Set(), seasons: {} });
          const tm = teams.get(tid);
          tm.display = c[side + '_display_name'][i] || tm.display; tm.location = c[side + '_location'][i] || tm.location;
          tm.nickname = c[side + '_name'][i] || tm.nickname; tm.abbrev = c[side + '_abbreviation'][i] || tm.abbrev;
          tm.color = c[side + '_color'][i] || tm.color; tm.names.add(c[side + '_display_name'][i]);
          const m = membership.of(season, tid);
          tm.seasons[season] = { d1: m.d1, conference: m.conference, ncaa_team_season_id: m.ncaa_id, ncaa_name: m.ncaa_name, mapping: m.mapping };
        }
      }
    }
    games.sort((a, b) => a.start_ms - b.start_ms || a.game_id - b.game_id);
    for (const tm of teams.values()) tm.names = [...tm.names];
    return { games, teams, stats, byId: new Map(games.map((g) => [g.game_id, g])) };
  });
}

/* ---------------------------------------------------------------- team games */
const ESPN_TEAM_COLS = {
  game_id: 'num', season: 'num', team_id: 'num', opponent_team_id: 'num', team_home_away: 'str', team_score: 'num', opponent_team_score: 'num',
  field_goals_made: 'num', field_goals_attempted: 'num', three_point_field_goals_made: 'num', three_point_field_goals_attempted: 'num',
  free_throws_made: 'num', free_throws_attempted: 'num', offensive_rebounds: 'num', defensive_rebounds: 'num', total_rebounds: 'num',
  assists: 'num', steals: 'num', blocks: 'num', total_turnovers: 'num', fouls: 'num', technical_fouls: 'num',
  fast_break_points: 'num', points_in_paint: 'num', turnover_points: 'num',
};
const NCAA_TEAM_COLS = {
  contest_id: 'str', espn_game_id: 'num', team_espn_team_id: 'num', team_ncaa_team_id: 'str', mins: 'num', o_poss: 'num', d_poss: 'num',
  pts: 'num', d_pts: 'num', fga: 'num', fgm: 'num', tpa: 'num', tpm: 'num', fta: 'num', ftm: 'num',
  rima: 'num', rimm: 'num', d_rima: 'num', d_rimm: 'num', rim_rate: 'num', mid_rate: 'num', mid_pct: 'num', d_rim_rate: 'num', d_mid_rate: 'num', d_mid_pct: 'num',
  d_fga: 'num', d_tpa: 'num', d_tpm: 'num', orb: 'num', drb: 'num', to: 'num', d_to: 'num', ast: 'num', d_ast: 'num', blk: 'num', d_blk: 'num',
  time_per_poss: 'num', d_time_per_poss: 'num', e_poss: 'num',
};

function loadTeamGames() {
  return once('teamGames', async () => {
    const G = await loadGames();
    const rows = []; const audit = {};
    for (const season of C.SEASONS) {
      const e = await read('espn_team_box_' + season, ESPN_TEAM_COLS); const c = e.cols;
      const n = await read('ncaa_mbb_team_box_' + season, NCAA_TEAM_COLS); const d = n.cols;
      const ncaa = new Map();
      let ncaaDup = 0; let ncaaNoEspn = 0;
      for (let i = 0; i < n.n; i++) {
        if (!isNum(d.espn_game_id[i]) || !isNum(d.team_espn_team_id[i])) { ncaaNoEspn++; continue; }
        const k = d.espn_game_id[i] + ':' + d.team_espn_team_id[i];
        if (ncaa.has(k)) { ncaaDup++; ncaa.set(k, -1); continue; }
        ncaa.set(k, i);
      }
      const a = audit[season] = { espn_rows: e.n, ncaa_rows: n.n, ncaa_without_espn_ids: ncaaNoEspn, ncaa_duplicate_keys: ncaaDup, joined: 0, discrepant: 0, discrepancy_fields: {}, schedule_score_mismatch: 0, not_in_schedule: 0 };
      for (let i = 0; i < e.n; i++) {
        const gid = c.game_id[i]; const g = G.byId.get(gid);
        if (!g) { a.not_in_schedule++; continue; }
        const tg = {
          game_id: gid, season, team: c.team_id[i], opp: c.opponent_team_id[i], side: c.team_home_away[i],
          pts: nn(c.team_score[i]), opp_pts: nn(c.opponent_team_score[i]),
          fgm: nn(c.field_goals_made[i]), fga: nn(c.field_goals_attempted[i]), tpm: nn(c.three_point_field_goals_made[i]), tpa: nn(c.three_point_field_goals_attempted[i]),
          ftm: nn(c.free_throws_made[i]), fta: nn(c.free_throws_attempted[i]), orb: nn(c.offensive_rebounds[i]), drb: nn(c.defensive_rebounds[i]),
          ast: nn(c.assists[i]), stl: nn(c.steals[i]), blk: nn(c.blocks[i]), tov: nn(c.total_turnovers[i]), pf: nn(c.fouls[i]),
          fb_pts: nn(c.fast_break_points[i]), paint_pts: nn(c.points_in_paint[i]), tov_pts: nn(c.turnover_points[i]),
          flags: [],
        };
        const expect = tg.side === 'home' ? g.hs : g.as;
        if (expect != null && tg.pts !== expect) { a.schedule_score_mismatch++; tg.flags.push('ESPN_BOX_SCORE_NE_SCHEDULE'); }
        const j = ncaa.get(gid + ':' + tg.team);
        if (j != null && j >= 0) {
          a.joined++;
          const delta = { pts: d.pts[j] - tg.pts, fgm: d.fgm[j] - tg.fgm, fga: d.fga[j] - tg.fga, tpm: d.tpm[j] - tg.tpm, tpa: d.tpa[j] - tg.tpa, ftm: d.ftm[j] - tg.ftm, fta: d.fta[j] - tg.fta };
          const bad = Object.keys(delta).filter((k) => !isNum(delta[k]) || delta[k] !== 0);
          tg.ncaa = {
            contest_id: d.contest_id[j], team_season_id: d.team_ncaa_team_id[j], o_poss: nn(d.o_poss[j]), d_poss: nn(d.d_poss[j]), mins: nn(d.mins[j]),
            rima: nn(d.rima[j]), rimm: nn(d.rimm[j]), opp_rima: nn(d.d_rima[j]), opp_rimm: nn(d.d_rimm[j]),
            mida: isNum(d.mid_rate[j]) && isNum(d.fga[j]) ? Math.round(d.mid_rate[j] * d.fga[j]) : null,
            opp_mida: isNum(d.d_mid_rate[j]) && isNum(d.d_fga[j]) ? Math.round(d.d_mid_rate[j] * d.d_fga[j]) : null,
            mid_pct: nn(d.mid_pct[j]), opp_mid_pct: nn(d.d_mid_pct[j]),
            sec_per_poss: nn(d.time_per_poss[j]), opp_sec_per_poss: nn(d.d_time_per_poss[j]), ast: nn(d.ast[j]), opp_ast: nn(d.d_ast[j]),
          };
          if (bad.length) {
            a.discrepant++; for (const k of bad) a.discrepancy_fields[k] = (a.discrepancy_fields[k] || 0) + 1;
            tg.flags.push('NCAA_DETAIL_DISAGREES_WITH_BOX:' + bad.join('+'));
            tg.ncaa.quarantined = true; tg.ncaa.delta = delta;
          }
        }
        rows.push(tg);
      }
    }
    // pair integrity: both sides of a game present, opponents agree
    const byGame = new Map();
    for (const r of rows) { if (!byGame.has(r.game_id)) byGame.set(r.game_id, []); byGame.get(r.game_id).push(r); }
    let pairs = 0; let broken = 0;
    for (const [gid, rs] of byGame) {
      if (rs.length !== 2 || rs[0].opp !== rs[1].team || rs[1].opp !== rs[0].team || rs[0].pts !== rs[1].opp_pts) { broken++; for (const r of rs) r.flags.push('PAIR_INTEGRITY_FAIL'); continue; }
      pairs++; rs[0].o = rs[1]; rs[1].o = rs[0];
    }
    return { rows, byGame, audit, pairs, broken_pairs: broken };
  });
}

/* ---------------------------------------------------------------- player games (ESPN) */
const ESPN_PLAYER_COLS = {
  game_id: 'num', season: 'num', team_id: 'num', athlete_id: 'num', athlete_display_name: 'str', athlete_jersey: 'str', athlete_position_abbreviation: 'str',
  minutes: 'num', field_goals_made: 'num', field_goals_attempted: 'num', three_point_field_goals_made: 'num', three_point_field_goals_attempted: 'num',
  free_throws_made: 'num', free_throws_attempted: 'num', offensive_rebounds: 'num', defensive_rebounds: 'num', assists: 'num', steals: 'num', blocks: 'num',
  turnovers: 'num', fouls: 'num', points: 'num', starter: 'bool', did_not_play: 'bool', ejected: 'bool', active: 'bool', home_away: 'str',
};

function loadPlayerGames() {
  return once('playerGames', async () => {
    const G = await loadGames();
    const rows = []; const audit = {};
    for (const season of C.SEASONS) {
      const t = await read('espn_player_box_' + season, ESPN_PLAYER_COLS); const c = t.cols;
      const a = audit[season] = { rows: t.n, missing_athlete_id: 0, duplicate_identity: 0, dnp: 0, zero_minutes_played: 0, null_minutes: 0, not_in_schedule: 0 };
      const seen = new Set();
      for (let i = 0; i < t.n; i++) {
        const g = G.byId.get(c.game_id[i]);
        if (!g) { a.not_in_schedule++; continue; }
        const aid = nn(c.athlete_id[i]);
        if (aid == null) { a.missing_athlete_id++; continue; } // unknown identity: kept out of every player history
        const k = c.game_id[i] + ':' + aid;
        if (seen.has(k)) { a.duplicate_identity++; continue; } seen.add(k);
        const dnp = c.did_not_play[i] === 1;
        if (dnp) a.dnp++;
        const min = nn(c.minutes[i]);
        if (min == null) a.null_minutes++; else if (min === 0 && !dnp) a.zero_minutes_played++;
        rows.push({
          game_id: c.game_id[i], season, team: c.team_id[i], athlete: aid, name: c.athlete_display_name[i], jersey: c.athlete_jersey[i],
          pos: c.athlete_position_abbreviation[i] || null, min, starter: c.starter[i] === 1, dnp, ejected: c.ejected[i] === 1,
          fgm: nn(c.field_goals_made[i]), fga: nn(c.field_goals_attempted[i]), tpm: nn(c.three_point_field_goals_made[i]), tpa: nn(c.three_point_field_goals_attempted[i]),
          ftm: nn(c.free_throws_made[i]), fta: nn(c.free_throws_attempted[i]), orb: nn(c.offensive_rebounds[i]), drb: nn(c.defensive_rebounds[i]),
          ast: nn(c.assists[i]), stl: nn(c.steals[i]), blk: nn(c.blocks[i]), tov: nn(c.turnovers[i]), pf: nn(c.fouls[i]), pts: nn(c.points[i]),
          start_ms: g.start_ms,
        });
      }
    }
    rows.sort((x, y) => x.start_ms - y.start_ms || x.game_id - y.game_id);
    return { rows, audit };
  });
}

/* ---------------------------------------------------------------- NCAA player games (2026) */
const NCAA_PLAYER_COLS = {
  contest_id: 'str', espn_game_id: 'num', team_espn_team_id: 'num', team_ncaa_team_id: 'str', player_id: 'num', clean_name: 'str', player: 'str',
  mins: 'num', o_poss: 'num', pts: 'num', orb: 'num', drb: 'num', ast: 'num', stl: 'num', blk: 'num', tov: 'num', pf: 'num',
  fgm: 'num', fga: 'num', tpm: 'num', tpa: 'num', ftm: 'num', fta: 'num', rimm: 'num', rima: 'num', midm: 'num', mida: 'num', pbackm: 'num', pbacka: 'num',
  blk_rim: 'num', blk_mid: 'num', blk_three: 'num', fga_trans: 'num', fgm_trans: 'num', tpa_trans: 'num', tpm_trans: 'num', rima_trans: 'num', rimm_trans: 'num',
  pts_trans: 'num', tov_trans: 'num', fgm_ast: 'num', tpm_ast: 'num', rimm_ast: 'num', midm_ast: 'num', fgm_unast: 'num', fga_unast: 'num', pts_ast: 'num', pts_unast: 'num',
};

function loadNcaaPlayerGames() {
  return once('ncaaPlayerGames', async () => {
    const G = await loadGames();
    const t = await read('ncaa_mbb_player_box_2026', NCAA_PLAYER_COLS); const c = t.cols;
    const rows = []; const a = { rows: t.n, missing_player_id: 0, missing_espn_ids: 0, duplicate_identity: 0 };
    const seen = new Set();
    for (let i = 0; i < t.n; i++) {
      const pid = nn(c.player_id[i]);
      if (pid == null) { a.missing_player_id++; continue; }
      if (!isNum(c.espn_game_id[i]) || !isNum(c.team_espn_team_id[i])) { a.missing_espn_ids++; continue; }
      const k = c.contest_id[i] + ':' + pid;
      if (seen.has(k)) { a.duplicate_identity++; continue; } seen.add(k);
      const o = { game_id: c.espn_game_id[i], contest_id: c.contest_id[i], team: c.team_espn_team_id[i], team_season_id: c.team_ncaa_team_id[i], pid, name: c.clean_name[i], raw_name: c.player[i] };
      for (const f of Object.keys(NCAA_PLAYER_COLS)) if (NCAA_PLAYER_COLS[f] === 'num' && !(f in o) && f !== 'player_id' && f !== 'espn_game_id' && f !== 'team_espn_team_id') o[f] = nn(c[f][i]);
      const g = G.byId.get(o.game_id); o.start_ms = g ? g.start_ms : null;
      rows.push(o);
    }
    return { rows, audit: a };
  });
}

/* ---------------------------------------------------------------- possessions (2026) */
function loadPossessions() {
  return once('possessions', async () => {
    const spec = {
      contest_id: 'str', espn_game_id: 'num', period: 'num', poss_num: 'num', poss_team_espn_team_id: 'num', home_espn_team_id: 'num', away_espn_team_id: 'num',
      pts: 'num', is_assisted: 'num', is_transition: 'num', is_garbage_time: 'num', last_event_time: 'num', first_shot_time: 'num', first_shot_type: 'str',
      home_score: 'num', away_score: 'num',
    };
    for (const s of ['home', 'away']) for (let k = 1; k <= 5; k++) { spec[`${s}_${k}_player_id`] = 'num'; spec[`${s}_${k}_clean_name`] = 'str'; spec[`${s}_${k}`] = 'str'; }
    const t = await read('ncaa_mbb_possessions_2026', spec); const c = t.cols; const n = t.n;
    // compact typed arrays; slots 0-4 home, 5-9 away
    const P = {
      n, game: new Float64Array(n), contest: c.contest_id, period: new Int8Array(n), num: new Int32Array(n),
      off_home: new Int8Array(n), home: new Float64Array(n), away: new Float64Array(n), pts: new Int8Array(n),
      assisted: new Int8Array(n), transition: new Int8Array(n), garbage: new Int8Array(n), secs: new Float32Array(n), shot_type: c.first_shot_type,
      ids: new Float64Array(n * 10), flags: new Uint8Array(n),
    };
    const names = new Map(); // ncaa player id -> {clean, raw} as observed beside the id in the same row
    const nameConflicts = [];
    for (let i = 0; i < n; i++) {
      P.game[i] = c.espn_game_id[i]; P.period[i] = c.period[i]; P.num[i] = c.poss_num[i];
      P.home[i] = c.home_espn_team_id[i]; P.away[i] = c.away_espn_team_id[i];
      const off = c.poss_team_espn_team_id[i];
      P.off_home[i] = isNum(off) && off === P.home[i] ? 1 : isNum(off) && off === P.away[i] ? 0 : -1;
      P.pts[i] = isNum(c.pts[i]) ? c.pts[i] : -1;
      P.assisted[i] = c.is_assisted[i] > 0 ? 1 : 0; P.transition[i] = c.is_transition[i] === 1 ? 1 : 0; P.garbage[i] = c.is_garbage_time[i] === 1 ? 1 : 0;
      P.secs[i] = isNum(c.last_event_time[i]) ? c.last_event_time[i] : NaN;
      const seen = new Set(); let missing = 0; let dup = 0;
      for (let k = 0; k < 10; k++) {
        const s = k < 5 ? 'home' : 'away'; const slot = (k % 5) + 1;
        const id = c[`${s}_${slot}_player_id`][i];
        P.ids[i * 10 + k] = isNum(id) ? id : NaN;
        if (!isNum(id)) { missing++; continue; }
        if (seen.has(id)) dup++; seen.add(id);
        const cl = c[`${s}_${slot}_clean_name`][i];
        const prev = names.get(id);
        if (!prev) names.set(id, { clean: cl, raw: c[`${s}_${slot}`][i] });
        else if (prev.clean !== cl && nameConflicts.length < 50) nameConflicts.push({ id, a: prev.clean, b: cl });
      }
      // bit 1: some slot unidentified; bit 2: a player twice among the ten; bit 4: offense unknown
      P.flags[i] = (missing ? 1 : 0) | (dup ? 2 : 0) | (P.off_home[i] < 0 ? 4 : 0);
    }
    P.names = names; P.name_conflicts = nameConflicts;
    return P;
  });
}

/* ---------------------------------------------------------------- stints and the publisher lineup table (2026) */
function loadStints() {
  return once('stints', async () => {
    const spec = { contest_id: 'str', period: 'num', start_seconds: 'num', end_seconds: 'num', duration_seconds: 'num', n_possessions: 'num', home_pts: 'num', away_pts: 'num', home_lineup: 'str', away_lineup: 'str', game_stint_num: 'num', home: 'str', away: 'str' };
    const t = await read('ncaa_mbb_matchup_stints_2026', spec);
    return t;
  });
}

function loadLineupTable() {
  return once('lineupTable', async () => read('ncaa_mbb_lineups_2026', {
    contest_id: 'str', team: 'str', team_year: 'num', season: 'num', stint_num: 'num', start_min: 'num', end_min: 'num', duration_mins: 'num',
    player_1: 'str', player_2: 'str', player_3: 'str', player_4: 'str', player_5: 'str', poss: 'num', pts: 'num', opp_poss: 'num', opp_pts: 'num', player_count_error: 'str',
  }));
}

function loadShots() {
  return once('shots', async () => read('espn_shots_2026', {
    game_id: 'num', team_id: 'num', period_number: 'num', athlete_id_1: 'num', athlete_id_2: 'num', type_text: 'str', scoring_play: 'bool', score_value: 'num', coordinate_x: 'num', coordinate_y: 'num',
  }));
}

function loadRapm() {
  return once('rapm', async () => {
    const out = {};
    for (const s of C.SEASONS) out[s] = T.rows(await read('ncaa_mbb_rapm_' + s, { season: 'num', player_id: 'num', person_id: 'str', player: 'str', team: 'str', orapm: 'num', drapm: 'num', rapm_net: 'num', off_poss: 'num', def_poss: 'num', estimand: 'str' }));
    return out;
  });
}

function loadRosters() {
  return once('rosters', async () => {
    const out = {};
    for (const s of C.SEASONS) out[s] = T.rows(await read('ncaa_mbb_rosters_' + s, { season: 'num', team: 'str', player: 'str', games: 'num' }));
    return out;
  });
}

function loadPackAudit() {
  return once('packAudit', async () => T.rows(await read('audit_source_discrepancies', { season: 'num', contest_id: 'str', espn_game_id: 'num', espn_team_id: 'num', pts_delta: 'num', fgm_delta: 'num', fga_delta: 'num', tpm_delta: 'num', tpa_delta: 'num', ftm_delta: 'num', fta_delta: 'num' })));
}

module.exports = {
  loadGames, loadTeamGames, loadPlayerGames, loadNcaaPlayerGames, loadPossessions, loadStints, loadLineupTable, loadShots, loadRapm, loadRosters, loadPackAudit,
  read, verify, PROVENANCE, classifyEvent, gameDay, parseUtc, overtimes, gameMinutes,
};
