/* ============================================================================
   WEATHER FOR A HEADLESS BUILD — the same integration the board already uses.

   The terminal fetches a forecast per game from open-meteo, keyless, joined on
   the venue coordinates in the trained parameter table (`fbP4Weather` in
   app.html). The offline builder fetched nothing at all and passed
   `weather: null` to the engine, so the committed card declared the weather
   layer blind on every game — including the 73 whose venue coordinates it was
   holding in memory at the time.

   This is that same call, through the recovery layer, so it gets a timeout,
   a per-host rate limit, retries on transient failures only, a shared cache
   and a budget. No new endpoint: the URL is copied from the board, and if the
   host refuses, the contract records FETCH_FAILED with the host and the
   reason rather than a silent null.

   A DOME IS NOT A FETCH. A venue the table marks indoor returns a
   neutralised forecast without a request, because the answer is known.
   ========================================================================== */
'use strict';
const path = require('path');
const R = require(path.join(__dirname, '..', 'data', 'recovery.js'));

const HOST = 'https://api.open-meteo.com/v1/forecast';

function urlFor(venue, kickIso) {
  const day = String(kickIso).slice(0, 10);
  return HOST + '?latitude=' + venue.lat + '&longitude=' + venue.lon
    + '&hourly=temperature_2m,precipitation,wind_speed_10m&temperature_unit=fahrenheit'
    + '&wind_speed_unit=mph&precipitation_unit=inch&timezone=UTC&start_date=' + day + '&end_date=' + day;
}

function parse(text, venue, kickIso) {
  let j;
  try { j = JSON.parse(text); } catch (_) { return null; }
  const h = j && j.hourly;
  if (!h || !h.time) return null;
  const want = Date.parse(kickIso);
  let best = -1, bd = 1e15;
  for (let i = 0; i < h.time.length; i++) {
    const d = Math.abs(Date.parse(h.time[i] + 'Z') - want);
    if (d < bd) { bd = d; best = i; }
  }
  /* A FORECAST FOUR HOURS FROM KICKOFF IS NOT THIS GAME'S WEATHER. */
  if (best < 0 || bd > 4 * 3600e3) return null;
  return {
    temp_f: h.temperature_2m[best], precip_in: h.precipitation[best],
    wind_mph: h.wind_speed_10m[best], dome: !!venue.dome,
    source: 'open-meteo forecast', as_of: new Date().toISOString()
  };
}

/* games: [{game_id, kickoff, venue}] — venue already resolved by the caller,
   so nothing here needs the parameter table. Returns {byGame, report}. */
async function fetchForGames(sess, games, opts) {
  opts = opts || {};
  const byGame = {};
  const report = { requested: 0, answered: 0, dome: 0, no_venue: 0, failed: 0, failures: {}, host: 'api.open-meteo.com' };
  const queue = [];
  for (const g of (games || [])) {
    if (!g || !g.kickoff) continue;
    if (!g.venue || g.venue.lat == null || g.venue.lon == null) { report.no_venue++; continue; }
    if (g.venue.dome) {
      byGame[String(g.game_id)] = { dome: true, temp_f: null, wind_mph: null, precip_in: null,
        source: 'trained venue table — indoor venue, no request made', as_of: new Date().toISOString() };
      report.dome++;
      continue;
    }
    queue.push(g);
  }
  /* BOUNDED CONCURRENCY, same reason the board bounds it: firing 150 requests
     at a keyless public API at once turns "weather" into "weather for the
     first forty games", which the engine reads as a missing input rather than
     as a throttle. */
  const lanes = Math.max(1, Math.min(opts.concurrency || 6, queue.length));
  let next = 0;
  async function worker() {
    while (next < queue.length) {
      const g = queue[next++];
      report.requested++;
      const r = await sess.get(urlFor(g.venue, g.kickoff), { timeout_ms: opts.timeout_ms || 15000, retries: 1 });
      if (!r.ok) {
        report.failed++;
        const k = r.status ? ('HTTP ' + r.status) : (r.error || 'unknown');
        report.failures[k] = (report.failures[k] || 0) + 1;
        continue;
      }
      const w = parse(r.text, g.venue, g.kickoff);
      if (w) { byGame[String(g.game_id)] = w; report.answered++; }
      else { report.failed++; report.failures['no hour within four hours of kickoff'] = (report.failures['no hour within four hours of kickoff'] || 0) + 1; }
    }
  }
  await Promise.all(Array.from({ length: lanes }, worker));
  report.summary = report.answered + ' of ' + report.requested + ' outdoor game(s) got a forecast; '
    + report.dome + ' indoor venue(s) needed none; ' + report.no_venue + ' had no coordinates to locate one; '
    + report.failed + ' request(s) failed'
    + (Object.keys(report.failures).length ? ' (' + Object.keys(report.failures).map(k => k + ' x' + report.failures[k]).join(', ') + ')' : '');
  return { byGame, report };
}

module.exports = { fetchForGames, urlFor, parse, HOST };
