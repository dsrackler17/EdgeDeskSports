#!/usr/bin/env node
/* ===========================================================================
   THE WHOLE PATH — source to adapter to artifact to interface to AI.

   fbs_epa.test.js holds the module's own rules. This one holds the rules that
   only exist BETWEEN modules, which is where a research layer usually goes
   wrong: every surface computes a number correctly and two of them disagree,
   or a research field quietly arrives inside the request the engine prices.

     1  ONE NUMBER, FOUR SURFACES. The card on the slate, the research packet,
        the browser's reader and the AI's packet all carry the SAME value for
        the same quarterback, because they all read one object that one module
        built. This suite recomputes it from the artifact and compares.
     2  RESEARCH CANNOT MOVE A PRICED NUMBER. The request the engine prices is
        byte-identical with the EPA layer loaded and with it removed. Not
        "should be" — compared, field by field.
     3  NO FUTURE CAN ENTER A PREGAME FEATURE. Asserted on the adapter, on the
        experiment's completion buffer and on its cold start.
     4  THE REGISTRY SAYS NO. Both experiment arms are in the promotion
        registry and neither may move a line.

   Run: node football/fbs_epa/path.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
global.window = global.window || global;
require(path.join(ROOT, 'football', 'cfb_p4', 'params.js'));

const EPA = require(path.join(__dirname, 'fbs_epa.js'));
const CONTRACT = require(path.join(__dirname, 'epa_contract.js'));
const IN = require(path.join(ROOT, 'football', 'matchup', 'inputs.js'));
const PACKET = require(path.join(ROOT, 'football', 'matchup', 'packet.js'));
const FIT = require(path.join(ROOT, 'football', 'cfb_p4', 'research', 'fit_qb_epa.js'));
const PROMOTE = require(path.join(ROOT, 'football', 'validation', 'promote.js'));

let pass = 0, fail = 0;
const failures = [];
function chk(name, cond, detail) {
  if (typeof cond === 'function') {
    try { cond = cond(); } catch (e) { cond = false; detail = String((e && e.stack) || e).slice(0, 320); }
  }
  if (cond) { pass++; return; }
  fail++; failures.push(name + (detail ? ' — ' + detail : ''));
}
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } }

const INDEX = readJson(path.join(__dirname, 'index.json'));
const SEASON = INDEX ? INDEX.season : null;
const ART = SEASON != null ? readJson(path.join(__dirname, `qb_epa_${SEASON}.json`)) : null;
const SLATE = readJson(path.join(ROOT, 'football', 'fbs', 'slate.json'));
const STARTERS = SEASON != null ? readJson(path.join(ROOT, 'football', 'starters', `cfb_${SEASON}.json`)) : null;

chk('the artifact and the published slate are both present', !!(ART && SLATE));
if (!ART || !SLATE) { console.log('FAIL | nothing to test the path with'); process.exit(1); }

/* ════════════════════ 1. ONE NUMBER, FOUR SURFACES ═══════════════════════ */
(function oneNumber() {
  const withCard = SLATE.games.filter(g => g.home_qb_epa && g.home_qb_epa.state === 'MEASURED');
  chk('the published slate carries a quarterback card on its rows',
    withCard.length > 0, withCard.length + ' of ' + SLATE.games.length + ' home sides');
  chk('the slate carries the legend once rather than on every row',
    !!(SLATE.qb_epa_legend && SLATE.qb_epa_legend.pricing)
    && SLATE.games.every(g => !g.home_qb_epa || g.home_qb_epa.pricing_why === undefined));
  chk('the slate records where the layer came from and how fresh it is',
    !!(SLATE.qb_epa_source && SLATE.qb_epa_source.freshness && SLATE.qb_epa_source.priced_input === false));
  if (!withCard.length) return;

  const row = withCard[0];

  /* SURFACE A — recomputed straight from the artifact by the adapter */
  const recomputed = EPA.cardForm(EPA.quarterback({
    artifact: ART,
    starter: (STARTERS && STARTERS.teams) ? STARTERS.teams[row.home_team_id] : null,
    team_key: row.home_team_id, opponent_key: row.away_team_id,
    kickoff: row.kickoff, side: 'home'
  }));
  chk('the card on the slate is the card the adapter builds — same player',
    recomputed.identity.athlete_id === row.home_qb_epa.identity.athlete_id,
    recomputed.identity.athlete_id + ' vs ' + row.home_qb_epa.identity.athlete_id);
  chk('the card on the slate is the card the adapter builds — same EPA per dropback',
    recomputed.career.epa_per_dropback === row.home_qb_epa.career.epa_per_dropback,
    recomputed.career.epa_per_dropback + ' vs ' + row.home_qb_epa.career.epa_per_dropback);
  chk('the card on the slate is the card the adapter builds — same sample size',
    recomputed.career.dropbacks === row.home_qb_epa.career.dropbacks);

  /* SURFACE B — the research packet */
  const ctx = PACKET.loadContext({ season: SEASON });
  const pk = PACKET.build({ context: ctx, game_id: row.game_id, row });
  chk('the research packet carries a quarterback section', !!(pk.quarterback && pk.quarterback.available));
  chk('the packet reports the same EPA per dropback as the card',
    pk.quarterback.home.career.epa_per_dropback === row.home_qb_epa.career.epa_per_dropback,
    JSON.stringify([pk.quarterback.home.career.epa_per_dropback, row.home_qb_epa.career.epa_per_dropback]));
  chk('the packet reports the same player as the card',
    pk.quarterback.home.identity.athlete_id === row.home_qb_epa.identity.athlete_id);
  chk('the packet says what kind of answer the identity is, in words',
    typeof pk.quarterback.home.identity.kind_means === 'string'
    && pk.quarterback.home.identity.kind_means.length > 20);
  chk('the packet states the pricing position and it is not priced',
    pk.quarterback.pricing && pk.quarterback.pricing.points_applied === false);
  chk('the packet carries the limits a reader needs to not over-read it',
    Array.isArray(pk.quarterback.limits)
    && pk.quarterback.limits.some(l => /scramble/i.test(l))
    && pk.quarterback.limits.some(l => /garbage time/i.test(l))
    && pk.quarterback.limits.some(l => /opponent-adjust/i.test(l)));

  /* SURFACE C and D — the browser's reader and the AI's, which are the SAME
     source: tools/presentation/inline.js copies _intelligence.js into
     app.html, and presentation_sync.test.js fails when they drift. Reading the
     canonical file here therefore tests both. */
  const INTEL_SRC = fs.readFileSync(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', '_intelligence.js'), 'utf8');
  chk('the canonical intelligence library carries the quarterback reader',
    INTEL_SRC.indexOf('function qbEpaRead(') > 0);
  chk('and the research packet it builds includes the quarterback section',
    /quarterback: quarterback, input_contract: contract/.test(INTEL_SRC));
  chk('the browser copy in app.html is the same source', () => {
    const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
    return APP.indexOf('function qbEpaRead(') > 0;
  });

  /* the reader, executed, against the same card */
  const start = INTEL_SRC.indexOf('function qbEpaRead(');
  const end = INTEL_SRC.indexOf('/* The input contract, in the seven states', start);
  const fnSrc = INTEL_SRC.slice(start, end);
  const sandbox = {
    fact: (v, o) => Object.assign({ value: v, available: v != null }, o || {}),
    missingFact: (why, src) => ({ value: null, available: false, why, source: src })
  };
  vm.createContext(sandbox);
  vm.runInContext(fnSrc + '\nglobalThis.__read = qbEpaRead;', sandbox);
  const read = sandbox.__read(row.home_qb_epa, 'home', 'football/fbs/slate.json');
  chk('the AI/browser reader returns the same EPA per dropback as the card',
    read.career.epa_per_dropback.value === row.home_qb_epa.career.epa_per_dropback,
    read.career.epa_per_dropback.value + ' vs ' + row.home_qb_epa.career.epa_per_dropback);
  chk('the reader carries the sample size beside the value',
    read.career.dropbacks.value === row.home_qb_epa.career.dropbacks);
  chk('the reader marks it unpriced and says why',
    read.priced.value === false && /does not affect the fair line/.test(read.priced.basis || ''));
  chk('the reader states the cutoff it was read at',
    read.cutoff.value === row.home_qb_epa.cutoff);
  chk('an unresolved side reads as unresolved identity rather than as no history', () => {
    const r = sandbox.__read({ state: 'UNRESOLVED_IDENTITY', identity: { kind: 'UNRESOLVED', player: null },
      state_means: 'nobody to measure', cutoff: null, points_applied: false }, 'home', 'x');
    return r.state.value === 'UNRESOLVED_IDENTITY';
  });
})();

/* ═════════════ 2. RESEARCH CANNOT MOVE A PRICED NUMBER ═══════════════════ */
(function pricingIsolation() {
  const ctx = IN.load({ season: SEASON });
  chk('the assembly loaded the EPA artifact', !!ctx.fbs_epa);
  const game = SLATE.games.filter(g => g.model_status === 'PREDICTED')[0];
  chk('there is a projected game to test with', !!game);
  if (!game || !ctx.fbs_epa) return;

  const FBS = require(path.join(ROOT, 'football', 'fbs', 'fbs.js'));
  const g = {
    game_id: game.game_id, season: game.season, week: game.week,
    home_team: game.home_team, away_team: game.away_team,
    home_conference: game.home_conference, away_conference: game.away_conference,
    neutral_site: game.neutral_site, venue: game.venue, start_date: game.kickoff
  };
  const meta = {
    home: { key: game.home_team_id, is_fbs: game.home_division === 'fbs', conference: game.home_conference,
      conference_id: game.home_conference_id, group: game.home_fbs_group },
    away: { key: game.away_team_id, is_fbs: game.away_division === 'fbs', conference: game.away_conference,
      conference_id: game.away_conference_id, group: game.away_fbs_group },
    matchup_type: game.matchup_type, is_conference_game: game.is_conference_game, id: String(game.game_id)
  };
  const E = require(path.join(ROOT, 'football', 'cfb_p4', 'engine.js'));
  const st = E.newState();
  const now = Date.parse(SLATE.generated_at) || Date.now();

  const withEpa = IN.buildRequest(ctx, { game: g, meta, state: st, now });
  const ctxNoEpa = Object.assign({}, ctx, { fbs_epa: null, fbs_epa_index: null, fbs_epa_freshness: null });
  const withoutEpa = IN.buildRequest(ctxNoEpa, { game: g, meta, state: st, now });

  chk('the request the engine PRICES is byte-identical with and without the EPA layer',
    JSON.stringify(withEpa.baseline) === JSON.stringify(withoutEpa.baseline),
    'the baseline request changed when the research layer loaded');
  chk('the SHADOW request is byte-identical too — even the unpriced arm does not read it',
    JSON.stringify(withEpa.enriched) === JSON.stringify(withoutEpa.enriched));
  chk('the priced QB input is still null on both sides',
    withEpa.baseline.teams.home.qb === null && withEpa.baseline.teams.away.qb === null);
  chk('the QB pricing door is still shut',
    withEpa.qb_pricing.home.priced === false && withEpa.qb_pricing.away.priced === false
    && withEpa.qb_pricing.whitelist.length === 0);

  const epaRows = withEpa.contract.filter(r => r.field === 'qb_efficiency_history');
  chk('the efficiency history appears on the input contract', epaRows.length === 2);
  chk('and NO efficiency row is ever marked priced',
    epaRows.every(r => r.priced === false), JSON.stringify(epaRows.map(r => [r.state, r.priced])));
  chk('a measured efficiency row is RESEARCH_ONLY or STALE, never USABLE',
    epaRows.every(r => ['RESEARCH_ONLY', 'STALE', 'UNAVAILABLE', 'NOT_APPLICABLE'].indexOf(r.state) >= 0),
    JSON.stringify(epaRows.map(r => r.state)));

  /* the same claim from the other direction: the field raises information
     coverage and cannot raise priced coverage */
  const withSummary = withEpa.summary, withoutSummary = withoutEpa.summary;
  chk('adding the field raises the KNOWN count', withSummary.known > withoutSummary.known,
    withSummary.known + ' vs ' + withoutSummary.known);
  chk('and leaves the PRICED count exactly where it was',
    withSummary.priced === withoutSummary.priced,
    withSummary.priced + ' vs ' + withoutSummary.priced);
  chk('so priced coverage cannot go UP because this field exists',
    withSummary.priced_coverage <= withoutSummary.priced_coverage,
    withSummary.priced_coverage + ' vs ' + withoutSummary.priced_coverage);

  /* every published slate row tells the same story */
  chk('no slate row publishes a priced efficiency field',
    SLATE.games.every(x => (x.input_contract || [])
      .filter(r => r.field === 'qb_efficiency_history').every(r => r.priced === false)));
  chk('no slate card claims points_applied',
    SLATE.games.every(x => !x.home_qb_epa || x.home_qb_epa.points_applied === false));
})();

/* ══════════════ 3. NO FUTURE CAN ENTER A PREGAME FEATURE ═════════════════ */
(function noFuture() {
  /* the adapter: already covered in depth by fbs_epa.test.js; the claim is
     restated here on a REAL slate game, because that is the path that ships */
  const g = SLATE.games.filter(x => x.home_qb_epa && x.home_qb_epa.state === 'MEASURED')[0];
  if (g) {
    const p = EPA.quarterback({ artifact: ART, team_key: g.home_team_id, opponent_key: g.away_team_id,
      starter: (STARTERS && STARTERS.teams) ? STARTERS.teams[g.home_team_id] : null, kickoff: g.kickoff });
    const cut = Date.parse(g.kickoff);
    chk('no game in the published game log kicked off at or after this game',
      (p.game_log || []).every(r => Date.parse(r.kickoff) < cut));
    chk('the team form beside it is cut at the same moment',
      (ART.teams[g.home_team_id].offence_log || [])
        .filter(r => Date.parse(r.kickoff) < cut).length === p.team.season_games);
  }

  /* the experiment harness */
  const cold = FIT.coldState();
  chk('the experiment starts from a state with no shipped seed ratings',
    Object.keys(cold.r).length === 0 && Object.keys(cold.n).length === 0
    && Object.keys(cold.conf || {}).length === 0);
  chk('and the harness refuses to run if a seed ever survives', () => {
    const P = global.EDCfbP4Params;
    const bad = FIT.coldState();
    bad.r[Object.keys(P.rating.seed_ratings)[0]] = 1;
    try { FIT.assertColdStart(bad); return false; } catch (_) { return true; }
  });
  chk('a clean cold state passes its own assertion', () => { FIT.assertColdStart(FIT.coldState()); return true; });

  /* the completion buffer: two games at one kickoff cannot see each other */
  chk('a game is not history until its completion buffer has passed', () => {
    const seen = [];
    const h = FIT.History(g2 => seen.push(g2.id));
    const t = Date.parse('2026-09-05T16:00:00Z');
    h.push({ id: 'A', finishedAt: t + FIT.COMPLETION_HOURS * 3600000 });
    h.push({ id: 'B', finishedAt: t + FIT.COMPLETION_HOURS * 3600000 });
    h.releaseBefore(t);                       /* B's own kickoff: A has not finished */
    if (seen.length !== 0) return false;
    h.releaseBefore(t + FIT.COMPLETION_HOURS * 3600000);
    return seen.length === 2;
  });
  chk('the buffer is a real number of hours, not zero', FIT.COMPLETION_HOURS >= 3);

  /* the published experiment artifact */
  const EXP = readJson(path.join(ROOT, 'football', 'cfb_p4', 'research', 'qb_epa.json'));
  chk('the experiment published an artifact', !!EXP);
  if (EXP) {
    chk('it names all five closed leaks', () => {
      const f = EXP.method.leak_fixes;
      return ['seeded_ratings', 'season_wide_centre', 'actual_participant',
        'selection_on_evaluation_folds', 'same_kickoff_absorption']
        .every(k => typeof f[k] === 'string' && /closed/.test(f[k]));
    });
    chk('the two arms are published separately and never pooled',
      !!(EXP.arms.pregame && EXP.arms.participant)
      && EXP.arms.pregame.pooled.games !== EXP.arms.participant.pooled.games);
    chk('the pregame arm is the one the rule judges',
      /PREGAME arm/i.test(EXP.promotion_rule.conditions.join(' ')));
    chk('the rule was declared before the result', EXP.promotion_rule.declared_before_the_result === true);
    chk('the selection is nested, and each fold publishes what it chose',
      EXP.arms.pregame.folds.every(f => f.selected == null || typeof f.selected === 'string')
      && EXP.arms.pregame.folds.some(f => Array.isArray(f.inner_ranking) && f.inner_ranking.length));
    chk('every outer fold’s inner seasons are strictly earlier than the fold itself',
      EXP.arms.pregame.folds.every(f => (f.inner_seasons || []).every(y => y < f.season)));
    chk('paired uncertainty is published, not just a point estimate',
      !!(EXP.arms.pregame.pooled.paired && Array.isArray(EXP.arms.pregame.pooled.paired.ci95)));
    chk('both sign conventions are stated so a null cannot be read as a win',
      /NEGATIVE is better/.test(EXP.sign_convention) && /POSITIVE is better/.test(EXP.sign_convention));
    chk('the explored seasons are labelled exploratory, not a fresh holdout',
      Array.isArray(EXP.method.exploratory.seasons) && /EXPLORATORY/.test(EXP.method.exploratory.why));
    chk('the residual dependencies are declared rather than implied',
      Array.isArray(EXP.method.residual_dependencies) && EXP.method.residual_dependencies.length >= 3);
    chk('subgroup results are published with their own sample sizes',
      Object.keys(EXP.arms.pregame.subgroups).length >= 6);
    chk('a subgroup the arm structurally cannot see says so instead of "too few games"',
      !EXP.arms.pregame.subgroups.transfer_involved.games
        ? /STRUCTURAL/.test(EXP.arms.pregame.subgroups.transfer_involved.why) : true);
    chk('the artifact carries its own decision and it is not applied',
      EXP.points_applied === false && typeof EXP.decision === 'string');
  }
})();

/* ═════════════════════ 4. THE REGISTRY SAYS NO ═══════════════════════════ */
(function registry() {
  const REG = readJson(path.join(ROOT, 'football', 'validation', 'feature-status.json'));
  chk('the promotion registry is published', !!REG);
  if (!REG) return;
  const names = REG.features.map(f => f.feature);
  chk('both experiment arms are in the registry',
    names.indexOf('qb_epa_pregame_v1') >= 0 && names.indexOf('qb_epa_participant_v1') >= 0, names.join(','));
  chk('neither arm may move a line',
    REG.features.filter(f => /^qb_epa_/.test(f.feature)).every(f => f.may_move_lines === false));
  chk('the participant arm is marked leakage-failed rather than quietly scored',
    (REG.features.filter(f => f.feature === 'qb_epa_participant_v1')[0] || {})
      .conditions_failed.indexOf('leakage') >= 0);
  chk('an arm that fails its leakage test cannot be a CANDIDATE', () => {
    const v = PROMOTE.evaluate({ feature: 'x', spread_mae: 1, brier: 0.1, leakage_clean: false,
      paired: { p: 0.001 }, per_season: [{ season: 1, n: 10, mae_before: 2, mae_after: 1 },
        { season: 2, n: 10, mae_before: 2, mae_after: 1 }] },
    { spread_mae: 2, brier: 0.1 });
    return v.status === 'RESEARCH_ONLY' && v.may_move_lines === false;
  });
  chk('nothing at all is VALIDATED', REG.validated_count === 0 && REG.summary.VALIDATED.length === 0);
  chk('the registry statement still says no feature moves a number',
    /changes no projected number/i.test(REG.statement));
  chk('the contract agrees with the registry: the EPA series is not a priced input',
    CONTRACT.COMPATIBILITY.priced_input === false);
})();

/* ─────────────────────────────────────────────────────────────── report ── */
console.log(`\nfbs_epa path: ${pass} passed, ${fail} failed`);
if (fail) { failures.forEach(f => console.log('  FAIL | ' + f)); process.exit(1); }
process.exit(0);
