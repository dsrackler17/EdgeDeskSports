'use strict';
/* Replay of the LIVE browser engine (mlb/engine.js) over a committed season,
   point-in-time for team inputs, compared with the repo's walk-forward history
   model (mlb/history) and Elo. Read-only use of repo code. */
const fs = require('fs');
const zlib = require('zlib');
const R = '/home/user/EdgeDeskSports/';
require(R + 'mlb/params.js');
const E = require(R + 'mlb/engine.js');
const PAR = globalThis.EDBaseballParams;
const I = require(R + 'mlb/history/ingest');
const WF = require(R + 'mlb/history/walkforward');
const { game } = require(R + 'mlb/history/model');
const live = JSON.parse(fs.readFileSync(R + 'mlb/history/params/mlb_live.json', 'utf8'));
const tuning = JSON.parse(fs.readFileSync(R + 'mlb/history/params/mlb_tuning.json', 'utf8'));

const SEASON = Number(process.argv[2] || 2025);
const USE_SP = process.argv.includes('--sp');
const USE_PARK = !process.argv.includes('--nopark');
const OUT = process.argv.find((a) => a.startsWith('--out='));

/* ---------- starters: end-of-season line (LOOK-AHEAD), name-matched ---------- */
const retroNames = JSON.parse(fs.readFileSync(R + 'mlb/history/data/pitchers.json', 'utf8'));
function csvGz(p) {
  const t = zlib.gunzipSync(fs.readFileSync(p)).toString('utf8').replace(/^﻿/, '');
  const lines = t.split(/\r?\n/).filter(Boolean); const h = lines[0].split(',');
  return lines.slice(1).map((l) => { const c = l.split(','); const o = {}; h.forEach((k, i) => { o[k] = c[i]; }); return o; });
}
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');
const pseas = {};
if (USE_SP) {
  for (const r of csvGz(R + 'mlb/pitchers/dataset/pitcher_seasons.csv.gz')) {
    if (Number(r.season) !== SEASON) continue;
    const k = norm(r.player_name); const st = Number(r.starts) || 0;
    if (!pseas[k] || st > pseas[k].starts) pseas[k] = { name: r.player_name, starts: st, ip: Number(r.innings_decimal), era: Number(r.era), fip: Number(r.fip) };
  }
}
let spHit = 0, spMiss = 0;
function starterFor(id) {
  if (!USE_SP || !id) return null;
  const nm = retroNames[id]; const s = nm ? pseas[norm(nm)] : null;
  if (!s || !(s.starts > 0)) { spMiss++; return null; }
  spHit++;
  return { name: s.name, era: s.era, fip: s.fip, xera: null, ip: s.ip, ip_per_start: s.ip / s.starts };
}

/* ---------- history model, point-in-time, and Elo ---------- */
const all = []; for (let y = I.FIRST; y <= I.LAST; y++) all.push(y);
const games = I.loadGames(all).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.game_id < b.game_id ? -1 : 1));
const t0 = Date.now();
const hist = WF.pass(games, tuning.chosen, { park: true, sp: true }, SEASON).raw;
const histTeam = WF.pass(games, tuning.chosen, { park: false, sp: false }, SEASON).raw;
console.error('history passes', ((Date.now() - t0) / 1000).toFixed(1) + 's');
const cal = live.calibration; /* cal[2025] for team_park_sp, as walkforward writes it */
const sig = (z) => 1 / (1 + Math.exp(-z));
function histP(x) { const G = game(x.lh, x.la, cal.r, cal.xi); const z = Math.log(G.p_home / (1 - G.p_home)); return { p: sig(cal.recal[0] + cal.recal[1] * z), raw: G.p_home, G }; }
/* Elo, tuned params */
const EP = Object.assign({ k: 4, hfa: 24, revert: 0.67 }, tuning.elo); const elo = new Map(); let eSeason = null; const eloP = new Map();
const eg = (t) => (elo.has(t) ? elo.get(t) : 1500);
for (const g of games) {
  if (g.season > SEASON) break;
  if (eSeason !== g.season) { if (eSeason != null) for (const [t, v] of elo) elo.set(t, 1500 + (v - 1500) * EP.revert); eSeason = g.season; }
  const p = 1 / (1 + Math.pow(10, -(eg(g.home) - eg(g.away) + EP.hfa) / 400)); eloP.set(g.game_id, p);
  const y = g.hs > g.as ? 1 : 0; const d = EP.k * Math.log(Math.abs(g.hs - g.as) + 1) * (y - p);
  elo.set(g.home, eg(g.home) + d); elo.set(g.away, eg(g.away) - d);
}

