#!/usr/bin/env node
/* ===========================================================================
   EdgeDesk UFC — the fight-night poller.

   One GitHub job stays alive for the card. It takes a lock on the event in
   the database (ufc.acquire_live_lock — one statement, so two runs cannot
   both hold it), then loops: read the provider's state of the card, normalise
   it, write it, sleep, repeat — twenty seconds while a bout is live, a minute
   between bouts — until the card is over or the job's own time runs out.

   WHAT A POLL WRITES, all of it idempotent:

     ufc.bouts            status, round, clock, result; and the boundary —
                          first_bell_at is the LAST poll that still saw the
                          bout as not started, so a price at or before it is
                          provably pre-fight. A poller that only ever saw the
                          bout live leaves it null and records the weaker
                          card-start bound instead.
     ufc.fight_live_state the latest cumulative statistics per corner, only
                          the fields the source published
     ufc.fight_snapshots  one row per distinct state (content hash), so the
                          same numbers seen twice are one row and a restart
                          cannot duplicate a timeline
     ufc.fight_round_stats provider splits where the source carries them,
                          otherwise the difference between the cumulative
                          state at the end of each round — rebuilt from the
                          stored snapshots on a restart, labelled as derived
     ufc.market_captures  the current price of every linked selection,
                          tagged PRE or LIVE against the bout's own bell as
                          known at that moment
     ufc.events           current bout, counts, state, completion
     ufc.pipeline_runs    a heartbeat every poll: latency, failures, message

   RECOVERY. A source timeout backs off (20s, 40s, ... 5m) and keeps the run
   alive; ninety minutes of unbroken failure ends the run with an error so
   the next scheduled gate starts a fresh one. A cancelled job releases the
   lock; a job that dies without releasing it loses it after the TTL. When
   the runner's time limit is reached mid-card the poller dispatches the
   workflow again for the same event (a workflow_dispatch made with the job's
   own token is the one event GitHub does run) and hands off cleanly.

     node tools/ufc/live_poll.js --event espn:600052001
     node tools/ufc/live_poll.js --event espn:600052001 --once      # one pass
     node tools/ufc/live_poll.js --event espn:600052001 --fixture-dir tools/ufc/fixtures/card
   =========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const R = require('../../lib/ufc_research.js');
const E = require('./espn.js');
const D = require('./db.js');
const S = require('./sync_events.js');

function log(...a) { if (!process.env.UFC_QUIET) console.log('[ufc-live]', ...a); }

const LOCK_TTL_S = 150;
const LIVE_INTERVAL_S = 20;
const IDLE_INTERVAL_S = 60;
const MARKET_EVERY_S = 60;
const FAIL_GIVE_UP_MS = 90 * 60 * 1000;
const QUIET_CARD_MS = 8 * 3600 * 1000;

function parseArgs(argv) {
  const o = { event: null, once: false, maxMinutes: 330, fixtureDir: null, dryRun: false, interval: null, now: null, noDispatch: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    if (a === '--event') o.event = next();
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
    async eventDetail(providerEventId) {
      const candidates = [`event_${step}.json`, 'event.json'];
      for (const c of candidates) if (fs.existsSync(path.join(dir, c))) {
        const evs = E.parseScoreboard(read(c)).filter(e => String(e.provider_event_id) === String(providerEventId));
        if (!evs.length) throw new Error('fixture has no event ' + providerEventId);
        return { event: evs[0], latency: 1, via: 'fixture' };
      }
      throw new Error('no event fixture in ' + dir);
    },
    async competitorStats(providerEventId, providerBoutId, athleteId) {
      const candidates = [`stats_${providerBoutId}_${athleteId}_${step}.json`, `stats_${providerBoutId}_${athleteId}.json`];
      for (const c of candidates) if (fs.existsSync(path.join(dir, c))) {
        const raw = read(c), n = E.normalizeStats(raw);
        return { stats: n.stats, unmapped: n.unmapped, mapped: n.mapped, rounds: E.roundSplits(raw), latency: 1 };
      }
      const e = new Error('no stats fixture for ' + providerBoutId + '/' + athleteId); e.status = 404; throw e;
    }
  };
}

/* ---- pure pieces ------------------------------------------------------------ */

const TERMINAL = ['final', 'no_contest', 'cancelled'];

