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
     capture_state.json the last run: its status (NOT_RUN, RUNNING, SUCCESS,
                        PARTIAL, NO_MARKETS, ERROR — see STATUSES below),
                        each request's HTTP answer, what came back, spend,
                        remaining credits, refusals. Written on EVERY outcome,
                        so the page never infers "not run" from a zero.

   The switch: in GitHub Actions the repository variable PROPS_CAPTURE, mapped
   into the step's environment and normalized (on / true / 1 / yes in any
   case). Off, the run says "Player props capture skipped: PROPS_CAPTURE
   disabled" and writes NOT_RUN. The key is never logged: only whether it is
   present.

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

/* ------------------------------------------------------------------ status
   capture_state.json says what the LAST run did, in one of six states, so the
   page never has to guess from a zero:

     NOT_RUN     the capture did not execute (PROPS_CAPTURE off, or no state
                 file has ever been published)
     RUNNING     a run started and has not finished (a run that dies mid-way
                 leaves this behind — it is never read as success)
     SUCCESS     every event request answered and prices were written
     PARTIAL     prices were written, but some request failed or the run
                 stopped early (budget, credit floor, 401/429)
     NO_MARKETS  the provider answered, and no book has posted a player market
                 for the events asked (MARKETS_NOT_RELEASED), or no event
                 kicks off inside the window (NO_EVENTS_IN_WINDOW)
     ERROR       nothing was written because the capture could not run or
                 every request failed: no key, the event index failed, a
                 401/429, the credit floor — error_message says which */
const STATE_SCHEMA = 'edgedesk_player_props_capture_state_v2';
const STATUSES = ['NOT_RUN', 'RUNNING', 'SUCCESS', 'PARTIAL', 'NO_MARKETS', 'ERROR'];
/* fields that only say WHEN; a state that differs from the last only in these
   is not rewritten, so a quiet hourly run does not commit */
const STATE_CLOCKS = { started_at: 1, completed_at: 1, updated_at: 1, last_attempt: 1 };

/* PROPS_CAPTURE, normalized: on / true / 1 / yes in any case, surrounding
   whitespace or quotes ignored. Anything else, unset included, is off. */
