-- ===========================================================================
-- EdgeDesk — supabase/community_posts.sql, attacked on a real PostgreSQL.
--
-- THE PROPERTY THIS FILE EXISTS FOR: any signed-in account may WRITE, and
-- only an entitled subscriber may PUBLISH without an editor reading the post
-- first. That is a statement about a VALUE in a column, which an RLS policy
-- cannot express, so it lives in a trigger — and a trigger nobody attacked is
-- a trigger nobody has checked. Everything below runs as the role and the
-- user it claims to be, through the same PostgREST-shaped path a browser
-- takes.
--
-- The second property, worth as much: a member post is not EdgeDesk research.
-- Nothing here can put one in public.site_articles, in a sitemap, or under
-- EdgeDesk's own byline.
-- ===========================================================================
set client_min_messages = notice;

create or replace function pg_temp.ok(p_name text, p_cond boolean, p_detail text default null)
returns void language plpgsql as $$
begin
  if p_cond then raise notice 'ok   %', p_name;
  else raise exception 'FAIL: % %', p_name, coalesce('— ' || p_detail, '');
  end if;
end; $$;

do $test$
declare
  FREE    constant uuid := '10000000-0000-0000-0000-000000000001';
  PAID    constant uuid := '10000000-0000-0000-0000-000000000002';
  TRIALER constant uuid := '10000000-0000-0000-0000-000000000003';
  LAPSED  constant uuid := '10000000-0000-0000-0000-000000000004';
  COMPED  constant uuid := '10000000-0000-0000-0000-000000000005';
  OPER    constant uuid := '10000000-0000-0000-0000-0000000000aa';
  BODY    constant text := repeat('Missouri rates better on a neutral field and the rating gap is 3.9 points. ', 6);
  st text; n integer; ts timestamptz; ts2 timestamptz; failed boolean; pid uuid;
