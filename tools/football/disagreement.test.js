#!/usr/bin/env node
/* ===========================================================================
   THE MAJOR-DISAGREEMENT INTEGRITY GATE, held to its rules.

   lib/cfb_disagreement.js decides whether a 7+ point gap between EdgeDesk and
   the market is a VERIFIED MAJOR DISAGREEMENT or something to INVESTIGATE.
   This suite proves, on constructed games whose every input is known:

     - the raw gap, its sign, the favourite on each side and the market
       convention;
     - the component decomposition reconciles to the published margin;
     - every check (game, market, team state, QB, roster, components,
       calibration, cross-model) and its tier: 7+, 10+, 15+ and the stricter
       favourite-flip gate;
     - FAIL CLOSED: an input that cannot be checked is never a pass, and a
       gate that throws returns INVESTIGATE — VERIFICATION INCOMPLETE;
     - the pure fair spread is never touched: the engine prices the same game
       identically with and without a market, and the football-only
       calibrator is published as a shadow;
     - the slate circuit breaker, the market-movement recheck and the
       false-extreme definition;
     - the wiring: the research view's label, the Model Lab checkpoint's
       verdict fields and the lab's graded section.

   Run: node tools/football/disagreement.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
global.window = global.window || global;
require(path.join(ROOT, 'football', 'cfb_p4', 'params.js'));
const E = require(path.join(ROOT, 'football', 'cfb_p4', 'engine.js'));
const D = require(path.join(ROOT, 'lib', 'cfb_disagreement.js'));
const V = require(path.join(ROOT, 'lib', 'cfb_research_view.js'));
const CP = require(path.join(ROOT, 'football', 'cfb_lab', 'checkpoint.js'));
const LABD = require(path.join(ROOT, 'football', 'cfb_lab', 'disagreement.js'));
const MC = require(path.join(ROOT, 'football', 'cfb_p4', 'margin_calibration.js'));

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (typeof ok === 'function') { try { ok = !!ok(); } catch (e) { detail = String(e && e.stack || e); ok = false; } }
  if (ok) { pass++; return; }
  fail++; console.error('FAIL | ' + name + (detail === undefined ? '' : ' | ' + JSON.stringify(detail).slice(0, 600)));
}
function eq(name, a, b) { chk(name, a === b, { got: a, wanted: b }); }
function near(name, a, b, tol) { chk(name, typeof a === 'number' && Math.abs(a - b) <= (tol || 1e-6), { got: a, wanted: b }); }
function section(t) { console.log('\n' + t); }

const NOW = Date.parse('2026-10-01T12:00:00Z');
const KICK = '2026-10-03T19:30:00Z';
/* ONE GAME THAT PASSES EVERYTHING at the 7+ tier: a 9-point gap toward the
   home side, built from a base rating that already disagrees, on current
   ratings, a fresh multi-book market, resolved quarterbacks, normal
   availability, and independent submodels that agree. Every test below
   breaks exactly one thing. */
function base(o) {
  o = o || {};
  const fair = o.fair != null ? o.fair : 14;
  const hfa = o.hfa != null ? o.hfa : 4.082;
  const matchup = o.matchup != null ? o.matchup : 0.8;
  const conference = o.conference != null ? o.conference : 0;
  const rating = fair - hfa - matchup - conference;
  const line = o.line != null ? o.line : 5;
  const x = {
    now_ms: NOW,
    game: { game_id: 'g1', home: 'Iowa State', away: 'West Virginia', kickoff: KICK, neutral_site: false, venue: 'Jack Trice Stadium', home_fbs: true, away_fbs: true },
    mapping: { teams_resolved: true },
    projection: { status: 'PREDICTED', fair, sigma: 14.9, home_win_prob: 0.75, confidence: 72,
      components: { rating, hfa, qb: 0, matchup, travel: 0, schedule: 0, injury: 0, rivalry: 0, conference },
      rating_detail: { home_carried: 10, home_fresh: 11, away_carried: 10 - rating, away_fresh: 11 - rating, prior_weight: 0.6, home_gp: 5, away_gp: 5 },
      season: 2026, week: 6 },
    market: { spread: line, books: 4, range: 1, as_of: '2026-10-01T10:00:00Z', stale: false, home_team: 'Iowa State', away_team: 'West Virginia', kickoff: KICK },
    submodels: { source: 'test', projections: { ridge: line + 7, gbm: line + 6, drive: line + 5 }, ensemble: line + 6, ensemble_sd: 1 },
    qb: { home: { status: 'PREVIOUS_GAME', player: 'A', availability: 'UNKNOWN' }, away: { status: 'ANNOUNCED', player: 'B', availability: 'AVAILABLE' } },
    roster: { home: { feed_state: 'NOT_DUE_YET' }, away: { feed_state: 'REPORTED' } },
    reliability: 82,
    long_term_vs_current_delta: 0
  };
  return x;
}
function mut(o, f) { const x = base(o); f(x); return x; }
function ev(x) { return D.evaluate(x); }
function failed(r, id) { return (r.checks || []).some(c => (c.group + '.' + c.id) === id && c.status === 'FAIL'); }

