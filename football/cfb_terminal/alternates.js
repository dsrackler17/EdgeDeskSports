#!/usr/bin/env node
/* ============================================================================
   THE EDGEDESK READ — alternate spreads (opt-in capture).

   The Read prices every captured alternate spread with the same champion
   distribution and the same threshold as the main line (lib/edgedesk_read.js).
   The production capture (supabase/functions/capture) asks The Odds API for
   h2h, spreads and totals only, and the Model Lab's consensus, opener and
   close are built from main lines only. Alternates therefore live in their
   OWN append-only ledger and can never enter a consensus, an opener, a close
   or a governed decision:

     football/cfb_terminal/read/<season>/alternates.jsonl     the quotes
     football/cfb_terminal/read/<season>/alternates_state.json the last run

   The Odds API bills alternate markets per EVENT (markets × regions per
   call; a bookmakers list of up to ten books counts as one region). This
   runner is therefore budgeted and opt-in:
     - it runs only with --network and an ODDS_API_KEY;
     - at most --max-events events per run (default 12), nearest kickoff first,
       inside --window-h hours of kickoff (default 72);
     - at most once every --min-interval-h hours (default 3);
     - one market (alternate_spreads) and one bookmakers list per call.
   It is NOT scheduled. Scheduling it is the owner's decision: it needs an
   ODDS_API_KEY GitHub secret (today the key lives only in the Supabase capture
   function, and tools/games/builder.test.js allows workflows to reference only
   the secrets the repository defines) and it spends Odds API credits. The step
   to add to .github/workflows/cfb-lab.yml, before "Research terminal", is in
   docs/edgedesk-read/DELIVERABLE.md. Until then nothing is spent and the Read
   says "no alternate spread was captured" — never an invented price.

   Event → game: the Model Lab's own name-and-kickoff join
   (supabase/functions/edgedesk_ai/_intelligence.js joinSignalsToGames over
   football/cfb_lab/market.js scheduleGames). A half match is refused.

     node football/cfb_terminal/alternates.js --network [--max-events 12] [--window-h 72]
     node football/cfb_terminal/alternates.js --fixture <event_odds.json> --game <id>   (offline parse, prints)
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const API = 'https://api.the-odds-api.com/v4';
const DEFAULTS = { sport: 'americanfootball_ncaaf', window_h: 72, max_events: 12, min_interval_h: 3,
  bookmakers: 'draftkings,fanduel,betmgm,williamhill_us,espnbet,betrivers,hardrockbet,fanatics' };
/* the same "impossible, not unusual" bounds as football/cfb_lab/integrity.js, widened
   for alternate prices (a +20.5 alternate at -1200 is a real, if expensive, price) */
const B = { SPREAD_ABS_MAX: 70, AMERICAN_ABS_MIN: 100, ALT_PRICE_ABS_MAX: 20000 };

function num(x) { if (x === null || x === undefined || x === '') return null; const n = Number(x); return Number.isFinite(n) ? n : null; }
function iso(t) { const v = typeof t === 'number' ? t : Date.parse(t); return Number.isFinite(v) ? new Date(v).toISOString() : null; }
function sha(x) { return crypto.createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex'); }
function norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, ''); }
function halfPoint(x) { return Number.isFinite(x) && Math.abs(x * 2 - Math.round(x * 2)) < 1e-9; }
function validPrice(a) { return Number.isInteger(a) && Math.abs(a) >= B.AMERICAN_ABS_MIN && Math.abs(a) <= B.ALT_PRICE_ABS_MAX; }

/* ONE event's odds response -> alternate-spread quotes, both sides of each
   number paired by book. A number only one side of was captured stays
   one-sided (the Read marks it lower confidence). Anything that is not a
   possible price is refused and counted, never repaired. */
