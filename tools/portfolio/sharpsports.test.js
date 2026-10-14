#!/usr/bin/env node
/* ===========================================================================
   SHARPSPORTS BETSYNC, END TO END — the two SHIPPED functions
   (supabase/functions/portfolio_connect/index.ts and
   supabase/functions/sharpsports-webhook/index.ts) in a stub Deno runtime,
   over the REAL migrations (portfolio.sql → portfolio_journal.sql →
   portfolio_connect.sql → portfolio_aggregator.sql) on a throwaway
   PostgreSQL, against a FAKE SharpSports.

   WHAT THIS IS NOT. It is not SharpSports' sandbox. The fake answers in the
   shapes this connector expects (lib/edgedesk_portfolio_connect_core.js
   SHARPSPORTS.contract); where SharpSports' documentation could not be read,
   so could not be checked here either (docs/platform-connections.md §
   SharpSports, "unverified"). The live sandbox run is
   tools/portfolio/connector_smoke.js. What this DOES prove is everything on
   EdgeDesk's side of the wire:

     - a bettor reference is made on first link, with an opaque internal id
       (never the reader's account id), and SharpSports' context is created
       with the PUBLIC key and a return URL on the app; data reads use the
       PRIVATE key; neither appears in a response or a log line;
     - sandbox linking is for operators only; production refuses while the
       registry has SharpSports switched off;
     - linking a book: a webhook (a hint) → discovery from the API → an
       AGGREGATOR account for the BOOK → the first sync: history imported,
       parlays with legs, cash-outs, pushes, half results, settlements
       recorded; slips that cannot be read without guessing are listed;
     - a new wager, then its settlement; a refresh (rate-limited, recorded,
       closed when SharpSports reports the result); paging;
     - failed verification and lost access → ACTION REQUIRED, history kept;
       reauthentication by a fresh link;
     - a duplicate delivery is answered and not applied twice; an unsigned
       or wrongly signed delivery is refused (401) when signatures are
       required, and in observe mode can only make a held account due;
     - another reader sees and touches none of it;
     - a bet the reader imported from a file is ADOPTED by the synced one
       (one position, the journal kept); an ambiguous one is reported;
     - the same history twice changes nothing; disconnect keeps or deletes
       the synced history as asked.

   Run: node tools/portfolio/sharpsports.test.js
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
const K = require(path.join(PG.ROOT, 'lib', 'edgedesk_portfolio_connect_core.js'));

const T = PG.kit('sharpsports betsync');
const chk = T.chk;
const L = PG.lit;
const FN_DIR = path.join(PG.ROOT, 'supabase', 'functions');
const AGG_FILE = path.join(PG.ROOT, 'supabase', 'portfolio_aggregator.sql');
const AGG = fs.readFileSync(AGG_FILE, 'utf8');
const HOOK_SRC = fs.readFileSync(path.join(FN_DIR, 'sharpsports-webhook', 'index.ts'), 'utf8');

/* ═══ STATIC ═════════════════════════════════════════════════════════════ */
chk('every aggregator service function asserts its caller first',
  (AGG.match(/create or replace function public\.portfolio_svc_(?!assert)\w+/g) || []).length === (AGG.match(/perform public\.portfolio_svc_assert\(\);/g) || []).length);
chk('the SharpSports seed never writes automatic_enabled', !/automatic_enabled\s*=\s*excluded/.test(AGG) && !/insert into public\.portfolio_platform_registry \([^)]*automatic_enabled/.test(AGG));
chk('the webhook lives at exactly the registered URL\'s function name (sharpsports-webhook)', fs.existsSync(path.join(FN_DIR, 'sharpsports-webhook', 'index.ts'))
  && /functions\/v1\/sharpsports-webhook/.test(HOOK_SRC) && /deploy sharpsports-webhook --no-verify-jwt/.test(HOOK_SRC));
chk('the webhook function imports nothing (one file, the core inlined)', !/^\s*import\s/m.test(HOOK_SRC) && /BEGIN CONNECT CORE/.test(HOOK_SRC));
chk('both functions carry the current core', require('./inline_connect_core.js').inSync());
chk('every SharpSports request the connector makes is labelled DOCUMENTED or INFERRED, and every INFERRED one is a read-only GET',
  Object.keys(K.SHARPSPORTS.contract).every((k) => { const c = K.SHARPSPORTS.contract[k]; return (c.seen === 'DOCUMENTED' || (c.seen === 'INFERRED' && c.method === 'GET')) && /^(public|private)$/.test(c.key); }));
chk('the registry still offers no sportsbook a direct connection (books reach EdgeDesk only through the aggregator)',
  K.REGISTRY.filter((p) => p.source_type === 'SPORTSBOOK').every((p) => p.automatic === null) && K.aggregatorInfo('sharpsports').method === 'AUTHORIZED_API');
(function partsAreCurrent() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfa-parts-'));
  cp.execFileSync(process.execPath, [path.join(PG.ROOT, 'tools', 'sql', 'split_sql.js'), AGG_FILE, dir, '18000']);
  const fresh = fs.readdirSync(dir).filter((f) => /^portfolio_aggregator\.part/.test(f)).sort();
  const committed = fs.readdirSync(path.join(PG.ROOT, 'supabase', 'parts')).filter((f) => /^portfolio_aggregator\.part/.test(f)).sort();
  chk('supabase/parts/portfolio_aggregator.part*.sql are current (npm run portfolio:parts)', fresh.length > 0 && JSON.stringify(fresh) === JSON.stringify(committed)
    && fresh.every((f) => fs.readFileSync(path.join(dir, f), 'utf8') === fs.readFileSync(path.join(PG.ROOT, 'supabase', 'parts', f), 'utf8')), { fresh, committed });
  fs.rmSync(dir, { recursive: true, force: true });
}());

