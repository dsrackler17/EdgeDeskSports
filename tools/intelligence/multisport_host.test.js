#!/usr/bin/env node
/* ===========================================================================
   THE MULTI-SPORT QUANT DESK THROUGH THE REAL HANDLER — the 2026-10-15
   regression, the model-first order, and the desk with every odds
   integration switched off.

   The network is tools/intelligence/fixtures/quant_oct15_2026.json: every
   artifact the desk reads, exactly as committed at 2026-10-15T13:00Z (built
   by tools/quant/build_oct15_fixture.js from git, trimmed to the window),
   plus the capture signals DERIVED from that day's committed scoreboard
   snapshot. The clock is 2026-10-15T13:00Z (8:00 AM CDT); the reader is in
   America/Chicago. Node strips the TypeScript; no writing model is called.

   THE OCT 15 REPORT'S FOUR DEFECTS, detected by `defects()` below:
     NFL_ONLY_FOCUS        the answer researched football only while another
                           sport had events and an operational model
     NO_INDEPENDENT_PROJECTION  the headline candidate rests on a market-derived
                           number, not an EdgeDesk projection
     STALE_QUOTE           the headline candidate's price is past its limit
     STARTER_DISAGREEMENT  a projection that assumed a different starter than
                           the depth chart was used rather than held back
   The captured-price desk alone (EDGEDESK_MULTISPORT=0) shows all four; the
   multi-sport desk shows none — and says why for each.

   Run: node tools/intelligence/multisport_host.test.js   (MS_PRINT=1 prints the answers)
   =========================================================================== */
'use strict';
const path = require('path');
const { pathToFileURL } = require('url');
const ROOT = path.join(__dirname, '..', '..');
const FX = require(path.join(__dirname, 'fixtures', 'quant_oct15_2026.json'));
const BASE_FX = require('./fixtures.js');

/* THE CLOCK: 2026-10-15T13:00Z, moving forward in real time from there */
const REPLAY = Date.parse(FX.replay_at);
const SHIFT = Date.now() - REPLAY;
{
  const RealDate = Date;
  globalThis.Date = class extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(RealDate.now() - SHIFT); }
    static now() { return RealDate.now() - SHIFT; }
  };
}

let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) { pass++; return; } fail++; console.log('FAIL | ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 900) : '')); }
const PRINT = process.env.MS_PRINT === '1';

const ENV = { EDGEDESK_RESEARCH_LOG: '0', EDGEDESK_AI_NO_SERVE: '1', ANTHROPIC_API_KEY: 'test-key', SUPABASE_URL: 'https://sb.test', SUPABASE_ANON_KEY: 'anon-key', EDGEDESK_SITE_BASE: 'https://site.test', EDGEDESK_QUOTE_REFRESH: '1', CRON_SECRET: 'cron-test', EDGEDESK_RESEARCH: '0' };
globalThis.Deno = { env: { get: (k) => ENV[k] } };

/* every request, in order: the order proof reads this */
let log = [], posted = [], modelCalls = 0;
const PRICE_URL = /\/rest\/v1\/(signals|book_quotes|book_quote_ticks)\b|the-odds-api\.com|odds\.blaze|oddsblaze|\/functions\/v1\/(capture|odds_gateway)/;
let refusePrices = false;
const base = BASE_FX.build(REPLAY);
const baseRoute = BASE_FX.router(base, { signals: [] });
function route(u) {
  if (u.indexOf('https://site.test/') === 0) {
    const rel = u.slice('https://site.test/'.length).split('?')[0];
    if (Object.prototype.hasOwnProperty.call(FX.artifacts, rel)) return FX.artifacts[rel];
    if (rel === 'football/matchup/metrics.json') return base.metrics;
    return baseRoute(u);
  }
  if (u.indexOf('/rest/v1/signals?') >= 0) {
    const sm = /sport_key=eq\.([A-Za-z0-9_%]+)/.exec(u), want = sm ? decodeURIComponent(sm[1]) : null;
    const sk = /sig_key=eq\.([^&]+)/.exec(u), key = sk ? decodeURIComponent(sk[1]) : null;
    return FX.signals.rows.filter((r) => (!want || r.sport_key === want) && (!key || r.sig_key === key));
  }
  if (u.indexOf('/rest/v1/games?') >= 0) return /sport_key=eq/.test(u) ? { __status: 400, __error: 'column games.sport_key does not exist' } : [];
  if (u.indexOf('/rest/v1/') >= 0) return baseRoute(u) || [];
  return baseRoute(u);
}
globalThis.fetch = async function (url, init) {
  const u = String(url);
  const method = (init && init.method) || 'GET';
  log.push({ method, u });
  if (u.indexOf('api.anthropic.com') >= 0) { modelCalls++; return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'ok' }] }), text: async () => 'ok' }; }
  if (refusePrices && PRICE_URL.test(u)) throw new Error('ODDS INTEGRATION TOUCHED WITH ODDS DISABLED: ' + u);
  if (/the-odds-api\.com|\/functions\/v1\/capture/.test(u)) throw new Error('an odds request was made: ' + u);
  if (method === 'POST' && u.indexOf('sb.test') >= 0) {
    let body = null; try { body = JSON.parse(init.body); } catch (_) { body = null; }
    posted.push({ table: u.replace('https://sb.test/rest/v1/', '').split('?')[0], query: u.split('?')[1] || '', body, at: log.length - 1 });
    return { ok: true, status: 201, text: async () => '', json: async () => [] };
  }
  if (method === 'HEAD') return { ok: true, status: 200, headers: { get: () => '*/0' }, text: async () => '' };
  const d = route(u);
  if (d === null || d === undefined) return { ok: false, status: 404, text: async () => 'nope', json: async () => null };
  if (d && d.__status) return { ok: false, status: d.__status, text: async () => d.__error || '', json: async () => null };
  return { ok: true, status: 200, text: async () => (d && typeof d.__text === 'string') ? d.__text : JSON.stringify(d), json: async () => d };
};

