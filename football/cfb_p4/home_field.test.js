/* ============================================================================
   ONE CFB HOME FIELD — what must stay true.

     node football/cfb_p4/home_field.test.js        (exit 0 = green)

   1  ONE VALUE. The rating recursion learns every home result against the
      same home field every projection adds, and a neutral site gets 0.
   2  THE FILE IS THE RECORD. football/cfb_p4/home_field.js carries the value
      its walk-forward chose, the seeds rebuilt under it and the record that
      promoted it; it agrees with the committed report
      (football/validation/cfb_home_field.json).
   3  IT APPLIES ONLY WHERE IT WAS BUILT. An unpromoted file, or one built for
      a different params.js, changes nothing: the engine learns 3.2 and
      projects 4.082 exactly as v1.0.0 did.
   4  THE CHANGE IS VISIBLE. Promoted, every projection carries
      edgedesk_cfb_p4_v1.0.1; the board, the test harness, the pricing-path
      freeze and the Model Lab all see the file.
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
global.window = global.window || global;
require('./params.js');
const E = require('./engine.js');
const HF = require('./home_field.js');
const P = global.window.EDCfbP4Params;
const REPORT = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'validation', 'cfb_home_field.json'), 'utf8'));

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) pass++; else { fail++; console.log('FAIL | ' + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail))); }
}
const near = (a, b, eps) => isFinite(a) && isFinite(b) && Math.abs(a - b) <= (eps === undefined ? 1e-9 : eps);
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* ---------------------------------------------------------------- 2 the file */
chk('schema and version', HF.schema === 'edgedesk_cfb_home_field_v1' && HF.version === 'cfb_hfa_unified_v1');
chk('built for the shipped params.js', HF.for_params_built_at === P.built_at && HF.trained_through_season === P.trained_through_season,
  [HF.for_params_built_at, P.built_at]);
chk('it replaces the split params.js ships', HF.replaces.learned_in_rating_recursion === P.rating.hyperparams.hfa
  && HF.replaces.added_in_projection === P.venue.league_hfa, HF.replaces);
chk('the value is on its own grid', HF.grid.indexOf(HF.hfa) >= 0, HF.hfa);
chk('the value is the walk-forward choice for the next season', HF.hfa === REPORT.value_for_next_season.h
  && HF.hfa === REPORT.decision.value_for_next_season, [HF.hfa, REPORT.value_for_next_season]);
chk('promoted only when the switch is on and the rule passed', HF.promoted === (HF.switch === true && HF.passes_rule === true)
  && HF.passes_rule === REPORT.decision.passes, [HF.promoted, HF.switch, HF.passes_rule]);
const rec = REPORT.vs_current.walkfwd.test;
chk('the rule: pooled walk-forward MAE better by >= 0.05 and better in most seasons', REPORT.decision.passes === (rec.d_spread_mae <= -0.05
  && +REPORT.decision.seasons_better.split('/')[0] * 2 > +REPORT.decision.seasons_better.split('/')[1]), REPORT.decision);
chk('the file’s record is the report’s', HF.record.d_spread_mae === rec.d_spread_mae && HF.record.n === rec.n
  && HF.record.d_log_loss === rec.d_log_loss && HF.record.seasons_better === REPORT.decision.seasons_better);
chk('the seeds cover exactly the teams params.js seeds', Object.keys(HF.seed_ratings).sort().join() === Object.keys(P.rating.seed_ratings).sort().join());
chk('the recursion that rebuilt the seeds reproduces the trainer’s seeds under its own value',
  REPORT.seed_parity && REPORT.seed_parity['learn 4.082 (python reference)'].max_abs_diff < 0.001, REPORT.seed_parity);
