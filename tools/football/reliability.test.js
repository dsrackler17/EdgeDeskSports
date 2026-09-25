#!/usr/bin/env node
/* ===========================================================================
   RELIABILITY — the rules, pinned (lib/cfb_reliability.js).

   Reliability is how much EdgeDesk trusts the completeness, freshness,
   consistency and stability of the information under ONE projection. These
   checks hold it to that, one scenario at a time, against a fixture built
   to be excellent and then damaged one input at a time:

     1  a fully populated Power 4 matchup earns VERY STRONG
     2  a missing starting QB caps it
     3  QB sources that disagree cap it
     4  a major non-QB absence, weighted by impact, lowers it
     5  FBS vs a thinly covered FCS opponent is THIN DATA
     6  an FCS opponent with unusually good data is scored on its data
     7  missing venue coordinates cost a proportional amount
     8  stale core statistics cap it
     9  a stale market quote costs freshness
    10  no market quote costs freshness; a build that joins none is not charged
    11  a projection stable under perturbation earns its stability
    12  a projection that flips favorite is UNSTABLE and capped
    13  conflicting team identity caps it hard
    14  a model self-check failure is a DATA FAULT
    15  one optional field missing from an excellent game costs a little
    16  nothing observed after the judging time — no result, no close — can
        inform a pregame score
   plus: the same input always gives the same score; the perturbation is
   exactly the engine's own arithmetic; confidence and reliability stay
   separate; grades, legacy tiers and the research label; next actions; the
   record freezes the pregame score; the dashboard and the calibration.

   Run: node tools/football/reliability.test.js
   =========================================================================== */
'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
require(path.join(ROOT, 'football', 'cfb_p4', 'params.js'));
const P = global.EDCfbP4Params;
const E = require(path.join(ROOT, 'football', 'cfb_p4', 'engine.js'));
const R = require(path.join(ROOT, 'lib', 'cfb_reliability.js'));
const V = require(path.join(ROOT, 'lib', 'cfb_research_view.js'));
const C = require(path.join(ROOT, 'tools', 'record', 'football_record_core.js'));

let pass = 0, fail = 0;
const failures = [];
function chk(name, cond, detail) {
  if (typeof cond === 'function') { try { cond = cond(); } catch (e) { cond = false; detail = String((e && e.stack) || e).slice(0, 400); } }
  if (cond) { pass++; return; }
  fail++; failures.push(name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 500) : ''));
}
function eq(name, got, want) { chk(name, got === want, { got, want }); }
function section(t) { console.log('\n' + t); }
const clone = (o) => JSON.parse(JSON.stringify(o));

/* ------------------------------------------------------------- fixtures */
const NOW = Date.parse('2026-10-03T15:00:00Z');
const KICK = '2026-10-03T23:30:00Z';
const ago = (h) => new Date(NOW - h * 3600e3).toISOString();

