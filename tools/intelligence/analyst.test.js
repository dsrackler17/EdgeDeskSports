#!/usr/bin/env node
/* ===========================================================================
   THE ANALYST KERNEL — pure functions, tested on chosen inputs.

   What is proven here:
     - cover / push / lose under a residual pmf reconcile to one and respect
       whole-number pushes; the sensitivity never calls a model-conditional
       figure a betting probability unless the validation record permits;
     - an alternative line the reader names is read (and the ladder widens
       for it), labelled by the gap alone, with key numbers named;
     - an interaction module with no measured input says NOT_MEASURED; a
       measured one carries evidence from both sides, a mechanism, a counter,
       an uncertainty and whether the rating already prices it; no module
       ever claims coverage, route or tracking data;
     - recent form separates a weak-opponent margin from an improvement and
       keeps a small sample a hypothesis;
     - scenarios are labelled conditional or qualitative and never the
       projection;
     - follow-ups resolve against the conversation state; a stated belief is
       a hypothesis;
     - conflicting findings resolve by source tier then time;
     - the packet diff names what changed;
     - the critic extras reject a search the log does not show and a
       scenario written as the projection.

   Run: node tools/intelligence/analyst.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const I = require(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', '_intelligence.js'));
const R = require(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', '_research.js'));
const A = require(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', '_analyst.js'));
const EDINTEL = I.EDINTEL || I;
try { EDINTEL.loadSnapshotValidation('americanfootball_ncaaf'); } catch (_) { /* the kernel is additive */ }

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push({ name, detail }); }
function done() {
  failures.forEach((f) => console.log('FAIL | ' + f.name + '  ' + String(JSON.stringify(f.detail)).slice(0, 300)));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}
const near = (a, b, e) => Math.abs(a - b) <= (e == null ? 1e-6 : e);

/* ---- 1. cover / push / lose ------------------------------------------- */
{
  const pmf = { '-3': 0.1, '-2': 0.1, '-1': 0.1, '0': 0.2, '1': 0.2, '2': 0.2, '3': 0.1 };
  /* home margin projected +2; home line -2 (whole): home covers when margin > 2, i.e. residual > 0 */
  const c = A.coverFromPmf(pmf, 2, -2);
  chk('cover, push and lose sum to one', near(c.win + c.push + c.lose, 1, 1e-3), c);
  chk('a whole-number line carries the push mass of the residual that lands on it', near(c.push, 0.2, 1e-3) && near(c.win, 0.5, 1e-3), c);
  const h = A.coverFromPmf(pmf, 2, -2.5);
  chk('a half-point line never pushes', h.push === 0 && near(h.win, 0.5, 1e-3) && near(h.lose, 0.5, 1e-3), h);
  chk('a missing pmf produces no probability', A.coverFromPmf(null, 2, -2) === null);
}

