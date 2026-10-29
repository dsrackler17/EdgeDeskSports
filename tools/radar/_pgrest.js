'use strict';
/* ===========================================================================
   A PostgREST STAND-IN OVER A REAL POSTGRESQL, for the Radar function suite.

   tools/billing/_pgrest.js's approach (every call answered by SQL against a
   throwaway cluster from tools/personal/_pg.js), extended with the PostgREST
   features supabase/functions/polymarket_sync uses and the billing one does
   not: or=(...) filters, not.in.(...), resolution=ignore-duplicates, and
   order=<col>.<dir>.<nullsfirst|nullslast>. So the SHIPPED function writes
   into the SHIPPED supabase/radar.sql — its real grants, guards, checks and
   append-only triggers — rather than into a JavaScript imitation of them.

   The bearer token decides the role: the service key is service_role,
   anything else is anon. Only the calls the function makes are implemented.
   =========================================================================== */
const PG = require('../personal/_pg.js');
const lit = PG.lit;

function sqlValue(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object') return lit(JSON.stringify(v)) + '::jsonb';
  return lit(String(v));
}
const ident = (s) => {
  if (!/^[a-z_][a-z0-9_]*$/i.test(s)) throw new Error('bad identifier ' + s);
  return '"' + s + '"';
};
function splitTop(s) {
  const out = []; let depth = 0, cur = '', q = false;
  for (const ch of s) {
    if (ch === '"') q = !q;
    if (!q && ch === '(') depth++;
    if (!q && ch === ')') depth--;
    if (!q && depth === 0 && ch === ',') { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
const listOf = (inner) => splitTop(inner).map((x) => x.replace(/^"|"$/g, '').replace(/\\"/g, '"'));

/* one filter (col, op.value) as SQL, comparing as the column's own type */
function cond(col, v, types) {
  const c = ident(col), t = types[col] || 'text';
  if (v === 'not.is.null') return c + ' is not null';
  if (v === 'is.null') return c + ' is null';
  if (v === 'is.true' || v === 'is.false') return c + ' is ' + v.slice(3);
  let m = /^(not\.)?in\.\((.*)\)$/.exec(v);
  if (m) {
    const xs = listOf(m[2]);
    if (!xs.length) return m[1] ? 'true' : 'false';
    return c + (m[1] ? ' not in (' : ' in (') + xs.map((x) => lit(x) + '::' + t).join(', ') + ')';
  }
  m = /^(eq|neq|gt|gte|lt|lte)\.(.*)$/.exec(v);
  if (!m) throw new Error('unsupported filter ' + col + '=' + v);
  return c + ' ' + { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' }[m[1]] + ' ' + lit(m[2]) + '::' + t;
}
function filters(params, types) {
  const where = [];
  for (const [k, v] of params) {
    if (['select', 'limit', 'order', 'on_conflict', 'offset'].indexOf(k) >= 0) continue;
    if (k === 'or') {
      const parts = splitTop(v.replace(/^\(|\)$/g, '')).map((p) => { const i = p.indexOf('.'); return cond(p.slice(0, i), p.slice(i + 1), types); });
      where.push('(' + parts.join(' or ') + ')');
      continue;
    }
    where.push(cond(k, v, types));
  }
  return where;
}

function make(db, opts) {
  const o = opts || {};
  const SERVICE = o.serviceKey || 'service-key';
  const calls = [];
  const colTypes = {}, srf = {};
  const run = (role, sql) => (role === 'service' ? db.service(sql) : db.anon(sql));
  function types(table) {
    if (!colTypes[table]) colTypes[table] = JSON.parse(db.sql("select coalesce(json_object_agg(column_name, udt_name), '{}') from information_schema.columns where table_schema = 'public' and table_name = " + lit(table)) || '{}');
    return colTypes[table];
  }
  function isSrf(fn) {
    if (srf[fn] === undefined) srf[fn] = db.sql("select coalesce(bool_or(proretset), false) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = " + lit(fn)) === 't';
    return srf[fn];
  }
  const res = (status, body) => ({ ok: status >= 200 && status < 300, status,
    text: async () => (body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body))),
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body) });

  async function rest(url, init) {
    const u = new URL(url);
    const method = (init && init.method) || 'GET';
    const h = (init && init.headers) || {};
    const role = String(h.authorization || '').replace(/^Bearer\s+/i, '') === SERVICE ? 'service' : 'anon';
    const target = u.pathname.replace(/^\/rest\/v1\//, '');
    calls.push(method + ' ' + target);
    try {
      if (target.indexOf('rpc/') === 0) {
        const fn = target.slice(4);
        const args = init && init.body ? JSON.parse(init.body) : {};
        const call = 'public.' + ident(fn) + '(' + Object.keys(args).map((k) => ident(k) + ' => ' + sqlValue(args[k])).join(', ') + ')';
        const out = run(role, isSrf(fn) ? "select coalesce(json_agg(t), '[]'::json) from " + call + ' t;' : 'select to_jsonb(' + call + ');');
        return res(200, out === '' ? 'null' : out);
      }
      const table = target, t = types(table);
      if (!Object.keys(t).length) return res(404, { message: 'relation ' + table + ' does not exist' });
      const params = [...u.searchParams.entries()];
      if (method === 'GET') {
        const sel = u.searchParams.get('select') || '*';
        const cols = sel === '*' ? '*' : sel.split(',').map(ident).join(', ');
        const where = filters(params, t);
        const order = u.searchParams.get('order');
        const ord = order ? ' order by ' + order.split(',').map((x) => {
          const [c, d, n] = x.split('.');
          return ident(c) + (d === 'desc' ? ' desc' : ' asc') + (n === 'nullsfirst' ? ' nulls first' : n === 'nullslast' ? ' nulls last' : '');
        }).join(', ') : '';
        const lim = u.searchParams.get('limit'), off = u.searchParams.get('offset');
        return res(200, run(role, "select coalesce(json_agg(t), '[]'::json) from (select " + cols + ' from public.' + ident(table)
          + (where.length ? ' where ' + where.join(' and ') : '') + ord + (lim ? ' limit ' + (+lim) : '') + (off ? ' offset ' + (+off) : '') + ') t;'));
      }
      if (method === 'POST') {
        const list = [].concat(JSON.parse(init.body));
        if (!list.length) return res(201, '');
        const keys = [...new Set(list.flatMap((r) => Object.keys(r)))];
        const onc = u.searchParams.get('on_conflict');
        const prefer = String(h.prefer || '');
        const tail = !onc ? '' : /merge-duplicates/.test(prefer)
          ? ' on conflict (' + onc.split(',').map(ident).join(', ') + ') do update set ' + keys.filter((k) => onc.split(',').indexOf(k) < 0).map((k) => ident(k) + ' = excluded.' + ident(k)).join(', ')
          : /ignore-duplicates/.test(prefer) ? ' on conflict (' + onc.split(',').map(ident).join(', ') + ') do nothing' : '';
        run(role, 'insert into public.' + ident(table) + ' (' + keys.map(ident).join(', ') + ') select ' + keys.map(ident).join(', ')
          + ' from json_populate_recordset(null::public.' + ident(table) + ', ' + lit(JSON.stringify(list)) + ')' + tail + ';');
        return res(201, '');
      }
      if (method === 'PATCH') {
        const row = JSON.parse(init.body), keys = Object.keys(row), where = filters(params, t);
        const set = keys.map((k) => ident(k) + ' = r.' + ident(k)).join(', ');
        run(role, 'update public.' + ident(table) + ' set ' + set + ' from (select * from json_populate_record(null::public.' + ident(table) + ', ' + lit(JSON.stringify(row)) + ')) r'
          + (where.length ? ' where ' + where.map((w) => w.replace(/"([a-z_0-9]+)"/gi, 'public.' + ident(table) + '."$1"')).join(' and ') : '') + ';');
        return res(204, '');
      }
      return res(405, { message: 'method ' + method + ' is not used by polymarket_sync' });
    } catch (e) {
      const msg = String(e.sqlMessage || e.message || e);
      return res(/permission denied/i.test(msg) ? 403 : 400, { message: msg.split('\n').filter((l) => /ERROR/.test(l)).join(' ') || msg.slice(0, 300) });
    }
  }
  return { calls, SERVICE, fetch: (url, init) => rest(url, init), json(sql) { return JSON.parse(db.sql("select coalesce(json_agg(t), '[]'::json) from (" + sql + ') t;') || '[]'); } };
}
module.exports = { make };
