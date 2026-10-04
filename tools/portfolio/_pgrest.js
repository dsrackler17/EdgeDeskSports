'use strict';
/* ===========================================================================
   A POSTGREST STAND-IN FOR THE PORTFOLIO PAGE, OVER A REAL POSTGRESQL.

   The browser suite (portfolio_ui.e2e.js) drives the shipped page against the
   shipped migration: every request the page makes is answered by running SQL
   on a throwaway cluster (tools/personal/_pg.js) AS THE READER — role
   authenticated, auth.uid() from the bearer token — so row level security,
   the derive trigger, the composite keys and the import functions are the
   real ones, not a JavaScript imitation that could agree with itself.

   Only what the page uses: select= (columns, col::text casts, *), eq. / is.
   filters, order=a.desc,b.asc, limit, offset; POST (one row or many, from
   JSON, defaults kept for absent keys) with Prefer return=representation;
   PATCH and DELETE by filter; POST /rpc/<fn> with named arguments. Errors
   come back the way PostgREST shapes them: { code, message, details }.
   =========================================================================== */
const lit = require('../personal/_pg.js').lit;

const IDENT = /^[a-z_][a-z0-9_]*$/;
function ident(s) { if (!IDENT.test(s)) throw new Error('bad identifier ' + s); return '"' + s + '"'; }
function selectList(sel) {
  if (!sel || sel === '*') return '*';
  return sel.split(',').map((c) => {
    const m = /^([a-z_][a-z0-9_]*)(?:::(text))?$/.exec(c.trim());
    if (!m) throw new Error('unsupported select ' + c);
    return m[2] ? ident(m[1]) + '::text as ' + ident(m[1]) : ident(m[1]);
  }).join(', ');
}
function where(params) {
  const out = [];
  for (const [k, v] of params) {
    if (['select', 'limit', 'offset', 'order'].indexOf(k) >= 0) continue;
    const m = /^(eq|neq|is)\.(.*)$/.exec(v);
    if (!m) throw new Error('unsupported filter ' + k + '=' + v);
    if (m[1] === 'is') out.push(ident(k) + (m[2] === 'null' ? ' is null' : m[2] === 'true' ? ' is true' : m[2] === 'false' ? ' is false' : ' is not null'));
    else out.push(ident(k) + (m[1] === 'eq' ? ' = ' : ' <> ') + lit(m[2]));
  }
  return out.length ? ' where ' + out.join(' and ') : '';
}
function orderBy(o) {
  if (!o) return '';
  return ' order by ' + o.split(',').map((p) => {
    const m = /^([a-z_][a-z0-9_]*)(?:\.(asc|desc))?$/.exec(p.trim());
    if (!m) throw new Error('unsupported order ' + p);
    return ident(m[1]) + ' ' + (m[2] || 'asc');
  }).join(', ');
}
/* "ERROR:  23505: duplicate key …" (psql VERBOSITY verbose) → PostgREST's shape */
function pgError(text) {
  const lines = String(text).split('\n');
  const e = lines.map((l) => /ERROR:\s+([0-9A-Z]{5}):\s+(.*)$/.exec(l)).filter(Boolean)[0];
  const d = lines.map((l) => /DETAIL:\s+(.*)$/.exec(l)).filter(Boolean)[0];
  const code = e ? e[1] : 'XX000';
  const status = code === '23505' ? 409 : code === '42501' ? 403 : code === 'P0002' ? 404 : code === '42P01' ? 404 : 400;
  return { status, body: { code, message: e ? e[2] : String(text).slice(0, 300), details: d ? d[1] : null, hint: null } };
}

function make(db, opts) {
  const o = opts || {};
  const tokens = o.tokens || {};
  const log = [];
  function run(uid, sql) {
    const text = '\\set VERBOSITY verbose\n' + sql;
    return uid ? db.as(uid, text) : db.anon(text);
  }
  function handle(method, rawPath, query, body, prefer, token) {
    const uid = tokens[token] || null;
    const params = new URLSearchParams(query || '');
    log.push({ method, path: rawPath, query, body });
    try {
      const rpc = /^rpc\/([a-z_][a-z0-9_]*)$/.exec(rawPath);
      if (rpc) {
        const args = Object.keys(body || {}).map((k) => ident(k) + ' => ' + (body[k] === null ? 'null'
          : lit(typeof body[k] === 'object' ? JSON.stringify(body[k]) : String(body[k])))).join(', ');
        const out = run(uid, `select coalesce(to_json(public.${ident(rpc[1])}(${args})), 'null'::json);`);
        return { status: 200, body: out ? JSON.parse(out) : null };
      }
      const table = 'public.' + ident(rawPath);
      if (method === 'GET') {
        const lim = params.get('limit') ? ' limit ' + (+params.get('limit')) : '';
        const off = params.get('offset') ? ' offset ' + (+params.get('offset')) : '';
        const out = run(uid, `select coalesce(json_agg(t), '[]'::json) from (select ${selectList(params.get('select'))} from ${table}${where(params)}${orderBy(params.get('order'))}${lim}${off}) t;`);
        return { status: 200, body: JSON.parse(out || '[]') };
      }
      if (method === 'POST') {
        const rows = Array.isArray(body) ? body : [body];
        const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((k) => IDENT.test(k));
        const cols = keys.map(ident).join(', ');
        const json = lit(JSON.stringify(rows));
        const rep = /return=representation/.test(prefer || '');
        const sql = `with ins as (insert into ${table} (${cols}) select ${cols} from json_populate_recordset(null::${table}, ${json}) returning *)
                     select ${rep ? `coalesce(json_agg(t), '[]'::json) from (select ${selectList(params.get('select'))} from ins) t` : `count(*) from ins`};`;
        const out = run(uid, sql);
        return { status: 201, body: rep ? JSON.parse(out) : null };
      }
      if (method === 'PATCH') {
        const keys = Object.keys(body || {}).filter((k) => IDENT.test(k));
        const cols = keys.map(ident).join(', ');
        const sql = `update ${table} set (${cols}) = (select ${cols} from json_populate_record(null::${table}, ${lit(JSON.stringify(body))}))${where(params)};`;
        run(uid, keys.length === 1 ? sql.replace(/set \(([^)]+)\) = \(select ([^)]+?) from/, 'set $1 = (select $2 from') : sql);
        return { status: 204, body: null };
      }
      if (method === 'DELETE') {
        run(uid, `delete from ${table}${where(params)};`);
        return { status: 204, body: null };
      }
      return { status: 405, body: { code: 'PGRST', message: 'method not supported here' } };
    } catch (e) {
      return pgError(e.sqlMessage || e.message);
    }
  }
  return { handle, log };
}

module.exports = { make, pgError };
