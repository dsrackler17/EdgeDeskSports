#!/usr/bin/env node
/* The Model Lab's replay import attributes every row to the version that
   produced it (audit F-02). `node football/cfb_lab/backfill.test.js` */
'use strict';
const fs = require('fs');
const path = require('path');
const B = require('./backfill.js');

let pass = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) pass++; else failures.push({ name, detail }); }

const V200 = 'edgedesk_cfb_v2.0.0', V210 = 'edgedesk_cfb_v2.1.0';

let s = B.replayRowsFor({ model_version: V200, rows: [{ game_id: 1 }, { game_id: 2 }] }, V200);
chk('a legacy replay (version on the file only) is attributed to the file\'s version', s.rows.length === 2 && !Object.keys(s.refused).length, s);

s = B.replayRowsFor({ model_version: V200, rows: [{ game_id: 1, model_version: V200 }, { game_id: 2, model_version: V210 }] }, V200);
chk('a row of another version is refused, never relabelled as candidate 001', s.rows.length === 1 && s.rows[0].game_id === 1 && s.refused[V210] === 1, s);

s = B.replayRowsFor({ model_version: V210, rows: [{ game_id: 1 }, { game_id: 2 }] }, V200);
chk('a whole replay written by v2.1.x is refused', s.rows.length === 0 && s.refused[V210] === 2, s);

s = B.replayRowsFor({ rows: [{ game_id: 1 }] }, V200);
chk('a replay that states no version is refused (it cannot be attributed)', s.rows.length === 0 && s.refused.unstated === 1, s);

s = B.replayRowsFor({ model_version: V210, rows: [{ game_id: 1, model_version: V200 }] }, V200);
chk('a row\'s own version wins over the file\'s', s.rows.length === 1, s);

chk('no replay at all is nothing to import', B.replayRowsFor(null, V200).rows.length === 0 && B.replayRowsFor({}, V200).rows.length === 0);

/* the committed replay: every row it would import is candidate 001's */
const f = path.join(__dirname, '..', 'cfb_v2', 'snapshots', '2026', 'replay_to_date.json');
if (fs.existsSync(f)) {
  const rp = JSON.parse(fs.readFileSync(f, 'utf8'));
  const sel = B.replayRowsFor(rp, V200);
  chk('the committed 2026 replay is candidate 001\'s and imports whole',
    sel.rows.length + Object.values(sel.refused).reduce((a, b) => a + b, 0) === rp.rows.length
    && sel.rows.every((r) => (r.model_version || rp.model_version) === V200), { rows: sel.rows.length, refused: sel.refused });
}

failures.forEach((x) => console.log('FAIL | ' + x.name + (x.detail !== undefined ? '  ' + JSON.stringify(x.detail).slice(0, 300) : '')));
console.log(failures.length ? 'FAILED ' + pass + ' passed, ' + failures.length + ' failed' : 'ALL GREEN ' + pass + ' passed, 0 failed');
process.exit(failures.length ? 1 : 0);
