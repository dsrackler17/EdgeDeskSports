'use strict';
/* ===========================================================================
   The optional market layer: an adapter for executable quotes, nothing more.

   Research never waits for it. With no source configured, the pricing
   section of a page says "market comparison unavailable" and why; every
   team, player, lineup and matchup section is unaffected.

   Source: a file of timestamped bookmaker quotes in the data pack's
   market_quotes contract (datapack/ncaam_v1/schemas/shared/market_quotes.json:
   record_id, revision, event_id, bookmaker_id, market_type, period, selection,
   line, odds_decimal | odds_american, quote_at, captured_at, expires_at,
   suspended, overtime_included, push_possible, reported_limit, rules_version,
   quality_status, retrieved_at), at basketball/ncaam_research/market/quotes.json
   or .csv. EdgeDesk's odds gateway does not carry basketball (its sport
   allowlist excludes it), so no file is committed and none is fabricated.

   normalise() keeps the latest revision per record, refuses rows without a
   bookmaker, event, market, selection, price or capture time (counted, never
   guessed), maps market types to moneyline / spread / total for the FULL
   GAME only (halves, team totals and player markets are listed as
   unsupported: a game model does not validate them), and leaves every gate
   decision to lib/ncaam_research.js compareMarket.
   =========================================================================== */
const fs = require('fs');
const C = require('./config');
const { readCsv } = require('../../engine/csv');

const MARKET_MAP = { moneyline: 'moneyline', h2h: 'moneyline', ml: 'moneyline', spread: 'spread', handicap: 'spread', point_spread: 'spread', total: 'total', totals: 'total', over_under: 'total' };
const SIDE_MAP = { home: 'home', away: 'away', over: 'over', under: 'under' };

function source() {
  const json = C.PATHS.quotes; const csv = json.replace(/\.json$/, '.csv');
  if (fs.existsSync(json)) return { path: json, rows: JSON.parse(fs.readFileSync(json, 'utf8')) };
  if (fs.existsSync(csv)) return { path: csv, rows: readCsv(csv).rows };
  return null;
}

function bool(v) { return v === true || v === 'true' || v === 1 || v === '1'; }
function num(v) { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }

function normalise(rows) {
  const latest = new Map(); const refused = {};
  const refuse = (why) => { refused[why] = (refused[why] || 0) + 1; };
  for (const r of rows) {
    const id = r.record_id; if (!id) { refuse('NO_RECORD_ID'); continue; }
    const rev = num(r.revision) || 0; const cur = latest.get(id);
    if (!cur || rev > cur.rev) latest.set(id, { rev, r });
  }
  const quotes = []; const unsupported = [];
  for (const { r } of latest.values()) {
    if (r.quality_status && !['observed', 'estimated'].includes(r.quality_status)) { refuse('QUALITY_' + String(r.quality_status).toUpperCase()); continue; }
    const market = MARKET_MAP[String(r.market_type || '').toLowerCase()];
    const period = String(r.period || 'full_game').toLowerCase();
    if (!market || !['full_game', 'game', ''].includes(period) || r.player_id) { unsupported.push({ record_id: r.record_id, market_type: r.market_type, period: r.period, player_id: r.player_id || null }); continue; }
    const side = SIDE_MAP[String(r.selection || '').toLowerCase()]; if (!side) { refuse('UNKNOWN_SELECTION'); continue; }
    if (!r.event_id || !r.bookmaker_id) { refuse('NO_EVENT_OR_BOOK'); continue; }
    const dec = num(r.odds_decimal); const am = num(r.odds_american);
    if (dec == null && am == null) { refuse('NO_PRICE'); continue; }
    const seen = r.captured_at || r.retrieved_at; if (!seen) { refuse('NO_CAPTURE_TIME'); continue; }
    if (market !== 'moneyline' && num(r.line) == null) { refuse('NO_LINE'); continue; }
    quotes.push({
      record_id: r.record_id, game_id: Number(r.event_id), book: r.bookmaker_id, provider: r.source_id || null, market, side, line: num(r.line),
      decimal: dec, american: am, quote_at: r.quote_at || null, observed_at: seen, expires_at: r.expires_at || null,
      status: bool(r.suspended) ? 'suspended' : (r.expires_at && Date.parse(r.expires_at) < Date.now() ? 'expired' : 'open'),
      limit: num(r.reported_limit), rules: { overtime_included: r.overtime_included == null || r.overtime_included === '' ? null : bool(r.overtime_included), push_possible: r.push_possible == null ? null : bool(r.push_possible), version: r.rules_version || null },
    });
  }
  return { quotes, unsupported, refused };
}

/** the layer's state for the build: UNAVAILABLE with a reason, or the normalised quotes by game */
function load() {
  const src = source();
  if (!src) {
    return { status: 'UNAVAILABLE', reason: 'No men\'s college basketball odds source is configured: EdgeDesk\'s odds gateway does not capture basketball, and no quotes file in the market_quotes contract is present.', byGame: new Map() };
  }
  const n = normalise(src.rows); const byGame = new Map();
  for (const q of n.quotes) { if (!byGame.has(q.game_id)) byGame.set(q.game_id, []); byGame.get(q.game_id).push(q); }
  return { status: n.quotes.length ? 'LOADED' : 'EMPTY', source: src.path.replace(C.ROOT + '/', ''), quotes: n.quotes.length, unsupported: n.unsupported.length, refused: n.refused, byGame };
}

module.exports = { load, normalise, MARKET_MAP };