/* ---------- park: the history model's own end-of-season park effect, as an index ---------- */
const parkIdx = (team) => { const t = live.fit.teams[team]; return t && USE_PARK ? Math.round(Math.exp(t.park) * 100) : 100; };

/* ---------- the engine replay ---------- */
const S = games.filter((g) => g.season === SEASON);
const ts = {}; /* team -> {rs, ra, g} season to date */
const byDate = new Map(); for (const g of S) { if (!byDate.has(g.date)) byDate.set(g.date, []); byDate.get(g.date).push(g); }
const rows = [];
for (const date of [...byDate.keys()].sort()) {
  const day = byDate.get(date);
  /* league baseline exactly as mlbxLeague(): unweighted mean of team runs_per_game, needs >= 8 clubs */
  const rates = Object.values(ts).filter((t) => t.g > 0).map((t) => t.rs / t.g);
  const league = rates.length >= 8 ? { runs_per_game: rates.reduce((a, b) => a + b, 0) / rates.length } : null;
  for (const g of day) {
    const side = (team, sp) => {
      const t = ts[team];
      return { name: team,
        offense: { runs_per_game: t && t.g ? t.rs / t.g : null, games: t ? t.g : null },
        defense: { runs_allowed_per_game: t && t.g ? t.ra / t.g : null, games: t ? t.g : null },
        starter: starterFor(sp), bullpen: { taxed: [], closer_flag: false } };
    };
    const req = { season: 2026 /* the guard: 2025 data replayed as if current */, league,
      home: side(g.home, g.sp_home), away: side(g.away, g.sp_away),
      park: { run_factor: parkIdx(g.home) }, weather: null, market: {} };
    const p = E.projectGame(req);
    const h = hist.get(g.game_id), ht = histTeam.get(g.game_id);
    const hp = histP(h);
    rows.push({ id: g.game_id, date, home: g.home, away: g.away, hs: g.hs, as: g.as, sp_home: g.sp_home, sp_away: g.sp_away,
      eng: p.status === 'PREDICTED' ? p : null, req, hist: { p: hp.p, raw: hp.raw, lh: h.lh, la: h.la, total: h.lh + h.la },
      histTeamLam: ht, elo: eloP.get(g.game_id) });
  }
  for (const g of day) {
    (ts[g.home] = ts[g.home] || { rs: 0, ra: 0, g: 0 }); (ts[g.away] = ts[g.away] || { rs: 0, ra: 0, g: 0 });
    ts[g.home].rs += g.hs; ts[g.home].ra += g.as; ts[g.home].g++;
    ts[g.away].rs += g.as; ts[g.away].ra += g.hs; ts[g.away].g++;
  }
}
console.error('starters matched', spHit, 'missed', spMiss);

