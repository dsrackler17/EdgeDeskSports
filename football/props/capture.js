#!/usr/bin/env node
/* ============================================================================
   PLAYER PROPS — sportsbook prop capture (The Odds API, per-event endpoint).

   Player markets exist only on /v4/sports/{sport}/events/{eventId}/odds (the
   bulk /odds endpoint rejects them), one request per event, billed markets ×
   regions (a bookmakers list of up to ten books is one region). The event
   index is free. So the runner is BUDGETED and OPT-IN, on the pattern of
   football/cfb_terminal/alternates.js:

     - it runs only with --network and ODDS_API_KEY (the scheduled workflow
       runs it only when the repository variable PROPS_CAPTURE is 'on');
     - only events that have not kicked off and start inside --window-h hours,
       nearest kickoff first, at most --max-events;
     - each event on its own clock: beyond --far-h hours of its kickoff at most
       every --far-interval-h hours, inside it every --min-interval-h, and
       inside six hours every --near-interval-h (the hourly schedule makes that
       hourly in practice);
     - it stops before spending when the provider reports fewer than
       --min-remaining credits, before a run would pass --max-credits, and at
       once on a 401 or 429;
     - change-only persistence; a duplicated outcome is refused, never averaged;
       an impossible price is refused and counted, never repaired.

   WHAT IT WRITES (all under football/props/<league>/)
     quotes.json        the CURRENT listing per event: every (book, market,
                        player, side, line) price with the provider's own
                        update time and EdgeDesk's capture time. An event not
                        polled this run keeps its last listing and ages into
                        STALE on the page — it is never re-stamped as fresh.
     lines.json         movement for upcoming events: per (player, market,
                        book) the main number's change-only series
                        [capture time, line, over, under], and each alternate
                        rung's first and latest price
     capture_state.json the last run: spend, remaining credits, refusals

   Identity: a quote is (sport, event → game, player, market, line, side, book,
   quoted_at). The player is named by the book (`description`); the board
   resolves the name to one player id within the two teams of the event, or
   marks it UNMAPPED — it never guesses.

     node football/props/capture.js --network [--league nfl|cfb] [--groups core,long,alt] [--max-events 16]
     node football/props/capture.js --fixture <event_odds.json> [--league nfl]     (offline parse, prints)
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const C = require('./config.js');
const EDP = require(path.join(C.ROOT, 'lib', 'edgedesk_props.js'));

const API = 'https://api.the-odds-api.com/v4';
const QUOTES_SCHEMA = 'edgedesk_player_props_quotes_v1';
const LINES_SCHEMA = 'edgedesk_player_props_lines_v1';
const MAX_SERIES = 48;

function iso(t) { const v = typeof t === 'number' ? t : Date.parse(t); return Number.isFinite(v) ? new Date(v).toISOString() : null; }
function readJson(p) { try { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null; } catch (e) { return null; } }
function num(x) { if (x === null || x === undefined || x === '') return null; const n = Number(x); return Number.isFinite(n) ? n : null; }

/* ONE event's odds response → prop quotes. Each outcome must name a player
   (description), a side (Over/Under/Yes/No), a price, and — except Yes/No
   markets — a line. */
