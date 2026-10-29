/* ============================================================================
   FSIE — the modeling panel: one row per team-game (team on offence against
   one opponent), carrying
     labels    what happened (plays, pass/rush attempts, sacks, drives, the
               realized margin) — never read by any feature;
     features  point-in-time snapshots of both teams (core/features.js),
               the pregame line, home/rest, and the two pure baselines;
     meta      season, week, population, data-quality tier, the line's source.
   The pure baselines are computed here, from the label history alone, so they
   cannot borrow anything from the situational machinery:
     season_avg      the team's mean over this season's earlier games (last
                     season's mean before its first game; the league's when
                     it has neither)
     recent_weighted an exponentially weighted mean, half-life 3 games, seeded
                     with last season's mean as one game
   ========================================================================== */
'use strict';
const path = require('path');
const U = require(path.join(__dirname, 'util.js'));
const FT = require(path.join(__dirname, 'features.js'));

const LABELS = ['plays', 'pass_att', 'rush_att', 'sacks', 'dropbacks', 'drives', 'scrambles'];
const HOME_ADV = { nfl: 1.5, cfb: 2.5 };

function v(x) { return x && typeof x === 'object' ? x.v : (U.isNum(x) ? x : null); }

/* pure baselines, chronological per team */
function baselines(seasonData, prev) {
  const rows = seasonData.team_games.slice().sort((a, b) => String(a.kickoff_at).localeCompare(String(b.kickoff_at)));
  const prevMean = {}; const lg = {};
  if (prev) {
    const acc = {};
    prev.team_games.forEach((r) => { if (!(r.quality && r.quality.volume_ok) || r.season_type !== 'REG') return; const a = acc[r.team] || (acc[r.team] = { n: 0 }); a.n++; LABELS.forEach((k) => { a[k] = (a[k] || 0) + r.counts[k]; }); const L = lg; L.n = (L.n || 0) + 1; LABELS.forEach((k) => { L[k] = (L[k] || 0) + r.counts[k]; }); });
    Object.keys(acc).forEach((t) => { prevMean[t] = {}; LABELS.forEach((k) => { prevMean[t][k] = acc[t][k] / acc[t].n; }); });
  }
  const lgMean = {}; LABELS.forEach((k) => { lgMean[k] = lg.n ? lg[k] / lg.n : null; });
  const sum = {}, ew = {}, out = new Map();
  const lam = Math.pow(0.5, 1 / 3);
  rows.forEach((r) => {
    const t = r.team;
    const s = sum[t]; const e = ew[t];
    const pm = prevMean[t] || null;
    const b = { season_avg: {}, recent_weighted: {}, games_before: s ? s.n : 0 };
    LABELS.forEach((k) => {
      b.season_avg[k] = s && s.n ? s[k] / s.n : (pm ? pm[k] : lgMean[k]);
      b.recent_weighted[k] = e && e.w > 0 ? e[k] / e.w : (pm ? pm[k] : lgMean[k]);
    });
    out.set(r.game_id + '|' + t, b);
    if (!(r.quality && r.quality.volume_ok)) return;
    const S = sum[t] || (sum[t] = { n: 0 }); S.n++; LABELS.forEach((k) => { S[k] = (S[k] || 0) + r.counts[k]; });
    if (!ew[t]) { ew[t] = { w: pm ? 1 : 0 }; LABELS.forEach((k) => { ew[t][k] = pm ? pm[k] : 0; }); }
    const E = ew[t]; E.w = E.w * lam + 1; LABELS.forEach((k) => { E[k] = E[k] * lam + r.counts[k]; });
  });
  return { byTeamGame: out, league: lgMean };
}

