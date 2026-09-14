#!/usr/bin/env node
/* ============================================================================
   THE COMMITTED EDITION STORE — what EdgeDesk said, in the repository.

   THE DATABASE IS PRODUCTION TRUTH and this is the reproducible record, which
   is the same split tools/articles/store.js already makes. An edition that
   exists only in a row cannot be diffed, cannot be re-rendered in a checkout
   with no credentials, and cannot be inspected six months later without
   database access. So every edition is written here too, with the research
   snapshot it was built from, and the render is reproducible from the file
   alone.

   LAYOUT
     articles/data/newsletter/settings.json          committed defaults
     articles/data/newsletter/index.json             one light row per edition
     articles/data/newsletter/editions/<id>.json     the full edition
     articles/data/newsletter/previews/<id>.html     the rendered HTML
     articles/data/newsletter/previews/<id>.txt      the plain-text alternative
     articles/data/newsletter/runs.json              the run log

   THE EDITION ID is the same identity the database's unique index enforces —
   sport, season, slate week and the scheduled local date — with the colons
   turned into hyphens so it is also a filename.
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DIR = path.join(ROOT, 'articles', 'data', 'newsletter');
const EDITIONS = path.join(DIR, 'editions');
const PREVIEWS = path.join(DIR, 'previews');
const INDEX = path.join(DIR, 'index.json');
const SETTINGS = path.join(DIR, 'settings.json');
const RUNS = path.join(DIR, 'runs.json');
const RUN_LOG_MAX = 500;

/* The committed defaults. The database overrides every one of them in
   production — see runtime.js — and these are what the offline suites and a
   credential-free checkout run on. */
const DEFAULT_SETTINGS = {
  schema: 'edgedesk_newsletter_settings_v1',
  sending_enabled: false,
  cfb_enabled: true,
  nfl_enabled: true,
  dispatcher_enabled: true,
  from_name: 'EdgeDesk Research',
  from_email: 'research@edgedesksports.com',
  reply_to_email: 'support@edgedesksports.com',
  mailing_address: 'Rackler Tech Ventures LLC, 2013 89th St, Lubbock, TX 79423',
  site_url: 'https://edgedesksports.com',
  send_hour_local: 10,
  send_minute_local: 0,
  send_zone: 'America/Chicago',
  retry_window_minutes: 240,
  target_games: 5,
  max_games: 10,
  thresholds: { NFL: 30, CFB: 14 },
  expansion_thresholds: { NFL: 38, CFB: 19 },
  quote_stale_hours: 72,
  record_stale_hours: 30,
  gap_confidence_floor: 0.55,
  /* how long after the scheduled minute the NFL edition may keep waiting for
     Monday Night Football to settle before it gives up and either sends with a
     stated cutoff or holds */
  mnf_settle_minutes: 90,
  batch_size: 100,
  test_recipients: [],
};

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  return file;
}

function settings() {
  const stored = readJson(SETTINGS, null);
  return Object.assign({}, DEFAULT_SETTINGS, stored || {});
}
function saveSettings(next) {
  return writeJson(SETTINGS, Object.assign({}, DEFAULT_SETTINGS, next || {}));
}

/* SPORT:SEASON:Wxx:DATE, and the file-safe form of the same thing. */
function editionKey(sport, season, week, editionDate) {
  return [String(sport).toUpperCase(), season, 'W' + String(week).padStart(2, '0'), editionDate].join(':');
}
function fileKey(key) { return String(key).replace(/[:]/g, '-'); }
function editionFile(key) { return path.join(EDITIONS, fileKey(key) + '.json'); }
function previewFile(key, ext) { return path.join(PREVIEWS, fileKey(key) + '.' + ext); }

function loadEdition(key) { return hydrate(readJson(editionFile(key), null)); }
function saveEdition(edition) {
  if (!edition || !edition.edition_key) throw new Error('an edition needs an edition_key');
  writeJson(editionFile(edition.edition_key), edition);
  return edition;
}
/* THE RENDERED EMAIL LIVES HERE AND NOT IN THE EDITION FILE. Both variants,
   both formats, four files. Keeping them out of editions/<id>.json halves the
   committed record without losing anything: these ARE the bodies, byte for
   byte, and the edition points at them. */
function savePreview(key, rendered, variant) {
  fs.mkdirSync(PREVIEWS, { recursive: true });
  const suffix = variant === 'member' ? 'member.' : '';
  const h = previewFile(key, suffix + 'html'), t = previewFile(key, suffix + 'txt');
  fs.writeFileSync(h, rendered.html);
  fs.writeFileSync(t, rendered.text);
  return { html: path.relative(ROOT, h), text: path.relative(ROOT, t) };
}
/* Read the four rendered bodies back onto an edition loaded from disk. The
   send phase needs them and the record deliberately does not carry them. */
