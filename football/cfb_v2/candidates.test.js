#!/usr/bin/env node
/* Frozen model candidates are immutable. `node football/cfb_v2/candidates.test.js`

   Every football/cfb_v2/candidates/<id>/manifest.json lists the sha256 of each
   file frozen with that candidate (predictions, model artifacts, params). This
   re-hashes them: an edited or regenerated candidate fails here, because a
   changed model is a NEW candidate, never a rewrite of an old one. */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = path.join(__dirname, 'candidates');
let fail = 0, n = 0;
function ok(c, what) { n++; if (!c) { fail++; console.log('FAIL ' + what); } else console.log('ok   ' + what); }

const ids = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((d) => fs.existsSync(path.join(DIR, d, 'manifest.json'))) : [];
ok(ids.length > 0, 'at least one frozen candidate exists');
for (const id of ids) {
  const m = JSON.parse(fs.readFileSync(path.join(DIR, id, 'manifest.json'), 'utf8'));
  ok(m.candidate_id === id, id + ': manifest names itself');
  ok(/^[0-9a-f]{7,40}$/.test(String(m.code && m.code.commit)), id + ': records the code commit');
  ok(m.config && m.config.SEED === m.seeds.global, id + ': records the seed');
  ok(m.ensemble_weights_by_season && Object.keys(m.ensemble_weights_by_season).length > 0, id + ': records ensemble weights by season');
  ok(m.uncertainty_and_win_calibration_by_season && Object.keys(m.data_files || {}).length > 0,
    id + ': records calibration objects and hashed data sources');
  const files = m.files || {};
  ok(Object.keys(files).length >= 3, id + ': lists its frozen files');
  for (const [rel, want] of Object.entries(files)) {
    const p = path.join(DIR, id, rel);
    const got = fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : null;
    ok(got === want, id + ': ' + rel + ' is unchanged since freezing');
  }
  const extra = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else { const rel = path.relative(path.join(DIR, id), p); if (rel !== 'manifest.json' && !(rel in files)) extra.push(rel); }
    }
  })(path.join(DIR, id));
  ok(extra.length === 0, id + ': no unlisted files were added (' + extra.join(', ') + ')');
}
console.log((n - fail) + '/' + n + ' passed');
process.exit(fail ? 1 : 0);
