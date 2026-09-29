/* ===========================================================================
   EdgeDesk player props — THE GRADED RECORD (Phase H).

   FREEZE. Every qualifying pregame entry (decision LEAN or BET at an observed
   quote) is written ONCE, before kickoff, with everything EdgeDesk said: the
   player, market, book, line, price, model probability, market probability,
   fair price, EV, confidence, data quality, the model and feature versions,
   the prediction id and the time. A later run never overwrites a frozen entry
   — not with a better price, not with a newer model. A newer model's opinion
   is a different prediction row, never a rewrite of this one.

   SETTLE. After the game is final: the actual stat from fact_player_game,
   WIN / LOSS / PUSH, or VOID when the player did not play; units on the frozen
   price (a flat 1-unit basis beside any recommended stake, so sizing is judged
   against flat staking); CLV against the last observed quote before kickoff
   at the same book, side and line (price CLV) and against the consensus close
   (line CLV).

   Stored as record/props/<league>_<season>.json (committed, like the football
   model record) and mirrored write-once into props.prop_record.
   =========================================================================== */
'use strict';
const path = require('path');
const crypto = require('crypto');
const EDP = require('../../lib/player_props.js');
const io = require('./lib/io.js');
const M = require('./model.js');
const { writeIfChanged } = require('../../tools/football/write_if_changed.js');

const SCHEMA = 'edgedesk_props_record_v1';
const DIR = path.join(io.ROOT, 'record', 'props');
const QUALIFY = { LEAN: true, BET: true };
function r(x, d) { return x == null || !isFinite(x) ? null : Math.round(x * Math.pow(10, d == null ? 4 : d)) / Math.pow(10, d == null ? 4 : d); }
function entryId(p) { return 'pr_' + crypto.createHash('sha256').update([p.game_id, p.player_id, p.market_key, p.focus.side].join('|')).digest('hex').slice(0, 24); }
function file(league, season) { return path.join(DIR, league.toLowerCase() + '_' + season + '.json'); }
function load(league, season) { return io.readJson(file(league, season), { schema: SCHEMA, league, season, entries: {} }); }

/* freeze qualifying entries from a scored board; returns the entries added */
function freeze(board, opts) {
  opts = opts || {};
  const now = opts.now || Date.now();
  const rec = opts.record || load(board.league, board.season);
  const added = [];
  (board.props || []).forEach((p) => {
    if (!p.focus || !p.decision || !QUALIFY[p.decision.decision]) return;
    if (!(Date.parse(p.kickoff_utc) > now)) return;                     /* never at or after kickoff */
    const id = entryId(p);
    if (rec.entries[id]) return;                                        /* frozen: never rewritten */
    const f = p.focus;
    rec.entries[id] = {
      entry_id: id, frozen_at: new Date(now).toISOString(), league: p.league, season: board.season, game_id: p.game_id, kickoff_utc: p.kickoff_utc, matchup: p.matchup,
      player_id: p.player_id, player: p.player, position: p.position, team: p.team, is_home: p.is_home, market_key: p.market_key,
      side: f.side, line: f.line, sportsbook: f.sportsbook, american: f.american, quote_snapshot_at: f.snapshot_at, lineage: 'observed',
      model_prob: f.model_prob, model_push: f.model_push, market_prob: f.market_prob, no_vig_prob: f.no_vig_prob, implied_prob: f.implied_prob, edge: f.edge_vs_market != null ? f.edge_vs_market : f.edge_vs_implied,
      fair_american: f.fair_american, ev: f.ev, conservative_ev: f.conservative_ev,
      confidence: p.confidence ? p.confidence.score : null, data_quality: p.data_quality ? p.data_quality.score : null, decision: p.decision.decision,
      stake_units: p.decision.units == null ? null : p.decision.units,
      model_version: p.model.model_version, feature_version: p.model.feature_version, training_cutoff: p.model.training_cutoff, prediction_id: p.model.prediction_id,
      scored_at: p.model.scored_at, projection: { mean: p.model.mean, median: p.model.median, p10: p.model.p10, p90: p.model.p90 },
      grade: null
    };
    added.push(rec.entries[id]);
  });
  return { record: rec, added };
}

/* settle every ungraded entry whose game is final */
function settle(rec, wh, quotes, opts) {
  opts = opts || {};
  const L = wh.leagues[rec.league];
  const games = new Map(L.games.map((g) => [g.game_id, g]));
  const facts = new Map(L.playerGames.map((x) => [x.game_id + '|' + x.player_id, x]));
  let graded = 0;
  Object.values(rec.entries).forEach((e) => {
    if (e.grade && e.grade.status === 'GRADED') return;                 /* a grade is written once */
    const g = games.get(e.game_id);
    if (!g || g.status !== 'final') { e.grade = { status: 'PENDING' }; return; }
    const fr = facts.get(e.game_id + '|' + e.player_id);
    const close = closeFor(e, quotes || [], g.kickoff_utc);
    const clv = EDP.clv({ side: e.side, line: e.line, american: e.american }, close);
    if (!fr) { e.grade = { status: 'GRADED', result: 'VOID', void_reason: 'player recorded no game (did not play)', actual: null, units: 0, units_flat: 0, clv_price: clv.price, clv_line: clv.line, close, graded_at: new Date(opts.now || Date.now()).toISOString() }; graded++; return; }
    const actual = M.targetFor({ targets: require('./features.js').targetsOf(fr) }, e.market_key);
    const result = EDP.settle(e.side, e.line, actual);
    e.grade = { status: 'GRADED', result, actual, units: e.stake_units ? EDP.unitsFor(result, e.american, e.stake_units) : null, units_flat: EDP.unitsFor(result, e.american, 1),
      clv_price: clv.price, clv_line: clv.line, close, settlement_quality: fr.source_quality, graded_at: new Date(opts.now || Date.now()).toISOString() };
    graded++;
  });
  return graded;
}
/* the last observed quote at or before kickoff at the same book / side / line,
   and that book's opposite side for the no-vig close */