/* ---- 2. line sensitivity ---------------------------------------------- */
{
  const s = A.lineSensitivity({ sport: 'americanfootball_ncaaf', side: 'away', selection: 'North Texas', model_home_line: 2.4, market_selection_line: -2.5, odds_american: -105 });
  chk('the sensitivity reads the registered college residual pmf', s.ok && /margin_resid/.test(s.basis), s.basis);
  chk('and is MODEL_CONDITIONAL because the spread record forbids a probability', s.probability_status === 'MODEL_CONDITIONAL' && s.validation_tier === 'RESEARCH', [s.probability_status, s.validation_tier]);
  chk('the selection line is stated from the selection side', s.model_selection_line === -2.4 && s.market_selection_line === -2.5);
  chk('the ladder is centred on the market line in half points', s.ladder.some((r) => r.selection_line === -2.5) && s.ladder.some((r) => r.selection_line === -3) && s.ladder.some((r) => r.selection_line === -2));
  chk('key numbers are named on the ladder', s.ladder.find((r) => r.selection_line === -3).key_number === 3 && s.ladder.find((r) => r.selection_line === -7).key_number === 7);
  chk('the price requirement is arithmetic on the price alone', s.requires && near(s.requires.break_even_cover_probability, 1 / R.americanToDec(-105), 1e-3), s.requires);
  chk('the verdict separates likely-to-cover from worth-betting', s.verdict && /NOT AN EDGE/.test(s.verdict.reading) && /different questions/.test(s.verdict.reading));
  chk('no expected value is produced', JSON.stringify(s).indexOf('ev_per_unit') < 0);
  const alt = A.atLine(s, 7);
  chk('a line off the ladder is read by widening it', alt.ok && alt.line.selection_line === 7, alt);
  chk('and named as a key number with the gap-alone label', alt.ok && alt.line.key_number === 7 && alt.label_on_gap_alone === 'MODEL DISAGREEMENT', alt);
  chk('the change in model-conditional cover is stated in points', alt.ok && typeof alt.change_in_cover_pp === 'number' && alt.change_in_cover_pp > 20, alt.change_in_cover_pp);
  const near1 = A.atLine(s, -1.5);
  chk('a line near the model is a PASS by the gap alone', near1.ok && near1.label_on_gap_alone === 'PASS', near1);
  chk('a quarter line is refused', !A.atLine(s, -2.25).ok);
  const nodist = A.lineSensitivity({ sport: 'basketball_ncaab', side: 'home', model_home_line: -3, market_selection_line: -3.5 });
  chk('with no registered distribution only the gap is shown', nodist.ok && nodist.probability_status === 'NOT_PRODUCED' && nodist.at_market.cover === null && nodist.gap_points === -0.5, nodist);
  const curve = A.lineSensitivity({ sport: 'americanfootball_nfl', side: 'home', model_home_line: -5.2, market_selection_line: -5, cover_curve: [{ home_line: -5, win: 0.46, push: 0.02, lose: 0.52, basis: 'margin_pmf_by_spread' }] });
  chk('a published cover curve is preferred and named', curve.ok && /margin_pmf_by_spread/.test(curve.basis) && curve.at_market.cover === 0.46 && curve.at_market.push === 0.02, curve.at_market);
  chk('the away side reads the same curve reversed', A.lineSensitivity({ sport: 'americanfootball_nfl', side: 'away', model_home_line: -5.2, market_selection_line: 5, cover_curve: [{ home_line: -5, win: 0.46, push: 0.02, lose: 0.52 }] }).at_market.cover === 0.52);
}

