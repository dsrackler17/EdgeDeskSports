#!/usr/bin/env node
/* ===========================================================================
   Market intelligence over the Model Lab ledger (docs/cfb-market/DELIVERABLE.md
   §39, §43). Point in time, append-only, deterministic.

     node football/cfb_market/run.js [--season 2026] [--now ISO]            dry run: counts + the panel
     node football/cfb_market/run.js [--season 2026] [--now ISO] --write    append to football/cfb_market/ledger/<season>/

   For every game with captured quotes, at every quote arrival before `now`
   and before kickoff (a snapshot sees only quotes observed by then):
     snapshots.jsonl     cfb_market_consensus_snapshots (integrity.js verdict included)
     events.jsonl        cfb_market_events (edge appears / disappears, market moves
                         toward / away from the model, key number crossed,
                         coordinated move, provider conflict) with a cooldown
     conflicts.jsonl     cfb_market_provider_conflicts (both feeds preserved)
     predictions.jsonl   cfb_market_predictions: the market-informed CHALLENGER
                         margin (never the fair line) at each snapshot
   The pure margin is the newest LIVE edgedesk_cfb_v2.1.0 snapshot taken at or
   before the market snapshot (football/cfb_lab/ledger/<season>/predictions).
   Nothing here writes into a prediction, a quote or a line: the Lab's own
   ledger is read-only to this job. A re-run adds nothing (ids hash the fact).

   Integration: one step in .github/workflows/cfb-lab.yml after `market`
   (`node football/cfb_market/run.js --write`), and a mirror of the four files
   into supabase/cfb_market.sql's tables (plan() gives the rows).
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const REPO = path.resolve(__dirname, '..', '..');
const L = require(path.join(REPO, 'football', 'cfb_lab', 'lab_core.js'));
const M = require('./market_intel.js');

const RULE = 'cfb_market_snapshot_v1';
const MODEL = 'edgedesk_cfb_v2.1.0';
function h(...parts) { return crypto.createHash('sha256').update(L.util.idParts(parts)).digest('hex').slice(0, 24); }
function readJsonl(p) { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []; }
function readDir(d) { return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.jsonl')).sort().flatMap((f) => readJsonl(path.join(d, f))) : []; }
const ms = (t) => (t == null ? null : Date.parse(t));
const r2 = (x) => (typeof x === 'number' && isFinite(x) ? Math.round(x * 100) / 100 : null);

function ledgerDir(season) { return path.join(REPO, 'football', 'cfb_lab', 'ledger', String(season)); }
function outDir(season) { return path.join(__dirname, 'ledger', String(season)); }

/* the rows the job would write, from the Lab ledger as of `now` */
function build(season, now, opts) {
  opts = opts || {};
  const quotes = opts.quotes || readDir(path.join(ledgerDir(season), 'quotes'));
  const preds = (opts.predictions || readDir(path.join(ledgerDir(season), 'predictions')))
    .filter((p) => p.origin === 'LIVE' && p.model_version === MODEL && typeof p.pure_home_margin === 'number');
  const tNow = ms(now);
  const byGame = {};
  quotes.forEach((q) => { if (q.game_id && ms(q.observed_at) <= tNow) (byGame[q.game_id] = byGame[q.game_id] || []).push(q); });
  const predBy = {};
  preds.forEach((p) => { (predBy[p.game_id] = predBy[p.game_id] || []).push(p); });
  Object.keys(predBy).forEach((g) => predBy[g].sort((a, b) => ms(a.prediction_ts) - ms(b.prediction_ts)));
  const pureAt = (g, t) => { let best = null; (predBy[g] || []).forEach((p) => { if (ms(p.prediction_ts) <= t) best = p; }); return best; };
  const out = { snapshots: [], events: [], conflicts: [], predictions: [], panel: [] };
  Object.keys(byGame).sort().forEach((g) => {
    const qs = byGame[g];
    const kick = qs.map((q) => q.kickoff_ts).filter(Boolean).sort().pop();
    if (!kick) return;
    const ser = M.snapshotSeries(qs, kick);
    const last = {};
    let prevState = null;
    ser.forEach((s) => {
      const t = ms(s.as_of);
      const row = { snapshot_id: 'cfbms_' + h(g, s.as_of, RULE), rule_version: RULE, game_id: g, season, week: qs[0].week == null ? null : qs[0].week,
        as_of: s.as_of, kickoff_ts: kick, n_books_seen: s.n_books_seen, n_active_books: s.n_active_books, stale_book_count: s.stale_book_count,
        integrity_excluded_count: s.integrity_excluded_count, median_home_line: s.median_home_line, weighted_median_home_line: s.weighted_median_home_line,
        mean_home_line: s.mean_home_line, trimmed_mean_home_line: s.trimmed_mean_home_line, consensus_margin: s.consensus_margin,
        consensus_uncertainty: s.consensus_uncertainty, dispersion_iqr: s.dispersion_iqr, dispersion_sd: s.dispersion_sd,
        best_home_book: s.best_home.book, best_home_line: s.best_home.line, best_home_price: s.best_home.price,
        best_away_book: s.best_away.book, best_away_line: s.best_away.line, best_away_price: s.best_away.price,
        median_price_home: s.median_price_home, median_price_away: s.median_price_away,
        integrity_status: s.integrity.status, actionable_status: s.integrity.actionable_status,
        quote_ids: s.books.filter((b) => !b.stale && !b.integrity_excluded).map((b) => b.quote_id).sort(),
        payload: { books: s.books, freshness_limit_hours: s.freshness_limit_hours, integrity_reasons: s.integrity.reasons } };
      out.snapshots.push(row);
      const p = pureAt(g, t);
      if (p) {
        const ch = M.challengerMargin(p.pure_home_margin, s.consensus_margin);
        if (ch) out.predictions.push({ prediction_id: 'cfbmp_' + h(g, 'MARKET_ADJUSTED_PROJECTION', ch.artifact, s.as_of), game_id: g, kind: 'MARKET_ADJUSTED_PROJECTION',
          as_of: s.as_of, kickoff_ts: kick, model_version: ch.artifact, role: 'challenger', value: ch.market_adjusted_projection, uncertainty: null,
          label: ch.label, payload: { w_pure: ch.w_pure, pure_prediction_id: p.prediction_id, consensus_margin: s.consensus_margin } });
      }
      /* events: the gap is the side-free edge proxy while no price is captured (EV needs a price) */
      const state = { at: s.as_of, game_id: g, consensus_margin: s.consensus_margin, pure_margin: p ? p.pure_home_margin : null,
        gap: p ? p.pure_home_margin - s.consensus_margin : null, ev: null };
      if (prevState && state.pure_margin != null && prevState.pure_margin != null) {
        M.marketEvents(prevState, state, { last }).forEach((e) => {
          last[e.type] = e.at;
          out.events.push({ event_id: 'cfbmv_' + h(g, e.type, e.at), game_id: g, event_type: e.type, at: e.at, kickoff_ts: kick, rule_version: RULE, detail: e.detail || {} });
        });
      }
      prevState = state;
    });
    M.coordinatedMoves(qs.filter((q) => ms(q.observed_at) < ms(kick))).filter((c) => c.label === 'COORDINATED_MOVE').forEach((c) => {
      out.events.push({ event_id: 'cfbmv_' + h(g, 'COORDINATED_MOVE', c.end), game_id: g, event_type: 'COORDINATED_MOVE', at: c.end, kickoff_ts: kick, rule_version: RULE,
        detail: { books: c.books, active_books: c.active_books, direction: c.direction, coordinated_move_score: c.coordinated_move_score, label: 'books moved together' } });
    });
    M.providerConflicts(qs).forEach((c) => {
      const at = qs.filter((q) => c.quote_ids.indexOf(q.quote_id) >= 0).map((q) => q.observed_at).sort().pop();
      out.conflicts.push({ conflict_id: 'cfbpc_' + h(g, c.book, c.quote_ids.join(',')), game_id: g, book: c.book, sources: c.sources, quote_ids: c.quote_ids,
        lines: c.lines, difference_pts: c.difference_pts, major: c.major, likely_fresher: c.likely_fresher, action: c.action, detected_at: at });
      if (c.major && ms(at) < ms(kick)) out.events.push({ event_id: 'cfbmv_' + h(g, 'PROVIDER_CONFLICT', at), game_id: g, event_type: 'PROVIDER_CONFLICT', at, kickoff_ts: kick,
        rule_version: RULE, detail: { book: c.book, sources: c.sources, lines: c.lines } });
    });
    if (ser.length) {
      const first = ser[0], cur = ser[ser.length - 1], p = pureAt(g, ms(cur.as_of));
      const gap = p ? M.modelMarketGap(p.pure_home_margin, cur.consensus_margin) : null;
      out.panel.push({ game_id: g, kickoff_ts: kick, current: cur.median_home_line, books: cur.n_active_books, actionable_status: cur.integrity.actionable_status,
        movement_since_open: r2(cur.consensus_margin - first.consensus_margin), best_home: cur.best_home, best_away: cur.best_away,
        model_gap: gap ? gap.raw_signed_gap : null, market_toward_model: gap && cur.consensus_margin !== first.consensus_margin
          ? (Math.sign(cur.consensus_margin - first.consensus_margin) === Math.sign(p.pure_home_margin - first.consensus_margin) ? 'TOWARD' : 'AWAY') : 'NEUTRAL' });
    }
  });
  /* one event per game x type x moment (the table's key) */
  const seen = {};
  out.events = out.events.filter((e) => { const k = e.game_id + '|' + e.event_type + '|' + e.at; if (seen[k]) return false; seen[k] = 1; return true; });
  return out;
}

