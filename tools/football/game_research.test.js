#!/usr/bin/env node
/* ===========================================================================
   MODEL-FIRST GAME RESEARCH — the snapshot, the graphic, the history, the
   compare-a-price arithmetic and the app wiring. docs/game-research/README.md

   Runs on the committed artifacts (every NFL and FBS game the slates carry)
   and on synthetic games for the edge cases a live slate may not hold today:
   no projection, a data fault, a terminal built from a different run, a
   near pick'em. No network, no browser (tools/football/game_research_ui.e2e.js
   is the browser half).

   Run: node tools/football/game_research.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..', '..');
global.window = global.window || global;
const C = require(path.join(ROOT, 'lib', 'edgedesk_calc.js'));
const GS = require(path.join(ROOT, 'lib', 'edgedesk_game_snapshot.js'));
const GG = require(path.join(ROOT, 'lib', 'edgedesk_game_graphic.js'));
require(path.join(ROOT, 'lib', 'research_core.js'));
const FL = require(path.join(ROOT, 'lib', 'edgedesk_fairline.js'));
const B = require(path.join(__dirname, 'build_game_research.js'));

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) { pass++; return; }
  fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 700) : ''));
}
function section(t) { console.log('\n== ' + t); }
function read(rel) { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')); }
const clone = (x) => JSON.parse(JSON.stringify(x));

const NFL = read('football/nfl/slate.json'), FBS = read('football/fbs/slate.json');
const kicks = NFL.games.concat(FBS.games).map((g) => Date.parse(g.kickoff)).filter(isFinite);
/* a clock before every game on the committed slates, so every game is pregame */
const NOW = new Date(Math.min.apply(null, kicks) - 3600e3).toISOString();
const R = B.build({ now: NOW, history: {}, previous: null });
const games = R.current.games;
const proj = games.filter((g) => g.model.available);

/* ======================================================================= */
section('1. Layer A: one snapshot per game, from the committed model runs');
chk('every NFL and FBS game on the slates has a snapshot (or a named refusal)', games.length + R.current.refused.length === NFL.games.length + FBS.games.length, { games: games.length, refused: R.current.refused });
chk('most games carry a projection', proj.length >= games.length * 0.9, { proj: proj.length, games: games.length });
chk('snapshot ids are content hashes', games.every((g) => /^gr1-[0-9a-f]{16}$/.test(g.snapshot_id)));
chk('snapshot ids are unique', new Set(games.map((g) => g.snapshot_id)).size === games.length);
chk('every id is the hash of everything the snapshot says (poll ranks, labels, records included)', games.every((g) => GS.snapshotId(g) === g.snapshot_id));
{ const t = clone(games[0]); t.home.record = { text: '9-0', as_of: NOW, source: 'tampered' }; chk('a changed record changes the id', GS.snapshotId(t) !== t.snapshot_id); }
chk('the same inputs give the same ids (deterministic)', B.build({ now: NOW, history: {}, previous: null }).current.games.every((g, i) => g.snapshot_id === games[i].snapshot_id));
/* the model block matches the slate it came from, number for number */
const nflBy = {}; NFL.games.forEach((g) => { nflBy['nfl|' + g.game_id] = g; });
const fbsBy = {}; FBS.games.forEach((g) => { fbsBy['cfb|' + g.game_id] = g; });
const off = proj.filter((s) => {
  const g = nflBy[s.game_key] || fbsBy[s.game_key];
  return Math.abs(s.model.home_margin - g.model_home_margin) > 0.005 || Math.abs(s.model.total_exact - g.model_fair_total) > 0.005 || Math.abs(s.model.win_prob.home - g.model_home_win_prob) > 0.00005;
});
chk('every projected number is the slate’s own (margin, total, win probability)', off.length === 0, off.map((s) => s.game_key));

section('2. Layer A never reads a market');
const noToday = B.build({ now: NOW, history: {}, previous: null, today: null });
const sameModel = noToday.current.games.every((g, i) => JSON.stringify(g.model) === JSON.stringify(games[i].model) && JSON.stringify(g.insights) === JSON.stringify(games[i].insights));
chk('without the ESPN slate (records only) every model block and insight is unchanged', sameModel);
const txt = JSON.stringify(R.current);
chk('no sportsbook field reaches a snapshot', !/"(spread_line|total_line|market_home_line|best_price|odds|sportsbook|captured_at|ml_home|reference_market)"/.test(txt));
chk('the NFL reference line (a market number) is not carried', games.filter((g) => g.league === 'nfl').every((g) => !('reference' in g)));

