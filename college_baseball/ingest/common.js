'use strict';
/* ===========================================================================
   EdgeDesk college baseball — ingestion helpers shared by every connector.

   Dates in the source are local calendar dates written MM/DD/YYYY, sometimes
   with a doubleheader suffix "(1)" / "(2)" and sometimes a local start time
   ("02/14/2026 01:00 PM", "02/16/2024 TBA"). The local date is the game's
   date; a local clock time is carried as text because the source gives no
   time zone, and converting it would invent one.

   NULL IS NOT ZERO. num('') is null, never 0.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { toCsv } = require('../../engine/csv');
const C = require('../config');

function num(v) { if (v === null || v === undefined || v === '' || v === 'NA') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function int(v) { const n = num(v); return n == null ? null : Math.trunc(n); }
function str(v) { return v === null || v === undefined || v === 'NA' ? '' : String(v).trim(); }

/** parse "MM/DD/YYYY[(n)][ HH:MM AM|TBA]" -> {date:'YYYY-MM-DD', dh:n|null, time:'HH:MM AM'|null} */
function parseDate(raw) {
  const s = str(raw);
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s*\((\d)\))?(?:\s+(.*))?$/.exec(s);
  if (!m) return null;
  const date = `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  let time = m[5] ? m[5].trim() : null;
  if (time && !/^\d{1,2}:\d{2}\s*(AM|PM)$/i.test(time)) time = null;   // TBA / TBD / noise
  return { date, dh: m[4] ? Number(m[4]) : null, time };
}

/** the instant a game's prediction is made (protocol §1) */
function predictAt(dateISO) { return `${dateISO}T${String(C.TIME.predict_hour_utc).padStart(2, '0')}:00:00Z`; }
/** the instant a game's facts are assumed available: 06:00 UTC the next day */
function availableAt(dateISO) {
  const d = new Date(dateISO + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10) + `T${String(C.TIME.available_next_day_hour_utc).padStart(2, '0')}:00:00Z`;
}

function addDays(dateISO, k) { const d = new Date(dateISO + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + k); return d.toISOString().slice(0, 10); }
function weekday(dateISO) { return new Date(dateISO + 'T00:00:00Z').getUTCDay(); }   // 0 Sun .. 6 Sat
function daysBetween(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5); }

/** Memorial Day: the last Monday of May */
function memorialDay(season) {
  const d = new Date(Date.UTC(season, 4, 31));
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** write text only when it changed; returns true if written */
function writeIfChanged(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const gz = /\.gz$/.test(file);
  if (fs.existsSync(file)) {
    const old = gz ? zlib.gunzipSync(fs.readFileSync(file)).toString('utf8') : fs.readFileSync(file, 'utf8');
    if (old === text) return false;
  }
  fs.writeFileSync(file, gz ? zlib.gzipSync(Buffer.from(text, 'utf8'), { level: 9, mtime: 0 }) : text);
  return true;
}
function writeCsv(file, header, rows) { return writeIfChanged(file, toCsv(header, rows)); }
function writeJson(file, obj) { return writeIfChanged(file, JSON.stringify(obj, null, 1) + '\n'); }

/** a team/person name in canonical comparison form */
function normName(s) {
  return str(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/&amp;/g, '&').replace(/[^a-z0-9&]+/g, ' ').trim();
}
/** a player's name in "first last" comparison form; handles "Last, F" and "F. Last" */
function personKey(s) {
  let t = str(s).replace(/\s+/g, ' ').trim();
  const comma = /^([^,]+),\s*(.+)$/.exec(t);
  if (comma) t = comma[2] + ' ' + comma[1];
  return normName(t);
}

/** innings-pitched text "5.1" = 5 innings + 1 out = 16 outs; "5.3" or worse is invalid */
function outsFromIp(ip) {
  const s = str(ip);
  if (!s) return null;
  const m = /^(\d+)(?:\.(\d))?$/.exec(s);
  if (!m) return { invalid: true, raw: s };
  const frac = m[2] ? Number(m[2]) : 0;
  if (frac > 2) return { invalid: true, raw: s };
  return Number(m[1]) * 3 + frac;
}

module.exports = { num, int, str, parseDate, predictAt, availableAt, addDays, weekday, daysBetween, memorialDay, writeIfChanged, writeCsv, writeJson, normName, personKey, outsFromIp };
