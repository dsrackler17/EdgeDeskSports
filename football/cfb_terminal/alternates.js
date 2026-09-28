#!/usr/bin/env node
/* ============================================================================
   THE EDGEDESK READ — alternate spreads (opt-in capture), CFB and NFL.

   The Read and the quote-level EV engine (lib/edgedesk_quote_ev.js) price every
   captured alternate spread with the same model distribution and the same
   threshold as the main line. The production capture (supabase/functions/capture)
   asks The Odds API for h2h, spreads and totals only, and the Model Lab's
   consensus, opener and close are built from main lines only. Alternates
   therefore live in their OWN append-only ledger and can never enter a
   consensus, an opener, a close or a governed decision:

     CFB  football/cfb_terminal/read/<season>/alternates.jsonl      the quotes (build.js reads it)
          football/cfb_terminal/read/<season>/alternates_state.json the last run
     NFL  football/markets/ledger/nfl/<season>/alternates.jsonl
          football/markets/ledger/nfl/<season>/alternates_state.json
     both football/markets/alternates_<cfb|nfl>.json                 the browser feed (app.html)

   PROVIDER SUPPORT (audited). The Odds API serves `alternate_spreads` (and
   `alternate_totals`) only from the per-event endpoint
   /v4/sports/{sport}/events/{eventId}/odds; the bulk /odds endpoint rejects
   them. There is no batch call for alternates: one request per event. The
   cost is markets × regions per call, and a bookmakers list of up to ten
   books counts as one region, so one event with alternate_spreads costs 1
   credit. The event index (/events) is free. Alternate totals are NOT
   requested: no totals probability is validated, so EdgeDesk would only
   store prices it cannot evaluate.

   CONTROLS. The runner is budgeted and opt-in:
     - it runs only with --network and an ODDS_API_KEY;
     - --league cfb|nfl picks the sport key (americanfootball_ncaaf / _nfl);
     - only games that have not kicked off and start inside --window-h hours
       (default 72), nearest kickoff first, at most --max-events (default 12);
     - at most once every --min-interval-h hours (default 3) per league: the
       clock advances only after a run that priced at least one event, so a
       run where every call failed does not lock the next one out;
     - it stops before spending when the provider reports fewer than
       --min-remaining credits (default 25), and at once on a 401 or 429;
     - one market (alternate_spreads) and one bookmakers list per call;
     - change-only persistence: a (game, book, number) is appended only when
       its prices changed since the last stored row;
     - dedup: a duplicated outcome is refused, never averaged.
   Scheduling is the owner's decision (.github/workflows/cfb-lab.yml runs it
   only when the repository variable READ_ALT_CAPTURE is 'on' and an
   ODDS_API_KEY secret exists). Until then nothing is spent and every surface
   says "Alternate spread pricing is not captured yet" — never an invented
   price.

   Event → game (CFB): the Model Lab's own name-and-kickoff join
   (supabase/functions/edgedesk_ai/_intelligence.js joinSignalsToGames over
   football/cfb_lab/market.js scheduleGames). A half match is refused. NFL
   quotes are keyed by the provider event id, the same id the captured board
   (signals.event_id) carries, which is how app.html joins them.

     node football/cfb_terminal/alternates.js --network [--league cfb|nfl] [--max-events 12] [--window-h 72]
     node football/cfb_terminal/alternates.js --feed-only [--league cfb|nfl]   (rebuild the browser feed from the ledger)
     node football/cfb_terminal/alternates.js --fixture <event_odds.json> --game <id>   (offline parse, prints)
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const API = 'https://api.the-odds-api.com/v4';
const LEAGUES = {
  cfb: { sport: 'americanfootball_ncaaf', join: true },
  nfl: { sport: 'americanfootball_nfl', join: false },
};
const DEFAULTS = { league: 'cfb', sport: LEAGUES.cfb.sport, window_h: 72, max_events: 12, min_interval_h: 3, min_remaining: 25,
  bookmakers: 'draftkings,fanduel,betmgm,williamhill_us,espnbet,betrivers,hardrockbet,fanatics' };
const FEED_SCHEMA = 'edgedesk_alternates_feed_v1';
/* the same "impossible, not unusual" bounds as football/cfb_lab/integrity.js, widened
   for alternate prices (a +20.5 alternate at -1200 is a real, if expensive, price) */