function row(field, side, state, o) {
  return Object.assign({ field, side: side || null, state, source: 'fixture', as_of: ago(2), observed_at: ago(2),
    age_hours: 2, identity: null, detail: null, fix: null, priced: state === 'USABLE' }, o || {});
}
/* an excellent Power 4 game: every input on file, current and agreeing */
function goodContract() {
  return [
    row('venue_geography', 'home', 'USABLE', { detail: 'Ohio Stadium' }),
    row('venue_geography', 'away', 'USABLE', { detail: 'Beaver Stadium' }),
    row('weather', null, 'RESEARCH_ONLY', { observed_at: ago(1), as_of: ago(1) }),
    row('roster', 'home', 'USABLE', { as_of: ago(30), observed_at: null }),
    row('roster', 'away', 'USABLE', { as_of: ago(30), observed_at: null }),
    row('availability', 'home', 'USABLE', { detail: '2 absence report(s) on file' }),
    row('availability', 'away', 'USABLE', { detail: '1 absence report(s) on file' }),
    row('roster_talent', 'home', 'USABLE', { detail: 'composite 60 at confidence 0.62' }),
    row('roster_talent', 'away', 'USABLE', { detail: 'composite 58 at confidence 0.58' }),
    row('qb_starter', 'home', 'RESEARCH_ONLY', { as_of: ago(3), observed_at: ago(100) }),
    row('qb_availability', 'home', 'USABLE'),
    row('qb_starter', 'away', 'RESEARCH_ONLY', { as_of: ago(3), observed_at: ago(100) }),
    row('qb_availability', 'away', 'USABLE'),
    row('qb_efficiency_history', 'home', 'RESEARCH_ONLY'),
    row('qb_efficiency_history', 'away', 'RESEARCH_ONLY'),
    row('recruiting_talent', 'home', 'RESEARCH_ONLY'),
    row('recruiting_talent', 'away', 'RESEARCH_ONLY'),
    row('team_rating', 'home', 'USABLE', { detail: 'rated 18.2 over 6 absorbed game(s) this season' }),
    row('team_rating', 'away', 'USABLE', { detail: 'rated 14.9 over 6 absorbed game(s) this season' }),
    row('matchup_profile', null, 'USABLE'),
    row('off_field', 'home', 'UNAVAILABLE'),
    row('off_field', 'away', 'UNAVAILABLE'),
    row('coaching_continuity', 'home', 'RESEARCH_ONLY'),
    row('coaching_continuity', 'away', 'RESEARCH_ONLY'),
    row('schedule_context', 'home', 'USABLE'),
    row('schedule_context', 'away', 'USABLE')
  ];
}
function qbInfo(who, ident, avail) {
  return { available: true, value: 0.9, confidence: 0.9,
    components: { who_starts: { value: who }, identity: { value: ident }, observed: { value: 1 }, available: { value: avail } } };
}
function term(key, points, confidence) { return { key, label: key, points, available: true, confidence, source: 'fixture' }; }
/* a projection whose additive terms sum to its fair spread */
function projection(o) {
  o = o || {};
  const terms = o.terms || [term('rating', 3.3, 1), term('hfa', 2.5, 0.95), term('matchup', 0.4, 0.9),
    term('qb', 0, 0.2), term('travel', 0, 0.95), term('schedule', 0, 0.4), term('injury', 0, 0.6),
    term('rivalry', 0, 1), term('conference', 0, 0.6)];
  terms.filter((t) => t.key === 'qb' || t.key === 'travel').forEach((t) => { t.available = false; });
  const m = terms.reduce((s, t) => s + (t.available ? t.points : 0), 0);
  const ph = E.dist ? E.dist.winProb(m, 14.9) : 0.6;
  return {
    status: 'PREDICTED', engine: 'fixture', model_version: P.model_version, prediction_timestamp: ago(0.5),
    game: { home: o.home || 'Ohio State', away: o.away || 'Penn State' },
    model: { fair_spread: m, home_win_prob: ph, away_win_prob: 1 - ph, sigma_margin: 14.9,
      median_margin: m, p10_margin: m - 19, p90_margin: m + 19, display_side: m >= 0 ? 'home' : 'away' },
    scores: { confidence: 84, confidence_priced: 48 },
    contributions: terms,
    layers: { qb: { information: { home: qbInfo(0.95, 1, 1), away: qbInfo(0.95, 1, 1) } },
      strength: { preseason_blend: { prior_weight: 0.6, games_played: 6 } } }
  };
}
function goodInput() {
  return {
    now: NOW,
    game: { game_id: 'fx-1', home: 'Ohio State', away: 'Penn State', kickoff: KICK, neutral_site: false, venue: 'Ohio Stadium',
      home_fbs: true, away_fbs: true, home_team_id: 'ohiostate', away_team_id: 'pennstate',
      home_conference_id: 'bigten', away_conference_id: 'bigten', matchup_type: 'conference' },
    projection: projection(),
    contract: goodContract(),
    starters: {
      home: { status: 'ANNOUNCED', confirmed: true, player_name: 'Home QB', conflicts: 0, published_at: ago(20), retrieved_at: ago(3) },
      away: { status: 'ANNOUNCED', confirmed: true, player_name: 'Away QB', conflicts: 0, published_at: ago(20), retrieved_at: ago(3) } },
    qb_epa: { home: { state: 'MEASURED', identity: { kind: 'CONFIRMED_STARTER', contested: false } },
      away: { state: 'MEASURED', identity: { kind: 'CONFIRMED_STARTER', contested: false } } },
    injuries: { home: [{ player: 'A', athlete_id: '1', status: 'out' }], away: [{ player: 'B', athlete_id: '2', status: 'out' }] },
    personnel: {
      home: { status: 'ASSESSED', impact: 3, coverage: { official: true, comprehensive: true, grade: 'OFFICIAL' },
        absences: [{ probability_of_absence: 1, impact_if_absent: 3 }], unrated: [], key_losses: [] },
      away: { status: 'ASSESSED', impact: 2, coverage: { official: true, comprehensive: true, grade: 'OFFICIAL' },
        absences: [{ probability_of_absence: 1, impact_if_absent: 2 }], unrated: [], key_losses: [] } },
    team_quality: { home: { gates: [] }, away: { gates: [] } },
    roster_talent: { home: { confidence: 0.62 }, away: { confidence: 0.58 } },
    venues: { home: { lat: 40.0, lon: -83.0 }, away: { lat: 40.8, lon: -77.9 } },
    market: { joined: true, spread_line: 3.5, as_of: ago(0.5), stale: false, spread_fault: false, n_books: 5 },
    model_state: { built_at: ago(1) },
    blend: { home: { games_played: 6, prior_weight: 0.6, carried: 18.4, this_season: 17.9 },
      away: { games_played: 6, prior_weight: 0.6, carried: 15.0, this_season: 14.6 } },
    params: P
  };
}
const score = (inp) => R.score(inp);
/* next actions are listed only under 90: leave one QB's status unconfirmed,
   which caps the game at 89, so the actions of the damage under test show */
function sub90(i) {
  i.contract = i.contract.map((x) => x.field === 'qb_availability' && x.side === 'home' ? row('qb_availability', 'home', 'UNAVAILABLE') : x);
  i.projection.layers.qb.information.home = qbInfo(0.95, 1, 0);
  return i;
}
const gateIds = (r) => r.gates.map((g) => g.id);
const base = score(goodInput());

