#!/usr/bin/env node
/* ===========================================================================
   EdgeDesk Tennis — the research board builder.

   WHAT IT DOES, in four phases:

     1  ODDS      pull whatever prices EdgeDesk has captured for tennis
                  fixtures, normalise them through the OddsProvider contract,
                  de-vig each two-way market, and append them to
                  tennis.odds_snapshots. Nothing is overwritten: a price is an
                  observation at a moment.
     2  PRICE     for every upcoming singles fixture whose two players both
                  resolve to the record, build the feature vector from the
                  CURRENT rating layer, run the ACTIVE model version, and write
                  one prediction. Predictions are append-only.
     3  RESEARCH  turn predictions into research opportunities where the gates
                  pass — with the gap, the EV, the confidence, the data-quality
                  and market-quality scores, and the reason codes. A match that
                  fails a gate still gets a prediction; it just does not get an
                  opportunity, and the reason is stored on the prediction.
     4  PUBLISH   write the immutable public record row at publication time,
                  BEFORE the match is played. That is the whole point of a
                  public record: the claim is frozen while the result is still
                  unknown.

   WHAT IT WILL NOT DO. It will not price a doubles match (a pair is a team and
   the rating layer is per player). It will not price a match where either side
   is unresolved. It will not price under a model version that is not active.
   It will not invent a market price, a weather reading or a start time. Each
   of those refusals is a reason code the board displays.

   Usage:
     node tools/tennis/price_board.js                    # report, write nothing
     node tools/tennis/price_board.js --commit
     node tools/tennis/price_board.js --commit --days 3
     node tools/tennis/price_board.js --commit --no-odds  # price without a market
   =========================================================================== */
'use strict';
const fs = require('fs');
const PG = require('./lib/pg.js');
const M = require('../../lib/tennis_model.js');
const PROV = require('./providers/index.js');
const ODDS = require('./providers/edgedesk_odds.js');
const LIVE = require('./providers/espn_results.js');

const JOB = 'price_board';

function args(argv) {
  const o = { commit: false, days: 3, odds: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    if (a === '--commit') o.commit = true;
    else if (a === '--days') o.days = Math.max(1, Number(next()) || 3);
    else if (a === '--no-odds') o.odds = false;
    else if (a === '--no-publish') o.publish = false;
    else if (a === '--tour') o.tour = String(next() || '').toUpperCase();
    else if (a === '--database') o.database = next();
    else if (a === '--help' || a === '-h') o.help = true;
  }
  if (o.publish == null) o.publish = true;
  return o;
}
const say = (...a) => console.log(...a);
const warn = (...a) => console.log('::warning::' + a.join(' '));
const fail = (...a) => console.error('::error::' + a.join(' '));

/* The rating layer, as the two sides of a matchup. This is where an UPCOMING
   match's features come from: the archive's per-match feature rows are history
   and there is no row for a match nobody has played. */
function ratingSide(r, prefix) {
  if (!r) return null;
  return {
    elo_pre: r[prefix + '_elo'],
    surface_elo_pre: r[prefix + '_surface_elo'],
    win_pct_30d_pre: r[prefix + '_form_30d'],
    win_pct_90d_pre: r[prefix + '_form_90d'],
    win_pct_365d_pre: r[prefix + '_form_365d'],
    matches_7d_pre: r[prefix + '_matches_7d'],
    matches_14d_pre: r[prefix + '_matches_14d'],
    rest_days_pre: r[prefix + '_rest_days'],
    career_surface_win_pct_pre: r[prefix + '_surface_win_pct'],
    career_surface_matches_pre: r[prefix + '_surface_matches'],
    rank_pre: r[prefix + '_rank'],
    rank_points_pre: r[prefix + '_rank_points'],
    age_pre: r[prefix + '_age'],
    /* Serve and return strength are NOT in the current rating layer: the
       archive carries no point-level history for a player EdgeDesk has not
       modelled forward, and the live pipeline's observed baselines are a
       different measurement on a different sample. Null, named, and the
       completeness score falls accordingly. */
    serve_strength_pre: null,
    return_strength_pre: null,
    sos_elo_pre: null,
    best_of: r.best_of,
    tourney_level: r.tournament_level
  };
}

