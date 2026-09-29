-- player_props -- part 4 of 6.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

-- ===========================================================================
-- QUALITY — every rule as a query; nothing here mutates a row
-- ===========================================================================
create or replace function props.run_quality_checks()
returns table(rule_id text, scope text, severity text, violations bigint, status text)
language sql stable security definer set search_path = props, pg_temp as $$
  select 'Q001', 'fact_player_game', 'ERROR', (select count(*) from (select game_id, player_id from props.fact_player_game group by 1, 2 having count(*) > 1) d), null
  union all select 'Q002', 'fact_player_game', 'ERROR', (select count(*) from props.fact_player_game where least(coalesce(attempts,0), coalesce(carries,0), coalesce(targets,0), coalesce(receptions,0)) < 0), null
  union all select 'Q003', 'fact_player_game', 'ERROR', (select count(*) from props.fact_player_game where completions > attempts), null
  union all select 'Q004', 'fact_player_game', 'ERROR', (select count(*) from props.fact_player_game where targets > 0 and receptions > targets), null
  union all select 'Q005', 'fact_player_game', 'WARN', (select count(*) from props.fact_player_game where passing_tds + interceptions > attempts or rushing_tds > carries or receiving_tds > receptions), null
  union all select 'Q006', 'fact_prop_quote', 'ERROR', (select count(*) from props.fact_prop_quote where lineage not in ('observed','reconstructed')), null
  union all select 'Q007', 'v_training_prop_quotes', 'ERROR', (select count(*) from props.v_training_prop_quotes q join props.dim_game g using (game_id) where q.snapshot_at >= g.kickoff_utc), null
  union all select 'Q008', 'fact_feature_snapshot', 'ERROR', (select count(*) from props.fact_feature_snapshot where source_max_timestamp > asof_at), null
  union all select 'Q009', 'bridge_cfb_nfl_player', 'ERROR', (select count(*) from props.dim_player p where p.identity_status = 'bridged' and not exists (select 1 from props.bridge_cfb_nfl_player b where b.player_id = p.player_id and b.production_eligible)), null
  union all select 'Q010', 'fact_prop_result', 'ERROR', (select count(*) from props.fact_prop_result where participated and result_quality < 0.95), null
  union all select 'Q011', 'fact_prop_quote', 'ERROR', (select count(*) from props.fact_prop_quote where american_price between -99 and 99), null
  union all select 'Q012', 'fact_prop_quote', 'WARN', (select count(*) from props.v_latest_prop_quotes o where o.is_main_line and o.side = 'over' and not exists (
        select 1 from props.v_latest_prop_quotes u where u.game_id = o.game_id and u.player_id = o.player_id and u.market_key = o.market_key and u.sportsbook = o.sportsbook
          and u.side = 'under' and u.line = o.line and u.snapshot_at = o.snapshot_at)), null
  union all select 'Q013', 'dim_game', 'ERROR', (select count(*) from props.dim_game where kickoff_utc is null), null
  union all select 'Q014', 'all', 'ERROR', (select count(*) from props.fact_player_game where source_provider is null) + (select count(*) from props.fact_prop_quote where provider is null), null
  union all select 'Q015', 'model_prediction', 'ERROR', (select count(*) from props.model_prediction p join props.dim_game g using (game_id) where p.asof_at >= g.kickoff_utc), null
$$;
-- the view form, with the status column filled
create or replace view props.v_quality with (security_invoker = true) as
select rule_id, scope, severity, violations, case when violations = 0 then 'ok' when severity = 'WARN' then 'warn' else 'FAIL' end as status
from props.run_quality_checks();

