#!/usr/bin/env node
/* ===========================================================================
   PLAYER PROPS CAPTURE — sportsbook player-prop quotes, timestamped.
   docs/player-props/MARKET.md · docs/runbooks/player-props.md

     ODDS_API_KEY=… node football/props/capture.js [--league nfl|cfb]
        [--now ISO] [--dry] [--max-events N] [--window-h H]
        [--bookmakers list] [--regions us] [--markets list]

   The template is football/cfb_terminal/alternates.js: the Odds API serves
   player props only from the per-event endpoint, which bills per market per
   region, so the run is budgeted — a window, an event cap, a per-event
   cadence that tightens near kickoff, a credit floor — and stops on 401/429.
   The event index is free.

   WHAT IT WRITES (all change-only; a price that did not move is not a tick)
     football/props/<league>/markets/<game_id>.json  the current quotes per
        prop (every book, main and alternates), the consensus history (every
        capture whose consensus moved), the first capture (the "opening"
        EdgeDesk saw) — what the board, the research page and the desk price
     football/props/<league>/market.json   the index: captures, per-game
        counts, UNMAPPED names (a sportsbook name that did not resolve to one
        player inside the game's two rosters — shown, never guessed), quota
     Supabase (when SB_URL and SB_SERVICE_ROLE are set, and the tables of
        supabase/player_props.sql exist): every tick into player_prop_quotes
        (append-only), the current state into player_prop_markets

   EVERY QUOTE CARRIES: game, player (EdgeDesk id + the book's own name),
   team, opponent, home/away, kickoff, prop type, line, Over price, Under
   price, sportsbook, the provider's last_update, EdgeDesk's capture time,
   provider, market key, alternate flag and market status.
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const P = require('../../lib/edgedesk_props.js');
const REG = require('./registry.js');
const { writeIfChanged } = require('../../tools/football/write_if_changed.js');

const ROOT = path.join(__dirname, '..', '..');
const API = process.env.ODDS_API_BASE || 'https://api.the-odds-api.com/v4';
const LEAGUES = { nfl: { sport: 'americanfootball_nfl', window_h: 96, max_events: 16 }, cfb: { sport: 'americanfootball_ncaaf', window_h: 48, max_events: 20 } };
const DEFAULTS = {
  regions: 'us',
  bookmakers: 'draftkings,fanduel,betmgm,williamhill_us,espnbet,betrivers,fanatics,hardrockbet',
  /* tier 1-2 main markets and their alternates; tier 3 and defence are opt-in (cost) */
  markets: P.oddsApiMarkets({ tiers: [1, 2], alternates: true }).concat(['player_anytime_td', 'player_reception_longest', 'player_rush_longest']).join(','),
  min_interval_h: 3, near_kickoff_h: 3, near_interval_min: 45, min_remaining: 500
};
function arg(n, d) { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; }
function readJson(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return d; } }
const num = (x) => { const n = Number(x); return x == null || x === '' || !isFinite(n) ? null : n; };
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  const remaining = num(res.headers.get('x-requests-remaining')), last = num(res.headers.get('x-requests-last'));
  if (!res.ok) throw Object.assign(new Error('HTTP ' + res.status + ' ' + url.replace(/apiKey=[^&]+/, 'apiKey=***')), { status: res.status, remaining });
  return { body: await res.json(), remaining, last };
}

/* ------------------------------------------------------------ games */
function nflGames(now) {
  const slate = readJson(path.join(ROOT, 'football', 'nfl', 'slate.json'), { games: [] });
  const FI = require('../../lib/football_identity.js');
  const byName = {};
  FI.NFL_TEAMS.forEach((t) => { [t[1]].concat(t[2]).forEach((n) => { byName[P.normName(n)] = t[0]; }); });
  const code = (n) => { const c = byName[P.normName(n)]; return c === 'LAR' ? 'LA' : c || null; };
  return { match: (ev) => {
    const h = code(ev.home_team), a = code(ev.away_team), t = Date.parse(ev.commence_time);
    const g = (slate.games || []).find((x) => x.home_code === h && x.away_code === a && Math.abs(Date.parse(x.kickoff) - t) < 36 * 3600e3);
    return g ? { game_id: g.game_id, home: g.home_code, away: g.away_code, kickoff: g.kickoff } : null;
  } };
}
function cfbGames(now, season) {
  const MK = require('../cfb_lab/market.js');
  const INTEL = require('../../supabase/functions/edgedesk_ai/_intelligence.js');
  const games = MK.scheduleGames(season);
  const slate = readJson(path.join(ROOT, 'football', 'fbs', 'slate.json'), { games: [] });
  return { match: (ev) => {
    const j = INTEL.joinSignalsToGames({ signals: [{ provider_event_id: ev.id, home_team: ev.home_team, away_team: ev.away_team, commence_time: ev.commence_time }], games });
    const gid = Object.keys(j.by_game || {})[0];
    if (!gid) return null;
    const sg = (slate.games || []).find((x) => String(x.game_id) === String(gid));
    return sg ? { game_id: String(gid), home: sg.home_team_id, away: sg.away_team_id, kickoff: sg.kickoff } : { game_id: String(gid), home: null, away: null, kickoff: ev.commence_time };
  } };
}

