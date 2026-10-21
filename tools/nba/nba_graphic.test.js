#!/usr/bin/env node
/* ===========================================================================
   The NBA matchup graphic (lib/edgedesk_nba_graphic.js), started games
   keeping their research (nba/build_slate.js carryRecent) and Today's Games
   linking every NBA game to it (tools/slate/research.js), offline.

     content    every committed slate game builds; the fair spread, fair total,
                moneyline and expected points are the slate's own; the win
                percents add to 100; the copy rule holds
     market     only a named-book price captured in the last 180 minutes and
                before tip; its gaps are the book's line against the fair line
                on the graphic; otherwise EdgeDesk's own detail
     watch      at most four lines, each naming a team, never a data-state
                note as the model's factor
     colours    every team has its colours, the bar shows on the dark card and
                the two teams never share a colour
     layout     both formats lay out with every text inside the canvas, on a
                court; football's picture is unchanged
     recent     a started game moves to recent.json as it was priced, frozen
                before the start; a game still ahead, a postponement and a
                game past the window are not kept; the later freeze wins
     today      Today's Games links every NBA game the engine priced, started
                ones to their frozen research, with the panel's own numbers

   Run: node tools/nba/nba_graphic.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const N = require(path.join(ROOT, 'lib', 'edgedesk_nba_graphic.js'));
const G = require(path.join(ROOT, 'lib', 'edgedesk_game_graphic.js'));
const B = require(path.join(ROOT, 'nba', 'build_slate.js'));
const C = require(path.join(ROOT, 'nba', 'config.js'));
const RES = require(path.join(ROOT, 'tools', 'slate', 'research.js'));
const SLATE = require(path.join(ROOT, 'nba', 'slate.json'));

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; failures.push({ name, detail }); } }
const clone = (x) => JSON.parse(JSON.stringify(x));
const minus = (t) => String(t).replace(/−/g, '-');

/* ---------------------------------------------------------------- content */
const NOW = Date.parse(SLATE.generated_at) + 60000;
const base = { now: NOW, generated_at: SLATE.generated_at, model_id: SLATE.model.chosen };
chk('the committed slate has games to draw', SLATE.games.length > 0);
SLATE.games.forEach((g) => {
  const r = N.content(g, base);
  chk('content builds: ' + g.game_id, r.ok, r);
  if (!r.ok) return;
  const c = r.content, P = g.price, fl = P.spread.fair_line_home;
  chk('the fair spread is the slate’s, for the team it favours: ' + g.game_id, fl === 0 ? c.spread_value === 'PK' : (Number(minus(c.spread_value)) === -Math.abs(fl) && c.spread_text.indexOf(fl < 0 ? g.home.abbr : g.away.abbr) === 0), [c.spread_text, fl]);
  chk('the fair total is the slate’s fair line: ' + g.game_id, Number(c.total) === P.total.fair_line, [c.total, P.total.fair_line]);
  chk('the projected score is each team’s expected points: ' + g.game_id, Math.abs(Number(c.scores.home) - P.expected.home) <= 0.05 + 1e-9 && Math.abs(Number(c.scores.away) - P.expected.away) <= 0.05 + 1e-9, [c.scores, P.expected]);
  chk('…and the expected total prints beside the fair total: ' + g.game_id, c.total_sub.text === P.expected.total.toFixed(2) + ' PTS');
  chk('win percents add to 100 and follow the moneyline: ' + g.game_id, c.win.home_pct + c.win.away_pct === 100 && c.fav_side === (P.moneyline.home >= 0.5 ? 'home' : 'away'));
  chk('the model moneyline is the slate’s: ' + g.game_id, minus(c.fair_ml.home) === (P.moneyline.home_american > 0 ? '+' : '') + P.moneyline.home_american && minus(c.fair_ml.away) === (P.moneyline.away_american > 0 ? '+' : '') + P.moneyline.away_american, [c.fair_ml, P.moneyline]);
  chk('insights: at most four, each with a title and a team: ' + g.game_id, c.insights.length <= 4 && c.insights.length >= 2 && c.insights.every((i) => i.title && i.text && (i.text.indexOf(g.home.abbr) >= 0 || i.text.indexOf(g.away.abbr) >= 0 || /possessions|rotation/i.test(i.text))), c.insights);
  chk('the biggest model factor is never a note on the data’s state: ' + g.game_id, !c.insights.some((i) => i.title === 'BIGGEST MODEL FACTOR' && /carried from last season|games played|rating uncertainty/i.test(i.text)));
  chk('bar colours visible and distinct: ' + g.game_id, N._lum(c.home.bar) >= 0.03 && N._lum(c.away.bar) >= 0.03 && c.home.bar !== c.away.bar, [c.home.bar, c.away.bar]);
  chk('drawn on a court, labelled as expected points: ' + g.game_id, c.surface === 'court' && /EXPECTED POINTS/.test(c.labels.center_sub));
  ['square', 'portrait'].forEach((f) => {
    const L = G.layout(c, f);
    const out = L.ops.filter((o) => o.type === 'text' && (o.y > L.height || o.y < 0 || (o.align === 'left' && o.x + Math.min(o.width, o.maxW || o.width) > L.width + 1) || (o.align === 'right' && o.x - Math.min(o.width, o.maxW || o.width) < -1)));
    chk('layout keeps every text on the canvas (' + f + '): ' + g.game_id, out.length === 0, out.map((o) => o.text));
  });
});
/* the game the graphic is drawn for has not started at the test's clock: a slate built on a game night
   still lists the games under way, and a market quote captured after tip is (rightly) never drawn */
