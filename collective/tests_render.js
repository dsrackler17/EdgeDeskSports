#!/usr/bin/env node
/* ===========================================================================
   EdgeDesk Model Collective — the record has to appear when the game ends.

   This file exists because of a Saturday. A college slate finished, the
   final scores were on screen, and the site showed a dash in every grade
   column, "0 SETTLED" on the wall, and "Nobody has cleared the minimums yet
   / 0 graded games" against every model on the rankings page. The unit
   suite in tests.js could not have caught it: every function it covers was
   correct. What was wrong was that nothing on the page ever asked.

   So this suite drives the REAL render functions — renderWall, renderBoard,
   renderRankings — against a stubbed API that reproduces exactly that
   state: finished games, final scores present, no server grades, empty
   ranking boards. Then it reads the HTML they produce and asserts the
   record is actually there. It is the regression test for the bug itself,
   not for the pieces underneath it.

   Offline, no dependencies, same DOM-shim approach as tests.js but with a
   shim rich enough to render into.

   Run:  node collective/tests_render.js
         node collective/tests.js          (the unit suite, run both)
   =========================================================================== */
'use strict';
var fs=require('fs'),path=require('path'),vm=require('vm');
var PAGE=path.join(__dirname,'index.html');
var html=fs.readFileSync(PAGE,'utf8');
var re=/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi,m,blocks=[];
while((m=re.exec(html))!==null)if(m[1].trim())blocks.push(m[1]);
var CODE=blocks.join('\n;\n');

var pass=0,fail=0,fails=[];
/* a thunk is evaluated here, in a try: an assertion must FAIL, never crash */
function chk(n,ok,d){
  if(typeof ok==='function'){try{ok=ok();}catch(e){ok=false;d={threw:String((e&&e.message)||e)};}}
  if(ok){pass++;return;}
  fail++;fails.push({n:n,d:d});
}

function G(id,away,home,hs,as,close,models){
  return {game_id:id,label:away+' @ '+home,home:home,away:away,week:1,season:2026,
    kickoff_at:'2026-08-29T16:00:00Z',
    result:(hs==null?null:{home_score:hs,away_score:as,closing_spread:close,closing_total:47.5}),
    consensus:{n:models.length,spread_mean:-12.2,spread_median:-13.6,spread_stdev:4.8,
               agreement:0.67,home_win_prob_mean:0.8,total_mean:49.4,pct_picks_home:0.75},
    models:models};
}
function M(cs,ms,side,spread,line,hw){
  return {creator_slug:cs,model_slug:ms,pick_side:side,projected_spread:spread,
    line_at_submission:line,home_win_probability:hw,projected_total:50.5,
    received_at:'2026-08-27T12:00:00Z',locked:false,late:false,grade:null};
}
var GAMES=[
  /* TCU -7.5 close; TCU wins 48-14 -> margin 34, home covers */
  G(1,'NORTHCAROL','TCU',48,14,-7.5,[
    M('mustbemoose','edgedesk-cfb-p4','home',-12.5,-12.5,0.78),
    M('blizzard-performance','cfb-model',null,-16.3,null,null),
    M('edgedesksports','edgedesk-cfb','home',-14.6,-6.5,0.82),
    M('blerm','blerm-s-model','away',-5.5,-8.5,null)]),
  /* USC -38.5 close; USC wins 59-28 -> margin 31, away covers */
  G(2,'SANJOSESTA','USC',59,28,-38.5,[
    M('mustbemoose','edgedesk-cfb-p4','home',-32,-32,0.96),
    M('blizzard-performance','cfb-model',null,-27.6,null,null),
    M('edgedesksports','edgedesk-cfb','away',-34.6,-38.5,0.99),
    M('blerm','blerm-s-model','away',-26.5,-38.5,null)]),
  /* VIRGINIA -5.5 close; NCSTATE wins 24-21 -> margin -3, away covers */
  G(3,'NCSTATE','VIRGINIA',21,24,-5.5,[
    M('mustbemoose','edgedesk-cfb-p4','home',-2,-2,0.55),
    M('blizzard-performance','cfb-model',null,-5.5,null,null),
    M('edgedesksports','edgedesk-cfb','away',-5.4,-5.5,0.63),
    M('blerm','blerm-s-model','away',0.5,-4,null)])
];
var WALL=[
  {creator_slug:'mustbemoose',creator_name:'Must Be Moose',model_slug:'edgedesk-cfb-p4',
   model_name:'MustBeMoose College Football',sport:'CFB',membership:'ACTIVE CONTRIBUTOR',
   founding:true,record:null,coverage_pct:100,last_submission_at:'2026-08-27T12:00:00Z',monogram:'MM'},
  {creator_slug:'blizzard-performance',creator_name:'Blizzard Performance',model_slug:'cfb-model',
   model_name:'CFB MODEL',sport:'CFB',membership:'ACTIVE CONTRIBUTOR',
   record:null,coverage_pct:100,last_submission_at:'2026-08-28T12:00:00Z',monogram:'BP'},
  {creator_slug:'edgedesksports',creator_name:'EdgeDesk Sports',model_slug:'edgedesk-cfb',
   model_name:'EdgeDesk Model',sport:'CFB',membership:'ACTIVE CONTRIBUTOR',
   record:null,coverage_pct:100,last_submission_at:'2026-08-28T12:00:00Z',monogram:'ED'},
  {creator_slug:'blerm',creator_name:'Blerm',model_slug:'blerm-s-model',
   model_name:"Blerm's Model",sport:'CFB',membership:'ACTIVE CONTRIBUTOR',
   record:null,coverage_pct:100,last_submission_at:'2026-08-29T02:00:00Z',monogram:'BL'}
];
var RANKINGS={thresholds:{min_graded_games:20,min_coverage_pct:60},
  boards:{win_pct:[],margin_mae:[],brier:[]},
  unranked:WALL.map(function(r){return {creator_slug:r.creator_slug,model_name:r.model_name,
    reason:'0 graded games is below the 20 minimum'};})};

