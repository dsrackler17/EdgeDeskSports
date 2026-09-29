#!/usr/bin/env node
/* ===========================================================================
   THE AI RESEARCH DESK ON PLAYER PROPS (football/props/desk.js, inlined into
   supabase/functions/edgedesk_ai/index.ts as EDPROPSDESK, and propsTurn()).

     kernel   intent, player and prop resolution; every answer built from the
              committed files through EDProps.prepare, so the desk says what
              the board says; no price invented (PROJECTION ONLY), a stale
              quote decides nothing, a name that fits two players is asked
              back, an unmodeled prop is said, never estimated
     critic   a rephrasing may not add a number or say "lock" / "best bet"
     handler  the real handle(), with the network stubbed: a player-prop
              question from a desk client AND a chat client gets the
              deterministic props answer; anything else falls through

   Run: node tools/props/props_desk.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const X = require('./_fixture.js');
const K = require('../../football/props/desk.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++; console.log('FAIL | ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 500) : ''));
}

/* ----------------------------------------------------- the fixture files */
const F = X.load();
const better = (b) => b.bookmakers.forEach((bk) => bk.markets.forEach((m) => { if (m.key === 'player_reception_yds') m.outcomes.forEach((o) => { if (o.description === 'Davante Adams') { o.point = 63.5; o.price = o.name === 'Over' ? 120 : -145; } }); }));
const cap = X.capture(F, X.NOW - 5 * 60000, null, better);
const priced = X.board(F, X.NOW, cap.file, cap.unmapped);
const BOARD = priced.board, GAME = priced.asm.gameFiles[0];
const INDEX = { nfl: { schema: 'edgedesk_player_index_v1', players: {} }, cfb: { schema: 'edgedesk_player_index_v1', players: {} } };
Object.values(F.registry.players).forEach((p) => { if (BOARD.rows.some((r) => r.pid === p.id)) INDEX.nfl.players[p.id] = [p.name, p.slug, p.position, p.team, null, null, null]; });
/* a second "Williams" on another board, so a bare surname is ambiguous */
INDEX.cfb.players.edp_0000000000aa = ['Ryan Williams', 'ryan-williams', 'WR', 'alabama', null, null, null];

function run(q, opts) {
  opts = opts || {};
  const cls = K.classify(q, INDEX);
  if (!cls) return { cls: null, out: null };
  const files = { boards: { nfl: opts.board || BOARD } };
  let out = K.answer(q, cls, files, opts.now || X.NOW);
  if (out && out.need_game) out = K.finish(q, cls, out, { board: opts.board || BOARD, game: GAME, market: opts.market === undefined ? cap.file : opts.market }, opts.now || X.NOW);
  return { cls, out };
}

