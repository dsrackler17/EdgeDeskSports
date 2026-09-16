#!/usr/bin/env node
/* ===========================================================================
   EdgeDesk MLB — a PostgREST-shaped client over psql. FOR TESTS ONLY.

   WHY THIS EXISTS. tools/lib/fake_pgrest.js stands in for the transport, which
   is enough to drive a pipeline and count rows — but it cannot run the promote
   gate, because the gate is a PL/pgSQL function with the whole point of the
   import inside it. Re-implementing that function in JavaScript to test it
   would mean testing the re-implementation.

   So this speaks the same small API the jobs use (select / selectAll / insert /
   upsert / patch / del / rpc) and answers every call by running real SQL
   against a real PostgreSQL. The importer, the promote gate, the constraints,
   the RLS grants and the query layer's own PostgREST strings are all exercised
   as shipped.

   It translates only the PostgREST grammar this project actually emits — the
   filters and ordering in lib/mlb_pitcher_history.js QUERIES and the writes in
   import_pitcher_history.js. Anything outside that throws rather than guessing,
   because a silently mistranslated filter is a test that proves nothing.
   =========================================================================== */
'use strict';
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/* A dollar-quote tag that cannot appear inside JSON, so a value carrying
   quotes, newlines or a semicolon cannot escape its literal. */
const TAG = '$edgjson$';

