/* ===========================================================================
   THE PRICE LOCK — the market price a model decision was made at.
   docs/pnl/DESIGN.md § Verified P&L

   The football model record publishes a NUMBER (a fair spread, total and win
   probability) and is graded against the close. No price was ever captured
   with that number, so its results are record-only. This file attaches the
   one price that can honestly stand behind such a decision: the sportsbook
   quote EdgeDesk itself STORED AT OR BEFORE the moment the number was
   published — never a later quote, never the close, never today's odds,
   never an assumed −110.

   ONE LOOKUP, TWO CALLERS
     · the forward lock: tools/record/football_record.js freezes, on the
       pick it records, each market as EdgeDesk's stored quotes saw it at the
       pick's publication time (pick.price_lock). A revised number is a new
       pick and gets its own lock; a lock is never rewritten.
     · the historical backfill: the same run, over picks recorded before the
       lock existed. The lookup reads only quotes observed at or before the
       pick was published, so running it today gives exactly the answer it
       would have given then — and running it twice gives the same answer.

   THE AS-OF RULE (football/cfb_lab/lab_core.js wrote the quotes, and this is
   its own reading of them: marketAt / latestPerBook)
     per book, the latest ordinary pregame quote observed at or before the
     decision. The lab writes a quote when a value changes and on a
     heartbeat, so that row IS the book's price at the decision while it is
     younger than the heartbeat (tools/record/pnl_config.json: 6 h; 90 min
     inside 3 h of kickoff, the decision engine's own freshness limit).
     Older, and the game went unobserved: no price.

   WHICH BOOK. The book the decision's own market was read from (the record's
   ESPN book) when it quoted; otherwise the most recent quote, ties to the
   lower payout. Never the best price across books — that would be line
   shopping after the fact.

   WHICH NUMBER. A model-record decision is graded on one exact selection
   (side and closing number). A lock prices that selection only when the
   stored quote was FOR THAT NUMBER (a moneyline has none). A market that
   stood elsewhere at the decision is a different bet: no price, and the
   reason says so. Nothing is moved, interpolated or re-graded.

   Pure: no clock, no network. readQuotes() is the only file access.
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const PNL = require(path.join(ROOT, 'lib', 'edgedesk_pnl.js'));
const CONFIG = require('./pnl_config.json');

const LOCK_SCHEMA = 'edgedesk_price_lock_v1';
const MARKETS = ['spread', 'total', 'moneyline'];
const SNAP = CONFIG.price_snapshots;

function num(v) { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function ms(t) { const v = Date.parse(t || ''); return Number.isFinite(v) ? v : null; }
function iso(t) { const v = typeof t === 'number' ? t : ms(t); return v == null ? null : new Date(v).toISOString(); }
function bookKey(b) { return String(b || '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }
function same(a, b) { return a != null && b != null && Math.abs(a - b) < 1e-6; }
function lineText(v) { if (v == null) return '—'; const x = Math.round(v * 10) / 10; return x === 0 ? 'PK' : (x > 0 ? '+' : '') + x; }

/* ---------------------------------------------------------------- quotes */
/** One stored quote → the shape the lookup reads, or null when it can never
    be a decision's price: no real book, not an ordinary pregame observation,
    no time, no price. */
