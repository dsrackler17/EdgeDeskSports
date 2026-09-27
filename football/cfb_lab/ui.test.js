#!/usr/bin/env node
/* ===========================================================================
   Tests for the CFB Model Lab page (admin/cfb-lab/index.html) as WIRED.

   The EDLAB block is cut out of the page between its markers and run in a
   sandbox against lab.json files written by the real lab modules
   (governance seed -> checkpoint runs at hourly times -> settle with
   readings -> report.run into a temporary directory):

     (a) the real lab.json shape: $CFB_LAB_SAMPLE or the committed
         football/cfb_lab/reports/<season>/lab.json when present, and always
         a generated pre-season ledger (OPEN snapshots only, reconstructed
         history settled) that has the same sparse shape
     (b) a populated ledger: two settled weeks of LIVE snapshots from V1,
         V2.1 and candidate 001, pushes, losses, a canceled game, a missed
         T24 window, a data-quality RED snapshot, miss reviews, CLV, and
         GIT_RECONSTRUCTED / REPLAY rows kept apart

   It cannot pass against a copy that drifted from the page. Nothing touches
   the real ledger. The fixture builders are exported for
   football/cfb_lab/record_section.test.js, which grades the same ledger.

   Run: node football/cfb_lab/ui.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const L = require('./lab_core.js');
const G = require('./ledger.js');
const MK = require('./market.js');
const CP = require('./checkpoint.js');
const ST = require('./settle.js');
const RP = require('./report.js');
const GOV = require('./governance.js');

const U = L.util;
const ROOT = path.join(__dirname, '..', '..');
const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

/* ---------------------------------------------------------------- fixtures */
const V1 = 'edgedesk_cfb_p4_v1.0.0', V21 = 'edgedesk_cfb_v2.1.0', V20 = 'edgedesk_cfb_v2.0.0';
const LABEL = { [V1]: 'V1', [V21]: 'V2.1 · hardened', [V20]: 'V2 · candidate 001' };
const HOSTILE = '<img src=x onerror=alert(1)>';
const HOSTILE2 = '<script>alert(2)</script>';
const H = 3600000;
const iso = (t) => new Date(t).toISOString();
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/* a projection shaped like models.js adapters return (tests.js §9 pattern) */
function proj(mv, g, margin, o) {
  o = o || {};
  return {
    model_version: mv, model_label: LABEL[mv], engine_id: 'test', source: 'test',
    projection_computed_at: iso(g.k - 120 * H), feature_ts: iso(g.k - 120 * H), feature_version: 'fv', calibration_version: 'cv', ensemble_version: 'ev', params_hash: 'ph',
    game: { game_id: g.id, season: 2026, week: g.week, season_type: 'regular', home: g.home, away: g.away, home_id: 'h' + g.id, away_id: 'a' + g.id, neutral_site: false, kickoff: iso(g.k) },
    pure: { margin, total: 52, p_home: U.r(1 / (1 + Math.exp(-margin / 8.5)), 4), sigma: 15, t_df: 100,
      intervals: { 50: [margin - 10, margin + 10], 80: [margin - 19, margin + 19], 95: [margin - 29, margin + 29] },
      home_pts: (52 + margin) / 2, away_pts: (52 - margin) / 2, confidence_raw: o.conf == null ? 75 : o.conf, ens_sd: o.ens_sd == null ? null : o.ens_sd },
    components: mv === V1 ? null : { C_ridge: margin - 0.8, D_gbm: margin + 0.6 },
    state: { data_completeness: 0.9, pbp_completeness: 1 },
    explain: { primary_edge: 'edge_epa', secondary_edge: null, primary_uncertainty: null, disagreement_summary: null },
    slateGame: o.slateGame || null, inputs: {},
    decide: (market) => {
      const gap = market && U.isNum(market.current_spread) ? margin - L.conv.bookToMargin(market.current_spread) : null;
      if (mv === V1) {
        const d = L.v1Decision(gap);
        return { status: d.status, side: d.side, decision_source: 'lab_rule', reason: d.reason, cover_probability: null, break_even_probability: 0.5238,
          estimated_ev: null, edge_quality: null, betting_reliability: null, threshold_distance: null, bet_enabled: false };
      }
      const a = U.isNum(gap) ? Math.abs(gap) : null, side = !U.isNum(gap) || gap === 0 ? null : (gap > 0 ? 'HOME' : 'AWAY');
      const status = a === null ? 'NOT_PRICED' : a >= 4 ? 'BET' : a >= 2 ? 'LEAN' : a >= 1.5 ? 'REVIEW' : 'PASS';
      const ev = a === null ? null : U.r(a * 0.02 - 0.015, 4);
      return { status, side, decision_source: 'engine', reason: 'test', cover_probability: a === null ? null : U.r(0.5 + a * 0.012, 4), break_even_probability: 0.5238,
        estimated_ev: ev, edge_quality: o.edge == null ? 50 : o.edge, betting_reliability: 80,
        threshold_distance: L.thresholdDistance(ev, a, 80, { lean_ev: 0, bet_ev: 0.06, bet_gap: 3, bet_min_rel: 0 }), bet_enabled: false };
    },
  };
}
function storeOpts(dir) { return { root: path.join(dir, 'ledger'), govRoot: path.join(dir, 'gov') }; }
function quote(g, t, line, book) {
  return MK.baseQuote({ game_id: g.id, season: 2026, week: g.week, source: 'odds_api', book: book || 'dk', market_type: 'spread', home_line: line,
    price_home: -110, price_away: -110, observed_at: iso(t), kickoff_ts: iso(g.k), retrieved_at: iso(t) });
}
function readOut(dir) {
  return { lab: JSON.parse(fs.readFileSync(path.join(dir, 'reports', 'lab.json'), 'utf8')), pub: JSON.parse(fs.readFileSync(path.join(dir, 'public.json'), 'utf8')) };
}
function report(dir, now) { RP.run({ now, season: 2026, storeOpts: storeOpts(dir), outDir: path.join(dir, 'reports'), publicPath: path.join(dir, 'public.json') }); return readOut(dir); }