section('3. Phase 8: every projection reconciles with itself');
proj.forEach((s) => {
  const M = s.model;
  const rc = C.scoresReconcile(M.scores.home, M.scores.away, M.home_margin, M.total, M.scores.decimals);
  if (!rc.ok) chk('scores reconcile · ' + s.game_key, false, rc);
  const hs = M.headline_scores;
  if (hs.whole) {
    const dh = +hs.home - +hs.away, sm = +hs.home + +hs.away;
    if (!(Math.abs(dh - M.home_margin) <= 1 && Math.abs(sm - M.total) <= 1)) chk('whole scores within ±1 · ' + s.game_key, false, { hs, m: M.home_margin, t: M.total });
    if (!(Math.sign(Math.round(M.home_margin * 10)) === Math.sign(dh) || (dh === 0 && Math.abs(M.home_margin) < 0.05))) chk('whole scores name the model’s winner · ' + s.game_key, false, { hs, m: M.home_margin });
  }
  if (Math.abs(M.win_prob.home + M.win_prob.away - 1) > 1e-6) chk('win probabilities sum to 1 · ' + s.game_key, false, M.win_prob);
  if (M.win_display.home_pct + M.win_display.away_pct !== 100) chk('displayed win probabilities sum to 100 · ' + s.game_key, false, M.win_display);
  if (Math.abs(M.home_margin) >= 0.05 && (M.home_margin > 0) !== (M.win_prob.home > 0.5)) chk('fair line and win probability name the same favourite · ' + s.game_key, false, M);
  ['home', 'away'].forEach((k) => { const imp = C.impliedFromAmerican(M.fair_ml[k]); if (imp == null || Math.abs(imp - M.win_prob[k]) > 0.01) chk('model moneyline restates the win probability · ' + s.game_key, false, M.fair_ml); });
  if (!/not a sportsbook price/.test(M.fair_ml.label)) chk('model moneyline labelled · ' + s.game_key, false, M.fair_ml.label);
  if (!s.checks.ok) chk('consistency checks pass · ' + s.game_key, false, s.checks.failed);
});
chk('3 · ran over every projected game', proj.length > 0);
chk('reliability is out of 100, never a percent', games.filter((g) => g.confidence.kind === 'reliability').every((g) => !/%/.test(g.confidence.label)));
chk('the NFL publishes no reliability score and none is invented', games.filter((g) => g.league === 'nfl').every((g) => g.confidence.kind === 'data_check' && g.confidence.score === null));
chk('ranks sit inside their league', games.every((g) => (g.units.rows || []).every((u) => ['home', 'away'].every((k) => !u[k] || (u[k].rank >= 1 && (!u[k].of || u[k].rank <= u[k].of))))));
chk('team records, where present, carry their source and time', games.every((g) => ['home', 'away'].every((k) => !g[k].record || (g[k].record.text && g[k].record.as_of && g[k].record.source))));

section('3b. the scoring distribution comes from the same run’s sheet');
const withD = proj.filter((s) => s.distribution);
chk('most projected games carry a scoring distribution', withD.length >= proj.length * 0.9, { with: withD.length, proj: proj.length });
chk('every range is ordered and brackets its centre', withD.every((s) => { const D = s.distribution; return (!D.total || (D.total.p10 < D.total.p90 && D.total.p10 <= s.model.total + 3 && s.model.total - 3 <= D.total.p90))
  && ['home_points', 'away_points'].every((k) => !D[k] || D[k].p10 < D[k].p90); }));
chk('each market’s method and held-out status travel with it', withD.every((s) => Object.keys(s.distribution.markets).every((k) => s.distribution.markets[k].status)));
{
  const g = clone(NFL.games.find((x) => x.model_status === 'PREDICTED'));
  const sh = R.probabilities.sheets['nfl|' + g.game_id] ? B.sheetsFor({ nfl: NFL, cfb: null }, Date.parse(NOW)).full['nfl|' + g.game_id] : null;
  if (sh) {
    const moved = clone(g); moved.model_home_margin += 2; moved.model_home_line -= 2;
    chk('a sheet from another projection never lends its distribution', GS.fromNfl(moved, { teams: NFL.teams, sheet: sh }).distribution === null && !!GS.fromNfl(g, { teams: NFL.teams, sheet: sh }).distribution);
  }
}

