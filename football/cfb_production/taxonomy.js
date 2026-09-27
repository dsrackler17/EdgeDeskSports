/* ============================================================================
   CFB production — ONE error taxonomy (docs/cfb-production/JOBS.md §4).

   Every production error carries a fine-grained CODE (what went wrong, for
   incident analysis) and the coarse RUNLOG CLASS the weekly engine already
   records in cfb_pipeline_stage_log.error_class
   (football/cfb_v2/research/v2/weekly/runlog.py ERROR_CLASSES:
   TRANSIENT, DATA_QUALITY, AUTH, RATE_LIMIT, SCHEMA, DATABASE, UNKNOWN).
   Nothing here invents a second vocabulary for the stage log: a code maps to
   exactly one runlog class, and football/cfb_production/tests.js proves every
   mapping target is a class runlog.py and supabase/cfb_weekly.sql accept.

   RETRY POLICY lives here too, so no caller decides it ad hoc: only the codes
   marked retryable are retried, each with its own attempt budget and a
   bounded, jittered backoff (db.js). Authentication failures, schema
   problems, malformed requests and integrity refusals are permanent and are
   raised at once, logged under their own code.

   classify(x) accepts what the jobs actually see:
     - a PostgREST answer   { status, body }  (body.code is the SQLSTATE or a
                            PGRST code; PostgREST answers 40P01, 55P03 and
                            57014 all with HTTP 500, so the body decides)
     - a psql / pg error    message text "ERROR:  40P01: deadlock detected"
                            (VERBOSITY verbose) or an Error with .code
     - a network failure    fetch's TypeError / ECONNRESET / AbortError
     - an Error already classified (err.cfb_code)
   ========================================================================== */
'use strict';

const RUNLOG_CLASSES = ['TRANSIENT', 'DATA_QUALITY', 'AUTH', 'RATE_LIMIT', 'SCHEMA', 'DATABASE', 'UNKNOWN'];

/* code -> { runlog, severity (default when it is not retried away), retry: attempts incl. the first (1 = never retried), meaning } */
const CODES = {
  DATA_STALE:           { runlog: 'DATA_QUALITY', severity: 'WARNING',  retry: 1, meaning: 'an input is older than its maximum acceptable age (freshness rules, OPERATIONS.md)' },
  DATA_MISSING:         { runlog: 'DATA_QUALITY', severity: 'WARNING',  retry: 1, meaning: 'a required input is absent (never converted to zero)' },
  PROVIDER_TRANSIENT:   { runlog: 'TRANSIENT',    severity: 'WARNING',  retry: 4, meaning: 'timeout, temporary 5xx, network reset' },
  PROVIDER_RATE_LIMIT:  { runlog: 'RATE_LIMIT',   severity: 'WARNING',  retry: 4, meaning: 'HTTP 429; Retry-After is honoured up to the cap' },
  PROVIDER_REJECTED:    { runlog: 'SCHEMA',       severity: 'WARNING',  retry: 1, meaning: 'a permanent 4xx: malformed request, unknown path, payload refused' },
  PROVIDER_SCHEMA:      { runlog: 'SCHEMA',       severity: 'CRITICAL', retry: 1, meaning: 'a provider payload lost a required field or changed type' },
  AUTH:                 { runlog: 'AUTH',         severity: 'CRITICAL', retry: 1, meaning: 'credentials refused (401/403, 28xxx, 42501): never retried' },
  TEAM_MAPPING:         { runlog: 'DATA_QUALITY', severity: 'WARNING',  retry: 1, meaning: 'a team did not map to one canonical id; the game fails safely' },
  PLAYER_MAPPING:       { runlog: 'DATA_QUALITY', severity: 'WARNING',  retry: 1, meaning: 'a player did not map to one canonical id' },
  MODEL_ARTIFACT:       { runlog: 'SCHEMA',       severity: 'CRITICAL', retry: 1, meaning: 'an artifact is missing or its hash differs from the manifest' },
  MODEL_INPUT:          { runlog: 'DATA_QUALITY', severity: 'WARNING',  retry: 1, meaning: 'an input violates the model input contract' },
  CALIBRATION:          { runlog: 'SCHEMA',       severity: 'CRITICAL', retry: 1, meaning: 'a calibrator or decision policy is incompatible with the model version' },
  MARKET_INVALID:       { runlog: 'DATA_QUALITY', severity: 'WARNING',  retry: 1, meaning: 'a quote failed sanity bounds or belongs to another game' },
  DATABASE_DEADLOCK:    { runlog: 'DATABASE',     severity: 'WARNING',  retry: 5, meaning: '40P01 deadlock / 40001 serialization failure: the server rolled the transaction back' },
  DATABASE_TIMEOUT:     { runlog: 'DATABASE',     severity: 'WARNING',  retry: 3, meaning: '55P03 lock_timeout / 57014 statement_timeout' },
  DATABASE_UNAVAILABLE: { runlog: 'TRANSIENT',    severity: 'WARNING',  retry: 4, meaning: '08xxx connection, 53xxx resources, 57P0x shutdown / starting up' },
  DATABASE_CONSTRAINT:  { runlog: 'DATABASE',     severity: 'WARNING',  retry: 1, meaning: 'a write refused by an integrity rule (23xxx, 22xxx, append-only trigger, guard)' },
  DATABASE_SCHEMA:      { runlog: 'SCHEMA',       severity: 'CRITICAL', retry: 1, meaning: 'a table, column or function is missing: the migration is not applied' },
  PIPELINE_CONFLICT:    { runlog: 'DATABASE',     severity: 'INFO',     retry: 1, meaning: 'another run holds the job lock; this one exits cleanly (runlog RunLock uses DATABASE)' },
  UNKNOWN:              { runlog: 'UNKNOWN',      severity: 'WARNING',  retry: 1, meaning: 'unclassified: investigate, never retried' },
};

