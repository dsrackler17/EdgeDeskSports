#!/usr/bin/env node
/* ============================================================================
   HOW WELL DOES LAST WEEK'S STARTER PREDICT THIS WEEK'S? — measured.

   WHY THIS EXISTS. The engine's information layer needs a number for "how
   well is this team's quarterback known", and the honest source of that
   number is not a constant somebody picked. College football publishes no
   depth chart this repository can read, so for most of the field the best
   available evidence is PREVIOUS_GAME: he opened the last one. The question
   that actually matters is therefore empirical —

     given a quarterback who took the first dropback of his team's last game
     and N% of that game's dropbacks, how often does he open the next one?

   — and this repository has four seasons of play attribution that answer it.
   So it is measured here, per evidence state and per usage band, with the
   sample size beside every rate, and written to a committed artifact the
   engine reads. A rate with too little support is published as null and the
   engine falls back to declaring the starter unknown rather than to a number
   nobody measured.

   WHAT IS AND IS NOT BEING MEASURED. This is CONTINUITY OF THE STARTING JOB,
   not quality and not availability. It says nothing about how good the
   quarterback is, and a quarterback who stops starting because of an injury
   and one who stops because he was benched are the same event here. That is
   the right scope: the engine uses this to say how confidently it knows WHO
   is playing, which is exactly the question it answers.

   THE WINDOW. Consecutive games for the same team within one season, in
   kickoff order. A season boundary is not a gap to be measured across — the
   roster changed — so pairs never cross one. The final game of a season has
   no successor and contributes nothing.

   V2: A SECOND MEASURED DIMENSION, because one game was never all the
   evidence. The v1 table conditioned on ONE fact — the share of the last
   game's dropbacks the opener took — and so said the same thing about a
   quarterback in his eighth consecutive start who happened to take 54% of a
   blowout as it said about one making his first start in a split room. Those
   are not the same situation and the feed already distinguishes them: the
   number of consecutive preceding games the SAME player opened is read off
   the same attribution, it is known before kickoff, and it is measured here
   rather than assumed. Cells are published only where the support clears the
   same floor a band does; a thin cell falls back to its band, and a thin band
   still publishes null. Nothing here loosens a requirement — it conditions on
   more of what was already observed.

     node football/starters/calibrate_persistence.js [--seasons 2022,2023,2024,2025]
          [--out football/starters/persistence.json] [--check] [--quiet]

   --check writes nothing and exits non-zero if the measurement could not be
   made, so CI can tell "the feed did not answer" from "the rate moved".
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const ROOT = path.join(HERE, '..', '..');
const S = require(path.join(HERE, 'starters.js'));

const CFB = 'https://raw.githubusercontent.com/sportsdataverse/cfbfastR-data/main';
const SCHEMA = 'edgedesk_starter_persistence_v1';
/* below this many observed pairs a rate is not published — a band measured on
   nine games is not a rate, and the engine must not treat it as one */
const MIN_PAIRS = 200;

function arg(name, fb) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fb;
  const v = process.argv[i + 1];
  return (v == null || String(v).startsWith('--')) ? true : v;
}
const QUIET = !!arg('quiet', false);
const log = (...a) => { if (!QUIET) console.error(...a); };
const NUM = v => { if (v == null || v === '') return null; const x = +v; return isFinite(x) ? x : null; };
const NUM_ARG = name => { const v = arg(name, null); return (v == null || v === true) ? null : NUM(v); };
const NA = v => (v == null || v === '' || v === 'NA') ? null : String(v);

/* The feed is ~60MB a season, so it is parsed as a stream of lines rather
   than split into one big array of rows: only the handful of columns this
   job needs are ever materialised. */
