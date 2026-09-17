#!/usr/bin/env node
/* ===========================================================================
   THE STRUCTURED ANSWER, AS THE PANEL RENDERS IT.

   The chat panel's structured-answer renderers are sliced out of the real
   app.html and run in a VM with the same helpers the page gives them. Every
   assertion is about the HTML a subscriber would see: the label chip, the
   model-versus-market cells with both timestamps and freshness badges, the
   price discipline line, the confidence split, the sources table, the
   critic's findings, the feedback controls — and that a five-section answer
   from the function is promoted the same way a four-section one was.

   Run: node tools/intelligence/structured_ui.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..', '..');
const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
const IDX = fs.readFileSync(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', 'index.ts'), 'utf8');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push({ name, detail }); }
function has(name, hay, needle) { chk(name, String(hay).indexOf(needle) >= 0, 'missing: ' + needle); }
function lacks(name, hay, needle) { chk(name, String(hay).indexOf(needle) < 0, 'present: ' + needle); }
function done() {
  failures.forEach((f) => console.log('FAIL | ' + f.name + '  ' + String(JSON.stringify(f.detail)).slice(0, 300)));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

/* ---- slice the real code out of the page ---------------------------------- */
const a = APP.indexOf('  var DESK_SECTIONS = [');
const b = APP.indexOf('  /* WHICH READ THE PANEL LEADS WITH.');
chk('the structured renderers are in app.html', a > 0 && b > a, { a, b });
const src = APP.slice(a, b);
has('the fifth Desk heading is registered', src, "key:'sides'");
has('a label chip renderer exists', src, 'function structuredLabelHTML');
has('a panels renderer exists', src, 'function structuredPanelsHTML');
has('freshness badges exist', src, 'function freshBadge');
has('the feedback recorder exists', src, 'function recordFeedback');
has('the label chip is rendered in the matchup turn', APP, 'var lede=structuredLabelHTML(d)+');
has('the panels are rendered under the research card', APP, '+structuredPanelsHTML(d)\n');
has('feedback is exposed on EDAI', APP, 'feedback: recordFeedback');
has('the CSS for the structured answer exists', APP, '.dk-structured{');
has('the grid stacks at phone width', APP, '@media (max-width:640px){.dk-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}');

