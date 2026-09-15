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
  const COLS = ['game_id', 'season', 'week', 'team', 'play_id',
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
    if (!g) { g = { team, game_id: r.game_id, week: NUM(r.week), counts: new Map(), first: null, firstOrder: Infinity }; byTeamGame.set(key, g); }
    const order = NUM(r.play_id) != null ? NUM(r.play_id) : i;
    i++;
    g.counts.set(pid, (g.counts.get(pid) || 0) + 1);
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
  const overall = { pairs: 0, same: 0 };
  const perSeason = {};
  const read = [];
  const failed = [];

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
      list.push({ week: g.week, first: g.first, share: total ? (g.counts.get(g.first) || 0) / total : null, dropbacks: total });
    }
    perSeason[y] = { pairs: 0, same: 0, teams: byTeam.size };
    for (const list of byTeam.values()) {
      list.sort((a, b) => a.week - b.week);
      for (let j = 0; j + 1 < list.length; j++) {
        const a = list[j], b = list[j + 1];
        if (!a.first || !b.first || a.share == null) continue;
        /* a team's bye week is not a break in the sequence: the next game it
           plays is the next game, whatever the calendar did in between */
        const same = a.first === b.first ? 1 : 0;
        const band = bandOf(a.share);
        tally[band.id].pairs++; tally[band.id].same += same;
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
    by_season: perSeason,
    note: 'A band with fewer than ' + MIN_PAIRS + ' observed pairs publishes rate: null, and the engine '
      + 'treats a null as no measurement rather than falling back to a number nobody measured.'
  };

  const dest = dest0;
  if (check) { log('[persistence] --check: measured, nothing written'); log(JSON.stringify(out.by_band, null, 1)); return; }
  fs.writeFileSync(dest, JSON.stringify(out, null, 1) + '\n');
  log('[persistence] wrote ' + path.relative(ROOT, dest));
  out.by_band.forEach(b => log('  ' + b.id.padEnd(10) + (b.rate == null ? 'not published' : (b.rate * 100).toFixed(1) + '%') + '  n=' + b.pairs));
  log('  overall   ' + (out.overall.rate * 100).toFixed(1) + '%  n=' + out.overall.pairs);
}

main().catch(e => { console.error('[persistence] ' + ((e && e.stack) || e)); process.exit(2); });
