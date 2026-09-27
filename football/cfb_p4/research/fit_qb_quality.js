#!/usr/bin/env node
/* ============================================================================
   WHAT IS A QUARTERBACK WORTH, IN POINTS OF SPREAD? — fitted, then tested.

   WHY THIS EXISTS. The engine's QB layer prices EPA per dropback:

       valPts = params.qb.points_per_epa_db * shrunk_epa_per_dropback

   and no feed this repository reads publishes EPA per dropback for college
   football. cfbfastR's real-EPA play-by-play stops at 2022 in a directory
   that no longer resolves, and football/players/config.js records EPA as not
   observed for the same reason. So the term has no input, contributes zero on
   every college game, and the published spread has never contained a
   quarterback adjustment of any kind.

   What the play feed DOES carry, on every row, is down, distance, yards to
   goal, and the player credited with the completion, the incompletion, the
   sack taken or the interception thrown. That is enough to measure two things
   this repository already treats as the honest stand-ins for EPA — success
   rate and net yards per dropback — and to ask the question the EPA
   coefficient was fitted to answer:

       given everything the ratings already know, how much of what is left
       over is explained by the gap between the two starting quarterbacks?

   HOW THE COEFFICIENT IS OBTAINED. Exactly as params.qb records the EPA one
   being obtained — "regressed on the rating residual over 4255 tune-window
   games" — with one addition this repository's own doctrine demands: the
   result is then WALK-FORWARD TESTED, and whether it is allowed to move a
   line is decided by that test rather than by whoever ran the job.

     1  replay the rating state season by season, game by game, in kickoff
        order, exactly as the board does
     2  BEFORE absorbing a game, take the model's baseline prediction from the
        state as it stands: rating gap plus home-field advantage
     3  identify each side's opening quarterback the same way the starter
        layer does — first dropback of the game
     4  score each of them from their dropbacks in games ALREADY PROCESSED and
        nothing else, shrunk toward the league mean by the engine's own
        n/(n+k) form
     5  residual = actual margin - baseline prediction; feature = home
        quarterback's shrunk quality minus away's
     6  fit the slope, then walk it forward: fit on every season before Y,
        measure held-out error on Y, for each Y in the window

   LEAKAGE IS THE ONLY WAY TO GET A GOOD ANSWER HERE BY ACCIDENT, so the
   ordering above is load-bearing and is asserted in the tests: a quarterback's
   score for a game never includes that game, and the rating state used for the
   baseline never includes it either.

   FBS-VS-FBS ONLY. An FCS opponent sits at a shared floor rating, so its
   residual is dominated by the floor rather than by its quarterback, and
   including those games would fit the coefficient to the wrong thing.

     node football/cfb_p4/research/fit_qb_quality.js
          [--seasons 2019,2020,2021,2022,2023,2024,2025]
          [--out football/cfb_p4/research/qb_quality.json]
          [--offline] [--quiet]

   Exit 2 means the fit could not be attempted (no feed). A coefficient that
   fails its walk-forward is NOT an error: it is written with
   points_applied:false and the engine keeps contributing zero, which is the
   honest outcome and the one this repository already applies to travel.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const ROOT = path.join(HERE, '..', '..', '..');
const CACHE = path.join(HERE, '.cache');
global.window = global.window || global;
require(path.join(ROOT, 'football', 'cfb_p4', 'params.js'));
const E = require(path.join(ROOT, 'football', 'cfb_p4', 'engine.js'));
const FBS = require(path.join(ROOT, 'football', 'fbs', 'fbs.js'));
const P = global.EDCfbP4Params;

const CFB = 'https://raw.githubusercontent.com/sportsdataverse/cfbfastR-data/main';
const SCHEMA = 'edgedesk_qb_quality_v1';

function arg(name, fb) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fb;
  const v = process.argv[i + 1];
  return (v == null || String(v).startsWith('--')) ? true : v;
}
const QUIET = !!arg('quiet', false);
const log = (...a) => { if (!QUIET) console.error(...a); };
const NUM = v => { if (v == null || v === '' || v === 'NA') return null; const x = +v; return isFinite(x) ? x : null; };
const NA = v => (v == null || v === '' || v === 'NA') ? null : String(v);
const r4 = x => Math.round(x * 10000) / 10000;

async function grab(url, file, offline) {
  const dest = path.join(CACHE, file);
  if (fs.existsSync(dest)) return fs.readFileSync(dest, 'utf8');
  if (offline) return null;
  const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(300000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${file}`);
  const t = await r.text();
  try { fs.mkdirSync(CACHE, { recursive: true }); fs.writeFileSync(dest, t); } catch (_) { /* cache is a convenience */ }
  return t;
}

