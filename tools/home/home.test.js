#!/usr/bin/env node
/* ===========================================================================
   THE LANDING PAGE'S LIVE HALF, OFFLINE: lib/edgedesk_home.js (the view
   model the landing page, the first-run screen and the trial emails share),
   lib/edgedesk_track.js (the funnel client) and football/home/board.json
   (tools/home/build_home.js).

     1  nothing is fabricated: no data → no number (null, never 0); a count
        of zero is hidden, not printed as a claim
     2  staleness is judged at VIEW time against the capture's schedule by
        hours to kickoff: a game market is listed up to 3 h old near kickoff
        (6 · 12 · 24 h as kickoff recedes); a prop price is FRESH ≤15 min,
        AGING ≤30, STALE ≤90 (research-grade → WATCH), then on schedule up to
        1.5 capture cadences (WATCH at most, no EV), DATA INCOMPLETE beyond;
        listed_games / listed_props never carry DATA INCOMPLETE
     3  the hero preview is both pillars: two RESEARCH / WATCH game markets
        and one player prop on a current price (a third game without one),
        nothing promoted to fill space; on a phone the prop is the second
        card; the hero's count is GAMES worth researching, each once, and
        only while it is selective
     4  the four public words are the only words; never BET / LOCK / PICK
     5  the tracker: known names only, one per entity per page load, no
        e-mail / token / query string ever leaves, batches of ≤25, and its
        name list is funnel.sql's client registry exactly
     6  board.json: small, self-consistent, every price carries its time

   (The JS status rule is held equal to the SQL one in home_sql.test.js,
   against a real PostgreSQL.)

   Run: node tools/home/home.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const H = require(path.join(ROOT, 'lib', 'edgedesk_home.js'));
const BH = require('./build_home.js');

let pass = 0, fail = 0; const failures = [];
function chk(label, ok, detail) { if (ok) pass++; else { fail++; failures.push(label + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 400) : '')); } }

const NOW = Date.parse('2026-10-01T18:00:00Z');
const ago = (min) => new Date(NOW - min * 60e3).toISOString();
const ahead = (h) => new Date(NOW + h * 3600e3).toISOString();

function prop(id, o) {
  return Object.assign({
    id, prop_id: 'cfb|1|' + id + '|rec_yds', league: 'cfb', game_key: 'cfb|1',
    matchup: { home: 'Iowa', away: 'Ohio State', kickoff: ahead(30) },
    player: { name: 'Player ' + id, team: 'Iowa', position: 'WR' }, market: { key: 'rec_yds', label: 'Receiving Yards' },
    selection: { side: 'under', line: 44.5, text: 'Under 44.5 receiving yards' },
    price: { american: -110, book: 'draftkings', captured_at: ago(8), books_at_line: 3 },
    projection: { mean: 38.2, median: 35, p25: 20, p75: 55 }, probability: 0.58, fair_american: -138, break_even: 0.524,
    ev: 0.041, ev_raw: 0.07, decision: 'LEAN', research_grade: true, research_score: 70, why: ['a'], concerns: ['b']
  }, o || {});
}
function game(key, o) {
  return Object.assign({
    game_key: key, league: 'cfb', home: 'Iowa', away: 'Ohio State', kickoff_at: ahead(30), status: 'RESEARCH',
    fair: { home_line: 7.7, total: null, text: 'Ohio State -7.7' }, market: { home_line: 14, text: 'Ohio State -14.0', book: 'fanduel', captured_at: ago(20), stale: false },
    gap: { points: 6.3, toward: 'home' }, win_prob_home: 0.3, reliability: { score: 71 }, props: { top: [] }
  }, o || {});
}
const rpc = (games, counts, times) => ({ ok: true, schema: 'edgedesk_home_board/1', games, counts: counts || {}, times: times || {} });

/* ── 1 nothing fabricated ─────────────────────────────────────────────── */
let v = H.build(null, null, NOW);
chk('no data: not live, nothing to preview', v.ok === false && v.live === false && v.games.length === 0 && v.props.length === 0 && v.preview.length === 0);
chk('no data: every count is null, never a zero', Object.keys(v.counts).every((k) => v.counts[k] === null), v.counts);
chk('no data: no freshness text', v.times.updated_text === null && v.times.model_text === null && v.times.odds_text === null);
v = H.build(rpc([], { games_analyzed: 0, props_tracked: 0, sportsbook_quotes: 0 }), null, NOW);
chk('a zero headline stat is hidden (null), not printed as "0 games analyzed"', v.counts.games_analyzed === null && v.counts.props_tracked === null && v.counts.sportsbook_quotes === null);
v = H.build(rpc([game('cfb|1', { fair: {}, market: {} })]), null, NOW);
chk('a game without numbers prints no numbers', v.games[0].fair_text === null && v.games[0].market_text === null && v.games[0].projected_text === null);
chk('…and is DATA INCOMPLETE with a reason, whatever label arrived', v.games[0].status === 'DATA_INCOMPLETE' && /market/.test(v.games[0].status_note), v.games[0].status_note);
v = H.build(rpc([game('cfb|1', { fair: {} })]), null, NOW);
chk('a market without EdgeDesk\'s number is not research', v.games[0].status === 'DATA_INCOMPLETE' && /not priced/.test(v.games[0].status_note));
v = H.build(rpc([game('cfb|1')], { games_analyzed: 12, game_research: 1, watching: 3, passes: 5, data_incomplete: 3, sportsbook_quotes: 480 }, { model_updated_at: ago(12), market_updated_at: ago(20) }), null, NOW);
chk('counts come straight from the database answer', v.counts.games_analyzed === 12 && v.counts.game_research === 1 && v.counts.watching === 3 && v.counts.sportsbook_quotes === 480, v.counts);
chk('"updated" is the most recent of model and odds', v.times.updated_text === '12 min ago' && v.times.model_text === '12 min ago' && v.times.odds_text === '20 min ago', v.times);
chk('without a prop summary, player-prop research is not invented', v.counts.prop_research === null && v.counts.props_tracked === null);
chk('the fair and market lines are the numbers given', /7\.7/.test(v.games[0].fair_text) && /14\.0/.test(v.games[0].market_text) && v.games[0].gap_text === '6.3 pts');
chk('one minus sign everywhere', v.games[0].fair_text.indexOf('-') < 0 && v.games[0].fair_text.indexOf('−') > 0, v.games[0].fair_text);

