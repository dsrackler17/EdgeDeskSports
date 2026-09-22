#!/usr/bin/env node
/* ===========================================================================
   THE NFL SLATE ARTIFACT, BUILT FROM FIXTURE FEEDS.

   Runs the real builder — the real football module out of app.html, the real
   engine and parameters — with games.csv and stats_team_week answered from
   fixtures, and asserts the conventions the research desk depends on: the
   home line is the negated margin, the outcome range is p10/p50/p90 of the
   home margin, the reference line is labelled a reference, kickoff is
   Eastern time converted to UTC, and nothing is a price.

   Run: node tools/football/nfl_slate.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const B = require('./build_nfl_slate.js');
const L = require('../../football/nfl/coaching_staff_ledger.js');

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push({ name, detail }); }
function done() {
  failures.forEach((f) => console.log('FAIL | ' + f.name + '  ' + JSON.stringify(f.detail).slice(0, 300)));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

/* kickoff conversion, DST and standard time */
chk('8:15 PM ET in September is 00:15 UTC next day', B.etToIso('2026-09-17', '20:15') === '2026-09-18T00:15:00.000Z', B.etToIso('2026-09-17', '20:15'));
chk('1:00 PM ET in December is 18:00 UTC', B.etToIso('2026-12-13', '13:00') === '2026-12-13T18:00:00.000Z', B.etToIso('2026-12-13', '13:00'));
chk('a missing time defaults to noon ET', /T16:00:00/.test(B.etToIso('2026-09-20', null)) || /T17:00:00/.test(B.etToIso('2026-09-20', null)));

const NOW = Date.parse('2026-09-16T12:00:00Z');
const GAMES = [
  'game_id,season,game_type,week,gameday,weekday,gametime,away_team,away_score,home_team,home_score,location,result,total,overtime,old_game_id,gsis,nfl_detail_id,pfr,pff,espn,ftn,away_rest,home_rest,away_moneyline,home_moneyline,spread_line,away_spread_odds,home_spread_odds,total_line,under_odds,over_odds,div_game,roof,surface,temp,wind,away_qb_id,home_qb_id,away_qb_name,home_qb_name,away_coach,home_coach,referee,stadium_id,stadium',
  '2026_01_LA_SF,2026,REG,1,2026-09-10,Thursday,20:15,LA,17,SF,24,Home,7,41,0,,,,,,,,7,7,150,-180,3.5,-110,-110,47.5,-110,-110,1,outdoors,grass,68,5,00-0036355,00-0037834,Matthew Stafford,Brock Purdy,Sean McVay,Kyle Shanahan,,SF01,Levi\'s Stadium',
  '2026_02_KC_BUF,2026,REG,2,2026-09-20,Sunday,13:00,KC,,BUF,,Home,,,,,,,,,,,10,10,120,-140,2.5,-110,-110,49.5,-110,-110,0,outdoors,a_turf,,,00-0033873,00-0034857,Patrick Mahomes,Josh Allen,Andy Reid,Sean McDermott,,BUF00,Highmark Stadium',
  '2026_02_SF_LA,2026,REG,2,2026-09-21,Monday,20:15,SF,,LA,,Home,,,,,,,,,,,10,10,-120,100,-1.5,-110,-110,46,-110,-110,1,dome,sportturf,,,00-0037834,00-0036355,Brock Purdy,Matthew Stafford,Kyle Shanahan,Sean McVay,,LA00,SoFi Stadium',
].join('\n');
const STW_HEAD = 'season,week,season_type,team,opponent_team,game_id,completions,attempts,passing_yards,passing_tds,passing_interceptions,sacks_suffered,sack_yards_lost,passing_first_downs,passing_epa,carries,rushing_yards,rushing_tds,rushing_first_downs,rushing_epa,def_sacks,def_interceptions,def_epa';
const STW = [STW_HEAD,
  '2026,1,REG,SF,LA,2026_01_LA_SF,22,30,260,2,0,1,8,12,6.1,28,120,1,7,2.0,3,1,4.0',
  '2026,1,REG,LA,SF,2026_01_LA_SF,24,36,240,1,1,3,20,10,-1.2,20,80,1,4,-0.5,1,0,-6.0',
].join('\n');
const ROSTER = 'season,team,position,depth_chart_position,jersey_number,status,full_name,gsis_id,espn_id\n2026,SF,QB,QB,13,ACT,Brock Purdy,00-0037834,4361741\n2026,LA,QB,QB,9,ACT,Matthew Stafford,00-0036355,12483';

