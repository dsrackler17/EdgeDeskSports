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
  'groups/index.html', 'dynasty/index.html', 'two-minute-drill/index.html', 'status/index.html',
  'franchise/index.html', 'roster/index.html', 'gameday/index.html', 'trophies/index.html', 'market/index.html',
  'conference/index.html', 'trades/index.html', 'staff/index.html', 'development/index.html', 'packs/index.html',
  'play/index.html']
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
/* the suffix counts a..z, then aa..az, ba.., and so on. It used to add one
   to the character code and stop thinking, so the twenty-seventh bump of a
   single day produced "20260907{" — a token that is not what the pages are
   stamped with and, worse, a '{' in a URL. Twenty-six deploys in a day is a
   long day, but it happens. */
function bumpSuffix(sfx) {
  if (!sfx) return 'a';
  const chars = sfx.split('');
  let i = chars.length - 1;
  while (i >= 0) {
    if (chars[i] !== 'z') { chars[i] = String.fromCharCode(chars[i].charCodeAt(0) + 1); return chars.join(''); }
    chars[i] = 'a';
    i--;
  }
  return 'a' + chars.join('');
}
function next(explicit) {
  if (explicit) return explicit;
  const cur = current() || '';
  const base = today();
  if (cur.indexOf(base) !== 0) return base + 'a';
  const sfx = cur.slice(base.length);
  return base + (/^[a-z]*$/.test(sfx) ? bumpSuffix(sfx) : 'a');
}

/* rewrite every local games asset URL to carry the token */
/* anything after the '?' is replaced, whatever it is. The old pattern only
   recognised a well-formed token, so once a bad one had been written the
   stamper could no longer see it to fix it. */
function stamp(html, v) {
  return html.replace(/(["'])(\/games\/[^"'?]+\.(?:js|css))(\?[^"']*)?\1/g,
    (m, q, url) => q + url + '?v=' + v + q);
}

/* THE SHARED LIBRARIES TOO. games.js loads /lib/edgedesk_*.js itself, from a
   token the page stamper could not see, and it was already a letter behind
   every page that loaded it. The token is one constant in games.js and this
   rewrites it with the same value the pages get. */
const SHARED = path.join(ROOT, 'games', 'games.js');
function stampShared(js, v) {
  return js.replace(/var SHARED_V = '[A-Za-z0-9._-]*';/, "var SHARED_V = '" + v + "';");
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
  if (fs.existsSync(SHARED)) {
    const before = fs.readFileSync(SHARED, 'utf8');
    const after = stampShared(before, v);
    if (after !== before) { fs.writeFileSync(SHARED, after); changed++; }
  }
  console.log('games assets stamped ' + v + ' in ' + changed + ' file(s)');
}

module.exports = { PAGES, SHARED, current, next, stamp, stampShared, today, bumpSuffix };
