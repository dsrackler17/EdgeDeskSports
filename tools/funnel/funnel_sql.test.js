#!/usr/bin/env node
/* ===========================================================================
   supabase/funnel.sql and supabase/lifecycle_email.sql, AGAINST A REAL
   POSTGRESQL, AS REAL READERS.

   Applies the chain both files stand on, then each twice, and proves:

     THE FUNNEL
       1  a page records events only through ed_track(); nobody can read the
          table; an unknown or server-only name is refused; user_id is always
          auth.uid(), never a parameter;
       2  deduplication is the registry's: a re-sent landing_view in the same
          session is one row, a game opened twice in a day is one row, two
          games are two;
       3  what is stored is clean: a hashed visitor id (the acquisition hash),
          a host and never a URL, a path and never a query string, no email
          address or token inside the properties;
       4  the server events: account_created on signup (and a failing insert
          never fails a signup), trial_started / subscription_started /
          subscription_cancelled from the subscription row and the Stripe
          ledger, comps excluded; second_session and return_day_N derived;
       5  the first-run state is the reader's own events and nobody else's;
       6  the admin report: operators only, counts that match the rows, rates
          null when there is no denominator, cohorts by week, source, sport,
          focus and research type, and the step each trial stopped at.
     THE EMAILS
       7  nothing is sent while sending is off;
       8  one welcome, day-1, day-3 and renewal reminder per trial — never a
          second, however often the job runs;
       9  a cancelled trial, an opt-out, a bounced address or a moved charge
          date turns the email into a skipped row with its reason;
      10  the unsubscribe link turns tips off (signed out) and leaves the
          billing reminder alone; the admin switches are operators-only.

   Run: node tools/funnel/funnel_sql.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const PG = require('../personal/_pg.js');

const T = PG.kit('funnel SQL');
const chk = T.chk;
const ROOT = PG.ROOT;
const F1 = path.join(ROOT, 'supabase', 'funnel.sql');
const F2 = path.join(ROOT, 'supabase', 'lifecycle_email.sql');
[F1, F2].forEach((f) => {
  const s = fs.readFileSync(f, 'utf8'), n = path.basename(f);
  chk(n + ': no psql meta-commands', !/^\\/m.test(s));
  chk(n + ': idempotent create statements', /create table if not exists/.test(s) && /create or replace function/.test(s));
  chk(n + ': additive — nothing is dropped', !/\bdrop table\b/i.test(s) && !/\bdrop column\b/i.test(s));
  chk(n + ': it ends in a report', /CHECK THIS/.test(s) && /order by 1;\s*$/.test(s));
  chk(n + ': PostgREST is told to reload', /notify pgrst, 'reload schema'/.test(s));
  chk(n + ': it never writes to the affiliate ledger', !/(insert into|update|delete from)\s+public\.affiliate_/i.test(s));
});

const db = PG.start('funnel');
if (db.skip) { console.log('NOTE | ' + db.skip + ' — LIVE layer skipped'); process.exit(T.done()); }
const lit = PG.lit;
const U = {
  admin: '00000000-0000-0000-0000-00000000f0ad', a: '00000000-0000-0000-0000-00000000f0a1', b: '00000000-0000-0000-0000-00000000f0b2',
  c: '00000000-0000-0000-0000-00000000f0c3', comp: '00000000-0000-0000-0000-00000000f0c4', d: '00000000-0000-0000-0000-00000000f0d5'
};
const VIS = 'abcdefabcdefabcdefabcdef0001', SID1 = 'sess_aaaaaaaa01', SID2 = 'sess_bbbbbbbb02';
const track = (who, events, visitor, session) => JSON.parse((who ? (s) => db.as(who, s) : (s) => db.anon(s))(
  `select public.ed_track(${lit(JSON.stringify(events))}::jsonb, ${lit(visitor || null)}, ${lit(session || null)});`));
const count = (where) => +db.sql(`select count(*) from public.user_events where ${where};`);
let seq = 0;
function stripe(type, obj, userId, secAgo) {
  const id = 'evt_f' + (++seq);
  const ev = { id, type, created: Math.floor(Date.now() / 1000) - (secAgo || 0), data: { object: obj } };
  db.service(`insert into public.stripe_events (id, type, stripe_created, customer_id, subscription_id, user_id, payload)
    values ('${id}','${type}', to_timestamp(${ev.created}), ${lit(obj.customer || null)}, ${lit(obj.subscription || (type.indexOf('customer.subscription') === 0 ? obj.id : null))},
            ${userId ? "'" + userId + "'" : 'null'}, ${lit(JSON.stringify(ev))}::jsonb);`);
}

try {
  ['billing.sql', 'stripe_webhook.sql', 'referral_codes.sql', 'personal_research.sql', 'affiliates.sql', 'growth.sql']
    .forEach((f) => db.applyFileAtomic(path.join(ROOT, 'supabase', f)));
  /* an account that exists BEFORE the file is applied is backfilled */
  db.sql(`insert into auth.users (id, email, created_at) values ('${U.d}', 'd@example.com', now() - interval '40 days');`);
  let out = db.applyFileAtomic(F1);
  chk('funnel.sql applies after the files it stands on, every report row ok', !/CHECK THIS/.test(out), out.slice(-700));
  out = db.applyFileAtomic(F1);
  chk('and a second time', !/CHECK THIS/.test(out), out.slice(-400));
  chk('an account that already existed has its account_created (backfill)', count(`user_id = '${U.d}' and event_name = 'account_created'`) === 1);
  out = db.applyFileAtomic(F2);
  chk('lifecycle_email.sql applies, every report row ok', !/CHECK THIS/.test(out), out.slice(-600));
  out = db.applyFileAtomic(F2);
  chk('and a second time', !/CHECK THIS/.test(out));

  /* ══ 4a. signup ══════════════════════════════════════════════════════════ */
  db.sql(`insert into auth.users (id, email, created_at) values
    ('${U.admin}','owner@example.com', now() - interval '300 days'),
    ('${U.a}','a@example.com', now() - interval '8 days'), ('${U.b}','b@example.com', now() - interval '2 days'),
    ('${U.c}','c@example.com', now() - interval '1 hour'), ('${U.comp}','comp@example.com', now() - interval '5 days');
    insert into public.affiliate_admins (user_id) values ('${U.admin}');`);
  chk('every signup is an account_created event, by trigger', count(`event_name = 'account_created'`) === 6, count(`event_name = 'account_created'`));
  chk('stamped with the account\'s own creation time', db.sql(`select abs(extract(epoch from (e.created_at - u.created_at))) < 1 from public.user_events e join auth.users u on u.id = e.user_id where e.user_id = '${U.a}' and e.event_name = 'account_created';`) === 't');
  db.sql(`alter table public.user_events add constraint user_events_break check (event_name <> 'account_created') not valid;`);
  let err = db.mustFail(() => db.sql(`insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000f0e6', 'e@example.com');`));
  chk('a failing analytics write never fails a signup', err === null, err);
  db.sql(`alter table public.user_events drop constraint user_events_break;`);

  /* ══ 1. the door ═════════════════════════════════════════════════════════ */
  err = db.mustFail(() => db.anon('select count(*) from public.user_events;'));
  chk('a signed-out visitor cannot read the events', !!err && /permission denied/.test(err));
  err = db.mustFail(() => db.as(U.a, 'select count(*) from public.user_events;'));
  chk('nor can a signed-in reader', !!err && /permission denied/.test(err));
  err = db.mustFail(() => db.as(U.a, `insert into public.user_events (user_id, event_name) values ('${U.b}', 'game_opened');`));
  chk('and nobody can write a row directly (so nobody can write one as somebody else)', !!err && /permission denied/.test(err));
  let r = track(null, [{ event: 'landing_view', page_path: '/?utm_source=x&token=abc#frag', referrer: 'https://t.co/abc123?x=1', utm_source: 'X', utm_campaign: 'Launch Week!' }], VIS, SID1);
  chk('a signed-out landing view is recorded', r.ok === true && r.recorded === 1, r);
  const row = db.sql(`select anonymous_session_id || '|' || coalesce(user_id::text,'-') || '|' || page_path || '|' || referrer || '|' || utm_source || '|' || utm_campaign from public.user_events where event_name = 'landing_view';`);
  chk('the visitor is stored as the acquisition hash, never raw', row.split('|')[0] === db.sql(`select md5('edgedesk-acq:${VIS}');`) && row.indexOf(VIS) < 0, row);
  chk('a path without its query string, a host without its URL, clean utm values', row.split('|').slice(1).join('|') === '-|/|t.co|x|launchweek', row);
  r = track(null, [{ event: 'landing_view' }, { event: 'landing_view' }], VIS, SID1);
  chk('the same landing view again in the same session records nothing (a re-render cannot double count)', r.recorded === 0 && count(`event_name = 'landing_view'`) === 1, r);
  track(null, [{ event: 'landing_view' }], VIS, SID2);
  chk('a new session is a new landing view', count(`event_name = 'landing_view'`) === 2);
  r = track(null, [{ event: 'account_created' }, { event: 'trial_started' }, { event: 'made_up_event' }, { event: 'game_opened', props: { entity: 'cfb|1' } }], VIS, SID1);
  chk('a page cannot send a server event, an unknown name, or a signed-in step while signed out', r.recorded === 0, r);
  r = track(null, [{ event: 'cta_clicked', props: { cta: 'hero_board', email: 'x@y.com', note: 'mail me at x@y.com', token: 'eyJhbGciOiJIUzI1NiJ9abcdefghijklmnop', n: 3, ok: true, nested: { a: 1 } } }], VIS, SID1);
  const props = JSON.parse(db.sql(`select event_properties from public.user_events where event_name = 'cta_clicked';`));
  chk('properties keep short scalars and drop contact details, tokens and objects', r.recorded === 1 && props.cta === 'hero_board' && props.n === 3 && props.ok === true
    && !('email' in props) && !('note' in props) && !('token' in props) && !('nested' in props), props);
  track(null, [{ event: 'cta_clicked', props: { cta: 'hero_board' } }, { event: 'cta_clicked', props: { cta: 'pricing_trial' } }], VIS, SID1);
  chk('two different calls to action are two rows; the same one again in a session is not', count(`event_name = 'cta_clicked'`) === 2);
  r = JSON.parse(db.anon(`select public.ed_track('[{"event":"landing_view"}]'::jsonb, null, null);`));
  chk('with neither an account nor a visitor id there is no actor, and nothing is stored', r.ok === false && r.reason === 'no_actor', r);
  r = JSON.parse(db.anon(`select public.ed_track('"not a list"'::jsonb, '${VIS}', '${SID1}');`));
  chk('a malformed batch is refused, not raised', r.ok === false);

  /* ══ 2. signed-in steps and dedupe ═══════════════════════════════════════ */
  r = track(U.c, [{ event: 'terminal_opened' }, { event: 'board_viewed', props: { surface: 'football' } }, { event: 'game_opened', props: { entity: 'cfb|401', league: 'cfb' } },
    { event: 'game_opened', props: { entity: 'cfb|401' } }, { event: 'game_opened', props: { entity: 'nfl|2026_04_PIT_CLE' } }], VIS, SID1);
  chk('a signed-in reader\'s steps are recorded under auth.uid()', r.recorded === 4 && count(`user_id = '${U.c}' and event_name in ('terminal_opened','board_viewed','game_opened')`) === 4, r);
  chk('the same game twice in a day is one row, two games are two', count(`user_id = '${U.c}' and event_name = 'game_opened'`) === 2);
  chk('the page\'s visitor is linked to the account, so landing events stitch to it', db.sql(`select count(*) from public.user_event_links where user_id = '${U.c}' and anonymous_session_id = md5('edgedesk-acq:${VIS}');`) === '1');
  chk('a one-hour-old account has not "returned" on day 1', count(`user_id = '${U.c}' and event_name like 'return_day_%'`) === 0);
  track(U.a, [{ event: 'terminal_opened' }], null, SID1);
  chk('a first session is not a second session', count(`user_id = '${U.a}' and event_name = 'second_session'`) === 0);
  chk('an 8-day-old account back in the terminal returned on day 1, 3 and 7 (rolling)', count(`user_id = '${U.a}' and event_name in ('return_day_1','return_day_3','return_day_7')`) === 3);
  track(U.a, [{ event: 'terminal_opened' }], null, SID2);
  track(U.a, [{ event: 'terminal_opened' }], null, 'sess_cccccccc03');
  chk('a terminal session in a different browser session is second_session, once', count(`user_id = '${U.a}' and event_name = 'second_session'`) === 1);
  chk('and return days are recorded once each, however often the reader comes back', count(`user_id = '${U.a}' and event_name = 'return_day_1'`) === 1);
  track(U.b, [{ event: 'terminal_opened' }, { event: 'prop_opened', props: { entity: 'cfb|401|55|rec_yds' } }, { event: 'custom_price_checked', props: { entity: 'cfb|401|55|rec_yds' } }], null, SID1);
  chk('a 2-day-old account returned on day 1 only', count(`user_id = '${U.b}' and event_name = 'return_day_1'`) === 1 && count(`user_id = '${U.b}' and event_name = 'return_day_3'`) === 0);

  /* ══ 4b. Stripe ══════════════════════════════════════════════════════════ */
  const TE = (d) => `now() + interval '${d} days'`;
  db.service(`insert into public.subscriptions (user_id, status, price_id, current_period_end, stripe_customer_id, stripe_subscription_id) values
    ('${U.a}','trialing','price_x', ${TE(-1)}, 'cus_a','sub_a'),
    ('${U.b}','trialing','price_x', ${TE(5)}, 'cus_b','sub_b'),
    ('${U.c}','trialing','price_x', ${TE(7)}, 'cus_c','sub_c'),
    ('${U.comp}','trialing','comp_trial', ${TE(9)}, null, null);`);
  chk('a Stripe trial is trial_started, by trigger', count(`event_name = 'trial_started' and user_id in ('${U.a}','${U.b}','${U.c}')`) === 3);
  chk('a comp trial granted by hand is not a funnel trial', count(`event_name = 'trial_started' and user_id = '${U.comp}'`) === 0);
  /* a's trial started 8 days ago: the webhook wrote the row then */
  db.sql(`update public.user_events set created_at = now() - interval '8 days' where user_id = '${U.a}' and event_name = 'trial_started';`);
  db.service(`update public.subscriptions set status = 'active', current_period_end = ${TE(29)} where user_id = '${U.a}';`);
  chk('trialing → active is subscription_started', count(`user_id = '${U.a}' and event_name = 'subscription_started'`) === 1);
  stripe('invoice.payment_succeeded', { id: 'in_a1', object: 'invoice', customer: 'cus_a', subscription: 'sub_a', amount_paid: 7999 }, null, 10);
  chk('the paid invoice for the same subscription does not count it twice', count(`user_id = '${U.a}' and event_name = 'subscription_started'`) === 1);
  stripe('invoice.payment_succeeded', { id: 'in_b0', object: 'invoice', customer: 'cus_b', subscription: 'sub_b', amount_paid: 0 }, null, 10);
  chk('a $0 trial invoice is not a payment', count(`user_id = '${U.b}' and event_name = 'subscription_started'`) === 0);
  db.service(`update public.subscriptions set cancel_at_period_end = true where user_id = '${U.b}';`);
  const cx = JSON.parse(db.sql(`select event_properties from public.user_events where user_id = '${U.b}' and event_name = 'subscription_cancelled';`) || '{}');
  chk('switching off renewal during the trial is subscription_cancelled, flagged in-trial', cx.during_trial === true && cx.immediate === false, cx);
  db.service(`update public.subscriptions set status = 'canceled' where user_id = '${U.b}';`);
  chk('and the subscription then ending is not a second cancellation', count(`user_id = '${U.b}' and event_name = 'subscription_cancelled'`) === 1);

  /* ══ 5. first run ════════════════════════════════════════════════════════ */
  err = db.mustFail(() => db.anon(`select public.ed_first_run_state(null);`));
  chk('the first-run state needs an account', !!err && /permission denied/.test(err));
  let fr = JSON.parse(db.as(U.c, `select public.ed_first_run_state('${SID1}');`));
  chk('a reader\'s steps are their own events: board and game done, prop, price and save not', fr.ok && fr.steps.board && fr.steps.game && !fr.steps.prop && !fr.steps.price && !fr.steps.save && fr.done === 2 && fr.total === 5, fr);
  fr = JSON.parse(db.as(U.b, `select public.ed_first_run_state(null);`));
  chk('another reader\'s are theirs: prop and price done', fr.steps.prop && fr.steps.price && !fr.steps.game, fr.steps);
  db.as(U.c, `insert into public.watchlist_games (game_key, home, away) values ('cfb|401', 'Home', 'Away');`);
  fr = JSON.parse(db.as(U.c, `select public.ed_first_run_state('${SID1}');`));
  chk('a watchlist save counts as saving research', fr.steps.save === true);
  fr = JSON.parse(db.as(U.a, `select public.ed_first_run_state('sess_cccccccc03');`));
  chk('the previous visit is the last terminal session before this one', !!fr.previous_visit_at);
  db.as(U.c, `insert into public.user_preferences (user_id, leagues, research_focus, favorite_teams) values ('${U.c}', '{nfl}', 'player_props', '{NFL:BUF,cfb:texastech}');`);
  fr = JSON.parse(db.as(U.c, `select public.ed_first_run_state(null);`));
  chk('the reader\'s own focus and favorite teams are saved, normalised', fr.prefs.research_focus === 'player_props' && JSON.stringify(fr.prefs.favorite_teams) === '["cfb:texastech","nfl:buf"]', fr.prefs);
  err = db.mustFail(() => db.as(U.c, `update public.user_preferences set research_focus = 'parlays' where user_id = '${U.c}';`));
  chk('a focus outside game lines / player props / both is refused', !!err);
  err = db.mustFail(() => db.as(U.c, `update public.user_preferences set favorite_teams = '{"not a team"}' where user_id = '${U.c}';`));
  chk('a favorite team outside <league>:<key> is refused', !!err);

  /* ══ 6. the admin report ═════════════════════════════════════════════════ */
  err = db.mustFail(() => db.as(U.a, `select public.funnel_admin_report(30);`));
  chk('the funnel report is for operators only', !!err && /not an admin/.test(err));
  err = db.mustFail(() => db.anon(`select public.funnel_admin_report(30);`));
  chk('and closed to signed-out visitors', !!err && /permission denied/.test(err));
  const rep = JSON.parse(db.as(U.admin, `select public.funnel_admin_report(30);`));
  const step = (k) => (rep.steps.find((x) => x.key === k) || {}).n;
  chk('visitors are distinct hashed visitors with a landing view', step('visitors') === 1, rep.steps);
  chk('accounts are the accounts created in the window', step('accounts') === 5, step('accounts'));
  chk('trials are Stripe trials, comps excluded', step('trials') === 3, step('trials'));
  chk('terminal, game and prop opens are counted among trials', step('terminal') === 3 && step('game') === 1 && step('prop') === 1, rep.steps);
  chk('paid is a real charge', step('paid') === 1);
  chk('the landing CTA rate is visitors who pressed one', rep.rates.landing_cta === 1, rep.rates);
  chk('signup is landing visitors linked to a new account over visitors — never above 100%', step('signed_up') === 1 && rep.rates.signup === 1 && rep.rates.signup <= 1, [step('signed_up'), rep.rates.signup]);
  chk('accounts with no tracked landing visit are reported, not hidden', rep.coverage.accounts === 5 && rep.coverage.accounts_from_tracked_visitors === 1 && rep.coverage.untracked_accounts === 4, rep.coverage);
  chk('trial-to-paid only counts trials whose trial has ended', rep.trial_outcomes.trials_ended === 1 && rep.rates.trial_to_paid === 1, rep.trial_outcomes);
  chk('cancellation is cancelled trials over trials', rep.rates.cancellation === Math.round(1 / 3 * 1e4) / 1e4 && rep.trial_outcomes.cancelled_in_trial === 1, rep.rates);
  chk('retention is among trials old enough: day 1 of 2, day 3 of 1, day 7 of 1', rep.retention.d1.eligible === 2 && rep.retention.d1.returned === 2
    && rep.retention.d3.eligible === 1 && rep.retention.d7.returned === 1, rep.retention);
  chk('where each trial stopped', rep.last_step.reduce((a, x) => a + x.trials, 0) === 3 && rep.last_step.some((x) => x.step === 'paid'), rep.last_step);
  ['signup_week', 'source', 'sport', 'stated_focus', 'research_type'].forEach((dim) =>
    chk('cohorts by ' + dim, Array.isArray(rep.cohorts[dim]) && rep.cohorts[dim].reduce((a, x) => a + x.accounts, 0) === 5, rep.cohorts[dim]));
  chk('research type is what readers opened: one game-lines reader, one prop reader', (rep.cohorts.research_type.find((x) => x.key === 'game_lines') || {}).accounts === 1
    && (rep.cohorts.research_type.find((x) => x.key === 'player_props') || {}).accounts === 1, rep.cohorts.research_type);
  chk('stated focus reads the preference', (rep.cohorts.stated_focus.find((x) => x.key === 'player_props') || {}).accounts === 1);
  chk('a rate with no denominator is null, never 0%', JSON.parse(db.as(U.admin, `select public.funnel_admin_report(1);`)).rates.trial_to_paid === null);

  /* ══ 7-10. the emails ════════════════════════════════════════════════════ */
  let plan = JSON.parse(db.service(`select public.lifecycle_plan();`));
  const msgs = (w) => db.sql(`select coalesce(string_agg(kind || ':' || status, ',' order by kind), '') from public.lifecycle_messages where ${w};`);
  chk('the plan schedules the trial emails and the reminder', plan.ok && plan.scheduled > 0, plan);
  chk('trial c: welcome, day 1, day 3 and a renewal reminder', msgs(`user_id = '${U.c}'`) === 'renewal_reminder:pending,trial_day1:pending,trial_day3:pending,trial_welcome:pending', msgs(`user_id = '${U.c}'`));
  chk('no email for a comp, and no reminder where nothing will be charged', msgs(`user_id = '${U.comp}'`) === '' && msgs(`user_id = '${U.b}' and kind = 'renewal_reminder'`) === '');
  chk('the reminder is due before the charge, by the configured lead', db.sql(`select (charge_at - due_at) between interval '47 hours' and interval '49 hours' from public.lifecycle_messages where user_id = '${U.c}' and kind = 'renewal_reminder';`) === 't');
  plan = JSON.parse(db.service(`select public.lifecycle_plan();`));
  chk('running the plan again schedules nothing new', plan.scheduled === 0, plan);
  let due = JSON.parse(db.service(`select public.lifecycle_due(25);`));
  chk('nothing is sent while sending is off', due.sending_enabled === false && due.messages.length === 0);
  db.sql(`update public.lifecycle_settings set sending_enabled = true;
          update public.lifecycle_messages set due_at = now() - interval '1 minute' where user_id = '${U.b}' and kind = 'trial_day1';`);
  due = JSON.parse(db.service(`select public.lifecycle_due(25);`));
  const kinds = due.messages.map((m) => m.user_id.slice(-4) + ':' + m.kind).sort();
  chk('only what is due now is claimed: c\'s welcome — not b\'s (cancelled), and none for a trial that began 8 days ago',
    JSON.stringify(kinds) === JSON.stringify(['f0c3:trial_welcome']), kinds);
  chk('a trial that began 8 days ago was never scheduled a welcome (only within two days of the start)', msgs(`user_id = '${U.a}' and kind = 'trial_welcome'`) === '');
  chk('b\'s welcome and day-1 email are skipped with the reason, not sent', db.sql(`select string_agg(kind || '=' || skip_reason, ',' order by kind) from public.lifecycle_messages where user_id = '${U.b}' and status = 'skipped';`)
    === 'trial_day1=no longer an active trial,trial_welcome=no longer an active trial');
  const w = due.messages.find((m) => m.kind === 'trial_welcome' && m.user_id === U.c);
  chk('a claimed email carries the address, an unsubscribe token and the reader\'s preferences, nothing more',
    w && w.email === 'c@example.com' && /^[0-9a-f]{64}$/.test(w.unsubscribe_token) && JSON.stringify(w.leagues) === '["nfl"]' && w.research_focus === 'player_props' && !('password' in w), w);
  chk('a second job running at the same time claims nothing already claimed', JSON.parse(db.service(`select public.lifecycle_due(25);`)).messages.length === 0);
  chk('the sender marks a send', db.service(`select public.lifecycle_mark(${w.id}, 'sent', 're_123', null);`) === 't' && msgs(`id = ${w.id}`) === 'trial_welcome:sent');
  chk('and cannot mark it twice', db.service(`select public.lifecycle_mark(${w.id}, 'sent', 're_124', null);`) === 'f');
  db.sql(`update public.lifecycle_messages set due_at = now() - interval '1 minute' where user_id = '${U.c}' and kind = 'trial_day1';`);
  const d1 = JSON.parse(db.service(`select public.lifecycle_due(25);`)).messages.find((m) => m.kind === 'trial_day1');
  chk('a dry run releases a claimed email back to pending with its attempt uncounted',
    d1 && db.service(`select public.lifecycle_mark(${d1.id}, 'release', null, null);`) === 't'
    && db.sql(`select status || ':' || attempts from public.lifecycle_messages where id = ${d1.id};`) === 'pending:0', d1);
  /* the reminder: moved charge date, then the real one */
  db.sql(`update public.lifecycle_messages set due_at = now() - interval '1 minute' where user_id = '${U.c}' and kind = 'renewal_reminder';`);
  db.service(`update public.subscriptions set current_period_end = current_period_end + interval '1 day' where user_id = '${U.c}';`);
  due = JSON.parse(db.service(`select public.lifecycle_due(25);`));
  chk('a reminder whose charge date moved is skipped, never sent with the wrong date',
    db.sql(`select skip_reason from public.lifecycle_messages where user_id = '${U.c}' and kind = 'renewal_reminder' and status = 'skipped';`) === 'the charge date moved');
  db.service(`select public.lifecycle_plan();`);
  chk('and the plan schedules one for the new date', +db.sql(`select count(*) from public.lifecycle_messages where user_id = '${U.c}' and kind = 'renewal_reminder';`) === 2);
  db.sql(`update public.lifecycle_messages set due_at = now() - interval '1 minute' where user_id = '${U.c}' and kind = 'renewal_reminder' and status = 'pending';`);
  stripe('customer.subscription.updated', { id: 'sub_c', object: 'subscription', customer: 'cus_c', status: 'trialing', items: { data: [{ price: { id: 'price_x', unit_amount: 3999 } }] } }, U.c, 5);
  due = JSON.parse(db.service(`select public.lifecycle_due(25);`));
  const rem = due.messages.find((m) => m.kind === 'renewal_reminder');
  chk('the reminder carries the charge date and the amount Stripe holds', rem && rem.charge_at && rem.amount_cents === 3999, rem);
  /* 10 · unsubscribe */
  const tok = w.unsubscribe_token;
  chk('a bad token is refused', JSON.parse(db.anon(`select public.lifecycle_unsubscribe('nope');`)).ok === false);
  chk('the email link turns tips off, signed out', JSON.parse(db.anon(`select public.lifecycle_unsubscribe('${tok}');`)).ok === true
    && db.sql(`select trial_emails from public.user_preferences where user_id = '${U.c}';`) === 'f');
  chk('the pending tips are skipped at once', db.sql(`select count(*) from public.lifecycle_messages where user_id = '${U.c}' and kind in ('trial_day1','trial_day3') and status = 'pending';`) === '0');
  chk('the billing reminder is not a tip: it is untouched', msgs(`user_id = '${U.c}' and kind = 'renewal_reminder' and status in ('sending','sent','pending')`).length > 0);
  err = db.mustFail(() => db.as(U.a, `select public.lifecycle_admin_set('{"sending_enabled":false}'::jsonb);`));
  chk('only an operator can switch sending', !!err && /not an admin/.test(err));
  const sum = JSON.parse(db.as(U.admin, `select public.lifecycle_admin_set('{"sending_enabled":false,"renewal_lead_hours":72}'::jsonb);`));
  chk('and an operator can, and sees the counts and the skip reasons', sum.settings.sending_enabled === false && sum.settings.renewal_lead_hours === 72 && sum.counts.length > 0 && sum.skips.length > 0, sum);
  err = db.mustFail(() => db.as(U.admin, `select public.lifecycle_admin_set('{"renewal_lead_hours":5}'::jsonb);`));
  chk('a lead time that would not be a reminder is refused', !!err);
  err = db.mustFail(() => db.as(U.a, `select public.lifecycle_due(5);`));
  chk('a reader cannot claim emails', !!err && /permission denied/.test(err));

  if (process.argv.indexOf('--write-fixture') >= 0) {
    /* the admin page's browser test renders the real report and summary */
    const fx = { note: 'tools/funnel/funnel_sql.test.js --write-fixture: funnel_admin_report(30) and lifecycle_admin_summary() over this suite\'s accounts',
      report: rep, lifecycle: JSON.parse(db.as(U.admin, `select public.lifecycle_admin_summary();`)) };
    fs.mkdirSync(path.join(__dirname, 'fixtures'), { recursive: true });
    fs.writeFileSync(path.join(__dirname, 'fixtures', 'funnel_admin.json'), JSON.stringify(fx, null, 1) + '\n');
    console.log('wrote tools/funnel/fixtures/funnel_admin.json');
  }
} catch (e) {
  chk('the live layer ran', false, String(e.message).slice(0, 2000));
} finally {
  db.stop();
}
process.exit(T.done());
