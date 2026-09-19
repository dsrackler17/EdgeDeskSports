#!/usr/bin/env node
/* WeatherProvider — Open-Meteo historical reanalysis.

   THE ONE THING THIS ADAPTER EXISTS TO SAY OUT LOUD: the archive dates a match
   to its tournament WEEK, so the weather attached to it is a seven-day profile
   around an event, not conditions at first serve. Every row it emits carries
   temporal_precision = 'tournament_week' and nothing downstream may present it
   as match-time weather.

   It also refuses INDOOR events outright. Not with a null — with an explicit
   'indoor' precision, because a null would look like a gap somebody could
   later fill in. */
'use strict';
const P = require('./index.js');
const M = require('../../../lib/tennis_model.js');

module.exports = P.defineProvider({
  kind: 'weather',
  name: 'open_meteo',
  source_key: 'open-meteo',
  /* No key is needed for the free tier, and the free tier is NON-COMMERCIAL.
     A commercial plan issues a key; naming it here is what makes the licensed
     path a configuration change rather than a code change. */
  credentials: [],
  commercial_credential: 'OPEN_METEO_API_KEY',
  capabilities: {
    pre_match_features: false, serve_statistics: false, exact_start_time: false,
    live_score: false, closing_price: false, doubles: false
  },

  /* Venues that could carry weather and do not yet. Deliberately a DATABASE
     read: the network call is a separate, rate-limited job, and this is the
     part that is testable without one. */
  async pending(db, opts) {
    const o = opts || {};
    return db.rows(`
      select v.venue_id, v.latitude, v.longitude, v.timezone, v.environment,
             v.resolution_confidence, t.tournament_id, t.start_date, t.end_date, t.name
        from tennis.venues v
        join tennis.tournaments t on t.venue_id = v.venue_id
        left join tennis.weather_observations w
               on w.venue_id = v.venue_id and w.tournament_id = t.tournament_id
       where w.observation_id is null
         and v.environment = 'outdoor'
         and v.latitude is not null and v.longitude is not null
         and v.resolution_confidence in ('exact','high','name_inferred')
         and t.start_date is not null
       order by t.start_date desc
       limit ${Math.max(1, Math.min(o.limit || 200, 2000))}`);
  },

  /* Build the request URL for one venue-week. Separated from the fetch so the
     URL shape is testable with no network at all. */
  url(v) {
    const start = v.start_date, end = v.end_date || v.start_date;
    return 'https://archive-api.open-meteo.com/v1/archive'
      + '?latitude=' + encodeURIComponent(v.latitude)
      + '&longitude=' + encodeURIComponent(v.longitude)
      + '&start_date=' + encodeURIComponent(start)
      + '&end_date=' + encodeURIComponent(end)
      + '&daily=temperature_2m_mean,temperature_2m_max,temperature_2m_min,'
      + 'relative_humidity_2m_mean,precipitation_sum,wind_speed_10m_mean,'
      + 'wind_gusts_10m_max,shortwave_radiation_sum'
      + '&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch'
      + (v.timezone ? '&timezone=' + encodeURIComponent(v.timezone) : '');
  },

  /* Provider payload -> the normalised shape. Pure. */
  normalise(payload, v) {
    const d = (payload && payload.daily) || {};
    const days = (d.time || []).length;
    if (!days) {
      return { source_key: 'open-meteo', venue_ref: v.venue_id, tournament_ref: v.tournament_id,
               observed_on: v.start_date, temporal_precision: 'tournament_week',
               quality: 'unusable', unmapped: ['daily'], days_covered: 0 };
    }
    const avg = (a) => M.mean((a || []).map(M.num));
    const max = (a) => { const xs = (a || []).map(M.num).filter((x) => x != null); return xs.length ? Math.max.apply(null, xs) : null; };
    const min = (a) => { const xs = (a || []).map(M.num).filter((x) => x != null); return xs.length ? Math.min.apply(null, xs) : null; };
    const sum = (a) => { const xs = (a || []).map(M.num).filter((x) => x != null); return xs.length ? xs.reduce((p, q) => p + q, 0) : null; };
    return {
      source_key: 'open-meteo',
      venue_ref: v.venue_id, tournament_ref: v.tournament_id,
      observed_on: v.start_date, window_start: v.start_date, window_end: v.end_date || v.start_date,
      /* NOT 'daily'. The match is dated to the week, so even daily readings can
         only be attributed to the week the match sits in. */
      temporal_precision: 'tournament_week',
      temp_mean_f: M.round(avg(d.temperature_2m_mean), 2),
      temp_max_f: M.round(max(d.temperature_2m_max), 2),
      temp_min_f: M.round(min(d.temperature_2m_min), 2),
      humidity_mean_pct: M.round(avg(d.relative_humidity_2m_mean), 2),
      precip_in: M.round(sum(d.precipitation_sum), 3),
      wind_mean_mph: M.round(avg(d.wind_speed_10m_mean), 2),
      gust_max_mph: M.round(max(d.wind_gusts_10m_max), 2),
      solar_mj_m2: M.round(sum(d.shortwave_radiation_sum), 3),
      days_covered: days,
      venue_confidence: v.resolution_confidence,
      quality: days >= 5 ? 'usable' : (days >= 3 ? 'low' : 'unusable'),
      unmapped: []
    };
  },

  describe() {
    return { name: 'open_meteo', coverage: 'daily reanalysis at a venue, summarised over the tournament week',
             grain: 'one row per venue per event', licence: 'free tier is NON-COMMERCIAL; a plan is required for a paid surface',
             not_carried: ['conditions at first serve', 'court-level microclimate', 'indoor venues (excluded by design)'] };
  }
});