/* Everything needed to price the next few days, in ONE read. */
function boardSql(o) {
  const to = `now() + interval '${o.days} days'`;
  return `
select lm.match_id, lm.tour, lm.tournament_id, t.name as tournament_name, t.level as tournament_level,
       coalesce(t.surface,'unknown') as surface,
       case when t.indoor is true then 'indoor' when t.indoor is false then 'outdoor'
            else coalesce(t.environment,'unknown') end as environment,
       lm.round, lm.best_of, lm.scheduled_at, lm.status, lm.is_doubles,
       lm.home_player_id as a_id, lm.away_player_id as b_id,
       lm.home_name as a_name, lm.away_name as b_name,
       ra.elo as a_elo, ra.hard_elo, ra.clay_elo, ra.grass_elo, ra.carpet_elo,
       ra.power_rating as a_power, ra.uncertainty as a_uncertainty, ra.rating_sample as a_sample,
       ra.form_30d as a_form_30d, ra.form_90d as a_form_90d, ra.form_365d as a_form_365d,
       ra.matches_7d as a_matches_7d, ra.matches_14d as a_matches_14d, ra.rest_days as a_rest_days,
       ra.official_rank as a_rank, ra.official_rank_points as a_rank_points,
       ra.computed_at as a_rated_at, ra.power_rating_surface as a_surfaces,
       rb.elo as b_elo,
       rb.power_rating as b_power, rb.uncertainty as b_uncertainty, rb.rating_sample as b_sample,
       rb.form_30d as b_form_30d, rb.form_90d as b_form_90d, rb.form_365d as b_form_365d,
       rb.matches_7d as b_matches_7d, rb.matches_14d as b_matches_14d, rb.rest_days as b_rest_days,
       rb.official_rank as b_rank, rb.official_rank_points as b_rank_points,
       rb.computed_at as b_rated_at, rb.power_rating_surface as b_surfaces,
       pa.latest_age as a_age, pb.latest_age as b_age,
       (select round(avg(case when won then 1.0 else 0.0 end),4) from tennis.player_match_rows
         where player_id = lm.home_player_id and surface = coalesce(t.surface,'unknown')) as a_surface_win_pct,
       (select count(*) from tennis.player_match_rows
         where player_id = lm.home_player_id and surface = coalesce(t.surface,'unknown')) as a_surface_matches,
       (select round(avg(case when won then 1.0 else 0.0 end),4) from tennis.player_match_rows
         where player_id = lm.away_player_id and surface = coalesce(t.surface,'unknown')) as b_surface_win_pct,
       (select count(*) from tennis.player_match_rows
         where player_id = lm.away_player_id and surface = coalesce(t.surface,'unknown')) as b_surface_matches
  from tennis.live_matches lm
  left join tennis.tournaments t on t.tournament_id = lm.tournament_id
  left join tennis.player_ratings_current ra on ra.player_id = lm.home_player_id
  left join tennis.player_ratings_current rb on rb.player_id = lm.away_player_id
  left join tennis.players pa on pa.player_id = lm.home_player_id
  left join tennis.players pb on pb.player_id = lm.away_player_id
 where lm.status in ('scheduled','live')
   and lm.scheduled_at is not null
   and lm.scheduled_at between now() - interval '6 hours' and ${to}
   ${o.tour ? `and lm.tour = ${PG.lit(o.tour)}` : ''}
 order by lm.scheduled_at
 limit 500`;
}

