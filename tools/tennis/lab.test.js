#!/usr/bin/env node
/* ===========================================================================
   lib/tennis_lab.js — the research engine, proven.

   These are the rules the product's honesty rests on, checked as arithmetic
   rather than asserted in a comment:

     SHRINKAGE       a player with six clay matches cannot be called a clay
                     specialist, and the adjustment shrinks monotonically with
                     the sample rather than at some threshold.
     SCHEDULE        a winning streak against a weaker field is NOT classified
                     as improvement. This is the single rule that separates a
                     research product from a momentum chart.
     NO SILENT ZERO  an absent input stays absent through translation,
                     trajectory, workload, projection and the comparison card.
                     A null must never become a 0 and a 0 must never be read
                     as "unknown".
     NOT MEDICINE    the workload classifier never claims an injury, and says
                     so in its own output.
     UNCERTAINTY     more data narrows the band; no amount of data closes it,
                     because the estimator is wrong on its own test set.
     POINT IN TIME   a projection is a pure function of the inputs handed to
                     it — it cannot reach for anything, so a cutoff enforced by
                     the caller cannot be undermined here.
     ONE ENGINE      the feature names this file labels are exactly the ones
                     lib/tennis_model.js fits. A retrain that changes the
                     vector fails here rather than rendering "d_sos" to a user.

   Run: node tools/tennis/lab.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const L = require(path.join(__dirname, '..', '..', 'lib', 'tennis_lab.js'));
const M = require(path.join(__dirname, '..', '..', 'lib', 'tennis_model.js'));

let pass = 0, fail = 0; const failures = [];
function chk(name, cond, detail) {
  if (typeof cond === 'function') { try { cond = cond(); } catch (e) { cond = false; detail = String(e && e.stack || e).slice(0, 300); } }
  if (cond) { pass++; return; }
  fail++; failures.push(name + (detail ? ' — ' + detail : ''));
}
function eq(a, b, name) { chk(name, a === b, 'got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b)); }
function near(a, b, tol, name) { chk(name, Math.abs(Number(a) - Number(b)) <= tol, 'got ' + a + ', want ~' + b); }

/* ───────────────────────── ONE ENGINE, ONE VECTOR ─────────────────────── */
chk('every model feature has a label for the studio',
  M.FEATURE_NAMES.every((n) => L.FEATURE_META[n] && L.FEATURE_META[n].label),
  'unlabelled: ' + M.FEATURE_NAMES.filter((n) => !L.FEATURE_META[n]).join(','));
chk('the lab labels no feature the model does not fit',
  Object.keys(L.FEATURE_META).every((n) => M.FEATURE_NAMES.indexOf(n) >= 0),
  'orphaned: ' + Object.keys(L.FEATURE_META).filter((n) => M.FEATURE_NAMES.indexOf(n) < 0).join(','));
eq(Object.keys(L.FEATURE_META).length, M.FEATURE_NAMES.length, 'the two lists are the same length');
chk('sideInputs produces exactly the keys featureVector reads',
  M.MODEL_INPUTS.every((k) => Object.prototype.hasOwnProperty.call(L.sideInputs({}, 'hard'), k)),
  'missing: ' + M.MODEL_INPUTS.filter((k) => !(k in L.sideInputs({}, 'hard'))).join(','));
chk('the documented scale matches the model’s own',
  L.POWER_SCALE.text === M.ratingScaleText() || L.POWER_SCALE.text.slice(0, 60) === M.ratingScaleText().slice(0, 60),
  'the page and the model quote different definitions of the power rating');
eq(L.POWER_SCALE.full_sample, M.RATING_FULL_SAMPLE, 'and the same full-sample threshold');

