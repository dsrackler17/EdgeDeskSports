#!/usr/bin/env node
'use strict';

const B = require('./build_coverage.js');
global.window = global.window || global;
require('../cfb_p4/params.js');
const E = require('../cfb_p4/engine.js');

let pass=0, fail=0;
function chk(name, ok, detail){
  if(typeof ok==='function'){try{ok=!!ok();}catch(e){detail=String(e&&e.stack||e);ok=false;}}
  if(ok){pass++;return;}
  fail++;console.error('FAIL | '+name+(detail==null?'':' | '+JSON.stringify(detail).slice(0,500)));
}

const rows={2026:[{
  game_id:'G1',season:2026,week:1,start_date:'2026-09-01T00:00:00Z',
  completed:true,neutral_site:true,
  home_team:'Texas Tech',away_team:'LSU',
  home_division:'fbs',away_division:'fbs',
  home_points:31,away_points:24
}]};
const eff={
  schema:'edgedesk_cfb_engine_efficiency_v1',season:2026,
  games_with_stats:1,team_game_rows:2,
  games:{G1:{teams:{
    texastech:{success_rate:0.56,def_success_rate:0.38,yards_per_play:6.9,def_yards_per_play:4.8,
      sack_rate_allowed:0.03,def_sack_rate_allowed:0.08,plays_per_game:70,def_plays_per_game:64},
    lsu:{success_rate:0.42,def_success_rate:0.49,yards_per_play:5.1,def_yards_per_play:6.2,
      sack_rate_allowed:0.09,def_sack_rate_allowed:0.04,plays_per_game:64,def_plays_per_game:70}
  }}}
};

const joined=B.efficiencyForGame(eff,rows[2026][0],2026);
chk('game id and canonical team keys join the published efficiency rows',
  joined&&joined.home&&joined.away&&joined.home.success_rate===0.56&&joined.away.success_rate===0.42,joined);

const withEff=B.buildState(rows,2026,eff);
chk('the completed game is counted once in replay',withEff.absorbed===1,withEff);
chk('the same replay records one efficiency game and two team rows',
  withEff.efficiency_games_absorbed===1&&withEff.efficiency_team_rows_absorbed===2,withEff);
chk('efficiency freshness advances for both teams',
  withEff.st.effFresh&&withEff.st.effFresh.texastech>0&&withEff.st.effFresh.lsu>0,withEff.st.effFresh);
const p=E.strength.profile(withEff.st,'texastech',true);
chk('the team profile now says efficiency was updated this season',
  p.efficiency_is_seed===false&&p.efficiency.success_rate.available===true,
  {seed:p.efficiency_is_seed,success:p.efficiency.success_rate});

const noEff=B.buildState(rows,2026,null);
chk('missing play-level data never becomes fake efficiency',
  noEff.efficiency_games_absorbed===0
    && noEff.efficiency_missing_final_games.length===1
    && E.strength.profile(noEff.st,'texastech',true).efficiency_is_seed===true,
  noEff);

const late=E.newState();
E.ingest.seasonBreak(late);
const beforeRating=E.strength.rating(late,'texastech',true);
E.ingest.absorbEfficiencyGame(late,{
  home:'Texas Tech',away:'LSU',
  team_stats:{home:eff.games.G1.teams.texastech,away:eff.games.G1.teams.lsu}
});
chk('late efficiency-only replay marks current play data fresh',
  late.effFresh&&late.effFresh.texastech>0&&late.effFresh.lsu>0,late.effFresh);
chk('late efficiency-only replay never changes the score-based rating state',
  E.strength.rating(late,'texastech',true)===beforeRating
    && (late.absorbed||0)===0,
  {before:beforeRating,after:E.strength.rating(late,'texastech',true),absorbed:late.absorbed});

console.log((fail?'FAILED ':'ALL GREEN ')+pass+' passed, '+fail+' failed');
process.exit(fail?1:0);
