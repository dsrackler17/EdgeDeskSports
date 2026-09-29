#!/usr/bin/env node
/* ===========================================================================
   The AI desk's player-prop answers (football/props/desk.js, EDPROPS) — the
   kernel, then the real edge function (supabase/functions/edgedesk_ai/
   index.ts) answering through propsTurn with the published artifacts routed.

     node football/props/desk.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const EDP = require('../../lib/player_props.js');
const D = require('./desk.js');
const FX = require('../../tools/intelligence/fixtures.js');

let pass = 0, fail = 0;
function ok(label, cond, detail) { if (cond) pass++; else { fail++; console.log('FAIL | ' + label + (detail !== undefined ? ' | ' + JSON.stringify(detail).slice(0, 400) : '')); } }

/* ------------------------------------------------------- a published prop */
const table = { probs: [0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99], bins: [{ mu_lo: 1, mu_hi: 200, mu_mid: 60, n: 1000, q: [0, 0.35, 0.68, 1.0, 1.32, 1.66, 2.4] }] };
const dist = EDP.dist.continuousFromRatio(74, table, 0, { integer: true });
const sum = EDP.dist.summary(dist);
const ref = EDP.dist.probs(dist, 69.5);
function prop(withMarket) {
  const p = {
    id: '2026_05_KC_BUF|espn:2|receiving_yards', league: 'NFL', game_id: '2026_05_KC_BUF', kickoff_utc: new Date(Date.now() + 3 * 86400e3).toISOString(), matchup: 'Kansas City Chiefs @ Buffalo Bills',
    team: 'KC', opponent: 'BUF', is_home: false, player_id: 'espn:2', player: 'Travis Kelce', position: 'TE', market_key: 'receiving_yards', market_label: 'Receiving yards', family: 'cdf',
    model: { prediction_id: 'pp_x', model_version: 'nfl_te_receiving_yards_v1.2025', feature_version: 'pf1', training_cutoff: '2026-02-09T23:30:00.000Z', scored_at: new Date().toISOString(),
      mean: sum.mean, median: sum.median, p10: sum.p10, p25: sum.p25, p75: sum.p75, p90: sum.p90, sd: sum.sd, uncertainty: 1.1, ref_line: 69.5, over_prob: Number(ref.over.toFixed(4)), under_prob: Number(ref.under.toFixed(4)),
      fair_over: EDP.evaluateQuote(dist, { side: 'over', line: 69.5, american_price: -110, lineage: 'observed' }).fair_american, fair_under: EDP.evaluateQuote(dist, { side: 'under', line: 69.5, american_price: -110, lineage: 'observed' }).fair_american,
      outcome_tier: 'OUTCOME_LEAN', market_tier: 'RESEARCH', recalibrated: true, dist },
    market: null, movement: null, focus: null, ladders: null,
    confidence: { score: 58, grade: 'MEDIUM', components: [], unknown: ['market_depth'] }, data_quality: { score: 0.82, parts: [] }, decision: { decision: 'PASS', reasons: ['no observed sportsbook line captured'] },
    drivers: [{ feature: 'target_share_l5', label: 'target share (last 5)', value: 0.24, pct: 6.1, effect: 0.059, text: 'target share (last 5) 0.24 moves the projection +6.1%' }],
    explain: { risks: ['Market depth is unknown, so it cannot support the number.'], invalidators: ['A role change, an inactive designation or a line move past the fair price would remove the edge.'] },
    context: {}
  };
  if (withMarket) {
    const e = EDP.evaluateQuote(dist, { side: 'over', line: 69.5, american_price: -110, sportsbook: 'draftkings', lineage: 'observed' }, { no_vig_prob: 0.5, consensus_prob: 0.5, reliability: 0.6 });
    p.market = { consensus_line: 69.5, consensus_over_prob: 0.5, consensus_under_prob: 0.5, book_count: 3, best_over_price: { sportsbook: 'draftkings', side: 'over', line: 69.5, american: -110 },
      best_under_price: { sportsbook: 'fanduel', side: 'under', line: 69.5, american: -108 }, books: [] };
    p.focus = { side: 'over', line: 69.5, sportsbook: 'draftkings', american: -110, implied_prob: e.implied_prob, market_prob: 0.5, model_prob: e.model_prob, edge_vs_market: e.edge_vs_market,
      fair_american: e.fair_american, ev: e.ev, conservative_ev: e.conservative_ev, kelly_growth: e.kelly_growth };
    p.decision = { decision: 'LEAN', reasons: ['capped at LEAN'] };
  }
  return p;
}
function board(p) {
  return { schema: 'edgedesk_props_board_v1', league: 'NFL', generated_at: new Date().toISOString(), quotes: { captured: !!p.market },
    rows: [{ id: p.id, game_id: p.game_id, kickoff: p.kickoff_utc, matchup: p.matchup, team: p.team, opp: p.opponent, player_id: p.player_id, player: p.player, pos: p.position, market: p.market_key,
      mean: p.model.mean, median: p.model.median, ref_line: 69.5, over: p.model.over_prob, focus: p.focus ? { side: 'over', line: 69.5, book: 'draftkings', am: -110, model: p.focus.model_prob, market: 0.5, edge: p.focus.edge_vs_market, ev: p.focus.ev, cev: p.focus.conservative_ev, fair: p.focus.fair_american } : null,
      conf: 58, dq: 0.82, decision: p.decision.decision }], games: [] };
}