/* ---- 3. interactions --------------------------------------------------- */
const packet = {
  game: { sport: 'americanfootball_ncaaf', game_id: 'g1', home: 'Texas State', away: 'North Texas', kickoff: '2026-09-22T00:00:00Z', status: 'SCHEDULED' },
  model: { home_line: { value: 2.4, missing: false }, fair_total: { value: 58.1, missing: false }, home_win_probability: { value: 0.43, missing: false }, interval: { missing: true }, drivers: { positive: [], negative: [] }, validation: { tier: 'RESEARCH', may_produce_probability: false } },
  market: { primary: { market: 'spreads', selection: 'North Texas', side: 'away', handicap: -2.5, odds_american: '-105', actionable: true, captured_at: '2026-09-16T01:00:00Z' } },
  comparison: { orientation: { side: 'away', selection: 'North Texas', model_selection_line: -2.4, market_selection_line: -2.5 }, gap_points: -0.1 },
  drivers: [], profiles: { home: { plays_per_game: 75.5, pass_rate: 0.40, explosive_pass_rate: 0.10, red_zone_td_rate: null, third_down_rate: 0.57, avg_drive_start_ytg: 65, excluding_garbage_time: { plays_per_game: 61 }, giveaways: 1, takeaways: 5, source: 'football/matchup/profiles_2026.json', as_of: '2026-09-16T01:39:38Z' }, away: { plays_per_game: 69.5, pass_rate: 0.51, explosive_pass_rate: 0.14, third_down_rate: 0.42, excluding_garbage_time: { plays_per_game: 55 }, giveaways: 4, takeaways: 1, source: 'football/matchup/profiles_2026.json', as_of: '2026-09-16T01:39:38Z' } },
  ratings: { home: { etsr: 3.7, confidence: 0.41, defense_rating: 53.4, special_teams: { z: -0.13, available: true, coverage: 0.4 }, depth: 51.8, source: 'football/rankings/current.json', as_of: '2026-09-16T01:39:19Z' }, away: { etsr: 2.4, confidence: 0.29, defense_rating: 50.7, special_teams: { z: 0.12, available: true, coverage: 0.4 }, depth: 45, source: 'football/rankings/current.json', as_of: '2026-09-16T01:39:19Z' } },
  starters: { home: { player_name: 'Brad Jackson', status: 'PREVIOUS_GAME', confirmed: false, source: 'cfbfastR-data' }, away: { player_name: 'Tayven Jackson', status: 'PREVIOUS_GAME', confirmed: false, source: 'cfbfastR-data' } },
  injuries: { home: null, away: null }, availability: { home: { state: 'UNKNOWN', source: 'football/availability/current.json' }, away: { state: 'UNKNOWN', source: 'football/availability/current.json' } },
  situation: { rest_days: { home: 14, away: 14 }, weather: { value: { temp_f: 78, wind_mph: 16, precip_pct: 35 }, source: 'open-meteo forecast (live)', observed_at: '2026-09-16T11:00:00Z', freshness: 'LIVE' }, roof: null, surface: null },
  previous_games: { home: [{ date: '2026-09-08', week: 2, opponent: 'Eastern Michigan', venue: 'home', result: 'W', margin: 21, points_for: 38, points_against: 17, opponent_sp_plus_now: -7.7, opponent_sp_rank_now: 110, opponent_rating_time_basis: 'AS_ASSESSED_NOW' }, { date: '2026-09-01', week: 1, opponent: 'Texas', venue: 'away', result: 'L', margin: -10, points_for: 14, points_against: 24, opponent_sp_plus_now: 22.1, opponent_sp_rank_now: 5, opponent_rating_time_basis: 'AS_ASSESSED_NOW' }], away: [] },
  matchup: { home: { sp_plus_overall: 1.0 }, away: { sp_plus_overall: 3.5 } }, unknowns: [], sources: [{ source: 'football/fbs/slate.json', observed_at: null, freshness: 'LIVE' }],
};
const unit = (raw, adj, league, z, n, rel, side) => ({ raw, adjusted: adj, league, z, n, reliability: rel, side, source: 'football/rankings/current.json', as_of: '2026-09-16T01:39:19Z' });
const identity = {
  home: { team: 'Texas State', league: 'FBS', season: 2026, verified_at: '2026-09-16T01:39:42Z', inferences: [{ id: 'scheme_run_heavy', label: 'run-heavy offence', confidence: 0.9, inputs: {} }], qualitative: [],
    measured: { units: { sack_rate_allowed: unit(0.06, 0.058, 0.055, -0.3, 80, 0.7, 'offense'), def_sack_rate: unit(0.09, 0.095, 0.06, 1.4, 70, 0.7, 'defense'), yards_per_rush: unit(5.1, 5.0, 4.6, 0.5, 60, 0.6, 'offense'), def_yards_per_rush: unit(4.5, 4.4, 4.6, 0.2, 70, 0.7, 'defense'), explosive_pass_rate: unit(0.10, 0.10, 0.104, -0.1, 60, 0.6, 'offense'), def_explosive_pass_allowed: unit(0.075, 0.075, 0.104, 0.9, 70, 0.7, 'defense'), rz_success: unit(0.6, 0.6, 0.62, -0.1, 12, 0.3, 'offense') }, profile: packet.profiles.home, rating: packet.ratings.home, quarterback: { starter: { name: 'Brad Jackson', status: 'PREVIOUS_GAME', confirmed: false, source: 'cfbfastR-data' }, backup: { name: 'Gavin Parkhurst', basis: 'slot 2' }, epa: { career: { epa_per_dropback: 0.16, dropbacks: 389, sack_rate: 0.085 }, season: { epa_per_dropback: 0.81, dropbacks: 42 }, league_epa_per_dropback: 0.077, source: 'football/fbs_epa' }, competition: { contested: false, players: [{ player_name: 'Brad Jackson', dropbacks: 42, share: 0.9 }, { player_name: 'Gavin Parkhurst', dropbacks: 4, share: 0.1 }] }, room_rating: 55 }, home_venue: { name: 'UFCU Stadium', lat: 29.9, lon: -97.9, dome: false } } },
  away: { team: 'North Texas', league: 'FBS', season: 2026, verified_at: '2026-09-16T01:39:42Z', inferences: [{ id: 'scheme_pass_heavy', label: 'pass-heavy offence', confidence: 0.9, inputs: {} }, { id: 'protection_strong', label: 'protection is a strength', confidence: 0.7, inputs: {} }], qualitative: [],
    measured: { units: { sack_rate_allowed: unit(0.02, 0.021, 0.055, 1.6, 90, 0.75, 'offense'), def_sack_rate: unit(0.05, 0.05, 0.06, -0.4, 60, 0.6, 'defense'), yards_per_rush: unit(4.0, 4.1, 4.6, -0.5, 60, 0.6, 'offense'), def_yards_per_rush: unit(5.2, 5.3, 4.6, -0.9, 70, 0.7, 'defense'), explosive_pass_rate: unit(0.194, 0.283, 0.104, 1.93, 49, 0.76, 'offense'), def_explosive_pass_allowed: unit(0.12, 0.12, 0.104, -0.4, 66, 0.7, 'defense') }, profile: packet.profiles.away, rating: packet.ratings.away, quarterback: { starter: { name: 'Tayven Jackson', status: 'PREVIOUS_GAME', confirmed: false }, backup: null, epa: null, competition: null } } },
};
{
  const bare = A.interactions({ packet: Object.assign({}, packet, { situation: { rest_days: {}, weather: { missing: true, reason: 'no forecast' } }, profiles: null, ratings: null }), identity: null });
  chk('with nothing measured every pair module is NOT_MEASURED', bare.modules.filter((m) => m.status === 'NOT_MEASURED').length >= 7, bare.modules.map((m) => m.id + ':' + m.status));
  chk('and no decisive factor is invented', bare.decisive_factors.length === 0);
  chk('the coverage note says what does not exist', /coverage, route, personnel-grouping, snap-count or tracking/.test(bare.not_measured_note));
  const it = A.interactions({ packet, identity });
  const by = {}; it.modules.forEach((m) => { by[m.id] = m; });
  chk('ten modules are always returned', it.modules.length === 10);
  chk('pass rush v protection is measured from both sides’ units', by.pass_rush_vs_protection.status === 'MEASURED' && by.pass_rush_vs_protection.evidence.home.length >= 1 && by.pass_rush_vs_protection.evidence.away.length >= 1, by.pass_rush_vs_protection.evidence);
  chk('and favours the side whose pairing is wider (North Texas protection v Texas State rush)', by.pass_rush_vs_protection.advantage.side === 'North Texas' || by.pass_rush_vs_protection.advantage.side === 'Texas State', by.pass_rush_vs_protection.advantage);
  chk('it names the mechanism and a counter', /third-and/.test(by.pass_rush_vs_protection.mechanism) && !!by.pass_rush_vs_protection.counter);
  chk('and says the rating already prices the unit levels', by.pass_rush_vs_protection.in_model.included === true && /layer B/.test(by.pass_rush_vs_protection.in_model.how));
  chk('explosive pass v coverage says coverage is not measured', /coverage scheme, route data and tracking are not measured/.test(by.explosive_pass_vs_coverage.uncertainty.reasons.join(' ')));
  chk('QB under pressure reads the sack rates and says the pressure split is unmeasured', by.qb_under_pressure.status === 'MEASURED' && /not measured anywhere/.test(by.qb_under_pressure.mechanism), by.qb_under_pressure);
  chk('personnel v availability is NOT_MEASURED when availability is UNKNOWN, and says unknown is not healthy', by.personnel_vs_availability.status === 'NOT_MEASURED' && by.personnel_vs_availability.missing.some((x) => /not healthy/.test(x)), by.personnel_vs_availability.missing);
  chk('weather v style reads the forecast against pass rates', by.weather_vs_style.status === 'MEASURED' && /Wind of 16 mph/.test(by.weather_vs_style.mechanism) && by.weather_vs_style.advantage.side === 'Texas State', by.weather_vs_style);
  chk('special teams reads both ratings', by.special_teams_field_position.status === 'MEASURED' && by.special_teams_field_position.advantage.side === 'North Texas');
  chk('the backdoor module is an inference and says so', by.late_game_backdoor.kind === 'inference');
  chk('finishing is PARTIAL when one side has no red-zone record', by.finishing_drives.status !== 'MEASURED' || by.finishing_drives.missing.length >= 0);
  chk('three decisive factors at most, each with evidence from both sides', it.decisive_factors.length <= 3 && it.decisive_factors.length >= 2 && it.decisive_factors.every((d) => d.evidence.length >= 2 && d.mechanism), it.decisive_factors.map((d) => d.sentence));
  /* THE PRODUCING HALF OF THE COUNTER-CASE RULE, PINNED WHERE IT CANNOT ROT.
     `!it.counter_case ||` is vacuously true on a null, so this passed just as
     happily on a layer that never produced a counter-case at all. The eval
     suite tried to cover that by asserting one of its two LIVE questions would
     produce one — which is a question about which way this week's z-scores
     point, and went red on 20 September with nothing broken.
     This fixture carries measured factors on BOTH sides of the model
     favourite by construction, so a counter-case is owed here, every run. */
  const opposing = it.modules.filter((m) => m.status === 'MEASURED' && m.advantage
    && m.advantage.side && m.advantage.magnitude != null && m.advantage.side !== it.model_favourite);
  chk('this fixture measures factors on both sides of the model favourite', opposing.length > 0,
    it.modules.filter((m) => m.status === 'MEASURED' && m.advantage && m.advantage.side)
      .map((m) => m.id + ':' + m.advantage.side));
  chk('so a counter-case is PRODUCED, not refused', !!it.counter_case, it.model_favourite);
  chk('the counter-case favours the side the model does not',
    !!it.counter_case && it.counter_case.favours !== it.model_favourite, it.counter_case);
  chk('no module contains an invented coverage or tracking statistic', !/man coverage|zone rate|separation|time to throw:?\s*\d/i.test(JSON.stringify(it)));
}

