/* ===========================================================================
   SIGNAL CENTER — one evaluation: every source in, every eligible signal out.
   Pure: no clock (now is passed), no network, no file. tools/signal_center/
   run.js does the reading and the writing around it.
   =========================================================================== */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const E = require(path.join(ROOT, 'lib', 'edgedesk_signal_engine.js'));
const DNA = require(path.join(ROOT, 'lib', 'edgedesk_model_dna.js'));
const REG = require(path.join(ROOT, 'lib', 'edgedesk_signal_registry.js'));
const { perfKeyFor } = require('./sources.js');

const ms = (t) => { const x = Date.parse(t); return isFinite(x) ? x : null; };
function latest(series) {
  let best = null;
  (series || []).forEach((r) => { if (r && typeof r.p_home === 'number' && r.data_status !== 'UNAVAILABLE' && (!best || ms(r.at) > ms(best.at))) best = r; });
  return best;
}
function latestQuote(list) {
  let best = null;
  (list || []).forEach((q) => { if (q && (!best || ms(q.captured_at) > ms(best.captured_at))) best = q; });
  return best;
}

/* inputs:
     football        sources.footballGames()      [{game, series}]
     footballCurrent sources.footballCurrent()
     perfGames       sources.perfForecastGames()  [{game, series}]
     perfLastCapture performance summary ledger.last_capture_at
     quotes          sources.perfQuotes()         Map(perf event key -> quotes)
     slateTeams      sources.slateTeams()         Map(slate id -> {home, away})
     audits          { registry, perf }
     cfbAvailability sources.cfbAvailability()
     sourceStates    sources.sourceStates()
     db (optional)   { simPairs:[{pair, results}], simReference:[...],
                       nbaInjuries:[rows], nbaEffects:{}, kalshi: Map(event key -> {p_home, captured_at}),
                       priorDivergences:[payloads] }
     now, fixture */
