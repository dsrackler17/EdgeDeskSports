#!/usr/bin/env node
/* ===========================================================================
   JUICE REEL, END TO END — the SHIPPED portfolio_connect function
   (supabase/functions/portfolio_connect/index.ts) in a stub Deno runtime,
   over the REAL migrations (portfolio.sql → portfolio_journal.sql →
   portfolio_connect.sql → portfolio_aggregator.sql → portfolio_decision.sql →
   portfolio_juicereel.sql) on a throwaway PostgreSQL, against a FAKE Juice
   Reel that enforces the documented contract (tools/portfolio/_fake_juicereel.js).

   WHAT THIS IS NOT. It is not Juice Reel: the fake answers in the shapes Juice
   Reel's documentation gives. The live check is the PRODUCTION smoke test
   (tools/portfolio/juicereel_smoke.js), after Juice Reel approves the app.
   What this DOES prove is everything on EdgeDesk's side of the wire:

     OAUTH     state and PKCE made server-side (S256; the verifier sealed,
               the state stored only as its hash), the exact consent URL and
               scopes (never subscribers.read), the callback accepted only
               from the reader who started it, once, inside 15 minutes; a
               refusal, a replay, an expired or another reader's state, a bad
               code, missing scopes and refused client credentials all end
               with nothing stored (and tokens already issued revoked);
     TOKENS    sealed (no token in any table, response or log line),
               refreshed under a lease so a single-use refresh token is sent
               once however many syncs race, rotated atomically, re-fetched
               after a 401, and an invalid grant → Connection expired,
               nothing retried, history kept;
     SYNC      the initial import (open, then settled; paging; resumable;
               a rejected cursor restarted), incremental reads of
               /bets/changed from the checkpoint, corrections, cancellations,
               a bet moved between books, a daily reconciliation that finds a
               missed settlement, idempotent re-reads, 429 / 5xx backoff;
     LEDGER    every book a Portfolio account (a quick-import account
               upgraded in place, an imported bet adopted), exact money (the
               docs' own 0.5886 example stores −0.5886), parlays with legs,
               the settlement history, and the existing summary / bankroll
               analytics over the synced bets;
     PEOPLE    readers see only their own; another reader can neither read,
               sync nor disconnect them, nor take the same Juice Reel account;
     SWITCH    off for readers until a PASSED PRODUCTION smoke test and a
               cleared terms review; an operator links only under a running
               PRODUCTION smoke test; disconnect revokes at Juice Reel.

   Run: node tools/portfolio/juicereel.test.js
   (PORTFOLIO_SQL_REQUIRED=1 makes a missing PostgreSQL a failure, for CI.)
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const cp = require('child_process');
const vm = require('vm');
const path = require('path');
const nodeCrypto = require('crypto');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const REST = require('./_pgrest.js');
const FAKE = require('./_fake_juicereel.js');
const K = require(path.join(PG.ROOT, 'lib', 'edgedesk_portfolio_connect_core.js'));

const T = PG.kit('juicereel');
const chk = T.chk;
const L = PG.lit;
const FN_FILE = path.join(PG.ROOT, 'supabase', 'functions', 'portfolio_connect', 'index.ts');
const FN_SRC = fs.readFileSync(FN_FILE, 'utf8');
const SQL_FILE = path.join(PG.ROOT, 'supabase', 'portfolio_juicereel.sql');
const SQL = fs.readFileSync(SQL_FILE, 'utf8');
const CALLBACK = fs.readFileSync(path.join(PG.ROOT, 'oauth', 'juicereel-callback.html'), 'utf8');
const { bet, subbet } = FAKE;

/* ═══ STATIC ═════════════════════════════════════════════════════════════ */
chk('every Juice Reel service function asserts its caller first',
  (SQL.match(/create or replace function public\.portfolio_svc_\w+/g) || []).length === (SQL.match(/perform public\.portfolio_svc_assert\(\);/g) || []).length);
chk('the Juice Reel seed never writes automatic_enabled', !/automatic_enabled\s*=\s*excluded/.test(SQL) && !/insert into public\.portfolio_platform_registry \([^)]*automatic_enabled/.test(SQL));
chk('portfolio_connect carries the current core (Juice Reel included)', require('./inline_connect_core.js').inSync() && /JUICEREEL/.test(FN_SRC));
chk('every Juice Reel request is DOCUMENTED; reads are GETs, the client secret goes only to token, revoke and the owner check (GET /oauth2/me) — never to a bet list',
  Object.keys(K.JUICEREEL.contract).every((k) => K.JUICEREEL.contract[k].seen === 'DOCUMENTED')
    && Object.keys(K.JUICEREEL.contract).filter((k) => K.JUICEREEL.contract[k].auth === 'basic').sort().join() === 'owner,revoke,token'
    && K.JUICEREEL.contract.owner.method === 'GET' && K.JUICEREEL.contract.owner.path === '/oauth2/me'
    && Object.keys(K.JUICEREEL.contract).filter((k) => /bets/.test(K.JUICEREEL.contract[k].path || '')).every((k) => K.JUICEREEL.contract[k].auth === 'bearer')
    && ['me', 'open', 'settled', 'changed'].every((k) => K.JUICEREEL.contract[k].method === 'GET' && K.JUICEREEL.contract[k].auth === 'bearer'));
chk('EdgeDesk asks only for the two bet scopes: never subscribers.read, the subscriber endpoints, checkout or a subscription webhook',
  JSON.stringify(K.JUICEREEL.scopes) === '["bets.open.read","bets.settled.read"]'
    && !/subscribers\/(current|status)|checkout\/sessions|SUBSCRIPTION_/.test(JSON.stringify(K.JUICEREEL.contract))
    && !fs.existsSync(path.join(PG.ROOT, 'supabase', 'functions', 'juicereel-webhook')));
chk('the documented endpoints and hosts', K.JUICEREEL.authorize === 'https://www.juicereel.com/oauth2/authorize' && K.JUICEREEL.api === 'https://external-api.juicereel.com'
  && K.JUICEREEL.contract.token.path === '/oauth2/token' && K.JUICEREEL.contract.revoke.path === '/oauth2/revoke' && K.JUICEREEL.contract.changed.path === '/oauth2/bets/changed');
chk('Juice Reel is an aggregator, not a sportsbook with a direct connection', K.aggregatorInfo('juicereel') === K.JUICEREEL
  && K.REGISTRY.filter((p) => p.source_type === 'SPORTSBOOK').every((p) => p.automatic === null));
(function partsAreCurrent() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfj-parts-'));
  cp.execFileSync(process.execPath, [path.join(PG.ROOT, 'tools', 'sql', 'split_sql.js'), SQL_FILE, dir, '18000']);
  const fresh = fs.readdirSync(dir).filter((f) => /^portfolio_juicereel\.part/.test(f)).sort();
  const committed = fs.readdirSync(path.join(PG.ROOT, 'supabase', 'parts')).filter((f) => /^portfolio_juicereel\.part/.test(f)).sort();
  chk('supabase/parts/portfolio_juicereel.part*.sql are current (npm run portfolio:parts)', fresh.length > 0 && JSON.stringify(fresh) === JSON.stringify(committed)
    && fresh.every((f) => fs.readFileSync(path.join(dir, f), 'utf8') === fs.readFileSync(path.join(PG.ROOT, 'supabase', 'parts', f), 'utf8')), { fresh, committed });
  fs.rmSync(dir, { recursive: true, force: true });
}());

