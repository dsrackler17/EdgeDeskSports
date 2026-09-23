#!/usr/bin/env node
/* ===========================================================================
   SETTLING THE DESK'S PREDICTION HISTORY.

   desk_prediction_history holds every selection the AI Desk showed a reader
   at a current, pregame price. This module turns finished games into rows
   of desk_prediction_finals, which the desk_prediction_history_settled view
   joins and grades. It never edits a prediction and never writes a final
   for a game that has not finished.

   The finals come from the Collective's committed settlement record
   (collective/settled/<SPORT>_<season>.json): a score only when every public
   feed that carries the game agrees, 0-0 never, a missing close null. A
   desk record is matched to one of those games by league, both teams and a
   kickoff within six hours — or not at all.

   outcomeOf() is the same rule the SQL view applies, kept here so the two can
   be tested against each other.

   CLI:
     node tools/intelligence/desk_history.js --records <file.json> [--dry-run]
       reads history records from a file (an export of the table), prints
       the finals it would write.
     node tools/intelligence/desk_history.js --write
       reads unsettled records with SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
       and writes their finals (write-once; a duplicate is ignored).
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

const FILE = { americanfootball_nfl: 'NFL', americanfootball_ncaaf: 'CFB' };
const KICKOFF_TOLERANCE_MS = 6 * 3600000;

function num(v) { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
/** The Collective's schedule keys: letters and digits, upper case, cut to ten characters. */
function collectiveKey(name) { return String(name || '').toUpperCase().replace(/&/g, 'AND').replace(/[^A-Z0-9]/g, '').slice(0, 10); }
/** NFL club codes from an nflverse game id ("2026_03_NYG_LA" -> away NYG, home LA). */
function nflCodes(gameId) { const m = /^\d{4}_\d{2}_([A-Z]{2,3})_([A-Z]{2,3})$/.exec(String(gameId || '')); return m ? { away: m[1], home: m[2] } : null; }

/** WIN / LOSS / PUSH for one record against a final, by the view's rule. */
function outcomeOf(rec, fin) {
  if (!rec || !fin) return null;
  const hs = num(fin.home_score), as = num(fin.away_score), line = num(rec.line);
  if (hs == null || as == null) return null;
  let s;
  if (rec.market === 'spread') { if (line == null) return null; s = Math.sign((rec.side === 'home' ? hs - as : as - hs) + line); }
  else if (rec.market === 'total') { if (line == null) return null; s = Math.sign(rec.side === 'over' ? (hs + as) - line : line - (hs + as)); }
  else if (rec.market === 'moneyline') s = Math.sign(rec.side === 'home' ? hs - as : as - hs);
  else return null;
  return s > 0 ? 'WIN' : s < 0 ? 'LOSS' : 'PUSH';
}
/** CLV in points against the captured close, side-oriented (positive = the number taken beat the close). */
function clvPoints(rec, fin) {
  const line = num(rec.line);
  if (line == null || !fin) return null;
  if (rec.market === 'spread') { const c = num(fin.close_home_line); return c == null ? null : Math.round((line - (rec.side === 'home' ? c : -c)) * 100) / 100; }
  if (rec.market === 'total') { const c = num(fin.close_total); return c == null ? null : Math.round((rec.side === 'over' ? c - line : line - c) * 100) / 100; }
  return null;
}

function loadSettled(sport, season) {
  const f = path.join(ROOT, 'collective', 'settled', FILE[sport] + '_' + season + '.json');
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; }
}

/**
 * The final for one history record, or null. `settled` is a Collective
 * settlement file. The record must carry home/away names (CFB) or an nflverse
 * game id (NFL); a match needs both teams and a kickoff within six hours, and a
 * settlement time after kickoff.
 */
