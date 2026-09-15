#!/usr/bin/env node
/* ============================================================================
   IS A QUARTERBACK WORTH POINTS OF SPREAD? — asked again, with the five
   leaks that made the last answer unreadable actually closed.

   WHAT THIS REPLACES. `fit_qb_quality.js` asked the right question with a
   substitute metric (yards per dropback) and answered it inside a harness with
   five specific defects. Each one is named below, each one is closed here, and
   each closure is asserted rather than asserted-to-have-been-done. The point of
   this file is NOT to get a better number. It is to find out what the number is
   when the experiment cannot flatter itself.

   ─────────────────────────────────────────────────────── THE FIVE, AND THE FIX

   1  THE RATING STATE WAS SEEDED FROM 2025.
      `E.newState()` clones `params.rating.seed_ratings`, and the shipped
      parameter artifact says `trained_through_season: 2025`. Replaying 2019
      from that state hands every 2019 game a rating trained on 2020-2025
      football; season decay shrinks it, it does not remove it.
      FIX: the state starts genuinely COLD — every rating, game count, scoring
      EWMA, efficiency EWMA and conference strength emptied — and is warmed up
      by replaying whole seasons before the first evaluation fold. `coldState()`
      below, and `assertColdStart()` fails the run if a seeded value survives.

   2  THE LEAGUE CENTRE WAS THE WHOLE SEASON'S.
      The centring constant for a week-two game was computed from the entire
      season's play file, September to January. Two passers with different
      shrinkage weights do not cancel a shared centre, so this moves the
      feature DIFFERENCE, not only its level.
      FIX: the centre is computed from games that had FINISHED before the
      kickoff being predicted, falling back to the previous season's closing
      rate in the weeks before the current one has any. Strictly lagged.

   3  THE QUARTERBACK WAS READ OUT OF THE GAME BEING PREDICTED.
      `hOpen`/`aOpen` came from the first recorded dropback OF THAT GAME. That
      is a retrospective question — "given who actually played" — and it is a
      legitimate one, but it is not the question a Saturday-morning price has
      to answer.
      FIX: TWO ARMS, run side by side and never pooled. `pregame` names the
      candidate from the last game that had finished; `participant` names the
      man who actually threw. The second is the ceiling on what quarterback
      information could be worth; the first is what a deployable forecast can
      have. Reporting the second as if it were the first is the error.

   4  THE WINNING FEATURE WAS PICKED ON THE FOLDS THAT REPORTED IT.
      Five candidates were walked forward, the best was chosen, and its
      walk-forward numbers were published as the result. That is selection,
      and selected folds are not held out.
      FIX: NESTED chronological selection. For every outer test season Y the
      candidate is chosen by an inner walk-forward over seasons strictly before
      Y, refit on everything before Y, and only then scored on Y. Which feature
      each outer fold picked is published, because the instability of that
      choice is itself a result.

   5  GAMES WERE ABSORBED BEFORE THEY HAD FINISHED.
      Sorting by kickoff and absorbing sequentially means a noon game is inside
      the rating used to predict the other noon game. Nothing in the old
      harness knew when a game ENDED.
      FIX: a completion buffer. A game becomes history `COMPLETION_HOURS` after
      its own kickoff and not before; games are held in a pending queue and
      released against the target kickoff. Every history read in this file goes
      through that queue.

   ───────────────────────────────────────────────────────────── WHAT IS TESTED

   Real passing EPA per dropback from `football/fbs_epa`, not a yards proxy —
   and read with the audit attached: `epa_contract.js` establishes the series is
   not on the scale `params.qb.points_per_epa_db` was fitted against, so this
   file FITS ITS OWN COEFFICIENT inside each training window and never borrows
   that one.

     level      the two candidates' shrunk career EPA per dropback, differenced
     recent     the same over their last five completed games
     change     candidate minus the INCUMBENT behind the current rating, which
                is the part the team rating cannot already contain
     matchup    each candidate's level against the pass defence he faces
     level+chg  the two together

   ───────────────────────────────────────────────────── WHAT IS NOT CLAIMED

   2014-2025 have already informed feature choices in this repository, so
   results on them are EXPLORATORY and are labelled that way in the artifact.
   The provider's expected-points model is one artifact scored onto every
   season, so even a clean fold is not vintage-correct. Neither of those is a
   reason to skip the experiment; both are reasons not to call its output a
   fresh out-of-sample record, and the artifact says so in its own fields.

     node football/cfb_p4/research/fit_qb_epa.js
          [--warmup 2014,2015,2016,2017] [--folds 2018,...,2026]
          [--corpus DIR] [--boot 2000] [--out PATH] [--quiet]

   Exit 2 means the experiment could not be attempted. A coefficient that fails
   its rule is NOT an error: it is written with points_applied:false and the
   engine keeps contributing zero, which is the honest outcome.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const HERE = __dirname;
const ROOT = path.join(HERE, '..', '..', '..');
global.window = global.window || global;
require(path.join(ROOT, 'football', 'cfb_p4', 'params.js'));
const E = require(path.join(ROOT, 'football', 'cfb_p4', 'engine.js'));
const FBS = require(path.join(ROOT, 'football', 'fbs', 'fbs.js'));
const CONTRACT = require(path.join(ROOT, 'football', 'fbs_epa', 'epa_contract.js'));
const P = global.EDCfbP4Params;

const SCHEMA = 'edgedesk_qb_epa_experiment_v1';
const DEFAULT_CORPUS = path.join(ROOT, 'football', 'data', 'cache', 'fbs_epa', 'corpus');

/* A college football game takes about three and a half hours. Four is the
   buffer, and it is deliberately generous: the cost of being late is that a
   real fact is withheld for an hour, and the cost of being early is a leak. */
const COMPLETION_HOURS = 4;

/* the engine's OWN shrinkage form and constant, so the feature is shrunk the
   way the layer that would price it shrinks */
const K = (P.qb && P.qb.shrink_attempts) || 100;
/* a candidate with fewer than this many career dropbacks is a "low-history"
   quarterback for the subgroup report. Declared here, not tuned. */
const LOW_HISTORY_DROPBACKS = 100;

function arg(name, fb) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fb;
  const v = process.argv[i + 1];
  return (v == null || String(v).startsWith('--')) ? true : v;
}
const QUIET = !!arg('quiet', false);
const log = (...a) => { if (!QUIET) console.error(...a); };
const isNum = x => typeof x === 'number' && isFinite(x);
const r4 = x => (isNum(x) ? Math.round(x * 10000) / 10000 : null);
const r3 = x => (isNum(x) ? Math.round(x * 1000) / 1000 : null);

