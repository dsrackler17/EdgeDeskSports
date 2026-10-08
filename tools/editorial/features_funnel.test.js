#!/usr/bin/env node
/* ===========================================================================
   THE READER FUNNEL for EdgeDesk's own articles (supabase/first_party_funnel.sql,
   lib/edgedesk_public.js engagement, the Growth Console panel).

     E  ENGAGED   article_engaged: only on a feature page, only after 30
                  seconds visible AND half the page read, once — and never
                  under Global Privacy Control or Do Not Track
     F  FUNNEL    on a real PostgreSQL: admin-only; impressions and organic
                  visits from Search Console; visits and engaged readers one per
                  session; research clicks are the article's own CTA;
                  registrations confirmed, owners excluded, direct and assisted
                  apart; counts only, never an identity
   Run: node tools/editorial/features_funnel.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const PG = require(path.join(ROOT, 'tools', 'personal', '_pg.js'));

let pass = 0, fail = 0;
function chk(name, cond, detail) {
  if (typeof cond === 'function') { try { cond = cond(); } catch (e) { cond = false; detail = String(e && e.stack || e).slice(0, 300); } }
  if (cond) { pass++; return; }
  fail++; console.log('  × ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 400) : ''));
}
function finish() { console.log((fail ? 'FAIL' : 'PASS') + ' | edgedesk reader funnel | ' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0); }

/* ── E: the engaged reader, with a fake window ──────────────────────────── */
function fakeWindow(o) {
  const calls = [], listeners = {}, store = {};
  let now = 1000000;
  const win = {
    EDPUBLIC_MANUAL: true, __now: () => now, innerHeight: 800, scrollY: 0,
    location: { pathname: '/articles/week-6-storylines-2026/', search: '', hostname: 'edgedesksports.com' },
    document: {
      referrer: '', cookie: '', readyState: 'complete', visibilityState: 'visible',
      body: { getAttribute: (k) => (k === 'data-ed-engage' ? (o.engage ? 'feature' : null) : null) },
      documentElement: { scrollHeight: o.height || 4000, appendChild: () => {} }, head: { appendChild: () => {} },
      createElement: () => ({}), addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); }
    },
    navigator: o.nav || {},
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {} },
    crypto: { getRandomValues: (a) => { for (let i = 0; i < a.length; i++) a[i] = (i * 31 + 7) & 255; return a; } },
    fetch: (url, init) => { calls.push({ url, body: JSON.parse(init.body || '{}') }); return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }); },
    addEventListener: (t, f) => { (listeners['w:' + t] = listeners['w:' + t] || []).push(f); },
    setInterval: () => 1, clearInterval: () => {}
  };
  win.advance = (ms) => { now += ms; };
  win.__calls = calls;
  return win;
}
function load(win) {
  const rd = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  new Function('self', 'globalThis', 'module', rd('lib/edgedesk_track.js'))(win, win, undefined);
  new Function('self', 'globalThis', 'module', rd('lib/edgedesk_public.js'))(win, win, undefined);
  return win.EDPublic;
}
const engagedSent = (w) => w.__calls.filter((c) => /ed_track/.test(c.url) && JSON.stringify(c.body).indexOf('article_engaged') >= 0).length;
const tick = () => new Promise((ok) => setTimeout(ok, 5));
(async function main() {
  let w = fakeWindow({ engage: true });
  let st = load(w).start();
  chk('E a feature page wires the engagement check', !!st.engagement);
  w.advance(20000); w.scrollY = 3000; st.engagement.check();
  chk('E 20 seconds is not engagement, however far the reader scrolled', !st.engagement.state().sent);
  await tick();
  chk('E … and nothing was sent', engagedSent(w) === 0);
  w.advance(15000); w.scrollY = 600; st.engagement.check();
  await tick();
  chk('E 35 seconds, more than half read: engaged, and the event leaves the page (the tracker allows it)', st.engagement.state().sent && st.engagement.state().depth >= 0.5 && engagedSent(w) === 1, w.__calls.map((c) => c.url));
  w.advance(60000); st.engagement.check(); await tick();
  chk('E … once', engagedSent(w) === 1);
  w = fakeWindow({ engage: true });
  st = load(w).start(); w.advance(45000); w.scrollY = 200; st.engagement.check();
  chk('E 45 seconds without reading half: not engaged', !st.engagement.state().sent);
  w = fakeWindow({ engage: true }); w.document.visibilityState = 'hidden';
  st = load(w).start(); w.advance(60000); w.scrollY = 3500; st.engagement.check();
  chk('E time in a background tab does not count', !st.engagement.state().sent);
  w = fakeWindow({ engage: true, height: 700 });
  st = load(w).start(); w.advance(31000); st.engagement.check();
  chk('E a page shorter than the screen is fully read', st.engagement.state().sent);
  w = fakeWindow({ engage: true, nav: { globalPrivacyControl: true } });
  st = load(w).start();
  chk('E Global Privacy Control: no engagement measured at all', st.engagement === null);
  w = fakeWindow({ engage: true, nav: { doNotTrack: '1' } });
  chk('E Do Not Track: the same', load(w).start().engagement === null);
  w = fakeWindow({ engage: false });
  chk('E a game article (no marker) is not measured for engagement', load(w).start().engagement === null);
  fdb();
})();

