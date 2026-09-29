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
     - each event on its own clock, EDProps FRESHNESS.cadence by hours to
       kickoff (defaults: every 15 min inside 90 min, 30 min inside 6 h, 60
       min inside 24 h, 2 h inside 48 h, 6 h beyond; PROPS_CADENCE overrides).
       The scheduler that wakes it is supabase/functions/props_cron (pg_cron,
       every five minutes), with the workflow's own cron as the backup;
     - RECOVERY: a failed event is retried on its own back-off (5, 10, 20, 40,
       60 min, ± jitter), sooner than its cadence; a timeout, network error or
       5xx is retried once inside the run; one event's failure never stops the
       others; a 429 stops the run and nothing is asked until its Retry-After
       (or FRESHNESS.rate_limit_minutes) has passed; an empty answer where the
       last poll had prices is not believed until it repeats;
     - PARTIAL ANSWERS: a book missing from an answer keeps its last quotes at
       their own capture time (they age out); the books that answered are
       current. Every successful event is committed, whatever the others did;
     - it stops before spending when the provider reports fewer than
       --min-remaining credits and before a run would pass --max-credits; below
       low_credits it polls games more than six hours out half as often, below
       critical_credits only games inside six hours;
     - a manual refresh (--force, optionally --events <ids>) re-asks every event
       not captured in the last FRESHNESS.manual.min_age_minutes;
     - change-only persistence; a duplicated outcome is refused, never averaged;
       an impossible price, an out-of-range line, a team entity, a reversed
       ladder or a future stamp is refused and counted, never repaired.

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
   markets — a line. DATA QUALITY: a quote that fails a guard is REFUSED and
   counted by reason, never repaired, so nothing corrupt reaches the model:
     - impossible odds, a missing / non-half / out-of-range line (EDProps.lineSane)
     - no player, or a team / defense entity in a player market
     - a market not in the registry
     - a duplicated outcome (the same price twice keeps one; two DIFFERENT
       prices for one outcome are both refused — nobody can say which is real)
     - a provider stamp in the future of the capture (a clock fault)
     - a ladder out of order: one book's Over getting CHEAPER as its line
       rises (or the Under the other way) — reversed sides or a broken feed */
