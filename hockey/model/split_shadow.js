'use strict';
/* ===========================================================================
   EdgeDesk NHL — the split-factor shadow: a pre-registered challenger to the
   pair recalibration's home/away split, priced beside production on every
   game and never published as the price.

   WHY IT EXISTS. On 2026-10-29 a reader saw every favourite less favoured
   than DraftKings (SJS −133 vs −198, MIN −146 vs −192). The captured closes
   (research/clv/openers/nhl) agreed: in 35 of 47 settled 2026-27 games the
   book's favourite was less favoured by the published price, by 2.2 points
   on average, and the book's prices were 1.2 times as spread out. Two
   causes were measured (docs/engine/NHL_LAB.md §6.3):
     - this season's split factor b = 0.90 (glm.js fitPairCalibration, fitted
       on the goal split of the three seasons before) is the lowest since
       2013-14, and it pulls every goal share 10% toward even;
     - fitted on what the slate publishes (the two-way moneyline) instead of
       on goals, the split comes out about 10% wider in both windows
       (1.125 on 2014-20, 1.15 on 2021-26, against 1.025 on goals).
   Neither fix beats production on the 2021-26 record (shadow +0.00027 log
   loss, interval covers zero; hockey/validation/nhl_split_shadow.json), so
   production keeps its price and the candidate is tested here, on games no
   one has seen.

   THE CANDIDATE (frozen for 2026-27): the production pair recalibration with
   its total compression a and centre c unchanged, and the split factor b
   chosen on glm.js's own grid (0.7 to 1.6, step 0.025) to maximise the
   moneyline log-likelihood of every earlier out-of-sample game since
   2013-14, each priced exactly as production priced it except for b. For
   2026-27 that is b = 1.125 (production: 0.9). hockey/lab/split_shadow.js
   recomputes it and fails its --check if it is not 1.125.

   THE RULE (written 2026-10-29, before any game in the shadow ledger existed)
   is PROTOCOL.rule below. Read it before changing anything in this file.

   THE SHADOW LEDGER (hockey/ledger/split_shadow_<season>.jsonl) is append-only
   and hash-checked like the production ledger. Each row freezes the shadow's
   price AND production's at the same moment, so the pair is graded on equal
   terms. The production ledger is not touched.

   PROMOTED BY THE OWNER, 2026-10-29 (PROTOCOL.promoted), before the rule's
   decision point and against the 2021-26 record. From then on the published
   2026-27 price uses b = 1.125: walkforward.js writes it into the live
   parameters (and lab/base.js prices the live season the same way), with the
   goal-split value kept beside it as goal_split_b. The shadow stops pricing,
   since it is now the price; the 33 rows already in its ledger stay as they
   are and are still graded. The DraftKings spread check keeps running on the
   published price.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const C = require('../config');
const V = require('../../engine/validation');
const GLM = require('./glm');

const PROTOCOL = {
  id: 'nhl_split_ml_v1',
  registered: '2026-10-29',
  season: 2027,
  b: 1.125,
  grid: [0.7, 1.6, 0.025],
  min_fit_games: 500,
  decision_n: 1000,
  production: 'pair recalibration (hockey/model/glm.js): the split factor b is the maximum-likelihood fit of the regulation goal split on the three seasons before (0.9 for 2026-27)',
  candidate: 'the same pair recalibration with a and c unchanged and b fitted on the moneyline (two-way, overtime and the shootout included) log-likelihood of every earlier out-of-sample game since 2013-14, each priced as production priced it but for b (1.125 for 2026-27, frozen)',
  rule: [
    'Population: every game whose last record in the shadow ledger was written before puck drop, graded against the official final. The shadow ledger starts with this change, so no game read for the registration is in it.',
    'The decision is read once, on the first 1,000 graded games by start time. Before that the record is IN_PROGRESS and its numbers are interim, not a decision. If the 2026-27 season ends first, the result is NOT_CONFIRMED.',
    'ELIGIBLE only if, on those games: (a) the moneyline log loss of the shadow minus production has a paired block-bootstrap 95% interval over dates (1,000 resamples, seed 20261013) wholly below zero; (b) the shadow\'s moneyline calibration slope is between 0.85 and 1.15 and |mean p − mean y| is at most 0.02; (c) the shadow\'s home −1.5 puck-line log loss is at most 0.001 above production\'s. Otherwise NOT_CONFIRMED.',
    'DraftKings\' closing prices (research/clv/openers/nhl) are reported beside the result. They never decide it.',
    'ELIGIBLE changes nothing by itself: promotion is a methodology-change pull request carrying this record, reviewed by the owner.',
  ],
  promoted: {
    on: '2026-10-29', by: 'the owner', from_b: 0.9,
    basis: 'the owner directed the switch after the investigation, before the rule\'s decision point: the published moneyline was 1.2 times narrower than DraftKings\' closes (35 of 47 favourites less favoured). On 2021-26 the candidate is +0.00027 log loss (−0.00013 to +0.00063) against the goal-split rule; on 2026-27 to date −0.00265 (198 games). The decision rule was not met and is not claimed.',
  },
};
const VERDICTS = ['IN_PROGRESS', 'ELIGIBLE', 'NOT_CONFIRMED', 'PROMOTED'];
const SPREAD_READINGS = ['TOO_EARLY', 'NARROWER_THAN_MARKET', 'WIDER_THAN_MARKET', 'CONSISTENT'];
const LEDGER_SCHEMA = 'edgedesk_nhl_split_shadow_ledger_v1';
const OPENERS = path.join(C.ROOT, 'research', 'clv', 'openers', 'nhl');
/* ESPN's NHL abbreviations that differ from the NHL's (the same map Today's Games uses: lib/edgedesk_games.js) */
const ESPN_NHL = { NJ: 'NJD', TB: 'TBL', LA: 'LAK', SJ: 'SJS', UTAH: 'UTA', MON: 'MTL', WAS: 'WSH' };

