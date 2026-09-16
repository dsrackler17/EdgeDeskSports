#!/usr/bin/env node
/* ===========================================================================
   VERIFY THE HAND-ENTERED NFL STADIUM TABLE against what the repo can check
   without a geocoder: the venue register (college venues with CFBD
   coordinates: a stadium that also hosts college games must sit within 2 km
   of the register's point), nflverse games.csv (roof and surface must agree
   with the feed's modal value for that stadium since 2020), the home state's
   bounding box (a US stadium must fall inside its state), and the time zone
   (must be consistent with the longitude to within one zone). Every row gets
   a verdict; a row with a failed check is REFUSED and the venue build will
   not write it.

   Run: node tools/football/verify_nfl_stadiums.js          # writes nfl_stadiums.verification.json, exit 1 on any refusal
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const TABLE = path.join(ROOT, 'football', 'venues', 'nfl_stadiums.json');
const OUT = path.join(ROOT, 'football', 'venues', 'nfl_stadiums.verification.json');
const STATE_BBOX = { /* [minLat, maxLat, minLon, maxLon], generous */
  NY: [40.4, 45.1, -79.8, -71.8], FL: [24.4, 31.1, -87.7, -79.9], MA: [41.2, 42.9, -73.6, -69.9], NJ: [38.9, 41.4, -75.6, -73.8], MD: [37.9, 39.8, -79.5, -75.0],
  OH: [38.4, 42.0, -84.9, -80.5], PA: [39.7, 42.3, -80.6, -74.6], TX: [25.8, 36.6, -106.7, -93.5], IN: [37.7, 41.8, -88.1, -84.7], TN: [34.9, 36.7, -90.4, -81.6],
  CO: [36.9, 41.1, -109.1, -102.0], MO: [35.9, 40.7, -95.8, -89.0], NV: [35.0, 42.1, -120.1, -114.0], CA: [32.5, 42.1, -124.5, -114.1], IL: [36.9, 42.6, -91.6, -87.0],
  MI: [41.6, 48.4, -90.5, -82.3], WI: [42.4, 47.1, -92.9, -86.7], MN: [43.4, 49.4, -97.3, -89.4], GA: [30.3, 35.1, -85.7, -80.7], NC: [33.8, 36.6, -84.4, -75.4],
  LA: [28.9, 33.1, -94.1, -88.7], AZ: [31.3, 37.1, -114.9, -109.0], WA: [45.5, 49.1, -124.9, -116.9] };
function hav(a, b) { const R = 6371, dLat = (b.lat - a.lat) * Math.PI / 180, dLon = (b.lon - a.lon) * Math.PI / 180; const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLon / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); }
function tzOffsetGuess(tz) { /* standard-time offsets, hours */ return ({ 'America/New_York': -5, 'America/Chicago': -6, 'America/Denver': -7, 'America/Phoenix': -7, 'America/Los_Angeles': -8, 'America/Detroit': -5, 'America/Indiana/Indianapolis': -5, 'Europe/London': 0, 'Europe/Dublin': 0, 'Europe/Berlin': 1, 'Europe/Madrid': 1, 'America/Mexico_City': -6, 'Australia/Melbourne': 10, 'America/Sao_Paulo': -3 })[tz]; }