function eachRow(text, cols, fn) {
  let start = 0;
  const idx = {};
  const nl0 = text.indexOf('\n');
  const head = text.slice(0, nl0).replace(/\r$/, '').split(',');
  head.forEach((h, i) => { idx[h] = i; });
  for (const c of cols) if (idx[c] === undefined) throw new Error('the play feed no longer carries ' + c);
  start = nl0 + 1;
  const want = cols.map(c => idx[c]);
  const maxIdx = Math.max.apply(null, want);
  while (start < text.length) {
    let nl = text.indexOf('\n', start);
    if (nl < 0) nl = text.length;
    const line = text.slice(start, nl);
    start = nl + 1;
    if (!line) continue;
    /* the columns this job reads never contain a quoted comma (ids, numbers,
       team names from a controlled vocabulary); a row that does not split to
       the expected width is skipped and counted rather than mis-parsed */
    const f = line.split(',');
    if (f.length <= maxIdx) continue;
    const o = {};
    for (let i = 0; i < cols.length; i++) o[cols[i]] = f[want[i]];
    fn(o);
  }
}

async function season(y) {
  const url = `${CFB}/player_stats/csv/player_stats_${y}.csv`;
  const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(300000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${y}`);
  return await r.text();
}

/* team -> game -> { order -> passer }, collapsed to one attribution per play
   exactly as build_starters.js does it */
function gamesOf(text) {
  const COLS = ['game_id', 'season', 'week', 'team', 'play_id', 'period',
    'team_score', 'opponent_score',
    'completion_player_id', 'incompletion_player_id', 'sack_taken_player_id',
    'interception_thrown_player_id'];
  const byTeamGame = new Map();
  let i = 0;
  eachRow(text, COLS, r => {
    const pid = NA(r.completion_player_id) || NA(r.incompletion_player_id)
      || NA(r.sack_taken_player_id) || NA(r.interception_thrown_player_id);
    if (!pid) return;
    const team = S.normKey(r.team);
    if (!team) return;
    const key = team + '|' + r.game_id;
    let g = byTeamGame.get(key);
    if (!g) { g = { team, game_id: r.game_id, week: NUM(r.week), counts: new Map(),
      live: new Map(), first: null, firstOrder: Infinity }; byTeamGame.set(key, g); }
    const order = NUM(r.play_id) != null ? NUM(r.play_id) : i;
    i++;
    g.counts.set(pid, (g.counts.get(pid) || 0) + 1);
    /* the score columns are the RUNNING score before the play, verified on the
       feed rather than assumed; a row missing them counts as competitive */
    const ts = NUM(r.team_score), os = NUM(r.opponent_score);
    const live = (ts == null || os == null) ? true : competitive(NUM(r.period), ts - os);
    if (live) g.live.set(pid, (g.live.get(pid) || 0) + 1);
    if (order < g.firstOrder) { g.firstOrder = order; g.first = pid; }
  });
  return byTeamGame;
}

/* Usage bands on the opener's share of his own game's dropbacks. A starter
   who took nine of ten is a different statement from one who took half, and
   collapsing them would hand the engine one number for two situations. */
const BANDS = [
  { id: 'dominant', min: 0.85, label: 'opener took 85%+ of the dropbacks' },
  { id: 'clear', min: 0.65, label: 'opener took 65-85%' },
  { id: 'split', min: 0.40, label: 'opener took 40-65% — a shared room' },
  { id: 'fragment', min: 0, label: 'opener took under 40% — he opened and handed it over' }
];
const bandOf = share => BANDS.filter(b => share >= b.min)[0] || BANDS[BANDS.length - 1];

/* THE SECOND DIMENSION. How many games in a row, immediately before this one,
   the SAME player opened. It is read off the same attribution, it is a fact
   about games already played, and it separates a quarterback eight starts
   into a job from one making his first. Ordered high to low; `min` is
   inclusive, exactly as the share bands are. */
const RUNS = [
  { id: 'entrenched', min: 4, label: 'and had opened the four before it' },
  { id: 'established', min: 2, label: 'and had opened the two or three before it' },
  { id: 'second', min: 1, label: 'and had opened the one before it' },
  { id: 'first', min: 0, label: 'and had not opened the game before it' }
];
const runOf = n => RUNS.filter(r => n >= r.min)[0] || RUNS[RUNS.length - 1];
const cellId = (bandId, runId) => bandId + '|' + runId;

/* THE THIRD READING OF THE SAME EVIDENCE, and the one that fixes the case
   this v2 exists for. A single game's share is noisy: a starter pulled early
   in a forty-point win against an FCS opponent lands in the same band as one
   losing a job. His share of the team's dropbacks ACROSS EVERY GAME PLAYED SO
   FAR is the same feed, is known before kickoff, and does not move on one
   blowout. Measured, not assumed — and if it turned out not to discriminate,
   the table below would say so and the engine would keep using the band. */
const SEASON_BANDS = [
  { id: 'season_dominant', min: 0.85, label: 'has taken 85%+ of the season’s dropbacks' },
  { id: 'season_clear', min: 0.65, label: 'has taken 65-85% of the season’s dropbacks' },
  { id: 'season_split', min: 0.40, label: 'has taken 40-65% of the season’s dropbacks' },
  { id: 'season_fragment', min: 0, label: 'has taken under 40% of the season’s dropbacks' }
];
const seasonBandOf = share => SEASON_BANDS.filter(b => share >= b.min)[0] || SEASON_BANDS[SEASON_BANDS.length - 1];

/* THE FOURTH READING, and the one the reproduction case turns on. A starter
   pulled with a thirty-point lead in the fourth quarter took half his game's
   dropbacks and lost none of his job; the raw share cannot tell him from a
   quarterback who was benched. The play feed carries the RUNNING score and
   the period, so the two can be separated: this is the opener's share of the
   dropbacks thrown while the game was still competitive.

   The margins are DECLARED, not fitted — the widely used garbage-time
   thresholds — and whether the distinction is worth anything is then MEASURED
   against a holdout like every other candidate here. If it does not beat the
   raw share out of sample it does not get used, however sensible it sounds. */
const GARBAGE = { 2: 38, 3: 28, 4: 22 };
function competitive(period, margin) {
  const p = Math.min(4, Math.max(1, period || 1));
  const lim = GARBAGE[p];
  return lim == null ? true : Math.abs(margin || 0) <= lim;
}

async function main() {
  const seasons = String(arg('seasons', '2022,2023,2024,2025')).split(',').map(s => parseInt(s, 10)).filter(Boolean);
  const check = !!arg('check', false);
  const dest0 = path.join(ROOT, String(arg('out', 'football/starters/persistence.json')));

  /* THESE RATES MOVE SLOWLY, AND THE FEED IS 60MB A SEASON. The job that
     refreshes the starter context fires several times a week; re-measuring
     four whole seasons on each of those firings would download a quarter of a
     gigabyte to move a number in the third decimal place. --max-age-days lets
     the caller say how stale is too stale, and a fresh artifact short-circuits
     with exit 0 so a scheduled run neither wastes the bandwidth nor reports a
     failure. Missing or unreadable always rebuilds. */
  const maxAge = NUM_ARG('max-age-days');
  if (maxAge != null && !check) {
    try {
      const prev = JSON.parse(fs.readFileSync(dest0, 'utf8'));
      const ageDays = (Date.now() - Date.parse(prev.generated_at)) / 864e5;
      if (isFinite(ageDays) && ageDays < maxAge) {
        log(`[persistence] ${path.relative(ROOT, dest0)} is ${ageDays.toFixed(1)} days old `
          + `(limit ${maxAge}) — left as it is`);
        return;
      }
    } catch (_) { /* absent or unreadable: measure it */ }
  }
  const tally = {};
  BANDS.forEach(b => { tally[b.id] = { pairs: 0, same: 0 }; });
  const cells = {};
  BANDS.forEach(b => RUNS.forEach(r => { cells[cellId(b.id, r.id)] = { pairs: 0, same: 0 }; }));
  const seasonCells = {};
  SEASON_BANDS.forEach(b => RUNS.forEach(r => { seasonCells[cellId(b.id, r.id)] = { pairs: 0, same: 0 }; }));
  const liveTally = {};
  BANDS.forEach(b => { liveTally[b.id] = { pairs: 0, same: 0 }; });
  const liveCells = {};
  BANDS.forEach(b => RUNS.forEach(r => { liveCells[cellId(b.id, r.id)] = { pairs: 0, same: 0 }; }));
  const overall = { pairs: 0, same: 0 };
  const perSeason = {};
  const read = [];
  const failed = [];
  /* every measured pair, kept so the three candidate conditionings can be
     compared out of sample rather than chosen by which one reads highest */
  const pairs = [];

  for (const y of seasons) {
    let text = null;
    try { text = await season(y); } catch (e) { failed.push({ season: y, why: String((e && e.message) || e) }); continue; }
    if (!text) { failed.push({ season: y, why: 'not published' }); continue; }
    read.push(y);
    const byTeamGame = gamesOf(text);
    /* per team, the season's games in week order */
    const byTeam = new Map();
    for (const g of byTeamGame.values()) {
      if (g.week == null) continue;
      let list = byTeam.get(g.team);
      if (!list) { list = []; byTeam.set(g.team, list); }
      let total = 0;
      for (const v of g.counts.values()) total += v;
      let liveTotal = 0;
      for (const v of g.live.values()) liveTotal += v;
      list.push({ week: g.week, first: g.first, share: total ? (g.counts.get(g.first) || 0) / total : null,
        /* a game played entirely in garbage time has no competitive share to
           measure, and falls back to the raw one rather than to a guess */
        live_share: liveTotal ? (g.live.get(g.first) || 0) / liveTotal
          : (total ? (g.counts.get(g.first) || 0) / total : null),
        live_dropbacks: liveTotal, dropbacks: total, counts: g.counts });
    }
    perSeason[y] = { pairs: 0, same: 0, teams: byTeam.size };
    for (const list of byTeam.values()) {
      list.sort((a, b) => a.week - b.week);
      for (let j = 0; j + 1 < list.length; j++) {
        const a = list[j], b = list[j + 1];
        if (!a.first || !b.first || a.share == null) continue;
        /* the pair, kept in its predictor form so the walk-forward below can
           re-tally it against a table fitted without its own season */
        /* a team's bye week is not a break in the sequence: the next game it
           plays is the next game, whatever the calendar did in between */
        const same = a.first === b.first ? 1 : 0;
        const band = bandOf(a.share);
        /* THE RUN, counted backwards from the game just played and ONLY over
           games this window actually observed. A season's opener has run 0
           because nothing precedes it here — not because the player is new,
           which is a different statement and is not claimed. */
        let run = 0;
        for (let k = j - 1; k >= 0 && list[k].first === a.first; k--) run++;
        const rb = runOf(run);
        /* his share of every dropback the team has thrown so far, games 1..j
           inclusive — exactly what a projection standing before game j+1 can
           see, and never a play from the game being predicted */
        let mine = 0, all = 0;
        for (let k = 0; k <= j; k++) { mine += (list[k].counts.get(a.first) || 0); all += list[k].dropbacks; }
        const seasonShare = all ? mine / all : null;
        tally[band.id].pairs++; tally[band.id].same += same;
        const cell = cells[cellId(band.id, rb.id)];
        cell.pairs++; cell.same += same;
        if (seasonShare != null) {
          const sc = seasonCells[cellId(seasonBandOf(seasonShare).id, rb.id)];
          sc.pairs++; sc.same += same;
        }
        pairs.push({ season: y, band: band.id, run: rb.id,
          live_band: a.live_share == null ? null : bandOf(a.live_share).id,
          season_band: seasonShare == null ? null : seasonBandOf(seasonShare).id, same: same });
        const lb = a.live_share == null ? null : bandOf(a.live_share);
        if (lb) {
          liveTally[lb.id].pairs++; liveTally[lb.id].same += same;
          const lc = liveCells[cellId(lb.id, rb.id)];
          lc.pairs++; lc.same += same;
        }
        overall.pairs++; overall.same += same;
        perSeason[y].pairs++; perSeason[y].same += same;
      }
    }
    log(`[persistence] ${y}: ${perSeason[y].pairs} consecutive-game pairs over ${perSeason[y].teams} teams`);
  }

  if (!overall.pairs) {
    console.error('[persistence] no pairs could be measured — the play feed did not answer for any requested season');
    process.exit(2);
  }

  const rate = t => (t.pairs >= MIN_PAIRS ? Math.round((t.same / t.pairs) * 1000) / 1000 : null);

  /* ------------------------------------------------------------------------
     WHICH CONDITIONING THE ENGINE SHOULD READ, decided out of sample.

     Three tables describe the same 10,843 pairs. Picking between them by
     which one reads highest would be marking our own homework, so each is
     fitted on every season but one and scored on the one left out, over every
     holdout in turn. Brier is the mean squared error of the published rate
     against what actually happened; lower is better. `covered` is the share
     of holdout pairs the table could answer at all — a table that answers a
     third of the field with a beautiful score is not the better table, and
     the fallback chain is scored WITH its fallbacks so the comparison is
     between what the engine would really do in each case.
     ------------------------------------------------------------------------ */
  function fit(rows) {
    const b = {}, c = {}, sc = {}, lb = {}, lc = {};
    BANDS.forEach(x => { b[x.id] = { pairs: 0, same: 0 }; lb[x.id] = { pairs: 0, same: 0 }; });
    BANDS.forEach(x => RUNS.forEach(r => { c[cellId(x.id, r.id)] = { pairs: 0, same: 0 };
      lc[cellId(x.id, r.id)] = { pairs: 0, same: 0 }; }));
    SEASON_BANDS.forEach(x => RUNS.forEach(r => { sc[cellId(x.id, r.id)] = { pairs: 0, same: 0 }; }));
    rows.forEach(r => {
      b[r.band].pairs++; b[r.band].same += r.same;
      const k = c[cellId(r.band, r.run)]; k.pairs++; k.same += r.same;
      if (r.season_band) { const k2 = sc[cellId(r.season_band, r.run)]; k2.pairs++; k2.same += r.same; }
      if (r.live_band) {
        lb[r.live_band].pairs++; lb[r.live_band].same += r.same;
        const k3 = lc[cellId(r.live_band, r.run)]; k3.pairs++; k3.same += r.same;
      }
    });
    return { b, c, sc, lb, lc };
  }
  /* the three candidates, each written as the lookup the engine would use */
  const CANDIDATES = {
    band: (t, r) => rate(t.b[r.band]),
    band_x_run: (t, r) => rate(t.c[cellId(r.band, r.run)]) != null
      ? rate(t.c[cellId(r.band, r.run)]) : rate(t.b[r.band]),
    season_share_x_run: (t, r) => {
      if (r.season_band) {
        const v = rate(t.sc[cellId(r.season_band, r.run)]);
        if (v != null) return v;
      }
      const v2 = rate(t.c[cellId(r.band, r.run)]);
      return v2 != null ? v2 : rate(t.b[r.band]);
    },
    competitive_share_x_run: (t, r) => {
      if (r.live_band) {
        const v = rate(t.lc[cellId(r.live_band, r.run)]);
        if (v != null) return v;
        const v1 = rate(t.lb[r.live_band]);
        if (v1 != null) return v1;
      }
      const v2 = rate(t.c[cellId(r.band, r.run)]);
      return v2 != null ? v2 : rate(t.b[r.band]);
    }
  };
  const evaluation = { method: 'leave-one-season-out; each table is fitted on the other seasons and scored '
      + 'on the held-out one, with its own fallback chain in place', holdouts: read.slice(), by_candidate: {} };
  Object.keys(CANDIDATES).forEach(name => {
    let n = 0, covered = 0, brier = 0, logloss = 0;
    read.forEach(y => {
      const t = fit(pairs.filter(r => r.season !== y));
      pairs.filter(r => r.season === y).forEach(r => {
        n++;
        const p = CANDIDATES[name](t, r);
        if (p == null) return;
        covered++;
        brier += (p - r.same) * (p - r.same);
        const q = Math.min(1 - 1e-6, Math.max(1e-6, p));
        logloss += -(r.same ? Math.log(q) : Math.log(1 - q));
      });
    });
    evaluation.by_candidate[name] = {
      scored: n, covered,
      coverage: n ? Math.round((covered / n) * 1000) / 1000 : null,
      brier: covered ? Math.round((brier / covered) * 100000) / 100000 : null,
      log_loss: covered ? Math.round((logloss / covered) * 100000) / 100000 : null
    };
  });
  {
    const names = Object.keys(evaluation.by_candidate)
      .filter(k => evaluation.by_candidate[k].brier != null && evaluation.by_candidate[k].coverage === 1);
    names.sort((a, b2) => evaluation.by_candidate[a].brier - evaluation.by_candidate[b2].brier);
    evaluation.best = names[0] || 'band';
    evaluation.basis = 'the engine reads `' + evaluation.best + '`: lowest held-out Brier among the tables '
      + 'that answer every pair. A table that cannot answer every pair is not chosen however well it scores '
      + 'on the ones it can.';
  }
  const out = {
    schema: SCHEMA, version: 1, generated_at: new Date().toISOString(),
    source: 'cfbfastR-data player_stats — play attribution',
    source_url: `${CFB}/player_stats/csv/player_stats_<season>.csv`,
    seasons_read: read, seasons_failed: failed,
    min_pairs_to_publish: MIN_PAIRS,
    question: 'given the quarterback who took the first dropback of a team’s game, how often does he '
      + 'take the first dropback of that team’s next game in the same season?',
    scope: 'continuity of the starting job only. It is not quality and not availability: a quarterback who '
      + 'stops starting because he was hurt and one who stops because he was benched are the same event here.',
    overall: { pairs: overall.pairs, same: overall.same, rate: rate(overall) },
    by_band: BANDS.map(b => ({
      id: b.id, min_share: b.min, label: b.label,
      pairs: tally[b.id].pairs, same: tally[b.id].same, rate: rate(tally[b.id]),
      published: rate(tally[b.id]) != null
    })),
    /* THE TWO-DIMENSIONAL TABLE. Same pairs, same window, conditioned on one
       more fact the feed already carried. A cell that does not clear the floor
       publishes rate: null and the engine falls back to that cell's BAND —
       never to a neighbouring cell and never to a number nobody measured. */
    run_bands: RUNS.map(r => ({ id: r.id, min_run: r.min, label: r.label })),
    by_band_and_run: BANDS.map(b => RUNS.map(r => {
      const t = cells[cellId(b.id, r.id)];
      return { band: b.id, run: r.id, min_share: b.min, min_run: r.min,
        label: b.label + ', ' + r.label,
        pairs: t.pairs, same: t.same, rate: rate(t), published: rate(t) != null };
    })).reduce((a, x) => a.concat(x), []),
    /* THE TABLE THE ENGINE PREFERS, when a cell in it is published: the
       opener's share of the season's dropbacks so far, crossed with his run
       of consecutive openings. Both are facts about games already played. */
    season_bands: SEASON_BANDS.map(b => ({ id: b.id, min_share: b.min, label: b.label })),
    by_season_share_and_run: SEASON_BANDS.map(b => RUNS.map(r => {
      const t = seasonCells[cellId(b.id, r.id)];
      return { season_band: b.id, run: r.id, min_season_share: b.min, min_run: r.min,
        label: b.label + ', ' + r.label,
        pairs: t.pairs, same: t.same, rate: rate(t), published: rate(t) != null };
    })).reduce((a, x) => a.concat(x), []),
    /* THE SAME CROSS, ON THE COMPETITIVE SHARE. Whether the engine reads this
       one or the raw-share one is decided by `evaluation` below, not here. */
    by_competitive_band: BANDS.map(b => ({
      id: b.id, min_share: b.min, label: b.label.replace('the dropbacks', 'the COMPETITIVE dropbacks'),
      pairs: liveTally[b.id].pairs, same: liveTally[b.id].same, rate: rate(liveTally[b.id]),
      published: rate(liveTally[b.id]) != null })),
    by_competitive_band_and_run: BANDS.map(b => RUNS.map(r => {
      const t = liveCells[cellId(b.id, r.id)];
      return { band: b.id, run: r.id, min_share: b.min, min_run: r.min,
        label: b.label.replace('the dropbacks', 'the COMPETITIVE dropbacks') + ', ' + r.label,
        pairs: t.pairs, same: t.same, rate: rate(t), published: rate(t) != null };
    })).reduce((a, x) => a.concat(x), []),
    garbage_time: { thresholds_by_period: GARBAGE,
      basis: 'a dropback is COMPETITIVE unless the running margin before the play exceeded the period\u2019s '
        + 'threshold. Declared, not fitted; its value is measured in `evaluation`.' },
    by_season: perSeason,
    evaluation: evaluation,
    engine_reads: evaluation.best,
    dimensions: ['share of the last game\u2019s dropbacks the opener took',
      'consecutive preceding games the same player opened',
      'the opener\u2019s share of every dropback the team has thrown so far this season',
      'the opener\u2019s share of the last game\u2019s COMPETITIVE dropbacks'],
    note: 'A band or cell with fewer than ' + MIN_PAIRS + ' observed pairs publishes rate: null. A null cell '
      + 'falls back to its BAND, and a null band is treated by the engine as no measurement rather than as '
      + 'a number nobody measured.'
  };

  const dest = dest0;
  if (check) { log('[persistence] --check: measured, nothing written'); log(JSON.stringify(out.by_band, null, 1)); return; }
  fs.writeFileSync(dest, JSON.stringify(out, null, 1) + '\n');
  log('[persistence] wrote ' + path.relative(ROOT, dest));
  out.by_band.forEach(b => log('  ' + b.id.padEnd(10) + (b.rate == null ? 'not published' : (b.rate * 100).toFixed(1) + '%') + '  n=' + b.pairs));
  log('  overall   ' + (out.overall.rate * 100).toFixed(1) + '%  n=' + out.overall.pairs);
  log('  by band x run:');
  out.by_band_and_run.forEach(c => log('    ' + (c.band + ' / ' + c.run).padEnd(26)
    + (c.rate == null ? 'not published' : (c.rate * 100).toFixed(1) + '%').padStart(14) + '  n=' + c.pairs));
  log('  held-out comparison (lower Brier is better):');
  Object.keys(out.evaluation.by_candidate).forEach(k => { const e = out.evaluation.by_candidate[k];
    log('    ' + k.padEnd(22) + ' brier ' + String(e.brier).padEnd(9) + ' log-loss ' + String(e.log_loss).padEnd(9)
      + ' coverage ' + e.coverage); });
  log('  engine reads: ' + out.engine_reads);
  log('  by competitive band x run:');
  out.by_competitive_band_and_run.forEach(c => log('    ' + (c.band + ' / ' + c.run).padEnd(30)
    + (c.rate == null ? 'not published' : (c.rate * 100).toFixed(1) + '%').padStart(14) + '  n=' + c.pairs));
  log('  by season share x run:');
  out.by_season_share_and_run.forEach(c => log('    ' + (c.season_band + ' / ' + c.run).padEnd(32)
    + (c.rate == null ? 'not published' : (c.rate * 100).toFixed(1) + '%').padStart(14) + '  n=' + c.pairs));
}

main().catch(e => { console.error('[persistence] ' + ((e && e.stack) || e)); process.exit(2); });
