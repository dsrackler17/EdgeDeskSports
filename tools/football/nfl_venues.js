/* ===========================================================================
   NFL VENUE LOOKUP — the hand-entered stadium table, read through its
   verification. A stadium the verifier REFUSED is not returned; a stadium
   with no verification on file is returned with verification: 'UNVERIFIED'
   so a consumer can decide. Lookup by stadium name or alias (games.csv's
   `stadium` column) or by club code (the home venue).
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const TABLE = path.join(ROOT, 'football', 'venues', 'nfl_stadiums.json');
const VERIF = path.join(ROOT, 'football', 'venues', 'nfl_stadiums.verification.json');
let cache = null;
function load(opts) {
  if (cache && !(opts && opts.reload)) return cache;
  let table = null, verif = null;
  try { table = JSON.parse(fs.readFileSync((opts && opts.table) || TABLE, 'utf8')); } catch (_) { table = null; }
  try { verif = JSON.parse(fs.readFileSync((opts && opts.verification) || VERIF, 'utf8')); } catch (_) { verif = null; }
  const verdict = {}; if (verif && verif.verdicts) verif.verdicts.forEach((r) => { verdict[r.name] = r; });
  const byName = {}, byClub = {};
  ((table && table.stadiums) || []).forEach((s) => {
    const v = verdict[s.name] || null;
    const row = Object.assign({}, s, { verification: v ? v.verdict : 'UNVERIFIED', independent_coordinate_check: v ? !!v.independent_coordinate_check : false, source: 'football/venues/nfl_stadiums.json (hand-entered; ' + (v ? v.verdict.toLowerCase() + ' by tools/football/verify_nfl_stadiums.js' : 'no verification on file') + ')', as_of: (table && table.generated_at) || null });
    if (row.verification === 'REFUSED') return;
    [s.name].concat(s.aliases || []).forEach((n) => { byName[String(n).toLowerCase()] = row; });
    (s.clubs || (s.club ? [s.club] : [])).forEach((c) => { byClub[String(c).toUpperCase()] = row; });
  });
  cache = { byName, byClub, table, verification: verif, count: Object.keys(byClub).length };
  return cache;
}
/** The venue for a game: by the feed's stadium name first, else the home club's stadium. */
function venueFor(o, opts) {
  const L = load(opts); o = o || {};
  const byName = o.stadium ? L.byName[String(o.stadium).toLowerCase()] : null;
  const row = byName || (o.club ? L.byClub[String(o.club).toUpperCase()] : null);
  if (!row) return null;
  return { name: row.name, city: row.city || null, lat: row.lat, lon: row.lon, tz_name: row.tz_name || null, dome: row.roof === 'dome' || row.roof === 'closed', roof: row.roof, grass: row.surface === 'grass', international: !!row.international, matched_by: byName ? 'stadium name' : 'home club', verification: row.verification, independent_coordinate_check: row.independent_coordinate_check, source: row.source, as_of: row.as_of };
}
module.exports = { load, venueFor, TABLE, VERIF };