/* QUOTE-AWARE, line-at-a-time, over the columns actually needed.

   The first version of this split each line on commas. That is wrong on this
   feed and wrongness here is invisible rather than loud: one player named
   "Smith, Jr." shifts every field after him by one, so `completion_yds` starts
   reading a player id and the season's average lands at minus thirteen hundred
   yards per dropback. It did exactly that on 2021. A parser that silently
   mis-assigns columns is worse than one that throws, so this one tracks quotes
   and the caller additionally range-checks what comes out. */
function eachRow(text, cols, fn) {
  const nl0 = text.indexOf('\n');
  const head = splitCsvLine(text.slice(0, nl0).replace(/\r$/, ''));
  const idx = {}; head.forEach((h, i) => { idx[h] = i; });
  for (const c of cols) if (idx[c] === undefined) throw new Error('the play feed no longer carries ' + c);
  const want = cols.map(c => idx[c]);
  const maxIdx = Math.max.apply(null, want);
  const width = head.length;
  let start = nl0 + 1, malformed = 0, total = 0;
  while (start < text.length) {
    /* a quoted field may contain a newline, so the end of a record is the next
       newline that is NOT inside quotes */
    let i = start, q = false;
    while (i < text.length) {
      const c = text[i];
      if (c === '"') q = !q;
      else if (c === '\n' && !q) break;
      i++;
    }
    const line = text.slice(start, i).replace(/\r$/, '');
    start = i + 1;
    if (!line) continue;
    total++;
    const f = splitCsvLine(line);
    /* A ROW THAT DOES NOT MATCH THE HEADER WIDTH IS DROPPED AND COUNTED, never
       read at shifted offsets. */
    if (f.length !== width || f.length <= maxIdx) { malformed++; continue; }
    const o = {};
    for (let j = 0; j < cols.length; j++) o[cols[j]] = f[want[j]];
    fn(o);
  }
  return { rows: total, malformed };
}

function splitCsvLine(line) {
  const out = []; let field = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; continue; }
    if (c === '"') q = true;
    else if (c === ',') { out.push(field); field = ''; }
    else field += c;
  }
  out.push(field);
  return out;
}

function parseCsvSmall(text) {
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; continue; }
    if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const head = rows.shift() || [];
  return rows.filter(r => r.length > 1).map(r => { const o = {}; head.forEach((h, i) => { o[h] = r[i] === undefined ? '' : r[i]; }); return o; });
}
const TRUE = v => /^(true|1|t|yes)$/i.test(String(v == null ? '' : v).trim());

/* SUCCESS, as this repository defines it everywhere else: the conventional
   down-based thresholds. A sack or an interception is never a success. */
function isSuccess(down, distance, gain) {
  if (!(distance > 0)) return null;
  if (down === 1) return gain >= 0.5 * distance;
  if (down === 2) return gain >= 0.7 * distance;
  if (down === 3 || down === 4) return gain >= distance;
  return null;
}

/* every dropback in a season, attributed, in play order, with what happened */
const PLAY_COLS = ['game_id', 'week', 'team', 'play_id', 'down', 'distance',
  'completion_player_id', 'completion_yds', 'incompletion_player_id',
  'sack_taken_player_id', 'sack_taken_stat', 'interception_thrown_player_id'];

/* A dropback outside these bounds is not football, it is a parse fault or a
   feed fault. Either way it is dropped and counted rather than averaged in. */
const MIN_GAIN = -40, MAX_GAIN = 110;

