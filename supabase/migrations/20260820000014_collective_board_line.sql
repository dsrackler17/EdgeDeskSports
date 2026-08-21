-- Model Collective, migration 14: show the number a model actually posted.
--
-- Not every model produces a projected spread. A model that picks a side at
-- the market line (a completely normal design, and what several creators
-- submit) sends pick_side, line_at_submission, and cover_probability but no
-- projected_spread and no home_win_prob. The board read only carried the
-- projected fields, so those models rendered a dash in every numeric column
-- and looked broken while their data was perfectly good.
--
-- Adding the two fields the creator did send. Same rows, same gating: this
-- view is only read through buildGames, which locks pre-kickoff numbers for
-- unentitled callers.

create or replace view collective.board_models as
select
  p.game_id, p.model_id, c.slug as creator_slug, m.slug as model_slug,
  p.pick_side, p.projected_spread, p.projected_total, p.home_win_prob,
  p.received_at, p.is_late,
  gr.pick_result, gr.margin_error, gr.brier,
  -- appended: create or replace view can only add columns at the end
  p.line_at_submission, p.cover_prob
from collective.projections p
join collective.models m on m.id = p.model_id and m.is_listed
join collective.creators c on c.id = m.creator_id and c.is_listed and c.status = 'active'
left join collective.grades gr on gr.projection_id = p.id
where p.resolution_status = 'resolved' and p.data_origin = 'live'
  and (p.is_graded_candidate or p.is_late);
