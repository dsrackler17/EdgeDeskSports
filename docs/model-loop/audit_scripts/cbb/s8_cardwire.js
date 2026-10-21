'use strict';
/* Does the NCAAM fair spread reach the EdgeDesk Card? Run the real join()
   (tools/slate/research.js) and card feed (lib/edgedesk_card_feed.js) on one
   game priced by the real basketball/build_slate.js priceGame. Nothing is written to the repo. */
const REPO = '/home/user/EdgeDeskSports';
const fs = require('fs');
const BS = require(REPO + '/basketball/build_slate.js');
const R = require(REPO + '/tools/slate/research.js');
const CF = require(REPO + '/lib/edgedesk_card_feed.js');
const live = JSON.parse(fs.readFileSync(REPO + '/basketball/params/ncaam_live.json', 'utf8'));
// Duke (150) at home vs North Carolina (153), a future date, off the live 2027 params (preseason priors)
const g = { game_id: '999000001', start_utc: '2026-11-20T00:00:00Z', date: '2026-11-19', neutral: 0, home_id: '150', away_id: '153', status: 'SCHEDULED' };
const p = BS.priceGame(g, live, () => null);
const fmt = (v) => Math.round(v * 10000) / 10000;
const am = (pp) => { const d = 1 + (1 - pp) / pp; return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)); };
const slateGame = { event_key: 'X|' + g.game_id, game_id: g.game_id, start_utc: g.start_utc, neutral: false, home: 'Duke', away: 'North Carolina', home_id: '150', away_id: '153',
  prices: { moneyline: { home: fmt(p.p_home), away: fmt(1 - p.p_home), fair_home: am(p.p_home), fair_away: am(1 - p.p_home) },
    spread: { projected_margin: Math.round(p.margin * 10) / 10, fair_home_line: p.fairSpread, lines: p.spreadLines }, total: { projected: Math.round(p.total * 10) / 10, fair_line: p.fairTotal, lines: p.totalLines } } };
const bb = { schema: 'edgedesk_lab_slate_v1', leagues: { ncaam: { games: [slateGame], validation: { moneyline: 'OUTCOME_VALIDATED', spread: 'OUTCOME_VALIDATED', total: 'OUTCOME_VALIDATED' }, value_reason: 'x' } } };
const ev = { id: 'ncaam:espn:999000001', sport: 'ncaam', provider: 'espn', provider_id: '999000001', start_utc: g.start_utc, status: 'SCHEDULED', home: { name: 'Duke Blue Devils', abbr: 'DUKE' }, away: { name: 'North Carolina Tar Heels', abbr: 'UNC' }, league: 'NCAAM' };
const src = { basketball: bb };
try { R.join([ev], src, { now: Date.parse('2026-11-19T12:00:00Z') }); } catch (e) { console.log('join threw:', e.message); }
console.log('priceGame: p_home', fmt(p.p_home), 'margin', p.margin.toFixed(2), 'fairSpread', p.fairSpread, 'total', p.total.toFixed(2));
console.log('research.model attached to the event:', JSON.stringify(ev.research && ev.research.model));
const slate = { generated_at: '2026-11-19T12:00:00Z', events: [ev], upcoming: [], markets: { [ev.id]: { captured_at: '2026-11-19T11:55:00Z', book: 'DraftKings', moneyline: { home: -200, away: 165 }, spread: { home: { point: -4.5, price: -110 }, away: { point: 4.5, price: -110 } }, total: { point: 150.5, over: -110, under: -110 } } } };
const rows = CF.rows(slate, { now: Date.parse('2026-11-19T12:00:00Z') });
const r0 = rows[0] || {};
console.log('card row:', JSON.stringify({ board_kind: r0.board_kind, decision: r0.decision, model_fair_text: r0.model_fair_text, market_type: r0.market_type, edge_pp: r0.edge_pp, decision_ev_pct: r0.decision_ev_pct, raw_ev_pct: r0.raw_ev_pct, why: (r0.action_reason_text || '').slice(0, 300) }));