(async () => {
  const emptyLedger = L.newLedger();
  const noBackfill = B.applyCoachingLedger(emptyLedger, [], [{
    done: true,
    g: { game_id: 'already-final', home_score: 31, away_score: 10 }
  }], new Date(NOW).toISOString());
  chk('a completed game without a frozen projection is not backfilled',
    noBackfill.settled === 0 && Object.keys(emptyLedger.settled).length === 0, noBackfill);

  const coachingLedger = L.newLedger();
  L.capture(coachingLedger, {
    game_id: '2026_01_LA_SF',
    season: 2026,
    week: 1,
    kickoff: '2026-09-11T00:15:00.000Z',
    home_code: 'SF',
    away_code: 'LA',
    model_home_margin: 3,
    captured_at: '2026-09-10T12:00:00.000Z',
    model_version: 'frozen-fixture'
  });

  const art = await B.build({
    now: NOW,
    fetchText: async (u) => (/games\.csv/.test(u) ? GAMES : /stats_team_week/.test(u) ? STW : /roster/.test(u) ? ROSTER : ''),
    lookahead: 12,
    coachingLedger
  });
  chk('schema', art.schema === 'edgedesk_nfl_slate_v1');
  chk('the completed game was absorbed', art.absorbed_games === 1, art.absorbed_games);
  chk('two upcoming games are on the slate', art.counts.games === 2, art.counts);
  chk('the previously frozen completed game settles from the final score',
    coachingLedger.settled['2026_01_LA_SF'] && coachingLedger.settled['2026_01_LA_SF'].residual === 4,
    coachingLedger.settled['2026_01_LA_SF']);
  chk('the build froze both upcoming projections',
    Object.keys(coachingLedger.pending).length === 2 && art.coaching_staff_ledger && art.coaching_staff_ledger.pending_total === 2,
    art.coaching_staff_ledger);
  chk('ledger wiring is evidence-only',
    art.coaching_staff_ledger && art.coaching_staff_ledger.projection_influence === false && art.coaching_staff_ledger.scoring_enabled === false,
    art.coaching_staff_ledger);
  chk('the slate publishes the evidence-only coaching staff contract',
    art.coaching_staff && art.coaching_staff.status === 'EVIDENCE_ONLY' && art.coaching_staff.affects_nfl_projection === false,
    art.coaching_staff && art.coaching_staff.status);
  chk('current frozen residual evidence is published without becoming a rating',
    art.coaching_staff && art.coaching_staff.teams.SF &&
      art.coaching_staff.teams.SF.coaching_staff_inputs.current_residual_conversion.available === true &&
      art.coaching_staff.teams.SF.coaching_staff_inputs.current_residual_conversion.value === 2 &&
      art.coaching_staff.teams.SF.coaching_staff_rating === null &&
      art.coaching_staff.teams.SF.coaching_staff_adjustment_points === 0,
    art.coaching_staff && art.coaching_staff.teams.SF);
  chk('one frozen season is not enough for multi-season head-coach evidence',
    art.coaching_staff && art.coaching_staff.teams.SF &&
      art.coaching_staff.teams.SF.coaching_staff_inputs.multi_season_head_coach.available === false &&
      art.coaching_staff.teams.SF.coaching_staff_inputs.multi_season_head_coach.value === null,
    art.coaching_staff && art.coaching_staff.teams.SF &&
      art.coaching_staff.teams.SF.coaching_staff_inputs.multi_season_head_coach);
  chk('one frozen season is not enough for franchise program persistence',
    art.coaching_staff && art.coaching_staff.teams.SF &&
      art.coaching_staff.teams.SF.coaching_staff_inputs.program_persistence.available === false &&
      art.coaching_staff.teams.SF.coaching_staff_inputs.program_persistence.value === null,
    art.coaching_staff && art.coaching_staff.teams.SF &&
      art.coaching_staff.teams.SF.coaching_staff_inputs.program_persistence);
  chk('insufficient team-week games keep efficiency development unavailable',
    art.coaching_staff && art.coaching_staff.teams.SF &&
      art.coaching_staff.teams.SF.coaching_staff_inputs.efficiency_development.available === false &&
      art.coaching_staff.teams.SF.coaching_staff_inputs.efficiency_development.value === null,
    art.coaching_staff && art.coaching_staff.teams.SF &&
      art.coaching_staff.teams.SF.coaching_staff_inputs.efficiency_development);
  const g = art.games.find((x) => x.game_id === '2026_02_KC_BUF');
  chk('the row carries display names and codes', g && g.home_team === 'Buffalo Bills' && g.away_code === 'KC', g && g.home_team);
  chk('the schedule feed head coaches ride on the pregame row',
    g && g.home_head_coach === 'Sean McDermott' && g.away_head_coach === 'Andy Reid',
    g && [g.home_head_coach, g.away_head_coach]);
  chk('kickoff is Eastern converted to UTC', g && g.kickoff === '2026-09-20T17:00:00.000Z', g && g.kickoff);
  chk('the game is predicted', g && g.model_status === 'PREDICTED', g && g.model_reason);
  chk('the frozen upcoming margin is exactly the pregame model margin',
    g && coachingLedger.pending[g.game_id] && coachingLedger.pending[g.game_id].pregame_home_margin === g.model_home_margin,
    g && coachingLedger.pending[g.game_id]);
  chk('the frozen ledger preserves the pregame head coaches',
    g && coachingLedger.pending[g.game_id] &&
      coachingLedger.pending[g.game_id].home_head_coach === 'Sean McDermott' &&
      coachingLedger.pending[g.game_id].away_head_coach === 'Andy Reid',
    g && coachingLedger.pending[g.game_id]);
  chk('home line is the negated margin', g && g.model_home_line === -g.model_home_margin && g.model_home_line != null, g && [g.model_home_line, g.model_home_margin]);
  chk('a win probability rides along', g && g.model_home_win_prob > 0 && g.model_home_win_prob < 1);
  chk('the outcome range is p10/p50/p90 of the home margin', g && g.outcome_range && g.outcome_range.p10 < g.outcome_range.p50 && g.outcome_range.p50 < g.outcome_range.p90 && /home margin/.test(g.outcome_range.unit));
  chk('the contributions that carried the number are published', g && g.contributions && g.contributions.spread.some((c) => c.key === 'net_epa'));
  chk('the reference line is labelled a reference, not a price', g && g.reference_market && /reference, not a price/.test(g.reference_market.source));
  chk('and its home line is the negated nflverse spread_line', g && g.reference_market.home_line === -2.5 && g.reference_market.home_margin === 2.5, g && g.reference_market);
  chk('the market is NOT JOINED in this build', g && g.market_status === 'NOT JOINED IN THIS BUILD');
  chk('the schedule feed’s starter is carried with its source', g && g.home_starter && g.home_starter.player_name === 'Josh Allen' && /games\.csv/.test(g.home_starter.source));
  chk('rest, roof, surface and division travel', g && g.home_rest === 10 && g.roof === 'outdoors' && g.surface === 'a_turf' && g.div_game === false);
  const d = art.games.find((x) => x.game_id === '2026_02_SF_LA');
  chk('a dome game reads dome', d && d.roof === 'dome');
  chk('a division game is flagged', d && d.div_game === true);
  chk('the engine version is stamped', /edgedesk_football/.test(art.engine.model_version) && /edgedesk_football/.test(g.model_version));
  chk('clubs carry ratings and ranks', art.teams.SF && typeof art.teams.SF.ratings.net_epa === 'number' || (art.teams.SF && Object.keys(art.teams.SF.ratings).length > 3), art.teams.SF && Object.keys(art.teams.SF.ratings).slice(0, 5));
  chk('the engine\u2019s validation record rides with the artifact and forbids a probability', art.engine.validation && art.engine.validation.tier === 'RESEARCH' && art.engine.validation.may_produce_probability === false && /does not beat the close/.test(art.engine.validation.record));
  chk('nothing in the artifact is a price', !JSON.stringify(art.games).includes('"best_dec"') && !JSON.stringify(art.games).includes('"odds_american"'));
  done();
})().catch((e) => { console.error(e); process.exit(1); });