async function main() {
  const o = args(process.argv.slice(2));
  if (o.help) { say(fs.readFileSync(__filename, 'utf8').split('*/')[0]); return 0; }
  const conn = PG.resolveConnection();
  if (!conn) { fail('no database connection (SUPABASE_DB_URL / DATABASE_URL / EDGD_PG)'); return 1; }
  const db = PG.client(conn, { database: o.database });
  if (!db.ping()) { fail('the database did not answer'); return 1; }

  /* The ACTIVE model version. No active model, no prices — and the board says
     so rather than silently falling back to an unregistered one. */
  const model = db.rows(`select model_version, feature_version, coefficients, status
                           from tennis.model_registry
                          where family = 'tennis_match_winner' and status = 'active' limit 1`)[0];
  if (!model) {
    fail('no ACTIVE tennis model is registered. Run tools/tennis/build_model.js --commit --activate. ' +
         'Nothing is priced from an unregistered model.');
    return 1;
  }
  const coeff = model.coefficients || {};
  say(`model               ${model.model_version} (features ${model.feature_version})`);

  const runId = o.commit ? db.scalar(`insert into tennis.ingestion_runs (job, source_key, build_version, scope, status)
      values (${PG.lit(JOB)}, 'edgedesk', ${PG.lit(model.model_version)},
              ${PG.lit((o.tour || 'both tours') + ' / ' + o.days + 'd')}, 'running') returning run_id`) : null;

  /* ── phase 1: odds ──────────────────────────────────────────────────── */
  let oddsWritten = 0, oddsSeen = 0;
  if (o.odds) {
    let rows = [];
    try { rows = rows.concat(await ODDS.fromTennisCaptures(db, { since: new Date(Date.now() - 48 * 3600 * 1000).toISOString() })); }
    catch (e) { warn('tennis market captures unavailable: ' + e.message); }
    try { rows = rows.concat(await ODDS.fromSignals(db, { since: new Date(Date.now() - 48 * 3600 * 1000).toISOString() })); }
    catch (e) { warn('the shared odds board is unavailable: ' + e.message); }
    rows = rows.filter((r) => r.match_ref && r.market_type && r.odds_decimal);
    ODDS.devig(rows);
    oddsSeen = rows.length;
    if (rows.length && o.commit) {
      const values = rows.map((r) => `(${[PG.lit('live'), PG.lit(r.match_ref), PG.lit(r.event_id), PG.lit(r.tour),
        PG.lit(r.sportsbook), r.book_trusted == null ? 'null' : (r.book_trusted ? 'true' : 'false'),
        PG.lit(r.market_type), PG.lit(r.selection), PG.lit(r.selection_source_id),
        r.line == null ? 'null' : r.line, r.odds_american == null ? 'null' : r.odds_american,
        r.odds_decimal == null ? 'null' : r.odds_decimal,
        r.implied_prob == null ? 'null' : r.implied_prob,
        r.no_vig_prob == null ? 'null' : r.no_vig_prob,
        PG.lit(r.market_state), PG.lit(r.market_status || 'open'),
        PG.lit(r.captured_at), PG.lit('odds_api'), PG.lit(runId)].join(',')})`).join(',\n');
      db.exec(`insert into tennis.odds_snapshots
        (match_scope, match_ref, event_id, tour, sportsbook, book_trusted, market_type, selection,
         selection_player_id, line, odds_american, odds_decimal, implied_prob, no_vig_prob,
         market_state, market_status, captured_at, source_key, ingestion_run_id)
        values ${values}
        on conflict do nothing`);
      oddsWritten = rows.length;
    }
    say(`odds observed       ${oddsSeen}${o.commit ? ' (' + oddsWritten + ' offered to the snapshot table)' : ''}`);
  } else {
    say('odds                skipped (--no-odds)');
  }

  /* ── phase 2+3: price and grade ─────────────────────────────────────── */
  const board = db.rows(boardSql(o));
  say(`fixtures in window  ${board.length}`);
  if (!board.length) {
    say('\nNo upcoming tennis fixtures are on file for this window. The draw is written by');
    say('tools/tennis/sync_events.js; until it has run there is nothing to price.');
    if (runId) db.exec(`update tennis.ingestion_runs set status='ok', finished_at=now(), reconciled=true,
      rows_read=0, details='{"fixtures":0}'::jsonb where run_id='${runId}'::uuid`);
    return 0;
  }

  /* the freshest market price per match, per side */
  const marketBy = new Map();
  db.rows(`select match_ref, selection, selection_player_id, sportsbook, odds_decimal,
                  implied_prob, no_vig_prob, captured_at, market_state
             from (select *, row_number() over (partition by match_ref, selection
                                                order by captured_at desc) rn
                     from tennis.odds_snapshots
                    where match_scope='live' and market_type='match_winner'
                      and captured_at > now() - interval '2 days') z
            where rn = 1`).forEach((r) => {
    const k = r.match_ref;
    if (!marketBy.has(k)) marketBy.set(k, []);
    marketBy.get(k).push(r);
  });

  const predictions = [], opportunities = [], records = [];
  const tally = { priced: 0, research: 0, provisional: 0, excluded: 0, reasons: {} };

  board.forEach((r) => {
    const a = ratingSide(r, 'a'), b = ratingSide(r, 'b');
    const fv = M.featureVector(a, b, { best_of: r.best_of, level: r.tournament_level });
    const prob = M.predict({ intercept: coeff.intercept, coefficients: coeff.coefficients || coeff }, fv);

    const market = marketBy.get(r.match_id) || [];
    const mA = market.find((m) => m.selection_player_id === r.a_id
      || M.normName(m.selection) === M.normName(r.a_name));
    const mB = market.find((m) => m.selection_player_id === r.b_id
      || M.normName(m.selection) === M.normName(r.b_name));
    const marketProbA = mA ? M.num(mA.no_vig_prob) ?? M.num(mA.implied_prob) : null;
    const marketProbB = mB ? M.num(mB.no_vig_prob) ?? M.num(mB.implied_prob) : null;
    const overround = (mA && mB && M.num(mA.implied_prob) != null && M.num(mB.implied_prob) != null)
      ? M.round(M.num(mA.implied_prob) + M.num(mB.implied_prob) - 1, 5) : null;
    const marketAge = mA ? (Date.now() - Date.parse(mA.captured_at)) / 60000 : null;
    const featureAge = r.a_rated_at ? (Date.now() - Date.parse(r.a_rated_at)) / 3600000 : null;

    const conf = M.confidence({ completeness: fv.completeness, uncertainty:
      Math.max(M.num(r.a_uncertainty) ?? 1, M.num(r.b_uncertainty) ?? 1),
      rating_sample_a: r.a_sample, rating_sample_b: r.b_sample, surface: r.surface });
    const grade = M.gradeResearch({
      completeness: fv.completeness,
      rating_sample_a: r.a_sample, rating_sample_b: r.b_sample,
      uncertainty: Math.max(M.num(r.a_uncertainty) ?? 1, M.num(r.b_uncertainty) ?? 1),
      surface: r.surface, market_prob: marketProbA, overround: overround,
      market_age_minutes: marketAge, feature_age_hours: featureAge,
      model_active: true, doubles: !!r.is_doubles,
      players_resolved: !!(r.a_id && r.b_id)
    });
    grade.reasons.forEach((x) => { tally.reasons[x] = (tally.reasons[x] || 0) + 1; });
    tally.priced++;
    tally[grade.grade === 'research' ? 'research' : grade.grade === 'provisional' ? 'provisional' : 'excluded']++;

    const fairA = M.decimalFromProb(prob), fairB = M.decimalFromProb(1 - prob);
    const pred = {
      match_ref: r.match_id, tour: r.tour,
      player_a_id: r.a_id, player_b_id: r.b_id,
      player_a_name: r.a_name, player_b_name: r.b_name,
      prob_a: M.round(prob, 5), prob_b: M.round(1 - prob, 5),
      fair_a_dec: fairA, fair_b_dec: fairB,
      fair_a_am: M.americanFromDecimal(fairA), fair_b_am: M.americanFromDecimal(fairB),
      confidence: conf,
      uncertainty: M.round(Math.max(M.num(r.a_uncertainty) ?? 1, M.num(r.b_uncertainty) ?? 1), 3),
      market_prob_a: marketProbA, market_prob_b: marketProbB,
      edge_a: M.edge(prob, marketProbA), edge_b: M.edge(1 - prob, marketProbB),
      ev_a: mA ? M.expectedValue(prob, M.num(mA.odds_decimal)) : null,
      ev_b: mB ? M.expectedValue(1 - prob, M.num(mB.odds_decimal)) : null,
      research_grade: grade.grade === 'research' ? 'research' : grade.grade === 'provisional' ? 'provisional' : 'excluded',
      exclusion_reasons: grade.reasons,
      missing_inputs: fv.missing,
      calibration_bucket: M.calibrationBucket(prob),
      feature_snapshot_at: r.a_rated_at || null,
      market_snapshot_id: null,
      inputs: { features: fv.map, completeness: fv.completeness, gates: grade.gates_version,
                surface: r.surface, environment: r.environment, market_book: mA ? mA.sportsbook : null,
                market_captured_at: mA ? mA.captured_at : null, overround: overround },
      scheduled_at: r.scheduled_at, surface: r.surface, round: r.round,
      tournament_name: r.tournament_name
    };
    predictions.push(pred);

    if (pred.research_grade !== 'excluded' && marketProbA != null) {
      [['a', r.a_name, r.a_id, prob, marketProbA, mA], ['b', r.b_name, r.b_id, 1 - prob, marketProbB, mB]]
        .forEach(([side, name, pid, p, mp, mk]) => {
          if (mp == null || !mk) return;
          const e = M.edge(p, mp);
          if (e == null || e < M.GATES.minEdge) return;
          opportunities.push({
            match_ref: r.match_id, tour: r.tour, market_type: 'match_winner',
            selection: name, selection_player_id: pid, sportsbook: mk.sportsbook,
            model_prob: M.round(p, 5), market_prob: mp,
            fair_dec: M.decimalFromProb(p), fair_am: M.americanFromDecimal(M.decimalFromProb(p)),
            market_dec: M.num(mk.odds_decimal), market_am: M.americanFromDecimal(M.num(mk.odds_decimal)),
            edge: e, ev: M.expectedValue(p, M.num(mk.odds_decimal)),
            confidence: conf,
            data_quality: M.round(fv.completeness, 3),
            market_quality: overround == null ? null : M.round(Math.max(0, 1 - overround / M.GATES.maxOverround), 3),
            reason_codes: reasonCodes(p, mp, r, fv),
            exclusion_reasons: grade.reasons,
            research_grade: pred.research_grade,
            expires_at: r.scheduled_at,
            _side: side
          });
        });
    }

    /* The public record row is written NOW, before the match. */
    if (pred.research_grade !== 'excluded' && pred.prob_a != null) {
      records.push(pred);
    }
  });

  say('');
  say(`  priced              ${tally.priced}`);
  say(`    research grade    ${tally.research}`);
  say(`    provisional       ${tally.provisional}`);
  say(`    excluded          ${tally.excluded}`);
  say(`  opportunities       ${opportunities.length} (edge >= ${(M.GATES.minEdge * 100).toFixed(0)} points)`);
  if (Object.keys(tally.reasons).length) {
    say('  why matches were held back or caveated:');
    Object.keys(tally.reasons).sort((x, y) => tally.reasons[y] - tally.reasons[x])
      .forEach((k) => say(`    ${k.padEnd(24)} ${tally.reasons[k]}`));
  }

  if (!o.commit) {
    say('\nDRY RUN — nothing written. A sample of what would be published:');
    predictions.slice(0, 5).forEach((p) => say(
      `  ${String(p.player_a_name).slice(0, 18).padEnd(18)} vs ${String(p.player_b_name).slice(0, 18).padEnd(18)} ` +
      `model ${(p.prob_a * 100).toFixed(1)}%  market ${p.market_prob_a == null ? '—' : (p.market_prob_a * 100).toFixed(1) + '%'}  ` +
      `fair ${p.fair_a_dec}  ${p.research_grade}`));
    return 0;
  }

  /* ── write ──────────────────────────────────────────────────────────── */
  const stmts = [];
  if (predictions.length) {
    stmts.push(`insert into tennis.model_predictions
      (match_scope, match_ref, tour, model_version, feature_version, player_a_id, player_b_id,
       player_a_name, player_b_name, prob_a, prob_b, fair_odds_a_decimal, fair_odds_b_decimal,
       fair_odds_a_american, fair_odds_b_american, confidence, uncertainty, feature_snapshot_at,
       market_prob_a, market_prob_b, edge_a, edge_b, ev_a, ev_b, research_grade,
       exclusion_reasons, calibration_bucket, inputs, missing_inputs, source_key, ingestion_run_id)
      values ${predictions.map((p) => `(${['live', p.match_ref, p.tour].map(PG.lit).join(',')},
        ${PG.lit(model.model_version)}, ${PG.lit(model.feature_version)},
        ${PG.lit(p.player_a_id)}, ${PG.lit(p.player_b_id)}, ${PG.lit(p.player_a_name)}, ${PG.lit(p.player_b_name)},
        ${p.prob_a}, ${p.prob_b}, ${p.fair_a_dec}, ${p.fair_b_dec}, ${p.fair_a_am}, ${p.fair_b_am},
        ${p.confidence}, ${p.uncertainty}, ${PG.lit(p.feature_snapshot_at)},
        ${nn(p.market_prob_a)}, ${nn(p.market_prob_b)}, ${nn(p.edge_a)}, ${nn(p.edge_b)},
        ${nn(p.ev_a)}, ${nn(p.ev_b)}, ${PG.lit(p.research_grade)},
        ${arr(p.exclusion_reasons)}, ${PG.lit(p.calibration_bucket)},
        ${PG.lit(JSON.stringify(p.inputs))}::jsonb, ${arr(p.missing_inputs)},
        'edgedesk', ${PG.lit(runId)})`).join(',\n')}
      on conflict do nothing;`);
  }
  /* Opportunities are the MUTABLE surface: the previous generation for these
     matches is superseded rather than deleted, so a reader can always see what
     EdgeDesk said an hour ago and why it changed. */
  if (opportunities.length) {
    stmts.push(`update tennis.research_opportunities
                   set status='superseded', superseded_at=now()
                 where status='open' and match_scope='live'
                   and match_ref in (${opportunities.map((x) => PG.lit(x.match_ref)).join(',')});`);
    stmts.push(`insert into tennis.research_opportunities
      (match_scope, match_ref, tour, model_version, market_type, selection, selection_player_id,
       sportsbook, model_prob, market_prob, fair_odds_decimal, fair_odds_american,
       market_odds_decimal, market_odds_american, estimated_edge, expected_value, confidence,
       data_quality_score, market_quality_score, reason_codes, exclusion_reasons,
       research_grade, status, expires_at, source_key)
      values ${opportunities.map((x) => `('live', ${PG.lit(x.match_ref)}, ${PG.lit(x.tour)},
        ${PG.lit(model.model_version)}, ${PG.lit(x.market_type)}, ${PG.lit(x.selection)},
        ${PG.lit(x.selection_player_id)}, ${PG.lit(x.sportsbook)},
        ${nn(x.model_prob)}, ${nn(x.market_prob)}, ${nn(x.fair_dec)}, ${nn(x.fair_am)},
        ${nn(x.market_dec)}, ${nn(x.market_am)}, ${nn(x.edge)}, ${nn(x.ev)}, ${nn(x.confidence)},
        ${nn(x.data_quality)}, ${nn(x.market_quality)}, ${arr(x.reason_codes)}, ${arr(x.exclusion_reasons)},
        ${PG.lit(x.research_grade)}, 'open', ${PG.lit(x.expires_at)}, 'edgedesk')`).join(',\n')};`);
  }
  if (o.publish && records.length) {
    stmts.push(`insert into tennis.prediction_record
      (match_scope, match_ref, tour, tournament_name, surface, round, model_version, feature_version,
       scheduled_at, player_a_id, player_b_id, player_a_name, player_b_name, prob_a,
       fair_odds_a_decimal, market_prob_a, market_odds_a_decimal, market_book,
       confidence, confidence_bucket, calibration_bucket, research_grade)
      values ${records.map((p) => `('live', ${PG.lit(p.match_ref)}, ${PG.lit(p.tour)},
        ${PG.lit(p.tournament_name)}, ${PG.lit(p.surface)}, ${PG.lit(p.round)},
        ${PG.lit(model.model_version)}, ${PG.lit(model.feature_version)}, ${PG.lit(p.scheduled_at)},
        ${PG.lit(p.player_a_id)}, ${PG.lit(p.player_b_id)}, ${PG.lit(p.player_a_name)}, ${PG.lit(p.player_b_name)},
        ${p.prob_a}, ${p.fair_a_dec}, ${nn(p.market_prob_a)},
        ${p.inputs.market_book ? nn(marketDec(marketBy, p)) : 'null'}, ${PG.lit(p.inputs.market_book)},
        ${p.confidence}, ${PG.lit(M.confidenceBucket(p.confidence))}, ${PG.lit(p.calibration_bucket)},
        ${PG.lit(p.research_grade)})`).join(',\n')}
      on conflict (match_scope, match_ref, model_version) do nothing;`);
  }
  stmts.push(`update tennis.ingestion_runs set status='ok', finished_at=now(), reconciled=true,
    rows_read=${board.length}, rows_inserted=${predictions.length},
    details=${PG.lit(JSON.stringify({ odds: oddsWritten, predictions: predictions.length,
      opportunities: opportunities.length, published: records.length, tally }))}::jsonb
    where run_id='${runId}'::uuid;`);

  try { db.transaction(stmts); }
  catch (e) {
    db.exec(`update tennis.ingestion_runs set status='error', finished_at=now(),
               error_summary=${PG.lit(String(e.message).slice(0, 900))} where run_id='${runId}'::uuid`);
    fail(e.message); return 1;
  }

  db.exec(`insert into tennis.meta (key, value) values ('board_built', now()::text)
           on conflict (key) do update set value = excluded.value`);
  say('');
  say(`  predictions written  ${predictions.length}  (append-only, under ${model.model_version})`);
  say(`  opportunities open   ${opportunities.length}`);
  say(`  public record rows   ${records.length}  (published BEFORE the match, immutable thereafter)`);
  return 0;
}

