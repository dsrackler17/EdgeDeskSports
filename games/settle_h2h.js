#!/usr/bin/env node
/* ============================================================================
   EdgeDesk Games — settle Head-to-Head challenges.

   The trusted half of the social layer. A browser cannot settle a challenge:
   h2h_settle() is granted to no client role, so the outcome of a game is a
   server-side fact rather than something a page asserts about itself.

   WHAT IT DOES
     1. reads the final scores out of games/data/challenges.json — the same
        committed artifact the pages read, produced by the canonical Power 4
        exporter;
     2. asks the database for locked, unsettled challenges on those games;
     3. grades each one with games/lib/h2h_grade.js — against the market
        SNAPSHOT frozen onto the challenge, never a number the market has since
        moved to;
     4. calls h2h_settle(), which is idempotent: replaying this worker cannot
        change a result that already landed.

   It needs the SERVICE ROLE key and refuses to run without one. Without
   EDGD_SB_SERVICE it exits 0 having done nothing, so the workflow is harmless
   on a fork or before the SQL is applied.

   Usage
     EDGD_SB_SERVICE=... node games/settle_h2h.js
     EDGD_SB_SERVICE=... node games/settle_h2h.js --dry-run
   ============================================================================ */
'use strict';

var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
global.window = global.window || global;
require(path.join(__dirname, 'lib', 'scoring.js'));
var GRADE = require(path.join(__dirname, 'lib', 'h2h_grade.js'));

var DRY = process.argv.indexOf('--dry-run') >= 0;

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
    headers: {
      apikey: cfg.key,
      authorization: 'Bearer ' + cfg.key,
      'content-type': 'application/json'
    },
    body: JSON.stringify(args || {})
  }).then(function (r) {
    return r.text().then(function (t) {
      var d = null;
      try { d = t ? JSON.parse(t) : null; } catch (_) { d = t; }
      if (!r.ok) throw new Error(fn + ' -> ' + r.status + ' ' + (d && d.message ? d.message : t));
      return d;
    });
  });
}

/* PostgREST select against the tables, as the service role. Only this worker
   ever reads selections directly, and only to grade them. */
function table(cfg, q) {
  return fetch(cfg.url + '/rest/v1/' + q, {
    headers: { apikey: cfg.key, authorization: 'Bearer ' + cfg.key }
  }).then(function (r) {
    if (!r.ok) return r.text().then(function (t) { throw new Error(q + ' -> ' + r.status + ' ' + t); });
    return r.json();
  });
}

async function main() {
  var cfg = config();
  if (!cfg) {
    log('[settle] no service credentials (EDGD_SB_SERVICE) — nothing to do');
    return;
  }
  if (typeof fetch !== 'function') {
    log('[settle] this runtime has no fetch');
    return;
  }

  var art;
  try {
    art = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'challenges.json'), 'utf8'));
  } catch (e) {
    log('[settle] cannot read the challenge artifact: ' + e.message);
    process.exit(1);
  }
  var finals = art.finals || {};
  var ids = Object.keys(finals);
  if (!ids.length) {
    log('[settle] no final scores in the artifact yet');
    return;
  }
  log('[settle] ' + ids.length + ' completed game(s) in the artifact');

  /* Challenges that locked, have not settled, and are on a game we have a
     final for. Anything else is left strictly alone. */
  var rows = await table(cfg,
    'game_challenges?select=id,invite_token,mode,canonical_game_id,market_snapshot,'
    + 'home_team,away_team&settled_at=is.null&locked_at=not.is.null'
    + '&canonical_game_id=in.(' + ids.map(encodeURIComponent).join(',') + ')');
  if (!rows.length) {
    log('[settle] nothing is waiting to be settled');
    return;
  }
  log('[settle] ' + rows.length + ' locked challenge(s) to grade');

  var done = 0, skipped = 0, failed = 0;
  for (var i = 0; i < rows.length; i++) {
    var c = rows[i];
    var sels = await table(cfg,
      'game_challenge_selections?select=player_slot,selection&challenge_id=eq.' + c.id);
    var a = null, b = null;
    sels.forEach(function (s) {
      if (s.player_slot === 'a') a = s.selection;
      if (s.player_slot === 'b') b = s.selection;
    });
    var result = finals[c.canonical_game_id];
    var g = GRADE.grade(c, a, b, result);
    if (!g) {
      log('  · ' + c.invite_token + ' (' + c.mode + ') — not gradeable from what is available');
      skipped++;
      continue;
    }
    if (DRY) {
      log('  ~ ' + c.invite_token + ' (' + c.mode + ') would settle: a=' + g.outcome_a);
      done++;
      continue;
    }
    try {
      var r = await rpc(cfg, 'h2h_settle', {
        p_challenge: c.id, p_outcome_a: g.outcome_a,
        p_evidence: g.evidence, p_score_a: g.score_a, p_score_b: g.score_b
      });
      log('  ' + (r && r.already_settled ? '=' : '✓') + ' ' + c.invite_token
        + ' (' + c.mode + ') a=' + g.outcome_a);
      done++;
    } catch (e) {
      log('  × ' + c.invite_token + ' — ' + e.message);
      failed++;
    }
  }

  if (!DRY) {
    try {
      var n = await rpc(cfg, 'h2h_sweep_expired', {});
      if (n) log('[settle] ' + n + ' unanswered challenge(s) marked expired');
    } catch (e) { log('[settle] sweep failed: ' + e.message); }
  }

  log('[settle] ' + done + ' settled, ' + skipped + ' skipped, ' + failed + ' failed');
  if (failed) process.exit(1);
}

main().catch(function (e) { console.error(e && (e.stack || e.message)); process.exit(1); });