/* ------------------------------------------------------------------ corpus */
function readCorpus(dir, name) {
  const f = path.join(dir, name + '.jsonl.gz');
  if (!fs.existsSync(f)) return null;
  const out = [];
  zlib.gunzipSync(fs.readFileSync(f)).toString('utf8').split('\n').forEach(l => { if (l) out.push(JSON.parse(l)); });
  return out;
}

/* ============================================================================
   FIX 1 — A GENUINELY COLD STATE.

   Everything the shipped parameters seeded is emptied. The hyperparameters
   (k, cap, hfa, carry, the two floors) stay, and that is DECLARED rather than
   hidden: they are six smoothing constants fitted on the whole window, not
   per-team information, and re-estimating them inside every fold is a
   different project from this one. `residual_dependencies` in the artifact
   names them, because an undeclared dependency is the thing that makes a
   result unreadable, not a declared one.
   ========================================================================== */
function coldState() {
  const st = E.newState();
  st.r = {}; st.n = {}; st.scoring = {}; st.eff = {}; st.conf = {};
  st.r0 = {}; st.rf = {}; st.gamesThisSeason = {};
  st.seededThrough = null;
  st.absorbed = 0;
  return st;
}
function assertColdStart(st) {
  const seeds = P.rating.seed_ratings || {};
  const names = Object.keys(seeds);
  const leaked = names.filter(k => st.r[k] !== undefined);
  if (leaked.length) {
    throw new Error('cold start failed: ' + leaked.length + ' seeded ratings survived (' + leaked.slice(0, 3) + ')');
  }
  if (Object.keys(st.conf || {}).length) throw new Error('cold start failed: seeded conference strength survived');
  if (Object.keys(st.n || {}).length) throw new Error('cold start failed: seeded game counts survived');
}

/* ============================================================================
   FIX 5 — A GAME BECOMES HISTORY WHEN IT FINISHES.

   Everything that can look backwards in this file looks through this queue,
   which releases a game only once COMPLETION_HOURS have passed since its own
   kickoff. Two games at the same kickoff can therefore never see each other,
   which is what sorting by start time quietly allowed.
   ========================================================================== */
function History(onRelease) {
  const pending = [];        /* kept in kickoff order by the caller */
  let next = 0;
  return {
    push(g) { pending.push(g); },
    /* release everything finished strictly before `asOf` (a ms timestamp) */
    releaseBefore(asOf) {
      while (next < pending.length && pending[next].finishedAt <= asOf) {
        onRelease(pending[next]);
        next++;
      }
    },
    releaseAll() { while (next < pending.length) { onRelease(pending[next]); next++; } },
    get released() { return next; },
    /* HOW MUCH WORK THE BUFFER IS DOING, measured rather than asserted: the
       games that had already KICKED OFF by `asOf` but had not finished. Under
       the old sort-and-absorb rule every one of these was inside the rating
       used to predict the next game. */
    unfinishedAt(asOf) {
      let n = 0;
      for (let i = next; i < pending.length; i++) {
        if (pending[i].kickMs != null && pending[i].kickMs <= asOf && pending[i].finishedAt > asOf) n++;
        else if (pending[i].kickMs != null && pending[i].kickMs > asOf) break;
      }
      return n;
    }
  };
}

/* ------------------------------------------------------------- aggregation */
function newLine() {
  return { games: 0, epaGames: 0, db: 0, epa: 0, att: 0, sacks: 0, ints: 0, yards: 0,
    recent: [], seasons: {}, lastTeam: null, lastSeason: null };
}
function addGame(line, row) {
  line.games++;
  line.att += row.attempts || 0; line.sacks += row.sacks || 0;
  line.ints += row.interceptions || 0; line.yards += row.passing_yards || 0;
  if (row.epa_denominator_consistent === true && row.recorded_dropbacks > 0) {
    line.epaGames++; line.db += row.recorded_dropbacks; line.epa += row.provider_epa_total;
  }
  line.recent.push(row);
  if (line.recent.length > 5) line.recent.shift();
  line.seasons[row.season] = 1;
  line.lastTeam = row.team_key; line.lastSeason = row.season;
}
/* FIX 2 — the centre is the league rate as it stood BEFORE this kickoff. */
function shrunk(line, leagueRate) {
  if (!line || !line.epaGames || !line.db || !isNum(leagueRate)) return null;
  const w = line.db / (line.db + K);
  return { v: w * (line.epa / line.db - leagueRate), n: line.db, rate: line.epa / line.db, w };
}
function recentShrunk(line, leagueRate) {
  if (!line || !isNum(leagueRate)) return null;
  let db = 0, epa = 0;
  line.recent.forEach(r => {
    if (r.epa_denominator_consistent === true && r.recorded_dropbacks > 0) { db += r.recorded_dropbacks; epa += r.provider_epa_total; }
  });
  if (!db) return null;
  const w = db / (db + K);
  return { v: w * (epa / db - leagueRate), n: db, rate: epa / db, w };
}

/* -------------------------------------------------------------- regression */
function ols(X, y) {
  const p = X[0].length, n = X.length;
  const A = [], b = [];
  for (let i = 0; i < p; i++) { A.push(new Array(p).fill(0)); b.push(0); }
  for (let r = 0; r < n; r++) {
    for (let i = 0; i < p; i++) {
      b[i] += X[r][i] * y[r];
      for (let j = 0; j < p; j++) A[i][j] += X[r][i] * X[r][j];
    }
  }
  /* Gaussian elimination with partial pivoting; a singular design returns
     null rather than a plausible-looking set of coefficients */
  for (let i = 0; i < p; i++) {
    let piv = i;
    for (let r = i + 1; r < p; r++) if (Math.abs(A[r][i]) > Math.abs(A[piv][i])) piv = r;
    if (Math.abs(A[piv][i]) < 1e-12) return null;
    if (piv !== i) { const t = A[i]; A[i] = A[piv]; A[piv] = t; const tb = b[i]; b[i] = b[piv]; b[piv] = tb; }
    for (let r = i + 1; r < p; r++) {
      const f = A[r][i] / A[i][i];
      if (!f) continue;
      for (let c = i; c < p; c++) A[r][c] -= f * A[i][c];
      b[r] -= f * b[i];
    }
  }
  const w = new Array(p).fill(0);
  for (let i = p - 1; i >= 0; i--) {
    let s = b[i];
    for (let j = i + 1; j < p; j++) s -= A[i][j] * w[j];
    w[i] = s / A[i][i];
  }
  return w;
}

