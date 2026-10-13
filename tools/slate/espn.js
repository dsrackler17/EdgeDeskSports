'use strict';
/* ===========================================================================
   EdgeDesk slate — the ESPN scoreboard adapter, every sport the slate lists.

   ESPN's public, keyless site API is the feed this repository already reads
   for football schedules and finals (tools/collective/sync_schedule.js,
   tools/collective/settle_finals.js), college baseball (tools/cbb/ingest.js),
   UFC (tools/ufc/espn.js) and the CFB lab's quotes (football/cfb_lab/market.js).
   It is undocumented and carries no published licence; docs/games/README.md
   says what that means for production use and which licensed feeds replace it.

   THE REQUEST IS THE PLAIN ONE. One day per request, no custom User-Agent,
   accept: json, redirects followed. tools/ufc/espn.js records why: a date
   RANGE with a custom agent was answered 403 from a GitHub runner while the
   football jobs' plain one-day request was answered.

   NOTHING IS INVENTED. Events normalise through lib/edgedesk_games.js
   (EDGames.fromEspn); an event without two named sides or a start time is
   dropped and counted. Odds are read separately (marketFromEspn), only before
   the game starts, only through the orientation-checked line reader the
   football record already uses (tools/record/football_record_sources.js
   espnLine), and only when every side the market needs is priced.
   =========================================================================== */
const path = require('path');
const G = require(path.join(__dirname, '..', '..', 'lib', 'edgedesk_games.js'));
const SRC = require(path.join(__dirname, '..', 'record', 'football_record_sources.js'));

const ESPN_API = (process.env.ESPN_API || 'https://site.api.espn.com').replace(/\/$/, '');

/* ESPN keys a scoreboard by US Eastern calendar day */
function etDay(ms) { return G.dateKey(ms, 'America/New_York').replace(/-/g, ''); }

function scoreboardUrl(feed, ymd) {
  const q = ['dates=' + ymd, 'limit=' + (feed.limit || 500)];
  if (feed.groups) q.push('groups=' + feed.groups);
  return ESPN_API + '/apis/site/v2/sports/' + feed.path + '/scoreboard?' + q.join('&');
}

/* every (sport, feed) the slate reads, in pill order */
function feeds() {
  const out = [];
  G.SPORTS.forEach((s) => s.espn.forEach((f) => out.push(Object.assign({ sport: s.id, key: s.id + ':' + f.path }, f))));
  return out;
}

async function fetchJson(url, fetchImpl, timeoutMs) {
  const f = fetchImpl || ((...a) => fetch(...a));
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs || 12000) : null;
  const t0 = Date.now();
  try {
    const res = await f(url, { headers: { accept: 'application/json' }, redirect: 'follow', signal: ctl ? ctl.signal : undefined });
    const text = await res.text();
    if (!res.ok) { const e = new Error(res.status + ' from ' + url.split('?')[0]); e.status = res.status; throw e; }
    let json;
    try { json = text ? JSON.parse(text) : null; } catch (_) { const e = new Error('unparseable JSON from ' + url.split('?')[0]); e.status = res.status; throw e; }
    if (!json || typeof json !== 'object' || !Array.isArray(json.events)) { const e = new Error('no events array from ' + url.split('?')[0] + ' (schema drift?)'); e.status = res.status; throw e; }
    return { json, latency_ms: Date.now() - t0 };
  } finally { if (timer) clearTimeout(timer); }
}

/* --------------------------------------------------------------- MARKETS
   One ESPN odds object → the slate's market shape, or { reject } with why.
   ESPN sends the book it quotes (provider.name). A "consensus" or nameless
   quote is a number, not a book's price, and is refused. The line is read by
   the football record's orientation-checked reader (a disagreement between
   ESPN's own fields about WHICH side is favoured drops the line), and every
   part then passes the slate's one integrity check (EDGames.cleanMarket). */