const G1 = SLATE.games.find((g) => Date.parse(g.start_utc) > NOW) || SLATE.games[0];
chk('every team on the slate has colours and a nickname', SLATE.games.every((g) => N.TEAMS[g.home.abbr] && N.TEAMS[g.away.abbr]));
chk('all thirty teams are coloured', Object.keys(N.TEAMS).length === 30);
const c0 = N.content(G1, base).content;
chk('no market: EdgeDesk’s own detail strip (range, model moneyline, overtime), no market panel', !c0.market && c0.detail && c0.detail.cells.map((x) => x.k).join() === '80% OUTCOME RANGE,MODEL MONEYLINE,OVERTIME', c0.detail);
chk('the 80% range reads in words from the slate’s margin interval', (() => { const iv = G1.price.margin_interval_80, v = c0.detail.cells[0].v; return v[0] === (iv[0] < 0 ? G1.away.abbr : G1.home.abbr) + ' BY ' + Math.abs(iv[0]) && v[1] === 'TO ' + (iv[1] > 0 ? G1.home.abbr : G1.away.abbr) + ' BY ' + Math.abs(iv[1]); })(), c0.detail.cells[0]);

/* ---------------------------------------------------------------- market */
const fl1 = G1.price.spread.fair_line_home, ft1 = G1.price.total.fair_line;
const mk = (min, extra) => Object.assign({ book: 'Draft Kings', source: 'espn_scoreboard', captured_at: new Date(NOW - min * 60000).toISOString(),
  moneyline: { home: -105, away: -115 }, spread: { home: { point: fl1 + 4, price: -112 }, away: { point: -(fl1 + 4), price: -108 } }, total: { point: ft1 + 4, over: -105, under: -115 } }, extra || {});
