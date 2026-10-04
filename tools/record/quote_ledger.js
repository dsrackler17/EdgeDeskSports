/* ===========================================================================
   THE MODEL RECORD'S QUOTE LEDGER — every priced pregame sportsbook quote
   the football model record reads, kept. docs/pnl/DESIGN.md § Verified P&L

   The record job (tools/record/football_record.js) reads ESPN's scoreboard
   every hour for the games the model publishes numbers on: the book line
   ESPN carries and its prices. Until 2026-10-03 it kept only the first quote
   (lines only), the last one inside 36 h (overwritten) and the close, and
   threw every other observation away — so a model number could only be
   priced on the ~71 college games the CFB Model Lab happens to track, and an
   NFL number never.

   This keeps them: one row per (source, book, game, market) whenever a value
   changes, plus a heartbeat (the CFB Model Lab's own rule and code,
   football/cfb_lab/lab_core.js dedupeDecision: written on change, at least
   every 6 h, every 50 min inside 3 h of kickoff), stamped with the moment it
   was read and never after kickoff. Append-only: a row is never rewritten or
   removed. The rows have the lab's quote shape, so tools/record/price_lock.js
   reads both ledgers the same way (tools/record/pnl_config.json sources).

     record/football/quotes/<sport>_<season>.jsonl

   Pure except read() / append().
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const LAB = require(path.join(__dirname, '..', '..', 'football', 'cfb_lab', 'lab_core.js'));

const SCHEMA = 'edgedesk_record_quote_v1';
const DIR = 'record/football/quotes';

function num(v) { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function ms(t) { const v = Date.parse(t || ''); return Number.isFinite(v) ? v : null; }
function bookKey(b) { return String(b || '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }
function file(root, sport, season) { return path.join(root, DIR, String(sport).toLowerCase() + '_' + season + '.jsonl'); }

/**
 * One ESPN pregame market reading (football_record_sources espnLine: home
 * line, total, book, prices) → the quote rows it carries, one per market
 * that has a price. `at` is when it was read; nothing at or after kickoff.
 */
function rowsFromMarket(sport, gameId, m, at, kickoff, teams) {
  if (!m || !gameId || ms(at) == null) return [];
  if (ms(kickoff) != null && ms(at) >= ms(kickoff)) return [];
  const p = m.prices || {}, book = bookKey(m.book);
  if (!book || book === 'consensus') return [];
  const base = { schema: SCHEMA, sport: String(sport).toUpperCase(), game_id: String(gameId), source: m.source || 'espn', book: book, provider_book: m.book || null,
    observed_at: new Date(ms(at)).toISOString(), kickoff_ts: kickoff ? new Date(ms(kickoff)).toISOString() : null,
    is_pregame: true, is_provider_open: false, is_provider_close: false, home_team: (teams && teams.home) || null, away_team: (teams && teams.away) || null };
  const out = [];
  const mk = (market, o) => {
    const r = Object.assign({}, base, { market_type: market, home_line: null, total_points: null, price_home: null, price_away: null, price_over: null, price_under: null }, o);
    r.quote_id = 'edq_' + crypto.createHash('sha1').update([r.source, r.book, r.game_id, market, r.observed_at].join('|')).digest('hex').slice(0, 24);
    out.push(r);
  };
  if (num(m.home_line) != null && (num(p.home) != null || num(p.away) != null)) mk('spread', { home_line: num(m.home_line), price_home: num(p.home), price_away: num(p.away) });
  if (num(m.total) != null && (num(p.over) != null || num(p.under) != null)) mk('total', { total_points: num(m.total), price_over: num(p.over), price_under: num(p.under) });
  if (num(p.home_ml) != null || num(p.away_ml) != null) mk('moneyline', { price_home: num(p.home_ml), price_away: num(p.away_ml) });
  return out;
}

/** the latest stored row per (source, book, game, market) */
function latestByKey(rows) {
  const out = {};
  (rows || []).forEach((r) => { const k = LAB.quoteKey(r); if (!out[k] || ms(r.observed_at) >= ms(out[k].observed_at)) out[k] = r; });
  return out;
}
/**
 * The rows of `candidates` worth keeping against what is stored: written on a
 * change and on the heartbeat, refused when not a valid pregame quote
 * (lab_core.dedupeDecision — the same rule the lab's quote ledger obeys).
 */
function select(stored, candidates) {
  const last = latestByKey(stored);
  const keep = [];
  (candidates || []).forEach((r) => {
    const k = LAB.quoteKey(r);
    if (LAB.dedupeDecision(last[k] || null, r) !== 'written') return;
    keep.push(r);
    last[k] = r;
  });
  return keep;
}

function read(f) {
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
}
/** append-only: new rows go on the end, nothing already there is touched */
function append(f, rows) {
  if (!rows || !rows.length) return 0;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return rows.length;
}

module.exports = { SCHEMA, DIR, file, rowsFromMarket, latestByKey, select, read, append, bookKey };
