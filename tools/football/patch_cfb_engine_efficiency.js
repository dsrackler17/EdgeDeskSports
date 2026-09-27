#!/usr/bin/env node
'use strict';

/* ============================================================================
   KEEP THE LEGACY CFB BROWSER REPLAY ON CURRENT TEAM-GAME EFFICIENCY.

   The national rankings build publishes football/rankings/engine_efficiency.json.
   This patch makes the static app load that artifact before replaying completed
   games and pass the measured team stats into EDCfbP4.ingest.absorbGame().

   It is idempotent and intentionally narrow. EPA remains absent because the
   public play feed cannot reproduce it; missing efficiency fields stay missing.
   ========================================================================== */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const FILE = path.join(ROOT, 'app.html');
let s = fs.readFileSync(FILE, 'utf8');

const MARK = 'function fbP4EngineEfficiencyLoad(season,signal){';
/* THE REPLAY IS JOINED either by this patch's own inline join or by
   fbP4EffForGame(), the join football/fbs/build_coverage.js makes, which
   app.html now carries (tools/football/page_build_parity.test.js holds it to
   the build). Either one is the patched state; re-applying over the second
   would find none of the anchors below and fail the weekly build. */
const JOINED = s.includes('team_stats:eg&&eg.teams?{')
  || (s.includes('function fbP4EffForGame(') && s.includes('fbP4EffForGame(S.engineEfficiency,r,'));
if (s.includes(MARK) && JOINED) {
  console.log('[cfb-browser-efficiency] already patched');
  process.exit(0);
}

function replaceOne(oldText, newText, label) {
  const n = s.split(oldText).length - 1;
  if (n !== 1) throw new Error(label + ': expected exactly one anchor, found ' + n);
  s = s.replace(oldText, newText);
}

replaceOne(
`function fbP4Load(force,signal){
  var S=FB.p4,E=null;`,
`function fbP4EngineEfficiencyLoad(season,signal){
  return fetch('football/rankings/engine_efficiency.json?v='+Date.now(),
    {cache:'no-store',signal:signal}).then(function(r){
      if(!r.ok)throw new Error('HTTP '+r.status);
      return r.json();
    }).then(function(d){
      if(!d||d.schema!=='edgedesk_cfb_engine_efficiency_v1')
        throw new Error('unexpected engine-efficiency schema');
      if(+d.season!==+season)
        throw new Error('engine-efficiency artifact is for season '+d.season+', not '+season);
      return d;
    });
}
function fbP4Load(force,signal){
  var S=FB.p4,E=null;`,
  'loader helper');

replaceOne(
`    var cur=fbP4Season();
    S.season=cur;`,
`    var cur=fbP4Season();
    S.season=cur;
    var effPromise=fbP4EngineEfficiencyLoad(cur,signal).catch(function(e){
      S.notes.push('Current team-game efficiency artifact did not load ('+((e&&e.message)||'fetch failed')
        +'). The neutral-field ETSR backbone still loads, but the engine efficiency layer remains explicitly stale rather than being called current.');
      return null;
    });`,
  'efficiency promise');

replaceOne(
`    var chain=Promise.resolve();`,
`    var chain=effPromise.then(function(d){S.engineEfficiency=d;});`,
  'wait for efficiency');

replaceOne(
`          rows.forEach(function(r){
            if(!r.completed||r.home_points==null||r.away_points==null)return;
            E.ingest.absorbGame(st,{home:r.home_team,away:r.away_team,
              home_fbs:fbP4IsFbs(r.home_division,r.home_team),
              away_fbs:fbP4IsFbs(r.away_division,r.away_team),
              neutral_site:r.neutral_site,home_points:r.home_points,away_points:r.away_points});`,
`          rows.forEach(function(r){
            if(!r.completed||r.home_points==null||r.away_points==null)return;
            var eg=S.engineEfficiency&&S.engineEfficiency.games
              ?S.engineEfficiency.games[String(r.game_id)]:null;
            var hk=fbP4Key(r.home_team),ak=fbP4Key(r.away_team);
            E.ingest.absorbGame(st,{home:r.home_team,away:r.away_team,
              home_fbs:fbP4IsFbs(r.home_division,r.home_team),
              away_fbs:fbP4IsFbs(r.away_division,r.away_team),
              neutral_site:r.neutral_site,home_points:r.home_points,away_points:r.away_points,
              team_stats:eg&&eg.teams?{home:eg.teams[hk]||null,away:eg.teams[ak]||null}:null});`,
  'replay team stats');

fs.writeFileSync(FILE, s);
console.log('[cfb-browser-efficiency] patched app.html');