/* ---- 4. recent form ----------------------------------------------------- */
{
  const f = A.formAssessment({ packet, identity });
  const H = f.sides.home;
  chk('margins are read against opponent quality', H.games[0].opponent_rating_now === -7.7 && H.games[0].expected_margin_sp != null && H.games[0].margin_vs_expected != null, H.games[0]);
  chk('the dominant win over a weak side is called what it is', f.questions.some((q) => /Eastern Michigan by 21/.test(q.answer) && /weak side/.test(q.answer)), f.questions);
  chk('two games is a hypothesis, not an improvement', H.small_sample && H.hypotheses.some((h) => h.id === 'sample'), H.hypotheses);
  chk('garbage time is quantified from the two profile views', H.garbage_time_share != null && H.garbage_time_share > 0.15, H.garbage_time_share);
  chk('turnover margin is flagged as the least repeatable input', H.turnover_margin === 4 && H.hypotheses.some((h) => h.id === 'turnovers'));
  chk('the opponent ratings are marked as-assessed-now', H.games.every((g) => g.opponent_rating_basis === 'AS_ASSESSED_NOW'));
  chk('a side with no games gets no invented read', f.sides.away.n === 0 && f.sides.away.avg_margin === null);
}

/* ---- 5. scenarios ------------------------------------------------------- */
{
  const s = A.scenarios({ packet, identity, sport: 'americanfootball_ncaaf', sensitivity: A.lineSensitivity({ sport: 'americanfootball_ncaaf', side: 'away', model_home_line: 2.4, market_selection_line: -2.5 }) });
  const by = {}; s.items.forEach((x) => { by[x.id] = x; });
  chk('a college QB-out scenario is QUALITATIVE with the evidence on file', by.home_qb_out.kind === 'QUALITATIVE' && by.home_qb_out.evidence.some((e) => /Gavin Parkhurst/.test(e)) && by.home_qb_out.result.home_line === null, by.home_qb_out);
  chk('and states what it would take to estimate it', /not on file/.test(by.home_qb_out.result.direction));
  const n = A.scenarios({ packet: Object.assign({}, packet, { game: Object.assign({}, packet.game, { sport: 'americanfootball_nfl' }), model: Object.assign({}, packet.model, { home_line: { value: -5.2, missing: false } }) }), sport: 'americanfootball_nfl', engine_scenarios: { home_qb_out: { home_line: -3.1, delta_home_line: 2.1, total: 51, home_win_prob: 0.6, basis: 'engine re-run with home_qb_id = null' } } });
  const hq = n.items.find((x) => x.id === 'home_qb_out');
  chk('an engine re-run is a CONDITIONAL_ESTIMATE with its assumptions', hq.kind === 'CONDITIONAL_ESTIMATE' && hq.result.home_line === -3.1 && hq.assumptions.length >= 2 && /not the projection/.test(hq.label), hq);
  chk('win-without-cover is model-conditional and labelled', by.win_not_cover && /MODEL-CONDITIONAL|QUALITATIVE/.test(by.win_not_cover.label));
  chk('the carrying assumption names the unconfirmed starter', /Brad Jackson|Tayven Jackson/.test(by.carrying_assumption.result.direction), by.carrying_assumption);
  chk('the note says none is the projection', /Neither is the projection/.test(s.note));
}

