#!/usr/bin/env node
/* ============================================================================
   SP+ PROJECTION — the T2 transform (lib/cfb_sp_plus.js) and the week's
   derived lines (football/sp_plus/lines.js, through the sync). Offline.

   Run: node football/sp_plus/projection.test.js
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const SP = require('../../lib/cfb_sp_plus.js');
const LN = require('./lines.js');
const S = require('./sync.js');

let pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; return; }
  fail++; console.log('FAIL | ' + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 400)));
}
function eq(a, b, name) { ok(JSON.stringify(a) === JSON.stringify(b), name, { got: a, want: b }); }

/* ------------------------------------------------------------- the formula */
eq(SP.projectHomeMargin(10, 5, false, 2.8), 7.8, 'home SP+ − away SP+ + home field');
eq(SP.projectHomeMargin(10, 5, true, 2.8), 5, 'a neutral site gets no home field');
eq(SP.projectHomeMargin(10, 5, true, null), 5, 'a neutral site needs no home field value');
eq(SP.projectHomeMargin(-4.2, 9.8, false, 2.8), -11.2, 'an away favourite is a negative home margin');
eq(SP.projectHomeMargin(1.004, 1, false, 0), 0, 'stored at 0.01');
eq(SP.projectHomeMargin(-1.4, -1.4, false, 0), 0, 'never a negative zero');
eq(SP.projectHomeMargin(null, 5, false, 2.8), null, 'a missing rating projects nothing');
eq(SP.projectHomeMargin(10, NaN, false, 2.8), null, 'a non-finite rating projects nothing');
eq(SP.projectHomeMargin(10, 5, false, undefined), null, 'a home game without a home field value projects nothing');
eq(SP.homeLine(7.8), -7.8, 'home line is the book sign (− = home favoured)');
eq(SP.homeLine(-11.2), 11.2, 'and an away favourite is a positive home line');
eq(SP.homeLine(0), 0, 'a pick’em is 0, not −0');
eq(SP.lineText('James Madison', 'Troy', 16.5), 'James Madison −16.5', 'named for the home favourite');
eq(SP.lineText('Middle Tennessee', 'Kennesaw State', -1.26), 'Kennesaw State −1.3', 'named for the away favourite, at 0.1');
eq(SP.lineText('A', 'B', 0.04), 'Pick’em', 'under 0.05 is a pick’em');
eq(SP.lineText('A', 'B', null), null, 'nothing to name without a margin');

/* the 2026-10-28 case: EdgeDesk MTSU −4.5 (margin 4.52); SP+ 120th vs 125th */
{
  const sp = SP.projectHomeMargin(-12.6, -11.1, false, 2.8);
  eq(sp, 1.3, 'MTSU–KSU: SP+ puts Middle Tennessee about a point favourite at home');
  eq(SP.disagreement(4.52, sp), { points: 3.22, disagree: true }, 'and EdgeDesk’s 4.5 disagrees with it by 3+ points');
  eq(SP.disagreement(4.52, 2.0), { points: 2.52, disagree: false }, 'a 2.5-point gap is below the threshold');
  eq(SP.disagreement(1, 4).disagree, true, 'exactly 3 points is a disagreement');
  eq(SP.disagreement(null, 4), null, 'no EdgeDesk number, no comparison');
}

