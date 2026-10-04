/* ============================================================================
   THE RELIABILITY IMPROVEMENT PLANNER — ENRICHMENT ROI.

   An ENGINEERING diagnostic, not a betting metric. For every data bottleneck:

     games_affected                 games carrying a deduction in it
     current_points_lost            the reliability points those deductions
                                    cost across the slate, as scored
     maximum_recoverable_points     what resolving that work family IN FULL
                                    would recover, game by game, by re-scoring
                                    with the same simulator next actions use
                                    (lib/cfb_reliability.js recoverability):
                                    gates lifted, caps honoured, stability held
     estimated_recoverable_points   the maximum times the share a realistic
                                    integration can reach (config.js ROI
                                    `feasible`, an engineering estimate
                                    published with its reason)
     engineering_priority           ranked by ENRICHMENT ROI =
                                    estimated_recoverable_points / cost

   Points lost and points recoverable are different numbers on purpose: a
   deduction behind a binding cap recovers nothing until the cap lifts, and
   a cap lifted by one input can recover more than that input's own points.
   ========================================================================== */
'use strict';

const C = require('./config.js');

/* which penalty families each work family cures */
const SYMPTOMS = {
  availability: ['availability', 'qb_status'],
  qb_identity: ['qb_identity'],
  qb_conflict: ['qb_conflict'],
  fcs_rating: ['fcs_rating'],
  attribution: ['attribution'],
  market_sources: ['market_sources'],
  market_quote: ['market_quote'],
  starters: ['starters'],
  matchup_profile: ['matchup_profile'],
  stability: ['stability', 'favorite_flips'],
  rating_sample: ['rating_sample']
};

/* rows: [{game_id, reliability: <score() result or the artifact's compact form with penalties + recoverable_by_family>}] */
/* o.market: the enrichment summary's market block. The published build joins
   no market, so market depth is scored only on the board's live join; its
   row carries the games affected and says why it has no points here */
function plan(rows, o) {
  o = o || {};
  const out = {};
  Object.keys(SYMPTOMS).forEach((k) => {
    const cfg = C.ROI[k] || { cost: 3, feasible: 0.5, label: k };
    out[k] = { key: k, label: cfg.label, games_affected: 0, current_points_lost: 0, maximum_recoverable_points: 0,
      games_recoverable: 0, cost: cfg.cost, feasible: cfg.feasible, how: cfg.how || null, recover: cfg.recover || null };
  });
  (rows || []).forEach((x) => {
    const r = x && x.reliability;
    if (!r) return;
    const seen = {};
    (r.penalties || []).forEach((p) => {
      const fam = p.family || (p.action_key ? String(p.action_key).split(':')[0] : null);
      Object.keys(SYMPTOMS).forEach((k) => {
        if (SYMPTOMS[k].indexOf(fam) < 0) return;
        out[k].current_points_lost += p.points || 0;
        if (!seen[k]) { out[k].games_affected++; seen[k] = 1; }
      });
    });
    const rec = r.recoverable_by_family || {};
    Object.keys(rec).forEach((f) => {
      if (!out[f]) return;
      out[f].maximum_recoverable_points += rec[f];
      if (rec[f] > 0) out[f].games_recoverable++;
    });
  });
  const list = Object.values(out).map((b) => {
    b.current_points_lost = Math.round(b.current_points_lost * 10) / 10;
    b.estimated_recoverable_points = Math.round(b.maximum_recoverable_points * b.feasible * 10) / 10;
    b.enrichment_roi = b.cost ? Math.round(100 * b.estimated_recoverable_points / b.cost) / 100 : null;
    return b;
  }).filter((b) => b.games_affected || b.maximum_recoverable_points);
  list.sort((a, b) => (b.enrichment_roi - a.enrichment_roi) || (b.maximum_recoverable_points - a.maximum_recoverable_points));
  list.forEach((b, i) => { b.engineering_priority = i + 1; });
  if (o.market) {
    const cfg = C.ROI.market_sources;
    list.push({ key: 'market_sources', label: cfg.label, games_affected: o.market.under_two_sources, current_points_lost: null,
      maximum_recoverable_points: null, estimated_recoverable_points: null, games_recoverable: null, cost: cfg.cost, feasible: cfg.feasible,
      enrichment_roi: null, engineering_priority: null, how: cfg.how, recover: cfg.recover,
      note: 'not scored in the published build (it joins no market); on the board\u2019s live score it is worth up to 0.5 of the 15 source-integrity points per game, plus the market-age freshness item' });
  }
  return {
    basis: 'ENRICHMENT ROI = estimated recoverable reliability points / implementation-and-data cost (1-5). An engineering diagnostic: '
      + 'where better data would make EdgeDesk know more, not where a bet is.',
    families: list,
    potential: potentialSummary(rows)
  };
}

function potentialSummary(rows) {
  const xs = (rows || []).filter((x) => x && x.reliability && x.reliability.potential != null);
  if (!xs.length) return null;
  const pot = xs.map((x) => typeof x.reliability.potential === 'object' ? x.reliability.potential.score : x.reliability.potential);
  const sc = xs.map((x) => x.reliability.score);
  const mean = (a) => Math.round(10 * a.reduce((s, v) => s + v, 0) / a.length) / 10;
  return { games: xs.length, mean_score: mean(sc), mean_potential: mean(pot),
    basis: 'the mean score if every input with a recovery action were resolved; not a probability and not a forecast' };
}

module.exports = { plan, SYMPTOMS };