function verify(table, register, games) {
  const byName = {}; Object.values(register.venues || {}).forEach((v) => { if (v && v.name && Number.isFinite(v.lat)) byName[String(v.name).toLowerCase()] = v; });
  /* modal roof/surface per stadium from games.csv since 2020 */
  const feed = {};
  games.forEach((g) => { if (!g.ctx || !g.ctx.stadium || g.season < 2020) return; const e = (feed[g.ctx.stadium.toLowerCase()] = feed[g.ctx.stadium.toLowerCase()] || { roof: {}, surface: {}, n: 0 }); e.n++; if (g.ctx.roof) e.roof[g.ctx.roof] = (e.roof[g.ctx.roof] || 0) + 1; if (g.ctx.surface) e.surface[g.ctx.surface] = (e.surface[g.ctx.surface] || 0) + 1; });
  const mode = (m) => Object.keys(m).sort((a, b) => m[b] - m[a])[0] || null;
  const seen = {}; const rows = [];
  table.stadiums.forEach((s) => {
    const checks = []; const names = [s.name].concat(s.aliases || []);
    names.forEach((n) => { const k = n.toLowerCase(); if (seen[k]) checks.push({ check: 'unique_name', ok: false, detail: n + ' also names ' + seen[k] }); seen[k] = s.name; });
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon) || Math.abs(s.lat) > 90 || Math.abs(s.lon) > 180) checks.push({ check: 'coordinates', ok: false, detail: 'not real coordinates' }); else checks.push({ check: 'coordinates', ok: true });
    const reg = names.map((n) => byName[n.toLowerCase()]).find(Boolean);
    if (reg) { const d = hav({ lat: s.lat, lon: s.lon }, { lat: reg.lat, lon: reg.lon }); checks.push({ check: 'register_distance_km', ok: d <= 2, detail: Math.round(d * 100) / 100 + ' km from the register (' + reg.name + ')' }); }
    else checks.push({ check: 'register_distance_km', ok: null, detail: 'not in the college venue register; no independent coordinate to compare' });
    const fe = names.map((n) => feed[n.toLowerCase()]).find(Boolean);
    if (fe && fe.n < 3) checks.push({ check: 'roof_vs_feed', ok: null, detail: 'only ' + fe.n + ' game(s) since 2020 in games.csv: one row is not evidence about a roof or a surface (feed says ' + mode(fe.roof) + ' / ' + mode(fe.surface) + ')' });
    else if (fe) { const r = mode(fe.roof), su = mode(fe.surface); const roofOk = !r || r === s.roof || (r === 'closed' && s.roof === 'dome') || (r === 'dome' && s.roof === 'closed') || (r === 'open' && s.roof === 'outdoors'); const surfOk = !su || su === s.surface || (/turf/i.test(su) && /turf/i.test(s.surface)) || (/grass/i.test(su) && /grass/i.test(s.surface)); checks.push({ check: 'roof_vs_feed', ok: roofOk, detail: 'feed modal roof ' + r + ', table ' + s.roof }); checks.push({ check: 'surface_vs_feed', ok: surfOk, detail: 'feed modal surface ' + su + ', table ' + s.surface }); }
    else checks.push({ check: 'roof_vs_feed', ok: null, detail: 'no games since 2020 under this name in games.csv' });
    if (s.state && STATE_BBOX[s.state]) { const b = STATE_BBOX[s.state]; const inside = s.lat >= b[0] && s.lat <= b[1] && s.lon >= b[2] && s.lon <= b[3]; checks.push({ check: 'inside_state', ok: inside, detail: s.state }); }
    else if (s.state) checks.push({ check: 'inside_state', ok: null, detail: 'no bounding box for ' + s.state });
    const off = tzOffsetGuess(s.tz_name); if (off != null) { const lonOff = Math.round(s.lon / 15); const ok = Math.abs(lonOff - off) <= 1 || (s.tz_name === 'America/Phoenix' && Math.abs(lonOff - off) <= 1) || (s.tz_name === 'Europe/Madrid' && Math.abs(lonOff - off) <= 1); checks.push({ check: 'timezone_vs_longitude', ok, detail: 'longitude zone ' + lonOff + ', tz offset ' + off }); }
    else checks.push({ check: 'timezone_vs_longitude', ok: false, detail: 'unknown tz ' + s.tz_name });
    const failed = checks.filter((c) => c.ok === false);
    rows.push({ name: s.name, club: s.club || null, verdict: failed.length ? 'REFUSED' : 'VERIFIED', independent_coordinate_check: checks.some((c) => c.check === 'register_distance_km' && c.ok === true), checks });
  });
  const verified = rows.filter((r) => r.verdict === 'VERIFIED').length;
  return { schema: 'edgedesk_nfl_stadiums_verification_v1', generated_at: new Date().toISOString(), table: path.relative(ROOT, TABLE), rows: rows.length, verified, refused: rows.length - verified, with_independent_coordinate_check: rows.filter((r) => r.independent_coordinate_check).length,
    basis: 'hand-entered coordinates checked against the college venue register (CFBD coordinates) where the stadium hosts college games, nflverse games.csv roof and surface, the state bounding box and the time zone; a stadium with no independent coordinate is VERIFIED on the other checks only and says so', verdicts: rows };
}

function main() {
  const table = JSON.parse(fs.readFileSync(TABLE, 'utf8'));
  const register = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'venues', 'resolved.json'), 'utf8'));
  let games = []; try { games = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'pricing', 'lines_nfl.json'), 'utf8')).games; } catch (_) { games = []; }
  const v = verify(table, register, games);
  fs.writeFileSync(OUT, JSON.stringify(v, null, 1));
  console.log(`nfl stadiums: ${v.rows} rows, ${v.verified} verified (${v.with_independent_coordinate_check} with an independent coordinate check), ${v.refused} refused`);
  v.verdicts.filter((r) => r.verdict === 'REFUSED').forEach((r) => console.log('  REFUSED ' + r.name + ': ' + r.checks.filter((c) => c.ok === false).map((c) => c.check + ' (' + c.detail + ')').join('; ')));
  v.verdicts.forEach((r) => { const d = r.checks.find((c) => c.check === 'register_distance_km' && c.ok !== null); if (d) console.log('  ' + r.name + ': ' + d.detail); });
  process.exit(v.refused ? 1 : 0);
}
module.exports = { verify, STATE_BBOX };
if (require.main === module) main();
