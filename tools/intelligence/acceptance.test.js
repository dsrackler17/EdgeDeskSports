#!/usr/bin/env node
/* ===========================================================================
   THE ACCEPTANCE CONVERSATION, RUN THROUGH THE REAL REQUEST HANDLER.

   Every message below is one a customer actually sent, in the order they sent
   it, against the shape production was in when it failed: an MLB board open, an
   MLB signal loaded, and a question about a college football team.

   What production did with the first of them:
       intent = unknown
       retrieval scoped to baseball_mlb
       "Texas State" unresolved; "texas" resolved to the Texas Rangers
       MLB pitcher, bullpen and offense evidence
       a long explanation that no college football module was queried
       an unrelated Padres-Rockies decision card
       a raw error about public.recommendation_ledger

   THE ANSWERS ARE NOT HARDCODED. Nothing here asserts a spread, a lean or a
   sentence about Texas State. What is asserted is that the question routed to
   the right sport, resolved to the right canonical game, retrieved from that
   sport's sources, and showed the reader nothing belonging to another game.
   A second block runs the same assertions over OTHER matchups drawn from the
   real published card — including the two Miamis, which share a name — so a
   fix that only works for Texas State fails here.

   The slate is the REAL committed artifact. The database is fixtures, because
   this repository has no live Supabase; which live checks that leaves
   unverified is stated in docs/intelligence.md.

   Run: node tools/intelligence/acceptance.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const fs = require('fs');
const FX = require('./fixtures.js');
const ROOT = path.join(__dirname, '..', '..');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push({ name, detail }); }
function eq(name, got, want) { chk(name, got === want, { got, want }); }
function done() {
  failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 400) : '')));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

/* ---- the environment the function expects ------------------------------ */
const ENV = {
  EDGEDESK_AI_NO_SERVE: '1', ANTHROPIC_API_KEY: 'test-key',
  SUPABASE_URL: 'https://sb.test', SUPABASE_ANON_KEY: 'anon-key',
  EDGEDESK_SITE_BASE: 'https://site.test',
};
globalThis.Deno = { env: { get: (k) => ENV[k] } };

let route = () => [];
let modelStatus = 200;            // flip to exercise an unavailable AI endpoint
let ledgerStatus = 201;           // flip to exercise an unavailable ledger
globalThis.fetch = async function (url, init) {
  const u = String(url);
  if (u.indexOf('api.anthropic.com') >= 0) {
    if (modelStatus !== 200) return { ok: false, status: modelStatus, text: async () => 'upstream down', json: async () => null };
    return { ok: true, status: 200, json: async () => ({ model: 'test', content: [{ type: 'text', text: 'ok' }] }), text: async () => 'ok' };
  }
  if (init && init.method === 'POST' && u.indexOf('recommendation_ledger') >= 0) {
    return { ok: ledgerStatus < 300, status: ledgerStatus,
      text: async () => (ledgerStatus < 300 ? '' : '{"message":"relation \\"public.recommendation_ledger\\" does not exist","code":"42P01"}'),
      json: async () => [] };
  }
  if (init && init.method === 'POST' && u.indexOf('sb.test') >= 0) return { ok: true, status: 201, text: async () => '', json: async () => [] };
  if (init && init.method === 'HEAD') return { ok: true, status: 200, headers: { get: () => '*/0' }, text: async () => '' };
  const d = route(u, init);
  if (d === null) return { ok: false, status: 404, text: async () => 'nope', json: async () => null };
  return { ok: true, status: 200, text: async () => JSON.stringify(d), json: async () => d };
};

/* THE BOARD THE READER HAS OPEN, and the signal loaded on it. This is the
   production shape: a baseball game in front of them, a football question in
   the box. Both are deliberately present — the packet is what produced the
   unrelated decision card, and the board scope is what produced the sport. */
const MLB_BOARD = { sport: 'baseball_mlb', label: 'today' };
const MLB_PACKET = {
  game: { matchup: 'San Diego Padres @ Colorado Rockies', sport: 'MLB', sport_key: 'baseball_mlb',
    away: 'San Diego Padres', home: 'Colorado Rockies', event_id: 'mlb-evt-1' },
  market: 'spreads', market_key: 'spreads', selection: 'San Diego Padres -1.5',
  prices: { detect: -110, current: -105, fair: -125, book: 'DraftKings' },
  price_sensitivity: { breakeven: -118, max_playable: -112 },
  deterministic: { verdict: 'BET', display_verdict: 'BET CANDIDATE', confidence: 'HIGH', score: 81,
    why: 'priced through the fair number', reasons_for: ['a'], reasons_against: [], falsifiers: [] },
};