/* ======================================================================== */
section('1 · the raw gap, its sign, the favourites, the market convention');
{
  const r = ev(base());
  near('raw_market_gap = pure fair margin - market margin', r.raw_market_gap, 9);
  eq('positive gap means EdgeDesk likes the HOME side more', r.direction, 'home');
  eq('and it names the team', r.toward_team, 'Iowa State');
  eq('EdgeDesk favourite', r.edgedesk_favorite, 'Iowa State');
  eq('market favourite (margin + = home favoured)', r.market_favorite, 'Iowa State');
  eq('no favourite flip here', r.favorite_flip, false);
  const a = ev(base({ fair: -3, line: 6, hfa: 4.082, matchup: -0.5 }));
  near('toward the away side is negative', a.raw_market_gap, -9);
  eq('and names the away team', a.toward_team, 'West Virginia');
  eq('a flip: EdgeDesk favours the road team, the market the home team', a.favorite_flip, true);
  eq('the tier of a 9-point gap', r.tier, 'MAJOR_7');
  eq('under 2 points is MARKET ALIGNED', ev(base({ fair: 6, line: 5 })).status, 'MARKET_ALIGNED');
  eq('2 to 7 is WORTH RESEARCHING', ev(base({ fair: 8, line: 5 })).status, 'WORTH_RESEARCHING');
  eq('6.99 is not a major gap', ev(base({ fair: 11.99, line: 5 })).tier, 'RESEARCH');
  eq('7.00 is', ev(base({ fair: 12, line: 5 })).tier, 'MAJOR_7');
  eq('10 is the next tier', ev(base({ fair: 15, line: 5 })).tier, 'MAJOR_10');
  eq('15 is the last', ev(base({ fair: 20, line: 5 })).tier, 'MAJOR_15');
}

/* ======================================================================== */
section('2 · the decomposition is the engine’s own equation');
{
  const r = ev(base());
  chk('the terms reconcile to the raw margin', r.decomposition.reconciles === true, r.decomposition);
  near('base rating gap = rating + home field - market', r.decomposition.base_rating_gap, (14 - 4.082 - 0.8) + 4.082 - 5, 1e-2);
  near('adjustments gap = fair - rating - home field', r.decomposition.adjustments_gap, 0.8, 1e-2);
  near('long-term state + current form = the rating term', r.decomposition.long_term_state + r.decomposition.current_form, r.decomposition.neutral_strength, 0.02);
  chk('the explanation names every source with its side', r.explanation.sources.some(s => /Base team strength: \+\d/.test(s.text) && /Iowa State/.test(s.text)), r.explanation.sources);
  chk('and states the equation', /raw game margin 14\.00 = the sum/.test(r.explanation.equation), r.explanation.equation);
  const bad = mut({}, x => { x.projection.fair = 20; });
  chk('a margin its terms do not sum to is flagged', ev(bad).decomposition.reconciles === false);
}

/* ======================================================================== */
section('3 · the gate: a clean 7+ gap is VERIFIED, and only then');
{
  const r = ev(base());
  eq('a game that passes every check is VERIFIED', r.status, 'VERIFIED_MAJOR_DISAGREEMENT', r.failed);
  chk('with no failed and no incomplete check', r.failed.length === 0 && r.incomplete.length === 0, { f: r.failed, i: r.incomplete });
  near('verified_market_gap is the raw gap', r.verified_market_gap, r.raw_market_gap);
  eq('root cause VALID_MODEL_DISAGREEMENT', r.root_cause.primary, 'VALID_MODEL_DISAGREEMENT');
  chk('and it says it is not a bet', /not a bet/i.test(r.not_a_bet));
  eq('the strongest tone is reserved for it', r.tone, 'verified');
  ['GAME', 'MARKET', 'TEAM_STATE', 'QB', 'ROSTER', 'COMPONENT', 'MODEL'].forEach(g => eq('group ' + g + ' passes', r.groups[g], 'PASS'));
  const i = ev(mut({}, x => { x.projection.rating_detail.away_gp = 1; }));
  eq('break one thing and it is INVESTIGATE', i.status, 'INVESTIGATE');
  eq('with no verified gap', i.verified_market_gap, null);
}

/* ======================================================================== */
section('4 · GAME CHECK: teams, venue, orientation, kickoff');
{
  const sw = ev(mut({}, x => { x.market.home_team = 'West Virginia'; x.market.away_team = 'Iowa State'; }));
  eq('home/away swapped on the quote is a DATA FAULT', sw.status, 'DATA_FAULT');
  eq('named HOME_AWAY_ERROR', sw.root_cause.primary, 'HOME_AWAY_ERROR');
  const or = ev(mut({}, x => { x.market.fault = true; }));
  eq('an orientation fault is a DATA FAULT', or.status, 'DATA_FAULT');
  const kk = ev(mut({}, x => { x.market.kickoff = '2026-10-10T19:30:00Z'; }));
  eq('a quote for a kickoff a week away is another game: DATA FAULT', kk.status, 'DATA_FAULT');
  eq('named MARKET_JOIN_ERROR', kk.root_cause.primary, 'MARKET_JOIN_ERROR');
  const st = ev(mut({}, x => { x.now_ms = Date.parse(KICK) + 60000; }));
  eq('a game that has kicked off cannot be verified', st.verified, false);
  const vn = ev(mut({}, x => { x.game.neutral_site = null; }));
  eq('an unknown venue flag is incomplete, not a pass', vn.status, 'INVESTIGATE');
  chk('and says verification is incomplete', /INCOMPLETE/.test(vn.status_label), vn.status_label);
  const mp = ev(mut({}, x => { x.mapping = { teams_resolved: false, warnings: ['alias ambiguous'] }; }));
  eq('a failed identity join is a DATA FAULT (GAME_MAPPING_ERROR)', mp.root_cause.primary, 'GAME_MAPPING_ERROR');
}