/* ------------------------------------------------ one event's odds → quotes */
function parseEvent(body, game, reg, overrides, observedAt, league, unmapped) {
  const quotes = [];
  const cands = REG.candidatesFor(reg, game.home).concat(REG.candidatesFor(reg, game.away));
  const cache = {};
  (body && body.bookmakers || []).forEach((bk) => {
    (bk.markets || []).forEach((mk) => {
      const pt = P.propTypeOfMarketKey(mk.key);
      if (!pt) return;
      P.pairOutcomes(mk.outcomes).forEach((q) => {
        const ck = q.player_name;
        let res = cache[ck];
        if (!res) { res = cache[ck] = P.resolvePlayer(q.player_name, cands, { overrides, league: league.toUpperCase(), team: '' }); }
        const pid = res.player_id;
        const person = pid ? reg.players[pid] : null;
        if (!pid) unmapped.push({ game_id: game.game_id, book: bk.key, market: mk.key, name: q.player_name, reason: res.reason, candidates: res.matched || [] });
        else if (res.method !== 'OVERRIDE' && res.method !== 'EXACT') REG.learnAlias(reg, pid, bk.key, q.player_name);
        const team = person ? person.team : null;
        const home = team && team === game.home;
        const row = { league: league.toUpperCase(), game_id: game.game_id, kickoff: game.kickoff, player_id: pid, player_name: q.player_name, mapping: res.method || res.reason, position: person ? person.position : null,
          team, opponent: team ? (home ? game.away : game.home) : null, home_away: team ? (home ? 'home' : 'away') : null, prop_type: pt.prop_type, market_key: mk.key, is_alternate: pt.alternate,
          book: bk.key, line: q.line, over: q.over, under: q.under, two_sided: q.two_sided, book_updated_at: mk.last_update || bk.last_update || null, captured_at: observedAt,
          provider: 'the-odds-api', market_status: 'open' };
        row.quote_id = 'pq_' + sha([row.game_id, row.book, row.market_key, P.normName(row.player_name), row.line, row.over, row.under, row.book_updated_at].join('|')).slice(0, 24);
        quotes.push(row);
      });
    });
  });
  return quotes;
}

/* the per-game market file: latest per (book, line, main|alt) per prop,
   plus the consensus history and the first capture */
function mergeGame(prev, quotes, game, observedAt) {
  const out = prev || { schema: 'edgedesk_props_market_v1', game_id: game.game_id, kickoff: game.kickoff, props: {}, history: {}, open: {}, captures: [] };
  const fresh = [];
  quotes.forEach((q) => {
    const k = q.game_id + '|' + (q.player_id || ('name:' + P.normName(q.player_name))) + '|' + q.prop_type;
    const list = out.props[k] || (out.props[k] = []);
    const slot = list.findIndex((x) => x.book === q.book && !!x.is_alternate === !!q.is_alternate && (q.is_alternate ? x.line === q.line : true));
    const same = slot >= 0 && list[slot].line === q.line && list[slot].over === q.over && list[slot].under === q.under;
    if (same) { list[slot].captured_at = q.captured_at; return; }
    if (slot >= 0) list[slot] = q; else list.push(q);
    fresh.push(q);
  });
  /* a book that stopped dealing a main line this capture is off the board */
  Object.keys(out.props).forEach((k) => {
    const cons = P.consensus(out.props[k], observedAt);
    if (!cons.books) return;
    const h = out.history[k] || (out.history[k] = []);
    const bo = cons.best_over, bu = cons.best_under;
    const snap = { at: observedAt, line: cons.consensus_line, novig_over: cons.novig_over == null ? null : Math.round(cons.novig_over * 10000) / 10000, over: bo ? bo.price : null, under: bu ? bu.price : null, books: cons.books };
    const last = h[h.length - 1];
    if (!last || last.line !== snap.line || last.novig_over !== snap.novig_over || last.books !== snap.books) h.push(snap);
    if (!out.open[k]) out.open[k] = Object.assign({ basis: 'the first capture EdgeDesk made (not necessarily the book’s opener)' }, snap);
  });
  out.captured_at = observedAt;
  out.captures = (out.captures || []).concat([observedAt]).slice(-60);
  return { market: out, fresh };
}