/* ------------------------------------------------------- pure, deterministic */
{
  const src = fs.readFileSync(LN.LIB, 'utf8');
  const tx = src.slice(src.indexOf('/*__TRANSFORM_START__*/'), src.indexOf('/*__TRANSFORM_END__*/'));
  ok(tx.length > 200 && /projectHomeMargin/.test(tx) && /disagreement/.test(tx), 'the transform is marked in the file');
  ok(!/Date\.now|new Date|Date\.parse|Math\.random|fetch\(|XMLHttpRequest/.test(tx.replace(/\/\*[\s\S]*?\*\//g, '')), 'the transform reads no clock, no randomness and no network');
  const a = [], b = [];
  for (let i = 0; i < 50; i++) { a.push(SP.projectHomeMargin(i * 0.37 - 9, 4.1 - i * 0.21, i % 3 === 0, 2.8)); }
  for (let i = 0; i < 50; i++) { b.push(SP.projectHomeMargin(i * 0.37 - 9, 4.1 - i * 0.21, i % 3 === 0, 2.8)); }
  eq(a, b, 'the same inputs give the same output, every time');
  /* the browser path: the page loads the file with a plain <script> tag */
  const win = { window: null };
  win.window = win;
  vm.runInNewContext(src, win, { filename: 'lib/cfb_sp_plus.js' });
  ok(win.EDCfbSpPlus && win.EDCfbSpPlus.projectHomeMargin(10, 5, false, 2.8) === 7.8, 'the same file runs in the browser as window.EDCfbSpPlus');
  eq([SP.TIER.rating, SP.TIER.line, SP.TIER.external, SP.TIER.edgedesk_model], ['T3', 'T2', true, false], 'labelled T3 external rating, T2 computed line, not an EdgeDesk model');
  ok(/ESPN, Bill Connelly/.test(SP.ATTRIBUTION) && /Data provided by CollegeFootballData\.com\./.test(SP.ATTRIBUTION), 'the attribution names SP+’s owner and CFBD’s recommended line');
}

/* ------------------------------------------- the engine's home field, one place */
{
  const hf = LN.appliedHomeField();
  const E = require('../cfb_p4/engine.js');
  eq(hf.hfa, E.homeField().hfa, 'the projection uses the home field the CFB engine applies');
  eq([hf.hfa, hf.source, hf.version], [2.8, 'football/cfb_p4/home_field.js', 'cfb_hfa_unified_v1'], 'today: 2.8 from football/cfb_p4/home_field.js');
  const fake = { homeField: () => null, _internal: { params: () => ({ venue: { league_hfa: 4.082 }, model_version: 'x' }) } };
  eq([LN.appliedHomeField(fake).hfa, LN.appliedHomeField(fake).source], [4.082, 'football/cfb_p4/params.js venue.league_hfa'],
    'and if the engine stopped applying that file, the projection follows the engine to params.js');
}

/* ------------------------------------------------------- a week's lines */
const SLATE = { season: 2026, current_week: { key: '2026:0:09', season: 2026, week: 9, season_type: 'regular' }, games: [
  { game_id: '401871058', season: 2026, week: 9, season_type: 'regular', kickoff: '2026-10-28T23:00:00.000Z', neutral_site: false,
    home_team: 'Middle Tennessee', away_team: 'Kennesaw State', home_team_id: 'middletennessee', away_team_id: 'kennesawstate', home_division: 'fbs', away_division: 'fbs' },
  { game_id: '401869963', season: 2026, week: 9, season_type: 'regular', kickoff: '2026-10-29T23:30:00.000Z', neutral_site: false,
    home_team: 'James Madison', away_team: 'Troy', home_team_id: 'jamesmadison', away_team_id: 'troy', home_division: 'fbs', away_division: 'fbs' },
  { game_id: 'N1', season: 2026, week: 9, season_type: 'regular', kickoff: '2026-10-31T16:00:00.000Z', neutral_site: true,
    home_team: 'Miami', away_team: 'Miami (OH)', home_team_id: 'miami', away_team_id: 'miamioh', home_division: 'fbs', away_division: 'fbs' },
  { game_id: 'F1', season: 2026, week: 9, season_type: 'regular', kickoff: '2026-10-31T17:00:00.000Z', neutral_site: false,
    home_team: 'James Madison', away_team: 'Wagner', home_team_id: 'jamesmadison', away_team_id: 'wagner', home_division: 'fbs', away_division: 'fcs' },
  { game_id: 'W10', season: 2026, week: 10, season_type: 'regular', kickoff: '2026-11-07T17:00:00.000Z', neutral_site: false,
    home_team: 'Troy', away_team: 'Middle Tennessee', home_team_id: 'troy', away_team_id: 'middletennessee', home_division: 'fbs', away_division: 'fbs' }
] };
const R = { middletennessee: { sp_overall: -12.6 }, kennesawstate: { sp_overall: -11.1 }, jamesmadison: { sp_overall: 9.8 }, troy: { sp_overall: -4.2 },
  miami: { sp_overall: 18.5 }, miamioh: { sp_overall: -3.3 } };
{
  const G = LN.buildGames(SLATE, R, { season: 2026, week_key: '2026:0:09' }, { hfa: 2.8 });
  eq(Object.keys(G).sort(), ['401869963', '401871058', 'F1', 'N1'], 'only the captured week’s games get a line');
  eq([G['401871058'].state, G['401871058'].home_margin, G['401871058'].home_line], ['AVAILABLE', 1.3, -1.3], 'MTSU–KSU: margin 1.3, home line −1.3');
  eq(G['401869963'].home_margin, 16.8, 'JMU–Troy: 9.8 − (−4.2) + 2.8');
  eq([G.N1.neutral, G.N1.home_margin], [true, 21.8], 'a neutral site: no home field');
  eq(G.F1.state, 'UNAVAILABLE', 'an FCS opponent has no SP+ rating: no line');
  ok(/no SP\+ rating for Wagner \(FCS: SP\+ rates FBS teams\)/.test(G.F1.reason), 'and the card says why', G.F1.reason);
  ok(Object.values(G).every((e) => !('sp_overall' in e) && !('home_sp' in e) && !('away_sp' in e)), 'no rating is carried into a game entry');
}

/* ------------------------------------------------ through the weekly sync */
(async () => {
  const sp = (team, r) => ({ year: 2026, team, rating: r, offense: { rating: 25 }, defense: { rating: 25 - r } });
  const body = [sp('Middle Tennessee', -12.6), sp('Kennesaw State', -11.1), sp('James Madison', 9.8), sp('Troy', -4.2), sp('Miami', 18.5), sp('Miami (OH)', -3.3)];
  const cfbd = async () => ({ ok: true, status: 200, json: async () => body });
  const db = { url: 'https://sb.test', key: 'k', fetch: async () => ({ ok: true, status: 201, text: async () => '' }), sleep: () => Promise.resolve() };
  const r = await S.run({ now: '2026-10-26T15:17:00.000Z', slate: SLATE, doc: S.emptyDoc(2026), key: 'test', cfbdFetch: cfbd, db });
  eq(r.status, 'OK', 'sync: OK');
  eq(r.doc.games['401871058'].home_line, -1.3, 'sync: publishes the derived line per game');
  eq([r.doc.projection.rule, r.doc.projection.hfa, r.doc.projection.hfa_source], ['cfb_sp_projection_v1', 2.8, 'football/cfb_p4/home_field.js'],
    'sync: names the rule and the home field it used, and where that came from');
  const text = JSON.stringify(r.doc);
  ok(['-12.6', '-11.1', '9.8', '-4.2', '18.5', '-3.3'].every((v) => text.indexOf(':' + v + ',') < 0 && text.indexOf(':' + v + '}') < 0), 'sync: the published file holds lines, never a rating value');
  /* a failure keeps last week's lines labelled last week */
  const s10 = Object.assign({}, SLATE, { current_week: { key: '2026:0:10', season: 2026, week: 10, season_type: 'regular' } });
  const f = await S.run({ now: '2026-11-02T15:17:00.000Z', slate: s10, doc: r.doc, key: 'test', cfbdFetch: async () => ({ ok: false, status: 503, json: async () => null }), db });
  eq([f.status, f.doc.snapshot.week_key, Object.keys(f.doc.games).includes('W10')], ['FAILED', '2026:0:09', false], 'sync: a failed week adds no line for that week');

  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