function dropbacksOf(text) {
  const byGameTeam = new Map();
  let seq = 0, rejected = 0;
  const parse = eachRow(text, PLAY_COLS, r => {
    const comp = NA(r.completion_player_id), inc = NA(r.incompletion_player_id),
      sack = NA(r.sack_taken_player_id), int_ = NA(r.interception_thrown_player_id);
    const pid = comp || inc || sack || int_;
    if (!pid) return;
    const team = FBS.normKey(r.team);
    if (!team) return;
    let gain = 0, kind = 'incompletion';
    if (comp) { gain = NUM(r.completion_yds) || 0; kind = 'completion'; }
    else if (sack) { gain = -(NUM(r.sack_taken_stat) || 0); kind = 'sack'; }
    else if (int_) { gain = 0; kind = 'interception'; }
    if (!(gain >= MIN_GAIN && gain <= MAX_GAIN)) { rejected++; return; }
    const down = NUM(r.down), dist = NUM(r.distance);
    const succ = (kind === 'sack' || kind === 'interception') ? false : isSuccess(down, dist, gain);
    const key = String(r.game_id) + '|' + team;
    let g = byGameTeam.get(key);
    if (!g) { g = { game_id: String(r.game_id), team, week: NUM(r.week), plays: [] }; byGameTeam.set(key, g); }
    const order = NUM(r.play_id) != null ? NUM(r.play_id) : seq;
    seq++;
    g.plays.push({ pid, order, gain, kind, success: succ });
  });
  for (const g of byGameTeam.values()) g.plays.sort((a, b) => a.order - b.order);
  return { byGameTeam, rejected, malformed: parse.malformed, rows: parse.rows };
}

/* A QUARTERBACK'S RUNNING LINE, carried across seasons. Updated only AFTER a
   game has been used, which is the whole leakage guarantee. */
function newCareer() { return { db: 0, yards: 0, succ: 0, succN: 0 }; }
function addGame(c, plays) {
  for (const p of plays) {
    c.db++; c.yards += p.gain;
    if (p.success !== null) { c.succN++; if (p.success) c.succ++; }
  }
}
/* the two candidate metrics, shrunk toward the league mean by the engine's own
   n/(n+k) form so a quarterback with no history contributes exactly zero */
function scoreOf(c, league, k) {
  if (!c || !c.db) return { ypd: 0, sr: 0, n: 0 };
  const w = c.db / (c.db + k);
  const ypd = c.yards / c.db;
  const sr = c.succN ? c.succ / c.succN : league.sr;
  return { ypd: w * (ypd - league.ypd), sr: w * (sr - league.sr), n: c.db };
}

/* ordinary least squares through the origin: the feature is a DIFFERENCE, so
   a home-side constant would be home-field advantage, which the baseline
   already carries */
function slopeThroughOrigin(rows, pick) {
  let sxy = 0, sxx = 0;
  for (const r of rows) { const x = pick(r); sxy += x * r.residual; sxx += x * x; }
  return sxx > 0 ? sxy / sxx : 0;
}
/* ORDINARY LEAST SQUARES over several features, through the origin, by
   Gaussian elimination on the normal equations. Three features and thousands
   of rows: the normal equations are well within what this can carry, and a
   singular system comes back null rather than as a set of huge cancelling
   coefficients. */
function olsThroughOrigin(rows, keys) {
  const k = keys.length;
  const A = [], b = [];
  for (let i = 0; i < k; i++) { A.push(new Array(k).fill(0)); b.push(0); }
  for (const r of rows) {
    for (let i = 0; i < k; i++) {
      b[i] += r[keys[i]] * r.residual;
      for (let j = 0; j < k; j++) A[i][j] += r[keys[i]] * r[keys[j]];
    }
  }
  for (let c = 0; c < k; c++) {
    let piv = c;
    for (let r2 = c + 1; r2 < k; r2++) if (Math.abs(A[r2][c]) > Math.abs(A[piv][c])) piv = r2;
    if (Math.abs(A[piv][c]) < 1e-12) return null;
    [A[c], A[piv]] = [A[piv], A[c]]; [b[c], b[piv]] = [b[piv], b[c]];
    for (let r2 = 0; r2 < k; r2++) {
      if (r2 === c) continue;
      const f = A[r2][c] / A[c][c];
      for (let j = c; j < k; j++) A[r2][j] -= f * A[c][j];
      b[r2] -= f * b[c];
    }
  }
  const out = {};
  for (let i = 0; i < k; i++) out[keys[i]] = b[i] / A[i][i];
  return out;
}

