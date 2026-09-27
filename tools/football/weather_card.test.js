#!/usr/bin/env node
/* ============================================================================
   THE GAME-TIME FORECAST CARD, AND THE THINGS IT MUST NOT SAY.

   The weather layer held four numbers and showed a reader none of them; the
   venue table held eight more — surface, roof, elevation, capacity — and
   showed none either. So the only sentence the card could produce about a
   stadium whose seating capacity it knew was "the weather layer is blind at
   that venue".

   This holds the card that replaced it, and it holds it in three places at
   once, because a renderer that is only correct inside a 3.6 MB page cannot
   be checked:

     1  the PARSER, against a provider response built to reproduce a real
        kickoff — the hour a 7:30 game belongs to is the 7 PM row, not the
        8 PM one, and the local hours must survive daylight saving
     2  the VIEW MODEL, which both the page and any export read, so the two
        cannot describe the same stadium differently
     3  the RENDERER, sliced out of app.html and executed, so a card that
        throws or silently prints nothing fails here

   AND THE RULES IT ENFORCES. No forecast is never drawn as good weather; a
   dome is answered rather than left blank; a carried forecast says it was
   carried and states its real age; and the three different reasons a
   forecast can be absent stay three different sentences.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
const F = require(path.join(ROOT, 'football', 'matchup', 'forecast.js'));

let checks = 0, failures = 0;
function ok(cond, what) { checks++; if (cond) return; failures++; console.error('  FAIL: ' + what); }
function eq(a, b, what) { ok(a === b, what + ' (got ' + JSON.stringify(a) + ', wanted ' + JSON.stringify(b) + ')'); }
function has(hay, needle, what) { ok(String(hay).indexOf(needle) >= 0, what + ' — missing ' + JSON.stringify(needle)); }
function hasNot(hay, needle, what) { ok(String(hay).indexOf(needle) < 0, what + ' — should not contain ' + JSON.stringify(needle)); }
function section(t) { console.log('\n' + t); }

function fnSrc(name) {
  const at = APP.indexOf('function ' + name + '(');
  if (at < 0) { console.error('FAIL | app.html no longer defines ' + name); process.exit(1); }
  const end = APP.indexOf('\n}\n', at);
  return APP.slice(at, end + 3);
}

/* ---- a provider answer for a real kickoff ------------------------------
   Pittsburgh, 17 September 2026, 7:30 PM ET. September is DAYLIGHT TIME, so
   the venue table's fixed `tz: -5` would put this game an hour earlier than
   it kicks; the provider's own `utc_offset_seconds` is what makes it right. */
const KICK = '2026-09-17T23:30:00Z';
const VENUE = { name: 'Acrisure Stadium', city: 'Pittsburgh, PA', lat: 40.4468, lon: -80.0158,
  elev: 222.5, capacity: 68400, dome: false, grass: true, tz: -5 };
function providerBody(over) {
  over = over || {};
  const byHour = Object.assign({
    19: [77, 84, 0.02, 56, 92, 5, 11, 315, 61, 1],
    20: [75, 80, 0, 36, 90, 4, 9, 315, 3, 0],
    21: [74, 78, 0, 38, 88, 3, 8, 315, 3, 0],
    22: [72, 75, 0, 39, 86, 3, 8, 315, 3, 0]
  }, over.byHour || {});
  const time = [], cols = [[], [], [], [], [], [], [], [], [], []];
  for (let h = 0; h <= 23; h++) {
    time.push('2026-09-17T' + String(h).padStart(2, '0') + ':00');
    const v = byHour[h] || [64, 64, 0, 8, 70, 4, 8, 315, 1, h >= 7 && h < 19 ? 1 : 0];
    for (let c = 0; c < 10; c++) cols[c].push(v[c]);
  }
  return JSON.stringify({
    timezone: 'America/New_York', timezone_abbreviation: 'EDT',
    utc_offset_seconds: over.offset === undefined ? -14400 : over.offset,
    hourly: { time: time, temperature_2m: cols[0], apparent_temperature: cols[1],
      precipitation: cols[2], precipitation_probability: cols[3], relative_humidity_2m: cols[4],
      wind_speed_10m: cols[5], wind_gusts_10m: cols[6], wind_direction_10m: cols[7],
      weather_code: cols[8], is_day: cols[9] }
  });
}

