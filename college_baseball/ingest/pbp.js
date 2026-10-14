'use strict';
/* ===========================================================================
   EdgeDesk college baseball — play-by-play, folded to what the models use.

   The play-by-play files (2017-2026; 2023 partial) are 0.8-2.3 million plays a
   season. Nothing downstream needs a play; it needs, per game:
     - runs by half-inning (the linescore), innings played, whether the home
       side batted in the last inning (walk-off / did not need to bat);
     - the final score the plays add up to (a reconciliation source that is
       independent of the box score's summary line);
     - per-team event counts (1B, 2B, 3B, HR, BB, HBP, K, ROE, SB, outs...) so
       component offense models can be tested on 2017-2023, before box scores;
   and, per season, the run environment:
     - the distribution of runs in a half-inning, by inning;
     - run expectancy by outs (base states are not reconstructed: the source's
       runner-advance fields are free text and the reconstruction error was not
       measured — research/UNRESOLVED.md U-07).

   Score columns are the score AFTER the play (checked: a bases-loaded walk
   raises the score on its own row). Half-inning runs are score changes; the
   line is used downstream only if it adds up to the official final.
   =========================================================================== */
const C = require('../config');
const K = require('./common');
const SRC = require('./sources');

const COLS = ['contest_id', 'inning', 'inning_top_bot', 'batting', 'fielding', 'play_number', 'score_away', 'score_home', 'batter', 'play_type', 'runs_scored', 'outs_on_play', 'game_date', 'location'];
const EVENTS = { single: '1b', double: '2b', triple: '3b', home_run: 'hr', walk: 'bb', intentional_walk: 'bb', hit_by_pitch: 'hbp', strikeout: 'k',
  reached_on_error: 'roe', fielders_choice: 'fc', stolen_base: 'sb', wild_pitch: 'wp', passed_ball: 'pb', double_play: 'dp' };
const EV_KEYS = ['1b', '2b', '3b', 'hr', 'bb', 'hbp', 'k', 'roe', 'fc', 'sb', 'wp', 'pb', 'dp', 'outs', 'pa'];
const PA_TYPES = new Set(['single', 'double', 'triple', 'home_run', 'walk', 'intentional_walk', 'hit_by_pitch', 'strikeout', 'groundout', 'flyout', 'popup', 'lineout', 'foulout', 'out', 'fielders_choice', 'reached_on_error', 'double_play']);

const HEADER = ['pbp_key', 'season', 'date', 'location', 'away_name', 'home_name', 'innings_played', 'home_batted_last', 'away_line', 'home_line', 'away_runs_sum', 'home_runs_sum', 'away_final', 'home_final', 'sum_matches_final', 'plays']
  .concat(EV_KEYS.map((k) => 'a_' + k)).concat(EV_KEYS.map((k) => 'h_' + k));

function emptyEv() { const o = {}; for (const k of EV_KEYS) o[k] = 0; return o; }

/** pure: the plays of one contest (sorted by play_number) -> game summary + RE observations */
function foldGame(key, plays) {
  plays.sort((a, b) => a.play_number - b.play_number);
  const halves = new Map();   // "inning:top|bot" -> runs
  const ev = { top: emptyEv(), bot: emptyEv() };
  let maxInning = 0; let away = ''; let home = ''; let date = ''; let location = '';
  const re = [];              // [outs_before, runs_rest_of_half]
  const halfOrder = [];
  let cur = null; let curOuts = 0; let paStarts = [];
  const closeHalf = () => {
    if (!cur) return;
    const total = halves.get(cur.k);
    for (const p of paStarts) re.push([p.outs, total - p.scoredBefore]);
  };
  let scored = 0;
  /* RUNS COME FROM THE RUNNING SCORE. The score columns (score after each
     play) reconcile with the official final in ~99% of games; the per-play
     runs_scored field does not (0.2% of 2017 games, 66% of 2024 games add up).
     A play's runs are the batting side's score change; runs_scored is used
     only on a row whose score is missing. */
  let lastAway = 0; let lastHome = 0; let lastTop = null; let lastBot = null;
  for (const p of plays) {
    const inn = K.int(p.inning); const tb = p.inning_top_bot === 'bot' ? 'bot' : 'top';
    if (!inn) continue;
    const k = inn + ':' + tb;
    if (!cur || cur.k !== k) { closeHalf(); cur = { k }; curOuts = 0; scored = 0; paStarts = []; halfOrder.push(k); if (!halves.has(k)) halves.set(k, 0); }
    if (inn > maxInning) maxInning = inn;
    if (tb === 'top') { away = away || K.str(p.batting); home = home || K.str(p.fielding); }
    else { home = home || K.str(p.batting); away = away || K.str(p.fielding); }
    date = date || K.str(p.game_date); location = location || K.str(p.location);
    const sa = K.int(p.score_away); const sh = K.int(p.score_home);
    let runs;
    if (tb === 'top') lastTop = k; else lastBot = k;
    if (sa != null && sh != null) {
      /* a corrected score never un-scores a run */
      const dA = Math.max(0, sa - lastAway); const dH = Math.max(0, sh - lastHome);
      lastAway = Math.max(lastAway, sa); lastHome = Math.max(lastHome, sh);
      /* the batting side's change belongs to this half; the fielding side's
         change was recorded late (the legacy files often post a half's last
         run on the next half's first row) and belongs to that side's last half */
      runs = tb === 'top' ? dA : dH;
      const late = tb === 'top' ? dH : dA; const lateKey = tb === 'top' ? lastBot : lastTop;
      if (late && lateKey && halves.has(lateKey)) halves.set(lateKey, halves.get(lateKey) + late);
    } else runs = K.int(p.runs_scored) || 0;
    const outs = K.int(p.outs_on_play) || 0;
    const t = K.str(p.play_type);
    if (PA_TYPES.has(t) && curOuts < 3) paStarts.push({ outs: curOuts, scoredBefore: scored });
    halves.set(k, halves.get(k) + runs);
    scored += runs; curOuts += outs;
    const e = ev[tb];
    if (EVENTS[t]) e[EVENTS[t]]++;
    if (PA_TYPES.has(t)) e.pa++;
    e.outs += outs;
  }
  closeHalf();
  const last = plays[plays.length - 1];
  const awayLine = []; const homeLine = [];
  for (let i = 1; i <= maxInning; i++) {
    awayLine.push(halves.has(i + ':top') ? halves.get(i + ':top') : 'x');
    homeLine.push(halves.has(i + ':bot') ? halves.get(i + ':bot') : 'x');
  }
  const aSum = awayLine.reduce((s, v) => s + (v === 'x' ? 0 : v), 0); const hSum = homeLine.reduce((s, v) => s + (v === 'x' ? 0 : v), 0);
  const aFin = last ? K.int(last.score_away) : null; const hFin = last ? K.int(last.score_home) : null;
  const pd = K.parseDate(date);
  const row = {
    pbp_key: key, date: pd ? pd.date : '', location, away_name: away, home_name: home, innings_played: maxInning,
    home_batted_last: halves.has(maxInning + ':bot') ? 1 : 0, away_line: awayLine.join(' '), home_line: homeLine.join(' '),
    away_runs_sum: aSum, home_runs_sum: hSum, away_final: aFin, home_final: hFin, sum_matches_final: aSum === aFin && hSum === hFin ? 1 : 0, plays: plays.length,
  };
  for (const kk of EV_KEYS) { row['a_' + kk] = ev.top[kk]; row['h_' + kk] = ev.bot[kk]; }
  return { row, re, halves: [...halves.entries()] };
}