/* (b) two settled weeks and an upcoming one */
async function populated(dir) {
  const so = storeOpts(dir), s = new G.Store(2026, so);
  GOV.seed(s);
  const R = rng(20261003);
  const weeks = [[6, Date.parse('2026-10-03T19:30:00Z')], [7, Date.parse('2026-10-10T19:30:00Z')], [8, Date.parse('2026-10-17T19:30:00Z')]];
  const games = [];
  weeks.forEach(([w, k]) => {
    for (let i = 0; i < (w === 8 ? 4 : 14); i++) {
      const line = w === 8 ? -3 : Math.round((R() * 24 - 14) * 2) / 2;   // the home line the T24 snapshot sees
      games.push({ id: 'lab' + w + '_' + String(i).padStart(2, '0'), week: w, k, home: 'Home ' + w + '-' + i, away: 'Away ' + w + '-' + i + (i === 5 ? ' A&M' : ''), line,
        open: line + [0, 0.5, -0.5, 1, -1][i % 5], close: line + [-0.5, 0, 0.5, -1, 1, 0][i % 6],
        d: [R() * 8 - 4, R() * 8 - 4, R() * 8 - 4], margin: w === 8 ? null : Math.round(-line + (R() * 2 - 1) * 16) });
    }
  });
  const gid = (id) => games.find((g) => g.id === id);
  /* a PUSH: V1 leans home at -3 and the home side wins by 3 */
  Object.assign(gid('lab6_00'), { line: -3, open: -3, close: -3.5, d: [3, 2.5, 1], margin: 3 });
  /* a LOSS: V1 leans home at -7 and the home side loses outright */
  Object.assign(gid('lab6_01'), { line: -7, open: -6.5, close: -7.5, d: [2.5, 1, -1], margin: -4 });
  /* the largest miss (so it is always listed); its home team is hostile markup */
  Object.assign(gid('lab6_02'), { home: HOSTILE, line: -10, open: -10, close: -10, d: [2, 1.5, 0.5], margin: -21 });
  /* MODEL_FAILURE: V1 is 11 off a close that was right */
  Object.assign(gid('lab6_03'), { line: -4, open: -4, close: -4, d: [11, 0.5, -0.5], margin: 4 });
  /* INFORMATION_CHANGE: the market moved 4 pts toward the result after the snapshot */
  Object.assign(gid('lab6_04'), { line: -3, open: -3, close: -7, d: [-2, -1, 0.5], margin: 20 });
  /* DATA_FAILURE: V1's snapshot is data-quality RED (teams swapped against the schedule) */
  gid('lab7_04').margin = Math.round(-gid('lab7_04').line + 18);
  gid('lab8_01').away = HOSTILE2;
  /* an upcoming game inside its T24 window when the report runs: an OFFICIAL row this week */
  games.push({ id: 'lab8_early', week: 8, k: Date.parse('2026-10-13T00:00:00Z'), home: 'Early Home', away: 'Early Away', line: -6.5, open: -6.5, close: null, d: [2.5, -1, 0.5], margin: null });
  const quotes = [];
  games.forEach((g) => {
    if (g.week === 8) { quotes.push(quote(g, Date.parse('2026-10-12T10:00:00Z'), g.open)); return; }
    quotes.push(quote(g, g.k - 110 * H, g.open), quote(g, g.k - 21 * H, g.line), quote(g, g.k - 21 * H, g.line, 'fd'), quote(g, g.k - H, g.close), quote(g, g.k - H, g.close, 'fd'));
  });
  s.appendQuotes(quotes);
  const redFor = (g, mv) => (g.id === 'lab7_04' || g.id === 'lab8_02') && mv === V1;
  const modelsFor = (skip) => [V1, V21, V20].map((mv, j) => ({ model_version: mv, label: LABEL[mv], projections: new Map(games.filter((g) => !(skip && skip(g, mv))).map((g, i) => [g.id,
    proj(mv, g, U.r(-g.line + g.d[j], 2), { conf: 55 + ((i * 7 + j * 5) % 44), ens_sd: mv === V1 ? null : U.r(0.4 + ((i * 3 + j) % 11) * 0.5, 2), edge: 5 + ((i * 13 + j * 7) % 90),
      slateGame: redFor(g, mv) ? { home_team: g.away, away_team: g.home, input_contract: [] } : null })])) }));
  /* V1 misses one week-7 T24 window (a checkpoint_missed alert, and no official row) */
  const missT24 = (g, mv) => g.id === 'lab7_06' && mv === V1;
  [100, 60, 30, 20, 8, 4, 1.5, 0.5].forEach((o) => [6, 7].forEach((w) => {
    const k = weeks.find((x) => x[0] === w)[1];
    CP.run({ now: iso(k - o * H), season: 2026, models: modelsFor((g, mv) => g.week !== w || (o === 20 && missT24(g, mv))), storeOpts: so });
  }));
  CP.run({ now: '2026-10-12T11:00:00.000Z', season: 2026, models: modelsFor((g) => g.week !== 8), storeOpts: so });
  /* reconstructed history, far off on purpose so it cannot hide in a live figure.
     (prediction_ts differs from the LIVE T24: the prediction id does not carry the origin) */
  const recon = [];
  games.filter((g) => g.week === 6).forEach((g) => [[V1, 'GIT_RECONSTRUCTED'], [V20, 'REPLAY']].forEach(([mv, origin]) => {
    const p = proj(mv, g, U.r(-g.line + 30, 2), { conf: 70, ens_sd: 1, edge: 50 });
    recon.push(CP.buildRow(p, 'T24', false, null, p.decide(null), { status: 'GREEN', checks: [] }, { now: iso(g.k - 22 * H), role: mv === V1 ? 'champion' : 'candidate', origin }));
  }));
  s.appendPredictions(recon);
  const readings = [{}, {}];
  games.filter((g) => g.week !== 8).forEach((g) => {
    if (g.id === 'lab7_13') { readings[0][g.id] = { source: 'espn', status: 'CANCELED' }; return; }
    const away = 17 + (g.margin < 0 ? -g.margin : 0), home = away + g.margin;
    readings[0][g.id] = { source: 'espn', status: 'FINAL', home_points: home, away_points: away, overtime: false };
    readings[1][g.id] = { source: 'cfbfastR', status: 'FINAL', home_points: home, away_points: away };
  });
  await ST.run({ now: '2026-10-11T06:00:00.000Z', season: 2026, offline: true, useRecord: false, storeOpts: so, readings });
  return Object.assign(report(dir, '2026-10-12T12:00:00.000Z'), { games });
}