function normalize(q, sourceKey) {
  if (!q || !q.game_id || MARKETS.indexOf(q.market_type) < 0) return null;
  if (!q.book || bookKey(q.book) === 'consensus') return null;            /* a provider average is not a book */
  if (q.is_provider_open || q.is_provider_close || q.is_pregame === false) return null;
  const at = ms(q.observed_at), ko = ms(q.kickoff_ts);
  if (at == null || (ko != null && at >= ko)) return null;
  const p = {};
  if (q.market_type === 'spread') {
    if (num(q.home_line) == null) return null;
    p.home = PNL.validAmerican(q.price_home); p.away = PNL.validAmerican(q.price_away);
  } else if (q.market_type === 'total') {
    if (num(q.total_points) == null) return null;
    p.over = PNL.validAmerican(q.price_over); p.under = PNL.validAmerican(q.price_under);
  } else {
    p.home_ml = PNL.validAmerican(q.price_home); p.away_ml = PNL.validAmerican(q.price_away);
  }
  Object.keys(p).forEach((k) => { if (p[k] == null) delete p[k]; });
  if (!Object.keys(p).length) return null;                                 /* a line with no price is not a price */
  return {
    source: sourceKey || 'cfb_lab_quotes', quote_id: q.quote_id || null, event_id: String(q.game_id), market: q.market_type,
    book: q.book, observed_at: iso(at), kickoff: ko != null ? iso(ko) : null,
    home_line: q.market_type === 'spread' ? num(q.home_line) : null,
    total: q.market_type === 'total' ? num(q.total_points) : null,
    prices: p
  };
}
/** quotes → { event_id: [normalized…] }, each game's quotes oldest first */
function index(rows, sourceKey) {
  const by = {};
  (rows || []).forEach((q) => { const n = normalize(q, sourceKey); if (n) (by[n.event_id] = by[n.event_id] || []).push(n); });
  Object.keys(by).forEach((k) => by[k].sort((a, b) => ms(a.observed_at) - ms(b.observed_at) || String(a.quote_id).localeCompare(String(b.quote_id))));
  return by;
}
function readLines(f, rows) {
  fs.readFileSync(f, 'utf8').split('\n').forEach((l) => { if (!l) return; try { rows.push(JSON.parse(l)); } catch (_) { /* a torn line is not a quote */ } });
}
/** The raw rows of one configured source (a directory of .jsonl files, or one file). */
function sourceRows(root, season, s) {
  const rows = [];
  const sub = (x) => x.replace('{season}', String(season)).replace('{sport}', String(s.league).toLowerCase());
  if (s.dir) {
    const dir = path.join(root || ROOT, sub(s.dir));
    if (fs.existsSync(dir)) fs.readdirSync(dir).filter((f) => /\.jsonl$/.test(f)).sort().forEach((f) => readLines(path.join(dir, f), rows));
  } else if (s.file) {
    const f = path.join(root || ROOT, sub(s.file));
    if (fs.existsSync(f)) readLines(f, rows);
  }
  return rows;
}
/**
 * Every configured snapshot source for a league and season, from disk, by
 * game. `override` replaces a source's rows by its key (a run passes its own
 * ledger as it will leave it, written or not).
 */
function readQuotes(root, season, league, override) {
  const out = {};
  (SNAP.sources || []).filter((s) => !league || s.league === league).forEach((s) => {
    const rows = override && override[s.key] ? override[s.key] : sourceRows(root, season, s);
    const ix = index(rows, s.key);
    Object.keys(ix).forEach((k) => { out[k] = (out[k] || []).concat(ix[k]); });
  });
  return out;
}
/**
 * What each source covers: its first and last stored priced quote and how many
 * games — the earliest point from which a league's model decisions can carry
 * a verified price.
 */
function coverage(root, season) {
  return (SNAP.sources || []).map((s) => {
    const ix = index(sourceRows(root, season, s), s.key), ids = Object.keys(ix);
    let first = null, last = null;
    ids.forEach((k) => ix[k].forEach((q) => { const t = ms(q.observed_at); if (first == null || t < first) first = t; if (last == null || t > last) last = t; }));
    return { key: s.key, league: s.league, covers: s.covers || null, games: ids.length, first_capture: first == null ? null : iso(first), last_capture: last == null ? null : iso(last) };
  });
}
/**
 * Per league, the first stored quote of a source that covers every game the
 * model publishes a number on (coverage() rows) — the earliest point from which
 * every model decision of that league can carry a verified price; null while
 * that league's ledger holds no quote yet.
 */
function everyGameFrom(cov) {
  const out = {};
  (SNAP.sources || []).forEach((s) => { if (s.covers === 'every_model_game' && !(s.league in out)) out[s.league] = null; });
  (cov || []).forEach((c) => {
    if (c.covers !== 'every_model_game' || !c.first_capture) return;
    if (out[c.league] == null || ms(c.first_capture) < ms(out[c.league])) out[c.league] = c.first_capture;
  });
  return out;
}

/**
 * The stored quotes the locked prices cite — refs: [{ source, quote_id, league }]
 * (price_ref) — as raw rows in the database's evidence shape
 * (supabase/model_pnl_verified.sql model_pnl_quotes), plus the refs not found.
 */
