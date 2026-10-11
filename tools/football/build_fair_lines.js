#!/usr/bin/env node
/* ===========================================================================
   THE FAIR LINE SHEETS — every upcoming NFL and FBS game priced in every
   market EdgeDesk can price, from the committed projections and the
   linemaker's calibration record. Writes two things:

     football/linemaker/fair_lines.json
         the browser's and the desk's feed: one sheet per pregame game
         (lib/edgedesk_fairline.js sheet()), the per-league calibration
         status, tier and held-out bands, and the reference market beside it
         where one is on file (never called a price);

     football/linemaker/ledger/<season>/sheets.jsonl
         the APPEND-ONLY record of what EdgeDesk published: a game gets a new
         line only when its sheet changed, only before kickoff, and no
         existing line is ever rewritten or removed (the build refuses to run
         over a ledger it cannot read back exactly, and --check verifies it).

   Inputs (all committed, no network, no market read for the projection):
     football/nfl/slate.json, football/fbs/slate.json      the projections
     football/validation/linemaker_<nfl|cfb>.json           the calibration
     football/cfb_lab/ledger/<season>/lines.jsonl           CFB consensus open (reference)
   The NFL reference is the slate's own nflverse consensus line, labelled by
   the slate as "reference, not a price".

   Run:
     node tools/football/build_fair_lines.js [--now ISO] [--out DIR] [--no-ledger]
     node tools/football/build_fair_lines.js --check
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..', '..');
const FL = require(path.join(ROOT, 'lib', 'edgedesk_fairline.js'));
const { writeIfChanged } = require(path.join(__dirname, 'write_if_changed.js'));

const SCHEMA = 'edgedesk_fair_lines_v1';
const LEDGER_SCHEMA = 'edgedesk_fair_line_record_v1';
const LEAGUE = {
  nfl: { sport: 'americanfootball_nfl', label: 'NFL', slate: 'football/nfl/slate.json', calib: 'football/validation/linemaker_nfl.json' },
  cfb: { sport: 'americanfootball_ncaaf', label: 'CFB', slate: 'football/fbs/slate.json', calib: 'football/validation/linemaker_cfb.json' }
};

function num(v) { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function readJson(rel) { try { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')); } catch (_) { return null; } }
function sha(text) { return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16); }
function erfinv(p) { /* inverse normal, Acklam */ const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00], b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01], c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00], d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00]; const pl = 0.02425; let q, r; if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); } if (p > 1 - pl) { q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); } q = p - 0.5; r = q * q; return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1); }

/* ------------------------------------------------------- engine hooks */
function engineHooks(league) {
  const ou = (c) => (c ? { over: c.win, push: c.push, under: c.lose } : null);
  if (league === 'nfl') {
    const E = require(path.join(ROOT, 'football', 'engine.js'));
    return { cover: (raw, thr) => ou(E.dist.coverProbSpread('nfl', raw.home_margin, thr)), over: (raw, L) => ou(E.dist.coverProbTotal('nfl', raw.total, L, 'over')), winProb: (raw) => E.dist.winProb('nfl', raw.home_margin), version: E.version() };
  }
  global.window = global.window || global;
  require(path.join(ROOT, 'football', 'cfb_p4', 'params.js'));
  const C = require(path.join(ROOT, 'football', 'cfb_p4', 'engine.js'));
  const P = global.window.EDCfbP4Params;
  const base = (P.volatility && P.volatility.sigma_base) || (P.distributions && P.distributions.sigma_margin) || 15;
  return { cover: (raw, thr) => ou(C.dist.coverProbSpread(raw.home_margin, thr, raw.sigma || base, base)), over: (raw, L) => ou(C.dist.coverProbTotal(raw.total, L, 'over')), winProb: (raw) => C.dist.winProb(raw.home_margin, raw.sigma || base), version: P.model_version, sigma_base: base };
}