const B = { SPREAD_ABS_MAX: 70, AMERICAN_ABS_MIN: 100, ALT_PRICE_ABS_MAX: 20000 };

function num(x) { if (x === null || x === undefined || x === '') return null; const n = Number(x); return Number.isFinite(n) ? n : null; }
function iso(t) { const v = typeof t === 'number' ? t : Date.parse(t); return Number.isFinite(v) ? new Date(v).toISOString() : null; }
function sha(x) { return crypto.createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex'); }
function norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, ''); }
function halfPoint(x) { return Number.isFinite(x) && Math.abs(x * 2 - Math.round(x * 2)) < 1e-9; }
function validPrice(a) { return Number.isInteger(a) && Math.abs(a) >= B.AMERICAN_ABS_MIN && Math.abs(a) <= B.ALT_PRICE_ABS_MAX; }
function leagueOf(x) { const k = String(x || 'cfb').toLowerCase(); if (!LEAGUES[k]) throw new Error('unknown league ' + x + ' (cfb or nfl)'); return k; }
/* the game a quote belongs to: the schedule id when joined (CFB), else the provider event */
function gameKey(q) { return q.game_id != null ? String(q.game_id) : 'ev:' + (q.provider_event_id || ''); }

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
        if (opts.league) q.league = opts.league;
        const gk = q.game_id != null ? q.game_id : 'ev:' + q.provider_event_id;
        q.fingerprint = sha([gk, q.book, q.home_line, q.price_home, q.price_away]).slice(0, 24);
        q.quote_id = 'edra_' + sha([gk, q.book, q.home_line, q.price_home, q.price_away, q.observed_at]).slice(0, 24);
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
    .forEach((q) => last.set(gameKey(q) + '|' + q.book + '|' + q.home_line, q.fingerprint));
  return quotes.filter((q) => last.get(gameKey(q) + '|' + q.book + '|' + q.home_line) !== q.fingerprint);
}

function ledgerPaths(season, league) {
  const lg = leagueOf(league);
  const dir = lg === 'cfb' ? path.join(ROOT, 'football', 'cfb_terminal', 'read', String(season))
    : path.join(ROOT, 'football', 'markets', 'ledger', lg, String(season));
  return { dir, quotes: path.join(dir, 'alternates.jsonl'), state: path.join(dir, 'alternates_state.json'),
    feed: path.join(ROOT, 'football', 'markets', 'alternates_' + lg + '.json') };
}
function readJsonl(p) { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean) : []; }
function readJson(p) { try { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null; } catch (e) { return null; } }

/* ------------------------------------------------------------ browser feed
   football/markets/alternates_<league>.json: the CURRENT alternate board per
   upcoming event, one quote per (book, side, number), each side stated in its
   own team's terms (point = that side's line). Only captured prices appear.

   Time is stated honestly. An event polled in a run carries that run's time
   as `observed_at` (every listed quote was present at that poll) and each
   quote its `first_seen_at` at this exact price; a number the book pulled is
   gone from the event. An event not polled this run keeps its last listing
   and its own older time, so it ages into STALE on the page rather than
   looking fresh. Rebuilt from the ledger alone (--feed-only), a quote carries
   only the time its price was last stored: never a later one. */
function sideQuotes(row, firstSeen) {
  const out = [];
  [['home', row.home_team, row.home_line, row.price_home], ['away', row.away_team, -row.home_line, row.price_away]].forEach(([side, team, point, price]) => {
    if (price === null || price === undefined) return;
    out.push({ side, selection: team || null, point: point === 0 ? 0 : point, price_american: price, book: row.book,
      first_seen_at: firstSeen || row.observed_at || null, provider_updated_at: row.provider_updated_at || null,
      quote_id: (row.quote_id || 'edra_' + sha([gameKey(row), row.book, row.home_line, row.observed_at]).slice(0, 24)) + ':' + side });
  });
  return out;
}
function sortQuotes(qs) {
  return qs.sort((a, b) => (a.side < b.side ? -1 : a.side > b.side ? 1 : 0) || a.point - b.point || (a.book < b.book ? -1 : a.book > b.book ? 1 : 0));
}
function eventShell(q) {
  return { event_id: q.provider_event_id || null, game_id: q.game_id != null ? String(q.game_id) : null, home_team: q.home_team || null,
    away_team: q.away_team || null, commence_time: q.kickoff_ts || null, observed_at: null, books: [], quotes: [] };
}
/* the ledger's latest row per (game, book, number), with the time its current
   price was first stored */