let c = N.content(G1, Object.assign({}, base, { market: mk(30) })).content;
chk('a price from 30 minutes ago: the market snapshot, the book named as the graphic names it, a reference', c.market && /^DraftKings via ESPN/.test(c.market.meta) && /REFERENCE/.test(c.market.note) && !c.detail, c.market);
chk('…every market it carries, as received', c.market && minus(c.market.home_spread) === (fl1 + 4 > 0 ? '+' : '') + (fl1 + 4).toFixed(1) && c.market.total === (ft1 + 4).toFixed(1) && c.market.home_ml === '−105' && c.market.away_ml === '−115' && c.market.total_prices === 'O −105 · U −115', c.market);
chk('…the no-vig split adds to 100', parseInt(c.market.no_vig.home, 10) + parseInt(c.market.no_vig.away, 10) === 100);
chk('…and the gaps are the book’s line against the fair line on the graphic', c.market.vs[0] === 'Spread: EdgeDesk 4.0 pts toward ' + G1.home.abbr && c.market.vs[1] === 'Total: EdgeDesk 4.0 pts lower', c.market.vs);
c = N.content(G1, Object.assign({}, base, { market: mk(30, { spread: { home: { point: fl1, price: -110 }, away: { point: -fl1, price: -110 } }, total: { point: ft1 } }) })).content;
chk('the same line both ways reads as agreement', c.market.vs.join(' | ') === 'Spread: EdgeDesk and the market agree | Total: EdgeDesk and the market agree', c.market.vs);
chk('a price older than 180 minutes is not shown', !N.content(G1, Object.assign({}, base, { market: mk(181) })).content.market);
chk('a price with no named book is not shown', !N.content(G1, Object.assign({}, base, { market: mk(10, { book: null }) })).content.market);
chk('a quote that carries no price is not shown', !N.content(G1, Object.assign({}, base, { market: mk(10, { moneyline: {}, spread: {}, total: {} }) })).content.market);
const tip = Date.parse(G1.start_utc);
chk('a price captured after tip is never shown as the market', !N.content(G1, Object.assign({}, base, { now: tip + 30 * 60000, market: Object.assign(mk(0), { captured_at: new Date(tip + 10 * 60000).toISOString() }) })).content.market);

/* ---------------------------------------------------------------- words */
const bad = clone(G1); bad.explanation = [{ feature: 'x', label: 'lock of the night', points_toward_home: 9 }];
chk('the copy rule refuses a graphic with banned words', N.content(bad, base).ok === false);
chk('the alt text says research, not picks', /Research, not picks\.$/.test(c0.alt));
const st = N.content(G1, Object.assign({}, base, { frozen_at: SLATE.generated_at })).content;
chk('a frozen game says pregame snapshot', /PREGAME SNAPSHOT/.test(st.status) && /^PREGAME SNAPSHOT/.test(st.snapshot_line));
chk('an early-season game says so in the footer', !G1.uncertainty.early_season || (c0.status === 'EARLY SEASON · RESEARCH ONLY' && c0.status_tone === 'warn'));
const gr = N.content(G1, Object.assign({}, base, { grade: { letter: 'C', score: 72 } })).content;
chk('the research grade prints in the footer', gr.confidence === 'RESEARCH GRADE C · 72/100');
chk('the cache key moves with the price shown, the grade and the records', N.key(G1, base) !== N.key(G1, Object.assign({}, base, { market: mk(5) })) && N.key(G1, base) !== N.key(G1, Object.assign({}, base, { grade: { letter: 'B', score: 81 } })) && N.key(G1, base) !== N.key(G1, Object.assign({}, base, { records: { BOS: '1-0' } })));
chk('venue and records come from the caller and print', (() => { const x = N.content(G1, Object.assign({}, base, { venue: 'Little Caesars Arena', records: { [G1.home.abbr]: '0-0' } })).content; return x.venue === 'LITTLE CAESARS ARENA' && x.home.record === '(0-0)'; })());
chk('a game with no price is refused, not drawn', N.content(Object.assign(clone(G1), { price: null }), base).ok === false);

