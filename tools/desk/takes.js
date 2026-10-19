/* ============================================================================
   "MY TAKE" FOR GAME ARTICLES — what the editorial pipeline reads before it
   decides whether an article may publish.

   Takes are written by the owner in /admin/desk/ into public.article_takes
   (supabase/desk_articles.sql). The editorial job reads them with the service
   role, merges each into its record, and the publisher refuses a record that
   has never been public and has no take of the minimum length
   (tools/editorial/publisher.js, check `my_take`).

   THE SWITCH. desk_settings.require_take_for_game_articles in the database
   (the owner's page), else EDGD_REQUIRE_MY_TAKE in the environment, else ON.

   FAILING CLOSED. With no service role, or a database that does not answer,
   no take can be read, so every NEW game article is held. A held article is
   a delay; an article published without its take is the thing this exists to
   prevent. Pages already published are never touched.
   ========================================================================== */
'use strict';

const DEFAULT_MIN = 240;

function envBool(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].indexOf(s) >= 0) return true;
  if (['false', '0', 'no', 'off'].indexOf(s) >= 0) return false;
  return null;
}
function takeLen(t) { return String(t || '').replace(/\s+/g, ' ').trim().length; }

async function load(opts) {
  opts = opts || {};
  const env = opts.env || process.env;
  const f = opts.fetch || (typeof fetch === 'function' ? fetch : null);
  /* its own names first: the editorial runtime switches on leases and
     heartbeats when it sees SB_SERVICE_ROLE, and reading takes must not */
  const url = (env.DESK_SB_URL || env.SB_URL || '').replace(/\/+$/, ''), key = env.DESK_SB_SERVICE_ROLE || env.SB_SERVICE_ROLE || '';
  const envRequire = envBool(env.EDGD_REQUIRE_MY_TAKE);
  const out = { map: Object.create(null), require: envRequire == null ? true : envRequire, min: DEFAULT_MIN, reachable: false, source: envRequire == null ? 'default' : 'env', note: '' };
  if (!url || !key || !f) {
    out.note = 'no service role in this run: no take can be read, so every new game article is held until one can';
    return out;
  }
  const h = { apikey: key, authorization: 'Bearer ' + key, 'content-type': 'application/json' };
  try {
    const r = await f(url + '/rest/v1/rpc/article_takes_for_pipeline', { method: 'POST', headers: h, body: '{}' });
    if (!r.ok) throw new Error('article_takes_for_pipeline HTTP ' + r.status);
    (await r.json() || []).forEach(row => { if (row && row.article_id) out.map[row.article_id] = row.take; });
    const s = await f(url + '/rest/v1/desk_settings?select=min_take_chars,require_take_for_game_articles&id=eq.1', { headers: h });
    if (s.ok) {
      const row = (await s.json() || [])[0];
      if (row) {
        if (typeof row.require_take_for_game_articles === 'boolean') { out.require = row.require_take_for_game_articles; out.source = 'database'; }
        if (Number.isFinite(row.min_take_chars)) out.min = row.min_take_chars;
      }
    }
    out.reachable = true;
    out.note = Object.keys(out.map).length + ' game take(s) on file; take ' + (out.require ? 'required' : 'NOT required') + ' (' + out.source + '), minimum ' + out.min + ' characters';
  } catch (e) {
    out.note = 'takes not read (' + String(e && e.message || e).slice(0, 120) + '): every new game article is held';
  }
  return out;
}

module.exports = { load, takeLen, DEFAULT_MIN };
