#!/usr/bin/env node
/* ===========================================================================
   The NHL matchup graphic (lib/edgedesk_nhl_graphic.js) and started games
   keeping their research (hockey/build_slate.js carryRecent), offline.

     content    every committed slate game builds; the projected goals are
                the model's (regulation + overtime/shootout share) and add to
                the expected total in tenths; the win percents add to 100;
                the fair moneyline is the slate's; the copy rule holds
     market     the nearest named-book price (older than 180 minutes: the last
                known market, with its time),
                labelled a reference; otherwise EdgeDesk's own detail
     watch      the decomposition's largest factors, each naming its club
                and its size, then the goalies; never more than four
     colours    the win-probability bar shows on the dark card and the two
                clubs never share a colour
     layout     both formats lay out with every text inside the canvas, and
                the football template draws it (square football unchanged:
                no labels, no surface, no bar colour)
     recent     a started game moves to recent.json as it was priced, frozen
                before the start; upcoming games, postponements and games
                past the window are not kept; the later pregame freeze wins
     today      Today's Games links a started game to its frozen research

   Run: node tools/hockey/nhl_graphic.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const N = require(path.join(ROOT, 'lib', 'edgedesk_nhl_graphic.js'));
const G = require(path.join(ROOT, 'lib', 'edgedesk_game_graphic.js'));
const B = require(path.join(ROOT, 'hockey', 'build_slate.js'));
const C = require(path.join(ROOT, 'hockey', 'config.js'));
const RES = require(path.join(ROOT, 'tools', 'slate', 'research.js'));
const SLATE = require(path.join(ROOT, 'hockey', 'slate.json'));

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; failures.push({ name, detail }); } }
const clone = (x) => JSON.parse(JSON.stringify(x));

/* ---------------------------------------------------------------- content */
const NOW = Date.parse(SLATE.generated_at) + 60000;
const base = { now: NOW, generated_at: SLATE.generated_at, model_id: SLATE.model.id };
SLATE.games.forEach((g) => {
  const r = N.content(g, base);
  chk('content builds: ' + g.game_id, r.ok, r);
  if (!r.ok) return;
  const c = r.content, pg = N.projectedGoals(g);
  chk('projected goals add to the expected total in tenths: ' + g.game_id, Math.round((pg.home + pg.away) * 10) === Math.round(g.prices.total.expected * 10), [pg, g.prices.total.expected]);
  const exact = g.lambda.home + (g.prices.moneyline.home - g.prices.regulation.home);
  chk('…each within a tenth of the model’s own expectation: ' + g.game_id, Math.abs(pg.home - exact) < 0.1 + 1e-9, [pg.home, exact]);
  chk('win percents add to 100: ' + g.game_id, c.win.home_pct + c.win.away_pct === 100);
  const fav = g.prices.moneyline.home >= 0.5 ? 'home' : 'away';
  chk('the fair moneyline is the slate’s, for its favourite: ' + g.game_id, c.fav_side === fav && c.spread_value.replace('−', '-') === String(fav === 'home' ? g.prices.moneyline.fair_home : g.prices.moneyline.fair_away).replace(/^(\d)/, '+$1'), [c.spread_value, g.prices.moneyline]);
  chk('fair total is the slate’s fair line: ' + g.game_id, Number(c.total) === g.prices.total.fair_line);
  chk('insights: at most four, each with a title and a size or the goalies: ' + g.game_id, c.insights.length <= 4 && c.insights.every((i) => i.title && /(\d+\.\d%|onfirmed)/.test(i.text)), c.insights);
  chk('bar colours visible and distinct: ' + g.game_id, N._lum(c.home.bar) >= 0.03 && N._lum(c.away.bar) >= 0.03 && c.home.bar !== c.away.bar, [c.home.bar, c.away.bar]);
  ['square', 'portrait'].forEach((f) => {
    const L = G.layout(c, f);
    const out = L.ops.filter((o) => o.type === 'text' && (o.y > L.height || o.y < 0 || (o.align === 'left' && o.x + Math.min(o.width, o.maxW || o.width) > L.width + 1) || (o.align === 'right' && o.x - Math.min(o.width, o.maxW || o.width) < -1)));
    chk('layout keeps every text on the canvas (' + f + '): ' + g.game_id, out.length === 0, out.map((o) => o.text));
  });
});
const G1 = SLATE.games[0];
chk('every club on the slate has colours and a nickname', SLATE.games.every((g) => N.TEAMS[g.home] && N.TEAMS[g.away]));
chk('no market: EdgeDesk’s own detail strip, no market panel', (() => { const c = N.content(G1, base).content; return !c.market && c.detail && c.detail.cells.length === 3; })());