/* -------------------------------------------------- the reference markets */
function cfbOpeners(season) {
  const out = {}, f = path.join(ROOT, 'football', 'cfb_lab', 'ledger', String(season), 'lines.jsonl');
  if (!fs.existsSync(f)) return out;
  fs.readFileSync(f, 'utf8').split('\n').forEach((l) => {
    if (!l.trim()) return; let r; try { r = JSON.parse(l); } catch (_) { return; }
    if (r.kind !== 'OPEN' || r.quality === 'MISSING' || !r.observed_at) return;
    const o = out[r.game_id] = out[r.game_id] || { kind: 'OPEN', source: 'EdgeDesk CFB Model Lab consensus opener (' + (r.n_books || 0) + ' book' + (r.n_books === 1 ? '' : 's') + ')', observed_at: r.observed_at };
    if (r.market_type === 'spread' && r.home_line != null) o.home_line = num(r.home_line);
    if (r.market_type === 'total' && r.total_points != null) o.total = num(r.total_points);
    if (r.market_type === 'moneyline') { o.home_ml = num(r.price_home); o.away_ml = num(r.price_away); }
  });
  return out;
}

/* ------------------------------------------------------- the inputs */
function inputsFor(league, slate, now) {
  const L = LEAGUE[league], rows = [], refused = [];
  const H = engineHooks(league);
  const openers = league === 'cfb' ? cfbOpeners(slate && slate.season) : {};
  (slate && slate.games || []).forEach((g) => {
    const kick = Date.parse(g.kickoff);
    const id = String(g.game_id);
    if (!Number.isFinite(kick)) { refused.push({ game_id: id, sport: L.sport, reason: 'no kickoff time' }); return; }
    if (kick <= now) return; /* started or final: no new sheet, the ledger already holds the pregame one */
    if (g.model_status !== 'PREDICTED') { refused.push({ game_id: id, sport: L.sport, reason: 'no projection (model status ' + (g.model_status || 'unknown') + ')' }); return; }
    if (num(g.model_home_margin) == null || num(g.model_fair_total) == null) { refused.push({ game_id: id, sport: L.sport, reason: 'the projection carries no ' + (num(g.model_home_margin) == null ? 'fair margin' : 'fair total') + ', so no sheet is priced' }); return; }
    if (league === 'cfb' && g.kickoff_tbd) { /* a TBA kickoff is still pregame; it is priced and labelled */ }
    const raw = { home_margin: num(g.model_home_margin), total: num(g.model_fair_total), home_win_prob: num(g.model_home_win_prob) };
    if (league === 'cfb') {
      /* the engine's own game sigma: published in disagreement_inputs, else
         recovered exactly from its win probability (P = Φ(margin / σ)) */
      const di = g.disagreement_inputs && g.disagreement_inputs.projection;
      let sg = di ? num(di.sigma) : null;
      if (sg == null && raw.home_win_prob > 0.001 && raw.home_win_prob < 0.999 && Math.abs(raw.home_margin) >= 0.5) sg = raw.home_margin / erfinv(raw.home_win_prob);
      raw.sigma = sg && sg > 0 ? sg : null; raw.sigma_base = H.sigma_base;
    }
    let reference = null;
    if (league === 'nfl' && g.reference_market && (g.reference_market.home_line != null || g.reference_market.total != null)) {
      reference = { kind: 'CONSENSUS', source: g.reference_market.source || 'nflverse consensus (reference, not a price)', home_line: num(g.reference_market.home_line), total: num(g.reference_market.total), home_ml: num(g.reference_market.home_ml), away_ml: num(g.reference_market.away_ml), observed_at: null, is_price: false };
    } else if (league === 'cfb' && openers[id]) {
      reference = Object.assign({ is_price: false }, openers[id]);
    }
    rows.push({
      input: { sport: L.sport, game_id: id, home: g.home_team, away: g.away_team, kickoff: g.kickoff, raw, reference },
      meta: { league: L.label, season: num(g.season), week: num(g.week), neutral_site: !!(g.neutral_site || (g.data_quality && /neutral/i.test(JSON.stringify(g.data_quality.warnings || [])))),
        kickoff_tbd: !!g.kickoff_tbd, model_version: g.model_version || (league === 'cfb' ? H.version : null), data_quality: g.data_quality || (g.reliability_grade ? { reliability_grade: g.reliability_grade } : null) }
    });
  });
  return { rows, refused, hooks: H };
}