/* -> rows[] */
function build(sport, seasonData, prev, walk, opts) {
  opts = opts || {};
  const base = baselines(seasonData, prev);
  const sched = {}; (seasonData.schedule || []).forEach((g) => { sched[g.game_id] = g; });
  const byKey = {}; seasonData.team_games.forEach((r) => { byKey[r.game_id + '|' + r.team] = r; });
  const div = opts.divisions || {};                           /* cfb: team -> {division, conference} for this season */
  const rows = [];
  for (const r of seasonData.team_games) {
    if (r.season_type !== 'REG') continue;
    const fT = walk.byTeamGame.get(r.game_id + '|' + r.team);
    const fO = walk.byTeamGame.get(r.game_id + '|' + r.opp);
    if (!fT || !fO) continue;
    const o = byKey[r.game_id + '|' + r.opp];
    const s = sched[r.game_id] || {};
    const b = base.byTeamGame.get(r.game_id + '|' + r.team);
    const lg = fT.league;
    let m = r.market.spread_margin, total = r.market.total_line, mSrc = m != null ? 'line' : null;
    const homeSign = r.neutral_site ? 0 : (r.is_home ? 1 : -1);
    if (m == null) {
      /* no line: a points-based expectation, flagged as such */
      const tp = v(fT.off.points_pg), oa = v(fO.def.points_pg), op = v(fO.off.points_pg), ta = v(fT.def.points_pg);
      if ([tp, oa, op, ta].every(U.isNum)) { m = (tp + oa) / 2 - (op + ta) / 2 + homeSign * HOME_ADV[sport]; total = (tp + oa) / 2 + (op + ta) / 2; mSrc = 'points_fallback'; }
    }
    const restDiff = s.home_rest != null && s.away_rest != null ? (r.is_home ? s.home_rest - s.away_rest : s.away_rest - s.home_rest) : 0;
    const dT = div[r.team] || {}, dO = div[r.opp] || {};
    rows.push({
      sport, season: r.season, week: r.week, game_id: r.game_id, team: r.team, opp: r.opp, kickoff_at: r.kickoff_at,
      home: homeSign, rest_diff: U.clamp(restDiff || 0, -7, 7),
      m, total, m_source: mSrc,
      T: { off: fT.off, def: fT.def, adj: fT.opp_adj, meta: fT.meta }, O: { off: fO.off, def: fO.def, adj: fO.opp_adj, meta: fO.meta },
      league: lg,
      base: b,
      labels: r.quality.volume_ok ? Object.assign({}, r.counts, { margin: r.counts.points != null && r.counts.opp_points != null ? r.counts.points - r.counts.opp_points : null,
        db_rate: r.counts.plays ? r.counts.dropbacks / r.counts.plays : null }) : null,
      opp_labels: o && o.quality && o.quality.volume_ok ? { plays: o.counts.plays, drives: o.counts.drives } : null,
      quality: { volume_ok: r.quality.volume_ok, situation_ok: r.quality.situation_ok, tier: (r.form && r.form.charted && r.form.charted >= 0.5 * r.counts.plays) || (r.form && r.form.ftn && r.form.ftn.n) ? 'A' : 'B' },
      population: sport === 'cfb' ? cfbPopulation(dT, dO, r.season) : 'nfl',
      division: dT.division || null, conference: dT.conference || null, opp_division: dO.division || null,
      script: r.quality.situation_ok ? r.script : null
    });
  }
  return rows;
}

/* power conferences of the season (the Pac-12 was one through 2023) */
function isPower(conf, season) { return conf === 'SEC' || conf === 'Big Ten' || conf === 'Big 12' || conf === 'ACC' || (conf === 'Pac-12' && season <= 2023); }
function cfbPopulation(dT, dO, season) {
  if (dT.division !== 'fbs') return 'fcs_team';
  if (dO.division && dO.division !== 'fbs') return 'vs_fcs';
  const tp = isPower(dT.conference, season), op = isPower(dO.conference, season);
  const nonconf = !!(dT.conference && dO.conference && dT.conference !== dO.conference);
  return (tp ? 'power' : 'group') + (nonconf ? '_nonconf' : '_conf');
}

module.exports = { build, baselines, LABELS, cfbPopulation, isPower, HOME_ADV };
