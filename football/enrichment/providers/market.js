/* ============================================================================
   MARKET PROVIDERS — every book EdgeDesk can see, not the first one it finds.

     cfb_lines         the Supabase cfb.lines table: every provider row per
                       game (the board already fetches all of them and kept
                       one; this keeps them all)
     capture_signals   EdgeDesk's own capture (public.signals): per point, the
                       best book and how many books quote it
     odds_api          The Odds API, per book, when ODDS_API_KEY is set
     lines_archive     football/pricing/lines_cfb.json (closing medians of past
                       seasons; never a current quote)

   The market is COMPARISON EVIDENCE: it feeds lib/market_consensus.js, the
   reliability scorer's market items and the diagnostics. It is never handed
   to the engine by this layer.

   The public read-only key the board already ships is read from app.html (or
   EDGEDESK_SB_URL / EDGEDESK_SB_ANON), so no credential is duplicated here.
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const MC = require('../../../lib/market_consensus.js');
const K = require('../core/cache.js');
const { http } = require('../core/provider.js');
const { ms, iso } = require('../core/lineage.js');

const ROOT = path.join(__dirname, '..', '..', '..');

function supabase() {
  let url = process.env.EDGEDESK_SB_URL || null, key = process.env.EDGEDESK_SB_ANON || null;
  if (!url || !key) {
    try {
      const head = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8').slice(0, 400000);
      const u = /var SB_URL="(https:\/\/[^"]+)"/.exec(head), k = /var SB_KEY="([^"]+)"/.exec(head);
      url = url || (u && u[1]); key = key || (k && k[1]);
    } catch (_) { /* not configured */ }
  }
  return url && key ? { url, key } : null;
}

const cfbLines = {
  name: 'cfb_lines', label: 'CFBD lines via Supabase cfb.lines (every provider)', kind: 'market', source_type: 'SECONDARY_STRUCTURED',
  role: 'MULTI-BOOK LINES',
  configured() { return supabase() ? true : 'no Supabase URL/anon key (app.html or EDGEDESK_SB_URL/EDGEDESK_SB_ANON)'; },
  async healthCheck() {
    const sb = supabase(); if (!sb) return null;
    return http(sb.url + '/rest/v1/lines?select=game_id&limit=1', { headers: { apikey: sb.key, authorization: 'Bearer ' + sb.key, 'accept-profile': 'cfb' },
      accept: (t) => { try { return Array.isArray(JSON.parse(t)) ? true : 'not a row list'; } catch (_) { return 'not JSON'; } } });
  },
  async fetchGames(ids, ledger) {
    const sb = supabase(); const out = {};
    if (!sb) return out;
    for (let i = 0; i < ids.length; i += 60) {
      const chunk = ids.slice(i, i + 60);
      const r = await http(sb.url + '/rest/v1/lines?select=*&game_id=in.(' + chunk.join(',') + ')',
        { headers: { apikey: sb.key, authorization: 'Bearer ' + sb.key, 'accept-profile': 'cfb' }, timeout_ms: 20000,
          accept: (t) => { try { return Array.isArray(JSON.parse(t)) ? true : 'not a row list'; } catch (_) { return 'not JSON'; } } });
      ledger.record('cfb_lines', { outcome: r.outcome, status: r.status, detail: r.detail, at: r.at, url: r.url, via: 'live' });
      if (!r.ok) { if (r.outcome === 'EGRESS_BLOCKED' || r.outcome === 'AUTH_FAILURE') break; continue; }
      JSON.parse(r.text).forEach((row) => { const g = String(row.game_id); (out[g] = out[g] || []).push(row); });
    }
    return out;
  },
  normalize(rows, at) {
    return rows.map((x) => ({ book: x.provider || 'provider', spread: typeof x.spread === 'number' ? x.spread : (x.spread != null ? +x.spread : null),
      total: x.over_under != null ? +x.over_under : null, ml_home: x.home_moneyline != null ? +x.home_moneyline : null,
      ml_away: x.away_moneyline != null ? +x.away_moneyline : null,
      timestamp: x.updated_at || x.last_updated || x.created_at || null, retrieved_at: at }))
      .filter((b) => !/consensus/i.test(b.book));   /* a provider's own "consensus" row is not a book */
  }
};

const captureSignals = {
  name: 'capture_signals', label: 'EdgeDesk capture (signals: books per point)', kind: 'market', source_type: 'SECONDARY_STRUCTURED',
  role: 'CAPTURED QUOTES',
  configured() { return supabase() ? true : 'no Supabase URL/anon key'; },
  async healthCheck() {
    const sb = supabase(); if (!sb) return null;
    return http(sb.url + '/rest/v1/signals?select=id&limit=1', { headers: { apikey: sb.key, authorization: 'Bearer ' + sb.key },
      accept: (t) => { try { return Array.isArray(JSON.parse(t)) ? true : 'not a row list'; } catch (_) { return 'not JSON'; } } });
  },
  async fetchWindow(fromIso, toIso, ledger) {
    const sb = supabase(); if (!sb) return [];
    const q = '/rest/v1/signals?select=event_id,market,selection,point,best_dec,best_book,n_books,home_team,away_team,commence_time,last_seen_at'
      + '&sport_key=eq.americanfootball_ncaaf&market=eq.spreads&commence_time=gte.' + fromIso + '&commence_time=lte.' + toIso + '&limit=2000';
    const r = await http(sb.url + q, { headers: { apikey: sb.key, authorization: 'Bearer ' + sb.key }, timeout_ms: 25000,
      accept: (t) => { try { return Array.isArray(JSON.parse(t)) ? true : 'not a row list'; } catch (_) { return 'not JSON'; } } });
    ledger.record('capture_signals', { outcome: r.outcome, status: r.status, detail: r.detail, at: r.at, url: r.url, via: 'live' });
    return r.ok ? JSON.parse(r.text) : [];
  },
  normalize() { return []; }
};