/** reference comparisons: arithmetic on the reference line, never an EV (no price) */
function versusReference(sh, ref) {
  if (!ref || !sh || !sh.ok) return null;
  const out = { source: ref.source, kind: ref.kind, observed_at: ref.observed_at || null, is_price: false };
  if (ref.home_line != null && sh.markets.spread) {
    const p = FL.probabilities(sh, { market: 'spread', side: 'home', line: ref.home_line });
    out.spread = { home_line: ref.home_line, gap_points: Math.round((sh.markets.spread.fair_home_line - ref.home_line) * 10) / 10, home_cover: p && !p.error ? round4(p.win) : null, push: p && !p.error ? round4(p.push) : null, away_cover: p && !p.error ? round4(p.lose) : null };
  }
  if (ref.total != null && sh.markets.total) {
    const p = FL.probabilities(sh, { market: 'total', side: 'over', line: ref.total });
    out.total = { line: ref.total, gap_points: Math.round((sh.markets.total.fair_total - ref.total) * 10) / 10, over: p && !p.error ? round4(p.win) : null, push: p && !p.error ? round4(p.push) : null, under: p && !p.error ? round4(p.lose) : null };
  }
  if (ref.home_ml != null && ref.away_ml != null) out.moneyline = { home_ml: ref.home_ml, away_ml: ref.away_ml, no_vig: FL.noVig(ref.home_ml, ref.away_ml) };
  return out;
}
function round4(v) { return v == null ? null : Math.round(v * 10000) / 10000; }

/* ------------------------------------------------------- the ledger */
function ledgerFile(dir, season) { return path.join(dir, 'ledger', String(season), 'sheets.jsonl'); }
function readLedger(file) {
  if (!fs.existsSync(file)) return { text: '', rows: [] };
  const text = fs.readFileSync(file, 'utf8');
  const rows = [];
  text.split('\n').forEach((l, i) => { if (!l.trim()) return; try { rows.push(JSON.parse(l)); } catch (e) { throw new Error(path.relative(ROOT, file) + ' line ' + (i + 1) + ' does not parse: the ledger is append-only and is never repaired by the build'); } });
  return { text, rows };
}
/* A new ledger record is written only when the sheet MOVED: a fair line by a
   half point, a moneyline by a percentage point, a method, a status or the
   calibration record behind it. A projection that wobbles by a tenth is the
   same published number and is not recorded again. */