/* ----------------------------------------------------- football untouched */
chk('the football template keeps its own words and yard lines without labels or surface', (() => {
  const L = G.layout(Object.assign({}, c0, { labels: null, surface: null }), 'square');
  return L.ops.some((o) => o.text === 'FAIR SPREAD') && L.ops.some((o) => o.text === 'PROJECTED SCORE') && L.ops.some((o) => o.text === 'EDGEDESK PROJECTION') && L.ops.filter((o) => o.type === 'line' && o.x0 === 0).length >= 7;
})());
chk('the court draws its centre circle', G.layout(c0, 'square').ops.some((o) => o.type === 'circle' && o.r === 72 && !o.fill));

/* ---------------------------------------------------------------- recent */
const H = 3600e3, t0 = Date.parse('2026-10-21T00:00:00Z');
const game = (id, startMs, predMs, extra) => Object.assign({ game_id: id, start_utc: new Date(startMs).toISOString(), predicted_at: new Date(predMs).toISOString(), home: { abbr: 'DET' }, away: { abbr: 'BOS' }, price: { moneyline: { home: 0.54 } } }, extra || {});
const slate = (genMs, games) => ({ schema: C.SCHEMA.slate, generated_at: new Date(genMs).toISOString(), value_reason: 'v', games });
const prev = slate(t0 - 2 * H, [game('1', t0 - H, t0 - 2 * H), game('2', t0 + 5 * H, t0 - 2 * H), game('3', t0 - 0.5 * H, t0 - 2 * H)]);
const next = slate(t0, [game('2', t0 + 5 * H, t0), game('1', t0 - H, t0)]);
let R = B.carryRecent(prev, null, next, t0);
chk('started games move to recent, frozen when the slate priced them', R.schema === C.SCHEMA.recent && R.games.map((g) => g.game_id).join() === '1,3' && R.games.every((g) => g.frozen_at === prev.generated_at), R.games);
chk('…exactly as priced, even while the new slate still lists (and re-prices) the started game', R.games[0].price.moneyline.home === 0.54 && R.games[0].predicted_at === prev.generated_at);
chk('a game still ahead stays on the slate, not in recent', !R.games.some((g) => g.game_id === '2'));
R = B.carryRecent(slate(t0 - 3 * H, [game('4', t0 + H, t0 - 3 * H)]), null, slate(t0, []), t0);
chk('a game whose start has not come is not kept', R.games.length === 0);
chk('a postponed game back on the slate with a later start is dropped', !B.carryRecent(prev, null, slate(t0, [game('1', t0 + 48 * H, t0)]), t0).games.some((g) => g.game_id === '1'));
const later = slate(t0 - 1.5 * H, [game('1', t0 - H, t0 - 1.5 * H, { price: { moneyline: { home: 0.56 } } })]);
R = B.carryRecent(later, B.carryRecent(prev, null, next, t0), next, t0);
chk('the later pregame freeze wins', R.games.find((g) => g.game_id === '1').price.moneyline.home === 0.56 && R.games.find((g) => g.game_id === '1').frozen_at === later.generated_at);
R = B.carryRecent(slate(t0 - 0.5 * H, [game('5', t0 - H, t0 - 0.5 * H)]), null, next, t0);
chk('a price made after the start is never frozen as pregame', R.games.length === 0);
R = B.carryRecent(null, { schema: C.SCHEMA.recent, games: [Object.assign(game('6', t0 - (C.RECENT_HOURS + 1) * H, t0 - (C.RECENT_HOURS + 3) * H), { frozen_at: new Date(t0 - (C.RECENT_HOURS + 3) * H).toISOString() }), Object.assign(game('7', t0 - 10 * H, t0 - 12 * H), { frozen_at: new Date(t0 - 12 * H).toISOString() })] }, next, t0);
chk('a game past the window leaves; one inside stays', R.games.map((g) => g.game_id).join() === '7', R.games.map((g) => g.game_id));
chk('the window covers Today’s Games (two Eastern days back, plus build gaps)', C.RECENT_HOURS >= 80);
const committed = (() => { try { return require(path.join(ROOT, 'nba', 'recent.json')); } catch (_) { return null; } })();
chk('the committed recent.json is the schema and every game was frozen before its start', committed && committed.schema === C.SCHEMA.recent && committed.games.every((g) => Date.parse(g.frozen_at) < Date.parse(g.start_utc)), committed && committed.schema);

