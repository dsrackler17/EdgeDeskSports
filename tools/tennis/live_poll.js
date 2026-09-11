#!/usr/bin/env node
/* ===========================================================================
   EdgeDesk Tennis — the on-court poller.

   One GitHub job stays alive for a TOUR-DAY ('atp:2026-05-28'). It takes a
   lock on that key in the database (tennis.acquire_live_lock — one statement,
   so two runs cannot both hold it), then loops: read the tour's scoreboard for
   that day, normalise it, write it, sleep, repeat — twenty seconds while
   anything is on court, ninety between matches — until the day is over or the
   job's own time runs out.

   WHY A TOUR-DAY. The provider files tennis as one scoreboard per tour per
   day carrying every tournament's matches together. Polling per tournament
   would fetch the same document five times; polling per tour-day fetches it
   once and writes all of it.

   WHAT A POLL WRITES, all of it idempotent:

     tennis.live_matches      status, set, games, server, score, result; and
                              the boundary — first_point_at is the LAST poll
                              that still saw the match not started, so a price
                              at or before it is provably pre-match. A poller
                              that only ever saw the match live leaves it null
                              and records the weaker scheduled-start bound.
     tennis.match_live_state  the latest cumulative statistics per side, only
                              the fields the source published
     tennis.match_snapshots   one row per distinct state (content hash), so the
                              same numbers seen twice are one row and a restart
                              cannot duplicate a timeline
     tennis.match_set_stats   provider splits where the source carries them,
                              otherwise the difference between the cumulative
                              state at each set boundary — rebuilt from the
                              stored snapshots on a restart, labelled derived
     tennis.market_captures   the current price of every linked side, tagged
                              PRE or LIVE against that match's own first point
                              as known at that moment
     tennis.tournaments       live counts and state
     tennis.pipeline_runs     a heartbeat every poll: latency, failures, message

   WHAT IT REFUSES. It never resolves a name (the sync owns identity, and a
   doubles pair is a team, never a player). It never writes a statistic the
   feed did not carry. It never moves first_point_at once observed. It never
   reopens a finished match.

   RECOVERY. A source timeout backs off (20s, 40s … 5m) and keeps the run
   alive; ninety minutes of unbroken failure ends the run with an error so the
   next scheduled gate starts a fresh one. A cancelled job releases the lock; a
   job that dies without releasing it loses it after the TTL. When the runner's
   time limit is reached mid-session the poller dispatches the workflow again
   for the same tour-day and hands off cleanly.

     node tools/tennis/live_poll.js --tour atp
     node tools/tennis/live_poll.js --tour wta --day 2026-05-28 --once
     node tools/tennis/live_poll.js --tour atp --fixture-dir tools/tennis/fixtures/day
   =========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const R = require('../../lib/tennis_research.js');
const E = require('./espn.js');
const D = require('./db.js');
const S = require('./sync_events.js');

function log(...a) { if (!process.env.TENNIS_QUIET) console.log('[tennis-live]', ...a); }

const LOCK_TTL_S = 150;
const LIVE_INTERVAL_S = 20;
const IDLE_INTERVAL_S = 90;
const MARKET_EVERY_S = 60;
const ROLLUP_EVERY_S = 300;
const FAIL_GIVE_UP_MS = 90 * 60 * 1000;
const QUIET_DAY_MS = 16 * 3600 * 1000;
const TERMINAL = ['final', 'walkover', 'cancelled'];

function parseArgs(argv) {
  const o = { tour: null, day: null, once: false, maxMinutes: 330, fixtureDir: null, dryRun: false, interval: null, now: null, noDispatch: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    if (a === '--tour') o.tour = String(next()).toLowerCase();
    else if (a === '--day') o.day = next();
    else if (a === '--lock-key') { const k = String(next()).split(':'); o.tour = k[0].toLowerCase(); o.day = k[1] || null; }
    else if (a === '--once') o.once = true;
    else if (a === '--max-minutes') o.maxMinutes = Number(next());
    else if (a === '--fixture-dir') o.fixtureDir = next();
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--interval') o.interval = Number(next());
    else if (a === '--now') o.now = next();
    else if (a === '--no-dispatch') o.noDispatch = true;
  }
  return o;
}

/* ---- a source over recorded files, for tests and rehearsal --------------- */
function fixtureSource(dir) {
  const read = f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  let step = 0;
  return {
    setStep(n) { step = n; },
    async day(tour) {
      for (const c of [`day_${step}.json`, 'day.json']) {
        if (fs.existsSync(path.join(dir, c))) return { tournaments: E.parseScoreboard(read(c), tour), latency: 1, via: 'fixture' };
      }
      throw new Error('no day fixture in ' + dir);
    },
    async summary(tour, providerTournamentId) {
      for (const c of [`summary_${providerTournamentId}_${step}.json`, `summary_${providerTournamentId}.json`]) {
        if (fs.existsSync(path.join(dir, c))) return { json: read(c), latency: 1 };
      }
      const e = new Error('no summary fixture for ' + providerTournamentId); e.status = 404; throw e;
    }
  };
}