/* the normalizer, offline: exact money, every outcome, nothing guessed */
(function normalizer() {
  const ev = (h, a, lg, t) => ({ sport: 'Football', league: lg, startTime: t, contestantHome: { fullName: h }, contestantAway: { fullName: a } });
  const r = K.sharpsportsNormalize([
    { id: 'SLIP_n1', type: 'single', oddsAmerican: -110, atRisk: 11000, toWin: 10000, status: 'completed', outcome: 'win', netProfit: 10000, timePlaced: '2026-09-14T16:00:00Z',
      timeClosed: '2026-09-14T20:00:00Z', bets: [{ proposition: 'spread', position: 'Miami Dolphins', line: 4.5, event: ev('Kansas City Chiefs', 'Miami Dolphins', 'NFL', '2026-09-14T17:00:00Z') }] },
    { id: 'SLIP_n2', type: 'parlay', subtype: 'teaser', oddsAmerican: 160, atRisk: 1000, toWin: 1600, status: 'pending', timePlaced: '2026-09-14T15:00:00Z',
      bets: [{ proposition: 'spread', position: 'Chiefs', line: -1.5, status: 'pending', event: ev('Kansas City Chiefs', 'Miami Dolphins', 'NFL', '2026-09-14T17:00:00Z') },
        { proposition: 'spread', position: 'Bills', line: 2.5, status: 'pending', event: ev('Buffalo Bills', 'New York Jets', 'NFL', '2026-09-14T20:25:00Z') }] },
    { id: 'SLIP_n3', type: 'single', oddsAmerican: 150, atRisk: 2000, toWin: 3000, status: 'completed', outcome: 'cashout', timePlaced: '2026-09-20T15:00:00Z' },
    { id: 'SLIP_n4', type: 'single', oddsAmerican: 200, atRisk: 0, toWin: 1000, status: 'pending', timePlaced: '2026-10-01T15:00:00Z' },
    { id: 'SLIP_n5', type: 'single', oddsAmerican: 200, atRisk: 500, toWin: 1000, status: 'pending', timePlaced: null },
    { id: 'SLIP_n6', type: 'single', oddsAmerican: 200, atRisk: 500, toWin: 1000, status: 'completed', outcome: 'mystery', timePlaced: '2026-10-01T15:00:00Z' },
    { id: 'SLIP_n7', type: 'single', oddsAmerican: 100, atRisk: 1050.5, toWin: 1000, status: 'pending', timePlaced: '2026-10-01T15:00:00Z' },
    { id: 'SLIP_n8', type: 'single', oddsAmerican: 'x', atRisk: 1000, toWin: 909, status: 'completed', outcome: 'halfloss', netProfit: -500, timePlaced: '2026-10-01T10:00:00Z' }
  ], { platform: 'draftkings' });
  const by = {}; r.positions.forEach((p) => { by[p.external_position_id] = p; });
  const a = by['sharpsports:SLIP_n1'], b = by['sharpsports:SLIP_n2'], h = by['sharpsports:SLIP_n8'];
  chk('normalizer: cents become exact dollars; a win pays atRisk + netProfit; the event, market, side and sport are read',
    a && a.stake === '110' && a.reported_payout === '210' && a.status === 'WON' && a.event_name === 'Miami Dolphins at Kansas City Chiefs'
      && a.selection === 'Miami Dolphins +4.5' && a.side === 'Miami Dolphins' && a.position_type === 'SPREAD' && a.sport === 'NFL' && a.legs === null, a);
  chk('normalizer: a teaser is a parlay with its legs (EdgeDesk\'s leg shape), still open, its type in the market name',
    b && b.status === 'OPEN' && b.position_type === 'PARLAY' && b.market_name === 'Teaser (2 legs)' && b.legs.length === 2 && b.legs[0].result === 'OPEN'
      && b.legs[1].selection === 'Bills +2.5' && b.reported_payout === null && b.settled_at === null, b);
  chk('normalizer: a half loss is LOST with the half stake returned; with no American odds the price comes from the book\'s own to-win',
    h && h.status === 'LOST' && h.reported_payout === '5' && h.odds_american === null && h.odds_decimal === '1.909', h);
  const codes = r.issues.map((x) => x.code + ':' + x.ref).sort().join(',');
  chk('normalizer: a cash-out without its amount, a free bet with no stake, a slip without a placed time, an unknown outcome and fractional cents are skipped and listed — none guessed',
    !by['sharpsports:SLIP_n3'] && !by['sharpsports:SLIP_n4'] && !by['sharpsports:SLIP_n5'] && !by['sharpsports:SLIP_n6'] && !by['sharpsports:SLIP_n7'] && r.skipped === 5
      && codes === 'MALFORMED_SLIP:SLIP_n7,NO_PAYOUT:SLIP_n3,NO_PLACED_TIME:SLIP_n5,NO_STAKE:SLIP_n4,UNKNOWN_OUTCOME:SLIP_n6', codes);
  const refs = K.sharpsportsWebhookRefs(JSON.stringify({ type: 'refreshResponse.created', data: { id: 'RRES_ab12cd34', bettorAccount: { id: 'BACT_Zx9y8w7v', bettor: 'BTTR_k1l2m3n4' },
    note: 'BACT_ inside text BACT_Zx9y8w7v again', betSlips: [{ id: 'SLIP_q1w2e3r4' }] } }));
  chk('a delivery\'s hints are the documented id prefixes, wherever they sit, each once',
    JSON.stringify(refs.bettor_account_ids) === '["BACT_Zx9y8w7v"]' && JSON.stringify(refs.bettor_ids) === '["BTTR_k1l2m3n4"]' && refs.slips === 1
      && JSON.stringify(refs.refresh_response_ids) === '["RRES_ab12cd34"]', refs);
}());

/* the Accounts tab, rendered in Node: BetSync appears only where the server
   says it is available, never asks for a credential, and says plainly what
   SharpSports reports */
(function accountsUi() {
  const UI = require(path.join(PG.ROOT, 'lib', 'edgedesk_portfolio_ui.js'));
  const base = Object.assign(UI.defaults(), { tab: 'accounts', positions: [{ id: 'p1' }], registry: {}, runs: [], now: Date.parse('2026-10-14T18:00:00Z'),
    setup: { selected: {}, open: true } });
  const acct = { id: 'a1', platform: 'draftkings', platform_label: 'DraftKings', platform_type: 'SPORTSBOOK', connection_type: 'AGGREGATOR', ingestion_method: 'AUTHORIZED_API',
    status: 'CONNECTED', positions: 6, open_positions: 1, last_success_at: '2026-10-14T17:58:00Z' };
  const off = UI.render.accounts(Object.assign({}, base, { accounts: [], betsync: null }));
  chk('Accounts without BetSync available: no BetSync panel, and the sportsbook copy is unchanged (Import, never Connect)',
    off.indexOf('data-r="betsync"') < 0 && /Sportsbooks · import/.test(off) && /no sportsbook offers customers an API/.test(off) && !/ss-link/.test(off));
  const S = Object.assign({}, base, { accounts: [acct], betsync: { ok: true, available: true, environment: 'sandbox', operator: true,
      provider: { what_the_reader_gives: K.SHARPSPORTS.what_the_reader_gives } },
    ssBooks: [{ name: 'DraftKings', platform: 'draftkings', label: 'DraftKings', status: 'active', sdk_required: false },
      { name: 'Ohio Super Book', platform: 'custom_ohio_super_book', label: 'Ohio Super Book', status: 'active', sdk_required: true }], ssPick: 'draftkings',
    connections: { a1: { id: 'a1', metadata: { provider: 'sharpsports', environment: 'sandbox', provider_state: { verified: true, access: true, book: { name: 'DraftKings' }, region: { name: 'DraftKings Ohio' } } } } },
    refreshes: [{ platform_account_id: 'a1', status: 'ACCEPTED', requested_at: '2026-10-14T17:57:00Z' }] });
  const on = UI.render.accounts(S);
  chk('BetSync available (sandbox, operator): the panel, the sandbox warning, the books (an app-only book disabled), Connect <book>, and no field for a password',
    /data-r="betsync"/.test(on) && /data-r="betsync-sandbox"/.test(on) && /Connect DraftKings/.test(on) && /app only/.test(on)
      && /never sees your sportsbook password/.test(on) && !/type="password"|name="password"|name="username"/.test(on) && /Sportsbooks · connect or import/.test(on));
  chk('a linked book\'s card: BetSync (SharpSports) · sandbox, verified with its book and region, the refresh waiting, and Refresh from book / Sync now / Disconnect',
    /BetSync \(SharpSports\) · sandbox/.test(on) && /SharpSports: verified · DraftKings · DraftKings Ohio/.test(on) && /Book refresh requested 3 min ago, waiting for SharpSports/.test(on)
      && /data-act="ss-refresh" data-id="a1"/.test(on) && /data-act="acct-sync" data-id="a1"/.test(on) && /data-act="acct-disconnect" data-id="a1"/.test(on));
  const need = UI.render.accounts(Object.assign({}, S, { accounts: [Object.assign({}, acct, { status: 'ACTION_REQUIRED', last_error: K.ERRORS.RELINK_REQUIRED })],
    connections: { a1: { id: 'a1', metadata: { provider: 'sharpsports', environment: 'sandbox', provider_state: { verified: false, access: true } } } }, refreshes: [] }));
  chk('an expired link: Action required, the reason in plain words, Reconnect through SharpSports, no Sync now',
    /Action required/.test(need) && /Reconnect it to resume syncing/.test(need) && /SharpSports: signing in to this book failed/.test(need)
      && /data-act="ss-link">Reconnect/.test(need) && !/data-act="acct-sync" data-id="a1"/.test(need));
}());

