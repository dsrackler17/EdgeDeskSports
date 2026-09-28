#!/usr/bin/env node
/* ============================================================================
   EdgeDesk CFB RESEARCH TERMINAL — the build.

   Reads the production artifacts that already exist and writes the cached
   research objects the research page reads. Nothing is trained, nothing is
   re-fitted, and no page ever runs a model: the page loads these files.

     reads   football/cfb_production/manifest.json        which model is champion
             football/cfb_lab/governance/model_roles.jsonl (the manifest is the pin)
             football/fbs/slate.json                      the champion V1 slate
             football/cfb_v2/current.json + params.js     V2.1 (production pathway)
             football/cfb_p4/params.js + engine.js        the champion's margin PMF
             football/cfb_lab/ledger/<season>/…           checkpoints, quotes, lines
             football/cfb_v2/artifacts/decision/…         the frozen policy + calibration
             football/cfb_decision/decision.js            the fail-closed decision engine
             lib/cfb_disagreement.js                      the major-gap integrity gate
             football/matchup/metrics.json                opponent-adjusted unit data
             football/validation/movement_cfb.json        typical college line movement
             record/football/cfb_<season>.json            the immutable public record
             football/cfb_production/reports/ops.json     operations health

     writes  football/cfb_terminal/board.json             compact slate rows (fast board)
             football/cfb_terminal/games.json             one research object per game
             football/cfb_terminal/record.json            record, calibration, benchmark, postgame
             football/cfb_terminal/brief.json             the weekly research brief
             football/cfb_terminal/history/<season>/snapshots.jsonl
                                                          APPEND-ONLY: the champion's number,
                                                          its terms and the QB state, once per
                                                          change — what "what changed?" reads

   Usage
     node football/cfb_terminal/build.js                 # build and write
     node football/cfb_terminal/build.js --check         # build, verify, write nothing
     node football/cfb_terminal/build.js --now 2026-09-27T18:00:00Z
     node football/cfb_terminal/build.js --out /tmp/demo  # write elsewhere, no history
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = __dirname;
global.window = global.window || global;
require(path.join(ROOT, 'football', 'cfb_p4', 'params.js'));
const E1 = require(path.join(ROOT, 'football', 'cfb_p4', 'engine.js'));
require(path.join(ROOT, 'football', 'cfb_v2', 'params.js'));
const E2 = require(path.join(ROOT, 'football', 'cfb_v2', 'engine.js'));
const DEC = require(path.join(ROOT, 'football', 'cfb_decision', 'decision.js'));
/* V2.1's pure number comes from the canonical service only (input contract, numeric
   checks; docs/cfb-production/CANONICAL.md §1): a refused row is UNAVAILABLE, never a default */
const CANON = require(path.join(ROOT, 'football', 'cfb_production', 'canonical.js'));
const DIS = require(path.join(ROOT, 'lib', 'cfb_disagreement.js'));
const T = require(path.join(ROOT, 'lib', 'cfb_terminal.js'));
/* THE EDGEDESK READ (lib/edgedesk_read.js): the price-specific read of every
   game, from the same champion distribution, stored as a probability curve */
const RD = require(path.join(ROOT, 'lib', 'edgedesk_read.js'));
const INTEG = (() => { try { return require(path.join(ROOT, 'football', 'cfb_lab', 'integrity.js')); } catch (e) { return null; } })();