/* ---- pure pieces ---------------------------------------------------------- */

function hashOf(obj) {
  const keys = Object.keys(obj).sort();
  return crypto.createHash('sha1').update(keys.map(k => k + '=' + (obj[k] == null ? '' : obj[k])).join('|')).digest('hex').slice(0, 24);
}

/* First-point bookkeeping for one match across polls. prev: the row as the
   database (or the last poll) knew it; row: the fresh parse; lastPreSeenIso:
   the poll time at which this match was last seen not started.

   The rule the whole CLV story rests on: a capture is PRE only if it is at or
   before the last moment the match was provably not under way. A poller that
   arrived after the first ball can never claim that moment, so it stores the
   weaker scheduled-start bound and says which one it used. */
function applyFirstPoint(prev, row, lastPreSeenIso, nowIso) {
  prev = prev || {};
  const out = Object.assign({}, row);
  const started = row.status === 'live' || row.status === 'final' || row.status === 'walkover';
  if (!started) return out;
  if (prev.first_point_at) { out.first_point_at = prev.first_point_at; out.close_bound_source = prev.close_bound_source || 'observed_first_point'; }
  else if (lastPreSeenIso) { out.first_point_at = lastPreSeenIso; out.close_bound_source = 'observed_first_point'; }
  else { out.first_point_at = null; out.close_bound_source = (row.scheduled_at || prev.scheduled_at) ? 'scheduled_start' : null; }
  out.first_live_seen_at = prev.first_live_seen_at || nowIso;
  if (row.status === 'final' || row.status === 'walkover') out.completed_at = prev.completed_at || nowIso;
  return out;
}

const ZERO = {};
E.STAT_FIELDS.forEach(k => { ZERO[k] = 0; });

/* Cumulative -> per-set difference. A field the source stopped publishing is
   null, not a negative delta. */
function diffStats(cur, base) {
  const out = {};
  E.STAT_FIELDS.forEach(k => {
    const a = cur ? cur[k] : null, b = base ? base[k] : null;
    if (a == null) { out[k] = null; return; }
    if (base === ZERO) { out[k] = a; return; }
    out[k] = b == null ? null : a - b;
  });
  return out;
}

/* Rebuild per-set end states from stored snapshots (a restart). Returns
   {side: {set: stats}} using the LAST snapshot seen in each set. */
function setEndsFromSnapshots(snaps) {
  const out = { home: {}, away: {} };
  (snaps || []).slice().sort((a, b) => String(a.captured_at).localeCompare(String(b.captured_at))).forEach(s => {
    if (!s.side || !(s.current_set >= 1)) return;
    const st = {};
    E.STAT_FIELDS.forEach(k => { st[k] = s[k] != null ? s[k] : null; });
    out[s.side][s.current_set] = st;
  });
  return out;
}

/* the columns tennis.match_set_stats actually holds */
const SET_FIELDS = ['aces', 'double_faults', 'first_serves_in', 'first_serves_total', 'first_serve_points_won',
  'first_serve_points_total', 'second_serve_points_won', 'second_serve_points_total', 'service_games_played',
  'service_games_won', 'service_points_won', 'service_points_total', 'break_points_faced', 'break_points_saved',
  'return_points_won', 'return_points_total', 'break_points_won', 'break_points_total', 'total_points_won',
  'winners', 'unforced_errors'];
function pickSet(o) { const r = {}; SET_FIELDS.forEach(k => { r[k] = o[k] != null ? o[k] : null; }); return r; }

/* the columns tennis.match_snapshots actually holds */
const SNAP_FIELDS = ['aces', 'double_faults', 'first_serves_in', 'first_serves_total', 'first_serve_points_won',
  'first_serve_points_total', 'second_serve_points_won', 'second_serve_points_total', 'service_games_played',
  'service_games_won', 'break_points_faced', 'break_points_saved', 'break_points_won', 'break_points_total',
  'return_points_won', 'return_points_total', 'total_points_won', 'winners', 'unforced_errors'];
function pickSnap(o) { const r = {}; SNAP_FIELDS.forEach(k => { r[k] = o[k] != null ? o[k] : null; }); return r; }

/* Games won in one set, from the match's own scoreline — always available even
   when the feed carries no statistics at all. */
function gamesInSet(match, side, setNumber) {
  const sets = R.setsFrom(match);
  const s = sets[setNumber - 1];
  if (!s) return null;
  return side === 'home' ? s.home : s.away;
}
function tbInSet(match, side, setNumber) {
  const sets = R.setsFrom(match);
  const s = sets[setNumber - 1];
  if (!s) return null;
  return side === 'home' ? s.home_tb : s.away_tb;
}

/* Set rows for one side from its cumulative history. ends: {set -> cumulative
   at the end of that set (or the latest seen in it)}. */