function evidence(root, season, refs) {
  const want = {};
  (refs || []).forEach((r) => { if (r && r.quote_id) (want[r.source] = want[r.source] || new Set()).add(String(r.quote_id)); });
  const rows = [], seen = new Set();
  (SNAP.sources || []).forEach((s) => {
    if (!want[s.key]) return;
    const file = (s.file || s.dir).replace('{season}', String(season)).replace('{sport}', String(s.league).toLowerCase());
    sourceRows(root, season, s).forEach((q) => {
      const id = q && q.quote_id != null ? String(q.quote_id) : null;
      if (!id || !want[s.key].has(id) || seen.has(s.key + '|' + id) || !normalize(q, s.key)) return;
      seen.add(s.key + '|' + id);
      rows.push({ quote_id: id, source: s.key, league: s.league, game_id: String(q.game_id), book: q.book, market_type: q.market_type,
        observed_at: iso(q.observed_at), kickoff_ts: q.kickoff_ts ? iso(q.kickoff_ts) : null,
        home_line: q.market_type === 'spread' ? num(q.home_line) : null, total_points: q.market_type === 'total' ? num(q.total_points) : null,
        price_home: num(q.price_home), price_away: num(q.price_away), price_over: num(q.price_over), price_under: num(q.price_under), source_file: file });
    });
  });
  const missing = [];
  Object.keys(want).forEach((k) => want[k].forEach((id) => { if (!seen.has(k + '|' + id)) missing.push({ source: k, quote_id: id }); }));
  return { rows, missing };
}

/* ---------------------------------------------------------------- as-of */
function maxAgeMs(decidedAt, kickoff) {
  const d = ms(decidedAt), k = ms(kickoff);
  if (d != null && k != null && (k - d) / 3600e3 <= SNAP.close_zone_hours) return SNAP.close_zone_max_age_minutes * 60e3;
  return SNAP.max_age_hours * 3600e3;
}
function miss(status, why, detail) { return { status: status, why: why, detail: detail }; }

/**
 * One market of one game as EdgeDesk's stored quotes saw it at `decidedAt`.
 *   quotes      that game's normalized quotes (index()[event_id])
 *   market      'spread' | 'total' | 'moneyline'
 *   opts        { decided_at, kickoff, prefer_book }
 * → { status: 'locked', quote } or a miss { status, why, detail }:
 *   historical_price_unavailable / no_snapshot   nothing stored for this market
 *   price_after_decision / after_decision        stored only after the decision
 *   historical_price_unavailable / stale         the latest before it is past the freshness limit
 */
function marketAt(quotes, market, opts) {
  const T = ms(opts.decided_at), K = ms(opts.kickoff);
  if (T == null) return miss('historical_price_unavailable', 'no_decision_time', 'the decision carries no publication time');
  const all = (quotes || []).filter((q) => q.market === market && (K == null || ms(q.observed_at) < K));
  if (!all.length) return miss('historical_price_unavailable', 'no_snapshot', 'EdgeDesk stored no priced ' + market + ' quote for this game');
  const before = all.filter((q) => ms(q.observed_at) <= T);
  if (!before.length) return miss('price_after_decision', 'after_decision', 'EdgeDesk\'s first stored ' + market + ' price for this game (' + iso(all[0].observed_at) + ') came after the decision (' + iso(T) + ')');
  /* each book's latest quote at or before the decision */
  const per = {};
  before.forEach((q) => { const k = bookKey(q.book); if (!per[k] || ms(q.observed_at) >= ms(per[k].observed_at)) per[k] = q; });
  const lim = maxAgeMs(opts.decided_at, opts.kickoff);
  const fresh = Object.keys(per).map((k) => per[k]).filter((q) => T - ms(q.observed_at) <= lim);
  if (!fresh.length) {
    const newest = Object.keys(per).map((k) => per[k]).sort((a, b) => ms(b.observed_at) - ms(a.observed_at))[0];
    return miss('historical_price_unavailable', 'stale', 'the latest stored ' + market + ' price before the decision was ' + Math.round((T - ms(newest.observed_at)) / 60e3) + ' minutes old — past the ' + Math.round(lim / 60e3) + '-minute limit');
  }
  const pref = bookKey(opts.prefer_book);
  const pick = fresh.filter((q) => pref && bookKey(q.book) === pref)[0] || fresh.sort((a, b) => ms(b.observed_at) - ms(a.observed_at) || payout(a) - payout(b) || bookKey(a.book).localeCompare(bookKey(b.book)))[0];
  return { status: 'locked', quote: pick };
}
/* the lower of a quote's payouts (decimal), for a deterministic, conservative tie-break */
function payout(q) { const d = Object.keys(q.prices).map((k) => PNL.decimal(q.prices[k])).filter((x) => x != null); return d.length ? Math.min.apply(null, d) : 0; }

