#!/usr/bin/env node
'use strict';

/* ============================================================================
   EXPOSE COACHING / PROGRAM EDGE ON THE NATIONAL RANKINGS PAGE.

   app.html is a checked-in legacy single-file client. This patch is deliberately
   narrow and idempotent: it only teaches the existing rankings renderer about
   the coaching/program fields already published by build_rankings.js.

   The browser computes NOTHING here. It renders committed ratings, ranks,
   reliability, movement and history. Coaching / Program remains research-only
   and its ETSR adjustment remains exactly what the artifact says it is.
   ========================================================================== */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const FILE = path.join(ROOT, 'app.html');
let s = fs.readFileSync(FILE, 'utf8');

const MARK = "coaching_program:function(t){return t.coaching_program_rating;}";
const REQUIRED = [
  "['coaching_program','Coaching / Program']",
  'Measured and ranked, but not currently an ETSR input.',
  '<div class="pq-sec">Coaching / Program</div>',
  '<th>coaching / program</th>'
];
if (s.includes(MARK)) {
  const missing = REQUIRED.filter(x => !s.includes(x));
  if (missing.length) throw new Error('coaching/program UI appears partially patched; missing: ' + missing.join(' | '));
  console.log('[coaching-program-ui] already patched');
  process.exit(0);
}

function replaceOne(oldText, newText, label) {
  const n = s.split(oldText).length - 1;
  if (n !== 1) throw new Error(label + ': expected exactly one anchor, found ' + n);
  s = s.replace(oldText, newText);
}

replaceOne(
`  var rows=[['overall','Overall'],['talent','Talent'],['performance','Performance'],
    ['offense','Offense'],['defense','Defense'],['special_teams','Special teams'],`,
`  var rows=[['overall','Overall'],['talent','Talent'],['performance','Performance'],['coaching_program','Coaching / Program'],
    ['offense','Offense'],['defense','Defense'],['special_teams','Special teams'],`,
  'pipeline coaching row');

replaceOne(
`  add('Coaching / coordinator', 0,
    'no public, keyless feed carries coordinator history. The input is contracted for and stays absent rather than being guessed.');`,
`  var cpHealth=(FB.rk.health||D.pipeline_health||{}), cpCat=cpHealth.by_category&&cpHealth.by_category.coaching_program;
  add('Coaching / program',cpCat&&cpCat.coverage!=null?cpCat.coverage:null,
    'Measured from talent conversion, persistent overperformance, roster management and same-program development. Head-coach continuity is observed but not given a directional bonus; OC/DC history and game-management decision value remain unavailable rather than guessed.');`,
  'coverage coaching card');

replaceOne(
`var FBRK_TABS=[['overall','Overall'],['talent','Talent'],['performance','Performance'],
  ['offense','Offense'],['defense','Defense'],['special_teams','Special teams'],`,
`var FBRK_TABS=[['overall','Overall'],['talent','Talent'],['performance','Performance'],['coaching_program','Coaching / Program'],
  ['offense','Offense'],['defense','Defense'],['special_teams','Special teams'],`,
  'coaching tab');

replaceOne(
`  performance:function(t){return t.performance&&t.performance.rating;},
  offense:function(t){return t.performance&&t.performance.offense;},`,
`  performance:function(t){return t.performance&&t.performance.rating;},
  coaching_program:function(t){return t.coaching_program_rating;},
  offense:function(t){return t.performance&&t.performance.offense;},`,
  'coaching field');

replaceOne(
`  [['offense','Offense',t.performance.offense],['defense','Defense',t.performance.defense],
   ['special_teams','Special teams',t.special_teams&&t.special_teams.rating],`,
`  [['coaching_program','Coaching / Program',t.coaching_program_rating],
   ['offense','Offense',t.performance.offense],['defense','Defense',t.performance.defense],
   ['special_teams','Special teams',t.special_teams&&t.special_teams.rating],`,
  'every-component coaching row');

