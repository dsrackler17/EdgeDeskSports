-- Model Collective, migration 6: distribution and money tables, inert.
-- Attribution, entitlement, and payout tables exist from the first day so
-- the data is captured before billing turns on (rule 8.13): retrofitting
-- attribution is impossible because the data was never captured.

-- Origin allowlist per creator: what makes the embed slug in page source
-- harmless anywhere else.
create table collective.embed_installs (
  id           uuid primary key default gen_random_uuid(),
  creator_id   uuid not null references collective.creators(id),
  origin       text not null,
  status       text not null default 'active' check (status in ('active','disabled')),
  last_seen_at timestamptz,
  created_at   timestamptz not null default now()
);
create unique index embed_installs_uniq on collective.embed_installs (creator_id, lower(origin));
alter table collective.embed_installs enable row level security;
grant select, insert, update, delete on collective.embed_installs to service_role;

-- Engagement evidence, append-only. Pays creators on bringing an audience,
-- never on being right (Section 5: never pay on model accuracy).
create table collective.embed_events (
  id               uuid primary key default gen_random_uuid(),
  creator_id       uuid references collective.creators(id),
  event_type       collective.embed_event_type not null,
  visitor_id       text,
  target_creator_id uuid,
  path             text,
  referrer         text,
  origin           text,
  occurred_at      timestamptz not null default now()
);
create index embed_events_creator_time on collective.embed_events (creator_id, occurred_at desc);
alter table collective.embed_events enable row level security;
grant select, insert on collective.embed_events to service_role;
create trigger embed_events_append_only
  before update or delete on collective.embed_events
  for each row execute function collective.block_mutation();

-- First touch attribution (Section 5): first wins, recorded on the embed
-- and on any Collective link carrying a creator slug.
create table collective.attribution_touches (
  id         uuid primary key default gen_random_uuid(),
  visitor_id text not null,
  creator_id uuid not null references collective.creators(id),
  source     text not null check (source in ('embed','link')),
  origin     text,
  touched_at timestamptz not null default now()
);
create index attribution_touches_visitor on collective.attribution_touches (visitor_id, touched_at);
alter table collective.attribution_touches enable row level security;
grant select, insert on collective.attribution_touches to service_role;
create trigger attribution_touches_append_only
  before update or delete on collective.attribution_touches
  for each row execute function collective.block_mutation();

-- Attribution locks at conversion and never moves: unique per subscriber,
-- no update grant, append-only trigger. Two creators cannot claim the same
-- subscriber.
create table collective.attributions (
  id                    uuid primary key default gen_random_uuid(),
  subscriber_user_id    uuid,
  subscriber_email_hash text,
  creator_id            uuid not null references collective.creators(id),
  visitor_id            text,
  source                text,
  locked_at             timestamptz not null default now()
);
create unique index attributions_user_uniq  on collective.attributions (subscriber_user_id)  where subscriber_user_id is not null;
create unique index attributions_email_uniq on collective.attributions (subscriber_email_hash) where subscriber_email_hash is not null;
alter table collective.attributions enable row level security;
grant select, insert on collective.attributions to service_role;
create trigger attributions_append_only
  before update or delete on collective.attributions
  for each row execute function collective.block_mutation();

-- The Collective's own subscribers (Mode A). Entitlement is checked by the
-- Collective at the API layer, never by a host site.
create table collective.subscribers (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid unique,
  email                  text,
  status                 collective.sub_status not null,
  plan                   text check (plan in ('monthly','annual')),
  stripe_customer_id     text,
  stripe_subscription_id text unique,
  attribution_id         uuid references collective.attributions(id),
  current_period_end     timestamptz,
  started_at             timestamptz not null default now(),
  canceled_at            timestamptz,
  created_at             timestamptz not null default now()
);
alter table collective.subscribers enable row level security;
grant select, insert, update on collective.subscribers to service_role;

