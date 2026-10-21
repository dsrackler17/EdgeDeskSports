const fs=require('fs');const ROOT=require('path').resolve(__dirname,'../../../..');
global.EDFootballParams=require(ROOT+'/football/params.js');const E=require(ROOT+'/football/engine.js');
function csv(t){const L=t.split(/\r?\n/).filter(Boolean);const h=L[0].split(',');return L.slice(1).map(l=>{const c=[];let cur='',q=false;for(const ch of l){if(ch==='"')q=!q;else if(ch===','&&!q){c.push(cur);cur='';}else cur+=ch;}c.push(cur);const o={};h.forEach((k,i)=>o[k]=c[i]===''||c[i]==='NA'?null:c[i]);return o;});}
const num=x=>(x==null||x===''?null:(isFinite(+x)?+x:null));
const games=csv(fs.readFileSync(process.env.NFL_GAMES_CSV || '.cache/model_loop/nfl/raw/games.csv','utf8'));const stw=csv(fs.readFileSync(ROOT+'/football/nfl/stats_team_week_2026.csv','utf8'));
const byGame={};stw.forEach(x=>(byGame[x.game_id]=byGame[x.game_id]||[]).push(x));
const MIR={off_epa_play:'def_epa_play',pass_epa_db:'def_pass_epa_db',rush_epa_att:'def_rush_epa_att',expl_pass:'def_expl_pass',expl_rush:'def_expl_rush',sack_rate_all:'sack_rate_made'};
function run(fixDef){const st=E.nfl.newState();E.nfl.seasonBreak(st);
 const rows=games.filter(r=>num(r.season)===2026).sort((a,b)=>String(a.gameday).localeCompare(String(b.gameday))||String(a.game_id).localeCompare(String(b.game_id)));
 const out=[];
 for(const g of rows){const rq={home:g.home_team,away:g.away_team,week:num(g.week),home_rest:num(g.home_rest),away_rest:num(g.away_rest),roof:g.roof,surface:g.surface,div_game:num(g.div_game),temp:num(g.temp),wind:num(g.wind),home_qb_id:g.home_qb_id,away_qb_id:g.away_qb_id,neutral:g.location==='Neutral'};
  const pr=E.nfl.predict(st,rq);
  if(g.home_score!=null&&g.spread_line!=null)out.push({id:g.game_id,wk:num(g.week),m:pr.model_spread,close:num(g.spread_line),res:num(g.result)});
  if(g.home_score==null)continue;const pair=byGame[g.game_id];if(!pair||pair.length!==2)continue;
  const h=pair.find(x=>x.team===g.home_team),a=pair.find(x=>x.team===g.away_team);
  const hr=E.nfl.teamGameFromStw(h),ar=E.nfl.teamGameFromStw(a);
  if(fixDef){for(const k in MIR){hr[MIR[k]]=ar[k];ar[MIR[k]]=hr[k];}}
  hr.pts_for=num(g.home_score);hr.pts_against=num(g.away_score);ar.pts_for=num(g.away_score);ar.pts_against=num(g.home_score);
  E.nfl.absorbGame(st,[[g.home_team,hr],[g.away_team,ar]],[]);}
 return out;}
for(const fix of [false,true]){const o=run(fix).filter(r=>r.wk>=2);const n=o.length;
 const mae=o.reduce((s,r)=>s+Math.abs(r.res-r.m),0)/n, cmae=o.reduce((s,r)=>s+Math.abs(r.res-r.close),0)/n, gap=o.reduce((s,r)=>s+Math.abs(r.m-r.close),0)/n;
 console.log(fix?'DEFENSE MIRRORED':'AS SHIPPED     ','n',n,'model MAE',mae.toFixed(2),'close MAE',cmae.toFixed(2),'mean|model-close|',gap.toFixed(2),'>=3pt',o.filter(r=>Math.abs(r.m-r.close)>=3).length);}