/* ── 2 staleness at view time ─────────────────────────────────────────── */
v = H.build(rpc([game('cfb|1', { kickoff_at: ahead(3), market: { home_line: 14, book: 'fanduel', captured_at: ago(200) } })]), null, NOW);
chk('near kickoff, a game market older than 3 h is DATA INCOMPLETE, and says why', v.games[0].status === 'DATA_INCOMPLETE' && /stale/.test(v.games[0].status_note) && v.games[0].market_stale === true, v.games[0]);
chk('…and is never listed', v.listed_games.length === 0 && v.live === false);
v = H.build(rpc([game('cfb|1', { market: { home_line: 14, book: 'fanduel', captured_at: ago(200) } })]), null, NOW);
chk('30 h out, the same 200-minute-old market is on schedule: its status stands, its age is printed plainly', v.games[0].status === 'RESEARCH' && v.games[0].market_stale === false && v.games[0].market_age_text === '3 h ago' && v.listed_games.length === 1, v.games[0]);
v = H.build(rpc([game('cfb|1', { market: { home_line: 14, captured_at: ago(13 * 60) } })]), null, NOW);
chk('…but 13 h old it is overdue (12 h window from 24 to 72 h out)', v.games[0].status === 'DATA_INCOMPLETE' && v.listed_games.length === 0);
chk('game windows by hours to kickoff: 3 · 6 · 12 · 24 h, the strictest when kickoff is unknown',
  [2, 12, 30, 100].map((h) => H.gameWindow(ahead(h), NOW)).join() === '180,360,720,1440' && H.gameWindow(null, NOW) === 180);
v = H.build(rpc([game('cfb|1', { kickoff_at: ahead(3), market: { home_line: 14, captured_at: ago(200) } }), game('cfb|2', { kickoff_at: ahead(3), status: 'WATCH', market: { home_line: 3, captured_at: ago(300) } }), game('cfb|3')],
  { games_analyzed: 3, game_research: 2, watching: 1, passes: 0, data_incomplete: 0 }, { model_updated_at: ago(10), market_updated_at: ago(20) }), null, NOW);
chk('the headline counts follow a view-time downgrade (never "2 research-grade" over a board showing one)', v.counts.game_research === 1 && v.counts.watching === 0 && v.counts.data_incomplete === 2, v.counts);
chk('…and so does the hero\'s "worth researching"', v.counts.worth_researching === 1, v.counts);
v = H.build(rpc([game('cfb|1')], { games_analyzed: 1 }, { model_updated_at: ago(240), market_updated_at: ago(200) }), null, NOW);
chk('nothing refreshed in 3 h: the board is not "live"', v.times.stale === true && v.times.updated_text === '3 h ago');
chk('…and a fresh one is', H.build(rpc([game('cfb|1')], {}, { model_updated_at: ago(10) }), null, NOW).times.stale === false);
v = H.build(rpc([game('cfb|1', { market: { home_line: 14, captured_at: ago(20), stale: true } })]), null, NOW);
chk('a market the database marked stale is DATA INCOMPLETE', v.games[0].status === 'DATA_INCOMPLETE');
const ps = (min) => H.priceState(ago(min), NOW);
chk('prop price windows: FRESH ≤15 · AGING ≤30 · STALE ≤90 · EXPIRED beyond', ps(10) === 'FRESH' && ps(15) === 'FRESH' && ps(25) === 'AGING' && ps(60) === 'STALE' && ps(91) === 'EXPIRED' && H.priceState(null, NOW) === 'UNKNOWN');
let pv = H.propView(prop('a'), NOW);
chk('a fresh research-grade LEAN is RESEARCH with its EV', pv.status === 'RESEARCH' && pv.ev_text === '+4.1%' && pv.odds_text === '−110' && pv.book === 'DraftKings' && pv.age_text === '8 min ago', pv);
pv = H.propView(prop('a', { price: { american: -110, book: 'draftkings', captured_at: ago(45) } }), NOW);
chk('the same prop at 45 min is WATCH, with a re-check note', pv.status === 'WATCH' && /re-check/.test(pv.status_note) && pv.price_state === 'STALE');
pv = H.propView(prop('a', { price: { american: -110, book: 'draftkings', captured_at: ago(120) } }), NOW);
chk('at 2 h, 30 h before kickoff, it is on the capture\'s schedule: WATCH, no EV, and says why', pv.status === 'WATCH' && pv.price_state === 'SCHEDULED' && pv.ev === null && pv.ev_text === null && pv.ev_raw_text === null && /normal schedule/.test(pv.status_note), pv);
pv = H.propView(prop('a', { matchup: { home: 'Iowa', away: 'Ohio State', kickoff: ahead(3) }, price: { american: -110, book: 'draftkings', captured_at: ago(120) } }), NOW);
chk('at 2 h, 3 h before kickoff, it is DATA INCOMPLETE and no EV is printed', pv.status === 'DATA_INCOMPLETE' && pv.ev === null && pv.ev_text === null && /Stale price/.test(pv.status_note), pv);
pv = H.propView(prop('a', { price: { american: -110, book: 'draftkings', captured_at: ago(240) } }), NOW);
chk('at 4 h, 30 h before kickoff, the capture is overdue: DATA INCOMPLETE', pv.status === 'DATA_INCOMPLETE' && pv.ev_text === null);
pv = H.propView(prop('a', { matchup: null, price: { american: -110, book: 'draftkings', captured_at: ago(120) } }), NOW, ahead(72));
chk('a prop without its own kickoff is judged by its game\'s', pv.status === 'WATCH' && pv.price_state === 'SCHEDULED');
chk('…and without any kickoff, by the strictest window', H.propView(prop('a', { matchup: null, price: { american: -110, book: 'draftkings', captured_at: ago(120) } }), NOW).status === 'DATA_INCOMPLETE');
chk('prop windows by hours to kickoff follow the capture cadence: 90 · 90 · 90 · 180 · 540 min',
  [1, 4, 12, 30, 100].map((h) => H.propWindow(ahead(h), NOW)).join() === '90,90,90,180,540');