-- ===========================================================================
-- INGESTION DOORS (service role only)
-- ===========================================================================
-- Quotes, one JSON array at a time: invalid rows quarantined, duplicates
-- ignored, valid rows appended. Running it twice appends nothing twice.
create or replace function props.ingest_prop_quotes(p_quotes jsonb, p_run_id text default null)
returns jsonb language plpgsql security definer set search_path = props, pg_temp as $$
declare q jsonb; n_in int := 0; n_ok int := 0; n_dup int := 0; n_bad int := 0; reasons text[]; ins int; nv numeric; opp jsonb;
begin
  for q in select * from jsonb_array_elements(coalesce(p_quotes, '[]'::jsonb)) loop
    n_in := n_in + 1; reasons := '{}';
    if (q->>'lineage') is null or (q->>'lineage') not in ('observed','reconstructed') then reasons := array_append(reasons, 'Q006: lineage missing or invalid'::text); end if;
    if (q->>'american_price') is null or ((q->>'american_price')::int between -99 and 99) then reasons := array_append(reasons, 'Q011: invalid American price'::text); end if;
    if (q->>'provider') is null then reasons := array_append(reasons, 'Q014: no provider'::text); end if;
    if not exists (select 1 from props.dim_game where game_id = q->>'game_id') then reasons := array_append(reasons, 'unknown game'::text); end if;
    if not exists (select 1 from props.dim_player where player_id = q->>'player_id') then reasons := array_append(reasons, 'Q009: unknown player'::text); end if;
    if not exists (select 1 from props.prop_catalog where market_key = q->>'market_key') then reasons := array_append(reasons, 'unknown market'::text); end if;
    if array_length(reasons, 1) > 0 then
      n_bad := n_bad + 1;
      insert into props.quarantine(rule_id, scope, natural_key, reasons, payload, run_id)
      values (coalesce(substring(reasons[1] from '^(Q[0-9]{3})'), 'Q014'), 'fact_prop_quote', coalesce(q->>'quote_id', md5(q::text)), reasons, q, p_run_id)
      on conflict do nothing;
      continue;
    end if;
    -- the no-vig probability from this quote's own pair (same book, snapshot, player, market, line) in the batch;
    -- the table is append-only, so it must be right on the way in
    nv := (q->>'no_vig_prob')::numeric;
    if nv is null then
      select o into opp from jsonb_array_elements(p_quotes) o
       where o->>'game_id' = q->>'game_id' and o->>'player_id' = q->>'player_id' and o->>'market_key' = q->>'market_key' and o->>'sportsbook' = q->>'sportsbook'
         and o->>'snapshot_at' = q->>'snapshot_at' and coalesce(o->>'line', '') = coalesce(q->>'line', '') and coalesce(o->>'is_alt_line', 'false') = coalesce(q->>'is_alt_line', 'false')
         and o->>'side' = case q->>'side' when 'over' then 'under' when 'under' then 'over' when 'yes' then 'no' else 'yes' end
       limit 1;
      if opp is not null and (opp->>'american_price') is not null and abs((opp->>'american_price')::int) >= 100 then
        nv := (1 / props.american_to_decimal((q->>'american_price')::int)) / ((1 / props.american_to_decimal((q->>'american_price')::int)) + (1 / props.american_to_decimal((opp->>'american_price')::int)));
      end if;
    end if;
    insert into props.fact_prop_quote(quote_id, league, game_id, player_id, team_id, market_key, sportsbook, provider, snapshot_at, provider_updated_at, minutes_to_kick,
      side, line, american_price, decimal_price, implied_prob, no_vig_prob, is_main_line, is_alt_line, lineage, source_market_key, source_player_name, player_match,
      provider_event_id, source_payload_hash, fingerprint, pair_hold_out_of_bounds)
    values (q->>'quote_id', q->>'league', q->>'game_id', q->>'player_id', q->>'team_id', q->>'market_key', q->>'sportsbook', q->>'provider', (q->>'snapshot_at')::timestamptz,
      (q->>'provider_updated_at')::timestamptz, (q->>'minutes_to_kick')::int, q->>'side', (q->>'line')::numeric, (q->>'american_price')::int,
      props.american_to_decimal((q->>'american_price')::int), 1 / props.american_to_decimal((q->>'american_price')::int), nv,
      coalesce((q->>'is_main_line')::boolean, false), coalesce((q->>'is_alt_line')::boolean, false), q->>'lineage', q->>'source_market_key', q->>'source_player_name',
      q->>'player_match', q->>'provider_event_id', q->>'source_payload_hash', q->>'fingerprint', coalesce((q->>'pair_hold_out_of_bounds')::boolean, false))
    on conflict do nothing;
    get diagnostics ins = row_count;
    if ins = 1 then n_ok := n_ok + 1; else n_dup := n_dup + 1; end if;
  end loop;
  return jsonb_build_object('received', n_in, 'inserted', n_ok, 'duplicates', n_dup, 'quarantined', n_bad);
end $$;

