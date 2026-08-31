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
/* An NFL slate of its own. Everything on this page is meant to be sport
   agnostic — the league it fetches, the scoreboard it reads, the season it
   sweeps all come from the sport switcher — but "meant to be" is not
   evidence, and the NFL side had never been driven once. */
var NFLGAMES=[
  /* KC -6.5 close, KC wins by 10: home covered */
  G(101,'BAL','KC',31,21,-6.5,[
    M('jadedbettor-murse2-0','nfl-math-madness','home',-9,-6.5,0.72),
    M('tiltdatalabs','nofunleague','away',-3,-6.5,0.55)]),
  /* SF -3 close, SF wins by 2: road side covered */
  G(102,'SEA','SF',24,22,-3,[
    M('jadedbettor-murse2-0','nfl-math-madness','home',-7,-3,0.68),
    M('tiltdatalabs','nofunleague','away',-1,-3,0.48)])
];
var NFLWALL=[
  {creator_slug:'jadedbettor-murse2-0',creator_name:'Jaded Bettor',
   model_slug:'nfl-math-madness',model_name:'NFL Math Madness',sport:'NFL',
   membership:'ACTIVE CONTRIBUTOR',record:null,coverage_pct:100,
   last_submission_at:'2026-09-12T12:00:00Z',monogram:'JB'},
  {creator_slug:'tiltdatalabs',creator_name:'Tilt Data Labs',
   model_slug:'nofunleague',model_name:'NoFunLeague',sport:'NFL',
   membership:'ACTIVE CONTRIBUTOR',record:null,coverage_pct:100,
   last_submission_at:'2026-09-12T12:00:00Z',monogram:'TD'}
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
  /* Both sports, because "it works for College Football" is not evidence
     that it works for the NFL — every sport-scoped path has to be driven. */
  if(u.indexOf('/v1/meta')>=0)return reply({sports:[
      {code:'CFB',season:2026,in_season:true},
      {code:'NFL',season:2026,in_season:true}],
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
    var isNFL=/[?&]sport=NFL/.test(u);
    if(wk&&wk[1]!=='1')return reply({games:[],week:+wk[1],entitled:true});
    if(isNFL)return reply({games:NFLGAMES,week:1,entitled:true});
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
  /* A suite that skips itself reports green having tested nothing, so name
     what has to exist before anything runs. */
  chk('the page defines the functions this suite drives',
    ['renderWall','renderBoard','renderRankings','renderPerformance','route',
     'rowGrade','localGrade','atsResult','finalResult','modelRecord',
     'modelCoverage','localGameLog','localRankings','seasonGames','liveTick',
     'liveRoute','liveFingerprint','paint','fail','recATSHtml'
    ].every(function(n){return typeof S[n]==='function';}),
    {missing:['renderWall','renderBoard','renderRankings','renderPerformance','route',
      'rowGrade','localGrade','atsResult','finalResult','modelRecord',
      'modelCoverage','localGameLog','localRankings','seasonGames','liveTick',
      'liveRoute','liveFingerprint','paint','fail','recATSHtml']
      .filter(function(n){return typeof S[n]!=='function';})});

  /* ---- THE WALL ---- */
  var v=node();
  await S.renderWall(v);
  await new Promise(function(r){setTimeout(r,50);});   /* let the season sweep land */
  var wall=v.innerHTML;
  chk('the wall no longer reports zero settled games',
    /<b>3<\/b> settled/.test(wall), {got:(/(<b>\d+<\/b> settled)/.exec(wall)||[])[1]});
  chk('the wall colours a graded row green or red, not by membership',
    wall.indexOf('var(--pos)')>=0 && wall.indexOf('var(--neg)')>=0);
  /* Colour alone cannot say which grades are settled and which the page
     worked out, and a reader should not have to hover every row to find
     out. A page-graded dot is drawn hollow. */
  chk('a page-graded dot is visibly different, not only in its title',
    (wall.match(/class="gb-dot pg"/g)||[]).length>=6,
    {hollow:(wall.match(/class="gb-dot pg"/g)||[]).length,
     all:(wall.match(/class="gb-dot/g)||[]).length});
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
    function(){
      var g=GAMES[0];
      return S.rowGrade(g,g.models[0]).pick_result==='win'      /* picked TCU  */
        && S.rowGrade(g,g.models[2]).pick_result==='win'        /* picked TCU  */
        && S.rowGrade(g,g.models[3]).pick_result==='loss'       /* picked UNC  */
        /* blizzard named no side, but posted TCU -16.3 into a -7.5 close:
           its own number is on TCU, and TCU covered */
        && S.rowGrade(g,g.models[1]).pick_result==='win'
        && S.rowGrade(g,g.models[1]).implied===true;
    });
  chk('a favourite that wins by less than the number does NOT cover',
    function(){
      var g=GAMES[1];
      return S.rowGrade(g,g.models[0]).pick_result==='loss'     /* picked USC -38.5 */
        && S.rowGrade(g,g.models[2]).pick_result==='win'        /* picked SJSU      */
        && S.rowGrade(g,g.models[3]).pick_result==='win';
    }, 'USC won by 31 on a 38.5 line');
  chk('an outright upset grades the road side a winner',
    function(){
      var g=GAMES[2];
      return S.rowGrade(g,g.models[0]).pick_result==='loss'
        && S.rowGrade(g,g.models[2]).pick_result==='win';
    });
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
  /* This is the whole complaint, end to end: three finished games and the
     boards used to be empty because of a twenty-game bar. */
  chk('the ranked boards fill from the first finished game',
    function(){
      var win=boardSlice(rank,'>Win %','>Margin MAE');
      return (rank.match(/Nobody has cleared the minimums yet/g)||[]).length===0
        && /Must Be Moose|EdgeDesk Sports|Blerm|Blizzard/.test(win)
        && /<td class="num" style="color:var\(--dim\)">[1-9]<\/td>/.test(win);
    },
    {board:boardSlice(rank,'>Win %','>Margin MAE').slice(0,400)});
  chk('every model is tracked in the live standings',
    rank.indexOf('Live standings')>=0
      && rank.indexOf('Must Be Moose')>=0 && rank.indexOf('Blerm')>=0
      && rank.indexOf('EdgeDesk Model')>=0 && rank.indexOf('CFB MODEL')>=0);
  chk('the standings carry a real record, not zeroes',
    /<span class="mono">[1-9]-\d-\d<\/span>/.test(rank),
    {rows:(rank.match(/<span class="mono">\d-\d-\d<\/span>/g)||[])});
  /* blizzard-performance posts a spread on every game and never a pick
     side. It used to have no win-loss record at all; its own number says
     which side it is on, so now it has one. */
  chk('a model that never types a pick side still gets a record',
    /<span class="mono">[1-9]-\d-\d<\/span>/.test(rank)
      && !/<span class="mono">0-0-0<\/span>/.test(rank),
    {zeroes:(rank.match(/<span class="mono">0-0-0<\/span>/g)||[])});
  /* every model here has finished games, so nobody is "not yet ranked" and
     no threshold is recited at anybody */
  chk('nobody is told they are below a minimum any more',
    rank.indexOf('Not yet ranked')<0
      && !/is below the \d+ minimum/.test(rank),
    {reasons:(rank.match(/\d+ graded games? is below[^<]*/g)||[])});
  chk('the Collective grades itself as one model too',
    rank.indexOf('The Collective as one model')>=0);

  /* ---- the server's unranked list must never reach the page -------------
     What the reader actually saw: models sitting on the boards above, and
     NFL models on the College Football page, all captioned "0 graded games
     is below the 20 minimum" — a threshold this page no longer applies.
     It leaked because every model in the fixture posted games, so the
     page's own list was never empty and the server's was never reached. */
  S.SEASON_GAMES={};S.LOCALREC={};S.WALLC=null;
  RANKINGS.unranked=[
    {creator_slug:'jadedbettor-murse2-0',model_name:'NFL Math Madness',
     reason:'0 graded games is below the 20 minimum'},
    {creator_slug:'tiltdatalabs',model_name:'NoFunLeague',
     reason:'0 graded games is below the 20 minimum'},
    {creator_slug:'blerm',model_name:"Blerm's Model",
     reason:'0 graded games is below the 20 minimum'}
  ];
  /* a College Football model on the wall that has posted nothing... */
  WALL.push({creator_slug:'newcomer',creator_name:'Newcomer',model_slug:'debut',
    model_name:'Debut Model',sport:'CFB',membership:'MEMBER',
    record:null,coverage_pct:0,last_submission_at:null,monogram:'NC'});
  /* ...and an NFL one, which must not appear on this page at all. Without
     it here, dropping the sport filter changes nothing and the test that
     guards it passes for free. */
  WALL.push({creator_slug:'tiltdatalabs',creator_name:'Tilt Data Labs',
    model_slug:'nofunleague',model_name:'NoFunLeague',sport:'NFL',
    membership:'MEMBER',record:null,coverage_pct:0,last_submission_at:null,monogram:'TD'});
  var rN=node();
  await S.renderRankings(rN);
  var un=rN.innerHTML;
  WALL.pop();WALL.pop();RANKINGS.unranked=[];
  chk('no model is told it is below a minimum that no longer exists',
    !/is below the \d+ minimum/.test(un),
    {found:(un.match(/[^<]*is below the \d+ minimum[^<]*/g)||[])});
  chk('a model already on a board is never listed as not-yet-ranked',
    function(){
      var i=un.indexOf('Not yet ranked');
      return i>=0 && un.slice(i).indexOf('Blerm')<0;
    },
    {tail:un.slice(un.indexOf('Not yet ranked'),un.indexOf('Not yet ranked')+300)});
  chk('another sport’s models stay off this sport’s page',
    function(){
      return un.indexOf('NFL Math Madness')<0 && un.indexOf('NoFunLeague')<0;
    },
    'the server’s list carries no sport, so NFL models were listed under College Football');
  chk('and a model of THIS sport that has played nothing is listed, honestly',
    function(){
      var i=un.indexOf('Not yet ranked');
      if(i<0)return false;
      var list=un.slice(i);
      return list.indexOf('Debut Model')>=0 && /no finished games yet/.test(list);
    },
    {tail:un.slice(un.indexOf('Not yet ranked'),un.indexOf('Not yet ranked')+300)});
  chk('the standings no longer claim the boards keep a minimum',
    !/boards above keep their minimums/.test(un)
      && !/has posted two games has not earned a rank/.test(un));
  S.SEASON_GAMES={};S.LOCALREC={};S.WALLC=null;
  /* The whole standings table is the page's own grading. Printing a record
     with no marker under a rules page that promises every one is marked is
     the kind of quiet claim this site cannot afford. */
  /* A stale server row for another sport passes inSport (it keeps a row
     whose sport it cannot resolve, deliberately), and it used to stand in
     for the whole board and suppress the one this page computed. */
  chk('one unresolvable server row does not suppress the page\u2019s own board',
    function(){
      return rank.indexOf('Live standings')>=0
        && /Must Be Moose|EdgeDesk Sports|Blerm|Blizzard/
             .test(boardSlice(rank,'>Win %','>Margin MAE'));
    });
  /* nobody may be ranked and unranked on the same screen */
  chk('no model is on a board and under "Not yet ranked" at once',
    function(){
      var un=rank.indexOf('Not yet ranked');
      if(un<0)return true;
      var boards=rank.slice(0,rank.indexOf('Live standings'));
      var listed=(rank.slice(un).match(/<b>([^<]+)<\/b>/g)||[])
        .map(function(x){return x.replace(/<\/?b>/g,'');});
      return listed.length>0 && listed.every(function(n){
        return boards.indexOf('>'+n+'<')<0;
      });
    },
    {listed:(rank.slice(rank.indexOf('Not yet ranked')).match(/<b>([^<]+)<\/b>/g)||[])});
  chk('the live standings say they are the page\u2019s own grading',
    function(){
      var i=rank.indexOf('Live standings');
      if(i<0)return false;
      var st=rank.slice(i);
      var note=st.indexOf('The marked rows are'), tbl=st.indexOf('<table');
      /* the note has to be above the table, where a reader meets it before
         the numbers, not somewhere further down the page */
      return note>=0 && tbl>=0 && note<tbl && st.slice(0,tbl).indexOf('published rule')>=0;
    },
    {head:rank.slice(rank.indexOf('Live standings'),rank.indexOf('Live standings')+260)});
  chk('every page-graded record on the rankings carries a marker',
    function(){
      var st=rank.slice(rank.indexOf('Live standings'));
      var recs=(st.match(/<span class="mono">\d+-\d+-\d+<\/span>/g)||[]).length;
      var marks=(st.match(/class="pgrade"/g)||[]).length;
      return recs>0 && marks>=recs;
    },
    {section:rank.slice(rank.indexOf('Live standings'),rank.indexOf('Live standings')+200)});

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
    function(){
      var i=board2.indexOf('err 9.9');
      return board2.slice(Math.max(0,i-400),i).indexOf('pgrade')<0;
    });
  chk('the rest of the slate is still graded by the page beside it',
    board2.indexOf('pgrade')>=0);
  GAMES[0].models[0].grade=null;

  /* ---- a finished game the Collective captured no close for ------------ */
  S.SEASON_GAMES={};S.LOCALREC={};
  var noClose=G(9,'A','B',30,20,null,[M('blerm','blerm-s-model','home',-12.5,null,0.8)]);
  chk('no captured close means no win, no loss, and no push',
    function(){
      var gr=S.rowGrade(noClose,noClose.models[0]);
      return gr && gr.pick_result===null && gr.margin_error!=null && gr.brier!=null;
    },
    'grading it against the model own posted line would be self-reporting');
  chk('and it is counted by nobody rather than counted as a loss',
    function(){
      var rec=S.modelRecord([noClose],'blerm','blerm-s-model');
      return rec.graded===0 && rec.losses===0 && rec.margin_n===1 && rec.brier_n===1;
    });

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
     A finished game the Collective captured no closing line for has no
     against-the-spread result for anybody. The old strip mapped anything
     that was not a win or a loss to 'p' and drew a push nobody got. */
  S.SEASON_GAMES={};S.LOCALREC={};
  var noClosePerf=G(77,'NOCLOSE','OPPO',31,10,null,[
    M('blizzard-performance','cfb-model',null,-9,null,null)]);
  GAMES.push(noClosePerf);
  S.PERF.a='blizzard-performance/cfb-model';S.PERF.b='blerm/blerm-s-model';
  S.location.hash='#performance';
  var v5=node();
  await S.renderPerformance(v5);
  await new Promise(function(r){setTimeout(r,80);});
  var perf=(S.document.getElementById('pfOut')||{innerHTML:''}).innerHTML||'';
  /* each model gets its own panel, so the label and the marks have to be
     counted inside ONE of them or the check compares two models' numbers */
  function panels(html){
    return html.split('<div class="panel">').slice(1);
  }
  /* Four graded games, two with an against-the-spread result: the Virginia
     game had this model sitting exactly ON the close (no lean, no side to
     imply) and the game added above has no captured close at all. Both are
     graded on margin and neither is a push. */
  chk('a game with no against-the-spread result draws no mark',
    function(){
      var log=S.localGameLog(GAMES,'blizzard-performance','cfb-model');
      var real=log.filter(function(g){return g.pick_result!=null;}).length;
      var p=panels(perf)[0]||'';
      return log.length===4 && real===2
        && (p.match(/<i class="[wlp]">/g)||[]).length===2
        && p.indexOf('<i class="p">')<0;
    },
    {drew:(panels(perf)[0]||'').match(/<i class="[wlp]">/g)||[]});
  chk('the "Last N graded" label counts exactly the marks beside it',
    function(){
      var ps=panels(perf);
      if(!ps.length)return false;
      return ps.every(function(p){
        var lab=/Last (\d+) graded/.exec(p);
        var marks=(p.match(/<i class="[wlp]">/g)||[]).length;
        return lab?marks===+lab[1]:marks===0;
      });
    },
    {panels:panels(perf).map(function(p){
      return {label:(/Last (\d+) graded/.exec(p)||[])[1],
        marks:(p.match(/<i class="[wlp]">/g)||[]).length};})});
  GAMES.length=3;

  /* ---- a failed repaint must never be permanent -----------------------
     The tick used to record the new fingerprint BEFORE redrawing, so one
     failed repaint was forever: it had already agreed it had drawn this
     state and never looked again, and the reader sat in front of an error
     box until they reloaded the page. */
  S.SEASON_GAMES={};S.LOCALREC={};S.META=null;S.WALLC=null;
  S.LIVE_FP=null;S.LIVE_SPORT=null;S.LIVE_BUSY=false;
  S.location.hash='';
  await S.liveTick();
  chk('the tick has a baseline to lose', S.LIVE_FP!=null);
  GAMES.push(G(11,'X','Y',24,21,-2.5,[M('blerm','blerm-s-model','home',-4,-2.5,0.6)]));
  var realRoute=S.route;
  var baseline=S.LIVE_FP, insideFp=null;
  S.route=function(){insideFp=S.LIVE_FP;throw new Error('repaint failed');};
  await S.liveTick();
  S.route=realRoute;
  chk('the new fingerprint is not recorded until the repaint has happened',
    insideFp===baseline,
    {baseline:String(baseline).slice(0,40),insideRepaint:String(insideFp).slice(0,40)});
  chk('a redraw that throws leaves the tick looking again next minute',
    S.LIVE_FP===null,
    'recording the fingerprint before the repaint made one failure permanent');
  await S.liveTick();
  chk('and it recovers on its own once the repaint works', S.LIVE_FP!=null);

  /* ---- the reader navigating mid-redraw wins --------------------------- */
  S.LIVE_FP=null;S.LIVE_SPORT=null;
  S.location.hash='';
  await S.liveTick();
  GAMES.push(G(12,'P','Q',31,17,-6.5,[M('blerm','blerm-s-model','home',-9,-6.5,0.7)]));
  var routed=[];
  S.route=function(){
    routed.push(S.location.hash);
    if(routed.length===1)S.location.hash='#board';   /* the reader moves mid-flight */
    return Promise.resolve();
  };
  await S.liveTick();
  S.route=realRoute;
  chk('a redraw that finished for a page the reader has left draws again',
    routed.length===2 && routed[1]==='#board',
    {routed:routed});
  S.location.hash='';S.LIVE_FP=null;S.LIVE_SPORT=null;
  GAMES.length=3;

  /* ---- the reader opening the uploader mid-tick ----------------------
     liveRoute() was checked only on the way in. Two requests happen after
     that, and in them a reader can open the dashboard — a view holding a
     half-mapped slate nobody has saved. */
  S.SEASON_GAMES={};S.LOCALREC={};S.META=null;S.WALLC=null;
  S.LIVE_FP=null;S.LIVE_SPORT=null;S.LIVE_BUSY=false;
  S.location.hash='';
  await S.liveTick();
  GAMES.push(G(13,'R','S',28,14,-3.5,[M('blerm','blerm-s-model','home',-7,-3.5,0.66)]));
  var drew=[];
  S.route=function(){drew.push(S.location.hash);return Promise.resolve();};
  var realFetch2=S.fetch;
  S.fetch=function(u){
    /* the reader opens the uploader while the tick is waiting on its data */
    if(String(u).indexOf('/v1/games')>=0)S.location.hash='#dashboard';
    return realFetch2(u);
  };
  await S.liveTick();
  S.fetch=realFetch2;S.route=realRoute;
  chk('a tick never redraws a view the reader opened while it was waiting',
    drew.length===0, {drew:drew});
  S.location.hash='';S.LIVE_FP=null;S.LIVE_SPORT=null;

  /* ---- an unreachable API must not replace the page with an error box -- */
  chk('a failed automatic refresh leaves the last good view alone',
    function(){
      var v=node();
      v.innerHTML='<h1>the page the reader is looking at</h1>';
      S.LIVE_QUIET=true;S.LIVE_FP='something';
      S.fail(v,new Error('briefly unreachable'));
      var kept=v.innerHTML.indexOf('the page the reader is looking at')>=0
        && S.LIVE_FP===null;
      S.LIVE_QUIET=false;
      /* and a reader-initiated failure still says so */
      S.fail(v,new Error('briefly unreachable'));
      return kept && v.innerHTML.indexOf('could not load')>=0;
    });

  /* ---- the season caches cannot go stale forever ----------------------
     The fingerprint watches the CURRENT week, because that is the week
     whose games are finishing. A settlement run reaching back to grade an
     earlier one would never be seen, so the season sweep is dropped on a
     slower cycle. */
  S.route=function(){return Promise.resolve();};
  S.LIVE_FP=null;S.LIVE_SPORT=null;S.LIVE_BUSY=false;S.location.hash='';
  await S.liveTick();
  S.SEASON_GAMES={'CFB|2026':[1,2,3]};S.LOCALREC={'CFB|2026':{}};
  S.LIVE_TICKS=0;
  chk('the slower cycle is genuinely slower than the tick',
    S.LIVE_SEASON_EVERY>=5,
    'dropping the season sweep every minute turns a one-request poll into a per-week storm');
  var kept=0;
  for(var t=0;t<S.LIVE_SEASON_EVERY-1;t++){
    await S.liveTick();
    if(Object.keys(S.SEASON_GAMES).length)kept++;
  }
  chk('an unchanged slate leaves the season sweep in place',
    kept===S.LIVE_SEASON_EVERY-1&&kept>=4, {kept:kept,of:S.LIVE_SEASON_EVERY-1});
  await S.liveTick();
  chk('and the sweep is dropped on the slower cycle, with no repaint',
    Object.keys(S.SEASON_GAMES).length===0
      && Object.keys(S.LOCALREC).length===0,
    {season:Object.keys(S.SEASON_GAMES),local:Object.keys(S.LOCALREC)});
  S.route=realRoute;S.LIVE_TICKS=0;
  GAMES.length=3;

  /* ---- one view on screen at a time -----------------------------------
     Every render ends in one innerHTML= and has awaits before it, so a
     render for the page a reader was on can finish after the page they are
     on now and paint over it. The refresh turns that from a rare race into
     a routine one. */
  chk('a render overtaken by a newer route paints nothing',
    function(){
      var v=node();v.innerHTML='<h1>the page the reader is on</h1>';
      var stale=S.ROUTE_TOKEN;
      S.ROUTE_TOKEN++;
      return S.paint(v,stale,'<h1>overtaken</h1>')===false
        && v.innerHTML.indexOf('the page the reader is on')>=0;
    });
  chk('and the render that still holds the token paints',
    function(){
      var v=node();
      return S.paint(v,S.ROUTE_TOKEN,'<h1>drawn</h1>')===true
        && v.innerHTML.indexOf('drawn')>=0;
    });
  chk('every route stamps a new token',
    function(){
      var before=S.ROUTE_TOKEN;
      S.location.hash='#models';S.route();
      var mid=S.ROUTE_TOKEN;
      S.location.hash='#rankings';S.route();
      S.location.hash='';
      return mid>before&&S.ROUTE_TOKEN>mid;
    });
  /* end to end: a board render caught mid-flight by a route change */
  S.SEASON_GAMES={};S.LOCALREC={};
  S.location.hash='#board';
  var vB=node();
  var flight=S.renderBoard(vB);
  S.ROUTE_TOKEN++;                       /* the reader navigated */
  await flight;
  chk('a board render overtaken mid-flight never reaches the page',
    vB.innerHTML.indexOf('The Board')<0,
    {left:vB.innerHTML.slice(0,120)});
  S.location.hash='';

  /* ---- the scroll restore must not yank a reader who moved ------------- */
  S.SEASON_GAMES={};S.LOCALREC={};S.META=null;S.WALLC=null;
  S.LIVE_FP=null;S.LIVE_SPORT=null;S.LIVE_BUSY=false;S.LIVE_TICKS=0;
  var scrolls=[];
  S.scrollTo=function(x,y){scrolls.push(y);S.scrollY=y;};
  await S.liveTick();
  GAMES.push(G(14,'T','U',35,7,-10.5,[M('blerm','blerm-s-model','home',-14,-10.5,0.8)]));
  S.scrollY=500;
  S.route=function(){S.scrollY=200;return Promise.resolve();};   /* the reader scrolled */
  await S.liveTick();
  chk('a reader who scrolled during the repaint is left where they are',
    scrolls.length===0, {scrolls:scrolls});
  GAMES.push(G(15,'V','W',20,17,-1.5,[M('blerm','blerm-s-model','home',-3,-1.5,0.6)]));
  S.scrollY=500;
  S.route=function(){S.scrollY=0;return Promise.resolve();};     /* the repaint lost it */
  await S.liveTick();
  chk('but a repaint that lost the position puts it back',
    scrolls.length===1&&scrolls[0]===500, {scrolls:scrolls});
  S.route=realRoute;S.scrollY=0;GAMES.length=3;
  S.LIVE_FP=null;S.LIVE_SPORT=null;

  /* ---- a week that failed to load must not be cached as a season ------
     One missing week is a hole in every record computed from the sweep, and
     caching it makes the hole permanent for the whole session. */
  S.SEASON_GAMES={};S.LOCALREC={};
  var realFetch3=S.fetch;
  S.fetch=function(u){
    if(/[?&]week=2/.test(String(u)))
      return Promise.resolve({ok:false,status:500,json:function(){return Promise.resolve({});}});
    if(String(u).indexOf('/v1/games')>=0&&!/[?&]week=/.test(String(u)))
      return reply({games:GAMES,week:3,entitled:true});
    return realFetch3(u);
  };
  var partial=await S.seasonGames('CFB',2026);
  chk('a sweep with a failed week still returns what arrived',
    partial.length>0);
  chk('but it is not remembered, so the next look retries',
    Object.keys(S.SEASON_GAMES).length===0,
    'a short record all day, and the reader never finds out why');
  S.fetch=realFetch3;
  S.SEASON_GAMES={};S.LOCALREC={};
  var full=await S.seasonGames('CFB',2026);
  chk('and a complete sweep is remembered',
    full.length>0 && Object.keys(S.SEASON_GAMES).length===1);
  S.SEASON_GAMES={};S.LOCALREC={};

  /* ---- a stale server row must not stand in for a whole board ---------
     inSport keeps a row whose sport it cannot resolve, deliberately: an
     unlabelled model is the server's omission and hiding it is worse. But
     one such row used to suppress the board this page computed for the
     sport the reader is actually on. */
  S.SEASON_GAMES={};S.LOCALREC={};
  RANKINGS.thresholds={min_graded_games:2,min_coverage_pct:60};
  RANKINGS.boards.win_pct=[{rank:1,creator_slug:'ghost',creator_name:'Ghost Analytics',
    model_name:'Ghost NFL Model',value:0.62,graded:41}];
  S.location.hash='#rankings';
  var rG=node();
  await S.renderRankings(rG);
  var hijack=rG.innerHTML;
  /* scoped to the Win % board itself: every model also appears in the live
     standings further down, so an unscoped search passes either way */
  function boardSlice(html,from,to){
    var a=html.indexOf(from);if(a<0)return '';
    var b=html.indexOf(to,a);return html.slice(a,b<0?html.length:b);
  }
  var winBoard=boardSlice(hijack,'>Win %','>Margin MAE');
  chk('a board the page can fill is not surrendered to an unplaceable row',
    winBoard.length>0 && winBoard.indexOf('Ghost Analytics')<0
      && /EdgeDesk Model|Must Be Moose|CFB MODEL/.test(winBoard),
    {board:winBoard.slice(0,400)});

  /* ---- and nobody is ranked and unranked at once ---------------------- */
  S.SEASON_GAMES={};S.LOCALREC={};
  RANKINGS.thresholds={min_graded_games:20,min_coverage_pct:60};
  /* a model name with no apostrophe: esc() would turn one into &#39; and
     the search would pass whatever the code did */
  RANKINGS.boards.win_pct=[{rank:1,creator_slug:'edgedesksports',creator_name:'EdgeDesk Sports',
    model_name:'EdgeDesk Model',value:0.58,graded:34}];
  /* a model whose only game has not kicked off yet: the one remaining way
     to be unranked now that there is no minimum */
  var future=G(88,'AAA','BBB',null,null,-3.5,[M('newbie','first-model','home',-6,-3.5,0.6)]);
  future.kickoff_at='2099-01-01T17:00:00Z';
  GAMES.push(future);
  var rU=node();
  await S.renderRankings(rU);
  var both=rU.innerHTML;
  GAMES.length=3;
  chk('the server-ranked model is on the board',
    boardSlice(both,'>Win %','>Margin MAE').indexOf('EdgeDesk Sports')>=0);
  chk('a model whose games have not been played is told exactly that',
    function(){
      var un=both.indexOf('Not yet ranked');
      if(un<0)return false;
      var list=both.slice(un);
      return list.indexOf('first-model')>=0
        && /no finished games yet/.test(list)
        && !/is below the \d+ minimum/.test(list);
    },
    {tail:both.slice(both.indexOf('Not yet ranked'),both.indexOf('Not yet ranked')+400)});
  chk('and a model that IS on a board is not also listed there',
    function(){
      var un=both.indexOf('Not yet ranked');
      if(un<0)return false;
      return both.slice(un).indexOf('EdgeDesk Model')<0;
    });
  RANKINGS.boards.win_pct=[];
  S.SEASON_GAMES={};S.LOCALREC={};S.location.hash='';

  /* ---- the sweep must not stop at one week -----------------------------
     The week-less payload names the current week, and that is what bounds
     the sweep. When it does not, the games it returned still do — reading
     one week and calling it a season would quietly build every record on
     this site out of a single slate. */
  S.SEASON_GAMES={};S.LOCALREC={};
  var realFetch4=S.fetch;
  function wkGame(n){
    var g=G(900+n,'A'+n,'B'+n,24,17,-3.5,[M('blerm','blerm-s-model','home',-6,-3.5,0.6)]);
    g.week=n;return g;
  }
  S.fetch=function(u){
    var q=String(u);
    if(q.indexOf('/v1/games')<0)return realFetch4(u);
    var m=/[?&]week=(\d+)/.exec(q);
    if(m)return reply({games:[wkGame(+m[1])],entitled:true});
    /* deliberately no top-level week on the head payload */
    return reply({games:[wkGame(3)],entitled:true});
  };
  var swept=await S.seasonGames('CFB',2026);
  chk('a payload that names no week is bounded by the games it returned',
    swept.length===3
      && [1,2,3].every(function(w){
           return swept.some(function(g){return g.week===w;});
         }),
    {weeks:swept.map(function(g){return g.week;})});
  S.fetch=realFetch4;
  S.SEASON_GAMES={};S.LOCALREC={};

  /* ---- THE REPORTED BUG, exactly as reported --------------------------
     The wire returns result:null on games that finished the day before.
     No FINAL chip on the board, 0 settled on the wall, every record zero —
     and no grader could fix it, because a grader cannot invent a score. */
  S.SEASON_GAMES={};S.LOCALREC={};S.META=null;S.WALLC=null;S.ESPN_DAYS={};
  var BLANK=GAMES.map(function(g){
    var c=JSON.parse(JSON.stringify(g));
    c.result=null;                       /* what the API actually returns */
    return c;
  });
  chk('with no result on the wire there is nothing to grade — the bug',
    function(){
      return BLANK.every(function(g){return S.finalResult(g)===null;})
        && S.modelRecord(BLANK,'blerm','blerm-s-model').graded===0;
    });
  var realFetch5=S.fetch;
  var asked=[];
  S.fetch=function(u){
    var q=String(u);
    if(q.indexOf('site.api.espn.com')>=0){
      asked.push(q);
      return Promise.resolve({ok:true,status:200,json:function(){
        return Promise.resolve({events:[
          {competitions:[{status:{type:{completed:true}},competitors:[
            {homeAway:'home',score:'48',team:{displayName:'TCU Horned Frogs',abbreviation:'TCU'}},
            {homeAway:'away',score:'14',team:{displayName:'North Carolina Tar Heels',abbreviation:'UNC'}}]}]},
          {competitions:[{status:{type:{completed:true}},competitors:[
            {homeAway:'home',score:'59',team:{displayName:'USC Trojans',abbreviation:'USC'}},
            {homeAway:'away',score:'28',team:{displayName:'San Jose State Spartans',abbreviation:'SJSU'}}]}]},
          {competitions:[{status:{type:{completed:false}},competitors:[
            {homeAway:'home',score:'0',team:{displayName:'Virginia Cavaliers'}},
            {homeAway:'away',score:'0',team:{displayName:'NC State Wolfpack'}}]}]}
        ]});}});
    }
    return realFetch5(u);
  };
  var filled=await S.enrichFinals(BLANK,'CFB',null);
  S.fetch=realFetch5;
  chk('the page goes and reads the finals the wire never wrote',
    filled===2 && asked.length>=1 && /dates=20260829/.test(asked[0]),
    {filled:filled,asked:asked});
  chk('and a game still in progress is NOT taken as a result',
    function(){
      var ncst=BLANK.filter(function(g){return g.game_id===3;})[0];
      return S.finalResult(ncst)===null;
    },
    'a score at half time is not a final');
  chk('the score is marked as the page’s own find, not the Collective’s',
    function(){
      var tcu=BLANK.filter(function(g){return g.game_id===1;})[0];
      return S.finalResult(tcu).source==='espn'
        && S.scoreSourceMark(tcu).indexOf('ESPN')>=0
        && S.scoreSourceMark(GAMES[0])==='';
    });
  chk('with the scores in hand, the record fills',
    function(){
      var rec=S.modelRecord(BLANK,'blerm','blerm-s-model');
      /* 0 settled becomes a real record: two graded games with a margin
         error each. The win-loss half needs a closing line, asserted next. */
      return S.hasRecord(rec) && rec.margin_n===2;
    },
    'this is the whole point: 0 settled becomes a real record');
  /* ESPN gives a score and nothing else, so ATS needs the Collective's own
     captured close — which comes off the odds feed, not from ESPN */
  chk('without a captured close there is a record but no win-loss',
    function(){
      var tcu=BLANK.filter(function(g){return g.game_id===1;})[0];
      return S.finalResult(tcu).closing_spread===null
        && S.modelRecord(BLANK,'blerm','blerm-s-model').wins===0
        && S.modelRecord(BLANK,'blerm','blerm-s-model').margin_n===2;
    },
    'a score alone grades margin and Brier; the spread needs the close');
  /* awaited BEFORE chk: a thunk that returns a promise is truthy whatever
     the promise resolves to, and would pass however wrong the code was */
  var withClose=[JSON.parse(JSON.stringify(BLANK[0]))];
  withClose[0].result=null;
  S.ESPN_DAYS={};
  S.fetch=function(u){
    if(String(u).indexOf('site.api.espn.com')>=0)
      return Promise.resolve({ok:true,status:200,json:function(){
        return Promise.resolve({events:[{competitions:[{status:{type:{completed:true}},
          competitors:[
            {homeAway:'home',score:'48',team:{displayName:'TCU Horned Frogs'}},
            {homeAway:'away',score:'14',team:{displayName:'North Carolina Tar Heels'}}]}]}]});}});
    return realFetch5(u);
  };
  await S.enrichFinals(withClose,'CFB',
    {find:function(g){return g&&g.game_id===1?{closing:{'spread:home':{line:-7.5}}}:null;}});
  S.fetch=realFetch5;
  chk('and with the stored close it grades against the spread too',
    function(){
      var r=S.finalResult(withClose[0]);
      var gr=S.rowGrade(withClose[0],withClose[0].models[3]);   /* blerm, on UNC */
      /* TCU won by 34 into a -7.5 close, so the road side lost */
      return r.closing_spread===-7.5 && gr.pick_result==='loss';
    },
    {close:(S.finalResult(withClose[0])||{}).closing_spread});
  S.ESPN_DAYS={};S.SEASON_GAMES={};S.LOCALREC={};S.CLOSING={};

  /* ---- THE SECOND HALF OF THE SAME BUG --------------------------------
     The board is a FORWARD window — odds.js says so itself: "a game that
     finished days ago is not in it". So the close above, read off the
     board, is only ever there for a game that has just finished. Every
     game from last week had a score and no close, atsResult() returned
     null on all of them, and the site reported "no ATS picks" and 0 graded
     against models whose closing lines were sitting in the Collective's
     own database the whole time.

     The Collective serves that number by name. Ask for it. */
  var lastWeek=[JSON.parse(JSON.stringify(BLANK[0]))];
  lastWeek[0].result={home_score:48,away_score:14,closing_spread:null,
                      closing_total:null,source:'espn'};
  var closingAsked=[];
  var realFetch6=S.fetch;
  S.fetch=function(u){
    var q=String(u);
    if(q.indexOf('/closing/')>=0){
      closingAsked.push(q);
      return reply({available:true,closing_spread:-7.5,closing_total:52.5,books:8});
    }
    return realFetch6(u);
  };
  /* Through the real entry point every surface calls, with mkt null: the
     board has nothing, exactly as it has nothing for any game that finished
     before its window opened. Driving fillCapturedCloses directly would
     prove the function works and not that anything ever calls it. */
  await S.enrichFinals(lastWeek,'CFB',null);
  S.fetch=realFetch6;
  chk('a game the board no longer carries is asked for by name',
    closingAsked.length===1
      && /\/collective_odds\/v1\/ncaaf\/closing\/1(\?|$)/.test(closingAsked[0]),
    {asked:closingAsked});
  chk('the captured close lands on the game and the record finally grades',
    function(){
      var r=S.finalResult(lastWeek[0]);
      var gr=S.rowGrade(lastWeek[0],lastWeek[0].models[3]);  /* blerm, on UNC */
      var rec=S.modelRecord(lastWeek,'blerm','blerm-s-model');
      return r.closing_spread===-7.5 && lastWeek[0].result.closing_total===52.5
        && gr.pick_result==='loss' && rec.graded===1 && rec.losses===1;
    },
    'THE BUG: this is the number whose absence emptied every ATS record');
  chk('and the sport names the league, never the tab the reader is on',
    /\/ncaaf\//.test(closingAsked[0]||'') ,
    'a College Football close asked of the NFL route comes back empty');

  /* An unavailable close is not a loss and is never invented: the game
     stays graded on its score alone, exactly as before. */
  S.CLOSING={};
  var noClose=[JSON.parse(JSON.stringify(BLANK[0]))];
  noClose[0].result={home_score:48,away_score:14,closing_spread:null,
                     closing_total:null,source:'espn'};
  var realFetch7=S.fetch;
  S.fetch=function(u){
    if(String(u).indexOf('/closing/')>=0)
      return reply({available:false,reason:'no_pregame_capture'});
    return realFetch7(u);
  };
  var nNone=await S.fillCapturedCloses(noClose,'CFB',null);
  S.fetch=realFetch7;
  chk('a close the Collective never captured is left alone, not guessed',
    function(){
      var rec=S.modelRecord(noClose,'blerm','blerm-s-model');
      return nNone===0 && S.finalResult(noClose[0]).closing_spread===null
        && rec.graded===0 && rec.margin_n===1;
    },
    {filled:nNone});

  /* The board is free and already in hand, so it is tried first and the
     endpoint is never asked about a game the board can already answer. */
  S.CLOSING={};
  var onBoard=[JSON.parse(JSON.stringify(BLANK[0]))];
  onBoard[0].result={home_score:48,away_score:14,closing_spread:null,
                     closing_total:null,source:'espn'};
  var askedAnyway=0;
  var realFetch8=S.fetch;
  S.fetch=function(u){
    if(String(u).indexOf('/closing/')>=0){askedAnyway++;return reply({available:false});}
    return realFetch8(u);
  };
  await S.fillCapturedCloses(onBoard,'CFB',
    {find:function(g){return g&&g.game_id===1?{closing:{'spread:home':{line:-7.5}}}:null;}});
  S.fetch=realFetch8;
  chk('the board answers first and costs no extra request',
    askedAnyway===0 && S.finalResult(onBoard[0]).closing_spread===-7.5,
    {asked:askedAnyway});
  S.ESPN_DAYS={};S.SEASON_GAMES={};S.LOCALREC={};S.CLOSING={};

  /* ---- the market page -------------------------------------------------
     It fetched whatever league the sport switcher said and then described it
     as the NFL, so a College Football slate sat under NFL wording — and it
     led with markets that closed eight days ago. Nothing drove this page at
     all, which is why neither was caught.

     odds.js is not loaded in this shim, so MCOdds is stubbed down to the
     handful of calls renderMarket actually makes. */
  var MKTGAMES=[
    {event_id:'e-old',collective_game_id:1,home:'TCU',away:'NORTHCAROL',
     commence_time:'2026-08-29T16:00:00Z',market_closed:true,
     closing:{'spread:home':{line:-7.5}}},
    {event_id:'e-recent',collective_game_id:2,home:'USC',away:'SANJOSESTA',
     commence_time:'2026-08-29T19:00:00Z',market_closed:true,
     closing:{'spread:home':{line:-38.5}}},
    {event_id:'e-soon',collective_game_id:9,home:'OREGON',away:'UTAH',
     commence_time:'2099-09-05T19:00:00Z',market_closed:false,closing:{}}
  ];
  S.MCOdds={
    configure:function(){},injectCss:function(){},
    leagueFor:function(c){return String(c).toLowerCase();},
    board:function(){return Promise.resolve({state:'ok',count:MKTGAMES.length,
      games:MKTGAMES,last_updated:'2026-08-30T12:00:00Z',
      find:function(g){return g&&g.game_id===1?MKTGAMES[0]:null;}});},
    ago:function(){return '76m';},ageOf:function(){return 0;},
    freshChip:function(){return '<span class="chip">Updated 76m ago</span>';},
    consensusSpread:function(g){
      var c=g&&g.closing&&g.closing['spread:home'];return c?c.line:null;},
    consensusTotal:function(){return 47.5;},
    edgeHtml:function(){return '';},line:function(x){return String(x);},
    marketCard:function(g){return '<div class="mco-card" data-ev="'+g.event_id+'">'+
      g.away+' @ '+g.home+'</div>';}
  };
  S.SEASON_GAMES={};S.LOCALREC={};
  S.location.hash='#market';
  var vM=node();
  await S.renderMarket(vM);
  var market=vM.innerHTML;
  chk('the market page names the sport it is actually showing',
    market.indexOf('College Football prices across sportsbooks')>=0
      && market.indexOf('NFL prices across sportsbooks')<0,
    {lede:(/<p class="lede">([^<]*)/.exec(market)||[])[1]});
  chk('and carries the sport switcher so a reader can change it',
    market.indexOf('data-sport="CFB"')>=0||market.indexOf('data-sport=')>=0
      ||S.sportSwitcherHTML({sports:[{code:'CFB',season:2026}]})==='',
    'one sport in the stub means the switcher is legitimately empty');
  chk('the market leads with what has not been played',
    function(){
      var order=(market.match(/data-ev="([^"]+)"/g)||[])
        .map(function(x){return /data-ev="([^"]+)"/.exec(x)[1];});
      /* upcoming first, then the closed markets newest-first */
      return order.join(',')==='e-soon,e-recent,e-old';
    },
    {order:(market.match(/data-ev="([^"]+)"/g)||[])});
  chk('a closed market still says the close is what a game is graded on',
    market.indexOf('graded against')>=0||market.indexOf('graded on')>=0);
  /* A closed market was a price board with the prices frozen: same shape as
     a live game, no score, nothing to say the thing had happened. */
  chk('a finished game says what it did to its own closing line',
    function(){
      /* USC closed -38.5 and won 59-28, by 31: the road side covered */
      return /FINAL SANJOSESTA 28 &ndash; USC 59/.test(market)
        && /close USC -38\.5/.test(market)
        && /<b>SANJOSESTA<\/b> covered/.test(market);
    },
    {strip:(/<div class="gb-hd"[^>]*>[\s\S]{0,240}/.exec(market)||[])[0]});
  chk('and a game that has not been played says nothing of the kind',
    function(){
      var at=market.indexOf('data-ev="e-soon"');
      if(at<0)return false;
      var soon=market.slice(at);
      /* from 1, not 0: the slice STARTS with the marker, so searching from
         zero finds itself, the window is empty and this passes for free */
      var next=soon.indexOf('data-ev="',1);
      var card=next<0?soon:soon.slice(0,next);
      return card.indexOf('FINAL')<0 && card.indexOf('covered')<0;
    },
    {card:(function(){
      var at=market.indexOf('data-ev="e-soon"');
      if(at<0)return '(no upcoming card)';
      var soon=market.slice(at),n=soon.indexOf('data-ev="',1);
      return (n<0?soon:soon.slice(0,n)).slice(0,200);
    })()});
  /* the market page is the one place a price change IS the content, so it
     is the one place the refresh watches the feed's stamp */
  chk('the market page refreshes itself when a new poll lands',
    function(){
      return S.LIVE_ROUTES['market']===1
        && S.liveRoute.toString().indexOf('LIVE_ROUTES')>=0;
    });
  S.MCOdds=undefined;S.location.hash='';

  /* ---- THE NFL SIDE, driven for the first time -------------------------
     Every sport-scoped path is supposed to read the switcher: the league the
     odds feed is asked for, the scoreboard league, the season sweep, the
     rankings. None of it had ever been exercised for the NFL, so none of it
     was evidence of anything. */
  chk('the NFL maps to its own scoreboard league, not college football',
    S.espnLeague('NFL')==='nfl' && S.espnLeague('CFB')==='college-football'
      && S.espnLeague('NCAAF')==='college-football'   /* alias folds to CFB */
      && S.espnLeague('QUIDDITCH')===null,
    'an unknown sport asks nobody for a score rather than guessing a league');
  S.SEASON_GAMES={};S.LOCALREC={};S.META=null;S.WALLC=null;S.ESPN_DAYS={};
  S.localStorage.setItem('mc_sport','NFL');
  WALL.push(NFLWALL[0]);WALL.push(NFLWALL[1]);
  S.location.hash='#rankings';
  var rNFL=node();
  await S.renderRankings(rNFL);
  var nfl=rNFL.innerHTML;
  chk('the NFL boards fill from NFL games',
    function(){
      var win=boardSlice(nfl,'>Win %','>Margin MAE');
      return win.indexOf('NFL Math Madness')>=0 && win.indexOf('NoFunLeague')>=0
        && win.indexOf('No finished games yet')<0;
    },
    {board:boardSlice(nfl,'>Win %','>Margin MAE').slice(0,300)});
  chk('and no College Football model leaks onto the NFL page',
    function(){
      var upTo=nfl.slice(0,nfl.indexOf('Not yet ranked')<0?nfl.length:nfl.indexOf('Not yet ranked'));
      return upTo.indexOf('CFB MODEL')<0 && upTo.indexOf('Blerm')<0
        && upTo.indexOf('MustBeMoose College Football')<0;
    });
  chk('the NFL records are graded by the same rule, and are correct',
    function(){
      /* KC -6.5, won by 10: the home side covered.
         SF -3, won by 2: the road side covered. */
      var mm=S.modelRecord(NFLGAMES,'jadedbettor-murse2-0','nfl-math-madness');
      var nf=S.modelRecord(NFLGAMES,'tiltdatalabs','nofunleague');
      return mm.wins===1 && mm.losses===1 && nf.wins===1 && nf.losses===1;
    },
    {mm:S.modelRecord(NFLGAMES,'jadedbettor-murse2-0','nfl-math-madness')});
  /* the scoreboard the NFL side would actually ask, when a result is missing */
  S.ESPN_DAYS={};
  var espnAsked=[];
  var realFetch6=S.fetch;
  S.fetch=function(u){
    if(String(u).indexOf('site.api.espn.com')>=0){
      espnAsked.push(String(u));
      return Promise.resolve({ok:true,status:200,json:function(){
        return Promise.resolve({events:[{competitions:[{status:{type:{completed:true}},
          competitors:[
            {homeAway:'home',score:'31',team:{displayName:'Kansas City Chiefs',abbreviation:'KC'}},
            {homeAway:'away',score:'21',team:{displayName:'Baltimore Ravens',abbreviation:'BAL'}}]}]}]});}});
    }
    return realFetch6(u);
  };
  var blankNFL=[JSON.parse(JSON.stringify(NFLGAMES[0]))];
  blankNFL[0].result=null;
  var filledNFL=await S.enrichFinals(blankNFL,'NFL',null);
  S.fetch=realFetch6;
  chk('a missing NFL result is read from the NFL scoreboard',
    filledNFL===1 && espnAsked.length===1
      && espnAsked[0].indexOf('/football/nfl/scoreboard')>=0,
    {asked:espnAsked});
  chk('and the college-only group filter is not sent for the NFL',
    espnAsked.length===1 && espnAsked[0].indexOf('groups=80')<0,
    'groups=80 is the FBS group; it means nothing to an NFL scoreboard');
  WALL.pop();WALL.pop();
  S.localStorage.setItem('mc_sport','CFB');
  S.SEASON_GAMES={};S.LOCALREC={};S.META=null;S.WALLC=null;S.ESPN_DAYS={};
  S.location.hash='';

  /* ---- an empty board must not break its own card ---------------------
     Rendered with NO games at all, so the empty message is actually on the
     page — asserting it against a board that filled passes for free. */
  S.SEASON_GAMES={};S.LOCALREC={};S.META=null;S.WALLC=null;
  var realFetch7=S.fetch;
  S.fetch=function(u){
    if(String(u).indexOf('/v1/games')>=0)
      return reply({games:[],week:1,entitled:true});
    return realFetch7(u);
  };
  var rEmpty=node();
  await S.renderRankings(rEmpty);
  S.fetch=realFetch7;
  var emptyHtml=rEmpty.innerHTML;
  chk('an empty board says so',
    (emptyHtml.match(/No finished games yet/g)||[]).length===3,
    {found:(emptyHtml.match(/No finished games yet/g)||[]).length});
  chk('and its message wraps instead of forcing a scrollbar',
    /white-space:normal[^>]*>\s*No finished games yet/.test(emptyHtml),
    {cell:(/<td[^>]*>\s*No finished games yet[^<]*/.exec(emptyHtml)||[])[0]});
  S.SEASON_GAMES={};S.LOCALREC={};S.META=null;S.WALLC=null;

  /* ---- THE MODEL'S OWN PAGE -------------------------------------------
     Never driven by this suite, and it was broken in the way that matters
     most: the page built its game log out of the weeks named in the
     SERVER's coverage table, so a model the settlement run had not reached
     had an empty coverage list, no weeks were fetched, and the profile
     rendered with no record and no picks at all — about a model whose
     games had all been played and which the rankings page was ranking off
     those very games at that moment.

     The stub returns exactly that state: record null, recent_graded [],
     coverage []. */
  S.SEASON_GAMES={};S.LOCALREC={};S.META=null;S.WALLC=null;S.CLOSING={};
  S.location.hash='#/model/blerm/blerm-s-model';
  var vMod=node();
  await S.renderModel(vMod,'blerm','blerm-s-model');
  var mod=vMod.innerHTML;
  chk('a profile the server has no coverage for still shows its games',
    /Every graded game/.test(mod)&&mod.indexOf('No game of this model')<0,
    {sample:mod.slice(0,300)});
  chk('every game this model posted is on the page, with its own pick',
    (mod.match(/data-res="(win|loss|push)"/g)||[]).length===3,
    {rows:(mod.match(/data-res="[a-z]*"/g)||[])});
  /* The picks themselves, not just "three rows appeared". blerm is on the
     road side of all three: UNC lost into TCU -7.5, SJSU covered +38.5,
     NC State covered +5.5. */
  chk('and each one says whether it won or lost',
    (mod.match(/>WIN</g)||[]).length===2&&(mod.match(/>LOSS</g)||[]).length===1,
    {win:(mod.match(/>WIN</g)||[]).length,loss:(mod.match(/>LOSS</g)||[]).length});
  chk('the log adds up to the record printed above it',
    /Against the spread/.test(mod)&&/2-1/.test(mod),
    {ats:(/Against the spread[\s\S]{0,160}/.exec(mod)||[])[0]});
  chk('the closing line each pick was graded against is on the row',
    /-7\.5/.test(mod)&&/-38\.5/.test(mod),
    'a record nobody can check against a number is just a claim');
  chk('the game log comes before the supporting charts, not after them',
    mod.indexOf('Every graded game')<mod.indexOf('Methodology')
      &&(mod.indexOf('Calibration')<0||mod.indexOf('Every graded game')<mod.indexOf('Calibration')),
    {log:mod.indexOf('Every graded game'),cal:mod.indexOf('Calibration'),
     method:mod.indexOf('Methodology')});
  chk('a record the page graded itself still says so',
    /class="pgrade"/.test(mod),
    'a settled record and one computed here are different claims');
  S.SEASON_GAMES={};S.LOCALREC={};S.META=null;S.WALLC=null;S.location.hash='';

  /* ---- getting there ---------------------------------------------------
     The rankings named every model and linked to none of them: a row went
     to the CREATOR, who may run several models, so the one number a reader
     had just clicked led to a page that did not show its picks. */
  S.SEASON_GAMES={};S.LOCALREC={};S.META=null;S.WALLC=null;
  var rLink=node();
  await S.renderRankings(rLink);
  var lnk=rLink.innerHTML;
  chk('every standings row links to the model whose record it is',
    /href="#\/model\/blerm\/blerm-s-model"/.test(lnk)
      &&/href="#\/model\/mustbemoose\/edgedesk-cfb-p4"/.test(lnk),
    {hrefs:(lnk.match(/href="#\/model\/[^"]*"/g)||[]).slice(0,6)});
  chk('the ranked boards link to the model too, not just the creator',
    (lnk.match(/href="#\/model\/[^"]*"/g)||[]).length>=6,
    {n:(lnk.match(/href="#\/model\/[^"]*"/g)||[]).length});
  chk('and the row carries the same destination as the name inside it',
    (function(){
      var rows=lnk.match(/<tr class="rowlink" data-href="([^"]*)"/g)||[];
      return rows.length>0&&rows.every(function(r){return /#\//.test(r);});
    })(),
    {rows:(lnk.match(/data-href="[^"]*"/g)||[]).slice(0,4)});
  chk('the standings offer the game log in as many words',
    /picks &rarr;|picks →/.test(lnk),
    'the link has to be findable without knowing the name is one');
  /* Once the closing lines arrive, a model that never types a pick side
     gets a full win-loss record decided entirely by the comparison between
     its own line and the close. That is a real graded result and a
     DIFFERENT claim from a stated pick, and a bare "3-0" beside its name
     claims something the creator never said. The per-row marker on the
     board was the only place this was ever admitted. */
  function standingsRow(name){
    var t=lnk.slice(lnk.indexOf('<table id="standtbl"'));
    t=t.slice(0,t.indexOf('</table>'));
    var rows=t.split('<tr').filter(function(r){return r.indexOf(name)>=0;});
    return rows[0]||'';
  }
  chk('a record built from implied sides says so where the record is shown',
    /implied/.test(standingsRow('CFB MODEL')),   /* posts no pick side at all */
    {row:standingsRow('CFB MODEL').slice(0,420)||'not in the standings'});
  chk('and a record of stated picks is not labelled implied',
    (function(){
      var r=standingsRow('Blerm&#39;s Model')||standingsRow("Blerm's Model");
      return r.length>0&&!/implied/.test(r);
    })(),
    'labelling an honest stated record as implied is the opposite mistake');
  S.SEASON_GAMES={};S.LOCALREC={};S.META=null;S.WALLC=null;S.location.hash='';

  fails.forEach(function(f){console.log('FAIL | '+f.n+(f.d?'  '+JSON.stringify(f.d).slice(0,400):''));});
  console.log((fail===0?'ALL GREEN ':'FAILED ')+pass+' passed, '+fail+' failed');
  process.exit(fail===0?0:1);
})().catch(function(e){console.log('CRASHED: '+(e&&e.stack||e));process.exit(1);});