/* ───────────────────────── the Oct 15 detector ───────────────────────── */
const FOOTBALL = new Set(['americanfootball_nfl', 'americanfootball_ncaaf', 'nfl', 'cfb']);
const MULTI = (() => { globalThis.EDFAIR = globalThis.EDFAIR || require(path.join(ROOT, 'lib', 'edgedesk_fairodds.js')); return require(path.join(ROOT, 'lib', 'edgedesk_multisport.js')); })();
/* what the day actually held, computed independently of the handler: sports with events AND an operational model */
const TRUTH = MULTI.prepare({ artifacts: FX.artifacts, question: 'tonight', now: REPLAY, timezone: 'America/Chicago' });
const OPERATIONAL_WITH_EVENTS = Object.entries(TRUTH.discovery.by_sport).filter(([, v]) => v.with_projection > 0).map(([k]) => k);
function headline(j) {
  const ms = j.multisport;
  if (ms && ms.available) return ms.best_verified ? { kind: 'MULTI_VERIFIED', row: ms.best_verified } : ms.best_research ? { kind: 'MULTI_RESEARCH', row: ms.best_research } : null;
  const sc = j.scan || {};
  const r = sc.best || (sc.potential || [])[0] || (sc.near_misses || [])[0] || null;
  if (r) return { kind: 'LEGACY_CANDIDATE', row: r };
  const bn = (sc.board_near_misses || [])[0];
  return bn ? { kind: 'LEGACY_BOARD_NEAR_MISS', row: bn } : null;
}
function defects(j) {
  const out = [];
  const ms = j.multisport && j.multisport.available ? j.multisport : null;
  /* 1 · football-only focus while another sport had events and a model */
  const researched = ms ? ms.coverage.filter((c) => c.events_researched > 0).map((c) => c.sport) : (j.scan && j.scan.coverage || []).filter((c) => c.status === 'EVALUATED').map((c) => c.sport);
  const otherHad = OPERATIONAL_WITH_EVENTS.filter((s) => !FOOTBALL.has(s));
  if (researched.every((s) => FOOTBALL.has(s)) && otherHad.length) out.push({ code: 'NFL_ONLY_FOCUS', detail: 'researched ' + (researched.join(', ') || 'nothing') + ' while ' + otherHad.join(', ') + ' had events with an operational model' });
  /* 2 · the headline candidate rests on no independent projection */
  const h = headline(j);
  if (h) {
    const independent = h.kind === 'MULTI_VERIFIED' ? !!(h.row.model && h.row.model.source === 'INDEPENDENT_MODEL_PROJECTION')
      : h.kind === 'MULTI_RESEARCH' ? !!(h.row.modeled && h.row.modeled.probability != null && h.row.model && h.row.model.artifact)
        : h.kind === 'LEGACY_CANDIDATE' ? !!(h.row.research && h.row.research.independent_fair_probability != null) || (h.row.candidate && h.row.candidate.fair && h.row.candidate.fair.method === 'MODEL')
          : false;
    if (!independent) out.push({ code: 'NO_INDEPENDENT_PROJECTION', detail: h.kind + ': ' + JSON.stringify(h.row.candidate ? h.row.candidate.fair : h.row.why || null).slice(0, 160) });
  }
  /* 3 · a candidate the answer puts forward stands on a stale price or a reference line (not a current price) */
  if (ms) {
    const shown = [ms.best_verified, ms.market_watch].filter(Boolean);
    const bad = shown.filter((r) => !(r.quote && r.quote.freshness && r.quote.freshness.actionable));
    if (bad.length) out.push({ code: 'STALE_QUOTE', detail: bad.map((r) => r.selection).join('; ') });
  } else {
    const sc = j.scan || {};
    const rows = [sc.best].concat(sc.potential || [], sc.near_misses || []).filter(Boolean).map((r) => ({ what: r.candidate.selection, f: String(r.candidate.quote && (r.candidate.quote.freshness || r.candidate.quote.status) || '') }))
      .concat((sc.board_near_misses || []).map((r) => ({ what: r.selection + ' ' + r.market, f: String(r.freshness || '') })));
    const bad = rows.filter((r) => /STALE|AGING|LINE_ONLY|UNKNOWN/i.test(r.f));
    if (bad.length) out.push({ code: 'STALE_QUOTE', detail: bad.map((r) => r.what + ' (' + r.f + ')').join('; ') });
  }
  /* 4 · a starter disagreement that was not held back */
  const sea = (FX.artifacts['football/nfl/slate.json'].games || []).find((g) => g.game_id === '2026_06_SEA_DEN');
  const depth = FX.artifacts['football/starters/nfl_2026.json'].teams.sea;
  if (sea && depth && sea.away_starter && sea.away_starter.player_name !== depth.player_name) {
    const heldBack = ms && (ms.held_back || []).some((r) => /Seattle Seahawks @ Denver Broncos/.test(r.event) && r.invalidated);
    if (!heldBack) out.push({ code: 'STARTER_DISAGREEMENT', detail: 'the SEA @ DEN projection assumed ' + sea.away_starter.player_name + ' while the depth chart lists ' + depth.player_name + ', and it was not held back' });
  }
  return out;
}

