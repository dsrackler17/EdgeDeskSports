/* ===========================================================================
   THE BENCHMARK HARNESS — the REAL edge function (supabase/functions/edgedesk_ai)
   driven through its full HTTP handler, handle(Request): bearer, rate limit,
   subscription gate, usage allowance, then whichever route the question
   reaches. The network is the intelligence fixture router (the committed NFL
   and FBS slates, metrics, pricing validation) plus captured prices, per-book
   quotes, an MLB card and desk notes written for each scenario — the same
   fixtures tools/intelligence/research_host.test.js uses. The clock is fixed
   (Monday 2026-10-12 16:00 UTC).

   RECORDED RESPONSES: any call to api.anthropic.com is answered from a
   recorded reply (a fixed, labelled string for the model desk; the constructed
   web-search fixture for search scenarios). Nothing here reaches a live
   provider; live checks are tools/research/providers_live.js.

   Usage: const H = await require('./harness.js').init({ env: {...} });
          const r = await H.ask(question, { scenario, body });
   =========================================================================== */
'use strict';
const path = require('path');
const { pathToFileURL } = require('url');
const ROOT = path.join(__dirname, '..', '..', '..');
const FX = require(path.join(ROOT, 'tools', 'intelligence', 'fixtures.js'));

const NOW = Date.parse('2026-10-12T16:00:00Z');
const ISO = (min) => new Date(NOW + min * 60000).toISOString();
const H = 60;
const etDate = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const USER_JWT = b64({ alg: 'none' }) + '.' + b64({ sub: '11111111-1111-1111-1111-111111111111', role: 'authenticated' }) + '.sig';
const RECORDED_DESK_REPLY = 'RECORDED REPLY (benchmark fixture): EdgeDesk can only speak to what its engines and sources hold for this question.';

