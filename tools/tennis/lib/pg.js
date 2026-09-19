#!/usr/bin/env node
/* ===========================================================================
   EdgeDesk Tennis — the DIRECT database door, for bulk work only.

   WHY THIS EXISTS AND WHY IT IS NOT PostgREST. Every other tennis job writes
   through tools/lib/pgrest.js, which is right for hundreds of rows and wrong
   for hundreds of thousands: 361,571 matches is 723,000 feature rows and
   ~15,500 players, and pushing that through the REST API is nine hundred
   round trips on a good day and a rate-limited afternoon on a normal one.
   An Edge Function is worse — a 120 MB compressed archive does not fit in its
   memory or its wall clock, and a backfill that dies halfway through a
   function invocation leaves nothing to resume from.

   So the backfill is a LOCAL ADMINISTRATIVE JOB with a direct connection, run
   by an operator or a CI job that already holds the database URL. It speaks
   psql, which every environment that can run a migration already has, and it
   uses COPY, which is the only sane way to move this many rows.

   THE CREDENTIAL NEVER LEAVES THIS PROCESS. It comes from the environment
   (SUPABASE_DB_URL / DATABASE_URL / EDGD_PG), is passed to psql through the
   environment rather than the command line — a connection string on argv is
   visible in `ps` to every user on the box — and is redacted from every error
   this module raises.
   =========================================================================== */