/* ═══ 1. the parser ══════════════════════════════════════════════════════ */
section('1. the provider answer becomes this game’s weather');
const W = F.parse(providerBody(), VENUE, KICK);
ok(!!W, 'a well-formed answer parses');
eq(W.kickoff_label, '7 PM', 'a 7:30 kickoff belongs to the 7 PM hour, not the nearest one');
eq(W.hours.length, 4, 'the strip is the kickoff hour and the three after it');
eq(W.hours.map(h => h.label).join(','), '7 PM,8 PM,9 PM,10 PM', 'and they run forward in venue-local time');
eq(W.tz_abbrev, 'EDT', 'the zone is the provider’s, which is the one that knows about daylight saving');
eq(W.temp_f, 77, 'the engine-facing temperature is the kickoff hour');
eq(W.wind_mph, 5, 'and so is the wind');
eq(W.precip_in, 0.02, 'and the precipitation');
eq(W.dome, false, 'and the dome flag comes from the venue, not the forecast');
eq(W.feels_f, 84, 'apparent temperature is carried: 77° at 92% humidity is an 84° game');
eq(W.humidity_pct, 92, 'humidity is carried, which is WHY it feels like 84');
eq(W.gust_mph, 11, 'the gust is carried separately from the average');
eq(W.wind_word, 'CALM', 'and a 5 mph field is CALM even with an 11 mph gust');
eq(W.precip_pct, 56, 'the probability of rain is carried, not only the amount');
eq(W.icon, '🌧️', 'the icon comes from the provider’s weather code');

/* DAYLIGHT SAVING IS THE WHOLE POINT OF timezone=auto. Re-read the same
   response as if the venue were on standard time and the labels must move. */
const Wstd = F.parse(providerBody({ offset: -18000 }), VENUE, KICK);
eq(Wstd.kickoff_label, '6 PM', 'the same instant on standard time is a 6 PM kickoff — the offset is read, never assumed');

/* ═══ 2. what it refuses ═════════════════════════════════════════════════ */
section('2. what the parser refuses to answer');
ok(F.parse('not json', VENUE, KICK) === null, 'a body that is not JSON is not a forecast');
ok(F.parse(JSON.stringify({ hourly: {} }), VENUE, KICK) === null, 'an answer with no hours is not a forecast');
/* A FORECAST FOUR HOURS FROM KICKOFF IS NOT THIS GAME'S WEATHER. */
ok(F.parse(providerBody(), VENUE, '2026-09-19T23:30:00Z') === null,
  'an answer covering a different day is refused rather than stretched to fit');
eq(F.urlFor({ lat: null, lon: null }, KICK), null, 'a venue with no coordinates produces no request at all');

/* ═══ 3. the view model ══════════════════════════════════════════════════ */
section('3. the view model both renderers read');
const C = F.card(W, VENUE);
eq(C.state, 'LIVE', 'an observed forecast is live');
eq(C.conditions, 'CALM · gusts 11 mph · 92% humidity', 'the conditions line reads as a person would say it');
eq(C.note, 'Feels like 84° at kickoff.', 'and the feels-like line appears when it differs from the temperature');
eq(C.venue.chips.map(c => c.text).join(','), 'GRASS,OPEN AIR', 'surface and roof are chips');
eq(C.venue.facts.map(f => f.text).join(','), '730 ft,≈68k', 'elevation converts metres to feet; capacity rounds to thousands');
/* A DOME IS AN ANSWER, NOT A GAP. */
const dome = F.card(F.forDome({ name: 'Alamodome', dome: true }), { name: 'Alamodome', dome: true, grass: false });
eq(dome.state, 'INDOOR', 'an indoor venue is INDOOR, never "missing"');
eq(dome.hours.length, 0, 'and draws no hourly strip');
has(dome.venue.chips.map(c => c.text).join(','), 'INDOOR', 'and says INDOOR on the chip');
has(dome.venue.chips.map(c => c.text).join(','), 'TURF', 'and still reports the surface');
/* NOTHING AT ALL IS NOT GOOD WEATHER. */
const none = F.card(null, VENUE);
eq(none.state, 'NONE', 'no forecast is NONE');
eq(none.hours.length, 0, 'and has no hours to draw');
eq(none.conditions, null, 'and states no conditions');
/* A CARRY IS VISIBLE AND KEEPS ITS OWN AGE. */
const carried = F.card(Object.assign({}, W, { carried: true, as_of: '2026-09-14T10:00:00Z' }), VENUE);
eq(carried.state, 'CARRIED', 'a carried forecast is marked carried');
eq(carried.observed_at, '2026-09-14T10:00:00Z', 'and reports the moment it was ACTUALLY observed, not now');

