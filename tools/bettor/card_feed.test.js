#!/usr/bin/env node
/* ===========================================================================
   THE CARD NEVER GOES DARK — every sport, priced from the free feed.

   The day The Odds API credits ran out, every game on the EdgeDesk Card read
   NO DECISION: the football boards' live overlay (priced from the paused
   capture) replaced the build's priced decisions with NO MARKET, and no other
   sport was on the Card at all. This suite pins the fix on the real modules
   and the committed today/slate.json:

     A  the free feed reads every sport's DraftKings price and model number
     B  a feed row is never a BET, never carries units, and is capped at LEAN
     C  a too-good-to-be-true gap is WATCH · CHECK THE NUMBER; a stale price caps at WATCH
     D  no model → PRICE ONLY, no price → AWAITING LINES; neither counts as a decision
     E  the football boards get the slate's spread / total / moneyline as quotes
     F  a live NO MARKET never replaces a build decision that was priced
        (and a held BET reads WATCH until a current price confirms it)
     G  the Card page: TOP OF THE CARD, the feed strip, the sport row, every sport's rows
     H  the engine's own counts and rows are untouched (feed rows are their own class)

   Run: node tools/bettor/card_feed.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const F = require(path.join(ROOT, 'lib', 'edgedesk_card_feed.js'));
const U = require(path.join(ROOT, 'lib', 'edgedesk_decision_ui.js'));
const SLATE = require(path.join(ROOT, 'today', 'slate.json'));

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('  ok   ' + name); return; }
  fail++; console.log('FAIL | ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 600) : ''));
}
function eq(name, a, b) { chk(name, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b }); }
const text = (h) => String(h).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

/* a synthetic slate: one game per case, a fixed clock */
const NOW = Date.parse('2026-10-14T16:00:00Z');
const AT = new Date(NOW - 20 * 60000).toISOString();
function ev(id, sport, start, home, away, model, extra) {
  return Object.assign({ id: id, sport: sport, league: sport.toUpperCase(), provider: 'espn', provider_id: id.split(':').pop(), start_utc: start, status: 'SCHEDULED',
    home: { name: home, abbr: home.slice(0, 3).toUpperCase(), logo: 'https://a.espncdn.com/x/' + home + '.png' }, away: { name: away, abbr: away.slice(0, 3).toUpperCase(), logo: 'https://a.espncdn.com/x/' + away + '.png' },
    research: { module: null, model: model || null } }, extra || {});
}
const IN6H = new Date(NOW + 6 * 3600000).toISOString(), IN3D = new Date(NOW + 72 * 3600000).toISOString();
const S = {
  schema: 'edgedesk_slate/1', generated_at: AT,
  events: [
    /* NHL: model -170 home vs book -125 → the home side is value */
    ev('nhl:espn:1', 'nhl', IN6H, 'Rangers', 'Bruins', { status: 'PREDICTED', tier: 'OUTCOME_VALIDATED', data_quality: 'OK', fair: { ml_home: -170, ml_away: 170 } }),
    /* NHL: the market and the model agree */
    ev('nhl:espn:2', 'nhl', IN6H, 'Kings', 'Ducks', { status: 'PREDICTED', tier: 'OUTCOME_VALIDATED', data_quality: 'OK', fair: { ml_home: -120, ml_away: 120 } }),
    /* soccer: a 3-way market the model calls wildly differently */
    ev('soccer:espn:3', 'soccer', IN6H, 'Hull City', 'Leeds', { status: 'PREDICTED', tier: 'PROVISIONAL', data_quality: 'LIMITED', fair: { ml_home: 150, ml_draw: 260, ml_away: 260, total_over_2_5: -110 } }),
    /* NBA: a price, no model */
    ev('nba:espn:4', 'nba', IN6H, 'Celtics', 'Knicks', null),
    /* NHL: a model, no price yet */
    ev('nhl:espn:5', 'nhl', IN3D, 'Oilers', 'Flames', { status: 'PREDICTED', tier: 'OUTCOME_VALIDATED', data_quality: 'OK', fair: { ml_home: -140, ml_away: 140 } }),
    /* CFB the engine already decides: never doubled */
    ev('cfb:espn:401000001', 'cfb', IN6H, 'Texas', 'Oklahoma', { status: 'PREDICTED', fair: { spread_home: -6, home_win: 0.68 } }),
    /* a started game: never on the Card */
    ev('nba:espn:6', 'nba', new Date(NOW - 3600000).toISOString(), 'Lakers', 'Suns', null),
    /* NHL value, but the price is a day old */
    ev('nhl:espn:7', 'nhl', IN6H, 'Stars', 'Blues', { status: 'PREDICTED', tier: 'OUTCOME_VALIDATED', data_quality: 'OK', fair: { ml_home: -170, ml_away: 170 } })
  ],
  upcoming: [
    ev('nfl:espn:8', 'nfl', IN3D, 'Jaguars', 'Texans', { status: 'PREDICTED', tier: 'LEAN', data_quality: 'OK', fair: { spread_home: -1, ml_home: -110, ml_away: 110 } }, { research: { module: 'football', game_key: 'nfl|2026_07_HOU_JAX', model: { status: 'PREDICTED', tier: 'LEAN', data_quality: 'OK', fair: { spread_home: -1, ml_home: -110, ml_away: 110 } } } })
  ],
  markets: {
    'nhl:espn:1': { book: 'Draft Kings', source: 'espn_scoreboard', captured_at: AT, moneyline: { home: -125, away: 105 }, total: { point: 6.5, over: -110, under: -110 } },
    'nhl:espn:2': { book: 'Draft Kings', source: 'espn_scoreboard', captured_at: AT, moneyline: { home: -128, away: 108 } },
    'soccer:espn:3': { book: 'DraftKings', source: 'espn_scoreboard', captured_at: AT, moneyline: { home: 370, draw: 260, away: -140 }, total: { point: 2.5, over: -110, under: -110 } },
    'nba:espn:4': { book: 'Draft Kings', source: 'espn_scoreboard', captured_at: AT, moneyline: { home: -200, away: 170 }, spread: { home: { point: -5.5, price: -110 }, away: { point: 5.5, price: -110 } }, total: { point: 221.5, over: -110, under: -110 } },
    'cfb:espn:401000001': { book: 'Draft Kings', source: 'espn_scoreboard', captured_at: AT, moneyline: { home: -250, away: 200 }, spread: { home: { point: -6.5, price: -110 }, away: { point: 6.5, price: -110 } }, total: { point: 55.5, over: -108, under: -112 } },
    'nhl:espn:7': { book: 'Draft Kings', source: 'espn_scoreboard', captured_at: new Date(NOW - 26 * 3600000).toISOString(), moneyline: { home: -125, away: 105 } },
    'nfl:espn:8': { book: 'Draft Kings', source: 'espn_scoreboard', captured_at: AT, moneyline: { home: -120, away: 100 }, spread: { home: { point: -1.5, price: -110 }, away: { point: 1.5, price: -110 } }, total: { point: 44.5, over: -110, under: -110 } }
  }
};
const rows = F.rows(S, { now: NOW, covered: { 'cfb|401000001': 1 } });
const byId = {}; rows.forEach((r) => { byId[r.game_id] = r; });

