/* ============================================================================
   CFB production — structured logging and the correlation id
   (docs/cfb-production/JOBS.md §5).

   One JSON object per line, never a free-form console string, with a fixed
   vocabulary so a log search can join a whole pipeline:

     ts              ISO-8601 UTC
     level           INFO | WARNING | CRITICAL
     job             the registry name (jobs.json), e.g. cfb_weekly_refresh
     correlation_id  ONE id across every step of one pipeline execution:
                     ingestion -> features -> prediction -> market decision.
                     Workflows set CFB_CORRELATION_ID =
                       cfb-<workflow file stem>-<github.run_id>-<run_attempt>
                     A local run without it gets cfb-local-<pid>-<epoch ms>.
     run_id          the engine's own execution id when it has one
                     (cfbw_… weekly, the lab's run log), else = correlation_id
     stage, event    what is happening (start | finish | retry | incident | ...)
     game_id, model_version, provider, error_code, runlog_class, duration_ms
                     when they apply

   SECRETS NEVER REACH A LOG LINE: keys that name a credential are replaced
   with "[REDACTED]" and bearer tokens / JWTs / sk- keys inside any string are
   masked, so a PostgREST error echoed into a log cannot leak the service key.
   ========================================================================== */
'use strict';

/* a field NAME that holds a credential (run_key / lock_key / incident_key are
   identifiers, not secrets, and stay readable) */
const SECRET_KEY = /^(key|auth|apikey)$|secret|password|passwd|token|api_key|authorization|cookie|credential|service_role/i;
const SECRET_VALUE = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,       // JWT
  /\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{8,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,                                        // GitHub tokens
  /([?&](apikey|api_key|key|token)=)[^&\s"']+/gi,
];

function scrub(s) {
  let out = String(s);
  for (const re of SECRET_VALUE) out = out.replace(re, (m, a) => (typeof a === 'string' && /[?&]/.test(a) ? a + '[REDACTED]' : '[REDACTED]'));
  return out;
}

function redact(v, depth) {
  depth = depth || 0;
  if (v == null) return v;
  if (typeof v === 'string') return scrub(v);
  if (typeof v !== 'object') return v;
  if (depth > 6) return '[depth]';
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => redact(x, depth + 1));
  if (v instanceof Error) return { name: v.name, message: scrub(v.message), code: v.cfb_code || v.code || null };
  const o = {};
  for (const k of Object.keys(v)) o[k] = SECRET_KEY.test(k) ? '[REDACTED]' : redact(v[k], depth + 1);
  return o;
}

function correlationId(env) {
  env = env || process.env;
  const c = env.CFB_CORRELATION_ID;
  if (c && /^[A-Za-z0-9._:-]{1,128}$/.test(c)) return c;
  return 'cfb-local-' + process.pid + '-' + Date.now();
}

/* logger({ job, run_id?, correlation_id?, sink?, now? }) -> { event, info, warn, critical, child, ctx } */
function logger(base, opts) {
  opts = opts || {};
  const ctx = Object.assign({ job: null, correlation_id: null, run_id: null }, base || {});
  if (!ctx.correlation_id) ctx.correlation_id = correlationId(opts.env);
  if (!ctx.run_id) ctx.run_id = ctx.correlation_id;
  const sink = opts.sink || ((line) => process.stdout.write(line + '\n'));
  const now = opts.now || (() => new Date().toISOString());
  function event(level, stage, name, fields) {
    const rec = Object.assign({ ts: now(), level, job: ctx.job, correlation_id: ctx.correlation_id, run_id: ctx.run_id,
      stage: stage || null, event: name || null }, redact(fields || {}));
    const line = JSON.stringify(rec);
    sink(line, rec);
    return rec;
  }
  return {
    ctx,
    event,
    info: (stage, name, f) => event('INFO', stage, name, f),
    warn: (stage, name, f) => event('WARNING', stage, name, f),
    critical: (stage, name, f) => event('CRITICAL', stage, name, f),
    child: (extra) => logger(Object.assign({}, ctx, extra || {}), opts),
  };
}

module.exports = { logger, redact, scrub, correlationId, SECRET_KEY };