/* ───────────────────────────── SURFACE TRANSLATION ─────────────────────── */
function player(o) {
  return Object.assign({
    player_id: 'p', tour: 'ATP', full_name: 'P', elo: 1800, elo_sample: 200, rating_sample: 200,
    hard_elo: 1800, clay_elo: 1800, grass_elo: 1800, carpet_elo: null,
    hard_sample: 100, clay_sample: 100, grass_sample: 40, carpet_sample: 0,
    form_30d: 0.6, form_90d: 0.6, form_365d: 0.6, form_sample_365d: 50,
    matches_7d: 1, matches_14d: 3, rest_days: 4, days_since_last_match: 4,
    official_rank: 20, official_rank_points: 2000,
    serve_strength: 0.62, return_strength: 0.40,
    sos_elo_recent: 1750, sos_elo_career: 1750, latest_age: 26
  }, o || {});
}
{
  /* A deep clay sample is trusted in full. */
  const deep = L.surfaceTranslation(player({ clay_elo: 1900, clay_sample: 100 }));
  near(deep.surfaces.clay.raw_delta, 100, 0.01, 'the raw clay delta is the plain difference');
  near(deep.surfaces.clay.adjustment, 100, 0.01, 'and a deep sample is not shrunk');

  /* The same +100 over six matches is shrunk hard. */
  const thin = L.surfaceTranslation(player({ clay_elo: 1900, clay_sample: 6 }));
  near(thin.surfaces.clay.raw_delta, 100, 0.01, 'the raw delta is reported unshrunk, so nothing is hidden');
  chk('a six-match clay record is shrunk toward the baseline',
    thin.surfaces.clay.adjustment < 30, 'adjustment was ' + thin.surfaces.clay.adjustment);
  chk('and carries a higher uncertainty than a deep one',
    thin.surfaces.clay.uncertainty > deep.surfaces.clay.uncertainty);
  chk('and a wider band', thin.surfaces.clay.band > deep.surfaces.clay.band);

  /* Monotonic: more matches, more of the raw delta is claimed. */
  const adjs = [1, 3, 6, 12, 25, 60].map((n) =>
    L.surfaceTranslation(player({ clay_elo: 1900, clay_sample: n })).surfaces.clay.adjustment);
  chk('the adjustment rises monotonically with the sample',
    adjs.every((v, i) => i === 0 || v >= adjs[i - 1]), adjs.join(' -> '));

  /* A surface never played is ABSENT, not zero and not "average". */
  const none = L.surfaceTranslation(player({ carpet_elo: null, carpet_sample: 0 }));
  eq(none.surfaces.carpet.elo, null, 'an unplayed surface has a null rating, not a zero');
  eq(none.surfaces.carpet.adjustment, null, 'and a null adjustment');
  eq(none.surfaces.carpet.known, false, 'and is flagged unknown');
  chk('and is named in the missing list', none.missing.indexOf('carpet_elo') >= 0);
  chk('an unplayed surface cannot be the player’s best',
    !none.best || none.best.surface !== 'carpet');

  /* A player with no overall rating cannot be translated at all. */
  const norating = L.surfaceTranslation(player({ elo: null }));
  eq(norating.baseline_elo, null, 'no baseline means no translation');
  chk('and says so', norating.missing.indexOf('overall_elo') >= 0);

  /* Versatility reads the spread, and only over surfaces actually played. */
  const spread = L.surfaceTranslation(player({ clay_elo: 1950, grass_elo: 1650, clay_sample: 80, grass_sample: 80 }));
  chk('a wide surface spread is called surface-dependent',
    spread.versatility && spread.versatility.label === 'Surface-dependent', JSON.stringify(spread.versatility));
  const flat = L.surfaceTranslation(player({ clay_elo: 1805, hard_elo: 1798, grass_elo: 1802 }));
  chk('a flat one is called versatile',
    flat.versatility && flat.versatility.label === 'Versatile', JSON.stringify(flat.versatility));
}