/* the same prop as the scorer publishes it: priced by the kernel's reprice()
   on observed quotes, then PACKED into the board, the card and the market
   file exactly as football/props/publish.js writes them */
const NOW = Date.now(), NOW_ISO = new Date(NOW).toISOString();
function quotes(p) {
  const at = new Date(NOW - 20 * 60e3).toISOString();
  const out = [];
  [['draftkings', -110, -110], ['fanduel', -112, -108], ['betmgm', -115, -105]].forEach(([b, o, u]) => {
    out.push({ game_id: p.game_id, player_id: p.player_id, market_key: p.market_key, sportsbook: b, side: 'over', line: 69.5, american_price: o, snapshot_at: at, is_main_line: true, lineage: 'observed' });
    out.push({ game_id: p.game_id, player_id: p.player_id, market_key: p.market_key, sportsbook: b, side: 'under', line: 69.5, american_price: u, snapshot_at: at, is_main_line: true, lineage: 'observed' });
  });
  return out;
}
function scoredProp(withMarket) {
  const p = prop(false);
  delete p.explain; p.headshot = null;
  p.confidence = EDP.confidence({ sample_size: 0.8, model_calibration: 0.7, role_certainty: 0.8, injury_certainty: 1, qb_certainty: 1, model_agreement: 0.8, source_quality: 1 });
  p._dq_inputs = { feature_completeness: 0.9, identity_confidence: 1, source_quality: 1, availability_freshness: 0.9 };
  p._invalidators = []; p.context = { form: {} }; p.imputed = []; p.as_of = p.model.scored_at; p.source_max_timestamp = null;
  return EDP.reprice(p, withMarket ? quotes(p) : [], { now: NOW });
}
function packed(withMarket) {
  const p = scoredProp(withMarket);
  const game = { game_id: p.game_id, kickoff_utc: p.kickoff_utc, home: 'BUF', away: 'KC', home_name: 'Buffalo Bills', away_name: 'Kansas City Chiefs' };
  return { p,
    board: EDP.wire.packBoard({ schema: 'edgedesk_props_board_v1', league: 'NFL', generated_at: NOW_ISO, as_of: NOW_ISO, quotes: { captured: withMarket },
      games: [{ game_id: p.game_id, kickoff: p.kickoff_utc, home: 'Buffalo Bills', away: 'Kansas City Chiefs', home_id: 'BUF', away_id: 'KC' }] }, [p]),
    card: EDP.wire.packCard([p], game, { league: 'NFL', generated_at: NOW_ISO }),
    market: EDP.wire.packMarket([p], { league: 'NFL', game_id: p.game_id, as_of: NOW_ISO }) };
}

/* ======================================================= 1. the kernel */
ok('classify: a player line with a market word is a PROP', (D.classify('Why does EdgeDesk like Kelce over 72.5 receiving yards?') || {}).intent === 'PROP');
ok('classify: reads the side, line and price', (() => { const c = D.classify('Is Travis Kelce o61.5 rec yds at -115 good?'); return c.side === 'over' && c.line === 61.5 && c.price === -115 && c.market === 'receiving_yards'; })());
ok('classify: "best NFL props" is the board', (D.classify('What are the best NFL player props today?') || {}).intent === 'PROP_BOARD');
ok('classify: a game total stays with the game desk', D.classify('Is the Chiefs Bills over 47.5 total points good?') === null);
ok('classify: a spread question is not a prop', D.classify('Is Buffalo -3.5 worth it?') === null);
ok('classify: anytime TD', (D.classify('Will Kelce score a touchdown? anytime td +140') || {}).market === 'anytime_td');
const b1 = board(prop(false));
ok('resolve: a full name on the board', (D.findPlayer([b1], 'why does edgedesk like travis kelce over 72.5') || {}).player.player === 'Travis Kelce');
ok('resolve: a unique last name', (D.findPlayer([b1], 'kelce receiving yards?') || {}).by === 'last name');
ok('resolve: a name not on the board is not guessed', D.findPlayer([b1], 'Davante Adams receiving yards') === null);

