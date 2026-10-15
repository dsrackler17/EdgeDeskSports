#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk slate — build today/slate.json, the daily slate every page reads.

     node tools/slate/build.js                 dry run: build, report, write nothing
     node tools/slate/build.js --write         write today/slate.json when it changed
     node tools/slate/build.js --verify        read today's scoreboard for every
                                               sport and report what came back
     node tools/slate/build.js --offline       no network: the repo's own schedules
     options: --now <iso>  --force  --out <path>

   WHAT IT HOLDS. Every game of every listed sport on the US-Eastern days
   [today − 2, today + 3] (so any reader, in any zone, has yesterday, today
   and tomorrow), plus each sport's next scheduled games beyond that window
   for the "Upcoming" list. Each game carries the research it already has
   (tools/slate/research.js). Prices sit in a separate `markets` map, so the
   schedule never waits on, or disappears with, a price.

   SCHEDULE NEVER DEPENDS ON ODDS. The slate reads schedules from ESPN's
   scoreboard (tools/slate/espn.js), not from the odds pipeline: no credit is
   spent and a paused or exhausted odds quota changes nothing here.

   ONE PROVIDER CALL PER (FEED, DAY) PER REFRESH WINDOW, NOT PER VISITOR. The
   file is served statically; readers never reach ESPN. A (feed, day) is
   re-read only when its last read is older than its refresh interval
   (REFRESH below): the near days often, the far days rarely, a past day whose
   every game is final never again.

   A FAILED READ NEVER EMPTIES A DAY. If ESPN cannot be read for a (feed, day),
   the previous read of it is carried forward and labelled with its age; with
   no previous read, the repo's own schedule for that sport is used
   (tools/slate/artifacts.js) and labelled as such; with neither, the day is
   marked failed for that sport, which the page shows as "Unable to load",
   never as "No games scheduled".
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const G = require(path.join(__dirname, '..', '..', 'lib', 'edgedesk_games.js'));
const ESPN = require('./espn.js');
const ART = require('./artifacts.js');
const RES = require('./research.js');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'today', 'slate.json');
const MIN = 60000, H = 3600000;

const WINDOW = { from: -2, to: 3 };
const UPCOMING = { through: 14, per_sport: 6 };
/* minutes between reads of one (feed, day), by its distance from today (ET) */
const REFRESH = { near: 20, tomorrow: 60, far: 180, upcoming: 360 };

function arg(name, def) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : def; }
const has = (name) => process.argv.includes(name);

function readPrev(file) {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return j && j.schema === G.SCHEMA ? j : null; } catch (_) { return null; }
}
function ymd(day) { return day.replace(/-/g, ''); }

/* the refresh interval of a (feed, day) bucket, minutes; null = never */
function refreshMin(day, today, prev) {
  if (prev && prev.ok && prev.source === 'espn' && day < today && prev.all_final) return null;
  if (day === today || day === G.addDays(today, -1)) return REFRESH.near;
  if (day === G.addDays(today, 1)) return REFRESH.tomorrow;
  if (day > G.addDays(today, WINDOW.to)) return REFRESH.upcoming;
  return REFRESH.far;
}

/* a few requests at a time, spaced: a cold start reads a few hundred
   scoreboard days once, and the provider should never see a burst */
let SPACING_MS = Number(process.env.SLATE_SPACING_MS || 120);
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

/* the feed an artifact event belongs to */
function feedOfArtifact(e) {
  const sp = G.sport(e.sport);
  if (!sp) return null;
  return sp.id + ':' + sp.espn[0].path;
}

