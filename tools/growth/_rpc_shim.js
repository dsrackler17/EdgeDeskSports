'use strict';
/* ===========================================================================
   A small PostgREST stand-in for the outbound Edge Function tests.

   The function under test calls Supabase over HTTP: GET /auth/v1/user to
   learn who the bearer token is, then POST /rest/v1/rpc/<door> for every
   database door. Here those calls run in the throwaway PostgreSQL
   (tools/personal/_pg.js) AS THAT CALLER, so the function meets the real
   SQL — its checks, its refusals, its owner gate — not a mock of it.

     const shim = rpcShim(db, { url, users: { [token]: { id, email } }, override: () => fn });
     globalThis.fetch = async (input, init) => (await shim(String(input), init)) || otherWorld(input, init);

   An error that says "outbound owner only" is a 403 (as PostgREST answers a
   42501); a door that does not exist is a 404 (PGRST202); anything else 400.
   =========================================================================== */
const { lit } = require('../personal/_pg.js');

const sqlVal = (v) => v === null || v === undefined ? 'null' : typeof v === 'number' || typeof v === 'boolean' ? String(v)
  : typeof v === 'string' ? lit(v) : lit(JSON.stringify(v)) + '::jsonb';
const jres = (status, body, headers) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { status, headers: Object.assign({ 'content-type': 'application/json' }, headers || {}) });

function rpcShim(db, o) {
  return async (url, init) => {
    const u = new URL(url);
    if (u.origin !== o.url) return null;
    const h = Object.assign({}, (init && init.headers) || {});
    const token = String(h.authorization || '').replace(/^Bearer /, '');
    const who = Object.prototype.hasOwnProperty.call(o.users, token) ? o.users[token] : null;
    if (u.pathname === '/auth/v1/user') return who ? jres(200, { id: who.id, email: who.email }) : jres(401, { msg: 'bad jwt' });
    const m = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(u.pathname);
    if (!m) return jres(404, {});
    const args = JSON.parse((init && init.body) || '{}');
    const ov = o.override && o.override();
    if (ov) { const r = ov(m[1], args); if (r) return r; }
    const sql = `select public.${m[1]}(${Object.entries(args).map(([k, v]) => k + ' => ' + sqlVal(v)).join(', ')});`;
    try {
      const out = who ? db.as(who.id, sql) : db.anon(sql);
      return jres(200, out === 't' ? true : out === 'f' ? false : out === '' ? null : JSON.parse(out));
    } catch (e) {
      const msg = String(e.sqlMessage || e.message);
      if (/outbound owner only/.test(msg)) return jres(403, { code: '42501', message: 'outbound owner only' });
      if (/does not exist/.test(msg)) return jres(404, { code: 'PGRST202', message: msg.slice(0, 200) });
      return jres(400, { message: msg.slice(0, 300) });
    }
  };
}

module.exports = { rpcShim, sqlVal, jres };