function marketFromEspn(odds, event, capturedAt) {
  const sp = G.sport(event.sport);
  if (!odds || !sp) return { reject: 'no odds object' };
  const book = odds.provider && odds.provider.name ? String(odds.provider.name).trim() : '';
  if (!book || /consensus|average|opening/i.test(book)) return { reject: 'no named book (' + (book || 'none') + ')' };
  const line = SRC.espnLine(odds, event.home.abbr, event.away.abbr) || {};
  const px = line.prices || {};
  /* the moneyline does not depend on a line: espnLine reads nothing when a
     quote carries no spread and no total (a 1X2, a fight, a moneyline-only
     game), so the moneyline is read from the same two places directly */
  const pick = (o) => (o && (o.close || o.current)) || null;
  const ho = odds.homeTeamOdds || {}, ao = odds.awayTeamOdds || {}, mlb = odds.moneyline || {};
  const mlH = px.home_ml != null ? px.home_ml : (SRC.american(ho.moneyLine) != null ? ho.moneyLine : (pick(mlb.home) && pick(mlb.home).odds));
  const mlA = px.away_ml != null ? px.away_ml : (SRC.american(ao.moneyLine) != null ? ao.moneyLine : (pick(mlb.away) && pick(mlb.away).odds));
  const raw = {};
  if (mlH != null || mlA != null) {
    raw.moneyline = { home: SRC.american(mlH), away: SRC.american(mlA) };
    if (sp.draw) raw.moneyline.draw = SRC.american(odds.drawOdds && (odds.drawOdds.moneyLine != null ? odds.drawOdds.moneyLine : odds.drawOdds.odds));
  }
  if (line.home_line != null) raw.spread = { home: { point: line.home_line, price: px.home }, away: { point: line.home_line === 0 ? 0 : -line.home_line, price: px.away } };
  if (line.total != null) raw.total = { point: line.total, over: px.over, under: px.under };
  const c = G.cleanMarket(event.sport, raw);
  if (!c.market) return { reject: c.why.length ? c.why.join('; ') : 'no market with both sides priced' };
  const out = Object.assign({ book, source: 'espn_scoreboard', captured_at: capturedAt }, c.market);
  if (c.why.length) out.partial = c.why;
  return out;
}

/* ------------------------------------------------------------ ONE PAYLOAD
   → { events, markets: {id: market}, dropped, rejected } */
function parseScoreboard(json, feed, fetchedAt) {
  const events = [], markets = {}, dropped = [], rejected = [];
  ((json && json.events) || []).forEach((raw) => {
    const e = G.fromEspn(raw, { sport: feed.sport, league: feed.league, fetched_at: fetchedAt });
    if (!e) { dropped.push({ id: raw && raw.id, why: 'no two named sides or no start time' }); return; }
    events.push(e);
    /* odds only before the start: in-play prices are never read */
    if (e.status !== 'SCHEDULED' || Date.parse(e.start_utc) <= Date.parse(fetchedAt)) return;
    const comp = G.sport(e.sport).card ? null : (raw.competitions || [])[0];
    const list = (comp && comp.odds) || [];
    for (const o of list) {
      const m = marketFromEspn(o, e, fetchedAt);
      if (m.reject) { rejected.push({ id: e.id, book: o && o.provider && o.provider.name, why: m.reject }); continue; }
      markets[e.id] = m;
      break;
    }
  });
  return { events, markets, dropped, rejected };
}

/* Read one feed for one ET day. Never throws: { ok, error, ...parsed } */
async function readDay(feed, ymd, o) {
  o = o || {};
  const url = scoreboardUrl(feed, ymd);
  const fetchedAt = new Date(o.now != null ? o.now : Date.now()).toISOString();
  try {
    const r = await fetchJson(url, o.fetch, o.timeoutMs);
    const parsed = parseScoreboard(r.json, feed, fetchedAt);
    return Object.assign({ ok: true, feed: feed.key, day: ymd, url, fetched_at: fetchedAt, latency_ms: r.latency_ms }, parsed);
  } catch (e) {
    return { ok: false, feed: feed.key, day: ymd, url, fetched_at: fetchedAt, error: String((e && e.message) || e), status: e && e.status || null, events: [], markets: {}, dropped: [], rejected: [] };
  }
}

module.exports = { ESPN_API, etDay, scoreboardUrl, feeds, fetchJson, marketFromEspn, parseScoreboard, readDay };