/* ============================================================== KERNEL */
{
  ok('props words map to prop types', K.propOf('receiving yards') === 'rec_yds' && K.propOf('how many catches') === 'receptions' && K.propOf('rush + rec yards') === 'rush_rec_yds' && K.propOf('anytime TD') === 'anytime_td' && K.propOf('passing yards') === 'pass_yds' && K.propOf('carries') === 'rush_att');
  const qt = K.quoteOf('Puka over 78.5 -105 at FanDuel');
  ok('a quote is read from the question', qt.side === 'over' && qt.line === 78.5 && qt.american === -105 && qt.book === 'fanduel', qt);
  ok('two quotes for a comparison', K.quoteOf('Is Bijan 71.5 -110 or 74.5 +105 better?').quotes.length === 2);

  const a = run('Should I bet Davante Adams over 63.5 receiving yards?');
  const row = BOARD.rows.find((r) => r.name === 'Davante Adams' && r.prop === 'rec_yds');
  ok('PROP: a named player and prop resolve to the board row', a.cls.intent === 'PROP' && a.out.row && a.out.row.id === row.id, a.cls && a.cls.intent);
  ok('the desk says what the board says: the same decision, price and EV', a.out.evaluation.decision === row.dec.cls && a.out.evaluation.recommended.american === row.px.am && Math.abs(a.out.evaluation.recommended.ev - row.px.ev) < 1e-9, a.out.evaluation.decision);
  ok('the answer carries the fair line, the book line, P(Over), the best price, edge, EV and reliability', /fair line is 70\.0/.test(a.out.text) && /consensus line is 63\.5/.test(a.out.text) && /P\(Over\) 55\.6%/.test(a.out.text) && /Over 63\.5 \+120 at DraftKings/.test(a.out.text) && /edge \+10\.2 pp/.test(a.out.text) && /EV \+22\.4%/.test(a.out.text) && /Reliability \d+\/100/.test(a.out.text), a.out.text);
  ok('and its decision in the house words, with units only on a BET', /EdgeDesk decision: BET 0\.25U/.test(a.out.text));
  ok('ends "Research, not picks."', /Research, not picks\.$/.test(a.out.text));
  ok('every number in the answer is a number the files or EDProps produced (critic passes itself)', K.critic(a.out.text, a.out).verdict === 'PASS');

  const b = run('Research Puka Nacua receiving yards over 81.5 -105 at FanDuel');
  ok('a quote the reader named is priced on the same distribution', /Your quote, Over 81\.5 −105 at FanDuel: P\(win\) \d/.test(b.out.text) && /zero-EV line is about \d/.test(b.out.text), b.out.text);
  ok('and it says no captured book deals it', /No captured book is dealing exactly that quote/.test(b.out.text));
  ok('an unresolved availability says so, and WATCH', /UNRESOLVED/.test(b.out.text) && /EdgeDesk decision: WATCH/.test(b.out.text));

  const c = run('Is Kyren Williams 64.5 -110 or 70.5 +130 better for rushing yards?');
  ok('COMPARE: both quotes priced on one distribution, never a claim about which "hits"', c.cls.intent === 'COMPARE' && /both priced on EdgeDesk’s one distribution/.test(c.out.text) && /higher EV/.test(c.out.text) && /higher probability/.test(c.out.text), c.out && c.out.text);

  const d = run('What does EdgeDesk project for Jalen Hurts?');
  ok('PLAYER: every projected prop with its fair line; no price where none is captured', d.cls.intent === 'PLAYER' && /Passing Yards: fair \d/.test(d.out.text) && /no price captured/.test(d.out.text), d.out && d.out.text);

  const e = run('Best player props today?');
  ok('BOARD: ranked by risk-adjusted EV, naming the price and book', e.cls.intent === 'BOARD' && /Davante Adams receiving yards Over 63\.5 \+120 at DraftKings \(BET 0\.25U/.test(e.out.text), e.out && e.out.text);
  ok('and a watch list with its reasons', /Watch list:/.test(e.out.text));
  const blank = X.board(F, X.NOW, null, []).board;
  const e2 = run('Best player props today?', { board: blank });
  ok('with no capture: no prop EV to rank, and nothing invented', /No sportsbook player-prop prices are captured for NFL/.test(e2.out.text) && !/\+\d+\.\d%/.test(e2.out.text), e2.out.text);

  const f = run('How does Nacua being out affect Adams?');
  ok('INJURY: the absent player’s share, who receives it and that part stays unassigned', f.cls.intent === 'INJURY' && /Puka Nacua \(UNRESOLVED/.test(f.out.text) && /Davante Adams is planned to receive \d/.test(f.out.text) && /never hands the whole share to one teammate/.test(f.out.text), f.out && f.out.text);

  const g = run('How many tackles will Dallas Goedert have?');
  ok('an unmodeled prop type is said, never estimated', g.cls.intent === 'UNMODELED' && !/\d+\.\d/.test(g.out.text), g.out && g.out.text);
  const h = run('Williams receiving yards?');
  ok('a surname two boards carry is asked back, never guessed', h.out && /More than one player/.test(h.out.text) && /Kyren Williams/.test(h.out.text) && /Ryan Williams/.test(h.out.text), h.out && h.out.text);
  const i = run('Davante Adams passing yards?');
  ok('a prop EdgeDesk does not project for that player is said', /no current passing yards projection for Davante Adams/.test(i.out.text), i.out && i.out.text);
  const j = run('Stafford passing yards?', { market: null });
  ok('no market file: PROJECTION ONLY, no EV', /No sportsbook price is captured for this prop/.test(j.out.text) && !/EV [+−]/.test(j.out.text), j.out && j.out.text);
  const k = run('Should I bet Davante Adams over 63.5 receiving yards?', { now: X.NOW + 3 * 3600e3 });
  ok('three hours later the same quote is stale: NO DECISION', /EdgeDesk decision: NO DECISION/.test(k.out.text) && /stale/i.test(k.out.text), k.out && k.out.text);
  ok('a question about a game, not a prop, is not the props desk', run('Who wins Rams at Eagles?').cls === null && run('What is the spread for Texas State?').cls === null);

  ok('critic: an added number fails', K.critic('Adams over 63.5 is a strong play at 71%.', a.out).findings.some((x) => x.code === 'NUMBER_NOT_IN_ANSWER'));
  ok('critic: "lock" and "best bet" fail', K.critic('This is a lock and our best bet.', a.out).findings.some((x) => x.code === 'BANNED_WORD'));
  ok('critic: certainty fails', K.critic('Adams will clear 63.5.', a.out).findings.some((x) => x.code === 'CERTAINTY'));
  ok('no answer anywhere uses a banned word', [a, b, c, d, e, f, g].every((r) => !/\b(lock|best bet|safe bet|guarantee)/i.test(r.out.text)));
}

/* ============================================================= HANDLER */
const SITE = 'https://site.test';
const ENV = { EDGEDESK_AI_NO_SERVE: '1', ANTHROPIC_API_KEY: 'test-key', SUPABASE_URL: 'https://sb.test', SUPABASE_ANON_KEY: 'anon-key', EDGEDESK_SITE_BASE: SITE };
globalThis.Deno = { env: { get: (k) => ENV[k] } };
const FILES = {
  '/football/props/nfl/players_index.json': INDEX.nfl, '/football/props/cfb/players_index.json': INDEX.cfb,
  '/football/props/nfl/board.json': BOARD, ['/football/props/nfl/games/' + X.GID + '.json']: GAME, ['/football/props/nfl/markets/' + X.GID + '.json']: cap.file
};
let modelCalls = 0;
globalThis.fetch = async function (url, init) {
  const s = String(url);
  if (s.indexOf('api.anthropic.com') >= 0) { modelCalls++; return { ok: true, status: 200, json: async () => ({ model: 'test', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }), text: async () => 'ok' }; }
  if (s.indexOf(SITE) === 0) {
    const p = s.slice(SITE.length).split('?')[0];
    const d = FILES[p];
    if (d === undefined) return { ok: false, status: 404, text: async () => 'not found', json: async () => null };
    return { ok: true, status: 200, text: async () => JSON.stringify(d), json: async () => d };
  }
  if (init && init.method === 'HEAD') return { ok: true, status: 200, headers: { get: () => '*/0' }, text: async () => '' };
  if (s.indexOf('sb.test') >= 0 && s.indexOf('/subscriptions') >= 0) {
    const sub = [{ status: 'active', price_id: 'price_test', current_period_end: new Date(Date.now() + 30 * 864e5).toISOString() }];
    return { ok: true, status: 200, text: async () => JSON.stringify(sub), json: async () => sub };
  }
  if (s.indexOf('sb.test') >= 0) return { ok: true, status: 200, text: async () => '[]', json: async () => [] };
  return { ok: false, status: 404, text: async () => 'nope', json: async () => null };
};

(async function main() {
  const m = await import(path.join(__dirname, '..', '..', 'supabase', 'functions', 'edgedesk_ai', 'index.ts'));
  ok('the edge function exports propsTurn', typeof m.propsTurn === 'function');
  async function ask(question, desk) {
    m.clearCache(); m.resetRateLimit(); if (m.clearInvestigationCache) m.clearInvestigationCache();
    const body = { mode: 'chat', question, packet: null, history: [], research_context: null };
    if (desk) body.desk = true;
    const r = await m.handle(new Request('https://fn.test/edgedesk_ai', { method: 'POST', headers: { authorization: 'Bearer user-jwt', 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    return { status: r.status, j: await r.json() };
  }
  /* propsTurn runs at the real clock, so it is called with the fixture's */
  const direct = await m.propsTurn({ body: { question: 'Should I bet Davante Adams over 63.5 receiving yards?' }, auth: 'Bearer x', now: X.NOW });
  const row = BOARD.rows.find((r) => r.name === 'Davante Adams' && r.prop === 'rec_yds');
  ok('propsTurn: the deterministic answer, the board’s decision and its sources', direct && direct.desk.intent === 'PROPS' && direct.props.decision.decision === row.dec.cls && direct.props.projection_id === row.id
    && direct.props.sources.some((x) => /board\.json/.test(x)) && direct.props.sources.some((x) => /markets\//.test(x)) && direct.answer === direct.deterministic_desk_answer, direct && direct.props);
  ok('propsTurn: no model is called without EDGEDESK_PROPS_NARRATE', direct && direct.model === null && direct.narration.prose === 'DETERMINISTIC');
  ok('propsTurn: the game is carried forward for follow-ups', direct && direct.research.research_context.game_id === X.GID && direct.research.research_context.sport === 'americanfootball_nfl');

  const before = modelCalls;
  const h1 = await ask('What does EdgeDesk project for Jalen Hurts?', true);
  ok('handler: a desk client gets the props answer', h1.status === 200 && h1.j.desk && h1.j.desk.intent === 'PROPS' && /Passing Yards: fair/.test(h1.j.answer), h1.j.answer || h1.j.error);
  const h2 = await ask('How many tackles will Dallas Goedert have?', false);
  ok('handler: a chat client gets it too (a prop question never reaches the model to be invented)', h2.status === 200 && h2.j.desk && h2.j.desk.intent === 'PROPS' && /does not model that prop type/.test(h2.j.answer), h2.j.answer || h2.j.error);
  ok('handler: neither spent a model call', modelCalls === before, modelCalls - before);
  const h3 = await ask('Who wins Texas State at North Texas?', true);
  ok('handler: a game question falls through to the desk and the pipeline', !(h3.j.desk && h3.j.desk.intent === 'PROPS'), h3.j.desk && h3.j.desk.intent);

  console.log((fail ? 'FAIL' : 'PASS') + ' | player props desk | ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
