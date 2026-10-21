#!/usr/bin/env node
/* ===========================================================================
   THE NFL WEEKLY EVALUATION'S RULES (tools/record/nfl_weekly_eval.js), on a
   hand-built week whose every number can be worked out on paper, then on the
   committed evaluation in record/football/weekly/.

   Run: node tools/record/nfl_weekly_eval.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const E = require('./nfl_weekly_eval.js');
const ROOT = path.join(__dirname, '..', '..');

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('PASS | ' + name); }
  else { fail++; console.log('FAIL | ' + name + (detail !== undefined ? ' | ' + JSON.stringify(detail).slice(0, 500) : '')); }
}
const near = (a, b, t) => a != null && b != null && Math.abs(a - b) <= (t || 1e-4);

/* the week: three games of week 2, one of week 1, one of week 3 unplayed */
const G = (id, w, h, a, hs, as, spread, hml, aml, loc) => ({ game_id: id, season: 2026, week: w, gameday: '2026-09-' + (10 + w), home_team: h, away_team: a,
  home_score: hs, away_score: as, spread_line: spread, home_moneyline: hml, away_moneyline: aml, location: loc || 'Home' });
const schedule = [
  G('2026_01_A_B', 1, 'B', 'A', 20, 17, 2.5, -140, 120),
  G('2026_02_C_D', 2, 'D', 'C', 27, 10, 3, -150, 130),        // home won by 17; close D -3
  G('2026_02_E_F', 2, 'F', 'E', 13, 24, -1, 105, -125),       // home lost by 11
  G('2026_02_G_H', 2, 'H', 'G', 20, 20, 0, -110, -110, 'Neutral'), // a tie at a neutral site
  G('2026_03_I_J', 3, 'J', 'I', null, null, 1, -115, -105),
];
const card = (base, pass, home) => ({ rows: [{ key: 'base_strength', points: base, prior: base * 0.6, current: base * 0.4 }, { key: 'passing', points: pass }, { key: 'home_field', points: home }] });
const pred = (m, p, c) => ({ status: 'PREDICTED', model: { fair_spread: m, home_win_prob: p }, card: c, model_version: 'edgedesk_nfl_v2.0.0' });
const weekPreds = {
  '2026_01_A_B': pred(1, 0.53, card(-2, 0, 3)),
  '2026_02_C_D': pred(7, 0.70, card(4, 0.5, 2.5)),          // 4 off the close of 3
  '2026_02_E_F': pred(2, 0.56, card(-1, 0.5, 2.5)),         // close -1: 3 off; final -11: residual -13
  '2026_02_G_H': pred(-0.5, 0.48, card(-0.5, 0, 0)),
};
const record = { games: {
  '2026_02_C_D': { pick: { home_line: -5.5, home_win_prob: 0.66, model_version: 'edgedesk_football_v1.0.0', at: '2026-09-10T00:00:00Z' }, grade: { clv_pick: { spread: { pts: 1 } } } },
  '2026_02_E_F': { pick: { home_line: 1, home_win_prob: 0.46, model_version: 'edgedesk_football_v1.0.0' }, grade: { clv_pick: { spread: { pts: -0.5 } } } },
} };
const openers = { games: { '2026_02_C_D': { open: { home_line: -2.5 } }, '2026_02_E_F': { open: { home_line: 0 } } } };
const ev = E.evaluate({ season: 2026, week: 2, schedule, weekPreds, record, openers, servedVersion: 'edgedesk_nfl_v2.0.0', now: '2026-09-22T15:00:00Z' });
const g = (id) => ev.games.find((x) => x.game_id === id);