const TEAM_ENTITY = /(^|\s)(d\/st|dst|defen[cs]e|special teams)(\s|$)/i;
const LADDER_TOLERANCE = 0.03;
function parseEventProps(ev, observedAt) {
  const out = { quotes: [], refused: {}, flagged: {}, books: [], markets: {} };
  const refuse = (why, n) => { out.refused[why] = (out.refused[why] || 0) + (n || 1); };
  const flag = (why) => { out.flagged[why] = (out.flagged[why] || 0) + 1; };
  if (!ev || typeof ev !== 'object' || !Array.isArray(ev.bookmakers)) { refuse('no bookmakers array'); return out; }
  const obs = Date.parse(observedAt);
  const seen = new Map(), conflicted = new Set();
  for (const bk of ev.bookmakers) {
    if (!bk || !bk.key || !Array.isArray(bk.markets)) { refuse('malformed bookmaker'); continue; }
    out.books.push(bk.key);
    for (const mk of bk.markets) {
      if (!mk || !Array.isArray(mk.outcomes)) { refuse('malformed market'); continue; }
      const pm = EDP.providerMarket(mk.key);
      if (!pm) { refuse('market not in the registry: ' + mk.key); continue; }
      const mdef = EDP.MARKETS[pm.market];
      const stamp = iso(mk.last_update || bk.last_update);
      const st = Date.parse(stamp);
      if (Number.isFinite(st) && Number.isFinite(obs) && st - obs > EDP.FRESHNESS.provider_future_tolerance_minutes * 60e3) { refuse('provider timestamp in the future', mk.outcomes.length); continue; }
      if (Number.isFinite(st) && Number.isFinite(obs) && obs - st > 24 * 3600e3) flag('provider stamp older than 24 h');
      for (const o of mk.outcomes) {
        const player = o && (o.description || o.participant || null);
        const side = EDP.sideOf(o && o.name);
        const price = num(o && o.price);
        let line = num(o && o.point);
        if (!player) { refuse('outcome names no player'); continue; }
        if (TEAM_ENTITY.test(String(player))) { refuse('team or defense entity, not a player'); continue; }
        if (!side) { refuse('side is not over/under/yes/no'); continue; }
        if (mdef.yesno) { if (line == null) line = 0.5; if (line !== 0.5) { refuse('yes/no market with a line other than 0.5'); continue; } }
        if (line == null) { refuse('outcome without a line'); continue; }
        if (line < 0 || Math.abs(line * 2 - Math.round(line * 2)) > 1e-9) { refuse('line not a non-negative half point'); continue; }
        if (!EDP.lineSane(pm.market, line)) { refuse('line outside the sane range for ' + pm.market); continue; }
        if (!EDP.validPrice(price)) { refuse('price not a valid American price'); continue; }
        const k = [bk.key, pm.market, EDP.normName(player), side, line].join('|');
        const prev = seen.get(k);
        if (prev) {
          if (prev.american === price) { refuse('duplicate outcome'); continue; }
          conflicted.add(k); refuse('conflicting duplicate outcome'); continue;
        }
        const q = { provider_event_id: ev.id || null, book: bk.key, book_title: bk.title || null, market: pm.market, provider_market: mk.key, alt: !!pm.alt,
          player_name: String(player).trim(), side, line, american: price, quoted_at: stamp, captured_at: observedAt };
        seen.set(k, q);
        out.quotes.push(q);
      }
    }
  }
  /* a conflicted outcome keeps neither price */
  if (conflicted.size) {
    const before = out.quotes.length;
    out.quotes = out.quotes.filter((q) => !conflicted.has([q.book, q.market, EDP.normName(q.player_name), q.side, q.line].join('|')));
    refuse('conflicting duplicate outcome', before - out.quotes.length);
  }
  /* a main market that lists the same (book, player, side, line) as its
     alternate keeps ONE row: the main one */
  const main = new Set(out.quotes.filter((q) => !q.alt).map((q) => [q.book, q.market, EDP.normName(q.player_name), q.side, q.line].join('|')));
  out.quotes = out.quotes.filter((q) => !q.alt || !main.has([q.book, q.market, EDP.normName(q.player_name), q.side, q.line].join('|')));
  /* each book's ladder must run the right way: P(Over) falls as the line rises */
  const ladders = new Map();
  out.quotes.forEach((q) => { const k = [q.book, q.market, EDP.normName(q.player_name), q.side].join('|'); (ladders.get(k) || ladders.set(k, []).get(k)).push(q); });
  const badLadder = new Set();
  ladders.forEach((qs, k) => {
    if (qs.length < 2 || EDP.MARKETS[qs[0].market].yesno) return;
    const sorted = qs.slice().sort((a, b) => a.line - b.line);
    for (let i = 1; i < sorted.length; i++) {
      const pPrev = EDP.implied(sorted[i - 1].american), pCur = EDP.implied(sorted[i].american);
      const wrong = sorted[i].side === 'over' ? pCur - pPrev > LADDER_TOLERANCE : pPrev - pCur > LADDER_TOLERANCE;
      if (wrong) { badLadder.add(k); break; }
    }
  });
  if (badLadder.size) {
    const before = out.quotes.length;
    out.quotes = out.quotes.filter((q) => !badLadder.has([q.book, q.market, EDP.normName(q.player_name), q.side].join('|')));
    refuse('ladder out of order (reversed sides?)', before - out.quotes.length);
  }
  out.quotes.forEach((q) => { out.markets[q.market] = (out.markets[q.market] || 0) + 1; });
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

/* the listing: a polled event's listing is rebuilt from its answer; an event
   not polled keeps its own at its own age (it is never re-stamped as fresh).

   PARTIAL ANSWERS. A book that dealt this event before and is missing from
   this answer (the provider did not return it) keeps its last quotes at their
   OWN capture time — they age out of the execution window like any old price,
   and drop from the listing once past the stale band. The books that did
   answer are current; one missing book never stales the rest.

   MARKET CLOSED. A (player, market) the answering books dealt before and no
   longer deal is recorded in `closed` with the time it disappeared, so the
   page says MARKET CLOSED instead of "no market". It clears if it returns.

   A listing is never replaced by an OLDER one (a delayed run cannot roll a
   newer capture back). */
function buildQuotesFeed(o) {
  const now = o.now != null ? o.now : Date.now();
  const staleMs = EDP.FRESHNESS.quote.stale_minutes * 60e3;
  const upcoming = (t) => { const v = Date.parse(t); return Number.isFinite(v) && v > now - 4 * 3600e3; };
  const pmKey = (q) => EDP.normName(q.player_name) + '|' + q.market;
  const events = {};
  if (o.prior && o.prior.schema === QUOTES_SCHEMA && o.prior.events) Object.keys(o.prior.events).forEach((id) => { const e = o.prior.events[id]; if (e && upcoming(e.commence_time)) events[id] = e; });
  (o.polled || []).forEach((p) => {
    const prev = events[p.id];
    if (prev && Date.parse(prev.observed_at) > Date.parse(o.observed_at)) return;
    const before = {}, priorQs = prev && Array.isArray(prev.quotes) ? prev.quotes.map(unpackQuote) : [];
    priorQs.forEach((q) => { before[quoteKey(q)] = q; });
    p.quotes.forEach((q) => { const b = before[quoteKey(q)]; q.first_seen_at = b && b.american === q.american ? (b.first_seen_at || b.captured_at) : o.observed_at; });
    /* a book's absence is believed when it answered for other markets, or
       when the whole (already re-checked) answer was empty */
    const answered = new Set(p.quotes.map((q) => q.book));
    const believed = (q) => answered.size === 0 || answered.has(q.book);
    const carried = priorQs.filter((q) => !believed(q) && now - Date.parse(q.captured_at) <= staleMs);
    const all = p.quotes.concat(carried);
    const nowPM = new Set(all.map(pmKey));
    const closed = Object.assign({}, prev && prev.closed ? prev.closed : {});
    Object.keys(closed).forEach((k) => { if (nowPM.has(k)) delete closed[k]; });
    priorQs.forEach((q) => { const k = pmKey(q); if (believed(q) && !nowPM.has(k) && !closed[k]) closed[k] = o.observed_at; });
    events[p.id] = { event_id: p.id, commence_time: iso(p.commence_time), home_team: p.home_team, away_team: p.away_team, observed_at: o.observed_at,
      books: p.books || [], n_quotes: all.length, cols: COLS, quotes: all.map(packQuote) };
    if (carried.length) { events[p.id].carried = carried.length; events[p.id].books_missing = Array.from(new Set(carried.map((q) => q.book))).sort(); }
    if (Object.keys(closed).length) events[p.id].closed = closed;
  });
  let n = 0; Object.keys(events).forEach((id) => { n += events[id].quotes.length; });
  return { schema: QUOTES_SCHEMA, league: o.league, sport: C.LEAGUES[o.league].sport, provider: 'the-odds-api', generated_at: new Date(now).toISOString(),
    markets: o.markets || null, bookmakers: o.bookmakers || null, n_events: Object.keys(events).length, n_quotes: n,
    why: 'captured player-prop quotes only. Each quote keeps its own capture time; an event not polled since, or a book missing from the latest answer, ages out of the execution window. No line or price is ever manufactured.',
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
                 401/429, the credit floor — error_message says which

   and, beside it, what the page's health strip reads (EDProps.systemHealth):
     events_state   each event's own record: last successful poll, last
                    attempt, consecutive failures, when it is next due (its
                    cadence, or its retry after a failure), what it returned
     provider       the provider's last answer, a 429's back-off window,
                    consecutive failures, credits
     health         HEALTHY / DEGRADED / DELAYED / OUTAGE and why
     next_due_at    the earliest moment any event is owed a poll — what the
                    scheduler (supabase/functions/props_cron) wakes for */
const STATE_SCHEMA = 'edgedesk_player_props_capture_state_v3';
const STATUSES = ['NOT_RUN', 'RUNNING', 'SUCCESS', 'PARTIAL', 'NO_MARKETS', 'ERROR'];
/* fields that only say WHEN; a state that differs from the last only in these
   is not rewritten, so a quiet run does not commit */
const STATE_CLOCKS = { started_at: 1, completed_at: 1, updated_at: 1, last_attempt: 1, duration_ms: 1 };

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

async function getJson(url, o) {
  const t0 = Date.now();
  let res;
  try { res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout((o && o.timeout_ms) || 30000) }); }
  catch (e) {
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    throw Object.assign(new Error((timeout ? 'TIMEOUT after ' + ((o && o.timeout_ms) || 30000) + ' ms ' : 'network error ') + scrub(url, url)), { status: timeout ? 'timeout' : 'network', body: scrub(e && e.message, url), ms: Date.now() - t0 });
  }
  const meta = { status: res.status, remaining: num(res.headers.get('x-requests-remaining')), used: num(res.headers.get('x-requests-used')), last: num(res.headers.get('x-requests-last')),
    retry_after: num(res.headers.get('retry-after')), ms: Date.now() - t0 };
  if (!res.ok) {
    let body = ''; try { body = await res.text(); } catch (e) { body = ''; }
    throw Object.assign(new Error('HTTP ' + res.status + ' ' + scrub(url, url)), meta, { body: scrub(body, url).slice(0, 500) });
  }
  let body;
  try { body = await res.json(); } catch (e) { throw Object.assign(new Error('malformed JSON ' + scrub(url, url)), meta, { status: 'malformed', body: 'the provider answered HTTP ' + res.status + ' with a body that is not JSON' }); }
  return Object.assign({ body }, meta);
}
/* a timeout, a network error, a malformed body or a 5xx is worth one more
   try inside the run; a 4xx is an answer and is not */
function transient(err) { const s = err && err.status; return s === 'timeout' || s === 'network' || s === 'malformed' || s == null || (typeof s === 'number' && (s >= 500 || s === 408)); }

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

/* one event's record carried from run to run (events_state) */
function eventRecord(prev, e) {
  const r = Object.assign({ polled_ok_at: null, attempted_at: null, failures: 0, next_retry_at: null, last_http: null, last_error: null, empty_streak: 0 }, prev || {});
  r.matchup = (e.away_team || '?') + ' @ ' + (e.home_team || '?'); r.kickoff = iso(e.commence_time);
  r.home_team = e.home_team || r.home_team || null; r.away_team = e.away_team || r.away_team || null;
  return r;
}
/* when is this event next owed a poll? its cadence after a success (stretched
   by credit pacing), its back-off after a failure, now if never polled */
function nextDue(rec, now, pace) {
  const k = Date.parse(rec.kickoff), h = (k - now) / 3600e3;
  if (!(h > 0)) return null;
  if (rec.next_retry_at && rec.failures > 0) return Date.parse(rec.next_retry_at);
  if (!rec.polled_ok_at) return now;
  const every = EDP.cadenceFor(h) * (h > 6 ? pace : 1);
  return Date.parse(rec.polled_ok_at) + every * 60e3;
}
function pacing(remaining, o) {
  if (remaining == null) return { factor: 1, near_only: false, reason: null };
  if (remaining < (o.critical_credits || 0)) return { factor: 1, near_only: true, reason: 'credits below ' + o.critical_credits + ': only games inside six hours are polled' };
  if (remaining < (o.low_credits || 0)) return { factor: 2, near_only: false, reason: 'credits below ' + o.low_credits + ': games more than six hours out are polled half as often' };
  return { factor: 1, near_only: false, reason: null };
}
const sleepMs = (ms) => new Promise((res) => setTimeout(res, ms));
/* a game four hours past kickoff moves its movement series to the
   append-only closes ledger (CLV, backtests) even on a run that polls nothing
   — history is archived, never deleted, and never waits for the next poll */
function archiveFinished(P, league, now, dryRun) {
  if (dryRun) return 0;
  const prior = readJson(P.lines);
  if (!prior || prior.schema !== LINES_SCHEMA || !prior.events) return 0;
  const up = updateLines(prior, [], new Date(now).toISOString(), now);
  if (!up.closed.length) return 0;
  up.lines.league = league;
  writeIfChanged(P.lines, up.lines);
  fs.mkdirSync(P.season_dir, { recursive: true });
  fs.appendFileSync(P.closes, up.closed.map((c) => JSON.stringify(Object.assign({ schema: 'edgedesk_player_props_close_v1', league }, c))).join('\n') + '\n');
  return up.closed.length;
}

async function run(opts) {
  const t0 = Date.now();
  const now = opts.now || Date.now(), league = opts.league || 'nfl', L = C.LEAGUES[league];
  if (!L) throw new Error('unknown league ' + league);
  const D = C.DEFAULTS;
  const O = Object.assign({ slack_min: D.slack_min, low_credits: D.low_credits, critical_credits: D.critical_credits, request_attempts: D.request_attempts, retry_delay_ms: D.retry_delay_ms, timeout_ms: D.timeout_ms }, opts);
  const season = opts.season || C.seasonOf(now), P = opts.paths || C.leaguePaths(league, season);
  const state = readJson(P.capture_state) || {};
  const log = opts.log || (() => {});
  const getter = opts.getJson || getJson;
  const sleep = opts.sleep || sleepMs;
  const rnd = opts.random || Math.random;
  const key = opts.key;
  const markets = marketList(league, opts.groups);
  const books = String(opts.bookmakers || D.bookmakers).split(',').map((b) => b.trim()).filter(Boolean);
  const regionsCost = Math.max(1, Math.ceil(books.length / 10));
  const costPerEvent = markets.length * regionsCost;
  const attemptAt = new Date(now).toISOString();
  const tag = '[props capture] ' + league;
  const prevProvider = state.provider || {};
  const eventsState = {};
  /* carry every upcoming event's record; a game long started is archived out */
  Object.keys(state.events_state || {}).forEach((id) => { const r = state.events_state[id]; if (r && Date.parse(r.kickoff) > now - 4 * 3600e3) eventsState[id] = r; });
  /* a state file from before events_state: its polled_at map is each event's last success */
  Object.keys(state.polled_at || {}).forEach((id) => { if (!eventsState[id]) eventsState[id] = { polled_ok_at: state.polled_at[id], attempted_at: state.polled_at[id], failures: 0 }; });
  /* the state every outcome starts from: what was asked, and what the last
     run that reached the provider left behind */
  const base = { schema: STATE_SCHEMA, league, sport: L.sport, season, status: null, reason: null, why: null, error_message: null,
    started_at: attemptAt, completed_at: null, updated_at: null, last_attempt: attemptAt, duration_ms: null,
    run: { id: opts.run_id || null, trigger: opts.trigger || null, refresh_request_id: opts.refresh_request_id || null, manual: !!opts.force },
    flag: opts.flag || null, key_present: !!key, enabled: opts.enabled !== false,
    markets, bookmakers: books, cost_per_event: costPerEvent, window_h: opts.window_h, cadence: EDP.FRESHNESS.cadence, executable_max_minutes: EDP.FRESHNESS.executable_max_minutes,
    last_run: state.last_run || null, last_success_at: state.last_success_at || null, last_full_success_at: state.last_full_success_at || null,
    polled_at: {}, events_state: eventsState,
    provider: Object.assign({ last_http: null, rate_limited_until: null, consecutive_failures: 0, last_error: null, requests_remaining: null, requests_used: null }, prevProvider) };
  const polledMap = () => { const m = {}; Object.keys(eventsState).forEach((id) => { if (eventsState[id].polled_ok_at) m[id] = eventsState[id].polled_ok_at; }); return m; };
  /* the page's health strip and the scheduler's next wake, from the state as it now stands */
  const finalize = (s, pace) => {
    s.polled_at = polledMap();
    let nd = null;
    Object.keys(eventsState).forEach((id) => {
      const rec = eventsState[id], k = Date.parse(rec.kickoff);
      if (!(k > now) || (opts.window_h && k - now > opts.window_h * 3600e3)) { rec.next_due_at = null; return; }
      const d = nextDue(rec, now, pace ? pace.factor : 1);
      rec.next_due_at = d != null ? new Date(Math.max(d, now)).toISOString() : null;
      if (d != null && (nd == null || d < nd)) nd = d;
    });
    const we = Date.parse(s.window_entry_at);
    if (Number.isFinite(we) && (nd == null || we < nd)) nd = we;
    const rl = Date.parse(s.provider.rate_limited_until);
    if (nd != null && Number.isFinite(rl) && rl > nd) nd = rl;
    s.next_due_at = nd != null ? new Date(Math.max(nd, now)).toISOString() : null;
    s.health = EDP.systemHealth({ now, capture: { enabled: s.enabled, status: s.status, reason: s.reason, last_attempt_at: s.last_attempt, last_success_at: s.last_success_at,
      consecutive_failures: s.provider.consecutive_failures, rate_limited_until: s.provider.rate_limited_until, provider_http: s.provider.last_http, error_message: s.error_message || s.provider.last_error, window_h: opts.window_h, next_due_at: s.next_due_at },
    events: Object.keys(eventsState).map((id) => ({ id, kickoff: eventsState[id].kickoff, polled_ok_at: eventsState[id].polled_ok_at, attempted_at: eventsState[id].attempted_at, failed: eventsState[id].failures > 0 })) });
    return s;
  };
  const finish = (s, pace) => {
    s.completed_at = s.updated_at = new Date(now + (Date.now() - t0)).toISOString();
    s.duration_ms = Date.now() - t0;
    finalize(s, pace);
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
  /* the provider asked us to wait (a 429): nothing is asked before then, a
     manual refresh included — the answer says exactly until when */
  const rlUntil = Date.parse(base.provider.rate_limited_until);
  if (Number.isFinite(rlUntil) && rlUntil > now) {
    const why = 'the odds provider rate-limited the last run: no request before ' + new Date(rlUntil).toISOString();
    log(tag + ': ' + why);
    const fin = finalize(Object.assign({}, base, { status: state.status || null, reason: state.reason || null, last_attempt: state.last_attempt || null }));
    return { league, status: null, last_status: state.status || null, skipped: why, rate_limited_until: base.provider.rate_limited_until, reason: 'RATE_LIMITED', health: fin.health, next_due_at: fin.next_due_at };
  }

  /* the event index is free: asked twice before the run gives up on it */
  const indexUrl = API + '/sports/' + L.sport + '/events?apiKey=' + encodeURIComponent(key) + '&dateFormat=iso';
  let ev, idxErr = null;
  for (let a = 1; a <= O.request_attempts; a++) {
    try { ev = await getter(indexUrl, { timeout_ms: O.timeout_ms }); idxErr = null; break; }
    catch (e) { idxErr = e; if (!transient(e) || a === O.request_attempts) break; await sleep(Math.round(O.retry_delay_ms * (0.75 + 0.5 * rnd()))); }
  }
  if (idxErr) {
    const e = idxErr, er = errorOf(e, indexUrl);
    log(tag + ': ERROR — GET /v4/sports/' + L.sport + '/events → HTTP ' + er.http + ' · body: ' + er.error);
    base.provider.last_http = er.http; base.provider.last_error = 'event index: ' + er.error; base.provider.consecutive_failures = (base.provider.consecutive_failures || 0) + 1;
    if (e.status === 429) base.provider.rate_limited_until = new Date(now + Math.max(num(e.retry_after) || 0, EDP.FRESHNESS.rate_limit_minutes * 60) * 1000).toISOString();
    if (e.remaining != null) base.provider.requests_remaining = e.remaining;
    const s = finish(Object.assign(base, { status: 'ERROR', reason: 'EVENT_INDEX_FAILED', requests_remaining: e.remaining != null ? e.remaining : null,
      why: 'The Odds API event index for ' + L.label + ' failed (HTTP ' + er.http + '): no prop was requested.', error_message: 'event index HTTP ' + er.http + ': ' + er.error }));
    return Object.assign({ skipped: 'event index failed: ' + er.http, last_error: 'event index failed: ' + er.http }, s);
  }
  const listed = Array.isArray(ev.body) ? ev.body : [];
  if (ev.remaining != null) base.provider.requests_remaining = ev.remaining;
  const pace = pacing(ev.remaining != null ? ev.remaining : base.provider.requests_remaining, O);
  base.pacing = pace;
  const soon = listed.filter((e) => { const t = Date.parse(e.commence_time); return t > now && t - now <= opts.window_h * 3600e3; })
    .sort((a, b) => Date.parse(a.commence_time) - Date.parse(b.commence_time));
  const label = (e) => e.id + ' ' + (e.away_team || '?') + ' @ ' + (e.home_team || '?') + ' ' + e.commence_time;
  log(tag + ': sport ' + L.sport + ' · event index HTTP ' + (ev.status || 200) + ' · events discovered ' + listed.length + ' · inside the ' + opts.window_h + ' h window ' + soon.length);
  if (listed.length) log(tag + ': discovered event ids ' + listed.map((e) => e.id).join(','));
  soon.forEach((e) => { eventsState[e.id] = eventRecord(eventsState[e.id], e); log(tag + ':   in window ' + label(e)); });
  const discovered = { events_discovered: listed.length, events_in_window: soon.length };
  /* the next game to ENTER the window is owed its first poll then */
  const entries = listed.map((e) => Date.parse(e.commence_time) - opts.window_h * 3600e3).filter((t) => Number.isFinite(t) && t > now);
  base.window_entry_at = entries.length ? new Date(Math.min.apply(null, entries)).toISOString() : null;
  if (!soon.length) {
    base.provider.last_http = ev.status || 200; base.provider.consecutive_failures = 0;
    const s = finish(Object.assign(base, discovered, { status: 'NO_MARKETS', reason: 'NO_EVENTS_IN_WINDOW', events_due: 0, events_checked: 0, events_polled: 0,
      why: 'The Odds API lists ' + listed.length + ' ' + L.label + ' events; none kicks off inside the next ' + opts.window_h + ' h, so no prop market was requested.' }), pace);
    s.closed_events = archiveFinished(P, league, now, opts.dry_run);
    log(tag + ': NO_MARKETS — no event inside the ' + opts.window_h + ' h window: nothing requested, nothing spent' + (s.closed_events ? ' · ' + s.closed_events + ' finished game(s) archived to the closes' : ''));
    return Object.assign({ skipped: 'no event inside the ' + opts.window_h + ' h window' }, s);
  }
  /* WHICH EVENTS ARE OWED A POLL. Each event keeps its own clock (EDProps
     FRESHNESS.cadence, by hours to kickoff): a game days away is re-polled
     rarely, one about to kick off every 15 minutes. A failed event is retried
     on its back-off, sooner than its cadence. A manual refresh (--force) asks
     again for every event not captured in the last few minutes. */
  const only = opts.only_events && opts.only_events.length ? new Set(opts.only_events) : null;
  const slack = O.slack_min * 60e3;
  const minManual = EDP.FRESHNESS.manual.min_age_minutes * 60e3;
  const due = soon.filter((e) => {
    if (only && !only.has(e.id)) return false;
    const rec = eventsState[e.id], h = (Date.parse(e.commence_time) - now) / 3600e3;
    if (pace.near_only && h > 6 && !opts.force) return false;
    if (opts.force) return !rec.polled_ok_at || now - Date.parse(rec.polled_ok_at) >= minManual;
    const d = nextDue(rec, now, pace.factor);
    /* the slack absorbs the five-minute scheduler tick on a game's cadence;
       a failed game's back-off is honoured exactly */
    return d != null && d - (rec.failures > 0 ? 0 : slack) <= now;
  });
  if (!due.length) {
    /* nothing is owed: the last run's prices and state stand as they are */
    const every = EDP.FRESHNESS.cadence.map((c) => (c.within_h == null ? 'beyond' : 'inside ' + c.within_h + ' h') + ' every ' + c.every_min + ' min').join(', ');
    const why = opts.force ? 'manual refresh: every game in the window was captured in the last ' + EDP.FRESHNESS.manual.min_age_minutes + ' minutes (nothing re-bought)'
      : 'no event due: each was polled inside its interval (at most ' + every + ')';
    const archived = archiveFinished(P, league, now, opts.dry_run);
    log(tag + ': ' + why + ' — last status ' + (state.status || 'unknown') + ', last polled ' + (state.last_run || 'never') + (archived ? ' · ' + archived + ' finished game(s) archived to the closes' : ''));
    const fin = finalize(Object.assign({}, base, { status: state.status || null, reason: state.reason || null, last_attempt: state.last_attempt || null }), pace);
    return { league, status: null, last_status: state.status || null, skipped: why, events_discovered: listed.length, events_in_window: soon.length, events_due: 0, last_run: state.last_run || null,
      next_due_at: fin.next_due_at, health: fin.health, manual: !!opts.force };
  }
  const take = due.slice(0, opts.max_events);
  log(tag + ': events due ' + due.length + ', querying ' + take.length + ' · markets requested (' + markets.length + ') ' + markets.join(',') + ' · books requested (' + books.length + ') ' + books.join(',') + ' · budget ' + costPerEvent + ' credits per event, at most ' + opts.max_credits_run + ' this run' + (pace.reason ? ' · pacing: ' + pace.reason : ''));
  if (!opts.dry_run) writeState(P.capture_state, Object.assign({}, base, discovered, { status: 'RUNNING', events_due: due.length, why: 'A capture started at ' + attemptAt + ' and has not finished.' }));

  const polled = [], refused = {}, flagged = {}, requests = [], booksBack = new Set(), marketsBack = {};
  let remaining = ev.remaining, used = ev.used != null ? ev.used : null, spent = 0, calls = 0, attempts = 0, failed = 0, noMarkets = 0, outcomes = 0, stopped = null, nq = 0, suspect = 0;
  const prior = readJson(P.quotes);
  const priorCount = (id) => { const e = prior && prior.events && prior.events[id]; return e && Array.isArray(e.quotes) ? e.quotes.length : 0; };
  for (const e of take) {
    if (remaining != null && remaining - costPerEvent < opts.min_remaining) { stopped = 'credits below floor (' + remaining + ' remaining, floor ' + opts.min_remaining + ')'; break; }
    if (spent + costPerEvent > opts.max_credits_run) { stopped = 'run budget reached (' + spent + ' of ' + opts.max_credits_run + ')'; break; }
    const rec = eventsState[e.id];
    const url = API + '/sports/' + L.sport + '/events/' + encodeURIComponent(e.id) + '/odds?apiKey=' + encodeURIComponent(key)
      + '&markets=' + encodeURIComponent(markets.join(',')) + '&bookmakers=' + encodeURIComponent(books.join(',')) + '&oddsFormat=american&dateFormat=iso';
    attempts++;
    rec.attempted_at = attemptAt;
    /* ONE event is isolated from the rest: whatever it throws is its own
       failure, recorded on it, and the loop moves on */
    let r = null, err = null, tries = 0;
    for (let a = 1; a <= O.request_attempts; a++) {
      tries = a;
      try {
        r = await getter(url, { timeout_ms: O.timeout_ms });
        if (r && r.body && r.body.id && r.body.id !== e.id) throw Object.assign(new Error('event id mismatch'), { status: 'mismatch', body: 'asked for event ' + e.id + ', the provider answered for ' + r.body.id });
        err = null; break;
      } catch (x) {
        err = x; r = null;
        if (x && x.remaining != null) remaining = x.remaining;
        if (!transient(x) || a === O.request_attempts) break;
        await sleep(Math.round(O.retry_delay_ms * (0.75 + 0.5 * rnd())));
      }
    }
    if (r) {
      try {
        calls++; spent += r.last != null ? r.last : costPerEvent; if (r.remaining != null) remaining = r.remaining; if (r.used != null) used = r.used;
        const cs = census(r.body);
        const parsed = parseEventProps(r.body, attemptAt);
        Object.keys(parsed.refused).forEach((k) => { refused[k] = (refused[k] || 0) + parsed.refused[k]; });
        Object.keys(parsed.flagged).forEach((k) => { flagged[k] = (flagged[k] || 0) + parsed.flagged[k]; });
        cs.books.forEach((b) => booksBack.add(b));
        Object.keys(cs.markets).forEach((k) => { marketsBack[k] = (marketsBack[k] || 0) + cs.markets[k]; });
        outcomes += cs.outcomes;
        const req = { event_id: e.id, matchup: rec.matchup, kickoff: e.commence_time, http: r.status || 200, attempts: tries, ms: r.ms != null ? r.ms : null,
          books: cs.books.length, markets: Object.keys(cs.markets).length, outcomes: cs.outcomes, quotes: parsed.quotes.length, cost: r.last != null ? r.last : null, remaining: r.remaining != null ? r.remaining : null };
        /* AN EMPTY ANSWER WHERE THERE WERE PRICES is not trusted at once: the
           listing is kept (its prices age on their own clock) and the event is
           retried on the back-off; a second empty answer in a row is believed
           (the books pulled the markets) */
        const hadPrices = priorCount(e.id) > 0;
        const kickH = (Date.parse(e.commence_time) - now) / 3600e3;
        if (!cs.outcomes && hadPrices && (rec.empty_streak || 0) < 1 && kickH > 0.5) {
          suspect++; rec.empty_streak = (rec.empty_streak || 0) + 1; rec.failures = (rec.failures || 0) + 1;
          rec.next_retry_at = new Date(now + EDP.retryDelay(rec.failures, rnd()) * 60e3).toISOString();
          rec.last_http = r.status || 200; rec.last_error = 'empty answer where the last poll had prices (kept, retried)';
          req.suspect_empty = true; requests.push(req);
          log(tag + ': event ' + label(e) + ' → HTTP ' + (r.status || 200) + ' with NO markets where the last poll had ' + priorCount(e.id) + ' prices: kept the listing, retry at ' + rec.next_retry_at);
          continue;
        }
        if (!cs.outcomes) noMarkets++;
        rec.empty_streak = cs.outcomes ? 0 : (rec.empty_streak || 0) + 1;
        rec.polled_ok_at = attemptAt; rec.failures = 0; rec.next_retry_at = null; rec.last_http = r.status || 200; rec.last_error = null;
        rec.books = cs.books.length; rec.markets = Object.keys(cs.markets).length; rec.quotes = parsed.quotes.length;
        polled.push({ id: e.id, commence_time: e.commence_time, home_team: e.home_team, away_team: e.away_team, books: parsed.books, quotes: parsed.quotes });
        nq += parsed.quotes.length;
        requests.push(req);
        log(tag + ': event ' + label(e) + ' → HTTP ' + (r.status || 200) + ' · books ' + cs.books.length + (cs.books.length ? ' (' + cs.books.join(',') + ')' : '') + ' · markets ' + Object.keys(cs.markets).length
          + ' · outcomes ' + cs.outcomes + ' · quotes normalized ' + parsed.quotes.length + ' · cost ' + (r.last != null ? r.last : '?') + ' · remaining ' + (r.remaining != null ? r.remaining : '?') + (tries > 1 ? ' · after ' + tries + ' tries' : '') + (cs.outcomes ? '' : ' · MARKETS_NOT_RELEASED (no book has posted a requested player market)'));
      } catch (x) { err = Object.assign(x instanceof Error ? x : new Error(String(x)), { status: 'parse' }); }
    }
    if (err) {
      failed++;
      const er = errorOf(err, url);
      rec.failures = (rec.failures || 0) + 1; rec.last_http = er.http; rec.last_error = er.error.slice(0, 300);
      rec.next_retry_at = new Date(now + EDP.retryDelay(rec.failures, rnd()) * 60e3).toISOString();
      requests.push({ event_id: e.id, matchup: rec.matchup, kickoff: e.commence_time, http: er.http, attempts: tries, error: er.error, retry_at: rec.next_retry_at });
      log(tag + ': event ' + label(e) + ' → HTTP ' + er.http + (tries > 1 ? ' (after ' + tries + ' tries)' : '') + ' · body: ' + er.error + ' · markets requested: ' + markets.join(',') + ' · retry at ' + rec.next_retry_at);
      if (err.status === 429) {
        base.provider.rate_limited_until = new Date(now + Math.max(num(err.retry_after) || 0, EDP.FRESHNESS.rate_limit_minutes * 60) * 1000).toISOString();
        stopped = 'provider refused: 429 (rate limited until ' + base.provider.rate_limited_until + ')'; break;
      }
      if (err.status === 401) { stopped = 'provider refused: 401'; break; }
      const k = 'event failed: ' + er.http; refused[k] = (refused[k] || 0) + 1;
    }
  }

  let status, reason, why, errorMessage = null;
  const failList = requests.filter((q) => q.error).map((q) => q.event_id + ' HTTP ' + q.http + ': ' + q.error.slice(0, 200));
  /* three examples are enough to diagnose; every request is in `requests` */
  const failures = failList.length > 3 ? failList.slice(0, 3).concat(['… ' + (failList.length - 3) + ' more']) : failList;
  if (nq > 0) {
    status = failed || stopped || suspect ? 'PARTIAL' : 'SUCCESS';
    reason = status === 'SUCCESS' ? 'QUOTES_WRITTEN' : (stopped ? 'STOPPED' : failed ? 'SOME_REQUESTS_FAILED' : 'SUSPECT_EMPTY_ANSWER');
    why = nq + ' prop prices from ' + booksBack.size + ' books across ' + polled.filter((p) => p.quotes.length).length + ' of ' + attempts + ' events queried' + (stopped ? '; the run stopped early: ' + stopped : '') + (failed ? '; ' + failed + ' requests failed (retried on back-off)' : '') + (suspect ? '; ' + suspect + ' empty answer' + (suspect === 1 ? '' : 's') + ' kept for a retry' : '') + '.';
    if (failed || stopped) errorMessage = (stopped ? stopped + (failures.length ? '; ' : '') : '') + failures.join('; ') || null;
  } else if (calls > 0 && !failed) {
    status = 'NO_MARKETS'; reason = suspect ? 'SUSPECT_EMPTY_ANSWER' : 'MARKETS_NOT_RELEASED';
    why = 'The Odds API answered for ' + calls + ' ' + L.label + ' event' + (calls === 1 ? '' : 's') + ' (HTTP 200) with no player market from any of the ' + books.length + ' books asked' + (suspect ? ' (where the last poll had prices: kept, and retried shortly)' : ': the books have not released these props yet') + '.' + (stopped ? ' The run stopped early: ' + stopped + '.' : '');
  } else {
    status = 'ERROR';
    reason = stopped && !failures.length ? 'STOPPED_BEFORE_REQUEST' : stopped && /provider refused/.test(stopped) ? 'PROVIDER_REFUSED' : 'REQUESTS_FAILED';
    errorMessage = (stopped ? stopped + (failures.length ? '; ' : '') : '') + failures.join('; ');
    why = 'No prop price was written: ' + errorMessage + '.';
  }
  /* the provider's own record: a clean answer resets its failure count */
  const lastReq = requests[requests.length - 1];
  base.provider.last_http = lastReq ? lastReq.http : (ev.status || 200);
  base.provider.requests_remaining = remaining; base.provider.requests_used = used;
  if (failed && !calls) { base.provider.consecutive_failures = (base.provider.consecutive_failures || 0) + 1; base.provider.last_error = failures[0] || stopped; }
  else if (calls) { base.provider.consecutive_failures = 0; if (!failed) base.provider.last_error = null; }
  if (!/429/.test(stopped || '') && base.provider.rate_limited_until && Date.parse(base.provider.rate_limited_until) <= now) base.provider.rate_limited_until = null;
  const allOk = nq > 0 && !failed && !stopped && !suspect && take.length === due.length;
  const summary = Object.assign(base, discovered, {
    status, reason, why, error_message: errorMessage,
    events_due: due.length, events_checked: attempts, events_polled: calls, events_failed: failed, events_no_markets: noMarkets, events_suspect_empty: suspect, event_ids: take.slice(0, attempts).map((e) => e.id),
    books_returned: Array.from(booksBack).sort(), markets_returned: marketsBack, outcomes_returned: outcomes,
    quotes: nq, quotes_normalized: nq, quotes_written: 0, refused, flagged, stopped,
    credits_spent: spent, requests_remaining: remaining, requests_used: used, requests,
    last_run: calls > 0 ? attemptAt : (state.last_run || null), last_success_at: nq > 0 ? attemptAt : (state.last_success_at || null),
    last_full_success_at: allOk ? attemptAt : (state.last_full_success_at || null) });
  if (!opts.dry_run) {
    fs.mkdirSync(P.dir, { recursive: true });
    const feed = buildQuotesFeed({ league, now, prior, polled, observed_at: attemptAt, markets, bookmakers: books });
    writeIfChanged(P.quotes, feed);
    summary.quotes_written = polled.reduce((n, p) => n + (feed.events[p.id] ? feed.events[p.id].quotes.length : 0), 0);
    summary.feed_quotes = feed.n_quotes; summary.feed_events = feed.n_events;
    summary.markets_closed = Object.keys(feed.events).reduce((n, id) => n + Object.keys(feed.events[id].closed || {}).length, 0);
    summary.quotes_carried = Object.keys(feed.events).reduce((n, id) => n + (feed.events[id].carried || 0), 0);
    const up = updateLines(readJson(P.lines), polled, attemptAt, now);
    up.lines.league = league;
    writeIfChanged(P.lines, up.lines);
    summary.closed_events = up.closed.length;
    if (up.closed.length) {
      fs.mkdirSync(P.season_dir, { recursive: true });
      fs.appendFileSync(P.closes, up.closed.map((c) => JSON.stringify(Object.assign({ schema: 'edgedesk_player_props_close_v1', league }, c))).join('\n') + '\n');
    }
  }
  finish(summary, pace);
  log(tag + ': ' + status + ' (' + reason + ') · events discovered ' + listed.length + ' · in window ' + soon.length + ' · queried ' + attempts + ' (answered ' + calls + ', failed ' + failed + ', no markets ' + noMarkets + (suspect ? ', suspect empty ' + suspect : '') + ')'
    + ' · books returned ' + booksBack.size + ' · markets returned ' + Object.keys(marketsBack).length + ' · outcomes ' + outcomes + ' · quotes normalized ' + nq + ' · quotes written ' + summary.quotes_written
    + ' · refused ' + JSON.stringify(refused) + ' · credits spent ' + spent + ' · remaining ' + (remaining != null ? remaining : '?') + (stopped ? ' · stopped: ' + stopped : '')
    + ' · health ' + summary.health.state + ' (' + summary.health.reason + ') · next due ' + (summary.next_due_at || 'none'));
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
  md += row('pipeline health', s.health ? s.health.state + ' — ' + s.health.reason + ': ' + s.health.text : null) + row('next poll due', s.next_due_at || null)
    + (s.provider && s.provider.rate_limited_until ? row('rate limited until', s.provider.rate_limited_until) : '') + (s.pacing && s.pacing.reason ? row('credit pacing', s.pacing.reason) : '');
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
    const envFresh = C.freshnessFromEnv();
    if (envFresh) { EDP.configureFreshness(envFresh); console.log('[props capture] freshness / cadence overrides from the environment: ' + JSON.stringify(envFresh)); }
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
    const envNum = (k, d) => { const v = process.env[k]; return v != null && String(v).trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : d; };
    const onlyEvents = String(arg('events', process.env.PROPS_REFRESH_EVENTS || '')).split(',').map((x) => x.trim()).filter(Boolean);
    run({ key, enabled, flag: { raw: raw === undefined ? null : raw, enabled, gated }, league, log: (m) => console.log(m),
      groups: arg('groups', process.env.PROPS_MARKET_GROUPS || '') ? String(arg('groups', process.env.PROPS_MARKET_GROUPS)).split(',').map((g) => g.trim()).filter(Boolean) : null,
      window_h: Number(arg('window-h', envNum('PROPS_WINDOW_H', D.window_h))), max_events: Number(arg('max-events', envNum('PROPS_MAX_EVENTS', D.max_events))),
      min_remaining: Number(arg('min-remaining', envNum('PROPS_MIN_REMAINING', D.min_remaining))),
      low_credits: envNum('PROPS_LOW_CREDITS', D.low_credits), critical_credits: envNum('PROPS_CRITICAL_CREDITS', D.critical_credits),
      max_credits_run: Number(arg('max-credits', envNum('PROPS_MAX_CREDITS', D.max_credits_run))),
      bookmakers: arg('bookmakers', process.env.PROPS_BOOKMAKERS || D.bookmakers), dry_run: flag('dry-run'), force: flag('force'),
      only_events: onlyEvents.length ? onlyEvents : null, trigger: arg('trigger', process.env.PROPS_TRIGGER || null),
      run_id: process.env.GITHUB_RUN_ID ? process.env.GITHUB_RUN_ID + '.' + (process.env.GITHUB_RUN_ATTEMPT || '1') : null,
      refresh_request_id: arg('refresh-request', process.env.PROPS_REFRESH_REQUEST || null) })
      .then((s) => {
        const brief = Object.assign({}, s); delete brief.requests; delete brief.polled_at; delete brief.events_state;
        console.log('[props capture] state ' + JSON.stringify(brief));
        /* one structured line per run: what football/props/health_sync.js and a log search read */
        console.log('[props capture] result ' + JSON.stringify({ league, status: s.status || null, reason: s.reason || null, skipped: s.skipped || null, health: s.health ? s.health.state : null,
          health_reason: s.health ? s.health.reason : null, next_due_at: s.next_due_at || null, events_polled: s.events_polled || 0, events_failed: s.events_failed || 0, quotes: s.quotes || 0,
          credits_spent: s.credits_spent || 0, requests_remaining: s.requests_remaining != null ? s.requests_remaining : null, rate_limited_until: s.rate_limited_until || (s.provider && s.provider.rate_limited_until) || null, duration_ms: s.duration_ms || null }));
        /* the run's own answer (a quiet run writes no state file): what
           football/props/health_sync.js records for this run */
        try { fs.mkdirSync(C.CACHE, { recursive: true }); fs.writeFileSync(path.join(C.CACHE, league + '_capture_result.json'), JSON.stringify(Object.assign({ recorded_at: new Date().toISOString() }, brief, { requests: s.requests || [] })) + '\n'); } catch (e) { /* the log has it */ }
        if (ci && s.status === 'ERROR') console.log('::error title=Player props capture (' + league + ')::' + (s.error_message || s.why));
        else if (ci && (s.status === 'PARTIAL' || s.status === 'NOT_RUN')) console.log('::warning title=Player props capture (' + league + ')::' + (s.status === 'NOT_RUN' ? s.why : s.error_message || s.why));
        stepSummary(s);
      })
      .catch((e) => { console.error('[props capture] failed: ' + scrub(e && e.stack || e)); if (ci) console.log('::error title=Player props capture (' + league + ')::' + scrub(e && e.message || e)); process.exit(0); });   /* fail soft: the state file says what happened */
  }
}
