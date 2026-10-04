#!/usr/bin/env node
/* ===========================================================================
   lib/edgedesk_opportunity.js — one research-and-decision object for a game
   market and a player prop, through every surface that reads it.

   On a board BUILT IN THIS PROCESS by football/props/build_board.js from the
   committed real-data fixture (football/props/fixtures: the NFL dataset and
   an Odds API event, with the committed calibration and correlation files —
   the same code path the hourly build runs), pinned five minutes after its
   capture, and on mutations of it that stand in for the situations it does
   not carry; then on the LIVE committed boards (football/props/<lg>/
   board.json and summary.json), which change every hour, for invariants only:

     A  a game with a strong game signal AND strong props
     B  a strong game signal and no worthwhile props
     C  no game edge, one strong player prop
     D  sportsbooks have not released player markets
     E  the prop capture failed (told apart from D)
     F  a stale prop price
     G  a questionable player
     H  a saved prop whose line moved (the snapshot is never rewritten)
     I  several correlated positions in one game
     J  the NFL and college boards, each on its own

   plus the shared services (EV parity with the kernel, units never above
   the engine or the validation stage), the per-event summary, explanations
   drawn from data only, the combined Card page, the GAME / PLAYER PROP
   record split, and the AI desk turn through the real edge handler.

   Run: node tools/opportunity/opportunity.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
global.window = global.window || global;
require(path.join(ROOT, 'lib', 'research_core.js'));
require(path.join(ROOT, 'lib', 'edgedesk_vocab.js'));
require(path.join(ROOT, 'lib', 'edgedesk_market.js'));
require(path.join(ROOT, 'lib', 'edgedesk_quote_ev.js'));
const D = require(path.join(ROOT, 'lib', 'edgedesk_decision.js'));
require(path.join(ROOT, 'lib', 'edgedesk_decision_track.js'));
const BK = require(path.join(ROOT, 'lib', 'edgedesk_bankroll.js'));
const RP = require(path.join(ROOT, 'lib', 'research_priority.js'));
const E = require(path.join(ROOT, 'lib', 'edgedesk_props.js'));
const O = require(path.join(ROOT, 'lib', 'edgedesk_opportunity.js'));
const PER = require(path.join(ROOT, 'lib', 'edgedesk_personal.js'));
const SUM = require(path.join(ROOT, 'football', 'props', 'build_summary.js'));

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push(name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 600) : '')); }
function section(t) { console.log('— ' + t); }
const clone = (o) => JSON.parse(JSON.stringify(o));
const near = (a, b, t) => typeof a === 'number' && Math.abs(a - b) <= (t == null ? 1e-6 : t);
const BANNED = /\b(lock|locks|best bets?|smash|hammer|guarantee[ds]?|can'?t lose|free money|sure thing|must[- ]bet)\b/i;
const junk = (s) => /\b(undefined|NaN|null)\b/.test(String(s));

/* the live committed boards (J): invariants only — they change hourly */
const RN = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'props', 'nfl', 'board.json'), 'utf8'));
const RC = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'props', 'cfb', 'board.json'), 'utf8'));
const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };
const CAPN = read(path.join(ROOT, 'football', 'props', 'nfl', 'capture_state.json'));
const CAPC = read(path.join(ROOT, 'football', 'props', 'cfb', 'capture_state.json'));
const RULE = SUM.SCRIPT_RULE;
const summaryOf = (b, cap) => O.buildSummary(b, { capture_state: cap, script_rule: RULE, now: Date.parse(b.generated_at) });

/* the deterministic board: the pipeline on the committed fixture */
const NOW = Date.parse('2026-10-04T15:10:00Z'), OBS = '2026-10-04T15:05:00.000Z', GID = '2026_04_ATL_NO';
async function buildFixture() {
  const os = require('os'), zlib = require('zlib');
  const C = require(path.join(ROOT, 'football', 'props', 'config.js')), CAP = require(path.join(ROOT, 'football', 'props', 'capture.js')), B = require(path.join(ROOT, 'football', 'props', 'build_board.js'));
  const FX = path.join(ROOT, 'football', 'props', 'fixtures');
  const ds = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(FX, 'dataset_nfl.json.gz'))).toString('utf8'));
  const EVENT = JSON.parse(fs.readFileSync(path.join(FX, 'odds_event_nfl.json'), 'utf8'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'edp-opp-')), P0 = C.leaguePaths('nfl', 2026), BP = {};
  Object.keys(P0).forEach((k) => { BP[k] = P0[k].replace(C.DIR, tmp); });
  fs.mkdirSync(BP.dir, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'football', 'props', 'nfl', 'correlation.json'), BP.correlation);
  fs.copyFileSync(path.join(ROOT, 'football', 'props', 'nfl', 'calibration.json'), BP.calibration);
  const pq = CAP.parseEventProps(EVENT, OBS);
  const feed = CAP.buildQuotesFeed({ league: 'nfl', now: NOW, polled: [{ id: EVENT.id, commence_time: EVENT.commence_time, home_team: EVENT.home_team, away_team: EVENT.away_team, books: pq.books, quotes: pq.quotes }], observed_at: OBS });
  const b = (await B.build({ league: 'nfl', season: 2026, now: NOW - 5 * 60000, dataset: ds, quotes: feed, lines: null, paths: BP })).board;
  /* TEST DATA: the fixture carries no EdgeDesk NFL game projection; this one
     is invented for the test (a game model 4 points kinder to Atlanta than the
     market), so the game-model-beside-the-prop path has a disagreement to read */
  const g = b.games.find((x) => x.game_id === GID);
  g.edgedesk = { home_margin: g.market.home_margin - 4, total: g.market.total - 2.5, source: 'TEST FIXTURE game projection' };
  b.capture = { status: 'SUCCESS', reason: 'QUOTES_WRITTEN', last_run: OBS, last_success_at: OBS, window_h: 96 };
  return b;
}