/* ---- 6. follow-ups and state ------------------------------------------ */
{
  const st = { game_id: 'g1', side: 'away', market: 'spreads' };
  const ol = A.followUp({ question: 'What about their offensive line?', state: st });
  chk('an offensive-line question routes to the protection and front modules', ol.kind === 'offensive_line' && ol.modules.indexOf('pass_rush_vs_protection') >= 0 && ol.is_follow_up);
  chk('"their" resolves to the other side of the conversation', ol.side_hint === 'home');
  const alt = A.followUp({ question: 'Does that change at +7?', state: st });
  chk('an alternative line is parsed with its sign', alt.kind === 'alt_line' && alt.line_override === 7);
  chk('a negative alternative line is parsed too', A.followUp({ question: 'What if we can get -1.5 instead?', state: st }).line_override === -1.5);
  chk('"who have they actually played" routes to form', A.followUp({ question: 'Who have they actually played?', state: st }).sections.indexOf('form') >= 0);
  chk('"strongest case against us" routes to the counter-case from our side', (() => { const f = A.followUp({ question: 'What is the strongest case against us?', state: st }); return f.kind === 'counter_case' && f.side_hint === 'away'; })());
  chk('a QB-out question routes to scenarios', A.followUp({ question: 'What changes if the starting quarterback is out?', state: st }).sections.indexOf('scenarios') >= 0);
  chk('"what changed since yesterday" routes to the diff', A.followUp({ question: 'What changed since yesterday?', state: st }).sections.indexOf('diff') >= 0);
  chk('a stated belief is a hypothesis, never a fact', (() => { const f = A.followUp({ question: 'I heard their left tackle is out, does that change it?', state: st }); return f.belief && f.belief.treatment === 'HYPOTHESIS'; })());
  chk('a new matchup is not a follow-up', !A.followUp({ question: 'Analyze Miami vs Wake Forest', state: st }).is_follow_up);
  chk('without a conversation state nothing is a follow-up', !A.followUp({ question: 'What about their line?', state: null }).is_follow_up);
  const cs = A.conversationState({ packet, previous: { turns: 2 }, investigation: { log: [{ gap: 'ol_availability', question: 'q', outcome: 'BLOCKED', blocker: 'no key' }, { gap: 'weather', question: 'w', outcome: 'FOUND' }] } });
  chk('the state carries the side, market and quoted number the server produced', cs.side === 'away' && cs.market === 'spreads' && cs.quoted_line === -2.5 && cs.quoted_odds === '-105' && cs.turns === 3, cs);
  chk('and the unresolved questions, not the found ones', cs.unresolved.length === 1 && cs.unresolved[0].gap === 'ol_availability');
  chk('and says it is re-verified every turn', /re-resolves|re-reads/.test(cs.note));
}

