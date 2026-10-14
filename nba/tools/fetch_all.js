#!/usr/bin/env node
'use strict';
/* Download (or revalidate) every source file of every season into .cache/nba_src.
     node nba/tools/fetch_all.js [--season 2003-2026|current|all] [--kinds schedule,team_box,player_box,pbp] */
const C = require('../config');
const io = require('../lib/io');
function arg(n, d) { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; }
function seasons(spec) {
  if (!spec || spec === 'all') { const o = []; for (let s = C.FIRST_SEASON; s <= C.CURRENT_SEASON; s++) o.push(s); return o; }
  if (spec === 'current') return [C.CURRENT_SEASON];
  const m = /^(\d{4})-(\d{4})$/.exec(spec); if (m) { const o = []; for (let s = +m[1]; s <= +m[2]; s++) o.push(s); return o; }
  return spec.split(',').map(Number);
}
(async () => {
  const kinds = arg('kinds', 'schedule,team_box,player_box,pbp').split(',');
  for (const s of seasons(arg('season', 'all'))) {
    for (const k of kinds) {
      const t0 = Date.now();
      const r = await io.fetchSource(C.SOURCES[k](s), { ttlMs: s >= C.CURRENT_SEASON - 1 ? 6 * 3600e3 : 30 * 86400e3 });
      console.log(s, k, r.ok ? 'ok ' + r.bytes + ' bytes' + (r.from_cache ? ' (cache)' : '') : (r.not_found ? 'not published' : 'ERROR ' + JSON.stringify(r.error)), ((Date.now() - t0) / 1000).toFixed(1) + 's');
    }
  }
})().catch((e) => { console.error(e); process.exit(1); });