section('4. insights come from the snapshot’s own numbers');
let insN = 0;
proj.forEach((s) => {
  const I = s.insights;
  if (I.length > 4) chk('at most four insights · ' + s.game_key, false, I.length);
  if (new Set(I.map((i) => i.family)).size !== I.length) chk('one insight per family · ' + s.game_key, false, I.map((i) => i.family));
  I.forEach((i) => {
    insN++;
    const e = i.evidence || {};
    if (e.units && e.ranks) {
      const rows = e.units.map((k) => (s.units.rows || []).find((u) => u.key === k));
      const all = []; rows.forEach((u) => { if (u) ['home', 'away'].forEach((k) => { if (u[k]) all.push(u[k].rank); }); });
      if (!e.ranks.every((r) => all.indexOf(r) >= 0)) chk('insight ranks are the units’ own · ' + s.game_key + ' ' + i.id, false, { e, all });
      if (!e.ranks.every((r) => i.text.indexOf('#' + r) >= 0)) chk('insight text prints its ranks · ' + s.game_key + ' ' + i.id, false, i.text);
    }
    if (e.term) {
      const d = (s.drivers && s.drivers.rows || []).find((x) => x.key === e.term);
      if (!d || Math.abs(d.points - e.points) > 1e-9) chk('insight points are the model’s own term · ' + s.game_key + ' ' + i.id, false, { e, d });
      if (i.text.indexOf(e.points.toFixed(1)) < 0) chk('insight text prints its points · ' + s.game_key + ' ' + i.id, false, i.text);
    }
    if (!i.text || !i.short || !i.title) chk('insight is complete · ' + s.game_key, false, i);
    if (GG.BANNED.test(i.text) || GG.BANNED.test(i.short)) chk('insight passes the copy rule · ' + s.game_key, false, i.text);
  });
});
chk('insights were generated', insN > proj.length * 2, insN);
chk('no game’s insights are generic copy (every one names a team, a rank or points)', proj.every((s) => s.insights.every((i) => /#\d|\d\.\d|[A-Z][a-z]/.test(i.text))));
chk('a CFB strength insight is the projection’s own term, never a second rating', proj.filter((s) => s.league === 'cfb').every((s) => s.insights.filter((i) => i.family === 'strength').every((i) => !i.evidence.term || i.evidence.term === 'rating')));

/* ======================================================================= */
section('5. edge cases on synthetic games');
const base = clone(NFL.games.find((g) => g.model_status === 'PREDICTED'));
{
  const g = Object.assign(clone(base), { model_status: 'NO_DATA', model_reason: 'no team history for one side', model_home_margin: null });
  const s = GS.fromNfl(g, { teams: NFL.teams, generated_at: NFL.generated_at });
  const av = GS.availability(s, GS.market(null));
  chk('no projection: the model says so, nothing is estimated', !s.model.available && /no team history/.test(s.model.reason) && s.insights.length === 0 && s.data.status === 'UNAVAILABLE', s.model);
  chk('no projection: research UNAVAILABLE, never a fabricated number', av.research === 'UNAVAILABLE' && av.model === 'UNAVAILABLE');
  const c = GG.content(GS.graphicSpec(s), null, { now: Date.parse(NOW) }).content;
  chk('no projection: the graphic shows the limitation and no score', c.model_available === false && !c.scores && !c.total && /RESEARCH LIMITED/.test(c.confidence) && /NO PROJECTION/.test(c.status));
}
{
  const g = Object.assign(clone(base), { model_fair_home_ml: 500, model_fair_away_ml: -500 });
  const s = GS.fromNfl(g, { teams: NFL.teams, generated_at: NFL.generated_at });
  const av = GS.availability(s, GS.market(null));
  chk('an inconsistent input is a DATA FAULT, shown, never smoothed over', s.data.status === 'FAULT' && s.checks.failed.some((f) => f.id === 'model_moneyline_restates_probability'), s.checks);
  chk('a data fault limits research and names the model state', av.research === 'LIMITED' && av.model === 'DATA FAULT');
  const c = GG.content(GS.graphicSpec(s), null, { now: Date.parse(NOW) }).content;
  chk('a data fault is prominent on the graphic', /DATA FAULT: MODEL MONEYLINE/.test(c.fault) && c.status_tone === 'fault');
}
{
  const g = Object.assign(clone(base), { model_home_margin: 0.4, model_home_line: -0.4, model_home_win_prob: 0.512, model_fair_home_ml: null, model_fair_away_ml: null });
  const s = GS.fromNfl(g, { teams: NFL.teams });
  chk('a near pick’em never shows a tied whole-number score', s.model.headline_scores.whole === false || s.model.headline_scores.home !== s.model.headline_scores.away, s.model.headline_scores);
  chk('…and the model moneyline is derived from the win probability', s.model.fair_ml.home === GS.fairAmerican(0.512) && s.model.fair_ml.away === GS.fairAmerican(0.488));
}
{
  const fg = clone(FBS.games.find((g) => g.model_status === 'PREDICTED'));
  const term = read('football/cfb_terminal/games.json').games[String(fg.game_id)];
  if (term) {
    const t2 = clone(term); t2.edgedesk.home_margin += 2; t2.why.final_margin += 2;
    const rk = read('football/rankings/current.json');
    const s = GS.fromCfb(fg, { terminal: t2, rankings: rk.teams, team_count: rk.team_count });
    chk('a terminal built from a different run is not mixed in (no drivers, no range) and says so', !s.drivers && !s.model.range80 && s.data.warnings.some((w) => /earlier projection/.test(w)), { d: s.drivers, w: s.data.warnings });
    const s2 = GS.fromCfb(fg, { terminal: term, rankings: rk.teams, team_count: rk.team_count });
    chk('the same run’s terms reconcile to the margin', !s2.drivers || s2.drivers.reconciles === true);
  }
}

/* ======================================================================= */
section('6. Layer B: the market, labelled honestly');
const t0 = Date.parse('2026-10-16T12:00:00Z');
const live = GS.market({ home_line: -3.5, total: 47.5, ml_home: -170, ml_away: 145, book: 'draftkings', captured_at: new Date(t0 - 12 * 60000).toISOString() }, { now: t0 });
const cached = GS.market({ home_line: -3.5, total: 47.5, book: 'draftkings', captured_at: new Date(t0 - 5 * 3600e3).toISOString() }, { now: t0 });
const stale = GS.market({ home_line: -3.5, captured_at: new Date(t0 - 4 * 864e5).toISOString() }, { now: t0 });
const staleFlag = GS.market({ home_line: -3.5, captured_at: new Date(t0 - 5 * 60000).toISOString(), stale: true }, { now: t0 });
const fault = GS.market({ home_line: -3.5, fault: 'two books disagree on the favourite' }, { now: t0 });
const manual = GS.market({ home_line: -3.5, manual: true, captured_at: new Date(t0).toISOString() }, { now: t0 });
const ref = GS.market({ home_line: -3.5, reference_only: true }, { now: t0 });
const none = GS.market(null);
chk('fresh odds: LIVE and current', live.state === 'LIVE' && live.current && live.age_minutes === 12);
chk('odds a few hours old: CACHED, not current', cached.state === 'CACHED' && !cached.current && /not a current price/.test(cached.reason));
chk('old odds: STALE, not current', stale.state === 'STALE' && !stale.current);
chk('a quote the page marked stale is never LIVE, however recent', staleFlag.state !== 'LIVE' && !staleFlag.current);
chk('a market fault carries no number', fault.state === 'FAULT' && fault.home_line === null && fault.total === null);
chk('a typed price is MANUAL, never current market data', manual.state === 'MANUAL' && !manual.current);
chk('an untimed reference line is REFERENCE, never a price', ref.state === 'REFERENCE' && !ref.current);
chk('no quote: UNAVAILABLE', none.state === 'UNAVAILABLE' && !none.current);
const s0 = proj[0];
const avNone = GS.availability(s0, none, { decision: 'NO_DECISION', blocker_codes: ['NO_MARKET'] });
chk('no odds: research AVAILABLE, model ACTIVE, market UNAVAILABLE, decision NOT EVALUATED', avNone.model !== 'UNAVAILABLE' && avNone.market === 'UNAVAILABLE' && avNone.decision === 'NOT EVALUATED', avNone);
chk('no odds: the exact calm note', avNone.market_note === 'Live sportsbook prices are currently unavailable. EdgeDesk’s independent matchup projections remain available.');
const avStale = GS.availability(s0, stale, { decision: 'NO_DECISION', blocker_codes: ['STALE_QUOTE'] });
chk('stale odds: market STALE, decision NOT EVALUATED (a market blocker, not a model failure)', avStale.market === 'STALE' && avStale.decision === 'NOT EVALUATED' && avStale.blocker_codes[0] === 'STALE_QUOTE');
const avLive = GS.availability(s0, live, { decision: 'PASS', label: 'PASS', blocker_codes: [] });
chk('fresh odds + an evaluated decision: EVALUATED, no outage note', avLive.market === 'LIVE' && avLive.decision === 'EVALUATED' && avLive.market_note === null && avLive.decision_label === 'PASS');
const avModel = GS.availability(s0, live, { decision: 'NO_DECISION', blocker_codes: ['DISTRIBUTION_MISSING'] });
chk('a model blocker is BLOCKED, never softened into a market note', avModel.decision === 'BLOCKED');
chk('a market fault note says the data failed a check', /failed an integrity check/.test(GS.availability(s0, fault, null).market_note));
/* the decision engine's codes: every market code exists there, and the rest are not softened */
const DEC = fs.readFileSync(path.join(ROOT, 'lib', 'edgedesk_decision.js'), 'utf8');
const codes = Array.from(new Set((DEC.match(/blocked\(out, *'([A-Z_]+)'/g) || []).map((x) => x.match(/'([A-Z_]+)'/)[1])));
chk('every market blocker code is one the decision engine emits', Object.keys(GS.MARKET_BLOCKERS).every((k) => codes.indexOf(k) >= 0), { codes, ours: Object.keys(GS.MARKET_BLOCKERS) });
chk('model and game blockers stay full-strength', ['DATA_FAULT', 'DISTRIBUTION_MISSING', 'IMPOSSIBLE_PROBABILITY', 'MODEL_VERSION_UNKNOWN', 'INVALID_GAME', 'EV_SIDE_CONTRADICTION'].every((k) => codes.indexOf(k) >= 0 && !GS.isMarketBlocker(k)));
chk('a market-only NO DECISION is recognised; a mixed one is not', GS.marketOnlyDecision({ decision: 'NO_DECISION', blocker_codes: ['STALE_QUOTE'] }) && !GS.marketOnlyDecision({ decision: 'NO_DECISION', blocker_codes: ['STALE_QUOTE', 'DATA_FAULT'] }) && !GS.marketOnlyDecision({ decision: 'PASS', blocker_codes: [] }));
const cm = GS.compareMarket(s0, live);
const fairD = Math.round(s0.model.fair.home_line * 10), mktD = Math.round(-3.5 * 10);
chk('the displayed spread gap is the difference of the displayed lines', cm.spread.gap === Math.abs(fairD - mktD) / 10, cm.spread);
chk('the market win probability is no-vig and labelled so, beside the model’s', cm.moneyline && /no-vig/.test(cm.moneyline.label) && Math.abs(cm.moneyline.market_no_vig_home + cm.moneyline.market_no_vig_away - 1) < 1e-6);
chk('no comparison against a market that is not current', GS.compareMarket(s0, cached) === null && GS.compareMarket(s0, stale) === null);

/* ======================================================================= */
section('7. compare a price the reader typed (EDFairLine on the snapshot’s own sheet)');
const P = R.probabilities;
chk('a sheet for nearly every projected game', proj.filter((s) => P.sheets[s.game_key]).length >= proj.length * 0.95);
chk('every served sheet was built from its snapshot’s projection', proj.every((s) => !P.sheets[s.game_key] || GS.sheetMatches(s, P.sheets[s.game_key])));
const sN = proj.find((s) => s.league === 'nfl' && P.sheets[s.game_key]), sheetN = P.sheets[sN.game_key], modelN = P.models.nfl;
const r1 = GS.comparePrice(sN, sheetN, modelN, { market: 'spread', side: 'home', line: -sN.model.fair.display < 0 ? Math.round(sN.model.fair.home_line * 2) / 2 : Math.round(sN.model.fair.home_line * 2) / 2, american: -110 }, FL);
chk('a typed spread: implied, model, difference, fair odds', r1.ok && Math.abs(r1.implied - 110 / 210) < 1e-4 && r1.model_prob > 0 && r1.model_prob < 1 && r1.fair_american != null && r1.prob_diff != null, r1.errors || r1);
chk('…labelled a user-entered, unverified quote', r1.label === 'User-entered, unverified sportsbook quote');
chk('…as a cover probability, never a win probability', /cover probability/.test(r1.prob_label) && r1.notes.some((n) => /not a win probability/.test(n)));
chk('EV only where the market’s probabilities are CALIBRATED', (r1.status === 'CALIBRATED') === (r1.ev != null) && (r1.status === 'CALIBRATED' || /not shown/.test(r1.ev_withheld)));
const r2 = GS.comparePrice(sN, sheetN, modelN, { market: 'moneyline', side: 'away', american: 150 }, FL);
chk('a typed moneyline prices the model win probability', r2.ok && /win probability/.test(r2.prob_label) && Math.abs(r2.model_prob - (sheetN.markets.moneyline.away_win)) < 1e-4, r2.errors);
const r3 = GS.comparePrice(sN, sheetN, modelN, { market: 'total', side: 'over', line: Math.round(sN.model.total) + 0.5, american: -105 }, FL);
chk('a typed total prices the over', r3.ok && r3.model_prob > 0, r3.errors);
chk('bad odds are refused with a reason', GS.comparePrice(sN, sheetN, modelN, { market: 'spread', side: 'home', line: -3.5, american: 50 }, FL).errors.some((e) => /American odds/.test(e)));
chk('quarter lines are refused', GS.comparePrice(sN, sheetN, modelN, { market: 'spread', side: 'home', line: -3.25, american: -110 }, FL).errors.some((e) => /half points/.test(e)));
chk('no sheet: no model probability is made up', GS.comparePrice(sN, null, modelN, { market: 'spread', side: 'home', line: -3.5, american: -110 }, FL).ok === false);
const moved = clone(sN); moved.model.home_margin += 1.5;
chk('a sheet from a different projection does not match', GS.sheetMatches(sN, sheetN) && !GS.sheetMatches(moved, sheetN));
const sC = proj.find((s) => s.league === 'cfb' && P.sheets[s.game_key]);
const r4 = GS.comparePrice(sC, P.sheets[sC.game_key], P.models.cfb, { market: 'spread', side: 'away', line: Math.round(-sC.model.fair.home_line * 2) / 2 + 3, american: -110 }, FL);
chk('a CFB typed spread prices on its own league’s sheet', r4.ok, r4.errors);
/* the fair alternate lines the page shows: a better number never prices lower
   (the CFB ladder once read a different table row at every line) */
const ladderDips = Object.keys(P.sheets).filter((k) => { const L = ((P.sheets[k].ladders || {}).spread || []).slice().sort((a, b) => a.home_line - b.home_line); return L.some((r, i) => i > 0 && r.home + r.push < L[i - 1].home + L[i - 1].push - 1.01e-4); });
chk('every spread ladder the build serves: a home line covers at least as often the more points it gets', Object.keys(P.sheets).some((k) => /^cfb/.test(k)) && ladderDips.length === 0, ladderDips.slice(0, 5));
const cfbHalf = Object.keys(P.sheets).filter((k) => /^cfb/.test(k)).filter((k) => { const L = P.sheets[k].ladders.spread, a = L.find((r) => r.home_line === -0.5), b = L.find((r) => r.home_line === 0.5); return a && b && a.home !== b.home; });
chk('CFB has no ties: a served −0.5 and +0.5 cover equally often', cfbHalf.length === 0, cfbHalf.slice(0, 5));
const viaPage = (() => { const k = Object.keys(P.sheets).find((x) => /^cfb/.test(x)), sh = P.sheets[k], c = Math.round(sh.markets.spread.fair_home_line * 2) / 2, ps = []; for (let d = -6; d <= 6; d += 0.5) ps.push(FL.probabilities(sh, { market: 'spread', side: 'home', line: c + d })); return ps; })();
chk('the page reads the same ladder through EDFairLine.probabilities, and it never dips', viaPage.every((p, i) => p && !p.error && (i === 0 || p.win + p.push >= viaPage[i - 1].win + viaPage[i - 1].push - 1.01e-4)));
chk('nothing in the price check writes to storage or the network', !/localStorage|fetch\(|XMLHttpRequest/.test(GS.comparePrice.toString()));

/* ======================================================================= */
section('8. the matchup graphic: the snapshot’s numbers, nothing else');
const W = { square: [1080, 1080], portrait: [1080, 1350] };
let laid = 0;
proj.forEach((s) => {
  const spec = GS.graphicSpec(s), ct = GG.content(spec, null, { now: Date.parse(NOW) });
  if (!ct.ok) { chk('content is made · ' + s.game_key, false, ct); return; }
  const c = ct.content, M = s.model;
  if (c.total !== M.total.toFixed(1)) chk('graphic total is the snapshot’s · ' + s.game_key, false, [c.total, M.total]);
  if (c.scores.home !== M.headline_scores.home || c.scores.away !== M.headline_scores.away) chk('graphic scores are the snapshot’s · ' + s.game_key, false, [c.scores, M.headline_scores]);
  if (c.win.home !== M.win_display.home || c.win.away !== M.win_display.away) chk('graphic win probabilities are the snapshot’s · ' + s.game_key, false, [c.win, M.win_display]);
  if (M.fair.favorite && c.spread_value !== '−' + Math.abs(M.fair.display).toFixed(1)) chk('graphic spread is the snapshot’s · ' + s.game_key, false, [c.spread_value, M.fair]);
  if (Math.abs(+c.points.home + +c.points.away - M.total) > 0.051) chk('projected points add to the total · ' + s.game_key, false, c.points);
  if (c.market) chk('no market panel without a live quote · ' + s.game_key, false, c.market);
  if (!c.detail || c.detail.cells.length < 2 || c.detail.cells.some((x) => !x.v || (Array.isArray(x.v) ? x.v.some((v) => !v || v === '—') : x.v === '—'))) chk('model detail replaces the market, no empty cell · ' + s.game_key, false, c.detail);
  if (/%/.test(c.confidence) && /RELIABILITY/.test(c.confidence)) chk('reliability is never a percent on the graphic · ' + s.game_key, false, c.confidence);
  ['square', 'portrait'].forEach((f) => {
    const L = GG.layout(c, f);
    laid++;
    const [w, h] = W[f];
    if (L.width !== w || L.height !== h) chk('graphic size · ' + f, false, [L.width, L.height]);
    const outside = L.ops.filter((o) => o.type === 'text' && (o.y < 0 || o.y > h || (o.align === 'left' && (o.x < 0 || o.x + Math.min(o.width || 0, o.maxW || 1e9) > w + 1)) || (o.align === 'right' && (o.x > w || o.x - (o.width || 0) < -1)) || (o.align === 'center' && (o.x - (o.width || 0) / 2 < -1 || o.x + (o.width || 0) / 2 > w + 1))));
    if (outside.length) chk('every text op inside the canvas · ' + s.game_key + ' ' + f, false, outside.slice(0, 3).map((o) => [o.text, o.x, o.y, o.width]));
    const over = L.ops.filter((o) => o.type === 'text' && o.maxW && o.width > o.maxW + 1 && o.size > 12);
    if (over.length) chk('every fitted text fits its box · ' + s.game_key + ' ' + f, false, over.slice(0, 3).map((o) => [o.text, o.width, o.maxW]));
  });
});
chk('laid out every projected game in both formats', laid === proj.length * 2, laid);
{
  const s = proj.find((x) => x.insights.length >= 3), spec = GS.graphicSpec(s);
  const cl = GG.content(spec, live, { now: t0 }).content;
  chk('a LIVE quote adds the market panel with its book and capture time', cl.market && /DraftKings/.test(cl.market.meta) && /captured/.test(cl.market.meta) && cl.market.home_spread === '−3.5');
  chk('the market panel labels its probability no-vig', cl.market.no_vig && /%$/.test(cl.market.no_vig.home));
  chk('a CACHED or STALE quote never reaches the graphic', !GG.content(spec, cached, { now: t0 }).content.market && !GG.content(spec, stale, { now: t0 }).content.market);
  const noMl = GS.market({ home_line: -3.5, total: 47.5, book: 'fanduel', captured_at: new Date(t0 - 5 * 60000).toISOString() }, { now: t0 });
  const L2 = GG.layout(GG.content(spec, noMl, { now: t0 }).content, 'square');
  chk('a quote without a moneyline draws no moneyline column (no empty box)', !L2.ops.some((o) => o.type === 'text' && o.text === 'MONEYLINE'));
  const bad = clone(spec); bad.insights[0].short = 'Lock of the week';
  chk('the copy rule refuses a tout word anywhere on the graphic', GG.content(bad, null).ok === false && GG.content(bad, null).reason === 'copy_rule');
  const k1 = GG.cacheKey(spec, null, 'square'), k2 = GG.cacheKey(spec, null, 'square'), k3 = GG.cacheKey(spec, null, 'portrait'), k4 = GG.cacheKey(spec, live, 'square');
  const spec2 = clone(spec); spec2.snapshot_id = 'gr1-0000000000000000';
  chk('cache: the same snapshot and quote reuse one key', k1 === k2);
  chk('cache: a new snapshot, a new format or a new quote draws again', k1 !== GG.cacheKey(spec2, null, 'square') && k1 !== k3 && k1 !== k4);
  chk('cache: a stale quote does not change the model-only graphic', GG.cacheKey(spec, stale, 'square') === k1);
  const alt = GG.altText(GG.content(spec, null).content);
  chk('alt text reads the numbers and the tagline', alt.indexOf(s.model.total.toFixed(1)) >= 0 && /Research, not picks\./.test(alt) && alt.indexOf(s.model.fair.text) >= 0);
  chk('the file is named for the matchup and format', /^edgedesk-.+-at-.+-portrait\.png$/.test(GG.fileName(GG.content(spec, null).content, 'portrait')));
  chk('no team logo or helmet asset is drawn', !GG.layout(GG.content(spec, null).content, 'square').ops.some((o) => o.type === 'image'));
}

/* ======================================================================= */
section('9. history: append-only, one row per change in what the graphic prints');
const hist = {};
R.current.games.forEach((g) => { hist[g.game_key] = { snapshot_id: g.snapshot_id, graphic_key: GS.graphicKey(g), recorded_at: NOW, spec: GS.graphicSpec(g), trail: [] }; });
const again = B.build({ now: NOW, history: hist, previous: R.current });
chk('an unchanged slate appends nothing', Object.keys(again.appendBySeason).length === 0, Object.keys(again.appendBySeason));
const nfl2 = clone(NFL); const gch = nfl2.games.find((g) => g.model_status === 'PREDICTED');
gch.model_home_margin += 1.3; gch.model_home_line -= 1.3;
const changed = B.build({ now: NOW, history: hist, previous: R.current, nfl: nfl2 });
const appended = [].concat.apply([], Object.values(changed.appendBySeason)).map((s) => s.game_key);
chk('a moved projection appends exactly that game', appended.length >= 1 && appended.indexOf('nfl|' + gch.game_id) >= 0 && appended.every((k) => k === 'nfl|' + gch.game_id), appended);
const row = B.historyRow(R.current.games[0], NOW);
chk('a history row carries the graphic spec that redraws it', row.spec && row.spec.snapshot_id === row.snapshot_id && GG.content(row.spec, null).ok);
const later = new Date(Date.parse(gch.kickoff) + 3600e3).toISOString();
const after = B.build({ now: later, history: hist, previous: R.current });
const frozen = after.current.games.find((g) => g.game_key === 'nfl|' + gch.game_id);
const orig = R.current.games.find((g) => g.game_key === 'nfl|' + gch.game_id);
chk('a game that kicked off keeps its frozen pregame snapshot, marked started', frozen && frozen.started === true && frozen.snapshot_id === orig.snapshot_id);
chk('…and never gets a new history row', ![].concat.apply([], Object.values(after.appendBySeason)).some((s) => s.game_key === 'nfl|' + gch.game_id));
const muchLater = new Date(Date.parse(gch.kickoff) + 40 * 3600e3).toISOString();
chk('…for a day and a half, then it leaves current.json', !B.build({ now: muchLater, history: hist, previous: R.current }).current.games.some((g) => g.game_key === 'nfl|' + gch.game_id));
try {
  const out = execFileSync(process.execPath, [path.join(__dirname, 'build_game_research.js'), '--check'], { cwd: ROOT, encoding: 'utf8' });
  chk('the committed artifact passes its integrity check (--check)', /self-consistent/.test(out), out);
} catch (e) { chk('the committed artifact passes its integrity check (--check)', false, String(e.stdout || e.stderr || e.message).slice(0, 300)); }
{
  /* the integrity check catches a snapshot edited after it was hashed */
  const curFile = path.join(ROOT, 'football', 'game_research', 'current.json'), orig = fs.readFileSync(curFile, 'utf8');
  try {
    const t = JSON.parse(orig); t.games[0].model.total = t.games[0].model.total + 3; fs.writeFileSync(curFile, JSON.stringify(t));
    let failed = false; try { execFileSync(process.execPath, [path.join(__dirname, 'build_game_research.js'), '--check'], { cwd: ROOT, stdio: 'pipe' }); } catch (_) { failed = true; }
    chk('--check fails on a snapshot edited after it was hashed', failed);
  } finally { fs.writeFileSync(curFile, orig); }
}
{
  /* …and a served ladder that covers less often at a better line (the CFB dip) */
  const prFile = path.join(ROOT, 'football', 'game_research', 'probabilities.json'), orig = fs.readFileSync(prFile, 'utf8');
  try {
    const t = JSON.parse(orig), k = Object.keys(t.sheets).find((x) => /^cfb/.test(x) && t.sheets[x].ladders && t.sheets[x].ladders.spread.length > 4);
    const L = t.sheets[k].ladders.spread, i = L.findIndex((r) => r.home_line === 0.5), j = L.findIndex((r) => r.home_line === -0.5);
    L[i].home = Math.round((L[j].home - 0.002) * 1e4) / 1e4; L[i].away = Math.round((1 - L[i].home - L[i].push) * 1e4) / 1e4; /* +0.5 below −0.5: Tulane's dip */
    fs.writeFileSync(prFile, JSON.stringify(t));
    let msg = ''; try { execFileSync(process.execPath, [path.join(__dirname, 'build_game_research.js'), '--check'], { cwd: ROOT, stdio: 'pipe' }); } catch (e) { msg = String(e.stderr || ''); }
    chk('--check fails on a spread ladder that covers less often at a better line', /covers less often at a better line/.test(msg), msg.slice(0, 200));
  } finally { fs.writeFileSync(prFile, orig); }
}
const ledgerDir = path.join(ROOT, 'football', 'game_research', 'history');
if (fs.existsSync(ledgerDir)) fs.readdirSync(ledgerDir).filter((f) => /\.jsonl$/.test(f)).forEach((f) => {
  const lines = fs.readFileSync(path.join(ledgerDir, f), 'utf8').split('\n').filter(Boolean);
  chk('the history ledger parses line by line · ' + f, lines.every((l) => { try { const r = JSON.parse(l); return r.schema === B.HISTORY_SCHEMA && r.spec; } catch (_) { return false; } }));
  chk('history rows are pregame only · ' + f, lines.every((l) => { const r = JSON.parse(l); return Date.parse(r.recorded_at) < Date.parse(r.kickoff); }));
});

/* ======================================================================= */
section('10. the app: wiring, the calm market note, the model-first lead');
const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
const at = (s) => APP.indexOf(s);
chk('the snapshot loads after the calculation layer it reads', at('/lib/edgedesk_calc.js') > 0 && at('/lib/edgedesk_game_snapshot.js') > at('/lib/edgedesk_calc.js'));
chk('the graphic and the page load after the snapshot', at('/lib/edgedesk_game_graphic.js') > at('/lib/edgedesk_game_snapshot.js') && at('/lib/edgedesk_game_view.js') > at('/lib/edgedesk_game_graphic.js'));
chk('every new file is cache-busted with one version', (APP.match(/edgedesk_game_(snapshot|graphic|view)\.(js|css)\?v=(\d{8}[a-z0-9]*)/g) || []).map((x) => x.split('?v=')[1]).every((v, i, a) => v === a[0]));
chk('the stylesheet and the display face are linked', at('/lib/edgedesk_game_view.css') > 0 && /family=Barlow\+Condensed/.test(APP));
chk('the page has its view, owned by the Research seat', at('<section id="v-game" class="view hide">') > 0 && /NAV_OWNER\.game='research';/.test(APP));
chk('#game/<league>/<id> routes to the page', /if\(\/\^#game\\\/\(nfl\|cfb\)\\\/\/\.test\(h\)\)/.test(APP));
chk('links from outside the board open the research page, the board card is the fallback', /window\.fbOpenGameFromDesk=function\(sport,gid\)\{[\s\S]{0,400}gvOpen\(lg,gid,\{replace:[\s\S]{0,120}fallback:true\}\)/.test(APP));
chk('the board’s own openers are untouched (fbOpenGame, the module hook)', /window\.fbOpenGame=function\(sport,gid\)\{\s*gid=String\(gid\);/.test(APP) && /openEntity:function\(id\)\{var s=String\(id==null\?'':id\)/.test(APP));
chk('the CFB card still puts the action card above the research', /body=fbDecCardHTML\(dec\)\+fbGxPropsSec\(u\)\+'<div data-edd-research="/.test(APP));
chk('both cards lead with the model', /\+fbGameResearchLead\('nfl',g\.game_id,homeName,awayName,mdl\.fair_spread,mdl\.fair_total,mdl\.home_win_prob/.test(APP) && /var lead=fbGameResearchLead\('cfb',gid,/.test(APP) && /\+lead\+body\+/.test(APP));
/* run the app's own fbDecCardHTML and fbGameResearchLead on stubs */
function slice(name) { const i = APP.indexOf('function ' + name + '('); let d = 0, j = APP.indexOf('{', i); for (let k = j; k < APP.length; k++) { if (APP[k] === '{') d++; else if (APP[k] === '}') { d--; if (!d) return APP.slice(i, k + 1); } } return null; }
const fbEsc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sandbox = { window: { EDDecision: { TOOLTIP: { model_fair: 'EdgeDesk’s own fair line for this game.' } }, EDDecisionUI: { actionCardHTML: (d) => '<section class="edd-act edd-none">EDGEDESK DECISION · NO DECISION · BLOCKER ' + (d.blocker_codes || []).join(',') + '</section>' }, EDGameSnapshot: GS, EDCalc: C, EDGameView: {} }, fbEsc, FBQEV: {} };
const mk = new Function('window', 'fbEsc', 'FBQEV', slice('fbDecCardHTML') + '\n' + slice('fbGameResearchLead') + '\nreturn {fbDecCardHTML, fbGameResearchLead};');
const F = mk(sandbox.window, fbEsc, sandbox.FBQEV);
const calm = F.fbDecCardHTML({ game_id: '1', sport: 'NFL', decision: 'NO_DECISION', blocker_codes: ['STALE_QUOTE'] });
chk('a stale quote: the calm note leads, the full card (blocker code included) sits under Lab details', /MARKET COMPARISON · BETTING DECISION NOT EVALUATED/.test(calm) && calm.indexOf('Live sportsbook prices are currently unavailable') < calm.indexOf('<details') && /<details class="edd-mkt-why"><summary>Lab details[\s\S]*STALE_QUOTE[\s\S]*<\/details>/.test(calm), calm);
chk('…keeping the decision text for every reader that looks for it', /NO DECISION/.test(calm) && /BLOCKER/.test(calm));
const calmFair = F.fbDecCardHTML({ game_id: '1', sport: 'NFL', decision: 'NO_DECISION', blocker_codes: ['STALE_QUOTE'], model_fair_text: 'Jacksonville Jaguars -2.2' });
chk('…and the model’s own number stays in view, with its term tip, before the Lab details', /data-ed-tip="model_fair"/.test(calmFair) && calmFair.indexOf('Jacksonville Jaguars -2.2') < calmFair.indexOf('<details'), calmFair.slice(0, 400));
chk('a CFB stale quote keeps "View full research" (beginner mode collapses the research)', /data-edd-act="research" data-edd-gid="9"/.test(F.fbDecCardHTML({ game_id: '9', sport: 'CFB', decision: 'NO_DECISION', blocker_codes: ['NO_MARKET'] })));
const full = F.fbDecCardHTML({ game_id: '1', sport: 'NFL', decision: 'NO_DECISION', blocker_codes: ['DISTRIBUTION_MISSING'] });
chk('a model blocker keeps the full decision card, unsoftened', !/edd-mkt-only/.test(full) && /DISTRIBUTION_MISSING/.test(full));
chk('an evaluated decision keeps the full card', !/edd-mkt-only/.test(F.fbDecCardHTML({ game_id: '1', sport: 'NFL', decision: 'PASS', blocker_codes: [] })));
const lead = F.fbGameResearchLead('nfl', 'G1', 'Jacksonville Jaguars', 'Houston Texans', 2.23, 41.49, 0.5824, false);
chk('the lead prints the card’s own projection, reconciled, and the door to the page', /Houston Texans 19\.65 · Jacksonville Jaguars 21\.85/.test(lead) && /Jacksonville Jaguars -2\.2 · 41\.5/.test(lead) && /58%/.test(lead) && /gvOpen\('nfl','G1'\)/.test(lead), lead);
chk('a game that kicked off has no research-page button on its lead', !/gvOpen/.test(F.fbGameResearchLead('nfl', 'G1', 'A', 'B', 2, 40, 0.6, true)));
const VIEW = fs.readFileSync(path.join(ROOT, 'lib', 'edgedesk_game_view.js'), 'utf8');
chk('the page states the calm note from the snapshot layer, not its own copy', /av\.market_note/.test(VIEW));
chk('the page never stores a typed price', !/setItem\([^)]*price|localStorage[\s\S]{0,40}price/i.test(VIEW));
chk('the Research level offers the fair alternate lines from the snapshot’s own sheet', /data-gv-act="alts"/.test(VIEW) && /FL\.probabilities\(sh, \{ market: 'spread'/.test(VIEW) && /Not sportsbook prices/.test(VIEW));
chk('the graphic is the first section of the page', VIEW.indexOf('h += graphicBlock(s);') < VIEW.indexOf('h += overview(s, av);') && VIEW.indexOf('h += overview(s, av);') < VIEW.indexOf('h += deep(s, mk);') && VIEW.indexOf('h += deep(s, mk);') < VIEW.indexOf('h += marketSection(s, mk, av);'));

console.log('\n' + (fail ? 'FAIL' : 'PASS') + ' | game research (snapshot, graphic, history, price check, wiring) | ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
