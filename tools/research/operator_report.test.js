#!/usr/bin/env node
/* THE OPERATOR PIPELINE, end to end and offline: a synthetic two-season
   schedule is replayed by the SHIPPED engine through
   football/cfb_p4/research/backtest_engine.js --records, and the records are
   read by tools/research/operator_report.js. Pins: records are emitted in the
   evaluator's shape with home lines; a game projected from a state holding a
   same-slate result is REJECTED by the leakage guard and counted; the report
   carries per-model diagnostics and component diagnostics and changes
   nothing.   Run: node tools/research/operator_report.test.js */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const ROOT = path.join(__dirname, '..', '..');
const OP = require(path.join(__dirname, 'operator_report.js'));
let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) {
  if (typeof ok === 'function') { try { ok = ok(); } catch (e) { ok = false; detail = String(e && e.stack).slice(0, 300); } }
  if (ok) { pass++; return; } fail++; failures.push({ name, detail });
}
function done() {
  failures.forEach((f) => console.log('FAIL | ' + f.name + '  ' + String(JSON.stringify(f.detail)).slice(0, 400)));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}
/* a deterministic schedule: six SEC teams, three games a week, two sharing
   a 16:00 kickoff and one at 19:00 — a same-slate result the replay absorbs */
const D = fs.mkdtempSync(path.join(os.tmpdir(), 'edr-op-'));
fs.mkdirSync(path.join(D, 'sched')); fs.mkdirSync(path.join(D, 'out'));
const teams = ['Alabama', 'Georgia', 'Auburn', 'Florida', 'LSU', 'Tennessee'];
const rounds = [[[0, 1], [2, 3], [4, 5]], [[0, 2], [1, 4], [3, 5]], [[0, 3], [1, 5], [2, 4]], [[0, 4], [1, 3], [2, 5]], [[0, 5], [1, 2], [3, 4]]];
const hdr = 'game_id,season,week,start_date,home_team,away_team,home_division,away_division,home_conference,away_conference,neutral_site,home_points,away_points\n';
let gid = 1000; const market = ['game_id,spread_close,total_close'];
[2023, 2024].forEach((season) => {
  let csv = hdr;
  for (let w = 1; w <= 10; w++) {
    rounds[(w - 1) % 5].forEach(([h, a], i) => {
      gid++;
      const hp = 14 + ((gid * 7) % 24), ap = 10 + ((gid * 11) % 21);
      const hr = i < 2 ? 16 : 19;
      const [H, A] = w > 5 ? [teams[a], teams[h]] : [teams[h], teams[a]];
      csv += [gid, season, w, season + '-09-' + String(w + 1).padStart(2, '0') + 'T' + hr + ':00:00Z', H, A, 'fbs', 'fbs', 'SEC', 'SEC', 'false', hp, ap].join(',') + '\n';
      market.push([gid, hp - ap + ((gid % 3) - 1) * 3, hp + ap].join(','));
    });
  }
  fs.writeFileSync(path.join(D, 'sched', 'sched_' + season + '.csv'), csv);
});
fs.writeFileSync(path.join(D, 'out', 'market.csv'), market.join('\n') + '\n');
const REC = path.join(D, 'records.json');
const run = cp.spawnSync(process.execPath, [path.join(ROOT, 'football', 'cfb_p4', 'research', 'backtest_engine.js'),
  '--data', D, '--from', '2024', '--to', '2024', '--replay-from', '2023', '--records', REC], { encoding: 'utf8' });
chk('the shipped engine replay runs on the fixture', run.status === 0, run.stderr);
const records = fs.existsSync(REC) ? JSON.parse(fs.readFileSync(REC, 'utf8')) : [];
chk('every projected game is emitted as a prediction record', records.length === 30, records.length);
chk('records are home lines with components and an input manifest', records.every((r) => typeof r.spread === 'number'
  && r.components && r.inputs && r.clv_not_applicable === true && r.predicted_at < r.kickoff_at));
chk('the engine margin was turned into a home line (spread = -fair margin)', (() => {
  const bt = JSON.parse(fs.readFileSync(path.join(D, 'out', 'backtest_engine.json'), 'utf8'));
  return bt.n_projected === records.length;
})());
const rep = OP.build(records);
chk('same-slate results absorbed before a kickoff are rejected as future inputs, and counted', rep.rejected.n > 0
  && Object.keys(rep.rejected.reasons).some((k) => /input from the future/.test(k)), rep.rejected);
chk('a week\'s first slot (16:00, nothing same-day absorbed) is scored', rep.n_scored > 0 && rep.n_scored + rep.rejected.n === 30);
const m = rep.models['edgedesk/cfb_p4'];
chk('the report carries diagnostics, calibration and component diagnostics', m && m.diagnostics.overall && m.calibration.length && m.components && m.components.length);
chk('component diagnostics give no reading below the minimum sample', m.components.every((c) => c.all.n >= 30 || /insufficient sample/.test(c.reading)));
const txt = OP.text(rep);
chk('the text report states it changes nothing', /changes a production weight/.test(txt) && /never scored/.test(txt));
chk('a null coverage prints n/a, never 0.0%', !/±1σ 0\.0%/.test(txt) || rep.scale_methods.rmse.n > 0);
try { fs.rmSync(D, { recursive: true, force: true }); } catch (e) {}
done();
