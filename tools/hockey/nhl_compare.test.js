#!/usr/bin/env node
/* ===========================================================================
   EdgeDesk vs the market for the NHL (lib/edgedesk_nhl_compare.js), offline,
   on synthetic games and prices where the answer is known, plus the committed
   slate.

     view       EdgeDesk's numbers in one shape; the compact view keeps the
                ±1.5 puck lines; an old slate without alternates still works
     compare    no-vig arithmetic, the gap is the difference of the two shown
                numbers, the side EdgeDesk rates higher, EV at the book's
                price, pushes excluded on whole lines, a line EdgeDesk never
                priced is not compared, the model's own spread decides
                "agree", a stale or timeless price, the favourites
     labels     a reference (ESPN) price never passes price_verified; nothing
                is VERIFIED VALUE while the NHL is untested against the close;
                a market the record has not validated is RESEARCH ONLY
     tape       + is better on every row, lower-is-better rows flip, within a
                point is even, the likeliest goalie, rest and back-to-backs,
                the projected goals
     artifacts  every committed slate game compares against its own fair
                prices with no gap and nothing paying; Today's Games carries
                the compact view

   Run: node tools/hockey/nhl_compare.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const C = require(path.join(ROOT, 'lib', 'edgedesk_nhl_compare.js'));
const MK = require(path.join(ROOT, 'lib', 'edgedesk_nhl_market.js'));
const RESEARCH = require(path.join(ROOT, 'tools', 'slate', 'research.js'));

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; failures.push({ name, detail }); } }
const near = (a, b, e) => a != null && b != null && Math.abs(a - b) <= (e == null ? 1e-9 : e);
const r1 = (v) => Math.round(v * 10) / 10;
const NOW = Date.parse('2026-10-14T18:00:00Z');
const at = (minAgo) => new Date(NOW - minAgo * 60000).toISOString();

/* a synthetic slate game: home 60% to win, the alternates the slate carries */
function game(o) {
  o = o || {};
  const pH = o.p_home != null ? o.p_home : 0.6;
  return {
    game_id: 2026020999, home: 'HOM', away: 'AWY', start_utc: '2026-10-15T00:00:00Z',
    lambda: { home: 3.3, away: 2.8 },
    prices: { moneyline: { home: pH, away: 1 - pH, fair_home: null, fair_away: null }, total: { expected: 6.1, fair_line: 6 },
      puck_line: { home_minus_1_5: 0.36, away_plus_1_5: 0.64, away_minus_1_5: 0.22, home_plus_1_5: 0.78 } },
    markets: o.noMarkets ? undefined : {
      puck_line: [
        { home_line: -2.5, p: 0.2, push: 0, p_other: 0.8, validation: 'OUTCOME_VALIDATED' },
        { home_line: -1.5, p: 0.36, push: 0, p_other: 0.64, validation: 'OUTCOME_VALIDATED' },
        { home_line: 1.5, p: 0.78, push: 0, p_other: 0.22, validation: 'OUTCOME_VALIDATED' }],
      total: [
        { line: 5.5, p: 0.58, push: 0, p_other: 0.42, validation: 'PROVISIONAL' },
        { line: 6, p: 0.48, push: 0.12, p_other: 0.40, validation: 'PROVISIONAL' },
        { line: 6.5, p: 0.48, push: 0, p_other: 0.52, validation: 'PROVISIONAL' }]
    },
    uncertainty: { moneyline_sd_pp: o.sd != null ? o.sd : 1.5 },
    goalies: { certainty: 'PROJECTED_UNCERTAIN',
      home: [{ name: 'H. Backup', p_start: 0.3, gsax_rate: -0.05 }, { name: 'H. Starter', p_start: 0.7, gsax_rate: 0.03 }],
      away: [{ name: 'A. Starter', p_start: 0.9, gsax_rate: 0.01 }],
      scenarios: [{ p_home: pH - 0.01 }, { p_home: pH + 0.01 }] },
    evidence: {
      home: { ev_xg_for_vs_league: 1.08, ev_xg_against_vs_league: 0.95, goals_for_vs_league: 1.005, goals_against_vs_league: 1.02, pp_vs_league: 1.10, pk_xga_vs_league: 1.04, rest_days: 2, back_to_back: false },
      away: { ev_xg_for_vs_league: 0.97, ev_xg_against_vs_league: 1.01, goals_for_vs_league: 1.0, goals_against_vs_league: 0.98, pp_vs_league: 0.92, pk_xga_vs_league: 0.96, rest_days: 1, back_to_back: true },
      notes: ['Ratios are to the league average.'] }
  };
}
const SLATE = { market_statuses: { moneyline: { status: 'OUTCOME_VALIDATED', market_status: 'NOT_TESTED', market_n: null } },
  readiness: { data: { state: 'FRESH' }, model: { moneyline: { status: 'OUTCOME_VALIDATED', market_status: 'NOT_TESTED' }, puck_line: { status: 'OUTCOME_VALIDATED', market_status: 'NOT_TESTED' }, total: { status: 'PROVISIONAL', market_status: 'NOT_TESTED' } } } };