/* ── F: the funnel on a real database ──────────────────────────────────── */
function fdb() {
const db = PG.start('fpfunnel');
if (db.skip) { console.log('NOTE | ' + db.skip + ' — database section skipped'); finish(); }
try {
  ['billing.sql', 'stripe_webhook.sql', 'referral_codes.sql', 'personal_research.sql', 'affiliates.sql', 'growth.sql', 'funnel.sql', 'site_articles.sql', 'newsletter.sql',
    'growth_engine.sql', 'growth_outbound.sql', 'content_engine.sql'].forEach((f) => db.applyFileAtomic(path.join(PG.ROOT, 'supabase', f)));
  const FILE = path.join(PG.ROOT, 'supabase', 'first_party_funnel.sql');
  const rep1 = db.applyFileAtomic(FILE), rep2 = db.applyFileAtomic(FILE);
  chk('F applies, and applies again', !/CHECK THIS/.test(String(rep1) + String(rep2)), String(rep2).slice(0, 300));
  const lit = PG.lit, one = (s) => db.sql(s);
  const ADMIN = '00000000-0000-0000-0000-00000000aa01', OWNER = '00000000-0000-0000-0000-00000000aa02', A = '00000000-0000-0000-0000-00000000aa03',
    B = '00000000-0000-0000-0000-00000000aa04', C = '00000000-0000-0000-0000-00000000aa05', U = '00000000-0000-0000-0000-00000000aa06';
  one(`insert into auth.users (id, email, email_confirmed_at) values (${lit(ADMIN)}, 'admin@e.test', now()), (${lit(OWNER)}, 'owner@e.test', now()),
         (${lit(A)}, 'a@e.test', now()), (${lit(B)}, 'b@e.test', now()), (${lit(U)}, 'u@e.test', null), (${lit(C)}, 'c@e.test', now());
       insert into public.affiliate_admins (user_id) values (${lit(ADMIN)}), (${lit(OWNER)});
       select growth_outbound.grant_owner('owner@e.test');`);
  const SLUG = 'week-6-storylines-2026';
  const gates = Array.from({ length: 12 }, (_, i) => ({ key: 'g' + i, ok: true }));
  one(`update content_engine.settings set fp_mode = 'auto' where id = 1;`);
  db.service(`select public.content_engine_fp_record(${lit(JSON.stringify({ id: 'feature-2026-10-07-storylines', kind: 'storylines', slot_date: '2026-10-07', week_of: '2026-10-05', status: 'published', mode: 'auto',
    title: 'Georgia at Alabama and Four More Storylines for Week 6', slug: SLUG, url: 'https://edgedesksports.com/articles/' + SLUG + '/', gates }))}::jsonb);`);
  const track = (vid, events) => db.anon(`select public.ed_track(${lit(JSON.stringify(events))}::jsonb, ${lit(vid)}, 'sess_${vid.slice(0, 12)}');`);
  const pv = { event: 'public_page_view', props: { entity: 'article:' + SLUG, kind: 'article' } };
  ['visitor-one-aaaaaaaa', 'visitor-two-bbbbbbbb', 'visitor-three-cccccc'].forEach((v) => track(v, [pv, pv]));
  track('visitor-one-aaaaaaaa', [{ event: 'article_engaged', props: { entity: 'article:' + SLUG } }, { event: 'public_cta_clicked', props: { cta: 'feature_research', page: 'article:' + SLUG } }]);
  track('visitor-two-bbbbbbbb', [{ event: 'article_engaged', props: { entity: 'article:' + SLUG } }, { event: 'public_cta_clicked', props: { cta: 'header_trial', page: 'article:' + SLUG } }]);
  track('visitor-four-dddddddd', [{ event: 'public_page_view', props: { entity: 'article:some-game-2026', kind: 'article' } }]);
  one(`insert into public.search_console_pages (day, page, clicks, impressions) values
         (current_date - 2, 'https://edgedesksports.com/articles/${SLUG}/', 7, 140), (current_date - 1, 'https://edgedesksports.com/articles/${SLUG}/', 5, 90),
         (current_date - 1, 'https://edgedesksports.com/articles/other/', 50, 900);`);
  const ua = (u, first, last) => `(${lit(u)}, now() - interval '2 days', 'search', ${lit(first)}, 'search', ${lit(last)})`;
  one(`insert into public.user_acquisition (user_id, signup_at, first_source, first_landing, last_source, last_landing) values
         ${ua(A, '/', '/articles/' + SLUG + '/')}, ${ua(B, '/articles/' + SLUG + '/', '/')}, ${ua(OWNER, '/articles/' + SLUG + '/', '/articles/' + SLUG + '/')},
         ${ua(U, '/articles/' + SLUG + '/', '/articles/' + SLUG + '/')}, ${ua(C, '/tools/', '/today/')};`);

  chk('F anon cannot read it', !!db.mustFail(() => db.anon(`select public.growth_admin_article_funnel(30);`)));
  chk('F a signed-in reader who is not an admin cannot', !!db.mustFail(() => db.as(A, `select public.growth_admin_article_funnel(30);`)));
  const r = JSON.parse(db.as(ADMIN, `select public.growth_admin_article_funnel(30);`));
  const a = r.articles[0] || {}, T = r.totals || {};
  chk('F the article is EdgeDesk’s own published feature', r.articles.length === 1 && a.slug === SLUG && a.kind === 'storylines', r.articles);
  chk('F impressions and organic visits are Search Console’s, for this page only', a.impressions === 230 && a.organic_visits === 12, a);
  chk('F visits: one per session, three readers (the repeat view is not counted again)', a.visits === 3, a);
  chk('F engaged readers: two', a.engaged === 2, a);
  chk('F research clicks: the article’s own call to action only', a.research_clicks === 1, a);
  chk('F registrations: the confirmed account whose last touch was the article; assisted apart; owners and unconfirmed excluded', a.registrations === 1 && a.registrations_assisted === 1 && T.registrations === 1 && T.registrations_assisted === 1, a);
  chk('F trials and paid are measured (billing installed), zero here', a.trials === 0 && a.paid === 0 && r.measured.billing === true);
  chk('F the targets: 500 organic visits, 100 research clicks, 25 registrations, 3 paid a month', r.targets.map((t) => t.target).join() === '500,100,25,3'
    && r.targets.find((t) => t.key === 'organic_visits').actual === 12 && r.targets.find((t) => t.key === 'research_clicks').actual === 1);
  chk('F counts only: no email, no user id, no visitor id in the answer', !/@e\.test|aa0[1-6]|visitor-/.test(JSON.stringify(r)));
  chk('F it says what it does not count', /Global Privacy Control/.test(r.note) && /Google Search Console/.test(r.note) && /never added/.test(r.note));
  const g = fs.readFileSync(path.join(ROOT, 'admin', 'growth', 'index.html'), 'utf8');
  chk('F the Growth Console shows it beside the acquisition funnel', /growth_admin_article_funnel/.test(g) && /EdgeDesk’s own articles — the reader funnel/.test(g) && /not measured/.test(g));
} catch (e) {
  chk('the database section reached its end — ' + String(e && e.stack || e).slice(0, 600), false);
} finally { db.stop(); }
finish();
}
