/* Audit item 19 — pure-model isolation in the PRODUCTION engine (football/cfb_v2/engine.js).
   node football/cfb_v2/research/v2/audit/purity.js <out.json>
   For every frozen/provisional V2 row on disk: compute pure(row) (with and without QB/injury
   overlays), then call decide() with 40 wild markets (lines -60..+60, both sides' prices,
   books, openers, stale and fresh timestamps, sign-flipped numbers) and, after EVERY call,
   recompute pure(row) and compare it byte-for-byte with the first result. Also: pure() must
   ignore market numbers smuggled into the row (row.shadow.market_at_freeze, row.line,
   row.close_margin) and into the overlays object, and decide() must not mutate its input. */
'use strict';
var fs = require('fs'), path = require('path');
var V2 = path.resolve(__dirname, '..', '..', '..');
require(path.join(V2, 'params.js'));
var E = require(path.join(V2, 'engine.js'));
var rows = [];
function add(f) {
  if (!fs.existsSync(f)) return;
  var j = JSON.parse(fs.readFileSync(f, 'utf8'));
  (j.rows || []).forEach(function (r) { rows.push(r); });
}
add(path.join(V2, 'current.json'));
add(path.join(V2, 'snapshots', '2026', 'replay_to_date.json'));
fs.readdirSync(path.join(V2, 'snapshots', '2026')).forEach(function (f) {
  if (f !== 'replay_to_date.json' && /\.json$/.test(f)) {
    JSON.parse(fs.readFileSync(path.join(V2, 'snapshots', '2026', f), 'utf8')).rows.forEach(function (x) { rows.push(x.row); });
  }
});
var overlaysSet = [
  null,
  { qb_status: { home: 'out', away: 'confirmed' } },
  { qb_status: { home: 'questionable' }, injuries: { away: [{ unit: 'OL', usage_share: 0.4, status: 'OUT' }] },
    weather: { wind_mph: 28 } }
];
function markets(pureP) {
  var out = [], lines = [-60, -35, -21, -14, -7, -3, -1, 0, 1, 3, 7, 14, 21, 35, 60];
  var now = '2026-10-01T12:00:00Z';
  lines.forEach(function (L, i) {
    out.push({ current: { home_line: L, ts: now }, price_home: -110, price_away: -110 });
    out.push({ books: [{ home_line: L }, { home_line: L + 0.5 }, { home_line: L - 3, alternate: true }],
      ts: now, open: { home_line: -L }, price_home: 250, price_away: -400 });
  });
  out.push({ current: { home_line: -(pureP.projected_margin || 0), ts: '2020-01-01T00:00:00Z' }, price_home: -105 });
  out.push({ current: { home_line: pureP.projected_margin || 0, ts: now }, price_home: -110, price_away: -110 }); /* sign flipped */
  out.push({});
  out.push(null);
  out.push({ current: { home_line: 3.5 }, price_home: -110 });
  out.push({ books: [{ home_line: -10 }, { home_line: 10 }, { home_line: 0 }], ts: now, price_home: +150, price_away: -170 });
  out.push({ current: { home_line: NaN, ts: now } });
  out.push({ current: { home_line: -7, ts: now }, price_home: -10000, price_away: 10000 });
  out.push({ current: { home_line: -7, ts: now }, price_home: 'x' });
  out.push({ current: { home_line: 1e9, ts: now }, price_home: -110 });
  return out;
}
var stats = { rows: rows.length, pure_calls: 0, decide_calls: 0, pure_changed: 0, decide_mutated_input: 0,
  smuggled_market_changed_pure: 0, decide_pure_margin_mismatch: 0, decide_threw: 0, statuses: {},
  not_predicted: 0, examples: [] };
rows.forEach(function (row) {
  overlaysSet.forEach(function (ov) {
    var p0 = E.pure(row, ov); stats.pure_calls++;
    var s0 = JSON.stringify(p0);
    if (p0.status !== 'PREDICTED') { stats.not_predicted++; }
    /* smuggled market numbers in the row and in the overlays */
    var r2 = JSON.parse(JSON.stringify(row));
    r2.line = -99; r2.close_margin = 55; r2.open_margin = -40; r2.current_home_line = 33;
    r2.shadow = { market_at_freeze: { open_home_line: 40, current_home_line: -40, total_open: 99 } };
    var ov2 = JSON.parse(JSON.stringify(ov || {}));
    ov2.market = { home_line: -50 }; ov2.home_line = 12; ov2.spread = 7;
    var p2 = E.pure(r2, ov2); stats.pure_calls++;
    var a = JSON.parse(s0), b = JSON.parse(JSON.stringify(p2));
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      stats.smuggled_market_changed_pure++;
      if (stats.examples.length < 5) stats.examples.push({ kind: 'smuggled', game_id: row.game_id });
    }
    markets(p0).forEach(function (m) {
      var before = JSON.stringify(p0), d;
      try {
        d = E.decide(p0, m, { row: row, now: '2026-10-01T12:05:00Z' }); stats.decide_calls++;
        stats.statuses[d.status] = (stats.statuses[d.status] || 0) + 1;
        if (p0.status === 'PREDICTED' && d.pure_fair_margin !== p0.projected_margin) stats.decide_pure_margin_mismatch++;
      } catch (e) {
        stats.decide_threw++;
        if (stats.examples.length < 8) stats.examples.push({ kind: 'threw', game_id: row.game_id, err: String(e).slice(0, 120) });
      }
      if (JSON.stringify(p0) !== before) stats.decide_mutated_input++;
      var p1 = E.pure(row, ov); stats.pure_calls++;
      if (JSON.stringify(p1) !== s0) {
        stats.pure_changed++;
        if (stats.examples.length < 5) stats.examples.push({ kind: 'pure_changed', game_id: row.game_id });
      }
    });
  });
});
stats.pass = stats.pure_changed === 0 && stats.decide_mutated_input === 0 && stats.smuggled_market_changed_pure === 0 &&
  stats.decide_pure_margin_mismatch === 0;
var outp = process.argv[2];
if (outp) fs.writeFileSync(outp, JSON.stringify(stats, null, 1) + '\n');
console.log(JSON.stringify(stats));
