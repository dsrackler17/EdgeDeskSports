#!/usr/bin/env node
/* ===========================================================================
   THE FAIRLINE PAGE'S WIRING — without a browser.
   (tools/fairline/page.e2e.js drives it in Chromium against the real SQL.)

     * the page carries the site's one Main nav, loads each module once, in
       dependency order, and reads its Supabase project from the same
       committed config the games pages read — no key of its own
     * it calls the database's doors and nothing that could bypass the gate:
       fairline_board and fairline_leaks, never signals or a table
     * it says plainly that it shows prices, not picks; it names its known
       limitations, including that per-book quotes cover actionable lines only
     * what is not built is shown inactive, never hidden or faked: The Tape
       and DK Predictions say Coming Soon
     * no price is typed in the page: the offer is lib/edgedesk_pricing.js's
     * a row and a leak card say what the database decided and nothing more,
       and every string is escaped

   Run: node tools/fairline/page.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const NAV = require(path.join(ROOT, 'lib', 'edgedesk_nav.js'));
global.EDFairlineCore = require(path.join(ROOT, 'lib', 'edgedesk_fairline_core.js'));
global.EDPricing = require(path.join(ROOT, 'lib', 'edgedesk_pricing.js'));
const UI = require(path.join(ROOT, 'lib', 'edgedesk_fairline_app.js'));

let pass = 0, fail = 0;
function chk(name, ok, detail) { if (ok) pass++; else { fail++; console.log('FAIL | ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 300) : '')); } }

const PAGE = read('fairline/index.html');
const MOD = read('lib/edgedesk_fairline_app.js');
const CORE = read('lib/edgedesk_fairline_core.js');
const CSS = read('lib/edgedesk_fairline_app.css');

/* ── the page ──────────────────────────────────────────────────────────── */
const nav = /<nav class="th-nav" aria-label="Main">([\s\S]*?)<\/nav>/.exec(PAGE);
const links = nav ? [...nav[1].matchAll(/<a href="([^"]+)" data-ed-nav="([^"]+)">([^<]+)<\/a>/g)].map((m) => [m[2], m[1], m[3]]) : [];
chk('the site\'s one Main nav, five links in order', JSON.stringify(links) === JSON.stringify(NAV.PRIMARY.map((x) => [x.key, x.href, x.label])), links);
const order = ['/lib/edgedesk_auth.js', '/lib/edgedesk_pricing.js', '/lib/edgedesk_access.js', '/games/lib/attribution.js', '/games/lib/social.js',
  '/games/lib/auth.js', '/lib/edgedesk_fairline_core.js', '/lib/edgedesk_fairline_app.js'];
const at = order.map((s) => PAGE.indexOf('<script src="' + s + '?v='));
chk('every module loads, once each, in dependency order', at.every((i) => i > 0) && at.every((i, k) => k === 0 || i > at[k - 1]) &&
  order.every((s) => PAGE.split('<script src="' + s + '?v=').length === 2), at);
chk('not the Linemaker\'s module of a similar name', !/edgedesk_fairline\.js/.test(PAGE));
chk('the stylesheets: the tools frame, the game cards, Fairline\'s own', ['/tools/tools.css', '/lib/edgedesk_games.css', '/lib/edgedesk_fairline_app.css']
  .every((c) => PAGE.indexOf('<link rel="stylesheet" href="' + c + '?v=') > 0));
