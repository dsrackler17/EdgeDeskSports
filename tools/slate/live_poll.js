#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk slate — the live poller: minute-level status, score and clock.

     node tools/slate/live_poll.js --gate                 is anything live, or about to be?
     node tools/slate/live_poll.js --max-minutes 55       poll until nothing is, or the limit
     options: --interval <s> (default 45) --now <iso> --once

   ONE READER FOR EVERY VISITOR. The poller is the only thing that reads the
   provider while games are on; visitors read what it wrote, through
   public_slate_live() (supabase/games_slate.sql). Same shape as the UFC live
   center (tools/ufc/live_poll.js, ufc-live.yml): a cheap gate decides whether
   to start, and one poller per window holds the work.

   WHAT IT READS. Only the feeds with a game inside its live window (from
   45 minutes before the start to the end of the game), only today's Eastern
   scoreboard (and yesterday's before 6 AM Eastern, when late games are still
   finishing), one request per feed per cycle. When every watched game is
   final and the next start is more than 45 minutes away, it stops.

   WHAT IT WRITES. Through slate_live_ingest() with the service role
   (SB_SERVICE_ROLE / SB_URL, as every job here): the events of each feed it
   read, with research references and ESPN's pregame quote, and each feed's
   read state. A failed read is recorded as failed and writes no events, so a
   provider outage leaves the last good read standing with its age.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const G = require(path.join(__dirname, '..', '..', 'lib', 'edgedesk_games.js'));
const ESPN = require('./espn.js');
const RES = require('./research.js');
const P = require(path.join(__dirname, '..', 'lib', 'pgrest.js'));

const ROOT = path.join(__dirname, '..', '..');
const SNAPSHOT = path.join(ROOT, 'today', 'slate.json');
const MIN = 60000, H = 3600000;
const PRE_MIN = 45;           /* a game enters its live window this long before its start */
const MAX_GAME_H = 6;         /* a game the feed never finalises leaves the window after this */

function arg(name, def) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : def; }
const has = (name) => process.argv.includes(name);
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function loadSnapshot(file) {
  try { const j = JSON.parse(fs.readFileSync(file || SNAPSHOT, 'utf8')); return j && j.schema === G.SCHEMA ? j : null; } catch (_) { return null; }
}

/* the Eastern scoreboard days worth reading right now */
function liveDays(now) {
  const today = G.etDay(now);
  const hourEt = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', hour: '2-digit' }).format(new Date(now))) % 24;
  return hourEt < 6 ? [G.addDays(today, -1), today] : [today];
}
/* is this event inside its live window? */
function inWindow(e, now) {
  const t = G.toMs(e.start_utc);
  if (t == null) return false;
  if (e.status === 'FINAL' || e.status === 'CANCELED' || e.status === 'POSTPONED') return false;
  if (e.status === 'LIVE' || e.status === 'DELAYED' || e.status === 'SUSPENDED') return now - t < 12 * H;
  return now >= t - PRE_MIN * MIN && now <= t + MAX_GAME_H * H;
}
/* the feeds (and days) a cycle must read, from what is known so far */
function plan(events, now) {
  const days = liveDays(now);
  const want = {};
  events.forEach((e) => {
    if (!inWindow(e, now)) return;
    const day = e.sb_day || G.etDay(G.toMs(e.start_utc));
    if (days.indexOf(day) < 0) return;
    const feed = e.feed || (G.sport(e.sport) && G.sport(e.sport).id + ':' + G.sport(e.sport).espn[0].path);
    if (feed) want[feed + '|' + day] = { feed, day };
  });
  return Object.keys(want).sort().map((k) => want[k]);
}
function feedByKey(key) { return ESPN.feeds().find((f) => f.key === key) || null; }

/* the gate: is there anything to poll in the next PRE_MIN minutes? */
function gate(snap, now) {
  const evs = (snap && snap.events) || [];
  const p = plan(evs, now);
  const next = evs.filter((e) => e.status === 'SCHEDULED' && G.toMs(e.start_utc) > now).map((e) => G.toMs(e.start_utc)).sort((a, b) => a - b)[0];
  return { found: p.length > 0, feeds: p, next_start: next != null ? new Date(next).toISOString() : null };
}

function row(e, market) {
  return { id: e.id, sport: e.sport, feed: e.feed, sb_day: e.sb_day, start_utc: e.start_utc, status: e.status, updated_at: e.updated_at, source: 'espn', event: e, market: market || null };
}