/* ======================================================================== */
section('1 · a fully populated Power 4 matchup');
chk('scores VERY STRONG', base.score >= 90 && base.grade === 'VERY_STRONG', { score: base.score, grade: base.grade, pen: base.penalties.slice(0, 5) });
eq('no gate binds', base.capped_by.length, 0);
chk('stability is measured and settled', base.stability.tier === 'VERY_STABLE' && base.stability.favorite_flip_rate === 0, base.stability);
chk('every component is reported with its max', R.COMPONENT_ORDER.every((k) => base.components[k] && base.components[k].max === R.CONFIG.weights[k]));
eq('the weights are 20/20/20/15/15/10', Object.values(R.CONFIG.weights).join('/'), '20/20/20/15/15/10');
chk('the components sum to the raw score', Math.abs(R.COMPONENT_ORDER.reduce((s, k) => s + base.components[k].score, 0) - base.raw) < 0.35);
eq('a game at 90+ lists no next actions', base.next_actions.length, 0);
chk('there is no base score: an empty input earns almost nothing', () => {
  const r = score({ now: NOW });
  return r.score <= 20;
});

/* ======================================================================== */
section('2 · a missing starting QB');
{
  const i = goodInput();
  i.starters.home = null;
  i.projection.layers.qb.information.home = { available: false };
  i.contract = i.contract.filter((x) => !(x.field === 'qb_starter' && x.side === 'home')).concat([row('qb_starter', 'home', 'UNAVAILABLE', { detail: 'no starter record was built for Ohio State' })]);
  const r = score(i);
  chk('QB_UNKNOWN binds', r.capped_by.indexOf('QB_UNKNOWN') >= 0, r.gates);
  chk('capped at 69 or below', r.score <= 69, r.score);
  chk('QB uncertainty is one of the largest single penalties', r.penalties.slice(0, 3).some((p) => /starting quarterback|QB/i.test(p.reason)), r.penalties.slice(0, 3));
  chk('the reason names the team', /Ohio State/.test(r.main_deduction), r.main_deduction);
  chk('the first next action identifies the QB, with a gain', r.next_actions[0] && /Identify Ohio State/.test(r.next_actions[0].action) && r.next_actions[0].potential_gain > 5, r.next_actions);
  const both = goodInput();
  both.starters = {}; both.projection.layers.qb.information = {};
  const rb = score(both);
  chk('both unknown caps lower (59)', rb.score <= 59 && rb.capped_by.indexOf('QB_UNKNOWN_BOTH') >= 0, { s: rb.score, c: rb.capped_by });
}

/* ======================================================================== */
section('3 · conflicting QB sources');
{
  const i = goodInput();
  i.starters.home = Object.assign({}, i.starters.home, { status: 'COMPETITION', confirmed: false, conflicts: 1 });
  i.qb_epa.home.identity = { kind: 'UNRESOLVED', contested: true };
  i.contract = i.contract.map((x) => (x.field === 'qb_starter' && x.side === 'home') ? row('qb_starter', 'home', 'CONFLICTING') : x);
  i.projection.layers.qb.information.home = qbInfo(0.5, 1, 1);
  const r = score(i);
  chk('the roster conflict binds at 69', r.capped_by.indexOf('ROSTER_CONFLICT') >= 0 && r.score <= 69, { s: r.score, c: r.capped_by });
  chk('source integrity loses points for the disagreement', r.components.source_integrity.score < base.components.source_integrity.score);
  chk('the contested job is gated too', gateIds(r).indexOf('QB_CONTESTED') >= 0);
  chk('resolving it is the top next action', /Resolve Ohio State/.test(r.next_actions[0].action), r.next_actions);
}

/* ======================================================================== */
section('4 · a major non-QB absence, weighted by impact');
{
  const i = goodInput();
  i.personnel.home = { status: 'ASSESSED', impact: 70, coverage: { official: true, comprehensive: true },
    absences: [{ probability_of_absence: 0.5, impact_if_absent: 80 }, { probability_of_absence: 1, impact_if_absent: 60 }],
    key_losses: [{ label: 'LT1', player_name: 'Big Tackle', injury_status: 'QUESTIONABLE', impact_if_absent: 80 }], unrated: [] };
  const r = score(i);
  chk('roster/availability falls by at least 1.5 pts', base.components.roster_availability.score - r.components.roster_availability.score >= 1.5,
    { b: base.components.roster_availability.score, r: r.components.roster_availability.score });
  chk('the reason names the impact and the player', r.penalties.some((p) => /70\/100/.test(p.reason) && /Big Tackle/.test(p.reason)), r.penalties.slice(0, 4));
  chk('and says the spread does not price it', r.penalties.some((p) => /not priced into the spread/.test(p.reason)));
  const minor = goodInput();
  minor.personnel.home = Object.assign({}, minor.personnel.home, { impact: 5 });
  chk('a minor absence costs less than a major one', score(minor).score > r.score, { minor: score(minor).score, major: r.score });
  const unrated = goodInput();
  unrated.personnel.home = { status: 'UNRATED_ABSENCES', coverage: { official: true, comprehensive: true }, unrated: [{ depth_rank: 1 }, { depth_rank: 1 }, { depth_rank: 5 }], absences: [] };
  const ru = score(unrated);
  chk('unrated starter-depth absences cost more than deep ones', ru.components.roster_availability.score < base.components.roster_availability.score
    && ru.penalties.some((p) => /at starter depth/.test(p.reason)), ru.penalties.slice(0, 3));
}