function setRowsFromEnds(match, side, playerId, ends, currentSet) {
  const rows = [], sets = Object.keys(ends).map(Number).sort((a, b) => a - b);
  let prev = ZERO;
  sets.forEach(n => {
    const cum = ends[n];
    const d = pickSet(diffStats(cum, prev));
    const isCurrent = currentSet != null && n === currentSet;
    rows.push(Object.assign({ match_id: match.match_id, tournament_id: match.tournament_id, set_number: n, side, player_id: playerId || null,
      set_status: isCurrent ? 'in_progress' : 'complete', stat_source: 'snapshot_delta',
      games_won: gamesInSet(match, side, n), tiebreak_points: tbInSet(match, side, n) }, d));
    prev = cum;
  });
  return rows;
}

/* Provider splits -> rows. */
function setRowsFromProvider(match, side, playerId, splits, currentSet) {
  return Object.keys(splits).map(Number).sort((a, b) => a - b).map(n => {
    const isCurrent = currentSet != null && n === currentSet;
    return Object.assign({ match_id: match.match_id, tournament_id: match.tournament_id, set_number: n, side, player_id: playerId || null,
      set_status: isCurrent ? 'in_progress' : 'complete', stat_source: 'provider',
      games_won: gamesInSet(match, side, n), tiebreak_points: tbInSet(match, side, n) }, pickSet(splits[n]));
  });
}

/* Tournament-level facts from the matches on file for it. Counts come from the
   database, never from the day's slice of the draw, so a poller cannot make a
   fortnight-long tournament look like a six-match one. */
function tournamentRollup(prev, allMatches, nowIso) {
  const total = allMatches.length;
  const done = allMatches.filter(m => m.status === 'final' || m.status === 'walkover').length;
  const live = allMatches.filter(m => m.status === 'live').length;
  let state = prev.state || 'scheduled';
  if (live > 0) state = 'live';
  else if (total > 0 && allMatches.every(m => TERMINAL.includes(m.status))) state = 'final';
  else if (state === 'live') state = 'scheduled';
  return { tournament_id: prev.tournament_id, state, matches_total: total, matches_completed: done, matches_live: live, source_updated_at: nowIso };
}

/* Fields the poller owns on a tournament row. Everything else (name, surface,
   dates, venue) belongs to the sync and is never overwritten from a day view. */
function tournamentTouch(t, nowIso) {
  return { tournament_id: t.tournament_id, source_updated_at: nowIso };
}

function stripInternal(m) {
  const out = Object.assign({}, m);
  ['inline_stats', 'grouping', 'tour_source', 'provider_tournament_id', 'updated_at', 'ingested_at'].forEach(k => { delete out[k]; });
  return out;
}

/* The fields a poll can change. source_updated_at is deliberately NOT among
   them: it moves every poll, and hashing it would make every row dirty. */
const MATCH_MUTABLE = ['status', 'status_detail', 'current_set', 'sets_home', 'sets_away', 'games_home', 'games_away',
  'points_home', 'points_away', 'server_side', 'winner_side', 'result_type', 'result_detail',
  'first_point_at', 'close_bound_source', 'completed_at', 'home_name', 'away_name', 'home_player_id', 'away_player_id',
  'round', 'court', 'best_of', 'scheduled_at', 'match_order', 'tour'];
function matchHash(m) {
  const o = {};
  MATCH_MUTABLE.forEach(k => { o[k] = m[k] == null ? '' : m[k]; });
  o.set_scores = JSON.stringify(m.set_scores || []);
  return hashOf(o);
}

/* ---- one poll ------------------------------------------------------------- */

