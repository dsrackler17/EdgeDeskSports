/* ============================================================================
   THE GAME-TIME FORECAST — one implementation, for the page and the build.

   WHY THIS FILE EXISTS. The forecast was written twice: `fbP4Weather()` in
   app.html for the browser and `urlFor`/`parse` in football/matchup/weather.js
   for the offline builder. Both asked open-meteo for three variables at one
   hour, in UTC, and both threw away everything else the answer carried. Two
   implementations of one contract is how the board and the committed artifact
   come to disagree, so it lives here once and both callers load it.

   WHAT CHANGED, AND WHY IT IS NOT DECORATION. A projection reads the
   temperature, the wind and the rain at kickoff. A PERSON reads a game the way
   a broadcast does: what it will be like at kick, and what it will be like in
   the fourth quarter. Those are different questions and the second one is the
   one that gets answered wrong by a single number — a 77° kickoff that is 72°
   and raining by the end is not a 77° game. So this fetches the hour the game
   kicks off in and the three that follow it, with the variables a person
   actually asks about: what it feels like, whether it will rain rather than
   only how much, the gusts rather than only the average, and the humidity
   that turns 77° into 84°.

   VENUE LOCAL, AND THAT MEANS DST. The trained venue table carries `tz` as a
   fixed UTC offset (-5 for Pittsburgh). On September 17th Pittsburgh is on
   -4, so labelling the hours from that column would print a 7:30 PM kickoff
   as a 6 PM row for half the season. open-meteo resolves the zone from the
   coordinates when asked with `timezone=auto`, so the hours come back already
   local and already correct, and `utc_offset_seconds` comes back with them —
   which is also what makes the absolute match below exact rather than
   approximate.

   A DOME IS NOT A FETCH, and it is not a gap either: the answer is known, so
   an indoor venue returns a neutralised forecast with no request made and the
   card says ROOF rather than showing four identical rows of nothing.
   ========================================================================== */
