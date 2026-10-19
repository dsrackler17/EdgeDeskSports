/* ============================================================================
   THE CFB LIVE CALIBRATION — what must stay true.

     node football/cfb_p4/live_calibration.test.js        (exit 0 = green)

   1  SHADOW MEANS SHADOW. Unpromoted, the calibration changes no priced
      number, no probability, no sigma and no model version.
   2  ONE NUMBER. The calibrated probability is Phi(margin / sigma) of the
      calibrated margin, the cap included, and the projected score adds up.
   3  PROMOTION IS VISIBLE. Promoted, the priced number IS the calibrated one
      and the model version changes, which is how the record marks it.
   4  SIGN CONVENTION. A book line is negated once; a blend moves the margin
      toward the market on the same side; an orientation fault is never used.
   5  NO LEAKAGE. The walk-forward never reads a close, never reads a line
      observed after the pick was published, and a game's parameters do not
      change when anything that happened after its publication is changed.
   6  THE SWITCH. The generated file is promoted only when the config's
      switch is on AND the record passed the rule.
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
global.window = global.window || global;
require('./params.js');
const E = require('./engine.js');
const GEN = require('./live_calibration.js');
const LC = require('./research/live_calibration.js');
const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'live_calibration_config.json'), 'utf8'));
const P = global.window.EDCfbP4Params;

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) pass++; else { fail++; console.log('FAIL | ' + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail))); }
}
const near = (a, b, eps) => isFinite(a) && isFinite(b) && Math.abs(a - b) <= (eps === undefined ? 1e-9 : eps);

const teams = Object.keys(P.rating.seed_ratings);
const HOME = teams.indexOf('alabama') >= 0 ? 'Alabama' : teams[0];
const AWAY = teams.indexOf('georgia') >= 0 ? 'Georgia' : teams[1];
function req(extra) {
  const r = { season: P.trained_through_season, week: 6, state: E.newState(),
    game: { home: HOME, away: AWAY, neutral_site: false, kickoff: '2025-10-11T19:00:00Z' },
    teams: { home: { conference: 'SEC' }, away: { conference: 'SEC' } }, market: {} };
  return Object.assign(r, extra || {});
}
function withCalibration(c, fn) {
  const was = global.window.EDCfbP4LiveCalibration;
  global.window.EDCfbP4LiveCalibration = c;
  try { return fn(); } finally { global.window.EDCfbP4LiveCalibration = was; }
}
const none = {};   /* a loaded file with no parameters: the engine as it was */

/* ---------------------------------------------------------------- 1 */
const base = withCalibration(none, () => E.projectGame(req()));
const shadow = E.projectGame(req());
chk('a projection still prices', base.status === 'PREDICTED' && shadow.status === 'PREDICTED', [base.status, shadow.status]);
chk('the generated file is unpromoted', GEN.promoted === false, GEN.promoted);
chk('shadow: fair spread unchanged', shadow.model.fair_spread === base.model.fair_spread, [shadow.model.fair_spread, base.model.fair_spread]);
chk('shadow: win probability unchanged', shadow.model.home_win_prob === base.model.home_win_prob);
chk('shadow: sigma unchanged', shadow.model.sigma_margin === base.model.sigma_margin);
chk('shadow: model version unchanged', shadow.model_version === base.model_version && shadow.model_version === E.version(), shadow.model_version);
chk('shadow: cover probability unchanged',
  JSON.stringify(withCalibration(none, () => E.projectGame(req({ market: { spread_line: 3.5 } }))).cover)
  === JSON.stringify(E.projectGame(req({ market: { spread_line: 3.5 } })).cover));
chk('shadow: the calibrated number is published beside it', shadow.model.live_calibration && shadow.model.live_calibration.promoted === false
  && shadow.model.live_calibration.version === GEN.calibration_version, shadow.model.live_calibration);
chk('no file: no shadow block and nothing else moves', base.model.live_calibration === null);

