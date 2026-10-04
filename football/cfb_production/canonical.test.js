#!/usr/bin/env node
/* ===========================================================================
   CFB production — the canonical prediction pathway and its numeric safety
   (docs/cfb-production/CANONICAL.md). Offline, deterministic.

     1  one canonical pathway: no consumer recomputes (a scan of the repository),
        and the official status has ONE definition (audit F-22 / F-23)
     2  the canonical service: identical numbers, input contract, refusals
     3  degraded modes, fallback order (the manifest's), public display policy
     4  numeric safety: bounds, consistency, cover-vs-line, precision measured
     5  time: explicit as_of, UTC instants, DST
     6  property tests (seeded): a better line never lowers cover probability,
        a worse price never raises EV, a price never moves the pure number
     7  golden games (golden/expected.json)
     8  pipeline chaos at the stored-projections level
     9  immutable snapshots: the Lab row carries the canonical verdict; a changed
        input is a new ADHOC version that names the row it supersedes
    10  the promotion guard
    11  audit fixes: lab ensemble_version, the pinned decision policy loader
    12  reproducibility: every preserved LIVE snapshot re-run; settlement re-graded

   Run: node football/cfb_production/canonical.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const CANON = require('./canonical.js');
const N = require('./numeric.js');
const PR = require('./projections.js');
const GOLD = require('./golden.js');
const PG = require('./promotion.js');
const RP = require('./reproduce.js');
const COMPAT = require('./compat.js');

const ROOT = path.join(__dirname, '..', '..');
let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) {
  if (typeof ok === 'function') { try { ok = ok(); } catch (e) { ok = false; detail = { threw: String((e && e.message) || e) }; } }
  if (ok) { pass++; return; }
  fail++; failures.push({ name, detail });
}
const throws = (fn) => { try { fn(); return false; } catch (e) { return true; } };
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const E = CANON.loadEngine();
const V = E.engine;
const cur = JSON.parse(read('football/cfb_v2/current.json'));
const G = GOLD.load();
const base = G.rows['401858250'];          // a real V2.1 row (North Carolina vs Notre Dame)
const AS_OF = '2026-09-28T12:00:00.000Z';

/* ======================================================= 1 one pathway */
{
  /* every file that can reach the V2 engine: it loads engine.js or names EDCfbV2 */
  const skip = /(^|\/)(node_modules|research|candidates|artifacts|\.git)(\/|$)|\.test\.js$|\/tests\.js$|\/golden\.js$/;
  const files = [];
  const walk = (d) => { for (const f of fs.readdirSync(path.join(ROOT, d))) { const rel = d ? d + '/' + f : f; if (skip.test(rel)) continue;
    const st = fs.statSync(path.join(ROOT, rel)); if (st.isDirectory()) { if (!/^(football|tools|admin|supabase|lib|games|articles|newsletter|collective|mlb|research|record)/.test(rel.split('/')[0]) && d === '') continue; walk(rel); }
    else if (/\.(js|html|ts)$/.test(f) && st.size < 8 * 1024 * 1024) files.push(rel); } };
  ['football', 'tools', 'admin', 'supabase', 'lib'].forEach((d) => { if (fs.existsSync(path.join(ROOT, d))) walk(d); });
  ['app.html', 'record.html', 'brief.html', 'index.html'].forEach((f) => files.push(f));
  /* code only: block comments and whole-line // comments are documentation, not calls */
  const code = (f) => read(f).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  const reach = files.filter((f) => { const t = read(f); return /^football\/cfb_v2\//.test(f) || /cfb_v2[\\/'"+ ,]*engine(\.js)?['"]|EDCfbV2\b|'engine\.js'/.test(t); });
  const PURE_OK = ['football/cfb_production/canonical.js', 'football/cfb_v2/engine.js'];
  const DECIDE_OK = ['football/cfb_v2/engine.js', 'football/cfb_lab/models.js', 'football/cfb_decision/shadow.js', 'football/cfb_v2/shadow_decisions.js'];
  /* any receiver but the canonical service itself (E2.pure, eng.engine.pure, window.EDCfbV2.pure ...) */
  const pureCalls = reach.filter((f) => !PURE_OK.includes(f) && /\b(?!CANON\b|canon\b)[A-Za-z_$][\w$]*\s*\.\s*pure\s*\(/.test(code(f)));
  const decideCalls = reach.filter((f) => !DECIDE_OK.includes(f) && /(\bEDCfbV2|\bE\d*|\beng\w*|\bengine|\bV2\.eng|\bV\d*)\s*\.\s*decide\s*\(/.test(code(f)));
  chk('pathway: no file outside canonical.js calls the V2 engine\'s pure() (' + reach.length + ' files can reach it)', pureCalls.length === 0, pureCalls);
  chk('pathway: engine.decide() runs only in the stored-research producers (Model Lab, decision shadow, shadow decisions)', decideCalls.length === 0, decideCalls);
  const pages = ['app.html', 'record.html', 'brief.html', 'index.html'].concat(files.filter((f) => /^admin\/|^supabase\/functions\/|^tools\/(newsletter|articles|editorial)\//.test(f)));
  const pageLoads = pages.filter((f) => /cfb_v2\/engine\.js|cfb_v2\/params\.js|EDCfbV2\.(pure|decide|card)/.test(read(f)));
  chk('pathway: no page, admin view, edge function, newsletter or article loads the V2 engine', pageLoads.length === 0, pageLoads);
  const nodeConsumers = ['football/cfb_lab/models.js', 'football/cfb_decision/shadow.js', 'football/cfb_v2/sync_supabase.js', 'football/cfb_v2/shadow_decisions.js', 'football/fbs/build_coverage.js'];
  chk('pathway: the scan covers every known consumer (it cannot pass by seeing nothing)', nodeConsumers.every((f) => reach.includes(f)), nodeConsumers.filter((f) => !reach.includes(f)));
  chk('pathway: every node consumer of a V2 projection goes through canonical.pure', nodeConsumers.every((f) => /canonical\.js/.test(read(f)) && /\.pure\(/.test(read(f)) && /(CANON|canon)\.pure\(/.test(read(f))), nodeConsumers.filter((f) => !/(CANON|canon)\.pure\(/.test(read(f))));
  const app = read('app.html');
  const panel = app.slice(app.indexOf('function fbV2ShadowHTML('), app.indexOf('/* THE EVIDENCE PACKET'));
  chk('pathway: the app\'s V2 loader reads the stored projections, not an engine', /reports\/projections\.json/.test(app) && !/fbScript\('football\/cfb_v2\/(engine|params)\.js'\)/.test(app));
  /* F-22: one definition of the official status */
  chk('F-22: the app shows the governed policy\'s status as "Official decision" and the stage-8 status only as research',
    /Official decision/.test(panel) && /od=e\.official_decision/.test(panel) && /Research only/.test(panel) && !/research_status/.test(panel) && !/\.decide\(/.test(panel));
  const X = require(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', '_cfb_explain.js'));
  const labLean = { prediction_id: 'p', home_team: 'A', away_team: 'B', pure_home_margin: 3, home_win_probability: 0.6, decision_class: 'LEAN', status: 'LEAN', decision_source: 'engine:edgedesk_cfb_v2.1.0', side: 'HOME', recommended_line: -2.5 };
  chk('F-22: an explanation never takes the Lab\'s stage-8 class as the official status', X.cfbFacts(labLean).decision.status === 'NO BET' && X.cfbFacts(labLean, { status: 'PASS', basis: 'cfb_decision_policy_v1' }).decision.status === 'PASS');
  const official = PR.officialDecision([
    { engine_role: 'CURRENT', engine_version: 'cfb_decision_baseline_001', policy_version: 'baseline_rule', status: 'LEAN', book: 'a', observed_at: '2026-09-28T10:00:00Z' },
    { engine_role: 'CHALLENGER', engine_version: 'cfb_decision_engine_v1', policy_version: 'cfb_decision_policy_v1', status: 'PASS', book: 'a', observed_at: '2026-09-28T10:00:00Z', reason_codes: ['PASS_PRICE'] }], Date.parse(AS_OF));
  chk('F-22: the stored official decision comes from the governed policy (CHALLENGER rows), never the stage-8 CURRENT rows', official.status === 'PASS' && /cfb_decision_policy_v1/.test(official.basis));
  chk('F-22: with no governed decision the stored status is NO_DECISION, not the research status', PR.officialDecision([{ engine_role: 'CURRENT', status: 'LEAN', observed_at: AS_OF }], Date.parse(AS_OF)).status === 'NO_DECISION');
  /* audit F-30 / F-31: what is published as THE decision (officialFor) */
  const betRow = PR.officialDecision([{ engine_role: 'CHALLENGER', engine_version: 'cfb_decision_engine_v1', policy_version: 'cfb_decision_policy_v1', status: 'BET',
    side: 'HOME', line_for_side: -3.5, price: -110, book: 'a', decision_id: 'd-bet', observed_at: '2026-09-28T10:00:00Z' }], Date.parse(AS_OF));
  const lv = (level) => ({ level, reason: 'r' });
  const refusedBet = PR.officialFor(betRow, lv(1), false);
  chk('F-30: a BET row while the governed policy has betting off is refused (NO_DECISION with the alarm), never published',
    betRow.status === 'BET' && refusedBet.status === 'NO_DECISION' && refusedBet.alarm.indexOf('BET_WHILE_BETTING_DISABLED') >= 0 && refusedBet.refused_decision_id === 'd-bet', refusedBet);
  chk('F-30: a BET without side, line and price is refused even with betting on',
    PR.officialFor(Object.assign({}, betRow, { price: null }), lv(1), true).status === 'NO_DECISION');
  chk('F-30: a complete BET under a policy with betting on is published as it is', PR.officialFor(betRow, lv(1), true).status === 'BET');
  chk('F-30: the committed policy has betting off, so build() refuses a BET row by default',
    PR.build({ now: AS_OF, decisions: [], predictions: [] }) && PR.officialFor(betRow, lv(2), undefined).status === 'NO_DECISION');
  const lean = Object.assign({}, betRow, { status: 'LEAN' });
  chk('F-30: a governed LEAN passes through unchanged', PR.officialFor(lean, lv(2), false) === lean);
  const atFallback = PR.officialFor(lean, lv(3), false);
  chk('F-31: at level 3 (the V1 number is the fallback) no decision made from V2.1 is published beside it',
    atFallback.status === 'NO_DECISION' && /level 3/.test(atFallback.reason) && atFallback.withheld_decision_id === 'd-bet', atFallback);
  chk('F-31: level 4 stays UNAVAILABLE', PR.officialFor(lean, lv(4), false).status === 'UNAVAILABLE');
  const labPage = read('admin/cfb-lab/index.html');
  chk('F-22: the Lab page labels its classes research (never "Decision")', /'Research class','Research position'/.test(labPage) && !/'Gap','Decision','Position'/.test(labPage));
  chk('F-23: no display calls the stage-8 EV strength or the P(positive CLV) tier "edge quality" or "bet quality"',
    !/edge_quality:'Edge quality'/.test(labPage) && /Stage-8 EV strength/.test(labPage) && /closing-line movement, not bet quality/i.test(PR.TENDENCY_NOTE)
    && !/(>|')\s*(Edge|Bet) quality/.test(panel) && /Closing-line tendency/.test(panel));
}

/* ======================================================= 2 the service */
{
  const rows = cur.rows;
  const same = rows.every((r) => { const a = CANON.pure(r), b = V.pure(r, {}); return JSON.stringify(a) === JSON.stringify(b); });
  chk('service: canonical.pure returns exactly the engine\'s projection for every live row (' + rows.length + ')', same);
  const snaps = rows.map((r) => CANON.snapshot(r, { as_of_ts: AS_OF }));
  chk('service: every live row passes the input contract and the numeric checks', snaps.every((s) => s.contract.ok && s.numeric.ok), snaps.filter((s) => !(s.contract.ok && s.numeric.ok)).map((s) => [s.game_id, s.reason]));
  chk('service: a snapshot carries versions, the input time, the hashes and the contract', snaps.every((s) => s.model_version === 'edgedesk_cfb_v2.1.0' && s.feature_version && s.params_sha256 && s.prediction_ts && s.input_hash && s.snapshot_id && s.contract.version));
  chk('service: the same inputs and as_of give the same snapshot (deterministic)', JSON.stringify(CANON.snapshot(base, { as_of_ts: AS_OF })) === JSON.stringify(CANON.snapshot(base, { as_of_ts: AS_OF })));
  chk('service: a later as_of is a new snapshot id, the same projection hash', (() => { const a = CANON.snapshot(base, { as_of_ts: AS_OF }), b = CANON.snapshot(base, { as_of_ts: '2026-09-28T13:00:00Z' }); return a.snapshot_id !== b.snapshot_id && a.projection_hash === b.projection_hash; })());
  const refused = (patch) => CANON.pure(Object.assign({}, base, patch));
  chk('contract: a missing margin is UNAVAILABLE, never a default', refused({ ens_pred: null }).status === 'UNAVAILABLE');
  chk('contract: text where a number belongs is UNAVAILABLE', refused({ sigma: '15.2' }).status === 'UNAVAILABLE');
  chk('contract: an impossible sigma is UNAVAILABLE', refused({ sigma: 0.5 }).status === 'UNAVAILABLE' && refused({ sigma: 400 }).status === 'UNAVAILABLE');
  chk('contract: home = away is UNAVAILABLE', refused({ away_id: base.home_id }).status === 'UNAVAILABLE');
  chk('contract: a prediction stamped after kickoff is UNAVAILABLE', refused({ prediction_ts: '2026-12-01T00:00:00Z' }).status === 'UNAVAILABLE');
  chk('contract: a naive (zone-less) kickoff is UNAVAILABLE', refused({ kickoff: '2026-10-03 19:30' }).status === 'UNAVAILABLE');
  chk('contract: an ensemble that is not the weighted components is UNAVAILABLE', refused({ components: { C_ridge: 1, D_gbm: 1 } }).status === 'UNAVAILABLE');
  chk('contract: a missing "priced" flag is UNAVAILABLE (never priced by default)', refused({ priced: undefined }).status === 'UNAVAILABLE');
  chk('contract: another version\'s row through this engine is UNAVAILABLE', refused({ model_version: 'edgedesk_cfb_v2.0.0' }).status === 'UNAVAILABLE'
    && CANON.pure(base, { row_model_version: 'edgedesk_cfb_v2.0.0' }).status === 'UNAVAILABLE');
  const rep = JSON.parse(read('football/cfb_v2/snapshots/2026/replay_to_date.json'));
  chk('contract: the v2.0.0 replay file run through the v2.1 engine is refused row by row (' + rep.rows.length + ')',
    rep.rows.every((r) => CANON.pure(r, { row_model_version: rep.model_version }).status === 'UNAVAILABLE'));
  const deg = CANON.snapshot(Object.assign({}, base, { ens_sd: null }), { as_of_ts: AS_OF });
  chk('contract: a missing decision input (ens_sd, read as 3 by engine.decide) keeps the projection and marks the decision inputs incomplete',
    deg.status === 'PREDICTED' && deg.contract.decision_inputs_complete === false && /ens_sd/.test(deg.contract.degrade.join()));
  chk('contract: the declared contract names every engine row input it guards', CANON.loadContract().row_inputs.length >= 20);
  chk('service: snapshot() refuses to run without as_of_ts (no clock inside)', throws(() => CANON.snapshot(base, {})) && throws(() => PR.build({})));
  chk('service: canonical.js and numeric.js never read the clock', !/Date\.now\(|new Date\(\)/.test(read('football/cfb_production/canonical.js')) && !/Date\.now\(|new Date\(\)/.test(read('football/cfb_production/numeric.js')));
}

/* ======================================================= 3 modes, fallback, display */
{
  const s = (row, ctx) => CANON.snapshot(Object.assign({}, base, row || {}), { as_of_ts: AS_OF, context: ctx || {} });
  const full = s(null, { market_integrity: { status: 'OK' } });
  chk('modes: a clean row with an OK market is FULL, level 1', full.degraded.modes.join() === 'FULL' && full.fallback_level === 1);
  const qb = s({ qb_missing_any: 1, qb: { home: null, away: base.qb.away } });
  chk('modes: a missing quarterback is QB_UNCERTAIN (level 2)', qb.degraded.modes.includes('QB_UNCERTAIN') && qb.fallback_level === 2);
  chk('modes: the weekly engine\'s DEGRADED_PBP / DEGRADED_AVAILABILITY / FALLBACK map to the brief\'s names',
    s({ model_modes: ['DEGRADED_PBP', 'DEGRADED_AVAILABILITY'] }).degraded.modes.join() === 'NO_PLAYER_DATA,NO_ADVANCED_PBP' && CANON.ENGINE_MODE.FALLBACK === 'FALLBACK_MODEL');
  const mk = s(null, { market_integrity: { status: 'DEGRADED', actionable_status: 'MARKET_DEGRADED' } });
  chk('modes: a degraded market is MARKET_DEGRADED but never lowers the football level (the pure number does not read the market)', mk.degraded.modes.includes('MARKET_DEGRADED') && mk.fallback_level === 1);
  chk('modes: low QB / injury certainty and incomplete PBP are visible modes', s(null, { qb_certainty: 20, injury_certainty: 30, pbp_completeness: 0.7 }).degraded.modes.join() === 'NO_PLAYER_DATA,NO_ADVANCED_PBP,QB_UNCERTAIN');
  const H = CANON.hierarchy();
  chk('fallback: the manifest declares FULL -> DEGRADED -> FALLBACK_MODEL (V1) -> UNAVAILABLE', H && H.map((x) => x.mode).join() === 'FULL,DEGRADED,FALLBACK_MODEL,UNAVAILABLE' && H[2].model_version === 'edgedesk_cfb_p4_v1.0.0');
  const bad = CANON.snapshot(Object.assign({}, base, { ens_pred: null }), { as_of_ts: AS_OF });
  const v1 = { status: 'PREDICTED', margin: -20, model_version: 'edgedesk_cfb_p4_v1.0.0' };
  chk('fallback: level 1 / 2 are V2.1, level 3 is V1 when V2.1 is unavailable, level 4 when neither', CANON.resolve(full, v1).level === 1 && CANON.resolve(qb, v1).level === 2
    && CANON.resolve(bad, v1).level === 3 && CANON.resolve(bad, v1).model_version === 'edgedesk_cfb_p4_v1.0.0' && CANON.resolve(bad, null).level === 4 && CANON.resolve(null, null).mode === 'UNAVAILABLE');
  chk('fallback: a fallback never carries the other model\'s number (resolve returns no numbers)', !('projected_margin' in CANON.resolve(bad, v1)) && !('margin' in CANON.resolve(bad, v1)));
  chk('display: a degraded projection withholds its confidence score and says why in words', qb.display.show_confidence_score === false && qb.display.label === 'Quarterback not confirmed');
  chk('display: FULL shows its confidence score', full.display.show_confidence_score === true && full.display.label === null);
  const fav = s({ ens_pred: 30, components: { C_ridge: 30, D_gbm: 30 }, qb_missing_any: 1, qb: { home: null, away: {} } });
  chk('display: a degraded 90%+ favourite is "strong favourite (reason)", never a precise 97%', /^strong favourite \(/.test(fav.display.win_probability_text));
  chk('display: an unavailable projection shows no numbers', CANON.display(bad).show_numbers === false);
}

/* ======================================================= 4 numeric safety */
{
  const p = V.pure(base, {});
  chk('numeric: the engine\'s projection passes sanity and consistency', N.sanity(p).length === 0 && N.consistency(p, { row: base, stack_weights: CANON.stackWeights() }).length === 0);
  const t = (mut) => { const x = JSON.parse(JSON.stringify(p)); mut(x); return N.sanity(x).concat(N.consistency(x, {})); };
  chk('numeric: a flipped fair line is caught', t((x) => { x.fair_spread_home_line = x.projected_margin; }).some((m) => /FAIR_LINE/.test(m)));
  chk('numeric: win probabilities that do not sum to 1 are caught', t((x) => { x.away_win_prob = 0.5; }).some((m) => /SUM_TO_1/.test(m)));
  chk('numeric: reversed and un-nested intervals are caught', t((x) => { x.intervals.p80 = [x.intervals.p80[1], x.intervals.p80[0]]; }).some((m) => /INTERVAL/.test(m)));
  chk('numeric: a win probability on the wrong side of the margin is caught', t((x) => { x.home_win_prob_raw = x.projected_margin > 0 ? 0.2 : 0.8; }).some((m) => /SIDE/.test(m)));
  chk('numeric: a score difference that is not the margin is caught', N.consistency(Object.assign({}, p, { projected_home_points: 30, projected_away_points: 10 }), {}).some((m) => /SCORE_DIFF/.test(m)));
  chk('numeric: out-of-bounds margins, sigmas and probabilities are caught', t((x) => { x.projected_margin = 90; }).some((m) => /MARGIN_OUT/.test(m)) && t((x) => { x.sigma = 0.1; }).some((m) => /SIGMA/.test(m)) && t((x) => { x.home_win_prob = 1.2; }).some((m) => /PROB/.test(m)));
  chk('numeric: a legitimate 60-point favourite is not refused (its rounded certainty is a note)', N.sanity(V.pure(Object.assign({}, base, { ens_pred: 60, components: { C_ridge: 60, D_gbm: 60 } }), {})).length === 0
    && N.roundingNotes(V.pure(Object.assign({}, base, { ens_pred: 60 }), {})).length === 1);
  /* cover probability consistent with the line and the distribution, at every line */
  let covBad = 0, covN = 0, maxLoss = 0;
  cur.rows.forEach((r) => { const pp = V.pure(r, {}); if (pp.status !== 'PREDICTED') return;
    for (let L = -30; L <= 30; L += 0.5) {
      const d = V.decide(pp, { current: { home_line: L, ts: AS_OF }, price_home: -110, price_away: -110 }, { row: r, now: AS_OF });
      if (typeof d.cover_probability_raw !== 'number') continue;
      covN++; if (N.coverConsistency(pp, d, V).length) covBad++;
      const fullH = 1 - V.tCdf((-L - r.ens_pred) / r.sigma, pp.t_df), want = d.side === 'HOME' ? fullH : 1 - fullH;
      maxLoss = Math.max(maxLoss, Math.abs(want - d.cover_probability_raw));
    } });
  chk('numeric: every stage-8 cover probability matches the engine\'s distribution at its line (' + covN + ' checks)', covN > 1000 && covBad === 0, covBad);
  /* PRECISION: engine.decide() reads the pure projection's rounded margin (0.01) and sigma (0.001),
     then rounds to 1e-4. Measured, bounded, not fixed (engine.js is pinned): CANONICAL.md §5 */
  chk('precision: rounding before computing in the pinned engine moves a cover probability by < 2.5e-4 (measured ' + maxLoss.toExponential(2) + ')', maxLoss < 2.5e-4, maxLoss);
  const pStored = cur.rows.filter((r) => typeof r.p_home === 'number' && r.priced !== false);
  const pDiff = Math.max.apply(null, pStored.map((r) => Math.abs(r.p_home - V.pure(r, {}).home_win_prob)));
  chk('precision: the Python p_home stored in current.json and the engine\'s win probability agree to 1e-4 (measured ' + pDiff.toExponential(2) + ')', pDiff <= 1.0001e-4, pDiff);
  chk('policy consistency: a BET while betting is disabled, or a stake on a non-BET, is flagged', N.policyConsistency({ status: 'BET', bet_enabled: false }).includes('BET_WHILE_BETTING_DISABLED')
    && N.policyConsistency({ decision_class: 'PASS', stake_units: 1 }).includes('STAKE_ON_A_NON_BET'));
  chk('numeric: display rounding is the only rounding the pathway adds', N.displayRound(0.54567, 3) === 0.546 && N.displayRound(null) === null);
}

/* ======================================================= 5 time */
{
  chk('time: a naive local timestamp is refused; offsets are normalised to UTC', N.utc('2026-10-03 19:30') === null && N.utc('2026-10-03T19:30:00-04:00') === '2026-10-03T23:30:00.000Z');
  chk('time: hours to kickoff across the US DST change (2026-11-01) are exact UTC hours', N.hoursBetween('2026-10-31T17:00:00Z', '2026-11-01T17:00:00Z') === 24
    && N.hoursBetween('2026-10-31T12:00:00-04:00', '2026-11-01T12:00:00-05:00') === 25);
  const L = require(path.join(ROOT, 'football', 'cfb_lab', 'lab_core.js'));
  chk('time: the Model Lab\'s checkpoint windows are UTC arithmetic (DST cannot move a window)', L.hoursToKickoff('2026-11-01T17:00:00Z', '2026-10-31T17:00:00Z') === 24 && L.windowFor(24) === 'T24');
  chk('time: requireAsOf refuses a missing or naive as_of_ts', throws(() => N.requireAsOf({})) && throws(() => N.requireAsOf({ as_of_ts: '2026-10-01' })) && N.requireAsOf({ as_of_ts: AS_OF }) === AS_OF);
  const local = ['football/cfb_production', 'football/cfb_lab', 'football/cfb_decision', 'football/cfb_market'].flatMap((d) => fs.readdirSync(path.join(ROOT, d)).filter((f) => f.endsWith('.js') && !/test/.test(f)).map((f) => d + '/' + f))
    .filter((f) => /\.(getHours|getDate|getMonth|getFullYear|getDay|getMinutes|setHours|setDate)\(|new Date\(\d{4},/.test(read(f)));
  chk('time: no local-time getter or local Date constructor in the production code', local.length === 0, local);
}

/* ======================================================= 6 property tests */
{
  const D = require(path.join(ROOT, 'football', 'cfb_decision', 'decision.js'));
  const art = COMPAT.decisionArtifacts();
  let seed = 20260927;
  const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; };
  const priced = cur.rows.filter((r) => r.priced !== false);
  let better = 0, betterBad = [], evBad = [], priceMoves = [], polBad = [], n = 0;
  for (let i = 0; i < 400; i++) {
    const r = priced[Math.floor(rnd() * priced.length)];
    const p = V.pure(r, {});
    const L = Math.round((rnd() * 50 - 25) * 2) / 2, step = 0.5 * (1 + Math.floor(rnd() * 6));
    const q = (line, ph, pa) => ({ book: 'b', quote_id: 'q', game_id: String(r.game_id), market_type: 'spread', source: 'book', home_line: line, price_home: ph, price_away: pa, observed_at: '2026-09-28T11:59:00.000Z', is_pregame: true });
    const dec = (line, ph, pa) => V.decide(p, { current: { home_line: line, ts: '2026-09-28T11:59:00.000Z' }, price_home: ph, price_away: pa }, { row: r, now: AS_OF });
    /* (a) a better number for HOME (a larger home line) never lowers P(home covers); for AWAY the mirror */
    const a = dec(L, -110, -110), b = dec(L + step, -110, -110);
    const ph = (d) => (d.side === 'HOME' ? d.cover_probability : 1 - d.cover_probability);
    if (typeof a.cover_probability === 'number' && typeof b.cover_probability === 'number') { n++; if (ph(b) < ph(a) - 1e-9) betterBad.push([r.game_id, L, step]); else better++; }
    const ctx = { policy: art.policy, artifact: art.calibration, now: Date.parse(AS_OF), _mc: D.marketConfidence(q(L, -110, -110), { books: 3, dispersion_iqr: 0 }, Date.parse(AS_OF), art.policy), row: r };
    const hA = D.sideNumbers(p, q(L, -110, -110), 'HOME', ctx), hB = D.sideNumbers(p, q(L + step, -110, -110), 'HOME', ctx);
    const aA = D.sideNumbers(p, q(L, -110, -110), 'AWAY', ctx), aB = D.sideNumbers(p, q(L + step, -110, -110), 'AWAY', ctx);
    if (hB.pure_cover_probability < hA.pure_cover_probability - 1e-12 || aB.pure_cover_probability > aA.pure_cover_probability + 1e-12) polBad.push([r.game_id, L, step]);
    /* (b) a worse price for the side never raises its EV (stage-8 EV at a price; the policy's theoretical EV) */
    const pr1 = -105 - Math.floor(rnd() * 20), pr2 = pr1 - 5 - Math.floor(rnd() * 20);
    const e1 = dec(L, pr1, pr1), e2 = dec(L, pr2, pr2);
    if (e1.side === e2.side && typeof e1.expected_value_per_unit === 'number' && e2.expected_value_per_unit > e1.expected_value_per_unit + 1e-12) evBad.push(['stage8', r.game_id, L, pr1, pr2]);
    const t1 = D.sideNumbers(p, q(L, pr1, -110), 'HOME', ctx), t2 = D.sideNumbers(p, q(L, pr2, -110), 'HOME', ctx);
    if (t2.theoretical_ev > t1.theoretical_ev + 1e-12) evBad.push(['policy theoretical', r.game_id, L, pr1, pr2]);
    /* (c) a price-only change never moves the pure fair spread */
    if (e1.pure_fair_margin !== e2.pure_fair_margin || e1.pure_fair_margin !== p.projected_margin) priceMoves.push(r.game_id);
  }
  chk('property: a better offered spread never lowers the stage-8 cover probability (' + n + ' random pairs)', n > 200 && betterBad.length === 0, betterBad.slice(0, 5));
  chk('property: a better offered spread never lowers the policy\'s pure cover probability (either side)', polBad.length === 0, polBad.slice(0, 5));
  chk('property: a worse price never improves EV (stage-8 and the policy\'s theoretical EV)', evBad.length === 0, evBad.slice(0, 5));
  chk('property: a price-only change never moves the pure fair spread', priceMoves.length === 0, priceMoves.slice(0, 5));
  const s1 = CANON.snapshot(base, { as_of_ts: AS_OF, context: { market_integrity: { status: 'OK' } } }), s2 = CANON.snapshot(base, { as_of_ts: AS_OF, context: { market_integrity: { status: 'INVALID' } } });
  chk('property: the market context changes the modes, never the canonical projection', s1.projection_hash === s2.projection_hash && s1.degraded.modes.join() !== s2.degraded.modes.join());
  chk('property: the pure projection is frozen (a consumer cannot write into it)', throws(() => { 'use strict'; const p = CANON.pure(base); p.projected_margin = 0; }));
}

/* ======================================================= 7 golden games */
{
  const d = GOLD.compare();
  chk('golden: every golden game reproduces its stored invariant outputs (' + GOLD.load().cases.length + ' cases)', d.length === 0, d.slice(0, 2));
  const exp = JSON.parse(fs.readFileSync(path.join(GOLD.DIR, 'expected.json'), 'utf8')).cases;
  const by = (s) => exp.find((c) => c.scenario.indexOf(s) === 0);
  chk('golden: road favourite names the AWAY team with the negated home margin', by('road favourite').pure.fair_spread_display === 'Notre Dame -23.0' && by('road favourite').pure.projected_margin < 0);
  chk('golden: FCS is projected but never priced; the stale market fails closed in both engines', by('FCS').pure.status === 'NOT_PRICED' && by('stale market').governed.reason_codes.includes('PASS_MARKET_STALE') && by('stale market').stage8_research.stale);
  chk('golden: postponed and canceled games settle VOID, never a loss', by('postponed').settlement.ats_result === 'VOID' && by('canceled').settlement.ats_result === 'VOID');
  chk('golden: four starters OUT widen sigma and leave the margin', by('multiple injuries: four').pure.sigma > by('multiple injuries: none').pure.sigma && by('multiple injuries: four').pure.projected_margin === by('multiple injuries: none').pure.projected_margin);
  chk('golden: a QB ruled OUT moves the margin by the measured change effect and widens the interval', by('QB change: home starter reported OUT').pure.projected_margin < by('QB change: no report').pure.projected_margin && by('QB change: home starter').pure.sigma > by('QB change: no report').pure.sigma);
  chk('golden: an impossible margin is refused and falls to V1; a v2.0.0 row cannot use the v2.1 decision calibration', by('impossible').resolved.level === 3 && by('neutral site').governed.reason_codes.includes('NO_BET_VERSION_MISMATCH'));
}

/* ======================================================= 8 chaos (stored projections) */
{
  const kick = Date.parse(base.kickoff);
  const now = new Date(kick - 30 * 3600000).toISOString();
  /* Both sides of the chaos slate come from the goldens. r2 used to be taken
     from the live football/cfb_v2/current.json, so every CFB build rewrote it
     and the section passed or failed on whichever row happened to sit first
     that day — a frozen fixture paired with a regenerated artifact. */
  const r2 = Object.assign({}, Object.values(G.rows).find((r) => r.priced !== false && r.game_id !== base.game_id), { kickoff: base.kickoff });
  const build = (rows, slate) => PR.build({ now, files: { 'football/cfb_v2/current.json': { model_version: 'edgedesk_cfb_v2.1.0', generated_at: now, rows },
    'football/fbs/slate.json': slate || { games: [] }, 'football/cfb_production/manifest.json': JSON.parse(read('football/cfb_production/manifest.json')) }, predictions: [], decisions: [] });
  const g = (rep, id) => rep.games.find((x) => x.game_id === String(id));
  /* Both chaos fixtures come from the goldens. r2 was previously read from the
     live football/cfb_v2/current.json, so every CFB build rewrote it and the
     section passed or failed on whichever priced row happened to sit first
     that day. Its definition was then lost in a merge, which left section 8
     referencing an undefined r2 and the whole suite unable to run. */
  const r2 = Object.assign({}, Object.values(G.rows).find((r) => r.priced !== false && r.game_id !== base.game_id), { kickoff: base.kickoff });
  const ok = build([base, r2]);
  chk('chaos: a clean slate resolves every game at level 1 or 2', ok.games.length === 2 && ok.games.every((x) => x.resolved.level === 1 || x.resolved.level === 2));
  const garbage = build([Object.assign({}, base, { sigma: NaN, ens_pred: 'x' }), r2]);
  chk('chaos: a garbage row is UNAVAILABLE (level 4 without V1) and the other game is untouched', g(garbage, base.game_id).resolved.level === 4 && g(garbage, r2.game_id).resolved.level <= 2
    && g(garbage, base.game_id).official_decision.status === 'UNAVAILABLE');
  const dup = build([base, Object.assign({}, base, { ens_pred: base.ens_pred + 3, components: { C_ridge: base.ens_pred + 3, D_gbm: base.ens_pred + 3 } }), r2]);
  chk('chaos: two different rows for one game use neither (never a silent pick)', g(dup, base.game_id).canonical === null && g(dup, base.game_id).duplicate_rows === true && g(dup, base.game_id).resolved.level === 4);
  chk('chaos: an identical duplicate row is harmless', build([base, base, r2]).games.filter((x) => x.game_id === String(base.game_id)).length === 1 && g(build([base, base, r2]), base.game_id).resolved.level <= 2);
  const swapped = build([Object.assign({}, base, { away_id: base.home_id }), r2]);
  chk('chaos: home = away is refused at the source', g(swapped, base.game_id).canonical.status === 'UNAVAILABLE');
  const empty = PR.build({ now, files: { 'football/cfb_v2/current.json': null, 'football/fbs/slate.json': null, 'football/cfb_production/manifest.json': {} }, predictions: [], decisions: [] });
  chk('chaos: no current.json and no slate is an empty report, never a crash or an invented game', empty.games.length === 0);
  const late = PR.build({ now: new Date(kick + 3600000).toISOString(), files: { 'football/cfb_v2/current.json': { rows: [base] }, 'football/fbs/slate.json': { games: [] }, 'football/cfb_production/manifest.json': {} }, predictions: [], decisions: [] });
  chk('chaos: a game that has kicked off is never offered as a pregame projection', late.games.length === 0);
  const stageBet = PR.officialDecision([{ engine_role: 'CURRENT', engine_version: 'cfb_decision_baseline_001', status: 'BET', observed_at: now }], Date.parse(now));
  chk('chaos: a stage-8 BET row in the decision ledger is never the official decision', stageBet.status === 'NO_DECISION');
  const future = PR.officialDecision([{ engine_role: 'CHALLENGER', engine_version: 'cfb_decision_engine_v1', policy_version: 'cfb_decision_policy_v1', status: 'LEAN', observed_at: new Date(kick).toISOString() }], Date.parse(now));
  chk('chaos: a decision observed after as_of is not visible at as_of (point in time)', future.status === 'NO_DECISION');
}

/* ======================================================= 9 immutable snapshots (Model Lab) */
{
  const M = require(path.join(ROOT, 'football', 'cfb_lab', 'models.js'));
  const CP = require(path.join(ROOT, 'football', 'cfb_lab', 'checkpoint.js'));
  const LG = require(path.join(ROOT, 'football', 'cfb_lab', 'ledger.js'));
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-canon-'));
  const so = { root: path.join(d, 'ledger'), govRoot: path.join(d, 'gov') };
  const kick = Date.parse(base.kickoff);
  const at = (h) => new Date(kick - h * 3600000).toISOString();
  const models = (row) => [M.v2Adapter('current', { current: { rows: [row], generated_at: at(40), model_version: 'edgedesk_cfb_v2.1.0' }, slate: { games: [] }, currentHash: 'test' })];
  try {
    const r1 = CP.run({ now: at(40), season: 2026, models: models(base), storeOpts: so, schedule: {} });
    const store = new LG.Store(2026, so);
    const first = store.predictions();
    chk('lab: the T48 snapshot carries the canonical verdict (contract, modes, fallback level, input hash)', r1.taken === 1 && first[0].inputs_ref.canonical
      && first[0].inputs_ref.canonical.contract_ok === true && first[0].inputs_ref.canonical.input_hash === CANON.inputHash(base) && [1, 2].includes(first[0].inputs_ref.canonical.fallback_level), first[0] && first[0].inputs_ref);
    chk('lab: a snapshot without a captured market is marked MARKET_DEGRADED', first[0].inputs_ref.canonical.degraded_modes.includes('MARKET_DEGRADED'));
    const same = CP.run({ now: at(39), season: 2026, models: models(base), storeOpts: so, schedule: {} });
    chk('lab: an unchanged input between windows writes nothing', same.taken === 0);
    const moved = Object.assign({}, base, { ens_pred: base.ens_pred + 2, components: { C_ridge: base.ens_pred + 2, D_gbm: base.ens_pred + 2 } });
    const r2 = CP.run({ now: at(38), season: 2026, models: models(moved), storeOpts: so, schedule: {} });
    const rows = store.predictions();
    const ad = rows.find((x) => x.checkpoint_type === 'ADHOC');
    chk('lab: a changed input inside 72 h is an event-triggered ADHOC version naming the row it supersedes', r2.taken === 1 && r2.event_adhoc === 1 && ad
      && ad.inputs_ref.event.kind === 'INPUT_CHANGED' && ad.inputs_ref.event.supersedes === first[0].prediction_id && ad.official_families.length === 0, r2);
    chk('lab: the earlier snapshot is kept byte for byte (corrections never overwrite)', JSON.stringify(rows.find((x) => x.prediction_id === first[0].prediction_id)) === JSON.stringify(first[0]));
    const r3 = CP.run({ now: at(37), season: 2026, models: models(moved), storeOpts: so, schedule: {} });
    chk('lab: the same changed input again adds nothing (idempotent)', r3.taken === 0);
    chk('lab: the ledger still verifies (ids, hashes, one row per window)', LG.verify({ roots: [so.root, so.govRoot], base: null }).length === 0, LG.verify({ roots: [so.root, so.govRoot], base: null }).slice(0, 3));
    const bad = Object.assign({}, base, { sigma: null });
    const r4 = CP.run({ now: at(20), season: 2026, models: models(bad), storeOpts: so, schedule: {} });
    chk('lab: a row the canonical service refuses is never snapshotted (no T24 from a broken row)', r4.taken === 0 && !store.predictions().some((x) => x.checkpoint_type === 'T24'));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
}

/* ======================================================= 10 promotion guard */
{
  const roles = { 'edgedesk_cfb_p4_v1.0.0': { role: 'champion' }, 'edgedesk_cfb_v2.1.0': { role: 'challenger' }, 'edgedesk_cfb_v2.0.0': { role: 'candidate' } };
  const eligibleLab = { comparison: { promotion: { evaluations: [{ challenger: 'edgedesk_cfb_v2.1.0', decision: 'ELIGIBLE', ready: true, n: 180, min_n: 150 }] } } };
  const okTests = { ok: true, detail: 'PASS' };
  const g = (m, o) => PG.guard(m, Object.assign({ roles, tests: okTests, lab: eligibleLab }, o || {}));
  chk('promotion: V2.1 with passing tests and an ELIGIBLE shadow passes every check', g('edgedesk_cfb_v2.1.0').ok, g('edgedesk_cfb_v2.1.0').checks.filter((c) => !c.ok));
  chk('promotion: "latest" (no explicit version) is refused', !g('latest').ok && !g('latest').checks[0].ok);
  chk('promotion: an incomplete shadow (INSUFFICIENT_SAMPLE) is refused', !g('edgedesk_cfb_v2.1.0', { lab: { comparison: { promotion: { evaluations: [{ challenger: 'edgedesk_cfb_v2.1.0', decision: 'INSUFFICIENT_SAMPLE', ready: false, n: 0, min_n: 150 }] } } } }).ok);
  chk('promotion: failing tests are refused', !g('edgedesk_cfb_v2.1.0', { tests: { ok: false, detail: 'FAILED tests.js' } }).ok);
  chk('promotion: an incompatible model (candidate 001) is refused', !g('edgedesk_cfb_v2.0.0').ok && !g('edgedesk_cfb_v2.0.0').checks.find((c) => c.n === 3).ok);
  const tam = JSON.parse(JSON.stringify(COMPAT.loadMatrix())); tam.entries[0].params_sha256 = '0'.repeat(64);
  chk('promotion: a calibration / params mismatch against the pinned tuple is refused', !g('edgedesk_cfb_v2.1.0', { matrix: tam }).ok);
  chk('promotion: the current champion cannot be promoted again', !g('edgedesk_cfb_p4_v1.0.0', { rollback: true }).ok);
  const r2 = { 'edgedesk_cfb_p4_v1.0.0': { role: 'challenger' }, 'edgedesk_cfb_v2.1.0': { role: 'champion' } };
  chk('promotion: the documented rollback to V1 needs --rollback and then needs no shadow evaluation', !PG.guard('edgedesk_cfb_p4_v1.0.0', { roles: r2, tests: okTests, lab: {} }).ok
    && PG.guard('edgedesk_cfb_p4_v1.0.0', { roles: r2, tests: okTests, lab: {}, rollback: true }).ok);
  chk('promotion: V2.1 today is refused only for its live sample (INSUFFICIENT_SAMPLE)', (() => { const x = PG.guard('edgedesk_cfb_v2.1.0', { roles, tests: okTests });
    return !x.ok && x.checks.filter((c) => !c.ok).map((c) => c.n).join() === '7'; })());
  const GOV = require(path.join(ROOT, 'football', 'cfb_lab', 'governance.js'));
  const LG = require(path.join(ROOT, 'football', 'cfb_lab', 'ledger.js'));
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-promo-'));
  try {
    const st = new LG.Store(2026, { root: path.join(d, 'l'), govRoot: path.join(d, 'g') });
    GOV.seed(st);
    const refusedGuard = g('edgedesk_cfb_v2.1.0', { tests: { ok: false } });
    chk('promotion: governance.promote refuses when the guard refused', throws(() => GOV.promote(st, 'edgedesk_cfb_v2.1.0', 'r', 'a', { guard: refusedGuard })));
    chk('promotion: governance.promote refuses a guard run for another model', throws(() => GOV.promote(st, 'edgedesk_cfb_v2.1.0', 'r', 'a', { guard: Object.assign({}, g('edgedesk_cfb_v2.1.0'), { model: 'edgedesk_cfb_v2.0.0' }) })));
    const res = GOV.promote(st, 'edgedesk_cfb_v2.1.0', 'test', 'tester', { guard: g('edgedesk_cfb_v2.1.0'), at: '2026-12-01T00:00:00Z' });
    chk('promotion: a guarded promotion records the guard in its audit event', res.audit.some((x) => x.event_type === 'MODEL_PROMOTED' && x.after.guard && x.after.guard.ok === true));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
  chk('promotion: the CLI always runs the guard', /PG\.guard\(arg\('--model'\)/.test(read('football/cfb_lab/governance.js')) && /guard \}\)/.test(read('football/cfb_lab/governance.js')));
}

/* ======================================================= 11 audit fixes */
{
  const M = require(path.join(ROOT, 'football', 'cfb_lab', 'models.js'));
  const v21 = M.ensembleVersion('edgedesk_cfb_v2.1.0', path.join(ROOT, 'football', 'cfb_v2', 'artifacts', 'edgedesk_cfb_v2.1.0', 'models.json'));
  const v20 = M.ensembleVersion('edgedesk_cfb_v2.0.0', path.join(ROOT, 'football', 'cfb_v2', 'candidates', 'cfb_v2_candidate_001', 'artifacts', 'models.json'));
  chk('ensemble_version: V2.0 and V2.1 record different ensembles, neither the hash of {}', v21 && v20 && v21.split(':')[1] !== v20.split(':')[1] && !/44136fa355b3/.test(v21 + v20), [v21, v20]);
  chk('ensemble_version: stable (same value twice) and equal to the manifest\'s', v21 === M.ensembleVersion('edgedesk_cfb_v2.1.0', path.join(ROOT, 'football', 'cfb_v2', 'artifacts', 'edgedesk_cfb_v2.1.0', 'models.json'))
    && v21 === JSON.parse(read('football/cfb_production/manifest.json')).ensemble_version);
  chk('ensemble_version: the adapters record it on every projection', [...M.v2Adapter('current').projections.values()].every((p) => p.ensemble_version === v21)
    && [...M.v2Adapter('candidate_001').projections.values()].every((p) => p.ensemble_version === v20));
  chk('ensemble_version: an artifact that cannot be read records null, never a guess', M.ensembleVersion('edgedesk_cfb_v9.9.9', '/nonexistent/models.json') === null);
  /* the pinned decision policy loader */
  const td = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-pin-'));
  try {
    const put = (dir, file, body) => { fs.mkdirSync(path.join(td, dir), { recursive: true }); fs.writeFileSync(path.join(td, dir, file), body); };
    put('cfb_decision_policy_v10', 'policy.json', JSON.stringify({ version: 'cfb_decision_policy_v10', calibration_artifact: 'cfb_decision_calibration_v1' }));
    put('cfb_decision_policy_v2', 'policy.json', JSON.stringify({ version: 'cfb_decision_policy_v2', calibration_artifact: 'cfb_decision_calibration_v1' }));
    put('cfb_decision_calibration_v1', 'calibration.json', '{"version":"cfb_decision_calibration_v1"}');
    put('cfb_decision_calibration_v1', 'MANIFEST.json', JSON.stringify({ files: { 'calibration.json': COMPAT.sha('{"version":"cfb_decision_calibration_v1"}') } }));
    const matrix = { entries: [{ model_version: 'mX', role: 'PRODUCTION_PATHWAY', status: 'COMPATIBLE', decision_policy_version: 'cfb_decision_policy_v10',
      decision_policy_sha256: COMPAT.shaFile(path.join(td, 'cfb_decision_policy_v10', 'policy.json')), decision_calibration_version: 'cfb_decision_calibration_v1',
      decision_calibration_manifest_sha256: COMPAT.shaFile(path.join(td, 'cfb_decision_calibration_v1', 'MANIFEST.json')) }] };
    const la = COMPAT.decisionArtifacts({ artDir: td, matrix, model_version: 'mX' });
    chk('pinned policy: the loader reads the pinned v10, not the lexically newest v2', COMPAT.newestDir(td, 'cfb_decision_policy_', 'policy.json') === 'cfb_decision_policy_v2'
      && la.policy_dir === 'cfb_decision_policy_v10' && la.policy.version === 'cfb_decision_policy_v10' && la.calibration_dir === 'cfb_decision_calibration_v1', la.problems);
    fs.writeFileSync(path.join(td, 'cfb_decision_policy_v10', 'policy.json'), JSON.stringify({ version: 'cfb_decision_policy_v10', calibration_artifact: 'cfb_decision_calibration_v1', bet_enabled: true }));
    const ch = COMPAT.decisionArtifacts({ artDir: td, matrix, model_version: 'mX' });
    chk('pinned policy: changed content loads as null (fail closed)', ch.policy === null && /differs/.test(ch.problems.join()));
    fs.rmSync(path.join(td, 'cfb_decision_policy_v10'), { recursive: true });
    chk('pinned policy: a missing pinned directory loads as null (fail closed), even with v2 present', COMPAT.decisionArtifacts({ artDir: td, matrix, model_version: 'mX' }).policy === null);
    chk('pinned policy: no COMPATIBLE entry loads nothing', COMPAT.decisionArtifacts({ artDir: td, matrix: { entries: [] }, model_version: 'mX' }).policy === null);
  } finally { fs.rmSync(td, { recursive: true, force: true }); }
  const real = COMPAT.decisionArtifacts();
  chk('pinned policy: the repository loads cfb_decision_policy_v1 and cfb_decision_calibration_v1', real.policy_dir === 'cfb_decision_policy_v1' && real.calibration_dir === 'cfb_decision_calibration_v1' && !real.problems.length, real.problems);
  chk('pinned policy: the decision shadow loads through the pinned loader, never "newest"', /COMPAT\.decisionArtifacts\(\)/.test(read('football/cfb_decision/shadow.js')) && !/function newest\(/.test(read('football/cfb_decision/shadow.js')));
  const f = COMPAT.facts();
  chk('pinned policy: the gate\'s fact is the loaded (pinned) directory; the newest directory is recorded, not loaded', f.decision_policy.dir === 'cfb_decision_policy_v1' && 'decision_policy_newest_dir' in f);
}

/* ======================================================= 12 reproducibility */
{
  const cfg = JSON.parse(read('football/cfb_lab/config.json'));
  const s = RP.snapshots(cfg.season, { depth: 50 });
  chk('reproduce: every preserved LIVE snapshot whose input file is reachable re-runs to the stored numbers (' + s.reproduced + ' of ' + s.checked + ', ' + s.no_source + ' without a source)',
    s.checked > 0 && s.mismatched.length === 0, s.mismatched.slice(0, 3));
  const t = RP.settlement(cfg.season);
  chk('reproduce: every committed evaluation re-grades identically from the committed ledger (' + t.reproduced + ' of ' + t.stored + ')', t.stored > 0 && t.mismatched.length === 0 && t.missing.length === 0, [t.mismatched.slice(0, 3), t.missing.slice(0, 3)]);
}

failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 500) : '')));
console.log((fail ? 'FAILED ' : 'ALL GREEN ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