function parseEventProps(ev, observedAt) {
  const out = { quotes: [], refused: {}, books: [], markets: {} };
  const refuse = (why) => { out.refused[why] = (out.refused[why] || 0) + 1; };
  if (!ev || typeof ev !== 'object' || !Array.isArray(ev.bookmakers)) { refuse('no bookmakers array'); return out; }
  const seen = new Set();
  for (const bk of ev.bookmakers) {
    if (!bk || !bk.key || !Array.isArray(bk.markets)) { refuse('malformed bookmaker'); continue; }
    out.books.push(bk.key);
    for (const mk of bk.markets) {
      if (!mk || !Array.isArray(mk.outcomes)) { refuse('malformed market'); continue; }
      const pm = EDP.providerMarket(mk.key);
      if (!pm) { refuse('market not in the registry: ' + mk.key); continue; }
      const mdef = EDP.MARKETS[pm.market];
      const stamp = iso(mk.last_update || bk.last_update);
      for (const o of mk.outcomes) {
        const player = o && (o.description || o.participant || null);
        const side = EDP.sideOf(o && o.name);
        const price = num(o && o.price);
        let line = num(o && o.point);
        if (!player) { refuse('outcome names no player'); continue; }
        if (!side) { refuse('side is not over/under/yes/no'); continue; }
        if (mdef.yesno) { if (line == null) line = 0.5; if (line !== 0.5) { refuse('yes/no market with a line other than 0.5'); continue; } }
        if (line == null) { refuse('outcome without a line'); continue; }
        if (line < 0 || Math.abs(line * 2 - Math.round(line * 2)) > 1e-9) { refuse('line not a non-negative half point'); continue; }
        if (!EDP.validPrice(price)) { refuse('price not a valid American price'); continue; }
        const k = [bk.key, pm.market, EDP.normName(player), side, line].join('|');
        if (seen.has(k)) { refuse('duplicate outcome'); continue; }
        seen.add(k);
        out.markets[pm.market] = (out.markets[pm.market] || 0) + 1;
        out.quotes.push({ provider_event_id: ev.id || null, book: bk.key, book_title: bk.title || null, market: pm.market, provider_market: mk.key, alt: !!pm.alt,
          player_name: String(player).trim(), side, line, american: price, quoted_at: stamp, captured_at: observedAt });
      }
    }
  }
  /* a main market that lists the same (book, player, side, line) as its
     alternate keeps ONE row: the main one */
  const main = new Set(out.quotes.filter((q) => !q.alt).map((q) => [q.book, q.market, EDP.normName(q.player_name), q.side, q.line].join('|')));
  out.quotes = out.quotes.filter((q) => !q.alt || !main.has([q.book, q.market, EDP.normName(q.player_name), q.side, q.line].join('|')));
  out.books = Array.from(new Set(out.books)).sort();
  return out;
}

/* the compact row the browser feed carries */
/* captured_at = this poll; first_seen_at = the first poll that saw THIS price
   (an unchanged price keeps its first sighting — the ledger is change-only) */
const COLS = ['book', 'market', 'player_name', 'side', 'line', 'american', 'alt', 'quoted_at', 'captured_at', 'first_seen_at'];
function packQuote(q) { return [q.book, q.market, q.player_name, q.side === 'over' ? 'o' : 'u', q.line, q.american, q.alt ? 1 : 0, q.quoted_at, q.captured_at, q.first_seen_at || q.captured_at]; }
function unpackQuote(a) { return { book: a[0], market: a[1], player_name: a[2], side: a[3] === 'o' ? 'over' : 'under', line: a[4], american: a[5], alt: !!a[6], quoted_at: a[7], captured_at: a[8], first_seen_at: a[9] || a[8] }; }
function quoteKey(q) { return [q.book, q.market, EDP.normName(q.player_name), q.side, q.line].join('|'); }

/* the listing: polled events replaced wholesale, others kept at their own age */
function buildQuotesFeed(o) {
  const now = o.now != null ? o.now : Date.now();
  const upcoming = (t) => { const v = Date.parse(t); return Number.isFinite(v) && v > now - 4 * 3600e3; };
  const events = {};
  if (o.prior && o.prior.schema === QUOTES_SCHEMA && o.prior.events) Object.keys(o.prior.events).forEach((id) => { const e = o.prior.events[id]; if (e && upcoming(e.commence_time)) events[id] = e; });
  (o.polled || []).forEach((p) => {
    const before = {};
    if (events[p.id] && Array.isArray(events[p.id].quotes)) events[p.id].quotes.forEach((a) => { const q = unpackQuote(a); before[quoteKey(q)] = q; });
    p.quotes.forEach((q) => { const b = before[quoteKey(q)]; q.first_seen_at = b && b.american === q.american ? (b.first_seen_at || b.captured_at) : o.observed_at; });
    events[p.id] = { event_id: p.id, commence_time: iso(p.commence_time), home_team: p.home_team, away_team: p.away_team, observed_at: o.observed_at,
      books: p.books || [], n_quotes: p.quotes.length, cols: COLS, quotes: p.quotes.map(packQuote) };
  });
  let n = 0; Object.keys(events).forEach((id) => { n += events[id].quotes.length; });
  return { schema: QUOTES_SCHEMA, league: o.league, sport: C.LEAGUES[o.league].sport, provider: 'the-odds-api', generated_at: new Date(now).toISOString(),
    markets: o.markets || null, bookmakers: o.bookmakers || null, n_events: Object.keys(events).length, n_quotes: n,
    why: 'captured player-prop quotes only. An event\'s observed_at is its last successful poll; an event not polled since ages into STALE. No line or price is ever manufactured.',
    events };
}

