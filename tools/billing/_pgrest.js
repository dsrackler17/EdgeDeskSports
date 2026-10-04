'use strict';
/* ===========================================================================
   A PostgREST AND SUPABASE AUTH STAND-IN, OVER A REAL POSTGRESQL.

   The billing Edge Functions talk to the database only through PostgREST
   (tables and /rpc) and to Supabase Auth only through /auth/v1/user and
   /auth/v1/admin/users/<id>. This answers exactly those calls by running SQL
   against a throwaway cluster from tools/personal/_pg.js — so a scenario test
   drives the SHIPPED functions against the SHIPPED migration, with its real
   grants, RLS, row locks and security-definer functions, rather than against
   a JavaScript imitation of them that could agree with itself and nothing else.

   The bearer token decides the role, the way PostgREST does:
     the service key            -> service_role
     a token from tokens{}      -> authenticated, with auth.uid() = that user
     anything else (anon key)   -> anon

   Only the PostgREST features the functions use are implemented: select=,
   eq./gt./lt./is.null filters, order=, limit=, on_conflict= with
   merge-duplicates, PATCH with filters, and /rpc with named arguments.
   =========================================================================== */
const PG = require('../personal/_pg.js');
const lit = PG.lit;

function sqlValue(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) {
    if (v.every((x) => typeof x === 'string')) return 'ARRAY[' + v.map(lit).join(',') + ']::text[]';
    return lit(JSON.stringify(v)) + '::jsonb';
  }
  if (typeof v === 'object') return lit(JSON.stringify(v)) + '::jsonb';
  return lit(String(v));
}
const ident = (s) => {
  if (!/^[a-z_][a-z0-9_]*$/i.test(s)) throw new Error('bad identifier ' + s);
  return '"' + s + '"';
};

/* comparisons on timestamps must compare as timestamps, not text */
function typedFilters(params, types) {
  const where = [];
  for (const [k, v] of params) {
    if (['select', 'limit', 'order', 'on_conflict', 'offset'].indexOf(k) >= 0) continue;
    const m = /^(eq|neq|gt|gte|lt|lte|is)\.(.*)$/.exec(v);
    if (!m) throw new Error('unsupported filter ' + k + '=' + v);
    const col = ident(k);
    if (m[1] === 'is') { where.push(col + (m[2] === 'null' ? ' is null' : ' is not null')); continue; }
    const op = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' }[m[1]];
    const t = types[k] || 'text';
    where.push(col + ' ' + op + ' ' + lit(m[2]) + '::' + t);
  }
  return where;
}