const dSeed = Object.keys(P.rating.seed_ratings).map((t) => HF.seed_ratings[t] - P.rating.seed_ratings[t]);
const meanAbs = dSeed.reduce((a, d) => a + Math.abs(d), 0) / dSeed.length;
chk('the rebuilt seeds move by fractions of a point (the home field, not the teams, changed)',
  Math.max.apply(null, dSeed.map(Math.abs)) < 1.5 && meanAbs < 0.5, [Math.max.apply(null, dSeed.map(Math.abs)), meanAbs]);

/* ---------------------------------------------------------------- 1 one value */
chk('the engine applies it', !!E.homeField() && E.homeField().hfa === HF.hfa);
const st = E.newState();
chk('newState learns with it', st.hp.hfa === HF.hfa, st.hp.hfa);
chk('newState seeds from the rebuilt ratings', Object.keys(HF.seed_ratings).every((t) => st.r[t] === HF.seed_ratings[t]));
chk('the long-run prior starts at the same seeds', Object.keys(HF.seed_ratings).every((t) => st.r0[t] === HF.seed_ratings[t]));
const vh = E.situation.venueHfa(null, false, 'alabama');
chk('every projection adds the same value', vh.value === st.hp.hfa, vh);
chk('a neutral site gets 0', E.situation.venueHfa(null, true, 'alabama').value === 0);

/* absorb one home result and check the update used that value */
E.ingest.seasonBreak(st);
const K = E.normKey, k = st.hp.k, rH = E.strength.rating(st, K('Alabama'), true), rA = E.strength.rating(st, K('Georgia'), true);
E.ingest.absorbGame(st, { home: 'Alabama', away: 'Georgia', home_fbs: true, away_fbs: true, neutral_site: false, home_points: 24, away_points: 20 });
chk('the rating update learns against the same value', near(E.strength.rating(st, K('Alabama'), true) - rH, k * (4 - (rH - rA + HF.hfa)), 1e-9),
  [E.strength.rating(st, K('Alabama'), true) - rH, k * (4 - (rH - rA + HF.hfa))]);
const rH2 = E.strength.rating(st, K('Texas'), true), rA2 = E.strength.rating(st, K('Ohio State'), true);
E.ingest.absorbGame(st, { home: 'Texas', away: 'Ohio State', home_fbs: true, away_fbs: true, neutral_site: true, home_points: 21, away_points: 17 });
chk('a neutral-site result learns against 0', near(E.strength.rating(st, K('Texas'), true) - rH2, k * (4 - (rH2 - rA2)), 1e-9),
  [E.strength.rating(st, K('Texas'), true) - rH2, k * (4 - (rH2 - rA2))]);

/* a projection: its home-field term is the value, and its version says so */
const req = (neutral) => ({ season: P.trained_through_season + 1, week: 6, state: st,
  game: { home: 'Alabama', away: 'Georgia', home_fbs: true, away_fbs: true, neutral_site: neutral },
  teams: { home: { conference: 'SEC' }, away: { conference: 'SEC' } } });
const home = E.projectGame(req(false)), neutral = E.projectGame(req(true));
chk('a projection prices', home.status === 'PREDICTED' && neutral.status === 'PREDICTED', [home.status, neutral.status]);
const hfaTerm = (o) => ((o.contributions || []).find((c) => c.key === 'hfa') || {}).points;
chk('the projection’s home-field term is the value', near(hfaTerm(home), HF.hfa, 1e-9) && near(hfaTerm(neutral), 0, 1e-9), [hfaTerm(home), hfaTerm(neutral)]);
chk('the projection carries the new model version', home.model_version === HF.model_version && HF.model_version === 'edgedesk_cfb_p4_v1.0.1', home.model_version);
chk('the engine reports the effective version', E.version() === HF.model_version && E.meta().model_version === HF.model_version
  && E.meta().home_field.hfa === HF.hfa);
chk('the margin calibration shadow removes the home field actually applied',
  !home.model.margin_calibration || near(home.model.margin_calibration.applied_hfa, HF.hfa, 1e-9), home.model.margin_calibration);