(async function main() {
  const m = await import(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', 'index.ts'));
  const fx = FX.build();

  /* One conversation: the client's own contract, including the resolved
     subject the panel hands back on the next turn. */
  function conversation(opts) {
    opts = opts || {};
    const history = [];
    let carried = null;
    return async function ask(question, over) {
      m.clearCache();
      route = FX.router(fx, (over && over.rows) || {});
      const body = {
        mode: (over && over.mode) || 'chat', question,
        packet: Object.assign({}, opts.packet || {}, { board_scope: (over && over.board) || opts.board || MLB_BOARD }),
        history: history.slice(-8),
        research_context: carried,
      };
      const r = await m.handle(new Request('https://fn.test/edgedesk_ai' + ((over && over.qs) || '?dry=1'), {
        method: 'POST', headers: { authorization: 'Bearer user-jwt', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }));
      const j = await r.json();
      const rc = j.research_context || (j.research && j.research.research_context) || null;
      if (rc && rc.game_id) {
        carried = { sport: rc.sport, game_id: rc.game_id, home: rc.home, away: rc.away,
          home_id: rc.home_id, away_id: rc.away_id };
      }
      history.push({ role: 'user', content: question });
      history.push({ role: 'assistant', content: (j.answer || 'researched') });
      j.__status = r.status;
      return j;
    };
  }

  /* Shared assertions. Called for Texas State AND for every generalisation
     matchup, so nothing below can pass by knowing one answer. */
  function assertsFor(label, j, want) {
    const c = j.research_context || {};
    eq(`${label}: routed to college football, not the open MLB board`, j.sport, 'americanfootball_ncaaf');
    eq(`${label}: resolved to the canonical game id`, c.game_id, want.game_id);
    chk(`${label}: resolved both canonical team ids`,
      c.away_id === want.away_id && c.home_id === want.home_id, { got: [c.away_id, c.home_id], want: [want.away_id, want.home_id] });
    /* THE RETRIEVAL, NOT JUST THE LABEL. Production reported the right sport in
       one field while reading MLB tables in another. */
    eq(`${label}: the slate index was built for college football`,
      j.data_path.slate_index && j.data_path.slate_index.sport, 'americanfootball_ncaaf');
    const steps = (j.intent && j.intent.steps) || [];
    chk(`${label}: no baseball retrieval layer executed`,
      !steps.some((s) => /pitcher|bullpen|park|workload|opponent_offense/.test(s)), steps);
    chk(`${label}: a college football layer did`,
      steps.some((s) => /^cfb_|matchup_context/.test(s)), steps);
    /* NO UNRELATED DECISION CARDS. */
    const decisions = j.decisions || [];
    chk(`${label}: every decision shown is about the game that was asked about`,
      decisions.every((d) => !d.game_id || String(d.game_id) === String(want.game_id)),
      decisions.map((d) => [d.game_id, d.matchup]));
    chk(`${label}: no baseball club appears in any decision`,
      !/Padres|Rockies|Rangers|Yankees|Orioles/.test(JSON.stringify(decisions)), decisions.map((d) => d.matchup));
    /* The card the panel renders is withheld too, not merely unmentioned. */
    chk(`${label}: the unrelated open selection produces no decision card`,
      !j.presentation || !/Padres|Rockies/.test(JSON.stringify(j.presentation)),
      j.presentation && j.presentation.simple && j.presentation.simple.headline);
    /* NOTHING FROM THE OTHER GAME REACHES THE MODEL EITHER. */
    const p = j.prompt || '';
    chk(`${label}: the open baseball selection is not in the prompt`, !/Padres|Rockies/.test(p));
    /* THE ALIAS TRAP, ASSERTED ON THE RIGHT PROPERTY.
       "Texas State" reaches the TEXAS RANGERS through the MLB alias "texas",
       and that is what production researched. The fix is not that the club is
       never named — naming what was REJECTED is how a reader can tell the trap
       was caught — it is that the club is never an entity. So: not in scope,
       never RESOLVED, and any mention is inside a rejection. */
    chk(`${label}: no baseball club is in the entity scope`,
      !(j.entities && j.entities.teams || []).some((t) => /Rangers|Astros|Padres|Rockies|Yankees/.test(t)),
      j.entities && j.entities.teams);
    chk(`${label}: and none is RESOLVED by the identity layer`,
      !(j.identity || []).some((i) => i.status === 'RESOLVED' && /Rangers|Astros|Padres|Rockies/.test(i.canonical_name || '')),
      (j.identity || []).map((i) => [i.query, i.status, i.canonical_name]));
    chk(`${label}: the cross-league alias is recorded as rejected, not used`,
      !/Texas Rangers/.test(p) || /rejected[^]{0,120}Texas Rangers/.test(p),
      p.slice(Math.max(0, p.indexOf('Texas Rangers') - 140), p.indexOf('Texas Rangers') + 60));
  }

  /* =====================================================================
     1. THE REPORTED CONVERSATION, EXACTLY AS IT WAS ASKED.
     ===================================================================== */
  const TXST = { game_id: '401858900', away_id: 'northtexas', home_id: 'texasstate' };
  {
    const ask = conversation({ packet: MLB_PACKET });

    const t1 = await ask('How does Texas State look this week?');
    assertsFor('turn 1', t1, TXST);
    chk('turn 1: the question is classified, not dumped on the unknown catch-all',
      t1.intent.intent !== 'unknown', t1.intent);
    chk('turn 1: and the trace says WHY this sport was chosen',
      /resolved against the published card/.test((t1.research_context || {}).sport_source || ''),
      (t1.research_context || {}).sport_source);
    chk('turn 1: the plan was rebuilt rather than left in baseball',
      !!t1.data_path.replan && t1.data_path.replan.from.intent === 'unknown', t1.data_path.replan);

    /* THE FOLLOW-UPS. Each one names no team at all. */
    const t2 = await ask('Who have they played?');
    assertsFor('turn 2 (who have they played)', t2, TXST);
    chk('turn 2: the subject was CARRIED, not re-guessed from the board',
      (t2.research_context || {}).carried === true, t2.research_context);
    chk('turn 2: previous games were actually retrieved',
      (t2.evidence_packets || []).some((pk) => {
        const prev = pk && pk.sections && pk.sections.matchup;
        return prev && JSON.stringify(prev).indexOf('previous_games') >= 0;
      }), (t2.evidence_packets || []).length);

    const t3 = await ask('Were those teams any good?');
    assertsFor('turn 3 (opponent quality)', t3, TXST);

    const t4 = await ask("What's the line?");
    assertsFor('turn 4 (the line)', t4, TXST);

    const t5 = await ask('What could make that lean wrong?');
    assertsFor('turn 5 (counterargument)', t5, TXST);
    eq('turn 5: a counterargument question is a thesis attack', t5.intent.intent, 'attack');
    chk('turn 5: and it retrieves what could break the thesis',
      ((t5.intent && t5.intent.steps) || []).indexOf('sharp_reference') >= 0, t5.intent.steps);
  }

  /* =====================================================================
     2. THE SECOND REPORTED QUESTION, WITH "Anything" IN IT.
     "Anything worth betting?" made "Anything" an unresolved entity.
     ===================================================================== */
  {
    const ask = conversation({ packet: MLB_PACKET });
    const j = await ask('What do you think about North Texas vs Texas State this week? Anything worth betting?');
    assertsFor('two-name matchup', j, TXST);
    const named = ((j.research_context || {}).teams) || [];
    chk('an ordinary word is never extracted as a team',
      !named.some((t) => /^(Anything|Anyone|Something|Thoughts|What)$/i.test(t)), named);
    chk('and no identity row claims one either',
      !(j.identity || []).some((i) => /^anything$/i.test(String(i.query || ''))), j.identity);

    /* THE TOPIC SWITCH. A different game, named explicitly. */
    const sw = await ask('What about Miami vs Wake Forest?');
    assertsFor('topic switch', sw, { game_id: '401858226', away_id: 'miami', home_id: 'wakeforest' });
    chk('the previous subject does not survive an explicit topic change',
      !/Texas State/.test(JSON.stringify(sw.decisions || [])), sw.decisions);
    chk('and the two Miamis are not confused — Miami (OH) is on this same card',
      (sw.research_context || {}).home_id !== 'miamioh'
      && (sw.research_context || {}).away_id !== 'miamioh', sw.research_context);
  }

  /* =====================================================================
     3. GENERALISATION. The same assertions, other programs, real card.
     ===================================================================== */
  {
    /* Drawn from the card these fixtures actually publish, and chosen for the
       traps rather than for the easy cases:
         Texas Tech   contains "Texas", the MLB alias that started all of this
         Arkansas     collides with Arkansas State in the curated registry
         Oregon       collides with Oregon State
         Pittsburgh   is a city token shared with a baseball club
         Houston      likewise, and is the AWAY side rather than the home one */
    const CASES = [
      { q: 'How does Texas Tech look this week?', game_id: '401856811', away_id: 'houston', home_id: 'texastech' },
      { q: 'What do you think about Georgia vs Arkansas?', game_id: '401856686', away_id: 'georgia', home_id: 'arkansas' },
      { q: 'Anything worth knowing about Oregon this week?', game_id: '401858455', away_id: 'portlandstate', home_id: 'oregon' },
      { q: 'What about Syracuse vs Pittsburgh?', game_id: '401858225', away_id: 'syracuse', home_id: 'pittsburgh' },
      { q: 'How does Houston look this week?', game_id: '401856811', away_id: 'houston', home_id: 'texastech' },
    ];
    for (const c of CASES) {
      const ask = conversation({ packet: MLB_PACKET });
      const j = await ask(c.q);
      assertsFor(`generalises: "${c.q}"`, j, c);
    }
  }

  /* =====================================================================
     4. THE MLB PATH IS UNCHANGED. The regression requirement.
     ===================================================================== */
  {
    const ask = conversation({ packet: MLB_PACKET });
    const j = await ask('Who are the worst pitchers on the board tonight?');
    eq('a genuine baseball question still routes to baseball', j.sport, 'baseball_mlb');
    eq('and keeps its own intent', j.intent.intent, 'worst_pitchers');
    chk('and still retrieves the pitching layer',
      ((j.intent && j.intent.steps) || []).indexOf('pitcher_features') >= 0, j.intent.steps);
    chk('and the open baseball selection IS authoritative here',
      /CLIENT PACKET/.test(j.prompt || ''));
  }

  /* =====================================================================
     5. EXPLICIT SPORT SWITCHING, IN BOTH DIRECTIONS.
     ===================================================================== */
  {
    const ask = conversation({ packet: MLB_PACKET });
    const a = await ask('What about Texas State this week?');
    eq('football first', a.sport, 'americanfootball_ncaaf');
    const b = await ask('Forget that — what do the MLB pitching matchups look like tonight?');
    eq('an explicit league word switches back to baseball', b.sport, 'baseball_mlb');
    chk('and the football subject is not dragged along',
      !/Texas State/.test(JSON.stringify(b.decisions || [])), b.decisions);
    const c = await ask('OK, back to college football — anything on Wake Forest?');
    eq('and switches forward again', c.sport, 'americanfootball_ncaaf');
  }

  /* =====================================================================
     6. AMBIGUITY IS ASKED ABOUT, NEVER GUESSED, AND NEVER DEFAULTED TO MLB.
     ===================================================================== */
  {
    const ask = conversation({ packet: MLB_PACKET });
    /* A BARE SCHOOL NAME, WITH A BASEBALL BOARD OPEN AND A BASEBALL SIGNAL
       LOADED. Before, this resolved to nothing and the sport was then taken
       from the open tab — a college question answered as a baseball one, in
       silence. The sport must come from the card the school is on. */
    const j = await ask('How about Oregon?');
    eq('a bare school name settles the sport from the card, not the open board',
      j.sport, 'americanfootball_ncaaf');
    chk('and it never silently becomes a baseball question about the open board',
      !/Padres|Rockies/.test(j.prompt || ''));

    /* AND WHEN THE SCHOOL IS ON THE CARD TWICE, THE GAME STAYS UNRESOLVED.
       Asserted through the resolver directly, because which programs play
       twice in a window depends on the card. */
    const twice = m.bareTeamWords('How about Oregon?');
    chk('a bare word is offered to the card resolver at all', twice.indexOf('Oregon') >= 0, twice);
    chk('and ordinary words are not', m.bareTeamWords('Anything worth betting?').length === 0,
      m.bareTeamWords('Anything worth betting?'));
  }

  /* =====================================================================
     7. THE FAILURE MODES, EACH KEPT APART FROM THE OTHERS.
     ===================================================================== */
  {
    /* (a) A NAMED MATCHUP THAT IS ON NO CARD is not an unknown team. */
    const ask = conversation({ packet: MLB_PACKET });
    const j = await ask('What do you think about Texas State vs Boise State this week?');
    const nm = j.data_path.named_matchup || {};
    eq('a matchup on no card is reported as exactly that', nm.state, 'NOT_ON_ANY_CARD');
    chk('and the answer is forbidden from substituting another game',
      /do NOT fall back|Do NOT answer about a different game/i.test(nm.note || ''), nm.note);
    chk('and no decision from some other game is shown in its place',
      !(j.decisions || []).length, j.decisions);
  }
  {
    /* (b) A SCHEDULE THAT CANNOT BE READ is not an empty schedule. */
    const ask = conversation({ packet: MLB_PACKET });
    const j = await ask('What do you think about North Texas vs Texas State?', {
      rows: {}, });
    /* routed through a router that 404s the artifact */
    m.clearCache();
    route = (u) => (u.indexOf('/football/fbs/slate.json') >= 0 ? null : []);
    const r2 = await m.handle(new Request('https://fn.test/edgedesk_ai?dry=1', {
      method: 'POST', headers: { authorization: 'Bearer u', 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'chat', question: 'What do you think about North Texas vs Texas State?',
        packet: { board_scope: MLB_BOARD }, history: [] }),
    }));
    const j2 = await r2.json();
    const nm2 = j2.data_path.named_matchup || {};
    eq('a source that cannot be read is a retrieval failure', nm2.state, 'RETRIEVAL_FAILED');
    chk('and is explicitly NOT a finding that the game does not exist',
      /RETRIEVAL failure, not a finding that the matchup is absent/i.test(nm2.note || ''), nm2.note);
  }
  {
    /* (c) THE AI ENDPOINT IS DOWN. The research must still reach the client. */
    modelStatus = 503;
    m.clearCache(); route = FX.router(fx, {});
    const r = await m.handle(new Request('https://fn.test/edgedesk_ai', {
      method: 'POST', headers: { authorization: 'Bearer u', 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'chat', question: 'How does Texas State look this week?',
        packet: Object.assign({}, MLB_PACKET, { board_scope: MLB_BOARD }), history: [] }),
    }));
    const j = await r.json();
    modelStatus = 200;
    eq('a model outage is reported as one', r.status, 502);
    chk('and the research still travels with it', !!j.research, Object.keys(j));
    chk('including the resolved scope, so the panel can render the right facts',
      j.research && j.research.research_context && j.research.research_context.game_id === TXST.game_id,
      j.research && j.research.research_context);
    chk('and the decisions it already computed',
      !!(j.research && j.research.decisions), j.research && (j.research.decisions || []).length);
    chk('the narration failure is named as retryable', j.narration && j.narration.retryable === true, j.narration);
    chk('no analyst opinion is fabricated in its place', j.answer === null, j.answer);
    chk('and no unrelated decision card rides along',
      !/Padres|Rockies/.test(JSON.stringify(j.research || {})));
  }
  {
    /* (d) THE LEDGER IS UNAVAILABLE. Research survives; SQL does not leak. */
    ledgerStatus = 404;
    m.clearCache(); route = FX.router(fx, {});
    const r = await m.handle(new Request('https://fn.test/edgedesk_ai', {
      method: 'POST', headers: { authorization: 'Bearer u', 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'chat', question: 'What do you think about North Texas vs Texas State this week?',
        packet: { board_scope: MLB_BOARD }, history: [] }),
    }));
    const j = await r.json();
    ledgerStatus = 201;
    chk('the answer is still produced when tracking fails',
      typeof j.answer === 'string' && j.answer.length > 0, j.error);
    const L = j.ledger || {};
    chk('tracking reports itself unavailable', /[Tt]racking is unavailable/.test(L.notice || ''), L.notice);
    chk('it never claims the decision was recorded', L.state !== 'RECORDED', L.state);
    /* THE LINE THE REPORTED FAILURE ENDED ON. */
    chk('and no database text reaches the customer',
      !/recommendation_ledger|relation |does not exist|schema cache|42P01|HTTP \d{3}/i.test(JSON.stringify(L)),
      L);
    chk('the raw detail is withheld from the response entirely', L.detail === null || L.detail === undefined, L.detail);
    chk('while telling the operator a diagnostic exists', L.diagnostic_available === true, L);
  }

  /* =====================================================================
     8. NO SECRETS, NO BACKEND INTERNALS, NO FABRICATED DATA.
     ===================================================================== */
  {
    m.clearCache(); route = FX.router(fx, {});
    const r = await m.handle(new Request('https://fn.test/edgedesk_ai?dry=1', {
      method: 'POST', headers: { authorization: 'Bearer u', 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'chat', question: 'How does Texas State look this week?',
        packet: Object.assign({}, MLB_PACKET, { board_scope: MLB_BOARD }), history: [] }),
    }));
    const j = await r.json();
    const blob = JSON.stringify(j);
    chk('no API key is echoed anywhere in the response', blob.indexOf('test-key') < 0);
    chk('no anon key is echoed either', blob.indexOf('anon-key') < 0);
    chk('no caller JWT is echoed', blob.indexOf('user-jwt') < 0 && blob.indexOf('Bearer u') < 0);
    chk('no PostgREST url is narrated to the reader', !/sb\.test\/rest\/v1/.test(j.prompt || ''));

    /* THE MODEL VALIDATION CEILING IS PRESERVED. A CFB spread may not become a
       validated edge just because the routing now works. */
    /* THE CEILING, STATED AS THE REGISTRY STATES IT. A college football spread
       may still reach BET CANDIDATE on a MARKET-anchored edge — a real price,
       a sharp reference and independent books — because that evidence is the
       market. What it may never do is derive one from the model: against the
       close the model does not beat it and gets worse as it disagrees more. So
       the assertion is about the MODEL's contribution, not about the verdict. */
    const dec = (j.decisions || []);
    chk('a CFB spread model produces no win probability',
      dec.every((d) => d.market !== 'spreads' || !d.model || d.model.win_probability == null),
      dec.map((d) => [d.market, d.model && d.model.win_probability]));
    chk('and no model EV',
      dec.every((d) => d.market !== 'spreads' || !d.model || d.model.model_ev == null),
      dec.map((d) => [d.market, d.model && d.model.model_ev]));
    chk('and is registered as not permitted to produce one',
      dec.every((d) => d.market !== 'spreads' || !d.model || d.model.may_produce_model_ev === false),
      dec.map((d) => [d.market, d.model && d.model.may_produce_model_ev]));
    chk('at the RESEARCH validation tier the registry records',
      dec.every((d) => d.market !== 'spreads' || !d.model || d.model.validation_tier === 'RESEARCH'),
      dec.map((d) => [d.market, d.model && d.model.validation_tier]));
    chk('and the spread model is declared as producing no probability',
      /RESEARCH|no validated outcome probability|contributes no expected value/i.test(j.prompt || ''));

    /* FABRICATION. Metrics the sport does not carry must be declared missing
       rather than invented. */
    const pk = (j.evidence_packets || [])[0];
    if (pk) {
      const s = JSON.stringify(pk);
      chk('per-play efficiency is declared missing, not invented',
        !/"success_rate":\s*[0-9]/.test(s) && !/"pressure_rate":\s*[0-9]/.test(s), 'a numeric value appeared');
      chk('and availability is UNKNOWN rather than healthy',
        !/no reported injuries|clean bill|fully healthy/i.test(s));
    }
  }

  /* =====================================================================
     9. THE GUARD ITSELF: a cross-game decision is WITHHELD, not merely absent.
     ===================================================================== */
  {
    const ctx = {
      sport: 'americanfootball_ncaaf', single_game: true, game_id: '401858900',
      home: 'Texas State', away: 'North Texas', home_id: 'texasstate', away_id: 'northtexas',
      team_ids: ['northtexas', 'texasstate'], team_names: ['North Texas', 'Texas State'],
      kickoff: null, sport_source: 't', season: null, week: null, market: null, selection: null,
      resolution_source: 'x', ambiguity: null, carried: false,
    };
    chk('the resolved game matches itself', m.matchesContext(ctx, { game_id: '401858900' }));
    chk('a book\'s own team names still join to it',
      m.matchesContext(ctx, { matchup: 'North Texas Mean Green @ Texas State Bobcats' }));
    chk('another college game does not', !m.matchesContext(ctx, { matchup: 'Miami @ Wake Forest' }));
    chk('and neither does a baseball game', !m.matchesContext(ctx, { matchup: 'San Diego Padres @ Colorado Rockies' }));
    chk('a card-wide question filters nothing',
      m.matchesContext(Object.assign({}, ctx, { single_game: false }), { matchup: 'Miami @ Wake Forest' }));
  }

  /* =====================================================================
     10. COUNTERARGUMENT, BLOCKER AND NEXT CHECK ARE THREE DIFFERENT THINGS.
     They were one list, so "last re-priced 446m ago — treat as stale until
     capture confirms it" was served as an ARGUMENT AGAINST the lean. It is a
     gap in what EdgeDesk knows, and the sentence contains its own remedy.
     ===================================================================== */
  {
    m.clearCache(); route = FX.router(fx, {});
    const r = await m.handle(new Request('https://fn.test/edgedesk_ai?dry=1', {
      method: 'POST', headers: { authorization: 'Bearer u', 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'challenge', question: 'What could make that lean wrong?',
        packet: { board_scope: MLB_BOARD }, history: [],
        research_context: { sport: 'americanfootball_ncaaf', game_id: TXST.game_id,
          home: 'Texas State', away: 'North Texas', home_id: 'texasstate', away_id: 'northtexas' } }),
    }));
    const j = await r.json();
    const ta = j.thesis_attack || {};
    chk('the attack is split three ways, not served as one list',
      Array.isArray(ta.counterarguments) && Array.isArray(ta.blockers) && Array.isArray(ta.next_checks),
      Object.keys(ta));
    /* A blocker is about what EdgeDesk does not KNOW. A counterargument is
       about what it does know and what that evidence says. The assertion is on
       that distinction, not on a copy of the classifier's regex. */
    const isGap = (x) => /treat as stale until|no availability report|availability is partial|not ingested|cannot be TESTED|no fair price on file|has not arrived yet/i.test(x);
    chk('no stale-or-missing item is filed as a counterargument',
      (ta.counterarguments || []).every((x) => !isGap(x)), ta.counterarguments);
    chk('and every blocker is a gap in knowledge, not an argument',
      (ta.blockers || []).every(isGap), ta.blockers);
    chk('availability being UNKNOWN is a blocker, not evidence against the lean',
      !(ta.counterarguments || []).some((x) => /no availability report/i.test(x))
      && (ta.blockers || []).some((x) => /no availability report/i.test(x)),
      { counter: ta.counterarguments, blockers: ta.blockers });
    chk('an unvalidated model IS a counterargument — no refresh answers it',
      (ta.counterarguments || []).some((x) => /NO validated outcome probability|EXPERIMENTAL/i.test(x)),
      ta.counterarguments);
    chk('every next check names what it would resolve',
      (ta.next_checks || []).every((x) => /availability|price|fair price|ingest|per-play/i.test(x)), ta.next_checks);
    /* THE SENTENCE THE BRIEF SINGLES OUT. */
    chk('"a fresh capture confirming the price" is a next check, never a counterargument',
      !(ta.counterarguments || []).some((x) => /capture confirms|re-capture/i.test(x)),
      ta.counterarguments);
    const p = j.prompt || '';
    chk('the prompt states that a next check answers a blocker, not a counterargument',
      /A next check answers a BLOCKER/.test(p));
    chk('and forbids claiming a refresh fixes personnel, routing or the model',
      /refreshing odds resolves missing personnel data, a routing failure or an unvalidated/.test(p));
    /* AND NO INTERNAL MACHINERY IN THE READER'S ANSWER. */
    chk('no raw SQL, JSON dump or table name is set up to reach the reader',
      !/relation \"public|schema cache|SELECT |PostgREST/i.test(j.answer || ''));
  }

  done();
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
