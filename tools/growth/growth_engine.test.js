#!/usr/bin/env node
/* ===========================================================================
   THE GROWTH ENGINE, offline: everything that does not need a database or a
   browser.

     1  THE FREE TOOLS' ARITHMETIC — conversions, the four de-vig methods (held
        equal to lib/edgedesk_ev.js, the terminal's own), fair odds, break-even
        and EV, and the refusals.
     2  THE PUBLIC-PAGE TRACKER (lib/edgedesk_public.js) in a fake browser: the
        landing page's first-touch rule, a search visit that reads an article
        first stays SEARCH, what is sent and what never is, GPC honoured.
     3  THE PUBLIC PAGES — tools, partners, the newsletter flows: metadata,
        canonicals that answer 200, the offer worded by lib/edgedesk_pricing.js,
        honest copy, the tracker loaded, nothing secret.
     4  ROBOTS AND SITEMAPS — the tool pages allowed one by one, the build
        scripts under /tools/ and the draft store still disallowed; every
        standing page submitted.
     5  ARTICLES — the trial line, served URLs, no link to an unpublished page,
        a real share image.
     6  NEWSLETTER LINKS carry the newsletter's own UTM.
     7  THE SEARCH CONSOLE IMPORTER signs a JWT a real RSA key verifies, writes
        only well-formed rows, prints counts only, and skips when unconfigured.
     8  THE SECURITY FIXES stay fixed (workflow inputs, cron auth, confirm on
        GET, honeypot, no error detail to anon, token redaction).

   Run: node tools/growth/growth_engine.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (ok) { pass++; return; }
  fail++; failures.push(name + (detail !== undefined ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300) : ''));
}
function section(t) { void t; }
const near = (a, b, e) => Math.abs(a - b) <= (e || 1e-6);

/* ═════════════════════════════ 1. THE ARITHMETIC ═════════════════════════ */
section('1');
const T = require(path.join(ROOT, 'lib', 'edgedesk_odds_tools.js'));
const EV = require(path.join(ROOT, 'lib', 'edgedesk_ev.js'));
(function () {
  let r = T.parsePrice('-110');
  chk('-110 is decimal 1.9091, 52.38%', r.ok && near(r.decimal, 1 + 100 / 110) && near(r.implied, 110 / 210));
  r = T.parsePrice('+150');
  chk('+150 is decimal 2.5, 40%', r.ok && near(r.decimal, 2.5) && near(r.implied, 0.4));
  r = T.parsePrice('−120');
  chk('a typographic minus is read as minus', r.ok && r.american === -120);
  r = T.parsePrice('1.91');
  chk('1.91 is read as decimal', r.ok && r.format === 'decimal' && near(r.decimal, 1.91));
  r = T.parsePrice('150', 'american');
  chk('a bare 150 in American mode is +150', r.ok && r.american === 150);
  ['+50', '-99', 'abc', '', '1.0', '-110.5'].forEach((x) => {
    chk('"' + x + '" is refused in American mode', !T.parsePrice(x, 'american').ok);
  });
  chk('decimal ≤ 1 is refused', !T.parsePrice('0.95', 'decimal').ok && !T.parsePrice('1', 'decimal').ok);
  chk('+100 and −100 display as the book prints them', T.americanDisplay(100) === '+100' && T.americanDisplay(-100) === '-100' && T.americanDisplay(99.4) === '+100');

  let nv = T.noVig(['-110', '-110']);
  chk('−110/−110: 52.38% each, 104.76% total, 4.76% overround, 4.55% hold, fair 50%/+100',
    nv.ok && near(nv.outcomes[0].implied, 0.52381, 1e-5) && near(nv.total_implied, 1.047619, 1e-5) && near(nv.overround, 0.047619, 1e-5)
    && near(nv.hold, 0.045455, 1e-5) && nv.outcomes.every((o) => near(o.fair, 0.5, 1e-6) && o.fair_american_display === '+100'), nv);
  chk('the working is printed', nv.steps.length === 4 && /104\.76%/.test(nv.steps[1]) && /Multiplicative/.test(nv.steps[2]));
  nv = T.noVig(['-150', '+130'], { method: 'proportional' });
  chk('−150/+130 multiplicative: fair probabilities sum to 1', nv.ok && near(nv.outcomes[0].fair + nv.outcomes[1].fair, 1, 1e-9));
  chk('the favourite keeps the favourite\'s side', nv.outcomes[0].fair > 0.5 && /^-/.test(nv.outcomes[0].fair_american_display));
  nv = T.noVig(['+300', '+300', '+300']);
  chk('prices that add to 75% are refused as not one market', !nv.ok && /98% and 150%/.test(nv.errors[0].error));
  nv = T.noVig(['-110', 'oops']);
  chk('a bad price names its side', !nv.ok && nv.errors[0].index === 1);
  nv = T.noVig(['-110']);
  chk('one outcome is not a market', !nv.ok);
  nv = T.noVig(['+10000', '-500', '+400'], { method: 'additive' });
  chk('additive refuses an impossible longshot and says so', !nv.ok && /additive method gives an impossible probability/.test(nv.errors[0].error), nv);
  nv = T.noVig(['+10000', '-500', '+400'], { method: 'shin' });
  chk('…while the other methods still price that market, and the comparison names the refusal', nv.ok
    && nv.compare.some((c) => c.method === 'additive' && !c.ok) && nv.compare.filter((c) => c.ok).length === 3, nv.compare);

  /* ONE TRUTH: the calculator's de-vig is the terminal's, to 1e-12 */
  const grid = [[-110, -110], [-150, 130], [-200, 170], [-400, 300], [105, -125], [-1000, 650], [250, -320], [-115, -105]];
  const methods = ['proportional', 'additive', 'power', 'shin'];
  let worst = 0, n = 0;
  grid.forEach((g) => methods.forEach((m) => {
    const dec = g.map((a) => (a > 0 ? 1 + a / 100 : 1 + 100 / -a));
    const a = T.devig(dec, m), b = EV.devig(dec, m);
    if (a.ok !== b.ok) { worst = Infinity; return; }
    if (!a.ok) return;
    n++;
    a.p.forEach((x, i) => { worst = Math.max(worst, Math.abs(x - b.p[i])); });
  }));
  chk('the calculator\'s four methods equal lib/edgedesk_ev.js devig on ' + n + ' markets', n >= 28 && worst < 1e-12, { n, worst });
  const three = [2.1, 3.4, 3.6];
  chk('…and on a three-way market', methods.every((m) => { const a = T.devig(three, m), b = EV.devig(three, m); return a.ok === b.ok && (!a.ok || a.p.every((x, i) => Math.abs(x - b.p[i]) < 1e-12)); }));

  let fo = T.fairOdds('60');
  chk('60% is 1.6667 and −150', fo.ok && near(fo.fair_decimal, 1.6667, 1e-4) && fo.fair_american_display === '-150');
  fo = T.fairOdds('40%');
  chk('40% is 2.50 and +150', fo.ok && fo.fair_decimal === 2.5 && fo.fair_american_display === '+150');
  fo = T.fairOdds('0.55');
  chk('0.55 is read as 55%', fo.ok && near(fo.probability, 0.55));
  fo = T.fairOdds('50', { push: '5' });
  chk('a push refunds the stake: 50% win, 5% push → (1 − 0.05)/0.5 = 1.90', fo.ok && near(fo.fair_decimal, 1.9, 1e-9) && near(fo.loss, 0.45));
  fo = T.fairOdds('55', { price: '-110' });
  chk('at 55% a −110 price: break-even 52.38%, EV +$5.00 per $100',
    fo.ok && near(fo.compare.break_even, 0.523810, 1e-6) && near(fo.compare.ev_per_100, 5, 1e-9) && near(fo.compare.edge_pp, 2.619, 1e-3), fo.compare);
  chk('…and the working says it is arithmetic on the reader\'s number, not a forecast', /not a forecast/.test(fo.steps[2]));
  fo = T.fairOdds('40', { price: '+140' });
  chk('a negative EV is reported as negative', fo.ok && fo.compare.ev_per_100 < 0 && near(fo.compare.ev_per_100, -4, 1e-9));
  ['0', '100', '150', 'x', '-5'].forEach((x) => chk('probability "' + x + '" is refused', !T.fairOdds(x).ok));
  chk('a push that leaves no loss is refused', !T.fairOdds('60', { push: '45' }).ok);
  chk('a bad comparison price is refused by field', !T.fairOdds('55', { price: '+50' }).ok && T.fairOdds('55', { price: '+50' }).errors[0].field === 'price');
})();