/* the callback page: no third-party resource, no referrer, code and state out of the address first */
(function callbackPage() {
  const srcs = (CALLBACK.match(/\b(?:src|href)\s*=\s*"([^"]*)"/g) || []).map((x) => x.replace(/^.*="|"$/g, ''));
  chk('the callback page loads nothing from anywhere (its one link is this site\'s own app)', srcs.every((s) => /^\/app\.html/.test(s)) && !/<script[^>]+src=/i.test(CALLBACK)
    && !/fetch\(|XMLHttpRequest|sendBeacon/.test(CALLBACK), srcs);
  chk('…sends no referrer, is not indexed, and runs under a strict CSP', /name="referrer" content="no-referrer"/.test(CALLBACK) && /noindex/.test(CALLBACK)
    && /default-src 'none'/.test(CALLBACK) && /form-action 'none'/.test(CALLBACK));
  const run = (search, opts) => {
    opts = opts || {};
    const store = {}, calls = [], el = {};
    const doc = { getElementById: (id) => (el[id] = el[id] || { textContent: '' }) };
    const win = { location: { search, pathname: '/oauth/juicereel-callback.html', replace: (u) => calls.push(['replace', u]) },
      history: { replaceState: (a, b, u) => calls.push(['replaceState', u]) },
      sessionStorage: { setItem: (k, v) => { if (opts.blocked) throw new Error('blocked'); calls.push(['setItem', k]); store[k] = v; } } };
    const script = CALLBACK.split('<script>')[1].split('</script>')[0];
    vm.runInNewContext(script, { window: win, document: doc, URLSearchParams, JSON, Date, String });
    return { store, calls, el };
  };
  const ok = run('?code=jrc_abc123&state=' + 'S'.repeat(43));
  const saved = JSON.parse(ok.store['edgedesk.jr.callback'] || 'null');
  chk('callback: the address is cleaned BEFORE anything is stored, then the app takes over (?juicereel=return), the code and state handed over in this tab only',
    ok.calls[0][0] === 'replaceState' && ok.calls[0][1] === '/oauth/juicereel-callback.html' && ok.calls[1][0] === 'setItem'
      && ok.calls[2][1] === '/app.html?juicereel=return#portfolio/accounts' && saved.code === 'jrc_abc123' && saved.state === 'S'.repeat(43) && saved.error === null, ok.calls);
  const den = JSON.parse(run('?error=access_denied&state=' + 'S'.repeat(43) + '&code=ignored').store['edgedesk.jr.callback']);
  const can = JSON.parse(run('?status=cancelled&state=' + 'S'.repeat(43)).store['edgedesk.jr.callback']);
  chk('callback: a refusal (error=…, or status=cancelled) is handed over as a refusal, never with a code', den.error === 'access_denied' && den.code === null && can.error === 'cancelled' && can.code === null);
  const none = run(''), blocked = run('?code=x&state=' + 'S'.repeat(43), { blocked: true });
  chk('callback: nothing to finish, or storage blocked → said plainly, no redirect', !none.calls.some((c) => c[0] === 'replace') && /Nothing was connected/.test(none.el.title.textContent)
    && !blocked.calls.some((c) => c[0] === 'replace') && /blocked the storage/.test(blocked.el.msg.textContent));
}());

/* ═══ OFFLINE: PKCE, the consent URL, the normalizer ═════════════════════ */
(async function offline() {
  const p = await K.jrPkce(), p2 = await K.jrPkce();
  const s256 = FAKE.b64url(nodeCrypto.createHash('sha256').update(p.verifier).digest());
  chk('PKCE: a 43-character verifier (32 random bytes), its S256 challenge, a 43-character state and its SHA-256 for the database',
    /^[A-Za-z0-9_-]{43}$/.test(p.verifier) && p.challenge === s256 && K.JR_STATE_RE.test(p.state)
      && p.state_hash === nodeCrypto.createHash('sha256').update(p.state).digest('hex') && p.verifier !== p2.verifier && p.state !== p2.state && p.state !== p.verifier);
  const url = new URL(K.jrAuthorizeUrl({ clientId: 'jr_c', redirectUri: 'https://edgedesksports.com/oauth/juicereel-callback.html' }, p));
  chk('the consent URL is exactly the documented one', url.origin + url.pathname === 'https://www.juicereel.com/oauth2/authorize'
    && url.searchParams.get('client_id') === 'jr_c' && url.searchParams.get('redirect_uri') === 'https://edgedesksports.com/oauth/juicereel-callback.html'
    && url.searchParams.get('response_type') === 'code' && url.searchParams.get('scope') === 'bets.open.read bets.settled.read' && url.searchParams.get('state') === p.state
    && url.searchParams.get('code_challenge') === p.challenge && url.searchParams.get('code_challenge_method') === 'S256' && !url.searchParams.has('code_verifier'), url.toString());

  /* the docs' own example bet, verbatim */
  const docs = { id: 9531, userId: 4, oddsAmerican: 114, amountRisked: 0.5886, toWin: 0.6714, netResult: -0.5886, result: 'Lost', datePlaced: '2026-08-11T13:32:26.434Z',
    dateClosed: '2026-08-11T23:15:00.000Z', isAdjustedOdds: false, isAdjustedLine: false, adjustedRisk: null, clvPct: null, createdAt: '2026-08-26T20:35:17.972Z',
    updatedAt: '2026-08-26T20:35:17.972Z', currencyCode: 'USD', BetType: { id: 1, typeName: 'Straight' }, BetStatus: { id: 2, statusName: 'Closed' }, Site: { id: 1589, name: 'NoVig' },
    Subbets: [subbet({ id: 13345, type: 'Moneyline', position: 'New York Mets', odds: 114, start: '2026-08-11T23:15:00.000Z', home: 'Atlanta Braves', away: 'New York Mets', result: 'Lost' })] };
  const r = K.juicereelNormalize([
    docs,
    bet(101, { result: 'Won', netResult: 100, dateClosed: '2026-09-20T23:00:00.000Z' }),
    bet(102, { BetType: { id: 2, typeName: 'Parlay' }, oddsAmerican: 264, amountRisked: 10, toWin: 26.4, result: 'Won', netResult: 10, dateClosed: '2026-09-21T03:00:00.000Z',
      Subbets: [subbet({ id: 1, position: 'Kansas City Chiefs', home: 'Kansas City Chiefs', away: 'Miami Dolphins', league: 'NFL', sport: 'Football', result: 'Won', odds: -150 }),
        subbet({ id: 2, type: 'Total', position: 'Over', value: 47.5, home: 'Buffalo Bills', away: 'New York Jets', league: 'NFL', sport: 'Football', result: 'Push', eventId: 429 })] }),
    bet(103, { result: 'Push', netResult: 0, dateClosed: '2026-09-21T00:00:00.000Z', Subbets: [subbet({ type: 'Spread', position: 'New York Mets', value: -1.5 })] }),
    bet(104, { result: 'Cancelled', BetStatus: { id: 3, statusName: 'Cancelled' }, dateClosed: '2026-09-21T00:00:00.000Z' }),
    bet(105, { result: 'Cashed Out', dateClosed: '2026-09-21T00:00:00.000Z' }),
    bet(106, { datePlaced: null }),
    bet(107, { currencyCode: 'EUR' }),
    bet(108, { oddsAmerican: null, toWin: 150, amountRisked: 100 }),
    bet(109, { Site: null }),
    bet(110, { result: 'Won', netResult: 50, dateClosed: '2026-09-20T12:00:00.000Z', datePlaced: '2026-09-20T13:00:00.000Z', Subbets: [subbet({ live: true })] }),
    bet(111, { adjustedRisk: 55 }),
    bet(112, { result: 'Lost', netResult: -200, amountRisked: 110, dateClosed: '2026-09-21T00:00:00.000Z' }),
    bet(113, { result: 'Half Won', netResult: 50, dateClosed: '2026-09-21T00:00:00.000Z' }),
    bet(114, { result: 'Graded', netResult: 12.34, dateClosed: '2026-09-21T00:00:00.000Z' }),
    bet(115, { userId: 77 }),
    bet(101, { result: 'Lost', netResult: -110, dateClosed: '2026-09-20T23:00:00.000Z', updatedAt: '2026-09-19T00:00:00.000Z' }),
    bet(116, { Subbets: [subbet({ type: 'Player Prop', position: 'Over', value: 250.5, player: 'Patrick Mahomes', metric: 'Passing Yards', league: 'NFL', sport: 'Football' })] })
  ], { providerUserId: '4' });
  const by = {}, books = {};
  r.books.forEach((b) => { books[b.platform] = b; b.positions.forEach((x) => { by[x.external_position_id] = x; }); });
  const d = by['juicereel:9531'];
  chk('the docs\' own example (risk 0.5886, net −0.5886): stake rounded UP to $0.59, payout $0.0014 — so the stored P&L is exactly −0.5886; filed under NoVig',
    d && d.stake === '0.59' && d.reported_payout === '0.0014' && d.status === 'LOST' && d.platform === 'novig' && d.odds_american === 114 && r.stats.rounded === 1, d);
  chk('…its event, market, pick and sport from the Subbet: "New York Mets at Atlanta Braves", Moneyline, MLB', d.event_name === 'New York Mets at Atlanta Braves' && d.market_name === 'Moneyline'
    && d.selection === 'New York Mets' && d.position_type === 'MONEYLINE' && d.sport === 'MLB' && d.line === null && d.event_id === 'juicereel:event:428', d);
  chk('a straight win pays stake + netResult', by['juicereel:101'].status === 'WON' && by['juicereel:101'].reported_payout === '210' && by['juicereel:101'].stake === '110');
  const pl = by['juicereel:102'];
  chk('a parlay: PARLAY with each leg (EdgeDesk\'s leg shape) and its result, the event names, payout = stake + net', pl.position_type === 'PARLAY' && pl.market_name === 'Parlay (2 legs)'
    && pl.legs.length === 2 && pl.legs[1].result === 'PUSH' && pl.legs[1].selection === 'Over 47.5' && pl.legs[1].line === '47.5' && pl.reported_payout === '20' && pl.sport === 'NFL', pl);
  chk('a push returns the stake; a spread carries its line; a cancelled bet is VOID', by['juicereel:103'].status === 'PUSH' && by['juicereel:103'].reported_payout === '110'
    && by['juicereel:103'].selection === 'New York Mets -1.5' && by['juicereel:103'].position_type === 'SPREAD' && by['juicereel:104'].status === 'VOID' && by['juicereel:104'].reported_payout === null);
  chk('no American odds: the price comes from to-win ÷ risk, exactly', by['juicereel:108'].odds_american === null && by['juicereel:108'].odds_decimal === '2.5');
  chk('no sportsbook named: its own account, "Juice Reel (no sportsbook named)"', books.custom_juicereel && by['juicereel:109'].platform_label === 'Juice Reel (no sportsbook named)');
  chk('a live bet whose close is reported before its placement settles at its placement (never before it), and is counted', by['juicereel:110'].settled_at === '2026-09-20T13:00:00.000Z'
    && r.stats.closed_before_placed === 1 && r.stats.live_legs === 1);
  chk('a half win is WON at the book\'s payout; an unknown result word with a net result is SETTLED at exactly that P&L', by['juicereel:113'].status === 'WON' && by['juicereel:113'].reported_payout === '160'
    && by['juicereel:114'].status === 'SETTLED' && by['juicereel:114'].reported_payout === '122.34');
  chk('the same bet twice in one read keeps its NEWEST version', by['juicereel:101'].status === 'WON');
  chk('a player prop: the player, side, line and metric', by['juicereel:116'].position_type === 'PLAYER_PROP' && by['juicereel:116'].selection === 'Patrick Mahomes Over 250.5 Passing Yards'
    && by['juicereel:116'].market_name === 'Player Prop · Passing Yards', by['juicereel:116']);
  const codes = [].concat(r.issues, ...r.books.map((b) => b.issues)).map((x) => x.code + ':' + x.ref).sort().join(',');
  chk('skipped and listed, never guessed: a cash-out with no amount, no placement time, a non-USD bet, losing more than the stake, another user\'s bet; an adjusted risk is stored and flagged',
    codes === 'ADJUSTED_RISK:111,CURRENCY_UNSUPPORTED:107,MALFORMED_BET:112,NOT_THIS_USER:115,NO_PAYOUT:105,NO_PLACED_TIME:106' && r.skipped === 5
      && !by['juicereel:105'] && !by['juicereel:106'] && !by['juicereel:107'] && !by['juicereel:112'] && !by['juicereel:115'] && by['juicereel:111'], codes);
  chk('the checkpoint candidate is the newest updatedAt seen', r.max_updated_at === '2026-09-20T13:05:00.000Z');
  const tok = K.jrTokenSet({ access_token: 'jra_aaaaaaaaaaaa', refresh_token: 'jrr_bbbbbbbbbbbb', token_type: 'Bearer', expires_in: 3600, scope: 'bets.open.read bets.settled.read' }, Date.parse('2026-10-14T00:00:00Z'));
  chk('a token answer: the pair, its expiry from expires_in, the granted scopes', tok.expires_at === '2026-10-14T01:00:00.000Z' && tok.scopes.length === 2);
  let bad = null; try { K.jrTokenSet({ access_token: 'x' }, 0); } catch (e) { bad = e.code; }
  chk('a malformed token answer is refused, not stored', bad === 'JR_CONTRACT');
  const red = JSON.stringify(K.redact({ authorization: 'Basic abcdefghijkl', note: 'Bearer jra_aaaaaaaaaaaaaaaa and jrs_secretsecret', code_verifier: 'v'.repeat(43), client_secret: 's' }));
  chk('anything that might be logged loses its tokens, Basic credentials, verifier and secret', !/jra_a|jrs_s|abcdefghijkl|vvvvvvvv/.test(red) && !/"client_secret":"s"/.test(red), red);
  /* the sportsbook provider seam (docs/sportsbook-sync-providers.md) */
  const jp = K.sportsbookProvider('juicereel');
  chk('Juice Reel is registered in the shared sportsbook provider registry: ACTIVE, the whole contract, its own linking origin, grant-level, never placing orders',
    jp && jp.status === 'ACTIVE' && K.SPORTSBOOK_PROVIDER_CONTRACT.every((m) => typeof jp[m] === 'function') && jp.link_origin === 'https://www.juicereel.com'
      && jp.grant_level === true && typeof jp.sweep === 'function' && !jp.places_orders && jp.normalize === K.juicereelNormalize && K.sportsbookProvider('sharpsports').status === 'RETIRED');
  chk('…active only where the server names it (SPORTSBOOK_SYNC_PROVIDER)', K.activeSportsbookProvider({ sportsbook: 'juicereel' }, 'juicereel') === jp
    && K.activeSportsbookProvider({ sportsbook: null }, 'juicereel') === null && K.activeSportsbookProvider({ sportsbook: 'sharpsports' }, 'juicereel') === null);
  const shown = K.jrAccountState({ grant_id: 'g', status: 'CONNECTED', display_name: 'X', smoke_test: 's', ciphertext_b64: 'c', provider_user_id: '4', books: 2 }, { operator: false });
  chk('…its account state: what a reader may see of a connection — never an id, a token, ciphertext or a smoke test', shown.status === 'CONNECTED' && shown.books === 2
    && !('grant_id' in shown) && !('ciphertext_b64' in shown) && !('provider_user_id' in shown) && !('smoke_test' in shown)
    && K.jrAccountState({ smoke_test: 's' }, { operator: true }).smoke_test === 's');
  chk('…no bet webhooks (Juice Reel has none; the changed feed is read on a schedule)', K.sportsbookProvider('juicereel').webhookRefs('BACT_abcdef').none === true);
}()).then(uiRender).then(live).catch((e) => { chk('unexpected failure (offline)', false, String(e && e.stack || e).slice(0, 1500)); process.exit(T.done()); });

/* ═══ THE ACCOUNTS TAB, rendered in Node: every connection state, honestly ═══ */
function uiRender() {
  const UI = require(path.join(PG.ROOT, 'lib', 'edgedesk_portfolio_ui.js'));
  const now = Date.parse('2026-10-14T18:00:00Z');
  const base = Object.assign(UI.defaults(), { tab: 'accounts', positions: [{ id: 'p1' }], registry: {}, runs: [], now, setup: { selected: {}, open: true } });
  const prov = { key: 'juicereel', label: 'Juice Reel', what_the_reader_gives: K.JUICEREEL.what_the_reader_gives, scopes: K.JUICEREEL.scopes };
  const jr = (o, g) => Object.assign({ ok: true, available: true, reason: null, approval: 'ENABLED', operator: false, environment: 'production', provider: prov, grant: g || null }, o || {});
  const grant = (o) => Object.assign({ status: 'CONNECTED', display_name: 'Sharp Bettor', scopes: K.JUICEREEL.scopes, connected_at: '2026-10-14T17:00:00Z', last_sync_at: '2026-10-14T17:58:00Z',
    last_success_at: '2026-10-14T17:58:00Z', next_sync_at: '2026-10-14T18:18:00Z', last_error_code: null, last_error: null, consecutive_failures: 0, syncing: false, imported: true,
    issues: [], books: 3, open_bets: 2 }, o || {});
  /* the page loads sb_status and jr_status; with Juice Reel the server's provider, both answer for it */
  const sb = (j) => (j && j.reason !== 'SYNC_OFF' ? { ok: true, available: j.available, environment: 'production', operator: j.operator, reason: j.reason,
    provider: { key: 'juicereel', label: 'Juice Reel', short: 'Juice Reel', link_origin: 'https://www.juicereel.com', what_the_reader_gives: K.JUICEREEL.what_the_reader_gives } }
    : { ok: true, available: false, reason: 'SYNC_OFF', provider: null });
  const view = (S) => UI.render.accounts(Object.assign({}, base, { accounts: [], sbBooks: [], sbSync: sb(S.juicereel) }, S));
  const stateOf = (h) => ((/data-r="jr-state" data-state="([A-Z_]+)"/.exec(h) || [])[1]);
  const off = view({ juicereel: null });
  chk('UI: without Juice Reel on the server, no Juice Reel panel and the sportsbook copy is unchanged', off.indexOf('data-r="juicereel"') < 0 && /Sportsbooks · import/.test(off) && !/jr-connect/.test(off));
  const wait = view({ juicereel: jr({ available: false, reason: 'awaiting_approval', approval: 'PENDING', message: K.ERRORS.JR_AWAITING_APPROVAL }) });
  chk('UI: a reader before approval sees "Awaiting provider approval", a disabled Connect, the import fallback — and no way to start linking',
    stateOf(wait) === 'AWAITING_APPROVAL' && /Awaiting provider approval/.test(wait) && /<button class="pfo-btn ghost" disabled aria-disabled="true"[^>]*>Connect Juice Reel/.test(wait)
      && !/data-act="jr-connect"/.test(wait) && /awaiting Juice Reel/.test(wait) && /Sportsbooks · import/.test(wait) && !/\bConnected\b/.test(wait));
  const none = view({ juicereel: jr() });
  chk('UI: available and not connected → "Not connected", Connect Juice Reel, what EdgeDesk reads, never a password field',
    stateOf(none) === 'NOT_CONNECTED' && /data-act="jr-connect">Connect Juice Reel/.test(none) && /open and settled bets/.test(none) && /never sees your Juice Reel or sportsbook password/.test(none)
      && !/type="password"|name="password"|name="username"/.test(none) && /Sportsbooks · connect or import/.test(none) && /Automatic — Juice Reel/.test(none) && !/\bConnected as\b/.test(none));
  const picked = view({ juicereel: jr(), setup: { pick: 'fanduel', open: true } });
  chk('UI: a sportsbook tile, Juice Reel on: its card connects through Juice Reel (the seam\'s sb-link, which opens Juice Reel\'s consent page) or imports a file',
    /data-act="sb-link" data-platform="fanduel"[^>]*>Connect FanDuel/.test(picked) && /Import a file instead/.test(picked));
  chk('UI: Connecting while the consent page opens, and while the return is checked', stateOf(view({ juicereel: jr(), jrBusy: true })) === 'CONNECTING'
    && /Finishing your Juice Reel connection/.test(view({ juicereel: jr(), jrReturn: { busy: true } })));
  const con = view({ juicereel: jr({}, grant()) });
  chk('UI: Connected only from the server\'s CONNECTED grant: who, when last synchronized, next, books, open bets; Sync now; Disconnect; delete',
    stateOf(con) === 'CONNECTED' && /Connected as Sharp Bettor · last synchronized 2 min ago/.test(con) && /3 sportsbooks · 2 open bets/.test(con)
      && /data-act="jr-sync"/.test(con) && /data-act="jr-disconnect">Disconnect Juice Reel/.test(con) && /data-act="jr-disconnect" data-delete="1"/.test(con), con.slice(con.indexOf('data-r="juicereel"'), con.indexOf('data-r="juicereel"') + 900));
  chk('UI: Syncing while a sync runs; the first import says so', stateOf(view({ juicereel: jr({}, grant({ syncing: true })) })) === 'SYNCING'
    && /importing your Juice Reel history/.test(view({ juicereel: jr({}, grant({ last_success_at: null, syncing: true })) })));
  const exp = view({ juicereel: jr({}, grant({ status: 'ACTION_REQUIRED', last_error_code: 'GRANT_EXPIRED', last_error: K.ERRORS.GRANT_EXPIRED })) });
  chk('UI: an invalid grant → "Connection expired", in plain words, Reconnect, no Sync now', stateOf(exp) === 'EXPIRED' && /Connection expired/.test(exp) && /Reconnect Juice Reel to resume syncing/.test(exp)
    && /data-act="jr-connect">Reconnect Juice Reel/.test(exp) && !/data-act="jr-sync"/.test(exp));
  const act = view({ juicereel: jr({}, grant({ status: 'ACTION_REQUIRED', last_error_code: 'JR_SCOPE_MISSING', last_error: K.ERRORS.JR_SCOPE_MISSING })) });
  chk('UI: a narrowed grant → "Action required"', stateOf(act) === 'ACTION_REQUIRED' && /both your open and your settled bets/.test(act));
  const err = view({ juicereel: jr({}, grant({ status: 'ERROR', consecutive_failures: 5, last_error: K.ERRORS.PLATFORM_DOWN })) });
  chk('UI: five failures → "Sync failing", EdgeDesk keeps retrying', stateOf(err) === 'ERROR' && /Sync failing/.test(err) && /keeps retrying/.test(err));
  const dis = view({ juicereel: jr({}, grant({ status: 'DISCONNECTED' })) });
  chk('UI: Disconnected — history kept, Connect again', stateOf(dis) === 'DISCONNECTED' && /history is kept/.test(dis) && /data-act="jr-connect"/.test(dis));
  const ret = view({ juicereel: jr({}, grant()), jrReturn: { ok: true, display_name: 'Sharp Bettor', sync: { status: 'SUCCEEDED', complete: true, totals: { positions_inserted: 7, positions_adopted: 1 }, books: [{ label: 'DraftKings' }, { label: 'FanDuel' }] } } });
  chk('UI: back from Juice Reel, the first sync in words', /Juice Reel connected as Sharp Bettor\. First sync: 7 bets imported \(1 matched to bets you had already recorded\) from DraftKings, FanDuel\./.test(ret));
  const card = view({ juicereel: jr({}, grant()), accounts: [{ id: 'a1', platform: 'draftkings', platform_label: 'DraftKings', platform_type: 'SPORTSBOOK', connection_type: 'AGGREGATOR',
    ingestion_method: 'AUTHORIZED_API', status: 'CONNECTED', positions: 4, open_positions: 1, last_success_at: '2026-10-14T17:58:00Z' }],
    connections: { a1: { id: 'a1', metadata: { provider: 'juicereel', environment: 'production', provider_state: { provider: 'juicereel', site: { id: '10', name: 'DraftKings' } } } } } });
  chk('UI: a Juice Reel book\'s card: "Juice Reel", synced through the one connection, Sync now — no per-book disconnect, no SharpSports words',
    /Sportsbook · Juice Reel · 4 positions/.test(card) && /Synced through your Juice Reel connection · DraftKings in Juice Reel/.test(card) && /data-act="acct-sync" data-id="a1"/.test(card)
      && !/data-act="acct-disconnect" data-id="a1"/.test(card) && !/sb-refresh|SharpSports/.test(card), card.slice(card.indexOf('pfo-acct"'), card.indexOf('pfo-acct"') + 900));
  /* the server's switch off: SPORTSBOOK_SYNC_PROVIDER unset */
  const offNone = view({ juicereel: jr({ available: false, reason: 'SYNC_OFF', approval: null, message: K.ERRORS.SYNC_OFF }) });
  chk('UI: sportsbook sync switched off and no connection: no Juice Reel panel, nothing to connect', offNone.indexOf('data-r="juicereel"') < 0 && !/jr-connect|sb-link/.test(offNone));
  const offHeld = view({ juicereel: jr({ available: false, reason: 'SYNC_OFF', approval: null, message: K.ERRORS.SYNC_OFF }, grant()) });
  chk('UI: switched off with a connection still held: "Sync off", history kept, Disconnect (and revoke) — no Sync now, no Connect',
    stateOf(offHeld) === 'SYNC_OFF' && /Sync off/.test(offHeld) && /history is kept/.test(offHeld) && /revoke it at Juice Reel/.test(offHeld)
      && /data-act="jr-disconnect">Disconnect Juice Reel/.test(offHeld) && !/data-act="jr-sync"|data-act="jr-connect"/.test(offHeld));
}

/* ═══ LIVE: the shipped function over the real SQL ═══════════════════════ */
async function live() {
  const db = PG.start('jrl');
  if (db.skip) {
    if (process.env.PORTFOLIO_SQL_REQUIRED === '1') chk('a PostgreSQL cluster starts (required in CI)', false, db.skip);
    console.log('NOTE | ' + db.skip + ' — LIVE layer skipped');
    process.exit(T.done());
  }
  const OP = 'e7e46801-80c4-4f47-b718-4aff211c8d3a';   // an operator (portfolio_is_admin's fallback)
  const B = '00000000-0000-0000-0000-00000000000b', C = '00000000-0000-0000-0000-00000000000c';
  const SB = 'https://project.supabase.co', SERVICE = 'service-role-key-for-tests', ANON = 'anon-key-for-tests';
  const TOKENS = { 'tok-op': OP, 'tok-b': B, 'tok-c': C };
  const one = (s) => String(s).split('\n')[0];
  const jq = (s) => JSON.parse(String(s).trim() || 'null');
  const count = (sql) => +db.sql(sql);
  const J = FAKE.make({ pageSize: 2 });
  const op = J.user(4, 'Sharp Bettor'), b77 = J.user(77, 'Reader B'), c55 = J.user(55, 'Reader C');
  try {
    for (const f of ['portfolio.sql', 'portfolio_journal.sql', 'portfolio_connect.sql', 'portfolio_aggregator.sql', 'portfolio_decision.sql', 'portfolio_juicereel.sql']) {
      const out = db.applyFileAtomic(path.join(PG.ROOT, 'supabase', f));
      if (/CHECK THIS/.test(out)) chk(f + ' reports ok', false, out.split('\n').filter((l) => /CHECK THIS/.test(l)));
    }
    const again = db.applyFileAtomic(SQL_FILE);
    const reapplied = ['portfolio.sql', 'portfolio_journal.sql'].map((f) => db.applyFileAtomic(path.join(PG.ROOT, 'supabase', f))).join('\n');
    chk('portfolio_juicereel.sql applied twice reports ok; re-applying portfolio.sql and portfolio_journal.sql afterwards opens no Juice Reel function to readers',
      !/CHECK THIS/.test(again) && !/CHECK THIS/.test(reapplied) && db.sql(`select count(*) from pg_proc where proname like 'portfolio_svc_jr%' and has_function_privilege('authenticated', oid, 'execute');`) === '0');
    db.sql(`insert into auth.users (id, email) values (${L(OP)}, 'op@example.com'), (${L(B)}, 'b@example.com'), (${L(C)}, 'c@example.com');`);
    const rest = REST.make(db, { tokens: Object.assign({ [SERVICE]: 'service_role' }, TOKENS) });

    const logs = [], fnResponses = [];
    const KEYS = { 1: Buffer.alloc(32, 9).toString('base64') };
    function load(env) {
      let handler = null;
      const sandbox = { Deno: { env: { get: (k) => env[k] }, serve: (h) => { handler = h; } }, fetch: (u, i) => fakeFetch(u, i), Response, Request, Headers, URL, URLSearchParams,
        TextEncoder, TextDecoder, crypto: globalThis.crypto, btoa, atob, AbortController, setTimeout, clearTimeout,
        console: { log: (x) => logs.push(String(x)), error: (x) => logs.push(String(x)) } };
      sandbox.globalThis = sandbox; sandbox.self = sandbox;
      vm.runInNewContext(FN_SRC, sandbox, { filename: 'portfolio_connect/index.ts' });
      return handler;
    }
    const env = { SB_URL: SB, SB_SERVICE_ROLE: SERVICE, SUPABASE_ANON_KEY: ANON, PORTFOLIO_CREDENTIAL_KEYS: JSON.stringify(KEYS), PORTFOLIO_CREDENTIAL_KEY_VERSION: '1',
      JUICE_REEL_CLIENT_ID: J.clientId, JUICE_REEL_CLIENT_SECRET: J.clientSecret, SPORTSBOOK_SYNC_PROVIDER: 'juicereel',
      /* SharpSports keys still present, as in production today: retired, they must not be used */
      SHARPSPORTS_API_KEY: 'ss-private-should-not-be-used', SHARPSPORTS_PUBLIC_KEY: 'ss-public-should-not-be-used' };
    let fn = null, hostsSeen = {};
    async function fakeFetch(url, init) {
      init = init || {};
      const u = new URL(url), h = init.headers || {}, auth = String(h.authorization || h.Authorization || '').replace(/^Bearer\s+/i, '');
      hostsSeen[u.hostname] = (hostsSeen[u.hostname] || 0) + 1;
      if (u.origin === SB && u.pathname === '/auth/v1/user') return TOKENS[auth] ? new Response(JSON.stringify({ id: TOKENS[auth] }), { status: 200 }) : new Response('{}', { status: 401 });
      if (u.origin === SB && u.pathname.indexOf('/rest/v1/') === 0) {
        const p = decodeURIComponent(u.pathname.slice('/rest/v1/'.length));
        const out = rest.handle(init.method || 'GET', p, u.search.slice(1), init.body ? JSON.parse(init.body) : null, h.prefer || '', auth);
        return new Response(out.body == null ? '' : JSON.stringify(out.body), { status: out.status });
      }
      if (u.hostname === 'external-api.juicereel.com') return J.fetch(u, init);
      throw new Error('no network: ' + url);
    }
    fn = load(env);
    const call = async (body, token) => {
      const r = await fn(new Request('https://fn.local/portfolio_connect', { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' },
        token ? { authorization: 'Bearer ' + token } : {}), body: JSON.stringify(body || {}) }));
      const out = { status: r.status, body: await r.json() };
      fnResponses.push(JSON.stringify(out.body));
      return out;
    };
    /* the whole browser round trip: start → Juice Reel's consent (the user approves as jrUser) → callback */
    async function connectAs(token, jrUser, o) {
      o = o || {};
      const s = await call(Object.assign({ action: 'jr_start' }, o.smoke ? { smoke_test: o.smoke } : {}), token);
      if (s.status !== 200) return { start: s };
      const a = J.approve(s.body.url, jrUser, o);
      const cb = await call({ action: 'jr_callback', state: a.state, code: a.code }, token);
      return { start: s, approve: a, cb };
    }
    const grantRow = (uid) => jq(db.sql(`select row_to_json(g) from (select id, status, provider_user_id, display_name, scopes, ciphertext is not null as sealed,
        encode(ciphertext, 'escape') as ct, token_generation, access_expires_at, sync_cursor, last_error_code, last_error, consecutive_failures, next_sync_at, smoke_test,
        sync_lease, refresh_lease from portfolio_private.oauth_grants g where user_id = ${L(uid)} and provider = 'juicereel') g;`));
    const accounts = (uid) => jq(db.sql(`select coalesce(json_agg(a order by platform), '[]') from (select id, platform, platform_label, connection_type, ingestion_method, connection_tier,
        status, external_account_id, last_error, metadata from public.platform_accounts where user_id = ${L(uid)}) a;`)) || [];
    const positions = (uid) => {
      const rows = jq(db.sql(`select coalesce(json_agg(p order by external_position_id), '[]') from (select external_position_id, platform, source, status, stake::text, reported_payout::text,
          profit_loss::text, position_type, market_name, selection, legs, notes, platform_account_id, settled_at from public.portfolio_positions where user_id = ${L(uid)}) p;`)) || [];
      const by = {}; rows.forEach((p) => { by[p.external_position_id || ('local:' + p.selection)] = p; });
      return { rows, by };
    };
    const due = () => db.sql(`update portfolio_private.oauth_grants set next_sync_at = now() - interval '1 minute', last_sync_at = now() - interval '5 minutes';`);
    const syncable = () => db.sql(`update portfolio_private.oauth_grants set last_sync_at = now() - interval '5 minutes';`);
    const nowIso = (ms) => new Date(Date.now() + (ms || 0)).toISOString();

    /* ── health ── */
    let r = await fn(new Request('https://fn.local/portfolio_connect', { method: 'GET' }));
    let hb = await r.json();
    chk('health names the Juice Reel configuration and the exact redirect URI to register — never the id or the secret',
      hb.configured.juicereel.client_id === true && hb.configured.juicereel.client_secret === true && hb.configured.juicereel.ready === true
        && hb.configured.juicereel.redirect_uri === 'https://edgedesksports.com/oauth/juicereel-callback.html' && hb.configured.juicereel.environment === 'production'
        && !JSON.stringify(hb).includes(J.clientSecret) && !JSON.stringify(hb).includes(J.clientId), hb.configured.juicereel);
    chk('…Juice Reel is this server\'s ONE sportsbook sync provider; SharpSports (retired) is not active although its keys are present',
      hb.configured.sportsbook_sync.provider === 'juicereel' && hb.configured.juicereel.active === true && hb.configured.sharpsports.active === false, { sb: hb.configured.sportsbook_sync, ss: hb.configured.sharpsports });
    chk('…and with everything set, nothing is listed as missing', Array.isArray(hb.configured.juicereel.missing) && hb.configured.juicereel.missing.length === 0, hb.configured.juicereel.missing);
    /* production as the 2026-10-14 deploy left it: the Juice Reel id and secret set, the provider and the vault key not */
    const bare = Object.assign({}, env); delete bare.SPORTSBOOK_SYNC_PROVIDER; delete bare.PORTFOLIO_CREDENTIAL_KEYS; delete bare.PORTFOLIO_CREDENTIAL_KEY_VERSION;
    const fnBare = load(bare);
    hb = await (await fnBare(new Request('https://fn.local/portfolio_connect', { method: 'GET' }))).json();
    chk('health names, by secret NAME, what stops Juice Reel: the provider switch and the vault key (production on 2026-10-14) — never a value',
      hb.configured.juicereel.ready === false && hb.configured.juicereel.missing.length === 2 && hb.configured.juicereel.missing[0] === 'SPORTSBOOK_SYNC_PROVIDER=juicereel'
        && /^PORTFOLIO_CREDENTIAL_KEYS/.test(hb.configured.juicereel.missing[1]) && !JSON.stringify(hb).includes(J.clientSecret), hb.configured.juicereel);

    /* ── the owner credential check (jr_check): does Juice Reel accept EdgeDesk's id and secret? ── */
    const callBy = async (handler, body, bearer) => {
      const res = await handler(new Request('https://fn.local/portfolio_connect', { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' },
        bearer ? { authorization: 'Bearer ' + bearer } : {}), body: JSON.stringify(body) }));
      const out = { status: res.status, body: await res.json() };
      fnResponses.push(JSON.stringify(out.body));
      return out;
    };
    const jrBefore = J.calls.length;
    r = await call({ action: 'jr_check' });
    const rB = await call({ action: 'jr_check' }, 'tok-b'), rX = await call({ action: 'jr_check' }, SERVICE + 'x');
    chk('jr_check: no token → 401; a reader → 403 operators only; a near-miss of the service key is no service key (401) — and Juice Reel was not asked',
      r.status === 401 && rB.status === 403 && rB.body.reason === 'operators_only' && rX.status === 401 && J.calls.length === jrBefore);
    r = await call({ action: 'jr_check' }, SERVICE);
    const ownerCalls = J.calls.slice(jrBefore);
    chk('jr_check as the service role: accepted, the application owner named, the setup checklist complete — off for readers, no live test running',
      r.status === 200 && r.body.accepted === true && r.body.code === null && r.body.owner === 'EdgeDesk Owner' && /accepted/.test(r.body.message)
        && r.body.setup.provider_on === true && r.body.setup.missing.length === 0 && r.body.setup.registry_installed === true
        && r.body.setup.switched_on_for_readers === false && r.body.setup.live_test_running === false
        && r.body.setup.redirect_uri === 'https://edgedesksports.com/oauth/juicereel-callback.html', r.body);
    chk('…ONE request: GET /oauth2/me with the client id:secret (Basic) and X-OAuth-Client-Id — no bet list read, no token issued, no reader involved',
      ownerCalls.length === 1 && ownerCalls[0].m === 'GET' && ownerCalls[0].p === '/oauth2/me' && ownerCalls[0].auth === 'basic' && ownerCalls[0].owner === true
        && ownerCalls[0].clientHeader === J.clientId && J.issued.length === 0, ownerCalls);
    chk('…the owner\'s Juice Reel id is not passed on, nor the id or the secret', !('id' in r.body) && !/"owner_id"|"id":7\b/.test(JSON.stringify(r.body))
      && !JSON.stringify(r.body).includes(J.clientSecret) && !JSON.stringify(r.body).includes(J.clientId));
    r = await call({ action: 'jr_check' }, 'tok-op');
    chk('jr_check as a signed-in operator: the same verdict', r.status === 200 && r.body.accepted === true && r.body.owner === 'EdgeDesk Owner');
    const fnWrong = load(Object.assign({}, env, { JUICE_REEL_CLIENT_SECRET: 'jrs_wrong_secret' }));
    r = await callBy(fnWrong, { action: 'jr_check' }, SERVICE);
    chk('Juice Reel refusing the credentials (unapproved, or a stale secret): accepted false, JR_CLIENT_REFUSED with Juice Reel\'s status, said plainly',
      r.status === 200 && r.body.accepted === false && r.body.code === 'JR_CLIENT_REFUSED' && r.body.status === 401 && /not approved yet/.test(r.body.message) && r.body.owner === null, r.body);
    r = await callBy(fnBare, { action: 'jr_check' }, SERVICE);
    chk('…it can be asked BEFORE Juice Reel is switched on (provider unset, no vault key): accepted, with the checklist naming what is still missing',
      r.status === 200 && r.body.accepted === true && r.body.setup.provider_on === false && r.body.setup.missing.length === 1 && /^PORTFOLIO_CREDENTIAL_KEYS/.test(r.body.setup.missing[0]), r.body);
    const fnNoId = load(Object.assign({}, env, { JUICE_REEL_CLIENT_ID: '', JUICE_REEL_CLIENT_SECRET: '' }));
    const nBefore = J.calls.length;
    r = await callBy(fnNoId, { action: 'jr_check' }, SERVICE);
    chk('…without an id and secret it does not call Juice Reel: NOT_CONFIGURED, both names listed', r.body.accepted === false && r.body.code === 'NOT_CONFIGURED' && J.calls.length === nBefore
      && r.body.setup.missing.indexOf('JUICE_REEL_CLIENT_ID') >= 0 && r.body.setup.missing.indexOf('JUICE_REEL_CLIENT_SECRET') >= 0, r.body);
    J.fail['/oauth2/me'] = [502];
    const fBefore = J.calls.length;
    r = await call({ action: 'jr_check' }, SERVICE);
    chk('…Juice Reel failing (5xx): a verdict, not an error — PLATFORM_DOWN, asked once, never retried', r.status === 200 && r.body.accepted === false && r.body.code === 'PLATFORM_DOWN'
      && J.calls.length === fBefore + 1, r.body);
    r = await callBy(fnBare, { action: 'jr_status' }, 'tok-op');
    const rr = await callBy(fnBare, { action: 'jr_status' }, 'tok-b');
    chk('the provider unset: jr_status says sync is off, to operators and readers alike',
      r.body.reason === 'SYNC_OFF' && rr.body.reason === 'SYNC_OFF', { op: r.body.reason, b: rr.body.reason });
    /* the operator's probe (tools/portfolio/juicereel_smoke.js probe) over the shipped function and callback page */
    const realFetch = globalThis.fetch, realLog = console.log, printed = [];
    globalThis.fetch = async (u, i) => {
      const url = String(u);
      if (url.indexOf(SB + '/functions/v1/portfolio_connect') === 0) return fn(new Request(url, i));
      if (url === 'https://edgedesksports.com/oauth/juicereel-callback.html') return new Response(CALLBACK, { status: 200 });
      throw new Error('no network: ' + url);
    };
    console.log = (x) => printed.push(String(x));
    try { await require('./juicereel_smoke.js').probe({ url: SB, service: SERVICE }); } finally { globalThis.fetch = realFetch; console.log = realLog; }
    chk('the probe names the redirect URI to register, finds the callback page there, and reports Juice Reel ACCEPTING the credentials — no secret printed',
      printed.some((l) => /https:\/\/edgedesksports\.com\/oauth\/juicereel-callback\.html/.test(l)) && printed.some((l) => /the EdgeDesk callback page/.test(l))
        && printed.some((l) => /^Juice Reel credentials: ACCEPTED/.test(l)) && !printed.join('\n').includes(J.clientSecret) && !printed.join('\n').includes(SERVICE), printed);
    const noVault = Object.assign({}, env); delete noVault.PORTFOLIO_CREDENTIAL_KEYS;
    const fnNoVault = load(noVault);
    r = await callBy(fnNoVault, { action: 'jr_status' }, 'tok-op');
    const rr2 = await callBy(fnNoVault, { action: 'jr_status' }, 'tok-b');
    chk('…(no vault key) operator: not_configured naming PORTFOLIO_CREDENTIAL_KEYS; reader: not_configured, no secret names',
      r.body.reason === 'not_configured' && /PORTFOLIO_CREDENTIAL_KEYS/.test(r.body.message) && rr2.body.reason === 'not_configured' && !/PORTFOLIO_CREDENTIAL_KEYS|Operators/.test(rr2.body.message),
      { op: r.body.message, b: rr2.body.message });

    /* ── PHASE 2 · who may connect: nobody while Juice Reel is off ── */
    r = await call({ action: 'jr_status' });
    chk('no token, no status', r.status === 401);
    r = await call({ action: 'jr_status' }, 'tok-b');
    chk('a reader, before approval: not available — "awaiting approval" — and no connection', r.status === 200 && r.body.available === false && r.body.reason === 'awaiting_approval'
      && r.body.approval === 'PENDING' && r.body.grant === null && r.body.operator === false && r.body.smoke_test === null);
    r = await call({ action: 'jr_start' }, 'tok-b');
    chk('a reader cannot start linking; nothing is stored for them', r.status === 403 && r.body.reason === 'awaiting_approval'
      && count(`select count(*) from portfolio_private.connect_sessions;`) === 0 && count(`select count(*) from portfolio_private.oauth_grants;`) === 0);
    r = await call({ action: 'jr_start' }, 'tok-op');
    chk('an operator with no live smoke test running cannot link either', r.status === 403 && /smoke test/.test(r.body.message));
    const demo = one(db.service(`select public.portfolio_svc_ag_smoke_begin('juicereel', 'sandbox', 'test');`));
    r = await call({ action: 'jr_start' }, 'tok-op');
    chk('a DEMO (sandbox) smoke test does not open production linking', r.status === 403);
    db.service(`update portfolio_private.connector_smoke_tests set status = 'FAILED', finished_at = now() where id = ${L(demo)};`);
    const smoke = one(db.service(`select public.portfolio_svc_ag_smoke_begin('juicereel', 'production', 'operator');`));
    r = await call({ action: 'jr_status' }, 'tok-op');
    chk('an operator under a running PRODUCTION smoke test may connect (and is told which test)', r.body.available === true && r.body.smoke_test === smoke && r.body.operator === true);

    /* the operator's history before connecting: a DraftKings file import with one bet the sync will match */
    db.as(OP, `insert into public.platform_accounts (platform, platform_label, platform_type, connection_type, status) values ('draftkings', 'DraftKings', 'SPORTSBOOK', 'CSV', 'IMPORT_ONLY');`);
    db.as(OP, `insert into public.portfolio_positions (platform, platform_label, platform_type, position_type, event_name, market_name, selection, odds_american, stake,
        status, reported_payout, placed_at, settled_at, source, notes)
      values ('draftkings', 'DraftKings', 'SPORTSBOOK', 'MONEYLINE', 'Mets @ Braves', 'Moneyline', 'Mets', -110, 110, 'WON', 210, '2026-09-20T13:04:00Z', '2026-09-20T23:00:00Z', 'CSV', 'my own note');`);
    const csvAcct = accounts(OP)[0];

    /* the operator's Juice Reel: three books, open and settled bets, the docs' own example */
    op.bets.push(
      bet(201, { result: 'Won', netResult: 100, dateClosed: '2026-09-20T23:00:00.000Z' }),                                   // DraftKings: matches the file's bet
      bet(202, { oddsAmerican: 150, amountRisked: 20, toWin: 30, Site: { id: 20, name: 'FanDuel' } }),                    // FanDuel, open
      bet(203, { BetType: { id: 2, typeName: 'Parlay' }, oddsAmerican: 264, amountRisked: 10, toWin: 26.4, result: 'Won', netResult: 10, dateClosed: '2026-09-21T03:00:00.000Z',
        datePlaced: '2026-09-20T15:00:00.000Z', Subbets: [subbet({ id: 1, position: 'Kansas City Chiefs', home: 'Kansas City Chiefs', away: 'Miami Dolphins', league: 'NFL', sport: 'Football', result: 'Won', odds: -150 }),
          subbet({ id: 2, type: 'Total', position: 'Over', value: 47.5, home: 'Buffalo Bills', away: 'New York Jets', league: 'NFL', sport: 'Football', result: 'Push', eventId: 429 })] }),
      { id: 9531, userId: 4, oddsAmerican: 114, amountRisked: 0.5886, toWin: 0.6714, netResult: -0.5886, result: 'Lost', datePlaced: '2026-08-11T13:32:26.434Z',
        dateClosed: '2026-08-11T23:15:00.000Z', isAdjustedOdds: false, isAdjustedLine: false, adjustedRisk: null, clvPct: null, createdAt: '2026-08-26T20:35:17.972Z',
        updatedAt: '2026-08-26T20:35:17.972Z', currencyCode: 'USD', BetType: { id: 1, typeName: 'Straight' }, BetStatus: { id: 2, statusName: 'Closed' }, Site: { id: 1589, name: 'NoVig' },
        Subbets: [subbet({ id: 13345, position: 'New York Mets', odds: 114, start: '2026-08-11T23:15:00.000Z', result: 'Lost' })] },
      bet(204, { result: 'Push', netResult: 0, dateClosed: '2026-09-22T00:00:00.000Z', datePlaced: '2026-09-21T13:00:00.000Z', Site: { id: 20, name: 'FanDuel' } }),
      bet(205, { result: 'Cancelled', BetStatus: { id: 3, statusName: 'Cancelled' }, dateClosed: '2026-09-22T00:00:00.000Z', datePlaced: '2026-09-21T14:00:00.000Z' }),
      bet(206, { currencyCode: 'CAD', datePlaced: '2026-09-21T15:00:00.000Z' }),
      bet(207, { datePlaced: '2026-09-23T15:00:00.000Z', Site: { id: 20, name: 'FanDuel' } }),                           // FanDuel, open (will be edited to DraftKings)
      bet(208, { datePlaced: '2026-09-24T15:00:00.000Z' })                                                                // DraftKings, open (a missed settlement, later)
    );

    /* ── PHASE 2 · OAuth: start ── */
    const s1 = await call({ action: 'jr_start' }, 'tok-op');
    const u1 = new URL(s1.body.url), state1 = u1.searchParams.get('state');
    chk('start: Juice Reel\'s own consent URL with the exact client id, redirect URI, scopes, state and S256 challenge',
      s1.status === 200 && u1.origin + u1.pathname === 'https://www.juicereel.com/oauth2/authorize' && u1.searchParams.get('client_id') === J.clientId
        && u1.searchParams.get('redirect_uri') === 'https://edgedesksports.com/oauth/juicereel-callback.html' && u1.searchParams.get('scope') === 'bets.open.read bets.settled.read'
        && u1.searchParams.get('code_challenge_method') === 'S256' && K.JR_STATE_RE.test(state1) && !/verifier/.test(s1.body.url), s1.body);
    const sess = jq(db.sql(`select row_to_json(s) from (select user_id, platform_key, method, state_hash, challenge, expires_at - created_at as ttl from portfolio_private.connect_sessions) s;`));
    const opened = await K.jrOpenSession({ keyring: { current: '1', keys: KEYS } }, OP, sess.state_hash, sess.challenge);
    chk('…the server keeps the state only as its SHA-256 and the verifier SEALED (it opens to the verifier whose S256 is the challenge), for this reader, for 15 minutes',
      sess.user_id === OP && sess.platform_key === 'juicereel' && sess.state_hash === nodeCrypto.createHash('sha256').update(state1).digest('hex')
        && !sess.challenge.includes(state1) && /^v1\./.test(sess.challenge) && FAKE.b64url(nodeCrypto.createHash('sha256').update(opened.verifier).digest()) === u1.searchParams.get('code_challenge')
        && !sess.challenge.includes(opened.verifier) && opened.smoke_test === smoke && sess.ttl === '00:15:00', sess);

    /* ── the callback's attacks ── */
    const a1 = J.approve(s1.body.url, 4);
    r = await call({ action: 'jr_callback', state: state1, code: a1.code }, 'tok-b');
    chk('CSRF: the operator\'s state presented under ANOTHER reader\'s session is refused, and is not used up', r.status === 400 && r.body.reason === 'JR_STATE_INVALID'
      && count(`select count(*) from portfolio_private.connect_sessions where consumed_at is null;`) === 1 && !J.codes[a1.code].used);
    r = await call({ action: 'jr_callback', state: 'x'.repeat(43), code: a1.code }, 'tok-op');
    const r2 = await call({ action: 'jr_callback', state: '<script>', code: a1.code }, 'tok-op');
    chk('an unknown state and a malformed one are refused before Juice Reel is asked', r.body.reason === 'JR_STATE_INVALID' && r2.body.reason === 'JR_STATE_INVALID' && !J.codes[a1.code].used);
    const s2 = await call({ action: 'jr_start' }, 'tok-op');
    r = await call({ action: 'jr_callback', state: new URL(s2.body.url).searchParams.get('state'), error: 'access_denied' }, 'tok-op');
    const r3 = await call({ action: 'jr_callback', state: new URL(s2.body.url).searchParams.get('state'), code: J.approve(s2.body.url, 4).code }, 'tok-op');
    chk('a refused consent: "you did not authorize", and its state cannot be used afterwards', r.status === 400 && r.body.reason === 'JR_CONSENT_DENIED' && r3.body.reason === 'JR_STATE_INVALID');
    const s3 = await call({ action: 'jr_start' }, 'tok-op');
    const a3 = J.approve(s3.body.url, 4);
    db.sql(`update portfolio_private.connect_sessions set created_at = now() - interval '20 minutes', expires_at = now() - interval '5 minutes' where consumed_at is null and state_hash = ${L(nodeCrypto.createHash('sha256').update(a3.state).digest('hex'))};`);
    r = await call({ action: 'jr_callback', state: a3.state, code: a3.code }, 'tok-op');
    chk('an expired sign-in (over 15 minutes) is refused', r.body.reason === 'JR_STATE_INVALID' && !J.codes[a3.code].used);
    const s4 = await call({ action: 'jr_start' }, 'tok-op');
    const forged = J.approve(s3.body.url, 4);   /* a code issued for ANOTHER challenge */
    r = await call({ action: 'jr_callback', state: new URL(s4.body.url).searchParams.get('state'), code: forged.code }, 'tok-op');
    chk('a code that fails PKCE (issued for another challenge) is refused by Juice Reel → "did not accept the sign-in"; nothing stored',
      r.body.reason === 'JR_CODE_INVALID' && count(`select count(*) from portfolio_private.oauth_grants where status = 'CONNECTED';`) === 0);
    J.grantScopes = ['bets.open.read'];
    const sc = await connectAs('tok-op', 4);
    J.grantScopes = null;
    const famScope = Object.keys(J.families).slice(-1)[0];
    chk('a consent that leaves out settled bets: refused (JR_SCOPE_MISSING), the tokens Juice Reel issued REVOKED at once, nothing stored',
      sc.cb.body.reason === 'JR_SCOPE_MISSING' && J.families[famScope].revoked === true && count(`select count(*) from portfolio_private.oauth_grants where ciphertext is not null;`) === 0);
    const wrong = load(Object.assign({}, env, { JUICE_REEL_CLIENT_SECRET: 'jrs_wrong_secret' }));
    const fnSave = fn; fn = wrong;
    const bad = await connectAs('tok-op', 4);
    fn = fnSave;
    chk('Juice Reel refusing EdgeDesk\'s client credentials (unapproved app, rotated secret) → JR_CLIENT_REFUSED, said to be on EdgeDesk\'s side',
      bad.cb.status === 502 && bad.cb.body.reason === 'JR_CLIENT_REFUSED' && /awaiting approval/.test(bad.cb.body.message));

    /* ── PHASE 2+3 · a real connection and the initial import ── */
    const callsBefore = J.calls.length;
    const ok1 = await connectAs('tok-op', 4);
    r = ok1.cb;
    const g1 = grantRow(OP);
    chk('connected: the code exchanged with the verifier, the pair SEALED (no token in the row), the Juice Reel user and scopes kept',
      r.status === 200 && r.body.ok && r.body.connected && r.body.display_name === 'Sharp Bettor' && g1.status === 'CONNECTED' && g1.sealed && g1.provider_user_id === '4'
        && g1.scopes.join(' ') === 'bets.open.read bets.settled.read' && g1.smoke_test === smoke && J.issued.every((t) => !String(g1.ct).includes(t)), { body: r.body, g1 });
    const acc1 = accounts(OP), dk = acc1.find((a) => a.platform === 'draftkings'), fd = acc1.find((a) => a.platform === 'fanduel'), nv = acc1.find((a) => a.platform === 'novig');
    chk('each book a Portfolio account of its own: tier 1, AGGREGATOR, provider juicereel — the DraftKings QUICK IMPORT account upgraded IN PLACE',
      dk && dk.id === csvAcct.id && dk.connection_type === 'AGGREGATOR' && dk.ingestion_method === 'AUTHORIZED_API' && dk.connection_tier === 1 && dk.metadata.provider === 'juicereel'
        && dk.metadata.environment === 'production' && dk.external_account_id === 'juicereel:site:id:10' && fd && nv && acc1.every((a) => a.status === 'CONNECTED'), acc1);
    let P = positions(OP);
    chk('the history imported, exact money from the database\'s own derivation: the docs\' example −0.5886, a win +100, a parlay with legs +10, a push 0, a void 0, the open bets OPEN',
      P.by['juicereel:9531'].profit_loss === '-0.5886' && P.by['juicereel:9531'].stake === '0.59' && P.by['juicereel:9531'].platform === 'novig'
        && P.by['juicereel:203'].profit_loss === '10' && P.by['juicereel:203'].legs.length === 2 && P.by['juicereel:203'].legs[1].result === 'PUSH'
        && P.by['juicereel:204'].profit_loss === '0' && P.by['juicereel:205'].status === 'VOID' && P.by['juicereel:205'].profit_loss === '0'
        && P.by['juicereel:202'].status === 'OPEN' && P.by['juicereel:202'].platform === 'fanduel' && P.by['juicereel:207'].status === 'OPEN', P.rows.map((p) => [p.external_position_id, p.status, p.profit_loss]));
    chk('RECONCILED: the bet the operator imported from a file was ADOPTED by its Juice Reel copy — one position, their note kept, +100',
      P.rows.length === 8 && P.by['juicereel:201'].source === 'CSV' && P.by['juicereel:201'].notes === 'my own note' && P.by['juicereel:201'].profit_loss === '100');
    chk('the non-USD bet was not stored, and is listed with its run', !P.by['juicereel:206'] && one(db.sql(`select count(*) from public.portfolio_sync_runs r, jsonb_array_elements(r.issues) e where e->>'code' = 'CURRENCY_UNSUPPORTED';`)) === '1');
    chk('settlement history: every settled result the sync recorded (the adopted file bet already had its result)', count(`select count(*) from public.portfolio_position_settlements where user_id = ${L(OP)};`) === 4);
    const cur1 = JSON.parse(grantRow(OP).sync_cursor);
    const jrCalls = J.calls.slice(callsBefore);
    chk('the initial import read /bets/open then /bets/settled to the end, following each opaque nextCursor (page size 2), and never /bets/changed',
      cur1.initial_done === true && typeof cur1.checkpoint === 'string' && jrCalls.filter((c) => c.p === '/oauth2/bets/open').length >= 2
        && jrCalls.filter((c) => c.p === '/oauth2/bets/settled').length >= 3 && !jrCalls.some((c) => c.p === '/oauth2/bets/changed')
        && jrCalls.filter((c) => c.p === '/oauth2/bets/settled' && c.q.cursor).length >= 2, { cur1, paths: jrCalls.map((c) => c.p) });
    chk('every request carried X-OAuth-Client-Id; the secret (Basic) went only to the token endpoint; resources only ever saw a Bearer token; no subscriber or checkout endpoint was called',
      J.calls.every((c) => c.clientHeader === J.clientId) && J.calls.filter((c) => c.auth === 'basic').every((c) => c.p === '/oauth2/token' || c.p === '/oauth2/revoke' || (c.p === '/oauth2/me' && c.owner))
        && J.calls.filter((c) => /bets|me/.test(c.p) && !c.owner).every((c) => c.auth === 'bearer') && !J.calls.some((c) => /subscribers|checkout/.test(c.p)));
    chk('the state is used up: replaying the same callback is refused', (await call({ action: 'jr_callback', state: ok1.approve.state, code: ok1.approve.code }, 'tok-op')).body.reason === 'JR_STATE_INVALID');
    const st1 = await call({ action: 'jr_status' }, 'tok-op');
    chk('status for the page: Connected as Sharp Bettor, 3 books, open bets — no token, ciphertext or Juice Reel id in it',
      st1.body.grant.status === 'CONNECTED' && st1.body.grant.display_name === 'Sharp Bettor' && +st1.body.grant.books === 3 && +st1.body.grant.open_bets === 3
        && !/ciphertext|provider_user_id|jra_|jrr_|grant_id/.test(JSON.stringify(st1.body)), st1.body.grant);

    /* ── PHASE 5 · the synced bets in the existing analytics ── */
    const sum = JSON.parse(one(db.as(OP, `select public.portfolio_summary(null, null, 'UTC', null);`)));
    chk('the Overview\'s own summary counts the Juice Reel bets: settled P&L = 100 + 10 + 0 + 0 − 0.5886, by book', +sum.settled.pnl === 109.4114
      && sum.platforms.some((x) => x.platform === 'novig') && sum.platforms.some((x) => x.platform === 'draftkings'), sum.settled);
    const pth = JSON.parse(one(db.as(OP, `select public.portfolio_pnl_path(null, null, 'UTC', null);`)));
    chk('the bankroll path runs over them, day by day', pth.days.length === 4 && +pth.days[pth.days.length - 1].cumulative === 109.4114, pth.days);

    /* ── idempotent: the same history again ── */
    const before = one(db.sql(`select count(*) || ':' || max(updated_at) from public.portfolio_positions;`));
    syncable();
    r = await call({ action: 'jr_sync' }, 'tok-op');
    chk('a manual sync with nothing new: nothing inserted or updated, no settlement twice (the first daily reconciliation re-reads the open list, harmlessly)',
      r.status === 200 && r.body.ok && r.body.totals.positions_inserted === 0 && r.body.totals.positions_updated === 0
        && one(db.sql(`select count(*) || ':' || max(updated_at) from public.portfolio_positions;`)) === before
        && count(`select count(*) from public.portfolio_position_settlements where user_id = ${L(OP)};`) === 4, r.body);
    r = await call({ action: 'jr_sync' }, 'tok-op');
    chk('Sync now at most once every two minutes', r.status === 429 && r.body.reason === 'too_soon');

    /* ── PHASE 3 · incremental: changes since the checkpoint ── */
    const ck1 = JSON.parse(grantRow(OP).sync_cursor).checkpoint;
    Object.assign(op.bets.find((x) => x.id === 202), { result: 'Won', netResult: 30, dateClosed: nowIso(-60000), BetStatus: { id: 2, statusName: 'Closed' }, updatedAt: nowIso(-50000) });
    Object.assign(op.bets.find((x) => x.id === 201), { result: 'Lost', netResult: -110, updatedAt: nowIso(-40000) });           // a correction
    op.bets.push(bet(209, { datePlaced: nowIso(-30000), createdAt: nowIso(-30000), updatedAt: nowIso(-30000), Site: { id: 30, name: 'BetMGM' } }));
    Object.assign(op.bets.find((x) => x.id === 207), { Site: { id: 10, name: 'DraftKings' }, updatedAt: nowIso(-20000) });       // its book edited in Juice Reel
    db.as(OP, `update public.portfolio_positions set notes = 'kept through the move' where external_position_id = 'juicereel:207';`);
    const c0 = J.calls.length;
    due();
    r = await call({ action: 'sweep' });
    P = positions(OP);
    const chg = J.calls.slice(c0).filter((c) => c.p === '/oauth2/bets/changed');
    chk('the scheduler reads /bets/changed from the checkpoint (less two minutes), never the whole history again',
      r.status === 200 && chg.length >= 1 && chg[0].q.updatedAtAfter === new Date(Date.parse(ck1) - 120000).toISOString()
        && !J.calls.slice(c0).some((c) => c.p === '/oauth2/bets/settled' && !c.q.dateClosedAfter), chg.map((c) => c.q));
    chk('a settlement (OPEN → WON, +30), a correction (WON → LOST, −110), a new bet at a new book (BetMGM), all in place',
      P.by['juicereel:202'].status === 'WON' && P.by['juicereel:202'].profit_loss === '30' && P.by['juicereel:201'].status === 'LOST' && P.by['juicereel:201'].profit_loss === '-110'
        && P.by['juicereel:209'] && P.by['juicereel:209'].platform === 'betmgm' && accounts(OP).some((a) => a.platform === 'betmgm'), P.rows.map((p) => [p.external_position_id, p.status, p.profit_loss]));
    chk('…each change appended to the settlement history (202 OPEN>WON, 201 WON>LOST)', one(db.sql(`select string_agg(s.external_position_id || ' ' || coalesce(s.previous_status, '-') || '>' || s.status, ',' order by s.external_position_id) from public.portfolio_position_settlements s
        where s.external_position_id in ('juicereel:202', 'juicereel:201') and s.previous_status is not null;`)) === 'juicereel:201 WON>LOST,juicereel:202 OPEN>WON');
    chk('a bet whose book was edited in Juice Reel MOVES to that book: one position, its note kept — never a duplicate', P.rows.filter((p) => p.external_position_id === 'juicereel:207').length === 1
      && P.by['juicereel:207'].platform === 'draftkings' && P.by['juicereel:207'].notes === 'kept through the move');
    const ck2 = JSON.parse(grantRow(OP).sync_cursor).checkpoint;
    chk('the checkpoint advanced to the newest updatedAt seen', ck2 > ck1 && ck2 === op.bets.find((x) => x.id === 207).updatedAt, { ck1, ck2 });

    /* ── tokens: expiry, rotation, the lease, a 401 ── */
    const g2 = grantRow(OP), refreshes0 = J.refreshes || 0;
    db.sql(`update portfolio_private.oauth_grants set access_expires_at = now() - interval '1 minute' where user_id = ${L(OP)};`);
    syncable();
    r = await call({ action: 'jr_sync' }, 'tok-op');
    const g3 = grantRow(OP);
    chk('an expired access token is refreshed ONCE, the new pair replaces the old atomically (generation +1), and the sync goes on',
      r.body.ok && (J.refreshes || 0) === refreshes0 + 1 && +g3.token_generation === +g2.token_generation + 1 && g3.ct !== g2.ct && !g3.refresh_lease && Date.parse(g3.access_expires_at) > Date.now() + 3000000);
    /* many syncs at once, the token expired: exactly one refresh, no single-use token sent twice */
    db.sql(`update portfolio_private.oauth_grants set access_expires_at = now() - interval '1 minute' where user_id = ${L(OP)};`);
    const ctx = { fetch: fakeFetch, rpc: async (fnName, args) => { const out = rest.handle('POST', 'rpc/' + fnName, '', args, '', SERVICE); if (out.status >= 300) { const e = new Error('rpc ' + fnName); e.body = JSON.stringify(out.body); throw e; } return out.body; },
      now: () => Date.now(), keyring: { current: '1', keys: KEYS }, log: () => {}, sleep: (ms) => new Promise((ok) => setTimeout(ok, Math.min(ms, 30))) };
    const cfg = { env: 'production', clientId: J.clientId, clientSecret: J.clientSecret, redirectUri: 'https://edgedesksports.com/oauth/juicereel-callback.html' };
    const gid = grantRow(OP).id, gen = +grantRow(OP).token_generation, r0 = J.refreshes, reuse0 = J.reuse || 0;
    const toks = await Promise.all([1, 2, 3, 4].map(() => K.jrAccessToken(ctx, cfg, { grant_id: gid, generation: gen }, false)));
    chk('four syncs racing on an expired token: ONE refresh (the lease), all four end with the same new token, no refresh token reused',
      J.refreshes === r0 + 1 && (J.reuse || 0) === reuse0 && new Set(toks).size === 1 && +grantRow(OP).token_generation === gen + 1, { refreshes: J.refreshes - r0, distinct: new Set(toks).size });
    const live1 = Object.keys(J.access).find((t) => J.access[t].active && J.access[t].userId === '4' && J.access[t].exp > Date.now() + 3000000 && toks[0] === t);
    J.access[live1].active = false;   /* Juice Reel drops the access token early */
    syncable();
    const r401 = J.refreshes;
    r = await call({ action: 'jr_sync' }, 'tok-op');
    chk('a 401 from Juice Reel mid-sync: refreshed once and retried — the sync succeeds', r.body.ok && J.refreshes === r401 + 1, r.body);

    /* ── rate limits and transient failures ── */
    J.fail['/oauth2/bets/changed'] = [502];
    syncable();
    r = await call({ action: 'jr_sync' }, 'tok-op');
    chk('a transient 5xx on an idempotent GET is retried with backoff inside the request', r.body.ok === true, r.body);
    J.fail['/oauth2/bets/changed'] = [429];
    syncable();
    r = await call({ action: 'jr_sync' }, 'tok-op');
    let g4 = grantRow(OP);
    chk('429: the sync stops (RATE_LIMITED), no retry storm — the next run waits 10 minutes (backoff plus Juice Reel\'s five-minute bucket); still Connected',
      r.body.ok === false && r.body.error.code === 'RATE_LIMITED' && g4.status === 'CONNECTED' && g4.consecutive_failures === 1
        && Date.parse(g4.next_sync_at) - Date.now() > 9 * 60000 && Date.parse(g4.next_sync_at) - Date.now() < 11 * 60000, g4);
    J.fail['/oauth2/bets/changed'] = [503, 503, 503, 503, 503, 503, 503, 503, 503, 503, 503, 503, 503, 503, 503];
    for (let i = 0; i < 4; i++) { due(); await call({ action: 'sweep' }); }
    g4 = grantRow(OP);
    chk('a provider down for five runs in a row: ERROR, backoff growing, the books say so, history kept', g4.status === 'ERROR' && g4.consecutive_failures === 5
      && accounts(OP).filter((a) => a.metadata.provider === 'juicereel').every((a) => a.status === 'ERROR') && positions(OP).rows.length === 9, g4);
    J.fail['/oauth2/bets/changed'] = [];
    due(); await call({ action: 'sweep' });
    chk('…and back to Connected on the next good run', grantRow(OP).status === 'CONNECTED' && grantRow(OP).consecutive_failures === 0 && accounts(OP).every((a) => a.status === 'CONNECTED'));

    /* ── a bet imported from the book's own file, WITH the book's bet id: adopted, never doubled ── */
    db.as(OP, `insert into public.portfolio_positions (platform, platform_label, platform_type, position_type, event_name, market_name, selection, odds_american, stake,
        status, reported_payout, placed_at, settled_at, source, notes, external_position_id)
      values ('draftkings', 'DraftKings', 'SPORTSBOOK', 'MONEYLINE', 'Cubs @ Reds', 'Moneyline', 'Cubs', 120, 25, 'WON', 55, '2026-09-27T18:01:00Z', '2026-09-28T02:00:00Z', 'CSV',
        'from the DK export', 'DK-55120');`);
    op.bets.push(bet(211, { oddsAmerican: 120, amountRisked: 25, toWin: 30, result: 'Won', netResult: 30, datePlaced: '2026-09-27T18:00:00.000Z', dateClosed: '2026-09-28T02:00:00.000Z',
      BetStatus: { id: 2, statusName: 'Closed' }, updatedAt: nowIso(-15000) }));
    syncable(); r = await call({ action: 'jr_sync' }, 'tok-op');
    P = positions(OP);
    chk('a bet imported from DraftKings\' own file WITH its bet id is ADOPTED by its Juice Reel copy: one position, the note kept, its P&L counted once (+30)',
      r.body.ok && P.rows.filter((p) => p.notes === 'from the DK export').length === 1 && P.by['juicereel:211'] && P.by['juicereel:211'].source === 'CSV'
        && P.by['juicereel:211'].notes === 'from the DK export' && P.by['juicereel:211'].profit_loss === '30' && !P.by['DK-55120'],
      P.rows.filter((p) => /211|DK-/.test(p.external_position_id || '')));
    /* a later run that carries only a second, identical bet (the first is not re-read with it) */
    const dkA = accounts(OP).find((a) => a.platform === 'draftkings');
    const runT = one(db.service(`select public.portfolio_svc_run_begin(${L(dkA.id)}, 'INCREMENTAL');`));
    const twin = { platform: 'draftkings', platform_label: 'DraftKings', external_position_id: 'juicereel:213', position_type: 'MONEYLINE', event_name: 'Cubs @ Reds',
      market_name: 'Moneyline', selection: 'Cubs', odds_american: 120, stake: '25', status: 'WON', reported_payout: '55', placed_at: '2026-09-27T18:02:00Z', settled_at: '2026-09-28T02:00:00Z' };
    db.service(`select public.portfolio_svc_ingest_wagers(${L(dkA.id)}, ${L(runT)}, ${L(JSON.stringify({ positions: [twin] }))}::jsonb);`);
    db.service(`select public.portfolio_svc_run_finish(p_run => ${L(runT)}, p_status => 'SUCCEEDED');`);
    P = positions(OP);
    chk('…and a second, identical bet arriving later never takes over the one already adopted: its own position; the adopted one keeps its Juice Reel id and note',
      P.by['juicereel:213'] && P.by['juicereel:213'].source === 'SYNC' && P.by['juicereel:211'] && P.by['juicereel:211'].notes === 'from the DK export',
      P.rows.filter((p) => /21[13]|DK-/.test(p.external_position_id || '')));

    /* ── a book whose run is still open (a sync that died): nothing moves past its bets ── */
    const dkNow = accounts(OP).find((a) => a.platform === 'draftkings');
    const stuck = one(db.service(`select public.portfolio_svc_run_begin(${L(dkNow.id)}, 'INCREMENTAL');`));
    const ckB = JSON.parse(grantRow(OP).sync_cursor).checkpoint;
    op.bets.push(bet(212, { datePlaced: nowIso(-9000), updatedAt: nowIso(-9000) }));
    syncable(); r = await call({ action: 'jr_sync' }, 'tok-op');
    chk('BOOK_BUSY: a new DraftKings bet is not stored while that book\'s run is open — and the checkpoint does NOT move past it (no silent loss)',
      !!stuck && !positions(OP).by['juicereel:212'] && JSON.parse(grantRow(OP).sync_cursor).checkpoint === ckB
        && jq(db.sql(`select last_issues from portfolio_private.oauth_grants where user_id = ${L(OP)};`)).some((x) => x.code === 'BOOK_BUSY'), { ckB, now: grantRow(OP).sync_cursor });
    db.service(`select public.portfolio_svc_run_finish(p_run => ${L(stuck)}, p_status => 'FAILED', p_error_code => 'UNKNOWN', p_error_message => 'test');`);
    syncable(); r = await call({ action: 'jr_sync' }, 'tok-op');
    chk('…the next run, the book free again, reads the same changes and stores the bet; the checkpoint moves on', r.body.ok && !!positions(OP).by['juicereel:212']
      && JSON.parse(grantRow(OP).sync_cursor).checkpoint > ckB);

    /* ── a changed feed longer than one run: the pass resumes where it stopped ── */
    for (let i = 0; i < 6; i++) op.bets.push(bet(220 + i, { datePlaced: nowIso(-8000 + i * 100), updatedAt: nowIso(-8000 + i * 100), Site: { id: 20, name: 'FanDuel' } }));
    const ckC = JSON.parse(grantRow(OP).sync_cursor).checkpoint, c2 = J.calls.length;
    J.fail['/oauth2/bets/changed'] = [0, 429];   /* the first page is read, the second is rate limited */
    syncable(); r = await call({ action: 'jr_sync' }, 'tok-op');
    const curC = JSON.parse(grantRow(OP).sync_cursor), stored1 = [220, 221, 222, 223, 224, 225].filter((n) => positions(OP).by['juicereel:' + n]).length;
    chk('cut short part-way (a 429 on page two): the page already read is STORED, the pass keeps its cursor, the checkpoint stays, and the reader is told it did not finish',
      r.body.ok === false && r.body.error.code === 'RATE_LIMITED' && stored1 === 2 && curC.pass && curC.pass.cursor && curC.checkpoint === ckC && grantRow(OP).consecutive_failures === 1,
      { body: r.body, curC, stored1 });
    J.fail['/oauth2/bets/changed'] = [];
    due(); r = await call({ action: 'sweep' });
    const resumed = J.calls.slice(c2).filter((c) => c.p === '/oauth2/bets/changed');
    const curC2 = JSON.parse(grantRow(OP).sync_cursor);
    chk('…the next run RESUMES the pass from its cursor (same updatedAtAfter), stores the rest, and only then moves the checkpoint to the newest change',
      [220, 221, 222, 223, 224, 225].every((n) => positions(OP).by['juicereel:' + n]) && !curC2.pass && curC2.checkpoint === op.bets.find((x) => x.id === 225).updatedAt
        && resumed.some((c) => c.q.cursor === curC.pass.cursor && c.q.updatedAtAfter === curC.pass.from) && grantRow(OP).consecutive_failures === 0,
      { curC2, q: resumed.map((c) => c.q) });

    /* ── rotation: a database hiccup is retried; an answer lost after the commit is recognised ── */
    const flaky = (mode) => Object.assign({}, ctx, { rpc: async (fnName, args) => {
      if (fnName === 'portfolio_svc_jr_rotate' && !flaky.done) {
        flaky.done = true;
        if (mode === 'after') { await ctx.rpc(fnName, args); }
        throw new Error('rpc portfolio_svc_jr_rotate: connection reset');
      }
      return ctx.rpc(fnName, args);
    } });
    for (const mode of ['before', 'after']) {
      flaky.done = false;
      db.sql(`update portfolio_private.oauth_grants set access_expires_at = now() - interval '1 minute' where user_id = ${L(OP)};`);
      const genF = +grantRow(OP).token_generation, revF = J.revokes.length;
      const tokF = await K.jrAccessToken(flaky(mode), cfg, { grant_id: gid, generation: genF }, false);
      chk('the rotation\'s database call fails once (' + (mode === 'before' ? 'before' : 'after') + ' it committed): the new pair is stored exactly once, nothing revoked, the sync goes on',
        flaky.done && typeof tokF === 'string' && +grantRow(OP).token_generation === genF + 1 && J.revokes.length === revF && J.access[tokF] && J.access[tokF].active);
    }

    /* ── a refusal of an OLDER pair never touches the one stored since ── */
    const genN = +grantRow(OP).token_generation;
    db.service(`select public.portfolio_svc_jr_grant_failed(${L(gid)}, 'GRANT_EXPIRED', 'stale', true, ${genN - 1});`);
    chk('portfolio_svc_jr_grant_failed for a stale generation: nothing changes (a reconnect\'s fresh pair survives a stale refresh\'s refusal)',
      grantRow(OP).status === 'CONNECTED' && grantRow(OP).sealed);

    /* ── reconciliation looks only at this Juice Reel account's open bets ── */
    db.sql(`insert into public.portfolio_positions (user_id, platform_account_id, platform, platform_label, platform_type, external_position_id, position_type, event_name, market_name,
        selection, odds_american, stake, status, placed_at, source, raw_payload)
      values (${L(OP)}, ${L(dkNow.id)}, 'draftkings', 'DraftKings', 'SPORTSBOOK', 'juicereel:99901', 'MONEYLINE', 'Old account bet', 'Moneyline', 'X', 100, 10, 'OPEN',
        '2026-09-01T00:00:00Z', 'SYNC', '{"id": 99901, "userId": 999}'::jsonb);`);
    const openHeld = jq(db.service(`select public.portfolio_svc_jr_open_positions(${L(gid)});`));
    chk('an open bet from a Juice Reel account the reader connected BEFORE (another Juice Reel user) is not this grant\'s to reconcile',
      !openHeld.some((x) => x.id === 'juicereel:99901') && openHeld.some((x) => x.id === 'juicereel:207'), openHeld.map((x) => x.id));
    db.sql(`delete from public.portfolio_positions where external_position_id = 'juicereel:99901';`);

    /* ── reconciliation after a missed update ── */
    Object.assign(op.bets.find((x) => x.id === 208), { result: 'Won', netResult: 100, dateClosed: '2026-09-25T00:00:00.000Z', BetStatus: { id: 2, statusName: 'Closed' } });  // updatedAt stays OLD: the changed feed will not show it
    const deleted = bet(210, { datePlaced: '2026-09-26T15:00:00.000Z', updatedAt: nowIso(-10000), Site: { id: 20, name: 'FanDuel' } });
    op.bets.push(deleted);
    syncable(); await call({ action: 'jr_sync' }, 'tok-op');
    op.bets.splice(op.bets.indexOf(deleted), 1);   /* then deleted in Juice Reel */
    chk('(setup) the missed settlement is still open here', positions(OP).by['juicereel:208'].status === 'OPEN' && positions(OP).by['juicereel:210'].status === 'OPEN');
    syncable();
    const c1 = J.calls.length;
    r = await call({ action: 'jr_sync', reconcile: true }, 'tok-op');
    P = positions(OP);
    const back = J.calls.slice(c1).filter((c) => c.p === '/oauth2/bets/settled');
    chk('RECONCILIATION: open here but not open at Juice Reel → its settled list read back to that bet\'s placement → the missed result applied (WON +100)',
      P.by['juicereel:208'].status === 'WON' && P.by['juicereel:208'].profit_loss === '100' && back.length >= 1 && back[0].q.dateClosedAfter === '2026-09-24T15:00:00.000Z', back.map((c) => c.q));
    chk('…a bet no longer anywhere at Juice Reel is reported, never changed or removed on a guess', P.by['juicereel:210'].status === 'OPEN'
      && (grantRow(OP) && jq(db.sql(`select last_issues from portfolio_private.oauth_grants where user_id = ${L(OP)};`)).some((x) => x.code === 'NOT_AT_JUICE_REEL' && x.ref === 'juicereel:210')));

    /* ── an interrupted initial import resumes; a rejected cursor restarts ── */
    db.sql(`update portfolio_private.oauth_grants set sync_cursor = null where user_id = ${L(OP)};`);
    const slow = Object.assign({}, ctx, { budgetMs: 1 });
    const part = await K.juicereelSync(slow, cfg, gid, 'INITIAL');
    const curP = JSON.parse(grantRow(OP).sync_cursor);
    chk('out of time mid-import: it stops where it is, keeps Juice Reel\'s cursor, and asks to run again in a minute', part.complete === false && curP.initial_done !== true
      && (curP.open_cursor || curP.settled_cursor) && Date.parse(grantRow(OP).next_sync_at) - Date.now() < 90000, { part: part.status, curP });
    db.sql(`update portfolio_private.oauth_grants set sync_cursor = (jsonb_set(jsonb_set(sync_cursor::jsonb, '{settled_cursor}', '"bm90LWEtY3Vyc29y"'), '{open_done}', 'true') - 'open_cursor')::text
              where user_id = ${L(OP)};`);
    const n0 = positions(OP).rows.length;
    let fin = null;
    for (let i = 0; i < 20 && !(fin && fin.complete); i++) fin = await K.juicereelSync(ctx, cfg, gid, 'INITIAL');
    db.service(`select public.portfolio_svc_jr_reset_cursor(${L(gid)});`);
    chk('(operator repair) a checkpoint can be forgotten so the next sync re-reads the whole history', grantRow(OP).sync_cursor === null);
    for (let i = 0; i < 20; i++) { const x = await K.juicereelSync(ctx, cfg, gid, 'INITIAL'); if (x.complete) break; }
    chk('…which re-reads everything and duplicates nothing', positions(OP).rows.length === n0);
    chk('resumed, a cursor Juice Reel rejects ("cursor is invalid") restarts that list from its start — the import completes with no duplicate',
      fin.complete === true && JSON.parse(grantRow(OP).sync_cursor).initial_done === true && positions(OP).rows.length === n0
        && count(`select count(*) from (select external_position_id from public.portfolio_positions where user_id = ${L(OP)} and external_position_id is not null group by 1 having count(*) > 1) d;`) === 0, fin);

    /* ── a rotation racing a disconnect: the new pair never outlives it ── */
    db.sql(`update portfolio_private.oauth_grants set access_expires_at = now() - interval '1 minute' where user_id = ${L(OP)};`);
    const racing = Object.assign({}, ctx, { fetch: async (u, init) => {
      const x = new URL(u);
      if (x.pathname === '/oauth2/token') { const out = await fakeFetch(u, init); db.service(`select public.portfolio_svc_jr_disconnect(${L(OP)}, 'production', false);`); return out; }
      return fakeFetch(u, init);
    } });
    const revokes0 = J.revokes.length;
    let raced = null;
    try { await K.jrAccessToken(racing, cfg, { grant_id: gid, generation: +grantRow(OP).token_generation }, false); } catch (e) { raced = e.code; }
    chk('a refresh that finishes after a disconnect: not stored, and the pair it got is revoked at Juice Reel at once', raced === 'JR_DISCONNECTED'
      && grantRow(OP).status === 'DISCONNECTED' && !grantRow(OP).sealed && J.revokes.length === revokes0 + 2 && J.revokes.slice(-2)[0].hint === 'refresh_token');
    /* reconnect: the same Juice Reel account, the same books */
    const ok2 = await connectAs('tok-op', 4);
    chk('reconnecting: the same accounts reused (no duplicates), Connected again, history intact', ok2.cb.body.ok && ok2.cb.body.reconnected === true
      && accounts(OP).filter((a) => a.metadata.provider === 'juicereel').every((a) => a.status === 'CONNECTED') && accounts(OP).filter((a) => a.platform === 'draftkings').length === 1
      && positions(OP).rows.length === n0, ok2.cb.body);

    /* ── a grant revoked at Juice Reel → Connection expired ── */
    J.familyOfUser(4).forEach(J.revokeFamily);
    db.sql(`update portfolio_private.oauth_grants set access_expires_at = now() - interval '1 minute' where user_id = ${L(OP)};`);
    syncable();
    r = await call({ action: 'jr_sync' }, 'tok-op');
    const g5 = grantRow(OP), st5 = await call({ action: 'jr_status' }, 'tok-op');
    chk('a refresh Juice Reel refuses (invalid_grant): ACTION REQUIRED / GRANT_EXPIRED, the dead pair deleted, every book says so, history kept',
      r.body.ok === false && r.body.error.code === 'GRANT_EXPIRED' && g5.status === 'ACTION_REQUIRED' && g5.last_error_code === 'GRANT_EXPIRED' && !g5.sealed
        && accounts(OP).filter((a) => a.metadata.provider === 'juicereel').every((a) => a.status === 'ACTION_REQUIRED' && /Reconnect Juice Reel/.test(a.last_error))
        && positions(OP).rows.length === n0 && st5.body.grant.last_error_code === 'GRANT_EXPIRED', { body: r.body, g5 });
    due();
    const sw = await call({ action: 'sweep' });
    r = await call({ action: 'jr_sync' }, 'tok-op');
    chk('…no retry storm: the scheduler skips it and Sync now says to reconnect', sw.body.due === 0 && r.status === 409);
    const ok3 = await connectAs('tok-op', 4);
    chk('reconnect after expiry: Connected, the same checkpoint kept (same Juice Reel account)', ok3.cb.body.ok && grantRow(OP).status === 'CONNECTED'
      && JSON.parse(grantRow(OP).sync_cursor || '{}').initial_done === true);

    /* ── the switch: off for readers until the evidence exists ── */
    db.service(`update portfolio_private.connector_smoke_tests set stages = ${L(JSON.stringify(Object.fromEntries(K.SMOKE_STAGES.map((x) => [x, { ok: true }]))))}::jsonb where id = ${L(smoke)};`);
    chk('the smoke test finished with all ten stages in PRODUCTION is PASSED', one(db.service(`select public.portfolio_svc_smoke_finish(${L(smoke)});`)) === 'PASSED');
    due();
    const sw2 = await call({ action: 'sweep' });
    chk('with the test finished and Juice Reel still off, not even the operator\'s grant is synced', sw2.body.due === 0);
    chk('the switch cannot be thrown without a PASSED PRODUCTION test of juicereel_v1 and a cleared review', /cannot be enabled/.test(db.mustFail(() => db.service(
      `update public.portfolio_platform_registry set automatic_enabled = true, tos_review = 'CLEARED', enabled_by_smoke_test = gen_random_uuid() where platform_key = 'juicereel';`)) || '')
      && /enabled_evidence|violates/.test(db.mustFail(() => db.service(`update public.portfolio_platform_registry set automatic_enabled = true, enabled_by_smoke_test = ${L(smoke)} where platform_key = 'juicereel';`)) || ''));
    db.service(`update public.portfolio_platform_registry set automatic_enabled = true, tos_review = 'CLEARED', enabled_by_smoke_test = ${L(smoke)} where platform_key = 'juicereel';`);
    r = await call({ action: 'jr_status' }, 'tok-b');
    chk('switched on with its evidence: a reader may now connect', r.body.available === true && r.body.approval === 'ENABLED');

    /* ── PHASE 6 · multiple readers ── */
    b77.bets.push(bet(301, { userId: 77, result: 'Won', netResult: 50, amountRisked: 50, oddsAmerican: 100, toWin: 50, dateClosed: '2026-09-28T00:00:00.000Z', datePlaced: '2026-09-27T15:00:00.000Z' }),
      bet(302, { userId: 77, Site: { id: 20, name: 'FanDuel' }, datePlaced: '2026-09-28T15:00:00.000Z' }));
    op.bets.push(bet(303, { userId: 77, datePlaced: '2026-09-29T15:00:00.000Z', updatedAt: nowIso(-5000) }));   /* a stray bet of another user in the operator's feed */
    const okB = await connectAs('tok-b', 77);
    chk('reader B connects their own Juice Reel: their two bets, their own DraftKings and FanDuel accounts', okB.cb.body.ok && positions(B).rows.length === 2
      && accounts(B).map((a) => a.platform).join() === 'draftkings,fanduel' && positions(B).by['juicereel:301'].profit_loss === '50', okB.cb.body);
    syncable(); await call({ action: 'jr_sync' }, 'tok-op');
    chk('a bet of another Juice Reel user inside the operator\'s feed is never stored for the operator', !positions(OP).by['juicereel:303'] && !positions(B).by['juicereel:303']);
    chk('B sees none of the operator\'s bets, accounts, runs or settlements; the operator none of B\'s', db.as(B, `select (select count(*) from public.portfolio_positions where external_position_id not like 'juicereel:3%')
        + (select count(*) from public.platform_accounts where user_id <> ${L(B)}) + (select count(*) from public.portfolio_sync_runs where user_id <> ${L(B)})
        + (select count(*) from public.portfolio_position_settlements where user_id <> ${L(B)});`) === '0'
      && db.as(OP, `select count(*) from public.portfolio_positions where external_position_id in ('juicereel:301', 'juicereel:302');`) === '0');
    const opDk = accounts(OP).find((a) => a.platform === 'draftkings');
    const xs = await call({ action: 'sync', account_id: opDk.id }, 'tok-b'), xd = await call({ action: 'disconnect', account_id: opDk.id }, 'tok-b');
    chk('B cannot sync or disconnect the operator\'s Juice Reel books', xs.status === 404 && xd.status === 404 && grantRow(OP).status === 'CONNECTED');
    chk('B cannot call a Juice Reel service function or read the grants (tokens, cursors)', /permission denied/.test(db.mustFail(() => db.as(B, `select public.portfolio_svc_jr_grant_tokens(${L(grantRow(OP).id)});`)) || '')
      && /permission denied/.test(db.mustFail(() => db.as(B, `select * from portfolio_private.oauth_grants;`)) || '') && /permission denied/.test(db.mustFail(() => db.anon(`select count(*) from public.portfolio_positions;`)) || ''));
    const revB = J.revokes.length;
    const steal = await connectAs('tok-c', 4);
    chk('reader C connecting the operator\'s Juice Reel account: refused (already connected elsewhere), the tokens issued to C revoked at once, C has nothing',
      steal.cb.body.reason === 'JR_ACCOUNT_IN_USE' && J.revokes.length === revB + 2 && !grantRow(C) === false && grantRow(C).status === 'DISCONNECTED' && positions(C).rows.length === 0, steal.cb.body);

    /* ── the provider seam, and the server's switch ── */
    r = await call({ action: 'sb_status' }, 'tok-b');
    chk('sb_status (the seam every provider answers) names Juice Reel as this server\'s sportsbook sync provider, from the shared registry',
      r.body.available === true && r.body.provider.key === 'juicereel' && r.body.provider.link_origin === 'https://www.juicereel.com', r.body);
    const sbl = await call({ action: 'sb_link' }, 'tok-b'), sbb = await call({ action: 'sb_books' }, 'tok-b');
    chk('…sb_link opens Juice Reel\'s consent page (the same server-side state and PKCE as jr_start); sb_books lists none (Juice Reel names books only on bets)',
      sbl.status === 200 && sbl.body.url.indexOf('https://www.juicereel.com/oauth2/authorize?') === 0 && /code_challenge_method=S256/.test(sbl.body.url)
        && sbb.status === 200 && Array.isArray(sbb.body.books) && sbb.body.books.length === 0, { sbl: sbl.body, sbb: sbb.body });
    const fnOff = load(Object.assign({}, env, { SPORTSBOOK_SYNC_PROVIDER: '' }));
    const off = async (body, token) => {
      const x = await fnOff(new Request('https://fn.local/portfolio_connect', { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' },
        token ? { authorization: 'Bearer ' + token } : {}), body: JSON.stringify(body || {}) }));
      const out = { status: x.status, body: await x.json() };
      fnResponses.push(JSON.stringify(out.body));
      return out;
    };
    r = await off({ action: 'jr_status' }, 'tok-op');
    chk('switch OFF (SPORTSBOOK_SYNC_PROVIDER unset): Juice Reel is not offered (SYNC_OFF) — but the reader\'s existing connection is still shown, so it can be removed',
      r.body.available === false && r.body.reason === 'SYNC_OFF' && r.body.grant && r.body.grant.status === 'CONNECTED', r.body);
    const offStart = await off({ action: 'jr_start' }, 'tok-op'), offSync = await off({ action: 'jr_sync' }, 'tok-op');
    const offAcct = await off({ action: 'sync', account_id: opDk.id }, 'tok-op'), offSb = await off({ action: 'sb_status' }, 'tok-op');
    chk('…nothing links or syncs: jr_start, jr_sync and a book\'s Sync now answer 403 SYNC_OFF; sb_status names no provider',
      offStart.status === 403 && offStart.body.reason === 'SYNC_OFF' && offSync.status === 403 && offSync.body.reason === 'SYNC_OFF'
        && offAcct.status === 403 && offAcct.body.reason === 'SYNC_OFF' && offSb.body.available === false && offSb.body.provider === null);
    due(); const callsOff = J.calls.length, swOff = await off({ action: 'sweep' });
    chk('…and its scheduler reads nothing from Juice Reel', swOff.status === 200 && J.calls.length === callsOff);

    /* ── disconnect: revoked at Juice Reel, history kept or deleted as asked ── */
    const famOp = J.familyOfUser(4);
    r = await call({ action: 'jr_disconnect' }, 'tok-op');
    const g6 = grantRow(OP);
    chk('disconnect: EdgeDesk\'s copy deleted, both tokens revoked at Juice Reel (refresh first), every book DISCONNECTED, history KEPT',
      r.status === 200 && r.body.provider_revoked === true && /confirmed it is revoked/.test(r.body.revoke) && g6.status === 'DISCONNECTED' && !g6.sealed
        && famOp.every((f) => J.families[f].revoked) && J.revokes.slice(-2).map((x) => x.hint).join() === 'refresh_token,access_token'
        && accounts(OP).filter((a) => a.metadata.provider === 'juicereel').every((a) => a.status === 'DISCONNECTED') && positions(OP).rows.length === n0, r.body);
    due();
    chk('a disconnected grant is never synced (the scheduler does not list it; Sync now finds no connection)',
      db.service(`select count(*) from public.portfolio_svc_jr_due('production', 50) where grant_id = ${L(g6.id)};`) === '0' && (await call({ action: 'jr_sync' }, 'tok-op')).status === 404);
    J.fail['/oauth2/revoke'] = [503, 503];
    r = await off({ action: 'jr_disconnect', delete_history: true }, 'tok-b');
    chk('disconnect and delete history WITH SYNC SWITCHED OFF (and Juice Reel not answering the revoke): the revoke is still attempted, EdgeDesk\'s copy is gone anyway, the reader is told to remove EdgeDesk at Juice Reel too, the synced bets and their books deleted',
      r.status === 200 && r.body.provider_revoked === false && J.fail['/oauth2/revoke'].length < 2 && /did not confirm/.test(r.body.revoke) && !grantRow(B).sealed
        && positions(B).rows.length === 0 && accounts(B).length === 0 && !/sealed|ciphertext/.test(JSON.stringify(r.body)), r.body);
    J.fail['/oauth2/revoke'] = [];

    /* ── delete everything: the grant goes with it — and a heavy bettor first ── */
    const heavy = J.user(55, 'Heavy Bettor');
    for (let i = 0; i < 1100; i++) {
      heavy.bets.push(bet(50000 + i, { userId: 55, result: 'Lost', netResult: -10, amountRisked: 10, toWin: 9.09, oddsAmerican: -110,
        datePlaced: new Date(Date.parse('2026-06-01T00:00:00Z') + i * 3600000).toISOString(), dateClosed: new Date(Date.parse('2026-06-01T03:00:00Z') + i * 3600000).toISOString(),
        BetStatus: { id: 2, statusName: 'Closed' } }));
    }
    const ps0 = J.pageSize; J.pageSize = 200;
    const okC = await connectAs('tok-c', 55);
    for (let i = 0; i < 10 && JSON.parse(grantRow(C).sync_cursor || '{}').initial_done !== true; i++) {
      db.sql(`update portfolio_private.oauth_grants set next_sync_at = now() - interval '1 minute' where user_id = ${L(C)};`); await call({ action: 'sweep' });
    }
    J.pageSize = ps0;
    chk('a heavy bettor — 1,100 settled bets at ONE book — is imported in full (the bets moved between books are checked in chunks)',
      okC.cb.body.ok && grantRow(C).sealed && positions(C).rows.length === 1100 && JSON.parse(grantRow(C).sync_cursor).initial_done === true, { cb: okC.cb.body.sync, n: positions(C).rows.length });
    db.as(C, `select public.portfolio_delete_everything('DELETE MY PORTFOLIO');`);
    chk('"delete everything" removes the Juice Reel grant, its sealed tokens included', grantRow(C) === null);

    /* ── nothing secret anywhere ── */
    const everything = logs.join('\n') + '\n' + fnResponses.join('\n');
    const secrets = [J.clientSecret, SERVICE].concat(J.issued, Object.keys(J.codes), [opened.verifier]);
    chk('no client secret, service key, access or refresh token, authorization code or PKCE verifier appears in any log line or any response',
      secrets.every((s) => everything.indexOf(s) < 0) && logs.every((l) => { try { return JSON.parse(l).fn === 'portfolio_connect'; } catch (_) { return false; } }), secrets.filter((s) => everything.indexOf(s) >= 0).slice(0, 3));
    const dump = db.sql(`select coalesce(string_agg(t::text, ' '), '') from (select row_to_json(x)::text as t from public.platform_accounts x union all select row_to_json(x)::text from public.portfolio_positions x
        union all select row_to_json(x)::text from public.portfolio_sync_runs x union all select row_to_json(x)::text from portfolio_private.connect_sessions x
        union all select row_to_json(x)::text from portfolio_private.oauth_grants x) q;`);
    chk('…nor in any table, in any form (the grants hold ciphertext only)', J.issued.concat([J.clientSecret]).every((s) => dump.indexOf(s) < 0));
    chk('no SharpSports request was made while it is retired', !hostsSeen['api.sharpsports.io']);
    const health = JSON.parse(one(db.as(OP, `select public.portfolio_admin_juicereel_health();`)));
    chk('the operator panel counts Juice Reel connections by state, no reader in it', health.grants['production:DISCONNECTED'] === 2 && !JSON.stringify(health).includes(OP)
      && /operators only/.test(db.mustFail(() => db.as(B, `select public.portfolio_admin_juicereel_health();`)) || ''));
  } catch (e) {
    chk('unexpected failure', false, String(e && (e.sqlMessage || e.stack) || e).slice(0, 2000));
  } finally {
    db.stop();
  }
  process.exit(T.done());
}