console.log('— A · every sport from the free feed');
eq('one row per pregame game the engine does not decide (the started game and the decided CFB game are out)', rows.map((r) => r.game_id).sort(),
  ['nba:espn:4', 'nfl:espn:8', 'nhl:espn:1', 'nhl:espn:2', 'nhl:espn:5', 'nhl:espn:7', 'soccer:espn:3']);
chk('a row names its sport, its teams, their logos, its book and the capture time', byId['nhl:espn:1'].sport === 'NHL' && byId['nhl:espn:1'].home === 'Rangers' && /^https:/.test(byId['nhl:espn:1'].home_logo) && byId['nhl:espn:1'].book === 'DraftKings' && byId['nhl:espn:1'].quote_captured_at === AT);
const nhl = byId['nhl:espn:1'];
chk('the model number is priced at the book price: Rangers ML at −125, a positive edge', nhl.reference_quote.side === 'home' && nhl.reference_quote.odds === -125 && nhl.edge_pp > 0 && nhl.decision_ev_pct > 0, nhl.reference_quote);
chk('…pulled toward the market: the decision probability sits between the model and the no-vig market', nhl.reference_quote.model_probability > nhl.reference_quote.decision_cover && nhl.reference_quote.decision_cover > nhl.reference_quote.market_probability, nhl.reference_quote);
const st = F.status(S, { now: NOW });
chk('the feed status: games, prices, sports and the capture age', st.ok && st.games === 8 && st.priced === 7 && st.capture_age_minutes === 20 && st.sports.map((x) => x.id).join() === 'nfl,cfb,nba,nhl,soccer', st);

