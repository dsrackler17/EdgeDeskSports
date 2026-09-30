#!/usr/bin/env node
/* ===========================================================================
   THE NFL REGIME SIGNAL (audit 2026-09-30 follow-up #4): a new head coach, a
   new starting quarterback, the starting quarterback out.

   THE DEFECT. The NFL model's team ratings are built from the team's own
   week-by-week stats, so a team whose quarterback changed carries the old
   quarterback's passing numbers. LAC @ SEA: Seattle's projected starter is
   Drew Lock, yet its +4.0-pt passing term was built with the starter it lost,
   and the engine's quarterback term moved the line 0.4 pts. Nothing flagged
   it, and nothing measured whether it matters.

   THE SIGNAL, per team-game, from nflverse games.csv (the coach and the
   starting QB of every game, 1999-2026) — every input known before kickoff:
     coach    the game's head coach is not the one who coached the team's last
              game of the previous season (a first-year head coach)
     new_qb   the game's starter is not last season's primary QB (most starts)
     qb_out   the team has started a QB this season and this game's starter is
              not its established starter (most starts this season so far) —
              the starting quarterback is out
   (nflverse's starter for a PLAYED game is who started it; for an upcoming
   game it is its projected starter. Starters are announced before kickoff,
   so this reads the information a closing line has, not an opener's.)

   THE PRICE, a signed level shift per side, in points:
        shift = (b_coach·coach + b_new_qb·new_qb)·exp(−λ·games this season) + b_qb_out·qb_out
        fair' = fair + shift_home − shift_away
   fitted by grid on MAE against the final margin, EXPANDING WINDOW: every
   season 2019-2025 is scored with coefficients fitted on 2016..S−1 only (the
   engine's own parameters were frozen on seasons <= 2015, so every scored
   game is out of sample for it too: tools/football/validate_pricing.js).
   PROMOTED to price only if the pooled held-out MAE improves by >= 0.05 AND
   the bootstrap 95% CI of the improvement excludes zero (the repo's 0.05 bar,
   declared before the first run). Otherwise it ships as research: every team's
   signal is published, and the shift is not applied.

   Also measured, for the research gate: when the model and the close disagree
   by 2+ pts, how often the model's side covers in flagged games against the
   rest, held out.

   Writes football/validation/nfl_regime.json (the record) and
   football/nfl/regime_<season>.json (this season's signal per team).

     node tools/football/nfl_regime.js            # print
     node tools/football/nfl_regime.js --write
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const R = require(path.join(ROOT, 'football', 'data', 'recovery.js'));
const VP = require(path.join(__dirname, 'validate_pricing.js'));

const SCHEMA = 'edgedesk_nfl_regime_v1';
const GAMES_URL = 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv';
const CACHE = path.join(ROOT, 'football', 'nfl', '.cache', GAMES_URL.replace(/[^a-z0-9.]+/gi, '_').slice(-120));
const RULES = { first_scored: 2019, first_fit: 2016, last: 2025, promote_min_gain: 0.05, disagreement_pts: 2, tolerance_pp: 2.5,
  grid: { coach: [-3, 1, 0.25], new_qb: [-4, 1, 0.25], qb_out: [-7, 1, 0.25], lambda: [0, 0.3, 0.1] } };
const SEASON = 2026;

function arg(name, dflt) { const i = process.argv.indexOf('--' + name); if (i < 0) return dflt; const v = process.argv[i + 1]; return (v == null || v.slice(0, 2) === '--') ? true : v; }
function num(v) { if (v == null || v === '' || v === 'NA') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function r3(x) { return x == null ? null : Math.round(x * 1000) / 1000; }
function r4(x) { return x == null ? null : Math.round(x * 10000) / 10000; }

/* ---- the signal: ONE definition (lib/nfl_regime.js), the board's own ---- */
const NR = require(path.join(ROOT, 'lib', 'nfl_regime.js'));
function loadRows() {
  if (!fs.existsSync(CACHE)) throw new Error('missing ' + path.relative(ROOT, CACHE) + ' — run node tools/football/build_lines_archive.js (it fetches nflverse games.csv into the cache)');
  return R.parseCsv(fs.readFileSync(CACHE, 'utf8'));
}

