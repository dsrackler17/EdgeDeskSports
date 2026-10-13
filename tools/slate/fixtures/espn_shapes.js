'use strict';
/* ===========================================================================
   ESPN scoreboard payloads, CONSTRUCTED for the slate's tests.

   These are not recordings. They follow the shape ESPN's public scoreboard
   returns (events[] → competitions[] → competitors[] / status / odds[] /
   venue / notes), the same shape the repository's recorded fixtures carry
   (football/cfb_lab/fixtures/providers/espn_scoreboard_pregame.json,
   tools/ufc/fixtures/scoreboard_sample.json), with every field the slate
   reads and the variants it must survive: a neutral site, a doubleheader, a
   postponement, a draw price, a live clock, a card of bouts, a one-sided
   price, a consensus quote. The real feed is checked by
   `node tools/slate/build.js --verify` on a runner that can reach it.
   =========================================================================== */
function team(abbr, name, short, id, logo) {
  return { id: String(id || abbr), abbreviation: abbr, displayName: name, shortDisplayName: short || name.split(' ').slice(-1)[0], name: short || name, location: name, logo: logo === undefined ? 'https://a.espncdn.com/i/teamlogos/test/' + abbr.toLowerCase() + '.png' : logo };
}
function status(kind, o) {
  o = o || {};
  const T = {
    pre: { id: '1', name: 'STATUS_SCHEDULED', state: 'pre', completed: false, description: 'Scheduled', shortDetail: o.detail || 'Scheduled' },
    live: { id: '2', name: o.name || 'STATUS_IN_PROGRESS', state: 'in', completed: false, description: 'In Progress', shortDetail: o.detail || 'In Progress' },
    final: { id: '3', name: o.name || 'STATUS_FINAL', state: 'post', completed: true, description: 'Final', shortDetail: o.detail || 'Final' },
    postponed: { id: '6', name: 'STATUS_POSTPONED', state: 'post', completed: false, description: 'Postponed', shortDetail: 'Postponed' },
    canceled: { id: '5', name: 'STATUS_CANCELED', state: 'post', completed: false, description: 'Canceled', shortDetail: 'Canceled' }
  };
  return { clock: 0, displayClock: o.clock || '0:00', period: o.period || 0, type: T[kind] };
}
function competitor(homeAway, t, score, record, extra) {
  return Object.assign({ id: t.id, homeAway, type: 'team', team: t, score: score == null ? '0' : String(score), records: record ? [{ name: 'overall', summary: record }] : [] }, extra || {});
}
/* odds({book, home:{ml, line, price, fav}, away:{ml, price}, total, over, under, draw}) */
function odds(o) {
  const h = o.home || {}, a = o.away || {};
  const out = { provider: { id: '100', name: o.book || 'DraftKings', priority: 1 } };
  if (h.line != null) {
    const favHome = h.line < 0;
    out.details = o.details || ((favHome ? o.homeAbbr : o.awayAbbr) + ' ' + (-Math.abs(h.line)));
    out.spread = h.line;
  }
  if (o.total != null) { out.overUnder = o.total; out.overOdds = o.over; out.underOdds = o.under; }
  out.homeTeamOdds = { favorite: h.line != null ? h.line < 0 : (h.ml != null && h.ml < 0), underdog: h.line != null ? h.line > 0 : false, moneyLine: h.ml, spreadOdds: h.price };
  out.awayTeamOdds = { favorite: h.line != null ? h.line > 0 : (a.ml != null && a.ml < 0), underdog: h.line != null ? h.line < 0 : false, moneyLine: a.ml, spreadOdds: a.price };
  if (o.draw != null) out.drawOdds = { moneyLine: o.draw };
  return out;
}
/* one event: a single competition between home and away */
function event(o) {
  const comp = {
    id: String(o.id), date: o.date, timeValid: o.timeValid === false ? false : true, neutralSite: !!o.neutral,
    venue: o.venue ? { fullName: o.venue, address: { city: o.city || 'Testville', state: o.state || 'TX' } } : undefined,
    status: o.status, competitors: [competitor('home', o.home, o.hs, o.hrec), competitor('away', o.away, o.as, o.arec)],
    notes: o.notes ? o.notes.map((h) => ({ type: 'event', headline: h })) : [],
    odds: o.odds ? [].concat(o.odds) : []
  };
  return { id: String(o.id), uid: 's:1~e:' + o.id, date: o.date, name: o.away.displayName + ' at ' + o.home.displayName, shortName: o.away.abbreviation + ' @ ' + o.home.abbreviation,
    season: { year: 2026, type: 2 }, week: o.week ? { number: o.week } : undefined, competitions: [comp], status: o.status };
}
/* a UFC card: one event, several bouts, fighters by order */
function card(o) {
  const bouts = o.bouts.map((b, i) => ({
    id: String(o.id) + '0' + i, date: o.date, timeValid: true, type: { text: b.cls || 'Bout' },
    competitors: [
      { id: b.a + 'id', type: 'athlete', order: 1, winner: false, athlete: { id: b.a + 'id', fullName: b.a, displayName: b.a, shortName: b.a.split(' ').pop() }, records: [{ summary: b.arec || '10-2-0' }] },
      { id: b.b + 'id', type: 'athlete', order: 2, winner: false, athlete: { id: b.b + 'id', fullName: b.b, displayName: b.b, shortName: b.b.split(' ').pop() }, records: [{ summary: b.brec || '11-3-0' }] }
    ],
    status: o.status
  }));
  return { id: String(o.id), date: o.date, name: o.name, shortName: o.shortName, competitions: bouts, status: o.status };
}
function board(events) { return { leagues: [{ id: '1' }], events }; }

/* a fetch that answers ESPN scoreboard URLs from a table:
   table[path + '|' + yyyymmdd] = payload | { status } | Error; anything else answers an empty day */
function fakeFetch(table, log) {
  return async function (url) {
    const m = /\/sports\/(.+?)\/scoreboard\?dates=(\d{8})/.exec(url);
    const key = m ? m[1] + '|' + m[2] : url;
    if (log) log.push(key);
    const v = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : (table['*'] !== undefined ? table['*'] : board([]));
    if (v instanceof Error) throw v;
    if (v && v.status && !v.events) return { ok: false, status: v.status, text: async () => 'refused' };
    return { ok: true, status: 200, text: async () => JSON.stringify(v) };
  };
}

module.exports = { team, status, competitor, odds, event, card, board, fakeFetch };