function parseEventOdds(ev, gameId, observedAt, opts) {
  opts = opts || {};
  const out = { quotes: [], refused: {}, books: 0 };
  const refuse = (why) => { out.refused[why] = (out.refused[why] || 0) + 1; };
  if (!ev || typeof ev !== 'object' || !Array.isArray(ev.bookmakers)) { refuse('no bookmakers array'); return out; }
  const home = ev.home_team, away = ev.away_team;
  for (const bk of ev.bookmakers) {
    if (!bk || !bk.key || !Array.isArray(bk.markets)) { refuse('malformed bookmaker'); continue; }
    out.books++;
    for (const mk of bk.markets) {
      if (!mk || mk.key !== 'alternate_spreads' || !Array.isArray(mk.outcomes)) continue;
      const stamp = iso(mk.last_update || bk.last_update);
      const byNum = new Map();
      for (const o of mk.outcomes) {
        const pt = num(o && o.point), pr = num(o && o.price);
        if (pt === null || pr === null) { refuse('outcome without point or price'); continue; }
        const isHome = norm(o.name) === norm(home), isAway = norm(o.name) === norm(away);
        if (!isHome && !isAway) { refuse('outcome names neither team'); continue; }
        const hl = isHome ? pt : -pt;                         /* the HOME line this outcome belongs to */
        if (!halfPoint(hl)) { refuse('not a half-point line'); continue; }
        if (Math.abs(hl) > B.SPREAD_ABS_MAX) { refuse('spread out of bounds'); continue; }
        if (!validPrice(pr)) { refuse('price not a valid American price'); continue; }
        const k = hl.toFixed(1);
        const row = byNum.get(k) || { home_line: hl, price_home: null, price_away: null };
        if (isHome) { if (row.price_home !== null) { refuse('duplicate outcome'); continue; } row.price_home = pr; }
        else { if (row.price_away !== null) { refuse('duplicate outcome'); continue; } row.price_away = pr; }
        byNum.set(k, row);
      }
      for (const row of byNum.values()) {
        /* two sides of one number paying both above fair is a broken feed, not a market */
        if (row.price_home !== null && row.price_away !== null) {
          const be = (a) => (a < 0 ? -a / (-a + 100) : 100 / (a + 100));
          const s = be(row.price_home) + be(row.price_away);
          if (s < 0.99 || s > 1.3) { refuse('two-way hold out of bounds'); continue; }
        }
        const q = { game_id: gameId != null ? String(gameId) : null, season: opts.season || null, source: 'odds_api', provider_event_id: ev.id || null,
          book: bk.key, market_type: 'spread', alternate: true, home_line: row.home_line, price_home: row.price_home, price_away: row.price_away,
          observed_at: observedAt, provider_updated_at: stamp, kickoff_ts: iso(ev.commence_time), home_team: home, away_team: away, is_pregame: true };
        q.fingerprint = sha([q.game_id, q.book, q.home_line, q.price_home, q.price_away]).slice(0, 24);
        q.quote_id = 'edra_' + sha([q.game_id, q.book, q.home_line, q.price_home, q.price_away, q.observed_at]).slice(0, 24);
        out.quotes.push(q);
      }
    }
  }
  return out;
}

/* append only what changed: the latest stored fingerprint per (game, book, number) */
function selectNew(stored, quotes) {
  const last = new Map();
  stored.slice().sort((a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at))
    .forEach((q) => last.set(q.game_id + '|' + q.book + '|' + q.home_line, q.fingerprint));
  return quotes.filter((q) => last.get(q.game_id + '|' + q.book + '|' + q.home_line) !== q.fingerprint);
}

function ledgerPaths(season) {
  const dir = path.join(ROOT, 'football', 'cfb_terminal', 'read', String(season));
  return { dir, quotes: path.join(dir, 'alternates.jsonl'), state: path.join(dir, 'alternates_state.json') };
}
function readJsonl(p) { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean) : []; }

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  const remaining = res.headers.get('x-requests-remaining');
  if (!res.ok) throw Object.assign(new Error('HTTP ' + res.status + ' ' + url.replace(/apiKey=[^&]+/, 'apiKey=***')), { status: res.status, remaining });
  return { body: await res.json(), remaining };
}