const ctx = {
  esc: (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
  mdToHtml: (s) => '<p>' + String(s) + '</p>',
  document: { querySelector: () => null },
  localStorage: { setItem: () => {} },
  console,
};
vm.createContext(ctx);
vm.runInContext(src + '\nthis.DESK_SECTIONS=DESK_SECTIONS;this.structuredLabelHTML=structuredLabelHTML;this.structuredPanelsHTML=structuredPanelsHTML;this.deskProseHTML=deskProseHTML;this.freshBadge=freshBadge;', ctx);

/* ---- Slice 7: the board renderer ------------------------------------------ */
{
  const ba = APP.indexOf('  function boardWhen(c){');
  const bb = APP.indexOf('  function deskAnswerHTML(answer, S){');
  chk('the board renderer is in app.html', ba > 0 && bb > ba, { ba, bb });
  const bsrc = APP.slice(ba, bb);
  has('the board is rendered before the matchup summary in askAI', APP, "if(d&&d.board&&d.board.schema==='edgedesk_board_v1'){");
  has('best-bet questions go to the desk', APP, 'if(wantsBoard(t) || (LAST_BOARD && !ctx && !isDailyScan(t))){');
  has('the local scan is announced as an offline fallback', APP, 'It is an offline fallback, not the desk');
  has('the board state is carried back', APP, 'if(LAST_BOARD) c.board=LAST_BOARD;');
  has('the browser sends its time zone', APP, 'timezone:clientTimeZone()');
  const bctx = { esc: ctx.esc, mdToHtml: ctx.mdToHtml, freshBadge: (f) => '<i class="fb">' + f + '</i>', obsAt: (iso) => iso ? String(iso).slice(0, 16) : '—', marketWord: (m) => m === 'spreads' ? 'spread' : m === 'totals' ? 'total' : 'moneyline', console };
  vm.createContext(bctx);
  vm.runInContext(bsrc + '\nthis.boardAnswerHTML=boardAnswerHTML;', bctx);
  const opp = { id: 'a', sport: 'americanfootball_ncaaf', sport_label: 'college football', game_id: '401858900', matchup: 'North Texas @ Texas State', home: 'Texas State', away: 'North Texas', kickoff: '2026-09-22T21:24:00.000Z', kickoff_local: 'Tue, Sep 22, 4:24 PM CDT', market: 'spreads', side: 'away', selection: 'North Texas', line: -2.5,
    quote: { book: 'DraftKings', odds_american: -105, odds_decimal: 1.95, captured_at: '2026-09-16T21:11:28.903Z', freshness: 'CURRENT', actionable: true, age_min: 14, source: 'signals (EdgeDesk capture)', executable: true },
    fair: { method: 'MARKET_DEVIG', label: 'Pinnacle de-vig fair', probability: 0.532, american: -114, validation: { tier: null, note: 'the fair is a de-vigged market reference' } },
    edge: { ev_per_unit: 0.0374, probability_edge_pp: 1.92, break_even: 0.5128, uncertainty: 'The de-vig fair carries no confidence interval.' },
    decision: { decision: 'BET CANDIDATE' }, threshold: { kind: 'price', price_limit_american: -112, line: -2.5, method: 'the worst price at which the de-vig fair still clears the floor' },
    reasons: [{ text: 'Fair price -114 against -105 at DraftKings', source: 'signals (EdgeDesk capture, SHARP_REFERENCE_DEVIG)', observed_at: '2026-09-16T21:11:28.903Z' }, { text: '6 independent book families', source: 'signals', observed_at: '2026-09-16T21:11:28.903Z' }],
    counter: 'The case is the price, not the matchup.', would_change: ['A price worse than -112 ends this.'], qualification: { status: 'QUALIFIED', rules: ['R3_MARKET: BET CANDIDATE with a live price'], lean: false }, rank: 1,
    model_case: { status: 'CONDITIONAL', tier: 'RESEARCH', fair_line: -2.5, cover_at_market: 0.5 } };
  const watch = Object.assign({}, opp, { id: 'w', sport: 'americanfootball_nfl', sport_label: 'NFL', matchup: 'Cincinnati Bengals @ Houston Texans', selection: 'Houston Texans', line: -3, quote: { executable: false, source: 'nflverse consensus (reference, no book, no capture time)', freshness: 'LINE_ONLY' }, fair: { method: 'MODEL_BLEND', fair_line: -3.6, probability: 0.53, validation: { tier: 'LEAN' } }, edge: { probability_edge_pp: 0.6, break_even: 0.524, uncertainty: 'sigma 13.2' }, threshold: { kind: 'line', bet_to_line: -3.5, method: 'the selection line where the fair cover meets break-even', note: 'LEAN tier' }, qualification: { status: 'WATCH', rules: ['R4_MODEL: LEAN_PLAY on a reference line with no executable price'], lean: true } });
  const board = { schema: 'edgedesk_board_v1', headline: '1 qualified opportunity across 2 sports evaluated for the next 7 days.', opportunities: [opp], watchlist: [watch], research_leads: [], data_checks: [], unsupported: [{ market: 'player_prop', label: 'player props', note: 'EdgeDesk has no pricing method for player props' }], candidates_considered: 9,
    coverage: [{ sport: 'americanfootball_nfl', label: 'NFL', status: 'EVALUATED', eligible: 7 }, { sport: 'tennis_wta', label: 'WTA tennis', status: 'RETRIEVAL_FAILED', eligible: 0, errors: ['games could not be read (HTTP 500)'] }],
    scope: { timezone: { zone: 'America/Chicago', source: 'client' }, window: { label: 'the next 7 days' }, follow_up: null }, freshness: { quotes: { newest: '2026-09-16T21:11:28.903Z', oldest: '2026-09-16T21:11:28.903Z' }, research: { newest: '2026-09-16T18:22:49.709Z' } }, note: 'Research, not picks.', no_bankroll_assumption: 'No stake, bankroll or risk preference is assumed.' };
  const html = bctx.boardAnswerHTML({ board }, 'The one qualified opportunity is North Texas -2.5.');
  has('the prose leads', html, 'The Desk’s read');
  has('the pick shows matchup, market and selection', html, '<b>North Texas -2.5</b> — North Texas @ Texas State');
  has('with its local start time', html, 'Tue, Sep 22, 4:24 PM CDT');
  has('the book, price and capture time with a freshness badge', html, 'DraftKings -105 · captured 2026-09-16T21:11 (14 min ago) <i class="fb">CURRENT</i>');
  has('the fair estimate names its method', html, 'fair -114 (Pinnacle de-vig fair)');
  has('the edge with its uncertainty', html, 'The de-vig fair carries no confidence interval.');
  has('every reason carries its source and time', html, 'signals (EdgeDesk capture, SHARP_REFERENCE_DEVIG) · 2026-09-16T21:11');
  has('the counterargument', html, 'Strongest case against');
  has('what would change it', html, 'A price worse than -112 ends this.');
  has('the threshold with its method', html, 'Playable to -112 at -2.5');
  has('the detail is expandable', html, '<details class="dk-more"><summary>Evidence, counter-case, threshold</summary>');
  has('the watchlist is labelled a threshold, not a bet', html, 'Watchlist — a threshold, not a bet');
  has('a reference line says it has no executable price', html, 'no executable price captured · nflverse consensus');
  has('LEAN is said on the watchlist row', html, '<b>LEAN</b>: break-even history, not a profit');
  has('the unsupported market is named', html, 'EdgeDesk has no pricing method for player props');
  has('coverage names the failed sport with the reason', html, 'WTA tennis — retrieval failed<div class="m">games could not be read (HTTP 500)</div>');
  has('the window and time zone are shown', html, 'the next 7 days · America/Chicago');
  has('quote freshness and research freshness are shown separately', html, 'quotes captured 2026-09-16T21:11 to 2026-09-16T21:11 · research artifacts built 2026-09-16T18:22');
  has('no bankroll is assumed', html, 'No stake, bankroll or risk preference is assumed.');
  lacks('no database state reaches the reader', html, 'RETRIEVAL_FAILED');
  const none = bctx.boardAnswerHTML({ board: Object.assign({}, board, { opportunities: [], headline: 'Nothing qualifies.' }) }, '');
  has('with no prose and nothing qualified the headline leads', none, '<p>Nothing qualifies.</p>');
  has('and the watchlist is framed as the closest, not a pick', none, 'Nothing qualifies — the closest, with the number that would change it');
  const rep = bctx.boardAnswerHTML({ board: Object.assign({}, board, { repriced: { ok: true, selection: 'North Texas', verdict: 'does not clear the floor at -125', note: '', freshness_note: 'The new price is the reader’s report.' } }) }, 'x');
  has('a repriced follow-up is shown at the top', rep, 'AT YOUR NUMBER');
}

/* ---- Slice 8: the staking panel ------------------------------------------- */
{
  const sa = APP.indexOf('  function stakeUnits(u){');
  const sb2 = APP.indexOf('  function boardAnswerHTML(d, answer){');
  chk('the staking renderer is in app.html', sa > 0 && sb2 > sa, { sa, sb2 });
  const ssrc = APP.slice(sa, sb2);
  has('the staking vocabulary reaches the desk', APP, "if(/\\bhow many units\\b|\\bunit size\\b");
  has('a single-game card is rendered when there is no board', APP, "if(d&&d.stake_card&&!d.board&&d.stake_card.schema==='edgedesk_stake_card_v1'){");
  has('the card is rendered under the board answer', APP, 'boardAnswerHTML(d,ansB)+stakeAnswerHTML(d)');
  has('the bankroll editor writes the reader’s own row', APP, "sbUpsert('bankroll_settings?on_conflict=user_id'");
  has('and the upsert merges duplicates under the caller’s token', APP, 'resolution=merge-duplicates');
  const sctx = { esc: ctx.esc, mdToHtml: ctx.mdToHtml, obsAt: (iso) => iso ? String(iso).slice(0, 16) : '—', console };
  vm.createContext(sctx);
  vm.runInContext(ssrc + '\nthis.stakeAnswerHTML=stakeAnswerHTML;', sctx);
  const rec = {
    event_id: '401858900', sport: 'americanfootball_ncaaf', sport_label: 'college football', matchup: 'North Texas @ Texas State',
    market: 'spread', market_key: 'spreads', selection: 'North Texas', line: -2.5, american_odds: -105, decimal_odds: 1.9524, sportsbook: 'DraftKings',
    price_captured_at: '2026-09-16T21:11:28.903Z', price_freshness: 'CURRENT', price_age_seconds: 840,
    model_probability: null, calibrated_probability: 0.56, conservative_probability: 0.5374, conservative_method: 'SHRINK_TO_HALF_BY_RELIABILITY',
    no_vig_market_probability: 0.56, model_edge: 0, conservative_edge: -0.0226, expected_value: 0.0494, fair_odds: -116, fair_line: -2.5,
    reliability_score: 0.6679, reliability_components: [], raw_kelly_fraction: 0.0303, fractional_kelly_fraction: 0.0076, kelly_multiplier: 0.25,
    recommended_units: 0.5, recommended_dollars: 12.5, recommendation_tier: 'STANDARD', recommendation_label: 'STANDARD — 0.50u',
    primary_reason: 'At -105 at DraftKings the price requires 51.2%; the staking probability after uncertainty is 53.7%.',
    strongest_counterargument: 'The de-vig fair assumes the book margin sits evenly on both sides.',
    invalidation_conditions: ['A starter change on either side.'],
    existing_team_exposure_units: 0, resulting_team_exposure_units: 0.5, existing_game_exposure_units: 0, resulting_game_exposure_units: 0.5,
    existing_daily_exposure_units: 0, resulting_daily_exposure_units: 0.5, existing_weekly_exposure_units: 0, resulting_weekly_exposure_units: 0.5,
    exposure_keys: { team: 'north texas', team_label: 'North Texas' }, correlated_exposure: [], warnings: [], gates_failed: [],
    price_limit_american: -112, bet_to_line: null, status: 'BET',
    policy: { max_team: 1.5, max_game: 1.25, max_daily: 4, max_weekly: 8 },
  };
  const card = {
    schema: 'edgedesk_stake_card_v1', id: 'card_1', headline: '1 recommended position totalling 0.50u ($12.50) from 8 markets evaluated across 3 games.',
    markets_evaluated: 8, games_evaluated: 3, recommendations: [rec], watchlist: [], passes: [], research_only: [], games: [], portfolio_actions: [],
    caps: { single: 1, game: 1.25, team: 1.5, daily: 4, weekly: 8 }, total_recommended_units: 0.5, total_recommended_dollars: 12.5,
    parlay: { built: false, requested: false, why: 'No parlay was requested and parlays are not enabled in your settings.' },
    policy: { bankroll_known: true, base_unit_amount: 25, dollars_note: 'Dollar figures use your stored bankroll of $2500.', basis: 'EdgeDesk default risk policy: 0.25 Kelly.' },
    conviction_note: 'A reader’s conviction is context, never an input.', note: 'The language model may explain this card; it may not change a number in it.',
  };
  const h = sctx.stakeAnswerHTML({ stake_card: card });
  has('the sized position leads with the selection and the number', h, '<b>North Texas -2.5</b>');
  has('the tier and the dollar figure are printed', h, '<b>STANDARD — 0.50u</b> · $12.50');
  has('the best price, book and capture time', h, 'Best price -105 at DraftKings · captured 2026-09-16T21:11 (CURRENT)');
  has('the calibrated, conservative and no-vig probabilities are all shown', h, 'Calibrated 56.0% · conservative 53.7% · no-vig market 56.0%');
  has('the expected value and the fair price', h, 'EV +4.9% · fair -116');
  has('the reliability score and the Kelly working', h, 'Reliability 0.6679 · Kelly 0.0303 × 0.25');
  has('the exposure after the wager, against the caps', h, 'Exposure after: 0.50u on this team (cap 1.5u) · 0.50u on the game (cap 1.25u) · 0.50u today (cap 4u)');
  has('the price it is playable through', h, 'Playable through -112');
  has('the main risk', h, '<b>Main risk:</b> The de-vig fair assumes');
  has('what would invalidate it', h, '<b>Invalidated by:</b> A starter change');
  has('the card total against the daily and weekly caps', h, 'Card total 0.50u / $12.50 · daily cap 4u · weekly cap 8u');
  has('the conviction note reaches the reader', h, 'conviction is context, never an input');
  /* NO BET renders as a pass, with the count and the reason */
  const none = sctx.stakeAnswerHTML({ stake_card: Object.assign({}, card, {
    recommendations: [], total_recommended_units: 0, total_recommended_dollars: null,
    headline: 'NO BET. EdgeDesk evaluated 8 current markets and none produced positive conservative expected value after uncertainty, price freshness and existing exposure.',
    watchlist: [Object.assign({}, rec, { recommended_units: 0, recommended_dollars: null, status: 'WATCH', expected_value: 0.004, gates_failed: [{ code: 'BELOW_MINIMUM_UNIT', detail: '0.14u rounds DOWN to 0u, below the 0.25u minimum' }] })],
    strongest_research_candidate: { selection: 'North Texas', why_not: 'the position it earns rounds below the minimum stake' },
  }) });
  has('a pass is rendered as NO BET', none, '<div class="h">No bet</div>');
  has('with the number of markets evaluated', none, 'EdgeDesk evaluated 8 current markets');
  has('and the strongest research candidate with its reason', none, 'Strongest research candidate: North Texas — the position it earns rounds below the minimum stake');
  has('and the pass is said to be a successful result', none, 'A pass is a successful result. Nothing is forced.');
  has('positive value with no stake is labelled as such, never as a bet', none, '<div class="h">Positive value, no stake</div>');
  has('with the reason it was not sized', none, '0.14u rounds DOWN to 0u, below the 0.25u minimum');
  /* no bankroll: units only, and the editor is offered */
  const nb = sctx.stakeAnswerHTML({ stake_card: Object.assign({}, card, {
    recommendations: [Object.assign({}, rec, { recommended_dollars: null })], total_recommended_dollars: null,
    policy: { bankroll_known: false, base_unit_amount: 25, dollars_note: 'No bankroll amount is stored, so the recommendation is in UNITS.', basis: 'EdgeDesk default risk policy: 0.25 Kelly.' },
  }) });
  has('with no bankroll the sizes are in units', nb, '<b>STANDARD — 0.50u</b>');
  lacks('and no dollar figure is printed at all', nb, '$12.50');
  has('the reader is told why and offered the editor', nb, 'EDAI.openBankroll()');
  has('the note explains what the setting adds', nb, 'EdgeDesk will state the exact dollar stake');

  /* ── THE ACCEPTANCE LOOP ─────────────────────────────────────────────
     Whether the reader took it is the one thing the desk cannot compute,
     and without it the engine's record and the reader's record collapse
     into the same number. */
  const withId = sctx.stakeAnswerHTML({ stake_card: Object.assign({}, card, { recommendations: [Object.assign({}, rec, { recommendation_id: 'stake_abc123' })] }) });
  has('the reader is asked whether they took it', withId, 'Did you take it?');
  has('taking it at the recommended size is one click, with the size on the button', withId, 'Took it at 0.50u');
  has('passing is the same', withId, '>Passed<');
  has('and a different size is recordable, in units', withId, 'id="sru_stake_abc123"');
  has('every button carries the recommendation id it answers', withId, 'EDAI.respondStake(&quot;stake_abc123&quot;,\'ACCEPTED\')');
  has('a resize is recorded as MODIFIED, not as agreement', withId, "respondStake(&quot;stake_abc123&quot;,'MODIFIED')".replace(/'/g, "\'"));
  has('the declined path is recorded as DECLINED', withId, "respondStake(&quot;stake_abc123&quot;,'DECLINED')".replace(/'/g, "\'"));
  lacks('a recommendation with no id shows no buttons rather than a broken one', h, 'Did you take it?');
  /* the write itself: an append-only INSERT, never an edit of the snapshot */
  has('the response is inserted, not upserted', APP, "sbPost('stake_recommendation_responses'");
  has('and the reader’s own units are what is recorded on a resize', APP, 'row.accepted_units = n;');
  has('the reader is told the two records stay separate', APP, 'graded separately');
  lacks('nothing in the acceptance path writes back to the recommendation', APP, "sbUpsert('stake_recommendations");

  /* ── ONE FRESH PRICE AWAY ────────────────────────────────────────────
     The difference between "EdgeDesk disagrees with this" and "EdgeDesk has
     not looked at the price recently enough" is the whole reason a reader
     would go back to the book, and the panel has to say which it is. */
  const opa = sctx.stakeAnswerHTML({ stake_card: Object.assign({}, card, {
    recommendations: [], total_recommended_units: 0, total_recommended_dollars: null,
    one_price_away: { count: 1, note: '1 position(s) failed only because the captured price is outside its freshness limit.',
      positions: [{ selection: 'North Texas', market: 'spread', line: -2.5, matchup: 'North Texas @ Texas State', sportsbook: 'DraftKings', american_odds: -105, expected_value: 0.0494, price_freshness: 'STALE', why: 'the captured price is STALE (360 minutes old)' }] },
  }) });
  has('the stale-only refusals are named as their own section', opa, '<div class="h">One fresh price away</div>');
  has('with the selection, the price and the book', opa, '<b>North Texas -2.5</b> -105 at DraftKings');
  has('and the exact reason, in minutes', opa, 'the captured price is STALE (360 minutes old)');
  has('and the expected value it would have had, at zero units', opa, '+4.9% conservative EV, 0u');
  lacks('a card with no stale-only refusal shows no such section', h, 'One fresh price away');
  /* the trigger itself: a capture pass is spent on targets, not on staleness */
  has('the refresh is targeted at prices that could still change an answer', IDX, 'export function refreshTargets');
  has('and every refresh records what it bought', IDX, 'export function refreshOutcome');
  has('a game that already started is never a refresh target', IDX, 'if (kick != null && kick <= now) continue;');
  has('and a refresh that changed nothing says so', IDX, 'is still outside its freshness limit, so the refusals stand');

  /* ── THE EXPOSURE BLIND SPOT ─────────────────────────────────────────
     A cap computed only from what EdgeDesk recommended is a cap on the
     part of the reader's book this system can see, which is a different
     and much weaker promise than the one the number implies. */
  const ea = APP.indexOf('  var EXTERNAL_FIELDS = [');
  const eb = APP.indexOf('  window.EDAI = {');
  chk('the declared-position editor is in app.html', ea > 0 && eb > ea, { ea, eb });
  const esrc = APP.slice(ea, eb);
  const ectx = { esc: ctx.esc, $id: () => null, console, push: () => {}, sbGet: async () => [], sbPost: async () => true, edToken: async () => 't', fetch: async () => ({ ok: true }), SB_URL: '', SB_KEY: '' };
  vm.createContext(ectx);
  vm.runInContext(esrc + '\nthis.externalFormHTML=externalFormHTML;this.EXTERNAL_FIELDS=EXTERNAL_FIELDS;', ectx);
  const emptyForm = ectx.externalFormHTML([]);
  has('the reader is told why declaring matters', emptyForm, 'Every exposure cap is computed from positions EdgeDesk recommended');
  has('and what the caps see today when nothing is declared', emptyForm, 'the caps currently see only what EdgeDesk recommended'.replace('the c', 'The c'));
  has('the size is asked for in units', emptyForm, 'id="ext_units"');
  has('and the team the cap should count it against', emptyForm, 'id="ext_team"');
  has('a declared position is never graded, and the form says so', emptyForm, 'never graded, never scored, and never part of EdgeDesk’s record');
  has('and that it can only make EdgeDesk size less', emptyForm, 'only ever make EdgeDesk size LESS');
  const listed = ectx.externalFormHTML([{ id: 7, selection: 'Army -2.5', units: 1.5, book: 'FanDuel', matchup: 'North Texas at Army' }]);
  has('a declared position is listed with its size', listed, 'Army -2.5 — 1.50u at FanDuel');
  has('and can be settled', listed, 'EDAI.settleExternal(7)');
  has('or removed, because this is the reader’s own book', listed, 'EDAI.removeExternal(7)');
  /* the wiring: the engine must read the union, not just its own trail */
  has('the desk reads open exposure from the view that unions both kinds', IDX, 'stake_open_exposure?select=ticket_id,kind');
  has('and a declared position is labelled as one EdgeDesk did not price', IDX, 'EdgeDesk did not price it and does not grade it');
  lacks('the caps no longer read the recommendation trail directly for exposure', IDX, 'stake_recommendations?select=recommendation_id,sport,game_id,matchup,market,selection,side,handicap,recommended_units');
}

const S = {
  schema: 'edgedesk_structured_answer_v1', prose_status: 'MODEL', packet_id: '401858900:ca8396f3',
  bottom_line: { label: 'PRICE DEPENDENT', decision: 'BET CANDIDATE', sentence: 'PRICE DEPENDENT — the case rests on the price, and ends when the price does.', read: { text: 'x', author: 'model' } },
  model_vs_market: {
    model_line: { home_line: 2.4, total: 58.1, favourite: 'North Texas', version: 'edgedesk_cfb_p4', generated_at: '2026-09-15T22:38:53Z', age: '3 h ago', freshness: 'LIVE', tier: 'RESEARCH' },
    market_line: { market: 'spreads', selection: 'North Texas', handicap: -2.5, price: '-105', book: 'DraftKings', captured_at: '2026-09-16T01:27:20Z', age: '14 min ago', freshness: 'LIVE', actionable: true, fair: 'Pinnacle de-vig fair' },
    consensus: null, gap_points: -0.1, orientation: { favourite_model: 'North Texas', favourite_market: 'North Texas', faults: [] },
    best_price: { american: '-105', book: 'DraftKings', freshness: 'LIVE' },
    movement: { opener_american: '-110', current_american: '-105', price_move_cents: 5, point_move: null, cause: 'UNKNOWN', cause_note: 'EdgeDesk records prices, not handle.' },
  },
  price_discipline: { current_price: '-105 at DraftKings', playable_to: '-112', price_needed: null, break_even_probability: 0.5128, ev_per_unit: 0.0374, ev_basis: 'Expected value measured against the market fair price, NOT produced by EdgeDesk’s model.' },
  confidence: { data: { band: 'LOW', score: 0.36, missing: ['availability for both sides', 'matchup drivers'] }, conclusion: { band: 'MEDIUM', score: 0.6, missing: ['validated probability in this market'] } },
  what_could_break_it: { unknowns: ['Availability for the home side is UNKNOWN.', 'Weather is not on file for this game.'] },
  sources: [
    { source: 'football/fbs/slate.json', kind: 'edgedesk_artifact', observed_at: null, freshness: 'LIVE' },
    { source: 'signals (DraftKings, spreads)', kind: 'market_capture', observed_at: '2026-09-16T01:27:20Z', freshness: 'LIVE' },
    { source: 'cfb.lines (consensus, no book, no timestamp)', kind: 'reference_number', observed_at: null, freshness: 'UNKNOWN' },
  ],
};
const critic = { verdict: 'WARN', findings: [{ code: 'NUMBER_NOT_IN_EVIDENCE', severity: 'WARN', detail: 'numbers with no source in the packet: 37' }] };

const label = ctx.structuredLabelHTML({ structured: S });
has('the label chip names the label', label, 'PRICE DEPENDENT');
has('and its sentence', label, 'ends when the price does');
lacks('an accepted answer is not marked rejected', label, 'rejected');
const rej = ctx.structuredLabelHTML({ structured: Object.assign({}, S, { prose_status: 'REJECTED' }) });
has('a rejected answer says so', rej, 'rejected by EdgeDesk');

const panels = ctx.structuredPanelsHTML({ structured: S, critic });
has('the model cell carries the home line', panels, 'home +2.4');
has('and the total', panels, 'total 58.1');
has('and the model version and age', panels, 'edgedesk_cfb_p4 &middot; 3 h ago'.replace('&middot;', '·'));
has('the market cell carries the price and book', panels, 'North Texas -2.5 at -105');
has('and the capture age', panels, 'captured 14 min ago');
has('with a LIVE badge', panels, 'dk-fresh live">LIVE');
has('the gap cell states both favourites', panels, 'model North Texas · market North Texas');
has('the best captured price is labelled as captured, not best anywhere', panels, 'among the books EdgeDesk captured');
has('price discipline carries playable-to', panels, 'Playable to <b>-112</b>');
has('and break-even', panels, 'Break-even 51.3%');
has('and expected return', panels, 'Expected return 3.74% per unit');
has('and says whose probability it is', panels, 'NOT produced by EdgeDesk');
has('movement is shown with its cause UNKNOWN', panels, 'Cause: <b>UNKNOWN</b>');
has('data confidence is shown', panels, 'Data confidence');
has('conclusion confidence is shown separately', panels, 'Conclusion confidence');
has('and names what is missing', panels, 'missing: availability for both sides');
has('unknowns are listed', panels, 'What EdgeDesk cannot see (2)');
has('sources are listed with observed times', panels, '2026-09-16 01:27Z');
has('an unknown-freshness source gets an UNKNOWN badge', panels, 'dk-fresh unknown">UNKNOWN');
has('the critic findings are disclosed', panels, 'checks on the written read: WARN (1)');
has('with the finding code', panels, 'NUMBER_NOT_IN_EVIDENCE');
has('feedback: helpful', panels, "EDAI.feedback('helpful'");
has('feedback: wrong data', panels, "EDAI.feedback('wrong_data'");
has('the packet id travels with feedback', panels, '401858900:ca8396f3');
chk('no panel is rendered without a structured answer', ctx.structuredPanelsHTML({}) === '' && ctx.structuredLabelHTML({}) === '');

const noMarket = ctx.structuredPanelsHTML({ structured: Object.assign({}, S, { model_vs_market: Object.assign({}, S.model_vs_market, { market_line: null, best_price: null, consensus: { spread_home: 2.5, total: 57.5 } }) }) });
has('with no book price the consensus number is shown as a consensus', noMarket, 'consensus home +2.5');
has('and labelled as having no book and no capture time', noMarket, 'no book, no capture time');

/* ---- Slice 2: the football evidence ---------------------------------------- */
has('the football evidence renderer exists', src, 'function footballEvidenceHTML');
has('and is rendered inside the panels', src, 'h+=footballEvidenceHTML(S);');
has('the CSS for the evidence exists', APP, '.dk-drv{');
has('and for the availability state chip', APP, '.dk-state.official{');
const CFB = Object.assign({}, S, {
  matchup: { home: { team: 'Texas State' }, away: { team: 'North Texas' }, source: 'football/fbs/slate.json',
    ratings: { home: { team: 'Texas State', etsr: 3.7, rank: 22, confidence: 0.405, games_used: 2, freshness: 'LIVE', basis: 'ETSR is a neutral-field rating in points against the league mean.' }, away: { team: 'North Texas', etsr: 6.1, rank: 14, confidence: 0.41, games_used: 2, freshness: 'LIVE' } },
    coaching: { home: { hc: 'G.J. Kinne', tenure_seasons: 4, new_hc: false, unknown: ['oc', 'dc'], freshness: 'LIVE' }, away: { value: null, missing: true, reason: 'coaching continuity not on file' } },
    profiles: { home: { plays_per_game: 75.5, pass_rate: 0.4041, points_for_per_game: 16.5, points_against_per_game: 45, freshness: 'LIVE' }, away: null } },
  why_the_number: { prose: null, model_drivers: { positive: [], negative: [], source: null }, drivers: [
    { id: 'explosive_pass_rate', label: 'Explosive pass rate', attacker: 'North Texas', defender: 'Texas State', favoured: 'North Texas', advantage_z: 1.7, gap_word: 'a wide gap',
      attacker_value: { show: '28.3%', league: '10.4%', show_basis: 'opponent-adjusted' }, defender_value: { show: '7.5%', league: '10.4%' }, reliability: 0.76,
      sentence: 'North Texas explosive pass rate 28.3% (league 10.4%) against Texas State explosive passes allowed 7.5% (league 10.4%) — a wide gap in North Texas’s favour.',
      source: 'football/matchup/metrics.json (from football/rankings/current.json)', observed_at: '2026-09-16T04:04:38.630Z', freshness: 'LIVE' },
    { id: 'pressure_rate', label: 'Pressure rate', attacker: 'Texas State', defender: 'North Texas', favoured: 'Texas State', gap_word: 'a narrow gap', attacker_value: { show: '9.1%', league: '8.0%' }, defender_value: { show: '7.2%', league: '8.0%' }, reliability: 0.5, sentence: 'x', source: 'football/matchup/metrics.json', observed_at: '2026-09-16T04:04:38.630Z', freshness: 'LIVE' },
  ] },
  availability: { home: { state: 'UNKNOWN', sentence: 'No availability record is on file for Texas State. THIS IS UNKNOWN, NOT HEALTHY.', source: 'football/availability/current.json', observed_at: '2026-09-15T21:15:29.273Z', freshness: 'LIVE' },
    away: { value: null, missing: true, reason: 'no availability record for the away side' }, states_note: 'UNKNOWN is not healthy. Only NO_REPORTED_INJURIES means an official report was read and listed nobody.' },
  starters: { home: { position: 'QB', player_name: 'Brad Jackson', status: 'PREVIOUS_GAME', confirmed: false, availability: { state: 'UNKNOWN' }, source: 'cfbfastR-data player_stats — play attribution', retrieved_at: '2026-09-16T01:39:32.535Z', freshness: 'LIVE' },
    away: { value: null, missing: true, reason: 'no projected starter on file for the away side' }, note: 'Only ANNOUNCED with confirmed:true is a confirmed starter.' },
  injuries: { home: null, away: null },
  situation: { rest_days: { home: 14, away: 14 }, weather: { value: { temp_f: 84.2, wind_mph: 11.6, wind_from: 'S', precip_pct: 20, text: 'partly cloudy' }, source: 'football/venues/forecasts.json (open-meteo)', observed_at: '2026-09-16T00:10:00Z', freshness: 'LIVE' }, travel: { value: null, missing: true, reason: 'travel distance and time zone are not computed' }, surface: null, roof: null, division_game: null },
});
const fb = ctx.structuredPanelsHTML({ structured: CFB });
has('the drivers section counts the drivers', fb, 'Matchup drivers (2)');
has('a driver names the side it favours', fb, '<span class="fav">North Texas</span>');
has('and the width of the gap', fb, 'a wide gap');
has('and carries its sentence with both league means', fb, 'league 10.4%');
has('and both unit values', fb, 'Texas State allows 7.5%');
has('and its reliability', fb, 'reliability 76%');
has('and says the figure is opponent-adjusted', fb, 'opponent-adjusted');
has('and its source and observed time', fb, 'football/matchup/metrics.json (from football/rankings/current.json) · observed 2026-09-16 04:04Z');
has('availability UNKNOWN is a warning chip, not a clean sheet', fb, 'dk-state unknown">UNKNOWN');
has('and its sentence is shown', fb, 'THIS IS UNKNOWN, NOT HEALTHY');
has('a missing availability side names the reason', fb, 'no availability record for the away side');
has('the states note is shown', fb, 'Only NO_REPORTED_INJURIES means an official report was read');
has('the projected starter is named', fb, 'Brad Jackson');
has('and is marked not confirmed', fb, '<b>not confirmed</b> · previous game');
has('with its source', fb, 'cfbfastR-data player_stats');
has('a missing starter side says so', fb, 'no projected starter on file for the away side');
has('rest days are shown for both sides', fb, '14d · 14d');
has('the forecast carries temperature, wind and precipitation', fb, '84°F · wind 12 mph S · precip 20%');
has('and its source and observed time', fb, 'football/venues/forecasts.json (open-meteo) · 2026-09-16 00:10Z');
has('travel that is not computed says so', fb, 'travel distance and time zone are not computed');
has('the ratings disclosure carries ETSR with the rank', fb, 'ETSR +3.7 (#22)');
has('and the rating confidence', fb, 'confidence 41%');
has('and the head coach with what is unknown', fb, 'HC G.J. Kinne · season 4 · oc/dc unknown');
has('and the play profile', fb, '75.5 plays/g · pass 40%');
has('and the neutral-field basis', fb, 'neutral-field rating');
lacks('no engine contributions are shown when none are published', fb, 'What carries the projection');

const NFL = Object.assign({}, CFB, {
  matchup: { home: { team: 'Buffalo Bills' }, away: { team: 'Detroit Lions' }, source: 'football/nfl/slate.json', profiles: { home: null, away: null }, ratings: { home: null, away: null }, coaching: { home: { missing: true }, away: { missing: true } } },
  why_the_number: { prose: null, drivers: [], model_drivers: { positive: ['net passing EPA per dropback: +1.59 points toward Buffalo Bills'], negative: ['quarterback adjustment: -0.05 points toward Detroit Lions'], source: 'football/nfl/slate.json (engine contributions)' } },
  availability: { home: { state: 'OFFICIAL_REPORT', source: 'nflverse-data injuries_2026.csv (public, keyless)', observed_at: '2026-09-13T16:20:24.079Z', freshness: 'STALE', week: 1, out: 0, doubtful: 0, questionable: 3,
      players: [{ name: 'Jordan Hancock', position: 'CB', status: 'Questionable', injury: 'Quadricep', practice: 'Full Participation in Practice' }] },
    away: { state: 'OFFICIAL_REPORT', source: 'nflverse-data injuries_2026.csv (public, keyless)', observed_at: '2026-09-13T16:20:24.079Z', freshness: 'STALE', week: 1, out: 1, doubtful: 0, questionable: 2, players: [] } },
  injuries: { home: { players: [{ name: 'Jordan Hancock', position: 'CB', status: 'Questionable', injury: 'Quadricep', practice: 'Full Participation in Practice' }] }, away: { players: [{ name: 'Taylor Decker', position: 'OT', status: 'Out', injury: 'Shoulder', practice: 'Did Not Participate In Practice' }] } },
  starters: { home: { position: 'QB', player_name: 'Josh Allen', status: 'SCHEDULE_FEED', confirmed: false, source: 'nflverse games.csv', freshness: 'LIVE' }, away: { position: 'QB', player_name: 'Jared Goff', status: 'SCHEDULE_FEED', confirmed: false, source: 'nflverse games.csv', freshness: 'LIVE' } },
  situation: { rest_days: { home: 7, away: 7 }, weather: { value: null, missing: true, reason: 'no weather forecast was retrieved for this game' }, travel: { missing: true, reason: 'not computed' }, surface: 'a_turf', roof: 'outdoors', division_game: false },
});
const nf = ctx.structuredPanelsHTML({ structured: NFL });
has('the engine contributions lead when there are no unit pairs', nf, 'What carries the projection');
has('with the positive contribution', nf, 'net passing EPA per dropback: +1.59 points toward Buffalo Bills');
has('and the negative one', nf, 'quarterback adjustment: -0.05 points toward Detroit Lions');
has('and their source', nf, 'football/nfl/slate.json (engine contributions)');
lacks('no matchup drivers section is drawn without drivers', nf, 'Matchup drivers (');
has('an official report is a green chip', nf, 'dk-state official">OFFICIAL REPORT');
has('with its counts and week', nf, '0 out · 0 doubtful · 3 questionable · week 1');
has('and the listed players with practice status', nf, '<span class="st">Questionable</span> Jordan Hancock (CB) — Quadricep <span class="pr">Full Participation in Practice</span>');
has('the away report lists the player from the injuries layer', nf, 'Taylor Decker (OT) — Shoulder');
has('a stale report wears a STALE badge', nf, 'nflverse-data injuries_2026.csv (public, keyless) · 2026-09-13 16:20Z <span class="dk-fresh stale">STALE</span>');
has('the schedule-feed starter is not confirmed', nf, 'Josh Allen</div><div class="s"><b>not confirmed</b> · schedule feed');
has('roof and surface are shown', nf, 'outdoors</div><div class="s">surface a_turf · non-division');
has('a missing forecast says so with an UNKNOWN badge', nf, 'no weather forecast was retrieved for this game <span class="dk-fresh unknown">UNKNOWN</span>');
chk('no ratings disclosure is drawn when nothing is on file', nf.indexOf('Ratings, coaching and play profile') < 0);
chk('football evidence is not drawn for a packet without those layers', ctx.structuredPanelsHTML({ structured: S }).indexOf('dk-state') < 0 && ctx.structuredPanelsHTML({ structured: S }).indexOf('Projected starting quarterbacks') < 0);

/* ---- Slice 4: the price ---------------------------------------------------- */
has('the pricing renderer exists', src, 'function pricingHTML');
has('the price is the first panel of the analyst lead', src, 'return pricingHTML(S)+(A?factorsHTML(A)');
has('the ranked board is expandable', src, 'function slatePricingHTML');
has('the CSS for the status chips exists', APP, '.dk-st.lean{');
const PX = { headline: 'Fair line Buffalo Bills -5.6 against a market of -4.5 (validated blend). Buffalo Bills -4.5 at -110 is on the right side of the number, to -5 — LEAN tier: break-even history, not an edge.',
  fair: { spread: { fair_home_line: -5.63, model_home_line: -9, market_home_line: -4.5, gap_points: 4.5, status: 'BLENDED', sigma: 12.8, tier: 'LEAN', required_edge_points: 1.5, tier_basis: 'FIXTURE: cleared break-even, not a profit' }, total: { fair_total: 44.6, market_total: 44 }, moneyline: { fair_home_win_prob: 0.61, fair_home_ml: -156 } },
  sides: [{ market: 'spread', side: 'home', selection: 'Buffalo Bills', market_line: -4.5, odds_american: -110, odds_assumed: false, break_even: 0.5238, cover_at_market: 0.5427, edge_pp: 1.89, bet_to_line: -5, price_at_market_line: -119, status: 'LEAN_PLAY', why: 'LEAN tier: the graded record cleared break-even, not a profit.' },
    { market: 'spread', side: 'away', selection: 'Detroit Lions', market_line: 4.5, odds_american: -110, odds_assumed: true, break_even: 0.5238, cover_at_market: 0.4573, edge_pp: -6.65, bet_to_line: 6.5, status: 'PASS', why: 'the projection favours the other side' },
    { market: 'total', side: 'over', cover_at_market: 0.52, status: 'CONDITIONAL' }, { market: 'moneyline', side: 'home', selection: 'Buffalo Bills', status: 'CONDITIONAL' }],
  quoted_side: { status: 'LEAN_PLAY', why: 'LEAN tier: the graded record cleared break-even, not a profit.' }, sizing: { fraction: null, reason: 'sizing is produced only for a VALIDATED tier; this market is LEAN' }, validation_error: null };
PX.movement = { ok: true, status: 'LEAN_READ', tier: 'LEAN', open_home_line: -3.5, market_home_line: -4, fair_home_line: -5.63, gap_at_open: -2.13, expected_close: null, sides: { home: { verdict: 'BET_NOW' }, away: { verdict: 'WAIT' } }, why: 'FIXTURE: the number moved toward the rating 53% of the time (n 4369) — a tendency, not a record' };
PX.game = { home: 'Buffalo Bills', away: 'Detroit Lions' };
const px = ctx.structuredPanelsHTML({ structured: Object.assign({}, CFB, { pricing: PX, slate_pricing: { games: 14, plays: 3, tier: 'LEAN', note: 'FIXTURE note', top: [{ selection: 'Detroit Lions', market_line: -7, fair_line: -9.29, gap_points: 6.77, cover_at_market: 0.57, bet_to_line: -9, status: 'LEAN_PLAY' }, { home: 'A', away: 'B', status: 'NO_NUMBER' }] } }) });
has('the headline is rendered first in the price panel', px, '<div class="hl">Fair line Buffalo Bills -5.6 against a market of -4.5');
has('the tier is a chip', px, 'The price <span class="dk-kind">LEAN</span>');
has('each spread side shows what the price requires and what the fair line gives', px, '<td class="n">52.4%</td><td class="n">54.3% (+1.89 pp)</td>');
has('the bet-to line and the break-even price at the market line are shown', px, '<td class="n">-5 · -4.5 at -119</td>');
has('LEAN_PLAY renders as the word LEAN, never PLAY', px, '<span class="dk-st lean">LEAN</span>');
chk('a LEAN never renders the play chip', px.indexOf('dk-st play') < 0);
has('an assumed price is starred and explained', px, '-110*</td>');
has('and the star is explained', px, '* price assumed at -110');
has('sizing states its absence and the reason', px, 'Sizing: none — sizing is produced only for a VALIDATED tier');
has('the movement line shows the opener, the current number, the fair line and a verdict per side', px, '<span class="dk-st lean">LEAN READ</span> opened -3.5 · now -4 · fair -5.63 — Buffalo Bills: BET NOW · Detroit Lions: WAIT');
has('the movement basis is quoted', px, 'a tendency, not a record');
has('the tier basis is quoted', px, 'Tier basis: FIXTURE: cleared break-even, not a profit');
has('the ranked board is rendered with its counts', px, 'The board, priced (14 games, 3 on the right side of the number, tier LEAN)');
has('a board row with no number names the game', px, '(A v B)');
chk('the price panel precedes the decisive factors', px.indexOf('class="dk-px"') < px.indexOf('dk-fac') || px.indexOf('dk-fac') < 0);
chk('no price panel is drawn without pricing', ctx.structuredPanelsHTML({ structured: CFB }).indexOf('dk-px') < 0);

/* ---- Slice 3: the analyst layer ------------------------------------------- */
has('the analyst lead renderer exists', src, 'function analystLeadHTML');
has('and is rendered before the movement block', src, 'h+=analystLeadHTML(S);');
has('the expandable analyst renderer is rendered after the football evidence', src, 'h+=analystMoreHTML(S);');
has('the CSS for the factors exists', APP, '.dk-fac{');
const AN = {
  decisive_factors: [
    { id: 'explosive_pass_vs_coverage', label: 'Explosive passing versus coverage', favours: 'North Texas', word: 'a wide gap', in_model: true, uncertainty: 'MEDIUM', evidence: ['North Texas explosive pass rate 28.3% (league 10.4%)', 'Texas State explosive passes allowed 7.5%'], mechanism: 'One explosive replaces a whole drive of successful plays.' },
    { id: 'pass_rush_vs_protection', label: 'Pass rush versus protection', favours: 'North Texas', word: 'a clear gap', in_model: 'partial', uncertainty: 'HIGH', evidence: ['North Texas sack rate allowed 2.1%'], mechanism: 'A sack is a drive-killer twice over.' },
  ],
  counter_case: { id: 'rushing_vs_front', label: 'Rushing attack versus defensive front', favours: 'Texas State', word: 'a modest gap', in_model: true, evidence: ['Texas State yards per carry 5.0'], counter: 'The blunt measure is noisy.' },
  coverage: { measured: 7, partial: 1, not_measured: 2, note: 'No coverage, route, personnel-grouping, snap-count or tracking statistic exists.' },
  what_changes_it: ['An answer to: Is Brad Jackson confirmed to start for Texas State?', 'A fresh price: the captured one is past its freshness limit.'],
  sensitivity: { probability_status: 'MODEL_CONDITIONAL', basis: 'pooled residual pmf', validation_tier: 'RESEARCH', selection: 'North Texas', side: 'away', model_selection_line: -2.4, market_selection_line: -2.5, gap_points: -0.1,
    at_market: { selection_line: -2.5, points_vs_model: -0.1, cover: 0.5171, push: 0, lose: 0.4829 },
    ladder: [{ selection_line: -3.5, points_vs_model: -1.1, cover: 0.49, push: 0, key_number: null }, { selection_line: -3, points_vs_model: -0.6, cover: 0.49, push: 0.023, key_number: 3 }, { selection_line: -2.5, points_vs_model: -0.1, cover: 0.5171, push: 0, key_number: null }, { selection_line: -1.5, points_vs_model: 0.9, cover: 0.54, push: 0, key_number: null }],
    key_numbers_crossed: [], requires: { price: -105, break_even_cover_probability: 0.5122 }, verdict: { reading: 'MODEL-CONDITIONAL, NOT AN EDGE. "Likely to cover if the model is right" and "worth betting at this price" are different questions.' }, note: 'x' },
  alternative_line: { ok: true, note: 'At +7 the market gives this side +9.4 points against the model’s -2.4; 7 is a key number (a touchdown).', change_in_cover_pp: 23.5 },
  investigation: { log: [{ question: 'What is the kickoff forecast?', outcome: 'FOUND', finding: 'UFCU Stadium at kickoff: 78°F, wind 16 mph', source: 'open-meteo forecast (live)', observed_at: '2026-09-16T11:00:00Z' }, { question: 'Is Texas State’s offensive line intact?', outcome: 'BLOCKED', blocker: 'EDGEDESK_SEARCH_API_KEY is not set; no web search provider is configured' }], budget: { requests_used: 1, ms_used: 42 }, note: 'Nothing outside this log was checked.' },
  scenarios: [{ id: 'home_qb_out', question: 'What changes if Brad Jackson is out?', kind: 'QUALITATIVE', result: { direction: 'the projection would move against Texas State by the difference between the starter’s and the replacement’s EPA per dropback; that difference is not on file' }, assumptions: ['the p4 model prices only the quarterback’s absence'], evidence: ['depth-chart backup: Gavin Parkhurst'] }, { id: 'home_qb_out_nfl', question: 'What changes if Josh Allen is out?', kind: 'CONDITIONAL_ESTIMATE', result: { home_line: -3.1, delta_home_line: 2.1, total: 51 }, assumptions: ['the replacement carries the club’s carried quarterback level'] }],
  scenarios_note: 'Neither is the projection; the baseline is unchanged.',
  form: { questions: [{ side: 'home', question: 'Did they improve, or did they face weak opponents?', answer: 'Texas State has outperformed the margin its opponents’ ratings imply by 5.5 a game — over 2 games, a hypothesis, not an improvement.' }], sides: { home: { team: 'Texas State', games: [{ opponent: 'Eastern Michigan', venue: 'home', result: 'W', margin: 21, opponent_rating_now: -7.7, margin_vs_expected: 9.2 }] }, away: null }, note: 'Early-season improvement is a hypothesis to evaluate.' },
  identity: { home: { team: 'Texas State', season: 2026, verified_at: '2026-09-16T01:39:42Z', inferences: [{ id: 'scheme_run_heavy', label: 'run-heavy offence', confidence: 0.9 }], trend: { summary: 'rating up 1.2 points from Preseason to Week 2 (rank 40 → 31). Over 3 snapshots this is a hypothesis, not a trend.' }, quarterback: { backup: { name: 'Gavin Parkhurst', basis: 'slot 2 of the projected quarterback room' } }, qualitative: [{ claim: 'new head coach G.J. Kinne', source: 'football/coaching/continuity.json' }] }, away: null },
  diff: { ok: true, from: { built_at: '2026-09-15T12:00:00Z' }, changes: [{ field: 'market price', from: '-110 at -2.5 (DraftKings)', to: '-105 at -2.5 (DraftKings)' }, { field: 'Texas State injury report', added: ['Spencer Brown (Out)'], removed: [] }] },
};
const ap = ctx.structuredPanelsHTML({ structured: Object.assign({}, CFB, { analysis: AN }) });
has('the three decisive factors are numbered with the side they favour', ap, 'Three decisive matchup factors');
has('a factor names its side', ap, '<span class="fav">North Texas</span>’s favour');
has('and whether the rating already prices it', ap, 'already in the rating');
has('and its evidence with league means', ap, 'league 10.4%');
has('the coverage line says how many interactions were measured', ap, '7 of 10 interactions measured, 2 not measured');
has('the counter-case is drawn in its own box', ap, 'Strongest counter-case');
has('and favours the other side', ap, 'Rushing attack versus defensive front: a modest gap in Texas State’s favour');
has('what could change the conclusion is listed', ap, 'What could change the conclusion');
has('the line sensitivity carries its probability status', ap, 'MODEL CONDITIONAL');
has('and the model-conditional cover at the market', ap, 'model-conditional cover 51.7%');
has('and what the price requires', ap, 'the price -105 requires 51.2%');
has('the ladder marks the market row and the key number', ap, '<tr class="at"><td>-2.5</td>');
has('with key 3 named', ap, 'key 3');
has('the reader’s alternative line is answered', ap, '<b>Your line.</b> At +7 the market gives this side +9.4 points');
has('and says the cover figure is not an edge', ap, 'NOT AN EDGE');
has('the investigation log is shown, open, with its budget', ap, 'What EdgeDesk checked this turn (2 questions, 1 request, 42 ms)');
has('a FOUND question shows its finding and source', ap, 'dk-kind found">FOUND');
has('a BLOCKED question names the blocker', ap, 'EDGEDESK_SEARCH_API_KEY is not set');
has('scenarios are labelled conditional, never the projection', ap, 'conditional, never the projection');
has('a conditional estimate carries the engine re-run number', ap, 'home line -3.1 (+2.1 vs baseline)');
has('a qualitative scenario says what is not on file', ap, 'that difference is not on file');
has('recent form is read against opponent quality', ap, 'Recent form, read against opponent quality');
has('with the opponent’s SP+ beside each margin', ap, '<td>-7.7</td><td>+21</td><td>+9.2</td>');
has('the identity keeps inferences labelled as inferred with a confidence', ap, 'inferred · 90%');
has('and shows the within-season trend', ap, 'Trend: rating up 1.2 points');
has('and the backup quarterback with its basis', ap, 'Backup QB: Gavin Parkhurst');
has('what changed since the last snapshot is listed', ap, 'What changed since 2026-09-15 12:00Z');
has('with additions to the injury report', ap, 'added Spencer Brown (Out)');
lacks('nothing is rendered when there is no analysis', ctx.structuredPanelsHTML({ structured: CFB }), 'Three decisive matchup factors');

const five = ['**The Desk’s read**', 'a', '**Why**', '- b', '**The case for each side**', '- c', '**What could make it wrong**', '- d', '**Price and data limitations**', '- e'].join('\n');
const prose = ctx.deskProseHTML(five);
has('a five-section answer promotes the fifth heading', prose, 'The case for each side');
has('as its own section', prose, 'dk-sec sides');
const four = ['**The Desk’s read**', 'a', '**Why**', '- b', '**What could make it wrong**', '- d', '**Price and data limitations**', '- e'].join('\n');
chk('a four-section answer from an older build still parses', ctx.deskProseHTML(four).indexOf('dk-read') >= 0);
chk('sections come out in answer order', (() => { const h = prose; return h.indexOf('dk-sec why') < h.indexOf('dk-sec sides') && h.indexOf('dk-sec sides') < h.indexOf('dk-sec wrong'); })());
done();
