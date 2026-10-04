#!/usr/bin/env node
/* ===========================================================================
   lib/edgedesk_portfolio_ui.js rendered in Node, and its wiring in app.html.

     - the overview answers "am I up or down?" before anything else, with the
       split, the platforms and the open exposure — and an empty book shows no
       sample figure at all;
     - open positions read like the spec: "$100 @ −110 · Risk · Potential
       profit" and "contracts · average entry · cost basis · current value";
     - nothing the reader typed can become markup;
     - no account is ever called "Connected" unless the server connected it;
     - the copy carries no tout or loss-chasing language;
     - the CSV export cannot smuggle a spreadsheet formula;
     - app.html loads the six files in order, owns a #v-portfolio view, routes
       to it, lists it in More, and leaves the seven-seat bar alone.

   Run: node tools/portfolio/portfolio_ui.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
global.window = global;
const ROOT = path.join(__dirname, '..', '..');
const E = require(path.join(ROOT, 'lib', 'edgedesk_portfolio.js'));
const U = require(path.join(ROOT, 'lib', 'edgedesk_portfolio_ui.js'));

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; failures.push({ name, detail }); } }
const strip = (h) => String(h).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ');

function pos(over, fills) {
  const p = Object.assign({ id: 'p' + Math.random().toString(16).slice(2), platform_type: 'SPORTSBOOK', platform: 'draftkings', platform_label: 'DraftKings', sport: 'NFL',
    position_type: 'SPREAD', event_name: 'Chiefs @ Bills', market_name: 'Spread', selection: 'Chiefs -2.5', stake: '100', odds_american: -110, status: 'WON',
    placed_at: '2026-09-07T17:00:00Z', settled_at: '2026-09-07T21:00:00Z', source: 'MANUAL' }, over);
  Object.assign(p, E.derive(p, fills));
  if (p.status === 'OPEN') p.settled_at = null;
  return p;
}
const BOOK = [
  pos({}),
  pos({ platform: 'fanduel', platform_label: 'FanDuel', status: 'LOST', stake: '200', odds_american: 120, selection: 'Jets ML', event_name: 'Jets @ Giants', position_type: 'MONEYLINE', settled_at: '2026-09-08T21:00:00Z' }),
  pos({ platform: 'draftkings', status: 'OPEN', selection: 'Chiefs -2.5 (open)', placed_at: '2026-10-03T17:00:00Z' }),
  pos({ platform_type: 'PREDICTION_MARKET', platform: 'kalshi', platform_label: 'Kalshi', sport: null, position_type: 'EVENT_CONTRACT', event_name: 'Will X happen?', market_name: 'Will X happen?',
    selection: 'YES', side: 'YES', status: 'OPEN', current_price: '0.68', current_price_at: '2026-10-03T12:00:00Z', placed_at: '2026-10-01T12:00:00Z' }, [{ transaction_type: 'BUY', quantity: '100', price: '0.61', fee: '0' }]),
  pos({ platform_type: 'PREDICTION_MARKET', platform: 'polymarket', platform_label: 'Polymarket', sport: null, position_type: 'EVENT_CONTRACT', event_name: 'Who wins?', market_name: 'Who wins?',
    selection: 'Chiefs', side: 'Chiefs', resolution: 'Chiefs', settled_at: '2026-09-20T12:00:00Z', placed_at: '2026-09-01T12:00:00Z' }, [{ transaction_type: 'BUY', quantity: '100', price: '0.40', fee: '0.25' }])
];
const S = Object.assign(U.defaults(), { positions: BOOK, accounts: [], tz: 'UTC', now: Date.parse('2026-10-04T12:00:00Z') });

/* ═══ OVERVIEW ══════════════════════════════════════════════════════════ */
let h = U.render.overview(S), t = strip(h);
const first = (re) => t.search(re);
chk('the overview leads with TOTAL P&L', first(/Total P&L/i) >= 0 && first(/Total P&L/i) < first(/ROI/), t.slice(0, 200));
chk('the total is settled P&L: 90.91 − 200 + 59.75 = −$49.34', /−\$49\.34/.test(t), t.slice(0, 300));
chk('and says it plainly, in words', /Down \$49\.34 across 3 settled positions on 3 platforms/.test(t), t.slice(0, 300));
chk('ROI, capital deployed, open exposure and the record are on the first card', /ROI\s*−/.test(t) && /Capital deployed\s*\$501\.00/.test(t) && /Open exposure\s*\$161\.00\s*2 open/.test(t) && /Record\s*2-1-0/.test(t), t.slice(0, 600));
chk('sportsbook and prediction-market P&L are shown separately', /Sportsbook P&L\s*−\$109\.09/.test(t) && /Prediction-market P&L\s*\+\$59\.75/.test(t));
chk('P&L by platform, every platform with a settled position', /DraftKings/.test(t) && /FanDuel/.test(t) && /Polymarket/.test(t));
chk('the cumulative chart is drawn', /<svg class="pfo-chart"/.test(h) && /<polyline/.test(h));
chk('open positions are summarized with their unrealized mark, labelled as the reader\'s', /Marked to the prices you entered: \+\$7\.00/.test(t));
const empty = strip(U.render.overview(Object.assign({}, S, { positions: [] })));
chk('an empty book shows no figure at all — no sample data', /Build your portfolio/.test(empty) && !/\$\d/.test(empty), empty);
chk('and says how to build one: connect accounts first, then import or record by hand', /Connect accounts\s+Import a CSV\s+Record a sportsbook bet/.test(empty), empty);