const noMkt = D.answer('Why does EdgeDesk like Kelce over 72.5 receiving yards?', D.classify('Why does EdgeDesk like Kelce over 72.5 receiving yards?'), prop(false), {});
ok('answer (no market): says there is no market — never a guessed one', /no observed sportsbook line has been captured/.test(noMkt.text), noMkt.text);
ok('answer (no market): prices the reader\'s own line from the same distribution', /At over 72\.5: model probability/.test(noMkt.text) && Math.abs(noMkt.ask.prob - EDP.dist.probs(dist, 72.5).over) < 1e-9, noMkt.text);
ok('answer: model, market, why, risks, invalidators and the tagline', ['Model:', 'Market:', 'Why the model', 'Risks:', 'What would invalidate', 'Research, not picks.'].every((k) => noMkt.text.indexOf(k) >= 0), noMkt.text);
ok('critic: the deterministic answer contains only published or kernel-computed numbers', D.critic(noMkt.text, noMkt.facts).ok, D.critic(noMkt.text, noMkt.facts));
ok('critic: an invented number is caught', !D.critic(noMkt.text + ' He has cleared 88 in five straight games.', noMkt.facts).ok);

const withMkt = D.answer('Is Kelce over 69.5 at -150 worth it?', D.classify('Is Kelce over 69.5 rec yards at -150 worth it?'), prop(true), {});
ok('answer (market): the model/market/edge split is stated', /Market: 3 books, consensus 69\.5/.test(withMkt.text) && /Edge: the best-value quote is over 69\.5 -110 at draftkings/.test(withMkt.text), withMkt.text);
ok('answer: a price, not a line, makes the bet — the same line at -150 is honestly negative', withMkt.ask.ev < 0 && /does NOT see value/.test(withMkt.text), withMkt.text);
ok('critic: the market answer passes too', D.critic(withMkt.text, withMkt.facts).ok, D.critic(withMkt.text, withMkt.facts));
const brd = D.boardAnswer([board(prop(false))], { intent: 'PROP_BOARD' });
ok('board: with no captured quotes it ranks nothing and says why', /no observed sportsbook line has been captured/.test(brd.text));
const brd2 = D.boardAnswer([board(prop(true))], { intent: 'PROP_BOARD' });
ok('board: priced props are ranked by conservative EV and capped at LEAN', /Strongest priced props/.test(brd2.text) && /capped at LEAN/.test(brd2.text));

/* the packed artifacts, unpacked by the desk with the kernel */
const pk = packed(true);
const eb = D.expandBoard(JSON.parse(JSON.stringify(pk.board)));
ok('wire: the desk unpacks the packed board row', eb.rows.length === 1 && eb.rows[0].id === pk.p.id && eb.rows[0].player === 'Travis Kelce' && eb.rows[0].focus && eb.rows[0].mkt.books === 3, eb.rows[0]);
const ec = D.expandCard(JSON.parse(JSON.stringify(pk.card)), JSON.parse(JSON.stringify(pk.market)));
ok('wire: the card + market file re-derive the scorer\'s prices exactly', ec.length === 1 && JSON.stringify([ec[0].focus, ec[0].market, ec[0].ladders, ec[0].decision, ec[0].confidence, ec[0].data_quality, ec[0].explain]) ===
  JSON.stringify([pk.p.focus, pk.p.market, pk.p.ladders, pk.p.decision, pk.p.confidence, pk.p.data_quality, pk.p.explain]), [ec[0] && ec[0].focus, pk.p.focus]);
ok('wire: the card alone is the model half — no market is invented', (() => { const x = D.expandCard(JSON.parse(JSON.stringify(pk.card)), null)[0]; return x.market === null && x.focus === null && x.ladders === null && x.decision.decision === 'PASS' && x.model.over_prob > 0; })());

