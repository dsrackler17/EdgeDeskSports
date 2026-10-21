'use strict';
const ROOT = '/home/user/EdgeDeskSports';
const M = require(ROOT + '/lib/tennis_model.js');
const R = require(ROOT + '/lib/tennis_research.js');
const ODDS = require(ROOT + '/tools/tennis/providers/edgedesk_odds.js');
// production shape: public.signals.sharp_fair is a FAIR PROBABILITY (capture/index.ts:2617), copied verbatim by sync_events.js:209
const at = '2026-09-20T10:00:00Z';
const fake = { rows: () => [
  { match_id: 'm1', tournament_id: 't', book: 'Pinnacle', side: 'home', capture_at: at, market_state: 'PRE', best_dec: 1.55, sharp_fair: 0.62, consensus_fair: 0.615, n_books: 8, has_sharp: true, tour: 'ATP', home_player_id: 'A', away_player_id: 'B', home_name: 'A', away_name: 'B' },
  { match_id: 'm1', tournament_id: 't', book: 'DraftKings', side: 'away', capture_at: '2026-09-20T10:00:05Z', market_state: 'PRE', best_dec: 2.75, sharp_fair: 0.38, consensus_fair: 0.385, n_books: 8, has_sharp: true, tour: 'ATP', home_player_id: 'A', away_player_id: 'B', home_name: 'A', away_name: 'B' } ] };
(async () => {
  const rows = await ODDS.fromTennisCaptures(fake, {});
  console.log('after fromTennisCaptures no_vig_prob:', rows.map(r => r.no_vig_prob), 'implied:', rows.map(r => r.implied_prob));
  ODDS.devig(rows);
  console.log('after devig no_vig_prob:', rows.map(r => r.no_vig_prob));
  const marketProbA = M.num(rows[0].no_vig_prob) ?? M.num(rows[0].implied_prob);
  console.log('price_board marketProbA (fallback):', marketProbA, ' vs true fair 0.62');
  // settle_record.js:92-96
  const closeFair = 0.62;
  console.log('settle_record closingProbA = probFromDecimal(0.62) ->', M.probFromDecimal(closeFair));
  // with fixture unit (decimal, make_board.js:101) it works:
  console.log('fixture unit probFromDecimal(1/0.62) ->', M.probFromDecimal(M.round(1/0.62,4)));
  // tennis_research closingReference/clv use the probability unit
  console.log('tennis_research.clv(entry 1.70, closeFair 0.62) =', R.clv(1.70, 0.62));
  // settle CLV definition: closing - published market prob for side A, independent of model side
  const pub = 0.60, close = 0.62, modelA = 0.45; // model liked B
  console.log('settle clv for side A =', M.round(close - pub, 5), 'beat_close =', close - pub > 0, '(model favoured B at', modelA, '-> B actually lost CLV)');
})();
