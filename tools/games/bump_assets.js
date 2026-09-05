#!/usr/bin/env node
/* ===========================================================================
   Bump the games asset version.

   Every /games page loads its scripts and stylesheets from URLs that carry
   ONE version token: /games/games.js?v=20260905a. A browser that cached the
   old games.js keeps serving it for as long as it likes — a phone opened
   the new Drill page against a games.js from the week before and sat on a
   skeleton forever, because the store function the page needed did not
   exist in the cached copy. A new token is a new URL, and a new URL is a
   fresh fetch; nothing else reliably is.

   Run after ANY change under games/ that a page depends on:

       node tools/games/bump_assets.js            # today's date, letter a
       node tools/games/bump_assets.js 20260905b  # an explicit token

   tools/games/games.test.js fails if any page carries a different token
   from the others, or a games asset with no token at all.
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const PAGES = ['index.html', 'price-it/index.html', 'pick-5/index.html', 'h2h/index.html',
  'groups/index.html', 'dynasty/index.html', 'two-minute-drill/index.html', 'status/index.html']
  .map(p => path.join(ROOT, 'games', p));

function today() {
  const d = new Date();
  return String(d.getUTCFullYear()) + String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0');
}

/* the token in play, read from the games home */
function current() {
  const home = fs.readFileSync(PAGES[0], 'utf8');
  const m = home.match(/\/games\/games\.js\?v=([A-Za-z0-9._-]+)/);
  return m ? m[1] : null;
}

/* the next token: today's date, then a letter that advances if today's is
   already in play (a second bump on the same day is b, then c) */
function next(explicit) {
  if (explicit) return explicit;
  const cur = current() || '';
  const base = today();
  if (cur.indexOf(base) !== 0) return base + 'a';
  const letter = cur.slice(base.length) || 'a';
  return base + String.fromCharCode(letter.charCodeAt(0) + 1);
}

/* rewrite every local games asset URL to carry the token */
function stamp(html, v) {
  return html.replace(/(["'])(\/games\/[^"'?]+\.(?:js|css))(\?v=[A-Za-z0-9._-]+)?\1/g,
    (m, q, url) => q + url + '?v=' + v + q);
}

if (require.main === module) {
  const v = next(process.argv[2]);
  let changed = 0;
  PAGES.forEach(p => {
    if (!fs.existsSync(p)) return;
    const before = fs.readFileSync(p, 'utf8');
    const after = stamp(before, v);
    if (after !== before) { fs.writeFileSync(p, after); changed++; }
  });
  console.log('games assets stamped ' + v + ' in ' + changed + ' page(s)');
}

module.exports = { PAGES, current, next, stamp, today };