/* PHASE 5 in Node: a synced parlay's legs on its Open card; units only where a unit size exists; the bankroll path */
(function tabsUi() {
  const UI = require(path.join(PG.ROOT, 'lib', 'edgedesk_portfolio_ui.js'));
  const J = require(path.join(PG.ROOT, 'lib', 'edgedesk_portfolio_journal_ui.js'));
  const norm = K.sharpsportsNormalize([{ id: 'SLIP_ui001', type: 'parlay', oddsAmerican: 264, atRisk: 1000, toWin: 2640, status: 'pending', timePlaced: '2026-10-14T15:00:00Z',
    bets: [{ proposition: 'moneyline', position: 'Kansas City Chiefs', oddsAmerican: -150, status: 'completed', outcome: 'win', event: { league: 'NFL', contestantHome: { fullName: 'Kansas City Chiefs' }, contestantAway: { fullName: 'Miami Dolphins' } } },
      { proposition: 'total', position: 'Over', line: 47.5, oddsAmerican: -110, status: 'pending', event: { league: 'NFL', contestantHome: { fullName: 'Buffalo Bills' }, contestantAway: { fullName: 'New York Jets' } } }] }],
    { platform: 'draftkings' }).positions[0];
  const pos = Object.assign({ id: 'p9', platform_label: 'DraftKings', platform_type: 'SPORTSBOOK', source: 'SYNC', open_cost_basis: '10', potential_profit: '26.4', potential_payout: '36.4' }, norm);
  const S = Object.assign(UI.defaults(), { tab: 'open', positions: [pos], accounts: [], now: Date.parse('2026-10-14T18:00:00Z') });
  const open = UI.render.open(S);
  chk('Open: a synced parlay shows each leg with the book\'s state for it (won, pending)', /data-r="legs"/.test(open) && /Kansas City Chiefs/.test(open) && /Over 47\.5/.test(open)
    && /pfo-leg-st WON">won/.test(open) && /pfo-leg-st OPEN">pending/.test(open) && /Details/.test(open), open.slice(0, 300));
  const sm = { settled: { n: 5, pnl: 90, staked: 165, roi: 0.5, wins: 2, losses: 1, pushes: 1, cashouts: 1, units_pnl: null, units_n: 0 }, open: { n: 1, exposure: 25 }, placed: { n: 6 } };
  chk('Overview: no Units figure claimed when no position was recorded with a unit size', !/Units/.test(J.hero(sm, 'all time')));
  const sm2 = JSON.parse(JSON.stringify(sm)); sm2.settled.units_pnl = 4.5; sm2.settled.units_n = 3;
  const mcOk = UI.modelContextView({ accepted_odds_american: -200, market_implied_probability: 0.666667, matched: true, edgedesk_probability: 0.7, probability_basis: 'THE_MODELS_SIDE',
    model_market_difference: 0.033333, outcome: 'WIN', status: 'WON', realized_return: 0.5, model: { game: 'MIA @ KC', market: 'moneyline', model_side: 'KC ML', recorded_at: '2026-09-18T12:00:00Z', evidence: 'RECONSTRUCTED' } });
  chk('Decision Record: EdgeDesk\'s model at the time — price, implied, model, difference, outcome — said to be recorded before the bet, labelled reconstructed, and kept out of the results',
    /66\.7%/.test(mcOk) && /70\.0%/.test(mcOk) && /\+3\.3 pts/.test(mcOk) && /before you placed the bet/.test(mcOk) && /published history, not captured live/.test(mcOk) && /not counted in your results/.test(mcOk));
  const mcLate = UI.modelContextView({ accepted_odds_american: -115, market_implied_probability: 0.53, matched: false, reason: 'MODEL_AFTER_PLACEMENT' });
  chk('Decision Record: a model record made after the bet is refused in plain words, with no model figure', /only after you placed the bet/.test(mcLate) && !/EdgeDesk probability/.test(mcLate));
  chk('Overview: units won or lost, with how many positions carry a unit size', /Units/.test(J.hero(sm2, 'all time')) && /\+4\.50u/.test(J.hero(sm2, 'all time')) && /on 3 with a unit size/.test(J.hero(sm2, 'all time')));
}());

const db = PG.start('ssb');
if (db.skip) {
  if (process.env.PORTFOLIO_SQL_REQUIRED === '1') chk('a PostgreSQL cluster starts (required in CI)', false, db.skip);
  console.log('NOTE | ' + db.skip + ' — LIVE layer skipped');
  process.exit(T.done());
}
const ADMIN = 'e7e46801-80c4-4f47-b718-4aff211c8d3a';   // an operator (portfolio_is_admin's fallback)
const B = '00000000-0000-0000-0000-00000000000b';       // another reader
const SB = 'https://project.supabase.co', SERVICE = 'service-role-key-for-tests', ANON = 'anon-key-for-tests';
const TOKENS = { 'tok-admin': ADMIN, 'tok-b': B };
const SS_PRIV = 'ss-private-sandbox-key-0123456789', SS_PUB = 'ss-public-sandbox-key-0123456789';
const HOOK_SECRET = 'hmac-secret-for-subscription-one', SUB_ID = '6f0c2a8e-1b9d-4a3e-9f61-2b7d0c5e8a11';
const one = (s) => String(s).split('\n')[0];
const jq = (s) => JSON.parse(String(s).trim() || 'null');   /* json_agg spans lines */
const count = (sql) => +db.sql(sql);
function res(status, body, headers) {
  return new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: Object.assign({ 'content-type': 'application/json' }, headers || {}) });
}

/* ── the fake SharpSports ── */
const SS = { contexts: [], refreshes: [], keyUse: [], bettors: {}, accounts: {}, slips: {}, pageSize: 0, refreshAt: {} };
function ssAccount(id, internalId, book, o) {
  SS.accounts[id] = Object.assign({ id, bettor: { id: SS.bettors[internalId].id, internalId }, book: { id: 'BOOK_' + book.toLowerCase().slice(0, 6), name: book, abbr: book.slice(0, 2).toLowerCase() },
    bookRegion: { id: 'REGN_' + book.slice(0, 4), name: book + ' Ohio', abbr: 'oh' }, verified: true, access: true, paused: false, refreshInProgress: false,
    latestRefreshResponse: null, timeCreated: '2026-10-14T12:00:00Z' }, o || {});
  SS.bettors[internalId].accounts.push(id);
  SS.slips[id] = SS.slips[id] || [];
}
function ssFetch(u, init) {
  const h = init.headers || {}, auth = String(h.authorization || ''), p = u.pathname.replace(/^\/v1/, ''), m = (init.method || 'GET').toUpperCase();
  /* SharpSports' sandbox and live modes each have their own keys; the fake knows both and records which was used */
  const as = (kind) => {
    const live = auth === 'Token ' + (kind === 'public' ? 'live-public' : 'live-private');
    SS.keyUse.push(m + ' ' + p.replace(/[A-Z]{4}_[A-Za-z0-9]+|ed_[0-9a-f]{32}/g, '{id}') + ' ' + kind + (live ? ' LIVE' : ''));
    return live || auth === 'Token ' + (kind === 'public' ? SS_PUB : SS_PRIV);
  };
  let x;
  if (m === 'POST' && p === '/context') {
    if (!as('public')) return res(401, { detail: 'bad key' });
    const b = JSON.parse(init.body);
    SS.contexts.push(b);
    if (!SS.bettors[b.internalId]) SS.bettors[b.internalId] = { id: 'BTTR_' + nodeCrypto.randomBytes(5).toString('hex'), accounts: [] };
    return res(200, { cid: 'CTX_' + SS.contexts.length + 'abc' });
  }
  if (m === 'GET' && p === '/books') { if (!as('public')) return res(401, {}); return res(200, [{ id: 'BOOK_dk', name: 'DraftKings', abbr: 'dk', status: 'active', sdkRequired: false },
    { id: 'BOOK_zz', name: 'Ohio Super Book', abbr: 'zz', status: 'active', sdkRequired: true }]); }
  if (m === 'GET' && (x = /^\/bettors\/([^/]+)\/bettorAccounts$/.exec(p))) {
    if (!as('private')) return res(401, {});
    const key = decodeURIComponent(x[1]);
    const internal = Object.keys(SS.bettors).find((k) => k === key || SS.bettors[k].id === key);
    if (!internal) return res(404, { detail: 'no bettor' });
    return res(200, SS.bettors[internal].accounts.map((id) => SS.accounts[id]));
  }
  if (m === 'GET' && (x = /^\/bettorAccounts\/([^/]+)$/.exec(p))) {
    if (!as('private')) return res(401, {});
    const a = SS.accounts[decodeURIComponent(x[1])];
    return a ? res(200, a) : res(404, { detail: 'not found' });
  }
  if (m === 'GET' && (x = /^\/bettorAccounts\/([^/]+)\/betSlips$/.exec(p))) {
    if (!as('private')) return res(401, {});
    const id = decodeURIComponent(x[1]), a = SS.accounts[id];
    if (!a) return res(404, {});
    if (a.access === false) return res(403, { detail: 'access revoked' });
    const all = SS.slips[id] || [];
    if (!SS.pageSize) return res(200, all);
    const page = +(u.searchParams.get('page') || 1), rows = all.slice((page - 1) * SS.pageSize, page * SS.pageSize);
    return res(200, { data: rows, next: page * SS.pageSize < all.length ? 'https://api.sharpsports.io/v1/bettorAccounts/' + id + '/betSlips?page=' + (page + 1) : null });
  }
  if (m === 'POST' && (x = /^\/bettorAccounts\/([^/]+)\/refresh$/.exec(p))) {
    if (!as('public')) return res(401, {});
    const id = decodeURIComponent(x[1]);
    if (!SS.accounts[id]) return res(404, {});
    if (SS.refreshAt[id] && Date.now() - SS.refreshAt[id] < 60000) return res(429, { detail: 'rate limited' });
    SS.refreshAt[id] = Date.now();
    SS.refreshes.push({ id, reverify: u.searchParams.get('reverify') === 'true' });
    return res(200, { requestId: 'RREQ_' + SS.refreshes.length + 'xyz' });
  }
  return res(404, { detail: 'no route ' + m + ' ' + p });
}
const ev = (h, a, lg, t) => ({ name: null, sport: 'Football', league: lg, startTime: t, contestantHome: { fullName: h }, contestantAway: { fullName: a } });
const slip = (id, o) => Object.assign({ id, type: 'single', oddsAmerican: -110, atRisk: 11000, toWin: 10000, status: 'pending', outcome: null, timePlaced: '2026-10-10T16:00:00Z',
  bets: [{ id: 'BET_' + id.slice(5), proposition: 'spread', position: 'Miami Dolphins', line: 4.5, oddsAmerican: -110, status: 'pending',
    event: ev('Kansas City Chiefs', 'Miami Dolphins', 'NFL', '2026-10-12T17:00:00Z') }] }, o || {});