/* ---------------------------------------------------------------- 2 */
const lc = shadow.model.live_calibration;
chk('one number: P(home) = Phi(margin / sigma)', near(lc.home_win_prob, E._internal.normCdf(lc.margin / lc.sigma), 1e-12), lc);
chk('one number: P(away) = 1 - P(home)', near(lc.away_win_prob, 1 - lc.home_win_prob, 1e-12));
chk('one number: the projected score adds to the total', near(lc.projected_home + lc.projected_away, lc.total, 1e-9));
chk('one number: the projected score differs by the margin', near(lc.projected_home - lc.projected_away, lc.margin, 1e-9));
chk('the candidate is the configured one', GEN.candidate === CONFIG.candidate && lc.candidate === CONFIG.candidate);
/* the home field the engine applied: params.js's league constant, or the
   one-home-field value once football/cfb_p4/home_field.js is promoted */
const appliedHfa = E.homeField() ? E.homeField().hfa : P.venue.league_hfa;
chk('HFA_PRE: margin = 0.9637 x (raw - applied home field) + 2.582 at a home venue',
  near(lc.margin, CONFIG.prior.k * (lc.raw_margin - appliedHfa) + CONFIG.prior.h, 1e-9), lc);
const neutral = E.projectGame(req({ game: { home: HOME, away: AWAY, neutral_site: true, kickoff: '2025-10-11T19:00:00Z' } }));
chk('neutral site: no home field is added back', near(neutral.model.live_calibration.margin, CONFIG.prior.k * neutral.model.live_calibration.raw_margin, 1e-9),
  neutral.model.live_calibration);

const apply = E.liveCalibration.apply;
const capped = apply({ params: { k: 1, h: null, p_cap: 0.95 } }, { raw_margin: 40, applied_hfa: 4.082, neutral: false, sigma: 14.9, total: 60 });
chk('cap: the probability stops at the cap', capped.home_win_prob <= 0.95 + 1e-9 && capped.capped === true, capped);
chk('cap: applied by widening sigma, so P = Phi(m / s) still', near(capped.home_win_prob, E._internal.normCdf(capped.margin / capped.sigma), 1e-12));
chk('cap: the margin itself is untouched', near(capped.margin, 40, 1e-9));
const probit = apply({ params: { k: 1, h: null, probit_a: 1.2, probit_b: -0.1 } }, { raw_margin: 10, applied_hfa: 4.082, neutral: false, sigma: 15 });
chk('probit: Phi(a z + b) is the same as one margin over one sigma',
  near(probit.home_win_prob, E._internal.normCdf(1.2 * 10 / 15 - 0.1), 1e-12) && near(probit.home_win_prob, E._internal.normCdf(probit.margin / probit.sigma), 1e-12), probit);

/* ---------------------------------------------------------------- 3 */
const promotedFile = Object.assign({}, GEN, { promoted: true });
const promoted = withCalibration(promotedFile, () => E.projectGame(req()));
chk('promoted: the priced margin is the calibrated margin', near(promoted.model.fair_spread, promoted.model.live_calibration.margin, 1e-12));
chk('promoted: the priced probability is the calibrated probability', near(promoted.model.home_win_prob, promoted.model.live_calibration.home_win_prob, 1e-12));
chk('promoted: sigma is the calibrated sigma', near(promoted.model.sigma_margin, promoted.model.live_calibration.sigma, 1e-12));
chk('promoted: the model version says so', promoted.model_version === GEN.model_version_if_promoted && promoted.model_version !== P.model_version, promoted.model_version);
chk('promoted: computed from the raw margin, so the shadow and the promoted numbers agree',
  near(promoted.model.live_calibration.margin, lc.margin, 1e-12));
chk('promoted: the raw margin is still published', near(promoted.model.raw_game_margin, base.model.fair_spread, 1e-12));