function spread(rows, key) {
  const xs = rows.map(r => r[key]).sort((a, b) => a - b);
  const mean = xs.reduce((a, x) => a + x, 0) / (xs.length || 1);
  const sd = Math.sqrt(xs.reduce((a, x) => a + (x - mean) * (x - mean), 0) / (xs.length || 1));
  return { sd: r4(sd), p10: r4(xs[Math.floor(xs.length * 0.1)]), p90: r4(xs[Math.floor(xs.length * 0.9)]),
    nonzero: xs.filter(x => Math.abs(x) > 1e-9).length };
}

const mae = (rows, adj) => rows.reduce((a, r) => a + Math.abs(r.residual - (adj ? adj(r) : 0)), 0) / (rows.length || 1);
const rmse = (rows, adj) => Math.sqrt(rows.reduce((a, r) => a + Math.pow(r.residual - (adj ? adj(r) : 0), 2), 0) / (rows.length || 1));

async function main() {
  const seasons = String(arg('seasons', '2019,2020,2021,2022,2023,2024,2025'))
    .split(',').map(s => parseInt(s, 10)).filter(Boolean).sort((a, b) => a - b);
  const offline = !!arg('offline', false);
  const K = (P.qb && P.qb.shrink_attempts) || 100;
  const HFA = (P.venue && P.venue.league_hfa) || 4.082;

  const career = new Map();          /* player id -> running line, across seasons */
  const teamDb = new Map();          /* team -> player id -> dropbacks behind the current rating */
  const incumbentOf = tk => {
    const t = teamDb.get(tk);
    if (!t) return null;
    let best = null, bn = 0;
    for (const [pid, n] of t) if (n > bn) { bn = n; best = pid; }
    return best;
  };
  const rows = [];                   /* one per usable game */
  const readSeasons = [], failed = [], parseNotes = [];
  let league = { ypd: 6.0, sr: 0.42 };   /* seeded, then re-measured from each season as it is read */
  const st = E.newState();
  let skippedNoOpener = 0, skippedNonFbs = 0, absorbed = 0;

  for (const y of seasons) {
    let plays = null, sched = null;
    try {
      plays = await grab(`${CFB}/player_stats/csv/player_stats_${y}.csv`, `player_stats_${y}.csv`, offline);
      sched = await grab(`${CFB}/schedules/csv/cfb_schedules_${y}.csv`, `cfb_schedules_${y}.csv`, offline);
    } catch (e) { failed.push({ season: y, why: String((e && e.message) || e) }); continue; }
    if (!plays || !sched) { failed.push({ season: y, why: 'not published or not cached' }); continue; }
    readSeasons.push(y);

    const parsed = dropbacksOf(plays);
    const byGameTeam = parsed.byGameTeam;
    /* A FEED THAT SUDDENLY WILL NOT PARSE MUST STOP THE JOB, not quietly
       contribute a season of nonsense to the coefficient. */
    const badShare = parsed.rows ? (parsed.malformed + parsed.rejected) / parsed.rows : 1;
    if (badShare > 0.01) {
      console.error(`[qb-fit] ${y}: ${parsed.malformed} malformed rows and ${parsed.rejected} out-of-range `
        + `dropbacks out of ${parsed.rows} (${(badShare * 100).toFixed(2)}%) — refusing to fit on this`);
      process.exit(2);
    }
    if (parsed.malformed || parsed.rejected) {
      log(`[qb-fit] ${y}: dropped ${parsed.malformed} malformed rows and ${parsed.rejected} out-of-range dropbacks`);
    }
    parseNotes.push({ season: y, rows: parsed.rows, malformed: parsed.malformed, out_of_range: parsed.rejected });
    /* the league line for THIS season, used to centre the metrics. It is a
       season aggregate and is not a per-game leak: it says what an average
       dropback looked like, not what happened in the game being predicted. */
    let ly = 0, ld = 0, ls = 0, ln = 0;
    for (const g of byGameTeam.values()) for (const p of g.plays) {
      ld++; ly += p.gain; if (p.success !== null) { ln++; if (p.success) ls++; }
    }
    if (ld) league = { ypd: ly / ld, sr: ln ? ls / ln : league.sr };

    const games = parseCsvSmall(sched).map(r => ({
      game_id: String(r.game_id), start_date: r.start_date, completed: TRUE(r.completed),
      neutral_site: TRUE(r.neutral_site),
      home_team: r.home_team, away_team: r.away_team,
      home_division: r.home_division, away_division: r.away_division,
      home_points: NUM(r.home_points), away_points: NUM(r.away_points)
    })).filter(g => g.completed && g.home_points != null && g.away_points != null)
      .sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)));

    E.ingest.seasonBreak(st);
    /* THE INCUMBENT RESETS WITH THE SEASON. The rating carries over, but the
       question this feature asks is "is the rating carrying the wrong
       quarterback THIS season", and in week one nobody has taken a snap behind
       it yet. A stale incumbent from last November would make every week-one
       game look like a quarterback change. */
    teamDb.clear();

    for (const g of games) {
      const hk = FBS.normKey(g.home_team), ak = FBS.normKey(g.away_team);
      const hFbs = FBS.isFbsDivision(g.home_division, g.home_team, { knownFbs: P.rating.seed_ratings });
      const aFbs = FBS.isFbsDivision(g.away_division, g.away_team, { knownFbs: P.rating.seed_ratings });
      const hPlays = byGameTeam.get(g.game_id + '|' + hk);
      const aPlays = byGameTeam.get(g.game_id + '|' + ak);

      /* ---- the observation, taken BEFORE anything about this game is
         absorbed into either the ratings or the quarterback lines ---- */
      if (hFbs && aFbs) {
        const hOpen = hPlays && hPlays.plays.length ? hPlays.plays[0].pid : null;
        const aOpen = aPlays && aPlays.plays.length ? aPlays.plays[0].pid : null;
        if (hOpen && aOpen) {
          const hs = scoreOf(career.get(hOpen), league, K);
          const as = scoreOf(career.get(aOpen), league, K);
          /* THE RATING ALREADY CONTAINS A QUARTERBACK.

             This is the thing the level feature above gets wrong, and it is
             why it barely beats nothing out of sample. The rating state was
             built by absorbing games this team already played, and whoever
             played quarterback in them is inside that number. Asking "how good
             is the starter" therefore asks the ratings to be surprised by
             something they have already priced.

             What the ratings have NOT priced is a CHANGE. When the man who
             took the snaps in the games behind the rating is not the man
             taking them today, the rating is carrying the wrong quarterback,
             and the size of that error is the difference between the two. When
             it is the same man the feature is exactly zero, which is the
             correct answer rather than a small one. */
          const hInc = incumbentOf(hk), aInc = incumbentOf(ak);
          const hDelta = hInc && hInc !== hOpen ? (hs.ypd - scoreOf(career.get(hInc), league, K).ypd) : 0;
          const aDelta = aInc && aInc !== aOpen ? (as.ypd - scoreOf(career.get(aInc), league, K).ypd) : 0;
          const baseline = E.strength.predictMargin(st, hk, ak, hFbs, aFbs, g.neutral_site ? 0 : HFA);
          if (isFinite(baseline)) {
            rows.push({
              season: y, game_id: g.game_id,
              residual: (g.home_points - g.away_points) - baseline,
              ypd: hs.ypd - as.ypd, sr: hs.sr - as.sr,
              delta: hDelta - aDelta,
              changed: (hInc && hInc !== hOpen ? 1 : 0) + (aInc && aInc !== aOpen ? 1 : 0),
              n_home: hs.n, n_away: as.n
            });
          }
        } else skippedNoOpener++;
      } else skippedNonFbs++;

      /* ---- only now does this game become history ---- */
      /* THE INCUMBENT: whoever has taken the most dropbacks in the games that
         built this team's current rating. Updated after the fact, like
         everything else here, so it never describes the game being predicted. */
      E.ingest.absorbGame(st, { home: g.home_team, away: g.away_team, home_fbs: hFbs, away_fbs: aFbs,
        neutral_site: g.neutral_site, home_points: g.home_points, away_points: g.away_points });
      absorbed++;
      for (const [side, tk] of [[hPlays, hk], [aPlays, ak]]) {
        if (!side) continue;
        const byPid = new Map();
        for (const p of side.plays) { if (!byPid.has(p.pid)) byPid.set(p.pid, []); byPid.get(p.pid).push(p); }
        for (const [pid, ps] of byPid) {
          if (!career.has(pid)) career.set(pid, newCareer());
          addGame(career.get(pid), ps);
          if (!teamDb.has(tk)) teamDb.set(tk, new Map());
          const t = teamDb.get(tk);
          t.set(pid, (t.get(pid) || 0) + ps.length);
        }
      }
    }
    log(`[qb-fit] ${y}: ${rows.filter(r => r.season === y).length} usable games `
      + `(league ${league.ypd.toFixed(2)} yds/dropback, ${(league.sr * 100).toFixed(1)}% success)`);
  }

  if (rows.length < 500) {
    console.error(`[qb-fit] only ${rows.length} usable games — refusing to fit a coefficient on that`);
    process.exit(2);
  }

  /* ---------------------------------------------------------- walk forward */
  /* Fit on everything BEFORE a season, score that season. A coefficient that
     only works on the games it was fitted to is the failure mode this exists
     to catch, so the in-sample number is reported and never used to decide. */
  const COMBINED = ['ypd', 'sr', 'delta'];
  const metrics = ['ypd', 'sr', 'delta', 'combined'];
  const walk = {};
  for (const m of metrics) {
    walk[m] = { folds: [], held_out_games: 0, base_mae: 0, adj_mae: 0, base_rmse: 0, adj_rmse: 0 };
    for (const y of readSeasons) {
      const train = rows.filter(r => r.season < y);
      const test = rows.filter(r => r.season === y);
      if (train.length < 300 || !test.length) continue;
      let b, adj;
      if (m === 'combined') {
        b = olsThroughOrigin(train, COMBINED);
        if (!b) continue;
        adj = r => COMBINED.reduce((a, k2) => a + b[k2] * r[k2], 0);
      } else {
        b = slopeThroughOrigin(train, r => r[m]);
        adj = r => b * r[m];
      }
      const fold = {
        season: y, train_games: train.length, test_games: test.length,
        coefficient: (m === 'combined')
          ? Object.keys(b).reduce((o, k2) => (o[k2] = r4(b[k2]), o), {}) : r4(b),
        base_mae: r4(mae(test)), adj_mae: r4(mae(test, adj)),
        base_rmse: r4(rmse(test)), adj_rmse: r4(rmse(test, adj))
      };
      fold.mae_delta = r4(fold.adj_mae - fold.base_mae);
      walk[m].folds.push(fold);
      walk[m].held_out_games += test.length;
      walk[m].base_mae += fold.base_mae * test.length;
      walk[m].adj_mae += fold.adj_mae * test.length;
      walk[m].base_rmse += fold.base_rmse * test.length;
      walk[m].adj_rmse += fold.adj_rmse * test.length;
    }
    const n = walk[m].held_out_games || 1;
    walk[m].base_mae = r4(walk[m].base_mae / n);
    walk[m].adj_mae = r4(walk[m].adj_mae / n);
    walk[m].base_rmse = r4(walk[m].base_rmse / n);
    walk[m].adj_rmse = r4(walk[m].adj_rmse / n);
    walk[m].mae_delta = r4(walk[m].adj_mae - walk[m].base_mae);
    walk[m].folds_improved = walk[m].folds.filter(f => f.mae_delta < 0).length;
    if (m === 'combined') {
      const f = olsThroughOrigin(rows, COMBINED);
      walk[m].full_sample_coefficient = f ? Object.keys(f).reduce((o, k2) => (o[k2] = r4(f[k2]), o), {}) : null;
    } else {
      walk[m].full_sample_coefficient = r4(slopeThroughOrigin(rows, r => r[m]));
      walk[m].feature_spread = spread(rows, m);
      /* WHAT THE COEFFICIENT WOULD ACTUALLY DO TO A LINE, so a reader can see
         whether a statistically-arguable effect is even football-sized. */
      walk[m].implied_points_p10_p90 = [
        r4(walk[m].full_sample_coefficient * walk[m].feature_spread.p10),
        r4(walk[m].full_sample_coefficient * walk[m].feature_spread.p90)];
    }
  }

  /* THE DECISION, AND IT IS NOT MINE. A metric earns points only if it lowers
     held-out MAE overall AND does so in a majority of the folds — one lucky
     season is not a record. Anything else ships applied:false and the engine
     keeps contributing zero, exactly as travel does. */
  const ranked = metrics.filter(m => walk[m].folds.length).slice()
    .sort((a, b) => walk[a].mae_delta - walk[b].mae_delta);
  const best = ranked[0];
  const w = walk[best];
  const majority = w.folds.length ? w.folds_improved / w.folds.length > 0.5 : false;
  const applied = w.mae_delta < 0 && majority;

  const out = {
    schema: SCHEMA, version: 1, generated_at: new Date().toISOString(),
    source: 'cfbfastR-data player_stats and schedules',
    seasons_read: readSeasons, seasons_failed: failed,
    tune_window_games: rows.length,
    skipped: { no_resolvable_opener: skippedNoOpener, not_fbs_vs_fbs: skippedNonFbs },
    parse: parseNotes,
    games_absorbed: absorbed,
    target: 'actual home margin minus the rating state’s own prediction (rating gap + league home-field advantage), '
      + 'taken BEFORE the game was absorbed',
    feature: 'home opening quarterback’s career-to-date quality minus the away opener’s, both measured '
      + 'only from games already processed and shrunk toward the league mean by n/(n+' + K + ')',
    shrink_attempts: K,
    league_reference: { yards_per_dropback: r4(league.ypd), success_rate: r4(league.sr),
      note: 'the last season read; each season is centred on its own' },
    metrics: walk,
    chosen_metric: best,
    points_per_quality: walk[best].full_sample_coefficient,
    points_applied: applied,
    decision: applied
      ? `${best} lowered held-out MAE by ${Math.abs(w.mae_delta).toFixed(4)} points a game across `
        + `${w.held_out_games} games and improved ${w.folds_improved} of ${w.folds.length} folds, so it is applied`
      : `${best} is the better of the two and it did NOT earn its keep out of sample `
        + `(held-out MAE ${w.mae_delta >= 0 ? 'rose' : 'fell'} by ${Math.abs(w.mae_delta).toFixed(4)} points a game, `
        + `${w.folds_improved} of ${w.folds.length} folds improved). points_applied is false and the QB layer `
        + 'contributes zero to the spread, which is what it did before this job existed',
    note: 'points_applied is set by the walk-forward above and by nothing else. The engine reads it and refuses '
      + 'to price the layer when it is false, the same discipline params.travel.points_applied already carries.',
    /* EVERY QUARTERBACK'S SCORE AS THE WINDOW ENDS, so the same number the fit
       was measured on is the number a live projection reads. Recomputing it at
       prediction time from a different definition is how a coefficient comes
       to be applied to a feature it was never fitted against. Shrunk and
       centred exactly as the feature was; a passer with no history scores 0,
       which is the correct contribution rather than a missing one. */
    players_as_of: readSeasons.length ? readSeasons[readSeasons.length - 1] : null,
    players: (() => {
      const out = {};
      for (const [pid, c] of career) {
        if (!c.db) continue;
        const sc = scoreOf(c, league, K);
        out[pid] = { ypd: r4(sc.ypd), sr: r4(sc.sr), dropbacks: c.db };
      }
      return out;
    })()
  };

  const dest = path.join(ROOT, String(arg('out', 'football/cfb_p4/research/qb_quality.json')));
  fs.writeFileSync(dest, JSON.stringify(out, null, 1) + '\n');
  log('[qb-fit] wrote ' + path.relative(ROOT, dest));
  log('[qb-fit] tune window: ' + rows.length + ' games over ' + readSeasons.join(', '));
  for (const m of metrics) {
    const x = walk[m];
    log(`  ${m.padEnd(9)} coef ${String(JSON.stringify(x.full_sample_coefficient)).padStart(9)}  held-out MAE `
      + `${x.base_mae} -> ${x.adj_mae}  (${x.mae_delta >= 0 ? '+' : ''}${x.mae_delta})  `
      + `${x.folds_improved}/${x.folds.length} folds improved`);
  }
  log('[qb-fit] ' + out.decision);
}

main().catch(e => { console.error('[qb-fit] ' + ((e && e.stack) || e)); process.exit(2); });
