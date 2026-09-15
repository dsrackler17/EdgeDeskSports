#!/usr/bin/env node
/* ============================================================================
   RECORD ONE OPERATOR CORRECTION — the CLI side of the narrow door.

   Validates against football/availability/operator.js and appends to
   football/availability/operator.json. A rejected entry is NOT written: the
   reasons are printed and the exit code is non-zero, so a mistyped entry fails
   at the moment it is made rather than sitting inert in a committed file.

     node football/availability/record_correction.js \
       --kind AVAILABILITY --team "Miami" --player "Carson Beck" --status OUT \
       --game-id 401858226 --kickoff 2026-09-18T23:30:00Z \
       --source-name "ACC availability report" --source-url https://theacc.com/... \
       --published-at 2026-09-17T02:00:00Z --by dsrackler

     node football/availability/record_correction.js \
       --kind STARTER --team "Miami" --player "Darian Mensah" --position QB \
       --confirmed --source-name "Miami football" --source-url https://hurricanesports.com/... \
       --published-at 2026-09-17T15:00:00Z --by dsrackler

   --list   print the live, expired and refused entries and exit
   --prune  drop entries that expired more than 30 days ago and exit
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const O = require(path.join(__dirname, 'operator.js'));

const STORE = path.join(__dirname, 'operator.json');

function arg(name, fb) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fb;
  const v = process.argv[i + 1];
  return (v == null || String(v).startsWith('--')) ? true : v;
}
function readStore() {
  try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); }
  catch (_) { return { schema: O.SCHEMA, entries: [] }; }
}
function writeStore(s) { fs.writeFileSync(STORE, JSON.stringify(s, null, 2) + '\n'); }

function main() {
  const store = readStore();
  const now = Date.now();

  if (arg('list', false)) {
    const l = O.load(store, now);
    console.log(JSON.stringify({ counts: l.counts, live: l.live, expired: l.expired, refused: l.refused }, null, 1));
    return l.refused.length ? 1 : 0;
  }
  if (arg('prune', false)) {
    const cutoff = now - 30 * 864e5;
    const before = (store.entries || []).length;
    store.entries = (store.entries || []).filter(e => {
      const v = O.validate(e, now);
      if (!v.ok) return true;                      /* a refusal is kept so it stays visible */
      return Date.parse(v.entry.expires_at) > cutoff;
    });
    writeStore(store);
    console.log('[operator] pruned ' + (before - store.entries.length) + ' entr(ies) expired more than 30 days ago');
    return 0;
  }

  const entry = {
    kind: String(arg('kind', '') || '').toUpperCase(),
    team: arg('team', null),
    player: arg('player', null),
    position: arg('position', null),
    status: arg('status', null) ? String(arg('status')).toUpperCase() : null,
    confirmed: !!arg('confirmed', false),
    game_id: arg('game-id', null) ? String(arg('game-id')) : null,
    kickoff: arg('kickoff', null) || null,
    expires_at: arg('expires-at', null) || null,
    source_name: arg('source-name', null),
    source_url: arg('source-url', null),
    published_at: arg('published-at', null),
    recorded_by: arg('by', null),
    recorded_at: new Date(now).toISOString(),
    note: arg('note', null) || null
  };
  const v = O.validate(entry, now);
  if (!v.ok) {
    console.error('[operator] REFUSED — nothing was written:');
    v.why.forEach(w => console.error('  · ' + w));
    return 2;
  }
  store.schema = store.schema || O.SCHEMA;
  store.entries = store.entries || [];
  store.entries.push(entry);
  writeStore(store);
  console.log('[operator] recorded: ' + v.entry.kind + ' ' + v.entry.team + ' / ' + v.entry.player
    + (v.entry.status ? ' = ' + v.entry.status : '')
    + ' — published ' + v.entry.published_at + ', expires ' + v.entry.expires_at);
  if (v.entry.downgraded_why) console.log('[operator] note: ' + v.entry.downgraded_why);
  return 0;
}

if (require.main === module) process.exit(main());
module.exports = { main, STORE };