/* ═══════════════════════════════ 2. THE TRACKER ══════════════════════════ */
section('2');
function fakeWindow(o) {
  o = o || {};
  const store = Object.assign({}, o.store || {});
  const calls = [];
  const listeners = {};
  const win = {
    EDPUBLIC_MANUAL: true,
    location: { pathname: o.path || '/articles/x-vs-y-2026/', search: o.search || '', hostname: 'edgedesksports.com' },
    document: {
      referrer: o.referrer || '', cookie: o.cookie || '', readyState: 'complete',
      body: { getAttribute: (k) => (k === 'data-ed-page' ? (o.page || null) : null) },
      head: { appendChild: () => { win.__gaScript = true; } }, documentElement: { appendChild: () => {} },
      createElement: () => ({}),
      addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); }
    },
    navigator: o.nav || {},
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    sessionStorage: { getItem: () => null, setItem: () => {} },
    crypto: { getRandomValues: (a) => { for (let i = 0; i < a.length; i++) a[i] = (i * 37 + 11) & 255; return a; } },
    fetch: (url, init) => { calls.push({ url, body: JSON.parse(init.body || '{}'), init }); return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }); },
    addEventListener: () => {}
  };
  win.__calls = calls; win.__store = store; win.__listeners = listeners;
  return win;
}
function loadPublic(win) {
  const src = rd('lib/edgedesk_public.js');
  const trackSrc = rd('lib/edgedesk_track.js');
  /* both files are UMD: run them with this fake window as their root */
  const fnT = new Function('self', 'globalThis', 'module', trackSrc);
  fnT(win, win, undefined);
  const fn = new Function('self', 'globalThis', 'module', src);
  fn(win, win, undefined);
  return win.EDPublic;
}
(function () {
  /* A. Google → an article: an organic placeholder that REMEMBERS Google */
  let w = fakeWindow({ referrer: 'https://www.google.com/', path: '/articles/ole-miss-vs-vanderbilt-2026/' });
  let P = loadPublic(w); let st = P.start();
  const first = JSON.parse(w.__store.edgedesk_attribution);
  chk('A a search visit is stored as an organic first touch that keeps its referrer and landing page',
    first.organic === true && first.referrer === 'www.google.com' && first.landing === '/articles/ole-miss-vs-vanderbilt-2026/', first);
  const acq = w.__calls.filter((c) => /acq_track_visit/.test(c.url));
  chk('A the visit is sent to acq_track_visit with the referrer host and landing, nothing else',
    acq.length === 1 && acq[0].body.p_touch.referrer_host === 'www.google.com' && acq[0].body.p_touch.landing === '/articles/ole-miss-vs-vanderbilt-2026/'
    && /^[A-Za-z0-9_-]{16,64}$/.test(acq[0].body.p_visitor) && !JSON.stringify(acq[0].body).includes('@'), acq);
  chk('A the page names itself article:<slug>', st.kind === 'article:ole-miss-vs-vanderbilt-2026');
  /* the same browser, next page, internal referrer: nothing sent to acquisition */
  const w2 = fakeWindow({ referrer: 'https://edgedesksports.com/articles/x/', path: '/tools/', store: w.__store });
  P = loadPublic(w2); P.start();
  chk('A an internal click sends no second acquisition visit', w2.__calls.filter((c) => /acq_track_visit/.test(c.url)).length === 0);
  chk('A …and the first touch is untouched', JSON.parse(w2.__store.edgedesk_attribution).referrer === 'www.google.com');

  /* B. a code-bearing visit upgrades an organic placeholder ONCE, then freezes */
  const w3 = fakeWindow({ referrer: 'https://t.co/', search: '?utm_source=newsletter&utm_medium=email&utm_campaign=nl_cfb_20261012', store: w.__store });
  P = loadPublic(w3); P.start();
  let f3 = JSON.parse(w3.__store.edgedesk_attribution);
  chk('B a tagged visit replaces an organic placeholder and keeps when the organic one was', f3.utm_source === 'newsletter' && !f3.organic && !!f3.organic_first_seen_at, f3);
  const w4 = fakeWindow({ search: '?ref=coachx', store: w3.__store });
  P = loadPublic(w4); P.start();
  f3 = JSON.parse(w4.__store.edgedesk_attribution);
  chk('B once a code is credited, a later one does not take it', f3.utm_source === 'newsletter' && !f3.ref, f3);
  chk('B …the later code is kept as the LAST touch', JSON.parse(w4.__store.edgedesk_attribution_last).ref === 'coachx');
  chk('B a ?ref= on any public page counts a partner click', w4.__calls.some((c) => /affiliate_track_click/.test(c.url) && c.body.p_code === 'COACHX'));

  /* C. a direct visit learns its first outside referrer, once */
  const w5 = fakeWindow({ referrer: '', path: '/' });
  P = loadPublic(w5); P.start();
  const w6 = fakeWindow({ referrer: 'https://duckduckgo.com/', path: '/tools/no-vig-calculator/', store: w5.__store });
  P = loadPublic(w6); P.start();
  chk('C a typed-in first visit followed by a search visit becomes the search visit', JSON.parse(w6.__store.edgedesk_attribution).referrer === 'duckduckgo.com');

  /* D. GA, and privacy */
  const w7 = fakeWindow({ nav: { globalPrivacyControl: true } });
  P = loadPublic(w7); P.start();
  chk('D Global Privacy Control: Google Analytics is not loaded', typeof w7.gtag !== 'function' && !w7.__gaScript);
  const w8 = fakeWindow({});
  P = loadPublic(w8); P.start();
  chk('D without it, GA4 loads with the site\'s one property', typeof w8.gtag === 'function' && w8.__gaScript === true && P.GA_ID === 'G-1PXVBV53FZ');

  /* E. page kinds */
  const K = (p) => P.kindOf(p, null);
  chk('E page kinds', K('/articles/') === 'research_hub:all' && K('/articles/nfl/') === 'research_hub:nfl' && K('/tools/') === 'tools_hub'
    && K('/tools/fair-odds-calculator/') === 'tool:fair-odds-calculator' && K('/newsletter/') === 'newsletter' && K('/record.html') === 'record'
    && K('/partners/') === 'partners' && K('/methodology/') === 'methodology', [K('/articles/'), K('/tools/')]);
  chk('E the tracker\'s registry includes the four public events',
    ['public_page_view', 'tool_used', 'public_cta_clicked', 'newsletter_signup'].every((e) => w8.EDTrack.CLIENT.indexOf(e) >= 0));
  const fsql = rd('supabase/funnel.sql');
  chk('E …and so does the database\'s', ['public_page_view', 'tool_used', 'public_cta_clicked', 'newsletter_signup']
    .every((e) => new RegExp("\\('" + e + "',\\s*'client'").test(fsql)));
  /* the tracker's props never carry an address */
  chk('E props drop anything that looks like an address', JSON.stringify(w8.EDTrack._props({ cta: 'x', email: 'a@b.com', source: 'nl_tool' })) === '{"cta":"x","source":"nl_tool"}');
})();