/* ─────────────────── TRAJECTORY: the schedule-strength rule ─────────────── */
{
  /* Up, on a comparable schedule -> improving. */
  const up = L.trajectory(player({ form_30d: 0.85, form_90d: 0.80, form_365d: 0.62,
    form_sample_365d: 40, sos_elo_recent: 1755, sos_elo_career: 1750 }));
  eq(up.klass, 'improving', 'a rise on a comparable schedule is improvement');
  eq(up.direction, 1, 'and its direction is positive');

  /* The SAME rise, but the field got 60 Elo weaker -> NOT improvement. */
  const soft = L.trajectory(player({ form_30d: 0.85, form_90d: 0.80, form_365d: 0.62,
    form_sample_365d: 40, sos_elo_recent: 1690, sos_elo_career: 1750 }));
  eq(soft.klass, 'above_sustainable', 'the same rise over a softer draw is NOT improvement');
  chk('and the reason names the schedule', /weaker/.test(soft.why.join(' ')));
  chk('and the shift is quantified', soft.schedule_shift && soft.schedule_shift.label === 'easier');

  /* Down, on a harder schedule -> not decline. */
  const hard = L.trajectory(player({ form_30d: 0.40, form_90d: 0.45, form_365d: 0.66,
    form_sample_365d: 40, sos_elo_recent: 1830, sos_elo_career: 1750 }));
  eq(hard.klass, 'below_ability', 'a slump against a harder draw is not called decline');
  chk('and the reason names the schedule', /stronger/.test(hard.why.join(' ')));

  const down = L.trajectory(player({ form_30d: 0.40, form_90d: 0.45, form_365d: 0.66,
    form_sample_365d: 40, sos_elo_recent: 1745, sos_elo_career: 1750 }));
  eq(down.klass, 'declining', 'a slump on a comparable schedule is decline');

  const flat = L.trajectory(player({ form_30d: 0.62, form_90d: 0.61, form_365d: 0.60, form_sample_365d: 40 }));
  eq(flat.klass, 'stable', 'horizons that agree are stable');

  /* Inactivity beats everything: no current form can be claimed. */
  const back = L.trajectory(player({ days_since_last_match: 200, form_30d: 0.9, form_365d: 0.5, form_sample_365d: 40 }));
  eq(back.klass, 'returning', 'a long absence is "returning", not a trend');
  chk('and says the numbers predate the gap', /before that gap/.test(back.why.join(' ')));
  eq(back.confidence, 'low', 'with low confidence');

  /* Too little on file -> unknown, never a guess. */
  const thin = L.trajectory(player({ form_sample_365d: 4 }));
  eq(thin.klass, 'unknown', 'four matches in a year is not a trend');
  chk('and says how many it needs', /12|twelve/.test(thin.why.join(' ')));

  /* Confidence scales with sample. */
  chk('confidence rises with the sample',
    L.trajectory(player({ form_sample_365d: 14, form_30d: 0.6, form_365d: 0.6 })).confidence === 'medium'
    && L.trajectory(player({ form_sample_365d: 60, form_30d: 0.6, form_365d: 0.6 })).confidence === 'high');
}

/* ─────────────────────── WORKLOAD: a calendar, not a body ──────────────── */
{
  eq(L.workload(player({ matches_7d: 5, matches_14d: 7, rest_days: 0 })).klass, 'heavy', 'five in seven days is heavy');
  eq(L.workload(player({ matches_7d: 2, matches_14d: 9, rest_days: 1 })).klass, 'heavy', 'nine in fourteen is heavy');
  eq(L.workload(player({ matches_7d: 4, matches_14d: 5, rest_days: 1 })).klass, 'elevated', 'four in seven is elevated');
  eq(L.workload(player({ matches_7d: 0, matches_14d: 1, rest_days: 9 })).klass, 'fresh', 'nine days off is fresh');
  eq(L.workload(player({ matches_7d: 2, matches_14d: 4, rest_days: 3 })).klass, 'normal', 'a routine week is normal');

  const unknown = L.workload({ matches_7d: null, matches_14d: null, rest_days: null });
  eq(unknown.klass, 'unknown', 'no schedule data is UNKNOWN, never defaulted to normal');
  chk('and says so plainly', /No recent-schedule data/.test(unknown.why.join(' ')));

  const heavy = L.workload(player({ matches_7d: 6, matches_14d: 10, rest_days: 0 }));
  eq(heavy.is_injury_claim, false, 'the classifier declares it is not an injury claim');
  chk('and says so in its own words', /not an injury or fitness report/.test(heavy.why.join(' ')));
  ['injured', 'hurt', 'fitness concern', 'doubtful', 'risk of injury'].forEach(
    (w) => chk('the workload output never says "' + w + '"',
      heavy.why.join(' ').toLowerCase().indexOf(w) < 0));

  /* A long absence is not a light workload. */
  const idle = L.workload(player({ matches_7d: 0, matches_14d: 0, rest_days: 300, days_since_last_match: 300 }));
  eq(idle.klass, 'unknown', 'an inactive player is not "Fresh"');
  chk('and the label says why', /inactive/i.test(idle.label));

  /* A forward-dated match yields no rest figure, but the COUNTS still classify. */
  const fwd = L.workload(player({ matches_7d: 5, matches_14d: 6, rest_days: -7, days_since_last_match: -7 }));
  eq(fwd.rest_days, null, 'a negative rest is refused rather than printed');
  eq(fwd.klass, 'heavy', 'but the match counts still classify the workload');
  chk('and the date problem is named as a data-quality issue',
    fwd.data_quality && fwd.data_quality[0].signal === 'future_dated_match');
  chk('and rest is listed as missing', fwd.missing.indexOf('rest_days') >= 0);
}