/* ---- the fit --------------------------------------------------------------- */
const shiftOf = NR.shiftOf;
function fairWith(r, b) { return r.fair + shiftOf(r.h.f, r.h.games_this_season, b) - shiftOf(r.a.f, r.a.games_this_season, b); }
function mae(list, b) { let s = 0; list.forEach((r) => { s += Math.abs((b ? fairWith(r, b) : r.fair) - r.margin); }); return list.length ? s / list.length : null; }
const ZERO = { coach: 0, new_qb: 0, qb_out: 0, lambda: 0 };
function range(lo, hi, st) { const v = []; for (let x = lo; x <= hi + 1e-9; x += st) v.push(Math.round(x * 1000) / 1000); return v; }
function fit(list) {
  const G = RULES.grid, flagged = list.filter((r) => r.h.f.coach || r.h.f.new_qb || r.h.f.qb_out || r.a.f.coach || r.a.f.new_qb || r.a.f.qb_out);
  let best = ZERO, bestE = mae(list, ZERO);
  const tot = (b) => Math.abs(b.coach) + Math.abs(b.new_qb) + Math.abs(b.qb_out);
  range(G.lambda[0], G.lambda[1], G.lambda[2]).forEach((l) => range(G.qb_out[0], G.qb_out[1], G.qb_out[2]).forEach((q) =>
    range(G.new_qb[0], G.new_qb[1], G.new_qb[2]).forEach((n) => range(G.coach[0], G.coach[1], G.coach[2]).forEach((c) => {
      const b = { coach: c, new_qb: n, qb_out: q, lambda: l };
      /* only the flagged games move, so the score is the base plus their change */
      let s = 0; flagged.forEach((r) => { s += Math.abs(fairWith(r, b) - r.margin) - Math.abs(r.fair - r.margin); });
      const e = bestE === null ? null : (mae(list, ZERO) * list.length + s) / list.length;
      if (e < bestE - 1e-12 || (Math.abs(e - bestE) <= 1e-12 && tot(b) < tot(best))) { best = b; bestE = e; }
    }))));
  return { coef: best, mae: bestE };
}
function bootCI(diffs, reps) {
  if (!diffs.length) return null;
  let seed = 20260930; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const m = [];
  for (let i = 0; i < (reps || 2000); i++) { let s = 0; for (let j = 0; j < diffs.length; j++) s += diffs[Math.floor(rnd() * diffs.length)]; m.push(s / diffs.length); }
  m.sort((a, b) => a - b);
  return [r3(m[Math.floor(0.025 * m.length)]), r3(m[Math.floor(0.975 * m.length)])];
}
/* cover rate of the model's side against the close, when they disagree by 2+ */
function coverTable(list, fairFn) {
  const t = { n: 0, w: 0 };
  list.forEach((r) => {
    const f = fairFn(r); if (Math.abs(f - r.close) < RULES.disagreement_pts || r.margin === r.close) return;
    t.n++; if (Math.sign(r.margin - r.close) === Math.sign(f - r.close)) t.w++;
  });
  return { games: t.n, cover_pct: t.n ? r3(100 * t.w / t.n) : null };
}