const SEVERITIES = ['INFO', 'WARNING', 'CRITICAL'];

/* SQLSTATE -> code. Exact codes first, then two-character classes. */
const SQLSTATE_EXACT = {
  '40P01': 'DATABASE_DEADLOCK', '40001': 'DATABASE_DEADLOCK',
  '55P03': 'DATABASE_TIMEOUT', '57014': 'DATABASE_TIMEOUT',
  '57P01': 'DATABASE_UNAVAILABLE', '57P02': 'DATABASE_UNAVAILABLE', '57P03': 'DATABASE_UNAVAILABLE',
  '42P01': 'DATABASE_SCHEMA', '42703': 'DATABASE_SCHEMA', '42883': 'DATABASE_SCHEMA', '3F000': 'DATABASE_SCHEMA',
  '42501': 'AUTH',
  'P0001': 'DATABASE_CONSTRAINT',
  /* PostgREST's own codes */
  PGRST202: 'DATABASE_SCHEMA', PGRST204: 'DATABASE_SCHEMA', PGRST205: 'DATABASE_SCHEMA', PGRST200: 'DATABASE_SCHEMA',
  PGRST301: 'AUTH', PGRST302: 'AUTH', PGRST300: 'AUTH',
  PGRST000: 'DATABASE_UNAVAILABLE', PGRST001: 'DATABASE_UNAVAILABLE', PGRST002: 'DATABASE_UNAVAILABLE', PGRST003: 'DATABASE_TIMEOUT',
};
const SQLSTATE_CLASS = { '08': 'DATABASE_UNAVAILABLE', '53': 'DATABASE_UNAVAILABLE', '23': 'DATABASE_CONSTRAINT', '22': 'DATABASE_CONSTRAINT',
  '28': 'AUTH', '42': 'PROVIDER_REJECTED', '40': 'DATABASE_DEADLOCK' };

function fromSqlstate(code) {
  if (!code) return null;
  const c = String(code).toUpperCase();
  if (SQLSTATE_EXACT[c]) return SQLSTATE_EXACT[c];
  if (/^[0-9A-Z]{5}$/.test(c) && SQLSTATE_CLASS[c.slice(0, 2)]) return SQLSTATE_CLASS[c.slice(0, 2)];
  return null;
}

/* HTTP status -> code, used only when the body names no SQLSTATE */
function fromHttp(status) {
  const s = Number(status);
  if (!Number.isFinite(s) || s < 400) return null;
  if (s === 429) return 'PROVIDER_RATE_LIMIT';
  if (s === 401 || s === 403) return 'AUTH';
  if (s === 408 || s === 425 || s === 500 || s === 502 || s === 503 || s === 504) return 'PROVIDER_TRANSIENT';
  if (s >= 500) return 'PROVIDER_TRANSIENT';
  return 'PROVIDER_REJECTED';
}

