#!/usr/bin/env node
/* ============================================================================
   EdgeDesk Games — publish the board to the franchise layer, and settle.

   The franchise layer scores Price It and settles Pick 5 on the SERVER, so
   the server needs its own copy of the committed challenge artifact — the
   same games/data/challenges.json every /games page reads, produced by the
   canonical Power 4 exporter. This worker is the only thing that writes it.

   WHAT IT DOES
     1. reads games/data/challenges.json;
     2. upserts every challenge and every final into public.game_board
        through game_board_upsert(), which is granted to the service role
        alone;
     3. with --settle, calls franchise_settle_pick5(), which grades every
        open selection whose game now carries a final and credits the
        ledger — idempotent, so replaying this worker changes nothing.

   IT COMPUTES NO PRICE. Every number it sends was in the artifact.

   It needs the SERVICE ROLE key and refuses to run without one: with no
   EDGD_SB_SERVICE it exits 0 having done nothing, so the workflows are
   harmless on a fork or before supabase/games_franchise.sql is applied.

   Usage
     EDGD_SB_SERVICE=... node games/publish_board.js
     EDGD_SB_SERVICE=... node games/publish_board.js --settle
     EDGD_SB_SERVICE=... node games/publish_board.js --dry-run
   ============================================================================ */
'use strict';

var fs = require('fs');
var path = require('path');

var DRY = process.argv.indexOf('--dry-run') >= 0;
var SETTLE = process.argv.indexOf('--settle') >= 0;
var CHUNK = 200;

function log() { console.error.apply(console, arguments); }

function config() {
  var key = process.env.EDGD_SB_SERVICE;
  if (!key) return null;
  var url = process.env.EDGD_SB_URL;
  if (!url) {
    try {
      var cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'config.json'), 'utf8'));
      url = cfg.supabase_url;
    } catch (e) { url = null; }
  }
  return url ? { url: url, key: key } : null;
}

function rpc(cfg, fn, args) {
  return fetch(cfg.url + '/rest/v1/rpc/' + fn, {
    method: 'POST',
    headers: { apikey: cfg.key, authorization: 'Bearer ' + cfg.key, 'content-type': 'application/json' },
    body: JSON.stringify(args || {})
  }).then(function (r) {
    return r.text().then(function (t) {
      var d = null; try { d = t ? JSON.parse(t) : null; } catch (_) { d = t; }
      if (!r.ok) throw new Error(fn + ' ' + r.status + ': ' + (d && (d.message || d.hint) ? (d.message || d.hint) : String(t).slice(0, 200)));
      return d;
    });
  });
}

/* The artifact's kickoff is "YYYY-MM-DD HH:MM" and the exporter stamps it
   UTC (kickoff_tz). Sent as an instant so the server never guesses a zone. */
function kickoffIso(k) {
  if (!k) return null;
  var s = String(k).trim().replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s)) s += (s.length === 16 ? ':00' : '') + 'Z';
  var t = Date.parse(s);
  return isFinite(t) ? new Date(t).toISOString() : null;
}

/* One board row per game: the challenge's prices, and any final the
   artifact carries — finals for games no longer on the board too, because
   those are exactly the ones a card is waiting on. */
function rows(artifact) {
  var out = {}, finals = artifact.finals || {};
  (artifact.challenges || []).forEach(function (c) {
    if (c.game_id == null) return;
    out[String(c.game_id)] = {
      game_id: String(c.game_id), season: c.season == null ? null : c.season, week: c.week == null ? null : c.week,
      slug: c.slug || null, home_team: c.home_team || null, away_team: c.away_team || null,
      kickoff: kickoffIso(c.kickoff), neutral_site: !!c.neutral_site,
      edgedesk_spread: c.edgedesk_spread == null ? null : c.edgedesk_spread,
      market_spread: c.market_spread == null ? null : c.market_spread,
      confidence: c.confidence == null ? null : c.confidence,
      research_state: c.research_state || null, status: c.status || null
    };
  });
  Object.keys(finals).forEach(function (gid) {
    var f = finals[gid];
    if (!f || typeof f.home_score !== 'number' || typeof f.away_score !== 'number') return;
    var r = out[gid] || { game_id: String(gid) };
    r.final_home = f.home_score; r.final_away = f.away_score;
    out[gid] = r;
  });
  return Object.keys(out).map(function (k) { return out[k]; });
}

function main() {
  var cfg = config();
  if (!cfg) {
    log('[franchise] no EDGD_SB_SERVICE (and/or no project URL) — nothing published, exit 0');
    return Promise.resolve(0);
  }
  var artifact;
  try {
    artifact = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'challenges.json'), 'utf8'));
  } catch (e) {
    log('[franchise] cannot read games/data/challenges.json: ' + e.message);
    return Promise.resolve(1);
  }
  if (!artifact || artifact.schema !== 'edgedesk_games_challenges_v1') {
    log('[franchise] refusing an artifact that is not edgedesk_games_challenges_v1');
    return Promise.resolve(1);
  }
  var all = rows(artifact);
  var withFinal = all.filter(function (r) { return r.final_home != null; }).length;
  log('[franchise] ' + all.length + ' board row(s) from the artifact, ' + withFinal + ' with a final'
    + (DRY ? ' — dry run, nothing written' : ''));
  if (DRY) return Promise.resolve(0);

  var i = 0, published = 0;
  function next() {
    if (i >= all.length) return Promise.resolve();
    var chunk = all.slice(i, i + CHUNK); i += CHUNK;
    return rpc(cfg, 'game_board_upsert', { p_rows: chunk }).then(function (n) {
      published += (n | 0);
      return next();
    });
  }
  return next().then(function () {
    log('[franchise] published ' + published + ' row(s) to game_board');
    if (!SETTLE) return 0;
    return rpc(cfg, 'franchise_settle_pick5', {}).then(function (r) {
      log('[franchise] settled: ' + JSON.stringify(r));
      return 0;
    });
  }).catch(function (e) {
    var m = String(e && e.message || e);
    if (/404|Could not find the function|does not exist/i.test(m)) {
      log('[franchise] the franchise functions are not deployed (' + m.slice(0, 120) + ') — nothing published, exit 0');
      return 0;
    }
    log('[franchise] failed: ' + m);
    return 1;
  });
}

if (require.main === module) {
  main().then(function (code) { process.exit(code); });
}

module.exports = { rows: rows, kickoffIso: kickoffIso, config: config };
