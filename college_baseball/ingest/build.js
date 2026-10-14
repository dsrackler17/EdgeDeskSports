'use strict';
/* ===========================================================================
   EdgeDesk college baseball — build the warehouse, one season at a time.

     node college_baseball/ingest/build.js --season 2026        one season
     node college_baseball/ingest/build.js --all                 2012-2026 (one process per season)
     node college_baseball/ingest/build.js --season 2026 --offline   cached sources only
     node college_baseball/ingest/build.js --check               re-read committed files and validate

   Order inside a season: team identity -> schedule (both shapes, reconciled)
   -> play-by-play (2017+) -> box score + linescore (2024+) -> innings truth
   and rule inference -> games CSV, provenance, quarantine, per-season report.

   Each season runs in its own process (--all spawns them) so every season
   gets the guarded client's per-run request budget, and one failed season
   never silently drops the others: the run reports every season's outcome
   and exits non-zero if any failed.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const C = require('../config');
const K = require('./common');
const SRC = require('./sources');
const TEAMS = require('./teams');
const SCH = require('./schedules');
const PBP = require('./pbp');
const BOX = require('./box');
const RULES = require('../lib/rules');
const { readCsv } = require('../../engine/csv');

function arg(name, def) { const i = process.argv.indexOf('--' + name); return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def; }
function flag(name) { return process.argv.includes('--' + name); }
const inRange = (s, r) => s >= r[0] && s <= r[1];

/* ---------------------------------------------------------------- shape-1 seasons */
function contestsFromGameShape(rowsBySource, season, idx, problems) {
  const groups = new Map();
  for (const [source, rows] of Object.entries(rowsBySource)) {
    const ordinals = new Map();
    for (const r of SCH.fromGameRows(rows, season, source)) {
      /* the source leaves the id blank when a seed prefixes the name ("#3 UMES") */
      for (const side of ['home', 'away']) {
        if (!r[side + '_id'] && r[side + '_name']) {
          const id = idx.byName(season, r[side + '_name']);
          if (id) { r[side + '_id'] = id; problems.push({ kind: 'ID_FILLED_FROM_NAME', season, detail: r[side + '_name'] }); }
        }
      }
      let key = r.key;
      if (!key) {
        const pair = [r.home_id || K.normName(r.home_name), r.away_id || K.normName(r.away_name)].sort().join('~');
        const base = `d${r.date}|${pair}`; const ok = base + '|' + r.file; const k = (ordinals.get(ok) || 0) + 1; ordinals.set(ok, k);
        key = `${base}|${k}`;
      }
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
  }
  const out = [];
  for (const [key, copies] of groups) {
    const rec = SCH.reconcileGameRows(copies);
    const g = rec.g;
    /* the lookup is authoritative for division and conference; disagreement is recorded */
    for (const side of ['home', 'away']) {
      const t = g[side + '_id'] ? idx.org(season, g[side + '_id']) : null;
      if (t) {
        if (g[side + '_div'] != null && t.division !== g[side + '_div']) problems.push({ kind: 'DIVISION_DISAGREES', season, detail: `${t.name}: schedule ${g[side + '_div']} lookup ${t.division}` });
        g[side + '_div'] = t.division; g[side + '_conf'] = t.conference || g[side + '_conf']; g[side + '_name'] = t.name || g[side + '_name'];
      }
    }
    out.push({ key, g, rec, copies });
  }
  return out;
}

/* ---------------------------------------------------------------- the season */
async function buildSeason(season, o) {
  o = o || {};
  const off = { offline: o.offline };
  const problems = [];
  const team = await TEAMS.run({ offline: o.offline, check: o.check });
  const idx = TEAMS.index(team.seasons);
  const d1 = new Set(idx.d1(season).map((t) => t.team_id));
  const report = { season, built_at: new Date().toISOString(), sources: {}, counts: {}, problems: [] };

  /* schedule */
  const sched = await SRC.parquet(C.SOURCE.urls.schedule(season), season >= 2024
    ? ['team_id', 'team_name', 'date', 'game_number', 'opponent_id', 'opponent', 'result', 'outcome', 'team_score', 'opponent_score', 'contest_id', 'division']
    : ['date', 'home_team', 'home_team_id', 'home_team_score', 'home_team_conference', 'home_team_division', 'away_team', 'away_team_id', 'away_team_score', 'away_team_conference', 'away_team_division', 'neutral_site', 'innings', 'contest_id', 'game_pbp_id'], off);
  if (!sched.ok) throw new Error(`season ${season}: schedule unavailable (${JSON.stringify(sched.prov && sched.prov.error)})`);
  report.sources.schedule = { url: sched.prov.url, sha256: sched.prov.sha256, rows: sched.rows.length, missing_columns: sched.missing };

  /* play-by-play */
  let pbp = null; const pbpMap = new Map();
  if (inRange(season, C.SEASONS.pbp)) {
    pbp = await PBP.run(season, { offline: o.offline, check: o.check });
    if (pbp.ok) for (const r of pbp.rows) pbpMap.set(r.pbp_key, r);
    report.sources.pbp = pbp.ok ? { url: pbp.prov.url, sha256: pbp.prov.sha256, games: pbp.games, plays: pbp.plays, split_contests: pbp.split_contests.length, missing_columns: pbp.missing_columns } : { error: String(pbp.error) };
    report.environment = pbp.ok ? pbp.environment : null;
  }

  /* box + linescore */
  let box = null;
  if (inRange(season, C.SEASONS.box)) {
    box = await BOX.run(season, idx, { offline: o.offline, check: o.check });
    if (box.ok) { report.sources.box = { team_games: box.teams.length, pitcher_lines: box.pitchers.length, batter_lines: box.batters, missing_columns: box.missing_columns }; problems.push(...box.problems); }
    else report.sources.box = { error: String(box.error) };
  }

  /* contests */
  let contests;
  if (season >= 2024) {
    const raw = SCH.fromTeamRows(sched.rows, season, idx, problems);
    contests = raw.map((g) => {
      const ls = box && box.ok ? box.linescore.get(g.contest_id) : null;
      const gt = box && box.ok ? box.gamesTable.get(g.contest_id) : null;
      const pb = pbpMap.get(g.contest_id);
      const extraFrom = (src, home, homeRuns, awayRuns) => ({ src, home_key: idx.byName(season, home) || K.normName(home), home_runs: homeRuns, away_runs: awayRuns });
      let extra = null;
      if (ls && ls.home_runs != null) extra = extraFrom('linescore', ls.home_name, ls.home_runs, ls.away_runs);
      else if (gt) extra = extraFrom('games_table', gt.home_name, gt.home_final, gt.away_final);
      else if (pb) extra = extraFrom('pbp', pb.home_name, pb.home_final, pb.away_final);
      const rec = SCH.reconcileTeamContest(g, extra);
      return { key: g.key, g: Object.assign(g, { status: rec.status, home_runs: rec.home_runs, away_runs: rec.away_runs, innings_marker: rec.innings_marker }), rec, ls, gt, pb };
    });
  } else {
    const bySource = { season_file: sched.rows };
    if (C.SEASONS.team_file_union.includes(season)) {
      const tf = [];
      let fetched = 0; let missing = 0;
      for (const t of idx.d1(season)) {
        const r = await SRC.csv(C.SOURCE.urls.teamSchedule(season, t.team_id), off);
        if (r.ok) { for (const x of r.rows) x._file = 'team_file:' + t.team_id; tf.push(...r.rows); fetched++; } else missing++;
      }
      bySource.team_file = tf;
      report.sources.team_files = { teams: idx.d1(season).length, fetched, missing, rows: tf.length };
    }
    contests = contestsFromGameShape(bySource, season, idx, problems).map((c) => {
      const pb = pbpMap.get('g' + c.g.pbp_id) || pbpMap.get(c.g.contest_id);
      return Object.assign(c, { pb });
    });
  }

  /* keep contests that involve a D-I program that season */
  const games = []; const prov = []; const quarantine = [];
  const collected = sched.prov.fetched_at;
  for (const c of contests) {
    const g = c.g;
    const isD1 = (id, div) => (id && d1.has(id)) || div === 1;
    if (!isD1(g.home_id, g.home_div) && !isD1(g.away_id, g.away_div)) continue;
    const notes = [].concat(c.rec.notes || []);
    const conflicts = [].concat(c.rec.conflicts || []);
    let quality = c.rec.quality;
    const srcs = new Set(c.rec.sources || (season >= 2024 ? ['schedule'] : ['season_file']));
    if (season >= 2024 && c.g.perspectives === 2) srcs.add('schedule_both_sides');
    /* innings truth: linescore, else play-by-play */
    let lines = null; let batsLast = 'H'; let linesRejected = '';
    /* an inning line is used only if it adds up to the official final (either orientation is checked; the
       orientation itself is settled below) — a line that does not reconcile would corrupt every inning model */
    const sumLine = (l) => (Array.isArray(l) ? l : String(l).split(' ')).reduce((t, v) => t + (v === 'x' || v === '' ? 0 : Number(v)), 0);
    const reconciles = (al, hl) => g.status === 'FINAL' && ((sumLine(al) === g.away_runs && sumLine(hl) === g.home_runs) || (sumLine(al) === g.home_runs && sumLine(hl) === g.away_runs));
    if (c.ls) {
      srcs.add('linescore');
      if (reconciles(c.ls.away_line, c.ls.home_line)) lines = { away_line: c.ls.away_line.join(' '), home_line: c.ls.home_line.join(' '), innings_played: c.ls.innings_played, src: 'linescore' };
      else if (g.status === 'FINAL') linesRejected = 'linescore';
    }
    if (c.pb) {
      srcs.add('pbp');
      if (!lines && reconciles(c.pb.away_line, c.pb.home_line)) lines = { away_line: c.pb.away_line, home_line: c.pb.home_line, innings_played: c.pb.innings_played, src: 'pbp' };
      else if (!lines && g.status === 'FINAL') linesRejected = linesRejected ? linesRejected + '+pbp' : 'pbp';
      /* pbp's orientation and final, independently */
      if (g.status === 'FINAL' && c.pb.home_final != null) {
        const pbHome = idx.byName(season, c.pb.home_name) || K.normName(c.pb.home_name);
        const schedHome = g.home_id || K.normName(g.home_name); const schedAway = g.away_id || K.normName(g.away_name);
        let ph = c.pb.home_final; let pa = c.pb.away_final;
        if (g.neutral && pbHome === schedHome && c.rec.home_basis !== 'LINESCORE_BATS_LAST') c.rec.home_basis = 'PBP_BATS_LAST';
        if (pbHome === schedAway && pbHome !== schedHome) {
          if (!g.neutral && c.rec.batsLastCandidate) {
            /* two independent sources (linescore/games table and play-by-play) agree the host did not bat last */
            batsLast = 'A'; notes.push('host did not bat last (' + c.rec.batsLastCandidate.src + ' + pbp)');
            [ph, pa] = [pa, ph];
          } else if (g.neutral) {
            c.rec.home_basis = 'PBP_BATS_LAST';
            /* at a neutral site the side that batted last is the box "home" */
            [g.home_id, g.away_id] = [g.away_id, g.home_id]; [g.home_name, g.away_name] = [g.away_name, g.home_name]; [g.home_div, g.away_div] = [g.away_div, g.home_div];
            [g.home_conf, g.away_conf] = [g.away_conf, g.home_conf]; [g.home_runs, g.away_runs] = [g.away_runs, g.home_runs];
            notes.push('neutral: oriented to the side that batted last (pbp)');
          } else { conflicts.push({ field: 'home_away', obs: `schedule ${g.home_name} / pbp ${c.pb.home_name}`, reason: 'play-by-play bats the listed road team last at a non-neutral game' }); }
        }
        if (ph !== g.home_runs || pa !== g.away_runs) {
          if (c.pb.sum_matches_final) notes.push(`pbp final ${ph}-${pa} vs official ${g.home_runs}-${g.away_runs}`);
          if (!c.ls && quality === 'SINGLE_SOURCE') quality = 'SINGLE_SOURCE_PBP_DISAGREES';
        } else if (quality === 'SINGLE_SOURCE') quality = 'VERIFIED';
      }
    }
    if (c.ls && c.pb && c.ls.home_runs != null && c.pb.home_final != null) {
      const agree = c.ls.home_runs === c.pb.home_final && c.ls.away_runs === c.pb.away_final || c.ls.home_runs === c.pb.away_final && c.ls.away_runs === c.pb.home_final;
      if (!agree) notes.push(`linescore ${c.ls.home_runs}-${c.ls.away_runs} vs pbp ${c.pb.home_final}-${c.pb.away_final}`);
    }
    if (!g.neutral && c.rec.batsLastCandidate && batsLast !== 'A') conflicts.push({ field: 'home_away', obs: `schedule home ${g.home_name} / ${c.rec.batsLastCandidate.src} home ${g.away_name}`, reason: 'one independent source says the listed road team batted last; no second source confirms it' });
    if (conflicts.length) quality = 'CONFLICT';
    let inf = { scheduled: null, basis: 'UNKNOWN_NO_INNINGS', ended_early: null };
    if (g.status === 'FINAL' && lines) inf = RULES.inferScheduled({ away_line: lines.away_line, home_line: lines.home_line, innings_played: lines.innings_played, dh: g.dh });
    else if (g.status === 'FINAL' && g.innings_marker >= 10) inf = { scheduled: null, basis: 'EXTRA_MARKER_ONLY', ended_early: 0 };
    const md = K.memorialDay(season);
    const tourney = g.date >= K.addDays(md, 4) ? 1 : 0;
    const confGame = g.home_conf && g.away_conf && g.home_conf === g.away_conf && g.home_div === 1 && g.away_div === 1 ? 1 : 0;
    const confWindow = confGame && g.date >= K.addDays(md, -7) && g.date <= md ? 1 : 0;
    const gameId = g.contest_id ? 'ncaa_' + g.contest_id : 'ncaa_x' + K.str(c.key).replace(/[^A-Za-z0-9]+/g, '_');
    const row = {
      game_id: gameId, contest_id: g.contest_id || '', season, date: g.date, start_time_local: g.time || '', dh: g.dh || '', weekday: K.weekday(g.date),
      home_id: g.home_id || '', away_id: g.away_id || '', home_name: g.home_name, away_name: g.away_name, home_div: g.home_div == null ? '' : g.home_div, away_div: g.away_div == null ? '' : g.away_div,
      home_conf: g.home_conf || '', away_conf: g.away_conf || '', conf_game: confGame, neutral: g.neutral ? 1 : 0, site: g.site || '',
      park_key: g.neutral ? 's:' + K.normName(g.site || (c.ls && c.ls.venue) || 'unknown') : 'h:' + (g.home_id || K.normName(g.home_name)),
      home_basis: c.rec.home_basis || (g.neutral ? 'FIRST_LISTED' : 'SCHEDULE'), bats_last: batsLast,
      status: g.status, home_runs: g.home_runs, away_runs: g.away_runs, innings_marker: g.innings_marker || '', innings_played: lines ? lines.innings_played : '',
      scheduled_innings: inf.scheduled || '', scheduled_basis: inf.basis, ended_early: inf.ended_early == null ? '' : inf.ended_early,
      ncaa_tourney_inferred: tourney, conf_tourney_window: confWindow,
      pbp_key: c.pb ? c.pb.pbp_key : '', lines_src: lines ? lines.src : (linesRejected ? 'REJECTED:' + linesRejected : ''),
      away_line: lines ? (batsLast === 'A' ? lines.home_line : lines.away_line) : '', home_line: lines ? (batsLast === 'A' ? lines.away_line : lines.home_line) : '',
      sources: [...srcs].sort().join('+'), n_observations: (c.copies ? c.copies.length : (c.g.perspectives || 1)) + (c.ls ? 1 : 0) + (c.pb ? 1 : 0),
      quality, quality_notes: notes.join('; ').slice(0, 400), known_at: '', assumed_available_at: K.availableAt(g.date), pit: 'RETRO',
    };
    games.push(row);
    if (quality === 'CONFLICT') for (const cf of conflicts) quarantine.push({ game_id: gameId, season, date: g.date, home_name: g.home_name, away_name: g.away_name, field: cf.field, observations: cf.obs, reason: cf.reason });
    /* provenance of the critical fields */
    const base = { game_id: gameId, event_time: g.date, available_at: row.assumed_available_at, quality_status: quality };
    const val = quality === 'CONFLICT' ? 'CONFLICT' : (quality.startsWith('VERIFIED') ? 'VERIFIED' : quality);
    const pushProv = (field, orig, canon, source, recId, collectedAt) => prov.push(Object.assign({}, base, { field, original_value: orig, canonical_value: canon, source, source_record_id: recId, collected_at: collectedAt || collected, validation_status: val, conflict_status: String(orig) === String(canon) ? 'AGREES' : 'DISAGREES' }));
    const canonScore = g.status === 'FINAL' ? `${g.home_runs}-${g.away_runs}` : g.status;
    if (season >= 2024) {
      (c.rec.scoreObs || []).forEach((v, i) => pushProv('final_score', v, canonScore, 'schedule_perspective_' + (i + 1), g.contest_id));
      if (!(c.rec.scoreObs || []).length) pushProv('final_score', g.status, canonScore, 'schedule', g.contest_id);
    } else (c.copies || []).forEach((cp) => pushProv('final_score', cp.home_runs != null ? `${cp.home_runs}-${cp.away_runs}` : 'NO_RESULT', canonScore, cp.source, cp.contest_id));
    if (c.ls) pushProv('final_score', `${c.ls.home_runs}-${c.ls.away_runs}`, canonScore, 'linescore', g.contest_id);
    if (c.pb) pushProv('final_score', `${c.pb.home_final}-${c.pb.away_final}`, canonScore, 'pbp', c.pb.pbp_key);
    pushProv('home_team', g.home_name, g.home_name, row.home_basis.toLowerCase(), g.contest_id);
    pushProv('neutral', row.neutral, row.neutral, 'schedule', g.contest_id);
    if (lines) pushProv('innings_played', lines.innings_played, lines.innings_played, lines.src, g.contest_id);
    pushProv('scheduled_innings', inf.basis, row.scheduled_innings || 'UNKNOWN', 'inferred:lib/rules.js', g.contest_id);
  }
  games.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.game_id < b.game_id ? -1 : 1));
  if (!o.check) {
    K.writeCsv(C.PATHS.games(season), SCH.GAME_HEADER, games);
    K.writeCsv(C.PATHS.provenance(season), SCH.PROV_HEADER, prov);
    K.writeCsv(C.PATHS.quarantine(season), SCH.QUAR_HEADER, quarantine);
  }
  report.counts = {
    contests: games.length, final: games.filter((g) => g.status === 'FINAL').length,
    canceled: games.filter((g) => g.status === 'CANCELED').length, postponed: games.filter((g) => g.status === 'POSTPONED').length,
    no_result: games.filter((g) => !['FINAL', 'CANCELED', 'POSTPONED'].includes(g.status)).length,
    quarantined: new Set(quarantine.map((q) => q.game_id)).size,
    quality: games.reduce((a, g) => { a[g.quality] = (a[g.quality] || 0) + 1; return a; }, {}),
    d1_vs_d1: games.filter((g) => g.home_div === 1 && g.away_div === 1).length,
    with_innings: games.filter((g) => g.innings_played !== '').length,
  };
  const pc = new Map(); for (const p of problems) pc.set(p.kind, (pc.get(p.kind) || 0) + 1);
  report.problems = [...pc.entries()].map(([kind, n]) => ({ kind, n, examples: problems.filter((p) => p.kind === kind).slice(0, 5).map((p) => p.detail || p.contest) }));
  report.provenance_files = SRC.PROVENANCE.filter((p) => !/team_schedules/.test(p.url)).map((p) => ({ url: p.url, sha256: p.sha256, bytes: p.bytes, fetched_at: p.fetched_at, ok: p.ok, error: p.error }));
  const tf = SRC.PROVENANCE.filter((p) => /team_schedules/.test(p.url));
  if (tf.length) report.provenance_team_files = { n: tf.length, ok: tf.filter((p) => p.ok).length, combined_sha256: require('crypto').createHash('sha256').update(tf.map((p) => p.sha256 || '').join('')).digest('hex') };
  if (!o.check) K.writeJson(path.join(C.PATHS.data, 'reports', season + '.json'), report);
  return report;
}

async function main() {
  if (flag('all')) {
    const out = [];
    for (let s = C.SEASONS.first; s <= C.SEASONS.last; s++) {
      const args = [__filename, '--season', String(s)].concat(flag('offline') ? ['--offline'] : []);
      const r = spawnSync(process.execPath, args, { stdio: 'inherit' });
      out.push({ season: s, ok: r.status === 0 });
    }
    console.log(JSON.stringify(out));
    process.exit(out.every((x) => x.ok) ? 0 : 1);
  }
  const season = Number(arg('season', C.currentSeason()));
  const t0 = Date.now();
  const rep = await buildSeason(season, { offline: flag('offline'), check: flag('check') });
  console.log(`season ${season}: ${rep.counts.contests} D-I contests, ${rep.counts.final} final, ${rep.counts.quarantined} quarantined, quality ${JSON.stringify(rep.counts.quality)} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  for (const p of rep.problems) console.log(`  problem ${p.kind}: ${p.n}  e.g. ${p.examples.slice(0, 2).join(' | ')}`);
}

if (require.main === module) main().catch((e) => { console.error(e.stack || e); process.exit(1); });

module.exports = { buildSeason, contestsFromGameShape };
