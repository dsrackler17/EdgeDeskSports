#!/usr/bin/env node
'use strict';
/* ===========================================================================
   BROADCAST LISTINGS — football/broadcasts/current.json
   docs/content-engine/GAMES_TO_WATCH.md §Broadcasts

   One request per day of the current week to ESPN's public, keyless
   scoreboard (the same feed the schedule already comes from), through the
   shared recovery layer: a timeout, retries on transient failures only, a
   per-host breaker and a request budget. No key, no subscription, no cost.

   What it records, per game: the national TV and streaming outlets and the
   regional ones by market, the time ESPN carries and whether that time is
   valid (TBA), the game status (postponed and canceled included) and the
   venue — and nothing it did not read. lib/edgedesk_broadcast.js decides
   what that listing is worth: an ESPN-operated network is the rights
   holder's own listing; any other network is LISTED and held until the
   owner verifies it from an official source in /admin/content/.

   A FETCH THAT FAILS ERASES NOTHING. The previous listing is kept with its
   real retrieval time, so a stale listing ages out of the publication window
   (EDBroadcast.fresh) rather than being replaced by a blank.

   CHANGES ARE KEPT. When a listing's network, time or status differs from
   the previous one (flex scheduling, a weather move, a regional split), the
   change is appended to `changes` with both values and both times.

   Usage: node football/broadcasts/collect.js [--week N] [--check]
   =========================================================================== */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const B = require(path.join(ROOT, 'lib', 'edgedesk_broadcast.js'));
const R = require(path.join(ROOT, 'football', 'data', 'recovery.js'));

const OUT = path.join(__dirname, 'current.json');
const SCHEMA = 'edgedesk_broadcast_listings_v1';
const ENDPOINT = 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard';
/* FBS (ESPN group 80); one day per request keeps every payload small */
function urlFor(day) { return ENDPOINT + '?groups=80&limit=300&dates=' + day; }

const ET_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
function readJson(f, fallback) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return fallback; } }

/* the week's game ids and the US calendar days they fall on */
function weekPlan(terminal, now, week) {
  const games = terminal && terminal.games ? Object.values(terminal.games) : [];
  if (week == null) {
    const up = games.filter((g) => Date.parse(g.kickoff) > now).sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff));
    week = up.length ? up[0].week : null;
  }
  const wk = games.filter((g) => g.week === week);
  const days = {};
  wk.forEach((g) => {
    const t = Date.parse(g.kickoff); if (!isFinite(t)) return;
    /* ESPN's dates are Eastern calendar days (a 10:30 PM ET kickoff is the
       next UTC day), taken with the zone's own DST rules */
    const d = ET_DAY.format(new Date(t)).replace(/-/g, '');
    days[d] = 1;
  });
  return { week, ids: wk.map((g) => String(g.game_id)), days: Object.keys(days).sort() };
}

/* what about a listing counts as a change */
function signature(l) {
  if (!l) return null;
  const nat = (l.outlets || []).filter((o) => !o.market || o.market === 'national').map((o) => o.network + '/' + (o.type || '')).sort().join(',');
  const reg = (l.outlets || []).filter((o) => o.market && o.market !== 'national').map((o) => o.network + '@' + o.market).sort().join(',');
  return [nat, reg, l.kickoff, l.time_valid, l.status].join('|');
}

function merge(prev, fresh, ids, retrievedAt) {
  const listings = Object.assign({}, prev && prev.listings ? prev.listings : {});
  const changes = (prev && prev.changes ? prev.changes : []).slice(-500);
  ids.forEach((id) => {
    const f = fresh[id];
    if (!f) return;
    const p = listings[id];
    if (p && signature(p) !== signature(f)) {
      changes.push({ game_id: id, detected_at: retrievedAt, from: { outlets: p.outlets, kickoff: p.kickoff, time_valid: p.time_valid, status: p.status, retrieved_at: p.retrieved_at },
        to: { outlets: f.outlets, kickoff: f.kickoff, time_valid: f.time_valid, status: f.status, retrieved_at: f.retrieved_at } });
    }
    listings[id] = f;
  });
  return { listings, changes };
}

async function collect(opts) {
  opts = opts || {};
  const now = opts.now != null ? opts.now : Date.now();
  const terminal = opts.terminal || readJson(path.join(ROOT, 'football', 'cfb_terminal', 'games.json'), null);
  const prev = opts.previous !== undefined ? opts.previous : readJson(OUT, null);
  const plan = weekPlan(terminal, now, opts.week);
  const sess = R.session({ fetch: opts.fetch || null, budget_requests: 12, timeout_ms: 20000, retries: 2 });
  const fetches = [], fresh = {};
  for (const day of plan.days) {
    const url = urlFor(day);
    const r = await sess.get(url);
    fetches.push({ day, url, ok: r.ok, status: r.status, error: r.error || null, retrieved_at: r.retrieved_at });
    if (!r.ok) continue;
    let payload = null;
    try { payload = JSON.parse(r.text); } catch (e) { fetches[fetches.length - 1].error = 'not JSON'; continue; }
    Object.assign(fresh, B.parseEspnScoreboard(payload, r.retrieved_at, url));
  }
  const merged = merge(prev, fresh, plan.ids, new Date(now).toISOString());
  const covered = plan.ids.filter((id) => fresh[id]).length;
  return {
    schema: SCHEMA, version: B.VERSION, generated_at: new Date(now).toISOString(), week: plan.week,
    source: { name: 'ESPN scoreboard', url: ENDPOINT, tier: 'public, keyless', cost: 'none' },
    rule: 'A listing is what ESPN’s scoreboard carried at retrieved_at; it is verified by lib/edgedesk_broadcast.js and printed only when CONFIRMED and fresh. A failed fetch keeps the previous listing with its real retrieval time.',
    fetches, coverage: { games: plan.ids.length, refreshed: covered, kept_from_previous: plan.ids.filter((id) => !fresh[id] && merged.listings[id]).length },
    listings: Object.fromEntries(plan.ids.filter((id) => merged.listings[id]).map((id) => [id, merged.listings[id]])),
    changes: merged.changes
  };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const wi = args.indexOf('--week');
  collect({ week: wi >= 0 ? +args[wi + 1] : undefined }).then((doc) => {
    const line = 'football/broadcasts/current.json — week ' + doc.week + ': ' + doc.coverage.refreshed + ' of ' + doc.coverage.games + ' listings refreshed, '
      + doc.coverage.kept_from_previous + ' kept from the previous run; fetches ' + doc.fetches.map((f) => f.day + ':' + (f.ok ? 'ok' : f.error)).join(' ');
    if (args.indexOf('--check') >= 0) { console.log(line); return; }
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(doc, null, 1) + '\n');
    console.log(line);
  }).catch((e) => { console.error('broadcast collect failed: ' + (e && e.message || e)); process.exit(1); });
}

module.exports = { collect, merge, signature, weekPlan, urlFor, SCHEMA, OUT, ENDPOINT };