async function build(o) {
  o = o || {};
  if (o.spacingMs != null) SPACING_MS = o.spacingMs;
  const now = o.now != null ? o.now : Date.now();
  const nowIso = new Date(now).toISOString();
  const today = G.etDay(now);
  const prev = o.prev !== undefined ? o.prev : readPrev(o.out || OUT);
  const prevBuckets = (prev && prev.buckets) || {};
  const prevEvents = {};
  ((prev && prev.events) || []).concat((prev && prev.upcoming) || []).forEach((e) => { prevEvents[e.id] = e; });
  const prevMarkets = (prev && prev.markets) || {};
  const feeds = ESPN.feeds().filter((f) => !o.sports || o.sports.indexOf(f.sport) >= 0);
  const art = o.artifacts || ART.load(nowIso);
  const artByFeedDay = {};
  Object.keys(art.bySport).forEach((s) => art.bySport[s].forEach((e) => {
    const fk = feedOfArtifact(e); if (!fk) return;
    const k = fk + '|' + G.etDay(G.toMs(e.start_utc));
    (artByFeedDay[k] = artByFeedDay[k] || []).push(Object.assign({}, e, { sb_day: G.etDay(G.toMs(e.start_utc)), feed: fk }));
  }));

  const days = [];
  for (let d = WINDOW.from; d <= WINDOW.to; d++) days.push(G.addDays(today, d));
  const buckets = {}, events = [], markets = {}, rejected = [], log = [];
  let requests = 0;

  /* one (feed, day): fresh read, carried read, artifact, or failed */
  async function bucket(feed, day, kind) {
    const key = feed.key + '|' + day;
    const pb = prevBuckets[key] || null;
    const every = refreshMin(day, today, pb);
    const age = pb && pb.fetched_at ? (now - Date.parse(pb.fetched_at)) / MIN : null;
    /* a read that failed is retried no sooner than its refresh interval
       (and at most every 20 minutes), so a provider outage is not hammered */
    const lastTry = pb && !pb.ok ? Date.parse(pb.last_error_at || pb.checked_at || 0) : null;
    const backoff = lastTry && isFinite(lastTry) && (now - lastTry) / MIN < Math.min(every == null ? REFRESH.near : every, REFRESH.near);
    const due = o.force || !pb || (!pb.ok ? !backoff : every != null && (age == null || age >= every));
    if (!due && pb && !pb.ok) return { key, b: Object.assign({}, pb, { checked_at: nowIso }), evs: [], mkts: {} };
    const carry = () => (pb && pb.ok && Array.isArray(pb.ids)) ? pb.ids.map((id) => prevEvents[id]).filter(Boolean) : null;
    if (!due && pb && pb.ok) {
      const evs = carry();
      if (evs) return { key, b: Object.assign({}, pb, { checked_at: nowIso }), evs, mkts: pb.ids.reduce((m, id) => { if (prevMarkets[id]) m[id] = prevMarkets[id]; return m; }, {}) };
    }
    if (!o.offline) {
      requests++;
      const r = await ESPN.readDay(feed, ymd(day), { fetch: o.fetch, now, timeoutMs: o.timeoutMs });
      if (SPACING_MS) await new Promise((res) => setTimeout(res, SPACING_MS));
      if (r.ok) {
        const evs = r.events.map((e) => Object.assign(e, { sb_day: day, feed: feed.key }));
        r.rejected.forEach((x) => rejected.push(Object.assign({ feed: feed.key }, x)));
        return { key, b: { ok: true, source: 'espn', fetched_at: r.fetched_at, checked_at: nowIso, count: evs.length,
          all_final: evs.length > 0 && evs.every((e) => e.status === 'FINAL' || e.status === 'CANCELED' || e.status === 'POSTPONED'), ids: evs.map((e) => e.id), kind }, evs, mkts: r.markets };
      }
      log.push(feed.key + ' ' + day + ': ' + r.error);
      const evs = carry();
      if (evs) return { key, b: Object.assign({}, pb, { checked_at: nowIso, carried: true, last_error: r.error, last_error_at: nowIso }), evs, mkts: pb.ids.reduce((m, id) => { if (prevMarkets[id]) m[id] = prevMarkets[id]; return m; }, {}) };
      const a = artByFeedDay[feed.key + '|' + day];
      if (a && a.length) return { key, b: { ok: true, source: 'artifact', fetched_at: a[0].updated_at || null, checked_at: nowIso, count: a.length, ids: a.map((e) => e.id), last_error: r.error, last_error_at: nowIso, kind }, evs: a, mkts: {} };
      return { key, b: { ok: false, source: 'none', fetched_at: null, checked_at: nowIso, count: 0, ids: [], last_error: r.error, last_error_at: nowIso, kind }, evs: [], mkts: {} };
    }
    /* offline: the previous read, else the repo's schedules. An artifact's
       silence for a day is not "no games" — the artifact may simply not
       cover that sport or that far ahead — so an empty offline bucket is
       unknown, not empty */
    const evs = carry();
    if (evs) return { key, b: Object.assign({}, pb, { checked_at: nowIso, carried: true }), evs, mkts: pb.ids.reduce((m, id) => { if (prevMarkets[id]) m[id] = prevMarkets[id]; return m; }, {}) };
    const a = artByFeedDay[feed.key + '|' + day] || [];
    const covered = art.sources.some((s) => s.sports.indexOf(feed.sport) >= 0 && artifactCovers(s, day, today));
    if (a.length || covered) return { key, b: { ok: true, source: 'artifact', fetched_at: a.length ? a[0].updated_at : (art.sources.find((s) => s.sports.indexOf(feed.sport) >= 0) || {}).generated_at || null, checked_at: nowIso, count: a.length, ids: a.map((e) => e.id), kind }, evs: a, mkts: {} };
    return { key, b: { ok: false, source: 'none', fetched_at: null, checked_at: nowIso, count: 0, ids: [], last_error: 'no schedule source for this sport offline', kind }, evs: [], mkts: {} };
  }

  const jobs = [];
  feeds.forEach((f) => days.forEach((d) => jobs.push([f, d])));
  const got = await pool(jobs, o.concurrency || 3, ([f, d]) => bucket(f, d, 'window'));
  got.forEach((g) => { buckets[g.key] = g.b; g.evs.forEach((e) => events.push(e)); Object.assign(markets, g.mkts); });

  /* UPCOMING: a sport with few scheduled games ahead in the window gets its
     next games, read day by day past the window until there are enough */
  const upcoming = [];
  const winEnd = G.addDays(today, WINDOW.to);
  for (const sp of G.SPORTS) {
    if (o.sports && o.sports.indexOf(sp.id) < 0) continue;
    const ahead = events.filter((e) => e.sport === sp.id && e.status === 'SCHEDULED' && e.sb_day > G.addDays(today, 1)).length;
    if (ahead >= UPCOMING.per_sport) continue;
    let found = [];
    for (let d = WINDOW.to + 1; d <= UPCOMING.through && found.length < UPCOMING.per_sport; d++) {
      const day = G.addDays(today, d);
      const got2 = await pool(sp.espn.map((f) => Object.assign({ sport: sp.id, key: sp.id + ':' + f.path }, f)), 4, (f) => bucket(f, day, 'upcoming'));
      got2.forEach((g) => { buckets[g.key] = g.b; Object.assign(markets, g.mkts); g.evs.forEach((e) => { if (e.status === 'SCHEDULED' && G.toMs(e.start_utc) > now) found.push(e); }); });
      /* the sport's source is down: scanning further days would only repeat it */
      if (got2.every((g) => !g.b.ok)) break;
    }
    found = G.order(found).slice(0, UPCOMING.per_sport);
    found.forEach((e) => upcoming.push(e));
  }

  /* one event, one id: across days and providers */
  const all = G.dedupe(events);
  const up = G.dedupe(upcoming).filter((e) => !all.some((x) => x.id === e.id));
  RES.join(all.concat(up), o.research || RES.loadSources(), { now });
  /* markets only for games the slate holds, and only pregame — the upcoming
     games too: ESPN posts next week's lines (Sunday's NFL slate on a
     Wednesday), and the EdgeDesk Card prices them (lib/edgedesk_card_feed.js) */
  const mk = {};
  all.concat(up).forEach((e) => { if (markets[e.id]) mk[e.id] = markets[e.id]; });

  /* per sport: what a reader is told about where the slate came from */
  const sports = {};
  G.SPORTS.forEach((sp) => {
    if (o.sports && o.sports.indexOf(sp.id) < 0) return;
    const bs = Object.keys(buckets).filter((k) => k.indexOf(sp.id + ':') === 0 && buckets[k].kind === 'window').map((k) => buckets[k]);
    const fresh = bs.filter((b) => b.ok && b.source === 'espn' && !b.carried);
    const carried = bs.filter((b) => b.ok && b.carried);
    const artb = bs.filter((b) => b.ok && b.source === 'artifact');
    const failed = bs.filter((b) => !b.ok);
    const lastOk = bs.filter((b) => b.ok && b.fetched_at).map((b) => b.fetched_at).sort().pop() || null;
    const state = failed.length === bs.length ? 'failed' : failed.length ? 'partial' : artb.length ? 'fallback' : carried.length ? 'stale' : 'ok';
    sports[sp.id] = {
      state, last_success_at: lastOk, days_fresh: fresh.length, days_carried: carried.length, days_fallback: artb.length, days_failed: failed.length,
      note: state === 'fallback' ? 'Schedule from EdgeDesk’s own ' + (art.sources.filter((s) => s.sports.indexOf(sp.id) >= 0).map((s) => s.file).join(', ') || 'files') + ': no live status or scores.'
        : state === 'failed' ? 'The schedule source could not be read and no earlier read is held.'
          : state === 'partial' ? 'Some days could not be read: ' + failed.length + ' of ' + bs.length + '.'
            : state === 'stale' ? 'The latest read failed; showing the previous read with its time.' : null
    };
  });

  const snap = {
    schema: G.SCHEMA,
    generated_at: nowIso,
    builder: 'tools/slate/build.js',
    note: 'The daily slate: every listed game on the US-Eastern days in `window`, the next games per sport in `upcoming`, the research each game already has, and pregame prices in `markets` (a book, both sides, the capture time). Schedules come from ESPN’s public scoreboard, never from the odds pipeline. Times are UTC. Research, not picks.',
    window: { from_day: days[0], to_day: days[days.length - 1], zone: 'America/New_York', upcoming_through: G.addDays(today, UPCOMING.through) },
    refresh_minutes: REFRESH,
    sources: { primary: 'ESPN public scoreboard (site.api.espn.com), one request per feed per day per refresh window', fallback: art.sources },
    sports,
    counts: { events: all.length, upcoming: up.length, markets: Object.keys(mk).length },
    run: { requests, odds_rejected: rejected.length },
    events: G.order(all).map(strip),
    upcoming: G.order(up).map(strip),
    markets: sortKeys(mk),
    buckets: sortKeys(buckets)
  };
  return { snap, log, rejected, requests };
}
function artifactCovers(src, day, today) {
  /* the artifact's own horizon: hockey and basketball 72 h, football 8
     days; a day past it is unknown, not empty */
  const lim = src.sports.indexOf('nhl') >= 0 || src.sports.indexOf('nba') >= 0 ? 2 : 7;
  return day >= today && day <= G.addDays(today, lim);
}
function strip(e) {
  const o = {};
  Object.keys(e).forEach((k) => { if (e[k] !== null && e[k] !== undefined && k !== 'doubleheader') o[k] = e[k]; });
  return o;
}
function sortKeys(o) { const r = {}; Object.keys(o).sort().forEach((k) => { r[k] = o[k]; }); return r; }