/* ---- 7. investigation plan and conflicts ------------------------------- */
{
  const plan = A.investigationPlan({ packet, sport: 'americanfootball_ncaaf' });
  const ids = plan.gaps.map((g) => g.id + (g.side ? '/' + g.side : ''));
  chk('unconfirmed starters, line availability and defensive personnel are gaps', ids.indexOf('starting_qb_confirmation/home') >= 0 && ids.indexOf('ol_availability/away') >= 0 && ids.indexOf('defensive_personnel/home') >= 0, ids);
  chk('an actionable price and a present forecast are not gaps', ids.indexOf('current_price') < 0 && ids.indexOf('weather') < 0, ids);
  chk('gaps are ordered by consequence', plan.gaps.every((g, i) => i === 0 || g.priority >= plan.gaps[i - 1].priority));
  const res = A.resolveConflicts([
    { value: 'Jared Goff', source: 'web search', source_kind: 'SEARCH', published_at: '2026-09-16T10:00:00Z' },
    { value: 'Jared Goff Questionable', source: 'nflverse injuries', source_kind: 'OFFICIAL_REPORT', published_at: '2026-09-15T18:00:00Z' },
    { value: 'Hendon Hooker', source: 'depth chart', source_kind: 'DEPTH_CHART', published_at: '2026-09-16T12:00:00Z' },
  ]);
  chk('the official report outranks a newer search result and a newer depth chart', res.resolved.source_kind === 'OFFICIAL_REPORT', res);
  chk('the disagreement is kept beside the resolution', res.disagreement && res.disagreement.length === 2);
  const tie = A.resolveConflicts([{ value: 'A', source: 's1', source_kind: 'DEPTH_CHART', published_at: '2026-09-15T00:00:00Z' }, { value: 'B', source: 's2', source_kind: 'DEPTH_CHART', published_at: '2026-09-16T00:00:00Z' }]);
  chk('among equals the newest wins and says so', tie.resolved.value === 'B' && /most recent/.test(tie.resolved.why));
  const groups = A.groupsOf([{ name: 'A', position: 'OT', status: 'Out' }, { name: 'B', position: 'CB', status: 'Questionable' }, { name: 'C', position: 'WR', status: 'Active' }]);
  chk('the injury report groups by position and drops the healthy', groups.OL.length === 1 && groups.DB.length === 1 && groups.WR_TE.length === 0);
}