(async function main() {
  try {
    for (const f of ['portfolio.sql', 'portfolio_journal.sql', 'portfolio_connect.sql', 'portfolio_aggregator.sql']) db.applyFileAtomic(path.join(PG.ROOT, 'supabase', f));
    /* the deploy workflow run a second time: every file in order on a database that has all of them */
    const again = ['portfolio.sql', 'portfolio_journal.sql', 'portfolio_connect.sql', 'portfolio_aggregator.sql']
      .filter((f) => /CHECK THIS/.test(db.applyFileAtomic(path.join(PG.ROOT, 'supabase', f))));
    chk('a second deploy reports ok in every file (portfolio.sql counts only its own tables\' policies)', again.length === 0, again.join(', '));
    db.sql(`insert into auth.users (id, email) values (${L(ADMIN)}, 'op@example.com'), (${L(B)}, 'b@example.com');`);
    const rest = REST.make(db, { tokens: Object.assign({ [SERVICE]: 'service_role' }, TOKENS) });

    /* two shipped functions, each in its own stub Deno */
    const logs = [];
    function load(dir, env) {
      let handler = null;
      const sandbox = { Deno: { env: { get: (k) => env[k] }, serve: (h) => { handler = h; } }, fetch: (u, i) => fakeFetch(u, i), Response, Request, Headers, URL, URLSearchParams,
        TextEncoder, TextDecoder, crypto: globalThis.crypto, btoa, atob, AbortController, setTimeout, clearTimeout,
        console: { log: (x) => logs.push(String(x)), error: (x) => logs.push(String(x)) } };
      sandbox.globalThis = sandbox; sandbox.self = sandbox;
      vm.runInNewContext(fs.readFileSync(path.join(FN_DIR, dir, 'index.ts'), 'utf8'), sandbox, { filename: dir + '/index.ts' });
      return handler;
    }
    const connectEnv = { SB_URL: SB, SB_SERVICE_ROLE: SERVICE, SUPABASE_ANON_KEY: ANON, SHARPSPORTS_API_KEY: SS_PRIV, SHARPSPORTS_PUBLIC_KEY: SS_PUB };
    const hookEnv = { SB_URL: SB, SB_SERVICE_ROLE: SERVICE, SHARPSPORTS_WEBHOOK_SECRETS: JSON.stringify({ [SUB_ID]: HOOK_SECRET }) };
    let connect = null, hook = null;
    async function fakeFetch(url, init) {
      init = init || {};
      const u = new URL(url), h = init.headers || {}, auth = String(h.authorization || h.Authorization || '').replace(/^Bearer\s+/i, '');
      if (u.origin === SB && u.pathname === '/auth/v1/user') return TOKENS[auth] ? res(200, { id: TOKENS[auth] }) : res(401, { msg: 'bad jwt' });
      if (u.origin === SB && u.pathname.indexOf('/rest/v1/') === 0) {
        const p = decodeURIComponent(u.pathname.slice('/rest/v1/'.length));
        const out = rest.handle(init.method || 'GET', p, u.search.slice(1), init.body ? JSON.parse(init.body) : null, h.prefer || '', auth);
        return new Response(out.body == null ? '' : JSON.stringify(out.body), { status: out.status });
      }
      if (u.origin === SB && u.pathname === '/functions/v1/portfolio_connect') return connect(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: init.body }));
      if (u.hostname === 'api.sharpsports.io') return ssFetch(u, init);
      throw new Error('no network: ' + url);
    }
    connect = load('portfolio_connect', connectEnv);
    hook = load('sharpsports-webhook', hookEnv);
    chk('both shipped functions load and register a handler', typeof connect === 'function' && typeof hook === 'function');
    const call = async (body, token) => {
      const r = await connect(new Request('https://fn.local/portfolio_connect', { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' },
        token ? { authorization: 'Bearer ' + token } : {}), body: JSON.stringify(body || {}) }));
      return { status: r.status, body: await r.json() };
    };
    const deliver = async (obj, o) => {
      o = o || {};
      const raw = typeof obj === 'string' ? obj : JSON.stringify(obj);
      const headers = { 'content-type': 'application/json' };
      if (o.sub !== false) headers['hook-subscription'] = o.sub || SUB_ID;
      if (o.secret !== false) headers[o.header || 'x-test-signature'] = (o.prefix || '') + nodeCrypto.createHmac('sha256', o.secret || HOOK_SECRET).update(raw).digest(o.enc || 'hex');
      const r = await hook(new Request('https://fn.local/sharpsports-webhook', { method: o.method || 'POST', headers, body: o.method === 'GET' ? undefined : raw }));
      return { status: r.status, body: await r.json() };
    };
    const accountRow = (where) => jq(db.sql(`select coalesce(json_agg(a), '[]') from (select id, platform, connection_type, ingestion_method, connection_tier, status,
        external_account_id, last_error, next_sync_at, metadata from public.platform_accounts where ${where} order by created_at) a;`)) || [];

    /* ── health ── */
    let hr = await hook(new Request('https://fn.local/sharpsports-webhook', { method: 'GET' }));
    let hb = await hr.json();
    chk('webhook health: what is configured, never a value', hr.status === 200 && hb.environment === 'sandbox' && hb.configured.subscription_secrets === 1
      && hb.configured.verify === 'observe' && !JSON.stringify(hb).includes(HOOK_SECRET) && !JSON.stringify(hb).includes(SUB_ID));
    let r = await connect(new Request('https://fn.local/portfolio_connect', { method: 'GET' }));
    hb = await r.json();
    chk('portfolio_connect health names the SharpSports environment and which keys are present, never a key',
      hb.configured.sharpsports.environment === 'sandbox' && hb.configured.sharpsports.private_key === true && hb.configured.sharpsports.public_key === true
        && !JSON.stringify(hb).includes(SS_PRIV) && !JSON.stringify(hb).includes(SS_PUB));

    /* ── PHASE 2 · who may link ── */
    r = await call({ action: 'ss_link' });
    chk('no token, no link', r.status === 401);
    r = await call({ action: 'ss_status' }, 'tok-b');
    chk('sandbox: a reader is told linking is not open yet', r.status === 200 && r.body.available === false && r.body.reason === 'sandbox_operators_only' && r.body.environment === 'sandbox');
    r = await call({ action: 'ss_link' }, 'tok-b');
    chk('sandbox: a reader cannot link, and no bettor reference is made for them', r.status === 403
      && count(`select count(*) from portfolio_private.aggregator_bettors where user_id = ${L(B)};`) === 0 && SS.contexts.length === 0);
    r = await call({ action: 'ss_status' }, 'tok-admin');
    chk('sandbox: an operator may link', r.body.available === true && r.body.operator === true);
    r = await call({ action: 'ss_books' }, 'tok-admin');
    chk('the books SharpSports lists, mapped to EdgeDesk platforms (an unknown book keeps its own name)', r.status === 200
      && r.body.books.find((b) => b.name === 'DraftKings').platform === 'draftkings'
      && r.body.books.find((b) => b.name === 'Ohio Super Book').platform === 'custom_ohio_super_book' && r.body.books.find((b) => b.sdk_required).name === 'Ohio Super Book');

    /* ── creating the bettor: the first link ── */
    r = await call({ action: 'ss_link', return_to: 'https://evil.example/steal' }, 'tok-admin');
    const bettor = JSON.parse(one(db.sql(`select row_to_json(b) from portfolio_private.aggregator_bettors b where user_id = ${L(ADMIN)};`)));
    chk('link: a bettor reference with an OPAQUE internal id (not the reader\'s account id), sent to SharpSports\' context with the app as the way back',
      r.status === 200 && /^https:\/\/ui\.sharpsports\.io\/link\/CTX_1abc$/.test(r.body.url) && /^ed_[0-9a-f]{32}$/.test(bettor.internal_id)
        && bettor.internal_id.indexOf(ADMIN.replace(/-/g, '')) < 0 && SS.contexts[0].internalId === bettor.internal_id
        && SS.contexts[0].redirectUrl === 'https://edgedesksports.com/app.html?betsync=return#portfolio/accounts', { body: r.body, ctx: SS.contexts[0] });
    chk('…and a discovery pass is scheduled in case the reader never comes back', bettor.discover_at !== null);
    r = await call({ action: 'ss_link' }, 'tok-admin');
    chk('a second link reuses the bettor and asks SharpSports for a FRESH context', r.body.url.endsWith('/CTX_2abc')
      && count(`select count(*) from portfolio_private.aggregator_bettors;`) === 1 && SS.contexts[1].internalId === bettor.internal_id);

    /* the reader had imported DraftKings from a file before (one bet the sync will match) */
    db.as(ADMIN, `insert into public.portfolio_positions (platform, platform_label, platform_type, position_type, event_name, market_name, selection, line, odds_american, stake,
        status, reported_payout, placed_at, settled_at, source, notes)
      values ('draftkings', 'DraftKings', 'SPORTSBOOK', 'SPREAD', 'Dolphins @ Chiefs', 'Spread', 'Dolphins +4.5', 4.5, -110, 110, 'WON', 210, '2026-09-14T16:04:00Z', '2026-09-14T20:00:00Z', 'CSV', 'my note');`);
    const csvAcct = accountRow(`user_id = ${L(ADMIN)}`)[0];
    db.as(ADMIN, `update public.portfolio_journal_entries set review_note = 'I liked the hook' where position_id = (select id from public.portfolio_positions where source = 'CSV');`);

    /* ── connecting a test sportsbook: SharpSports links it and posts webhooks ── */
    ssAccount('BACT_dk0001', bettor.internal_id, 'DraftKings');
    SS.slips.BACT_dk0001 = [
      slip('SLIP_h0001', { status: 'completed', outcome: 'win', netProfit: 10000, timePlaced: '2026-09-14T16:00:00Z', timeClosed: '2026-09-14T20:00:00Z',
        bets: [{ proposition: 'spread', position: 'Miami Dolphins', line: 4.5, status: 'completed', outcome: 'win', event: ev('Kansas City Chiefs', 'Miami Dolphins', 'NFL', '2026-09-14T17:00:00Z') }] }),
      slip('SLIP_h0002', { type: 'parlay', oddsAmerican: 264, atRisk: 1000, toWin: 2640, status: 'completed', outcome: 'win', netProfit: 1000, timePlaced: '2026-09-15T15:00:00Z', timeClosed: '2026-09-16T03:00:00Z',
        bets: [{ proposition: 'moneyline', position: 'Kansas City Chiefs', oddsAmerican: -150, status: 'completed', outcome: 'win', event: ev('Kansas City Chiefs', 'Miami Dolphins', 'NFL', '2026-09-14T17:00:00Z') },
          { proposition: 'total', position: 'Over', line: 47.5, oddsAmerican: -110, status: 'completed', outcome: 'push', event: ev('Buffalo Bills', 'New York Jets', 'NFL', '2026-09-14T20:25:00Z') }] }),
      slip('SLIP_h0003', { oddsAmerican: 150, atRisk: 2000, toWin: 3000, status: 'completed', outcome: 'cashout', netProfit: 500, timePlaced: '2026-09-20T15:00:00Z', timeClosed: '2026-09-20T20:00:00Z' }),
      slip('SLIP_h0004', { oddsAmerican: 120, atRisk: 1000, toWin: 1200, status: 'completed', outcome: 'void', netProfit: 0, timePlaced: '2026-09-21T15:00:00Z', timeClosed: '2026-09-21T16:00:00Z' }),
      slip('SLIP_h0005', { oddsAmerican: 105, atRisk: 0, toWin: 1050, timePlaced: '2026-09-22T15:00:00Z' }),
      slip('SLIP_h0006', { timePlaced: '2026-10-10T16:00:00Z' })
    ];
    const created = { type: 'bettor.created', data: { id: SS.bettors[bettor.internal_id].id, internalId: bettor.internal_id } };
    r = await deliver(created);
    chk('webhook bettor.created (signed): recorded as SIGNATURE, the bettor marked for discovery, answered 200',
      r.status === 200 && r.body.ok && r.body.bettors_marked === 1 && r.body.accounts_marked === 0, r.body);
    const ev1 = JSON.parse(one(db.sql(`select row_to_json(e) from portfolio_private.aggregator_webhook_events e order by id limit 1;`)));
    chk('…the delivery keeps how it was authenticated and which header carried the signature (for the operator to pin)',
      ev1.authenticated_by === 'SIGNATURE' && ev1.signature_header === 'x-test-signature' && ev1.subscription_id === SUB_ID && ev1.status === 'PROCESSED' && ev1.payload !== null);
    r = await deliver(created);
    chk('the SAME delivery again: answered 200 as a duplicate and not applied twice', r.status === 200 && r.body.duplicate === true
      && count(`select count(*) from portfolio_private.aggregator_webhook_events;`) === 1 && count(`select attempts from portfolio_private.aggregator_webhook_events;`) === 2);
    /* the poke ran the sweep: discovery from the API, the account, its first sync */
    let accts = accountRow(`user_id = ${L(ADMIN)}`);
    const dk = accts.find((a) => a.external_account_id === 'BACT_dk0001');
    chk('discovery (from SharpSports\' API, not the webhook): the reader\'s QUICK IMPORT DraftKings account is upgraded IN PLACE to a tier-1 aggregator account',
      accts.length === 1 && dk && dk.id === csvAcct.id && dk.connection_type === 'AGGREGATOR' && dk.ingestion_method === 'AUTHORIZED_API' && dk.connection_tier === 1
        && dk.metadata.provider === 'sharpsports' && dk.metadata.environment === 'sandbox' && dk.metadata.provider_state.verified === true, accts);
    chk('the bettor id SharpSports reported for OUR internal id is confirmed', one(db.sql(`select provider_bettor_id from portfolio_private.aggregator_bettors;`)) === SS.bettors[bettor.internal_id].id);
    if (dk.status !== 'CONNECTED') await call({ action: 'sweep' });
    accts = accountRow(`user_id = ${L(ADMIN)}`);
    const pos = jq(db.sql(`select coalesce(json_agg(p order by external_position_id), '[]') from (select external_position_id, source, status, stake::text, reported_payout::text,
        profit_loss::text, position_type, market_name, legs, notes, platform_account_id from public.portfolio_positions where user_id = ${L(ADMIN)}) p;`));
    const byId = {}; pos.forEach((p) => { byId[p.external_position_id] = p; });
    chk('verified and synced: CONNECTED, the history imported (a win, a parlay with a pushed leg, a cash-out, a void, an open bet)',
      accts[0].status === 'CONNECTED' && byId['sharpsports:SLIP_h0002'].status === 'WON' && byId['sharpsports:SLIP_h0002'].profit_loss === '10'
        && byId['sharpsports:SLIP_h0002'].legs.length === 2 && byId['sharpsports:SLIP_h0002'].legs[1].result === 'PUSH'
        && byId['sharpsports:SLIP_h0003'].status === 'CASHED_OUT' && byId['sharpsports:SLIP_h0003'].profit_loss === '5'
        && byId['sharpsports:SLIP_h0004'].status === 'VOID' && byId['sharpsports:SLIP_h0004'].profit_loss === '0'
        && byId['sharpsports:SLIP_h0006'].status === 'OPEN' && byId['sharpsports:SLIP_h0006'].source === 'SYNC', pos);
    chk('RECONCILED: the bet the reader imported from a file was adopted by its synced copy — one position, their note and journal kept',
      pos.length === 5 && byId['sharpsports:SLIP_h0001'] && byId['sharpsports:SLIP_h0001'].source === 'CSV' && byId['sharpsports:SLIP_h0001'].notes === 'my note'
        && one(db.sql(`select review_note from public.portfolio_journal_entries j join public.portfolio_positions p on p.id = j.position_id where p.external_position_id = 'sharpsports:SLIP_h0001';`)) === 'I liked the hook');
    const run1 = JSON.parse(one(db.sql(`select row_to_json(r) from public.portfolio_sync_runs r order by started_at desc limit 1;`)));
    chk('the run is honest: PARTIAL, the free bet with no stake listed, nothing guessed', run1.status === 'PARTIAL' && run1.issues.some((x) => x.code === 'NO_STAKE' && x.ref === 'SLIP_h0005')
      && run1.positions_inserted === 4 && run1.positions_updated === 1 && run1.positions_settled === 3,
      { inserted: run1.positions_inserted, updated: run1.positions_updated, settled: run1.positions_settled, issues: run1.issues });
    /* the adopted bet already carried this result from the file: confirmed, not a change */
    chk('settlement records: every settled result the sync recorded or changed (the adopted file bet already had it), append-only',
      count(`select count(*) from public.portfolio_position_settlements where user_id = ${L(ADMIN)};`) === 3
      && /append-only/.test(db.mustFail(() => db.service(`update public.portfolio_position_settlements set status = 'LOST';`)) || ''));
    chk('a synced bet is read-only to the reader except notes', /read-only/.test(db.mustFail(() => db.as(ADMIN, `update public.portfolio_positions set stake = 1 where external_position_id = 'sharpsports:SLIP_h0006';`)) || '')
      && db.mustFail(() => db.as(ADMIN, `update public.portfolio_positions set notes = 'ok' where external_position_id = 'sharpsports:SLIP_h0006';`)) === null);
    chk('the private key is used for reads and the public key for the context and the book list, as documented',
      SS.keyUse.includes('POST /context public') && SS.keyUse.includes('GET /books public') && SS.keyUse.includes('GET /bettorAccounts/{id} private')
        && SS.keyUse.includes('GET /bettorAccounts/{id}/betSlips private') && SS.keyUse.includes('GET /bettors/{id}/bettorAccounts private'), SS.keyUse);

    /* ── the same history again: nothing changes ── */
    const before = one(db.sql(`select count(*) || ':' || max(updated_at) from public.portfolio_positions;`));
    db.sql(`update public.portfolio_sync_runs set started_at = started_at - interval '5 minutes';`);
    r = await call({ action: 'sync', account_id: dk.id }, 'tok-admin');
    /* still PARTIAL: the free bet it cannot store is listed again, honestly */
    chk('a manual sync of the same history: nothing inserted, nothing updated, no settlement recorded twice', r.status === 200 && r.body.totals.positions_inserted === 0
      && r.body.totals.positions_updated === 0 && r.body.totals.positions_unchanged === 5 && one(db.sql(`select count(*) || ':' || max(updated_at) from public.portfolio_positions;`)) === before
      && count(`select count(*) from public.portfolio_position_settlements;`) === 3 && r.body.status === 'PARTIAL', r.body);

    /* ── a new wager, then its settlement, through refresh + webhook ── */
    db.sql(`update public.portfolio_sync_runs set started_at = started_at - interval '5 minutes';`);
    r = await call({ action: 'ss_refresh', account_id: dk.id }, 'tok-admin');
    chk('refresh: SharpSports is asked to read the book (public key), and the request is recorded', r.status === 200 && r.body.status === 'ACCEPTED'
      && SS.refreshes.length === 1 && SS.keyUse.includes('POST /bettorAccounts/{id}/refresh public')
      && one(db.sql(`select status || ':' || provider_request_id from public.portfolio_refresh_requests;`)) === 'ACCEPTED:RREQ_1xyz');
    r = await call({ action: 'ss_refresh', account_id: dk.id }, 'tok-admin');
    chk('a second refresh inside 15 minutes is refused before SharpSports is asked', r.status === 429 && r.body.reason === 'too_soon' && SS.refreshes.length === 1);
    SS.slips.BACT_dk0001.push(slip('SLIP_n0007', { oddsAmerican: 140, atRisk: 2500, toWin: 3500, timePlaced: '2026-10-14T13:00:00Z',
      bets: [{ proposition: 'moneyline', position: 'Ohio State', status: 'pending', event: ev('Ohio State', 'Michigan', 'NCAAF', '2026-10-18T16:00:00Z') }] }));
    SS.accounts.BACT_dk0001.latestRefreshResponse = { id: 'RRES_r0001', status: 200, timeCreated: new Date().toISOString(), type: 'manual', detail: 'ok' };
    db.sql(`update public.platform_accounts set last_sync_at = now() - interval '5 minutes' where id = ${L(dk.id)};`);
    r = await deliver({ type: 'refreshResponse.created', data: { id: 'RRES_r0001', status: 200, bettorAccount: { id: 'BACT_dk0001', bettor: SS.bettors[bettor.internal_id].id }, betSlips: [{ id: 'SLIP_n0007' }] } });
    chk('webhook refreshResponse.created: the account it names is made due, and the sweep it pokes reads the new wager', r.status === 200 && r.body.accounts_marked === 1
      && one(db.sql(`select status || ':' || position_type || ':' || sport from public.portfolio_positions where external_position_id = 'sharpsports:SLIP_n0007';`)) === 'OPEN:MONEYLINE:CFB', r.body);
    chk('…and the refresh request is closed from what SharpSports\' API reports on the account (not from the webhook)',
      one(db.sql(`select status || ':' || provider_response_id from public.portfolio_refresh_requests;`)) === 'SUCCEEDED:RRES_r0001');
    Object.assign(SS.slips.BACT_dk0001.find((s) => s.id === 'SLIP_n0007'), { status: 'completed', outcome: 'loss', netProfit: -2500, timeClosed: '2026-10-18T20:00:00Z' });
    SS.accounts.BACT_dk0001.latestRefreshResponse = { id: 'RRES_g0002', status: 200, timeCreated: new Date().toISOString(), type: 'grade' };
    db.sql(`update public.platform_accounts set next_sync_at = now() - interval '1 minute' where id = ${L(dk.id)};`);
    await call({ action: 'sweep' });
    const n7 = JSON.parse(one(db.sql(`select row_to_json(p) from (select status, profit_loss::text, settled_at from public.portfolio_positions where external_position_id = 'sharpsports:SLIP_n0007') p;`)));
    const s7 = one(db.sql(`select string_agg(coalesce(p.previous_status, '-') || '>' || p.status, ',' order by p.id) from public.portfolio_position_settlements p join public.portfolio_positions x on x.id = p.position_id where x.external_position_id = 'sharpsports:SLIP_n0007';`));
    chk('a settled wager updates in place: OPEN → LOST, its settlement appended to the history', n7.status === 'LOST' && n7.profit_loss === '-25' && s7 === 'OPEN>LOST', { n7, s7 });
    /* PHASE 5 · the synced bets in the Portfolio's own analytics */
    const path5 = JSON.parse(one(db.as(ADMIN, `select public.portfolio_pnl_path(null, null, 'UTC', null);`)));
    chk('the bankroll path over the synced history: cumulative by settlement day, and the drawdown the loss opened',
      path5.days.map((d) => d.date + ':' + d.cumulative).join(',') === '2026-09-14:100,2026-09-16:110,2026-09-20:115,2026-09-21:115,2026-10-18:90'
        && +path5.max_drawdown === 25 && path5.max_drawdown_on === '2026-10-18' && +path5.current_drawdown === 25 && +path5.peak === 115, path5);
    const sum5 = JSON.parse(one(db.as(ADMIN, `select public.portfolio_summary(null, null, 'UTC', null);`)));
    chk('the Overview\'s summary counts the synced bets: 5 settled, +$90, the platform breakdown names DraftKings, no units claimed without a unit size',
      +sum5.settled.n === 5 && +sum5.settled.pnl === 90 && sum5.platforms.some((x) => x.platform === 'draftkings') && sum5.settled.units_pnl === null && +sum5.settled.units_n === 0, sum5.settled);
    chk('reader B\'s bankroll path is empty (the function runs as the caller)', JSON.parse(one(db.as(B, `select public.portfolio_pnl_path(null, null, 'UTC', null);`))).days.length === 0);

    /* ── paging ── */
    SS.pageSize = 2;
    db.sql(`update public.platform_accounts set next_sync_at = now() - interval '1 minute', sync_cursor = null where id = ${L(dk.id)};`);
    const pagedBefore = SS.keyUse.length;
    await call({ action: 'sweep' });
    const pageReads = SS.keyUse.slice(pagedBefore).filter((k) => k === 'GET /bettorAccounts/{id}/betSlips private').length;
    chk('a paged list is followed to its end (same-origin next links only), and still duplicates nothing', pageReads === 4
      && count(`select count(*) from public.portfolio_positions where user_id = ${L(ADMIN)};`) === 6, pageReads);
    SS.pageSize = 0;

    /* ── failed verification, then reauthentication ── */
    SS.accounts.BACT_dk0001.verified = false;
    db.sql(`update public.platform_accounts set last_sync_at = now() - interval '5 minutes' where id = ${L(dk.id)};`);
    r = await deliver({ type: 'bettorAccount.unverified', data: { id: 'BACT_dk0001' } }, { secret: false });
    let a1 = accountRow(`id = ${L(dk.id)}`)[0];
    chk('verification fails (an UNSIGNED hint in observe mode is enough to re-read; the state comes from the API): ACTION REQUIRED, said plainly, history kept',
      r.status === 200 && a1.status === 'ACTION_REQUIRED' && /Reconnect it to resume syncing/.test(a1.last_error) && a1.next_sync_at === null
        && count(`select count(*) from public.portfolio_positions where platform_account_id = ${L(dk.id)};`) === 6, a1);
    chk('…the unsigned delivery was recorded as FETCH_BACK, its payload not kept', one(db.sql(`select authenticated_by || ':' || (payload is null) from portfolio_private.aggregator_webhook_events order by id desc limit 1;`)) === 'FETCH_BACK:true');
    r = await call({ action: 'ss_link' }, 'tok-admin');
    SS.accounts.BACT_dk0001.verified = true;
    r = await call({ action: 'ss_discover' }, 'tok-admin');
    await call({ action: 'sweep' });
    a1 = accountRow(`id = ${L(dk.id)}`)[0];
    chk('reauthenticated by a fresh link: the same account, CONNECTED again', r.status === 200 && r.body.accounts.length === 1 && r.body.accounts[0].account_id === dk.id && a1.status === 'CONNECTED', { body: r.body, a1 });

    /* ── an inaccessible account ── */
    SS.accounts.BACT_dk0001.access = false;
    db.sql(`update public.platform_accounts set next_sync_at = now() - interval '1 minute' where id = ${L(dk.id)};`);
    await call({ action: 'sweep' });
    a1 = accountRow(`id = ${L(dk.id)}`)[0];
    chk('access lost: ACTION REQUIRED with its own sentence, history kept', a1.status === 'ACTION_REQUIRED' && /no longer has access/.test(a1.last_error)
      && a1.metadata.provider_state.access === false, a1);
    SS.accounts.BACT_dk0001.access = true;

    /* ── a second book, linked from SharpSports' page: no webhook needed, the return does it ── */
    ssAccount('BACT_fd0002', bettor.internal_id, 'FanDuel', { verified: true });
    SS.slips.BACT_fd0002 = [slip('SLIP_f0001', { timePlaced: '2026-10-13T12:00:00Z' })];
    r = await call({ action: 'ss_discover' }, 'tok-admin');
    const fd = accountRow(`user_id = ${L(ADMIN)} and platform = 'fanduel'`)[0];
    chk('returning from SharpSports: discovery adds the new book and runs its first sync in the same request', r.status === 200 && fd && fd.status === 'CONNECTED'
      && r.body.synced.length === 1 && r.body.synced[0].status === 'SUCCEEDED' && count(`select count(*) from public.portfolio_positions where platform_account_id = ${L(fd.id)};`) === 1, r.body);

    /* ── another reader ── */
    chk('reader B sees none of A\'s bets, refreshes, settlements or accounts', db.as(B, `select (select count(*) from public.portfolio_positions) + (select count(*) from public.portfolio_refresh_requests)
        + (select count(*) from public.portfolio_position_settlements) + (select count(*) from public.platform_accounts);`) === '0');
    r = await call({ action: 'ss_refresh', account_id: dk.id }, 'tok-b');
    const rb2 = await call({ action: 'sync', account_id: dk.id }, 'tok-b');
    const rb3 = await call({ action: 'disconnect', account_id: dk.id }, 'tok-b');
    chk('reader B cannot refresh, sync or disconnect A\'s linked account', r.status === 404 && rb2.status === 404 && rb3.status === 404);
    chk('reader B cannot call an aggregator service function, nor read the bettor table',
      /permission denied/.test(db.mustFail(() => db.as(B, `select public.portfolio_svc_ag_bettor('sharpsports', 'sandbox', ${L(B)});`)) || '')
      && /permission denied/.test(db.mustFail(() => db.as(B, `select * from portfolio_private.aggregator_bettors;`)) || ''));

    /* ── signatures required ── */
    hookEnv.SHARPSPORTS_WEBHOOK_VERIFY = 'required';
    hookEnv.SHARPSPORTS_WEBHOOK_SIGNATURE_HEADER = 'x-test-signature';
    const events0 = count(`select count(*) from portfolio_private.aggregator_webhook_events;`);
    const forged = { type: 'bettorAccount.verified', data: { id: 'BACT_dk0001' } };
    const u1 = await deliver(forged, { secret: false });
    const u2 = await deliver(forged, { secret: 'not-the-secret-at-all' });
    const u3 = await deliver(forged, { sub: '00000000-0000-0000-0000-000000000000' });
    const u4 = await deliver(forged, { header: 'x-other-header' });
    const ok1 = await deliver({ type: 'bettorAccount.verified', data: { id: 'BACT_fd0002' } }, { enc: 'base64', prefix: 'sha256=' });
    chk('signatures required: unsigned, wrongly signed, an unknown subscription and a signature outside the pinned header are all refused with 401, and nothing is recorded but a count',
      u1.status === 401 && u2.status === 401 && u3.status === 401 && u4.status === 401 && count(`select count(*) from portfolio_private.aggregator_webhook_events;`) === events0 + 1
        && one(db.sql(`select string_agg(reason, ',' order by id) from portfolio_private.aggregator_webhook_rejections;`)) === 'BAD_SIGNATURE,BAD_SIGNATURE,UNKNOWN_SUBSCRIPTION,BAD_SIGNATURE', [u1.status, u2.status, u3.status, u4.status]);
    chk('…a genuinely signed delivery (base64, "sha256=" prefix) is accepted', ok1.status === 200 && ok1.body.ok === true);
    const bad1 = await deliver('{not json', {});
    chk('a body that is not JSON is refused with 400', bad1.status === 400);
    hookEnv.SHARPSPORTS_WEBHOOK_VERIFY = 'observe'; delete hookEnv.SHARPSPORTS_WEBHOOK_SIGNATURE_HEADER;
    const before2 = one(db.sql(`select count(*) || ':' || max(updated_at) from public.portfolio_positions;`));
    const forgedData = await deliver({ type: 'refreshResponse.created', data: { bettorAccount: { id: 'BACT_unknown99' }, betSlips: [{ id: 'SLIP_fake1', atRisk: 999999, status: 'completed', outcome: 'win' }] } }, { secret: false });
    chk('observe mode: a forged delivery naming nothing EdgeDesk holds is IGNORED, and nothing in it is ever stored as a bet',
      forgedData.status === 200 && forgedData.body.status === 'IGNORED' && one(db.sql(`select count(*) || ':' || max(updated_at) from public.portfolio_positions;`)) === before2
        && count(`select count(*) from public.portfolio_positions where external_position_id = 'sharpsports:SLIP_fake1';`) === 0);

    /* ── production stays off ── */
    connectEnv.SHARPSPORTS_ENV = 'production';
    const connect0 = connect;
    connect = load('portfolio_connect', connectEnv);
    r = await call({ action: 'ss_status' }, 'tok-admin');
    chk('production with no live keys: not configured (the sandbox keys are never read as live ones)', r.body.available === false && r.body.reason === 'not_configured');
    connectEnv.SHARPSPORTS_LIVE_API_KEY = 'live-private'; connectEnv.SHARPSPORTS_LIVE_PUBLIC_KEY = 'live-public';
    connect = load('portfolio_connect', connectEnv);
    r = await call({ action: 'ss_link' }, 'tok-admin');
    chk('production while the registry has SharpSports off: refused, even for an operator', r.status === 403 && r.body.reason === 'DISABLED');
    chk('…and the database refuses it too', /not enabled/.test(db.mustFail(() => db.service(`select * from public.portfolio_svc_ag_bettor('sharpsports', 'production', ${L(ADMIN)});`)) || ''));
    const demo = one(db.service(`select public.portfolio_svc_ag_smoke_begin('sharpsports', 'sandbox', 'test');`));
    r = await call({ action: 'ss_link', smoke_test: demo }, 'tok-admin');
    chk('a SANDBOX rehearsal (recorded DEMO) never opens production linking, even for an operator', r.status === 403
      && one(db.sql(`select environment from portfolio_private.connector_smoke_tests where id = ${L(demo)};`)) === 'DEMO'
      && /not enabled/.test(db.mustFail(() => db.service(`select * from public.portfolio_svc_ag_bettor('sharpsports', 'production', ${L(ADMIN)}, ${L(demo)});`)) || ''));
    db.service(`update portfolio_private.connector_smoke_tests set stages = ${L(JSON.stringify(Object.fromEntries(K.SMOKE_STAGES.map((x) => [x, { ok: true }]))))}::jsonb where id = ${L(demo)};`);
    chk('…and finishing it, all ten stages passed, is not PASSED: it cannot be the evidence that switches production on',
      one(db.service(`select public.portfolio_svc_smoke_finish(${L(demo)});`)) === 'FAILED'
      && /cannot be enabled/.test(db.mustFail(() => db.service(`update public.portfolio_platform_registry set automatic_enabled = true, tos_review = 'CLEARED', enabled_by_smoke_test = ${L(demo)} where platform_key = 'sharpsports';`)) || ''));
    const live = one(db.service(`select public.portfolio_svc_ag_smoke_begin('sharpsports', 'production', 'test');`));
    r = await call({ action: 'ss_link', smoke_test: live }, 'tok-admin');
    chk('a PRODUCTION smoke test lets its operator link in production while SharpSports is off for readers — with the LIVE public key',
      r.status === 200 && /\/link\//.test(r.body.url) && SS.keyUse[SS.keyUse.length - 1] === 'POST /context public LIVE'
      && one(db.sql(`select environment from portfolio_private.connector_smoke_tests where id = ${L(live)};`)) === 'PRODUCTION', r.body);
    chk('…its production bettor is a separate reference from the sandbox one', +db.sql(`select count(*) from portfolio_private.aggregator_bettors where user_id = ${L(ADMIN)};`) === 2);
    r = await call({ action: 'ss_link', smoke_test: live }, 'tok-b');
    chk('…but not a reader holding its id', r.status === 403);
    chk('…and the switch cannot be thrown without a passing live smoke test', /cannot be enabled/.test(db.mustFail(() => db.service(
      `update public.portfolio_platform_registry set automatic_enabled = true, tos_review = 'CLEARED', enabled_by_smoke_test = gen_random_uuid() where platform_key = 'sharpsports';`)) || ''));
    await new Promise((ok) => setTimeout(ok, 3000));   /* let any sandbox sweep an earlier poke started finish */
    db.sql(`update public.platform_accounts set next_sync_at = now() - interval '1 minute' where id = ${L(dk.id)};`);
    const prodDue = await call({ action: 'sweep' });
    chk('a production server syncs no sandbox account, even one that is due', prodDue.status === 200 && prodDue.body.due === 0
      && one(db.sql(`select (next_sync_at <= now())::text from public.platform_accounts where id = ${L(dk.id)};`)) === 'true', prodDue.body);
    connect = connect0;

    /* ── disconnect ── */
    r = await call({ action: 'disconnect', account_id: fd.id }, 'tok-admin');
    chk('disconnect: DISCONNECTED, history kept, and the reader is told what SharpSports still holds', r.status === 200 && accountRow(`id = ${L(fd.id)}`)[0].status === 'DISCONNECTED'
      && count(`select count(*) from public.portfolio_positions where platform_account_id = ${L(fd.id)};`) === 1 && /SharpSports keeps its own link/.test(r.body.revoke));
    r = await call({ action: 'disconnect', account_id: fd.id, delete_history: true }, 'tok-admin');
    chk('disconnect and delete history: the synced bets go with the account', r.status === 200 && count(`select count(*) from public.portfolio_positions where external_position_id = 'sharpsports:SLIP_f0001';`) === 0);

    /* ── nothing secret anywhere ── */
    const everything = logs.join('\n');
    chk('no key, secret or signature appears in any log line', [SS_PRIV, SS_PUB, HOOK_SECRET, 'live-private', 'live-public'].every((s) => everything.indexOf(s) < 0)
      && logs.every((l) => { try { const j = JSON.parse(l); return j.fn === 'portfolio_connect' || j.fn === 'sharpsports-webhook'; } catch (_) { return false; } }), logs.slice(-3));
    chk('the operator panel counts deliveries by how they were authenticated, with no reader or payload', (function () {
      const h = JSON.parse(one(db.as(ADMIN, `select public.portfolio_admin_aggregator_health(24);`)));
      return h.deliveries.some((d) => d.authenticated_by === 'SIGNATURE' && d.signature_header === 'x-test-signature') && h.rejections.BAD_SIGNATURE === 3
        && !JSON.stringify(h).includes(ADMIN) && !JSON.stringify(h).includes('BACT_');
    }()));
    chk('the operator panel is closed to a reader', /operators only/.test(db.mustFail(() => db.as(B, `select public.portfolio_admin_aggregator_health(24);`)) || ''));
  } catch (e) {
    chk('unexpected failure', false, String(e && (e.sqlMessage || e.stack) || e).slice(0, 2000));
  } finally {
    db.stop();
  }
  process.exit(T.done());
}());
