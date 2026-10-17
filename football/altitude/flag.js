/* ============================================================================
   THE ALTITUDE SWITCH — public.cfb_feature_flags.cfb_altitude_adjustment_enabled,
   read FAIL-CLOSED.

   football/cfb_production/gate.js reads its job flags fail-open (a missing
   table or an unseeded flag lets a job run) because a skipped capture loses
   data that can never be re-taken. This flag is the opposite kind of switch:
   it decides whether a research adjustment may move a published number, so
   every answer other than an explicit `true` from the table is OFF — no
   database, no credentials, an unseeded flag, an error, a timeout.

     const F = require('./flag.js');
     const { enabled, source } = await F.read();         // SB_URL, SB_SERVICE_ROLE
   ========================================================================== */
'use strict';

const FLAG = 'cfb_altitude_adjustment_enabled';

async function read(opts) {
  opts = opts || {};
  const env = opts.env || process.env;
  const url = opts.url || env.SB_URL, key = opts.key || env.SB_SERVICE_ROLE;
  const f = opts.fetch || globalThis.fetch;
  if (!url || !key || typeof f !== 'function') return { flag: FLAG, enabled: false, source: 'no database credentials: off' };
  try {
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ac ? setTimeout(() => ac.abort(), opts.timeoutMs || 10000) : null;
    let res;
    try {
      res = await f(url.replace(/\/+$/, '') + '/rest/v1/cfb_feature_flags?select=enabled,evidence_ref,updated_at&flag=eq.' + FLAG,
        Object.assign({ headers: { apikey: key, authorization: 'Bearer ' + key } }, ac ? { signal: ac.signal } : {}));
    } finally { if (timer) clearTimeout(timer); }
    if (!res.ok) return { flag: FLAG, enabled: false, source: 'HTTP ' + res.status + ': off' };
    const rows = await res.json();
    if (!Array.isArray(rows) || !rows.length) return { flag: FLAG, enabled: false, source: 'flag not seeded: off' };
    return { flag: FLAG, enabled: rows[0].enabled === true, evidence_ref: rows[0].evidence_ref || null,
      updated_at: rows[0].updated_at || null, source: 'cfb_feature_flags' };
  } catch (e) {
    return { flag: FLAG, enabled: false, source: 'unreadable (' + String((e && e.message) || e).slice(0, 120) + '): off' };
  }
}

module.exports = { FLAG, read };
