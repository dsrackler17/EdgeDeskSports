#!/usr/bin/env node
/* ============================================================================
   THE UPCOMING SLATE — which games the next edition is allowed to be about.

   "The upcoming slate" sounds obvious and is not. Three things make it hard,
   and all three are handled here rather than guessed at by the caller:

     1  A WEEK IS NOT SEVEN DAYS FROM NOW. College football plays Tuesday
        through Saturday in some weeks; the NFL plays Thursday through Monday
        and, twice a season, on a Friday or a Saturday. A window of "the next
        seven days" straddles two weeks for one sport and half of one for the
        other, so the slate is identified by the FEED'S OWN season and week
        columns, and the week is chosen by a vote of the games actually in
        front of us.

     2  A GAME THAT HAS STARTED IS NOT UPCOMING. This is the rule the whole
        product rests on — a newsletter that previews a game already in the
        third quarter is not research, it is an error a reader can see. The
        comparison is on the absolute kickoff instant, never on a local date.

     3  AN EMPTY SLATE IS A REAL ANSWER. Between the national championship and
        the NFL's wild-card round, in a bye week, in July: the honest output is
        "nothing qualifies", with a reason, and the pipeline holds the edition.
        Padding it with last week's games, or with games nine days out, is the
        exact failure this file exists to make impossible.

   THE INPUT is a list of candidates — normalised from the committed article
   records, and optionally cross-checked against the live schedule rows the
   research host reads. Either way the season, the week and the kickoff come
   from the schedule feed; nothing here infers a week from a date.
   ========================================================================== */
'use strict';

/* How far ahead to look when deciding WHICH week is the upcoming one. Eight
   days rather than seven so a Monday edition still sees the following
   Monday-night game, and a Tuesday edition still sees the Monday after it. */
const DEFAULT_HORIZON_DAYS = 8;