/* ======================================================================== */
section('5 · MARKET CHECK: books, freshness, dispersion, validity');
{
  const one = ev(mut({}, x => { x.market.books = 1; x.market.range = null; }));
  eq('one book at 7+ is a MARKET FAULT', one.status, 'MARKET_FAULT');
  eq('named THIN_MARKET', one.root_cause.primary, 'THIN_MARKET');
  const stale = ev(mut({}, x => { x.market.stale = true; }));
  eq('a stale quote is a MARKET FAULT', stale.status, 'MARKET_FAULT');
  eq('named STALE_MARKET', stale.root_cause.primary, 'STALE_MARKET');
  const old = ev(mut({}, x => { x.market.as_of = '2026-09-29T00:00:00Z'; }));
  eq('a quote 60 hours old is a MARKET FAULT at 7+', old.status, 'MARKET_FAULT');
  const noTs = ev(mut({}, x => { delete x.market.as_of; }));
  eq('a quote with no capture time cannot be judged fresh: INVESTIGATE, incomplete', noTs.status, 'INVESTIGATE');
  const disp = ev(mut({}, x => { x.market.range = 6; }));
  eq('books 6 points apart: an outlier drives the consensus (MARKET FAULT)', disp.status, 'MARKET_FAULT');
  const silly = ev(mut({}, x => { x.market.spread = -334; }));
  chk('a -334 spread is not a plausible line', failed(silly, 'MARKET.consensus_valid'));
  const noBooks = ev(mut({}, x => { delete x.market.books; }));
  eq('an unreported book count is incomplete, never a pass', noBooks.status, 'INVESTIGATE');
  const noMkt = ev(mut({}, x => { x.market = { spread: null }; }));
  eq('no market: no gap, no verdict', noMkt.available, false);
}

/* ======================================================================== */
section('6 · TEAM STATE: current sample, stability, convergence, FCS');
{
  const early = ev(mut({}, x => { x.projection.rating_detail.home_gp = 2; }));
  eq('two current-season games at 7+ is INVESTIGATE', early.status, 'INVESTIGATE');
  eq('named EARLY_SEASON_PRIOR_ERROR', early.root_cause.primary, 'EARLY_SEASON_PRIOR_ERROR');
  eq('three is enough at 7+', ev(mut({}, x => { x.projection.rating_detail.home_gp = 3; })).status, 'VERIFIED_MAJOR_DISAGREEMENT');
  const noGp = ev(mut({}, x => { x.projection.rating_detail.home_gp = null; }));
  eq('games played unreported is incomplete', noGp.status, 'INVESTIGATE');
  const conv = ev(mut({}, x => { x.state = { converged: false }; }));
  eq('an opponent adjustment that did not converge fails', conv.root_cause.primary, 'OPPONENT_ADJUSTMENT_ERROR');
  const wrongSeason = ev(mut({}, x => { x.state = { season: 2025 }; }));
  eq('a rating state from another season fails', wrongSeason.status, 'INVESTIGATE');
  const stale = ev(mut({}, x => { x.state = { fresh: false }; }));
  eq('a rating state that missed the latest games fails', stale.root_cause.primary, 'TEAM_RATING_ERROR');
  const fcs10 = ev(mut({ fair: 16, line: 5 }, x => { x.game.away_fbs = false; x.projection.rating_detail.home_gp = 4; x.projection.rating_detail.away_gp = 4;
    x.submodels = { projections: { a: 16, b: 15, c: 14 }, ensemble: 15, ensemble_sd: 1 }; }));
  eq('an FCS opponent at 10+ fails (FCS_TRANSLATION_ERROR)', fcs10.root_cause.primary, 'FCS_TRANSLATION_ERROR');
  const ltd = ev(mut({ fair: 16, line: 5 }, x => { x.long_term_vs_current_delta = 14; x.projection.rating_detail.home_gp = 4; x.projection.rating_detail.away_gp = 4;
    x.submodels = { projections: { a: 16, b: 15, c: 14 }, ensemble: 15, ensemble_sd: 1 }; }));
  chk('long-term state 14 pts from current form fails at 10+', failed(ltd, 'TEAM_STATE.state_stability'));
}

/* ======================================================================== */
section('7 · QB CHECK: resolved, uncertain, absent, changed');
{
  const comp7 = ev(mut({}, x => { x.qb.home.status = 'COMPETITION'; }));
  eq('a contested starter at 7+ is a warning, not a failure', comp7.status, 'VERIFIED_MAJOR_DISAGREEMENT');
  const comp10 = ev(mut({ fair: 16, line: 5 }, x => { x.qb.home.status = 'COMPETITION'; x.projection.rating_detail.home_gp = 4; x.projection.rating_detail.away_gp = 4;
    x.submodels = { projections: { a: 16, b: 15, c: 14 }, ensemble: 15, ensemble_sd: 1 }; }));
  eq('at 10+ it must be resolved: INVESTIGATE (QB_STATUS_ERROR)', comp10.root_cause.primary, 'QB_STATUS_ERROR');
  const out = ev(mut({}, x => { x.qb.away.availability = 'OUT'; }));
  eq('a starter ruled OUT that the number does not price fails', out.root_cause.primary, 'QB_STATUS_ERROR');
  const outPriced = ev(mut({}, x => { x.qb.away.availability = 'OUT'; x.projection.components.injury = 1.5; x.projection.components.rating -= 1.5; }));
  chk('priced through the absence term it is a warning only', !failed(outPriced, 'QB.away_availability'), outPriced.checks.filter(c => c.group === 'QB'));
  const change = ev(mut({}, x => { x.qb.home = { status: 'ANNOUNCED', player: 'Backup', change: true, recent_starts: 0 }; }));
  eq('a new starter the rating has never seen, unpriced, fails', change.root_cause.primary, 'QB_STATUS_ERROR');
  const reflected = ev(mut({}, x => { x.qb.home = { status: 'PREVIOUS_GAME', player: 'Backup', change: true, recent_starts: 3 }; }));
  eq('a backup who has started the last three is already in the rating: no double count', reflected.status, 'VERIFIED_MAJOR_DISAGREEMENT');
  const noQb = ev(mut({}, x => { x.qb = null; }));
  eq('no starter context is incomplete, never a pass', noQb.status, 'INVESTIGATE');
  chk('and verification says so', /INCOMPLETE/.test(noQb.status_label));
}

