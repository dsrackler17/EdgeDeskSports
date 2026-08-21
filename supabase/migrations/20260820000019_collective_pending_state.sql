-- Model Collective, migration 19: say what is actually true before results.
--
-- The wall and the profile both read "first submission pending" whenever a
-- model had no graded games. Between a creator's first post and the first
-- kickoff that is simply wrong: the slate is in, nothing has been played yet.
-- It reads as though the submission failed, which is the one impression a
-- creator should never get right after a successful post.
--
-- Adds the count that separates the two states. Appended, because
-- create or replace view can only add columns at the end.

create or replace view collective.model_wall as
select
  c.id  as creator_id, c.slug as creator_slug, c.display_name as creator_name,
  c.logo_url, collective.monogram(c.display_name) as monogram,
  c.founding_member as founding, c.website_url, c.x_handle,
  collective.creator_membership(c.id) as membership,
  m.id as model_id, m.slug as model_slug, m.name as model_name, m.sport_code as sport,
  r.graded, r.wins, r.losses, r.pushes, r.win_pct, r.margin_mae, r.total_mae, r.brier,
  ct.coverage_pct,
  (select max(p.received_at) from collective.projections p
    where p.model_id = m.id and p.data_origin = 'live' and p.resolution_status = 'resolved')
    as last_submission_at,
  -- appended: games this model has posted a live pick on, played or not.
  -- This is what separates "has not submitted" from "submitted, waiting on
  -- kickoff", which the wall and profile were conflating.
  (select count(distinct p.game_id) from collective.projections p
    where p.model_id = m.id and p.data_origin = 'live'
      and p.resolution_status = 'resolved' and p.is_graded_candidate)
    as submitted_games
from collective.creators c
join collective.models m on m.creator_id = c.id and m.is_listed
left join collective.model_records r on r.model_id = m.id
left join collective.model_coverage_totals ct
  on ct.model_id = m.id
 and ct.season = (select max(season) from collective.sport_seasons ss where ss.sport_code = m.sport_code)
where c.is_listed and c.status = 'active';