/* ======================================================================== */
function fcsInput(good) {
  const i = goodInput();
  i.game.away = 'Howard'; i.game.away_team_id = 'howard'; i.game.away_fbs = false; i.game.matchup_type = 'fbs_fcs';
  i.game.away_conference_id = 'meac';
  i.projection.game.away = 'Howard';
  if (good) return i;
  i.contract = i.contract.map((x) => {
    if (x.side !== 'away' && x.field !== 'matchup_profile') return x;
    if (x.field === 'team_rating') return row('team_rating', 'away', 'UNAVAILABLE', { detail: 'Howard is outside the rated FBS field, so the projection uses params.rating.fcs_rating' });
    if (x.field === 'matchup_profile') return row('matchup_profile', null, 'UNAVAILABLE', { detail: 'Howard is outside the FBS field the profiles cover' });
    if (['roster', 'roster_talent', 'availability', 'qb_availability', 'qb_efficiency_history'].indexOf(x.field) >= 0) return row(x.field, 'away', 'UNAVAILABLE', { detail: 'Howard is outside the FBS field' });
    if (x.field === 'recruiting_talent') return row(x.field, 'away', 'NOT_APPLICABLE');
    if (x.field === 'qb_starter') return row(x.field, 'away', 'UNAVAILABLE');
    return x;
  });
  i.starters.away = null; i.projection.layers.qb.information.away = { available: false };
  i.personnel.away = null; i.team_quality.away = null; i.roster_talent.away = null;
  i.blend.away = { basis: 'FCS bucket', value: -28, prior_weight: 1, carried: -28, this_season: -28, games_played: null };
  i.projection.contributions[0].points = 24; i.projection.contributions[2].available = false;
  i.projection.model.fair_spread = i.projection.contributions.reduce((s, t) => s + (t.available ? t.points : 0), 0);
  return i;
}
section('5 · FBS vs FCS with thin roster coverage');
{
  const r = score(fcsInput(false));
  chk('THIN DATA binds: an unrated opponent is not research-grade', r.capped_by.indexOf('THIN_DATA') >= 0 && r.score <= 59, { s: r.score, c: r.capped_by });
  eq('the gate label says THIN DATA', r.gate_label, 'THIN DATA');
  chk('the FCS floor widens the projection', r.stability.projection_stability_sd >= 6, r.stability.projection_stability_sd);
  chk('the reasons are specific, never generic', r.penalties.every((p) => !/input data incomplete/i.test(p.reason)) && r.penalties.some((p) => /Howard/.test(p.reason)));
  chk('the FCS floor names the action that would fix it', r.next_actions.some((a) => /FCS team-rating source/.test(a.action)), r.next_actions);
}

/* ======================================================================== */
section('6 · FBS vs FCS with unusually good data coverage');
{
  const r = score(fcsInput(true));
  chk('an FCS opponent the state actually rates is not THIN DATA', gateIds(r).indexOf('THIN_DATA') < 0, r.gates);
  chk('and scores on its data like any other game (STRONG or better)', r.score >= 80, { s: r.score, pen: r.penalties.slice(0, 4) });
  chk('the division alone moves nothing: same data, same score', r.score === base.score, { fcs: r.score, fbs: base.score });
}

/* ======================================================================== */
section('7 · missing venue coordinates');
{
  const i = goodInput();
  i.contract = i.contract.map((x) => (x.field === 'venue_geography' && x.side === 'home') ? row('venue_geography', 'home', 'UNAVAILABLE', { detail: 'no coordinates' }) : x);
  i.venues.home = null;
  const r = score(i);
  chk('environment loses the coordinates', r.components.environment.score < base.components.environment.score);
  chk('missing names venue_coordinates', r.missing.indexOf('venue_coordinates') >= 0, r.missing);
  chk('a proportional cost, not a cap', r.capped_by.length === 0 && base.score - r.score <= 8, { b: base.score, r: r.score, c: r.capped_by });
  const r9 = score(sub90(i));
  chk('the next action resolves the coordinates', r9.next_actions.some((a) => /venue coordinates/.test(a.action)), r9.next_actions);
}

/* ======================================================================== */
section('8 · stale statistics');
{
  const i = goodInput();
  i.model_state.built_at = ago(24 * 10);
  const r = score(i);
  chk('STALE_CORE binds at 69', r.capped_by.indexOf('STALE_CORE') >= 0 && r.score <= 69, { s: r.score, c: r.capped_by });
  chk('the reason gives the age', /10 days/.test(r.gates.filter((g) => g.id === 'STALE_CORE')[0].reason));
  const j = goodInput();
  j.model_state.unabsorbed = ['Penn State'];
  chk('a state that missed a team’s latest game is stale however new', score(j).capped_by.indexOf('STALE_CORE') >= 0);
}