/* ═══════════════════════════════ 3. PUBLIC PAGES ═════════════════════════ */
section('3');
const PRICING = require(path.join(ROOT, 'lib', 'edgedesk_pricing.js'));
(function () {
  const pages = {
    'tools/index.html': 'https://edgedesksports.com/tools/',
    'tools/no-vig-calculator/index.html': 'https://edgedesksports.com/tools/no-vig-calculator/',
    'tools/fair-odds-calculator/index.html': 'https://edgedesksports.com/tools/fair-odds-calculator/',
    'tools/model-vs-market/index.html': 'https://edgedesksports.com/tools/model-vs-market/',
    'partners/index.html': 'https://edgedesksports.com/partners/'
  };
  Object.keys(pages).forEach((f) => {
    const h = rd(f), head = h.split('</head>')[0];
    chk(f + ': a title under 95 characters', /<title>([^<]{20,95})<\/title>/.test(head));
    chk(f + ': a meta description', /<meta name="description" content="[^"]{80,}"/.test(head));
    chk(f + ': canonical is its own served URL (trailing slash)', head.indexOf('<link rel="canonical" href="' + pages[f] + '">') >= 0);
    chk(f + ': indexable', /<meta name="robots" content="index,follow">/.test(head));
    chk(f + ': a real share image', /property="og:image" content="https:\/\/edgedesksports\.com\/assets\/og\/edgedesk-research\.png"/.test(head)
      && fs.existsSync(path.join(ROOT, 'assets', 'og', 'edgedesk-research.png')));
    const ld = (head.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) || []).map((b) => { try { return JSON.parse(b.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '')); } catch (e) { return null; } });
    chk(f + ': structured data that parses', ld.length >= 1 && ld.every(Boolean));
    chk(f + ': one H1', (h.match(/<h1[\s>]/g) || []).length === 1);
    chk(f + ': the trial terms, worded by lib/edgedesk_pricing.js', h.indexOf(PRICING.CTA_LINE) >= 0, PRICING.CTA_LINE);
    chk(f + ': the trial button goes to the landing page\'s checkout, counted', /href="\/#subscribe" data-ed-cta="[a-z_]+"/.test(h));
    chk(f + ': loads the first-party tracker, deferred', /<script src="\/lib\/edgedesk_track\.js[^"]*" defer><\/script>\s*<script src="\/lib\/edgedesk_public\.js[^"]*" defer><\/script>/.test(h));
    chk(f + ': 21+ and the helpline', /21\+/.test(h) && /1-800-GAMBLER/.test(h));
    chk(f + ': research, not picks', /Research, not picks/i.test(h));
    chk(f + ': no service key', h.indexOf('service_role') < 0 && !/sk_live|sk_test|whsec_/.test(h));
    chk(f + ': no tout language', !/\b(lock of|best bets?|guaranteed (win|profit)|can'?t lose|sure thing|free money)\b/i.test(h.replace(/<script[\s\S]*?<\/script>/g, '')));
  });
  const P2 = rd('partners/index.html');
  chk('partners: promises no commission and no payment without a written agreement',
    /agreed individually and in writing/.test(P2) && /does not pay or credit anything without that written agreement/.test(P2) && !/\d+%\s*(commission|recurring)/i.test(P2));
  const NV = rd('tools/no-vig-calculator/index.html');
  chk('no-vig page: loads the arithmetic library and tracks one use per page load', /\/lib\/edgedesk_odds_tools\.js/.test(NV) && /track\('tool_used', \{ entity: 'no_vig'/.test(NV));
  chk('no-vig page: the method is in the HTML a crawler reads', /pᵢ = qᵢ ÷ Σq/.test(NV) && /<noscript>/.test(NV));
  const MV = rd('tools/model-vs-market/index.html');
  chk('explorer: reads only the public board door and the published index', /rpc\/public_home_board/.test(MV) && /\/articles\/data\/published\.json/.test(MV)
    && !/game_research_state|rpc\/(?!public_home_board)/.test(MV));
  chk('explorer: judges staleness with the landing page\'s own view model', /\/lib\/edgedesk_home\.js/.test(MV) && /H\.build\(rpc, null, Date\.now\(\)/.test(MV));
  chk('explorer: shows no EV and no player props', !/calibrated_ev|ev_text|\.props\b/.test(MV.split('<script>')[1] || ''));

  const NL = rd('newsletter/index.html');
  chk('newsletter: the findings topic', /id="nlFindings"/.test(NL));
  chk('newsletter: product updates have their own box, not pre-ticked, sent as their own consent', /id="nlProduct"/.test(NL)
    && !/id="nlProduct"[^>]*checked/.test(NL) && /product_consent: product\.checked/.test(NL));
  chk('newsletter: the honeypot is off-screen and sent', /class="hpf" aria-hidden="true"/.test(NL) && /website: \$\('nlWebsite'\)\.value/.test(NL));
  chk('newsletter: the source label comes from ?from=, cleaned', /'nl_' \+ f/.test(NL) && /replace\(\/\[\^a-z0-9_\]\/g, ''\)/.test(NL));
  chk('newsletter: the consent box is still not pre-ticked', !/id="nlConsent"[^>]*checked/.test(NL));
  ['newsletter/confirm/index.html', 'newsletter/manage/index.html'].forEach((f) => {
    const h = rd(f);
    chk(f + ': noindex, no referrer, a strict CSP to the project only', /noindex,nofollow/.test(h) && /name="referrer" content="no-referrer"/.test(h)
      && /connect-src https:\/\/iattxbkbufslbauoumga\.supabase\.co;/.test(h));
    chk(f + ': the token is read from the fragment and leaves the address bar', /location\.hash/.test(h) && /history\.replaceState/.test(h));
    chk(f + ': loads no tracker and no analytics', !/edgedesk_track|edgedesk_public|gtag/.test(h));
    chk(f + ': no button inside someone else\'s frame', /window\.top!==window\.self/.test(h));
  });
  const CF = rd('newsletter/confirm/index.html');
  chk('confirm: newsletter_confirm is called only from the button', /go\.addEventListener\('click'[\s\S]*rpc\/newsletter_confirm/.test(CF)
    && (CF.match(/rpc\/newsletter_confirm/g) || []).length === 1);
  const MG = rd('newsletter/manage/index.html');
  chk('manage: opening it only READS preferences; changes are button presses', /rpc\('newsletter_preferences_get'/.test(MG)
    && /\$\('save'\)\.addEventListener\('click'/.test(MG) && /\$\('all'\)\.addEventListener\('click'/.test(MG));
  const UN = rd('email/unsubscribe/index.html');
  chk('trial-email unsubscribe: a button, not a page load', /stop\.addEventListener\('click'[\s\S]*rpc\/lifecycle_unsubscribe/.test(UN));
  chk('the record and methodology pages load the public tracker', /edgedesk_public\.js/.test(rd('record.html')) && /edgedesk_public\.js/.test(rd('methodology/index.html')));
  ['terms.html', 'privacy.html', 'disclaimer.html', 'record.html'].forEach((f) => chk(f + ': a canonical', /<link rel="canonical" href="https:\/\/edgedesksports\.com\/[a-z]+\.html">/.test(rd(f))));
  const IDX = rd('index.html');
  chk('landing: a real share image and a large card', /property="og:image" content="https:\/\/edgedesksports\.com\/assets\/og\/edgedesk-research\.png"/.test(IDX) && /twitter:card" content="summary_large_image"/.test(IDX));
  chk('landing: links the free tools and the partners page', /href="\/tools\/"/.test(IDX) && /href="\/partners\/"/.test(IDX));
  chk('admin pages are noindex', ['admin/acquisition/index.html', 'admin/seo/index.html'].every((f) => /noindex,nofollow/.test(rd(f))));
  const AQ = rd('admin/acquisition/index.html');
  chk('acquisition dashboard: operator RPCs only, under the operator\'s token', /rpc\('growth_admin_acquisition'/.test(AQ) && /rpc\('growth_is_admin'/.test(AQ)
    && !/growth_acquisition_payload|growth_mrr|service_role/.test(AQ));
  chk('acquisition dashboard: estimates are marked as estimates', /kpi\.est/.test(AQ) && /mrr_net_cents_estimate/.test(AQ) && /trial_mrr_list_cents_estimate/.test(AQ));
})();

/* ═══════════════════════════ 4. ROBOTS AND SITEMAPS ══════════════════════ */
section('4');
const SEO = require(path.join(ROOT, 'tools', 'seo', 'audit.js'));
(function () {
  const rules = SEO.robotsRules(ROOT);
  const ok = (p) => SEO.allowed(rules, p).ok;
  ['/tools/', '/tools/no-vig-calculator/', '/tools/fair-odds-calculator/', '/tools/model-vs-market/', '/tools/tools.css', '/articles/', '/articles/x-vs-y-2026/',
    '/partners/', '/newsletter/', '/assets/og/edgedesk-research.png', '/lib/edgedesk_public.js', '/articles/data/published.json']
    .forEach((p) => chk('robots allows ' + p, ok(p)));
  ['/tools/articles/build_articles.js', '/tools/growth/gsc_import.js', '/tools/editorial/', '/articles/data/records/cfb-1.json', '/articles/data/index.json',
    '/supabase/newsletter.sql', '/admin/acquisition/', '/articles/_preview/x/']
    .forEach((p) => chk('robots still disallows ' + p, !ok(p)));
  chk('robots: the longest rule wins and a tie goes to Allow', SEO.allowed([{ allow: false, path: '/a/' }, { allow: true, path: '/a/' }], '/a/x').ok
    && !SEO.allowed([{ allow: true, path: '/a' }, { allow: false, path: '/a/b' }], '/a/b/c').ok && SEO.allowed([{ allow: false, path: '/t/' }, { allow: true, path: '/t/$' }], '/t/').ok);
  const sm = new Set(SEO.sitemapUrls(ROOT));
  SEO.STANDING.forEach((p) => chk('submitted in the sitemap: ' + p, sm.has('https://edgedesksports.com' + p)));
  const idx = rd('sitemap.xml');
  const lms = (idx.match(/<lastmod>([^<]+)<\/lastmod>/g) || []).map((m) => m.replace(/<\/?lastmod>/g, ''));
  const arts = rd('sitemap-articles.xml');
  const newestArt = (arts.match(/<lastmod>([^<]+)<\/lastmod>/g) || []).map((m) => m.replace(/<\/?lastmod>/g, '')).sort().pop();
  chk('the sitemap index dates the article set by its newest article, not by the build', lms.indexOf(newestArt) >= 0, { lms, newestArt });
  chk('article sitemap URLs carry the trailing slash GitHub Pages serves', (arts.match(/<loc>([^<]+)<\/loc>/g) || []).every((m) => /\/<\/loc>$/.test(m)));
  const rep = SEO.run(ROOT);
  chk('the SEO audit finds no error on any public page', rep.summary.errors === 0, rep.pages.filter((r) => r.errors.length).map((r) => r.path + ': ' + r.errors.join('; ')).slice(0, 5));
})();

/* ════════════════════════════════ 5. ARTICLES ════════════════════════════ */
section('5');
const R = require(path.join(ROOT, 'tools', 'articles', 'article_render.js'));
(function () {
  chk('the article trial line is lib/edgedesk_pricing.js CTA_LINE', R.TRIAL_LINE === PRICING.CTA_LINE, [R.TRIAL_LINE, PRICING.CTA_LINE]);
  chk('slashed(): article URLs gain the slash, others are left alone', R.slashed('https://edgedesksports.com/articles/a-b-2026') === 'https://edgedesksports.com/articles/a-b-2026/'
    && R.slashed('/articles') === '/articles/' && R.slashed('/articles/nfl/') === '/articles/nfl/' && R.slashed('/app.html#x') === '/app.html#x'
    && R.slashed('https://edgedesksports.com/articles/a#b') === 'https://edgedesksports.com/articles/a/#b');
  const rec = { article_type: 'postgame', related: { pregame_url: 'https://edgedesksports.com/articles/never-published-2026' } };
  chk('a postgame page does not link to a pregame that was never published', R.relatedHTML(rec, new Set(['other'])) === '');
  chk('…and does link to one that was', /Before the game/.test(R.relatedHTML(rec, new Set(['never-published-2026']))));
  const pub = JSON.parse(rd('articles/data/published.json'));
  chk('the published index lists published articles only, with served URLs', pub.articles.length > 0 && pub.articles.every((a) => /\/articles\/[a-z0-9-]+\/$/.test(a.url)));
  const page = rd('articles/' + pub.articles.find((a) => a.type === 'pregame').slug + '/index.html');
  chk('a published article carries the trial line twice and links to the tools', (page.split(PRICING.CTA_LINE).length - 1) >= 2 && /href="\/tools\/no-vig-calculator\/"/.test(page));
  chk('a published article\'s share image is a PNG, never a data: URI', /og:image" content="https:\/\/edgedesksports\.com\/assets\/og\/edgedesk-research\.png"/.test(page) && !/og:image" content="data:/.test(page));
  chk('the editorial integrity gate treats the offer line as boilerplate', /RENDER\.TRIAL_LINE/.test(rd('tools/editorial/quality.js')));
})();

/* ════════════════════════════ 6. NEWSLETTER LINKS ════════════════════════ */
section('6');
(function () {
  const NR = require(path.join(ROOT, 'tools', 'newsletter', 'render.js'));
  const e = { sport: 'NFL', edition_date: '2026-10-13', week: 6 };
  chk('a site link gains the newsletter UTM', NR.tagUrl('https://edgedesksports.com/articles/nfl/', e) === 'https://edgedesksports.com/articles/nfl/?utm_source=newsletter&utm_medium=email&utm_campaign=nl_nfl_20261013');
  chk('…before the fragment the terminal routes on', NR.tagUrl('https://edgedesksports.com/app.html#research/football/x', e) === 'https://edgedesksports.com/app.html?utm_source=newsletter&utm_medium=email&utm_campaign=nl_nfl_20261013#research/football/x');
  chk('legal pages and already-tagged links are left alone', NR.tagUrl('https://edgedesksports.com/privacy.html', e) === 'https://edgedesksports.com/privacy.html'
    && NR.tagUrl('https://edgedesksports.com/?utm_source=x', e) === 'https://edgedesksports.com/?utm_source=x');
  const html = NR.tagLinks('<a href="https://edgedesksports.com/articles/x/">a</a> <a href="https://iattxbkbufslbauoumga.supabase.co/functions/v1/newsletter/unsubscribe?t=abc">u</a>', e, null, true);
  chk('in HTML the ampersands are entities, and the unsubscribe link is untouched', /utm_source=newsletter&amp;utm_medium=email/.test(html) && /unsubscribe\?t=abc"/.test(html));
  chk('the classifier reads utm_source=newsletter as the newsletter channel', /if src in \('newsletter', 'edgedesk_newsletter'\) or med = 'newsletter' then return 'newsletter'/.test(rd('supabase/growth.sql')));
})();

/* ═══════════════════════ 7. THE SEARCH CONSOLE IMPORTER ══════════════════ */
section('7');
const GSC = require(path.join(ROOT, 'tools', 'growth', 'gsc_import.js'));
(async function () {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sa = { client_email: 'edgedesk@proj.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), private_key_id: 'k1' };
  const jwt = GSC.assertion(sa, 1700000000);
  const [h, c, s] = jwt.split('.');
  const verify = crypto.createVerify('RSA-SHA256').update(h + '.' + c).verify(publicKey, Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
  const claims = JSON.parse(Buffer.from(c.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
  chk('7 the assertion is a valid RS256 JWT for the read-only Search Console scope', verify && claims.scope === 'https://www.googleapis.com/auth/webmasters.readonly'
    && claims.iss === sa.client_email && claims.exp - claims.iat === 3600, claims);
  const w = GSC.windowOf(10, Date.parse('2026-10-08T12:00:00Z'));
  chk('7 the window is ten days ending three days ago', w.start === '2026-09-26' && w.end === '2026-10-05', w);
  const rows = GSC.toRows([{ keys: ['2026-10-01', 'https://edgedesksports.com/tools/'], clicks: 3, impressions: 90, ctr: 0.0333, position: 12.4 },
    { keys: ['bad-date', 'https://x'], clicks: 1 }, { keys: ['2026-10-01', 'not a url'], clicks: 1 }], 'page');
  chk('7 malformed rows are dropped, never coerced', rows.length === 1 && rows[0].clicks === 3 && rows[0].page === 'https://edgedesksports.com/tools/');
  const logs = [];
  let out = await GSC.main({}, { log: (m) => logs.push(m) });
  chk('7 unconfigured: says what is missing and does nothing', out.ok && out.skipped.indexOf('GSC_SERVICE_ACCOUNT_JSON') >= 0 && /not configured/.test(logs[0]));
  const writes = [];
  const fakeFetch = async (url, init) => {
    if (/oauth2/.test(url)) return { ok: true, status: 200, json: async () => ({ access_token: 'tok' }) };
    const body = JSON.parse(init.body);
    const dim = body.dimensions[1];
    return { ok: true, status: 200, json: async () => ({ rows: [{ keys: ['2026-10-01', dim === 'page' ? 'https://edgedesksports.com/articles/a/' : 'no vig calculator'], clicks: 2, impressions: 40, ctr: 0.05, position: 7 }] }) };
  };
  const db = { upsert: async (s1, rel, r) => { writes.push([rel, r.length]); }, insert: async (s1, rel, r) => { writes.push([rel, r.length, r[0]]); } };
  logs.length = 0;
  out = await GSC.main({ GSC_SERVICE_ACCOUNT_JSON: JSON.stringify(sa), GSC_SITE: 'sc-domain:edgedesksports.com', SB_SERVICE_ROLE: 'svc' },
    { fetch: fakeFetch, db, log: (m) => logs.push(m), now: Date.parse('2026-10-08T12:00:00Z') });
  chk('7 configured: pages and queries upserted by day, and the run recorded', out.ok && out.pages === 1 && out.queries === 1
    && writes.some((x) => x[0] === 'search_console_pages') && writes.some((x) => x[0] === 'search_console_queries') && writes.some((x) => x[0] === 'search_console_runs' && x[2].ok === true), writes);
  chk('7 the log prints counts only — never a page or a query', logs.length === 1 && !/no vig calculator|\/articles\/a\//.test(logs[0]), logs);
  const wf = rd('.github/workflows/search-console.yml');
  chk('7 the workflow passes secrets as env and the day count as data', /GSC_SERVICE_ACCOUNT_JSON: \$\{\{ secrets\.GSC_SERVICE_ACCOUNT_JSON \}\}/.test(wf)
    && !/run:[^\n]*\$\{\{ github\.event\.inputs/.test(wf) && /case "\$DAYS" in/.test(wf));
  chk('7 an unconfigured run is loud: a ::warning:: and a run-summary line naming the missing secrets', /::warning::Search Console import not configured/.test(wf)
    && /Missing secret\(s\):\$missing\." >> "\$GITHUB_STEP_SUMMARY"/.test(wf) && ['GSC_SERVICE_ACCOUNT_JSON', 'GSC_SITE', 'SB_SERVICE_ROLE', 'SB_URL'].every((k) => wf.indexOf('[ -n "$' + k + '" ]') >= 0));
  finish8();
})().catch((e) => { chk('7 the importer suite ran — ' + e.message, false); finish8(); });

/* ═══════════════════════════ 8. THE SECURITY FIXES ═══════════════════════ */
async function finish8() {
  const wf = rd('.github/workflows/newsletter.yml');
  const runs = (wf.match(/run: \|[\s\S]*?(?=\n {6}- name:|\n {6}#|$)/g) || []).join('\n');
  chk('8 no free-text dispatch input is interpolated into a shell script', !/\$\{\{\s*github\.event\.inputs\.(to|sport|phase|force)\s*\}\}/.test(runs));
  chk('8 the test address is validated before use', /grep -Eq '\^\[A-Za-z0-9\._%\+-\]\{1,64\}@/.test(wf));
  const NF = rd('supabase/functions/newsletter/index.ts');
  chk('8 /confirm on GET redirects and confirms nothing', /if \(req\.method !== 'POST'\) \{\s*return redirect\(`\$\{c\.site\}\/newsletter\/confirm\/#t=/.test(NF));
  chk('8 /preferences and /unsubscribe on GET redirect to the site', /return redirect\(`\$\{c\.site\}\/newsletter\/manage\/#t=\$\{encodeURIComponent\(url\.searchParams\.get\('t'\)/.test(NF)
    && /return redirect\(`\$\{c\.site\}\/newsletter\/manage\/#t=\$\{encodeURIComponent\(t\)\}&unsubscribe=/.test(NF));
  chk('8 the RFC 8058 one-click POST is unchanged', /body\['List-Unsubscribe'\] === 'One-Click'/.test(NF));
  chk('8 the honeypot answers like everyone and does nothing', /if \(String\(body\.website \?\? body\.hp \?\? ''\)\.trim\(\) !== ''\) return json\(\{ ok: true, state: 'check_your_email' \}\);/.test(NF));
  chk('8 no RPC error text reaches an anonymous caller', !/reason: 'signup_failed', detail/.test(NF) && !/confirmation_email_failed', detail/.test(NF));
  chk('8 the client address is keyed, and a missing one is still one source', /'edgedesk-nl-ip:' \+ c\.serviceKey/.test(NF) && /\|\| 'unknown'/.test(NF));
  chk('8 a confirmed address is mailed its own preferences link instead of being changed', /send_manage_link/.test(NF) && /manageEmail\(/.test(NF));
  chk('8 the operator\'s test address is validated in the function too', /invalid_test_address/.test(NF));
  const NC = rd('supabase/functions/newsletter_cron/index.ts');
  chk('8 the newsletter cron refuses a caller without the service role', /if \(!\(await authorized\(req\)\)\)/.test(NC) && NC.indexOf('authorized(req)') < NC.indexOf('const out = await run()'));
  /* the same two doors by behaviour: neither function imports anything, so
     Node loads the TypeScript as is (Deno.serve absent: no server starts) */
  try {
    const ENV = { SUPABASE_URL: 'https://proj.supabase.test', SUPABASE_SERVICE_ROLE_KEY: 'service-key-123' };
    globalThis.Deno = { env: { get: (k) => ENV[k] } };
    const { pathToFileURL } = require('url');
    const NFM = await import(pathToFileURL(path.join(ROOT, 'supabase/functions/newsletter/index.ts')).href);
    const req = (h) => new Request('https://x.test/', { headers: h });
    const ih = (h) => NFM.ipHash({ serviceKey: 'k' }, req(h));
    chk('8 the client address: x-real-ip counts when it is the only header', (await ih({ 'x-real-ip': '1.2.3.4' })) === (await ih({ 'x-forwarded-for': '1.2.3.4, 10.0.0.1' }))
      && (await ih({ 'x-real-ip': '1.2.3.4' })) !== (await ih({})));
    chk('8 …no header at all and an empty one are the same single source', (await ih({})) === (await ih({ 'x-forwarded-for': '' })) && (await ih({})) === (await ih({ 'cf-connecting-ip': ' ' })));
    chk('8 …and the hash is keyed', (await ih({ 'x-real-ip': '1.2.3.4' })) !== (await NFM.ipHash({ serviceKey: 'other' }, req({ 'x-real-ip': '1.2.3.4' }))));
    const NCM = await import(pathToFileURL(path.join(ROOT, 'supabase/functions/newsletter_cron/index.ts')).href);
    const reads = [];
    const settingsRead = (rows, ok = true) => async (url, init) => { reads.push([url, init.headers.authorization]); return { ok, json: async () => rows }; };
    const auth = (tok, f) => NCM.authorized(new Request('https://x.test/', { method: 'POST', headers: tok == null ? {} : { authorization: 'Bearer ' + tok } }), f);
    chk('8 the cron: the service key passes without a network call', (await auth('service-key-123', settingsRead([]))) === true && reads.length === 0);
    chk('8 …no token, or a token that reads no settings row (anon, a reader), is refused', (await auth(null, settingsRead([{ id: 1 }]))) === false
      && (await auth('anon-or-reader', settingsRead([]))) === false && (await auth('expired', settingsRead({ message: 'JWT expired' }, false))) === false);
    chk('8 …a token that can read the settings row (a newsletter operator) passes', (await auth('operator-jwt', settingsRead([{ id: 1 }]))) === true
      && reads.some((r) => /\/rest\/v1\/newsletter_settings\?select=id&limit=1$/.test(r[0]) && r[1] === 'Bearer operator-jwt'));
    chk('8 …a fetch that throws is a refusal', (await auth('x', async () => { throw new Error('down'); })) === false);
  } catch (e) { chk('8 the edge functions load under Node and run — ' + e.message, false); }
  const RUN = rd('tools/newsletter/run.js');
  chk('8 a test send prints no live token and no full address', /redactToken\(l\.unsubscribe\)/.test(RUN) && /maskEmail\(l\.email\)/.test(RUN));
  const RUNMOD = (() => { const src = RUN.slice(RUN.indexOf('function maskEmail'), RUN.indexOf('function redactToken')) + RUN.slice(RUN.indexOf('function redactToken')).split('\n}\n')[0] + '\n}'; return new Function(src + '; return { maskEmail, redactToken };')(); })();
  chk('8 …redaction keeps four characters', RUNMOD.redactToken('https://x/unsubscribe?t=' + 'a'.repeat(64) + '&sport=NFL') === 'https://x/unsubscribe?t=aaaa…(redacted)&sport=NFL'
    && RUNMOD.maskEmail('davis@example.com') === 'da***@example.com');

  console.log('');
  failures.forEach((f) => console.log('  × ' + f));
  console.log((fail ? 'FAIL' : 'PASS') + ' | growth engine | ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
