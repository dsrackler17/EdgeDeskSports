#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk NHL — grade the published pregame prices against what happened.

     node hockey/grade_ledger.js     write hockey/ledger/grades.json

   Reads the append-only ledger (hockey/ledger/<season>.jsonl, written by
   build_slate.js before each game), takes the LAST record before each game's
   start (the price as it stood at puck drop), joins the final from the
   committed team-game table, and scores the moneyline, the home −1.5 and the
   totals at 5.5 and 6.5. Where the ledger also froze the market (captured
   prices), it reports closing-line value of the best price against the last
   no-vig consensus before the start. Every figure prints its n and sample
   state; nothing here was a bet, so there is no profit and no ROI.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const C = require('./config');
const V = require('../engine/validation');
const TG = require('./ingest/team_games');

function grade(o) {
  o = o || {};
  const season = o.season || C.CURRENT_SEASON;
  const file = path.join(C.PATHS.ledger, season + '.jsonl');
  const recs = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const last = new Map(); const allByGame = new Map();
  for (const r of recs) {
    if (!(Date.parse(r.recorded_at) < Date.parse(r.start_utc))) continue;
    const prev = last.get(r.game_id); if (!prev || r.recorded_at >= prev.recorded_at) last.set(r.game_id, r);
    if (!allByGame.has(r.game_id)) allByGame.set(r.game_id, []); allByGame.get(r.game_id).push(r);
  }
  const rows = o.teamGames || TG.loadTeamGames([season]);
  const res = new Map(); for (const t of rows) if (t.home === 1) res.set(t.game_id, t);
  const ml = [], pl = [], o55 = [], o65 = [], tot = [], clv = [];
  for (const [gid, r] of last) {
    const t = res.get(gid); if (!t) continue;
    const total = t.gf + t.ga, margin = t.gf - t.ga;
    ml.push({ p: r.p_home, y: t.win });
    if (r.pl_home_minus_1_5 != null) pl.push({ p: r.pl_home_minus_1_5, y: margin >= 2 ? 1 : 0 });
    if (r.over_5_5 != null) o55.push({ p: r.over_5_5, y: total > 5.5 ? 1 : 0 });
    if (r.over_6_5 != null) o65.push({ p: r.over_6_5, y: total > 6.5 ? 1 : 0 });
    if (r.exp_total != null) tot.push(Math.abs(r.exp_total - total));
    /* CLV: the first captured best price on the model's side against the last no-vig before the start */
    const withM = (allByGame.get(gid) || []).filter((x) => x.market && x.market.ml_best && x.market.ml_novig_home != null).sort((a, b) => (a.recorded_at < b.recorded_at ? -1 : 1));
    if (withM.length >= 2) {
      const first = withM[0], lastM = withM[withM.length - 1];
      const side = first.p_home >= 0.5 ? 'home' : 'away';
      const a = first.market.ml_best[side].american; const dec = a > 0 ? 1 + a / 100 : 1 + 100 / -a;
      const pClose = side === 'home' ? lastM.market.ml_novig_home : 1 - lastM.market.ml_novig_home;
      clv.push(dec * pClose - 1);
    }
  }
  const sum = (b) => ({ n: b.n, sample_state: b.sample_state, log_loss: b.log_loss, brier: b.brier, mean_p: b.mean_p, mean_y: b.mean_y });
  return {
    schema: 'edgedesk_nhl_grades_v1', generated_at: new Date().toISOString(), season, ledger_records: recs.length, games_graded: ml.length,
    moneyline: ml.length ? sum(V.binary(ml)) : { n: 0, sample_state: 'TOO_EARLY' },
    puck_line_home_minus_1_5: pl.length ? sum(V.binary(pl)) : { n: 0, sample_state: 'TOO_EARLY' },
    total_over_5_5: o55.length ? sum(V.binary(o55)) : { n: 0, sample_state: 'TOO_EARLY' },
    total_over_6_5: o65.length ? sum(V.binary(o65)) : { n: 0, sample_state: 'TOO_EARLY' },
    total_mae: tot.length ? V.r(tot.reduce((a, v) => a + v, 0) / tot.length, 3) : null,
    clv: clv.length ? { n: clv.length, mean: V.r(clv.reduce((a, v) => a + v, 0) / clv.length), share_positive: V.r(clv.filter((v) => v > 0).length / clv.length), note: 'EV of the first captured best price at the last no-vig consensus before the start' } : { n: 0, note: 'no game has two captured market snapshots yet (NHL prices are not captured)' },
    note: 'Graded from the last pregame record of each game. Nothing here was a bet: no profit, no ROI.',
  };
}

if (require.main === module) {
  const g = grade();
  fs.mkdirSync(C.PATHS.ledger, { recursive: true });
  fs.writeFileSync(path.join(C.PATHS.ledger, 'grades.json'), JSON.stringify(g, null, 1) + '\n');
  console.log('[nhl grades] ' + g.games_graded + ' games graded from ' + g.ledger_records + ' ledger records; moneyline ' + g.moneyline.sample_state + (g.moneyline.log_loss != null ? ' LL ' + g.moneyline.log_loss : ''));
}
module.exports = { grade };