function hashOf(obj) {
  const keys = Object.keys(obj).sort();
  return crypto.createHash('sha1').update(keys.map(k => k + '=' + (obj[k] == null ? '' : obj[k])).join('|')).digest('hex').slice(0, 24);
}

/* Bell bookkeeping for one bout across polls. prev: the row as the database
   (or the last poll) knew it; row: the fresh parse; lastPreSeen: the poll
   time at which this bout was last seen not started. */
function applyBell(prev, row, lastPreSeenIso, nowIso, event) {
  prev = prev || {};
  const out = Object.assign({}, row);
  const started = row.status === 'live' || row.status === 'final' || row.status === 'no_contest';
  if (!started) return out;
  if (prev.first_bell_at) { out.first_bell_at = prev.first_bell_at; out.close_bound_source = prev.close_bound_source || 'observed_bell'; }
  else if (lastPreSeenIso) { out.first_bell_at = lastPreSeenIso; out.close_bound_source = 'observed_bell'; }
  else { out.first_bell_at = null; out.close_bound_source = event && event.scheduled_at ? 'card_start' : null; }
  out.first_live_seen_at = prev.first_live_seen_at || nowIso;
  if (row.status === 'live') {
    const cs = row.clock_seconds != null ? row.clock_seconds : R.parseClock(row.clock);
    out.elapsed_seconds = R.elapsedFromClock(row.round, cs);
  }
  if ((row.status === 'final' || row.status === 'no_contest')) {
    out.completed_at = prev.completed_at || nowIso;
    const el = R.elapsedAtEnd(row);
    if (el != null) out.elapsed_seconds = el;
  }
  return out;
}

const ZERO = {};
E.STAT_FIELDS.forEach(k => { ZERO[k] = 0; });

function diffStats(cur, base) {
  const out = {};
  E.STAT_FIELDS.forEach(k => {
    const a = cur ? cur[k] : null, b = base ? base[k] : null;
    if (a == null) { out[k] = null; return; }
    out[k] = b == null ? (base === ZERO ? a : null) : a - b;
    if (base === ZERO) out[k] = a;
  });
  return out;
}

/* Rebuild per-round end states from stored snapshots (a restart). Returns
   {corner: {round: stats}} using the LAST snapshot in each round. */
function roundEndsFromSnapshots(snaps) {
  const out = { red: {}, blue: {} };
  (snaps || []).slice().sort((a, b) => String(a.captured_at).localeCompare(String(b.captured_at))).forEach(s => {
    if (!s.corner || !(s.round >= 1)) return;
    const st = {};
    E.STAT_FIELDS.forEach(k => { st[k] = s[k] != null ? s[k] : null; });
    out[s.corner][s.round] = st;
  });
  return out;
}

/* Round rows for one corner from its cumulative history. ends: {round ->
   cumulative at the end of that round (or the latest seen in it)}. current:
   the round in progress (null once the bout is over). */
function roundRowsFromEnds(bout, corner, fighterId, ends, currentRound, elapsedInRound, finalRound, finalEndSeconds) {
  const rows = [], rounds = Object.keys(ends).map(Number).sort((a, b) => a - b);
  let prev = ZERO;
  rounds.forEach(n => {
    const cum = ends[n];
    const d = diffStats(cum, prev);
    const isCurrent = currentRound != null && n === currentRound;
    const isLast = finalRound != null && n === finalRound;
    rows.push(Object.assign({ bout_id: bout.bout_id, event_id: bout.event_id, round: n, corner, fighter_id: fighterId || null,
      round_status: isCurrent ? 'in_progress' : 'complete', stat_source: 'snapshot_delta',
      round_seconds: isCurrent ? (elapsedInRound != null ? elapsedInRound : null) : (isLast && finalEndSeconds != null ? finalEndSeconds : R.ROUND_SECONDS) }, d));
    prev = cum;
  });
  return rows;
}

/* Provider splits -> rows. */
function roundRowsFromProvider(bout, corner, fighterId, splits, currentRound, elapsedInRound, finalRound, finalEndSeconds) {
  return Object.keys(splits).map(Number).sort((a, b) => a - b).map(n => {
    const isCurrent = currentRound != null && n === currentRound, isLast = finalRound != null && n === finalRound;
    const st = {}; E.STAT_FIELDS.forEach(k => { st[k] = splits[n][k] != null ? splits[n][k] : null; });
    return Object.assign({ bout_id: bout.bout_id, event_id: bout.event_id, round: n, corner, fighter_id: fighterId || null,
      round_status: isCurrent ? 'in_progress' : 'complete', stat_source: 'provider',
      round_seconds: isCurrent ? (elapsedInRound != null ? elapsedInRound : null) : (isLast && finalEndSeconds != null ? finalEndSeconds : R.ROUND_SECONDS) }, st);
  });
}