(function (root, factory) {
  var api = factory();
  root.EDForecast = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var HOST = 'https://api.open-meteo.com/v1/forecast';

  /* the hour the game kicks off in, plus this many after it. Four rows is a
     football game: kick, the middle two quarters, and the finish. */
  var HOURS_AFTER = 3;

  /* every variable the card reads, and nothing it does not. Each one is here
     because something on the card would otherwise be a guess:
       apparent_temperature      "feels like", which is the number people feel
       precipitation_probability WHETHER it rains, not only how much
       wind_gusts_10m            the gust, which is what moves a kick
       relative_humidity_2m      why 77 feels like 84
       weather_code              the icon, from the provider rather than
                                 reverse-engineered from millimetres
       is_day                    sun or moon beside the hour */
  var HOURLY = ['temperature_2m', 'apparent_temperature', 'precipitation',
    'precipitation_probability', 'relative_humidity_2m', 'wind_speed_10m',
    'wind_gusts_10m', 'wind_direction_10m', 'weather_code', 'is_day'];

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function ymd(ms) {
    var d = new Date(ms);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }

  /* A THREE-DAY WINDOW, ASKED IN UTC DAYS, READ IN LOCAL HOURS. `timezone=auto`
     makes start_date/end_date mean LOCAL days, and the local day of a kickoff
     is not knowable until the offset comes back — which arrives in the same
     response. Asking for the day either side costs seventy-two rows and
     removes the circularity entirely. */
  function urlFor(venue, kickIso) {
    var t = Date.parse(kickIso);
    if (!venue || venue.lat == null || venue.lon == null || !isFinite(t)) return null;
    return HOST + '?latitude=' + venue.lat + '&longitude=' + venue.lon
      + '&hourly=' + HOURLY.join(',')
      + '&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch'
      + '&timezone=auto'
      + '&start_date=' + ymd(t - 86400e3) + '&end_date=' + ymd(t + 86400e3);
  }

  /* ---- how a number becomes a word ------------------------------------- */

  /* Sustained wind, not gusts. A 5 mph field with an 11 mph gust is a calm
     night that occasionally puffs, and calling it "breezy" off the gust would
     describe a different game. */
  function windWord(mph) {
    if (mph == null || !isFinite(mph)) return null;
    if (mph < 6) return 'CALM';
    if (mph < 12) return 'LIGHT';
    if (mph < 18) return 'BREEZY';
    if (mph < 25) return 'WINDY';
    return 'STRONG';
  }

  /* Meteorological direction is where the wind comes FROM; the arrow points
     where it is going. Both are published so neither has to be inferred. */
  var ARROWS = ['↓', '↙', '←', '↖', '↑', '↗', '→', '↘'];
  var POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  function dirArrow(deg) {
    if (deg == null || !isFinite(deg)) return null;
    return ARROWS[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
  }
  function dirFrom(deg) {
    if (deg == null || !isFinite(deg)) return null;
    return POINTS[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
  }

  /* WMO codes, as the provider publishes them. The icon is not guessed from
     the precipitation column: 0.0 inches of snow and 0.0 inches of clear sky
     are the same number and a different game. */
  function codeText(code) {
    var c = +code;
    if (c === 0) return 'Clear';
    if (c === 1) return 'Mostly clear';
    if (c === 2) return 'Partly cloudy';
    if (c === 3) return 'Overcast';
    if (c === 45 || c === 48) return 'Fog';
    if (c >= 51 && c <= 57) return 'Drizzle';
    if (c >= 61 && c <= 65) return 'Rain';
    if (c === 66 || c === 67) return 'Freezing rain';
    if (c >= 71 && c <= 75) return 'Snow';
    if (c === 77) return 'Snow grains';
    if (c >= 80 && c <= 82) return 'Showers';
    if (c === 85 || c === 86) return 'Snow showers';
    if (c >= 95) return 'Thunderstorm';
    return null;
  }
  function iconFor(code, isDay) {
    var c = +code, day = (isDay == null) ? 1 : +isDay;
    if (c === 0) return day ? '☀️' : '🌙';
    if (c === 1) return day ? '🌤️' : '🌙';
    if (c === 2) return day ? '⛅' : '☁️';
    if (c === 3) return '☁️';
    if (c === 45 || c === 48) return '🌫️';
    if (c >= 51 && c <= 57) return '🌦️';
    if ((c >= 61 && c <= 65) || (c >= 80 && c <= 82)) return '🌧️';
    if (c === 66 || c === 67) return '🌨️';
    if ((c >= 71 && c <= 77) || c === 85 || c === 86) return '🌨️';
    if (c >= 95) return '⛈️';
    return '☁️';
  }

  /* "2026-09-17T19:00" -> "7 PM". The string is already venue-local, so this
     formats rather than converts — there is no second chance to get a zone
     wrong here. */
  function hourLabel(localIso) {
    var m = /T(\d{2}):/.exec(String(localIso || ''));
    if (!m) return null;
    var h = +m[1];
    var ampm = h < 12 ? 'AM' : 'PM';
    var h12 = h % 12; if (h12 === 0) h12 = 12;
    return h12 + ' ' + ampm;
  }

  /* ---- the answer ------------------------------------------------------ */

  function num(v) { return (v == null || v === '' || !isFinite(+v)) ? null : +v; }

  /* Returns null when the provider did not answer about THIS kickoff. The
     engine-facing keys (temp_f, wind_mph, precip_in, dome, as_of, source) are
     unchanged, so nothing downstream has to know this got richer. */
  function parse(text, venue, kickIso, opts) {
    opts = opts || {};
    var j;
    try { j = (typeof text === 'string') ? JSON.parse(text) : text; } catch (_) { return null; }
    var h = j && j.hourly;
    if (!h || !h.time || !h.time.length) return null;
    var want = Date.parse(kickIso);
    if (!isFinite(want)) return null;
    var off = (typeof j.utc_offset_seconds === 'number') ? j.utc_offset_seconds : 0;

    /* local hour strings -> absolute instants, so the match is exact */
    var abs = [];
    for (var i = 0; i < h.time.length; i++) abs.push(Date.parse(h.time[i] + 'Z') - off * 1000);

    /* THE HOUR THE GAME KICKS OFF IN, not the nearest one. A 7:30 kickoff
       belongs to the 7 PM row the way a broadcast does; rounding it to 8 PM
       would label the pregame as the game. */
    var at = -1;
    for (var k = 0; k < abs.length; k++) {
      if (abs[k] <= want && (k + 1 >= abs.length || abs[k + 1] > want)) { at = k; break; }
    }
    if (at < 0) {
      var bd = Infinity;
      for (var n = 0; n < abs.length; n++) {
        var d = Math.abs(abs[n] - want);
        if (d < bd) { bd = d; at = n; }
      }
      if (at < 0) return null;
    }
    /* A FORECAST FOUR HOURS FROM KICKOFF IS NOT THIS GAME'S WEATHER, and the
       guard belongs on BOTH paths. The containing-hour search above treats the
       LAST row as containing everything after it — there is no next row to be
       greater than the kickoff — so a response for Thursday matched Saturday's
       game at its final hour and reported it as that game's weather. */
    if (Math.abs(abs[at] - want) > 4 * 3600e3) return null;

    var hours = [];
    for (var q = at; q < Math.min(abs.length, at + 1 + HOURS_AFTER); q++) {
      var code = num(h.weather_code ? h.weather_code[q] : null);
      var isDay = h.is_day ? num(h.is_day[q]) : null;
      hours.push({
        local: h.time[q],
        at: new Date(abs[q]).toISOString(),
        label: hourLabel(h.time[q]),
        temp_f: num(h.temperature_2m[q]),
        feels_f: num(h.apparent_temperature ? h.apparent_temperature[q] : null),
        precip_in: num(h.precipitation ? h.precipitation[q] : null),
        precip_pct: num(h.precipitation_probability ? h.precipitation_probability[q] : null),
        humidity_pct: num(h.relative_humidity_2m ? h.relative_humidity_2m[q] : null),
        wind_mph: num(h.wind_speed_10m[q]),
        gust_mph: num(h.wind_gusts_10m ? h.wind_gusts_10m[q] : null),
        wind_dir_deg: num(h.wind_direction_10m ? h.wind_direction_10m[q] : null),
        wind_from: dirFrom(num(h.wind_direction_10m ? h.wind_direction_10m[q] : null)),
        wind_arrow: dirArrow(num(h.wind_direction_10m ? h.wind_direction_10m[q] : null)),
        code: code, text: codeText(code), icon: iconFor(code, isDay), is_day: isDay
      });
    }
    if (!hours.length) return null;
    var k0 = hours[0];

    return {
      /* --- what the engine has always read, unchanged --- */
      temp_f: k0.temp_f, wind_mph: k0.wind_mph, precip_in: k0.precip_in,
      dome: !!(venue && venue.dome),
      source: 'open-meteo forecast', as_of: opts.as_of || new Date().toISOString(),

      /* --- what the card reads --- */
      kickoff_local: k0.local, kickoff_label: k0.label,
      timezone: j.timezone || null, tz_abbrev: j.timezone_abbreviation || null,
      utc_offset_seconds: off,
      feels_f: k0.feels_f, humidity_pct: k0.humidity_pct, gust_mph: k0.gust_mph,
      precip_pct: k0.precip_pct, code: k0.code, text: k0.text, icon: k0.icon,
      wind_word: windWord(k0.wind_mph), wind_from: k0.wind_from, wind_arrow: k0.wind_arrow,
      hours: hours
    };
  }

  /* An indoor venue, answered without a request. Not a gap and not a fetch. */
  function forDome(venue, opts) {
    opts = opts || {};
    return { dome: true, temp_f: null, wind_mph: null, precip_in: null,
      roof: true, hours: [],
      source: opts.source || 'trained venue table — indoor venue, no request made',
      as_of: opts.as_of || new Date().toISOString() };
  }

  /* ---- the view model both renderers read ------------------------------
     Built here rather than in the page so the card, the brief and any export
     describe the same game the same way. Returns null when there is nothing
     honest to draw. */
  function card(w, venue) {
    venue = venue || {};
    var chips = [];
    if (venue.grass === true) chips.push({ kind: 'surface', text: 'GRASS', icon: '🌱' });
    else if (venue.grass === false) chips.push({ kind: 'surface', text: 'TURF', icon: '▦' });
    chips.push(venue.dome ? { kind: 'roof', text: 'INDOOR', icon: '🏟️' }
      : { kind: 'roof', text: 'OPEN AIR', icon: '☁️' });

    var facts = [];
    /* the table stores elevation in metres; the card has always spoken feet */
    if (venue.elev != null && isFinite(venue.elev)) facts.push({ kind: 'elev', icon: '▲',
      text: Math.round(venue.elev * 3.28084) + ' ft' });
    if (venue.capacity != null && isFinite(venue.capacity) && venue.capacity > 0) facts.push({ kind: 'capacity',
      icon: '👥', text: '≈' + Math.round(venue.capacity / 1000) + 'k' });

    var head = { name: venue.name || null, city: venue.city || null, chips: chips, facts: facts };
    if (!w) return { venue: head, state: 'NONE', hours: [], conditions: null, note: null };
    if (w.dome) {
      return { venue: head, state: 'INDOOR', hours: [], conditions: null,
        note: (venue.name || 'This venue') + ' is indoors — kickoff conditions are the same in every hour.' };
    }
    var cond = [];
    if (w.wind_word) cond.push(w.wind_word);
    if (w.gust_mph != null) cond.push('gusts ' + Math.round(w.gust_mph) + ' mph');
    if (w.humidity_pct != null) cond.push(Math.round(w.humidity_pct) + '% humidity');
    return {
      venue: head,
      state: w.carried ? 'CARRIED' : 'LIVE',
      conditions: cond.length ? cond.join(' · ') : null,
      hours: w.hours || [],
      note: (w.feels_f != null && w.temp_f != null && Math.abs(w.feels_f - w.temp_f) >= 2)
        ? ('Feels like ' + Math.round(w.feels_f) + '° at kickoff.') : null,
      observed_at: w.as_of || null,
      carried: !!w.carried,
      tz: w.tz_abbrev || w.timezone || null
    };
  }

  return { HOST: HOST, HOURLY: HOURLY, HOURS_AFTER: HOURS_AFTER,
    urlFor: urlFor, parse: parse, forDome: forDome, card: card,
    windWord: windWord, dirArrow: dirArrow, dirFrom: dirFrom,
    codeText: codeText, iconFor: iconFor, hourLabel: hourLabel };
});