/* changed beyond its timestamps? */
function material(s) {
  if (!s) return null;
  const c = JSON.parse(JSON.stringify(s));
  delete c.generated_at;
  delete c.run;
  Object.keys(c.buckets || {}).forEach((k) => { delete c.buckets[k].checked_at; });
  return JSON.stringify(c);
}

function report(r, out) {
  const s = r.snap;
  const lines = ['EdgeDesk slate · ' + s.generated_at + ' · window ' + s.window.from_day + ' → ' + s.window.to_day + ' (ET)',
    'events ' + s.counts.events + ' · upcoming ' + s.counts.upcoming + ' · markets ' + s.counts.markets + ' · provider requests ' + s.run.requests + ' · odds refused ' + s.run.odds_rejected];
  Object.keys(s.sports).forEach((k) => {
    const x = s.sports[k];
    const n = s.events.filter((e) => e.sport === k).length;
    lines.push('  ' + k.padEnd(9) + x.state.padEnd(9) + String(n).padStart(4) + ' games · fresh ' + x.days_fresh + ' carried ' + x.days_carried + ' fallback ' + x.days_fallback + ' failed ' + x.days_failed + (x.note ? ' · ' + x.note : ''));
  });
  r.log.slice(0, 20).forEach((l) => lines.push('  ! ' + l));
  const why = {};
  r.rejected.forEach((x) => { why[x.why] = (why[x.why] || 0) + 1; });
  Object.keys(why).slice(0, 10).forEach((k) => lines.push('  odds refused ×' + why[k] + ': ' + k));
  (out || console.log)(lines.join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY) { try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '```\n' + lines.join('\n') + '\n```\n'); } catch (_) { /* summary is optional */ } }
}