/* ═══ 4. the renderer, executed ══════════════════════════════════════════ */
section('4. the renderer, sliced out of app.html and run');
function render(weather, venue, gameOver) {
  const sandbox = {
    window: { EDForecast: F, EDCfbP4Params: { universe: { venues: venue ? { pitt: venue } : {} } },
      EDFbs: { normKey: () => 'pitt' } },
    FB: { p4: { weather: weather ? { 'g1': weather } : {} } },
    fbEsc: (x) => String(x == null ? '' : x).replace(/[&<>"]/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    console: console
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fnSrc('fbGxWxTempClass') + '\n' + fnSrc('fbGxWeather'), sandbox);
  const g = Object.assign({ game_id: 'g1', home_team: 'Pittsburgh', venue: 'Acrisure Stadium' }, gameOver || {});
  return sandbox.fbGxWeather({ g: g });
}
const html = render(W, VENUE);
ok(!!html, 'the card renders something');
has(html, 'Acrisure Stadium', 'it names the stadium');
has(html, 'Pittsburgh, PA', 'and the city');
has(html, 'GRASS', 'the surface chip is drawn');
has(html, 'OPEN AIR', 'the roof chip is drawn');
has(html, '730 ft', 'the elevation is drawn in feet');
has(html, '≈68k', 'the capacity is drawn');
has(html, 'CALM', 'the conditions line leads with the wind word');
has(html, 'gusts 11 mph', 'and carries the gust');
has(html, '92% humidity', 'and the humidity');
has(html, '7 PM', 'the strip starts at the kickoff hour');
has(html, '10 PM', 'and runs to the fourth quarter');
has(html, '77°', 'the kickoff temperature is on the strip');
has(html, '72°', 'and so is the last hour, which is where a total goes wrong');
has(html, '☔ 56%', 'the chance of rain is drawn');
has(html, 'Feels like 84° at kickoff.', 'and the feels-like line closes the card');
has(html, 'venue local', 'the strip says the hours are venue-local');
has(html, '(EDT)', 'and names the zone it is using');
has(html, 'class="tp warm"', '77° is drawn warm');
has(html, 'class="tp mild"', 'and 72° is drawn mild');

section('5. and what it renders when there is nothing to draw');
const noWx = render(null, VENUE);
has(noWx, 'Acrisure Stadium', 'a venue with no forecast still describes the stadium');
has(noWx, 'No game-time forecast', 'and says plainly that there is none');
has(noWx, 'no forecast has been retrieved', 'naming WHICH of the three reasons applies');
has(noWx, 'widens its outcome range', 'and what the engine does about it');
hasNot(noWx, '☔', 'it draws no precipitation it does not have');
hasNot(noWx, 'Feels like', 'and no feels-like it cannot compute');

const noVenue = render(null, null);
eq(noVenue, '', 'no venue and no forecast renders nothing at all rather than an empty shell');

const domeHtml = render(F.forDome({ name: 'Alamodome', dome: true }), { name: 'Alamodome', dome: true, grass: false, capacity: 64000 });
has(domeHtml, 'INDOOR', 'a dome says INDOOR');
has(domeHtml, 'same in every hour', 'and explains why there is no strip');
hasNot(domeHtml, 'gx-wxrow', 'and draws no hourly strip');
hasNot(domeHtml, 'No game-time forecast', 'a dome is never reported as a missing forecast');

const carriedHtml = render(Object.assign({}, W, { carried: true, as_of: '2026-09-14T10:00:00Z' }), VENUE);
has(carriedHtml, 'Carried forward', 'a carried forecast says so on the card');
has(carriedHtml, '2026-09-14 10:00 UTC', 'at the time it was actually observed');

/* ═══ 6. the page and the build describe the same stadium the same way ═══
   THE BUG THIS CATCHES, found on the live site. The page reads the trained
   venue table straight out of params.js. That table carries coordinates,
   elevation, capacity, roof and surface — everything the model was fitted on
   — and NO CITY AT ALL. The offline build fills the city from
   football/venues/resolved.json in its loader; the browser has no such
   loader, so the card in the page said "Acrisure Stadium" while the committed
   slate said "Acrisure Stadium, Pittsburgh, PA" about the same game.

   That is the same drift football/matchup/forecast.js exists to end one level
   down: one contract, two implementations, and a reader who cannot tell which
   is right. football/venues/descriptions.js closes it, and this holds it
   closed — on the REAL renderer, against the REAL trained table. */
section('6. the page names the same stadium the build names');
{
  global.window = global.window || global;
  require(path.join(ROOT, 'football', 'cfb_p4', 'params.js'));
  const PARAMS = global.window.EDCfbP4Params;
  const TRAINED = (PARAMS && PARAMS.universe && PARAMS.universe.venues) || {};
  let TEXT = null;
  try { TEXT = require(path.join(ROOT, 'football', 'venues', 'descriptions.js')); } catch (_) { TEXT = null; }
  ok(!!TEXT, 'football/venues/descriptions.js exists and loads');
  ok(TEXT && Object.keys(TEXT).length > 100, 'and covers the FBS field, not a handful');

  /* the trained table is the thing that lacks a city — if it ever gains one,
     this whole layer is unnecessary and should be deleted rather than kept */
  const trainedHasCity = Object.keys(TRAINED).some(k => TRAINED[k] && TRAINED[k].city);
  ok(!trainedHasCity, 'the trained table still carries no city, which is why this layer exists');

  /* NO COORDINATE, ROOF OR SURFACE may travel through the description map:
     those are what the venue coefficients were fitted on. */
  const FORBIDDEN = ['lat', 'lon', 'elev', 'capacity', 'dome', 'grass'];
  const leaked = Object.keys(TEXT || {}).filter(k => FORBIDDEN.some(f => TEXT[k] && TEXT[k][f] !== undefined));
  eq(leaked.length, 0, 'and it restates no coordinate, roof, surface, elevation or capacity');

  /* the renderer, run exactly as the page runs it */
  const FBS = require(path.join(ROOT, 'football', 'fbs', 'fbs.js'));
  function renderAsPage(teamName, weather) {
    const sandbox = {
      window: { EDForecast: F, EDCfbP4Params: PARAMS, EDFbs: FBS, EDVenueText: TEXT },
      FB: { p4: { weather: weather ? { g1: weather } : {} } },
      fbEsc: (x) => String(x == null ? '' : x).replace(/[&<>"]/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
      console: console
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(fnSrc('fbGxWxTempClass') + '\n' + fnSrc('fbGxWeather'), sandbox);
    return sandbox.fbGxWeather({ g: { game_id: 'g1', home_team: teamName } });
  }
  const pitt = renderAsPage('Pittsburgh', null);
  has(pitt, 'Acrisure Stadium', 'the page names the stadium');
  has(pitt, 'Pittsburgh, PA', 'AND the town it is in — the line that was missing on the live site');
  has(pitt, '724 ft', 'elevation still comes from the trained table');
  has(pitt, '≈68k', 'and so does capacity');

  /* every home venue the published slate needs must name a town, or the card
     is back to a stadium floating in no particular place */
  let slate = null;
  try { slate = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'fbs', 'slate.json'), 'utf8')); }
  catch (_) { /* no slate on disk */ }
  if (slate && slate.games && slate.games.length) {
    const nameless = [];
    slate.games.forEach(g => {
      const k = FBS.normKey(g.home_team);
      const v = TRAINED[k];
      if (!v) return;
      const city = (v.city != null && v.city !== '') ? v.city : ((TEXT && TEXT[k]) ? TEXT[k].city : null);
      if (!city) nameless.push(g.home_team);
    });
    eq(nameless.length, 0, 'every home venue on the published slate can say what town it is in'
      + (nameless.length ? ' (' + nameless.slice(0, 5).join(', ') + ')' : ''));
  }
}

console.log('\n' + (failures ? 'FAILED ' + failures + ' of ' + checks
  : 'weather card: ' + checks + ' passed, 0 failed'));
process.exit(failures ? 1 : 0);
