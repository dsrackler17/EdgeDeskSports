'use strict';
const REPO = '/home/user/EdgeDeskSports';
const CF = require(REPO + '/lib/edgedesk_card_feed.js');
const am = (p) => { const d = 1 + (1 - p) / p; return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)); };
const cases = [
  ['Bellarmine v Houston Christian 2025-11-25', 0.8767, 124, -148, -2.5],
  ['New Hampshire v Brown 2025-11-26', 0.7579, 205, -250, 5.5],
  ['Tulsa v Missouri State 2025-12-06', 0.9524, -425, 330, -7.5],
  ['Saint Louis v Loyola Chicago 2026-03-04', 0.9816, -6500, 2000, -21.5],
  ['East Carolina v Tulsa 2026-03-05', 0.1203, 360, -470, 8.5],
  ['Maryland v Illinois 2026-03-08', 0.0672, 950, -1650, 14.5],
];
const now = Date.parse('2026-01-01T12:00:00Z');
for (const [name, p, mh, ma, line] of cases) {
  const ev = { id: 'ncaam:espn:1', sport: 'ncaam', start_utc: '2026-01-01T20:00:00Z', status: 'SCHEDULED', home: { name: 'Home' }, away: { name: 'Away' }, league: 'NCAAM',
    research: { model: { status: 'PREDICTED', tier: 'OUTCOME_VALIDATED', data_quality: 'OK', fair: { ml_home: am(p), ml_away: am(1 - p), spread_home: null, total: null } } } };
  const slate = { generated_at: '2026-01-01T12:00:00Z', events: [ev], upcoming: [], markets: { [ev.id]: { captured_at: '2026-01-01T11:50:00Z', book: 'DraftKings', moneyline: { home: mh, away: ma }, spread: { home: { point: line, price: -110 }, away: { point: -line, price: -110 } } } } };
  const r = CF.rows(slate, { now })[0];
  console.log(name.padEnd(42), 'model p_home', p, '| card:', r.decision, r.decision_qualifier || '', '| side', r.side_key, 'ML', r.reference_quote && r.reference_quote.odds, '| EV', r.decision_ev_pct, '% raw EV', r.raw_ev_pct, '% edge', r.edge_pp, 'pp');
}