function reply(body){return Promise.resolve({ok:true,status:200,json:function(){return Promise.resolve(body);}});}
var CALLS=[];
function fakeFetch(url){
  CALLS.push(url);
  var u=String(url);
  if(u.indexOf('/v1/meta')>=0)return reply({sports:[{code:'CFB',season:2026,in_season:true}],
    counts:{live_projections:351,graded_games:0},pricing:{monthly_cents:2900,annual_cents:0},
    billing_live:false});
  if(u.indexOf('/v1/wall')>=0)return reply({rows:WALL});
  if(u.indexOf('/v1/activity')>=0)return reply({rows:[]});
  if(u.indexOf('/v1/rankings')>=0)return reply(RANKINGS);
  if(u.indexOf('/v1/models/')>=0){
    var parts=u.split('/v1/models/')[1].split('?')[0].split('/');
    var wr=WALL.filter(function(x){return x.creator_slug===parts[0];})[0]||WALL[0];
    return reply({creator:{slug:wr.creator_slug,display_name:wr.creator_name,founding:!!wr.founding},
      model:{model_slug:wr.model_slug,model_name:wr.model_name,sport:'CFB',description:null},
      record:null,recent_graded:[],coverage:[],coverage_pct:100});
  }
  if(u.indexOf('/v1/games')>=0){
    var wk=/[?&]week=(\d+)/.exec(u);
    if(wk&&wk[1]!=='1')return reply({games:[],week:+wk[1],entitled:true});
    return reply({games:GAMES,week:1,entitled:true});
  }
  return reply({});
}