const r4 = (v) => (v == null || !isFinite(v) ? null : Math.round(v * 1e4) / 1e4);
const logit = (p) => Math.log(p / (1 - p));

function grid() { const [lo, hi, st] = PROTOCOL.grid; const g = []; for (let b = lo; b <= hi + 1e-9; b += st) g.push(+b.toFixed(3)); return g; }
/** the shadow prices beside production only while it is not production */
function active(season) { return season === PROTOCOL.season && !PROTOCOL.promoted; }
/** the split factor the published price uses this season, when promoted (null otherwise) */
function promotedSplit(season) { return PROTOCOL.promoted && season === PROTOCOL.season ? PROTOCOL.b : null; }
/**
 * Production's pair recalibration for a season, with the promoted split
 * factor when there is one. a and c are kept; the goal-split fit is kept as
 * goal_split_b. An identity calibration (no earlier record) is left alone.
 */
function promote(cal, season) {
  const b = promotedSplit(season);
  if (b == null || !cal || !cal.c) return cal;
  return Object.assign({}, cal, { b, goal_split_b: cal.goal_split_b != null ? cal.goal_split_b : cal.b, split_basis: PROTOCOL.id + ' promoted ' + PROTOCOL.promoted.on + ': b fitted on the moneyline of every earlier out-of-sample game (hockey/model/split_shadow.js)' });
}
/** the shadow's pair recalibration: production's, with the frozen split factor */
function shadowCal(cal) { return Object.assign({}, cal || {}, { b: PROTOCOL.b }); }
/** λ under the shadow (glm.js applyPairCalibration with the frozen b) */
function shadowLambda(lh, la, cal) { return GLM.applyPairCalibration(lh, la, shadowCal(cal)); }

/**
 * The split factor that maximises the moneyline log-likelihood.
 * rows: [{ ps: [P(home wins) at each grid value], y: 1|0 }]; fewer than
 * PROTOCOL.min_fit_games rows gives the identity (1), as glm.js does.
 */
function fitMoneylineSplit(rows, g) {
  g = g || grid();
  if (!rows || rows.length < PROTOCOL.min_fit_games) return { b: 1, n: rows ? rows.length : 0, basis: 'identity: fewer than ' + PROTOCOL.min_fit_games + ' earlier out-of-sample games' };
  let best = null;
  for (let i = 0; i < g.length; i++) {
    let ll = 0; for (const r of rows) ll += V.logLoss(r.ps[i], r.y);
    if (!best || ll < best.ll) best = { b: g[i], ll };
  }
  return { b: best.b, n: rows.length, log_loss: V.r(best.ll / rows.length, 5), basis: 'maximum moneyline likelihood on earlier seasons\' out-of-sample predictions' };
}