begin
  insert into auth.users(id,email) values
    (FREE,'free@x.co'),(PAID,'paid@x.co'),(TRIALER,'trial@x.co'),
    (LAPSED,'lapsed@x.co'),(COMPED,'comp@x.co'),(OPER,'op@x.co')
  on conflict do nothing;

  -- the subscription states the entitlement rule has to tell apart
  insert into public.subscriptions(user_id,status,price_id,current_period_end) values
    (PAID,'active','price_live', now() + interval '20 days'),
    (TRIALER,'trialing','price_live', now() + interval '5 days'),
    (LAPSED,'canceled','price_live', now() - interval '2 days'),
    (COMPED,'active','owner_comp', null)
  on conflict (user_id) do update set status = excluded.status,
    price_id = excluded.price_id, current_period_end = excluded.current_period_end;
  -- FREE has no row at all, which is the commonest case of all
  insert into public.site_article_admins(user_id, note) values (OPER,'test operator')
    on conflict do nothing;

  -- ── 1. THE ENTITLEMENT RULE ITSELF ──────────────────────────────────────
  perform pg_temp.ok('an account with no subscription is not entitled', not public.community_is_entitled(FREE));
  perform pg_temp.ok('an active subscriber is', public.community_is_entitled(PAID));
  perform pg_temp.ok('a trialing account is — a trial is a subscription', public.community_is_entitled(TRIALER));
  perform pg_temp.ok('a cancelled account is not', not public.community_is_entitled(LAPSED));
  perform pg_temp.ok('a comp is, on the row alone', public.community_is_entitled(COMPED));
  update public.subscriptions set status='past_due', current_period_end = now() - interval '3 days' where user_id = PAID;
  perform pg_temp.ok('a failed card inside Stripe''s retry window keeps posting', public.community_is_entitled(PAID));
  update public.subscriptions set current_period_end = now() - interval '40 days' where user_id = PAID;
  perform pg_temp.ok('and loses it once the retries are exhausted', not public.community_is_entitled(PAID));
  update public.subscriptions set status='active', current_period_end = now() + interval '20 days' where user_id = PAID;

  -- ── 2. A FREE ACCOUNT MAY WRITE, AND MAY NOT PUBLISH ────────────────────
  perform set_config('request.jwt.claim.sub', FREE::text, false);
  set local role authenticated;
  insert into public.community_posts(author_name,slug,title,body,status)
    values ('Reader','free-post-1','A free account writes something worth reading',BODY,'published');
  reset role;
  select status into st from public.community_posts where slug='free-post-1';
  perform pg_temp.ok('a free account asking to publish lands as pending, not published', st = 'pending', st);

  -- and it cannot promote its own post afterwards either
  perform set_config('request.jwt.claim.sub', FREE::text, false);
  set local role authenticated;
  update public.community_posts set status='published' where slug='free-post-1';
  reset role;
  select status into st from public.community_posts where slug='free-post-1';
  perform pg_temp.ok('nor can it promote the post it already filed', st = 'pending', st);

  -- ── 3. A SUBSCRIBER PUBLISHES STRAIGHT THROUGH ──────────────────────────
  perform set_config('request.jwt.claim.sub', PAID::text, false);
  set local role authenticated;
  insert into public.community_posts(author_name,slug,title,body,status)
    values ('Paid Member','paid-post-1','A subscriber writes about the Kansas number',BODY,'published');
  reset role;
  select status, published_at into st, ts from public.community_posts where slug='paid-post-1';
  perform pg_temp.ok('an entitled subscriber publishes without an editor', st = 'published', st);
  perform pg_temp.ok('and the post is stamped with when it went up', ts is not null);

  -- ── 4. THE WORDLIST QUEUES A POST, IT DOES NOT SWALLOW IT ───────────────
  perform set_config('request.jwt.claim.sub', PAID::text, false);
  set local role authenticated;
  insert into public.community_posts(author_name,slug,title,body,status)
    values ('Paid Member','paid-post-2','This is my best bet of the week', BODY, 'published');
  reset role;
  select status into st from public.community_posts where slug='paid-post-2';
  perform pg_temp.ok('a subscriber post carrying a banned phrase queues instead of publishing', st = 'pending', st);
  select array_length(flagged_terms,1) into n from public.community_posts where slug='paid-post-2';
  perform pg_temp.ok('and the phrase it caught is recorded on the row', n >= 1, coalesce(n::text,'null'));
  select array_length(flagged_terms,1) into n from public.community_posts where slug='paid-post-1';
  perform pg_temp.ok('while a clean post carries no flags', n is null, coalesce(n::text,'null'));

  -- ── 5. NOBODY POSTS AS SOMEBODY ELSE ────────────────────────────────────
  failed := false;
  begin
    perform set_config('request.jwt.claim.sub', FREE::text, false);
    set local role authenticated;
    insert into public.community_posts(author_id,author_name,slug,title,body)
      values (PAID,'Impostor','stolen-1','Filed under a subscriber who never wrote it',BODY);
    reset role;
  exception when others then failed := true; reset role;
  end;
  perform pg_temp.ok('a post filed under another account is refused', failed);

  -- ── 6. WHO CAN READ WHAT ────────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', '', false);
  set local role anon;
  select count(*) into n from public.community_posts;
  reset role;
  perform pg_temp.ok('anon sees published posts and nothing else', n = 1, n::text);

  perform set_config('request.jwt.claim.sub', FREE::text, false);
  set local role authenticated;
  select count(*) into n from public.community_posts where slug = 'free-post-1';
  reset role;
  perform pg_temp.ok('an author can see their own post while it waits', n = 1, n::text);

  perform set_config('request.jwt.claim.sub', TRIALER::text, false);
  set local role authenticated;
  select count(*) into n from public.community_posts where status <> 'published';
  reset role;
  perform pg_temp.ok('one member cannot read another member''s queued post', n = 0, n::text);

  -- ── 7. THE OPERATOR MODERATES, AND ONLY THE OPERATOR ────────────────────
  perform set_config('request.jwt.claim.sub', OPER::text, false);
  set local role authenticated;
  select count(*) into n from public.community_posts;
  perform pg_temp.ok('an operator sees every post', n = 3, n::text);
  update public.community_posts set status='published' where slug='free-post-1';
  reset role;
  select status, moderated_by into st, pid from public.community_posts where slug='free-post-1';
  perform pg_temp.ok('an operator can approve a queued post', st = 'published', st);
  perform pg_temp.ok('and the approval is attributed', pid = OPER);

  -- ── 8. AN AUTHOR MAY WITHDRAW, AND NOBODY MAY DELETE ────────────────────
  perform set_config('request.jwt.claim.sub', FREE::text, false);
  set local role authenticated;
  update public.community_posts set status='removed' where slug='free-post-1';
  reset role;
  select status into st from public.community_posts where slug='free-post-1';
  perform pg_temp.ok('an author can always withdraw their own post', st = 'removed', st);

  failed := false;
  begin
    perform set_config('request.jwt.claim.sub', FREE::text, false);
    set local role authenticated;
    delete from public.community_posts where slug='free-post-1';
    reset role;
    select count(*) into n from public.community_posts where slug='free-post-1';
    failed := (n = 0);
  exception when others then failed := false; reset role;
  end;
  perform pg_temp.ok('and cannot destroy the record of what was said', not failed);

  -- ── 9. published_at IS STAMPED ONCE ─────────────────────────────────────
  select published_at into ts from public.community_posts where slug='paid-post-1';
  perform set_config('request.jwt.claim.sub', OPER::text, false);
  set local role authenticated;
  update public.community_posts set status='removed' where slug='paid-post-1';
  update public.community_posts set status='published' where slug='paid-post-1';
  reset role;
  select published_at into ts2 from public.community_posts where slug='paid-post-1';
  perform pg_temp.ok('unpublishing and re-approving does not make an old post look new', ts2 = ts,
    coalesce(ts::text,'null') || ' -> ' || coalesce(ts2::text,'null'));

  -- ── 10. HOW MANY IN A DAY ───────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', COMPED::text, false);
  set local role authenticated;
  insert into public.community_posts(author_name,slug,title,body,status) values
    ('Comped','rate-1','A post about the Missouri front seven',BODY,'published'),
    ('Comped','rate-2','A post about the Kansas secondary',BODY,'published'),
    ('Comped','rate-3','A post about early-season carryover',BODY,'published'),
    ('Comped','rate-4','A post about the outcome range',BODY,'published'),
    ('Comped','rate-5','A post about what the model cannot see',BODY,'published');
  reset role;
  select count(*) into n from public.community_posts where author_id = COMPED and status='published';
  perform pg_temp.ok('five posts in a day is allowed', n = 5, n::text);
  failed := false;
  begin
    perform set_config('request.jwt.claim.sub', COMPED::text, false);
    set local role authenticated;
    insert into public.community_posts(author_name,slug,title,body,status)
      values ('Comped','rate-6','The sixth post of the day',BODY,'published');
    reset role;
  exception when others then failed := true; reset role;
  end;
  perform pg_temp.ok('the sixth is refused rather than silently dropped', failed);

  -- ── 11. THE SHAPE CONSTRAINTS ───────────────────────────────────────────
  failed := false;
  begin
    perform set_config('request.jwt.claim.sub', PAID::text, false);
    set local role authenticated;
    insert into public.community_posts(author_name,slug,title,body) values ('X','short-1','Too short','tiny');
    reset role;
  exception when others then failed := true; reset role;
  end;
  perform pg_temp.ok('a one-line post is refused: this section is for reasoning', failed);

  failed := false;
  begin
    perform set_config('request.jwt.claim.sub', PAID::text, false);
    set local role authenticated;
    insert into public.community_posts(author_name,slug,title,body,sport)
      values ('X','sport-1','A post naming a sport nobody covers',BODY,'CRICKET');
    reset role;
  exception when others then failed := true; reset role;
  end;
  perform pg_temp.ok('a sport the site does not cover is refused', failed);

  failed := false;
  begin
    perform set_config('request.jwt.claim.sub', PAID::text, false);
    set local role authenticated;
    insert into public.community_posts(author_name,slug,title,body)
      values ('Dup','paid-post-1','A second post claiming a taken address',BODY);
    reset role;
  exception when others then failed := true; reset role;
  end;
  perform pg_temp.ok('two posts cannot claim one URL', failed);

  -- ── 12. A MEMBER POST IS NOT RESEARCH ───────────────────────────────────
  select count(*) into n from public.site_articles;
  perform pg_temp.ok('nothing a member wrote reached the research table', n = 0, n::text);

  raise notice 'ALL COMMUNITY SQL CHECKS PASSED';
end $test$;
