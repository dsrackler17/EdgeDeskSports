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

const ms = (t) => { const x = typeof t === 'number' ? t : Date.parse(t); return isFinite(x) ? x : null; };
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
     footballLedger  sources.footballLedgerGames() [{game, series}] (before research)
     footballCurrent sources.footballCurrent()
     perfGames       sources.perfForecastGames()  [{game, series}]
     perfLastCapture performance summary ledger.last_capture_at
     quotes          sources.allQuotes()          Map(perf event key -> quotes)
     slateTeams      sources.slateTeams()         Map(slate id -> {home, away})
     audits          { registry, perf }
     cfbAvailability sources.cfbAvailability()
     nflInjuries     sources.nflInjuries()        designations dated by EdgeDesk's first sight
     sourceStates    sources.sourceStates()
     db (optional)   { simPairs:[{pair, results}], simReference:[...],
                       nbaInjuries:[rows], nbaEffects:{}, kalshi: Map(event key -> {p_home, captured_at}),
                       ncaamGames / ncaawGames:[{game, series}] (db.ncaamGames, db.ncaawGames), priorDivergences:[payloads] }
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
  /* the ledger's football rows from before research covered a game: their
     own series, listed first so the research entry is the game's identity;
     then forecast history kept in the database (men's and women's college basketball's daily runs) */
  const dbGames = ((inputs.db && inputs.db.ncaamGames) || []).concat((inputs.db && inputs.db.ncaawGames) || []);
  const allGames = (inputs.footballLedger || []).concat(football, perfGames, dbGames);
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
  /* the past boards first: the live evaluation below replaces any comparison
     that is still current (one payload per key, the latest wins) */
  const rp = replayMarket(allGames, gameBy, quotes, ctx, (sp, cat) => eligible(sp, cat));
  rp.signals.forEach((s) => out.signals.push(s));
  out.stats.replay = rp.stats;
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
  /* NFL: quarterbacks, as CFB; the row is dated by EdgeDesk's first sight (no publication time exists) */
  if (eligible('nfl', 'INJURY_IMPACT')) {
    E.injuryChanges(inputs.nflInjuries || [], Object.assign({}, ctx, { positions: ['QB'] })).forEach((s) => out.signals.push(s));
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

/* ---- model vs market, replayed point in time. At each quote capture pass
   the board is rebuilt from the records stamped at or before that moment
   (lib/edgedesk_replay.js's rule: a later record is never read): each game's
   latest model snapshot and latest price, judged by the same engine with
   now = the pass. A comparison is kept the first time it crossed the floor,
   which is when the hourly evaluation would have found it; a convergence the
   first time a disagreement found earlier closed. Only prices that carry the
   teams' names are replayed: an unnamed price can be oriented only by
   today's slate, which says nothing about a past board. */
const PASS_GAP_MS = 10 * 60000;
const MOVE_PP = 2;
function lastAtOrBefore(list, t, at) {
  let lo = 0, hi = list.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (ms(at(list[mid])) <= t) lo = mid + 1; else hi = mid; }
  return lo ? list[lo - 1] : null;
}
function replayMarket(allGames, gameBy, quotes, ctx, eligible) {
  const T = E.SPEC.thresholds.market_divergence;
  const stats = { passes: 0, comparisons: 0, refused: 0, divergences: 0, convergences: 0 };
  const now = ms(ctx.now);
  const models = new Map();
  /* each snapshot keeps the source it came from (a game can have a ledger
     series before its research series), so a signal cites the right file */
  allGames.forEach((g) => g.series.forEach((r) => {
    if (r.data_status === 'UNAVAILABLE' || !(typeof r.p_home === 'number' && r.p_home > 0 && r.p_home < 1) || ms(r.at) === null) return;
    if (!models.has(g.game.event_key)) models.set(g.game.event_key, []);
    models.get(g.game.event_key).push(Object.assign({}, r, { source: g.game.source }));
  }));
  models.forEach((l) => l.sort((a, b) => ms(a.at) - ms(b.at)));
  const events = [];
  quotes.forEach((list, perfKey) => {
    const key = perfKey.replace(/^(NFL|CFB)\|/, (m, a) => a.toLowerCase() + '|');
    const g = gameBy.get(key);
    if (!g || !models.has(key) || !eligible(g.game.sport, 'MARKET_DIVERGENCE')) return;
    const qs = list.filter((q) => q.home && q.away && ms(q.captured_at) !== null && ms(q.captured_at) <= now).sort((a, b) => ms(a.captured_at) - ms(b.captured_at));
    if (qs.length) events.push({ game: g.game, quotes: qs, models: models.get(key) });
  });
  const times = [];
  events.forEach((e) => e.quotes.forEach((q) => times.push(ms(q.captured_at))));
  times.sort((a, b) => a - b);
  const passes = [];
  times.forEach((t) => { const p = passes[passes.length - 1]; if (p && t - p.end <= PASS_GAP_MS) p.end = t; else passes.push({ end: t }); });
  /* one disagreement per episode (event, book, side, model version): a
     refreshed snapshot with the same gap is the same story, so a new signal
     only when the gap moved MOVE_PP since the last one (E.materialUpdate's
     rule for a new version) or the earlier one closed */
  const found = new Map(), last = new Map(), closed = new Set();
  const episode = (s) => [s.event.key, String(s.market && s.market.book).toLowerCase(), s.subject.side, s.model.version].join('|');
  passes.forEach((pass) => {
    const at = pass.end;
    const rows = [];
    events.forEach((e) => {
      if (e.game.event_at && ms(e.game.event_at) <= at) return;
      const q = lastAtOrBefore(e.quotes, at, (x) => x.captured_at);
      if (!q || at - ms(q.captured_at) > T.quote_live_minutes * 60000) return;
      const m = lastAtOrBefore(e.models, at, (x) => x.at);
      if (!m) return;
      rows.push({ game: Object.assign({}, e.game, { source: m.source }), quote: q,
        model: { p_home: m.p_home, at: m.at, snapshot_id: m.snapshot_id, model_id: m.model_id, model_version: m.model_version, built_at: m.built_at, data_status: m.data_status, validation: m.validation || null } });
    });
    if (!rows.length) return;
    stats.passes++; stats.comparisons += rows.length;
    const pctx = Object.assign({}, ctx, { now: new Date(at).toISOString(), detected_at: ctx.now });
    const dv = E.marketDivergence(rows, pctx);
    stats.refused += dv.refused.length;
    dv.signals.forEach((s) => {
      const prev = last.get(episode(s));
      if (found.has(s.signal_key) || (prev && !closed.has(prev.signal_key) && Math.abs(s.values.change_pp - prev.values.change_pp) < MOVE_PP)) return;
      found.set(s.signal_key, s); last.set(episode(s), s); stats.divergences++;
    });
    const prior = Array.from(last.values()).filter((d) => !closed.has(d.signal_key));
    E.marketConvergence(prior, rows.filter((r) => eligible(r.game.sport, 'MARKET_CONVERGENCE')), pctx).forEach((c) => {
      if (closed.has(c.identity.from)) return;
      closed.add(c.identity.from); found.set(c.signal_key, c); stats.convergences++;
    });
  });
  return { signals: Array.from(found.values()), stats };
}

/* the moneyline market test from the backtest registry, for the caveat */
function marketValidation(registry, sport) {
  const id = sport;
  const s = ((registry && registry.sports) || []).filter((x) => x.id === id)[0];
  const m = s && s.readiness && s.readiness.markets && s.readiness.markets.moneyline;
  return m ? { state: m.state, market_test: m.market, value_claims: m.value_claims === true } : null;
}

module.exports = { evaluate, latest, latestQuote, replayMarket };