/* ======================================================================== */
section('8 · ROSTER CHECK: abnormal missing data, double counts');
{
  eq('a failed availability feed fails', ev(mut({}, x => { x.roster.home.feed_state = 'FETCH_FAILED'; })).root_cause.primary, 'PLAYER_AVAILABILITY_ERROR');
  eq('a report not yet due is normal', ev(mut({}, x => { x.roster.home.feed_state = 'NOT_DUE_YET'; })).status, 'VERIFIED_MAJOR_DISAGREEMENT');
  eq('an absence priced twice fails', ev(mut({}, x => { x.roster.away.double_count = true; })).root_cause.primary, 'ROSTER_DOUBLE_COUNT');
  const missing = ev(mut({}, x => { x.roster = null; }));
  eq('no availability state is incomplete', missing.status, 'INVESTIGATE');
}

/* ======================================================================== */
section('9 · COMPONENT CHECK: validated ranges and the large single component');
{
  const P = D.params();
  const conf = ev(mut({ conference: 4, fair: 14 }, () => {}));
  chk('a conference term that alone lifts the gap over 7 fails', failed(conf, 'COMPONENT.conference_dominance'), conf.checks.filter(c => c.group === 'COMPONENT'));
  eq('named CROSS_CONFERENCE_SCALE_ERROR', conf.root_cause.primary, 'CROSS_CONFERENCE_SCALE_ERROR');
  const mu = ev(mut({ matchup: 3, fair: 14 }, () => {}));
  chk('a matchup term that alone lifts it is flagged but, being historically informative, does not fail',
    !failed(mu, 'COMPONENT.matchup_dominance') && mu.checks.some(c => c.id === 'matchup_dominance' && c.status === 'WARN'));
  const small = ev(mut({ matchup: 0.8, fair: 12.5, line: 5 }, () => {}));
  chk('a half-point term nudging the gap over a line is not a large component', !small.checks.some(c => c.id === 'matchup_dominance'));
  const big = ev(mut({ matchup: (P.components.pct.matchup.p99 || 4.6) + 1, fair: 16, line: 5 }, x => {
    x.projection.rating_detail.home_gp = 4; x.projection.rating_detail.away_gp = 4; x.submodels = { projections: { a: 16, b: 15, c: 14 }, ensemble: 15, ensemble_sd: 1 }; }));
  chk('a matchup term past its validated p99 fails', failed(big, 'COMPONENT.matchup_range'), big.checks.filter(c => c.group === 'COMPONENT'));
  chk('home field is never judged as a dominant component (the market prices it too)', !ev(base({ fair: 12.5, line: 5 })).checks.some(c => c.id === 'hfa_dominance'));
}

/* ======================================================================== */
section('10 · CALIBRATION: football-only, zero-preserving, shadow');
{
  const P = D.params();
  eq('the generated calibrator is loaded', P.calibration.version, MC.version);
  near('the calibrator matches its generated record', P.calibration.slope, MC.slope);
  eq('and it is NOT promoted to the priced number', MC.promoted, false);
  const cm = D.calibratedMargin({ fair: 0, components: { hfa: 0 } }, true, P);
  eq('a neutral-site pick’em stays exactly 0', cm, 0);
  const a = D.calibratedMargin({ fair: 10, components: { hfa: 0 } }, true, P), b = D.calibratedMargin({ fair: -10, components: { hfa: 0 } }, true, P);
  near('swapping the teams at a neutral site negates it', a, -b);
  near('slope x (raw - applied home field) + fitted home field', D.calibratedMargin({ fair: 14, components: { hfa: 4.082 } }, false, P), P.calibration.slope * (14 - 4.082) + P.calibration.hfa);
  const hfaOnly = ev(base({ fair: 12.3, line: 5 }));
  eq('a home-favourite gap that exists only because of the over-sized home field fails calibration', hfaOnly.root_cause.primary, 'HFA_ERROR');
  chk('its calibrated gap is under 7', Math.abs(hfaOnly.calibrated.gap) < 7, hfaOnly.calibrated);
  const road = ev(base({ fair: -4, line: 5, matchup: -0.5 }));
  chk('the same correction widens a road-favourite gap rather than hiding it', Math.abs(road.calibrated.gap) > Math.abs(road.raw_market_gap), road.calibrated);
  const fx = ev(base({ fair: 20, line: 12.5 }));
  chk('the label claims only the tier the calibrated gap supports', !fx.verified || fx.verified_tier === 'MAJOR_7', { t: fx.verified_tier, g: fx.calibrated });
}

/* ======================================================================== */
section('11 · CROSS-MODEL: independent submodels, never the market');
{
  const opp = ev(mut({}, x => { x.submodels = { projections: { ridge: 4, gbm: 5, drive: 6 }, ensemble: 5, ensemble_sd: 1 }; }));
  eq('submodels sitting with the market: INVESTIGATE', opp.status, 'INVESTIGATE');
  eq('named TEAM_RATING_ERROR', opp.root_cause.primary, 'TEAM_RATING_ERROR');
  eq('the stance of each submodel is reported', opp.cross_model.projections.length, 3);
  const one = ev(mut({}, x => { x.submodels = { projections: { ridge: 14, gbm: 5.5, drive: 5 }, ensemble: 8, ensemble_sd: 5 }; }));
  eq('one model carrying the whole gap does not verify', one.status, 'INVESTIGATE');
  const none = ev(mut({}, x => { x.submodels = null; }));
  eq('no submodels: incomplete, never verified', none.status, 'INVESTIGATE');
  chk('and the label says VERIFICATION INCOMPLETE', /INCOMPLETE/.test(none.status_label));
  const wide10 = ev(mut({ fair: 16, line: 5 }, x => { x.projection.rating_detail.home_gp = 4; x.projection.rating_detail.away_gp = 4;
    x.submodels = { projections: { a: 16, b: 15, c: 14 }, ensemble: 15, ensemble_sd: 9 }; }));
  chk('at 10+ an ensemble that disagrees with itself (SD 9) fails', failed(wide10, 'MODEL.ensemble_disagreement'));
  const weak10 = ev(mut({ fair: 16, line: 5 }, x => { x.projection.rating_detail.home_gp = 4; x.projection.rating_detail.away_gp = 4;
    x.submodels = { projections: { a: 8, b: 7.5, c: 7.2 }, ensemble: 7.5, ensemble_sd: 1 }; }));
  chk('at 10+ the ensemble must itself be 3+ pts on EdgeDesk’s side', failed(weak10, 'MODEL.ensemble_direction'));
}

