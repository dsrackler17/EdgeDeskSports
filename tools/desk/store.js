/* ============================================================================
   THE DESK STORE — published desk articles, committed, for the static build.

   articles/data/desk/records/<slug>.json holds one PUBLISHED desk article:
   the draft that was published (its body and its whole data snapshot) and
   the take that was required for it. tools/desk/sync.js writes it from the
   public view desk_published; tools/articles/build_articles.js renders it.
   A draft is never in here: the view cannot return one.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DIR = path.join(ROOT, 'articles', 'data', 'desk', 'records');
const SITE = 'https://edgedesksports.com';

/* the committed shape of one published desk article, from a desk_published row */
function toRecord(row) {
  return {
    schema: 'edgedesk_desk_article_v1',
    article_key: row.article_key, type: row.type, sport: row.sport, season: row.season, week: row.week, period: row.period,
    slug: row.slug, canonical_url: SITE + '/articles/' + row.slug + '/', status: 'published',
    title: row.title, description: row.description, lead: row.lead, highlights: row.highlights || [],
    reddit_title: row.reddit_title || null, record_link: row.record_link || null,
    body_md: row.generated_body, my_take: row.my_take,
    data_snapshot: row.data_snapshot, data_as_of: row.data_as_of,
    draft_id: row.draft_id, source_commit: row.source_commit, generator_version: row.generator_version,
    generated_at: row.generated_at, published_at: row.published_at, updated_at: row.updated_at
  };
}
function loadPublished(dir) {
  dir = dir || DIR;
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()
    .map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
    .filter(r => r && r.status === 'published' && r.slug);
}
function save(rec, dir) {
  dir = dir || DIR;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, rec.slug + '.json');
  const body = JSON.stringify(rec, null, 1) + '\n';
  const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (prev === body) return false;
  fs.writeFileSync(file, body);
  return true;
}
function remove(slug, dir) {
  const file = path.join(dir || DIR, slug + '.json');
  if (fs.existsSync(file)) { fs.unlinkSync(file); return true; }
  return false;
}

module.exports = { ROOT, DIR, SITE, toRecord, loadPublished, save, remove };
