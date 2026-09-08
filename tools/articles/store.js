#!/usr/bin/env node
/* ============================================================================
   THE ARTICLE STORE — where a record lives between being generated and being
   read by a crawler.

   IT IS THE REPOSITORY, and that is a decision rather than a shortcut.
   EdgeDesk is a static site: there is no server to render an article on
   request, so an article a search engine can read has to be a committed file.
   Making the repository the store means every publication is a commit, every
   change to a published number is a diff, and the page a reader sees was
   built from the record in the same checkout.

   LAYOUT
     articles/data/index.json          the manifest: one light row per article
                                       plus the publishing settings
     articles/data/records/<id>.json   the full record, research payload and all
     articles/data/market/*.json       captured book quotes replayed into a
                                       build that cannot reach the live capture

   Supabase carries the SAME records where it is reachable
   (supabase/site_articles.sql) so the operator can change publication state
   from a browser; tools/articles/sync.js reconciles the two. Neither is
   required for the other to work: with no network the repository still
   builds every page, and with no commit the operator still sees live state.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const MODEL = require('./article_model.js');

const ROOT = path.join(__dirname, '..', '..');
const DATA = path.join(ROOT, 'articles', 'data');
const RECORDS = path.join(DATA, 'records');
const MARKET = path.join(DATA, 'market');
const INDEX = path.join(DATA, 'index.json');

const DEFAULT_SETTINGS = {
  auto_publish: false,
  /* An article is only auto-published when the game is still ahead of us by
     at least this much. A page published four minutes before kickoff has no
     reader and no crawl time, and it freezes almost immediately. */
  auto_publish_min_lead_minutes: 90,
  /* and never for a game further out than this: research a fortnight early is
     mostly last season, and it would be rewritten before anybody read it */
  auto_publish_max_lead_days: 14
};

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}
function recordFile(id) { return path.join(RECORDS, String(id) + '.json'); }

function loadIndex() {
  const idx = readJson(INDEX, null);
  if (!idx) return { schema: 'edgedesk_article_index_v1', generated_at: null, settings: Object.assign({}, DEFAULT_SETTINGS), articles: [] };
  idx.settings = Object.assign({}, DEFAULT_SETTINGS, idx.settings || {});
  idx.articles = Array.isArray(idx.articles) ? idx.articles : [];
  return idx;
}
function settings() { return loadIndex().settings; }

/* A record goes to disk WITHOUT its derived `article` half and comes back
   with it: the sections are a selection from the research payload the record
   already carries, and writing both would be the same thirty kilobytes twice
   with two places for them to disagree. See article_model.articleFor(). */
function loadAll() {
  if (!fs.existsSync(RECORDS)) return [];
  return fs.readdirSync(RECORDS).filter(f => f.endsWith('.json'))
    .map(f => readJson(path.join(RECORDS, f), null))
    .filter(Boolean)
    .map(MODEL.hydrate)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}
function load(id) { return MODEL.hydrate(readJson(recordFile(id), null)); }
function save(rec) {
  if (!rec || !rec.id) throw new Error('an article record needs an id');
  writeJson(recordFile(rec.id), MODEL.compact(rec));
  return rec;
}
function remove(id) { try { fs.unlinkSync(recordFile(id)); return true; } catch (_) { return false; } }

function published(records) {
  return (records || loadAll()).filter(r => r && r.status === 'published');
}

/* Every slug and alias already claimed, so a new article cannot take one.
   Maps slug -> the id that owns it, which is what uniqueSlug() needs to tell
   "taken by somebody else" from "already mine". */
function takenSlugs(records) {
  const taken = Object.create(null);
  (records || loadAll()).forEach(r => {
    if (r.slug) taken[r.slug] = r.id;
    (r.aliases || []).forEach(a => { taken[a] = r.id; });
  });
  return taken;
}

/* The manifest. Deliberately small — it is what the hub, the admin screen and
   the sitemap read, and none of them wants a megabyte of research payload. */
function buildIndex(records, opts) {
  opts = opts || {};
  const recs = records || loadAll();
  const prior = loadIndex();
  return {
    schema: 'edgedesk_article_index_v1',
    generated_at: opts.now ? new Date(opts.now).toISOString() : new Date().toISOString(),
    settings: Object.assign({}, DEFAULT_SETTINGS, prior.settings, opts.settings || {}),
    counts: {
      total: recs.length,
      published: recs.filter(r => r.status === 'published').length,
      ready: recs.filter(r => r.status === 'ready').length,
      draft: recs.filter(r => r.status === 'draft').length,
      archived: recs.filter(r => r.status === 'archived').length
    },
    articles: recs.map(r => ({
      id: r.id, slug: r.slug, aliases: r.aliases || [], sport: r.sport, sport_slug: r.sport_slug,
      game_id: r.game_id, status: r.status, title: r.title, excerpt: r.excerpt,
      home_team: r.home_team, away_team: r.away_team, game_time: r.game_time,
      published_at: r.published_at, updated_at: r.updated_at, generated_at: r.generated_at,
      model_status: r.model_status, confidence: r.confidence, priced: r.priced,
      fair_spread_text: r.fair_spread_text, fair_total: r.fair_total,
      hero_image: r.hero_image, canonical_url: r.canonical_url, frozen: !!r.frozen,
      model_version: r.model_version
    })).sort((a, b) => (Date.parse(b.published_at || b.updated_at || 0) || 0) - (Date.parse(a.published_at || a.updated_at || 0) || 0))
  };
}
function saveIndex(records, opts) {
  const idx = buildIndex(records, opts);
  writeJson(INDEX, idx);
  return idx;
}

/* ------------------------------------------------- captured market quotes */
/* A book quote EdgeDesk captured, replayed into a build that cannot reach the
   live capture. It is somebody else's number either way; what a snapshot
   changes is only whether this build can see the one the terminal saw. Each
   entry carries its book, the moment it was captured and where the snapshot
   came from, and the article prints that provenance. */
function loadMarketSnapshots() {
  if (!fs.existsSync(MARKET)) return [];
  const out = [];
  fs.readdirSync(MARKET).filter(f => f.endsWith('.json')).sort().forEach(f => {
    const j = readJson(path.join(MARKET, f), null);
    if (!j || !Array.isArray(j.quotes)) return;
    j.quotes.forEach(q => { if (q && q.game_id) out.push(Object.assign({ _file: f, _source: j.source || null }, q)); });
  });
  return out;
}

module.exports = {
  ROOT, DATA, RECORDS, MARKET, INDEX, DEFAULT_SETTINGS,
  readJson, writeJson, recordFile,
  loadIndex, settings, loadAll, load, save, remove, published, takenSlugs,
  buildIndex, saveIndex, loadMarketSnapshots
};