/* ═══ OPEN ══════════════════════════════════════════════════════════════ */
t = strip(U.render.open(S));
chk('open sportsbook bet: "$100.00 @ −110", risk and potential profit', /\$100\.00 @ −110/.test(t) && /Risk \$100\.00/.test(t) && /Potential profit \$90\.91/.test(t), t.slice(0, 500));
chk('open contract: contracts, average entry, cost basis, current value, unrealized', /Contracts 100/.test(t) && /Average entry \$0\.61/.test(t) && /Cost basis \$61\.00/.test(t) && /Current value \$68\.00/.test(t) && /Unrealized P&L \+\$7\.00/.test(t), t);
chk('settled positions are not open', !/Jets ML/.test(t));
let only = strip(U.render.open(Object.assign({}, S, { openFilter: { kind: 'PREDICTION_MARKET', platform: '', sport: '', placed: '' } })));
chk('the Sportsbook / Prediction market filter', /Will X happen/.test(only) && !/Chiefs -2\.5 \(open\)/.test(only));
only = strip(U.render.open(Object.assign({}, S, { openFilter: { kind: 'ALL', platform: 'draftkings', sport: '', placed: '' } })));
chk('the platform filter', /Chiefs -2\.5 \(open\)/.test(only) && !/Will X happen/.test(only));
chk('no live figure is shown without a live feed', !/pfo-live/.test(U.render.open(S)));
const withLive = U.render.open(Object.assign({}, S, { live: (p) => (p.selection === 'Chiefs -2.5 (open)' ? { label: 'Receiving yards', current: 25, line: 58.5 } : null) }));
chk('a live provider, once one exists, attaches to the position it names', /Receiving yards/.test(strip(withLive)) && /current 25/.test(strip(withLive)));

