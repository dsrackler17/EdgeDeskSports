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
    /* 'empty' is the reported shape: a 200 with no text and stop_reason
       max_tokens, which the function must treat as recoverable rather than
       fatal — and, when the retry is also empty, answer deterministically. */
    if (modelStatus === 'empty') {
      return { ok: true, status: 200, text: async () => '',
        json: async () => ({ model: 'test', stop_reason: 'max_tokens',
          usage: { input_tokens: 31000, output_tokens: 0 }, content: [] }) };
    }
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
    /* THE FIVE STATES GET FIVE SENTENCES. Sent down the wrong branch, an
       ambiguous single name produced "no game carries BOTH of those sides"
       about a question that named ONE — a true sentence about a different
       failure, which is how a failed lookup becomes "that team does not
       exist". */
    const p = j.prompt || '';
    /* Scoped to claims about the TEAMS. The prompt says "the data does not
       exist" elsewhere, about a source that answered with no rows, and that
       sentence is correct — it is the distinction this assertion is protecting,
       not a violation of it. */
    const nmNote = (j.data_path.named_matchup || {}).note || '';
    chk('an unresolved matchup is never described as an unknown or absent team',
      !/(team|program|school|Texas State|Boise State)[^.]{0,40}(does not exist|is not a real|unknown team)/i.test(p + ' ' + nmNote),
      nmNote);
    chk('it is described as absent from the CARD, which is what was checked',
      /no scheduled game with BOTH of those|not on any card|no game carries BOTH/i.test(p + ' ' + nmNote), nmNote);
    chk('and the answer is told to ask rather than substitute',
      /ASK ONE SHORT CLARIFYING QUESTION/.test(p));
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
    /* (b2) A SCHEDULED GAME WITH NO PRICE is not a missing game, and is not a
       tradeable one either. Three counts travel together everywhere in this
       system and conflating any two is how a 46-market board was described as
       having one. */
    const ask = conversation({ packet: MLB_PACKET });
    const j = await ask('How does Oregon look this week?');
    const c = j.research_context || {};
    eq('an unpriced game still resolves', c.game_id, '401858455');
    eq('and routes to football', j.sport, 'americanfootball_ncaaf');
    chk('the absence of a price is never reported as an absent game',
      !/no such game|game does not exist|not on the card/i.test(j.prompt || ''));
    const st = j.slate_state || {};
    chk('scheduled, quoted and priced are counted separately',
      st.scheduled_games != null && st.games_with_quotes != null
      && st.scheduled_games >= st.games_with_quotes,
      { scheduled: st.scheduled_games, quoted: st.games_with_quotes });
    chk('and the prompt says a market NUMBER is not an executable price',
      /not a price to bet into|no book, no per-side odds and no capture time|consensus line is a number/i.test(j.prompt || ''));
    chk('no decision is published for a game with no executable price',
      (j.decisions || []).every((d) => String(d.game_id) !== '401858455'
        || (d.price && d.price.offered_american != null)),
      (j.decisions || []).map((d) => [d.game_id, d.price && d.price.offered_american]));
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

  /* =====================================================================
     11. THE WEBSITE HALF.

     The server can route perfectly and the panel can still answer about the
     wrong game: app.html has its own resolver, its own planner and its own
     fallbacks, and all three used to assume the loaded signal was the subject.
     These run the browser's OWN resolver — the EDINTEL block inlined into
     app.html, not a copy — against the real published card.
     ===================================================================== */
  {
    const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');

    /* ---- the resolver the panel uses, actually executed ---------------- */
    const kernel = APP.slice(APP.indexOf('/*__EDINTEL_START__*/'), APP.indexOf('/*__EDINTEL_END__*/'));
    chk('the intelligence kernel is inlined into the page', kernel.length > 1000, kernel.length);
    const grab = (name) => {
      const at = APP.indexOf('function ' + name + '(');
      if (at < 0) return null;
      /* Balance braces from the first one after the signature. */
      let i = APP.indexOf('{', at), depth = 0;
      for (let j = i; j < APP.length; j++) {
        if (APP[j] === '{') depth++;
        else if (APP[j] === '}') { depth--; if (!depth) return APP.slice(at, j + 1); }
      }
      return null;
    };
    const src = [grab('resolveQuestionToGame')].filter(Boolean).join('\n');
    chk('resolveQuestionToGame was found in the page', !!src.length);
    const sandbox = new Function('EDINTEL_SRC', `
      ${kernel}
      ${src}
      return { resolveQuestionToGame: resolveQuestionToGame, EDINTEL: EDINTEL };
    `)();
    const EI = sandbox.EDINTEL;
    const SL = JSON.parse(fs.readFileSync(path.join(ROOT, 'football/fbs/slate.json'), 'utf8'));
    const games = SL.games.map((g) => ({ game_id: String(g.game_id), home_team: g.home_team,
      away_team: g.away_team, home_id: g.home_team_id, away_id: g.away_team_id, kickoff: g.kickoff }));
    const ix = EI.fbsIndexFor(games);
    const R = (q) => sandbox.resolveQuestionToGame(q, games, ix);

    const nt = R('What do you think about North Texas vs Texas State this week?');
    chk('the browser resolves a named matchup off the published card',
      nt && nt.home_id === 'texasstate' && nt.away_id === 'northtexas', nt && [nt.away_team, nt.home_team]);
    const solo = R('How does Texas State look this week?');
    chk('and resolves a single named program to its one game',
      solo && solo.home_id === 'texasstate', solo && [solo.away_team, solo.home_team]);
    /* THE TRAP THE WHOLE INCIDENT TURNS ON. */
    chk('"Texas State" is never read as "Texas"',
      !solo || !/rangers/i.test(JSON.stringify(solo)), solo);
    const oh = R('What about Miami (OH) vs Cincinnati?');
    chk('Miami (OH) reaches Cincinnati, not Miami Florida',
      oh && oh.away_id === 'miamioh', oh && [oh.away_team, oh.home_team]);
    const fl = R('What about Miami vs Wake Forest?');
    chk('and plain Miami reaches Wake Forest',
      fl && fl.away_id === 'miami' && fl.home_id === 'wakeforest', fl && [fl.away_team, fl.home_team]);
    chk('an ordinary sentence resolves to no game at all',
      R('Anything worth betting tonight?') == null, R('Anything worth betting tonight?'));
    /* THE RESOLVER IS MASCOT-TOLERANT BY DESIGN — it exists to join a book's
       "Colorado Buffaloes" to a schedule's "Colorado" — so it will resolve
       "Colorado Rockies" to Colorado's football team if asked. It is fenced by
       excluding whatever the reader has open in another sport. */
    chk('a baseball club is excluded once the loaded selection is named',
      sandbox.resolveQuestionToGame('San Diego Padres @ Colorado Rockies', games, ix,
        'San Diego Padres @ Colorado Rockies') == null);

    /* ---- the contract the panel now keeps ----------------------------- */
    chk('the panel sends the resolved subject back with every question',
      /research_context\s*:\s*LAST_CTX/.test(APP));
    chk('and keeps a failed response that still carries research',
      /if\(parsed && parsed\.research\)/.test(APP));
    chk('the local deep path is gated on the question being about the open signal',
      /if\(ctx && askedAboutOpenSignal\(t, ctx\.x, 'chat'\)\)/.test(APP));
    chk('and so is the deterministic narrative fallback',
      /if\(x && askedAboutOpenSignal\(question, x, mode\)\)/.test(APP));
    chk('a narration failure renders facts plus a retry, not an invented view',
      /factualFallbackHTML/.test(APP) && /EdgeDesk has not formed a view/.test(APP)
      && /EDAI\.retryLast\(\)/.test(APP));
    /* THE LINE THE REPORTED FAILURE ENDED ON. */
    chk('the ledger notice no longer renders the database detail',
      !/esc\(String\(L\.detail\)/.test(APP));
    chk('and sends it to the console instead',
      /console\.warn\('EdgeDesk ledger write failed:'/.test(APP));
    chk('the fact card separates a captured quote from a consensus reference',
      /not an executable sportsbook quote/.test(APP) && /captured/.test(APP));
    /* NO PRIVILEGED CREDENTIAL MOVES TO THE BROWSER.
       A page that NAMES a server-side variable in a diagnostic sentence is
       fine; a page that holds a key, or calls the model directly, is not. */
    chk('the page holds no model key', !/sk-ant-[A-Za-z0-9]/.test(APP));
    chk('and never calls the model API itself — that stays server-side',
      !/api\.anthropic\.com/.test(APP) && !/['"]x-api-key['"]/.test(APP));
    chk('and no service-role key is either',
      !/service_role|SERVICE_ROLE/.test(APP));
    chk('the only privileged call it makes is to the authenticated function',
      /functions\/v1\/edgedesk_ai/.test(APP));
  }

  /* =====================================================================
     12. THE NARRATION PATH, WHEN THE WRITING MODEL WILL NOT WRITE.

     The reported reply resolved the right game and was still useless: the
     model returned nothing usable, six near-identical cards filled the space,
     and the PRICE NEEDED was filed as an argument against the lean. Every
     assertion below is one of those failures.
     ===================================================================== */
  {
    const STALE = new Date(Date.now() - 38.5 * 3600 * 1000).toISOString();
    const six = ['spreads:North Texas:2.5', 'spreads:Texas State:-2.5', 'totals:Over:57.5',
                 'totals:Under:57.5', 'h2h:North Texas:', 'h2h:Texas State:']
      .map((spec) => { const [market, selection, point] = spec.split(':');
        return fx.signal({ market, selection, point: point === '' ? null : Number(point),
          last_seen_at: STALE, best_book: 'FanDuel', edge: 0.004 }); });

    /* ---- (a) the model returns no text, twice --------------------------- */
    modelStatus = 'empty';
    m.clearCache(); route = FX.router(fx, { signals: six });
    const r = await m.handle(new Request('https://fn.test/edgedesk_ai', {
      method: 'POST', headers: { authorization: 'Bearer u', 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'chat',
        question: 'What do you think about North Texas vs Texas State this week? Anything worth betting?',
        packet: { board_scope: { sport: 'americanfootball_ncaaf', season: 2026, week: 3 } }, history: [] }),
    }));
    const j = await r.json();
    modelStatus = 200;

    eq('a narration failure is not a failed request', r.status, 200);
    chk('it is reported as a narration failure', j.narration && j.narration.ok === false, j.narration);
    /* THE RETRY IS ACTUALLY SMALLER. 60,000 characters is not a smaller
       payload after 31,000 input tokens exhausted the budget. */
    chk('a retry was attempted', j.narration && j.narration.retried === true, j.narration);
    chk('with a genuinely smaller evidence budget',
      j.narration && j.narration.retry && j.narration.retry.evidence_budget <= 6000,
      j.narration && j.narration.retry);

    const S = j.matchup_summary;
    chk('the reader still gets a read', !!S, Object.keys(j));
    chk('and it is built from EdgeDesk fields, not written', S && S.source === 'deterministic', S && S.source);
    /* THE TARGET SENTENCE — the market number, then the honest limit. */
    chk('the read names the favourite from the MARKET number',
      /favored by 2\.5/.test(S.read || ''), S && S.read);
    chk('and says plainly that it cannot call the value',
      /doesn't have enough current evidence to call that value/.test(S.read || ''), S && S.read);
    chk('and names the stale quote in hours, with its book',
      /FanDuel quote is stale/.test(S.read || '') && /38\.5 hours old/.test(S.read || ''), S && S.read);
    chk('and reaches research-only rather than a lean',
      /research-only until the market refreshes/.test(S.read || ''), S && S.read);
    /* NO INVENTED LEAN. */
    chk('no bet, play or recommendation is invented',
      !/\b(bet it|take the|i like|play the|hammer|lean to)\b/i.test(S.read || ''), S && S.read);

    /* ONE PRIMARY MARKET, NOT SIX CARDS. */
    chk('one market is marked primary', (j.research.decisions || []).filter((d) => d.primary).length === 1,
      (j.research.decisions || []).map((d) => [d.market, d.selection, d.primary]));
    eq('and the rest are secondary', (j.research.decisions || []).filter((d) => !d.primary).length, 5);
    chk('the primary is the spread, which is what "the line" means',
      S && S.primary && S.primary.market === 'spreads', S && S.primary);
    eq('and the summary counts the others', S && S.other_markets, 5);

    /* PRICE NEEDED AND BLOCKERS ARE NOT COUNTERARGUMENTS. */
    const wrong = (S && S.could_be_wrong) || [];
    chk('the price needed is not filed as opposing evidence',
      !wrong.some((x) => /good to -|price limit|or better would/i.test(x)), wrong);
    chk('nor is the stale quote',
      !wrong.some((x) => /hours old|stale until|re-priced/i.test(x)), wrong);
    chk('nor is a missing availability report',
      !wrong.some((x) => /availability report/i.test(x)), wrong);
    chk('the price needed is stated as a price', /-112/.test((S && S.price_needed) || ''), S && S.price_needed);
    chk('the stale quote is a data blocker',
      (S.data_blockers || []).some((x) => /38\.5 hours/.test(x)), S.data_blockers);
    chk('and it is stated once, not twice',
      (S.data_blockers || []).filter((x) => /hours old|re-priced|stale until/i.test(x)).length === 1,
      S.data_blockers);

    /* EV PROVENANCE — whose arithmetic the number is. */
    chk('the expected return names its source',
      /sharp-market fair price/.test(S.ev_provenance || ''), S && S.ev_provenance);
    chk('and says the model did not produce it',
      /no validated outcome probability/.test(S.ev_provenance || ''), S && S.ev_provenance);
    chk('no CFB spread decision carries a model EV',
      (j.research.decisions || []).every((d) => d.market !== 'spreads' || !d.model || d.model.model_ev == null),
      (j.research.decisions || []).map((d) => [d.market, d.model && d.model.model_ev]));

    /* NOTHING OPERATIONAL REACHES THE READER. */
    const blob = JSON.stringify({ read: S.read, why: S.why, wrong: S.could_be_wrong,
      price: S.price_needed, blockers: S.data_blockers });
    chk('the read carries no internal classification',
      !/cfb_research_matchup|cfb_betting_candidate|RESEARCH_LEAN|data_path|single_game|americanfootball_ncaaf/i.test(blob),
      blob.slice(0, 200));
  }
  {
    /* ---- (b) the contract that makes the model answer ------------------- */
    m.clearCache(); route = FX.router(fx, {});
    const r = await m.handle(new Request('https://fn.test/edgedesk_ai?dry=1', {
      method: 'POST', headers: { authorization: 'Bearer u', 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'chat', question: 'How does Texas State look this week?',
        packet: { board_scope: MLB_BOARD }, history: [] }),
    }));
    const j = await r.json();
    const sys = j.system || '';
    chk('a single-matchup question carries The Desk contract',
      /THE DESK — ANSWER CONTRACT FOR A SINGLE MATCHUP/.test(sys));
    for (const h of ["The Desk's read", 'Why', 'What could make it wrong', 'Price and data limitations']) {
      chk(`the contract asks for "${h}"`, sys.indexOf(h) >= 0);
    }
    chk('it forbids a missing input from being an argument',
      /A missing input is NOT an argument/.test(sys));
    chk('and bans internal vocabulary from the prose',
      /cfb_research_matchup/.test(sys) && /FORBIDDEN IN THE ANSWER/.test(sys));
    /* THE PROMPT HAS ROOM TO ANSWER IN. */
    chk('the card-wide blocks are dropped for a one-game question',
      !/THE CARD, RANKED/.test(j.prompt || '') && !/RESEARCH QUEUE/.test(j.prompt || ''));
    chk('and the prompt is small enough to leave room for an answer',
      (j.prompt || '').length < 100000, (j.prompt || '').length);
  }

  done();
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