/* one Deno shim for every instance: each instance's env is swapped in while it imports and while it answers */
let CUR_ENV = {};
const URL_RX = /https?:\/\/[^\s"'<>)\]\\]+/g;
/* served: every URL the fixture network handed the handler (cumulative across the run, so a module-level cache never hides one) */
const S = { served: new Set(), route: () => [], modelCalls: 0, modelBodies: [], searchCalls: [], searchReply: null, modelStatus: 200, posted: [], reads: [], oddsCalls: [] };
function installNetwork() {
  globalThis.fetch = async function (url, init) {
    const u = String(url);
    if (u.indexOf('api.anthropic.com') >= 0) {
      const body = init && init.body ? JSON.parse(init.body) : {};
      if (/"web_search"/.test(String(init && init.body))) {
        S.searchCalls.push(body);
        const rep = S.searchReply;
        if (!rep || rep.__status) return { ok: false, status: (rep && rep.__status) || 500, json: async () => ({ type: 'error', error: { type: 'api_error', message: 'fixture failure' } }), text: async () => 'fixture failure' };
        (JSON.stringify(rep).match(URL_RX) || []).forEach((x) => S.served.add(x));
        return { ok: true, status: 200, json: async () => rep, text: async () => JSON.stringify(rep) };
      }
      S.modelCalls++; S.modelBodies.push(body);
      if (S.modelStatus !== 200) return { ok: false, status: S.modelStatus, json: async () => ({ type: 'error', error: { type: 'overloaded_error', message: 'fixture outage' } }), text: async () => 'fixture outage' };
      return { ok: true, status: 200, json: async () => ({ model: 'recorded', stop_reason: 'end_turn', content: [{ type: 'text', text: RECORDED_DESK_REPLY }], usage: { input_tokens: 1000, output_tokens: 40 } }), text: async () => RECORDED_DESK_REPLY };
    }
    if (u.indexOf('the-odds-api.com') >= 0 || u.indexOf('/functions/v1/capture') >= 0 || u.indexOf('/functions/v1/odds_gateway') >= 0) { S.oddsCalls.push(u); throw new Error('an odds request was made: ' + u); }
    if (init && init.method === 'POST' && /\/rpc\/research_(usage|cost)_/.test(u)) {
      const out = /claim/.test(u) ? { ok: true, claim_id: 41 } : { ok: true };
      return { ok: true, status: 200, text: async () => JSON.stringify(out), json: async () => out };
    }
    if (init && init.method === 'POST' && u.indexOf('sb.test') >= 0) {
      S.posted.push({ table: u.replace('https://sb.test/rest/v1/', '').split('?')[0] });
      return { ok: true, status: 201, text: async () => '', json: async () => [] };
    }
    if (init && init.method === 'HEAD') return { ok: true, status: 200, headers: { get: () => '*/0' }, text: async () => '' };
    S.reads.push(u); S.served.add(u);
    const d = S.route(u, init);
    if (d && typeof d === 'object') ((typeof d.__text === 'string' ? d.__text : JSON.stringify(d)).match(URL_RX) || []).forEach((x) => S.served.add(x));
    if (d === null) return { ok: false, status: 404, text: async () => 'nope', json: async () => null };
    if (d && d.__status) return { ok: false, status: d.__status, text: async () => d.__error || '', json: async () => null };
    return { ok: true, status: 200, text: async () => (d && typeof d.__text === 'string') ? d.__text : JSON.stringify(d), json: async () => d };
  };
}

async function init(o) {
  o = o || {};
  const ENV = Object.assign({ EDGEDESK_AI_NO_SERVE: '1', ANTHROPIC_API_KEY: 'test-key', SUPABASE_URL: 'https://sb.test', SUPABASE_ANON_KEY: 'anon-key', EDGEDESK_SITE_BASE: 'https://site.test', CRON_SECRET: 'cron-test',
    EDGEDESK_RESEARCH_PAID_OK: '0', EDGEDESK_RESEARCH_LOG: '0' }, o.env || {});
  globalThis.Deno = { env: { get: (k) => CUR_ENV[k] } };
  CUR_ENV = ENV;
  installNetwork();
  const m = await import(pathToFileURL(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', 'index.ts')).href + '?bench=' + (o.tag || 'base'));
  const fx = FX.build(NOW);

  /* the NFL card: Lions @ Bills and Colts @ Texans on Sunday, with the engine's own QB-out re-runs */
  const SUNDAY = ISO(6 * 24 * H);
  fx.nfl.games.forEach((g) => { if (g.game_id === 'nfl-fx-det-buf' || g.game_id === 'nfl-fx-ind-hou') g.kickoff = SUNDAY; });
  const nflGame = (id) => fx.nfl.games.find((g) => g.game_id === id);
  const BUF = nflGame('nfl-fx-det-buf'), HOU = nflGame('nfl-fx-ind-hou');
  BUF.scenarios = { home_qb_out: { home_line: 1.3, delta_home_line: 6.5, basis: 'FIXTURE engine re-run with home_qb_id = null', source: 'FIXTURE football/nfl/slate.json' },
    away_qb_out: { home_line: -9.4, delta_home_line: -4.2, basis: 'FIXTURE engine re-run with away_qb_id = null', source: 'FIXTURE football/nfl/slate.json' } };
  const nfl = (x) => fx.signal(Object.assign({ sport_key: 'americanfootball_nfl', sport_title: 'NFL', market: 'spreads', first_seen_at: ISO(-300), last_seen_at: ISO(-4), flagged_at: ISO(-20) }, x));
  const BILLS = nfl({ sig_key: 'ev-det-buf|spreads|Buffalo Bills|-2.5', event_id: 'ev-det-buf', selection: 'Buffalo Bills', point: -2.5, home_team: 'Buffalo Bills', away_team: 'Detroit Lions', commence_time: BUF.kickoff, best_dec: 1.95, best_book: 'FanDuel', sharp_fair: 0.532, sharp_book_fair: 0.532, consensus_fair: 0.528, pin_dec: 1.88, edge: 0.0374, first_edge: 0.035, books: 6 });
  const LIONS = nfl({ sig_key: 'ev-det-buf|spreads|Detroit Lions|2.5', event_id: 'ev-det-buf', selection: 'Detroit Lions', point: 2.5, home_team: 'Buffalo Bills', away_team: 'Detroit Lions', commence_time: BUF.kickoff, best_dec: 1.87, best_book: 'BetMGM', sharp_fair: 0.468, sharp_book_fair: 0.468, consensus_fair: 0.472, pin_dec: 2.0, edge: -0.12, first_edge: -0.11, books: 6 });
  const TEXANS = nfl({ sig_key: 'ev-ind-hou|spreads|Houston Texans|-3.5', event_id: 'ev-ind-hou', selection: 'Houston Texans', point: -3.5, home_team: 'Houston Texans', away_team: 'Indianapolis Colts', commence_time: HOU.kickoff, best_dec: 1.96, best_book: 'FanDuel', sharp_fair: 0.533, sharp_book_fair: 0.533, consensus_fair: 0.53, pin_dec: 1.87, edge: 0.0447, first_edge: 0.04, books: 5 });
  const COLTS = nfl({ sig_key: 'ev-ind-hou|spreads|Indianapolis Colts|3.5', event_id: 'ev-ind-hou', selection: 'Indianapolis Colts', point: 3.5, home_team: 'Houston Texans', away_team: 'Indianapolis Colts', commence_time: HOU.kickoff, best_dec: 1.86, best_book: 'BetMGM', sharp_fair: 0.467, sharp_book_fair: 0.467, consensus_fair: 0.47, pin_dec: 2.01, edge: -0.13, first_edge: -0.12, books: 5 });
  const NFL_SIGNALS = [BILLS, LIONS, TEXANS, COLTS];
  const BOOK_QUOTES = {
    'ev-det-buf|spreads|Buffalo Bills|-2.5': [['FanDuel', 1.95], ['DraftKings', 1.93], ['Caesars', 1.92], ['Pinnacle', 1.88]],
    'ev-ind-hou|spreads|Houston Texans|-3.5': [['FanDuel', 1.96], ['DraftKings', 1.94], ['Pinnacle', 1.87]],
    'ev-tb-cle|h2h|Tampa Bay Rays|': [['FanDuel', 2.2], ['DraftKings', 2.18], ['BetMGM', 2.15], ['Caesars', 2.12], ['Pinnacle', 2.08]],
    'ev-tb-cle|h2h|Cleveland Guardians|': [['DraftKings', 1.83], ['FanDuel', 1.8], ['Pinnacle', 1.81]]
  };
  /* MLB: Rays (away) @ Guardians (home), TOMORROW evening (Tue 7:05 PM ET) — inside the window EdgeDesk's MLB card and
     schedule are read for (yesterday, today, tomorrow), so the benchmark asks about a game production would hold */
  const MLB_START = '2026-10-13T23:05:00.000Z';
  const MLB_GAME = { game_id: '776655', game_date: etDate(Date.parse(MLB_START)), home_team: 'Cleveland Guardians', away_team: 'Tampa Bay Rays', start_time: MLB_START, status: 'Scheduled', park_id: 5 };
  const CARD = { game_date: MLB_GAME.game_date, start_time: MLB_START, status: 'Scheduled', away_team_name: 'Tampa Bay Rays', away_pitcher_name: 'Shane Baz', away_pitcher_throws: 'R', home_team_name: 'Cleveland Guardians', home_pitcher_name: 'Tanner Bibee', home_pitcher_throws: 'R', venue_name: 'Progressive Field', updated_at: ISO(-120) };
  const mlb = (x) => fx.signal(Object.assign({ event_id: 'ev-tb-cle', sport_key: 'baseball_mlb', sport_title: 'MLB', home_team: 'Cleveland Guardians', away_team: 'Tampa Bay Rays', commence_time: MLB_START, first_seen_at: ISO(-300), last_seen_at: ISO(-4), flagged_at: ISO(-20) }, x));
  const RAYS_ML = mlb({ sig_key: 'ev-tb-cle|h2h|Tampa Bay Rays|', market: 'h2h', selection: 'Tampa Bay Rays', point: null, best_dec: 2.2, first_best_dec: 2.15, best_book: 'FanDuel', sharp_fair: 0.4655, sharp_book_fair: 0.4655, consensus_fair: 0.464, pin_dec: 2.08, edge: 0.0241, first_edge: 0.02, books: 7 });
  const CLE_ML = mlb({ sig_key: 'ev-tb-cle|h2h|Cleveland Guardians|', market: 'h2h', selection: 'Cleveland Guardians', point: null, best_dec: 1.83, first_best_dec: 1.83, best_book: 'DraftKings', sharp_fair: 0.5345, sharp_book_fair: 0.5345, consensus_fair: 0.536, pin_dec: 1.81, edge: -0.022, first_edge: -0.02, books: 7 });
  const MLB_SIGNALS = [RAYS_ML, CLE_ML];

  function metricsWith(over) {
    const mm = JSON.parse(JSON.stringify(fx.metrics));
    mm.generated_at = ISO(-2 * H);
    Object.keys(mm.nfl.teams).forEach((k) => { const t = mm.nfl.teams[k]; if (t.injuries) t.injuries.retrieved_at = ISO(-2 * H); if (t.starter) { t.starter.published_at = ISO(-20 * H); t.starter.retrieved_at = ISO(-2 * H); } });
    Object.keys(over || {}).forEach((k) => { const t = mm.nfl.teams[k]; const x = over[k]; if (x.players) t.injuries.players = x.players.concat(t.injuries.players); if (x.retrieved_at) t.injuries.retrieved_at = x.retrieved_at; });
    return mm;
  }
  const notes = (list) => ({ schema: 'edgedesk_desk_notes_v1', notes: list.map((n, i) => Object.assign({ id: 'note_b' + i, recorded_by: 'fixture operator', expires_at: ISO(6 * 24 * H), game_id: null }, n)) });
  function routerFor(x) {
    x = x || {};
    const signals = x.signals || MLB_SIGNALS.concat(NFL_SIGNALS);
    const inner = FX.router(fx, Object.assign({ signals, metrics: x.metrics || metricsWith(), notes: x.notes || { schema: 'edgedesk_desk_notes_v1', notes: [] } }, x.opts || {}));
    return function (u, ini) {
      if (x.fail && x.fail(u)) return { __status: 503, __error: 'upstream unavailable' };
      /* the MLB schedule and card honour the dates asked for, as PostgREST would: the card is read for yesterday, today
         and tomorrow only (Dal.getMlbCard), so a Saturday game is not on Monday's card */
      const dates = (() => { const m = /game_date=in\.\(([^)]*)\)/.exec(decodeURIComponent(u)); if (m) return m[1].split(',').map((d) => d.replace(/"/g, '').trim()); const e = /game_date=eq\.([0-9-]{10})/.exec(u); return e ? [e[1]] : null; })();
      const onDates = (row) => !dates || dates.indexOf(row.game_date) >= 0;
      if (u.indexOf('games?') >= 0 && u.indexOf('game_date=in.') >= 0 && u.indexOf('sport_key=') < 0) return x.noMlb ? [] : [MLB_GAME].filter(onDates);
      if (u.indexOf('mlb_game_cards?') >= 0) return x.noMlb ? [] : [CARD].filter(onDates);
      if (u.indexOf('market_execution_costs?') >= 0) return [];
      if (u.indexOf('book_quotes?') >= 0) {
        const k = decodeURIComponent((/sig_key=eq\.([^&]+)/.exec(u) || [])[1] || '');
        return (BOOK_QUOTES[k] || []).map(([b, d]) => ({ sig_key: k, book_title: b, book_key: b.toLowerCase(), dec: d, updated_at: x.bookAt || ISO(-3), is_fresh: true }));
      }
      if (u.indexOf('portfolio_positions?') >= 0) return x.positions ? x.positions(u, ini) : [];
      return inner(u, ini);
    };
  }
  const allen = { sport: 'americanfootball_nfl', team: 'BUF', kind: 'availability', player: 'Josh Allen', status: 'ACTIVE', key: true, text: 'Josh Allen was a full participant in Saturday practice and will play Sunday', source: 'ESPN', url: 'https://www.espn.com/nfl/story/_/id/fixture-allen-practice', published_at: ISO(-2 * H), recorded_at: ISO(-90), source_kind: 'NEWS' };
  /* the scenarios a benchmark item names: each is a fixture network, labelled */
  const SCENARIOS = {
    base: {},
    no_odds: { signals: [] },
    nfl_only: { signals: NFL_SIGNALS, noMlb: true },
    mlb_only: { signals: MLB_SIGNALS },
    stale: { signals: MLB_SIGNALS.concat(NFL_SIGNALS).map((s) => Object.assign({}, s, { last_seen_at: ISO(-400) })), bookAt: ISO(-400) },
    conflict_qb: { metrics: metricsWith({ BUF: { players: [{ name: 'Josh Allen', position: 'QB', status: 'Out', injury: 'Shoulder', practice: 'Did Not Participate In Practice' }], retrieved_at: ISO(-30 * H) } }), notes: notes([allen]) },
    conflict_goff: { notes: notes([
      { sport: 'americanfootball_nfl', team: 'DET', kind: 'availability', player: 'Jared Goff', status: 'OUT', key: true, text: 'Jared Goff has been ruled out for Sunday with a hand injury', source: 'NFL Network via NBC Sports', url: 'https://www.nbcsports.com/nfl/news/fixture-goff-out', published_at: ISO(-3 * H), recorded_at: ISO(-170), source_kind: 'NEWS' },
      { sport: 'americanfootball_nfl', team: 'DET', kind: 'availability', player: 'Jared Goff', status: 'ACTIVE', key: true, text: 'Jared Goff will play Sunday, the coach said after practice', source: 'The Athletic', url: 'https://www.theathletic.com/fixture-goff-plays', published_at: ISO(-2 * H), recorded_at: ISO(-110), source_kind: 'NEWS' }]) },
    starter_change_mlb: { signals: [Object.assign({}, RAYS_ML, { last_seen_at: ISO(-60) }), Object.assign({}, CLE_ML, { last_seen_at: ISO(-60) })], bookAt: ISO(-58),
      notes: notes([{ sport: 'baseball_mlb', team: 'Tampa Bay Rays', kind: 'starting_pitcher', player: 'Taj Bradley', status: 'STARTING', text: 'Taj Bradley will start Saturday for the Rays; Shane Baz was scratched with forearm tightness', source: 'MLB.com', url: 'https://www.mlb.com/news/fixture-rays-starter', published_at: ISO(-30), recorded_at: ISO(-25), source_kind: 'OFFICIAL' }]) },
    all_rejected: { signals: NFL_SIGNALS.map((s) => Object.assign({}, s, { best_dec: 1.8, edge: -0.04, first_edge: -0.04 })), noMlb: true },
    injury_feed_down: { fail: (u) => /nflverse-data\/releases\/download\/injuries\//.test(u) },
    db_down: { fail: (u) => /\/rest\/v1\/signals\?/.test(u) },
    metrics_down: { fail: (u) => /football\/matchup\/metrics\.json/.test(u) },
    model_down: { modelStatus: 503 }
  };
  SCENARIOS.cfb_outlier = { signals: [], noMlb: true, prep: () => { const g = fx.slate.games.find((x) => String(x.game_id) === '401858900'); const saved = [g.model_home_line, g.model_home_margin, g.kickoff]; g.model_home_line = -9.5; g.model_home_margin = 9.5; g.kickoff = ISO(5 * 24 * H); SCENARIOS.cfb_outlier.signals = [fx.signal({ commence_time: g.kickoff, last_seen_at: ISO(-4), first_seen_at: ISO(-300), flagged_at: ISO(-20) })]; return () => { g.model_home_line = saved[0]; g.model_home_margin = saved[1]; g.kickoff = saved[2]; }; } };

  async function ask(question, a) {
    a = a || {};
    CUR_ENV = ENV;
    const sc = SCENARIOS[a.scenario || 'base'] || {};
    const undo = sc.prep ? sc.prep() : null;
    m.clearCache(); m.resetRateLimit(); if (m.clearInvestigationCache) m.clearInvestigationCache(); m.resetResearchLedger();
    S.route = routerFor(sc); S.modelCalls = 0; S.modelBodies = []; S.searchCalls = []; S.posted = []; S.reads = []; S.oddsCalls = []; S.modelStatus = sc.modelStatus || 200; S.searchReply = a.searchReply || null;
    /* the website's request: stream:true (app.html), so the research routes answer as NDJSON (accepted → plan → progress → result) */
    const body = Object.assign({ mode: 'chat', question, history: [], timezone: 'America/New_York', desk: true, stream: true }, a.body || {});
    /* the handler reads Date.now(): pinned to the benchmark clock, so every run means the same on any day */
    const realNow = Date.now, T0 = realNow();
    Date.now = () => NOW + (realNow() - T0);
    const t0 = process.hrtime.bigint();
    let status = 0, json = null, err = null, events = [], ct = '';
    try {
      const r = await m.handle(new Request('https://fn.test/edgedesk_ai', { method: 'POST', headers: { authorization: 'Bearer ' + USER_JWT, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
      status = r.status; ct = (r.headers && r.headers.get('content-type')) || '';
      const txt = await r.text();
      if (/ndjson/.test(ct)) {
        events = txt.split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch (_) { return { type: 'unparseable', raw: l.slice(0, 200) }; } });
        const res = events.find((e) => e.type === 'result');
        const er = events.find((e) => e.type === 'error');
        json = res ? res.payload : (er ? er : null);
      } else { try { json = JSON.parse(txt); } catch (_) { json = { raw: txt.slice(0, 400) }; } }
    } catch (e) { err = String(e && e.message || e).slice(0, 200); }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    Date.now = realNow;
    if (undo) undo();
    return { status, ct, json, events, err, ms, model_calls: S.modelCalls, model_bodies: S.modelBodies.slice(), search_calls: S.searchCalls.length, odds_calls: S.oddsCalls.length, served: S.served, posted: S.posted.map((p) => p.table) };
  }
  return { m, ask, NOW, ISO, SCENARIOS, USER_JWT, RECORDED_DESK_REPLY };
}
module.exports = { init, NOW, RECORDED_DESK_REPLY };