/* ═══ HISTORY ═══════════════════════════════════════════════════════════ */
t = strip(U.render.history(S));
chk('history: settled positions with platform, event, market, selection, stake, odds, result, P&L', /DraftKings/.test(t) && /Chiefs @ Bills/.test(t) && /Spread/.test(t) && /\$100\.00/.test(t) && /−110/.test(t) && /Win/.test(t) && /\+\$90\.91/.test(t));
const q = (f) => U.filterHistory(Object.assign({}, S, { histFilter: Object.assign(U.defaults().histFilter, f) })).map((p) => p.selection);
chk('search', JSON.stringify(q({ q: 'jets' })) === JSON.stringify(['Jets ML']));
chk('filter by result', JSON.stringify(q({ result: 'LOSS' })) === JSON.stringify(['Jets ML']));
chk('filter by platform type', JSON.stringify(q({ kind: 'PREDICTION_MARKET' })) === JSON.stringify(['Chiefs']));
chk('filter by source', q({ source: 'CSV' }).length === 0 && q({ source: 'MANUAL' }).length === 3);
chk('filter by date (settled date, inclusive)', JSON.stringify(q({ from: '2026-09-08', to: '2026-09-08' })) === JSON.stringify(['Jets ML']));
chk('"All" includes the open positions', q({ state: '' }).length === 5);

/* ═══ ANALYTICS ═════════════════════════════════════════════════════════ */
t = strip(U.render.analytics(S));
chk('analytics compares sportsbook, prediction market and combined', /Sportsbook Prediction Combined/.test(t) && /P&L −\$109\.09 \+\$59\.75 −\$49\.34/.test(t), t.slice(0, 700));
chk('win rate, average stake, average odds, average contract entry, fees', /Win rate/.test(t) && /Average stake/.test(t) && /Average odds/.test(t) && /Average contract entry \$0\.505/.test(t) && /Fees paid \$0\.25/.test(t), t.slice(600, 1400));
chk('best and worst platform', /Best platform DraftKings \+\$90\.91/.test(t) && /Worst platform FanDuel −\$200\.00/.test(t), t.slice(t.indexOf('Best and worst'), t.indexOf('Best and worst') + 300));
chk('attribution is described as recorded, never inferred', /never infers it from a matching event/.test(t));
chk('7D excludes what settled earlier', /Nothing placed or settled in this period|Settled 0 0 0/.test(strip(U.render.analytics(Object.assign({}, S, { period: '7D' })))));

/* ═══ ACCOUNTS ══════════════════════════════════════════════════════════ */
const accts = [
  { id: 'a1', platform: 'draftkings', platform_label: 'DraftKings', platform_type: 'SPORTSBOOK', connection_type: 'MANUAL', status: 'MANUAL', positions: 3, open_positions: 1, last_position_at: '2026-10-03T17:00:00Z' },
  { id: 'a2', platform: 'kalshi', platform_label: 'Kalshi', platform_type: 'PREDICTION_MARKET', connection_type: 'CSV', status: 'IMPORT_ONLY', positions: 0, open_positions: 0, last_import_at: '2026-10-02T17:00:00Z' }
];
t = strip(U.render.accounts(Object.assign({}, S, { accounts: accts })));
chk('accounts say how each platform is tracked', /DraftKings/.test(t) && /Manual tracking/.test(t) && /Kalshi/.test(t) && /CSV import/.test(t));
chk('and never say "Connected" for a manual or CSV account', !/\bConnected\b/.test(t));
chk('automatic sync is described as unavailable, with no password ask', /Automatic sync is not available for DraftKings yet/.test(t) && /never by asking for a sportsbook password/.test(t));
chk('remove is offered only for an account with no positions', (U.render.accounts(Object.assign({}, S, { accounts: accts })).match(/remove-account/g) || []).length === 1);
const live = strip(U.render.accounts(Object.assign({}, S, { accounts: [{ id: 'x', platform: 'kalshi', platform_label: 'Kalshi', platform_type: 'PREDICTION_MARKET', connection_type: 'API', status: 'CONNECTED', positions: 4, open_positions: 0, last_sync_at: '2026-10-04T11:57:00Z', last_success_at: '2026-10-04T11:57:00Z' }] })));
chk('a real API account (Phase B) shows Connected with its sync times', /Connected/.test(live) && /Last successful sync/.test(live));

