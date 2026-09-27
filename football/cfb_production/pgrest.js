/* ============================================================================
   A PostgREST stand-in for the CFB production tests: a `fetch` that turns the
   exact requests the mirrors and job clients send into SQL on a throwaway
   PostgreSQL (tools/personal/_pg.js), and turns Postgres errors back into the
   HTTP answers PostgREST gives:

     POST /rest/v1/<table>?on_conflict=<cols>   Prefer: resolution=ignore-duplicates
        -> insert into <table> (<payload columns>) select ... from
           jsonb_populate_recordset(...) on conflict (<cols>) do nothing
           (ONE statement, ONE transaction — what PostgREST does)
     POST /rest/v1/rpc/<fn>                     named arguments
        -> select to_jsonb(public.<fn>(p_a => ..., ...))

   Errors: psql runs with VERBOSITY verbose, so "ERROR:  40P01: deadlock
   detected" carries its SQLSTATE; the status follows PostgREST's table
   (23505 -> 409, 42P01 -> 404, 40P01 / 55P03 / 57014 -> 500, P0001 -> 400 ...)
   and the body is PostgREST's { code, message, details, hint }.

   Hooks for chaos tests:
     opts.preamble(table|rpc, attempt) -> SQL run first, inside the same
       transaction (e.g. take row locks in an order that deadlocks with a
       background session, or set lock_timeout)
     opts.fault(table|rpc, attempt)    -> { status, body } answered instead
   Every request is counted in .calls.
   ========================================================================== */
'use strict';
const PG = require('../../tools/personal/_pg.js');

const lit = PG.lit;

function httpStatus(code) {
  if (!code) return 500;
  if (/^23503$/.test(code) || /^23505$/.test(code)) return 409;
  if (/^23/.test(code)) return 400;
  if (code === '42P01' || code === '42883') return 404;
  if (code === '42501') return 403;
  if (/^28/.test(code)) return 403;
  if (/^08/.test(code) || /^53/.test(code)) return 503;
  if (code === 'P0001') return 400;
  if (/^(40|55|57|25|P0|XX|38|39|3B)/.test(code)) return 500;
  if (/^22/.test(code) || /^42/.test(code)) return 400;
  return 400;
}

function sqlValue(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'object') return lit(JSON.stringify(v));
  return lit(String(v));
}

function response(status, bodyText, headers) {
  return {
    ok: status >= 200 && status < 300, status,
    text: async () => bodyText || '',
    json: async () => JSON.parse(bodyText || 'null'),
    headers: { get: (k) => (headers || {})[String(k).toLowerCase()] || null },
  };
}

function makeFetch(db, opts) {
  opts = opts || {};
  const attempts = {};
  const calls = [];
  async function f(url, init) {
    const u = new URL(url);
    const p = u.pathname.replace(/^\/rest\/v1\//, '');
    const target = p.startsWith('rpc/') ? p : p;
    attempts[target] = (attempts[target] || 0) + 1;
    const attempt = attempts[target];
    calls.push({ target, attempt, method: (init && init.method) || 'GET' });
    const fault = opts.fault && opts.fault(target, attempt);
    if (fault) return response(fault.status, typeof fault.body === 'string' ? fault.body : JSON.stringify(fault.body || {}), fault.headers);
    const body = init && init.body ? JSON.parse(init.body) : null;
    let sql;
    if (p.startsWith('rpc/')) {
      const fn = p.slice(4);
      if (!/^[a-z_][a-z0-9_]*$/.test(fn)) return response(404, JSON.stringify({ code: 'PGRST202', message: 'bad function name' }));
      const args = Object.keys(body || {}).map((k) => k + ' => ' + sqlValue(body[k])).join(', ');
      sql = 'select to_jsonb(public.' + fn + '(' + args + '));';
    } else {
      const table = p;
      if (!/^[a-z_][a-z0-9_]*$/.test(table)) return response(404, JSON.stringify({ code: 'PGRST205', message: 'bad table' }));
      const rows = Array.isArray(body) ? body : [body];
      const cols = Array.from(rows.reduce((s, r) => { Object.keys(r).forEach((k) => s.add(k)); return s; }, new Set()));
      const conflict = u.searchParams.get('on_conflict');
      const ignore = /resolution=ignore-duplicates/.test(String((init && init.headers && (init.headers.prefer || init.headers.Prefer)) || ''));
      const qcols = cols.map((c) => '"' + c.replace(/"/g, '""') + '"').join(', ');
      sql = 'insert into public.' + table + ' (' + qcols + ') select ' + qcols + ' from jsonb_populate_recordset(null::public.' + table + ', '
        + lit(JSON.stringify(rows)) + '::jsonb)' + (ignore ? ' on conflict' + (conflict ? ' (' + conflict.split(',').map((c) => '"' + c + '"').join(', ') + ')' : '') + ' do nothing' : '') + ';';
    }
    const pre = opts.preamble ? opts.preamble(target, attempt) : null;
    const text = '\\set VERBOSITY verbose\nbegin;\n' + (pre || '') + '\n' + sql + '\ncommit;\n';
    try {
      const out = db.sql(text);
      return response(p.startsWith('rpc/') ? 200 : 201, p.startsWith('rpc/') ? out.split('\n').filter(Boolean).pop() || 'null' : '');
    } catch (e) {
      const msg = String(e.sqlMessage || e.message);
      const m = /ERROR:\s+([0-9A-Z]{5}):\s*([^\n]*)/.exec(msg);
      const code = m ? m[1] : null;
      return response(httpStatus(code), JSON.stringify({ code, message: m ? m[2] : msg.slice(0, 300), details: null, hint: null }));
    }
  }
  f.calls = calls;
  f.attempts = attempts;
  return f;
}

module.exports = { makeFetch, httpStatus };