async function pollOnce(ctx) {
  const { db, src, state, o } = ctx;
  const nowIso = ctx.now();
  const nowMs = Date.parse(nowIso);
  const res = await src.day(ctx.tour, ctx.dayMs);
  const writes = { matches: 0, states: 0, snapshots: 0, sets: 0, captures: 0, tournaments: 0 };
  const unmapped = {};
  let statErrors = 0, latency = res.latency;

  /* 1. every tournament the day carries, and every match THIS TOUR OWNS.

     A runner showed the provider returning a combined event (the US Open)
     from both the atp and the wta scoreboard as the same id carrying the same
     478 competitions. Two pollers would then write the same rows over each
     other twenty seconds apart. So each match is owned by exactly one tour —
     read from the draw bucket it is filed under — and a poller writes only
     what it owns. Mixed doubles belongs to no single tour, so one is named as
     its owner by convention (E.ownerTour). */
  const nextMatches = [], byTournament = {};
  const seenTournaments = [];
  const wantTour = String(ctx.tour || '').toUpperCase();
  let notMine = 0;
  (res.tournaments || []).forEach(t => {
    const rows = S.tournamentRows(t, nowIso);
    seenTournaments.push(rows.tournament);
    rows.matches.forEach(m => {
      if (E.ownerTour(m.tour) !== wantTour) { notMine++; return; }
      const prev = state.matches[m.match_id];
      /* identity belongs to the sync: the poller carries it forward, never re-derives it */
      if (prev) {
        if (prev.home_player_id) m.home_player_id = prev.home_player_id;
        if (prev.away_player_id) m.away_player_id = prev.away_player_id;
        if (prev.best_of != null && m.best_of == null) m.best_of = prev.best_of;
      }
      if (m.status === 'scheduled') state.lastPreSeen[m.match_id] = nowIso;
      const row = applyFirstPoint(prev, m, state.lastPreSeen[m.match_id], nowIso);
      /* a finished match never reopens because a later document forgot it */
      if (prev && TERMINAL.includes(prev.status) && (row.status === 'scheduled' || row.status === 'unknown')) {
        row.status = prev.status; row.winner_side = prev.winner_side; row.result_type = prev.result_type; row.result_detail = prev.result_detail;
      }
      row.tournament_id = rows.tournament.tournament_id;
      nextMatches.push(row);
      (byTournament[rows.tournament.tournament_id] = byTournament[rows.tournament.tournament_id] || []).push(row);
    });
  });

  if (!o.dryRun && seenTournaments.length) {
    await db.upsert('tennis', 'tournaments', seenTournaments.map(t => tournamentTouch(t, nowIso)), 'tournament_id', { returning: false });
    writes.tournaments += seenTournaments.length;
  }
  /* WRITE WHAT MOVED. A slam day carries hundreds of matches, almost all of
     them unchanged between polls; upserting every one of them every twenty
     seconds would be hundreds of writes a minute for nothing. A content hash
     over the mutable fields decides. The first poll of a run writes every row
     it owns, because the hash is not yet known for any of them. */
  const dirty = nextMatches.filter(m => {
    const h = matchHash(m);
    if (state.matchHash[m.match_id] === h) return false;
    state.matchHash[m.match_id] = h;
    return true;
  });
  if (!o.dryRun && dirty.length) {
    await db.upsert('tennis', 'live_matches', dirty.map(stripInternal), 'match_id', { returning: false, chunk: 200 });
    writes.matches += dirty.length;
  }
  const changed = nextMatches.filter(m => state.matchStatus[m.match_id] !== m.status);
  nextMatches.forEach(m => { state.matches[m.match_id] = Object.assign({}, state.matches[m.match_id] || {}, m); state.matchStatus[m.match_id] = m.status; });

  /* 2. statistics for live matches, and once more for matches that just ended */
  const inline = {};
  (res.tournaments || []).forEach(t => (t.matches || []).forEach(m => { inline[S.matchId(m.provider_match_id)] = m; }));
  const wantStats = nextMatches.filter(m => m.status === 'live' || ((m.status === 'final' || m.status === 'walkover') && !state.finalDone[m.match_id]));
  const summaryCache = {};
  for (const m of wantStats) {
    const pm = inline[m.match_id];
    const got = {};
    for (const side of ['home', 'away']) {
      let st = null, splits = {}, mapped = 0;
      const il = pm && pm.inline_stats && pm.inline_stats[side];
      if (il) {
        const n = E.normalizeStats(il);
        if (n.mapped) { st = n.stats; mapped = n.mapped; splits = E.setSplits(il); Object.keys(n.unmapped).forEach(k => { unmapped[k] = (unmapped[k] || 0) + 1; }); }
      }
      if (!st && pm && pm.provider_tournament_id && typeof src.summary === 'function') {
        try {
          if (summaryCache[pm.provider_tournament_id] === undefined) {
            const r = await src.summary(ctx.tour, pm.provider_tournament_id);
            summaryCache[pm.provider_tournament_id] = r.json; latency = r.latency;
          }
          const found = statsFromSummary(summaryCache[pm.provider_tournament_id], pm.provider_match_id, side);
          if (found && found.mapped) { st = found.stats; mapped = found.mapped; splits = found.splits || {}; Object.keys(found.unmapped || {}).forEach(k => { unmapped[k] = (unmapped[k] || 0) + 1; }); }
        } catch (e) {
          summaryCache[pm.provider_tournament_id] = null;
          statErrors++;
          if (!e || e.status !== 404) state.lastStatError = String(e && e.message || e);
        }
      }
      got[side] = { stats: st || {}, mapped, splits, playerId: side === 'home' ? m.home_player_id : m.away_player_id,
        name: side === 'home' ? m.home_name : m.away_name, athleteId: side === 'home' ? m.home_provider_id : m.away_provider_id };
    }

    const sw = R.setsWon(m);
    const stateRows = [], snapRows = [], setRows = [];
    ['home', 'away'].forEach(side => {
      const g = got[side], raw = g.stats;
      const clean = {}; E.STAT_FIELDS.forEach(k => { clean[k] = raw[k] != null ? raw[k] : null; });
      const hash = hashOf(Object.assign({ set: m.current_set, status: m.status, games: side === 'home' ? m.games_home : m.games_away,
        sets: side === 'home' ? sw.home : sw.away }, clean));
      stateRows.push(Object.assign({ match_id: m.match_id, tournament_id: m.tournament_id, side, player_id: g.playerId || null,
        provider_athlete_id: g.athleteId || null, player_name: g.name || null, status: m.status,
        current_set: m.current_set, sets_won: side === 'home' ? sw.home : sw.away,
        games_won: side === 'home' ? m.games_home : m.games_away,
        stats_available: g.mapped > 0, source: 'espn', source_updated_at: nowIso, source_latency_ms: latency, content_hash: hash }, clean));
      if (g.mapped > 0) {
        snapRows.push(Object.assign({ match_id: m.match_id, side, captured_at: nowIso, status: m.status, current_set: m.current_set,
          sets_won: side === 'home' ? sw.home : sw.away, games_won: side === 'home' ? m.games_home : m.games_away,
          is_serving: m.server_side === side, content_hash: hash }, pickSnap(clean)));
        const cur = m.status === 'live' ? m.current_set : null;
        if (g.splits && Object.keys(g.splits).length) setRows.push(...setRowsFromProvider(m, side, g.playerId, g.splits, cur));
        else if (m.current_set >= 1) {
          const ends = (state.setEnds[m.match_id] = state.setEnds[m.match_id] || { home: {}, away: {} })[side];
          ends[m.current_set] = clean;
          setRows.push(...setRowsFromEnds(m, side, g.playerId, ends, cur));
        }
      } else if (m.current_set >= 1) {
        /* no statistics at all: the scoreline is still a fact, so the set row
           exists carrying games won and nothing invented beside it */
        const sets = R.setsFrom(m);
        for (let n = 1; n <= sets.length; n++) {
          setRows.push(Object.assign({ match_id: m.match_id, tournament_id: m.tournament_id, set_number: n, side, player_id: g.playerId || null,
            set_status: (m.status === 'live' && n === m.current_set) ? 'in_progress' : 'complete', stat_source: 'snapshot_delta',
            games_won: gamesInSet(m, side, n), tiebreak_points: tbInSet(m, side, n) }, pickSet({})));
        }
      }
    });
    if (!o.dryRun) {
      await db.upsert('tennis', 'match_live_state', stateRows, 'match_id,side', { returning: false }); writes.states += stateRows.length;
      if (snapRows.length) { await db.upsert('tennis', 'match_snapshots', snapRows, 'match_id,side,content_hash', { ignoreDuplicates: true, returning: false }); writes.snapshots += snapRows.length; }
      if (setRows.length) { await db.upsert('tennis', 'match_set_stats', setRows, 'match_id,set_number,side', { returning: false }); writes.sets += setRows.length; }
    }
    if (m.status === 'final' || m.status === 'walkover') {
      if (!statErrors && (got.home.mapped || got.away.mapped)) state.finalDone[m.match_id] = true;
      else {
        state.statMisses[m.match_id] = (state.statMisses[m.match_id] || 0) + 1;
        if (state.statMisses[m.match_id] >= 3) state.finalDone[m.match_id] = true;
      }
    }
  }

  /* 3. market captures, each minute, for the links THIS POLL SAW.

     The link table holds every linked match on file, not just today's. Asking
     the odds feed about all of them would be dozens of requests a minute for
     matches this runner is not watching and cannot tag a capture against — a
     capture's PRE/LIVE state is decided by its own match's first point, so a
     match the poll did not see has nothing to decide it. */
  const byId = {};
  nextMatches.forEach(m => { byId[m.match_id] = m; });
  const mine = ctx.links.filter(l => byId[l.match_id]);
  if (mine.length && (!state.lastMarketAt || nowMs - state.lastMarketAt >= MARKET_EVERY_S * 1000)) {
    try {
      const keys = [].concat(...mine.map(l => [l.home_sig_key, l.away_sig_key].filter(Boolean)));
      if (keys.length) {
        const sig = [];
        for (let i = 0; i < keys.length; i += 30) sig.push(...await db.select('public', 'signals', `select=${SIGNAL_COLS}&sig_key=in.${D.inList(keys.slice(i, i + 30))}`));
        const caps = S.captureRows(mine, sig, byId).filter(c => c.source === 'signals');
        if (caps.length && !o.dryRun) { await db.upsert('tennis', 'market_captures', caps, 'sig_key,capture_at', { ignoreDuplicates: true, returning: false, chunk: 200 }); writes.captures += caps.length; }
      }
      state.lastMarketAt = nowMs; state.marketOk = true;
    } catch (e) { state.marketOk = false; state.lastMarketError = String(e && e.message || e); }
  }

  /* 4. tournament rollups — only when something moved, or every five minutes,
        and always counted over the whole draw on file rather than today's slice */
  if (changed.length || !state.lastRollupAt || nowMs - state.lastRollupAt >= ROLLUP_EVERY_S * 1000) {
    for (const t of seenTournaments) {
      try {
        const all = await db.selectAll('tennis', 'live_matches', `select=match_id,status&tournament_id=eq.${encodeURIComponent(t.tournament_id)}&order=match_id.asc`);
        const prev = state.tournaments[t.tournament_id] || { tournament_id: t.tournament_id, state: t.state };
        const roll = tournamentRollup(prev, all, nowIso);
        state.tournaments[t.tournament_id] = roll;
        if (!o.dryRun) await db.upsert('tennis', 'tournaments', [roll], 'tournament_id', { returning: false });
      } catch (e) { state.lastRollupError = String(e && e.message || e); }
    }
    state.lastRollupAt = nowMs;
  }

  const live = nextMatches.filter(m => m.status === 'live');
  const doneCount = nextMatches.filter(m => m.status === 'final' || m.status === 'walkover').length;
  const scheduled = nextMatches.filter(m => m.status === 'scheduled').length;
  const anyLive = live.length > 0;
  const done = nextMatches.length > 0 && scheduled === 0 && !anyLive;
  const lead = live.slice().sort((a, b) => (a.match_order || 0) - (b.match_order || 0))[0];
  const message = lead
    ? `${R.shortName(lead.home_name)} vs ${R.shortName(lead.away_name)} ${R.scoreLine(lead) || ''} · ${live.length} live, ${doneCount} done, ${scheduled} to come`
    : `${live.length} live, ${doneCount} done, ${scheduled} to come`;
  return { matches: nextMatches, tournaments: seenTournaments, anyLive, done, writes, latency, statErrors, unmapped, message, via: res.via,
    counts: { live: live.length, done: doneCount, scheduled, written: dirty.length, other_tour: notMine } };
}