-- Money movements, append-only. Earnings post per paid invoice at the
-- creator's own referral_share_bps; annual pays on the full amount when it
-- clears; clawbacks are negative rows inside payout.clawback_days; payouts
-- are negative rows when paid. Balance is always sum(amount_cents).
create table collective.earnings_ledger (
  id            uuid primary key default gen_random_uuid(),
  creator_id    uuid not null references collective.creators(id),
  subscriber_id uuid references collective.subscribers(id),
  entry_type    collective.ledger_type not null,
  amount_cents  int not null,
  period_month  date not null,
  available_at  timestamptz,
  stripe_ref    text,
  note          text,
  created_at    timestamptz not null default now()
);
create index earnings_creator_month on collective.earnings_ledger (creator_id, period_month);
create unique index earnings_invoice_once
  on collective.earnings_ledger (stripe_ref) where entry_type = 'earning' and stripe_ref is not null;
-- Stripe delivers webhooks at least once: a replayed refund must not
-- double-debit the creator.
create unique index earnings_clawback_once
  on collective.earnings_ledger (stripe_ref) where entry_type = 'clawback' and stripe_ref is not null;
alter table collective.earnings_ledger enable row level security;
grant select, insert on collective.earnings_ledger to service_role;
create trigger earnings_ledger_append_only
  before update or delete on collective.earnings_ledger
  for each row execute function collective.block_mutation();

-- Stripe Connect is requested only after the first successful submission,
-- never at signup (Section 6).
create table collective.payout_accounts (
  creator_id        uuid primary key references collective.creators(id),
  stripe_connect_id text,
  status            text not null default 'unstarted' check (status in ('unstarted','requested','connected','disabled')),
  requested_at      timestamptz,
  connected_at      timestamptz
);
alter table collective.payout_accounts enable row level security;
grant select, insert, update on collective.payout_accounts to service_role;

-- Mode B seat reporting: minimum 10 seats, wholesale.seat_cents each,
-- billed monthly on actual seat count.
create table collective.wholesale_seats (
  id           uuid primary key default gen_random_uuid(),
  creator_id   uuid not null references collective.creators(id),
  period_month date not null,
  seat_count   int not null check (seat_count >= 10),
  reported_at  timestamptz not null default now(),
  invoiced     boolean not null default false,
  unique (creator_id, period_month)
);
alter table collective.wholesale_seats enable row level security;
grant select, insert, update on collective.wholesale_seats to service_role;

-- Sliding-window rate limiting evidence. Pruned by maintenance.
create table collective.api_request_log (
  id         bigint generated always as identity primary key,
  api_key_id uuid,
  endpoint   text,
  at         timestamptz not null default now()
);
create index api_request_log_window on collective.api_request_log (api_key_id, at desc);
alter table collective.api_request_log enable row level security;
grant select, insert on collective.api_request_log to service_role;
create trigger api_request_log_append_only
  before update or delete on collective.api_request_log
  for each row execute function collective.block_mutation();

-- Creator-facing earnings rollup: if a creator cannot see what the
-- Collective earned them this month, they will assume it is nothing.
create view collective.creator_earnings_monthly as
select
  c.id as creator_id, c.slug as creator_slug,
  l.period_month,
  sum(l.amount_cents) filter (where l.entry_type = 'earning')  as earned_cents,
  -sum(l.amount_cents) filter (where l.entry_type = 'clawback') as clawed_cents,
  -sum(l.amount_cents) filter (where l.entry_type = 'payout')   as paid_cents,
  sum(l.amount_cents)                                           as balance_cents,
  -- Earnings mature at available_at; clawbacks and payouts must always
  -- count against availability (clawbacks carry the available_at of the
  -- earning they reverse, payouts carry none).
  sum(l.amount_cents) filter (where l.available_at is null or l.available_at <= now())
                                                                as available_cents
from collective.creators c
join collective.earnings_ledger l on l.creator_id = c.id
group by c.id, c.slug, l.period_month;
grant select on collective.creator_earnings_monthly to service_role;