function closeFor(e, quotes, kickoff) {
  const k = Date.parse(kickoff);
  const same = quotes.filter((q) => q.lineage === 'observed' && q.game_id === e.game_id && q.player_id === e.player_id && q.market_key === e.market_key && q.sportsbook === e.sportsbook && Date.parse(q.snapshot_at) <= k);
  const opp = { over: 'under', under: 'over', yes: 'no', no: 'yes' }[e.side];
  const latest = (arr) => arr.sort((a, b) => Date.parse(b.snapshot_at) - Date.parse(a.snapshot_at))[0] || null;
  const side = latest(same.filter((q) => q.side === e.side && (q.line == null ? e.line == null : q.line === e.line)));
  const other = latest(same.filter((q) => q.side === opp && (q.line == null ? e.line == null : q.line === e.line)));
  const anyLine = latest(same.filter((q) => q.side === e.side && q.is_main_line));
  if (!side && !anyLine) return null;
  return { line: side ? side.line : anyLine.line, side_price: side ? side.american_price : null, other_price: other ? other.american_price : null, snapshot_at: (side || anyLine).snapshot_at };
}

/* the summary: every segment, bad ones included */
function summarize(recs) {
  const all = [];
  recs.forEach((rec) => Object.values(rec.entries).forEach((e) => all.push(e)));
  const seg = (keyFn) => {
    const m = {};
    all.forEach((e) => {
      const k = keyFn(e); if (k == null) return;
      const s = m[k] || (m[k] = { n: 0, graded: 0, wins: 0, losses: 0, pushes: 0, voids: 0, units: 0, staked: 0, ev: 0, clv: 0, nclv: 0 });
      s.n++; s.ev += e.ev || 0;
      const gr = e.grade;
      if (gr && gr.status === 'GRADED') {
        s.graded++;
        if (gr.result === 'WIN') s.wins++; else if (gr.result === 'LOSS') s.losses++; else if (gr.result === 'PUSH') s.pushes++; else s.voids++;
        if (gr.result !== 'VOID') { s.units += gr.units_flat || 0; s.staked += 1; }
        if (isFinite(gr.clv_price) && gr.clv_price != null) { s.clv += gr.clv_price; s.nclv++; }
      }
    });
    return Object.keys(m).sort().map((k) => { const s = m[k]; return { segment: k, n: s.n, graded: s.graded, wins: s.wins, losses: s.losses, pushes: s.pushes, voids: s.voids,
      units_flat: r(s.units, 3), roi_flat: s.staked ? r(s.units / s.staked, 4) : null, mean_ev: s.n ? r(s.ev / s.n, 4) : null, mean_clv_price: s.nclv ? r(s.clv / s.nclv, 4) : null,
      sufficient_sample: s.graded >= 100 }; });
  };
  return {
    schema: 'edgedesk_props_record_summary_v1', generated_at: new Date().toISOString(),
    rule: 'Every frozen LEAN/BET entry, graded on the frozen price at a flat 1 unit. Nothing is removed from any segment; a segment under 100 graded entries says so.',
    total: seg(() => 'all')[0] || { segment: 'all', n: 0, graded: 0 },
    by_league: seg((e) => e.league), by_position: seg((e) => e.position), by_market: seg((e) => e.market_key), by_edge_bucket: seg((e) => EDP.edgeBucket(e.edge)),
    by_confidence: seg((e) => EDP.confidenceBucket(e.confidence)), by_sportsbook: seg((e) => e.sportsbook), by_season: seg((e) => e.season),
    by_price: seg((e) => EDP.priceBucket(e.american)), by_fav_dog: seg((e) => (e.american < 0 ? 'favorite' : 'underdog')), by_home_away: seg((e) => (e.is_home == null ? null : e.is_home ? 'home' : 'away')),
    by_model_version: seg((e) => e.model_version), by_decision: seg((e) => e.decision)
  };
}
function save(rec) { return writeIfChanged(file(rec.league, rec.season), rec, { pretty: true, newline: true }); }
function saveSummary(sum) { return writeIfChanged(path.join(DIR, 'summary.json'), sum, { pretty: true, newline: true }); }

module.exports = { SCHEMA, load, freeze, settle, summarize, save, saveSummary, closeFor, entryId, file, QUALIFY };