function evaluate(inputs) {
  const now = inputs.now;
  const ctxBase = { now, fixture: !!inputs.fixture };
  const out = { signals: [], dna: [], refused: [], ineligible: {}, stats: {} };
  const refuse = (cat, sport, reason, key) => out.refused.push({ category: cat, sport, reason, key: key || null });
  const eligible = (sport, cat) => {
    const e = REG.eligible(sport, cat);
    if (!e.ok) { const k = sport + ':' + cat; out.ineligible[k] = e.state + ' — ' + e.reason; }
    return e.ok;
  };

  const football = inputs.football || [];
  const perfGames = inputs.perfGames || [];
  const allGames = football.concat(perfGames);
  const gameBy = new Map(allGames.map((g) => [g.game.event_key, g]));

  /* ---- Model DNA, and the reliability grade every signal carries */
  const serving = {}, versions = {};
  (inputs.footballCurrent && inputs.footballCurrent.games || []).forEach((g) => { serving[g.league] = { id: g.model.model_id, version: g.model.model_version }; });
  /* the serving model of a ledger sport is the model of its most recent
     forecast, across every event (football's is the snapshot now served) */
  const newest = {};
  allGames.forEach((g) => {
    const sp = g.game.sport;
    (versions[sp] = versions[sp] || new Set());
    g.series.forEach((r) => { if (r.model_version) versions[sp].add(r.model_version); if (r.model_id) versions[sp].add(r.model_id); });
    const l = latest(g.series);
    if (l && (!newest[sp] || ms(l.at) > ms(newest[sp].at))) newest[sp] = l;
  });
  Object.keys(newest).forEach((sp) => { if (!serving[sp]) serving[sp] = { id: newest[sp].model_id, version: newest[sp].model_id }; });
  const vbs = {}; Object.keys(versions).forEach((k) => { vbs[k] = Array.from(versions[k]); });
  out.dna = DNA.build(inputs.audits && inputs.audits.registry, inputs.audits && inputs.audits.perf, serving, now);
  const reliability = DNA.gradeMap(out.dna, vbs);
  const ctx = Object.assign({}, ctxBase, { reliability });

  /* ---- forecast shifts: pass 1 collects every comparable move (the
     point-in-time rarity reference), pass 2 makes the signals */
  const reference = {};
  allGames.forEach((g) => { E.forecastShifts(g.series, g.game, { now }).moves.forEach((m) => (reference[m.league] = reference[m.league] || []).push(m)); });
  allGames.forEach((g) => {
    if (!eligible(g.game.sport, 'FORECAST_SHIFT')) return;
    E.forecastShifts(g.series, g.game, Object.assign({}, ctx, { reference })).signals.forEach((s) => out.signals.push(s));
  });

  /* ---- model vs market */
  const slateTeams = inputs.slateTeams || new Map();
  const quotes = inputs.quotes || new Map();
  const kalshi = (inputs.db && inputs.db.kalshi) || new Map();
  const divRows = [];
  const attach = (q) => {
    if (!q) return null;
    const t = q.slate_id ? slateTeams.get(q.slate_id) : null;
    return Object.assign({}, q, t ? { home: t.home, away: t.away } : { oriented_by: null });
  };
  (inputs.footballCurrent && inputs.footballCurrent.games || []).forEach((cg) => {
    const g = gameBy.get(cg.event_key);
    if (!g) return;
    const q = attach(latestQuote(quotes.get(perfKeyFor(cg.event_key))));
    if (!q) return;
    const k = kalshi.get(cg.event_key) || null;
    const val = (inputs.audits && inputs.audits.registry) ? marketValidation(inputs.audits.registry, g.game.sport) : null;
    divRows.push({ game: g.game, model: Object.assign({}, cg.model, { validation: val }), quote: q, kalshi: k, context: cg.context || null });
  });
  perfGames.forEach((g) => {
    const l = latest(g.series);
    if (!l) return;
    const q = attach(latestQuote(quotes.get(g.game.event_key)));
    if (!q) return;
    /* the ledger appends only on change: the latest revision is the current
       forecast as of the ledger's last capture pass */
    const isLatest = true;
    const model = { p_home: l.p_home, at: isLatest && inputs.perfLastCapture ? inputs.perfLastCapture : l.at, snapshot_id: l.snapshot_id, model_id: l.model_id, model_version: l.model_version, built_at: l.built_at, data_status: l.data_status, validation: l.validation };
    divRows.push({ game: g.game, model, quote: q });
  });
  const divEligible = divRows.filter((r) => eligible(r.game.sport, 'MARKET_DIVERGENCE'));
  const dv = E.marketDivergence(divEligible, ctx);
  dv.signals.forEach((s) => out.signals.push(s));
  dv.refused.forEach((r) => refuse('MARKET_DIVERGENCE', null, r.reason, r.event_key));
  out.stats.board_gaps = dv.gaps.length;
  const conv = E.marketConvergence((inputs.db && inputs.db.priorDivergences) || [], divEligible.filter((r) => eligible(r.game.sport, 'MARKET_CONVERGENCE')), ctx);
  conv.forEach((s) => out.signals.push(s));

  /* ---- line movement, same book only */
  const lmRef = {};
  const lmGames = [];
  quotes.forEach((list, perfKey) => {
    const key = /^(NFL|CFB)\|/.test(perfKey) ? perfKey.replace(/^(NFL|CFB)\|/, (m, a) => a.toLowerCase() + '|') : perfKey;
    const g = gameBy.get(key);
    if (!g) return;
    lmGames.push({ g, list });
    E.lineMovement(list, g.game, { now }).moves.forEach((m) => (lmRef[m.league] = lmRef[m.league] || []).push(m));
  });
  lmGames.forEach(({ g, list }) => {
    if (!eligible(g.game.sport, 'LINE_MOVEMENT')) return;
    E.lineMovement(list, g.game, Object.assign({}, ctx, { reference: lmRef })).signals.forEach((s) => out.signals.push(s));
  });

  /* ---- the Simulator: published run against the run it replaced */
  ((inputs.db && inputs.db.simPairs) || []).forEach(({ pair, results }) => {
    if (!eligible(pair.sport, 'SIMULATION_SHIFT')) return;
    const r = E.simulationShifts(pair, results, Object.assign({}, ctx, { reference: (inputs.db.simReference || {})[pair.sport] || [] }));
    r.signals.forEach((s) => out.signals.push(s));
    r.refused.forEach((x) => refuse('SIMULATION_SHIFT', pair.sport, x.reason, x.entity ? x.entity + ':' + x.outcome : null));
  });

  /* ---- availability */
  if (eligible('cfb', 'INJURY_IMPACT')) {
    E.injuryChanges(inputs.cfbAvailability || [], Object.assign({}, ctx, { positions: REG.sport('cfb') ? ['QB'] : [] })).forEach((s) => out.signals.push(s));
  }
  if (inputs.db && inputs.db.nbaInjuries && eligible('nba', 'INJURY_IMPACT')) {
    E.injuryChanges(inputs.db.nbaInjuries, Object.assign({}, ctx, { effects: inputs.db.nbaEffects || {} })).forEach((s) => out.signals.push(s));
  }

  /* ---- audits */
  E.reliabilityWarnings(out.dna.filter((d) => eligible(d.sport, 'MODEL_RELIABILITY_WARNING')), ctx).forEach((s) => out.signals.push(s));
  E.dataQuality(inputs.sourceStates || [], ctx).forEach((s) => out.signals.push(s));

  /* one payload per key: the latest evaluation of the same comparison wins
     (identical comparisons hash identically, so this only drops duplicates) */
  const seen = new Map();
  out.signals.forEach((s) => seen.set(s.signal_key, s));
  out.signals = Array.from(seen.values()).sort((a, b) => String(a.signal_key).localeCompare(String(b.signal_key)));
  const by = {};
  out.signals.forEach((s) => { const k = s.category + ' ' + s.sport + ' ' + s.verification.state; by[k] = (by[k] || 0) + 1; });
  out.stats.by_category = by;
  out.stats.signals = out.signals.length;
  return out;
}

/* the moneyline market test from the backtest registry, for the caveat */
function marketValidation(registry, sport) {
  const id = sport;
  const s = ((registry && registry.sports) || []).filter((x) => x.id === id)[0];
  const m = s && s.readiness && s.readiness.markets && s.readiness.markets.moneyline;
  return m ? { state: m.state, market_test: m.market, value_claims: m.value_claims === true } : null;
}

module.exports = { evaluate, latest, latestQuote };