function arg(name, dflt) { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : dflt; }
function flag(name) { return process.argv.indexOf('--' + name) > 0; }
function readJson(p, dflt) { try { return JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8')); } catch (e) { return dflt === undefined ? null : dflt; } }
function readJsonl(p) {
  const f = path.join(ROOT, p);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
}
function listDir(p) { const f = path.join(ROOT, p); return fs.existsSync(f) ? fs.readdirSync(f).sort() : []; }
function num(x) { return typeof x === 'number' && isFinite(x) ? x : null; }
function ms(t) { const x = typeof t === 'number' ? t : Date.parse(t); return isFinite(x) ? x : null; }
function sha(x) { return crypto.createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex'); }
function mtimeIso(p) { try { return fs.statSync(path.join(ROOT, p)).mtime.toISOString(); } catch (e) { return null; } }

/* ------------------------------------------------------------ governance */
function loadGovernance() {
  const man = readJson('football/cfb_production/manifest.json', {});
  const roles = readJsonl('football/cfb_lab/governance/model_roles.jsonl');
  /* the latest role per model, by effective time */
  const byModel = {};
  roles.forEach((r) => { if (!byModel[r.model_version] || ms(r.effective_at) >= ms(byModel[r.model_version].effective_at)) byModel[r.model_version] = r; });
  const champion = Object.keys(byModel).find((k) => byModel[k].role === 'champion') || man.champion_model_version || 'edgedesk_cfb_p4_v1.0.0';
  const polDir = (man.decision_policy && man.decision_policy.dir) || 'cfb_decision_policy_v1';
  const calVer = (man.decision_calibration && man.decision_calibration.version) || 'cfb_decision_calibration_v1';
  const policy = readJson('football/cfb_v2/artifacts/decision/' + polDir + '/policy.json');
  const artifact = readJson('football/cfb_v2/artifacts/decision/' + calVer + '/calibration.json');
  return { manifest: man, roles: byModel, champion: champion, champion_label: (byModel[champion] || {}).model_label || null,
    production_model: man.production_model_version || null, policy: policy, artifact: artifact, policy_dir: polDir, calibration_version: calVer };
}

/* the calibrated-EV reality under the frozen calibration, stated from the artifact itself */
function calibratedEvNote(A, P) {
  const c = A && A.ev_curve_decision;
  if (!c || !c.y || !P) return null;
  const ys = c.y.filter((v) => num(v) != null), max = Math.max.apply(null, ys);
  if (max < (P.min_ev || 0)) return 'Under the frozen decision calibration (' + A.version + ', for ' + A.base_model_version + ') the calibrated EV never reaches the policy minimum: its highest value is ' + (100 * max).toFixed(1) + '% at any price, so no quote can be a certified bet today.';
  return null;
}

/* the typical college open-to-close move, from the held-out movement study */
function typicalMove() {
  const m = readJson('football/validation/movement_cfb.json');
  const fits = m && m.result && m.result.fits;
  if (!fits || !fits.length) return null;
  const xs = fits.map((f) => num(f.mae_no_move)).filter((x) => x != null);
  return xs.length ? Math.round(10 * xs.reduce((a, b) => a + b, 0) / xs.length) / 10 : null;
}

/* ---------------------------------------------------- the champion's distribution
   EDCfbP4 dist.coverProbSpread(fair, line, σ, σbase) borrows the margin PMF
   CONDITIONED ON THE MARKET SPREAD (the variable the table was built on) and
   evaluates it at that same number. A price curve asks a different question:
   the market is where it is, and the bettor asks about other numbers. So the
   curve keeps the engine's conditioning on the CURRENT market margin and moves
   only the threshold. At threshold == market margin this reproduces the
   engine's own coverProbSpread exactly (tests pin it). With no market, the
   engine's own call is used unchanged. */
function pmfEntries(pmf) {
  const out = [];
  Object.keys(pmf || {}).forEach((k) => out.push([parseInt(k, 10), pmf[k]]));
  return out.sort((a, b) => a[0] - b[0]);
}
function v1CoverConditioned(fair, condMargin, sigma, sigmaBase) {
  const D = window.EDCfbP4Params.distributions || {};
  const tab = D.margin_pmf_by_spread, rng = D.pmf_spread_range;
  if (num(condMargin) == null || !tab || !rng || condMargin < rng[0] || condMargin > rng[1]) return null;
  let key = (Math.round(condMargin * 2) / 2).toFixed(1);
  if (key === '-0.0') key = '0.0';
  const pmf = tab[key] || tab[Math.round(condMargin).toFixed(1)];
  if (!pmf) return null;
  const es = pmfEntries(pmf);
  let em = 0, ew = 0;
  es.forEach((e) => { em += e[0] * e[1]; ew += e[1]; });
  const shift = ew > 0 ? Math.round(fair - em / ew) : 0;
  const stretch = (num(sigma) && num(sigmaBase) && sigmaBase > 0) ? sigma / sigmaBase : 1;
  const pts = es.map((e) => {
    const m = e[0] + shift;
    let w = e[1];
    if (Math.abs(stretch - 1) >= 0.02) {
      const z0 = (m - fair) / (sigmaBase || 1), z1 = (m - fair) / (sigma || 1);
      w = e[1] * Math.exp(-0.5 * (z1 * z1 - z0 * z0)) / stretch;
    }
    return [m, w];
  });
  const tot = pts.reduce((s, x) => s + x[1], 0);
  if (!(tot > 0)) return null;
  return function (threshold) {
    let win = 0, push = 0;
    pts.forEach((x) => { if (Math.abs(x[0] - threshold) < 1e-9) push += x[1]; else if (x[0] > threshold) win += x[1]; });
    return { win: win / tot, push: push / tot, lose: 1 - (win + push) / tot };
  };
}
function v1Dist(margin, sigma, marketMargin) {
  const P = window.EDCfbP4Params, base = (P.volatility && P.volatility.sigma_base) || (P.distributions && P.distributions.sigma_margin) || 15;
  const s = num(sigma) || base;
  const md = E1.dist.marginDistribution(margin, s);
  const q = (x) => (md ? E1.dist.quantile(md, x) : null);
  const cond = v1CoverConditioned(margin, marketMargin, s, base);
  return {
    basis: cond ? 'the champion’s empirical college margin PMF, conditioned on the current market spread as the engine conditions it, re-centred on EdgeDesk’s fair margin and stretched to this game’s sigma'
      : 'the champion’s empirical college margin PMF (EDCfbP4 dist.coverProbSpread), re-centred on its fair margin',
    conditioned_on_market_margin: cond ? marketMargin : null,
    sigma: s, sigma_base: base,
    quantiles: { p10: q(0.10), p25: q(0.25), p50: q(0.5), p75: q(0.75), p90: q(0.90) },
    cover: cond || function (line) { return E1.dist.coverProbSpread(margin, line, s, base); }
  };
}
/* V2.1's distribution (used only if V2.1 is ever the champion): its t error
   model, with the decision calibration's measured push rates */
function v2Dist(margin, sigma, df, pushTable) {
  const qz = (p) => { let lo = -10, hi = 10; for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (E2.tCdf(m, df) < p) lo = m; else hi = m; } return (lo + hi) / 2; };
  return {
    basis: 'V2.1’s Student-t error model (df ' + df + ') with the decision calibration’s measured push rates',
    quantiles: { p10: margin + sigma * qz(0.1), p25: margin + sigma * qz(0.25), p50: margin, p75: margin + sigma * qz(0.75), p90: margin + sigma * qz(0.9) },
    cover: function (line) {
      const pushP = DEC.pushProb(line, pushTable);
      const pHome = 1 - E2.tCdf((line - margin) / sigma, df);
      return { win: pHome * (1 - pushP), push: pushP, lose: (1 - pHome) * (1 - pushP) };
    }
  };
}

/* sigma for the V1 slate number: the Lab snapshot of the SAME slate when one
   exists, else inverted exactly from the published win probability
   (EDCfbP4 dist.winProb = Φ(margin / σ)), else the engine's base */
function v1Sigma(slateRow, labRow, slateAt) {
  if (labRow && num(labRow.prediction_sigma) != null && labRow.inputs_ref && labRow.inputs_ref.slate_generated_at === slateAt)
    return { sigma: labRow.prediction_sigma, basis: 'the Model Lab snapshot of this slate' };
  const m = num(slateRow.model_home_margin), p = num(slateRow.model_home_win_prob);
  if (m != null && p != null && Math.abs(m) >= 1 && p > 0.001 && p < 0.999) {
    let lo = -8, hi = 8;
    for (let i = 0; i < 80; i++) { const z = (lo + hi) / 2; if (0.5 * (1 + erf(z / Math.SQRT2)) < p) lo = z; else hi = z; }
    const z = (lo + hi) / 2;
    if (Math.abs(z) > 1e-6) return { sigma: m / z, basis: 'inverted from the published win probability (Φ(margin/σ))' };
  }
  if (labRow && num(labRow.prediction_sigma) != null) return { sigma: labRow.prediction_sigma, basis: 'the latest Model Lab snapshot' };
  const P = window.EDCfbP4Params;
  return { sigma: (P.volatility && P.volatility.sigma_base) || 14.9, basis: 'the engine’s base sigma (no game sigma on file)' };
}
function erf(x) { const s = x < 0 ? -1 : 1; x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return s * y; }

/* ---------------------------------------------------------------- the lab ledger */
function loadLedger(season) {
  const base = 'football/cfb_lab/ledger/' + season;
  const preds = [], quotes = [];
  listDir(base + '/predictions').forEach((f) => { if (/\.jsonl$/.test(f)) readJsonl(base + '/predictions/' + f).forEach((r) => preds.push(r)); });
  listDir(base + '/quotes').forEach((f) => { if (/\.jsonl$/.test(f)) readJsonl(base + '/quotes/' + f).forEach((r) => quotes.push(r)); });
  const lines = readJsonl(base + '/lines.jsonl');
  const byGame = (rows, key) => { const m = new Map(); rows.forEach((r) => { const k = String(r[key]); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }); return m; };
  /* an alternate spread is never the book's main line: kept apart for the Read, never in the terminal's market */
  const isAlt = (q) => !!q.alternate || q.market_type === 'alternate_spread';
  const alts = quotes.filter((q) => isAlt(q) && !q.is_heartbeat && q.is_pregame !== false)
    .concat(readJsonl('football/cfb_terminal/read/' + season + '/alternates.jsonl'))
    .map((q) => Object.assign({}, q, { market_type: 'spread', alternate: true }));
  return { preds: byGame(preds, 'game_id'), quotes: byGame(quotes.filter((q) => q.market_type === 'spread' && !isAlt(q) && !q.is_heartbeat && q.is_pregame !== false), 'game_id'),
    alts: byGame(alts, 'game_id'), ml: byGame(quotes.filter((q) => q.market_type === 'moneyline' && !q.is_heartbeat && q.is_pregame !== false), 'game_id'),
    lines: byGame(lines, 'game_id'), n_preds: preds.length, n_quotes: quotes.length, n_alts: alts.length };
}

/* ------------------------------------------------------------- terminal history */
function historyPath(season) { return path.join(OUT, 'history', String(season), 'snapshots.jsonl'); }
function loadHistory(season) {
  const p = historyPath(season);
  if (!fs.existsSync(p)) return new Map();
  const m = new Map();
  fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).forEach((l) => { try { const r = JSON.parse(l); const k = String(r.game_id); if (!m.has(k)) m.set(k, []); m.get(k).push(r); } catch (e) { /* a torn line is skipped, never rewritten */ } });
  return m;
}

/* ----------------------------------------------------------- per-game assembly */
function qbOf(row, side) {
  const s = row[side + '_starter'], e = row[side + '_qb_epa'];
  if (!s) return null;
  const idn = e && e.identity;
  const contested = s.status === 'COMPETITION' || /UNSETTLED|CONTESTED/i.test(String(s.status)) || !!(idn && idn.contested);
  return { player: s.player_name || null, status: s.status || null, confirmed: s.confirmed === true, contested: contested,
    label: s.label || null, source: s.source || null, as_of: s.retrieved_at || null,
    epa: e && e.season && num(e.season.epa_per_dropback) != null ? e.season.epa_per_dropback : null,
    dropbacks: e && e.season ? e.season.dropbacks : null };
}
function contractField(row, field, side) { return (row.input_contract || []).find((f) => f.field === field && (side == null || f.side === side)) || null; }

function buildGame(ctx, row) {
  const G = ctx.gov, now = ctx.now, gid = String(row.game_id);
  ctx._governed = null;
  const labRows = (ctx.ledger.preds.get(gid) || []).filter((r) => ms(r.prediction_ts) != null && ms(r.prediction_ts) <= now);
  const champRows = labRows.filter((r) => r.model_version === G.champion).sort((a, b) => ms(a.prediction_ts) - ms(b.prediction_ts));
  const latestChamp = champRows[champRows.length - 1] || null;
  const v21 = ctx.v2.byId[gid] || null;
  const v21pure = v21 ? CANON.pure(v21) : null;
  const fcs = row.home_division !== 'fbs' || row.away_division !== 'fbs';
  const game = { game_id: gid, season: row.season, week: row.week, kickoff: row.kickoff, home: row.home_team, away: row.away_team,
    neutral_site: !!row.neutral_site, venue: row.venue || null, home_conference: row.home_conference, away_conference: row.away_conference,
    matchup_type: row.matchup_type || null, fcs: fcs, cross_conference: !fcs && row.matchup_type && row.matchup_type !== 'conference' };

  /* the market consensus first: the champion's cover curve is conditioned on it */
  const quotesEarly = (ctx.ledger.quotes.get(gid) || []).filter((q) => ms(q.observed_at) != null && ms(q.observed_at) <= now && (!row.kickoff || ms(q.observed_at) < ms(row.kickoff)));
  /* the fresh consensus when one exists, else the latest seen: the PMF is
     conditioned on where the market is; a stale market is never PRICED (the
     research object refuses), but the conditioning must still be one number */
  const perBook = T.latestPerBook(quotesEarly.map((q) => ({ book: q.book === 'consensus' ? q.source + ' consensus' : q.book, home_line: q.home_line, observed_at: q.observed_at })), now);
  const consEarly = perBook.filter((q) => (now - ms(q.observed_at)) / 60000 <= ctx.cfg.stale_minutes);
  const condSet = consEarly.length ? consEarly : perBook;
  ctx._consMargin = condSet.length ? -T.util.median(condSet.map((q) => q.home_line)) : null;

  /* the champion's pure number: V1 from the slate, or V2.1 if governance says so */
  let model = null, dist = null, fault = null, terms = null, calibration = null, expErr = null, ratingSplit = null;
  if (G.champion === 'edgedesk_cfb_v2.1.0') {
    if (v21pure && v21pure.status === 'PREDICTED') {
      model = { model_version: v21pure.model_version, label: G.champion_label, role: 'champion', home_margin: v21pure.projected_margin,
        fair_total: v21pure.fair_total, home_win_prob: v21pure.home_win_prob, sigma: v21pure.sigma, sigma_basis: 'V2.1 error model',
        football_confidence: v21pure.football_prediction_confidence, prediction_ts: v21pure.prediction_ts, source: 'football/cfb_v2/current.json' };
      dist = v2Dist(v21pure.projected_margin, v21pure.sigma, v21pure.t_df, (G.artifact && G.artifact.push_table) || null);
      expErr = v21pure.sigma * Math.sqrt(2 / Math.PI);
    } else model = { unavailable_reason: 'V2.1 has no priced projection for this game (' + ((v21pure && (v21pure.reason || v21pure.status)) || 'no row') + ')' };
  } else {
    if (row.model_status === 'PREDICTED' && num(row.model_home_margin) != null) {
      const sg = v1Sigma(row, latestChamp, ctx.slate.generated_at);
      const conf = row.confidence_ledger && row.confidence_ledger.reconciles ? row.confidence_ledger.reconciles.displayed_confidence_pct : null;
      model = { model_version: G.champion, label: G.champion_label || 'V1', role: 'champion', home_margin: row.model_home_margin,
        fair_total: row.model_fair_total, home_win_prob: row.model_home_win_prob, sigma: sg.sigma, sigma_basis: sg.basis,
        home_points: latestChamp ? latestChamp.projected_home_points : null, away_points: latestChamp ? latestChamp.projected_away_points : null,
        football_confidence: num(conf) != null ? Math.round(conf) : (latestChamp ? latestChamp.football_confidence : null),
        prediction_ts: ctx.slate.generated_at, source: 'football/fbs/slate.json' };
      /* the engine's team points are (total ± margin) / 2 exactly */
      if (num(row.model_fair_total) != null) { model.home_points = (row.model_fair_total + row.model_home_margin) / 2; model.away_points = (row.model_fair_total - row.model_home_margin) / 2; }
      dist = v1Dist(row.model_home_margin, sg.sigma, ctx._consMargin);
      expErr = latestChamp && num(latestChamp.expected_model_error) != null && latestChamp.inputs_ref && latestChamp.inputs_ref.slate_generated_at === ctx.slate.generated_at
        ? latestChamp.expected_model_error : sg.sigma * Math.sqrt(2 / Math.PI);
      const rated = (side) => { const f = contractField(row, 'team_rating', side); const m = f && /rated (-?\d+(?:\.\d+)?)/.exec(String(f.detail || '')); return m ? parseFloat(m[1]) : null; };
      ratingSplit = { home: rated('home'), away: rated('away') };
      const di = row.disagreement_inputs;
      if (di && di.projection && di.projection.components) {
        terms = Object.keys(di.projection.components).map((k) => ({ key: k, points: di.projection.components[k], available: di.projection.component_available ? di.projection.component_available[k] !== false : true }));
        calibration = di.projection.calibration || null;
      }
    } else {
      model = { unavailable_reason: 'the champion reports ' + (row.model_status || 'no status') };
      if (/BLOCKED|THREW/.test(String(row.model_status))) fault = 'The champion engine refused this game (' + row.model_status + '): a sanity or data check failed.';
    }
  }

  /* the market: every pregame spread quote the Lab captured, up to now */
  const quotes = (ctx.ledger.quotes.get(gid) || []).filter((q) => ms(q.observed_at) != null && ms(q.observed_at) <= now && (!row.kickoff || ms(q.observed_at) < ms(row.kickoff)));
  const lines = ctx.ledger.lines.get(gid) || [];
  const open = lines.find((l) => l.kind === 'OPEN' && l.market_type === 'spread' && num(l.home_line) != null) || null;
  /* the Lab's own recorded opener when the lines ledger has none: its first snapshot's opening spread */
  const firstWithOpen = labRows.filter((r) => num(r.opening_spread) != null).sort((a, b) => ms(a.prediction_ts) - ms(b.prediction_ts))[0];
  const market = { quotes: quotes.map((q) => ({ book: q.book === 'consensus' ? q.source + ' consensus' : q.book, source: q.source, home_line: q.home_line,
    price_home: q.price_home, price_away: q.price_away, observed_at: q.observed_at, quote_id: q.quote_id || null, provider_updated_at: q.provider_updated_at || null })),
    open_home_line: open ? open.home_line : (firstWithOpen ? firstWithOpen.opening_spread : null),
    open_at: open ? (open.observed_at || null) : (firstWithOpen ? firstWithOpen.opening_market_ts : null) };

  /* the checkpoints: every model's stored number, champion first */
  const checkpoints = champRows.map((r) => ({ at: r.prediction_ts, home_margin: r.pure_home_margin, checkpoint: r.checkpoint_type, model_version: r.model_version, source: 'Model Lab ' + r.origin }));
  const hist = (ctx.history.get(gid) || []).filter((s) => s.model_version === G.champion);
  hist.forEach((s) => checkpoints.push({ at: s.at, home_margin: s.home_margin, checkpoint: 'TERMINAL', model_version: s.model_version, source: 'terminal history' }));
  if (model && num(model.home_margin) != null) checkpoints.push({ at: model.prediction_ts, home_margin: model.home_margin, checkpoint: 'CURRENT', model_version: model.model_version, source: model.source });

  /* the independent model numbers */
  const models = [];
  if (row.model_status === 'PREDICTED' && num(row.model_home_margin) != null)
    models.push({ key: 'v1', label: 'V1 champion (additive rating engine)', family: 'additive rating', home_margin: row.model_home_margin, role: (G.roles['edgedesk_cfb_p4_v1.0.0'] || {}).role || 'champion', independent: true });
  if (v21pure && v21pure.status === 'PREDICTED') {
    models.push({ key: 'v21', label: 'V2.1 ensemble (production pathway)', family: 'stacked ensemble', home_margin: v21pure.projected_margin, role: 'challenger', independent: false });
    if (v21.components && num(v21.components.C_ridge) != null) models.push({ key: 'v21_ridge', label: 'V2.1 ridge efficiency model', family: 'ridge regression', home_margin: v21.components.C_ridge, independent: true });
    if (v21.components && num(v21.components.D_gbm) != null) models.push({ key: 'v21_gbm', label: 'V2.1 boosted matchup model', family: 'gradient-boosted trees', home_margin: v21.components.D_gbm, independent: true });
  }
  const cand = v21 && v21.shadow && v21.shadow.candidate_001;
  if (cand && num(cand.ens_pred) != null) models.push({ key: 'v20', label: 'V2.0 candidate 001 ensemble', family: 'stacked ensemble (5 submodels)', home_margin: cand.ens_pred, role: 'candidate', independent: false });

  /* the integrity gate on a 7+ gap: exactly as the Model Lab runs it */
  const T0 = T.config();
  let integrity = null;
  const cons = T.latestPerBook(market.quotes, now).filter((q) => (now - ms(q.observed_at)) / 60000 <= ctx.cfg.stale_minutes);
  const consLine = cons.length ? T.util.median(cons.map((q) => q.home_line)) : null;
  if (model && num(model.home_margin) != null && consLine != null && Math.abs(model.home_margin + consLine) >= T0.major_gap) {
    const di = row.disagreement_inputs;
    if (di && di.projection) {
      const sub = { source: 'the Model Lab’s V2 projections', projections: {}, ensemble: null, ensemble_sd: null };
      if (v21 && v21.components) Object.keys(v21.components).forEach((k) => { if (num(v21.components[k]) != null) sub.projections['v2.1 ' + k] = v21.components[k]; });
      if (v21pure && v21pure.status === 'PREDICTED') { sub.ensemble = v21pure.projected_margin; sub.ensemble_sd = num(v21.ens_sd); }
      if (cand && num(cand.ens_pred) != null) sub.projections['V2 · candidate 001 ensemble'] = cand.ens_pred;
      const rd = di.projection.rating_detail || {};
      const lines2 = cons.map((q) => q.home_line).sort((a, b) => a - b);
      try {
        integrity = DIS.evaluate({ now_ms: now,
          game: { game_id: gid, home: game.home, away: game.away, kickoff: game.kickoff, neutral_site: game.neutral_site, venue: di.game ? di.game.venue : null,
            home_fbs: di.game ? di.game.home_fbs : !fcs, away_fbs: di.game ? di.game.away_fbs : !fcs },
          mapping: { teams_resolved: true }, projection: di.projection,
          market: { spread: -consLine, books: cons.length, dispersion: lines2.length > 1 ? lines2[lines2.length - 1] - lines2[0] : 0,
            as_of: cons.length ? cons.map((q) => q.observed_at).sort().pop() : null, stale: false, source: cons.map((q) => q.source).filter((x, i, a) => a.indexOf(x) === i).join('+') },
          submodels: Object.keys(sub.projections).length ? sub : null, qb: di.qb || null, roster: di.roster || null, reliability: num(di.reliability),
          long_term_vs_current_delta: (num(rd.home_gp) != null && num(rd.away_gp) != null && Math.min(rd.home_gp, rd.away_gp) >= 3)
            ? (rd.home_carried - rd.away_carried) - (rd.home_fresh - rd.away_fresh) : null });
      } catch (e) { integrity = null; }
    }
  }

  /* the decision engine for the champion, at every fresh quote (fail closed) */
  let decision = null;
  if (model && num(model.home_margin) != null) {
    const pure = { status: 'PREDICTED', game_id: gid, kickoff: game.kickoff, model_version: model.model_version, projected_margin: model.home_margin,
      sigma: model.sigma, t_df: G.champion === 'edgedesk_cfb_v2.1.0' && v21pure ? v21pure.t_df : 1e6, football_prediction_confidence: model.football_confidence,
      home: game.home, away: game.away };
    const priced = cons.filter((q) => num(q.price_home) != null && num(q.price_away) != null)
      .map((q, i) => ({ quote_id: q.quote_id || ('term_' + gid + '_' + i), book: q.book, source: q.source, market_type: 'spread', home_line: q.home_line,
        price_home: q.price_home, price_away: q.price_away, observed_at: q.observed_at, provider_updated_at: q.provider_updated_at || null }));
    try {
      const gd = DEC.decideGame(pure, { quotes: priced }, { policy: G.policy, artifact: G.artifact, now: now,
        row: { qb_missing_any: v21 ? v21.qb_missing_any : 0, qb_unsettled_any: v21 ? v21.qb_unsettled_any : 0 } });
      /* the governed verdict for each exact quote: the only source of a certified BET in the Read */
      ctx._governed = { engine: DEC.ENGINE_ID + ' ' + DEC.ENGINE_VERSION, policy_version: G.policy ? G.policy.version : null, by_quote: {} };
      (gd.decisions || []).forEach((d) => { if (d.quote_id) ctx._governed.by_quote[d.quote_id] = { status: d.status, reason_codes: (d.reason_codes || []).slice(), timing: d.timing, book: d.book, line: d.line_for_side, side: d.side }; });
      const top = gd.decisions && gd.decisions.length ? gd.decisions[gd.summary_index == null ? 0 : gd.summary_index] : null;
      decision = { engine: DEC.ENGINE_ID + ' ' + DEC.ENGINE_VERSION, status: gd.status, reason_codes: (top ? top.reason_codes : gd.reason_codes) || [],
        reasons: ((top ? top.reason_codes : gd.reason_codes) || []).map((c) => DEC.REASON[c] || c), detail: top ? top.detail || null : null, model_version: model.model_version };
      if (!priced.length) { decision.status = 'NO_BET'; decision.reason_codes = ['PASS_PRICE']; decision.reasons = ['no fresh two-sided priced quote to decide on']; }
    } catch (e) { decision = { status: 'NO_BET', reason_codes: ['NO_BET_COMPUTATION'], reasons: ['the decision engine threw: ' + e.message] }; }
  }

  const metricsFor = (key) => (ctx.metrics.teams || {})[key] || null;
  const mH = metricsFor(row.home_team_id), mA = metricsFor(row.away_team_id);
  const gpOf = (t) => t && t.performance && t.performance.sample ? num(t.performance.sample.games_played) : null;
  const gps = [gpOf(mH), gpOf(mA)].filter((x) => x != null);
  const rel = row.reliability || {};
  const stab = rel.stability || row.projection_stability || null;
  const avail = (s) => { const f = contractField(row, 'availability', s); return f ? { state: f.state, why: f.detail ? String(f.detail).split(' — ')[0].slice(0, 160) : null } : null; };
  const wx = contractField(row, 'weather', null);
  const qb = { home: qbOf(row, 'home'), away: qbOf(row, 'away') };
  const extreme = (integrity && integrity.checks || []).filter((c) => c.group === 'COMPONENT' && c.status === 'FAIL').map((c) => 'Adjustment outside its validated range: ' + c.detail);

  const b = {
    now: now, config: ctx.cfg, game: game, model: model || {}, dist: dist, fault: fault, terms: terms, calibration: calibration, rating_split: ratingSplit,
    expected_abs_error: expErr, market: market, integrity: integrity, decision: decision, reference_price: (G.policy && G.policy.reference_price) || -110,
    models: models, v21: v21 ? { model_version: 'edgedesk_cfb_v2.1.0', drivers: v21.drivers || [] } : null, v2params: window.EDCfbV2Params,
    stability: stab ? { dimensions: stab.dimensions || [], favorite_flip_rate: stab.favorite_flip_rate } : null,
    qb: qb, availability: { home: avail('home'), away: avail('away') },
    weather: wx ? { available: wx.state === 'USABLE' || wx.state === 'RESEARCH_ONLY', state: wx.state } : null,
    reliability: { score: num(rel.score) != null ? rel.score : num(row.reliability_score), grade: rel.grade_label || row.reliability_grade || null,
      main_deduction: rel.main_deduction || null, gates: rel.gates || [], next_actions: row.reliability_next_actions || rel.next_actions || [] },
    data_coverage: row.data_coverage || null,
    games_played: { home: gpOf(mH), away: gpOf(mA), min: gps.length ? Math.min.apply(null, gps) : null },
    metrics: { home: mH, away: mA },
    key_mass: (window.EDCfbP4Params.distributions || {}).abs_margin_key_mass || null,
    uncertainty_drivers: v21 ? v21.uncertainty_drivers || [] : [],
    extreme: extreme,
    checkpoints: checkpoints, snapshots: hist,
    wait_policy: G.policy ? G.policy.wait : null,
    trust: { model_updated_at: ctx.slate.generated_at, qb_as_of: [qb.home && qb.home.as_of, qb.away && qb.away.as_of].filter(Boolean).sort()[0] || null,
      roster_as_of: (contractField(row, 'roster', 'home') || {}).as_of || null, degraded: ctx.degraded,
      decision_policy: G.policy_dir, betting_enabled: !!(G.policy && G.policy.bet_enabled), calibrated_ev_note: ctx.evNote, warnings: ctx.warnings },
    sources: ctx.sources
  };
  const first = T.build(b);
  b.historical = T.historicalContext(ctx.recordRows, first);
  const o = T.build(b);
  /* THE EDGEDESK READ: the stored inputs, then the read built through the same adapter the page uses */
  const readInputs = readBase(ctx, row, game, model, dist, v21, market, quotes, lines, expErr);
  let read = null;
  try { read = RD.read(RD.fromTerminal(o, readInputs, { now: now, integrity: INTEG })); }
  catch (e) { read = null; ctx.warnings.push('EdgeDesk Read failed for ' + gid + ': ' + e.message); }
  ctx._governed = null;
  return { object: o, read: read, read_inputs: readInputs, snapshot: snapshotRow(o, terms, qb, model) };
}

/* --------------------------------------------------- the Read's stored inputs
   Everything the Read needs beyond the research object, stored once so the
   page can re-price another book, an alternate, a typed quote or a moved line
   without running a model: the champion's probability at every half point
   (the curve), the calibration verdict, the policy numbers, every captured
   spread quote (main lines and alternates), the opener, the numbers other
   EdgeDesk artifacts displayed (for the quote check), the moneyline, and the
   governed decision for each exact quote. */
function readBase(ctx, row, game, model, dist, v21, market, quotes, lines, expErr) {
  const G = ctx.gov, gid = game.game_id, P = G.policy || {};
  const avail = !!(model && num(model.home_margin) != null);
  const mkt = ctx._consMargin, fair = avail ? model.home_margin : null;
  let curve = null;
  if (avail && dist && typeof dist.cover === 'function') {
    const center = mkt != null ? mkt : fair;
    const hw = Math.min(60, Math.max(30, Math.ceil(Math.abs((fair || 0) - (center || 0))) + 24));
    curve = RD.buildCurve(dist.cover, center, hw, { basis: dist.basis, conditioned_on: dist.conditioned_on_market_margin, model_version: model.model_version, built_at: new Date(ctx.now).toISOString() });
  }
  /* the decision calibration is validated for one model version: anything else is CALIBRATION PENDING */
  const av = G.artifact && avail ? DEC.validateArtifact(G.artifact, model.model_version) : { ok: false, detail: 'no calibration artifact loaded' };
  const A = G.artifact || {};
  const calibration = av.ok
    ? { status: 'VALIDATED', version: A.version, base_model_version: A.base_model_version, cover_calibration: A.cover_calibration,
        market_shrinkage: A.market_shrinkage ? Object.assign({}, A.market_shrinkage, { w_ci95: A.market_shrinkage.w_ci95_profile_dev || null }) : null }
    : { status: 'PENDING', version: A.version || null, base_model_version: A.base_model_version || null,
        reason: A.version ? A.version + ' is validated for ' + A.base_model_version + '; EdgeDesk fair comes from ' + (avail ? model.model_version : 'no model') : (av.detail || 'no calibration artifact') };
  const alts = (ctx.ledger.alts.get(gid) || []).filter((q) => ms(q.observed_at) != null && ms(q.observed_at) <= ctx.now && (!row.kickoff || ms(q.observed_at) < ms(row.kickoff)))
    .map((q) => ({ quote_id: q.quote_id || null, book: q.book, source: q.source, alternate: true, home_line: q.home_line, price_home: q.price_home, price_away: q.price_away,
      observed_at: q.observed_at, provider_updated_at: q.provider_updated_at || null }));
  const mls = (ctx.ledger.ml.get(gid) || []).filter((q) => ms(q.observed_at) != null && ms(q.observed_at) <= ctx.now && num(q.price_home) != null && num(q.price_away) != null)
    .sort((a, b) => ms(b.observed_at) - ms(a.observed_at));
  const open = lines.find((l) => l.kind === 'OPEN' && l.market_type === 'spread' && num(l.home_line) != null) || null;
  const stored = [];
  const pj = ctx.projections && ctx.projections.byId[gid];
  if (pj && pj.market && num(pj.market.home_line) != null) stored.push({ label: 'projections.json market (the app’s V2 panel)', origin: 'STORED', book: pj.market.books === 1 ? 'draftkings' : null,
    home_line: pj.market.home_line, observed_at: pj.market.as_of || pj.market.snapshot_ts || null });
  return {
    model: avail ? { available: true, model_version: model.model_version, home_margin: model.home_margin, fair_total: num(model.fair_total), home_points: num(model.home_points),
      away_points: num(model.away_points), home_win_prob: num(model.home_win_prob) } : { available: false, reason: model ? model.unavailable_reason || null : null },
    curve: curve, calibration: calibration,
    policy: { version: P.version || null, bet_enabled: !!P.bet_enabled, calibrated_ev_note: ctx.evNote || null, wait: P.wait ? { enabled: !!P.wait.enabled } : null },
    market: { quotes: market.quotes.concat(alts), open: open ? { home_line: open.home_line, observed_at: open.observed_at || open.derived_at || null, source: 'Model Lab OPEN (' + (open.quality || '') + ')' }
      : (market.open_home_line != null ? { home_line: market.open_home_line, observed_at: market.open_at, source: 'Model Lab first snapshot opener' } : null),
      stored: stored, moneyline: mls[0] ? { book: mls[0].book, price_home: mls[0].price_home, price_away: mls[0].price_away, observed_at: mls[0].observed_at } : null },
    governed: ctx._governed || null,
    config: { stale_minutes: ctx.cfg.stale_minutes, min_probability_edge: ctx.cfg.min_probability_edge, ideal_probability_edge: ctx.cfg.ideal_probability_edge,
      min_ev: P.min_ev != null ? P.min_ev : 0, max_price: P.max_price != null ? P.max_price : -125, reference_price: P.reference_price || -110,
      min_books: ctx.cfg.min_books, max_dispersion_iqr: ctx.cfg.max_dispersion_iqr, max_model_sd: ctx.cfg.max_model_sd, typical_move_pts: ctx.cfg.typical_move_pts },
    limits: { min_confidence: T.CONFIG.min_confidence, low_reliability: T.CONFIG.low_reliability },
    key_mass: (window.EDCfbP4Params.distributions || {}).abs_margin_key_mass || null, expected_abs_error: num(expErr)
  };
}

/* the append-only projection history row: what "what changed?" compares */
function snapshotRow(o, terms, qb, model) {
  if (!o.edgedesk.available) return null;
  const t = {};
  (terms || []).forEach((x) => { if (num(x.points) != null) t[x.key] = Math.round(x.points * 100) / 100; });
  const row = { game_id: o.game_id, season: o.season, week: o.week, at: model.prediction_ts, model_version: model.model_version,
    home_margin: o.edgedesk.home_margin, terms: Object.keys(t).length ? t : null,
    qb: { home: qb.home ? { player: qb.home.player, status: qb.home.status } : null, away: qb.away ? { player: qb.away.player, status: qb.away.status } : null },
    market_home_line: o.market.consensus_home_line, status: o.status.key,
    cover_at_best: o.price.available && o.price.current ? o.price.current.cover : null,
    best_line: o.price.available && o.price.current ? o.price.current.line : null, side: o.price.side || null };
  row.snapshot_id = 'cfbt_' + sha([row.game_id, row.at, row.model_version, row.home_margin, row.terms, row.qb]).slice(0, 24);
  return row;
}

/* compact board row: everything the board shows at first glance */
function boardRow(o) {
  return { game_id: o.game_id, week: o.week, kickoff: o.kickoff, home: o.game.home, away: o.game.away,
    conf: [o.game.away_conference, o.game.home_conference], fcs: o.game.fcs,
    fair: o.edgedesk.available ? o.edgedesk.fair_text : null, fair_home_margin: o.edgedesk.available ? o.edgedesk.home_margin : null,
    market: o.market.available ? o.market.consensus_text : null, market_home_line: o.market.consensus_home_line, market_stale: !!o.market.stale, books: o.market.books_fresh,
    gap: o.disagreement.available ? o.disagreement.points : null, gap_toward: o.disagreement.toward_team,
    gap_class: o.disagreement.class, verification: o.disagreement.verification, verified: o.disagreement.verified,
    status: o.status.key, status_label: o.status.label, status_reason: o.status.reason,
    research_interest: o.fields.research_interest.score, edge: o.price.available && o.price.current ? o.price.current.edge : null,
    price_at: o.price.available && o.price.current ? o.price.current.text : null,
    confidence: o.edgedesk.available ? o.edgedesk.football_confidence.score : null, reliability: o.data_quality.reliability,
    agreement: o.consensus.available ? o.consensus.agreement.tier : null, model_sd: o.consensus.sd,
    market_direction: o.disagreement.market_direction, decay: o.edge_decay.available ? o.edge_decay.verdict : null,
    uncertainty: o.uncertainty.score, flags: o.flags, summary: o.summary };
}

/* ------------------------------------------------------------ the postgame set */
function postgame(ctx) {
  const rows = ctx.recordRows;
  const recent = rows.filter((r) => ms(r.kickoff) != null && ms(r.kickoff) < ctx.now && ms(r.kickoff) > ctx.now - 10 * 86400e3);
  return recent.map((r) => {
    const gid = r.game_id, champ = (ctx.ledger.preds.get(gid) || []).filter((p) => p.model_version === ctx.gov.champion && ms(p.prediction_ts) < ms(r.kickoff))
      .sort((a, b) => ms(a.prediction_ts) - ms(b.prediction_ts));
    const quotes = (ctx.ledger.quotes.get(gid) || []).filter((q) => ms(q.observed_at) != null && ms(q.observed_at) < ms(r.kickoff));
    const b = { now: ctx.now, config: ctx.cfg, game: { game_id: gid, home: r.home, away: r.away, kickoff: r.kickoff },
      checkpoints: champ.map((p) => ({ at: p.prediction_ts, home_margin: p.pure_home_margin, checkpoint: p.checkpoint_type, model_version: p.model_version, source: 'Model Lab ' + p.origin })),
      market: { quotes: quotes.map((q) => ({ book: q.book, source: q.source, home_line: q.home_line, observed_at: q.observed_at })) } };
    /* the published record's own two numbers join the series */
    if (num(r.first_home_line) != null) b.checkpoints.push({ at: (ctx.recordGames[gid] && ctx.recordGames[gid].first) ? ctx.recordGames[gid].first.at : null, home_margin: -r.first_home_line, checkpoint: 'RECORD_FIRST', model_version: r.model_version, source: 'record' });
    if (num(r.frozen_home_line) != null) b.checkpoints.push({ at: r.frozen_at, home_margin: -r.frozen_home_line, checkpoint: 'RECORD_PICK', model_version: r.model_version, source: 'record' });
    b.checkpoints = b.checkpoints.filter((c) => c.at && num(c.home_margin) != null);
    const cfg = T.config(ctx.cfg);
    const TL = T.timelines(b, { available: true }, cfg);
    const gapC = r.close_home_line != null && r.frozen_home_line != null ? { available: true } : { available: false };
    /* the EdgeDesk Read AT THE TIME OF DECISION: the last frozen snapshot before kickoff, never a later value */
    const rds = (ctx.readRows || []).filter((x) => String(x.game_id) === String(gid) && ms(x.recorded_at) < ms(r.kickoff)).sort((a, b) => ms(a.recorded_at) - ms(b.recorded_at));
    const rAt = rds.length ? rds[rds.length - 1] : null;
    const rGrade = rAt ? (ctx.readGrades || []).filter((g) => g.read_id === rAt.read_id)[0] || null : null;
    return { game_id: gid, week: r.week, kickoff: r.kickoff, matchup: r.matchup, final: r.final_text, record: r,
      timeline: TL, edge_decay: T.edgeDecay(TL, gapC, cfg), postmortem: T.postmortem(r),
      read_at_decision: rAt, read_grade: rGrade, read_history_n: rds.length };
  });
}

/* ------------------------------------------------------------- the scorecard */
function scorecard(objs, rec, bench, cal) {
  const n = objs.length || 1;
  const share = (f) => Math.round(100 * objs.filter(f).length / n);
  const shownCal = cal.rows.filter((x) => x.shown);
  const ece = shownCal.length ? Math.round(10 * shownCal.reduce((s, x) => s + x.n * Math.abs(x.predicted - x.observed), 0) / shownCal.reduce((s, x) => s + x.n, 0)) / 10 : null;
  return [
    { dimension: 'Prediction quality', value: bench.model_mae != null ? 'MAE ' + bench.model_mae + ' vs close ' + bench.close_mae + ' (n=' + bench.n + ')' : 'building', evidence: 'record: published pregame number vs final, beside the close' },
    { dimension: 'Calibration', value: ece != null ? 'win-probability gap ' + ece + ' pts across ' + shownCal.length + ' buckets with n≥30' : 'building', evidence: 'record: published win probability vs outright result' },
    { dimension: 'Research depth', value: share((o) => o.reconcile.available) + '% of games with a reconciliation · ' + share((o) => o.sensitivity.available) + '% with sensitivity', evidence: 'research objects' },
    { dimension: 'Price intelligence', value: share((o) => o.price.available && o.price.current) + '% of games priced at a live quote · ' + share((o) => o.line_shopping.available && !o.line_shopping.single_book) + '% with 2+ books', evidence: 'Model Lab market capture' },
    { dimension: 'Explainability', value: share((o) => o.why.available && !o.why.partial) + '% with the champion’s exact terms · ' + share((o) => o.why.available && o.why.partial) + '% partial (rating term only) · ' + share((o) => o.why.v2_drivers) + '% with V2.1 drivers', evidence: 'slate disagreement_inputs; published team ratings; V2.1 current.json' },
    { dimension: 'Data freshness', value: (function () { const ages = objs.filter((o) => o.market.available).map((o) => o.market.age_minutes).sort((a, b) => a - b); return ages.length ? 'median quote age ' + ages[Math.floor(ages.length / 2)] + ' min' : 'no quotes'; })(), evidence: 'quote timestamps' },
    { dimension: 'Transparency', value: 'record n=' + rec.n + ', ATS ' + (rec.ats.pct == null ? '—' : rec.ats.pct + '%') + ', CLV n=' + rec.clv.n, evidence: 'immutable record; every rate prints its n' },
    { dimension: 'Workflow speed', value: 'board: ' + 'one row per game (5 fields); game: summary first, 8 sections behind it', evidence: 'the research page' }
  ];
}

/* the board's compact Read: what the queue shows and filters on */
function readRow(r) {
  if (!r) return null;
  const s = r.selected;
  const flags = {};
  Object.keys(RD.FILTERS).forEach((k) => { try { flags[k] = !!RD.FILTERS[k].test(r); } catch (e) { flags[k] = false; } });
  return { timing: r.timing_read, decision: r.decision_status, research: r.research_status.status, price_status: r.price_status.key,
    best_value: r.best_value_market.label, selected: s ? s.label : null, book: s ? s.book : null, cover: r.cover_probability, basis: r.probability_basis,
    break_even: r.break_even_probability, ev: r.estimated_ev, bettable_to: r.bettable_to && r.bettable_to.line != null ? r.bettable_to.line : null,
    bettable_label: r.bettable_to ? r.bettable_to.label : null, target: r.target_price ? r.target_price.line : null, alt: r.main_vs_alt_summary.alt_verdict,
    quote_check: r.market_quote_check.length > 0, flags: flags };
}

/* ------------------------------------------------------------ the Read record
   reads.jsonl  one frozen snapshot per change of a game's recordable read
   grades.jsonl one grade per snapshot, written once, after the close and the
                final exist (CLV at the recorded number; W/L at the recorded
                line and price — never a better historical line) */
function readLedger(season, built, ctx, now) {
  const base = 'football/cfb_terminal/read/' + season;
  const have = readJsonl(base + '/reads.jsonl'), graded = readJsonl(base + '/grades.jsonl');
  const lastBy = {};
  have.forEach((x) => { if (!lastBy[x.game_id] || ms(x.recorded_at) >= ms(lastBy[x.game_id].recorded_at)) lastBy[x.game_id] = x; });
  const ids = new Set(have.map((x) => x.read_id));
  const newReads = [];
  built.forEach((b) => {
    const r = b.read;
    if (!r || !RD.shouldRecord(r)) return;
    const snap = RD.snapshot(r);
    const last = lastBy[snap.game_id];
    if (ids.has(snap.read_id) || (last && last.read_id === snap.read_id)) return;
    newReads.push(snap); ids.add(snap.read_id); lastBy[snap.game_id] = snap;
  });
  const allReads = have.concat(newReads);
  /* grade once: needs the Lab's consensus close and a FINAL result */
  const gradedIds = new Set(graded.map((g) => g.read_id));
  const results = {}, closes = {};
  readJsonl('football/cfb_lab/ledger/' + season + '/results.jsonl').forEach((x) => { results[String(x.game_id)] = x; });
  ctx.ledger.lines.forEach((ls, gid) => { const c = ls.filter((l) => l.kind === 'CLOSE' && l.book === 'CONSENSUS' && l.market_type === 'spread' && num(l.home_line) != null).pop(); if (c) closes[gid] = c; });
  const newGrades = [];
  allReads.forEach((x) => {
    if (gradedIds.has(x.read_id)) return;
    const res = results[x.game_id], c = closes[x.game_id];
    if (!res || res.status !== 'FINAL' || num(res.final_margin) == null || !c) return;
    const later = (ctx.ledger.quotes.get(x.game_id) || []).filter((q) => q.book === x.book || !x.book).map((q) => ({ home_line: q.home_line, observed_at: q.observed_at }));
    const g = RD.grade(x, { close_home_line: c.home_line, final_margin: res.final_margin, later_quotes: later });
    g.graded_at = new Date(now).toISOString();
    newGrades.push(g); gradedIds.add(x.read_id);
  });
  const validation = RD.validation(allReads, graded.concat(newGrades));
  validation.n_reads = allReads.length; validation.n_grades = graded.length + newGrades.length;
  return { new_reads: newReads, new_grades: newGrades, all_reads: allReads, all_grades: graded.concat(newGrades), validation: validation,
    paths: { reads: base + '/reads.jsonl', grades: base + '/grades.jsonl', alternates: base + '/alternates.jsonl' } };
}

/* ================================================================== main */
function main() {
  const now = arg('now') ? Date.parse(arg('now')) : Date.now();
  const check = flag('check');
  const slate = readJson('football/fbs/slate.json');
  if (!slate || !slate.games) { console.error('no football/fbs/slate.json'); process.exit(2); }
  const season = slate.season;
  const gov = loadGovernance();
  const v2cur = readJson('football/cfb_v2/current.json', { rows: [] });
  const v2 = { byId: {} };
  (v2cur.rows || []).forEach((r) => { v2.byId[String(r.game_id)] = r; });
  const ledger = loadLedger(season);
  const recordFile = readJson('record/football/cfb_' + season + '.json', { games: {} });
  const recordRows = T.recordRows(recordFile.games || {});
  const ops = readJson('football/cfb_production/reports/ops.json', null);
  const tm = typicalMove();
  const cfg = { stale_minutes: gov.policy ? gov.policy.stale_minutes : 180, min_books: gov.policy ? gov.policy.min_books : 3,
    max_dispersion_iqr: gov.policy ? gov.policy.max_dispersion_iqr : 1.5, max_model_sd: gov.policy ? gov.policy.max_ensemble_sd : 6,
    min_probability_edge: gov.policy ? gov.policy.min_probability_edge : 0.01, ideal_probability_edge: gov.policy ? gov.policy.ideal_probability_edge : 0.02,
    typical_move_pts: tm || T.CONFIG.typical_move_pts };
  const warnings = [];
  if (ops && ops.system && ops.system.status !== 'OK') {
    Object.keys(ops.sections || {}).forEach((k) => { const s = ops.sections[k]; if (s && (s.status === 'CRITICAL' || s.status === 'WARNING')) warnings.push('Operations ' + s.status + ' · ' + k.replace(/_/g, ' ') + ': ' + (s.summary || s.detail || '').slice(0, 180)); });
  }
  const slateAgeH = (now - Date.parse(slate.generated_at)) / 3600e3;
  if (slateAgeH > 12) warnings.push('The champion slate is ' + Math.round(slateAgeH) + ' h old.');
  const ctx = {
    now: now, gov: gov, slate: slate, v2: v2, ledger: ledger, recordRows: recordRows, recordGames: recordFile.games || {},
    metrics: readJson('football/matchup/metrics.json', { teams: {} }), history: loadHistory(season), cfg: cfg,
    evNote: calibratedEvNote(gov.artifact, gov.policy), warnings: warnings,
    degraded: ops && ops.system ? { status: ops.system.status, rule: ops.system.rule } : null,
    sources: [
      { id: 'slate', path: 'football/fbs/slate.json', updated_at: slate.generated_at, what: 'champion projections, reliability, QB context' },
      { id: 'v21', path: 'football/cfb_v2/current.json', updated_at: v2cur.generated_at || null, what: 'V2.1 pure projections and components' },
      { id: 'lab', path: 'football/cfb_lab/ledger/' + season, updated_at: mtimeIso('football/cfb_lab/reports/' + season + '/last_run.json'), what: 'checkpoints and captured quotes (append-only)' },
      { id: 'policy', path: 'football/cfb_v2/artifacts/decision/' + gov.policy_dir + '/policy.json', updated_at: gov.policy ? gov.policy.frozen_at || null : null, what: 'frozen decision policy' },
      { id: 'metrics', path: 'football/matchup/metrics.json', updated_at: null, what: 'opponent-adjusted unit metrics' },
      { id: 'record', path: 'record/football/cfb_' + season + '.json', updated_at: recordFile.updated_at || null, what: 'the immutable public record' }
    ]
  };
  const metricsGen = ctx.metrics.generated_at || null;
  ctx.sources[4].updated_at = metricsGen;
  /* the numbers other EdgeDesk artifacts display (the Read's market quote check) */
  const pj = readJson('football/cfb_production/reports/projections.json', { games: [] });
  ctx.projections = { byId: {} };
  (pj.games || []).forEach((g) => { ctx.projections.byId[String(g.game_id)] = g; });
  ctx.sources.push({ id: 'read', path: 'lib/edgedesk_read.js · football/cfb_terminal/read/' + season, updated_at: null, what: 'the EdgeDesk Read: price-specific reads, frozen read snapshots and their grades (append-only)' });

  /* the current slate: pregame games the champion slate carries */
  const upcoming = slate.games.filter((g) => ms(g.kickoff) != null && ms(g.kickoff) > now);
  const built = upcoming.map((row) => buildGame(ctx, row));
  const objs = T.queue(built.map((x) => x.object));
  const readOf = {};
  built.forEach((x) => { readOf[x.object.game_id] = x; });

  /* THE READ RECORD: a frozen snapshot each time a game's read changes to a
     recordable state (append-only, deterministic ids), then grades against
     the close and the result — never a better historical line */
  const RL = readLedger(season, built, ctx, now);

  /* the append-only history: one row per change */
  const newSnaps = [];
  built.forEach((x) => {
    const s = x.snapshot;
    if (!s) return;
    const prior = (ctx.history.get(s.game_id) || []).slice().sort((a, b) => ms(a.at) - ms(b.at)).pop();
    if (prior && prior.snapshot_id === s.snapshot_id) return;
    if (prior && prior.model_version === s.model_version && Math.abs(prior.home_margin - s.home_margin) < 0.005
      && JSON.stringify(prior.terms) === JSON.stringify(s.terms) && JSON.stringify(prior.qb) === JSON.stringify(s.qb)) return;
    newSnaps.push(s);
  });

  const rec = T.recordSummary(recordRows);
  const cal = T.calibration(recordRows);
  const bench = T.benchmark(recordRows, { n: (() => { let k = 0; ledger.lines.forEach((ls) => { if (ls.some((l) => l.kind === 'OPEN' && l.market_type === 'spread' && num(l.home_line) != null)) k++; }); return k; })(),
    note: 'openers the Lab archived with a line; the rest are MISSING, so an opener benchmark waits for the archive' });
  const weekOf = objs.length ? objs.map((o) => o.week).sort()[0] : null;
  const brief = T.brief(objs, { generated_at: new Date(now).toISOString(), season: season, week: weekOf });
  ctx.readRows = RL.all_reads; ctx.readGrades = RL.all_grades;
  const pg = postgame(ctx);

  const meta = {
    generated_at: new Date(now).toISOString(), season: season, contract: T.version,
    champion: { model_version: gov.champion, label: gov.champion_label, selection: gov.manifest.champion_selection || null,
      note: 'EDGEDESK FAIR is the governance champion’s number. A person promotes a challenger (football/cfb_lab/governance.js promote); this build then follows it.' },
    production_pathway: { model_version: gov.production_model, status: gov.manifest.production_model_status || null },
    decision: { policy: gov.policy_dir, calibration: gov.calibration_version, calibration_for: gov.artifact ? gov.artifact.base_model_version : null,
      bet_enabled: !!(gov.policy && gov.policy.bet_enabled), calibrated_ev_note: ctx.evNote, wait_enabled: !!(gov.policy && gov.policy.wait && gov.policy.wait.enabled) },
    operations: ctx.degraded, warnings: warnings, config: T.config(cfg), sources: ctx.sources,
    inputs_sha256: sha([slate.generated_at, v2cur.generated_at, ledger.n_preds, ledger.n_quotes, recordFile.updated_at]).slice(0, 16)
  };
  const board = Object.assign({ schema: 'edgedesk_cfb_terminal_board_v1' }, meta, {
    counts: T.counts(objs), terms: T.TERMS, statuses: T.STATUS, status_order: T.STATUS_KEYS,
    filters: Object.keys(T.FILTERS).map((k) => ({ key: k, label: T.FILTERS[k].label, n: objs.filter((o) => o.flags[k]).length })),
    rows: objs.map((o) => Object.assign(boardRow(o), { read: readRow(readOf[o.game_id] && readOf[o.game_id].read) })),
    read_filters: Object.keys(RD.FILTERS).map((k) => ({ key: k, label: RD.FILTERS[k].label, n: objs.filter((o) => { const r = readOf[o.game_id] && readOf[o.game_id].read; try { return !!(r && RD.FILTERS[k].test(r)); } catch (e) { return false; } }).length })),
    read_counts: (() => { const c = {}; objs.forEach((o) => { const r = readOf[o.game_id] && readOf[o.game_id].read; const k = r ? r.timing_read : 'NO_READ'; c[k] = (c[k] || 0) + 1; }); return c; })(),
    read_validation: RL.validation,
    record_headline: { n: rec.n, ats: rec.ats, clv: rec.clv, versions: rec.versions }
  });
  const games = Object.assign({ schema: 'edgedesk_cfb_terminal_games_v1' }, meta, { games: {} });
  objs.forEach((o) => { const x = readOf[o.game_id] || {}; games.games[o.game_id] = Object.assign({}, o, { read: x.read || null, read_inputs: x.read_inputs || null }); });
  games.read = { version: RD.VERSION, timing_vocabulary: RD.TIMING, research_vocabulary: RD.RESEARCH_STATUS, validation: RL.validation, ledger: RL.paths };
  const record = Object.assign({ schema: 'edgedesk_cfb_terminal_record_v1' }, meta, {
    rows: recordRows, summary: rec, calibration: cal, benchmark: bench,
    by_version: Object.keys(rec.versions).map((v) => ({ model_version: v, summary: T.recordSummary(recordRows.filter((r) => (r.model_version || 'unknown') === v)) })),
    governance: Object.keys(gov.roles).map((k) => ({ model_version: k, role: gov.roles[k].role, label: gov.roles[k].model_label, since: gov.roles[k].effective_at, reason: gov.roles[k].reason })),
    postgame: pg, filters: Object.keys(T.RECORD_FILTERS),
    read_record: { validation: RL.validation, reads: RL.all_reads.slice(-400), grades: RL.all_grades.slice(-400),
      rules: ['A read is frozen the moment a game’s read changes to a recordable state: book, line, odds, time, fair, probability, EV and status.',
        'It is graded once, against the Model Lab’s consensus close and the final, at the recorded number — never a better historical line.',
        'Timing earns validation through CLV, entry quality and price movement on prospective reads, never because BET EARLY reads happened to win.',
        'PASS and PRICE GONE reads are graded as counterfactuals, never counted as wagers.'] },
    rules: ['Nothing is removed. A published number is graded as published.', 'The pick is the last pregame number; the first is kept beside it.',
      'Process (the price against the close) is graded apart from the outcome (the result).', 'Model versions are never merged: every rate names the version it came from.'],
    scorecard: null
  });
  record.scorecard = scorecard(objs, rec, bench, cal);
  board.scorecard = record.scorecard;
  const briefOut = Object.assign({ }, brief, { champion: meta.champion, decision: meta.decision });

  /* verify before writing: one fair line everywhere, nothing actionable on a stale market */
  const problems = [];
  objs.forEach((o) => {
    const row = slate.games.find((g) => String(g.game_id) === o.game_id);
    if (gov.champion !== 'edgedesk_cfb_v2.1.0' && o.edgedesk.available && Math.abs(o.edgedesk.home_margin - row.model_home_margin) > 0.005) problems.push(o.game_id + ': fair differs from the slate');
    if (o.market.stale && ['BET', 'RESEARCH', 'WAIT'].indexOf(o.status.key) >= 0) problems.push(o.game_id + ': actionable status on a stale market');
    if (o.status.key === 'BET' && !(gov.policy && gov.policy.bet_enabled)) problems.push(o.game_id + ': BET while betting is disabled');
    const rd = readOf[o.game_id] && readOf[o.game_id].read;
    if (rd && rd.actionable && !(gov.policy && gov.policy.bet_enabled)) problems.push(o.game_id + ': an actionable Read while betting is disabled');
    if (rd && rd.actionable && rd.selected && !rd.selected.fresh) problems.push(o.game_id + ': an actionable Read on a stale quote');
    if (rd && rd.actionable && rd.research_status.blocks_action) problems.push(o.game_id + ': an actionable Read on an unverified gap');
    if (rd && !rd.language.ok) problems.push(o.game_id + ': Read wording ' + rd.language.problems.join('; '));
    if (rd && o.edgedesk.available && rd.projected_margin != null && Math.abs(rd.projected_margin - o.edgedesk.home_margin) > 0.005) problems.push(o.game_id + ': the Read’s fair differs from the research object');
  });
  if (problems.length) { console.error('terminal build refused:\n  ' + problems.join('\n  ')); process.exit(1); }

  const summary = { games: objs.length, counts: board.counts, read_counts: board.read_counts, new_snapshots: newSnaps.length, postgame: pg.length, record_rows: recordRows.length,
    read_snapshots_new: RL.new_reads.length, read_grades_new: RL.new_grades.length };
  if (check) { console.log(JSON.stringify(summary, null, 1)); return; }
  /* --out <dir>: write the four artifacts elsewhere (demos, replays); the
     append-only history is only ever written by a normal build */
  const outDir = arg('out') ? path.resolve(arg('out')) : OUT;
  if (outDir !== OUT) fs.mkdirSync(outDir, { recursive: true });
  const w = (f, o) => fs.writeFileSync(path.join(outDir, f), JSON.stringify(o) + '\n');
  w('board.json', board); w('games.json', games); w('record.json', record); w('brief.json', briefOut);
  if (newSnaps.length && outDir === OUT) {
    const hp = historyPath(season);
    fs.mkdirSync(path.dirname(hp), { recursive: true });
    fs.appendFileSync(hp, newSnaps.map((s) => JSON.stringify(s)).join('\n') + '\n');
  }
  /* the Read record is append-only and, like the history, only a normal build writes it */
  if (outDir === OUT) {
    const rp = path.join(OUT, 'read', String(season));
    if (RL.new_reads.length || RL.new_grades.length) fs.mkdirSync(rp, { recursive: true });
    if (RL.new_reads.length) fs.appendFileSync(path.join(rp, 'reads.jsonl'), RL.new_reads.map((x) => JSON.stringify(x)).join('\n') + '\n');
    if (RL.new_grades.length) fs.appendFileSync(path.join(rp, 'grades.jsonl'), RL.new_grades.map((x) => JSON.stringify(x)).join('\n') + '\n');
  }
  w('read_validation.json', Object.assign({ schema: 'edgedesk_read_validation_file_v1', generated_at: new Date(now).toISOString(), season: season }, RL.validation));
  /* the Read for spreadsheets and API readers: one row per game (lib/edgedesk_read.js exportRow) */
  const csvRows = objs.map((o) => readOf[o.game_id] && readOf[o.game_id].read).filter(Boolean).map(RD.exportRow);
  if (csvRows.length) {
    const cols = Object.keys(csvRows[0]);
    const cell = (v) => { if (v == null) return ''; const t = String(v); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
    fs.writeFileSync(path.join(outDir, 'read.csv'), cols.join(',') + '\n' + csvRows.map((r) => cols.map((c) => cell(r[c])).join(',')).join('\n') + '\n');
  }
  console.log(JSON.stringify(summary));
}

if (require.main === module) main();
module.exports = { buildGame, boardRow, snapshotRow, v1Dist, v2Dist, v1Sigma, loadGovernance, calibratedEvNote, typicalMove };
