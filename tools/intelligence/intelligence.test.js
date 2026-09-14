#!/usr/bin/env node
/* ===========================================================================
   REGRESSION TESTS FOR EDGEDESK INTELLIGENCE.

   Every test below is named after a failure that was actually observed in the
   product, and fails if that failure can happen again. They run against the
   REAL edge function (Node 22 strips the TypeScript), the REAL published FBS
   slate artifact, and the REAL model validation artifact — with fixtures only
   where this repository has no live database to reach.

   Run: node tools/intelligence/intelligence.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const FX = require('./fixtures.js');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (ok) { pass++; return; }
  fail++; failures.push({ name, detail });
}
function eq(name, got, want) { chk(name, got === want, { got, want }); }
function near(name, got, want, tol) { chk(name, got != null && Math.abs(got - want) <= (tol || 1e-6), { got, want }); }
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
let posted = [];
globalThis.fetch = async function (url, init) {
  const u = String(url);
  if (u.indexOf('api.anthropic.com') >= 0) {
    return { ok: true, status: 200, json: async () => ({ model: 'test', content: [{ type: 'text', text: 'ok' }] }), text: async () => 'ok' };
  }
  if (init && init.method === 'POST' && u.indexOf('sb.test') >= 0) {
    posted.push({ table: u.replace('https://sb.test/rest/v1/', ''), body: JSON.parse(init.body) });
    return { ok: true, status: 201, text: async () => '', json: async () => [] };
  }
  if (init && init.method === 'HEAD') return { ok: true, status: 200, headers: { get: () => '*/0' }, text: async () => '' };
  const d = route(u, init);
  if (d === null) return { ok: false, status: 404, text: async () => 'nope', json: async () => null };
  return { ok: true, status: 200, text: async () => JSON.stringify(d), json: async () => d };
};

/* The retrieval cache is per-isolate and long-lived by design, so one
   scenario's rows would otherwise answer the next one's query. Cleared
   between scenarios; production keeps the cache. */
let clearCache = () => {};