/* ---- 8. the packet diff ------------------------------------------------- */
{
  const prev = JSON.parse(JSON.stringify(packet)); prev.packet_id = 'p1'; prev.built_at = '2026-09-15T12:00:00Z'; prev.label = { label: 'PASS' }; prev.market.primary.odds_american = '-110';
  const now = JSON.parse(JSON.stringify(packet)); now.packet_id = 'p2'; now.built_at = '2026-09-16T12:00:00Z'; now.label = { label: 'PRICE DEPENDENT' }; now.starters.home.player_name = 'Gavin Parkhurst';
  const d = A.packetDiff(prev, now);
  chk('the diff names the label, the price and the starter change', d.ok && d.changes.some((c) => c.field === 'label') && d.changes.some((c) => /market price/.test(c.field)) && d.changes.some((c) => /projected starter/.test(c.field) && c.to === 'Gavin Parkhurst'), d.changes);
  chk('an unchanged pair says so', A.packetDiff(prev, prev).unchanged === true);
}

/* ---- 9. critic extras --------------------------------------------------- */
{
  const an = { investigation: { log: [] }, scenarios: { items: [{ id: 'home_qb_out', result: { home_line: -3.1 } }] } };
  const c1 = A.criticExtras({ answer: 'EdgeDesk checked the injury report and found nothing.', analysis: an });
  chk('a search claim with an empty log is rejected', c1.some((f) => f.code === 'SEARCH_CLAIM_UNSUPPORTED' && f.severity === 'FAIL'), c1);
  const c2 = A.criticExtras({ answer: 'EdgeDesk checked the injury report and found nothing.', analysis: { investigation: { log: [{ outcome: 'FOUND' }] }, scenarios: { items: [] } } });
  chk('the same claim with a logged check passes', c2.length === 0, c2);
  const c3 = A.criticExtras({ answer: 'The model projects Texas State -3.1 here.', analysis: an });
  chk('a scenario number written as the projection is rejected', c3.some((f) => f.code === 'SCENARIO_AS_PROJECTION'), c3);
  const c4 = A.criticExtras({ answer: 'If Brad Jackson were out the engine re-run would put Texas State at -3.1.', analysis: an });
  chk('the same number written conditionally passes', c4.length === 0, c4);
  const logged = { investigation: { log: [{ gap: 'weather', outcome: 'FOUND' }, { gap: 'ol_availability', outcome: 'BLOCKED' }] }, scenarios: { items: [] } };
  const c5 = A.criticExtras({ answer: 'EdgeDesk checked the latest reports and confirmed every starter is healthy.', analysis: logged, packet: packet });
  chk('a "confirmed" claim needs a FOUND question on that subject', c5.some((f) => f.code === 'SEARCH_CLAIM_UNSUPPORTED'), c5);
  chk('and a clean sheet asserted over UNKNOWN availability is rejected', c5.some((f) => f.code === 'CLEAN_SHEET_CLAIM'), c5);
  const c6 = A.criticExtras({ answer: 'EdgeDesk checked the forecast and it shows 16 mph wind.', analysis: logged, packet: packet });
  chk('a check that was FOUND may be quoted', c6.length === 0, c6);
  const c7 = A.criticExtras({ answer: 'They blitz on 41.7% of dropbacks against a line allowing 2.31 seconds to throw.', analysis: logged, packet: packet });
  chk('a quantified statistic EdgeDesk never measures is rejected', c7.some((f) => f.code === 'NOT_MEASURED_STAT_CLAIM'), c7);
  const c8 = A.criticExtras({ answer: 'Pressure short of a sack is not measured, so the read rests on sack rates.', analysis: logged, packet: packet });
  chk('naming an unmeasured statistic without a number is fine', c8.length === 0, c8);
}