/* ======================================================================== */
section('9 · a stale market quote');
{
  const i = goodInput();
  i.market.as_of = ago(30); i.market.stale = true;
  const r = score(i);
  chk('freshness loses the quote', r.components.freshness.score < base.components.freshness.score);
  chk('the reason says the quote is past its limit', r.penalties.some((p) => /market quote is past its freshness limit/.test(p.reason)));
  chk('a market quote four hours old is scored on its own clock, not the roster’s', () => {
    const j = goodInput(); j.market.as_of = ago(4);
    const f = score(j).components.freshness.items.filter((x) => x.id === 'market_age')[0];
    const ro = score(j).components.freshness.items.filter((x) => x.id === 'roster_age')[0];
    return f.earned > 0 && f.earned < f.max && ro.earned === ro.max;
  });
}

/* ======================================================================== */
section('10 · no market quote');
{
  const i = goodInput();
  i.market = { joined: true, spread_line: null };
  const r = score(i);
  chk('costs freshness and says so', r.penalties.some((p) => /no market quote/.test(p.reason)) && r.missing.indexOf('market_quote') >= 0);
  const r9 = score(sub90(i));
  chk('capturing one is a next action', r9.next_actions.some((a) => /Capture a market quote/.test(a.action)), r9.next_actions);
  const j = goodInput();
  j.market = { joined: false };
  const rj = score(j);
  chk('a caller that joins no market is not charged for one', rj.penalties.every((p) => !/market/.test(p.reason))
    && rj.components.freshness.items.filter((x) => x.id === 'market_age')[0].state === 'NOT_APPLICABLE');
}

/* ======================================================================== */
section('11 · a projection stable through perturbation');
{
  const s = R.stability(goodInput().projection, { params: P, blend: goodInput().blend, fbs: { home: true, away: true } });
  chk('it is measured, deterministic scenarios', s.measured && s.n_scenarios === 64, s);
  eq('VERY STABLE', s.tier, 'VERY_STABLE');
  eq('no flips', s.favorite_flip_rate, 0);
  chk('p10 <= p50 <= p90 around the published number', s.projection_p10 <= s.projection_p50 && s.projection_p50 <= s.projection_p90
    && Math.abs(s.projection_p50 - s.base_margin) < 0.5);
  chk('publishes the required fields', ['projection_stability_score', 'projection_stability_sd', 'projection_p10', 'projection_p50',
    'projection_p90', 'favorite_flip_rate'].every((k) => typeof s[k] === 'number'));
  chk('QB, travel and weather are named as not perturbed, with the reason', ['qb', 'travel', 'weather'].every((k) => s.not_perturbed.some((x) => x.key === k)));
}

/* ======================================================================== */
section('12 · a projection that frequently flips favorite');
{
  const i = goodInput();
  i.projection = projection({ terms: [term('rating', -1.5, 1), term('hfa', 2.7, 0.3), term('matchup', 0.3, 0.1),
    term('qb', 0, 0.2), term('travel', 0, 0.95), term('schedule', 0, 0.4), term('injury', 0, 0.6), term('rivalry', 0, 1), term('conference', 0, 0.6)] });
  i.projection.contributions[2].points = 5; i.projection.contributions[0].points = -6;
  i.projection.model.fair_spread = i.projection.contributions.reduce((s, t) => s + (t.available ? t.points : 0), 0);
  i.blend.home = { games_played: 1, prior_weight: 1, carried: 10, this_season: 2 };
  const r = score(i);
  chk('flips in a quarter or more of runs', r.stability.favorite_flip_rate >= 0.25, r.stability);
  eq('UNSTABLE', r.stability.tier, 'UNSTABLE');
  chk('cannot be STRONG or VERY STRONG', r.score <= 79 && gateIds(r).some((g) => /UNSTABLE/.test(g)), { s: r.score, g: gateIds(r) });
  chk('the explanation gives the flip rate', R.explain(r).some((l) => /favorite flips \d+%|flips favorite in \d+%/.test(l)));
  const cap = goodInput(); cap.projection = i.projection; cap.blend = i.blend;
  chk('an otherwise excellent game that flips is held under STRONG by the gate', score(cap).score <= 79);
}

/* ======================================================================== */
section('13 · conflicting team identity');
{
  const i = goodInput();
  i.game.away_team_id = 'ohiostate';
  const r = score(i);
  chk('IDENTITY_CONFLICT binds at 40', r.capped_by.indexOf('IDENTITY_CONFLICT') >= 0 && r.score <= 40, { s: r.score, c: r.capped_by });
  const j = goodInput();
  j.projection.game.away = 'Michigan';
  chk('a projection for a different team is a conflict too', score(j).capped_by.indexOf('IDENTITY_CONFLICT') >= 0);
}

/* ======================================================================== */
section('14 · a model self-check failure');
{
  const i = goodInput();
  i.projection.model.fair_spread += 3;                  /* the terms no longer sum to it */
  const r = score(i);
  chk('is a DATA FAULT capped at 20', r.gate_label === 'DATA FAULT' && r.score <= 20, { s: r.score, g: r.gates });
  chk('the reason names the failed check', /do not sum to its fair spread/.test(r.main_deduction), r.main_deduction);
  const j = goodInput(); j.projection.model.home_win_prob = 0.2;
  chk('a win probability that favours the other side is a fault', score(j).gate_label === 'DATA FAULT');
  const k = goodInput(); k.projection = { status: 'BLOCKED', reason: 'sanity check failed' };
  const rk = score(k);
  chk('a blocked projection is a fault and says why', rk.gate_label === 'DATA FAULT' && /sanity check failed/.test(rk.main_deduction), rk.main_deduction);
}