function fingerprint(sh, calib) {
  const m = sh.markets, h = (v) => (v == null ? null : Math.round(v * 2) / 2), p = (v) => (v == null ? null : Math.round(v * 100) / 100);
  return sha(JSON.stringify([
    m.spread && [h(m.spread.fair_home_line), m.spread.method, m.spread.status],
    m.moneyline && [p(m.moneyline.home_win), m.moneyline.method, m.moneyline.status],
    m.total && [h(m.total.fair_total), m.total.method, m.total.status],
    m.team_total && [h(m.team_total.home_fair), h(m.team_total.away_fair), m.team_total.method, m.team_total.status],
    calib && calib.sha,
    sh.reference_versus && sh.reference_versus.spread && sh.reference_versus.spread.home_line,
    sh.reference_versus && sh.reference_versus.total && sh.reference_versus.total.line]));
}
function ledgerRecord(sh, meta, nowIso, calib) {
  const m = sh.markets, rv = sh.reference_versus;
  const rec = {
    schema: LEDGER_SCHEMA, game_id: sh.game_id, sport: sh.sport, league: meta.league, season: meta.season, week: meta.week,
    home: sh.home, away: sh.away, kickoff: sh.kickoff, recorded_at: nowIso, fingerprint: sh.fingerprint,
    model_version: meta.model_version, calibration: calib, fairline_version: FL.VERSION,
    centres: sh.centres,
    spread: m.spread ? { fair_home_line: m.spread.fair_home_line, at_fair: m.spread.at_fair, method: m.spread.method, status: m.spread.status, tier: m.spread.tier } : null,
    moneyline: m.moneyline ? { home_win: m.moneyline.home_win, away_win: m.moneyline.away_win, tie: m.moneyline.tie, home_fair: m.moneyline.home_fair, away_fair: m.moneyline.away_fair, method: m.moneyline.method, status: m.moneyline.status, tier: m.moneyline.tier } : null,
    total: m.total ? { fair_total: m.total.fair_total, method: m.total.method, status: m.total.status, tier: m.total.tier } : null,
    team_total: m.team_total ? { home_fair: m.team_total.home_fair, away_fair: m.team_total.away_fair, method: m.team_total.method, status: m.team_total.status } : null,
    /* the probabilities at the half points the grader scores against, frozen now */
    at_lines: atLines(sh),
    reference: rv || null
  };
  rec.record_id = 'flr_' + sha(JSON.stringify(rec));
  return rec;
}
/** probabilities frozen at the half points near the fair number (spread and
    total ±7, team totals ±4), so the grader never has to rebuild a distribution */
function atLines(sh) {
  const o = { spread: {}, total: {}, home_team_total: {}, away_team_total: {} }, m = sh.markets;
  const near = (v, c, w) => c != null && Math.abs(v - c) <= w + 1e-9;
  const cs = m.spread ? m.spread.fair_home_line_half : null, ct = m.total ? m.total.fair_total_half : null;
  const ch = m.team_total ? m.team_total.home_fair_half : null, ca = m.team_total ? m.team_total.away_fair_half : null;
  (sh.ladders.spread || []).forEach((r) => { if (near(r.home_line, cs, 7)) o.spread[r.home_line] = [r.home, r.push, r.away]; });
  (sh.ladders.total || []).forEach((r) => { if (near(r.line, ct, 7)) o.total[r.line] = [r.over, r.push, r.under]; });
  (sh.ladders.home_team_total || []).forEach((r) => { if (near(r.line, ch, 4)) o.home_team_total[r.line] = [r.over, r.push, r.under]; });
  (sh.ladders.away_team_total || []).forEach((r) => { if (near(r.line, ca, 4)) o.away_team_total[r.line] = [r.over, r.push, r.under]; });
  return o;
}