replaceOne(
`    h+='<div class="pq-note">'+fbEsc(t.movement.basis)+'</div>';
  } else h+='<div class="pq-note">'+fbEsc((t.movement&&t.movement.reason)||'no earlier snapshot to difference against')+'</div>';

  /* the rating as it was built */`,
`    var cm=t.movement.coaching_program;
    if(cm){
      h+='<div class="pq-sec">Coaching / Program movement</div>';
      if(cm.available){
        h+='<div class="pq-gate"><span class="mono">rating '+fbRkN(cm.rating.from)+' → '+fbRkN(cm.rating.to)
          +' ('+fbRkPts(cm.rating.delta)+')</span><span class="mono">raw '+fbRkN(cm.raw_score.from)+' → '+fbRkN(cm.raw_score.to)
          +'</span><span class="mono">reliability '+fbRkPct(cm.reliability.from)+' → '+fbRkPct(cm.reliability.to)+'</span></div>';
      } else h+='<div class="pq-note">'+fbEsc(cm.reason||'no comparable coaching/program snapshot')+'</div>';
      var cpm=[];
      for(var cpi in (cm.inputs||{})){if(!cm.inputs.hasOwnProperty(cpi))continue;
        var cpx=cm.inputs[cpi],vd=cpx.value&&cpx.value.delta,rd=cpx.reliability&&cpx.reliability.delta;
        if(vd==null&&rd==null)continue;
        if((vd==null||Math.abs(vd)<0.05)&&(rd==null||Math.abs(rd)<0.005))continue;
        cpm.push(cpx);
      }
      if(cpm.length){
        h+='<div style="overflow-x:auto"><table class="pq-tbl"><tr><th>subfactor</th><th>from</th><th>to</th><th>moved</th><th>reliability Δ</th></tr>'
          +cpm.map(function(x){return '<tr><td>'+fbEsc(x.label)+'</td>'
            +'<td class="mono">'+(x.value.from==null?'—':fbRkN(x.value.from))+'</td>'
            +'<td class="mono">'+(x.value.to==null?'—':fbRkN(x.value.to))+'</td>'
            +'<td class="mono">'+(x.value.delta==null?'—':fbRkPts(x.value.delta))+'</td>'
            +'<td class="mono">'+(x.reliability.delta==null?'—':fbRkPts(x.reliability.delta*100)+' pp')+'</td></tr>';}).join('')
          +'</table></div>';
      }
    }
    h+='<div class="pq-note">'+fbEsc(t.movement.basis)+'</div>';
  } else h+='<div class="pq-note">'+fbEsc((t.movement&&t.movement.reason)||'no earlier snapshot to difference against')+'</div>';

  /* the rating as it was built */`,
  'coaching movement');

replaceOne(
`    +'<tr><td>talent</td><td class="mono">'+fbRkPts(t.talent_points)+'</td>'
    +'<td class="mut" style="font-size:11px">roster ability, in points</td></tr>'
    +'<tr><td>home field</td><td class="mono">not included</td>'`,
`    +'<tr><td>talent</td><td class="mono">'+fbRkPts(t.talent_points)+'</td>'
    +'<td class="mut" style="font-size:11px">roster ability, in points</td></tr>'
    +'<tr><td>coaching / program adjustment</td><td class="mono">'+(t.coaching_program_adjustment_points==null?'—':fbRkPts(t.coaching_program_adjustment_points))+'</td>'
    +'<td class="mut" style="font-size:11px">Measured and ranked, but not currently an ETSR input.</td></tr>'
    +'<tr><td>home field</td><td class="mono">not included</td>'`,
  'ETSR adjustment row');