/* ─────────────────────────── MATCHUP PROJECTION ────────────────────────── */
{
  const A = player({ player_id: 'a', full_name: 'A', elo: 2000, hard_elo: 2050, clay_elo: 1900,
    hard_sample: 200, clay_sample: 150, hard_win_pct: 0.75, clay_win_pct: 0.60, official_rank: 4 });
  const B = player({ player_id: 'b', full_name: 'B', elo: 1900, hard_elo: 1850, clay_elo: 1990,
    hard_sample: 180, clay_sample: 160, hard_win_pct: 0.62, clay_win_pct: 0.74, official_rank: 15 });

  const hard = L.projectMatchup(A, B, { surface: 'hard', best_of: 3 });
  const clay = L.projectMatchup(A, B, { surface: 'clay', best_of: 3 });
  chk('a projection returns a probability', hard.prob_a > 0 && hard.prob_a < 1);
  chk('the two probabilities sum to one', Math.abs(hard.prob_a + hard.prob_b - 1) < 0.001);
  chk('the SURFACE changes the answer', hard.prob_a > clay.prob_a + 0.05,
    'hard ' + hard.prob_a + ' vs clay ' + clay.prob_a);
  chk('A is favoured on hard and B gains on clay', hard.favoured === 'a' && clay.prob_a < hard.prob_a);

  /* Format matters, through the interaction term. */
  const bo5 = L.projectMatchup(A, B, { surface: 'hard', best_of: 5 });
  chk('best-of-five changes the projection', Math.abs(bo5.prob_a - hard.prob_a) > 0.001);

  /* Drivers are attributed and ordered. */
  chk('the projection is attributed to drivers', hard.drivers.length >= 3);
  chk('drivers are ordered by absolute contribution',
    hard.drivers.every((d, i) => i === 0 || Math.abs(d.contribution) <= Math.abs(hard.drivers[i - 1].contribution)));
  chk('every driver has a human label',
    hard.drivers.every((d) => d.label && !/^d_/.test(d.label)),
    'raw feature names leaked: ' + hard.drivers.map((d) => d.label).join(','));

  /* The uncertainty floor: perfect data does not buy certainty. */
  eq(hard.data_uncertainty, 0, 'two deep records with every feature present have no DATA uncertainty');
  chk('but the published uncertainty is still floored',
    hard.uncertainty >= L.MODEL_FLOOR_UNCERTAINTY, 'got ' + hard.uncertainty);
  chk('and the band never closes', hard.band >= L.MODEL_FLOOR_BAND, 'got ' + hard.band);
  chk('no projection can ever publish a zero band', hard.band > 0);

  /* Thin records widen it. */
  const thinA = Object.assign({}, A, { rating_sample: 4 });
  const thin = L.projectMatchup(thinA, B, { surface: 'hard', best_of: 3 });
  chk('a thin record widens the band', thin.band > hard.band, thin.band + ' vs ' + hard.band);
  chk('and raises the uncertainty', thin.uncertainty > hard.uncertainty);

  /* Missing inputs are NAMED and counted, never imputed as levels. */
  const gappy = Object.assign({}, B, { serve_strength: null, return_strength: null, form_90d: null });
  const g = L.projectMatchup(A, gappy, { surface: 'hard', best_of: 3 });
  chk('missing inputs are named', g.missing.length >= 3, JSON.stringify(g.missing));
  chk('a missing feature is not a driver',
    g.drivers.every((d) => g.missing.indexOf(d.feature) < 0));
  chk('coverage falls when features are missing', g.coverage < hard.coverage);
  chk('and the card lists what was absent', /Missing from this projection/.test(g.why.join(' ')));

  /* Below a quarter of the model's weight, it declines rather than guesses. */
  const bare = { player_id: 'x', tour: 'ATP', full_name: 'X', elo: 1800, rating_sample: 20 };
  const bare2 = { player_id: 'y', tour: 'ATP', full_name: 'Y', elo: 1700, rating_sample: 20 };
  const dec = L.projectMatchup(bare, bare2, { surface: 'clay' });
  eq(dec.method, 'declined', 'a projection with almost no inputs is DECLINED, not guessed');
  eq(dec.prob_a, null, 'and publishes no probability at all');
  eq(dec.uncertainty, 1, 'with maximum uncertainty');

  /* Stability: when the band swallows the lean, say so. */
  const close = L.projectMatchup(
    Object.assign({}, A, { elo: 1900, hard_elo: 1900, official_rank: 15, rating_sample: 8 }),
    Object.assign({}, B, { elo: 1898, hard_elo: 1899, official_rank: 15, rating_sample: 8 }),
    { surface: 'hard', best_of: 3 });
  eq(close.stability, 'unstable', 'a near-coin-flip between thin records is unstable');
  eq(close.crosses_even, true, 'and its band crosses even money');
  chk('and the card says it does not lean reliably',
    /does not lean reliably/.test(close.why.join(' ')));

  /* Refusals that protect the reader. */
  const cross = L.projectMatchup(A, Object.assign({}, B, { tour: 'WTA' }), { surface: 'hard' });
  eq(cross.prob_a, null, 'EdgeDesk refuses to project across tours');
  chk('and says why', /separate scales/.test(cross.why.join(' ')));
  const self = L.projectMatchup(A, A, { surface: 'hard' });
  eq(self.prob_a, null, 'a player cannot be projected against themselves');

  /* PURITY: the projection cannot reach for anything. Same inputs, same answer,
     regardless of the clock or of any surrounding state. */
  const r1 = L.projectMatchup(A, B, { surface: 'hard', best_of: 3 });
  const r2 = L.projectMatchup(JSON.parse(JSON.stringify(A)), JSON.parse(JSON.stringify(B)), { surface: 'hard', best_of: 3 });
  eq(r1.prob_a, r2.prob_a, 'the projection is a pure function of its inputs');
  chk('it reads no clock', r1.as_of === null && r2.as_of === null);

  /* The counter-argument is always produced. */
  chk('the underdog’s path is always stated', typeof hard.path === 'string' && hard.path.length > 20);

  /* The vocabulary. */
  const words = hard.why.join(' ') + ' ' + hard.path;
  chk('the projection says "EdgeDesk projects"', /EdgeDesk projects/.test(words));
  ['pick', 'lock', 'guaranteed', 'will win', 'best bet'].forEach(
    (w) => chk('the projection never says "' + w + '"', words.toLowerCase().indexOf(w) < 0));
}