/* (a) the pre-season shape the lab has on its first day: LIVE snapshots are
   all OPEN and unsettled; only reconstructed history has results */
async function sparse(dir) {
  const so = storeOpts(dir), s = new G.Store(2026, so);
  GOV.seed(s);
  const up = [0, 1, 2, 3, 4].map((i) => ({ id: 'pre5_' + i, week: 5, k: Date.parse('2026-10-03T16:00:00Z') + i * 3 * H, home: 'Pre Home ' + i, away: 'Pre Away ' + i, line: -3 - i }));
  const past = [0, 1, 2, 3].map((i) => ({ id: 'past4_' + i, week: 4, k: Date.parse('2026-09-20T19:00:00Z') + i * H, home: 'Past Home ' + i, away: 'Past Away ' + i, line: -1 - i }));
  s.appendQuotes(up.slice(0, 2).map((g) => quote(g, Date.parse('2026-09-27T07:23:14Z'), g.line)));
  CP.run({ now: '2026-09-27T12:07:00.000Z', season: 2026, storeOpts: so,
    models: [V1, V21, V20].map((mv, j) => ({ model_version: mv, label: LABEL[mv], projections: new Map(up.map((g) => [g.id, proj(mv, g, -g.line + j - 1, { ens_sd: mv === V1 ? null : 1.5 })])) })) });
  const recon = [];
  past.forEach((g) => [[V1, 'GIT_RECONSTRUCTED'], [V20, 'REPLAY']].forEach(([mv, origin]) => {
    const p = proj(mv, g, -g.line + 2, {});
    recon.push(CP.buildRow(p, 'T24', false, null, p.decide(null), { status: 'GREEN', checks: [] }, { now: iso(g.k - 20 * H), role: mv === V1 ? 'champion' : 'candidate', origin }));
  }));
  s.appendPredictions(recon);
  const rd = {}; past.forEach((g, i) => { rd[g.id] = { source: 'espn', status: 'FINAL', home_points: 24 + i * 3, away_points: 20, overtime: false }; });
  await ST.run({ now: '2026-09-27T12:07:00.000Z', season: 2026, offline: true, useRecord: false, storeOpts: so, readings: [rd] });
  return report(dir, '2026-09-27T12:07:00.000Z');
}
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cfblab-ui-')); }
/* the real sample, when one exists: $CFB_LAB_SAMPLE (a lab.json path) or the committed report */
function realSample() {
  const cands = [process.env.CFB_LAB_SAMPLE, path.join(__dirname, 'reports', String(CFG.season), 'lab.json')].filter(Boolean);
  for (const f of cands) {
    if (!fs.existsSync(f)) continue;
    let lastRun = null; try { lastRun = JSON.parse(fs.readFileSync(path.join(path.dirname(f), 'last_run.json'), 'utf8')); } catch (e) { /* optional */ }
    return { file: f, lab: JSON.parse(fs.readFileSync(f, 'utf8')), lastRun };
  }
  return null;
}