replaceOne(
`  /* §31 SPECIAL TEAMS — a measured team unit, with every component it used,
     every component it could not get, and what nobody can see at all. */
  h+='<div class="pq-sec">Special teams</div>';`,
`  /* COACHING / PROGRAM — arithmetic from the committed artifact only. */
  h+='<div class="pq-sec">Coaching / Program</div>';
  if(t.coaching_program_rating!=null){
    h+='<div class="pq-gate"><span class="pq-state">'+fbRkN(t.coaching_program_rating)+'</span>'
      +'<span class="mono">'+fbRkRank(t,'coaching_program')+'</span>'
      +'<span class="mono">reliability '+fbRkPct(t.coaching_program_reliability)+'</span>'
      +'<span class="mut">raw '+fbRkN(t.coaching_program_raw_score)+' · '+fbRkPct(t.coaching_program_observed_weight)+' configured weight observed</span></div>'
      +'<div class="pq-note"><b>Measured and ranked, but not currently an ETSR input.</b> Exact ETSR adjustment: '
      +(t.coaching_program_adjustment_points==null?'—':fbRkPts(t.coaching_program_adjustment_points))+'. '
      +'The published score is shrunk toward 50 as reliability falls.</div>';
  } else h+='<div class="pq-note">No coaching/program score was published. Missing evidence stays unavailable; it is never filled with a neutral 50.</div>';
  var cpin=t.coaching_program_inputs||{},cpLabels={
    talent_conversion:'Talent conversion',
    multi_season_program_overperformance:'Multi-season overperformance',
    roster_management_retention:'Roster management / retention',
    staff_continuity_stability:'Staff continuity / stability',
    development:'Development',
    game_management:'Game management'
  };
  h+='<div style="overflow-x:auto"><table class="pq-tbl"><tr><th>subfactor</th><th>rating</th><th>observations</th><th>reliability</th><th>updated</th><th>source / limitation</th></tr>';
  ['talent_conversion','multi_season_program_overperformance','roster_management_retention','staff_continuity_stability','development','game_management'].forEach(function(id){
    var x=cpin[id]||{};
    h+='<tr><td>'+fbEsc(cpLabels[id])+'</td>'
      +'<td class="mono">'+(x.value==null?'<span class="pq-miss">—</span>':fbRkN(x.value))+'</td>'
      +'<td class="mono">'+(x.observations==null?'—':x.observations)+'</td>'
      +'<td class="mono">'+fbRkPct(x.reliability)+'</td>'
      +'<td class="mono">'+fbEsc(x.last_updated?String(x.last_updated).slice(0,10):'—')+'</td>'
      +'<td class="mut" style="font-size:11px">'+fbEsc(x.source||x.reason||'unavailable')
        +(x.source&&x.reason?('<br>'+fbEsc(x.reason)):'')+'</td></tr>';
  });
  h+='</table></div>';
  if(t.coaching_program_warnings&&t.coaching_program_warnings.length){
    h+='<div class="pq-note"><b>Limitations:</b> '+t.coaching_program_warnings.map(function(w){return fbEsc(w.detail||w.id);}).join(' ')+'</div>';
  }
  h+='<div class="pq-note"><b>What nobody can see:</b> private locker-room dynamics, recruiting relationship quality, '
    +'staff-player trust, undisclosed NIL budgets and deal structure, and portal context that is not present in a structured public feed. '
    +'None of those is guessed, reputation-scored or filled in by a language model.</div>';

  /* §31 SPECIAL TEAMS — a measured team unit, with every component it used,
     every component it could not get, and what nobody can see at all. */
  h+='<div class="pq-sec">Special teams</div>';`,
  'coaching detail');

replaceOne(
`    +'<tr><th>week</th><th>ETSR</th><th>rank</th><th>Δ ETSR</th><th>offense</th><th>defense</th><th>special teams</th><th>talent</th><th>conf</th></tr>';`,
`    +'<tr><th>week</th><th>ETSR</th><th>rank</th><th>Δ ETSR</th><th>offense</th><th>defense</th><th>special teams</th><th>talent</th><th>coaching / program</th><th>CP rel</th><th>conf</th></tr>';`,
  'history header');

replaceOne(
`      +'<td class="mono">'+(r.talent==null?'<span class="pq-miss">—</span>':fbRkN(r.talent))+'</td>'
      +'<td class="mono">'+fbRkPct(r.confidence)+'</td></tr>';`,
`      +'<td class="mono">'+(r.talent==null?'<span class="pq-miss">—</span>':fbRkN(r.talent))+'</td>'
      +'<td class="mono">'+(r.coaching_program==null?'<span class="pq-miss">—</span>':(fbRkN(r.coaching_program)+' '+(r.coaching_program_rank==null?'ur':'#'+r.coaching_program_rank)))+'</td>'
      +'<td class="mono">'+fbRkPct(r.coaching_program_reliability)+'</td>'
      +'<td class="mono">'+fbRkPct(r.confidence)+'</td></tr>';`,
  'history coaching cells');

for (const x of REQUIRED) {
  if (!s.includes(x)) throw new Error('post-patch validation failed: missing ' + x);
}

fs.writeFileSync(FILE, s);
console.log('[coaching-program-ui] patched app.html');