/* Event-level facts from its bouts. */
function eventFromBouts(event, bouts, feedState, nowIso) {
  const live = bouts.filter(b => b.status === 'live').sort((a, b) => (a.bout_order || 0) - (b.bout_order || 0));
  const terminal = bouts.filter(b => TERMINAL.includes(b.status));
  const scheduled = bouts.filter(b => b.status === 'scheduled').sort((a, b) => (a.bout_order || 0) - (b.bout_order || 0));
  let state;
  if (live.length) state = 'live';
  else if (bouts.length && terminal.length === bouts.length) state = 'final';
  else if (terminal.length && scheduled.length) state = 'live';
  else if (feedState === 'live') state = 'live';
  else state = feedState || 'scheduled';
  const bells = bouts.map(b => b.first_bell_at).filter(Boolean).sort();
  return Object.assign({}, event, {
    event_state: state,
    current_bout_id: live.length ? live[0].bout_id : (scheduled.length ? scheduled[0].bout_id : null),
    bouts_total: bouts.length,
    bouts_completed: bouts.filter(b => b.status === 'final' || b.status === 'no_contest').length,
    bouts_live: live.length,
    first_bell_at: event.first_bell_at || bells[0] || null,
    completed_at: state === 'final' ? (event.completed_at || nowIso) : (event.completed_at || null),
    source_updated_at: nowIso
  });
}

/* ---- one poll ------------------------------------------------------------- */