/* movement: per event → "player|market" → book → { main: [[t, line, over, under]…], alt: { "side|line": [first_t, first_price, last_t, last_price] } } */
function updateLines(prior, polled, observedAt, now) {
  const L = prior && prior.schema === LINES_SCHEMA ? prior : { schema: LINES_SCHEMA, events: {} };
  const upcoming = (t) => { const v = Date.parse(t); return Number.isFinite(v) && v > now - 4 * 3600e3; };
  const closed = [];
  Object.keys(L.events).forEach((id) => { if (!upcoming(L.events[id].commence_time)) { closed.push(Object.assign({ event_id: id }, L.events[id])); delete L.events[id]; } });
  (polled || []).forEach((p) => {
    const E = L.events[p.id] || (L.events[p.id] = { commence_time: iso(p.commence_time), home_team: p.home_team, away_team: p.away_team, props: {} });
    const mains = {};
    p.quotes.forEach((q) => {
      const pk = EDP.normName(q.player_name) + '|' + q.market;
      const P = E.props[pk] || (E.props[pk] = { player_name: q.player_name, books: {} });
      const B = P.books[q.book] || (P.books[q.book] = { main: [], alt: {} });
      if (q.alt) {
        const k = q.side + '|' + q.line, a = B.alt[k];
        if (!a) B.alt[k] = [observedAt, q.american, observedAt, q.american]; else { a[2] = observedAt; a[3] = q.american; }
      } else {
        const mk = pk + '|' + q.book;
        (mains[mk] = mains[mk] || { B, lines: {} }).lines[q.line] = Object.assign(mains[mk].lines[q.line] || {}, { [q.side]: q.american });
      }
    });
    Object.keys(mains).forEach((mk) => {
      const { B, lines } = mains[mk];
      /* the book's main number: two-sided nearest even money */
      const ls = Object.keys(lines).map(Number).sort((a, b) => a - b);
      let pick = ls.find((l) => lines[l].over != null && lines[l].under != null);
      if (pick == null) pick = ls[0];
      const row = [observedAt, pick, lines[pick].over != null ? lines[pick].over : null, lines[pick].under != null ? lines[pick].under : null];
      const last = B.main[B.main.length - 1];
      if (!last || last[1] !== row[1] || last[2] !== row[2] || last[3] !== row[3]) {
        B.main.push(row);
        if (B.main.length > MAX_SERIES) B.main.splice(1, B.main.length - MAX_SERIES);   /* keep the open */
      }
    });
  });
  L.generated_at = new Date(now).toISOString();
  return { lines: L, closed };
}

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
  const remaining = num(res.headers.get('x-requests-remaining')), last = num(res.headers.get('x-requests-last'));
  if (!res.ok) throw Object.assign(new Error('HTTP ' + res.status + ' ' + url.replace(/apiKey=[^&]+/, 'apiKey=***')), { status: res.status, remaining });
  return { body: await res.json(), remaining, last };
}

function marketList(league, groups) {
  const gs = groups && groups.length ? groups : C.DEFAULT_GROUPS[league];
  const keys = [];
  gs.forEach((g) => (C.MARKET_GROUPS[g] || []).forEach((k) => { if (keys.indexOf(k) < 0) keys.push(k); }));
  return keys;
}