/* ------------------------------------------------------------- the features */
/* Each returns the model-matrix columns for one row, or null when the row
   cannot carry that feature. A row that cannot carry it is EXCLUDED from that
   feature's fit and from its evaluation, and the count is reported — it is not
   silently scored at zero. */
const FEATURES = {
  level: {
    label: 'career EPA per dropback, shrunk and differenced',
    cols: r => (isNum(r.h_level) && isNum(r.a_level)) ? [r.h_level - r.a_level] : null
  },
  recent: {
    label: 'last-five-game EPA per dropback, shrunk and differenced',
    cols: r => (isNum(r.h_recent) && isNum(r.a_recent)) ? [r.h_recent - r.a_recent] : null
  },
  change: {
    label: 'candidate minus incumbent — the part the team rating cannot contain',
    cols: r => (isNum(r.h_change) && isNum(r.a_change)) ? [r.h_change - r.a_change] : null
  },
  matchup: {
    label: 'each candidate against the pass defence he faces',
    cols: r => (isNum(r.h_level) && isNum(r.a_level) && isNum(r.h_oppdef) && isNum(r.a_oppdef))
      ? [r.h_level * r.h_oppdef - r.a_level * r.a_oppdef] : null
  },
  level_and_change: {
    label: 'level and change together, two coefficients',
    cols: r => (isNum(r.h_level) && isNum(r.a_level) && isNum(r.h_change) && isNum(r.a_change))
      ? [r.h_level - r.a_level, r.h_change - r.a_change] : null
  }
};
const FEATURE_KEYS = Object.keys(FEATURES);

function design(rows, key) {
  const f = FEATURES[key];
  const X = [], y = [], keep = [];
  rows.forEach(r => {
    const c = f.cols(r);
    if (!c) return;
    X.push(c.concat([1]));
    y.push(r.residual);
    keep.push(r);
  });
  return { X, y, rows: keep };
}
function fit(rows, key) {
  const d = design(rows, key);
  if (d.X.length < 300) return null;
  const w = ols(d.X, d.y);
  if (!w) return null;
  return { key, w, n: d.X.length };
}
function adjust(model, r) {
  const c = FEATURES[model.key].cols(r);
  if (!c) return null;
  let s = 0;
  for (let i = 0; i < c.length; i++) s += model.w[i] * c[i];
  return s + model.w[model.w.length - 1];
}
/* A SPREAD CAN IMPROVE WHILE THE PROBABILITIES GET WORSE, so both are scored.

   The win probability is the engine's own form — a normal around the projected
   margin at the trained CFB margin sigma — and BOTH arms use the same sigma,
   so any Brier difference between them comes from the mean shift and from
   nothing else. That is the comparison the promotion rule asks for; it is not
   a claim that this sigma is the right one for either arm. */
const SIGMA_MARGIN = (P.distributions && P.distributions.sigma_margin) || 14.9;
function normCdf(z) {
  /* Abramowitz & Stegun 7.1.26, the same approximation the engine carries */
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-z * z / 2);
  const pr = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - pr : pr;
}
function winProb(margin) { return normCdf(margin / SIGMA_MARGIN); }

/* Paired errors. Only rows the candidate can actually score are compared, and
   the count is carried so a feature cannot look good by quietly covering the
   easy half of the slate. */
function score(model, rows) {
  let baseAbs = 0, adjAbs = 0, baseSq = 0, adjSq = 0, n = 0;
  let baseBrier = 0, adjBrier = 0, brierN = 0;
  const paired = [];
  rows.forEach(r => {
    const a = adjust(model, r);
    if (a == null) return;
    const be = Math.abs(r.residual), ae = Math.abs(r.residual - a);
    baseAbs += be; adjAbs += ae; baseSq += r.residual * r.residual; adjSq += (r.residual - a) * (r.residual - a);
    paired.push(be - ae);
    n++;
    /* the actual margin is the baseline prediction plus the residual; a push
       (margin exactly zero) is not a win for either side and is excluded */
    const actual = r.baseline + r.residual;
    if (actual !== 0) {
      const y = actual > 0 ? 1 : 0;
      const pb = winProb(r.baseline), pa = winProb(r.baseline + a);
      baseBrier += (pb - y) * (pb - y); adjBrier += (pa - y) * (pa - y); brierN++;
    }
  });
  if (!n) return null;
  return { n, base_mae: baseAbs / n, adj_mae: adjAbs / n,
    base_rmse: Math.sqrt(baseSq / n), adj_rmse: Math.sqrt(adjSq / n),
    mae_delta: (adjAbs - baseAbs) / n,
    base_brier: brierN ? baseBrier / brierN : null,
    adj_brier: brierN ? adjBrier / brierN : null,
    brier_n: brierN,
    paired };
}

/* A paired bootstrap over GAMES. The two arms see the same games, so the
   pairing is what makes the interval honest; an unpaired interval on two
   pooled means would be wider and would answer a question nobody asked. */
function bootstrapCi(paired, draws, seed) {
  if (!paired.length) return null;
  let s = seed >>> 0 || 1;
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  const means = new Array(draws);
  for (let d = 0; d < draws; d++) {
    let acc = 0;
    for (let i = 0; i < paired.length; i++) acc += paired[(rnd() * paired.length) | 0];
    means[d] = acc / paired.length;
  }
  means.sort((a, b) => a - b);
  const lo = means[Math.floor(0.025 * draws)], hi = means[Math.floor(0.975 * draws)];
  const point = paired.reduce((a, b) => a + b, 0) / paired.length;
  /* the share of resamples on the wrong side of zero: a two-sided bootstrap
     p-value for "this feature reduces error by nothing at all" */
  let wrong = 0;
  for (let d = 0; d < draws; d++) if ((point >= 0 ? means[d] <= 0 : means[d] >= 0)) wrong++;
  return { improvement: r4(point), ci95: [r4(lo), r4(hi)], p_two_sided: r4(Math.min(1, 2 * wrong / draws)),
    n: paired.length,
    basis: 'paired bootstrap over games of (baseline |error| - adjusted |error|). Positive is an improvement.' };
}

/* ============================================================================
   THE REPLAY
   ========================================================================== */