async function pollOnce(ctx) {
  const { db, src, state, o } = ctx;
  const nowIso = ctx.now();
  const nowMs = Date.parse(nowIso);
  const res = await src.eventDetail(ctx.providerEventId, ctx.scheduledAtMs);
  const parsed = res.event;
  const rows = S.eventRows(parsed, nowIso);
  const writes = { bouts: 0, states: 0, snapshots: 0, rounds: 0, captures: 0 };
  const unmapped = {};

  /* bouts and the bell */
  const nextBouts = [];
  rows.bouts.forEach(b => {
    const prev = state.bouts[b.bout_id];
    if (prev) { if (prev.red_fighter_id && !b.red_fighter_id) b.red_fighter_id = prev.red_fighter_id; if (prev.blue_fighter_id && !b.blue_fighter_id) b.blue_fighter_id = prev.blue_fighter_id; }
    if (b.status === 'scheduled') state.lastPreSeen[b.bout_id] = nowIso;
    const row = applyBell(prev, b, state.lastPreSeen[b.bout_id], nowIso, ctx.event);
    if (prev && (prev.status === 'final' || prev.status === 'no_contest') && row.status === 'scheduled') { row.status = prev.status; row.winner_corner = prev.winner_corner; row.method = prev.method; }
    nextBouts.push(row);
  });
  /* a bout the card no longer lists that had not ended: cancelled, in place */
  Object.keys(state.bouts).forEach(id => {
    if (nextBouts.some(b => b.bout_id === id)) return;
    const prev = state.bouts[id];
    if (TERMINAL.includes(prev.status)) { nextBouts.push(Object.assign({}, prev)); return; }
    nextBouts.push(Object.assign({}, prev, { status: 'cancelled', status_detail: 'absent from provider card', source_updated_at: nowIso }));
  });
  if (!o.dryRun) { await db.upsert('ufc', 'bouts', nextBouts.map(stripInternal), 'bout_id', { returning: false }); writes.bouts += nextBouts.length; }
  nextBouts.forEach(b => { state.bouts[b.bout_id] = Object.assign({}, state.bouts[b.bout_id] || {}, b); });

  /* statistics for live bouts, and once more for bouts that just ended */
  const inline = {};
  rows.bouts.forEach(b => { inline[b.bout_id] = parsed.bouts.find(x => 'espn:' + x.provider_bout_id === b.bout_id); });
  const wantStats = nextBouts.filter(b => b.status === 'live' || ((b.status === 'final' || b.status === 'no_contest') && !state.finalDone[b.bout_id]));
  let statErrors = 0, latency = res.latency;
  for (const b of wantStats) {
    const pb = inline[b.bout_id];
    const corners = [['red', b.red_provider_id, b.red_fighter_id, b.red_name], ['blue', b.blue_provider_id, b.blue_fighter_id, b.blue_name]];
    const got = {};
    for (const c of corners) {
      const corner = c[0], athleteId = c[1];
      let st = null, rounds = {}, mapped = 0;
      const il = pb && pb.inline_stats && pb.inline_stats[corner];
      if (il) { const n = E.normalizeStats(il); if (n.mapped) { st = n.stats; mapped = n.mapped; rounds = E.roundSplits(il); Object.keys(n.unmapped).forEach(k => { unmapped[k] = (unmapped[k] || 0) + 1; }); } }
      if (!st && athleteId) {
        try {
          const r = await src.competitorStats(ctx.providerEventId, b.provider_bout_id, athleteId);
          st = r.stats; mapped = r.mapped; rounds = r.rounds || {}; latency = r.latency;
          Object.keys(r.unmapped || {}).forEach(k => { unmapped[k] = (unmapped[k] || 0) + 1; });
        } catch (e) { statErrors++; if (!e || e.status !== 404) state.lastStatError = String(e && e.message || e); }
      }
      got[corner] = { stats: st || {}, mapped, rounds, fighterId: c[2], name: c[3], athleteId };
    }
    const elapsed = b.elapsed_seconds != null ? b.elapsed_seconds : null;
    const stateRows = [], snapRows = [], roundRows = [];
    ['red', 'blue'].forEach(corner => {
      const g = got[corner], st = g.stats;
      const clean = {}; E.STAT_FIELDS.forEach(k => { clean[k] = st[k] != null ? st[k] : null; });
      const hash = hashOf(Object.assign({ round: b.round, status: b.status }, clean));
      stateRows.push(Object.assign({ bout_id: b.bout_id, event_id: b.event_id, corner, fighter_id: g.fighterId || null, provider_athlete_id: g.athleteId || null,
        fighter_name: g.name || null, status: b.status, round: b.round, clock: b.clock, clock_seconds: b.clock_seconds, elapsed_seconds: elapsed,
        stats_available: g.mapped > 0, source: 'espn', source_updated_at: nowIso, source_latency_ms: latency, content_hash: hash }, clean));
      if (g.mapped > 0) {
        snapRows.push(Object.assign({ bout_id: b.bout_id, corner, captured_at: nowIso, status: b.status, round: b.round, clock: b.clock, clock_seconds: b.clock_seconds,
          elapsed_seconds: elapsed, content_hash: hash }, pickSnap(clean)));
        /* per-round: provider splits win; otherwise cumulative deltas at round boundaries */
        const cur = b.status === 'live' ? b.round : null;
        const elIn = (b.status === 'live' && elapsed != null && b.round >= 1) ? elapsed - (b.round - 1) * R.ROUND_SECONDS : null;
        const finalRound = (b.status === 'final' || b.status === 'no_contest') ? (b.end_round || b.round || null) : null;
        const finalEnd = finalRound != null ? R.parseClock(b.end_time) : null;
        if (g.rounds && Object.keys(g.rounds).length) roundRows.push(...roundRowsFromProvider(b, corner, g.fighterId, g.rounds, cur, elIn, finalRound, finalEnd));
        else if (b.round >= 1) {
          const ends = (state.roundEnds[b.bout_id] = state.roundEnds[b.bout_id] || { red: {}, blue: {} })[corner];
          ends[b.round] = clean;
          roundRows.push(...roundRowsFromEnds(b, corner, g.fighterId, ends, cur, elIn, finalRound, finalEnd));
        }
      }
    });
    if (!o.dryRun) {
      await db.upsert('ufc', 'fight_live_state', stateRows, 'bout_id,corner', { returning: false }); writes.states += stateRows.length;
      if (snapRows.length) { await db.upsert('ufc', 'fight_snapshots', snapRows, 'bout_id,corner,content_hash', { ignoreDuplicates: true, returning: false }); writes.snapshots += snapRows.length; }
      if (roundRows.length) { await db.upsert('ufc', 'fight_round_stats', roundRows, 'bout_id,round,corner', { returning: false }); writes.rounds += roundRows.length; }
    }
    if (b.status === 'final' || b.status === 'no_contest') {
      if (!statErrors) state.finalDone[b.bout_id] = true;
      else {
        /* a finished bout the source never publishes statistics for is asked
           three times, then left with stats_available=false rather than
           asked on every poll for the rest of the card */
        state.statMisses[b.bout_id] = (state.statMisses[b.bout_id] || 0) + 1;
        if (state.statMisses[b.bout_id] >= 3) state.finalDone[b.bout_id] = true;
      }
    }
  }

  /* market captures for every linked selection, each minute */
  if (ctx.links.length && (!state.lastMarketAt || nowMs - state.lastMarketAt >= MARKET_EVERY_S * 1000)) {
    try {
      const keys = [].concat(...ctx.links.map(l => [l.red_sig_key, l.blue_sig_key, l.draw_sig_key].filter(Boolean)));
      if (keys.length) {
        const sig = [];
        for (let i = 0; i < keys.length; i += 30) sig.push(...await db.select('public', 'signals', `select=${S_COLS}&sig_key=in.${D.inList(keys.slice(i, i + 30))}`));
        const boutsById = {}; nextBouts.forEach(b => { boutsById[b.bout_id] = b; });
        const caps = S.captureRows(ctx.links, sig, null, boutsById, { [ctx.eventId]: ctx.event }).filter(c => c.source === 'signals');
        if (caps.length && !o.dryRun) { await db.upsert('ufc', 'market_captures', caps, 'sig_key,capture_at', { ignoreDuplicates: true, returning: false }); writes.captures += caps.length; }
      }
      state.lastMarketAt = nowMs; state.marketOk = true;
    } catch (e) { state.marketOk = false; state.lastMarketError = String(e && e.message || e); }
  }

  /* the event */
  const ev = eventFromBouts(Object.assign({}, ctx.event, rows.event), nextBouts, parsed.event_state, nowIso);
  if (!o.dryRun) await db.upsert('ufc', 'events', [ev], 'event_id', { returning: false });
  ctx.event = ev;

  const anyLive = nextBouts.some(b => b.status === 'live');
  const done = ev.event_state === 'final';
  const cur = nextBouts.find(b => b.bout_id === ev.current_bout_id);
  const message = cur ? `${cur.status === 'live' ? 'R' + (cur.round || '?') + ' ' + (cur.clock || '') + ' ' : 'next: '}${cur.red_name} vs ${cur.blue_name} · ${ev.bouts_completed}/${ev.bouts_total} complete`
    : `${ev.event_state} · ${ev.bouts_completed}/${ev.bouts_total} complete`;
  return { event: ev, bouts: nextBouts, anyLive, done, writes, latency, statErrors, unmapped, message, via: res.via };
}