chk('the frame is the game page (dark, dense, the same cards and empty states)', /class="wrap gm-page fl"/.test(PAGE) && /gm-empty/.test(MOD) && /gm-lg/.test(MOD));
chk('the Supabase project comes from games/data/config.json — the page carries no key', /fetch\('\/games\/data\/config\.json'/.test(PAGE) &&
  !/eyJhbGciOi/.test(PAGE) && !/eyJhbGciOi/.test(MOD) && !/supabase\.co/.test(MOD));
const inline = [...PAGE.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
chk('the inline boot parses', inline.length === 1 && (() => { try { new Function(inline[0]); return true; } catch (_) { return false; } })());
chk('mobile first: the viewport, and no fixed width wider than a phone', /width=device-width/.test(PAGE) &&
  !/(^|[^-a-z])width:\s*(4[2-9]\d|[5-9]\d\d|\d{4,})px/.test(CSS) && !/min-width:\s*(4[2-9]\d|[5-9]\d\d)px;/.test(CSS.replace(/@media\([^)]*\)/g, '')));
chk('the page is in the sitemap', /https:\/\/edgedesksports\.com\/fairline\//.test(read('sitemap-pages.xml')));

/* ── the doors ─────────────────────────────────────────────────────────── */
const rpcs = [...MOD.matchAll(/rpc\('([a-z_]+)'/g)].map((m) => m[1]).sort();
chk('the page calls the two Fairline doors and nothing else', JSON.stringify([...new Set(rpcs)]) === JSON.stringify(['fairline_board', 'fairline_leaks']), rpcs);
chk('it never reads a table directly (signals stays the terminal\'s)', !/\/rest\/v1\/(?!rpc\/)/.test(MOD.replace(/\/rest\/v1\/rpc\//g, '')) && !/signals\?/.test(MOD));
chk('the free sign-in is the Games door, configured to come back here', /configure\(S\.url, S\.key, \{ returnPath: '\/fairline\/', surface: 'fairline' \}\)/.test(MOD));
chk('a confirmation link lands here and is consumed (lib/edgedesk_auth.js)', /S\.edauth\.consume\(\{ url: S\.url, key: S\.key \}\)/.test(MOD));
chk('the page decides no gate: paid comes from the answer, never from the plan in the browser', /S\.board && S\.board\.paid/.test(MOD) && !/has_access/.test(MOD) && !/bet_checker_paid/.test(MOD));

/* ── what it says ──────────────────────────────────────────────────────── */
chk('it says plainly: prices, not picks; it never tells you what to bet', /Prices, not picks/.test(PAGE) && /never tells you what to bet/.test(PAGE) &&
  /not a pick list/.test(UI.BOARD_LIMITS.join(' ')));
chk('Known limitations, consistent with the MLB card: coverage is what capture recorded, book quotes are actionable lines only',
  /Known limitations/.test(PAGE) && /Coverage is whatever capture recorded/.test(UI.BOARD_LIMITS.join(' ')) && /actionable lines only/.test(UI.BOARD_LIMITS.join(' ')));
chk('…and Kalshi\'s own limits (5-minute snapshots, the 6¢ spread rule, before fees)', /5-minute snapshots/.test(UI.BOARD_LIMITS.join(' ')) && /6¢/.test(UI.BOARD_LIMITS.join(' ')) &&
  /fees/.test(UI.BOARD_LIMITS.join(' ')));
chk('The Tape is visible and inactive: Coming Soon, disabled', /data-fl-tab="tape"[^>]*disabled[^>]*>The Tape <span class="fl-chip soon">Coming Soon<\/span>/.test(PAGE));
chk('DK Predictions is a column, Coming Soon, with no data source', /cell\('DK Predictions', '<span class="fl-chip soon">Coming Soon<\/span>', 'inactive'/.test(MOD) &&
  /no price feed exists yet/.test(UI.BOARD_LIMITS.join(' ')) && !/dk_predictions_price|dk_price/.test(MOD + CORE));
chk('no price is typed in the page or the module: the offer is the pricing file\'s', !/\$[1-9]/.test(PAGE) && !/\$[1-9]/.test(MOD) && /P\.betCheckerOffer\('monthly'\)/.test(MOD));
chk('labels are chips with words, never colour alone', /class="fl-chip ' \+ esc\(lv\.cls\)/.test(MOD) && /esc\(lv\.chip\)/.test(MOD) && /\.fl-chip\.leak\{/.test(CSS));
chk('each leak card leads with its verdict, big and plain, numbers underneath', /chip\(s, true\) \+\s*'<p class="fl-verdict/.test(MOD) && /\+ numsHTML\(s\) \+ '<\/article>'/.test(MOD) &&
  /\.fl-verdict\.lead\{font-size:clamp\(19px/.test(CSS));

/* ── a row and a card say what the database decided ────────────────────── */
const page = UI._make({ querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {} }, { url: 'x', key: 'y', fetch: () => null });
const row = { sig_key: 'k1', sport: 'NFL', market: 'spread', selection: 'Kansas City Chiefs', point: -3.5, home_team: 'Kansas City Chiefs', away_team: 'Buffalo Bills',
  commence_time: '2026-11-01T18:00:00Z', fair_prob: 0.52, fair_american: -108, best_dec: 2.04, best_american: 104, best_book: 'DraftKings', edge_pts: 2.98,
  quote_age_min: 3.5, fresh_limit_min: 120, fresh: true, kalshi_state: null };
let h = page.rowHTML(row);
chk('a fresh row: fair, best and book, edge, age; no stale chip', /data-fresh="true"/.test(h) && /52\.0%/.test(h) && /fair −108/.test(h) && /\+104/.test(h) && /DraftKings/.test(h) &&
  /\+2\.98 pts/.test(h) && /4 min/.test(h) && !/fl-chip stale/.test(h));
h = page.rowHTML(Object.assign({}, row, { fresh: false, quote_age_min: 300 }));
chk('a stale row is marked in words ("Stale", why), not only greyed', /data-fresh="false"/.test(h) && /fl-chip stale">Stale</.test(h) && /Older than its 2 h limit/.test(h));
h = page.rowHTML(Object.assign({}, row, { selection: '<img src=x onerror=alert(1)>', best_book: '"><script>x</script>' }));
chk('every string in a row is escaped', !/<img src=x/.test(h) && !/<script>x/.test(h) && /&lt;img src=x/.test(h));
const card = page.leakCard({ dim: 'market', val: 'props', bets: 40, wins: 15, losses: 25, label: 'real_leak', small_sample: false, roi_basis: 'dollars', pl_dollars: -395,
  dollars_bets: 40, avg_clv_pct: -1.4, clv_bets: 40, beat_close: 14, beat_close_pct: 35, roi_pct: -19.8 }, { min_sample_bets: 15 }, true);
chk('the top leak card: the chip, then the sentence, big', /fl-chip leak big">Real leak/.test(card) &&
  /<p class="fl-verdict lead">Props: down \$395 over 40 bets, and you’re not beating the close\. This one’s real\.<\/p>/.test(card));
const sm = page.leakCard({ dim: 'market', val: 'parlay', bets: 6, label: null, small_sample: true }, { min_sample_bets: 15 }, false);
chk('a small-sample card has the Small sample chip and no label word', /Small sample/.test(sm) && !/Real leak|Bad luck|Running hot|Real edge/.test(sm));

console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'fairline page wiring — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