function ledgerLatest(rows) {
  const last = new Map(), first = new Map();
  rows.slice().sort((a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at)).forEach((q) => {
    const k = gameKey(q) + '|' + q.book + '|' + q.home_line, prev = last.get(k);
    if (!prev || prev.fingerprint !== q.fingerprint) first.set(k, q.observed_at);
    last.set(k, q);
  });
  return { last, first };
}
function buildFeed(o) {
  const lg = leagueOf(o.league), now = o.now != null ? o.now : Date.now();
  const upcoming = (t) => { const v = Date.parse(t); return Number.isFinite(v) && v > now; };
  const events = {};
  const L = ledgerLatest(o.ledger || []);
  if (o.prior && o.prior.schema === FEED_SCHEMA && o.prior.events && !o.rebuild) {
    Object.keys(o.prior.events).forEach((id) => { const e = o.prior.events[id]; if (e && upcoming(e.commence_time)) events[id] = e; });
  } else {
    /* no prior listing: the ledger's latest price per number, at its own stored time */
    L.last.forEach((row, k) => {
      if (!row.provider_event_id || !upcoming(row.kickoff_ts)) return;
      const e = events[row.provider_event_id] || (events[row.provider_event_id] = eventShell(row));
      sideQuotes(row, L.first.get(k)).forEach((sq) => { sq.observed_at = row.observed_at; e.quotes.push(sq); });
    });
  }
  /* the events this run polled: their listing is exactly what the book showed now */
  const run = o.run || null;
  if (run && Array.isArray(run.polled)) {
    run.polled.forEach((id) => {
      const qs = (run.quotes || []).filter((q) => q.provider_event_id === id);
      const base = qs[0] || (run.events && run.events[id]) || null;
      if (!base) { delete events[id]; return; }
      const e = eventShell(base);
      e.observed_at = run.observed_at;
      qs.forEach((q) => {
        const k = gameKey(q) + '|' + q.book + '|' + q.home_line, prev = L.last.get(k);
        const firstSeen = prev && prev.fingerprint === q.fingerprint ? (L.first.get(k) || prev.observed_at) : q.observed_at;
        sideQuotes(q, firstSeen).forEach((sq) => e.quotes.push(sq));
      });
      if (upcoming(e.commence_time)) events[id] = e; else delete events[id];
    });
  }
  let nq = 0;
  Object.keys(events).forEach((id) => {
    const e = events[id];
    /* one quote per (book, side, number): a duplicate is dropped, never averaged */
    const seen = new Set();
    e.quotes = sortQuotes((e.quotes || []).filter((q) => { const k = q.book + '|' + q.side + '|' + q.point; if (seen.has(k)) return false; seen.add(k); return true; }));
    e.books = Array.from(new Set(e.quotes.map((q) => q.book))).sort();
    nq += e.quotes.length;
  });
  return { schema: FEED_SCHEMA, league: lg, sport: LEAGUES[lg].sport, provider: 'the-odds-api', market: 'alternate_spreads',
    generated_at: new Date(now).toISOString(), window_h: o.window_h != null ? o.window_h : null, bookmakers: o.bookmakers || null,
    n_events: Object.keys(events).length, n_quotes: nq,
    why: 'captured alternate-spread quotes only, both sides stated in their own team\'s terms. An event\'s observed_at is its last successful poll; an event not polled since ages into STALE. No alternate line or price is ever manufactured.',
    events };
}
function writeFeed(file, feed) {
  const prev = readJson(file);
  /* change-only: an identical listing is not rewritten just to move generated_at */
  const strip = (f) => f ? JSON.stringify(Object.assign({}, f, { generated_at: null })) : null;
  if (prev && strip(prev) === strip(feed)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(feed) + '\n');
  return true;
}

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  const remaining = num(res.headers.get('x-requests-remaining')), last = num(res.headers.get('x-requests-last'));
  if (!res.ok) throw Object.assign(new Error('HTTP ' + res.status + ' ' + url.replace(/apiKey=[^&]+/, 'apiKey=***')), { status: res.status, remaining });
  return { body: await res.json(), remaining, last };
}

