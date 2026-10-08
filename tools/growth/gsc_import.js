#!/usr/bin/env node
/* ===========================================================================
   GOOGLE SEARCH CONSOLE → public.search_console_pages / _queries
   (supabase/growth_engine.sql), for the owner's acquisition dashboard.

   WHAT IT DOES. Signs a JWT as a Google service account (RS256, Node's own
   crypto — no dependency), exchanges it for a read-only Search Console token,
   asks the Search Analytics API for clicks, impressions, CTR and position by
   (date, page) and by (date, query) over a rolling window, and upserts the
   rows with the Supabase service role. Re-running is harmless: every row is
   keyed by its day and its page or query. Search Console finalises data two
   to three days late, so the window ends three days ago and is re-read.

   WHAT IT NEVER DOES: print a row. The repository and its Actions logs are
   public; the log says how many rows were written and nothing else.

   CONFIGURATION (repository secrets, never committed):
     GSC_SERVICE_ACCOUNT_JSON  the service account's JSON key. Add the
                               account's client_email as a user (Restricted is
                               enough) on the Search Console property.
     GSC_SITE                  the property: sc-domain:edgedesksports.com for a
                               domain property, or https://edgedesksports.com/
     SB_SERVICE_ROLE, SB_URL   the Supabase service role, as every other job.
   Without them it says which is missing and exits 0, so an unconfigured
   repository is not a red workflow.

     node tools/growth/gsc_import.js [--days 10] [--dry]
   =========================================================================== */
'use strict';
const crypto = require('crypto');
const PGREST = require('../lib/pgrest.js');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const API = 'https://www.googleapis.com/webmasters/v3/sites/';

function arg(name, fb) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fb;
  const v = process.argv[i + 1];
  return (v == null || v.startsWith('--')) ? true : v;
}
function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }

/* the service account's signed assertion (RFC 7523) */
function assertion(sa, nowSec) {
  const now = nowSec || Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: sa.private_key_id || undefined }));
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: sa.token_uri || TOKEN_URL, iat: now, exp: now + 3600 }));
  const sig = crypto.createSign('RSA-SHA256').update(head + '.' + claims).sign(sa.private_key);
  return head + '.' + claims + '.' + b64url(sig);
}
async function accessToken(sa, fetchImpl) {
  const f = fetchImpl || fetch;
  const r = await f(sa.token_uri || TOKEN_URL, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + encodeURIComponent(assertion(sa))
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error('token exchange refused (' + r.status + '): ' + String(j.error_description || j.error || '').slice(0, 120));
  return j.access_token;
}
function ymd(d) { return d.toISOString().slice(0, 10); }
function windowOf(days, now) {
  const end = new Date((now || Date.now()) - 3 * 864e5);
  const start = new Date(end.getTime() - (Math.max(1, days) - 1) * 864e5);
  return { start: ymd(start), end: ymd(end) };
}
/* every row of one dimension pair, paged by startRow */
async function query(site, token, body, fetchImpl) {
  const f = fetchImpl || fetch;
  const out = [];
  for (let startRow = 0; startRow < 250000; startRow += 25000) {
    const r = await f(API + encodeURIComponent(site) + '/searchAnalytics/query', {
      method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify(Object.assign({}, body, { rowLimit: 25000, startRow }))
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('Search Analytics refused (' + r.status + '): ' + String((j.error && j.error.message) || '').slice(0, 160));
    const rows = j.rows || [];
    out.push(...rows);
    if (rows.length < 25000) break;
  }
  return out;
}
/* API rows → table rows; anything malformed is dropped, never coerced */
function toRows(apiRows, key) {
  const now = new Date().toISOString();
  return (apiRows || []).map(r => {
    const keys = r.keys || [];
    const day = keys[0], val = keys[1];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || '')) || !val) return null;
    const o = { day, clicks: Math.max(0, Math.round(+r.clicks || 0)), impressions: Math.max(0, Math.round(+r.impressions || 0)),
      ctr: isFinite(+r.ctr) ? +(+r.ctr).toFixed(6) : null, position: isFinite(+r.position) ? +(+r.position).toFixed(3) : null, imported_at: now };
    o[key] = String(val).slice(0, key === 'page' ? 600 : 300);
    if (key === 'page' && !/^https?:\/\//.test(o.page)) return null;
    return o;
  }).filter(Boolean);
}

async function main(env, deps) {
  env = env || process.env; deps = deps || {};
  const log = deps.log || ((...a) => console.log(...a));
  const raw = env.GSC_SERVICE_ACCOUNT_JSON || '';
  const site = String(env.GSC_SITE || '').trim();
  const missing = [];
  if (!raw) missing.push('GSC_SERVICE_ACCOUNT_JSON');
  if (!site) missing.push('GSC_SITE');
  const cfg = PGREST.config({ EDGD_SB_SERVICE: env.SB_SERVICE_ROLE || env.EDGD_SB_SERVICE, EDGD_SB_URL: env.SB_URL || env.EDGD_SB_URL });
  if (!cfg) missing.push('SB_SERVICE_ROLE');
  if (missing.length) { log('search console import: not configured (' + missing.join(', ') + ' missing) — nothing to do'); return { ok: true, skipped: missing }; }
  let sa;
  try { sa = JSON.parse(raw); } catch (_) { throw new Error('GSC_SERVICE_ACCOUNT_JSON is not valid JSON'); }
  if (!sa.client_email || !sa.private_key) throw new Error('GSC_SERVICE_ACCOUNT_JSON has no client_email/private_key');

  const days = parseInt(arg('days', env.GSC_DAYS || '10'), 10) || 10;
  const w = windowOf(days, deps.now);
  const token = await accessToken(sa, deps.fetch);
  const pages = toRows(await query(site, token, { startDate: w.start, endDate: w.end, dimensions: ['date', 'page'], dataState: 'final' }, deps.fetch), 'page');
  const queries = toRows(await query(site, token, { startDate: w.start, endDate: w.end, dimensions: ['date', 'query'], dataState: 'final' }, deps.fetch), 'query');
  const dry = !!arg('dry', false) || deps.dry;
  if (!dry) {
    const db = deps.db || PGREST.client(cfg, deps.fetch);
    await db.upsert('public', 'search_console_pages', pages, 'day,page', { returning: false });
    await db.upsert('public', 'search_console_queries', queries, 'day,query', { returning: false });
    await db.insert('public', 'search_console_runs', [{ site, start_day: w.start, end_day: w.end, pages: pages.length, queries: queries.length, ok: true }], { returning: false });
  }
  log('search console import: ' + w.start + ' to ' + w.end + ' · ' + pages.length + ' page rows · ' + queries.length + ' query rows' + (dry ? ' (dry run, nothing written)' : ''));
  return { ok: true, window: w, pages: pages.length, queries: queries.length };
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((e) => { console.error('search console import failed: ' + String(e && e.message || e)); process.exit(1); });
}
module.exports = { main, assertion, accessToken, toRows, windowOf, query };