function buildRows(corpus, opts) {
  const { games, passers, teamGames } = corpus;
  const arm = opts.arm;                       /* 'pregame' | 'participant' */

  const gameById = new Map(games.map(g => [String(g.game_id), g]));
  const keyOf = new Map();
  games.forEach(g => {
    keyOf.set(String(g.home_team_id), FBS.normKey(g.home_team));
    keyOf.set(String(g.away_team_id), FBS.normKey(g.away_team));
  });

  /* passer rows, grouped by game and team, in kickoff order */
  const byGameTeam = new Map();
  passers.forEach(p => {
    const g = gameById.get(String(p.game_id));
    if (!g || !g.completed_by_cutoff) return;
    const k = String(p.game_id) + '|' + String(p.team_id);
    if (!byGameTeam.has(k)) byGameTeam.set(k, []);
    byGameTeam.get(k).push(Object.assign({}, p, { team_key: keyOf.get(String(p.team_id)) || null }));
  });
  const teamGameRows = new Map();
  teamGames.forEach(t => {
    const k = String(t.game_id) + '|' + String(t.team_id);
    teamGameRows.set(k, t);
  });

  const ordered = games.filter(g => g.completed_by_cutoff)
    .map(g => Object.assign({}, g, {
      kickMs: Date.parse(g.kickoff),
      finishedAt: Date.parse(g.kickoff) + COMPLETION_HOURS * 3600000
    }))
    .filter(g => isFinite(g.kickMs))
    .sort((a, b) => a.kickMs - b.kickMs || String(a.game_id).localeCompare(String(b.game_id)));

  const st = coldState();
  assertColdStart(st);

  const career = new Map();          /* athlete_id -> line */
  const teamDb = new Map();          /* team key -> athlete_id -> dropbacks behind the rating */
  const teamLastGame = new Map();    /* team key -> last released game's passer rows */
  const defAllowed = new Map();      /* team key -> recent allowed pass EPA/play */
  const leagueRun = { epa: 0, db: 0 };
  /* A SECOND LEAGUE LINE, because the two quantities are not on one scale.
     EPA per DROPBACK centres a passer; EPA per PLAY centres a pass defence,
     and the provider publishes the second on the team row. Centring one with
     the other would put a number into the interaction term that is neither.
     Both are strictly lagged in exactly the same way. */
  const leagueDefRun = { sum: 0, n: 0 };
  let priorLeagueDefRate = null;
  let priorLeagueRate = null;        /* the closing rate of the previous season */
  let seasonNow = null;
  const rows = [];
  const counts = { released: 0, skipped_non_fbs: 0, skipped_no_candidate: 0, skipped_no_baseline: 0,
    skipped_no_history: 0, used: 0,
    /* the leak the completion buffer closes, counted: games that had kicked
       off but not finished when this one kicked off. The old harness put every
       one of them inside the rating it predicted from. */
    games_withheld_because_unfinished: 0,
    predictions_with_an_unfinished_game_in_flight: 0 };

  /* the release side: this is the ONLY place history changes */
  function release(g) {
    counts.released++;
    const hk = keyOf.get(String(g.home_team_id)), ak = keyOf.get(String(g.away_team_id));
    const hFbs = g.home_division === 'fbs', aFbs = g.away_division === 'fbs';
    E.ingest.absorbGame(st, { home: g.home_team, away: g.away_team, home_fbs: hFbs, away_fbs: aFbs,
      neutral_site: g.neutral_site, home_points: g.home_points, away_points: g.away_points });
    [[String(g.home_team_id), hk], [String(g.away_team_id), ak]].forEach(([tid, tk]) => {
      if (!tk) return;
      const list = byGameTeam.get(String(g.game_id) + '|' + tid) || [];
      if (list.length) teamLastGame.set(tk, { game_id: String(g.game_id), kickoff: g.kickoff, rows: list });
      list.forEach(p => {
        if (p.epa_denominator_consistent === true && p.recorded_dropbacks > 0) {
          leagueRun.epa += p.provider_epa_total; leagueRun.db += p.recorded_dropbacks;
        }
        if (!p.athlete_id) return;
        const id = String(p.athlete_id);
        if (!career.has(id)) career.set(id, newLine());
        addGame(career.get(id), p);
        if (!teamDb.has(tk)) teamDb.set(tk, new Map());
        const m = teamDb.get(tk);
        m.set(id, (m.get(id) || 0) + (p.recorded_dropbacks || 0));
      });
      /* what this team's DEFENCE allowed, from the opponent's team-game row */
      const oppId = tid === String(g.home_team_id) ? String(g.away_team_id) : String(g.home_team_id);
      const opp = teamGameRows.get(String(g.game_id) + '|' + oppId);
      if (opp && isNum(opp.pass_epa_per_play)) {
        if (!defAllowed.has(tk)) defAllowed.set(tk, []);
        const arr = defAllowed.get(tk);
        arr.push(opp.pass_epa_per_play);
        if (arr.length > 5) arr.shift();
        leagueDefRun.sum += opp.pass_epa_per_play; leagueDefRun.n++;
      }
    });
  }
  const history = History(release);
  ordered.forEach(g => history.push(g));

  function leagueRate() {
    if (leagueRun.db >= 20000) return leagueRun.epa / leagueRun.db;      /* enough of this season */
    if (priorLeagueRate != null) return priorLeagueRate;
    return leagueRun.db ? leagueRun.epa / leagueRun.db : null;
  }
  function leagueDefRate() {
    if (leagueDefRun.n >= 600) return leagueDefRun.sum / leagueDefRun.n;
    if (priorLeagueDefRate != null) return priorLeagueDefRate;
    return leagueDefRun.n ? leagueDefRun.sum / leagueDefRun.n : null;
  }
  function incumbentOf(tk) {
    const m = teamDb.get(tk);
    if (!m) return null;
    let best = null, bn = 0;
    for (const [id, n] of m) if (n > bn) { bn = n; best = id; }
    return best;
  }
  /* FIX 3, the pregame arm: the candidate is the leading passer of the last
     game that had FINISHED. A tie resolves to nobody. */
  function candidatePregame(tk) {
    const last = teamLastGame.get(tk);
    if (!last) return null;
    const by = new Map();
    last.rows.forEach(p => {
      if (!p.athlete_id) return;
      const id = String(p.athlete_id);
      by.set(id, (by.get(id) || 0) + (p.recorded_dropbacks || 0));
    });
    let best = null, bn = -1, tie = false;
    for (const [id, n] of by) { if (n > bn) { best = id; bn = n; tie = false; } else if (n === bn) tie = true; }
    return (best && bn > 0 && !tie) ? best : null;
  }
  /* FIX 3, the participant arm: the leading passer OF THIS GAME. Retrospective
     by construction, and labelled as such everywhere it appears. */
  function candidateParticipant(gameId, teamId) {
    const list = byGameTeam.get(String(gameId) + '|' + String(teamId)) || [];
    let best = null, bn = -1, tie = false;
    list.forEach(p => {
      if (!p.athlete_id) return;
      const n = p.recorded_dropbacks || 0;
      if (n > bn) { best = String(p.athlete_id); bn = n; tie = false; } else if (n === bn) tie = true;
    });
    return (best && bn > 0 && !tie) ? best : null;
  }

  ordered.forEach(g => {
    if (seasonNow !== g.season) {
      if (seasonNow != null) {
        /* the season closes: the rate it ended on becomes the centre the next
           season's early weeks are measured against, and the running total
           restarts. Nothing from the new season is inside it. */
        priorLeagueRate = leagueRun.db ? leagueRun.epa / leagueRun.db : priorLeagueRate;
        priorLeagueDefRate = leagueDefRun.n ? leagueDefRun.sum / leagueDefRun.n : priorLeagueDefRate;
        leagueRun.epa = 0; leagueRun.db = 0;
        leagueDefRun.sum = 0; leagueDefRun.n = 0;
        E.ingest.seasonBreak(st);
        teamDb.clear();
        teamLastGame.clear();
        defAllowed.clear();
      }
      seasonNow = g.season;
    }
    /* FIX 5: everything that had finished by this kickoff, and nothing else */
    const inFlight = history.unfinishedAt(g.kickMs);
    if (inFlight) {
      counts.games_withheld_because_unfinished += inFlight;
      counts.predictions_with_an_unfinished_game_in_flight++;
    }
    history.releaseBefore(g.kickMs);
    const hk = keyOf.get(String(g.home_team_id)), ak = keyOf.get(String(g.away_team_id));
    const hFbs = g.home_division === 'fbs', aFbs = g.away_division === 'fbs';

    if (!(hFbs && aFbs)) { counts.skipped_non_fbs++; return; }
    if (!opts.evalSeasons.has(g.season) && !opts.warmupSeasons.has(g.season)) return;
    if (opts.warmupSeasons.has(g.season)) return;     /* warm-up contributes history only */

    const lr = leagueRate();
    if (lr == null) { counts.skipped_no_history++; return; }

    const hCand = arm === 'pregame' ? candidatePregame(hk) : candidateParticipant(g.game_id, g.home_team_id);
    const aCand = arm === 'pregame' ? candidatePregame(ak) : candidateParticipant(g.game_id, g.away_team_id);
    if (!hCand || !aCand) { counts.skipped_no_candidate++; return; }

    const hLine = career.get(hCand), aLine = career.get(aCand);
    const hL = shrunk(hLine, lr), aL = shrunk(aLine, lr);
    const hR = recentShrunk(hLine, lr), aR = recentShrunk(aLine, lr);
    const hInc = incumbentOf(hk), aInc = incumbentOf(ak);
    const hIncL = hInc ? shrunk(career.get(hInc), lr) : null;
    const aIncL = aInc ? shrunk(career.get(aInc), lr) : null;
    const baseline = E.strength.predictMargin(st, hk, ak, hFbs, aFbs, g.neutral_site ? 0 : st.hp.hfa);
    if (!isFinite(baseline)) { counts.skipped_no_baseline++; return; }

    const meanOf = arr => (arr && arr.length) ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
    const hDef = meanOf(defAllowed.get(hk)), aDef = meanOf(defAllowed.get(ak));
    const ldr = leagueDefRate();

    const row = {
      season: g.season, week: g.week, game_id: String(g.game_id),
      kickoff: g.kickoff,
      home_key: hk, away_key: ak,
      residual: (g.home_points - g.away_points) - baseline,
      baseline,
      h_level: hL ? hL.v : null, a_level: aL ? aL.v : null,
      h_recent: hR ? hR.v : null, a_recent: aR ? aR.v : null,
      h_change: (hInc && hInc !== hCand && hL && hIncL) ? (hL.v - hIncL.v) : ((hInc && hL) ? 0 : null),
      a_change: (aInc && aInc !== aCand && aL && aIncL) ? (aL.v - aIncL.v) : ((aInc && aL) ? 0 : null),
      /* the pass defence he faces, centred so the interaction is around zero */
      h_oppdef: (isNum(aDef) && isNum(ldr)) ? aDef - ldr : null,
      a_oppdef: (isNum(hDef) && isNum(ldr)) ? hDef - ldr : null,
      /* subgroup labels, none of which can reach a coefficient */
      changed: (hInc && hInc !== hCand ? 1 : 0) + (aInc && aInc !== aCand ? 1 : 0),
      low_history: ((hL && hL.n < LOW_HISTORY_DROPBACKS) ? 1 : 0) + ((aL && aL.n < LOW_HISTORY_DROPBACKS) ? 1 : 0),
      transfer: ((hLine && hLine.lastTeam && hLine.lastTeam !== hk) ? 1 : 0)
        + ((aLine && aLine.lastTeam && aLine.lastTeam !== ak) ? 1 : 0),
      early_season: g.week != null && g.week <= 3 ? 1 : 0,
      p4: (opts.p4.has(g.home_conference) || opts.p4.has(g.away_conference)) ? 1 : 0,
      h_dropbacks: hL ? hL.n : 0, a_dropbacks: aL ? aL.n : 0
    };
    rows.push(row);
    counts.used++;
  });
  history.releaseAll();
  return { rows, counts, state: st };
}