/* ---- 10. the prompt block and analyse() -------------------------------- */
{
  const an = A.analyse({ packet, identity, line_override: 7, investigation: { log: [{ gap: 'weather', question: 'forecast?', outcome: 'FOUND', finding: '78F, 16 mph', source: 'open-meteo', observed_at: '2026-09-16T11:00:00Z' }, { gap: 'ol_availability', question: 'line?', outcome: 'BLOCKED', blocker: 'EDGEDESK_SEARCH_API_KEY is not set' }], budget: { requests_used: 1, ms_used: 40 } } });
  chk('analyse assembles every layer', an.interactions && an.form && an.sensitivity && an.scenarios && an.investigation_plan && an.alternative_line && an.what_changes_it.length >= 1);
  const pb = A.promptBlock(an, packet);
  chk('the prompt block leads with the decisive factors', /DECISIVE MATCHUP FACTORS/.test(pb) && /STRONGEST COUNTER-CASE|NOT MEASURED/.test(pb));
  chk('and carries the sensitivity with its status', /LINE SENSITIVITY \(MODEL_CONDITIONAL/.test(pb) && /NOT betting probabilities/.test(pb));
  chk('and the reader’s alternative line', /THE READER’S ALTERNATIVE LINE: At \+7/.test(pb));
  chk('and the investigation log with the rule against claiming unlogged searches', /INVESTIGATION/.test(pb) && /forecast\? → FOUND/.test(pb) && /blocked: EDGEDESK_SEARCH_API_KEY/.test(pb) && /Never claim a search that is not in this log/.test(pb));
  chk('and the identity inferences with the season and verification date', /IDENTITY — North Texas \(2026, verified 2026-09-16\)/.test(pb) && /pass-heavy offence/.test(pb));
  chk('and every number in the block is quotable from the packet or the analysis', (() => { const nums = (pb.match(/-?\d+(?:\.\d+)?/g) || []).map(Number); const allowed = R.allowedFrom({ packet, analysis: an }); return nums.every((n) => allowed.numbers[String(Math.round(n * 100) / 100)] || allowed.numbers[String(Math.round(n))] || (Math.abs(n) <= 1 && allowed.numbers[String(Math.round(n * 100))])); })());
  chk('the tools register into the research kernel', A.registerTools() === true && A.TOOL_NAMES.every((t) => !!R.TOOLS[t]));
  packet.analysis = an;
  const t = R.runTool('get_line_sensitivity', { line: 7 }, { packet });
  chk('get_line_sensitivity reads an alternative line through the same envelope', t.ok && t.data.line.selection_line === 7, t.error);
  const bad = R.runTool('run_matchup_scenario', { scenario: 'nope' }, { packet });
  chk('an unknown scenario is refused at the boundary', !bad.ok && bad.error.code === 'INVALID_INPUT');
  chk('get_what_changed refuses without a previous snapshot', !R.runTool('get_what_changed', {}, { packet }).ok);
}
done();
