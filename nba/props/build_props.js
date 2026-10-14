#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk NBA props — fair lines for every projected player on the slate.

     node nba/props/build_props.js        (after nba/build_slate.js)

   For each game on nba/slate.json, the players of each team's previous-game
   rotation (the projected regime: nothing of the game itself is known), the
   prop model fitted on the four seasons before this one (nba/props/model.js),
   and per stat: expected minutes, the mean, the half-point line nearest it,
   P(over) and the fair prices from the negative-binomial distribution, the
   80% range; combined props from the correlated moments; double- and
   triple-double probabilities from the copula. Each family carries its
   status from nba/validation/nba_props_walkforward.json.

   No prop prices are captured: these are fair lines, never value calls.
   Writes nba/props_slate.json (schema edgedesk_nba_props_slate_v1).
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const C = require('../config');
const D = require('../lib/data');
const ST = require('./state');
const PM = require('./model');
const PW = require('./walkforward');
const WF = require('../model/walkforward');
const DIST = require('../model/distribution');

const OUT = path.join(C.NBA, 'props_slate.json');
const r2 = (v) => (v == null || !isFinite(v) ? null : Math.round(v * 100) / 100);
const r4 = (v) => (v == null || !isFinite(v) ? null : Math.round(v * 1e4) / 1e4);
function readJson(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return d; } }

function quantile(pmf, q) { let c = 0; for (let i = 0; i < pmf.length; i++) { c += pmf[i]; if (c >= q) return i; } return pmf.length - 1; }

async function build() {
  const slate = readJson(C.PATHS.slate, null);
  if (!slate || !slate.games) throw new Error('nba/slate.json is missing: run node nba/build_slate.js first');
  const season = slate.season;
  const upcoming = slate.games.map((g) => ({ game_id: g.game_id, home: String(g.home.id), away: String(g.away.id), start: Date.parse(g.start_utc), neutral: g.neutral ? 1 : 0, season, f: g.context || {} }));
  const tuning = readJson(WF.TUNING, { pass: {} });
  D.requireWork(D.seasonList(C.FIRST_SEASON, season), 'nba props');
  const gameRows = await WF.buildRows(tuning);
  const ctx = new Map(gameRows.map((r) => [r.id, r]));
  const res = ST.run({ seasons: D.seasonList(C.FIRST_SEASON, season), gameRows: ctx, upcoming, avail: true });
  const train = res.rows.filter((r) => PW.eligible(r) && r.season >= season - 4 && r.season < season);
  const model = PM.fit(train, 'P');
  const availModel = PM.fitAvail(res.avail.filter((r) => r.season >= season - 4 && r.season < season));
  const rec = readJson(PW.RECORD, null);
  const win = rec && rec.windows ? (rec.windows.test && rec.windows.test.status !== 'SEALED' ? rec.windows.test.P : rec.windows.selection && rec.windows.selection.P) : null;
  const status = {}; if (win) for (const k of PW.FAMILIES) if (win[k]) status[k] = { status: win[k].status, failed: win[k].failed, n: win[k].n, crps: win[k].crps, baseline_crps: win[k].baselines.season_average.crps, coverage_80: win[k].coverage_80 };
  const aw = rec && rec.windows ? (rec.windows.test && rec.windows.test.status !== 'SEALED' ? rec.windows.test.availability : rec.windows.selection && rec.windows.selection.availability) : null;
  if (aw) status.availability = { status: aw.status, failed: aw.failed, n: aw.n, log_loss: aw.model.log_loss, baseline_log_loss: aw.baseline_played_last_game.log_loss, calibration_slope: aw.model.calibration_slope };
  const players = D.playersMap();
  const byGame = new Map();
  for (const r of res.upcoming) {
    if (r.f.min_ew < 8) continue;
    const pred = PM.predict(model, r.f);
    const stats = {};
    const one = (mu, d) => {
      const line = Math.floor(mu) + 0.5; const over = DIST.pGreater(d, line);
      return { mean: r2(mu), line, over: r4(over), fair_over: DIST.probToAmerican(over), fair_under: DIST.probToAmerican(1 - over), p10_p90: [quantile(d.pmf, 0.1), quantile(d.pmf, 0.9)] };
    };
    for (const k of ST.STATS) stats[k] = one(pred.stat[k].mu, PM.statDist(pred, k));
    for (const [k, keys] of Object.entries(PM.COMBOS)) stats[k] = one(PM.combo(model, pred, keys).mu, PM.comboDist(model, pred, keys));
    const md = PM.multiDouble(model, pred, 2000, Number(r.p) % 100000);
    if (!byGame.has(r.g)) byGame.set(r.g, []);
    byGame.get(r.g).push({ id: r.p, name: (players[r.p] || {}).name || r.p, team: r.tm, played_last_game: !!r.f.in_last, p_plays: r.avail_f ? r4(PM.predictAvail(availModel, r.avail_f)) : null,
      minutes: r2(pred.min.mu), minutes_sd: r2(pred.min.sd), stats, double_double: r4(md.dd), triple_double: r4(md.td) });
  }
  const games = slate.games.map((g) => ({ game_id: g.game_id, start_utc: g.start_utc, label: (g.away.abbr || g.away.name) + ' @ ' + (g.home.abbr || g.home.name),
    players: (byGame.get(g.game_id) || []).map((p) => Object.assign(p, { team: p.team === String(g.home.id) ? g.home.abbr : g.away.abbr })).sort((a, b) => b.minutes - a.minutes) }));
  const out = { schema: 'edgedesk_nba_props_slate_v1', generated_at: new Date().toISOString(), season, slate_generated_at: slate.generated_at,
    model: { track: 'P (projected: the previous game\'s rotation)', trained_seasons: [season - 4, season - 1], n_train: model.n, record: rec ? (rec.windows.test && rec.windows.test.status !== 'SEALED' ? 'test window' : 'selection window (test sealed)') : 'no record' },
    note: 'Fair lines from the validated count distributions — expected minutes × per-minute production, opponent and pace adjusted, teammates\' absences redistributed — priced as if the player plays (a prop is void if he does not); P(plays) is the separately validated probability that he does. No prop prices are captured, so nothing here is a value call.',
    availability_model: availModel ? { n_train: availModel.n, base_rate: r4(availModel.base) } : null,
    value_claims: 'DISABLED', status, games };
  fs.writeFileSync(OUT, JSON.stringify(out) + '\n');
  return out;
}

module.exports = { build, OUT };
if (require.main === module) build().then((o) => console.log('[nba props slate] ' + o.games.reduce((a, g) => a + g.players.length, 0) + ' players in ' + o.games.length + ' games')).catch((e) => { console.error(e); process.exit(1); });