function make(db, opts) {
  const o = opts || {};
  const SERVICE = o.serviceKey || 'service-key';
  const ANON = o.anonKey || 'anon-key';
  const tokens = o.tokens || {};
  const calls = [];
  let failNext = {};               // { 'rpc/billing_apply_subscription_state': 2 }
  const colTypes = {};
  const srf = {};

  function run(role, uid, sql) {
    if (role === 'service') return db.service(sql);
    if (role === 'user') return db.as(uid, sql);
    return db.anon(sql);
  }
  function types(table) {
    if (colTypes[table]) return colTypes[table];
    const out = db.sql("select coalesce(json_object_agg(column_name, udt_name), '{}') from information_schema.columns " +
      "where table_schema = 'public' and table_name = " + lit(table));
    colTypes[table] = JSON.parse(out || '{}');
    return colTypes[table];
  }
  function isSrf(fn) {
    if (srf[fn] === undefined) srf[fn] = db.sql("select coalesce(bool_or(proretset), false) from pg_proc p join pg_namespace n " +
      "on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = " + lit(fn)) === 't';
    return srf[fn];
  }
  const res = (status, body) => ({
    ok: status >= 200 && status < 300, status,
    text: async () => (body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body))),
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  });

  async function rest(url, init) {
    const u = new URL(url);
    const method = (init && init.method) || 'GET';
    const h = (init && init.headers) || {};
    const auth = String(h.authorization || h.Authorization || '').replace(/^Bearer\s+/i, '');
    let role = 'anon', uid = null;
    if (auth === SERVICE) role = 'service';
    else if (tokens[auth]) { role = 'user'; uid = tokens[auth].id; }
    const target = u.pathname.replace(/^\/rest\/v1\//, '');
    calls.push(method + ' ' + target);
    if (failNext[target] > 0) { failNext[target]--; return res(503, { message: 'injected failure' }); }
    try {
      if (target.indexOf('rpc/') === 0) {
        const fn = target.slice(4);
        const args = init && init.body ? JSON.parse(init.body) : {};
        const argSql = Object.keys(args).map((k) => ident(k) + ' => ' + sqlValue(args[k])).join(', ');
        const call = 'public.' + ident(fn) + '(' + argSql + ')';
        const sql = isSrf(fn)
          ? "select coalesce(json_agg(t), '[]'::json) from " + call + ' t;'
          : 'select to_jsonb(' + call + ');';
        const out = run(role, uid, sql);
        return res(200, out === '' ? 'null' : out);
      }
      const table = target;
      const t = types(table);
      if (!Object.keys(t).length) return res(404, { message: 'relation ' + table + ' does not exist' });
      const params = [...u.searchParams.entries()];
      if (method === 'GET') {
        const sel = u.searchParams.get('select') || '*';
        const cols = sel === '*' ? '*' : sel.split(',').map(ident).join(', ');
        const where = typedFilters(params, t);
        const order = u.searchParams.get('order');
        let ord = '';
        if (order) {
          const [c, d] = order.split('.');
          ord = ' order by ' + ident(c) + (d === 'desc' ? ' desc' : ' asc');
        }
        const lim = u.searchParams.get('limit');
        const sql = "select coalesce(json_agg(t), '[]'::json) from (select " + cols + ' from public.' + ident(table) +
          (where.length ? ' where ' + where.join(' and ') : '') + ord + (lim ? ' limit ' + (+lim) : '') + ') t;';
        return res(200, run(role, uid, sql));
      }
      if (method === 'POST') {
        const rows = JSON.parse(init.body);
        const list = Array.isArray(rows) ? rows : [rows];
        const keys = [...new Set(list.flatMap((r) => Object.keys(r)))];
        const onc = u.searchParams.get('on_conflict');
        const merge = /merge-duplicates/.test(String(h.prefer || ''));
        const sql = 'insert into public.' + ident(table) + ' (' + keys.map(ident).join(', ') + ') select ' +
          keys.map(ident).join(', ') + ' from json_populate_recordset(null::public.' + ident(table) + ', ' +
          lit(JSON.stringify(list)) + ')' +
          (onc && merge ? ' on conflict (' + onc.split(',').map(ident).join(', ') + ') do update set ' +
            keys.filter((k) => onc.split(',').indexOf(k) < 0).map((k) => ident(k) + ' = excluded.' + ident(k)).join(', ') : '') + ';';
        run(role, uid, sql);
        return res(201, '');
      }
      if (method === 'PATCH') {
        const row = JSON.parse(init.body);
        const keys = Object.keys(row);
        const where = typedFilters(params, t);
        const sql = 'update public.' + ident(table) + ' set (' + keys.map(ident).join(', ') + ') = (select ' +
          keys.map(ident).join(', ') + ' from json_populate_record(null::public.' + ident(table) + ', ' +
          lit(JSON.stringify(row)) + '))' + (where.length ? ' where ' + where.join(' and ') : '') + ';';
        // a one-column update needs ROW(...) syntax in PostgreSQL
        const fixed = keys.length === 1 ? sql.replace('set (' + ident(keys[0]) + ') = (select', 'set ' + ident(keys[0]) + ' = (select') : sql;
        run(role, uid, fixed);
        return res(204, '');
      }
      return res(405, { message: 'method' });
    } catch (e) {
      const msg = String(e.sqlMessage || e.message || e);
      const status = /permission denied|42501|not authorized/i.test(msg) ? 403 : 400;
      return res(status, { message: msg.split('\n').filter((l) => /ERROR/.test(l)).join(' ') || msg.slice(0, 300) });
    }
  }

  async function auth(url, init) {
    const u = new URL(url);
    const h = (init && init.headers) || {};
    const bearer = String(h.authorization || '').replace(/^Bearer\s+/i, '');
    if (u.pathname === '/auth/v1/user') {
      const t = tokens[bearer];
      if (!t) return res(401, { message: 'invalid token' });
      return res(200, { id: t.id, email: t.email, email_confirmed_at: t.confirmed === false ? null : '2026-01-01T00:00:00Z' });
    }
    const m = /^\/auth\/v1\/admin\/users\/([0-9a-f-]{36})$/.exec(u.pathname);
    if (m) {
      if (bearer !== SERVICE) return res(401, { message: 'service role required' });
      const out = db.sql("select coalesce(json_agg(t), '[]'::json) from (select id, email, email_confirmed_at from auth.users where id = " +
        lit(m[1]) + ') t;');
      const rows = JSON.parse(out || '[]');
      return rows[0] ? res(200, rows[0]) : res(404, { message: 'not found' });
    }
    return res(404, { message: 'not found' });
  }

  return {
    calls, tokens, SERVICE, ANON,
    fail(target, n) { failNext[target] = n == null ? 1 : n; },
    async fetch(url, init) {
      const p = new URL(url).pathname;
      if (p.indexOf('/rest/v1/') === 0) return rest(url, init);
      if (p.indexOf('/auth/v1/') === 0) return auth(url, init);
      return res(404, { message: 'no route ' + p });
    },
    json(sql) { const out = db.sql('select coalesce(json_agg(t), \'[]\'::json) from (' + sql + ') t;'); return JSON.parse(out || '[]'); },
  };
}

module.exports = { make, sqlValue };