async function run(opts) {
  const now = opts.now || Date.now(), league = opts.league || 'nfl', L = C.LEAGUES[league];
  if (!L) throw new Error('unknown league ' + league);
  const season = opts.season || C.seasonOf(now), P = opts.paths || C.leaguePaths(league, season);
  const state = readJson(P.capture_state) || {};
  const getter = opts.getJson || getJson;
  const key = opts.key;
  if (!key) return { league, skipped: 'no ODDS_API_KEY: nothing captured, nothing spent' };
  const markets = marketList(league, opts.groups);
  const books = String(opts.bookmakers || C.DEFAULTS.bookmakers).split(',').filter(Boolean);
  const regionsCost = Math.max(1, Math.ceil(books.length / 10));
  const costPerEvent = markets.length * regionsCost;
  const attemptAt = new Date(now).toISOString();
  let ev;
  try { ev = await getter(API + '/sports/' + L.sport + '/events?apiKey=' + encodeURIComponent(key) + '&dateFormat=iso'); }
  catch (e) {
    const s = Object.assign({}, state, { league, last_attempt: attemptAt, last_error: 'event index failed: ' + (e.status || 'network') });
    if (!opts.dry_run) { fs.mkdirSync(P.dir, { recursive: true }); fs.writeFileSync(P.capture_state, JSON.stringify(s, null, 1) + '\n'); }
    return Object.assign({ skipped: s.last_error }, s);
  }
  const soon = (ev.body || []).filter((e) => { const t = Date.parse(e.commence_time); return t > now && t - now <= opts.window_h * 3600e3; })
    .sort((a, b) => Date.parse(a.commence_time) - Date.parse(b.commence_time));
  /* each event keeps its own clock: a game days away is re-polled rarely, one
     about to kick off often. Ten minutes of slack absorbs the hourly cron's drift */
  const polledAt = {};
  soon.forEach((e) => { if (state.polled_at && state.polled_at[e.id]) polledAt[e.id] = state.polled_at[e.id]; });
  const intervalFor = (e) => { const d = Date.parse(e.commence_time) - now; return d <= 6 * 3600e3 ? opts.near_interval_h : d <= (opts.far_h || 36) * 3600e3 ? opts.min_interval_h : (opts.far_interval_h || opts.min_interval_h); };
  const due = soon.filter((e) => opts.force || !polledAt[e.id] || now - Date.parse(polledAt[e.id]) >= intervalFor(e) * 3600e3 - 10 * 60e3);
  if (!due.length) return { league, skipped: soon.length ? 'no event due: each was polled inside its interval (every ' + opts.near_interval_h + ' h at most inside six hours of kickoff, ' + opts.min_interval_h + ' h inside ' + (opts.far_h || 36) + ' h, ' + (opts.far_interval_h || opts.min_interval_h) + ' h beyond)' : 'no event inside the ' + opts.window_h + ' h window' };
  const take = due.slice(0, opts.max_events);
  const polled = [], refused = {};
  let remaining = ev.remaining, spent = 0, calls = 0, stopped = null, nq = 0;
  for (const e of take) {
    if (remaining != null && remaining - costPerEvent < opts.min_remaining) { stopped = 'credits below floor (' + remaining + ' remaining, floor ' + opts.min_remaining + ')'; break; }
    if (spent + costPerEvent > opts.max_credits_run) { stopped = 'run budget reached (' + spent + ' of ' + opts.max_credits_run + ')'; break; }
    try {
      const r = await getter(API + '/sports/' + L.sport + '/events/' + encodeURIComponent(e.id) + '/odds?apiKey=' + encodeURIComponent(key)
        + '&markets=' + encodeURIComponent(markets.join(',')) + '&bookmakers=' + encodeURIComponent(books.join(',')) + '&oddsFormat=american&dateFormat=iso');
      calls++; spent += r.last != null ? r.last : costPerEvent; if (r.remaining != null) remaining = r.remaining;
      polledAt[e.id] = attemptAt;
      const parsed = parseEventProps(r.body, attemptAt);
      Object.keys(parsed.refused).forEach((k) => { refused[k] = (refused[k] || 0) + parsed.refused[k]; });
      polled.push({ id: e.id, commence_time: e.commence_time, home_team: e.home_team, away_team: e.away_team, books: parsed.books, quotes: parsed.quotes });
      nq += parsed.quotes.length;
    } catch (err) {
      if (err.status === 429 || err.status === 401) { stopped = 'provider refused: ' + err.status; break; }
      const k = 'event failed: ' + (err.status || 'network'); refused[k] = (refused[k] || 0) + 1;
    }
  }
  const summary = { league, sport: L.sport, season, markets, bookmakers: books, cost_per_event: costPerEvent, events_in_window: soon.length, events_due: due.length, events_polled: calls,
    quotes: nq, refused, stopped, credits_spent: spent, requests_remaining: remaining, last_attempt: attemptAt, last_run: calls > 0 ? attemptAt : (state.last_run || null), polled_at: polledAt };
  if (!opts.dry_run) {
    fs.mkdirSync(P.dir, { recursive: true });
    const feed = buildQuotesFeed({ league, now, prior: readJson(P.quotes), polled, observed_at: attemptAt, markets, bookmakers: books });
    writeIfChanged(P.quotes, feed);
    const up = updateLines(readJson(P.lines), polled, attemptAt, now);
    up.lines.league = league;
    writeIfChanged(P.lines, up.lines);
    summary.closed_events = up.closed.length;
    if (up.closed.length) {
      fs.mkdirSync(P.season_dir, { recursive: true });
      fs.appendFileSync(P.closes, up.closed.map((c) => JSON.stringify(Object.assign({ schema: 'edgedesk_player_props_close_v1', league }, c))).join('\n') + '\n');
    }
    fs.writeFileSync(P.capture_state, JSON.stringify(summary, null, 1) + '\n');
  }
  return summary;
}
function writeIfChanged(file, obj) {
  const strip = (f) => f ? JSON.stringify(Object.assign({}, f, { generated_at: null })) : null;
  let prev = null; try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { prev = null; }
  if (prev && strip(prev) === strip(obj)) return false;
  fs.writeFileSync(file, JSON.stringify(obj) + '\n');
  return true;
}