function ident(name) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(String(name))) throw new Error(`unsafe identifier: ${name}`);
  return String(name);
}
function lit(v) {
  if (v == null) return 'null';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return "'" + String(v).replace(/'/g, "''") + "'";
}

/* ---- PostgREST filter grammar -> SQL ------------------------------------ */

function decodeInList(s) {
  return String(s).replace(/^\(|\)$/g, '').split(',')
    .map(x => x.trim().replace(/^"|"$/g, ''))
    .filter(x => x !== '');
}
/* PostgREST spells the wildcard '*' in like/ilike and hands SQL '%'. */
function likePattern(v) { return String(v).replace(/\*/g, '%'); }

function filterSql(col, expr, prefix) {
  const c = (prefix ? prefix + '.' : '') + ident(col);
  let negate = false, rest = String(expr);
  if (rest.startsWith('not.')) { negate = true; rest = rest.slice(4); }
  const m = /^(eq|neq|gt|gte|lt|lte|in|is|like|ilike)\.([\s\S]*)$/.exec(rest);
  if (!m) throw new Error(`unsupported filter: ${col}=${expr}`);
  const op = m[1], val = m[2];
  let sql;
  switch (op) {
    case 'eq':  sql = `${c} = ${lit(val)}`; break;
    case 'neq': sql = `${c} <> ${lit(val)}`; break;
    case 'gt':  sql = `${c} > ${lit(val)}`; break;
    case 'gte': sql = `${c} >= ${lit(val)}`; break;
    case 'lt':  sql = `${c} < ${lit(val)}`; break;
    case 'lte': sql = `${c} <= ${lit(val)}`; break;
    case 'in': {
      const vals = decodeInList(val);
      sql = vals.length ? `${c} in (${vals.map(lit).join(',')})` : 'false';
      break;
    }
    case 'is':
      sql = val === 'null' ? `${c} is null` : `${c} is ${val === 'true' ? 'true' : 'false'}`;
      break;
    case 'like':  sql = `${c} like ${lit(likePattern(val))}`; break;
    case 'ilike': sql = `${c} ilike ${lit(likePattern(val))}`; break;
    default: throw new Error(`unsupported operator: ${op}`);
  }
  /* PostgREST's `not.` negates the whole predicate, and NOT (x is null) is
     what `not.is.null` means — not `x is not null` by accident of precedence,
     though here they coincide. Written out so the intent is on the page. */
  return negate ? `not (${sql})` : sql;
}

function parseQuery(q, prefix) {
  const out = { select: '*', filters: [], order: [], limit: null, offset: null };
  String(q || '').split('&').forEach(part => {
    if (!part) return;
    const i = part.indexOf('=');
    if (i < 0) return;
    const k = decodeURIComponent(part.slice(0, i));
    const v = decodeURIComponent(part.slice(i + 1));
    if (k === 'select') { out.select = v; return; }
    if (k === 'limit') { out.limit = Number(v); return; }
    if (k === 'offset') { out.offset = Number(v); return; }
    if (k === 'on_conflict') { out.onConflict = v; return; }
    if (k === 'order') {
      v.split(',').forEach(spec => {
        const m = /^([a-zA-Z_][a-zA-Z0-9_]*)(?:\.(asc|desc))?(?:\.(nullsfirst|nullslast))?$/.exec(spec.trim());
        if (!m) throw new Error(`unsupported order: ${spec}`);
        out.order.push(`${ident(m[1])} ${m[2] === 'desc' ? 'desc' : 'asc'}`
          + (m[3] ? (m[3] === 'nullslast' ? ' nulls last' : ' nulls first') : ''));
      });
      return;
    }
    out.filters.push(filterSql(k, v, prefix));
  });
  return out;
}

function selectList(sel) {
  if (!sel || sel === '*') return '*';
  return sel.split(',').map(s => ident(s.trim())).join(', ');
}

/* ---- the client --------------------------------------------------------- */

function pgClient(conn, opts) {
  opts = opts || {};
  const stats = { requests: 0, writes: 0 };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edg-pg-'));
  let seq = 0;

  function run(sql, wantJson) {
    stats.requests++;
    const file = path.join(dir, `q${++seq}.sql`);
    fs.writeFileSync(file, sql);
    const args = conn.concat(['-d', opts.database || 'postgres', '-v', 'ON_ERROR_STOP=1', '-tA', '-f', file]);
    const r = cp.spawnSync('psql', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    try { fs.unlinkSync(file); } catch (_) { /* best effort */ }
    if (r.status !== 0) {
      const msg = (r.stderr || '').trim().split('\n').filter(l => /ERROR|DETAIL/.test(l)).join(' | ') || (r.stderr || '').trim();
      const err = new Error(msg.slice(0, 600));
      err.postgrest = true;
      err.status = /does not exist|permission denied/i.test(msg) ? 404 : 400;
      throw err;
    }
    if (!wantJson) return [];
    const text = (r.stdout || '').trim();
    if (!text) return [];
    try { return JSON.parse(text); } catch (e) { throw new Error(`could not parse result: ${text.slice(0, 200)}`); }
  }

  /** Every read comes back as one JSON array, exactly as PostgREST answers. */
  function query(schema, rel, q) {
    const p = parseQuery(q);
    let sql = `select coalesce(json_agg(t), '[]'::json) from (select ${selectList(p.select)} from ${ident(schema)}.${ident(rel)}`;
    if (p.filters.length) sql += ' where ' + p.filters.join(' and ');
    if (p.order.length) sql += ' order by ' + p.order.join(', ');
    if (p.limit != null) sql += ` limit ${Number(p.limit)}`;
    if (p.offset != null) sql += ` offset ${Number(p.offset)}`;
    sql += ') t;';
    return run(sql, true);
  }

  /** Columns present on the rows; missing columns take their table default. */
  function columnsOf(rows) {
    const seen = [];
    rows.forEach(r => Object.keys(r).forEach(k => { if (seen.indexOf(k) < 0) seen.push(k); }));
    return seen.map(ident);
  }

  function insertSql(schema, rel, rows) {
    const cols = columnsOf(rows);
    const json = JSON.stringify(rows.map(r => {
      const o = {};
      cols.forEach(c => { o[c] = r[c] === undefined ? null : r[c]; });
      return o;
    }));
    return `insert into ${ident(schema)}.${ident(rel)} (${cols.join(', ')})\n`
      + `select ${cols.join(', ')} from json_populate_recordset(null::${ident(schema)}.${ident(rel)}, ${TAG}${json}${TAG}::json);`;
  }

  return {
    stats,
    cfg: { url: 'psql://' + (opts.database || 'postgres'), key: 'local' },
    async select(schema, rel, q) { return query(schema, rel, q); },
    async selectAll(schema, rel, q, pageSize, maxPages) {
      pageSize = pageSize || 1000; maxPages = maxPages || 60;
      const out = [];
      for (let p = 0; p < maxPages; p++) {
        const rows = query(schema, rel, `${q}&limit=${pageSize}&offset=${p * pageSize}`);
        if (!rows.length) break;
        out.push(...rows);
        if (rows.length < pageSize) break;
      }
      return out;
    },
    async insert(schema, rel, rows) {
      if (!rows || !rows.length) return [];
      stats.writes++;
      run(insertSql(schema, rel, rows), false);
      return [];
    },
    async upsert(schema, rel, rows, onConflict) {
      if (!rows || !rows.length) return [];
      stats.writes++;
      const cols = columnsOf(rows);
      const keys = String(onConflict || '').split(',').map(s => ident(s.trim())).filter(Boolean);
      const setCols = cols.filter(c => keys.indexOf(c) < 0);
      let sql = insertSql(schema, rel, rows).replace(/;\s*$/, '');
      if (keys.length) {
        sql += `\non conflict (${keys.join(', ')}) do `
          + (setCols.length ? `update set ${setCols.map(c => `${c} = excluded.${c}`).join(', ')}` : 'nothing');
      }
      run(sql + ';', false);
      return [];
    },
    async patch(schema, rel, q, body) {
      stats.writes++;
      /* The row source `s` carries every column of the same table, so an
         unqualified filter would be ambiguous. Filters are built against the
         target alias `t` from the start rather than rewritten afterwards. */
      const p = parseQuery(q, 't');
      const cols = Object.keys(body).map(ident);
      const json = JSON.stringify(body);
      let sql = `update ${ident(schema)}.${ident(rel)} t set `
        + cols.map(c => `${c} = s.${c}`).join(', ')
        + `\nfrom json_populate_record(null::${ident(schema)}.${ident(rel)}, ${TAG}${json}${TAG}::json) s`;
      if (p.filters.length) sql += ' where ' + p.filters.join(' and ');
      run(sql + ';', false);
      return [];
    },
    async del(schema, rel, q) {
      stats.writes++;
      const p = parseQuery(q);
      let sql = `delete from ${ident(schema)}.${ident(rel)}`;
      if (p.filters.length) sql += ' where ' + p.filters.join(' and ');
      run(sql + ';', false);
      return [];
    },
    async rpc(schema, fn, args) {
      stats.writes++;
      const names = Object.keys(args || {});
      const call = names.map(n => `${ident(n)} => ${lit(args[n])}`).join(', ');
      return run(`select json_agg(r) from (select ${ident(schema)}.${ident(fn)}(${call}) as x) q,`
        + ` lateral (select q.x) r(x);`, true).map(r => r.x);
    },
    /** Straight SQL, for a test that wants to assert on the database itself. */
    sql(text) { return run(text, false); },
    rows(text) { return run(`select coalesce(json_agg(t), '[]'::json) from (${text.replace(/;\s*$/, '')}) t;`, true); },
    close() { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ } }
  };
}

/* ---- finding a server, the same way the other SQL suites do -------------- */

function candidates() {
  const out = [];
  if (process.env.EDGD_PG) out.push(process.env.EDGD_PG.split(' '));
  if (process.env.PGHOST) out.push([]);
  out.push(['-h', '/var/tmp/edgpg/sock', '-p', '5433', '-U', 'postgres']);
  out.push(['-h', '127.0.0.1', '-p', '5432', '-U', 'postgres']);
  out.push([]);
  return out;
}
function findServer() {
  const have = cp.spawnSync('sh', ['-c', 'command -v psql'], { encoding: 'utf8' }).status === 0;
  if (!have) return null;
  for (const c of candidates()) {
    if (cp.spawnSync('psql', c.concat(['-d', 'postgres', '-tAc', 'select 1']), { encoding: 'utf8' }).status === 0) return c;
  }
  return null;
}
function createDatabase(conn, name) {
  cp.spawnSync('psql', conn.concat(['-d', 'postgres', '-q', '-c', `drop database if exists ${ident(name)} (force)`]), { encoding: 'utf8' });
  const r = cp.spawnSync('psql', conn.concat(['-d', 'postgres', '-q', '-c', `create database ${ident(name)}`]), { encoding: 'utf8' });
  return r.status === 0;
}
function dropDatabase(conn, name) {
  cp.spawnSync('psql', conn.concat(['-d', 'postgres', '-q', '-c', `drop database if exists ${ident(name)} (force)`]), { encoding: 'utf8' });
}
function applyFile(conn, database, file) {
  const r = cp.spawnSync('psql', conn.concat(['-d', database, '-v', 'ON_ERROR_STOP=1', '-q', '-f', file]), { encoding: 'utf8' });
  return { ok: r.status === 0, stderr: (r.stderr || '').trim() };
}

module.exports = { pgClient, parseQuery, filterSql, findServer, createDatabase, dropDatabase, applyFile };