/* --------------------------------------------------------- the build */
function build(opts) {
  opts = opts || {};
  const now = opts.now != null ? Date.parse(opts.now) : Date.now();
  const nowIso = new Date(now).toISOString();
  const outDir = opts.out || path.join(ROOT, 'football', 'linemaker');
  const games = [], refused = [], models = {}, inputs = {};
  ['nfl', 'cfb'].forEach((lg) => {
    const L = LEAGUE[lg];
    const cal = opts.calibration && opts.calibration[lg] ? opts.calibration[lg] : readJson(L.calib);
    const slate = opts.slates && opts.slates[lg] ? opts.slates[lg] : readJson(L.slate);
    inputs[lg] = { slate: L.slate, slate_generated_at: slate ? slate.generated_at : null, calibration: L.calib, calibration_generated_at: cal ? cal.generated_at : null };
    if (!cal || !cal.live) { refused.push({ sport: L.sport, reason: 'no calibration record (' + L.calib + '): run tools/football/linemaker_calibrate.js' }); return; }
    if (!slate) { refused.push({ sport: L.sport, reason: 'no slate (' + L.slate + ')' }); return; }
    const calibRef = { file: L.calib, generated_at: cal.generated_at, sha: sha(JSON.stringify(cal.live)) };
    models[L.sport] = { league: L.label, calibration: calibRef, frame: cal.frame, bands: cal.live.bands, bands_at_market: cal.live.bands_at_market || {}, band_min_n: cal.live.band_min_n,
      markets: Object.keys(cal.live.markets).reduce((o, k) => { const m = cal.live.markets[k]; o[k] = { method: m.method, status: m.status, status_reasons: m.status_reasons, tier: m.tier, tier_basis: m.tier_basis }; return o; }, {}),
      centre_accuracy: cal.centre_accuracy || null };
    const { rows, refused: rf, hooks } = inputsFor(lg, slate, now);
    rf.forEach((r) => refused.push(r));
    rows.forEach(({ input, meta }) => {
      const sh = FL.sheet(input, cal.live, hooks);
      if (!sh.ok) { refused.push({ game_id: input.game_id, sport: L.sport, reason: sh.error }); return; }
      sh.league = meta.league; sh.season = meta.season; sh.week = meta.week; sh.neutral_site = meta.neutral_site; sh.kickoff_tbd = meta.kickoff_tbd;
      sh.model_version = meta.model_version; sh.data_quality = meta.data_quality;
      sh.reference_versus = versusReference(sh, input.reference);
      delete sh.reference;
      /* the published distributions: tails under 1e-5 trimmed, five decimals */
      Object.keys(sh.dist).forEach((k) => { if (sh.dist[k]) sh.dist[k] = FL.pmf.compact(sh.dist[k], 1e-5, 5); });
      sh._calib = calibRef;
      sh.fingerprint = fingerprint(sh, calibRef);
      games.push(sh);
    });
  });
  games.sort((a, b) => String(a.kickoff).localeCompare(String(b.kickoff)) || String(a.game_id).localeCompare(String(b.game_id)));
  /* the ledger: append only, before kickoff, when the sheet changed */
  const appended = {};
  if (!opts.noLedger) {
    const bySeason = {};
    games.forEach((g) => { (bySeason[g.season] = bySeason[g.season] || []).push(g); });
    Object.keys(bySeason).forEach((season) => {
      const file = ledgerFile(outDir, season);
      const led = readLedger(file);
      const last = {};
      led.rows.forEach((r) => { last[r.game_id + '|' + r.sport] = r; });
      const add = [];
      bySeason[season].forEach((g) => {
        if (Date.parse(g.kickoff) <= now) return;
        const prev = last[g.game_id + '|' + g.sport];
        if (prev && prev.fingerprint === g.fingerprint) return;
        add.push(JSON.stringify(ledgerRecord(g, { league: g.league, season: g.season, week: g.week, model_version: g.model_version }, nowIso, g._calib)));
      });
      if (add.length) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, (led.text && !led.text.endsWith('\n') ? '\n' : '') + add.join('\n') + '\n');
        /* read back: the old bytes must be an exact prefix of the new file */
        const after = fs.readFileSync(file, 'utf8');
        if (after.slice(0, led.text.length) !== led.text) throw new Error('ledger ' + file + ' changed in place; refusing');
        appended[season] = add.length;
      }
    });
  }
  /* slim the published sheets: a ladder the browser can rebuild from a
     published distribution is not shipped twice (EDFairLine.ladder rebuilds
     it); the ENGINE spread's ladder IS its distribution and stays, without
     the fair prices EDFairLine.ladder derives from its probabilities */
  games.forEach((g) => {
    delete g._calib;
    const K = { spread: 'margin', total: 'total', home_team_total: 'home', away_team_total: 'away' };
    Object.keys(K).forEach((k) => { if (g.dist[K[k]]) delete g.ladders[k]; });
    Object.keys(g.ladders).forEach((k) => { g.ladders[k] = g.ladders[k].map((r) => { const o = Object.assign({}, r); delete o.home_fair; delete o.away_fair; delete o.over_fair; delete o.under_fair; return o; }); });
  });
  const out = {
    schema: SCHEMA, version: 1, generated_at: nowIso, source: 'tools/football/build_fair_lines.js',
    fairline: { version: FL.VERSION, schema: FL.SCHEMA },
    inputs, models,
    counts: { games: games.length, nfl: games.filter((g) => g.league === 'NFL').length, cfb: games.filter((g) => g.league === 'CFB').length, refused: refused.length },
    games, refused,
    note: 'Fair prices from EdgeDesk’s own projections. Each market carries its calibration status against OUTCOMES on held-out seasons and, separately, its tier against the CLOSING LINE. A reference line is shown for comparison and is never a price; no expected value is computed without a priced quote.'
  };
  return { out, appended, outDir };
}

