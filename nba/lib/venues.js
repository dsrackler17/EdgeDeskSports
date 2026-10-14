'use strict';
/* ===========================================================================
   EdgeDesk NBA — where games are played: city coordinates, a standard UTC
   offset and altitude, for travel distance, time-zone shifts and altitude.

   Keyed by the city the source gives for the venue (ESPN venue_address_city).
   Coordinates are the arena's to about 1 km (public geography); `tz` is the
   standard-time UTC offset in hours (DST moves every North American city
   together except Phoenix, a one-hour difference this table ignores);
   `alt` is the arena's elevation in metres. A game with no city falls back to
   the home team's most common home city that season (computed from data in
   nba/ingest/season.js, never assumed).
   =========================================================================== */
const CITIES = {
  'Atlanta': [33.757, -84.396, -5, 320], 'Austin': [30.270, -97.740, -6, 150], 'Berlin': [52.507, 13.443, 1, 34],
  'Boston': [42.366, -71.062, -5, 5], 'Brooklyn': [40.683, -73.976, -5, 10], 'Charlotte': [35.225, -80.839, -5, 230],
  'Chicago': [41.881, -87.674, -6, 180], 'Cleveland': [41.496, -81.688, -5, 200], 'Dallas': [32.790, -96.810, -6, 140],
  'Denver': [39.749, -105.008, -7, 1609], 'Detroit': [42.341, -83.055, -5, 190], 'Auburn Hills': [42.697, -83.245, -5, 290],
  'East Rutherford': [40.812, -74.071, -5, 5], 'Houston': [29.751, -95.362, -6, 15], 'Indianapolis': [39.764, -86.155, -5, 220],
  'Inglewood': [33.945, -118.343, -8, 30], 'Lake Buena Vista': [28.337, -81.556, -5, 30], 'Las Vegas': [36.103, -115.178, -8, 620],
  'London': [51.503, 0.003, 0, 10], 'Los Angeles': [34.043, -118.267, -8, 90], 'Manchester': [53.488, -2.244, 0, 40],
  'Memphis': [35.138, -90.051, -6, 80], 'Mexico City': [19.404, -99.096, -6, 2240], 'Miami': [25.781, -80.187, -5, 2],
  'Milwaukee': [43.045, -87.917, -6, 190], 'Minneapolis': [44.980, -93.276, -6, 260], 'New Orleans': [29.949, -90.082, -6, 2],
  'New York': [40.751, -73.993, -5, 10], 'Newark': [40.734, -74.171, -5, 10], 'Oakland': [37.750, -122.203, -8, 5],
  'Oklahoma City': [35.463, -97.515, -6, 365], 'Orlando': [28.539, -81.384, -5, 30], 'Paris': [48.839, 2.379, 1, 35],
  'Philadelphia': [39.901, -75.172, -5, 10], 'Phoenix': [33.446, -112.071, -7, 340], 'Portland': [45.532, -122.667, -8, 15],
  'Sacramento': [38.580, -121.500, -8, 10], 'Salt Lake City': [40.768, -111.901, -7, 1288], 'San Antonio': [29.427, -98.438, -6, 200],
  'San Francisco': [37.768, -122.388, -8, 5], 'Seattle': [47.622, -122.354, -8, 50], 'Tampa': [27.943, -82.452, -5, 5],
  'Toronto': [43.643, -79.379, -5, 80], 'Washington': [38.898, -77.021, -5, 20], 'Kansas City': [39.097, -94.580, -6, 270],
  'Vancouver': [49.278, -123.109, -8, 10], 'Abu Dhabi': [24.537, 54.398, 4, 5], 'Tokyo': [35.630, 139.880, 9, 5],
  'Cincinnati': [39.097, -84.505, -5, 150], 'Uniondale': [40.723, -73.590, -5, 30], 'Montreal': [45.496, -73.569, -5, 40],
};

function geo(city) { const c = CITIES[city]; return c ? { city, lat: c[0], lon: c[1], tz: c[2], alt: c[3] } : null; }

/** great-circle distance in km */
function km(a, b) {
  if (!a || !b) return null;
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

module.exports = { CITIES, geo, km };
