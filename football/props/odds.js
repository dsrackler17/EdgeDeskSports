/* ===========================================================================
   EdgeDesk player props — OBSERVED SPORTSBOOK PROP QUOTES (Phase C).

   Extends the existing The Odds API integration the way the alternate-spread
   capture does (football/cfb_terminal/alternates.js): the same provider, the
   same key (ODDS_API_KEY), the per-event endpoint (the bulk /odds endpoint
   does not serve player props), the free /events index, a credit floor read
   from x-requests-remaining, a minimum interval, a stop on 401/429 and a
   change-only append-only ledger. The production capture edge function is NOT
   changed: it keys outcomes by name|point and ignores the player (the
   `description` field), so two players' overs would collide there.

   EVERY quote this file produces is lineage = 'observed'. There is no code
   path here that writes 'reconstructed'; a reconstructed research line is a
   different dataset built by a different job, with its own provider name
   ('edgedesk_reconstruction'), and the database refuses to let the two meet in
   a backtest or a calibration (supabase/player_props.sql).

   PROVIDER LABELS END HERE. player_pass_yds → pass_yards (config/markets.json
   provider_map). An unmapped market key is quarantined as UNMAPPED_MARKET and
   its raw payload kept; it is never guessed.

   PLAYER RESOLUTION IS TEAM-SCOPED. The provider names a player by display
   name only. A name is resolved against the players of THE TWO TEAMS IN THIS
   GAME (their recent history), never against the whole league; no match or
   two matches = quarantined as UNRESOLVED_PLAYER with the raw name.

   HISTORICAL BACKFILL (--historical). /v4/historical/sports/{sport}/events and
   /events/{id}/odds?date=… — props history from 2023-05-03, at 10x the credit
   cost of a live call. Snapshots are taken at fixed offsets before kickoff
   (default 24 h, 6 h, 60 min, 10 min) so opener-ish, mid and closing prices
   exist per event. Budgeted and resumable: an event × offset already in the
   ledger is skipped.
   =========================================================================== */
'use strict';
const path = require('path');
const crypto = require('crypto');
const io = require('./lib/io.js');
const qa = require('./qa.js');
const FI = require('../../lib/football_identity.js');
const identity = require('./identity.js');
const cfbSrc = require('./sources/cfb.js');
const nflSrc = require('./sources/nfl.js');
const MK = require('./config/markets.json');

const API = 'https://api.the-odds-api.com/v4';
const PROVIDER = 'the-odds-api';
const SPORT = { NFL: 'americanfootball_nfl', CFB: 'americanfootball_ncaaf' };
const DEFAULTS = { window_h: 96, max_events: 16, min_interval_h: 2, min_remaining: 50, regions: null,
  bookmakers: 'draftkings,fanduel,betmgm,williamhill_us,espnbet,betrivers,hardrockbet,fanatics,pinnacle,bovada',
  markets: 'player_pass_yds,player_pass_tds,player_pass_completions,player_pass_attempts,player_pass_interceptions,player_rush_yds,player_rush_attempts,player_reception_yds,player_receptions,player_anytime_td,player_pass_rush_yds,player_rush_reception_yds,player_reception_longest,player_rush_longest,player_pass_longest_completion,player_reception_tds,player_rush_tds',
  alt_markets: 'player_pass_yds_alternate,player_rush_yds_alternate,player_reception_yds_alternate,player_receptions_alternate,player_rush_reception_yds_alternate,player_pass_rush_yds_alternate',
  historical_offsets_min: [1440, 360, 60, 10], HISTORICAL_FROM: '2023-05-03T00:00:00Z' };
const MAP = new Map(MK.provider_map.filter((m) => m.provider === PROVIDER).map((m) => [m.provider_market_key, m]));
const LEDGER = path.join(io.CACHE, 'ledger');