/* ======================================================================== */
section('15 · one optional field missing from an excellent game');
{
  const i = goodInput();
  i.contract = i.contract.map((x) => x.field === 'weather' ? row('weather', null, 'FETCH_FAILED', { detail: 'the forecast request did not answer' }) : x);
  const r = score(i);
  chk('costs a little and no more', base.score - r.score >= 1 && base.score - r.score <= 3, { b: base.score, r: r.score });
  chk('no gate binds for it', r.capped_by.length === 0);
  const dome = goodInput();
  dome.contract = dome.contract.map((x) => x.field === 'weather' ? row('weather', null, 'NOT_APPLICABLE') : x);
  eq('a dome’s weather is not a hole', score(dome).score, base.score);
  const neutral = goodInput();
  neutral.game.neutral_site = true;
  neutral.contract = neutral.contract.map((x) => (x.field === 'venue_geography' && x.side === 'away') ? row('venue_geography', 'away', 'NOT_APPLICABLE') : x);
  chk('a neutral site’s travel is not a hole', score(neutral).components.environment.items.filter((x) => x.id === 'travel')[0].state === 'NOT_APPLICABLE');
  chk('off-field reporting is published as not scored, with the reason', base.not_scored.some((x) => x.field === 'off_field'));
}

/* ======================================================================== */
section('16 · nothing after the judging time can inform a pregame score');
{
  const i = goodInput();
  const j = goodInput();
  j.game.final = { home_score: 31, away_score: 10 }; j.close = { home_line: -7 }; j.result = 'win';
  j.projection.final_margin = 21;
  eq('a result and a close in the input change nothing', score(j).score, score(i).score);
  const k = goodInput();
  k.contract = k.contract.map((x) => x.field === 'availability' && x.side === 'home' ? Object.assign({}, x, { observed_at: new Date(NOW + 5 * 3600e3).toISOString() }) : x);
  const rk = score(k);
  chk('a timestamp later than now is refused and gated', rk.capped_by.indexOf('FUTURE_DATA') >= 0, rk.gates);
  const realNow = Date.now;
  Date.now = () => NOW + 400 * 24 * 3600e3;
  const later = score(goodInput());
  Date.now = realNow;
  eq('the wall clock is never read: the score is judged at input.now', later.score, base.score);
  /* the record: a number published after kickoff is refused with its score */
  const L = C.emptyLedger('cfb', 2026);
  const proj = C.projectionFromSlate('cfb', { model_status: 'PREDICTED', game_id: 'g1', season: 2026, week: 6, kickoff: KICK,
    home_team: 'Ohio State', away_team: 'Penn State', model_home_line: -3.5, model_fair_total: 50, model_home_win_prob: 0.6,
    home_division: 'fbs', away_division: 'fbs', reliability_score: 88, reliability_grade: 'STRONG',
    reliability_components: { team_data: { score: 19, max: 20 } }, projection_stability: { projection_stability_sd: 1.2, favorite_flip_rate: 0, tier: 'VERY_STABLE' },
    reliability: { contract: R.version, capped_by: [] } }, { season: 2026 });
  eq('a late publication is refused', C.recordProjection(L, proj, { published_at: new Date(Date.parse(KICK) + 60e3).toISOString() }), 'refused:published after kickoff');
  eq('and leaves no reliability behind', L.games.g1, undefined);
}

/* ======================================================================== */
section('determinism');
{
  const a = score(goodInput()), b = score(goodInput()), c2 = score(clone(goodInput()));
  eq('the same input always gives the same result', JSON.stringify(a), JSON.stringify(b));
  eq('a JSON round-trip of the input changes nothing', JSON.stringify(a), JSON.stringify(c2));
  const s1 = R.stability(goodInput().projection, { params: P, blend: goodInput().blend });
  eq('the perturbation scenarios are fixed', JSON.stringify(s1), JSON.stringify(R.stability(goodInput().projection, { params: P, blend: goodInput().blend })));
}

/* ======================================================================== */
section('the perturbation is the engine’s own arithmetic');
{
  const st = E.newState();
  const req = { season: P.trained_through_season + 1, week: 1, state: st,
    game: { home: 'Ohio State', away: 'Penn State', neutral_site: false, kickoff: KICK, home_fbs: true, away_fbs: true },
    teams: { home: { conference: 'Big Ten' }, away: { conference: 'Big Ten' } }, venue: {}, weather: null, market: {}, timestamps: {} };
  const p0 = E.projectGame(req);
  chk('the engine publishes a projection', p0.status === 'PREDICTED', p0.reason);
  const sum = p0.contributions.reduce((s, t) => s + (t.available ? t.points : 0), 0);
  chk('its additive terms sum to its fair spread (what the perturbation relies on)', Math.abs(sum - p0.model.fair_spread) < 1e-9, { sum, fs: p0.model.fair_spread });
  const key = E.normKey('Ohio State');
  const b0 = E.strength.blendedRating(st, key, true, 1);
  const st2 = clone(st); st2.r[key] = st.r[key] + 2;
  const p1 = E.projectGame(Object.assign({}, req, { state: st2 }));
  chk('moving the rating input moves the engine’s number by exactly the rating term’s share',
    Math.abs((p1.model.fair_spread - p0.model.fair_spread) - 2 * b0.prior_weight) < 1e-9,
    { moved: p1.model.fair_spread - p0.model.fair_spread, w: b0.prior_weight });
  const s = R.stability(p0, { params: P, blend: { home: b0, away: E.strength.blendedRating(st, E.normKey('Penn State'), true, 1) } });
  chk('the scenarios centre on the engine’s own number', Math.abs(s.projection_p50 - p0.model.fair_spread) < 0.6, { p50: s.projection_p50, fs: p0.model.fair_spread });
}

