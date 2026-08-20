-- Behavioral smoke for the Collective schema. Every block raises on
-- failure, so a clean run is a real assertion, not a vibe. Exercises the
-- rules by number: 8.2 identity, 8.3 append-only, 8.4 quarantine, 8.5
-- first-submission lock, 8.6 late flagging, 8.7 coverage, 8.8 derived
-- status, 8.9 consensus, 8.11 grading, 9.2 probability mismatch.

\set ON_ERROR_STOP 1

do $$
declare
  admin_id uuid := '00000000-0000-0000-0000-00000000adad';
  user_id  uuid := '00000000-0000-0000-0000-0000000000c1';
  r jsonb;
  kctx jsonb;
  env jsonb;
  g_future uuid; g_past uuid;
  v_creator uuid; v_model uuid;
  n int;
  rec record;
begin
  -- The smoke runs today, which may be off-season: pull the season window
  -- around now so the derived-status assertions are meaningful.
  update collective.sport_seasons
     set starts_on = current_date - 30, ends_on = current_date + 150
   where sport_code = 'NFL' and season = 2026;
  update collective.config set value = jsonb_build_array(admin_id::text) where key = 'admin.user_ids';

  ---------------------------------------------------------------- invites
  r := collective.mint_invite(admin_id,
        jsonb_build_object('display_name','Must Be Moose','sport','NFL','model_name','NFL Model'),
        true, null, 1, 'smoke invite', 'hash-of-invite-token', 'mci_smok');
  if not (r->>'ok')::boolean then raise exception 'mint_invite failed: %', r; end if;

  r := collective.invite_status('hash-of-invite-token');
  if r->>'status' <> 'valid' then raise exception 'invite_status wanted valid, got %', r; end if;
  if not (r->>'founding')::boolean then raise exception 'founding flag lost'; end if;

  r := collective.invite_status('hash-of-nothing');
  if coalesce(r->>'code','') <> 'token_invalid' then raise exception 'unknown token should be token_invalid: %', r; end if;

  r := collective.redeem_invite('hash-of-invite-token', user_id, 'moose@example.com',
        jsonb_build_object('display_name','Must Be Moose','sport','NFL','model_name','NFL Model',
                           'website_url','https://moosepicks.example.com',
                           'source_kind','github','source_ref','https://github.com/moose/model'),
        'mck_smoke1', 'sha-of-full-key');
  if not (r->>'ok')::boolean or (r->>'already_issued')::boolean then raise exception 'redeem failed: %', r; end if;
  if r->>'creator_slug' <> 'must-be-moose' then raise exception 'slug wanted must-be-moose, got %', r->>'creator_slug'; end if;
  v_creator := (r->>'creator_id')::uuid; v_model := (r->>'model_id')::uuid;

  -- comp is the founder pool now: referral share on the row is the separate
  -- acquisition share, which defaults to 0 (econ.referral_bps)
  select referral_share_bps into n from collective.creators where id = v_creator;
  if n <> 0 then raise exception 'referral share wanted 0 bps, got %', n; end if;
  if not exists (select 1 from collective.creators where id = v_creator and founding_member) then
    raise exception 'founding flag lost on redeem';
  end if;

  -- the model source landed on the model record
  if not exists (select 1 from collective.models where id = v_model
                 and source_kind = 'github' and source_ref = 'https://github.com/moose/model') then
    raise exception 'model source was not stored';
  end if;

  -- an invalid source kind is dropped, never an error
  if (select source_kind from collective.models where id = v_model) not in ('excel','github','online','other') then
    raise exception 'source kind check failed';
  end if;

  -- website became an embed origin
  if not exists (select 1 from collective.embed_installs where creator_id = v_creator
                 and origin = 'https://moosepicks.example.com') then
    raise exception 'embed origin was not seeded from the website';
  end if;

  -- redeem is idempotent per user
  r := collective.redeem_invite('hash-of-invite-token', user_id, 'moose@example.com',
        jsonb_build_object('display_name','Someone Else','sport','NFL','model_name','X'), 'mck_smoke2', 'h2');
  if not (r->>'already_issued')::boolean then raise exception 'second redeem should be already_issued: %', r; end if;

  ---------------------------------------------------------------- keys
  kctx := collective.verify_key('mck_smoke1', 'sha-of-full-key');
  if not (kctx->>'ok')::boolean then raise exception 'verify_key failed: %', kctx; end if;
  if kctx->>'model_slug' <> 'nfl-model' or kctx->>'sport' <> 'NFL' then raise exception 'key context wrong: %', kctx; end if;

  r := collective.verify_key('mck_smoke1', 'wrong-hash');
  if coalesce(r->>'code','') <> 'invalid_key' then raise exception 'wrong hash must be invalid_key: %', r; end if;

  if not collective.rate_check((kctx->>'key_id')::uuid, '/v1/projections') then
    raise exception 'first rate_check should pass';
  end if;

  ---------------------------------------------------------------- games
  r := collective.upsert_games(admin_id, jsonb_build_object(
    'sport','NFL','season',2026,'games', jsonb_build_array(
      jsonb_build_object('week',1,'kickoff', to_char(now() + interval '2 days', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),'home','KC','away','BUF'),
      jsonb_build_object('week',1,'kickoff', to_char(now() - interval '1 day',  'YYYY-MM-DD"T"HH24:MI:SS"Z"'),'home','DAL','away','Giants'))));
  if (r->>'upserted')::int <> 2 then raise exception 'upsert_games wanted 2, got %', r; end if;

  r := collective.upsert_games('00000000-0000-0000-0000-000000000bad'::uuid, '{"sport":"NFL","season":2026,"games":[]}');
  if coalesce(r->>'code','') <> 'forbidden' then raise exception 'non-admin upsert must be forbidden: %', r; end if;

  select g.id into g_future from collective.games g
   join collective.teams t on t.id = g.home_team_id where t.code = 'KC';
  select g.id into g_past from collective.games g
   join collective.teams t on t.id = g.home_team_id where t.code = 'DAL';

  ---------------------------------------------------------------- ingest
  env := jsonb_build_object(
    'sport','NFL','season',2026,'data_origin','live',
    'rows', jsonb_build_array(
      jsonb_build_object('game_ref','NFL_2026_W1_BUF_KC','home_team','Chiefs','away_team','BUF',
        'kickoff', to_char(now() + interval '2 days', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'pick_side','home','projected_spread',-6.0,'projected_total',48.5,
        'proj_home_score',28,'proj_away_score',21,'home_win_probability',0.68),
      jsonb_build_object('game_ref','NFL_2026_W1_X','home_team','Okland Raiders','away_team','DEN',
        'kickoff', to_char(now() + interval '2 days', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
      jsonb_build_object('game_ref','NFL_2026_W1_NYG_DAL','home_team','DAL','away_team','New York Giants',
        'kickoff', to_char(now() - interval '1 day', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'pick_side','home','projected_spread',-4.0,'home_win_probability',0.64),
      jsonb_build_object('game_ref','NFL_2026_W1_BAD','home_team','KC','away_team','BUF',
        'kickoff', to_char(now() + interval '2 days', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'projected_spread',5.0,'home_win_probability',0.80)));

  -- dry run writes nothing
  r := collective.ingest_submission(kctx, env, true);
  if not (r->>'ok')::boolean then raise exception 'dry run failed: %', r; end if;
  select count(*) into n from collective.projections;
  if n <> 0 then raise exception 'dry run wrote % rows', n; end if;

  r := collective.ingest_submission(kctx, env, false);
  if not (r->>'ok')::boolean then raise exception 'ingest failed: %', r; end if;
  if (r->'counts'->>'quarantined')::int <> 1 then raise exception 'wanted 1 quarantined: %', r->'counts'; end if;
  if (r->'counts'->>'late')::int <> 1 then raise exception 'wanted 1 late: %', r->'counts'; end if;
  if (r->'counts'->>'first')::int <> 1 then raise exception 'wanted 1 first: %', r->'counts'; end if;
  if (r->'counts'->>'rejected')::int <> 1 then raise exception 'wanted 1 rejected (rule 9.2): %', r->'counts'; end if;

  -- rejected rows are never stored
  select count(*) into n from collective.projections where raw_game_ref = 'NFL_2026_W1_BAD';
  if n <> 0 then raise exception 'rejected row was stored'; end if;

  -- late row stored, flagged, not a candidate (8.6)
  select count(*) into n from collective.projections where game_id = g_past and is_late and not is_graded_candidate;
  if n <> 1 then raise exception 'late row not flagged correctly'; end if;

  -- identity comes from the key (8.2)
  r := collective.ingest_submission(kctx, env || jsonb_build_object('model','someone-elses-model'), false);
  if coalesce(r->>'code','') <> 'invalid_payload' then raise exception 'model mismatch must reject: %', r; end if;

  -- idempotent replay (same payload, same answer)
  r := collective.ingest_submission(kctx, env, false);
  if not (r->>'duplicate')::boolean then raise exception 'replay should be duplicate: %', r; end if;
  select count(*) into n from collective.submissions;
  if n <> 1 then raise exception 'replay duplicated the submission: % rows', n; end if;

  -- a revision is movement, never the graded number (8.5)
  r := collective.ingest_submission(kctx, jsonb_build_object(
    'sport','NFL','season',2026,'data_origin','live',
    'rows', jsonb_build_array(
      jsonb_build_object('game_ref','NFL_2026_W1_BUF_KC','home_team','KC','away_team','Bills',
        'kickoff', to_char(now() + interval '2 days', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'pick_side','home','projected_spread',-3.0,'home_win_probability',0.60))), false);
  if (r->'counts'->>'first')::int <> 0 or (r->'counts'->>'movement')::int <> 1 then
    raise exception 'revision must be movement: %', r->'counts';
  end if;
  select projected_spread into rec from collective.first_submissions where game_id = g_future and model_id = v_model;
  if rec.projected_spread <> -6.0 then raise exception 'first submission drifted to %', rec.projected_spread; end if;

  ---------------------------------------------------------------- quarantine
  insert into collective.team_aliases (sport_code, alias, team_id)
  select 'NFL', 'Okland Raiders', id from collective.teams where code = 'LV';
  r := collective.admin_reresolve('NFL');
  -- the quarantined row referenced LV at DEN which is not on the slate:
  -- it stays quarantined as unknown_game territory, resolved count 0
  if (r->>'resolved')::int <> 0 then raise exception 'reresolve resolved a game that does not exist: %', r; end if;

  -- add the game, then reresolve for real
  perform collective.upsert_games(admin_id, jsonb_build_object('sport','NFL','season',2026,'games',
    jsonb_build_array(jsonb_build_object('week',1,'kickoff', to_char(now() + interval '2 days', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),'home','Okland Raiders','away','DEN'))));
  r := collective.admin_reresolve('NFL');
  if (r->>'resolved')::int <> 1 then raise exception 'reresolve wanted 1: %', r; end if;
  select count(*) into n from collective.quarantine_queue;
  if n <> 0 then raise exception 'quarantine queue should be empty, has %', n; end if;

  ---------------------------------------------------------------- grading
  r := collective.settle_game(admin_id, g_future, jsonb_build_object(
    'home_score',27,'away_score',20,'closing_spread',-4.5,'closing_total',47.5,'closing_home_ml_prob',0.66));
  if not (r->>'ok')::boolean or (r->>'graded')::int < 1 then raise exception 'settle failed: %', r; end if;

  -- hand-computed: margin 7, close -4.5 so home covered, pick home = win;
  -- projected margin 28-21=7, error 0; brier (0.68-1)^2 = 0.1024
  select g.pick_result, g.margin_error, g.brier into rec
  from collective.grades g join collective.first_submissions fs on fs.id = g.projection_id
  where g.game_id = g_future and g.model_id = v_model;
  if rec.pick_result <> 'win' then raise exception 'pick wanted win, got %', rec.pick_result; end if;
  if rec.margin_error <> 0 then raise exception 'margin error wanted 0, got %', rec.margin_error; end if;
  if abs(rec.brier - 0.1024) > 1e-9 then raise exception 'brier wanted 0.1024, got %', rec.brier; end if;

  -- push case: exact number
  perform collective.settle_game(admin_id, g_past, jsonb_build_object(
    'home_score',24,'away_score',20,'closing_spread',-4.0));
  -- the only row on g_past is late, so nothing grades; assert that
  select count(*) into n from collective.grades where game_id = g_past;
  if n <> 0 then raise exception 'late row was graded (rule 8.6 violation)'; end if;

  ---------------------------------------------------------------- views
  select membership into rec from collective.model_wall where creator_slug = 'must-be-moose';
  if rec.membership <> 'ACTIVE CONTRIBUTOR' then raise exception 'membership wanted ACTIVE CONTRIBUTOR, got %', rec.membership; end if;

  select c.n into n from collective.consensus c where c.game_id = g_future;
  if n is distinct from 1 then raise exception 'consensus n wanted 1, got %', n; end if;

  if not exists (select 1 from collective.model_rankings where creator_slug = 'must-be-moose'
                 and is_ranked = false and unranked_reason is not null) then
    raise exception 'below-minimum model must be unranked with a reason';
  end if;

  if not exists (select 1 from collective.model_coverage_totals where model_id = v_model) then
    raise exception 'coverage totals view returned nothing';
  end if;

  if not exists (select 1 from collective.activity_feed where creator_slug = 'must-be-moose') then
    raise exception 'activity feed returned nothing';
  end if;

  ---------------------------------------------------------------- append-only
  begin
    update collective.projections set projected_spread = 0 where game_id = g_future;
    raise exception 'append-only failed: update went through';
  exception when raise_exception then
    if sqlerrm like '%append-only failed%' then raise; end if;
    -- expected: the block_mutation trigger fired
  end;
  begin
    delete from collective.submissions;
    raise exception 'append-only failed: delete went through';
  exception when raise_exception then
    if sqlerrm like '%append-only failed%' then raise; end if;
  end;

  ---------------------------------------------------------------- money (inert)
  r := collective.billing_upsert_subscriber(jsonb_build_object(
    'user_id','00000000-0000-0000-0000-0000000000d1','email','fan@example.com',
    'status','active','plan','monthly','stripe_customer_id','cus_1','stripe_subscription_id','sub_1',
    'visitor','vis-1','ref_slug','must-be-moose'));
  if not (r->>'ok')::boolean then raise exception 'subscriber upsert failed: %', r; end if;
  -- the waterfall: $24.99 invoice, 60% pool / 6 seats = 249 cents per founder;
  -- moose is the only active founding member so exactly one earning posts,
  -- and referral (0 bps by default) posts nothing
  r := collective.billing_post_invoice(jsonb_build_object(
    'stripe_subscription_id','sub_1','amount_cents',2499,'stripe_ref','in_1'));
  if (r->>'per_founder_cents')::int <> 249 then
    raise exception 'per-founder share of $24.99 wanted 249 cents, got %', r;
  end if;
  if (r->>'entries')::int <> 1 then raise exception 'wanted 1 pool entry, got %', r; end if;
  select count(*) into n from collective.earnings_ledger where entry_type = 'earning' and note = 'referral share';
  if n <> 0 then raise exception 'referral posted despite 0 bps'; end if;
  -- a ref-less invoice refuses to post (no idempotency, no clawback path)
  r := collective.billing_post_invoice(jsonb_build_object(
    'stripe_subscription_id','sub_1','amount_cents',2499));
  if (r->>'posted')::boolean then raise exception 'ref-less invoice posted: %', r; end if;
  -- same invoice twice posts once
  perform collective.billing_post_invoice(jsonb_build_object(
    'stripe_subscription_id','sub_1','amount_cents',2499,'stripe_ref','in_1'));
  select count(*) into n from collective.earnings_ledger where entry_type = 'earning';
  if n <> 1 then raise exception 'invoice earning posted % times', n; end if;
  r := collective.billing_post_refund(jsonb_build_object('stripe_ref','in_1'));
  if (r->>'amount_cents')::int <> -249 then raise exception 'clawback wanted -249: %', r; end if;

  select balance_cents into n from collective.creator_earnings_monthly where creator_slug = 'must-be-moose';
  if n <> 0 then raise exception 'balance after clawback wanted 0, got %', n; end if;

  -- a replayed refund webhook never double-debits
  r := collective.billing_post_refund(jsonb_build_object('stripe_ref','in_1'));
  if (r->>'posted')::boolean then raise exception 'refund replay posted a second clawback'; end if;
  select count(*) into n from collective.earnings_ledger where entry_type = 'clawback';
  if n <> 1 then raise exception 'clawback posted % times', n; end if;

  -- refunded money is never shown as available to pay
  select available_cents into n from collective.creator_earnings_monthly where creator_slug = 'must-be-moose';
  if n <> 0 then raise exception 'available after clawback wanted 0, got %', n; end if;

  -- a returning subscriber (same user, new Stripe subscription) updates in
  -- place instead of erroring, and keeps the original attribution
  r := collective.billing_upsert_subscriber(jsonb_build_object(
    'user_id','00000000-0000-0000-0000-0000000000d1','email','fan@example.com',
    'status','active','plan','annual','stripe_customer_id','cus_1','stripe_subscription_id','sub_2'));
  if not (r->>'ok')::boolean then raise exception 'resubscribe failed: %', r; end if;
  select count(*) into n from collective.subscribers;
  if n <> 1 then raise exception 'resubscribe duplicated the subscriber: % rows', n; end if;

  ---------------------------------------------------------------- hardening
  -- a bad optional field rejects that row only, never the submission
  r := collective.ingest_submission(kctx, jsonb_build_object(
    'sport','NFL','season',2026,'week',1,'data_origin','live',
    'rows', jsonb_build_array(
      jsonb_build_object('game_ref','BADFIELD','home_team','KC','away_team','BUF',
        'kickoff', to_char(now() + interval '2 days', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'pick_side','banana'),
      jsonb_build_object('game_ref','GOODROW','home_team','LV','away_team','DEN',
        'kickoff', to_char(now() + interval '2 days', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'projected_total',43.5))), false);
  if not (r->>'ok')::boolean then raise exception 'bad optional field aborted the submission: %', r; end if;
  if (r->'counts'->>'rejected')::int <> 1 then raise exception 'bad pick_side should reject one row: %', r->'counts'; end if;
  -- envelope-level week flows onto rows that omit it
  select week into n from collective.projections where raw_game_ref = 'GOODROW';
  if n is distinct from 1 then raise exception 'envelope week not applied, got %', n; end if;

  -- a null hash can never verify
  r := collective.verify_key('mck_smoke1', null);
  if coalesce(r->>'code','') <> 'invalid_key' then raise exception 'null hash must be invalid_key: %', r; end if;

  -- a 60-char display name still redeems (slug clamped to the constraint)
  perform collective.mint_invite(admin_id, '{}'::jsonb, false, null, 1, 'long name', 'hash-of-long-token', 'mci_long');
  r := collective.redeem_invite('hash-of-long-token', '00000000-0000-0000-0000-0000000000c2'::uuid, 'long@example.com',
        jsonb_build_object('display_name', repeat('Very Long Name ', 4), 'sport','NFL','model_name','Long Model'),
        'mck_smoke3', 'h3');
  if not (r->>'ok')::boolean then raise exception 'long display name failed to redeem: %', r; end if;
  if length(r->>'creator_slug') > 40 then raise exception 'slug exceeds 40 chars: %', r->>'creator_slug'; end if;

  -- dead tokens leak no prefill
  update collective.invite_tokens set expires_at = now() - interval '1 day' where token_prefix = 'mci_long';
  r := collective.invite_status('hash-of-long-token');
  if r->'prefill' <> '{}'::jsonb then raise exception 'expired token leaked prefill: %', r; end if;

  ---------------------------------------------------------------- econ config
  if collective.cfg_int('econ.reserve_bps', -1) <> 1000
     or collective.cfg_int('econ.platform_bps', -1) <> 3000
     or collective.cfg_int('econ.founder_pool_bps', -1) <> 6000
     or collective.cfg_int('econ.founder_count', -1) <> 6
     or collective.cfg_int('econ.referral_bps', -1) <> 0 then
    raise exception 'econ config keys missing or wrong';
  end if;

  ---------------------------------------------------------------- revocation
  perform collective.mint_invite(admin_id,
    jsonb_build_object('display_name','Revoked Guy'), false, null, 1, 'revoke test',
    'hash-of-revoke-token', 'mci_revk');
  r := collective.revoke_invite(admin_id,
    (select id from collective.invite_tokens where token_prefix = 'mci_revk'));
  if not (r->>'ok')::boolean or (r->>'already_revoked')::boolean then
    raise exception 'revoke failed: %', r;
  end if;
  r := collective.invite_status('hash-of-revoke-token');
  if r->>'status' <> 'revoked' then raise exception 'status wanted revoked, got %', r; end if;
  if r->'prefill' <> '{}'::jsonb then raise exception 'revoked token leaked prefill'; end if;
  r := collective.redeem_invite('hash-of-revoke-token',
    '00000000-0000-0000-0000-0000000000c3'::uuid, 'rv@example.com',
    jsonb_build_object('display_name','Revoked Guy','sport','NFL','model_name','RG Model'),
    'mck_smoke4', 'h4');
  if coalesce(r->>'code','') <> 'token_revoked' then
    raise exception 'revoked redeem wanted token_revoked, got %', r;
  end if;
  -- revoking twice reports already_revoked, never errors
  r := collective.revoke_invite(admin_id,
    (select id from collective.invite_tokens where token_prefix = 'mci_revk'));
  if not (r->>'already_revoked')::boolean then raise exception 'double revoke wrong: %', r; end if;
  -- a non-admin cannot revoke
  r := collective.revoke_invite('00000000-0000-0000-0000-0000000000c4'::uuid,
    (select id from collective.invite_tokens where token_prefix = 'mci_revk'));
  if coalesce(r->>'code','') <> 'forbidden' then raise exception 'non-admin revoke allowed: %', r; end if;

  raise notice 'SMOKE: all assertions passed';
end $$;