-- Promote staged player-games: new rows inserted, changed rows logged in
-- fact_corrections THEN updated, unchanged rows untouched, rows failing a
-- quality gate quarantined. Idempotent.
create or replace function props.promote_player_games(p_run_id text)
returns jsonb language plpgsql security definer set search_path = props, pg_temp as $$
declare n_new int; n_changed int; n_bad int;
begin
  with bad as (
    select s.* from props.stg_player_game s where s.run_id = p_run_id and (
      (s.completions > s.attempts) or (s.targets > 0 and s.receptions > s.targets)
      or least(coalesce(s.attempts,0), coalesce(s.carries,0), coalesce(s.targets,0), coalesce(s.receptions,0), coalesce(s.completions,0)) < 0
      or s.source_provider is null
      or not exists (select 1 from props.dim_player p where p.player_id = s.player_id)
      or not exists (select 1 from props.dim_game g where g.game_id = s.game_id))
  ), q as (
    insert into props.quarantine(rule_id, scope, natural_key, reasons, payload, run_id)
    select case when b.completions > b.attempts then 'Q003' when b.targets > 0 and b.receptions > b.targets then 'Q004' when b.source_provider is null then 'Q014'
                when not exists (select 1 from props.dim_player p where p.player_id = b.player_id) then 'Q009' else 'Q002' end,
           'fact_player_game', b.game_id || '|' || b.player_id, array['failed a quality gate at promotion'], to_jsonb(b), p_run_id
    from bad b on conflict do nothing returning 1
  ) select count(*) into n_bad from q;
  delete from props.stg_player_game s where s.run_id = p_run_id and (
      (s.completions > s.attempts) or (s.targets > 0 and s.receptions > s.targets)
      or least(coalesce(s.attempts,0), coalesce(s.carries,0), coalesce(s.targets,0), coalesce(s.receptions,0), coalesce(s.completions,0)) < 0
      or s.source_provider is null
      or not exists (select 1 from props.dim_player p where p.player_id = s.player_id)
      or not exists (select 1 from props.dim_game g where g.game_id = s.game_id));
  -- corrections first: an existing row whose measured values changed
  insert into props.fact_corrections(game_id, player_id, run_id, old_row, new_row)
  select f.game_id, f.player_id, p_run_id, to_jsonb(f) - 'loaded_at', to_jsonb(s) - 'run_id' - 'loaded_at'
  from props.stg_player_game s join props.fact_player_game f using (game_id, player_id)
  where s.run_id = p_run_id and (s.attempts, s.completions, s.passing_yards, s.passing_tds, s.interceptions, s.carries, s.rushing_yards, s.rushing_tds,
        s.targets, s.receptions, s.receiving_yards, s.receiving_tds, s.longest_reception, s.longest_rush, s.longest_completion, s.snaps)
     is distinct from (f.attempts, f.completions, f.passing_yards, f.passing_tds, f.interceptions, f.carries, f.rushing_yards, f.rushing_tds,
        f.targets, f.receptions, f.receiving_yards, f.receiving_tds, f.longest_reception, f.longest_rush, f.longest_completion, f.snaps);
  get diagnostics n_changed = row_count;
  insert into props.fact_player_game
  select game_id, player_id, team_id, opponent_id, player_name, position, position_group, season, week, kickoff_utc, is_home, starter, active_status, injury_status, snaps, snap_share, routes,
      attempts, completions, passing_yards, passing_tds, interceptions, sacks_taken, passing_air_yards, passing_epa, passing_cpoe, dropbacks, scrambles, designed_rushes,
      carries, rushing_yards, rushing_tds, rushing_epa, targets, receptions, receiving_yards, receiving_tds, receiving_epa, air_yards, yac, target_share, air_yard_share,
      red_zone_touches, goal_line_touches, rz_targets, rz_carries, gl_carries, explosive_rec, explosive_rush, longest_completion, longest_rush, longest_reception,
      fumbles_lost, special_teams_tds, fg_made, fg_att, pat_made, kicking_points, def_interceptions, def_sacks, def_tackles_assists, source_quality, source_provider,
      source_detail, source_updated_at, qa_warnings, now()
  from props.stg_player_game where run_id = p_run_id
  on conflict (game_id, player_id) do update set
    attempts = excluded.attempts, completions = excluded.completions, passing_yards = excluded.passing_yards, passing_tds = excluded.passing_tds, interceptions = excluded.interceptions,
    carries = excluded.carries, rushing_yards = excluded.rushing_yards, rushing_tds = excluded.rushing_tds, targets = excluded.targets, receptions = excluded.receptions,
    receiving_yards = excluded.receiving_yards, receiving_tds = excluded.receiving_tds, longest_reception = excluded.longest_reception, longest_rush = excluded.longest_rush,
    longest_completion = excluded.longest_completion, snaps = excluded.snaps, snap_share = excluded.snap_share, source_quality = excluded.source_quality, loaded_at = now()
  where (excluded.attempts, excluded.completions, excluded.passing_yards, excluded.passing_tds, excluded.interceptions, excluded.carries, excluded.rushing_yards, excluded.rushing_tds,
         excluded.targets, excluded.receptions, excluded.receiving_yards, excluded.receiving_tds, excluded.longest_reception, excluded.longest_rush, excluded.longest_completion, excluded.snaps)
     is distinct from (props.fact_player_game.attempts, props.fact_player_game.completions, props.fact_player_game.passing_yards, props.fact_player_game.passing_tds,
         props.fact_player_game.interceptions, props.fact_player_game.carries, props.fact_player_game.rushing_yards, props.fact_player_game.rushing_tds, props.fact_player_game.targets,
         props.fact_player_game.receptions, props.fact_player_game.receiving_yards, props.fact_player_game.receiving_tds, props.fact_player_game.longest_reception,
         props.fact_player_game.longest_rush, props.fact_player_game.longest_completion, props.fact_player_game.snaps);
  get diagnostics n_new = row_count;
  delete from props.stg_player_game where run_id = p_run_id;
  return jsonb_build_object('upserted', n_new, 'corrections_logged', n_changed, 'quarantined', n_bad);