/* ======================================================================== */
section('confidence and reliability are separate numbers');
{
  const i = goodInput(); i.projection.scores.confidence = 20;
  eq('changing the engine’s confidence does not move reliability', score(i).score, base.score);
  const v1 = V.build({ game: { game_id: 'fx', home: 'Ohio State', away: 'Penn State' }, projection: goodInput().projection,
    market: { spread_line: 3.5 }, reliability: base });
  const worse = score(fcsInput(false));
  const v2 = V.build({ game: { game_id: 'fx', home: 'Ohio State', away: 'Penn State' }, projection: goodInput().projection,
    market: { spread_line: 3.5 }, reliability: worse });
  eq('and changing reliability does not move confidence', v1.confidence.score, v2.confidence.score);
}

/* ======================================================================== */
section('grades, legacy tiers and the research label');
{
  const G = (s) => R.grade(s).label;
  chk('the grade bands', G(95) === 'VERY STRONG' && G(90) === 'VERY STRONG' && G(89) === 'STRONG' && G(80) === 'STRONG'
    && G(79) === 'ADEQUATE' && G(70) === 'ADEQUATE' && G(69) === 'CAUTION' && G(60) === 'CAUTION' && G(59) === 'LOW'
    && G(50) === 'LOW' && G(49) === 'VERY LOW' && G(0) === 'VERY LOW');
  chk('the three legacy tiers keep their LOW bar at 60', R.legacyTier(80) === 'STRONG' && R.legacyTier(79) === 'ADEQUATE'
    && R.legacyTier(60) === 'ADEQUATE' && R.legacyTier(59) === 'LOW');
  const g = { game_id: 'fx', home: 'Ohio State', away: 'Penn State' };
  const good = V.build({ game: g, projection: goodInput().projection, market: { spread_line: -0.5 }, reliability: base });
  chk('the view prints a score, never a percentage', good.reliability.text === base.score + ' · VERY STRONG' && !/%/.test(good.reliability.text), good.reliability.text);
  eq('and keeps the tier older readers key on', good.reliability.tier, 'STRONG');
  const low = V.build({ game: g, projection: goodInput().projection, market: { spread_line: -0.5 }, reliability: score(fcsInput(false)) });
  eq('under 60 is LOW RELIABILITY', low.research_label.key, 'LOW_RELIABILITY');
  eq('by the reliability rule', low.research_label.rule, 'reliability');
  chk('whose sentence gives the reasons, not a count', /Why:/.test(low.research_label.means) && /THIN DATA|FCS/.test(low.research_label.means), low.research_label.means);
  const brief = V.brief(good);
  chk('the published brief carries the score, grade and components', brief.reliability.score === base.score
    && brief.reliability.components.length === 6 && /not a probability/.test(brief.reliability.scale), brief.reliability);
  const legacy = V.build({ game: g, projection: goodInput().projection, market: { spread_line: -0.5 }, coverage: { input_coverage: 0.77, known: 20, applicable: 26 } });
  chk('a caller with only coverage still gets the legacy number, marked legacy', legacy.reliability.legacy === true && legacy.reliability.pct === 77);
}

/* ======================================================================== */
section('what would raise it');
{
  const i = goodInput();
  i.contract = i.contract.map((x) => x.field === 'availability' && x.side === 'away' ? row('availability', 'away', 'FETCH_FAILED', { detail: 'espn_depth refuses for all 138 programmes (HTTP 404)' }) : x);
  i.personnel.away = { status: 'NOT_ASSESSABLE', coverage: { official: false, comprehensive: false } };
  i.contract = i.contract.map((x) => x.field === 'qb_availability' && x.side === 'away' ? row('qb_availability', 'away', 'UNAVAILABLE') : x);
  i.projection.layers.qb.information.away = qbInfo(0.95, 1, 0);
  const r = score(i);
  chk('a game under 90 lists its next actions', r.score < 90 && r.next_actions.length > 0, { s: r.score, n: r.next_actions });
  chk('each carries an upper-bound gain, never a promise', r.next_actions.every((a) => a.potential_gain >= 1 && /^up to \+\d+$/.test(a.potential_gain_text)
    && a.potential_gain <= 100 - r.score));
  chk('the provider-wide refusal is named as one', r.penalties.some((p) => /provider-wide refusal/.test(p.reason) && /espn_depth/.test(p.reason)), r.penalties.slice(0, 3));
  chk('restoring the source is the top action', () => /Restore an injury\/availability source for Penn State/.test(r.next_actions[0].action), r.next_actions);
}

