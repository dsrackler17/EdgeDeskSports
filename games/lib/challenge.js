/* ===========================================================================
   EdgeDesk Games — challenge identity and selection.

   Pure functions over challenge records. The BUILDER uses them to choose and
   name what goes in the artifact; the PAGES use the same functions to pick
   today's challenge out of it. One implementation, so a share link built by
   the browser and a slug written by the build always agree.

   NOTHING HERE COMPUTES A PRICE. Every quantitative field on a challenge comes
   from the canonical Power 4 export and is passed through untouched.
   =========================================================================== */
(function (root) {
  'use strict';

  /* ── identity ─────────────────────────────────────────────────────────── */

  /* A URL-safe team token: "Texas A&M" -> "texas-am", "Miami (FL)" -> "miami-fl" */
  function teamSlug(name) {
    return String(name == null ? '' : name)
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-and-/g, '-')      /* "texas-and-m" reads worse than "texas-m" */
      || 'team';
  }

  /* The canonical challenge slug: away, then home, the way a matchup is read
     aloud. `/games/price-it/?g=toledo-michigan-state`.

     Two games between the same two teams in one season (a rematch in a title
     game) would collide; the builder appends the game_id when it detects one,
     and `slugFor` is given that responsibility rather than guessing here. */
  function baseSlug(away, home) { return teamSlug(away) + '-' + teamSlug(home); }

  function slugFor(rec, disambiguate) {
    var s = baseSlug(rec.away_team, rec.home_team);
    return disambiguate ? (s + '-' + rec.game_id) : s;
  }

  /* ── selection ────────────────────────────────────────────────────────── */

  /* How playable is this matchup as a PRICE IT challenge?

     Higher is better. The ranking is deterministic and total — no clock, no
     random — so the same slate always yields the same order, and a rebuilt
     artifact does not reshuffle a player's challenge out from under them.

     What it prefers, in order of weight:
       * a live market number (the reveal has three prices, not two)
       * a projection the engine actually made
       * the engine's own confidence in it
       * a Power 4 team on the field (recognisable to a cold visitor)
       * an earlier kickoff (a game about to be played is more interesting) */
  function playability(rec) {
    if (!rec || rec.status !== 'PREDICTED') return -1;
    if (rec.edgedesk_spread == null) return -1;
    var s = 0;
    if (rec.market_spread != null) s += 1000;
    s += Math.max(0, Math.min(100, rec.confidence == null ? 0 : rec.confidence)) * 4;
    if (rec.p4) s += 150;
    if (rec.both_fbs) s += 60;
    return s;
  }

  /* Sort a pool into canonical challenge order. Ties break on kickoff, then
     game_id, so the order is total and stable across builds. */
  function rank(pool) {
    return (pool || []).slice().sort(function (a, b) {
      var d = playability(b) - playability(a);
      if (d) return d;
      var ta = Date.parse(a.kickoff) || 0, tb = Date.parse(b.kickoff) || 0;
      if (ta !== tb) return ta - tb;
      return String(a.game_id).localeCompare(String(b.game_id));
    });
  }

  /* A small stable hash, so "today's challenge" is a pure function of the day
     and the pool rather than of when the page happened to load.

     FNV-1a, then a murmur3 finalising mix. The mix is not decoration: FNV's
     low bits barely move between two strings as similar as "2026-09-04" and
     "2026-09-05", so without it `hash(day) % poolSize` lands on the same few
     matchups for days at a time — the rotation stops rotating. */
  function hash(str) {
    var h = 2166136261, i;
    str = String(str);
    for (i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    h ^= h >>> 16; h = Math.imul(h, 2246822507);
    h ^= h >>> 13; h = Math.imul(h, 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  }

  /* How deep into the ranked board the daily rotation is allowed to reach.
     A cold visitor's FIRST matchup decides whether they play at all, so the
     rotation draws from the strongest challenges rather than from the whole
     slate — otherwise a Tuesday lands on an FCS blowout the model itself does
     not trust, which is the worst possible front door. Still deterministic,
     still rotates: it is a smaller wheel, not a fixed pick. */
  var FEATURE_POOL = 12;

  /* Today's Price It challenge: rotate through the strongest playable games by
     day key, so a returning visitor gets a different matchup tomorrow and a
     new one gets a good matchup today.

     Games whose kickoff has passed are dropped first — a challenge nobody can
     still be curious about is not a challenge. */
  function featured(pool, dayKey, nowMs) {
    var live = playable(pool, nowMs);
    if (!live.length) return null;
    var wheel = live.slice(0, Math.min(FEATURE_POOL, live.length));
    return wheel[hash(dayKey || '') % wheel.length];
  }

  /* Every challenge still worth playing, best first. */
  function playable(pool, nowMs) {
    var now = nowMs == null ? Date.now() : nowMs;
    return rank((pool || []).filter(function (r) {
      if (playability(r) < 0) return false;
      var t = Date.parse(r.kickoff);
      return !isFinite(t) || t > now;
    }));
  }

  /* Find one challenge by slug, falling back to game_id so an older share link
     still resolves after a rebuild. */
  function bySlug(pool, slug) {
    if (!slug) return null;
    var i, s = String(slug);
    for (i = 0; i < (pool || []).length; i++) if (pool[i].slug === s) return pool[i];
    for (i = 0; i < (pool || []).length; i++) if (String(pool[i].game_id) === s) return pool[i];
    return null;
  }

  /* ── Pick 5 ───────────────────────────────────────────────────────────── */

  /* The week's five. Deterministic: the five most playable games of the week
     that carry a market number, because a pick against a spread needs a
     spread. Fewer than five available means fewer than five are offered —
     the card never pads itself with a game it cannot price. */
  function pickFive(pool, weekKey, nowMs) {
    var live = playable(pool, nowMs).filter(function (r) { return r.market_spread != null; });
    return live.slice(0, 5);
  }

  var API = {
    FEATURE_POOL: FEATURE_POOL,
    teamSlug: teamSlug, baseSlug: baseSlug, slugFor: slugFor,
    playability: playability, rank: rank, playable: playable,
    hash: hash, featured: featured, bySlug: bySlug, pickFive: pickFive
  };
  root.EDGamesChallenge = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