console.log('— B · never a BET, never units');
chk('every feed row has 0 units and no row is a BET', rows.every((r) => r.recommended_units === 0 && r.decision !== 'BET'));
eq('the NHL value is a LEAN, labelled as an unvalidated model', [nhl.decision, nhl.decision_qualifier, nhl.action_reason_code], ['LEAN', 'UNVALIDATED MODEL', 'MODEL_EDGE_UNVALIDATED']);
chk('…and says why it is capped', /not yet validated against closing prices/.test(nhl.action_reason_text));
eq('the aligned NHL game is a PASS', [byId['nhl:espn:2'].decision, byId['nhl:espn:2'].action_reason_code].join(' '), 'PASS MARKET_ALIGNED');

console.log('— C · scrutiny');
const soc = byId['soccer:espn:3'];
eq('a gap too large to believe is WATCH · CHECK THE NUMBER', [soc.decision, soc.decision_qualifier], ['WATCH', 'CHECK THE NUMBER']);
chk('…the 3-way market is read with its draw', soc.reference_quote && ['home', 'draw', 'away', 'over', 'under'].indexOf(soc.reference_quote.side) >= 0 && F.modelProbs(S.events[2].research.model, 'soccer').three_way === true);
eq('value on a day-old price is capped at WATCH · STALE PRICE', [byId['nhl:espn:7'].decision, byId['nhl:espn:7'].decision_qualifier], ['WATCH', 'STALE PRICE']);

console.log('— D · price only and awaiting lines');
eq('no model → PRICE ONLY, with the full line', [byId['nba:espn:4'].board_kind, byId['nba:espn:4'].action_reason_code], ['PRICE_ONLY', 'NO_MODEL']);
chk('…the line reads spread, total and both moneylines', /CEL -5\.5 \(-110\)/.test(byId['nba:espn:4'].market_text) && /O\/U 221\.5/.test(byId['nba:espn:4'].market_text) && /KNI \+170/.test(byId['nba:espn:4'].market_text), byId['nba:espn:4'].market_text);
eq('no price → AWAITING LINES, with EdgeDesk’s number', [byId['nhl:espn:5'].board_kind, /Oilers -140/.test(byId['nhl:espn:5'].action_reason_text)], ['AWAITING_LINES', true]);
chk('an NFL game the boards have not reached is still on the Card', byId['nfl:espn:8'] && byId['nfl:espn:8'].board_kind === 'MODEL');

console.log('— E · the football boards’ quotes');
const fq = F.footballQuotes(S, 'cfb', '401000001');
eq('CFB: spread, total and moneyline, both sides, by the ESPN id', fq.map((q) => q.market_type + ':' + q.side + ':' + (q.line == null ? '' : q.line) + ':' + q.american),
  ['spread:home:-6.5:-110', 'spread:away:6.5:-110', 'total:over:55.5:-108', 'total:under:55.5:-112', 'moneyline:home::-250', 'moneyline:away::200']);