async function toSupabase(fresh, current) {
  const url = process.env.SB_URL || process.env.SUPABASE_URL, key = process.env.SB_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || !fresh.length) return { skipped: !url || !key ? 'no SB_URL / SB_SERVICE_ROLE' : 'nothing new' };
  const h = { apikey: key, authorization: 'Bearer ' + key, 'content-type': 'application/json', prefer: 'resolution=ignore-duplicates,return=minimal' };
  const rows = fresh.map((q) => ({ quote_id: q.quote_id, league: q.league, game_id: q.game_id, kickoff: q.kickoff, player_id: q.player_id, book_player_name: q.player_name, mapping_method: q.mapping, team: q.team, opponent: q.opponent,
    home_away: q.home_away, prop_type: q.prop_type, market_key: q.market_key, is_alternate: q.is_alternate, book: q.book, line: q.line, over_price: q.over, under_price: q.under,
    book_updated_at: q.book_updated_at, captured_at: q.captured_at, provider: q.provider, market_status: q.market_status }));
  const out = {};
  for (let i = 0; i < rows.length; i += 500) {
    const r = await fetch(url + '/rest/v1/player_prop_quotes?on_conflict=quote_id', { method: 'POST', headers: h, body: JSON.stringify(rows.slice(i, i + 500)) });
    if (!r.ok) { out.error = 'player_prop_quotes HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200); break; }
  }
  const cur = current.map((q) => ({ market_key_id: [q.game_id, q.player_id || 'name:' + P.normName(q.player_name), q.prop_type, q.book, q.is_alternate ? 'alt:' + q.line : 'main'].join('|'), quote_id: q.quote_id, league: q.league, game_id: q.game_id,
    player_id: q.player_id, book_player_name: q.player_name, prop_type: q.prop_type, is_alternate: q.is_alternate, book: q.book, line: q.line, over_price: q.over, under_price: q.under, captured_at: q.captured_at, kickoff: q.kickoff, market_status: q.market_status }));
  for (let i = 0; i < cur.length && !out.error; i += 500) {
    const r = await fetch(url + '/rest/v1/player_prop_markets?on_conflict=market_key_id', { method: 'POST', headers: Object.assign({}, h, { prefer: 'resolution=merge-duplicates,return=minimal' }), body: JSON.stringify(cur.slice(i, i + 500)) });
    if (!r.ok) { out.error = 'player_prop_markets HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200); break; }
  }
  out.ticks = rows.length; out.current = cur.length;
  return out;
}

async function run(opts) {
  const league = (opts.league || 'nfl').toLowerCase(), L = LEAGUES[league];
  const now = opts.now || Date.now(), key = opts.key;
  const dir = opts.dir || path.join(__dirname, league), mdir = path.join(dir, 'markets');
  const index = readJson(path.join(dir, 'market.json'), { schema: 'edgedesk_props_market_index_v1', league: league.toUpperCase(), games: {}, unmapped: [], runs: [] });
  if (!key) return { league, skipped: 'no ODDS_API_KEY: nothing captured, nothing spent (the board shows PROJECTION ONLY)' };
  const getter = opts.getJson || getJson;
  const season = new Date(now).getUTCMonth() <= 1 ? new Date(now).getUTCFullYear() - 1 : new Date(now).getUTCFullYear();
  const matcher = league === 'nfl' ? nflGames(now) : cfbGames(now, season);
  const reg = REG.load(league.toUpperCase());
  const overrides = REG.overrides();
  const observedAt = new Date(now).toISOString();
  let ev;
  try { ev = await getter(API + '/sports/' + L.sport + '/events?apiKey=' + encodeURIComponent(key) + '&dateFormat=iso'); }
  catch (e) { return { league, skipped: 'event index failed: ' + (e.status || e.message) }; }
  const windowH = opts.window_h || L.window_h;
  const soon = (ev.body || []).filter((e) => { const t = Date.parse(e.commence_time); return t > now && t - now <= windowH * 3600e3; })
    .sort((a, b) => Date.parse(a.commence_time) - Date.parse(b.commence_time));
  let remaining = ev.remaining, calls = 0, stopped = null, spent = 0;
  const unmapped = [], summary = { league, observed_at: observedAt, events_in_window: soon.length, events_matched: 0, events_priced: 0, quotes: 0, fresh: 0, refused: {} };
  for (const e of soon.slice(0, opts.max_events || L.max_events)) {
    const game = matcher.match(e);
    if (!game) { summary.refused['event not matched to an EdgeDesk game'] = (summary.refused['event not matched to an EdgeDesk game'] || 0) + 1; continue; }
    summary.events_matched++;
    /* cadence: every min_interval_h, tightening to near_interval_min inside near_kickoff_h */
    const gi = index.games[game.game_id];
    const ttk = (Date.parse(e.commence_time) - now) / 3600e3;
    const gap = ttk <= DEFAULTS.near_kickoff_h ? DEFAULTS.near_interval_min / 60 : (opts.min_interval_h || DEFAULTS.min_interval_h);
    if (gi && gi.captured_at && now - Date.parse(gi.captured_at) < gap * 3600e3 && !opts.force) { summary.refused['captured recently'] = (summary.refused['captured recently'] || 0) + 1; continue; }
    if (remaining != null && remaining < (opts.min_remaining == null ? DEFAULTS.min_remaining : opts.min_remaining)) { stopped = 'credits below floor (' + remaining + ')'; break; }
    let r;
    try {
      r = await getter(API + '/sports/' + L.sport + '/events/' + encodeURIComponent(e.id) + '/odds?apiKey=' + encodeURIComponent(key) + '&regions=' + encodeURIComponent(opts.regions || DEFAULTS.regions)
        + '&markets=' + encodeURIComponent(opts.markets || DEFAULTS.markets) + (opts.bookmakers || DEFAULTS.bookmakers ? '&bookmakers=' + encodeURIComponent(opts.bookmakers || DEFAULTS.bookmakers) : '') + '&oddsFormat=american&dateFormat=iso');
    } catch (err) {
      if (err.status === 401 || err.status === 429) { stopped = 'provider refused: ' + err.status; break; }
      summary.refused['event failed: ' + (err.status || 'network')] = (summary.refused['event failed: ' + (err.status || 'network')] || 0) + 1; continue;
    }
    calls++; if (r.remaining != null) remaining = r.remaining; if (r.last != null) spent += r.last;
    const quotes = parseEvent(r.body, game, reg, overrides, observedAt, league, unmapped);
    const file = path.join(mdir, game.game_id + '.json');
    const merged = mergeGame(readJson(file, null), quotes, game, observedAt);
    summary.events_priced++; summary.quotes += quotes.length; summary.fresh += merged.fresh.length;
    index.games[game.game_id] = { captured_at: observedAt, kickoff: game.kickoff, props: Object.keys(merged.market.props).length, quotes: quotes.length, provider_event_id: e.id };
    if (!opts.dry) {
      writeIfChanged(file, merged.market);
      if (opts.supabase !== false) { const sb = await toSupabase(merged.fresh, quotes); if (sb.error) summary.refused['supabase: ' + sb.error] = 1; else if (sb.ticks) summary.supabase = (summary.supabase || 0) + sb.ticks; }
    }
  }
  summary.events_priced = calls; summary.stopped = stopped; summary.requests_remaining = remaining; summary.credits_spent = spent;
  summary.unmapped = unmapped.length;
  const seen = {};
  index.unmapped = unmapped.concat(index.unmapped || []).filter((u) => { const k = u.game_id + '|' + P.normName(u.name); if (seen[k]) return false; seen[k] = 1; return true; }).slice(0, 300);
  index.captured_at = calls ? observedAt : index.captured_at || null;
  index.runs = (index.runs || []).concat([summary]).slice(-40);
  if (!opts.dry) { writeIfChanged(path.join(dir, 'market.json'), index); if (!opts.dir) REG.save(reg, writeIfChanged); }
  return summary;
}

/* the board reads every captured game's market as one object */
function loadMarket(league, gameIds, dirOverride) {
  const dir = dirOverride || process.env.PROPS_MARKET_DIR_OVERRIDE || path.join(__dirname, league.toLowerCase());
  const idx = readJson(path.join(dir, 'market.json'), null);
  const out = { captured_at: idx ? idx.captured_at : null, props: {}, history: {}, open: {}, close: {}, unmapped: idx ? idx.unmapped || [] : [] };
  (gameIds || Object.keys((idx && idx.games) || {})).forEach((gid) => {
    const m = readJson(path.join(dir, 'markets', gid + '.json'), null);
    if (!m) return;
    Object.assign(out.props, m.props || {}); Object.assign(out.history, m.history || {}); Object.assign(out.open, m.open || {}); Object.assign(out.close, m.close || {});
  });
  return out;
}

module.exports = { run, parseEvent, mergeGame, loadMarket, DEFAULTS, LEAGUES };
if (require.main === module) {
  const league = arg('league', 'nfl');
  run({ league, key: process.env.ODDS_API_KEY, now: arg('now') ? Date.parse(arg('now')) : Date.now(), dry: process.argv.includes('--dry'), force: process.argv.includes('--force'),
    max_events: arg('max-events') ? Number(arg('max-events')) : null, window_h: arg('window-h') ? Number(arg('window-h')) : null, bookmakers: arg('bookmakers'), regions: arg('regions'), markets: arg('markets') })
    .then((s) => { console.log(JSON.stringify(s, null, 1)); process.exit(0); })
    .catch((e) => { console.error(e && e.stack || e); process.exit(1); });
}
