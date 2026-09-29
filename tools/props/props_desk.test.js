#!/usr/bin/env node
/* ===========================================================================
   THE AI RESEARCH DESK ON PLAYER PROPS (football/props/desk.js, inlined into
   supabase/functions/edgedesk_ai/index.ts as EDPROPSDESK, and propsTurn()).

     kernel   intent, player and market resolution on the Player Props board
              the pipeline builds from its real-data fixture; every answer is
              EDProps.boardEval — the evaluation the build wrote and the Props
              page re-runs — so the desk says what the page says; no price is
              invented (a named line nobody deals is not priced, a stale
              captured price is not reused), a name that fits two players is
              asked back, a market EdgeDesk does not project is said
     critic   a rephrasing may not add a number or say "lock" / "best bet"
     handler  the real handle(), with the network stubbed: a player-prop
              question from a desk client AND a chat client gets the
              deterministic props answer; anything else falls through, and a
              plain injury question reads no board

   Run: node tools/props/props_desk.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const ROOT = path.join(__dirname, '..', '..');
require(path.join(ROOT, 'lib', 'research_core.js'));
require(path.join(ROOT, 'lib', 'edgedesk_decision.js'));
const EDP = require(path.join(ROOT, 'lib', 'edgedesk_props.js'));
const C = require(path.join(ROOT, 'football', 'props', 'config.js'));
const CAP = require(path.join(ROOT, 'football', 'props', 'capture.js'));
const B = require(path.join(ROOT, 'football', 'props', 'build_board.js'));
const K = require(path.join(ROOT, 'football', 'props', 'desk.js'));

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++; console.log('FAIL | ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 600) : ''));
}
const clone = (x) => JSON.parse(JSON.stringify(x));

/* ------------------------------------------ the board, built by the pipeline */
const FX = path.join(ROOT, 'football', 'props', 'fixtures');
const NOW = Date.parse('2026-10-04T15:10:00Z');
const OBS = '2026-10-04T15:05:00.000Z';
const GID = '2026_04_ATL_NO';

async function buildBoard() {
  const ds = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(FX, 'dataset_nfl.json.gz'))).toString('utf8'));
  const EVENT = JSON.parse(fs.readFileSync(path.join(FX, 'odds_event_nfl.json'), 'utf8'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'edp-desk-'));
  const p = C.leaguePaths('nfl', 2026), BP = {};
  Object.keys(p).forEach((k) => { BP[k] = p[k].replace(C.DIR, tmp); });
  fs.mkdirSync(BP.dir, { recursive: true });
  const pq = CAP.parseEventProps(EVENT, OBS);
  const poll = { id: EVENT.id, commence_time: EVENT.commence_time, home_team: EVENT.home_team, away_team: EVENT.away_team, books: ['draftkings'], quotes: pq.quotes.map((q) => Object.assign({}, q, { captured_at: OBS })) };
  const feed = CAP.buildQuotesFeed({ league: 'nfl', now: NOW, polled: [poll], observed_at: OBS });
  return (await B.build({ league: 'nfl', season: 2026, now: NOW, dataset: ds, quotes: feed, lines: null, paths: BP })).board;
}
/* a second board with another "Robinson", so the surname alone is ambiguous
   (test data: a name only, never priced) */
function otherBoard() {
  return { schema: 'edgedesk_player_props_board_v1', league: 'cfb', generated_at: OBS, games: [{ game_id: 'cfb_g1', kickoff: '2026-10-10T19:30:00Z', status: 'scheduled', home: 'alabama', away: 'auburn' }],
    players: { 'cfb_p1@cfb_g1': { id: 'cfb_p1', name: 'Jalen Robinson', pos: 'WR', team: 'alabama', g: 'cfb_g1' } }, props: [], stages: {} };
}