chk('…each labelled with its book, its capture time and its source', fq.every((q) => q.book === 'DraftKings' && q.captured_at === AT && q.provider_market_key === 'espn' && q.game_id === '401000001'));
eq('NFL: found by the nflverse game id', F.footballQuotes(S, 'nfl', '2026_07_HOU_JAX').length, 6);
eq('a game the slate does not hold: no quotes, never invented', F.footballQuotes(S, 'cfb', '999').length, 0);

console.log('— F · a live NO MARKET never erases a priced build decision');
const KO = new Date(Date.now() + 86400000).toISOString();
const built = { game_id: 'g1', decision: 'PASS', kickoff: KO, evaluated_at: '2026-10-14T15:00:00Z' };
const liveNoMkt = { game_id: 'g1', decision: 'NO_DECISION', kickoff: KO, blocker_codes: ['STALE_QUOTE'], action_reason_code: 'STALE_QUOTE', evaluated_at: '2026-10-14T16:00:00Z' };
const liveNoModel = { game_id: 'g1', decision: 'NO_DECISION', blocker_codes: ['MODEL_UNAVAILABLE'], action_reason_code: 'MODEL_UNAVAILABLE', evaluated_at: '2026-10-14T16:00:00Z' };
const liveWatch = { game_id: 'g1', decision: 'WATCH', evaluated_at: '2026-10-14T16:00:00Z' };
chk('a stale-quote live decision keeps the build’s PASS', U.liveWins(liveNoMkt, built) === false);
chk('a newer evaluable live decision still wins', U.liveWins(liveWatch, built) === true);
chk('a live blocker that is not about the price still wins (a real fault)', U.liveWins(liveNoModel, built) === true);
chk('with no build decision the live one stands', U.liveWins(liveNoMkt, null) === true);
U._state.build = { decisions: [built] }; U._state.registry = { g1: liveNoMkt };
eq('mergedDecisions keeps the priced build decision (the PASS shows, not NO DECISION)', U.mergedDecisions().map((d) => d.decision), ['PASS']);
U._state.registry = { g1: Object.assign({}, liveWatch, { kickoff: KO }) };
eq('…and takes the newer live answer when it can evaluate', U.mergedDecisions().map((d) => d.decision), ['WATCH']);
const builtBet = { game_id: 'g2', decision: 'BET', recommended_units: 0.5, kickoff: KO, evaluated_at: '2026-10-14T15:00:00Z', quote_captured_at: '2026-10-14T14:58:00Z',
  bet_price: { side: 'home', team: 'Texas', line: -6.5, odds: -105, book: 'draftkings' } };
U._state.build = { decisions: [builtBet] }; U._state.registry = { g2: Object.assign({}, liveNoMkt, { game_id: 'g2' }) };
const hb = U.mergedDecisions()[0];
eq('a stale quote never BETs: a held build BET reads WATCH · QUOTE REFRESH PENDING with no stake', [hb.decision, hb.decision_qualifier, hb.recommended_units], ['WATCH', 'QUOTE REFRESH PENDING', 0]);
chk('…the build object itself is untouched', builtBet.decision === 'BET' && builtBet.recommended_units === 0.5);
U._state.build = null; U._state.registry = {};

console.log('— G · the Card page');
const engine = [{ game_id: '401000001', sport: 'CFB', home: 'Texas', away: 'Oklahoma', kickoff: IN6H, decision: 'PASS', action_reason_text: 'The price is past the number.', action_reason_code: 'CALIBRATED_EV_NEGATIVE', evaluated_at: AT, recommended_units: 0,
  reference_quote: { side: 'home', team: 'Texas', market_type: 'spread', line: -6.5, odds: -110, book: 'draftkings' } }];
