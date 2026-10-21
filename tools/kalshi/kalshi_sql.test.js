#!/usr/bin/env node
/* ===========================================================================
   The Kalshi market data layer on a real PostgreSQL
   (supabase/kalshi_market_data.sql, kalshi_market_data_cron.sql,
   kalshi_market_data_rollback.sql).

     node tools/kalshi/kalshi_sql.test.js     (KALSHI_SQL_REQUIRED=1 in CI)

   The capture tables are built as production has them: public.signals and
   public.signal_ticks readable by the client roles, with row level security
   that lets only a subscriber (has_active_sub()) see a row. Then:
     guard        the layer refuses to install without close_v7_parity's column
     roles        anon and authenticated read Kalshi's (public) tables; nobody
                  but service_role writes
     history      snapshots, runs and alerts refuse update, delete and truncate;
                  a link is written once and only a missing game id is filled,
                  once
     mid          a spread of exactly 0.06 is trusted, 0.07 is not; a zero bid
                  or a $1 ask is one-sided
     comparison   pregame only; spread > 0.06 excluded; the nearest capture
                  pass either way (a tie goes to the earlier); > 10 minutes
                  flagged; the gap in points
     close        the last snapshot before kickoff (in-game prices never), a
                  wide close left out rather than replaced; an unknown book
                  observation time flagged
     access       the comparison, the close and the card's gap answer only a
                  subscriber: anon and a non-subscriber see Kalshi's prices
                  and no book fair
     card         OK, WIDE_SPREAD, STALE, NO_SNAPSHOT; after kickoff, the close
     capture      a market with no snapshot near its close is a miss, counted
     readiness    never run, discover only, a silent scheduler and a failed
                  snapshot are errors; a priced game left unmatched, close
                  capture under 90% and no tracked series are warnings; a game
                  no book prices is counted apart, never a warning
     cron         the poke without its secret records a failed run and a
                  FAILURE alert; with it, both modes queue with the header
     rollback     removes the layer and its jobs
     starter      over the starter kalshi_schema.sql (tools/kalshi/fixtures):
                  its tables and rows kept and upgraded, its views replaced,
                  its cron jobs removed
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const T = PG.kit('Kalshi market data');
const ROOT = PG.ROOT;
const F = (n) => path.join(ROOT, 'supabase', n);
const LAYER = fs.readFileSync(F('kalshi_market_data.sql'), 'utf8');
const FILES = ['kalshi_market_data.sql', 'kalshi_market_data_cron.sql', 'kalshi_market_data_rollback.sql'];

T.chk('the layer never grants a client write', !/grant\s+(insert|update|delete|all)[^;]*to\s+(anon|authenticated)/i.test(LAYER));
T.chk('the migration copy is the same file', fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '20261021230000_kalshi_market_data.sql'), 'utf8') === LAYER);
T.chk('no psql meta-command in any file', FILES.every((n) => !/^\s*\\/m.test(fs.readFileSync(F(n), 'utf8'))));
T.chk('the rules are the stated ones (spread 0.06, 10 minutes)', /'max_spread'\s+then 0\.06/.test(LAYER) && /'max_fair_gap_minutes'\s+then 10\b/.test(LAYER) && /'close_capture_minutes'\s+then 10\b/.test(LAYER));
T.chk('the cron file never writes the service-role key into a job', !/service_role_key|Bearer\s/i.test(fs.readFileSync(F('kalshi_market_data_cron.sql'), 'utf8')));

const db = PG.start('kalshi');
if (db.skip) {
  if (process.env.KALSHI_SQL_REQUIRED === '1') T.chk('a PostgreSQL cluster starts (required in CI)', false, db.skip);
  console.log('NOTE | ' + db.skip + ' — the LIVE layer did not run'); process.exit(T.done());
}
const lit = PG.lit;
const fails = (fn) => { try { fn(); return false; } catch (_) { return true; } };
const J = (s) => JSON.parse(String(s).split('\n').filter(Boolean).pop());
const SUB = '00000000-0000-0000-0000-0000000000aa', NOSUB = '00000000-0000-0000-0000-0000000000bb';
const asSub = (q) => db.as(SUB, q);
const rows = (q, who) => J((who || db.sql)(`select coalesce(jsonb_agg(x), '[]'::jsonb) from (${q}) x;`));
const one = (q, who) => rows(q, who)[0] || null;
try {
  /* ---- the capture tables, as production has them (signals gated on has_active_sub) ---- */
  db.sql(`create table public.signals (id bigserial primary key, sig_key text unique not null, event_id text, sport_key text, commence_time timestamptz,
      home_team text, away_team text, market text, selection text, point numeric, sharp_fair numeric, closing_sharp_fair numeric, closed_at timestamptz);
    create table public.signal_ticks (id bigserial primary key, sig_key text not null, created_at timestamptz not null default now(), best_dec numeric, sharp_fair numeric, n_books integer);
    create index signal_ticks_sig_created_idx on public.signal_ticks (sig_key, created_at);
    create or replace function public.has_active_sub() returns boolean language sql stable as $$ select auth.uid() = ${lit(SUB)}::uuid $$;
    alter table public.signals enable row level security; alter table public.signal_ticks enable row level security;
    create policy signals_sub on public.signals for select to authenticated using (public.has_active_sub());
    create policy ticks_sub on public.signal_ticks for select to authenticated using (public.has_active_sub());
    grant select on public.signals, public.signal_ticks to anon, authenticated;`);
  let err = null; try { db.applyFile(F('kalshi_market_data.sql')); } catch (e) { err = String(e.message); }
  T.chk('guard: without signals.closing_at_observed the layer names close_v7_parity.sql and installs nothing', /close_v7_parity\.sql/.test(err || '') && db.sql("select to_regclass('public.kalshi_markets') is null") === 't', err);
  db.sql('alter table public.signals add column closing_at_observed timestamptz, add column closing_source text;');

  let out = db.applyFile(F('kalshi_market_data.sql'));
  T.chk('the layer applies; every report row is ok or the tracked series is pending', !/CHECK THIS/.test(out) && (out.match(/\|ok/g) || []).length === 9 && /8 a series is tracked\|pending/.test(out), out);
  out = db.applyFile(F('kalshi_market_data.sql'));
  T.chk('applying it twice is harmless (idempotent)', !/CHECK THIS/.test(out), out.slice(0, 400));

  /* ---- the world: two NFL games and a fight ----
       G1 DAL @ PHI kicks off in 30 minutes (pregame); G2 NYG @ WAS kicked off a day ago;
       BUF @ KC is on Kalshi but on no book (unmapped); a UFC market closed two hours ago */
  db.service(`insert into public.kalshi_series (ticker, title, category, tracked) values
      ('KXNFLGAME', 'Professional Football Game', 'Sports', true), ('KXUFCFIGHT', 'UFC Fight', 'Sports', true), ('KXNCAAFGAME', 'College Football Game', 'Sports', false);
    insert into public.kalshi_markets (ticker, event_ticker, series_ticker, yes_sub_title, close_time, expected_expiration_time, status, first_seen_at) values
      ('KXNFLGAME-G1-PHI', 'KXNFLGAME-G1', 'KXNFLGAME', 'Philadelphia', now() + interval '48 hours', now() + interval '3 hours 30 minutes', 'active', now() - interval '3 days'),
      ('KXNFLGAME-G1-DAL', 'KXNFLGAME-G1', 'KXNFLGAME', 'Dallas',       now() + interval '48 hours', now() + interval '3 hours 30 minutes', 'active', now() - interval '3 days'),
      ('KXNFLGAME-G2-WAS', 'KXNFLGAME-G2', 'KXNFLGAME', 'Washington',   now() + interval '24 hours', now() - interval '21 hours', 'active', now() - interval '4 days'),
      ('KXNFLGAME-G2-NYG', 'KXNFLGAME-G2', 'KXNFLGAME', 'New York G',   now() + interval '24 hours', now() - interval '21 hours', 'active', now() - interval '4 days'),
      ('KXNFLGAME-G9-KC',  'KXNFLGAME-G9', 'KXNFLGAME', 'Kansas City',  now() + interval '58 hours', now() + interval '10 hours', 'active', now() - interval '1 day'),
      ('KXUFCFIGHT-F1-A',  'KXUFCFIGHT-F1', 'KXUFCFIGHT', 'Fighter A',   now() - interval '2 hours', now() - interval '2 hours', 'closed', now() - interval '2 days');`);
  db.sql(`insert into public.signals (sig_key, event_id, sport_key, commence_time, home_team, away_team, market, selection, closing_sharp_fair, closing_at_observed, closing_source) values
      ('ev1|h2h|PHI', 'ev1', 'americanfootball_nfl', now() + interval '30 minutes', 'Philadelphia Eagles', 'Dallas Cowboys', 'h2h', 'Philadelphia Eagles', null, null, null),
      ('ev1|h2h|DAL', 'ev1', 'americanfootball_nfl', now() + interval '30 minutes', 'Philadelphia Eagles', 'Dallas Cowboys', 'h2h', 'Dallas Cowboys', null, null, null),
      ('ev2|h2h|WAS', 'ev2', 'americanfootball_nfl', now() - interval '1 day', 'Washington Commanders', 'New York Giants', 'h2h', 'Washington Commanders', 0.56, now() - interval '1 day 3 minutes', 'live'),
      ('ev2|h2h|NYG', 'ev2', 'americanfootball_nfl', now() - interval '1 day', 'Washington Commanders', 'New York Giants', 'h2h', 'New York Giants', 0.44, now() - interval '1 day 3 minutes', 'live');
    insert into public.signal_ticks (sig_key, created_at, sharp_fair, n_books) values
      ('ev1|h2h|PHI', now() - interval '3 hours 2 minutes', 0.60, 8), ('ev1|h2h|PHI', now() - interval '120 minutes', 0.61, 8),
      ('ev1|h2h|PHI', now() - interval '40 minutes', 0.64, 9), ('ev1|h2h|PHI', now() - interval '1 minute', 0.63, 9),
      ('ev1|h2h|PHI', now() + interval '40 minutes', 0.99, 9),
      ('ev2|h2h|WAS', now() - interval '1 day 4 minutes', 0.56, 9);`);
  const link = (m, ev, yes, opp, home, away, kick, sig, extra) => db.service(`insert into public.kalshi_game_links (market_ticker, event_ticker, series_ticker, sport, kalshi_yes_name, yes_team, opponent, home_team, away_team, kickoff_at,
      odds_event_id, odds_sport_key, odds_sig_key, game_id, game_key, match_confidence, match_method, linker_version)
    values (${lit(m)}, ${lit(m.replace(/-[A-Z]+$/, ''))}, 'KXNFLGAME', 'nfl', null, ${lit(yes)}, ${lit(opp)}, ${lit(home)}, ${lit(away)}, ${kick}, ${lit(ev)}, 'americanfootball_nfl', ${lit(sig)},
      ${extra && extra.game ? lit(extra.game) : 'null'}, ${extra && extra.game ? lit('nfl|' + extra.game) : 'null'}, 'high', 'test', 'test');`);
  link('KXNFLGAME-G1-PHI', 'ev1', 'Philadelphia Eagles', 'Dallas Cowboys', 'Philadelphia Eagles', 'Dallas Cowboys', "now() + interval '30 minutes'", 'ev1|h2h|PHI', { game: '2026_08_DAL_PHI' });
  link('KXNFLGAME-G1-DAL', 'ev1', 'Dallas Cowboys', 'Philadelphia Eagles', 'Philadelphia Eagles', 'Dallas Cowboys', "now() + interval '30 minutes'", 'ev1|h2h|DAL', { game: '2026_08_DAL_PHI' });
  link('KXNFLGAME-G2-WAS', 'ev2', 'Washington Commanders', 'New York Giants', 'Washington Commanders', 'New York Giants', "now() - interval '1 day'", 'ev2|h2h|WAS');
  link('KXNFLGAME-G2-NYG', 'ev2', 'New York Giants', 'Washington Commanders', 'Washington Commanders', 'New York Giants', "now() - interval '1 day'", 'ev2|h2h|NYG');
  const snap = (t, at, bid, ask, extra) => db.service(`insert into public.kalshi_price_snapshots (ticker, captured_at, yes_bid, yes_ask, last_price, volume, open_interest, status)
    values (${lit(t)}, ${at}, ${bid == null ? 'null' : bid}, ${ask == null ? 'null' : ask}, ${(extra && extra.last) || 'null'}, ${(extra && extra.vol) || 1000}, 500, 'active');`);
  snap('KXNFLGAME-G1-PHI', "now() - interval '3 hours'", 0.58, 0.62);
  snap('KXNFLGAME-G1-PHI', "now() - interval '100 minutes'", 0.60, 0.66);   // spread exactly 0.06: trusted
  snap('KXNFLGAME-G1-PHI', "now() - interval '50 minutes'", 0.55, 0.70);    // 0.15: excluded
  snap('KXNFLGAME-G1-PHI', "now() - interval '4 minutes'", 0.64, 0.66, { vol: 25000 });
  snap('KXNFLGAME-G1-DAL', "now() - interval '30 minutes'", 0.34, 0.38);
  /* an exact tie: one pass five minutes before the DAL snapshot, one five minutes after */
  db.sql(`insert into public.signal_ticks (sig_key, created_at, sharp_fair, n_books)
    select 'ev1|h2h|DAL', s.captured_at + d.off, d.fair, 9 from public.kalshi_price_snapshots s,
      (values (interval '-5 minutes', 0.38), (interval '5 minutes', 0.36)) d(off, fair) where s.ticker = 'KXNFLGAME-G1-DAL';`);
  snap('KXNFLGAME-G2-WAS', "now() - interval '1 day 30 minutes'", 0.55, 0.58);
  snap('KXNFLGAME-G2-WAS', "now() - interval '1 day 6 minutes'", 0.57, 0.59);
  snap('KXNFLGAME-G2-WAS', "now() - interval '1 day' + interval '30 minutes'", 0.80, 0.82);   // in-game
  snap('KXNFLGAME-G2-NYG', "now() - interval '1 day 60 minutes'", 0.40, 0.42);
  snap('KXNFLGAME-G2-NYG', "now() - interval '1 day 5 minutes'", 0.30, 0.40);                  // the close is wide
  snap('KXNFLGAME-G9-KC', "now() - interval '3 minutes'", 0.70, 0.71);

  /* ---- roles ---- */
  T.chk('anon reads the snapshots, the markets, the links and the readiness', db.anon('select count(*) from public.kalshi_price_snapshots;') === '11'
    && db.anon('select count(*) from public.kalshi_game_links;') === '4' && db.anon('select count(*) from public.kalshi_readiness;') === '1');
  T.chk('anon cannot write a snapshot', fails(() => db.anon("insert into public.kalshi_price_snapshots (ticker, yes_bid, yes_ask) values ('KXNFLGAME-G1-PHI', 0.5, 0.52);")));
  T.chk('an authenticated reader cannot write a snapshot, a link or a series switch', fails(() => db.as(SUB, "insert into public.kalshi_price_snapshots (ticker, yes_bid, yes_ask) values ('KXNFLGAME-G1-PHI', 0.5, 0.52);"))
    && fails(() => db.as(SUB, "update public.kalshi_series set tracked = false where ticker = 'KXNFLGAME';")) && fails(() => db.as(SUB, "delete from public.kalshi_game_links;")));
  T.chk('a price outside 0..1 is refused', fails(() => db.service("insert into public.kalshi_price_snapshots (ticker, yes_bid, yes_ask) values ('KXNFLGAME-G1-PHI', 56, 58);")));

  /* ---- history (a run and an alert to refuse changes to) ---- */
  const r0 = db.service("insert into public.kalshi_sync_runs (trigger, mode, status, started_at, finished_at) values ('test', 'discover', 'ok', now() - interval '3 days', now() - interval '3 days') returning run_id;").split('\n').filter(Boolean).pop();
  db.service(`insert into public.kalshi_alerts (run_id, severity, code, message, created_at) values (${lit(r0)}, 'WARNING', 'test', 'a test alert', now() - interval '3 days');`);
  for (const t of ['kalshi_price_snapshots', 'kalshi_sync_runs', 'kalshi_alerts']) {
    T.chk('history: ' + t + ' refuses an update and a delete (even service_role), and a truncate', fails(() => db.service(`update public.${t} set ${t === 'kalshi_price_snapshots' ? 'yes_bid = yes_bid' : 'message = message'} where true;`))
      && fails(() => db.sql(`delete from public.${t};`)) && fails(() => db.sql(`truncate public.${t} cascade;`)));
  }
  T.chk('history: the snapshots are all still there', db.sql('select count(*) from public.kalshi_price_snapshots') === '11');
  T.chk('links: a link cannot be rewritten or deleted', fails(() => db.service("update public.kalshi_game_links set kickoff_at = now() where market_ticker = 'KXNFLGAME-G2-WAS';"))
    && fails(() => db.sql("delete from public.kalshi_game_links where market_ticker = 'KXNFLGAME-G2-WAS';")) && fails(() => db.sql('truncate public.kalshi_game_links;')));
  T.chk('links: a game id may not ride along with another change', fails(() => db.service("update public.kalshi_game_links set game_id = 'x', game_key = 'nfl|x', opponent = 'Someone' where market_ticker = 'KXNFLGAME-G2-WAS';")));
  T.chk('links: a missing game id is filled once', !fails(() => db.service("update public.kalshi_game_links set game_id = '2026_07_NYG_WAS', game_key = 'nfl|2026_07_NYG_WAS', game_method = 'teams+kickoff_36h', game_linked_at = now() where market_ticker = 'KXNFLGAME-G2-WAS';"))
    && fails(() => db.service("update public.kalshi_game_links set game_id = 'other', game_key = 'nfl|other' where market_ticker = 'KXNFLGAME-G2-WAS';")));
  T.chk('links: a game id needs its key', fails(() => db.service("update public.kalshi_game_links set game_id = 'x' where market_ticker = 'KXNFLGAME-G2-NYG';")));

  /* ---- the mid ---- */
  const mids = rows("select captured_at, spread, yes_mid, mid_excluded_reason from public.kalshi_snapshot_mid where ticker = 'KXNFLGAME-G1-PHI' order by captured_at");
  T.chk('mid: a spread of exactly 0.06 is trusted (0.63); 0.15 is wide and has no mid', mids[1].yes_mid === 0.63 && mids[1].spread === 0.06 && mids[2].yes_mid === null && mids[2].mid_excluded_reason === 'wide_spread', mids);
  db.service(`insert into public.kalshi_markets (ticker, event_ticker, series_ticker, status) values ('KXUFCFIGHT-F2-B', 'KXUFCFIGHT-F2', 'KXUFCFIGHT', 'active');`);
  snap('KXUFCFIGHT-F2-B', 'now()', 0, 0.05); snap('KXUFCFIGHT-F2-B', 'now()', 0.97, 1); snap('KXUFCFIGHT-F2-B', 'now()', 0.50, 0.57); snap('KXUFCFIGHT-F2-B', 'now()', 0.50, null);
  const m2 = rows("select mid_excluded_reason as r, yes_mid from public.kalshi_snapshot_mid where ticker = 'KXUFCFIGHT-F2-B' order by id");
  T.chk('mid: no bid, a $1 ask or a missing side is one-sided; 0.07 is wide', m2.map((x) => x.r).join(',') === 'one_sided,one_sided,wide_spread,one_sided' && m2.every((x) => x.yes_mid === null), m2);

  /* ---- the comparison (as a subscriber) ---- */
  const cmp = rows("select market_ticker, round(extract(epoch from now() - captured_at) / 60) as snap_ago, round(extract(epoch from now() - book_at) / 60) as book_ago, kalshi_mid, kalshi_spread, book_fair_prob, time_diff_minutes, time_gap_flag, gap_pp, kalshi_tier, comparison_tier from public.kalshi_book_comparison order by market_ticker, captured_at", asSub);
  const phi = cmp.filter((r) => r.market_ticker === 'KXNFLGAME-G1-PHI');
  T.chk('comparison: three trusted pregame PHI snapshots; the wide one is excluded', phi.length === 3 && !phi.some((r) => r.snap_ago === 50), phi);
  T.chk('comparison: the nearest pass (2 min before) — gap 0.00, unflagged', phi[0].book_fair_prob === 0.6 && phi[0].gap_pp === 0 && phi[0].time_gap_flag === false && phi[0].time_diff_minutes === -2, phi[0]);
  T.chk('comparison: 0.06 spread compared; the nearest pass is 20 minutes away: flagged, gap +2.00', phi[1].kalshi_spread === 0.06 && phi[1].book_fair_prob === 0.61 && phi[1].time_gap_flag === true && phi[1].gap_pp === 2 && phi[1].time_diff_minutes === -20, phi[1]);
  T.chk('comparison: the nearest pass is the one AFTER the snapshot when it is closer (3 min after)', phi[2].book_fair_prob === 0.63 && phi[2].time_diff_minutes === 3 && phi[2].gap_pp === 2 && phi[2].time_gap_flag === false, phi[2]);
  T.chk('comparison: a pass after kickoff is never the fair (0.99 never appears)', !cmp.some((r) => r.book_fair_prob === 0.99));
  const dal = cmp.filter((r) => r.market_ticker === 'KXNFLGAME-G1-DAL')[0];
  T.chk('comparison: a tie (5 minutes either way) goes to the earlier pass — gap −2.00', dal && dal.book_fair_prob === 0.38 && dal.gap_pp === -2 && dal.time_diff_minutes === -5, dal);
  T.chk('comparison: every row says what it is (T0 Kalshi, T2 comparison)', cmp.every((r) => r.kalshi_tier === 'T0' && r.comparison_tier === 'T2'));
  T.chk('comparison: an in-game snapshot is never compared', !cmp.some((r) => r.market_ticker === 'KXNFLGAME-G2-WAS' && r.kalshi_mid === 0.81));
  T.chk('comparison: an unlinked market is not compared', !cmp.some((r) => r.market_ticker === 'KXNFLGAME-G9-KC'));

  /* ---- access: the book fair stays behind signals' own rule ---- */
  T.chk('access: anon sees no comparison and no close (signals answers anon nothing)', db.anon('select count(*) from public.kalshi_book_comparison;') === '0' && db.anon('select count(*) from public.kalshi_book_closing_comparison;') === '0');
  T.chk('access: a signed-in reader without a subscription sees none either', db.as(NOSUB, 'select count(*) from public.kalshi_book_comparison;') === '0');
  const anonCard = one("select state, yes_mid, gap_pp, book_fair_prob from public.kalshi_card_current where market_ticker = 'KXNFLGAME-G1-PHI'", db.anon);
  T.chk('access: anon’s card has Kalshi’s price and no book fair or gap', anonCard.state === 'OK' && anonCard.yes_mid === 0.65 && anonCard.gap_pp === null && anonCard.book_fair_prob === null, anonCard);

  /* ---- the close ---- */
  const cl = rows("select market_ticker, kalshi_close_mid, kalshi_minutes_before_kickoff, book_close_fair, time_diff_minutes, time_gap_flag, gap_pp from public.kalshi_book_closing_comparison order by market_ticker", asSub);
  T.chk('close: WAS — the last snapshot before kickoff (6 min), never the in-game one; book close 0.56; 3 min apart; gap +2.00',
    cl.length === 1 && cl[0].market_ticker === 'KXNFLGAME-G2-WAS' && cl[0].kalshi_close_mid === 0.58 && cl[0].kalshi_minutes_before_kickoff === 6 && cl[0].book_close_fair === 0.56 && cl[0].time_diff_minutes === 3 && cl[0].time_gap_flag === false && cl[0].gap_pp === 2, cl);
  T.chk('close: NYG’s last pregame snapshot is wide, so NYG has no close — an earlier tight one is NOT used instead', !cl.some((r) => r.market_ticker === 'KXNFLGAME-G2-NYG'));
  db.sql("update public.signals set closing_at_observed = null where sig_key = 'ev2|h2h|WAS';");
  const cl2 = one("select time_diff_minutes, time_gap_flag from public.kalshi_book_closing_comparison where market_ticker = 'KXNFLGAME-G2-WAS'", asSub);
  T.chk('close: a book close with no observation time is flagged, never assumed aligned', cl2.time_diff_minutes === null && cl2.time_gap_flag === true, cl2);
  db.sql("update public.signals set closing_at_observed = now() - interval '1 day 3 minutes' where sig_key = 'ev2|h2h|WAS';");
  const cs = rows("select ticker, close_basis, close_mid, round(minutes_before_close) as before from public.kalshi_closing_snapshot order by ticker");
  T.chk('closing snapshot: a linked game closes at kickoff, any other market at close_time; an unlinked game market is left out',
    cs.find((r) => r.ticker === 'KXNFLGAME-G2-WAS').close_basis === 'kickoff' && cs.find((r) => r.ticker === 'KXNFLGAME-G2-WAS').close_mid === 0.58
    && !cs.some((r) => r.ticker === 'KXNFLGAME-G9-KC') && !cs.some((r) => r.ticker === 'KXNFLGAME-G1-PHI'), cs);

  /* ---- capture health ---- */
  const hl = rows('select close_basis, markets_closed, with_snapshot, captured_within_10m, usable_within_10m, pct_within_10m, pct_usable_within_10m from public.kalshi_close_capture_health order by close_basis');
  const hk = hl.find((r) => r.close_basis === 'kickoff'), hc = hl.find((r) => r.close_basis === 'close_time');
  T.chk('capture: both G2 markets captured within 10 minutes of kickoff; the wide NYG close is captured but not usable', hk && hk.markets_closed === 2 && hk.captured_within_10m === 2 && hk.usable_within_10m === 1 && hk.pct_within_10m === 100 && hk.pct_usable_within_10m === 50, hl);
  T.chk('capture: a closed market with no snapshot at all is a counted miss, not dropped', hc && hc.markets_closed === 1 && hc.with_snapshot === 0 && hc.pct_within_10m === 0, hc);

  /* ---- the card ---- */
  const card = (t, who) => one(`select * from public.kalshi_card_current where market_ticker = ${lit(t)}`, who || asSub);
  let c = card('KXNFLGAME-G1-PHI');
  T.chk('card: OK — the latest snapshot (4 min), its mid, spread, volume, and the gap at the latest aligned pass (+2.00)', c.state === 'OK' && c.pregame === true && c.yes_mid === 0.65 && c.spread === 0.02 && c.volume === 25000
    && c.gap_pp === 2 && c.gap_basis === 'latest_pregame' && c.book_fair_prob === 0.63 && c.game_id === '2026_08_DAL_PHI', c);
  c = card('KXNFLGAME-G1-DAL');
  T.chk('card: a pregame snapshot 30 minutes old is STALE and shows no mid', c.state === 'STALE' && c.yes_mid === null && c.snapshot_age_minutes === 30, c);
  snap('KXNFLGAME-G1-DAL', "now() - interval '1 minute'", 0.30, 0.40);
  c = card('KXNFLGAME-G1-DAL');
  T.chk('card: a fresh but wide quote is WIDE_SPREAD with no mid (the bid and ask still say why)', c.state === 'WIDE_SPREAD' && c.yes_mid === null && c.spread === 0.1 && c.yes_bid === 0.3, c);
  c = card('KXNFLGAME-G2-WAS');
  T.chk('card: after kickoff, the close: the last pregame snapshot (6 min before) and the close gap', c.pregame === false && c.state === 'OK' && c.yes_mid === 0.58 && c.gap_basis === 'close' && c.gap_pp === 2, c);
  c = card('KXNFLGAME-G2-NYG');
  T.chk('card: after kickoff with a wide close, WIDE_SPREAD and no gap', c.state === 'WIDE_SPREAD' && c.yes_mid === null && c.gap_pp === null, c);
  T.chk('card: an unlinked market has no card row (nothing is shown for an unmatched game)', db.sql("select count(*) from public.kalshi_card_current where market_ticker = 'KXNFLGAME-G9-KC'") === '0');
  db.service(`insert into public.kalshi_markets (ticker, event_ticker, series_ticker, yes_sub_title, status, first_seen_at) values ('KXNFLGAME-G5-SEA', 'KXNFLGAME-G5', 'KXNFLGAME', 'Seattle', 'active', now() - interval '1 day');`);
  db.sql("insert into public.signals (sig_key, event_id, sport_key, commence_time, home_team, away_team, market, selection) values ('ev5|h2h|SEA', 'ev5', 'americanfootball_nfl', now() - interval '2 hours', 'Seattle Seahawks', 'Arizona Cardinals', 'h2h', 'Seattle Seahawks');");
  link('KXNFLGAME-G5-SEA', 'ev5', 'Seattle Seahawks', 'Arizona Cardinals', 'Seattle Seahawks', 'Arizona Cardinals', "now() - interval '2 hours'", 'ev5|h2h|SEA');
  c = card('KXNFLGAME-G5-SEA');
  T.chk('card: a linked market never snapshotted before kickoff is NO_SNAPSHOT', c.state === 'NO_SNAPSHOT' && c.yes_mid === null && c.gap_pp === null, c);

  /* ---- readiness ---- */
  const rd = () => J(db.anon('select row_to_json(r) from public.kalshi_readiness r;'));
  const runRow = (mode, status, at, extra) => db.service(`insert into public.kalshi_sync_runs (trigger, mode, status, started_at, finished_at, markets_snapshotted, message, details)
    values ('test', ${lit(mode)}, ${lit(status)}, ${at} - interval '20 seconds', ${at}, ${(extra && extra.n) || 0}, ${lit(extra && extra.message || null)}, ${lit(JSON.stringify((extra && extra.details) || {}))}::jsonb) returning run_id;`).split('\n').filter(Boolean).pop();
  let r = rd();
  T.chk('readiness: discover alone (three days old) is an error: no snapshot run yet', r.state === 'error' && /no snapshot run/.test(r.state_reason), r);
  runRow('discover', 'ok', 'now()');
  runRow('snapshot', 'ok', 'now()', { n: 4 });
  r = rd();
  T.chk('readiness: a fresh snapshot, but an unmapped game market settling in 10 hours, is a warning', r.state === 'warn' && r.unmapped_settling_soon === 1 && /could not be matched/.test(r.state_reason) && r.markets_last_snapshot === 4 && r.tracked_series === 2, r);
  T.chk('readiness: close capture over 7 days counts kickoff closes only (2 of 3: G5 had no snapshot)', r.closes_7d === 3 && r.closes_captured_7d === 2 && r.close_capture_pct_7d === 66.7, r);
  runRow('snapshot', 'ok', 'now()', { n: 4, details: { unmapped_soon_actionable: 0, unmapped_soon_unpriced: 1, unmapped_counts: { no_book_event: 1 } } });
  r = rd();
  T.chk('readiness: the sync classified the unmatched game as one no book prices: not a warning; counted apart', r.unmapped_settling_soon === 0 && r.unmapped_unpriced_soon === 1
    && r.unmapped_counts && r.unmapped_counts.no_book_event === 1 && !/could not be matched/.test(String(r.state_reason)) && /close capture/.test(String(r.state_reason)), r);
  runRow('snapshot', 'ok', 'now()', { n: 4, details: { unmapped_soon_actionable: 2, unmapped_soon_unpriced: 0 } });
  r = rd();
  T.chk('readiness: a priced game that could not be matched is the warning, named with where to look', r.state === 'warn' && r.unmapped_settling_soon === 2 && /2 game event\(s\) settling soon that a book prices/.test(String(r.state_reason)), r);
  runRow('snapshot', 'ok', 'now()', { n: 4, details: { unmapped_soon_actionable: 0, unmapped_soon_unpriced: 0 } });   // the next run, once the names are fixed
  db.sql("insert into public.signals (sig_key, event_id, sport_key, commence_time, home_team, away_team, market, selection) values ('ev9|h2h|KC', 'ev9', 'americanfootball_nfl', now() + interval '7 hours', 'Kansas City Chiefs', 'Buffalo Bills', 'h2h', 'Kansas City Chiefs');");
  link('KXNFLGAME-G9-KC', 'ev9', 'Kansas City Chiefs', 'Buffalo Bills', 'Kansas City Chiefs', 'Buffalo Bills', "now() + interval '7 hours'", 'ev9|h2h|KC');
  r = rd();
  T.chk('readiness: with the market linked, close capture under 90% is the warning', r.state === 'warn' && r.unmapped_settling_soon === 0 && /close capture 66\.7%/.test(r.state_reason), r);
  snap('KXNFLGAME-G5-SEA', "now() - interval '2 hours 3 minutes'", 0.5, 0.52);
  r = rd();
  T.chk('readiness: every close captured: ok', r.state === 'ok' && r.close_capture_pct_7d === 100 && r.state_reason === null, r);
  const bad = runRow('snapshot', 'error', 'now()', { message: 'snapshot error: Kalshi could not be reached' });
  db.service(`insert into public.kalshi_alerts (run_id, severity, code, message) values (${lit(bad)}, 'FAILURE', 'snapshot_error', 'Kalshi could not be reached');`);
  r = rd();
  T.chk('readiness: a failed snapshot is an error, a consecutive failure and a FAILURE in 24 h', r.state === 'error' && r.consecutive_failures === 1 && r.failures_24h === 1 && /Kalshi could not be reached/.test(r.state_reason), r);
  T.chk('pipeline ledger: the snapshot status reads error, the row count is the last good run’s',
    db.anon("select value from public.kalshi_meta where key = 'kalshi_snapshot_last_status';") === 'error' && db.anon("select value from public.kalshi_meta where key = 'row_count_kalshi_snapshot';") === '4');
  runRow('snapshot', 'ok', 'now()', { n: 5 });
  r = rd();
  T.chk('readiness: a good snapshot after it clears the streak; the failure still counts in 24 h (degradation is a warning)', r.state === 'warn' && r.consecutive_failures === 0 && r.failures_24h === 1, r);

  /* ---- cron ---- */
  db.sql(`create schema if not exists cron;
    create table if not exists cron.job (jobid bigserial primary key, jobname text, schedule text, command text, active boolean default true);
    create or replace function cron.schedule(n text, s text, c text) returns bigint language sql as $$ insert into cron.job (jobname, schedule, command) values (n, s, c) returning jobid $$;
    create or replace function cron.unschedule(j bigint) returns boolean language sql as $$ delete from cron.job where jobid = j returning true $$;
    create schema if not exists vault; create table if not exists vault.decrypted_secrets (name text, decrypted_secret text);
    create schema if not exists net; create table if not exists net.calls (url text, body jsonb, headers jsonb);
    create or replace function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds integer default 5000) returns bigint language sql as $$ insert into net.calls values (url, body, headers); select 1::bigint $$;`);
  out = db.applyFile(F('kalshi_market_data_cron.sql'));
  T.chk('cron: both jobs scheduled; the report flags the missing secret', /1 the daily discover is scheduled\|ok/.test(out) && /2 the 5-minute snapshot is scheduled\|ok/.test(out) && /CHECK THIS: select vault\.create_secret/.test(out), out);
  T.chk('cron: snapshot every 5 minutes, discover daily', db.sql("select string_agg(jobname || '=' || schedule, ',' order by jobname) from cron.job") === 'kalshi_sync_discover=17 9 * * *,kalshi_sync_snapshot=*/5 * * * *');
  let pk = J(db.sql("select public.kalshi_poke('snapshot');"));
  r = rd();
  T.chk('forced failure: no secret is a failed snapshot run and a FAILURE alert, visible in the readiness KPIs', pk.queued === false && r.state === 'error' && r.last_snapshot_run_status === 'error'
    && db.sql('select code from public.kalshi_alerts order by id desc limit 1') === 'no_cron_secret', [pk, r]);
  db.sql("insert into vault.decrypted_secrets values ('kalshi_cron_secret', 's3cret');");
  pk = J(db.sql("select public.kalshi_poke('discover');"));
  T.chk('cron: with the secret, the poke queues the mode with the x-cron-secret header', pk.queued === true
    && db.sql("select headers ->> 'x-cron-secret' || ':' || (body ->> 'mode') || ':' || (body ->> 'source') from net.calls limit 1") === 's3cret:discover:supabase_cron' && /\/functions\/v1\/kalshi_sync$/.test(db.sql('select url from net.calls limit 1')));
  T.chk('cron: an unknown mode is refused', fails(() => db.sql("select public.kalshi_poke('everything');")));
  T.chk('cron: no client may call the poke', fails(() => db.anon("select public.kalshi_poke('snapshot');")) && fails(() => db.as(SUB, "select public.kalshi_poke('snapshot');")) && fails(() => db.service("select public.kalshi_poke('snapshot');")));
  out = db.applyFile(F('kalshi_market_data_cron.sql'));
  T.chk('cron: applying it twice keeps one job each', db.sql("select count(*) from cron.job where jobname like 'kalshi_sync_%'") === '2' && !/CHECK THIS/.test(out), out);

  /* ---- a silent scheduler, on a fresh layer ---- */
  const ticksBefore = db.sql('select count(*) from public.signal_ticks');
  out = db.applyFile(F('kalshi_market_data_rollback.sql'));
  T.chk('rollback removes the layer and its jobs; the capture tables are untouched', /\|ok/.test(out) && db.sql("select to_regclass('public.kalshi_price_snapshots') is null") === 't'
    && db.sql("select count(*) from cron.job where jobname like 'kalshi_sync_%'") === '0' && db.sql('select count(*) from public.signal_ticks') === ticksBefore, out);
  db.applyFile(F('kalshi_market_data.sql'));
  r = rd();
  T.chk('readiness: a layer that has never run is an error', r.state === 'error' && /never run/.test(r.state_reason), r);
  db.service("insert into public.kalshi_series (ticker, tracked) values ('KXNFLGAME', true);");
  runRow('discover', 'ok', "now() - interval '1 hour'");
  runRow('snapshot', 'ok', "now() - interval '30 minutes'", { n: 3 });
  r = rd();
  T.chk('readiness: no snapshot run in over 20 minutes is an error (the scheduler is not calling)', r.state === 'error' && /scheduler/.test(r.state_reason) && r.minutes_since_snapshot === 30, r);
  db.service("insert into public.kalshi_sync_runs (trigger, mode, status, started_at, finished_at, series_tracked) values ('test', 'snapshot', 'warn', now(), now(), 0);");
  db.sql("update public.kalshi_series set tracked = false;");
  r = rd();
  T.chk('readiness: running with nothing tracked is a warning that says what to do', r.state === 'warn' && /tracked = true/.test(r.state_reason), r);

  /* ---- over the starter schema (kalshi_schema.sql, as it was handed over) ---- */
  db.applyFile(F('kalshi_market_data_rollback.sql'));
  db.applyFile(path.join(__dirname, 'fixtures', 'kalshi_schema_starter.sql'));
  db.sql(`insert into public.kalshi_series (ticker, tracked) values ('KXNFLGAME', true);
    insert into public.kalshi_markets (ticker, event_ticker, series_ticker, yes_sub_title, close_time) values ('KXNFLGAME-S-PHI', 'KXNFLGAME-S', 'KXNFLGAME', 'Philadelphia', now() + interval '2 days');
    insert into public.kalshi_price_snapshots (ticker, captured_at, yes_bid, yes_ask, volume) values ('KXNFLGAME-S-PHI', now() - interval '1 hour', 0.60, 0.62, 100);
    select cron.schedule('kalshi_snapshot_5m', '*/5 * * * *', 'select 1'); select cron.schedule('kalshi_discover_daily', '7 9 * * *', 'select 1');`);
  T.chk('starter: in place before the upgrade (its own mid view, no run id)', db.sql("select count(*) from information_schema.columns where table_name = 'kalshi_snapshot_mid' and column_name = 'mid_excluded_reason'") === '0'
    && db.sql("select count(*) from information_schema.columns where table_name = 'kalshi_price_snapshots' and column_name = 'run_id'") === '0');
  out = db.applyFile(F('kalshi_market_data.sql'));
  T.chk('over the starter: the layer applies; every report row is ok, the upgrade row included', !/CHECK THIS/.test(out) && /10 the tables carry every column[^\n]*\|ok/.test(out) && (out.match(/\|ok/g) || []).length === 10, out);
  const kept = one("select ticker, yes_mid, spread, mid_excluded_reason, run_id from public.kalshi_snapshot_mid where ticker = 'KXNFLGAME-S-PHI'", db.anon);
  T.chk('over the starter: its rows are kept and read through this layer’s views', kept && kept.yes_mid === 0.61 && kept.spread === 0.02 && kept.run_id === null
    && db.sql("select tracked from public.kalshi_series where ticker = 'KXNFLGAME'") === 't' && db.sql("select count(*) from public.kalshi_markets") === '1', kept);
  T.chk('over the starter: what kalshi_sync writes now lands (a market title, a snapshot run id)', !fails(() => db.service(`update public.kalshi_markets set title = 'Philadelphia wins' where ticker = 'KXNFLGAME-S-PHI';
    insert into public.kalshi_price_snapshots (ticker, yes_bid, yes_ask, run_id) values ('KXNFLGAME-S-PHI', 0.61, 0.63, gen_random_uuid());`)));
  T.chk('over the starter: its snapshots are append-only now', fails(() => db.service("update public.kalshi_price_snapshots set yes_bid = 0.5 where ticker = 'KXNFLGAME-S-PHI';")) && fails(() => db.sql('delete from public.kalshi_price_snapshots;')));
  T.chk('over the starter: anon reads it now (the starter had row level security with no policy)', db.anon('select count(*) from public.kalshi_price_snapshots;') === '2');
  out = db.applyFile(F('kalshi_market_data.sql'));
  T.chk('over the starter: applying it again is harmless', !/CHECK THIS/.test(out), out);
  out = db.applyFile(F('kalshi_market_data_cron.sql'));
  T.chk('over the starter: the cron file removes the starter’s jobs (they carried the service-role key)', /4 no starter job is left[^\n]*\|ok/.test(out)
    && db.sql("select string_agg(jobname, ',' order by jobname) from cron.job where jobname like 'kalshi%'") === 'kalshi_sync_discover,kalshi_sync_snapshot', out);
} catch (e) { T.chk('the run completed', false, String(e.message).slice(0, 1200)); }
finally { db.stop(); }
process.exit(T.done());