const espn = (o) => Object.assign({ book: 'Draft Kings', source: 'espn_scoreboard', captured_at: at(10) }, o);
const mOf = (r, kind) => r.markets.filter((m) => m.kind === kind)[0];
const sOf = (m, key) => m.sides.filter((x) => x.key === key)[0];

/* ---------------- view ---------------- */
const V = C.view(game(), SLATE);
chk('view: carries both moneyline probabilities and the record\'s status', V.moneyline.home === 0.6 && near(V.moneyline.away, 0.4) && V.moneyline.status === 'OUTCOME_VALIDATED' && V.moneyline.market_status === 'NOT_TESTED');
chk('view: the full view keeps every alternate puck line, the compact one only ±1.5', V.puck_line.length === 3 && C.view(game(), SLATE, { compact: true }).puck_line.every((x) => Math.abs(x.home_line) === 1.5) && C.view(game(), SLATE, { compact: true }).puck_line.length === 2);
chk('view: totals keep their push and per-line held-out status', V.total.lines.length === 3 && V.total.lines[1].push === 0.12 && V.total.lines[1].status === 'PROVISIONAL');
const V0 = C.view(game({ noMarkets: true }), SLATE);
chk('view: a slate without the alternate sheet falls back to ±1.5 and its own status', V0.puck_line.length === 2 && V0.puck_line[0].home === 0.36 && V0.puck_line[0].status === 'OUTCOME_VALIDATED');
chk('view: no moneyline probabilities, no view (fair prices alone are not enough)', C.view({ prices: {} }, SLATE) === null && C.view(null) === null && C.view({ prices: { moneyline: { fair_home: -120, fair_away: 120 } } }, SLATE) === null);
chk('view: goalie scenarios, certainty, the model spread and the data state ride along', V.scenarios_home.length === 2 && V.goalie_certainty === 'PROJECTED_UNCERTAIN' && V.sd_pp === 1.5 && V.data_state === 'FRESH');

/* ---------------- compare: no price ---------------- */
let r = C.compare(V, null, { now: NOW });
chk('compare: no price is said plainly and EdgeDesk\'s favourite still stands', !r.ok && /No sportsbook price/.test(r.reason) && r.summary.fav.key === 'home' && r.summary.fav.pct === 60 && r.summary.fav.fair_american === -150);
r = C.compare(V, { book: 'X', moneyline: { home: -150, away: 130 } }, { now: NOW });
chk('compare: a price without a capture time is not compared', !r.ok && /capture time/.test(r.reason));
chk('compare: no view, nothing to compare', !C.compare(null, espn({ moneyline: { home: -150, away: 130 } })).ok);

/* ---------------- compare: the moneyline ---------------- */
r = C.compare(V, espn({ moneyline: { home: -145, away: 125 } }), { now: NOW });
let ml = mOf(r, 'moneyline'), h = sOf(ml, 'home'), a = sOf(ml, 'away');
const nv = MK.noVig(-145, 125);
chk('moneyline: the book\'s number is its no-vig probability, rounded once', h.book_pct === r1(nv.p * 100) && a.book_pct === r1((1 - nv.p) * 100), [h.book_pct, a.book_pct, nv.p]);
chk('moneyline: every gap is the difference of the two shown numbers', ml.sides.every((x) => x.gap_pp === r1(x.edgedesk_pct - x.book_pct)));
chk('moneyline: on a two-way market the gaps are opposite', near(h.gap_pp, -a.gap_pp, 0.11));
chk('moneyline: the side EdgeDesk rates higher is the one with the positive gap', ml.lean === 'home' && h.gap_pp > 0);
chk('moneyline: EV is EdgeDesk\'s probability at the book\'s price', near(h.ev, Math.round((0.6 * MK.amToDec(-145) - 1) * 1e4) / 1e4, 1e-4) && h.ev > 0);
chk('moneyline: positive EV on a validated market is PROVISIONAL, never more', h.verdict === 'PROVISIONAL' && r.markets.every((m) => m.sides.every((x) => x.verdict !== 'VERIFIED_VALUE')));
const pv = h.gates.filter((g) => g.gate === 'price_verified')[0];
chk('labels: a republished price is a reference and fails price_verified, saying why without naming ESPN', pv && !pv.ok && /DraftKings’s price as republished by a public scoreboard: a reference/.test(pv.reason) && !/ESPN/.test(pv.reason), pv);
chk('labels: the market test gate fails while the NHL is untested against the close', h.gates.some((g) => g.gate === 'market_tested' && !g.ok));
chk('compare: the book is named (the reader never sees ESPN), the source kept as a reference, the age kept', r.source.book === 'DraftKings' && r.source.kind === 'reference' && r.source.via === 'ESPN' && r.source.label === 'DraftKings' && r.source.age_min === 10 && !r.source.stale);
chk('compare: the sentence names the side, the gap and the price that pays', /EdgeDesk rates HOM \d\.\d pp higher than DraftKings does/.test(ml.sentence) && /pays more than EdgeDesk’s fair −150/.test(ml.sentence) && /Provisional, not a verified edge/.test(ml.sentence), ml.sentence);
chk('compare: the summary says who EdgeDesk and the book make the favourite, and agree', r.summary.book_fav.key === 'home' && r.summary.agree_on_fav === true && r.summary.any_pays === true && r.summary.best.name === 'HOM');