/* ---------------------------------------------------------------- today */
const ev = (g, status) => ({ id: 'nba:espn:' + g.game_id, sport: 'nba', provider: 'espn', provider_id: String(g.game_id), start_utc: g.start_utc, status,
  home: { name: g.home.name, abbr: g.home.abbr }, away: { name: g.away.name, abbr: g.away.abbr }, research: null });
const evs = SLATE.games.map((g) => ev(g, 'SCHEDULED'));
RES.join(evs, { nba: SLATE, nbaRecent: null, basketball: { leagues: {} } }, { now: NOW });
chk('Today’s Games links every NBA game the engine priced to its research page', evs.every((e) => e.research.module === 'nba' && e.research.entity === e.provider_id), evs.filter((e) => e.research.module !== 'nba').map((e) => e.id));
const e0 = evs.find((e) => e.provider_id === String(G1.game_id));
chk('…with the panel’s own numbers (fair moneyline, spread, total) and its validation', e0.research.model.source === 'nba/slate.json' && e0.research.model.fair.ml_home === G1.price.moneyline.home_american && e0.research.model.fair.spread_home === G1.price.spread.fair_line_home && e0.research.model.fair.total === G1.price.total.fair_line && e0.research.model.tier === 'OUTCOME_VALIDATED' && /value claims are off/.test(e0.research.model.note), e0.research.model);
chk('…and its target is the NBA panel’s game route', require(path.join(ROOT, 'lib', 'edgedesk_games.js')).researchTarget(e0, 'app').href === '#research/nba/' + G1.game_id);
const started = Object.assign(clone(G1), { game_id: '999', start_utc: '2026-10-20T19:00:00Z', frozen_at: '2026-10-20T15:23:00Z' });
const evS = [Object.assign(ev(started, 'LIVE'))];
RES.join(evS, { nba: Object.assign({}, SLATE, { games: [] }), nbaRecent: { schema: C.SCHEMA.recent, games: [started] } }, { now: Date.parse('2026-10-20T20:00:00Z') });
chk('a live game links to its frozen research', evS[0].research.module === 'nba' && evS[0].research.entity === '999' && evS[0].research.model && evS[0].research.model.frozen_at === '2026-10-20T15:23:00Z', evS[0].research);
const evR = [ev(started, 'LIVE')];
RES.join(evR, { nba: Object.assign({}, SLATE, { games: [Object.assign(clone(started), { frozen_at: undefined, predicted_at: '2026-10-20T19:30:00Z' })] }), nbaRecent: { schema: C.SCHEMA.recent, games: [started] } }, { now: Date.parse('2026-10-20T20:00:00Z') });
chk('a started game the slate still lists reads the research frozen before tip', evR[0].research.model.frozen_at === '2026-10-20T15:23:00Z');
const evN = [ev(started, 'LIVE')];
RES.join(evN, { nba: Object.assign({}, SLATE, { games: [] }), nbaRecent: null }, { now: Date.parse('2026-10-20T20:00:00Z') });
chk('…and without research there is no link (never a guess)', !evN[0].research.module);
const swap = [Object.assign(ev(G1, 'SCHEDULED'), { home: { abbr: G1.away.abbr }, away: { abbr: G1.home.abbr } })];
RES.join(swap, { nba: SLATE }, { now: NOW });
chk('the same id with the sides the other way round keeps its link but sets no number against the price', swap[0].research.module === 'nba' && swap[0].research.sides_swapped === true && swap[0].research.model === null);

failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 400) : '')));
console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'NBA graphic, started games and Today’s Games — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
