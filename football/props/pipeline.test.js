#!/usr/bin/env node
/* ===========================================================================
   The Player Props pipeline, end to end, offline and deterministic.

   On a real (cut-down) nflverse slice (fixtures/dataset_nfl.json.gz) and a
   hand-written Odds API response (fixtures/odds_event_nfl.json — test data,
   not market data):

     capture   parse: players, sides, Yes/No, alternates vs mains, refusals
               (impossible price, duplicate outcome, unknown market); the
               listing keeps an unchanged price's first sighting; an event not
               re-polled keeps its own (older) time; movement is change-only;
               the runner spends nothing without a key, respects its interval,
               its credit floor and stops at once on a 429
     identity  book names → one player within the two teams (suffixes,
               initials), ambiguous or unknown names are UNMAPPED, never guessed
     model     every default market projects a valid distribution; a teammate
               OUT raises a share (a projected adjustment); QUESTIONABLE lowers
               volume; wind lowers passing; the environment reads the consensus
               market first and EdgeDesk's own numbers without one
     board     priced props, the unmapped name kept visible, ledger records
               (qualified once per selection), the pregame record frozen when
               the game starts, a stale capture judged stale
     grade     WIN / LOSS / PUSH / VOID (did not play), pending while the game
               is not final, CLV against the frozen close, the report and its
               calibration table; the Supabase sync maps every row once

   Run: node football/props/pipeline.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const ROOT = path.join(__dirname, '..', '..');
global.window = global.window || global;
require(path.join(ROOT, 'lib', 'research_core.js'));
require(path.join(ROOT, 'lib', 'edgedesk_vocab.js'));
require(path.join(ROOT, 'lib', 'edgedesk_market.js'));
require(path.join(ROOT, 'lib', 'edgedesk_decision.js'));
const EDP = require(path.join(ROOT, 'lib', 'edgedesk_props.js'));
const C = require('./config.js');
const CAP = require('./capture.js');
const M = require('./model.js');
const B = require('./build_board.js');
const G = require('./grade.js');
const SY = require('./sync_supabase.js');
const V = require('./verify_ledger.js');
const { fakePgrest } = require(path.join(ROOT, 'tools', 'lib', 'fake_pgrest.js'));

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push(name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 500) : '')); }
const FX = path.join(__dirname, 'fixtures');
const loadDs = () => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(FX, 'dataset_nfl.json.gz'))).toString('utf8'));
const EVENT = JSON.parse(fs.readFileSync(path.join(FX, 'odds_event_nfl.json'), 'utf8'));
const NOW = Date.parse('2026-10-04T15:10:00Z');
const OBS = '2026-10-04T15:05:00.000Z';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'edp-props-'));
const paths = (lg) => { const p = C.leaguePaths(lg, 2026); const map = {}; Object.keys(p).forEach((k) => { map[k] = p[k].replace(C.DIR, tmp); }); return map; };

(async function main() {
  /* ------------------------------------------------------------ capture */
  const parsed = CAP.parseEventProps(EVENT, OBS);
  chk('the fixture parses into quotes from four books', parsed.quotes.length > 60 && parsed.books.length === 4, [parsed.quotes.length, parsed.books]);
  chk('an impossible price (+50) is refused and counted', parsed.refused['price not a valid American price'] === 1, parsed.refused);
  chk('a duplicated outcome is refused, never averaged', parsed.refused['duplicate outcome'] === 1);
  chk('Yes outcomes become over 0.5', parsed.quotes.filter((q) => q.market === 'anytime_td').every((q) => q.side === 'over' && q.line === 0.5));
  chk('alternate rungs are marked alternate', parsed.quotes.filter((q) => q.provider_market === 'player_rush_yds_alternate').every((q) => q.alt === true && q.market === 'rush_yds'));
  chk('every quote carries the provider update time and EdgeDesk\'s capture time', parsed.quotes.every((q) => q.quoted_at && q.captured_at === OBS));
  const bad = CAP.parseEventProps({ id: 'x', bookmakers: [{ key: 'dk', markets: [{ key: 'player_hot_dogs', outcomes: [] }, { key: 'player_rush_yds', outcomes: [{ name: 'Over', price: -110, point: 50.5 }, { name: 'Sideways', description: 'A B', price: -110, point: 50.5 }, { name: 'Over', description: 'A B', price: -110, point: 50.3 }, { name: 'Over', description: 'A B', price: -110 }] }] }] }, OBS);
  chk('unknown market, no player, bad side, non-half line and missing line are each refused', bad.quotes.length === 0 && Object.keys(bad.refused).length === 5, bad.refused);
  chk('a response without bookmakers is refused, not a crash', CAP.parseEventProps(null, OBS).refused['no bookmakers array'] === 1);
  /* the listing */
  const poll = (quotes, at) => ({ id: EVENT.id, commence_time: EVENT.commence_time, home_team: EVENT.home_team, away_team: EVENT.away_team, books: ['draftkings'], quotes: quotes.map((q) => Object.assign({}, q, { captured_at: at })) });
  const f1 = CAP.buildQuotesFeed({ league: 'nfl', now: NOW, polled: [poll(parsed.quotes, OBS)], observed_at: OBS });
  const later = '2026-10-04T17:05:00.000Z';
  const moved = parsed.quotes.map((q) => (q.book === 'draftkings' && q.market === 'rush_yds' && q.line === 84.5 && q.side === 'over' ? Object.assign({}, q, { american: -120 }) : q));
  const f2 = CAP.buildQuotesFeed({ league: 'nfl', now: NOW + 2 * 3600e3, prior: f1, polled: [poll(moved, later)], observed_at: later });
  const qs2 = f2.events[EVENT.id].quotes.map(CAP.unpackQuote);
  const movedQ = qs2.find((q) => q.book === 'draftkings' && q.market === 'rush_yds' && q.line === 84.5 && q.side === 'over');
  const sameQ = qs2.find((q) => q.book === 'fanduel' && q.market === 'rush_yds' && q.side === 'over');
  chk('a changed price is first seen at the new poll', movedQ.first_seen_at === later && movedQ.american === -120, movedQ);
  chk('an unchanged price keeps its first sighting (change-only ledger)', sameQ.first_seen_at === OBS && sameQ.captured_at === later, sameQ);
  const f3 = CAP.buildQuotesFeed({ league: 'nfl', now: NOW + 2 * 3600e3, prior: f1, polled: [], observed_at: later });
  chk('an event not re-polled keeps its own older time (it ages into STALE)', f3.events[EVENT.id].observed_at === OBS);
  const f4 = CAP.buildQuotesFeed({ league: 'nfl', now: Date.parse(EVENT.commence_time) + 5 * 3600e3, prior: f1, polled: [], observed_at: later });
  chk('an event long started drops out of the listing', !f4.events[EVENT.id]);
  /* movement */
  let L1 = CAP.updateLines(null, [poll(parsed.quotes, OBS)], OBS, NOW).lines;
  let L2 = CAP.updateLines(JSON.parse(JSON.stringify(L1)), [poll(parsed.quotes, later)], later, NOW + 3600e3).lines;
  const key = EDP.normName('Bijan Robinson') + '|rush_yds';
  chk('movement is change-only: an unchanged main number adds no row', L2.events[EVENT.id].props[key].books.draftkings.main.length === 1);
  L2 = CAP.updateLines(JSON.parse(JSON.stringify(L1)), [poll(moved, later)], later, NOW + 3600e3).lines;
  chk('a moved price adds one row, the open is kept', L2.events[EVENT.id].props[key].books.draftkings.main.length === 2 && L2.events[EVENT.id].props[key].books.draftkings.main[0][2] === -105);
  chk('alternate rungs keep first and latest price', L1.events[EVENT.id].props[key].books.draftkings.alt['over|59.5'][1] === -270);
  const closed = CAP.updateLines(JSON.parse(JSON.stringify(L1)), [], later, Date.parse(EVENT.commence_time) + 5 * 3600e3);
  chk('a game past kickoff moves its series to the closes', closed.closed.length === 1 && !closed.lines.events[EVENT.id]);
  /* the runner */
  const P = paths('nfl');
  const noKey = await CAP.run({ key: null, league: 'nfl', now: NOW, paths: P, window_h: 96, max_events: 4, min_interval_h: 2, near_interval_h: 0.5, min_remaining: 50, max_credits_run: 500 });
  chk('no key: nothing captured, nothing spent', /no ODDS_API_KEY/.test(noKey.skipped));
  const calls = [];
  const getter = (remaining, fail429) => async (url) => {
    calls.push(url.replace(/apiKey=[^&]+/, 'apiKey=***'));
    if (/\/events\?/.test(url)) return { body: [{ id: EVENT.id, commence_time: EVENT.commence_time, home_team: EVENT.home_team, away_team: EVENT.away_team }, { id: 'e2', commence_time: '2026-10-05T17:00:00Z', home_team: 'Chicago Bears', away_team: 'New York Jets' }], remaining, last: 0 };
    if (fail429) throw Object.assign(new Error('HTTP 429'), { status: 429 });
    return { body: /fixture_evt/.test(url) ? EVENT : { id: 'e2', bookmakers: [] }, remaining: remaining - 14, last: 14 };
  };
  const RUN = { key: 'k', league: 'nfl', now: NOW, paths: P, window_h: 96, max_events: 4, min_interval_h: 2, near_interval_h: 0.5, min_remaining: 50, max_credits_run: 500, groups: ['core', 'long'] };
  const r1 = await CAP.run(Object.assign({}, RUN, { getJson: getter(1000) }));
  chk('a run polls every event in the window, nearest kickoff first', r1.events_polled === 2 && /events\/e2\//.test(calls[1]) && calls[2].indexOf(EVENT.id) > 0, calls);
  chk('the key never appears in a logged URL', calls.every((u) => u.indexOf('apiKey=***') > 0));
  chk('the run writes the listing, the movement and its state', fs.existsSync(P.quotes) && fs.existsSync(P.lines) && fs.existsSync(P.capture_state));
  chk('cost per event = markets × regions (ten books = one region)', r1.cost_per_event === CAP.marketList('nfl', ['core', 'long']).length, r1.cost_per_event);
  const r2 = await CAP.run(Object.assign({}, RUN, { now: NOW + 30 * 60000, getJson: getter(1000) }));
  chk('it will not run again inside its interval', /at most/.test(r2.skipped || ''), r2);
  const r3 = await CAP.run(Object.assign({}, RUN, { now: NOW + 3 * 3600e3, getJson: getter(40) }));
  chk('it stops before spending below the credit floor', /credits below floor/.test(r3.stopped || '') && r3.events_polled === 0, r3);
  const r4 = await CAP.run(Object.assign({}, RUN, { now: NOW + 6 * 3600e3, getJson: getter(1000, true) }));
  chk('a 429 stops the run at once', /429/.test(r4.stopped || ''), r4);
  /* each event on its own clock: the game about to start is re-polled, the one days away is not */
  const P2 = Object.assign({}, P, { capture_state: P.capture_state + '.clock', quotes: P.quotes + '.clock', lines: P.lines + '.clock' });
  const seen = [];
  const clockGetter = async (url) => {
    seen.push(url);
    if (/\/events\?/.test(url)) return { body: [{ id: 'near', commence_time: new Date(NOW + 3 * 3600e3).toISOString(), home_team: 'Chicago Bears', away_team: 'New York Jets' }, { id: 'far', commence_time: new Date(NOW + 60 * 3600e3).toISOString(), home_team: 'Green Bay Packers', away_team: 'Detroit Lions' }], remaining: 5000, last: 0 };
    return { body: { id: /events\/near\//.test(url) ? 'near' : 'far', bookmakers: [] }, remaining: 4980, last: 20 };
  };
  const CL = Object.assign({}, RUN, { paths: P2, getJson: clockGetter, min_interval_h: 3, far_h: 36, far_interval_h: 8 });
  const c1 = await CAP.run(CL);
  seen.length = 0;
  const c2 = await CAP.run(Object.assign({}, CL, { now: NOW + 3600e3 }));
  chk('each event keeps its own clock: an hour later only the game inside six hours of kickoff is re-polled', c1.events_polled === 2 && c2.events_polled === 1 && seen.some((u) => /events\/near\//.test(u)) && !seen.some((u) => /events\/far\//.test(u)), [c1.events_polled, c2.events_polled]);
  const c3 = await CAP.run(Object.assign({}, CL, { now: NOW + 8 * 3600e3 }));
  chk('…and the far game is polled again once its own interval has passed', c3.events_polled >= 1 && c3.polled_at.far === new Date(NOW + 8 * 3600e3).toISOString(), c3.polled_at);

  /* ------------------------------------------------------------ identity */
  const ds = loadDs();
  const ix = B.nameIndex(Object.values(ds.players));
  const rid = (n) => B.resolveName(ix, n).id;
  chk('"Kyle Pitts Sr." resolves to Kyle Pitts', rid('Kyle Pitts Sr.') && ds.players[rid('Kyle Pitts Sr.')].name === 'Kyle Pitts');
  chk('"Michael Penix" resolves to Michael Penix Jr.', rid('Michael Penix') && /Penix/.test(ds.players[rid('Michael Penix')].name));
  chk('"B. Robinson" is ambiguous (two Robinsons on one team) and refused', B.resolveName(ix, 'B. Robinson').id === null && /ambiguous/.test(B.resolveName(ix, 'B. Robinson').why));
  chk('an unknown name is refused, never guessed', B.resolveName(ix, 'Totally Unknown Player').id === null);

  /* ------------------------------------------------------------ model */
  const game = ds.schedule.find((g) => g.game_id === '2026_04_ATL_NO');
  const ctx = M.prepare(ds, game.gameday);
  const BIJAN = Object.values(ds.players).find((p) => p.name === 'Bijan Robinson').id;
  const PENIX = Object.values(ds.players).find((p) => /Penix/.test(p.name)).id;
  const pr = M.projectPlayer(ctx, BIJAN, game, M.defaultMarkets('RB'), {});
  chk('every default RB market projects a valid distribution', pr.ok && M.defaultMarkets('RB').every((m) => pr.markets[m] && EDP.validDist(pr.markets[m].dist)), pr.ok ? Object.keys(pr.markets) : pr.reason);
  chk('the build is recorded step by step', pr.steps.length >= 8 && pr.steps.every((s) => s.label && s.value != null));
  chk('the environment reads the consensus market', /consensus market/.test(pr.env.source) && pr.env.total === game.total_line);
  const noMkt = Object.assign({}, game, { spread_line: null, total_line: null, edgedesk: { home_margin: 3, total: 44 } });
  chk('without a market it reads EdgeDesk\'s own fair numbers, labelled', /EdgeDesk fair/.test(M.environment(ctx, noMkt, 'ATL').source) && M.environment(ctx, noMkt, 'ATL').total === 44);
  const BROB = Object.values(ds.players).find((p) => p.team === 'ATL' && p.pg === 'RB' && p.id !== BIJAN && /Robinson/.test(p.name)).id;
  const ctxOut = M.prepare(ds, game.gameday, { absent: { ATL: [BROB], NO: [] } });
  const prOut = M.projectPlayer(ctxOut, BIJAN, game, ['rush_att'], {});
  chk('a teammate OUT raises the carry share (projected, printed)', prOut.shares.car.projected > pr.shares.car.projected && prOut.teammates_out.length === 1 && prOut.teammates_out[0].label === 'carry share', [pr.shares.car.projected, prOut.shares.car.projected, prOut.teammates_out]);
  const dsQ = loadDs(); dsQ.injuries.by_player[BIJAN] = { status: 'Questionable', practice: 'Limited Participation in Practice', team: 'ATL', week: 4 };
  const prQ = M.projectPlayer(M.prepare(dsQ, game.gameday), BIJAN, game, ['rush_att'], {});
  chk('QUESTIONABLE lowers the projected volume and is carried as status', prQ.status.status === 'QUESTIONABLE' && EDP.mean(prQ.markets.rush_att.dist) < EDP.mean(pr.markets.rush_att.dist));
  const windy = Object.assign({}, game, { roof: 'outdoors', forecast: { wind_mph: 22, precip_in: 0, temp_f: 50 } });
  const qbCalm = M.projectPlayer(ctx, PENIX, game, ['pass_yds'], { force: true }), qbWind = M.projectPlayer(ctx, PENIX, windy, ['pass_yds'], { force: true });
  chk('a 22 mph wind lowers the passing projection', EDP.mean(qbWind.markets.pass_yds.dist) < EDP.mean(qbCalm.markets.pass_yds.dist), [EDP.mean(qbCalm.markets.pass_yds.dist), EDP.mean(qbWind.markets.pass_yds.dist)]);
  chk('a dome removes the weather', M.environment(ctx, Object.assign({}, windy, { roof: 'dome' }), 'ATL').wind === null);

  /* ------------------------------------------------------------ board */
  const pq = CAP.parseEventProps(EVENT, OBS);
  const feed = CAP.buildQuotesFeed({ league: 'nfl', now: NOW, polled: [poll(pq.quotes, OBS)], observed_at: OBS });
  const BP = paths('nfl');
  fs.mkdirSync(BP.dir, { recursive: true });
  const b1 = await B.build({ league: 'nfl', season: 2026, now: NOW, dataset: loadDs(), quotes: feed, lines: null, paths: BP });
  const board = b1.board;
  chk('the board lists the upcoming games in its window', board.games.some((g) => g.game_id === '2026_04_ATL_NO') && board.games.every((g) => Date.parse(g.kickoff) > NOW - 4 * 3600e3));
  const priced = board.props.filter((x) => x.q.length);
  chk('the fixture\'s players are priced on the board', priced.length >= 15, priced.length);
  chk('the unmapped name is kept, visible and never priced', board.props.some((x) => x.fl && x.fl.indexOf('UNMAPPED') >= 0 && x.e.d === 'NO_DECISION'));
  chk('every priced prop carries a decision the page can show', priced.every((x) => ['BET', 'LEAN', 'WATCH', 'PASS', 'NO_DECISION'].indexOf(x.e.d) >= 0));
  chk('projection-only props are NO_MARKET, with a fair line', board.props.filter((x) => !x.q.length && x.x.dist).every((x) => x.e.d === 'NO_DECISION' && x.e.c === 'NO_MARKET' && x.e.inf));
  chk('player context is per player and game', Object.keys(board.players).every((k) => /@/.test(k)));
  chk('the page re-prices a row to the same decision the build wrote', (() => {
    const U = require(path.join(ROOT, 'lib', 'edgedesk_props_ui.js')); U.state.clock = () => NOW; U._prepBoard(board);
    return priced.every((r) => { const e = EDP.compact(EDP.evaluate(U._inputOf(board, r), { now: NOW, calibration: { state: board.probability.state }, stages: board.stages })); return e.d === r.e.d && JSON.stringify(e.cand) === JSON.stringify(r.e.cand); });
  })());
  chk('the board carries each of its markets\' validation stage, derived from evidence', board.stages && Object.keys(board.stages).length > 0 && Object.keys(board.stages).every((m) => EDP.STAGES.indexOf(board.stages[m].stage) >= 0 && Array.isArray(board.stages[m].gates)));
  chk('an EXPERIMENTAL market never carries units on the board', priced.every((r) => !(board.stages[r.m] && board.stages[r.m].stage === 'EXPERIMENTAL' && r.e.u > 0)));
  chk('every frozen record carries its market\'s stage', b1.ledger_rows.every((x) => EDP.STAGES.indexOf(x.stage) >= 0));
  chk('qualified records: one per BET/LEAN selection', b1.ledger_rows.length > 0 && b1.ledger_rows.every((x) => x.kind === 'qualified' && ['BET', 'LEAN'].indexOf(x.decision) >= 0), b1.ledger_rows.length);
  fs.writeFileSync(path.join(BP.dir, 'pregame_state.json'), JSON.stringify(b1.pregame));
  fs.mkdirSync(BP.season_dir, { recursive: true });
  fs.writeFileSync(BP.evaluations, b1.ledger_rows.map((x) => JSON.stringify(x)).join('\n') + '\n');
  const again = await B.build({ league: 'nfl', season: 2026, now: NOW + 60000, dataset: loadDs(), quotes: feed, lines: null, paths: BP });
  chk('a rebuild writes no duplicate qualified record', again.ledger_rows.filter((x) => x.kind === 'qualified').length === 0, again.ledger_rows.length);
  const stale = await B.build({ league: 'nfl', season: 2026, now: Date.parse(OBS) + 2 * 3600e3, dataset: loadDs(), quotes: feed, lines: null, paths: BP });
  {
    /* the ledger the build froze verifies, and only ever growing verifies */
    const text = fs.readFileSync(BP.evaluations, 'utf8');
    chk('the frozen ledger verifies: ids from content, evaluated before kickoff', V.checkEvaluations('', text, 'evaluations.jsonl').length === 0, V.checkEvaluations('', text, 'evaluations.jsonl'));
    const more = text + JSON.stringify(Object.assign({}, b1.ledger_rows[0], { kind: 'qualified', selection_key: 'extra', evaluated_at: new Date(NOW + 1000).toISOString(), evaluation_id: V.evaluationId(Object.assign({}, b1.ledger_rows[0], { kind: 'qualified', selection_key: 'extra', evaluated_at: new Date(NOW + 1000).toISOString() })) })) + '\n';
    chk('appending to the published ledger passes', V.checkEvaluations(text, more, 'evaluations.jsonl').length === 0, V.checkEvaluations(text, more, 'evaluations.jsonl'));
    const edited = text.replace(/"american":(-?\d+)/, (m0, a) => '"american":' + (Number(a) - 5));
    chk('editing a published price is caught (prefix and id)', V.checkEvaluations(text, edited, 'evaluations.jsonl').length >= 2, V.checkEvaluations(text, edited, 'evaluations.jsonl'));
  }
  chk('two hours after the capture every price is STALE · NO DECISION', stale.board.props.filter((x) => x.q.length && x.p).every((x) => x.e.d === 'NO_DECISION' && x.e.c === 'STALE_QUOTE'));
  const after = await B.build({ league: 'nfl', season: 2026, now: Date.parse(EVENT.commence_time) + 5 * 3600e3, dataset: loadDs(), quotes: feed, lines: null, paths: BP });
  const finals = after.ledger_rows.filter((x) => x.kind === 'final');
  chk('once the game starts its last pregame evaluations are frozen as final', finals.length > 0 && finals.every((x) => x.game_id === '2026_04_ATL_NO' && x.frozen_at), finals.length);
  chk('a final record carries the model probability at the consensus line', finals.every((x) => x.model_over_at_consensus != null && x.consensus && x.consensus.line != null));
  const kickPlus1 = await B.build({ league: 'nfl', season: 2026, now: Date.parse(EVENT.commence_time) + 3600e3, dataset: loadDs(), quotes: feed, lines: null, paths: BP });
  chk('a game that has kicked off leaves the board (no started-game rows, priced or not)', !kickPlus1.board.games.some((g) => g.game_id === '2026_04_ATL_NO') && !kickPlus1.board.props.some((x) => x.g === '2026_04_ATL_NO'));

  /* ------------------------------------------------------------ grade */
  const G3 = '2026_03_ATL_GB', KICK3 = ds.schedule.find((g) => g.game_id === G3).kickoff;
  const RUSH3 = ds.players[BIJAN].logs.find((l) => l.gid === G3).ryd;
  const COOPER = Object.values(ds.players).find((p) => p.name === 'Cooper Rush').id;
  const q = (id, pid, market, side, line, american, units, dec) => ({ kind: 'qualified', evaluation_id: id, selection_key: id, prop_id: 'nfl|' + G3 + '|' + pid + '|' + market, league: 'nfl', season: 2026, week: 3,
    game_id: G3, kickoff: KICK3, player_id: pid, market, position: 'RB', evaluated_at: '2026-09-24T12:00:00.000Z', decision: dec || 'BET', units, side, line, american, book: 'draftkings', ev: 0.07, p_side: 0.57, confidence: 72 });
  const rows = [q('w', BIJAN, 'rush_yds', 'over', 84.5, -105, 0.25), q('l', BIJAN, 'rush_yds', 'under', 84.5, -115, 0.25), q('p', BIJAN, 'rush_yds', 'over', RUSH3, -110, 0.25),
    q('v', COOPER, 'pass_yds', 'over', 200.5, -110, 0.25), q('lean', BIJAN, 'rush_att', 'over', 19.5, -110, 0, 'LEAN'),
    Object.assign(q('pend', BIJAN, 'rush_yds', 'over', 84.5, -105, 0.25), { game_id: '2026_04_ATL_NO', kickoff: game.kickoff, prop_id: 'x' }),
    { kind: 'final', evaluation_id: 'f1', prop_id: 'nfl|' + G3 + '|' + BIJAN + '|rush_yds', league: 'nfl', season: 2026, game_id: G3, kickoff: KICK3, player_id: BIJAN, market: 'rush_yds', position: 'RB',
      evaluated_at: '2026-09-25T00:10:00.000Z', decision: 'PASS', consensus: { line: 86.5, over: -115, under: -105, novig_over: 0.52 }, model_over_at_consensus: 0.61 }];
  const graded = G.grade(ds, rows, [], NOW);
  const byId = {}; graded.forEach((x) => { byId[x.evaluation_id] = x; });
  chk('an over that the box score clears is a WIN, units at the price', byId.w.result === 'WIN' && byId.w.value === RUSH3 && EDP.unitsWon('WIN', -105, 0.25) === byId.w.units_won, byId.w);
  chk('the under is a LOSS', byId.l.result === 'LOSS' && byId.l.units_won === -0.25);
  chk('the exact number on a whole line is a PUSH', byId.p.result === 'PUSH' && byId.p.units_won === 0, byId.p);
  chk('a player who did not play is VOID, not a loss', byId.v.result === 'VOID' && byId.v.units_won === 0, byId.v);
  chk('a game not yet final stays pending', !byId.pend);
  chk('CLV against the frozen close: bought 84.5, closed 86.5 → +2', byId.w.clv.available && byId.w.clv.line_clv === 2 && byId.w.clv.beat_close === true, byId.w.clv);
  chk('the final row is graded for calibration at the consensus line', byId.f1.result === (RUSH3 > 86.5 ? 'WIN' : 'LOSS') && byId.f1.p_over === 0.61);
  chk('grading is idempotent: settled rows are never re-graded', G.grade(ds, rows, graded, NOW).length === 0);
  {
    const rtext = graded.map((x) => JSON.stringify(x)).join('\n') + '\n';
    chk('every grade refers to an evaluation on file, once, after its kickoff', V.checkResults('', rtext, rows, 'results.jsonl').length === 0, V.checkResults('', rtext, rows, 'results.jsonl'));
    chk('a grade of an evaluation that is not on file is caught', V.checkResults('', rtext, rows.filter((x) => x.evaluation_id !== 'w'), 'results.jsonl').some((p) => /not on file/.test(p)));
    chk('a grade repeated is caught', V.checkResults('', rtext + JSON.stringify(graded[0]) + '\n', rows, 'results.jsonl').some((p) => /second time/.test(p)));
  }
  const rep = G.report('nfl', 2026, graded, rows, NOW);
  chk('the report counts bets (BET only) and keeps LEAN apart', rep.summary.n === 3 && rep.lean.n === 1, [rep.summary, rep.lean]);
  chk('the report carries breakdowns and the calibration table', rep.breakdown.market.length && rep.breakdown.ev_bucket.length && rep.calibration.table.length === 5);
  chk('with a handful of rows the probability source stays UNVALIDATED', rep.calibration_state.state === 'UNVALIDATED');

  /* ------------------------------------------------------------ sync */
  const db = fakePgrest();
  const resolved = { rows: b1.resolved_quotes };
  const s1 = await SY.sync({ league: 'nfl', season: 2026, now: NOW, db, evaluations: b1.ledger_rows, results: graded.map((x) => Object.assign({}, x, { graded_at: new Date(NOW).toISOString() })), resolved });
  chk('the sync writes quotes, evaluations, projections and results', s1.quotes > 50 && s1.evaluations > 0 && s1.projections > 0 && s1.results > 0, s1);
  const qt = db.tables['public.player_prop_ledger_quotes'];
  chk('an unmapped quote is keyed by its name, a mapped one by its player id', qt.some((x) => /^name:/.test(x.player_key) && x.player_id === null) && qt.some((x) => x.player_id && x.player_key === x.player_id));
  await SY.sync({ league: 'nfl', season: 2026, now: NOW, db, evaluations: b1.ledger_rows, results: [], resolved });
  chk('running the sync twice writes nothing twice', db.tables['public.player_prop_ledger_quotes'].length === qt.length && db.tables['public.player_prop_evaluations'].length === b1.ledger_rows.length);

  console.log('\n' + (fail ? 'FAILED ' : 'ALL GREEN ') + 'player props pipeline — ' + pass + ' passed, ' + fail + ' failed');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* tmp */ }
  if (fail) { failures.forEach((m) => console.log('  ✗ ' + m)); process.exit(1); }
})().catch((e) => { console.error(e.stack || e); process.exit(1); });