/* ======================================================================== */
section('the record freezes the pregame score');
{
  const slateRow = { model_status: 'PREDICTED', game_id: 'g2', season: 2026, week: 6, kickoff: KICK,
    home_team: 'Ohio State', away_team: 'Penn State', model_home_line: -3.5, model_fair_total: 50, model_home_win_prob: 0.6,
    home_division: 'fbs', away_division: 'fbs', reliability_score: 84, reliability_grade: 'STRONG',
    reliability_components: { team_data: { score: 19, max: 20 }, roster_availability: { score: 12, max: 20 } },
    projection_stability: { projection_stability_sd: 1.9, favorite_flip_rate: 0, tier: 'STABLE' },
    reliability: { contract: R.version, capped_by: [] } };
  const L = C.emptyLedger('cfb', 2026);
  const p1 = C.projectionFromSlate('cfb', slateRow, { season: 2026 });
  eq('the slate row carries its reliability into the projection', p1.reliability.score, 84);
  eq('recorded', C.recordProjection(L, p1, { published_at: ago(10) }), 'new');
  chk('first and pick both carry it, stamped', L.games.g2.first.reliability.score === 84 && L.games.g2.pick.reliability.at === ago(10));
  const p2 = C.projectionFromSlate('cfb', Object.assign({}, slateRow, { reliability_score: 88, reliability_grade: 'STRONG' }), { season: 2026 });
  eq('a later pregame read with the same number is not a revision', C.recordProjection(L, p2, { published_at: ago(5) }), 'unchanged');
  chk('but refreshes the reliability behind the pick', L.games.g2.pick.reliability.score === 88 && L.games.g2.revisions === 0 && L.games.g2.first.reliability.score === 84);
  const older = C.projectionFromSlate('cfb', Object.assign({}, slateRow, { reliability_score: 50 }), { season: 2026 });
  C.recordProjection(L, older, { published_at: ago(20) });
  eq('an older publication never overwrites it', L.games.g2.pick.reliability.score, 88);
  const noRel = C.projectionFromSlate('cfb', Object.assign({}, slateRow, { reliability_score: null }), { season: 2026 });
  eq('a slate that predates reliability records null, never a guess', noRel.reliability, null);
  L.games.g2.final = { home_score: 24, away_score: 20, source: 'fixture' };
  L.games.g2.close = { home_line: -4, total: 49, source: 'fixture' };
  const sum = C.gradeLedger(L, new Date(Date.parse(KICK) + 86400e3).toISOString());
  eq('the grade carries the bucket', L.games.g2.grade.reliability.bucket, '80-89');
  chk('the summary reports error by reliability bucket, unvalidated at n=1', sum.by_reliability && sum.by_reliability.buckets.length === 6
    && sum.by_reliability.validated === false, sum.by_reliability && sum.by_reliability.verdict);
}

/* ======================================================================== */
section('the dashboard and the calibration');
{
  const rows = [
    { home_conference: 'Big Ten', away_conference: 'Big Ten', matchup_type: 'conference', legacy_input_coverage: 0.77, reliability: base },
    { home_conference: 'Big Ten', away_conference: 'MEAC', matchup_type: 'fbs_fcs', legacy_input_coverage: 0.5, reliability: score(fcsInput(false)) }
  ];
  const S = R.summarize(rows);
  chk('counts, percentiles and grades', S.games === 2 && S.by_grade.reduce((n, g) => n + g.n, 0) === 2 && S.percentiles.p50 != null);
  chk('FBS vs FCS apart', S.fbs_vs_fcs.fbs_fbs.n === 1 && S.fbs_vs_fcs.fbs_fcs.n === 1);
  chk('the THIN DATA game is flagged', S.flags.thin_data === 1);
  chk('bottlenecks are named, counted per game', S.bottlenecks.length > 0 && S.bottlenecks.every((b) => b.games >= 1 && typeof b.label === 'string'));
  chk('the old measure sits beside the new', S.legacy_input_coverage && S.legacy_input_coverage.n === 2);
  /* synthetic calibration: error falling with reliability validates, the reverse does not */
  function synth(order) {
    const out = [];
    [95, 85, 75, 65].forEach((rel, i) => { for (let k = 0; k < 40; k++) {
      const err = order === 'good' ? 2 + i * 2 : 8 - i * 2;
      out.push({ reliability: rel, model_margin: 3, close_margin: 3 + (k % 2 ? err : -err), final_margin: 3 + (k % 2 ? err * 2 : -err * 2) });
    } });
    return out;
  }
  eq('an ordering where error falls as reliability rises validates', R.calibrate(synth('good')).validated, true);
  eq('the reverse ordering does not', R.calibrate(synth('bad')).validated, false);
  const small = R.calibrate(synth('good').slice(0, 50));
  eq('a thin sample is never validated', small.validated, false);
  chk('and says why', /too few graded games/.test(small.verdict), small.verdict);
}

/* ======================================================================== */
console.log('');
if (fail) {
  failures.forEach((f) => console.log('  FAIL ' + f));
  console.log('\nFAIL | reliability | ' + pass + ' passed, ' + fail + ' failed');
  process.exit(1);
}
console.log('ALL GREEN ' + pass + ' passed, 0 failed');
