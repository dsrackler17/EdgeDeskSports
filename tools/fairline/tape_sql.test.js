#!/usr/bin/env node
/* ===========================================================================
   supabase/fairline_tape.sql (and fairline_tape_cron.sql), AGAINST A REAL
   POSTGRESQL, AS REAL READERS — and the sender over it, end to end.

   The Tape is one stored snapshot of last week per Fairline reader, built
   Monday morning in Chicago and emailed through the existing email pipeline.
   This proves, as Fairline readers, a Bet Checker (red) reader, a lapsed one,
   a free one, anon and the service role:

     1 it installs over fairline.sql and the email pipeline (twice), names
       what is missing, and its report says ok; so does the cron file, which
       schedules one job in both UTC hours that can be 06:00 in Chicago
     2 THE WEEK is Monday to Monday in America/Chicago, across both DST
       changes (169 and 167 hours); the build is due only on Monday from
       06:00 there, CDT or CST
     3 only Fairline readers (black, blue) get a Tape; one per week, however
       many times the build runs
     4 a Tape is APPEND-ONLY: no update, no delete, no truncate — even for the
       service role and the superuser — yet deleting the account removes it
     5 WHAT IS IN IT, against hand-worked figures: the record, units and
       dollars, the return in the slice's own measure, CLV and the beat-close
       rate; price quality from the frozen entry edge (never-checked bets
       counted, never guessed); the best number; the slice that crossed the
       minimum sample into a real leak and the one whose label changed; a
       quiet week; the same arithmetic as The Leaks (fairline_slices_at)
     6 a reader's Tapes are their own; a free, red or lapsed account gets no
       Tape and no figure; anon gets nothing
     7 THE EMAIL: nothing while either switch is off; claimed once, re-checked
       NOW (opted out in the app or from the link, bounced, no longer
       Fairline, too late, a quiet week); marked; a dry run releases; the
       unsubscribe token is the pipeline's own and turns off only The Tape
     8 the sender (tools/fairline/tape_send.js) over the real SQL: one Resend
       call per Tape, its own Idempotency-Key, the List-Unsubscribe link,
       every row marked sent

   Run: node tools/fairline/tape_sql.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));

const T = PG.kit('fairline tape SQL');
const chk = T.chk;
const lit = PG.lit;
const ROOT = PG.ROOT;
const SUPA = (f) => path.join(ROOT, 'supabase', f);
const FILE = SUPA('fairline_tape.sql');
const CRON = SUPA('fairline_tape_cron.sql');
const MIRROR = SUPA(path.join('migrations', '20261029120000_fairline_tape.sql'));
const CRON_MIRROR = SUPA(path.join('migrations', '20261029120100_fairline_tape_cron.sql'));
const SQL = fs.readFileSync(FILE, 'utf8');
const CSQL = fs.readFileSync(CRON, 'utf8');
const NOCOMMENT = SQL.replace(/--.*$/gm, '');

/* ── STATIC: the folder's conventions ──────────────────────────────────── */
chk('no psql meta-commands (it is pasted into the SQL editor)', !/^\\/m.test(SQL) && !/^\\/m.test(CSQL));
chk('both files end in a report', /CHECK THIS/.test(SQL) && /order by 1;\s*$/.test(SQL) && /CHECK THIS/.test(CSQL) && /order by 1;\s*$/.test(CSQL));
chk('nothing is dropped but its own triggers (re-created)', !/\bdrop\s+(table|column|view|function|index|policy)/i.test(NOCOMMENT) &&
  (NOCOMMENT.match(/\bdrop trigger if exists (\w+)/g) || []).every((d) => /fairline_tapes_no_(update|truncate)/.test(d)));
chk('the migration mirrors are byte-identical', fs.existsSync(MIRROR) && fs.readFileSync(MIRROR, 'utf8') === SQL &&
  fs.existsSync(CRON_MIRROR) && fs.readFileSync(CRON_MIRROR, 'utf8') === CSQL);