/* ======================================================================== */
section('12 · 10+, 15+ and favourite-flip gates are stricter');
{
  const g10 = mut({ fair: 16, line: 5 }, x => { x.projection.rating_detail.home_gp = 4; x.projection.rating_detail.away_gp = 4;
    x.submodels = { projections: { a: 16, b: 15, c: 14 }, ensemble: 15, ensemble_sd: 1 }; });
  const r10 = ev(g10);
  eq('a clean 11-point gap verifies at 10+', r10.status, 'VERIFIED_MAJOR_DISAGREEMENT', r10.failed);
  chk('flagged GATE_10', r10.flags.indexOf('GATE_10') >= 0);
  const three = ev(mut({ fair: 16, line: 5 }, x => { x.projection.rating_detail.home_gp = 3; x.projection.rating_detail.away_gp = 3;
    x.submodels = { projections: { a: 16, b: 15, c: 14 }, ensemble: 15, ensemble_sd: 1 }; }));
  eq('the same gap on 3 games per side fails at 10+ (4 required)', three.root_cause.primary, 'EARLY_SEASON_PRIOR_ERROR');
  const fresh10 = ev(mut({ fair: 16, line: 5 }, x => { x.projection.rating_detail.home_gp = 4; x.projection.rating_detail.away_gp = 4; x.market.as_of = '2026-09-30T20:00:00Z';
    x.submodels = { projections: { a: 16, b: 15, c: 14 }, ensemble: 15, ensemble_sd: 1 }; }));
  eq('a 16-hour-old quote is fine at 7+ but not at 10+ (12 h)', fresh10.status, 'MARKET_FAULT');
  const g15 = mut({ fair: 21, line: 5 }, x => { x.projection.rating_detail.home_gp = 5; x.projection.rating_detail.away_gp = 5;
    x.submodels = { projections: { a: 21, b: 20, c: 19 }, ensemble: 20, ensemble_sd: 1 }; });
  const r15 = ev(g15);
  eq('a clean 16-point gap on 4 books verifies', r15.status, 'VERIFIED_MAJOR_DISAGREEMENT', r15.failed);
  eq('and queues a manual review', r15.manual_review, true);
  chk('the label says it is extraordinary', /EXTRAORDINARY|MANUAL REVIEW/.test(r15.status_label), r15.status_label);
  const b15 = ev(mut({ fair: 21, line: 5 }, x => { x.market.books = 2; x.projection.rating_detail.home_gp = 5; x.projection.rating_detail.away_gp = 5;
    x.submodels = { projections: { a: 21, b: 20, c: 19 }, ensemble: 20, ensemble_sd: 1 }; }));
  eq('two books is not enough at 15+ (three)', b15.status, 'MARKET_FAULT');
  const flip = mut({ fair: -3, line: 5, matchup: -0.5 }, x => { x.projection.rating_detail.home_gp = 4; x.projection.rating_detail.away_gp = 4;
    x.submodels = { projections: { a: -4, b: -3, c: -2 }, ensemble: -3, ensemble_sd: 1 }; });
  const rf = ev(flip);
  eq('a clean 8-point favourite flip verifies under the stricter gate', rf.status, 'VERIFIED_MAJOR_DISAGREEMENT', rf.failed);
  chk('and is flagged FAVORITE_FLIP', rf.flags.indexOf('FAVORITE_FLIP') >= 0);
  const f3 = ev(mut({ fair: -3, line: 5, matchup: -0.5 }, x => { x.projection.rating_detail.home_gp = 3; x.projection.rating_detail.away_gp = 3;
    x.submodels = { projections: { a: -4, b: -3, c: -2 }, ensemble: -3, ensemble_sd: 1 }; }));
  eq('a flip on 3 games per side takes the 10+ sample rule and fails', f3.root_cause.primary, 'EARLY_SEASON_PRIOR_ERROR');
  const fe = ev(mut({ fair: -3, line: 5, matchup: -0.5 }, x => { x.projection.rating_detail.home_gp = 4; x.projection.rating_detail.away_gp = 4;
    x.submodels = { projections: { a: 1, b: 1.5, c: 2 }, ensemble: 1.5, ensemble_sd: 1 }; }));
  chk('a flip the independent ensemble does not share fails', failed(fe, 'MODEL.ensemble_favorite') || failed(fe, 'MODEL.ensemble_direction'));
  const guard = ev(mut({ fair: 29, line: 5 }, x => { x.projection.rating_detail.home_gp = 1; }));
  eq('past the 21-pt guard and unverified: DATA FAULT', guard.status, 'DATA_FAULT');
  const passGuard = ev(mut({ fair: 29, line: 5, matchup: 0.5 }, x => { x.projection.rating_detail.home_gp = 6; x.projection.rating_detail.away_gp = 6;
    x.submodels = { projections: { a: 29, b: 28, c: 27 }, ensemble: 28, ensemble_sd: 1 }; }));
  eq('past the guard and passing EVERY check it is shown, not hidden', passGuard.status, 'VERIFIED_MAJOR_DISAGREEMENT', passGuard.failed);
  chk('flagged PAST_GUARD with a manual review', passGuard.flags.indexOf('PAST_GUARD') >= 0 && passGuard.manual_review);
}