function num(v) { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function txt(v) { if (v == null) return null; const s = String(v).replace(/\s+/g, ' ').trim(); return s || null; }
function ms(v) { if (v == null) return null; const t = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(t) ? t : null; }

function keyFor(sport, gameId) { return String(sport || '').toUpperCase() + ':' + String(gameId); }

/* ------------------------------------------------- candidates from records */
/* An article record already carries everything the slate needs and carries it
   from the same schedule feed the board reads, so this is a projection of the
   record rather than a second source. `research` rides along because the
   ranking downstream reads it, and re-loading the record to get it would mean
   two passes over a couple of hundred files. */
function fromRecord(rec) {
  if (!rec || !rec.sport || !rec.game_id) return null;
  return {
    key: keyFor(rec.sport, rec.game_id),
    sport: String(rec.sport).toUpperCase(),
    game_id: String(rec.game_id),
    season: num(rec.season),
    week: num(rec.week),
    kickoff: txt(rec.game_time),
    kickoff_ms: ms(rec.game_time),
    home: txt(rec.home_team),
    away: txt(rec.away_team),
    venue: txt(rec.venue),
    neutral_site: !!rec.neutral_site,
    conference_line: txt(rec.conference_line),
    record: rec,
  };
}

/* The same shape out of a research-host slate row, for the cross-check. A row
   the records do not carry is a GAP — a game on the board with no research
   record — and the operator console says so rather than the newsletter
   silently never considering it. */
function fromSlateRow(row) {
  if (!row || !row.sport || !row.game_id) return null;
  return {
    key: keyFor(row.sport, row.game_id),
    sport: String(row.sport).toUpperCase(),
    game_id: String(row.game_id),
    season: num(row.season),
    week: num(row.week),
    kickoff: txt(row.kickoff),
    kickoff_ms: ms(row.kickoff_ms != null ? row.kickoff_ms : row.kickoff),
    home: txt(row.home_name || row.home),
    away: txt(row.away_name || row.away),
    venue: txt(row.venue),
    neutral_site: !!row.neutral_site,
    /* the feed's own word on what part of the season this is */
    game_type: txt(row.game_type),
    season_type: txt(row.season_type),
    notes: txt(row.notes),
    record: null,
  };
}

/* ---------------------------------------------------------- the resolver */
/* Which (season, week) is "the upcoming slate" for this sport right now?

   A VOTE, NOT THE FIRST GAME. Taking the week of the earliest upcoming
   kickoff looks right and is wrong on exactly the days this newsletter runs:
   a Monday edition that sees one leftover Monday-night game from the week
   just finishing would make that single game the whole slate. So every
   not-yet-started game inside the horizon votes, the week with the most votes
   wins, and a tie goes to the week that starts sooner. */
function pickWeek(candidates, nowMs, horizonDays) {
  const until = nowMs + (horizonDays || DEFAULT_HORIZON_DAYS) * 86400000;
  const votes = Object.create(null);
  candidates.forEach(c => {
    if (c.kickoff_ms == null || c.kickoff_ms <= nowMs || c.kickoff_ms > until) return;
    if (c.season == null || c.week == null) return;
    const k = c.season + ':' + c.week;
    if (!votes[k]) votes[k] = { season: c.season, week: c.week, games: 0, first: c.kickoff_ms };
    votes[k].games++;
    if (c.kickoff_ms < votes[k].first) votes[k].first = c.kickoff_ms;
  });
  const all = Object.keys(votes).map(k => votes[k]);
  if (!all.length) return null;
  all.sort((a, b) => (b.games - a.games) || (a.first - b.first));
  return { season: all[0].season, week: all[0].week, votes: all };
}

/* resolve({ candidates, sport, now, horizon_days })

   Returns the slate identity and the games in it, plus every candidate it
   refused and why. The refusals are not debris: the operator console prints
   them, and "why was this game not in the newsletter?" should never need a
   code read. */
function resolve(opts) {
  opts = opts || {};
  const sport = String(opts.sport || '').toUpperCase();
  const nowMs = opts.now == null ? Date.now() : (typeof opts.now === 'number' ? opts.now : Date.parse(opts.now));
  if (!Number.isFinite(nowMs)) throw new Error('slate.resolve needs a resolvable `now`');
  const horizon = num(opts.horizon_days) || DEFAULT_HORIZON_DAYS;

  const all = (opts.candidates || []).filter(Boolean)
    .filter(c => String(c.sport).toUpperCase() === sport);

  const excluded = [];
  const usable = [];
  all.forEach(c => {
    if (c.kickoff_ms == null) { excluded.push({ key: c.key, why: 'no_kickoff', detail: 'the record carries no kickoff time' }); return; }
    if (c.kickoff_ms <= nowMs) { excluded.push({ key: c.key, why: 'already_started', detail: 'kickoff was ' + c.kickoff }); return; }
    if (c.season == null || c.week == null) { excluded.push({ key: c.key, why: 'no_week_identity', detail: 'the record carries no season/week' }); return; }
    usable.push(c);
  });

  const picked = pickWeek(usable, nowMs, horizon);
  if (!picked) {
    return {
      ok: false, sport, season: null, week: null, slate_key: null,
      games: [], excluded, horizon_days: horizon,
      reason: 'no_upcoming_games',
      detail: 'no ' + sport + ' game with a season and week identifier kicks off in the next '
        + horizon + ' days',
      now: new Date(nowMs).toISOString(),
    };
  }

  const games = [];
  usable.forEach(c => {
    if (c.season !== picked.season || c.week !== picked.week) {
      excluded.push({ key: c.key, why: 'other_week',
        detail: 'season ' + c.season + ' week ' + c.week + ', not the upcoming '
          + picked.season + ' week ' + picked.week });
      return;
    }
    games.push(c);
  });
  games.sort((a, b) => (a.kickoff_ms - b.kickoff_ms) || String(a.key).localeCompare(String(b.key)));

  return {
    ok: games.length > 0,
    sport,
    season: picked.season,
    week: picked.week,
    slate_key: sport + ':' + picked.season + ':W' + picked.week,
    games,
    excluded,
    horizon_days: horizon,
    /* the alternatives the vote rejected, so a surprising week is explicable */
    week_votes: picked.votes,
    first_kickoff: games.length ? games[0].kickoff : null,
    last_kickoff: games.length ? games[games.length - 1].kickoff : null,
    reason: games.length ? null : 'no_upcoming_games',
    now: new Date(nowMs).toISOString(),
  };
}

/* THE GAME THE NFL EDITION WAITS FOR. The most recent Monday-night NFL game
   that has already kicked off — the one Tuesday's edition is published after.
   Returned with its kickoff so the caller can decide whether enough time has
   passed and whether a result has landed. `null` means there was no Monday
   game to wait for, which is a perfectly ordinary week and not a hold. */
function lastMondayGame(candidates, nowMs, zoneParts) {
  let best = null;
  (candidates || []).forEach(c => {
    if (String(c.sport).toUpperCase() !== 'NFL') return;
    if (c.kickoff_ms == null || c.kickoff_ms > nowMs) return;
    /* within the four days before now: the Monday of the week just finished */
    if (nowMs - c.kickoff_ms > 4 * 86400000) return;
    const p = zoneParts(c.kickoff_ms);
    if (p.weekday !== 'Mon') return;
    if (!best || c.kickoff_ms > best.kickoff_ms) best = c;
  });
  return best;
}

module.exports = {
  DEFAULT_HORIZON_DAYS,
  keyFor, fromRecord, fromSlateRow, pickWeek, resolve, lastMondayGame,
};