module.exports = { parseEventProps, buildQuotesFeed, updateLines, packQuote, unpackQuote, quoteKey, marketList, run, COLS, QUOTES_SCHEMA, LINES_SCHEMA };

if (require.main === module) {
  const a = process.argv.slice(2);
  const arg = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
  const flag = (k) => a.indexOf('--' + k) >= 0;
  const league = arg('league', 'nfl');
  if (arg('fixture')) {
    const ev = JSON.parse(fs.readFileSync(path.resolve(arg('fixture')), 'utf8'));
    const r = parseEventProps(ev, new Date().toISOString());
    console.log(JSON.stringify({ quotes: r.quotes.length, books: r.books, markets: r.markets, refused: r.refused }, null, 1));
  } else if (!flag('network')) {
    console.log('[props capture] offline: pass --network (and ODDS_API_KEY) to capture; nothing spent.');
  } else {
    const D = C.DEFAULTS;
    run({ key: process.env.ODDS_API_KEY || null, league, groups: arg('groups', process.env.PROPS_MARKET_GROUPS || '') ? String(arg('groups', process.env.PROPS_MARKET_GROUPS)).split(',') : null,
      window_h: Number(arg('window-h', D.window_h)), max_events: Number(arg('max-events', D.max_events)), min_interval_h: Number(arg('min-interval-h', process.env.PROPS_MIN_INTERVAL_H || D.min_interval_h)),
      near_interval_h: Number(arg('near-interval-h', D.near_interval_h)), min_remaining: Number(arg('min-remaining', D.min_remaining)),
      far_h: Number(arg('far-h', D.far_h)), far_interval_h: Number(arg('far-interval-h', process.env.PROPS_FAR_INTERVAL_H || D.far_interval_h)),
      max_credits_run: Number(arg('max-credits', process.env.PROPS_MAX_CREDITS || D.max_credits_run)),
      bookmakers: arg('bookmakers', process.env.PROPS_BOOKMAKERS || D.bookmakers), dry_run: flag('dry-run'), force: flag('force') })
      .then((s) => console.log('[props capture]', JSON.stringify(s)))
      .catch((e) => { console.error('[props capture] failed:', e.message); process.exit(0); });   /* fail soft: the page says what is captured */
  }
}