/* ======================================================================== */
section('13 · FAIL CLOSED');
{
  const throwing = base();
  Object.defineProperty(throwing, 'submodels', { get() { throw new Error('boom'); } });
  const r = D.evaluate(throwing);
  eq('a gate that throws returns INVESTIGATE', r.status, 'INVESTIGATE');
  eq('labelled VERIFICATION INCOMPLETE', r.status_label, 'INVESTIGATE — VERIFICATION INCOMPLETE');
  eq('never verified', r.verified, false);
  eq('with the raw gap still reported, not hidden', r.raw_market_gap, 9);
  eq('nothing is verified by default: empty input', D.evaluate({}).verified !== true, true);
  const hist = ev(mut({}, x => { x.historical = true; x.qb = null; x.roster = null; x.reliability = null; }));
  chk('the historical replay marks what it cannot know NOT_EVALUATED (and says so), never PASS',
    hist.checks.some(c => c.group === 'QB' && c.status === 'NOT_EVALUATED') && hist.checks.some(c => c.group === 'ROSTER' && c.status === 'NOT_EVALUATED'));
}

/* ======================================================================== */
section('14 · PURITY: the market never moves the football number');
{
  const st = E.newState();
  E.ingest.seasonBreak(st);
  [['Alabama', 'Vanderbilt', 42, 10], ['Georgia', 'Kentucky', 31, 17], ['Alabama', 'Georgia', 24, 27], ['Vanderbilt', 'Kentucky', 20, 23]].forEach(g =>
    E.ingest.absorbGame(st, { home: g[0], away: g[1], home_fbs: true, away_fbs: true, home_points: g[2], away_points: g[3] }));
  const req = m => ({ season: 2026, week: 5, state: st, game: { home: 'Alabama', away: 'Kentucky', home_fbs: true, away_fbs: true, neutral_site: false },
    teams: { home: { conference: 'SEC' }, away: { conference: 'SEC' } }, market: m });
  const p0 = E.projectGame(req({})), p1 = E.projectGame(req({ spread_line: -30 })), p2 = E.projectGame(req({ spread_line: 45, total_line: 70 }));
  eq('the fair spread is identical with no market, one line and another', p0.model.fair_spread === p1.model.fair_spread && p1.model.fair_spread === p2.model.fair_spread, true);
  eq('so is the win probability', p0.model.home_win_prob === p2.model.home_win_prob, true);
  eq('and the projected total', p0.model.fair_total === p2.model.fair_total, true);
  eq('the engine publishes the raw game margin as the equation’s first term', p0.model.raw_game_margin, p0.model.fair_spread);
  chk('and the calibrated shadow beside it, unpromoted', p0.model.margin_calibration && p0.model.margin_calibration.promoted === false
    && typeof p0.model.margin_calibration.calibrated_margin === 'number', p0.model.margin_calibration);
  const sum = p0.contributions.reduce((s, c) => s + c.points, 0);
  near('the contributions still sum to the priced number', sum, p0.model.fair_spread, 1e-9);
  const pr = D.fromEngine(p0);
  eq('the gate reads the engine’s own numbers', pr.fair, p0.model.fair_spread);
  eq('including both teams’ current-season games', pr.rating_detail.away_gp, 2);
  const before = JSON.stringify(p0.model);
  D.evaluate({ projection: pr, market: { spread: -30, books: 5 }, game: { home: 'Alabama', away: 'Kentucky', kickoff: KICK, neutral_site: false }, now_ms: NOW });
  eq('evaluating the gate leaves the projection byte-identical', JSON.stringify(p0.model), before);
}

/* ======================================================================== */
section('15 · the slate circuit breaker, the recheck and the false extreme');
{
  const normal = Array.from({ length: 30 }, (_, i) => ({ available: true, raw_gap_abs: i < 3 ? 8 : 2, raw_market_gap: i % 2 ? 2 : -2, week: 8 }));
  eq('a normal slate raises no alert', D.circuitBreaker(normal).alert, null);
  const wild = Array.from({ length: 30 }, (_, i) => ({ available: true, raw_gap_abs: i < 14 ? 12 : 2, raw_market_gap: 12, week: 8 }));
  const cb = D.circuitBreaker(wild);
  eq('14 of 30 games at 10+ in week 8 is MODEL_SCALE_ALERT', cb.alert, 'MODEL_SCALE_ALERT');
  eq('and it suppresses nothing: it counts', cb.observed.g10, 14);
  chk('the zero-centre check sees a one-sided slate', !!cb.zero_center_alert, cb);
  const prev = { raw_market_gap: 9, market_line: 5, verified: true };
  eq('a verified gap the market moves 2 pts further from triggers RECHECK_REQUIRED', D.movement(prev, { spread: 3, books: 4 }).recheck, true);
  eq('moving toward EdgeDesk does not', D.movement(prev, { spread: 7, books: 4 }).recheck, false);
  eq('and the state is named', D.movement(prev, { spread: 7, books: 4 }).state, 'MOVED_TOWARD');
  eq('an unverified gap never triggers it', D.movement({ raw_market_gap: 9, market_line: 5, verified: false }, { spread: 2 }).recheck, false);
  eq('false extreme: close held, result at the market', D.falseExtreme({ fair: 14, open: 5, close: 5, final_margin: 4 }), true);
  eq('NOT false: the market moved toward EdgeDesk, even though the ticket lost', D.falseExtreme({ fair: 14, open: 5, close: 8, final_margin: 2 }), false);
  eq('NOT false: the result landed on EdgeDesk’s side', D.falseExtreme({ fair: 14, open: 5, close: 4, final_margin: 13 }), false);
  eq('a gap under 7 is never an extreme', D.falseExtreme({ fair: 10, open: 5, close: 5, final_margin: 0 }), null);
}