/* --------------------------------------------------------- the check */
function check(dir) {
  dir = dir || path.join(ROOT, 'football', 'linemaker');
  const errs = [];
  const f = path.join(dir, 'fair_lines.json');
  let d = null;
  try { d = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { errs.push('fair_lines.json: ' + e.message); }
  if (d) {
    if (d.schema !== SCHEMA) errs.push('schema ' + d.schema);
    (d.games || []).forEach((g) => {
      ['spread', 'moneyline', 'total', 'team_total'].forEach((mk) => { const m = g.markets && g.markets[mk]; if (m && !['CALIBRATED', 'PROVISIONAL', 'UNCALIBRATED'].includes(m.status)) errs.push(g.game_id + ' ' + mk + ' status ' + m.status); });
      if (g.reference_versus && g.reference_versus.is_price !== false) errs.push(g.game_id + ': a reference line is labelled as a price');
      if (/expected_value|\bev\b/i.test(JSON.stringify(g.reference_versus || {}))) errs.push(g.game_id + ': an EV against a reference line');
    });
  }
  const ld = path.join(dir, 'ledger');
  if (fs.existsSync(ld)) fs.readdirSync(ld).forEach((season) => {
    const file = path.join(ld, season, 'sheets.jsonl'); if (!fs.existsSync(file)) return;
    let led; try { led = readLedger(file); } catch (e) { errs.push(e.message); return; }
    const ids = new Set();
    led.rows.forEach((r, i) => {
      if (r.schema !== LEDGER_SCHEMA) errs.push(season + ' line ' + (i + 1) + ': schema');
      if (ids.has(r.record_id)) errs.push(season + ' line ' + (i + 1) + ': duplicate record ' + r.record_id); ids.add(r.record_id);
      if (!(Date.parse(r.recorded_at) < Date.parse(r.kickoff))) errs.push(season + ' line ' + (i + 1) + ': recorded at or after kickoff');
      const copy = Object.assign({}, r); delete copy.record_id;
      if ('flr_' + sha(JSON.stringify(copy)) !== r.record_id) errs.push(season + ' line ' + (i + 1) + ': the record does not match its id (edited after it was written)');
    });
  });
  return errs;
}

function main() {
  const a = process.argv.slice(2);
  const arg = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : null);
  if (a.includes('--check')) { const e = check(arg('--out')); if (e.length) { e.forEach((x) => console.error('fair lines: ' + x)); process.exit(1); } console.log('fair lines ok'); return; }
  const r = build({ now: arg('--now'), out: arg('--out'), noLedger: a.includes('--no-ledger') });
  const file = path.join(r.outDir, 'fair_lines.json');
  const w = writeIfChanged(file, r.out, { pretty: false });
  console.log(w + ' ' + path.relative(ROOT, file) + ' — ' + r.out.counts.games + ' games (NFL ' + r.out.counts.nfl + ', CFB ' + r.out.counts.cfb + '), ' + r.out.counts.refused + ' refused');
  Object.keys(r.appended).forEach((s) => console.log('ledger ' + s + ': +' + r.appended[s] + ' record(s)'));
}

module.exports = { build, check, fingerprint, ledgerRecord, readLedger, versusReference, inputsFor, engineHooks, SCHEMA, LEDGER_SCHEMA };
if (require.main === module) main();
