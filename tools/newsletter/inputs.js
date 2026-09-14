#!/usr/bin/env node
/* ============================================================================
   THE INPUT GATE — is the research fresh enough to send an edition built on it?

   THREE QUESTIONS, asked separately because they fail separately:

     1  HOW OLD IS THE RESEARCH? Article records carry their own
        `generated_at`. A newsletter assembled from records that were last
        refreshed two days ago is quoting a board nobody has looked at since,
        and the reader has no way to know.

     2  HOW OLD ARE THE RATINGS? football/rankings/current.json is the state
        every projection is built on and it stamps itself. This is the input
        that actually moves after a game finishes.

     3  HAS MONDAY NIGHT FOOTBALL BEEN ABSORBED? The Tuesday NFL edition is
        published *after* Monday Night Football and the brief is explicit
        about what has to happen when it has not settled: a bounded retry
        window, then either send with a stated data cutoff or hold with a
        reason an operator can see.

   WHAT COUNTS AS "SETTLED" — and this is the part worth being careful about.
   A final score is not the same thing as an updated model input. The score
   arrives within minutes; the ratings absorb it when the ratings job next
   runs. So readiness needs BOTH, and the two are reported separately so the
   hold reason says which one is missing:

     final_available   a completed result exists, from the editorial result
                       store or from the nflverse schedule's own score columns
     inputs_fresh      the ratings artifact was rebuilt after the game ended

   NO NEW FEED IS ADDED. Both sources are files this repository already
   produces or caches; when neither is reachable the answer is `unknown`,
   which is a hold reason rather than a guess.
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const RANKINGS = path.join(ROOT, 'football', 'rankings', 'current.json');
const RESULTS_DIR = path.join(ROOT, 'articles', 'data', 'editorial', 'results');
const CACHE_DIR = process.env.EDP_CACHE || path.join(ROOT, 'football', 'data', 'cache');
/* the name tools/articles/research_host.js caches the nflverse schedule under */
const NFL_SCHEDULE_CACHE = path.join(CACHE_DIR, 'articles_games.csv');

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; } }
function ms(v) { const t = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(t) ? t : null; }
function hours(a, b) { const x = ms(a), y = ms(b); return (x == null || y == null) ? null : (y - x) / 3600000; }

/* --------------------------------------------------------- record ages */
function recordFreshness(candidates, now, staleHours) {
  const nowMs = ms(now) || Date.now();
  const ages = [];
  (candidates || []).forEach(c => {
    const g = c.record && c.record.generated_at;
    const h = g ? hours(g, nowMs) : null;
    if (h != null) ages.push({ key: c.key, hours: Math.round(h * 10) / 10, generated_at: g });
  });
  ages.sort((a, b) => a.hours - b.hours);
  const floor = staleHours == null ? 30 : staleHours;
  const stale = ages.filter(a => a.hours > floor);
  return {
    counted: ages.length,
    missing: (candidates || []).length - ages.length,
    newest_hours: ages.length ? ages[0].hours : null,
    oldest_hours: ages.length ? ages[ages.length - 1].hours : null,
    newest_at: ages.length ? ages[0].generated_at : null,
    stale_threshold_hours: floor,
    stale_count: stale.length,
    stale_share: ages.length ? Math.round((stale.length / ages.length) * 100) / 100 : null,
  };
}

/* ------------------------------------------------------ ratings ages */
function ratingsFreshness(now) {
  const nowMs = ms(now) || Date.now();
  const r = readJson(RANKINGS);
  if (!r) return { available: false, why: 'football/rankings/current.json could not be read' };
  return {
    available: true,
    season: r.season == null ? null : Number(r.season),
    week: r.week == null ? null : Number(r.week),
    week_label: r.week_label || null,
    generated_at: r.generated_at || null,
    age_hours: r.generated_at ? Math.round(hours(r.generated_at, nowMs) * 10) / 10 : null,
    team_count: r.team_count == null ? null : Number(r.team_count),
  };
}

/* -------------------------------------------- did this game finish? */
/* The editorial result store first — it is the one source in this repository
   that has already applied a readiness gate of its own (two agreeing
   providers, a real box score, not just a scoreboard). */
function resultFromStore(sport, gameId) {
  const f = path.join(RESULTS_DIR, String(sport).toUpperCase() + '_' + String(gameId) + '.json');
  const r = readJson(f);
  if (!r) return null;
  if (r.completed !== true) return null;
  return {
    source: 'editorial result store',
    home_score: r.home_score, away_score: r.away_score,
    final_seen_at: r.final_seen_at || r.observed_at || null,
  };
}

/* …then the nflverse schedule's own score columns, out of the cache the
   article refresh writes. A tiny CSV read rather than a parser dependency:
   the file is quoted-field-free in the columns this needs. */