function loadBodies(key) {
  const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch (_) { return null; } };
  return {
    html_free: read(previewFile(key, 'html')),
    text_free: read(previewFile(key, 'txt')),
    html_member: read(previewFile(key, 'member.html')),
    text_member: read(previewFile(key, 'member.txt')),
  };
}
function hydrate(edition) {
  if (!edition || !edition.edition_key) return edition;
  if (edition.html_free && edition.text_free) return edition;
  return Object.assign({}, edition, loadBodies(edition.edition_key));
}

function allEditions() {
  if (!fs.existsSync(EDITIONS)) return [];
  return fs.readdirSync(EDITIONS).filter(f => f.endsWith('.json'))
    .map(f => readJson(path.join(EDITIONS, f), null)).filter(Boolean)
    .sort((a, b) => String(b.edition_key).localeCompare(String(a.edition_key)));
}

/* The manifest. Deliberately small: it is what the operator console and the
   run report read, and neither wants a megabyte of research snapshot. */
function buildIndex(editions, opts) {
  opts = opts || {};
  const eds = editions || allEditions();
  return {
    schema: 'edgedesk_newsletter_index_v1',
    generated_at: opts.now ? new Date(opts.now).toISOString() : new Date().toISOString(),
    note: 'One row per edition. The full edition, including the research and market '
      + 'snapshot it was built from, is in editions/<id>.json; the rendered email is '
      + 'in previews/<id>.html and previews/<id>.txt.',
    counts: {
      total: eds.length,
      sent: eds.filter(e => e.status === 'sent').length,
      held: eds.filter(e => e.status === 'held').length,
      skipped: eds.filter(e => e.status === 'skipped').length,
      ready: eds.filter(e => e.status === 'ready').length,
    },
    editions: eds.map(e => ({
      edition_key: e.edition_key, sport: e.sport, season: e.season,
      slate_week: e.slate_week, edition_date: e.edition_date,
      status: e.status, hold_reason: e.hold_reason || null,
      scheduled_at: e.scheduled_at, data_cutoff_at: e.data_cutoff_at,
      subject: e.subject, game_count: e.game_count,
      eligible_recipients: e.eligible_recipients == null ? null : e.eligible_recipients,
      content_hash: e.content_hash, sent_at: e.sent_at || null,
      validation_ok: !!(e.validation && e.validation.ok),
    })),
  };
}
function saveIndex(editions, opts) { return writeJson(INDEX, buildIndex(editions, opts)); }
function loadIndex() { return readJson(INDEX, { schema: 'edgedesk_newsletter_index_v1', editions: [] }); }

/* ------------------------------------------------------------- the runs */
function loadRuns() {
  return readJson(RUNS, { schema: 'edgedesk_newsletter_runs_v1', kept: 0, max: RUN_LOG_MAX, runs: [] });
}
function appendRuns(rows, opts) {
  opts = opts || {};
  const log = loadRuns();
  const at = opts.now ? new Date(opts.now).toISOString() : new Date().toISOString();
  (rows || []).forEach(r => log.runs.push(Object.assign({ at }, r)));
  log.runs = log.runs.slice(-RUN_LOG_MAX);
  log.kept = log.runs.length;
  log.max = RUN_LOG_MAX;
  log.generated_at = at;
  writeJson(RUNS, log);
  return log;
}

/* A content hash of the thing that actually gets sent, so a second run over
   unchanged research produces the same edition and can be recognised as the
   same. Same FNV-1a the editorial snapshot uses, for the same reason: no
   dependency, and stable across runtimes. */
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return ('0000000' + h.toString(16)).slice(-8);
}
function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}
function contentHash(edition) {
  /* everything a reader would see, and nothing that is only a clock */
  return 'ed_' + fnv1a(canonical({
    subject: edition.subject,
    preview_text: edition.preview_text,
    intro: edition.intro,
    games: (edition.games || []).map(g => ({
      key: g.key, rank: g.rank, matchup: g.matchup, kickoff: g.kickoff,
      model: g.model, market: g.market && { line_text: g.market.line_text, book: g.market.book, total: g.market.total },
      difference: g.difference && { points: g.difference.points, edge_home: g.difference.edge_home },
      total: g.total, why: (g.why || []).map(w => w.text), watch: g.watch,
      link: g.link, flags: (g.flags || []).map(f => f.id),
    })),
    disclosures: edition.disclosures,
  }));
}

module.exports = {
  ROOT, DIR, EDITIONS, PREVIEWS, INDEX, SETTINGS, RUNS, RUN_LOG_MAX, DEFAULT_SETTINGS,
  readJson, writeJson, settings, saveSettings,
  editionKey, fileKey, editionFile, previewFile,
  loadEdition, saveEdition, savePreview, allEditions, loadBodies, hydrate,
  buildIndex, saveIndex, loadIndex, loadRuns, appendRuns,
  fnv1a, canonical, contentHash,
};