(async function main() {
  const NFL0 = await buildFixture(), CFB0 = RC;
  /* ======================================================================= */
  section('shared services');
  chk('the fixture board prices the game', (NFL0.games.find((g) => g.game_id === GID) || {}).n_priced > 0, NFL0.games.map((g) => g.n_priced));
  const ev1 = O.calculatePropEV(0.6, -110, 0);
  chk('calculatePropEV: EV is the kernel\'s own number at the exact price', near(ev1.ev, E.expectedValue(0.6, -110, 0), 1e-4) && near(ev1.break_even, 1 / E.toDecimal(-110), 1e-4) && near(ev1.edge_pp, 100 * (0.6 - 1 / E.toDecimal(-110)), 0.01), ev1);
  const evp = O.calculatePropEV(0.5, 100, 0.1);
  chk('calculatePropEV: a push returns the stake (push-aware probability and EV)', near(evp.probability, 0.5 / 0.9, 1e-4) && near(evp.ev, 0.5 * 1 - 0.4, 1e-4), evp);
  chk('calculatePropEV: no price, no EV (never an assumed −110)', O.calculatePropEV(0.6, null) === null && O.calculatePropEV(0.6, 50) === null);
  chk('classifyPropDecision IS the kernel classifier', O.classifyPropDecision === E.evaluate || O.classifyPropDecision.toString().indexOf('evaluate') >= 0);
  const row0 = NFL0.props.find((r) => r.g === GID && r.p && r.e && r.e.d === 'BET');
  const o0 = O.fromPropRow(NFL0, row0, { now: NOW });
  chk('a prop opportunity carries the board\'s decision, price and probability unchanged', o0.type === 'PLAYER_PROP' && o0.decision === row0.e.d && o0.price.american === row0.e.cand[2] && o0.price.book === row0.e.cand[3] && o0.ev === row0.e.cand[6] && o0.edge_pp === row0.e.cand[8] && o0.confidence === row0.e.cf, o0);
  chk('…joined on the canonical event id, with the provider id beside it', o0.event.event_key === 'nfl|' + GID && o0.event.provider_event_id === NFL0.games.find((g) => g.game_id === GID).event_id);
  chk('…and never units above the engine\'s', o0.units <= row0.e.u + 1e-9 && o0.units <= 0.25 + 1e-9, [o0.units, row0.e.u]);
  const exp = { type: 'PLAYER_PROP', decision: 'BET', engine_units: 1, stage: 'EXPERIMENTAL', probability_source: 'model_estimated' };
  chk('units: an EXPERIMENTAL market never stakes', O.calculateOpportunityUnits(exp).units === 0);
  chk('units: TRACKING is held to the model-estimated cap (0.25U)', O.calculateOpportunityUnits(Object.assign({}, exp, { stage: 'TRACKING' })).units === 0.25);
  chk('units: RESEARCH GRADE to the partially-calibrated cap (0.50U)', O.calculateOpportunityUnits(Object.assign({}, exp, { stage: 'RESEARCH_GRADE' })).units === 0.5);
  chk('units: only a BET carries units', O.calculateOpportunityUnits(Object.assign({}, exp, { decision: 'LEAN', stage: 'PRODUCTION' })).units === 0);
  chk('units: a game market keeps the engine\'s units exactly', O.calculateOpportunityUnits({ type: 'GAME', decision: 'BET', engine_units: 0.5 }).units === 0.5);
  chk('units: rounded DOWN onto the grid, never above 1.00U', O.calculateOpportunityUnits({ type: 'PLAYER_PROP', decision: 'BET', engine_units: 0.6, stage: 'PRODUCTION', probability_source: 'calibrated' }).units === 0.5);
  const rs = o0.research;
  chk('the research score is 0-100 and every part is returned for debugging', rs.score >= 0 && rs.score <= 100 && ['ev', 'edge', 'confidence', 'market', 'disagreement', 'decision'].every((k) => typeof rs.parts[k] === 'number') && typeof rs.base === 'number', rs);
  const loud = Object.assign(clone(o0), { ev: 0.9, edge_pp: 30, caps: ['PRICE_ANOMALY'] }), quiet = Object.assign(clone(o0), { ev: 0.9, edge_pp: 30, caps: [] });
  chk('the research score is not EV: an extreme uncorroborated price is penalised', O.calculatePropResearchScore(loud).score < O.calculatePropResearchScore(quiet).score);

  /* ======================================================================= */
  section('the per-event summary (fixture)');
  const SN = summaryOf(NFL0, null);
  chk('one entry per board game, counts that add up', Object.keys(SN.events).length === NFL0.games.length && SN.counts.priced === NFL0.counts.priced, SN.counts);
  const evN = SN.events[GID];
  chk('the priced game has research-grade props and at most four carried in full', evN.capture.state === 'PRICED' && evN.research_grade_count > 0 && evN.top_opportunities.length <= 4 && evN.top_opportunities.length > 0 && evN.more === evN.research_grade_count - evN.top_opportunities.length, { g: evN.research_grade_count, t: evN.top_opportunities.length, m: evN.more });
  chk('the top candidates are research grade and ordered by research score', evN.top_opportunities.every((o, i, a) => o.research.grade && (i === 0 || a[i - 1].research.score >= o.research.score)));
  chk('the summary carries the correlation model the Card needs', !!SN.correlation && !!SN.correlation.teammate);
  chk('a TRACKING market can BET, at the 0.25U model-estimated ceiling', evN.top_opportunities.some((o) => o.decision === 'BET' && o.stage === 'TRACKING' && o.units === 0.25));

  /* ======================================================================= */
  section('J · the live committed boards, each league on its own (invariants)');
  const LN = summaryOf(RN, CAPN), LC = summaryOf(RC, CAPC);
  const allTop = (S) => [].concat(...Object.values(S.events).map((e) => e.top_opportunities));
  chk('NFL and CFB summaries: one entry per board game', Object.keys(LN.events).length === RN.games.length && Object.keys(LC.events).length === RC.games.length, [LN.counts, LC.counts]);
  chk('NFL and CFB ids never collide: every event key names its league', Object.values(LN.events).every((e) => /^nfl\|/.test(e.event_key)) && Object.values(LC.events).every((e) => /^cfb\|/.test(e.event_key)));
  chk('every event names a capture state, and a priced event is PRICED', Object.values(LN.events).concat(Object.values(LC.events)).every((e) => ['PRICED', 'NOT_RELEASED', 'NOT_CAPTURED_YET', 'CAPTURE_FAILED', 'CAPTURE_OFF'].indexOf(e.capture.state) >= 0 && (e.priced_props > 0) === (e.capture.state === 'PRICED')));
  chk('a research-grade prop always has a positive EV at a fresh price and at least the LEAN edge (both leagues)', allTop(LN).concat(allTop(LC)).every((o) => o.ev > 0 && o.edge_pp >= 2 && ['FRESH', 'AGING'].indexOf(o.price.fresh) >= 0 && ['BET', 'LEAN', 'WATCH'].indexOf(o.decision) >= 0));
  chk('CFB: every college market is EXPERIMENTAL, so no college prop carries units', allTop(LC).every((o) => o.stage === 'EXPERIMENTAL' && o.units === 0 && o.decision !== 'BET'), allTop(LC).map((o) => [o.stage, o.decision, o.units]));
  chk('no prop, in either league, is sized above 0.25U while its probability is model-estimated', allTop(LN).concat(allTop(LC)).every((o) => o.units <= 0.25 + 1e-9));
  chk('the summary is a fraction of the board (Research never loads the raw universe)', JSON.stringify(LN).length < JSON.stringify(RN).length / 5 && JSON.stringify(LC).length < JSON.stringify(RC).length / 5, [JSON.stringify(LN).length, JSON.stringify(RN).length]);
  ['nfl', 'cfb'].forEach((lg) => {
    const f = read(path.join(ROOT, 'football', 'props', lg, 'summary.json')), b = lg === 'nfl' ? RN : RC, S = lg === 'nfl' ? LN : LC;
    chk(lg + ': the committed summary.json is this build of the committed board (no drift)', f && f.schema === O.SUMMARY_SCHEMA && f.generated_at === b.generated_at && f.counts.research_grade === S.counts.research_grade, f && [f.generated_at, b.generated_at, f.counts.research_grade, S.counts.research_grade]);
  });
  const cfbNRl = Object.values(LC.events).find((e) => e.capture.state === 'NOT_RELEASED');
  chk('D (live): a college game whose markets are not released reads so', !cfbNRl || /have not released enough player markets/.test(cfbNRl.capture.text));

  /* explanations from data only */
  const ex = evN.top_opportunities[0].explanation;
  chk('WHY THIS PROP IS INTERESTING: sentences, no empty values', ex && ex.why.length >= 2 && ex.why.concat(ex.concerns).every((t) => typeof t === 'string' && t.length > 8 && !junk(t)), ex);
  chk('…the probability source is always stated among the concerns', ex.concerns.some((t) => /MODEL-ESTIMATED/.test(t)));
  chk('…the book count it cites is the number of books posting that exact line', (() => { const o = evN.top_opportunities[0], n = o.price.books_at_line, t = ex.why.concat(ex.concerns).find((s) => /sportsbooks? posts?/.test(s)); return !t || t.indexOf(String(n)) >= 0 || (n === 1 && /Only 1/.test(t)); })());
  const link = ex.game_link;
  chk('the game model is read BESIDE the projection, never in it (NFL: the market script)', link && link.available && link.kind === 'SENSITIVITY' && /A sensitivity only/.test(link.text), link);
  const inProj = O.propGameLink({ type: 'PLAYER_PROP', player: { team: 'H' }, market: { key: 'rec_yds', category: 'receiving' }, selection: { side: 'over' } },
    { home: 'H', away: 'A', home_name: 'Home U', edgedesk: { home_margin: 3, total: 50 } }, { margin: 3, total: 50, source: 'EdgeDesk fair margin and total (no market on file)' }, RULE);
  chk('no market spread (most college games): the projection ALREADY used EdgeDesk\'s game model, and it says so (no double count)', inProj.kind === 'IN_PROJECTION' && /not counted twice/.test(inProj.text) && !inProj.direction, inProj);
  const cfbGame = CFB0.games.find((g) => g.market && /EdgeDesk/.test(g.market.source) && g.n_priced > 0);
  const cfbRow = cfbGame && CFB0.props.find((r) => r.g === cfbGame.game_id && r.p && r.e && r.e.cand);
  const cfbOpp = cfbRow ? O.fromPropRow(CFB0, cfbRow, { now: Date.parse(CFB0.generated_at), ev: E.boardEval(CFB0, cfbRow, Date.parse(CFB0.generated_at)), script_rule: RULE }) : null;
  chk('…and on the live college board wherever that is the case', !cfbOpp || (cfbOpp.explanation.game_link.kind === 'IN_PROJECTION' && /not counted twice/.test(cfbOpp.explanation.game_link.text)), cfbOpp && cfbOpp.explanation.game_link);
  /* the sensitivity is the model's own rule, computed */
  const g0 = NFL0.games.find((g) => g.game_id === GID), ctx0 = O.gameContext(g0, null, NFL0);
  chk('game context: EdgeDesk\'s and the market\'s script, pace and weather, and what is NOT available', ctx0.edgedesk && ctx0.market && ctx0.market.is_market && ctx0.pace && ctx0.weather && ctx0.not_available.indexOf('game-script probability') >= 0, ctx0);
  const pr = { type: 'PLAYER_PROP', player: { team: g0.away }, market: { key: 'pass_att', category: 'passing' }, selection: { side: 'over' } };
  const lk = O.propGameLink(pr, ctx0, { margin: -g0.market.home_margin, total: g0.market.total, source: 'consensus market' }, RULE);
  const dM = (-ctx0.edgedesk.home_margin) - (-g0.market.home_margin);
  chk('the script sensitivity is plays × the model\'s 0.6 pp/pt rule × the margin gap', !lk.effect || near(lk.effect, -RULE.pass_rate_per_pt * dM * g0.pace.away, 0.01), [lk.effect, -RULE.pass_rate_per_pt * dM * g0.pace.away]);
  /* a receiving prop on a team EdgeDesk sees trailing more: more dropbacks — an OVER is supported, an UNDER is cut against; never read off implied points */
  const recv = (side) => ({ type: 'PLAYER_PROP', player: { team: g0.away }, market: { key: 'receptions', category: 'receiving' }, selection: { side: side } });
  const envA = { margin: -g0.market.home_margin, total: g0.market.total, source: 'consensus market' };
  const lkO = O.propGameLink(recv('over'), ctx0, envA, RULE), lkU = O.propGameLink(recv('under'), ctx0, envA, RULE), lkN = O.propGameLink(recv('under'), ctx0, envA, null);
  const trails = dM < 0;
  chk('a volume prop reads the script as dropbacks, and the direction agrees with the sentence', /dropbacks/.test(lkO.text) && (trails ? lkO.direction === 'SUPPORTS' && lkU.direction === 'CONFLICTS' : lkO.direction === 'CONFLICTS' && lkU.direction === 'SUPPORTS') && !/implied points/.test(lkU.text), [lkO, lkU]);
  chk('without the model\'s rule on hand no size or direction is claimed for a volume prop', lkN.direction === 'NEUTRAL' && !/supports|cuts against/.test(lkN.text), lkN);

  /* ======================================================================= */
  section('A · B · C · the reading order with prop signals');
  const cand = (o) => Object.assign({ key: 'nfl|X', sport: 'nfl', home: 'Home', away: 'Away', kickoff: NOW + 864e5, status: 'INVESTIGATE', projected: true,
    model_margin: 6, market_margin: 1, normalized_gap: 0.4, market: { kind: 'live', age_h: 1, stale: false }, fault: false, thin: false, completeness: null,
    flags: ['LARGE_DISAGREEMENT', 'SPREAD_LEAN'], qualifiers: [], model_total: 44, market_total: 43, total_gap: 1, movement: {}, qb_unknown: false }, o || {});
  const sig = O.propSignal(O.eventFromSummary(SN, GID, NOW));
  chk('the prop signal: a count, the best prop\'s research score, and one sentence', sig.count > 0 && sig.top_score > 0 && /meet EdgeDesk’s research threshold/.test(sig.text), sig);
  const gameOnly = RP.rank([cand({ key: 'nfl|B' })]).items[0];
  const both = RP.rank([cand({ key: 'nfl|A', props: sig })]).items[0];
  chk('A: a game with a game signal AND props: both signals, and the props never LOWER the game score', both.detail.signals.join() === 'GAME,PROPS' && both.score >= gameOnly.score && both.score <= 100, [both.score, gameOnly.score]);
  chk('A: the prop signal adds part of the headroom above the game score', near(both.score, Math.round(10 * (gameOnly.score + (100 - gameOnly.score) * RP.PROPS.blend * sig.top_score / 100)) / 10, 0.11), [both.score]);
  chk('B: a game with no worthwhile props is scored exactly as before', RP.rank([cand({ key: 'nfl|B', props: { count: 0, top_score: null } })]).items[0].score === gameOnly.score);
  const flat = cand({ key: 'nfl|C', model_margin: 1.2, market_margin: 1, normalized_gap: 0.02, flags: [], status: 'AGREEMENT' });
  chk('C: with no game edge the game alone is not listed', RP.rank([flat]).items.length === 0);
  const c1 = RP.rank([Object.assign({}, flat, { props: sig })]).items[0];
  chk('C: …a strong player prop lists it on its props alone, at the declared scale', c1 && c1.detail.signals.join() === 'PROPS' && near(c1.score, Math.round(10 * RP.PROPS.only * sig.top_score) / 10, 0.11) && c1.why.code === 'prop_signal', c1 && c1.detail);
  chk('C: a DATA FAULT game is never listed on its props', RP.rank([Object.assign({}, flat, { fault: true, props: sig })]).items.length === 0);
  const many = RP.rank([cand({ key: 'nfl|M', props: Object.assign({}, sig, { count: 40, top_score: 50 }) }), cand({ key: 'nfl|Q', props: Object.assign({}, sig, { count: 1, top_score: 90 }) })]).items;
  chk('quality, not quantity: one better prop outranks forty weaker ones', many[0].key === 'nfl|Q', many.map((x) => [x.key, x.score]));
  const st = PER.normalizeState({ game_key: 'nfl|C', sport: 'nfl', priority: { eligible: true, signals: ['PROPS'], game_reasons: ['nothing to explain'] } });
  chk('research grade keeps its GAME meaning: a props-only listing is not a research-grade game', st.research_grade === false && st.research_grade_reasons.indexOf('nothing to explain') >= 0, st.research_grade_reasons);

  /* ======================================================================= */
  section('D · E · F · the empty states, told apart');
  const gNR = { game_id: 'g_nr', event_id: 'ev_nr' }, gFail = { game_id: 'g_f', event_id: 'ev_f' }, gFar = { game_id: 'g_far', event_id: null };
  const capOk = { status: 'SUCCESS', window_h: 96 };
  const nr = O.eventCaptureState(gNR, capOk, { requests: [{ event_id: 'ev_nr', http: 200, outcomes: 0 }], polled_at: { ev_nr: '2026-09-29T13:00:00Z' } }, 0);
  chk('D: polled, no book has posted player markets → NOT RELEASED, projections available', nr.state === 'NOT_RELEASED' && /have not released enough player markets/.test(nr.text) && /projections are available/.test(nr.text), nr);
  const fe = O.eventCaptureState(gFail, capOk, { requests: [{ event_id: 'ev_f', http: 500, error: 'HTTP 500' }] }, 0);
  const fe2 = O.eventCaptureState(gFar, { status: 'ERROR', reason: 'NO_API_KEY' }, {}, 0);
  chk('E: a failed request, or a failed run, is CAPTURE FAILED — never "not released"', fe.state === 'CAPTURE_FAILED' && fe2.state === 'CAPTURE_FAILED' && /encountered an error/.test(fe.text) && !/not released/i.test(fe.text.replace('not the same as markets not being released', '')), [fe, fe2]);
  const far = O.eventCaptureState(gFar, capOk, {}, 0);
  chk('outside the capture window: NOT CAPTURED YET (EdgeDesk has not asked, so "not released" would be a guess)', far.state === 'NOT_CAPTURED_YET' && /96 hours/.test(far.text), far);
  chk('capture switched off is said as such', O.eventCaptureState(gFar, { status: 'NOT_RUN' }, {}, 0).state === 'CAPTURE_OFF');
  const zero = { capture: { state: 'PRICED' }, evaluated_props: 42, priced_props: 42, top_opportunities: [], more: 0 };
  chk('no prop clears the research threshold: "42 props evaluated … a valid result"', /^42 props evaluated\. No player props currently meet EdgeDesk’s research threshold\. This is a valid result\.$/.test(O.emptyText(zero)), O.emptyText(zero));
  const none = { capture: { state: 'PRICED' }, evaluated_props: 0, priced_props: 35, top_opportunities: [], more: 0 };
  chk('priced, none evaluated: the count is 0, not the priced 35 (0 is a count, not a missing field)', O.evaluatedCount(none) === 0 && O.pricedNotEvaluated(none) && O.evaluatedCount({ priced_props: 35 }) === 35 && !O.pricedNotEvaluated(zero), [O.evaluatedCount(none), O.evaluatedCount({ priced_props: 35 })]);
  chk('…and the empty state says none of the 35 priced props could be evaluated, never "35 props evaluated"', /^None of the 35 priced props could be evaluated/.test(O.emptyText(none)) && !/35 props evaluated/.test(O.emptyText(none)), O.emptyText(none));
  const late = NOW + 3 * 3600e3;
  const evStale = O.eventFromSummary(SN, GID, late);
  chk('F: three hours later every summarized price is STALE: nothing is research grade, and it says why', evStale.stale_now && evStale.research_grade_now === 0 && evStale.top_opportunities.every((o) => o.decision === 'NO_DECISION' && o.code === 'STALE_QUOTE' && o.units === 0 && !o.research.grade), evStale.top_opportunities.map((o) => [o.decision, o.code]));
  chk('F: …the stale decision is only ever DOWN, and the evaluated one is kept beside it', evStale.top_opportunities.every((o) => o.evaluated && o.evaluated.decision !== 'NO_DECISION'));
  chk('F: …re-opened while fresh, the same object reads its own decision again', O.eventFromSummary(SN, GID, NOW).top_opportunities.every((o) => o.decision !== 'NO_DECISION' && !o.stale));
  chk('F: the empty state names the stale price, not missing markets', /past the 30-minute execution window/.test(O.emptyText(evStale)));
  chk('F: the league-wide leaders drop stale prices too', O.topFromSummary(SN, 5, late).length === 0 && O.topFromSummary(SN, 5, NOW).length > 0);

  /* ======================================================================= */
  section('G · a questionable player');
  const NQ = clone(NFL0), rq = NQ.props.find((r) => r.g === GID && r.p && r.e && r.e.d === 'BET');
  const pk = rq.p + '@' + rq.g; NQ.players[pk] = Object.assign({}, NQ.players[pk], { status: { status: 'QUESTIONABLE', practice: 'Limited', injury: 'Ankle', on_file: true } });
  const evq = E.boardEval(NQ, rq, NOW);
  chk('G: the kernel holds a questionable player at WATCH (AVAILABILITY PENDING): never a BET', evq.decision === 'WATCH' && evq.caps.some((c) => c.code === 'AVAILABILITY_PENDING'), [evq.decision, evq.caps]);
  const oq = O.fromPropRow(NQ, rq, { compact: E.compact(evq), now: NOW, ev: evq, context: O.gameContext(NQ.games.find((g) => g.game_id === GID), null, NQ), script_rule: RULE });
  chk('G: the research score discounts the unresolved status', oq.research.factors.availability === O.RULES.research.factor.availability, oq.research.factors);
  chk('G: the concerns name the designation and the wait', oq.explanation.concerns.some((t) => /QUESTIONABLE/.test(t)) && oq.explanation.concerns.some((t) => /status/.test(t)), oq.explanation.concerns);
  chk('G: WATCH carries no units', oq.units === 0);

  /* ======================================================================= */
  section('H · a saved prop whose line moved');
  const rh = NFL0.props.find((r) => r.g === GID && r.p && r.e && r.e.cand && ['rec_yds', 'rush_yds', 'pass_yds'].indexOf(r.m) >= 0 && (r.e.d === 'BET' || r.e.d === 'LEAN'));
  const oh = O.fromPropRow(NFL0, rh, { now: NOW });
  const entry = O.cardEntry(oh, { now: NOW });
  chk('ADD TO CARD snapshots id, type, decision, sport, event, market, line, side, price, book, probability, EV, edge, confidence, units, time — and the player', ['opportunity_id', 'type', 'decision', 'sport', 'event_key', 'market', 'line', 'side', 'american', 'book', 'probability', 'ev', 'edge_pp', 'confidence', 'units', 'saved_at', 'player_id', 'player_name', 'prop_type'].every((k) => entry[k] !== undefined && entry[k] !== null || (k === 'units')), entry);
  chk('the snapshot is frozen', Object.isFrozen(entry) && Object.isFrozen(entry.snapshot) && (() => { try { entry.line = 99; } catch (e) { /* strict */ } return entry.line !== 99; })());
  const NH = clone(NFL0), rhm = NH.props.find((r) => r.g === rh.g && r.p === rh.p && r.m === rh.m);
  const side = entry.side === 'over' ? 'o' : 'u', step = entry.side === 'over' ? 2 : -2;
  rhm.q = rhm.q.map((a) => (a[2] === side || a[2] === (side === 'o' ? 'u' : 'o')) && Math.abs(a[1] - entry.line) < 1e-9 ? [a[0], a[1] + step, a[2], a[3] - 5, a[4], a[5], a[6]] : a);
  const cur = E.boardEval(NH, rhm, NOW);
  const mv = O.priceMove(entry, cur);
  chk('H: PRICE MOVED — saved and current both shown', mv.comparable && mv.material && mv.line_move === step && /PRICE MOVED · Saved/.test(mv.text) && /Current/.test(mv.text), mv);
  chk('H: the current EV is its own number, and the saved line, price and EV are untouched', typeof mv.current_ev === 'number' && entry.line === oh.selection.line && entry.american === oh.price.american && entry.ev === oh.ev && mv.saved.ev === oh.ev, [mv.current_ev, entry.ev]);
  chk('H: the saved price is also re-priced at today\'s model (EV at the saved price now)', typeof mv.ev_at_saved_price_now === 'number');
  chk('H: an unchanged market reads unchanged', O.priceMove(entry, E.boardEval(NFL0, rh, NOW)).material === false);

  /* ======================================================================= */
  section('I · correlated positions in one game');
  const qb = NFL0.props.find((r) => r.g === GID && r.m === 'pass_yds' && r.p && r.e && r.e.cand);
  const wr = NFL0.props.find((r) => r.g === GID && r.m === 'rec_yds' && r.p && r.e && r.e.cand && (NFL0.players[r.p + '@' + r.g] || {}).team === (NFL0.players[qb.p + '@' + qb.g] || {}).team && (NFL0.players[r.p + '@' + r.g] || {}).pos === 'WR');
  const rb = NFL0.props.find((r) => r.g === GID && r.m === 'rush_att' && r.p && r.e && r.e.cand);
  const asBet = (r, side) => { const o = O.fromPropRow(NFL0, r, { now: NOW }); o.decision = 'BET'; o.engine_units = 0.25; o.units = 0.25; o.stage = 'TRACKING'; if (side) { o.selection = Object.assign({}, o.selection, { side: side }); o.key = o.key.replace(/\|(over|under)$/, '|' + side); } return O.cardEntry(o, { now: NOW }); };
  const eQB = asBet(qb, 'over'), eWR = asBet(wr, 'over'), eRB = asBet(rb, 'over');
  const gdec = { game_id: GID, sport: 'NFL', home: 'New Orleans Saints', away: 'Atlanta Falcons', kickoff: g0.kickoff, decision: 'BET', recommended_units: 0.5, market_type: 'spread', side: 'Atlanta Falcons', side_key: 'away', tier: 'STANDARD', calibrated_ev_pct: 6,
    bet_price: { side: 'away', team: 'Atlanta Falcons', line: 2.5, odds: -110, book: 'draftkings', decision_ev: 0.06 }, evaluated_at: new Date(NOW).toISOString() };
  const pos = O.cardPositions([gdec], [eQB, eWR, eRB], NOW);
  const models = { nfl: NFL0.correlation }, homeOf = () => g0.home;
  const X = O.cardExposure(pos, { bankroll_amount: 2500 }, { now: NOW, models, homeOf });
  chk('I: one bankroll: the game BET and the prop BETs are summed into one exposure', near(X.total_units, 0.5 + 0.75, 1e-9) && X.by_type.GAME.units === 0.5 && X.by_type.PLAYER_PROP.units === 0.75 && X.total_dollars === 31.25, X);
  const cg = X.correlated.find((c) => c.event_key === 'nfl|' + GID);
  chk('I: CORRELATED EXPOSURE — the units tied to this one game, and that they share game-script dependency', cg && near(cg.units, 1.25, 1e-9) && /You have 1\.25U tied to/.test(cg.text) && /share game-script dependency/.test(cg.text) && /not a forecast/.test(cg.text), cg && cg.text);
  const qw = cg.pairs.find((p) => [p.a, p.b].indexOf(eQB.key) >= 0 && [p.a, p.b].indexOf(eWR.key) >= 0);
  chk('I: QB passing over + his WR receiving over: the MEASURED correlation, positive', qw && qw.relation.kind === 'MEASURED' && qw.relation.rho > 0, qw);
  const gr = cg.pairs.find((p) => [p.a, p.b].indexOf(eRB.key) >= 0 && [p.a, p.b].some((k) => /^game\|/.test(k)));
  chk('I: a game market with a prop is STRUCTURAL — a direction, never an invented number', gr && gr.relation.kind === 'STRUCTURAL' && gr.relation.rho === undefined, gr);
  const tot = O.correlation([{ pos_key: 'g', type: 'GAME', league: 'nfl', event_key: 'nfl|Z', market_type: 'total', decision: 'BET', recommended_units: 0.5, entry: { side: 'over' } },
    { pos_key: 'p', type: 'PLAYER_PROP', league: 'nfl', event_key: 'nfl|Z', market_type: 'player_prop', category: 'passing', decision: 'BET', recommended_units: 0.25, entry: { market: 'pass_yds', side: 'under', team: 'A' } }], {}, () => 'H')[0];
  chk('I: game over + QB passing under offset each other (said, not summed as independent)', tot.offsetting && tot.pairs[0].relation.same === false, tot);
  const SAMEG = /^(SAME_GAME|OPPOSITE_SIDES_SAME_GAME)$/;
  const nNotes = (BK.exposure(pos.filter((p) => p.decision === 'BET'), {}, {}).correlation_notes || []).filter((n) => SAMEG.test(n.code)).length;
  chk('I: the bankroll\'s generic same-game note is replaced by the explained one (not both)', nNotes >= 1 && !X.correlation_notes.some((n) => SAMEG.test(n.code) && String(n.game_id) === String(GID)), X.correlation_notes);
  const groups = O.groupByGame(pos, NOW);
  chk('GROUP BY GAME: the game market, its props, and the total game exposure', groups.length === 1 && groups[0].game.length === 1 && groups[0].props.length === 3 && near(groups[0].units, 1.25, 1e-9), groups);
  chk('nothing is reduced automatically: every saved unit stays as saved', pos.filter((p) => p.source === 'saved').every((p) => p.recommended_units === 0.25));
  chk('filters: GAMES / PROPS and a prop category', O.passesFilter(pos[0], 'games') && !O.passesFilter(pos[0], 'props') && O.passesFilter(pos.find((p) => p.entry === eQB), 'passing') && O.passesFilter(pos.find((p) => p.entry === eRB), 'rushing') && O.passesFilter(pos[0], 'spread') && !O.passesFilter(pos[0], 'total'));

  /* ======================================================================= */
  section('the combined Card page');
  const U = require(path.join(ROOT, 'lib', 'edgedesk_decision_ui.js'));
  const page = U.cardPageHTML([gdec], { entries: [eQB, eWR, eRB], view: { filter: 'all', sort: 'kickoff' }, no_health: true, now: NOW });
  const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  chk('the Card: 4 BETS, 1.25U total exposure, games and props on one bankroll', /<b>4<\/b><span>BETS/.test(page) && /<b>1\.25U<\/b><span>TOTAL EXPOSURE/.test(page) && /GAMES<\/i> 0\.50U/.test(page) && /PLAYER PROPS<\/i> 0\.75U/.test(page), text(page).slice(0, 400));
  chk('…BET split into GAME BETS and PLAYER PROPS, each prop with player, selection, price and book', /GAME BETS/.test(page) && />PLAYER PROPS</.test(page) && page.indexOf(eQB.player_name) > 0 && page.indexOf(eQB.book) > 0);
  chk('…the correlated-exposure warning', /CORRELATED EXPOSURE/.test(page) && /share game-script dependency/.test(page));
  chk('…every filter, old and new', ['All', 'Games', 'Props', 'Bets', 'Leans', 'Watching', 'Pass', 'No decision', 'NFL', 'CFB', '0.25U', '0.50U', '0.75U', '1.00U'].every((f) => page.indexOf('>' + f + '<') >= 0) && /Group by game/.test(page));
  const pg = U.cardPageHTML([gdec], { entries: [eQB, eWR, eRB], view: { filter: 'all', sort: 'kickoff', group: true }, no_health: true, now: NOW });
  chk('Group by game: TOTAL GAME EXPOSURE 1.25U under the one game', /TOTAL GAME EXPOSURE/.test(pg) && /<b>1\.25U<\/b>/.test(pg) && />PROPS</.test(pg) && />GAME</.test(pg));
  const pp = U.cardPageHTML([gdec], { entries: [eQB, eWR, eRB], view: { filter: 'props', sub: 'passing', sort: 'kickoff' }, no_health: true, now: NOW });
  chk('Props › Passing shows the passing prop only', pp.indexOf(eQB.player_name) > 0 && /All props/.test(pp) && pp.indexOf('edd-r-saved') === pp.lastIndexOf('edd-r-saved'));
  chk('no card prints tout language', !BANNED.test(text(page)) && !BANNED.test(text(pg)));
  const plain = U.cardPageHTML([gdec], { entries: [], view: { filter: 'all', sort: 'kickoff' }, no_health: true, now: NOW });
  chk('with nothing saved the Card is the game Card it always was (no prop rows, no type line)', !/edd-r-saved/.test(plain) && !/edd-kpi-type/.test(plain) && /<b>0\.50U<\/b><span>TOTAL EXPOSURE/.test(plain));

  /* ---- the record split */
  const settled = [Object.assign({}, eQB, { grade: { result: 'WIN', units_won: 0.23 } }), Object.assign({}, eWR, { grade: { result: 'LOSS', units_won: -0.25 } }),
    { type: 'GAME', sport: 'NFL', units: 0.5, ev: 0.06, grade: { result: 'WIN', units_won: 0.45, clv: 1 } }];
  const R = O.recordSplit(settled);
  chk('the record: GAME and PLAYER PROP apart, ALL beside them — never pooled into one accuracy', R.GAME.n === 1 && R.PLAYER_PROP.n === 2 && R.ALL.n === 3 && R.GAME.wins === 1 && R.PLAYER_PROP.wins === 1 && R.PLAYER_PROP.losses === 1 && /never pooled/.test(R.note), R);
  const gradeW = O.gradePropEntry(eWR, [{ game_id: GID, player_id: eWR.player_id, market: eWR.market, value: eWR.line + 10 }]);
  const gradeV = O.gradePropEntry(eWR, [{ game_id: GID, player_id: eWR.player_id, market: eWR.market, result: 'VOID', reason: 'did not play' }]);
  chk('a saved prop grades at ITS OWN line from the graded box score (WIN), and a did-not-play is VOID', gradeW && gradeW.result === 'WIN' && gradeV && gradeV.result === 'VOID', [gradeW, gradeV]);

  /* ======================================================================= */
  section('the AI desk');
  chk('ask: a matchup question and a card question are told apart; "build my card" stays with the staking engine', O.classifyAsk('What should I research in Buffalo vs Miami?', false) === 'MATCHUP' && O.classifyAsk('What are the best opportunities on my card?', true) === 'CARD' && O.classifyAsk('Build my card for today', true) !== 'CARD' && O.classifyAsk('What are the best opportunities on my card?', false) !== 'CARD');
  const summaries = { nfl: SN, cfb: LC };
  const am = O.matchupAnswer(summaries, 'What should I research in Falcons vs Saints?', { now: NOW });
  chk('MATCHUP: the game, the GAME signal and the PLAYER PROPS signal', am && am.event_key === 'nfl|' + GID && /GAME — /.test(am.text) && /PLAYER PROPS — /.test(am.text) && /research threshold/.test(am.text), am && am.text);
  const quoted = (am.text.match(/[+−-]\d{3,4}\b/g) || []).map((x) => +x.replace('−', '-'));
  /* the captured best prices and the consensus prices at the line, as the summary holds them */
  const known = new Set([].concat(...evN.top_opportunities.map((o) => [o.price.american, o.market_view && o.market_view.over, o.market_view && o.market_view.under])));
  chk('MATCHUP: every sportsbook price quoted is one the summary holds (nothing invented)', quoted.length > 0 && quoted.every((p) => known.has(p)), [quoted, [...known]]);
  chk('MATCHUP: no tout words, no empty values', !BANNED.test(am.text) && !junk(am.text));
  const amStale = O.matchupAnswer(summaries, 'What should I research in Falcons vs Saints?', { now: late });
  chk('MATCHUP: a stale summary quotes no price and says why', amStale && !/[+−-]\d{3}\b/.test(amStale.text.split('PLAYER PROPS — ')[1] || '') && /30-minute execution window/.test(amStale.text), amStale && amStale.text);
  chk('MATCHUP: a team EdgeDesk has no game for is not guessed', O.matchupAnswer(summaries, 'What should I research in Toronto vs Montreal?', { now: NOW }) === null);
  const ca = O.cardAnswer({ entries: [eQB, eWR, eRB], decisions: [gdec] }, { now: NOW, models });
  chk('CARD: types, total exposure and the correlated game — from the Card only', ca && /4 BETs/.test(ca.text) && /1\.25U total exposure/.test(ca.text) && /games 0\.50U, player props 0\.75U/.test(ca.text) && /CORRELATED EXPOSURE/.test(ca.text), ca && ca.text);

  /* the real edge handler */
  const SITE = 'https://site.test';
  const ENV = { EDGEDESK_AI_NO_SERVE: '1', ANTHROPIC_API_KEY: 'test-key', SUPABASE_URL: 'https://sb.test', SUPABASE_ANON_KEY: 'anon-key', EDGEDESK_SITE_BASE: SITE };
  globalThis.Deno = { env: { get: (x) => ENV[x] } };
  const FILES = { '/football/props/nfl/summary.json': SN, '/football/props/cfb/summary.json': LC };
  let modelCalls = 0;
  globalThis.fetch = async function (url, init) {
    const s = String(url);
    if (s.indexOf('api.anthropic.com') >= 0) { modelCalls++; return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'ok' }] }), text: async () => 'ok' }; }
    if (s.indexOf(SITE) === 0) { const p = s.slice(SITE.length).split('?')[0], dd = FILES[p]; if (dd === undefined) return { ok: false, status: 404, text: async () => 'not found', json: async () => null }; return { ok: true, status: 200, text: async () => JSON.stringify(dd), json: async () => clone(dd) }; }
    if (init && init.method === 'HEAD') return { ok: true, status: 200, headers: { get: () => '*/0' }, text: async () => '' };
    if (s.indexOf('sb.test') >= 0 && s.indexOf('/subscriptions') >= 0) { const sub = [{ status: 'active', price_id: 'p', current_period_end: new Date(Date.now() + 30 * 864e5).toISOString() }]; return { ok: true, status: 200, text: async () => JSON.stringify(sub), json: async () => sub }; }
    if (s.indexOf('sb.test') >= 0) return { ok: true, status: 200, text: async () => '[]', json: async () => [] };
    return { ok: false, status: 404, text: async () => 'nope', json: async () => null };
  };
  const mod = await import(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', 'index.ts'));
  chk('the edge function exports opportunityTurn and inlines the opportunity layer', typeof mod.opportunityTurn === 'function');
  const t1 = await mod.opportunityTurn({ body: { question: 'What should I research in Falcons vs Saints?' }, auth: 'Bearer x', now: NOW });
  chk('opportunityTurn: MATCHUP RESEARCH, deterministic, the same text the page\'s library writes', t1 && t1.desk.intent === 'MATCHUP_RESEARCH' && t1.answer === am.text && t1.model === null && t1.research.research_context.game_id === GID, t1 && t1.answer);
  const t2 = await mod.opportunityTurn({ body: { question: 'What are the best opportunities on my card?', card: { entries: [eQB, eWR, eRB], decisions: [gdec] } }, auth: 'Bearer x', now: NOW });
  chk('opportunityTurn: the reader\'s CARD, with its exposure', t2 && t2.desk.intent === 'CARD' && t2.opportunity.exposure.total_units === 1.25, t2 && t2.opportunity);
  chk('opportunityTurn: a card question without a card is not answered here', (await mod.opportunityTurn({ body: { question: 'What are the best opportunities on my card?' }, auth: 'Bearer x', now: NOW })) === null);
  chk('opportunityTurn: an unrelated question falls through', (await mod.opportunityTurn({ body: { question: 'Who wins Falcons at Saints?' }, auth: 'Bearer x', now: NOW })) === null);
  chk('opportunityTurn: no model call anywhere', modelCalls === 0);

  console.log('');
  failures.forEach((f) => console.log('FAIL | ' + f));
  console.log((fail ? 'FAILED' : 'ALL GREEN') + ' opportunity layer — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
