#!/usr/bin/env node
/* ===========================================================================
   supabase/growth.sql, AGAINST A REAL POSTGRESQL, AS REAL READERS.

   Applies the whole chain the file stands on (billing, the Stripe ledger,
   referral codes, the personal research tables, the partner program), then
   this file twice, and proves:

     1  ACTIVATION. A trial reader's actions become deduplicated events — the
        ones that write a row of their own (watchlist, journal, alerts, share
        cards) by trigger, the rest only through edp_track — and the state
        walks NOT_ACTIVATED → EXPLORING → ACTIVATED → POWER_USER on the
        configured thresholds, timed by the event that met each. A reader can
        neither read their score nor forge a trigger-only action. The admin's
        numbers (trials, activated trials, activation rate, paid conversions,
        activated-to-paid, time to activation) are counts of those rows.
     2  ACQUISITION. The source rule; a direct first touch upgraded once by the
        first attributable one and frozen after; last touch kept apart; touches
        after signup ignored; the affiliate ledger never touched; the funnel.
     3  PUBLIC SAMPLES. Only a game the admin made public is readable signed
        out, and only the public subset of its research state.

   Run: node tools/personal/growth_sql.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const PG = require('./_pg.js');

const T = PG.kit('growth SQL');
const chk = T.chk;
const FILE = path.join(PG.ROOT, 'supabase', 'growth.sql');
const SQL = fs.readFileSync(FILE, 'utf8');

/* ── STATIC: the folder's conventions ──────────────────────────────────── */
chk('no psql meta-commands', !/^\\/m.test(SQL));
chk('idempotent create statements', /create table if not exists/.test(SQL) && /create or replace function/.test(SQL));
chk('additive: nothing is dropped but triggers it recreates', !/\bdrop table\b/i.test(SQL) && !/\bdrop column\b/i.test(SQL));
chk('it ends in a report', /CHECK THIS/.test(SQL) && /order by 1;\s*$/.test(SQL));
chk('PostgREST is told to reload', /notify pgrst, 'reload schema'/.test(SQL));
chk('it never writes to the affiliate ledger', !/(insert into|update|delete from)\s+public\.affiliate_/i.test(SQL));

const db = PG.start('growth');
if (db.skip) { console.log('NOTE | ' + db.skip + ' — LIVE layer skipped'); process.exit(T.done()); }

const U = {
  admin: '00000000-0000-0000-0000-0000000000ad',
  t1: '00000000-0000-0000-0000-0000000000f1', t2: '00000000-0000-0000-0000-0000000000f2', t3: '00000000-0000-0000-0000-0000000000f3',
  t4: '00000000-0000-0000-0000-0000000000f4', p: '00000000-0000-0000-0000-0000000000f5', creator: '00000000-0000-0000-0000-0000000000f6',
  r1: '00000000-0000-0000-0000-0000000000f7'
};
const KICK = new Date(Date.now() + 2 * 864e5).toISOString();
let seq = 0;
function event(type, obj, userId, secAgo) {
  const id = 'evt_g' + (++seq);
  const ev = { id, type, created: Math.floor(Date.now() / 1000) - (secAgo || 0), data: { object: obj } };
  db.service(`insert into public.stripe_events (id, type, stripe_created, customer_id, subscription_id, user_id, payload)
    values ('${id}','${type}', to_timestamp(${ev.created}), ${PG.lit(obj.customer || null)}, ${PG.lit(obj.subscription || (type.indexOf('customer.subscription') === 0 ? obj.id : null))},
            ${userId ? "'" + userId + "'" : 'null'}, ${PG.lit(JSON.stringify(ev))}::jsonb);`);
}
const act = (uid) => db.sql(`select coalesce((select state from public.user_activation where user_id = '${uid}'), 'none');`);
const evs = (uid, kind) => db.sql(`select count(*) from public.activation_events where user_id = '${uid}'${kind ? ` and kind = '${kind}'` : ''};`);