end $$;

-- ===========================================================================
-- 12. AI CONTEXT — bounded, read-only, the only door the desk reads props through
-- ===========================================================================
create or replace function props.ai_prop_context(p_player text, p_market text default null, p_league text default null)
returns jsonb language sql stable security definer set search_path = props, pg_temp as $$
  with pl as (
    select player_id, full_name, position from props.dim_player
    where (player_id = p_player or lower(full_name) = lower(p_player)) limit 5
  ), pr as (
    select p.*, g.kickoff_utc, g.home_team_id, g.away_team_id from props.v_latest_predictions p join pl using (player_id) join props.dim_game g using (game_id)
    where g.kickoff_utc > now() and (p_market is null or p.market_key = p_market) and (p_league is null or p.league = upper(p_league))
    order by g.kickoff_utc limit 12
  )
  select jsonb_build_object(
    'player', (select jsonb_agg(to_jsonb(pl)) from pl),
    'predictions', coalesce((select jsonb_agg(jsonb_build_object('game_id', game_id, 'kickoff_utc', kickoff_utc, 'market_key', market_key, 'model_version', model_version,
        'mean', projected_mean, 'median', projected_median, 'p10', projected_p10, 'p90', projected_p90, 'ref_line', ref_line, 'over', over_probability, 'under', under_probability,
        'fair_over', fair_over_american, 'fair_under', fair_under_american, 'confidence', confidence, 'data_quality', data_quality, 'scored_at', scored_at)) from pr), '[]'::jsonb),
    'quotes', coalesce((select jsonb_agg(jsonb_build_object('market_key', e.market_key, 'sportsbook', e.sportsbook, 'side', e.side, 'line', e.line, 'american', e.american_price,
        'model_prob', round(e.model_prob, 4), 'fair_american', e.fair_american, 'ev', round(e.expected_value, 4), 'no_vig', round(e.no_vig_prob, 4), 'snapshot_at', e.snapshot_at))
        from props.v_prop_quote_eval e join pr on pr.game_id = e.game_id and pr.player_id = e.player_id and pr.market_key = e.market_key), '[]'::jsonb),
    'record', (select jsonb_agg(to_jsonb(s)) from props.v_prop_record_summary s where p_market is null or s.market_key = p_market),
    'rule', 'Only what is stored here may be quoted. A missing field is missing; nothing is filled in.')
$$;
create or replace function props.ai_prop_board(p_league text default null, p_limit int default 20)
returns jsonb language sql stable security definer set search_path = props, pg_temp as $$
  select coalesce(jsonb_agg(to_jsonb(b)), '[]'::jsonb) from (
    select * from props.v_player_props_board where (p_league is null or league = upper(p_league)) and expected_value_pct is not null
    order by expected_value_pct desc nulls last limit least(greatest(coalesce(p_limit, 20), 1), 50)) b
$$;
create or replace function props.ai_data_health()
returns jsonb language sql stable security definer set search_path = props, pg_temp as $$
  select jsonb_build_object(
    'player_games', (select count(*) from props.fact_player_game), 'games', (select count(*) from props.dim_game),
    'observed_quotes', (select count(*) from props.fact_prop_quote where lineage = 'observed'),
    'reconstructed_quotes', (select count(*) from props.fact_prop_quote where lineage = 'reconstructed'),
    'last_quote_at', (select max(snapshot_at) from props.fact_prop_quote), 'last_prediction_at', (select max(scored_at) from props.model_prediction),
    'champion_models', (select count(*) from props.v_model_status where status = 'CHAMPION'),
    'quality', (select jsonb_agg(jsonb_build_object('rule', rule_id, 'violations', violations, 'status', status)) from props.v_quality))
$$;
