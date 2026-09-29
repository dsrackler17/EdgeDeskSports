#!/usr/bin/env node
/* ===========================================================================
   PLAYER PROPS RECORD — freeze before kickoff, grade after the final.
   docs/player-props/RECORD.md

     node football/props/record.js freeze [--league nfl|cfb] [--now ISO]
     node football/props/record.js grade  [--league nfl|cfb] [--now ISO]
     node football/props/record.js verify [--league nfl|cfb] [--base REF]

   FREEZE (pregame). For every prop on the evaluated board with a fresh,
   priced market, EDProps.freeze() writes an immutable prediction — player,
   prop, side, line, price, book, EdgeDesk probability, fair odds, fair
   line, EV, the decision and units, reliability, stage, the quote's capture
   time, the model version and the projection id — to an APPEND-ONLY ledger:
       football/props/ledger/<league>/<season>/predictions.jsonl
   A prop is frozen when it is first seen with a market (FIRST), whenever
   its decision class changes (DECISION_CHANGE), and inside the final three
   hours (PREGAME_FINAL, again only when its price or decision moved). A
   later price is a NEW prediction with its own id; nothing is updated, and
   `verify` proves the committed ledger only ever grew (the git base must be
   a prefix of the working file). freeze() refuses at or after kickoff.

   GRADE (postgame). Against the box score the model itself reads (nflverse /
   cfbfastR): WIN / LOSS / PUSH, VOID when the player did not play or the
   game was not played. Units at the price taken; CLV against the last
   pre-kickoff consensus (price CLV at the same line, line CLV in points).
   The graded record is published as record/props/<league>_<season>.json
   with scorecards overall and by prop type, position, tier, stage,
   confidence tier, book, decision and model version, the edge buckets and
   the calibration table. The PREGAME_FINAL row of each prop is the one the
   headline scorecard counts; every decision class is graded, PASS included.
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const P = require('../../lib/edgedesk_props.js');
const { writeIfChanged } = require('../../tools/football/write_if_changed.js');

const ROOT = path.join(__dirname, '..', '..');
function arg(n, d) { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; }
function readJson(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return d; } }
function readJsonl(p) { try { return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (_) { return []; } }
function ledgerPath(league, season) { return path.join(__dirname, 'ledger', league.toLowerCase(), String(season), 'predictions.jsonl'); }
const FINAL_WINDOW_H = 3;

/* ------------------------------------------------------------ FREEZE */
function freeze(league, now, opts) {
  opts = opts || {};
  const L = league.toLowerCase();
  const board = opts.board || readJson(path.join(__dirname, L, 'board.json'), null);
  if (!board) return { league, frozen: 0, skipped: 'no board' };
  const market = opts.market || require('./capture.js').loadMarket(L, board.games.map((g) => g.game_id), opts.market_dir);
  const file = opts.ledger || ledgerPath(L, board.season);
  const prior = readJsonl(file);
  const lastByProp = new Map();
  prior.forEach((x) => lastByProp.set(x.game_id + '|' + x.player_id + '|' + x.prop_type, x));
  const out = [];
  const gameFiles = {};
  board.rows.forEach((row) => {
    if (!row.mkt || !row.dec || row.dec.cls === 'NO_DECISION' || !row.px) return;
    const g = board.games.find((x) => x.game_id === row.gid);
    if (!g) return;
    const ko = Date.parse(g.kickoff);
    if (!(now < ko)) return;
    const gf = gameFiles[row.gid] || (gameFiles[row.gid] = (opts.gameFiles && opts.gameFiles[row.gid]) || readJson(path.join(__dirname, L, 'games', row.gid + '.json'), null));
    if (!gf) return;
    const rec = (gf.projections || []).find((x) => x.projection_id === row.id);
    if (!rec) return;
    const proj = P.hydrate(gf, rec);
    const k = row.gid + '|' + row.pid + '|' + row.prop;
    /* the same canonical evaluation the board ran, re-run on the same inputs */
    const ev = P.prepare(proj, market.props[k] || [], { now, stages: board.stages, cv_norm: board.cv_norm, calibration: board.calibration, history: market.history[k], open: market.open[k] }).evaluation;
    if (ev.decision === 'NO_DECISION') return;
    ev.units = row.dec.units; /* card-level exposure caps, as published */
    const last = lastByProp.get(k);
    const inFinal = ko - now <= FINAL_WINDOW_H * 3600e3;
    const rec0 = ev.recommended || ev.best;
    if (!rec0) return;
    const changed = !last || last.decision !== ev.decision || last.line !== rec0.line || last.american !== rec0.american || last.book !== rec0.book || last.side !== rec0.side;
    let kind = null;
    if (!last) kind = 'FIRST';
    else if (last.decision !== ev.decision) kind = 'DECISION_CHANGE';
    else if (inFinal && changed) kind = 'PREGAME_FINAL';
    else if (inFinal && last.kind !== 'PREGAME_FINAL') kind = 'PREGAME_FINAL';
    if (!kind) return;
    const f = P.freeze(proj, ev, now);
    if (!f) return;
    const row2 = Object.assign({}, f, { kind, market_prob_source: rec0.market_prob_source || null, consensus_line: ev.consensus.consensus_line, books: ev.consensus.books, novig_over: ev.consensus.novig_over == null ? null : Math.round(ev.consensus.novig_over * 1e4) / 1e4 });
    if (prior.some((x) => x.prediction_id === row2.prediction_id)) return;
    out.push(row2);
    lastByProp.set(k, row2);
  });
  if (out.length && !opts.dry) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, out.map((x) => JSON.stringify(x)).join('\n') + '\n'); }
  return { league, frozen: out.length, kinds: out.reduce((o, x) => { o[x.kind] = (o[x.kind] || 0) + 1; return o; }, {}), ledger: path.relative(ROOT, file) };
}