function sha(x) { return crypto.createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex'); }
function iso(t) { const v = typeof t === 'number' ? t : Date.parse(t); return isFinite(v) ? new Date(v).toISOString() : null; }
function num(x) { if (x === null || x === undefined || x === '') return null; const n = Number(x); return isFinite(n) ? n : null; }

/* the deterministic quote id the workbook's loader defines, over the fields
   that make a quote distinct (provider, game, player, market, book, snapshot,
   side, line, price) */
function quoteId(q) {
  return 'pq_' + sha([q.provider, q.game_id, q.player_id, q.market_key, q.sportsbook, q.snapshot_at, q.side, q.line == null ? '' : q.line, q.american_price].join('|')).slice(0, 32);
}
/* change detection ignores the snapshot time: a price that did not move is not a new row */
function fingerprint(q) { return sha([q.game_id, q.player_id, q.market_key, q.sportsbook, q.side, q.line == null ? '' : q.line, q.american_price].join('|')).slice(0, 24); }

/* ------------------------------------------------------------ games & teams */
function registryFor(league, games) {
  if (league === 'NFL') {
    const teams = FI.NFL_TEAMS.map((t) => ({ id: nflSrc.code(t[0]), name: t[1], code: t[0], aliases: [t[0]].concat(t[2] || []) }));
    return FI.buildRegistry('NFL', teams);
  }
  const names = new Map();
  (games || []).forEach((g) => { if (g.home_team_name) names.set(String(g.home_team_id), g.home_team_name); if (g.away_team_name) names.set(String(g.away_team_id), g.away_team_name); });
  const teams = Array.from(cfbSrc.TEAM.values()).map((t) => ({ id: String(t.espn_team_id), name: names.get(String(t.espn_team_id)) || t.name, aliases: [t.key, t.name] }));
  return FI.buildRegistry('CFB', teams);
}
function linkEvent(reg, league, ev, games) {
  const pool = games.map((g) => ({ game_id: g.game_id, sport: league, season: g.season, home_team_id: String(g.home_team_id), away_team_id: String(g.away_team_id), kickoff_at: g.kickoff_utc,
    external_ref: g.espn_event_id ? 'espn:' + g.espn_event_id : null }));
  return FI.matchEvent(reg, { source: PROVIDER, source_event_id: ev.id, sport: league, home_name: ev.home_team, away_name: ev.away_team, kickoff_at: ev.commence_time }, pool, { toleranceMinutes: 36 * 60 });
}

/* team-scoped player resolution: roster = [{player_id, name, team_id}] of the
   two teams in this game */
function resolvePlayer(roster, rawName) {
  const k = identity.normName(rawName);
  if (!k) return { player_id: null, reason: 'empty name' };
  let hits = roster.filter((p) => identity.normName(p.name) === k);
  if (!hits.length) hits = roster.filter((p) => identity.namesAgree(p.name, rawName));
  const ids = Array.from(new Set(hits.map((h) => h.player_id)));
  if (ids.length === 1) return { player_id: ids[0], method: hits[0] && identity.normName(hits[0].name) === k ? 'team_scoped_exact' : 'team_scoped_variant', team_id: hits[0].team_id };
  if (ids.length > 1) return { player_id: null, reason: 'AMBIGUOUS in this game: ' + ids.join(', ') };
  return { player_id: null, reason: 'no player of either team is named ' + rawName };
}

/* ------------------------------------------------------------ parse
   One event's odds payload → normalised observed quotes. `ctx` = {game,
   roster, observedAt, league}. Anything that is not a possible quote is
   refused and counted, never repaired. */
function parseEventOdds(ev, ctx) {
  const out = { quotes: [], quarantined: [], refused: {}, books: 0, listings: [] };
  const refuse = (why, raw) => { out.refused[why] = (out.refused[why] || 0) + 1; if (raw) out.quarantined.push(Object.assign({ reason: why }, raw)); };
  if (!ev || !Array.isArray(ev.bookmakers)) { refuse('no bookmakers array'); return out; }
  const g = ctx.game, kick = Date.parse(g.kickoff_utc);
  const snap = ctx.observedAt;
  const payloadHash = sha(ev).slice(0, 32);
  for (const bk of ev.bookmakers) {
    if (!bk || !bk.key || !Array.isArray(bk.markets)) { refuse('malformed bookmaker'); continue; }
    out.books++;
    for (const mk of bk.markets) {
      const map = MAP.get(mk.key);
      if (!map) { refuse('UNMAPPED_MARKET', { provider_market_key: mk.key, sportsbook: bk.key }); continue; }
      const stamp = iso(mk.last_update || bk.last_update) || snap;
      const seen = new Set();
      for (const o of mk.outcomes || []) {
        const name = String(o.name || '').trim(), desc = String(o.description || '').trim();
        let side = name.toLowerCase(), playerName = desc;
        if (side !== 'over' && side !== 'under' && side !== 'yes' && side !== 'no') {
          /* some books list the player as the outcome name on yes/no markets */
          if (map.market_key === 'anytime_td' || map.market_key === 'first_td') { side = 'yes'; playerName = name; }
          else { refuse('side is neither over/under nor yes/no', { provider_market_key: mk.key, sportsbook: bk.key, outcome: name }); continue; }
        }
        const who = resolvePlayer(ctx.roster, playerName);
        if (!who.player_id) { refuse('UNRESOLVED_PLAYER', { provider_market_key: mk.key, sportsbook: bk.key, source_player_name: playerName, why: who.reason }); continue; }
        const line = num(o.point), price = num(o.price);
        const q = { provider: PROVIDER, lineage: 'observed', league: ctx.league, game_id: g.game_id, player_id: who.player_id, team_id: who.team_id || null, market_key: map.market_key,
          source_market_key: mk.key, source_player_name: playerName, player_match: who.method, sportsbook: bk.key, snapshot_at: snap, provider_updated_at: stamp,
          minutes_to_kick: Math.round((kick - Date.parse(snap)) / 60000), side, line: side === 'yes' || side === 'no' ? null : line,
          american_price: price == null ? null : Math.round(price), is_alt_line: !!map.is_alternate, is_main_line: !map.is_alternate,
          provider_event_id: ev.id || null, source_payload_hash: payloadHash };
        const chk = qa.checkQuote(q);
        if (chk.errors.length) { refuse(chk.errors[0][0], Object.assign({ provider_market_key: mk.key, sportsbook: bk.key, source_player_name: playerName }, { errors: chk.errors.map((e) => e.join(': ')) })); continue; }
        const dk = [q.player_id, q.market_key, q.side, q.line, q.is_alt_line].join('|');
        if (seen.has(dk)) { refuse('duplicate outcome'); continue; }
        seen.add(dk);
        q.decimal_price = q.american_price > 0 ? 1 + q.american_price / 100 : 1 + 100 / -q.american_price;
        q.implied_prob = 1 / q.decimal_price;
        q.quote_id = quoteId(q); q.fingerprint = fingerprint(q);
        out.quotes.push(q);
      }
    }
  }
  /* THE LISTING: every key each book offered at this snapshot, per player and
     market. Prices are stored change-only; the listing is what says a line was
     WITHDRAWN (lib/player_props.js latestByBook). */
  const lst = new Map();
  out.quotes.forEach((q) => {
    const k = q.sportsbook + '|' + q.player_id + '|' + q.market_key;
    let l = lst.get(k);
    if (!l) { l = { league: ctx.league, game_id: g.game_id, player_id: q.player_id, market_key: q.market_key, sportsbook: q.sportsbook, snapshot_at: snap, keys: [] }; lst.set(k, l); }
    l.keys.push(q.side + '|' + (q.line == null ? '' : q.line) + '|' + (q.is_alt_line ? 1 : 0));
  });
  lst.forEach((l) => { l.keys.sort(); l.listing_id = 'pl_' + sha([l.game_id, l.player_id, l.market_key, l.sportsbook, l.snapshot_at].join('|')).slice(0, 28); out.listings.push(l); });
  /* the no-vig probability of each quote from its own book's pair (same
     snapshot, player, market, line) — stored on the quote (fact_prop_quote.no_vig_prob) */
  const byPair = new Map();
  out.quotes.forEach((q) => { const k = [q.sportsbook, q.player_id, q.market_key, q.line, q.is_alt_line].join('|'); let a = byPair.get(k); if (!a) { a = {}; byPair.set(k, a); } a[q.side] = q; });
  byPair.forEach((pairQ) => {
    const o = pairQ.over || pairQ.yes, u = pairQ.under || pairQ.no;
    if (o && u) { const s = o.implied_prob + u.implied_prob; if (s < 0.98 || s > 1.35) { o.pair_hold_out_of_bounds = u.pair_hold_out_of_bounds = true; return; } o.no_vig_prob = o.implied_prob / s; u.no_vig_prob = u.implied_prob / s; }
  });
  return out;
}

/* ------------------------------------------------------------ ledger */
function ledgerPath(league, season) { return path.join(LEDGER, league.toLowerCase(), String(season), 'quotes.jsonl'); }
function statePath(league, season) { return path.join(LEDGER, league.toLowerCase(), String(season), 'state.json'); }
function readLedger(league, season) { return io.readJsonl(ledgerPath(league, season)); }
function listingsPath(league, season) { return path.join(LEDGER, league.toLowerCase(), String(season), 'listings.jsonl'); }
function readListings(league, season) { return io.readJsonl(listingsPath(league, season)); }
/* a listing is appended when it differs from the last one stored for that (game, player, market, book) */
function appendListings(league, season, listings) {
  if (!listings.length) return 0;
  const last = new Map();
  readListings(league, season).forEach((l) => last.set([l.game_id, l.player_id, l.market_key, l.sportsbook].join('|'), l.keys.join(',')));
  const fresh = listings.filter((l) => last.get([l.game_id, l.player_id, l.market_key, l.sportsbook].join('|')) !== l.keys.join(','));
  if (!fresh.length) return 0;
  const f = listingsPath(league, season);
  require('fs').mkdirSync(path.dirname(f), { recursive: true });
  require('fs').appendFileSync(f, fresh.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return fresh.length;
}
/* change-only: a quote is appended when its (game, player, market, book, side,
   line) price differs from the last stored one. History is never rewritten. */
function selectNew(stored, quotes) {
  const last = new Map();
  stored.forEach((q) => last.set([q.game_id, q.player_id, q.market_key, q.sportsbook, q.side, q.line, q.is_alt_line].join('|'), q.fingerprint));
  return quotes.filter((q) => last.get([q.game_id, q.player_id, q.market_key, q.sportsbook, q.side, q.line, q.is_alt_line].join('|')) !== q.fingerprint);
}
function appendLedger(league, season, rows) {
  if (!rows.length) return 0;
  const f = ledgerPath(league, season);
  require('fs').mkdirSync(path.dirname(f), { recursive: true });
  require('fs').appendFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return rows.length;
}

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  const remaining = num(res.headers.get('x-requests-remaining')), last = num(res.headers.get('x-requests-last'));
  if (!res.ok) throw Object.assign(new Error('HTTP ' + res.status + ' ' + url.replace(/apiKey=[^&]+/, 'apiKey=***')), { status: res.status, remaining });
  return { body: await res.json(), remaining, last };
}

/* rosters of the two teams (recent players, from the warehouse) */
function rosterFor(wh, league, game, season) {
  const L = wh.leagues[league];
  const byId = new Map(wh.identity.players.map((p) => [p.player_id, p]));
  const out = new Map();
  L.playerGames.forEach((r) => {
    if (!r.player_id || r.season < season - 1) return;
    if (r.team_id !== String(game.home_team_id) && r.team_id !== String(game.away_team_id)) return;
    const p = byId.get(r.player_id);
    out.set(r.player_id, { player_id: r.player_id, name: (p && p.full_name) || r.player_name, team_id: r.team_id });
    if (r.player_name && p && r.player_name !== p.full_name) out.set(r.player_id + '#alias', { player_id: r.player_id, name: r.player_name, team_id: r.team_id });
  });
  return Array.from(out.values());
}

/* ------------------------------------------------------------ live capture */
async function capture(wh, league, opts) {
  opts = Object.assign({}, DEFAULTS, opts || {});
  const key = opts.key, now = opts.now || Date.now(), season = opts.season || io.currentSeason(now);
  const getter = opts.getJson || getJson;
  if (!key) return { league, skipped: 'no ODDS_API_KEY: nothing captured, nothing spent' };
  const state = io.readJson(statePath(league, season), {});
  if (!opts.force && state.last_run && now - Date.parse(state.last_run) < opts.min_interval_h * 3600e3) return { league, skipped: 'ran ' + state.last_run + ' (every ' + opts.min_interval_h + ' h at most)' };
  const games = wh.leagues[league].games.filter((g) => g.status === 'scheduled' && Date.parse(g.kickoff_utc) > now && Date.parse(g.kickoff_utc) - now <= opts.window_h * 3600e3);
  const reg = registryFor(league, wh.leagues[league].games);
  let evs;
  try { evs = await getter(API + '/sports/' + SPORT[league] + '/events?apiKey=' + encodeURIComponent(key) + '&dateFormat=iso'); }
  catch (e) { return { league, skipped: 'event index failed: ' + (e.status || 'network') }; }
  const links = [], refusedLinks = {};
  (evs.body || []).forEach((ev) => {
    const t = Date.parse(ev.commence_time);
    if (!(t > now && t - now <= opts.window_h * 3600e3)) return;
    const m = linkEvent(reg, league, ev, games);
    if (m.game_id) links.push({ ev, game: games.find((g) => g.game_id === m.game_id), method: m.method });
    else refusedLinks[m.reason] = (refusedLinks[m.reason] || 0) + 1;
  });
  links.sort((a, b) => Date.parse(a.game.kickoff_utc) - Date.parse(b.game.kickoff_utc));
  const take = links.slice(0, opts.max_events);
  const observedAt = new Date(now).toISOString();
  const all = [], quarantined = [], refused = {}, listings = [];
  let remaining = evs.remaining, calls = 0, stopped = null;
  const markets = [opts.markets, opts.alt ? opts.alt_markets : null].filter(Boolean).join(',');
  for (const l of take) {
    if (remaining != null && remaining < opts.min_remaining) { stopped = 'credits below floor (' + remaining + ' < ' + opts.min_remaining + ')'; break; }
    try {
      const url = API + '/sports/' + SPORT[league] + '/events/' + encodeURIComponent(l.ev.id) + '/odds?apiKey=' + encodeURIComponent(key) + '&markets=' + encodeURIComponent(markets)
        + (opts.regions ? '&regions=' + encodeURIComponent(opts.regions) : '&bookmakers=' + encodeURIComponent(opts.bookmakers)) + '&oddsFormat=american&dateFormat=iso&includeMultipliers=false';
      const r = await getter(url);
      calls++; if (r.remaining != null) remaining = r.remaining;
      if (opts.rawSink) opts.rawSink({ league, game_id: l.game.game_id, provider_event_id: l.ev.id, observed_at: observedAt, payload: r.body });
      const parsed = parseEventOdds(r.body, { game: l.game, roster: rosterFor(wh, league, l.game, season), observedAt, league });
      all.push(...parsed.quotes); listings.push(...parsed.listings); quarantined.push(...parsed.quarantined.map((x) => Object.assign({ game_id: l.game.game_id }, x)));
      Object.keys(parsed.refused).forEach((k) => { refused[k] = (refused[k] || 0) + parsed.refused[k]; });
    } catch (e) {
      if (e.status === 429 || e.status === 401) { stopped = 'provider refused: ' + e.status; break; }
      refused['event failed: ' + (e.status || 'network')] = (refused['event failed: ' + (e.status || 'network')] || 0) + 1;
    }
  }
  const stored = readLedger(league, season);
  const fresh = selectNew(stored, all);
  const summary = { league, season, events_in_window: links.length, events_priced: calls, link_refused: refusedLinks, quotes: all.length, written: fresh.length,
    quarantined: quarantined.length, refused, stopped, requests_remaining: remaining, last_attempt: observedAt, last_run: calls > 0 ? observedAt : (state.last_run || null) };
  summary.listings_written = opts.dry_run ? 0 : appendListings(league, season, listings);
  if (!opts.dry_run) {
    appendLedger(league, season, fresh);
    io.writeJson(statePath(league, season), summary, true);
    if (quarantined.length) io.writeJsonl(path.join(LEDGER, league.toLowerCase(), String(season), 'quarantine_' + observedAt.replace(/[:.]/g, '') + '.jsonl'), quarantined);
  }
  summary.fresh = fresh;
  return summary;
}

/* ------------------------------------------------------------ historical backfill */
async function backfillHistorical(wh, league, opts) {
  opts = Object.assign({}, DEFAULTS, opts || {});
  const key = opts.key; const getter = opts.getJson || getJson;
  if (!key) return { league, skipped: 'no ODDS_API_KEY' };
  const from = Math.max(Date.parse(DEFAULTS.HISTORICAL_FROM), Date.parse(opts.from || DEFAULTS.HISTORICAL_FROM));
  const to = Math.min(Date.now(), Date.parse(opts.to || new Date().toISOString()));
  const games = wh.leagues[league].games.filter((g) => g.status === 'final' && Date.parse(g.kickoff_utc) >= from && Date.parse(g.kickoff_utc) <= to)
    .filter((g) => league !== 'CFB' || (g.home_division === 'fbs' && g.away_division === 'fbs'))
    .sort((a, b) => Date.parse(a.kickoff_utc) - Date.parse(b.kickoff_utc)).slice(0, opts.max_games || 25);
  const reg = registryFor(league, wh.leagues[league].games);
  const out = { league, games: games.length, calls: 0, written: 0, skipped_done: 0, stopped: null, remaining: null };
  for (const g of games) {
    const season = g.season, done = new Set(readLedger(league, season).filter((q) => q.game_id === g.game_id).map((q) => q.snapshot_at));
    for (const off of opts.historical_offsets_min) {
      const at = new Date(Date.parse(g.kickoff_utc) - off * 60000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      if (Array.from(done).some((s) => Math.abs(Date.parse(s) - Date.parse(at)) < 20 * 60000)) { out.skipped_done++; continue; }
      if (out.remaining != null && out.remaining < opts.min_remaining) { out.stopped = 'credits below floor'; return out; }
      try {
        const evs = await getter(API + '/historical/sports/' + SPORT[league] + '/events?apiKey=' + encodeURIComponent(key) + '&date=' + encodeURIComponent(at));
        out.calls++; out.remaining = evs.remaining;
        const list = (evs.body && evs.body.data) || [];
        const ev = list.find((e) => linkEvent(reg, league, e, [g]).game_id === g.game_id);
        if (!ev) continue;
        const r = await getter(API + '/historical/sports/' + SPORT[league] + '/events/' + encodeURIComponent(ev.id) + '/odds?apiKey=' + encodeURIComponent(key) + '&date=' + encodeURIComponent(at)
          + '&markets=' + encodeURIComponent(opts.markets) + '&bookmakers=' + encodeURIComponent(opts.bookmakers) + '&oddsFormat=american&dateFormat=iso');
        out.calls++; out.remaining = r.remaining;
        const snapAt = (r.body && r.body.timestamp) || at;
        const parsed = parseEventOdds((r.body && r.body.data) || r.body, { game: g, roster: rosterFor(wh, league, g, season), observedAt: iso(snapAt), league });
        const pre = parsed.quotes.filter((q) => Date.parse(q.snapshot_at) < Date.parse(g.kickoff_utc));
        const fresh = selectNew(readLedger(league, season), pre);
        out.written += appendLedger(league, season, fresh);
        appendListings(league, season, parsed.listings.filter((x) => Date.parse(x.snapshot_at) < Date.parse(g.kickoff_utc)));
      } catch (e) {
        if (e.status === 429 || e.status === 401 || e.status === 422) { out.stopped = 'provider refused: ' + e.status; return out; }
      }
    }
  }
  return out;
}

/* the current listing (latest per book/side/line) for upcoming games */
function currentQuotes(league, season, now) {
  const rows = readLedger(league, season);
  return rows.filter((q) => q.lineage === 'observed');
}

module.exports = { PROVIDER, SPORT, DEFAULTS, MAP, quoteId, fingerprint, parseEventOdds, resolvePlayer, rosterFor, registryFor, linkEvent, selectNew, readLedger, appendLedger, readListings, appendListings, listingsPath,
  capture, backfillHistorical, currentQuotes, ledgerPath };
