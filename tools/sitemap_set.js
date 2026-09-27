/* ============================================================================
   THE SITEMAP SET — sitemap.xml plus every urlset it names.

   WHY THIS EXISTS. sitemap.xml stopped being a single urlset when the research
   articles arrived. Articles are added and refreshed continuously and would
   have churned the same file the standing pages live in, so the primary
   sitemap became an INDEX pointing at sitemap-pages.xml (hand-maintained) and
   sitemap-articles.xml (rewritten by tools/articles/build_articles.js).

   Half a dozen tests assert "this route is in the sitemap", and that
   assertion is still exactly right — it just has to read the SET now. One
   resolver, used by all of them, so the next time the shape changes it
   changes in one place rather than in six that can drift apart.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/* The sitemap files the index names, resolved to repository paths. Only
   same-origin `sitemap*.xml` names are followed: an index is a list of URLs
   and this must never turn into a file reader pointed by a URL. */
function children(root) {
  root = root || ROOT;
  let index = '';
  try { index = fs.readFileSync(path.join(root, 'sitemap.xml'), 'utf8'); } catch (_) { return []; }
  if (index.indexOf('<sitemapindex') < 0) return [];
  return (index.match(/<loc>([^<]+)<\/loc>/g) || [])
    .map(m => m.replace(/<\/?loc>/g, '').trim())
    .map(u => u.replace(/^https?:\/\/[^/]+\//, ''))
    .filter(f => /^sitemap[\w-]*\.xml$/.test(f));
}

/* Every sitemap's text, concatenated — the index first, so a check for the
   index's own shape still works against the same string. */
function text(root) {
  root = root || ROOT;
  let out = '';
  try { out = fs.readFileSync(path.join(root, 'sitemap.xml'), 'utf8'); } catch (_) { return ''; }
  children(root).forEach(f => {
    try { out += '\n' + fs.readFileSync(path.join(root, f), 'utf8'); } catch (_) {}
  });
  return out;
}

/* Every <loc> in the set that is a page rather than another sitemap. */
function urls(root) {
  return (text(root).match(/<loc>([^<]+)<\/loc>/g) || [])
    .map(m => m.replace(/<\/?loc>/g, '').trim())
    .filter(u => !/\/sitemap[\w-]*\.xml$/.test(u));
}

module.exports = { ROOT, children, text, urls };