async function cycle(state, o) {
  const now = o.now != null ? o.now : Date.now();
  const p = plan(state.events, now);
  const rows = [], feeds = [];
  for (const { feed: fk, day } of p) {
    const feed = feedByKey(fk);
    if (!feed) continue;
    const r = await ESPN.readDay(feed, day.replace(/-/g, ''), { fetch: o.fetch, now, timeoutMs: o.timeoutMs });
    feeds.push({ feed: fk, sport: feed.sport, day, ok: r.ok, fetched_at: r.fetched_at, count: r.events.length, error: r.ok ? null : r.error });
    if (!r.ok) { state.failures++; continue; }
    state.failures = 0;
    r.events.forEach((e) => { e.sb_day = day; e.feed = fk; });
    RES.join(r.events, state.sources, { now });
    r.events.forEach((e) => rows.push(row(e, r.markets[e.id])));
    /* what this feed/day holds now replaces what was known of it */
    state.events = state.events.filter((x) => !(x.feed === fk && x.sb_day === day)).concat(r.events);
  }
  let wrote = null;
  if ((rows.length || feeds.length) && state.db) {
    try { wrote = await state.db.rpc('public', 'slate_live_ingest', { p_events: rows, p_feeds: feeds }); state.dbFailures = 0; }
    catch (e) { state.dbFailures++; wrote = { error: String(e && e.message || e).slice(0, 300) }; }
  }
  return { feeds: p.length, rows: rows.length, failed: feeds.filter((f) => !f.ok).length, wrote, active: plan(state.events, now).length };
}

async function poll(o) {
  o = o || {};
  const snap = o.snapshot !== undefined ? o.snapshot : loadSnapshot();
  const cfg = o.db === undefined ? P.config() : null;
  const state = {
    events: ((snap && snap.events) || []).slice(),
    sources: o.sources || RES.loadSources(),
    db: o.db !== undefined ? o.db : (cfg ? P.client(cfg, o.fetchDb) : null),
    failures: 0, dbFailures: 0
  };
  if (!state.db && !o.allowNoDb) throw new Error('SB_SERVICE_ROLE / SB_URL are not set: the poller has nowhere to write');
  const t0 = o.clock ? o.clock() : Date.now();
  const limit = (o.maxMinutes || 55) * MIN;
  const every = (o.intervalS || 45) * 1000;
  const out = [];
  let idle = 0;
  for (;;) {
    const now = o.clock ? o.clock() : Date.now();
    const r = await cycle(state, Object.assign({}, o, { now }));
    out.push(r);
    if (o.log !== false) console.log(new Date(now).toISOString() + ' feeds ' + r.feeds + ' rows ' + r.rows + ' failed ' + r.failed + ' active ' + r.active + (r.wrote ? ' db ' + JSON.stringify(r.wrote) : ''));
    if (o.once) break;
    idle = r.active ? 0 : idle + 1;
    if (idle >= 2) break;                                  /* nothing left to watch */
    if (state.failures >= 40 || state.dbFailures >= 20) { const e = new Error('giving up: ' + state.failures + ' provider and ' + state.dbFailures + ' database failures in a row'); e.cycles = out; throw e; }
    if ((o.clock ? o.clock() : Date.now()) - t0 + every > limit) break;
    await (o.sleep || sleep)(state.failures ? Math.min(every * Math.pow(2, Math.min(state.failures, 4)), 5 * MIN) : every);
  }
  return out;
}

async function main() {
  const nowArg = arg('--now', null);
  const now = nowArg ? Date.parse(nowArg) : Date.now();
  if (has('--gate')) {
    const g = gate(loadSnapshot(), now);
    console.log((g.found ? 'LIVE WINDOW: ' + g.feeds.map((f) => f.feed + ' ' + f.day).join(', ') : 'nothing live') + (g.next_start ? ' · next start ' + g.next_start : ''));
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'found=' + (g.found ? 'true' : 'false') + '\n');
    return;
  }
  await poll({ maxMinutes: Number(arg('--max-minutes', 55)), intervalS: Number(arg('--interval', 45)), once: has('--once') });
}

if (require.main === module) main().catch((e) => { console.error(e && e.stack || e); process.exit(1); });

module.exports = { gate, plan, inWindow, liveDays, cycle, poll, PRE_MIN };
