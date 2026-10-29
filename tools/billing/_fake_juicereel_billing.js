'use strict';
/* ===========================================================================
   A fake Juice Reel for EdgeDesk's Juice Reel billing (supabase/functions/
   juicereel_billing). It ENFORCES the documented contract, so a request
   EdgeDesk shapes wrongly fails here the way it would there:

     POST /checkout/sessions   HTTP Basic id:secret + X-OAuth-Client-Id; JSON
                               {successUrl, cancelUrl, scopes, state,
                               codeChallenge}; both URLs registered EXACTLY;
                               scopes unique and approved → 201 {checkoutSessionId,
                               checkoutUrl, expiresAt}
     POST /oauth2/token        Basic + header; form grant_type=authorization_code,
                               code (single use, short-lived), redirect_uri equal
                               to the one the code was issued for (the SUCCESS
                               URL after a checkout), code_verifier (S256)
     POST /oauth2/revoke       Basic; 200 {} for any token, 401 invalid_client
     GET  /oauth2/me           Bearer → {id (integer), displayName}
     GET  /oauth2/subscribers/status    Bearer + subscribers.read
     GET  /oauth2/subscribers/current   owner access (Basic)

   THE LAST TWO ANSWER AS JUICE REEL DOCUMENTS THEM (confirmed by Juice Reel
   on 2026-10-29; juicereel.com/api-docs/subscriber-status and
   /current-subscribers), by default:
     status   {isCurrentlySubscribed: true, subscription: {subscriptionProductId,
              userId, expiresDate, isCurrentlySubscribed, SubscriptionProduct}};
              an expired or never-subscribed buyer gets {isCurrentlySubscribed:
              false} with NO subscription; the application's owner gets
              {isCurrentlySubscribed: true} with NO subscription
     list     {subscribers: [...]}: everyone who has EVER subscribed (expired
              and refunded entries too, a buyer's older entries first), each
              {subscriptionProductId, userId, expiresDate, isCurrentlySubscribed,
              User: {id, displayName}, SubscriptionProduct}; no pagination
   `statusShape` and `listShape` still switch to the forms EdgeDesk guessed
   before that, so the reader keeps being exercised on each.

   The buyer's side is driven by the test: pay() and cancel() for a checkout,
   authorize() for a plain account link, and webhook() for a signed delivery.
   =========================================================================== */
const crypto = require('crypto');

