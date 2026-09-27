/* ============================================================================
   FEED CACHE FRESHNESS — which cached feed may be reused, and which may not.

   The raw feeds are tens of megabytes a season and a COMPLETED season never
   changes again, so caching those between builds is simply correct. The season
   IN PROGRESS is the entire point of a weekly rebuild: it grows every
   Saturday.

   Serving the in-progress season out of a cache a previous run wrote is how a
   scheduled build goes green every week while republishing last week's
   numbers — the job succeeds, the commit is empty, and the board never moves
   on a result it has already seen. This module is the ONE place that decides
   which of those two a cached file is, so no fetcher can quietly get it wrong
   on its own.

   THE RULE
     A cache entry whose name carries a season year EARLIER than the season
     being built is permanent: that football is over.
     Everything else — the season in progress, and any whole-history file that
     carries no year at all (the line archive, the team table) — is VOLATILE
     and may only be reused inside a short window, long enough for the three
     processes of one build to share a download and short enough that the next
     scheduled run always refetches.
   ========================================================================== */
'use strict';
const fs = require('fs');

/* One build runs build_box, build_players and build_rankings as separate
   processes minutes apart, and they read the same schedule and roster files.
   Half an hour lets those share one download; every scheduled run is further
   apart than that, so every scheduled run refetches. */
const DEFAULT_TTL_MS = 30 * 60 * 1000;

function ttlMs() {
  const v = +process.env.EDP_CACHE_TTL_MS;
  return isFinite(v) && v >= 0 ? v : DEFAULT_TTL_MS;
}

/* the season a cache entry belongs to, read from the first four-digit year in
   its name — `pstats_2026.csv`, `player_box_2025.parquet`, `sched_2024.csv` */
function seasonOf(cacheName) {
  const m = /(?:19|20)\d{2}/.exec(String(cacheName == null ? '' : cacheName));
  return m ? +m[0] : null;
}

/* volatile = it can still change under us */
function isVolatile(cacheName, currentSeason) {
  const y = seasonOf(cacheName);
  if (y == null) return true;                       /* no year: whole-history file */
  if (!(currentSeason > 0)) return true;            /* no season stated: assume the worst */
  return !(y < currentSeason);
}

/* May this cached file be read instead of refetched? */
function usable(file, cacheName, currentSeason, minBytes) {
  let st;
  try { st = fs.statSync(file); } catch (_) { return false; }
  if (!(st.size > (minBytes || 0))) return false;
  if (!isVolatile(cacheName, currentSeason)) return true;
  return (Date.now() - st.mtimeMs) <= ttlMs();
}

module.exports = { usable, isVolatile, seasonOf, ttlMs, DEFAULT_TTL_MS };