/* ---------- DraftKings closes from the hourly ESPN capture ---------- */
function noVigHome(ml) {
  if (!ml || ml.home == null || ml.away == null) return null;
  const imp = (a) => (a < 0 ? -a / (-a + 100) : 100 / (a + 100));
  const h = imp(ml.home), a = imp(ml.away);
  return h + a > 0 ? h / (h + a) : null;
}
/** every NHL game the capture settled with DraftKings' close: [{ start_utc, home, away, ml, p_home }] (NHL abbreviations) */
function readCloses(dir) {
  dir = dir || OPENERS;
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /\.jsonl$/.test(f)).sort(); } catch (_) { return []; }
  const ev = new Map(), closes = new Map();
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line) continue;
      let r; try { r = JSON.parse(line); } catch (_) { continue; }
      if (r.kind === 'event' || r.kind === 'archive') ev.set(r.cid, r);
      if ((r.kind === 'settle' || r.kind === 'archive') && r.completed && Array.isArray(r.books)) {
        const dk = r.books.find((b) => b && b.book === 'DraftKings' && b.close && b.close.ml && b.close.ml.home != null && b.close.ml.away != null);
        if (dk) closes.set(r.cid, dk.close.ml);
      }
    }
  }
  const ab = (a) => ESPN_NHL[a] || a;
  const out = [];
  for (const [cid, ml] of closes) {
    const e = ev.get(cid); if (!e || !e.home || !e.away) continue;
    const p = noVigHome(ml); if (p == null) continue;
    out.push({ cid, start_utc: e.start_utc, home: ab(e.home.abbr), away: ab(e.away.abbr), ml: { home: ml.home, away: ml.away }, p_home: p });
  }
  return out;
}
/** the close for one game: same clubs, ESPN's start within 6 hours of the NHL's */
function matchClose(closes, startUtc, home, away) {
  const t = Date.parse(startUtc);
  return closes.find((c) => c.home === home && c.away === away && Math.abs(Date.parse(c.start_utc) - t) <= 6 * 3600e3) || null;
}

/**
 * How spread out the model's moneyline is against the market's, on the same games.
 * pairs: [{ p, m }] (model and no-vig market P(home)). The slope is least
 * squares of the market's logit on the model's: 1 when the two are equally
 * spread, above 1 when the model is narrower (every favourite less favoured).
 */
function spreadStats(pairs) {
  const n = pairs.length;
  const out = { n, slope: null, ci95: null, reading: 'TOO_EARLY', mean_favourite_gap_pp: null, favourites_less_favoured: null, model_logit_sd: null, market_logit_sd: null };
  if (!n) return out;
  const x = pairs.map((q) => logit(q.p)), y = pairs.map((q) => logit(q.m));
  const mx = x.reduce((a, v) => a + v, 0) / n, my = y.reduce((a, v) => a + v, 0) / n;
  let sxx = 0, sxy = 0, syy = 0; for (let i = 0; i < n; i++) { sxx += (x[i] - mx) ** 2; sxy += (x[i] - mx) * (y[i] - my); syy += (y[i] - my) ** 2; }
  let gap = 0, less = 0;
  for (const q of pairs) { const s = q.m >= 0.5 ? 1 : -1; const d = (q.p - q.m) * s; gap += d; if (d < 0) less++; }
  out.mean_favourite_gap_pp = V.r(100 * gap / n, 2);
  out.favourites_less_favoured = less;
  out.model_logit_sd = V.r(Math.sqrt(sxx / n), 3); out.market_logit_sd = V.r(Math.sqrt(syy / n), 3);
  if (n < 30 || !(sxx > 0)) return out;
  const b = sxy / sxx; let rss = 0; for (let i = 0; i < n; i++) rss += (y[i] - my - b * (x[i] - mx)) ** 2;
  const se = Math.sqrt(rss / (n - 2) / sxx);
  out.slope = V.r(b, 3); out.ci95 = [V.r(b - 1.96 * se, 3), V.r(b + 1.96 * se, 3)];
  out.reading = out.ci95[0] > 1 ? 'NARROWER_THAN_MARKET' : out.ci95[1] < 1 ? 'WIDER_THAN_MARKET' : 'CONSISTENT';
  return out;
}

/* ---------- the shadow ledger ---------- */
function ledgerFile(season) { return path.join(C.PATHS.ledger, 'split_shadow_' + (season || C.CURRENT_SEASON) + '.jsonl'); }
const hashOf = (rec) => crypto.createHash('sha256').update(JSON.stringify(rec)).digest('hex').slice(0, 16);
/**
 * Append each upcoming game's shadow and production prices when either moved
 * by half a point or more (or the production model changed). Every game on
 * the slate must carry calibration_shadow. Returns the number of rows added.
 */