function seasonOf(now) {
  /* January and February belong to the season that started the previous
     August (CFB bowls, the NFL playoffs) */
  const nd = new Date(now);
  return nd.getUTCMonth() <= 1 ? nd.getUTCFullYear() - 1 : nd.getUTCFullYear();
}

async function run(opts) {
  const now = opts.now || Date.now(), key = opts.key, league = leagueOf(opts.league), L = LEAGUES[league];
  const sport = opts.sport || L.sport;
  const season = opts.season || seasonOf(now);
  const P = opts.paths || ledgerPaths(season, league);
  const state = readJson(P.state) || {};
  const getter = opts.getJson || getJson;
  if (!key) return { league, skipped: 'no ODDS_API_KEY: nothing captured, nothing spent' };
  if (state.last_run && now - Date.parse(state.last_run) < opts.min_interval_h * 3600e3) return { league, skipped: 'ran ' + state.last_run + ' (every ' + opts.min_interval_h + ' h at most)' };
  const attemptAt = new Date(now).toISOString();
  /* the event index is free: it costs no credit */
  let ev;
  try { ev = await getter(API + '/sports/' + sport + '/events?apiKey=' + encodeURIComponent(key) + '&dateFormat=iso'); }
  catch (e) {
    const s = Object.assign({}, state, { league, last_attempt: attemptAt, last_error: 'event index failed: ' + (e.status || 'network') });
    if (!opts.dry_run) { fs.mkdirSync(P.dir, { recursive: true }); fs.writeFileSync(P.state, JSON.stringify(s, null, 1) + '\n'); }
    return Object.assign({ skipped: s.last_error }, s);
  }
  const soon = (ev.body || []).filter((e) => { const t = Date.parse(e.commence_time); return t > now && t - now <= opts.window_h * 3600e3; });
  const pairs = [];
  let joinRefused = 0;
  if (L.join) {
    const MK = opts.market || require(path.join(ROOT, 'football', 'cfb_lab', 'market.js'));
    const INTEL = opts.intel || require(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', '_intelligence.js'));
    const join = INTEL.joinSignalsToGames({ signals: soon.map((e) => ({ provider_event_id: e.id, home_team: e.home_team, away_team: e.away_team, commence_time: e.commence_time })), games: MK.scheduleGames(season) });
    Object.keys(join.by_game || {}).forEach((gid) => (join.by_game[gid] || []).forEach((s) => pairs.push({ game_id: gid, event: soon.find((e) => e.id === s.provider_event_id) })));
    joinRefused = join.signals_refused || 0;
  } else {
    soon.forEach((e) => pairs.push({ game_id: null, event: e }));
  }
  pairs.sort((a, b) => Date.parse(a.event.commence_time) - Date.parse(b.event.commence_time));
  const take = pairs.slice(0, opts.max_events);
  const observedAt = attemptAt, all = [], refused = {}, polled = [], evInfo = {};
  let remaining = ev.remaining, calls = 0, stopped = null;
  for (const p of take) {
    if (remaining != null && opts.min_remaining != null && remaining < opts.min_remaining) { stopped = 'credits below floor (' + remaining + ' < ' + opts.min_remaining + ')'; break; }
    try {
      const r = await getter(API + '/sports/' + sport + '/events/' + encodeURIComponent(p.event.id) + '/odds?apiKey=' + encodeURIComponent(key)
        + '&markets=alternate_spreads&bookmakers=' + encodeURIComponent(opts.bookmakers) + '&oddsFormat=american&dateFormat=iso');
      calls++; if (r.remaining != null) remaining = r.remaining;
      const parsed = parseEventOdds(r.body, p.game_id, observedAt, { season, league });
      all.push(...parsed.quotes);
      polled.push(p.event.id);
      evInfo[p.event.id] = { provider_event_id: p.event.id, game_id: p.game_id, home_team: p.event.home_team, away_team: p.event.away_team, kickoff_ts: iso(p.event.commence_time) };
      Object.keys(parsed.refused).forEach((k) => { refused[k] = (refused[k] || 0) + parsed.refused[k]; });
    } catch (e) {
      if (e.status === 429 || e.status === 401) { refused['quota or key: ' + e.status] = 1; stopped = 'provider refused: ' + e.status; break; }
      refused['event failed: ' + (e.status || 'network')] = (refused['event failed: ' + (e.status || 'network')] || 0) + 1;
    }
  }
  const stored = readJsonl(P.quotes);
  const fresh = selectNew(stored, all);
  /* the budget clock moves only when a run actually priced an event */
  const summary = { league, sport, season, events_in_window: soon.length, events_joined: pairs.length, events_priced: calls, join_refused: joinRefused,
    quotes: all.length, written: fresh.length, refused, stopped, requests_remaining: remaining,
    last_attempt: attemptAt, last_run: calls > 0 ? observedAt : (state.last_run || null) };
  if (!opts.dry_run) {
    fs.mkdirSync(P.dir, { recursive: true });
    if (fresh.length) fs.appendFileSync(P.quotes, fresh.map((q) => JSON.stringify(q)).join('\n') + '\n');
    fs.writeFileSync(P.state, JSON.stringify(summary, null, 1) + '\n');
    const feed = buildFeed({ league, now, prior: readJson(P.feed), ledger: stored.concat(fresh), window_h: opts.window_h, bookmakers: opts.bookmakers,
      run: { polled, quotes: all, observed_at: observedAt, events: evInfo } });
    summary.feed_written = writeFeed(P.feed, feed);
    summary.feed_events = feed.n_events;
  }
  return summary;
}

/* rebuild the browser feed from the stored ledger (no network, nothing spent) */
function feedOnly(opts) {
  const now = opts.now || Date.now(), league = leagueOf(opts.league);
  const season = opts.season || seasonOf(now), P = opts.paths || ledgerPaths(season, league);
  const feed = buildFeed({ league, now, ledger: readJsonl(P.quotes), rebuild: true, window_h: null, bookmakers: null });
  const written = opts.dry_run ? false : writeFeed(P.feed, feed);
  return { league, season, feed: path.relative(ROOT, P.feed), events: feed.n_events, quotes: feed.n_quotes, written, feed_json: feed };
}

module.exports = { parseEventOdds, selectNew, ledgerPaths, buildFeed, writeFeed, ledgerLatest, feedOnly, run, DEFAULTS, LEAGUES, FEED_SCHEMA };

if (require.main === module) {
  const a = process.argv.slice(2);
  const arg = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
  const flag = (k) => a.indexOf('--' + k) >= 0;
  const league = arg('league', DEFAULTS.league);
  if (arg('fixture')) {
    const ev = JSON.parse(fs.readFileSync(path.resolve(arg('fixture')), 'utf8'));
    console.log(JSON.stringify(parseEventOdds(ev, arg('game', null), new Date().toISOString(), { league }), null, 1));
  } else if (flag('feed-only')) {
    console.log('[read alternates]', JSON.stringify(feedOnly({ league, dry_run: flag('dry-run') })));
  } else if (!flag('network')) {
    console.log('[read alternates] offline: pass --network (and ODDS_API_KEY) to capture; nothing spent.');
  } else {
    run({ key: process.env.ODDS_API_KEY || null, league, sport: arg('sport', null), window_h: Number(arg('window-h', DEFAULTS.window_h)),
      max_events: Number(arg('max-events', DEFAULTS.max_events)), min_interval_h: Number(arg('min-interval-h', DEFAULTS.min_interval_h)),
      min_remaining: Number(arg('min-remaining', DEFAULTS.min_remaining)),
      bookmakers: arg('bookmakers', process.env.READ_ALT_BOOKMAKERS || DEFAULTS.bookmakers), dry_run: flag('dry-run') })
      .then((s) => console.log('[read alternates]', JSON.stringify(s)))
      .catch((e) => { console.error('[read alternates] failed:', e.message); process.exit(0); });   /* fail soft: the page says none captured */
  }
}
