/* Emits "<table>\t<column>" for every column capture actually writes, taken
   from the real row builders rather than from a list somebody maintains. Used
   by migration.test.js to prove the migration covers all of them. */
globalThis.Deno = { env: { get: () => undefined } };
const here = new URL('.', import.meta.url).pathname;
const M = await import(here + '../../supabase/functions/capture/index.ts');
const cfg = M.defaultConfig(() => undefined);
const NOW = Date.parse('2026-09-05T12:00:00.000Z');
const AGO = (s) => new Date(NOW - s * 1000).toISOString();
const ev = {
  id: 'e1', sport_key: 'americanfootball_nfl', sport_title: 'NFL',
  commence_time: new Date(NOW + 6 * 3600e3).toISOString(), home_team: 'C', away_team: 'R',
  bookmakers: ['pinnacle', 'draftkings', 'fanduel', 'betmgm', 'betrivers'].map((k) => ({
    key: k, title: k, last_update: AGO(60),
    markets: [{ key: 'spreads', last_update: AGO(60), outcomes: [
      { name: 'C', price: k === 'betrivers' ? 2.02 : 1.88, point: -3.5 },
      { name: 'R', price: k === 'betrivers' ? 1.83 : 1.94, point: 3.5 }] }],
  })),
};
const c = M.priceEvent(ev, cfg, NOW).candidates.find((x) => x.selection === 'C');
const v = M.qualifySignal(c, { priorStreak: 5, nowMs: NOW }, cfg);
const iso = new Date(NOW).toISOString();
/* A player market: the player row adds its own columns to `signals`, and every
   quote goes to player_prop_quotes with its event's poll row beside it. */
const pev = {
  id: 'e2', sport_key: 'americanfootball_nfl', sport_title: 'NFL',
  commence_time: new Date(NOW + 6 * 3600e3).toISOString(), home_team: 'C', away_team: 'R',
  bookmakers: ['draftkings', 'fanduel'].map((k) => ({
    key: k, title: k, last_update: AGO(60),
    markets: [{ key: 'player_pass_yds', last_update: AGO(60), outcomes: [
      { name: 'Over', description: 'Patrick Mahomes', price: 1.91, point: 274.5 },
      { name: 'Under', description: 'Patrick Mahomes', price: 1.91, point: 274.5 }] }],
  })),
};
const pc = M.priceEvent(pev, cfg, NOW).candidates.find((x) => x.selection === 'Over');
const pv = M.qualifySignal(pc, { priorStreak: 0, nowMs: NOW }, cfg);
const out = {
  signals: [...new Set([...Object.keys(M.signalRow(c, v, iso)), ...Object.keys(M.flagRow(c, v, iso)),
    ...Object.keys(M.signalRow(pc, pv, iso))])],
  signal_ticks: Object.keys(M.tickRow(c, v, iso)),
  book_quotes: Object.keys(M.bookQuoteRows(c, v, cfg, iso)[0]),
  player_prop_quotes: Object.keys(M.playerPropQuoteRows(pc, iso)[0]),
  player_prop_event_polls: Object.keys(M.propPollRow(pev, 'americanfootball_nfl', iso, {
    markets_requested: 1, markets_returned: 1, requests_failed: 0, credits_spent: 1, quotes: 4, players: 1, poll_status: 'ok' })),
};
for (const t in out) for (const col of out[t]) console.log(t + '\t' + col);