module.exports = { populated, sparse, proj, tmp, realSample, HOSTILE, HOSTILE2, V1, V21, V20 };

if (require.main === module) {
  let pass = 0, fail = 0; const failures = [];
  const chk = function (name, ok, detail) {
    if (typeof ok === 'function') { try { ok = ok(); } catch (e) { ok = false; detail = { threw: String((e && e.message) || e) }; } }
    if (ok) { pass++; return; }
    fail++; failures.push({ name, detail });
  };
  const done = function () {
    failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 500) : '')));
    console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
    process.exit(fail === 0 ? 0 : 1);
  };

  const PAGE = fs.readFileSync(path.join(ROOT, 'admin', 'cfb-lab', 'index.html'), 'utf8');
  const slice = (start, end, label) => {
    const a = PAGE.indexOf(start), b = PAGE.indexOf(end, a);
    if (a < 0 || b < 0) throw new Error('admin/cfb-lab/index.html no longer contains ' + label);
    return PAGE.slice(a, b + end.length);
  };
  const block = slice('/*__EDLAB_START__*/', '/*__EDLAB_END__*/', 'the EDLAB block');

  /* ---- structure ------------------------------------------------------------ */
  chk('the page is noindex, nofollow', /<meta name="robots" content="noindex, nofollow">/.test(PAGE));
  chk('no external script src', !/<script[^>]*\ssrc\s*=/i.test(PAGE));
  chk('no external stylesheet, font or import', !/<link[^>]+rel=["']?stylesheet/i.test(PAGE) && !/@import|fonts\.googleapis|fonts\.gstatic/i.test(PAGE));
  chk('colour tokens: dark by default, light by preference and by data-theme', /\.viz-root\{\s*color-scheme:dark/.test(PAGE) && /@media \(prefers-color-scheme: light\)/.test(PAGE) && /:root\[data-theme="light"\] \.viz-root/.test(PAGE) && /:root:where\(:not\(\[data-theme="dark"\]\)\) \.viz-root/.test(PAGE));
  chk('system font, 16px side gutter, no horizontal page scroll', /font-family:system-ui/.test(PAGE) && /\.wrap\{[^}]*padding:0 16px/.test(PAGE) && /body\.viz-root\{[^}]*overflow-x:hidden/.test(PAGE) && /\.scroll\{overflow-x:auto/.test(PAGE));
  chk('the header comment says what the page reads and that it computes nothing', /computes nothing of its own/.test(PAGE) && /reports\/<season>\/lab\.json/.test(PAGE) && /last_run\.json/.test(PAGE));
  chk('the pure block has no DOM, network or storage access', !/document\.|location\.|fetch\(|localStorage|sessionStorage|innerHTML/.test(block));
  chk('the boot reads lab.json and last_run.json from the season\'s report dir, ?season= else 2026', /'\.\.\/\.\.\/football\/cfb_lab\/reports\/'\+season\+'\/'/.test(PAGE) && /get\(base\+'lab\.json'\)/.test(PAGE) && /get\(base\+'last_run\.json'\)/.test(PAGE) && /:'2026'/.test(PAGE) && /typeof document==='undefined'/.test(PAGE));
  chk('the boot comes after the block', PAGE.indexOf('/*__EDLAB_END__*/') < PAGE.indexOf("getElementById('lab')"));

  const ctx = { window: {}, document: undefined, console };
  ctx.window.window = ctx.window;
  vm.createContext(ctx);
  vm.runInContext('(function(window){' + block + '})(window)', ctx);
  const E = ctx.window.EDLAB;
  chk('EDLAB exposes render and the per-section renderers', E && ['render', 'health', 'thisWeek', 'performance', 'comparison', 'errors', 'edge', 'market', 'governance', 'reconstructed', 'job', 'nav'].every((k) => typeof E[k] === 'function'));
  const IDS = (E && E.SECTIONS || []).map((s) => s[0]);
  chk('ten sections, in order', IDS.join() === 'health,this-week,performance,comparison,errors,edge,market,disagreement,governance,reconstructed', IDS);
  chk('the major-disagreement section renders from lab.json', E && typeof E.disagreement === 'function');

  /* ---- formatting ------------------------------------------------------------ */
  const F = E.fmt;
  chk('lines 1 dp (2 dp only for a quarter point), signed', F.ln(-3) === '-3.0' && F.ln(3.5) === '+3.5' && F.ln(-4.25) === '-4.25' && F.ln(0) === '0.0' && F.ln(-0.04) === '0.0');
  chk('MAE 2 dp, probabilities 3 dp, percents 1 dp', F.mae(8.816) === '8.82' && F.pr(0.24979) === '0.250' && F.pc(0.2727) === '27.3%' && F.pc(1) === '100.0%');
  chk('null, undefined and NaN render as an em dash', [F.ln, F.mae, F.pr, F.pc, F.fx].every((f) => f(null) === '—' && f(undefined) === '—' && f(NaN) === '—'));
  chk('times print as UTC minutes', F.when('2026-10-03T19:30:00.000Z') === '2026-10-03 19:30Z' && F.when(null) === '—');

  const clean = (h) => !/undefined|NaN|>null</.test(h);
  const tablesScroll = (h) => (h.match(/<table/g) || []).length === (h.match(/<div class="scroll"><table/g) || []).length;
  const sectionOf = (h, id) => { const a = h.indexOf('<section class="card" id="' + id + '"'); const b = h.indexOf('</section>', a); return a < 0 ? '' : h.slice(a, b); };
  const LIVE_IDS = ['health', 'this-week', 'performance', 'comparison', 'errors', 'edge', 'market'];

  (async () => {
    /* ---- nothing at all ------------------------------------------------------ */
    const none = E.render(null, null);
    chk('with no lab.json every section still renders, honestly empty', IDS.every((id) => none.indexOf('id="' + id + '"') >= 0) && /lab\.json did not load/.test(none) && clean(none));
    chk('with no last_run.json the job health says so', /last_run\.json was not found/.test(none));

    /* ---- (a) the real shape ------------------------------------------------- */
    const samples = [];
    const real = realSample();
    if (real) samples.push({ name: 'real sample ' + path.relative(ROOT, real.file), lab: real.lab, lastRun: real.lastRun });
    else console.log('note | no committed lab.json and no $CFB_LAB_SAMPLE: the real-shape checks use the generated pre-season ledger only');
    const sp = await sparse(tmp());
    samples.push({ name: 'generated pre-season', lab: sp.lab, lastRun: null });
    samples.forEach((S) => {
      const h = E.render(S.lab, S.lastRun);
      chk(S.name + ': every section id renders and the nav links to it', IDS.every((id) => h.indexOf('<section class="card" id="' + id + '"') >= 0 && h.indexOf('href="#' + id + '"') >= 0));
      chk(S.name + ': no "undefined", "NaN" or raw null in the output', clean(h), (h.match(/.{0,60}(undefined|NaN|>null<).{0,60}/) || [])[0]);
      chk(S.name + ': every table scrolls inside its own container', tablesScroll(h));
      const perf = sectionOf(h, 'performance');
      const settled = Object.keys(S.lab.performance || {}).reduce((a, m) => a + ((S.lab.performance[m].official || {}).errors || {}).n, 0);
      chk(S.name + ': the empty-performance state is honest', settled > 0 || /No official LIVE predictions have settled yet\./.test(perf));
      chk(S.name + ': null metrics render as an em dash, right-aligned', settled > 0 || /<td class="num">—<\/td>/.test(perf));
      chk(S.name + ': sample-size labels print beside the metrics', /<span class="ss">small sample<\/span>/.test(perf) && /<span class="ss">small sample<\/span>/.test(sectionOf(h, 'comparison')));
      chk(S.name + ': the six promotion gates render with their decision', ['G1', 'G2', 'G3', 'G4', 'G5', 'G6'].every((g) => sectionOf(h, 'comparison').indexOf('<b>' + g + '</b>') >= 0) && /INSUFFICIENT SAMPLE/.test(h) && /Eligibility never changes the champion/.test(h));
      chk(S.name + ': drift alerts are said never to act', /never retrain, re-weight, re-calibrate or promote anything/.test(sectionOf(h, 'health')));
      const rc = sectionOf(h, 'reconstructed');
      const rbm = (S.lab.reconstructed || {}).by_model || {};
      chk(S.name + ': the reconstructed section carries the NOT OFFICIAL banner', /Not official · not public · not used for promotion/.test(rc));
      chk(S.name + ': every reconstructed origin is labelled not official, and only there', Object.keys(rbm).every((m) => (rbm[m].origin || []).every((o) => rc.indexOf(o + ' · not official') >= 0))
        && LIVE_IDS.every((id) => !/GIT_RECONSTRUCTED|REPLAY/.test(sectionOf(h, id))));
      chk(S.name + ': governance lists the seeded experiments and partitions', /EXP-001/.test(sectionOf(h, 'governance')) && /live_observation_pool/.test(sectionOf(h, 'governance')));
      chk(S.name + ': this week shows every upcoming game', (S.lab.this_week || []).every((g) => sectionOf(h, 'this-week').indexOf(E.fmt.esc(g.home)) >= 0));
    });
    const sh = E.render(sp.lab, null);
    chk('pre-season: reconstructed history is populated while the live record is empty', Object.keys(sp.lab.reconstructed.by_model).length === 2 && /GIT_RECONSTRUCTED · not official/.test(sectionOf(sh, 'reconstructed')) && /REPLAY · not official/.test(sectionOf(sh, 'reconstructed')));
    chk('pre-season: the largest-misses table waits honestly', /No official LIVE predictions have settled yet\./.test(sectionOf(sh, 'errors')));

    /* ---- (b) a populated ledger ---------------------------------------------- */
    const P = await populated(tmp());
    const lab = P.lab;
    const lastRun = { started_at: '2026-10-12T12:00:00.000Z', season: 2026, finished_at: '2026-10-12T12:01:10.000Z', ok: false,
      steps: { seed: { ok: true, roles: 0, ms: 1 }, supabase_pull: { ok: true, skipped: 'no Supabase credentials', ms: 0 }, market: { ok: false, error: 'Error: ESPN 503 <html>', ms: 5012 },
        checkpoints: { ok: true, due: 12, taken: 12, ms: 700 }, verify: { skipped: true } } };
    const h = E.render(lab, lastRun);
    chk('populated: every section id renders', IDS.every((id) => h.indexOf('<section class="card" id="' + id + '"') >= 0));
    chk('populated: no "undefined", "NaN" or raw null', clean(h), (h.match(/.{0,60}(undefined|NaN|>null<).{0,60}/) || [])[0]);
    chk('populated: every table scrolls inside its own container', tablesScroll(h));
    chk('populated: the fixture has settled official games, a push, a loss and reconstructed rows', lab.performance[V1].official.errors.n >= 20 && P.pub.games.some((g) => g.result === 'PUSH') && P.pub.games.some((g) => g.result === 'LOSS') && Object.keys(lab.reconstructed.by_model).length === 2);

    /* escaping */
    chk('a hostile team name is escaped everywhere', h.indexOf(HOSTILE) < 0 && h.indexOf(HOSTILE2) < 0 && h.indexOf('<img') < 0 && h.indexOf('<script') < 0
      && h.indexOf('&lt;img src=x onerror=alert(1)&gt;') >= 0 && h.indexOf('&lt;script&gt;alert(2)&lt;/script&gt;') >= 0);
    chk('ampersands in team names are escaped', h.indexOf('A&amp;M') >= 0 && !/ A&M/.test(h));
    const hostileLab = JSON.parse(JSON.stringify(lab));
    /* <zq..> tags the page never emits: any that survive were not escaped */
    hostileLab.health.alerts.push({ kind: '<zq1>x', level: 'warn" onmouseover="x', message: '<zq2>m', detail: { '<zq3>': '<zq4>' }, model_version: '<zq5>' });
    hostileLab.governance.experiments.push({ id: '<zq6>', name: '<zq7>', status: '"><zq8>', change: ['<zq9>', '<zq10>'] });
    hostileLab.health.roles['<zq11 role="x">'] = { role: '"><zq12 onload=1>', label: '<zq13>', reason: '<zq14>', actor: '<zq15>' };
    hostileLab.error_analysis.miss_reviews['<zq16>'] = 2;
    hostileLab.health.data_quality.by_check['<zq17>'] = { YELLOW: 1, RED: 0 };
    const hh = E.render(hostileLab, { steps: { '<zq18>': { ok: false, error: '<zq19>' } } });
    chk('every string from the JSON is escaped, keys and attribute-bound values included', !/<zq/.test(hh) && !/onmouseover="x/.test(hh) && hh.indexOf('&lt;zq3&gt;: &lt;zq4&gt;') >= 0 && [1, 2, 5, 6, 7, 9, 11, 13, 14, 15, 16, 17, 18, 19].every((i) => hh.indexOf('&lt;zq' + i) >= 0), (hh.match(/.{0,40}<zq.{0,40}/) || [])[0]);

    /* health */
    const hl = sectionOf(h, 'health');
    chk('health: champion, ledger counts and DQ counts', hl.indexOf(V1) >= 0 && hl.indexOf('>' + lab.health.ledger.predictions + '<') >= 0 && /1 red/.test(hl) && /not GREEN/.test(hl));
    chk('health: the checkpoint_missed alert is listed', /checkpoint_missed/.test(hl) && /lab7_06/.test(hl));
    chk('health: the data-quality issue behind the RED game is shown', /team_mapping/.test(hl) && /swapped/.test(hl));
    chk('health: job health shows each step ok / failed / skipped with ms and the error escaped', /Job health/.test(hl) && />market</.test(hl) && /failed<\/span>/.test(hl) && />5012</.test(hl) && /ESPN 503 &lt;html&gt;/.test(hl) && /skipped<\/span>/.test(hl) && /no Supabase credentials/.test(hl));
    chk('health: feed staleness is measured against the report time', /h before this report/.test(hl));

    /* this week */
    const tw = sectionOf(h, 'this-week');
    chk('this week: every model\'s latest snapshot with checkpoint, fair line, margin, win p, decision, DQ', /Early Away/.test(tw) && /T24 <span class="chip good">official<\/span>/.test(tw) && /OPEN/.test(tw) && /V2\.1 · hardened/.test(tw) && /Home 8-0 -/.test(tw) && /chip bad">RED/.test(tw));
    chk('this week: the market (current, opening, books) is shown', /<td class="num" rowspan="3">-6\.5/.test(tw) && /-3\.0/.test(tw));

    /* performance */
    const pf = sectionOf(h, 'performance');
    const e1 = lab.performance[V1].official.errors;
    chk('performance: per-model official MAE, RMSE, median, bias, P90, P95, Brier, log loss, ECE, coverage', [F.mae(e1.mae), F.mae(e1.rmse), F.mae(e1.median_ae), F.mae(e1.p95_ae), F.pr(e1.brier), F.pr(e1.log_loss)].every((x) => pf.indexOf('>' + x + '<') >= 0) && /50% cov/.test(pf) && /95% cov/.test(pf) && /Win ECE/.test(pf), [F.mae(e1.mae), F.pr(e1.brier)]);
    chk('performance: numbers are right-aligned', pf.indexOf('<td class="num">' + F.mae(e1.mae) + '</td>') >= 0);
    chk('performance: rolling windows 25 / 50 / 100 / season / all', ['last 25', 'last 50', 'last 100', 'season to date', 'all LIVE'].every((w) => pf.indexOf(w) >= 0) && /not grounds for conclusions/.test(pf));
    chk('performance: V1 counts only its LIVE official snapshots', pf.indexOf('>' + e1.n + '<span class="ss">') >= 0 && e1.n === P.pub.counts.graded);

    /* reconstructed rows are labelled and never in a live figure */
    const rmae = F.mae(lab.reconstructed.by_model[V1].errors.mae);
    const rc = sectionOf(h, 'reconstructed');
    chk('reconstructed: its own MAE is shown, in its own section, labelled', rc.indexOf('>' + rmae + '<') >= 0 && /GIT_RECONSTRUCTED · not official/.test(rc) && /REPLAY · not official/.test(rc) && /Not official · not public · not used for promotion/.test(rc), rmae);
    chk('reconstructed: its numbers are absent from every live section', LIVE_IDS.concat(['governance']).every((id) => sectionOf(h, id).indexOf('>' + rmae + '<') < 0 && !/GIT_RECONSTRUCTED|REPLAY/.test(sectionOf(h, id))));

    /* comparison */
    const cm = sectionOf(h, 'comparison');
    chk('comparison: common set with opener and close rows and its n', /opening market/.test(cm) && /closing market/.test(cm) && cm.indexOf('n = ' + lab.comparison.common.n_common) >= 0 && /class="mkt"/.test(cm));
    chk('comparison: submodel scoreboard with its research-only note', /C_ridge/.test(cm) && /Research only: ensemble weights never change/.test(cm));
    const evs = lab.comparison.promotion.evaluations, gt = evs.reduce((a, e) => a + Object.keys(e.gates).filter((k) => e.gates[k]).length, 0);
    chk('comparison: each promotion evaluation names its challenger (a version string) and its champion', evs.length === 2 && evs.every((e) => typeof e.challenger === 'string' && typeof e.champion === 'string' && e.challenger_stats && e.champion_stats)
      && /<h4><b>V2\.1 · hardened<\/b> <span class="chip info">challenger<\/span> <span class="mv">edgedesk_cfb_v2\.1\.0<\/span> <span class="faint">vs champion<\/span> <b>V1<\/b>/.test(cm) && /<h4><b>V2 · candidate 001<\/b>/.test(cm));
    chk('comparison: every gate of every evaluation renders pass or fail, as lab.json says', (cm.match(/<li><span class="chip (good">pass|bad">fail)<\/span>/g) || []).length === 6 * evs.length && (cm.match(/chip good">pass/g) || []).length === gt && /Eligibility never changes the champion/.test(cm));
    chk('comparison: champion and challenger stats print side by side', cm.indexOf('<td>champion</td><td class="num">' + F.mae(evs[0].champion_stats.mae) + '</td>') >= 0 && cm.indexOf('<td>challenger</td><td class="num">' + F.mae(evs[0].challenger_stats.mae) + '</td>') >= 0);
    const old = JSON.parse(JSON.stringify(lab));
    old.comparison.promotion.evaluations.forEach((e) => { e.champion = e.champion_stats; e.challenger = e.challenger_stats; delete e.champion_stats; delete e.challenger_stats; });
    chk('comparison: an older lab.json (stats under challenger / champion) still names the model by its role', /<h4><b>V2\.1 · hardened<\/b>/.test(E.comparison(old)) && E.comparison(old).indexOf('<td>challenger</td><td class="num">' + F.mae(evs[0].challenger_stats.mae) + '</td>') >= 0);
    const elig = JSON.parse(JSON.stringify(lab));
    elig.comparison.promotion.evaluations[0] = Object.assign({}, elig.comparison.promotion.evaluations[0], { decision: 'ELIGIBLE', ready: true, n: 160,
      gates: { G1_mae_ci_below_zero: true, G2_brier_not_worse: true, G3_ece_within_001: true, G4_coverage80_in_band: true, G5_tail_not_worse: true, G6_weekly_stability: false } });
    const ce = E.comparison(elig);
    chk('comparison: an ELIGIBLE evaluation shows passing gates and still says it changes nothing', /chip good">ELIGIBLE/.test(ce) && (ce.match(/chip good">pass/g) || []).length === 5 + Object.keys(evs[1].gates).filter((k) => evs[1].gates[k]).length && /only a person, through governance\.js promote/.test(ce));

    /* errors */
    const er = sectionOf(h, 'errors');
    chk('errors: largest misses with classification and rationale', /MODEL FAILURE/.test(er) && /INFORMATION CHANGE/.test(er) && /DATA FAILURE/.test(er) && er.indexOf(E.fmt.esc(lab.error_analysis.largest_misses[0].matchup)) >= 0);
    chk('errors: miss-review counts for all five classes', ['MODEL FAILURE', 'DATA FAILURE', 'INFORMATION CHANGE', 'HIGH-VARIANCE', 'UNKNOWN'].every((c) => er.indexOf('>' + c + '</span>') >= 0) && er.indexOf('>' + lab.error_analysis.miss_reviews.UNKNOWN + '<') >= 0);
    chk('errors: segments with n, label, SE and z', /Segments/.test(er) && lab.error_analysis.segments.length > 0 && er.indexOf(E.fmt.esc(lab.error_analysis.segments[0].segment)) >= 0);

    /* edge */
    const ed = sectionOf(h, 'edge');
    chk('edge: the four bucket tables per model, gap buckets 0-1 ... 7+', ['0-1', '5-7', '7+', '90-100', '&lt;60', '80-100', 'very low', 'very high'].every((b) => ed.indexOf('>' + b + '<') >= 0) && (ed.match(/<details class="model"/g) || []).length === 3);
    chk('edge: decisions table BET / LEAN / RESEARCH / PASS with ATS, pushes, ROI, CLV, price assumed', ['BET', 'LEAN', 'RESEARCH', 'PASS'].every((c) => ed.indexOf('>' + c + '</span>') >= 0) && /W-L-P/.test(ed) && /Price assumed/.test(ed) && /ROI/.test(ed));
    chk('edge: timing by checkpoint, near misses and the process/outcome quadrant', /Timing by checkpoint/.test(ed) && /T72/.test(ed) && /Near misses/.test(ed) && /Good process/.test(ed) && /GOOD_PROCESS_LOSS = a bad beat/.test(ed));
    chk('edge: no flag is claimed below n = 30', /No RECALIBRATE flag/.test(ed) && /No DOES_NOT_SORT flag/.test(ed) && /No DISAGREEMENT_PREDICTS_ERROR flag/.test(ed));
    const fl = JSON.parse(JSON.stringify(lab));
    fl.edge_analysis[V21].buckets[1].flags = [{ flag: 'RECALIBRATE', detail: 'reliability 90-100 has MAE 12 vs 80-89 9 (> 1 SE): <higher> reliability is not smaller error' }];
    fl.edge_analysis[V21].buckets[3].flags = [{ flag: 'DISAGREEMENT_PREDICTS_ERROR', detail: 'very-high 14 vs very-low 9' }];
    fl.edge_analysis[V21].buckets[0].rows[0].label = 'provisional';
    const ef = E.edge(fl);
    chk('edge: RECALIBRATE / DISAGREEMENT_PREDICTS_ERROR flags render with their detail, escaped', /chip bad">RECALIBRATE/.test(ef) && /&lt;higher&gt; reliability/.test(ef) && /DISAGREEMENT_PREDICTS_ERROR<\/span> very-high/.test(ef));
    chk('edge: a provisional bucket label prints', /<span class="ss">provisional<\/span>/.test(ef));

    /* market */
    const mk = sectionOf(h, 'market');
    chk('market: vs opener, vs close, discovery and CLV per model', /vs opener/.test(mk) && /vs close/.test(mk) && /Moved toward/.test(mk) && /Closing line value/.test(mk) && mk.indexOf(F.pc(lab.market_discovery[V1].vs_close.beat_share)) >= 0);

    /* governance */
    const gv = sectionOf(h, 'governance');
    chk('governance: experiments, partitions, research queue, audit tail', /EXP-002/.test(gv) && /R2 components C\+D; R3 equal weights/.test(gv) && /future_holdout_pool/.test(gv) && /The research queue is empty\./.test(gv) && /ROLE_CHANGED/.test(gv));
    const rq = JSON.parse(JSON.stringify(lab));
    rq.governance.research_queue = [{ item_key: 'segment:x', title: 'V2.1: home underdog under-rated by 2.1 pts over 60 games', n: 60, effect: 2.1, effect_se: 0.9, status: 'OPEN', opened_at: '2026-10-12T12:00:00.000Z', updated_at: '2026-10-12T12:00:00.000Z', history: 1 }];
    chk('governance: an open research item renders', /home underdog under-rated/.test(E.governance(rq)) && /chip info">OPEN/.test(E.governance(rq)));

    done();
  })().catch((e) => { console.error(e); process.exit(1); });
}
