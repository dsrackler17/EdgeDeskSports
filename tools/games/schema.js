#!/usr/bin/env node
/* ===========================================================================
   What schema does this repository ship, and what does the database have?

   supabase/games_social.sql and supabase/games_franchise.sql are pasted into
   the Supabase SQL editor and re-run. That has carried eight phases and it is
   worth keeping — there is no migration runner to install, no ordered
   directory to keep in step, and every file is safe to run again. Its one
   hole was that NOTHING COULD TELL YOU WHAT A DATABASE HAD: a project three
   phases behind looked exactly like a current one right up until a page
   called a function that was not there.

   So every phase now records itself in games_schema_log as it applies, and
   this tool reads the same record three ways:

       node tools/games/schema.js           # what the repository ships
       node tools/games/schema.js --live    # ...and what the database has

   --live reads games/data/config.json and calls games_schema(), which is
   granted to anon and returns phase names and dates and nothing about
   anybody. It applies nothing. Exit code 1 if the database is behind the
   repository, so a deploy check can use it.

   The parity between the SQL, the client mirror in games/lib/franchise.js
   and this tool is asserted by tools/games/franchise.test.js — a phase that
   forgets to record itself goes red there, not here.
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const FILES = [
  { layer: 'social', file: 'supabase/games_social.sql' },
  { layer: 'franchise', file: 'supabase/games_franchise.sql' }
];

/* EVERY PHASE A FILE RECORDS, in the order it records it. This is the
   repository's own answer, read from the SQL rather than from a list
   somebody has to remember to update. */
function shipped() {
  const out = {};
  for (const { layer, file } of FILES) {
    const sql = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const re = /games_schema_note\(\s*'([a-z_]+)'\s*,\s*(\d+)\s*,\s*'((?:[^']|'')*)'\s*\)/g;
    const rows = [];
    let m;
    while ((m = re.exec(sql))) {
      if (m[1] !== layer) continue;                       /* a note for another layer */
      rows.push({ phase: Number(m[2]), name: m[3].replace(/''/g, "'") });
    }
    rows.sort((a, b) => a.phase - b.phase);
    out[layer] = { file, phases: rows, max: rows.length ? rows[rows.length - 1].phase : 0 };
  }
  return out;
}

/* WHAT THE DATABASE HAS. One anon RPC, no state applied. */
async function live() {
  const cfgPath = path.join(ROOT, 'games', 'data', 'config.json');
  if (!fs.existsSync(cfgPath)) throw new Error('games/data/config.json is not in this build');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  if (!cfg.supabase_url || !cfg.supabase_anon_key) throw new Error('config.json carries no endpoint');
  const res = await fetch(cfg.supabase_url.replace(/\/+$/, '') + '/rest/v1/rpc/games_schema', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: cfg.supabase_anon_key,
      authorization: 'Bearer ' + cfg.supabase_anon_key
    },
    body: '{}'
  });
  if (res.status === 404) {
    /* the log itself is not installed: this database predates it */
    return { missing: true, host: cfg.supabase_url };
  }
  if (!res.ok) throw new Error('games_schema() answered HTTP ' + res.status + ': ' + (await res.text()).slice(0, 200));
  return { data: await res.json(), host: cfg.supabase_url };
}

/* `node tools/games/schema.js | head` closes the pipe under us; that is a
   normal way to read a report, not a crash. */
process.stdout.on('error', e => { if (e && e.code === 'EPIPE') process.exit(0); throw e; });
function line(s) { process.stdout.write(s + '\n'); }

async function main() {
  const wantLive = process.argv.includes('--live');
  const ship = shipped();

  line('');
  line('  THE REPOSITORY SHIPS');
  for (const layer of Object.keys(ship)) {
    const s = ship[layer];
    line('');
    line('    ' + layer + ' ' + s.max + '   ' + s.file);
    for (const p of s.phases) line('      ' + String(p.phase).padStart(2) + '  ' + p.name);
    /* a gap in the numbering means a phase forgot to record itself */
    const holes = s.phases.map(p => p.phase).filter((n, i) => n !== i + 1);
    if (holes.length) line('      !! not consecutive from 1 — a phase is not recording itself');
  }
  line('');

  if (!wantLive) {
    line('  Pass --live to ask the deployed database what it actually has.');
    line('');
    return 0;
  }

  let got;
  try {
    got = await live();
  } catch (e) {
    line('  THE DATABASE could not be read: ' + e.message);
    line('');
    return 2;
  }

  if (got.missing) {
    line('  THE DATABASE has no games_schema() — it was applied before the schema');
    line('  log existed, so it cannot say what it has. Re-apply both files; they');
    line('  are safe to run again, and after that this reports the real answer.');
    line('');
    return 1;
  }

  const d = got.data || {};
  line('  THE DATABASE at ' + got.host.replace(/^https?:\/\//, ''));
  line('');
  let behind = 0;
  for (const layer of Object.keys(ship)) {
    const have = Number(d[layer] || 0), want = ship[layer].max;
    const mark = (have >= want ? 'ok' : 'BEHIND').padEnd(6);
    line('    ' + mark + ' ' + layer + ' ' + have + ' of ' + want
      + (have < want ? '   ' + ship[layer].file : ''));
    for (const p of ship[layer].phases) {
      if (p.phase > have) { behind++; line('      missing ' + p.phase + '  ' + p.name); }
    }
    if (have > want) line('      (ahead of this checkout — a newer file was applied)');
  }
  line('');
  line('    first applied   ' + (d.applied_at || 'unknown'));
  line('    last re-applied ' + (d.reapplied_at || 'never'));
  line('');
  if (behind) {
    line('  ' + behind + ' phase(s) missing. Paste the file(s) above into the Supabase SQL');
    line('  editor and run. Safe to run again.');
    line('');
    return 1;
  }
  line('  Current.');
  line('');
  return 0;
}

main().then(code => { process.exitCode = code; },
  e => { console.error(e && e.stack || e); process.exitCode = 2; });