/* ======================================================= 2. the handler */
const ENV = { EDGEDESK_AI_NO_SERVE: '1', ANTHROPIC_API_KEY: 'test-key', SUPABASE_URL: 'https://sb.test', SUPABASE_ANON_KEY: 'anon-key', EDGEDESK_SITE_BASE: 'https://site.test' };
globalThis.Deno = { env: { get: (k) => ENV[k] } };
let route = () => [];
globalThis.fetch = async function (url, init) {
  const s = String(url);
  if (s.indexOf('api.anthropic.com') >= 0) return { ok: true, status: 200, json: async () => ({ model: 'test', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }), text: async () => 'ok' };
  if (init && init.method === 'POST' && s.indexOf('sb.test') >= 0) return { ok: true, status: 201, text: async () => '', json: async () => [] };
  if (init && init.method === 'HEAD') return { ok: true, status: 200, headers: { get: () => '*/0' }, text: async () => '' };
  const d = route(s, init);
  if (d === null || d === undefined) return { ok: false, status: 404, text: async () => 'nope', json: async () => null };
  return { ok: true, status: 200, text: async () => JSON.stringify(d), json: async () => d };
};
(async function main() {
  const m = await import(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', 'index.ts'));
  let fetched = [];
  const fx = FX.build(Date.now());
  const base = FX.router(fx, { signals: [fx.signal()] });
  async function ask(question, opts) {
    opts = opts || {};
    m.clearCache(); m.resetRateLimit(); if (m.clearInvestigationCache) m.clearInvestigationCache();
    const P = packed(!!opts.market);
    fetched = [];
    route = (s, init) => {
      if (/football\/props\/published\//.test(s)) fetched.push(s.replace(/^.*published\//, ''));
      if (/football\/props\/published\/board_nfl\.json/.test(s)) return opts.noBoard ? null : P.board;
      if (/football\/props\/published\/board_cfb\.json/.test(s)) return null;
      if (/football\/props\/published\/nfl\/2026_05_KC_BUF\.json/.test(s)) return P.card;
      if (/football\/props\/published\/nfl\/2026_05_KC_BUF\.market\.json/.test(s)) return P.market;
      return base(s, init);
    };
    const body = { mode: 'chat', question, packet: null, history: [], research_context: null, desk: true };
    const r = await m.handle(new Request('https://fn.test/edgedesk_ai', { method: 'POST', headers: { authorization: 'Bearer user-jwt', 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    return { status: r.status, j: await r.json() };
  }
  const h1 = await ask('Why does EdgeDesk like Travis Kelce over 72.5 receiving yards?');
  ok('host: a prop question gets the PROPS answer, before the game desk', h1.status === 200 && h1.j.desk && h1.j.desk.intent === 'PROPS' && /Travis Kelce — Receiving yards/.test(h1.j.answer), h1.j.answer || h1.j.error);
  ok('host: it carries the props block and the context forward', h1.j.props && h1.j.props.prop_id === '2026_05_KC_BUF|espn:2|receiving_yards' && h1.j.research.research_context.player === 'Travis Kelce');
  ok('host: the critic passed on what was returned', h1.j.narration && h1.j.narration.critic && h1.j.narration.critic.ok === true, h1.j.narration);
  ok('host: an unpriced prop reads the card only (no market file is requested)', fetched.indexOf('nfl/2026_05_KC_BUF.json') >= 0 && !fetched.some((f) => /market\.json$/.test(f)), fetched);
  const h2 = await ask('Is Kelce over 69.5 receiving yards at -115 good?', { market: true });
  ok('host: with a market, the answer states model, market and edge', /Market: 3 books/.test(h2.j.answer || '') && /Edge:/.test(h2.j.answer || ''), h2.j.answer);
  ok('host: a priced prop reads the market file too', fetched.indexOf('nfl/2026_05_KC_BUF.market.json') >= 0, fetched);
  const h3 = await ask('best NFL player props today?');
  ok('host: the board question is answered from the board', h3.j.desk && h3.j.desk.intent === 'PROPS' && /player-prop projections/.test(h3.j.answer || ''), h3.j.answer);
  const h4 = await ask('Is Buffalo -3.5 worth it?');
  ok('host: a spread question falls through to the game desk', !(h4.j.desk && h4.j.desk.intent === 'PROPS'));
  const h5 = await ask('Why does EdgeDesk like Kelce over 72.5 receiving yards?', { noBoard: true });
  ok('host: no published board, no props answer', !(h5.j.desk && h5.j.desk.intent === 'PROPS'));
  console.log((fail ? 'FAILED' : 'ALL GREEN') + ' props desk — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
