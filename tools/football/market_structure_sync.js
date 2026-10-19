#!/usr/bin/env node
/* ===========================================================================
   NFL MARKET STRUCTURE — copy the committed artifact into Supabase.

   football/market_structure/nfl.json → public.nfl_market_structure_load()
   (supabase/nfl_market_structure.sql): the margin-frequency windows into
   nfl_margin_frequency (where public.half_point_value() reads them) and the
   two-point weeks into nfl_two_point_weekly. The loader writes a version only
   when it differs from the current one, so re-running this is free.

   Without SB_URL / SB_SERVICE_ROLE it says so and exits 0: the committed
   artifact is complete on its own and the card reads it directly. While the
   migration is not applied (PostgREST answers 404 / PGRST202 for the function)
   it warns and exits 0 for the same reason. Any other failure exits 1.

     node tools/football/market_structure_sync.js [--dry-run]
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const ART = path.join(ROOT, 'football', 'market_structure', 'nfl.json');

async function main() {
  const dry = process.argv.includes('--dry-run');
  const art = JSON.parse(fs.readFileSync(ART, 'utf8'));
  const url = process.env.SB_URL, key = process.env.SB_SERVICE_ROLE;
  const n = art.margin_frequency.windows.map((w) => w.window_label + ':' + w.fav_signed.n_games).join(' ');
  if (dry || !url || !key) {
    console.log((dry ? 'dry run' : 'SB_URL / SB_SERVICE_ROLE not set') + ': would load ' + n + ' and ' + art.two_point.weeks.length + ' two-point weeks (generated ' + art.generated_at + ')');
    return 0;
  }
  const res = await fetch(url.replace(/\/$/, '') + '/rest/v1/rpc/nfl_market_structure_load', {
    method: 'POST',
    headers: { apikey: key, authorization: 'Bearer ' + key, 'content-type': 'application/json' },
    body: JSON.stringify({ p_artifact: art })
  });
  const text = await res.text();
  if (res.status === 404 || /PGRST202|42883/.test(text)) {
    console.warn('nfl_market_structure_load is not deployed (apply supabase/nfl_market_structure.sql): nothing copied. ' + text.slice(0, 200));
    return 0;
  }
  if (!res.ok) { console.error('load failed: HTTP ' + res.status + ' ' + text.slice(0, 400)); return 1; }
  console.log('loaded: ' + text);
  return 0;
}
if (require.main === module) main().then((c) => process.exit(c), (e) => { console.error(e && e.stack || e); process.exit(1); });
module.exports = { main };