chk('the settled week is the latest whose every game is final (week 3 is not)', E.settledWeek(schedule, 2026) === 2);
chk('week 2 holds its three games; the season to date also holds week 1', ev.games.length === 3 && ev.season_to_date.rows.length === 4);
chk('devig: -150/+130 -> 0.6/(0.6+0.4348)', near(E.devig(-150, 130), 0.6 / (0.6 + 100 / 230)));
const cd = g('2026_02_C_D');
chk('published = the record\'s pick (home line -5.5 is a +5.5 home margin), never recomputed', cd.published.home_margin === 5.5 && cd.published.model_version === 'edgedesk_football_v1.0.0');
chk('margin errors: published |5.5-17| = 11.5, replayed |7-17| = 10, close |3-17| = 14', cd.published.error === 11.5 && cd.replayed.error === 10 && cd.close_scores.error === 14);
chk('Brier and log loss on the home win (y = 1)', near(cd.replayed.brier, 0.09) && near(cd.replayed.logloss, -Math.log(0.7)) && near(cd.published.brier, 0.1156));
chk('published CLV is the record\'s own points; replayed CLV runs from the opener (+2.5) to the close (+3) on the home side = +0.5',
  cd.published.clv_pts === 1 && cd.replayed.clv_pts_open_to_close === 0.5);
chk('CLV: a number on the other side of the open is paid for the opposite move', E.clvPts(-1, 2.5, 3) === -0.5 && E.clvPts(2.5, 2.5, 3) === null);
chk('ATS vs the close: the replayed 7 leans home against 3, home won by 17 -> win', cd.replayed.ats === 'win');
const ef = g('2026_02_E_F');
chk('a 3-point disagreement is flagged (replayed 2 vs close -1), and 4 points (C@D) too', ev.flags.length === 2 && ev.flags.some((f) => f.game_id === '2026_02_E_F' && f.replayed_gap === 3));
chk('…with the card\'s drivers, largest first', ev.flags.find((f) => f.game_id === '2026_02_E_F').drivers[0].key === 'home_field');
const miss = ev.misses[0];
chk('the biggest miss is E @ F (residual -13), attributed to the components that pointed home: home field then passing',
  miss.game_id === '2026_02_E_F' && miss.residual === -13 && miss.pushed_wrong_way.map((r) => r.key).join() === 'home_field,passing' && miss.market_saw_it === true, miss);
chk('…with the base strength\'s prior/current split', near(miss.base_strength_split.prior, -0.6) && near(miss.base_strength_split.current, -0.4));
const gh = g('2026_02_G_H');
chk('a tie scores margin error but no probability (y is undefined)', gh.replayed.error === 0.5 && gh.replayed.brier === null && gh.y === null && gh.neutral === true);
chk('a game the site never published has no published number, and is not invented', gh.published === null);
const ws = ev.week_summary;
chk('the week\'s replayed MAE is the mean of 10, 13 and 0.5', near(ws.replayed.mae, (10 + 13 + 0.5) / 3));
chk('the paired block compares only the games all three numbers have (2)', ws.paired.n === 2 && ws.paired.published.n === 2 && ws.paired.replayed.n === 2 && ws.paired.close.n === 2);
chk('calibration bins count every decided game once per source', ev.season_to_date.calibration.replayed.n === 3 && ev.season_to_date.calibration.close.n === 3);
chk('the evaluation names the served model and the published versions', ev.served_model === 'edgedesk_nfl_v2.0.0' && ev.published_versions.join() === 'edgedesk_football_v1.0.0');

/* the committed evaluation */
const dir = path.join(ROOT, 'record', 'football', 'weekly');
const idx = fs.existsSync(path.join(dir, 'index.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')) : null;
if (idx) {
  const doc = JSON.parse(fs.readFileSync(path.join(dir, idx.latest.file), 'utf8'));
  chk('the committed index points at a committed evaluation of the same week', doc.schema === E.SCHEMA && doc.week === idx.latest.week && doc.season === idx.latest.season);
  chk('…every game in it has a final, and every flag is at least 3 points', doc.games.every((x) => x.final) && doc.flags.every((f) => Math.abs(f.replayed_gap || 0) >= 3 || Math.abs(f.published_gap || 0) >= 3));
  chk('…no published number differs from the model record\'s pick', (() => {
    const rec = JSON.parse(fs.readFileSync(path.join(ROOT, 'record', 'football', `nfl_${doc.season}.json`), 'utf8'));
    return doc.games.every((x) => !x.published || (rec.games[x.game_id] && Math.abs(-rec.games[x.game_id].pick.home_line - x.published.home_margin) < 0.006));
  })());
} else console.log('NOTE | no committed weekly evaluation yet');

console.log(fail ? `FAILURES ${pass} passed, ${fail} failed` : `ALL GREEN ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