chk('an on-schedule PASS stays PASS, its EV still withheld', (function () { const x = H.propView(prop('a', { decision: 'PASS', price: { american: -110, book: 'draftkings', captured_at: ago(120) } }), NOW); return x.status === 'PASS' && x.ev_text === null; })());
pv = H.propView(prop('a', { price: { book: 'draftkings', captured_at: ago(5) } }), NOW);
chk('no price → DATA INCOMPLETE ("No sportsbook price is on file")', pv.status === 'DATA_INCOMPLETE' && /No sportsbook price/.test(pv.status_note));
pv = H.propView(prop('a', { ev: null }), NOW);
chk('no EV → DATA INCOMPLETE, not a guess', pv.status === 'DATA_INCOMPLETE' && pv.ev_text === null);
pv = H.propView(prop('a', { decision: 'PASS' }), NOW);
chk('the engine\'s PASS stays PASS', pv.status === 'PASS');
pv = H.propView(prop('a', { research_grade: false, ev: 0.02 }), NOW);
chk('a positive EV that is not research-grade is WATCH, never RESEARCH', pv.status === 'WATCH');
chk('an Under with the projection below the line SUPPORTS the side', H.propView(prop('a'), NOW).supports === true && H.propView(prop('a', { selection: { side: 'over', line: 44.5 } }), NOW).supports === false);
chk('a model-estimated probability says so', H.propView(prop('a', { probability_label: 'MODEL-ESTIMATED' }), NOW).ev_label === 'model-estimated');

/* prop research counts only while that league's capture is fresh */
const stat = (capMin, grade) => ({ schema: 'edgedesk_home_static/1', props: { counts: { cfb: { research_grade: grade, capture: { last_success_at: ago(capMin) } }, total: { props: 2400 } }, items: { a: prop('a'), b: prop('b', { research_score: 90 }) }, top: ['a', 'b'], by_game: {} } });
v = H.build(rpc([]), stat(30, 24), NOW);
chk('a fresh capture\'s research-grade count is the headline', v.counts.prop_research === 24 && v.counts.props_tracked === 2400, v.counts);
v = H.build(rpc([]), stat(180, 24), NOW);
chk('a stale capture\'s count is dropped for what is research-grade NOW', v.counts.prop_research === 2, v.counts);
chk('research-grade props lead, best research score first', v.props[0].id === 'b' && v.props[1].id === 'a');
const agedItems = stat(4, 24); agedItems.props.items = { a: prop('a', { price: { american: -110, book: 'draftkings', captured_at: ago(46) } }) };
v = H.build(rpc([]), agedItems, NOW);
chk('a fresh capture whose printed props have aged to WATCH claims no research-grade props', v.counts.prop_research === null && v.props[0].status === 'WATCH', v.counts);

