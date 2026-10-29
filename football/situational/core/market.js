/* ============================================================================
   FSIE — player prop markets: model-vs-market comparisons and CLV.

   No Odds API call is made here. Prices come from what the props pipeline
   already captured and committed (football/props/<lg>/board.json for the
   live board, football/props/<lg>/<season>/closes.jsonl for line history),
   so every timestamp, book and side is the props pipeline's own. Markets:
   player_pass_attempts, player_rush_attempts, player_receptions — the three
   volume markets the capture requests (football/props/config.js). Targets
   have no market in the capture and are not compared.

   A comparison is a PROJECTION DISAGREEMENT, never a betting edge: the
   difference between the model's median and the consensus line, with the
   model's (uncalibrated, research-only) over probability shown beside it.
   No EV is computed here and nothing here feeds a decision.

   CLV uses lib/edgedesk_props.js clv() — the project's own definition:
   line CLV for any close, price and no-vig probability CLV at the same
   number. A missing close is an exclusion with a reason, never a guess.
   CLV and the eventual outcome are reported separately.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const U = require(path.join(__dirname, 'util.js'));
const EDP = require(path.join(__dirname, '..', '..', '..', 'lib', 'edgedesk_props.js'));

const MARKETS = ['pass_att', 'rush_att', 'receptions'];
/* preregistered flag thresholds: |model median - entry line| at or above */
const FLAG = { pass_att: 2.0, rush_att: 1.5, receptions: 0.75 };

/* consensus at a moment: each book's last main entry at or before `at`;
   the modal line; median over/under prices among books at that line */
function consensusAt(books, at) {
  const rows = [];
  Object.keys(books || {}).forEach((bk) => {
    const main = (books[bk] && books[bk].main) || [];
    let last = null; for (const e of main) { if (!at || e[0] <= at) last = e; }
    if (last && U.isNum(last[1])) rows.push({ book: bk, t: last[0], line: last[1], over: last[2], under: last[3] });
  });
  if (!rows.length) return null;
  const cnt = {}; rows.forEach((r) => { cnt[r.line] = (cnt[r.line] || 0) + 1; });
  const line = +Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a] || +a - +b)[0];
  const at_line = rows.filter((r) => r.line === line);
  const med = (xs) => { const v = xs.filter(U.isNum).sort((a, b) => a - b); return v.length ? v[Math.floor((v.length - 1) / 2)] : null; };
  return { line, over: med(at_line.map((r) => r.over)), under: med(at_line.map((r) => r.under)), books: rows.length, books_at_line: at_line.length,
    at: rows.map((r) => r.t).sort().pop() };
}
function firstSeen(books) { let t = null; Object.values(books || {}).forEach((b) => { ((b && b.main) || []).forEach((e) => { if (!t || e[0] < t) t = e[0]; }); }); return t; }
function snapshotsAfter(books, from, before) {
  const ts = new Set(); Object.values(books || {}).forEach((b) => { ((b && b.main) || []).forEach((e) => { if ((!from || e[0] >= from) && (!before || e[0] < before)) ts.add(e[0]); }); });
  return Array.from(ts).sort();
}

function pOver(draws, line) { if (!draws || !draws.length) return null; return U.round(draws.filter((x) => x > line).length / draws.length, 4); }

/* one comparison row */
function compare(proj, cons, meta) {
  const median = proj.p50;
  return {
    sport: meta.sport, game_id: meta.game_id, event_id: meta.event_id || null, player_id: meta.player_id, player_name: meta.player_name || null, market: meta.market,
    model_version: meta.model_version, model_as_of: meta.model_as_of, model_median: median, model_mean: proj.mean, model_p10: proj.p10, model_p90: proj.p90,
    market_line: cons.line, market_over: cons.over, market_under: cons.under, market_books: cons.books, market_at: cons.at,
    difference: U.round(median - cons.line, 2), p_over_research: meta.draws ? pOver(meta.draws, cons.line) : null,
    label: 'projection_disagreement', experimental: true, data_quality: meta.data_quality || 'ok'
  };
}

function direction(market, diff) { if (diff >= FLAG[market]) return 'over'; if (diff <= -FLAG[market]) return 'under'; return null; }
function priceFor(cons, side) { return side === 'over' ? cons.over : cons.under; }

/* CLV for a flagged comparison; close missing -> exclusion */
function clvRow(side, entry, close, entryAt, closeAt) {
  if (!close || !U.isNum(close.line)) return { available: false, exclusion: 'no pregame close captured for this prop' };
  const am = priceFor(entry, side);
  const r = EDP.clv({ side, line: entry.line, american: U.isNum(am) ? am : -110 }, { line: close.line, over: close.over, under: close.under });
  if (!r.available) return { available: false, exclusion: r.reason || 'no closing line on file' };
  return Object.assign({ entry_line: entry.line, entry_price: U.isNum(am) ? am : null, entry_at: entryAt, close_at: closeAt, close_line: close.line, close_price: priceFor(close, side) }, r,
    { price_assumed: !U.isNum(am) });
}
function outcome(side, line, actual) { if (!U.isNum(actual)) return null; if (actual === line) return 'PUSH'; return (actual > line) === (side === 'over') ? 'WIN' : 'LOSS'; }

/* parse a league's closes.jsonl */
function readCloses(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
}
function propsOf(ev) {
  const out = [];
  Object.keys(ev.props || {}).forEach((k) => { const i = k.lastIndexOf('|'); const mk = k.slice(i + 1); if (MARKETS.indexOf(mk) < 0) return; out.push({ key: k, norm: k.slice(0, i), market: mk, player_name: ev.props[k].player_name, books: ev.props[k].books }); });
  return out;
}

function summarize(rows) {
  const by = {};
  rows.forEach((r) => {
    const s = by[r.market] || (by[r.market] = { comparisons: 0, flagged: 0, clv_valid: 0, excluded: {}, line_clv_sum: 0, beat_close: 0, beat_known: 0, prob_clv: [], outcomes: { WIN: 0, LOSS: 0, PUSH: 0, VOID: 0 } });
    s.comparisons++;
    if (!r.direction) return;
    s.flagged++;
    if (r.clv && r.clv.available) { s.clv_valid++; s.line_clv_sum += r.clv.line_clv; if (r.clv.beat_close != null) { s.beat_known++; if (r.clv.beat_close) s.beat_close++; } if (U.isNum(r.clv.prob_clv_pp)) s.prob_clv.push(r.clv.prob_clv_pp); }
    else { const why = (r.clv && r.clv.exclusion) || r.exclusion || 'unknown'; s.excluded[why] = (s.excluded[why] || 0) + 1; }
    if (r.outcome) s.outcomes[r.outcome]++;
  });
  Object.values(by).forEach((s) => {
    s.mean_line_clv = s.clv_valid ? U.round(s.line_clv_sum / s.clv_valid, 3) : null; delete s.line_clv_sum;
    s.beat_close_rate = s.beat_known ? U.round(s.beat_close / s.beat_known, 3) : null;
    s.mean_prob_clv_pp = s.prob_clv.length ? U.round(U.mean(s.prob_clv), 3) : null; s.prob_clv_n = s.prob_clv.length; delete s.prob_clv;
    const g = s.outcomes.WIN + s.outcomes.LOSS; s.outcome_hit_rate = g ? U.round(s.outcomes.WIN / g, 3) : null;
  });
  return by;
}

module.exports = { consensusAt, firstSeen, snapshotsAfter, pOver, compare, direction, clvRow, outcome, readCloses, propsOf, summarize, MARKETS, FLAG };
