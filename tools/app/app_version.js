#!/usr/bin/env node
/* ===========================================================================
   /app-version.json — the version of EdgeDesk's app code as deployed, so an
   open tab can tell that a new deploy landed (lib/edgedesk_update.js).

   The version is a hash of app.html and every file under lib/: it changes
   exactly when the app's code does, never for the data jobs that commit
   every few minutes. .github/workflows/app-version.yml restamps it on main.

     node tools/app/app_version.js           print the version
     node tools/app/app_version.js --write   write app-version.json when it changed
     node tools/app/app_version.js --check   exit 1 when app-version.json is stale
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'app-version.json');
const SCHEMA = 'edgedesk_app_version_v1';

function files(root) {
  const out = ['app.html'];
  (function walk(rel) {
    fs.readdirSync(path.join(root, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1)).forEach((d) => {
      const p = rel + '/' + d.name;
      if (d.isDirectory()) walk(p); else out.push(p);
    });
  })('lib');
  return out;
}
function stamp(root) {
  root = root || ROOT;
  const h = crypto.createHash('sha256'), list = files(root);
  list.forEach((p) => { h.update(p + '\0'); h.update(fs.readFileSync(path.join(root, p))); h.update('\0'); });
  return { schema: SCHEMA, version: h.digest('hex').slice(0, 16), files: list.length,
    note: 'A hash of app.html and lib/: an open EdgeDesk tab reloads when this changes (lib/edgedesk_update.js). Restamped by .github/workflows/app-version.yml.' };
}

if (require.main === module) {
  const s = stamp();
  const cur = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : null;
  const same = cur && cur.version === s.version && cur.files === s.files;
  if (process.argv.includes('--check')) {
    if (!same) { console.error('[app version] app-version.json is stale (' + (cur ? cur.version : 'missing') + ' ≠ ' + s.version + '): run node tools/app/app_version.js --write'); process.exit(1); }
    console.log('[app version] ok: ' + s.version);
  } else if (process.argv.includes('--write')) {
    if (!same) fs.writeFileSync(OUT, JSON.stringify(s, null, 1) + '\n');
    console.log('[app version] ' + s.version + (same ? ' (unchanged)' : ' written'));
  } else console.log(s.version);
}
module.exports = { stamp, files, SCHEMA };