const FLAG_ON = ['on', 'true', '1', 'yes'];
function captureEnabled(raw) {
  return FLAG_ON.indexOf(String(raw == null ? '' : raw).trim().replace(/^["']+|["']+$/g, '').trim().toLowerCase()) >= 0;
}

/* never let the key reach a log, a state file or an error message */
function scrub(text, url) {
  let s = String(text == null ? '' : text).replace(/apiKey=[^&\s"']+/gi, 'apiKey=***');
  const m = url && /apiKey=([^&]+)/.exec(url);
  if (m) { let k = m[1]; try { k = decodeURIComponent(k); } catch (e) { /* keep raw */ } if (k.length >= 8) s = s.split(k).join('***'); }
  return s;
}

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
  const meta = { status: res.status, remaining: num(res.headers.get('x-requests-remaining')), used: num(res.headers.get('x-requests-used')), last: num(res.headers.get('x-requests-last')) };
  if (!res.ok) {
    let body = ''; try { body = await res.text(); } catch (e) { body = ''; }
    throw Object.assign(new Error('HTTP ' + res.status + ' ' + scrub(url, url)), meta, { body: scrub(body, url).slice(0, 500) });
  }
  return Object.assign({ body: await res.json() }, meta);
}

function marketList(league, groups) {
  const gs = groups && groups.length ? groups : C.DEFAULT_GROUPS[league];
  const keys = [];
  gs.forEach((g) => (C.MARKET_GROUPS[g] || []).forEach((k) => { if (keys.indexOf(k) < 0) keys.push(k); }));
  return keys;
}

/* what the provider actually returned for one event, before any refusal */
function census(ev) {
  const c = { books: [], markets: {}, outcomes: 0 };
  if (!ev || !Array.isArray(ev.bookmakers)) return c;
  ev.bookmakers.forEach((bk) => {
    if (!bk || !Array.isArray(bk.markets) || !bk.markets.length) return;
    c.books.push(bk.key);
    bk.markets.forEach((mk) => { if (!mk || !mk.key) return; c.markets[mk.key] = (c.markets[mk.key] || 0) + 1; c.outcomes += Array.isArray(mk.outcomes) ? mk.outcomes.length : 0; });
  });
  return c;
}

function errorOf(err, url) {
  return { http: err && err.status ? err.status : 'network', error: scrub((err && err.body) || (err && err.message) || String(err), url).slice(0, 500) };
}

function writeState(file, state) {
  const strip = (f) => f ? JSON.stringify(f, (k, v) => (STATE_CLOCKS[k] ? null : v)) : null;
  let prev = null; try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { prev = null; }
  if (prev && strip(prev) === strip(state)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 1) + '\n');
  return true;
}

async function run(opts) {
  const t0 = Date.now();
  const now = opts.now || Date.now(), league = opts.league || 'nfl', L = C.LEAGUES[league];
  if (!L) throw new Error('unknown league ' + league);
  const season = opts.season || C.seasonOf(now), P = opts.paths || C.leaguePaths(league, season);
  const state = readJson(P.capture_state) || {};
  const log = opts.log || (() => {});
  const getter = opts.getJson || getJson;
  const key = opts.key;
  const markets = marketList(league, opts.groups);
  const books = String(opts.bookmakers || C.DEFAULTS.bookmakers).split(',').map((b) => b.trim()).filter(Boolean);
  const regionsCost = Math.max(1, Math.ceil(books.length / 10));
  const costPerEvent = markets.length * regionsCost;
  const attemptAt = new Date(now).toISOString();
  const tag = '[props capture] ' + league;
  /* the state every outcome starts from: what was asked, and what the last
     run that reached the provider left behind */
  const base = { schema: STATE_SCHEMA, league, sport: L.sport, season, status: null, reason: null, why: null, error_message: null,
    started_at: attemptAt, completed_at: null, updated_at: null, last_attempt: attemptAt,
    flag: opts.flag || null, key_present: !!key,
    markets, bookmakers: books, cost_per_event: costPerEvent, window_h: opts.window_h,
    last_run: state.last_run || null, last_success_at: state.last_success_at || null, polled_at: state.polled_at || {} };
  const finish = (s) => {
    s.completed_at = s.updated_at = new Date(now + (Date.now() - t0)).toISOString();
    if (!opts.dry_run) writeState(P.capture_state, s);
    return s;
  };

  /* CASE D — the capture is switched off: say so, write NOT_RUN, spend nothing */
  if (opts.enabled === false) {
    log('Player props capture skipped: PROPS_CAPTURE disabled (' + league + '; raw value ' + JSON.stringify(opts.flag && opts.flag.raw != null ? opts.flag.raw : null) + ')');
    return Object.assign(finish(Object.assign(base, { status: 'NOT_RUN', reason: 'PROPS_CAPTURE_DISABLED',
      why: 'Player props capture skipped: PROPS_CAPTURE disabled. Set the repository variable PROPS_CAPTURE to on (on, true, 1 or yes).' })), { skipped: 'PROPS_CAPTURE disabled: nothing captured, nothing spent' });
  }
  if (!key) {
    log(tag + ': ERROR — PROPS_CAPTURE is on but ODDS_API_KEY is empty in this step: nothing requested, nothing spent');
    return Object.assign(finish(Object.assign(base, { status: 'ERROR', reason: 'NO_API_KEY',
      why: 'The capture ran with PROPS_CAPTURE on, but the ODDS_API_KEY secret did not reach it: no request was made.', error_message: 'ODDS_API_KEY is empty' })), { skipped: 'no ODDS_API_KEY: nothing captured, nothing spent' });
  }

  /* the event index is free */
  const indexUrl = API + '/sports/' + L.sport + '/events?apiKey=' + encodeURIComponent(key) + '&dateFormat=iso';
  let ev;
  try { ev = await getter(indexUrl); }
  catch (e) {
    const er = errorOf(e, indexUrl);
    log(tag + ': ERROR — GET /v4/sports/' + L.sport + '/events → HTTP ' + er.http + ' · body: ' + er.error);
    const s = finish(Object.assign(base, { status: 'ERROR', reason: 'EVENT_INDEX_FAILED', requests_remaining: e.remaining != null ? e.remaining : null,
      why: 'The Odds API event index for ' + L.label + ' failed (HTTP ' + er.http + '): no prop was requested.', error_message: 'event index HTTP ' + er.http + ': ' + er.error }));
    return Object.assign({ skipped: 'event index failed: ' + er.http, last_error: 'event index failed: ' + er.http }, s);
  }
  const listed = Array.isArray(ev.body) ? ev.body : [];
  const soon = listed.filter((e) => { const t = Date.parse(e.commence_time); return t > now && t - now <= opts.window_h * 3600e3; })
    .sort((a, b) => Date.parse(a.commence_time) - Date.parse(b.commence_time));
  const label = (e) => e.id + ' ' + (e.away_team || '?') + ' @ ' + (e.home_team || '?') + ' ' + e.commence_time;
  log(tag + ': sport ' + L.sport + ' · event index HTTP ' + (ev.status || 200) + ' · events discovered ' + listed.length + ' · inside the ' + opts.window_h + ' h window ' + soon.length);
  if (listed.length) log(tag + ': discovered event ids ' + listed.map((e) => e.id).join(','));
  soon.forEach((e) => log(tag + ':   in window ' + label(e)));
  const discovered = { events_discovered: listed.length, events_in_window: soon.length };
  if (!soon.length) {
    const s = finish(Object.assign(base, discovered, { status: 'NO_MARKETS', reason: 'NO_EVENTS_IN_WINDOW', events_due: 0, events_checked: 0, events_polled: 0,
      why: 'The Odds API lists ' + listed.length + ' ' + L.label + ' events; none kicks off inside the next ' + opts.window_h + ' h, so no prop market was requested.' }));
    log(tag + ': NO_MARKETS — no event inside the ' + opts.window_h + ' h window: nothing requested, nothing spent');
    return Object.assign({ skipped: 'no event inside the ' + opts.window_h + ' h window' }, s);
  }
  /* each event keeps its own clock: a game days away is re-polled rarely, one
     about to kick off often. Ten minutes of slack absorbs the hourly cron's drift */
  const polledAt = {};
  soon.forEach((e) => { if (state.polled_at && state.polled_at[e.id]) polledAt[e.id] = state.polled_at[e.id]; });
  const intervalFor = (e) => { const d = Date.parse(e.commence_time) - now; return d <= 6 * 3600e3 ? opts.near_interval_h : d <= (opts.far_h || 36) * 3600e3 ? opts.min_interval_h : (opts.far_interval_h || opts.min_interval_h); };
  const due = soon.filter((e) => opts.force || !polledAt[e.id] || now - Date.parse(polledAt[e.id]) >= intervalFor(e) * 3600e3 - 10 * 60e3);
  if (!due.length) {
    /* nothing is owed: the last run's prices and state stand as they are */
    const why = 'no event due: each was polled inside its interval (every ' + opts.near_interval_h + ' h at most inside six hours of kickoff, ' + opts.min_interval_h + ' h inside ' + (opts.far_h || 36) + ' h, ' + (opts.far_interval_h || opts.min_interval_h) + ' h beyond)';
    log(tag + ': ' + why + ' — last status ' + (state.status || 'unknown') + ', last polled ' + (state.last_run || 'never'));
    return { league, status: null, last_status: state.status || null, skipped: why, events_discovered: listed.length, events_in_window: soon.length, events_due: 0, last_run: state.last_run || null };
  }
  const take = due.slice(0, opts.max_events);
  log(tag + ': events due ' + due.length + ', querying ' + take.length + ' · markets requested (' + markets.length + ') ' + markets.join(',') + ' · books requested (' + books.length + ') ' + books.join(',') + ' · budget ' + costPerEvent + ' credits per event, at most ' + opts.max_credits_run + ' this run');
  if (!opts.dry_run) writeState(P.capture_state, Object.assign({}, base, discovered, { status: 'RUNNING', events_due: due.length, why: 'A capture started at ' + attemptAt + ' and has not finished.' }));

  const polled = [], refused = {}, requests = [], booksBack = new Set(), marketsBack = {};
  let remaining = ev.remaining, used = ev.used != null ? ev.used : null, spent = 0, calls = 0, attempts = 0, failed = 0, noMarkets = 0, outcomes = 0, stopped = null, nq = 0;
  for (const e of take) {
    if (remaining != null && remaining - costPerEvent < opts.min_remaining) { stopped = 'credits below floor (' + remaining + ' remaining, floor ' + opts.min_remaining + ')'; break; }
    if (spent + costPerEvent > opts.max_credits_run) { stopped = 'run budget reached (' + spent + ' of ' + opts.max_credits_run + ')'; break; }
    const url = API + '/sports/' + L.sport + '/events/' + encodeURIComponent(e.id) + '/odds?apiKey=' + encodeURIComponent(key)
      + '&markets=' + encodeURIComponent(markets.join(',')) + '&bookmakers=' + encodeURIComponent(books.join(',')) + '&oddsFormat=american&dateFormat=iso';
    attempts++;
    try {
      const r = await getter(url);
      calls++; spent += r.last != null ? r.last : costPerEvent; if (r.remaining != null) remaining = r.remaining; if (r.used != null) used = r.used;
      polledAt[e.id] = attemptAt;
      const cs = census(r.body);
      const parsed = parseEventProps(r.body, attemptAt);
      Object.keys(parsed.refused).forEach((k) => { refused[k] = (refused[k] || 0) + parsed.refused[k]; });
      cs.books.forEach((b) => booksBack.add(b));
      Object.keys(cs.markets).forEach((k) => { marketsBack[k] = (marketsBack[k] || 0) + cs.markets[k]; });
      outcomes += cs.outcomes;
      if (!cs.outcomes) noMarkets++;
      polled.push({ id: e.id, commence_time: e.commence_time, home_team: e.home_team, away_team: e.away_team, books: parsed.books, quotes: parsed.quotes });
      nq += parsed.quotes.length;
      requests.push({ event_id: e.id, matchup: (e.away_team || '?') + ' @ ' + (e.home_team || '?'), kickoff: e.commence_time, http: r.status || 200,
        books: cs.books.length, markets: Object.keys(cs.markets).length, outcomes: cs.outcomes, quotes: parsed.quotes.length, cost: r.last != null ? r.last : null, remaining: r.remaining != null ? r.remaining : null });
      log(tag + ': event ' + label(e) + ' → HTTP ' + (r.status || 200) + ' · books ' + cs.books.length + (cs.books.length ? ' (' + cs.books.join(',') + ')' : '') + ' · markets ' + Object.keys(cs.markets).length
        + ' · outcomes ' + cs.outcomes + ' · quotes normalized ' + parsed.quotes.length + ' · cost ' + (r.last != null ? r.last : '?') + ' · remaining ' + (r.remaining != null ? r.remaining : '?') + (cs.outcomes ? '' : ' · MARKETS_NOT_RELEASED (no book has posted a requested player market)'));
    } catch (err) {
      failed++;
      const er = errorOf(err, url);
      if (err && err.remaining != null) remaining = err.remaining;
      requests.push({ event_id: e.id, matchup: (e.away_team || '?') + ' @ ' + (e.home_team || '?'), kickoff: e.commence_time, http: er.http, error: er.error });
      log(tag + ': event ' + label(e) + ' → HTTP ' + er.http + ' · body: ' + er.error + ' · markets requested: ' + markets.join(','));
      if (err.status === 429 || err.status === 401) { stopped = 'provider refused: ' + err.status; break; }
      const k = 'event failed: ' + er.http; refused[k] = (refused[k] || 0) + 1;
    }
  }

  let status, reason, why, errorMessage = null;
  const failList = requests.filter((q) => q.error).map((q) => q.event_id + ' HTTP ' + q.http + ': ' + q.error.slice(0, 200));
  /* three examples are enough to diagnose; every request is in `requests` */
  const failures = failList.length > 3 ? failList.slice(0, 3).concat(['… ' + (failList.length - 3) + ' more']) : failList;
  if (nq > 0) {
    status = failed || stopped ? 'PARTIAL' : 'SUCCESS';
    reason = status === 'SUCCESS' ? 'QUOTES_WRITTEN' : (stopped ? 'STOPPED' : 'SOME_REQUESTS_FAILED');
    why = nq + ' prop prices from ' + booksBack.size + ' books across ' + polled.filter((p) => p.quotes.length).length + ' of ' + attempts + ' events queried' + (stopped ? '; the run stopped early: ' + stopped : '') + (failed ? '; ' + failed + ' requests failed' : '') + '.';
    if (failed || stopped) errorMessage = (stopped ? stopped + (failures.length ? '; ' : '') : '') + failures.join('; ') || null;
  } else if (calls > 0 && !failed) {
    status = 'NO_MARKETS'; reason = 'MARKETS_NOT_RELEASED';
    why = 'The Odds API answered for ' + calls + ' ' + L.label + ' event' + (calls === 1 ? '' : 's') + ' (HTTP 200) with no player market from any of the ' + books.length + ' books asked: the books have not released these props yet.' + (stopped ? ' The run stopped early: ' + stopped + '.' : '');
  } else {
    status = 'ERROR';
    reason = stopped && !failures.length ? 'STOPPED_BEFORE_REQUEST' : stopped && /provider refused/.test(stopped) ? 'PROVIDER_REFUSED' : 'REQUESTS_FAILED';
    errorMessage = (stopped ? stopped + (failures.length ? '; ' : '') : '') + failures.join('; ');
    why = 'No prop price was written: ' + errorMessage + '.';
  }
  const summary = Object.assign(base, discovered, {
    status, reason, why, error_message: errorMessage,
    events_due: due.length, events_checked: attempts, events_polled: calls, events_failed: failed, events_no_markets: noMarkets, event_ids: take.slice(0, attempts).map((e) => e.id),
    books_returned: Array.from(booksBack).sort(), markets_returned: marketsBack, outcomes_returned: outcomes,
    quotes: nq, quotes_normalized: nq, quotes_written: 0, refused, stopped,
    credits_spent: spent, requests_remaining: remaining, requests_used: used, requests,
    last_run: calls > 0 ? attemptAt : (state.last_run || null), last_success_at: nq > 0 ? attemptAt : (state.last_success_at || null), polled_at: polledAt });
  if (!opts.dry_run) {
    fs.mkdirSync(P.dir, { recursive: true });
    const feed = buildQuotesFeed({ league, now, prior: readJson(P.quotes), polled, observed_at: attemptAt, markets, bookmakers: books });
    writeIfChanged(P.quotes, feed);
    summary.quotes_written = polled.reduce((n, p) => n + (feed.events[p.id] ? feed.events[p.id].quotes.length : 0), 0);
    summary.feed_quotes = feed.n_quotes; summary.feed_events = feed.n_events;
    const up = updateLines(readJson(P.lines), polled, attemptAt, now);
    up.lines.league = league;
    writeIfChanged(P.lines, up.lines);
    summary.closed_events = up.closed.length;
    if (up.closed.length) {
      fs.mkdirSync(P.season_dir, { recursive: true });
      fs.appendFileSync(P.closes, up.closed.map((c) => JSON.stringify(Object.assign({ schema: 'edgedesk_player_props_close_v1', league }, c))).join('\n') + '\n');
    }
  }
  finish(summary);
  log(tag + ': ' + status + ' (' + reason + ') · events discovered ' + listed.length + ' · in window ' + soon.length + ' · queried ' + attempts + ' (answered ' + calls + ', failed ' + failed + ', no markets ' + noMarkets + ')'
    + ' · books returned ' + booksBack.size + ' · markets returned ' + Object.keys(marketsBack).length + ' · outcomes ' + outcomes + ' · quotes normalized ' + nq + ' · quotes written ' + summary.quotes_written
    + ' · refused ' + JSON.stringify(refused) + ' · credits spent ' + spent + ' · remaining ' + (remaining != null ? remaining : '?') + (stopped ? ' · stopped: ' + stopped : ''));
  return summary;
}
function writeIfChanged(file, obj) {
  const strip = (f) => f ? JSON.stringify(Object.assign({}, f, { generated_at: null })) : null;
  let prev = null; try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { prev = null; }
  if (prev && strip(prev) === strip(obj)) return false;
  fs.writeFileSync(file, JSON.stringify(obj) + '\n');
  return true;
}

module.exports = { parseEventProps, buildQuotesFeed, updateLines, packQuote, unpackQuote, quoteKey, marketList, run, captureEnabled, census, scrub, COLS, QUOTES_SCHEMA, LINES_SCHEMA, STATE_SCHEMA, STATUSES };

/* the step summary a workflow run shows on its page */
function stepSummary(s) {
  const f = process.env.GITHUB_STEP_SUMMARY; if (!f) return;
  const row = (k, v) => '| ' + k + ' | ' + String(v == null ? '—' : v).replace(/\|/g, '/') + ' |\n';
  let md = '\n### Player props capture — ' + s.league + ': **' + (s.status || 'no request this run (last status ' + (s.last_status || 'none') + ')') + '**' + (s.reason ? ' (' + s.reason + ')' : '') + '\n\n| | |\n|---|---|\n';
  md += row('PROPS_CAPTURE raw / enabled', s.flag ? JSON.stringify(s.flag.raw) + ' / ' + s.flag.enabled : '—') + row('ODDS_API_KEY present', s.key_present);
  md += row('events discovered / in window / due / queried', [s.events_discovered, s.events_in_window, s.events_due, s.events_checked].map((x) => x == null ? '—' : x).join(' / '));
  md += row('books returned', s.books_returned ? s.books_returned.length + ' ' + s.books_returned.join(', ') : null) + row('markets returned', s.markets_returned ? Object.keys(s.markets_returned).length : null);
  md += row('outcomes returned', s.outcomes_returned) + row('quotes normalized / written', s.quotes_normalized != null ? s.quotes_normalized + ' / ' + s.quotes_written : null);
  md += row('credits spent / remaining', s.credits_spent != null ? s.credits_spent + ' / ' + s.requests_remaining : null) + row('why', s.why || s.skipped) + (s.error_message ? row('error', s.error_message) : '');
  try { fs.appendFileSync(f, md); } catch (e) { /* the log has it */ }
}

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
    /* In GitHub Actions the repository variable is the switch (the workflow
       maps it into PROPS_CAPTURE; unset arrives empty = off). A by-hand run
       without the variable is opted in by --network itself. */
    const raw = process.env.PROPS_CAPTURE;
    const gated = raw !== undefined || process.env.GITHUB_ACTIONS === 'true';
    const enabled = gated ? captureEnabled(raw) : true;
    const key = String(process.env.ODDS_API_KEY || '').trim() || null;
    const ci = process.env.GITHUB_ACTIONS === 'true';
    console.log('[props capture] ' + league + ' · ODDS_API_KEY present: ' + !!key + ' · PROPS_CAPTURE raw: ' + (raw === undefined ? '(not set)' : JSON.stringify(raw))
      + ' · PROPS_CAPTURE parsed enabled: ' + enabled + (gated ? '' : ' (by-hand run: --network is the opt-in)'));
    run({ key, enabled, flag: { raw: raw === undefined ? null : raw, enabled, gated }, league, log: (m) => console.log(m),
      groups: arg('groups', process.env.PROPS_MARKET_GROUPS || '') ? String(arg('groups', process.env.PROPS_MARKET_GROUPS)).split(',').map((g) => g.trim()).filter(Boolean) : null,
      window_h: Number(arg('window-h', process.env.PROPS_WINDOW_H || D.window_h)), max_events: Number(arg('max-events', D.max_events)), min_interval_h: Number(arg('min-interval-h', process.env.PROPS_MIN_INTERVAL_H || D.min_interval_h)),
      near_interval_h: Number(arg('near-interval-h', D.near_interval_h)), min_remaining: Number(arg('min-remaining', D.min_remaining)),
      far_h: Number(arg('far-h', D.far_h)), far_interval_h: Number(arg('far-interval-h', process.env.PROPS_FAR_INTERVAL_H || D.far_interval_h)),
      max_credits_run: Number(arg('max-credits', process.env.PROPS_MAX_CREDITS || D.max_credits_run)),
      bookmakers: arg('bookmakers', process.env.PROPS_BOOKMAKERS || D.bookmakers), dry_run: flag('dry-run'), force: flag('force') })
      .then((s) => {
        const brief = Object.assign({}, s); delete brief.requests; delete brief.polled_at;
        console.log('[props capture] state ' + JSON.stringify(brief));
        if (ci && s.status === 'ERROR') console.log('::error title=Player props capture (' + league + ')::' + (s.error_message || s.why));
        else if (ci && (s.status === 'PARTIAL' || s.status === 'NOT_RUN')) console.log('::warning title=Player props capture (' + league + ')::' + (s.status === 'NOT_RUN' ? s.why : s.error_message || s.why));
        stepSummary(s);
      })
      .catch((e) => { console.error('[props capture] failed: ' + scrub(e && e.stack || e)); if (ci) console.log('::error title=Player props capture (' + league + ')::' + scrub(e && e.message || e)); process.exit(0); });   /* fail soft: the state file says what happened */
  }
}