/* ======================================================================== */
section('16 · the research view and the Model Lab read the verdict');
{
  const GAME = { game_id: 'g1', home: 'Iowa State', away: 'West Virginia' };
  const proj = { status: 'PREDICTED', model: { fair_spread: 14, display_fair_spread: 14, display_side: 'home', is_near_pickem: false },
    scores: { confidence: 72 }, contributions: [] };
  const v = V.build({ game: GAME, projection: proj, market: { spread_line: 5 }, coverage: { input_coverage: 0.9 }, disagreement: ev(base()) });
  eq('the view reads VERIFIED from the gate', v.research_label.key, 'VERIFIED_MAJOR_DISAGREEMENT');
  eq('and carries the evidence summary', v.disagreement.verified, true);
  const vi = V.build({ game: GAME, projection: proj, market: { spread_line: 5 }, coverage: { input_coverage: 0.9 },
    disagreement: ev(mut({}, x => { x.market.books = 1; x.market.range = null; })) });
  eq('a thin market reads MARKET FAULT', vi.research_label.key, 'MARKET_FAULT');
  const vn = V.build({ game: GAME, projection: proj, market: { spread_line: 5 }, coverage: { input_coverage: 0.9 } });
  eq('no gate result reads INVESTIGATE (fail closed)', vn.research_label.key, 'INVESTIGATE');
  const brief = V.brief(v);
  chk('the published brief carries the verdict without clock-dependent detail', brief.disagreement && brief.disagreement.verified === true && brief.disagreement.status === 'VERIFIED_MAJOR_DISAGREEMENT', brief.disagreement);

  /* the lab checkpoint stores the verdict; the verified gap IS the row's gap */
  const x = base();
  const model = { engine_id: 'edgedesk_cfb_p4', model_version: 'edgedesk_cfb_p4_v1.0.0', model_label: 'V1',
    game: { game_id: 'g1', season: 2026, week: 6, home: 'Iowa State', away: 'West Virginia', neutral_site: false, kickoff: KICK },
    pure: { margin: 14, total: 52, p_home: 0.75, sigma: 14.9, confidence_raw: 72 }, state: {}, explain: {}, inputs: {},
    slateGame: { disagreement_inputs: { contract: D.version, projection: x.projection, qb: x.qb, roster: x.roster, reliability: 82,
      game: { home_fbs: true, away_fbs: true, venue: 'Jack Trice Stadium' } } } };
  const v2 = { model_version: 'edgedesk_cfb_v2.1.0', projections: new Map([['g1', { engine_id: 'edgedesk_cfb_v2', model_version: 'edgedesk_cfb_v2.1.0',
    pure: { margin: 11, ens_sd: 1 }, components: { C_ridge: 11.5, D_gbm: 10.5 } }]]) };
  const c1 = { model_version: 'edgedesk_cfb_v2.0.0', projections: new Map([['g1', { engine_id: 'edgedesk_cfb_v2', model_version: 'edgedesk_cfb_v2.0.0', model_label: 'V2 · candidate 001',
    pure: { margin: 10.5 } }]]) };
  const market = { current_spread: -5, sportsbook_count: 4, market_dispersion: 0.5, market_as_of: '2026-10-01T10:00:00Z', market_stale: false, market_sources: ['espn', 'cfbd'] };
  const dq = { status: 'GREEN', checks: [] };
  const dec = { status: 'PASS', decision_source: 'test' };
  const row = CP.buildRow(model, 'T48', false, market, dec, dq, { now: '2026-10-01T12:00:00Z', role: 'champion', origin: 'LIVE',
    disagreement: D.evaluate(Object.assign({}, x, { projection: x.projection, submodels: { projections: { 'v2.1 C_ridge': 11.5, 'v2.1 D_gbm': 10.5, 'c001': 10.5 }, ensemble: 11, ensemble_sd: 1 } })) });
  eq('the lab row stores the verdict', row.disagreement_status, 'VERIFIED_MAJOR_DISAGREEMENT', row.disagreement_checks);
  eq('its verified gap is exactly the row’s raw gap (the SQL constraint)', row.verified_market_gap, row.model_market_gap);
  chk('with a calibrated gap beside it', typeof row.calibrated_market_gap === 'number');
  const noVerdict = CP.buildRow(model, 'T48', false, market, dec, dq, { now: '2026-10-01T12:00:00Z', role: 'champion', origin: 'LIVE' });
  chk('a row with no verdict carries no verdict fields', noVerdict.disagreement_status === undefined && noVerdict.verified_market_gap === undefined);
  chk('and the verdict changes the row hash (the row is what was known)', row.row_hash !== noVerdict.row_hash);

  const S = LABD.section({ preds: [Object.assign({}, row, { prediction_id: 'p1', engine_id: 'edgedesk_cfb_p4', origin: 'LIVE' })],
    evals: [{ prediction_id: 'p1', result_status: 'FINAL', abs_margin_error: 3, close_home_line: -7, final_margin: 11 }] });
  eq('the Model Lab counts the raw major disagreement', S.raw_major_disagreements, 1);
  eq('and the verified one', S.verified_major_disagreements, 1);
  eq('market movement toward the verified gap (the close came to EdgeDesk)', S.market_movement_toward_verified_pct, 100);
  eq('verified-gap MAE is the graded error', S.verified_gap_mae, 3);
  near('verified-gap CLV in points', S.verified_gap_clv, 2);
  eq('not a false extreme', S.false_extreme_rate_verified_pct, 0);
}