(async function main() {
  const NFL = await buildBoard();
  const BOARDS = { nfl: NFL, cfb: otherBoard() };
  const ask = (q, opts) => {
    opts = opts || {};
    const boards = opts.boards || BOARDS;
    const cls = K.classify(q, boards);
    return { cls, out: cls ? K.answer(q, cls, boards, opts.now || NOW) : null };
  };
  const pid = (name) => { const k = Object.keys(NFL.players).find((x) => NFL.players[x].name === name); return k ? NFL.players[k].id : null; };
  const rowOf = (name, m) => NFL.props.find((r) => r.p === pid(name) && r.m === m && r.g === GID);
  const BIJAN = pid('Bijan Robinson'), LONDON = pid('Drake London');
  ok('the fixture board is priced and names its players', !!BIJAN && !!LONDON && NFL.props.some((r) => r.q.length) && NFL.stages && NFL.stages.rush_yds, [BIJAN, LONDON]);

  /* ============================================================== KERNEL */
  ok('market words map to the board\'s market keys', K.marketOf('receiving yards') === 'rec_yds' && K.marketOf('how many catches') === 'receptions' && K.marketOf('rush + rec yards') === 'rush_rec_yds'
    && K.marketOf('anytime TD') === 'anytime_td' && K.marketOf('passing yards') === 'pass_yds' && K.marketOf('carries') === 'rush_att' && K.marketOf('interceptions') === 'pass_ints' && K.marketOf('longest reception') === 'rec_long');
  const qt = K.quoteOf('Puka over 78.5 -105 at FanDuel');
  ok('a quote is read from the question', qt.side === 'over' && qt.line === 78.5 && qt.american === -105 && qt.book === 'fanduel', qt);
  ok('two quotes for a comparison', K.quoteOf('Is Bijan 71.5 -110 or 74.5 +105 better?').quotes.length === 2);

  /* PROP: the desk says what the page says */
  const a = ask('Should I bet Bijan Robinson over 84.5 rushing yards?');
  const row = rowOf('Bijan Robinson', 'rush_yds');
  const page = EDP.boardEval(NFL, row, NOW);
  ok('PROP: a named player and market resolve to the board row', a.cls.intent === 'PROP' && a.out.row === row, a.cls && a.cls.intent);
  ok('the desk says what the page says: the same evaluation, decision and best price', a.out.evaluation.decision === page.decision && JSON.stringify(a.out.evaluation.candidate) === JSON.stringify(page.candidate) && a.out.evaluation.code === page.code, [a.out.evaluation.decision, page.decision]);
  ok('…and what the build wrote on the row', EDP.compact(a.out.evaluation).d === row.e.d && JSON.stringify(EDP.compact(a.out.evaluation).cand) === JSON.stringify(row.e.cand), [row.e.d, row.e.c]);
  const cand = page.candidate;
  ok('the answer carries the consensus line, the best price at its book, and the EV', a.out.text.indexOf('consensus line is ' + page.consensus.line) >= 0 && a.out.text.indexOf(EDP.bookName(cand.book)) >= 0
    && a.out.text.indexOf((cand.ev >= 0 ? '+' : '−') + Math.abs(100 * cand.ev).toFixed(1) + '%') >= 0, a.out.text);
  ok('an EXPERIMENTAL market says so and carries no units', NFL.stages.rush_yds.stage !== 'EXPERIMENTAL' || (/EXPERIMENTAL/.test(a.out.text) && !(a.out.evaluation.units > 0)), a.out.text);
  ok('the answer is research, not a pick', /Research, not picks\.$/.test(a.out.text));

  /* the data factory's validated distribution, when the board joined one (TEST FIXTURE row) */
  {
    const FXB = JSON.parse(JSON.stringify(NFL));
    FXB.factory = { state: 'JOINED', generated_at: OBS, models: [['nfl_rb_rush_yards_v1.2025', 'OUTCOME_VALIDATED', 0.1, 0.02, 3]] };
    const fr = FXB.props.find((r) => r.p === row.p && r.m === row.m && r.g === row.g);
    fr.fx = [0, { t: 'cdf', x: [9.5, 40.5, 60.5, 80.5, 100.5, 140.5, 220.5], p: [0, 0.1, 0.3, 0.55, 0.78, 0.95, 1], int: true }, null, OBS];
    const fa = ask('Should I bet Bijan Robinson over 84.5 rushing yards?', { boards: { nfl: FXB, cfb: otherBoard() } });
    const fvv = EDP.factoryView(fr.fx, FXB.factory, cand.line, cand.side, cand.american);
    ok('a joined factory projection is stated beside the decision, priced at the same line and price', fa.out && fa.out.text.indexOf('The validated model (walk-forward, skill in every fold) has ' + (cand.side === 'over' ? 'Over' : 'Under') + ' ' + cand.line + ' at ' + (100 * fvv.p_side).toFixed(1) + '%') >= 0
      && /evidence beside the decision, not the decision/.test(fa.out.text) && fa.out.evaluation.decision === page.decision, fa.out && fa.out.text);
    ok('…and the critic accepts every number in it', K.critic(fa.out.text, fa.out).ok !== false);
    ok('without a joined projection the answer does not mention it', a.out.text.indexOf('validated model') < 0);
  }

  /* a named quote at an exact price is priced on the same distribution */
  const b = ask('Research Bijan Robinson rushing yards under 84.5 -108');
  const pr = EDP.probLine(page._dist.informed, 84.5), d0 = EDP.toDecimal(-108);
  const evq = pr.under * (d0 - 1) - (1 - pr.under - pr.push);
  ok('a quote the reader names is priced as given, at the exact price', b.out.text.indexOf('Your quote, Under 84.5 −108') >= 0 && b.out.text.indexOf('EV ' + (evq >= 0 ? '+' : '−') + Math.abs(100 * evq).toFixed(1) + '%') >= 0, b.out.text);
  const dealt = row.q.map((q) => q[1]);
  const free = [93.5, 94.5, 95.5, 96.5, 97.5].find((l) => dealt.indexOf(l) < 0);
  const c = ask('Should I bet Bijan Robinson over ' + free + ' rushing yards?');
  ok('a line nobody deals, with no price given, is not priced (never −110)', /No captured book deals Over/.test(c.out.text) && /never assumes −110/.test(c.out.text) && c.out.text.indexOf('Your quote') < 0, c.out.text);
  const d = ask('Should I bet Bijan Robinson over 84.5 rushing yards?', { now: NOW + 3 * 3600e3 });
  ok('three hours later every price is stale: NO DECISION, and no stale price is reused', d.out.evaluation.decision === 'NO_DECISION' && /inside the 30-minute execution window/.test(d.out.text)
    && /past the execution window/.test(d.out.text) && d.out.text.indexOf('Your quote') < 0 && d.out.text.indexOf('Best value') < 0, d.out.text);

  /* projection only */
  const unpriced = NFL.props.find((r) => r.p && !r.q.length && r.x && r.x.dist && !(EDP.MARKETS[r.m] || {}).yesno && NFL.players[r.p + '@' + r.g] && NFL.props.filter((x) => x.p === r.p && x.m === r.m).length === 1);
  const who = NFL.players[unpriced.p + '@' + unpriced.g].name;
  const e = ask('What is ' + who + '\'s fair line for ' + EDP.MARKETS[unpriced.m].label.toLowerCase() + '?');
  ok('an unpriced prop is projection only: a fair line, no EV, no decision, no "why" against a line nobody posted', e.out && e.out.intent === 'PROP' && /fair line/.test(e.out.text) && /No sportsbook price is captured/.test(e.out.text)
    && !/Best value|EdgeDesk decision|Why (over|under)/.test(e.out.text), [who, unpriced.m, e.out && e.out.text]);

  /* COMPARE */
  const f = ask('Is Bijan 71.5 -110 or 74.5 +105 better?');
  const p1 = EDP.probLine(page._dist.informed, 71.5), p2 = EDP.probLine(page._dist.informed, 74.5);
  const ev1 = p1.over * (EDP.toDecimal(-110) - 1) - (1 - p1.over - p1.push), ev2 = p2.over * (EDP.toDecimal(105) - 1) - (1 - p2.over - p2.push);
  ok('COMPARE: both quotes priced on one distribution; the higher EV named', f.cls.intent === 'COMPARE' && new RegExp('The ' + (ev1 >= ev2 ? 'first' : 'second') + ' has the higher EV').test(f.out.text), f.out && f.out.text);
  ok('COMPARE: no side named → read as Overs, and said', /read as Overs/.test(f.out.text));
  ok('COMPARE: a missing price is asked for, never assumed', /never assumes −110/.test(ask('Is Bijan over 71.5 or over 74.5 +105 better?').out.text));
  ok('a unique first name ("Bijan") names the player', f.cls.players.players.length === 1 && f.cls.players.players[0].pid === BIJAN);

  /* PLAYER */
  const g = ask('What does EdgeDesk project for Drake London?');
  const lrows = NFL.props.filter((r) => r.p === LONDON && r.g === GID);
  ok('PLAYER: every market he is priced in, each with the page\'s decision', g.cls.intent === 'PLAYER' && lrows.every((r) => g.out.text.indexOf(EDP.MARKETS[r.m].label + ':') >= 0)
    && lrows.filter((r) => r.q.length).every((r) => g.out.text.indexOf(EDP.boardEval(NFL, r, NOW).decision_label) >= 0), g.out && g.out.text);

  /* BOARD */
  const h = ask('Best player props today?');
  const ranked = NFL.props.filter((r) => r.q.length && r.p).map((r) => ({ r, ev: EDP.boardEval(NFL, r, NOW) })).filter((x) => (x.ev.decision === 'BET' || x.ev.decision === 'LEAN') && x.ev.candidate)
    .sort((x, y) => (y.ev.value_score || 0) - (x.ev.value_score || 0));
  const top = NFL.players[ranked[0].r.p + '@' + ranked[0].r.g].name;
  ok('BOARD: the props that clear a threshold, ranked by value score', h.cls.intent === 'BOARD' && h.out.text.indexOf(top) > 0 && h.out.text.indexOf(top) < h.out.text.indexOf(';'), h.out && h.out.text);
  ok('BOARD: a PASS never appears among the leads, an EXPERIMENTAL lead carries no units', !/\(PASS/.test(h.out.text) && !/LEAN \d/.test(h.out.text) && /never carries units/.test(h.out.text));
  const bare = clone(NFL); bare.props.forEach((r) => { r.q = []; });
  const i = ask('Any NFL props worth a look?', { boards: { nfl: bare } });
  ok('BOARD with no captured prices: said, nothing ranked', /No sportsbook player-prop prices are captured for NFL/.test(i.out.text) && !/ranked/.test(i.out.text), i.out.text);

  /* INJURY */
  const j = ask('How does Drake London being out affect Bijan Robinson rushing yards?');
  ok('INJURY: a player the board does not list as out moves nothing, and it says so', j.cls.intent === 'INJURY' && /does not treat Drake London as out/.test(j.out.text), j.out && j.out.text);
  const hurt = clone(NFL); const bk = BIJAN + '@' + GID;
  hurt.players[bk].teammates_out = [{ id: LONDON, name: 'Drake London', pos: 'WR', status: 'OUT', delta: 0.031, label: 'target share' }];
  const k = ask('How does Drake London being out affect Bijan Robinson rushing yards?', { boards: { nfl: hurt, cfb: otherBoard() } });
  ok('INJURY: an absence the projection carries is quoted from the board, not estimated', /already carries \+3\.1% target share/.test(k.out.text), k.out.text);

  /* names and markets */
  const l = ask('Robinson receiving yards?');
  ok('an ambiguous surname is asked back, never guessed', l.out.intent === 'AMBIGUOUS' && /Bijan Robinson/.test(l.out.text) && /Jalen Robinson/.test(l.out.text), l.out);
  const m = ask('Bijan Robinson passing yards');
  ok('a market EdgeDesk does not price for him is said', /no current passing yards projection for Bijan Robinson/.test(m.out.text), m.out.text);
  const n = ask('How many sacks will Bijan Robinson have?');
  ok('a market EdgeDesk does not project anywhere is said, never estimated', /does not project sacks props/.test(n.out.text), n.out.text);
  ok('a game question is not the props desk', ask('Who wins Falcons at Saints?').cls === null && ask('What is the spread for Texas State?').cls === null && ask('Will the Falcons cover?').cls === null);
  ok('an everyday first name is never a player', !K.playersIn('Will the total go over 44.5?', BOARDS).players.length);

  /* critic */
  ok('critic: the deterministic answer passes its own critic', K.critic(a.out.text, a.out).verdict === 'PASS', K.critic(a.out.text, a.out));
  ok('critic: an added number fails', K.critic('Bijan over 84.5 is a strong play at 71%.', a.out).findings.some((x) => x.code === 'NUMBER_NOT_IN_ANSWER'));
  ok('critic: "lock" and "best bet" fail', K.critic('This is a lock and our best bet.', a.out).findings.some((x) => x.code === 'BANNED_WORD'));
  ok('critic: certainty fails', K.critic('Bijan will clear 84.5.', a.out).findings.some((x) => x.code === 'CERTAINTY'));
  ok('no answer anywhere uses a banned word', [a, b, c, d, e, f, g, h, i, j, k, l, m, n].every((r) => !/\b(lock|best bet|safe bet|guarantee)/i.test(r.out.text)));

  /* ============================================================= HANDLER */
  const SITE = 'https://site.test';
  const ENV = { EDGEDESK_AI_NO_SERVE: '1', ANTHROPIC_API_KEY: 'test-key', SUPABASE_URL: 'https://sb.test', SUPABASE_ANON_KEY: 'anon-key', EDGEDESK_SITE_BASE: SITE };
  globalThis.Deno = { env: { get: (x) => ENV[x] } };
  let FILES = { '/football/props/nfl/board.json': NFL, '/football/props/cfb/board.json': otherBoard() };
  let modelCalls = 0; const boardReads = [];
  globalThis.fetch = async function (url, init) {
    const s = String(url);
    if (s.indexOf('api.anthropic.com') >= 0) { modelCalls++; return { ok: true, status: 200, json: async () => ({ model: 'test', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }), text: async () => 'ok' }; }
    if (s.indexOf(SITE) === 0) {
      const p = s.slice(SITE.length).split('?')[0];
      if (/\/football\/props\//.test(p)) boardReads.push(p);
      const dd = FILES[p];
      if (dd === undefined) return { ok: false, status: 404, text: async () => 'not found', json: async () => null };
      return { ok: true, status: 200, text: async () => JSON.stringify(dd), json: async () => clone(dd) };
    }
    if (init && init.method === 'HEAD') return { ok: true, status: 200, headers: { get: () => '*/0' }, text: async () => '' };
    if (s.indexOf('sb.test') >= 0 && s.indexOf('/subscriptions') >= 0) {
      const sub = [{ status: 'active', price_id: 'price_test', current_period_end: new Date(Date.now() + 30 * 864e5).toISOString() }];
      return { ok: true, status: 200, text: async () => JSON.stringify(sub), json: async () => sub };
    }
    if (s.indexOf('sb.test') >= 0) return { ok: true, status: 200, text: async () => '[]', json: async () => [] };
    return { ok: false, status: 404, text: async () => 'nope', json: async () => null };
  };
  const mod = await import(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', 'index.ts'));
  ok('the edge function exports propsTurn', typeof mod.propsTurn === 'function');
  async function handle(question, desk) {
    mod.clearCache(); mod.resetRateLimit(); if (mod.clearInvestigationCache) mod.clearInvestigationCache();
    const body = { mode: 'chat', question, packet: null, history: [], research_context: null };
    if (desk) body.desk = true;
    const r = await mod.handle(new Request('https://fn.test/edgedesk_ai', { method: 'POST', headers: { authorization: 'Bearer user-jwt', 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    return { status: r.status, j: await r.json() };
  }
  /* propsTurn runs at the real clock, so it is called with the fixture's */
  const direct = await mod.propsTurn({ body: { question: 'Should I bet Bijan Robinson over 84.5 rushing yards?' }, auth: 'Bearer x', now: NOW });
  ok('propsTurn: the deterministic answer, the board\'s decision and its sources', direct && direct.desk.intent === 'PROPS' && direct.answer === a.out.text && direct.props.decision.decision === row.e.d
    && direct.props.row.player_id === BIJAN && direct.props.row.market === 'rush_yds' && direct.props.sources.indexOf('football/props/nfl/board.json') >= 0 && direct.answer === direct.deterministic_desk_answer, direct && direct.props);
  ok('propsTurn: the stage and the probability source travel with the decision', direct.props.decision.stage === (NFL.stages.rush_yds || {}).stage && /MODEL/.test(direct.props.decision.probability_label || ''), direct.props.decision);
  ok('propsTurn: no model is called without EDGEDESK_PROPS_NARRATE', direct.model === null && direct.narration.prose === 'DETERMINISTIC');
  ok('propsTurn: the game is carried forward for follow-ups', direct.research && direct.research.research_context.game_id === GID && direct.research.research_context.sport === 'americanfootball_nfl', direct.research);

  const before = modelCalls;
  const h1 = await handle('What does EdgeDesk project for Drake London?', true);
  ok('handler: a desk client gets the props answer', h1.status === 200 && h1.j.desk && h1.j.desk.intent === 'PROPS' && /^Drake London/.test(h1.j.answer), h1.j.answer || h1.j.error);
  const h2 = await handle('How many sacks will Bijan Robinson have?', false);
  ok('handler: a chat client gets it too (a prop question never reaches the model to be invented)', h2.status === 200 && h2.j.desk && h2.j.desk.intent === 'PROPS' && /does not project sacks props/.test(h2.j.answer), h2.j.answer || h2.j.error);
  ok('handler: neither spent a model call', modelCalls === before, modelCalls - before);
  const h3 = await handle('Who wins Falcons at Saints?', true);
  ok('handler: a game question falls through to the desk and the pipeline', !(h3.j.desk && h3.j.desk.intent === 'PROPS'), h3.j.desk && h3.j.desk.intent);
  boardReads.length = 0;
  await handle('Is Drake London out this week?', true);
  ok('handler: a plain injury question reads no prop board', boardReads.length === 0, boardReads);
  FILES = {};
  const h5 = await handle('Should I bet Bijan Robinson over 84.5 rushing yards?', true);
  ok('handler: with no board to read, a prop question falls through rather than being answered from nothing', !(h5.j.desk && h5.j.desk.intent === 'PROPS'), h5.j.desk && h5.j.desk.intent);

  console.log((fail ? 'FAIL' : 'PASS') + ' | player props desk | ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