/* ═══ FORMS ═════════════════════════════════════════════════════════════ */
const wf = strip(U.render.wagerForm({ status: 'WON', position_type: 'PARLAY' }, {}));
chk('the sportsbook form has every field the spec names', ['Sportsbook', 'Sport', 'League', 'Event', 'Market type', 'Selection', 'Line', 'American odds', 'Stake', 'Placed', 'Status', 'Settled', 'Amount the book paid', 'Where the idea came from']
  .every((f) => wf.indexOf(f) >= 0), wf);
chk('a parlay explains how a re-priced ticket is entered', /re-priced the ticket/.test(wf));
const pf = strip(U.render.predictionForm({ state: 'RESOLVED' }, {}));
chk('the prediction form: platform, event, market, side, contracts, entry price, fees, opened, resolution', ['Platform', 'Event or question', 'Market', 'Side', 'Contracts', 'Average entry price', 'Fees', 'Opened', 'Resolved as'].every((f) => pf.indexOf(f) >= 0), pf);
let w = U.wagerFromForm({ platform: '__other', platform_other: 'Corner Book', position_type: 'MONEYLINE', event_name: 'A @ B', selection: 'A', odds: '+150', stake: '20', placed_at: '2026-09-07T13:00', status: 'OPEN' });
chk('"Other" sportsbook becomes the reader\'s own platform', w.row.platform === 'custom_corner_book' && w.row.platform_label === 'Corner Book' && w.issues.length === 0, w);
w = U.wagerFromForm({ platform: 'draftkings', position_type: 'SPREAD', event_name: 'A @ B', selection: 'A', odds: '1.91', odds_format: 'decimal', stake: '20', placed_at: '2026-09-07T13:00', status: 'OPEN' });
chk('decimal odds from the form', w.row.odds_decimal === '1.91' && w.row.odds_american === null && w.issues.length === 0);
w = U.wagerFromForm({ platform: '', event_name: '', selection: '', odds: '50', stake: '-1', placed_at: '', status: 'CASHED_OUT' });
chk('the form refuses what the database would refuse, in words', w.issues.filter((x) => x.level === 'error').length >= 5 && w.issues.every((x) => x.message));
let pr = U.predictionFromForm({ platform: 'kalshi', event_name: 'Q?', side: 'NO', contracts: '50', price: '0.30', placed_at: '2026-09-07T13:00', state: 'SOLD', exit_price: '0.45', settled_at: '2026-09-08T13:00' });
chk('"sold before it resolved" records a buy and a sell', pr.payload.fills.length === 2 && pr.payload.fills[1].action === 'SELL' && pr.payload.fills[1].quantity === '50' && pr.issues.length === 0, pr);
pr = U.predictionFromForm({ platform: 'kalshi', event_name: 'Q?', side: 'YES', contracts: '10', price: '61', placed_at: '2026-09-07T13:00', state: 'OPEN' });
chk('a price of 61 is not a contract price', pr.issues.some((x) => x.code === 'BAD_PRICE'));
pr = U.predictionFromForm({ platform: 'kalshi', event_name: 'Q?', side: 'YES', contracts: '10', price: '0.6', placed_at: '2026-09-07T13:00', state: 'OPEN', edge_source: 'EDGEDESK', edge_ref: 'stake_recommendation:rec-1' },
  [{ type: 'stake_recommendation', id: 'rec-1', model_version: 'v9', model_probability: '0.62' }]);
chk('an explicit EdgeDesk link carries the record id and its model version', pr.payload.edge_ref_type === 'stake_recommendation' && pr.payload.edge_ref_id === 'rec-1' && pr.payload.model_version === 'v9');
chk('the preview uses the same arithmetic as the database', /payout <b>\$190\.91/.test(U.wagerPreview(U.wagerFromForm({ platform: 'draftkings', event_name: 'A', selection: 'B', odds: '-110', stake: '100', placed_at: '2026-09-07T13:00', status: 'OPEN' }).row)));
chk('a datetime-local value round-trips in the browser\'s own zone', U.isoToLocalInput(U.localInputToIso('2026-09-07T13:00')) === '2026-09-07T13:00');