/* ---- a DOM shim good enough to render into --------------------------- */
function node(){
  var n={_html:'',value:'',textContent:'',disabled:false,style:{},children:[],
    classList:{add:function(){},remove:function(){},contains:function(){return false;},toggle:function(){}},
    getAttribute:function(k){return n['_attr_'+k]||null;},
    setAttribute:function(k,v){n['_attr_'+k]=v;},
    appendChild:function(){},removeChild:function(){},remove:function(){},
    addEventListener:function(){},removeEventListener:function(){},
    querySelector:function(){return node();},querySelectorAll:function(){return [];},
    focus:function(){},click:function(){},scrollIntoView:function(){},
    onclick:null,onchange:null,oninput:null};
  Object.defineProperty(n,'innerHTML',{get:function(){return n._html;},set:function(v){n._html=String(v);}});
  Object.defineProperty(n,'firstChild',{get:function(){return node();}});
  return n;
}
var VIEW=node(),ELS={view:VIEW};
var sandbox={
  console:console,
  setTimeout:function(f){return 0;},clearTimeout:function(){},
  setInterval:function(){return 1;},clearInterval:function(){},
  fetch:fakeFetch,
  localStorage:{_d:{mc_sport:'CFB'},getItem:function(k){return this._d[k]===undefined?null:this._d[k];},
    setItem:function(k,v){this._d[k]=v;},removeItem:function(k){delete this._d[k];}},
  sessionStorage:{getItem:function(){return null;},setItem:function(){}},
  location:{hash:'',href:'http://localhost/collective/',search:'',pathname:'/collective/',
    origin:'http://localhost',replace:function(){},assign:function(){}},
  history:{replaceState:function(){},pushState:function(){}},
  navigator:{userAgent:'node',clipboard:{writeText:function(){}}},
  document:{
    getElementById:function(id){if(!ELS[id])ELS[id]=node();return ELS[id];},
    querySelector:function(){return node();},
    querySelectorAll:function(){return [];},
    createElement:function(){return node();},
    addEventListener:function(){},removeEventListener:function(){},
    body:node(),head:node(),title:'',cookie:'',hidden:false},
  atob:function(s){return Buffer.from(s,'base64').toString('binary');},
  btoa:function(s){return Buffer.from(s,'binary').toString('base64');},
  URL:URL,URLSearchParams:URLSearchParams,TextEncoder:TextEncoder,TextDecoder:TextDecoder,
  AbortController:AbortController,Headers:typeof Headers!=='undefined'?Headers:function(){},
  Promise:Promise,JSON:JSON,Math:Math,Date:Date,RegExp:RegExp,Intl:Intl,
  performance:{now:function(){return 0;}},
  crypto:{getRandomValues:function(a){return a;},randomUUID:function(){return 'x';}}
};
sandbox.window=sandbox;sandbox.globalThis=sandbox;
sandbox.addEventListener=function(){};sandbox.removeEventListener=function(){};
sandbox.dispatchEvent=function(){return true;};
sandbox.matchMedia=function(){return {matches:false,addListener:function(){},addEventListener:function(){}};};
sandbox.getComputedStyle=function(){return {getPropertyValue:function(){return '';}};};
sandbox.scrollTo=function(){};sandbox.scrollY=0;
sandbox.requestAnimationFrame=function(){return 0;};
sandbox.alert=function(){};sandbox.confirm=function(){return false;};
vm.createContext(sandbox);
try{vm.runInContext(CODE,sandbox,{timeout:20000});}
catch(e){console.log('[boot] '+e.message);}