/* ── 3 the hero preview ───────────────────────────────────────────────── */
const g4 = [game('cfb|1'), game('cfb|2', { status: 'WATCH' }), game('cfb|3', { status: 'PASS' }), game('cfb|4', { status: 'DATA_INCOMPLETE' })];
const kinds = (x) => x.preview.map((i) => i.kind).join();
const onlyProps = (items) => ({ schema: 'edgedesk_home_static/1', props: { counts: {}, items, top: Object.keys(items), by_game: {} } });
v = H.build(rpc(g4), stat(30, 24), NOW);
chk('the preview is both pillars: two game markets, then one player prop', kinds(v) === 'game,game,prop', kinds(v));
chk('…the game markets are RESEARCH or WATCH, research first', v.preview[0].game.status === 'RESEARCH' && v.preview[1].game.status === 'WATCH');
chk('…the prop is the strongest current one (RESEARCH, best research score)', v.preview[2].prop.id === 'b' && v.preview[2].prop.status === 'RESEARCH', v.preview[2].prop.id);
const pp = v.preview[2].prop;
chk('…and carries player, prop type, line, projection, difference, status, book and capture age',
  pp.player === 'Player b' && pp.market === 'Receiving Yards' && pp.line_text === '44.5' && pp.projection_text === '38.2' && pp.difference_text === '−6.3'
  && pp.status_label === 'RESEARCH' && pp.book === 'DraftKings' && pp.age_text === '8 min ago', pp);
v = H.build(rpc([game('cfb|1'), game('cfb|2', { status: 'WATCH' }), game('cfb|5', { status: 'WATCH' }), game('cfb|6')]), null, NOW);
chk('without a current prop, a third game takes the prop\'s slot', kinds(v) === 'game,game,game', kinds(v));
v = H.build(rpc(g4.concat(game('cfb|5', { status: 'WATCH' }))), onlyProps({ x: prop('x', { price: { american: -110, book: 'draftkings', captured_at: ago(600) } }) }), NOW);
chk('a DATA INCOMPLETE prop never fills the slot (a game does)', kinds(v) === 'game,game,game', kinds(v));
v = H.build(rpc(g4), onlyProps({ k: prop('k', { matchup: { home: 'Iowa', away: 'Ohio State', kickoff: ago(20) } }) }), NOW);
chk('a prop whose game has kicked off is not previewed', kinds(v) === 'game,game', kinds(v));
v = H.build(rpc(g4), onlyProps({ n: prop('n', { projection: { mean: null } }) }), NOW);
chk('a prop without EdgeDesk\'s projection is not previewed', kinds(v) === 'game,game', kinds(v));
v = H.build(rpc(g4), onlyProps({ w: prop('w', { research_grade: false, research_score: 99 }), r: prop('r', { research_score: 50 }) }), NOW);
chk('a RESEARCH prop takes the slot before a higher-scored WATCH', v.preview[2].prop.id === 'r', v.preview.map((i) => i.kind === 'prop' ? i.prop.id : i.kind));
v = H.build(rpc(g4), onlyProps({ p: prop('p', { decision: 'PASS' }) }), NOW);
chk('with nothing stronger, a current PASS prop is shown AS PASS, never relabelled', v.preview[2].kind === 'prop' && v.preview[2].prop.status_label === 'PASS');
v = H.build(rpc([game('cfb|3', { status: 'PASS' })]), null, NOW);
chk('a board of PASSes previews nothing rather than promoting one', v.preview.length === 0 && v.live === true);

/* on a phone: one of each pillar first, then the rest, nothing added or dropped */
const ids = (items) => items.map((i) => i.kind === 'prop' ? 'p:' + i.prop.id : 'g:' + i.game.game_key).join();
v = H.build(rpc(g4), stat(30, 24), NOW);
chk('phone: a game market, then the player prop, then the second game', ids(H.pillarsFirst(v.preview)) === 'g:cfb|1,p:b,g:cfb|2', ids(H.pillarsFirst(v.preview)));
chk('…the build\'s own order is left as it was (the desktop column)', kinds(v) === 'game,game,prop', kinds(v));
v = H.build(rpc([game('cfb|1'), game('cfb|2', { status: 'WATCH' }), game('cfb|5', { status: 'WATCH' })]), null, NOW);
chk('phone: without a current prop the three games stand', ids(H.pillarsFirst(v.preview)) === 'g:cfb|1,g:cfb|2,g:cfb|5', ids(H.pillarsFirst(v.preview)));
v = H.build(rpc([game('cfb|3', { status: 'PASS' })]), stat(30, 24), NOW);
chk('phone: a prop with no game market beside it stays alone, nothing promoted', ids(H.pillarsFirst(v.preview)) === 'p:b', ids(H.pillarsFirst(v.preview)));
chk('phone: an empty preview stays empty', H.pillarsFirst([]).length === 0 && H.pillarsFirst(null).length === 0);

/* a prop from a game's own block carries no matchup: it reads with its game's */
const cardProp = prop('c'); delete cardProp.matchup;
v = H.build(rpc([game('cfb|1', { home: 'Northwestern', away: 'Penn State', props: { top: [cardProp] } })]), null, NOW);
const cm = (v.preview[1] && v.preview[1].prop.matchup) || {};
chk('a game card\'s prop takes that game\'s matchup and kickoff', cm.away === 'Penn State' && cm.home === 'Northwestern' && cm.kickoff === ahead(30), cm);
v = H.build(rpc([game('cfb|1', { kickoff_at: ago(20), props: { top: [cardProp] } })]), null, NOW);
chk('…so a game card\'s prop is not previewed once its game has kicked off', !v.preview.some((i) => i.kind === 'prop'), kinds(v));

/* the hero's count: games worth researching, each once, and selective */
const worthStat = (capMin, byGame) => ({ schema: 'edgedesk_home_static/1', props: {
  counts: { cfb: { research_grade: 14, capture: { last_success_at: ago(capMin) } } },
  items: { a: prop('a'), b: prop('b', { game_key: 'cfb|2' }) }, top: ['a', 'b'], by_game: byGame } });