function req(body, qs) {
  return new Request('https://fn.test/edgedesk_ai' + (qs || ''), {
    method: 'POST', headers: { authorization: 'Bearer user-jwt', 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
}
const SCOPE = { sport: 'americanfootball_ncaaf', season: 2026, week: 3, label: 'week 3' };

(async function main() {
  const m = await import(path.join(__dirname, '..', '..', 'supabase', 'functions', 'edgedesk_ai', 'index.ts'));
  const I = globalThis.EDINTEL;
  clearCache = m.clearCache;
  chk('the intelligence kernel is loaded inside the function', !!I && I.VERSION === 1);

  /* =====================================================================
     1. THE CFB SCHEDULE EXISTS BUT THE SIGNALS QUERY IS EMPTY.
     The observed failure: the FBS board showed 75 games and Intelligence
     answered "there are no CFB matchups to evaluate on this slate".
     ===================================================================== */
  {
    const fx = FX.build();
    /* BOTH market sources empty. The board resolves a market from captured
       signals OR cfb.lines, so emptying only the first would leave the other
       one answering and test a different state than the name claims. */
    clearCache(); route = FX.router(fx, { signals: [], lines: [] });
    const r = await m.handle(req({ mode: 'chat', question: 'Any CFB matchups look good this week?',
      packet: { board_scope: SCOPE }, history: [] }, '?dry=1'));
    const j = await r.json();
    const st = j.data_path && j.data_path.slate_index && j.data_path.slate_index.slate_state;
    chk('an empty signals query still finds the scheduled games', st && st.scheduled > 0, st);
    eq('and classifies the slate as quoted-less, not empty', st && st.state, 'GAMES_NO_QUOTES');
    eq('the slate scope denominator comes from the schedule', j.slate_scope && j.slate_scope.expected_games, fx.slate.games.length);
    const p = j.prompt || '';
    chk('the prompt states the real game count',
      new RegExp(fx.slate.games.length + ' CFB games are scheduled').test(p),
      p.slice(p.indexOf('THE SLATE'), p.indexOf('THE SLATE') + 200));
    chk('and says both market sources were checked, not just signals',
      /NONE of them carries a market number from either source/.test(p), p.slice(p.indexOf('THE SLATE'), p.indexOf('THE SLATE') + 400));
    chk('the prompt forbids the "no games" claim outright',
      p.indexOf('YOU MAY NOT CLAIM THAT THERE ARE NO GAMES TO EVALUATE') >= 0);
    chk('and tells the analyst to research them anyway',
      /Research, compare and rank the games anyway/.test(p));
    chk('the schedule source is named', /the FBS board’s own published slate|cfb\.games/.test(p));
  }

  /* =====================================================================
     2. A RETRIEVAL FAILURE IS NOT AN EMPTY SLATE.
     ===================================================================== */
  {
    const fx = FX.build();
    clearCache(); route = (u) => (u.indexOf('/football/fbs/slate.json') >= 0 ? null : (u.indexOf('/signals?') >= 0 ? [] : []));
    const r = await m.handle(req({ mode: 'chat', question: 'Any CFB games worth betting?',
      packet: { board_scope: SCOPE }, history: [] }, '?dry=1'));
    const j = await r.json();
    const st = j.data_path && j.data_path.slate_index && j.data_path.slate_index.slate_state;
    chk('a schedule source that cannot be read reports a retrieval failure, not zero games',
      st && st.state === 'RETRIEVAL_FAILED', st);
    chk('and the prompt still forbids the "no games" claim',
      (j.prompt || '').indexOf('YOU MAY NOT CLAIM') >= 0);
  }

  /* =====================================================================
     3. HOME/AWAY SPREAD ORIENTATION.
     A model line published from the home side, compared against a book
     handicap on the away selection, is wrong by twice the line.
     ===================================================================== */
  {
    const o = m.orientToSelection({ selection: 'North Texas', home_team: 'Texas State',
      away_team: 'North Texas', point: -2.5, model_home_line: 2.4 });
    eq('the away selection resolves to the away side', o.side, 'away');
    near('the home-side model line is flipped for the away selection', o.model_selection_line, -2.4);
    const h = m.orientToSelection({ selection: 'Texas State', home_team: 'Texas State',
      away_team: 'North Texas', point: 2.5, model_home_line: 2.4 });
    eq('the home selection resolves to the home side', h.side, 'home');
    near('the home-side model line is used unchanged', h.model_selection_line, 2.4);
    const un = m.orientToSelection({ selection: 'Over', home_team: 'Texas State',
      away_team: 'North Texas', point: 58.5, model_home_line: 2.4 });
    eq('a selection on neither side asserts no orientation', un.side, null);
    chk('and says so rather than guessing', /could not be resolved to either side/.test(un.note));

    /* The orientation must survive the whole pipeline, not just the helper. */
    const fx = FX.build();
    clearCache(); route = FX.router(fx);
    const r = await m.handle(req({ mode: 'chat', question: 'Analyze North Texas versus Texas State.',
      packet: { board_scope: SCOPE }, history: [] }, '?dry=1'));
    const j = await r.json();
    const d = (j.decisions || [])[0];
    chk('the decision carries the resolved side', d && d.side === 'away', d && d.side);
    chk('the model-market gap is ORDINARY once both are on the same side',
      d && d.disagreement && d.disagreement.level === 'ORDINARY', d && d.disagreement && d.disagreement.gap);
    chk('an unoriented comparison would have produced a LARGE phantom gap',
      Math.abs(2.4 - (-2.5)) >= I.config().disagreement_points);
  }

  /* =====================================================================
     4. A MISSING SHARP REFERENCE AND THE FAIR-PRICE LABEL.
     The observed failure: one row claimed "Estimated edge vs Pinnacle de-vig
     fair" and "No sharp reference quoted this selection" at the same time.
     ===================================================================== */
  {
    const consensus = { sharp_fair: 0.535, sharp_book_fair: null, consensus_fair: 0.535,
      reference_type: 'robust_consensus', has_sharp: false, n_books: 7, n_books_eff: 4, corrob_n: 0 };
    const fm = I.fairMethod(consensus);
    eq('a consensus-anchored row is not labelled sharp', fm.method, 'ROBUST_CONSENSUS_MEDIAN');
    chk('and the label never says Pinnacle', fm.label.toLowerCase().indexOf('pinnacle') < 0, fm.label);
    chk('a populated sharp_fair alone does NOT make a row sharp-anchored', fm.sharp === false);

    const sharp = { sharp_fair: 0.532, sharp_book_fair: 0.532, consensus_fair: 0.528,
      reference_type: 'sharp', reference_book: 'pinnacle', has_sharp: true, pin_dec: 1.88, pin_opp_dec: 2.02, n_books: 9, n_books_eff: 6 };
    const fs = I.fairMethod(sharp);
    eq('a row with the reference book’s own number IS sharp-anchored', fs.method, 'SHARP_REFERENCE_DEVIG');
    chk('and names the reference book', /Pinnacle de-vig fair/.test(fs.label), fs.label);
    chk('and names the quotes it was actually de-vigged from', fs.contributing_quotes.length === 2, fs.contributing_quotes);

    const claimed = { sharp_fair: 0.53, sharp_book_fair: null, consensus_fair: 0.53,
      reference_type: 'sharp', has_sharp: true, n_books: 5, n_books_eff: 3 };
    const fc = I.fairMethod(claimed);
    eq('a claimed anchor with no evidence is flagged, not trusted', fc.method, 'SHARP_CLAIMED_UNVERIFIED');
    chk('and is not treated as sharp', fc.sharp === false);

    /* and the contradiction cannot reach the prompt */
    const fx = FX.build();
    clearCache(); route = FX.router(fx, { signals: [fx.signal(consensus)] });
    const r = await m.handle(req({ mode: 'why', question: 'Why does EdgeDesk like this?',
      packet: { board_scope: SCOPE }, history: [] }, '?dry=1'));
    const j = await r.json();
    const sig = (j.evidence || []).find((e) => e.field === 'signal');
    chk('the board row the analyst receives carries the honest method',
      sig && sig.value.fair_method === 'ROBUST_CONSENSUS_MEDIAN', sig && sig.value.fair_method);
    chk('and never claims a Pinnacle anchor',
      sig && String(sig.value.fair_label).toLowerCase().indexOf('pinnacle') < 0, sig && sig.value.fair_label);
    chk('book count is explicitly not sharp confirmation',
      /Book count is not sharp confirmation/.test(I.confirmationRead(consensus).caveat));
  }

  /* =====================================================================
     5. STALE QUOTES CANNOT BECOME ACTIONABLE RECOMMENDATIONS.
     Observed: "top opportunities" containing quotes aged 446, 806 and 2126
     minutes.
     ===================================================================== */
  {
    const now = Date.now();
    [446, 806, 2126].forEach((age) => {
      const q = I.quoteState({ captured_at: now - age * 60000, now, market: 'spreads' });
      eq('a ' + age + '-minute-old spread quote is stale', q.status, 'STALE');
      chk('and is not actionable', q.actionable === false);
      chk('and is still usable for research', q.research_usable === true);
    });
    const fresh = I.quoteState({ captured_at: now - 12 * 60000, now, market: 'spreads' });
    eq('a 12-minute-old quote is current', fresh.status, 'CURRENT');
    chk('and is actionable', fresh.actionable === true);
    const unknown = I.quoteState({ captured_at: null, now, market: 'spreads' });
    eq('a quote with no timestamp is unknown, not fresh', unknown.status, 'UNKNOWN');
    chk('and is not actionable', unknown.actionable === false);

    /* the whole pipeline, on a stale row */
    const fx = FX.build();
    clearCache(); route = FX.router(fx, { signals: [fx.signal({ last_seen_at: new Date(fx.now - 2126 * 60000).toISOString() })] });
    const r = await m.handle(req({ mode: 'chat', question: 'Any CFB matchups look good?',
      packet: { board_scope: SCOPE }, history: [] }, '?dry=1'));
    const j = await r.json();
    const d = (j.decisions || [])[0];
    chk('a stale quote cannot produce a BET CANDIDATE', d && d.decision !== 'BET CANDIDATE', d && d.decision);
    eq('it becomes a WATCH', d && d.decision, 'WATCH');
    chk('and the reason names the staleness', d && /2126 minutes ago/.test(d.why), d && d.why);
    const rank = (j.slate_ranking || []).find((x) => /North Texas/.test(x.game));
    chk('a stale-only game is not eligible for a priced recommendation', rank && rank.eligible === false, rank);
    chk('and the ineligibility reason says why', rank && /stale/.test(rank.reason || ''), rank && rank.reason);

    /* a failed refresh withdraws actionability without deleting the price */
    const prev = { captured_at: new Date(now - 30 * 60000).toISOString(), dec: 1.95 };
    const after = I.applyRefresh(prev, { ok: false, why: 'the book did not answer' }, { now, market: 'spreads' });
    chk('a failed refresh keeps the last observed price', after.quote === prev);
    chk('and withdraws its actionability', after.state.actionable === false);
    chk('and says the refresh failed', /refresh did not complete/.test(after.state.why), after.state.why);
  }

  /* =====================================================================
     6. TRUNCATION CANNOT ERASE SCOPE OR CRITICAL BLOCKERS.
     Observed: 361 items retrieved, 130 withheld, and a categorical absence
     claim made anyway.
     ===================================================================== */
  {
    const fx = FX.build();
    const many = [];
    for (let i = 0; i < 40; i++) many.push(fx.signal({ event_id: 'e' + i, home_team: 'H' + i, away_team: 'A' + i }));
    clearCache(); route = FX.router(fx, { signals: many });
    ENV.EDGEDESK_EVIDENCE_MAX = '4000';
    const r = await m.handle(req({ mode: 'chat', question: 'Any CFB matchups look good?',
      packet: { board_scope: SCOPE }, history: [] }, '?dry=1'));
    const j = await r.json();
    delete ENV.EDGEDESK_EVIDENCE_MAX;
    const p = j.prompt || '';
    chk('the slate scope survives truncation',
      p.indexOf('THE SLATE') >= 0
      && new RegExp(fx.slate.games.length + ' CFB games (are )?scheduled').test(p));
    chk('withheld items are reported', p.indexOf('EVIDENCE WITHHELD') >= 0);
    chk('the unseen subjects are NAMED, not just counted',
      p.indexOf('SUBJECTS WITH NO EVIDENCE IN THIS MESSAGE AT ALL') >= 0);
    chk('a whole-slate comparison claim is forbidden',
      p.indexOf('YOU MAY NOT CLAIM TO HAVE COMPARED THE WHOLE SLATE') >= 0);
    chk('a categorical absence claim is gated on full delivery',
      /A CATEGORICAL ABSENCE CLAIM[\s\S]{0,200}They do not both hold here/.test(p));
    chk('the three coverage numbers are named separately',
      /required-field completeness/.test(p) && /retrieval success/.test(p) && /evidence delivered/.test(p));
  }

  /* =====================================================================
     7. MISSING EFFICIENCY STAYS EXPLICITLY MISSING.
     Observed: "team_efficiency 0/176" and "Not available: games.team_efficiency"
     for a metric college football does not have in this project at all.
     ===================================================================== */
  {
    const fx = FX.build();
    clearCache(); route = FX.router(fx);
    const r = await m.handle(req({ mode: 'chat', question: 'Which CFB offenses are most efficient?',
      packet: { board_scope: SCOPE }, history: [] }, '?dry=1'));
    const j = await r.json();
    const cov = j.coverage_per_entity || [];
    chk('team_efficiency is not counted as a coverage gap for college football',
      !cov.some((c) => c.field === 'team_efficiency'), cov.map((c) => c.field));
    chk('it is declared as a capability the sport lacks instead',
      (j.capabilities || []).some((c) => c.capability === 'per_play_efficiency' && c.status === 'NOT_AVAILABLE'));
    const pk = (j.evidence_packets || [])[0];
    if (pk) {
      const eff = pk.sections.efficiency.per_play;
      chk('the evidence packet marks per-play efficiency missing', eff && eff.missing === true);
      chk('with a reason naming why it is absent', eff && /NOT ingested for college football/.test(eff.reason), eff && eff.reason);
      chk('and forbids substituting points per game', eff && /Do not substitute points per game/.test(eff.reason));
      chk('injuries are declared missing rather than omitted',
        pk.sections.personnel.injuries.missing === true
        && /not a clean injury sheet/.test(pk.sections.personnel.injuries.reason));
    } else chk('an evidence packet was built', false, 'no packet');
  }

  /* =====================================================================
     8. EXPECTED VALUE, INCLUDING PUSHES.
     ===================================================================== */
  {
    const d = I.americanToDec(-110);
    near('-110 is 1.9091 decimal', d, 1.9091, 1e-4);
    near('EV at 55% with no push', I.ev({ dec: d, p_win: 0.55 }).ev, 0.55 * (d - 1) - 0.45, 1e-4);
    const withPush = I.ev({ dec: d, p_win: 0.50, p_push: 0.06 });
    near('a push is not a loss', withPush.ev, 0.50 * (d - 1) - 0.44, 1e-4);
    chk('and the push mass is reported', withPush.p_push === 0.06 && withPush.p_loss === 0.44, withPush);
    const wrong = 0.50 * (d - 1) - 0.50;
    chk('treating the push as a loss would understate EV', withPush.ev > wrong);
    near('break-even at -110 with no push', I.breakEvenProb(d), 1 / d, 1e-4);
    near('break-even at -110 with a 6% push', I.breakEvenProb(d, 0.06), 0.94 / d, 1e-4);
    chk('EV is null when no probability exists', I.ev({ dec: d }).ev === null);
    chk('and says a line difference is not a probability',
      /line difference alone is not a probability/.test(I.ev({ dec: d }).why));

    /* push probability is UNKNOWN, never silently zero, on an integer line */
    const noDist = I.pushProbability({ handicap: -3, centre: -3 });
    chk('an integer handicap with no distribution returns unknown, not zero', noDist.p_push === null, noDist);
    chk('and says so explicitly', /it is not zero/.test(noDist.why));
    eq('a half-point handicap genuinely cannot push', I.pushProbability({ handicap: -3.5 }).p_push, 0);
    const withDist = I.pushProbability({ handicap: -3, centre: -3, distribution_key: 'americanfootball_ncaaf|margin_resid' });
    chk('with a registered distribution it is computed', withDist.p_push > 0 && withDist.p_push < 0.1, withDist);
    chk('and carries its training window', !!withDist.window, withDist.window);
  }

  /* =====================================================================
     9. A SPREAD GAP ALONE DOES NOT PRODUCE MODEL EV.
     The football model's own walk-forward record does not beat the close.
     ===================================================================== */
  {
    const sp = I.validationFor('americanfootball_ncaaf', 'spreads');
    eq('the CFB spread model is research-tier', sp.tier, 'RESEARCH');
    chk('it may not produce a probability', sp.may_produce_probability === false);
    chk('it may not produce a model expected value', sp.may_produce_model_ev === false);
    eq('and it is capped at WATCH', sp.max_decision, 'WATCH');
    chk('the limitation quotes the real ATS record', /49\.94% at 1\+ points/.test(sp.limitations), sp.limitations);
    const wp = I.modelWinProbability({ sport: 'americanfootball_ncaaf', market: 'spreads', model_margin: 10, handicap: -3 });
    chk('so no model win probability is produced for a spread', wp.p === null && wp.permitted === false, wp);

    const ml = I.validationFor('americanfootball_ncaaf', 'h2h');
    eq('the moneyline model does carry a calibrated probability', ml.tier, 'PROBABILITY');
    chk('and it is labelled experimental because it does not beat the close', ml.experimental === true);
    chk('and its worst-calibrated band is reported', !!ml.worst_calibration_bin, ml.worst_calibration_bin);

    const unknown = I.validationFor('some_sport', 'spreads');
    eq('an unregistered sport gets no permission at all', unknown.tier, 'UNVALIDATED');
    chk('absence of a record is not permission', unknown.may_produce_model_ev === false);
  }

  /* =====================================================================
     10. THE LEDGER PRESERVES THE ORIGINAL DECISION.
     ===================================================================== */
  {
    const e = I.ledgerEntry({ sport: 'americanfootball_ncaaf', game_id: 'g1', matchup: 'A @ B',
      kickoff: '2026-09-20T19:00:00Z', market: 'spreads', selection: 'A', handicap: -2.5,
      odds_american: -105, book: 'DraftKings', decision: 'BET CANDIDATE', probability: 0.532,
      expected_value: 0.0374, published_at: '2026-09-14T18:00:00Z' });
    chk('a ledger entry is built', e.ok === true, e);
    eq('it records the decision verbatim', e.decision, 'BET CANDIDATE');
    eq('it is a forward recommendation', e.mode, 'FORWARD');
    chk('it is marked immutable', e.immutable === true);
    const u = I.ledgerUpdate(e, { decision: 'PASS', reason: 'price moved to -125' });
    eq('a change is a separate row', u.kind, 'UPDATE');
    eq('pointing back at the original', u.supersedes, e.entry_key);
    eq('and the original decision is untouched', e.decision, 'BET CANDIDATE');
    chk('an invalid decision is refused', I.ledgerEntry({ decision: 'STRONG BUY' }).ok === false);

    /* measurement */
    const rows = [
      Object.assign({}, e, { result: 'win', clv: 0.012 }),
      Object.assign({}, e, { entry_key: 'b', result: 'loss', clv: -0.004, probability: 0.52 }),
      Object.assign({}, e, { entry_key: 'c', result: 'push', clv: 0.001 }),
      Object.assign({}, e, { entry_key: 'd', result: 'void' }),
      Object.assign({}, e, { entry_key: 'x', result: 'win', mode: 'BACKTEST' }),
      u,
    ];
    const mm = I.measure(rows);
    eq('pushes are counted separately from wins and losses', mm.forward.pushes, 1);
    eq('and excluded from the win rate denominator', mm.forward.win_rate, 0.5);
    eq('voids are excluded from the stake', mm.forward.amount_staked, 3);
    near('units are computed on the real prices', mm.forward.units, (I.americanToDec(-105) - 1) - 1, 0.01);
    chk('an interval is reported, not a bare point estimate', !!mm.forward.win_rate_interval);
    chk('a small sample is flagged as meaningless', /neither a positive nor a negative record means anything yet/.test(mm.forward.caveat));
    eq('backtests are a separate population', mm.backtest.wins, 1);
    eq('and are not counted in the forward record', mm.forward.wins, 1);
    chk('the separation is stated', /never combined/.test(mm.separation_note));
  }

  /* =====================================================================
     11. HISTORICAL VALIDATION EXCLUDES FUTURE INFORMATION.
     ===================================================================== */
  {
    const late = I.validateNoLookahead({ published_at: '2026-09-21T01:00:00Z', kickoff: '2026-09-20T19:00:00Z' });
    chk('a row published after kickoff is excluded', late.clean === false);
    chk('and the reason is named', /published after kickoff/.test(late.problems.join(' ')));
    const early = I.validateNoLookahead({ published_at: '2026-09-14T18:00:00Z', kickoff: '2026-09-20T19:00:00Z',
      closing_captured_at: '2026-09-20T18:50:00Z' });
    chk('a properly ordered row is clean', early.clean === true, early);
    const backwards = I.validateNoLookahead({ published_at: '2026-09-20T18:00:00Z', kickoff: '2026-09-20T19:00:00Z',
      closing_captured_at: '2026-09-19T00:00:00Z' });
    chk('a close captured before publication is leakage', backwards.clean === false, backwards);
    const undated = I.validateNoLookahead({ kickoff: '2026-09-20T19:00:00Z' });
    chk('an undated row cannot be shown to precede the event', undated.clean === false);

    /* the evidence-level guard, on the real function */
    const fx = FX.build();
    clearCache(); route = FX.router(fx);
    const r = await m.handle(req({ mode: 'chat', question: 'How did the CFB card look as of 2026-09-01?',
      packet: { board_scope: SCOPE }, history: [] }, '?dry=1'));
    const j = await r.json();
    chk('an explicit as-of date arms the leakage guard',
      j.leakage_guard && j.leakage_guard.as_of === '2026-09-01', j.leakage_guard);
    chk('and the prompt states the cutoff', /HISTORICAL CUTOFF/.test(j.prompt || ''));
  }

  /* =====================================================================
     12. FOLLOW-UPS REFRESH TIME-SENSITIVE PRICES.
     ===================================================================== */
  {
    const fx = FX.build();
    const packet = { market: 'spreads', selection: 'North Texas', point: -2.5,
      prices: { current: -105, fair: -114, max_playable: -112, book: 'DraftKings', trusted: true },
      edge: { current: 0.037, detect: 0.016, ev: 0.037, remaining: 1, floor: 0.005 },
      confirmation: { has_sharp: true, n_books: 9, corrob: 2, trusted: true },
      timing: { stale_min: 14, last_seen_at: new Date(fx.now - 14 * 60000).toISOString() },
      price_sensitivity: { breakeven: -114, max_playable: -112 },
      deterministic: { verdict: 'LEAN', display_verdict: 'LEAN', confidence: 'MEDIUM', score: 60,
        why: 'x', reasons_for: [], reasons_against: [], falsifiers: [] },
      game: { matchup: 'North Texas @ Texas State', sport_key: 'americanfootball_ncaaf' },
      board_scope: SCOPE };
    clearCache(); route = FX.router(fx);
    const r = await m.handle(req({ mode: 'price', question: 'What price makes it a pass?',
      packet, history: [{ role: 'user', content: 'Analyze North Texas versus Texas State.' },
        { role: 'assistant', content: 'North Texas -2.5 at -105 is a BET CANDIDATE.' }] }, '?dry=1'));
    const j = await r.json();
    const p = j.prompt || '';
    chk('a follow-up re-reads the market rather than reusing the earlier answer',
      (j.provenance.retrieval_log || []).some((l) => /signals/.test(l.table)), j.provenance.retrieval_log);
    chk('the freshness rule travels with every turn',
      /An unrevalidated repeat of an actionable price is a false statement about the present/.test(j.system || ''));
    chk('the presentation card carries a live freshness read',
      j.presentation && j.presentation.simple && j.presentation.simple.freshness
      && j.presentation.simple.freshness.status === 'CURRENT', j.presentation && j.presentation.simple && j.presentation.simple.freshness);
    /* a cached conclusion is invalid once a decision-critical field moves */
    const a = I.evidencePacket({ game_id: 'g', market: { price: I.fact(-105, { source: 's' }) } });
    const b = I.evidencePacket({ game_id: 'g', market: { price: I.fact(-125, { source: 's' }) } });
    const v = I.packetStillValid(a, b);
    chk('a moved price invalidates a cached analysis', v.valid === false, v);
    chk('and names the field that moved', v.changed.indexOf('market.price') >= 0, v.changed);
  }

  /* =====================================================================
     13. THE VALIDATION SNAPSHOT MATCHES THE REAL ARTIFACT.
     The edge function cannot read params.js, so it carries a transcription.
     A transcription is only honest if drift fails the build.
     ===================================================================== */
  {
    global.window = global.window || global;
    require(path.join(__dirname, '..', '..', 'football', 'cfb_p4', 'params.js'));
    require(path.join(__dirname, '..', '..', 'football', 'cfb_p4', 'calibration.js'));
    const P = global.EDCfbP4Params, C = global.EDCfbP4Calibration;
    const snap = I.validationSnapshot('americanfootball_ncaaf');
    chk('a snapshot is carried', !!snap);
    eq('it is stamped with the model version it came from', snap.model_version, P.model_version);
    eq('the beats-the-close finding matches the artifact',
      snap.validation_summary.market.beats_closing_line, P.validation_summary.market.beats_closing_line);
    eq('the max tier matches', snap.validation_summary.market.max_tier, P.validation_summary.market.max_tier);
    eq('the ATS record matches', JSON.stringify(snap.validation_summary.market.ats_vs_close),
      JSON.stringify(P.validation_summary.market.ats_vs_close));
    eq('the O/U record matches', JSON.stringify(snap.validation_summary.market.ou_vs_close),
      JSON.stringify(P.validation_summary.market.ou_vs_close));
    eq('the win-probability record matches', JSON.stringify(snap.validation_summary.winprob),
      JSON.stringify(P.validation_summary.winprob));
    eq('the margin distribution matches', JSON.stringify(snap.distributions.margin_resid_pmf),
      JSON.stringify(P.distributions.margin_resid_pmf));
    eq('the close-anticipation record matches', JSON.stringify(snap.clv_proxy_vs_open),
      JSON.stringify(C.clv_proxy_vs_open));
  }

  /* =====================================================================
     14. THE DECISION PASS, END TO END, ON A LIVE SHARP-ANCHORED QUOTE.
     ===================================================================== */
  {
    const fx = FX.build();
    clearCache(); route = FX.router(fx);
    posted = [];
    const r = await m.handle(req({ mode: 'chat', question: 'Any CFB matchups look good this week?',
      packet: { board_scope: SCOPE }, history: [] }, '?dry=1'));
    const j = await r.json();
    const d = (j.decisions || [])[0];
    chk('a live, sharp-anchored, floor-clearing price is a BET CANDIDATE', d && d.decision === 'BET CANDIDATE', d && d.decision);
    near('expected return is computed from the fair probability and the offered price',
      d && d.price.market_ev, 0.532 * (1.95 - 1) - 0.468, 1e-3);
    chk('the probability edge is reported separately and in different units',
      d && d.price.probability_edge_pp != null && d.price.probability_edge_pp !== d.price.market_ev, d && d.price);
    chk('a price limit is derived from the fair price', d && !!d.price.price_limit_american, d && d.price);
    chk('the model is present but contributes no expected value',
      d && d.model && d.model.may_produce_model_ev === false && d.price.model_ev === null, d && d.model);
    chk('a ledger row is published for it', (j.ledger_rows || []).length > 0);
    eq('and it records the same decision', (j.ledger_rows || [])[0] && j.ledger_rows[0].decision, 'BET CANDIDATE');
    chk('the attention tier is labelled editorial',
      d && d.attention && d.attention.basis === 'editorial' && /Do not equate low attention with a soft market/.test(d.attention.caveat));
  }

  /* =====================================================================
     15. THE EVIDENCE PACKET IS SUBSTANTIVE FOOTBALL, NOT SIGNAL METADATA.
     ===================================================================== */
  {
    const fx = FX.build();
    clearCache(); route = FX.router(fx);
    const r = await m.handle(req({ mode: 'chat', question: 'Analyze North Texas versus Texas State.',
      packet: { board_scope: SCOPE }, history: [] }, '?dry=1'));
    const j = await r.json();
    const pk = (j.evidence_packets || []).find((p) => /North Texas/.test(JSON.stringify(p.sections.identity)));
    chk('a packet was built for the named matchup', !!pk);
    if (pk) {
      eq('it is versioned', pk.schema, 'edgedesk_game_evidence_v1');
      chk('it has a stable id', /^401858900:v\d+$/.test(pk.packet_id), pk.packet_id);
      const away = pk.sections.matchup.away;
      chk('previous games are present', away.previous_games.missing === false, away.previous_games);
      const games = away.previous_games.value || [];
      chk('each previous game carries the opponent’s strength',
        games.length > 0 && games.every((g) => 'opponent_sp_plus' in g), games[0]);
      const fcs = games.find((g) => /Nicholls/.test(g.opponent));
      chk('a blowout over a weak opponent carries that opponent’s rating',
        fcs && fcs.opponent_sp_plus < -10, fcs);
      chk('rest days are derived from the schedule', away.rest_days.missing === false && away.rest_days.value > 0, away.rest_days);
      chk('SP+ defence is labelled lower-is-better',
        /LOWER is better/.test(away.sp_plus_defense.note || ''), away.sp_plus_defense.note);
      chk('strength of schedule is attached', away.strength_of_schedule.missing === false);
      chk('the SP+ gap is labelled as an external-model difference, not a spread',
        /not a spread, not a probability and not an edge/.test(pk.sections.matchup.sp_plus_gap.note || ''));
      chk('quarterbacks come with the roster caveat',
        /NOT A DEPTH CHART/.test(away.quarterbacks.note || ''), away.quarterbacks.note);
      chk('every source is named', pk.sources.length > 3, pk.sources);
      chk('and the gaps are declared with reasons',
        pk.missing.length > 0 && pk.missing.every((x) => !!x.reason), pk.missing.slice(0, 3));
    }
    const p = j.prompt || '';
    chk('the prompt tells the analyst how to read a matchup',
      /HOW TO USE A MATCHUP PACKET/.test(p) && /this is football analysis, not metadata paraphrase/.test(p));
    chk('and forbids inventing an explanation for a projection',
      /Never invent a matchup explanation to rationalise a projection/.test(p));
  }

  /* =====================================================================
     16. STAGED RETRIEVAL: A COMPLETE INDEX, A RESEARCHED SHORTLIST.
     ===================================================================== */
  {
    const fx = FX.build();
    clearCache(); route = FX.router(fx);
    const r = await m.handle(req({ mode: 'chat', question: 'Separate smaller-profile and big-attention CFB games.',
      packet: { board_scope: SCOPE }, history: [] }, '?dry=1'));
    const j = await r.json();
    chk('every game on the card is indexed', (j.slate_ranking || []).length === fx.slate.games.length,
      { indexed: (j.slate_ranking || []).length, card: fx.slate.games.length });
    chk('only a shortlist is researched in depth',
      (j.evidence_packets || []).length > 0 && j.evidence_packets.length < fx.slate.games.length,
      { researched: (j.evidence_packets || []).length });
    chk('eligibility and priority are reported separately',
      (j.slate_ranking || []).every((x) => 'eligible' in x && 'priority' in x));
    /* THREE STATES, NOT TWO. Collapsing "carries a consensus line" into "no
       market" is what made a 46-game board read as one game, so the ranking
       is asserted on the states themselves rather than on a reason string. */
    const rk = j.slate_ranking || [];
    const byStatus = (st) => rk.filter((x) => x.market_status === st);
    chk('a priced game is eligible', byStatus('PRICED').length > 0 && byStatus('PRICED').every((x) => x.eligible), byStatus('PRICED')[0]);
    chk('a line-only game is ineligible for a priced recommendation but still researchable',
      byStatus('LINE ONLY').length > 0
      && byStatus('LINE ONLY').every((x) => x.eligible === false && x.researchable === true),
      byStatus('LINE ONLY')[0]);
    chk('and its reason names the missing half rather than the whole market',
      byStatus('LINE ONLY').every((x) => /consensus market LINE but no executable price/.test(x.ineligible_reason || '')),
      (byStatus('LINE ONLY')[0] || {}).ineligible_reason);
    chk('a game with no number from either source is neither eligible nor researchable',
      byStatus('NO MARKET').length > 0
      && byStatus('NO MARKET').every((x) => !x.eligible && !x.researchable
        && /not a captured price, not a consensus line/.test(x.ineligible_reason || '')),
      (byStatus('NO MARKET')[0] || {}).ineligible_reason);
    chk('every ranked game lands in exactly one of the three states',
      rk.length > 0 && rk.every((x) => ['PRICED', 'PRICED (STALE)', 'LINE ONLY', 'NO MARKET'].indexOf(x.market_status) >= 0));
    chk('an ineligible game can still out-rank an eligible one on interest',
      rk.some((x) => !x.eligible && x.priority > 0), rk.filter((x) => !x.eligible).slice(0, 2));
    const p = j.prompt || '';
    chk('the prompt distinguishes the index from the shortlist',
      /THESE ARE THE ONLY GAMES YOU RESEARCHED IN DEPTH/.test(p));
    chk('attention tiers are labelled editorial in the prompt',
      /ATTENTION TIERS ARE EDITORIAL/.test(p));
  }

  /* =====================================================================
     17. THE BOARD'S ACTIVE SCOPE IS RESPECTED AND DISPLAYED.
     ===================================================================== */
  {
    const fx = FX.build();
    clearCache(); route = FX.router(fx);
    const r = await m.handle(req({ mode: 'chat', question: 'What looks good?',
      packet: { board_scope: SCOPE }, history: [] }, '?dry=1'));
    const j = await r.json();
    eq('the board scope decides the sport when the question does not', j.sport, 'americanfootball_ncaaf');
    chk('the resolved scope is echoed to the client',
      j.data_path.board_scope && j.data_path.board_scope.week === 3, j.data_path.board_scope);
    chk('and the prompt tells the analyst to stay inside it',
      /ACTIVE BOARD SCOPE/.test(j.prompt || ''));
  }

  /* =====================================================================
     18. THE BOOK AND THE SCHEDULE DO NOT SPELL A PROGRAM THE SAME WAY.
     The observed failure, and the one that caused every other CFB symptom:
     the FBS board showed 75 games and 46 with market quotes while
     Intelligence reported no CFB matchups. The capture writes "North Texas
     Mean Green"; the schedule writes "North Texas". A join on normalised
     strings matches NOTHING and reports the emptiness as an absent market.
     tools/newsletter/market.js recorded the same failure: "a live run read
     410 college signal rows and joined zero".
     ===================================================================== */
  {
    const games = [
      { game_id: 'g1', home_team: 'Texas State', away_team: 'North Texas', home_id: 'texasstate', away_id: 'northtexas', kickoff: '2026-09-20T23:00:00Z' },
      { game_id: 'g2', home_team: 'Wake Forest', away_team: 'Miami', home_id: 'wakeforest', away_id: 'miami', kickoff: '2026-09-20T20:00:00Z' },
      { game_id: 'g3', home_team: 'Ohio State', away_team: 'Ohio', home_id: 'ohiostate', away_id: 'ohio', kickoff: '2026-09-20T18:00:00Z' },
    ];
    const sig = (h, a, t) => ({ home_team: h, away_team: a, commence_time: t || '2026-09-20T20:00:00Z' });
    const j = I.joinSignalsToGames({
      games,
      signals: [
        sig('Texas State Bobcats', 'North Texas Mean Green', '2026-09-20T23:00:00Z'),
        sig('Wake Forest Demon Deacons', 'Miami Hurricanes'),
        sig('Wake Forest Demon Deacons', 'Miami (OH) RedHawks'),
        sig('Ohio State Buckeyes', 'Ohio Bobcats', '2026-09-20T18:00:00Z'),
        sig('Alabama Crimson Tide', 'Auburn Tigers'),
        sig('Texas State Bobcats', 'North Texas Mean Green', '2026-09-27T23:00:00Z'),
      ],
    });
    chk('a book’s nickname resolves to the school the schedule names',
      (j.by_game.g1 || []).length === 1, j.by_game.g1);
    chk('and so does a full book name on a ranked program',
      (j.by_game.g2 || []).length === 1, j.by_game.g2);
    /* The trap fbs.js names: "Ohio" must never swallow "Ohio State", and
       neither Miami may take the other's number. */
    chk('Miami Ohio does NOT take Miami Florida’s number',
      (j.by_game.g2 || []).every((r) => !/RedHawks/.test(r.away_team)), j.by_game.g2);
    chk('Ohio and Ohio State stay two different programs',
      (j.by_game.g3 || []).length === 1
      && /Ohio Bobcats/.test((j.by_game.g3 || [{}])[0].away_team || ''), j.by_game.g3);
    chk('a fixture for a game not on this card is refused, not attached',
      j.unresolved_names.indexOf('Alabama Crimson Tide') >= 0, j.unresolved_names);
    chk('a kickoff a week away is refused even when both teams resolve',
      /kickoff/.test(Object.keys(j.refusal_reasons).join(' ')), j.refusal_reasons);
    eq('three of the six rows joined', j.signals_joined, 3);
    eq('and the other three are refused and counted, not lost', j.signals_refused, 3);

    /* ZERO JOINED OUT OF MANY READ IS A JOIN FAULT, AND MUST SAY SO. */
    const none = I.joinSignalsToGames({
      games, signals: [sig('Alabama Crimson Tide', 'Auburn Tigers'), sig('Boise State Broncos', 'Fresno State Bulldogs')],
    });
    chk('reading rows and joining none is reported as a JOIN FAULT',
      /JOIN FAULT/.test(none.diagnosis) && /not an absence of markets/.test(none.diagnosis), none.diagnosis);
    chk('an empty read is NOT called a join fault',
      !/JOIN FAULT/.test(I.joinSignalsToGames({ games, signals: [] }).diagnosis));
    chk('the resolver is named rather than described', /fbs\.js/.test(none.resolver), none.resolver);
  }

  /* =====================================================================
     19. THE BOARD'S TWO MARKET SOURCES, RECONCILED END TO END.
     The board resolves a market from captured signals OR cfb.lines
     (fbP4Market). Counting only the first is what turned a 46-market card
     into one. All three counts must survive to the client and the prompt.
     ===================================================================== */
  {
    const fx = FX.build();
    clearCache(); route = FX.router(fx);
    const r = await m.handle(req({ mode: 'chat', question: 'Which CFB games are worth betting this week?',
      packet: { board_scope: SCOPE }, history: [] }, '?dry=1'));
    const j = await r.json();
    const si = j.data_path.slate_index;
    eq('every scheduled game is indexed from the schedule', si.slate_state.scheduled, fx.slate.games.length);
    eq('the consensus source is read for the WHOLE card, not just a shortlist',
      si.cfb_lines.game_ids_tried, fx.slate.games.length);
    eq('games carrying a market NUMBER counts both sources', si.cfb_lines.games_with_a_line, 4);
    eq('games carrying an EXECUTABLE price is the smaller number',
      si.cfb_lines.games_with_an_executable_price, 1);
    chk('the captured join is reported separately from the consensus join',
      si.signal_join && si.signal_join.signals_joined > 0, si.signal_join);
    const ms = j.data_path.slate_ranking.market_states;
    eq('and the ranking agrees with the index on lines', (ms['LINE ONLY'] || 0) + (ms['PRICED'] || 0) + (ms['PRICED (STALE)'] || 0), 4);
    eq('and on prices', (ms['PRICED'] || 0) + (ms['PRICED (STALE)'] || 0), 1);
    eq('the schedule cross-check agrees with the artifact', j.data_path.slate_index.cross_check.agrees, true);
    const p = j.prompt || '';
    chk('the prompt carries all three counts, not one',
      /games carrying a market number: 4/.test(p) && /games carrying an executable price: 1/.test(p), 
      p.slice(p.indexOf('THE SLATE'), p.indexOf('THE SLATE') + 500));
    chk('and states that a consensus line is not a price',
      /consensus line is a number, not a price|not a price to bet into/i.test(p));
  }

  /* =====================================================================
     20. AVAILABILITY IS CONNECTED, AND ITS EMPTINESS IS NOT "HEALTHY".
     football/availability/ is a real scheduled pipeline over 138 programs.
     What it currently carries — zero verified records, no official report
     anywhere, two of three sources failing per team — is itself the finding,
     and the one thing it may never become is a clean injury sheet.
     ===================================================================== */
  {
    const fx = FX.build();
    clearCache(); route = FX.router(fx);
    const r = await m.handle(req({ mode: 'chat', question: 'Analyze North Texas versus Texas State.',
      packet: { board_scope: SCOPE }, history: [] }, '?dry=1'));
    const j = await r.json();
    const dp = j.data_path.game_evidence || j.data_path.cfb_evidence || {};
    chk('the availability artifact is read, not skipped',
      (dp.availability && dp.availability.teams_indexed > 0), dp.availability);
    const pk = (j.evidence_packets || []).find((p) => /North Texas/.test(JSON.stringify(p.sections.identity)));
    chk('a packet was built', !!pk);
    if (pk) {
      const av = pk.sections.matchup.away.availability;
      chk('availability is attached to each side', av && av.missing === false, av);
      const v = (av && av.value) || {};
      chk('its state is one of the five', I.AVAIL_STATES.indexOf(v.state) >= 0, v.state);
      chk('an empty report is UNKNOWN, never a clean sheet', v.state === 'UNKNOWN', v.state);
      chk('and it says so in words a reader cannot misread',
        /THIS IS UNKNOWN, NOT HEALTHY/.test(v.sentence || ''), v.sentence);
      chk('the claim "no reported injuries" is explicitly withheld', v.may_claim_healthy === false, v);
      chk('availability never moves the projection', v.may_adjust_projection === false, v);
      chk('the failed sources are counted rather than hidden',
        v.sources_checked > 0 && v.sources_failed > 0, v);
      chk('the artifact is named as the source', /availability\/current\.json/.test(av.source || ''), av.source);
      chk('and its age is carried so staleness is visible', typeof v.artifact_age_hours === 'number', v);
    }
    const p = j.prompt || '';
    chk('the prompt gives the five states and their meanings',
      /NO_REPORTED_INJURIES an OFFICIAL report was read/.test(p) && /UNKNOWN\s+EdgeDesk looked/.test(p));
    chk('and forbids the healthy claim outside the one state that earns it',
      /Never describe a side as healthy, clean, fully available or at full strength unless the state is NO_REPORTED_INJURIES/.test(p));
    chk('the old blanket claim that no availability feed exists is gone',
      !/NO injury report exists for this sport in EdgeDesk/.test(p));

    /* A FAILED READ IS A THIRD THING, not a report and not an absence. */
    clearCache(); route = FX.router(fx, { avail: null });
    const r2 = await m.handle(req({ mode: 'chat', question: 'Analyze North Texas versus Texas State.',
      packet: { board_scope: SCOPE }, history: [] }, '?dry=1'));
    const j2 = await r2.json();
    const pk2 = (j2.evidence_packets || [])[0];
    const av2 = pk2 && pk2.sections.matchup.away.availability;
    chk('a failed availability read is declared missing with a reason',
      av2 && av2.missing === true && /not the same as nobody being hurt/.test(av2.reason || ''), av2);
  }

  done();
})().catch((e) => { console.error('CRASH', e && e.stack || e); process.exit(1); });