var S=sandbox;
(async function(){
  /* ---- THE WALL ---- */
  var v=node();
  await S.renderWall(v);
  await new Promise(function(r){setTimeout(r,50);});   /* let the season sweep land */
  var wall=v.innerHTML;
  chk('the wall no longer reports zero settled games',
    /<b>3<\/b> settled/.test(wall), {got:(/(<b>\d+<\/b> settled)/.exec(wall)||[])[1]});
  chk('the wall colours a graded row green or red, not by membership',
    wall.indexOf('var(--pos)')>=0 && wall.indexOf('var(--neg)')>=0);
  chk('a graded dot says what it graded, in its title',
    /title="WIN &#8212; graded|title="WIN — graded|WIN/.test(wall));
  chk('the model directory shows a record instead of "awaiting results"',
    wall.indexOf('awaiting results')<0, {sample:wall.slice(wall.indexOf('walltbl'),wall.indexOf('walltbl')+900)});
  chk('the directory marks the records this page graded',
    (wall.match(/class="pgrade"/g)||[]).length>=4);

  /* ---- THE BOARD ---- */
  S.location.hash='#board';
  var b=node();
  await S.renderBoard(b);
  var board=b.innerHTML;
  chk('the board grades every finished game',
    (board.match(/class="mono grade-(win|loss|push)"/g)||[]).length>=9,
    {n:(board.match(/class="mono grade-/g)||[]).length});
  chk('the board grades the consensus row too',
    board.indexOf('consrow')>=0 && (board.match(/grade-(win|loss)/g)||[]).length>9);
  chk('the board never prints a grade class the stylesheet has no rule for',
    !/grade-(?!win|loss|push)/.test(board));
  chk('a graded row still shows its margin error and brier',
    /err \d/.test(board) && /brier \d/.test(board));
  /* Not just "some grades appeared" — the RIGHT ones. TCU closed -7.5 and
     won by 34, so the home side covered; USC closed -38.5 and won by 31, so
     the road side did. Every model is graded on the side it named, against
     the Collective's captured close and nothing else. */
  chk('the side that covered wins and the side that did not loses',
    (function(){
      var g=GAMES[0];
      return S.rowGrade(g,g.models[0]).pick_result==='win'      /* picked TCU  */
        && S.rowGrade(g,g.models[2]).pick_result==='win'        /* picked TCU  */
        && S.rowGrade(g,g.models[3]).pick_result==='loss'       /* picked UNC  */
        && S.rowGrade(g,g.models[1])!==null                     /* no pick side, still margin-graded */
        && S.rowGrade(g,g.models[1]).pick_result===null;
    })());
  chk('a favourite that wins by less than the number does NOT cover',
    (function(){
      var g=GAMES[1];
      return S.rowGrade(g,g.models[0]).pick_result==='loss'     /* picked USC -38.5 */
        && S.rowGrade(g,g.models[2]).pick_result==='win'        /* picked SJSU      */
        && S.rowGrade(g,g.models[3]).pick_result==='win';
    })(), 'USC won by 31 on a 38.5 line');
  chk('an outright upset grades the road side a winner',
    (function(){
      var g=GAMES[2];
      return S.rowGrade(g,g.models[0]).pick_result==='loss'
        && S.rowGrade(g,g.models[2]).pick_result==='win';
    })());
  /* The whole point of one shared closing line: a model that posted at its
     own better number is graded on the Collective's, not on the one it
     picked at. Driven through the real grader, not through atsResult --
     grading on line_at_submission is a one-word change inside localGrade
     and the arithmetic below is identical either way, so only the grader
     itself can tell the two apart. */
  chk('the page grades against the CAPTURED close, not the line a model posted',
    function(){
      var g=G(99,'AWAY','HOME',27,20,-7.5,[
        M('c','m','home',-9,-6.5,0.7)]);       /* posted at -6.5, close -7.5 */
      var gr=S.rowGrade(g,g.models[0]);
      return gr.pick_result==='loss'
        && S.atsResult(7,-6.5,'home')==='win';  /* its own number would have covered */
    },
    'a 7-point win covers -6.5 and does not cover -7.5');

  /* ---- THE RANKINGS ---- */
  S.location.hash='#rankings';
  var r=node();
  await S.renderRankings(r);
  var rank=r.innerHTML;
  chk('the ranked boards still enforce the published minimums',
    (rank.match(/Nobody has cleared the minimums yet/g)||[]).length===3,
    'three graded games must not become a rank');
  chk('every model is tracked in the live standings',
    rank.indexOf('Live standings')>=0
      && rank.indexOf('Must Be Moose')>=0 && rank.indexOf('Blerm')>=0
      && rank.indexOf('EdgeDesk Model')>=0 && rank.indexOf('CFB MODEL')>=0);
  chk('the standings carry a real record, not zeroes',
    /<td class="num mono">[1-9]-\d-\d<\/td>/.test(rank),
    {rows:(rank.match(/<td class="num mono">\d-\d-\d<\/td>/g)||[])});
  chk('"not yet ranked" counts the games that were played, not zero',
    rank.indexOf('0 graded games is below')<0 && /graded games? is below the 20 minimum/.test(rank),
    {reasons:(rank.match(/\d+ graded games? is below[^<]*/g)||[])});
  chk('the Collective grades itself as one model too',
    rank.indexOf('The Collective as one model')>=0);

  /* ---- the live refresh notices a score and redraws ---- */
  S.location.hash='';
  await S.liveTick();                       /* baseline */
  var before=S.LIVE_FP;
  chk('the first tick only takes a baseline', before!=null);
  var quiet=CALLS.length;
  await S.liveTick();
  chk('an unchanged slate causes no redraw', S.LIVE_FP===before);
  GAMES.push(G(4,'IOWA','IOWASTATE',31,28,-3.5,[M('blerm','blerm-s-model','home',-6,-3.5,0.6)]));
  await S.liveTick();
  chk('a game finishing changes the fingerprint and drops the caches',
    S.LIVE_FP!==before && Object.keys(S.SEASON_GAMES).length===0);

  /* ---- the normal path must not regress -------------------------------
     Everything above is the page standing in for a settlement run that is
     behind. When the run is NOT behind, its grades are the record and the
     page must show them untouched and unmarked. */
  S.SEASON_GAMES={};S.LOCALREC={};S.META=null;S.WALLC=null;
  GAMES.length=3;
  GAMES[0].models[0].grade={pick_result:'loss',margin_error:9.9,brier:0.99};
  S.location.hash='#board';
  var b2=node();
  await S.renderBoard(b2);
  var board2=b2.innerHTML;
  chk('a settled grade is shown exactly as the Collective published it',
    board2.indexOf('err 9.9')>=0 && board2.indexOf('brier 0.990')>=0
      && /grade-loss/.test(board2),
    'the page recomputed win for this row and must not have used it');
  chk('a settled grade carries no live marker',
    (function(){
      var i=board2.indexOf('err 9.9');
      return board2.slice(Math.max(0,i-400),i).indexOf('pgrade')<0;
    })());
  chk('the rest of the slate is still graded by the page beside it',
    board2.indexOf('pgrade')>=0);
  GAMES[0].models[0].grade=null;

  /* ---- a finished game the Collective captured no close for ------------ */
  S.SEASON_GAMES={};S.LOCALREC={};
  var noClose=G(9,'A','B',30,20,null,[M('blerm','blerm-s-model','home',-12.5,null,0.8)]);
  chk('no captured close means no win, no loss, and no push',
    (function(){
      var gr=S.rowGrade(noClose,noClose.models[0]);
      return gr && gr.pick_result===null && gr.margin_error!=null && gr.brier!=null;
    })(),
    'grading it against the model own posted line would be self-reporting');
  chk('and it is counted by nobody rather than counted as a loss',
    (function(){
      var rec=S.modelRecord([noClose],'blerm','blerm-s-model');
      return rec.graded===0 && rec.losses===0 && rec.margin_n===1 && rec.brier_n===1;
    })());

  /* ---- the API being unreachable must not blank the page --------------- */
  S.SEASON_GAMES={};S.LOCALREC={};S.META=null;S.WALLC=null;
  var realFetch=S.fetch;
  S.fetch=function(u){
    if(String(u).indexOf('/v1/games')>=0)
      return Promise.resolve({ok:false,status:503,json:function(){return Promise.resolve({});}});
    return realFetch(u);
  };
  S.location.hash='';
  var v3=node();
  await S.renderWall(v3);
  chk('the wall still renders when the games endpoint is down',
    v3.innerHTML.indexOf('LIVE MODEL WALL')>=0 && v3.innerHTML.indexOf('Must Be Moose')>=0);
  S.location.hash='#rankings';
  var r3=node();
  await S.renderRankings(r3);
  chk('the rankings still render when the games endpoint is down',
    r3.innerHTML.indexOf('Rankings')>=0 && r3.innerHTML.indexOf('could not load')<0);
  S.fetch=function(u){
    if(String(u).indexOf('/v1/rankings')>=0)
      return Promise.resolve({ok:false,status:503,json:function(){return Promise.resolve({});}});
    return realFetch(u);
  };
  S.SEASON_GAMES={};S.LOCALREC={};
  var r4=node();
  await S.renderRankings(r4);
  chk('the rankings endpoint being down is no longer an error page',
    r4.innerHTML.indexOf('Live standings')>=0 && r4.innerHTML.indexOf('Must Be Moose')>=0,
    'the page can compute those boards itself now');
  S.fetch=realFetch;

  /* ---- the directory sorts the record it is SHOWING -------------------
     Sorting on the server's record while displaying the page's meant "sort
     by Win %" did nothing at all to a column full of numbers. */
  S.SEASON_GAMES={};S.LOCALREC={};S.META=null;S.WALLC=null;
  S.location.hash='';
  S.WALL_SORT='win_pct';
  var v4=node();
  await S.renderWall(v4);
  await new Promise(function(r){setTimeout(r,50);});
  chk('sorting the directory by win % actually reorders it',
    function(){
      var html=v4.innerHTML, body=html.slice(html.indexOf('<tbody>'));
      var pcts=(body.match(/<td class="num">(\d+\.\d)%<\/td>/g)||[])
        .map(function(x){return parseFloat(/([\d.]+)%/.exec(x)[1]);});
      if(pcts.length<2)return false;
      for(var i=1;i<pcts.length;i++)if(pcts[i]>pcts[i-1])return false;
      return true;
    },
    'best win % first, computed from the same record the cells print');
  S.WALL_SORT='canonical';

  /* ---- the compare page must not draw a push that never happened ------
     blizzard-performance posts a spread on every game and NO pick side, so
     it has three graded games and not one against-the-spread result. The
     old strip mapped anything that was not a win or a loss to 'p' and drew
     it three pushes it never got. */
  S.SEASON_GAMES={};S.LOCALREC={};
  S.PERF.a='blizzard-performance/cfb-model';S.PERF.b='blerm/blerm-s-model';
  S.location.hash='#performance';
  var v5=node();
  await S.renderPerformance(v5);
  await new Promise(function(r){setTimeout(r,80);});
  var perf=(S.document.getElementById('pfOut')||{innerHTML:''}).innerHTML||'';
  chk('a model with no ATS result gets no form strip at all',
    function(){
      /* it IS graded — three margin errors — it just has no win/loss/push */
      var log=S.localGameLog(GAMES,'blizzard-performance','cfb-model');
      return log.length===3
        && log.every(function(g){return g.pick_result===null;})
        && perf.indexOf('<i class="p">')<0;
    },
    {drew:(perf.match(/<i class="[wlp]">/g)||[]),label:(/Last (\d+) graded/.exec(perf)||[])[0]});
  chk('the "Last N graded" label counts exactly the marks beside it',
    function(){
      var lab=/Last (\d+) graded/.exec(perf);
      var marks=(perf.match(/<i class="[wlp]">/g)||[]).length;
      if(!lab)return marks===0;
      return marks===+lab[1];
    },
    {perf:perf.slice(0,300)});

  fails.forEach(function(f){console.log('FAIL | '+f.n+(f.d?'  '+JSON.stringify(f.d).slice(0,400):''));});
  console.log((fail===0?'ALL GREEN ':'FAILED ')+pass+' passed, '+fail+' failed');
  process.exit(fail===0?0:1);
})().catch(function(e){console.log('CRASHED: '+(e&&e.stack||e));process.exit(1);});