const three = [game('cfb|1'), game('cfb|2', { status: 'WATCH' }), game('cfb|3', { status: 'PASS' })];
v = H.build(rpc(three, { games_analyzed: 30, game_research: 1 }), worthStat(5, { 'cfb|1': { research_grade: 3 }, 'cfb|2': { research_grade: 11 } }), NOW);
chk('the hero count is in games: a RESEARCH game with its own props once, a game with eleven research-grade props once',
  v.counts.worth_researching === 2 && v.counts.game_research + v.counts.prop_research === 15, v.counts);
v = H.build(rpc(three, { games_analyzed: 30, game_research: 1 }), worthStat(5, { 'cfb|1': { research_grade: 3 }, 'cfb|9': { research_grade: 4 } }), NOW);
chk('a fresh capture\'s per-game summary adds the games whose props are not printed', v.counts.worth_researching === 3, v.counts);
v = H.build(rpc(three, { games_analyzed: 30, game_research: 1 }), worthStat(180, { 'cfb|1': { research_grade: 3 }, 'cfb|9': { research_grade: 4 } }), NOW);
chk('a stale capture\'s summary is not read: only games with a prop RESEARCH now', v.counts.worth_researching === 2, v.counts);
v = H.build(rpc(three, { games_analyzed: 30, game_research: 5 }), worthStat(5, { 'cfb|9': { research_grade: 4 } }), NOW);
chk('RESEARCH games past the listed eight add only what no unlisted prop game could be (a floor)', v.counts.worth_researching === 6, v.counts);
const onCard = prop('z', { game_key: undefined, matchup: undefined });
v = H.build(rpc([game('cfb|1'), game('cfb|2', { status: 'WATCH', props: { top: [onCard] } }), game('cfb|3', { status: 'PASS' })], { games_analyzed: 30, game_research: 1 }), null, NOW);
chk('a research-grade prop known only from its game\'s card (no game_key of its own) counts that game', v.counts.worth_researching === 2, v.counts);
v = H.build(rpc(three, { games_analyzed: 30, game_research: 1 }), onlyProps({ k: prop('k', { game_key: 'cfb|7', matchup: { home: 'A', away: 'B', kickoff: ago(20) } }) }), NOW);
chk('a prop whose game has kicked off adds no game', v.counts.worth_researching === 1, v.counts);
v = H.build(rpc(three, { games_analyzed: 5, game_research: 1 }), worthStat(5, {}), NOW);
chk('over a third of the games analyzed, the count is left out — never "most of the slate"', v.counts.worth_researching === null && v.counts.game_research === 1, v.counts);
v = H.build(rpc(three, { games_analyzed: 6, game_research: 1 }), worthStat(5, {}), NOW);
chk('…a third exactly still shows', v.counts.worth_researching === 2, v.counts);
v = H.build(rpc(three, { game_research: 1 }), worthStat(5, {}), NOW);
chk('without the games analyzed to compare with, it is left out', v.counts.worth_researching === null, v.counts);
v = H.build(rpc([game('cfb|3', { status: 'PASS' })], { games_analyzed: 30, game_research: 0 }), null, NOW);
chk('nothing worth researching is hidden (null), never "0 worth researching"', v.counts.worth_researching === null, v.counts);
chk('the board sorts RESEARCH, WATCH, PASS, DATA INCOMPLETE', H.build(rpc(g4.slice().reverse()), null, NOW).games.map((g) => g.status).join() === 'RESEARCH,WATCH,PASS,DATA_INCOMPLETE');
v = H.build(rpc(g4), { schema: 'edgedesk_home_static/1', props: { counts: {}, items: { a: prop('a'), x: prop('x', { price: { american: -110, captured_at: ago(600) } }) }, top: ['a', 'x'], by_game: {} } }, NOW);
chk('what is listed leaves DATA INCOMPLETE out, games and props alike', v.listed_games.map((g) => g.status).join() === 'RESEARCH,WATCH,PASS' && v.listed_props.map((p) => p.id).join() === 'a' && v.props.length === 2, [v.listed_games.map((g) => g.status), v.listed_props.map((p) => p.id)]);
chk('a college book arrives as "captured · pinnacle" and reads as the book', H.bookName('captured · pinnacle') === 'Pinnacle' && H.bookName('captured · ') === null && H.bookName('fanduel') === 'FanDuel');

/* ── 4 words and links ────────────────────────────────────────────────── */
chk('the four public words are the only words', Object.keys(H.STATUS).join() === 'RESEARCH,WATCH,PASS,DATA_INCOMPLETE' && !/\b(BET|LOCK|PICK)\b/.test(JSON.stringify(H.STATUS).replace(/not a bet|never a pick/gi, '')));
v = H.build(rpc([game('cfb|1', { sample: true }), game('nfl|2026_05_KC_BUF', { league: 'nfl', home: 'Buffalo Bills', away: 'Kansas City Chiefs', status: 'WATCH' })]), null, NOW);
chk('a public sample link only where an admin made the game public', v.games[0].sample_url === '/research/sample/?game=cfb%7C1' && v.games[1].sample_url === null);
chk('terminal links: college by game id, NFL with its league prefix', v.games[0].app_hash === '#research/football/1' && v.games[1].app_hash === '#research/football/nfl|2026_05_KC_BUF', v.games.map((g) => g.app_hash));
chk('NFL numbers read with team codes', /BUF|KC/.test(v.games[1].fair_text), v.games[1].fair_text);

