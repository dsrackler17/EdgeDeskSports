#!/usr/bin/env node
/* ===========================================================================
   supabase/player_props.sql against a REAL PostgreSQL.

   Applies the shipped file (twice, and once as one editor-style transaction),
   checks its own report, then attacks every guarantee it claims:
     - quotes are append-only for every role (update / delete / truncate)
     - lineage is required; a reconstructed line cannot name a sportsbook;
       reconstructed quotes never reach the training view, a backtest or the
       record
     - features obey source_max_timestamp <= asof_at <= kickoff and are frozen
     - predictions are pregame, immutable and name a registered model version
     - a record entry is frozen before kickoff and graded exactly once
     - the ingestion door is idempotent and quarantines bad quotes
     - promotion quarantines impossible stat lines and logs corrections
     - props.dist_probs prices a line exactly as lib/player_props.js does
     - row level security: who may read what
   Without PostgreSQL it skips loudly and passes; CI runs it with a database.

     node football/props/sql.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const H = require('../../tools/personal/_pg.js');
const EDP = require('../../lib/player_props.js');

const FILE = path.join(__dirname, '..', '..', 'supabase', 'player_props.sql');
const t = H.kit('props SQL');
const db = H.start('props');
if (!db || db.skip) { console.log('SKIP | props SQL | ' + (db && db.skip)); process.exit(0); }

/* the harness wraps each call in begin/commit: every statement must end in ';' */
const semi = (x) => (/;\s*$/.test(x) ? x : x + ';');
['sql', 'service', 'anon'].forEach((k) => { const f = db[k].bind(db); db[k] = (x) => f(semi(x)); });
{ const f = db.as.bind(db); db.as = (u, x) => f(u, semi(x)); }
let code = 1;
try {
  const rep = db.applyFile(FILE);
  const rows = rep.split('\n').filter((l) => /^\d+\|/.test(l));
  t.chk('the report has 14 rows', rows.length === 14, rows.length);
  t.chk('every report row reads ok', rows.every((l) => /\|ok$/.test(l)), rows.filter((l) => !/\|ok$/.test(l)));
  t.chk('idempotent: a second application succeeds with the same report', /\|ok$/.test(db.applyFile(FILE).split('\n').filter((l) => /^1\|/.test(l))[0] || ''));
  t.chk('idempotent: applied as one transaction (the SQL editor path)', (() => { try { db.applyFileAtomic(FILE); return true; } catch (e) { return e.message; } })() === true);
  t.chk('no psql meta-command anywhere in the file', !require('fs').readFileSync(FILE, 'utf8').split('\n').some((l) => /^\s*\\/.test(l)));

  /* ---------------------------------------------------------------- seed */
  db.sql(`
    insert into props.dim_game (game_id, league, source_game_id, season, week, season_type, kickoff_utc, home_team_id, away_team_id, status, source_provider)
      values ('2026_05_KC_BUF','NFL','2026_05_KC_BUF',2026,5,'regular', now() + interval '2 days','BUF','KC','scheduled','nflverse'),
             ('2025_10_KC_BUF','NFL','2025_10_KC_BUF',2025,10,'regular', '2025-11-09T21:25:00Z','BUF','KC','final','nflverse'),
             ('401871049','CFB','401871049',2026,5,'regular', now() + interval '3 days','166','98','scheduled','cfbfastR');
    insert into props.dim_player (player_id, full_name, position, identity_status) values
      ('espn:4361370','Test Receiver','WR','bridged'), ('gsis:00-0000001','Test Quarterback','QB','nfl_only'), ('espn:5000001','College Back','RB','cfb_only');
    insert into props.model_registry (model_version, model_name, league, position_group, market_key, family, algorithm, feature_version, training_from, training_to, training_cutoff, trained_at, n_rows, sha256, artifact)
      values ('nfl_wr_receiving_yards_v1.2025','nfl_wr_receiving_yards','NFL','WR','receiving_yards','continuous','ridge_poisson_glm+empirical_ratio','pf1',2011,2025,'2026-02-10T00:00:00Z', now(), 1000, 'abc', '{}'::jsonb);
    insert into props.model_status_events (model_version, status, reason, actor) values ('nfl_wr_receiving_yards_v1.2025','CHAMPION','test','sql.test');
  `);
  const q = (id, over) => Object.assign({ quote_id: id, league: 'NFL', game_id: '2026_05_KC_BUF', player_id: 'espn:4361370', market_key: 'receiving_yards', sportsbook: 'draftkings',
    provider: 'the-odds-api', snapshot_at: new Date(Date.now() - 60000).toISOString(), side: 'over', line: 69.5, american_price: -110, lineage: 'observed', is_main_line: true }, over || {});
  const mtk = (snap) => Math.round((Date.parse(db.sql("select kickoff_utc from props.dim_game where game_id = '2026_05_KC_BUF'").trim().replace(' ', 'T').replace(/\+00$/, 'Z')) - Date.parse(snap)) / 60000);
  const ins = (rows) => JSON.parse(db.service("select props.ingest_prop_quotes('" + JSON.stringify(rows).replace(/'/g, "''") + "'::jsonb)::text;"));
  const snap = new Date(Date.now() - 60000).toISOString();
  const base = [q('pq_1', { snapshot_at: snap, minutes_to_kick: mtk(snap) }), q('pq_2', { side: 'under', snapshot_at: snap, minutes_to_kick: mtk(snap) }),
    q('pq_3', { line: 79.5, american_price: 125, is_main_line: false, is_alt_line: true, snapshot_at: snap, minutes_to_kick: mtk(snap) })];
  let r1 = ins(base);
  t.chk('ingest: three valid observed quotes inserted', r1.inserted === 3, r1);
  const r2 = ins(base);
  t.chk('ingest is idempotent: a second call inserts nothing', r2.inserted === 0 && r2.duplicates === 3, r2);
  const bad = ins([q('pq_bad1', { lineage: null, snapshot_at: snap, minutes_to_kick: mtk(snap) }), q('pq_bad2', { american_price: 50, snapshot_at: snap, minutes_to_kick: mtk(snap) }),
    q('pq_bad3', { player_id: 'espn:999', snapshot_at: snap, minutes_to_kick: mtk(snap) })]);
  t.chk('ingest quarantines a missing lineage, a -99..99 price and an unknown player', bad.quarantined === 3 && bad.inserted === 0, bad);
  t.chk('quarantine rows carry the rule', Number(db.sql("select count(*) from props.quarantine where rule_id in ('Q006','Q011','Q009')")) === 3);

  /* --------------------------------------------------------- append-only */
  ['service_role', 'postgres'].forEach((role) => {
    const as = role === 'postgres' ? (s) => db.sql(s) : (s) => db.service(s);
    t.chk(role + ': a quote cannot be updated', /immutable/.test(db.mustFail(() => as("update props.fact_prop_quote set american_price = -120 where quote_id = 'pq_1'")) || ''));
    t.chk(role + ': a quote cannot be deleted', /immutable/.test(db.mustFail(() => as("delete from props.fact_prop_quote where quote_id = 'pq_1'")) || ''));
    t.chk(role + ': the quote table cannot be truncated', /immutable|permission denied/.test(db.mustFail(() => as('truncate props.fact_prop_quote cascade')) || ''));
  });

  /* ------------------------------------------------------------- lineage */
  const k0 = db.sql("select extract(epoch from kickoff_utc)::bigint from props.dim_game where game_id = '2026_05_KC_BUF'");
  const mins = Math.round((Number(k0) * 1000 - Date.parse(snap)) / 60000);
  const ins1 = (vals) => db.mustFail(() => db.sql(`insert into props.fact_prop_quote (quote_id, league, game_id, player_id, market_key, sportsbook, provider, snapshot_at, minutes_to_kick, side, line, american_price, decimal_price, implied_prob, lineage)
    values (${vals})`));
  t.chk('lineage cannot be null', /null value|violates/.test(ins1(`'x1','NFL','2026_05_KC_BUF','espn:4361370','receiving_yards','draftkings','the-odds-api','${snap}',${mins},'over',69.5,-110,1.9091,0.5238,null`) || ''));
  t.chk('lineage must be observed or reconstructed', /props_quote_lineage/.test(ins1(`'x2','NFL','2026_05_KC_BUF','espn:4361370','receiving_yards','draftkings','the-odds-api','${snap}',${mins},'over',69.5,-110,1.9091,0.5238,'guessed'`) || ''));
  t.chk('a reconstructed line cannot claim a sportsbook provider', /props_quote_lineage_provider/.test(ins1(`'x3','NFL','2026_05_KC_BUF','espn:4361370','receiving_yards','draftkings','the-odds-api','${snap}',${mins},'over',69.5,-110,1.9091,0.5238,'reconstructed'`) || ''));
  t.chk('an observed quote cannot claim the reconstruction provider', /props_quote_lineage_provider/.test(ins1(`'x4','NFL','2026_05_KC_BUF','espn:4361370','receiving_yards','draftkings','edgedesk_reconstruction','${snap}',${mins},'over',69.5,-110,1.9091,0.5238,'observed'`) || ''));
  t.chk('an American price inside -99..99 is refused', /props_quote_american/.test(ins1(`'x5','NFL','2026_05_KC_BUF','espn:4361370','receiving_yards','draftkings','the-odds-api','${snap}',${mins},'over',69.5,50,1.5,0.6667,'observed'`) || ''));
  t.chk('minutes_to_kick must agree with the kickoff', /disagrees/.test(ins1(`'x6','NFL','2026_05_KC_BUF','espn:4361370','receiving_yards','draftkings','the-odds-api','${snap}',5,'over',69.5,-110,1.9091,0.5238,'observed'`) || ''));
  db.sql(`insert into props.fact_prop_quote (quote_id, league, game_id, player_id, market_key, sportsbook, provider, snapshot_at, minutes_to_kick, side, line, american_price, decimal_price, implied_prob, lineage)
    values ('rc_1','NFL','2026_05_KC_BUF','espn:4361370','receiving_yards','reconstructed','edgedesk_reconstruction','${snap}',${mins},'over',64.5,-110,1.909090909,0.523809524,'reconstructed')`);
  t.chk('a properly labelled reconstructed research line may be stored', db.sql("select count(*) from props.fact_prop_quote where lineage = 'reconstructed'") === '1');
  t.chk('the observed view never shows it', db.sql("select count(*) from props.v_observed_prop_quotes where quote_id = 'rc_1'") === '0');
  t.chk('the training view never shows it', db.sql("select count(*) from props.v_training_prop_quotes where quote_id = 'rc_1'") === '0');
  t.chk('the latest-quotes view never shows it', db.sql("select count(*) from props.v_latest_prop_quotes where quote_id = 'rc_1'") === '0');
  t.chk('a backtest decision on a reconstructed quote is refused', /not an observed sportsbook price/.test(db.mustFail(() => db.sql(
    `insert into props.backtest_decision (game_id, player_id, market_key, quote_id, model_version, decision_at, decision) values ('2026_05_KC_BUF','espn:4361370','receiving_yards','rc_1','nfl_wr_receiving_yards_v1.2025', now() - interval '1 minute','LEAN')`)) || ''));
  t.chk('a backtest decision on an observed pregame quote is accepted', !db.mustFail(() => db.sql(
    `insert into props.backtest_decision (game_id, player_id, market_key, quote_id, model_version, decision_at, decision) values ('2026_05_KC_BUF','espn:4361370','receiving_yards','pq_1','nfl_wr_receiving_yards_v1.2025', now() - interval '1 minute','LEAN')`)));
  t.chk('a record entry cannot be reconstructed', /violates check constraint/.test(db.mustFail(() => db.sql(
    `insert into props.prop_record (entry_id, frozen_at, league, season, game_id, kickoff_utc, player_id, market_key, side, line, sportsbook, american, lineage, model_prob, decision, model_version, feature_version)
     values ('pr_x', now(), 'NFL', 2026, '2026_05_KC_BUF', now() + interval '2 days', 'espn:4361370', 'receiving_yards', 'over', 64.5, 'reconstructed', -110, 'reconstructed', 0.55, 'LEAN', 'nfl_wr_receiving_yards_v1.2025', 'pf1')`)) || ''));

  /* ----------------------------------------------------- point in time */
  t.chk('Q008: a feature whose source is newer than its as-of is refused', /props_feature_pit/.test(db.mustFail(() => db.sql(
    `insert into props.fact_feature_snapshot (game_id, player_id, asof_at, feature_name, feature_value, source_max_timestamp) values ('2026_05_KC_BUF','espn:4361370', now(), 'targets_avg_l3', 7, now() + interval '1 hour')`)) || ''));
  t.chk('a feature as of after kickoff is refused', /after kickoff/.test(db.mustFail(() => db.sql(
    `insert into props.fact_feature_snapshot (game_id, player_id, asof_at, feature_name, feature_value, source_max_timestamp) values ('2025_10_KC_BUF','espn:4361370', '2025-11-10T00:00:00Z', 'targets_avg_l3', 7, '2025-11-01T00:00:00Z')`)) || ''));
  db.sql(`insert into props.fact_feature_snapshot (game_id, player_id, asof_at, feature_name, feature_value, source_max_timestamp) values ('2026_05_KC_BUF','espn:4361370', now(), 'targets_avg_l3', 7, now() - interval '5 days')`);
  t.chk('a valid point-in-time feature is stored', db.sql('select count(*) from props.fact_feature_snapshot') === '1');
  t.chk('a stored feature cannot be edited', /immutable/.test(db.mustFail(() => db.service('update props.fact_feature_snapshot set feature_value = 9')) || ''));

  /* ---------------------------------------------------------- predictions */
  const dist = EDP.dist.continuousFromRatio(72, { probs: [0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99], bins: [{ mu_lo: 1, mu_hi: 200, mu_mid: 60, n: 1000, q: [0, 0.3, 0.6, 0.95, 1.35, 1.75, 2.6] }] }, 0, { integer: true });
  const predSql = (id, asof, ver) => `insert into props.model_prediction (prediction_id, game_id, player_id, market_key, league, asof_at, scored_at, model_version, feature_version, training_cutoff, projected_mean, dist)
    values ('${id}','2026_05_KC_BUF','espn:4361370','receiving_yards','NFL', ${asof}, now(), '${ver}', 'pf1', '2026-02-10T00:00:00Z', 72, '${JSON.stringify(dist)}'::jsonb)`;
  t.chk('a prediction names a registered model version', /foreign key/.test(db.mustFail(() => db.sql(predSql('pp_bad', 'now()', 'nfl_wr_receiving_yards_v9'))) || ''));
  t.chk('a prediction after kickoff is refused', /before kickoff/.test(db.mustFail(() => db.sql(predSql('pp_late', "now() + interval '3 days'", 'nfl_wr_receiving_yards_v1.2025'))) || ''));
  db.sql(predSql('pp_1', 'now()', 'nfl_wr_receiving_yards_v1.2025'));
  t.chk('a pregame prediction is stored', db.sql('select count(*) from props.model_prediction') === '1');
  t.chk('a prediction cannot be rewritten by a newer model', /immutable/.test(db.mustFail(() => db.service("update props.model_prediction set model_version = 'nfl_wr_receiving_yards_v1.2025', projected_mean = 80")) || ''));
  t.chk('a prediction cannot be deleted', /immutable/.test(db.mustFail(() => db.service('delete from props.model_prediction')) || ''));

  /* ------------------------------------------------ the serving arithmetic */
  const lines = [49.5, 59.5, 64.5, 69.5, 70, 74.5, 79.5, 89.5];
  const sqlP = db.sql(`select string_agg(round(p_over::numeric, 6)::text || ':' || round(p_push::numeric, 6)::text, ',' order by l) from (select l, (props.dist_probs('${JSON.stringify(dist)}'::jsonb, l)).* from unnest(array[${lines.join(',')}]::numeric[]) l) x`).split(',');
  const jsP = lines.map((l) => { const p = EDP.dist.probs(dist, l); return p.over.toFixed(6) + ':' + p.push.toFixed(6); });
  t.chk('props.dist_probs matches lib/player_props.js at every alternate line (continuous)', sqlP.every((v, i) => Math.abs(Number(v.split(':')[0]) - Number(jsP[i].split(':')[0])) < 1e-5 && Math.abs(Number(v.split(':')[1]) - Number(jsP[i].split(':')[1])) < 1e-5), { sqlP, jsP });
  const pmf = EDP.dist.negBinomPmf(4.6, 9);
  const cl = [2.5, 3, 3.5, 4, 4.5, 5.5, 6.5];
  const sqlC = db.sql(`select string_agg(round(p_over::numeric, 6)::text || ':' || round(p_push::numeric, 6)::text, ',' order by l) from (select l, (props.dist_probs('${JSON.stringify(pmf)}'::jsonb, l)).* from unnest(array[${cl.join(',')}]::numeric[]) l) x`).split(',');
  const jsC = cl.map((l) => { const p = EDP.dist.probs(pmf, l); return p.over.toFixed(6) + ':' + p.push.toFixed(6); });
  t.chk('props.dist_probs matches lib/player_props.js on a count pmf, pushes included', sqlC.every((v, i) => Math.abs(Number(v.split(':')[0]) - Number(jsC[i].split(':')[0])) < 1e-5 && Math.abs(Number(v.split(':')[1]) - Number(jsC[i].split(':')[1])) < 1e-5), { sqlC, jsC });
  const ev = db.sql("select round(expected_value::numeric, 5) || '|' || round(model_prob::numeric, 5) || '|' || fair_american from props.v_prop_quote_eval where quote_id = 'pq_1'").split('|');
  const jev = EDP.evaluateQuote(dist, { side: 'over', line: 69.5, american_price: -110, lineage: 'observed' }, {});
  t.chk('the quote-evaluation view prices EV exactly as the kernel does', Math.abs(Number(ev[0]) - jev.ev) < 1e-4 && Math.abs(Number(ev[1]) - jev.model_prob) < 1e-4 && Number(ev[2]) === jev.fair_american, { ev, jev: [jev.ev, jev.model_prob, jev.fair_american] });
  const board = db.sql("select player_name || '|' || line || '|' || price || '|' || round(model_over_prob::numeric,4) || '|' || round(market_no_vig_over_prob::numeric,4) || '|' || book_count from props.v_player_props_board");
  t.chk('the website board view returns the player, line, price, model, market and depth', /^Test Receiver\|69\.5\|-110\|0\.\d{4}\|0\.5000\|1$/.test(board), board);

  /* a withdrawn line leaves the latest-quotes view once the book's listing drops it */
  const snap2 = new Date(Date.now() - 30000).toISOString();
  const r3 = ins([q('pq_4', { line: 72.5, snapshot_at: snap2, minutes_to_kick: mtk(snap2) }), q('pq_5', { line: 72.5, side: 'under', snapshot_at: snap2, minutes_to_kick: mtk(snap2) })]);
  t.chk('a moved main line is ingested (change-only)', r3.inserted === 2, r3);
  t.chk('without a listing both numbers are still shown', db.sql("select count(*) from props.v_latest_prop_quotes where sportsbook = 'draftkings' and not is_alt_line") === '4');
  db.sql(`insert into props.fact_prop_listing (listing_id, league, game_id, player_id, market_key, sportsbook, snapshot_at, keys)
    values ('pl_1','NFL','2026_05_KC_BUF','espn:4361370','receiving_yards','draftkings','${snap2}', array['over|72.5|0','under|72.5|0','over|79.5|1'])`);
  t.chk('with the listing, the withdrawn 69.5 leaves the market and 72.5 and the alternate stay',
    db.sql("select string_agg(side || ':' || line, ',' order by line, side) from props.v_latest_prop_quotes where sportsbook = 'draftkings'") === 'over:72.5,under:72.5,over:79.5');
  t.chk('a listing is append-only', /immutable/.test(db.mustFail(() => db.service("delete from props.fact_prop_listing")) || ''));
  const bl = db.sql("select line || '|' || price from props.v_player_props_board");
  t.chk('the board follows the listing to the new number', bl === '72.5|-110', bl);

  /* ------------------------------------------------------------- record */
  const recSql = (id, frozen, kick) => `insert into props.prop_record (entry_id, frozen_at, league, season, game_id, kickoff_utc, player_id, market_key, side, line, sportsbook, american, lineage, model_prob, decision, model_version, feature_version)
     values ('${id}', ${frozen}, 'NFL', 2026, '2026_05_KC_BUF', ${kick}, 'espn:4361370', 'receiving_yards', 'over', 69.5, 'draftkings', -110, 'observed', 0.56, 'LEAN', 'nfl_wr_receiving_yards_v1.2025', 'pf1')`;
  t.chk('a record entry frozen at or after kickoff is refused', /violates check constraint/.test(db.mustFail(() => db.sql(recSql('pr_late', 'now()', "now() - interval '1 minute'"))) || ''));
  db.sql(recSql('pr_1', 'now()', "now() + interval '2 days'"));
  t.chk('a frozen entry cannot be rewritten (no better price after the fact)', /cannot be rewritten/.test(db.mustFail(() => db.service("update props.prop_record set american = 110 where entry_id = 'pr_1'")) || ''));
  t.chk('a frozen entry cannot be re-attributed to a newer model', /cannot be rewritten/.test(db.mustFail(() => db.service("update props.prop_record set model_version = 'nfl_wr_receiving_yards_v2' where entry_id = 'pr_1'")) || ''));
  db.service("update props.prop_record set result = 'WIN', actual = 88, units_flat = 0.9091, graded_at = now() where entry_id = 'pr_1'");
  t.chk('the grade is written beside the entry', db.sql("select result from props.prop_record where entry_id = 'pr_1'") === 'WIN');
  t.chk('a grade is written once', /written once/.test(db.mustFail(() => db.service("update props.prop_record set result = 'LOSS' where entry_id = 'pr_1'")) || ''));
  t.chk('a record entry is never deleted', /never deleted/.test(db.mustFail(() => db.service("delete from props.prop_record where entry_id = 'pr_1'")) || ''));

  /* ---------------------------------------------------------- promotion */
  db.sql(`insert into props.stg_player_game (game_id, player_id, team_id, opponent_id, season, kickoff_utc, attempts, completions, receptions, targets, receiving_yards, source_provider, run_id) values
    ('2025_10_KC_BUF','espn:4361370','BUF','KC',2025,'2025-11-09T21:25:00Z',0,0,6,9,71,'nflverse','run1'),
    ('2025_10_KC_BUF','gsis:00-0000001','KC','BUF',2025,'2025-11-09T21:25:00Z',30,34,0,0,0,'nflverse','run1');
    insert into props.ingestion_runs (run_id, job) values ('run1','test'), ('run2','test');`);
  const pr = JSON.parse(db.service("select props.promote_player_games('run1')::text"));
  t.chk('promotion loads the good row and quarantines completions > attempts (Q003)', pr.upserted === 1 && pr.quarantined === 1, pr);
  t.chk('the impossible stat line is in quarantine, not in the facts', db.sql("select count(*) from props.quarantine where rule_id = 'Q003'") === '1' && db.sql("select count(*) from props.fact_player_game where player_id = 'gsis:00-0000001'") === '0');
  db.sql(`insert into props.stg_player_game (game_id, player_id, team_id, opponent_id, season, kickoff_utc, attempts, completions, receptions, targets, receiving_yards, source_provider, run_id) values
    ('2025_10_KC_BUF','espn:4361370','BUF','KC',2025,'2025-11-09T21:25:00Z',0,0,6,9,74,'nflverse','run2')`);
  const pr2 = JSON.parse(db.service("select props.promote_player_games('run2')::text"));
  t.chk('a changed source value is logged in fact_corrections before it is updated', pr2.corrections_logged === 1 && db.sql("select (old_row->>'receiving_yards') || '>' || (new_row->>'receiving_yards') from props.fact_corrections") === '71>74', pr2);
  const pr3 = JSON.parse(db.service("select props.promote_player_games('run2')::text"));
  t.chk('re-promoting the same run changes nothing', pr3.upserted === 0 && pr3.corrections_logged === 0, pr3);

  /* ------------------------------------------------ row level security */
  t.chk('anon reads the board view', !db.mustFail(() => db.anon('select count(*) from props.v_player_props_board')));
  t.chk('anon reads the dimensions and the record', !db.mustFail(() => db.anon('select count(*) from props.dim_player; select count(*) from props.prop_record')));
  t.chk('anon cannot read quote history', /permission denied/.test(db.mustFail(() => db.anon('select count(*) from props.fact_prop_quote')) || ''));
  t.chk('anon cannot read features', /permission denied/.test(db.mustFail(() => db.anon('select count(*) from props.fact_feature_snapshot')) || ''));
  t.chk('a signed-in reader reads observed quote history', db.as('00000000-0000-0000-0000-000000000001', 'select count(*) from props.fact_prop_quote') !== '');
  t.chk('a signed-in reader cannot read features, staging, quarantine or raw payloads', ['fact_feature_snapshot', 'stg_player_game', 'quarantine', 'raw_odds_payloads'].every((tb) =>
    /permission denied/.test(db.mustFail(() => db.as('00000000-0000-0000-0000-000000000001', 'select count(*) from props.' + tb)) || '')));
  t.chk('a signed-in reader cannot write a quote', /permission denied/.test(db.mustFail(() => db.as('00000000-0000-0000-0000-000000000001', "insert into props.fact_prop_quote (quote_id) values ('z')")) || ''));
  t.chk('anon cannot call the ingestion door', /permission denied/.test(db.mustFail(() => db.anon("select props.ingest_prop_quotes('[]'::jsonb)")) || ''));
  t.chk('the AI context door answers for a signed-in reader', /"predictions"/.test(db.as('00000000-0000-0000-0000-000000000001', "select props.ai_prop_context('Test Receiver')::text")));

  /* ------------------------------------------------------------- quality */
  t.chk('Q009 fires for a player marked bridged without a production bridge row', /Q009=FAIL/.test(db.sql("select string_agg(rule_id || '=' || status, ',' order by rule_id) from props.v_quality")));
  db.sql("insert into props.bridge_cfb_nfl_player (bridge_id, player_id, cfb_espn_id, nfl_gsis_id, match_method, match_confidence) values ('br_1','espn:4361370','4361370','00-0099999','exact_espn_id',1)");
  t.chk('a bridge below 0.90 without review is not production-eligible', db.sql("insert into props.bridge_cfb_nfl_player (bridge_id, player_id, cfb_espn_id, nfl_gsis_id, match_method, match_confidence) values ('br_2','espn:5000001','5000001','00-0088888','name_chronology_position',0.85) returning production_eligible") === 'f');
  const qr = db.sql("select string_agg(rule_id || '=' || status, ',' order by rule_id) from props.v_quality");
  t.chk('all fifteen quality rules report', qr.split(',').length === 15, qr);
  t.chk('the quality report is clean on this data (Q012 pairing may warn)', qr.split(',').every((x) => /=ok$|Q012=(ok|warn)$/.test(x)), qr);
  code = t.done();
} catch (e) {
  console.error(e.stack || e.message);
  code = 1;
} finally { db.stop(); }
process.exit(code);
