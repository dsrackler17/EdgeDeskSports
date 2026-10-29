#!/usr/bin/env node
/* ============================================================================
   FOOTBALL SITUATIONAL INTELLIGENCE on the game cards, cut out of app.html.

   The glue block (window.fbSituationalHTML) is run in a vm with a stubbed
   window whose fetch serves a fixture cards.json. Checks: nothing renders
   before the artifact or for an unknown game; the NFL card renders a
   collapsible section, the FBS card a bare body for its own section frame;
   observed tendencies carry their samples and no grade; research is labelled
   experimental with its model version and as-of; a missing value renders as
   an explanation, never a zero; names are escaped; an empty market says no
   real line, never a number; the hooks are wired into both cards.
   Run: node tools/football/fsie_card_ui.test.js
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..', '..');
const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');

let n = 0, fails = 0;
function chk(what, cond, detail) { n++; if (cond) return; fails++; console.error('  FAIL: ' + what + (detail ? ' — ' + String(detail).slice(0, 300) : '')); }

const marker = APP.indexOf('/* ═══ FOOTBALL SITUATIONAL INTELLIGENCE ═══');
const open = APP.lastIndexOf('<script>', marker), close = APP.indexOf('</script>', marker);
chk('the glue block is in app.html', marker > 0 && open > 0 && close > marker);
const SRC = APP.slice(open + '<script>'.length, close);

const metric = (v, nn) => ({ v, n: nn });
const side = (name, opts) => Object.assign({
  team: { id: name, name },
  observed: { tier: 'A', missing_fields: [], offense: { early_down_pass_rate: metric(0.52, 210), neutral_pass_rate: metric(0.58, 190), third_down_pass_rate: metric(0.81, 60), red_zone_pass_rate: metric(0.44, 40),
    trailing_pass_rate: null, leading_run_rate: metric(0.55, 30), plays_per_game: metric(63.2, 7), neutral_seconds_per_play: metric(27.4, 150), shotgun_rate: metric(0.71, 440), no_huddle_rate: metric(0.05, 440),
    play_action_rate: metric(0.24, 420), motion_rate: metric(0.5, 420) }, defense: { pass_rate_faced: metric(0.6, 450), rush_rate_faced: metric(0.4, 450), neutral_pass_rate_faced: metric(0.57, 200), plays_per_game_allowed: metric(64, 7), box_count_avg: metric(6.6, 300), eight_plus_box_rate_vs_run: metric(0.18, 120) },
  sample: { games: 7, plays: 442, window: { first: '2026-09-10T00:00:00Z', last: '2026-10-26T00:00:00Z' } } },
  projection: { point: { plays: 64.8, pass_att: 37.1, rush_att: 25.7, drives: 10.8, pass_rate: 0.59 }, p10: { plays: 55, pass_att: 28, rush_att: 17 }, p50: { plays: 65 }, p90: { plays: 75, pass_att: 47, rush_att: 35 },
    script: { competitive: 0.58, leading: 0.15, trailing: 0.13, garbage: 0.03, two_minute: 0.11 }, missing_reasons: [] },
  players: [{ id: 'q', name: 'J. Love', role: 'QB', availability: 'NO_REPORT_LISTING', markets: { pass_att: { p10: 25, p50: 36, p90: 47 } } }],
  players_note: null
}, opts || {});
const FIX = { schema: 'edgedesk_fsie_cards_v1', built_at: '2026-10-29T14:00:00Z', games: {
  '2026_08_CAR_GB': { sport: 'nfl', game_id: '2026_08_CAR_GB', home: side('Green Bay Packers'), away: side('<script>alert(1)</script>'),
    research: { status: 'projected', model_version: 'situational_v1', as_of: '2026-10-29T14:00:00Z', market: [], market_state: { capture: { status: 'NOT_RUN', reason: 'GATEWAY_DEFERRED' } },
      validation: { state: 'holdout_evaluated', holdout_season: 2025, n_team_games: 570, plays: { model_mae: 6.6, season_avg_mae: 7.1, market_only_mae: 6.6 }, pass_att: { model_mae: 6.1, season_avg_mae: 6.7, market_only_mae: 6.4 }, rush_att: { model_mae: 5.8, season_avg_mae: 6.3, market_only_mae: 6.0 }, team_criteria_passed: false, player_criteria_passed: false },
      limitations: ['Experimental research model.'] }, updated_at: '2026-10-29T14:00:00Z' },
  '401856733': { sport: 'cfb', game_id: '401856733', home: side('Arkansas', { players: [], players_note: 'the team\'s latest game failed the player-attribution gate' }), away: side('Missouri', { projection: null }),
    research: { status: 'projected', model_version: 'situational_v1', as_of: '2026-10-29T14:00:00Z', market: [], validation: { state: 'not_evaluated' }, limitations: ['No college personnel feed.'] }, updated_at: '2026-10-29T14:00:00Z' }
} };

let resolveFetch;
const fetched = new Promise((r) => { resolveFetch = r; });
const win = { FB: { sport: 'nfl' }, renderFootball: () => {}, setTimeout: (fn) => { fn(); return 0; },
  fetch: (url) => { chk('the glue fetches the committed artifact', url === '/football/situational/data/cards.json', url); return Promise.resolve({ ok: true, json: () => Promise.resolve(FIX) }).then((r) => { setImmediate(resolveFetch); return r; }); } };
win.window = win;
const ctx = vm.createContext(Object.assign(win, { console, Date, JSON, Math, String, Object, Array, Number, isFinite, Promise, setImmediate }));
vm.runInContext(SRC, ctx);

chk('nothing renders before the artifact arrives', win.fbSituationalHTML('nfl', '2026_08_CAR_GB') === '');
fetched.then(() => new Promise((r) => setImmediate(r))).then(() => {
  const nfl = win.fbSituationalHTML('nfl', '2026_08_CAR_GB');
  chk('the NFL card gets a collapsible section', /^<details class="fsie-wrap"/.test(nfl) && /Situational Intelligence/.test(nfl));
  chk('observed tendencies carry their samples', /Early-down pass rate/.test(nfl) && /n 210/.test(nfl) && /7 games · 442 plays/.test(nfl));
  chk('observed tendencies carry no grade or pick', !/\b(BET|LEAN|grade [A-F]|edge)\b/i.test(nfl.split('Research Models')[0]));
  chk('a missing rate is an explanation, never 0%', /no trailing snaps/.test(nfl) && !/Trailing pass rate<\/span><span class="t"><i style="width:0%/.test(nfl));
  chk('research is labelled experimental, with model version and as-of', /Research Models \(Experimental\)/.test(nfl) && /rs-mat-exp/.test(nfl) && /situational_v1/.test(nfl) && /as of/.test(nfl));
  chk('projections show the median with its P10–P90', /64\.8/.test(nfl) && /55–75/.test(nfl) && /28–47/.test(nfl));
  chk('names are escaped', !/<script>alert/.test(nfl) && /&lt;script&gt;/.test(nfl));
  chk('no captured price: the card says so and compares nothing', /No captured price/.test(nfl) && /GATEWAY_DEFERRED/.test(nfl) && /Nothing is compared without a real line/.test(nfl));
  chk('the holdout summary is shown with the criteria verdict', /Untouched 2025 holdout/.test(nfl) && /NOT met/.test(nfl));
  const cfb = win.fbSituationalHTML('cfb', '401856733', { bare: true });
  chk('the FBS card gets a bare body for its own section frame', /^<div class="fsie-bare">/.test(cfb) && !/<details/.test(cfb));
  chk('college box/coverage is stated as unobserved', /not observed in any college feed/.test(cfb));
  chk('a team without a projection says so', /Missouri: no projection/.test(cfb));
  chk('a team without player projections says why', /failed the player-attribution gate/.test(cfb));
  chk('an unknown game renders nothing', win.fbSituationalHTML('nfl', 'nope') === '');
  chk('a sport mismatch renders nothing', win.fbSituationalHTML('cfb', '2026_08_CAR_GB') === '');
  /* wiring */
  chk('the NFL card calls the hook (predicted and unpredicted cards)', (APP.match(/window\.fbSituationalHTML\?window\.fbSituationalHTML\('nfl',g\.game_id\):''/g) || []).length === 2);
  chk('the FBS card frames it as its own section', /fbGxSec\(gid,'situational','Situational intelligence',\(window\.fbSituationalHTML\?window\.fbSituationalHTML\('cfb',gid,\{bare:true\}\):''\)/.test(APP));
  chk('the section is registered closed by default', /personnel:true,grade:false,situational:false\}/.test(APP));
  chk('the styles are its own (no reuse of another section\'s wrapper)', /<style id="fsie-styles">/.test(APP) && !/fsie-wrap[^"]*ms-wrap/.test(APP));
  console.log((fails ? 'FAILED ' : 'ok     ') + 'fsie card UI — ' + (n - fails) + '/' + n + ' checks');
  process.exit(fails ? 1 : 0);
});
