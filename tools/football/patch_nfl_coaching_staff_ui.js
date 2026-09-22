#!/usr/bin/env node
'use strict';

/* Expose the committed NFL Coaching / Staff research artifact in app.html.
   The browser performs NO coaching calculation and applies NO point shift.
   It reads football/nfl/slate.json, whose builder is held against the same
   leak-free NFL engine path used by the board. */

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const FILE = path.join(ROOT, 'app.html');
let s = fs.readFileSync(FILE, 'utf8');

const MARK = 'function fbNflCoachingHTML(g){';
const REQUIRED = [
  "var FB_URL_NFL_COACHING='/football/nfl/slate.json';",
  'Coaching / Staff',
  'Applied to model',
  'Research candidate'
];

if (s.includes(MARK)) {
  const missing = REQUIRED.filter(x => !s.includes(x));
  if (missing.length) throw new Error('NFL coaching UI appears partially patched; missing: ' + missing.join(' | '));
  console.log('[nfl-coaching-ui] already patched');
  process.exit(0);
}

function replaceOne(oldText, newText, label) {
  const n = s.split(oldText).length - 1;
  if (n !== 1) throw new Error(label + ': expected exactly one anchor, found ' + n);
  s = s.replace(oldText, newText);
}

/* Load the committed research artifact beside the live engine. It is context,
   not an input to fbPredict(), and a missing/stale artifact never blocks NFL. */
replaceOne(
`function fbLoadNfl(signal){
  var E=window.EDFootball,S=FB.nfl;
  S.notes=[];
  return fbFetchText(FB_URL_GAMES,signal).then(function(txt){`,
`var FB_URL_NFL_COACHING='/football/nfl/slate.json';
function fbLoadNfl(signal){
  var E=window.EDFootball,S=FB.nfl;
  S.notes=[];S.coachingArtifact=null;S.coachingByGame={};
  var coachingP=fbFetchText(FB_URL_NFL_COACHING,signal).then(function(txt){
    var j=JSON.parse(txt);
    if(!j||j.schema!=='edgedesk_nfl_slate_v1')throw new Error('wrong NFL slate schema');
    S.coachingArtifact=j;
    (j.games||[]).forEach(function(g){S.coachingByGame[String(g.game_id)]=g.coaching_staff||null;});
    return j;
  }).catch(function(e){
    S.coachingArtifact=null;S.coachingByGame={};
    S.notes.push('NFL Coaching / Staff research context is unavailable in this session. The projection is unchanged; this layer never fills missing evidence with a guess.');
    return null;
  });
  return fbFetchText(FB_URL_GAMES,signal).then(function(txt){`,
  'NFL coaching artifact loader'
);

/* The normal load waits for the research artifact before first render, but a
   failure resolves null rather than taking down the football board. */
replaceOne(
`      return fbSignals('americanfootball_nfl',signal);
    }).then(function(sig){
      S.sig=sig;`,
`      return Promise.all([fbSignals('americanfootball_nfl',signal),coachingP]);
    }).then(function(parts){
      var sig=parts[0];
      S.sig=sig;`,
  'NFL coaching load join'
);

/* Deterministic renderer: all values come from the committed slate artifact. */
replaceOne(
`function fbGameCardNfl(u){
  var g=u.g;`,
`function fbNflCoachingHTML(g){
  var S=FB.nfl, c=S&&S.coachingByGame?S.coachingByGame[String(g.game_id)]:null;
  if(!c)return '<div class="gd-modelnote"><b>Coaching / Staff</b> · research context not published for this game. Applied to model: <b>0.0 points</b>.</div>';
  function side(x){
    if(!x||x.coaching_staff_rating==null)return 'not measured';
    var rank=x.coaching_staff_rank==null?'unranked':('#'+x.coaching_staff_rank);
    var rel=x.coaching_staff_reliability==null?'—':Math.round(x.coaching_staff_reliability*100)+'% rel';
    return fbEsc(x.coach||'coach not named')+' · '+x.coaching_staff_rating.toFixed(1)+' · '+rank+' · '+rel;
  }
  var cand=c.candidate_matchup_points==null?'—':fbPts(c.candidate_matchup_points);
  var status=c.validation_status||'UNVALIDATED';
  return '<div class="gd-modelnote"><b>Coaching / Staff</b> · '+fbEsc(g.away_team)+': '+side(c.away)
    +' · '+fbEsc(g.home_team)+': '+side(c.home)
    +'<br><b>Research candidate:</b> '+cand+' home-margin pts at tuned ±'+fbEsc(String(c.tuned_candidate_cap||0))+' cap'
    +' · validation '+fbEsc(status)
    +' · <b>Applied to model: '+fbPts(c.adjustment_points==null?0:c.adjustment_points)+' points</b>. '
    +'This is measured from leak-free pregame residuals; it is not a coach reputation grade.</div>';
}
function fbGameCardNfl(u){
  var g=u.g;`,
  'NFL coaching card helper'
);

replaceOne(
`    +lines+qb+fbQualityLine(p,extra)+(window.fbBriefBtn?fbBriefBtn('nfl',g,u,homeName,awayName):'')+'</div>';`,
`    +lines+fbNflCoachingHTML(g)+qb+fbQualityLine(p,extra)+(window.fbBriefBtn?fbBriefBtn('nfl',g,u,homeName,awayName):'')+'</div>';`,
  'NFL coaching card insertion'
);

for (const x of REQUIRED) if (!s.includes(x)) throw new Error('post-patch validation failed: missing ' + x);
fs.writeFileSync(FILE, s);
console.log('[nfl-coaching-ui] patched app.html');
