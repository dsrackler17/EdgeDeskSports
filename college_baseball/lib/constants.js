'use strict';
/* ===========================================================================
   EdgeDesk college baseball — league constants, measured on a declared window.

   The run distribution and the simulator need a handful of league-level
   shapes: how runs fall in a half-inning (regulation and extra), how a tied
   game resolves in extra innings, how runs spread across innings, how often a
   doubleheader game is scheduled for seven. They are measured ONLY on the
   seasons passed in (by default the SELECTION window of inning data,
   2017-2022), so nothing from VALIDATION or HOLDOUT leaks into a prediction
   through a constant. params/constants.json records the window it came from.
   =========================================================================== */
const W = require('./warehouse');
const RULES = require('./rules');

const MAXR = 12;   // half-inning histogram cap

function blankHist(n) { return new Array(n + 1).fill(0); }
function norm(h) { const t = h.reduce((a, b) => a + b, 0); return h.map((v) => (t ? v / t : 0)); }
function r4(v) { return Math.round(v * 10000) / 10000; }

function measure(fromSeason, toSeason) {
  const reg = blankHist(MAXR); const extra = blankHist(MAXR);
  const share = new Array(9).fill(0); let shareTot = 0;
  let tied = 0; let homeWonExtra = 0;
  const homeMargin = blankHist(8); const awayMargin = blankHist(8); const added = blankHist(20);
  const walkoffMargin = blankHist(8); let homeWinsLastInning = 0;
  let games = 0; let runs = 0; const teamRuns = blankHist(40);
  const firstFive = { games: 0, tie: 0 };
  let sched7 = 0; let schedKnown = 0;
  for (let s = fromSeason; s <= toSeason; s++) {
    for (const g of W.games(s)) {
      if (!W.usable(g)) continue;
      games++; runs += g.home_runs + g.away_runs;
      teamRuns[Math.min(40, g.home_runs)]++; teamRuns[Math.min(40, g.away_runs)]++;
      if (!g.away_line) continue;
      const a = RULES.parseLine(g.away_line); const h = RULES.parseLine(g.home_line);
      const inf = RULES.inferScheduled(g);
      const n = inf.scheduled;
      if (!n) continue;
      schedKnown++; if (n === 7) sched7++;
      /* half-inning shapes: every half that was played; the bottom of the last
         scheduled inning is excluded when the home side led (it was not played,
         and the source sometimes writes it as 0) */
      for (let i = 0; i < a.length; i++) {
        for (const [line, isHome] of [[a, false], [h, true]]) {
          const v = line[i]; if (v == null) continue;
          if (isHome && i === n - 1 && RULES.runsThrough(h, n - 1) > RULES.runsThrough(a, n)) continue;
          if (isHome && i >= n - 1 && i === a.length - 1 && v > 0 && RULES.runsThrough(h, i + 1) > RULES.runsThrough(a, i + 1)) continue; // walk-off half: truncated, not a full half
          (i >= n ? extra : reg)[Math.min(MAXR, v)]++;
        }
      }
      if (n === 9 && !inf.ended_early) {
        for (const line of [a, h]) for (let i = 0; i < Math.min(9, line.length); i++) if (line[i] != null) { share[i] += line[i]; shareTot += line[i]; }
        if (a.length >= 5 && h.length >= 5) { firstFive.games++; if (RULES.runsThrough(a, 5) === RULES.runsThrough(h, 5)) firstFive.tie++; }
      }
      /* extra-inning resolution, from games tied after their scheduled length */
      if (a.length > n && RULES.runsThrough(a, n) === RULES.runsThrough(h, n)) {
        tied++;
        const regTot = 2 * RULES.runsThrough(a, n);
        const fin = g.home_runs + g.away_runs; added[Math.min(20, fin - regTot)]++;
        const m = g.home_runs - g.away_runs;
        if (m > 0) { homeWonExtra++; homeMargin[Math.min(8, m)]++; } else awayMargin[Math.min(8, -m)]++;
      }
      /* regulation walk-off margins: home wins decided in the bottom of the last scheduled inning */
      if (a.length === n && h[n - 1] != null && g.home_runs > g.away_runs && RULES.runsThrough(h, n - 1) <= RULES.runsThrough(a, n)) {
        homeWinsLastInning++; walkoffMargin[Math.min(8, g.home_runs - g.away_runs)]++;
      }
    }
  }
  const regP = norm(reg); const extraP = norm(extra);
  const mean = (p) => p.reduce((acc, v, i) => acc + v * i, 0);
  return {
    schema: 'edgedesk_cbase_constants_v1', window: [fromSeason, toSeason],
    games, runs_per_team_game: r4(runs / games / 2),
    team_runs_hist: teamRuns,
    half_inning: { regulation: regP.map(r4), extra: extraP.map(r4), regulation_n: reg.reduce((x, y) => x + y, 0), extra_n: extra.reduce((x, y) => x + y, 0), regulation_mean: r4(mean(regP)), extra_mean: r4(mean(extraP)) },
    run_share_by_inning: share.map((v) => r4(v / shareTot)),
    extra_resolution: { tied_games: tied, home_win_share: r4(homeWonExtra / Math.max(1, tied)), home_margin: norm(homeMargin).map(r4), away_margin: norm(awayMargin).map(r4), added_runs: norm(added).map(r4) },
    walkoff: { home_wins_in_last_inning: homeWinsLastInning, margin: norm(walkoffMargin).map(r4) },
    first_five_tie_rate: r4(firstFive.tie / Math.max(1, firstFive.games)),
    /* the share of games scheduled for seven in the window: the run model's expectations already contain it */
    scheduled_seven_share: r4(sched7 / Math.max(1, schedKnown)),
    /* a seven-inning game's runs relative to nine: innings 1-6 at their nine-inning share plus a final inning like the ninth */
    seven_inning_factor: r4(share.slice(0, 6).reduce((x, y) => x + y, 0) / shareTot + share[8] / shareTot),
  };
}

module.exports = { measure, MAXR };