function ledgerAppend(slate, now, file) {
  file = file || ledgerFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const last = new Map();
  for (const line of old.split('\n')) { if (!line) continue; const r = JSON.parse(line); last.set(r.game_id, r); }
  let added = 0, text = old;
  for (const g of slate.games) {
    const sh = g.calibration_shadow;
    if (!sh || !(Date.parse(g.start_utc) > now)) continue;
    const rec = { schema: LEDGER_SCHEMA, protocol: PROTOCOL.id, game_id: g.game_id, start_utc: g.start_utc, type: g.type, home: g.home, away: g.away, recorded_at: slate.generated_at,
      production: { model: slate.model.id, b: sh.production_b, p_home: g.prices.moneyline.home, pl_home_minus_1_5: g.prices.puck_line.home_minus_1_5 },
      shadow: { b: sh.b, p_home: sh.p_home, pl_home_minus_1_5: sh.pl_home_minus_1_5 } };
    const prev = last.get(g.game_id);
    const moved = !prev || prev.production.model !== rec.production.model || Math.abs(prev.production.p_home - rec.production.p_home) >= 0.005 || Math.abs(prev.shadow.p_home - rec.shadow.p_home) >= 0.005;
    if (!moved) continue;
    rec.id = hashOf(rec);
    text += JSON.stringify(rec) + '\n'; added++;
  }
  if (added) { const tmp = file + '.tmp'; fs.writeFileSync(tmp, text); if (!fs.readFileSync(tmp, 'utf8').startsWith(old)) throw new Error('shadow ledger prefix check failed'); fs.renameSync(tmp, file); }
  return added;
}
/** the shadow ledger's own integrity: every row as written, recorded before its start, no duplicate */
function checkLedger(file) {
  file = file || ledgerFile();
  const fails = [];
  if (!fs.existsSync(file)) return fails;
  const seen = new Set();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue; const r = JSON.parse(line); const id = r.id; delete r.id;
    if (r.schema !== LEDGER_SCHEMA) fails.push('shadow ledger record ' + id + ' is not ' + LEDGER_SCHEMA);
    if (hashOf(r) !== id) fails.push('shadow ledger record ' + id + ' was edited');
    if (!(Date.parse(r.recorded_at) < Date.parse(r.start_utc))) fails.push('shadow ledger record ' + id + ' recorded at or after the start');
    if (seen.has(id)) fails.push('duplicate shadow ledger record ' + id); seen.add(id);
  }
  return fails;
}
/** the last record before the start, per game */
function lastPregame(recs) {
  const last = new Map();
  for (const r of recs) {
    if (!(Date.parse(r.recorded_at) < Date.parse(r.start_utc))) continue;
    const prev = last.get(r.game_id); if (!prev || r.recorded_at >= prev.recorded_at) last.set(r.game_id, r);
  }
  return last;
}
function readJsonl(file) { return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []; }

/* ---------- the rule ---------- */
/**
 * rows: graded games [{ date, start_utc, y, margin, prod: { p, pl }, shadow: { p, pl } }].
 * The decision set is the first PROTOCOL.decision_n by start time, fixed once reached.
 */
function verdict(rows) {
  const sorted = rows.slice().sort((a, b) => Date.parse(a.start_utc) - Date.parse(b.start_utc));
  const reached = sorted.length >= PROTOCOL.decision_n;
  const set = reached ? sorted.slice(0, PROTOCOL.decision_n) : sorted;
  const out = { status: null, rule_status: null, n: set.length, needed: PROTOCOL.decision_n, decision_set: reached ? 'the first ' + PROTOCOL.decision_n + ' graded games by start time' : 'interim: every graded game so far (not a decision)' };
  const done = (st) => { out.rule_status = st; out.status = PROTOCOL.promoted ? 'PROMOTED' : st; if (PROTOCOL.promoted) { out.promoted = PROTOCOL.promoted; out.decision_set = 'interim: the rows frozen before the promotion (not a decision; the rule was not met)'; } return out; };
  if (!set.length) return done('IN_PROGRESS');
  const ml = (k) => V.binary(set.map((x) => ({ p: x[k].p, y: x.y })));
  const mP = ml('prod'), mS = ml('shadow');
  out.moneyline = {
    production: { log_loss: mP.log_loss, calibration_slope: mP.calibration_slope, calibration_in_the_large: mP.calibration_in_the_large },
    shadow: { log_loss: mS.log_loss, calibration_slope: mS.calibration_slope, calibration_in_the_large: mS.calibration_in_the_large },
    shadow_minus_production: V.pairedBootstrap(set.map((x) => ({ date: x.date, a: V.logLoss(x.shadow.p, x.y), b: V.logLoss(x.prod.p, x.y) })), { B: 1000, seed: 20261013 }),
  };
  const pl = set.filter((x) => x.prod.pl != null && x.shadow.pl != null);
  const plLL = (k) => (pl.length ? pl.reduce((a, x) => a + V.logLoss(x[k].pl, x.margin >= 2 ? 1 : 0), 0) / pl.length : null);
  out.puck_line_home_minus_1_5 = { n: pl.length, production_log_loss: V.r(plLL('prod'), 5), shadow_log_loss: V.r(plLL('shadow'), 5) };
  out.checks = {
    moneyline_interval_below_zero: out.moneyline.shadow_minus_production.ci95[1] < 0,
    calibration: mS.calibration_slope != null && mS.calibration_slope >= 0.85 && mS.calibration_slope <= 1.15 && Math.abs(mS.calibration_in_the_large) <= 0.02,
    puck_line_not_worse: pl.length > 0 && plLL('shadow') <= plLL('prod') + 0.001,
  };
  return done(reached ? (Object.values(out.checks).every(Boolean) ? 'ELIGIBLE' : 'NOT_CONFIRMED') : 'IN_PROGRESS');
}

