#!/usr/bin/env node
'use strict';
/* ===========================================================================
   The MLB lab model (mlb/history, the loop's served `team_park_sp`) walked
   forward for the CLV programme with an OPENER-TIME starting pitcher.

   mlb/history prices each game with the ACTUAL starter (Retrosheet), which is
   known only after the game; probable starters were never archived. This
   driver keeps everything else of mlb/history/walkforward.js (pass, the
   season calibration, priced()) and changes one input of the prediction:
     sp = the pitcher who started the team's 5th-previous game, if he has not
          started in the 4 days before this game's date; otherwise none (the
          model's no-starter term, 0).
   Results are absorbed with the actual starters (they are known by then),
   exactly as mlb/history does. Variants: `sp_proj` (projected starter),
   `team_park` (no starter term at all), `sp_actual` (reproduction only; never
   used for an opener bet). Writes nothing but <out.csv>.

     node research/clv/mlb_predict.js <out.csv>
   ========================================================================== */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const WF = require(path.join(ROOT, 'mlb', 'history', 'walkforward.js'));
const { RunsModel } = require(path.join(ROOT, 'mlb', 'history', 'model.js'));

const dayNum = (d) => Math.floor(Date.parse(d + 'T12:00:00Z') / 864e5);

function projectStarters(games) {
  const hist = new Map(); const proj = new Map(); let hit = 0, n = 0;
  for (const g of games) {
    const out = {};
    for (const [side, team] of [['home', g.home], ['away', g.away]]) {
      const h = hist.get(team) || [];
      let p = null;
      if (h.length >= 5) {
        const cand = h[h.length - 5].sp;
        const recent = h.filter((x) => x.sp === cand && dayNum(g.date) - dayNum(x.date) <= 4).length;
        if (cand && !recent) p = cand;
      }
      out[side] = p;
      const actual = side === 'home' ? g.sp_home : g.sp_away;
      if (actual) { n++; if (p === actual) hit++; }
    }
    proj.set(g.game_id, out);
    for (const [team, sp] of [[g.home, g.sp_home], [g.away, g.sp_away]]) {
      if (!hist.has(team)) hist.set(team, []);
      hist.get(team).push({ date: g.date, sp: sp || null });
    }
  }
  return { proj, hitRate: n ? hit / n : null };
}

function pass(games, params, use, spFor) {
  const m = new RunsModel(params, use);
  const byDay = new Map(); for (const g of games) { if (!byDay.has(g.date)) byDay.set(g.date, []); byDay.get(g.date).push(g); }
  const out = new Map();
  for (const date of [...byDay.keys()].sort()) {
    const day = byDay.get(date);
    m.startSeason(day[0].season); m.fit(dayNum(date));
    for (const g of day) { const sp = spFor(g); const l = m.lambdas(g.home, g.away, sp.home, sp.away, g.home); out.set(g.game_id, { lh: l.lh, la: l.la }); }
    m.absorb(dayNum(date), day);
  }
  return out;
}

function score(games, raw) {
  const rows = games.map((g) => ({ id: g.game_id, season: g.season, date: g.date, home: g.home, away: g.away, hs: g.hs, as: g.as,
    outs: Number(g.outs) || null, raw: raw.get(g.game_id) }));
  const bySeason = new Map(); for (const r of rows) { if (!bySeason.has(r.season)) bySeason.set(r.season, []); bySeason.get(r.season).push(r); }
  const last = Math.max(...bySeason.keys()); const out = [];
  for (let s = WF.W.selection[0]; s <= last; s++) {
    const prior = rows.filter((r) => r.season >= s - 3 && r.season < s).map((r) => ({ lh: r.raw.lh, la: r.raw.la, hs: r.hs, as: r.as, outs: r.outs }));
    const k = WF.calibrationFor(prior);
    for (const r of bySeason.get(s) || []) { const x = WF.priced(r.raw, k); r.p = x.p; r.exp_total = x.mk.exp_total; out.push(r); }
  }
  return out;
}

const games = WF.load();
const served = WF.servedParams();
const { proj, hitRate } = projectStarters(games);
const variants = {
  sp_actual: [WF.CANDS.team_park_sp, (g) => ({ home: g.sp_home || null, away: g.sp_away || null })],
  sp_proj: [WF.CANDS.team_park_sp, (g) => proj.get(g.game_id)],
  team_park: [WF.CANDS.team_park, () => ({ home: null, away: null })],
};
const res = {};
for (const [k, [use, f]] of Object.entries(variants)) res[k] = new Map(score(games, pass(games, served.params, use, f)).map((r) => [r.id, r]));
const lines = ['game_id,season,date,home,away,hs,as,sp_home,sp_away,proj_sp_home,proj_sp_away,p_actual,p_proj,p_team_park,total_actual,total_proj,total_team_park'];
for (const [id, r] of res.sp_proj) {
  const g = games.find ? null : null;
  const a = res.sp_actual.get(id), t = res.team_park.get(id), pr = proj.get(id);
  lines.push([id, r.season, r.date, r.home, r.away, r.hs, r.as, '', '', pr.home || '', pr.away || '', a.p.toFixed(5), r.p.toFixed(5),
    t.p.toFixed(5), a.exp_total.toFixed(4), r.exp_total.toFixed(4), t.exp_total.toFixed(4)].join(','));
}
fs.writeFileSync(process.argv[2], lines.join('\n') + '\n');
console.log(`mlb lab (${served.version || 'tuning'}): ${res.sp_proj.size} games; projected starter = actual for ${(100 * hitRate).toFixed(1)}% of team-games`);