(async function main() {
  const href = pathToFileURL(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', 'index.ts')).href;
  async function ask(m, question, extra) {
    if (m.clearCache) m.clearCache(); if (m.resetRateLimit) m.resetRateLimit(); if (m.clearInvestigationCache) m.clearInvestigationCache();
    log = []; posted = []; modelCalls = 0;
    const body = Object.assign({ mode: 'chat', question, packet: null, history: [], research_context: null, timezone: 'America/Chicago', desk: true }, extra || {});
    const r = await m.handle(new Request('https://fn.test/edgedesk_ai', { method: 'POST', headers: { authorization: 'Bearer user-jwt', 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    const j = await r.json();
    if (PRINT) console.log('\n──── Q: ' + question + '\n' + (j.answer || JSON.stringify(j).slice(0, 600)));
    return { status: r.status, j };
  }
  const Q = "What's the best researched opportunity tonight?";
  ok('the fixture is the committed state at the replay time, with no look-ahead refusal', FX.replay_at === '2026-10-15T13:00:00Z' && !Object.keys(FX.errors || {}).length && Object.values(FX.meta).every((x) => !x.generated_at || Date.parse(x.generated_at) <= REPLAY), FX.errors);
  ok('…and on that day NHL (11 games) had an operational model, the NFL one game, college football three', TRUTH.discovery.by_sport.nhl.with_projection === 11 && TRUTH.discovery.by_sport.nfl.with_projection === 1 && TRUTH.discovery.by_sport.cfb.with_projection === 3, TRUTH.discovery.by_sport);

  /* ═══ 1. THE CAPTURED-PRICE DESK ALONE: THE OCT 15 DEFECTS, REPRODUCED ═══ */
  ENV.EDGEDESK_MULTISPORT = '0';
  const mLegacy = await import(href + '?multisport=off');
  const L = await ask(mLegacy, Q);
  ok('LEGACY: the scan answers', L.status === 200 && L.j.quant && L.j.quant.intent === 'SCAN', [L.status, L.j.quant, L.j.error]);
  ok('LEGACY: it carries no multi-sport research', !L.j.multisport || L.j.multisport === null, L.j.multisport);
  const dl = defects(L.j).map((d) => d.code);
  ok('LEGACY: the detector finds the NFL-only focus', dl.includes('NFL_ONLY_FOCUS'), defects(L.j));
  ok('LEGACY: the detector finds the missing independent projection', dl.includes('NO_INDEPENDENT_PROJECTION'), defects(L.j));
  ok('LEGACY: the detector finds the stale quote', dl.includes('STALE_QUOTE'), defects(L.j));
  ok('LEGACY: the detector finds the unheld starter disagreement (Drew Lock assumed, Sam Darnold on the depth chart)', dl.includes('STARTER_DISAGREEMENT'), defects(L.j));
  ok('LEGACY: NHL is reported NOT_CAPTURED by the price board — the root cause: no price, no research', (L.j.scan.coverage || []).some((c) => c.sport === 'icehockey_nhl' && c.status === 'NOT_CAPTURED'), (L.j.scan.coverage || []).map((c) => c.sport + ':' + c.status));
  delete ENV.EDGEDESK_MULTISPORT;

  /* ═══ 2. THE MULTI-SPORT DESK: THE SAME DAY, THE SAME DATA ═══ */
  const mNew = await import(href + '?multisport=on');
  const N = await ask(mNew, Q);
  const ms = N.j.multisport || {};
  ok('NEW: the scan answers deterministically, no model call', N.status === 200 && N.j.quant && N.j.quant.intent === 'SCAN' && modelCalls === 0, [N.status, N.j.error]);
  ok('NEW: the detector finds none of the four defects', defects(N.j).length === 0, defects(N.j));
  ok('NEW: six sports discovered, NHL with 11 events, all 11 researched', ms.counts && ms.counts.sports_discovered === 6 && ms.coverage.find((c) => c.sport === 'nhl').events_discovered === 11 && ms.coverage.find((c) => c.sport === 'nhl').events_researched === 11, ms.counts);
  ok('NEW: 15 independent projections frozen (NHL 11, NFL 1, CFB 3)', ms.counts && ms.counts.independent_projections === 15, ms.counts);
  ok('NEW: the best researched matchup is an NHL game, not football', ms.best_research && ms.best_research.sport === 'nhl', ms.best_research && [ms.best_research.sport, ms.best_research.event]);
  ok('NEW: …it carries its modeled probability, uncertainty, validation and freshness as separate fields', ms.best_research && ms.best_research.modeled.probability > 0.5 && ms.best_research.modeled.sigma.total > 0 && ms.best_research.model_confidence.validation_state === 'OUTCOME_VALIDATED' && ms.best_research.model_confidence.n > 1000 && ms.best_research.freshness.state === 'FRESH', ms.best_research);
  ok('NEW: no verified opportunity — every scoreboard price is stale at 8 AM, and the answer says so', !ms.best_verified && ms.comparison_counts.STALE_PRICE > 0 && ms.comparison_counts.VERIFIED_POSITIVE_EV === 0 && /^BEST VERIFIED OPPORTUNITY\nNone\./.test(N.j.answer) && /stale price/.test(N.j.answer), ms.comparison_counts);
  ok('NEW: the SEA @ DEN projection is held back for the starter conflict, both sources named', (ms.held_back || []).some((r) => /Seattle Seahawks @ Denver Broncos/.test(r.event) && r.invalidated && /Drew Lock/.test(r.availability.conflicts[0]) && /Sam Darnold/.test(r.availability.conflicts[0])), ms.held_back);
  ok('NEW: the answer has every section, in order', ['BEST VERIFIED OPPORTUNITY', 'BEST RESEARCHED MATCHUP', 'STRONGEST CONDITIONAL MARKET WATCH', 'OTHER TOP CANDIDATES', 'WHAT COULD CHANGE THE ANSWER', 'COVERAGE REPORT', 'MARKET BENCHMARK', 'RESEARCH SOURCES'].every((h, i, a) => N.j.answer.indexOf(h) >= 0 && (i === 0 || N.j.answer.indexOf(h) > N.j.answer.indexOf(a[i - 1]))), N.j.answer.split('\n').filter((l) => /^[A-Z ]{8,}/.test(l)));
  ok('NEW: the coverage report names every blocker: NBA preseason, Europa League, MLB without a projection', /NBA: 2 discovered, 0 researched.*preseason/.test(N.j.answer) && /Europa League is not a modelled competition/.test(N.j.answer) && /MLB: 2 discovered, 0 researched.*no per-game MLB projection/.test(N.j.answer), N.j.answer.split('\n').filter((l) => /^- /.test(l)));
  ok('NEW: a probability is never called a confidence score', /not a confidence score/.test(N.j.answer) && !/confidence[^\n]{0,20}\d{2}(\.\d)?%/i.test(N.j.answer));
  ok('NEW: the captured-price result survives as a labelled market benchmark, not as EdgeDesk\'s edge', N.j.scan && N.j.scan.role === 'MARKET_BENCHMARK' && /MARKET BENCHMARK — CAPTURED-PRICE AUDIT \(market-derived/.test(N.j.answer), N.j.scan && N.j.scan.role);

  /* ═══ 3. THE ORDER: FROZEN AND WRITTEN BEFORE ANY PRICE IS READ ═══ */
  const snapPost = posted.find((p) => p.table === 'projection_snapshots');
  const firstPrice = log.findIndex((x) => PRICE_URL.test(x.u));
  ok('ORDER: the frozen snapshot is written under the reader\'s token, idempotent on (user, snapshot)', snapPost && /on_conflict=user_id,snapshot_id/.test(snapPost.query) && /^pjs_[0-9a-f]{32}$/.test(snapPost.body.snapshot_id) && snapPost.body.projections.length === 15, snapPost && [snapPost.query, snapPost.body.snapshot_id]);
  ok('ORDER: …BEFORE the first price read (signals)', snapPost && firstPrice > snapPost.at, { snapshot_at: snapPost && snapPost.at, first_price_read: firstPrice, first: log[firstPrice] });
  ok('ORDER: every projection in the snapshot states no market input', snapPost && snapPost.body.projections.every((p) => Array.isArray(p.market_inputs) && p.market_inputs.length === 0));
  const cmpPost = posted.find((p) => p.table === 'market_comparisons');
  const hashes = new Map(snapPost ? snapPost.body.projections.map((p) => [p.projection_id, p.projection_hash]) : []);
  ok('ORDER: the comparison rows name that snapshot and the exact projection hashes it froze', cmpPost && cmpPost.body.length > 0 && cmpPost.body.every((r) => r.snapshot_id === snapPost.body.snapshot_id && hashes.get(r.projection_id) === r.projection_hash && Date.parse(r.compared_at) >= Date.parse(r.frozen_at)), cmpPost && cmpPost.body.slice(0, 2));
  ok('ORDER: the answer proves the comparison did not move a projection', ms.order && ms.order.snapshot_unchanged === true && ms.order.frozen_before_market === true, ms.order);
  /* a second question on unchanged projections is its own freeze: its own row, and its comparisons name it (a hash-only id
     was deduplicated onto the first freeze, so the database refused every comparison of the second turn) */
  const N2 = await ask(mNew, Q);
  const snap2 = posted.find((p) => p.table === 'projection_snapshots'), cmp2 = posted.find((p) => p.table === 'market_comparisons');
  ok('ORDER: a second question on the same projections writes its own snapshot (same hash, new id) and its comparisons name that one', N2.status === 200 && snap2 && snapPost && snap2.body.snapshot_hash === snapPost.body.snapshot_hash && snap2.body.snapshot_id !== snapPost.body.snapshot_id
    && cmp2 && cmp2.body.length > 0 && cmp2.body.every((r) => r.snapshot_id === snap2.body.snapshot_id && r.frozen_at === snap2.body.frozen_at), [snapPost && snapPost.body.snapshot_id, snap2 && snap2.body.snapshot_id, snap2 && snap2.body.frozen_at]);

  /* ═══ 4. EVERY ODDS INTEGRATION OFF ═══ */
  ENV.EDGEDESK_ODDS_DISABLED = '1';
  refusePrices = true;
  const mOff = await import(href + '?odds=off');
  const O = await ask(mOff, Q);
  const mo = O.j.multisport || {};
  ok('ODDS OFF: the desk still answers, with no price endpoint touched', O.status === 200 && mo.available && !log.some((x) => PRICE_URL.test(x.u)), [O.status, O.j.error, log.filter((x) => PRICE_URL.test(x.u)).map((x) => x.u)]);
  ok('ODDS OFF: every event with an operational model still gets its independent projection (15)', mo.counts && mo.counts.independent_projections === 15 && mo.counts.research_evaluations === 15, mo.counts);
  ok('ODDS OFF: the same best researched matchup as with odds on — prices never move a projection', mo.best_research && ms.best_research && mo.best_research.projection_id === ms.best_research.projection_id && mo.best_research.modeled.probability === ms.best_research.modeled.probability, [mo.best_research && mo.best_research.event, ms.best_research && ms.best_research.event]);
  ok('ODDS OFF: the snapshot hash is identical to the odds-on run (same projections, same hashes)', mo.snapshot && ms.snapshot && mo.snapshot.snapshot_hash === ms.snapshot.snapshot_hash, [mo.snapshot, ms.snapshot]);
  ok('ODDS OFF: every market reads NO CURRENT ODDS, nothing is called an edge', mo.comparison_counts && mo.comparison_counts.NO_CURRENT_ODDS > 0 && Object.keys(mo.comparison_counts).filter((k) => k !== 'NO_CURRENT_ODDS').every((k) => mo.comparison_counts[k] === 0) && mo.odds.disabled === true, mo.comparison_counts);
  ok('ODDS OFF: the answer says the integrations are off and the captured-price audit did not run', /odds integrations are disabled/.test(O.j.answer) && /Not run: the odds integrations are disabled/.test(O.j.answer) && O.j.scan && O.j.scan.not_run === 'ODDS_DISABLED', O.j.answer.split('\n').slice(0, 3));
  /* the single-game routing check reads captured prices (signals); with every odds integration off it is skipped */
  const O2 = await ask(mOff, "What's the best Vegas bet tonight?");
  ok('ODDS OFF: a scan naming a team reads no price before (or after) the freeze — the named-game check is skipped', O2.status === 200 && O2.j.quant && O2.j.quant.intent === 'SCAN' && !log.some((x) => PRICE_URL.test(x.u)), log.filter((x) => PRICE_URL.test(x.u)).map((x) => x.u));
  refusePrices = false;
  delete ENV.EDGEDESK_ODDS_DISABLED;

  /* ═══ 4b. "WHICH SPORTS COULDN'T BE SCANNED?" — prices AND research ═══ */
  const C = await ask(mNew, "Which sports couldn't be scanned?");
  ok('COVERAGE: the price capture is still reported (NHL prices not captured)…', C.j.quant && C.j.quant.intent === 'COVERAGE' && /NHL/.test(C.j.answer), C.j.answer);
  ok('COVERAGE: …beside the research coverage, which needs no price: NHL 11 of 11 researched, MLB with its blocker', /Research coverage \(models first/.test(C.j.answer) && /NHL 11 of 11 researched/.test(C.j.answer) && /MLB 0 of 2 researched \(no per-game MLB projection/.test(C.j.answer), C.j.answer.split('Research coverage')[1]);

  /* ═══ 5. A DIFFERENT DAY, A DIFFERENT ZONE ═══ */
  const T = await ask(mNew, "What's the best researched opportunity tomorrow?", { timezone: 'America/Los_Angeles' });
  ok('TOMORROW (Los Angeles): the window is the next local day, and NHL games on Oct 16 Pacific are in it', T.j.multisport && /tomorrow, 2026-10-16/.test(T.j.multisport.window.label) && T.j.multisport.window.timezone === 'America/Los_Angeles', T.j.multisport && T.j.multisport.window);

  /* MS_DUMP=<file>: the handler's real Oct 15 responses, for the browser suite (quant_ui.e2e.js) to render */
  if (process.env.MS_DUMP) require('fs').writeFileSync(process.env.MS_DUMP, JSON.stringify({ oct15: { question: Q, response: N.j }, odds_off: { question: Q, response: O.j } }));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('the suite threw', e && e.stack || e); process.exit(1); });