/* ---------- metrics ---------- */
const ll = (p, y) => -(y ? Math.log(Math.max(1e-12, p)) : Math.log(Math.max(1e-12, 1 - p)));
function slope(ps, ys) { /* logistic calibration slope by Newton on logit(p) */
  let a = 0, b = 1;
  for (let it = 0; it < 50; it++) {
    let g0 = 0, g1 = 0, h00 = 0, h01 = 0, h11 = 0;
    for (let i = 0; i < ps.length; i++) { const x = Math.log(ps[i] / (1 - ps[i])); const q = sig(a + b * x); const r = ys[i] - q; const w = q * (1 - q); g0 += r; g1 += r * x; h00 += w; h01 += w * x; h11 += w * x * x; }
    const det = h00 * h11 - h01 * h01; const da = (h11 * g0 - h01 * g1) / det, db = (h00 * g1 - h01 * g0) / det; a += da; b += db; if (Math.abs(da) + Math.abs(db) < 1e-9) break;
  }
  return { a, b };
}
function summary(sel, name, pf) {
  const ok = sel.filter((r) => r.eng);
  const ps = ok.map(pf), ys = ok.map((r) => (r.hs > r.as ? 1 : 0));
  const L = ps.reduce((a, p, i) => a + ll(p, ys[i]), 0) / ps.length;
  const B = ps.reduce((a, p, i) => a + (p - ys[i]) ** 2, 0) / ps.length;
  const sd = Math.sqrt(ps.reduce((a, p) => a + (p - 0.5) ** 2, 0) / ps.length);
  const s = slope(ps, ys);
  return { name, n: ps.length, log_loss: +L.toFixed(5), brier: +B.toFixed(5), mean_p: +(ps.reduce((a, b) => a + b, 0) / ps.length).toFixed(4), mean_y: +(ys.reduce((a, b) => a + b, 0) / ys.length).toFixed(4), sd_from_50: +sd.toFixed(4), cal_slope: +s.b.toFixed(3), cal_int: +s.a.toFixed(3) };
}
const res = {};
const months = [['all', () => true], ['Mar-Apr', (r) => r.date.slice(5, 7) <= '04'], ['May-Jun', (r) => ['05', '06'].includes(r.date.slice(5, 7))], ['Jul-Aug', (r) => ['07', '08'].includes(r.date.slice(5, 7))], ['Sep', (r) => r.date.slice(5, 7) >= '09']];
for (const [m, f] of months) {
  const sel = rows.filter(f);
  res[m] = [summary(sel, 'engine (mlb/engine.js replay)', (r) => r.eng.model.home_win_prob), summary(sel, 'history team_park_sp (recalibrated)', (r) => r.hist.p), summary(sel, 'elo', (r) => r.elo), summary(sel, 'const 0.5316', () => 0.5316)];
}
/* totals */
const ok = rows.filter((r) => r.eng);
const totBias = ok.reduce((a, r) => a + r.eng.model.fair_total - (r.hs + r.as), 0) / ok.length;
const histBias = ok.reduce((a, r) => a + r.hist.total - (r.hs + r.as), 0) / ok.length;
const mae = ok.reduce((a, r) => a + Math.abs(r.eng.model.fair_total - (r.hs + r.as)), 0) / ok.length;
const hmae = ok.reduce((a, r) => a + Math.abs(r.hist.total - (r.hs + r.as)), 0) / ok.length;
const rmse = Math.sqrt(ok.reduce((a, r) => a + (r.eng.model.fair_total - (r.hs + r.as)) ** 2, 0) / ok.length);
const hrmse = Math.sqrt(ok.reduce((a, r) => a + (r.hist.total - (r.hs + r.as)) ** 2, 0) / ok.length);
const meanT = ok.reduce((a, r) => a + r.hs + r.as, 0) / ok.length;
const constRmse = Math.sqrt(ok.reduce((a, r) => a + (meanT - (r.hs + r.as)) ** 2, 0) / ok.length);
/* O8.5 */
const o85 = ok.map((r) => { const tp = E.dist.totalProbs(r.eng.distribution.total, 8.5); return { p: tp.over_fair, y: r.hs + r.as > 8.5 ? 1 : 0 }; });
const o85s = slope(o85.map((x) => x.p), o85.map((x) => x.y));
const o85ll = o85.reduce((a, x) => a + ll(x.p, x.y), 0) / o85.length;
/* run line home -1.5 */
const rl = ok.map((r) => { const q = E.dist.runLineProbs(r.eng.distribution.home, r.eng.distribution.away, -1.5); return { p: q.cover_fair, y: r.hs - r.as >= 2 ? 1 : 0 }; });
const rls = slope(rl.map((x) => x.p), rl.map((x) => x.y));
const rlll = rl.reduce((a, x) => a + ll(x.p, x.y), 0) / rl.length;
const rlMean = rl.reduce((a, x) => a + x.p, 0) / rl.length, rlY = rl.reduce((a, x) => a + x.y, 0) / rl.length;
/* p10/p90 coverage of the total */
let inBand = 0; for (const r of ok) { const t = r.hs + r.as; if (t >= r.eng.model.total_p10 && t <= r.eng.model.total_p90) inBand++; }
/* card inconsistencies */
let favMismatch = 0, rlMismatch = 0, mlDisc = 0, mlDiscMax = 0, prodMax = 0, prodMaxRounded = 0;
for (const r of ok) {
  const m = r.eng.model; const favHome = m.home_win_prob >= 0.5;
  if (favHome !== (m.home_runs >= m.away_runs)) favMismatch++;
  if ((m.run_line < 0) !== favHome) rlMismatch++;
  const am = m.fair_home_ml; const imp = am < 0 ? (-am) / (-am + 100) : 100 / (am + 100);
  const d = Math.abs(imp - m.home_win_prob) * 100; if (d > mlDiscMax) mlDiscMax = d;
  const disp = Math.round(m.home_win_prob * 100); const dispImp = Math.round(imp * 100); if (disp !== dispImp) mlDisc++;
  for (const s of ['home', 'away']) {
    const prod = r.eng.contributions[s].reduce((a, t) => a * t.v, 1) * r.eng.components.league_runs_per_game;
    const shown = s === 'home' ? m.home_runs : m.away_runs; const e = Math.abs(prod - shown); if (e > prodMaxRounded) prodMaxRounded = e;
  }
}
const out = { season: SEASON, use_sp: USE_SP, use_park: USE_PARK, n: rows.length, scored: ok.length, moneyline: res,
  totals: { engine_bias: +totBias.toFixed(3), history_bias: +histBias.toFixed(3), engine_mae: +mae.toFixed(3), history_mae: +hmae.toFixed(3), engine_rmse: +rmse.toFixed(3), history_rmse: +hrmse.toFixed(3), constant_rmse: +constRmse.toFixed(3), mean_actual: +meanT.toFixed(3),
    o85_log_loss: +o85ll.toFixed(5), o85_slope: +o85s.b.toFixed(3), o85_int: +o85s.a.toFixed(3), p10_p90_coverage: +(inBand / ok.length).toFixed(4) },
  run_line: { home_m15_log_loss: +rlll.toFixed(5), slope: +rls.b.toFixed(3), mean_p: +rlMean.toFixed(4), mean_y: +rlY.toFixed(4) },
  card: { fav_by_prob_vs_runs_mismatch: favMismatch, runline_side_vs_ml_fav_mismatch: rlMismatch, ml_vs_prob_display_mismatch_pctpt: mlDisc, ml_vs_prob_max_pts: +mlDiscMax.toFixed(3), runs_product_max_abs_err: +prodMaxRounded.toFixed(4) } };
console.log(JSON.stringify(out, null, 1));
if (OUT) fs.writeFileSync(OUT.slice(6), JSON.stringify(rows.map((r) => ({ id: r.id, date: r.date, home: r.home, away: r.away, hs: r.hs, as: r.as, sp_home: r.sp_home, sp_away: r.sp_away, req: r.req, eng: r.eng ? { model: r.eng.model, components: r.eng.components, contributions: r.eng.contributions } : null, hist: r.hist, elo: r.elo }))));
