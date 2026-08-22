-- Fix 025: it promoted sign-flipped rows for half the slate
--
-- 025 promoted "the earliest row carrying a spread". For 8 of 16 EdgeDesk
-- games the earliest such row came from an older upload that mapped
-- model_home_margin instead of model_home_line - the same number with the
-- opposite sign. The wall now shows those picks backwards: IND read as a
-- 1.3 point dog when the model has IND favoured by 1.3.
--
-- Each bad row proves itself wrong without reference to any file: its spread
-- contradicts its own home_win_prob. A home team cannot be a 1.45 point
-- underdog and a 55.4% favourite at the same time. This promotes only rows
-- that pass that check.
--
-- It also undoes a second thing 025 got wrong. A model that submits a market
-- line and a cover probability but no spread of its own (mustbemoose) had a
-- spread promoted that carries no win probability to check it against. There
-- is no way to verify such a number, so it should not be on the wall: those
-- models go back to showing their market line, which is what they actually
-- submitted.
--
-- Preference order per model and game:
--   1. earliest row whose spread agrees with its own win probability
--   2. earliest row with a market line and no spread
--   (a row with an unverifiable spread is never chosen while 1 or 2 exists)
--
-- Nothing is deleted. Only the flag moves. Rerunning changes nothing.

-- ---------------------------------------------------------------- STEP 1
-- Read-only. Every stored row, with the verdict this script will act on.

select c.slug as creator, gd.label as game, p.received_at,
       p.is_graded_candidate as on_wall_now,
       p.projected_spread, p.home_win_prob, p.line_at_submission,
       case
         when p.projected_spread is not null and p.home_win_prob is not null
              and ((p.projected_spread < 0 and p.home_win_prob > 0.5)
                or (p.projected_spread > 0 and p.home_win_prob < 0.5)
                or p.projected_spread = 0)                                then 'verified'
         when p.projected_spread is not null and p.home_win_prob is not null then 'CONTRADICTS ITS OWN WIN PROB'
         when p.projected_spread is null and p.line_at_submission is not null then 'market line only'
         else 'unverifiable spread'
       end as verdict
from collective.projections p
join collective.models   m on m.id = p.model_id
join collective.creators c on c.id = m.creator_id
left join collective.game_detail gd on gd.game_id = p.game_id
where p.data_origin = 'live' and p.resolution_status = 'resolved'
order by c.slug, gd.label, p.received_at;

-- ---------------------------------------------------------------- STEP 2
-- Move the flag onto the verified row, through the maintenance path.

do $maint$
declare
  v_off int;
  v_on  int;
begin
  perform set_config('collective.maintenance', 'on', true);

  create temporary table _want on commit drop as
  select distinct on (r.model_id, r.game_id) r.id, r.model_id, r.game_id
  from (
    select p.id, p.model_id, p.game_id, p.received_at,
           case
             when p.projected_spread is not null and p.home_win_prob is not null
                  and ((p.projected_spread < 0 and p.home_win_prob > 0.5)
                    or (p.projected_spread > 0 and p.home_win_prob < 0.5)
                    or p.projected_spread = 0)                                then 1
             when p.projected_spread is null and p.line_at_submission is not null then 2
             else 3
           end as tier
    from collective.projections p
    where p.data_origin = 'live'
      and p.resolution_status = 'resolved'
      and not p.is_late
  ) r
  where r.tier < 3
  order by r.model_id, r.game_id, r.tier asc, r.received_at asc;

  -- Clear only where a replacement exists, so no game is left unflagged.
  update collective.projections p
  set    is_graded_candidate = false
  where  p.is_graded_candidate
    and  p.data_origin = 'live'
    and  exists (select 1 from _want w
                 where w.model_id = p.model_id and w.game_id = p.game_id)
    and  not exists (select 1 from _want w where w.id = p.id);
  get diagnostics v_off = row_count;

  update collective.projections p
  set    is_graded_candidate = true
  from   _want w
  where  p.id = w.id and not p.is_graded_candidate;
  get diagnostics v_on = row_count;

  raise notice 'unflagged % rows, flagged % verified rows', v_off, v_on;
end
$maint$;

-- ---------------------------------------------------------------- STEP 3
-- Verify. Every spread here should agree with its win probability: negative
-- spread with a probability above 50%, positive spread with one below.

select bm.creator_slug, gd.label as game, bm.pick_side,
       bm.projected_spread, bm.projected_total, bm.home_win_prob,
       bm.line_at_submission, bm.cover_prob
from collective.board_models bm
join collective.game_detail gd on gd.game_id = bm.game_id
order by bm.creator_slug, gd.label;