/* a price that does not pay: the side EdgeDesk rates higher, and the number it would take */
r = C.compare(V, espn({ moneyline: { home: -180, away: 145 } }), { now: NOW });
ml = mOf(r, 'moneyline'); a = sOf(ml, 'away');
chk('moneyline: when the book has the favourite shorter, EdgeDesk rates the underdog higher', ml.lean === 'away' && a.gap_pp > 0);
chk('moneyline: neither price pays and the sentence gives the price it would take', !ml.pays && a.verdict === 'PASS' && /Neither price pays/.test(ml.sentence) && new RegExp('it would take \\+' + a.min_american + ' or better').test(ml.sentence), ml.sentence);
chk('moneyline: the minimum price clears the 2% bar exactly', near(0.4 * MK.amToDec(a.min_american) - 1, 0.02, 0.006));
r = C.compare(V, espn({ moneyline: { home: -185, away: 150 } }), { now: NOW });
chk('moneyline: a price exactly at fair is said to be at fair, EV ±0.0%, and does not pay', /AWY at \+150 is right at EdgeDesk’s fair \+150 \(EV ±0.0%\)/.test(mOf(r, 'moneyline').sentence) && !mOf(r, 'moneyline').pays, mOf(r, 'moneyline').sentence);

/* inside the model's own spread: agree */
r = C.compare(V, espn({ moneyline: { home: -155, away: 135 } }), { now: NOW });
ml = mOf(r, 'moneyline');
chk('moneyline: a gap inside the model\'s own spread is called agreement', ml.within_band === true && /so the two agree/.test(ml.sentence) && /inside EdgeDesk’s own ±1.5 pp model spread/.test(ml.sentence), [ml.within_band, ml.sentence]);
r = C.compare(C.view(game({ sd: 0.2 }), SLATE), espn({ moneyline: { home: -155, away: 135 } }), { now: NOW });
chk('moneyline: the same gap outside a tighter spread is a difference', mOf(r, 'moneyline').within_band === false);

/* the favourites disagree */
r = C.compare(C.view(game({ p_home: 0.53 }), SLATE), espn({ moneyline: { home: 110, away: -130 } }), { now: NOW });
chk('compare: when the book makes the other club favourite, the summary says the two disagree', r.summary.agree_on_fav === false && r.summary.book_fav.key === 'away' && /disagree on who should win/.test(r.summary.sentence), r.summary.sentence);

/* a captured (gateway) price passes price_verified, and still is not verified value */
r = C.compare(V, { book: 'FanDuel', source: 'odds_api', captured_at: at(5), moneyline: { home: -120, away: 100 } }, { now: NOW });
h = sOf(mOf(r, 'moneyline'), 'home');
chk('labels: a gateway capture passes price_verified', h.gates.some((g) => g.gate === 'price_verified' && g.ok) && r.source.kind === 'captured' && r.source.label === 'FanDuel');
chk('labels: a large edge on a fresh captured price is still not VERIFIED VALUE while the market is untested', h.ev > 0.05 && h.verdict === 'PROVISIONAL', [h.ev, h.verdict]);

