#!/usr/bin/env node
/* ===========================================================================
   supabase/card_opportunities.sql, AGAINST A REAL POSTGRESQL, AS REAL READERS.

   A saved Card position (a game market or a player prop) is private, saved
   before kickoff, and write-once: the line, price and EV the reader saved
   can never be edited later — only removed from the Card — and the grade is
   the grading job's alone. The record view keeps GAME and PLAYER_PROP apart.

   Run: node tools/opportunity/card_sql.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));

const T = PG.kit('card opportunities SQL');
const chk = T.chk;
const FILE = path.join(PG.ROOT, 'supabase', 'card_opportunities.sql');
const DEPS = [path.join(PG.ROOT, 'supabase', 'bankroll_and_stakes.sql'), path.join(PG.ROOT, 'supabase', 'bettor_decisions.sql')];
const SQL = fs.readFileSync(FILE, 'utf8');

/* ── STATIC: the folder's conventions ──────────────────────────────────── */
chk('no psql meta-commands', !/^\\/m.test(SQL));
chk('idempotent create statements', /create table if not exists/.test(SQL) && /create or replace function/.test(SQL));
chk('additive: nothing is dropped', !/\bdrop table\b/i.test(SQL) && !/\bdrop column\b/i.test(SQL));
chk('it ends in a report', /CHECK THIS/.test(SQL) && /order by 1;\s*$/.test(SQL));
chk('PostgREST is told to reload', /notify pgrst, 'reload schema'/.test(SQL));
chk('under the SQL editor paste limit (18 KB)', Buffer.byteLength(SQL) <= 18000, Buffer.byteLength(SQL));
chk('it names its dependency', /apply supabase\/bettor_decisions\.sql first/.test(SQL));

const db = PG.start('card');
if (db.skip) {
  if (process.env.PLAYER_PROPS_SQL_REQUIRED === '1') chk('a PostgreSQL cluster starts (required in CI)', false, db.skip);
  console.log('NOTE | ' + db.skip + ' — LIVE layer skipped'); process.exit(T.done());
}