/* ─────────────────── SURFACE FALLBACK: absent is not average ───────────── */
{
  const A = player({ hard_elo: null, hard_sample: 0 });
  const si = L.sideInputs(A, 'hard');
  eq(si.surface_elo_pre, null, 'asking for a surface the player has never played yields null, not the overall Elo');
  const noSurf = L.sideInputs(A, null);
  eq(noSurf.surface_elo_pre, A.elo, 'but a surface-agnostic question falls back to the overall rating');
}

/* ───────────────────────────── COMPARISON CARD ─────────────────────────── */
{
  const A = player({ player_id: 'a', full_name: 'A', power_rating: 80, hard_elo: 2000, hard_sample: 120, official_rank: 3 });
  const B = player({ player_id: 'b', full_name: 'B', power_rating: 60, hard_elo: 1800, hard_sample: 90, official_rank: 40 });
  const c = L.compareCard(A, B, { surface: 'hard' });
  chk('the card compares every declared row', c.rows.length === L.COMPARE_ROWS.length);
  chk('a higher rating wins its row', c.rows.find((r) => r.key === 'power_rating').edge === 'a');
  chk('a LOWER official ranking wins its row',
    c.rows.find((r) => r.key === 'official_rank').edge === 'a',
    'rank 3 must beat rank 40 even though 3 < 40');
  chk('a missing value wins nothing',
    L.compareCard(Object.assign({}, A, { serve_strength: null }), B, { surface: 'hard' })
      .rows.find((r) => r.key === 'serve_strength').edge === null);
  chk('and is reported as missing',
    L.compareCard(Object.assign({}, A, { serve_strength: null }), B, { surface: 'hard' })
      .rows_missing.indexOf('Serve strength') >= 0);
  chk('the card refuses to be read as a probability', /not a projection/.test(c.note));
  chk('edges are counted for both sides', c.edges_a > 0 && c.edges_b >= 0);
}

