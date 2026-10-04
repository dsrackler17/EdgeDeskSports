#!/usr/bin/env node
/* ===========================================================================
   ADD A DESK NOTE — a person looked something up; record it with a receipt.

     node tools/football/add_note.js --sport nfl --team BUF --kind starting_qb \
       --text "Josh Allen confirmed to start by the club" \
       --source "Buffalo Bills" --url https://www.buffalobills.com/... \
       --published-at 2026-09-16T14:00:00Z --by "D. Rackler" [--expires-at ISO] [--game-id 2026_03_DET_BUF]
     node tools/football/add_note.js --list
     node tools/football/add_note.js --expire      # drop expired notes

   A note without a url, a publication time or a recorder is REFUSED. Notes
   expire after seven days unless told otherwise, because a note that never
   expires is a permanent fiction. Nothing here is verified against the
   source; the note says who looked and where, and the desk quotes exactly that.
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const FILE = path.join(ROOT, 'football', 'notes', 'current.json');
const KINDS = ['starting_qb', 'starting_qb_confirmation', 'ol_availability', 'ol_replacement', 'defensive_personnel', 'weather', 'current_price', 'opponent_adjusted', 'projection'];
const SPORTS = { nfl: 'americanfootball_nfl', cfb: 'americanfootball_ncaaf' };
const TTL_MS = 7 * 86400000;
function arg(name) { const i = process.argv.indexOf('--' + name); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : null; }
function load() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (_) { return { schema: 'edgedesk_desk_notes_v1', notes: [] }; } }
function save(j) { j.generated_at = new Date().toISOString(); fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(j, null, 1)); }
/** Validate one note; returns {ok, note} or {ok:false, reasons}. Pure. */
function validate(o, nowMs) {
  const reasons = [];
  const sport = SPORTS[String(o.sport || '').toLowerCase()] || (Object.values(SPORTS).includes(o.sport) ? o.sport : null);
  if (!sport) reasons.push('sport must be nfl or cfb');
  if (!o.team) reasons.push('team is required (NFL club code or the college team key)');
  if (!KINDS.includes(o.kind)) reasons.push('kind must be one of ' + KINDS.join(', '));
  if (!o.text || String(o.text).trim().length < 8) reasons.push('text is required');
  if (!o.source) reasons.push('source name is required');
  if (!/^https?:\/\/\S+\.\S+/i.test(String(o.url || ''))) reasons.push('a source url is required ("I heard" is not a note)');
  const pub = Date.parse(o.published_at || ''); if (!Number.isFinite(pub)) reasons.push('published_at (when the SOURCE said it) is required, ISO 8601');
  if (!o.by) reasons.push('by (who recorded it) is required');
  if (Number.isFinite(pub) && pub > nowMs + 3600000) reasons.push('published_at is in the future');
  if (reasons.length) return { ok: false, reasons };
  const exp = o.expires_at ? Date.parse(o.expires_at) : pub + TTL_MS;
  return { ok: true, note: { id: 'note_' + Math.random().toString(36).slice(2, 10), sport, team: String(o.team).toUpperCase(), kind: o.kind, text: String(o.text).trim(), source: String(o.source), url: String(o.url), published_at: new Date(pub).toISOString(), recorded_at: new Date(nowMs).toISOString(), recorded_by: String(o.by), expires_at: new Date(Number.isFinite(exp) ? exp : pub + TTL_MS).toISOString(), game_id: o.game_id || null, source_kind: /\.(edu|gov)$/i.test(new URL(o.url).hostname) || /(sports|athletics|nfl|bills|lions|chiefs|packers|eagles)\.com$/i.test(new URL(o.url).hostname) ? 'OFFICIAL_SITE' : 'REPUTABLE_MEDIA' } };
}
function main() {
  const j = load(); const now = Date.now();
  if (process.argv.includes('--list')) { j.notes.forEach((n) => console.log(`${n.sport} ${n.team} ${n.kind} [${n.published_at}] ${n.text} — ${n.source} ${n.url} (by ${n.recorded_by}, expires ${n.expires_at})`)); console.log(j.notes.length + ' note(s)'); return; }
  if (process.argv.includes('--expire')) { const before = j.notes.length; j.notes = j.notes.filter((n) => Date.parse(n.expires_at) > now); save(j); console.log('expired ' + (before - j.notes.length) + ' note(s); ' + j.notes.length + ' remain'); return; }
  const v = validate({ sport: arg('sport'), team: arg('team'), kind: arg('kind'), text: arg('text'), source: arg('source'), url: arg('url'), published_at: arg('published-at'), by: arg('by'), expires_at: arg('expires-at'), game_id: arg('game-id') }, now);
  if (!v.ok) { console.error('REFUSED: ' + v.reasons.join('; ')); process.exit(1); }
  j.notes.push(v.note); save(j); console.log('recorded ' + v.note.id + ' for ' + v.note.team + ' (' + v.note.kind + '), expires ' + v.note.expires_at);
}
module.exports = { validate, KINDS, SPORTS, TTL_MS, FILE };
if (require.main === module) main();
