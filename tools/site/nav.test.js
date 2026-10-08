#!/usr/bin/env node
/* ===========================================================================
   ONE PRIMARY NAVIGATION ON EVERY PUBLIC PAGE.

   lib/edgedesk_nav.js PRIMARY is the list: Free Research, Today's Games,
   Tools, Research Terminal, Pricing — free research first. The pages are
   hand-written static HTML (and generated articles), so each carries the
   links in its own markup for crawlers; this suite fails the moment one of
   them drifts:

     * every page's Main nav has exactly the five, in order, with the labels
       and destinations in the list (the landing page links its own #pricing)
     * the article generator's copy of the list equals the module
     * every published article and hub, as built, carries it
     * the section a page belongs to is marked, and only that one:
       aria-current="page" on the destination itself, "true" inside it
     * a page that uses the shared row loads its stylesheet
     * the landing page hides none of the five at any width

   Run: node tools/site/nav.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const NAV = require(path.join(ROOT, 'lib', 'edgedesk_nav.js'));
let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) { pass++; return; }
  fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 300) : ''));
}
function eq(name, got, want) { chk(name, JSON.stringify(got) === JSON.stringify(want), { got, want }); }
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const plain = (s) => String(s).replace(/<[^>]+>/g, '').replace(/&rsquo;/g, '’').replace(/&#39;/g, "'").replace(/&amp;/g, '&').trim();

/* the Main nav's links, in order: [key, href, label, aria-current] */
function mainNav(html) {
  const m = /<(nav|div)\b[^>]*(?:aria-label="Main"|id="navMenu")[^>]*>([\s\S]*?)<\/\1>/.exec(html);
  if (!m) return null;
  return [...m[2].matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)]
    .filter((a) => /data-ed-nav="/.test(a[1]))
    .map((a) => [(/data-ed-nav="([^"]+)"/.exec(a[1]) || [])[1], (/href="([^"]+)"/.exec(a[1]) || [])[1], plain(a[2]),
      (/aria-current="([^"]+)"/.exec(a[1]) || [])[1] || null]);
}

/* ── the list itself ─────────────────────────────────────────────────── */
eq('the five, in order, free research first', NAV.PRIMARY.map((x) => x.key), ['research', 'today', 'tools', 'terminal', 'pricing']);
eq('their labels', NAV.PRIMARY.map((x) => x.label), ['Free Research', 'Today’s Games', 'Tools', 'Research Terminal', 'Pricing']);
eq('their destinations', NAV.PRIMARY.map((x) => x.href), ['/articles/', '/today/', '/tools/', '/app.html', '/#pricing']);
NAV.PRIMARY.forEach((x) => {
  if (x.href.charAt(1) === '#') return;
  const rel = x.href === '/app.html' ? 'app.html' : x.href.replace(/^\//, '') + 'index.html';
  chk('the destination exists: ' + x.href, fs.existsSync(path.join(ROOT, rel)));
});
chk('the renderer marks the exact page and the section apart',
  /aria-current="page"/.test(NAV.links('tools', null, 'on', true)) && /aria-current="true"/.test(NAV.links('tools', null, 'on', false))
  && (NAV.links(null).match(/aria-current/g) || []).length === 0);

/* the article generator's copy (it loads in a browser without lib/) */
{
  const R = read('tools/articles/article_render.js');
  const m = /var NAV = \[([\s\S]*?)\];/.exec(R);
  chk('the article renderer carries a copy of the list', !!m);
  const rows = m ? [...m[1].matchAll(/\['([^']+)', '([^']+)', '([^']+)'\]/g)].map((r) => ({ key: r[1], label: JSON.parse('"' + r[2] + '"'), href: r[3] })) : [];
  eq('and it equals lib/edgedesk_nav.js', rows, NAV.PRIMARY.map((x) => ({ key: x.key, label: x.label, href: x.href })));
}

/* ── every public page ───────────────────────────────────────────────── */
/* [file, the section it is in (or null), is it that destination itself] */
const PAGES = [
  ['index.html', null, false],
  ['today/index.html', 'today', true],
  ['tools/index.html', 'tools', true],
  ['tools/no-vig-calculator/index.html', 'tools', false],
  ['tools/fair-odds-calculator/index.html', 'tools', false],
  ['tools/model-vs-market/index.html', 'tools', false],
  ['partners/index.html', null, false],
  ['methodology/index.html', null, false],
  ['newsletter/index.html', null, false],
  ['record.html', null, false],
  ['research/sample/index.html', null, false],
  ['articles/index.html', 'research', true],
  ['articles/nfl/index.html', 'research', false],
  ['articles/college-football/index.html', 'research', false],
  ['articles/community/index.html', 'research', false],
  ['articles/write/index.html', 'research', false]
];
/* and every built article page (published and its aliases) */
fs.readdirSync(path.join(ROOT, 'articles')).forEach((d) => {
  const f = path.join('articles', d, 'index.html');
  if (/-20\d\d/.test(d) && fs.existsSync(path.join(ROOT, f))) PAGES.push([f, 'research', false]);
});
chk('the built articles are covered', PAGES.length > 40, PAGES.length);

PAGES.forEach(([rel, section, exact]) => {
  const html = read(rel);
  const links = mainNav(html);
  chk(rel + ': has a Main navigation', !!links && links.length > 0);
  if (!links) return;
  eq(rel + ': the five, in order', links.map((l) => l[0]), NAV.PRIMARY.map((x) => x.key));
  eq(rel + ': the labels', links.map((l) => l[2]), NAV.PRIMARY.map((x) => x.label));
  const want = NAV.PRIMARY.map((x) => (rel === 'index.html' && x.key === 'pricing') ? '#pricing' : x.href);
  eq(rel + ': the destinations', links.map((l) => l[1]), want);
  const cur = links.filter((l) => l[3]);
  if (section) eq(rel + ': marks its section, and only it', cur.map((l) => [l[0], l[3]]), [[section, exact ? 'page' : 'true']]);
  else eq(rel + ': marks no section', cur.length, 0);
  if (/class="ed-pnav/.test(html)) chk(rel + ': loads the shared nav stylesheet', /\/lib\/edgedesk_nav\.css/.test(html));
  const body = html.slice(Math.max(0, html.indexOf('<body')));
  const head = body.slice(0, body.indexOf('</header>') > 0 ? body.indexOf('</header>') : 4000);
  chk(rel + ': the header links research with its slash (no 301 hop)', !/href="\/articles"/.test(head));
});

/* ── the landing page shows all five ─────────────────────────────────── */
{
  const IDX = read('index.html');
  const css = (IDX.match(/<style>[\s\S]*?<\/style>/g) || []).join('\n');
  chk('the landing page hides no primary link', !/\.nlink\[href[^{]*\{[^}]*display:\s*none/.test(css));
  chk('the landing menu is still a disclosure on a phone', /id="navBurger"[^>]*aria-controls="navMenu"/.test(IDX));
}

/* ── the stylesheet the hand-written pages share ─────────────────────── */
{
  const C = read('lib/edgedesk_nav.css');
  chk('the shared row wraps, never scrolls sideways', /\.ed-pnav\{[^}]*flex-wrap:wrap/.test(C) && !/overflow-x/.test(C));
  chk('on a phone it is a row of its own', /@media\(max-width:760px\)\{[\s\S]*\.ed-pnav\{[^}]*flex:1 0 100%/.test(C));
}

console.log((fail ? 'FAILED ' : 'ALL GREEN ') + 'site navigation — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