/* ───────────────────────────── COMPARABLES ─────────────────────────────── */
{
  const t = { elo_gap: 150, surface: 'clay', best_of: 3, level: 'A', environment: 'outdoor' };
  const same = L.comparability(t, t);
  const other = L.comparability(t, { elo_gap: 600, surface: 'grass', best_of: 5, level: 'G', environment: 'indoor' });
  chk('an identical setup scores near one', same.score > 0.95, 'got ' + same.score);
  chk('a different one scores far lower', other.score < 0.3, 'got ' + other.score);
  chk('similarity names its reasons', same.reasons.length >= 3);
  chk('comparability never reads the RESULT',
    Object.keys(L.comparability({ elo_gap: 100, winner: 'a' }, { elo_gap: 100, winner: 'b' })).join() ===
    Object.keys(L.comparability({ elo_gap: 100 }, { elo_gap: 100 })).join(),
    'a winner field must not change the similarity contract');
}

/* ──────────────────────── THE BRIEF: no odds, no fixtures ──────────────── */
{
  const trends = L.buildBrief({ tour: 'ATP', movers: [{ player_id: 'a', full_name: 'A', delta: 3.2, sample: 40, uncertainty: 0.1 }] });
  eq(trends.tier, 'trends', 'with no schedule the brief falls back to trends');
  chk('and says no schedule was available', /No verified schedule/.test(trends.note || ''));
  eq(trends.contains_odds, false, 'a brief never contains odds');
  eq(trends.contains_selections, false, 'and never contains selections');

  const hist = L.buildBrief({ tour: 'WTA' });
  eq(hist.tier, 'historical', 'with nothing at all it is a historical brief');
  chk('and still produces a document', hist.sections !== undefined);

  const sched = L.buildBrief({ tour: 'ATP', scheduled_matches: [
    { player_a_name: 'A', player_b_name: 'B', match_ref: 'm1', surface: 'clay', best_of: 3, prob_a: 0.62 }] });
  eq(sched.tier, 'scheduled', 'a verified schedule produces a scheduled brief');
  chk('whose first section is matches worth researching',
    sched.sections[0] && sched.sections[0].key === 'matches');
  chk('and which does NOT claim no schedule exists', !sched.note);
  chk('section titles never say "picks"',
    L.BRIEF_SECTIONS.every((s) => !/pick|bet|lock/i.test(s.title)));
}

