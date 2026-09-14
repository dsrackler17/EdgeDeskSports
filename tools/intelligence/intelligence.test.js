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
        games.length > 0 && games.every((g) => 'opponent_sp_plus_now' in g), games[0]);
      const fcs = games.find((g) => /Nicholls/.test(g.opponent));
      chk('a blowout over a weak opponent carries that opponent’s rating',
        fcs && fcs.opponent_sp_plus_now < -10, fcs);
      /* WHEN the rating was true, not just what it says. cfb.ratings is keyed
         (season, team) with no week column, so the number is where the opponent
         stands NOW — a good answer to "how good were they really" and the wrong
         one for "what was knowable then". */
      chk('and the rating is named for the time it describes',
        games.every((g) => g.opponent_rating_time_basis === 'AS_ASSESSED_NOW'), games[0]);
      chk('the contemporary version is declared absent rather than implied',
        games.every((g) => 'opponent_sp_plus_at_the_time' in g && g.opponent_sp_plus_at_the_time === null), games[0]);
      chk('and the note says the database holds no historical version',
        /no week and no as-of column/.test(away.previous_games.note || ''), away.previous_games.note);
      /* A rename is only done when its consumers move with it. Both of these
         read the field and would have shown nothing at all — silently — while
         every assertion above went on passing. */
      const APP = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'app.html'), 'utf8');
      chk('the app reads the renamed field', /opponent_sp_plus_now/.test(APP));
      chk('and labels it as a rating from NOW rather than from then',
        /as it stands now<\/b> attached/.test(APP) && /no historical version is on file/.test(APP));
      const ANS = require('fs').readFileSync(require('path').join(__dirname, 'answer.js'), 'utf8');
      chk('the offline renderer reads it too, and says NOW', /opponent_sp_plus_now/.test(ANS) && /SP\+ NOW/.test(ANS));
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
    /* The permission sentence must use the PRICED count, not the market-number
       count: four lines and one price is permission to recommend one game. */
    chk('the recommendation permission is granted on priced games only',
      /Priced recommendations are possible on the 1 game carrying an executable price, and on those only/.test(p),
      p.slice(p.indexOf('Priced recommendations'), p.indexOf('Priced recommendations') + 160));
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

  /* =====================================================================
     21. THE KILL SWITCH IS A SWITCH, NOT A THRESHOLD.
     The documented shutdown was `configure({ ev_floor: 1 })`. That reaches a
     verdict through ONE branch, conditioned on an expected value existing —
     and under RESEARCH_LEAN a college spread usually has none. What it does
     produce is PASS, which asserts the bet was weighed and rejected.
     ===================================================================== */
  {
    const live = {
      market: 'spreads', selection: 'North Texas', game_status: 'scheduled',
      evidence: [{ field: 'quote' }, { field: 'fair' }],
      quote: { market: 'spreads', dec: 1.95, captured_at: new Date().toISOString(), book: 'DraftKings' },
      fair: { fair_probability: 0.532, method: 'SHARP_REFERENCE_DEVIG', sharp: true, label: 'Pinnacle de-vig fair' },
      confirmation: { independent_families: 3, sharp_confirmed: true },
    };
    const on = I.decide(live);
    chk('with the layer on, a decision is produced', I.DECISIONS.indexOf(on.decision) >= 0, on.decision);

    I.configure({ decisions_enabled: false });
    const off = I.decide(live);
    eq('with the layer off, there is no decision at all', off.decision, null);
    eq('and the absence is named', off.decision_state, I.DECISIONS_DISABLED);
    chk('it is explicitly NOT a judgement about the bet',
      /NOT a judgement about the bet/.test(off.why || ''), off.why);
    chk('no PASS is fabricated', off.decision !== 'PASS');
    chk('and no price is offered at which it would have been a candidate',
      off.price === null && !/price/i.test(String(off.what_would_change_it || '')), off.what_would_change_it);
    eq('it may not be written to the ledger', off.may_publish_to_ledger, false);
    chk('and the ledger validator refuses it by name',
      I.ledgerEntry({ decision: off.decision_state, game_id: 'g', market: 'spreads', selection: 'X' }).ok === false);
    chk('research is untouched by the switch',
      I.slateState({ scheduled_games: 7, games_with_quotes: 4, games_with_executable_price: 1, games_with_signals: 1 }).may_research === true);
    chk('the shutdown does not forge a config the desk never ran',
      off.config_used.ev_floor === undefined, off.config_used);
    I.configure({ decisions_enabled: true });
    eq('and it switches back on', I.decisionsEnabled(), true);
  }

  /* =====================================================================
     22. A DECISION THAT WAS NOT RECORDED SAYS SO.
     The ledger write rode along with the fire-and-forget memory write: the
     POST went out after the response, its failure was swallowed, and the
     answer showed a recommendation while implying a record that did not
     exist.
     ===================================================================== */
  {
    const row = {
      schema: 'edgedesk_recommendation_v1', kind: 'RECOMMENDATION', entry_key: 'k1',
      game_id: 'g1', market: 'spreads', selection: 'X', decision: 'BET CANDIDATE',
      mode: 'FORWARD', odds_decimal: 1.95, published_at: new Date().toISOString(),
    };
    const ok = await m.publishLedger('Bearer t', [row], async () => ({ status: 201, text: async () => '' }));
    eq('a successful write is RECORDED', ok.state, 'RECORDED');
    eq('and carries no notice, because there is nothing to warn about', ok.notice, null);

    const missing = await m.publishLedger('Bearer t', [row], async () => ({
      status: 404, text: async () => '{"message":"relation \"public.recommendation_ledger\" does not exist"}',
    }));
    eq('a failed write is NOT_RECORDED', missing.state, 'NOT_RECORDED');
    chk('and says tracking is unavailable in words a reader will understand',
      /TRACKING UNAVAILABLE/.test(missing.notice || '') && /was NOT recorded/.test(missing.notice || ''), missing.notice);
    chk('a missing table names the migration that fixes it',
      /recommendation_ledger\.sql has not been applied/.test(missing.notice || ''), missing.notice);
    chk('and it is called an operational fault, not a change to the recommendation',
      /operational fault|has not been applied/.test(missing.notice || ''), missing.notice);

    const threw = await m.publishLedger('Bearer t', [row], async () => { throw new Error('network down'); });
    eq('a thrown write is still reported rather than swallowed', threw.state, 'NOT_RECORDED');
    chk('with the underlying reason attached', /network down/.test(threw.notice || ''), threw.notice);

    eq('nothing to record is its own state',
      (await m.publishLedger('Bearer t', [])).state, 'NOTHING_TO_RECORD');

    I.configure({ decisions_enabled: false });
    const offw = await m.publishLedger('Bearer t', [row], async () => ({ status: 201, text: async () => '' }));
    eq('a switched-off layer writes nothing at all', offw.state, 'DECISIONS_DISABLED');
    eq('and records no rows', offw.rows, 0);
    I.configure({ decisions_enabled: true });

    /* And the client renders it. */
    const appHtml = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'app.html'), 'utf8');
    chk('the app renders the tracking notice next to the decisions',
      /function ledgerNoticeHTML/.test(appHtml) && /\+ledgerNoticeHTML\(d\)\+/.test(appHtml));
  }

  /* =====================================================================
     23. A MARKET NUMBER DOES NOT PROMOTE AN UNVALIDATED GAP.
     Connecting cfb.lines gives most of the college card a number to compare
     the model against for the first time. The ceiling that existed when
     there was nothing to compare against has to survive that.
     ===================================================================== */
  {
    const v = I.validationFor('americanfootball_ncaaf', 'spreads');
    eq('the college spread ceiling is still WATCH', v.max_decision, 'WATCH');
    eq('and model expected value is still refused', v.may_produce_model_ev, false);
    chk('the model is still marked experimental in this market', v.experimental === true, v);

    /* A consensus line: a real market number, and still not a price. */
    const mk = I.resolveMarket({
      signals: [], lines: [{ provider: 'consensus', spread: -3, over_under: 57.5, home_moneyline: -160, away_moneyline: 135 }],
      home_selection: 'Texas State', away_selection: 'North Texas', model_home_line: 2.4,
    });
    eq('a consensus row is a LINE, not a price', mk.market_status, 'LINE ONLY');
    eq('so nothing executable comes out of it', mk.has_executable_price, false);
    eq('and no spread odds are invented for either side', mk.spread.odds_decimal, null);
    chk('the moneyline de-vig is allowed, because BOTH sides are real numbers',
      mk.moneyline.devig && mk.moneyline.devig.ok === true, mk.moneyline.devig);
    eq('but it is still not actionable, because it has no book and no timestamp', mk.moneyline.actionable, false);

    /* The gap itself must refuse to become a probability. */
    const gap = I.ev({ dec: null, p_win: null });
    chk('a line difference alone yields no expected value',
      gap === null || gap.ev == null, gap);
    const d = I.decide({
      market: 'spreads', selection: 'North Texas', game_status: 'scheduled',
      evidence: [{ field: 'line' }],
      model: { market: 'spreads', line: 2.4, win_probability: 0.6 }, thesis_rests_on_model: true,
    });
    chk('a model thesis on a line-only game never reaches BET CANDIDATE', d.decision !== 'BET CANDIDATE', d.decision);
    eq('and produces no model expected value', d.price ? d.price.model_ev : null, null);

    const p = (await (await m.handle(req({ mode: 'chat', question: 'Which CFB games are worth betting this week?',
      packet: { board_scope: SCOPE }, history: [] }, '?dry=1'))).json()).prompt || '';
    chk('the prompt says a gap is not an edge, in this market, with the number',
      /A GAP IS NOT AN EDGE/.test(p) && /49\.94% against the close over 2,599 games/.test(p), 
      p.slice(p.indexOf('A GAP IS NOT AN EDGE'), p.indexOf('A GAP IS NOT AN EDGE') + 200));
  }

  /* =====================================================================
     24. A RETROSPECTIVE RATING IS NOT HISTORICAL EVIDENCE.
     ===================================================================== */
  {
    const now = I.ratingTimeBasis({ basis: 'AS_ASSESSED_NOW', source: 'cfb.ratings', event_when: '2026-08-30', for_evaluation: true });
    chk('a current rating attached to a past game is named as such',
      /AS IT STANDS NOW/.test(now.sentence) && /not as it stood on 2026-08-30/.test(now.sentence), now.sentence);
    chk('it is still the right number for reading that result', now.usable_for_reading_a_past_result === true);
    chk('and the wrong number for evaluating a past decision', now.usable_for_leakage_free_evaluation === false);
    chk('which is stated rather than left to be inferred',
      /EXCLUDED FROM ANY LEAKAGE-FREE CLAIM/.test(now.evaluation_note || '')
      && /may not be described as out-of-sample/.test(now.evaluation_note || ''), now.evaluation_note);
    chk('and the absence of a historical version is disclosed, not hidden',
      /no week and no as-of column/.test(now.sentence), now.sentence);

    const then = I.ratingTimeBasis({ basis: 'AT_THE_TIME', source: 'archive', event_when: '2026-08-30' });
    chk('a genuinely contemporary rating IS usable for evaluation', then.usable_for_leakage_free_evaluation === true);

    /* And the leakage check knows about it, which a timestamp alone cannot. */
    const clean = I.validateNoLookahead({ published_at: '2026-09-01T00:00:00Z', kickoff: '2026-09-02T00:00:00Z' });
    chk('a row with clean timestamps and no stated basis is clean', clean.clean === true, clean.problems);
    const leaky = I.validateNoLookahead({ published_at: '2026-09-01T00:00:00Z', kickoff: '2026-09-02T00:00:00Z', rating_time_basis: 'AS_ASSESSED_NOW' });
    chk('but the same row evaluated with today’s ratings is NOT leakage-free',
      leaky.clean === false && /not available when it was published/.test(leaky.why || ''), leaky.problems);
    chk('and leakage_free is reported as its own field', leaky.leakage_free === false);
  }

  /* =====================================================================
     25. A PACKET ARRIVES ENTIRE OR IS NAMED AS ABSENT.
     The packet block was a blind slice at 90,000 characters. Five researched
     games ran past it, so the fifth packet was severed mid-object while the
     header above it went on claiming five — the same failure as "361 items,
     130 withheld", one layer in.
     ===================================================================== */
  {
    const fx = FX.build();
    clearCache(); route = FX.router(fx);
    const j = await (await m.handle(req({ mode: 'chat', question: 'Any CFB matchups look good this week?',
      packet: { board_scope: SCOPE }, history: [] }, '?dry=1'))).json();
    const p = j.prompt || '';
    /* The section only. Later blocks have their own budgets and their own
       truncation, and this assertion is about THIS one. */
    const secOf = (txt) => {
      const a = txt.indexOf('RESEARCHED MATCHUPS');
      const b = txt.indexOf('\n\n', a);
      return a < 0 ? '' : txt.slice(a, b < 0 ? txt.length : b);
    };
    const block = secOf(p);
    const bodies = (block.match(/"sections":\{/g) || []).length;
    const header = /RESEARCHED MATCHUPS — (\d+) versioned evidence packet/.exec(block);
    chk('the header counts what was actually delivered, not what was built',
      header && Number(header[1]) === bodies, { header: header && header[1], bodies });
    chk('and every delivered packet is complete JSON, not a severed tail',
      (() => { try { JSON.parse(block.slice(block.indexOf('[{'))); return true; } catch (_) { return false; } })());
    chk('no packet is cut off mid-object', !/…\[truncated at \d+ chars\]/.test(block), block.slice(-120));

    /* Squeeze it until packets genuinely cannot fit, and check what it says. */
    ENV.EDGEDESK_EVIDENCE_MAX = '30000';
    clearCache();
    const j2 = await (await m.handle(req({ mode: 'chat', question: 'Any CFB matchups look good this week?',
      packet: { board_scope: SCOPE }, history: [] }, '?dry=1'))).json();
    delete ENV.EDGEDESK_EVIDENCE_MAX;
    const p2 = j2.prompt || '';
    chk('a tight budget still delivers whole packets',
      !/…\[truncated at \d+ chars\]/.test(secOf(p2)));
    chk('and if one does not fit, it is named rather than silently dropped',
      (() => { const b2 = secOf(p2); const h = /RESEARCHED MATCHUPS — (\d+) versioned/.exec(b2);
        const n = (b2.match(/"sections":\{/g) || []).length;
        return h && Number(h[1]) === n && (!/did NOT FIT/.test(b2) || /You do NOT have their evidence/.test(b2)); })());
    chk('the evidence block still names what it withheld rather than going quiet',
      !/EVIDENCE WITHHELD/.test(p2) || /SUBJECTS WITH NO EVIDENCE IN THIS MESSAGE AT ALL/.test(p2));
  }

  /* =====================================================================
     26. THE WHOLE REAL CARD, RECONCILED.
     Scenario 19 checks the counts on a seven-game fixture. This runs the
     desk's market resolution over the REAL committed 75-game slate — the same
     artifact the board renders — so the shape the user actually saw (75
     scheduled, most carrying a market number, far fewer carrying a price) is
     reproduced from the real file rather than from numbers typed in.
     ===================================================================== */
  {
    const slate = FX.SLATE;
    chk('the committed card is the size the board showed', slate.games.length === 75, slate.games.length);

    /* cfb.lines.spread is a BETTING number, the convention the artifact
       publishes model_home_line in, so a correctly stored row IS that number.
       Building the fixture the other way round is what a bad ingest looks
       like, and both are run here. */
    const linesFor = (offset, invert) => {
      const L = {};
      slate.games.forEach((g, i) => {
        if (i % 5 === 3 || g.model_home_line == null) return;   /* a fifth carry no line */
        const spread = g.model_home_line + offset;
        L[g.game_id] = [{ game_id: g.game_id, provider: 'consensus',
          spread: invert ? -spread : spread, over_under: 55.5, home_moneyline: -150, away_moneyline: 130 }];
      });
      return L;
    };
    const runCard = (L) => {
      const out = { lined: 0, priced: 0, none: 0, faults: 0, devig: 0, mirrored: 0 };
      slate.games.forEach((g) => {
        const mk = I.resolveMarket({ signals: [], lines: L[g.game_id] || [],
          home_selection: g.home_team, away_selection: g.away_team, model_home_line: g.model_home_line });
        if (mk.has_market_line) out.lined++; else out.none++;
        if (mk.has_executable_price) out.priced++;
        if (mk.spread.fault) out.faults++;
        if (mk.moneyline.devig && mk.moneyline.devig.ok) out.devig++;
        if (mk.spread.odds_decimal != null || mk.spread.odds_american != null) out.mirrored++;
      });
      return out;
    };

    const good = runCard(linesFor(1.5, false));
    eq('every game on the card is accounted for', good.lined + good.none, slate.games.length);
    chk('most of the card carries a market NUMBER, as the board shows', good.lined > 50, good);
    eq('and none of it carries an executable price without a captured quote', good.priced, 0);
    eq('a correctly oriented card produces no convention faults', good.faults, 0);
    chk('a two-sided consensus moneyline IS de-vigged, because both sides are real',
      good.devig === good.lined && good.devig > 50, good);
    eq('and NO spread price is ever mirrored from the other side of a handicap', good.mirrored, 0);

    /* The same card stored the wrong way round. The guard must catch the rows
       big enough to catch and must never flip one. */
    const bad = runCard(linesFor(1.5, true));
    chk('an inverted table has most of its spreads dropped rather than flipped',
      bad.faults > 30, bad);
    eq('and dropping a spread never invents an executable price', bad.priced, 0);
    chk('the games still count as carrying a market, because the total and the moneyline survive',
      bad.lined === good.lined, { bad: bad.lined, good: good.lined });
  }

  /* =====================================================================
     27. "WHAT IS THE STRONGEST ARGUMENT AGAINST THAT LEAN?"
     The deterministic attack layer read a signals row and nothing else, so a
     live, sharp-anchored, floor-clearing quote came back SURVIVES with an
     EMPTY falsifier list — and the one question a reader asks when they are
     trying not to be fooled was answered with silence. Silence there is not
     neutrality; it is the closest this system can come to manufactured
     confidence.
     ===================================================================== */
  {
    const live = {
      market: 'spreads', selection: 'North Texas', edge: 0.037, first_edge: 0.030,
      n_books: 9, has_sharp: true, last_seen_at: new Date().toISOString(),
    };
    const bare = m.attackThesis(live, 0.02, 45);
    eq('the arithmetic still survives on its own terms', bare.status, 'SURVIVES');
    eq('and with nothing passed in, there is nothing structural to report', bare.structural.length, 0);

    const withCtx = m.attackThesis(live, 0.02, 45, {
      validation: I.validationFor('americanfootball_ncaaf', 'spreads'),
      availability: [
        { team: 'North Texas', state: 'UNKNOWN' },
        { team: 'Texas State', state: 'UNKNOWN' },
      ],
      market: { has_executable_price: true, has_market_line: true, spread: { book: 'DraftKings' } },
      packet_gaps: [{ field: 'per_play_efficiency', reason: 'not ingested' },
        { field: 'success_rate', reason: 'not ingested' }],
      kickoff: new Date(Date.now() + 6 * 86400000).toISOString(),
    });
    eq('the arithmetic is unchanged by the context', withCtx.status, 'SURVIVES');
    chk('but the case against is no longer empty', withCtx.falsifiers.length > 0, withCtx.falsifiers.length);
    chk('and SURVIVES stops meaning "nothing against it"',
      /not the same as the case being strong/.test(withCtx.note), withCtx.note);

    const all = withCtx.structural.join(' | ');
    chk('the unvalidated model is named as the first limit',
      /NO validated outcome probability in this market/.test(withCtx.structural[0] || ''), withCtx.structural[0]);
    chk('and its agreement with the price is refused as corroboration',
      /agreement with the price is not corroboration/.test(all));
    chk('an UNKNOWN availability report is a risk, not a neutral',
      /North Texas: no availability report on file/.test(all) && /UNKNOWN, not healthy/.test(all), all.slice(0, 200));
    chk('and BOTH sides are named rather than "the home side"',
      /North Texas/.test(all) && /Texas State/.test(all));
    chk('the untestable matchup is stated as untestable',
      /matchup read cannot be TESTED/.test(all) && /in either direction/.test(all));
    chk('a single-book dependency is named with the book',
      /ONE captured price at DraftKings/.test(all));
    chk('and a distant kickoff is a limit, because the information has not arrived',
      /Kickoff is \d+ hours away/.test(all));

    /* A LINE-ONLY GAME HAS ITS OWN STRUCTURAL OBJECTION. */
    const lineOnly = m.attackThesis(live, 0.02, 45, {
      market: { has_executable_price: false, has_market_line: true },
    });
    chk('a market number with no price says so as a limit',
      /no executable price/.test(lineOnly.structural.join(' ')), lineOnly.structural);

    /* And it reaches the model, apart from the price-level falsifiers. */
    const fx = FX.build();
    clearCache(); route = FX.router(fx);
    const j = await (await m.handle(req({ mode: 'chat', question: 'What is the strongest argument against that lean?',
      packet: { board_scope: SCOPE },
      history: [{ role: 'user', content: 'Analyze North Texas versus Texas State.' },
        { role: 'assistant', content: 'North Texas -2.5 looks like a candidate.' }] }, '?dry=1'))).json();
    const p = j.prompt || '';
    chk('the prompt carries the structural limits as their own block',
      /STRUCTURAL LIMITS — true whatever the price does/.test(p), p.indexOf('STRUCTURAL LIMITS'));
    chk('and tells the analyst these ARE the answer to that question',
      /When you are asked for the strongest argument AGAINST a lean, these are it/.test(p));
    chk('and that surviving the arithmetic is not surviving these',
      /has NOT survived these/.test(p));
    chk('the limits name this game, not a generic one',
      /North Texas: no availability report on file|Texas State: no availability report on file/.test(p));
    chk('and an empty list still refuses a manufactured objection',
      /manufacturing an objection to look balanced|manufacture an objection to look balanced/.test(p));
  }

  /* =====================================================================
     28. THE PRODUCTION FAILURE, VERBATIM.

     Observed in the live product, with an MLB game open on the board:

       "What do you think about North Texas vs Texas State this week?
        Anything worth betting?"

     came back resolved as baseball_mlb, with North Texas, Texas State AND
     "Anything" listed as unresolved entities, MLB pitchers and bullpens
     retrieved, the requested matchup reported ABSENT, and an unrelated
     mixed-sport board offered instead.

     Every one of those is asserted against here, at the exact sentence.
     ===================================================================== */
  {
    const Q = 'What do you think about North Texas vs Texas State this week? Anything worth betting?';
    const MLB_BOARD = {
      game: { matchup: 'Baltimore Orioles @ New York Yankees', sport: 'MLB', sport_key: 'baseball_mlb',
        commence: '2026-09-15T23:05:00Z', away: 'Baltimore Orioles', home: 'New York Yankees', event_id: 'mlb-1' },
      sport_key: 'baseball_mlb', market_key: 'spreads',
      board_scope: { sport: 'baseball_mlb', label: 'today' },
    };

    /* ---- the classifier's own answer, before anything is retrieved ------ */
    const plan = m.classify(Q, 'chat');
    chk('"Anything" is not a person', (plan.entities.player_hints || []).indexOf('Anything') < 0,
      plan.entities.player_hints);
    chk('and neither is "worth" or "betting"',
      !(plan.entities.player_hints || []).some((h) => /^(worth|betting|week|game)$/i.test(h)),
      plan.entities.player_hints);
    /* The alias collision itself is unchanged and still recorded — the fix is
       that it no longer decides the sport, not that it stopped happening. */
    chk('"Texas State" still reaches the Texas Rangers through an MLB alias',
      m.resolveTeamsDetailed(Q).some((t) => t.name === 'Texas Rangers' && t.ambiguous === true),
      m.resolveTeamsDetailed(Q));
    eq('and that alias is dropped once the sport is college football',
      m.scopeTeamsToSport(m.resolveTeamsDetailed(Q), 'americanfootball_ncaaf').teams.length, 0);

    /* ---- the whole path, with a BASEBALL GAME OPEN ---------------------- */
    for (const [label, packet] of [
      ['an MLB game open on the board', MLB_BOARD],
      ['no board context at all', {}],
      ['a CFB board already open', { board_scope: SCOPE }],
    ]) {
      const fx = FX.build();
      clearCache(); route = FX.router(fx);
      const j = await (await m.handle(req({ mode: 'chat', question: Q, packet, history: [] }, '?dry=1'))).json();
      const nm = j.data_path.named_matchup;

      eq(`[${label}] the sport is college football`, j.sport, 'americanfootball_ncaaf');
      eq(`[${label}] and retrieval used that sport too, not the board's`,
        j.data_path.slate_index.sport, 'americanfootball_ncaaf');
      chk(`[${label}] the named matchup resolved against the published card`,
        nm && nm.state === 'RESOLVED' && nm.source === 'football/fbs/slate.json', nm);
      eq(`[${label}] to a canonical game id`, nm && nm.game_id, '401858900');
      chk(`[${label}] with canonical team ids on both sides`,
        nm && nm.away_id === 'northtexas' && nm.home_id === 'texasstate', nm);
      chk(`[${label}] the two teams ARE the entity scope`,
        (j.entities.teams || []).length === 2
        && j.entities.teams.indexOf('North Texas') >= 0 && j.entities.teams.indexOf('Texas State') >= 0,
        j.entities.teams);
      eq(`[${label}] no baseball club is carried`,
        (j.entities.teams || []).filter((t) => /Rangers|Orioles|Yankees/.test(t)).length, 0);
      eq(`[${label}] nothing is treated as an unresolved person`,
        (j.entities.players || []).length, 0);
      chk(`[${label}] the requested matchup is RESEARCHED, not reported absent`,
        (j.evidence_packets || []).some((p) => p.packet_id === '401858900:v1'),
        (j.evidence_packets || []).map((p) => p.packet_id));
      chk(`[${label}] the slate is not reported empty`,
        j.slate_state && j.slate_state.state !== 'NO_SCHEDULED_GAMES', j.slate_state && j.slate_state.state);
      chk(`[${label}] the prompt names the matchup as the subject`,
        /THE MATCHUP THIS QUESTION IS ABOUT: North Texas vs Texas State/.test(j.prompt || ''));
      /* The window moves with the sport. Keeping the overridden board's label
         produced "7 CFB games scheduled in today" — a baseball board's word
         for its own window, printed over a college card. */
      chk(`[${label}] and the scope window is not the overridden board's`,
        !/scheduled in today/.test(j.slate_state.sentence || ''), j.slate_state.sentence);
    }

    /* The override is REPORTED, not silent. */
    {
      const fx = FX.build();
      clearCache(); route = FX.router(fx);
      const j = await (await m.handle(req({ mode: 'chat', question: Q, packet: MLB_BOARD, history: [] }, '?dry=1'))).json();
      eq('overriding the open board is recorded as data', j.data_path.named_matchup.overrode_open_board, true);
      chk('and the prompt tells the analyst it happened',
        /reader had a DIFFERENT sport open on their board/.test(j.prompt || ''));
      chk('the MLB board scope is still echoed, so nothing is hidden',
        !!j.data_path.board_scope, j.data_path.board_scope);
    }
  }

  /* =====================================================================
     29. WHEN THE MATCHUP DOES NOT RESOLVE, ASK — DO NOT SUBSTITUTE.
     ===================================================================== */
  {
    const fx = FX.build();
    const MLB_BOARD = { sport_key: 'baseball_mlb', board_scope: { sport: 'baseball_mlb', label: 'today' } };

    clearCache(); route = FX.router(fx);
    const gone = await (await m.handle(req({ mode: 'chat',
      question: 'What about Slippery Rock vs Podunk Tech this week? Anything worth betting?',
      packet: MLB_BOARD, history: [] }, '?dry=1'))).json();
    const nmg = gone.data_path.named_matchup;
    eq('a matchup on no card is NOT_ON_ANY_CARD', nmg.state, 'NOT_ON_ANY_CARD');
    chk('both names are carried so the reader can see what was looked for',
      nmg.named.length === 2 && /Slippery Rock/.test(nmg.named.join(' ')), nmg.named);
    chk('the prompt asks ONE short clarifying question',
      /ASK ONE SHORT CLARIFYING QUESTION and stop/.test(gone.prompt || ''));
    chk('and forbids answering about a different matchup',
      /may NOT: answer about a different matchup/.test(gone.prompt || ''));
    chk('and forbids presenting a board as the answer',
      /present the slate or a ranked board as though it were the answer/.test(gone.prompt || ''));
    chk('and forbids retrieving another sport in its place',
      /retrieve and narrate another\s+sport’s evidence|retrieve and narrate another sport's evidence/.test(gone.prompt || '')
      || /another sport/.test(gone.prompt || ''));
    chk('it says how many games were actually checked',
      /\d+ games were checked on the FBS slate/.test(nmg.note || ''), nmg.note);

    /* A CARD THAT CANNOT BE READ IS A THIRD THING. */
    clearCache(); route = FX.router(fx, { slate: null });
    const broke = await (await m.handle(req({ mode: 'chat',
      question: 'What do you think about North Texas vs Texas State this week? Anything worth betting?',
      packet: MLB_BOARD, history: [] }, '?dry=1'))).json();
    eq('an unreadable card is RETRIEVAL_FAILED, not an absent game',
      broke.data_path.named_matchup.state, 'RETRIEVAL_FAILED');
    chk('and the prompt refuses to call it absent',
      /RETRIEVAL FAILURE, NOT AN ABSENT GAME/.test(broke.prompt || ''));
    chk('the reason names what could not be read',
      /could not be read/.test(broke.data_path.named_matchup.note || ''), broke.data_path.named_matchup.note);
    chk('and it is explicitly not reportable as an absence',
      /may not be reported as one/.test(broke.data_path.named_matchup.note || ''));
  }

  /* =====================================================================
     30. AND THE FOLLOW-UPS KEEP IT, WITH THE BASEBALL BOARD STILL OPEN.
     ===================================================================== */
  {
    const fx = FX.build();
    const MLB_BOARD = {
      game: { matchup: 'Baltimore Orioles @ New York Yankees', sport: 'MLB', sport_key: 'baseball_mlb',
        commence: '2026-09-15T23:05:00Z', away: 'Baltimore Orioles', home: 'New York Yankees', event_id: 'mlb-1' },
      sport_key: 'baseball_mlb', board_scope: { sport: 'baseball_mlb', label: 'today' },
    };
    const history = [];
    const seq = [
      'What do you think about North Texas vs Texas State this week? Anything worth betting?',
      'Who have they played?',
      'What price makes it a pass?',
    ];
    for (let i = 0; i < seq.length; i++) {
      clearCache(); route = FX.router(fx);
      const j = await (await m.handle(req({ mode: 'chat', question: seq[i],
        packet: MLB_BOARD, history: history.slice(-8) }, '?dry=1'))).json();
      eq(`follow-up ${i + 1} stays on college football`, j.sport, 'americanfootball_ncaaf');
      chk(`follow-up ${i + 1} keeps the matchup ("${seq[i]}")`,
        (j.evidence_packets || []).some((p) => p.packet_id === '401858900:v1'),
        (j.evidence_packets || []).map((p) => p.packet_id));
      chk(`follow-up ${i + 1} never drifts to the open baseball game`,
        !(j.entities.teams || []).some((t) => /Orioles|Yankees|Rangers/.test(t)), j.entities.teams);
      history.push({ role: 'user', content: seq[i] });
      history.push({ role: 'assistant', content: 'ok' });
    }
  }

  /* =====================================================================
     31. ONE TEAM IS THE SAME BUG WITH ONE NAME.
     "How does Texas State look this week?" has no "vs" to find, and hits the
     identical dead end: the only team resolver here knows MLB clubs, so
     "Texas State" becomes the Texas Rangers and the open board picks the
     sport. Same lookup discipline, one name.
     ===================================================================== */
  {
    const MLB_BOARD = {
      game: { matchup: 'Baltimore Orioles @ New York Yankees', sport: 'MLB', sport_key: 'baseball_mlb',
        away: 'Baltimore Orioles', home: 'New York Yankees', event_id: 'mlb-1' },
      sport_key: 'baseball_mlb', board_scope: { sport: 'baseball_mlb', label: 'today' },
    };
    for (const q of ['How does Texas State look this week?', 'Is North Texas worth a look?', 'Thoughts on Texas State?']) {
      const fx = FX.build();
      clearCache(); route = FX.router(fx);
      const j = await (await m.handle(req({ mode: 'chat', question: q, packet: MLB_BOARD, history: [] }, '?dry=1'))).json();
      eq(`"${q}" resolves to college football`, j.sport, 'americanfootball_ncaaf');
      eq(`"${q}" retrieves the same sport it reports`, j.data_path.slate_index.sport, 'americanfootball_ncaaf');
      eq(`"${q}" finds the one game that team is on`, (j.data_path.named_matchup || {}).game_id, '401858900');
      chk(`"${q}" carries no baseball club`,
        !(j.entities.teams || []).some((t) => /Orioles|Yankees|Rangers/.test(t)), j.entities.teams);
    }

    /* THE EXTRACTOR ASSERTS NOTHING — every phrase goes to the card resolver,
       and the conversational questions must produce none at all. */
    const none = ['Any CFB matchups look good?', 'What price makes it a pass?', 'Who have they played?',
      'Did opponent quality inflate their numbers?', 'What is the strongest argument against that lean?'];
    none.forEach((q) => chk(`"${q}" yields no team phrase`, m.teamishPhrases(q).length === 0, m.teamishPhrases(q)));
    chk('a leading sentence word is trimmed, not kept',
      JSON.stringify(m.teamishPhrases('Is North Texas worth a look?')) === '["North Texas"]',
      m.teamishPhrases('Is North Texas worth a look?'));
    eq('a lone bare word is never a team phrase', m.teamishPhrases('Thoughts on Miami?').length, 0);

    /* A TEAMISH PHRASE ON NO CARD FALLS THROUGH SILENTLY — it is not a finding
       worth interrupting for, because the reader may have meant a player. */
    {
      const fx = FX.build();
      clearCache(); route = FX.router(fx);
      const j = await (await m.handle(req({ mode: 'chat', question: 'How does Slippery Rock look this week?',
        packet: MLB_BOARD, history: [] }, '?dry=1'))).json();
      eq('an unknown single name does not fire the clarification path',
        (j.data_path.named_matchup || { state: 'NONE_NAMED' }).state, 'NONE_NAMED');
      chk('and no clarifying question is demanded',
        !/ASK ONE SHORT CLARIFYING QUESTION/.test(j.prompt || ''));
    }

    /* AND THE OPEN PACKET'S OWN TEAMS ARE NEVER TREATED AS A NAMED MATCHUP.
       Passing them to the card resolver made an ordinary question asked with a
       baseball game open look up "Orioles vs Yankees" on the FBS slate, fail,
       and demand a clarification for a matchup nobody named. */
    {
      const fx = FX.build();
      clearCache(); route = FX.router(fx);
      const j = await (await m.handle(req({ mode: 'chat', question: 'What do you make of this one?',
        packet: MLB_BOARD, history: [] }, '?dry=1'))).json();
      eq('an ordinary question on the open game names no matchup',
        (j.data_path.named_matchup || { state: 'NONE_NAMED' }).state, 'NONE_NAMED');
      chk('and is not interrupted by a clarification',
        !/ASK ONE SHORT CLARIFYING QUESTION/.test(j.prompt || ''));
    }
  }

  done();
})().catch((e) => { console.error('CRASH', e && e.stack || e); process.exit(1); });