/* ═══ SAFETY ════════════════════════════════════════════════════════════ */
const evil = '<img src=x onerror=alert(1)>"\'';
const hostile = [pos({ event_name: evil, selection: evil, platform_label: evil, notes: evil, status: 'OPEN' })];
const all = ['overview', 'open', 'history', 'analytics'].map((k) => U.render[k](Object.assign({}, S, { positions: hostile, histFilter: Object.assign(U.defaults().histFilter, { state: '' }) }))).join('')
  + U.render.accounts(Object.assign({}, S, { accounts: [{ id: evil, platform: 'x', platform_label: evil, display_name: evil, platform_type: 'SPORTSBOOK', connection_type: 'MANUAL', status: 'MANUAL', positions: 0 }] }));
chk('nothing a reader typed becomes markup', !/<img/.test(all) && /&lt;img/.test(all));
chk('nor breaks out of an attribute', !/data-id="<img/.test(all) && !/"'/.test(all.replace(/&quot;|&#39;/g, '')));
const csv = U.exportCsv([pos({ event_name: '=HYPERLINK("http://x","y")', selection: '+1 cmd', notes: '@SUM(A1)' })]);
chk('the CSV export neutralizes spreadsheet formulas', /'=HYPERLINK/.test(csv) && /'\+1 cmd/.test(csv) && /'@SUM/.test(csv) && !/,=HYPERLINK/.test(csv));
chk('and quotes what needs quoting', /"'=HYPERLINK\(""http:\/\/x"",""y""\)"/.test(csv));
chk('friendly errors: a duplicate is named as one', U.friendly({ status: 409, pg: { code: '23505', message: 'duplicate key value violates unique constraint "portfolio_positions_fingerprint_once"' } }).dup === true);
chk('friendly errors: the database\'s own sentence, without its prefix', U.friendly({ status: 400, pg: { code: '23514', message: 'portfolio: more contracts sold than bought' } }).text === 'More contracts sold than bought.');
chk('friendly errors: a missing migration says which file', /portfolio\.sql/.test(U.friendly({ status: 404, pg: null }).text));

/* ═══ COPY: factual, never a nudge ══════════════════════════════════════ */
/* the coach's own list of banned words is the one place they may appear */
const SRC = ['edgedesk_portfolio_ui.js', 'edgedesk_portfolio.js', 'edgedesk_portfolio_import.js', 'edgedesk_portfolio_connectors.js', 'edgedesk_portfolio_process.js', 'edgedesk_portfolio_journal_ui.js']
  .map((f) => fs.readFileSync(path.join(ROOT, 'lib', f), 'utf8')).join('\n').replace(/var BANNED_WORDS = \[[\s\S]*?\];/, '');
const strings = (SRC.replace(/\/\*[\s\S]*?\*\//g, '').match(/'(?:[^'\\\n]|\\.)*'/g) || []).join('\n');
const TOUT = /\b(bet this|locks?|lock of|guaranteed?|smash|must[- ]bet|can'?t lose|best bets?|winning plays?|free money|sure thing|hammer|win it back|chase|get even|recoup|bounce back|deposit (now|more)|reload bonus|boost your|hot streak|on fire|due for|don'?t miss)\b/i;
const hit = strings.split('\n').filter((l) => TOUT.test(l));
chk('no tout, urgency or loss-chasing language anywhere in Portfolio copy', hit.length === 0, hit.slice(0, 5));
const rendered = [U.render.overview(S), U.render.open(S), U.render.history(S), U.render.analytics(S), U.render.accounts(Object.assign({}, S, { accounts: accts })), U.render.import(S),
  U.render.wagerForm({}, {}), U.render.predictionForm({}, {})].map(strip).join(' ');
chk('…nor in anything the page renders', !TOUT.test(rendered), (rendered.match(TOUT) || [])[0]);
chk('up and down are described the same way: "Up $x" / "Down $x"', /"Up"|'Up'/.test(SRC) && /'Down'/.test(SRC) && !/congrat|celebrat|🎉|🔥/i.test(SRC));
chk('nothing financial is written to browser storage', !/localStorage|sessionStorage|indexedDB/.test(SRC.replace(/\/\*[\s\S]*?\*\//g, '')));
chk('no password or credential field exists in the page', !/type="password"|name="password"|api[_-]?secret/i.test(SRC));

/* ═══ APP WIRING ════════════════════════════════════════════════════════ */
const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
const order = ['edgedesk_portfolio.js', 'edgedesk_portfolio_import.js', 'edgedesk_portfolio_connectors.js', 'edgedesk_portfolio_process.js', 'edgedesk_portfolio_journal_ui.js', 'edgedesk_portfolio_ui.js']
  .map((f) => APP.indexOf('<script src="/lib/' + f + '?v='));
chk('app.html loads the engine, importer, contract, process engine, journal views and page, in that order', order.every((i) => i > 0) && order.every((i, k) => k === 0 || i > order[k - 1]), order);
chk('and the stylesheet', /<link rel="stylesheet" href="\/lib\/edgedesk_portfolio\.css\?v=/.test(APP));
/* Since the five-destination navigation (docs/ia/NAVIGATION_AUDIT.md) Portfolio
   is a SEAT of its own, not a More row: the same page in the same host, opened by
   lib/edgedesk_workspace_ui.js pfOpen(), with the old Ledger's tracked prices as
   one section under it. */
const WS = fs.readFileSync(path.join(ROOT, 'lib', 'edgedesk_workspace_ui.js'), 'utf8');
chk('a #v-portfolio view with its own host (not the Ledger\'s id="portfolio")', /<section id="v-portfolio" class="view hide">\s*<div id="pfoHost"><\/div>/.test(APP) && (APP.match(/id="portfolio"/g) || []).length === 1 && (APP.match(/id="v-portfolio"/g) || []).length === 1);
chk('the router paints it', APP.indexOf("if(v==='portfolio'){try{if(window.pfOpen)window.pfOpen();}catch(_){}}") > 0 && WS.indexOf('PFS.ctl = W.EDPortfolioUI.show(host)') > 0);
chk('its own seat reads active while it is open', /var NAV_PRIMARY=\{[^}]*portfolio:1/.test(APP) && !/NAV_OWNER=\{[^}]*portfolio:/.test(APP));
chk('#portfolio deep-links to it, and #portfolio/<tab> to a tab', /NAV_HASH_MAP=\{[^}]*portfolio:'portfolio'/.test(APP) && APP.indexOf("if(t==='portfolio'&&m[2]){try{if(window.pfSetTab)window.pfSetTab(m[2],true);}catch(_){}}") > 0);
chk('More no longer lists it: it has a seat', APP.indexOf("dest.push(moreItem(IC.portfolio,'Portfolio'") < 0);
chk('a reader can make it their landing page', APP.indexOf("['portfolio','Portfolio']") > 0);
const nav = APP.slice(APP.indexOf('<nav class="bottomnav"'), APP.indexOf('</nav>', APP.indexOf('<nav class="bottomnav"'))).replace(/<!--[\s\S]*?-->/g, '');
chk('Portfolio is one of the five seats', (nav.match(/data-v="/g) || []).length === 5 && /data-v="portfolio"/.test(nav));
chk('the CSS prefix does not collide with the Ledger\'s .pfl- panel', !/\.pfl-/.test(fs.readFileSync(path.join(ROOT, 'lib', 'edgedesk_portfolio.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')));

failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 600) : '')));
console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'portfolio UI — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