const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';
const iso = (ms) => new Date(Date.now() + ms).toISOString();
const KICK = iso(2 * 86400000);
const q = (v) => v == null ? 'null' : "'" + String(v).replace(/'/g, "''") + "'";
function row(o) {
  const r = Object.assign({ entry_id: 'ce_1', key: 'prop|nfl|g1|p1|rec_yds|over', type: 'PLAYER_PROP', sport: 'NFL', league: 'nfl', event_key: 'nfl|g1', game_id: 'g1', kickoff: KICK,
    market: 'rec_yds', player_id: 'p1', player_name: 'A Receiver', team: 'PIT', prop_type: 'rec_yds', side: 'over', line: 71.5, american: -110, book: 'draftkings',
    probability: 0.59, ev: 0.12, edge_pp: 6.6, confidence: 74, decision: 'BET', units: 0.25, stage: 'TRACKING', probability_source: 'model_estimated', snapshot: '{"a":1}' }, o || {});
  const ks = Object.keys(r);
  return 'insert into public.card_opportunities (' + ks.join(',') + ') values (' + ks.map((k) => k === 'snapshot' ? q(r[k]) + '::jsonb' : q(r[k])).join(',') + ');';
}

try {
  const noDep = db.mustFail(() => db.applyFileAtomic(FILE));
  chk('without bettor_decisions.sql it stops and names the file', /bettor_decisions\.sql/.test(noDep || ''), noDep && noDep.slice(0, 300));
  db.sql('create table if not exists public.signals (sig_key text primary key, closing_sharp_fair numeric, closing_dec numeric, closing_at_observed timestamptz, result text, clv numeric, beat_close boolean);');
  DEPS.forEach((f) => db.applyFileAtomic(f));
  db.sql(`insert into auth.users (id, email) values ('${A}','a@example.com'), ('${B}','b@example.com');`);
  let out = db.applyFileAtomic(FILE);
  chk('the migration applies and every report row says ok', !/CHECK THIS/.test(out), out.slice(-600));
  out = db.applyFileAtomic(FILE);
  chk('and applies a second time without error', !/CHECK THIS/.test(out));

  /* ── saving ────────────────────────────────────────────────────────── */
  db.as(A, row());
  db.as(A, row({ entry_id: 'ce_2', key: 'game|nfl|g1|spread|away', type: 'GAME', market: 'spread', player_id: null, player_name: null, prop_type: null, side: 'away', line: -2.5, units: 0.5, stage: null }));
  chk('a reader saves a player prop and a game market to one Card', db.as(A, 'select count(*) from public.card_opportunities;') === '2');
  chk('the user id comes from the token, never the row', db.as(A, "select count(*) from public.card_opportunities where user_id = '" + A + "';") === '2');
  chk('another reader cannot see it', db.as(B, 'select count(*) from public.card_opportunities;') === '0');
  chk('anon cannot read it', !!db.mustFail(() => db.anon('select count(*) from public.card_opportunities;')));
  chk('a prop must name its player and prop type', !!db.mustFail(() => db.as(A, row({ entry_id: 'ce_3', player_id: null }))));
  chk('only a BET carries units', !!db.mustFail(() => db.as(A, row({ entry_id: 'ce_4', decision: 'LEAN', units: 0.25 }))));
  chk('never more than 1.00U', !!db.mustFail(() => db.as(A, row({ entry_id: 'ce_5', units: 1.5 }))));
  chk('an impossible price is refused', !!db.mustFail(() => db.as(A, row({ entry_id: 'ce_6', american: 50 }))));
  chk('a started game cannot be saved to', !!db.mustFail(() => db.as(A, row({ entry_id: 'ce_7', kickoff: iso(-3600e3) }))));
  db.as(A, row({ entry_id: 'ce_8', key: 'prop|nfl|g1|p2|receptions|under', player_id: 'p2', prop_type: 'receptions', market: 'receptions', result: 'WIN', units_won: 9 }));
  chk('a grade never arrives with the entry', db.as(A, "select coalesce(result, 'none') from public.card_opportunities where entry_id = 'ce_8';") === 'none');

  /* ── write-once ────────────────────────────────────────────────────── */
  chk('the saved line cannot be edited', !!db.mustFail(() => db.as(A, "update public.card_opportunities set line = 73.5 where entry_id = 'ce_1';")));
  chk('the saved price cannot be edited', !!db.mustFail(() => db.as(A, "update public.card_opportunities set american = -115 where entry_id = 'ce_1';")));
  chk('the saved EV cannot be edited', !!db.mustFail(() => db.as(A, "update public.card_opportunities set ev = 0.5 where entry_id = 'ce_1';")));
  chk('the reader cannot write a grade', !!db.mustFail(() => db.as(A, "update public.card_opportunities set result = 'WIN' where entry_id = 'ce_1';")));
  db.as(A, "update public.card_opportunities set status = 'removed' where entry_id = 'ce_8';");
  chk('the reader may remove a position from the Card', db.as(A, "select status from public.card_opportunities where entry_id = 'ce_8';") === 'removed');
  chk('a removed position stays removed', !!db.mustFail(() => db.as(A, "update public.card_opportunities set status = 'open' where entry_id = 'ce_8';")));
  chk('the reader cannot delete the record', !!db.mustFail(() => db.as(A, "delete from public.card_opportunities where entry_id = 'ce_1';")) || db.as(A, 'select count(*) from public.card_opportunities;') === '3');

  /* ── the grading job, and the record by type ───────────────────────── */
  db.service("update public.card_opportunities set result = 'WIN', units_won = 0.2273, graded_at = now() where entry_id = 'ce_1';");
  db.service("update public.card_opportunities set result = 'LOSS', units_won = -0.5, graded_at = now() where entry_id = 'ce_2';");
  const rec = db.as(A, "select type || ':' || settled || ':' || wins || ':' || losses from public.card_record_by_type order by type;");
  chk('the record keeps GAME and PLAYER_PROP apart', rec.split('\n').map((s) => s.trim()).join('|') === 'GAME:1:0:1|PLAYER_PROP:1:1:0', rec);
  chk('another reader sees no record of A\'s', db.as(B, 'select count(*) from public.card_record_by_type;') === '0');
} finally { db.stop(); }
process.exit(T.done());
