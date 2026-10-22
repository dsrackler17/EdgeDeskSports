'use strict';
/* ===========================================================================
   A FAKE JUICE REEL for the Juice Reel suites (juicereel.test.js and
   juicereel_ui.e2e.js) — the documented contract, enforced:

     POST /oauth2/token    HTTP Basic client id:secret AND X-OAuth-Client-Id;
                           form-encoded; authorization_code needs the exact
                           redirect_uri and a code_verifier whose S256 is the
                           challenge the code was issued for; a code works
                           once; refresh_token is single-use and REUSING a
                           consumed one revokes the token family (the grant)
    POST /oauth2/revoke    Basic + header; token & token_type_hint; 200 {}
                           whether or not the token existed
    GET  /oauth2/me        Bearer + X-OAuth-Client-Id → { id, displayName };
                           with Basic client id:secret instead (owner access)
                           → the application owner's { id, displayName }, or
                           401 invalid_client for credentials it refuses
    GET  /oauth2/bets/open | /settled | /changed
                           scopes; the documented filters and ordering
                           (descending id; changed: updatedAt desc, id desc);
                           { bets, nextCursor (opaque), hasMore }; a cursor it
                           did not issue → 400 "cursor is invalid"
   Errors take the documented shapes. Everything the fake is asked is logged
   (method, path, query, which auth), so a test can prove what EdgeDesk sent.

   WHAT THIS IS NOT. It is not Juice Reel. It answers in the shapes Juice
   Reel's documentation gives (juicereel.com/api-docs, 2026-10-14); the live
   check is the production smoke test (tools/portfolio/juicereel_smoke.js).
   =========================================================================== */
const crypto = require('crypto');

