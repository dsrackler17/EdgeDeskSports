-- Model Collective, migration 4: results, grades, and the grading engine.
-- Three separate metrics, never blended (rule 8.11), graded only against
-- the Collective's own captured closing line (rule 9.1), only on each
-- model's first pre-kickoff live submission (rule 8.5), reproducible from
-- raw tables by someone who does not trust us.

create table collective.results (
  game_id              uuid primary key references collective.games(id),
  home_score           int not null,
  away_score           int not null,
  -- Home convention, negative means home favored, same as projections.
  closing_spread       numeric,
  closing_total        numeric,
  closing_home_ml_prob numeric check (closing_home_ml_prob is null or (closing_home_ml_prob >= 0 and closing_home_ml_prob <= 1)),
  source               text,
  settled_at           timestamptz not null default now()
);
alter table collective.results enable row level security;
grant select, insert, update on collective.results to service_role;

create table collective.grades (
  projection_id   uuid primary key references collective.projections(id),
  game_id         uuid not null references collective.games(id),
  model_id        uuid not null references collective.models(id),
  pick_result     collective.grade_result,
  margin_error    numeric,
  total_error     numeric,
  brier           numeric,
  grading_version int not null default 1,
  graded_at       timestamptz not null default now()
);
create index grades_model on collective.grades (model_id);
create index grades_game on collective.grades (game_id);
alter table collective.grades enable row level security;
grant select on collective.grades to service_role;

-- Grades every candidate projection on a settled game. Deterministic:
-- rerunning it produces identical rows (grading_version stamps the rules).
create or replace function collective.grade_game(p_game_id uuid) returns int
language plpgsql security definer set search_path = collective as $$
declare
  r  collective.results%rowtype;
  p  record;
  v_margin numeric;
  v_pick collective.grade_result;
  v_marg_err numeric;
  v_tot_err numeric;
  v_brier numeric;
  v_n int := 0;
begin
  select * into r from collective.results where game_id = p_game_id;
  if not found then return 0; end if;
  v_margin := r.home_score - r.away_score;

  for p in
    select * from collective.projections
    where game_id = p_game_id and is_graded_candidate
  loop
    -- 1. Pick result vs the Collective closing spread. Home covers when
    --    margin + closing_spread > 0; the exact number is a push and is
    --    excluded from win percentage downstream.
    v_pick := null;
    if p.pick_side is not null and r.closing_spread is not null then
      if v_margin + r.closing_spread = 0 then
        v_pick := 'push';
      elsif (v_margin + r.closing_spread > 0) = (p.pick_side = 'home') then
        v_pick := 'win';
      else
        v_pick := 'loss';
      end if;
    end if;

    -- 2. Margin error. Projected home margin from scores when given, else
    --    from the spread (home convention: projected margin = -spread).
    v_marg_err := null;
    if p.proj_home_score is not null and p.proj_away_score is not null then
      v_marg_err := abs((p.proj_home_score - p.proj_away_score) - v_margin);
    elsif p.projected_spread is not null then
      v_marg_err := abs((-p.projected_spread) - v_margin);
    end if;

    v_tot_err := null;
    if p.projected_total is not null then
      v_tot_err := abs(p.projected_total - (r.home_score + r.away_score));
    end if;

    -- 3. Brier on the moneyline home win probability. A tie grades null:
    --    the outcome is neither a home win nor a home loss.
    v_brier := null;
    if p.home_win_prob is not null and v_margin <> 0 then
      v_brier := power(p.home_win_prob - (case when v_margin > 0 then 1 else 0 end), 2);
    end if;

    insert into collective.grades (projection_id, game_id, model_id, pick_result, margin_error, total_error, brier, grading_version)
    values (p.id, p_game_id, p.model_id, v_pick, v_marg_err, v_tot_err, v_brier, 1)
    on conflict (projection_id) do update
      set pick_result = excluded.pick_result,
          margin_error = excluded.margin_error,
          total_error = excluded.total_error,
          brier = excluded.brier,
          grading_version = excluded.grading_version,
          graded_at = now();
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;
revoke execute on function collective.grade_game(uuid) from public;
grant execute on function collective.grade_game(uuid) to service_role;
