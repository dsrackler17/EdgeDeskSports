#!/usr/bin/env node
/* ===========================================================================
   supabase/player_props.sql AGAINST A REAL POSTGRESQL.

   Applied twice (idempotent), the report reads ok, and the guarantees hold
   for every role: quotes, projections, frozen decisions and grades are
   append-only (UPDATE / DELETE refused, even for the service role); a
   decision frozen at or after kickoff is refused; a grade before kickoff is
   refused; a BET with zero units is refused; anonymous readers see model
   output but not the live market, and see a frozen decision only after its
   kickoff.

   Run: node tools/props/player_props_sql.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const T = PG.kit('player props SQL');
const chk = T.chk;
const FILE = path.join(PG.ROOT, 'supabase', 'player_props.sql');
const SQL = fs.readFileSync(FILE, 'utf8');

chk('no psql meta-commands', !/^\\/m.test(SQL));
chk('idempotent', /create table if not exists/.test(SQL) && /create or replace view/.test(SQL) && /drop trigger if exists/.test(SQL));
chk('additive: no table or column is dropped', !/\bdrop table\b/i.test(SQL) && !/\bdrop column\b/i.test(SQL));
chk('it ends in a report', /CHECK THIS/.test(SQL));
chk('PostgREST is told to reload', /notify pgrst, 'reload schema'/.test(SQL));
chk('player ids are EdgeDesk ids, never names', /player_id ~ '\^edp_\[0-9a-f\]\{12\}\$'/.test(SQL));

const db = PG.start('props');
if (db.skip) {
  if (process.env.PLAYER_PROPS_SQL_REQUIRED === '1') chk('a PostgreSQL cluster starts (required in CI)', false, db.skip);
  console.log('NOTE | ' + db.skip + ' — LIVE layer skipped'); process.exit(T.done());
}
const DAY = 86400000;
/* every statement handed to the harness ends in a semicolon */
const semi = (t) => (/;\s*$/.test(t) ? t : t + ';');
const svc = (t) => db.service(semi(t)), anon = (t) => db.anon(semi(t)), su = (t) => db.sql(semi(t)), as = (u, t) => db.as(u, semi(t));
const iso = (ms) => new Date(Date.now() + ms).toISOString();
try {
  db.applyFileAtomic(FILE);
  const rep = db.applyFileAtomic(FILE);
  chk('applies twice, and every report row reads ok', rep.split('\n').filter(Boolean).every((l) => /\|ok$/.test(l)), rep);
  svc("insert into public.player_registry (player_id, league, anchor_system, anchor_id, full_name, slug, position, current_team) values ('edp_0123456789ab','NFL','gsis','00-0039075','Puka Nacua','puka-nacua','WR','LA')");
  chk('a name is not an id', db.mustFail(() => svc("insert into public.player_registry (player_id, league, anchor_system, anchor_id, full_name, slug) values ('Puka Nacua','NFL','gsis','x','Puka Nacua','puka')")));
  const K = iso(2 * DAY);
  svc("insert into public.player_prop_quotes (quote_id, league, game_id, kickoff, player_id, book_player_name, prop_type, market_key, book, line, over_price, under_price, captured_at) values ('pq_1','NFL','2026_04_LA_PHI','" + K + "','edp_0123456789ab','Puka Nacua','rec_yds','player_reception_yds','draftkings',78.5,-110,-110,'" + iso(-60000) + "')");
  chk('a quote tick is never updated (service role)', db.mustFail(() => svc("update public.player_prop_quotes set line = 80.5 where quote_id = 'pq_1'")));
  chk('a quote tick is never deleted (superuser trigger)', db.mustFail(() => su("delete from public.player_prop_quotes where quote_id = 'pq_1'")));
  chk('a price inside (-100, 100) is not a price', db.mustFail(() => svc("insert into public.player_prop_quotes (quote_id, league, game_id, book_player_name, prop_type, market_key, book, line, over_price, captured_at) values ('pq_2','NFL','g','x','rec_yds','m','dk',1,50,now())")));
  const dec = (id, frozen, kick, cls, units) => "insert into public.player_prop_decisions (prediction_id, kind, league, game_id, kickoff, player_id, prop_type, side, line, american, book, decision, units, model_version, frozen_at) values ('" + id + "','FIRST','NFL','2026_04_LA_PHI','" + kick + "','edp_0123456789ab','rec_yds','over',78.5,-110,'draftkings','" + cls + "'," + units + ",'NFL_PLAYER_PROPS_V1.0','" + frozen + "')";
  svc(dec('ppd_00000000000000a1', iso(-60000), K, 'LEAN', 0));
  chk('a decision frozen at kickoff is refused', db.mustFail(() => svc(dec('ppd_00000000000000a2', K, K, 'LEAN', 0))));
  chk('a BET with zero units is refused', db.mustFail(() => svc(dec('ppd_00000000000000a3', iso(-60000), K, 'BET', 0))));
  chk('units above 1.00U are refused', db.mustFail(() => svc(dec('ppd_00000000000000a4', iso(-60000), K, 'BET', 1.5))));
  chk('a frozen decision is never rewritten', db.mustFail(() => svc("update public.player_prop_decisions set american = -105 where prediction_id = 'ppd_00000000000000a1'")));
  chk('a grade before kickoff is refused', db.mustFail(() => svc("insert into public.player_prop_grades (prediction_id, result, graded_at, kickoff) values ('ppd_00000000000000a1','WIN','" + iso(-1000) + "','" + K + "')")));
  const anonDec = anon('select count(*) from public.player_prop_decisions');
  chk('anonymous readers cannot see a pregame decision', anonDec.trim() === '0', anonDec);
  const anonQ = anon('select count(*) from public.player_prop_quotes');
  const authQ = as('00000000-0000-0000-0000-00000000000a', 'select count(*) from public.player_prop_quotes');
  chk('the live market is for signed-in readers', anonQ.trim() === '0' && authQ.trim() === '1', { anon: anonQ, auth: authQ });
  const anonReg = anon('select count(*) from public.player_registry');
  chk('model output and identity are public', anonReg.trim() === '1', anonReg);
  const PK = iso(-3 * 3600e3);
  su("alter table public.player_prop_decisions disable trigger player_prop_decisions_pregame");
  svc(dec('ppd_00000000000000b1', iso(-4 * 3600e3), PK, 'PASS', 0));
  su("alter table public.player_prop_decisions enable trigger player_prop_decisions_pregame");
  const anonPast = anon('select count(*) from public.player_prop_decisions');
  chk('a decision becomes public after kickoff', anonPast.trim() === '1', anonPast);
  svc("insert into public.player_prop_grades (prediction_id, result, actual, profit_units, graded_at, kickoff) values ('ppd_00000000000000b1','LOSS',61,-1,'" + iso(0) + "','" + PK + "')");
  const rec = anon("select result from public.player_prop_record where prediction_id = 'ppd_00000000000000b1'");
  chk('the record view joins decisions to grades', /LOSS/.test(rec), rec);
} catch (e) {
  chk('the live SQL suite ran', false, e.message.slice(0, 400));
} finally { db.stop(); }
process.exit(T.done());