/** season run environment from folded games */
function environment(folds) {
  const byInning = {};      // inning -> histogram of half-inning runs
  const reSum = [0, 0, 0]; const reN = [0, 0, 0];
  let games = 0; let runs = 0; const innDist = {};
  for (const f of folds) {
    games++;
    runs += f.row.away_runs_sum + f.row.home_runs_sum;
    innDist[f.row.innings_played] = (innDist[f.row.innings_played] || 0) + 1;
    for (const [k, v] of f.halves) {
      const inn = Number(k.split(':')[0]); const key = inn >= 10 ? 'x' : String(inn);
      if (!byInning[key]) byInning[key] = {};
      const b = Math.min(v, 15); byInning[key][b] = (byInning[key][b] || 0) + 1;
    }
    for (const [o, r] of f.re) { if (o >= 0 && o <= 2) { reSum[o] += r; reN[o]++; } }
  }
  return {
    games, runs_per_team_game: games ? Math.round(runs / games / 2 * 1000) / 1000 : null,
    innings_played: innDist,
    half_inning_runs: byInning,
    re_by_outs: reN.map((n, i) => ({ outs: i, n, re: n ? Math.round(reSum[i] / n * 10000) / 10000 : null })),
  };
}

async function run(season, o) {
  o = o || {};
  const folds = []; let cur = null; let buf = []; const seenClosed = new Set(); let noncontiguous = 0;
  const flush = () => { if (cur !== null) { if (seenClosed.has(cur)) noncontiguous++; seenClosed.add(cur); folds.push(foldGame(cur, buf)); } buf = []; };
  const res = await SRC.parquetEach(C.SOURCE.urls.pbp(season), COLS, (r) => {
    const key = K.str(r.contest_id);
    if (key !== cur) { flush(); cur = key; }
    r.play_number = K.int(r.play_number);
    buf.push(r);
  }, { offline: o.offline });
  flush();
  if (!res.ok) return { ok: false, season, error: res.prov && res.prov.error, not_found: res.prov && res.prov.not_found };
  /* a contest whose plays are split across the file cannot be folded from one
     pass; it is excluded from play-by-play outputs and listed, never half-counted */
  const counts = new Map();
  for (const f of folds) counts.set(f.row.pbp_key, (counts.get(f.row.pbp_key) || 0) + 1);
  const split = [...counts.entries()].filter(([, n]) => n > 1).map(([k]) => k);
  const merged = folds.filter((f) => counts.get(f.row.pbp_key) === 1);
  const rows = merged.map((f) => Object.assign({ season }, f.row));
  if (!o.check) K.writeCsv(C.PATHS.innings(season), HEADER, rows);
  return { ok: true, season, games: rows.length, plays: res.n, noncontiguous, split_contests: split, missing_columns: res.missing, environment: environment(merged), prov: res.prov, rows };
}

module.exports = { run, foldGame, environment, HEADER, COLS, EV_KEYS };