const S_COLS = 'sig_key,event_id,sport_key,market,selection,point,commence_time,home_team,away_team,best_dec,best_book,first_best_dec,first_seen_at,sharp_fair,consensus_fair,n_books,has_sharp,last_seen_at';

function stripInternal(b) {
  const out = Object.assign({}, b);
  ['inline_stats', 'order_source', 'raw_status_name', 'scheduled_at', 'provider_event_id', 'updated_at', 'ingested_at'].forEach(k => { delete out[k]; });
  return out;
}
function pickSnap(clean) {
  const keep = ['knockdowns', 'sig_strikes_landed', 'sig_strikes_attempted', 'total_strikes_landed', 'total_strikes_attempted', 'takedowns_landed', 'takedowns_attempted',
    'submission_attempts', 'reversals', 'control_seconds', 'head_strikes_landed', 'body_strikes_landed', 'leg_strikes_landed', 'distance_strikes_landed', 'clinch_strikes_landed', 'ground_strikes_landed'];
  const o = {}; keep.forEach(k => { o[k] = clean[k]; }); return o;
}

/* ---- startup state, from the database ------------------------------------- */
async function loadState(db, eventId) {
  const state = { bouts: {}, lastPreSeen: {}, roundEnds: {}, finalDone: {}, statMisses: {}, lastMarketAt: 0, marketOk: null };
  const bouts = await db.select('ufc', 'bouts', `select=*&event_id=eq.${encodeURIComponent(eventId)}&limit=60`);
  bouts.forEach(b => {
    state.bouts[b.bout_id] = b;
    if (TERMINAL.includes(b.status)) state.finalDone[b.bout_id] = b.status === 'cancelled' ? true : false;
    /* the last write that saw this bout still scheduled is the last moment it
       was provably pre-fight: a restart keeps the strict bound instead of
       falling back to the card start */
    if (b.status === 'scheduled' && (b.source_updated_at || b.updated_at)) state.lastPreSeen[b.bout_id] = b.source_updated_at || b.updated_at;
  });
  const open = bouts.filter(b => b.status === 'live' || b.status === 'final' || b.status === 'no_contest').map(b => b.bout_id);
  if (open.length) {
    const snaps = await db.select('ufc', 'fight_snapshots', `select=bout_id,corner,round,captured_at,${E.STAT_FIELDS.filter(k => !/_attempted$/.test(k) || /sig_strikes|total_strikes|takedowns/.test(k)).join(',')}&bout_id=in.${D.inList(open)}&order=captured_at.asc&limit=5000`);
    const by = {}; snaps.forEach(s => { (by[s.bout_id] = by[s.bout_id] || []).push(s); });
    Object.keys(by).forEach(id => { state.roundEnds[id] = roundEndsFromSnapshots(by[id]); });
    /* a final bout whose stats were already stored needs no refetch */
    const states = await db.select('ufc', 'fight_live_state', `select=bout_id,corner,stats_available,status&bout_id=in.${D.inList(open)}`);
    states.forEach(s => { const b = state.bouts[s.bout_id]; if (b && (b.status === 'final' || b.status === 'no_contest') && s.stats_available && s.status === b.status) state.finalDone[s.bout_id] = true; });
  }
  return state;
}