/* ======================================================================== */
section('17 · the board (app.html) shows VERIFIED only when the gate verifies');
{
  const fs = require('fs'), vm = require('vm');
  const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
  const a = APP.indexOf('function fbDgSubEnsure(){'), b = APP.indexOf('function fbP4Line(team,fairSpread){', a);
  chk('the board carries the gate adapter before its status function', a > 0 && b > a);
  const st = E.newState();
  E.ingest.seasonBreak(st);
  for (let i = 0; i < 4; i++) {
    E.ingest.absorbGame(st, { home: 'Alabama', away: 'Vanderbilt', home_fbs: true, away_fbs: true, home_points: 45, away_points: 7 });
    E.ingest.absorbGame(st, { home: 'Kentucky', away: 'Georgia', home_fbs: true, away_fbs: true, home_points: 17, away_points: 20 });
  }
  const kick = new Date(Date.now() + 2 * 86400e3).toISOString();
  const p = E.projectGame({ season: 2026, week: 6, state: st, game: { home: 'Alabama', away: 'Georgia', home_fbs: true, away_fbs: true, neutral_site: false, kickoff: kick },
    teams: { home: { conference: 'SEC' }, away: { conference: 'SEC' } } });
  /* the fixture carries no roster or QB inputs, so the engine's information
     confidence sits under its 35 floor; stated here, as a fixture choice */
  p.scores.confidence = 70;
  const line = p.model.fair_spread - 9.5;
  const u = { g: { game_id: 'b1', home_team: 'Alabama', away_team: 'Georgia', neutral_site: false, venue: 'Bryant-Denny Stadium', start_date: kick },
    t: Date.parse(kick), meta: { home: { is_fbs: true }, away: { is_fbs: true } } };
  function ctxWith(opts) {
    delete u._dg;
    const ctx = { window: {}, Date, Math, JSON, String, isFinite, fetch: () => new Promise(() => {}) };
    ctx.window.EDCfbDisagreement = opts.noGate ? undefined : D;
    /* the one research classifier the board word is read off (audit 2026-09-30 #6) */
    ctx.window.EDCanon = require(path.join(ROOT, 'lib', 'edgedesk_canon.js'));
    ctx.window.EDCalc = require(path.join(ROOT, 'lib', 'edgedesk_calc.js'));
    ctx.FB = { p4: { _proj: { b1: p }, up: [u], _mkt: {}, dgSub: opts.dgSub === undefined ? { b1: { source: 't', projections: { r: line + 9, g: line + 8, c: line + 8.5 }, ensemble: line + 8.5, ensemble_sd: 1 } } : opts.dgSub, dgSubLoading: true } };
    ctx.FB_GUARD = { p4: { game: 21 } };
    ctx.fbP4Assembly = () => ({ starters: { home: { status: 'PREVIOUS_GAME', player_name: 'QB1', availability: { state: 'UNKNOWN' } },
      away: { status: 'PREVIOUS_GAME', player_name: 'QB2', availability: { state: 'UNKNOWN' } } },
      contract: [{ field: 'availability', side: 'home', state: 'NOT_DUE_YET' }, { field: 'availability', side: 'away', state: 'NOT_DUE_YET' }] });
    /* THE GATE COUNTS ONLY DATED, FRESH QUOTES as books behind the consensus
       (docs/cfb-validation/DELIVERABLE.md §42): the captured quotes carry
       their capture time and how many books quoted each point. The undated
       cfb.lines rows behind fbMarketConsensusFor are reference context only. */
    ctx.window.EDMarketConsensus = require(path.join(ROOT, 'lib', 'market_consensus.js'));
    const nb = opts.books == null ? 4 : opts.books, capAt = new Date(Date.now() - 1800e3).toISOString();
    ctx.fbP4QuotesFor = () => (opts.undated ? [] : [
      { side: 'home', book: 'dk', line: -line, price_dec: 1.91, n_books: nb, captured_at: capAt, state: 'CURRENT', actionable: true },
      { side: 'away', book: 'dk', line: line, price_dec: 1.91, n_books: nb, captured_at: capAt, state: 'CURRENT', actionable: true }]);
    ctx.fbMarketConsensusFor = () => ({ books_reporting: opts.undated ? 6 : nb, market_dispersion: { range: 1 } });
    ctx.fbP4ReliabilityFor = () => ({ score: 82 });
    vm.createContext(ctx);
    /* the page's one gap helper (lib/edgedesk_calc.js through fbCalcGap) */
    { const c0 = APP.indexOf('function fbCalcGap('); vm.runInContext(APP.slice(c0, APP.indexOf('\n}\n', c0) + 3), ctx, { filename: 'app.html [fbCalcGap]' }); }
    vm.runInContext(APP.slice(a, b), ctx, { filename: 'app.html [gate adapter]' });
    return ctx;
  }
  const mkt = { spread_line: line, as_of: new Date(Date.now() - 3600e3).toISOString(), stale: false, match: 'captured quote, both teams resolved', book: 'captured · dk' };
  const good = ctxWith({});
  const sv = good.fbP4StatusFor(p, mkt, u);
  eq('a gap that passes every check is VERIFIED MAJOR DISAGREEMENT on the board', sv.t, 'VERIFIED MAJOR DISAGREEMENT', good.fbP4DisagreementFor(u, p, mkt, { score: 82 }).failed);
  eq('with the strongest visual class', sv.cls, 'verified');
  eq('found from the projection alone, as every export calls it', good.fbP4StatusFor(p, mkt).t, 'VERIFIED MAJOR DISAGREEMENT');
  eq('one book: MARKET FAULT', ctxWith({ books: 1 }).fbP4StatusFor(p, mkt, u).t, 'MARKET FAULT');
  eq('six UNDATED provider rows cannot verify a gap: MARKET FAULT', ctxWith({ undated: true }).fbP4StatusFor(p, mkt, u).t, 'MARKET FAULT');
  eq('no submodels: INVESTIGATE', ctxWith({ dgSub: null }).fbP4StatusFor(p, mkt, u).t, 'INVESTIGATE');
  const ng = ctxWith({ noGate: true }).fbP4StatusFor(p, mkt, u);
  eq('the gate library missing: INVESTIGATE (fail closed)', ng.t, 'INVESTIGATE');
  chk('saying verification is incomplete', /VERIFICATION INCOMPLETE/.test(ng.sub), ng);
  eq('a small gap stays RESEARCH', good.fbP4StatusFor(p, Object.assign({}, mkt, { spread_line: p.model.fair_spread - 3 }), u).t, 'RESEARCH');
}

console.log('\n' + (fail ? fail + ' of ' + (pass + fail) + ' checks FAILED' : 'ALL GREEN ' + pass + ' passed, 0 failed'));
process.exit(fail ? 1 : 0);
