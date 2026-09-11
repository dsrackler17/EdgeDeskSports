#!/usr/bin/env node
/* The tennis pipeline's database door: the shared PostgREST client bound to
   this sport's schema, so every job here says `db.select('tennis', …)` through
   the same transport the rest of the estate uses. See tools/lib/pgrest.js. */
'use strict';
const P = require('../lib/pgrest.js');

const SCHEMA = 'tennis';
const CONTRACT = 'tennis_live_center.sql';

/* A failure an operator can act on, or null. Until the contract is installed
   every tennis job fails on its first read, and a raw schema-cache error names
   the symptom rather than the fix. Printed as a GitHub error annotation so it
   lands on the run summary instead of halfway down a log. */
function explain(err) {
  const hint = P.contractHint(err, CONTRACT);
  if (!hint) return null;
  return hint;
}
function reportFailure(tag, err) {
  const hint = explain(err);
  if (hint) console.error('::error::' + tag + ': ' + hint);
  return !!hint;
}

/* The player pool every resolver reads: the LICENSED record first, the
   provider directory behind it. tennis.players is authoritative — where it
   carries a person, the directory's copy of that person is dropped, so the
   day a cleared feed is loaded it wins with nothing to unpick. Either side
   may be absent: a database with only the older contract installed still
   resolves everything it used to, it just resolves less, and one with no
   licensed record at all resolves from the directory alone. Both missing is
   a real failure and is raised.

   opts.columns           columns to read from the licensed record
   opts.directoryColumns  columns to read from the directory; defaults to
                          opts.columns, and must be a superset of it so the
                          merged pool is one shape
   opts.ids               restrict to these player ids, chunked; null reads all
   opts.singles           only directory rows seen in a singles draw        */
async function playerPool(db, R, log, opts) {
  const o = opts || {};
  const cols = o.columns || 'player_id,full_name,tour';
  const say = log || function () {};

  async function read(rel, cols, extra) {
    const ids = o.ids;
    if (!ids) return db.selectAll(SCHEMA, rel, 'select=' + cols + (extra || '') + '&order=player_id.asc');
    const out = [], chunk = 120;
    for (let i = 0; i < ids.length; i += chunk)
      out.push.apply(out, await db.selectAll(SCHEMA, rel,
        'select=' + cols + (extra || '') + '&player_id=in.' + P.inList(ids.slice(i, i + chunk)) + '&order=player_id.asc'));
    return out;
  }
  async function tolerant(rel, cols, extra, absent) {
    try { return { rows: await read(rel, cols, extra), installed: true }; }
    catch (err) {
      if (!P.notInstalled(err)) throw err;
      say(absent);
      return { rows: [], installed: false };
    }
  }

  const lic = await tolerant('players', cols, '',
    'no licensed tennis.players record in this database — resolving from the provider directory alone');
  const dir = await tolerant('player_directory', o.directoryColumns || cols, o.singles ? '&seen_in_singles=is.true' : '',
    'no provider directory in this database yet — run supabase/tennis_player_directory.sql so provider names can resolve');
  if (!lic.installed && !dir.installed)
    throw new Error('neither tennis.players nor tennis.player_directory is installed — ' + P.contractHint({ message: 'PGRST205 schema cache' }, CONTRACT));

  const pool = R.mergePlayerSources(lic.rows, dir.rows);
  const shadowed = lic.rows.length + dir.rows.length - pool.length;
  say(lic.rows.length + ' licensed player(s), ' + dir.rows.length + ' from the provider directory' +
      (shadowed > 0 ? ' (' + shadowed + ' shadowed by the licensed record)' : '') +
      ' \u2192 ' + pool.length + ' resolvable');
  return { pool: pool, licensed: lic.rows, directory: dir.rows };
}

module.exports = {
  SCHEMA,
  CONTRACT,
  explain,
  reportFailure,
  playerPool,
  config: P.config,
  client: P.client,
  inList: P.inList,
  sleep: P.sleep,
  DEFAULT_URL: P.DEFAULT_URL,
  runLedger: (db, job, o) => P.runLedger(db, SCHEMA, job, o),
  writeMeta: (db, entries) => P.writeMeta(db, SCHEMA, entries)
};
