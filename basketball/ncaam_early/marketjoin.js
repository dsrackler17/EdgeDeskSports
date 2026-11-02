'use strict';
/* ===========================================================================
   NCAAM-EARLY — the market join: NCAAB prices from the boards the odds
   gateway has ALREADY bought (ncaam_es_ncaab_board reads
   public.odds_api_snapshots; nothing here buys, or calls the gateway), matched
   to the model's games, compared with the stored projections (market.js).

     parseBoard(boards)            the gateway boards -> one quote per event,
                                   book and market (decimal prices, the
                                   latest board wins); a malformed or live
                                   price is rejected with its reason
     matchEvents(targets, events, names, aliases)
                                   an ESPN game <- an odds event: both team
                                   names equal after normalising (or by an
                                   alias), commence within 3 h of the tip,
                                   exactly one candidate either way; anything
                                   else is left UNMATCHED, never guessed
     quotesFor(quotes, matches)    Map(game -> { spread, total, moneyline })
                                   in market.js's quote form, in the ESPN
                                   game's home / away orientation

   A board is a stored response of The Odds API v4 /odds (h2h, spreads,
   totals): [{ id, commence_time, home_team, away_team, bookmakers: [{ key,
   markets: [{ key, outcomes: [{ name, price, point }] }] }] }].
   =========================================================================== */
const MK = require('./market');

const MATCH_WINDOW_MS = 3 * 3600e3;
const MARKET = { h2h: 'moneyline', spreads: 'spread', totals: 'total' };