function finalFor(rec, settled, names) {
  if (!rec || !settled || !settled.games) return null;
  const k = Date.parse(rec.kickoff);
  let home, away;
  if (rec.sport === 'americanfootball_nfl') { const c = nflCodes(rec.game_id); if (!c) return null; home = c.home; away = c.away; }
  else { if (!names || !names.home || !names.away) return null; home = collectiveKey(names.home); away = collectiveKey(names.away); }
  const hits = Object.keys(settled.games).map((id) => settled.games[id]).filter((g) => g && g.home === home && g.away === away
    && Number.isFinite(Date.parse(g.kickoff_at)) && Math.abs(Date.parse(g.kickoff_at) - k) <= KICKOFF_TOLERANCE_MS);
  if (hits.length !== 1) return null;
  const g = hits[0];
  if (num(g.home_score) == null || num(g.away_score) == null || (g.home_score === 0 && g.away_score === 0)) return null;
  if (!(Date.parse(g.settled_at) > k)) return null;
  return { sport: rec.sport, game_id: rec.game_id, home_score: g.home_score, away_score: g.away_score,
    close_home_line: num(g.closing_spread), close_total: num(g.closing_total), settled_at: g.settled_at,
    source: 'collective/settled/' + FILE[rec.sport] + '_' + settled.season + '.json (' + (g.score_source || 'collective') + ')' };
}

/** The team names frozen on the record (home_team, away_team). */
function namesOf(rec) {
  return rec && rec.home_team && rec.away_team ? { home: rec.home_team, away: rec.away_team } : null;
}

function finalsFor(records, loader) {
  const out = [], seen = {};
  loader = loader || loadSettled;
  const cache = {};
  (records || []).forEach((r) => {
    const key = r.sport + '|' + r.game_id; if (seen[key]) return;
    const season = new Date(r.kickoff).getUTCFullYear();
    const ck = r.sport + season;
    if (!(ck in cache)) cache[ck] = loader(r.sport, season);
    const f = finalFor(r, cache[ck], namesOf(r));
    if (f) { seen[key] = 1; out.push(f); }
  });
  return out;
}

async function main(argv) {
  const dry = argv.includes('--dry-run'), write = argv.includes('--write');
  const ri = argv.indexOf('--records');
  let records = [];
  if (ri >= 0) records = JSON.parse(fs.readFileSync(argv[ri + 1], 'utf8'));
  else if (write) {
    const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) { console.log('BLOCKED: --write needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY'); process.exit(2); }
    const r = await fetch(url + '/rest/v1/desk_prediction_history_settled?select=record_id,sport,game_id,home_team,away_team,kickoff,market,side,line&settled=is.false&kickoff=lt.' + new Date().toISOString() + '&limit=2000',
      { headers: { apikey: key, authorization: 'Bearer ' + key } });
    records = r.ok ? await r.json() : [];
    if (!r.ok) { console.log('could not read history: HTTP ' + r.status); process.exit(1); }
  } else { console.log('usage: desk_history.js --records <file.json> [--dry-run] | --write'); process.exit(2); }
  const finals = finalsFor(records);
  console.log(records.length + ' records, ' + finals.length + ' finals matched');
  if (dry || !write) { finals.forEach((f) => console.log(JSON.stringify(f))); return; }
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const r = await fetch(url + '/rest/v1/desk_prediction_finals?on_conflict=sport,game_id', { method: 'POST',
    headers: { apikey: key, authorization: 'Bearer ' + key, 'content-type': 'application/json', prefer: 'return=minimal,resolution=ignore-duplicates' },
    body: JSON.stringify(finals) });
  console.log(r.ok ? 'wrote ' + finals.length + ' finals' : 'write failed: HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
  if (!r.ok) process.exit(1);
}

module.exports = { outcomeOf, clvPoints, finalFor, finalsFor, collectiveKey, nflCodes, namesOf, KICKOFF_TOLERANCE_MS };
if (require.main === module) main(process.argv.slice(2)).catch((e) => { console.error(e); process.exit(1); });