/* ---------------------------------------------------------------- market */
const mk = (min, extra) => Object.assign({ book: 'DraftKings', source: 'espn_scoreboard', captured_at: new Date(NOW - min * 60000).toISOString(), moneyline: { home: -150, away: 130 }, total: { point: 6.5, over: -110, under: -110 } }, extra || {});
let c = N.content(G1, Object.assign({}, base, { market: mk(30) })).content;
chk('a price from 30 minutes ago: the market snapshot, named and labelled a reference', c.market && /DraftKings/.test(c.market.meta) && /REFERENCE/.test(c.market.note) && c.market.home_ml === '−150' && c.market.away_ml === '+130' && !c.detail, c.market);
chk('…with the no-vig split adding to 100 and the model beside it', c.market && parseInt(c.market.no_vig.home, 10) + parseInt(c.market.no_vig.away, 10) === 100 && c.market.vs.length === 2);
c = N.content(G1, Object.assign({}, base, { market: mk(181) })).content;
chk('a price older than 180 minutes is the last known market, with its time (the nearest price, never hidden)', c.market && c.market.title === 'LAST KNOWN MARKET' && c.market.state === 'STALE' && !c.detail, c.market);
c = N.content(G1, Object.assign({}, base, { market: mk(10, { book: null }) })).content;
chk('a price with no named book is not shown', !c.market);
c = N.content(G1, Object.assign({}, base, { market: mk(10, { moneyline: {}, total: {} }) })).content;
chk('a quote that carries no price is not shown', !c.market);

/* ---------------------------------------------------------------- words */
const bad = clone(G1); bad.explanation.factors[0].label = 'lock of the night'; bad.explanation.factors[0].key = 'home_mystery'; bad.explanation.factors[0].pp = 9;
chk('the copy rule refuses a graphic with banned words', N.content(bad, base).ok === false);
chk('the alt text says research, not picks', /Research, not picks\.$/.test(N.content(G1, base).content.alt));
const st = N.content(G1, Object.assign({}, base, { frozen_at: SLATE.generated_at })).content;
chk('a frozen game says pregame snapshot', /PREGAME SNAPSHOT/.test(st.status) && /^PREGAME SNAPSHOT/.test(st.snapshot_line));
const gr = N.content(G1, Object.assign({}, base, { grade: { letter: 'C', score: 79 } })).content;
chk('the research grade prints in the footer', gr.confidence === 'RESEARCH GRADE C · 79/100');
chk('the cache key moves with the price shown and the grade', N.key(G1, base) !== N.key(G1, Object.assign({}, base, { market: mk(5) })) && N.key(G1, base) !== N.key(G1, Object.assign({}, base, { grade: { letter: 'B', score: 81 } })));

/* ----------------------------------------------------- football untouched */
chk('the football template keeps its own words without labels', (() => {
  const L = G.layout(Object.assign({}, N.content(G1, base).content, { labels: null }), 'square');
  return L.ops.some((o) => o.text === 'FAIR SPREAD') && L.ops.some((o) => o.text === 'FAIR TOTAL');
})());

