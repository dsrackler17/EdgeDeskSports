-- portfolio_journal -- part 2 of 8.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. THE JOURNAL
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.portfolio_journal_entries (
  position_id               uuid        primary key,
  user_id                   uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  -- DECISION (write-once per field)
  decision_source           text        null,
  opening_odds_american     integer     null,
  opening_odds_decimal      numeric     null,
  opening_line              numeric     null,
  opening_price             numeric     null,
  research_odds_american    integer     null,
  research_odds_decimal     numeric     null,
  research_line             numeric     null,
  research_price            numeric     null,
  research_at               timestamptz null,
  model_version             text        null,
  model_probability         numeric     null,
  model_fair_line           numeric     null,
  model_fair_odds_decimal   numeric     null,
  edge_at_entry             numeric     null,
  confidence_tier           text        null,
  decision_tags             text[]      null,
  planned                   boolean     null,
  thesis                    text        null,
  unit_size_at_entry        numeric     null,
  bankroll_at_entry         numeric     null,
  max_single_units_at_entry numeric     null,
  max_daily_units_at_entry  numeric     null,
  unit_recorded_at          timestamptz null,
  decision_recorded_at      timestamptz null,
  model_recorded_at         timestamptz null,
  research_recorded_at      timestamptz null,
  tags_recorded_at          timestamptz null,
  -- CLOSE (write-once per field)
  closing_odds_american     integer     null,
  closing_odds_decimal      numeric     null,
  closing_line              numeric     null,
  closing_price             numeric     null,
  closing_source            text        null,
  closing_book              text        null,
  closing_recorded_at       timestamptz null,
  -- REVIEW (the reader's)
  would_repeat              text        null,
  review_note               text        null,
  library                   text        null,
  reviewed_at               timestamptz null,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  constraint portfolio_journal_position_fk foreign key (position_id, user_id)
    references public.portfolio_positions (id, user_id) on delete cascade,
  constraint portfolio_journal_source check ((decision_source is null or decision_source in ('EDGEDESK', 'USER', 'OTHER'))
    and (closing_source is null or closing_source in ('USER', 'PLATFORM', 'EDGEDESK_CAPTURE'))),
  constraint portfolio_journal_odds check (
    (opening_odds_american is null or ((opening_odds_american <= -100 or opening_odds_american >= 100) and abs(opening_odds_american) <= 1000000))
    and (research_odds_american is null or ((research_odds_american <= -100 or research_odds_american >= 100) and abs(research_odds_american) <= 1000000))
    and (closing_odds_american is null or ((closing_odds_american <= -100 or closing_odds_american >= 100) and abs(closing_odds_american) <= 1000000))
    and (opening_odds_decimal is null or (opening_odds_decimal > 1 and opening_odds_decimal <= 10001))
    and (research_odds_decimal is null or (research_odds_decimal > 1 and research_odds_decimal <= 10001))
    and (closing_odds_decimal is null or (closing_odds_decimal > 1 and closing_odds_decimal <= 10001))
    and (model_fair_odds_decimal is null or (model_fair_odds_decimal > 1 and model_fair_odds_decimal <= 10001))),
  constraint portfolio_journal_prices check ((opening_price is null or opening_price between 0 and 1)
    and (research_price is null or research_price between 0 and 1) and (closing_price is null or closing_price between 0 and 1)
    and (model_probability is null or (model_probability > 0 and model_probability < 1))
    and (edge_at_entry is null or edge_at_entry between -1 and 100)),
  constraint portfolio_journal_lines check ((opening_line is null or abs(opening_line) <= 1000) and (research_line is null or abs(research_line) <= 1000)
    and (closing_line is null or abs(closing_line) <= 1000) and (model_fair_line is null or abs(model_fair_line) <= 1000)),
  constraint portfolio_journal_units check ((unit_size_at_entry is null or unit_size_at_entry > 0) and (bankroll_at_entry is null or bankroll_at_entry > 0)
    and (max_single_units_at_entry is null or max_single_units_at_entry > 0) and (max_daily_units_at_entry is null or max_daily_units_at_entry > 0)),
  constraint portfolio_journal_tags check (decision_tags is null or (cardinality(decision_tags) <= 11 and decision_tags <@ array['MODEL', 'LINE_VALUE',
    'MATCHUP', 'INJURY', 'WEATHER', 'MARKET_MOVEMENT', 'PROMOTION', 'LIVE_READ', 'HEDGE', 'PERSONAL_READ', 'OTHER']::text[])),
  constraint portfolio_journal_review check ((would_repeat is null or would_repeat in ('YES', 'NO', 'UNSURE'))
    and (library is null or library in ('MISTAKE', 'STRENGTH'))),
  constraint portfolio_journal_text check (coalesce(length(thesis), 0) <= 1000 and coalesce(length(review_note), 0) <= 1000
    and coalesce(length(model_version), 0) <= 60 and coalesce(length(confidence_tier), 0) <= 30 and coalesce(length(closing_book), 0) <= 60)
);
comment on table public.portfolio_journal_entries is
  'One row per position. DECISION and CLOSE fields are write-once (a recorded value is never rewritten, by anyone); REVIEW fields are the reader''s. The Decision Grade reads these, never profit or loss.';
create index if not exists portfolio_journal_user on public.portfolio_journal_entries (user_id);
create index if not exists portfolio_positions_user_settled on public.portfolio_positions (user_id, settled_at) where settled_at is not null;

-- the fields that, once recorded, never change
create or replace function public.portfolio_journal_frozen_fields()
returns text[] language sql immutable as $$
  select array['decision_source', 'opening_odds_american', 'opening_odds_decimal', 'opening_line', 'opening_price',
    'research_odds_american', 'research_odds_decimal', 'research_line', 'research_price', 'research_at', 'model_version',
    'model_probability', 'model_fair_line', 'model_fair_odds_decimal', 'edge_at_entry', 'confidence_tier', 'decision_tags',
    'planned', 'thesis', 'unit_size_at_entry', 'bankroll_at_entry', 'max_single_units_at_entry', 'max_daily_units_at_entry', 'unit_recorded_at',
    'closing_odds_american', 'closing_odds_decimal', 'closing_line', 'closing_price', 'closing_source', 'closing_book']
$$;

create or replace function public.portfolio_journal_guard() returns trigger
language plpgsql as $$
declare
  reader boolean := auth.uid() is not null;
  o jsonb; n jsonb; k text;
  now_ts timestamptz := now();
  has_close boolean;
begin
  if tg_op = 'INSERT' then
    if reader then new.user_id := auth.uid(); end if;
    new.created_at := now_ts;
    o := '{}'::jsonb;
  else
    new.position_id := old.position_id; new.user_id := old.user_id; new.created_at := old.created_at;
    o := to_jsonb(old);
  end if;
  /* odds typed as American carry their decimal, computed the one way */
  if new.opening_odds_american is not null and new.opening_odds_decimal is null then new.opening_odds_decimal := public.portfolio_american_to_decimal(new.opening_odds_american); end if;
  if new.research_odds_american is not null and new.research_odds_decimal is null then new.research_odds_decimal := public.portfolio_american_to_decimal(new.research_odds_american); end if;
  if new.closing_odds_american is not null and new.closing_odds_decimal is null then new.closing_odds_decimal := public.portfolio_american_to_decimal(new.closing_odds_american); end if;
  new.thesis := nullif(btrim(new.thesis), '');
  new.review_note := nullif(btrim(new.review_note), '');
  if new.decision_tags is not null then
    new.decision_tags := (select array_agg(distinct upper(btrim(t)) order by upper(btrim(t))) from unnest(new.decision_tags) t where btrim(t) <> '');
  end if;
  /* who said what the close was: a reader's closing price is the reader's
     word; only a connector or EdgeDesk's own capture may name another source,
     and a source once recorded stays */
  has_close := coalesce(new.closing_odds_decimal, new.closing_price, new.closing_line) is not null;
  if o->>'closing_source' is not null then new.closing_source := o->>'closing_source';
  elsif not has_close then new.closing_source := null;
  elsif reader or new.closing_source is null then new.closing_source := 'USER';
  end if;
  if tg_op = 'UPDATE' then
    n := to_jsonb(new);
    foreach k in array public.portfolio_journal_frozen_fields() loop
      if jsonb_typeof(coalesce(o->k, 'null'::jsonb)) <> 'null' and (n->k) is distinct from (o->k) then
        raise exception 'portfolio: a recorded decision is never rewritten (%)', k using errcode = '42501',
          hint = 'Add a review note instead; the original stays as it was.';
      end if;
    end loop;
  end if;
  /* when each part was first recorded: the grade only credits a model
     probability or a research price recorded before the event */
  new.decision_recorded_at := case when coalesce(new.decision_source, new.opening_odds_decimal::text, new.opening_line::text, new.opening_price::text,
      new.research_odds_decimal::text, new.research_line::text, new.research_price::text, new.model_probability::text, new.model_fair_line::text,
      new.edge_at_entry::text, new.planned::text, new.thesis, array_to_string(new.decision_tags, ',')) is null then null
    else coalesce((o->>'decision_recorded_at')::timestamptz, now_ts) end;
  new.model_recorded_at := case when new.model_probability is null then null else coalesce((o->>'model_recorded_at')::timestamptz, now_ts) end;
  new.research_recorded_at := case when coalesce(new.research_odds_decimal, new.research_price, new.research_line) is null then null
                                   else coalesce((o->>'research_recorded_at')::timestamptz, now_ts) end;
  new.tags_recorded_at := case when new.decision_tags is null and new.planned is null then null
                               else coalesce((o->>'tags_recorded_at')::timestamptz, now_ts) end;
  new.closing_recorded_at := case when has_close then coalesce((o->>'closing_recorded_at')::timestamptz, now_ts) end;
  if tg_op = 'INSERT' or (new.would_repeat, new.review_note, new.library) is distinct from (o->>'would_repeat', o->>'review_note', o->>'library') then
    new.reviewed_at := case when coalesce(new.would_repeat, new.review_note, new.library) is null then null else now_ts end;
  else
    new.reviewed_at := (o->>'reviewed_at')::timestamptz;
  end if;
  new.updated_at := now_ts;
  return new;
end $$;
drop trigger if exists portfolio_journal_guard_trg on public.portfolio_journal_entries;
create trigger portfolio_journal_guard_trg before insert or update on public.portfolio_journal_entries
  for each row execute function public.portfolio_journal_guard();

-- The unit and caps in force for a reader, read the way lib/edgedesk_bankroll.js
-- unitValue() reads them: a fixed unit, else a percentage of the bankroll,
-- else a typed unit, else none. bankroll_settings belongs to the staking
-- engine; this only reads it, and copes with it not existing at all.
create or replace function public.portfolio_unit_snapshot(p_user uuid)
returns table (unit numeric, bankroll numeric, max_single numeric, max_daily numeric)
language plpgsql stable as $$
declare j jsonb; mode text; pct numeric; base numeric; bank numeric;
begin
  if to_regclass('public.bankroll_settings') is null then return; end if;
  execute 'select to_jsonb(b) from public.bankroll_settings b where b.user_id = $1' into j using p_user;
  if j is null then return; end if;
  base := case when (j->>'base_unit_amount') ~ '^[0-9]+(\.[0-9]+)?$' and (j->>'base_unit_amount')::numeric > 0 then (j->>'base_unit_amount')::numeric end;
  bank := case when (j->>'bankroll_amount') ~ '^[0-9]+(\.[0-9]+)?$' and (j->>'bankroll_amount')::numeric > 0 then (j->>'bankroll_amount')::numeric end;
  pct := case when (j->>'unit_percent') ~ '^[0-9]*\.?[0-9]+$' then (j->>'unit_percent')::numeric end;
  if pct is null or pct <= 0 or pct > 0.10 then pct := 0.01; end if;
  mode := case when j->>'unit_mode' in ('fixed', 'percent') then j->>'unit_mode' when base is not null then 'fixed' else 'percent' end;
  unit := case when mode = 'fixed' and base is not null then base when bank is not null then round(bank * pct, 2) else base end;
  bankroll := bank;
  max_single := case when (j->>'maximum_single_wager_units') ~ '^[0-9]*\.?[0-9]+$' then (j->>'maximum_single_wager_units')::numeric end;
  max_daily := case when (j->>'maximum_daily_exposure_units') ~ '^[0-9]*\.?[0-9]+$' then (j->>'maximum_daily_exposure_units')::numeric end;
  return next;
end $$;

-- Every position gets its journal entry the moment it exists, with the
-- decision context it arrived with and the unit and caps in force then.
-- Attribution set on the position later fills only what the journal has not
-- recorded yet; it never replaces a recorded value.
create or replace function public.portfolio_positions_journal() returns trigger
language plpgsql as $$
declare u record; src text;
begin
  src := case new.edge_source when 'EDGEDESK' then 'EDGEDESK' when 'SELF' then 'USER' when 'OTHER' then 'OTHER' end;
  if tg_op = 'INSERT' then
    select * into u from public.portfolio_unit_snapshot(new.user_id);
    insert into public.portfolio_journal_entries (position_id, user_id, decision_source, model_version, model_probability, model_fair_line,
        research_line, edge_at_entry, confidence_tier, unit_size_at_entry, bankroll_at_entry, max_single_units_at_entry,
        max_daily_units_at_entry, unit_recorded_at)
    values (new.id, new.user_id, src, new.model_version, new.model_probability, new.model_fair_line, new.market_line_at_research,
        new.edge_at_entry, new.confidence_tier, u.unit, u.bankroll, u.max_single, u.max_daily, case when u.unit is not null then now() end)
    on conflict (position_id) do nothing;
  else
    update public.portfolio_journal_entries j set
           decision_source = coalesce(j.decision_source, src), model_version = coalesce(j.model_version, new.model_version),
           model_probability = coalesce(j.model_probability, new.model_probability), model_fair_line = coalesce(j.model_fair_line, new.model_fair_line),
           research_line = coalesce(j.research_line, new.market_line_at_research), edge_at_entry = coalesce(j.edge_at_entry, new.edge_at_entry),
           confidence_tier = coalesce(j.confidence_tier, new.confidence_tier)
     where j.position_id = new.id
       and ((j.decision_source is null and src is not null) or (j.model_version is null and new.model_version is not null)
         or (j.model_probability is null and new.model_probability is not null) or (j.model_fair_line is null and new.model_fair_line is not null)
         or (j.research_line is null and new.market_line_at_research is not null) or (j.edge_at_entry is null and new.edge_at_entry is not null)
         or (j.confidence_tier is null and new.confidence_tier is not null));
  end if;
  return null;
end $$;
drop trigger if exists portfolio_positions_journal_ins_trg on public.portfolio_positions;
create trigger portfolio_positions_journal_ins_trg after insert on public.portfolio_positions
  for each row execute function public.portfolio_positions_journal();
drop trigger if exists portfolio_positions_journal_upd_trg on public.portfolio_positions;
create trigger portfolio_positions_journal_upd_trg after update on public.portfolio_positions
  for each row when ((old.edge_source, old.model_version, old.model_probability, old.model_fair_line, old.market_line_at_research,
                      old.edge_at_entry, old.confidence_tier)
       is distinct from (new.edge_source, new.model_version, new.model_probability, new.model_fair_line, new.market_line_at_research,
                      new.edge_at_entry, new.confidence_tier))
  execute function public.portfolio_positions_journal();

-- positions that existed before the journal: an entry each, recorded now
-- (the conservative stamp — a model probability that cannot be shown to
-- predate the event is not credited as pre-event)
insert into public.portfolio_journal_entries (position_id, user_id, decision_source, model_version, model_probability, model_fair_line,
    research_line, edge_at_entry, confidence_tier)
select p.id, p.user_id, case p.edge_source when 'EDGEDESK' then 'EDGEDESK' when 'SELF' then 'USER' when 'OTHER' then 'OTHER' end,
       p.model_version, p.model_probability, p.model_fair_line, p.market_line_at_research, p.edge_at_entry, p.confidence_tier
  from public.portfolio_positions p
 where not exists (select 1 from public.portfolio_journal_entries j where j.position_id = p.id);