/* stale */
r = C.compare(V, espn({ captured_at: at(120), moneyline: { home: -150, away: 130 } }), { now: NOW });
chk('compare: a price past the 90-minute limit is compared but marked a past price', r.ok && r.source.stale === true && r.source.age_min === 120);
chk('labels: a stale price fails price_fresh', sOf(mOf(r, 'moneyline'), 'home').gates.some((g) => g.gate === 'price_fresh' && !g.ok));

/* ---------------- compare: totals and puck lines ---------------- */
r = C.compare(V, espn({ total: { point: 6.5, over: -110, under: -110 } }), { now: NOW });
let tot = mOf(r, 'total');
chk('total: a half-goal line compares the over and under directly', tot && sOf(tot, 'over').edgedesk_pct === 48 && sOf(tot, 'under').edgedesk_pct === 52 && sOf(tot, 'over').book_pct === 50 && tot.lean === 'under');
chk('total: a market the record calls provisional is RESEARCH ONLY even when it pays', (() => { const x = C.compare(V, espn({ total: { point: 6.5, over: -110, under: 120 } }), { now: NOW }); const u = sOf(mOf(x, 'total'), 'under'); return u.ev > 0 && u.verdict === 'RESEARCH_ONLY' && /Research only/.test(mOf(x, 'total').sentence); })());
chk('total: the sentence states EdgeDesk\'s expected goals and the book\'s line', /EdgeDesk expects 6.1 goals; DraftKings has the line at 6.5/.test(tot.sentence), tot.sentence);
r = C.compare(V, espn({ total: { point: 6, over: -110, under: -110 } }), { now: NOW });
tot = mOf(r, 'total');
chk('total: on a whole-number line both numbers exclude the push', sOf(tot, 'over').edgedesk_pct === r1(0.48 / 0.88 * 100) && /pushes excluded/.test(tot.sentence), [sOf(tot, 'over').edgedesk_pct, tot.sentence]);
chk('total: EV on a whole line returns the stake on a push', near(sOf(tot, 'over').ev, Math.round((0.48 * (MK.amToDec(-110) - 1) - 0.40) * 1e4) / 1e4, 1e-4));
r = C.compare(V, espn({ total: { point: 7.5, over: 150, under: -180 } }), { now: NOW });
chk('total: a line EdgeDesk never priced is not compared, never interpolated', !mOf(r, 'total') && r.not_compared.some((x) => /total 7.5/.test(x)) && !r.ok);
r = C.compare(V, espn({ spread: { home: { point: -1.5, price: 170 }, away: { point: 1.5, price: -200 } } }), { now: NOW });
let pl = mOf(r, 'puck_line');
chk('puck line: home −1.5 reads EdgeDesk\'s home −1.5 and away +1.5', pl && sOf(pl, 'home').edgedesk_pct === 36 && sOf(pl, 'away').edgedesk_pct === 64 && sOf(pl, 'home').name === 'HOM −1.5' && sOf(pl, 'away').name === 'AWY +1.5');
r = C.compare(V, espn({ spread: { home: { point: 1.5, price: -250 }, away: { point: -1.5, price: 210 } } }), { now: NOW });
pl = mOf(r, 'puck_line');
chk('puck line: home +1.5 reads the other row', pl && sOf(pl, 'home').edgedesk_pct === 78 && sOf(pl, 'away').edgedesk_pct === 22);
r = C.compare(V, espn({ spread: { home: { point: -1.5, price: 170 }, away: { point: 2.5, price: -200 } }, moneyline: { home: -150, away: 130 } }), { now: NOW });
chk('puck line: sides that are not opposite are not compared', !mOf(r, 'puck_line') && !!mOf(r, 'moneyline'));
r = C.compare(V, espn({ moneyline: { home: -150, away: 130 }, partial: ['puck line not priced on both sides'] }), { now: NOW });
chk('compare: what the capture left out is listed as not compared', r.not_compared.indexOf('puck line not priced on both sides') >= 0);

/* ---------------- tape ---------------- */
const T = C.tape(game());
const row = (k) => T.rows.filter((x) => x.key === k)[0];
chk('tape: + is better than average on a higher-is-better area', row('attack').home === 8 && row('attack').away === -3 && row('attack').edge === 'home');
chk('tape: lower-is-better areas flip sign', row('defence').home === 5 && row('defence').away === -1 && row('defence').edge === 'home' && row('penalty_kill').home === -4 && row('penalty_kill').edge === 'away');
chk('tape: within one point is even', row('scoring').edge === 'even');
chk('tape: the goalie row uses each club\'s likeliest starter', row('goalie').names.home === 'H. Starter' && row('goalie').home === 3 && row('goalie').away === 1 && row('goalie').edge === 'home');
chk('tape: a back-to-back loses the rest row', row('rest').edge === 'home' && row('rest').b2b.away === true);
chk('tape: the projected goals are the model\'s own and name the stronger side', T.projected.home === 3.3 && T.projected.away === 2.8 && T.projected.edge === 'home' && /HOM is the stronger side tonight/.test(T.sentence));
chk('tape: the counts add up to the rows', T.count.home + T.count.away + T.count.even === T.rows.length);
chk('tape: no evidence, no tape', C.tape({ evidence: null }) === null);

