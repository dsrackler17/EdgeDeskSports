-- Fix: the spread/probability coherence check in collective.ingest_submission
--
-- Symptom: posting a 16-game NFL slate returns eight rows as
--   REJECTED <ref>: home_win_probability contradicts projected_spread;
--   check that the probability is moneyline and the spread is home convention
-- on rows whose numbers are correct.
--
-- The check is NOT in the collective_public edge function; that function
-- passes the envelope verbatim to this RPC and returns its row statuses.
--
-- The rule it applies is a straight line of about 2.5 points of win
-- probability per point of spread, rejecting past roughly 4.3 points. That
-- approximation is fine near a pick'em and bends away past about four
-- points, which is where every rejected row sat. STEP 3 below proves the
-- point with the closing market's own numbers.
--
-- Run the steps in order. Steps 1 to 3 change nothing.

-- ---------------------------------------------------------------- STEP 1
-- Show the check as it is deployed, with 30 lines of context. Paste the
-- output back if you want the exact replacement written for you.

with d as (
  select pg_get_functiondef(p.oid) as src
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'collective' and p.proname = 'ingest_submission'
),
lines as (
  select i, ln from d, unnest(string_to_array(d.src, chr(10))) with ordinality as t(ln, i)
),
hit as (select min(i) as i from lines where ln ilike '%contradict%')
select l.i as line_no, l.ln as source
from lines l, hit
where hit.i is not null and l.i between hit.i - 30 and hit.i + 10
order by l.i;

-- ---------------------------------------------------------------- STEP 2
-- The replacement mapping: a normal margin model instead of a straight
-- line. Additive and safe on its own; nothing uses it until step 4.
-- Abramowitz-Stegun 26.2.17, accurate to ~7.5e-8, no extensions needed.

create or replace function collective.norm_cdf(z double precision)
returns double precision
language sql
immutable
parallel safe
as $$
  select case when z > 0 then 1.0 - v else v end
  from (
    select d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937
             + t * (-1.821255978 + t * 1.330274429)))) as v
    from (
      select 1.0 / (1.0 + 0.2316419 * abs(z)) as t,
             0.3989422804014327 * exp(-z * z / 2.0) as d
    ) a
  ) b
$$;

comment on function collective.norm_cdf(double precision) is
  'Standard normal CDF. Used to check a submitted home win probability against
   the submitted home-convention spread. A straight-line approximation was used
   before and rejected correct submissions on favourites of four points or more.';

-- ---------------------------------------------------------------- STEP 3
-- Proof, before changing anything. Both rules are run over two sets of
-- numbers: the model rows that were rejected, and the CLOSING MARKET's own
-- spread with its own no-vig moneyline for the same sixteen games.
--
-- Expected: the old rule rejects 8 model rows AND 6 market rows. A rule that
-- rejects the market's own pairs is not measuring coherence. The new rule
-- accepts all 32.

with sample(game_ref, whose, spread, prob) as (values
    ('2026_01_NE_SEA','model',-5.01,0.68),
    ('2026_01_SF_LA','model',-5.18,0.6859999999999999),
    ('2026_01_CHI_CAR','model',2.62,0.40299999999999997),
    ('2026_01_TB_CIN','model',-4.42,0.66),
    ('2026_01_NO_DET','model',-5.75,0.705),
    ('2026_01_BUF_HOU','model',-0.58,0.522),
    ('2026_01_BAL_IND','model',-1.32,0.5489999999999999),
    ('2026_01_CLE_JAX','model',-8.08,0.775),
    ('2026_01_ATL_PIT','model',-1.45,0.5539999999999999),
    ('2026_01_NYJ_TEN','model',-4.77,0.672),
    ('2026_01_ARI_LAC','model',-4.93,0.6779999999999999),
    ('2026_01_MIA_LV','model',1.73,0.436),
    ('2026_01_GB_MIN','model',-0.95,0.535),
    ('2026_01_WAS_PHI','model',-5.51,0.6970000000000001),
    ('2026_01_DAL_NYG','model',-3,0.611),
    ('2026_01_DEN_KC','model',2.35,0.413),
    ('2026_01_NE_SEA','market',-3.5,0.6225),
    ('2026_01_SF_LA','market',-3.5,0.6225),
    ('2026_01_CHI_CAR','market',2.5,0.4279),
    ('2026_01_TB_CIN','market',-3.5,0.6369),
    ('2026_01_NO_DET','market',-7,0.7258),
    ('2026_01_BUF_HOU','market',1.5,0.4826),
    ('2026_01_BAL_IND','market',3.5,0.3775),
    ('2026_01_CLE_JAX','market',-7.5,0.7572),
    ('2026_01_ATL_PIT','market',-3,0.6092),
    ('2026_01_NYJ_TEN','market',-3,0.5721),
    ('2026_01_ARI_LAC','market',-10.5,0.8223),
    ('2026_01_MIA_LV','market',-3.5,0.6447),
    ('2026_01_GB_MIN','market',-1.5,0.5217),
    ('2026_01_WAS_PHI','market',-4.5,0.6575),
    ('2026_01_DAL_NYG','market',2.5,0.4279),
    ('2026_01_DEN_KC','market',-3,0.5830)
)
select whose,
       count(*) as rows,
       count(*) filter (where abs(prob - (0.5 + 0.025 * (-spread))) > 0.043) as rejected_by_old_rule,
       count(*) filter (where abs(prob - collective.norm_cdf(-spread / 13.0)) > 0.12) as rejected_by_new_rule
from sample
group by whose
order by whose;

-- Same thing row by row, if you want to see which games:
--   select *, abs(prob - (0.5 + 0.025 * (-spread))) as old_gap,
--             abs(prob - collective.norm_cdf(-spread / 13.0)) as new_gap
--   from sample order by whose, game_ref;

-- ---------------------------------------------------------------- STEP 4
-- Apply. Replace the old condition inside collective.ingest_submission with
-- the line below, keeping whatever variable names step 1 showed. If the
-- variables there are, say, v_spread and v_prob:
--
--     -- old: abs(v_prob - (0.5 + 0.025 * (-v_spread))) > 0.043
--     if abs(v_prob - collective.norm_cdf(-v_spread / 13.0)) > 0.12 then
--       -- reject as before, same code, same message
--     end if;
--
-- Why 13.0 and 0.12: 13 is the scale of an NFL final margin, so the mapping
-- follows the real curve instead of a tangent to it. 0.12 is wide enough to
-- clear the market's own pairs at every number on the board, and still
-- narrow enough to catch what this check is actually for: a spread sent in
-- away convention, or a probability sent as 68 instead of 0.68. A genuinely
-- inverted row (home favoured by 5 with a 35% home probability) misses by 30
-- points and is still rejected.
--
-- Rollback: restore the previous function body, or widen nothing and simply
-- put the old condition back. collective.norm_cdf can be left in place; it
-- has no other callers.

-- ---------------------------------------------------------------- STEP 5
-- After applying, re-post the slate from the dashboard. The eight refused
-- games should come back as revisions carrying their win probabilities.