function resultFromScheduleCache(gameId, file) {
  const f = file || NFL_SCHEDULE_CACHE;
  let text;
  try { text = fs.readFileSync(f, 'utf8'); } catch (_) { return null; }
  const lines = text.split(/\r?\n/);
  if (!lines.length) return null;
  const cols = lines[0].split(',');
  const iId = cols.indexOf('game_id');
  const iH = cols.indexOf('home_score'), iA = cols.indexOf('away_score');
  if (iId < 0 || iH < 0 || iA < 0) return null;
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const parts = lines[i].split(',');
    if (parts[iId] !== String(gameId)) continue;
    /* AN EMPTY CELL IS NOT A ZERO. nflverse writes the score columns blank
       until a game finishes, and Number('') is 0 — which would read every
       unplayed game as a 0-0 final. */
    const hRaw = String(parts[iH] || '').trim(), aRaw = String(parts[iA] || '').trim();
    if (!hRaw || !aRaw) return null;
    const h = Number(hRaw), a = Number(aRaw);
    if (!Number.isFinite(h) || !Number.isFinite(a)) return null;
    return { source: 'nflverse schedule (cached)', home_score: h, away_score: a, final_seen_at: null };
  }
  return null;
}

/* -------------------------------------------------- the Monday gate */
/* mondayNightReadiness({ candidates, now, settle_minutes, deadline_at })

   `candidates` is every NFL record, started or not: the game being waited on
   has already kicked off, so it is NOT in the upcoming slate.

   Returns a decision the caller can act on without re-deriving anything:
     required        false when there was no Monday game to wait for
     ready           the result is in AND the ratings have absorbed it
     past_deadline   the bounded retry window has run out
     action          'proceed' | 'wait' | 'proceed_with_cutoff' | 'hold'          */
function mondayNightReadiness(opts) {
  opts = opts || {};
  const SCHEDULE = opts.schedule || require('./schedule.js');
  const SLATE = opts.slate || require('./slate.js');
  const nowMs = ms(opts.now) || Date.now();
  const settle = opts.settle_minutes == null ? 90 : opts.settle_minutes;

  const game = SLATE.lastMondayGame(opts.candidates || [], nowMs,
    t => SCHEDULE.zonedParts(t, 'America/New_York'));
  if (!game) {
    return { required: false, ready: true, action: 'proceed',
      reason: 'no_monday_game',
      detail: 'no NFL game kicked off on the Monday before this edition, so there is nothing to wait for' };
  }

  const result = resultFromStore('NFL', game.game_id)
    || resultFromScheduleCache(game.game_id, opts.schedule_cache);
  const ratings = ratingsFreshness(nowMs);
  /* a game is over roughly three and a half hours after kickoff; the settle
     window is measured from there rather than from the kickoff itself */
  const endedAt = game.kickoff_ms + 3.5 * 3600000;
  const inputsFresh = !!(ratings.available && ms(ratings.generated_at) != null
    && ms(ratings.generated_at) >= endedAt);
  const settledAt = endedAt + settle * 60000;
  const pastDeadline = opts.deadline_at ? nowMs > ms(opts.deadline_at) : false;

  const base = {
    required: true,
    game: { key: game.key, matchup: game.away + ' at ' + game.home, kickoff: game.kickoff },
    final_available: !!result,
    final: result || null,
    inputs_fresh: inputsFresh,
    ratings,
    settle_minutes: settle,
    settled_at: new Date(settledAt).toISOString(),
    past_deadline: pastDeadline,
  };

  if (result && inputsFresh) {
    return Object.assign(base, { ready: true, action: 'proceed',
      reason: 'monday_settled',
      detail: 'the Monday result is in (' + result.source + ') and the ratings were rebuilt after it' });
  }
  if (!pastDeadline && nowMs < settledAt) {
    return Object.assign(base, { ready: false, action: 'wait',
      reason: !result ? 'awaiting_monday_result' : 'awaiting_model_inputs',
      detail: !result
        ? 'no completed result for ' + base.game.matchup + ' yet; retrying until ' + base.settled_at
        : 'the result is in but the ratings were last built '
          + (ratings.generated_at || 'at an unknown time') + ', before the game ended' });
  }
  if (!pastDeadline) {
    return Object.assign(base, { ready: false, action: 'wait',
      reason: !result ? 'awaiting_monday_result' : 'awaiting_model_inputs',
      detail: (!result
        ? 'no completed result for ' + base.game.matchup + ' has arrived; '
        : 'the result for ' + base.game.matchup + ' is in but the ratings have not been rebuilt since; ')
        + 'past the ' + settle + '-minute settle window but still inside the edition’s retry window, '
        + 'so the next dispatcher tick will try again' });
  }
  /* PAST THE RETRY WINDOW. The brief gives two acceptable outcomes and they
     are not interchangeable: send with an explicit cutoff if the edition is
     still useful, or hold with a reason an operator can see. A result that
     never arrived means the ratings cannot have absorbed it, and an edition
     whose numbers predate the game it is published after is not useful —
     so that case holds. A result that IS in, with ratings that have not yet
     caught up, is still useful, and the cutoff says exactly what it is. */
  if (result) {
    return Object.assign(base, { ready: false, action: 'proceed_with_cutoff',
      reason: 'monday_result_in_inputs_lagging',
      detail: 'the Monday result is in but the ratings have not been rebuilt since; '
        + 'sending with an explicit data cutoff of '
        + (ratings.generated_at || 'the last ratings build') });
  }
  return Object.assign(base, { ready: false, action: 'hold',
    reason: 'monday_result_never_arrived',
    detail: 'no completed result for ' + base.game.matchup
      + ' reached this checkout before the edition’s retry window closed' });
}

module.exports = {
  RANKINGS, RESULTS_DIR, CACHE_DIR, NFL_SCHEDULE_CACHE,
  recordFreshness, ratingsFreshness, resultFromStore, resultFromScheduleCache, mondayNightReadiness,
};