/* the signed-in copy: research-state rows → the same shape */
const rows = [
  { game_key: 'cfb|1', sport: 'cfb', home: 'Iowa', away: 'Ohio State', kickoff_at: ahead(20), projected: true, status: 'RESEARCH', research_label: 'WORTH_RESEARCHING', research_grade: true, market_home_line: 14, market_stale: false, gap_pts: 6.3, fair_home_line: 7.7, market_captured_at: ago(20), computed_at: ago(5) },
  { game_key: 'cfb|2', sport: 'cfb', home: 'A', away: 'B', kickoff_at: ahead(20), projected: true, status: 'AGREEMENT', research_grade: false, market_home_line: -3, market_stale: false, gap_pts: 0.5, computed_at: ago(9) },
  { game_key: 'cfb|3', sport: 'cfb', home: 'C', away: 'D', kickoff_at: ahead(20), projected: true, status: 'NO MARKET', research_grade: false, market_home_line: null, gap_pts: null, computed_at: ago(9) },
  { game_key: 'cfb|old', sport: 'cfb', home: 'E', away: 'F', kickoff_at: ago(60), projected: true, status: 'RESEARCH', research_grade: true, market_home_line: -3, gap_pts: 5 },
  { game_key: 'cfb|far', sport: 'cfb', home: 'G', away: 'H', kickoff_at: ahead(24 * 10), projected: true, status: 'RESEARCH', research_grade: true, market_home_line: -3, gap_pts: 5 }
];
const fr = H.fromStateRows(rows, NOW);
chk('state rows: only games kicking off in the next 8 days', fr.games.map((g) => g.game_key).join() === 'cfb|1,cfb|2,cfb|3');
chk('state rows: the four counts add up', fr.counts.game_research === 1 && fr.counts.passes === 1 && fr.counts.data_incomplete === 1 && fr.counts.watching === 0 && fr.counts.games_on_slate === 3, fr.counts);
chk('state rows: a DATA INCOMPLETE game says why', fr.games[2].status_note === 'No current sportsbook market has been captured.');
chk('state rows: times are the newest real ones', fr.times.model_updated_at === ago(5) && fr.times.market_updated_at === ago(20));