/* ---------------- artifacts ---------------- */
const HS = JSON.parse(fs.readFileSync(path.join(ROOT, 'hockey', 'slate.json'), 'utf8'));
let allFair = true, allTape = true, detail = null;
HS.games.forEach((g) => {
  const v = C.view(g, HS);
  if (!C.tape(g)) allTape = false;
  /* the book quoting EdgeDesk's own fair prices with no margin: no gap, nothing pays */
  const ml2 = { home: g.prices.moneyline.fair_home, away: g.prices.moneyline.fair_away };
  const x = C.compare(v, espn({ captured_at: at(1), moneyline: ml2 }), { now: NOW });
  const m = mOf(x, 'moneyline');
  if (!m || m.sides.some((s) => Math.abs(s.gap_pp) > 0.3) || x.summary.any_pays && x.summary.best.ev > 0.004) { allFair = false; detail = { game: g.game_id, sides: m && m.sides.map((s) => [s.gap_pp, s.ev]) }; }
});
chk('artifacts: every slate game, priced at its own fair moneyline, shows no real gap and nothing paying', allFair, detail);
chk('artifacts: every slate game has a who-is-better-where tape', allTape);
const g0 = HS.games[0];
const ev = { id: 'nhl:nhl:' + g0.game_id, sport: 'nhl', provider: 'nhl', provider_id: String(g0.game_id), start_utc: g0.start_utc, home: { name: g0.home }, away: { name: g0.away } };
RESEARCH.join([ev], RESEARCH.loadSources({ nfl: null, cfb: null, home: null, basketball: null, soccer: null, engine: null, published: null }));
chk('artifacts: Today\'s Games carries the compact view for an NHL game', ev.research.module === 'nhl' && ev.research.model.view && ev.research.model.view.game_id === String(g0.game_id) && ev.research.model.view.puck_line.every((x) => Math.abs(x.home_line) === 1.5), ev.research);
const TEAMS = JSON.parse(fs.readFileSync(path.join(ROOT, 'hockey', 'data', 'teams.json'), 'utf8')).teams;
const swapped = { id: 'nhl:espn:swap', sport: 'nhl', provider: 'espn', provider_id: 'swap', start_utc: g0.start_utc, home: { name: TEAMS[g0.away].name }, away: { name: TEAMS[g0.home].name } };
const straight = { id: 'nhl:espn:straight', sport: 'nhl', provider: 'espn', provider_id: 'straight', start_utc: g0.start_utc, home: { name: TEAMS[g0.home].name }, away: { name: TEAMS[g0.away].name } };
RESEARCH.join([straight], RESEARCH.loadSources({ nfl: null, cfb: null, home: null, basketball: null, soccer: null, engine: null, published: null }));
chk('artifacts: an ESPN event matched by its teams and start carries the view', straight.research.module === 'nhl' && !straight.research.sides_swapped && !!straight.research.model.view, straight.research);
RESEARCH.join([swapped], RESEARCH.loadSources({ nfl: null, cfb: null, home: null, basketball: null, soccer: null, engine: null, published: null }));
chk('artifacts: a game the sources list the other way round keeps its research link but carries no view to compare', swapped.research.module === 'nhl' && swapped.research.sides_swapped === true && swapped.research.model.view === null, swapped.research);
chk('artifacts: the carried view compares exactly as the full one does on the moneyline and the total', (() => {
  const mk = espn({ captured_at: at(1), moneyline: { home: -120, away: 100 }, total: { point: g0.prices.total.fair_line, over: -110, under: -110 } });
  const A = C.compare(ev.research.model.view, mk, { now: NOW }), B = C.compare(C.view(g0, HS), mk, { now: NOW });
  return JSON.stringify(A.markets.map((m) => m.sides.map((s) => [s.edgedesk_pct, s.gap_pp, s.ev]))) === JSON.stringify(B.markets.map((m) => m.sides.map((s) => [s.edgedesk_pct, s.gap_pp, s.ev])));
})());

failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 400) : '')));
console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'NHL vs the market — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