/* ============================================================================
   FIX 4 — NESTED CHRONOLOGICAL SELECTION.
   ========================================================================== */
function nestedWalkForward(rows, folds, draws) {
  const out = { folds: [], selected: {}, pooled: null };
  const pooledPaired = [];
  let pooledBase = 0, pooledAdj = 0, pooledN = 0;
  let pooledBaseBrier = 0, pooledAdjBrier = 0, pooledBrierN = 0;

  folds.forEach(Y => {
    const train = rows.filter(r => r.season < Y);
    const test = rows.filter(r => r.season === Y);
    if (!train.length || !test.length) return;

    /* INNER: choose the candidate using seasons strictly before Y only. Each
       inner fold trains on everything before it and is scored on itself, so
       the choice never sees Y. */
    const innerSeasons = Array.from(new Set(train.map(r => r.season))).sort();
    const innerTest = innerSeasons.slice(1);        /* the first has no training history */
    const inner = {};
    FEATURE_KEYS.forEach(k => { inner[k] = { improved: 0, folds: 0, base: 0, adj: 0, n: 0 }; });
    innerTest.forEach(y => {
      const itr = train.filter(r => r.season < y), ite = train.filter(r => r.season === y);
      if (!itr.length || !ite.length) return;
      FEATURE_KEYS.forEach(k => {
        const m = fit(itr, k);
        if (!m) return;
        const s = score(m, ite);
        if (!s) return;
        inner[k].folds++;
        if (s.mae_delta < 0) inner[k].improved++;
        inner[k].base += s.base_mae * s.n; inner[k].adj += s.adj_mae * s.n; inner[k].n += s.n;
      });
    });
    const ranked = FEATURE_KEYS.filter(k => inner[k].n > 0)
      .map(k => ({ key: k, delta: (inner[k].adj - inner[k].base) / inner[k].n,
        improved: inner[k].improved, folds: inner[k].folds, n: inner[k].n }))
      .sort((a, b) => a.delta - b.delta);
    const chosen = ranked.length ? ranked[0] : null;

    const fold = { season: Y, train_games: train.length, test_games: test.length,
      inner_seasons: innerTest, inner_ranking: ranked.map(x => ({ feature: x.key, inner_mae_delta: r4(x.delta),
        inner_folds_improved: x.improved + '/' + x.folds, inner_games: x.n })),
      selected: chosen ? chosen.key : null };

    if (chosen) {
      out.selected[chosen.key] = (out.selected[chosen.key] || 0) + 1;
      /* OUTER: refit the SELECTED feature on everything before Y, then score Y */
      const m = fit(train, chosen.key);
      const s = m ? score(m, test) : null;
      if (s) {
        fold.coefficients = m.w.map(r4);
        fold.scored_games = s.n;
        fold.base_mae = r4(s.base_mae); fold.adj_mae = r4(s.adj_mae);
        fold.base_rmse = r4(s.base_rmse); fold.adj_rmse = r4(s.adj_rmse);
        fold.mae_delta = r4(s.mae_delta);
        fold.improvement = r4(-s.mae_delta);
        fold.base_brier = r4(s.base_brier); fold.adj_brier = r4(s.adj_brier);
        pooledBase += s.base_mae * s.n; pooledAdj += s.adj_mae * s.n; pooledN += s.n;
        if (s.brier_n) { pooledBaseBrier += s.base_brier * s.brier_n; pooledAdjBrier += s.adj_brier * s.brier_n; pooledBrierN += s.brier_n; }
        s.paired.forEach(v => pooledPaired.push(v));
      } else {
        fold.why = 'the selected feature could not be fitted or scored on this fold';
      }
    } else {
      fold.why = 'no candidate could be selected from the inner folds';
    }
    out.folds.push(fold);
  });

  if (pooledN) {
    out.pooled = {
      games: pooledN,
      base_mae: r4(pooledBase / pooledN), adj_mae: r4(pooledAdj / pooledN),
      mae_delta: r4((pooledAdj - pooledBase) / pooledN),
      base_brier: pooledBrierN ? r4(pooledBaseBrier / pooledBrierN) : null,
      adj_brier: pooledBrierN ? r4(pooledAdjBrier / pooledBrierN) : null,
      brier_delta: pooledBrierN ? r4((pooledAdjBrier - pooledBaseBrier) / pooledBrierN) : null,
      brier_basis: 'a normal around the projected margin at the engine\u2019s trained CFB sigma ('
        + SIGMA_MARGIN + '), applied identically to both arms so the difference is the mean shift alone',
      folds_improved: out.folds.filter(f => isNum(f.mae_delta) && f.mae_delta < 0).length,
      folds_scored: out.folds.filter(f => isNum(f.mae_delta)).length,
      paired: bootstrapCi(pooledPaired, draws, 20260915)
    };
  }
  return out;
}