function main() {
  const rowsCsv = loadRows(), sig = NR.signals(rowsCsv);
  const archive = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'pricing', 'lines_nfl.json'), 'utf8'));
  const byId = {}; archive.games.forEach((g) => { byId[g.id] = g; });
  const rep = VP.replayNfl(archive);
  const rows = rep.rows.map((r) => ({ id: r.id, season: r.season, week: r.week, fair: r.model, close: r.close, margin: r.margin,
    h: sig[r.id + '|home'], a: sig[r.id + '|away'] })).filter((r) => r.h && r.a);
  /* the expanding window */
  const held = [], perSeason = [];
  for (let S = RULES.first_scored; S <= RULES.last; S++) {
    const tr = rows.filter((r) => r.season >= RULES.first_fit && r.season < S), te = rows.filter((r) => r.season === S);
    if (!tr.length || !te.length) continue;
    const ft = fit(tr);
    te.forEach((r) => held.push({ r, b: ft.coef }));
    perSeason.push({ season: S, fitted_on: RULES.first_fit + '-' + (S - 1), coef: ft.coef, games: te.length, mae_standard: r3(mae(te, null)), mae_regime: r3(mae(te, ft.coef)) });
  }
  const diffs = held.map((h) => Math.abs(fairWith(h.r, h.b) - h.r.margin) - Math.abs(h.r.fair - h.r.margin));
  const flaggedH = held.filter((h) => ['coach', 'new_qb', 'qb_out'].some((k) => h.r.h.f[k] || h.r.a.f[k]));
  const pooled = { games: held.length, mae_standard: r3(held.reduce((s, h) => s + Math.abs(h.r.fair - h.r.margin), 0) / held.length),
    mae_regime: r3(held.reduce((s, h) => s + Math.abs(fairWith(h.r, h.b) - h.r.margin), 0) / held.length),
    delta: r3(diffs.reduce((a, b) => a + b, 0) / diffs.length), delta_ci95: bootCI(diffs),
    flagged_games: flaggedH.length, flagged_delta: flaggedH.length ? r3(flaggedH.reduce((s, h) => s + Math.abs(fairWith(h.r, h.b) - h.r.margin) - Math.abs(h.r.fair - h.r.margin), 0) / flaggedH.length) : null };
  const promote = pooled.delta <= -RULES.promote_min_gain && pooled.delta_ci95 && pooled.delta_ci95[1] < 0;
  /* the research gate's evidence, held out: flagged vs unflagged cover rates */
  const heldRows = held.map((h) => h.r);
  const byFlag = {};
  ['coach', 'new_qb', 'qb_out'].forEach((k) => {
    byFlag[k] = { flagged: coverTable(heldRows.filter((r) => r.h.f[k] || r.a.f[k]), (r) => r.fair),
      unflagged: coverTable(heldRows.filter((r) => !(r.h.f.coach || r.h.f.new_qb || r.h.f.qb_out || r.a.f.coach || r.a.f.new_qb || r.a.f.qb_out)), (r) => r.fair) };
    const a = byFlag[k].flagged.cover_pct, b = byFlag[k].unflagged.cover_pct;
    byFlag[k].difference_pp = a != null && b != null ? r3(a - b) : null;
    byFlag[k].gate = a != null && b != null && a - b < -RULES.tolerance_pp;
  });
  const ship = fit(rows.filter((r) => r.season >= RULES.first_fit && r.season <= RULES.last));
  /* this season: every team's signal for its next game */
  const cur = {}, now = Date.now();
  rowsCsv.filter((g) => num(g.season) === SEASON && num(g.result) == null).sort((x, y) => String(x.gameday).localeCompare(String(y.gameday)))
    .forEach((g) => ['home', 'away'].forEach((side) => {
    const s = sig[g.game_id + '|' + side]; if (!s || cur[s.team]) return;
    const shift = r3(shiftOf(s.f, s.games_this_season, ship.coef));
    cur[s.team] = { team: s.team, next_game: g.game_id, week: num(g.week), coach: s.coach, prev_coach: s.prev_coach, new_coach: !!s.f.coach,
      starter: s.starter_name, starter_id: s.starter, established_qb: s.established_qb, prev_primary_qb: s.prev_primary_qb,
      new_qb: !!s.f.new_qb, qb_out: !!s.f.qb_out, games_this_season: s.games_this_season,
      regime: !!(s.f.coach || s.f.new_qb || s.f.qb_out), shift_points: shift, priced: promote, why: NR.whyOf(s) };
  }));
  const report = { schema: SCHEMA, generated_at: new Date(now).toISOString(), rules: RULES,
    signal: 'coach: the game’s head coach is not the one who coached the team’s last game of the previous season; new_qb: the starter is not last season’s primary QB (most starts); qb_out: the team has started a QB this season and this game’s starter is not its established starter (most starts so far)',
    price: 'shift = (b_coach·coach + b_new_qb·new_qb)·exp(−λ·games this season) + b_qb_out·qb_out per side; fair’ = fair + shift_home − shift_away',
    market_is_an_input: false, engine_frozen_through: 2015,
    data: { replay_rows: rep.rows.length, joined: rows.length, seasons: RULES.first_fit + '-' + RULES.last, source: 'nflverse games.csv (coach, starter per game); tools/football/validate_pricing.js replayNfl (the shipped NFL engine, cold)' },
    walk_forward: { by_season: perSeason, pooled }, promoted: promote,
    verdict: promote ? 'PROMOTED: the held-out improvement clears the 0.05 bar with a CI that excludes zero'
      : 'NOT PROMOTED (research): the held-out change is ' + pooled.delta + ' pts MAE, CI ' + JSON.stringify(pooled.delta_ci95) + '; the bar is −0.05 with a CI excluding zero',
    research_gate: { rule: 'held out, model vs close disagreeing by ' + RULES.disagreement_pts + '+: a flag whose games cover more than ' + RULES.tolerance_pp + ' pp less often than unflagged games holds a research label at INVESTIGATE', by_flag: byFlag },
    shipped: { fitted_on: RULES.first_fit + '-' + RULES.last, coef: ship.coef, in_sample_mae: r3(ship.mae), in_sample_mae_standard: r3(mae(rows, null)) } };
  const cs = { schema: 'edgedesk_nfl_regime_season_v1', season: SEASON, generated_at: report.generated_at, priced: promote,
    gate: Object.keys(byFlag).filter((k) => byFlag[k].gate), coef: ship.coef, record: 'football/validation/nfl_regime.json', by_team: cur };
  console.log(JSON.stringify({ walk_forward: report.walk_forward, promoted: promote, verdict: report.verdict, research_gate: report.research_gate, shipped: report.shipped,
    flagged_now: Object.values(cur).filter((t) => t.regime).map((t) => t.team + ': ' + t.why) }, null, 1));
  if (arg('write', false)) {
    fs.writeFileSync(path.join(ROOT, 'football', 'validation', 'nfl_regime.json'), JSON.stringify(report, null, 1) + '\n');
    fs.writeFileSync(path.join(ROOT, 'football', 'nfl', 'regime_' + SEASON + '.json'), JSON.stringify(cs, null, 1) + '\n');
    console.error('[write] football/validation/nfl_regime.json and football/nfl/regime_' + SEASON + '.json');
  }
}
if (require.main === module) main();
module.exports = { fit, RULES, SCHEMA };