const API = 'https://external-api.juicereel.com';
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function make(opts) {
  const o = Object.assign({
    clientId: 'jr_test_client', clientSecret: 'jrs_test_secret', webhookSecret: 'jrwh_test_secret',
    redirectUris: ['https://edgedesksports.com/oauth/juicereel-subscribe.html'],
    approvedScopes: ['subscribers.read', 'bets.open.read', 'bets.settled.read'],
    ownerId: 1, ownerName: 'EdgeDeskSports', pageSize: 2,
  }, opts || {});
  const S = {
    sessions: {}, codes: {}, tokens: {}, subs: {},   // subs[jrUserId] = [{productId, expiresDate, status}]
    users: {}, calls: [],
    statusShape: 'documented',    // documented | flag | list | array | flag_bare | contradiction | absent (404) | not_subscribed
    listShape: 'documented',      // documented (everyone ever, one page) | paged (current only, nextCursor)
    ownerAccess: true,            // false: /subscribers/current refuses Basic
    down: {},                     // path -> true: answer 503
    checkoutUrlHost: 'https://www.juicereel.com',
    nowMs: () => Date.now(),
  };
  let seq = 100;

  function res(status, body) {
    const text = body === undefined ? '' : JSON.stringify(body);
    return Promise.resolve({ ok: status >= 200 && status < 300, status, text: async () => text, json: async () => JSON.parse(text || 'null') });
  }
  function hdr(init, k) {
    const h = (init && init.headers) || {};
    for (const key of Object.keys(h)) if (key.toLowerCase() === k) return String(h[key]);
    return '';
  }
  function basicOk(init) {
    const a = hdr(init, 'authorization');
    const m = /^Basic\s+(.+)$/i.exec(a);
    if (!m) return false;
    const want = Buffer.from(o.clientId + ':' + o.clientSecret).toString('base64');
    return m[1] === want && hdr(init, 'x-oauth-client-id') === o.clientId;
  }
  function bearer(init) {
    const m = /^Bearer\s+(.+)$/i.exec(hdr(init, 'authorization'));
    if (!m || hdr(init, 'x-oauth-client-id') !== o.clientId) return null;
    const t = S.tokens[m[1]];
    return t && t.kind === 'access' && t.expiresMs > S.nowMs() ? t : null;
  }
  function scopesOk(list) {
    return Array.isArray(list) && list.every((x) => typeof x === 'string' && o.approvedScopes.indexOf(x) >= 0)
      && new Set(list).size === list.length;
  }
  function buyer(jrUserId, name) {
    S.users[jrUserId] = { id: jrUserId, displayName: name || ('Buyer ' + jrUserId) };
    return S.users[jrUserId];
  }
  function issueCode(redirectUri, challenge, scopes, jrUserId) {
    const code = 'jrc_' + crypto.randomBytes(12).toString('hex');
    S.codes[code] = { redirectUri, challenge, scopes, jrUserId, expiresMs: S.nowMs() + 60000, used: false };
    return code;
  }
  function subscribe(jrUserId, productId, days) {
    const exp = new Date(S.nowMs() + days * 86400000).toISOString();
    S.subs[jrUserId] = (S.subs[jrUserId] || []).filter((x) => x.productId !== productId)
      .concat([{ productId, expiresDate: exp, status: 'active' }]);
    return exp;
  }
  function currentOf(jrUserId) {
    return (S.subs[jrUserId] || []).filter((x) => x.status === 'active' && Date.parse(x.expiresDate) > S.nowMs());
  }
  /* an older subscription of the same buyer, ended: listed BEFORE the current one */
  function history(jrUserId, productId, endedDaysAgo) {
    S.subs[jrUserId] = [{ productId, expiresDate: new Date(S.nowMs() - endedDaysAgo * 86400000).toISOString(), status: 'ended' }].concat(S.subs[jrUserId] || []);
  }
  /* Juice Reel takes access away before the paid-through date (a refund): the
     entry stays listed with its future expiresDate and isCurrentlySubscribed false */
  function refund(jrUserId, productId) {
    (S.subs[jrUserId] || []).forEach((x) => { if (x.productId === productId) x.status = 'refunded'; });
  }

  /* one subscription as Juice Reel documents it */
  function documented(jrUserId, x) {
    return { subscriptionProductId: x.productId, userId: Number(jrUserId), expiresDate: x.expiresDate,
      isCurrentlySubscribed: x.status === 'active' && Date.parse(x.expiresDate) > S.nowMs(), SubscriptionProduct: { duration: 'MONTHLY' } };
  }

  async function api(url, init) {
    const u = new URL(url);
    const method = (init && init.method) || 'GET';
    S.calls.push({ method, path: u.pathname, auth: /^Basic/i.test(hdr(init, 'authorization')) ? 'basic' : /^Bearer/i.test(hdr(init, 'authorization')) ? 'bearer' : 'none',
      clientHeader: hdr(init, 'x-oauth-client-id') === o.clientId, body: init && typeof init.body === 'string' ? init.body : '' });
    if (S.down[u.pathname]) return res(503, { error: 'unavailable' });

    if (u.pathname === '/checkout/sessions' && method === 'POST') {
      if (!basicOk(init)) return res(401, { error: 'invalid_client' });
      let b; try { b = JSON.parse(init.body); } catch (_) { return res(400, { error: 'invalid_request' }); }
      if (hdr(init, 'content-type').indexOf('application/json') < 0) return res(400, { error: 'invalid_request' });
      if (o.redirectUris.indexOf(b.successUrl) < 0 || o.redirectUris.indexOf(b.cancelUrl) < 0) return res(400, { error: 'invalid_request', message: 'redirect URI is not registered' });
      if (!scopesOk(b.scopes)) return res(400, { error: 'invalid_scope' });
      if (typeof b.state !== 'string' || !b.state || typeof b.codeChallenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(b.codeChallenge)) return res(400, { error: 'invalid_request' });
      const id = crypto.randomUUID();
      S.sessions[id] = { id, successUrl: b.successUrl, cancelUrl: b.cancelUrl, scopes: b.scopes, state: b.state, challenge: b.codeChallenge, done: false };
      return res(201, { checkoutSessionId: id, checkoutUrl: S.checkoutUrlHost + '/checkout/sessions/' + id, expiresAt: new Date(S.nowMs() + 3600000).toISOString() });
    }

    if (u.pathname === '/oauth2/token' && method === 'POST') {
      if (!basicOk(init)) return res(401, { error: 'invalid_client' });
      if (hdr(init, 'content-type').indexOf('application/x-www-form-urlencoded') < 0) return res(400, { error: 'invalid_request' });
      const f = new URLSearchParams(init.body);
      if (f.get('grant_type') !== 'authorization_code') return res(400, { error: 'unsupported_grant_type' });
      const c = S.codes[f.get('code')];
      if (!c || c.used || c.expiresMs < S.nowMs()) return res(400, { error: 'invalid_grant' });
      c.used = true;   // single use, even when the rest is wrong
      if (f.get('redirect_uri') !== c.redirectUri) return res(400, { error: 'invalid_grant' });
      const v = f.get('code_verifier') || '';
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(v) || b64url(crypto.createHash('sha256').update(v).digest()) !== c.challenge) return res(400, { error: 'invalid_grant' });
      const at = 'jra_' + crypto.randomBytes(16).toString('hex'), rt = 'jrr_' + crypto.randomBytes(16).toString('hex');
      S.tokens[at] = { kind: 'access', jrUserId: c.jrUserId, scopes: c.scopes, expiresMs: S.nowMs() + 3600000 };
      S.tokens[rt] = { kind: 'refresh', jrUserId: c.jrUserId, scopes: c.scopes };
      return res(200, { access_token: at, refresh_token: rt, token_type: 'Bearer', expires_in: 3600, scope: c.scopes.join(' ') });
    }

    if (u.pathname === '/oauth2/revoke' && method === 'POST') {
      if (!basicOk(init)) return res(401, { error: 'invalid_client' });
      return res(200, {});
    }

    if (u.pathname === '/oauth2/me' && method === 'GET') {
      if (basicOk(init)) return res(200, { id: o.ownerId, displayName: o.ownerName });
      const t = bearer(init);
      if (!t) return res(401, { error: 'Invalid OAuth access token' });
      const me = S.users[t.jrUserId] || { id: t.jrUserId, displayName: null };
      return res(200, { id: Number(me.id), displayName: me.displayName });
    }

    if (u.pathname === '/oauth2/subscribers/status' && method === 'GET') {
      if (S.statusShape === 'absent') return res(404, { error: 'not_found' });
      const t = bearer(init);
      if (!t) return res(401, { error: 'Invalid OAuth access token' });
      if (t.scopes.indexOf('subscribers.read') < 0) return res(403, { error: 'insufficient_scope' });
      const cur = currentOf(t.jrUserId);
      const entry = (x) => ({ subscriptionProductId: x.productId, expiresDate: x.expiresDate, status: x.status });
      if (S.statusShape === 'documented') {
        if (String(t.jrUserId) === String(o.ownerId)) return res(200, { isCurrentlySubscribed: true });
        if (!cur.length) return res(200, { isCurrentlySubscribed: false });
        return res(200, { isCurrentlySubscribed: true, subscription: documented(t.jrUserId, cur[0]) });
      }
      if (S.statusShape === 'not_subscribed' || !cur.length) return res(200, { isSubscribed: false, subscriptions: [] });
      if (S.statusShape === 'list') return res(200, { subscriptions: cur.map(entry) });
      if (S.statusShape === 'array') return res(200, cur.map(entry));
      if (S.statusShape === 'flag_bare') return res(200, { isSubscribed: true, subscription: { expiresDate: cur[0].expiresDate } });
      if (S.statusShape === 'contradiction') return res(200, { isSubscribed: false, subscription: entry(cur[0]) });
      return res(200, { isSubscribed: true, subscription: entry(cur[0]) });
    }

    if (u.pathname === '/oauth2/subscribers/current' && method === 'GET') {
      if (!S.ownerAccess || !basicOk(init)) return res(401, { error: 'invalid_client' });
      if (S.listShape === 'documented') {
        const ever = [];
        Object.keys(S.subs).sort().forEach((id) => (S.subs[id] || []).forEach((x) => ever.push(Object.assign(documented(id, x),
          { User: { id: Number(id), displayName: (S.users[id] && S.users[id].displayName) || null } }))));
        return res(200, { subscribers: ever });
      }
      const all = [];
      Object.keys(S.subs).sort().forEach((id) => currentOf(id).forEach((x) => all.push({
        subscriberUserId: Number(id), subscriptionProductId: x.productId, expiresDate: x.expiresDate })));
      const start = Number(u.searchParams.get('cursor') ? Buffer.from(u.searchParams.get('cursor'), 'base64').toString() : 0) || 0;
      const page = all.slice(start, start + o.pageSize);
      const more = start + o.pageSize < all.length;
      return res(200, { subscribers: page, nextCursor: more ? Buffer.from(String(start + o.pageSize)).toString('base64') : null, hasMore: more });
    }
    return res(404, { error: 'not_found' });
  }

  /* ── the buyer's side ─────────────────────────────────────────────────── */
  function checkoutIdOf(url) { return String(url).split('/').pop(); }
  /* pay on Juice Reel's checkout, then answer the consent screen */
  function pay(checkoutUrl, jrUserId, p) {
    const q = Object.assign({ productId: 'prod_edgedesk_monthly', days: 30, consent: true, name: null }, p || {});
    const s = S.sessions[checkoutIdOf(checkoutUrl)];
    if (!s || s.done) throw new Error('fake JR: no open checkout session for ' + checkoutUrl);
    s.done = true;
    if (!S.users[jrUserId]) buyer(jrUserId, q.name);
    const exp = subscribe(jrUserId, q.productId, q.days);
    if (!q.consent) return { url: s.cancelUrl + '?status=cancelled&state=' + encodeURIComponent(s.state), expiresDate: exp };
    const code = issueCode(s.successUrl, s.challenge, s.scopes, jrUserId);
    return { url: s.successUrl + '?status=success&code=' + encodeURIComponent(code) + '&state=' + encodeURIComponent(s.state), expiresDate: exp, code };
  }
  function cancel(checkoutUrl) {
    const s = S.sessions[checkoutIdOf(checkoutUrl)];
    s.done = true;
    return { url: s.cancelUrl + '?status=cancelled&state=' + encodeURIComponent(s.state) };
  }
  /* the consent page of a plain account link (GET www.juicereel.com/oauth2/authorize) */
  function authorize(authorizeUrl, jrUserId, name) {
    const u = new URL(authorizeUrl);
    const p = u.searchParams;
    if (u.origin + u.pathname !== 'https://www.juicereel.com/oauth2/authorize') throw new Error('fake JR: not the authorize URL');
    if (p.get('client_id') !== o.clientId || o.redirectUris.indexOf(p.get('redirect_uri')) < 0 || p.get('response_type') !== 'code'
        || p.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(p.get('code_challenge') || '') || !p.get('state')) {
      throw new Error('fake JR: authorize request refused');
    }
    const scopes = String(p.get('scope') || '').split(/\s+/).filter(Boolean);
    if (!scopesOk(scopes)) throw new Error('fake JR: scope not approved');
    if (!S.users[jrUserId]) buyer(jrUserId, name);
    const code = issueCode(p.get('redirect_uri'), p.get('code_challenge'), scopes, jrUserId);
    return { url: p.get('redirect_uri') + '?code=' + encodeURIComponent(code) + '&state=' + encodeURIComponent(p.get('state')) };
  }
  /* one SUBSCRIPTION_EVENTS delivery, signed with X-Juice-Reel-Signature: sha256=<hex> */
  function webhook(type, data, extra) {
    const ev = Object.assign({ id: 'evt_' + (++seq), type, createdAt: new Date(S.nowMs()).toISOString(), data }, extra || {});
    const raw = JSON.stringify(ev);
    const sig = 'sha256=' + crypto.createHmac('sha256', o.webhookSecret).update(raw).digest('hex');
    return { raw, sig, ev };
  }

  return { api, S, o, API, buyer, subscribe, history, refund, pay, cancel, authorize, webhook, issueCode };
}

module.exports = { make, API };