/**
 * The lock of one pick: every market as stored at its publication time.
 * `prev` is the lock the pick already carries; a LOCKED market is never
 * rewritten (immutable), a miss is looked up again (a quote committed late
 * can still be one observed before the decision).
 * → { lock, changed }
 */
function lockPick(quotes, opts, prev) {
  const lock = prev && prev.schema === LOCK_SCHEMA && prev.decided_at === iso(opts.decided_at) ? JSON.parse(JSON.stringify(prev)) : { schema: LOCK_SCHEMA, decided_at: iso(opts.decided_at) };
  let changed = !prev || lock.decided_at !== (prev && prev.decided_at) || prev.schema !== LOCK_SCHEMA;
  MARKETS.forEach((m) => {
    const cur = lock[m];
    if (cur && cur.status === 'locked') return;                             /* frozen */
    const r = marketAt(quotes, m, opts);
    const next = r.status === 'locked'
      ? { status: 'locked', source: r.quote.source, quote_id: r.quote.quote_id, book: r.quote.book, observed_at: r.quote.observed_at,
          home_line: r.quote.home_line, total: r.quote.total, prices: r.quote.prices, locked_at: iso(opts.now) }
      : r;
    if (JSON.stringify(cur || null) !== JSON.stringify(next)) { lock[m] = next; changed = true; }
  });
  return { lock, changed };
}

/**
 * The price of ONE graded selection from a pick's lock.
 *   entry   lock[market] (or undefined)
 *   sel     { market_type, side, line }  line is the side's own number (null for a moneyline)
 * → { status: 'locked', odds, line, book, observed_at, quote_id, source } or a miss.
 */
function priceFor(entry, sel) {
  if (!entry) return miss('historical_price_unavailable', 'no_snapshot', 'no stored quote was looked up for this market');
  if (entry.status !== 'locked') return entry;
  const mt = sel.market_type, side = sel.side;
  let line = null, key = null;
  if (mt === 'spread') { line = side === 'home' ? entry.home_line : side === 'away' && entry.home_line != null ? -entry.home_line : null; key = side; }
  else if (mt === 'total') { line = entry.total; key = side; }
  else if (mt === 'moneyline') key = side === 'home' ? 'home_ml' : side === 'away' ? 'away_ml' : null;
  if (mt !== 'moneyline' && !same(line, sel.line)) {
    const lbl = mt === 'total' ? (side === 'over' ? 'Over ' : 'Under ') : '';
    return miss('historical_price_unavailable', 'line_moved', 'at the decision the stored ' + entry.book + ' number was ' + lbl + (mt === 'total' ? line : lineText(line))
      + '; the graded number ' + lbl + (mt === 'total' ? sel.line : lineText(sel.line)) + ' had no stored price then');
  }
  const odds = key ? PNL.validAmerican(entry.prices && entry.prices[key]) : null;
  if (odds == null) return miss('historical_price_unavailable', 'no_side_price', 'the stored quote carried no price for this side');
  return { status: 'locked', odds: odds, line: mt === 'moneyline' ? null : line, book: entry.book, observed_at: entry.observed_at, quote_id: entry.quote_id, source: entry.source, locked_at: entry.locked_at || null };
}

module.exports = { LOCK_SCHEMA, MARKETS, CONFIG, normalize, index, readQuotes, sourceRows, coverage, everyGameFrom, evidence, marketAt, lockPick, priceFor, maxAgeMs, bookKey };