'use strict';
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function redact(s) {
  return String(s == null ? '' : s)
    .replace(/postgres(?:ql)?:\/\/[^\s'"]*/gi, 'postgresql://<redacted>')
    .replace(/(password=)[^\s&'"]*/gi, '$1<redacted>');
}

/* How to reach the database, in the order an operator would expect.
   Returns {mode:'url'|'args', url?, args?} or null. */
function resolveConnection(env) {
  env = env || process.env;
  const url = String(env.SUPABASE_DB_URL || env.DATABASE_URL || env.EDGD_DB_URL || '').trim();
  if (url) return { mode: 'url', url };
  const pg = String(env.EDGD_PG || '').trim();
  if (pg) return { mode: 'args', args: pg.split(/\s+/).filter(Boolean) };
  if (env.PGHOST || env.PGDATABASE) return { mode: 'args', args: [] };
  return null;
}

function have(bin) {
  return cp.spawnSync('sh', ['-c', 'command -v ' + bin], { encoding: 'utf8' }).status === 0;
}

function client(conn, opts) {
  opts = opts || {};
  const db = opts.database || null;
  if (!have('psql')) throw new Error('psql is not installed — the bulk importer needs it');

  function baseArgs() {
    const a = ['-v', 'ON_ERROR_STOP=1', '--no-psqlrc'];
    if (conn.mode === 'url') a.push(conn.url);
    else { a.push(...conn.args); if (db) a.push('-d', db); }
    return a;
  }
  /* The URL form carries the database inside it; -d after it is ignored by
     psql and would be confusing, so the two forms are kept apart. */
  function run(args, input, o) {
    o = o || {};
    const r = cp.spawnSync('psql', baseArgs().concat(args), {
      encoding: 'utf8',
      input: input == null ? undefined : input,
      maxBuffer: o.maxBuffer || 256 * 1024 * 1024,
      env: Object.assign({}, process.env, { PGAPPNAME: 'edgedesk-tennis-import' })
    });
    if (r.error) throw new Error('psql: ' + redact(r.error.message));
    if (r.status !== 0) {
      const err = new Error('psql exited ' + r.status + ': ' + redact((r.stderr || '').trim().split('\n').slice(0, 6).join(' | ')));
      err.stderr = redact(r.stderr || '');
      err.sqlstate = (/ERROR:\s+(\w{5}):/.exec(r.stderr || '') || [])[1] || null;
      throw err;
    }
    return { stdout: r.stdout || '', stderr: r.stderr || '' };
  }

  return {
    redact,
    /* A statement or script, no result wanted. */
    exec(sql) { return run(['-q', '-c', sql]).stdout; },
    execFile(file, vars) {
      const a = ['-q'];
      Object.keys(vars || {}).forEach((k) => a.push('-v', k + '=' + vars[k]));
      a.push('-f', file);
      return run(a).stdout;
    },
    /* One value. psql prints the command tag ("INSERT 0 1") after the result
       of a data-modifying statement with RETURNING, so the FIRST non-empty
       line is the value and everything after it is psql talking. Taking
       .trim() on the whole output silently concatenated the two. */
    scalar(sql) {
      const out = run(['-tA', '-c', sql]).stdout.split('\n')
        .map((l) => l.trim()).filter((l) => l.length > 0);
      return out.length ? out[0] : '';
    },
    /* Rows as objects, via PostgreSQL's own JSON so nothing has to be parsed
       out of psql's table formatting. */
    rows(sql) {
      const out = run(['-tA', '-c',
        "select coalesce(json_agg(t), '[]'::json)::text from (" + sql.replace(/;\s*$/, '') + ') t']).stdout.trim();
      if (!out) return [];
      try { return JSON.parse(out); } catch (e) { throw new Error('unreadable result: ' + out.slice(0, 200)); }
    },
    /* COPY ... FROM STDIN. `lines` is pre-escaped TEXT format (see lib/csv.js).
       Written to a temp file and streamed with \copy rather than handed to psql
       on stdin in one string, so a 50,000-row chunk does not have to exist
       twice in this process's heap. */
    copyFrom(table, columns, lines, tmpDir) {
      const dir = tmpDir || fs.mkdtempSync(path.join(os.tmpdir(), 'edgd-tennis-'));
      const f = path.join(dir, 'chunk.tsv');
      fs.writeFileSync(f, lines);
      try {
        return run(['-q', '-c',
          "\\copy " + table + ' (' + columns.join(',') + ") from '" + f + "' with (format text, null '\\N')"]).stdout;
      } finally {
        try { fs.unlinkSync(f); } catch (_) {}
        if (!tmpDir) { try { fs.rmdirSync(dir); } catch (_) {} }
      }
    },
    /* A transaction around a callback that only issues exec/copyFrom. psql is
       a new process per call, so a transaction has to be one call: the caller
       builds the statements and this wraps them. */
    transaction(statements) {
      const sql = ['begin;'].concat(statements).concat(['commit;']).join('\n');
      return run(['-q', '-c', sql]).stdout;
    },
    /* A whole script in ONE psql session, which is the only way to get a
       transaction that contains \copy: psql is a new process per invocation,
       so begin/copy/insert/commit has to be one file. This is what makes a
       chunk atomic — a chunk either lands whole or not at all, and a resumed
       run never has to reason about half a chunk. */
    script(lines, tmpDir) {
      const dir = tmpDir || fs.mkdtempSync(path.join(os.tmpdir(), 'edgd-tennis-'));
      const f = path.join(dir, 'chunk.sql');
      fs.writeFileSync(f, Array.isArray(lines) ? lines.join('\n') + '\n' : String(lines));
      try { return run(['-q', '-f', f]).stdout; }
      finally { try { fs.unlinkSync(f); } catch (_) {} if (!tmpDir) { try { fs.rmdirSync(dir); } catch (_) {} } }
    },
    ping() {
      try { return run(['-tA', '-c', 'select 1']).stdout.trim() === '1'; }
      catch (_) { return false; }
    }
  };
}

/* A SQL string literal. Used only for values this process itself produced
   (ids, counts, timestamps); nothing from the source file is ever interpolated
   — source rows go through COPY, which does not parse SQL at all. */
function lit(v) {
  if (v == null) return 'null';
  if (typeof v === 'number') return isFinite(v) ? String(v) : 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return "'" + String(v).replace(/'/g, "''") + "'";
}

module.exports = { resolveConnection, client, lit, redact, have };