/* ───────────────────────────── FRESHNESS / QUALITY ─────────────────────── */
{
  const now = '2026-09-19T12:00:00Z';
  eq(L.freshness('2026-09-19T06:00:00Z', now).state, 'fresh', 'six hours old is fresh');
  eq(L.freshness('2026-09-16T06:00:00Z', now).state, 'aging', 'three days old is aging');
  eq(L.freshness('2026-08-01T06:00:00Z', now).state, 'stale', 'seven weeks old is stale');
  eq(L.freshness(null, now).state, 'unknown', 'no timestamp is unknown, not fresh');

  const q = L.qualitySignals(player({ rating_sample: 4, official_rank: null, serve_strength: null,
    days_since_last_match: 300, hard_sample: 0 }), { surface: 'hard' });
  const kinds = q.map((x) => x.signal);
  ['sample_size', 'missing_ranking', 'missing_serve_stats', 'inactive', 'low_surface_experience']
    .forEach((s) => chk('quality signals include ' + s, kinds.indexOf(s) >= 0, 'got ' + kinds.join(',')));
  chk('every signal carries a severity and a detail',
    q.every((x) => x.severity && x.detail));
  chk('the declared signal list covers what is emitted',
    kinds.every((k) => L.QUALITY_SIGNALS.indexOf(k) >= 0), 'undeclared: ' + kinds.join(','));
}

/* ───────────────────────── NO SILENT ZERO, ANYWHERE ────────────────────── */
{
  /* The single rule with the widest blast radius, checked across every entry
     point: a null input must never surface as a 0, and a real 0 must never be
     reported as missing. */
  const nulled = { player_id: 'n', tour: 'ATP', full_name: 'N', elo: null, hard_elo: null,
    form_30d: null, form_90d: null, form_365d: null, matches_7d: null, matches_14d: null,
    rest_days: null, serve_strength: null, return_strength: null, official_rank: null,
    rating_sample: 0, days_since_last_match: null };
  const si = L.sideInputs(nulled, 'hard');
  chk('no null input becomes a zero in the feature inputs',
    Object.keys(si).every((k) => si[k] === null || si[k] === undefined),
    'became a value: ' + Object.keys(si).filter((k) => si[k] != null).map((k) => k + '=' + si[k]).join(','));
  const t = L.surfaceTranslation(nulled);
  eq(t.baseline_elo, null, 'translation of a null rating stays null');
  const w = L.workload(nulled);
  eq(w.klass, 'unknown', 'workload from nulls is unknown');

  /* And the converse: a genuine zero is a measurement. */
  const zeroed = player({ matches_7d: 0, matches_14d: 0, rest_days: 0 });
  const wz = L.workload(zeroed);
  eq(wz.matches_7d, 0, 'a real zero survives as zero');
  chk('and is not reported as missing', wz.missing.indexOf('matches_7d') < 0);
  chk('zero matches in seven days is not "unknown"', wz.klass !== 'unknown');
  /* num() must keep the distinction at the bottom of the stack. */
  eq(M.num('0'), 0, 'the string "0" is the number zero');
  eq(M.num(''), null, 'an empty cell is absent');
  eq(M.num('NA'), null, 'and so is NA');
}

/* ─────────────────────────────── the modes ─────────────────────────────── */
{
  eq(L.LAB_MODES.length, 9, 'the brief asks for nine ways to rank a tour');
  chk('every mode has a key, a label and a blurb',
    L.LAB_MODES.every((m) => m.key && m.label && m.blurb));
  ['overall', 'hard', 'clay', 'grass', 'indoor', 'form', 'serve', 'return', 'workload']
    .forEach((k) => chk('mode "' + k + '" exists', L.LAB_MODES.some((m) => m.key === k)));
  eq(L.labMode('nonsense').key, 'overall', 'an unknown mode falls back to overall rather than throwing');
  chk('the workload mode says it is not an injury claim', /never an injury/.test(L.labMode('workload').blurb));
}

console.log('\nTennis Lab engine');
failures.forEach((f) => console.log('  FAIL | ' + f));
console.log((fail ? 'FAILED ' : 'ok ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