/* ── 5 the tracker ────────────────────────────────────────────────────── */
function store() { const m = {}; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: (k) => { delete m[k]; }, _m: m }; }
const sent = [];
Object.assign(globalThis, {
  localStorage: store(), sessionStorage: store(),
  location: { pathname: '/', search: '?utm_source=Reddit&utm_medium=social!&utm_campaign=wk5%20launch&email=a@b.com', hostname: 'edgedesksports.com' },
  document: { referrer: 'https://www.reddit.com/r/cfb/comments/abc?x=1', visibilityState: 'visible', addEventListener() {} },
  addEventListener() {},
  fetch: async (url, init) => { sent.push({ url, init, body: JSON.parse(init.body) }); return { ok: true }; }
});
const T = require(path.join(ROOT, 'lib', 'edgedesk_track.js'));
(async function () {
  T.configure({ url: 'https://sb.test', key: 'anon-key', flush_ms: 0, ga: false });
  T._reset();
  chk('an unknown event name is dropped before the network', T.event('page_scrolled', {}) === false && T.event('subscription_started', {}) === false && T._queue().length === 0);
  chk('a known event queues', T.event('landing_view', { surface: 'hero' }) === true && T._queue().length === 1);
  chk('the same event twice on one page load queues once (re-renders cannot double-count)', T.event('landing_view', { surface: 'hero' }) === false && T._queue().length === 1);
  chk('a different entity is a different event', T.event('game_opened', { entity: 'cfb|1' }) && T.event('game_opened', { entity: 'cfb|2' }) && !T.event('game_opened', { entity: 'cfb|1' }));
  chk('a different CTA is a different click', T.event('cta_clicked', { cta: 'hero_board' }) && T.event('cta_clicked', { cta: 'pricing' }) && !T.event('cta_clicked', { cta: 'pricing' }));
  chk('once:false lets it queue again (the server still dedupes)', T.event('cta_clicked', { cta: 'pricing' }, { once: false }) === true);
  const p = T._props({ entity: 'cfb|1', email: 'reader@example.com', note: 'mail me at x@y.z', Bad_Key: 1, nested: { a: 1 }, n: Infinity, ok: true, long: 'x'.repeat(500) });
  chk('props keep short scalars and drop anything with an @, objects, odd keys and non-finite numbers', p.entity === 'cfb|1' && !('email' in p) && !('note' in p) && !('Bad_Key' in p) && !('nested' in p) && !('n' in p) && p.ok === true && p.long.length === 120, p);
  const many = {}; for (let i = 0; i < 30; i++) many['k' + i] = i;
  chk('at most 16 props', Object.keys(T._props(many)).length === 16);
  const q = T._queue()[0];
  chk('context: the path without its query string', q.page_path === '/');
  chk('context: the referring HOST only', q.referrer === 'www.reddit.com');
  chk('context: utm values cleaned to [a-z0-9_.-]', q.utm_source === 'reddit' && q.utm_medium === 'social' && q.utm_campaign === 'wk5launch', q);
  await T.flush();
  chk('one request for the whole queue', sent.length === 1 && sent[0].url === 'https://sb.test/rest/v1/rpc/ed_track' && sent[0].body.p_events.length === 6, sent.map((s) => s.body.p_events.length));
  const body = JSON.stringify(sent[0].body);
  chk('nothing in the body looks like an address, a token or a query string', !/@/.test(body) && !/utm_source=|\?/.test(body) && !/anon-key|access_token/.test(body));
  chk('a visitor id and a session id ride along', /^[a-f0-9]{36}$/.test(sent[0].body.p_visitor) && /^[a-f0-9]{24}$/.test(sent[0].body.p_session), [sent[0].body.p_visitor, sent[0].body.p_session]);
  chk('the visitor id is the page\'s shared one (localStorage edgedesk_visitor)', globalThis.localStorage.getItem('edgedesk_visitor') === sent[0].body.p_visitor);
  chk('signed out, the request carries the anon key', sent[0].init.headers.authorization === 'Bearer anon-key' && sent[0].init.credentials === 'omit');
  globalThis.localStorage.setItem('edgedesk_session', JSON.stringify({ access_token: 'user-jwt', expires_at: Math.floor(Date.now() / 1000) + 3600 }));
  T.event('board_viewed', {}); await T.flush();
  chk('signed in, the reader\'s own token — the server takes the user from it, never from the body', sent[1].init.headers.authorization === 'Bearer user-jwt' && !/user-jwt/.test(sent[1].init.body));
  globalThis.localStorage.setItem('edgedesk_session', JSON.stringify({ access_token: 'old-jwt', expires_at: Math.floor(Date.now() / 1000) - 10 }));
  T.event('prop_board_opened', {}); await T.flush();
  chk('an expired token is not used', sent[2].init.headers.authorization === 'Bearer anon-key');
  T._reset();
  for (let i = 0; i < 30; i++) T.event('prop_opened', { entity: 'p' + i });
  const before = sent.length; await T.flush();
  chk('batches of at most 25', sent.length - before === 2 && sent[before].body.p_events.length === 25 && sent[before + 1].body.p_events.length === 5);
  T._reset(); T.configure({ enabled: false });
  chk('switched off, nothing queues', T.event('landing_view', {}) === false && T._queue().length === 0);
  T.configure({ enabled: true });
  const sid = T.session(Date.now());
  chk('a session holds inside 30 minutes idle', T.session(Date.now() + 29 * 60e3) === sid);
  chk('and renews after', T.session(Date.now() + 29 * 60e3 + 31 * 60e3) !== sid);
  globalThis.fetch = async () => { throw new Error('offline'); };
  T._reset(); T.event('landing_view', {});
  chk('an offline phone costs the reader nothing (flush resolves false, never throws)', (await T.flush()) === false);

  const FSQL = fs.readFileSync(path.join(ROOT, 'supabase', 'funnel.sql'), 'utf8');
  const clientKinds = [...FSQL.matchAll(/^\s*\('([a-z_0-9]+)',\s*'client'/gm)].map((m) => m[1]).sort();
  chk('the tracker\'s names are funnel.sql\'s client registry exactly', JSON.stringify(T.CLIENT.slice().sort()) === JSON.stringify(clientKinds), { js: T.CLIENT.length, sql: clientKinds.length });

  /* ── 6 board.json ─────────────────────────────────────────────────── */
  const RAW = fs.readFileSync(path.join(ROOT, 'football', 'home', 'board.json'), 'utf8');
  const S = JSON.parse(RAW);
  chk('board.json is the static schema, and small (< 64 KB)', S.schema === 'edgedesk_home_static/1' && Buffer.byteLength(RAW) < 64 * 1024, Buffer.byteLength(RAW));
  chk('props.top: at most 12 ids, each printed once in items', S.props.top.length <= BH.LIMITS.top && S.props.top.every((id) => S.props.items[id]));
  chk('props.by_game: at most 3 ids a game, each in items', Object.values(S.props.by_game).every((g) => (g.top || []).length <= BH.LIMITS.per_game && (g.top || []).every((id) => S.props.items[id])));
  chk('every printed prop carries its price and the time it was captured', Object.values(S.props.items).every((p) => p.price && typeof p.price.american === 'number' && isFinite(Date.parse(p.price.captured_at))));
  chk('every college game EV carries the exact quote it is for', Object.values(S.game_ev).every((e) => e.selection && typeof e.price === 'number' && e.book && isFinite(Date.parse(e.captured_at)) && 'calibrated_ev' in e && 'raw_ev' in e));
  chk('the landing page no longer needs the 6 MB ratings file', !!S.ratings && Array.isArray(S.ratings.top) && S.ratings.top.length <= 5);
  /* the committed file is a snapshot: other jobs (cfb-terminal.yml, hourly)
     move its inputs between player-props.yml rebuilds, so it is NOT compared
     with a rebuild — the build itself must be deterministic, and a rebuild
     must have the committed file's shape */
  const a1 = BH.build({ now: S.generated_at }), a2 = BH.build({ now: S.generated_at });
  chk('build_home is deterministic: the same artifacts, the same file', JSON.stringify(a1) === JSON.stringify(a2));
  chk('a rebuild has the committed file\'s shape', a1.schema === S.schema && JSON.stringify(Object.keys(a1)) === JSON.stringify(Object.keys(S)) && JSON.stringify(Object.keys(a1.props)) === JSON.stringify(Object.keys(S.props)));
  chk('a rebuild keeps its own limits', a1.props.top.length <= BH.LIMITS.top && a1.props.top.every((id) => a1.props.items[id]) && Buffer.byteLength(JSON.stringify(a1)) < 64 * 1024);
  /* THE SIZE BUDGET, on a week with far more games than any one hour has: a
     real research-grade opportunity, copied onto 120 games a day apart in
     kickoff. The file must stay under budget, the top list untouched, every
     id resolvable, and the cards taken off the LATEST games first. */
  {
    const real = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'props', 'nfl', 'summary.json'), 'utf8'));
    const evs = Array.isArray(real.events) ? real.events : Object.values(real.events || {});
    /* the template card: a real research-grade opportunity from the committed
       board when the week has one; between slates the board can hold none (16
       NFL events and no opportunities on 2026-10-02), and then the probe's own
       committed props block (tools/home/fixtures/props_block.json) */
    const probe = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'props_block.json'), 'utf8')).props.top_opportunities;
    const src = evs.map((e) => (e.top_opportunities || []).find((o) => o.research && o.research.grade)).filter(Boolean)[0]
      || probe.find((o) => o.research && o.research.grade);
    chk('size budget: a research-grade card to build the week from', !!src);
    const t0 = Date.parse('2026-10-02T12:00:00Z');
    const many = [];
    for (let i = 0; i < 120; i++) {
      const key = 'nfl|2026_99_G' + i;
      const kick = new Date(t0 + 3600e3 + i * 3600e3).toISOString();
      const opps = [0, 1, 2].map((j) => Object.assign(JSON.parse(JSON.stringify(src)), { id: 'syn_' + i + '_' + j, prop_id: 'syn_' + i + '_' + j,
        research: Object.assign({}, src.research, { grade: true, score: 50 + ((i * 7 + j) % 40) }),
        event: Object.assign({}, src.event, { event_key: key, kickoff: kick }) }));
      many.push({ event_key: key, game_id: '2026_99_G' + i, kickoff: kick, total_props: 40, priced_props: 30, evaluated_props: 20, research_grade_count: 3, top_opportunities: opps });
    }
    const fat = { counts: { events: 120, props: 4800, priced: 3600, evaluated: 2400, research_grade: 360 }, generated_at: '2026-10-02T11:00:00Z', events: many };
    const readMany = (rel) => (rel === 'football/props/nfl/summary.json' ? fat : null);
    const unbounded = BH.build({ now: '2026-10-02T12:00:00Z', read: readMany, budget: Infinity });
    const B = BH.build({ now: '2026-10-02T12:00:00Z', read: readMany });
    const P = B.props, size = Buffer.byteLength(JSON.stringify(B));
    const carded = Object.keys(P.by_game).filter((k) => (P.by_game[k].top || []).length);
    const bare = Object.keys(P.by_game).filter((k) => !(P.by_game[k].top || []).length);
    const n = (k) => Number(k.split('_G')[1]);
    chk('size budget: the fixture really is over budget without it', Buffer.byteLength(JSON.stringify(unbounded)) > 64 * 1024, Buffer.byteLength(JSON.stringify(unbounded)));
    chk('size budget: a 120-game week builds under the budget', size <= BH.BUDGET_BYTES && size < 64 * 1024, size);
    chk('size budget: the top list is never trimmed', JSON.stringify(P.top) === JSON.stringify(unbounded.props.top) && P.top.length === BH.LIMITS.top);
    chk('size budget: every id printed resolves', P.top.concat(...carded.map((k) => P.by_game[k].top)).every((id) => P.items[id]));
    chk('size budget: no item is printed that nothing points at', Object.keys(P.items).every((id) => P.top.indexOf(id) >= 0 || carded.some((k) => P.by_game[k].top.indexOf(id) >= 0)));
    chk('size budget: the latest games give up their cards first, and keep their counts', bare.length > 0 && carded.length > 0
      && Math.min(...bare.map(n)) > Math.max(...carded.map(n)) && bare.every((k) => P.by_game[k].research_grade === 3) && Object.keys(P.by_game).length === 120, { bare: bare.length, carded: carded.length });
    chk('size budget: what was taken is counted', P.counts.trimmed && P.counts.trimmed.games === bare.length && P.counts.trimmed.budget_bytes === BH.BUDGET_BYTES, P.counts.trimmed);
    chk('size budget: deterministic', JSON.stringify(B) === JSON.stringify(BH.build({ now: '2026-10-02T12:00:00Z', read: readMany })));
    chk('size budget: a board under budget is left exactly as built', !a1.props.counts.trimmed || Buffer.byteLength(JSON.stringify(BH.build({ now: S.generated_at, budget: Infinity }))) > BH.BUDGET_BYTES);
  }
  const noRead = BH.build({ now: S.generated_at, read: () => null });
  chk('with no artifacts it writes an empty board, not an invented one', noRead.props.top.length === 0 && Object.keys(noRead.props.items).length === 0 && Object.keys(noRead.game_ev).length === 0);

  failures.forEach((f) => console.log('FAIL | ' + f));
  console.log((fail ? 'FAILED' : 'ALL GREEN') + ' home view model + tracker — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