const oddsApi = {
  name: 'odds_api', label: 'The Odds API (per-book spreads, totals, moneylines)', kind: 'market', source_type: 'SECONDARY_STRUCTURED',
  role: 'PER-BOOK QUOTES',
  configured() { return process.env.ODDS_API_KEY ? true : 'ODDS_API_KEY is not set for this job (capture holds it as a Supabase function secret; the build does not)'; },
  async healthCheck() {
    if (!process.env.ODDS_API_KEY) return null;
    return http('https://api.the-odds-api.com/v4/sports?apiKey=' + encodeURIComponent(process.env.ODDS_API_KEY),
      { accept: (t) => { try { return Array.isArray(JSON.parse(t)) ? true : 'not a list'; } catch (_) { return 'not JSON'; } } });
  },
  normalize() { return []; }
};

const linesArchive = {
  name: 'lines_archive', label: 'Closing-line archive (football/pricing/lines_cfb.json)', kind: 'market', source_type: 'SECONDARY_STRUCTURED',
  role: 'HISTORICAL ONLY',
  configured() { return fs.existsSync(path.join(ROOT, 'football', 'pricing', 'lines_cfb.json')) ? true : 'no archive'; },
  async healthCheck() { return null; },
  normalize() { return []; }
};

const PROVIDERS = [cfbLines, captureSignals, oddsApi, linesArchive];

/* collect(ctx) -> { byGame: {gid: consensus}, sources: {gid: [...]} } */
async function collect(ctx) {
  const L = ctx.ledger, now = ms(ctx.now), cache = ctx.cache;
  const byGame = {};
  const ids = (ctx.slate || []).map((g) => g.game_id);
  const nk = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  let lines = {}, sig = [];
  if (ctx.live && cfbLines.configured() === true) lines = await cfbLines.fetchGames(ids, L);
  if (ctx.live && captureSignals.configured() === true) {
    const from = iso(now - 6 * 3600e3), to = iso(now + 14 * 86400e3);
    sig = await captureSignals.fetchWindow(from, to, L);
  }
  if (ctx.live && oddsApi.configured() === true) { const c = await oddsApi.healthCheck(); if (c) L.record('odds_api', { outcome: c.outcome, status: c.status, at: c.at, detail: c.detail, via: 'live health check' }); }
  const arc = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'pricing', 'lines_cfb.json'), 'utf8')); } catch (_) { return null; } })();
  if (arc) {
    const seasons = Object.values(arc.games || {}).map((g) => g.season).filter(Boolean);
    const last = seasons.length ? Math.max.apply(null, seasons) : null;
    L.record('lines_archive', { outcome: 'OK', status: 200, at: arc.generated_at, via: 'committed archive' });
    L.note('lines_archive', { content_stale_why: last != null && last < ctx.season ? 'the archive ends with the ' + last + ' season: closing medians of past games, never a current quote' : null,
      artifact_at: arc.generated_at });
  }
  (ctx.slate || []).forEach((g) => {
    const key = 'market:' + g.game_id;
    const fromLines = (lines[g.game_id] || []);
    const fromSig = sig.filter((r) => nk(r.home_team) && (nk(r.home_team).indexOf(nk(g.home.name)) === 0 || nk(g.home.name).indexOf(nk(r.home_team)) === 0)
      && (nk(r.away_team).indexOf(nk(g.away.name)) === 0 || nk(g.away.name).indexOf(nk(r.away_team)) === 0)
      && Math.abs(ms(r.commence_time) - ms(g.kickoff)) < 36 * 3600e3);
    let books = cfbLines.normalize(fromLines, iso(now));
    let points = fromSig.map((r) => ({ side: nk(r.selection || '') === nk(r.home_team) ? 'home' : 'away', line: r.point, n_books: r.n_books,
      best_book: r.best_book, price_dec: r.best_dec, captured_at: r.last_seen_at }));
    let carried = null;
    if (books.length || points.length) {
      K.put(cache, key, 'market', { value: { books, points }, source: books.length ? 'cfb.lines' : 'capture', observed_at: now, retrieved_at: now }, now);
    } else {
      const back = K.recall(cache, key, now);
      if (back.found && back.value) { books = back.value.books || []; points = back.value.points || []; carried = back; }
    }
    if (!books.length && !points.length) return;
    const c = MC.consensus(books.length ? { books } : { points }, now);
    c.sources = { cfb_lines: fromLines.length, capture_points: fromSig.length };
    if (carried) { c.carried = true; c.carried_reason = carried.reason; c.stale = !!carried.stale; }
    byGame[g.game_id] = c;
  });
  return { byGame };
}

module.exports = { PROVIDERS, collect, supabase };
