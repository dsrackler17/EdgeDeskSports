#!/usr/bin/env node
/* ===========================================================================
   supabase/functions/sharp_lag/index.ts, tested as deployed: imported (not a
   copy) under Node's type stripping, with a Deno shim and an in-memory
   PostgREST (tools/sharp_lag/_rest_mock.js). The provider is never called:
   any request that is not the database or the published NBA roster inputs
   fails the suite.
     copy      the inlined core (and, from step B, the club identity) match
               lib/ and the team files
     auth      GET is a probe; POST needs the cron secret
     ingest    Pinnacle and DraftKings only, out of featured / close /
               sharp_check snapshots, American converted, each snapshot once
     triggers  a Kalshi move of 3c+, an NBA starter's status change, an NHL
               goalie change, each matched to its provider event, recorded in
               the dispatch switch's mode, once
     flags     DraftKings and Kalshi gaps of 2.5 pp+, the trigger behind a
               triggered check carried, fee_unverified, one per episode, none
               while the switch is off
     grades    none before the registry link; then each started flag once,
               the close within 90 minutes
     role      a top-8 rotation player to OUT switches his game to the
               build's scenario (one trigger; a stale or missing scenario
               switches nothing); the pull stores only the named teammates'
               props, its close check too; flags at 2.5 pp from the trigger's
               own pull; graded once there is a final ESPN box, with the stat
     spend     no call to odds_gateway or the provider, no PATCH, no DELETE
   Run: node tools/sharp_lag/sharp_lag_fn.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const M = require(path.join(__dirname, '_rest_mock.js'));
let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; failures.push({ name, detail }); } }

const ENV = { SUPABASE_URL: 'https://stub.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-key', SHARP_LAG_CRON_SECRET: 'cron-secret', NBA_INPUTS_URL: 'https://edgedesksports.com/nba/roster_inputs.json' };
globalThis.Deno = { env: { get: (k) => ENV[k] } };
chk('copy: the inlined copies match lib/edgedesk_sharp_lag.js and the team files (node tools/sharp_lag/inline_core.js)', require(path.join(__dirname, 'inline_core.js')).current());

const NOW = '2026-11-02T18:00:00Z', T0 = Date.parse(NOW);
const at = (min) => new Date(T0 + min * 60000).toISOString();
const NFL = { id: 'ev_nfl', sport_key: 'americanfootball_nfl', commence_time: at(240), home_team: 'Philadelphia Eagles', away_team: 'Dallas Cowboys' };
const book = (key, markets, upd) => ({ key, title: key, last_update: upd || at(-12), markets });
const h2h = (h, a) => ({ key: 'h2h', outcomes: [{ name: NFL.home_team, price: h }, { name: NFL.away_team, price: a }] });
const nflBody = (pin, dk) => [Object.assign({}, NFL, { bookmakers: [book('pinnacle', [h2h(pin[0], pin[1]), { key: 'totals', outcomes: [{ name: 'Over', price: 1.91, point: 47.5 }, { name: 'Under', price: 1.99, point: 47.5 }] }]),
  book('draftkings', [h2h(dk[0], dk[1]), { key: 'totals', outcomes: [{ name: 'Over', price: 1.7, point: 47.5 }, { name: 'Under', price: dk[2] || 2.2, point: 47.5 }] }]), book('fanduel', [h2h(1.5, 2.7)])] })];
const NBA_EV = { id: 'ev_nba', sport_key: 'basketball_nba', commence_time: at(180), home_team: 'Charlotte Hornets', away_team: 'Washington Wizards' };
const NHL_EV = { id: 'ev_nhl', sport_key: 'icehockey_nhl', commence_time: at(120), home_team: 'Toronto Maple Leafs', away_team: 'Montreal Canadiens' };
const snap = (o) => Object.assign({ fingerprint: 'fp' + o.last_request_id, odds_format: 'decimal' }, o);
const INPUTS = { games: [{ game_id: '401909868', start_utc: at(180), home: { id: '30', abbr: 'CHA', name: 'Charlotte Hornets' }, away: { id: '27', abbr: 'WSH', name: 'Washington Wizards' },
  reference: { home: [{ id: 'p1', name: 'LaMelo Ball', minutes: 33 }, { id: 'p2', name: 'Miles Bridges', minutes: 31 }, { id: 'p3', name: 'Brandon Miller', minutes: 30 }, { id: 'p4', name: 'Mark Williams', minutes: 26 }, { id: 'p5', name: 'Josh Green', minutes: 24 }, { id: 'p6', name: 'Bench Guy', minutes: 9 }],
    away: [{ id: 'w1', name: 'Jordan Poole', minutes: 32 }] } }] };

const ROLE_URL = 'https://edgedesksports.com/nba/role_shift.json', SUMMARY = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=';
const EMPTY_RS = { schema: 'edgedesk_nba_role_shift_v1', generated_at: at(-60), props_generated_at: at(-61), model: { key: 'NBA-ROLE-SHIFT', version: '0.1', regime: 'injury_conditioned', default_regime: 'projected' }, games: [] };
let RSFILE = EMPTY_RS, BOX = null, espn = [];
let R, extCalls;
function world(seed) {
  R = M.create(seed); extCalls = [];
  globalThis.fetch = async (u, init) => {
    u = String(u);
    if (u.startsWith(ENV.SUPABASE_URL + '/rest/v1/')) { const [s, b] = R.rest(u, init); return M.resp(s, b); }
    if (u === ENV.NBA_INPUTS_URL) return M.resp(200, INPUTS);
    if (u === ROLE_URL) return M.resp(200, RSFILE);
    if (u.startsWith(SUMMARY)) { espn.push(u); return BOX ? M.resp(200, BOX) : M.resp(404, 'no summary'); }
    extCalls.push(u);
    return M.resp(404, 'unmocked ' + u);
  };
}
const cfg = (dispatch, extra) => [{ key: 'dispatch', value: dispatch || 'shadow' }, { key: 'flags', value: 'on' }, { key: 'public_display', value: 'off' }].concat(extra || []);

(async () => {
  let F;
  try { F = await import(path.join(ROOT, 'supabase', 'functions', 'sharp_lag', 'index.ts')); }
  catch (e) { console.log('SKIP | sharp lag fn | the deployed function could not be imported: ' + (e && e.message) + ' (needs Node 22+ type stripping)'); process.exit(0); }
  const run = (o) => F.runOnce(Object.assign({ now: NOW }, o || {}));

  /* ── auth ────────────────────────────────────────────────────────────── */
  world({ sharp_lag_config: cfg() });
  let res = await F.handle(new Request('https://x/functions/v1/sharp_lag', { method: 'GET' }));
  chk('auth: GET is a probe naming the build and the core', res.status === 200 && /sharp_lag@/.test((await res.json()).build));
  res = await F.handle(new Request('https://x/functions/v1/sharp_lag', { method: 'POST', body: '{}' }));
  chk('auth: a POST without the cron secret is refused', res.status === 401);

  /* ── ingest ──────────────────────────────────────────────────────────── */
  world({ sharp_lag_config: cfg(), odds_api_snapshots: [
    snap({ category: 'featured', sport_key: NFL.sport_key, event_id: null, last_request_id: 501, last_success_at: at(-10), body: nflBody([1.6, 2.5], [1.75, 2.15]) }),
    snap({ category: 'featured', sport_key: 'basketball_nba', event_id: null, odds_format: 'american', last_request_id: 502, last_success_at: at(-20),
      body: [Object.assign({}, NBA_EV, { bookmakers: [book('pinnacle', [{ key: 'h2h', outcomes: [{ name: NBA_EV.home_team, price: -150 }, { name: NBA_EV.away_team, price: 130 }] }])] })] }),
    snap({ category: 'collective', sport_key: NFL.sport_key, last_request_id: 504, last_success_at: at(-5), body: nflBody([1.6, 2.5], [1.6, 2.5]) }),
    snap({ category: 'featured', sport_key: NFL.sport_key, last_request_id: 400, last_success_at: at(-420), body: nflBody([1.6, 2.5], [1.6, 2.5]) })] });
  let out = await run({ steps: ['ingest'] });
  const P = R.DB.sharp_price_snapshots;
  chk('ingest: Pinnacle and DraftKings only, from the featured snapshots (not collective, not 7 h old)', out.ingest.snapshots_read === 2 && P.every((r) => ['pinnacle', 'draftkings'].includes(r.book)) && !P.some((r) => r.source_request_id === 504 || r.source_request_id === 400), out.ingest);
  chk('ingest: each row stamped with the snapshot\'s fetch time and its gateway request', P.filter((r) => r.source_request_id === 501).every((r) => r.captured_at === at(-10) && r.source_category === 'featured'));
  chk('ingest: American prices are stored decimal', P.some((r) => r.source_request_id === 502 && Math.abs(r.price_dec - 1.6667) < 1e-4));
  const n1 = P.length;
  out = await run({ steps: ['ingest'] });
  chk('ingest: a second run reads nothing again', R.DB.sharp_price_snapshots.length === n1 && out.ingest.snapshots_read === 0);

  /* ── flags ───────────────────────────────────────────────────────────── */
  R.DB.kalshi_game_links.push({ market_ticker: 'KXNFLGAME-26NOV02DALPHI-PHI', yes_team: NFL.home_team, odds_event_id: NFL.id, odds_sport_key: NFL.sport_key, game_id: '2026_09_DAL_PHI', home_team: NFL.home_team, away_team: NFL.away_team, kickoff_at: NFL.commence_time });
  R.DB.kalshi_price_snapshots.push({ id: 1, ticker: 'KXNFLGAME-26NOV02DALPHI-PHI', captured_at: at(-8), yes_bid: 0.54, yes_ask: 0.55 }, { id: 2, ticker: 'KXNFLGAME-26NOV02DALPHI-PHI', captured_at: at(-3), yes_bid: 0.54, yes_ask: 0.55 });
  out = await run({ steps: ['flags'] });
  const Fl = R.DB.sharp_flags;
  chk('flags: DraftKings h2h 1.75 (57.1%) against the Pinnacle Shin fair (~61%) is flagged', Fl.some((f) => f.target_venue === 'draftkings' && f.market === 'h2h' && f.side === NFL.home_team && f.gap_pp >= 2.5), Fl);
  const kf = Fl.find((f) => f.target_venue === 'kalshi');
  chk('flags: Kalshi YES 55c + the highest plausible 2c fee (57%) under the ~61% fair is flagged, fee_unverified', kf && kf.fee_unverified === true && kf.target_cost_prob === 0.57 && kf.fee_basis === 'highest_plausible', kf);
  chk('flags: the flag carries the trigger (scheduled: a featured board), both prices, the gap, the seconds since Pinnacle and the resolution', kf && kf.trigger_type === 'scheduled' && kf.pinnacle_price_dec === 1.6 && kf.seconds_since_reference === 600 && kf.target_resolution_s === 300);
  chk('flags: the first Pinnacle observation of an event takes the gateway\'s nominal cadence as its resolution (60 min inside 24 h)', kf && kf.reference_resolution_s === 3600 && kf.snapshot_resolution_s === 3600);
  chk('flags: a total at the same point is compared too (DraftKings Under 2.20 against the Pinnacle fair)', Fl.some((f) => f.market === 'totals' && f.side === 'Under' && f.point === 47.5));
  const nf = Fl.length;
  out = await run({ steps: ['flags'] });
  chk('flags: the next run writes no second flag while the gap has not converged (one per episode)', R.DB.sharp_flags.length === nf, out.flags);
  /* a triggered check: the snapshot bought for an NBA starter's change carries that trigger */
  R.DB.sharp_triggers.push({ id: 77, trigger_type: 'nba_injury', sport_key: 'basketball_nba', event_id: NBA_EV.id, mode: 'live', dedupe_key: 'x', detected_at: at(-30) });
  R.DB.sharp_check_requests.push({ id: 5, trigger_id: 77, gateway_request_id: 503, category: 'sharp_check', event_id: NBA_EV.id, decision: 'granted' });
  R.DB.odds_api_snapshots.push(snap({ category: 'sharp_check', sport_key: 'basketball_nba', event_id: NBA_EV.id, last_request_id: 503, last_success_at: at(-2),
    body: Object.assign({}, NBA_EV, { bookmakers: [book('pinnacle', [{ key: 'h2h', outcomes: [{ name: NBA_EV.home_team, price: 1.4 }, { name: NBA_EV.away_team, price: 3.2 }] }]),
      book('draftkings', [{ key: 'h2h', outcomes: [{ name: NBA_EV.home_team, price: 1.62 }, { name: NBA_EV.away_team, price: 2.4 }] }])] }) }));
  out = await run({ steps: ['ingest', 'flags'] });
  const tf = R.DB.sharp_flags.find((f) => f.event_id === NBA_EV.id);
  chk('flags: a flag from a triggered check names its trigger (nba_injury, id 77)', tf && tf.trigger_type === 'nba_injury' && tf.trigger_id === 77 && tf.reference_category === 'sharp_check', tf);
  /* a player-props pull is never a sharp-lag observation (review, 2026-10-26): the main markets' latest
     Pinnacle and DraftKings boards stay the reference and the target, and props are never flagged here */
  const ps = (rid, cat, at_, book, market, side, dec, o) => Object.assign({ captured_at: at_, source_request_id: rid, source_category: cat, sport_key: 'basketball_nba', event_id: NBA_EV.id,
    home_team: NBA_EV.home_team, away_team: NBA_EV.away_team, commence_time: NBA_EV.commence_time, book, market, side, participant: null, point: null, price_dec: dec }, o || {});
  const pp = { participant: 'Miles Bridges', point: 6.5 };
  world({ sharp_lag_config: cfg(), sharp_price_snapshots: [ps(503, 'sharp_check', at(-2), 'pinnacle', 'h2h', NBA_EV.home_team, 1.4), ps(503, 'sharp_check', at(-2), 'pinnacle', 'h2h', NBA_EV.away_team, 3.2),
    ps(503, 'sharp_check', at(-2), 'draftkings', 'h2h', NBA_EV.home_team, 1.62), ps(503, 'sharp_check', at(-2), 'draftkings', 'h2h', NBA_EV.away_team, 2.4),
    ps(811, 'nba_role_props', at(-1), 'pinnacle', 'player_rebounds', 'Over', 1.6, pp), ps(811, 'nba_role_props', at(-1), 'pinnacle', 'player_rebounds', 'Under', 2.5, pp),
    ps(811, 'nba_role_props', at(-1), 'draftkings', 'player_rebounds', 'Over', 1.9, pp), ps(811, 'nba_role_props', at(-1), 'draftkings', 'player_rebounds', 'Under', 1.9, pp)] });
  out = await run({ steps: ['flags'] });
  chk('flags: a later props pull does not displace the main-market boards: the DraftKings h2h gap is still flagged', R.DB.sharp_flags.some((f) => f.market === 'h2h' && f.reference_request_id === 503), R.DB.sharp_flags.map((f) => f.market + ':' + f.reference_request_id));
  chk('flags: no sharp-lag flag is ever written on a player prop', !R.DB.sharp_flags.some((f) => /^player_/.test(f.market)));
  world({ sharp_lag_config: [{ key: 'flags', value: 'off' }], sharp_price_snapshots: P.slice() });
  out = await run({ steps: ['flags'] });
  chk('flags: with the switch off nothing is flagged, and the run says why', R.DB.sharp_flags.length === 0 && /switched off/.test(out.flags.skipped));

  /* ── triggers ────────────────────────────────────────────────────────── */
  world({ sharp_lag_config: cfg('shadow'),
    odds_api_events: [{ event_id: NBA_EV.id, sport_key: 'basketball_nba', commence_time: NBA_EV.commence_time, home_team: NBA_EV.home_team, away_team: NBA_EV.away_team },
      { event_id: NHL_EV.id, sport_key: 'icehockey_nhl', commence_time: NHL_EV.commence_time, home_team: NHL_EV.home_team, away_team: NHL_EV.away_team }],
    kalshi_game_links: [{ market_ticker: 'KX-PHI', yes_team: NFL.home_team, odds_event_id: NFL.id, odds_sport_key: NFL.sport_key, game_id: 'g1', home_team: NFL.home_team, away_team: NFL.away_team, kickoff_at: NFL.commence_time }],
    kalshi_price_snapshots: [{ id: 11, ticker: 'KX-PHI', captured_at: at(-10), yes_bid: 0.55, yes_ask: 0.57 }, { id: 12, ticker: 'KX-PHI', captured_at: at(-5), yes_bid: 0.58, yes_ask: 0.6 }],
    nba_injury_reports: [{ id: 1, captured_at: at(-120), matchups: [{ game_id: '401909868' }] }, { id: 2, captured_at: at(-10), matchups: [{ game_id: '401909868' }] }],
    nba_injury_report_snapshots: [{ report_id: 1, game_id: '401909868', player_id: 'p1', status: 'QUESTIONABLE' }, { report_id: 2, game_id: '401909868', player_id: 'p1', status: 'OUT' },
      { report_id: 1, game_id: '401909868', player_id: 'p6', status: 'QUESTIONABLE' }, { report_id: 2, game_id: '401909868', player_id: 'p6', status: 'OUT' }],
    nhl_goalie_starters: [{ id: 1, game_id: '2026020301', game_start_utc: NHL_EV.commence_time, team: 'TOR', side: 'home', goalie_id: '8', goalie_name: 'Joseph Woll', status: 'projected', fetched_at: at(-60), source: 'consensus' },
      { id: 2, game_id: '2026020301', game_start_utc: NHL_EV.commence_time, team: 'TOR', side: 'home', goalie_id: '8', goalie_name: 'Joseph Woll', status: 'confirmed', fetched_at: at(-5), source: 'consensus' },
      { id: 3, game_id: '2026020301', game_start_utc: NHL_EV.commence_time, team: 'MTL', side: 'away', goalie_id: '5', goalie_name: 'Sam Montembeault', status: 'projected', fetched_at: at(-60), source: 'consensus' }] });
  out = await run({ steps: ['triggers'] });
  const Tr = R.DB.sharp_triggers;
  const km = Tr.find((t) => t.trigger_type === 'kalshi_move'), ni = Tr.filter((t) => t.trigger_type === 'nba_injury'), ng = Tr.find((t) => t.trigger_type === 'nhl_goalie');
  chk('triggers: a Kalshi mid move of 3c between consecutive snapshots, on the linked event', km && km.event_id === NFL.id && Math.abs(km.detail.move - 0.03) < 1e-9, km);
  chk('triggers: an NBA starter going QUESTIONABLE -> OUT, matched to the provider event; a bench player is not a starter', ni.length === 1 && ni[0].detail.player_name === 'LaMelo Ball' && ni[0].event_id === NBA_EV.id && ni[0].detail.to === 'OUT', ni);
  chk('triggers: an NHL goalie confirmed, matched to the provider event by club names', ng && ng.event_id === NHL_EV.id && ng.detail.to.status === 'confirmed', ng);
  chk('triggers: recorded in shadow while dispatch is shadow', Tr.length === 3 && Tr.every((t) => t.mode === 'shadow'));
  out = await run({ steps: ['triggers'] });
  chk('triggers: a second run records nothing twice', R.DB.sharp_triggers.length === 3);
  R.DB.sharp_lag_config = cfg('live');
  R.DB.kalshi_price_snapshots.push({ id: 13, ticker: 'KX-PHI', captured_at: at(-1), yes_bid: 0.62, yes_ask: 0.64 });
  out = await run({ steps: ['triggers'] });
  chk('triggers: with dispatch live, a new move is recorded live', R.DB.sharp_triggers.length === 4 && R.DB.sharp_triggers[3].mode === 'live');

  /* ── grades ──────────────────────────────────────────────────────────── */
  world({ sharp_lag_config: cfg(), odds_api_snapshots: [snap({ category: 'featured', sport_key: NFL.sport_key, last_request_id: 601, last_success_at: at(-10), body: nflBody([1.6, 2.5], [1.75, 2.15]) })] });
  await run({ steps: ['ingest', 'flags'] });
  const flagsMade = R.DB.sharp_flags.length;
  /* the close: Pinnacle 40 minutes before the start, and DraftKings caught up */
  R.DB.odds_api_snapshots.push(snap({ category: 'close', sport_key: NFL.sport_key, last_request_id: 602, last_success_at: at(200), body: nflBody([1.55, 2.6], [1.6, 2.4, 1.95]) }));
  await F.runOnce({ now: at(201), steps: ['ingest'] });
  out = await F.runOnce({ now: at(260), steps: ['grades'] });
  chk('grades: none before SHARP-LAG is in the research registry, and the run says so', R.DB.sharp_flag_grades.length === 0 && out.grades.registered === false && out.warnings.some((w) => w.code === 'not_registered'));
  R.DB.sharp_lag_config.push({ key: 'registry_ref:SHARP-LAG', value: 'v-1' });
  out = await F.runOnce({ now: at(260), steps: ['grades'] });
  const G = R.DB.sharp_flag_grades;
  chk('grades: every started flag graded once, against the registry link', flagsMade > 0 && G.length === flagsMade && G.every((g) => g.registry_ref === 'v-1'), [flagsMade, G.length]);
  const gdk = G.find((g) => R.DB.sharp_flags.find((f) => f.flag_id === g.flag_id).target_venue === 'draftkings' && R.DB.sharp_flags.find((f) => f.flag_id === g.flag_id).market === 'h2h');
  chk('grades: the close is the Pinnacle observation 40 minutes before the start, and CLV is positive here', gdk && gdk.close_status === 'graded' && gdk.close_lead_min === 40 && gdk.clv_pp > 0 && gdk.hit === true, gdk);
  chk('grades: DraftKings converged at the close snapshot (lag measured to the hourly resolution)', gdk && gdk.converged === true && gdk.lag_resolution_s != null);
  await F.runOnce({ now: at(300), steps: ['grades'] });
  chk('grades: a flag is graded once, ever', R.DB.sharp_flag_grades.length === flagsMade);

  /* ── role shifts ─────────────────────────────────────────────────────── */
  {
    const FX = require(path.join(__dirname, 'fixtures', 'role_shift_fixture.js'));
    const built = FX.file({ now: at(-60), props_generated_at: at(-61) });
    /* the fixture's game as the published inputs' game: LaMelo Ball (p1) is its absent star */
    const g = built.games[0]; g.game_id = '401909868';
    g.scenarios.forEach((sc) => { if (sc.absent.id === '1') { sc.absent.id = 'p1'; sc.absent.name = 'LaMelo Ball'; } });
    const ROLE_FILE = built;
    const reports = { nba_injury_reports: [{ id: 1, captured_at: at(-120), matchups: [{ game_id: '401909868' }] }, { id: 2, captured_at: at(-10), matchups: [{ game_id: '401909868' }] }],
      nba_injury_report_snapshots: [{ report_id: 1, game_id: '401909868', player_id: 'p1', status: 'QUESTIONABLE' }, { report_id: 2, game_id: '401909868', player_id: 'p1', status: 'OUT' },
        { report_id: 1, game_id: '401909868', player_id: 'p4', status: 'PROBABLE' }, { report_id: 2, game_id: '401909868', player_id: 'p4', status: 'QUESTIONABLE' },
        { report_id: 2, game_id: '401909868', player_id: 'p6', status: 'DOUBTFUL' }] };
    const evs = { odds_api_events: [{ event_id: NBA_EV.id, sport_key: 'basketball_nba', commence_time: NBA_EV.commence_time, home_team: NBA_EV.home_team, away_team: NBA_EV.away_team }] };
    RSFILE = Object.assign({}, ROLE_FILE, { generated_at: at(-30 * 60) });
    world(Object.assign({ sharp_lag_config: cfg('live') }, reports, evs));
    out = await run({ steps: ['triggers'] });
    chk('role: a scenario file over 24 hours old switches nothing on, and the run says so', !R.DB.sharp_triggers.some((t) => t.trigger_type === 'role_shift') && out.warnings.some((w) => w.code === 'role_shift_stale'));
    RSFILE = ROLE_FILE;
    world(Object.assign({ sharp_lag_config: cfg('live') }, reports, evs));
    out = await run({ steps: ['triggers'] });
    const rs = R.DB.sharp_triggers.filter((t) => t.trigger_type === 'role_shift');
    chk('role: QUESTIONABLE -> OUT of a top-8 rotation player is one role-shift trigger on the provider event', rs.length === 1 && rs[0].event_id === NBA_EV.id && rs[0].dedupe_key === 'role_shift|401909868|p1' && rs[0].mode === 'live', rs);
    const d = rs[0] && rs[0].detail;
    chk('role: the trigger records the regime switch, the absent player\'s move and the 3 priced teammates', d && d.regime_switch.from === 'projected' && d.regime_switch.to === 'injury_conditioned' && d.regime_switch.scenario_built_at === at(-60)
      && d.absent.id === 'p1' && d.absent.from === 'QUESTIONABLE' && d.absent.to === 'OUT' && d.report_id === 2 && d.teammates.map((t) => t.name).join() === 'Absorber,Newcomer,Small', d && d.absent);
    chk('role: QUESTIONABLE switches nothing; a DOUBTFUL player with no scenario is counted, not triggered', !rs.some((t) => /p4|p6/.test(t.dedupe_key)) && out.triggers.role_shift_skipped.no_scenario === 1, out.triggers);
    await run({ steps: ['triggers'] });
    chk('role: one trigger per player per game, however many reports follow', R.DB.sharp_triggers.filter((t) => t.trigger_type === 'role_shift').length === 1);
    /* the dispatcher's pull (tools/sharp_lag/sharp_check_fn.test.js): one nba_role_props request for the event */
    const tid = rs[0].id;
    R.DB.sharp_check_requests.push({ id: 41, purpose: 'role_shift', trigger_id: tid, category: 'nba_role_props', sport_key: 'basketball_nba', event_id: NBA_EV.id, decision: 'granted', gateway_request_id: 801, requested_at: at(-4) });
    const prop = (bk, who, mk, pt, o, u) => ({ key: mk, outcomes: [{ name: 'Over', description: who, point: pt, price: o }, { name: 'Under', description: who, point: pt, price: u }] });
    const propsBody = (rebO, rebU) => Object.assign({}, NBA_EV, { bookmakers: [
      book('draftkings', [prop('draftkings', 'Absorber', 'player_rebounds', 6.5, rebO, rebU), prop('draftkings', 'LaMelo Ball', 'player_rebounds', 7.5, 1.9, 1.9), prop('draftkings', 'Somebody Else', 'player_assists', 4.5, 1.9, 1.9)]),
      book('fanduel', [prop('fanduel', 'Absorber', 'player_assists', 2.5, 2.1, 1.75)]), book('pinnacle', [{ key: 'h2h', outcomes: [{ name: NBA_EV.home_team, price: 1.5 }, { name: NBA_EV.away_team, price: 2.7 }] }])] });
    R.DB.odds_api_snapshots.push(snap({ category: 'nba_role_props', sport_key: 'basketball_nba', event_id: NBA_EV.id, last_request_id: 801, last_success_at: at(-3), body: propsBody(2.05, 1.8) }));
    out = await run({ steps: ['ingest'] });
    const PR = R.DB.sharp_price_snapshots.filter((r) => r.source_request_id === 801);
    chk('role: the pull stores only the named teammates\' prop prices (not the absent player, not anyone else, not the main markets)', PR.length === 4 && PR.every((r) => r.participant === 'Absorber' && /^player_/.test(r.market)), PR.map((r) => r.participant + ' ' + r.market));
    out = await run({ steps: ['flags'] });
    const rf = R.DB.sharp_flags.filter((f) => f.model_key === 'NBA-ROLE-SHIFT');
    const reb = rf.find((f) => f.market === 'player_rebounds');
    chk('role: the trigger\'s own pull is flagged at 2.5 pp: Absorber rebounds Over 6.5 at DraftKings, assists at FanDuel', reb && reb.side === 'Over' && reb.target_venue === 'draftkings' && reb.trigger_id === tid && rf.some((f) => f.market === 'player_assists' && f.target_venue === 'fanduel'), rf);
    chk('role: the flag names the absent player and states its resolution: the report (10 min ago) to the pull (3 min ago), 420 s', reb && reb.absent_player_id === 'p1' && reb.absent_player_name === 'LaMelo Ball' && reb.snapshot_resolution_s === 420 && reb.target_request_id === 801);
    const nRole = rf.length;
    await run({ steps: ['flags'] });
    chk('role: a second run writes no second flag', R.DB.sharp_flags.filter((f) => f.model_key === 'NBA-ROLE-SHIFT').length === nRole);
    /* the close check the dispatcher buys inside the last hour: no trigger of its own */
    R.DB.sharp_check_requests.push({ id: 42, purpose: 'role_shift_close', trigger_id: null, category: 'nba_role_props', sport_key: 'basketball_nba', event_id: NBA_EV.id, decision: 'granted', gateway_request_id: 802, requested_at: at(160) });
    R.DB.odds_api_snapshots.push(snap({ category: 'nba_role_props', sport_key: 'basketball_nba', event_id: NBA_EV.id, last_request_id: 802, last_success_at: at(160), body: propsBody(1.7, 2.2) }));
    await F.runOnce({ now: at(161), steps: ['ingest'] });
    chk('role: the close check stores the same teammates (named by the role shift on the event)', R.DB.sharp_price_snapshots.filter((r) => r.source_request_id === 802).length === 4);
    out = await F.runOnce({ now: at(200), steps: ['grades'] });
    chk('role: no grade before NBA-ROLE-SHIFT is in the research registry, and the run says so', !R.DB.sharp_flag_grades.length && out.warnings.some((w) => w.code === 'role_shift_not_registered'));
    R.DB.sharp_lag_config.push({ key: 'registry_ref:NBA-ROLE-SHIFT', value: 'v-rs' });
    BOX = { header: { competitions: [{ status: { type: { completed: false } } }] }, boxscore: { players: [] } };
    out = await F.runOnce({ now: at(200), steps: ['grades'] });
    chk('role: not graded while the game has no final box (inside a day)', !R.DB.sharp_flag_grades.length && out.role_shift_grades.waiting_for_box === nRole && espn.length >= 1 && /event=401909868$/.test(espn[0]), out.role_shift_grades);
    BOX = { header: { competitions: [{ status: { type: { completed: true } } }] }, boxscore: { players: [{ team: { id: '30' }, statistics: [{ keys: ['minutes', 'threePointFieldGoalsMade-threePointFieldGoalsAttempted', 'rebounds', 'assists', 'points'],
      athletes: [{ athlete: { id: '2', displayName: 'Absorber' }, stats: ['31', '3-7', '9', '2', '17'] }] }] }] } };
    out = await F.runOnce({ now: at(400), steps: ['grades'] });
    const gr = R.DB.sharp_flag_grades.find((x) => x.flag_id === reb.flag_id);
    chk('role: graded once there is a final box: the close 20 minutes out at DraftKings, Shin CLV, the stat beside it', gr && gr.close_status === 'graded' && gr.close_lead_min === 20 && gr.registry_ref === 'v-rs' && gr.model_key === 'NBA-ROLE-SHIFT'
      && gr.actual_stat === 9 && gr.actual_outcome === 'over' && gr.detail.league_game_id === '401909868', gr);
    const ga = R.DB.sharp_flag_grades.find((x) => R.DB.sharp_flags.find((f) => f.flag_id === x.flag_id).market === 'player_assists');
    chk('role: assists 2 under 2.5; every role-shift flag graded once', ga && ga.actual_stat === 2 && ga.actual_outcome === 'under' && R.DB.sharp_flag_grades.length === nRole);
    await F.runOnce({ now: at(500), steps: ['grades'] });
    chk('role: a flag is graded once, ever', R.DB.sharp_flag_grades.length === nRole);

    /* a role-shift ask the gateway answered from its cache: the pull it served is still evaluated (review, 2026-10-26) */
    world(Object.assign({ sharp_lag_config: cfg('live') }, reports, evs));
    await run({ steps: ['triggers'] });
    const t2 = R.DB.sharp_triggers.find((t) => t.trigger_type === 'role_shift');
    R.DB.sharp_check_requests.push({ id: 51, purpose: 'role_shift', trigger_id: t2.id, category: 'nba_role_props', sport_key: 'basketball_nba', event_id: NBA_EV.id, decision: 'cache_hit', source: 'cache', cost: 0,
      gateway_request_id: 9999, fetched_at: at(-3), requested_at: at(-2) });
    R.DB.odds_api_snapshots.push(snap({ category: 'nba_role_props', sport_key: 'basketball_nba', event_id: NBA_EV.id, last_request_id: 801, last_success_at: at(-3), body: propsBody(2.05, 1.8) }));
    out = await run({ steps: ['ingest', 'flags'] });
    const cf = R.DB.sharp_flags.filter((f) => f.model_key === 'NBA-ROLE-SHIFT');
    chk('role: an ask answered from the gateway\'s cache is evaluated on the pull it served (its own request id names no stored pull)', cf.length > 0 && cf.every((f) => f.target_request_id === 801 && f.trigger_id === t2.id), out.flags && out.flags.role_shift);
  }

  /* ── spend ───────────────────────────────────────────────────────────── */
  chk('spend: no call outside the database, the published NBA files and ESPN\'s box score (no gateway, no provider)', extCalls.length === 0, extCalls);
  chk('spend: no PATCH and no DELETE, ever (append-only)', !R.calls.some((c) => /^(PATCH|DELETE)/.test(c)));
  const src = require('fs').readFileSync(path.join(ROOT, 'supabase', 'functions', 'sharp_lag', 'index.ts'), 'utf8');
  chk('spend: the free job never names odds_gateway\'s URL or the provider', !/functions\/v1\/odds_gateway|the-odds-api\.com|ODDS_API_KEY|ODDS_GATEWAY_PROVIDER_KEY/.test(src));

  console.log((fail ? 'FAILED' : 'ALL GREEN') + ' sharp lag fn: ' + pass + ' passed, ' + fail + ' failed');
  for (const f of failures) console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 700) : ''));
  process.exit(fail ? 1 : 0);
})();