const FILES = { snapshots: 'snapshot_id', events: 'event_id', conflicts: 'conflict_id', predictions: 'prediction_id' };
const TABLES = { snapshots: 'cfb_market_consensus_snapshots', events: 'cfb_market_events', conflicts: 'cfb_market_provider_conflicts', predictions: 'cfb_market_predictions' };

/* append-only: rows whose id is already stored are skipped, nothing is rewritten */
function write(season, rows, dir) {
  const d = dir || outDir(season), res = {};
  Object.keys(FILES).forEach((k) => {
    const p = path.join(d, k + '.jsonl'), idf = FILES[k];
    const have = new Set(readJsonl(p).map((x) => x[idf]));
    const fresh = rows[k].filter((x) => !have.has(x[idf]) && have.add(x[idf]));
    if (fresh.length) { fs.mkdirSync(d, { recursive: true }); fs.appendFileSync(p, fresh.map((x) => JSON.stringify(x)).join('\n') + '\n'); }
    res[k] = fresh.length;
  });
  return res;
}
/* the mirror plan: every table's rows (insert-only, on_conflict=<id> ignore) */
function plan(season, now, opts) {
  const b = build(season, now || new Date().toISOString(), opts);
  return Object.keys(TABLES).map((k) => ({ table: TABLES[k], key: FILES[k], rows: b[k] }));
}

module.exports = { build, write, plan, RULE, TABLES, FILES };

if (require.main === module) {
  const a = process.argv.slice(2);
  const arg = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  const season = Number(arg('--season', new Date().getUTCFullYear()));
  const now = arg('--now', new Date().toISOString());
  const b = build(season, now);
  const counts = Object.fromEntries(Object.keys(FILES).map((k) => [k, b[k].length]));
  if (a.includes('--write')) console.log(JSON.stringify({ season, now, written: write(season, b), counts }));
  else console.log(JSON.stringify({ season, now, dry_run: true, counts, panel: b.panel.slice(0, 5) }, null, 1));
}