/* ------------------------------------------------------------- GRADE */
async function grade(league, now, opts) {
  opts = opts || {};
  const L = league.toLowerCase();
  const seasons = opts.seasons || [new Date(now).getUTCMonth() <= 1 ? new Date(now).getUTCFullYear() - 1 : new Date(now).getUTCFullYear()];
  const out = { schema: 'edgedesk_props_record_v1', league: league.toUpperCase(), generated_at: new Date(now).toISOString(), method: 'football/props/record.js', seasons: {} };
  for (const season of seasons) {
    const preds = opts.predictions || readJsonl(ledgerPath(L, season));
    if (!preds.length && !opts.predictions) { out.seasons[season] = null; continue; }
    const data = opts.data || await (L === 'nfl' ? require('./nfl_data.js').load({ seasons: [season], pbp: true, roster: false }) : require('./cfb_data.js').load({ seasons: [season] }));
    const reg = opts.registry || require('./registry.js').load(league.toUpperCase());
    const PJ = require('./project.js');
    const byGame = new Map();
    data.playerGames.forEach((x) => { const k = x.game_id + '|' + x.gsis; byGame.set(k, x); });
    const teamPlayed = new Set([...data.teamGames.values()].map((t) => t.game_id + '|' + t.team));
    const graded = [];
    const closes = {};
    preds.forEach((p) => {
      const person = reg.players[p.player_id];
      const anchor = person ? person.ids[reg.anchor] : null;
      const g = data.games.get(String(p.game_id));
      const final = g && g.home_score != null && g.away_score != null;
      const box = anchor ? byGame.get(p.game_id + '|' + anchor) : null;
      const res = { final, played: box ? true : (final && teamPlayed.has(p.game_id + '|' + p.team) ? false : undefined), actual: box ? PJ.ACTUAL[p.prop_type](box) : null, graded_at: new Date(now).toISOString(),
        game_status: g && g.game_type === 'CANCELLED' ? 'cancelled' : null };
      if (!final) { graded.push(Object.assign({}, p, { result: null, status: 'PENDING' })); return; }
      const gr = P.grade(p, res);
      /* the close: the last consensus EdgeDesk captured before kickoff */
      const mk = closes[p.game_id] || (closes[p.game_id] = readJson(path.join(opts.market_dir || path.join(__dirname, L), 'markets', p.game_id + '.json'), null));
      const key = p.game_id + '|' + p.player_id + '|' + p.prop_type;
      const hist = mk && mk.history && mk.history[key] ? mk.history[key].filter((h) => Date.parse(h.at) < Date.parse(p.kickoff)) : [];
      const close = hist.length ? hist[hist.length - 1] : null;
      const cl = close ? P.clv(p, { line: close.line, over: close.over, under: close.under }) : { price: null, line: null };
      graded.push(Object.assign({}, p, { status: 'GRADED', result: gr.result, void_reason: gr.void_reason, actual: gr.actual, profit_units: gr.profit_units, flat_profit: gr.flat_profit,
        close: close ? { line: close.line, over: close.over, under: close.under, at: close.at, basis: 'last pre-kickoff capture' } : null, clv_price: cl.price, clv_line: cl.line }));
    });
    out.seasons[season] = { predictions: graded, scorecards: scorecards(graded) };
  }
  return out;
}

