#!/usr/bin/env node
/* ===========================================================================
   ONE DATABASE INTERFACE FOR BOTH BACKENDS

   THIS FILE EXISTS BECAUSE THE COLLEGE BASEBALL COMMIT PATH COULD NOT WRITE.
   Worth stating plainly rather than quietly fixing, because the failure was
   invisible in exactly the way that matters:

     - tools/cbb/ingest.js --commit called P.client() on tools/mlb/pg_client.js,
       which exports pgClient and has no client at all. That is a TypeError on
       the first line of the commit path.
     - and even with the name corrected it would still not have worked, because
       pg_client.js is a PostgREST-SHAPED HARNESS OVER LOCAL psql, built for
       tests. It speaks SQL text to a unix socket. Production is Supabase over
       HTTP, which cannot execute SQL text at all.

   So tools/cbb/stage.js, which emits `insert into ...` strings, was only ever
   going to work against the test harness. Every run so far has been --check, on
   a pull request or out of season, so nothing ever exercised the write. The
   first scheduled in-season run in February would have been the first time
   anyone found out.

   The fix is this adapter. It wraps EITHER backend behind the four operations
   the importers actually need, so the path the tests exercise and the path the
   scheduler runs are the same code with one object swapped underneath — which
   is the only arrangement in which a passing test says anything about
   production.
   =========================================================================== */
'use strict';

const SCHEMA = 'cbb';

/* literals are ours to quote in the SQL backend */
function lit(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  /* The cast follows the ELEMENTS, not a default. cbb.import_runs.seasons is
     int[] and cbb.games.seen_by is text[]; casting both to text[] fails on the
     first one, and casting both to int[] would fail on the second. An empty
     array has no element to read, so it is left uncast and Postgres resolves it
     from the column. */
  if (Array.isArray(v)) {
    const body = 'array[' + v.map((x) => lit(x)).join(',') + ']';
    if (!v.length) return body;
    return body + (v.every((x) => typeof x === 'number') ? '::int[]' : '::text[]');
  }
  return "'" + String(v).replace(/'/g, "''") + "'";
}

function chunk(rows, n) {
  const out = [];
  for (let i = 0; i < rows.length; i += n) out.push(rows.slice(i, i + n));
  return out;
}

/* ── the psql-shaped harness: SQL text over a socket ─────────────────────── */
function psqlAdapter(db) {
  return {
    mode: 'psql',
    async stageRows(rel, cols, rows, importId) {
      let n = 0;
      for (const part of chunk(rows, 400)) {
        db.sql(`insert into ${SCHEMA}.${rel} (import_id, ${cols.join(', ')}) values `
          + part.map((r) => '(' + lit(importId) + ', '
            + cols.map((c) => lit(r[c] === undefined ? null : r[c])).join(', ') + ')').join(', '));
        n += part.length;
      }
      return n;
    },
    /* Positional, because that is what SQL takes. The argument ORDER here is
       part of the contract and is kept identical to the named form below. */
    async gate(fn, argOrder, args) {
      const call = argOrder.map((k) => {
        const v = args[k];
        /* dates must be typed or Postgres cannot resolve the overload */
        if (k === 'p_from' || k === 'p_through') return `${lit(v)}::date`;
        return lit(v);
      }).join(', ');
      const res = db.rows(`select ${SCHEMA}.${fn}(${call}) as v`)[0];
      return typeof res.v === 'string' ? JSON.parse(res.v) : res.v;
    },
    async completedGames(season, limit) {
      const cap = limit > 0 ? ` limit ${Number(limit)}` : '';
      return db.rows(`select game_id, season, game_date, home_team_id, away_team_id,
                             home_name, away_name
                        from ${SCHEMA}.games
                       where season = ${Number(season)} and completed
                       order by game_date${cap}`);
    },
    async abandon(importId, reason) {
      db.sql(`select ${SCHEMA}.abandon_cbb_import(${lit(importId)}, ${lit(reason)})`);
    },
    async startRun(row) {
      const cols = Object.keys(row);
      db.sql(`insert into ${SCHEMA}.import_runs (${cols.join(', ')}) values (`
        + cols.map((c) => lit(row[c])).join(', ') + ')');
    },
  };
}

/* ── Supabase over PostgREST: JSON over HTTP ─────────────────────────────── */
function pgrestAdapter(db) {
  return {
    mode: 'pgrest',
    async stageRows(rel, cols, rows, importId) {
      let n = 0;
      for (const part of chunk(rows, 400)) {
        /* PostgREST refuses a bulk write whose objects do not all carry the
           SAME keys (PGRST102). The importers build rows from a labelled source
           where a column can simply be absent, so every row is filled out to
           the full column set with explicit nulls. Here that is right: an
           absent stat means unknown, and null is how this schema spells
           unknown. It is NOT a general rule — elsewhere in this project an
           omitted key is deliberate and padding it would overwrite state. */
        const payload = part.map((r) => {
          const o = { import_id: importId };
          for (const c of cols) o[c] = r[c] === undefined ? null : r[c];
          return o;
        });
        await db.insert(SCHEMA, rel, payload, { returning: false });
        n += part.length;
      }
      return n;
    },
    /* Named, because that is what PostgREST takes. Same arguments, same
       meaning, same order in the signature — see the note above. */
    async gate(fn, argOrder, args) {
      const payload = {};
      for (const k of argOrder) payload[k] = args[k] === undefined ? null : args[k];
      const res = await db.rpc(SCHEMA, fn, payload);
      /* PostgREST returns a scalar function's result bare, or wrapped in a
         single-element array depending on the accept profile. */
      const v = Array.isArray(res) ? res[0] : res;
      if (v && typeof v === 'object' && !Array.isArray(v) && v.ok === undefined
          && Object.keys(v).length === 1) {
        return v[Object.keys(v)[0]];
      }
      return typeof v === 'string' ? JSON.parse(v) : v;
    },
    async completedGames(season, limit) {
      const cap = limit > 0 ? `&limit=${Number(limit)}` : '';
      return db.select(SCHEMA, 'games',
        `select=game_id,season,game_date,home_team_id,away_team_id,home_name,away_name`
        + `&season=eq.${Number(season)}&completed=is.true&order=game_date.asc${cap}`);
    },
    async abandon(importId, reason) {
      await db.rpc(SCHEMA, 'abandon_cbb_import',
        { p_import_id: importId, p_reason: reason });
    },
    async startRun(row) {
      await db.insert(SCHEMA, 'import_runs', [row], { returning: false });
    },
  };
}

/* Wrap whatever it is given. A caller with a harness passes the harness; a
   caller in production passes nothing and gets Supabase from the environment. */
function wrap(db) {
  if (db && typeof db.sql === 'function' && typeof db.rows === 'function') return psqlAdapter(db);
  if (db && typeof db.rpc === 'function' && typeof db.insert === 'function') return pgrestAdapter(db);
  if (db && db.mode) return db;   /* already wrapped */
  throw new Error('cbb/db: this object is neither a psql harness (sql/rows) nor a '
    + 'PostgREST client (insert/rpc), so nothing can be written with it');
}

/* Production: the service role, from the environment, and a refusal to
   silently degrade to a no-op if it is absent. */
function createDb() {
  const P = require('../lib/pgrest.js');
  const cfg = P.config();
  if (!cfg) {
    throw new Error('EDGD_SB_SERVICE and EDGD_SB_URL are not both set, so nothing can be '
      + 'written. This is a missing credential, not an empty season.');
  }
  return pgrestAdapter(P.client(cfg));
}

module.exports = { SCHEMA, lit, chunk, wrap, createDb, psqlAdapter, pgrestAdapter };