const SIGNAL_COLS = 'sig_key,event_id,sport_key,market,selection,point,commence_time,home_team,away_team,best_dec,best_book,first_best_dec,first_seen_at,sharp_fair,consensus_fair,n_books,has_sharp,last_seen_at';

/* Statistics for one competition out of a tournament summary document. The
   summary is a different shape from the scoreboard, so this looks for the
   competition by id and reads whatever statistics hang off its competitors. */
function statsFromSummary(json, providerMatchId, side) {
  if (!json) return null;
  let comp = null;
  (function walk(node) {
    if (comp || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (String(node.id) === String(providerMatchId) && Array.isArray(node.competitors)) { comp = node; return; }
    Object.keys(node).forEach(k => walk(node[k]));
  })(json);
  if (!comp) return null;
  const comps = comp.competitors.slice().sort((a, b) => (Number(a.order) || 99) - (Number(b.order) || 99));
  const c = side === 'home' ? comps[0] : comps[1];
  if (!c) return null;
  const raw = c.statistics || c.stats || null;
  if (!raw) return null;
  const n = E.normalizeStats(raw);
  if (!n.mapped) return null;
  return { stats: n.stats, mapped: n.mapped, unmapped: n.unmapped, splits: E.setSplits(raw) };
}

/* ---- startup state, from the database ------------------------------------- */
/* The tour labels one poller owns. A mixed-doubles row carries tour MIXED and
   is owned by exactly one tour (E.ownerTour), so the owner must LOAD it too —
   otherwise a restart would not know its first point and would fall back to
   the weaker scheduled-start bound on a match it had been watching. */
function ownedTours(tour) {
  const t = String(tour || '').toUpperCase();
  const mine = [t];
  if (E.ownerTour('MIXED') === t) mine.push('MIXED');
  return mine;
}

async function loadState(db, tour, dayIso) {
  const state = { matches: {}, matchStatus: {}, matchHash: {}, lastPreSeen: {}, setEnds: {}, finalDone: {}, statMisses: {},
    tournaments: {}, lastMarketAt: 0, lastRollupAt: 0, marketOk: null };
  const from = new Date(Date.parse(dayIso + 'T00:00:00Z') - 36 * 3600000).toISOString();
  const to = new Date(Date.parse(dayIso + 'T00:00:00Z') + 60 * 3600000).toISOString();
  const rows = await db.selectAll('tennis', 'live_matches',
    `select=*&tour=in.${D.inList(ownedTours(tour))}&scheduled_at=gte.${from}&scheduled_at=lte.${to}&order=match_id.asc`);
  rows.forEach(m => {
    state.matches[m.match_id] = m;
    state.matchStatus[m.match_id] = m.status;
    if (TERMINAL.includes(m.status)) state.finalDone[m.match_id] = m.status === 'cancelled';
    /* the last write that saw this match still scheduled is the last moment it
       was provably pre-match: a restart keeps the strict bound rather than
       falling back to the scheduled start */
    if (m.status === 'scheduled' && (m.source_updated_at || m.updated_at)) state.lastPreSeen[m.match_id] = m.source_updated_at || m.updated_at;
  });
  const open = rows.filter(m => m.status === 'live' || m.status === 'final' || m.status === 'walkover').map(m => m.match_id);
  for (let i = 0; i < open.length; i += 40) {
    const slice = open.slice(i, i + 40);
    const snaps = await db.selectAll('tennis', 'match_snapshots',
      `select=match_id,side,current_set,captured_at,${SNAP_FIELDS.join(',')}&match_id=in.${D.inList(slice)}&order=captured_at.asc`);
    const by = {}; snaps.forEach(s => { (by[s.match_id] = by[s.match_id] || []).push(s); });
    Object.keys(by).forEach(id => { state.setEnds[id] = setEndsFromSnapshots(by[id]); });
    const states = await db.select('tennis', 'match_live_state', `select=match_id,side,stats_available,status&match_id=in.${D.inList(slice)}`);
    states.forEach(s => {
      const m = state.matches[s.match_id];
      if (m && (m.status === 'final' || m.status === 'walkover') && s.stats_available && s.status === m.status) state.finalDone[s.match_id] = true;
    });
  }
  return state;
}

async function dispatchContinuation(tour, day, env) {
  env = env || process.env;
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPOSITORY) { log('no GITHUB_TOKEN/GITHUB_REPOSITORY — cannot dispatch a continuation'); return false; }
  const api = (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
  const wf = env.TENNIS_LIVE_WORKFLOW || 'tennis-live.yml';
  const res = await fetch(`${api}/repos/${env.GITHUB_REPOSITORY}/actions/workflows/${wf}/dispatches`, {
    method: 'POST', headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' },
    body: JSON.stringify({ ref: env.GITHUB_REF_NAME || 'main', inputs: { tour, day, continuation: 'true' } })
  });
  if (res.status === 204) { log(`continuation dispatched for ${tour}:${day}`); return true; }
  log(`continuation dispatch answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return false;
}

/* ---- the run --------------------------------------------------------------- */
async function run(o, deps) {
  deps = deps || {};
  const db = deps.db, src = deps.source || (o.fixtureDir ? fixtureSource(o.fixtureDir) : E.source());
  const clock = deps.now || (() => new Date().toISOString());
  const sleep = deps.sleep || D.sleep;
  const owner = deps.owner || `${process.env.GITHUB_RUN_ID || 'local'}-${process.env.GITHUB_RUN_ATTEMPT || '1'}-${process.pid}`;
  const tour = String(o.tour || '').toLowerCase();
  if (!tour) throw new Error('a tour is required (--tour atp|wta)');
  const day = o.day || String(clock()).slice(0, 10);
  const lockKey = tour + ':' + day;
  const dayMs = Date.parse(day + 'T12:00:00Z');
  const ledger = deps.ledger || D.runLedger(db, 'tennis_live', { scope: lockKey });
  const summary = { polls: 0, failures: 0, consecutive: 0, writes: 0, status: 'ok', message: '', lock_key: lockKey };

  /* the lock */
  if (!o.dryRun) {
    const lk = await db.rpc('tennis', 'acquire_live_lock', { p_lock_key: lockKey, p_owner: owner, p_ttl_seconds: LOCK_TTL_S });
    if (!lk || !lk.acquired) {
      log(`lock on ${lockKey} is held by ${lk && lk.owner} until ${lk && lk.expires_at} — standing down`);
      await ledger.start({ owner, lock: lk }); await ledger.finish('cancelled', `lock held by ${lk && lk.owner}`);
      return Object.assign(summary, { status: 'cancelled', message: 'lock held' });
    }
  }
  await ledger.start({ owner, tour, day });

  const links = await db.selectAll('tennis', 'match_markets', 'select=match_id,tournament_id,home_sig_key,away_sig_key&order=match_id.asc');
  const state = await loadState(db, tour, day);
  /* every link is carried; a capture is only written for a match the poll
     actually saw, so a link to another day costs nothing here */
  const ctx = { db, src, state, o, now: clock, tour, day, dayMs, lockKey, links };
  const deadline = Date.parse(clock()) + (o.maxMinutes != null && isFinite(o.maxMinutes) ? o.maxMinutes : 330) * 60000;
  const dayStart = Date.parse(day + 'T00:00:00Z');
  let stopping = false, failSince = null, unmappedAll = {}, lastCounts = null;
  const onSignal = () => { stopping = true; };
  process.on('SIGTERM', onSignal); process.on('SIGINT', onSignal);

  let done = false, handedOff = false;
  try {
    while (!stopping) {
      let interval = IDLE_INTERVAL_S;
      try {
        const r = await pollOnce(ctx);
        summary.polls++; summary.consecutive = 0; failSince = null; summary.writes = db.stats ? db.stats.writes : summary.writes;
        Object.keys(r.unmapped).forEach(k => { unmappedAll[k] = (unmappedAll[k] || 0) + r.unmapped[k]; });
        interval = r.anyLive ? LIVE_INTERVAL_S : IDLE_INTERVAL_S;
        summary.message = r.message; lastCounts = r.counts;
        log(`${r.message} · ${r.via} ${r.latency}ms · ${r.counts.written} row(s) written${r.counts.other_tour ? ', ' + r.counts.other_tour + ' left to the other tour' : ''}${r.statErrors ? ' · ' + r.statErrors + ' stat fetch error(s)' : ''}`);
        await ledger.beat({ polls: summary.polls, writes: summary.writes, consecutive_failures: 0, last_success_at: clock(), last_source_at: clock(),
          source_latency_ms: r.latency, message: r.message,
          details: { tour, day, counts: r.counts, via: r.via, unmapped_keys: unmappedAll, stat_errors: r.statErrors,
            last_stat_error: state.lastStatError || null, market_ok: state.marketOk, market_error: state.lastMarketError || null, owner } });
        if (r.done) { done = true; break; }
        /* a day past its window with nothing live and nothing moving is not
           worth a runner: the gate will start a fresh one if play resumes */
        if (!r.anyLive && Date.parse(clock()) - dayStart > QUIET_DAY_MS && r.counts.done > 0) {
          log(`nothing live ${Math.round((Date.parse(clock()) - dayStart) / 3600000)}h into ${day} with ${r.counts.scheduled} still scheduled — leaving the day to the next gate`);
          done = true; break;
        }
      } catch (e) {
        summary.failures++; summary.consecutive++;
        failSince = failSince || Date.parse(clock());
        const backoff = Math.min(300, LIVE_INTERVAL_S * Math.pow(2, Math.max(0, summary.consecutive - 1)));
        log(`poll failed (${summary.consecutive} in a row): ${e && e.message || e} — retrying in ${backoff}s`);
        await ledger.beat({ consecutive_failures: summary.consecutive, message: `source failing: ${String(e && e.message || e).slice(0, 200)}` });
        if (Date.parse(clock()) - failSince > FAIL_GIVE_UP_MS) { summary.status = 'error'; summary.message = 'source failed for 90 minutes'; break; }
        interval = backoff;
      }
      if (o.once) break;
      if (Date.parse(clock()) + interval * 1000 > deadline) {
        if (!o.dryRun && !o.noDispatch) handedOff = await dispatchContinuation(tour, day);
        summary.status = 'handed_off';
        summary.message = handedOff ? 'time limit reached — continuation dispatched' : 'time limit reached — no continuation dispatched';
        break;
      }
      if (!o.dryRun) {
        const lk = await db.rpc('tennis', 'acquire_live_lock', { p_lock_key: lockKey, p_owner: owner, p_ttl_seconds: LOCK_TTL_S });
        if (!lk || !lk.acquired) { summary.status = 'cancelled'; summary.message = `lock taken over by ${lk && lk.owner}`; log(summary.message); break; }
      }
      await sleep((o.interval != null ? o.interval : interval) * 1000);
    }
  } finally {
    process.removeListener('SIGTERM', onSignal); process.removeListener('SIGINT', onSignal);
  }
  if (stopping && !done) { summary.status = 'cancelled'; summary.message = 'stopped by signal'; }
  if (done && lastCounts) summary.message = `${lockKey} settled · ${lastCounts.done} complete, ${lastCounts.scheduled} never started`;
  if (!o.dryRun) { try { await db.rpc('tennis', 'release_live_lock', { p_lock_key: lockKey, p_owner: owner }); } catch (_) {} }
  await ledger.finish(summary.status, summary.message, { polls: summary.polls, writes: summary.writes, consecutive_failures: summary.consecutive,
    details: { owner, tour, day, unmapped_keys: unmappedAll, done, handed_off: handedOff, counts: lastCounts } });
  if (!o.dryRun) await D.writeMeta(db, { tennis_live_last_run: clock(),
    tennis_live_last_status: (summary.status === 'ok' || summary.status === 'handed_off') ? 'ok' : summary.status,
    tennis_live_last_scope: lockKey });
  return Object.assign(summary, { done, handedOff, counts: lastCounts });
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!o.tour) { console.error('usage: live_poll.js --tour atp|wta [--day YYYY-MM-DD] [--once] [--max-minutes N] [--fixture-dir DIR] [--dry-run]'); process.exit(2); }
  const cfg = D.config();
  if (!cfg) { console.error('No service credential (EDGD_SB_SERVICE + EDGD_SB_URL).'); process.exit(1); }
  const db = D.client(cfg);
  try {
    const s = await run(o, { db });
    log(`${s.status}: ${s.message} (${s.polls} polls, ${s.failures} failures)`);
    process.exit(s.status === 'error' ? 1 : 0);
  } catch (e) {
    console.error('[tennis-live] failed: ' + (e && e.stack || e));
    process.exit(1);
  }
}

module.exports = { parseArgs, fixtureSource, applyFirstPoint, diffStats, setEndsFromSnapshots, setRowsFromEnds, setRowsFromProvider,
  tournamentRollup, statsFromSummary, pollOnce, loadState, ownedTours, run, hashOf, matchHash, gamesInSet, SET_FIELDS, SNAP_FIELDS, MATCH_MUTABLE,
  LOCK_TTL_S, LIVE_INTERVAL_S, IDLE_INTERVAL_S, MARKET_EVERY_S, TERMINAL };
if (require.main === module) main();
