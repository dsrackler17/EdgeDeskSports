#!/usr/bin/env node
/* ===========================================================================
   supabase/research_snapshots.sql against a real, throwaway PostgreSQL, fed
   with snapshot rows built by the terminal's own resilience layer from the
   committed slate (football/cfb_terminal/resilience.js snapshotRow).

   Proves: applies clean, twice, and as one transaction; the ingest is
   idempotent on the content-hash id; the ledger is append-only for every role;
   a snapshot at or after kickoff is refused; a betting-eligible row needs a
   LIVE verified market; a FAULT never carries a comparison number; anon reads
   nothing, authenticated reads, only the service role ingests; the latest
   view; and the rollback.

   Run: node tools/resilience/research_snapshots_sql.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const PG = require('../personal/_pg.js');

const ROOT = path.join(__dirname, '..', '..');
const SQL = path.join(ROOT, 'supabase', 'research_snapshots.sql');
const ROLLBACK = path.join(ROOT, 'supabase', 'research_snapshots_rollback.sql');
let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push({ name, detail }); }
function done(note) {
  if (note && /^SKIP/.test(note) && process.env.RESILIENCE_SQL_REQUIRED === '1') { fail++; failures.push({ name: 'Postgres required but ' + note }); }
  failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 400) : '')));
  if (note) console.log(note);
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'research snapshots SQL — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

/* real rows: build the slate into a temp dir and snapshot every game */
const RES = require(path.join(ROOT, 'football', 'cfb_terminal', 'resilience.js'));
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'rsnap-'));
cp.execFileSync(process.execPath, [path.join(ROOT, 'football', 'cfb_terminal', 'build.js'), '--out', out], { stdio: 'ignore' });
const G = JSON.parse(fs.readFileSync(path.join(out, 'games.json'), 'utf8'));
const NOW = Date.parse(G.generated_at);
const rows = Object.keys(G.games).map((id) => { const o = G.games[id]; return RES.snapshotRow(o, { market_state: o.market_state, resilience: o.resilience }, { now: NOW, inputs_sha256: G.inputs_sha256 }); });

const db = PG.start('rsnap');
if (!db || db.skip) done('SKIP | ' + ((db && db.skip) || 'no postgres') + ' — the SQL layer did not run');
const J = (o) => '$j$' + JSON.stringify(o) + '$j$::jsonb';
const ingest = (list) => JSON.parse(db.service(`select public.research_snapshots_ingest(${J(list)})::text;`));
try {
  const r1 = db.applyFile(SQL);
  chk('applies to a clean database, every report row ok', !/CHECK THIS/.test(r1) && (r1.match(/\|ok/g) || []).length === 6, r1);
  chk('applies a second time, still ok', !/CHECK THIS/.test(db.applyFile(SQL)));
  chk('applies as ONE transaction, still ok', !/CHECK THIS/.test(db.applyFileAtomic(SQL)));

  const a = ingest(rows);
  chk('every game of the committed slate ingests (' + rows.length + ')', a.inserted === rows.length && a.received === rows.length, a);
  const b = ingest(rows);
  chk('a re-sync is a no-op (idempotent on the content hash)', b.inserted === 0 && b.already_present === rows.length, b);
  chk('the market states round-trip', db.sql(`select count(distinct market_state) from public.research_snapshots`) >= '1'
    && +db.sql(`select count(*) from public.research_snapshots where research_visibility = 'AVAILABLE'`) === rows.filter((r) => r.research_visibility === 'AVAILABLE').length);
  chk('the UCF @ Oklahoma State row records INVESTIGATE against its market', db.sql(`select research_verdict || '|' || market_state || '|' || (research_disagreement->>'points') from public.research_snapshots where game_id = '401856824'`).split('|')[0] === 'INVESTIGATE');

  chk('UPDATE is refused, service role included', /append-only/.test(db.mustFail(() => db.service(`update public.research_snapshots set research_verdict = 'X';`)) || ''));
  chk('DELETE is refused, service role included', /append-only/.test(db.mustFail(() => db.service(`delete from public.research_snapshots;`)) || ''));
  chk('TRUNCATE is refused', /append-only/.test(db.mustFail(() => db.sql(`truncate public.research_snapshots;`)) || ''));

  const base = rows[0];
  const variant = (o) => Object.assign(JSON.parse(JSON.stringify(base)), { snapshot_id: 'cfbr_' + 'f'.repeat(24) }, o);
  chk('a snapshot at or after kickoff is refused', /pregame/.test(db.mustFail(() => ingest([variant({ observed_at: base.kickoff })])) || ''));
  chk('betting-eligible without a LIVE verified market is refused', /betting_needs_live/.test(db.mustFail(() => ingest([variant({ betting_validation: 'ELIGIBLE', market: Object.assign({}, base.market, { state: 'CACHED', verified: false }) })])) || ''));
  chk('a FAULT row carrying a market number is refused', /fault_withheld/.test(db.mustFail(() => ingest([variant({ market: Object.assign({}, base.market, { state: 'FAULT', spread_home_line: -3 }) })])) || ''));
  chk('an unknown market state is refused', /check constraint/.test(db.mustFail(() => ingest([variant({ market: Object.assign({}, base.market, { state: 'STALE' }) })])) || ''));
  chk('a malformed snapshot id is refused', /check constraint/.test(db.mustFail(() => ingest([variant({ snapshot_id: 'x' })])) || ''));

  chk('anon reads nothing', !!db.mustFail(() => db.anon(`select count(*) from public.research_snapshots;`)));
  chk('authenticated reads', +db.as('00000000-0000-0000-0000-000000000001', `select count(*) from public.research_snapshots;`) === rows.length);
  chk('authenticated cannot ingest', !!db.mustFail(() => db.as('00000000-0000-0000-0000-000000000001', `select public.research_snapshots_ingest('[]'::jsonb);`)));
  chk('authenticated cannot insert directly', !!db.mustFail(() => db.as('00000000-0000-0000-0000-000000000001', `insert into public.research_snapshots (snapshot_id, observed_at, game_id, market_state, research_visibility, market_integrity, betting_validation, research_verdict, snapshot) values ('cfbr_${'e'.repeat(24)}', now(), 'g', 'LIVE', 'AVAILABLE', 'VERIFIED', 'BLOCKED', 'X', '{}');`)));
  chk('the latest view returns one row per game', +db.as('00000000-0000-0000-0000-000000000001', `select count(*) from public.research_snapshot_latest;`) === rows.length);

  const rb = db.applyFile(ROLLBACK);
  chk('the rollback removes every object', /\|ok/.test(rb) && !/CHECK THIS/.test(rb), rb);
  chk('the file applies again after a rollback and the ledger restores every row', !/CHECK THIS/.test(db.applyFile(SQL)) && ingest(rows).inserted === rows.length);
} catch (e) {
  chk('the suite ran without an unexpected error', false, String(e.message).slice(0, 600));
} finally {
  db.stop();
  try { fs.rmSync(out, { recursive: true, force: true }); } catch (_) { /* ignore */ }
}
done();