/* the PREGAME_FINAL row of each prop (else its latest row) */
function finals(rows) {
  const m = new Map();
  rows.forEach((x) => { const k = x.game_id + '|' + x.player_id + '|' + x.prop_type; const prev = m.get(k); if (!prev || Date.parse(x.frozen_at) >= Date.parse(prev.frozen_at)) m.set(k, x); });
  return [...m.values()];
}
function scorecards(rows) {
  const fin = finals(rows.filter((x) => x.status === 'GRADED'));
  const by = (f) => { const o = {}; fin.forEach((x) => { const k = f(x); if (k == null) return; (o[k] = o[k] || []).push(x); }); Object.keys(o).forEach((k) => { o[k] = P.scorecard(o[k]); }); return o; };
  const byProp = by((x) => x.prop_type);
  Object.keys(byProp).forEach((k) => {
    const eb = P.edgeBuckets(fin.filter((x) => x.prop_type === k));
    const rates = eb.filter((b) => b.n >= 30).map((b) => b.flat_roi);
    byProp[k].edge_monotone = rates.length >= 3 ? rates.every((v, i) => i === 0 || v >= rates[i - 1] - 0.02) : null;
    byProp[k].calibration_holdout_ok = null;
  });
  return {
    note: 'Each prop counts once: its last pregame prediction. Every decision class is graded; units and ROI are at the price taken. CLV is measured against EdgeDesk’s own last pre-kickoff capture.',
    all: P.scorecard(fin), bets: P.scorecard(fin.filter((x) => x.decision === 'BET')), leans: P.scorecard(fin.filter((x) => x.decision === 'LEAN')),
    by_prop: byProp, by_position: by((x) => x.position), by_tier: by((x) => 'tier ' + P.tierOf(x.prop_type, x.position)), by_stage: by((x) => x.stage),
    by_confidence: by((x) => x.confidence_tier), by_book: by((x) => x.book), by_decision: by((x) => x.decision), by_model_version: by((x) => x.model_version),
    by_week: by((x) => 'week ' + x.week), edge_buckets: P.edgeBuckets(fin), n_predictions: rows.length, n_props: fin.length };
}

/* the ledger only ever grows: the committed base must be a prefix, every
   line's id must be the hash of its own content, and nothing was frozen at
   or after its kickoff. checkLedger() is the rule; verify() applies it to
   the working file against a git base. */
function checkLedger(prev, cur, rel) {
  const bad = [];
  if (!cur.startsWith(prev || '')) bad.push(rel + ': the committed ledger is not a prefix of the working file (a frozen prediction was edited or removed)');
  cur.split('\n').filter(Boolean).forEach((line, i) => {
    let x = null;
    try { x = JSON.parse(line); } catch (_) { bad.push(rel + ':' + (i + 1) + ' is not JSON'); return; }
    const body = Object.assign({}, x); delete body.prediction_id; delete body.kind; delete body.market_prob_source; delete body.consensus_line; delete body.books; delete body.novig_over;
    if ('ppd_' + P.hash(P.canonical(body), 16) !== x.prediction_id) bad.push(rel + ':' + (i + 1) + ' content does not match its prediction id');
    if (!(Date.parse(x.frozen_at) < Date.parse(x.kickoff))) bad.push(rel + ':' + (i + 1) + ' frozen at or after kickoff');
  });
  return bad;
}
function verify(league, base) {
  const L = league.toLowerCase();
  const dir = path.join(__dirname, 'ledger', L);
  if (!fs.existsSync(dir)) return { ok: true, files: 0 };
  const bad = [];
  let files = 0;
  fs.readdirSync(dir).forEach((season) => {
    const f = path.join(dir, season, 'predictions.jsonl');
    if (!fs.existsSync(f)) return;
    files++;
    const rel = path.relative(ROOT, f);
    let prev = '';
    try { prev = execSync('git show ' + (base || 'HEAD') + ':' + rel, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString(); } catch (_) { prev = ''; }
    const cur = fs.readFileSync(f, 'utf8');
    checkLedger(prev, cur, rel).forEach((b) => bad.push(b));
  });
  return { ok: !bad.length, files, problems: bad };
}

async function main() {
  const cmd = process.argv[2];
  const league = arg('league', 'nfl');
  const now = arg('now') ? Date.parse(arg('now')) : Date.now();
  if (cmd === 'freeze') { console.log(JSON.stringify(freeze(league, now, {}), null, 1)); return 0; }
  if (cmd === 'verify') { const v = verify(league, arg('base')); console.log(JSON.stringify(v, null, 1)); return v.ok ? 0 : 1; }
  if (cmd === 'grade') {
    const r = await grade(league, now, {});
    Object.keys(r.seasons).forEach((s) => {
      if (!r.seasons[s]) return;
      const f = path.join(ROOT, 'record', 'props', league.toLowerCase() + '_' + s + '.json');
      const rec = Object.assign({ schema: r.schema, league: r.league, season: Number(s), generated_at: r.generated_at, method: r.method }, r.seasons[s]);
      console.log(writeIfChanged(f, rec) + ' ' + path.relative(ROOT, f) + ' · ' + JSON.stringify(rec.scorecards.all));
    });
    return 0;
  }
  console.error('usage: record.js freeze|grade|verify [--league nfl|cfb] [--now ISO]');
  return 2;
}
module.exports = { freeze, grade, verify, checkLedger, finals, scorecards, ledgerPath };
if (require.main === module) main().then((c) => process.exit(c)).catch((e) => { console.error(e && e.stack || e); process.exit(1); });