chk('the live calibration shadow sees the home field actually applied',
  !home.model.live_calibration || /home field 2\.80/.test(home.model.live_calibration.equation || ''), home.model.live_calibration && home.model.live_calibration.equation);

/* ---------------------------------------------------------------- 3 only where built */
function isolated(hf) {
  const win = { console };
  win.window = win; win.globalThis = win;
  vm.createContext(win);
  vm.runInContext(read('football/cfb_p4/params.js'), win, { filename: 'params.js' });
  if (hf) win.EDCfbP4HomeField = hf;
  win.module = { exports: {} };
  vm.runInContext(read('football/cfb_p4/engine.js'), win, { filename: 'engine.js' });
  delete win.module;
  return win.EDCfbP4;
}
function asShipped(E2, label) {
  const s = E2.newState();
  chk(label + ': learns 3.2', s.hp.hfa === P.rating.hyperparams.hfa, s.hp.hfa);
  chk(label + ': projects 4.082', E2.situation.venueHfa(null, false, 'alabama').value === P.venue.league_hfa);
  chk(label + ': params.js seeds', Object.keys(P.rating.seed_ratings).every((t) => s.r[t] === P.rating.seed_ratings[t]));
  chk(label + ': v1.0.0', E2.version() === P.model_version && E2.homeField() === null, E2.version());
}
asShipped(isolated(null), 'no file');
asShipped(isolated(Object.assign({}, HF, { promoted: false })), 'unpromoted file');
asShipped(isolated(Object.assign({}, HF, { for_params_built_at: '2000-01-01T00:00:00+00:00' })), 'file built for another params.js');
const iso = isolated(HF);
chk('the browser global applies exactly as the require path does', iso.newState().hp.hfa === HF.hfa && iso.version() === HF.model_version);

/* ---------------------------------------------------------------- 4 visible */
const app = read('app.html');
const iEng = app.indexOf("fbScript('football/cfb_p4/engine.js')"), iHf = app.indexOf("fbScript('football/cfb_p4/home_field.js')");
chk('the board loads it right after the engine', iEng > 0 && iHf > iEng && !/home_field\.js'\)\.catch/.test(app));
chk('the board waits for it', /window\.EDCfbP4RegimeCurve&&window\.EDCfbP4HomeField\)return Promise\.resolve\(\)/.test(app));
chk('the board test harness loads it', /cfb_p4', 'home_field\.js'/.test(read('tools/football/_module.js')));
const F = require(path.join(ROOT, 'football', 'cfb_validation', 'freeze.js'));
chk('it is on the pricing-path freeze', F.PATHS.PRICING.indexOf('football/cfb_p4/home_field.js') >= 0);
const lastPricing = F.readJsonl(F.VERSIONS).filter((v) => v.kind === 'PRICING').pop();
chk('the freeze has a row for the current pricing path', lastPricing.fingerprint === F.fingerprint('PRICING').sha, lastPricing.version);
const LAB = require(path.join(ROOT, 'football', 'cfb_lab', 'models.js'));
const slate = JSON.parse(read('football/fbs/slate.json'));
const priced = (slate.games || []).filter((g) => g.model_version);
if (priced.length) {
  const fake = Object.assign({}, slate, { games: priced.slice(0, 3).map((g) => Object.assign({}, g, { model_version: HF.model_version })) });
  const A = LAB.v1Adapter({ slate: fake, slateHash: 'test' });
  const first = [...A.projections.values()][0];
  chk('the Model Lab keeps V1’s identity and records the build as its calibration version',
    !first || (first.model_version === P.model_version && first.calibration_version === HF.model_version), first && [first.model_version, first.calibration_version]);
}
const coverage = read('football/fbs/build_coverage.js');
chk('the coverage report states the effective version', /model_version: E\.version\(\)/.test(coverage));

console.log((fail === 0 ? 'ALL GREEN ' : 'FAILURES ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