/* ---------------------------------------------------------------- 4 */
chk('a book line of -7 (home favoured) is a +7 home margin', LC.marginOfBookLine(-7) === 7 && LC.marginOfBookLine(3.5) === -3.5);
const bl = apply({ params: { k: 1, h: null, blend: { enabled: true, w: 0.25 } } }, { raw_margin: 15, applied_hfa: 4.082, neutral: false, sigma: 15, market_margin: LC.marginOfBookLine(-7) });
chk('blend: moves the model toward the market on the SAME side', near(bl.margin, 0.25 * 15 + 0.75 * 7, 1e-9) && bl.blend.used, bl);
const blOff = apply({ params: { k: 1, h: null, blend: { enabled: false, w: 0.25 } } }, { raw_margin: 15, applied_hfa: 4.082, neutral: false, sigma: 15, market_margin: 7 });
chk('blend: disabled means the market is not read', near(blOff.margin, 15, 1e-9) && blOff.blend === null, blOff);
const flip = apply({ params: { k: 1, h: null, blend: { enabled: true, w: 0.25 } } }, { raw_margin: 21.2, applied_hfa: 4.082, neutral: false, sigma: 15, market_margin: -20.5 });
chk('blend: an orientation fault is dropped, never blended or flipped', near(flip.margin, 21.2, 1e-9) && flip.blend && flip.blend.used === false, flip);
const blDis = apply({ params: { k: 1, h: null, blend: { enabled: true, w: 0.2, w_per_10_disagreement: -0.1 } } }, { raw_margin: 20, applied_hfa: 4.082, neutral: false, sigma: 15, market_margin: 10 });
chk('blend: w can fall with disagreement and is clamped to [0, 1]', near(blDis.blend.w, 0.1, 1e-12) && near(blDis.margin, 0.1 * 20 + 0.9 * 10, 1e-9), blDis);
chk('the generated candidate blends nothing', GEN.params.blend === null && CONFIG.blend.enabled === false);

/* ---------------------------------------------------------------- 5 */
const recFile = path.join(ROOT, 'record', 'football', 'cfb_' + (P.trained_through_season + 1) + '.json');
const recHash = crypto.createHash('sha256').update(fs.readFileSync(recFile)).digest('hex');
const D = LC.buildDataset(P.trained_through_season + 1);
chk('the dataset has graded games', D.rows.length > 100, D.rows.length);
chk('every market input was observed at or before its pick was published',
  D.rows.every((x) => x.pub_at == null || Date.parse(x.pub_at) <= Date.parse(x.pick_at)),
  D.rows.filter((x) => x.pub_at && Date.parse(x.pub_at) > Date.parse(x.pick_at)).slice(0, 3).map((x) => x.game_id));
chk('no market input is a close', D.rows.every((x) => !x.pub_src || !/close/i.test(x.pub_src)));
chk('every market input is pregame', D.rows.every((x) => x.pub_at == null || Date.parse(x.pub_at) < Date.parse(x.kickoff)));
const withLine = D.rows.filter((x) => x.pub_margin != null);
const corr = (a, b) => { const ma = a.reduce((s, v) => s + v, 0) / a.length, mb = b.reduce((s, v) => s + v, 0) / b.length;
  let s = 0, sa = 0, sb = 0; a.forEach((v, i) => { s += (v - ma) * (b[i] - mb); sa += (v - ma) ** 2; sb += (b[i] - mb) ** 2; }); return s / Math.sqrt(sa * sb); };
const cMp = corr(withLine.map((x) => x.model_margin), withLine.map((x) => x.pub_margin));
chk('sign check: the publish-time line and the model margin share a convention (correlation > 0.8)', withLine.length > 50 && cMp > 0.8, cMp);
chk('sign check: no publish-time line is an orientation fault', withLine.every((x) => !E.market.orientationFault(x.model_margin, x.pub_margin)));
const rec = JSON.parse(fs.readFileSync(recFile, 'utf8'));
chk('the model margin is the published pick, negated once',
  D.rows.every((x) => x.model_margin === -rec.games[x.game_id].pick.home_line));
chk('the evaluated probability is the published probability',
  D.rows.every((x) => x.p_home === null || x.p_home === rec.games[x.game_id].pick.home_win_prob));

