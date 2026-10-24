'use strict';
/* ===========================================================================
   The database the NCAAW jobs talk to: one method, an RPC — the same contract
   as simulator/src/publish/db.ts.

   PostgREST: POST {SB_URL}/rest/v1/rpc/<fn> with the service role key, which
   lives only in the job's environment (GitHub Actions secret SB_SERVICE_ROLE)
   — never in a file, a log line or an error message (every message is
   redacted, every occurrence). Only `ncaaw_fc_*` functions can be called.
   Transient failures (network, 5xx, 429) are retried at most 3 times with
   backoff; a 4xx is never retried.
   =========================================================================== */
class DbError extends Error { constructor(msg, status, transient) { super(msg); this.status = status; this.transient = transient; } }

function postgrestDb(env, opt) {
  env = env || process.env; opt = opt || {};
  const url = String(env.SB_URL || '').replace(/\/+$/, ''); const key = String(env.SB_SERVICE_ROLE || '');
  if (!/^https:\/\/[a-z0-9.-]+$/i.test(url)) throw new Error('SB_URL is not set to an https Supabase URL: nothing can be published');
  if (key.length < 20) throw new Error('SB_SERVICE_ROLE is not set: nothing can be published');
  const retries = opt.retries == null ? 3 : opt.retries; const f = opt.fetchImpl || fetch;
  const sleep = opt.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const redact = (s) => String(s).split(key).join('[redacted]');
  return {
    async rpc(name, args) {
      if (!/^ncaaw_fc_[a-z_]+$/.test(name)) throw new Error('refusing to call a function outside the NCAAW forecast schema: ' + name);
      let last = null;
      for (let attempt = 0; attempt <= retries; attempt++) {
        let res;
        try { res = await f(url + '/rest/v1/rpc/' + name, { method: 'POST', headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify(args) }); }
        catch (e) { last = new DbError('network error calling ' + name + ': ' + redact(e && e.message || e), null, true); if (attempt < retries) { await sleep(500 * Math.pow(2, attempt)); continue; } throw last; }
        const text = await res.text();
        if (res.ok) { try { return text ? JSON.parse(text) : null; } catch (_) { return text; } }
        const transient = res.status >= 500 || res.status === 429;
        last = new DbError(name + ' answered ' + res.status + ': ' + redact(text.slice(0, 400)), res.status, transient);
        if (transient && attempt < retries) { await sleep(500 * Math.pow(2, attempt)); continue; }
        throw last;
      }
      throw last;
    },
  };
}

module.exports = { postgrestDb, DbError };