chk('PostgREST is told to reload', /notify pgrst, 'reload schema'/.test(SQL));
chk('the minimum sample is not written here (it is fairline_rules()\'s)', !/\b15\b/.test(NOCOMMENT));
chk('the time zone is not written here (it is fairline_rules()\'s)', !/America\/Chicago/.test(NOCOMMENT.replace(/comment on table[^;]*;/g, '')));
chk('the cron file writes no key and calls no URL: the build is inside the database', !/service_role_key|Bearer\s|net\.http_post|https?:\/\//i.test(CSQL.replace(/--.*$/gm, '')));

const db = PG.start('tape');
/* FAIRLINE_SQL_REQUIRED=1 (CI) makes a missing PostgreSQL a failure, never a pass */
if (db.skip) { if (process.env.FAIRLINE_SQL_REQUIRED === '1') chk('environment: ' + db.skip, false); console.log('SKIPPED | ' + db.skip + ' — the LIVE layer did not run (not verified)'); process.exit(T.done()); }

const J = (q) => JSON.parse(db.sql('select coalesce(json_agg(t), \'[]\'::json) from (' + q + ') t;') || '[]');
const V = (q) => db.sql(q);
const S1 = (q) => JSON.parse(db.service(q) || 'null');
const uid = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const P = uid(1), Q = uid(2), A = uid(3), B = uid(4), RD = uid(5), C = uid(6), F = uid(7), Z = uid(8), Y = uid(10);
const H = 3600 * 1000, MIN = 60 * 1000;
const asJ = (u, q) => JSON.parse(db.as(u, q) || 'null');
const tapes = (u) => asJ(u, 'select public.fairline_tapes();');
const SIG_COLS = 'sig_key text primary key, event_id text, sport_key text, sport_title text, commence_time timestamptz, home_team text, away_team text, ' +
  'market text, selection text, point numeric, sharp_fair numeric, last_seen_at timestamptz, point_is_modal boolean, is_player_prop boolean not null default false, ' +
  'flagged_at timestamptz, closed_at timestamptz, closing_sharp_fair numeric, clv_excluded_reason text, closing_source text, result text, ' +
  'closing_dec numeric, closing_at_observed timestamptz, clv numeric, beat_close boolean, best_dec numeric, best_book text, best_quote_age_s integer, n_books integer';
/* every number anywhere in a JSON value, by path */
function numbers(v, p, out) {
  out = out || []; p = p || '';
  if (typeof v === 'number') out.push(p);
  else if (Array.isArray(v)) v.forEach((x, i) => numbers(x, p + '[' + i + ']', out));
  else if (v && typeof v === 'object') Object.keys(v).forEach((k) => numbers(v[k], p + '.' + k, out));
  return out;
}
const subscribe = (u, price, status, days) => V('insert into public.subscriptions (user_id, status, price_id, current_period_end) values (' + lit(u) + ', ' + lit(status) +
  ', ' + lit(price) + ", now() + interval '" + days + " days') on conflict (user_id) do update set status = excluded.status, price_id = excluded.price_id, current_period_end = excluded.current_period_end;");

try {
  /* ===================================================================== */
  /* 1. IT INSTALLS, AND SAYS WHAT IT NEEDS                                */
  /* ===================================================================== */
  const noFairline = db.mustFail(() => db.applyFileAtomic(FILE));
  chk('without The Leaks it stops and names fairline.sql', /fairline\.sql/.test(noFairline || ''), noFairline && noFairline.slice(0, 200));
  V('create table public.signals (' + SIG_COLS + ');');
  for (const f of ['bankroll_and_stakes.sql', 'bettor_decisions.sql', 'billing.sql', 'stripe_webhook.sql', 'billing_hardening.sql', 'bet_checker.sql',
    'portfolio.sql', 'bet_import.sql', 'fairline.sql']) db.applyFileAtomic(SUPA(f));
  const noMail = db.mustFail(() => db.applyFileAtomic(FILE));
  chk('without the email pipeline it stops and names lifecycle_email.sql', /lifecycle_email\.sql/.test(noMail || ''), noMail && noMail.slice(0, 200));
  for (const f of ['referral_codes.sql', 'personal_research.sql', 'affiliates.sql', 'growth.sql', 'funnel.sql', 'lifecycle_email.sql']) db.applyFileAtomic(SUPA(f));
  /* the bounce list lifecycle_email.sql honours when present (newsletter.sql) */
  V('create table public.newsletter_suppressions (email text primary key, reason text not null);');

  let out = db.applyFileAtomic(FILE);
  const rep = out.split('\n').filter((l) => /^\d\d /.test(l));
  chk('it applies: eight report rows, every one ok', rep.length === 8 && rep.every((l) => /\|ok/.test(l)), out.slice(-1500));
  chk('the report says Tape email is off by default', /07 Tape email is off, the email pipeline is off/.test(out), rep);
  out = db.applyFileAtomic(FILE);
  chk('and applies a second time, identically', out.split('\n').filter((l) => /^\d\d .*\|ok/.test(l)).length === 8);
  chk('the reader\'s opt-out defaults to on', V("select column_default from information_schema.columns where table_name = 'user_preferences' and column_name = 'fairline_tape_emails';") === 'true');

  /* the cron file, over a stand-in pg_cron */
  const noCron = db.mustFail(() => db.applyFileAtomic(CRON));
  chk('cron: without pg_cron it stops and says so', /pg_cron is not enabled/.test(noCron || ''), noCron && noCron.slice(0, 200));
  V(`create schema if not exists cron;
    create table if not exists cron.job (jobid bigserial primary key, jobname text, schedule text, command text, active boolean default true);
    create or replace function cron.schedule(n text, s text, c text) returns bigint language sql as $$ insert into cron.job (jobname, schedule, command) values (n, s, c) returning jobid $$;
    create or replace function cron.unschedule(j bigint) returns boolean language sql as $$ delete from cron.job where jobid = j returning true $$;`);
  let cout = db.applyFileAtomic(CRON);
  chk('cron: it applies and every report row says ok', cout.split('\n').filter((l) => /^\d /.test(l)).length === 3 && !/CHECK THIS/.test(cout), cout.slice(-800));
  cout = db.applyFileAtomic(CRON);
  chk('cron: applied again, still one job, Mondays at :23 in 11:00 and 12:00 UTC, calling the build',
    V("select count(*) from cron.job where jobname = 'fairline_tape_build';") === '1' &&
    V("select schedule || '|' || btrim(command) from cron.job where jobname = 'fairline_tape_build';") === '23 11,12 * * 1|select public.fairline_tape_build();', cout);
  chk('cron: the report\'s own probe built nothing', V('select count(*) from public.fairline_tapes;') === '0');

  /* ===================================================================== */
  /* 2. THE WEEK, IN CHICAGO, ACROSS DST                                   */
  /* ===================================================================== */
  const build = (atIso, force) => S1('select public.fairline_tape_build(' + lit(atIso) + '::timestamptz' + (force ? ', true' : '') + ');');
  let b = build('2026-11-02 11:23+00');
  chk('Mon 2 Nov 2026 11:23 UTC is 05:23 CST: not due, nothing built', b.due === false && /Mon 2026-11-02 05:23/.test(b.local_time), b);
  b = build('2026-11-02 12:23+00');
  chk('…12:23 UTC is 06:23 CST: due, for the week of Mon 26 Oct', b.due === true && b.week_start === '2026-10-26' && b.built === 0, b);
  chk('…a DST week runs 169 hours: CDT midnight to CST midnight', Date.parse(b.starts_at) === Date.parse('2026-10-26T05:00:00Z') && Date.parse(b.ends_at) === Date.parse('2026-11-02T06:00:00Z'), b);
  b = build('2026-10-26 11:23+00');
  chk('Mon 26 Oct 11:23 UTC is 06:23 CDT: due, for the week of Mon 19 Oct (168 hours)', b.due === true && b.week_start === '2026-10-19' &&
    Date.parse(b.ends_at) - Date.parse(b.starts_at) === 168 * H, b);
  chk('Mon 26 Oct 10:59 UTC is 05:59 CDT: not due', build('2026-10-26 10:59+00').due === false);
  chk('a Tuesday and a Sunday are never due', build('2026-10-27 12:23+00').due === false && build('2026-11-01 15:00+00').due === false);
  b = build('2027-03-15 11:23+00');
  chk('spring forward: Mon 15 Mar 2027 11:23 UTC is 06:23 CDT, the week of 8 Mar runs 167 hours',
    b.due === true && b.week_start === '2027-03-08' && Date.parse(b.ends_at) - Date.parse(b.starts_at) === 167 * H, b);
  const nextAt = (iso) => 1000 * Number(V("select extract(epoch from public.fairline_tape_next('" + iso + "'::timestamptz));"));
  chk('the next Tape: before 06:00 CT on a Monday it is that morning, after it the next Monday',
    nextAt('2026-11-02 11:23+00') === Date.parse('2026-11-02T12:00:00Z') && nextAt('2026-11-02 12:23+00') === Date.parse('2026-11-09T12:00:00Z'),
    [nextAt('2026-11-02 11:23+00'), nextAt('2026-11-02 12:23+00')]);
  chk('nobody else may build: a reader is refused', /scheduler's alone/.test(db.mustFail(() => db.as(P, "select public.fairline_tape_build(now(), true);")) || '') ||
    /permission denied/.test(db.mustFail(() => db.as(P, "select public.fairline_tape_build(now(), true);")) || ''));

  /* ===================================================================== */
  /* the readers and their bets, around LAST week (relative to now)        */
  /* ===================================================================== */
  const W = J("select week_start::text as ws, extract(epoch from starts_at) * 1000 as s, extract(epoch from ends_at) * 1000 as e, extract(epoch from now()) * 1000 as n from public.fairline_tape_week(now())")[0];
  const off = (absMs) => "(now() + interval '" + Math.round((absMs - W.n) / 1000) + " seconds')";
  V('insert into auth.users (id, email) values ' + [P, Q, A, B, RD, C, F, Z].map((u, i) => '(' + lit(u) + ", 'u" + i + "@x.co')").join(', ') + ", (" + lit(Y) + ", 'y@x.co');");
  db.service("select public.billing_learn_price_tier('price_red_t', 'prod_bc', 'red', 'bet_checker_monthly', true, 'test');");
  db.service("select public.billing_learn_price_tier('price_black_t', 'prod_fl', 'black', 'fairline_monthly', true, 'test');");
  db.service("select public.billing_learn_price_tier('price_blue_t', 'prod_ed', 'blue', null, true, 'test');");
  subscribe(P, 'price_black_t', 'active', 20);
  subscribe(Q, 'price_blue_t', 'trialing', 5);
  subscribe(A, 'price_black_t', 'active', 20);
  subscribe(B, 'price_black_t', 'active', 20);
  subscribe(Z, 'price_black_t', 'active', 20);
  subscribe(Y, 'price_black_t', 'active', 20);
  subscribe(RD, 'price_red_t', 'active', 20);
  subscribe(C, 'price_black_t', 'canceled', -3);

  /* a graded Bet Checker row (the grader's columns, written as the superuser) */
  let nb = 0;
  function ub(u, o) {
    const id = V('select gen_random_uuid();');
    nb++;
    V('set session_replication_role = replica; insert into public.user_bets (id, user_id, bet_key, source, sport, game_id, event_id, market_type, side, team, line, odds, book, units, ' +
      'placed_at, kickoff, home_team, away_team, result, units_won, close_status, clv_pct, status, entry_grade, entry_edge_pct, created_at) values (' +
      [lit(id), lit(u), lit('bc:' + id), "'own'", "'NFL'", lit('g' + nb), lit('g' + nb), lit(o.market || 'spread'), lit(o.side || 'home'), lit(o.team || null),
       o.line == null ? 'null' : o.line, o.odds || -110, lit(o.book || 'DraftKings'), 1,
       off(o.kick - 30 * H), off(o.kick), lit(o.home || 'Kansas City Chiefs'), lit(o.away || 'Buffalo Bills'),
       lit(o.result || null), o.won == null ? 'null' : o.won, lit(o.clv == null ? 'pending' : 'captured'), o.clv == null ? 'null' : o.clv, "'open'",
       lit(o.grade || null), o.edge == null ? 'null' : o.edge, 'now()'].join(', ') + '); set session_replication_role = default;');
    return id;
  }
  const before = (h) => W.s - h * H, inWeek = (h) => W.s + h * H;
  /* P, before the week: 14 losing spreads under the close (a small sample),
     15 totals 10-5 over the close (Real edge) */
  for (let i = 0; i < 14; i++) ub(P, { kick: before(72 + i), market: 'spread', line: -3, result: 'loss', won: -1, clv: -1 });
  for (let i = 0; i < 15; i++) ub(P, { kick: before(40 + i), market: 'total', side: 'over', line: 47.5, result: i < 10 ? 'win' : 'loss', won: i < 10 ? 0.9091 : -1, clv: 1.5 });
  /* P, in the week: two more losing spreads (16: now a Real leak), eight
     losing totals still over the close (Bad luck), an open moneyline, and one
     Portfolio bet won at +120 for $50 */
  ub(P, { kick: inWeek(20), market: 'spread', line: -3, result: 'loss', won: -1, clv: -1, grade: 'red', edge: -1 });
  ub(P, { kick: inWeek(21), market: 'spread', line: -3, result: 'loss', won: -1, clv: -1, grade: 'red', edge: -1 });
  ub(P, { kick: inWeek(30), market: 'total', side: 'over', line: 44.5, odds: -105, result: 'loss', won: -1, clv: 1.5, grade: 'green', edge: 2.5,
    home: 'Detroit Lions', away: 'Green Bay Packers' });
  for (let i = 1; i < 8; i++) ub(P, { kick: inWeek(30 + i), market: 'total', side: 'over', line: 47.5, result: 'loss', won: -1, clv: 1.5, grade: i === 1 ? 'ungraded' : null });
  ub(P, { kick: inWeek(100), market: 'moneyline', side: 'home' });
  db.as(P, 'insert into public.portfolio_positions (platform, platform_label, platform_type, position_type, event_name, event_start_at, market_name, selection, line, ' +
    "odds_american, stake, status, settled_at, placed_at, source) values ('fanduel', 'FanDuel', 'SPORTSBOOK', 'MONEYLINE', 'Lakers @ Celtics', " + off(inWeek(50)) +
    ", 'Game line', 'Celtics', null, 120, 50, 'WON', " + off(inWeek(53)) + ', ' + off(inWeek(48)) + ", 'MANUAL') returning id;");
  /* Q (terminal), B and Z (Fairline): a bet each in the week; A: nothing */
  ub(Q, { kick: inWeek(40), result: 'win', won: 0.9091, clv: 0.5 });
  ub(B, { kick: inWeek(40), result: 'loss', won: -1 });
  ub(Z, { kick: inWeek(41), result: 'win', won: 0.9091 });
  /* Y turned The Tape emails off long before this week, in their own row */
  ub(Y, { kick: inWeek(42), result: 'win', won: 0.9091 });
  db.as(Y, 'insert into public.user_preferences (user_id, fairline_tape_emails) values (' + lit(Y) + ', false);');
  /* RD (Bet Checker only), C (lapsed), F (free): bets, and no Tape */
  ub(RD, { kick: inWeek(40), result: 'win', won: 0.9091 });
  ub(C, { kick: inWeek(40), result: 'win', won: 0.9091 });
  ub(F, { kick: inWeek(40), result: 'win', won: 0.9091 });

  /* ===================================================================== */
  /* 3. ONLY FAIRLINE READERS, ONCE A WEEK                                 */
  /* ===================================================================== */
  b = S1('select public.fairline_tape_build(now(), true);');
  chk('the build makes one Tape for each Fairline reader: black and blue, not red, lapsed or free',
    b.built === 6 && b.week_start === W.ws &&
    J('select user_id from public.fairline_tapes order by user_id').map((r) => r.user_id).join() === [P, Q, A, B, Z, Y].join(), b);
  chk('…each with one email waiting', V("select count(*) from public.fairline_tape_deliveries where status = 'pending';") === '6');
  b = S1('select public.fairline_tape_build(now(), true);');
  chk('a second run adds nothing', b.built === 0 && V('select count(*) from public.fairline_tapes;') === '6', b);
  const bg = db.background("select public.fairline_tape_build(now(), true);");
  db.sql('select public.fairline_tape_build(now(), true);');
  chk('two overlapping runs add nothing either', bg.wait(30000).code === 0 && V('select count(*) from public.fairline_tapes;') === '6');

  /* ===================================================================== */
  /* 4. APPEND-ONLY                                                        */
  /* ===================================================================== */
  const tp = J('select id from public.fairline_tapes where user_id = ' + lit(P))[0].id;
  chk('no update, even as the service role', /append-only/.test(db.mustFail(() => db.service("update public.fairline_tapes set tape = '{}'::jsonb where id = " + tp + ';')) || ''));
  chk('no update, even as the superuser', /append-only/.test(db.mustFail(() => V('update public.fairline_tapes set built_at = now() where id = ' + tp + ';')) || ''));
  chk('no delete while the reader exists', /append-only/.test(db.mustFail(() => V('delete from public.fairline_tapes where id = ' + tp + ';')) || '') &&
    /append-only/.test(db.mustFail(() => db.service('delete from public.fairline_tapes where id = ' + tp + ';')) || ''));
  chk('no truncate', /append-only/.test(db.mustFail(() => V('truncate public.fairline_tapes cascade;')) || ''));
  chk('the Tape is still there, unchanged', V('select count(*) from public.fairline_tapes;') === '6');

  /* ===================================================================== */
  /* 5. WHAT IS IN IT                                                      */
  /* ===================================================================== */
  const tape = asJ(P, 'select public.fairline_tapes();');
  const t = tape.tapes[0].tape;
  const w = t.week_stats;
  chk('P\'s Tape is for last week, in Chicago', tape.paid === true && tape.tapes.length === 1 && tape.tapes[0].week_start === W.ws &&
    t.week.start === W.ws && t.week.time_zone === 'America/Chicago', tape.tapes[0] && tape.tapes[0].week_start);
  chk('the week: 11 settled, 1 open; 1-10', w.bets === 11 && w.pending === 1 && w.wins === 1 && w.losses === 10 && w.pushes === 0, w);
  chk('units on the 10 Bet Checker bets (−10.00u), dollars on the 1 Portfolio bet (+$60.00)',
    Number(w.pl_units) === -10 && w.units_bets === 10 && Number(w.pl_dollars) === 60 && w.dollars_bets === 1, w);
  chk('the return is read flat (neither measure covers all 11): −8.80 a unit, −80.0%', w.roi_basis === 'flat' && Number(w.pl_basis_value) === -8.8 && Number(w.roi_pct) === -80, w);
  chk('CLV over the 10 captured closes: +1.00% average, 8 beat the close (80%)', w.clv_bets === 10 && Number(w.avg_clv_pct) === 1 && w.beat_close === 8 && Number(w.beat_close_pct) === 80, w);
  chk('the week is The Leaks\' own "all" slice over the week (fairline_slices_at)',
    JSON.stringify(w) === JSON.stringify((() => {
      const s = JSON.parse(db.service('select s from jsonb_array_elements(public.fairline_slices_at(' + lit(P) + ', ' + lit(new Date(W.s).toISOString()) + ', ' +
        lit(new Date(W.e).toISOString()) + ")) s where s ->> 'dim' = 'all';"));
      ['set_hash', 'dim', 'val', 'ord', 'label', 'label_basis', 'small_sample'].forEach((k) => delete s[k]);
      return s;
    })()));
  chk('fairline_slices_for is fairline_slices_at over every bet', db.service('select public.fairline_slices_for(' + lit(P) + ') = public.fairline_slices_at(' + lit(P) + ', null, null);') === 't');
  const pq = t.price;
  chk('price quality: 12 bets in the week, 3 checked against fair when placed, +0.17 pts average, 1 better and 2 worse; the ungraded one is not counted',
    pq.bets === 12 && pq.priced === 3 && Number(pq.avg_edge_pts) === 0.17 && pq.better_than_fair === 1 && pq.worse_than_fair === 2, pq);
  chk('the best number: the largest entry edge, +2.50 pts, with what it was', t.best && t.best.measure === 'fair' && Number(t.best.edge_pts) === 2.5 &&
    t.best.selection === 'Over 44.5' && t.best.odds_american === -105 && t.best.platform === 'DraftKings' && t.best.event === 'Green Bay Packers at Detroit Lions', t.best);
  const ch = t.changes;
  const chOf = (dim, val) => ch.find((c) => c.dim === dim && c.val === val);
  chk('spreads crossed the minimum sample (14 → 16) into a Real leak', chOf('market', 'spread') && chOf('market', 'spread').kind === 'crossed' &&
    chOf('market', 'spread').from === null && chOf('market', 'spread').to === 'real_leak' && chOf('market', 'spread').bets === 16 &&
    chOf('market', 'spread').bets_before === 14, chOf('market', 'spread'));
  chk('totals changed from Real edge to Bad luck (losing now, still beating the close)', chOf('market', 'total') && chOf('market', 'total').kind === 'changed' &&
    chOf('market', 'total').from === 'real_edge' && chOf('market', 'total').to === 'bad_luck', chOf('market', 'total'));
  chk('the slices that did not change are not listed (NFL, DraftKings: Bad luck before and after); a real leak leads',
    !chOf('sport', 'NFL') && !chOf('book', 'DraftKings') && ch[0].to === 'real_leak' && ch.every((c) => c.dim !== 'all'), ch.map((c) => c.dim + ':' + c.val + ':' + c.from + '>' + c.to));
  chk('it carries the rules it was read by', t.rules && t.rules.min_sample_bets === 15 && Array.isArray(t.rules.odds_buckets) && t.rules.version === 'fairline-v1');
  chk('P\'s week is not quiet', t.quiet === false);
  /* the offline email suite (tape_email.test.js) reads a stored Tape from
     tools/fairline/fixtures/tape.json: it must have exactly a real Tape's
     shape. FAIRLINE_TAPE_FIXTURE_WRITE=1 rewrites it from this one. */
  const FIX = path.join(__dirname, 'fixtures', 'tape.json');
  if (process.env.FAIRLINE_TAPE_FIXTURE_WRITE === '1') { fs.mkdirSync(path.dirname(FIX), { recursive: true }); fs.writeFileSync(FIX, JSON.stringify(t, null, 2) + '\n'); }
  const shape = (v) => Array.isArray(v) ? (v.length ? [shape(v[0])] : []) : v && typeof v === 'object' ? Object.keys(v).sort().map((k) => k + ':' + JSON.stringify(shape(v[k]))) : typeof v;
  chk('the email suite\'s fixture has a real Tape\'s shape', fs.existsSync(FIX) && JSON.stringify(shape(JSON.parse(fs.readFileSync(FIX, 'utf8')))) === JSON.stringify(shape(t)));
  const ta = tapes(A).tapes[0].tape;
  chk('A bet nothing: a quiet Tape, zeros, no price, no best number, no change', ta.quiet === true && ta.week_stats.bets === 0 && ta.price.bets === 0 &&
    ta.best === null && ta.changes.length === 0, ta);
  chk('Q\'s (the terminal\'s) Tape: 1-0, its close captured', tapes(Q).tapes[0].tape.week_stats.wins === 1 && tapes(Q).tapes[0].tape.week_stats.clv_bets === 1);
  chk('B\'s best number, with no fair at entry, is none (no close either)', tapes(B).tapes[0].tape.best === null);
  const tq = tapes(Q).tapes[0].tape;
  chk('…and Q\'s, with no fair at entry, falls back to the best captured close', tq.best && tq.best.measure === 'close' && Number(tq.best.clv_pct) === 0.5, tq.best);

  /* ===================================================================== */
  /* 6. A READER'S TAPES ARE THEIR OWN; NO FIGURE WITHOUT FAIRLINE         */
  /* ===================================================================== */
  chk('P sees only P\'s Tape', tapes(P).tapes.length === 1 && tapes(Z).tapes.length === 1 &&
    JSON.stringify(tapes(P).tapes[0].tape) !== JSON.stringify(tapes(Z).tapes[0].tape));
  chk('no reader reads the table directly', /permission denied/.test(db.mustFail(() => db.as(P, 'select * from public.fairline_tapes;')) || '') &&
    /permission denied/.test(db.mustFail(() => db.as(P, 'select * from public.fairline_tape_deliveries;')) || ''));
  chk('no reader may compute another account\'s Tape', /permission denied/.test(db.mustFail(() => db.as(P, 'select public.fairline_tape_compute(' + lit(Q) + ", now() - interval '7 days', now());")) || ''));
  chk('nor the window of another account\'s leaks', /permission denied/.test(db.mustFail(() => db.as(P, 'select public.fairline_slices_at(' + lit(Q) + ', null, null);')) || ''));
  for (const [who, name] of [[RD, 'Bet Checker (red)'], [C, 'lapsed'], [F, 'free']]) {
    const x = tapes(who);
    const nums = numbers(x).filter((p) => !/^\.rules\.tape\./.test(p));
    chk(name + ': not paid, no Tape, and no figure but the schedule', x.paid === false && !x.tapes && nums.length === 0 && !!x.next_at, { x, nums });
  }
  chk('anon reads no Tape', /permission denied/.test(db.mustFail(() => db.anon('select public.fairline_tapes();')) || ''));

  /* ===================================================================== */
  /* 7. THE EMAIL                                                          */
  /* ===================================================================== */
  /* the sender's clock: Monday 07:00 CT after the week (the claim re-checks
     against it), so the suite reads the same on any day it runs */
  const MONDAY = new Date(W.e + 7 * H).toISOString();
  const due = (n) => S1('select public.fairline_tape_due(' + (n || 25) + ', ' + lit(MONDAY) + '::timestamptz);');
  let d = due();
  chk('the pipeline switched off: nothing claimed', d.sending_enabled === false && d.messages.length === 0 &&
    V("select count(*) from public.fairline_tape_deliveries where status = 'pending';") === '6');
  V('update public.lifecycle_settings set sending_enabled = true;');
  d = due();
  chk('the pipeline on, The Tape\'s own switch off (the default): nothing claimed', d.sending_enabled === true && d.tape_email_enabled === false && d.messages.length === 0);
  chk('the page says email delivery is not on yet', tapes(P).email.delivering === false && tapes(P).email.mine === true);
  V('update public.fairline_tape_settings set email_enabled = true;');
  chk('readers cannot call the sender\'s functions', ['public.fairline_tape_due(5, now())', "public.fairline_tape_mark(1, 'sent')"].every((f) =>
    /permission denied/.test(db.mustFail(() => db.as(P, 'select ' + f + ';')) || '')));
  /* before the claim: B opts out in the app, Z's address bounced, Q lapses */
  chk('B turns The Tape emails off on the page', asJ(B, 'select public.fairline_tape_email(false);').on === false &&
    V("select status || ':' || skip_reason from public.fairline_tape_deliveries d join public.fairline_tapes t on t.id = d.tape_id where t.user_id = " + lit(B) + ';') === 'skipped:reader turned The Tape emails off');
  V("insert into public.newsletter_suppressions values ('u7@x.co', 'bounce');");
  subscribe(Q, 'price_blue_t', 'canceled', -1);
  d = due();
  const ids = d.messages.map((m) => m.user_id);
  chk('only P is claimed: A (quiet), Z (bounced), Q (no longer Fairline), Y (opted out before the week) are skipped with the reason; B was already skipped',
    ids.join() === P && J('select t.user_id, d.status, d.skip_reason from public.fairline_tape_deliveries d join public.fairline_tapes t on t.id = d.tape_id order by t.user_id')
      .map((r) => r.user_id.slice(-1) + ':' + r.status + ':' + (r.skip_reason || '')).join('|') ===
      ['1:sending:', '2:skipped:no longer a Fairline reader', '3:skipped:nothing to report this week', '4:skipped:reader turned The Tape emails off', '8:skipped:address bounced or complained',
       '0:skipped:reader turned The Tape emails off'].join('|'),
    J('select t.user_id, d.status, d.skip_reason from public.fairline_tape_deliveries d join public.fairline_tapes t on t.id = d.tape_id order by t.user_id'));
  const m = d.messages[0];
  const tok = V('select token from public.lifecycle_tokens where user_id = ' + lit(P) + ';');
  chk('the message carries the stored Tape, the address and the pipeline\'s own token', m.kind === 'fairline_tape' && m.email === 'u0@x.co' &&
    JSON.stringify(m.tape) === JSON.stringify(t) && m.unsubscribe_token === tok && /^[0-9a-f]{64}$/.test(tok) && d.from && d.mailing_address);
  chk('a claimed row is not claimed twice', due().messages.length === 0);
  chk('a dry run releases it: pending, the attempt uncounted', db.service('select public.fairline_tape_mark(' + m.id + ", 'release');") === 't' &&
    V('select status || ' + "':'" + ' || attempts from public.fairline_tape_deliveries where id = ' + m.id + ';') === 'pending:0');
  /* the opt-out from the email's link, signed out */
  chk('a bad token changes nothing', JSON.parse(db.anon("select public.fairline_tape_unsubscribe('" + 'f'.repeat(64) + "');")).ok === false &&
    JSON.parse(db.anon("select public.fairline_tape_unsubscribe('nope');")).ok === false);
  V("insert into public.lifecycle_tokens (user_id) values (" + lit(Z) + ') on conflict do nothing;');
  const ztok = V('select token from public.lifecycle_tokens where user_id = ' + lit(Z) + ';');
  chk('the link turns off The Tape emails for its reader, and nothing else', JSON.parse(db.anon("select public.fairline_tape_unsubscribe('" + ztok + "');")).ok === true &&
    V('select fairline_tape_emails::text || trial_emails::text from public.user_preferences where user_id = ' + lit(Z) + ';') === 'falsetrue');
  chk('…and the trial emails\' own link does not touch The Tape', JSON.parse(db.anon("select public.lifecycle_unsubscribe('" + tok + "');")).ok === true &&
    V('select fairline_tape_emails::text || trial_emails::text from public.user_preferences where user_id = ' + lit(P) + ';') === 'truefalse');
  chk('B turns the email back on', asJ(B, 'select public.fairline_tape_email(true);').on === true && tapes(B).email.mine === true);
  chk('anon cannot set a preference', /permission denied/.test(db.mustFail(() => db.anon('select public.fairline_tape_email(true);')) || ''));
  /* an old week is never emailed */
  b = S1("select public.fairline_tape_build(now() - interval '14 days', true);");
  chk('a catch-up build of an older week makes its Tapes', b.built >= 1 && b.week_start !== W.ws, b);
  d = due();
  const old = J("select t.user_id, d.status, d.skip_reason from public.fairline_tape_deliveries d join public.fairline_tapes t on t.id = d.tape_id where t.week_start <> " + lit(W.ws) + ' order by t.user_id');
  chk('…none of which is emailed: P\'s is too late (more than 48 hours after its week); only this week\'s P is claimed again',
    d.messages.length === 1 && d.messages[0].id === m.id && old.length === b.built && old.every((r) => r.status === 'skipped') &&
    old.find((r) => r.user_id === P).skip_reason === 'too late to be useful', old);
  chk('marked sent, with the provider id; a second mark changes nothing', db.service('select public.fairline_tape_mark(' + m.id + ", 'sent', 'em_1');") === 't' &&
    db.service('select public.fairline_tape_mark(' + m.id + ", 'failed', null, 'late');") === 'f' &&
    V('select status || provider_id from public.fairline_tape_deliveries where id = ' + m.id + ';') === 'sentem_1');
  chk('the page shows the email as sent', tapes(P).tapes.find((x) => x.week_start === W.ws).email.status === 'sent');

  /* ===================================================================== */
  /* 8. THE SENDER, OVER THE REAL SQL                                      */
  /* ===================================================================== */
  const SENDER = require(path.join(ROOT, 'tools', 'fairline', 'tape_send.js'));
  /* a fresh week for P to send: drop the sent mark by building next week's */
  V('insert into auth.users (id, email) values (' + lit(uid(9)) + ", 'u9@x.co');");
  subscribe(uid(9), 'price_black_t', 'active', 20);
  ub(uid(9), { kick: inWeek(60), result: 'win', won: 0.9091, clv: 2, grade: 'green', edge: 1.2 });
  S1('select public.fairline_tape_build(now(), true);');
  const rpc = async (name, body) => {
    if (name === 'fairline_tape_due') body = Object.assign({ p_now: MONDAY }, body);
    const args = Object.keys(body || {}).map((k) => k + ' => ' + (typeof body[k] === 'number' ? String(body[k]) : lit(body[k])));
    const r = db.service('select public.' + name + '(' + args.join(', ') + ');');
    return r === 't' ? true : r === 'f' ? false : JSON.parse(r);
  };
  const calls = [];
  const fakeFetch = async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return { ok: true, status: 200, text: async () => JSON.stringify({ id: 're_' + calls.length }) }; };
  (async () => {
    const res = await SENDER.run({ rpc, apiKey: 'k', key: 'svc', url: 'https://x.supabase.co', fetch: fakeFetch, log: () => {} });
    chk('the sender sends the one Tape due, through Resend', res.status === 'OK' && res.sent === 1 && calls.length === 1 && calls[0].url === 'https://api.resend.com/emails', res);
    const c = calls[0] || { init: { headers: {} }, body: {} };
    const did = V('select d.id from public.fairline_tape_deliveries d join public.fairline_tapes t on t.id = d.tape_id where t.user_id = ' + lit(uid(9)) + ';');
    chk('…with its own Idempotency-Key, never a trial email\'s', c.init.headers['idempotency-key'] === 'edgedesk-lifecycle-fairline-tape-' + did, c.init.headers);
    const ut = V('select token from public.lifecycle_tokens where user_id = ' + lit(uid(9)) + ';');
    chk('…the List-Unsubscribe link to the Tape opt-out, with the reader\'s token', c.body.headers && c.body.headers['List-Unsubscribe'] === '<https://edgedesksports.com/email/tape/?t=' + ut + '>', c.body.headers);
    chk('…to the reader, from the pipeline\'s sender, with the week\'s words', c.body.to && c.body.to[0] === 'u9@x.co' && /EdgeDesk/.test(c.body.from) &&
      /^The Tape: /.test(c.body.subject) && /Last week: 1–0 on 1 bet settled/.test(c.body.text) && /1-800-GAMBLER/.test(c.body.text), { subject: c.body.subject, text: (c.body.text || '').slice(0, 300) });
    chk('…and the row is marked sent with the provider id', V('select status || provider_id from public.fairline_tape_deliveries where id = ' + did + ';') === 'sentre_1');
    const again = await SENDER.run({ rpc, apiKey: 'k', key: 'svc', url: 'https://x.supabase.co', fetch: fakeFetch, log: () => {} });
    chk('a second run sends nothing', again.status === 'OK' && again.sent === 0 && calls.length === 1, again);
    V('update public.fairline_tape_settings set email_enabled = false;');
    chk('with The Tape\'s switch off the sender claims nothing', (await SENDER.run({ rpc, apiKey: 'k', key: 'svc', url: 'https://x.supabase.co', fetch: fakeFetch, log: () => {} })).status === 'DISABLED');

    /* deleting the account still removes its Tapes (the cascade passes the guard) */
    V('delete from auth.users where id = ' + lit(A) + ';');
    chk('deleting an account removes its Tapes and their emails', V('select count(*) from public.fairline_tapes where user_id = ' + lit(A) + ';') === '0' &&
      V('select count(*) from public.fairline_tape_deliveries where user_id = ' + lit(A) + ';') === '0');
    chk('…and only its own', V('select count(*) from public.fairline_tapes where user_id = ' + lit(P) + ';') !== '0');
    db.stop();
    process.exit(T.done());
  })().catch((e) => { chk('the sender ran', false, String(e && e.stack || e).slice(0, 600)); db.stop(); process.exit(T.done()); });
} catch (e) {
  chk('the suite ran to the end', false, String(e && (e.sqlMessage || e.stack) || e).slice(0, 1200));
  db.stop();
  process.exit(T.done());
}
