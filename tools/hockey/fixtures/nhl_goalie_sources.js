'use strict';
/* ===========================================================================
   Source pages for the NHL goalie tests, CONSTRUCTED in each source's
   documented shape (the build environment's network policy denies both
   www.dailyfaceoff.com and api-web.nhle.com, so no live page was captured):

     Daily Faceoff  the starting-goalies page's Next.js __NEXT_DATA__ block:
                    one object per game with home/awayTeamName,
                    home/awayGoalieName, home/awayNewsStrengthName
                    (Confirmed / Likely / Unconfirmed) and the news times
     NHL API        /v1/gamecenter/{id}/boxscore: homeTeam / awayTeam with
                    abbrev, and playerByGameStats.<side>.goalies[] carrying
                    playerId, name.default and starter once lineups post

   The 2026-10-25 Minnesota at Vancouver replay: the only fact taken from the
   report is that Leevi Merilainen started for Vancouver while EdgeDesk's card
   named Kevin Lankinen. Minnesota's starter is set to Cam Pickard (the usage
   projection's likeliest, 77%) and every timestamp is constructed.
   =========================================================================== */

function dfGame(o) {
  return {
    id: o.id || 1, date: o.date, dateGmt: o.dateGmt, time: o.time || null,
    homeTeamName: o.homeTeamName, homeTeamSlug: o.homeTeamSlug || null, awayTeamName: o.awayTeamName, awayTeamSlug: o.awayTeamSlug || null,
    homeGoalieName: o.home ? o.home.name : null, homeNewsStrengthName: o.home ? o.home.strength : null, homeNewsCreatedAt: o.home ? o.home.at : null, homeNewsDetails: o.home ? o.home.details || null : null,
    awayGoalieName: o.away ? o.away.name : null, awayNewsStrengthName: o.away ? o.away.strength : null, awayNewsCreatedAt: o.away ? o.away.at : null, awayNewsDetails: o.away ? o.away.details || null : null,
    homeGoalieSavePercentage: null, awayGoalieSavePercentage: null,
  };
}
/** the page as Daily Faceoff renders it: HTML around one __NEXT_DATA__ script */
function dfPage(games) {
  const data = { props: { pageProps: { date: games[0] ? games[0].date : null, data: games.map(dfGame) } }, page: '/starting-goalies/[date]', query: {}, buildId: 'test' };
  return '<!DOCTYPE html><html><head><title>Starting Goalies</title></head><body><div id="__next"><h1>NHL Starting Goalies</h1></div>'
    + '<script id="__NEXT_DATA__" type="application/json">' + JSON.stringify(data) + '</script></body></html>';
}

/** a boxscore before lineups post, or with each side's goalies listed and the starters flagged (and, with
    homeSkaters / awaySkaters, the dressed skaters: the first twelve as forwards, the rest as defence) */
function boxscore(o) {
  const sk = (ids) => (ids || []).map((id) => ({ playerId: Number(id), name: { default: 'Skater ' + id }, toi: '00:00' }));
  const g = (list, ids) => ({ forwards: sk((ids || []).slice(0, 12)), defense: sk((ids || []).slice(12)), goalies: list.map((x) => ({ playerId: Number(x.id), name: { default: x.name }, starter: !!x.starter, toi: '00:00' })) });
  const b = { id: Number(o.id), gameState: o.state || 'PRE', homeTeam: { abbrev: o.home, score: 0 }, awayTeam: { abbrev: o.away, score: 0 } };
  if (o.homeGoalies || o.awayGoalies || o.homeSkaters || o.awaySkaters) b.playerByGameStats = { homeTeam: g(o.homeGoalies || [], o.homeSkaters), awayTeam: g(o.awayGoalies || [], o.awaySkaters) };
  return b;
}

/* ---------------------------------------------------------------- the lineup lock (CONSTRUCTED)
   Each club's typical lineup is 18 skaters at 1,000 s of ice time a game
   (typical 18,000); the lock variant's linear predictor is the goalie
   variant's own (eta), with the production fit's lineup coefficients. The
   numbers are chosen so the arithmetic is checkable by hand, not to be real. */
const SKATER_BASE = { VAN: 9100000, MIN: 9200000 };
function skaterIds(team, n, from) { const out = []; for (let i = from || 1; i < (from || 1) + (n == null ? 18 : n); i++) out.push(String(SKATER_BASE[team] + i)); return out; }
function withLineups(inputs) {
  const x = JSON.parse(JSON.stringify(inputs));
  x.model.all_variant = 'xg_all_confirmed'; x.model.all_model_id = 'edgedesk_nhl_v1:xg_all_confirmed';
  x.model.all_beta = { goalie: x.model.goalie_beta, lu_own: 0.870723, lu_opp: -0.368072 };
  x.model.all_pair_calibration = x.model.pair_calibration;
  x.skater_prior_s = 600; x.skater_values = {};
  for (const t of Object.keys(SKATER_BASE)) for (const id of skaterIds(t)) x.skater_values[id] = 1000;
  for (const g of x.games) {
    const top = (side) => (((g.projection || {})[side] || [])[0] || {}).goalie_id || null;
    g.lineup = { eta: { home: g.eta.home, away: g.eta.away }, typical: { home: 18000, away: 18000 }, last: { home: skaterIds(g.home), away: skaterIds(g.away) },
      check: { home_goalie_id: top('home'), away_goalie_id: top('away'), p_home: null, basis: 'set by the test' } };
  }
  return x;
}

module.exports.skaterIds = skaterIds;
module.exports.withLineups = withLineups;

const MIN_VAN = { game_id: '2026020184', date: '2026-10-25', dateGmt: '2026-10-26T02:00:00.000Z', homeTeamName: 'Vancouver Canucks', awayTeamName: 'Minnesota Wild', homeTeamSlug: 'vancouver-canucks', awayTeamSlug: 'minnesota-wild' };
/* the replay's Daily Faceoff timeline (UTC): what the page said at each run */
const TIMELINE = {
  morning: { home: null, away: null },                                                                                  /* 8 AM ET: no news yet */
  afternoon: { home: { name: 'Leevi Merilainen', strength: 'Likely', at: '2026-10-25T17:42:00.000Z', details: 'constructed test text' },
    away: { name: 'Cam Pickard', strength: 'Likely', at: '2026-10-25T17:10:00.000Z' } },
  evening: { home: { name: 'Leevi Merilainen', strength: 'Confirmed', at: '2026-10-25T23:12:00.000Z', details: 'constructed test text' },
    away: { name: 'Cam Pickard', strength: 'Likely', at: '2026-10-25T17:10:00.000Z' } },
  final: { home: { name: 'Leevi Merilainen', strength: 'Confirmed', at: '2026-10-25T23:12:00.000Z' },
    away: { name: 'Cam Pickard', strength: 'Confirmed', at: '2026-10-26T01:14:00.000Z' } },
};
function minVanPage(step) { const t = TIMELINE[step]; return dfPage([Object.assign({}, MIN_VAN, { home: t.home, away: t.away })]); }

Object.assign(module.exports, { dfGame, dfPage, boxscore, MIN_VAN, TIMELINE, minVanPage });
