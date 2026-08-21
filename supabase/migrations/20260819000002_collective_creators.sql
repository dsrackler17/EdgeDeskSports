-- Model Collective, migration 2: creators, models, api keys, invite tokens.
-- user_id is a bare uuid on purpose: no FK into auth.users, so the schema
-- stays liftable (rule 8.1). Identity always comes from the authenticated
-- key or JWT, never from payload strings (rule 8.2).

create table collective.creators (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid unique,
  slug               text not null unique
                       check (slug ~ '^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$'),
  display_name       text not null check (length(display_name) between 2 and 60),
  description        text,
  website_url        text,
  x_handle           text,
  logo_url           text,
  status             collective.creator_status not null default 'active',
  is_listed          boolean not null default true,
  founding_member    boolean not null default false,
  -- The money number travels on the creator record, not on a tier check,
  -- so founding terms survive any later tier changes (Section 5).
  referral_share_bps int not null default 4000 check (referral_share_bps between 0 and 10000),
  billing_mode       collective.billing_mode not null default 'referral',
  pinned_model_id    uuid,
  invite_token_id    uuid,
  created_at         timestamptz not null default now()
);
alter table collective.creators enable row level security;
grant select, insert, update on collective.creators to service_role;

create table collective.models (
  id          uuid primary key default gen_random_uuid(),
  creator_id  uuid not null references collective.creators(id) on delete restrict,
  slug        text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$'),
  name        text not null check (length(name) between 2 and 60),
  sport_code  text not null references collective.sports(code),
  description text,
  is_listed   boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (creator_id, slug)
);
alter table collective.models enable row level security;
grant select, insert, update on collective.models to service_role;

-- Keys: mck_live_/mck_test_ + 8 char prefix + 32 char secret. Only the
-- prefix and the sha256 of the full raw key are stored; the raw key is
-- shown exactly once at issue time.
create table collective.api_keys (
  id           uuid primary key default gen_random_uuid(),
  creator_id   uuid not null references collective.creators(id),
  model_id     uuid references collective.models(id),
  scope        collective.key_scope not null default 'submit',
  kind         text not null default 'live' check (kind in ('live','test')),
  key_prefix   text not null unique,
  key_hash     text not null,
  status       collective.key_status not null default 'active',
  last_used_at timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now()
);
create index api_keys_creator on collective.api_keys (creator_id);
alter table collective.api_keys enable row level security;
grant select, insert, update on collective.api_keys to service_role;

-- Invite tokens: the entire join flow is one link (Section 6). Hashed at
-- rest; the raw token is shown once to the founder at mint time.
create table collective.invite_tokens (
  id                 uuid primary key default gen_random_uuid(),
  token_hash         text not null unique,
  token_prefix       text not null,
  prefill            jsonb not null default '{}'::jsonb,
  founding_member    boolean not null default false,
  referral_share_bps int check (referral_share_bps between 0 and 10000),
  max_uses           int not null default 1 check (max_uses >= 1),
  use_count          int not null default 0,
  expires_at         timestamptz not null,
  note               text,
  created_by         uuid,
  created_at         timestamptz not null default now()
);
alter table collective.invite_tokens enable row level security;
grant select, insert, update on collective.invite_tokens to service_role;

-- Join requests from dead-token pages: stored, not just logged, so a lost
-- creator is never silently dropped.
create table collective.join_requests (
  id         uuid primary key default gen_random_uuid(),
  email      text not null,
  note       text,
  token_seen text,
  created_at timestamptz not null default now()
);
alter table collective.join_requests enable row level security;
grant select, insert on collective.join_requests to service_role;