/* numbers inside ids must never read as HTTP statuses: "game 401628374" is not a 401 */
function hasStatus(s, codes) { return new RegExp('(?<![0-9])(' + codes.join('|') + ')(?![0-9])').test(s); }

function fromText(text) {
  const s = String(text || '');
  const m = /ERROR:\s+([0-9A-Z]{5}):/.exec(s) || /\bSQLSTATE[ =:]+([0-9A-Z]{5})\b/i.exec(s) || /"code"\s*:\s*"([0-9A-Z]{5}|PGRST[0-9]{3})"/.exec(s);
  if (m) { const c = fromSqlstate(m[1]); if (c) return c; }
  const l = s.toLowerCase();
  if (/deadlock detected/.test(l)) return 'DATABASE_DEADLOCK';
  if (/could not serialize access/.test(l)) return 'DATABASE_DEADLOCK';
  if (/canceling statement due to (lock|statement) timeout|lock_not_available|could not obtain lock/.test(l)) return 'DATABASE_TIMEOUT';
  if (/append-only|violates (check|unique|foreign key|not-null) constraint|duplicate key value/.test(l)) return 'DATABASE_CONSTRAINT';
  if (/relation .* does not exist|column .* does not exist|function .* does not exist|could not find the function/.test(l)) return 'DATABASE_SCHEMA';
  if (hasStatus(l, ['429']) || /rate limit|too many requests/.test(l)) return 'PROVIDER_RATE_LIMIT';
  if (hasStatus(l, ['401', '403']) || /unauthori[sz]ed|forbidden|permission denied|invalid api key|jwt expired|authentication failed/.test(l)) return 'AUTH';
  if (hasStatus(l, ['502', '503', '504']) || /econnreset|econnrefused|etimedout|eai_again|enotfound|socket hang up|network|timed out|timeout|fetch failed|connection (reset|refused|terminated)|server closed the connection/.test(l)) return 'PROVIDER_TRANSIENT';
  return null;
}

/* Classify anything a job can throw or receive. Returns a CODE. */
function classify(x) {
  if (x == null) return 'UNKNOWN';
  if (typeof x === 'object' && x.cfb_code && CODES[x.cfb_code]) return x.cfb_code;
  if (typeof x === 'object' && ('status' in x) && !(x instanceof Error)) {
    const body = x.body;
    let code = null;
    if (body && typeof body === 'object') code = fromSqlstate(body.code);
    else if (typeof body === 'string') {
      try { const j = JSON.parse(body); code = fromSqlstate(j && j.code); } catch (_) { code = fromText(body); }
    }
    return code || fromHttp(x.status) || 'UNKNOWN';
  }
  if (x instanceof Error || typeof x === 'object') {
    const byCode = fromSqlstate(x.code) || fromSqlstate(x.sqlState);
    if (byCode) return byCode;
    const name = String(x.name || '');
    if (name === 'AbortError' || name === 'TimeoutError') return 'PROVIDER_TRANSIENT';
    const net = String(x.code || (x.cause && x.cause.code) || '');
    if (/^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|UND_ERR_[A-Z_]+)$/.test(net)) return 'PROVIDER_TRANSIENT';
    const t = fromText((x.message || '') + ' ' + (x.sqlMessage || '') + ' ' + ((x.cause && x.cause.message) || ''));
    if (t) return t;
    if (name === 'TypeError' && /fetch/i.test(String(x.message))) return 'PROVIDER_TRANSIENT';
    return 'UNKNOWN';
  }
  return fromText(x) || 'UNKNOWN';
}

function info(code) { return CODES[code] || CODES.UNKNOWN; }
function runlogClass(code) { return info(code).runlog; }
function attempts(code) { return info(code).retry; }
function retryable(code) { return info(code).retry > 1; }

/* An Error that carries its classification (and survives JSON logging). */
class CfbError extends Error {
  constructor(message, code, extra) {
    super(message);
    this.name = 'CfbError';
    this.cfb_code = CODES[code] ? code : 'UNKNOWN';
    this.runlog_class = runlogClass(this.cfb_code);
    Object.assign(this, extra || {});
  }
}

module.exports = { CODES, RUNLOG_CLASSES, SEVERITIES, classify, fromSqlstate, fromHttp, fromText, info, runlogClass, attempts, retryable, CfbError };