const WF1 = LC.walkForward(D, CONFIG);
const pickOf = (w) => JSON.stringify(Object.keys(w.priced).sort().map((k) => [k, w.priced[k].margin, w.priced[k].p]));
/* change every close: nothing priced may move */
const D2 = { rows: D.rows.map((x) => Object.assign({}, x, { close_margin: -x.close_margin + 9, close_nv: 0.5, close_total: 0 })) };
const WF2 = LC.walkForward(D2, CONFIG);
chk('no priced number reads the close', WF1.length === WF2.length && WF1.every((w, i) => pickOf(w) === pickOf(WF2[i])));
/* change everything that happened after a cut: games published before it may not move */
const cut = Date.parse(WF1[Math.floor(WF1.length / 2)].x.pick_at);
const D3 = { rows: D.rows.map((x) => Date.parse(x.kickoff) >= cut
  ? Object.assign({}, x, { actual_margin: -x.actual_margin + 17, home_win: x.home_win === 1 ? 0 : 1, pub_margin: x.pub_margin == null ? null : x.pub_margin + 3 })
  : x) };
const WF3 = LC.walkForward(D3, CONFIG);
const before = WF1.map((w, i) => [w, WF3[i]]).filter(([w]) => Date.parse(w.x.pick_at) < cut && Date.parse(w.x.kickoff) < cut);
chk('a game published before the cut is priced the same whatever happened after it',
  before.length > 20 && before.every(([a, b]) => pickOf(a) === pickOf(b)), before.length);
chk('every training game had finished before the pick it trains',
  WF1.every((w) => w.train_n === D.rows.filter((g) => g.fbs_fbs && Date.parse(g.kickoff) + CONFIG.walk_forward.final_known_after_hours * 3600e3 < Date.parse(w.x.pick_at)).length));
chk('no scored game is in the initial training period', WF1.every((w) => w.x.week >= CONFIG.walk_forward.eval_from_week));
chk('FBS-vs-FCS games keep the published number in every option but the cap',
  WF1.filter((w) => !w.x.fbs_fbs).every((w) => Object.keys(w.priced).every((k) => k === 'CAP95' || (w.priced[k].margin === w.x.model_margin && w.priced[k].p === w.x.p_home))));
chk('the record is untouched by the fitter', crypto.createHash('sha256').update(fs.readFileSync(recFile)).digest('hex') === recHash);

/* ---------------------------------------------------------------- 6 */
chk('promoted only when the switch is on and the rule passed', GEN.promoted === (CONFIG.promote === true && GEN.status === 'VALIDATED'), [GEN.promoted, CONFIG.promote, GEN.status]);
chk('the generated parameters are the configured prior for a pre-registered candidate',
  CONFIG.candidate.indexOf('HFA_PRE') !== 0 || (GEN.params.k === CONFIG.prior.k && GEN.params.h === CONFIG.prior.h));
chk('the generated versions match the config', GEN.calibration_version === CONFIG.calibration_version
  && GEN.model_version_if_promoted === CONFIG.model_version_if_promoted && GEN.base_model_version === P.model_version);
const good = { n: 400, weeks_scored: 8, weeks_better: 7, d_brier: -0.004, d_brier_ci: [-0.007, -0.001], d_logloss: -0.01, d_mae: -0.1, games_needed: 300 };
const segOk = { group: [{ segment: 'p4', n: 200, d_brier: { X: -0.003 } }], margin_bucket: [], favourite_side: [] };
chk('decide: every condition met is VALIDATED', LC.decide('X', good, segOk, CONFIG, true).status === 'VALIDATED');
chk('decide: an interval touching zero is CANDIDATE', LC.decide('X', Object.assign({}, good, { d_brier_ci: [-0.007, 0.0004] }), segOk, CONFIG, true).status === 'CANDIDATE');
chk('decide: a degraded large segment blocks it', LC.decide('X', good, { group: [{ segment: 'p4', n: 200, d_brier: { X: 0.01 } }], margin_bucket: [], favourite_side: [] }, CONFIG, true).status === 'CANDIDATE');
chk('decide: a probability not built from the margin cannot be VALIDATED', LC.decide('X', good, segOk, CONFIG, false).status !== 'VALIDATED');
chk('decide: worse on Brier and log loss is REJECTED', LC.decide('X', Object.assign({}, good, { d_brier: 0.002, d_logloss: 0.01, d_brier_ci: [0.001, 0.003] }), segOk, CONFIG, true).status === 'REJECTED');

console.log((fail === 0 ? 'ALL GREEN ' : 'FAILURES ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