/* Subgroups, each scored with the SAME per-fold models the headline used, so a
   subgroup cannot get a coefficient of its own. */
/* A subgroup that comes back EMPTY is not always a small sample. Sometimes the
   arm's own candidate rule cannot produce that kind of row at all, and saying
   "too few games" would hide the more useful fact. */
const BLIND_SPOTS = {
  transfer_involved: 'STRUCTURAL, not small. A transfer cannot BE the pregame candidate until he has already '
    + 'played a game for his new team \u2014 the rule names the leading passer of the last completed game, and '
    + 'before that game he has none. So the pregame arm sees no transfers by construction, and the participant '
    + 'arm is the only place their effect is visible. Closing this needs a timestamped pregame starter source, '
    + 'not more history.'
};

function subgroups(rows, folds, draws, selectedByFold) {
  selectedByFold = selectedByFold || {};
  const defs = {
    starter_unchanged: r => r.changed === 0,
    starter_changed: r => r.changed > 0,
    low_history_qb: r => r.low_history > 0,
    transfer_involved: r => r.transfer > 0,
    early_season: r => r.early_season === 1,
    p4_involved: r => r.p4 === 1,
    other_fbs: r => r.p4 === 0
  };
  const out = {};
  Object.keys(defs).forEach(name => {
    const paired = [];
    let base = 0, adj = 0, n = 0;
    folds.forEach(Y => {
      const train = rows.filter(r => r.season < Y);
      const test = rows.filter(r => r.season === Y && defs[name](r));
      if (train.length < 300 || !test.length) return;
      /* THE FEATURE IS THE ONE THE OUTER FOLD ALREADY SELECTED. Re-selecting
         inside a subgroup would be the same defect this file exists to close,
         one level down: seven subgroups times five candidates is thirty-five
         chances for noise to look like a finding. A fold whose selection
         failed contributes nothing here rather than falling back to a
         different feature. */
      const key = selectedByFold[Y];
      if (!key) return;
      const m = fit(train, key);
      if (!m) return;
      const s = score(m, test);
      if (!s) return;
      base += s.base_mae * s.n; adj += s.adj_mae * s.n; n += s.n;
      s.paired.forEach(v => paired.push(v));
    });
    out[name] = n ? { games: n, base_mae: r4(base / n), adj_mae: r4(adj / n),
      mae_delta: r4((adj - base) / n),
      improvement: r4((base - adj) / n),
      paired: bootstrapCi(paired, Math.min(draws, 800), 7771 + name.length) }
      : { games: 0, why: BLIND_SPOTS[name] || 'too few games in this subgroup to measure' };
  });
  return out;
}