/**
 * The live record: the shadow ledger graded against the finals, both prices
 * against DraftKings' closes, and production's whole-season spread against
 * the closes from the production ledger (the monitor).
 * o: { season, teamGames, closes, shadowRecs, productionRecs }
 */
function grade(o) {
  o = o || {};
  const season = o.season || C.CURRENT_SEASON;
  const TG = require('../ingest/team_games');
  const tg = o.teamGames || TG.loadTeamGames([season]);
  const res = new Map(); for (const t of tg) if (t.home === 1) res.set(t.game_id, t);
  const closes = o.closes || readCloses();
  const shadowRecs = o.shadowRecs || readJsonl(ledgerFile(season));
  const prodRecs = o.productionRecs || readJsonl(path.join(C.PATHS.ledger, season + '.jsonl'));
  const rows = [];
  for (const [gid, r] of lastPregame(shadowRecs)) {
    const t = res.get(gid); if (!t) continue;
    rows.push({ game_id: gid, date: t.date, start_utc: r.start_utc, home: r.home, away: r.away, y: t.win, margin: t.gf - t.ga, prod: { p: r.production.p_home, pl: r.production.pl_home_minus_1_5 }, shadow: { p: r.shadow.p_home, pl: r.shadow.pl_home_minus_1_5 } });
  }
  const v = verdict(rows);
  /* DraftKings' closes on the shadow's graded games (reported, never deciding) */
  const withClose = rows.map((x) => Object.assign({ close: matchClose(closes, x.start_utc, x.home, x.away) }, x)).filter((x) => x.close);
  v.draftkings_close = {
    n: withClose.length,
    production: spreadStats(withClose.map((x) => ({ p: x.prod.p, m: x.close.p_home }))),
    shadow: spreadStats(withClose.map((x) => ({ p: x.shadow.p, m: x.close.p_home }))),
    close_log_loss: withClose.length ? V.r(withClose.reduce((a, x) => a + V.logLoss(x.close.p_home, x.y), 0) / withClose.length, 5) : null,
    note: 'no-vig DraftKings close from ESPN (research/clv/openers/nhl); reported beside the rule, never deciding it',
  };
  /* the monitor: production's last pregame price for every graded game of the season against the close */
  const mon = [];
  for (const [gid, r] of lastPregame(prodRecs)) {
    if (!res.has(gid)) continue;
    const c = matchClose(closes, r.start_utc, r.home, r.away); if (!c) continue;
    mon.push({ p: r.p_home, m: c.p_home });
  }
  return {
    season, protocol: PROTOCOL.id, generated_at: new Date().toISOString(),
    shadow_ledger: path.relative(C.ROOT, ledgerFile(season)), shadow_ledger_records: shadowRecs.length, games_graded: rows.length,
    verdict: v,
    market_spread: Object.assign({ basis: 'production\'s last pregame ledger price (hockey/ledger/' + season + '.jsonl) for every graded game with a DraftKings close; the slope is the market\'s logit on the model\'s (1 = equally spread; above 1 = the model is narrower, every favourite less favoured)' }, spreadStats(mon)),
  };
}

module.exports = { PROTOCOL, VERDICTS, SPREAD_READINGS, LEDGER_SCHEMA, ESPN_NHL, grid, active, promotedSplit, promote, shadowCal, shadowLambda, fitMoneylineSplit, noVigHome, readCloses, matchClose, spreadStats, ledgerFile, ledgerAppend, checkLedger, lastPregame, verdict, grade, readJsonl };