async function run(opts) {
  const now = opts.now || Date.now(), key = opts.key;
  const nd = new Date(now), season = opts.season || (nd.getUTCMonth() <= 1 ? nd.getUTCFullYear() - 1 : nd.getUTCFullYear());
  const P = ledgerPaths(season);
  const state = fs.existsSync(P.state) ? JSON.parse(fs.readFileSync(P.state, 'utf8')) : {};
  if (!key) return { skipped: 'no ODDS_API_KEY: nothing captured, nothing spent' };
  if (state.last_run && now - Date.parse(state.last_run) < opts.min_interval_h * 3600e3) return { skipped: 'ran ' + state.last_run + ' (every ' + opts.min_interval_h + ' h at most)' };
  const MK = require(path.join(ROOT, 'football', 'cfb_lab', 'market.js'));
  const INTEL = require(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', '_intelligence.js'));
  /* the event index is free: it costs no credit */
  const ev = await getJson(API + '/sports/' + opts.sport + '/events?apiKey=' + encodeURIComponent(key) + '&dateFormat=iso');
  const soon = (ev.body || []).filter((e) => { const t = Date.parse(e.commence_time); return t > now && t - now <= opts.window_h * 3600e3; });
  const join = INTEL.joinSignalsToGames({ signals: soon.map((e) => ({ provider_event_id: e.id, home_team: e.home_team, away_team: e.away_team, commence_time: e.commence_time })), games: MK.scheduleGames(season) });
  const pairs = [];
  Object.keys(join.by_game || {}).forEach((gid) => (join.by_game[gid] || []).forEach((s) => pairs.push({ game_id: gid, event: soon.find((e) => e.id === s.provider_event_id) })));
  pairs.sort((a, b) => Date.parse(a.event.commence_time) - Date.parse(b.event.commence_time));
  const take = pairs.slice(0, opts.max_events);
  const observedAt = new Date(now).toISOString(), all = [], refused = {};
  let remaining = ev.remaining, calls = 0;
  for (const p of take) {
    try {
      const r = await getJson(API + '/sports/' + opts.sport + '/events/' + encodeURIComponent(p.event.id) + '/odds?apiKey=' + encodeURIComponent(key)
        + '&markets=alternate_spreads&bookmakers=' + encodeURIComponent(opts.bookmakers) + '&oddsFormat=american&dateFormat=iso');
      calls++; remaining = r.remaining;
      const parsed = parseEventOdds(r.body, p.game_id, observedAt, { season });
      all.push(...parsed.quotes);
      Object.keys(parsed.refused).forEach((k) => { refused[k] = (refused[k] || 0) + parsed.refused[k]; });
    } catch (e) {
      if (e.status === 429 || e.status === 401) { refused['quota or key: ' + e.status] = 1; break; }
      refused['event failed: ' + (e.status || 'network')] = (refused['event failed: ' + (e.status || 'network')] || 0) + 1;
    }
  }
  const fresh = selectNew(readJsonl(P.quotes), all);
  const summary = { season, events_in_window: soon.length, events_joined: pairs.length, events_priced: calls, join_refused: join.signals_refused || 0,
    quotes: all.length, written: fresh.length, refused, requests_remaining: remaining, last_run: observedAt };
  if (!opts.dry_run) {
    fs.mkdirSync(P.dir, { recursive: true });
    if (fresh.length) fs.appendFileSync(P.quotes, fresh.map((q) => JSON.stringify(q)).join('\n') + '\n');
    fs.writeFileSync(P.state, JSON.stringify(summary, null, 1) + '\n');
  }
  return summary;
}

module.exports = { parseEventOdds, selectNew, ledgerPaths, run, DEFAULTS };

if (require.main === module) {
  const a = process.argv.slice(2);
  const arg = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
  const flag = (k) => a.indexOf('--' + k) >= 0;
  if (arg('fixture')) {
    const ev = JSON.parse(fs.readFileSync(path.resolve(arg('fixture')), 'utf8'));
    console.log(JSON.stringify(parseEventOdds(ev, arg('game', null), new Date().toISOString()), null, 1));
  } else if (!flag('network')) {
    console.log('[read alternates] offline: pass --network (and ODDS_API_KEY) to capture; nothing spent.');
  } else {
    run({ key: process.env.ODDS_API_KEY || null, sport: arg('sport', DEFAULTS.sport), window_h: Number(arg('window-h', DEFAULTS.window_h)),
      max_events: Number(arg('max-events', DEFAULTS.max_events)), min_interval_h: Number(arg('min-interval-h', DEFAULTS.min_interval_h)),
      bookmakers: arg('bookmakers', process.env.READ_ALT_BOOKMAKERS || DEFAULTS.bookmakers), dry_run: flag('dry-run') })
      .then((s) => console.log('[read alternates]', JSON.stringify(s)))
      .catch((e) => { console.error('[read alternates] failed:', e.message); process.exit(0); });   /* fail soft: the Read says none captured */
  }
}
