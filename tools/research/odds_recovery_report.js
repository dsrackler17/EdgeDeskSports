#!/usr/bin/env node
/* ===========================================================================
   ODDS RECOVERY REPORT — the numbers behind docs/research-engine/ODDS_RECOVERY.md.
   Simulates game-line capture schedules on the NFL and FBS kickoffs of the
   week of 13-19 Oct 2026 (real, frozen in fixtures/ from the slates committed
   on 12 Oct), plus a SYNTHETIC MLB regular-season week (labelled: no MLB
   schedule is committed), with lib/edgedesk_odds_recovery.js. Buys nothing.

   Run: node tools/research/odds_recovery_report.js            (markdown)
        node tools/research/odds_recovery_report.js --json
   =========================================================================== */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const P = require(path.join(ROOT, 'lib', 'edgedesk_odds_recovery.js'));

const FROM = '2026-10-13T00:00:00Z', TO = '2026-10-20T00:00:00Z';
const ALIGNED = [[0.5, 5], [2, 15], [6, 45], [24, 60], [72, 120], [Infinity, 360]];
const REFRESH = { enabled: true, within_hours: 6, min_gap_min: 5, daily_credit_cap: 120 };
/* the incident's expected monthly use under the gateway (all paths, in season), and its ceilings */
const BUDGET = { planned: 35000, operational: 60000, breaker_latch: 57000 };

/* the week's real kickoffs, frozen from the slates as they were committed when this report was
   written: the live slates roll forward daily, and read live they leave this fixed week empty */
const KICKOFFS = path.join(__dirname, 'fixtures', 'odds_recovery_kickoffs_2026-10-12.json');
function football() {
  const k = require(KICKOFFS);
  return { americanfootball_nfl: k.americanfootball_nfl, americanfootball_ncaaf: k.americanfootball_ncaaf };
}
/* SYNTHETIC: a typical regular-season MLB day (15 games: 1:05, 1:10, 4:05, 4:10, 6:40, 6:45, 7:05×3, 7:10×2, 7:40, 8:10, 9:40, 10:10 ET) for seven days */
function mlbSynthetic() {
  const times = ['17:05', '17:10', '20:05', '20:10', '22:40', '22:45', '23:05', '23:05', '23:05', '23:10', '23:10', '23:40', '00:10', '01:40', '02:10'];
  const out = [];
  for (let d = 13; d < 20; d++) times.forEach((t) => { const [h, m] = t.split(':').map(Number); const day = h < 12 ? d + 1 : d; out.push(new Date(Date.UTC(2026, 9, day, h, m)).toISOString()); });
  return out;
}
function scenarios() {
  const fb = football(), mlb = { baseball_mlb: mlbSynthetic() };
  const run = (sports, extra) => P.simulate(Object.assign({ sports, from: FROM, to: TO }, extra || {}));
  return {
    football: { gateway: run(fb), aligned: run(fb, { cadence: ALIGNED }), refresh: run(fb, { refresh: REFRESH }) },
    mlb_synthetic: { gateway: run(mlb), aligned: run(mlb, { cadence: ALIGNED }), refresh: run(mlb, { refresh: REFRESH }) }
  };
}
function md(s) {
  const L = [];
  const row = (name, r) => `| ${name} | ${r.credits} | ${r.per_day} | ${r.per_30_days} | ${['≤0.5 h', '0.5–2 h', '2–6 h', '6–24 h', '24–72 h'].map((b) => r.verifiable[b].share == null ? '—' : Math.round(r.verifiable[b].share * 100) + '%').join(' | ')} |`;
  const head = '| Schedule | Credits / week | / day | / 30 days | ≤0.5 h | 0.5–2 h | 2–6 h | 6–24 h | 24–72 h |\n|---|---|---|---|---|---|---|---|---|';
  L.push('### NFL + FBS game lines, week of 13–19 Oct 2026 (committed slates: ' + s.football.gateway.by_sport.americanfootball_nfl.games + ' NFL and ' + s.football.gateway.by_sport.americanfootball_ncaaf.games + ' FBS kickoffs)\n');
  L.push(head); L.push(row('A. Gateway cadence as planned (60 / 120 / 360 min; hourly floor since 2026-10-21)', s.football.gateway)); L.push(row('B. Aligned to the readiness limits inside 6 h (5 / 15 / 45 / 60 / 120 / 360)', s.football.aligned)); L.push(row('C. A + research-triggered refresh (≤ 6 h, ≥ 5 min apart, ≤ 120 credits/day)', s.football.refresh));
  L.push('\n### MLB game lines, a SYNTHETIC regular-season week (15 games a day; no MLB schedule is committed)\n');
  L.push(head); L.push(row('A. Gateway cadence as planned', s.mlb_synthetic.gateway)); L.push(row('B. Aligned inside 6 h', s.mlb_synthetic.aligned)); L.push(row('C. A + research-triggered refresh', s.mlb_synthetic.refresh));
  const dB = s.football.aligned.per_30_days - s.football.gateway.per_30_days, dC = s.mlb_synthetic.refresh.per_30_days - s.mlb_synthetic.gateway.per_30_days;
  const f = P.fit(dB + dC, BUDGET);
  L.push('\n**Recommended mix (football B + MLB C):** +' + dB + ' (football) + ' + dC + ' (MLB refresh, capped) = **+' + (dB + dC) + ' credits per 30 days** on top of the incident\'s expected ~' + BUDGET.planned.toLocaleString('en-US') + ' → **' + f.total.toLocaleString('en-US') + '** of the ' + BUDGET.operational.toLocaleString('en-US') + ' operational ceiling (' + Math.round(f.share_of_operational * 100) + '%), under the ' + BUDGET.breaker_latch.toLocaleString('en-US') + ' breaker latch: ' + (f.within ? 'yes' : 'NO') + '.');
  return L.join('\n');
}
module.exports = { scenarios, md, mlbSynthetic, ALIGNED, REFRESH, BUDGET };
if (require.main === module) { const s = scenarios(); console.log(process.argv.includes('--json') ? JSON.stringify(s, null, 2) : md(s)); }