async function verify() {
  const today = G.etDay(Date.now());
  let ok = 0, bad = 0;
  for (const f of ESPN.feeds()) {
    const r = await ESPN.readDay(f, ymd(today), {});
    if (r.ok) ok++; else bad++;
    console.log((r.ok ? 'OK   ' : 'FAIL ') + f.key.padEnd(44) + (r.ok ? r.events.length + ' events, ' + Object.keys(r.markets).length + ' priced' : r.error));
  }
  console.log(ok + ' feeds answered, ' + bad + ' did not');
  return bad === 0;
}

async function main() {
  if (has('--verify')) { const ok = await verify(); process.exit(ok ? 0 : 1); }
  const out = arg('--out', OUT);
  const nowArg = arg('--now', null);
  const r = await build({ now: nowArg ? Date.parse(nowArg) : undefined, offline: has('--offline'), force: has('--force'), out });
  report(r);
  if (!has('--write')) { console.log('dry run: nothing written (pass --write)'); return; }
  const prev = readPrev(out);
  if (prev && material(prev) === material(r.snap)) { console.log('unchanged beyond timestamps: ' + path.relative(ROOT, out) + ' not rewritten'); return; }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(r.snap) + '\n');
  console.log('wrote ' + path.relative(ROOT, out) + ' (' + Math.round(fs.statSync(out).size / 1024) + ' KB)');
}

if (require.main === module) main().catch((e) => { console.error(e && e.stack || e); process.exit(1); });

module.exports = { build, material, refreshMin, WINDOW, REFRESH, UPCOMING, feedOfArtifact };