function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function res(status, body) {
  return new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function make(o) {
  o = o || {};
  const J = {
    clientId: o.clientId || 'jr_test_client_0001', clientSecret: o.clientSecret || 'jrs_test_secret_0001',
    redirects: o.redirects || ['https://edgedesksports.com/oauth/juicereel-callback.html'],
    users: {}, codes: {}, access: {}, refresh: {}, families: {}, calls: [], revokes: [], issued: [],
    pageSize: o.pageSize || 2, fail: {}, grantScopes: null, accessTtl: 3600, deny: false,
    owner: o.owner || { id: 7, displayName: 'EdgeDesk Owner' },
  };
  J.user = function (id, name) { J.users[String(id)] = J.users[String(id)] || { id: +id, displayName: name || ('User ' + id), bets: [] }; return J.users[String(id)]; };
  /* the user approves EdgeDesk on the consent page: a code for this challenge and redirect */
  J.approve = function (authorizeUrl, userId, opts) {
    opts = opts || {};
    const u = new URL(authorizeUrl), q = u.searchParams;
    if (q.get('client_id') !== J.clientId || J.redirects.indexOf(q.get('redirect_uri')) < 0 || q.get('response_type') !== 'code'
        || q.get('code_challenge_method') !== 'S256' || !q.get('state') || !q.get('code_challenge')) {
      return { error: 'invalid_request', state: q.get('state') };
    }
    const code = 'jrc_' + crypto.randomBytes(18).toString('hex');
    const wanted = (q.get('scope') || '').split(/\s+/).filter(Boolean);
    J.codes[code] = { userId: String(userId), challenge: q.get('code_challenge'), redirect: q.get('redirect_uri'), scopes: opts.scopes || J.grantScopes || wanted,
      used: false, exp: Date.now() + 600000 };
    return { code, state: q.get('state'), redirect: q.get('redirect_uri') };
  };
  function issue(userId, scopes, family) {
    const fam = family || ('fam_' + crypto.randomBytes(6).toString('hex'));
    J.families[fam] = J.families[fam] || { revoked: false, userId: String(userId) };
    const at = 'jra_' + crypto.randomBytes(20).toString('hex'), rt = 'jrr_' + crypto.randomBytes(20).toString('hex');
    J.access[at] = { userId: String(userId), family: fam, exp: Date.now() + J.accessTtl * 1000, scopes, active: true };
    J.refresh[rt] = { userId: String(userId), family: fam, used: false, scopes };
    J.issued.push(at, rt);
    return { access_token: at, refresh_token: rt, token_type: 'Bearer', expires_in: J.accessTtl, scope: scopes.join(' ') };
  }
  J.revokeFamily = function (fam) { if (J.families[fam]) J.families[fam].revoked = true; };
  J.familyOfUser = function (userId) { return Object.keys(J.families).filter((f) => J.families[f].userId === String(userId) && !J.families[f].revoked); };
  function basicOk(h) {
    return String(h.authorization || '') === 'Basic ' + Buffer.from(J.clientId + ':' + J.clientSecret).toString('base64');
  }
  function bearer(h) {
    const t = String(h.authorization || '').replace(/^Bearer\s+/, ''), a = J.access[t];
    if (!a || !a.active || a.exp < Date.now() || J.families[a.family].revoked) return null;
    return a;
  }
  /* the documented lists */
  function list(user, name, q) {
    let bets = user.bets.slice();
    const closed = (b) => b.result != null || (b.BetStatus && /closed|cancel/i.test(b.BetStatus.statusName || ''));
    if (name === 'open') {
      bets = bets.filter((b) => !closed(b));
      if (q.get('datePlacedAfter')) bets = bets.filter((b) => b.datePlaced >= new Date(q.get('datePlacedAfter')).toISOString());
      bets.sort((a, b) => b.id - a.id);
    } else if (name === 'settled') {
      bets = bets.filter(closed);
      if (q.get('dateClosedAfter')) bets = bets.filter((b) => b.dateClosed && b.dateClosed >= new Date(q.get('dateClosedAfter')).toISOString());
      if (q.get('dateClosedBefore')) bets = bets.filter((b) => b.dateClosed && b.dateClosed < new Date(q.get('dateClosedBefore')).toISOString());
      bets.sort((a, b) => b.id - a.id);
    } else {
      if (q.get('updatedAtAfter')) bets = bets.filter((b) => b.updatedAt >= new Date(q.get('updatedAtAfter')).toISOString());
      bets.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : b.id - a.id));
    }
    return bets;
  }
  function cursorFor(name, off) { return b64url(JSON.stringify({ l: name, o: off, k: crypto.createHmac('sha256', 'fake').update(name + off).digest('hex').slice(0, 8) })); }
  function readCursor(name, c) {
    try {
      const x = JSON.parse(Buffer.from(String(c).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
      return x.l === name && cursorFor(name, x.o) === c ? x.o : null;
    } catch (_) { return null; }
  }
  J.fetch = async function (u, init) {
    init = init || {};
    const h = {}; Object.keys(init.headers || {}).forEach((k) => { h[k.toLowerCase()] = init.headers[k]; });
    const m = (init.method || 'GET').toUpperCase(), p = u.pathname;
    const auth = /^Basic /.test(h.authorization || '') ? 'basic' : /^Bearer /.test(h.authorization || '') ? 'bearer' : 'none';
    J.calls.push({ m, p, q: Object.fromEntries(u.searchParams), auth, clientHeader: h['x-oauth-client-id'] || null, owner: m === 'GET' && p === '/oauth2/me' && auth === 'basic' });
    /* scripted failures: { '/oauth2/bets/changed': [429, 502] } (0: that call is answered normally) */
    const f = J.fail[p];
    if (f && f.length) { const st = f.shift(); if (st) return res(st, st === 429 ? { error: 'Rate limit exceeded' } : st >= 500 ? { error: 'Internal server error' } : { error: 'scripted' }); }
    if (u.hostname !== 'external-api.juicereel.com') return res(404, { error: 'not found' });
    if (h['x-oauth-client-id'] !== J.clientId) return res(400, { error: 'X-OAuth-Client-Id header is required' });
    if (m === 'POST' && (p === '/oauth2/token' || p === '/oauth2/revoke')) {
      if (!basicOk(h)) return res(401, { error: 'invalid_client', error_description: 'Client authentication failed' });
      if (!/application\/x-www-form-urlencoded/.test(h['content-type'] || '')) return res(400, { error: 'invalid_request' });
      const form = new URLSearchParams(String(init.body || ''));
      if (p === '/oauth2/revoke') {
        const t = form.get('token');
        J.revokes.push({ hint: form.get('token_type_hint'), token: t });
        if (J.refresh[t]) J.revokeFamily(J.refresh[t].family);
        if (J.access[t]) J.access[t].active = false;
        return res(200, {});
      }
      const gt = form.get('grant_type');
      if (gt === 'authorization_code') {
        const c = J.codes[form.get('code')];
        if (!c || c.used || c.exp < Date.now() || c.redirect !== form.get('redirect_uri')
            || b64url(crypto.createHash('sha256').update(String(form.get('code_verifier') || '')).digest()) !== c.challenge) {
          if (c) c.used = true;
          return res(400, { error: 'invalid_grant', error_description: 'The authorization code is invalid, expired, consumed, or PKCE failed' });
        }
        c.used = true;
        return res(200, issue(c.userId, c.scopes));
      }
      if (gt === 'refresh_token') {
        const r = J.refresh[form.get('refresh_token')];
        if (!r || J.families[r.family].revoked) return res(400, { error: 'invalid_grant' });
        if (r.used) { J.revokeFamily(r.family); J.reuse = (J.reuse || 0) + 1; return res(400, { error: 'invalid_grant', error_description: 'refresh token reused; grant revoked' }); }
        r.used = true;
        J.refreshes = (J.refreshes || 0) + 1;
        return res(200, issue(r.userId, r.scopes, r.family));
      }
      return res(400, { error: 'invalid_request' });
    }
    /* owner access: the application's own credentials answer for its owner (only /me is modelled; EdgeDesk reads no bets this way) */
    if (m === 'GET' && p === '/oauth2/me' && auth === 'basic') {
      if (!basicOk(h)) return res(401, { error: 'invalid_client', error_description: 'Client authentication failed' });
      return res(200, { id: J.owner.id, displayName: J.owner.displayName });
    }
    if (m === 'GET' && /^\/oauth2\/(me|bets\/(open|settled|changed))$/.test(p)) {
      const a = bearer(h);
      if (!a) return res(401, { error: 'Invalid OAuth access token' });
      const user = J.users[a.userId];
      if (p === '/oauth2/me') return res(200, { id: user.id, displayName: user.displayName });
      const name = p.split('/').pop();
      const need = name === 'open' ? ['bets.open.read'] : name === 'settled' ? ['bets.settled.read'] : ['bets.open.read', 'bets.settled.read'];
      if (!need.every((s) => a.scopes.indexOf(s) >= 0)) return res(403, { error: 'The access token requires the requested scope' });
      let off = 0;
      if (u.searchParams.get('cursor')) { off = readCursor(name, u.searchParams.get('cursor')); if (off == null) return res(400, { error: 'cursor is invalid' }); }
      const all = list(user, name, u.searchParams), page = all.slice(off, off + J.pageSize), more = off + J.pageSize < all.length;
      return res(200, { bets: JSON.parse(JSON.stringify(page)), nextCursor: more ? cursorFor(name, off + J.pageSize) : null, hasMore: more });
    }
    return res(404, { error: 'not found' });
  };
  return J;
}

/* a Bet in the documented shape (juicereel.com/api-docs, the example response) */
function team(id, name) { return { id, name, displayName: name, oddsJamId: String(id), espnId: String(id) }; }
function subbet(o) {
  o = o || {};
  const home = o.home || 'Atlanta Braves', away = o.away || 'New York Mets', start = o.start || '2026-09-20T23:15:00.000Z';
  return { id: o.id || 1, userId: o.userId || 4, subbetType: o.type || 'Moneyline', position: o.position || away, value: o.value != null ? o.value : 0,
    oddsAmerican: o.odds != null ? o.odds : -110, duration: null, startDate: start, wasLiveBet: !!o.live, description: o.description || (home + ' vs ' + away + ' - X'),
    scrapeDescription: null, metric: o.metric || null, createdAt: '2026-09-20T12:00:00.000Z', updatedAt: '2026-09-20T12:00:00.000Z',
    TruthTeam: team(2, o.position || away), OppTruthTeam: team(1, home), Player: o.player ? { id: 9, name: o.player, displayName: o.player } : null, OppPlayer: null,
    Event: o.event === null ? null : { id: o.eventId || 428, name: null, startDate: start, exactStartTime: null, type: 'Game', status: 'Scheduled', homeTeamId: 1, awayTeamId: 2,
      HomeTeam: team(1, home), AwayTeam: team(2, away), Sport: { id: 1, name: o.sport || 'Baseball' }, League: { id: 2, name: o.league || 'MLB' } },
    BetResult: o.result === undefined ? null : o.result == null ? null : { id: 2, name: o.result }, Sport: { id: 1, name: o.sport || 'Baseball' }, League: { id: 2, name: o.league || 'MLB' } };
}
function bet(id, o) {
  o = o || {};
  const closed = o.result != null;
  return Object.assign({ id, userId: 4, oddsAmerican: -110, amountRisked: 110, toWin: 100, netResult: null, result: null,
    datePlaced: '2026-09-20T13:00:00.000Z', dateClosed: null, isAdjustedOdds: false, isAdjustedLine: false, adjustedRisk: null, clvPct: null,
    createdAt: '2026-09-20T13:05:00.000Z', updatedAt: '2026-09-20T13:05:00.000Z', currencyCode: 'USD', BetType: { id: 1, typeName: 'Straight' },
    BetStatus: closed ? { id: 2, statusName: 'Closed' } : { id: 1, statusName: 'Open' }, Site: { id: 10, name: 'DraftKings' }, Subbets: [subbet({ id: id * 10 })] }, o);
}

module.exports = { make, bet, subbet, b64url };
