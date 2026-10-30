#!/usr/bin/env node
/* ===========================================================================
   The DraftKings vs Novig section (lib/edgedesk_market_compare_ui.js) and the
   comparison graphics (lib/edgedesk_compare_cards.js), as app.html ships them.

     app.html    the four modules load in order; the hook sits beside the
                 Kalshi hook in the four pregame football cards, guarded, and
                 the Kalshi hooks are untouched
     access      a reader the database says "none" gets '' (the card is
                 unchanged); Novig not deployed gives '' to readers; a
                 subscriber with public display on in the database still gets
                 '' while the code's NOVIG_PUBLIC_DISPLAY_ENABLED is false
     operator    an internal-preview banner; the real BUF/BAL book: the $100
                 stake pressed, DraftKings | Novig | Better, the cost of the
                 worse price in dollars, hold and the exchange spread named
                 apart, liquidity (BAL's top price is not achievable at $25),
                 no EV — the football model is research-tier and the reason is
                 shown; sources named
     states      stale DraftKings (historical, no savings claimed), one source
                 only (awaiting), suspended, no liquidity
     stakes      a custom stake is walked against the stored depth; a stake
                 larger than the book is "not fillable", never filled
     graphics    every template lays out from real payloads with sources,
                 times, the disclaimer and the internal watermark; an EV card
                 without a validated model, a hold without both sides captured
                 together, a movement card without history, today's gaps with
                 nothing comparable and a one-example "why shopping" are each
                 refused; a banned word is refused; draw() paints every op

   Run: node tools/novig/novig_ui.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..', '..');
const FX = require(path.join(__dirname, 'fixtures', 'catalog_nfl_2026-10-30.json'));
const EVN = require(path.join(ROOT, 'lib', 'edgedesk_venue_compare.js'));

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; failures.push({ name, detail }); } }

/* ---------------------------------------------------------------- app.html */
const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
const tags = ['edgedesk_venue_compare.js', 'edgedesk_lead_lag.js', 'edgedesk_compare_cards.js', 'edgedesk_market_compare_ui.js'].map((f) => APP.indexOf('<script src="/lib/' + f + '?v='));
chk('app.html: the four modules load, the engine before the section', tags.every((i) => i > 0) && tags[0] < tags[3] && tags[1] < tags[3] && tags[2] < tags[3]);
const hooks = APP.match(/\(window\.fbNovigHTML\?window\.fbNovigHTML\('(nfl|cfb)',g,u\.t,(M\.ev|ev)(,\{pred:p\})?\):''\)/g) || [];
chk('app.html: the guarded hook sits in the four pregame football cards (NFL and CFB, with and without a prediction)', hooks.length === 4 && hooks.filter((h) => /'nfl'/.test(h)).length === 2 && hooks.filter((h) => /\{pred:p\}/.test(h)).length === 2, hooks);
chk('app.html: every Novig hook follows a Kalshi hook, and the Kalshi hooks are untouched (5)', (APP.match(/window\.fbKalshiHTML\?window\.fbKalshiHTML\(/g) || []).length === 5
  && hooks.every((h) => APP.indexOf("(window.fbKalshiHTML?window.fbKalshiHTML('" + (/'nfl'/.test(h) ? 'nfl' : 'cfb')) >= 0));
chk('app.html: no Novig price, key or flag is set in the page itself', !/NOVIG_(READ|MANAGEMENT|STREAM)_|novig_config/.test(APP));

/* ---------------------------------------------------------------- the operator console */
const ADMIN = fs.readFileSync(path.join(ROOT, 'admin', 'novig', 'index.html'), 'utf8');
const jwt = (ADMIN.match(/SB_KEY = "([^"]+)"/) || [])[1] || '';
chk('console: noindex; the only key is the public anon key; it never calls Novig or The Odds API', /noindex,nofollow/.test(ADMIN) && JSON.parse(Buffer.from(jwt.split('.')[1] || '', 'base64').toString() || '{}').role === 'anon'
  && !/novig\.com|the-odds-api|service_role/.test(ADMIN.replace(/<!--[\s\S]*?-->/g, '')));
chk('console: readiness, the research summary, the queue and the logged switch — and turning display on is not a button', /novig_readiness/.test(ADMIN) && /novig_price_gap_summary/.test(ADMIN) && /novig_unmapped/.test(ADMIN)
  && /novig_config_log/.test(ADMIN) && !/method: 'PATCH'|novig_config\?[^']*', \{ method/.test(ADMIN) && /Wilson/.test(ADMIN));

/* ---------------------------------------------------------------- the world: the real BUF/BAL moneyline book */
const MID = FX.markets.find((m) => m.marketType === 'MONEY' && /BUF/.test(m.description)).marketId;
const MK = FX.markets.find((m) => m.marketId === MID), BOOK = FX.books[MID], IDS = MK.outcomes.map((o) => o.outcomeId);
const NOW = Date.now(), ago = (min) => new Date(NOW - min * 60000).toISOString();
function compareRow(side, outcomeId, dkDec, dkAgo, over) {
  const q = EVN.executableQuote(BOOK, outcomeId, IDS, { fee: MK.fee, eventStatus: 'OPEN_PREGAME' });
  const exec = {}; for (const s of q.stakes) exec[String(s.stake_dollars)] = [s.status, s.contracts || 0, s.total || null, s.payout || null, s.unspent || null, s.vwap || null];
  const other = IDS.find((x) => x !== outcomeId);
  const bids = EVN.levelsOf(BOOK.orders[outcomeId]), ob = EVN.levelsOf(BOOK.orders[other]);
  return Object.assign({ odds_event_id: 'odds-bufbal', sport: 'nfl', league: 'NFL', home_team: 'Buffalo Bills', away_team: 'Baltimore Ravens', kickoff_at: new Date(NOW + 9 * 3600e3).toISOString(),
    book_market: 'h2h', period: 'game', line: null, side, point: null, match_confidence: 'medium', settlement_notes: ['FMV'],
    novig: { market_id: MID, outcome_id: outcomeId, market_type: 'MONEY', environment: 'production', snapshot_id: 77, observed_at: ago(2), snapshot_at: ago(2), source: 'rest_book', book_seq: BOOK.seq,
      top: { bid: bids[0] ? EVN.milliStr(bids[0].m) : null, bid_qty: bids[0] ? bids[0].qty : null, ask: EVN.milliStr(1000 - ob[0].m), ask_qty: ob[0].qty }, exec, market_status: 'OPEN', event_status: 'OPEN_PREGAME',
      fee: Object.assign({ charged_now: false }, MK.fee), voids: 'FMV', depth: EVN.compactDepth(BOOK), outcome_ids: IDS, state: 'RECENT' },
    draftkings: dkDec == null ? { price_dec: null, observed_at: null, state: 'AWAITING' } : { price_dec: dkDec, observed_at: ago(dkAgo), book_last_update: ago(dkAgo + 1), state: dkAgo <= 10 ? 'LIVE' : dkAgo <= 90 ? 'RECENT' : 'STALE' } }, over || {});
}
const BUF = MK.outcomes.find((o) => o.name === 'BUF').outcomeId, BAL = MK.outcomes.find((o) => o.name === 'BAL').outcomeId;
const ROWS = () => [compareRow('Buffalo Bills', BUF, 1.606, 6), compareRow('Baltimore Ravens', BAL, 2.45, 6)];

/* ---------------------------------------------------------------- the browser, in a box */
function boot(answer) {
  const calls = [];
  const ctx = { console, Date, Math, JSON, Promise, setTimeout: (fn) => { fn(); return 1; }, clearTimeout: () => {}, Number, String, Object, Array, isFinite, encodeURIComponent, BigInt, URL, TextEncoder,
    SB_URL: 'https://sb.test', SB_KEY: 'anon', edToken: () => 'jwt', renderFootball: () => { ctx._repaints = (ctx._repaints || 0) + 1; },
    fetch: async (u, init) => { const fn = String(u).split('/rpc/')[1]; calls.push(fn); const a = answer(fn, init && init.body ? JSON.parse(init.body) : {}); return { ok: a.status === 200, status: a.status, json: async () => a.body, text: async () => JSON.stringify(a.body) }; } };
  ctx.globalThis = ctx; ctx.window = ctx; ctx.self = ctx;
  vm.createContext(ctx);
  for (const f of ['edgedesk_venue_compare.js', 'edgedesk_lead_lag.js', 'edgedesk_compare_cards.js', 'edgedesk_market_compare_ui.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, 'lib', f), 'utf8'), ctx, { filename: f });
  ctx.EDFootball = { meta: () => ({ model_version: 'edgedesk_football_v1.0.0', built_at: '2026-08-21T19:18:15+00:00' }) };
  return { ctx, calls };
}
const EV_ARG = { rows: [{ event_id: 'odds-bufbal' }] };
const G = { game_id: '2026_09_BAL_BUF' };
const PRED = { status: 'PREDICTED', model: { home_win_prob: 0.64 } };
async function render(answer, opts) {
  const b = boot(answer);
  b.ctx.fbNovigHTML('nfl', G, null, EV_ARG, opts);
  await b.ctx.EDMarketCompareUI._load(true);
  return Object.assign(b, { html: b.ctx.fbNovigHTML('nfl', G, null, EV_ARG, opts) });
}
const op = (rows, access, pd) => (fn) => fn === 'novig_access' ? { status: 200, body: { access, public_display: pd || 'off', environment: 'production' } } : fn === 'novig_compare' ? { status: 200, body: rows } : { status: 404, body: {} };
const strip = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/\s+/g, ' ');

(async () => {
  /* ---- access ---- */
  let r = await render(op(ROWS(), 'none'));
  chk('access none: the card is unchanged (empty string), and novig_compare is never asked', r.html === '' && !r.calls.includes('novig_compare'));
  r = await render(() => ({ status: 404, body: { message: 'Could not find the function public.novig_access' } }));
  chk('not deployed: readers get nothing', r.html === '');
  r = await render(op(ROWS(), 'subscriber', 'on'));
  chk('subscriber with public display on in the database: still nothing while the code flag is false (both must be on)', r.html === '' && r.ctx.EDMarketCompareUI.NOVIG_PUBLIC_DISPLAY_ENABLED === false);

  /* ---- operator, the real book ---- */
  r = await render(op(ROWS(), 'operator'), { pred: PRED });
  const t = strip(r.html);
  chk('operator: an internal-preview banner while public display is off', /Internal preview/.test(t) && /not for distribution/.test(t));
  chk('operator: DraftKings | Novig | Better at $100, with $100 pressed', /DraftKings vs Novig/.test(t) && /Better at \$100/.test(t) && /data-nvc-stake="100"[^>]*aria-pressed="true"/.test(r.html));
  chk('operator: Buffalo at DraftKings −165 (1.606) vs Novig −167 (0.625): DraftKings is the better price, and it says by how much', /Buffalo Bills/.test(t) && /-165/.test(t) && /-167/.test(t) && /DraftKings\s+\$[\d.]+ more on a win/.test(t), t.slice(0, 900));
  chk('operator: Baltimore at DraftKings +145 vs Novig +163: Novig better; at $100 the order walks the book', /\+145/.test(t) && /\+163/.test(t) && /Novig\s+\$[\d.]+ more on a win/.test(t) && /walks the book/.test(t));
  chk('cost of the worse price: payouts in dollars, contracts, VWAP', /Cost of the worse price/.test(t) && /DraftKings pays \$160\.60 on a win/.test(t) && /VWAP/.test(t) && /contracts at/.test(t));
  chk('EV: none stated — the football model is research-tier, and the reason is shown', /No EV is stated/.test(t) && /RESEARCH/.test(t) && !/Positive EV/.test(t));
  chk('hold: DraftKings\' margin with the no-vig estimate; Novig\'s cost to cross named as an exchange spread, not a hold', /DraftKings holds [\d.]+%/.test(t) && /estimate/.test(t) && /exchange spread, not a hold/.test(t));
  chk('liquidity: the top level and its size; BAL\'s top price is not achievable at $100 (3,282 contracts at 0.380)', /top 0\.380 for 3,282 contracts/.test(t) && /top price not achievable at this size/.test(t) && /none now \(pregame/.test(t));
  chk('sources and research language; movement on request; the graphic button', /The Odds API/.test(t) && /exchange order book/.test(t) && /not live/.test(t) && /Show movement at both venues/.test(r.html) && /Generate comparison graphic/.test(t));
  chk('no misleading words', !/guarantee|risk-free|lock|free money/i.test(t));

  /* ---- states ---- */
  r = await render(op([compareRow('Buffalo Bills', BUF, 1.606, 200), compareRow('Baltimore Ravens', BAL, 2.45, 200)], 'operator'));
  let s = strip(r.html);
  chk('stale DraftKings: shown as Stale (historical), no comparison, no savings claimed', /Stale/.test(s) && !/more on a win/.test(s) && /nothing is claimed/.test(s) && /historical/.test(r.html));
  r = await render(op([compareRow('Buffalo Bills', BUF, null, 0), compareRow('Baltimore Ravens', BAL, null, 0)], 'operator'));
  s = strip(r.html);
  chk('one source only: DraftKings awaiting data; Novig still shown; nothing compared', /Awaiting data/.test(s) && /-167/.test(s) && !/more on a win/.test(s));
  const susp = ROWS().map((x) => Object.assign(x, { novig: Object.assign(x.novig, { state: 'SUSPENDED', market_status: 'CLOSED' }) }));
  r = await render(op(susp, 'operator'));
  chk('suspended: labelled, not compared', /Suspended/.test(strip(r.html)) && !/more on a win/.test(strip(r.html)));
  const noliq = ROWS(); noliq[0].novig.state = 'NO_LIQUIDITY';
  r = await render(op(noliq, 'operator'));
  chk('no liquidity on one side: that side labelled and not compared; the other still is', /No liquidity/.test(strip(r.html)) && /Novig\s+\$[\d.]+ more on a win/.test(strip(r.html)));

  /* ---- stakes ---- */
  r = await render(op(ROWS(), 'operator'));
  r.ctx.EDMarketCompareUI._state.stake['odds-bufbal'] = 37;
  s = strip(r.ctx.fbNovigHTML('nfl', G, null, EV_ARG));
  chk('custom $37: walked against the stored depth (not one of the standard stakes)', /Better at \$37/.test(s) && /at \$37/.test(s));
  r.ctx.EDMarketCompareUI._state.stake['odds-bufbal'] = 50000;
  s = strip(r.ctx.fbNovigHTML('nfl', G, null, EV_ARG));
  chk('$50,000 on Baltimore exceeds the book ($22,752.72): not fillable, never filled', /cannot fill \$50000/.test(s) && /not fillable/.test(s));

  /* ---- graphics ---- */
  r = await render(op(ROWS(), 'operator'));
  const C = r.ctx.EDCompareCards, P = (k) => r.ctx.EDMarketCompareUI._payload(k, 'odds-bufbal');
  const texts = (lay) => lay.ops.filter((o) => o.t === 'text').map((o) => o.s).join(' | ');
  let lay = C.layout('price_gap', P('price_gap'));
  chk('graphic price gap: drawn from the real comparison, both prices, the verdict, sources with times, disclaimer, internal watermark', lay.ok && /THE PRICE GAP/.test(texts(lay)) && /\+145|\+163|-165|-167/.test(texts(lay))
    && /better price/.test(texts(lay)) && /observed/.test(texts(lay)) && /not, by itself, a positive-EV bet/.test(texts(lay)) && /INTERNAL PREVIEW/.test(texts(lay)) && /\.png$/.test(lay.file), lay.reason || texts(lay).slice(0, 400));
  lay = C.layout('worse_price_cost', P('worse_price_cost'));
  chk('graphic worse-price cost: five stakes, payouts at each venue', lay.ok && /\$25/.test(texts(lay)) && /\$500/.test(texts(lay)) && /DRAFTKINGS PAYS/.test(texts(lay)), lay.reason);
  lay = C.layout('book_hold', P('book_hold'));
  chk('graphic book hold: the margin and the no-vig estimate, explained', lay.ok && /BOOK HOLD/.test(texts(lay)) && /not what any one bettor is certain to lose/.test(texts(lay)) && /estimate/.test(texts(lay)), lay.reason);
  lay = C.layout('edge_upgrade', P('edge_upgrade'));
  chk('graphic edge upgrade: refused without a validated model, with the reason', !lay.ok && /no validated model probability/.test(lay.reason), lay);
  chk('graphic market movement: refused until the history is loaded', P('market_movement').reason_missing && /movement/.test(P('market_movement').reason_missing));
  lay = C.layout('why_shopping', P('why_shopping'));
  chk('graphic why shopping: real observed examples, including one where DraftKings is better', lay.ok && /DraftKings better/.test(texts(lay)) && /Novig better/.test(texts(lay)) && /not hypothetical/.test(texts(lay)), lay.reason || texts(lay));
  chk('graphic today\'s gaps: refused when nothing is comparable', !C.layout('todays_gaps', { as_of: new Date().toISOString(), rows: [{ comparable: false }] }).ok);
  chk('graphic why shopping: refused with fewer than two real examples', !C.layout('why_shopping', { as_of: 'x', examples: [{ comparable: true, observed: true }] }).ok);
  chk('graphic: a stale comparison is refused, not drawn', !C.layout('price_gap', Object.assign(P('price_gap'), { comparable: false, why: 'DraftKings is stale' })).ok);
  chk('graphic: a banned word in the copy is refused', /copy rule/.test(C.layout('price_gap', Object.assign(P('price_gap'), { selection: 'Lock of the week' })).reason || ''));
  const mv = C.layout('market_movement', { game: 'BAL @ BUF', selection: 'Buffalo Bills', dk_observed_at: ago(6), novig_observed_at: ago(2), series: { novig: [{ t: 1, p: 0.6 }, { t: 2, p: 0.62 }], draftkings: [{ t: 1, p: 0.61 }, { t: 3, p: 0.62 }] }, lead_lag: 'x' });
  chk('graphic market movement: with real series, both venues plotted at their own times; sequence, not cause', mv.ok && mv.ops.filter((o) => o.t === 'poly').length === 2 && /not proof of cause/.test(texts(mv)));
  const ALL = [C.layout('price_gap', P('price_gap')), C.layout('worse_price_cost', P('worse_price_cost')), C.layout('book_hold', P('book_hold')), C.layout('why_shopping', P('why_shopping')), mv];
  chk('graphic layout: every template\'s content ends above the watermark band and the sources (y < ' + C.CONTENT_MAX + '); titles never wrap', ALL.every((l) => l.ok && l.ops.filter((o) => o.t === 'text' && o.y > 300 && o.y < 1000 && !/INTERNAL|permission/.test(o.s)).every((o) => o.y < C.CONTENT_MAX)
    && l.ops.filter((o) => o.t === 'text' && o.y === 250).every((o) => !o.maxWidth)), ALL.map((l) => l.ok && l.ops.filter((o) => o.t === 'text' && o.y >= C.CONTENT_MAX && o.y < 1000).map((o) => o.s + '@' + o.y)));
  const painted = []; const fake = new Proxy({}, { get: (_, k) => (k === 'measureText' ? (s) => ({ width: String(s).length * 10 }) : typeof k === 'string' && /^(fill|stroke|beginPath|moveTo|lineTo|roundRect|fillRect|fillText)/.test(k) ? (...a) => painted.push(k) : undefined), set: () => true });
  C.draw(mv.ops, fake);
  chk('draw: every op kind paints (rect, text with wrapping, line, polyline)', ['fillRect', 'fillText', 'stroke', 'lineTo'].every((k) => painted.includes(k)));

  console.log((fail ? 'FAILED' : 'ALL GREEN') + ' novig ui: ' + pass + ' passed, ' + fail + ' failed');
  for (const f of failures) console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 900) : ''));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAILED novig ui: ' + (e && e.stack || e)); process.exit(1); });