/* ============================================================================
   MAIN
   ========================================================================== */
function main() {
  const corpusDir = String(arg('corpus', DEFAULT_CORPUS));
  const games = readCorpus(corpusDir, 'games');
  const passers = readCorpus(corpusDir, 'passer_games');
  const teamGames = readCorpus(corpusDir, 'team_games');
  if (!games || !passers || !teamGames) {
    console.error('[qb-epa] no corpus at ' + corpusDir + ' — run football/fbs_epa/build_epa.js --refresh first');
    process.exit(2);
  }
  const warmup = String(arg('warmup', '2014,2015,2016,2017')).split(',').map(Number).filter(Boolean);
  const evalSeasons = String(arg('folds', '2018,2019,2020,2021,2022,2023,2024,2025,2026'))
    .split(',').map(Number).filter(Boolean).sort((a, b) => a - b);
  const draws = +(arg('boot', 2000));
  const outPath = String(arg('out', path.join(HERE, 'qb_epa.json')));

  const p4 = new Set(['SEC', 'Big Ten', 'Big 12', 'ACC', 'Pac-12', 'FBS Independents']);
  const opts = { warmupSeasons: new Set(warmup), evalSeasons: new Set(evalSeasons), p4 };

  const arms = {};
  ['pregame', 'participant'].forEach(arm => {
    const built = buildRows({ games, passers, teamGames }, Object.assign({}, opts, { arm }));
    log(`[qb-epa] ${arm}: ${built.rows.length} usable games `
      + `(${built.counts.skipped_no_candidate} skipped for no candidate, `
      + `${built.counts.skipped_non_fbs} non-FBS-vs-FBS)`);
    /* the folds that can actually be scored: they need training history */
    const present = Array.from(new Set(built.rows.map(r => r.season))).sort();
    const folds = present.slice(1);
    const wf = nestedWalkForward(built.rows, folds, draws);
    const selByFold = {};
    wf.folds.forEach(f => { if (f.selected && isNum(f.mae_delta)) selByFold[f.season] = f.selected; });
    const sg = subgroups(built.rows, folds, draws, selByFold);
    arms[arm] = {
      rows: built.rows.length, counts: built.counts,
      seasons: present, folds: wf.folds, selected_by_fold: selByFold,
      selection_counts: wf.selected, pooled: wf.pooled, subgroups: sg
    };
  });

  /* ------------------------------------------------------- the promotion rule */
  const RULE = {
    id: 'qb_epa_v1',
    declared_at: '2026-09-15',
    declared_before_the_result: true,
    conditions: [
      'the PREGAME arm, not the participant arm — a price cannot know who actually threw',
      'pooled held-out MAE improves by at least 0.02 points of spread',
      'the paired bootstrap 95% interval excludes zero',
      'at least five outer folds are scored and a majority of them improve',
      'the feature selected by the inner folds is the SAME feature in a majority of outer folds — '
        + 'a coefficient whose own identity changes fold to fold is not one feature',
      'the live feature definition matches the training definition exactly (same candidate rule, same '
        + 'shrinkage, same lagged centre)'
    ],
    basis: 'football/validation/feature-status.json carries the repository-wide rule; these are its '
      + 'conditions restated for this experiment and fixed before the numbers were read.'
  };

  function verdict(arm) {
    const A = arms[arm];
    const p = A.pooled;
    const checks = [];
    const add = (name, ok, detail) => checks.push({ check: name, ok: !!ok, detail: detail || null });
    add('pooled MAE improves by at least 0.02 points',
      !!(p && p.mae_delta != null && p.mae_delta <= -0.02),
      p ? ('mae_delta ' + p.mae_delta) : 'not scored');
    add('the paired 95% interval excludes zero',
      !!(p && p.paired && p.paired.ci95 && ((p.paired.ci95[0] > 0 && p.paired.ci95[1] > 0)
        || (p.paired.ci95[0] < 0 && p.paired.ci95[1] < 0))),
      p && p.paired ? ('95% CI ' + JSON.stringify(p.paired.ci95)) : 'not measured');
    add('at least five outer folds are scored', !!(p && p.folds_scored >= 5),
      p ? (p.folds_scored + ' folds') : 'none');
    add('a majority of scored folds improve',
      !!(p && p.folds_scored && p.folds_improved / p.folds_scored > 0.5),
      p ? (p.folds_improved + ' of ' + p.folds_scored) : 'none');
    const counts = A.selection_counts || {};
    const top = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || null;
    const totalSel = Object.keys(counts).reduce((a, k) => a + counts[k], 0);
    add('the inner folds keep choosing the same feature',
      !!(top && totalSel && counts[top] / totalSel > 0.5),
      top ? (top + ' chosen ' + counts[top] + ' of ' + totalSel + ' times') : 'nothing chosen');
    return { passed: checks.every(c => c.ok), checks, dominant_feature: top };
  }

  const pregameVerdict = verdict('pregame');
  const participantVerdict = verdict('participant');
  const applied = pregameVerdict.passed === true;

  const artifact = {
    schema: SCHEMA, version: 1,
    generated_at: new Date().toISOString(),
    question: 'does a measured quarterback add anything to the spread beyond the team rating that already '
      + 'contains him?',
    source: {
      corpus: path.relative(ROOT, corpusDir),
      provider: 'sportsdataverse/cfbfastR-cfb-data adv_passing via football/fbs_epa',
      ep_model_version: CONTRACT.PROVIDER_MODEL.model_version,
      ep_model_training_seasons: CONTRACT.PROVIDER_MODEL.ep_model.training_seasons,
      metric: 'passing EPA per recorded dropback (attempts + sacks); scrambles excluded, garbage time included'
    },
    method: {
      baseline: 'the engine’s own rating gap plus its home-field advantage, taken from a state replayed '
        + 'COLD from ' + warmup[0] + ' with no shipped seed ratings',
      warmup_seasons: warmup,
      evaluation_seasons: evalSeasons,
      completion_buffer_hours: COMPLETION_HOURS,
      shrinkage: 'n/(n+' + K + '), the engine’s own form and constant',
      centring: 'the league EPA per dropback as it stood BEFORE this kickoff; the previous season’s '
        + 'closing rate until the current season has 20,000 reconciled dropbacks. Pass defence is centred on '
        + 'its OWN league line (allowed EPA per PLAY, also strictly lagged) rather than on the passer line, '
        + 'because the two are different quantities and the interaction term multiplies them',
      selection: 'nested chronological: the candidate is chosen by an inner walk-forward over seasons '
        + 'strictly before the outer test season, then refit on everything before it',
      arms: {
        pregame: 'the candidate is the leading passer of the last game that had FINISHED. This is what a '
          + 'deployable Saturday-morning forecast can know.',
        participant: 'the candidate is the leading passer OF THE GAME BEING PREDICTED. Retrospective by '
          + 'construction, and an upper bound on what quarterback information could be worth rather than a '
          + 'forecast.'
      },
      leak_fixes: {
        seeded_ratings: 'closed — coldState() empties every seeded rating, game count, scoring EWMA, '
          + 'efficiency EWMA and conference strength, and assertColdStart() fails the run if one survives',
        season_wide_centre: 'closed — the centre is strictly lagged',
        actual_participant: 'closed — split into two arms that are never pooled',
        selection_on_evaluation_folds: 'closed — nested selection; the outer folds never inform the choice',
        same_kickoff_absorption: 'closed — a game becomes history ' + COMPLETION_HOURS
          + ' hours after its own kickoff, so two games at one kickoff cannot see each other'
      },
      residual_dependencies: [
        'the rating hyperparameters (k, cap, hfa, carry, the two rating floors) are the shipped ones, fitted '
          + 'over the whole window. They are six smoothing constants rather than per-team information, and '
          + 're-estimating them inside every fold is a different project. Declared, not hidden.',
        'the provider’s expected-points model is ONE artifact (v' + CONTRACT.PROVIDER_MODEL.model_version
          + ', trained on ' + CONTRACT.PROVIDER_MODEL.ep_model.training_seasons.join('–')
          + ') scored onto every season, so a 2018 fold uses a metric defined with knowledge of 2019–2025 '
          + 'football. This is a look-ahead in the metric’s definition, not in any outcome.',
        'the 48-hour publication lag the source archive assumes is an assembly rule, not a recovered '
          + 'publication timestamp. This experiment does not rely on it: it uses kickoff plus a completion '
          + 'buffer, which is a property of the game rather than of the publisher.'
      ],
      exploratory: {
        seasons: evalSeasons.filter(y => y <= 2025),
        why: 'these seasons have already informed feature choices in this repository (fit_qb_quality.js walked '
          + '2019–2026). Results on them are EXPLORATORY and are not a fresh untouched holdout. A genuinely '
          + 'fresh test means freezing this candidate and collecting prospective snapshots.'
      }
    },
    features: Object.keys(FEATURES).reduce((o, k) => { o[k] = FEATURES[k].label; return o; }, {}),
    sign_convention: 'mae_delta is (adjusted - baseline), so NEGATIVE is better. `improvement` and the paired '
      + 'bootstrap are (baseline - adjusted), so POSITIVE is better. Both are published because reporting one '
      + 'and calling it the other is the easiest way to make a null result look like a finding.',
    structural_blind_spots: BLIND_SPOTS,
    arms,
    promotion_rule: RULE,
    verdict: { pregame: pregameVerdict, participant: participantVerdict },
    points_applied: applied,
    decision: applied
      ? 'the pregame arm passed every predeclared condition'
      : 'the pregame arm did NOT pass the predeclared rule: '
        + pregameVerdict.checks.filter(c => !c.ok).map(c => c.check + ' (' + c.detail + ')').join('; ')
        + '. points_applied stays false and the QB layer contributes zero, exactly as it did before this '
        + 'experiment ran.',
    pricing_note: 'Even a pass here would not by itself switch the engine on: football/fbs_epa/epa_contract.js '
      + 'separately establishes that the provider series is not on the scale params.qb.points_per_epa_db was '
      + 'fitted against, which is why this file fits its OWN coefficient rather than reusing that one. Source '
      + 'coverage, information coverage and priced coverage are three different numbers and none of them was '
      + 'moved to make another look better.'
  };

  fs.writeFileSync(outPath, JSON.stringify(artifact, null, 1) + '\n');

  /* ----------------------------------------------------------------- report */
  ['pregame', 'participant'].forEach(arm => {
    const A = arms[arm], p = A.pooled;
    log('');
    log(`[qb-epa] ${arm.toUpperCase()} arm — ${A.rows} games, seasons ${A.seasons[0]}–${A.seasons[A.seasons.length - 1]}`);
    if (!p) { log('  not scored'); return; }
    log(`  pooled   baseline MAE ${p.base_mae}  ->  adjusted ${p.adj_mae}   (improvement ${r4(-p.mae_delta)} pts/game)`);
    log(`  folds    ${p.folds_improved} of ${p.folds_scored} improved`);
    if (p.paired) log(`  paired   ${p.paired.improvement} pts/game, 95% CI [${p.paired.ci95[0]}, ${p.paired.ci95[1]}], p=${p.paired.p_two_sided}`);
    log(`  chosen   ${JSON.stringify(A.selection_counts)}`);
    Object.keys(A.subgroups).forEach(k => {
      const s = A.subgroups[k];
      if (!s.games) { log(`    ${k.padEnd(20)} — ${String(s.why).slice(0, 100)}`); return; }
      log(`    ${k.padEnd(20)} n=${String(s.games).padStart(5)}  MAE improvement ${String(s.improvement).padStart(8)}`
        + (s.paired ? `  95% CI [${s.paired.ci95[0]}, ${s.paired.ci95[1]}]${(s.paired.ci95[0] > 0 || s.paired.ci95[1] < 0) ? '  *' : ''}` : ''));
    });
  });
  log('');
  log('[qb-epa] verdict: points_applied=' + applied);
  pregameVerdict.checks.forEach(c => log('  ' + (c.ok ? 'PASS' : 'FAIL') + '  ' + c.check + ' — ' + c.detail));
  log('[qb-epa] wrote ' + path.relative(ROOT, outPath));
}

if (require.main === module) {
  try { main(); } catch (e) { console.error(e && e.stack || e); process.exit(1); }
}

module.exports = { coldState, assertColdStart, History, shrunk, recentShrunk, ols, fit, score, subgroups,
  winProb, SIGMA_MARGIN,
  bootstrapCi, buildRows, nestedWalkForward, FEATURES, FEATURE_KEYS, COMPLETION_HOURS, K, SCHEMA };
