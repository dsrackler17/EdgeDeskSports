/* ============================================================================
   RECRUITING PEDIGREE — THE ADAPTER, WITH NO SOURCE WIRED IN.

   Recruiting pedigree is a legitimate component of a young player's rating and
   this layer is built to carry it. It does not carry it today, and this file
   exists to make that a stated architectural fact rather than a silent gap.

   WHY NOTHING IS WIRED IN
   The composite ratings, star ratings and national/position/state ranks that
   everyone quotes are the property of subscription recruiting services. They
   are behind paywalls and their terms forbid redistribution. EdgeDesk does not
   scrape protected or paywalled sources, so:

       recruiting_score, star, national_rank, position_rank, state_rank
       ALL SHIP NULL, AND THE RATING SAYS SO ON EVERY PLAYER.

   The one nearly-public route — CollegeFootballData's recruiting endpoints —
   needs an API key per user, is rate-limited on the free tier, and cannot be
   redistributed as a committed dataset either. A caller who HAS a key and a
   licence can hand this adapter that data through `ingest()` and every rating
   downstream will pick the prior up automatically, with the source named on
   the player. That is the whole point of building the seam.

   WHAT WOULD CHANGE IF A SOURCE WERE WIRED IN
   * `recruiting_score` (0-100) would populate.
   * `prior_z` would replace positional replacement (z = 0) as the shrinkage
     target, which matters most for exactly the players the production feed
     cannot see: true freshmen, and anyone with no attributed snaps.
   * The `recruiting` data-quality dimension would rise off zero.
   NOTHING ELSE. Recruiting pedigree may never equal player quality by itself:
   a former five-star who has played badly must eventually rate below a
   productive three-star veteran, and the shrinkage guarantees it — as college
   evidence accumulates, n/(n+k) drives the prior's weight toward zero.

   Runs in the browser (window.EDPlayerRecruiting) and in node.
   ========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDPlayerRecruiting = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SCHEMA = 'edgedesk_recruiting_adapter_v1';

  /* The normalised record every source must be mapped onto. */
  var FIELDS = ['athlete_id', 'name', 'school', 'position', 'class_year',
    'recruiting_score', 'star', 'national_rank', 'position_rank', 'state_rank',
    'source', 'source_url', 'retrieved_at', 'licence'];

  /* Sources this adapter knows the SHAPE of. `wired` is the honest column. */
  var SOURCES = [
    { id: 'cfbd_recruiting', name: 'CollegeFootballData recruiting/players',
      wired: false, keyless: false, redistributable: false,
      why: 'needs a per-user API key and its terms do not allow committing the data as a dataset. A caller holding a key may supply it through ingest().' },
    { id: 'on3_industry', name: 'industry composite ratings', wired: false, keyless: false, redistributable: false,
      why: 'subscription service; scraping it would violate its terms, so EdgeDesk does not' },
    { id: 'caller_supplied', name: 'anything the caller is licensed to use', wired: false, keyless: null, redistributable: null,
      why: 'the supported route: hand ingest() rows you have the right to use' }
  ];

  function num(v) { if (v == null || v === '') return null; var n = +v; return isFinite(n) ? n : null; }

  /* Normalise one source's rows into the canonical shape. Anything the source
     does not carry stays null — never zero, never a guess. */
  function ingest(rows, opts) {
    opts = opts || {};
    var map = opts.map || {};
    var out = {}, i, r, rec, k;
    for (i = 0; i < (rows || []).length; i++) {
      r = rows[i];
      rec = {};
      for (k = 0; k < FIELDS.length; k++) {
        var f = FIELDS[k];
        var src = map[f] || f;
        rec[f] = (r && r[src] != null && r[src] !== '') ? r[src] : null;
      }
      rec.recruiting_score = normaliseScore(rec.recruiting_score, rec.star, opts.scale);
      rec.source = rec.source || opts.source || null;
      rec.retrieved_at = rec.retrieved_at || opts.retrieved_at || null;
      rec.licence = rec.licence || opts.licence || null;
      var id = rec.athlete_id != null ? String(rec.athlete_id).trim() : '';
      if (!id) continue;               /* a recruiting row with no stable id is not joined by name */
      out['a:' + id] = rec;
    }
    return { schema: SCHEMA, by_key: out, count: Object.keys(out).length,
      source: opts.source || null, retrieved_at: opts.retrieved_at || null };
  }

  /* 0-100. A star rating alone is coarse and is mapped to the midpoint of its
     own band, with the coarseness carried in the confidence, not hidden. */
  var STAR_MIDPOINT = { 5: 95, 4: 82, 3: 65, 2: 48, 1: 35 };
  function normaliseScore(score, star, scale) {
    var s = num(score);
    if (s != null) {
      if (scale === '0_1') return Math.max(0, Math.min(100, s * 100));
      if (scale === 'composite_0_1') return Math.max(0, Math.min(100, (s - 0.7) / 0.3 * 100));
      return Math.max(0, Math.min(100, s));
    }
    var st = num(star);
    return st != null && STAR_MIDPOINT[st] != null ? STAR_MIDPOINT[st] : null;
  }

  /* The prior the rating engine reads. Returns null — not zero — when nothing
     is wired in, so the engine falls back to positional replacement and says
     which of the two it used. */
  function priorFor(playerKey, store) {
    if (!store || !store.by_key || !store.by_key[playerKey]) return null;
    var rec = store.by_key[playerKey];
    var s = num(rec.recruiting_score);
    if (s == null) return null;
    /* the recruiting population's own spread, supplied by the caller that
       ingested it; without it there is no z and the prior stays unused */
    if (!(store.mean != null && store.sd > 0)) {
      return { z: null, score: s, source: rec.source,
        reason: 'a recruiting score arrived but no population mean and spread came with it, so it cannot be turned into a prior' };
    }
    return { z: (s - store.mean) / store.sd, score: s, star: num(rec.star),
      national_rank: num(rec.national_rank), position_rank: num(rec.position_rank),
      state_rank: num(rec.state_rank), source: rec.source, source_url: rec.source_url,
      retrieved_at: rec.retrieved_at, licence: rec.licence };
  }

  function status() {
    return {
      schema: SCHEMA, wired: false,
      shipping_null: ['recruiting_score', 'star', 'national_rank', 'position_rank', 'state_rank'],
      sources: SOURCES,
      statement: 'No recruiting feed is wired in. Every recruiting field on every player is null, and the recruiting data-quality dimension is zero. That is a real gap in this layer and it is reported as one rather than filled with a guess.',
      what_it_would_change: 'the shrinkage prior for players the production feed cannot see — true freshmen and anyone with no attributed snaps. Nothing else. As college evidence accumulates the prior’s weight n/(n+k) falls toward zero on its own, so a five-star who plays badly ends up rated below a productive three-star.'
    };
  }

  return { SCHEMA: SCHEMA, FIELDS: FIELDS, SOURCES: SOURCES,
    ingest: ingest, priorFor: priorFor, normaliseScore: normaliseScore, status: status };
});