async function dispatchContinuation(eventId, env) {
  env = env || process.env;
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPOSITORY) { log('no GITHUB_TOKEN/GITHUB_REPOSITORY — cannot dispatch a continuation'); return false; }
  const api = (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
  const wf = env.UFC_LIVE_WORKFLOW || 'ufc-live.yml';
  const res = await fetch(`${api}/repos/${env.GITHUB_REPOSITORY}/actions/workflows/${wf}/dispatches`, {
    method: 'POST', headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' },
    body: JSON.stringify({ ref: env.GITHUB_REF_NAME || 'main', inputs: { event_id: eventId, continuation: 'true' } })
  });
  if (res.status === 204) { log('continuation dispatched for ' + eventId); return true; }
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
  const eventId = o.event;
  const ev = (await db.select('ufc', 'events', `select=*&event_id=eq.${encodeURIComponent(eventId)}`))[0];
  if (!ev) throw new Error(`event ${eventId} is not on file — run tools/ufc/sync_events.js first`);
  const ledger = deps.ledger || D.runLedger(db, 'ufc_live', { eventId });
  const summary = { polls: 0, failures: 0, consecutive: 0, writes: 0, status: 'ok', message: '' };

  /* the lock */
  if (!o.dryRun) {
    const lk = await db.rpc('ufc', 'acquire_live_lock', { p_event_id: eventId, p_owner: owner, p_ttl_seconds: LOCK_TTL_S });
    if (!lk || !lk.acquired) {
      log(`lock on ${eventId} is held by ${lk && lk.owner} until ${lk && lk.expires_at} — standing down`);
      await ledger.start({ owner, lock: lk }); await ledger.finish('cancelled', `lock held by ${lk && lk.owner}`);
      return Object.assign(summary, { status: 'cancelled', message: 'lock held' });
    }
  }
  await ledger.start({ owner, provider_event_id: ev.provider_event_id, name: ev.name });

  const links = await db.select('ufc', 'bout_markets', `select=bout_id,event_id,signal_event_id,red_sig_key,blue_sig_key,draw_sig_key&event_id=eq.${encodeURIComponent(eventId)}&limit=60`);
  const state = await loadState(db, eventId);
  const ctx = { db, src, state, o, now: clock, event: ev, eventId, providerEventId: ev.provider_event_id, scheduledAtMs: Date.parse(ev.scheduled_at), links };
  const deadline = Date.parse(clock()) + (o.maxMinutes != null && isFinite(o.maxMinutes) ? o.maxMinutes : 330) * 60000;
  let stopping = false, failSince = null, lastFinalAt = null, unmappedAll = {};
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
        if (r.event.bouts_completed) lastFinalAt = lastFinalAt || Date.parse(clock());
        summary.message = r.message;
        log(`${r.message} · ${r.via} ${r.latency}ms${r.statErrors ? ' · ' + r.statErrors + ' stat fetch error(s)' : ''}`);
        await ledger.beat({ polls: summary.polls, writes: summary.writes, consecutive_failures: 0, last_success_at: clock(), last_source_at: clock(), source_latency_ms: r.latency,
          message: r.message, details: { current_bout_id: r.event.current_bout_id, event_state: r.event.event_state, any_live: r.anyLive, via: r.via, unmapped_keys: unmappedAll,
            stat_errors: r.statErrors, last_stat_error: state.lastStatError || null, market_ok: state.marketOk, market_error: state.lastMarketError || null, owner } });
        if (r.done) { done = true; break; }
        /* a card past its window with nothing live and nothing moving is not worth a runner */
        if (!r.anyLive && Date.parse(clock()) - ctx.scheduledAtMs > QUIET_CARD_MS && r.event.bouts_completed > 0) {
          const scheduledLeft = r.bouts.filter(b => b.status === 'scheduled');
          if (scheduledLeft.length) { log(`${scheduledLeft.length} bout(s) still scheduled ${Math.round((Date.parse(clock()) - ctx.scheduledAtMs) / 3600000)}h after the card start — marking the event stale and exiting`);
            if (!o.dryRun) await db.patch('ufc', 'events', `event_id=eq.${encodeURIComponent(eventId)}`, { event_state: 'stale', source_updated_at: clock() }); }
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
        if (!o.dryRun && !o.noDispatch) handedOff = await dispatchContinuation(eventId);
        summary.status = 'handed_off'; summary.message = handedOff ? 'time limit reached — continuation dispatched' : 'time limit reached — no continuation dispatched';
        break;
      }
      if (!o.dryRun) {
        const lk = await db.rpc('ufc', 'acquire_live_lock', { p_event_id: eventId, p_owner: owner, p_ttl_seconds: LOCK_TTL_S });
        if (!lk || !lk.acquired) { summary.status = 'cancelled'; summary.message = `lock taken over by ${lk && lk.owner}`; log(summary.message); break; }
      }
      await sleep((o.interval != null ? o.interval : interval) * 1000);
    }
  } finally {
    process.removeListener('SIGTERM', onSignal); process.removeListener('SIGINT', onSignal);
  }
  if (stopping && !done) { summary.status = 'cancelled'; summary.message = 'stopped by signal'; }
  if (done) { summary.status = summary.status === 'ok' ? 'ok' : summary.status; summary.message = `event ${ctx.event.event_state} · ${ctx.event.bouts_completed}/${ctx.event.bouts_total} bouts complete`; }
  if (!o.dryRun) { try { await db.rpc('ufc', 'release_live_lock', { p_event_id: eventId, p_owner: owner }); } catch (_) {} }
  await ledger.finish(summary.status, summary.message, { polls: summary.polls, writes: summary.writes, consecutive_failures: summary.consecutive, details: { owner, unmapped_keys: unmappedAll, done, handed_off: handedOff } });
  if (!o.dryRun) await D.writeMeta(db, { ufc_live_last_run: clock(), ufc_live_last_status: summary.status === 'ok' ? 'ok' : (summary.status === 'handed_off' ? 'ok' : summary.status), ufc_live_last_event: eventId });
  return Object.assign(summary, { done, handedOff, event: ctx.event });
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!o.event) { console.error('usage: live_poll.js --event <ufc event id> [--once] [--max-minutes N] [--fixture-dir DIR] [--dry-run]'); process.exit(2); }
  const cfg = D.config();
  if (!cfg) { console.error('No service credential (EDGD_SB_SERVICE + EDGD_SB_URL).'); process.exit(1); }
  const db = D.client(cfg);
  try {
    const s = await run(o, { db });
    log(`${s.status}: ${s.message} (${s.polls} polls, ${s.failures} failures)`);
    process.exit(s.status === 'error' ? 1 : 0);
  } catch (e) {
    console.error('[ufc-live] failed: ' + (e && e.stack || e));
    process.exit(1);
  }
}

module.exports = { parseArgs, fixtureSource, applyBell, diffStats, roundEndsFromSnapshots, roundRowsFromEnds, roundRowsFromProvider, eventFromBouts, pollOnce, loadState, run,
  hashOf, LOCK_TTL_S, LIVE_INTERVAL_S, IDLE_INTERVAL_S, MARKET_EVERY_S, TERMINAL };
if (require.main === module) main();