const page = U.cardPageHTML(engine, { board: rows, feed: st, hero: true, view: { filter: 'all', sort: 'kickoff' }, no_health: true });
const t = text(page);
chk('TOP OF THE CARD leads with the strongest answer: the NHL LEAN, as a tile', /TOP OF THE CARD/.test(t) && /class="edc-tile edc-t-lean"/.test(page) && page.indexOf('edc-tile') < page.indexOf('edd-sech-bet'));
chk('…a CHECK THE NUMBER or stale row is never a top tile', !/edc-tile[^>]*data-edc-open="soccer:espn:3"/.test(page) && !/edc-tile[^>]*data-edc-open="nhl:espn:7"/.test(page));
chk('the feed strip says where prices come from and how old they are', /PRICES/.test(t) && /DraftKings via ESPN/.test(t) && /20 min ago/.test(t) && /7 of 8 upcoming games priced/.test(t), t.slice(0, 600));
chk('the sport row: All sports, NFL, CFB, NBA, NHL, SOCCER with counts', ['All sports', 'NFL', 'CFB', 'NBA', 'NHL', 'SOCCER'].every((x) => page.indexOf('<span>' + x + '</span>') >= 0) && /data-edd-act="sport" data-edd-v="nhl"><span>NHL<\/span> <small>4<\/small>/.test(page), page.match(/edc-sports[\s\S]{0,900}/)[0]);
chk('feed rows sit in the decision sections (LEAN, WATCHING, PASS) with their sport badge', /LEAN <small>1/.test(page) && /WATCHING <small>2/.test(page) && /PASS <small>3/.test(page) && /<span class="edc-sp">NHL<\/span> <b>Rangers ML \(-125\)<\/b>/.test(page), t.slice(0, 900));
chk('MARKET BOARD lists the priced game without a model; AWAITING LINES the modelled game without a price', /MARKET BOARD/.test(t) && /data-edc-open="nba:espn:4"/.test(page) && /AWAITING LINES/.test(t) && /data-edc-open="nhl:espn:5"/.test(page));
chk('neither is counted as a decision: 0 no decision', /0 no decision/.test(t), t.slice(0, 500));
chk('the empty BET section says how many games across how many sports were evaluated', /evaluated 6 games across 4 sports/.test(t), t.match(/No current price[^.]*\.[^.]*\./));
const nhlOnly = U.cardPageHTML(engine, { board: rows, feed: st, hero: true, view: { filter: 'all', sport: 'nhl', sort: 'kickoff' }, no_health: true });
chk('the NHL pill shows NHL only (no CFB row, no NBA board line)', /Rangers ML/.test(nhlOnly) && !/data-edd-open="401000001"/.test(nhlOnly) && !/data-edc-open="nba:espn:4"/.test(nhlOnly));
chk('a saved sport filter from before the sport row still works', /Rangers ML/.test(U.cardPageHTML(engine, { board: rows, feed: st, view: { filter: 'nhl', sort: 'kickoff' }, no_health: true })));
const noVal = U.cardPageHTML(engine, { board: [], feed: null, hero: true, view: { filter: 'all', sort: 'kickoff' }, no_health: true });
chk('with nothing close, TOP OF THE CARD says PASS is a real answer instead of going blank', /Nothing on the board is a BET, LEAN or WATCH/.test(text(noVal)));
chk('every outbound copy line stays inside the banned-words rule', U.copyOk(page));

console.log('— H · the engine’s own surface is unchanged');
const plain = U.cardPageHTML(engine, { view: { filter: 'all', sort: 'kickoff' }, no_health: true });
chk('an explicit list without a board renders no feed rows, no tiles and no strip', !/edc-row|edc-tile|edc-feed/.test(plain));
chk('engine rows keep .edd-row; feed rows are .edc-row (one class per kind)', (page.match(/class="edd-row /g) || []).length === 1 && (page.match(/class="edc-row /g) || []).length === 5);
chk('the header still reads N passes · N no decision', /\d+ pass(es)? · \d+ no decision/.test(t));

console.log('— the committed slate');
const real = F.rows(SLATE, { now: Date.parse(SLATE.generated_at) });
const sports = {}; real.forEach((r) => { sports[r.sport_id] = 1; });
chk('the committed slate puts more than one sport on the Card', Object.keys(sports).length >= 2, Object.keys(sports));
chk('no committed-slate row is a BET or carries units', real.every((r) => r.decision !== 'BET' && r.recommended_units === 0));

console.log('\n' + (fail ? 'FAILED' : 'ALL GREEN') + ' card feed — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
