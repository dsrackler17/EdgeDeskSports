/* ===========================================================================
   EDGEDESK SAVED RESEARCH — the reader's saved desk answers and fair-line
   sheets on their account (supabase/saved_research.sql), under their own
   token. Row level security decides what a reader can reach; this client
   never sends another reader's id and never reads the table as anon.

   Every call answers {ok, ...} and never throws. When the account save is
   not possible (not signed in, the table is not deployed, the network is
   down) the answer says so in `why`, and the caller keeps its on-device copy:
   nothing is silently lost and nothing is silently claimed as saved.

   Browser: window.EDSaved.configure({url, key, token}) then save/list/rename/remove.
   Node:    require('./edgedesk_saved_research.js') (tests pass a fetch).
   =========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.EDSaved = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';
  var CFG = { url: null, key: null, token: null, fetch: null };
  var KINDS = { desk_answer: 1, fair_line: 1, note: 1 };
  var LIMITS = { title: 160, note: 4000, question: 1000, answer: 20000, payload: 200000 };

  function configure(o) { o = o || {}; Object.keys(o).forEach(function (k) { CFG[k] = o[k]; }); return api; }
  function f() { return CFG.fetch || (typeof fetch === 'function' ? fetch : null); }
  function cut(s, n) { if (s == null) return null; s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function tokenOf() {
    try { var t = typeof CFG.token === 'function' ? CFG.token() : CFG.token; return Promise.resolve(t); } catch (e) { return Promise.resolve(null); }
  }
  /* the anon key is not an account: a token that is the public key saves nothing */
  function signedIn(t) { return !!t && t !== CFG.key; }
  function headers(t, extra) { var h = { apikey: CFG.key, authorization: 'Bearer ' + t, 'content-type': 'application/json' }; Object.keys(extra || {}).forEach(function (k) { h[k] = extra[k]; }); return h; }
  function why(status, text) {
    if (status === 401 || status === 403) return 'your session could not be verified; sign in again to save to your account';
    if (status === 404) return 'saved research is not set up on the server yet (supabase/saved_research.sql)';
    if (status === 0) return 'the server could not be reached';
    if (/500 saved items/.test(text || '')) return '500 saved items is the limit; delete or archive some first';
    return 'the server answered ' + status;
  }
  function call(method, path, body, extra) {
    var F = f();
    if (!F || !CFG.url || !CFG.key) return Promise.resolve({ ok: false, status: 0, why: 'saved research is not configured on this page' });
    return tokenOf().then(function (t) {
      if (!signedIn(t)) return { ok: false, status: 401, why: 'sign in to save research to your account' };
      return F(CFG.url + '/rest/v1/' + path, { method: method, headers: headers(t, extra), body: body == null ? undefined : JSON.stringify(body) })
        .then(function (r) {
          return r.text().then(function (txt) {
            var j = null; try { j = txt ? JSON.parse(txt) : null; } catch (e) { j = null; }
            return r.ok ? { ok: true, status: r.status, data: j } : { ok: false, status: r.status, why: why(r.status, txt) };
          });
        }, function () { return { ok: false, status: 0, why: why(0) }; });
    });
  }

  /** item: {kind, title, sport?, game_id?, question?, answer?, payload?, note?} */
  function save(item) {
    item = item || {};
    if (!KINDS[item.kind]) return Promise.resolve({ ok: false, why: 'unknown kind ' + item.kind });
    var title = cut(String(item.title || '').trim(), LIMITS.title);
    if (!title) return Promise.resolve({ ok: false, why: 'a saved item needs a title' });
    var payload = item.payload == null ? null : item.payload;
    if (payload != null) { try { if (JSON.stringify(payload).length > LIMITS.payload) return Promise.resolve({ ok: false, why: 'this item is too large to save to your account (over 200 KB)' }); } catch (e) { return Promise.resolve({ ok: false, why: 'this item cannot be saved: ' + e.message }); } }
    var row = { kind: item.kind, title: title, sport: cut(item.sport, 64), game_id: item.game_id == null ? null : cut(String(item.game_id), 64),
      question: cut(item.question, LIMITS.question), answer: cut(item.answer, LIMITS.answer), note: cut(item.note, LIMITS.note), payload: payload };
    return call('POST', 'saved_research', row, { prefer: 'return=representation' }).then(function (r) {
      return r.ok ? { ok: true, row: Array.isArray(r.data) ? r.data[0] : r.data } : r;
    });
  }
  function list(opts) {
    opts = opts || {};
    var q = 'saved_research?select=id,created_at,kind,sport,game_id,title,note,archived,question&order=created_at.desc&limit=' + Math.max(1, Math.min(200, opts.limit || 50));
    if (!opts.includeArchived) q += '&archived=is.false';
    if (opts.kind && KINDS[opts.kind]) q += '&kind=eq.' + opts.kind;
    return call('GET', q, null).then(function (r) { return r.ok ? { ok: true, rows: r.data || [] } : r; });
  }
  function get(id) {
    if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) return Promise.resolve({ ok: false, why: 'not a saved item id' });
    return call('GET', 'saved_research?select=*&id=eq.' + id, null).then(function (r) { return r.ok ? { ok: !!(r.data && r.data[0]), row: r.data && r.data[0], why: r.data && r.data[0] ? null : 'not found' } : r; });
  }
  function rename(id, title, note) {
    if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) return Promise.resolve({ ok: false, why: 'not a saved item id' });
    var patch = {}; if (title != null) patch.title = cut(String(title).trim(), LIMITS.title); if (note != null) patch.note = cut(note, LIMITS.note);
    if (patch.title === '') return Promise.resolve({ ok: false, why: 'a saved item needs a title' });
    return call('PATCH', 'saved_research?id=eq.' + id, patch, { prefer: 'return=minimal' });
  }
  function archive(id, on) { return /^[0-9a-f-]{36}$/i.test(String(id || '')) ? call('PATCH', 'saved_research?id=eq.' + id, { archived: on !== false }, { prefer: 'return=minimal' }) : Promise.resolve({ ok: false, why: 'not a saved item id' }); }
  function remove(id) { return /^[0-9a-f-]{36}$/i.test(String(id || '')) ? call('DELETE', 'saved_research?id=eq.' + id, null, { prefer: 'return=minimal' }) : Promise.resolve({ ok: false, why: 'not a saved item id' }); }

  var api = { configure: configure, save: save, list: list, get: get, rename: rename, archive: archive, remove: remove, LIMITS: LIMITS, KINDS: Object.keys(KINDS) };
  return api;
});
