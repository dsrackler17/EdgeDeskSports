/* ============================================================================
   CFB Model Lab — the MAJOR-DISAGREEMENT read.

   Every V1 snapshot the lab takes against a market now carries the integrity
   gate's verdict (checkpoint.js -> lib/cfb_disagreement.js). This turns those
   verdicts, and the grades the lab already computes for each snapshot, into
   the numbers that say whether VERIFIED means anything:

     raw major disagreements      7+ gaps, whatever the gate said
     verified / investigate /     the gate's verdicts
       data fault / market fault
     average raw gap              |pure margin - market margin|
     market movement toward       did the close come to EdgeDesk after a
       verified gaps              VERIFIED snapshot, compared with after an
                                  unverified 7+ one
     verified-gap MAE / CLV       graded like every other snapshot
     false-extreme rate           lib/cfb_disagreement.js falseExtreme: the
                                  close did not move toward EdgeDesk AND the
                                  result landed on the market's side. Never
                                  "every losing ticket".

   One snapshot per game: the latest LIVE V1 snapshot that had a market
   (a game is not counted once per checkpoint). Nothing here changes a row.
   ========================================================================== */
'use strict';
const L = require('./lab_core.js');
const DIS = require('../../lib/cfb_disagreement.js');
const U = L.util;

const MAJOR = 7;

function latestPerGame(preds) {
  const by = new Map();
  preds.forEach((p) => {
    if (p.origin !== 'LIVE' || p.engine_id !== 'edgedesk_cfb_p4' || !U.isNum(p.model_market_gap)) return;
    const cur = by.get(p.game_id);
    if (!cur || U.ms(p.prediction_ts) > U.ms(cur.prediction_ts)) by.set(p.game_id, p);
  });
  return [...by.values()];
}

function grade(rows, evalByPred) {
  const ev = rows.map((p) => ({ p, e: evalByPred.get(p.prediction_id) || null }));
  const settled = ev.filter((x) => x.e && x.e.result_status === 'FINAL' && !x.e.void);
  const mv = settled.filter((x) => U.isNum(x.e.close_home_line));
  const toward = mv.map((x) => {
    const g = x.p.model_market_gap, snap = L.conv.bookToMargin(x.p.current_spread), close = L.conv.bookToMargin(x.e.close_home_line);
    const m = (close - snap) * Math.sign(g);
    return Math.abs(close - snap) < 0.25 ? 0.5 : (m > 0 ? 1 : 0);
  });
  const clv = mv.map((x) => (L.conv.bookToMargin(x.e.close_home_line) - L.conv.bookToMargin(x.p.current_spread)) * Math.sign(x.p.model_market_gap));
  const fe = mv.map((x) => DIS.falseExtreme({ fair: x.p.pure_home_margin, open: L.conv.bookToMargin(x.p.current_spread),
    close: L.conv.bookToMargin(x.e.close_home_line), final_margin: x.e.final_margin })).filter((v) => v !== null);
  return {
    n: rows.length, settled: settled.length,
    mae: U.r(U.mean(settled.map((x) => x.e.abs_margin_error)), 3),
    market_mae_at_snapshot: U.r(U.mean(settled.map((x) => Math.abs(L.conv.bookToMargin(x.p.current_spread) - x.e.final_margin))), 3),
    moved_toward_pct: toward.length ? U.r(100 * U.mean(toward), 1) : null,
    clv_points: clv.length ? U.r(U.mean(clv), 3) : null,
    false_extreme_rate_pct: fe.length ? U.r(100 * U.mean(fe.map((v) => (v ? 1 : 0))), 1) : null,
    false_extremes: fe.filter(Boolean).length
  };
}

function section(D) {
  const rows = latestPerGame(D.preds || []);
  const evalByPred = new Map((D.evals || []).map((e) => [e.prediction_id, e]));
  const withVerdict = rows.filter((p) => p.disagreement_status);
  const major = rows.filter((p) => Math.abs(p.model_market_gap) >= MAJOR);
  const by = (st) => major.filter((p) => p.disagreement_status === st);
  const verified = by('VERIFIED_MAJOR_DISAGREEMENT');
  const unverified = major.filter((p) => p.disagreement_status !== 'VERIFIED_MAJOR_DISAGREEMENT');
  const causes = {};
  unverified.forEach((p) => { const c = p.disagreement_root_cause || (p.disagreement_status ? 'UNKNOWN' : 'NOT_RUN'); causes[c] = (causes[c] || 0) + 1; });
  const weeks = {};
  major.forEach((p) => {
    const w = weeks[p.week] || (weeks[p.week] = { raw_7plus: 0, raw_10plus: 0, raw_15plus: 0, verified: 0, investigate: 0, data_fault: 0, market_fault: 0, not_run: 0, favorite_flips: 0 });
    const g = Math.abs(p.model_market_gap);
    w.raw_7plus++; if (g >= 10) w.raw_10plus++; if (g >= 15) w.raw_15plus++;
    if (p.disagreement_status === 'VERIFIED_MAJOR_DISAGREEMENT') w.verified++;
    else if (p.disagreement_status === 'INVESTIGATE') w.investigate++;
    else if (p.disagreement_status === 'DATA_FAULT') w.data_fault++;
    else if (p.disagreement_status === 'MARKET_FAULT') w.market_fault++;
    else w.not_run++;
    if (Math.sign(p.pure_home_margin) !== Math.sign(L.conv.bookToMargin(p.current_spread))) w.favorite_flips++;
  });
  const gv = grade(verified, evalByPred), gu = grade(unverified, evalByPred), gr = grade(major, evalByPred);
  return {
    what: 'the integrity gate’s verdict on V1’s latest market snapshot per game (lib/cfb_disagreement.js), graded like every snapshot',
    definitions: 'docs/cfb-disagreement/DESIGN.md; false extreme = the close did not move toward EdgeDesk AND the result landed on the market’s side (never every losing ticket)',
    games_with_market: rows.length,
    games_with_verdict: withVerdict.length,
    raw_major_disagreements: major.length,
    verified_major_disagreements: verified.length,
    verified_10plus: verified.filter((p) => Math.abs(p.model_market_gap) >= 10).length,
    verified_15plus: verified.filter((p) => Math.abs(p.model_market_gap) >= 15).length,
    investigate: by('INVESTIGATE').length,
    data_fault: by('DATA_FAULT').length,
    market_fault: by('MARKET_FAULT').length,
    verification_not_run: major.filter((p) => !p.disagreement_status).length,
    average_raw_gap: U.r(U.mean(rows.map((p) => Math.abs(p.model_market_gap))), 3),
    average_raw_gap_7plus: U.r(U.mean(major.map((p) => Math.abs(p.model_market_gap))), 3),
    market_movement_toward_verified_pct: gv.moved_toward_pct,
    market_movement_toward_unverified_pct: gu.moved_toward_pct,
    verified_gap_mae: gv.mae, verified_gap_clv: gv.clv_points,
    false_extreme_rate_raw_pct: gr.false_extreme_rate_pct,
    false_extreme_rate_verified_pct: gv.false_extreme_rate_pct,
    graded: { raw_7plus: gr, verified: gv, unverified: gu },
    root_causes_unverified: causes,
    by_week: weeks,
    note: 'VERIFIED is not a bet. The counts are what the gate found, never a quota.'
  };
}

module.exports = { section, latestPerGame, grade };