try {
  ['billing.sql', 'stripe_webhook.sql', 'referral_codes.sql', 'personal_research.sql', 'affiliates.sql']
    .forEach((f) => db.applyFileAtomic(path.join(PG.ROOT, 'supabase', f)));
  let out = db.applyFileAtomic(FILE);
  chk('the migration applies after the files it stands on', true);
  chk('every report row says ok', !/CHECK THIS/.test(out), out.slice(-700));
  out = db.applyFileAtomic(FILE);
  chk('and applies a second time, still all ok', !/CHECK THIS/.test(out));
  const saver = db.background('begin;\nselect count(*) from public.research_journal;\nselect pg_sleep(2);\nselect count(*) from public.activation_events;\ncommit;\n');
  db.sleep(0.4);
  const rerun = db.mustFail(() => db.applyFileAtomic(FILE));
  const sv = saver.wait(30000);
  chk('re-running it while a reader saves a journal entry deadlocks neither side', rerun === null && sv.code === 0, { rerun: rerun && rerun.slice(0, 300), sv });

  db.sql(`insert into auth.users (id, email, created_at) values
    ('${U.admin}','owner@example.com', now() - interval '300 days'),
    ('${U.t1}','t1@example.com', now() - interval '20 days'), ('${U.t2}','t2@example.com', now() - interval '20 days'),
    ('${U.t3}','t3@example.com', now() - interval '20 days'), ('${U.t4}','t4@example.com', now() - interval '20 days'),
    ('${U.p}','p@example.com', now() - interval '20 days'), ('${U.creator}','creator@example.com', now() - interval '100 days'),
    ('${U.r1}','r1@example.com', now() - interval '10 days');
    insert into public.affiliate_admins (user_id) values ('${U.admin}');`);
  db.service(`insert into public.game_research_state (game_key, sport, game_id, home, away, kickoff_at, status, projected, fair_home_line, fair_total,
      market_home_line, market_total, market_kind, market_book, market_captured_at, market_stale, gap_pts, win_prob_home, reliability_score, reliability_grade,
      research_grade, priority_eligible, priority_score, priority_rank, key_reason, state, state_hash, computed_at)
    values ('cfb|9001','cfb','9001','Florida','Ole Miss','${KICK}','RESEARCH',true, 1.7, 51.5, -2.5, 49.5, 'live', 'DraftKings', now() - interval '30 minutes', false,
      4.2, 0.46, 88, 'STRONG', true, true, 71.4, 1, 'Model flips the market favorite.',
      ${PG.lit(JSON.stringify({ game_key: 'cfb|9001', home: 'Florida', away: 'Ole Miss', fair: { home_line: 1.7, text: 'Ole Miss -1.7' },
        market: { home_line: -2.5, text: 'Florida -2.5', books: 4 }, gap: { points: 4.2, toward: 'away' }, win_prob_home: 0.46,
        reliability: { score: 88, grade: 'STRONG', scored: true, main_deduction: 'one QB not confirmed' },
        qb: { home: { name: 'Home QB', confirmed: true }, away: { name: 'Away QB', confirmed: false }, confirmed_both: false },
        injuries: { home: { known: true, out: ['A (WR)'], doubtful: [], questionable: ['B (CB)'] }, away: { known: false } },
        drivers: [{ text: 'team-strength edge', points: 3.1 }, { text: 'quarterback matchup', points: 1.4 }, { text: 'home-field advantage', points: 1.2 }, { text: 'travel', points: 0.6 }],
        priority: { eligible: true, rank: 1, score: 71.4, why_text: 'secret ranking reason' }, movement: { spread_moved: 1.5 } }))}::jsonb, 'h1', now());`);

  /* ══ 1. ACTIVATION ═════════════════════════════════════════════════════ */
  let err = db.mustFail(() => db.anon(`select public.edp_track('visit', null);`));
  chk('a signed-out visitor cannot record an action', !!err && /permission denied/.test(err));
  let r = JSON.parse(db.as(U.t1, `select public.edp_track('watchlist_save', 'cfb|9001');`));
  chk('the client door refuses an action that writes its own row (it cannot be forged)', r.ok === false && r.reason === 'not_a_client_event', r);
  r = JSON.parse(db.as(U.t1, `select public.edp_track('visit', null);`));
  chk('a visit is recorded and returns nothing about the score', r.ok === true && Object.keys(r).length === 1, r);
  chk('a first visit alone is NOT_ACTIVATED (a visit carries no weight)', act(U.t1) === 'NOT_ACTIVATED');
  db.as(U.t1, `select public.edp_track('matchup_viewed', 'cfb|9001');`);
  db.as(U.t1, `select public.edp_track('matchup_viewed', 'cfb|9001');`);
  chk('the same matchup viewed twice in a day is one event', evs(U.t1, 'matchup_viewed') === '1');
  chk('one meaningful action makes the reader EXPLORING', act(U.t1) === 'EXPLORING');
  db.as(U.t1, `insert into public.watchlist_games (game_key, home, away) values ('cfb|9001','Florida','Ole Miss');`);
  chk('a watchlist save is recorded by trigger', evs(U.t1, 'watchlist_save') === '1'
    && db.sql(`select source from public.activation_events where user_id = '${U.t1}' and kind = 'watchlist_save';`) === 'db');
  db.as(U.t2, `insert into public.watchlist_games (game_key, source) values ('cfb|9001','import');`);
  chk('a device import is not counted as the reader\'s action', evs(U.t2, 'watchlist_save') === '0');
  db.as(U.t1, `insert into public.research_journal (game_key, decision, my_home_line, snapshot, snapshot_hash) values ('cfb|9001','researching', 3.5, '{}','g1');`);
  chk('a journal entry is recorded by trigger', evs(U.t1, 'journal_entry_created') === '1');
  chk('and a saved number records Compare My Number', evs(U.t1, 'compare_my_number') === '1');
  db.as(U.t1, `select public.edp_track('compare_my_number', 'cfb|9001');`);
  chk('comparing the same game again today counts once, whichever door it came through', evs(U.t1, 'compare_my_number') === '1');
  db.as(U.t1, `insert into public.alert_preferences (gap_min_pts) values (2.5);`);
  db.as(U.t1, `update public.alert_preferences set gap_min_pts = 3;`);
  chk('configuring alerts is recorded once', evs(U.t1, 'alert_configured') === '1');
  db.as(U.t1, `insert into public.share_cards (game_key, content, content_hash) values ('cfb|9001', '{"tagline":"Research, not picks."}', 's1');`);
  chk('a generated share card is recorded by trigger', evs(U.t1, 'share_card_generated') === '1');
  db.as(U.t1, `select public.edp_track('ai_research_used', null); select public.edp_track('top5_opened', null);`);
  chk('AI research and the Top 5 are recorded once a day each', evs(U.t1, 'ai_research_used') === '1' && evs(U.t1, 'top5_opened') === '1');
  chk('many actions on a single day are still not ACTIVATED (two active days are required)', act(U.t1) === 'EXPLORING'
    && db.sql(`select active_days from public.user_activation where user_id = '${U.t1}';`) === '1');
  /* yesterday's visit, then today's: a repeat visit */
  db.service(`insert into public.activation_events (user_id, kind, dedupe_key, occurred_at) values ('${U.t1}','visit', to_char((now() - interval '1 day') at time zone 'utc', 'YYYY-MM-DD'), now() - interval '1 day');`);
  db.service(`delete from public.activation_events where user_id = '${U.t1}' and kind = 'visit' and dedupe_key = to_char(now() at time zone 'utc', 'YYYY-MM-DD');`);
  db.as(U.t1, `select public.edp_track('visit', null);`);
  chk('a visit on a later day records a repeat visit', evs(U.t1, 'repeat_visit') === '1');
  chk('a second active day with core actions makes the reader ACTIVATED', act(U.t1) === 'ACTIVATED');
  const t1a = db.sql(`select (activated_at between now() - interval '1 minute' and now()) || '|' || (exploring_at < activated_at) from public.user_activation where user_id = '${U.t1}';`);
  chk('each state is stamped with the event that first met it', t1a === 'true|true', t1a);
  err = db.mustFail(() => db.as(U.t1, `select state from public.user_activation;`));
  chk('a reader cannot read their own activation state (internal only)', !!err && /permission denied/.test(err));
  err = db.mustFail(() => db.as(U.t1, `select count(*) from public.activation_events;`));
  chk('nor the events', !!err && /permission denied/.test(err));
  err = db.mustFail(() => db.as(U.t1, `select public.activation_compute('${U.t1}');`));
  chk('nor run the scoring', !!err && /permission denied/.test(err));
  /* power user: five days, five kinds, 25 points */
  db.service(`insert into public.activation_events (user_id, kind, dedupe_key, game_key, occurred_at)
    select '${U.t3}', k, 'd' || d || k, 'cfb|9001', now() - make_interval(days => d)
      from generate_series(0, 5) d, unnest(array['matchup_viewed','watchlist_save','journal_entry_created','compare_my_number','ai_research_used','share_card_generated']) k;`);
  chk('five active days across five kinds make a POWER_USER', act(U.t3) === 'POWER_USER', act(U.t3));
  /* a trigger can never fail the reader's own write */
  db.sql(`alter table public.activation_events add constraint tmp_refuse check (kind <> 'watchlist_save') not valid;`);
  err = db.mustFail(() => db.as(U.t4, `insert into public.watchlist_games (game_key) values ('cfb|9001');`));
  chk('when recording an action fails, the reader\'s own save still succeeds', err === null && db.as(U.t4, `select count(*) from public.watchlist_games;`) === '1', err);
  db.sql(`alter table public.activation_events drop constraint tmp_refuse;`);

  /* thresholds are configurable, and a change recomputes history */
  err = db.mustFail(() => db.as(U.t1, `select public.growth_admin_update_activation_settings('{"activated_min_active_days":1}'::jsonb);`));
  chk('a reader cannot change the thresholds', !!err && /not an admin/.test(err));
  r = JSON.parse(db.as(U.admin, `select public.growth_admin_update_activation_settings('{"weights":{"lottery":5}}'::jsonb);`));
  chk('an unknown action weight is refused', r.ok === false && r.reason === 'invalid_settings', r);
  r = JSON.parse(db.as(U.admin, `select public.growth_admin_update_activation_settings('{"activated_min_points":9999}'::jsonb);`));
  chk('an activated bar above the power-user bar is refused', r.ok === false, r);
  db.as(U.t2, `insert into public.research_journal (game_key, decision, snapshot, snapshot_hash) values ('cfb|9001','passed','{}','g2');
               insert into public.alert_preferences (gap_min_pts) values (4);
               select public.edp_track('matchup_viewed', 'cfb|9001'); select public.edp_track('ai_research_used', null);`);
  chk('before the change, one busy day is EXPLORING', act(U.t2) === 'EXPLORING');
  r = JSON.parse(db.as(U.admin, `select public.growth_admin_update_activation_settings('{"activated_min_active_days":1}'::jsonb);`));
  chk('an admin lowers the active-day bar and every reader is recomputed', r.ok === true && r.recomputed >= 3 && act(U.t2) === 'ACTIVATED', r);
  db.as(U.admin, `select public.growth_admin_update_activation_settings('{"activated_min_active_days":2}'::jsonb);`);
  chk('and raising it again recomputes back', act(U.t2) === 'EXPLORING');
  db.as(U.admin, `select public.growth_admin_update_activation_settings('{"core_kinds":[]}'::jsonb);`);
  chk('the core-action list can be emptied', db.sql(`select cardinality(core_kinds) from public.activation_settings;`) === '0');
  db.as(U.admin, `select public.growth_admin_update_activation_settings('{"core_kinds":["watchlist_save","alert_configured","compare_my_number","journal_entry_created","share_card_generated"]}'::jsonb);`);
  chk('and set again, and a call that leaves it out keeps it', JSON.parse(db.as(U.admin, `select public.growth_admin_update_activation_settings('{"trial_days":7}'::jsonb);`)).settings.core_kinds.length === 5);

  /* the admin's activation numbers, from Stripe's own events */
  db.service(`insert into public.subscriptions (user_id, status, stripe_customer_id, stripe_subscription_id, created_at) values
    ('${U.t1}','active','cus_t1','sub_t1', now() - interval '12 days'), ('${U.t2}','trialing','cus_t2','sub_t2', now() - interval '3 days'),
    ('${U.t3}','canceled','cus_t3','sub_t3', now() - interval '9 days');`);
  const ts = (d) => Math.floor(Date.now() / 1000) - d * 86400;
  event('customer.subscription.created', { id: 'sub_t1', customer: 'cus_t1', status: 'trialing', trial_start: ts(1) }, U.t1, 86400);
  event('customer.subscription.created', { id: 'sub_t2', customer: 'cus_t2', status: 'trialing', trial_start: ts(3) }, null, 3 * 86400);
  event('customer.subscription.created', { id: 'sub_t3', customer: 'cus_t3', status: 'trialing', trial_start: ts(6) }, U.t3, 6 * 86400);
  event('invoice.payment_succeeded', { id: 'in_t1a', customer: 'cus_t1', subscription: 'sub_t1', amount_paid: 0 }, U.t1, 86400);
  event('invoice.payment_succeeded', { id: 'in_t1b', customer: 'cus_t1', subscription: 'sub_t1', amount_paid: 7999 }, null, 100);
  err = db.mustFail(() => db.as(U.t1, `select public.growth_admin_activation(90);`));
  chk('the activation report is admin-only', !!err && /not an admin/.test(err));
  err = db.mustFail(() => db.anon(`select public.growth_admin_activation(90);`));
  chk('and closed to a signed-out visitor', !!err && /permission denied/.test(err));
  const rep = JSON.parse(db.as(U.admin, `select public.growth_admin_activation(90);`));
  chk('trials are the accounts Stripe shows trialing (resolved through the customer when the event names no user)', rep.trials === 3, rep);
  chk('activated trials reached ACTIVATED inside the trial', rep.activated_trials === 2 && Math.abs(rep.activation_rate - 0.6667) < 1e-4, rep);
  chk('paid conversions count a real charge only (a $0 trial invoice is not one)', rep.paid_conversions === 1 && rep.activated_paid === 1
    && rep.activated_to_paid_rate === 0.5, rep);
  chk('time to activation is measured from the trial start', rep.time_to_activation_hours.n === 2 && rep.time_to_activation_hours.median >= 0, rep.time_to_activation_hours);
  chk('the state mix and the per-action reach are reported', rep.states.POWER_USER === 1 && rep.states.ACTIVATED === 1 && rep.states.EXPLORING === 1
    && rep.actions.watchlist_save >= 1 && rep.cohorts.length >= 1, { s: rep.states, a: rep.actions });
  chk('the report names no reader', !/example\.com|0000-0000/.test(JSON.stringify(rep)));

  /* ══ 2. ACQUISITION ════════════════════════════════════════════════════ */
  db.as(U.admin, `select public.affiliate_admin_upsert_account('creator@example.com','COACHX','active',null,null,'Coach X');`);
  const cls = (a, b, c, d) => db.sql(`select public.acq_classify(${PG.lit(a)}, ${PG.lit(b)}, ${PG.lit(c)}, ${PG.lit(d)});`);
  const CASES = [
    [[null, null, null, null], 'direct'], [[null, null, null, 'edgedesksports.com'], 'direct'], [[null, null, null, 'checkout.stripe.com'], 'direct'],
    [['coachx', null, null, 't.co'], 'creator_affiliate'], [['friend123', null, null, null], 'referral'],
    [[null, 'x', 'dm', null], 'x_dm'], [[null, 'twitter', 'social', null], 'organic_x'], [[null, null, null, 't.co'], 'organic_x'],
    [[null, null, null, 'www.linkedin.com'], 'linkedin'], [[null, 'linkedin', null, null], 'linkedin'],
    [[null, null, null, 'www.google.com'], 'search'], [[null, null, null, 'duckduckgo.com'], 'search'], [[null, 'google', 'organic', null], 'search'],
    [[null, 'google', 'cpc', null], 'other'], [[null, 'newsletter', 'email', null], 'other'], [[null, null, null, 'reddit.com'], 'referral'],
    [[null, 'x_dm', null, null], 'x_dm'], [['COACHX', 'x', 'dm', null], 'creator_affiliate']
  ];
  const wrong = CASES.filter((c) => cls(...c[0]) !== c[1]).map((c) => ({ in: c[0], want: c[1], got: cls(...c[0]) }));
  chk('every source is classified by the one stated rule', wrong.length === 0, wrong);
  err = db.mustFail(() => db.anon(`select public.acq_classify('a','b','c','d');`));
  chk('the classifier is not a public door', !!err && /permission denied/.test(err));

  const V1 = 'acqvisitor_0123456789abcd';
  db.anon(`select public.acq_track_visit('${V1}', '{"landing":"/"}'::jsonb);`);
  const vrow = () => db.sql(`select first_source || '|' || last_source || '|' || (direct_first_seen_at is not null) || '|' || touches from public.acquisition_visitors;`);
  chk('a first direct visit is recorded without an account', vrow() === 'direct|direct|false|1', vrow());
  chk('only a hash of the visitor id is kept', db.sql(`select count(*) from public.acquisition_visitors where visitor_hash = '${V1}';`) === '0');
  db.anon(`select public.acq_track_visit('${V1}', '{"referrer_host":"t.co","landing":"/"}'::jsonb);`);
  chk('the first attributable visit replaces a direct placeholder, keeping when the direct visit happened', vrow() === 'organic_x|organic_x|true|2', vrow());
  db.anon(`select public.acq_track_visit('${V1}', '{"utm_source":"linkedin"}'::jsonb);`);
  chk('then the first touch is frozen and the last touch moves on', vrow() === 'organic_x|linkedin|true|3', vrow());
  db.anon(`select public.acq_track_visit('${V1}', '{}'::jsonb);`);
  chk('a later direct visit does not overwrite the last attributable touch', vrow() === 'organic_x|linkedin|true|4', vrow());
  chk('a malformed visitor id records nothing', JSON.parse(db.anon(`select public.acq_track_visit('x', '{}'::jsonb);`)).ok === false);
  err = db.mustFail(() => db.anon(`select count(*) from public.acquisition_visitors;`));
  chk('anon cannot read visitors', !!err && /permission denied/.test(err));

  /* the account claims its touches */
  db.sql(`insert into auth.users (id, email, created_at) values ('00000000-0000-0000-0000-0000000000e1','new@example.com', now());`);
  const NEW = '00000000-0000-0000-0000-0000000000e1';
  err = db.mustFail(() => db.anon(`select public.acq_claim('${V1}', null, null);`));
  chk('a signed-out visitor cannot claim', !!err && /permission denied/.test(err));
  r = JSON.parse(db.as(NEW, `select public.acq_claim('${V1}', null, null);`));
  const ua = (uid) => db.sql(`select first_source || '|' || last_source from public.user_acquisition where user_id = '${uid}';`);
  chk('an account inherits its visitor\'s first and last touch, and learns nothing back', r.ok === true && Object.keys(r).length === 1 && ua(NEW) === 'organic_x|linkedin', ua(NEW));
  chk('the visitor row now names the account', db.sql(`select user_id from public.acquisition_visitors where visitor_hash = md5('edgedesk-acq:${V1}');`) === NEW);
  err = db.mustFail(() => db.service(`update public.user_acquisition set first_source = 'search' where user_id = '${NEW}';`));
  chk('the first touch of an account is write-once, even for the service role', !!err && /write-once/.test(err));
  /* a direct account is upgraded once, by a touch from before signup */
  db.as(U.r1, `select public.acq_claim(null, null, null);`);
  chk('an account with no signal is direct', ua(U.r1) === 'direct|direct');
  const before = new Date(Date.now() - 12 * 864e5).toISOString();
  db.as(U.r1, `select public.acq_claim(null, '${JSON.stringify({ ref: 'coachx', referrer_host: 't.co', seen_at: before })}'::jsonb, null);`);
  chk('the page\'s stored first touch upgrades a direct account once', ua(U.r1) === 'creator_affiliate|creator_affiliate', ua(U.r1));
  db.as(U.r1, `select public.acq_claim(null, '${JSON.stringify({ utm_source: 'google', utm_medium: 'organic', seen_at: new Date(Date.now() - 15 * 864e5).toISOString() })}'::jsonb, null);`);
  chk('after that no claim changes it, not even an earlier one', ua(U.r1).split('|')[0] === 'creator_affiliate', ua(U.r1));
  db.as(U.r1, `select public.acq_claim(null, null, '${JSON.stringify({ utm_source: 'linkedin', seen_at: new Date().toISOString() })}'::jsonb);`);
  chk('a touch made long after signup is not acquisition', ua(U.r1) === 'creator_affiliate|creator_affiliate', ua(U.r1));
  /* the affiliate ledger is never touched */
  const attrBefore = db.sql(`select count(*) from public.affiliate_attributions;`);
  db.as(U.t1, `select public.acq_claim(null, '${JSON.stringify({ ref: 'coachx', seen_at: new Date(Date.now() - 21 * 864e5).toISOString() })}'::jsonb, null);`);
  chk('an acquisition claim never writes an affiliate attribution', db.sql(`select count(*) from public.affiliate_attributions;`) === attrBefore);
  chk('a creator link claimed through the partner program is its own record', JSON.parse(db.as(U.p, `select public.affiliate_claim('COACHX', null);`)).ok === true);
  db.as(U.p, `select public.acq_claim(null, '${JSON.stringify({ referrer_host: 'www.google.com', seen_at: new Date(Date.now() - 21 * 864e5).toISOString() })}'::jsonb, null);`);
  chk('and never changes one: a creator-credited account keeps its creator whatever its acquisition source',
    db.sql(`select code from public.affiliate_attributions where user_id = '${U.p}';`) === 'COACHX' && ua(U.p) === 'search|search', ua(U.p));

  /* the funnel */
  err = db.mustFail(() => db.as(U.t1, `select public.growth_admin_funnel(90, 'first');`));
  chk('the funnel is admin-only', !!err && /not an admin/.test(err));
  const fu = JSON.parse(db.as(U.admin, `select public.growth_admin_funnel(90, 'first');`));
  const row = (s) => fu.rows.find((x) => x.source === s) || {};
  chk('the funnel has a row for every source, and one for accounts with no record', fu.rows.length === 9
    && ['organic_x', 'x_dm', 'creator_affiliate', 'linkedin', 'search', 'direct', 'referral', 'other', '(untracked)'].every((s) => fu.rows.some((x) => x.source === s)), fu.rows.map((x) => x.source));
  chk('visitors are counted by their first touch', row('organic_x').visitors === 1, row('organic_x'));
  chk('accounts flow visitor → signup → trial → activated → paid by source', row('creator_affiliate').signups === 2 && row('creator_affiliate').trials === 1
    && row('creator_affiliate').activated_trials === 1 && row('creator_affiliate').paid === 1, row('creator_affiliate'));
  chk('retained is its own stage (a renewal), not the first payment', row('creator_affiliate').retained === 0 && /2 paid invoices/.test(fu.retained_rule), fu.retained_rule);
  chk('creator credit from the affiliate ledger is shown beside the acquisition source, not instead of it', row('search').creator_credited === 1 && row('search').signups === 1, row('search'));
  const fl = JSON.parse(db.as(U.admin, `select public.growth_admin_funnel(90, 'last');`));
  chk('the funnel can be read by last touch too', fl.touch === 'last' && (fl.rows.find((x) => x.source === 'linkedin') || {}).signups === 1, fl.rows.find((x) => x.source === 'linkedin'));
  event('invoice.payment_succeeded', { id: 'in_t1c', customer: 'cus_t1', subscription: 'sub_t1', amount_paid: 7999 }, U.t1, 50);
  chk('a renewal makes a paid account retained', JSON.parse(db.as(U.admin, `select public.growth_admin_funnel(90, 'first');`)).rows.find((x) => x.source === 'creator_affiliate').retained === 1);

  /* ══ 3. PUBLIC SAMPLES ═════════════════════════════════════════════════ */
  r = JSON.parse(db.anon(`select public.public_sample_research('cfb|9001');`));
  chk('a game is not public until an admin makes it so', r.ok === false && r.reason === 'not_public', r);
  err = db.mustFail(() => db.as(U.t1, `select public.growth_admin_sample_set('cfb|9001', true);`));
  chk('a reader cannot make a game public', !!err && /not an admin/.test(err));
  r = JSON.parse(db.as(U.admin, `select public.growth_admin_sample_set('cfb|0000', true);`));
  chk('a game with no research state cannot be made public', r.ok === false && r.reason === 'no_research_state_for_that_game', r);
  r = JSON.parse(db.as(U.admin, `select public.growth_admin_sample_set('cfb|9001', true, 'launch sample');`));
  chk('an admin makes a game public', r.ok === true);
  const pub = JSON.parse(db.anon(`select public.public_sample_research('cfb|9001');`));
  chk('a signed-out visitor reads the public game', pub.ok === true && pub.home === 'Florida' && pub.fair.text === 'Ole Miss -1.7' && pub.market.text === 'Florida -2.5'
    && pub.gap.points === 4.2 && pub.reliability.score === 88 && pub.key_reason === 'Model flips the market favorite.', pub);
  chk('with at most three measured drivers', pub.drivers.length === 3 && pub.drivers[0].text === 'team-strength edge', pub.drivers);
  chk('availability as counts, not names', pub.availability.home.out === 1 && pub.availability.home.questionable === 1 && !/A \(WR\)/.test(JSON.stringify(pub)), pub.availability);
  chk('and none of the subscriber-only fields', !('win_prob_home' in pub) && !/secret ranking reason|0\.46|71\.4|spread_moved/.test(JSON.stringify(pub)) && !('state' in pub));
  chk('it names what stays behind the account', Array.isArray(pub.locked) && pub.locked.indexOf('win probability') >= 0);
  const list = JSON.parse(db.anon(`select public.public_sample_list();`));
  chk('the public list carries it', list.length === 1 && list[0].game_key === 'cfb|9001' && !('win_prob_home' in list[0]), list);
  const adm = JSON.parse(db.as(U.admin, `select public.growth_admin_samples();`));
  chk('the admin sees the samples and the candidates', adm.samples.length === 1 && Array.isArray(adm.candidates));
  db.as(U.admin, `select public.growth_admin_sample_set('cfb|9001', false);`);
  chk('turning it off closes it again', JSON.parse(db.anon(`select public.public_sample_research('cfb|9001');`)).ok === false
    && JSON.parse(db.anon(`select public.public_sample_list();`)).length === 0);
  db.as(U.admin, `select public.growth_admin_sample_set('cfb|9001', true, null, now() - interval '1 minute');`);
  chk('an expired sample is closed', JSON.parse(db.anon(`select public.public_sample_research('cfb|9001');`)).ok === false);
  err = db.mustFail(() => db.anon(`select count(*) from public.public_sample_games;`));
  chk('the sample table itself is not readable', !!err && /permission denied/.test(err));
  err = db.mustFail(() => db.anon(`select count(*) from public.game_research_state;`));
  chk('and the research state behind it stays closed to a signed-out visitor', !!err && /permission denied/.test(err));

  /* ══ the file, re-run on a live site with readers' rows already there ═════ */
  db.service(`delete from public.activation_events where user_id = '${U.t1}' and kind in ('watchlist_save', 'journal_entry_created', 'compare_my_number');`);
  const before2 = db.sql(`select count(*) from public.activation_events;`);
  out = db.applyFileAtomic(FILE);
  chk('re-running it puts earlier watchlist and journal actions on record, at the time each row was made', !/CHECK THIS/.test(out)
    && evs(U.t1, 'watchlist_save') === '1' && evs(U.t1, 'journal_entry_created') === '1' && evs(U.t1, 'compare_my_number') === '1'
    && db.sql(`select (e.occurred_at = w.created_at) from public.activation_events e join public.watchlist_games w on w.user_id = e.user_id and w.game_key = e.dedupe_key where e.user_id = '${U.t1}' and e.kind = 'watchlist_save';`) === 't', out.slice(-300));
  const after2 = db.sql(`select count(*) from public.activation_events;`);
  db.applyFileAtomic(FILE);
  chk('the save whose recording failed earlier is healed by it too', evs(U.t4, 'watchlist_save') === '1' && +after2 === +before2 + 4, { before2, after2 });
  chk('and a third run adds nothing', db.sql(`select count(*) from public.activation_events;`) === after2);
  chk('and never invents a client-only action', evs(U.t2, 'watchlist_save') === '0');
} catch (e) {
  chk('the live suite ran without an unexpected error', false, String(e.message).slice(0, 1200));
} finally {
  db.stop();
}
process.exit(T.done());