function nn(x) { return x == null ? 'null' : Number(x); }
function arr(a) { return a && a.length ? `array[${a.map(PG.lit).join(',')}]::text[]` : `'{}'::text[]`; }
function marketDec(marketBy, p) {
  const m = (marketBy.get(p.match_ref) || []).find((x) => x.selection_player_id === p.player_a_id
    || M.normName(x.selection) === M.normName(p.player_a_name));
  return m ? M.num(m.odds_decimal) : null;
}

/* Why this row is on the board, in codes the page turns into sentences. They
   describe the DATA, never a recommendation. */
function reasonCodes(modelProb, marketProb, r, fv) {
  const out = [];
  const gap = modelProb - marketProb;
  if (Math.abs(gap) >= 0.08) out.push('large_model_market_gap');
  else if (Math.abs(gap) >= 0.04) out.push('moderate_model_market_gap');
  const ea = M.num(r.a_elo), eb = M.num(r.b_elo);
  if (ea != null && eb != null && Math.abs(ea - eb) < 30) out.push('ratings_close');
  const sa = M.num(r.a_surface_win_pct), sb = M.num(r.b_surface_win_pct);
  if (sa != null && sb != null && Math.abs(sa - sb) >= 0.15
      && Number(r.a_surface_matches) >= 20 && Number(r.b_surface_matches) >= 20)
    out.push('surface_record_diverges');
  const ra = M.num(r.a_rest_days), rb = M.num(r.b_rest_days);
  if (ra != null && rb != null && Math.abs(ra - rb) >= 4) out.push('rest_asymmetry');
  if ((r.a_matches_14d || 0) >= 6 || (r.b_matches_14d || 0) >= 6) out.push('heavy_recent_workload');
  if (fv.missing.length) out.push('inputs_missing');
  if (r.surface === 'unknown') out.push('surface_unknown');
  return out;
}

if (require.main === module) main().then((c) => process.exit(c)).catch((e) => { fail(String(e && e.stack || e)); process.exit(1); });
module.exports = { boardSql, ratingSide, reasonCodes };