/* team names: accents, case, punctuation and '&' do not distinguish teams */
function norm(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/['‘’`.]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function toDecimal(price, fmt) {
  const p = Number(price);
  if (!Number.isFinite(p)) return null;
  if (fmt === 'american') return MK.decimalFromAmerican(p);
  return p > 1 ? p : null;
}

function parseBoard(boards) {
  const best = new Map(); const rejected = [];
  const rej = (reason, x) => rejected.push(Object.assign({ reason }, x));
  for (const b of boards || []) {
    const at = b && b.snapshot_at, atMs = Date.parse(at), fmt = (b && b.odds_format) || 'decimal';
    if (!Number.isFinite(atMs)) { rej('BOARD_WITHOUT_SNAPSHOT_TIME', { fingerprint: b && b.fingerprint }); continue; }
    for (const ev of (b.events || [])) {
      const ct = Date.parse(ev && ev.commence_time);
      if (!ev || !ev.id || !ev.home_team || !ev.away_team || !Number.isFinite(ct)) { rej('EVENT_INCOMPLETE', { event_id: ev && ev.id }); continue; }
      if (!(ct > atMs)) { rej('SEEN_AT_OR_AFTER_COMMENCE', { event_id: ev.id }); continue; }
      for (const bk of (ev.bookmakers || [])) {
        for (const m of ((bk && bk.markets) || [])) {
          const market = MARKET[m && m.key]; if (!market || !bk.key) continue;
          const outs = m.outcomes || [];
          const find = (name) => outs.filter((o) => o && o.name === name);
          const [oa, ob] = market === 'total' ? [find('Over'), find('Under')] : [find(ev.home_team), find(ev.away_team)];
          const base = { event_id: ev.id, book: bk.key, market };
          if (oa.length !== 1 || ob.length !== 1) { rej('OUTCOMES_NOT_ONE_EACH', base); continue; }
          const da = toDecimal(oa[0].price, fmt), db = toDecimal(ob[0].price, fmt);
          if (da == null || db == null) { rej('PRICE_INVALID', base); continue; }
          let line = null;
          if (market === 'spread') {
            const pa = Number(oa[0].point), pb = Number(ob[0].point);
            if (!Number.isFinite(pa) || !Number.isFinite(pb) || Math.abs(pa + pb) > 1e-9) { rej('SPREAD_POINTS_NOT_OPPOSITE', base); continue; }
            line = pa;
          } else if (market === 'total') {
            const pa = Number(oa[0].point), pb = Number(ob[0].point);
            if (!Number.isFinite(pa) || pa !== pb || !(pa > 0)) { rej('TOTAL_POINTS_DIFFER', base); continue; }
            line = pa;
          }
          const q = Object.assign(base, { commence_time: new Date(ct).toISOString(), home_team: ev.home_team, away_team: ev.away_team, line,
            price_a: da, price_b: db, captured_at: new Date(atMs).toISOString(), snapshot_fingerprint: b.fingerprint || null });
          const k = q.event_id + '|' + q.book + '|' + q.market;
          if (!best.has(k) || Date.parse(best.get(k).captured_at) < atMs) best.set(k, q);
        }
      }
    }
  }
  return { quotes: [...best.values()], rejected };
}

/** targets: [{ game_id, home_espn, away_espn, start_utc }]; events: [{ event_id,
    home_team, away_team, commence_time }]; names: Map(espn id -> name);
    aliases: Map(normalised odds name -> espn id) */
function matchEvents(targets, events, names, aliases) {
  aliases = aliases || new Map();
  const nameToEspn = new Map(); const dup = new Set();
  for (const [id, n] of names) { const k = norm(n); if (nameToEspn.has(k) && nameToEspn.get(k) !== String(id)) dup.add(k); nameToEspn.set(k, String(id)); }
  for (const k of dup) nameToEspn.delete(k);   // a name two teams share identifies neither
  const resolve = (n) => { const k = norm(n); return aliases.has(k) ? String(aliases.get(k)) : (nameToEspn.get(k) || null); };
  const evs = [...new Map(events.map((e) => [e.event_id, e])).values()].map((e) => Object.assign({}, e, { h: resolve(e.home_team), a: resolve(e.away_team), ms: Date.parse(e.commence_time) }));
  const out = new Map(); const claimed = new Map();
  for (const t of targets) {
    const H = String(t.home_espn), A = String(t.away_espn), tip = Date.parse(t.start_utc);
    const c = evs.filter((e) => e.h && e.a && Math.abs(e.ms - tip) <= MATCH_WINDOW_MS && ((e.h === H && e.a === A) || (e.h === A && e.a === H)));
    if (c.length !== 1) { out.set(String(t.game_id), { status: c.length ? 'AMBIGUOUS' : 'UNMATCHED', candidates: c.length }); continue; }
    const e = c[0];
    out.set(String(t.game_id), { status: 'MATCHED', event_id: e.event_id, swapped: e.h !== H, basis: e.h === H ? 'NAMES_AND_TIP' : 'NAMES_AND_TIP_HOME_AWAY_SWAPPED' });
    claimed.set(e.event_id, (claimed.get(e.event_id) || []).concat(String(t.game_id)));
  }
  for (const [, games] of claimed) if (games.length > 1) for (const g of games) out.set(g, { status: 'AMBIGUOUS', candidates: 1, note: 'one odds event fits ' + games.length + ' games' });
  const unresolved = [...new Set(evs.flatMap((e) => [e.h ? null : e.home_team, e.a ? null : e.away_team]).filter(Boolean))].sort();
  return { matches: out, unresolved_names: unresolved };
}

/** quotes (parseBoard) -> Map(game -> { spread, total, moneyline }) in the
    game's own orientation: a swapped event's home price is the game's away
    price, and its home spread the negative of the game's */
function quotesFor(quotes, matches) {
  const byEvent = new Map();
  for (const q of quotes) { if (!byEvent.has(q.event_id)) byEvent.set(q.event_id, []); byEvent.get(q.event_id).push(q); }
  const out = new Map();
  for (const [game, m] of matches) {
    if (m.status !== 'MATCHED') continue;
    const g = { spread: [], total: [], moneyline: [] };
    for (const q of byEvent.get(m.event_id) || []) {
      const flip = m.swapped && q.market !== 'total';
      g[q.market].push({ book: q.book, line: q.market === 'spread' && flip ? -q.line : q.line, dec_a: flip ? q.price_b : q.price_a, dec_b: flip ? q.price_a : q.price_b, captured_at: q.captured_at });
    }
    out.set(game, g);
  }
  return out;
}

module.exports = { norm, toDecimal, parseBoard, matchEvents, quotesFor, MATCH_WINDOW_MS };