/* ---------------------------------------------------------------- recent */
const H = 3600e3, t0 = Date.parse('2026-10-20T00:00:00Z');
const game = (id, startMs, extra) => Object.assign({ game_id: id, start_utc: new Date(startMs).toISOString(), home: 'MTL', away: 'SJS', prices: { moneyline: { home: 0.6 } } }, extra || {});
const slate = (genMs, games) => ({ schema: C.SCHEMA.slate, generated_at: new Date(genMs).toISOString(), model: { id: 'm1' }, attribution: 'a', games });
const prev = slate(t0 - 2 * H, [game(1, t0 - H), game(2, t0 + 5 * H), game(3, t0 - 0.5 * H)]);
const next = slate(t0, [game(2, t0 + 5 * H)]);
let R = B.carryRecent(prev, null, next, t0);
chk('started games move to recent, frozen at the slate that priced them', R.schema === C.SCHEMA.recent && R.games.map((g) => g.game_id).join() === '1,3' && R.games.every((g) => g.frozen_at === prev.generated_at && g.model_id === 'm1'), R.games);
chk('…exactly as priced', R.games[0].prices.moneyline.home === 0.6);
chk('an upcoming game stays on the slate, not in recent', !R.games.some((g) => g.game_id === 2));
R = B.carryRecent(slate(t0 - 3 * H, [game(4, t0 + H)]), null, slate(t0, []), t0);
chk('a game whose start has not come is not kept (removed from the schedule)', R.games.length === 0);
const postponed = B.carryRecent(prev, null, slate(t0, [game(1, t0 + 48 * H)]), t0);
chk('a postponed game back on the slate is dropped from recent', !postponed.games.some((g) => g.game_id === 1));
const later = slate(t0 - 1.5 * H, [game(1, t0 - H, { prices: { moneyline: { home: 0.62 } } })]);
R = B.carryRecent(later, B.carryRecent(prev, null, next, t0), next, t0);
chk('the later pregame freeze wins', R.games.find((g) => g.game_id === 1).prices.moneyline.home === 0.62 && R.games.find((g) => g.game_id === 1).frozen_at === later.generated_at);
R = B.carryRecent(slate(t0 - 0.5 * H, [game(5, t0 - H)]), null, next, t0);
chk('a price made after the start is never frozen as pregame', R.games.length === 0);
R = B.carryRecent(null, { schema: C.SCHEMA.recent, games: [Object.assign(game(6, t0 - (C.RECENT_HOURS + 1) * H), { frozen_at: new Date(t0 - (C.RECENT_HOURS + 3) * H).toISOString() }), Object.assign(game(7, t0 - 10 * H), { frozen_at: new Date(t0 - 12 * H).toISOString() })] }, next, t0);
chk('a game past the window leaves; one inside stays', R.games.map((g) => g.game_id).join() === '7', R.games.map((g) => g.game_id));
chk('the window covers Today’s Games (two Eastern days back, plus build gaps)', C.RECENT_HOURS >= 80);

/* ---------------------------------------------------------------- today */
const ev = (id, startIso, status) => ({ id: 'nhl:espn:' + id, sport: 'nhl', provider: 'espn', provider_id: String(id), start_utc: startIso, status,
  home: { name: 'Montreal Canadiens', abbr: 'MTL' }, away: { name: 'San Jose Sharks', abbr: 'SJ' }, research: null });
const recentFile = { schema: C.SCHEMA.recent, games: [Object.assign(clone(G1), { game_id: 999, home: 'MTL', away: 'SJS', start_utc: '2026-10-19T23:00:00Z', frozen_at: '2026-10-19T20:00:00Z' })] };
const teams = require(path.join(ROOT, 'hockey', 'data', 'teams.json'));
const src = { nhl: { schema: SLATE.schema, readiness: SLATE.readiness, games: [] }, nhlRecent: recentFile, nhlTeams: teams };
const evs = [ev(1, '2026-10-19T23:00:00.000Z', 'LIVE')];
RES.join(evs, src, { now: Date.parse('2026-10-20T00:30:00Z') });
const e1 = evs[0];
chk('Today’s Games links a live game to its frozen research', e1.research && e1.research.module === 'nhl' && e1.research.entity === '999' && e1.research.model && e1.research.model.frozen_at === '2026-10-19T20:00:00Z', e1.research);
const evs2 = [ev(1, '2026-10-19T23:00:00.000Z', 'LIVE')];
RES.join(evs2, { nhl: src.nhl, nhlTeams: teams, nhlRecent: null }, { now: Date.parse('2026-10-20T00:30:00Z') });
chk('…and without frozen research there is no link (never a guess)', !(evs2[0].research || {}).module);

failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 400) : '')));
console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'NHL graphic and started games — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
