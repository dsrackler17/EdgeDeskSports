#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');

assert.ok(APP.includes("var FB_URL_NFL_COACHING='/football/nfl/slate.json';"),
  'the live NFL board must load the committed Coaching / Staff research artifact');
assert.ok(APP.includes('function fbNflCoachingHTML(g){'),
  'the Coaching / Staff renderer must exist');
assert.ok(APP.includes('Applied to model:'),
  'the UI must state the applied adjustment explicitly');
assert.ok(APP.includes('Research candidate:'),
  'the UI must distinguish the candidate from the applied model');

const start = APP.indexOf('function fbNflCoachingHTML(g){');
const end = APP.indexOf('function fbGameCardNfl(u){', start);
assert.ok(start >= 0 && end > start, 'renderer slice must be extractable');

const ctx = {
  console, Math, String, Number, Object, Array, JSON, isFinite,
  FB: {
    nfl: {
      coachingByGame: {
        game1: {
          validation_status: 'CANDIDATE',
          affects_projection: false,
          tuned_candidate_cap: 1,
          validated_cap: 0,
          candidate_home_points: 0.6,
          candidate_away_points: -0.2,
          candidate_matchup_points: 0.8,
          adjustment_points: 0,
          home: {
            coach: 'Home Coach',
            coaching_staff_rating: 61.2,
            coaching_staff_rank: 5,
            coaching_staff_reliability: 0.72
          },
          away: {
            coach: 'Away Coach',
            coaching_staff_rating: 47.8,
            coaching_staff_rank: 19,
            coaching_staff_reliability: 0.63
          }
        }
      }
    }
  },
  fbEsc: s => String(s == null ? '' : s),
  fbPts: v => v == null ? '—' : ((v > 0 ? '+' : '') + Number(v).toFixed(1))
};
vm.createContext(ctx);
vm.runInContext(APP.slice(start, end), ctx, { filename: 'app.html:nfl-coaching-staff' });

const html = ctx.fbNflCoachingHTML({ game_id: 'game1', home_team: 'HOME', away_team: 'AWAY' });
assert.match(html, /Coaching \/ Staff/);
assert.match(html, /Home Coach/);
assert.match(html, /Away Coach/);
assert.match(html, /61\.2/);
assert.match(html, /72% rel/);
assert.match(html, /Research candidate:<\/b> \+0\.8 home-margin pts/);
assert.match(html, /validation CANDIDATE/);
assert.match(html, /Applied to model: \+?0\.0 points/);
assert.doesNotMatch(html, /validated cap.*1/i,
  'the tuned research cap must never be presented as the validated production cap');

/* Missing research context is not filled with a neutral score. */
ctx.FB.nfl.coachingByGame = {};
const missing = ctx.fbNflCoachingHTML({ game_id: 'missing', home_team: 'H', away_team: 'A' });
assert.match(missing, /research context not published/);
assert.match(missing, /Applied to model: <b>0\.0 points<\/b>/);
assert.doesNotMatch(missing, /50\.0/);

console.log('nfl coaching staff UI: passed');
